use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::reparse::reject_reparse_under_projects_root;
use crate::types::{
    ExecResult, RemoteType, WorkspaceInfo, WorkspaceList, WorkspaceOpenworkConfig, WorkspaceType,
};
use crate::workspace::files::ensure_workspace_files;
use crate::workspace::state::{
    load_workspace_state, remove_legacy_starter_workspace, remove_retired_docker_workspaces,
    resolve_container_path, save_workspace_state, stable_workspace_id,
    stable_workspace_id_for_openwork, stable_workspace_id_for_remote,
};
use crate::workspace::watch::{update_workspace_watch, WorkspaceWatchState};
use serde::Serialize;
use tauri::State;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

#[tauri::command(async)]
pub fn workspace_bootstrap(
    app: tauri::AppHandle,
    watch_state: State<WorkspaceWatchState>,
) -> Result<WorkspaceList, String> {
    tracing::info!(
        boot_id = %crate::logging::boot_id(),
        component = "workspace",
        stage = "bootstrap",
        "bootstrap"
    );
    let mut state = load_workspace_state(&app)?;

    // One-time cleanup for pre-existing installs: this app no longer
    // auto-creates the local "Starter" workspace, so any leftover registered
    // entry (with a stale, never-refreshed .opencode folder) is deregistered
    // and deleted here rather than migrated. No-op once already cleaned up.
    remove_legacy_starter_workspace(&app, &mut state)?;

    // Workspaces of the retired Docker sandbox backend point at a container
    // that no longer exists; deregister them the same way.
    remove_retired_docker_workspaces(&mut state);

    if !state.workspaces.iter().any(|w| w.id == state.active_id) {
        state.active_id = state
            .workspaces
            .first()
            .map(|entry| entry.id.clone())
            .unwrap_or_else(|| "".to_string());
    }

    save_workspace_state(&app, &state)?;
    let active_workspace = state.workspaces.iter().find(|w| w.id == state.active_id);
    update_workspace_watch(&app, watch_state, active_workspace)?;

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_forget(
    app: tauri::AppHandle,
    workspace_id: String,
    watch_state: State<WorkspaceWatchState>,
) -> Result<WorkspaceList, String> {
    tracing::info!(
        boot_id = %crate::logging::boot_id(),
        component = "workspace",
        stage = "forget.request",
        workspace_id = %workspace_id,
        "forget request"
    );
    let mut state = load_workspace_state(&app)?;
    let id = workspace_id.trim();

    if id.is_empty() {
        return Err("workspaceId is required".to_string());
    }

    let before = state.workspaces.len();
    state.workspaces.retain(|w| w.id != id);
    if before == state.workspaces.len() {
        return Err("Unknown workspaceId".to_string());
    }

    if state.active_id == id {
        state.active_id = state
            .workspaces
            .first()
            .map(|entry| entry.id.clone())
            .unwrap_or_else(|| "".to_string());
    }

    save_workspace_state(&app, &state)?;
    let active_workspace = state.workspaces.iter().find(|w| w.id == state.active_id);
    update_workspace_watch(&app, watch_state, active_workspace)?;

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command(async)]
pub fn workspace_set_active(
    app: tauri::AppHandle,
    workspace_id: String,
    watch_state: State<WorkspaceWatchState>,
) -> Result<WorkspaceList, String> {
    tracing::info!(
        boot_id = %crate::logging::boot_id(),
        component = "workspace",
        stage = "set_active.request",
        workspace_id = %workspace_id,
        "set_active request"
    );
    let mut state = load_workspace_state(&app)?;
    let id = workspace_id.trim();

    if id.is_empty() {
        return Err("workspaceId is required".to_string());
    }

    if !state.workspaces.iter().any(|w| w.id == id) {
        return Err("Unknown workspaceId".to_string());
    }

    state.active_id = id.to_string();
    save_workspace_state(&app, &state)?;
    let active_workspace = state.workspaces.iter().find(|w| w.id == state.active_id);
    update_workspace_watch(&app, watch_state, active_workspace)?;

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_update_display_name(
    app: tauri::AppHandle,
    workspace_id: String,
    display_name: Option<String>,
) -> Result<WorkspaceList, String> {
    tracing::info!(
        boot_id = %crate::logging::boot_id(),
        component = "workspace",
        stage = "update_display_name.request",
        workspace_id = %workspace_id,
        "update display name request"
    );
    let mut state = load_workspace_state(&app)?;
    let id = workspace_id.trim();

    if id.is_empty() {
        return Err("workspaceId is required".to_string());
    }

    let next_name = display_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let workspace = state.workspaces.iter_mut().find(|w| w.id == id);
    match workspace {
        Some(entry) => {
            entry.display_name = next_name;
        }
        None => return Err("Unknown workspaceId".to_string()),
    }

    save_workspace_state(&app, &state)?;

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_create(
    app: tauri::AppHandle,
    folder_path: String,
    name: String,
    preset: String,
    watch_state: State<WorkspaceWatchState>,
) -> Result<WorkspaceList, String> {
    tracing::info!(
        boot_id = %crate::logging::boot_id(),
        component = "workspace",
        stage = "create_local.request",
        "create local request"
    );
    let folder = folder_path.trim().to_string();
    if folder.is_empty() {
        return Err("folderPath is required".to_string());
    }

    let workspace_name = name.trim().to_string();
    if workspace_name.is_empty() {
        return Err("name is required".to_string());
    }

    let preset = preset.trim().to_string();
    let preset = if preset.is_empty() {
        "starter".to_string()
    } else {
        preset
    };

    fs::create_dir_all(&folder).map_err(|e| format!("Failed to create workspace folder: {e}"))?;

    let id = stable_workspace_id(&folder);

    ensure_workspace_files(&folder, &preset)?;

    let mut state = load_workspace_state(&app)?;

    state.workspaces.retain(|w| w.id != id);
    state.workspaces.push(WorkspaceInfo {
        id: id.clone(),
        name: workspace_name,
        path: folder,
        preset,
        workspace_type: WorkspaceType::Local,
        remote_type: None,
        base_url: None,
        directory: None,
        display_name: None,
        openwork_host_url: None,
        openwork_token: None,
        openwork_workspace_id: None,
        openwork_workspace_name: None,
        sandbox_backend: None,
        container_path: Some(resolve_container_path(&app)),
    });

    state.active_id = id.clone();
    save_workspace_state(&app, &state)?;
    let active_workspace = state.workspaces.iter().find(|w| w.id == state.active_id);
    update_workspace_watch(&app, watch_state, active_workspace)?;

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_create_remote(
    app: tauri::AppHandle,
    base_url: String,
    directory: Option<String>,
    display_name: Option<String>,
    remote_type: Option<RemoteType>,
    openwork_host_url: Option<String>,
    openwork_token: Option<String>,
    openwork_workspace_id: Option<String>,
    openwork_workspace_name: Option<String>,
    sandbox_backend: Option<String>,
    watch_state: State<WorkspaceWatchState>,
) -> Result<WorkspaceList, String> {
    tracing::info!(
        boot_id = %crate::logging::boot_id(),
        component = "workspace",
        stage = "create_remote.request",
        "create remote request"
    );
    let base_url = base_url.trim().to_string();
    let remote_type = remote_type.unwrap_or_default();
    if base_url.is_empty() {
        return Err("baseUrl is required".to_string());
    }
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err("baseUrl must start with http:// or https://".to_string());
    }

    let directory = directory
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let display_name = display_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let openwork_host_url = openwork_host_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let openwork_token = openwork_token
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if remote_type == RemoteType::Openwork {
        let host_url = openwork_host_url.clone().unwrap_or_default();
        if host_url.is_empty() {
            return Err("openworkHostUrl is required for OpenWork remote".to_string());
        }
        if !host_url.starts_with("http://") && !host_url.starts_with("https://") {
            return Err("openworkHostUrl must start with http:// or https://".to_string());
        }
    }

    let id = if remote_type == RemoteType::Openwork {
        stable_workspace_id_for_openwork(
            openwork_host_url.as_deref().unwrap_or(""),
            openwork_workspace_id.as_deref(),
        )
    } else {
        stable_workspace_id_for_remote(&base_url, directory.as_deref())
    };
    let name = openwork_workspace_name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| display_name.clone())
        .unwrap_or_else(|| {
            if remote_type == RemoteType::Openwork {
                openwork_host_url
                    .clone()
                    .unwrap_or_else(|| base_url.clone())
            } else {
                base_url.clone()
            }
        });
    let path = directory.clone().unwrap_or_default();

    let mut state = load_workspace_state(&app)?;
    state.workspaces.retain(|w| w.id != id);
    state.workspaces.push(WorkspaceInfo {
        id: id.clone(),
        name,
        path,
        preset: "remote".to_string(),
        workspace_type: WorkspaceType::Remote,
        remote_type: Some(remote_type),
        base_url: Some(base_url),
        directory,
        display_name,
        openwork_host_url,
        openwork_token,
        openwork_workspace_id,
        openwork_workspace_name,
        sandbox_backend: sandbox_backend
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        // Remote workspaces don't need a container path — `directory` already
        // encodes the equivalent meaning for the remote opencode-router.
        container_path: None,
    });
    state.active_id = id.clone();
    save_workspace_state(&app, &state)?;
    let active_workspace = state.workspaces.iter().find(|w| w.id == state.active_id);
    update_workspace_watch(&app, watch_state, active_workspace)?;

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command(async)]
pub fn workspace_update_remote(
    app: tauri::AppHandle,
    workspace_id: String,
    base_url: Option<String>,
    directory: Option<String>,
    display_name: Option<String>,
    remote_type: Option<RemoteType>,
    openwork_host_url: Option<String>,
    openwork_token: Option<String>,
    openwork_workspace_id: Option<String>,
    openwork_workspace_name: Option<String>,
    sandbox_backend: Option<String>,
) -> Result<WorkspaceList, String> {
    tracing::info!(
        boot_id = %crate::logging::boot_id(),
        component = "workspace",
        stage = "update_remote.request",
        workspace_id = %workspace_id,
        "update remote request"
    );
    let mut state = load_workspace_state(&app)?;
    let id = workspace_id.trim();
    if id.is_empty() {
        return Err("workspaceId is required".to_string());
    }

    let entry = state.workspaces.iter_mut().find(|w| w.id == id);
    let Some(entry) = entry else {
        return Err("Unknown workspaceId".to_string());
    };

    if entry.workspace_type != WorkspaceType::Remote {
        return Err("workspaceId is not remote".to_string());
    }

    if let Some(next_base_url) = base_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if !next_base_url.starts_with("http://") && !next_base_url.starts_with("https://") {
            return Err("baseUrl must start with http:// or https://".to_string());
        }
        entry.base_url = Some(next_base_url);
    }

    let next_directory = directory
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if directory.is_some() {
        entry.directory = next_directory.clone();
        entry.path = next_directory.unwrap_or_default();
    }

    if let Some(next_name) = display_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        entry.display_name = Some(next_name.clone());
        entry.name = next_name;
    }

    if let Some(next_remote_type) = remote_type {
        entry.remote_type = Some(next_remote_type);
    }

    if let Some(next_host_url) = openwork_host_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if !next_host_url.starts_with("http://") && !next_host_url.starts_with("https://") {
            return Err("openworkHostUrl must start with http:// or https://".to_string());
        }
        entry.openwork_host_url = Some(next_host_url);
    }

    if openwork_token.is_some() {
        entry.openwork_token = openwork_token
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }

    if openwork_workspace_id.is_some() {
        entry.openwork_workspace_id = openwork_workspace_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }

    if let Some(next_name) = openwork_workspace_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        entry.openwork_workspace_name = Some(next_name.clone());
        if entry.display_name.is_none() {
            entry.name = next_name;
        }
    }

    if let Some(next_backend) = sandbox_backend
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        entry.sandbox_backend = Some(next_backend);
    }

    save_workspace_state(&app, &state)?;

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

