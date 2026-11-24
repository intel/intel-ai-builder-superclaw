use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;

pub const SERVICEHUB_PROGRESS_EVENT: &str = "superclaw://servicehub-progress";
pub const SERVICEHUB_READY_EVENT: &str = "superclaw://servicehub-ready";
pub const SERVICEHUB_ERROR_EVENT: &str = "superclaw://servicehub-error";

/// Startup-logging unification (2026-07-21 §3.2 / §4.1): persist ServiceHub boot
/// state transitions to tauri.log so the in-memory state
/// machine leaves an on-disk audit trail correlated by boot_id.
///
/// `elapsed_ms` is milliseconds since the boot state was created — a monotonic
/// per-launch relative clock so the on-disk audit trail (and the boot timeline)
/// stay comparable regardless of the process wall-clock timezone.
fn log_transition(from: Option<&str>, to: &str, elapsed_ms: u64, error: Option<&str>) {
    let from = from.unwrap_or("-");
    match error {
        Some(err) => tracing::error!(
            boot_id = %crate::logging::boot_id(),
            component = "tauri",
            stage = "bootstate.transition",
            from,
            to,
            elapsed_ms,
            "boot state {from} -> {to} (+{elapsed_ms}ms): {err}"
        ),
        None => tracing::info!(
            boot_id = %crate::logging::boot_id(),
            component = "tauri",
            stage = "bootstate.transition",
            from,
            to,
            elapsed_ms,
            "boot state {from} -> {to} (+{elapsed_ms}ms)"
        ),
    }
}

/// Status of a single boot-timeline stage.
///
/// * `ok`   — a normal progress step (or a terminal ready).
/// * `fail` — an error was recorded at this stage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StageStatus {
    Ok,
    Fail,
}

/// One entry in the boot timeline: which stage, how long after boot start it
/// happened, whether it succeeded, and a short human message. This is the
/// "each stage on one line, with relative elapsed and ok/fail" summary that lets
/// a reader see the whole startup flow and pinpoint the slow / failing step
/// without hand-diffing timestamps across logs.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageEntry {
    pub stage: String,
    /// Milliseconds since boot start (monotonic, timezone-independent).
    pub elapsed_ms: u64,
    pub status: StageStatus,
    pub message: String,
}

// ── ServiceHub boot state ──────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHubReadyPayload {
    pub hub_url: String,
    pub hub_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openwork_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owt_token: Option<String>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHubBootSnapshot {
    pub ready: bool,
    pub stage: Option<String>,
    pub message: Option<String>,
    pub pct: Option<f64>,
    pub error: Option<String>,
    /// Set once when SERVICEHUB_READY_EVENT fires.
    pub ready_payload: Option<ServiceHubReadyPayload>,
    /// Launch correlation key (2026-07-21 startup-logging unification). Exposed
    /// so the UI can stamp the same boot_id onto its own logs, correlating the
    /// frontend timeline with tauri.log / servicehub.log.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
    /// Ordered boot timeline: one entry per stage transition, each with a
    /// relative `elapsedMs`, an ok/fail status, and a short message. Lets the UI
    /// render a "startup flow at a glance + where it stalled/failed" summary.
    #[serde(default)]
    pub timeline: Vec<StageEntry>,
    /// Milliseconds since boot start at snapshot time. `None` before the boot
    /// state has been initialized (`reset_starting`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_elapsed_ms: Option<u64>,
}

/// Interior mutable boot state. Holds the serializable [`ServiceHubBootSnapshot`]
/// plus a monotonic boot-start [`Instant`] used to stamp relative elapsed times
/// onto every timeline entry (timezone-independent per-launch clock).
#[derive(Default)]
pub struct ServiceHubBootState {
    inner: Mutex<ServiceHubBootSnapshot>,
    started_at: Mutex<Option<Instant>>,
}

