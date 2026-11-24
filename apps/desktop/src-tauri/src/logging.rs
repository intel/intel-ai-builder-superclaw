//! Unified startup logging for the Tauri desktop shell.
//!
//! Part of the 2026-07-21 startup-logging-unification design (leaf-level
//! observability). Establishes a single `boot_id` for the whole application
//! launch and wires `tracing` to a per-launch file sink under
//! `%LOCALAPPDATA%\SuperClaw\app\tauri_<ts>.log` (the desktop shell's own
//! launch-log dir, kept separate from the Python `servicehub` data dir) plus
//! stderr, so an installed build — which has no console under
//! `windows_subsystem="windows"` — still has an on-disk startup timeline.
//! `ingest_ui_log` (2026-07-22 follow-up) routes the frontend's
//! in-memory ring-buffer logger through this same sink, tagged
//! `component="ui"`, so a startup failure in the webview also lands on disk
//! instead of only living in a devtools console that's gone once the window
//! closes.
//!
//! Time alignment across Rust/Python/container logs is deliberately left to a
//! human sorting by UTC under one `boot_id`; this module only guarantees the
//! Rust timestamps are UTC-parseable and carry the `boot_id`.

use std::fmt::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use time::macros::format_description;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::time::{FormatTime, UtcTime};
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields};
use tracing_subscriber::prelude::*;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::EnvFilter;

/// Filename stem for a launch log. Each process launch writes a fresh file
/// `tauri_<YYYYMMDDTHHMMSS>.log` (see `launch_log_filename`) — mirroring the
/// Python services' per-launch timestamped files (`sbms-<ts>.log`,
/// `llmrouter_manager-<ts>.log`) so the whole stack shares one naming scheme
/// and the same second-level precision (an app can launch several times a day).
const LOG_FILE_STEM: &str = "tauri";

/// How many `tauri_*.log` files to keep. `tracing-appender`'s fixed-file
/// appender has no built-in rotation/retention, so we prune by file count on
/// startup. Ten launches covers normal hot-reload/debug cycles without
/// unbounded growth.
const LOG_FILE_RETENTION: usize = 10;

/// The correlation key for one whole application launch. Injected into the
/// ServiceHub child via `SUPERCLAW_BOOT_ID`, echoed by Python loguru and the
/// sandbox container so a single value greps out the full startup timeline.
static BOOT_ID: OnceLock<String> = OnceLock::new();

/// Keeps the non-blocking file-appender worker alive for the process lifetime.
static FILE_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

/// Resolve the directory the Tauri shell writes its startup logs into.
///
/// The desktop shell's own launch log (`tauri.log`, plus routed frontend UI
/// lines) lives under a dedicated **`%LOCALAPPDATA%\SuperClaw\app`** directory,
/// kept separate from the Python `servicehub` data dir (`servicehub.log` and
/// friends). `SUPERCLAW_APP_LOG_DIR` overrides the location outright (e.g. for
/// tests or a portable install); otherwise it derives from `%LOCALAPPDATA%`.
pub(crate) fn resolve_log_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("SUPERCLAW_APP_LOG_DIR") {
        let p = PathBuf::from(dir);
        if !p.as_os_str().is_empty() {
            return Some(p);
        }
    }

    std::env::var("LOCALAPPDATA")
        .ok()
        .map(|local| PathBuf::from(local).join("SuperClaw").join("app"))
}

/// Filename for this launch's log: `tauri_<YYYYMMDDTHHMMSS>.log` (UTC,
/// second-level precision to match the Python services' per-launch files).
/// A fresh file per launch means the name ends in `.log` (unlike
/// `tracing-appender`'s rotation, which forces a trailing `.<date>` suffix).
fn launch_log_filename() -> String {
    let now = time::OffsetDateTime::now_utc();
    let ts = now
        .format(format_description!(
            "[year][month][day]T[hour][minute][second]"
        ))
        .unwrap_or_else(|_| "unknown".to_string());
    format!("{LOG_FILE_STEM}_{ts}.log")
}

