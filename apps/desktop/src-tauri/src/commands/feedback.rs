//! Debug-only "Report a Bug" log collection + gist upload.
//!
//! This is a **developer/debug-only** flow (the frontend only calls it when
//! `__BUILD_DEBUG__` is true). It reads recent SuperClaw launch logs and
//! uploads them as a secret `gh gist` using the developer's **locally installed
//! & already authenticated `gh` CLI** — the client never holds a GitHub token.
//! The frontend then opens the GitHub "new issue" prefill page in the browser
//! with the gist link dropped in; **this flow never runs `gh issue create`**,
//! the user reviews and submits the issue themselves.
//!
//! Log-selection rule (per bug-report design): under the `%LOCALAPPDATA%\
//! SuperClaw` root, for **each folder that directly contains `.log` files**
//! (a "leaf log folder"), take the **newest 2** by mtime; if a folder has only
//! one, take one; **skip any 0-byte file**. Large files are tailed to a cap so
//! the gist stays reasonable.
//!
//! Sensitivity note: `llmrouter_manager` logs may contain prompt fragments /
//! `sk-*` / `Bearer` tokens (see `host/llmrouter_manager/AGENTS.md`). Per the
//! design decision this flow surfaces the file list + a warning in the UI and
//! uploads the content as-is on explicit confirmation — it does not scrub.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::platform::command_for_program;

/// Per-file byte cap embedded per log. Anything larger is tailed to the last
/// `LOG_TAIL_BYTES` bytes so the gist/issue stays reasonable.
const LOG_TAIL_BYTES: usize = 64 * 1024;

/// One collected log file, ready for preview in the UI and upload via `gh`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectedLog {
    /// Absolute path on disk.
    pub path: String,
    /// Path relative to the SuperClaw root (e.g. `servicehub\logs\foo.log`),
    /// used as the gist filename (with separators flattened) and in the UI.
    pub relative_path: String,
    /// On-disk size in bytes (before any tailing).
    pub size_bytes: u64,
    /// Modified time as unix millis (for display / ordering in the UI).
    pub modified_ms: u64,
    /// File content, tailed to `LOG_TAIL_BYTES` if the file was larger.
    pub content: String,
    /// True when the embedded `content` was truncated to the tail.
    pub truncated: bool,
}

/// Resolve the `%LOCALAPPDATA%\SuperClaw` root that holds all component log
/// dirs. Honors `SUPERCLAW_APP_LOG_DIR` (whose parent is the SuperClaw root)
/// so tests / portable installs line up with the shell's own log dir logic.
fn resolve_superclaw_root() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("SUPERCLAW_APP_LOG_DIR") {
        let p = PathBuf::from(dir);
        if !p.as_os_str().is_empty() {
            // SUPERCLAW_APP_LOG_DIR points at `<root>\app`; its parent is root.
            return p.parent().map(Path::to_path_buf).or(Some(p));
        }
    }
    std::env::var("LOCALAPPDATA")
        .ok()
        .map(|local| PathBuf::from(local).join("SuperClaw"))
}

fn modified_ms(path: &Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Group `.log` files by their containing directory, then for each directory
/// take the newest 2 non-empty files. Returns them sorted newest-first overall.
fn select_recent_logs(root: &Path) -> Vec<PathBuf> {
    use std::collections::HashMap;

    let mut by_dir: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();

    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_log = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("log"))
            .unwrap_or(false);
        if !is_log {
            continue;
        }
        // Skip 0-byte files entirely — they carry no signal.
        let len = path.metadata().map(|m| m.len()).unwrap_or(0);
        if len == 0 {
            continue;
        }
        if let Some(dir) = path.parent() {
            by_dir
                .entry(dir.to_path_buf())
                .or_default()
                .push(path.to_path_buf());
        }
    }

    let mut selected: Vec<PathBuf> = Vec::new();
    for (_dir, mut files) in by_dir {
        // Newest first by mtime.
        files.sort_by(|a, b| modified_ms(b).cmp(&modified_ms(a)));
        for f in files.into_iter().take(2) {
            selected.push(f);
        }
    }
    // Newest-first overall for a stable, predictable preview order.
    selected.sort_by(|a, b| modified_ms(b).cmp(&modified_ms(a)));
    selected
}

fn read_tailed(path: &Path) -> std::io::Result<(String, bool)> {
    let bytes = std::fs::read(path)?;
    if bytes.len() <= LOG_TAIL_BYTES {
        return Ok((String::from_utf8_lossy(&bytes).into_owned(), false));
    }
    let tail = &bytes[bytes.len() - LOG_TAIL_BYTES..];
    Ok((String::from_utf8_lossy(tail).into_owned(), true))
}

