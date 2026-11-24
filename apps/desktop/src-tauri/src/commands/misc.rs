use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use crate::engine::doctor::resolve_engine_path;
use crate::paths::home_dir;
use crate::platform::command_for_program;
use crate::types::{ExecResult, WorkspaceOpenworkConfig};
use crate::workspace::state::load_workspace_state;
use tauri::{AppHandle, Manager, State};

#[derive(serde::Serialize)]
pub struct CacheResetResult {
    pub removed: Vec<String>,
    pub missing: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBuildInfo {
    pub version: String,
    pub git_sha: Option<String>,
    pub build_epoch: Option<String>,
    pub openwork_dev_mode: bool,
    pub channel: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFolderFile {
    pub name: String,
    pub relative_path: String,
    pub content: Vec<u8>,
}

fn env_truthy(key: &str) -> bool {
    matches!(
        std::env::var(key)
            .ok()
            .map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if value == "1" || value == "true" || value == "yes" || value == "on"
    )
}

fn opencode_cache_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(value) = std::env::var("XDG_CACHE_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            candidates.push(PathBuf::from(trimmed).join("opencode"));
        }
    }

    if let Some(home) = home_dir() {
        candidates.push(home.join(".cache").join("opencode"));

        #[cfg(target_os = "macos")]
        {
            candidates.push(home.join("Library").join("Caches").join("opencode"));
        }
    }

    #[cfg(windows)]
    {
        if let Ok(value) = std::env::var("LOCALAPPDATA") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                candidates.push(PathBuf::from(trimmed).join("opencode"));
            }
        }
        if let Ok(value) = std::env::var("APPDATA") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                candidates.push(PathBuf::from(trimmed).join("opencode"));
            }
        }
    }

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|path| seen.insert(path.to_string_lossy().to_string()))
        .collect()
}

fn validate_server_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("server_name is required".to_string());
    }

    if trimmed.starts_with('-') {
        return Err("server_name must not start with '-'".to_string());
    }

    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("server_name must be alphanumeric with '-' or '_'".to_string());
    }

    Ok(trimmed.to_string())
}

fn read_workspace_openwork_config(
    workspace_path: &Path,
) -> Result<WorkspaceOpenworkConfig, String> {
    let openwork_path = workspace_path.join(".opencode").join("openwork.json");
    if !openwork_path.exists() {
        let mut cfg = WorkspaceOpenworkConfig::default();
        let workspace_value = workspace_path.to_string_lossy().to_string();
        if !workspace_value.trim().is_empty() {
            cfg.authorized_roots.push(workspace_value);
        }
        return Ok(cfg);
    }

    let raw = fs::read_to_string(&openwork_path)
        .map_err(|e| format!("Failed to read {}: {e}", openwork_path.display()))?;

    serde_json::from_str::<WorkspaceOpenworkConfig>(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", openwork_path.display()))
}

fn load_authorized_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let state = load_workspace_state(app)?;
    let mut roots = Vec::new();

    for workspace in state.workspaces {
        let workspace_path = PathBuf::from(&workspace.path);
        let mut config = read_workspace_openwork_config(&workspace_path)?;

        if config.authorized_roots.is_empty() {
            config.authorized_roots.push(workspace.path.clone());
        }

        for root in config.authorized_roots {
            let trimmed = root.trim();
            if !trimmed.is_empty() {
                roots.push(PathBuf::from(trimmed));
            }
        }
    }

    if roots.is_empty() {
        return Err("No authorized roots configured".to_string());
    }

    Ok(roots)
}

fn validate_project_dir(app: &AppHandle, project_dir: &str) -> Result<PathBuf, String> {
    let trimmed = project_dir.trim();
    if trimmed.is_empty() {
        return Err("project_dir is required".to_string());
    }

    let project_path = PathBuf::from(trimmed);
    if !project_path.is_absolute() {
        return Err("project_dir must be an absolute path".to_string());
    }

    let canonical = fs::canonicalize(&project_path)
        .map_err(|e| format!("Failed to resolve project_dir: {e}"))?;

    if !canonical.is_dir() {
        return Err("project_dir must be a directory".to_string());
    }

    let roots = load_authorized_roots(app)?;
    let mut allowed = false;
    for root in roots {
        let Ok(root) = fs::canonicalize(&root) else {
            continue;
        };
        if canonical.starts_with(&root) {
            allowed = true;
            break;
        }
    }

    if !allowed {
        return Err("project_dir is not within an authorized root".to_string());
    }

    Ok(canonical)
}

fn resolve_opencode_program(
    app: &AppHandle,
    prefer_sidecar: bool,
    opencode_bin_path: Option<String>,
) -> Result<PathBuf, String> {
    if let Some(custom) = opencode_bin_path {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let resource_dir = app.path().resource_dir().ok();
    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));

    let (program, _in_path, notes) = resolve_engine_path(
        prefer_sidecar,
        resource_dir.as_deref(),
        current_bin_dir.as_deref(),
    );

    program.ok_or_else(|| {
        let notes_text = notes.join("\n");
        format!(
            "OpenCode CLI not found.\n\nInstall with:\n- brew install anomalyco/tap/opencode\n- curl -fsSL https://opencode.ai/install | bash\n\nNotes:\n{notes_text}"
        )
    })
}

#[tauri::command]
pub fn reset_opencode_cache() -> Result<CacheResetResult, String> {
    let candidates = opencode_cache_candidates();
    let mut removed = Vec::new();
    let mut missing = Vec::new();
    let mut errors = Vec::new();

    for path in candidates {
        if path.exists() {
            if let Err(err) = std::fs::remove_dir_all(&path) {
                errors.push(format!("Failed to remove {}: {err}", path.display()));
            } else {
                removed.push(path.to_string_lossy().to_string());
            }
        } else {
            missing.push(path.to_string_lossy().to_string());
        }
    }

    Ok(CacheResetResult {
        removed,
        missing,
        errors,
    })
}

#[tauri::command]
pub fn app_build_info(app: AppHandle) -> AppBuildInfo {
    let version = app.package_info().version.to_string();
    let git_sha = option_env!("OPENWORK_GIT_SHA").map(|value| value.to_string());
    let build_epoch = option_env!("OPENWORK_BUILD_EPOCH").map(|value| value.to_string());
    AppBuildInfo {
        version,
        git_sha,
        build_epoch,
        openwork_dev_mode: env_truthy("OPENWORK_DEV_MODE"),
        channel: crate::telemetry::release_channel(),
    }
}

#[tauri::command]
pub fn obsidian_is_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        let mut candidates = vec![PathBuf::from("/Applications/Obsidian.app")];
        if let Some(home) = home_dir() {
            candidates.push(home.join("Applications").join("Obsidian.app"));
        }
        return candidates.into_iter().any(|path| path.exists());
    }

    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[tauri::command]