/// Keep only the most recent `LOG_FILE_RETENTION` `tauri_*.log` files in `dir`,
/// deleting older ones. Best-effort: any IO error is ignored (retention is a
/// housekeeping nicety, not a correctness requirement). Timestamped filenames
/// sort lexicographically in chronological order, so a plain name sort suffices.
fn prune_old_logs(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut logs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(&format!("{LOG_FILE_STEM}_")) && n.ends_with(".log"))
                .unwrap_or(false)
        })
        .collect();
    if logs.len() <= LOG_FILE_RETENTION {
        return;
    }
    logs.sort();
    let remove_count = logs.len() - LOG_FILE_RETENTION;
    for old in logs.into_iter().take(remove_count) {
        let _ = std::fs::remove_file(old);
    }
}

/// Generate a short, sortable boot id: `<unix_ms hex>-<short uuid>`.
fn generate_boot_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let short = uuid::Uuid::new_v4().simple().to_string();
    format!("{millis:x}-{}", &short[..8])
}

/// The `boot_id` for this launch. Idempotent — first call fixes the value.
pub fn boot_id() -> &'static str {
    BOOT_ID.get_or_init(generate_boot_id)
}

/// Collects an event's fields, splitting out `component` so it can be rendered
/// as a `[component]` prefix at the head of the line (right after the level),
/// while `message` becomes the line body and every other field trails as
/// `key=value`. This is the single rendering seam that gives every `tauri.log`
/// line (`component="tauri"` / `"servicehub"` / `"ui"`) a scannable module tag
/// up front instead of burying `component="ui"` at the end of the line.
#[derive(Default)]
struct FieldExtractor {
    component: Option<String>,
    message: Option<String>,
    rest: String,
}

impl Visit for FieldExtractor {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        match field.name() {
            "component" => self.component = Some(strip_quotes(&format!("{value:?}"))),
            "message" => self.message = Some(format!("{value:?}")),
            name => {
                // Keep the same `key=value` shape the default fmt layer used, so
                // existing greps on `boot_id=`, `stage=`, etc. keep matching.
                let _ = write!(self.rest, " {name}={value:?}");
            }
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "component" => self.component = Some(value.to_string()),
            "message" => self.message = Some(value.to_string()),
            name => {
                let _ = write!(self.rest, " {name}={value:?}");
            }
        }
    }
}

/// `{:?}` on a string value yields a quoted form (`"ui"`); the prefix reads
/// cleaner as `[ui]` than `["ui"]`.
fn strip_quotes(s: &str) -> String {
    s.trim_matches('"').to_string()
}

/// Line layout: `<utc-ts>  <LEVEL> [<component>] <message><trailing fields>`.
/// A missing `component` degrades to no bracket rather than an empty `[]`.
struct PrefixedFormat;

impl<S, N> FormatEvent<S, N> for PrefixedFormat
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        _ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let timer = UtcTime::rfc_3339();
        timer.format_time(&mut writer)?;
        write!(writer, "  ")?;

        let meta = event.metadata();
        write!(writer, "{:>5} ", meta.level())?;

        let mut fields = FieldExtractor::default();
        event.record(&mut fields);

        if let Some(component) = &fields.component {
            write!(writer, "[{component}] ")?;
        }
        if let Some(message) = &fields.message {
            write!(writer, "{message}")?;
        }
        writer.write_str(&fields.rest)?;
        writeln!(writer)
    }
}

