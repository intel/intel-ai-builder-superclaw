//! The first hop: `CreateProcessWithLogonW` into a tier account.
//!
//! # Why this call and not `CreateProcessAsUserW`
//!
//! An interactive elevated administrator token does not hold `SeAssignPrimaryTokenPrivilege`, so
//! launching with a foreign token fails with Win32 1314 no matter how the token was obtained. Rather
//! than acquire the privilege, the design stops needing it: `CreateProcessWithLogonW` performs the
//! logon inside the Secondary Logon service and hands back a process that is already running as the
//! tier account, and the caller needs no privilege at all. That is why this module is reachable from
//! the unelevated launcher and why `tests/launcher_closure.rs` still forbids every token API here.
//!
//! # What this call cannot do, and why that is by design
//!
//! It has no `bInheritHandles` parameter and no attribute list: **no handle crosses this hop**. The
//! consequences are deliberate rather than worked around.
//!
//! - No Job can be named at creation, so the process this call starts - the tier bootstrap (#3499) - is
//!   created suspended and the owner assigns it to the owner-held role Job through the process handle
//!   this call returns, verifies membership, protects it, and only then resumes it (#3010). The tier
//!   never receives a Job handle; the supervisor and its role inherit the Job.
//! - No stdio pipe can be handed over, so the bootstrap has no usable standard error. Its account of
//!   what it did is its one authenticated handoff frame, or the exit code of the step it stopped at, and
//!   the supervisor's arrives on the report pipe. The `--tier-loopback-self-test` mode keeps the
//!   same-account path, and with it captured diagnostics, for the unelevated test suite.
//! - `EXTENDED_STARTUPINFO_PRESENT` is not passed and `STARTUPINFOEXW` is not used: this API takes a
//!   plain `STARTUPINFOW`, and an extended one would be silently misread.
//!
//! # The password
//!
//! `lppassword` is borrowed from a `ZeroizedWide` the caller owns, for the duration of one call. This
//! module never copies it, never stores it and never formats it: a `LogonAttemptError` carries a Win32
//! code, and the classification below is a function of that code alone. The caller drops the container
//! as soon as the call returns, which bounds the lifetime of the plaintext password.

use crate::launch_environment::encode_environment_block;
use crate::process_win32::{JOB_EXIT_CODE, OwnedHandle, wide_null};
use crate::zeroize::ZeroizedWide;
use std::io;
use std::mem::size_of;
use std::path::Path;
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_ACCOUNT_DISABLED, ERROR_ACCOUNT_LOCKED_OUT,
    ERROR_ACCOUNT_RESTRICTION, ERROR_FILE_NOT_FOUND, ERROR_INVALID_LOGON_HOURS,
    ERROR_INVALID_WORKSTATION, ERROR_LOGON_FAILURE, ERROR_LOGON_TYPE_NOT_GRANTED,
    ERROR_NO_SUCH_LOGON_SESSION, ERROR_NO_SUCH_USER, ERROR_PASSWORD_EXPIRED,
    ERROR_PASSWORD_MUST_CHANGE, ERROR_PATH_NOT_FOUND, ERROR_SERVICE_DISABLED,
    ERROR_SERVICE_NOT_ACTIVE, ERROR_SERVICE_REQUEST_TIMEOUT, GetLastError, WAIT_FAILED,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_PROCESS_LOGON_FLAGS, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    CreateProcessWithLogonW, GetExitCodeProcess, PROCESS_INFORMATION, ResumeThread, STARTUPINFOW,
    TerminateProcess, WaitForSingleObject,
};

