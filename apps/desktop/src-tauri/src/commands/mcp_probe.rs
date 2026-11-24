use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn is_valid_date(date: &str) -> bool {
    date.len() == 10
        && date.bytes().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7) && byte == b'-'
                || !matches!(index, 4 | 7) && byte.is_ascii_digit()
        })
}

fn diagnostic_log_path(app_local_data_dir: &Path, date: &str) -> PathBuf {
    app_local_data_dir.join(format!("mcp-diagnostics-{date}.log"))
}

fn append_diagnostic_line(app: &AppHandle, date: &str, line: &str) -> Result<PathBuf, String> {
    if !is_valid_date(date) {
        return Err("MCP diagnostic date must use YYYY-MM-DD".to_string());
    }
    let app_local_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to resolve local app data directory: {error}"))?;
    create_dir_all(&app_local_data_dir)
        .map_err(|error| format!("Failed to create local app data directory: {error}"))?;
    let log_path = diagnostic_log_path(&app_local_data_dir, date);

    let line = line.replace('\r', " ").replace('\n', " ");
    let line = line.trim();
    if line.is_empty() {
        return Err("MCP diagnostic line must not be empty".to_string());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Failed to open MCP diagnostics: {error}"))?;
    writeln!(file, "{line}")
        .map_err(|error| format!("Failed to write MCP diagnostics: {error}"))?;
    Ok(log_path)
}

#[tauri::command]
pub fn mcp_diagnostic_line(app: AppHandle, date: String, line: String) -> Result<String, String> {
    append_diagnostic_line(&app, &date, &line).map(|path| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::diagnostic_log_path;
    use std::path::PathBuf;

    // Test diagnostic logs use the dated app-local-data filename.
    #[test]
    fn diagnostic_log_uses_the_dated_file_under_local_app_data() {
        let local_app_data = PathBuf::from(r"C:\Users\test\AppData\Local\com.aibuilder.superclaw");

        assert_eq!(
            diagnostic_log_path(&local_app_data, "2026-07-17"),
            local_app_data.join("mcp-diagnostics-2026-07-17.log")
        );
    }
}
