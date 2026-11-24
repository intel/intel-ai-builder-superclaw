//! The owner's adoption of what the tier bootstrap reported (#3499, #3400).
//!
//! The handoff frame names four handles in the bootstrap's handle table and the supervisor's process id.
//! The owner duplicates each handle through the bootstrap process handle it kept from creation, which
//! carries `PROCESS_DUP_HANDLE` whatever the bootstrap's descriptor now says, and then checks every object
//! it got before it relies on any of them:
//!
//! - the station and the desktop: object type, exact name, the access the bootstrap's handle was granted,
//!   and the descriptor - owner, protection and every entry - against `tier_desktop_policy`;
//! - the supervisor's process and primary thread: object type, the full access the creation returned,
//!   and the descriptor - owner, protection and every entry - that its restricted token's default DACL
//!   gives them (`tier_desktop_policy::supervisor_object_descriptor`); then the process id the handle
//!   denotes, that the thread handle is that process's thread, that the image is this launcher and that
//!   it is in the role's Job, all before the owner resumes it; the desktop it was created on is checked
//!   once the bootstrap has ended (`process_desktop.rs`). Its token must be the tier account; that is
//!   checked here only when the token is readable. In production it is not - the restricted token's own
//!   DACL grants only the tier account and SYSTEM (measured: 5) - so it is checked after resume at each
//!   pipe binding, by impersonating the supervisor's connection, before anything is sent on it.
//!
//! Any mismatch is a refusal and nothing is repaired: these objects' security is set once, at creation,
//! by the bootstrap. The owner then holds the station and the desktop until the Job is gone, because a
//! desktop whose last handle closes before the supervisor connects to it kills the supervisor at `user32`
//! initialization (#3546).

use crate::job::Job;
use crate::object_descriptor::{ObjectDescriptor, ObjectKind, read_descriptor, require_exact};
use crate::process_win32::OwnedHandle;
use crate::sid_win32::canonical_sid;
use crate::tier_desktop_policy::{
    DESKTOP_ACCESS, DesktopTrustees, PROCESS_THREAD_ALL_ACCESS, STATION_ACCESS, desktop_descriptor,
    desktop_path, station_descriptor, supervisor_object_descriptor,
};
use crate::tier_handoff::Handoff;
use crate::token_info::{open_process_token, token_user};
use std::io;
use std::path::Path;
use windows_sys::Wdk::Foundation::{NtQueryObject, ObjectBasicInformation, ObjectTypeInformation};
use windows_sys::Win32::Foundation::{
    DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_ACCESS_DENIED, HANDLE,
};
use windows_sys::Win32::Security::TOKEN_QUERY;
use windows_sys::Win32::System::StationsAndDesktops::{
    CloseDesktop, CloseWindowStation, GetUserObjectInformationW, HDESK, HWINSTA, UOI_NAME, UOI_TYPE,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessId, GetProcessIdOfThread, PROCESS_NAME_WIN32,
    QueryFullProcessImageNameW,
};

/// `PUBLIC_OBJECT_BASIC_INFORMATION`, declared here so the owner needs no further `windows-sys` feature
/// for the one field it reads.
#[repr(C)]
#[derive(Default)]
struct ObjectBasic {
    attributes: u32,
    granted_access: u32,
    handle_count: u32,
    pointer_count: u32,
    reserved: [u32; 10],
}

fn refused(detail: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, detail)
}

/// Which user object a handle must denote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum UserObjectType {
    Station,
    Desktop,
}

/// What the station and desktop must be.
pub(super) struct DesktopExpectation<'a> {
    pub(super) trustees: DesktopTrustees<'a>,
    pub(super) station_name: &'a str,
    pub(super) desktop_name: &'a str,
}

/// A duplicated window station handle, closed with `CloseWindowStation`.
struct StationHandle(HWINSTA);

impl Drop for StationHandle {
    fn drop(&mut self) {
        // SAFETY: The handle was duplicated into this process and is closed exactly once, here.
        unsafe { CloseWindowStation(self.0) };
    }
}

/// A duplicated desktop handle, closed with `CloseDesktop`.
struct DesktopHandle(HDESK);

impl Drop for DesktopHandle {
    fn drop(&mut self) {
        // SAFETY: The handle was duplicated into this process and is closed exactly once, here.
        unsafe { CloseDesktop(self.0) };
    }
}