/// The logon flags for the first hop.
///
/// Zero, meaning no profile is loaded for the tier account. The launch policy prefers this over
/// `LOGON_WITH_PROFILE` for one reason that outweighs convenience: loading a profile creates a
/// registry hive and a profile directory for the tier account, which is persistent state that
/// `--revoke` would then have to find and remove, and a revoke that leaves state behind is not a
/// revoke. With no hive there is nothing to unmount and nothing to clean up.
///
/// The cost is that the tier process has no per-account `USERPROFILE`, `APPDATA` or `TEMP`, which is
/// why `launch_environment::resolve_cross_account_environment` removes those names rather than passing
/// the owner's values across, and why a role that needs a writable location declares one.
///
/// The fallback, should a role ever be found to need a loaded hive, is to give this constant the value
/// `LOGON_WITH_PROFILE`. It is a single named constant so that no call site can disagree with another
/// about the flags.
///
/// **It stopped being a one-token change.** The first hop is per role, so a tier with three roles logs
/// on to the same account three times concurrently, and under `LOGON_WITH_PROFILE` that means loading
/// one profile three times at once - which is where profile load and unload contention lives. The
/// fallback was designed when each tier had exactly one role. Switching it now requires concurrent
/// same-account profile loading to be verified first, or the fallback to be removed outright.
/// Concurrent profile loading remains an open verification item.
///
/// Concurrent logon at this value is not the same question and is not open: `dwLogonFlags = 0` is
/// exercised in production by an external implementation that logs the same sandbox account on once per
/// executed command and serializes nothing, at a rate far above three roles.
pub const TIER_LOGON_FLAGS: CREATE_PROCESS_LOGON_FLAGS = 0;

/// `.` selects the local SAM. The tier account is created by `NetUserAdd` on this machine, so naming
/// the local domain explicitly is both correct and a refusal of anything else: a bare account name
/// could otherwise be resolved against a trusted domain, and the account that logged on would not be
/// the account whose SID the pipes are bound to.
const LOCAL_DOMAIN: &str = ".";

/// `RPC_S_SERVER_UNAVAILABLE`. Not exported by `windows_sys::Win32::Foundation`, so it is spelled out
/// here; the Secondary Logon service is reached over RPC, and an RPC failure to reach it is a
/// service-availability failure rather than a logon failure.
const RPC_S_SERVER_UNAVAILABLE: u32 = 1722;
/// `RPC_S_SERVER_TOO_BUSY`, for the same reason.
const RPC_S_SERVER_TOO_BUSY: u32 = 1723;

/// How long a dropped, unreaped runner is given to die before its handle is closed anyway. Matches
/// `process_same_account`, for the same reason: the common case should be an observed exit.
const DROP_TERMINATE_WAIT_MS: u32 = 2_000;

/// The largest wait this module asks the kernel for. `INFINITE` is `u32::MAX`, so saturating a
/// caller's finite budget there would silently turn a bounded wait into an unbounded one.
const LONGEST_WAIT_MS: u128 = u32::MAX as u128 - 1;

/// Everything one cross-account creation needs.
pub struct TierLogonSpec<'a> {
    /// The derived tier account name, resolved and validated by the caller before it gets here.
    pub account_name: &'a str,
    /// Borrowed for the duration of the call only.
    pub password: &'a ZeroizedWide,
    pub executable: &'a Path,
    /// The full command line, assembled by the launcher. Never caller-supplied argv.
    pub command: &'a str,
    /// The exact variable set the bootstrap gets, already filtered to machine scope by the caller. There
    /// is no path here that passes `NULL` and inherits the owner's environment.
    pub environment: &'a [(String, String)],
}

/// Why one attempt did not produce a process.
pub enum LogonAttemptError {
    /// The attempt was abandoned before the Win32 call: a path that is not Unicode, an environment
    /// that will not encode. Never a logon failure, so never retried and never classified as one.
    Preparation(io::Error),
    /// `CreateProcessWithLogonW` failed, carrying the raw `GetLastError` code.
    Logon(u32),
}

/// What one `CreateProcessWithLogonW` failure code means.
///
/// The classes are chosen by what the caller must *do*, not by how Windows groups the codes: the two
/// retryable classes are retried once against a freshly reread credential, the rest are refused
/// immediately with their own reason, and `Unclassified` is the only class that consults the service
/// state before deciding.
///
/// Two codes share the retry behaviour and nothing else, so they are two classes rather than one. What
/// a caller does with them is identical, which is what `is_retryable` is for; what a caller *says* about
/// them cannot be, because one means the stored password is wrong and the other means it was never
/// tested. A single class would have forced one sentence to cover both, and that sentence would have
/// been false half the time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogonFailureClass {
    /// `ERROR_LOGON_FAILURE`: the stored credential did not authenticate. The launch retry policy
    /// requires one atomic reread and one retry for this code, because a provision that rotated the password
    /// between this launcher's read and its logon is the expected benign cause, and the reread resolves
    /// it without an operator.
    RetryableCredential,
    /// `ERROR_NO_SUCH_LOGON_SESSION`: the logon session went away underneath the call, so the
    /// credential was never judged. Retried for the same reason - the second attempt is cheap and the
    /// condition is transient - but it says nothing about the password, and the refusal must not claim
    /// it does.
    RetryableSession,
    /// The account or its password is not in the state provisioning leaves behind, and no retry can
    /// change that.
    Provision,
    /// The account authenticated but policy forbids it logging on interactively here.
    LocalLogonDenied,
    /// The Secondary Logon service could not service the request.
    Seclogon,
    /// The launcher image itself could not be reached as the tier account: absent, or its directory not
    /// traversable, or read and execute not granted. These codes describe the *creation* half of the
    /// call rather than the credential or the service, so the remedy is an ACL on the install directory
    /// applied during provisioning rather than anything done to the account or to seclogon.
    LauncherImageUnreachable,
    /// No established meaning for this call.
    Unclassified,
}

