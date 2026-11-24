use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tauri::AppHandle;

use super::{baseline_telemetry_enabled, post_otlp_json, release_channel, unix_nanos};

const OS: &str = std::env::consts::OS;
static APP_STARTED_AT: OnceLock<Instant> = OnceLock::new();
/// Notified by `notify_bundle_id_cached` once ServiceHub writes the bundle ID to prefs.
static BUNDLE_ID_READY: OnceLock<(Mutex<bool>, Condvar)> = OnceLock::new();
/// Product version from sandbox_manager /v1/system/status (e.g. "1.2.0.811").
static APP_PRODUCT_VERSION: OnceLock<String> = OnceLock::new();

#[derive(Clone, Copy)]
struct HostUsageEvent<'a> {
    event_name: &'static str,
    metric_name: &'static str,
    phase: Option<&'a str>,
    outcome: Option<&'a str>,
    error_class: Option<&'a str>,
    error: Option<&'a str>,
    startup_ms: Option<u64>,
    workspace_type: Option<&'a str>,
    feedback_mode: Option<&'a str>,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn startup_bucket_ms(value: u64) -> u64 {
    const BUCKETS: [u64; 8] = [
        1_000, 3_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000,
    ];
    BUCKETS
        .into_iter()
        .find(|upper_bound| value <= *upper_bound)
        .unwrap_or(300_000)
}

/// Shared install identity is enabled once install consent is complete.
fn install_identity_enabled(prefs: &crate::commands::app_prefs::AppPrefs) -> bool {
    prefs.install_telemetry_consent_completed
}

/// True when baseline telemetry is active and no install ID is persisted yet.
fn first_baseline_run(prefs: &crate::commands::app_prefs::AppPrefs) -> bool {
    super::baseline_telemetry_enabled_for_prefs(prefs) && prefs.install_id.is_none()
}

fn install_id(app: &AppHandle) -> Option<String> {
    let prefs = crate::commands::app_prefs::read_prefs_sync(app);
    if !install_identity_enabled(&prefs) {
        return None;
    }
    crate::commands::app_prefs::resolve_runtime_install_id(app)
        .ok()
        .flatten()
}

fn committed_bundle_id(app: &AppHandle) -> Option<String> {
    crate::commands::app_prefs::read_prefs_sync(app).committed_bundle_id
}

/// Frontend-reported switch target, pre-commit. Only used when nothing has
/// committed yet; the download/verify may still fail, so this is a
/// lower-confidence attribution than `committed_bundle_id`.
fn target_bundle_id(app: &AppHandle) -> Option<String> {
    crate::commands::app_prefs::read_prefs_sync(app).target_bundle_id
}

/// Called by `cache_product_version_from_servicehub` once the sandbox version is known.
pub(crate) fn notify_product_version(version: &str) {
    let _ = APP_PRODUCT_VERSION.set(version.trim().to_owned());
    // Wake any thread waiting for startup metadata.
    notify_bundle_id_cached();
}

/// Returns the real product version from runtime cache or persisted prefs.
///
/// Never falls back to the desktop package version, which may diverge from the
/// sandbox-manager product version used for telemetry slicing.
pub(crate) fn effective_app_version(app: &AppHandle) -> Option<String> {
    if let Some(version) = APP_PRODUCT_VERSION.get() {
        return Some(version.clone());
    }
    let cached = crate::commands::app_prefs::read_cached_product_version(app)?;
    let _ = APP_PRODUCT_VERSION.set(cached.clone());
    Some(cached)
}

