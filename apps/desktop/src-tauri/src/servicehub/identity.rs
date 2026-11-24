use std::path::{Path, PathBuf};

use super::{resolve_servicehub_launch_target, SERVICEHUB_EXE_NAME, SERVICEHUB_LEGACY_EXE_NAME};

/// Best-effort read of a Windows process's command line, or None.
///
/// Tries `wmic` first, then falls back to PowerShell `Get-CimInstance`
/// (`wmic` is deprecated / absent on newer Windows). Any failure — the process
/// already exited, neither tool present, non-zero exit, empty output — returns
/// None so the caller fails safe and does NOT kill an unverified PID.
#[cfg(target_os = "windows")]
const PROCESS_COMMAND_LINE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

#[cfg(target_os = "windows")]
fn command_output_with_timeout(mut command: std::process::Command) -> Option<std::process::Output> {
    use std::io::Read;
    use std::process::Stdio;
    use std::thread;
    use std::time::Instant;

    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).map(|_| bytes)
    });

    let deadline = Instant::now() + PROCESS_COMMAND_LINE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(std::time::Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return None;
            }
        }
    };

    Some(std::process::Output {
        status,
        stdout: stdout_reader.join().ok()?.ok()?,
        stderr: stderr_reader.join().ok()?.ok()?,
    })
}

#[cfg(target_os = "windows")]
pub(super) fn windows_process_cmdline(pid: u32) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // wmic
    let mut wmic = std::process::Command::new("wmic");
    wmic.args([
        "process",
        "where",
        &format!("processid={pid}"),
        "get",
        "commandline",
    ])
    .creation_flags(CREATE_NO_WINDOW);
    if let Some(out) = command_output_with_timeout(wmic) {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let value: String = text
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && l.to_lowercase() != "commandline")
                .collect::<Vec<_>>()
                .join(" ");
            if !value.is_empty() {
                return Some(value);
            }
        }
    }

    // PowerShell fallback
    let script = format!(
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); (Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine"
    );
    let mut powershell = std::process::Command::new("powershell");
    powershell
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW);
    if let Some(out) = command_output_with_timeout(powershell) {
        if out.status.success() {
            let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

pub(super) fn servicehub_image_path_is_ours(path: &Path) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    // The legacy name is accepted here (unlike in the launch path) so a Hub left
    // running by a pre-rename build can still be recognized and reaped instead of
    // holding the singleton mutex against every later launch.
    [SERVICEHUB_EXE_NAME, SERVICEHUB_LEGACY_EXE_NAME]
        .iter()
        .any(|name| normalized.ends_with(&format!("/superclaw/servicehub/{name}")))
}

#[cfg(target_os = "windows")]
pub(super) fn windows_process_image_path(pid: u32) -> Option<PathBuf> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const MAX_PATH_CHARS: usize = 32_768;
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut buffer = vec![0_u16; MAX_PATH_CHARS];
    let mut length = buffer.len() as u32;
    let query_ok =
        unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) };
    unsafe {
        let _ = CloseHandle(handle);
    }
    if query_ok == 0 || length == 0 {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(
        &buffer[..length as usize],
    )))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TcpListenerStatus {
    Owned,
    Missing,
    DifferentOwner,
    Unavailable,
}