impl LogonFailureClass {
    /// Whether one atomic credential reread and one more attempt is worth making.
    ///
    /// The retry policy is this predicate and the `LOGON_ATTEMPTS` budget beside it, so a caller never
    /// spells out a set of classes and cannot disagree with another caller about it.
    pub const fn is_retryable(self) -> bool {
        matches!(self, Self::RetryableCredential | Self::RetryableSession)
    }
}

pub fn classify_logon_error(code: u32) -> LogonFailureClass {
    match code {
        ERROR_LOGON_FAILURE => LogonFailureClass::RetryableCredential,
        ERROR_NO_SUCH_LOGON_SESSION => LogonFailureClass::RetryableSession,
        ERROR_NO_SUCH_USER
        | ERROR_PASSWORD_EXPIRED
        | ERROR_ACCOUNT_DISABLED
        | ERROR_PASSWORD_MUST_CHANGE
        | ERROR_ACCOUNT_LOCKED_OUT => LogonFailureClass::Provision,
        ERROR_LOGON_TYPE_NOT_GRANTED
        | ERROR_ACCOUNT_RESTRICTION
        | ERROR_INVALID_LOGON_HOURS
        | ERROR_INVALID_WORKSTATION => LogonFailureClass::LocalLogonDenied,
        ERROR_SERVICE_REQUEST_TIMEOUT
        | ERROR_SERVICE_DISABLED
        | ERROR_SERVICE_NOT_ACTIVE
        | RPC_S_SERVER_UNAVAILABLE
        | RPC_S_SERVER_TOO_BUSY => LogonFailureClass::Seclogon,
        // The creation half of the call, reported through the same code as the logon half. All three
        // are what an install directory the tier account cannot read, execute or traverse looks like
        // from here, and none of them has any other plausible cause on this path: the image is this
        // running executable, so the owner can obviously reach it, and every other input is derived.
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND | ERROR_ACCESS_DENIED => {
            LogonFailureClass::LauncherImageUnreachable
        }
        _ => LogonFailureClass::Unclassified,
    }
}

/// Which policy refused, for a code in the `LocalLogonDenied` class.
///
/// Four codes, one reason, four different places to look. The remedy on `local_logon_denied` names the
/// interactive-logon right, because that is the case an operator actually meets on a hardened machine;
/// the other three would be misdescribed by it, and an operator sent to the wrong policy is worse off
/// than one sent nowhere. The text is a function of the code alone, exactly like the classification
/// above, which is why it lives here rather than in the refusal builder.
///
/// A code outside that class cannot reach this, so the fallback claims nothing the class does not.
pub fn local_logon_denial(code: u32) -> &'static str {
    match code {
        ERROR_LOGON_TYPE_NOT_GRANTED => {
            "the account authenticated but does not hold the interactive logon right on this \
             machine, so either `Deny log on locally` now covers it or `Allow log on locally` no \
             longer does"
        }
        ERROR_ACCOUNT_RESTRICTION => {
            "the account authenticated but an account restriction refused the logon: an empty \
             password, which no provisioned tier account has, or a restriction recorded on the \
             account itself rather than in policy"
        }
        ERROR_INVALID_LOGON_HOURS => {
            "the account authenticated but this is outside the hours its policy permits it to log \
             on, so the same launch would succeed at another time of day"
        }
        ERROR_INVALID_WORKSTATION => {
            "the account authenticated but it is restricted to a list of workstations that does not \
             include this machine"
        }
        _ => "the account authenticated but policy forbids it logging on to this machine",
    }
}