/// The station and desktop the owner holds for the launch's lifetime. Fields drop in declaration order,
/// so the desktop is closed before the station it lives on.
pub(super) struct AdoptedDesktop {
    _desktop: DesktopHandle,
    _station: StationHandle,
    path: String,
}

impl AdoptedDesktop {
    /// `station\desktop`.
    pub(super) fn path(&self) -> &str {
        &self.path
    }
}

/// Which kernel object a handle must denote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum KernelObjectType {
    Process,
    Thread,
}

/// What the supervisor must be.
pub(super) struct SupervisorExpectation<'a> {
    pub(super) tier_sid: &'a str,
    pub(super) image: &'a Path,
    /// Who owns the supervisor's process and thread: its token's owner, which is the tier account in
    /// production.
    pub(super) object_owner_sid: &'a str,
}

/// The suspended supervisor, through handles the owner holds itself.
pub(super) struct AdoptedSupervisor {
    pub(super) process: OwnedHandle,
    pub(super) thread: OwnedHandle,
    pub(super) pid: u32,
    /// Whether the token could be read through the process handle. When it cannot, the pipe bindings
    /// read it by impersonation instead (`pipe::TierPipeServer::bind_impersonating`).
    pub(super) token_verified_before_resume: bool,
}

/// Duplicates and verifies the station and the desktop.
pub(super) fn adopt_desktop(
    bootstrap: HANDLE,
    handoff: &Handoff,
    expect: &DesktopExpectation<'_>,
) -> io::Result<AdoptedDesktop> {
    let station = StationHandle(duplicate_raw(bootstrap, handoff.station_handle)?);
    verify_user_object(
        station.0,
        UserObjectType::Station,
        expect.station_name,
        STATION_ACCESS,
        &station_descriptor(&expect.trustees)?,
    )?;
    let desktop = DesktopHandle(duplicate_raw(bootstrap, handoff.desktop_handle)?);
    verify_user_object(
        desktop.0,
        UserObjectType::Desktop,
        expect.desktop_name,
        DESKTOP_ACCESS,
        &desktop_descriptor(&expect.trustees)?,
    )?;
    Ok(AdoptedDesktop {
        _desktop: desktop,
        _station: station,
        path: desktop_path(expect.station_name, expect.desktop_name),
    })
}

/// Duplicates and verifies the supervisor's process and primary thread.
pub(super) fn adopt_supervisor(
    bootstrap: HANDLE,
    handoff: &Handoff,
    job: &Job,
    expect: &SupervisorExpectation<'_>,
) -> io::Result<AdoptedSupervisor> {
    let process = duplicate_from(bootstrap, handoff.supervisor_process_handle)?;
    let thread = duplicate_from(bootstrap, handoff.supervisor_thread_handle)?;
    let descriptor = supervisor_object_descriptor(expect.object_owner_sid, expect.tier_sid)?;
    verify_kernel_object(
        process.raw(),
        KernelObjectType::Process,
        PROCESS_THREAD_ALL_ACCESS,
        &descriptor,
    )?;
    verify_kernel_object(
        thread.raw(),
        KernelObjectType::Thread,
        PROCESS_THREAD_ALL_ACCESS,
        &descriptor,
    )?;
    let pid = handoff.supervisor_pid;
    // SAFETY: Both handles are live duplicates owned here.
    let (process_id, thread_owner) = unsafe {
        (
            GetProcessId(process.raw()),
            GetProcessIdOfThread(thread.raw()),
        )
    };
    if process_id != pid || thread_owner != pid {
        return Err(refused(format!(
            "the reported supervisor {pid} is process {process_id} with a thread of process \
             {thread_owner}"
        )));
    }
    job.verify_membership(process.raw())
        .map_err(|error| refused(format!("the supervisor is not in the role's Job ({error})")))?;
    let image = image_of(&process)
        .map_err(|error| io::Error::new(error.kind(), format!("reading its image: {error}")))?;
    if !image.eq_ignore_ascii_case(&expect.image.display().to_string()) {
        return Err(refused(format!(
            "the supervisor runs {image}, not {}",
            expect.image.display()
        )));
    }
    let token_verified_before_resume = match open_process_token(process.raw(), TOKEN_QUERY) {
        Ok(token) => {
            let user = token_user(&token)?;
            if user != canonical_sid(expect.tier_sid)? {
                return Err(refused(format!(
                    "the supervisor runs as {user}, not the tier account {}",
                    expect.tier_sid
                )));
            }
            true
        }
        // The restricted token's own DACL is its default one, the tier account and SYSTEM, so the
        // owner's handle to the process does not reach it. Every pipe binding then reads it by
        // impersonating the supervisor's connection, before anything is sent to it.
        Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => false,
        Err(error) => {
            return Err(io::Error::new(
                error.kind(),
                format!("opening its token: {error}"),
            ));
        }
    };
    Ok(AdoptedSupervisor {
        process,
        thread,
        pid,
        token_verified_before_resume,
    })
}

