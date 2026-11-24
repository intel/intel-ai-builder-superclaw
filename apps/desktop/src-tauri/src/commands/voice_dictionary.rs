use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};

use tauri::{AppHandle, Manager};

/// Upper bound on name attempts; past this something other than a busy
/// Downloads folder is wrong.
const MAX_NAME_ATTEMPTS: u32 = 1000;

/// Write the voice Dictionary export to the user's Downloads folder and return
/// the path written. The webview cannot save a Blob download, so the Settings
/// dialog calls this instead. Never overwrites: an existing `dictionary.txt`
/// gets a `dictionary (2).txt` sibling, and so on.
#[tauri::command]
pub fn write_voice_dictionary_export(app: AppHandle, content: String) -> Result<String, String> {
    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("Failed to resolve downloads dir: {e}"))?;

    for attempt in 1..=MAX_NAME_ATTEMPTS {
        let name = if attempt == 1 {
            "dictionary.txt".to_string()
        } else {
            format!("dictionary ({attempt}).txt")
        };
        let target = downloads_dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(mut file) => {
                file.write_all(content.as_bytes())
                    .map_err(|e| format!("Failed to write {}: {e}", target.display()))?;
                return Ok(target.to_string_lossy().to_string());
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to create {}: {e}", target.display())),
        }
    }
    Err(format!(
        "Could not find a free file name in {}",
        downloads_dir.display()
    ))
}