/// A running tier-account child: a retained process handle, its process id, and nothing else.
///
/// The handle is what makes the id trustworthy. While it is open the kernel cannot recycle the id, so
/// the `GetNamedPipeClientProcessId` comparison both pipes perform is a comparison against this exact
/// process rather than against whatever later took its number.
pub struct LogonChild {
    process: OwnedHandle,
    /// The primary thread, held while the runner is suspended and released by `resume`.
    thread: Option<OwnedHandle>,
    pid: u32,
    /// Set once `wait` has seen the child exit, so drop does not ask the kernel to kill a corpse.
    reaped: bool,
}

impl LogonChild {
    pub const fn pid(&self) -> u32 {
        self.pid
    }

    /// Resumes the runner's primary thread, exactly once, after the owner has put it in the role Job.
    ///
    /// `CREATE_SUSPENDED` accounts for one suspension. A previous count of anything else means
    /// something other than this launch suspended the thread, and the runner would look started while
    /// running nothing; that is a refusal, and dropping the child terminates it.
    pub fn resume(&mut self) -> io::Result<()> {
        let thread = self
            .thread
            .take()
            .ok_or_else(|| io::Error::other("the tier runner was already resumed"))?;
        // SAFETY: The thread handle came from the creation and is resumed exactly once here.
        match unsafe { ResumeThread(thread.raw()) } {
            u32::MAX => Err(io::Error::last_os_error()),
            1 => Ok(()),
            previous => Err(io::Error::other(format!(
                "the tier runner's primary thread had suspend count {previous} before resume, so \
                 it is still suspended and is not running"
            ))),
        }
    }

    /// The suspended primary thread, for the owner to protect before it resumes the bootstrap.
    pub fn primary_thread(&self) -> io::Result<&OwnedHandle> {
        self.thread
            .as_ref()
            .ok_or_else(|| io::Error::other("the tier bootstrap was already resumed"))
    }

    /// Ends the child with `code` and returns the exit code it ended with, within `timeout`. A child that
    /// had already exited keeps its own code, which is how the caller tells the two apart.
    pub fn end(&mut self, code: u32, timeout: Duration) -> io::Result<u32> {
        // SAFETY: The retained handle carries PROCESS_TERMINATE; a child that already exited fails the
        // call harmlessly and keeps its own exit code.
        unsafe { TerminateProcess(self.process.raw(), code) };
        self.wait(timeout)
    }

    /// The retained handle, for the pipe binding to read the runner's token SID through.
    ///
    /// Borrowed rather than duplicated so there is exactly one handle to this process in the launcher,
    /// and so the binding cannot outlive the guard that terminates the runner. Reading the SID here
    /// rather than from the process id is not an optimization: the tier process need not be openable by
    /// the owner that created it at all.
    pub const fn process(&self) -> &OwnedHandle {
        &self.process
    }

    pub fn wait(&mut self, timeout: Duration) -> io::Result<u32> {
        let millis = timeout.as_millis().min(LONGEST_WAIT_MS) as u32;
        // SAFETY: The retained process handle is valid for synchronization.
        match unsafe { WaitForSingleObject(self.process.raw(), millis) } {
            WAIT_OBJECT_0 => {
                self.reaped = true;
                let mut code = 0;
                // SAFETY: The process has exited and `code` points to writable storage.
                if unsafe { GetExitCodeProcess(self.process.raw(), &mut code) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(code)
            }
            WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the tier runner did not exit within the wait budget",
            )),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            result => Err(io::Error::other(format!(
                "unexpected tier runner wait result: {result}"
            ))),
        }
    }
}

/// Kill-on-drop, for the window the owner-held Job does not cover.
///
/// Between creation and assignment the runner is suspended and in no Job of the owner's, so closing the
/// Job would not reach it; a launcher that failed there would leave a suspended process in the tier
/// account. Terminating it here is what closes that window. After assignment the Job's kill-on-close
/// covers the runner and its whole tree regardless.
impl Drop for LogonChild {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        // SAFETY: The handle is owned here and still open. Terminating a process that has already
        // exited fails harmlessly, which is why the result is discarded: there is no caller left to
        // report it to.
        unsafe {
            TerminateProcess(self.process.raw(), JOB_EXIT_CODE);
            WaitForSingleObject(self.process.raw(), DROP_TERMINATE_WAIT_MS);
        }
    }
}

