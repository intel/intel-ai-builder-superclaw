//! Starts SuperClaw again when an in-app update's installer exits without doing so itself.
//!
//! The installer relaunches SuperClaw only after a successful install (`SC_LaunchSuperClaw`), and
//! the shell exits as soon as the installer starts, so a cancelled or failed install would leave
//! the app closed. A hidden, unelevated `powershell.exe` outside the install directory waits for
//! the installer and then for this process, through two inherited SYNCHRONIZE-only handles, and
//! starts SuperClaw. The installer's handle is the one `ShellExecuteExW` returned: a fresh
//! `OpenProcess` by PID is subject to the elevated process's DACL and mandatory label, and fails
//! when a different administrator approved UAC. After a successful install SuperClaw is already
//! running and the watcher starts nothing.

use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessId, CREATE_NO_WINDOW};

const INSTALLER_WAIT_MS: u32 = 2 * 60 * 60 * 1000;
const APP_EXIT_WAIT_MS: u32 = 2 * 60 * 1000;
const LOG_FILE_NAME: &str = "ota-relaunch-watcher.log";

/// Start the watcher for `installer`; returns its process id.
pub fn start(installer: &OwnedHandle) -> Result<u32, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let log = crate::logging::resolve_log_dir()
        .ok_or("no log directory")?
        .join(LOG_FILE_NAME);
    spawn(installer, &exe, &log)
}