fn wait_for_product_version(app: &AppHandle, timeout: Duration) -> Option<String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(version) = effective_app_version(app) {
            return Some(version);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Called by `cache_bundle_id_from_servicehub` once the ID is persisted to prefs.
pub(crate) fn notify_bundle_id_cached() {
    let (lock, cvar) = BUNDLE_ID_READY.get_or_init(|| (Mutex::new(false), Condvar::new()));
    *lock.lock().unwrap() = true;
    cvar.notify_all();
}

/// Wait up to `timeout` until bundle_id is available in prefs.
fn wait_for_bundle_id(app: &AppHandle, timeout: Duration) -> Option<String> {
    let deadline = std::time::Instant::now() + timeout;
    // Fast path.
    if committed_bundle_id(app).is_some() {
        return committed_bundle_id(app);
    }
    let (lock, cvar) = BUNDLE_ID_READY.get_or_init(|| (Mutex::new(false), Condvar::new()));
    loop {
        if committed_bundle_id(app).is_some() {
            break;
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let guard = lock.lock().unwrap();
        let _ = cvar.wait_timeout(guard, remaining.min(Duration::from_secs(2)));
    }
    committed_bundle_id(app)
}

pub(crate) fn bundle_id_for_event(app: &AppHandle, _event_name: &str) -> Option<String> {
    committed_bundle_id(app).or_else(|| target_bundle_id(app))
}

fn event_record(
    event: HostUsageEvent<'_>,
    app_version: &str,
    channel: &str,
    install_id: Option<&str>,
    bundle_id: Option<&str>,
) -> Value {
    let mut record = Map::new();
    record.insert("event_name".to_string(), json!(event.event_name));
    record.insert("app_version".to_string(), json!(app_version));
    record.insert("channel".to_string(), json!(channel));
    record.insert("os".to_string(), json!(OS));
    if let Some(value) = event.phase {
        record.insert("phase".to_string(), json!(value));
    }
    if let Some(value) = event.outcome {
        record.insert("outcome".to_string(), json!(value));
    }
    if let Some(value) = event.error_class {
        record.insert("error_class".to_string(), json!(value));
    }
    if let Some(value) = event.error {
        record.insert(
            "error".to_string(),
            json!(super::scrub_crash_text(value, 500)),
        );
    }
    if let Some(value) = event.startup_ms {
        record.insert("startup_ms".to_string(), json!(startup_bucket_ms(value)));
    }
    if let Some(value) = event.workspace_type {
        record.insert("workspace_type".to_string(), json!(value));
    }
    if let Some(value) = event.feedback_mode {
        record.insert("feedback_mode".to_string(), json!(value));
    }
    if let Some(value) = install_id {
        record.insert("install_id".to_string(), json!(value));
    }
    if let Some(value) = bundle_id {
        record.insert("bundle_id".to_string(), json!(value));
    }
    Value::Object(record)
}

fn metric_attributes(event: HostUsageEvent<'_>, app_version: &str, channel: &str, bundle_id: Option<&str>) -> Vec<Value> {
    let mut attributes = vec![json!({
        "key": "superclaw.app_version",
        "value": {"stringValue": app_version}
    })];
    if let Some(id) = bundle_id {
        attributes.push(json!({
            "key": "superclaw.bundle_id",
            "value": {"stringValue": id}
        }));
    }
    match event.event_name {
        "app_start" | "app_ready" | "first_run" => {
            attributes.push(json!({
                "key": "superclaw.channel",
                "value": {"stringValue": channel}
            }));
            attributes.push(json!({
                "key": "superclaw.os",
                "value": {"stringValue": OS}
            }));
        }
        "startup_phase" => {
            attributes.push(json!({
                "key": "superclaw.channel",
                "value": {"stringValue": channel}
            }));
            attributes.push(json!({
                "key": "superclaw.phase",
                "value": {"stringValue": event.phase.unwrap_or("ready")}
            }));
            attributes.push(json!({
                "key": "superclaw.outcome",
                "value": {"stringValue": event.outcome.unwrap_or("success")}
            }));
            attributes.push(json!({
                "key": "superclaw.error_class",
                "value": {"stringValue": event.error_class.unwrap_or("unknown")}
            }));
        }
        "sandbox_ready" => {
            attributes.push(json!({
                "key": "superclaw.channel",
                "value": {"stringValue": channel}
            }));
            attributes.push(json!({
                "key": "superclaw.outcome",
                "value": {"stringValue": event.outcome.unwrap_or("success")}
            }));
            attributes.push(json!({
                "key": "superclaw.error_class",
                "value": {"stringValue": event.error_class.unwrap_or("unknown")}
            }));
        }
        "project_opened" => {
            attributes.push(json!({
                "key": "superclaw.channel",
                "value": {"stringValue": channel}
            }));
            attributes.push(json!({
                "key": "superclaw.os",
                "value": {"stringValue": OS}
            }));
            attributes.push(json!({
                "key": "superclaw.project_type",
                "value": {"stringValue": event.workspace_type.unwrap_or("unknown")}
            }));
        }
        "feedback_submitted" => {
            attributes.push(json!({
                "key": "superclaw.channel",
                "value": {"stringValue": channel}
            }));
            attributes.push(json!({
                "key": "superclaw.os",
                "value": {"stringValue": OS}
            }));
            attributes.push(json!({
                "key": "superclaw.feedback_mode",
                "value": {"stringValue": event.feedback_mode.unwrap_or("unknown")}
            }));
            attributes.push(json!({
                "key": "superclaw.outcome",
                "value": {"stringValue": event.outcome.unwrap_or("unknown")}
            }));
        }
        _ => {}
    }
    attributes
}

fn metrics_payload(event: HostUsageEvent<'_>, app_version: &str, channel: &str, bundle_id: Option<&str>) -> Value {
    let timestamp = unix_nanos();
    json!({
        "resourceMetrics": [{
            "resource": {"attributes": [
                {"key": "service.name", "value": {"stringValue": "superclaw-desktop"}},
                {"key": "service.version", "value": {"stringValue": app_version}}
            ]},
            "scopeMetrics": [{
                "scope": {"name": "superclaw.host.usage"},
                "metrics": [{
                    "name": event.metric_name,
                    "unit": "1",
                    "sum": {
                        "aggregationTemporality": 1,
                        "isMonotonic": true,
                        "dataPoints": [{
                            "startTimeUnixNano": timestamp,
                            "timeUnixNano": timestamp,
                            "asInt": "1",
                            "attributes": metric_attributes(event, app_version, channel, bundle_id)
                        }]
                    }
                }]
            }]
        }]
    })
}

fn log_payload(record: &Value, app_version: &str) -> Value {
    json!({
        "resourceLogs": [{
            "resource": {"attributes": [
                {"key": "service.name", "value": {"stringValue": "superclaw-desktop"}},
                {"key": "service.version", "value": {"stringValue": app_version}}
            ]},
            "scopeLogs": [{
                "scope": {"name": "superclaw.host.usage"},
                "logRecords": [{
                    "timeUnixNano": unix_nanos(),
                    "severityNumber": 9,
                    "severityText": "INFO",
                    "body": {"stringValue": record.to_string()},
                    "attributes": [
                        {"key": "superclaw.event_name", "value": {"stringValue": record.get("event_name").and_then(Value::as_str).unwrap_or("unknown")}},
                        {"key": "superclaw.app_version", "value": {"stringValue": app_version}}
                    ]
                }]
            }]
        }]
    })
}

fn heartbeat_record(install_id: &str, app_version: &str, channel: &str, bundle_id: Option<&str>) -> Value {
    let mut record = serde_json::Map::new();
    record.insert("event_name".to_string(), json!("active_install"));
    record.insert("install_id".to_string(), json!(install_id));
    record.insert("app_version".to_string(), json!(app_version));
    record.insert("os".to_string(), json!(OS));
    record.insert("channel".to_string(), json!(channel));
    if let Some(id) = bundle_id {
        record.insert("bundle_id".to_string(), json!(id));
    }
    Value::Object(record)
}

fn emit_event_sync(
    app: &AppHandle,
    event: HostUsageEvent<'_>,
    install_id_override: Option<&str>,
) -> Result<bool, String> {
    if !baseline_telemetry_enabled(app) {
        return Ok(false);
    }
    let Some(app_version) = effective_app_version(app) else {
        tracing::debug!(
            event_name = event.event_name,
            "telemetry skipped: product version unavailable"
        );
        return Ok(false);
    };
    let channel = release_channel();
    let install_id = install_id_override
        .map(ToOwned::to_owned)
        .or_else(|| install_id(app));
    let bundle_id = bundle_id_for_event(app, event.event_name);
    let record = event_record(event, &app_version, &channel, install_id.as_deref(), bundle_id.as_deref());

    let metric_sent = post_otlp_json("metrics", metrics_payload(event, &app_version, &channel, bundle_id.as_deref()))?;
    let log_sent = post_otlp_json("logs", log_payload(&record, &app_version))?;
    Ok(metric_sent && log_sent)
}

fn emit_event_with_version_retry(
    app: AppHandle,
    event: HostUsageEvent<'static>,
    install_id_override: Option<String>,
    wait_timeout: Duration,
) {
    std::thread::spawn(move || {
        if effective_app_version(&app).is_none() {
            let _ = wait_for_product_version(&app, wait_timeout);
        }
        if let Err(error) = emit_event_sync(&app, event, install_id_override.as_deref()) {
            tracing::warn!(
                event_name = event.event_name,
                error = %error,
                "telemetry export failed"
            );
        }
    });
}

fn emit_heartbeat_with_version_retry(
    app: AppHandle,
    install_id_override: Option<String>,
    wait_timeout: Duration,
) {
    std::thread::spawn(move || {
        if effective_app_version(&app).is_none() {
            let _ = wait_for_product_version(&app, wait_timeout);
        }
        emit_heartbeat_sync(&app, install_id_override.as_deref());
    });
}

fn emit_async(app: AppHandle, event: HostUsageEvent<'static>) {
    emit_event_with_version_retry(app, event, None, Duration::from_secs(90));
}

fn frontend_usage_event<'a>(event: &'a Value) -> Option<HostUsageEvent<'a>> {
    match event.get("event_name").and_then(Value::as_str)? {
        "project_opened" => Some(HostUsageEvent {
            event_name: "project_opened",
            metric_name: "superclaw_project_opened",
            phase: None,
            outcome: None,
            error_class: None,
            error: None,
            startup_ms: None,
            workspace_type: match event.get("workspace_type").and_then(Value::as_str) {
                Some("local") => Some("local"),
                Some("remote") => Some("remote"),
                _ => Some("unknown"),
            },
            feedback_mode: None,
        }),
        "feedback_submitted" => Some(HostUsageEvent {
            event_name: "feedback_submitted",
            metric_name: "superclaw_feedback_submitted",
            phase: None,
            outcome: match event.get("outcome").and_then(Value::as_str) {
                Some("success") => Some("success"),
                Some("error") => Some("error"),
                _ => Some("unknown"),
            },
            error_class: None,
            error: None,
            startup_ms: None,
            workspace_type: None,
            feedback_mode: match event.get("feedback_mode").and_then(Value::as_str) {
                Some("mailto") => Some("mailto"),
                Some("github_issue") => Some("github_issue"),
                _ => Some("unknown"),
            },
        }),
        "sandbox_ready" => {
            let outcome = match event.get("outcome").and_then(Value::as_str) {
                Some("success") => "success",
                Some("failed") => "failed",
                Some("timeout") => "timeout",
                Some("cancelled") => "cancelled",
                _ => "failed",
            };
            let error_class = match event.get("error_class").and_then(Value::as_str) {
                Some(
                    value @ ("unknown"
                    | "servicehub_unavailable"
                    | "sandbox_start_failed"
                    | "owt_unavailable"
                    | "deadline_exceeded"
                    | "cancelled_by_user"),
                ) => value,
                _ => "unknown",
            };
            Some(HostUsageEvent {
                event_name: "sandbox_ready",
                metric_name: "superclaw_sandbox_ready",
                phase: None,
                outcome: Some(outcome),
                error_class: Some(error_class),
                error: None,
                startup_ms: None,
                workspace_type: None,
                feedback_mode: None,
            })
        }
        // Frontend-emitted startup_phase events cover the phases that are only
        // observable from the UI (model download, container start, etc.) and
        // are invisible to the Rust boot thread. The closed enum of valid phase
        // values is enforced here; unknown phase values are clamped to "unknown".
        "startup_phase" => {
            let phase = match event.get("phase").and_then(Value::as_str) {
                Some(
                    p @ ("servicehub_boot"
                    | "sandbox_provision"
                    | "model_download"
                    | "container_start"
                    | "ready"),
                ) => p,
                _ => "unknown",
            };
            let outcome = match event.get("outcome").and_then(Value::as_str) {
                Some("success") => "success",
                Some("failed") => "failed",
                Some("timeout") => "timeout",
                Some("cancelled") => "cancelled",
                _ => "success",
            };
            let error_class = match event.get("error_class").and_then(Value::as_str) {
                Some(c) if !c.is_empty() => c,
                _ => "unknown",
            };
            Some(HostUsageEvent {
                event_name: "startup_phase",
                metric_name: "superclaw_startup_phase",
                phase: Some(phase),
                outcome: Some(outcome),
                error_class: Some(error_class),
                error: event.get("error").and_then(Value::as_str),
                startup_ms: None,
                workspace_type: None,
                feedback_mode: None,
            })
        }
        _ => None,
    }
}