/// Starts `spec.command` as `spec.account_name`, one attempt, no retry.
///
/// Retrying is the caller's decision because only the caller can do the thing that makes a retry
/// meaningful: reread the credential. See `LogonFailureClass::Retryable`.
pub fn spawn_with_logon(spec: &TierLogonSpec<'_>) -> Result<LogonChild, LogonAttemptError> {
    let prepared = prepare(spec).map_err(LogonAttemptError::Preparation)?;
    let mut command = prepared.command;
    let mut environment_block = prepared.environment_block;

    // `lpDesktop` is always null. That is the only way the new tier logon initializes `user32` at all:
    // Secondary Logon then gives it the caller's logon SID, which the caller's window station and desktop
    // grant, and that reaches the bootstrap only on `WinSta0`; the owner hop refuses to start from
    // anywhere else (`window_station.rs`, #3292). The same logon SID is why the bootstrap is not a role
    // and runs there only until it has created the tier's private station and desktop and started the
    // supervisor on them (#3400, #3499). An explicit `lpDesktop` gives the logon a fresh SID instead,
    // which no station it could open grants, and every image that loads `user32` dies at initialization
    // (measured). `CREATE_NO_WINDOW` states that nothing here draws; the bootstrap is a
    // GUI-subsystem image, so no console is created for it either way. `STARTF_USESTDHANDLES` is absent
    // because no handle can cross this hop.
    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut process_info = PROCESS_INFORMATION::default();

    // SAFETY: Every string is NUL-terminated and outlives the call. `password` is borrowed from a
    // container the caller keeps alive across it. The environment block is a non-empty explicit block,
    // so the child never inherits this process's environment. No handle is passed, because this API
    // cannot pass one.
    let created = unsafe {
        CreateProcessWithLogonW(
            prepared.account_name.as_ptr(),
            prepared.domain.as_ptr(),
            spec.password.as_ptr(),
            TIER_LOGON_FLAGS,
            prepared.application.as_ptr(),
            command.as_mut_ptr(),
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            environment_block.as_mut_ptr().cast(),
            prepared.working_directory.as_ptr(),
            &startup,
            &mut process_info,
        )
    };
    if created == 0 {
        // Read before anything else runs: any intervening call can overwrite the thread's last error.
        // SAFETY: Reading the calling thread's last-error value is always sound.
        return Err(LogonAttemptError::Logon(unsafe { GetLastError() }));
    }

    // The kill-on-drop guard is built before anything else that can fail, because the runner exists by
    // now. Adopting the thread handle first would mean a refusal to adopt it returned an error with a
    // tier process behind it and no guard in existence, which is the one outcome this hop cannot leave.
    let process =
        OwnedHandle::new(process_info.hProcess).map_err(LogonAttemptError::Preparation)?;
    let mut child = LogonChild {
        process,
        thread: None,
        pid: process_info.dwProcessId,
        reaped: false,
    };
    // Kept for `resume`. A failure to adopt it drops `child`, which terminates the suspended runner.
    child.thread =
        Some(OwnedHandle::new(process_info.hThread).map_err(LogonAttemptError::Preparation)?);
    Ok(child)
}

/// Everything that has to be encoded before the call, so no fallible conversion sits between the
/// `CreateProcessWithLogonW` call and the `GetLastError` that describes it.
struct Prepared {
    account_name: Vec<u16>,
    domain: Vec<u16>,
    application: Vec<u16>,
    command: Vec<u16>,
    working_directory: Vec<u16>,
    environment_block: Vec<u16>,
}

fn prepare(spec: &TierLogonSpec<'_>) -> io::Result<Prepared> {
    let application = spec.executable.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "non-Unicode executable path")
    })?;
    let working_directory = spec
        .executable
        .parent()
        .and_then(Path::to_str)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "the launcher executable has no usable parent directory",
            )
        })?;
    Ok(Prepared {
        account_name: wide_null(spec.account_name),
        domain: wide_null(LOCAL_DOMAIN),
        application: wide_null(application),
        command: wide_null(spec.command),
        working_directory: wide_null(working_directory),
        environment_block: encode_environment_block(spec.environment)?,
    })
}