/// `<workspace>\.opencode\openwork.json`, refused if a planted link or
/// junction under the projects root sits on the way (#3666).
fn openwork_json_path(workspace_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(workspace_path)
        .join(".opencode")
        .join("openwork.json");
    reject_reparse_under_projects_root(&path)?;
    Ok(path)
}

#[tauri::command]
pub fn workspace_add_authorized_root(
    _app: tauri::AppHandle,
    workspace_path: String,
    folder_path: String,
) -> Result<ExecResult, String> {
    let workspace_path = workspace_path.trim().to_string();
    let folder_path = folder_path.trim().to_string();

    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }
    if folder_path.is_empty() {
        return Err("folderPath is required".to_string());
    }

    let openwork_path = openwork_json_path(&workspace_path)?;

    if let Some(parent) = openwork_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    let mut config: WorkspaceOpenworkConfig = if openwork_path.exists() {
        let raw = fs::read_to_string(&openwork_path)
            .map_err(|e| format!("Failed to read {}: {e}", openwork_path.display()))?;
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        let mut cfg = WorkspaceOpenworkConfig::default();
        if !cfg.authorized_roots.iter().any(|p| p == &workspace_path) {
            cfg.authorized_roots.push(workspace_path.clone());
        }
        cfg
    };

    if !config.authorized_roots.iter().any(|p| p == &folder_path) {
        config.authorized_roots.push(folder_path);
    }

    fs::write(
        &openwork_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", openwork_path.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: "Updated authorizedRoots".to_string(),
        stderr: String::new(),
    })
}