pub(super) fn classify_tcp_listener_rows(
    port: u16,
    pid: u32,
    rows: impl IntoIterator<Item = (u16, u32, u32)>,
) -> TcpListenerStatus {
    let loopback = u32::from_ne_bytes([127, 0, 0, 1]);
    let mut found_port = false;
    let mut owned = false;

    for (row_port, local_address, owning_pid) in rows {
        if row_port != port || (local_address != loopback && local_address != 0) {
            continue;
        }
        found_port = true;
        if owning_pid != pid {
            return TcpListenerStatus::DifferentOwner;
        }
        if local_address == loopback {
            owned = true;
        }
    }

    if owned {
        TcpListenerStatus::Owned
    } else if found_port {
        TcpListenerStatus::DifferentOwner
    } else {
        TcpListenerStatus::Missing
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReuseListenerDecision {
    Attach,
    Wait,
    Recover,
    Reject,
}

pub(super) fn reuse_listener_decision(
    status: TcpListenerStatus,
    startup_wait_expired: bool,
) -> ReuseListenerDecision {
    match status {
        TcpListenerStatus::Owned => ReuseListenerDecision::Attach,
        TcpListenerStatus::Missing if startup_wait_expired => ReuseListenerDecision::Recover,
        TcpListenerStatus::Missing => ReuseListenerDecision::Wait,
        TcpListenerStatus::DifferentOwner | TcpListenerStatus::Unavailable => {
            ReuseListenerDecision::Reject
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReuseListenerPreflight {
    Ready,
    ProbeFailed,
    RecoveryStarted,
    Rejected,
    Waiting,
}

pub(super) fn run_reuse_listener_preflight(
    verified_listener_status: Option<TcpListenerStatus>,
    startup_wait_expired: bool,
    probe_readiness: impl FnOnce() -> bool,
    recover_missing_listener: impl FnOnce(),
    reject: impl FnOnce(&'static str, &'static str),
) -> ReuseListenerPreflight {
    let status = verified_listener_status.unwrap_or(TcpListenerStatus::Unavailable);
    match reuse_listener_decision(status, startup_wait_expired) {
        ReuseListenerDecision::Attach => {
            if probe_readiness() {
                ReuseListenerPreflight::Ready
            } else {
                ReuseListenerPreflight::ProbeFailed
            }
        }
        ReuseListenerDecision::Wait => ReuseListenerPreflight::Waiting,
        ReuseListenerDecision::Recover => {
            recover_missing_listener();
            ReuseListenerPreflight::RecoveryStarted
        }
        ReuseListenerDecision::Reject => {
            reject(
                "reuse.identity.rejected",
                "ServiceHub reuse endpoint failed process, lockfile, or listener ownership validation",
            );
            ReuseListenerPreflight::Rejected
        }
    }
}

#[cfg(target_os = "windows")]
pub(super) fn tcp_listener_status(port: u16, pid: u32) -> TcpListenerStatus {
    use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };

    const AF_INET: u32 = 2;
    let mut buffer_size = 0u32;
    unsafe {
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut buffer_size,
            0,
            AF_INET,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
    }
    if buffer_size < std::mem::size_of::<u32>() as u32 {
        return TcpListenerStatus::Unavailable;
    }

    let mut buffer = Vec::<u32>::new();
    let mut query_succeeded = false;
    for _ in 0..3 {
        buffer.resize(
            (buffer_size as usize).div_ceil(std::mem::size_of::<u32>()),
            0,
        );
        let capacity_bytes = buffer.len() * std::mem::size_of::<u32>();
        let result = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr().cast(),
                &mut buffer_size,
                0,
                AF_INET,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if result == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        if result != 0 || buffer_size as usize > capacity_bytes {
            return TcpListenerStatus::Unavailable;
        }
        query_succeeded = true;
        break;
    }
    if !query_succeeded {
        return TcpListenerStatus::Unavailable;
    }

    let header_size = std::mem::size_of::<u32>();
    let row_size = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
    let count = buffer[0] as usize;
    if (buffer_size as usize) < header_size
        || count > (buffer_size as usize - header_size) / row_size
    {
        return TcpListenerStatus::Unavailable;
    }

    let rows = (0..count).map(|index| {
        let row = unsafe {
            buffer
                .as_ptr()
                .cast::<u8>()
                .add(header_size + index * row_size)
                .cast::<MIB_TCPROW_OWNER_PID>()
                .read_unaligned()
        };
        (
            u16::from_be((row.dwLocalPort & 0xFFFF) as u16),
            row.dwLocalAddr,
            row.dwOwningPid,
        )
    });
    classify_tcp_listener_rows(port, pid, rows)
}

#[cfg(not(target_os = "windows"))]
pub(super) fn tcp_listener_status(_port: u16, _pid: u32) -> TcpListenerStatus {
    TcpListenerStatus::Unavailable
}

/// After a packaged exe path token in a command line, the next byte must not
/// extend the filename (e.g. `.exe.bak`).
pub(super) fn cmdline_path_token_boundary_ok(bytes: &[u8], after_token: usize) -> bool {
    match bytes.get(after_token) {
        None => true,
        Some(b'"' | b'\'') => true,
        Some(b) if b.is_ascii_whitespace() => true,
        Some(b'-') if bytes.get(after_token + 1) == Some(&b'-') => true,
        _ => false,
    }
}

/// First argv token (executable image path), handling a leading double-quoted path.
pub(super) fn cmdline_argv0(cmdline: &str) -> String {
    let trimmed = cmdline.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with('"') {
        let rest = trimmed.as_bytes().get(1..).unwrap_or_default();
        let end = rest.iter().position(|&b| b == b'"').unwrap_or(rest.len());
        return String::from_utf8_lossy(&rest[..end]).into_owned();
    }
    trimmed
        .split_once(|c: char| c.is_whitespace())
        .map(|(argv0, _)| argv0.to_string())
        .unwrap_or_else(|| trimmed.to_string())
}

pub(super) fn servicehub_packaged_exe_argv0_is_ours(argv0: &str) -> bool {
    let normalized = argv0.replace('\\', "/").to_ascii_lowercase();
    [SERVICEHUB_EXE_NAME, SERVICEHUB_LEGACY_EXE_NAME]
        .iter()
        .any(|name| {
            let suffix = format!("/superclaw/servicehub/{name}");
            if !normalized.ends_with(&suffix) {
                return false;
            }
            cmdline_path_token_boundary_ok(normalized.as_bytes(), normalized.len())
        })
}

pub(super) fn servicehub_packaged_exe_in_cmdline(normalized: &str) -> bool {
    servicehub_packaged_exe_argv0_is_ours(&cmdline_argv0(normalized))
}

/// Dev/module launches must run from a SuperClaw tree (not a coincidental `superclaw` substring).
pub(super) fn module_launch_argv0_under_superclaw_root(argv0: &str) -> bool {
    let path = argv0.replace('\\', "/").to_ascii_lowercase();
    path.contains("/superclaw/") || path.contains("/superclaw-dev/")
}

pub(super) fn servicehub_module_launch_argv0_is_python(argv0: &str) -> bool {
    let path = argv0.replace('\\', "/").to_ascii_lowercase();
    path.ends_with("python")
        || path.ends_with("python3")
        || path.ends_with("python.exe")
        || path.ends_with("python3.exe")
        || path.contains("/python")
        || path.contains("/python3")
}

pub(super) fn servicehub_module_launch_in_cmdline(normalized: &str) -> bool {
    let argv0 = cmdline_argv0(normalized);
    if !module_launch_argv0_under_superclaw_root(&argv0) {
        return false;
    }
    if !servicehub_module_launch_argv0_is_python(&argv0) {
        return false;
    }
    const TOKEN: &str = "-m servicehub";
    let normalized = normalized.to_ascii_lowercase();
    let mut search_from = 0usize;
    while let Some(rel) = normalized[search_from..].find(TOKEN) {
        let idx = search_from + rel;
        if idx > 0 && !normalized.as_bytes()[idx - 1].is_ascii_whitespace() {
            search_from = idx + 1;
            continue;
        }
        let after = idx + TOKEN.len();
        if cmdline_path_token_boundary_ok(normalized.as_bytes(), after) {
            return true;
        }
        search_from = idx + 1;
    }
    false
}

#[cfg(target_os = "windows")]
pub(super) fn windows_command_line_args(cmdline: &str) -> Option<Vec<String>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::UI::Shell::CommandLineToArgvW;

    if cmdline.contains('\0') || cmdline.trim().is_empty() {
        return None;
    }
    let wide: Vec<u16> = cmdline.encode_utf16().chain(Some(0)).collect();
    let mut count = 0;
    let argv = unsafe { CommandLineToArgvW(wide.as_ptr(), &mut count) };
    if argv.is_null() {
        return None;
    }
    let mut args = Vec::new();
    for index in 0..count {
        let argument = unsafe { *argv.add(index as usize) };
        let mut length = 0;
        while unsafe { *argument.add(length) } != 0 {
            length += 1;
        }
        args.push(String::from_utf16_lossy(unsafe {
            std::slice::from_raw_parts(argument, length)
        }));
    }
    unsafe {
        LocalFree(argv.cast());
    }
    Some(args)
}

#[cfg(target_os = "windows")]
pub(super) fn servicehub_module_invocation_in_cmdline(cmdline: &str) -> bool {
    let Some(args) = windows_command_line_args(cmdline) else {
        return false;
    };
    let mut arguments = args.iter().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "-m" => {
                return arguments
                    .next()
                    .is_some_and(|module| module == "servicehub")
            }
            "-u" | "-B" | "-E" | "-s" | "-S" | "-I" | "-O" | "-OO" | "-q" => {}
            "-X" | "-W" => {
                if arguments.next().is_none() {
                    return false;
                }
            }
            option if option.starts_with("-X") || option.starts_with("-W") => {}
            _ => return false,
        }
    }
    false
}

#[cfg(not(target_os = "windows"))]
pub(super) fn servicehub_module_invocation_in_cmdline(cmdline: &str) -> bool {
    let tokens = cmdline.split_whitespace().collect::<Vec<_>>();
    tokens
        .windows(2)
        .any(|arguments| arguments == ["-m", "servicehub"])
}

pub(super) fn process_path_normalized(path: &str) -> String {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    normalized
        .strip_prefix("//?/")
        .unwrap_or(&normalized)
        .to_string()
}

pub(super) fn python_executable_path(path: &str) -> bool {
    matches!(
        process_path_normalized(path).rsplit('/').next(),
        Some("python.exe" | "python3.exe" | "pythonw.exe" | "python" | "python3")
    )
}

fn executable_path_matches(image_path: &str, argv0: &str) -> bool {
    let normalized_image = process_path_normalized(image_path);
    let normalized_argv0 = process_path_normalized(argv0);
    if normalized_image == normalized_argv0 {
        return true;
    }
    let argv0_path = Path::new(argv0);
    let normalized_argv0_bytes = normalized_argv0.as_bytes();
    let is_windows_absolute = normalized_argv0_bytes.len() >= 3
        && normalized_argv0_bytes[0].is_ascii_alphabetic()
        && normalized_argv0_bytes[1] == b':'
        && normalized_argv0_bytes[2] == b'/';
    if !argv0_path.is_absolute() && !normalized_argv0.starts_with('/') && !is_windows_absolute {
        return normalized_image.rsplit('/').next() == normalized_argv0.rsplit('/').next();
    }
    let canonical_match = std::fs::canonicalize(image_path)
        .and_then(|image| std::fs::canonicalize(argv0_path).map(|argv0| (image, argv0)))
        .is_ok_and(|(image, argv0)| {
            process_path_normalized(&image.to_string_lossy())
                == process_path_normalized(&argv0.to_string_lossy())
        });
    if canonical_match {
        return true;
    }
    #[cfg(target_os = "windows")]
    return windows_venv_redirector_matches(image_path, argv0);
    #[cfg(not(target_os = "windows"))]
    false
}

#[cfg(target_os = "windows")]
fn windows_venv_redirector_matches(image_path: &str, argv0: &str) -> bool {
    let redirector_path = Path::new(argv0);
    if !python_executable_path(argv0) || !python_executable_path(image_path) {
        return false;
    }
    let Some(scripts_dir) = redirector_path.parent() else {
        return false;
    };
    if !scripts_dir
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("Scripts"))
    {
        return false;
    }
    let Some(venv_dir) = scripts_dir.parent() else {
        return false;
    };
    let Ok(config) = std::fs::read_to_string(venv_dir.join("pyvenv.cfg")) else {
        return false;
    };
    let Some(redirector_name) = redirector_path.file_name() else {
        return false;
    };
    let normalized_redirector_name = process_path_normalized(&redirector_name.to_string_lossy());
    let Ok(image) = std::fs::canonicalize(image_path) else {
        return false;
    };
    let normalized_image = process_path_normalized(&image.to_string_lossy());

    config.lines().any(|line| {
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        let value = value.trim().trim_matches('"');
        let candidate = match key.trim().to_ascii_lowercase().as_str() {
            "home" => Path::new(value).join(redirector_name),
            "executable" => PathBuf::from(value),
            _ => return false,
        };
        std::fs::canonicalize(candidate).is_ok_and(|candidate| {
            process_path_normalized(&candidate.to_string_lossy()) == normalized_image
                && process_path_normalized(
                    &candidate.file_name().unwrap_or_default().to_string_lossy(),
                ) == normalized_redirector_name
        })
    })
}

