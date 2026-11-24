//! The bootstrap's first instructions (#3499): protect its own token's default DACL and every thread it
//! has, then set its error mode.
//!
//! Before resuming the bootstrap, the owner replaced its process and primary-thread DACLs with SYSTEM,
//! `OWNER RIGHTS` `READ_CONTROL`, and either the tier SID by default or the owner logon SID under #3838.
//! A handle opened before that keeps its access. Threads the loader creates after resume still get their
//! DACL from the token's original default DACL. It grants the same tier in full and the owner logon SID
//! `GENERIC_READ | GENERIC_EXECUTE`; flag-off roles hold that SID enabled. Until the protection below
//! reaches a loader thread, those processes can open it with that access and keep that handle
//! afterwards; the whole span from `CreateProcessWithLogonW` until `protect_self` completes is open
//! residual risk (#3713). The default DACL is set first, to the same three trustees, so nothing created
//! after it - a thread, the restricted token, the supervisor's creation - inherits the old one, and then
//! every thread that already exists is given the same protected DACL the owner gave the primary one, from
//! a snapshot of this process taken again until it shows no thread left unprotected. Each write is on an
//! object this process created or owns and is read back exactly; a thread already carrying the descriptor
//! is left alone.
//!
//! By default this does not exclude the same tier: the tier account is the trustee used to open real
//! handles to this process's threads. Under the #3838 spike flag, that trustee is instead the owner's
//! logon SID. The bootstrap holds it enabled and can still protect its threads; the supervisor and roles
//! hold it deny-only and the tier SID has no entry, so a same-tier role cannot newly open the bootstrap.
//!
//! The error mode comes after, so a role or the supervisor that fails at loader initialization exits
//! rather than raising a dialog on a desktop nobody can see; it crosses `CreateProcessAsUserW` (measured).

use crate::object_descriptor::{
    DaclEntry, ObjectDescriptor, ObjectKind, dacl_of, read_descriptor, require_exact,
    security_descriptor,
};
use crate::process_win32::OwnedHandle;
use crate::tier_desktop_policy::{
    READ_CONTROL, bootstrap_default_dacl, bootstrap_default_dacl_sddl, bootstrap_object_descriptor,
    bootstrap_object_sddl, boundary_bootstrap_default_dacl, boundary_bootstrap_default_dacl_sddl,
    boundary_bootstrap_object_descriptor, boundary_bootstrap_object_sddl,
};
use crate::tier_handoff::BootstrapStep;
use crate::token_info::{current_process_token, default_dacl, enabled_logon_sid, token_user};
use std::collections::BTreeSet;
use std::io;
use windows_sys::Win32::Foundation::{
    ERROR_INVALID_PARAMETER, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS, GetLastError,
};
use windows_sys::Win32::Security::Authorization::{SE_KERNEL_OBJECT, SetSecurityInfo};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SetTokenInformation,
    TOKEN_ADJUST_DEFAULT, TOKEN_DEFAULT_DACL, TOKEN_QUERY, TokenDefaultDacl,
};
use windows_sys::Win32::System::Diagnostics::Debug::{GetErrorMode, SetErrorMode};
use windows_sys::Win32::System::Diagnostics::ProcessSnapshotting::{
    HPSS, HPSSWALK, PSS_CAPTURE_THREADS, PSS_THREAD_ENTRY, PSS_THREAD_FLAGS_TERMINATED,
    PSS_WALK_THREADS, PssCaptureSnapshot, PssFreeSnapshot, PssWalkMarkerCreate, PssWalkMarkerFree,
    PssWalkSnapshot,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetProcessIdOfThread, OpenThread,
    THREAD_QUERY_LIMITED_INFORMATION,
};

/// `SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX`, the mode measured to cross both hops.
pub const BOOTSTRAP_ERROR_MODE: u32 = 0x0001 | 0x0002;