pub fn open_in_obsidian(file_path: String) -> Result<(), String> {
    let trimmed = file_path.trim();
    println!("[misc][obsidian] open request path={trimmed}");
    if trimmed.is_empty() {
        println!("[misc][obsidian] rejected: empty path");
        return Err("file_path is required".to_string());
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        println!(
            "[misc][obsidian] rejected: non-absolute path={}",
            path.display()
        );
        return Err("file_path must be an absolute path".to_string());
    }
    if !path.exists() {
        println!(
            "[misc][obsidian] missing path={} cwd={}",
            path.display(),
            std::env::current_dir()
                .map(|dir| dir.display().to_string())
                .unwrap_or_else(|_| "(unknown)".to_string())
        );
        return Err(format!("File does not exist: {}", path.display()));
    }

    #[cfg(target_os = "macos")]
    {
        if !obsidian_is_available() {
            println!("[misc][obsidian] rejected: app not installed");
            return Err("Obsidian is not installed.".to_string());
        }

        println!("[misc][obsidian] launching path={}", path.display());
        let status = std::process::Command::new("open")
            .arg("-a")
            .arg("Obsidian")
            .arg(&path)
            .status()
            .map_err(|e| format!("Failed to launch Obsidian: {e}"))?;
        if status.success() {
            println!("[misc][obsidian] launch success path={}", path.display());
            return Ok(());
        }
        println!(
            "[misc][obsidian] launch failed path={} status={status}",
            path.display()
        );
        return Err(format!(
            "Failed to launch Obsidian (exit status: {status})."
        ));
    }

    #[cfg(not(target_os = "macos"))]
    {
        println!(
            "[misc][obsidian] unsupported platform request path={}",
            path.display()
        );
        Err("Open in Obsidian is currently supported on macOS only.".to_string())
    }
}

#[tauri::command]
pub fn open_in_file_explorer(path: String, reveal: Option<bool>) -> Result<(), String> {
    let trimmed = path.trim();
    println!("[info][misc][explorer] open request path={trimmed}");
    if trimmed.is_empty() {
        return Err("path is required".to_string());
    }

    let target = PathBuf::from(trimmed);
    if !target.is_absolute() {
        return Err("path must be an absolute path".to_string());
    }
    if !target.exists() {
        return Err(format!("Path does not exist: {}", target.display()));
    }

    #[cfg(target_os = "windows")]
    {
        let reveal = reveal.unwrap_or(false);
        println!(
            "[info][misc][explorer] launch intent path={} reveal={}",
            target.display(),
            reveal
        );
        let mut command = std::process::Command::new("explorer");
        if reveal {
            command.arg(format!("/select,{}", target.display()));
        } else {
            command.arg(&target);
        }
        command
            .spawn()
            .map_err(|e| format!("Failed to launch File Explorer: {e}"))?;
        println!(
            "[info][misc][explorer] launch success path={} reveal={}",
            target.display(),
            reveal
        );
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = reveal;
        Err("Open in File Explorer is currently supported on Windows only.".to_string())
    }
}

fn sanitize_obsidian_workspace_id(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut out = String::with_capacity(trimmed.len());
    let mut last_dash = false;
    for ch in trimmed.chars() {
        let normalized = if ch.is_ascii_alphanumeric() || ch == '_' {
            ch.to_ascii_lowercase()
        } else {
            '-'
        };

        if normalized == '-' {
            if last_dash {
                continue;
            }
            out.push('-');
            last_dash = true;
            continue;
        }

        out.push(normalized);
        last_dash = false;
    }

    out.trim_matches('-').to_string()
}

fn normalize_obsidian_mirror_relative_path(file_path: &str) -> Result<PathBuf, String> {
    let mut value = file_path.trim().replace('\\', "/");
    if value.is_empty() {
        return Err("file_path is required".to_string());
    }

    while let Some(stripped) = value.strip_prefix("./") {
        value = stripped.to_string();
    }

    if value.is_empty() {
        return Err("file_path is required".to_string());
    }

    let lower = value.to_ascii_lowercase();
    if lower.starts_with("workspace/") {
        value = value["workspace/".len()..].to_string();
    } else if lower.starts_with("/workspace/") {
        let without_leading_slash = value.trim_start_matches('/').to_string();
        if without_leading_slash
            .to_ascii_lowercase()
            .starts_with("workspace/")
        {
            value = without_leading_slash["workspace/".len()..].to_string();
        }
    }

    let bytes = value.as_bytes();
    let is_windows_abs =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';

    if value.starts_with('/') || value.starts_with('~') || is_windows_abs {
        return Err("file_path must be worker-relative".to_string());
    }

    let mut relative = PathBuf::new();
    for part in value.split('/').filter(|part| !part.is_empty()) {
        if part == "." || part == ".." {
            return Err("file_path must not contain '.' or '..' segments".to_string());
        }
        relative.push(part);
    }

    if relative.as_os_str().is_empty() {
        return Err("file_path is required".to_string());
    }

    Ok(relative)
}

