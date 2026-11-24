//! The same-account launch path: `CreateProcessW` only, no token and no privilege.
//!
//! This module is the physically isolated counterpart of `process.rs`. It exists as its own file so
//! the unelevated `native_isolation_launcher` binary can reach a complete launch implementation
//! without `CreateProcessAsUserW`, `AdjustTokenPrivileges` or any other token API appearing anywhere
//! in its reachable set. Do not add a token parameter here; a launch that needs a foreign token is
//! by definition not a same-account launch.
//!
//! Every launch here:
//! - creates the process suspended, with an explicit handle list so only the child's own standard
//!   handles are inherited;
//! - passes an explicit UTF-16 environment block, never `NULL`;
//! - starts the child in a directory its role decided, not wherever its program happens to sit;
//! - installs `PROC_THREAD_ATTRIBUTE_JOB_LIST`, when the caller holds the Job, in the same creation
//!   call as the handle list, so the child is a member from its first instruction, and re-checks that
//!   membership before resuming the primary thread. A role the tier runner starts names no Job: the
//!   runner is already in the owner-held Job, which the role inherits from creation, and the runner
//!   holds no handle it could name (#3010);
//! - allocates no console (`DETACHED_PROCESS`). No standard handle is a console handle, so a console
//!   would only add a `conhost.exe` to the role's Job, which both widens the role's surface and makes
//!   the Job's process count depend on when conhost happens to appear.
//!
//! A role's output is bound straight to a destination the caller opened (`RoleStdio::SharedLog`), so the
//! role's bytes never pass through this process. The pipe form remains for the owner-side hop, whose
//! child is a launcher whose diagnostics the owner reports itself.

use crate::job::Job;
use crate::launch_environment::{encode_environment_block, resolve_role_environment};
use crate::launch_spec::CatalogLaunchSpec;
#[cfg(test)]
use crate::launch_spec::RoleStdin;
use crate::process_win32::{
    JOB_EXIT_CODE, OwnedHandle, ProcThreadAttributes, StdioPipes, SuspendedProcess, wide_null,
};
use std::fs::File;
use std::io;
use std::mem::size_of;
use std::path::Path;
use std::ptr::null;
use std::time::Duration;
use windows_sys::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DETACHED_PROCESS,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, PROCESS_INFORMATION, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, WaitForSingleObject,
};

/// How long a dropped, unreaped child is given to die before the handle is closed anyway. The wait
/// exists so the common case is an observed exit rather than a request to exit.
const DROP_TERMINATE_WAIT_MS: u32 = 2_000;

/// The largest wait this module will ask the kernel for. `INFINITE` is `u32::MAX`, so saturating a
/// caller's finite budget at `u32::MAX` would silently turn a bounded wait into an unbounded one.
const LONGEST_WAIT_MS: u128 = u32::MAX as u128 - 1;

/// Where a child's standard output and standard error go.
pub enum RoleStdio {
    /// Two anonymous pipes the launching process reads. Used for the owner-side hop, whose child is a
    /// launcher rather than a role: the owner keeps its runner's diagnostics for its own refusal report.
    Pipes,
    /// One inheritable, append-only destination bound to both streams, which the child writes to
    /// directly. This is what makes a role's log a file the tier opened rather than bytes copied through
    /// the runner, and it is why a role launch needs no drain threads.
    SharedLog(OwnedHandle),
}

/// What a same-account creation needs to know. The environment is resolved from the allowlist plus
/// `declared_environment`, so a caller cannot pass the raw parent environment through by accident.
pub struct SameAccountSpawn<'a> {
    pub executable: &'a Path,
    /// The full command line, assembled from the catalog. Never caller-supplied argv.
    pub command: &'a str,
    /// The directory the child starts in, decided by the role rather than by where its program sits.
    pub current_directory: &'a Path,
    pub declared_environment: &'a [(String, String)],
    /// The Job the new process must belong to from its first instruction, verified before resume.
    /// `None` is correct only where the creating process is itself in the Job the child must inherit:
    /// the tier runner launching its role, which holds no Job handle by design (#3010).
    pub job: Option<&'a Job>,
    pub stdio: RoleStdio,
}