#[tauri::command]
pub fn workspace_openwork_read(
    _app: tauri::AppHandle,
    workspace_path: String,
) -> Result<WorkspaceOpenworkConfig, String> {
    let workspace_path = workspace_path.trim().to_string();
    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }

    let openwork_path = openwork_json_path(&workspace_path)?;

    if !openwork_path.exists() {
        let mut cfg = WorkspaceOpenworkConfig::default();
        cfg.authorized_roots.push(workspace_path);
        return Ok(cfg);
    }

    let raw = fs::read_to_string(&openwork_path)
        .map_err(|e| format!("Failed to read {}: {e}", openwork_path.display()))?;

    serde_json::from_str::<WorkspaceOpenworkConfig>(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", openwork_path.display()))
}

#[tauri::command]
pub fn workspace_openwork_write(
    _app: tauri::AppHandle,
    workspace_path: String,
    config: WorkspaceOpenworkConfig,
) -> Result<ExecResult, String> {
    let workspace_path = workspace_path.trim().to_string();
    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }

    let openwork_path = openwork_json_path(&workspace_path)?;

    if let Some(parent) = openwork_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    fs::write(
        &openwork_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", openwork_path.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Wrote {}", openwork_path.display()),
        stderr: String::new(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceExportSummary {
    pub output_path: String,
    pub included: usize,
    pub excluded: Vec<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_zip_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_secret_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower == ".env" || lower.starts_with(".env.") {
        return true;
    }
    if lower == "credentials.json" || lower == "credentials.yml" || lower == "credentials.yaml" {
        return true;
    }
    if lower.ends_with(".key")
        || lower.ends_with(".pem")
        || lower.ends_with(".p12")
        || lower.ends_with(".pfx")
    {
        return true;
    }
    false
}

fn should_exclude(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|entry| entry.to_str())
        .unwrap_or("");
    is_secret_name(name)
}