/// Initialize tracing: per-launch file sink under
/// `%LOCALAPPDATA%\SuperClaw\app\tauri_<ts>.log` plus stderr. Idempotent and
/// best-effort — a failure to open the file sink degrades to stderr-only
/// rather than aborting startup.
///
/// Returns the resolved log file path when the file sink was installed.
pub fn init() -> Option<PathBuf> {
    // Fix the boot id first so it is present in the very first log line.
    let boot = boot_id().to_string();

    let filter = EnvFilter::try_from_env("SUPERCLAW_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info"));

    let stderr_layer = tracing_subscriber::fmt::layer()
        .event_format(PrefixedFormat)
        .with_writer(std::io::stderr);

    let (file_layer, log_path) = match resolve_log_dir() {
        Some(dir) if std::fs::create_dir_all(&dir).is_ok() => {
            // One fresh file per launch: `tauri_<ts>.log` (mirrors the Python
            // services' per-launch naming). Prune old files by count first
            // (closest equivalent to the loguru services' "keep 3").
            prune_old_logs(&dir);
            let path = dir.join(launch_log_filename());
            match std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                Ok(file) => {
                    let (non_blocking, guard) = tracing_appender::non_blocking(file);
                    let _ = FILE_GUARD.set(guard);
                    let layer = tracing_subscriber::fmt::layer()
                        .event_format(PrefixedFormat)
                        .with_ansi(false)
                        .with_writer(non_blocking);
                    (Some(layer), Some(path))
                }
                Err(_) => (None, None),
            }
        }
        _ => (None, None),
    };

    let registry = tracing_subscriber::registry()
        .with(filter)
        .with(stderr_layer)
        .with(file_layer);

    // `try_init` is a no-op error if a global subscriber already exists; that
    // keeps this idempotent for tests and repeated calls.
    let _ = registry.try_init();

    tracing::info!(
        boot_id = %boot,
        component = "tauri",
        stage = "log.init",
        log_file = ?log_path,
        "tauri logging initialized"
    );

    log_path
}