impl ServiceHubBootState {
    /// Milliseconds since boot start, or 0 before `reset_starting` has run.
    fn elapsed_ms(&self) -> u64 {
        self.started_at
            .lock()
            .ok()
            .and_then(|g| *g)
            .map(|start| start.elapsed().as_millis() as u64)
            .unwrap_or(0)
    }

    fn push_stage(
        snap: &mut ServiceHubBootSnapshot,
        stage: &str,
        message: &str,
        elapsed_ms: u64,
        status: StageStatus,
    ) {
        snap.timeline.push(StageEntry {
            stage: stage.to_string(),
            elapsed_ms,
            status,
            message: message.to_string(),
        });
        snap.total_elapsed_ms = Some(elapsed_ms);
    }

    pub fn reset_starting(&self) {
        if let Ok(mut start) = self.started_at.lock() {
            *start = Some(Instant::now());
        }
        if let Ok(mut snap) = self.inner.lock() {
            *snap = ServiceHubBootSnapshot {
                ready: false,
                stage: Some("spawn".to_string()),
                message: Some("Starting ServiceHub".to_string()),
                pct: None,
                error: None,
                ready_payload: None,
                boot_id: None,
                timeline: Vec::new(),
                total_elapsed_ms: Some(0),
            };
            Self::push_stage(&mut snap, "spawn", "Starting ServiceHub", 0, StageStatus::Ok);
        }
    }

    pub fn update_progress(
        &self,
        stage: &str,
        message: &str,
        pct: Option<f64>,
        error: Option<&str>,
    ) {
        let elapsed_ms = self.elapsed_ms();
        if let Ok(mut snap) = self.inner.lock() {
            let prev = snap.stage.clone();
            // Skip the audit line when this call re-affirms the *same* stage
            // `reset_starting` already seeded (e.g. the first `update_progress`
            // after boot start): a `boot state spawn -> spawn (+0ms)` line adds
            // no information and reads as a mistake when grepping tauri.log.
            let is_self_reaffirmation = error.is_none() && prev.as_deref() == Some(stage);
            if !is_self_reaffirmation {
                log_transition(prev.as_deref(), stage, elapsed_ms, error);
            }
            let status = if error.is_some() {
                StageStatus::Fail
            } else {
                StageStatus::Ok
            };
            if is_self_reaffirmation {
                // Refresh the placeholder entry in place instead of appending
                // a second "spawn"/duplicate entry for the same stage — see
                // `reset_starting`, which seeds a generic placeholder before
                // the caller's first real `update_progress` call for that
                // stage arrives with the detailed message.
                if let Some(last) = snap.timeline.last_mut() {
                    last.message = message.to_string();
                    last.elapsed_ms = elapsed_ms;
                } else {
                    Self::push_stage(&mut snap, stage, message, elapsed_ms, status);
                }
                snap.total_elapsed_ms = Some(elapsed_ms);
            } else {
                Self::push_stage(&mut snap, stage, message, elapsed_ms, status);
            }
            snap.stage = Some(stage.to_string());
            snap.message = Some(message.to_string());
            snap.pct = pct;
            if let Some(e) = error {
                snap.error = Some(e.to_string());
            }
        }
    }

    pub fn mark_ready(&self, payload: &ServiceHubReadyPayload) {
        let elapsed_ms = self.elapsed_ms();
        if let Ok(mut snap) = self.inner.lock() {
            let prev = snap.stage.clone();
            // The common call path is `emit_progress(app, "ready", ...)`
            // immediately followed by `mark_ready` — that `update_progress`
            // call already logged the transition and pushed the "ready"
            // timeline entry, so refresh it in place instead of duplicating it.
            let is_self_reaffirmation = prev.as_deref() == Some("ready");
            if is_self_reaffirmation {
                if let Some(last) = snap.timeline.last_mut() {
                    last.elapsed_ms = elapsed_ms;
                }
                snap.total_elapsed_ms = Some(elapsed_ms);
            } else {
                log_transition(prev.as_deref(), "ready", elapsed_ms, None);
                Self::push_stage(
                    &mut snap,
                    "ready",
                    "ServiceHub is ready",
                    elapsed_ms,
                    StageStatus::Ok,
                );
            }
            snap.ready = true;
            snap.stage = Some("ready".to_string());
            snap.message = Some("ServiceHub is ready".to_string());
            snap.pct = Some(1.0);
            snap.error = None;
            snap.ready_payload = Some(payload.clone());
        }
    }

