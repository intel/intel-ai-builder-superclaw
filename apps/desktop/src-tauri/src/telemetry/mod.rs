//! Consent-gated host crash reporting for the Tauri shell and webview.

pub(crate) mod otlp_env;
mod usage;

pub(crate) use otlp_env::{
    apply_packaged_observability_env, ensure_process_otlp_env_for_export, feedback_ingest_endpoint,
    otlp_child_export_env_keys_to_strip, otlp_child_export_env_overrides, otlp_child_export_env_patch,
    otlp_credential_source_label, otlp_endpoint_fails_stable_prod_guard,
    otlp_endpoint_for_spawn, otlp_export_configured, otlp_export_refusal_reason,
    otlp_headers_for_spawn, OtlpChildExportEnvPatch,
};
pub use usage::{emit_app_ready, emit_app_start, emit_sandbox_ready, emit_startup_phase};
pub(crate) use usage::{notify_bundle_id_cached, notify_product_version};

use std::panic;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tauri::AppHandle;

const CRASH_EVENT_NAME: &str = "crash_reported";
const MAX_ERROR_CHARS: usize = 500;
const MAX_STACK_CHARS: usize = 4_000;

fn truncate(value: &str, max_chars: usize) -> String {
    let count = value.chars().count();
    if count <= max_chars {
        return value.to_string();
    }
    let keep = max_chars.saturating_sub(3);
    format!("{}...", value.chars().take(keep).collect::<String>())
}

pub fn scrub_crash_text(value: &str, max_chars: usize) -> String {
    let scrubbed = value
        .split_whitespace()
        .map(|token| {
            if token.starts_with("http://") || token.starts_with("https://") {
                return token.split(['?', '#']).next().unwrap_or(token).to_string();
            }
            let lower = token.to_ascii_lowercase();
            if lower.contains(":\\users\\")
                || lower.starts_with("/users/")
                || lower.starts_with("/home/")
            {
                return "~".to_string();
            }
            token.to_string()
        })
        .collect::<Vec<_>>()
        .join(" ");
    let normalized = if scrubbed.trim().is_empty() {
        "unknown"
    } else {
        scrubbed.trim()
    };
    truncate(normalized, max_chars)
}

fn string_field(event: &Value, key: &str, max_chars: usize) -> Option<String> {
    event
        .get(key)
        .and_then(Value::as_str)
        .map(|value| scrub_crash_text(value, max_chars))
        .filter(|value| !value.is_empty() && value != "unknown")
}

fn normalize_release_channel(raw: &str, debug_build: bool) -> String {
    let default_channel = if debug_build { "dev" } else { "stable" };
    let value = raw.trim().to_ascii_lowercase();
    if value.is_empty() {
        return default_channel.to_string();
    }
    if matches!(value.as_str(), "stable" | "beta" | "dev") {
        value.to_string()
    } else {
        "dev".to_string()
    }
}

/// Telemetry channel for OTLP routing and event payloads (`stable` | `beta` | `dev`).
///
/// Precedence: compile-time `SUPERCLAW_BAKED_BUILD_CHANNEL=stable` (release installers;
/// ignores runtime overrides), then `SUPERCLAW_BUILD_CHANNEL`, then
/// `SUPERCLAW_TELEMETRY_CHANNEL` (credential export), then other baked channels, then
/// build-type default.
pub(crate) fn release_channel() -> String {
    let debug_build = cfg!(debug_assertions);
    if option_env!("SUPERCLAW_BAKED_BUILD_CHANNEL")
        .is_some_and(|channel| channel.trim() == "stable")
    {
        return "stable".to_string();
    }
    if let Ok(value) = std::env::var("SUPERCLAW_BUILD_CHANNEL") {
        return normalize_release_channel(&value, debug_build);
    }
    if let Ok(value) = std::env::var("SUPERCLAW_TELEMETRY_CHANNEL") {
        return normalize_release_channel(&value, debug_build);
    }
    if let Some(baked) = option_env!("SUPERCLAW_BAKED_BUILD_CHANNEL") {
        if !baked.trim().is_empty() {
            return normalize_release_channel(baked, debug_build);
        }
    }
    normalize_release_channel("", debug_build)
}

/// Baseline collection requires install consent and remains enabled unless disabled in Settings.
pub(crate) fn baseline_telemetry_enabled_for_prefs(prefs: &crate::commands::app_prefs::AppPrefs) -> bool {
    crate::commands::app_prefs::resolve_baseline_telemetry_enabled_for_gating(prefs)
}