/// The runner's command line, which is this same executable in `--tier-runner` mode: the supervisor's
/// in production, which the tier bootstrap builds from the same definition, and the loopback runner's.
///
/// The runner receives a tier, a pipe id and a per-launch key and nothing else, and there is no argument
/// on it that a caller supplied.
pub fn tier_runner_command(launcher: &Path, tier: &str, pipe_id: &str, key_hex: &str) -> String {
    crate::tier_handoff::runner_command_line(launcher, tier, pipe_id, key_hex)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::Threading::LOGON_WITH_PROFILE;

    /// The flags are pinned as a value, and the documented fallback is pinned beside them, so a change
    /// from one to the other is a deliberate edit to a constant rather than a drifting call site.
    ///
    /// Deliberate is no longer the same as cheap: with three roles in a tier, switching to
    /// `LOGON_WITH_PROFILE` loads one profile concurrently three times. The constant's own comment
    /// carries that precondition; this case only holds the two values apart.
    #[test]
    fn the_first_hop_loads_no_profile_and_names_its_fallback() {
        assert_eq!(TIER_LOGON_FLAGS, 0);
        assert_eq!(LOGON_WITH_PROFILE, 1);
        assert_ne!(
            TIER_LOGON_FLAGS, LOGON_WITH_PROFILE,
            "loading a profile hive creates tier-account state that --revoke would have to remove"
        );
        assert_eq!(LOCAL_DOMAIN, ".");
    }

    /// Every code the two-hop design can actually meet, mapped to the action it implies. The table is
    /// the contract between `CreateProcessWithLogonW` and the refusal vocabulary, so it is asserted
    /// exhaustively rather than sampled.
    #[test]
    fn every_known_logon_code_maps_to_the_action_it_implies() {
        assert_eq!(
            classify_logon_error(ERROR_LOGON_FAILURE),
            LogonFailureClass::RetryableCredential
        );
        assert_eq!(
            classify_logon_error(ERROR_NO_SUCH_LOGON_SESSION),
            LogonFailureClass::RetryableSession
        );
        for code in [
            ERROR_NO_SUCH_USER,
            ERROR_PASSWORD_EXPIRED,
            ERROR_ACCOUNT_DISABLED,
            ERROR_PASSWORD_MUST_CHANGE,
            ERROR_ACCOUNT_LOCKED_OUT,
        ] {
            assert_eq!(
                classify_logon_error(code),
                LogonFailureClass::Provision,
                "{code}"
            );
        }
        for code in [
            ERROR_LOGON_TYPE_NOT_GRANTED,
            ERROR_ACCOUNT_RESTRICTION,
            ERROR_INVALID_LOGON_HOURS,
            ERROR_INVALID_WORKSTATION,
        ] {
            assert_eq!(
                classify_logon_error(code),
                LogonFailureClass::LocalLogonDenied,
                "{code}"
            );
        }
        for code in [
            ERROR_SERVICE_REQUEST_TIMEOUT,
            ERROR_SERVICE_DISABLED,
            ERROR_SERVICE_NOT_ACTIVE,
            RPC_S_SERVER_UNAVAILABLE,
            RPC_S_SERVER_TOO_BUSY,
        ] {
            assert_eq!(
                classify_logon_error(code),
                LogonFailureClass::Seclogon,
                "{code}"
            );
        }
        // Install-directory access is a provisioning prerequisite and the most likely failure on a
        // hardened image. Landing in `Unclassified` would answer it with "no local remedy is known".
        for code in [
            ERROR_FILE_NOT_FOUND,
            ERROR_PATH_NOT_FOUND,
            ERROR_ACCESS_DENIED,
        ] {
            assert_eq!(
                classify_logon_error(code),
                LogonFailureClass::LauncherImageUnreachable,
                "{code}"
            );
        }
        // 1314 is the code the whole two-hop design exists to avoid, and it must not be quietly
        // absorbed into a class that suggests a remedy: seeing it here would mean the launcher had
        // somehow taken the token path.
        for code in [0, 1314, 87, u32::MAX] {
            assert_eq!(
                classify_logon_error(code),
                LogonFailureClass::Unclassified,
                "{code}"
            );
        }
    }

    /// The retry set is exactly the two codes the plan names. Widening it silently would turn a
    /// permanent failure into two identical failures and a slower refusal.
    ///
    /// Asked of `is_retryable` rather than of the class names, because that predicate is what the owner
    /// hop branches on: a third retryable class added without a reason would be caught here.
    #[test]
    fn only_a_credential_that_may_have_been_rotated_is_worth_a_retry() {
        let retryable: Vec<u32> = (0..2100)
            .filter(|code| classify_logon_error(*code).is_retryable())
            .collect();
        assert_eq!(
            retryable,
            vec![ERROR_NO_SUCH_LOGON_SESSION, ERROR_LOGON_FAILURE]
        );
    }

    /// Each denial code gets its own sentence. One shared sentence would be right for at most one of
    /// them, and the operator reading it has no other way to tell which policy to open.
    #[test]
    fn each_local_logon_denial_names_the_policy_that_refused() {
        let denials: Vec<&str> = [
            ERROR_LOGON_TYPE_NOT_GRANTED,
            ERROR_ACCOUNT_RESTRICTION,
            ERROR_INVALID_LOGON_HOURS,
            ERROR_INVALID_WORKSTATION,
        ]
        .iter()
        .map(|code| local_logon_denial(*code))
        .collect();
        for (index, denial) in denials.iter().enumerate() {
            assert!(
                !denials[..index].contains(denial),
                "two denial codes share one description: {denial}"
            );
            assert!(
                !denial.contains("  "),
                "line-continuation artifact: {denial}"
            );
        }
        assert!(denials[0].contains("interactive logon right"));
        assert!(denials[1].contains("empty password"));
        assert!(denials[2].contains("hours"));
        assert!(denials[3].contains("workstations"));
    }

    #[test]
    fn the_runner_command_line_carries_a_tier_a_pipe_and_a_key_and_nothing_else() {
        let command = tier_runner_command(
            Path::new(r"C:\Program Files\SuperClaw\native_isolation_launcher.exe"),
            "bootstrap",
            "a1b2",
            &"ab".repeat(32),
        );
        assert_eq!(
            command,
            format!(
                "\"C:\\Program Files\\SuperClaw\\native_isolation_launcher.exe\" --tier-runner \
                 --tier bootstrap --pipe-id a1b2 --auth-key {}",
                "ab".repeat(32)
            )
        );
        // The quoting is what keeps a space in the install path from splitting into two arguments.
        assert!(command.starts_with('"'));
    }

    /// An environment that would encode to nothing is refused before the call rather than passed as a
    /// null block, which is how `CreateProcessWithLogonW` is told to inherit the owner's environment.
    /// This is the one preparation failure that would be a confidentiality bug rather than an error.
    #[test]
    fn a_cross_account_launch_can_never_ask_to_inherit_the_owner_environment() {
        let password = ZeroizedWide::from_utf8(b"unused").expect("a valid password");
        // Matched rather than unwrapped through `expect_err`, which would need `Prepared` to be
        // `Debug`. Nothing in the preparation is a secret, but it sits one struct field away from one,
        // so the whole logon path stays free of derived formatting.
        match prepare(&TierLogonSpec {
            account_name: "SCBBZUMXK5U6MIU7VEA4",
            password: &password,
            executable: Path::new(r"C:\SuperClaw\native_isolation_launcher.exe"),
            command: "unused",
            environment: &[],
        }) {
            Ok(_) => panic!("an empty environment must not encode to a null block"),
            Err(error) => assert_eq!(error.kind(), io::ErrorKind::InvalidInput),
        }
    }

    /// The first hop names no desktop: there is no field to put one in, and the creation's
    /// `STARTUPINFOW` sets none. Pinned in the source, because the call itself is only reachable with a
    /// real tier account.
    #[test]
    fn the_first_hop_never_names_a_desktop() {
        let source = include_str!("logon.rs");
        let creation = source
            .split("let startup = STARTUPINFOW {")
            .nth(1)
            .and_then(|rest| rest.split("};").next())
            .expect("the first hop builds one STARTUPINFOW");
        assert!(!creation.contains("lpDesktop"), "{creation}");
        let spec = source
            .split("pub struct TierLogonSpec")
            .nth(1)
            .and_then(|rest| rest.split('}').next())
            .expect("the spec is declared here");
        assert!(!spec.contains("desktop"), "{spec}");
    }
}