fn collect_workspace_entries(
    workspace_root: &Path,
) -> Result<(Vec<(PathBuf, String)>, Vec<String>), String> {
    let mut entries: Vec<(PathBuf, String)> = Vec::new();
    let mut excluded: Vec<String> = Vec::new();

    let config_path = workspace_root.join("opencode.json");
    reject_reparse_under_projects_root(&config_path)?;
    if config_path.exists() && config_path.is_file() {
        if should_exclude(&config_path) {
            excluded.push("opencode.json".to_string());
        } else {
            entries.push((config_path, "opencode.json".to_string()));
        }
    }

    let opencode_dir = workspace_root.join(".opencode");
    reject_reparse_under_projects_root(&opencode_dir)?;
    if opencode_dir.exists() {
        for entry in WalkDir::new(&opencode_dir) {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_file() {
                continue;
            }
            let absolute = entry.path().to_path_buf();
            let rel = absolute
                .strip_prefix(workspace_root)
                .map_err(|e| format!("Failed to compute relative path: {e}"))?;
            let rel_str = normalize_zip_path(rel);
            if should_exclude(&absolute) {
                if !excluded.contains(&rel_str) {
                    excluded.push(rel_str);
                }
                continue;
            }
            entries.push((absolute, rel_str));
        }
    }

    Ok((entries, excluded))
}