pub fn emit_frontend_event(app: &AppHandle, event: &Value) -> Result<bool, String> {
    if frontend_usage_event(event).is_none() {
        return Ok(false);
    }
    let app = app.clone();
    let event = event.clone();
    std::thread::spawn(move || {
        let Some(usage_event) = frontend_usage_event(&event) else {
            return;
        };
        if let Err(error) = emit_event_sync(&app, usage_event, None) {
            tracing::warn!(
                event_name = usage_event.event_name,
                error = %error,
                "telemetry export failed"
            );
        }
    });
    Ok(true)
}

pub fn emit_app_start(app: AppHandle) {
    let _ = APP_STARTED_AT.set(Instant::now());
    std::thread::spawn(move || {
        let prefs_at_start = crate::commands::app_prefs::read_prefs_sync(&app);
        let first_baseline_launch = first_baseline_run(&prefs_at_start);
        let runtime_install_id = crate::commands::app_prefs::resolve_runtime_install_id(&app)
            .ok()
            .flatten();
        // Wait briefly for ServiceHub to cache bundle_id. Do not gate app_start
        // on slower startup paths.
        wait_for_bundle_id(&app, Duration::from_secs(2));
        let app_start = HostUsageEvent {
            event_name: "app_start",
            metric_name: "superclaw_app_start",
            phase: None,
            outcome: None,
            error_class: None,
            error: None,
            startup_ms: None,
            workspace_type: None,
            feedback_mode: None,
        };
        emit_event_with_version_retry(
            app.clone(),
            app_start,
            runtime_install_id.clone(),
            Duration::from_secs(90),
        );
        if first_baseline_launch {
            let first_run = HostUsageEvent {
                event_name: "first_run",
                metric_name: "superclaw_first_run",
                ..app_start
            };
            emit_event_with_version_retry(
                app.clone(),
                first_run,
                runtime_install_id.clone(),
                Duration::from_secs(90),
            );
        }
        emit_heartbeat_with_version_retry(app.clone(), runtime_install_id, Duration::from_secs(90));
    });
}

