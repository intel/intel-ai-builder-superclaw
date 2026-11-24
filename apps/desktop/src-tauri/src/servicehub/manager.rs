use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri_plugin_shell::process::CommandChild;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHubInfo {
    pub running: bool,
    pub hub_port: Option<u16>,
    pub pid: Option<u32>,
    pub last_stdout: Option<String>,
    pub last_stderr: Option<String>,
}

pub struct ServiceHubState {
    pub child: Option<CommandChild>,
    pub child_exited: bool,
    pub hub_port: Option<u16>,
    pub hub_token: Option<String>,
    pub last_stdout: Option<String>,
    pub last_stderr: Option<String>,
    /// Cancellation token for the active boot-sequence thread.
    /// Set to `true` to signal the running boot thread to exit early.
    pub boot_cancel: Arc<AtomicBool>,
}

impl Default for ServiceHubState {
    fn default() -> Self {
        Self {
            child: None,
            child_exited: false,
            hub_port: None,
            hub_token: None,
            last_stdout: None,
            last_stderr: None,
            boot_cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Default)]
pub struct ServiceHubManager {
    pub inner: Arc<Mutex<ServiceHubState>>,
}

impl ServiceHubManager {
    /// Cancel any running boot-sequence thread and return a fresh cancellation
    /// token for the new boot sequence about to start.
    pub fn cancel_boot_and_new_token(state: &mut ServiceHubState) -> Arc<AtomicBool> {
        state.boot_cancel.store(true, Ordering::SeqCst);
        let new_token = Arc::new(AtomicBool::new(false));
        state.boot_cancel = new_token.clone();
        new_token
    }

    pub fn snapshot_locked(state: &mut ServiceHubState) -> ServiceHubInfo {
        let (running, pid) = match state.child.as_ref() {
            None => (false, None),
            Some(_child) if state.child_exited => {
                state.child = None;
                (false, None)
            }
            Some(child) => (true, Some(child.pid())),
        };

        ServiceHubInfo {
            running,
            hub_port: state.hub_port,
            pid,
            last_stdout: state.last_stdout.clone(),
            last_stderr: state.last_stderr.clone(),
        }
    }

    pub fn stop_locked(state: &mut ServiceHubState) {
        state.boot_cancel.store(true, Ordering::SeqCst);
        // REUSE handoff children exit quickly; killing a stale PID after recycle is unsafe.
        if state.child_exited {
            state.child = None;
        } else if let Some(child) = state.child.take() {
            crate::utils::kill_process_tree(child.pid());
            let _ = child.kill();
        }
        state.child_exited = true;
        state.hub_port = None;
        state.hub_token = None;
        state.last_stdout = None;
        state.last_stderr = None;
    }
}
