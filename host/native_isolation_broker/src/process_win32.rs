//! Win32 process-creation primitives shared by every launch path in this adapter.
//!
//! Nothing here touches tokens, privileges or account management. The privileged foreign-token path
//! (`process.rs`) and the unelevated same-account path (`process_same_account.rs`) both build on
//! these types so there is exactly one measured implementation of handle ownership, stdio pipe
//! inheritance, and the `STARTUPINFOEXW` attribute list.

use std::fs::File;
use std::io;
use std::mem::size_of;
use std::os::windows::io::FromRawHandle;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
    WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    DeleteProcThreadAttributeList, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

/// Exit code stamped on processes this adapter tears down, so an operator can tell a policy kill
/// from an application exit. Spells "SCJB".
pub const JOB_EXIT_CODE: u32 = 0x5343_4A42;

/// A kernel handle this process exclusively owns and closes on drop.
pub struct OwnedHandle(HANDLE);

impl OwnedHandle {
    pub fn new(handle: HANDLE) -> io::Result<Self> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }

    pub const fn raw(&self) -> HANDLE {
        self.0
    }

    pub fn wait(&self, timeout: std::time::Duration) -> io::Result<()> {
        let millis = timeout.as_millis().min(u32::MAX as u128) as u32;
        // SAFETY: this object owns a live handle with synchronization access.
        match unsafe { WaitForSingleObject(self.0, millis) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the process did not exit within the wait budget",
            )),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            result => Err(io::Error::other(format!(
                "unexpected process wait result: {result}"
            ))),
        }
    }

    /// Gives up ownership so the handle can be adopted by something else that closes it, such as
    /// `std::fs::File::from_raw_handle`.
    pub fn into_raw(self) -> HANDLE {
        let handle = self.0;
        std::mem::forget(self);
        handle
    }

    /// Adopts a pipe end as a `File` so the standard `Read`/`Write` machinery can be used on it
    /// instead of a hand-rolled `ReadFile`/`WriteFile` loop.
    pub fn into_file(self) -> File {
        // SAFETY: The handle is a valid pipe end this process exclusively owns, and ownership moves
        // to the File, which closes it exactly once.
        unsafe { File::from_raw_handle(self.into_raw().cast()) }
    }
}

// SAFETY: A Win32 HANDLE is a process-wide index into the kernel's handle table, not a pointer into
// this process's address space, and every call this crate makes on one (`CloseHandle`, `ReadFile`,
// `WriteFile`, `WaitForSingleObject`) is documented as thread-safe. The auto trait is only absent
// because `HANDLE` is spelled `*mut c_void`. `Sync` is deliberately not claimed: two threads issuing
// overlapped I/O on one shared handle would have an `OVERLAPPED` sequencing problem this type does
// not solve, so a handle may move between threads but not be used from two at once.
unsafe impl Send for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: OwnedHandle is the sole owner of a valid, non-pseudo HANDLE.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// The handles wired to a child's three standard handles.
///
/// Only the child ends are inheritable, and only those handles are ever named in the attribute list, so
/// a child inherits nothing else this process happens to hold.
///
/// Standard input is always a pipe, because that is the only way to hand a child a bounded payload and
/// then an end-of-file. Output is either two more pipes, for a caller that reads what the child says, or
/// one shared append-only destination the child writes to directly.
pub struct StdioPipes {
    child_stdin: Option<OwnedHandle>,
    child_stdout: Option<OwnedHandle>,
    /// `None` when output is shared, in which case `child_stdout` serves as both.
    child_stderr: Option<OwnedHandle>,
    parent_stdin: Option<OwnedHandle>,
    parent_stdout: Option<OwnedHandle>,
    parent_stderr: Option<OwnedHandle>,
}

impl StdioPipes {
    pub fn create() -> io::Result<Self> {
        let (child_stdin, parent_stdin) = create_inheritable_pipe()?;
        let (parent_stdout, child_stdout) = create_inheritable_pipe()?;
        let (parent_stderr, child_stderr) = create_inheritable_pipe()?;

        make_not_inheritable(parent_stdin.raw())?;
        make_not_inheritable(parent_stdout.raw())?;
        make_not_inheritable(parent_stderr.raw())?;

        Ok(Self {
            child_stdin: Some(child_stdin),
            child_stdout: Some(child_stdout),
            child_stderr: Some(child_stderr),
            parent_stdin: Some(parent_stdin),
            parent_stdout: Some(parent_stdout),
            parent_stderr: Some(parent_stderr),
        })
    }