#[tauri::command]
pub fn workspace_export_config(
    app: tauri::AppHandle,
    workspace_id: String,
    output_path: String,
) -> Result<WorkspaceExportSummary, String> {
    let workspace_id = workspace_id.trim().to_string();
    if workspace_id.is_empty() {
        return Err("workspaceId is required".to_string());
    }
    let output_path = output_path.trim().to_string();
    if output_path.is_empty() {
        return Err("outputPath is required".to_string());
    }

    let state = load_workspace_state(&app)?;
    let workspace = state
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| "Unknown workspaceId".to_string())?;

    if workspace.workspace_type != WorkspaceType::Local {
        return Err("Workspace export is only supported for local workspaces".to_string());
    }

    let workspace_root = PathBuf::from(&workspace.path);
    if !workspace_root.exists() {
        return Err(format!(
            "Workspace path not found: {}",
            workspace_root.display()
        ));
    }

    let output_path = PathBuf::from(&output_path);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create export folder {}: {e}", parent.display()))?;
    }

    let (entries, excluded_paths) = collect_workspace_entries(&workspace_root)?;
    if entries.is_empty() {
        return Err("No workspace config files found to export".to_string());
    }

    let file = fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create {}: {e}", output_path.display()))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut included_paths: Vec<String> = Vec::new();

    for (src, rel) in entries {
        let mut input =
            fs::File::open(&src).map_err(|e| format!("Failed to read {}: {e}", src.display()))?;
        zip.start_file(rel.clone(), options)
            .map_err(|e| format!("Failed to add {}: {e}", rel))?;
        let mut buffer = Vec::new();
        input
            .read_to_end(&mut buffer)
            .map_err(|e| format!("Failed to read {}: {e}", src.display()))?;
        zip.write_all(&buffer)
            .map_err(|e| format!("Failed to write {}: {e}", src.display()))?;
        included_paths.push(rel);
    }

    let included_count = included_paths.len();
    let excluded_summary = excluded_paths.clone();
    let manifest = serde_json::json!({
        "version": 1,
        "createdAtMs": now_ms(),
        "workspace": {
            "id": workspace.id.clone(),
            "name": workspace.name.clone(),
            "path": workspace.path.clone()
        },
        "included": included_paths,
        "excluded": excluded_paths,
    });
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.start_file("manifest.json", options)
        .map_err(|e| format!("Failed to add manifest: {e}"))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("Failed to write manifest: {e}"))?;

    zip.finish()
        .map_err(|e| format!("Failed to finalize export: {e}"))?;

    Ok(WorkspaceExportSummary {
        output_path: output_path.to_string_lossy().to_string(),
        included: included_count,
        excluded: excluded_summary,
    })
}

