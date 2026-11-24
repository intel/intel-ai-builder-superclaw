//! Resolves the set of ports whose occupancy is a hard startup failure.
//!
//! Ports are read from their real source of truth wherever one exists
//! (`service_cfg.json`, `LLAMA_ROUTER_PORT`) so this list cannot drift from what
//! the services actually bind. The compiled-in constants are only a fallback for
//! when the config file is unreadable.

use std::collections::HashSet;
use std::path::Path;

use super::RequiredPort;

/// Fallback fixed ports, used only when `service_cfg.json` cannot be read.
/// Kept in sync with `host/servicehub/service_cfg.json`.
/// Tuple: `(port, bind_host, name, entrypoint, exe_name, role)`.
///
/// Only the *required* children belong here. `startup: "on_demand"` services (e.g.
/// `tts_manager` on 18827) are excluded — `parse_service_cfg` skips them so they
/// never gate startup, and the fallback must not reintroduce that gating when the
/// config file is unreadable.
///
/// `role` is `Some(name)` because these three are hosted by the shared
/// `superclaw-services.exe` multi-role bundle (`launch.kind = "role"`), so their
/// identity lives on the command line rather than in the image name.
const FALLBACK_SERVICEHUB_PORTS: &[(u16, &str, &str, &str, &str, Option<&str>)] = &[
    (
        18321,
        "127.0.0.1",
        "llmrouter_manager",
        "llmrouter_manager",
        crate::servicehub::SERVICEHUB_EXE_NAME,
        Some("llmrouter_manager"),
    ),
    (
        18826,
        "127.0.0.1",
        "privacy_manager",
        "protection_service.servicehub_entry",
        crate::servicehub::SERVICEHUB_EXE_NAME,
        Some("privacy_manager"),
    ),
    (
        18821,
        "127.0.0.1",
        "sandbox_manager",
        "sandbox_manager",
        crate::servicehub::SERVICEHUB_EXE_NAME,
        Some("sandbox_manager"),
    ),
];

/// Default llama-server router port — `llmrouter_manager/local/config.py`'s
/// `_DEFAULT_LLAMA_ROUTER_PORT`. Overridable via `LLAMA_ROUTER_PORT`.
const DEFAULT_LLAMA_ROUTER_PORT: u16 = 18103;
/// `_DEFAULT_LLAMA_BIND_HOST` — LRM reaches llama-server on loopback only.
const DEFAULT_LLAMA_BIND_HOST: &str = "127.0.0.1";

/// Build the full list of ports to probe, de-duplicated by `(port, bind_host)`.
///
/// De-duplication uses a seen-set rather than `Vec::dedup_by`, which only removes
/// *adjacent* duplicates: a `service_cfg.json` listing the same `(port, bind_host)`
/// non-adjacently — or any future reordering of these entries — would otherwise
/// leak duplicates through and make the dialog list the same port twice. Insertion
/// order is preserved so the logged `checked` list stays readable.
pub fn required_ports(servicehub_dir: Option<&Path>) -> Vec<RequiredPort> {
    let mut entries = servicehub_ports(servicehub_dir);
    entries.push(llama_router_port());

    let mut seen: HashSet<(u16, String)> = HashSet::new();
    entries.retain(|entry| seen.insert((entry.port, entry.bind_host.clone())));
    entries
}