#[cfg(test)]
pub(super) fn servicehub_reuse_process_matches(image_path: &str, cmdline: &str) -> bool {
    servicehub_reuse_process_matches_in_context(image_path, cmdline)
}

fn servicehub_reuse_process_matches_in_context(image_path: &str, cmdline: &str) -> bool {
    if servicehub_image_path_is_ours(Path::new(image_path)) {
        return servicehub_packaged_role_matches_in_context(image_path, cmdline);
    }
    let argv0 = cmdline_argv0(cmdline);
    python_executable_path(image_path)
        && executable_path_matches(image_path, &argv0)
        && servicehub_module_invocation_in_cmdline(cmdline)
}

pub(super) fn servicehub_dispatch_role_is_servicehub(cmdline: &str) -> bool {
    servicehub_dispatch_role_matches(cmdline, false)
}

fn servicehub_dispatch_role_matches(cmdline: &str, allow_implicit_hub: bool) -> bool {
    #[cfg(target_os = "windows")]
    let tokens = match windows_command_line_args(cmdline) {
        Some(args) => args,
        None => return false,
    };
    #[cfg(not(target_os = "windows"))]
    let tokens = cmdline
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut selected_role = None;
    let mut index = 1;
    while index < tokens.len() {
        if tokens[index] == "--service" {
            let Some(role) = tokens.get(index + 1) else {
                return false;
            };
            selected_role = Some(role.as_str());
            index += 2;
        } else if let Some(role) = tokens[index].strip_prefix("--service=") {
            selected_role = Some(role);
            index += 1;
        } else {
            index += 1;
        }
    }
    match selected_role {
        Some(role) => role.eq_ignore_ascii_case("servicehub"),
        None => allow_implicit_hub,
    }
}