fn image_of(process: &OwnedHandle) -> io::Result<String> {
    let mut buffer = vec![0u16; 1024];
    let mut length = buffer.len() as u32;
    // SAFETY: The handle carries query access; `length` is the buffer's size in characters.
    if unsafe {
        QueryFullProcessImageNameW(
            process.raw(),
            PROCESS_NAME_WIN32,
            buffer.as_mut_ptr(),
            &mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(String::from_utf16_lossy(&buffer[..length as usize]))
}

/// Refuses unless `handle` is a `kind` named `name`, granted exactly `access`, whose descriptor is
/// exactly `descriptor`.
pub(super) fn verify_user_object(
    handle: HANDLE,
    kind: UserObjectType,
    name: &str,
    access: u32,
    descriptor: &ObjectDescriptor,
) -> io::Result<()> {
    let (what, type_name) = match kind {
        UserObjectType::Station => ("the tier's window station", "WindowStation"),
        UserObjectType::Desktop => ("the tier's desktop", "Desktop"),
    };
    let actual_type = user_object_string(handle, UOI_TYPE)?;
    if actual_type != type_name {
        return Err(refused(format!(
            "{what} is a {actual_type}, not a {type_name}"
        )));
    }
    let actual_name = user_object_string(handle, UOI_NAME)?;
    if actual_name != name {
        return Err(refused(format!(
            "{what} is named {actual_name}, not {name}"
        )));
    }
    let granted = granted_access(handle)?;
    if granted != access {
        return Err(refused(format!(
            "{what} was granted {granted:#x}, not {access:#x}"
        )));
    }
    require_exact(
        what,
        &read_descriptor(handle, ObjectKind::Window, descriptor.owner.is_some())?,
        descriptor,
    )
}

/// Refuses unless `handle` is a `kind`, granted exactly `access`, whose descriptor is exactly
/// `descriptor`.
pub(super) fn verify_kernel_object(
    handle: HANDLE,
    kind: KernelObjectType,
    access: u32,
    descriptor: &ObjectDescriptor,
) -> io::Result<()> {
    let (what, type_name) = match kind {
        KernelObjectType::Process => ("the supervisor's process", "Process"),
        KernelObjectType::Thread => ("the supervisor's primary thread", "Thread"),
    };
    let actual_type = object_type_name(handle)?;
    if actual_type != type_name {
        return Err(refused(format!(
            "{what} is a {actual_type}, not a {type_name}"
        )));
    }
    let granted = granted_access(handle)?;
    if granted != access {
        return Err(refused(format!(
            "{what} was granted {granted:#x}, not {access:#x}"
        )));
    }
    require_exact(
        what,
        &read_descriptor(handle, ObjectKind::Kernel, descriptor.owner.is_some())?,
        descriptor,
    )
}

/// `UNICODE_STRING`, the head of `PUBLIC_OBJECT_TYPE_INFORMATION`.
#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum: u16,
    buffer: *const u16,
}

/// The object manager's name for the type of object `handle` denotes.
fn object_type_name(handle: HANDLE) -> io::Result<String> {
    let mut information = [0u64; 128];
    let mut returned = 0;
    // SAFETY: The buffer is writable for the size passed and aligned for the structure written to it.
    let status = unsafe {
        NtQueryObject(
            handle,
            ObjectTypeInformation,
            information.as_mut_ptr().cast(),
            size_of_val(&information) as u32,
            &mut returned,
        )
    };
    if status != 0 {
        return Err(io::Error::other(format!(
            "NtQueryObject failed with {:#x}",
            status as u32
        )));
    }
    // SAFETY: A successful call wrote a PUBLIC_OBJECT_TYPE_INFORMATION, which begins with the name.
    let name = unsafe { &*information.as_ptr().cast::<UnicodeString>() };
    let start = information.as_ptr() as usize;
    let end = start + size_of_val(&information);
    let text = name.buffer as usize;
    let length = usize::from(name.length);
    if length % 2 != 0 || text < start || text + length > end {
        return Err(io::Error::other(
            "the object type name is not inside its buffer",
        ));
    }
    // SAFETY: The name's `length` bytes were checked to lie inside `information`, which is alive.
    let units = unsafe { std::slice::from_raw_parts(name.buffer, length / 2) };
    String::from_utf16(units).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "an object type name is not UTF-16",
        )
    })
}