/// A running same-account child, its stdio pipes, and the evidence gathered while starting it.
///
/// Dropping this without having observed the child exit kills it: see the `Drop` impl below for why
/// that is the only correct default here.
pub struct SameAccountChild {
    process: OwnedHandle,
    stdio: StdioPipes,
    pid: u32,
    job_membership_verified_before_resume: bool,
    environment: Vec<(String, String)>,
    /// Set once `wait` has seen the child exit, so drop does not ask the kernel to kill a corpse.
    reaped: bool,
}

impl SameAccountChild {
    pub const fn pid(&self) -> u32 {
        self.pid
    }

    /// The retained handle, so a caller that binds something to this child's identity can read its
    /// token through the handle it already holds instead of reopening its process id.
    pub const fn process(&self) -> &OwnedHandle {
        &self.process
    }

    /// True when this child was created with a Job list and membership was confirmed while it was
    /// still suspended. False only for a hop that intentionally runs outside a Job.
    pub const fn job_membership_verified_before_resume(&self) -> bool {
        self.job_membership_verified_before_resume
    }

    /// The exact variable set handed to the child.
    pub fn environment(&self) -> &[(String, String)] {
        &self.environment
    }

    /// Takes the write end of the child's stdin. Dropping the returned file is what gives the child
    /// EOF, so a caller holds it exactly as long as it intends the child to keep reading.
    pub fn take_stdin_writer(&mut self) -> io::Result<File> {
        self.stdio
            .take_parent_stdin()
            .map(OwnedHandle::into_file)
            .ok_or_else(|| io::Error::other("child stdin writer was already taken"))
    }

    /// The read end of the child's standard output, for a child launched with `RoleStdio::Pipes`.
    ///
    /// A child whose output went to a shared log has no reader here at all, and that is the answer rather
    /// than an omission: its bytes go from the child to the destination without passing through this
    /// process.
    pub fn take_stdout_reader(&mut self) -> io::Result<File> {
        self.stdio
            .take_parent_stdout()
            .map(OwnedHandle::into_file)
            .ok_or_else(|| {
                io::Error::other(
                    "this child has no stdout reader: it was either already taken, or the child writes \
                     to its own log destination",
                )
            })
    }

    pub fn take_stderr_reader(&mut self) -> io::Result<File> {
        self.stdio
            .take_parent_stderr()
            .map(OwnedHandle::into_file)
            .ok_or_else(|| {
                io::Error::other(
                    "this child has no stderr reader: it was either already taken, or the child writes \
                     to its own log destination",
                )
            })
    }

    pub fn wait(&mut self, timeout: Duration) -> io::Result<u32> {
        let millis = timeout.as_millis().min(LONGEST_WAIT_MS) as u32;
        // SAFETY: The retained process handle is valid for synchronization.
        match unsafe { WaitForSingleObject(self.process.raw(), millis) } {
            WAIT_OBJECT_0 => {
                self.reaped = true;
                let mut code = 0;
                // SAFETY: The process has exited and code points to writable storage.
                if unsafe { GetExitCodeProcess(self.process.raw(), &mut code) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(code)
            }
            WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "same-account child did not exit within the wait budget",
            )),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            result => Err(io::Error::other(format!(
                "unexpected same-account child wait result: {result}"
            ))),
        }
    }
}

/// Kill-on-drop, so a child this process gave up on does not keep running until its Job is closed.
///
/// The Job is the cleanup guarantee; this is the prompt one. A role whose runner failed before
/// reporting it, or a loopback runner whose owner gave up, is terminated here rather than waiting for
/// the owner-held Job's kill-on-close to take its tree down.
impl Drop for SameAccountChild {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        // SAFETY: The handle is owned by this struct and still open. Terminating a process that has
        // already exited fails harmlessly, which is why the result is discarded rather than checked:
        // there is no caller left to report it to.
        unsafe {
            TerminateProcess(self.process.raw(), JOB_EXIT_CODE);
            WaitForSingleObject(self.process.raw(), DROP_TERMINATE_WAIT_MS);
        }
    }
}

