use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::backend_progress::{
    ServiceHubBootState, ServiceHubReadyPayload, SERVICEHUB_ERROR_EVENT, SERVICEHUB_PROGRESS_EVENT,
    SERVICEHUB_READY_EVENT,
};
use crate::utils::truncate_output;

pub mod manager;
mod port;
pub mod readiness;
pub mod sandbox_proxy;

mod identity;
use identity::{
    lockfile_pid_process_is_running as identity_lockfile_pid_process_is_running,
    run_reuse_listener_preflight, servicehub_reuse_process_is_ours, tcp_listener_status,
    ReuseListenerPreflight, TcpListenerStatus,
};
#[cfg(test)]
use identity::*;

use manager::{ServiceHubInfo, ServiceHubManager, ServiceHubState};

const SERVICEHUB_HANDSHAKE_PREFIX: &str = "SERVICEHUB_READY ";
const SERVICEHUB_REUSE_PREFIX: &str = "REUSE ";
const SERVICEHUB_LOCKFILE: &str = "servicehub.lock";
/// Image name of the packaged multi-role bundle that hosts ServiceHub and its four
/// children, selected at spawn with `--service <role>`.
///
/// The payload DIRECTORY is still `servicehub\`; only the image is named for the
/// bundle, because every role runs from it and Task Manager would otherwise list
/// five identical `servicehub.exe` rows. Must equal `launch.exe_name` in
/// `service_cfg.json` — ServiceHub refuses to re-exec an image whose name disagrees.
pub(crate) const SERVICEHUB_EXE_NAME: &str = "superclaw-services.exe";
/// Pre-rename image name. Retained ONLY for recognizing a stale process left by a
/// build from before the rename, never for launching one: such a bundle ships a
/// `service_cfg.json` that names the new image, so its children would refuse to
/// spawn.
pub(crate) const SERVICEHUB_LEGACY_EXE_NAME: &str = "servicehub.exe";
const HANDSHAKE_TIMEOUT_SECS: u64 = 300;
const REUSE_LISTENER_STARTUP_TIMEOUT: Duration = Duration::from_secs(HANDSHAKE_TIMEOUT_SECS);
const REUSE_LISTENER_STARTUP_POLL: Duration = Duration::from_millis(200);
const REUSE_CHILD_RESTART_TIMEOUT: Duration = Duration::from_secs(120);
const REUSE_CHILD_HEALTH_SETTLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Stale-REUSE self-heal restart limiter. The recovery path kills a half-dead
/// kept-alive Hub and cold-restarts via `start_servicehub`, which spawns a new
/// boot thread that may itself hit REUSE again. Without a cap, a persistently
/// broken lockfile/mutex could loop restarts indefinitely. We allow at most
/// `MAX_STALE_REUSE_RESTARTS` consecutively; successful convergence resets the
/// budget so unrelated stale events do not accumulate.
const MAX_STALE_REUSE_RESTARTS: u32 = 3;
static STALE_REUSE_ATTEMPTS: Mutex<u32> = Mutex::new(0);

fn reset_stale_reuse_restart_budget() {
    match STALE_REUSE_ATTEMPTS.lock() {
        Ok(mut attempts) => *attempts = 0,
        Err(poisoned) => *poisoned.into_inner() = 0,
    }
}

/// Record a consecutive stale-REUSE recovery attempt and report whether it is
/// within budget. A successfully converged boot resets the counter.
fn stale_reuse_restart_allowed() -> bool {
    let mut attempts = match STALE_REUSE_ATTEMPTS.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    if *attempts >= MAX_STALE_REUSE_RESTARTS {
        return false;
    }
    *attempts += 1;
    true
}
/// Timeout for the graceful-shutdown HTTP POST (user is quitting — keep short).
const SHUTDOWN_HTTP_TIMEOUT: Duration = Duration::from_secs(5);

// ── Launch target resolution ───────────────────────────────────────────────

struct ServiceHubLaunchTarget {
    command: String,
    args: Vec<String>,
    cwd: PathBuf,
    env: Vec<(&'static str, String)>,
    description: String,
    allow_python_reuse: bool,
}

fn python_servicehub_target(
    servicehub_dir: PathBuf,
    description: String,
    port: u16,
) -> ServiceHubLaunchTarget {
    let port = port.to_string();
    let host_dir = servicehub_dir
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| servicehub_dir.clone());
    let service_cfg_path = servicehub_dir.join("service_cfg.json");
    let host_venv_python = host_dir.join(".venv").join("Scripts").join("python.exe");

    if host_venv_python.is_file() {
        return ServiceHubLaunchTarget {
            command: host_venv_python.to_string_lossy().to_string(),
            args: vec![
                "-u".to_string(),
                "-m".to_string(),
                "servicehub".to_string(),
                "--port".to_string(),
                port,
            ],
            cwd: host_dir,
            env: vec![
                ("PYTHONUNBUFFERED", "1".to_string()),
                (
                    "SERVICEHUB_CFG",
                    service_cfg_path.to_string_lossy().to_string(),
                ),
            ],
            description: format!("{} via host/.venv python", description),
            allow_python_reuse: true,
        };
    }

    let args: Vec<String> = [
        "run",
        "python",
        "-u",
        "-m",
        "servicehub",
        "--port",
        port.as_str(),
        "--service-cfg",
        "servicehub/service_cfg.json",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();

    ServiceHubLaunchTarget {
        command: "uv".to_string(),
        args,
        cwd: host_dir,
        env: vec![("PYTHONUNBUFFERED", "1".to_string())],
        description,
        allow_python_reuse: true,
    }
}

fn exe_servicehub_target(
    exe_path: PathBuf,
    cwd: PathBuf,
    description: String,
    port: u16,
) -> ServiceHubLaunchTarget {
    ServiceHubLaunchTarget {
        command: exe_path.to_string_lossy().to_string(),
        args: vec![
            "--service".to_string(),
            "servicehub".to_string(),
            "--port".to_string(),
            port.to_string(),
            "--service-cfg".to_string(),
            "service_cfg.json".to_string(),
        ],
        cwd,
        env: Vec::new(),
        description,
        allow_python_reuse: false,
    }
}

fn find_repo_servicehub_dir_from(start_dir: PathBuf) -> Option<PathBuf> {
    for dir in start_dir.ancestors() {
        let candidate = dir.join("host").join("servicehub");
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_repo_servicehub_dir_from_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // Walk up enough levels to find the repo root from the exe location.
    let mut dir = exe.parent().map(|p| p.to_path_buf());
    for _ in 0..5 {
        dir = dir.and_then(|current| current.parent().map(|p| p.to_path_buf()));
    }
    let root = dir?;
    let candidate = root.join("host").join("servicehub");
    candidate.is_dir().then_some(candidate)
}

fn installed_sibling_servicehub_target_from_exe(
    exe: &Path,
    port: u16,
) -> Option<ServiceHubLaunchTarget> {
    let app_dir = exe.parent()?;
    let servicehub_dir = app_dir.join("servicehub");
    let servicehub_exe = servicehub_dir.join(SERVICEHUB_EXE_NAME);
    if servicehub_exe.is_file() {
        return Some(exe_servicehub_target(
            servicehub_exe,
            servicehub_dir,
            format!("installed sibling {SERVICEHUB_EXE_NAME}"),
            port,
        ));
    }
    None
}

/// Resolve the ServiceHub launch target following the installed-product-first resolver order:
/// 1. SERVICEHUB_EXE env → packaged executable
/// 2. SERVICEHUB_DIR env → development source directory
/// 3. exe-sibling `servicehub/superclaw-services.exe` (production layout)
/// 4. Search upward from cwd for host/servicehub
/// 5. Search upward from current_exe() for host/servicehub
fn resolve_servicehub_launch_target(port: u16) -> Result<ServiceHubLaunchTarget, String> {
    // 1. Explicit executable override
    if let Ok(exe) = std::env::var("SERVICEHUB_EXE") {
        let exe_path = PathBuf::from(&exe);
        if !exe_path.is_file() {
            return Err(format!(
                "SERVICEHUB_EXE={exe} does not exist or is not a file"
            ));
        }
        let cwd = exe_path
            .parent()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| format!("{exe} has no parent directory"))?;
        return Ok(exe_servicehub_target(
            exe_path,
            cwd,
            "SERVICEHUB_EXE override".to_string(),
            port,
        ));
    }

    // 2. Explicit development directory override
    if let Ok(dir) = std::env::var("SERVICEHUB_DIR") {
        let dir_path = PathBuf::from(&dir);
        if dir_path.is_dir() {
            return Ok(python_servicehub_target(
                dir_path,
                "SERVICEHUB_DIR development directory".to_string(),
                port,
            ));
        }
        return Err(format!(
            "SERVICEHUB_DIR={dir} does not exist or is not a directory"
        ));
    }

    // 3. Production layout: exe-sibling servicehub/superclaw-services.exe. This must
    // win before repo discovery so build\Release\SuperClaw.exe launched from
    // inside the repo still uses its bundled ServiceHub payload.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(target) = installed_sibling_servicehub_target_from_exe(&exe, port) {
            return Ok(target);
        }
    }

    // 4. Search upward from cwd
    if let Ok(current_dir) = std::env::current_dir() {
        if let Some(servicehub_dir) = find_repo_servicehub_dir_from(current_dir) {
            return Ok(python_servicehub_target(
                servicehub_dir,
                "repo layout from current working directory".to_string(),
                port,
            ));
        }
    }

    // 5. Search upward from current_exe()
    if let Some(servicehub_dir) = resolve_repo_servicehub_dir_from_exe() {
        return Ok(python_servicehub_target(
            servicehub_dir,
            "repo layout from current executable".to_string(),
            port,
        ));
    }

    Err(
        "Cannot find ServiceHub executable or development directory. \
         Set SERVICEHUB_EXE or SERVICEHUB_DIR."
            .into(),
    )
}

// ── Handshake parsing ──────────────────────────────────────────────────────

/// Parse a ServiceHub handshake line into `(port, token, is_reuse)`.
///
/// `is_reuse` is `true` when the line is a `REUSE {...}` handoff (a prior
/// kept-alive Hub is still holding the singleton mutex) rather than a fresh
/// `SERVICEHUB_READY {...}`. The boot sequence uses this to validate the reused
/// instance is actually responsive and self-heal a half-dead kept-alive Hub.
fn parse_servicehub_ready(line: &str) -> Option<(u16, String, bool, Option<u32>)> {
    let trimmed = line.trim();
    let (json_str, is_reuse) = if let Some(rest) = trimmed.strip_prefix(SERVICEHUB_HANDSHAKE_PREFIX)
    {
        (rest, false)
    } else if let Some(rest) = trimmed.strip_prefix(SERVICEHUB_REUSE_PREFIX) {
        (rest, true)
    } else {
        return None;
    };
    let value: serde_json::Value = serde_json::from_str(json_str).ok()?;
    let port = u16::try_from(value.get("port")?.as_u64()?).ok()?;
    if port == 0 {
        return None;
    }
    let token = value.get("token")?.as_str()?.to_string();
    let pid = value
        .get("pid")
        .and_then(serde_json::Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 0);
    if is_reuse && pid.is_none() {
        return None;
    }
    Some((port, token, is_reuse, pid))
}