pub(super) fn servicehub_packaged_role_matches(image_path: &str, cmdline: &str) -> bool {
    servicehub_packaged_role_matches_in_context(image_path, cmdline)
}

fn servicehub_packaged_role_matches_in_context(image_path: &str, cmdline: &str) -> bool {
    let normalized_image = process_path_normalized(image_path);
    let is_legacy_dedicated_exe = normalized_image
        .rsplit('/')
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case(SERVICEHUB_LEGACY_EXE_NAME));
    let role_matches = if is_legacy_dedicated_exe {
        servicehub_dispatch_role_matches(cmdline, true)
    } else {
        servicehub_dispatch_role_is_servicehub(cmdline)
    };
    executable_path_matches(image_path, &cmdline_argv0(cmdline)) && role_matches
}

#[cfg(test)]
pub(super) fn servicehub_reuse_image_matches_launch_target(
    image_path: &str,
    cmdline: &str,
    launch_command: &str,
) -> bool {
    servicehub_reuse_image_matches_launch_target_in_context(image_path, cmdline, launch_command)
}

fn servicehub_reuse_image_matches_launch_target_in_context(
    image_path: &str,
    cmdline: &str,
    launch_command: &str,
) -> bool {
    if python_executable_path(launch_command)
        || !executable_path_matches(image_path, launch_command)
    {
        return false;
    }
    servicehub_packaged_role_matches_in_context(image_path, cmdline)
        || servicehub_bare_shared_hub_matches(image_path, cmdline)
}