    pub fn mark_error(&self, stage: &str, error: &str) {
        let elapsed_ms = self.elapsed_ms();
        if let Ok(mut snap) = self.inner.lock() {
            log_transition(snap.stage.as_deref(), stage, elapsed_ms, Some(error));
            Self::push_stage(&mut snap, stage, error, elapsed_ms, StageStatus::Fail);
            snap.stage = Some(stage.to_string());
            snap.error = Some(error.to_string());
        }
    }

    pub fn snapshot(&self) -> ServiceHubBootSnapshot {
        let mut snap = self.inner.lock().map(|s| s.clone()).unwrap_or_default();
        snap.boot_id = Some(crate::logging::boot_id().to_string());
        // Refresh `total_elapsed_ms` to the current monotonic clock while the
        // boot is still in progress, so a snapshot fetched between two state
        // transitions (e.g. while stalled waiting on a stage) reflects elapsed
        // time "now" instead of the timestamp of the last transition. Terminal
        // states (ready/error) keep the frozen elapsed time recorded when they
        // were reached — that is the meaningful "time to ready/fail" metric.
        if !snap.ready && snap.error.is_none() && snap.stage.is_some() {
            snap.total_elapsed_ms = Some(self.elapsed_ms());
        }
        snap
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Positive: ServiceHubBootState ──────────────────────────────────

    #[test]
    fn default_snapshot_is_not_ready() {
        let state = ServiceHubBootState::default();
        let snap = state.snapshot();
        assert!(!snap.ready);
        assert!(snap.stage.is_none());
        assert!(snap.message.is_none());
        assert!(snap.pct.is_none());
        assert!(snap.error.is_none());
        assert!(snap.ready_payload.is_none());
    }

    #[test]
    fn update_progress_sets_fields() {
        let state = ServiceHubBootState::default();
        state.update_progress(
            "handshake.complete",
            "ServiceHub ready on port 19000",
            Some(0.5),
            None,
        );

        let snap = state.snapshot();
        assert_eq!(snap.stage.as_deref(), Some("handshake.complete"));
        assert_eq!(
            snap.message.as_deref(),
            Some("ServiceHub ready on port 19000")
        );
        assert_eq!(snap.pct, Some(0.5));
        assert!(snap.error.is_none());
        assert!(!snap.ready); // not yet ready
    }

    #[test]
    fn update_progress_with_error_sets_error() {
        let state = ServiceHubBootState::default();
        state.update_progress("spawn.failed", "could not start", None, Some("spawn error"));

        let snap = state.snapshot();
        assert_eq!(snap.error.as_deref(), Some("spawn error"));
    }

    #[test]
    fn mark_ready_sets_ready_state() {
        let state = ServiceHubBootState::default();
        let payload = ServiceHubReadyPayload {
            hub_url: "http://127.0.0.1:19000".to_string(),
            hub_token: "secret-token".to_string(),
            openwork_url: None,
            owt_token: None,
        };
        state.mark_ready(&payload);

        let snap = state.snapshot();
        assert!(snap.ready);
        assert_eq!(snap.stage.as_deref(), Some("ready"));
        assert_eq!(
            snap.message.as_deref(),
            Some("ServiceHub is ready")
        );
        assert_eq!(snap.pct, Some(1.0));
        assert!(snap.error.is_none());

        let rp = snap.ready_payload.unwrap();
        assert_eq!(rp.hub_url, "http://127.0.0.1:19000");
        assert_eq!(rp.hub_token, "secret-token");
        assert!(rp.openwork_url.is_none());
        assert!(rp.owt_token.is_none());
    }

    #[test]
    fn mark_ready_clears_prior_error() {
        let state = ServiceHubBootState::default();
        // Set an error first
        state.mark_error("spawn.failed", "timeout");
        assert!(state.snapshot().error.is_some());

        // Then mark ready — error should be cleared
        let payload = ServiceHubReadyPayload {
            hub_url: "http://127.0.0.1:19000".to_string(),
            hub_token: "tok".to_string(),
            openwork_url: None,
            owt_token: None,
        };
        state.mark_ready(&payload);
        assert!(state.snapshot().error.is_none());
        assert!(state.snapshot().ready);
    }

    #[test]
    fn mark_ready_with_data_plane_tokens() {
        let state = ServiceHubBootState::default();
        let payload = ServiceHubReadyPayload {
            hub_url: "http://127.0.0.1:19000".to_string(),
            hub_token: "hub-tok".to_string(),
            openwork_url: Some("http://127.0.0.1:8787".to_string()),
            owt_token: Some("owt-tok".to_string()),
        };
        state.mark_ready(&payload);

        let rp = state.snapshot().ready_payload.unwrap();
        assert_eq!(rp.openwork_url.as_deref(), Some("http://127.0.0.1:8787"));
        assert_eq!(rp.owt_token.as_deref(), Some("owt-tok"));
    }

    // ── Negative: ServiceHubBootState ──────────────────────────────────

    #[test]
    fn mark_error_sets_error_but_not_ready() {
        let state = ServiceHubBootState::default();
        state.mark_error("handshake.timeout", "Timeout waiting for handshake");

        let snap = state.snapshot();
        assert!(!snap.ready);
        assert_eq!(snap.stage.as_deref(), Some("handshake.timeout"));
        assert_eq!(snap.error.as_deref(), Some("Timeout waiting for handshake"));
        assert!(snap.ready_payload.is_none());
    }

    #[test]
    fn mark_error_does_not_overwrite_message_or_pct() {
        let state = ServiceHubBootState::default();
        state.update_progress("spawn", "Starting...", Some(0.1), None);
        state.mark_error("spawn.failed", "Process crashed");

        let snap = state.snapshot();
        // mark_error only sets stage + error, not message/pct
        assert_eq!(snap.stage.as_deref(), Some("spawn.failed"));
        assert_eq!(snap.error.as_deref(), Some("Process crashed"));
        // Original message and pct preserved
        assert_eq!(snap.message.as_deref(), Some("Starting..."));
        assert_eq!(snap.pct, Some(0.1));
    }

    #[test]
    fn update_progress_does_not_clear_previous_error_without_explicit_param() {
        let state = ServiceHubBootState::default();
        state.mark_error("spawn.failed", "failed");

        // Calling update_progress without error param does NOT clear the error
        state.update_progress("retry", "retrying...", Some(0.0), None);

        let snap = state.snapshot();
        assert_eq!(snap.stage.as_deref(), Some("retry"));
        // Error from mark_error is still present
        assert_eq!(snap.error.as_deref(), Some("failed"));
    }

    // ── Positive: ServiceHubReadyPayload serialization ─────────────────

    #[test]
    fn ready_payload_serializes_without_optional_fields() {
        let payload = ServiceHubReadyPayload {
            hub_url: "http://127.0.0.1:19000".to_string(),
            hub_token: "tok".to_string(),
            openwork_url: None,
            owt_token: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("hubUrl"));
        assert!(json.contains("hubToken"));
        // Optional None fields should be skipped
        assert!(!json.contains("openworkUrl"));
        assert!(!json.contains("owtToken"));
    }

    #[test]
    fn ready_payload_serializes_with_optional_fields() {
        let payload = ServiceHubReadyPayload {
            hub_url: "http://127.0.0.1:19000".to_string(),
            hub_token: "tok".to_string(),
            openwork_url: Some("http://127.0.0.1:8787".to_string()),
            owt_token: Some("owt".to_string()),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("openworkUrl"));
        assert!(json.contains("owtToken"));
    }

    // ── Event constants ───────────────────────────────────────────────

    #[test]
    fn event_constants_are_distinct() {
        assert_ne!(SERVICEHUB_PROGRESS_EVENT, SERVICEHUB_READY_EVENT);
        assert_ne!(SERVICEHUB_READY_EVENT, SERVICEHUB_ERROR_EVENT);
        assert_ne!(SERVICEHUB_PROGRESS_EVENT, SERVICEHUB_ERROR_EVENT);
    }

    // ── State transition audit (2026-07-21 startup-logging design) ─────

    #[test]
    fn transitions_drive_state_machine_and_do_not_panic() {
        // `log_transition` fires on each state change; with no global tracing
        // subscriber installed these are no-ops, so this test asserts the
        // transitions are wired without panicking and the state advances as
        // expected across the spawn -> progress -> ready path.
        let state = ServiceHubBootState::default();
        state.reset_starting();
        assert_eq!(state.snapshot().stage.as_deref(), Some("spawn"));

        state.update_progress("handshake.complete", "ready on port", Some(0.5), None);
        assert_eq!(state.snapshot().stage.as_deref(), Some("handshake.complete"));

        let payload = ServiceHubReadyPayload {
            hub_url: "http://127.0.0.1:19000".to_string(),
            hub_token: "tok".to_string(),
            openwork_url: None,
            owt_token: None,
        };
        state.mark_ready(&payload);
        let snap = state.snapshot();
        assert!(snap.ready);
        assert_eq!(snap.stage.as_deref(), Some("ready"));
    }

    // ── Boot timeline summary (2026-07-22 boot-timeline follow-up) ─────

    #[test]
    fn timeline_records_each_stage_in_order_with_status() {
        let state = ServiceHubBootState::default();
        state.reset_starting();
        state.update_progress("handshake.complete", "ready on port", Some(0.5), None);
        state.update_progress("data-plane", "attaching", Some(0.6), None);
        let payload = ServiceHubReadyPayload {
            hub_url: "http://127.0.0.1:19000".to_string(),
            hub_token: "tok".to_string(),
            openwork_url: None,
            owt_token: None,
        };
        state.mark_ready(&payload);

        let snap = state.snapshot();
        let stages: Vec<&str> = snap.timeline.iter().map(|e| e.stage.as_str()).collect();
        assert_eq!(
            stages,
            vec!["spawn", "handshake.complete", "data-plane", "ready"]
        );
        // All ok on the happy path.
        assert!(snap.timeline.iter().all(|e| e.status == StageStatus::Ok));
        assert!(snap.total_elapsed_ms.is_some());
    }

    #[test]
    fn timeline_marks_failing_stage_as_fail() {
        let state = ServiceHubBootState::default();
        state.reset_starting();
        state.mark_error("handshake.timeout", "Timeout waiting for handshake");

        let snap = state.snapshot();
        let last = snap.timeline.last().expect("timeline has entries");
        assert_eq!(last.stage, "handshake.timeout");
        assert_eq!(last.status, StageStatus::Fail);
        assert_eq!(last.message, "Timeout waiting for handshake");
    }

    #[test]
    fn timeline_elapsed_is_monotonic_non_decreasing() {
        let state = ServiceHubBootState::default();
        state.reset_starting();
        std::thread::sleep(std::time::Duration::from_millis(5));
        state.update_progress("handshake.complete", "ready", Some(0.5), None);
        std::thread::sleep(std::time::Duration::from_millis(5));
        state.update_progress("data-plane", "attaching", Some(0.6), None);

        let snap = state.snapshot();
        let elapsed: Vec<u64> = snap.timeline.iter().map(|e| e.elapsed_ms).collect();
        for pair in elapsed.windows(2) {
            assert!(pair[1] >= pair[0], "elapsed must not go backwards: {elapsed:?}");
        }
        // First entry (spawn) is at ~0.
        assert_eq!(elapsed.first().copied(), Some(0));
    }

    #[test]
    fn timeline_serializes_camel_case_fields() {
        let state = ServiceHubBootState::default();
        state.reset_starting();
        let snap = state.snapshot();
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("timeline"));
        assert!(json.contains("elapsedMs"));
        assert!(json.contains("totalElapsedMs"));
        assert!(json.contains("\"status\":\"ok\""));
    }