fn servicehub_lockfile_identity_matches(
    value: &serde_json::Value,
    port: u16,
    token: &str,
    pid: u32,
) -> bool {
    value.get("port").and_then(serde_json::Value::as_u64) == Some(u64::from(port))
        && value.get("token").and_then(serde_json::Value::as_str) == Some(token)
        && value.get("pid").and_then(serde_json::Value::as_u64) == Some(u64::from(pid))
}

fn reuse_lockfile_matches_identity(port: u16, token: &str, pid: u32) -> bool {
    let Some(lock_path) = resolve_servicehub_lockfile_data_dir()
        .map(|dir| dir.join(SERVICEHUB_LOCKFILE))
    else {
        return false;
    };
    let Ok(contents) = std::fs::read_to_string(lock_path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return false;
    };
    servicehub_lockfile_identity_matches(&value, port, token, pid)
}

fn reuse_handoff_identity_status(port: u16, token: &str, pid: u32) -> TcpListenerStatus {
    reuse_handoff_identity_status_with_checks(
        reuse_lockfile_matches_identity(port, token, pid),
        || identity_lockfile_pid_process_is_running(pid),
        || servicehub_reuse_process_is_ours(pid),
        || tcp_listener_status(port, pid),
    )
}

fn reuse_handoff_identity_status_with_checks(
    lockfile_matches_identity: bool,
    pid_process_is_running: impl FnOnce() -> bool,
    servicehub_process_is_ours: impl FnOnce() -> bool,
    listener_status: impl FnOnce() -> TcpListenerStatus,
) -> TcpListenerStatus {
    if !lockfile_matches_identity || !pid_process_is_running() || !servicehub_process_is_ours() {
        return TcpListenerStatus::Unavailable;
    }
    listener_status()
}

fn accept_reuse_after_identity_recheck(
    recheck_identity: impl FnOnce() -> TcpListenerStatus,
    is_cancelled: impl FnOnce() -> bool,
    reject: impl FnOnce(&'static str, &'static str),
) -> bool {
    let identity_status = recheck_identity();
    if is_cancelled() {
        return false;
    }
    if identity_status == TcpListenerStatus::Owned {
        true
    } else {
        reject(
            "reuse.identity.rejected",
            "ServiceHub reuse identity changed during the authenticated readiness probe",
        );
        false
    }
}

fn parse_reuse_error(raw: &str) -> Option<String> {
    raw.lines().rev().find_map(|line| {
        let json = line.trim().strip_prefix(SERVICEHUB_REUSE_PREFIX)?;
        let value: serde_json::Value = serde_json::from_str(json).ok()?;
        value
            .get("error")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|error| !error.is_empty())
            .map(str::to_string)
    })
}

fn sanitize_servicehub_startup_detail(raw: &str) -> Option<String> {
    const MAX_DETAIL_LINES: usize = 4;
    const MAX_DETAIL_CHARS: usize = 600;

    let mut safe_lines = raw
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            let lower = trimmed.to_ascii_lowercase();
            let contains_secret = lower.contains("\"token\"")
                || lower.contains("authorization:")
                || lower.contains("bearer ")
                || lower.contains("--hub-token");
            let is_protocol = trimmed.starts_with(SERVICEHUB_HANDSHAKE_PREFIX)
                || trimmed.starts_with(SERVICEHUB_REUSE_PREFIX);
            if contains_secret || is_protocol {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .collect::<Vec<_>>();
    if safe_lines.is_empty() {
        return None;
    }
    if safe_lines.len() > MAX_DETAIL_LINES {
        safe_lines.drain(..safe_lines.len() - MAX_DETAIL_LINES);
    }
    Some(truncate_output(&safe_lines.join(" | "), MAX_DETAIL_CHARS))
}

fn compose_handshake_failed_message(state: &ServiceHubState) -> String {
    let base = "ServiceHub process exited before sending handshake";
    let reuse_error = state
        .last_stdout
        .as_deref()
        .and_then(parse_reuse_error)
        .and_then(|error| sanitize_servicehub_startup_detail(&error));
    let detail = reuse_error
        .or_else(|| {
            state
                .last_stdout
                .as_deref()
                .and_then(sanitize_servicehub_startup_detail)
        })
        .or_else(|| {
            state
                .last_stderr
                .as_deref()
                .and_then(sanitize_servicehub_startup_detail)
        });
    match detail {
        Some(detail) => format!("{base}\nDetail: {detail}"),
        None => base.to_string(),
    }
}

fn append_servicehub_exit_status(existing: Option<String>, code: Option<i32>) -> String {
    let exit_status = match code {
        Some(code) => format!("ServiceHub exited (code {code})."),
        None => "ServiceHub exited.".to_string(),
    };
    let combined = match existing {
        Some(existing) if !existing.trim().is_empty() => format!("{existing}\n{exit_status}"),
        _ => exit_status,
    };
    truncate_output(&combined, 8000)
}

/// Value-level credential redaction for a single log line before it is
/// persisted to `tauri.log`.
///
/// Startup-logging unification (2026-07-21 design §4.1): `safe_servicehub_stdout_line`
/// only recognized the *protocol handshake* forms, so a credential riding on an
/// ordinary child stderr line (e.g. a Python traceback echoing an outgoing
/// request header or a spawn command line) would land on disk verbatim. This
/// redacts the credential **value** in the three concrete forms the stack can
/// emit, deliberately keeping the rest of the line intact for debugging rather
/// than dropping the whole line or matching a broad `token=` that would maul
/// unrelated business content:
///
/// * `Authorization: Bearer <secret>` / `Authorization: <secret>` (HTTP header)
/// * `Bearer <secret>` (a bare bearer token elsewhere on the line)
/// * `--hub-token <secret>` / `--hub-token=<secret>` (spawn CLI flag)
///
/// Matching is case-insensitive on the key; only the value is replaced with
/// `[redacted]`, so `Authorization: Bearer abc123` becomes
/// `Authorization: [redacted]`. Idempotent — an already-redacted line is a
/// no-op.
fn redact_credentials_in_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    // Fast path: no credential marker present, return the borrow-free original.
    if !lower.contains("authorization:")
        && !lower.contains("bearer ")
        && !lower.contains("--hub-token")
    {
        return line.to_string();
    }

    let mut out = String::with_capacity(line.len());
    // Walk char-boundary-safe by bytes, matching known credential prefixes and
    // then swallowing the following value token(s) up to end-of-line.
    let bytes = line.as_bytes();
    let lower_bytes = lower.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let rest = &lower_bytes[i..];
        // `Authorization:` header — redact everything after the colon on this
        // line (the whole header value, incl. an inner `Bearer`).
        if rest.starts_with(b"authorization:") {
            out.push_str(&line[i..i + "authorization:".len()]);
            out.push_str(" [redacted]");
            // Consume to end of line (or the line's newline terminator).
            let mut j = i + "authorization:".len();
            while j < bytes.len() && bytes[j] != b'\n' && bytes[j] != b'\r' {
                j += 1;
            }
            i = j;
            continue;
        }
        // `--hub-token <value>` or `--hub-token=<value>`.
        if rest.starts_with(b"--hub-token") {
            out.push_str(&line[i..i + "--hub-token".len()]);
            let mut j = i + "--hub-token".len();
            // Skip an optional `=` or run of spaces, then the value token.
            if j < bytes.len() && (bytes[j] == b'=' || bytes[j] == b' ') {
                let sep = bytes[j] as char;
                out.push(sep);
                j += 1;
                while j < bytes.len() && bytes[j] == b' ' {
                    out.push(' ');
                    j += 1;
                }
                // Swallow the value up to the next whitespace / line end.
                while j < bytes.len()
                    && bytes[j] != b' '
                    && bytes[j] != b'\n'
                    && bytes[j] != b'\r'
                {
                    j += 1;
                }
                out.push_str("[redacted]");
            }
            i = j;
            continue;
        }
        // Bare `Bearer <value>` not preceded by an `Authorization:` (handled above).
        if rest.starts_with(b"bearer ") {
            out.push_str(&line[i..i + "bearer ".len()]);
            let mut j = i + "bearer ".len();
            while j < bytes.len() && bytes[j] == b' ' {
                out.push(' ');
                j += 1;
            }
            // Swallow the token up to the next whitespace / line end.
            while j < bytes.len() && bytes[j] != b' ' && bytes[j] != b'\n' && bytes[j] != b'\r'
            {
                j += 1;
            }
            out.push_str("[redacted]");
            i = j;
            continue;
        }
        // Copy this byte through, staying on a char boundary.
        let ch_len = utf8_char_len(bytes[i]);
        out.push_str(&line[i..i + ch_len]);
        i += ch_len;
    }
    out
}

/// Byte length of the UTF-8 char starting at a lead byte, clamped to 1 for any
/// invalid lead byte so the walker always makes progress on a char boundary.
fn utf8_char_len(lead: u8) -> usize {
    match lead {
        b if b < 0x80 => 1,
        b if b >= 0xF0 => 4,
        b if b >= 0xE0 => 3,
        b if b >= 0xC0 => 2,
        _ => 1,
    }
}

fn safe_servicehub_stdout_line(line: &str) -> String {
    let newline = if line.ends_with('\n') { "\n" } else { "" };
    if let Some((_port, _token, is_reuse, _pid)) = parse_servicehub_ready(line) {
        let prefix = if is_reuse {
            "REUSE"
        } else {
            "SERVICEHUB_READY"
        };
        return format!("{prefix} [redacted]{newline}");
    }
    if let Some(error) = parse_reuse_error(line) {
        let safe_error = sanitize_servicehub_startup_detail(&error)
            .unwrap_or_else(|| "ServiceHub reuse failed".to_string());
        return format!("ServiceHub reuse error: {safe_error}{newline}");
    }
    let trimmed = line.trim_start();
    if trimmed.starts_with(SERVICEHUB_HANDSHAKE_PREFIX)
        || trimmed.starts_with(SERVICEHUB_REUSE_PREFIX)
    {
        return format!("ServiceHub protocol output [redacted]{newline}");
    }
    // Fall-through: an ordinary child line. Redact any credential *value* riding
    // on it (Authorization / Bearer / --hub-token) before it reaches disk, while
    // keeping the rest of the line for debugging.
    redact_credentials_in_line(line)
}

// ── Child-service health parsing (reuse validation) ─────────────────────────

/// Verdict for a reused ServiceHub's child-service health, derived purely from a
/// `GET /app/readiness` response body. Kept side-effect-free so the reuse
/// decision is unit-testable without HTTP or a live Hub. Classification lives in
/// [`readiness`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildHealthVerdict {
    /// Every child reports healthy — safe to attach to the reused Hub as-is.
    AllHealthy,
    /// At least one child is unhealthy — the reused Hub is alive but its
    /// children/data-plane are stale; try a Hub-internal restart before the
    /// heavier kill + cold-restart self-heal.
    SomeUnhealthy,
    /// The response could not be interpreted (missing/!object/no services list).
    /// Treated conservatively as "cannot confirm healthy" by the caller.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ChildHealthTarget {
    name: String,
    proxy_prefix: String,
    instance_id: String,
}

fn direct_child_health_matches(target: &ChildHealthTarget, payload: &serde_json::Value) -> bool {
    if payload.get("status").and_then(serde_json::Value::as_str) != Some("ok") {
        return false;
    }
    if payload.get("service").and_then(serde_json::Value::as_str) != Some(target.name.as_str()) {
        return false;
    }
    if payload
        .get("instance_id")
        .and_then(serde_json::Value::as_str)
        != Some(target.instance_id.as_str())
    {
        return false;
    }
    true
}

