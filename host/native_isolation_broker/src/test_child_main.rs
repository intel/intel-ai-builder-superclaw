//! Unelevated fixed-behavior child for the broker's suspended Job launch boundary.
//!
//! Two command lines and nothing else. Each is matched exactly and refused if it differs by a single
//! character, so this binary can never be repurposed as a way to run something else: there is no
//! argument that names a program, a path or a stream.
//!
//! `--sleep-ms 60000` is the form the shipped catalog's test role produces. In probe mode it spawns
//! exactly one grandchild. That exists so a test can prove the property that matters about the Job
//! boundary: a descendant this adapter never launched still joins the role's Job and still dies with it.
//! The probe variable is removed from the grandchild's environment, so the tree is exactly two processes
//! deep by construction rather than by timing.
//!
//! In probe mode the role also prints one `superclaw-test-role-observation` line to its standard output,
//! which is its log: the window station and desktop it is connected to, the desktop it was created with
//! and the one its parent (the supervisor) was, the attributes of its own and its parent's logon SIDs, the
//! UI restrictions of the Job it is in, and its desktop's descriptor. `tests/tier_desktop.rs` reads it,
//! because from inside the Job is the only place an unelevated test can ask those questions. It is the
//! role's own account and is evidence for that test only.
//!
//! `--report-io` is the form that makes a role's standard streams observable. It writes a known line to
//! each of standard output and standard error, reports the directory it was started in, and echoes what
//! it read from standard input. Nothing in the catalog produces this form - the test role's argv is fixed
//! at the sleeping one - so it is reachable only from a test that builds a launch spec itself.
//!
//! Echoing standard input is deliberate and is the only way to prove a bounded payload arrived
//! byte-for-byte and was followed by end-of-file. It is safe here because the caller of this form is a
//! test choosing its own sentinel; no production role echoes its input, and the one production payload
//! that carries secrets goes to a role whose own code never prints it.

use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;
use windows_sys::Win32::System::Threading::DETACHED_PROCESS;

/// Declared by the catalog resolution for the test role, never inherited: the same-account launch
/// path builds the role environment from an allowlist plus the declared overlay, so this variable is
/// present only when the role was launched with it on purpose.
const PROBE_VARIABLE: &str = "SUPERCLAW_TEST_ROLE_PROBE";

/// The most this child will read from standard input. Larger than any payload a launch may deliver, so
/// a truncated echo means the launch truncated it.
const STDIN_LIMIT: u64 = 64 * 1024;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [sleep_flag, sleep_ms] if sleep_flag == "--sleep-ms" && sleep_ms == "60000" => sleep_mode(),
        [mode] if mode == "--report-io" => report_io(),
        _ => ExitCode::FAILURE,
    }
}

fn sleep_mode() -> ExitCode {
    if std::env::var_os(PROBE_VARIABLE).is_some() {
        let mut output = std::io::stdout();
        let _ = writeln!(output, "{}", observation::line());
        let _ = output.flush();
        if let Some(line) = boundary_checks::run() {
            let _ = writeln!(output, "{line}");
            let _ = output.flush();
        }
        if spawn_one_grandchild().is_err() {
            return ExitCode::FAILURE;
        }
    }
    std::thread::sleep(Duration::from_secs(60));
    ExitCode::SUCCESS
}