#[tauri::command]
pub fn workspace_import_config(
    app: tauri::AppHandle,
    archive_path: String,
    target_dir: String,
    name: Option<String>,
    watch_state: State<WorkspaceWatchState>,
) -> Result<WorkspaceList, String> {
    let archive_path = archive_path.trim().to_string();
    if archive_path.is_empty() {
        return Err("archivePath is required".to_string());
    }
    let target_dir = target_dir.trim().to_string();
    if target_dir.is_empty() {
        return Err("targetDir is required".to_string());
    }

    let target_path = PathBuf::from(&target_dir);
    if target_path.exists() {
        let mut entries = fs::read_dir(&target_path)
            .map_err(|e| format!("Failed to read {}: {e}", target_path.display()))?;
        if entries.next().is_some() {
            return Err("Target folder must be empty".to_string());
        }
    }

    fs::create_dir_all(&target_path)
        .map_err(|e| format!("Failed to create {}: {e}", target_path.display()))?;

    let file = fs::File::open(&archive_path)
        .map_err(|e| format!("Failed to open {}: {e}", archive_path))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Failed to read archive: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().map_err(|e| e.to_string())?.to_string();
        if name == "manifest.json" {
            continue;
        }
        let entry_path = Path::new(&name);
        if entry_path.components().any(|component| match component {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => true,
            _ => false,
        }) {
            return Err("Archive contains an unsafe path".to_string());
        }
        if !(name == "opencode.json" || name.starts_with(".opencode/")) {
            continue;
        }
        if let Some(file_name) = entry_path.file_name().and_then(|entry| entry.to_str()) {
            if is_secret_name(file_name) {
                continue;
            }
        }
        let out_path = target_path.join(Path::new(&name));
        reject_reparse_under_projects_root(&out_path)?;
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
        if name.ends_with('/') {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create {}: {e}", out_path.display()))?;
            continue;
        }
        let mut buffer = Vec::new();
        entry
            .read_to_end(&mut buffer)
            .map_err(|e| format!("Failed to read archive entry: {e}"))?;
        fs::write(&out_path, buffer)
            .map_err(|e| format!("Failed to write {}: {e}", out_path.display()))?;
    }

    let opencode_dir = target_path.join(".opencode");
    if !opencode_dir.exists() {
        return Err("Archive is missing .opencode config".to_string());
    }

    let openwork_path = target_path.join(".opencode").join("openwork.json");
    reject_reparse_under_projects_root(&openwork_path)?;
    let mut preset = "starter".to_string();
    let mut workspace_name = name.clone().filter(|value| !value.trim().is_empty());

    if openwork_path.exists() {
        let raw = fs::read_to_string(&openwork_path)
            .map_err(|e| format!("Failed to read {}: {e}", openwork_path.display()))?;
        if let Ok(mut config) = serde_json::from_str::<WorkspaceOpenworkConfig>(&raw) {
            config.authorized_roots = vec![target_dir.clone()];
            if let Some(workspace) = &config.workspace {
                if workspace_name.is_none() {
                    workspace_name = workspace
                        .name
                        .clone()
                        .filter(|value| !value.trim().is_empty());
                }
                if let Some(next_preset) = &workspace.preset {
                    if !next_preset.trim().is_empty() {
                        preset = next_preset.clone();
                    }
                }
            }
            fs::write(
                &openwork_path,
                serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
            )
            .map_err(|e| format!("Failed to write {}: {e}", openwork_path.display()))?;
        }
    } else {
        let config = WorkspaceOpenworkConfig::new(&target_dir, &preset, now_ms());
        if let Some(parent) = openwork_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
        fs::write(
            &openwork_path,
            serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("Failed to write {}: {e}", openwork_path.display()))?;
    }

    let name = workspace_name
        .unwrap_or_else(|| {
            target_path
                .file_name()
                .and_then(|entry| entry.to_str())
                .unwrap_or("Workspace")
                .to_string()
        })
        .trim()
        .to_string();

    let id = stable_workspace_id(&target_dir);

    let mut state = load_workspace_state(&app)?;
    state.workspaces.retain(|w| w.id != id);
    state.workspaces.push(WorkspaceInfo {
        id: id.clone(),
        name,
        path: target_dir.clone(),
        preset,
        workspace_type: WorkspaceType::Local,
        remote_type: None,
        base_url: None,
        directory: None,
        display_name: None,
        openwork_host_url: None,
        openwork_token: None,
        openwork_workspace_id: None,
        openwork_workspace_name: None,
        sandbox_backend: None,
        container_path: Some(resolve_container_path(&app)),
    });
    state.active_id = id.clone();
    save_workspace_state(&app, &state)?;

    let active_workspace = state.workspaces.iter().find(|w| w.id == state.active_id);
    update_workspace_watch(&app, watch_state, active_workspace)?;

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[cfg(test)]
mod zip_roundtrip_tests {
    use super::{CompressionMethod, SimpleFileOptions, ZipArchive, ZipWriter};
    use std::io::{Cursor, Read, Write};

