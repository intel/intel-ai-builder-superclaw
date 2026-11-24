use std::fs;

use tauri::{AppHandle, State};

use crate::backend_progress::{ServiceHubBootSnapshot, ServiceHubBootState};
use crate::servicehub;
use crate::servicehub::manager::{ServiceHubInfo, ServiceHubManager};
use crate::servicehub::sandbox_proxy::{proxy_get, proxy_post};

#[tauri::command]
pub fn start_servicehub(
    app: AppHandle,
    manager: State<ServiceHubManager>,
) -> Result<ServiceHubInfo, String> {
    servicehub::start_servicehub(&app, &manager)
}

#[tauri::command]
pub fn retry_servicehub_boot(
    app: AppHandle,
    manager: State<ServiceHubManager>,
) -> Result<ServiceHubInfo, String> {
    let status = servicehub::get_servicehub_status(&manager)?;
    if status.running {
        return Ok(status);
    }
    servicehub::start_servicehub(&app, &manager)
}

#[tauri::command]
pub fn get_servicehub_status(manager: State<ServiceHubManager>) -> Result<ServiceHubInfo, String> {
    servicehub::get_servicehub_status(&manager)
}

#[tauri::command]
pub fn stop_servicehub(manager: State<ServiceHubManager>) -> Result<ServiceHubInfo, String> {
    servicehub::stop_servicehub(&manager)
}

#[tauri::command]
pub fn get_servicehub_boot_snapshot(
    boot_state: State<ServiceHubBootState>,
) -> ServiceHubBootSnapshot {
    boot_state.snapshot()
}

/// Build the cleanup-status path, appending `?enabled=` when specified.
fn cleanup_status_path(enabled: Option<bool>) -> String {
    let base = "/sandbox-manager/v1/workspace/cleanup/status";
    match enabled {
        Some(true) => format!("{base}?enabled=true"),
        Some(false) => format!("{base}?enabled=false"),
        None => base.to_string(),
    }
}

#[tauri::command]
pub fn get_backend_system_status(
    manager: State<ServiceHubManager>,
) -> Result<serde_json::Value, String> {
    proxy_get(&manager, "/sandbox-manager/v1/system/status", 5)
}

#[tauri::command]
pub fn get_debug_build_commit() -> Result<String, String> {
    if !cfg!(debug_assertions) {
        return Err("Build commit is only available in debug builds".to_string());
    }

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../build/Debug/servicehub/sandbox_manager/BUILD_COMMIT");
    let commit = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
    let commit = commit.trim();
    if commit.is_empty() {
        return Err(format!("Build commit is empty: {}", path.display()));
    }
    Ok(commit.to_string())
}

#[tauri::command]
pub fn run_workspace_cleanup_now(
    manager: State<ServiceHubManager>,
) -> Result<serde_json::Value, String> {
    proxy_post(
        &manager,
        "/app/workspace/cleanup/run-now",
        "{}",
        300,
    )
}

#[tauri::command]
pub fn preview_workspace_cleanup(
    manager: State<ServiceHubManager>,
    retention_days: Option<i64>,
) -> Result<serde_json::Value, String> {
    let body = match retention_days {
        Some(days) => serde_json::json!({ "retention_days": days }).to_string(),
        None => "{}".to_string(),
    };
    proxy_post(&manager, "/sandbox-manager/v1/workspace/cleanup/preview", &body, 60)
}

#[tauri::command]
pub fn get_workspace_cleanup_status(
    manager: State<ServiceHubManager>,
    enabled: Option<bool>,
) -> Result<serde_json::Value, String> {
    proxy_get(&manager, &cleanup_status_path(enabled), 30)
}

#[tauri::command]
pub fn get_workspace_cleanup_settings(
    manager: State<ServiceHubManager>,
) -> Result<serde_json::Value, String> {
    proxy_get(&manager, "/sandbox-manager/v1/workspace/cleanup/settings", 10)
}

#[tauri::command]
pub fn set_workspace_cleanup_settings(
    manager: State<ServiceHubManager>,
    enabled: Option<bool>,
    retention_days: Option<i64>,
) -> Result<serde_json::Value, String> {
    let mut body = serde_json::Map::new();
    if let Some(value) = enabled {
        body.insert("enabled".to_string(), serde_json::Value::Bool(value));
    }
    if let Some(value) = retention_days {
        body.insert("retentionDays".to_string(), serde_json::Value::from(value));
    }
    proxy_post(
        &manager,
        "/app/workspace/cleanup/settings",
        &serde_json::Value::Object(body).to_string(),
        10,
    )
}

#[tauri::command]
pub fn get_workspace_cleanup_policy(
    manager: State<ServiceHubManager>,
) -> Result<serde_json::Value, String> {
    proxy_get(&manager, "/sandbox-manager/v1/workspace/cleanup/policy", 10)
}


#[cfg(test)]
mod tests {
    // These commands are thin proxies; we only assert the query string builder for
    // the one that transforms its input, so the ?enabled= contract is locked.
    // HTTP behavior is covered by the sandbox_proxy unit tests.
    use super::cleanup_status_path;

    #[test]
    fn cleanup_status_path_omits_query_when_none() {
        assert_eq!(
            cleanup_status_path(None),
            "/sandbox-manager/v1/workspace/cleanup/status"
        );
    }

    #[test]
    fn cleanup_status_path_appends_enabled_flag() {
        assert_eq!(
            cleanup_status_path(Some(true)),
            "/sandbox-manager/v1/workspace/cleanup/status?enabled=true"
        );
        assert_eq!(
            cleanup_status_path(Some(false)),
            "/sandbox-manager/v1/workspace/cleanup/status?enabled=false"
        );
    }
}