/// Fixed Win32 observations used only when the opt-in tier test places its sentinel.
///
/// This does not launch a program or accept an executable, path, access mask or operation from the
/// request. The child still always spawns exactly its one fixed grandchild.
mod boundary_checks {
    use std::fs;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseWindowStation, OpenWindowStationW,
    };
    use windows_sys::Win32::System::Threading::{
        CreateMutexW, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    const REQUEST: &str = r"boundary-data\role-boundary-checks.txt";
    const CLAIMED: &str = r"boundary-data\role-boundary-checks-claimed.txt";
    const READY: &str = r"boundary-data\role-boundary-ready";

    pub fn run() -> Option<String> {
        fs::rename(REQUEST, CLAIMED).ok()?;
        let request = fs::read_to_string(CLAIMED).ok()?;
        let owner = target(&request, "owner")?;
        let mut fields = vec![
            field("plain_mutex", create_mutex("SuperClaw3838Boundary")),
            field("local_mutex", create_mutex(r"Local\SuperClaw3838Boundary")),
            field("global_mutex", create_mutex(r"Global\SuperClaw3838Boundary")),
            field("winsta0", open_winsta0()),
            field("owner_vm_read", open_process(owner, PROCESS_VM_READ)),
        ];
        fs::write(READY, b"ready").ok()?;
        let deadline = Instant::now() + Duration::from_secs(20);
        let bootstrap = loop {
            if let Some(pid) = fs::read_to_string(CLAIMED)
                .ok()
                .and_then(|text| target(&text, "bootstrap"))
            {
                break open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION);
            }
            if Instant::now() >= deadline {
                break u32::MAX;
            }
            std::thread::sleep(Duration::from_millis(2));
        };
        fields.push(field("bootstrap_process", bootstrap));
        Some(format!("superclaw-role-boundary-checks {}", fields.join(" ")))
    }

    fn target(text: &str, name: &str) -> Option<u32> {
        text.lines().find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key == name).then(|| value.parse().ok()).flatten()
        })
    }

    fn field(name: &str, value: u32) -> String {
        format!("{name}={value}")
    }

    fn create_mutex(name: &str) -> u32 {
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        // SAFETY: The name is NUL-terminated; a returned handle is closed exactly once.
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        close_or_error(handle)
    }

    fn open_winsta0() -> u32 {
        let name: Vec<u16> = "WinSta0".encode_utf16().chain(Some(0)).collect();
        // SAFETY: The name is NUL-terminated; a returned handle is closed exactly once.
        let handle = unsafe { OpenWindowStationW(name.as_ptr(), 0, 0x0200_0000) };
        if handle.is_null() {
            unsafe { GetLastError() }
        } else {
            unsafe { CloseWindowStation(handle) };
            0
        }
    }

    fn open_process(pid: u32, access: u32) -> u32 {
        // SAFETY: A process open by id; a returned handle is closed exactly once.
        let handle = unsafe { OpenProcess(access, 0, pid) };
        close_or_error(handle)
    }

    fn close_or_error(handle: windows_sys::Win32::Foundation::HANDLE) -> u32 {
        if handle.is_null() {
            unsafe { GetLastError() }
        } else {
            unsafe { CloseHandle(handle) };
            0
        }
    }
}

/// Reports what a launch gave this process, on the streams the launch bound.
///
/// Standard error is written first and flushed, so a reader of a shared destination sees both streams
/// even if the process is torn down immediately after; the order between the two is not something this
/// binary promises, because two streams on one append-only handle are ordered by when each write lands.
fn report_io() -> ExitCode {
    let mut error = std::io::stderr();
    let _ = writeln!(error, "stderr-sentinel");
    let _ = error.flush();

    let mut output = std::io::stdout();
    let directory = std::env::current_dir().unwrap_or_default();
    let _ = writeln!(output, "cwd={}", directory.display());
    let _ = writeln!(output, "stdout-sentinel");

    let mut received = Vec::new();
    // Bounded, and read to end rather than by line: a payload that never ended would hang here, and the
    // point of the test is that the launch closes the writer.
    if std::io::stdin()
        .lock()
        .take(STDIN_LIMIT)
        .read_to_end(&mut received)
        .is_err()
    {
        return ExitCode::FAILURE;
    }
    let _ = writeln!(output, "stdin-bytes={}", received.len());
    let _ = writeln!(
        output,
        "stdin={}",
        String::from_utf8_lossy(&received).trim_end()
    );
    let _ = output.flush();
    ExitCode::SUCCESS
}