fn user_object_string(handle: HANDLE, index: i32) -> io::Result<String> {
    let mut buffer = [0u16; 256];
    let mut needed = 0;
    // SAFETY: The handle is a live station or desktop; the length is the buffer's size in bytes.
    if unsafe {
        GetUserObjectInformationW(
            handle,
            index,
            buffer.as_mut_ptr().cast(),
            size_of_val(&buffer) as u32,
            &mut needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16(&buffer[..length]).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "a user object name is not UTF-16",
        )
    })
}

/// The access this handle was granted, as the object manager recorded it.
fn granted_access(handle: HANDLE) -> io::Result<u32> {
    let mut information = ObjectBasic::default();
    // SAFETY: The buffer has the class's size, which is what is passed.
    let status = unsafe {
        NtQueryObject(
            handle,
            ObjectBasicInformation,
            (&raw mut information).cast(),
            size_of::<ObjectBasic>() as u32,
            std::ptr::null_mut(),
        )
    };
    if status != 0 {
        return Err(io::Error::other(format!(
            "NtQueryObject failed with {:#x}",
            status as u32
        )));
    }
    Ok(information.granted_access)
}

/// Duplicates kernel handle `value` of process `source` into this process with the access it already has.
pub(super) fn duplicate_from(source: HANDLE, value: u64) -> io::Result<OwnedHandle> {
    OwnedHandle::new(duplicate_raw(source, value)?)
}