/// Full/crash collection: install consent completed and user opt-in pref (installer + Settings).
pub(crate) fn full_telemetry_enabled_for_prefs(prefs: &crate::commands::app_prefs::AppPrefs) -> bool {
    crate::commands::app_prefs::resolve_full_telemetry_enabled_for_gating(prefs)
}

pub(crate) fn effective_baseline_telemetry_enabled(app: &AppHandle) -> bool {
    baseline_telemetry_enabled_for_prefs(&crate::commands::app_prefs::read_prefs_sync(app))
}

/// Full/crash collection: install consent completed and user opt-in pref (installer + Settings).
pub(crate) fn effective_full_telemetry_enabled(app: &AppHandle) -> bool {
    full_telemetry_enabled_for_prefs(&crate::commands::app_prefs::read_prefs_sync(app))
}

/// Baseline install + usage telemetry (same gate in debug and release builds).
pub(crate) fn baseline_telemetry_enabled(app: &AppHandle) -> bool {
    effective_baseline_telemetry_enabled(app)
}

/// Full / crash telemetry (opt-in via installer + Settings; same gate in all builds).
pub(crate) fn full_telemetry_enabled(app: &AppHandle) -> bool {
    effective_full_telemetry_enabled(app)
}

/// Resolves the version to attach to crash/`service.version` records, matching the
/// sandbox-manager product version usage telemetry reports (see `usage::effective_app_version`).
/// Deliberately does NOT fall back to the Tauri shell's own package version - that's the
/// divergent value this resolver exists to avoid, and usage telemetry's callers never use it
/// either (they skip the emit instead). Crash records can't be re-emitted later, so instead of
/// dropping the whole record we tag `release` as `"unknown"`, mirroring how this same function
/// already tags a missing `error_class`/`error` rather than guessing from another source.
fn resolved_release(app: &AppHandle) -> String {
    usage::effective_app_version(app).unwrap_or_else(|| "unknown".to_string())
}

fn build_crash_record(app: &AppHandle, event: &Value) -> Option<Value> {
    if event.get("event_name").and_then(Value::as_str) != Some(CRASH_EVENT_NAME) {
        return None;
    }

    let release = resolved_release(app);
    let runtime = string_field(event, "runtime", 40).unwrap_or_else(|| "frontend".to_string());
    let service = if runtime == "rust" {
        "tauri-shell"
    } else {
        "webview"
    };

    let mut record = Map::new();
    record.insert("event_name".to_string(), json!(CRASH_EVENT_NAME));
    record.insert("release".to_string(), json!(release));
    record.insert("runtime".to_string(), json!(runtime));
    record.insert("service".to_string(), json!(service));
    record.insert("channel".to_string(), json!(release_channel()));
    record.insert("outcome".to_string(), json!("failed"));
    record.insert(
        "error_class".to_string(),
        json!(string_field(event, "error_class", 120).unwrap_or_else(|| "Error".to_string())),
    );
    record.insert(
        "error".to_string(),
        json!(
            string_field(event, "error", MAX_ERROR_CHARS).unwrap_or_else(|| "unknown".to_string())
        ),
    );
    if let Some(bundle_id) = usage::bundle_id_for_event(app, CRASH_EVENT_NAME) {
        record.insert("bundle_id".to_string(), json!(bundle_id));
    }
    if let Some(stack) = string_field(event, "stack", MAX_STACK_CHARS) {
        record.insert("stack".to_string(), json!(stack));
    }
    if full_telemetry_enabled(app) {
        if let Ok(Some(install_id)) = crate::commands::app_prefs::resolve_runtime_install_id(app) {
            record.insert("install_id".to_string(), json!(install_id));
        }
    }
    Some(Value::Object(record))
}

fn otlp_signal_url(signal: &str) -> Option<String> {
    let signal_endpoint = match signal {
        "logs" => "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
        "metrics" => "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
        _ => return None,
    };
    std::env::var(signal_endpoint)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|value| format!("{}/v1/{signal}", value.trim_end_matches('/')))
        })
}

fn unix_nanos() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string()
}

/// `no_endpoint_configured` and `export_not_configured` are the routine state of any build
/// with no OTLP endpoint wired up (every local/dev launch without baked or env credentials),
/// not a security-relevant refusal — log those at `debug`. Every other reason here is an
/// actual fail-closed guard (registry/ingress mismatch, invalid registry, etc.) and stays
/// at `warn` since it indicates a credential that doesn't belong on this build.
fn is_routine_otlp_refusal_reason(reason: &str) -> bool {
    matches!(reason, "no_endpoint_configured" | "export_not_configured")
}