/// The probe role's account of where it runs. Every question that cannot be answered is reported as
/// `error:<code>` rather than failing the role.
mod observation {
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
        GetSecurityInfo, SDDL_REVISION_1, SE_WINDOW_OBJECT,
    };
    use windows_sys::Win32::Security::{
        DACL_SECURITY_INFORMATION, GetTokenInformation, OWNER_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, TOKEN_GROUPS, TOKEN_QUERY, TokenGroups,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::JobObjects::{
        JOBOBJECT_BASIC_UI_RESTRICTIONS, JobObjectBasicUIRestrictions, QueryInformationJobObject,
    };
    use windows_sys::Win32::System::StationsAndDesktops::{
        GetProcessWindowStation, GetThreadDesktop, GetUserObjectInformationW, UOI_NAME,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentThreadId, GetStartupInfoW, OpenProcess, OpenProcessToken,
        PROCESS_QUERY_INFORMATION, PROCESS_VM_READ, STARTUPINFOW,
    };

    const LOGON_ID: u32 = 0xC000_0000;

    type Answer = Result<String, u32>;

    fn last_error() -> u32 {
        // SAFETY: Reads the calling thread's last-error value.
        unsafe { GetLastError() }
    }

    fn show(answer: Answer) -> String {
        answer.unwrap_or_else(|code| format!("error:{code}"))
    }

    pub fn line() -> String {
        // SAFETY: Both are this process's and thread's own and are not closed.
        let (station, desktop) = unsafe {
            (
                GetProcessWindowStation(),
                GetThreadDesktop(GetCurrentThreadId()),
            )
        };
        let parent = parent_pid();
        // SAFETY: A query-and-read open of the parent, owned here and closed below.
        let parent_process = parent.map(|pid| unsafe {
            OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid)
        });
        let parent_desktop = parent_process.and_then(|process| {
            if process.is_null() {
                Err(last_error())
            } else {
                desktop_info(process)
            }
        });
        let parent_logon = parent_process.and_then(|process| {
            if process.is_null() {
                Err(last_error())
            } else {
                logon_sids(process)
            }
        });
        if let Ok(process) = parent_process
            && !process.is_null()
        {
            // SAFETY: Opened above and closed exactly once.
            unsafe { CloseHandle(process) };
        }
        format!(
            "superclaw-test-role-observation station={} desktop={} startup_desktop={} parent_pid={} \
             parent_desktop={} logon_sids={} parent_logon_sids={} ui_restrictions={} desktop_sd={}",
            show(object_name(station)),
            show(object_name(desktop)),
            show(startup_desktop()),
            show(parent.map(|pid| pid.to_string())),
            show(parent_desktop),
            // SAFETY: This process's pseudo-handle.
            show(logon_sids(unsafe { GetCurrentProcess() })),
            show(parent_logon),
            show(ui_restrictions()),
            show(descriptor(desktop)),
        )
    }

    fn object_name(object: HANDLE) -> Answer {
        let mut buffer = [0u16; 256];
        let mut needed = 0;
        // SAFETY: The handle is this process's own station or desktop; the length is the buffer's bytes.
        if unsafe {
            GetUserObjectInformationW(
                object,
                UOI_NAME,
                buffer.as_mut_ptr().cast(),
                size_of_val(&buffer) as u32,
                &mut needed,
            )
        } == 0
        {
            return Err(last_error());
        }
        let length = buffer.iter().position(|unit| *unit == 0).unwrap_or(0);
        Ok(String::from_utf16_lossy(&buffer[..length]))
    }

    fn startup_desktop() -> Answer {
        let mut startup = STARTUPINFOW::default();
        // SAFETY: Fills a caller-owned structure.
        unsafe { GetStartupInfoW(&mut startup) };
        if startup.lpDesktop.is_null() {
            return Ok(String::new());
        }
        // SAFETY: lpDesktop points at this process's NUL-terminated process parameters string.
        Ok(unsafe { wide_text(startup.lpDesktop) })
    }

    /// # Safety
    ///
    /// `text` must point at a NUL-terminated UTF-16 string.
    unsafe fn wide_text(text: *const u16) -> String {
        let mut length = 0;
        // SAFETY: Bounded by the terminator the caller promises.
        while unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        // SAFETY: The `length` units before the terminator are readable.
        String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) })
    }

    /// `PROCESS_BASIC_INFORMATION` as six pointer-sized fields: the PEB is the second, the parent the sixth.
    fn basic_information(process: HANDLE) -> Result<[usize; 6], u32> {
        let mut basic = [0usize; 6];
        // SAFETY: The buffer has the structure's size, which is what is passed.
        let status = unsafe {
            NtQueryInformationProcess(
                process,
                ProcessBasicInformation,
                (&raw mut basic).cast(),
                size_of_val(&basic) as u32,
                null_mut(),
            )
        };
        if status != 0 {
            return Err(status as u32);
        }
        Ok(basic)
    }

    fn parent_pid() -> Result<u32, u32> {
        // SAFETY: This process's pseudo-handle.
        basic_information(unsafe { GetCurrentProcess() }).map(|basic| basic[5] as u32)
    }

    /// The `DesktopInfo` `process` was created with. 64-bit layouts: `PEB.ProcessParameters` at 0x20 and
    /// `RTL_USER_PROCESS_PARAMETERS.DesktopInfo` at 0xC0.
    fn desktop_info(process: HANDLE) -> Answer {
        let read = |address: usize, buffer: &mut [u8]| {
            // SAFETY: The buffer is writable for its length and the handle allows reading.
            let ok = unsafe {
                ReadProcessMemory(
                    process,
                    address as *const c_void,
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    null_mut(),
                )
            };
            if ok == 0 { Err(last_error()) } else { Ok(()) }
        };
        let basic = basic_information(process)?;
        let mut pointer = [0u8; 8];
        read(basic[1] + 0x20, &mut pointer)?;
        let parameters = usize::from_le_bytes(pointer);
        let mut field = [0u8; 16];
        read(parameters + 0xC0, &mut field)?;
        let length = usize::from(u16::from_le_bytes([field[0], field[1]]));
        if length % 2 != 0 || length > 2048 {
            return Err(u32::MAX);
        }
        let buffer = usize::from_le_bytes(field[8..].try_into().map_err(|_| u32::MAX)?);
        let mut text = vec![0u8; length];
        if length > 0 {
            read(buffer, &mut text)?;
        }
        let units: Vec<u16> = text
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        Ok(String::from_utf16_lossy(&units))
    }

    /// Every logon SID of `process`'s token as `sid:attributes`, comma-separated.
    fn logon_sids(process: HANDLE) -> Answer {
        let mut token = null_mut();
        // SAFETY: The process handle allows query; the token is closed below.
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(last_error());
        }
        let mut required = 0;
        // SAFETY: A sizing call.
        unsafe { GetTokenInformation(token, TokenGroups, null_mut(), 0, &mut required) };
        let mut buffer = vec![0u64; (required as usize).div_ceil(8)];
        // SAFETY: The buffer holds `required` bytes, 8-byte aligned.
        let read = unsafe {
            GetTokenInformation(
                token,
                TokenGroups,
                buffer.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        };
        let error = last_error();
        // SAFETY: Opened above and closed exactly once.
        unsafe { CloseHandle(token) };
        if read == 0 {
            return Err(error);
        }
        // SAFETY: GetTokenInformation wrote a TOKEN_GROUPS followed by its entries.
        let groups = unsafe {
            let header = &*buffer.as_ptr().cast::<TOKEN_GROUPS>();
            std::slice::from_raw_parts(header.Groups.as_ptr(), header.GroupCount as usize)
        };
        let mut listed = Vec::new();
        for group in groups
            .iter()
            .filter(|group| group.Attributes & LOGON_ID == LOGON_ID)
        {
            let mut text = null_mut();
            // SAFETY: The SID lives in `buffer`; the string is LocalAlloc memory freed below.
            if unsafe { ConvertSidToStringSidW(group.Sid, &mut text) } == 0 {
                return Err(last_error());
            }
            // SAFETY: A NUL-terminated string from the conversion above, freed exactly once.
            let sid = unsafe {
                let sid = wide_text(text);
                LocalFree(text.cast());
                sid
            };
            listed.push(format!("{sid}:{:x}", group.Attributes));
        }
        Ok(listed.join(","))
    }

    /// The UI restrictions of the Job this process is in, asked of the Job by passing no handle.
    fn ui_restrictions() -> Answer {
        let mut restrictions = JOBOBJECT_BASIC_UI_RESTRICTIONS::default();
        // SAFETY: A null Job is the caller's own; the buffer matches the class.
        if unsafe {
            QueryInformationJobObject(
                null_mut(),
                JobObjectBasicUIRestrictions,
                (&raw mut restrictions).cast(),
                size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
                null_mut(),
            )
        } == 0
        {
            return Err(last_error());
        }
        Ok(format!("0x{:x}", restrictions.UIRestrictionsClass))
    }

    /// `object`'s owner and DACL as SDDL.
    fn descriptor(object: HANDLE) -> Answer {
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: The handle is this thread's desktop; the descriptor is LocalAlloc memory freed below.
        let status = unsafe {
            GetSecurityInfo(
                object,
                SE_WINDOW_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(status);
        }
        let mut text = null_mut();
        // SAFETY: The descriptor is live; the string is LocalAlloc memory freed below.
        let converted = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut text,
                null_mut(),
            )
        };
        let error = last_error();
        // SAFETY: Both allocations are freed exactly once; `text` only when the conversion produced it.
        unsafe {
            LocalFree(descriptor);
            if converted == 0 {
                return Err(error);
            }
            let sddl = wide_text(text);
            LocalFree(text.cast());
            Ok(sddl)
        }
    }
}

/// Detached on purpose. This role is launched with no console, and a console-subsystem child created
/// without a console flag would have one allocated for it, which puts an extra `conhost.exe` in the
/// role's Job. Detaching keeps the Job's process count equal to the processes the test reasons about.
fn spawn_one_grandchild() -> std::io::Result<()> {
    Command::new(std::env::current_exe()?)
        .args(["--sleep-ms", "60000"])
        .env_remove(PROBE_VARIABLE)
        .creation_flags(DETACHED_PROCESS)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
}