    /// A stdin pipe plus one inheritable handle serving as both standard output and standard error.
    ///
    /// One handle rather than two duplicates of the same file, deliberately. Two handles to one file each
    /// carry their own file pointer, so interleaved writes would overwrite each other; a single handle
    /// has one pointer, and when the file was opened append-only every write from either stream lands at
    /// the end. This is what makes a role's diagnostics readable in the order they were produced.
    ///
    /// The caller keeps no reader: there is nothing to drain, because the child writes to the
    /// destination directly rather than through this process.
    pub fn create_with_shared_output(output: OwnedHandle) -> io::Result<Self> {
        let (child_stdin, parent_stdin) = create_inheritable_pipe()?;
        make_not_inheritable(parent_stdin.raw())?;
        Ok(Self {
            child_stdin: Some(child_stdin),
            child_stdout: Some(output),
            child_stderr: None,
            parent_stdin: Some(parent_stdin),
            parent_stdout: None,
            parent_stderr: None,
        })
    }

    /// The three handles a child is given, in `hStdInput`, `hStdOutput`, `hStdError` order. When output
    /// is shared the last two are the same handle, which the handle list below deduplicates.
    pub fn child_handles(&self) -> [HANDLE; 3] {
        let output = self.child_stdout.as_ref().expect("child stdout open").raw();
        [
            self.child_stdin.as_ref().expect("child stdin open").raw(),
            output,
            self.child_stderr.as_ref().map_or(output, OwnedHandle::raw),
        ]
    }

    /// Releases this process's copies of the inheritable ends once the child holds them, so pipe
    /// EOF tracks the child's lifetime rather than ours.
    pub fn close_child_ends(&mut self) {
        self.child_stdin = None;
        self.child_stdout = None;
        self.child_stderr = None;
    }

    /// Takes the write end of the child's stdin. Dropping the returned handle is what signals EOF
    /// to the child, so callers hold it exactly as long as they intend the child to keep reading.
    pub fn take_parent_stdin(&mut self) -> Option<OwnedHandle> {
        self.parent_stdin.take()
    }

    pub fn take_parent_stdout(&mut self) -> Option<OwnedHandle> {
        self.parent_stdout.take()
    }

    pub fn take_parent_stderr(&mut self) -> Option<OwnedHandle> {
        self.parent_stderr.take()
    }

    #[cfg(test)]
    fn parent_handles(&self) -> Vec<HANDLE> {
        [
            self.parent_stdin.as_ref(),
            self.parent_stdout.as_ref(),
            self.parent_stderr.as_ref(),
        ]
        .into_iter()
        .flatten()
        .map(OwnedHandle::raw)
        .collect()
    }
}

/// The `STARTUPINFOEXW` attribute list for a single suspended creation.
///
/// `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` closes handle inheritance to a named set, and
/// `PROC_THREAD_ATTRIBUTE_JOB_LIST` makes the process a Job member from its first instruction, so
/// there is no window in which a child exists outside its Job. Both must be installed in the same
/// creation call; that is the whole reason they share one type.
///
/// The count a list is initialized for is only an upper bound as far as Win32 is concerned, so a path
/// that declared an attribute and then failed to install it would still create a process - silently
/// without that attribute. `new` therefore compares the two and refuses the mismatch.
pub struct ProcThreadAttributes {
    /// `usize`-backed rather than byte-backed because `PROC_THREAD_ATTRIBUTE_LIST` is an opaque
    /// structure containing pointers, and `Vec<u8>` only guarantees one-byte alignment.
    buffer: Vec<usize>,
    handles: Vec<HANDLE>,
    jobs: Vec<HANDLE>,
    installed: u32,
}