/// Launches a resolved catalog role in the caller's own account, with both of its output streams bound
/// to `log`. `job` is `None` from the tier runner, whose role inherits the owner-held Job; see
/// `SameAccountSpawn::job`.
///
/// The log handle is taken by value because the child is the only thing that should be writing to it: it
/// is passed to the creation and released as soon as the child holds it, so the destination's last
/// remaining writer is the role itself.
pub fn launch_catalog_same_account(
    spec: &CatalogLaunchSpec,
    job: Option<&Job>,
    log: OwnedHandle,
) -> io::Result<SameAccountChild> {
    spawn_same_account(SameAccountSpawn {
        executable: &spec.executable,
        command: &spec.command,
        current_directory: &spec.current_directory,
        declared_environment: &spec.environment,
        job,
        stdio: RoleStdio::SharedLog(log),
    })
}

pub fn spawn_same_account(spawn: SameAccountSpawn<'_>) -> io::Result<SameAccountChild> {
    let mut stdio = match spawn.stdio {
        RoleStdio::Pipes => StdioPipes::create()?,
        RoleStdio::SharedLog(log) => StdioPipes::create_with_shared_output(log)?,
    };
    let child_handles = stdio.child_handles();
    let jobs = spawn.job.map(|job| vec![job.raw()]).unwrap_or_default();
    // One creation carries both lists. Splitting them would leave a window in which the child exists
    // outside its Job, and the handle list is what keeps that same creation from inheriting everything
    // else this process holds - including, in the runner, its two tier pipe ends.
    let mut attributes = ProcThreadAttributes::new(child_handles.to_vec(), jobs)?;

    let application = wide_null(spawn.executable.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "non-Unicode executable path")
    })?);
    let mut command = wide_null(spawn.command);
    let working_directory = wide_null(spawn.current_directory.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "non-Unicode working directory")
    })?);
    let environment = resolve_role_environment(
        crate::launch_environment::current_process_environment()?.into_iter(),
        spawn.declared_environment,
    )?;
    let mut environment_block = encode_environment_block(&environment)?;

    // `lpDesktop` stays null, so the child starts on this process's desktop: for the tier runner, the
    // one the first hop placed it on. Naming a desktop here would name one its account may have no
    // access to, and a role that cannot open its desktop dies loading `user32` (#3292).
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = child_handles[0];
    startup.StartupInfo.hStdOutput = child_handles[1];
    startup.StartupInfo.hStdError = child_handles[2];
    startup.lpAttributeList = attributes.as_mut_ptr();
    let mut process_info = PROCESS_INFORMATION::default();

    // SAFETY: The application path, command line, working directory and environment block are all
    // NUL-terminated and outlive the call. The attribute list restricts inheritance to the three
    // stdio handles and names the Job the child joins at creation. The child starts suspended, so
    // nothing runs before membership is confirmed below.
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED
                | DETACHED_PROCESS
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment_block.as_mut_ptr().cast(),
            working_directory.as_ptr(),
            &startup.StartupInfo,
            &mut process_info,
        )
    };
    stdio.close_child_ends();
    drop(attributes);
    if created == 0 {
        return Err(io::Error::last_os_error());
    }

    let process = OwnedHandle::new(process_info.hProcess)?;
    let mut suspended = SuspendedProcess::arm(process.raw());
    let thread = OwnedHandle::new(process_info.hThread)?;

    let job_membership_verified_before_resume = match spawn.job {
        Some(job) => {
            job.verify_membership(process.raw())?;
            true
        }
        None => false,
    };
    // SAFETY: The primary thread was created suspended and is resumed exactly once.
    match unsafe { ResumeThread(thread.raw()) } {
        u32::MAX => return Err(io::Error::last_os_error()),
        // The return value is the suspend count *before* this call. `CREATE_SUSPENDED` accounts for
        // exactly one, so anything else means the thread was suspended by something other than this
        // launch and is still suspended now: the role would look started and never run a single
        // instruction. The kill guard below is still armed, so returning here terminates it.
        1 => {}
        previous => {
            return Err(io::Error::other(format!(
                "the role's primary thread had suspend count {previous} before resume, so it is \
                 still suspended and is not running"
            )));
        }
    }
    suspended.disarm();

    Ok(SameAccountChild {
        process,
        stdio,
        pid: process_info.dwProcessId,
        job_membership_verified_before_resume,
        environment,
        reaped: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::JobLimitProfile;
    use crate::process_win32::{create_inheritable_pipe, make_not_inheritable};

    fn test_child() -> std::path::PathBuf {
        std::env::current_exe()
            .expect("current exe")
            .with_file_name(format!(
                "native_isolation_test_child{}",
                std::env::consts::EXE_SUFFIX
            ))
    }

    /// A temporary directory that stands in for a tier's log directory, removed on drop.
    struct LogDirectory(std::path::PathBuf);

    impl LogDirectory {
        fn create() -> Self {
            let path = std::env::temp_dir().join(format!(
                "superclaw-same-account-log-{}",
                crate::random_bytes::random_hex(8).expect("rng")
            ));
            std::fs::create_dir_all(&path).expect("the test owns this directory");
            Self(path)
        }

        /// One log file's handle, opened the way the tier runner opens a role's log.
        fn open_log(&self) -> (std::path::PathBuf, OwnedHandle) {
            let launch_id = crate::role_log::LaunchId::from_pipe_id(
                &crate::random_bytes::random_hex(16).expect("rng"),
            )
            .expect("a freshly drawn pipe id is a launch id");
            let target = crate::role_log::RoleLogTarget::new(&self.0, &launch_id);
            let handle = target.create_for_role().expect("the log should be created");
            (target.path().to_owned(), handle)
        }
    }

    impl Drop for LogDirectory {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn sleep_child_spec(environment: Vec<(String, String)>) -> CatalogLaunchSpec {
        let executable = test_child();
        let current_directory = executable
            .parent()
            .expect("the test child sits beside the test binary")
            .to_owned();
        CatalogLaunchSpec {
            command: format!("\"{}\" --sleep-ms 60000", executable.display()),
            executable,
            current_directory,
            job_profile: JobLimitProfile::FixedSleepTest,
            environment,
            stdin: RoleStdin::Eof,
            log_directory: std::env::temp_dir(),
        }
    }

    #[test]
    fn a_role_joins_its_job_at_creation_and_the_job_drains_on_cleanup() {
        let logs = LogDirectory::create();
        let job = Job::create(JobLimitProfile::FixedSleepTest).expect("Job should be creatable");
        let child = launch_catalog_same_account(
            &sleep_child_spec(Vec::new()),
            Some(&job),
            logs.open_log().1,
        )
        .expect("same-account launch should succeed");

        assert!(child.job_membership_verified_before_resume());
        assert_ne!(child.pid(), 0);
        assert!(
            job.lists_process(child.pid())
                .expect("the Job's process list should be readable"),
            "the Job's own list names the role, which is how a holder without its handle checks"
        );
        assert_eq!(
            job.active_processes()
                .expect("accounting should be readable"),
            1
        );
        assert_eq!(
            job.terminate_and_confirm_drained(Duration::from_secs(10))
                .expect("the Job should drain"),
            0
        );
    }

    #[test]
    fn the_role_environment_is_exactly_the_allowlist_plus_the_declared_overlay() {
        let logs = LogDirectory::create();
        let job = Job::create(JobLimitProfile::FixedSleepTest).expect("Job should be creatable");
        let child = launch_catalog_same_account(
            &sleep_child_spec(vec![("SUPERCLAW_ROLE_PROBE".to_owned(), "1".to_owned())]),
            Some(&job),
            logs.open_log().1,
        )
        .expect("same-account launch should succeed");

        let names: Vec<&str> = child
            .environment()
            .iter()
            .map(|(name, _)| name.as_str())
            .collect();
        assert!(names.contains(&"SUPERCLAW_ROLE_PROBE"), "{names:?}");
        assert!(names.contains(&"SYSTEMROOT"), "{names:?}");
        assert!(
            names.iter().all(|name| {
                crate::launch_environment::BASE_ENVIRONMENT.contains(name)
                    || *name == "SUPERCLAW_ROLE_PROBE"
            }),
            "no variable of this test process leaked into the role: {names:?}"
        );
    }

    /// Regression coverage for `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` itself.
    ///
    /// The creation passes `bInheritHandles = 1`, so without the handle list a role would inherit
    /// *every* inheritable handle this process happens to hold - including, in the launcher, the two
    /// tier pipe ends and the Job handle. Asserting the parent's inherit flags does not catch that;
    /// only the child's actual inherited set does.
    ///
    /// The probe here is a spare inheritable pipe write end. Once the parent has dropped its own copy,
    /// the read end reaches EOF if and only if no other process holds a write end. If the role
    /// inherited one, the read never completes, which is what the timeout detects.
    #[test]
    fn a_role_inherits_no_inheritable_handle_outside_its_handle_list() {
        let (probe_read, probe_write) =
            create_inheritable_pipe().expect("probe pipe should be created");
        make_not_inheritable(probe_read.raw()).expect("the read end stays with the parent");
        // Adopted as a File before the launch, because a raw HANDLE is not Send and the drain below
        // has to happen on another thread to be bounded at all.
        let mut probe_reader = probe_read.into_file();

        let logs = LogDirectory::create();
        let job = Job::create(JobLimitProfile::FixedSleepTest).expect("Job should be creatable");
        let child = launch_catalog_same_account(
            &sleep_child_spec(Vec::new()),
            Some(&job),
            logs.open_log().1,
        )
        .expect("same-account launch should succeed");
        drop(probe_write);

        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut drained = Vec::new();
            let _ = sender.send(std::io::Read::read_to_end(&mut probe_reader, &mut drained));
        });
        let reached_eof = receiver.recv_timeout(Duration::from_secs(10)).is_ok();

        // Tear the role down before asserting, so a failure does not also leak a 60 second sleeper.
        // This is also what releases the probe write end in the failing case, so the reader thread
        // finishes rather than being left blocked.
        drop(child);
        job.terminate_and_confirm_drained(Duration::from_secs(10))
            .expect("the Job should drain");
        assert!(
            reached_eof,
            "the role inherited a handle that was not in its handle list, so \
             PROC_THREAD_ATTRIBUTE_HANDLE_LIST is no longer restricting inheritance"
        );
    }

    /// A spec for the reporting form of the test child, in a directory the caller chooses.
    fn report_io_spec(current_directory: &Path) -> CatalogLaunchSpec {
        let executable = test_child();
        CatalogLaunchSpec {
            command: format!("\"{}\" --report-io", executable.display()),
            executable,
            current_directory: current_directory.to_owned(),
            job_profile: JobLimitProfile::FixedSleepTest,
            environment: Vec::new(),
            stdin: RoleStdin::Eof,
            log_directory: std::env::temp_dir(),
        }
    }

    /// Both of a role's output streams reach the one log the caller opened, and the role starts in the
    /// directory its spec named rather than beside its program.
    ///
    /// One test for both because they are one creation: the working directory and the two bound handles
    /// are arguments to the same `CreateProcessW`, and the role's own report is the only evidence that
    /// what was passed is what arrived.
    #[test]
    fn a_role_writes_both_streams_into_the_log_the_caller_opened_and_starts_where_it_was_told() {
        let logs = LogDirectory::create();
        let (log_path, log) = logs.open_log();
        // A directory that is not the one the program sits in, so "started where it was told" cannot be
        // satisfied by the old behaviour of deriving it from the executable.
        let working = LogDirectory::create();
        let job = Job::create(JobLimitProfile::FixedSleepTest).expect("Job should be creatable");

        let mut child = launch_catalog_same_account(&report_io_spec(&working.0), Some(&job), log)
            .expect("same-account launch should succeed");
        // No writer is kept, so the role sees end-of-file on its standard input immediately. That is what
        // lets it finish rather than block on a payload that is never coming.
        drop(child.take_stdin_writer().expect("stdin writer"));
        assert_eq!(
            child
                .wait(Duration::from_secs(30))
                .expect("the reporting child should exit"),
            0
        );
        job.terminate_and_confirm_drained(Duration::from_secs(10))
            .expect("the Job should drain");

        let written = std::fs::read_to_string(&log_path).expect("the log should be readable");
        assert!(written.contains("stdout-sentinel"), "{written}");
        assert!(
            written.contains("stderr-sentinel"),
            "standard error reached somewhere other than the log: {written}"
        );
        assert!(
            written.contains(&format!("cwd={}", working.0.display())),
            "{written}"
        );
        assert!(written.contains("stdin-bytes=0"), "{written}");
        assert!(
            child.take_stdout_reader().is_err() && child.take_stderr_reader().is_err(),
            "a role whose output goes to a log must expose no reader to copy it through this process"
        );
    }

    /// A bounded payload arrives byte-for-byte and is followed by end-of-file.
    ///
    /// The payload here is a sentinel rather than a real bootstrap, and that is the point: this test is
    /// about delivery, and `connector_bootstrap` owns what the real payload contains. The role echoes what
    /// it read, so a partial write, an extra byte or a missing terminator all fail here.
    #[test]
    fn a_bounded_stdin_payload_arrives_whole_and_is_followed_by_end_of_file() {
        use std::io::Write;

        let logs = LogDirectory::create();
        let (log_path, log) = logs.open_log();
        let working = LogDirectory::create();
        let job = Job::create(JobLimitProfile::FixedSleepTest).expect("Job should be creatable");
        let mut child = launch_catalog_same_account(&report_io_spec(&working.0), Some(&job), log)
            .expect("same-account launch should succeed");

        let payload = format!("{{\"sentinel\":\"{}\"}}\n", "a".repeat(64));
        let mut writer = child.take_stdin_writer().expect("stdin writer");
        writer
            .write_all(payload.as_bytes())
            .expect("the whole payload should be written");
        writer.flush().expect("flush");
        drop(writer);

        assert_eq!(
            child
                .wait(Duration::from_secs(30))
                .expect("the reporting child should exit"),
            0
        );
        job.terminate_and_confirm_drained(Duration::from_secs(10))
            .expect("the Job should drain");

        let written = std::fs::read_to_string(&log_path).expect("the log should be readable");
        assert!(
            written.contains(&format!("stdin-bytes={}", payload.len())),
            "{written}"
        );
        assert!(written.contains(payload.trim_end()), "{written}");
    }

    /// A launch that names no Job - the runner's role launch, which inherits the owner-held Job instead -
    /// claims no membership check. The test child refuses any command line but its one fixed form, so it
    /// exits non-zero immediately; that is enough to prove the creation path and the stdio pipes work
    /// with no Job installed.
    #[test]
    fn a_launch_that_names_no_job_claims_no_membership_check() {
        let executable = test_child();
        let mut child = spawn_same_account(SameAccountSpawn {
            executable: &executable,
            command: &format!("\"{}\" --sleep-ms 0", executable.display()),
            current_directory: executable.parent().expect("a parent directory"),
            declared_environment: &[],
            job: None,
            stdio: RoleStdio::Pipes,
        })
        .expect("same-account launch should succeed");

        assert!(!child.job_membership_verified_before_resume());
        let mut stdout = child.take_stdout_reader().expect("stdout reader");
        drop(child.take_stdin_writer().expect("stdin writer"));
        let mut reported = String::new();
        std::io::Read::read_to_string(&mut stdout, &mut reported).expect("stdout should reach EOF");
        assert_eq!(reported, "");
        assert_ne!(
            child
                .wait(Duration::from_secs(10))
                .expect("child should exit"),
            0
        );
    }
}