fn log_otlp_export_refused(signal: &str, reason: &str) {
    if is_routine_otlp_refusal_reason(reason) {
        tracing::debug!(
            component = "telemetry",
            stage = "otlp.export.refused",
            signal,
            reason,
            "OTLP export refused before send"
        );
    } else {
        tracing::warn!(
            component = "telemetry",
            stage = "otlp.export.refused",
            signal,
            reason,
            "OTLP export refused (fail-closed)"
        );
    }
}

fn post_otlp_json(signal: &str, body: Value) -> Result<bool, String> {
    crate::telemetry::ensure_process_otlp_env_for_export();
    let Some(url) = otlp_signal_url(signal) else {
        log_otlp_export_refused(signal, "no_endpoint_configured");
        return Ok(false);
    };
    // otlp_export_configured() already runs the same registry/ingress pairing check as
    // otlp_endpoint_fails_stable_prod_guard, so checking it first would mask the specific
    // mismatch reason behind a generic "not configured" — evaluate both through
    // otlp_export_refusal_reason so the log always carries the real cause.
    if !crate::telemetry::otlp_export_configured() || otlp_endpoint_fails_stable_prod_guard(&url) {
        log_otlp_export_refused(signal, otlp_export_refusal_reason(&url));
        return Ok(false);
    }
    let agent = crate::http_proxy::apply_env_proxy_for_url(
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(5))
            .timeout_read(Duration::from_secs(15)),
        &url,
    )
    .build();
    let mut request = agent.post(&url).set("Content-Type", "application/json");
    if let Ok(headers) = std::env::var("OTEL_EXPORTER_OTLP_HEADERS") {
        for pair in headers.split(',') {
            if let Some((key, value)) = pair.split_once('=') {
                request = request.set(key.trim(), value.trim());
            }
        }
    }
    request
        .send_json(body)
        .map(|response| {
            tracing::info!(
                component = "telemetry",
                stage = "otlp.export.ok",
                signal,
                credential_source = otlp_credential_source_label(),
                status = response.status(),
                "OTLP export succeeded"
            );
            true
        })
        .map_err(|error| format!("OTLP {signal} export failed: {error}"))
}

fn emit_record_sync(app: &AppHandle, record: Value) -> Result<bool, String> {
    if !full_telemetry_enabled(app) {
        return Ok(false);
    }

    let release = resolved_release(app);
    let body = json!({
        "resourceLogs": [{
            "resource": {"attributes": [
                {"key": "service.name", "value": {"stringValue": "superclaw-desktop"}},
                {"key": "service.version", "value": {"stringValue": release}}
            ]},
            "scopeLogs": [{
                "scope": {"name": "superclaw.host.crash"},
                "logRecords": [{
                    "timeUnixNano": unix_nanos(),
                    "severityNumber": 21,
                    "severityText": "FATAL",
                    "body": {"stringValue": record.to_string()},
                    "attributes": [
                        {"key": "superclaw.event_name", "value": {"stringValue": CRASH_EVENT_NAME}},
                        {"key": "superclaw.runtime", "value": {"stringValue": record.get("runtime").and_then(Value::as_str).unwrap_or("unknown")}},
                        {"key": "superclaw.service", "value": {"stringValue": record.get("service").and_then(Value::as_str).unwrap_or("unknown")}},
                        {"key": "superclaw.channel", "value": {"stringValue": record.get("channel").and_then(Value::as_str).unwrap_or("dev")}}
                    ]
                }]
            }]
        }]
    });

    post_otlp_json("logs", body)
}

#[tauri::command(async)]
pub fn emit_telemetry(app: AppHandle, event: Value) -> Result<bool, String> {
    if let Some(record) = build_crash_record(&app, &event) {
        if !full_telemetry_enabled(&app) {
            return Ok(false);
        }
        return emit_record_sync(&app, record);
    }
    if !baseline_telemetry_enabled(&app) {
        return Ok(false);
    }
    usage::emit_frontend_event(&app, &event)
}

