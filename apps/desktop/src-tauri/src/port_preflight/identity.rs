//! Identity check for the process holding one of our ports — a Rust port of
//! ServiceHub's `_is_our_orphan_image_path` / `_is_our_orphan_cmdline`.
//!
//! ## Why this must match ServiceHub exactly
//!
//! ServiceHub already solves the same problem in
//! `process_manager._ensure_fixed_ports_bindable`: a fixed child port is occupied,
//! and it must decide whether the holder is one of its own orphaned children
//! (safe to reap) or an unrelated program (must never be touched). If this gate
//! used a weaker test, the two would disagree — the gate would refuse to start
//! over a process ServiceHub would happily reap, or wave through something
//! ServiceHub would treat as a hard blocker. Same question, same answer.
//!
//! ## The two accepted proofs of ownership
//!
//! A holder qualifies as ours when EITHER holds:
//!
//! 1. **Image path** matches the exact location we would have launched the child
//!    from — `<install>\servicehub\<name>\<name>.exe` for a packaged build. This
//!    is the strongest signal and needs no external tooling: it comes from
//!    `QueryFullProcessImageNameW`, which works unelevated and cannot be spoofed
//!    by naming a binary `llama-server.exe`.
//! 2. **Command line** references this specific service (its entrypoint as a
//!    `-m <module>` launch, or its `<name>.exe`) **and** carries a SuperClaw
//!    ownership marker (an install-path fragment). Requiring *both* is what keeps
//!    a user's own `python -m http.server` or a private `llmrouter_manager` clone
//!    outside our tree from matching.
//!
//! Everything else — including a holder whose identity cannot be read at all — is
//! NOT ours. ServiceHub fails safe by declining to kill; we fail safe by reporting
//! the conflict. Both refuse to act on an unverified process.

use std::path::{Path, PathBuf};

/// Built-in lowercase fragments that mark a path/command line as SuperClaw's.
///
/// Mirrors `process_manager._ownership_markers`: the dev source tree, the
/// packaged `servicehub` layout, and the `%LOCALAPPDATA%\SuperClaw` app-data root.
const OWNERSHIP_MARKERS: &[&str] = &["applications.ai.superclaw", "servicehub", "superclaw"];

/// Env var for extending the marker list, matching ServiceHub's escape hatch for
/// custom install paths that contain none of the built-in fragments.
const EXTRA_MARKERS_ENV: &str = "SUPERCLAW_ORPHAN_MARKERS";

/// Lowercase, backslash-normalised form for path/command-line comparison.
fn normalize(value: &str) -> String {
    value.replace('/', "\\").to_ascii_lowercase()
}

/// All ownership markers, built-ins plus any from `SUPERCLAW_ORPHAN_MARKERS`.
fn ownership_markers() -> Vec<String> {
    let mut markers: Vec<String> = OWNERSHIP_MARKERS.iter().map(|m| m.to_string()).collect();
    if let Ok(extra) = std::env::var(EXTRA_MARKERS_ENV) {
        for chunk in extra.replace(';', ",").replace(':', ",").split(',') {
            let token = chunk.trim().to_ascii_lowercase();
            if !token.is_empty() {
                markers.push(token);
            }
        }
    }
    markers
}

/// Whether `haystack` carries any SuperClaw ownership marker.
pub(super) fn has_ownership_marker(haystack: &str) -> bool {
    let normalized = normalize(haystack);
    ownership_markers()
        .iter()
        .any(|marker| normalized.contains(marker.as_str()))
}

/// The exact image path a packaged ServiceHub child would run from.
///
/// Mirrors `_expected_frozen_child_image_path`: ServiceHub computes it as
/// `PureWindowsPath(sys.executable).parent / stem / exe_name`, i.e. a `<name>`
/// subdirectory beside the Hub image. `servicehub_dir` is that parent.
pub(super) fn expected_child_image_path(servicehub_dir: &Path, exe_name: &str) -> PathBuf {
    let stem = Path::new(exe_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| exe_name.to_string());
    servicehub_dir.join(stem).join(exe_name)
}