pub fn emit_app_ready(app: AppHandle) {
    let startup_ms = APP_STARTED_AT
        .get()
        .map(Instant::elapsed)
        .map(|elapsed| elapsed.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default();
    emit_async(
        app,
        HostUsageEvent {
            event_name: "app_ready",
            metric_name: "superclaw_app_ready",
            phase: None,
            outcome: None,
            error_class: None,
            error: None,
            startup_ms: Some(startup_ms),
            workspace_type: None,
            feedback_mode: None,
        },
    );
}

pub fn emit_startup_phase(
    app: AppHandle,
    outcome: &'static str,
    error_class: &'static str,
    error: Option<String>,
) {
    std::thread::spawn(move || {
        let event = HostUsageEvent {
            event_name: "startup_phase",
            metric_name: "superclaw_startup_phase",
            phase: Some("servicehub_boot"),
            outcome: Some(outcome),
            error_class: Some(error_class),
            error: error.as_deref(),
            startup_ms: None,
            workspace_type: None,
            feedback_mode: None,
        };
        if let Err(export_error) = emit_event_sync(&app, event, None) {
            tracing::debug!(error = %export_error, "telemetry startup_phase export failed");
        }
    });
}

pub fn emit_sandbox_ready(app: AppHandle, ready: bool) {
    emit_async(
        app,
        HostUsageEvent {
            event_name: "sandbox_ready",
            metric_name: "superclaw_sandbox_ready",
            phase: None,
            outcome: Some(if ready { "success" } else { "timeout" }),
            error_class: Some(if ready { "unknown" } else { "unknown" }),
            error: None,
            startup_ms: None,
            workspace_type: None,
            feedback_mode: None,
        },
    );
}

fn emit_heartbeat_sync(app: &AppHandle, install_id_override: Option<&str>) {
    let now_ms = now_millis();
    if !baseline_telemetry_enabled(app)
        || !crate::commands::app_prefs::heartbeat_due(app, now_ms).unwrap_or(false)
    {
        return;
    }
    let resolved_install_id = install_id_override
        .map(ToOwned::to_owned)
        .or_else(|| install_id(app));
    let Some(install_id) = resolved_install_id else {
        return;
    };
    let bundle_id = bundle_id_for_event(app, "active_install");
    let Some(app_version) = effective_app_version(app) else {
        tracing::debug!("telemetry active_install skipped: product version unavailable");
        return;
    };
    let record = heartbeat_record(&install_id, &app_version, &release_channel(), bundle_id.as_deref());
    match post_otlp_json("logs", log_payload(&record, &app_version)) {
        Ok(true) => {
            if let Err(error) = crate::commands::app_prefs::mark_heartbeat_emitted(app, now_ms) {
                tracing::warn!(error = %error, "telemetry heartbeat cursor update failed");
            }
        }
        Ok(false) => {}
        Err(error) => tracing::warn!(error = %error, "telemetry active_install export failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::app_prefs::AppPrefs;

    fn app_start_event() -> HostUsageEvent<'static> {
        HostUsageEvent {
            event_name: "app_start",
            metric_name: "superclaw_app_start",
            phase: None,
            outcome: None,
            error_class: None,
            error: None,
            startup_ms: None,
            workspace_type: None,
            feedback_mode: None,
        }
    }

    #[test]
    fn metric_payload_never_contains_install_id() {
        let payload = metrics_payload(app_start_event(), "1.2.3", "stable", None).to_string();
        assert!(!payload.contains("install_id"));
        assert!(payload.contains("superclaw_app_start"));
    }

    #[test]
    fn usage_log_carries_install_id_only_in_body() {
        let record = event_record(app_start_event(), "1.2.3", "stable", Some("install-123"), None);
        let payload = log_payload(&record, "1.2.3");
        assert_eq!(record["install_id"], "install-123");
        assert!(payload.to_string().contains("install-123"));
    }

    #[test]
    fn startup_duration_is_bucketed() {
        let event = HostUsageEvent {
            startup_ms: Some(10_001),
            ..app_start_event()
        };
        let record = event_record(event, "1.2.3", "stable", None, None);
        assert_eq!(record["startup_ms"], 30_000);
    }

    #[test]
    fn heartbeat_is_logs_only_and_carries_an_install_id() {
        let record = heartbeat_record("install-123", "1.2.3", "stable", None);
        assert_eq!(record["event_name"], "active_install");
        assert_eq!(record["install_id"], "install-123");
        assert_eq!(record["os"], OS);
        assert_eq!(record["channel"], "stable");
    }

    #[test]
    fn bundle_id_appears_in_log_body_and_metric_attributes() {
        let record = event_record(app_start_event(), "1.2.3", "stable", None, Some("local-35b"));
        assert_eq!(record["bundle_id"], "local-35b");

        let payload = metrics_payload(app_start_event(), "1.2.3", "stable", Some("local-35b")).to_string();
        assert!(payload.contains("superclaw.bundle_id"));
        assert!(payload.contains("local-35b"));
        // install_id must never bleed into metric attributes
        assert!(!payload.contains("install_id"));
    }

    #[test]
    fn heartbeat_carries_bundle_id_when_available() {
        let record = heartbeat_record("install-123", "1.2.3", "stable", Some("local-4b"));
        assert_eq!(record["bundle_id"], "local-4b");
        assert_eq!(record["install_id"], "install-123");
    }

    #[test]
    fn install_identity_enabled_requires_install_consent() {
        let consented = crate::commands::app_prefs::AppPrefs {
            install_telemetry_consent_completed: true,
            ..crate::commands::app_prefs::AppPrefs::default()
        };
        let not_consented = crate::commands::app_prefs::AppPrefs::default();

        assert!(install_identity_enabled(&consented));
        assert!(!install_identity_enabled(&not_consented));
    }

    #[test]
    fn frontend_metric_payload_never_contains_install_id() {
        let value = json!({
            "event_name": "project_opened",
            "workspace_type": "local"
        });
        let event = frontend_usage_event(&value)
        .unwrap();
        let payload = metrics_payload(event, "1.2.3", "stable", None).to_string();
        assert!(!payload.contains("install_id"));
        assert!(payload.contains("superclaw_project_opened"));
        assert!(payload.contains("superclaw.project_type"));
    }

    #[test]
    fn frontend_log_body_is_allowlisted() {
        let value = json!({
            "event_name": "feedback_submitted",
            "feedback_mode": "mailto",
            "outcome": "success",
            "workspace_path": "C:/secret/project",
            "project_name": "secret-project",
            "session_id": "session-123"
        });
        let event = frontend_usage_event(&value)
        .unwrap();
        let record = event_record(event, "1.2.3", "stable", Some("install-123"), None);
        let body = record.to_string();
        assert!(body.contains("feedback_submitted"));
        assert!(body.contains("mailto"));
        assert!(body.contains("install-123"));
        assert!(!body.contains("workspace_path"));
        assert!(!body.contains("project_name"));
        assert!(!body.contains("session_id"));
    }

    #[test]
    fn frontend_sandbox_ready_is_bounded_and_channelled() {
        let value = json!({
            "event_name": "sandbox_ready",
            "outcome": "timeout",
            "error_class": "deadline_exceeded",
            "operation_id": "must-not-escape"
        });
        let event = frontend_usage_event(&value).unwrap();
        let attributes = json!(metric_attributes(event, "1.2.3", "dev", None)).to_string();
        let record = event_record(event, "1.2.3", "dev", Some("install-123"), None).to_string();

        assert!(attributes.contains("superclaw.channel"));
        assert!(attributes.contains("deadline_exceeded"));
        assert!(record.contains("timeout"));
        assert!(!record.contains("operation_id"));
    }

    #[test]
    fn startup_phase_metric_includes_channel_dimension() {
        let value = json!({
            "event_name": "startup_phase",
            "phase": "container_start",
            "outcome": "timeout",
            "error_class": "deadline_exceeded"
        });
        let event = frontend_usage_event(&value).unwrap();
        let attributes = json!(metric_attributes(event, "1.2.3", "dev", None)).to_string();

        assert!(attributes.contains("superclaw.channel"));
        assert!(attributes.contains("\"stringValue\":\"dev\""));
    }

    #[test]
    fn first_baseline_run_before_install_id_mint() {
        let prefs = AppPrefs {
            install_telemetry_consent_completed: true,
            full_telemetry_enabled: false,
            install_id: None,
            ..AppPrefs::default()
        };
        assert!(
            first_baseline_run(&prefs),
            "consented install with no persisted ID should count as first baseline run"
        );
        let mut after_mint = prefs.clone();
        after_mint.install_id = Some("minted-for-baseline".to_string());
        assert!(
            !first_baseline_run(&after_mint),
            "after ID mint the old post-resolve check would always be false"
        );
    }
}