    // ── Regression: duplicate timeline entries (2026-07-22 dedup follow-up) ─

    #[test]
    fn spawn_stage_is_not_duplicated_when_reaffirmed() {
        // Mirrors the real `start_servicehub` sequence: `reset_starting` seeds
        // a placeholder "spawn" entry, then the caller immediately calls
        // `update_progress("spawn", ...)` with a more detailed message. That
        // must refresh the placeholder in place, not append a second "spawn".
        let state = ServiceHubBootState::default();
        state.reset_starting();
        state.update_progress(
            "spawn",
            "Starting ServiceHub (bundled) from /some/path",
            None,
            None,
        );

        let snap = state.snapshot();
        let stages: Vec<&str> = snap.timeline.iter().map(|e| e.stage.as_str()).collect();
        assert_eq!(stages, vec!["spawn"]);
        assert_eq!(
            snap.timeline[0].message,
            "Starting ServiceHub (bundled) from /some/path"
        );
    }

    #[test]
    fn ready_stage_is_not_duplicated_when_mark_ready_follows_update_progress() {
        // Mirrors the real boot sequence: `emit_progress(app, "ready", ...)`
        // (-> `update_progress`) immediately followed by `mark_ready`. Only
        // one "ready" timeline entry should be recorded.
        let state = ServiceHubBootState::default();
        state.reset_starting();
        state.update_progress(
            "ready",
            "ServiceHub is ready",
            Some(1.0),
            None,
        );

        let payload = ServiceHubReadyPayload {
            hub_url: "http://127.0.0.1:19000".to_string(),
            hub_token: "tok".to_string(),
            openwork_url: None,
            owt_token: None,
        };
        state.mark_ready(&payload);

        let snap = state.snapshot();
        let stages: Vec<&str> = snap.timeline.iter().map(|e| e.stage.as_str()).collect();
        assert_eq!(stages, vec!["spawn", "ready"]);
        assert!(snap.ready);
        assert_eq!(
            snap.ready_payload.unwrap().hub_url,
            "http://127.0.0.1:19000"
        );
    }