/// Whether `image_path` is exactly where we would have launched this child from.
///
/// Exact comparison, not a substring test: a third-party binary sitting anywhere
/// else must not qualify no matter what it is called. Mirrors
/// `_is_our_orphan_image_path`.
pub(super) fn image_path_is_ours(image_path: &str, expected: &Path) -> bool {
    let strip = |value: &str| normalize(value).trim_end_matches('\\').to_string();
    strip(image_path) == strip(&expected.to_string_lossy())
}

/// Whether `cmdline` selects `role` via the multi-role dispatcher's `--service` flag.
///
/// Token-exact, not a substring test: `--service sandbox_manager_backup` must not
/// satisfy `sandbox_manager`. Mirrors `process_manager._cmdline_declares_role`.
pub(super) fn cmdline_declares_role(cmdline: &str, role: &str) -> bool {
    let lowered = cmdline.to_ascii_lowercase();
    let tokens: Vec<&str> = lowered.split_whitespace().collect();
    let target = role.to_ascii_lowercase();
    let equals_form = format!("--service={target}");
    tokens.iter().enumerate().any(|(index, token)| {
        (*token == "--service" && tokens.get(index + 1) == Some(&target.as_str()))
            || *token == equals_form.as_str()
    })
}

/// Whether `cmdline` is unmistakably this service, launched from our tree.
///
/// Mirrors `_is_our_orphan_cmdline`: BOTH a reference to this specific service
/// AND an ownership marker are required. Either alone is far too loose — a
/// marker alone would match any process running under a path containing
/// "superclaw", and a service reference alone would match an unrelated
/// `llmrouter_manager` clone elsewhere on the machine.
///
/// A `role` service adds a THIRD requirement: the role token. Several services
/// share one multi-role bundle, so their exe name, image path and every other
/// argv token are identical; without `--service <name>` the first two proofs
/// would accept ANY of our services as ANY other one.
pub(super) fn cmdline_is_ours(
    cmdline: &str,
    entrypoint: &str,
    exe_names: &[String],
    role: Option<&str>,
) -> bool {
    if let Some(role) = role {
        if !cmdline_declares_role(cmdline, role) {
            return false;
        }
    }

    let normalized = normalize(cmdline);
    let entrypoint_lower = entrypoint.to_ascii_lowercase();

    let references_executable = exe_names.iter().any(|exe| {
        let exe = exe.to_ascii_lowercase();
        normalized.contains(&format!("\\{exe}"))
            || normalized.trim_start_matches('"').starts_with(&format!("{exe} "))
            || normalized.trim_start_matches('"').trim_end() == exe
    });

    let references_entrypoint = normalized.contains(&format!("-m {entrypoint_lower}"))
        || references_executable
        // Bare-word match, padded so it cannot hit a longer identifier.
        || format!(" {normalized} ").contains(&format!(" {entrypoint_lower} "));

    references_entrypoint && has_ownership_marker(cmdline)
}

/// Read a process's full image path via `QueryFullProcessImageNameW`.
///
/// Preferred over `tasklist`/`wmic`/PowerShell: no subprocess, no dependency on
/// tools that may be absent or blocked by application-control policy, works
/// unelevated, and yields a full path rather than a spoofable image name.
/// Mirrors `process_manager._process_image_path`.
#[cfg(windows)]
pub(super) fn process_image_path(pid: u32) -> Option<PathBuf> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const MAX_PATH_CHARS: usize = 32_768;
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut buffer = vec![0_u16; MAX_PATH_CHARS];
    let mut length = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) };
    unsafe {
        let _ = CloseHandle(handle);
    }
    if ok == 0 || length == 0 {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(
        &buffer[..length as usize],
    )))
}

#[cfg(not(windows))]
pub(super) fn process_image_path(_pid: u32) -> Option<PathBuf> {
    None
}
