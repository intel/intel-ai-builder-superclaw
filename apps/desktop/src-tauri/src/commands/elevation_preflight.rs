//! Frontend-facing command for the startup elevation gate.

use crate::elevation_preflight;

/// Whether this launch was refused for running with an elevated token. `false` outside Windows and in
/// debug builds.
#[tauri::command]
pub fn get_elevation_blocked() -> bool {
    elevation_preflight::blocked()
}