pub fn install_panic_hook(app: AppHandle) {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let mut error = info.to_string();
        if let Some(location) = info.location() {
            error.push_str(&format!(" at {}:{}", location.file(), location.line()));
        }
        let event = json!({
            "event_name": CRASH_EVENT_NAME,
            "runtime": "rust",
            "error_class": "panic",
            "error": error,
        });
        if let Some(record) = build_crash_record(&app, &event) {
            let _ = emit_record_sync(&app, record);
        }
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::app_prefs::AppPrefs;
    use std::io::Write;
    use std::net::TcpListener;
    use crate::test_process_env::ENV_MUTEX;

    #[test]
    fn scrub_removes_url_secrets_and_user_paths() {
        let input =
            "failed https://example.com/run?token=secret#frag at C:\\Users\\alice\\project\\app.rs";
        let output = scrub_crash_text(input, 500);
        assert!(output.contains("https://example.com/run"));
        assert!(!output.contains("token=secret"));
        assert!(!output.contains("alice"));
    }

    #[test]
    fn scrub_truncates_unicode_safely() {
        assert_eq!(scrub_crash_text("abcdefghijk", 8), "abcde...");
        assert_eq!(scrub_crash_text("错误错误错误", 5), "错误...");
    }

    #[test]
    fn channel_is_bounded() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("SUPERCLAW_BUILD_CHANNEL", "invalid-value");
        assert_eq!(release_channel(), "dev");
        std::env::remove_var("SUPERCLAW_BUILD_CHANNEL");
        std::env::remove_var("SUPERCLAW_TELEMETRY_CHANNEL");
    }

    #[test]
    fn telemetry_export_channel_env_is_used_when_build_channel_unset() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("SUPERCLAW_BUILD_CHANNEL");
        std::env::set_var("SUPERCLAW_TELEMETRY_CHANNEL", "beta");
        assert_eq!(release_channel(), "beta");
        std::env::remove_var("SUPERCLAW_TELEMETRY_CHANNEL");
    }

    #[test]
    fn channel_defaults_to_build_type_when_env_unset() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("SUPERCLAW_BUILD_CHANNEL");
        std::env::remove_var("SUPERCLAW_TELEMETRY_CHANNEL");
        let expected = if cfg!(debug_assertions) { "dev" } else { "stable" };
        assert_eq!(release_channel(), expected);
    }

    #[test]
    fn consent_gates_disable_export_until_install_acknowledged() {
        let prefs = AppPrefs::default();
        assert!(!baseline_telemetry_enabled_for_prefs(&prefs));
        assert!(!full_telemetry_enabled_for_prefs(&prefs));
    }

    #[test]
    fn consent_gates_follow_full_telemetry_pref_after_install_acknowledged() {
        let mut prefs = AppPrefs::default();
        prefs.install_telemetry_consent_completed = true;
        assert!(baseline_telemetry_enabled_for_prefs(&prefs));
        assert!(!full_telemetry_enabled_for_prefs(&prefs));

        prefs.full_telemetry_enabled = true;
        assert!(full_telemetry_enabled_for_prefs(&prefs));

        prefs.full_telemetry_enabled = false;
        assert!(!full_telemetry_enabled_for_prefs(&prefs));
    }

    #[test]
    fn baseline_telemetry_can_be_disabled_after_install_consent() {
        let mut prefs = AppPrefs::default();
        prefs.install_telemetry_consent_completed = true;
        prefs.baseline_telemetry_enabled = false;

        assert!(!baseline_telemetry_enabled_for_prefs(&prefs));
    }

    #[test]
    fn full_telemetry_requires_install_consent_even_when_pref_is_true() {
        let mut prefs = AppPrefs::default();
        prefs.full_telemetry_enabled = true;
        assert!(!full_telemetry_enabled_for_prefs(&prefs));
    }

    // Helper: spin up a TCP listener, accept one connection in a background thread,
    // drain the full HTTP request (headers + body), send a minimal 200 response, then
    // return the raw request string.  We drain fully before responding so ureq never
    // sees an early RST while it is still writing the request body.
    fn run_otlp_server<F>(signal: &str, set_env: F) -> String
    where
        F: FnOnce(&str), // receives the full endpoint URL
    {
        use std::io::BufRead;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = format!("http://{address}/v1/{signal}");

        set_env(&endpoint);

        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(&stream);

            // Read header section up to the blank line.
            let mut header_text = String::new();
            let mut content_length: usize = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line == "\n" {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if lower.starts_with("content-length:") {
                    content_length = lower
                        .trim_start_matches("content-length:")
                        .trim()
                        .parse()
                        .unwrap_or(0);
                }
                header_text.push_str(&line);
            }

            // Drain the body so the write-side sees EOF before we respond.
            let mut body = vec![0_u8; content_length];
            std::io::Read::read_exact(&mut reader, &mut body).unwrap_or(());

            let mut writer = std::io::BufWriter::new(&stream);
            writer
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                )
                .unwrap();
            writer.flush().unwrap();

            format!(
                "{}\r\n{}",
                header_text,
                String::from_utf8_lossy(&body)
            )
        });

        assert!(
            post_otlp_json(signal, json!({"test": true})).unwrap(),
            "post_otlp_json returned false"
        );
        server.join().expect("server thread panicked")
    }

    #[test]
    fn otlp_transport_posts_json_to_the_signal_endpoint() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var_os("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT");
        let prev_headers = std::env::var_os("OTEL_EXPORTER_OTLP_HEADERS");
        // There is no in-source fallback credential or endpoint anymore; set explicit test
        // credentials so export is considered configured regardless of ambient env state.
        let prev_cred = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        let prev_token = std::env::var_os("SUPERCLAW_OTLP_EDGE_TOKEN");
        std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS");
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", "test-credential-id");
        std::env::set_var("SUPERCLAW_OTLP_EDGE_TOKEN", "test-edge-token");

        let request = run_otlp_server("logs", |url| {
            std::env::set_var("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", url);
        });

        assert!(request.starts_with("POST /v1/logs HTTP/1.1"));
        assert!(request.contains("application/json"));

        match prev {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"),
        }
        match prev_headers {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_HEADERS", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS"),
        }
        match prev_cred {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
        match prev_token {
            Some(v) => std::env::set_var("SUPERCLAW_OTLP_EDGE_TOKEN", v),
            None => std::env::remove_var("SUPERCLAW_OTLP_EDGE_TOKEN"),
        }
    }

    // Verify that when OTEL_EXPORTER_OTLP_HEADERS contains the edge auth header pair
    // (as assembled by servicehub/mod.rs from SUPERCLAW_EDGE_CREDENTIAL_ID +
    // SUPERCLAW_OTLP_EDGE_TOKEN), post_otlp_json forwards both headers verbatim on
    // the HTTP POST.
    #[test]
    fn otlp_transport_forwards_edge_auth_headers() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let prev_endpoint = std::env::var_os("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT");
        let prev_headers = std::env::var_os("OTEL_EXPORTER_OTLP_HEADERS");
        std::env::set_var(
            "OTEL_EXPORTER_OTLP_HEADERS",
            "x-superclaw-credential-id=build-1-1-0-stable,x-superclaw-edge-token=tok_abc123",
        );

        let request = run_otlp_server("metrics", |url| {
            std::env::set_var("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", url);
        });

        assert!(
            request.contains("x-superclaw-credential-id: build-1-1-0-stable"),
            "credential-id header missing:\n{request}"
        );
        assert!(
            request.contains("x-superclaw-edge-token: tok_abc123"),
            "edge-token header missing:\n{request}"
        );

        match prev_endpoint {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"),
        }
        match prev_headers {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_HEADERS", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS"),
        }
    }

    // Verify that when OTEL_EXPORTER_OTLP_HEADERS is absent (and edge cred env unset),
    // no x-superclaw-* headers are emitted.
    #[test]
    fn otlp_transport_sends_no_auth_headers_when_credentials_absent() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let prev_endpoint = std::env::var_os("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT");
        let prev_headers = std::env::var_os("OTEL_EXPORTER_OTLP_HEADERS");
        // Force the base OTEL_EXPORTER_OTLP_ENDPOINT to loopback so this test is isolated from
        // whatever ambient value the environment (or a developer's local `.env`) might supply.
        let prev_base = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_cred = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        let prev_token = std::env::var_os("SUPERCLAW_OTLP_EDGE_TOKEN");
        let prev_skip_debug_env_file = std::env::var_os(otlp_env::SKIP_DEBUG_ENV_FILE_VAR);
        // A developer's local gitignored `.env` (see otlp_env::load_debug_env_file) must not
        // repopulate the credentials this test just removed.
        std::env::set_var(otlp_env::SKIP_DEBUG_ENV_FILE_VAR, "1");
        std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS");
        std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID");
        std::env::remove_var("SUPERCLAW_OTLP_EDGE_TOKEN");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1");

        let request = run_otlp_server("logs", |url| {
            std::env::set_var("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", url);
        });

        assert!(
            !request.contains("x-superclaw-"),
            "unexpected superclaw auth header:\n{request}"
        );

        match prev_skip_debug_env_file {
            Some(v) => std::env::set_var(otlp_env::SKIP_DEBUG_ENV_FILE_VAR, v),
            None => std::env::remove_var(otlp_env::SKIP_DEBUG_ENV_FILE_VAR),
        }
        match prev_endpoint {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"),
        }
        match prev_headers {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_HEADERS", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS"),
        }
        match prev_base {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_cred {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
        match prev_token {
            Some(v) => std::env::set_var("SUPERCLAW_OTLP_EDGE_TOKEN", v),
            None => std::env::remove_var("SUPERCLAW_OTLP_EDGE_TOKEN"),
        }
    }
}