fn spawn(installer: &OwnedHandle, exe: &Path, log: &Path) -> Result<u32, String> {
    let installer_pid = unsafe { GetProcessId(installer.as_raw_handle()) };
    let installer_wait = win::inheritable_synchronize(installer.as_raw_handle())?;
    let app_wait = win::inheritable_synchronize(unsafe { GetCurrentProcess() })?;
    let script = watcher_script(
        installer_wait.as_raw_handle() as usize,
        app_wait.as_raw_handle() as usize,
        installer_pid,
        exe,
        log,
    )
    .ok_or("install path cannot be quoted")?;
    let system = win::system_directory()?;
    // Rebuilt for the user: this process's own environment carries what it set for itself
    // (telemetry credentials among them), which a relaunched newer build must not inherit.
    let child = Command::new(system.join(r"WindowsPowerShell\v1.0\powershell.exe"))
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .current_dir(&system)
        .env_clear()
        .envs(win::user_environment()?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;
    Ok(child.id())
}

/// The `-Command` script. It quotes only with PowerShell single quotes, so the command line
/// needs no escaping of its own; `None` for a path that is not Unicode or holds a `"`.
fn watcher_script(
    installer: usize,
    app: usize,
    installer_pid: u32,
    exe: &Path,
    log: &Path,
) -> Option<String> {
    let quote = |path: &Path| {
        let text = path.to_str().filter(|text| !text.contains('"'))?;
        Some(format!("'{}'", text.replace('\'', "''")))
    };
    let name = quote(Path::new(exe.file_stem()?))?;
    let (exe_dir, exe, log) = (quote(exe.parent()?)?, quote(exe)?, quote(log)?);
    // The `already_running` check closes the race a successful install would otherwise start: the
    // installer launches SuperClaw just before it exits, and a second launch that lands before
    // the first has a window would run as a second full instance.
    Some(format!(
        "$ErrorActionPreference='Stop'; \
         function L($o) {{ try {{ Add-Content -LiteralPath {log} -Value ((Get-Date -Format o) + ' ota relaunch_watcher installer_pid={installer_pid} outcome=' + $o) }} catch {{}} }}; \
         function W($h, $ms) {{ $e = New-Object System.Threading.ManualResetEvent $false; $e.SafeWaitHandle = New-Object Microsoft.Win32.SafeHandles.SafeWaitHandle ([IntPtr]$h), $true; $e.WaitOne($ms) }}; \
         try {{ \
         if (-not (W {installer} {INSTALLER_WAIT_MS})) {{ L 'installer_timeout'; exit }}; \
         if (-not (W {app} {APP_EXIT_WAIT_MS})) {{ L 'app_still_running'; exit }}; \
         if (Get-Process -Name {name} -ErrorAction SilentlyContinue) {{ L 'already_running'; exit }}; \
         Start-Process -FilePath {exe} -WorkingDirectory {exe_dir}; L 'relaunched' \
         }} catch {{ L ('failed:' + $_.Exception.GetType().Name) }}"
    ))
}

mod win {
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use std::path::PathBuf;
    use windows_sys::Win32::Foundation::{CloseHandle, DuplicateHandle, HANDLE};
    use windows_sys::Win32::Security::{TOKEN_DUPLICATE, TOKEN_QUERY};
    use windows_sys::Win32::System::Environment::{
        CreateEnvironmentBlock, DestroyEnvironmentBlock,
    };
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcessToken, PROCESS_SYNCHRONIZE,
    };

    /// A new inheritable handle to `source` carrying only SYNCHRONIZE; closed when dropped.
    pub fn inheritable_synchronize(source: HANDLE) -> Result<OwnedHandle, String> {
        let mut target: HANDLE = std::ptr::null_mut();
        let process = unsafe { GetCurrentProcess() };
        if unsafe {
            DuplicateHandle(
                process,
                source,
                process,
                &mut target,
                PROCESS_SYNCHRONIZE,
                1,
                0,
            )
        } == 0
        {
            return Err(format!(
                "DuplicateHandle: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(unsafe { OwnedHandle::from_raw_handle(target) })
    }

    pub fn system_directory() -> Result<PathBuf, String> {
        let mut buffer = [0u16; 260];
        let len = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
        if len == 0 || len >= buffer.len() {
            return Err(format!(
                "GetSystemDirectoryW: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..len])))
    }

    /// The environment Windows builds for this user, without this process's changes. Drive-cwd
    /// entries (`=C:=...`) are left out.
    pub fn user_environment() -> Result<Vec<(String, String)>, String> {
        let mut token: HANDLE = std::ptr::null_mut();
        if unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_QUERY | TOKEN_DUPLICATE,
                &mut token,
            )
        } == 0
        {
            return Err(format!(
                "OpenProcessToken: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut block: *mut core::ffi::c_void = std::ptr::null_mut();
        let created = unsafe { CreateEnvironmentBlock(&mut block, token, 0) } != 0;
        let error = std::io::Error::last_os_error();
        unsafe { CloseHandle(token) };
        if !created {
            return Err(format!("CreateEnvironmentBlock: {error}"));
        }
        let mut vars = Vec::new();
        let mut cursor = block as *const u16;
        loop {
            // SAFETY: the block is a run of NUL-terminated strings ended by an empty one.
            let len = (0..)
                .take_while(|&i| unsafe { *cursor.add(i) } != 0)
                .count();
            if len == 0 {
                break;
            }
            let entry =
                String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(cursor, len) });
            if let Some((name, value)) = entry.split_once('=').filter(|(name, _)| !name.is_empty())
            {
                vars.push((name.to_string(), value.to_string()));
            }
            cursor = unsafe { cursor.add(len + 1) };
        }
        unsafe { DestroyEnvironmentBlock(block) };
        Ok(vars)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn script(exe: &str) -> Option<String> {
        let log = PathBuf::from(r"C:\Users\o'neil\AppData\Local\SuperClaw\app\w.log");
        watcher_script(0x1a4, 0x1b8, 4242, &PathBuf::from(exe), &log)
    }

    #[test]
    fn the_script_waits_on_both_handles_with_bounds_then_starts_the_installed_exe() {
        let script = script(r"C:\Program Files\Intel\SuperClaw\SuperClaw.exe").expect("script");
        assert!(script.contains("W 420 7200000"), "{script}");
        assert!(script.contains("W 440 120000"), "{script}");
        assert!(
            script.contains("Get-Process -Name 'SuperClaw' "),
            "{script}"
        );
        assert!(script.contains(
            r"Start-Process -FilePath 'C:\Program Files\Intel\SuperClaw\SuperClaw.exe' -WorkingDirectory 'C:\Program Files\Intel\SuperClaw'"
        ));
        assert!(script.contains("installer_pid=4242 outcome="));
        assert!(
            script.contains(r"-LiteralPath 'C:\Users\o''neil\AppData\Local\SuperClaw\app\w.log'")
        );
        assert!(
            !script.contains('"'),
            "the command line must need no escaping: {script}"
        );
    }

    #[test]
    fn a_path_that_cannot_be_single_quoted_is_refused() {
        assert!(script("C:\\Bad\"Dir\\SuperClaw.exe").is_none());
    }

    #[test]
    fn the_user_environment_excludes_what_this_process_set() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        std::env::set_var("SUPERCLAW_RELAUNCH_WATCHER_TEST", "1");
        let vars = win::user_environment().expect("environment block");
        std::env::remove_var("SUPERCLAW_RELAUNCH_WATCHER_TEST");
        assert!(vars
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("SystemRoot")));
        assert!(!vars
            .iter()
            .any(|(name, _)| name == "SUPERCLAW_RELAUNCH_WATCHER_TEST"));
        assert!(!vars
            .iter()
            .any(|(name, _)| name.is_empty() || name.starts_with('=')));
    }
}