impl ProcThreadAttributes {
    /// `handles` is deduplicated, preserving order.
    ///
    /// A role whose standard output and standard error are one shared handle names it twice among its
    /// three standard handles. The documented meaning of the list is the *set* of handles a child may
    /// inherit, so a repeat says nothing new; deduplicating keeps the list a set in fact as well as in
    /// intent, and keeps `handle_count` a number a test can compare against the distinct handles a launch
    /// meant to pass.
    pub fn new(handles: Vec<HANDLE>, jobs: Vec<HANDLE>) -> io::Result<Self> {
        let handles = handles.iter().fold(Vec::new(), |mut distinct, handle| {
            if !distinct.contains(handle) {
                distinct.push(*handle);
            }
            distinct
        });
        let count = u32::from(!handles.is_empty()) + u32::from(!jobs.is_empty());
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "an attribute list must declare at least one attribute",
            ));
        }
        let mut size = 0;
        // SAFETY: Sizing call with a null list pointer, as documented.
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut size);
        }
        let mut buffer = vec![0usize; size.div_ceil(size_of::<usize>())];
        let list = buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        // SAFETY: The buffer is sized from the preceding query and aligned for pointers.
        if unsafe { InitializeProcThreadAttributeList(list, count, 0, &mut size) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // From here the list is initialized, so Drop owns releasing it even if install() fails.
        let mut attributes = Self {
            buffer,
            handles,
            jobs,
            installed: 0,
        };
        attributes.install()?;
        if attributes.installed() != count {
            return Err(io::Error::other(format!(
                "the attribute list declared {count} attributes but installed {}, so a creation \
                 using it would silently lose one",
                attributes.installed
            )));
        }
        Ok(attributes)
    }

    fn install(&mut self) -> io::Result<()> {
        if !self.handles.is_empty() {
            let value = self.handles.as_ptr().cast();
            let size = size_of::<HANDLE>() * self.handles.len();
            self.update(PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, value, size)?;
        }
        if !self.jobs.is_empty() {
            let value = self.jobs.as_ptr().cast();
            let size = size_of::<HANDLE>() * self.jobs.len();
            self.update(PROC_THREAD_ATTRIBUTE_JOB_LIST as usize, value, size)?;
        }
        Ok(())
    }

    /// How many attributes this list actually carries. Always equal to the number declared, because
    /// `new` refuses to hand back a list where the two differ.
    pub const fn installed(&self) -> u32 {
        self.installed
    }

    /// How many distinct handles the child may inherit. Test-only, following `parent_handles` below:
    /// production code declares the list rather than counting it, and a count no shipped path reads is
    /// better absent from the shipped binaries than carried with an allow.
    #[cfg(test)]
    pub fn handle_count(&self) -> usize {
        self.handles.len()
    }

    fn update(
        &mut self,
        attribute: usize,
        value: *const std::ffi::c_void,
        size: usize,
    ) -> io::Result<()> {
        let list = self.as_mut_ptr();
        // SAFETY: The list is initialized and the pointed-to slice outlives process creation
        // because it is owned by this struct, which the caller keeps alive across the call.
        if unsafe { UpdateProcThreadAttribute(list, 0, attribute, value, size, null_mut(), null()) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        self.installed += 1;
        Ok(())
    }

    pub fn as_mut_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST
    }
}

impl Drop for ProcThreadAttributes {
    fn drop(&mut self) {
        // SAFETY: The list was initialized successfully in new().
        unsafe {
            DeleteProcThreadAttributeList(self.as_mut_ptr());
        }
    }
}

/// Kill guard for the window between a successful suspended creation and a successful resume.
///
/// If anything in that window fails, the child must not be left suspended and unowned; disarming is
/// the only way out.
pub struct SuspendedProcess {
    process: HANDLE,
    armed: bool,
}

impl SuspendedProcess {
    pub const fn arm(process: HANDLE) -> Self {
        Self {
            process,
            armed: true,
        }
    }

    pub const fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for SuspendedProcess {
    fn drop(&mut self) {
        if self.armed {
            // SAFETY: The process handle remains valid while this guard is armed.
            unsafe {
                TerminateProcess(self.process, JOB_EXIT_CODE);
                WaitForSingleObject(self.process, 2_000);
            }
        }
    }
}

pub fn create_inheritable_pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read = null_mut();
    let mut write = null_mut();
    // SAFETY: Both out-parameters and security attributes are valid.
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((OwnedHandle::new(read)?, OwnedHandle::new(write)?))
}