/// Decide whether a sandbox `phase` warrants an ACTIVE provision request during
/// the data-plane wait, versus just continuing to poll.
///
/// Why this exists: `sandbox_manager` auto-runs `ensure_ready()` only once, at
/// its *process* startup. On a fresh app launch that brings the sandbox up.
/// But on a REUSE launch the sandbox_manager process is the *old* one — its
/// startup auto-ensure ran long ago — so if the sandbox was stopped meanwhile,
/// nothing re-triggers bring-up and a passive poll for
/// `phase == "running"` just times out. When the phase is one that will NOT
/// recover on its own we must actively POST the (idempotent) provisions endpoint.
///
/// Phases (from `GET /sandbox-manager/v1/agent/sandbox`):
/// - `stopped` / `error` / `missing` → terminal-ish, needs a kick → `true`.
/// - `running` → already up (caller stops polling anyway) → `false`.
/// - `starting` / `installing` → a provision/ensure is already in flight; kicking
///   again is wasteful and could interleave operations → `false`.
/// - anything unknown/empty → conservative `false` (don't hammer provisions on a
///   phase we don't understand; the poll timeout still bounds the wait).
fn should_provision_sandbox(phase: &str) -> bool {
    matches!(phase, "stopped" | "error" | "missing")
}

#[derive(Debug, PartialEq, Eq)]
enum SandboxProvisionOutcome {
    Accepted,
    CapabilityProfileRequired,
    Rejected,
}

fn is_capability_profile_required(payload: &serde_json::Value) -> bool {
    payload
        .get("error")
        .and_then(|error| error.get("code"))
        .and_then(serde_json::Value::as_str)
        == Some("capability_profile_required")
}

fn hub_operation_id(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("operation_id")
        .and_then(serde_json::Value::as_str)
        .filter(|operation_id| !operation_id.is_empty())
        .map(str::to_string)
}

fn should_self_heal_after_child_probe(
    child_restart_attempted: bool,
    child_verdict: ChildHealthVerdict,
) -> bool {
    child_verdict == ChildHealthVerdict::SomeUnhealthy
        || (child_restart_attempted && child_verdict != ChildHealthVerdict::AllHealthy)
}

fn should_restart_children_on_reuse(child_verdict: ChildHealthVerdict) -> bool {
    matches!(
        child_verdict,
        ChildHealthVerdict::SomeUnhealthy | ChildHealthVerdict::Unknown
    )
}

// ── Event helpers ──────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceHubProgressPayload {
    stage: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, pct: Option<f64>) {
    tracing::info!(
        boot_id = %crate::logging::boot_id(),
        component = "servicehub",
        stage,
        "{}",
        message
    );
    if let Some(bs) = app.try_state::<ServiceHubBootState>() {
        bs.update_progress(stage, message, pct, None);
    }
    let payload = ServiceHubProgressPayload {
        stage: stage.to_string(),
        message: message.to_string(),
        pct,
        error: None,
    };
    let _ = app.emit(SERVICEHUB_PROGRESS_EVENT, payload);
}

fn is_startup_failure_stage(stage: &str) -> bool {
    !stage.starts_with("telemetry.")
}

fn emit_error(app: &AppHandle, stage: &str, error: &str) {
    tracing::error!(
        boot_id = %crate::logging::boot_id(),
        component = "servicehub",
        stage,
        "{}",
        error
    );
    if let Some(bs) = app.try_state::<ServiceHubBootState>() {
        bs.mark_error(stage, error);
    }
    let payload = ServiceHubProgressPayload {
        stage: stage.to_string(),
        message: error.to_string(),
        pct: None,
        error: Some(error.to_string()),
    };
    let _ = app.emit(SERVICEHUB_PROGRESS_EVENT, payload);
    let _ = app.emit(SERVICEHUB_ERROR_EVENT, error.to_string());
    if is_startup_failure_stage(stage) {
        crate::telemetry::emit_startup_phase(
            app.clone(),
            "failed",
            "unknown",
            Some(error.to_string()),
        );
    }
}

// ── Boot sequence ──────────────────────────────────────────────────────────

// ── Stale kept-alive Hub recovery ──────────────────────────────────────────

/// Base directory for ServiceHub state before the `SuperClaw/servicehub` suffix.
///
/// Mirrors Python `config._default_data_dir`: `LOCALAPPDATA` when set, otherwise
/// `Path.home() / ".local" / "share"`.
fn servicehub_default_data_base() -> Option<PathBuf> {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let trimmed = local.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    let home = std::env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("USERPROFILE")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })?;
    Some(PathBuf::from(home).join(".local").join("share"))
}

/// Resolve the ServiceHub data directory that holds `servicehub.lock`.
///
/// Mirrors the Python `config._default_data_dir`:
/// `SERVICEHUB_DATA_DIR` override → `{base}/SuperClaw/servicehub` where `base` is
/// `LOCALAPPDATA` or `~/.local/share`.
fn resolve_servicehub_lockfile_data_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("SERVICEHUB_DATA_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.is_absolute() {
                return Some(path);
            }
            let target = resolve_servicehub_launch_target(0).ok()?;
            return Some(target.cwd.join(path));
        }
    }
    servicehub_default_data_base().map(|base| base.join("SuperClaw").join("servicehub"))
}