/// Collect the newest ≤2 non-empty `.log` files per leaf log folder under the
/// SuperClaw root. Debug-only; the frontend gates the call behind
/// `__BUILD_DEBUG__`.
#[tauri::command]
pub fn collect_recent_logs() -> Result<Vec<CollectedLog>, String> {
    let root = resolve_superclaw_root()
        .ok_or_else(|| "Could not resolve %LOCALAPPDATA%\\SuperClaw log root".to_string())?;
    if !root.exists() {
        return Err(format!("Log root does not exist: {}", root.display()));
    }
    Ok(collect_from_root(&root))
}

/// Core of `collect_recent_logs`, split out so it can be tested against a
/// fixture directory without mutating process-wide environment variables.
fn collect_from_root(root: &Path) -> Vec<CollectedLog> {
    let mut out: Vec<CollectedLog> = Vec::new();
    for path in select_recent_logs(root) {
        let size_bytes = path.metadata().map(|m| m.len()).unwrap_or(0);
        let (content, truncated) = match read_tailed(&path) {
            Ok(v) => v,
            Err(e) => (format!("<failed to read: {e}>"), false),
        };
        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        out.push(CollectedLog {
            path: path.to_string_lossy().into_owned(),
            relative_path,
            size_bytes,
            modified_ms: modified_ms(&path),
            content,
            truncated,
        });
    }
    out
}

/// The absolute `%LOCALAPPDATA%\SuperClaw` log root, so the frontend can open
/// its file picker there by default. Returns `None` (serialized as `null`) when
/// it cannot be resolved.
#[tauri::command]
pub fn superclaw_log_root() -> Option<String> {
    resolve_superclaw_root().map(|p| p.to_string_lossy().into_owned())
}

/// Read a single user-picked log file into the same `CollectedLog` shape used
/// by `collect_recent_logs` (tailed content, size, relative path when the file
/// lives under the SuperClaw root). Rejects 0-byte files so the "skip empty"
/// rule holds for manual picks too. Debug-only.
#[tauri::command]
pub fn read_log_file(path: String) -> Result<CollectedLog, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_file() {
        return Err(format!("Not a file: {}", p.display()));
    }
    let size_bytes = p.metadata().map(|m| m.len()).unwrap_or(0);
    if size_bytes == 0 {
        return Err("File is empty (0 bytes) and was not added.".to_string());
    }
    let (content, truncated) = read_tailed(&p).map_err(|e| format!("Failed to read: {e}"))?;
    // Show a path relative to the SuperClaw root when the pick is under it,
    // otherwise fall back to the file's basename for a readable label.
    let relative_path = resolve_superclaw_root()
        .and_then(|root| p.strip_prefix(&root).ok().map(Path::to_path_buf))
        .map(|rel| rel.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            p.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| p.to_string_lossy().into_owned())
        });
    Ok(CollectedLog {
        path: p.to_string_lossy().into_owned(),
        relative_path,
        size_bytes,
        modified_ms: modified_ms(&p),
        content,
        truncated,
    })
}

/// Whether the `gh` CLI is available and authenticated on this machine. Used by
/// the frontend to decide between the programmatic path and the prefill-URL
/// fallback. `async` + `spawn_blocking`: `gh auth status` shells out and can be
/// slow, so it must not run on the main thread.
#[tauri::command]
pub async fn gh_available() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        let mut cmd = command_for_program(Path::new("gh"));
        cmd.arg("auth").arg("status");
        match cmd.output() {
            Ok(out) => out.status.success(),
            Err(_) => false,
        }
    })
    .await
    .unwrap_or(false)
}

/// One log file to upload as a gist, sent by the (already user-confirmed) UI.
#[derive(Debug, Clone, Deserialize)]
pub struct ReportBugFile {
    /// Flattened, gist-safe filename (e.g. `servicehub__logs__foo.log`).
    pub name: String,
    pub content: String,
}