/// `WRITE_DAC`, the one right besides `READ_CONTROL` a thread is opened with here.
const WRITE_DAC: u32 = 0x0004_0000;

/// Who the bootstrap is: the tier account, and the logon SID Secondary Logon gave it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnIdentity {
    pub tier_sid: String,
    pub logon_sid: String,
}

/// Runs the three protections in order and returns who this process is.
pub fn protect_self(
    role_desktop_boundary: bool,
) -> Result<OwnIdentity, (BootstrapStep, io::Error)> {
    let at = |step: BootstrapStep| move |error: io::Error| (step, error);
    let token = current_process_token(TOKEN_QUERY | TOKEN_ADJUST_DEFAULT)
        .map_err(at(BootstrapStep::DefaultDacl))?;
    let logon_sid = enabled_logon_sid(&token).map_err(at(BootstrapStep::DefaultDacl))?;
    let tier_sid = token_user(&token).map_err(at(BootstrapStep::DefaultDacl))?;
    let (default_sddl, default) = if role_desktop_boundary {
        (
            boundary_bootstrap_default_dacl_sddl(&logon_sid),
            boundary_bootstrap_default_dacl(&logon_sid).map_err(at(BootstrapStep::DefaultDacl))?,
        )
    } else {
        (
            bootstrap_default_dacl_sddl(&tier_sid),
            bootstrap_default_dacl(&tier_sid).map_err(at(BootstrapStep::DefaultDacl))?,
        )
    };
    set_default_dacl(&token, &default_sddl, &default).map_err(at(BootstrapStep::DefaultDacl))?;
    protect_own_threads(&tier_sid, &logon_sid, role_desktop_boundary)
        .map_err(at(BootstrapStep::ThreadProtection))?;
    set_error_mode().map_err(at(BootstrapStep::ErrorMode))?;
    Ok(OwnIdentity {
        tier_sid,
        logon_sid,
    })
}

/// Sets `token`'s default DACL to `sddl` and requires it to read back as exactly `expected`.
pub fn set_default_dacl(token: &OwnedHandle, sddl: &str, expected: &[DaclEntry]) -> io::Result<()> {
    let descriptor = security_descriptor(sddl)?;
    let default = TOKEN_DEFAULT_DACL {
        DefaultDacl: dacl_of(&descriptor)?,
    };
    // SAFETY: The ACL lives inside `descriptor`, which outlives the call; the kernel copies it.
    if unsafe {
        SetTokenInformation(
            token.raw(),
            TokenDefaultDacl,
            (&raw const default).cast(),
            size_of::<TOKEN_DEFAULT_DACL>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let actual = default_dacl(token)?;
    if actual != expected {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("the token's default DACL read back as {actual:?}, expected {expected:?}"),
        ));
    }
    Ok(())
}