/// Read the pid from `servicehub.lock` if present.
fn read_servicehub_lockfile_pid() -> Option<u32> {
    let dir = resolve_servicehub_lockfile_data_dir()?;
    let lock_path = dir.join(SERVICEHUB_LOCKFILE);
    let content = std::fs::read_to_string(&lock_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    value.get("pid")?.as_u64().map(|v| v as u32)
}

/// Force-kill a stale ServiceHub PID (and its child-service tree) so the next
/// spawn acquires the singleton mutex cleanly. `kill_process_tree` is
/// platform-aware (taskkill /F /T on Windows, SIGKILL of the process group
/// elsewhere) but only logs when the kill command fails.
///
/// The kill is gated on the shared REUSE identity validator to avoid killing an unrelated
/// process that inherited a recycled PID. Returns `true` only when the PID was
/// verified as ours and is no longer running after the kill attempt (with a
/// short poll — do not treat “kill command ran” as success).
fn force_kill_stale_servicehub(pid: u32) -> bool {
    if !identity::servicehub_reuse_process_is_ours(pid) {
        eprintln!(
            "[servicehub] stale lockfile pid={pid} is not a ServiceHub process (or unverifiable) — skipping kill"
        );
        return false;
    }
    eprintln!("[servicehub] killing stale ServiceHub pid={pid}");
    crate::utils::kill_process_tree(pid);

    const KILL_SETTLE_POLL: Duration = Duration::from_millis(50);
    const KILL_VERIFY_TIMEOUT: Duration = Duration::from_secs(2);
    let deadline = Instant::now() + KILL_VERIFY_TIMEOUT;
    while Instant::now() < deadline {
        if !identity::lockfile_pid_process_is_running(pid) {
            return true;
        }
        thread::sleep(KILL_SETTLE_POLL);
    }

    if identity::lockfile_pid_process_is_running(pid) {
        eprintln!(
            "[servicehub] stale ServiceHub pid={pid} still running after kill attempt"
        );
        return false;
    }
    true
}

/// Delete `servicehub.lock` so the next spawn is not misled by stale handoff
/// data. Best-effort; a missing file is not an error.
fn delete_servicehub_lockfile() {
    if let Some(dir) = resolve_servicehub_lockfile_data_dir() {
        let lock_path = dir.join(SERVICEHUB_LOCKFILE);
        match std::fs::remove_file(&lock_path) {
            Ok(_) => eprintln!("[servicehub] removed stale {}", lock_path.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => eprintln!("[servicehub] failed to remove {}: {e}", lock_path.display()),
        }
    }
}

/// Outcome of the "should we delete the lockfile?" decision during stale-REUSE
/// self-heal. Extracted as a pure decision so the fix for the lockfile-deletion
/// race (only delete when we actually killed the old Hub) is unit-testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LockfileAction {
    /// We force-killed the stale Hub PID — the lockfile is now orphaned and MUST
    /// be removed so the fresh spawn writes its own.
    Delete,
    /// We could NOT kill (no PID, or the PID was unverifiable / not ours). The
    /// old Hub may still be alive and holding the singleton mutex; deleting the
    /// lockfile here would strand the next spawn (it hits REUSE again but finds
    /// no metadata → "lockfile missing" error). So we KEEP the lockfile.
    Keep,
}

/// Decide whether to delete `servicehub.lock` after a stale-REUSE kill attempt.
///
/// `killed` is the result of [`force_kill_stale_servicehub`] (false when there
/// was no PID, the PID could not be verified as ours, or it is still running).
fn lockfile_action_after_kill(killed: bool) -> LockfileAction {
    if killed {
        LockfileAction::Delete
    } else {
        LockfileAction::Keep
    }
}

/// Kill a stale/half-dead kept-alive Hub and cold-restart a fresh one.
///
/// Shared by the two stale-REUSE triggers in [`run_boot_sequence`]:
/// 1. the reused Hub shell fails its `/health` probe, or
/// 2. the reused Hub is up but its child services stay unhealthy even after an
///    in-Hub `POST /app/system/restart`.
///
/// Returns `true` when a cold restart was triggered (caller should stop its own
/// boot thread) and `false` when the restart budget is exhausted (caller has
/// already surfaced the give-up error is NOT this fn's job — see below). The
/// give-up error is emitted here so both call sites behave identically.
///
/// Implements the lockfile-deletion-race fix: the lockfile is removed only when
/// the stale PID was actually killed ([`lockfile_action_after_kill`]).
fn stale_reuse_self_heal(
    app_handle: &AppHandle,
    port: u16,
    expected_identity: Option<(u16, String, u32)>,
    reason: &str,
) -> bool {
    let Some((expected_port, expected_token, expected_pid)) = expected_identity else {
        emit_error(
            app_handle,
            "reuse.identity.rejected",
            "ServiceHub recovery did not have the expected handoff identity",
        );
        return false;
    };
    if expected_port != port
        || !reuse_lockfile_matches_identity(expected_port, &expected_token, expected_pid)
    {
        emit_error(
            app_handle,
            "reuse.identity.changed",
            "ServiceHub lockfile identity changed before stale-instance recovery",
        );
        return false;
    }

    // Bound the recovery: a persistently broken lockfile/mutex must not loop
    // restarts forever.
    if !stale_reuse_restart_allowed() {
        emit_error(
            app_handle,
            "reuse.stale.giveup",
            &format!(
                "ServiceHub kept-alive instance on port {port} stayed unhealthy after \
                 {MAX_STALE_REUSE_RESTARTS} restart attempts ({reason}). Stop leftover \
                 ServiceHub processes (or reboot) and relaunch."
            ),
        );
        return false;
    }

    eprintln!("[servicehub] STALE REUSE on port {port} ({reason}) — killing and restarting");
    emit_progress(
        app_handle,
        "reuse.stale.recovering",
        "Reused ServiceHub instance is unhealthy — restarting…",
        Some(0.05),
    );

    if !reuse_lockfile_matches_identity(expected_port, &expected_token, expected_pid) {
        emit_error(
            app_handle,
            "reuse.identity.changed",
            "ServiceHub lockfile identity changed before stale-instance recovery",
        );
        return false;
    }
    let killed = force_kill_stale_servicehub(expected_pid);

    match lockfile_action_after_kill(killed) {
        LockfileAction::Delete => delete_servicehub_lockfile(),
        LockfileAction::Keep => eprintln!(
            "[servicehub] stale Hub not killed — KEEPING servicehub.lock to avoid REUSE race"
        ),
    }

    thread::sleep(Duration::from_millis(800));

    let manager = app_handle.state::<ServiceHubManager>();
    match start_servicehub(app_handle, &manager) {
        Ok(_) => eprintln!("[servicehub] restart after stale REUSE: spawn ok"),
        Err(e) => emit_error(
            app_handle,
            "reuse.stale.restart_failed",
            &format!("Failed to restart after stale REUSE: {e}"),
        ),
    }
    true
}

fn missing_lockfile_reuse_detected(state: &ServiceHubState) -> bool {
    state.last_stdout.as_deref().is_some_and(|stdout| {
        let lower = stdout.to_ascii_lowercase();
        lower.contains("servicehub reuse error:") && lower.contains("lockfile is missing")
    })
}

fn missing_lockfile_reuse_self_heal(app_handle: &AppHandle) -> bool {
    if !stale_reuse_restart_allowed() {
        emit_error(
            app_handle,
            "reuse.missing_lockfile.giveup",
            &format!(
                "A running ServiceHub has no lockfile after \
                 {MAX_STALE_REUSE_RESTARTS} recovery attempts. Stop leftover \
                 ServiceHub processes (or reboot) and relaunch."
            ),
        );
        return true;
    }

    let pids = identity::servicehub_pids_without_lockfile();
    if pids.is_empty() {
        return false;
    }
    emit_progress(
        app_handle,
        "reuse.missing_lockfile.recovering",
        "Found a stale ServiceHub without connection metadata — restarting…",
        Some(0.05),
    );
    let killed = pids
        .into_iter()
        .filter(|pid| force_kill_stale_servicehub(*pid))
        .count();
    if killed == 0 {
        return false;
    }

    thread::sleep(Duration::from_millis(800));
    let manager = app_handle.state::<ServiceHubManager>();
    match start_servicehub(app_handle, &manager) {
        Ok(_) => eprintln!("[servicehub] restart after missing-lockfile REUSE: spawn ok"),
        Err(error) => emit_error(
            app_handle,
            "reuse.missing_lockfile.restart_failed",
            &format!("Failed to restart after missing-lockfile REUSE: {error}"),
        ),
    }
    true
}

fn run_boot_sequence(
    app_handle: AppHandle,
    boot_state: Arc<Mutex<ServiceHubState>>,
    handshake_rx: std::sync::mpsc::Receiver<(u16, String, bool, Option<u32>)>,
    cancel: Arc<AtomicBool>,
) {
    tracing::info!(
        boot_id = %crate::logging::boot_id(),
        component = "servicehub",
        stage = "boot.start",
        "waiting for handshake"
    );

    // 1. Wait for SERVICEHUB_READY (or REUSE) handshake from stdout
    let (port, token, is_reuse, reuse_pid) = {
        let deadline = Instant::now() + Duration::from_secs(HANDSHAKE_TIMEOUT_SECS);
        loop {
            if cancel.load(Ordering::SeqCst) {
                eprintln!("[servicehub] boot sequence cancelled (handshake wait)");
                return;
            }
            match handshake_rx.recv_timeout(Duration::from_secs(2)) {
                Ok(hs) => break hs,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if Instant::now() >= deadline {
                        emit_error(
                            &app_handle,
                            "handshake.timeout",
                            "Timeout waiting for ServiceHub handshake",
                        );
                        return;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    // Let the event consumer persist the final stderr/exit event
                    // before composing the user-facing startup failure.
                    thread::sleep(Duration::from_millis(50));
                    let (message, missing_lockfile) = boot_state
                        .lock()
                        .map(|state| {
                            (
                                compose_handshake_failed_message(&state),
                                missing_lockfile_reuse_detected(&state),
                            )
                        })
                        .unwrap_or_else(|_| {
                            (
                                "ServiceHub process exited before sending handshake".to_string(),
                                false,
                            )
                        });
                    if missing_lockfile && missing_lockfile_reuse_self_heal(&app_handle) {
                        return;
                    }
                    emit_error(&app_handle, "handshake.failed", &message);
                    return;
                }
            }
        }
    };

    let hub_url = format!("http://127.0.0.1:{port}");
    if is_reuse {
        let Some(pid) = reuse_pid else {
            emit_error(
                &app_handle,
                "reuse.identity.rejected",
                "ServiceHub reuse handshake omitted the primary PID",
            );
            return;
        };
        if !reuse_listener_preflight(&app_handle, port, &token, pid, &hub_url, &cancel) {
            return;
        }
    }

    // Startup-logging unification (2026-07-21 §3.1): on a REUSE launch we attach
    // to a long-lived Hub whose loguru still carries its *original* boot_id — the
    // new launch boot_id never appears in servicehub.log. Record a correlation
    // line so a reader can bridge from this launch's boot_id to the reused Hub.
    if is_reuse {
        tracing::info!(
            boot_id = %crate::logging::boot_id(),
            component = "servicehub",
            stage = "reuse.attach",
            port,
            "attached to existing servicehub (its boot_id predates this launch); \
             this launch boot_id correlates via port"
        );
    }

    // 1a. If this was a REUSE handshake, a prior kept-alive Hub is still holding
    //     the singleton mutex. Before we attach we validate TWO layers:
    //       (i)  the Hub *shell* answers `/health` — guards a half-dead Hub
    //            (mutex held, uvicorn hung/crashed mid-boot); and
    //       (ii) the Hub's *child services* (sandbox_manager, llmrouter_manager,
    //            …) are healthy — guards a stale data-plane (e.g. the sandbox
    //            was stopped while kept alive) that would pass `/health`
    //            yet fail real work. For (ii) we first try the cheap in-Hub
    //            `POST /app/system/restart`; only if children stay unhealthy do
    //            we fall through to the heavy kill + cold-restart self-heal.
    if cancel.load(Ordering::SeqCst) {
        eprintln!("[servicehub] boot sequence cancelled (pre-reuse-probe)");
        return;
    }
    let activation_active = if is_reuse {
        // (i) Hub shell responsive?
        if !verify_servicehub_health(&hub_url, &token, &cancel) {
            if cancel.load(Ordering::SeqCst) {
                eprintln!("[servicehub] boot sequence cancelled (reuse-probe)");
                return;
            }
            stale_reuse_self_heal(
                &app_handle,
                port,
                reuse_pid.map(|pid| (port, token.clone(), pid)),
                "hub /health unresponsive",
            );
            // Either a cold restart was triggered (its own boot thread takes
            // over) or the budget was exhausted (error already surfaced). Either
            // way this boot thread is done.
            return;
        }

        // An active Model Binding Activation owns convergence. Discover it
        // before generic child restart/provision so REUSE does not interfere.
        match request_active_model_binding_activation(&hub_url, &token) {
            Ok(active) => {
                if active {
                    eprintln!("[servicehub] reuse found an active Model Binding Activation");
                }
                active
            }
            Err(message) => {
                emit_error(&app_handle, "reuse.activation_discovery.failed", &message);
                return;
            }
        }
    } else {
        false
    };

    if is_reuse && !activation_active {
        // (ii) Child services healthy?
        if cancel.load(Ordering::SeqCst) {
            eprintln!("[servicehub] boot sequence cancelled (reuse-child-probe)");
            return;
        }
        let mut child_verdict = fetch_child_health(&hub_url, &token, &cancel);
        let mut child_restart_attempted = false;
        if should_restart_children_on_reuse(child_verdict) {
            eprintln!(
                "[servicehub] reused Hub children not confirmed healthy ({child_verdict:?}) — requesting in-Hub restart"
            );
            emit_progress(
                &app_handle,
                "reuse.children.restarting",
                "Reused ServiceHub children are stale — restarting them…",
                Some(0.1),
            );
            if let Some(operation_id) = request_hub_restart(&hub_url, &token) {
                child_restart_attempted = true;
                if wait_for_hub_operation(&hub_url, &token, &operation_id, &cancel) {
                    child_verdict = wait_for_child_health_after_restart(&hub_url, &token, &cancel);
                }
            }
        }

        // Attach when children are healthy. `Unknown` (probe/parse failure) is
        // treated as non-blocking: the Hub shell already passed `/health`, and
        // the downstream data-plane wait (step 5) plus the UI's own lazy-fetch
        // will surface any real problem without us needlessly killing a Hub we
        // could not fully assess.
        if should_self_heal_after_child_probe(child_restart_attempted, child_verdict) {
            if cancel.load(Ordering::SeqCst) {
                eprintln!("[servicehub] boot sequence cancelled (post-child-restart)");
                return;
            }
            stale_reuse_self_heal(
                &app_handle,
                port,
                reuse_pid.map(|pid| (port, token.clone(), pid)),
                "child services did not return healthy after in-Hub restart",
            );
            return;
        }
    }

    // 2. Store handshake info in state
    if let Ok(mut st) = boot_state.lock() {
        st.hub_port = Some(port);
        st.hub_token = Some(token.clone());
    }

    emit_progress(
        &app_handle,
        "handshake.complete",
        &format!("ServiceHub ready on port {port}"),
        Some(0.5),
    );

    // 3. Verify the ServiceHub health endpoint is reachable
    if cancel.load(Ordering::SeqCst) {
        eprintln!("[servicehub] boot sequence cancelled (pre-health-check)");
        return;
    }

    let health_ok = verify_servicehub_health(&hub_url, &token, &cancel);
    if cancel.load(Ordering::SeqCst) {
        eprintln!("[servicehub] boot sequence cancelled (health check)");
        return;
    }
    if !health_ok {
        emit_error(
            &app_handle,
            "health.failed",
            "ServiceHub health endpoint is not reachable after handshake",
        );
        return;
    }

    cache_bundle_id_from_servicehub(&app_handle, &hub_url, &token);
    cache_product_version_from_servicehub(&app_handle, &hub_url, &token);

    // 4. Print the ServiceHub child-service health summary for terminal smoke checks.
    log_servicehub_child_health(&hub_url, &token);

    // 5. Wait for the sandbox data-plane (container ready + OWT token).
    //    This blocks the boot overlay so the UI never sees a broken "unreachable"
    //    state.  Falls back to None (UI lazy-fetch) on timeout so startup is
    //    never permanently stuck.
    //
    //    Capability-gating exception: when `CAPABILITY_GATING_V1` is on, the
    //    Sandbox is ServiceHub-managed and is NOT provisioned at boot — it is
    //    brought up by the capability switch saga once a Profile is committed.
    //    The public provisions endpoint returns 409 `capability_profile_required`
    //    in that mode, so boot must NOT wait on / provision the data-plane here;
    //    doing so deadlocks startup at `sandbox phase=error`. Skip straight to
    //    ready and let the capability startup flow drive the Sandbox.
    //
    //    This is v1.2 product behavior, gated on `CAPABILITY_GATING_V1`. The
    //    desktop process seeds the flag before spawning ServiceHub in every
    //    build profile, so Debug and Release share this managed startup path.
    let capability_gating_on = std::env::var("CAPABILITY_GATING_V1")
        .map(|v| matches!(v.trim(), "1" | "true" | "TRUE" | "True"))
        .unwrap_or(false);

    let (openwork_url, owt_token) = if capability_gating_on {
        if is_reuse && !activation_active {
            let _ = request_sandbox_provision(&hub_url, &token);
        }
        // Startup-logging unification follow-up (2026-07-22): this boot
        // timeline is about to report "ready" even though the
        // Sandbox container has NOT been checked at all — its readiness is
        // driven asynchronously by the Capability switch saga, not by this
        // function. Without this breadcrumb, a reader grepping this launch's
        // boot_id in tauri.log sees a clean, fully-successful boot and has no
        // signal that a real failure (e.g. sandbox_manager resource-missing,
        // sandbox provisioning errors) can still be sitting one layer
        // down in servicehub-*.log / sandbox_manager's own logs.
        //
        // This is a log-only breadcrumb: it must NOT emit a progress event,
        // which would add a frontend-visible boot stage that did not exist
        // before the logging work.
        tracing::info!(
            boot_id = %crate::logging::boot_id(),
            component = "servicehub",
            stage = "data-plane.deferred",
            "capability gating on — Sandbox/data-plane readiness is managed by \
             the Capability switch flow, NOT this boot timeline; check \
             servicehub-*.log and sandbox_manager logs for actual provisioning status"
        );
        (None, None)
    } else {
        emit_progress(
            &app_handle,
            "data-plane",
            "Waiting for sandbox container…",
            Some(0.6),
        );
        match wait_for_data_plane(&hub_url, &token, &cancel, activation_active) {
            Some((url, owt)) => {
                eprintln!("[servicehub] data-plane ready: openwork_url={url}");
                (Some(url), Some(owt))
            }
            None => {
                eprintln!("[servicehub] data-plane not ready within timeout; UI will lazy-fetch");
                (None, None)
            }
        }
    };
    let sandbox_ready = openwork_url.is_some() && owt_token.is_some();

    // 6. Emit the terminal "ready" event. Runtime/Sandbox readiness is
    // resolved separately by the capability flow and must not be implied here.
    emit_progress(&app_handle, "ready", "ServiceHub is ready", Some(1.0));

    let ready_payload = ServiceHubReadyPayload {
        hub_url: hub_url.clone(),
        hub_token: token,
        openwork_url,
        owt_token,
    };
    if let Some(bs) = app_handle.try_state::<ServiceHubBootState>() {
        bs.mark_ready(&ready_payload);
    }
    let _ = app_handle.emit(SERVICEHUB_READY_EVENT, ready_payload);
    crate::telemetry::emit_startup_phase(app_handle.clone(), "success", "unknown", None);
    if !capability_gating_on {
        crate::telemetry::emit_sandbox_ready(app_handle.clone(), sandbox_ready);
    }
    crate::telemetry::emit_app_ready(app_handle.clone());

    reset_stale_reuse_restart_budget();
    eprintln!("[servicehub] boot.complete: hub at {hub_url}");
}

/// Poll sandbox_manager through the ServiceHub proxy until the container
/// reports `phase: "running"` and an OWT token is available.
///
/// Returns `Some((openwork_url, owt_token))` on success, `None` on timeout or
/// cancellation.  The caller treats `None` as non-fatal — the UI falls back to
/// its own lazy-fetch loop.
fn wait_for_data_plane(
    hub_url: &str,
    hub_token: &str,
    cancel: &Arc<AtomicBool>,
    activation_active: bool,
) -> Option<(String, String)> {
    const SANDBOX_PORT: u16 = 8787;
    const POLL_INTERVAL: Duration = Duration::from_secs(3);
    // Budget covers an actively-provisioned cold bring-up: after the sandbox
    // stopped, the reuse path POSTs provisions, which restart the sandbox before
    // phase flips to `running`. 120s (the old passive-poll budget, which assumed
    // the sandbox was already starting) is too tight for that; 240s gives the
    // provision room while still bounding the boot overlay (timeout falls back
    // to UI lazy-fetch, never hangs forever).
    const TIMEOUT: Duration = Duration::from_secs(240);

    let deadline = Instant::now() + TIMEOUT;
    let auth = format!("Bearer {hub_token}");
    let sandbox_url = format!("{hub_url}/sandbox-manager/v1/agent/sandbox");
    let token_url = format!("{hub_url}/app/runtime/sandbox-token");

    // Phase 1: wait for sandbox phase == "running"
    eprintln!("[servicehub] data-plane: waiting for sandbox phase=running");
    // Kick provisioning at most once per wait: on a REUSE launch the container
    // may be stopped with nothing to restart it (sandbox_manager only auto-
    // provisions at its own startup). We actively POST provisions when we see a
    // non-recovering phase, then keep polling for phase=running.
    let mut provision_requested = false;
    loop {
        if cancel.load(Ordering::SeqCst) {
            eprintln!("[servicehub] data-plane: cancelled (phase wait)");
            return None;
        }
        if Instant::now() >= deadline {
            eprintln!("[servicehub] data-plane: timeout waiting for sandbox phase=running");
            return None;
        }

        match ureq::get(&sandbox_url)
            .timeout(Duration::from_secs(5))
            .set("Authorization", &auth)
            .call()
        {
            Ok(resp) if resp.status() == 200 => {
                if let Ok(body) = resp.into_json::<serde_json::Value>() {
                    let phase = body
                        .get("phase")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    if phase == "running" {
                        eprintln!("[servicehub] data-plane: sandbox phase=running");
                        break;
                    }
                    eprintln!("[servicehub] data-plane: sandbox phase={phase}, retrying…");
                    // If the container will not come up on its own, kick the
                    // idempotent provisions endpoint once and keep polling.
                    if !activation_active
                        && !provision_requested
                        && should_provision_sandbox(phase)
                    {
                        eprintln!(
                            "[servicehub] data-plane: sandbox phase={phase} won't self-recover — requesting provision"
                        );
                        provision_requested = true;
                        if request_sandbox_provision(hub_url, hub_token)
                            == SandboxProvisionOutcome::CapabilityProfileRequired
                        {
                            eprintln!(
                                "[servicehub] data-plane: sandbox requires a Capability Profile; deferring startup to the Capability flow"
                            );
                            return None;
                        }
                    }
                }
            }
            Ok(resp) => {
                eprintln!(
                    "[servicehub] data-plane: sandbox status HTTP {} (retrying)",
                    resp.status()
                );
            }
            Err(e) => {
                eprintln!("[servicehub] data-plane: sandbox status error: {e} (retrying)");
            }
        }

        thread::sleep(POLL_INTERVAL);
    }

    // Phase 2: fetch OWT token (sandbox is running, token should be available quickly)
    eprintln!("[servicehub] data-plane: fetching OWT token");
    for attempt in 1..=10 {
        if cancel.load(Ordering::SeqCst) {
            eprintln!("[servicehub] data-plane: cancelled (token fetch)");
            return None;
        }
        if Instant::now() >= deadline {
            eprintln!("[servicehub] data-plane: timeout waiting for OWT token");
            return None;
        }

        match ureq::get(&token_url)
            .timeout(Duration::from_secs(5))
            .set("Authorization", &auth)
            .call()
        {
            Ok(resp) if resp.status() == 200 => {
                if let Ok(body) = resp.into_json::<serde_json::Value>() {
                    if let Some(token) = body.get("token").and_then(serde_json::Value::as_str) {
                        if !token.is_empty() {
                            let openwork_url = format!("http://127.0.0.1:{SANDBOX_PORT}");
                            eprintln!(
                                "[servicehub] data-plane: OWT token acquired (attempt {attempt})"
                            );
                            return Some((openwork_url, token.to_string()));
                        }
                    }
                }
            }
            Ok(resp) => {
                eprintln!(
                    "[servicehub] data-plane: token fetch HTTP {} (attempt {attempt})",
                    resp.status()
                );
            }
            Err(e) => {
                eprintln!("[servicehub] data-plane: token fetch error: {e} (attempt {attempt})");
            }
        }

        thread::sleep(POLL_INTERVAL);
    }

    eprintln!("[servicehub] data-plane: OWT token not available after 10 attempts");
    None
}

fn log_servicehub_child_health(hub_url: &str, token: &str) {
    let url = format!("{hub_url}/app/services/health");
    let auth = format!("Bearer {token}");

    match ureq::get(&url)
        .timeout(Duration::from_secs(3))
        .set("Authorization", &auth)
        .call()
    {
        Ok(resp) if resp.status() == 200 => match resp.into_json::<serde_json::Value>() {
            Ok(payload) => print_child_health_summary(&payload),
            Err(err) => eprintln!(
                "[servicehub] child services status unavailable: invalid JSON from /app/services/health: {err}"
            ),
        },
        Ok(resp) => eprintln!(
            "[servicehub] child services status unavailable: HTTP {} from /app/services/health",
            resp.status()
        ),
        Err(err) => eprintln!(
            "[servicehub] child services status unavailable: {err}"
        ),
    }
}

fn print_child_health_summary(payload: &serde_json::Value) {
    let healthy = payload
        .get("healthy")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let Some(services) = payload
        .get("services")
        .and_then(serde_json::Value::as_array)
    else {
        eprintln!("[servicehub] child services status unavailable: missing services list");
        return;
    };

    eprintln!(
        "[servicehub] child services summary: healthy={} count={}",
        healthy,
        services.len()
    );
    for service in services {
        eprintln!("[servicehub]   {}", format_child_health_line(service));
    }
}

fn format_child_health_line(service: &serde_json::Value) -> String {
    let name = service
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("<unknown>");
    let state = service
        .get("state")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let port = service
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .map_or_else(|| "unknown".to_string(), |port| port.to_string());
    let healthy = service
        .get("healthy")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let restart_attempts = service
        .get("restart_attempts")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let instance_id = service
        .get("instance_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("<missing>");
    let marker = if healthy { "OK" } else { "FAIL" };

    format!(
        "{marker} name={name} port={port} state={state} restart_attempts={restart_attempts} instance_id={instance_id}"
    )
}

/// Poll GET /health (unauthenticated) up to 5 times to confirm the Hub is reachable.
fn verify_servicehub_health(hub_url: &str, _token: &str, cancel: &Arc<AtomicBool>) -> bool {
    let url = format!("{hub_url}/health");
    for attempt in 0..5 {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        match ureq::get(&url).timeout(Duration::from_secs(3)).call() {
            Ok(resp) if resp.status() == 200 => {
                eprintln!("[servicehub] health probe OK (attempt {})", attempt + 1);
                return true;
            }
            Ok(resp) => {
                eprintln!(
                    "[servicehub] health probe got HTTP {} (attempt {})",
                    resp.status(),
                    attempt + 1
                );
            }
            Err(e) => {
                eprintln!(
                    "[servicehub] health probe error (attempt {}): {}",
                    attempt + 1,
                    e
                );
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

fn retry_authenticated_readiness(
    cancel: &AtomicBool,
    retry_delay: Duration,
    mut probe: impl FnMut(u32) -> bool,
) -> bool {
    for attempt in 1..=5 {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        if probe(attempt) {
            return true;
        }
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        if attempt < 5 {
            thread::sleep(retry_delay);
        }
    }
    false
}

fn verify_authenticated_servicehub_readiness(
    hub_url: &str,
    token: &str,
    cancel: &Arc<AtomicBool>,
) -> bool {
    let url = format!("{hub_url}/app/readiness");
    let auth = format!("Bearer {token}");
    retry_authenticated_readiness(
        cancel,
        Duration::from_millis(500),
        |attempt| match ureq::get(&url)
            .set("Authorization", &auth)
            .timeout(Duration::from_secs(3))
            .call()
        {
            Ok(response) if response.status() == 200 => {
                match response.into_json::<serde_json::Value>() {
                    Ok(payload) if payload.is_object() => true,
                    Ok(_) => {
                        eprintln!(
                            "[servicehub] readiness probe returned non-object JSON (attempt {attempt})"
                        );
                        false
                    }
                    Err(error) => {
                        eprintln!(
                            "[servicehub] readiness probe returned invalid JSON (attempt {attempt}): {error}"
                        );
                        false
                    }
                }
            }
            Ok(response) => {
                eprintln!(
                    "[servicehub] readiness probe returned HTTP {} (attempt {attempt})",
                    response.status()
                );
                false
            }
            Err(error) => {
                eprintln!("[servicehub] readiness probe failed (attempt {attempt}): {error}");
                false
            }
        },
    )
}

fn reuse_listener_preflight(
    app_handle: &AppHandle,
    port: u16,
    token: &str,
    pid: u32,
    hub_url: &str,
    cancel: &Arc<AtomicBool>,
) -> bool {
    let started_at = Instant::now();
    let (listener_status, startup_wait_expired) = loop {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        let status = reuse_handoff_identity_status(port, token, pid);
        if status != TcpListenerStatus::Missing {
            break (status, false);
        }
        if started_at.elapsed() >= REUSE_LISTENER_STARTUP_TIMEOUT {
            break (status, true);
        }
        thread::sleep(REUSE_LISTENER_STARTUP_POLL);
    };

    let result = run_reuse_listener_preflight(
        Some(listener_status),
        startup_wait_expired,
        || verify_authenticated_servicehub_readiness(hub_url, token, cancel),
        || {
            if !cancel.load(Ordering::SeqCst) {
                stale_reuse_self_heal(
                    app_handle,
                    port,
                    Some((port, token.to_owned(), pid)),
                    "reused Hub listener did not start",
                );
            }
        },
        |code, message| {
            if !cancel.load(Ordering::SeqCst) {
                emit_error(app_handle, code, message);
            }
        },
    );

    if cancel.load(Ordering::SeqCst) {
        return false;
    }

    match result {
        ReuseListenerPreflight::Ready => {
            if cancel.load(Ordering::SeqCst) {
                return false;
            }
            accept_reuse_after_identity_recheck(
                || reuse_handoff_identity_status(port, token, pid),
                || cancel.load(Ordering::SeqCst),
                |code, message| emit_error(&app_handle, code, message),
            )
        }
        ReuseListenerPreflight::ProbeFailed => {
            if !cancel.load(Ordering::SeqCst) {
                stale_reuse_self_heal(
                    app_handle,
                    port,
                    Some((port, token.to_owned(), pid)),
                    "authenticated readiness probe failed",
                );
            }
            false
        }
        ReuseListenerPreflight::RecoveryStarted
        | ReuseListenerPreflight::Rejected
        | ReuseListenerPreflight::Waiting => false,
    }
}

/// Authenticated REUSE validation for child-service health.
///
/// Unlike [`verify_servicehub_health`] (which only checks the Hub *shell* is up
/// via unauthenticated `/health`), this first reads the Hub registry via
/// `/app/services/health`, then directly probes each child through its proxied
/// `/<service>/v1/health` endpoint and validates `service` + `instance_id`.
/// This second layer is required because the registry can be stale: a killed
/// child can still be shown as `state=running` briefly (or if monitor/watchdog
/// recovery wedged), which would otherwise make REUSE attach to a missing LRM.
///
/// Network/parse failures return [`ChildHealthVerdict::Unknown`] so the caller
/// can decide conservatively rather than treating a probe error as "healthy".
/// Fetch the committed primary Bundle ID from ServiceHub and cache it in prefs
/// so host telemetry can include it without querying LRM directly.
fn cache_bundle_id_from_servicehub(app: &tauri::AppHandle, hub_url: &str, token: &str) {
    let app = app.clone();
    let hub_url = hub_url.to_owned();
    let token = token.to_owned();
    std::thread::spawn(move || {
        const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
        const DEADLINE: std::time::Duration = std::time::Duration::from_secs(300);
        let started_at = std::time::Instant::now();
        while started_at.elapsed() <= DEADLINE {
            let url = format!("{hub_url}/app/capability-profile");
            let result = ureq::get(&url)
                .set("Authorization", &format!("Bearer {token}"))
                .timeout(std::time::Duration::from_secs(3))
                .call();
            let bundle_id = match result {
                Ok(response) => response
                    .into_json::<serde_json::Value>()
                    .ok()
                    .and_then(|v| {
                        v.get("primary_bundle")?
                            .get("bundle_id")?
                            .as_str()
                            .map(ToOwned::to_owned)
                    }),
                Err(_) => None,
            };
            if let Some(id) = bundle_id {
                if let Err(e) = crate::commands::app_prefs::cache_committed_bundle_id(&app, &id) {
                    tracing::debug!(error = %e, "failed to cache committed bundle id");
                } else {
                    tracing::info!(bundle_id = %id, "cached committed bundle id from ServiceHub");
                    crate::telemetry::notify_bundle_id_cached();
                }
                return;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
        tracing::debug!("timed out waiting for committed bundle id from ServiceHub");
    });
}

fn cache_product_version_from_servicehub(app: &tauri::AppHandle, hub_url: &str, token: &str) {
    let app = app.clone();
    let hub_url = hub_url.to_owned();
    let token = token.to_owned();
    std::thread::spawn(move || {
        const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
        const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);
        let started_at = std::time::Instant::now();
        while started_at.elapsed() <= DEADLINE {
            let url = format!("{hub_url}/sandbox-manager/v1/system/status");
            let version = ureq::get(&url)
                .set("Authorization", &format!("Bearer {token}"))
                .timeout(std::time::Duration::from_secs(3))
                .call()
                .ok()
                .and_then(|r| r.into_json::<serde_json::Value>().ok())
                .and_then(|v| v.get("version")?.as_str().map(ToOwned::to_owned));
            if let Some(ver) = version {
                if let Err(e) = crate::commands::app_prefs::cache_product_version(&app, &ver) {
                    tracing::debug!(error = %e, "failed to cache product version");
                }
                crate::telemetry::notify_product_version(&ver);
                return;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
        tracing::debug!("timed out waiting for product version from sandbox_manager");
    });
}

fn probe_child_service_health(hub_url: &str, token: &str, target: &ChildHealthTarget) -> bool {
    let url = format!(
        "{}{}{}",
        hub_url,
        target.proxy_prefix.trim_end_matches('/'),
        "/v1/health"
    );
    let auth = format!("Bearer {token}");
    match ureq::get(&url)
        .timeout(Duration::from_secs(3))
        .set("Authorization", &auth)
        .call()
    {
        Ok(resp) if resp.status() == 200 => match resp.into_json::<serde_json::Value>() {
            Ok(payload) => {
                let ok = direct_child_health_matches(target, &payload);
                if !ok {
                    eprintln!(
                        "[servicehub] direct child-health mismatch name={} prefix={} instance_id={}",
                        target.name, target.proxy_prefix, target.instance_id
                    );
                }
                ok
            }
            Err(err) => {
                eprintln!(
                    "[servicehub] direct child-health invalid JSON name={} error={err}",
                    target.name
                );
                false
            }
        },
        Ok(resp) => {
            eprintln!(
                "[servicehub] direct child-health HTTP {} name={} prefix={}",
                resp.status(),
                target.name,
                target.proxy_prefix
            );
            false
        }
        Err(err) => {
            eprintln!(
                "[servicehub] direct child-health error name={} prefix={} error={err}",
                target.name, target.proxy_prefix
            );
            false
        }
    }
}

fn fetch_child_health(hub_url: &str, token: &str, cancel: &Arc<AtomicBool>) -> ChildHealthVerdict {
    let url = format!("{hub_url}/app/readiness");
    let auth = format!("Bearer {token}");

    for attempt in 0..3 {
        if cancel.load(Ordering::SeqCst) {
            return ChildHealthVerdict::Unknown;
        }
        match ureq::get(&url)
            .timeout(Duration::from_secs(3))
            .set("Authorization", &auth)
            .call()
        {
            Ok(resp) if resp.status() == 200 => match resp.into_json::<serde_json::Value>() {
                Ok(payload) => {
                    let verdict = readiness::classify_app_readiness(&payload);
                    eprintln!(
                        "[servicehub] reuse child readiness probe (attempt {}): {:?}{}",
                        attempt + 1,
                        verdict,
                        readiness::format_readiness_blockers(&payload)
                    );
                    if verdict == ChildHealthVerdict::SomeUnhealthy {
                        return verdict;
                    }
                    if verdict == ChildHealthVerdict::AllHealthy {
                        // Addressing for the direct probes comes from the catalog,
                        // which is the documented carrier of `proxy_prefix`.
                        let Some(catalog) = readiness::fetch_services_catalog(hub_url, token) else {
                            eprintln!(
                                "[servicehub] reuse child-health probe: services catalog unavailable"
                            );
                            return ChildHealthVerdict::Unknown;
                        };
                        let Some(targets) =
                            readiness::child_health_targets_from(&payload, &catalog)
                        else {
                            eprintln!(
                                "[servicehub] reuse child-health probe: readiness/catalog missing direct probe targets"
                            );
                            return ChildHealthVerdict::Unknown;
                        };
                        let all_direct_healthy = targets
                            .iter()
                            .all(|target| probe_child_service_health(hub_url, token, target));
                        if all_direct_healthy {
                            eprintln!(
                                "[servicehub] reuse direct child-health probe (attempt {}): AllHealthy",
                                attempt + 1
                            );
                            return ChildHealthVerdict::AllHealthy;
                        }
                        eprintln!(
                            "[servicehub] reuse direct child-health probe (attempt {}): SomeUnhealthy",
                            attempt + 1
                        );
                        return ChildHealthVerdict::SomeUnhealthy;
                    }
                    // A transient partial snapshot can read Unknown; retry a
                    // couple of times before giving the caller Unknown.
                }
                Err(err) => eprintln!(
                    "[servicehub] reuse child-health probe: invalid JSON (attempt {}): {err}",
                    attempt + 1
                ),
            }
            Ok(resp) => eprintln!(
                "[servicehub] reuse child-health probe: HTTP {} (attempt {})",
                resp.status(),
                attempt + 1
            ),
            Err(err) => eprintln!(
                "[servicehub] reuse child-health probe error (attempt {}): {err}",
                attempt + 1
            ),
        }
        thread::sleep(Duration::from_millis(500));
    }
    ChildHealthVerdict::Unknown
}

/// Ask a reused, still-running Hub to restart its child services in place via
/// `POST /app/system/restart` (bearer-protected). This is the *cheap* recovery
/// for a stale data-plane: it avoids killing the Hub process and cold-restarting
/// the whole supervisor when only the children went stale.
///
/// Returns whether the restart request was accepted (HTTP 2xx). The route is
/// async/fan-out on the Hub side, so acceptance does not by itself prove the
/// children are healthy again — the caller re-probes child health afterwards.
fn request_hub_restart(hub_url: &str, token: &str) -> Option<String> {
    let url = format!("{hub_url}/app/system/restart");
    let auth = format!("Bearer {token}");
    match ureq::post(&url)
        .timeout(Duration::from_secs(10))
        .set("Authorization", &auth)
        .set("Content-Type", "application/json")
        .send_string("{}")
    {
        Ok(resp) => {
            let status = resp.status();
            if !(200..300).contains(&status) {
                eprintln!("[servicehub] reuse child-restart request → HTTP {status} (rejected)");
                return None;
            }
            eprintln!("[servicehub] reuse child-restart request → HTTP {status} (accepted)");
            match resp.into_json::<serde_json::Value>() {
                Ok(payload) => hub_operation_id(&payload),
                Err(e) => {
                    eprintln!("[servicehub] reuse child-restart response invalid JSON: {e}");
                    None
                }
            }
        }
        Err(e) => {
            eprintln!("[servicehub] reuse child-restart request failed: {e}");
            None
        }
    }
}

/// Kick the sandbox container bring-up via
/// `POST /app/runtime/converge` (idempotent desired-deployment convergence).
///
/// This is the reuse-path replacement for the fact that `sandbox_manager` only
/// auto-provisions at its own process startup. When the reused Hub's container
/// is `stopped`/`error`/`missing`, this actively re-triggers the same bring-up a
/// cold start would perform (restart a stopped container, or full re-provision).
///
/// Returns the provision result. A managed SandboxManager deliberately rejects
/// public provisions until the Capability flow has committed a Profile;
/// the desktop must then emit ServiceHub-ready so that flow can begin.
fn request_sandbox_provision(hub_url: &str, hub_token: &str) -> SandboxProvisionOutcome {
    let url = format!("{hub_url}/app/runtime/converge");
    let auth = format!("Bearer {hub_token}");
    match ureq::post(&url)
        .timeout(Duration::from_secs(15))
        .set("Authorization", &auth)
        .set("Content-Type", "application/json")
        .send_string("{}")
    {
        Ok(resp) => {
            let status = resp.status();
            let ok = (200..300).contains(&status);
            eprintln!(
                "[servicehub] data-plane: sandbox provision request → HTTP {status} ({})",
                if ok { "accepted" } else { "rejected" }
            );
            if ok {
                SandboxProvisionOutcome::Accepted
            } else {
                SandboxProvisionOutcome::Rejected
            }
        }
        Err(ureq::Error::Status(409, response)) => {
            let payload = response.into_json::<serde_json::Value>();
            if payload
                .as_ref()
                .is_ok_and(is_capability_profile_required)
            {
                SandboxProvisionOutcome::CapabilityProfileRequired
            } else {
                eprintln!("[servicehub] data-plane: sandbox provision request → HTTP 409 (rejected)");
                SandboxProvisionOutcome::Rejected
            }
        }
        Err(e) => {
            eprintln!("[servicehub] data-plane: sandbox provision request failed: {e}");
            SandboxProvisionOutcome::Rejected
        }
    }
}

/// Discover whether the resident Hub owns an active Model Binding Activation.
fn request_active_model_binding_activation(hub_url: &str, hub_token: &str) -> Result<bool, String> {
    let url = format!("{hub_url}/app/model-binding/activations/active");
    let auth = format!("Bearer {hub_token}");
    match ureq::get(&url)
        .timeout(Duration::from_secs(5))
        .set("Authorization", &auth)
        .call()
    {
        Ok(response) if response.status() == 200 => {
            let payload = response
                .into_json::<serde_json::Value>()
                .map_err(|error| format!("activation discovery returned invalid JSON: {error}"))?;
            parse_active_model_binding_activation(&payload)
        }
        Ok(response) => Err(format!(
            "activation discovery returned HTTP {}",
            response.status()
        )),
        // Older Hubs predate active activation discovery; preserve their existing
        // REUSE behavior during the staged rollout.
        Err(ureq::Error::Status(404, _)) => Ok(false),
        Err(ureq::Error::Status(status, _)) => {
            Err(format!("activation discovery returned HTTP {status}"))
        }
        Err(error) => Err(format!("activation discovery request failed: {error}")),
    }
}

fn parse_active_model_binding_activation(payload: &serde_json::Value) -> Result<bool, String> {
    let contract_version = payload
        .get("contract_version")
        .and_then(serde_json::Value::as_u64);
    if contract_version != Some(1) {
        return Err("activation discovery returned an unsupported contract version".to_owned());
    }
    if payload.get("disposition").is_some() {
        return Err("activation discovery returned retired handoff fields".to_owned());
    }
    let Some(operation) = payload.get("operation") else {
        return Err("activation discovery lacks an operation field".to_owned());
    };
    if operation.is_null() {
        return Ok(false);
    }
    let operation = operation
        .as_object()
        .ok_or_else(|| "activation discovery returned an invalid operation projection".to_owned())?;
    if operation.contains_key("phase") || operation.contains_key("state") {
        return Err("activation discovery returned an invalid operation projection".to_owned());
    }
    let operation_version = operation.get("contract_version").and_then(serde_json::Value::as_u64);
    let operation_id = operation.get("operation_id").and_then(serde_json::Value::as_str);
    let status = operation.get("status").and_then(serde_json::Value::as_str);
    let stage = operation.get("stage").and_then(serde_json::Value::as_str);
    if operation_version == Some(1)
        && operation_id.is_some_and(|value| {
            value.strip_prefix("hub:").is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
            })
        })
        && status == Some("applying")
        && matches!(stage, Some("preparing" | "activating" | "aligning_runtime"))
    {
        Ok(true)
    } else {
        Err("activation discovery returned an invalid operation projection".to_owned())
    }
}

fn wait_for_hub_operation(
    hub_url: &str,
    token: &str,
    operation_id: &str,
    cancel: &Arc<AtomicBool>,
) -> bool {
    let url = format!("{hub_url}/app/operations/{operation_id}");
    let auth = format!("Bearer {token}");
    let deadline = Instant::now() + REUSE_CHILD_RESTART_TIMEOUT;

    loop {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        if Instant::now() >= deadline {
            eprintln!("[servicehub] reuse child-restart operation {operation_id} timed out");
            return false;
        }

        match ureq::get(&url)
            .timeout(Duration::from_secs(5))
            .set("Authorization", &auth)
            .call()
        {
            Ok(resp) if resp.status() == 200 => match resp.into_json::<serde_json::Value>() {
                Ok(payload) => match payload.get("state").and_then(serde_json::Value::as_str) {
                    Some("done") | Some("skipped") => return true,
                    Some("error") | Some("cancelled") => {
                        eprintln!(
                            "[servicehub] reuse child-restart operation {operation_id} ended as {:?}",
                            payload.get("state")
                        );
                        return false;
                    }
                    Some(state) => eprintln!(
                        "[servicehub] reuse child-restart operation {operation_id} state={state}"
                    ),
                    None => eprintln!(
                        "[servicehub] reuse child-restart operation {operation_id} missing state"
                    ),
                },
                Err(e) => eprintln!(
                    "[servicehub] reuse child-restart operation {operation_id} invalid JSON: {e}"
                ),
            },
            Ok(resp) => eprintln!(
                "[servicehub] reuse child-restart operation {operation_id} HTTP {}",
                resp.status()
            ),
            Err(e) => eprintln!(
                "[servicehub] reuse child-restart operation {operation_id} poll failed: {e}"
            ),
        }

        thread::sleep(Duration::from_secs(2));
    }
}

fn wait_for_child_health_after_restart(
    hub_url: &str,
    token: &str,
    cancel: &Arc<AtomicBool>,
) -> ChildHealthVerdict {
    let deadline = Instant::now() + REUSE_CHILD_HEALTH_SETTLE_TIMEOUT;
    let mut last_verdict = ChildHealthVerdict::Unknown;

    while Instant::now() < deadline {
        if cancel.load(Ordering::SeqCst) {
            return ChildHealthVerdict::Unknown;
        }
        thread::sleep(Duration::from_secs(2));
        last_verdict = fetch_child_health(hub_url, token, cancel);
        if last_verdict == ChildHealthVerdict::AllHealthy {
            return last_verdict;
        }
    }

    last_verdict
}

// ── Public API ─────────────────────────────────────────────────────────────

pub fn start_servicehub(
    app: &AppHandle,
    manager: &ServiceHubManager,
) -> Result<ServiceHubInfo, String> {
    if let Some(bs) = app.try_state::<ServiceHubBootState>() {
        bs.reset_starting();
    }

    let mut state = match manager.inner.lock() {
        Ok(state) => state,
        Err(_) => {
            // Surface this like the other start_servicehub error paths so the
            // frontend/boot-state see the failure instead of a silent hang;
            // lib.rs's auto-start relies on every error path self-reporting.
            let error = "servicehub mutex poisoned".to_string();
            emit_error(app, "spawn.mutex_poisoned", &error);
            return Err(error);
        }
    };

    // Stop any existing instance
    ServiceHubManager::stop_locked(&mut state);

    let port = match port::select_service_hub_port() {
        Ok(port) => port,
        Err(error) => {
            emit_error(app, "spawn.port_unavailable", &error);
            return Err(error);
        }
    };

    let launch_target = match resolve_servicehub_launch_target(port) {
        Ok(target) => target,
        Err(error) => {
            emit_error(app, "spawn.resolve_failed", &error);
            return Err(error);
        }
    };
    eprintln!(
        "[servicehub] starting via {}: command={} cwd={} args={:?}",
        launch_target.description,
        launch_target.command,
        launch_target.cwd.display(),
        launch_target.args
    );

    emit_progress(
        app,
        "spawn",
        &format!(
            "Starting ServiceHub ({}) from {}",
            launch_target.description,
            launch_target.cwd.display()
        ),
        None,
    );

    let mut cmd = app
        .shell()
        .command(launch_target.command.clone())
        .args(launch_target.args.clone())
        .current_dir(&launch_target.cwd);

    for (key, value) in &launch_target.env {
        cmd = cmd.env(*key, value);
    }

    // Startup-logging unification (2026-07-21): thread the launch boot_id into
    // ServiceHub so its loguru output (and every child it spawns, which inherit
    // this process env) carries the same correlation key as tauri.log.
    cmd = cmd.env("SUPERCLAW_BOOT_ID", crate::logging::boot_id());

    // Force UTF-8 on the Python child's stdout/stderr. On Windows the child
    // otherwise encodes non-ASCII (e.g. Python 3.12 traceback caret/box-drawing
    // markers) with the system ANSI code page (cp936/GBK), which the shell
    // plugin then decodes as UTF-8 and mangles into U+FFFD replacement chars in
    // tauri.log. PYTHONUTF8 + PYTHONIOENCODING make the child emit UTF-8 so the
    // captured lines round-trip cleanly. Children inherit this env too.
    cmd = cmd.env("PYTHONUTF8", "1");
    cmd = cmd.env("PYTHONIOENCODING", "utf-8");

    if cfg!(debug_assertions) {
        cmd = cmd.env("SUPERCLAW_DEBUG_OBSERVABILITY", "1");
    }

    // OTLP + telemetry env for ServiceHub children (all build flavors).
    let baseline = crate::telemetry::effective_baseline_telemetry_enabled(app);
    let full_telemetry = crate::telemetry::effective_full_telemetry_enabled(app);
    if baseline || full_telemetry {
        crate::telemetry::ensure_process_otlp_env_for_export();
        // Forward OTLP as a pair only when export is fully configured; otherwise clear
        // inherited host env so children cannot export with a prod/dev mismatch.
        let otlp_patch =
            crate::telemetry::otlp_child_export_env_patch(&launch_target.env);
        for (key, value) in crate::telemetry::otlp_child_export_env_overrides(&otlp_patch) {
            cmd = cmd.env(key, value);
        }
    }
    if baseline || full_telemetry {
        match crate::commands::app_prefs::resolve_runtime_install_id(app) {
            Ok(Some(install_id)) => {
                cmd = cmd.env("SUPERCLAW_INSTALL_ID", install_id);
            }
            Ok(None) => {}
            Err(e) => {
                emit_error(app, "telemetry.install_id", &e);
            }
        }
    }
    if baseline {
        // Propagate consent to ServiceHub children (sandbox reads these at runtime).
        cmd = cmd.env("SUPERCLAW_BASELINE_TELEMETRY", "1");
    } else {
        cmd = cmd.env("SUPERCLAW_BASELINE_TELEMETRY", "");
    }
    if full_telemetry {
        cmd = cmd.env("SUPERCLAW_FULL_TELEMETRY", "1");
    } else {
        cmd = cmd.env("SUPERCLAW_FULL_TELEMETRY", "");
    }
    if !(baseline || full_telemetry) {
        let strip_patch = crate::telemetry::OtlpChildExportEnvPatch {
            strip_inherited: true,
            endpoint: None,
            headers: None,
        };
        for (key, value) in crate::telemetry::otlp_child_export_env_overrides(&strip_patch) {
            cmd = cmd.env(key, value);
        }
    }

    let (mut rx, child) = cmd.spawn().map_err(|e| {
        let error = format!(
            "Failed to spawn ServiceHub via {} (command={}, cwd={}): {e}",
            launch_target.description,
            launch_target.command,
            launch_target.cwd.display()
        );
        emit_error(app, "spawn.failed", &error);
        error
    })?;

    state.child = Some(child);
    state.child_exited = false;

    let snapshot = ServiceHubManager::snapshot_locked(&mut state);
    let cancel = ServiceHubManager::cancel_boot_and_new_token(&mut state);

    // Drop the state lock before spawning threads
    drop(state);

    // Handshake channel: stdout reader → boot thread. The bool is `is_reuse`.
    let (handshake_tx, handshake_rx) =
        std::sync::mpsc::channel::<(u16, String, bool, Option<u32>)>();
    let state_handle = manager.inner.clone();

    // Async task: consume stdout/stderr, detect handshake line
    tauri::async_runtime::spawn(async move {
        let mut handshake_sent = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    let safe_line = safe_servicehub_stdout_line(&line);
                    tracing::info!(
                        boot_id = %crate::logging::boot_id(),
                        component = "tauri",
                        stage = "servicehub.stdout",
                        "{}",
                        safe_line.trim()
                    );

                    if !handshake_sent {
                        if let Some((port, token, is_reuse, pid)) = parse_servicehub_ready(&line) {
                            tracing::info!(
                                boot_id = %crate::logging::boot_id(),
                                component = "tauri",
                                stage = "handshake.received",
                                port,
                                reuse = is_reuse,
                                "ServiceHub handshake received"
                            );
                            let _ = handshake_tx.send((port, token, is_reuse, pid));
                            handshake_sent = true;
                        }
                    }

                    if let Ok(mut st) = state_handle.try_lock() {
                        let next =
                            st.last_stdout.as_deref().unwrap_or_default().to_string() + &safe_line;
                        st.last_stdout = Some(truncate_output(&next, 8000));
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    // Security prerequisite (2026-07-21 design §4.1): once Rust
                    // stderr is persisted to tauri.log it must be sanitized just
                    // like stdout, or a child's `--hub-token`/`Authorization:`
                    // line would land on disk. Reuse the stdout sanitizer.
                    let safe_line = safe_servicehub_stdout_line(&line);
                    tracing::info!(
                        boot_id = %crate::logging::boot_id(),
                        component = "tauri",
                        stage = "servicehub.stderr",
                        "{}",
                        safe_line.trim()
                    );

                    if let Ok(mut st) = state_handle.try_lock() {
                        // Store the *sanitized* line, not the raw one: `last_stderr`
                        // is surfaced to the UI via `compose_handshake_failed_message`
                        // (which runs `sanitize_servicehub_startup_detail`, dropping
                        // credential lines), but keeping raw credentials in memory is
                        // a needless latent leak for any future consumer. Redact at
                        // the ingress so state never holds a token.
                        let next = st.last_stderr.as_deref().unwrap_or_default().to_string()
                            + &safe_line;
                        st.last_stderr = Some(truncate_output(&next, 8000));
                    }
                }
                CommandEvent::Terminated(payload) => {
                    // Diagnostic (ServiceHub exit-code-1 debugging): emit a
                    // discrete, timestamped event the moment the child exits.
                    // Before this, an exit-before-handshake was only observable
                    // as an eventual `handshake.failed` composed message; there
                    // was no line pinning WHEN the child died, with WHAT code,
                    // and whether it was pre- or post-handshake. `pre_handshake`
                    // distinguishes a crash during startup (the exit-code-1
                    // case) from a normal later shutdown. The child's own
                    // stderr/traceback is already logged line-by-line under
                    // stage="servicehub.stderr"; grep the same boot_id just
                    // before this line for the cause.
                    tracing::error!(
                        boot_id = %crate::logging::boot_id(),
                        component = "servicehub",
                        stage = "servicehub.terminated",
                        exit_code = payload.code,
                        pre_handshake = !handshake_sent,
                        "ServiceHub child process terminated"
                    );
                    if let Ok(mut st) = state_handle.try_lock() {
                        st.child_exited = true;
                        st.last_stderr = Some(append_servicehub_exit_status(
                            st.last_stderr.take(),
                            payload.code,
                        ));
                    }
                }
                CommandEvent::Error(msg) => {
                    // Diagnostic: a spawn/IO-layer error (distinct from a clean
                    // child exit). Sanitize before logging — the message can
                    // echo the spawn command line, which may carry --hub-token.
                    let safe_msg = safe_servicehub_stdout_line(&msg);
                    tracing::error!(
                        boot_id = %crate::logging::boot_id(),
                        component = "servicehub",
                        stage = "servicehub.io_error",
                        pre_handshake = !handshake_sent,
                        "ServiceHub child process I/O error: {}",
                        safe_msg.trim()
                    );
                    if let Ok(mut st) = state_handle.try_lock() {
                        st.child_exited = true;
                        let next = st.last_stderr.as_deref().unwrap_or_default().to_string() + &msg;
                        st.last_stderr = Some(truncate_output(&next, 8000));
                    }
                }
                _ => {}
            }
        }
    });

    // Background thread: handshake → health check → emit ready
    let app_handle = app.clone();
    let boot_state = manager.inner.clone();
    thread::spawn(move || {
        run_boot_sequence(app_handle, boot_state, handshake_rx, cancel);
    });

    Ok(snapshot)
}

pub fn get_servicehub_status(manager: &ServiceHubManager) -> Result<ServiceHubInfo, String> {
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "servicehub mutex poisoned".to_string())?;
    Ok(ServiceHubManager::snapshot_locked(&mut state))
}

const STOP_SERVICEHUB_BLOCKED_MSG: &str =
    "ServiceHub is still running and could not be stopped safely. \
     Turn off “Keep backend running”, fully quit SuperClaw, or reboot, then try again.";

/// Best-effort probe: something is accepting TCP connections on localhost.
fn local_tcp_port_accepting_connections(port: u16) -> bool {
    use std::net::{SocketAddr, TcpStream};

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn reap_lockfile_servicehub_pid(pid: u32) -> Result<(), String> {
    if force_kill_stale_servicehub(pid) {
        delete_servicehub_lockfile();
        return Ok(());
    }
    if identity::lockfile_pid_process_is_running(pid) {
        return Err(STOP_SERVICEHUB_BLOCKED_MSG.to_string());
    }
    eprintln!(
        "[servicehub] lockfile pid={pid} is no longer running — removing stale lockfile"
    );
    delete_servicehub_lockfile();
    Ok(())
}

/// When `servicehub.lock` is missing or unreadable, discover our Hub via process
/// scan (same primitive as missing-lockfile REUSE self-heal) and/or verify the
/// reused handoff port has gone quiet.
fn reap_kept_alive_servicehub_without_lockfile(
    reused_hub_port: Option<u16>,
) -> Result<(), String> {
    let pids = identity::servicehub_pids_without_lockfile();
    if pids.is_empty() {
        if reused_hub_port.is_some_and(local_tcp_port_accepting_connections) {
            return Err(STOP_SERVICEHUB_BLOCKED_MSG.to_string());
        }
        return Ok(());
    }

    let mut killed_any = false;
    let mut still_running = false;
    for pid in pids {
        if force_kill_stale_servicehub(pid) {
            killed_any = true;
        } else if identity::lockfile_pid_process_is_running(pid) {
            still_running = true;
        }
    }
    if killed_any {
        delete_servicehub_lockfile();
    }
    if still_running {
        return Err(STOP_SERVICEHUB_BLOCKED_MSG.to_string());
    }
    if reused_hub_port.is_some_and(local_tcp_port_accepting_connections) {
        return Err(STOP_SERVICEHUB_BLOCKED_MSG.to_string());
    }
    Ok(())
}

fn reap_kept_alive_primary_servicehub(reused_hub_port: Option<u16>) -> Result<(), String> {
    match read_servicehub_lockfile_pid() {
        Some(pid) => reap_lockfile_servicehub_pid(pid),
        None => reap_kept_alive_servicehub_without_lockfile(reused_hub_port),
    }
}

pub fn stop_servicehub(manager: &ServiceHubManager) -> Result<ServiceHubInfo, String> {
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "servicehub mutex poisoned".to_string())?;

    let reused_hub_port = state.hub_port;

    // REUSE / keepBackendOnExit: the live Hub may not be `state.child`. Ask it
    // to shut down while we still hold port + token from the handoff.
    if let (Some(port), Some(token)) = (reused_hub_port, state.hub_token.clone()) {
        graceful_shutdown_sync(port, &token);
        thread::sleep(Duration::from_millis(300));
    }

    ServiceHubManager::stop_locked(&mut state);

    // On a REUSE launch `state.child` is only the short-lived handoff process
    // that printed `REUSE {...}` and exited — the primary kept-alive Hub is a
    // separate process, tracked only by the PID in `servicehub.lock`. Reap it
    // too so a caller that needs a real cold restart (e.g. telemetry consent
    // changing) doesn't leave the old Hub/children running with stale env.
    reap_kept_alive_primary_servicehub(reused_hub_port)?;

    Ok(ServiceHubManager::snapshot_locked(&mut state))
}

/// Graceful HTTP shutdown of ServiceHub before killing the sidecar process.
/// Sends `POST /app/system/shutdown`; process teardown is handled by the caller.
pub fn graceful_shutdown_sync(port: u16, token: &str) {
    let url = format!("http://127.0.0.1:{port}/app/system/shutdown");
    let auth = format!("Bearer {token}");

    eprintln!("[servicehub] sending graceful shutdown to port {port}");
    match ureq::post(&url)
        .timeout(SHUTDOWN_HTTP_TIMEOUT)
        .set("Authorization", &auth)
        .set("Content-Type", "application/json")
        .send_string("{}")
    {
        Ok(_) => {
            eprintln!("[servicehub] shutdown request accepted");
        }
        Err(e) => {
            eprintln!("[servicehub] shutdown request failed (will force-kill): {e}");
        }
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod reuse_identity_tests;