/// ServiceHub's fixed child ports, read from `service_cfg.json`.
fn servicehub_ports(servicehub_dir: Option<&Path>) -> Vec<RequiredPort> {
    servicehub_dir
        .map(|dir| dir.join("service_cfg.json"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| parse_service_cfg(&raw))
        .filter(|entries| !entries.is_empty())
        .unwrap_or_else(|| {
            tracing::warn!(
                component = "port_preflight",
                stage = "service_cfg.fallback",
                "could not read service_cfg.json; using compiled-in fixed ports"
            );
            FALLBACK_SERVICEHUB_PORTS
                .iter()
                .map(
                    |(port, bind_host, service, entrypoint, exe_name, role)| RequiredPort {
                        port: *port,
                        bind_host: (*bind_host).to_string(),
                        service: (*service).to_string(),
                        entrypoint: (*entrypoint).to_string(),
                        exe_names: vec![(*exe_name).to_string()],
                        role: role.map(str::to_string),
                    },
                )
                .collect()
        })
}

/// Extract `{name, port, bind_host, entrypoint, exe_names}` from a
/// `service_cfg.json` document.
///
/// Services flagged `startup: "on_demand"` are skipped because they are not
/// started during app boot and therefore must not gate app startup.
///
/// `bind_host` defaults to `127.0.0.1` when a service omits it, matching
/// ServiceHub's own `ServiceEntry` default. `exe_names` mirrors
/// `process_manager._configured_exe_names`: the declared `launch.exe_name` plus
/// the implicit `<entrypoint>.exe`.
pub(super) fn parse_service_cfg(raw: &str) -> Option<Vec<RequiredPort>> {
    // `serde_json` rejects a leading UTF-8 BOM, and the Python side reads the same
    // file with `encoding="utf-8-sig"`, which silently accepts one. That asymmetry
    // already cost us: a BOM on this file made every parse here fail, the gate fell
    // back to the compiled-in port list, and nothing surfaced except one WARN line -
    // so the "read the source of truth so it cannot drift" guarantee was gone while
    // the app looked healthy. Match the Python reader's tolerance instead.
    let value: serde_json::Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()?;
    let services = value.get("services")?.as_array()?;

    Some(
        services
            .iter()
            .filter_map(|service| {
                // An on-demand child's port must never gate app startup because
                // ServiceHub does not claim it until the feature is first used.
                if service
                    .get("startup")
                    .and_then(serde_json::Value::as_str)
                    == Some("on_demand")
                {
                    return None;
                }

                let port = u16::try_from(service.get("port")?.as_u64()?).ok()?;
                let name = service.get("name")?.as_str()?.to_string();
                let bind_host = service
                    .get("bind_host")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("127.0.0.1")
                    .to_string();
                let entrypoint = service
                    .get("entrypoint")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(&name)
                    .to_string();

                let launch = service.get("launch");
                let launch_exe_name = launch
                    .and_then(|launch| launch.get("exe_name"))
                    .and_then(serde_json::Value::as_str);
                // `launch.kind = "role"` means this service shares one multi-role
                // exe with its siblings and is selected by `--service <name>`.
                // Mirrors `process_manager._launch_role`.
                let role = match launch
                    .and_then(|launch| launch.get("kind"))
                    .and_then(serde_json::Value::as_str)
                {
                    Some("role") => Some(name.clone()),
                    _ => None,
                };

                let mut exe_names = vec![format!("{name}.exe")];
                if let Some(exe_name) = launch_exe_name {
                    if !exe_names.iter().any(|e| e.eq_ignore_ascii_case(exe_name)) {
                        exe_names.push(exe_name.to_string());
                    }
                }
                // The entrypoint can differ from the service name (e.g.
                // `protection_service.servicehub_entry` for privacy_manager), so
                // add its implicit exe form too when it is a bare identifier.
                let entry_exe = format!("{entrypoint}.exe");
                if !entrypoint.contains('.')
                    && !exe_names.iter().any(|e| e.eq_ignore_ascii_case(&entry_exe))
                {
                    exe_names.push(entry_exe);
                }

                Some(RequiredPort {
                    port,
                    bind_host,
                    service: name,
                    entrypoint,
                    exe_names,
                    role,
                })
            })
            .collect(),
    )
}

/// The llama-server router port. Occupancy is a hard failure: LRM's
/// `RouterSupervisor._launch` raises `PortConflictError` rather than retrying on
/// another port.
fn llama_router_port() -> RequiredPort {
    let port = std::env::var("LLAMA_ROUTER_PORT")
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .unwrap_or(DEFAULT_LLAMA_ROUTER_PORT);
    let bind_host = std::env::var("LLAMA_BIND_HOST")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .unwrap_or_else(|| DEFAULT_LLAMA_BIND_HOST.to_string());

    RequiredPort {
        port,
        bind_host,
        service: "llama_router".to_string(),
        entrypoint: "llama-server".to_string(),
        exe_names: vec!["llama-server.exe".to_string()],
        role: None,
    }
}
