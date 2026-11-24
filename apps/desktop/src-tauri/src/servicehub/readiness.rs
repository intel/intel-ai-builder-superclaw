//! REUSE child-health classification driven by `GET /app/readiness`.
//!
//! Replaces the earlier `/app/services/health` classification, which treated a
//! live process that had stopped honoring its health contract as healthy.
//!
//! Two boundaries are deliberate:
//!
//! Only `startup: "required"` **host_service** components decide the verdict. The
//! verdict drives a *child-service* restart, so scoping it to what a restart can
//! fix keeps supervision honest — a stalled container or wedged OpenCode is real,
//! reported by the runtime components, and not repaired by restarting children.
//!
//! Addressing comes from `GET /app/services/catalog`, which `ADDING_A_SERVICE.md`
//! designates as the discovery surface carrying `proxy_prefix`; duplicating
//! routing data into the readiness contract would recreate the endpoint overlap
//! this work removes.

use std::time::Duration;

use super::{ChildHealthTarget, ChildHealthVerdict};

const HOST_SERVICE_KIND: &str = "host_service";
const REQUIRED_STARTUP: &str = "required";

/// Fetch `GET /app/services/catalog`, the documented carrier of `proxy_prefix`.
///
/// Separate from the readiness read because addressing and state are different
/// authorities; duplicating `proxy_prefix` into the readiness contract would
/// recreate the endpoint overlap this work removes.
pub(super) fn fetch_services_catalog(hub_url: &str, token: &str) -> Option<serde_json::Value> {
    let url = format!("{hub_url}/app/services/catalog");
    ureq::get(&url)
        .timeout(Duration::from_secs(3))
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .ok()
        .filter(|resp| resp.status() == 200)
        .and_then(|resp| resp.into_json::<serde_json::Value>().ok())
}

/// Render the required components that are not ready, for the reuse log line.
pub(super) fn format_readiness_blockers(payload: &serde_json::Value) -> String {
    let Some(components) = payload.get("components").and_then(|v| v.as_array()) else {
        return String::new();
    };
    let blockers: Vec<String> = components
        .iter()
        .filter(|component| {
            component
                .get("startup")
                .and_then(serde_json::Value::as_str)
                == Some(REQUIRED_STARTUP)
                && component.get("state").and_then(serde_json::Value::as_str) != Some("ready")
        })
        .map(|component| {
            let name = component
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?");
            let state = component
                .get("state")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?");
            match component
                .get("reason_code")
                .and_then(serde_json::Value::as_str)
            {
                Some(reason) => format!("{name}={state}/{reason}"),
                None => format!("{name}={state}"),
            }
        })
        .collect();
    if blockers.is_empty() {
        String::new()
    } else {
        format!(" blockers: {}", blockers.join(", "))
    }
}

/// Classify a `/app/readiness` document into a REUSE verdict.
///
/// `Unknown` is returned for a malformed document or one carrying no required
/// host services: a healthy Hub always has its required children registered, so
/// their absence means no meaningful snapshot was read. Treating that as healthy
/// is exactly the false-positive this endpoint was introduced to remove.
pub(super) fn classify_app_readiness(payload: &serde_json::Value) -> ChildHealthVerdict {
    let Some(components) = payload.get("components").and_then(|v| v.as_array()) else {
        return ChildHealthVerdict::Unknown;
    };

    let mut saw_required_host_service = false;
    let mut all_ready = true;
    for component in components {
        if !is_required_host_service(component) {
            continue;
        }
        saw_required_host_service = true;
        if component.get("state").and_then(serde_json::Value::as_str) != Some("ready") {
            all_ready = false;
        }
    }

    if !saw_required_host_service {
        return ChildHealthVerdict::Unknown;
    }
    if all_ready {
        ChildHealthVerdict::AllHealthy
    } else {
        ChildHealthVerdict::SomeUnhealthy
    }
}

/// Join readiness evidence with catalog addressing into direct-probe targets.
///
/// The direct probe is a trust check on the Hub itself — it is what catches a Hub
/// reporting a child as healthy when that child is gone — so it needs the child's
/// own address, which only the catalog carries. Returns `None` if the two
/// documents cannot be joined, so the caller degrades to `Unknown` rather than
/// silently probing a subset.
pub(super) fn child_health_targets_from(
    readiness: &serde_json::Value,
    catalog: &serde_json::Value,
) -> Option<Vec<ChildHealthTarget>> {
    let components = readiness.get("components")?.as_array()?;
    let services = catalog.get("services")?.as_array()?;

    let mut targets = Vec::new();
    for component in components {
        if !is_required_host_service(component) {
            continue;
        }
        let name = component.get("name")?.as_str()?;
        if name.is_empty() {
            return None;
        }
        let instance_id = component.get("instance_id")?.as_str()?;
        if instance_id.is_empty() {
            return None;
        }
        let proxy_prefix = catalog_proxy_prefix(services, name)?;
        targets.push(ChildHealthTarget {
            name: name.to_string(),
            proxy_prefix,
            instance_id: instance_id.to_string(),
        });
    }

    if targets.is_empty() {
        return None;
    }
    Some(targets)
}

fn is_required_host_service(component: &serde_json::Value) -> bool {
    component.get("kind").and_then(serde_json::Value::as_str) == Some(HOST_SERVICE_KIND)
        && component
            .get("startup")
            .and_then(serde_json::Value::as_str)
            == Some(REQUIRED_STARTUP)
}

fn catalog_proxy_prefix(services: &[serde_json::Value], name: &str) -> Option<String> {
    for service in services {
        if service.get("name").and_then(serde_json::Value::as_str) != Some(name) {
            continue;
        }
        let prefix = service.get("proxy_prefix")?.as_str()?;
        if prefix.is_empty() || prefix == "/" || !prefix.starts_with('/') {
            return None;
        }
        return Some(prefix.to_string());
    }
    None
}