fn servicehub_bare_shared_hub_matches(image_path: &str, cmdline: &str) -> bool {
    let is_shared_bundle = process_path_normalized(image_path)
        .rsplit('/')
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case(SERVICEHUB_EXE_NAME));
    is_shared_bundle
        && executable_path_matches(image_path, &cmdline_argv0(cmdline))
        && servicehub_dispatch_role_matches(cmdline, true)
}

fn servicehub_reuse_legacy_image_matches_launch_target(
    image_path: &str,
    cmdline: &str,
    launch_command: &str,
) -> bool {
    let image = Path::new(image_path);
    let target = Path::new(launch_command);
    let same_parent = image
        .parent()
        .zip(target.parent())
        .is_some_and(|(image_parent, target_parent)| {
            let image_parent = std::fs::canonicalize(image_parent)
                .map(|path| process_path_normalized(&path.to_string_lossy()))
                .unwrap_or_else(|_| process_path_normalized(&image_parent.to_string_lossy()));
            let target_parent = std::fs::canonicalize(target_parent)
                .map(|path| process_path_normalized(&path.to_string_lossy()))
                .unwrap_or_else(|_| process_path_normalized(&target_parent.to_string_lossy()));
            image_parent == target_parent
        });
    let is_legacy_image = image
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(SERVICEHUB_LEGACY_EXE_NAME));

    same_parent
        && is_legacy_image
        && servicehub_packaged_role_matches_in_context(image_path, cmdline)
}

fn servicehub_reuse_python_module_matches_in_context(
    image_path: &str,
    cmdline: &str,
    launch_command: &str,
    allow_python_reuse: bool,
) -> bool {
    let target_is_python = python_executable_path(launch_command);
    let argv0 = cmdline_argv0(cmdline);
    allow_python_reuse
        && python_executable_path(image_path)
        && (!target_is_python || executable_path_matches(image_path, launch_command))
        && executable_path_matches(image_path, &argv0)
        && servicehub_module_invocation_in_cmdline(cmdline)
}