fn run_gh(args: &[&str]) -> Result<String, String> {
    let mut cmd = command_for_program(Path::new("gh"));
    for a in args {
        cmd.arg(a);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run gh: {e} (is the GitHub CLI installed?)"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh {} failed: {}", args.join(" "), stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Upload the confirmed log files as a secret gist and return its URL. The
/// frontend then drops this URL into the GitHub "new issue" prefill page it
/// opens in the browser. Returns `None` when there are no files.
///
/// `async` + `spawn_blocking`: the `gh` subprocess is a blocking, multi-second
/// network call. A synchronous Tauri command runs on the main thread and would
/// freeze the window ("SuperClaw not responding"); running the blocking work on
/// the blocking thread pool keeps the UI responsive.
#[tauri::command]
pub async fn create_bug_gist(files: Vec<ReportBugFile>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || create_bug_gist_blocking(files))
        .await
        .map_err(|e| format!("gist task failed to run: {e}"))?
}

fn create_bug_gist_blocking(files: Vec<ReportBugFile>) -> Result<Option<String>, String> {
    if files.is_empty() {
        return Ok(None);
    }
    // Stage log files in a unique temp dir so `gh gist create` can pick them up
    // by real filenames (gist filenames come from the on-disk basename).
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp_dir = std::env::temp_dir().join(format!("superclaw-bug-logs-{stamp}"));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("Failed to create temp dir: {e}"))?;

    let mut staged: Vec<PathBuf> = Vec::new();
    for f in &files {
        // Guard against path separators sneaking into the filename.
        let safe = f.name.replace(['/', '\\'], "__");
        let file_path = tmp_dir.join(&safe);
        std::fs::write(&file_path, &f.content)
            .map_err(|e| format!("Failed to stage log {safe}: {e}"))?;
        staged.push(file_path);
    }

    let mut args: Vec<String> = vec![
        "gist".into(),
        "create".into(),
        "--desc".into(),
        format!("SuperClaw bug report logs ({} files)", staged.len()),
    ];
    for p in &staged {
        args.push(p.to_string_lossy().into_owned());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let url = run_gh(&arg_refs)?;

    // Best-effort cleanup; gist already captured the content.
    let _ = std::fs::remove_dir_all(&tmp_dir);

    Ok(url.lines().last().map(str::to_string).filter(|s| !s.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn selects_newest_two_non_empty_per_folder() {
        let tmp = std::env::temp_dir().join(format!(
            "superclaw-log-select-test-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let dir_a = tmp.join("app");
        // Three files, oldest→newest; only newest two should be picked.
        touch(&dir_a.join("tauri_1.log"), b"one");
        std::thread::sleep(std::time::Duration::from_millis(10));
        touch(&dir_a.join("tauri_2.log"), b"two");
        std::thread::sleep(std::time::Duration::from_millis(10));
        touch(&dir_a.join("tauri_3.log"), b"three");
        // A 0-byte file must be skipped even though it is the newest.
        std::thread::sleep(std::time::Duration::from_millis(10));
        touch(&dir_a.join("empty.log"), b"");

        // Separate leaf folder with a single file → contributes exactly one.
        let dir_b = tmp.join("servicehub").join("logs");
        touch(&dir_b.join("only.log"), b"solo");

        // Non-log file must be ignored.
        touch(&dir_b.join("notes.txt"), b"ignore me");

        let selected = select_recent_logs(&tmp);
        let names: Vec<String> = selected
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();

        assert!(names.contains(&"tauri_3.log".to_string()));
        assert!(names.contains(&"tauri_2.log".to_string()));
        assert!(!names.contains(&"tauri_1.log".to_string()));
        assert!(!names.contains(&"empty.log".to_string()));
        assert!(names.contains(&"only.log".to_string()));
        assert!(!names.contains(&"notes.txt".to_string()));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn collect_from_root_tails_large_files_and_sets_relative_paths() {
        let tmp = std::env::temp_dir().join(format!(
            "superclaw-log-collect-test-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let leaf = tmp.join("servicehub").join("logs");

        // Small file: kept whole, not truncated.
        touch(&leaf.join("small.log"), b"hello world");
        std::thread::sleep(std::time::Duration::from_millis(10));

        // Large file: > LOG_TAIL_BYTES → tailed to the last LOG_TAIL_BYTES.
        let big = vec![b'A'; LOG_TAIL_BYTES + 5000];
        touch(&leaf.join("big.log"), &big);

        let collected = collect_from_root(&tmp);
        assert_eq!(collected.len(), 2, "both files in the one leaf folder");

        let big_entry = collected
            .iter()
            .find(|c| c.relative_path.ends_with("big.log"))
            .expect("big.log present");
        assert!(big_entry.truncated, "large file should be tailed");
        assert_eq!(big_entry.content.len(), LOG_TAIL_BYTES);
        assert_eq!(big_entry.size_bytes, (LOG_TAIL_BYTES + 5000) as u64);
        // Relative path is under the root, using the OS separator.
        assert!(big_entry.relative_path.contains("servicehub"));
        assert!(big_entry.relative_path.contains("logs"));

        let small_entry = collected
            .iter()
            .find(|c| c.relative_path.ends_with("small.log"))
            .expect("small.log present");
        assert!(!small_entry.truncated);
        assert_eq!(small_entry.content, "hello world");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
