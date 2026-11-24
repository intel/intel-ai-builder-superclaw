use tauri::{AppHandle, LogicalSize, Manager};

/// Set (or clear) the minimum inner size of the main window.
/// Pass `width`/`height` > 0 to enforce a minimum; pass exactly 0/0 to clear it.
/// Any other combination (e.g. one dimension zero, negative values) is rejected.
#[tauri::command]
pub fn set_window_min_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    if width == 0.0 && height == 0.0 {
        window
            .set_min_size(None::<LogicalSize<f64>>)
            .map_err(|e| format!("Failed to clear min size: {e}"))
    } else if width > 0.0 && height > 0.0 {
        window
            .set_min_size(Some(LogicalSize::new(width, height)))
            .map_err(|e| format!("Failed to set min size: {e}"))
    } else {
        Err(format!(
            "Invalid min size ({width}x{height}): both dimensions must be positive, or both must be 0 to clear"
        ))
    }
}

/// Set the inner size of the main window.
/// Both `width` and `height` must be positive.
#[tauri::command]
pub fn set_window_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if width <= 0.0 || height <= 0.0 {
        return Err(format!(
            "Invalid window size ({width}x{height}): both dimensions must be positive"
        ));
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| format!("Failed to set window size: {e}"))
}

/// Lets the next app SuperClaw opens, such as the browser, come to the front.
/// Windows only lets the foreground app pass that on; without it, a page opened
/// without a click in SuperClaw (the Gmail guide's sign-in) opens behind it.
#[tauri::command]
pub fn allow_browser_foreground() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
        // SAFETY: no pointers; fails harmlessly when SuperClaw is not in front.
        unsafe { AllowSetForegroundWindow(ASFW_ANY) };
    }
}

/// Set window decorations (titlebar) visibility.
/// When `decorations` is false, the native titlebar is hidden.
/// This is useful for tiling window managers on Linux (e.g., Hyprland, i3, sway).
#[tauri::command]
pub fn set_window_decorations(app: AppHandle, decorations: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    window
        .set_decorations(decorations)
        .map_err(|e| format!("Failed to set decorations: {e}"))
}