/// Persist one frontend ring-buffer log line through the same `tracing`
/// pipeline as the rest of the Rust/Python stack, tagged `component="ui"`.
///
/// This is the disk-persistence half of the frontend logger (`apps/ui/src/
/// app/lib/log.ts`): the 2026-07-21 design shipped it as in-memory-only
/// (ring buffer, lost on reload/crash); this routes it into `tauri.log`
/// instead of a separate `ui.log` so a single `boot_id` grep already covers
/// the frontend without adding another file/rotation policy to track.
///
/// `client_ts_ms` is the frontend's own `Date.now()` at record time — it can
/// lag the line landing here by up to the frontend's flush-batching window,
/// so it's logged as a distinct field rather than trusted as the line's own
/// timestamp (which is this call's wall-clock time, per the `tracing` layer).
pub fn emit_ui_log(
    level: &str,
    stage: &str,
    client_ts_ms: i64,
    message: &str,
    payload_json: Option<&str>,
) {
    let boot = boot_id();
    let payload = payload_json.unwrap_or("");
    match level {
        "error" => tracing::error!(
            boot_id = %boot,
            component = "ui",
            stage,
            client_ts_ms,
            payload,
            "{message}"
        ),
        "warn" => tracing::warn!(
            boot_id = %boot,
            component = "ui",
            stage,
            client_ts_ms,
            payload,
            "{message}"
        ),
        "debug" => tracing::debug!(
            boot_id = %boot,
            component = "ui",
            stage,
            client_ts_ms,
            payload,
            "{message}"
        ),
        _ => tracing::info!(
            boot_id = %boot,
            component = "ui",
            stage,
            client_ts_ms,
            payload,
            "{message}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── launch_log_filename ─────────────────────────────────────────────

    #[test]
    fn launch_log_filename_is_timestamped_and_ends_with_log() {
        // Shape: `tauri_<YYYYMMDDTHHMMSS>.log` — ends in `.log` (not a trailing
        // `.<date>`), and carries second-level precision so multiple launches
        // in one day produce distinct files, matching the Python services.
        let name = launch_log_filename();
        assert!(name.starts_with("tauri_"), "expected tauri_ prefix, got {name}");
        assert!(name.ends_with(".log"), "expected .log suffix, got {name}");
        // `tauri_` (6) + `YYYYMMDDTHHMMSS` (15) + `.log` (4) = 25 chars.
        let ts = &name["tauri_".len()..name.len() - ".log".len()];
        assert_eq!(ts.len(), 15, "expected YYYYMMDDTHHMMSS, got {ts}");
        assert_eq!(&ts[8..9], "T", "expected 'T' date/time separator, got {ts}");
    }

    #[test]
    fn prune_old_logs_keeps_most_recent_and_ignores_others() {
        let dir = std::env::temp_dir().join(format!(
            "superclaw-logtest-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // More timestamped launch logs than retention + one alien file.
        for index in 1..=LOG_FILE_RETENTION + 2 {
            std::fs::write(dir.join(format!("tauri_20260722T{index:06}.log")), b"x").unwrap();
        }
        std::fs::write(dir.join("servicehub.log"), b"x").unwrap();

        prune_old_logs(&dir);

        let mut remaining: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        remaining.sort();
        assert_eq!(remaining.len(), LOG_FILE_RETENTION + 1);
        assert_eq!(remaining[0], "servicehub.log");
        assert!(!remaining.contains(&"tauri_20260722T000001.log".to_string()));
        assert!(!remaining.contains(&"tauri_20260722T000002.log".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── boot_id ─────────────────────────────────────────────────────────

    #[test]
    fn boot_id_is_stable_across_calls() {
        // OnceLock-backed: repeated calls within a process must agree, or the
        // whole "one boot_id greps the full launch" premise breaks.
        assert_eq!(boot_id(), boot_id());
    }

    // ── emit_ui_log ─────────────────────────────────────────────────────

    #[test]
    fn emit_ui_log_does_not_panic_for_any_known_level() {
        // No global subscriber is installed in unit tests, so these are
        // no-ops; the assertion is simply that routing frontend log levels
        // through here never panics regardless of level/payload shape.
        for level in ["debug", "info", "warn", "error", "unknown-level"] {
            emit_ui_log(level, "boot.snapshot", 0, "test message", None);
            emit_ui_log(level, "boot.snapshot", 0, "test message", Some("{\"a\":1}"));
        }
    }

    // ── PrefixedFormat ──────────────────────────────────────────────────

    /// A `MakeWriter` that appends every formatted line into a shared buffer,
    /// so a test can install a `PrefixedFormat` subscriber and inspect the
    /// exact rendered line.
    #[derive(Clone)]
    struct BufWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for BufWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for BufWriter {
        type Writer = BufWriter;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    fn render_with_prefixed_format(emit: impl FnOnce()) -> String {
        let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let layer = tracing_subscriber::fmt::layer()
            .event_format(PrefixedFormat)
            .with_writer(BufWriter(buf.clone()));
        let subscriber = tracing_subscriber::registry().with(layer);
        tracing::subscriber::with_default(subscriber, emit);
        let bytes = buf.lock().unwrap().clone();
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn prefixed_format_renders_component_as_a_leading_bracket_tag() {
        // The whole point of this module tag: `[ui]` sits right after the
        // level and before the message, and the remaining fields (boot_id,
        // stage, ...) trail as `key=value` so existing greps still match.
        let line = render_with_prefixed_format(|| {
            tracing::info!(
                boot_id = "b-123",
                component = "ui",
                stage = "runtime.owt",
                "Workspace token refreshed successfully"
            );
        });
        let tag_at = line.find("[ui]").expect("expected [ui] tag");
        let msg_at = line
            .find("Workspace token refreshed successfully")
            .expect("expected message");
        assert!(tag_at < msg_at, "tag must precede message: {line}");
        assert!(line.contains(" INFO "), "level must render: {line}");
        assert!(line.contains("boot_id=\"b-123\""), "boot_id must trail: {line}");
        assert!(line.contains("stage=\"runtime.owt\""), "stage must trail: {line}");
    }

    #[test]
    fn prefixed_format_omits_bracket_when_no_component() {
        // A line without `component` degrades to no bracket, not an empty `[]`.
        let line = render_with_prefixed_format(|| {
            tracing::info!(stage = "log.init", "no component here");
        });
        assert!(!line.contains("[]"), "must not emit empty bracket: {line}");
        assert!(line.contains("no component here"), "message must render: {line}");
    }
}