pub fn make_not_inheritable(handle: HANDLE) -> io::Result<()> {
    // SAFETY: Handle is valid and owned by this process.
    if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Foundation::GetHandleInformation;

    fn inherit_flag(handle: HANDLE) -> u32 {
        let mut flags = 0;
        // SAFETY: Handle is valid and flags points to writable storage.
        assert_ne!(unsafe { GetHandleInformation(handle, &mut flags) }, 0);
        flags & HANDLE_FLAG_INHERIT
    }

    #[test]
    fn stdio_inherits_only_child_ends() {
        let pipes = StdioPipes::create().expect("stdio pipes should be created");
        for handle in pipes.child_handles() {
            assert_eq!(inherit_flag(handle), HANDLE_FLAG_INHERIT);
        }
        for handle in pipes.parent_handles() {
            assert_eq!(inherit_flag(handle), 0);
        }
    }

    #[test]
    fn attribute_list_accepts_handle_and_job_lists_together() {
        let pipes = StdioPipes::create().expect("stdio pipes should be created");
        let job = crate::job::Job::create(crate::job::JobLimitProfile::FixedSleepTest)
            .expect("Job should be creatable");
        let attributes = ProcThreadAttributes::new(pipes.child_handles().to_vec(), vec![job.raw()])
            .expect("a single creation must be able to carry both lists");
        assert_eq!(
            attributes.installed(),
            2,
            "both the handle list and the Job list must be installed, not just declared"
        );
    }

    /// The foreign-token path in `process.rs` declares a handle list and no Job list, because it
    /// assigns its Job after creation. That is the other shape this type has to get exactly right.
    #[test]
    fn attribute_list_accepts_a_handle_list_on_its_own() {
        let pipes = StdioPipes::create().expect("stdio pipes should be created");
        let attributes = ProcThreadAttributes::new(pipes.child_handles().to_vec(), Vec::new())
            .expect("a handle list on its own is a valid declaration");
        assert_eq!(attributes.installed(), 1);
    }

    /// A shared output destination is one handle in two places, and the attribute list carries it once.
    ///
    /// Both halves matter. `hStdOutput` and `hStdError` must be the same handle, or the two streams would
    /// have separate file pointers and overwrite each other; the handle list must name it once, or the
    /// list would no longer be the set of handles it claims to be.
    #[test]
    fn a_shared_output_handle_is_named_twice_in_stdio_and_once_in_the_handle_list() {
        // A pipe's write end stands in for the log handle: this test is about handle identity and the
        // attribute list, and `role_log` owns the properties of the real destination.
        let (_reader, destination) =
            create_inheritable_pipe().expect("a stand-in for the log file");
        let pipes = StdioPipes::create_with_shared_output(destination)
            .expect("shared output should be set");
        let handles = pipes.child_handles();
        assert_eq!(handles[1], handles[2], "both streams take the same handle");
        assert_ne!(handles[0], handles[1], "standard input stays its own pipe");
        for handle in handles {
            assert_eq!(inherit_flag(handle), HANDLE_FLAG_INHERIT);
        }
        let kept = pipes.parent_handles();
        assert_eq!(
            kept.len(),
            1,
            "the only end this process keeps is the stdin writer, because there is nothing to drain"
        );
        assert!(
            !handles.contains(&kept[0]),
            "the end this process keeps is the writer, not one of the child's own handles"
        );
        assert_eq!(inherit_flag(kept[0]), 0);

        let job = crate::job::Job::create(crate::job::JobLimitProfile::FixedSleepTest)
            .expect("Job should be creatable");
        let attributes = ProcThreadAttributes::new(handles.to_vec(), vec![job.raw()])
            .expect("a shared output handle is a valid declaration");
        assert_eq!(attributes.installed(), 2);
        assert_eq!(
            attributes.handle_count(),
            2,
            "three standard handles over two distinct kernel objects is two inheritable handles"
        );
    }

    #[test]
    fn attribute_list_refuses_an_empty_declaration() {
        match ProcThreadAttributes::new(Vec::new(), Vec::new()) {
            Ok(_) => panic!("a creation that declares no attributes must be refused"),
            Err(error) => assert_eq!(error.kind(), io::ErrorKind::InvalidInput),
        }
    }

    #[test]
    fn an_adopted_pipe_end_round_trips_bytes_and_signals_eof_on_close() {
        use std::io::{Read, Write};

        let (read, write) = create_inheritable_pipe().expect("pipe should be created");
        let mut writer = write.into_file();
        writer.write_all(b"tier-report\n").expect("write");
        drop(writer);

        let mut collected = String::new();
        read.into_file()
            .read_to_string(&mut collected)
            .expect("read to EOF");
        assert_eq!(collected, "tier-report\n");
    }
}
