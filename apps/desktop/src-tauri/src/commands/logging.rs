//! Tauri command bridging the frontend ring-buffer logger to disk.
//!
//! 2026-07-22 follow-up to the 2026-07-21 startup-logging-unification design,
//! which shipped the frontend logger (`apps/ui/src/app/lib/log.ts`) as
//! in-memory-only. This command lets the frontend flush batches of its log
//! records into the same `tracing` pipeline as `tauri.log`
//! (`crate::logging::emit_ui_log`), tagged `component="ui"`, so a startup
//! failure in the webview survives a reload/crash instead of only living in
//! a devtools console.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLogEntry {
    /// One of "debug" | "info" | "warn" | "error"; anything else is treated
    /// as "info" by `emit_ui_log` rather than rejected, so a frontend/backend
    /// level-set drift degrades gracefully instead of dropping the log line.
    pub level: String,
    pub stage: String,
    pub message: String,
    /// Frontend `Date.now()` at record time — may predate arrival here by up
    /// to the frontend's flush-batching interval.
    pub ts: i64,
    /// Structured payload, forwarded as a compact JSON string (kept as
    /// `serde_json::Value` here purely so malformed payloads still deserialize
    /// the rest of the batch instead of rejecting it).
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
}

#[tauri::command]
pub fn ingest_ui_log(entries: Vec<UiLogEntry>) -> Result<(), String> {
    for entry in entries {
        let payload_json = entry.payload.as_ref().map(|v| v.to_string());
        crate::logging::emit_ui_log(
            &entry.level,
            &entry.stage,
            entry.ts,
            &entry.message,
            payload_json.as_deref(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_log_entry_deserializes_from_frontend_camel_case_shape() {
        // Mirrors the exact object shape `log.ts` sends: { level, stage,
        // message, ts, payload }. A drift here (e.g. a rename on either side)
        // would silently drop every frontend log line, so pin the contract.
        let json = r#"{"level":"error","stage":"boot.timeline","message":"boom","ts":1732000000000,"payload":{"a":1}}"#;
        let entry: UiLogEntry = serde_json::from_str(json).expect("valid UiLogEntry");
        assert_eq!(entry.level, "error");
        assert_eq!(entry.stage, "boot.timeline");
        assert_eq!(entry.message, "boom");
        assert_eq!(entry.ts, 1732000000000);
        assert_eq!(entry.payload.unwrap()["a"], 1);
    }

    #[test]
    fn ui_log_entry_payload_defaults_to_none_when_absent() {
        let json = r#"{"level":"info","stage":"boot.snapshot","message":"ok","ts":0}"#;
        let entry: UiLogEntry = serde_json::from_str(json).expect("valid UiLogEntry");
        assert!(entry.payload.is_none());
    }

    #[test]
    fn ingest_ui_log_accepts_an_empty_batch() {
        assert!(ingest_ui_log(vec![]).is_ok());
    }

    #[test]
    fn ingest_ui_log_does_not_error_on_a_batch_with_and_without_payloads() {
        let entries = vec![
            UiLogEntry {
                level: "warn".to_string(),
                stage: "boot.timeline".to_string(),
                message: "no payload".to_string(),
                ts: 1,
                payload: None,
            },
            UiLogEntry {
                level: "error".to_string(),
                stage: "boot.timeline".to_string(),
                message: "with payload".to_string(),
                ts: 2,
                payload: Some(serde_json::json!({"failedStages": ["ready"]})),
            },
        ];
        assert!(ingest_ui_log(entries).is_ok());
    }
}