    /// Regression test for the zip crate 0.6 -> 9.x migration: writes a small
    /// archive with the exact API surface `workspace_export_config` uses
    /// (`SimpleFileOptions`, `CompressionMethod::Deflated`, `start_file`,
    /// `write_all`, `finish`), then reads it back with the same API
    /// `workspace_import_config` uses (`by_index`, `name()`, `read_to_end`)
    /// and asserts the round trip preserves names and contents.
    #[test]
    fn zip_write_then_read_round_trips_names_and_contents() {
        let files: &[(&str, &[u8])] = &[
            ("opencode.json", b"{\"ok\":true}"),
            (".opencode/openwork.json", b"{\"version\":1}"),
            ("manifest.json", b"{\"included\":[]}"),
        ];

        let mut buffer = Vec::new();
        {
            let mut zip = ZipWriter::new(Cursor::new(&mut buffer));
            let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            for (name, contents) in files {
                zip.start_file(*name, options).expect("start_file");
                zip.write_all(contents).expect("write_all");
            }
            zip.finish().expect("finish");
        }

        let mut archive = ZipArchive::new(Cursor::new(buffer)).expect("read back archive");
        assert_eq!(archive.len(), files.len());

        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("by_index");
            let name = entry.name().expect("entry name").to_string();
            let expected = files
                .iter()
                .find(|(expected_name, _)| *expected_name == name)
                .unwrap_or_else(|| panic!("unexpected entry name in archive: {name}"));
            let mut read_back = Vec::new();
            entry.read_to_end(&mut read_back).expect("read_to_end");
            assert_eq!(read_back, expected.1);
        }
    }
}

#[cfg(all(test, windows))]
mod reparse_tests {
    use super::{collect_workspace_entries, openwork_json_path};
    use crate::commands::reparse::test_support::{junction, layout, use_projects_root};

    #[test]
    fn openwork_json_and_export_through_a_planted_junction_are_refused() {
        let (root, outside) = layout();
        use_projects_root(&root);
        std::fs::write(outside.join("openwork.json"), "owner data").unwrap();
        junction(&root.join(".opencode"), &outside);

        assert!(openwork_json_path(&root.to_string_lossy()).is_err());
        assert!(collect_workspace_entries(&root).is_err());
    }

    #[test]
    fn openwork_json_and_export_work_in_a_real_directory() {
        let (root, _) = layout();
        use_projects_root(&root);
        std::fs::create_dir(root.join(".opencode")).unwrap();
        std::fs::write(root.join(".opencode").join("openwork.json"), "{}").unwrap();

        let path = openwork_json_path(&root.to_string_lossy()).expect("real dir");
        assert_eq!(path, root.join(".opencode").join("openwork.json"));
        assert_eq!(collect_workspace_entries(&root).unwrap().0.len(), 1);
    }
}
