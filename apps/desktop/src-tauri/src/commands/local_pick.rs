use std::path::PathBuf;

use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;

use super::misc::scanned_files;

/// Open the native file picker on `default_path` and make only the file the
/// user picks readable through `read_local_file_bytes`. The webview may suggest
/// a file, but it cannot read one the user did not choose in native UI.
#[tauri::command]
pub async fn pick_local_file(
    window: WebviewWindow,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = window.dialog().file().set_parent(&window);
    if let Some(path) = default_path.map(|value| PathBuf::from(value.trim())) {
        if let Some(parent) = path.parent().filter(|parent| parent.is_dir()) {
            dialog = dialog.set_directory(parent);
        }
        if let Some(name) = path.file_name() {
            dialog = dialog.set_file_name(name.to_string_lossy());
        }
    }
    let Some(picked) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve file: {e}"))?;
    if !canonical.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    scanned_files()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(canonical);
    Ok(Some(path.to_string_lossy().into_owned()))
}