#[cfg(test)]
pub(super) fn servicehub_reuse_process_matches_launch_target(
    image_path: &str,
    cmdline: &str,
    launch_command: &str,
) -> bool {
    servicehub_reuse_process_matches_launch_target_with_policy(
        image_path,
        cmdline,
        launch_command,
        false,
    )
}

#[cfg(test)]
pub(super) fn servicehub_reuse_process_matches_launch_target_with_command(
    image_path: &str,
    cmdline: &str,
    launch_command: &str,
) -> bool {
    servicehub_reuse_process_matches_launch_target_with_policy(
        image_path,
        cmdline,
        launch_command,
        true,
    )
}

pub(super) fn servicehub_reuse_process_matches_launch_target_with_policy(
    image_path: &str,
    cmdline: &str,
    launch_command: &str,
    allow_python_reuse: bool,
) -> bool {
    servicehub_reuse_image_matches_launch_target_in_context(image_path, cmdline, launch_command)
        || servicehub_reuse_legacy_image_matches_launch_target(image_path, cmdline, launch_command)
        || servicehub_reuse_python_module_matches_in_context(
            image_path,
            cmdline,
            launch_command,
            allow_python_reuse,
        )
}

#[cfg(test)]
mod trusted_reuse_identity_tests {
    use super::{
        servicehub_reuse_process_matches_launch_target,
        servicehub_reuse_process_matches_launch_target_with_policy,
    };

    #[test]
    fn reuse_process_identity_accepts_resolved_packaged_launch_paths() {
        let sibling_build =
            r#"C:\work\SuperClaw\build\Release\servicehub\superclaw-services.exe"#;
        assert!(servicehub_reuse_process_matches_launch_target(
            sibling_build,
            r#""C:\work\SuperClaw\build\Release\servicehub\superclaw-services.exe" --service servicehub --port 0"#,
            sibling_build,
        ));
        assert!(!servicehub_reuse_process_matches_launch_target(
            sibling_build,
            r#""C:\work\SuperClaw\build\Release\servicehub\superclaw-services.exe" --service llmrouter_manager --port 18821"#,
            sibling_build,
        ));

        let executable_override = r#"D:\custom\servicehub\servicehub-bundle.exe"#;
        assert!(servicehub_reuse_process_matches_launch_target(
            executable_override,
            r#""D:\custom\servicehub\servicehub-bundle.exe" --service servicehub --port 0"#,
            executable_override,
        ));
        assert!(!servicehub_reuse_process_matches_launch_target(
            r#"D:\other\servicehub-bundle.exe"#,
            r#""D:\other\servicehub-bundle.exe" --service servicehub"#,
            executable_override,
        ));
    }

    #[test]
    fn installed_target_rejects_python_module_lookalike() {
        let installed_exe =
            r#"C:\Program Files\Intel\SuperClaw\servicehub\superclaw-services.exe"#;
        let python = r"C:\work\SuperClaw\host\.venv\Scripts\python.exe";
        let python_command = format!("\"{python}\" -u -m servicehub --port 0");

        assert!(!servicehub_reuse_process_matches_launch_target_with_policy(
            python,
            &python_command,
            installed_exe,
            false,
        ));
        assert!(servicehub_reuse_process_matches_launch_target_with_policy(
            python,
            &python_command,
            python,
            true,
        ));
    }