/// Gives `thread` the protected DACL `sddl` unless it already reads back as `expected`, then requires
/// that it does. The handle needs `READ_CONTROL | WRITE_DAC`.
pub fn protect_thread(
    thread: &OwnedHandle,
    sddl: &str,
    expected: &ObjectDescriptor,
) -> io::Result<()> {
    let thread = thread.raw();
    if read_descriptor(thread, ObjectKind::Kernel, false)? == *expected {
        return Ok(());
    }
    let descriptor = security_descriptor(sddl)?;
    // SAFETY: The thread handle carries WRITE_DAC; the ACL lives inside `descriptor` for the call.
    let status = unsafe {
        SetSecurityInfo(
            thread,
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl_of(&descriptor)?,
            std::ptr::null_mut(),
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    require_exact(
        "a bootstrap thread",
        &read_descriptor(thread, ObjectKind::Kernel, false)?,
        expected,
    )
}

/// Every thread this process has gets the protected DACL. A thread can start while the others are being
/// protected, so the process is snapshotted again after each round until a snapshot shows no thread that
/// was not protected; a process still starting threads after `MAX_PROTECTION_ROUNDS` refuses.
fn protect_own_threads(
    tier_sid: &str,
    logon_sid: &str,
    role_desktop_boundary: bool,
) -> io::Result<()> {
    let (sddl, expected) = if role_desktop_boundary {
        (
            boundary_bootstrap_object_sddl(logon_sid),
            boundary_bootstrap_object_descriptor(logon_sid)?,
        )
    } else {
        (
            bootstrap_object_sddl(tier_sid),
            bootstrap_object_descriptor(tier_sid)?,
        )
    };
    protect_until_stable(own_threads, |thread| {
        match open_own_thread(thread.id, READ_CONTROL | WRITE_DAC)? {
            Some(handle) => protect_thread(&handle, &sddl, &expected),
            None => Ok(()),
        }
    })
}

/// Snapshots before the thread list must have stopped growing.
const MAX_PROTECTION_ROUNDS: usize = 4;

/// More threads than this in the bootstrap means something is wrong; the walk stops rather than run on.
const MAX_OWN_THREADS: usize = 256;

/// One thread of this process, as a snapshot saw it. The creation time is part of its identity, because
/// an exited thread's id can be given to a new one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct OwnThread {
    pub id: u32,
    pub created: u64,
}

/// Protects every thread `snapshot` lists, and snapshots again, until a snapshot lists none that is not
/// protected yet.
fn protect_until_stable(
    mut snapshot: impl FnMut() -> io::Result<Vec<OwnThread>>,
    mut protect: impl FnMut(OwnThread) -> io::Result<()>,
) -> io::Result<()> {
    let mut protected = BTreeSet::new();
    for _ in 0..MAX_PROTECTION_ROUNDS {
        let unprotected: Vec<OwnThread> = snapshot()?
            .into_iter()
            .filter(|thread| !protected.contains(thread))
            .collect();
        if unprotected.is_empty() && !protected.is_empty() {
            return Ok(());
        }
        for thread in unprotected {
            protect(thread)?;
            protected.insert(thread);
        }
    }
    Err(io::Error::other(format!(
        "this process was still starting threads after {MAX_PROTECTION_ROUNDS} snapshots"
    )))
}

/// Frees a snapshot of this process.
struct Snapshot(HPSS);

impl Drop for Snapshot {
    fn drop(&mut self) {
        // SAFETY: The snapshot was captured from this process and is freed once.
        unsafe { PssFreeSnapshot(GetCurrentProcess(), self.0) };
    }
}

/// Frees a snapshot walk marker.
struct WalkMarker(HPSSWALK);

impl Drop for WalkMarker {
    fn drop(&mut self) {
        // SAFETY: The marker was created by `PssWalkMarkerCreate` and is freed once.
        unsafe { PssWalkMarkerFree(self.0) };
    }
}

/// Every live thread of this process, from a snapshot of this process alone (`PssCaptureSnapshot`) rather
/// than a system-wide one, whose cost is whatever the rest of the machine makes it (measured: 2 to 21 s on
/// a loaded host, every launch, against 1 to 2 ms for this one).
pub fn own_threads() -> io::Result<Vec<OwnThread>> {
    let mut raw = std::ptr::null_mut();
    // SAFETY: The pseudo-handle names this process; `raw` receives a snapshot freed by `Snapshot`.
    let status =
        unsafe { PssCaptureSnapshot(GetCurrentProcess(), PSS_CAPTURE_THREADS, 0, &mut raw) };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let snapshot = Snapshot(raw);
    let mut raw = std::ptr::null_mut();
    // SAFETY: A null allocator selects the default heap; `raw` receives a marker freed by `WalkMarker`.
    let status = unsafe { PssWalkMarkerCreate(std::ptr::null(), &mut raw) };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let marker = WalkMarker(raw);
    let mut threads = Vec::new();
    loop {
        let mut entry = PSS_THREAD_ENTRY::default();
        // SAFETY: The snapshot and marker are live, and the buffer is one writable PSS_THREAD_ENTRY.
        let status = unsafe {
            PssWalkSnapshot(
                snapshot.0,
                PSS_WALK_THREADS,
                marker.0,
                (&raw mut entry).cast(),
                size_of::<PSS_THREAD_ENTRY>() as u32,
            )
        };
        if status == ERROR_NO_MORE_ITEMS {
            break;
        }
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        if entry.Flags & PSS_THREAD_FLAGS_TERMINATED != 0 {
            continue;
        }
        threads.push(OwnThread {
            id: entry.ThreadId,
            created: (u64::from(entry.CreateTime.dwHighDateTime) << 32)
                | u64::from(entry.CreateTime.dwLowDateTime),
        });
        if threads.len() > MAX_OWN_THREADS {
            return Err(io::Error::other(format!(
                "this process has more than {MAX_OWN_THREADS} threads"
            )));
        }
    }
    drop(marker);
    drop(snapshot);
    if threads.is_empty() {
        return Err(io::Error::other(
            "the snapshot lists no thread of this process",
        ));
    }
    Ok(threads)
}

/// Opens thread `id` of this process with `access`, or `None` when it has exited since the snapshot. The
/// thread is required to belong to this process, since an exited thread's id can be reused by another.
pub fn open_own_thread(id: u32, access: u32) -> io::Result<Option<OwnedHandle>> {
    // SAFETY: Opens a thread by id; the handle is owned from here on.
    let opened = unsafe { OpenThread(access | THREAD_QUERY_LIMITED_INFORMATION, 0, id) };
    if opened.is_null() {
        // SAFETY: Read immediately after the failed open.
        if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
            return Ok(None);
        }
        return Err(io::Error::last_os_error());
    }
    let thread = OwnedHandle::new(opened)?;
    // SAFETY: Reads this process's own id.
    let me = unsafe { GetCurrentProcessId() };
    // SAFETY: The handle carries THREAD_QUERY_LIMITED_INFORMATION.
    let owner = unsafe { GetProcessIdOfThread(thread.raw()) };
    keep_if_own(thread, owner, me, io::Error::last_os_error)
}