    // ── Regression: snapshot() elapsed clock (2026-07-22 dedup follow-up) ──

    #[test]
    fn snapshot_refreshes_elapsed_while_in_progress() {
        let state = ServiceHubBootState::default();
        state.reset_starting();
        state.update_progress("handshake.complete", "ready on port", Some(0.5), None);

        let first = state.snapshot().total_elapsed_ms.unwrap();
        std::thread::sleep(std::time::Duration::from_millis(15));
        let second = state.snapshot().total_elapsed_ms.unwrap();

        assert!(
            second > first,
            "snapshot() should reflect the live clock while boot is in progress: {first} -> {second}"
        );
    }

    #[test]
    fn snapshot_freezes_elapsed_once_ready() {
        let state = ServiceHubBootState::default();
        state.reset_starting();
        let payload = ServiceHubReadyPayload {
            hub_url: "http://127.0.0.1:19000".to_string(),
            hub_token: "tok".to_string(),
            openwork_url: None,
            owt_token: None,
        };
        state.mark_ready(&payload);

        let first = state.snapshot().total_elapsed_ms.unwrap();
        std::thread::sleep(std::time::Duration::from_millis(15));
        let second = state.snapshot().total_elapsed_ms.unwrap();

        assert_eq!(
            first, second,
            "snapshot() must keep the frozen time-to-ready after boot completes"
        );
    }
}