    #[test]
    fn installed_target_rejects_packaged_lookalike_path() {
        let installed_exe =
            "/opt/intel/SuperClaw/servicehub/superclaw-services.exe";
        let lookalike_exe = "/tmp/SuperClaw/servicehub/superclaw-services.exe";
        let command = format!("\"{lookalike_exe}\" --service servicehub --port 0");

        assert!(!servicehub_reuse_process_matches_launch_target_with_policy(
            lookalike_exe,
            &command,
            installed_exe,
            false,
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn tcp_listener_status_distinguishes_owner_from_conflict() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind listener");
        let port = listener.local_addr().expect("listener address").port();
        let pid = std::process::id();

        assert_eq!(
            super::tcp_listener_status(port, pid),
            super::TcpListenerStatus::Owned
        );
        assert_eq!(
            super::tcp_listener_status(port, pid.wrapping_add(1)),
            super::TcpListenerStatus::DifferentOwner
        );
    }
}

#[cfg(target_os = "windows")]
pub(super) fn servicehub_reuse_process_is_ours(pid: u32) -> bool {
    let Some(image_path) = windows_process_image_path(pid) else {
        return false;
    };
    let Ok(launch_target) = resolve_servicehub_launch_target(0) else {
        return false;
    };
    let Some(cmdline) = windows_process_cmdline(pid) else {
        return false;
    };
    if servicehub_reuse_process_matches_launch_target_with_policy(
        &image_path.to_string_lossy(),
        &cmdline,
        &launch_target.command,
        launch_target.allow_python_reuse,
    ) {
        return true;
    }
    false
}

#[cfg(not(target_os = "windows"))]
pub(super) fn servicehub_reuse_process_is_ours(pid: u32) -> bool {
    servicehub_pid_is_ours(pid)
}

pub(super) fn servicehub_cmdline_is_ours(cmdline: &str) -> bool {
    let normalized = cmdline.replace('\\', "/").to_ascii_lowercase();
    (servicehub_packaged_exe_in_cmdline(&normalized)
        && servicehub_packaged_role_matches(&cmdline_argv0(cmdline), cmdline))
        || servicehub_module_launch_in_cmdline(&normalized)
}

/// Confirm a PID read from `servicehub.lock` still belongs to a ServiceHub
/// process before we force-kill it.
///
/// Windows recycles PIDs, so a stale lockfile can point at a PID now owned by an
/// unrelated process. We only authorize the kill when the PID's command line
/// identifies the Hub role (module launch `-m servicehub`, an explicit
/// `--service servicehub` for the shared image, or the legacy dedicated Hub
/// executable). A bare shared image with no role argument is also accepted, so
/// a Hub left running by an older build can be reused or cleaned up after an
/// update; a child launched by hand with an inherited `SERVICEHUB_SERVICE_NAME`
/// would match too. If the command line cannot be read, we conservatively
/// decline to kill.
#[cfg(target_os = "windows")]
pub(super) fn servicehub_pid_is_ours(pid: u32) -> bool {
    let Some(cmdline) = windows_process_cmdline(pid) else {
        eprintln!(
            "[servicehub] cannot verify pid={pid} cli — declining to kill (PID reuse safety)"
        );
        return false;
    };
    let Some(image_path) = windows_process_image_path(pid) else {
        return false;
    };
    let Ok(launch_target) = resolve_servicehub_launch_target(0) else {
        return false;
    };
    servicehub_reuse_process_matches_launch_target_with_policy(
        &image_path.to_string_lossy(),
        &cmdline,
        &launch_target.command,
        launch_target.allow_python_reuse,
    )
}

#[cfg(target_os = "linux")]
pub(super) fn unix_process_cmdline(pid: u32) -> Option<String> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let cmdline = bytes
        .split(|byte| *byte == 0)
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = cmdline.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(target_os = "linux")]
pub(super) fn unix_process_exe_path(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(target_os = "linux")]
pub(super) fn unix_real_uid_from_proc_status(status_path: &str) -> Option<u32> {
    let status = std::fs::read_to_string(status_path).ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("Uid:") {
            return rest.split_whitespace().next()?.parse().ok();
        }
    }
    None
}

#[cfg(target_os = "linux")]
pub(super) fn current_unix_real_uid() -> Option<u32> {
    unix_real_uid_from_proc_status("/proc/self/status")
}

#[cfg(target_os = "linux")]
pub(super) fn unix_process_real_uid(pid: u32) -> Option<u32> {
    unix_real_uid_from_proc_status(&format!("/proc/{pid}/status"))
}