/// `thread` when `owner` is this process `me`, `None` when it is another process (the id was reused after
/// the snapshot's thread exited), and `failure` when `owner` is 0, which is how `GetProcessIdOfThread`
/// reports that it could not tell.
fn keep_if_own<T>(
    thread: T,
    owner: u32,
    me: u32,
    failure: impl FnOnce() -> io::Error,
) -> io::Result<Option<T>> {
    match owner {
        0 => Err(failure()),
        owner if owner == me => Ok(Some(thread)),
        _ => Ok(None),
    }
}
/// Sets `BOOTSTRAP_ERROR_MODE` and requires it to read back.
pub fn set_error_mode() -> io::Result<()> {
    // SAFETY: Sets this process's error mode; no pointers involved.
    unsafe { SetErrorMode(BOOTSTRAP_ERROR_MODE) };
    // SAFETY: Reads it back.
    let actual = unsafe { GetErrorMode() };
    if actual & BOOTSTRAP_ERROR_MODE != BOOTSTRAP_ERROR_MODE {
        return Err(io::Error::other(format!(
            "the error mode read back as {actual:#x}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object_descriptor::{ObjectKind, read_descriptor};
    use crate::sid_win32::current_process_sid;
    use crate::tier_desktop_policy::{
        bootstrap_default_dacl, bootstrap_default_dacl_sddl, bootstrap_object_descriptor,
        bootstrap_object_sddl,
    };
    use crate::token_info::{current_process_token, default_dacl};
    use std::ptr::null;
    use windows_sys::Win32::Security::{
        DuplicateTokenEx, SecurityAnonymous, TOKEN_ADJUST_DEFAULT, TOKEN_DUPLICATE, TOKEN_QUERY,
        TokenPrimary,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentThreadId, OpenThread, THREAD_QUERY_LIMITED_INFORMATION,
    };

    const TIER: &str = "S-1-5-21-1-2-3-2002";

    /// A primary-token copy of this process's own, so the test can change a default DACL without changing
    /// the one every later object of this test process would inherit.
    fn token_copy() -> OwnedHandle {
        let own = current_process_token(TOKEN_DUPLICATE | TOKEN_QUERY).expect("own token");
        let mut copy = std::ptr::null_mut();
        // SAFETY: `own` is live with TOKEN_DUPLICATE; the output is owned from here on.
        let duplicated = unsafe {
            DuplicateTokenEx(
                own.raw(),
                TOKEN_QUERY | TOKEN_ADJUST_DEFAULT,
                null(),
                SecurityAnonymous,
                TokenPrimary,
                &mut copy,
            )
        };
        assert_ne!(duplicated, 0, "{}", io::Error::last_os_error());
        OwnedHandle::new(copy).expect("the copy is a handle")
    }

    #[test]
    fn a_default_dacl_is_set_and_read_back_exactly() {
        let token = token_copy();
        let expected = bootstrap_default_dacl(TIER).expect("expected");
        set_default_dacl(&token, &bootstrap_default_dacl_sddl(TIER), &expected)
            .expect("the default DACL is set and verified");
        assert_eq!(default_dacl(&token).expect("read back"), expected);
    }

    #[test]
    fn a_default_dacl_that_reads_back_differently_is_refused() {
        let token = token_copy();
        let mut wider = bootstrap_default_dacl(TIER).expect("expected");
        wider.pop();
        assert_eq!(
            set_default_dacl(&token, &bootstrap_default_dacl_sddl(TIER), &wider)
                .expect_err("an expectation the kernel did not store must refuse")
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    /// A thread of this test process, parked until the test releases it, with the access protection needs.
    struct ParkedThread {
        handle: OwnedHandle,
        release: std::sync::mpsc::Sender<()>,
        joined: Option<std::thread::JoinHandle<()>>,
    }

    impl ParkedThread {
        fn start() -> Self {
            let (id_sender, id_receiver) = std::sync::mpsc::channel();
            let (release, released) = std::sync::mpsc::channel::<()>();
            let joined = std::thread::spawn(move || {
                // SAFETY: Reads the calling thread's own id.
                id_sender
                    .send(unsafe { GetCurrentThreadId() })
                    .expect("send");
                let _ = released.recv();
            });
            let id = id_receiver.recv().expect("the thread reports its id");
            // SAFETY: Opens a thread of this process by id; the handle is owned from here on.
            let handle = OwnedHandle::new(unsafe {
                OpenThread(
                    0x0002_0000 | 0x0004_0000 | THREAD_QUERY_LIMITED_INFORMATION,
                    0,
                    id,
                )
            })
            .expect("this process can open its own thread");
            Self {
                handle,
                release,
                joined: Some(joined),
            }
        }
    }

    impl Drop for ParkedThread {
        fn drop(&mut self) {
            let _ = self.release.send(());
            if let Some(joined) = self.joined.take() {
                let _ = joined.join();
            }
        }
    }

    #[test]
    fn a_thread_is_given_the_protected_dacl_and_a_second_pass_changes_nothing() {
        let thread = ParkedThread::start();
        let tier = current_process_sid().expect("this process's SID");
        let expected = bootstrap_object_descriptor(&tier).expect("expected");
        protect_thread(&thread.handle, &bootstrap_object_sddl(&tier), &expected)
            .expect("the thread is protected and verified");
        let read = read_descriptor(thread.handle.raw(), ObjectKind::Kernel, false).expect("read");
        assert_eq!(read.entries, expected.entries);
        assert!(read.protected);
        protect_thread(&thread.handle, &bootstrap_object_sddl(&tier), &expected)
            .expect("an already protected thread verifies");
    }

    #[test]
    fn this_process_lists_its_own_threads() {
        let thread = ParkedThread::start();
        let threads = own_threads().expect("this process's own threads");
        let ids: Vec<u32> = threads.iter().map(|thread| thread.id).collect();
        // SAFETY: Reads the calling thread's own id.
        let me = unsafe { GetCurrentThreadId() };
        assert!(ids.contains(&me), "{ids:?}");
        assert!(ids.len() >= 2, "{ids:?}");
        assert!(
            threads.iter().all(|thread| thread.created != 0),
            "{threads:?}"
        );
        assert!(open_own_thread(me, READ_CONTROL).expect("open").is_some());
        drop(thread);
    }

    #[test]
    fn a_thread_whose_owner_cannot_be_read_is_refused_not_skipped() {
        let failed = keep_if_own("thread", 0, 42, || io::Error::other("unknown owner"));
        assert_eq!(failed.unwrap_err().to_string(), "unknown owner");
        assert_eq!(
            keep_if_own("thread", 7, 42, || unreachable!()).expect("foreign"),
            None
        );
        assert_eq!(
            keep_if_own("thread", 42, 42, || unreachable!()).expect("own"),
            Some("thread")
        );
    }

    fn thread(id: u32, created: u64) -> OwnThread {
        OwnThread { id, created }
    }

    /// Runs `protect_until_stable` over `snapshots` in turn and returns what it protected, in order.
    fn rounds(snapshots: Vec<Vec<OwnThread>>) -> (io::Result<()>, Vec<OwnThread>, usize) {
        let mut snapshots = snapshots.into_iter();
        let mut taken = 0;
        let mut protected = Vec::new();
        let result = protect_until_stable(
            || {
                taken += 1;
                Ok(snapshots
                    .next()
                    .expect("a snapshot was asked for past the script"))
            },
            |thread| {
                protected.push(thread);
                Ok(())
            },
        );
        (result, protected, taken)
    }

    #[test]
    fn an_unchanged_second_snapshot_ends_the_protection() {
        let both = vec![thread(1, 10), thread(2, 20)];
        let (result, protected, taken) = rounds(vec![both.clone(), both.clone()]);
        result.expect("stable");
        assert_eq!(protected, both);
        assert_eq!(taken, 2);
    }

    #[test]
    fn a_thread_started_during_protection_is_protected_and_checked_again() {
        let (result, protected, taken) = rounds(vec![
            vec![thread(1, 10)],
            vec![thread(1, 10), thread(2, 20)],
            vec![thread(2, 20)],
        ]);
        result.expect("stable once the new thread is protected and the first has exited");
        assert_eq!(protected, vec![thread(1, 10), thread(2, 20)]);
        assert_eq!(taken, 3);
    }

    #[test]
    fn a_reused_thread_id_counts_as_a_new_thread() {
        let (result, protected, _) = rounds(vec![
            vec![thread(1, 10)],
            vec![thread(1, 11)],
            vec![thread(1, 11)],
        ]);
        result.expect("stable");
        assert_eq!(protected, vec![thread(1, 10), thread(1, 11)]);
    }

    #[test]
    fn a_process_that_keeps_starting_threads_is_refused() {
        let growing = (0..MAX_PROTECTION_ROUNDS as u32)
            .map(|round| (0..=round).map(|id| thread(id, u64::from(id))).collect())
            .collect();
        let (result, _, taken) = rounds(growing);
        assert!(result.is_err());
        assert_eq!(taken, MAX_PROTECTION_ROUNDS);
    }

    #[test]
    fn a_failure_to_snapshot_or_protect_refuses() {
        let failed = protect_until_stable(|| Err(io::Error::other("snapshot")), |_| Ok(()));
        assert_eq!(failed.unwrap_err().to_string(), "snapshot");
        let failed = protect_until_stable(
            || Ok(vec![thread(1, 10)]),
            |_| Err(io::Error::other("protect")),
        );
        assert_eq!(failed.unwrap_err().to_string(), "protect");
    }
}