fn resolve_obsidian_vault_path(vault_name: &str) -> Result<PathBuf, String> {
    let folder_name = vault_name.trim();
    if folder_name.is_empty() {
        return Err("Enter an Obsidian vault folder name.".to_string());
    }
    if folder_name == "."
        || folder_name == ".."
        || folder_name.contains('/')
        || folder_name.contains('\\')
    {
        return Err(
            "Enter only the Obsidian vault folder name, without /workspace.".to_string(),
        );
    }

    let home = std::env::var("USERPROFILE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(home_dir)
        .ok_or_else(|| "Unable to resolve the user profile directory.".to_string())?;
    let vault_path = home.join("SuperClawProjects").join(folder_name);
    if !vault_path.is_dir() {
        return Err(format!(
            "Obsidian vault \"{folder_name}\" was not found in %USERPROFILE%\\SuperClawProjects."
        ));
    }

    Ok(vault_path)
}

#[tauri::command]
pub fn validate_obsidian_vault(vault_name: String) -> Result<String, String> {
    resolve_obsidian_vault_path(&vault_name)?;
    Ok(format!("/workspace/{}", vault_name.trim()))
}

#[tauri::command]
pub fn write_obsidian_mirror_file(
    app: AppHandle,
    workspace_id: String,
    file_path: String,
    content: String,
) -> Result<String, String> {
    let workspace_trimmed = workspace_id.trim();
    if workspace_trimmed.is_empty() {
        return Err("workspace_id is required".to_string());
    }

    let workspace_key = sanitize_obsidian_workspace_id(workspace_trimmed);
    if workspace_key.is_empty() {
        return Err("workspace_id must contain at least one alphanumeric character".to_string());
    }

    let relative_path = normalize_obsidian_mirror_relative_path(&file_path)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    let mirror_root = app_data_dir.join("obsidian-mirror").join(workspace_key);
    let target = mirror_root.join(relative_path);

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    fs::write(&target, content.as_bytes())
        .map_err(|e| format!("Failed to write {}: {e}", target.display()))?;

    Ok(target.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailTemplateResult {
    pub path: String,
    pub created: bool,
}

#[tauri::command]
pub fn write_gmail_credentials_template(
    app: AppHandle,
    content: String,
) -> Result<GmailTemplateResult, String> {
    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("Failed to resolve downloads dir: {e}"))?;

    let target = downloads_dir.join("credentials_template.json");

    let created = if target.exists() {
        if !target.is_file() {
            return Err(format!(
                "Target path exists but is not a file: {}",
                target.display()
            ));
        }
        false
    } else {
        fs::write(&target, content.as_bytes())
            .map_err(|e| format!("Failed to write {}: {e}", target.display()))?;
        true
    };

    Ok(GmailTemplateResult {
        path: target.to_string_lossy().to_string(),
        created,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianMirrorFileContent {
    pub exists: bool,
    pub path: String,
    pub content: Option<String>,
    pub updated_at_ms: Option<u64>,
}

#[tauri::command]
pub fn read_obsidian_mirror_file(
    app: AppHandle,
    workspace_id: String,
    file_path: String,
) -> Result<ObsidianMirrorFileContent, String> {
    let workspace_trimmed = workspace_id.trim();
    if workspace_trimmed.is_empty() {
        return Err("workspace_id is required".to_string());
    }

    let workspace_key = sanitize_obsidian_workspace_id(workspace_trimmed);
    if workspace_key.is_empty() {
        return Err("workspace_id must contain at least one alphanumeric character".to_string());
    }

    let relative_path = normalize_obsidian_mirror_relative_path(&file_path)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    let mirror_root = app_data_dir.join("obsidian-mirror").join(workspace_key);
    let target = mirror_root.join(relative_path);
    let path_string = target.to_string_lossy().to_string();

    if !target.exists() {
        return Ok(ObsidianMirrorFileContent {
            exists: false,
            path: path_string,
            content: None,
            updated_at_ms: None,
        });
    }

    let metadata =
        fs::metadata(&target).map_err(|e| format!("Failed to stat {}: {e}", target.display()))?;
    if !metadata.is_file() {
        return Err(format!("Mirror path is not a file: {}", target.display()));
    }

    let content = fs::read_to_string(&target)
        .map_err(|e| format!("Failed to read {}: {e}", target.display()))?;
    let updated_at_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);

    Ok(ObsidianMirrorFileContent {
        exists: true,
        path: path_string,
        content: Some(content),
        updated_at_ms,
    })
}

#[tauri::command]
pub fn read_local_folder_files(folder_path: String) -> Result<Vec<LocalFolderFile>, String> {
    let root = PathBuf::from(folder_path.trim());
    if root.as_os_str().is_empty() {
        return Err("folder_path is required".to_string());
    }

    let root = root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve folder: {e}"))?;
    if !root.is_dir() {
        return Err(format!(
            "Folder path is not a directory: {}",
            root.display()
        ));
    }

    let mut files = Vec::new();
    let mut total_bytes: u64 = 0;
    for entry in walkdir::WalkDir::new(&root).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let relative = path
            .strip_prefix(&root)
            .map_err(|e| format!("Failed to compute relative path: {e}"))?;
        let relative_path = relative.to_string_lossy().replace('\\', "/");
        if relative_path.is_empty() {
            continue;
        }

        // This command holds every file's bytes in one Vec and serialises them
        // as a single IPC response; unbounded input aborts the shell with
        // 0xc0000409 (issue #809). Refuse instead — large folders go through
        // scan_local_folder + read_local_file_bytes.
        if files.len() >= 2_000 {
            return Err(
                "Folder has more than 2,000 files — too large to read in one call. \
                 Use the folder-import flow (scan_local_folder + read_local_file_bytes) instead."
                    .to_string(),
            );
        }

        // Check size via metadata BEFORE reading into memory, so a single very
        // large file can't make the shell allocate a huge buffer (or OOM)
        // before the cap triggers (Copilot review, #824).
        let file_size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if total_bytes + file_size > 256 * 1024 * 1024 {
            return Err(
                "Folder contents exceed 256 MB — too large to read in one call. \
                 Use the folder-import flow (scan_local_folder + read_local_file_bytes) instead."
                    .to_string(),
            );
        }
        total_bytes += file_size;

        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("file")
            .to_string();
        let mut file =
            fs::File::open(path).map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
        let mut content = Vec::new();
        file.read_to_end(&mut content)
            .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;

        files.push(LocalFolderFile {
            name,
            relative_path,
            content,
        });
    }

    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(files)
}

/// Directory names skipped by `scan_local_folder`: dependency/build output
/// that balloons folder imports. A source repo is ~25 MB / 1.6k files without
/// these and multi-GB / 100k+ files with them — reading the latter is what
/// crashed the shell (issue #809).
const FOLDER_SCAN_JUNK_DIRS: [&str; 9] = [
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    ".ruff_cache",
    ".pytest_cache",
];

/// Hard ceiling for a folder scan; past it the scan stops and reports
/// `truncated` so the UI can refuse gracefully.
const FOLDER_SCAN_MAX_FILES: usize = 20_000;

/// Per-file ceiling for `read_local_file_bytes` (one file per IPC call).
const FOLDER_IMPORT_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const SKILL_IMPORT_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const SKILL_SCAN_MAX_DISCOVERED_FILES: usize = 20_000;
const SKILL_SCAN_IGNORED_DIRS: [&str; 7] = [
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    ".ruff_cache",
    ".pytest_cache",
    ".mypy_cache",
];

/// Canonical paths of the exact files a prior `scan_local_folder` call
/// returned. `read_local_file_bytes` only serves a path in this set, so the
/// webview cannot use it as an arbitrary-file read primitive — and it cannot
/// reach files the scan deliberately excluded (junk dirs, or the tail past the
/// truncation limit), which a "under a scanned root" prefix check would have
/// let through (Copilot review, #824).
pub(crate) fn scanned_files() -> &'static std::sync::Mutex<HashSet<PathBuf>> {
    static FILES: std::sync::OnceLock<std::sync::Mutex<HashSet<PathBuf>>> =
        std::sync::OnceLock::new();
    FILES.get_or_init(|| std::sync::Mutex::new(HashSet::new()))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFolderScanEntry {
    pub name: String,
    pub relative_path: String,
    pub size: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFolderScan {
    pub root: String,
    pub entries: Vec<LocalFolderScanEntry>,
    pub total_bytes: u64,
    pub skipped_dirs: Vec<String>,
    pub truncated: bool,
}

/// Walk a folder and return file metadata only (no contents): the pre-flight
/// half of the folder-import flow. Junk directories are skipped and reported;
/// the scan stops at FOLDER_SCAN_MAX_FILES and reports `truncated`.
#[tauri::command]
pub fn scan_local_folder(folder_path: String) -> Result<LocalFolderScan, String> {
    let root = PathBuf::from(folder_path.trim());
    if root.as_os_str().is_empty() {
        return Err("folder_path is required".to_string());
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve folder: {e}"))?;
    if !root.is_dir() {
        return Err(format!(
            "Folder path is not a directory: {}",
            root.display()
        ));
    }

    let mut entries = Vec::new();
    let mut allowed_files: Vec<PathBuf> = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut skipped: HashSet<String> = HashSet::new();
    let mut truncated = false;

    let mut walker = walkdir::WalkDir::new(&root).follow_links(false).into_iter();
    while let Some(entry) = walker.next() {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                if FOLDER_SCAN_JUNK_DIRS.contains(&name) {
                    skipped.insert(name.to_string());
                    walker.skip_current_dir();
                }
            }
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if entries.len() >= FOLDER_SCAN_MAX_FILES {
            truncated = true;
            break;
        }

        let path = entry.path();
        let relative = path
            .strip_prefix(&root)
            .map_err(|e| format!("Failed to compute relative path: {e}"))?;
        let relative_path = relative.to_string_lossy().replace('\\', "/");
        if relative_path.is_empty() {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        total_bytes += size;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("file")
            .to_string();
        // Record the canonical path so read_local_file_bytes can later serve
        // exactly this file (and no other). canonicalize failure → don't record;
        // the read would fail anyway.
        if let Ok(canon) = path.canonicalize() {
            allowed_files.push(canon);
        }
        entries.push(LocalFolderScanEntry {
            name,
            relative_path,
            size,
        });
    }
    entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    if let Ok(mut files) = scanned_files().lock() {
        files.extend(allowed_files);
    }
    let mut skipped_dirs: Vec<String> = skipped.into_iter().collect();
    skipped_dirs.sort();

    Ok(LocalFolderScan {
        root: root.to_string_lossy().to_string(),
        entries,
        total_bytes,
        skipped_dirs,
        truncated,
    })
}

/// Skill-package scan used only by remote skill-folder import. Unlike the
/// generic folder scan, build/dist/target directories are valid resources.
#[tauri::command]
pub fn scan_skill_folder(folder_path: String) -> Result<LocalFolderScan, String> {
    let root = PathBuf::from(folder_path.trim());
    if root.as_os_str().is_empty() {
        return Err("folder_path is required".to_string());
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve folder: {e}"))?;
    if !root.is_dir() {
        return Err(format!(
            "Folder path is not a directory: {}",
            root.display()
        ));
    }

    let mut entries = Vec::new();
    let mut allowed_files = Vec::new();
    let mut total_bytes = 0_u64;
    let mut skipped = HashSet::new();
    let mut truncated = false;
    let mut walker = walkdir::WalkDir::new(&root).follow_links(false).into_iter();

    while let Some(entry) = walker.next() {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_dir() {
            if entry.path() != root {
                if let Some(name) = entry.file_name().to_str() {
                    if SKILL_SCAN_IGNORED_DIRS.contains(&name.to_ascii_lowercase().as_str()) {
                        let relative = entry
                            .path()
                            .strip_prefix(&root)
                            .map_err(|e| format!("Failed to compute relative path: {e}"))?;
                        skipped.insert(relative.to_string_lossy().replace('\\', "/"));
                        walker.skip_current_dir();
                    }
                }
            }
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if entries.len() >= SKILL_SCAN_MAX_DISCOVERED_FILES {
            truncated = true;
            break;
        }

        let path = entry.path();
        let relative = path
            .strip_prefix(&root)
            .map_err(|e| format!("Failed to compute relative path: {e}"))?;
        let relative_path = relative.to_string_lossy().replace('\\', "/");
        if relative_path.is_empty() {
            continue;
        }
        let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        total_bytes = total_bytes.saturating_add(size);
        if let Ok(canonical) = path.canonicalize() {
            allowed_files.push(canonical);
        }
        entries.push(LocalFolderScanEntry {
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("file")
                .to_string(),
            relative_path,
            size,
        });
    }

    entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    if let Ok(mut files) = scanned_files().lock() {
        files.extend(allowed_files);
    }
    let mut skipped_dirs: Vec<String> = skipped.into_iter().collect();
    skipped_dirs.sort();
    Ok(LocalFolderScan {
        root: root.to_string_lossy().to_string(),
        entries,
        total_bytes,
        skipped_dirs,
        truncated,
    })
}

/// Read ONE file's bytes: the streaming half of the folder-import flow. The
/// path must live under a root previously approved by `scan_local_folder`.
#[tauri::command]
pub fn read_local_file_bytes(file_path: String) -> Result<Vec<u8>, String> {
    let path = PathBuf::from(file_path.trim());
    if path.as_os_str().is_empty() {
        return Err("file_path is required".to_string());
    }
    let path = path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve file: {e}"))?;

    let allowed = scanned_files()
        .lock()
        .map(|files| files.contains(&path))
        .unwrap_or(false);
    if !allowed {
        return Err("File was not returned by a prior scan_local_folder call; \
             scan the folder first (the scan excludes junk dirs and the tail past its limit)."
            .to_string());
    }

    let meta =
        fs::metadata(&path).map_err(|e| format!("Failed to stat {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    if meta.len() > FOLDER_IMPORT_MAX_FILE_BYTES {
        return Err(format!(
            "File {} is {} MB — over the {} MB folder-import limit; skip it or copy it manually",
            path.display(),
            meta.len() / (1024 * 1024),
            FOLDER_IMPORT_MAX_FILE_BYTES / (1024 * 1024)
        ));
    }
    fs::read(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))
}

/// Read a bounded chunk from a file approved by a prior folder scan.
#[tauri::command]
pub fn read_local_file_chunk(
    file_path: String,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, String> {
    if length == 0 || length > SKILL_IMPORT_CHUNK_BYTES {
        return Err(format!(
            "length must be between 1 and {} bytes",
            SKILL_IMPORT_CHUNK_BYTES
        ));
    }
    let path = PathBuf::from(file_path.trim())
        .canonicalize()
        .map_err(|e| format!("Failed to resolve file: {e}"))?;
    let allowed = scanned_files()
        .lock()
        .map(|files| files.contains(&path))
        .unwrap_or(false);
    if !allowed {
        return Err("File was not returned by a prior folder scan".to_string());
    }
    let metadata = fs::metadata(&path)
        .map_err(|e| format!("Failed to stat {}: {e}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    if metadata.len() > FOLDER_IMPORT_MAX_FILE_BYTES {
        return Err(format!("File exceeds the 64 MiB skill import limit: {}", path.display()));
    }
    if offset >= metadata.len() {
        return Err("offset must be less than file size".to_string());
    }

    let read_length = std::cmp::min(length as u64, metadata.len() - offset) as usize;
    let mut file = fs::File::open(&path)
        .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("Failed to seek {}: {e}", path.display()))?;
    let mut bytes = vec![0_u8; read_length];
    file.read_exact(&mut bytes)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    Ok(bytes)
}

/// Mirrors the composer's supported image formats.
const DROPPED_IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// Matches the composer's 8 MB attachment limit.
const DROPPED_IMAGE_MAX_BYTES: u64 = 8 * 1024 * 1024;

const DROPPED_IMAGE_GRANT_TTL: std::time::Duration = std::time::Duration::from_secs(30);

const DROPPED_IMAGE_NOT_AUTHORIZED: &str =
    "File was not authorized by a recent drag-drop event";

fn has_dropped_image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .is_some_and(|ext| DROPPED_IMAGE_EXTENSIONS.contains(&ext.as_str()))
}

struct DroppedFileGrant {
    expires_at: std::time::Instant,
    remaining_reads: usize,
}

/// Short-lived, single-use grants for canonical paths from native drops.
fn dropped_files() -> &'static std::sync::Mutex<HashMap<PathBuf, DroppedFileGrant>> {
    static FILES: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, DroppedFileGrant>>> =
        std::sync::OnceLock::new();
    FILES.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn dropped_file_candidates() -> &'static std::sync::Mutex<HashMap<PathBuf, DroppedFileGrant>> {
    static FILES: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, DroppedFileGrant>>> =
        std::sync::OnceLock::new();
    FILES.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn composer_dropped_files() -> &'static std::sync::Mutex<HashMap<PathBuf, DroppedFileGrant>> {
    static FILES: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, DroppedFileGrant>>> =
        std::sync::OnceLock::new();
    FILES.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Add short-lived read grants for files from a native drop.
pub fn record_dropped_files(paths: &[PathBuf]) {
    let canon: HashSet<PathBuf> = paths
        .iter()
        .filter_map(|path| path.canonicalize().ok())
        .collect();
    if let Ok(mut candidates) = dropped_file_candidates().lock() {
        let now = std::time::Instant::now();
        candidates.retain(|_, grant| grant.expires_at > now);
        let expires_at = now + DROPPED_IMAGE_GRANT_TTL;
        for path in canon {
            candidates
                .entry(path)
                .and_modify(|grant| {
                    grant.expires_at = expires_at;
                    grant.remaining_reads = grant.remaining_reads.saturating_add(1);
                })
                .or_insert(DroppedFileGrant {
                    expires_at,
                    remaining_reads: 1,
                });
        }
    }
}

/// Promote paths from the latest native drop after the composer confirms that
/// the pointer landed inside its drop target.
#[tauri::command]
pub fn authorize_composer_dropped_files(file_paths: Vec<String>) -> Result<(), String> {
    let canonical_paths: Vec<PathBuf> = file_paths
        .iter()
        .map(|file_path| {
            let path = PathBuf::from(file_path.trim());
            if path.as_os_str().is_empty() {
                return Err(DROPPED_IMAGE_NOT_AUTHORIZED.to_string());
            }
            path.canonicalize()
                .map_err(|_| DROPPED_IMAGE_NOT_AUTHORIZED.to_string())
        })
        .collect::<Result<_, _>>()?;
    let now = std::time::Instant::now();
    {
        let mut candidates = dropped_file_candidates()
            .lock()
            .map_err(|_| "Failed to authorize composer drop".to_string())?;
        candidates.retain(|_, grant| grant.expires_at > now);
        for path in &canonical_paths {
            let remove_candidate = match candidates.get_mut(path) {
                Some(grant) if grant.remaining_reads > 0 => {
                    grant.remaining_reads -= 1;
                    grant.remaining_reads == 0
                }
                _ => return Err(DROPPED_IMAGE_NOT_AUTHORIZED.to_string()),
            };
            if remove_candidate {
                candidates.remove(path);
            }
        }
    }
    let expires_at = now + DROPPED_IMAGE_GRANT_TTL;
    let mut image_files = dropped_files()
        .lock()
        .map_err(|_| "Failed to authorize composer drop".to_string())?;
    image_files.retain(|_, grant| grant.expires_at > now);
    let mut generic_files = composer_dropped_files()
        .lock()
        .map_err(|_| "Failed to authorize composer drop".to_string())?;
    generic_files.retain(|_, grant| grant.expires_at > now);
    for path in canonical_paths {
        let files = if has_dropped_image_extension(&path) {
            &mut image_files
        } else {
            &mut generic_files
        };
        files
            .entry(path)
            .and_modify(|grant| {
                grant.expires_at = expires_at;
                grant.remaining_reads = grant.remaining_reads.saturating_add(1);
            })
            .or_insert(DroppedFileGrant {
                expires_at,
                remaining_reads: 1,
            });
    }
    Ok(())
}

/// Read one image authorized by a recent native drop event.
#[tauri::command]
pub fn read_dropped_image(file_path: String) -> Result<Vec<u8>, String> {
    let path = PathBuf::from(file_path.trim());
    if path.as_os_str().is_empty() {
        return Err("file_path is required".to_string());
    }
    let path = path
        .canonicalize()
        .map_err(|_| DROPPED_IMAGE_NOT_AUTHORIZED.to_string())?;
    let allowed = dropped_files().lock().map_or(false, |mut files| {
        let now = std::time::Instant::now();
        files.retain(|_, grant| grant.expires_at > now);
        let mut remove_grant = false;
        let allowed = match files.get_mut(&path) {
            Some(grant) => {
                grant.remaining_reads -= 1;
                remove_grant = grant.remaining_reads == 0;
                true
            }
            None => false,
        };
        if remove_grant {
            files.remove(&path);
        }
        allowed
    });
    if !allowed {
        return Err(DROPPED_IMAGE_NOT_AUTHORIZED.to_string());
    }
    if !has_dropped_image_extension(&path) {
        return Err("Unsupported image type".to_string());
    }
    let file = fs::File::open(&path)
        .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Failed to stat {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    if meta.len() > DROPPED_IMAGE_MAX_BYTES {
        return Err(format!(
            "Image {} is {} bytes, over the {} byte drag-drop limit",
            path.display(),
            meta.len(),
            DROPPED_IMAGE_MAX_BYTES
        ));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(DROPPED_IMAGE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    if bytes.len() as u64 > DROPPED_IMAGE_MAX_BYTES {
        return Err(format!(
            "Image {} exceeds the {} byte drag-drop limit",
            path.display(),
            DROPPED_IMAGE_MAX_BYTES
        ));
    }
    Ok(bytes)
}

/// Read one non-image file authorized by a recent native drop event.
#[tauri::command]
pub fn read_dropped_file(file_path: String) -> Result<Vec<u8>, String> {
    let path = PathBuf::from(file_path.trim());
    if path.as_os_str().is_empty() {
        return Err("file_path is required".to_string());
    }
    let path = path
        .canonicalize()
        .map_err(|_| DROPPED_IMAGE_NOT_AUTHORIZED.to_string())?;
    let allowed = composer_dropped_files().lock().map_or(false, |mut files| {
        let now = std::time::Instant::now();
        files.retain(|_, grant| grant.expires_at > now);
        let mut remove_grant = false;
        let allowed = match files.get_mut(&path) {
            Some(grant) => {
                grant.remaining_reads -= 1;
                remove_grant = grant.remaining_reads == 0;
                true
            }
            None => false,
        };
        if remove_grant {
            files.remove(&path);
        }
        allowed
    });
    if !allowed {
        return Err(DROPPED_IMAGE_NOT_AUTHORIZED.to_string());
    }
    if has_dropped_image_extension(&path) {
        return Err("Use read_dropped_image for image files".to_string());
    }
    let file = fs::File::open(&path)
        .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Failed to stat {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    if meta.len() > DROPPED_IMAGE_MAX_BYTES {
        return Err(format!(
            "File {} is {} bytes, over the {} byte drag-drop limit",
            path.display(),
            meta.len(),
            DROPPED_IMAGE_MAX_BYTES
        ));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(DROPPED_IMAGE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    if bytes.len() as u64 > DROPPED_IMAGE_MAX_BYTES {
        return Err(format!(
            "File {} exceeds the {} byte drag-drop limit",
            path.display(),
            DROPPED_IMAGE_MAX_BYTES
        ));
    }
    Ok(bytes)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadWorkspaceFileResult {
    pub ok: bool,
    pub content: Option<String>,
    pub error: Option<String>,
}

/// Read a text file from the filesystem given an absolute path.
/// Only allows reading from within a workspace root for safety.
#[tauri::command]
pub fn read_workspace_file(file_path: String, workspace_root: String) -> ReadWorkspaceFileResult {
    let file_trimmed = file_path.trim();
    let root_trimmed = workspace_root.trim();

    if file_trimmed.is_empty() {
        return ReadWorkspaceFileResult {
            ok: false,
            content: None,
            error: Some("file_path is required".to_string()),
        };
    }
    if root_trimmed.is_empty() {
        return ReadWorkspaceFileResult {
            ok: false,
            content: None,
            error: Some("workspace_root is required".to_string()),
        };
    }

    let target = std::path::Path::new(file_trimmed);
    let root = std::path::Path::new(root_trimmed);

    // Before canonicalize: a nested root such as `SuperClawProjects\sensitive`
    // may itself be a planted junction, which canonicalize would follow (#3666).
    if let Err(error) = super::reparse::reject_reparse_under_projects_root(target) {
        return ReadWorkspaceFileResult {
            ok: false,
            content: None,
            error: Some(error),
        };
    }

    // Canonicalize both paths to prevent path traversal
    let canonical_root = match root.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            return ReadWorkspaceFileResult {
                ok: false,
                content: None,
                error: Some(format!("Invalid workspace root: {e}")),
            };
        }
    };
    let canonical_target = match target.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            return ReadWorkspaceFileResult {
                ok: false,
                content: None,
                error: Some(format!("File not found: {e}")),
            };
        }
    };

    if !canonical_target.starts_with(&canonical_root) {
        return ReadWorkspaceFileResult {
            ok: false,
            content: None,
            error: Some("File path is outside workspace root".to_string()),
        };
    }

    match fs::read_to_string(&canonical_target) {
        Ok(content) => ReadWorkspaceFileResult {
            ok: true,
            content: Some(content),
            error: None,
        },
        Err(e) => ReadWorkspaceFileResult {
            ok: false,
            content: None,
            error: Some(format!("Failed to read file: {e}")),
        },
    }
}

/// Read a binary file from the filesystem and return it as a base64-encoded string.
#[tauri::command]
pub fn read_workspace_file_base64(
    file_path: String,
    workspace_root: String,
) -> ReadWorkspaceFileResult {
    use base64::{engine::general_purpose, Engine as _};

    let file_trimmed = file_path.trim();
    let root_trimmed = workspace_root.trim();

    if file_trimmed.is_empty() {
        return ReadWorkspaceFileResult {
            ok: false,
            content: None,
            error: Some("file_path is required".to_string()),
        };
    }
    if root_trimmed.is_empty() {
        return ReadWorkspaceFileResult {
            ok: false,
            content: None,
            error: Some("workspace_root is required".to_string()),
        };
    }

    let target = std::path::Path::new(file_trimmed);
    let root = std::path::Path::new(root_trimmed);

    // See read_workspace_file: refuse a planted junction before canonicalize (#3666).
    if let Err(error) = super::reparse::reject_reparse_under_projects_root(target) {
        return ReadWorkspaceFileResult {
            ok: false,
            content: None,
            error: Some(error),
        };
    }

    let canonical_root = match root.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            return ReadWorkspaceFileResult {
                ok: false,
                content: None,
                error: Some(format!("Invalid workspace root: {e}")),
            };
        }
    };
    let canonical_target = match target.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            return ReadWorkspaceFileResult {
                ok: false,
                content: None,
                error: Some(format!("File not found: {e}")),
            };
        }
    };

    if !canonical_target.starts_with(&canonical_root) {
        return ReadWorkspaceFileResult {
            ok: false,
            content: None,
            error: Some("File path is outside workspace root".to_string()),
        };
    }

    match fs::read(&canonical_target) {
        Ok(bytes) => ReadWorkspaceFileResult {
            ok: true,
            content: Some(general_purpose::STANDARD.encode(&bytes)),
            error: None,
        },
        Err(e) => ReadWorkspaceFileResult {
            ok: false,
            content: None,
            error: Some(format!("Failed to read file: {e}")),
        },
    }
}

/// Check whether a file exists within a workspace root.
/// Cheaper than `read_workspace_file` — only canonicalizes + checks existence,
/// never reads file content.  Used by the artifacts panel to verify file lists.
#[tauri::command]
pub fn workspace_file_exists(file_path: String, workspace_root: String) -> bool {
    let file_trimmed = file_path.trim();
    let root_trimmed = workspace_root.trim();

    if file_trimmed.is_empty() || root_trimmed.is_empty() {
        return false;
    }

    let target = std::path::Path::new(file_trimmed);
    let root = std::path::Path::new(root_trimmed);

    // See read_workspace_file: refuse a planted junction before canonicalize (#3666).
    if super::reparse::reject_reparse_under_projects_root(target).is_err() {
        return false;
    }

    let canonical_root = match root.canonicalize() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let canonical_target = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => return false,
    };

    canonical_target.starts_with(&canonical_root) && canonical_target.exists()
}

#[cfg(test)]
mod tests {
    use super::{
        authorize_composer_dropped_files, dropped_files,
        normalize_obsidian_mirror_relative_path, read_dropped_file, read_dropped_image,
        record_dropped_files, sanitize_obsidian_workspace_id, DROPPED_IMAGE_MAX_BYTES,
        DROPPED_IMAGE_NOT_AUTHORIZED,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    fn dropped_image_test_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .expect("lock dropped-image tests")
    }

    fn authorize_drop(path: &std::path::Path) {
        authorize_composer_dropped_files(vec![path.to_string_lossy().into_owned()])
            .expect("composer should promote the observed drop");
    }

    #[test]
    fn sanitize_workspace_id_collapses_separators() {
        let out = sanitize_obsidian_workspace_id(" Team Alpha / Worker #1 ");
        assert_eq!(out, "team-alpha-worker-1");
    }

    #[test]
    fn normalize_mirror_path_strips_workspace_prefixes() {
        // The function returns a `PathBuf` built with `push`, so its separator
        // is platform-native (`\` on Windows, `/` elsewhere). Compare against a
        // `PathBuf` built the same way rather than a hard-coded `/` string, so
        // the assertion holds on every platform.
        let expected: PathBuf = ["notes", "plan.md"].iter().collect();

        let path = normalize_obsidian_mirror_relative_path("/workspace/notes/plan.md")
            .expect("path should normalize");
        assert_eq!(path, expected);

        let path = normalize_obsidian_mirror_relative_path("workspace/notes/plan.md")
            .expect("path should normalize");
        assert_eq!(path, expected);
    }

    #[test]
    fn normalize_mirror_path_rejects_parent_segments() {
        let err = normalize_obsidian_mirror_relative_path("notes/../secret.md")
            .expect_err("parent segments should be rejected");
        assert!(err.contains("must not contain"));
    }

    #[test]
    fn normalize_mirror_path_rejects_absolute_paths() {
        let err = normalize_obsidian_mirror_relative_path("/etc/passwd")
            .expect_err("absolute path should be rejected");
        assert!(err.contains("worker-relative"));
    }

    #[test]
    fn dropped_image_authorization_is_single_use() {
        let _guard = dropped_image_test_lock();
        let path = std::env::temp_dir().join(format!("superclaw-drop-{}.png", uuid::Uuid::new_v4()));
        fs::write(&path, b"image bytes").expect("write dropped-image fixture");
        record_dropped_files(std::slice::from_ref(&path));
        assert_eq!(
            read_dropped_image(path.to_string_lossy().into_owned())
                .expect_err("window drop alone must not authorize image reads"),
            DROPPED_IMAGE_NOT_AUTHORIZED,
        );
        authorize_drop(&path);

        assert_eq!(
            read_dropped_image(path.to_string_lossy().into_owned())
                .expect("first read should be authorized"),
            b"image bytes",
        );
        let unauthorized = read_dropped_image(path.to_string_lossy().into_owned())
            .expect_err("second read should be denied");

        fs::remove_file(&path).expect("remove dropped-image fixture");

        let missing = read_dropped_image(path.to_string_lossy().into_owned())
            .expect_err("missing path should be denied");
        assert_eq!(missing, unauthorized);
    }

    #[test]
    fn dropped_file_authorization_is_single_use() {
        let _guard = dropped_image_test_lock();
        let path = std::env::temp_dir().join(format!("superclaw-drop-{}.pdf", uuid::Uuid::new_v4()));
        fs::write(&path, b"pdf bytes").expect("write dropped-file fixture");
        record_dropped_files(std::slice::from_ref(&path));

        assert_eq!(
            read_dropped_file(path.to_string_lossy().into_owned())
                .expect_err("window drop alone must not authorize generic reads"),
            DROPPED_IMAGE_NOT_AUTHORIZED,
        );
        authorize_composer_dropped_files(vec![path.to_string_lossy().into_owned()])
            .expect("composer should promote the observed drop");
        assert_eq!(
            read_dropped_file(path.to_string_lossy().into_owned())
                .expect("first read should be authorized"),
            b"pdf bytes",
        );
        assert_eq!(
            read_dropped_file(path.to_string_lossy().into_owned())
                .expect_err("second read should be denied"),
            DROPPED_IMAGE_NOT_AUTHORIZED,
        );
        fs::remove_file(path).expect("remove dropped-file fixture");
    }

    #[test]
    fn overlapping_drops_keep_each_batch_authorized() {
        let _guard = dropped_image_test_lock();
        let first = std::env::temp_dir().join(format!("superclaw-drop-{}.png", uuid::Uuid::new_v4()));
        let second = std::env::temp_dir().join(format!("superclaw-drop-{}.png", uuid::Uuid::new_v4()));
        fs::write(&first, b"first").expect("write first dropped-image fixture");
        fs::write(&second, b"second").expect("write second dropped-image fixture");

        record_dropped_files(std::slice::from_ref(&first));
        record_dropped_files(std::slice::from_ref(&second));
        authorize_drop(&first);
        authorize_drop(&second);

        assert_eq!(
            read_dropped_image(first.to_string_lossy().into_owned())
                .expect("first drop should remain authorized"),
            b"first",
        );
        assert_eq!(
            read_dropped_image(second.to_string_lossy().into_owned())
                .expect("second drop should be authorized"),
            b"second",
        );
        fs::remove_file(first).expect("remove first dropped-image fixture");
        fs::remove_file(second).expect("remove second dropped-image fixture");
    }

    #[test]
    fn repeated_path_drops_keep_each_batch_authorized() {
        let _guard = dropped_image_test_lock();
        let path = std::env::temp_dir().join(format!("superclaw-drop-{}.png", uuid::Uuid::new_v4()));
        fs::write(&path, b"same image").expect("write repeated dropped-image fixture");

        record_dropped_files(std::slice::from_ref(&path));
        record_dropped_files(std::slice::from_ref(&path));
        authorize_drop(&path);
        authorize_drop(&path);

        assert_eq!(
            read_dropped_image(path.to_string_lossy().into_owned())
                .expect("first repeated drop should be authorized"),
            b"same image",
        );
        assert_eq!(
            read_dropped_image(path.to_string_lossy().into_owned())
                .expect("second repeated drop should be authorized"),
            b"same image",
        );
        fs::remove_file(path).expect("remove repeated dropped-image fixture");
    }

    #[test]
    fn dropped_image_grants_expire() {
        let _guard = dropped_image_test_lock();
        let path = std::env::temp_dir().join(format!("superclaw-drop-{}.png", uuid::Uuid::new_v4()));
        fs::write(&path, b"image bytes").expect("write dropped-image fixture");
        record_dropped_files(std::slice::from_ref(&path));
        authorize_drop(&path);

        let canonical_path = path.canonicalize().expect("canonicalize fixture");
        dropped_files()
            .lock()
            .expect("lock dropped-image grants")
            .get_mut(&canonical_path)
            .expect("find dropped-image grant")
            .expires_at = std::time::Instant::now();

        assert_eq!(
            read_dropped_image(path.to_string_lossy().into_owned())
                .expect_err("expired grant should be denied"),
            DROPPED_IMAGE_NOT_AUTHORIZED,
        );
        fs::remove_file(path).expect("remove dropped-image fixture");
    }

    #[test]
    fn dropped_image_size_error_reports_exact_bytes() {
        let _guard = dropped_image_test_lock();
        let path = std::env::temp_dir().join(format!("superclaw-drop-{}.png", uuid::Uuid::new_v4()));
        let oversized_bytes = DROPPED_IMAGE_MAX_BYTES + 512 * 1024;
        let file = fs::File::create(&path).expect("create dropped-image fixture");
        file.set_len(oversized_bytes)
            .expect("resize dropped-image fixture");
        drop(file);
        record_dropped_files(std::slice::from_ref(&path));
        authorize_drop(&path);

        let error = read_dropped_image(path.to_string_lossy().into_owned())
            .expect_err("oversized image should be denied");

        assert!(error.contains(&format!("{oversized_bytes} bytes")));
        assert!(!error.contains("is 8 MB"));
        fs::remove_file(path).expect("remove dropped-image fixture");
    }
}

#[tauri::command]
pub fn opencode_db_migrate(
    app: AppHandle,
    project_dir: String,
    prefer_sidecar: Option<bool>,
    opencode_bin_path: Option<String>,
) -> Result<ExecResult, String> {
    let project_dir = validate_project_dir(&app, &project_dir)?;
    let program =
        resolve_opencode_program(&app, prefer_sidecar.unwrap_or(false), opencode_bin_path)?;

    let mut command = command_for_program(&program);
    for (key, value) in crate::bun_env::bun_env_overrides() {
        command.env(key, value);
    }

    let output = command
        .arg("db")
        .arg("migrate")
        .current_dir(&project_dir)
        .output()
        .map_err(|e| format!("Failed to run opencode db migrate: {e}"))?;

    let status = output.status.code().unwrap_or(-1);
    Ok(ExecResult {
        ok: output.status.success(),
        status,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

/// Run `opencode mcp auth <server_name>` in the given project directory.
/// This spawns the process detached so the OAuth flow can open a browser.
#[tauri::command]
pub fn opencode_mcp_auth(
    app: AppHandle,
    project_dir: String,
    server_name: String,
) -> Result<ExecResult, String> {
    let project_dir = validate_project_dir(&app, &project_dir)?;
    let server_name = validate_server_name(&server_name)?;

    let program = resolve_opencode_program(&app, true, None)?;

    let mut command = command_for_program(&program);
    for (key, value) in crate::bun_env::bun_env_overrides() {
        command.env(key, value);
    }

    let output = command
        .arg("mcp")
        .arg("auth")
        .arg(server_name)
        .current_dir(&project_dir)
        .output()
        .map_err(|e| format!("Failed to run opencode mcp auth: {e}"))?;

    let status = output.status.code().unwrap_or(-1);
    Ok(ExecResult {
        ok: output.status.success(),
        status,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

#[tauri::command]
pub fn read_env_var(name: String) -> Result<Option<String>, String> {
    if !name.starts_with("SUPERCLAW_") {
        return Err(format!(
            "Access denied: only SUPERCLAW_* environment variables are allowed, got '{name}'"
        ));
    }
    Ok(std::env::var(name).ok())
}

pub const MCP_OAUTH_CALLBACK_EVENT: &str = "mcp://oauth-callback";

/// Shared cancel flag for the MCP OAuth callback listener.
/// Calling `stop_mcp_oauth_listener` sets this to `true`, which causes the
/// background accept-loop in `start_mcp_oauth_listener` to exit promptly,
/// releasing port 19876 so a new OAuth flow can bind it immediately.
#[derive(Default)]
pub struct McpOauthListenerCancel(pub Arc<Mutex<Option<Arc<AtomicBool>>>>);

const MCP_OAUTH_SUCCESS_HTML: &str = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Authorization Successful</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#eee}h1{color:#4ade80;margin-bottom:.5rem}p{color:#aaa}</style></head><body><div style=\"text-align:center\"><h1>Authorization Successful</h1><p>You can close this window and return to SuperClaw.</p></div><script>setTimeout(function(){window.close()},1500)</script></body></html>";

const MCP_OAUTH_FAILED_HTML: &str = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Authorization Failed</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#eee}h1{color:#f87171;margin-bottom:.5rem}p{color:#aaa}</style></head><body><div style=\"text-align:center\"><h1>Authorization Failed</h1><p>Return to SuperClaw and try again.</p></div></body></html>";

// The agent (and opencode's own OAuth callback server) runs inside the sandbox,
// but the OAuth redirect targets http://127.0.0.1:<port><path> on the Windows host
// where the browser runs. Catch that redirect here on the host, then forward the
// full callback URL to the frontend, which completes the exchange via opencode's
// mcp.auth.callback API. Binding before opencode starts its own callback server
// also makes opencode skip it (isPortInUse).
#[tauri::command]
pub fn start_mcp_oauth_listener(
    app: AppHandle,
    cancel_state: State<McpOauthListenerCancel>,
    port: u16,
    callback_path: String,
    timeout_secs: u64,
) -> Result<(), String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("bind 127.0.0.1:{port} failed: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut guard = cancel_state.0.lock().map_err(|e| e.to_string())?;
        *guard = Some(Arc::clone(&cancel));
    }

    std::thread::spawn(move || {
        use tauri::Emitter;
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs.max(1));
        loop {
            if cancel.load(Ordering::SeqCst) || std::time::Instant::now() >= deadline {
                break;
            }
            match listener.accept() {
                Ok((mut stream, _addr)) => {
                    if let Some(url) = read_mcp_oauth_callback(&mut stream, port, &callback_path) {
                        let _ = app.emit(MCP_OAUTH_CALLBACK_EVENT, url);
                        break;
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_mcp_oauth_listener(cancel_state: State<McpOauthListenerCancel>) -> Result<(), String> {
    let guard = cancel_state.0.lock().map_err(|e| e.to_string())?;
    if let Some(cancel) = guard.as_ref() {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

fn read_mcp_oauth_callback(
    stream: &mut std::net::TcpStream,
    port: u16,
    callback_path: &str,
) -> Option<String> {
    use std::io::Write;

    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .ok();
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).ok()?;
    if n == 0 {
        return None;
    }
    let request = String::from_utf8_lossy(&buf[..n]);
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))?;
    let path = target.split('?').next().unwrap_or(target);
    if path != callback_path {
        let response =
            "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot found";
        let _ = stream.write_all(response.as_bytes());
        return None;
    }
    let has_error = target
        .split_once('?')
        .map(|(_, query)| query.split('&').any(|kv| kv.starts_with("error=")))
        .unwrap_or(false);
    let body = if has_error {
        MCP_OAUTH_FAILED_HTML
    } else {
        MCP_OAUTH_SUCCESS_HTML
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    Some(format!("http://127.0.0.1:{port}{target}"))
}

/// The workspace readers refuse a junction that leads outside the root (#3666).
#[cfg(all(test, windows))]
mod reparse_tests {
    use super::{read_workspace_file, read_workspace_file_base64, workspace_file_exists};
    use crate::commands::reparse::test_support::{junction, layout};

    #[test]
    fn workspace_readers_refuse_junction_outside_root() {
        let (root, outside) = layout();
        std::fs::write(outside.join("secret.txt"), "owner data").unwrap();
        junction(&root.join("planted"), &outside);
        let file = root.join("planted").join("secret.txt");
        let file = file.to_string_lossy().into_owned();
        let root = root.to_string_lossy().into_owned();
        assert!(!read_workspace_file(file.clone(), root.clone()).ok);
        assert!(!read_workspace_file_base64(file.clone(), root.clone()).ok);
        assert!(!workspace_file_exists(file, root));
    }

    #[test]
    fn workspace_readers_read_real_file() {
        let (root, _) = layout();
        std::fs::write(root.join("a.txt"), "hello").unwrap();
        let file = root.join("a.txt").to_string_lossy().into_owned();
        let root = root.to_string_lossy().into_owned();
        let read = read_workspace_file(file.clone(), root.clone());
        assert_eq!(read.content.as_deref(), Some("hello"));
        assert!(workspace_file_exists(file, root));
    }
}