/// The duplicate itself, for a caller that wraps it in the owner its object type needs.
fn duplicate_raw(source: HANDLE, value: u64) -> io::Result<HANDLE> {
    let mut copy = std::ptr::null_mut();
    // SAFETY: `source` carries PROCESS_DUP_HANDLE; a value that denotes no handle fails the call.
    if unsafe {
        DuplicateHandle(
            source,
            value as usize as HANDLE,
            GetCurrentProcess(),
            &mut copy,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if copy.is_null() {
        return Err(io::Error::other("the duplicated handle is null"));
    }
    Ok(copy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::JobLimitProfile;
    use crate::launch_environment::{current_process_environment, resolve_role_environment};
    use crate::random_bytes::random_hex;
    use crate::sid_win32::current_process_sid;
    use crate::tier_bootstrap::restricted_launch::{
        SupervisorSpec, restricted_token, start_supervisor,
    };
    use crate::tier_bootstrap::station::{User32, create_desktop_here};
    use crate::tier_desktop_policy::{DESKTOP_ACCESS, desktop_descriptor, desktop_sddl};
    use crate::token_info::{current_process_token, enabled_logon_sid};
    use windows_sys::Win32::Security::{
        TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    const OWNER: &str = "S-1-5-21-1-2-3-1001";

    fn refused(result: io::Result<()>, why: &str) {
        assert_eq!(
            result.expect_err(why).kind(),
            io::ErrorKind::PermissionDenied,
            "{why}"
        );
    }

    #[test]
    fn a_desktop_is_accepted_only_with_its_exact_type_name_access_and_descriptor() {
        let user32 = User32::load().expect("user32");
        let tier = current_process_sid().expect("sid");
        let trustees = DesktopTrustees {
            owner_sid: OWNER,
            tier_sid: &tier,
        };
        let name = format!("SuperClawTest-{}", random_hex(8).expect("rng"));
        let desktop =
            create_desktop_here(&user32, &name, &desktop_sddl(&trustees)).expect("desktop");
        // SAFETY: This process's pseudo-handle.
        let copy = DesktopHandle(
            duplicate_raw(unsafe { GetCurrentProcess() }, desktop.raw() as u64).expect("duplicate"),
        );
        let mut expected = desktop_descriptor(&trustees).expect("expected");
        expected.owner = Some(
            crate::object_descriptor::read_descriptor(
                copy.0,
                crate::object_descriptor::ObjectKind::Window,
                true,
            )
            .expect("read")
            .owner
            .expect("owner"),
        );
        let verify = |kind, name: &str, access, descriptor: &ObjectDescriptor| {
            verify_user_object(copy.0, kind, name, access, descriptor)
        };
        verify(UserObjectType::Desktop, &name, DESKTOP_ACCESS, &expected).expect("exact");
        refused(
            verify(UserObjectType::Station, &name, DESKTOP_ACCESS, &expected),
            "wrong type",
        );
        refused(
            verify(
                UserObjectType::Desktop,
                "Default",
                DESKTOP_ACCESS,
                &expected,
            ),
            "wrong name",
        );
        refused(
            verify(UserObjectType::Desktop, &name, 0x000F_01FF, &expected),
            "wrong access",
        );
        let mut extra = expected.clone();
        extra
            .entries
            .push(crate::object_descriptor::DaclEntry::allow("S-1-1-0", 0x0002_0000).expect("SID"));
        refused(
            verify(UserObjectType::Desktop, &name, DESKTOP_ACCESS, &extra),
            "extra entry",
        );
    }

    #[test]
    fn a_handle_value_that_denotes_nothing_is_refused() {
        // SAFETY: This process's pseudo-handle.
        let me = unsafe { GetCurrentProcess() };
        assert!(duplicate_from(me, 0).is_err());
        assert!(duplicate_from(me, 0x00FF_FFFC).is_err());
    }

    /// A restricted, suspended test child started the way the bootstrap starts the supervisor, with the
    /// tier SID and the token owner it was started with. `None` on a host whose token carries no logon
    /// SID.
    struct RestrictedChild {
        child: crate::tier_bootstrap::restricted_launch::Supervisor,
        tier: String,
        owner: String,
        image: std::path::PathBuf,
    }

    fn restricted_child() -> Option<RestrictedChild> {
        let own = current_process_token(
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
        )
        .expect("token");
        let Ok(logon) = enabled_logon_sid(&own) else {
            eprintln!("skipped: this token carries no logon SID");
            return None;
        };
        let tier = current_process_sid().expect("sid");
        let token = restricted_token(&own, &tier, &logon, false).expect("restricted");
        let owner = crate::token_info::token_owner(&token).expect("owner");
        let image = std::env::current_exe()
            .expect("exe")
            .with_file_name("native_isolation_test_child.exe");
        let command = format!("\"{}\" --sleep-ms 60000", image.display());
        let environment =
            resolve_role_environment(current_process_environment().expect("env").into_iter(), &[])
                .expect("environment");
        let directory = image.parent().expect("dir").to_owned();
        let user32 = User32::load().expect("user32");
        let desktop = user32.current_desktop_path().expect("desktop");
        let child = start_supervisor(
            &token,
            &SupervisorSpec {
                image: &image,
                command: &command,
                current_directory: &directory,
                environment: &environment,
                desktop: &desktop,
            },
        )
        .expect("child");
        Some(RestrictedChild {
            child,
            tier,
            owner,
            image,
        })
    }

    /// The supervisor's process and thread are accepted only as what the bootstrap created: the right
    /// object type, the full access the creation returned, and the descriptor its token gives them.
    #[test]
    fn a_process_or_thread_is_accepted_only_with_its_exact_type_access_and_descriptor() {
        use crate::tier_desktop_policy::{PROCESS_THREAD_ALL_ACCESS, supervisor_object_descriptor};
        let Some(restricted) = restricted_child() else {
            return;
        };
        // SAFETY: This process's pseudo-handle.
        let me = unsafe { GetCurrentProcess() };
        let process = duplicate_from(me, restricted.child.process.raw() as u64).expect("duplicate");
        let thread = duplicate_from(me, restricted.child.thread.raw() as u64).expect("duplicate");
        let expected =
            supervisor_object_descriptor(&restricted.owner, &restricted.tier).expect("expected");
        let all = PROCESS_THREAD_ALL_ACCESS;
        verify_kernel_object(process.raw(), KernelObjectType::Process, all, &expected)
            .expect("the supervisor's process is what the bootstrap created");
        verify_kernel_object(thread.raw(), KernelObjectType::Thread, all, &expected)
            .expect("its primary thread too");
        refused(
            verify_kernel_object(process.raw(), KernelObjectType::Thread, all, &expected),
            "a process is not a thread",
        );
        refused(
            verify_kernel_object(thread.raw(), KernelObjectType::Process, all, &expected),
            "a thread is not a process",
        );
        let mut narrowed = std::ptr::null_mut();
        // SAFETY: Duplicates this process's own handle with less access; the copy is owned below.
        let duplicated =
            unsafe { DuplicateHandle(me, process.raw(), me, &mut narrowed, 0x0002_1000, 0, 0) };
        assert_ne!(duplicated, 0, "{}", io::Error::last_os_error());
        let narrowed = OwnedHandle::new(narrowed).expect("a handle");
        refused(
            verify_kernel_object(narrowed.raw(), KernelObjectType::Process, all, &expected),
            "a handle without full access",
        );
        let mut extra = expected.clone();
        extra
            .entries
            .push(crate::object_descriptor::DaclEntry::allow("S-1-1-0", 0x1000).expect("SID"));
        refused(
            verify_kernel_object(process.raw(), KernelObjectType::Process, all, &extra),
            "an extra entry",
        );
        let mut protected = expected.clone();
        protected.protected = true;
        refused(
            verify_kernel_object(process.raw(), KernelObjectType::Process, all, &protected),
            "a different protection",
        );
        let mut owner = expected.clone();
        owner.owner = Some("S-1-5-18".to_owned());
        refused(
            verify_kernel_object(process.raw(), KernelObjectType::Process, all, &owner),
            "a different owner",
        );
    }

    /// A restricted, suspended test child in a Job stands in for the supervisor, with this process as the
    /// bootstrap whose handle table the values come from.
    #[test]
    fn a_supervisor_is_adopted_only_restricted_in_the_job_and_running_this_image() {
        let Some(RestrictedChild {
            child,
            tier,
            owner,
            image,
        }) = restricted_child()
        else {
            return;
        };
        let handoff = Handoff {
            station_handle: 4,
            desktop_handle: 4,
            supervisor_pid: child.pid,
            supervisor_process_handle: child.process.raw() as u64,
            supervisor_thread_handle: child.thread.raw() as u64,
        };
        // SAFETY: This process's pseudo-handle.
        let me = unsafe { GetCurrentProcess() };
        let expect = SupervisorExpectation {
            tier_sid: &tier,
            image: &image,
            object_owner_sid: &owner,
        };

        let outside = Job::create(JobLimitProfile::FixedSleepTest).expect("job");
        assert!(
            adopt_supervisor(me, &handoff, &outside, &expect).is_err(),
            "a supervisor outside the Job must be refused"
        );
        let job = Job::create(JobLimitProfile::FixedSleepTest).expect("job");
        job.assign_and_verify(child.process.raw()).expect("assign");
        let wrong_image = SupervisorExpectation {
            image: Path::new(r"C:\Windows\System32\cmd.exe"),
            ..expect
        };
        assert!(adopt_supervisor(me, &handoff, &job, &wrong_image).is_err());
        let wrong_pid = Handoff {
            supervisor_pid: child.pid + 4,
            ..handoff
        };
        assert!(adopt_supervisor(me, &wrong_pid, &job, &expect).is_err());
        let foreign_owner = SupervisorExpectation {
            object_owner_sid: "S-1-5-18",
            ..expect
        };
        refused(
            adopt_supervisor(me, &handoff, &job, &foreign_owner).map(|_| ()),
            "a supervisor whose objects another account owns",
        );

        let adopted = adopt_supervisor(me, &handoff, &job, &expect).expect("adopted");
        assert_eq!(adopted.pid, child.pid);
        job.terminate_and_confirm_drained(std::time::Duration::from_secs(10))
            .expect("drained");
    }
}
