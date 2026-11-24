use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn truncate_output(input: &str, max_chars: usize) -> String {
    let char_count = input.chars().count();
    if char_count <= max_chars {
        return input.to_string();
    }

    input
        .chars()
        .skip(char_count - max_chars)
        .collect()
}

// ── Process tree cleanup ────────────────────────────────────────────────────
// On Windows, `TerminateProcess` (what `child.kill()` calls) does NOT
// propagate to child processes.  `taskkill /F /T` terminates the entire
// process tree rooted at the given PID.
//
// Call this BEFORE `child.kill()` so the root PID is still valid for tree
// enumeration.  `taskkill /T` walks the tree top-down, so it handles
// grandchildren (e.g. uv → python → python3.13).

#[cfg(target_os = "windows")]
pub fn kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    match std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(output) => {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                eprintln!(
                    "[shutdown] taskkill /T /PID {} exited {}: {}",
                    pid,
                    output.status.code().unwrap_or(-1),
                    stderr.trim()
                );
            }
        }
        Err(e) => eprintln!("[shutdown] failed to spawn taskkill for PID {}: {}", pid, e),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn kill_process_tree(pid: u32) {
    // On Unix, send SIGKILL to the process group (negative PID).
    // Falls back to direct kill if the process isn't a group leader.
    let neg_pid = format!("-{}", pid);
    match std::process::Command::new("kill")
        .args(["-9", &neg_pid])
        .output()
    {
        Ok(output) if output.status.success() => {}
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            eprintln!(
                "[shutdown] kill -9 {} exited {}: {}",
                neg_pid,
                output.status.code().unwrap_or(-1),
                stderr.trim()
            );
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }
        Err(e) => {
            eprintln!(
                "[shutdown] failed to spawn kill for process group {}: {}",
                neg_pid, e
            );
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }
    }
}
