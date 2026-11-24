use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn command_for_program(program: &Path) -> Command {
    if program
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("cmd"))
        .unwrap_or(false)
    {
        let mut command = Command::new("cmd");
        command
            .arg("/C")
            .arg(program)
            .creation_flags(CREATE_NO_WINDOW);
        return command;
    }

    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

pub fn configure_hidden(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

/// Right Alt is the dictation hotkey. Windows delivers it as a system menu key:
/// the first press opens that menu and the page never sees the release, so the
/// hotkey only toggles on the next press. F9 is an ordinary key, which is why it
/// works. Mark the system key handled and replay it into the page. Ctrl held
/// means AltGr — leave that alone so composed characters still type.
pub fn release_alt_key(window: &tauri::WebviewWindow) {
    let host = window.clone();
    let applied = window.with_webview(move |webview| unsafe {
        forward_right_alt(&host, &webview);
    });
    if let Err(err) = applied {
        tracing::warn!(
            component = "tauri",
            stage = "webview.accelerator_keys",
            error = %err,
            "failed to reach the WebView2 controller"
        );
    }
}

unsafe fn forward_right_alt(
    host: &tauri::WebviewWindow,
    webview: &tauri::webview::PlatformWebview,
) {
    use webview2_com::AcceleratorKeyPressedEventHandler;

    let host = host.clone();
    let mut token = 0_i64;
    let registered = webview.controller().add_AcceleratorKeyPressed(
        &AcceleratorKeyPressedEventHandler::create(Box::new(move |_controller, args| {
            if let Some(args) = args {
                replay_right_alt(&host, &args);
            }
            Ok(())
        })),
        &mut token,
    );
    if let Err(err) = registered {
        tracing::warn!(
            component = "tauri",
            stage = "webview.accelerator_keys",
            error = %err,
            "failed to watch Right Alt system keys"
        );
        return;
    }
    tracing::info!(
        component = "tauri",
        stage = "webview.accelerator_keys",
        "Right Alt system keys are replayed into the page"
    );
}

/// VK_MENU, the virtual key WebView2 reports for either Alt.
const VK_MENU: u32 = 0x12;
/// VK_RMENU, reported for Right Alt on some keyboard layouts.
const VK_RMENU: u32 = 0xA5;
/// VK_CONTROL. Held together with Right Alt, this is AltGr, not the hotkey.
const VK_CONTROL: i32 = 0x11;

/// Dispatch on the focused element, not `window`. An event fired on `window`
/// never reaches `document`, and the Settings capture field listens through
/// Solid's document delegate. Bubbling still delivers it to the window
/// matcher. The capture field calls `stopPropagation`, so choosing a shortcut
/// does not also start dictation.
const ALT_RIGHT_REPLAY: &str = "var t=document.activeElement||document.body;if(t)t.dispatchEvent(new KeyboardEvent('TYPE',{code:'AltRight',key:'Alt',bubbles:true,cancelable:true}))";

unsafe fn replay_right_alt(
    host: &tauri::WebviewWindow,
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2AcceleratorKeyPressedEventArgs,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_KEY_UP,
        COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_UP,
        COREWEBVIEW2_PHYSICAL_KEY_STATUS,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
    if args.KeyEventKind(&mut kind).is_err() {
        return;
    }
    let mut vk = 0_u32;
    if args.VirtualKey(&mut vk).is_err() {
        return;
    }
    let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
    if args.PhysicalKeyStatus(&mut status).is_err() {
        return;
    }
    let right_alt = vk == VK_RMENU || (vk == VK_MENU && status.IsExtendedKey.as_bool());
    if !right_alt {
        return;
    }
    // High bit set means the key is down. AltGr must still compose.
    if (GetAsyncKeyState(VK_CONTROL) as u16) & 0x8000 != 0 {
        return;
    }
    if args.SetHandled(true).is_err() {
        return;
    }
    let is_down = kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
        || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN;
    let is_up = kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_UP
        || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_UP;
    // A held key repeats as another keydown. The page already has the first one.
    if is_down && status.WasKeyDown.as_bool() {
        return;
    }
    let script = if is_down {
        ALT_RIGHT_REPLAY.replace("TYPE", "keydown")
    } else if is_up {
        ALT_RIGHT_REPLAY.replace("TYPE", "keyup")
    } else {
        return;
    };
    if let Err(err) = host.eval(script) {
        tracing::warn!(
            component = "tauri",
            stage = "webview.accelerator_keys",
            error = %err,
            "failed to replay Right Alt into the page"
        );
    }
}
