//! Frontend-facing command for the startup port-conflict gate.

use tauri::State;

use crate::port_preflight::{PortPreflightReport, PortPreflightState};

/// Return the startup port probe result, or `None` if the probe never ran.
///
/// `None` is a deliberate fail-open signal: it means the gate did not execute
/// (non-Windows dev, or `setup()` bailed before probing), so the frontend must
/// pass through to the normal startup flow rather than blocking on an unknown.
#[tauri::command]
pub fn get_port_preflight_report(
    state: State<'_, PortPreflightState>,
) -> Option<PortPreflightReport> {
    state.get()
}