#[cfg(target_os = "macos")]
pub(super) fn current_unix_real_uid() -> Option<u32> {
    use std::process::Command;

    let output = Command::new("id").arg("-u").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

#[cfg(target_os = "macos")]
pub(super) fn unix_process_real_uid(pid: u32) -> Option<u32> {
    use std::process::Command;

    let output = Command::new("ps")
        .arg("-p")
        .arg(pid.to_string())
        .args(["-o", "uid="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// Force-kill authorization is limited to processes owned by this login session.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn unix_process_owned_by_current_user(pid: u32) -> bool {
    match (current_unix_real_uid(), unix_process_real_uid(pid)) {
        (Some(me), Some(theirs)) => me == theirs,
        _ => false,
    }
}

#[cfg(target_os = "macos")]
pub(super) fn unix_process_cmdline(pid: u32) -> Option<String> {
    use std::process::Command;

    let output = Command::new("ps")
        .arg("-p")
        .arg(pid.to_string())
        .args(["-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Confirm a lockfile PID on Unix before force-kill (same contract as Windows).
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn servicehub_pid_is_ours(pid: u32) -> bool {
    if !unix_process_owned_by_current_user(pid) {
        return false;
    }
    match unix_process_cmdline(pid) {
        Some(cmdline) => {
            #[cfg(target_os = "linux")]
            {
                if let Some(image) = unix_process_exe_path(pid) {
                    let Ok(launch_target) = resolve_servicehub_launch_target(0) else {
                        return false;
                    };
                    return servicehub_reuse_process_matches_launch_target_with_policy(
                        &image.to_string_lossy(),
                        &cmdline,
                        &launch_target.command,
                        launch_target.allow_python_reuse,
                    );
                }
                return false;
            }
            #[cfg(target_os = "macos")]
            {
                let Ok(launch_target) = resolve_servicehub_launch_target(0) else {
                    return false;
                };
                servicehub_reuse_process_matches_launch_target_with_policy(
                    &cmdline_argv0(&cmdline),
                    &cmdline,
                    &launch_target.command,
                    launch_target.allow_python_reuse,
                )
            }
            #[cfg(not(target_os = "macos"))]
            {
                false
            }
        }
        None => {
            eprintln!(
                "[servicehub] cannot verify pid={pid} command line — declining to kill (PID reuse safety)"
            );
            false
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub(super) fn servicehub_pid_is_ours(_pid: u32) -> bool {
    false
}

/// Whether the PID recorded in `servicehub.lock` still refers to a live process.
/// Used after a declined force-kill to decide if the kept-alive Hub is still up.
#[cfg(target_os = "windows")]
pub(super) fn lockfile_pid_process_is_running(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }
    // An exited process still opens while any handle to it is held; only its exit code says it ran.
    let mut code = 0u32;
    let queried = unsafe { GetExitCodeProcess(handle, &mut code) } != 0;
    unsafe { CloseHandle(handle) };
    queried && code == STILL_ACTIVE as u32
}

#[cfg(target_os = "linux")]
pub(super) fn lockfile_pid_process_is_running(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(target_os = "macos")]
pub(super) fn lockfile_pid_process_is_running(pid: u32) -> bool {
    std::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub(super) fn lockfile_pid_process_is_running(_pid: u32) -> bool {
    false
}

pub(super) fn parse_servicehub_tasklist_candidates(output: &str) -> Vec<u32> {
    output
        .lines()
        .filter_map(|line| {
            let fields = line
                .trim()
                .trim_matches('"')
                .split("\",\"")
                .collect::<Vec<_>>();
            if fields.len() < 2 {
                return None;
            }
            let image_name = fields[0].to_ascii_lowercase();
            if !matches!(
                image_name.as_str(),
                SERVICEHUB_EXE_NAME | SERVICEHUB_LEGACY_EXE_NAME | "python.exe" | "pythonw.exe"
            ) {
                return None;
            }
            fields[1].parse::<u32>().ok()
        })
        .collect()
}

#[cfg(target_os = "windows")]
pub(super) fn servicehub_pids_without_lockfile() -> Vec<u32> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let Ok(output) = std::process::Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_servicehub_tasklist_candidates(&String::from_utf8_lossy(&output.stdout))
        .into_iter()
        .filter(|pid| servicehub_pid_is_ours(*pid))
        .collect()
}

#[cfg(target_os = "linux")]
pub(super) fn servicehub_pids_without_lockfile() -> Vec<u32> {
    let mut pids = Vec::new();
    let entries = match std::fs::read_dir("/proc") {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let pid_str = name.to_string_lossy();
        if !pid_str.chars().all(|ch| ch.is_ascii_digit()) {
            continue;
        }
        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        if servicehub_pid_is_ours(pid) {
            pids.push(pid);
        }
    }
    pids
}

#[cfg(target_os = "macos")]
pub(super) fn servicehub_pids_without_lockfile() -> Vec<u32> {
    use std::process::Command;

    let me = current_unix_real_uid();
    let output = match Command::new("ps")
        .args(["-ax", "-o", "uid=", "-o", "pid=", "-o", "command="])
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return Vec::new(),
    };
    let mut pids = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let uid_str = parts.next().unwrap_or("");
        let pid_str = parts.next().unwrap_or("");
        let cmdline = parts.collect::<Vec<_>>().join(" ");
        let Ok(uid) = uid_str.parse::<u32>() else {
            continue;
        };
        if me.is_some_and(|expected| uid != expected) {
            continue;
        }
        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        if servicehub_pid_is_ours(pid) {
            pids.push(pid);
        }
    }
    pids
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub(super) fn servicehub_pids_without_lockfile() -> Vec<u32> {
    Vec::new()
}
