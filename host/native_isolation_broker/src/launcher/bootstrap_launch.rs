//! The owner's half of a production tier launch (#3499, #3400): from the suspended bootstrap to a resumed
//! supervisor on the tier's private desktop.
//!
//! # The order, and why each step is where it is
//!
//! 1. **Assign the bootstrap** to the role's Job, which holds seven of its eight UI limits, and read
//!    membership back. The bootstrap is still suspended.
//! 2. **Protect the bootstrap**: replace its process and primary-thread DACLs with SYSTEM, its own tier
//!    and `OWNER RIGHTS` (`bootstrap_protection.rs`). This stops new opens of those two by every other
//!    tier; its own tier keeps access, and a handle opened since creation survives it (#3713).
//! 3. **Resume the bootstrap.** Its own first instructions protect the rest of it. Until they complete, a
//!    thread the loader creates after resume carries the creation-time default DACL, and a handle opened
//!    to it survives that protection too (#3713).
//! 4. **Receive the handoff**: the one frame on the handoff pipe, bound like every tier pipe to the exact
//!    process this launch created and its token SID, authenticated, strictly typed and bounded. A bootstrap
//!    that exits instead is reported by the step its exit code names.
//! 5. **Seal the UI limits**: apply `JOB_OBJECT_UILIMIT_DESKTOP` and read all eight back. The bootstrap
//!    needs that limit absent only for its `CreateDesktopW`, which it calls before it sends the handoff;
//!    after the handoff it only waits to be ended. From here every process in the Job, the still-running
//!    bootstrap included, is under all eight.
//! 6. **Adopt the desktop** and 7. **the supervisor** (`tier_desktop_adopt.rs`): duplicate, then verify
//!    type, name, access, descriptor, Job membership, pid, thread and image. The supervisor's token is
//!    not readable through the owner's handle, so it is verified at each pipe binding after step 10, by
//!    impersonation, before anything is sent on that pipe.
//! 8. **Release the bootstrap**: end it and observe its exit. It is the last process of this launch that
//!    ran on `WinSta0`, and it is gone before anything else resumes. It also held a full-access handle
//!    to the supervisor, which is why the next step comes after it.
//! 9. **Verify the supervisor's desktop** (`process_desktop.rs`): read the `DesktopInfo` the suspended
//!    supervisor was created with from its own memory, through the verified full-access process handle,
//!    and require exactly the adopted `station\desktop`. The check exists to catch a wrong `lpDesktop` from
//!    the bootstrap, which chose it and is the process the #3713 window exposes, not to exclude a later
//!    write (below).
//! 10. **Resume the supervisor**, which is today's tier runner and binds to the pipes next. A suspend
//!     count other than 1 means something else resumed it, and is a refusal.
//!
//! # What the order does not cover (#3713)
//!
//! From step 3 until step 5 the Job holds seven of its eight UI limits, so a process of the same tier
//! that gets into the bootstrap in that span - the bootstrap's protective DACLs grant the tier - can make
//! it call `CreateDesktop` or `SwitchDesktop` on `WinSta0` with the owner's logon SID.
//!
//! The suspended supervisor is not locked. Its process and primary thread grant the tier and SYSTEM full
//! access by design (`tier_desktop_policy::supervisor_object_descriptor`), so from its creation until
//! step 10 a process of the same tier can open both, write its memory and manipulate its thread - change
//! its context, or resume it before steps 8 and 9 have run. Step 10 refuses an early resume left running,
//! but cannot prevent the supervisor's code having run by then - under seven of the eight UI limits if it
//! ran before step 5 - and a thread resumed and suspended again shows the count it expects. Whatever
//! such a process makes the supervisor do runs with its restricted token, which keeps the owner's
//! interactive logon SID enabled (#3805), so it can open a handle to `WinSta0`, the owner's desktop and -
//! because an owner process's DACL grants that logon SID - an owner process. Closing this is a protected
//! supervisor DACL at creation, follow-up work under #3713.
//!
//! Every step's failure is a `windows_api_failure` refusal naming the step. No step has a fallback: there
//! is no path from here to a supervisor on `WinSta0`, a null desktop, or an unrestricted token, and a
//! failure leaves the suspended processes to the Job's kill-on-close.

use super::bootstrap_protection::protect_bootstrap;
use super::logon::LogonChild;
use super::pipe::TierPipeServer;
use super::process_desktop::{desktop_info, require_desktop};
use super::refusal::{RefusalContext, TierLaunchRefusal, TierLaunchRefusalReason, refuse};
use super::role_job::RoleJob;
use super::tier_desktop_adopt::{
    AdoptedDesktop, AdoptedSupervisor, DesktopExpectation, SupervisorExpectation, adopt_desktop,
    adopt_supervisor,
};
use crate::process_win32::{JOB_EXIT_CODE, OwnedHandle};
use crate::tier::IsolationTier;
use crate::tier_desktop_policy::{DesktopTrustees, desktop_name, station_name};
use crate::tier_handoff::{self, BOOTSTRAP_RELEASED_EXIT_CODE, BootstrapStep, Handoff};
use crate::token_info::{authentication_id, open_process_token};
use std::io;
use std::os::windows::io::BorrowedHandle;
use std::path::Path;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::Security::TOKEN_QUERY;
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, ResumeThread, TerminateProcess, WaitForSingleObject,
};

/// How long the bootstrap is given to connect and send its handoff. Its own budget is the same, and it
/// starts after the owner's.
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(15);

/// How often a wait for the handoff looks at whether the bootstrap has exited instead.
const HANDOFF_POLL: Duration = Duration::from_millis(100);

/// How long the bootstrap is given to be gone once the owner ends it.
const RELEASE_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a dropped, unreaped supervisor is given to die before its handle is closed anyway.
const DROP_TERMINATE_WAIT_MS: u32 = 2_000;

/// The largest finite wait this module asks the kernel for.
const LONGEST_WAIT_MS: u128 = u32::MAX as u128 - 1;

/// The detail every refusal on this path starts with.
pub(super) const PRIVATE_DESKTOP_FAILURE: &str =
    "the tier's private window station and desktop could not be set up";

/// The owner's steps, in the one order they run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HandoffStep {
    AssignBootstrap,
    ProtectBootstrap,
    ResumeBootstrap,
    ReceiveHandoff,
    SealUiLimits,
    AdoptDesktop,
    AdoptSupervisor,
    ReleaseBootstrap,
    VerifySupervisorDesktop,
    ResumeSupervisor,
}

impl HandoffStep {
    pub(super) const SEQUENCE: [Self; 10] = [
        Self::AssignBootstrap,
        Self::ProtectBootstrap,
        Self::ResumeBootstrap,
        Self::ReceiveHandoff,
        Self::SealUiLimits,
        Self::AdoptDesktop,
        Self::AdoptSupervisor,
        Self::ReleaseBootstrap,
        Self::VerifySupervisorDesktop,
        Self::ResumeSupervisor,
    ];

    /// A short name for diagnostics lines.
    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::AssignBootstrap => "assign",
            Self::ProtectBootstrap => "protect",
            Self::ResumeBootstrap => "resume_bootstrap",
            Self::ReceiveHandoff => "handoff",
            Self::AdoptDesktop => "adopt_desktop",
            Self::AdoptSupervisor => "adopt_supervisor",
            Self::VerifySupervisorDesktop => "verify_supervisor_desktop",
            Self::ReleaseBootstrap => "release",
            Self::SealUiLimits => "seal",
            Self::ResumeSupervisor => "resume_supervisor",
        }
    }

    pub(super) const fn describe(self) -> &'static str {
        match self {
            Self::AssignBootstrap => "placing the tier bootstrap in the role's Job",
            Self::ProtectBootstrap => "protecting the tier bootstrap's process and thread",
            Self::ResumeBootstrap => "resuming the tier bootstrap",
            Self::ReceiveHandoff => "receiving the tier bootstrap's handoff",
            Self::AdoptDesktop => "verifying the private window station and desktop",
            Self::AdoptSupervisor => "verifying the restricted supervisor",
            Self::VerifySupervisorDesktop => "verifying the restricted supervisor's desktop",
            Self::ReleaseBootstrap => "ending the tier bootstrap",
            Self::SealUiLimits => "applying the Job's eighth UI limit",
            Self::ResumeSupervisor => "resuming the restricted supervisor",
        }
    }
}

/// One step of the sequence, performed. The production implementation is `BootstrapHandoff`; tests
/// inject failures through their own.
pub(super) trait HandoffSteps {
    fn perform(&mut self, step: HandoffStep) -> io::Result<()>;
}

/// The step that failed and why.
#[derive(Debug)]
pub(super) struct HandoffFailure {
    pub(super) step: HandoffStep,
    pub(super) error: io::Error,
    pub(super) elapsed: Duration,
}

/// Runs every step in `HandoffStep::SEQUENCE`, stops at the first failure, and returns how long each step
/// took.
pub(super) fn run_handoff(
    steps: &mut impl HandoffSteps,
) -> Result<Vec<(HandoffStep, Duration)>, HandoffFailure> {
    let mut timings = Vec::with_capacity(HandoffStep::SEQUENCE.len());
    for step in HandoffStep::SEQUENCE {
        let started = Instant::now();
        steps.perform(step).map_err(|error| HandoffFailure {
            step,
            error,
            elapsed: started.elapsed(),
        })?;
        timings.push((step, started.elapsed()));
    }
    Ok(timings)
}

/// The refusal a failed step ends the launch with.
pub(super) fn handoff_refusal(failure: &HandoffFailure) -> TierLaunchRefusal {
    TierLaunchRefusal::new(
        TierLaunchRefusalReason::WindowsApiFailure,
        format!(
            "{PRIVATE_DESKTOP_FAILURE}: {} failed after {} ms ({})",
            failure.step.describe(),
            failure.elapsed.as_millis(),
            failure.error
        ),
    )
}

/// `step:milliseconds` for each step, in order, for the adoption lifecycle line.
fn step_timings(timings: &[(HandoffStep, Duration)]) -> String {
    timings
        .iter()
        .map(|(step, elapsed)| format!("{}:{}", step.label(), elapsed.as_millis()))
        .collect::<Vec<_>>()
        .join(",")
}

/// The resumed supervisor, through the handles the owner duplicated, and the station and desktop it runs
/// on, held until the supervisor is dropped - which is after the Job is gone.
pub(super) struct SupervisorChild {
    process: OwnedHandle,
    pid: u32,
    _desktop: AdoptedDesktop,
    reaped: bool,
}

impl SupervisorChild {
    pub(super) const fn pid(&self) -> u32 {
        self.pid
    }

    /// The duplicated handle, for the pipe binding to read the supervisor's token through.
    pub(super) const fn process(&self) -> &OwnedHandle {
        &self.process
    }

    pub(super) fn wait(&mut self, timeout: Duration) -> io::Result<u32> {
        let millis = timeout.as_millis().min(LONGEST_WAIT_MS) as u32;
        // SAFETY: The duplicated process handle carries SYNCHRONIZE.
        match unsafe { WaitForSingleObject(self.process.raw(), millis) } {
            WAIT_OBJECT_0 => {
                self.reaped = true;
                let mut code = 0;
                // SAFETY: The process has exited and `code` is writable.
                if unsafe { GetExitCodeProcess(self.process.raw(), &mut code) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(code)
            }
            WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the supervisor did not exit within the wait budget",
            )),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            result => Err(io::Error::other(format!(
                "unexpected supervisor wait result: {result}"
            ))),
        }
    }
}

/// Kill-on-drop. The Job already covers the supervisor; this only makes the common failure prompt.
impl Drop for SupervisorChild {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        // SAFETY: The handle is owned here and still open; a corpse fails harmlessly.
        unsafe {
            TerminateProcess(self.process.raw(), JOB_EXIT_CODE);
            WaitForSingleObject(self.process.raw(), DROP_TERMINATE_WAIT_MS);
        }
    }
}

/// Everything the owner's half of a production launch works with.
pub(super) struct HandoffLaunch<'a> {
    pub(super) bootstrap: LogonChild,
    pub(super) role_job: &'a mut RoleJob,
    pub(super) pipe: &'a TierPipeServer,
    pub(super) key: &'a [u8],
    pub(super) tier: IsolationTier,
    pub(super) pipe_id: &'a str,
    pub(super) owner_sid: &'a str,
    pub(super) tier_sid: &'a str,
    /// This launcher's own image, which the supervisor must be running.
    pub(super) launcher: &'a Path,
    pub(super) launch_role: &'a str,
    pub(super) role_desktop_boundary: bool,
    pub(super) owner_logon_sid: Option<&'a str>,
}

/// Runs the owner's half of the launch and returns the resumed supervisor, or refuses with the step that
/// failed.
pub(super) fn hand_off(
    context: &RefusalContext<'_>,
    launch: HandoffLaunch<'_>,
) -> io::Result<SupervisorChild> {
    let mut steps = BootstrapHandoff {
        launch,
        handoff: None,
        desktop: None,
        supervisor: None,
        supervisor_desktop_info: None,
    };
    let timings = match run_handoff(&mut steps) {
        Ok(timings) => timings,
        Err(failure) => return Err(refuse(context, handoff_refusal(&failure))),
    };
    let (Some(desktop), Some(supervisor)) = (steps.desktop.take(), steps.supervisor.take()) else {
        return Err(io::Error::other(
            "the handoff completed without a desktop and a supervisor",
        ));
    };
    eprintln!(
        "native_launcher_lifecycle stage=handoff event=adopted role={} bootstrap_pid={} \
         supervisor_pid={} desktop={} supervisor_desktop_info={} ui_restrictions={:#x} \
         supervisor_token={} steps_ms={}",
        steps.launch.launch_role,
        steps.launch.bootstrap.pid(),
        supervisor.pid,
        desktop.path(),
        steps
            .supervisor_desktop_info
            .as_deref()
            .unwrap_or("(not read)"),
        steps.launch.role_job.ui_restrictions()?,
        if supervisor.token_verified_before_resume {
            "verified_before_resume"
        } else {
            "deferred_to_pipe_binding"
        },
        step_timings(&timings),
    );
    Ok(SupervisorChild {
        process: supervisor.process,
        pid: supervisor.pid,
        _desktop: desktop,
        reaped: false,
    })
}

/// The production steps.
struct BootstrapHandoff<'a> {
    launch: HandoffLaunch<'a>,
    handoff: Option<Handoff>,
    desktop: Option<AdoptedDesktop>,
    supervisor: Option<AdoptedSupervisor>,
    /// The `DesktopInfo` read from the suspended supervisor, once it matched the adopted desktop.
    supervisor_desktop_info: Option<String>,
}

impl HandoffSteps for BootstrapHandoff<'_> {
    fn perform(&mut self, step: HandoffStep) -> io::Result<()> {
        let bootstrap = &mut self.launch.bootstrap;
        match step {
            HandoffStep::AssignBootstrap => self.launch.role_job.adopt_bootstrap(bootstrap),
            HandoffStep::ProtectBootstrap => {
                let owner_logon_sid = if self.launch.role_desktop_boundary {
                    Some(self.launch.owner_logon_sid.ok_or_else(|| {
                        io::Error::other(
                            "the role desktop boundary has no owner logon SID for bootstrap protection",
                        )
                    })?)
                } else {
                    None
                };
                protect_bootstrap(
                    bootstrap.process(),
                    bootstrap.primary_thread()?,
                    self.launch.tier_sid,
                    owner_logon_sid,
                )
            }
            HandoffStep::ResumeBootstrap => bootstrap.resume(),
            HandoffStep::ReceiveHandoff => {
                self.handoff = Some(self.receive()?);
                Ok(())
            }
            HandoffStep::AdoptDesktop => {
                let handoff = self.handoff()?;
                let bootstrap = self.launch.bootstrap.process();
                let token = open_process_token(bootstrap.raw(), TOKEN_QUERY)?;
                let (high, low) = authentication_id(&token)?;
                let station = station_name(high, low);
                let desktop = desktop_name(self.launch.pipe_id);
                self.desktop = Some(adopt_desktop(
                    bootstrap.raw(),
                    &handoff,
                    &DesktopExpectation {
                        trustees: DesktopTrustees {
                            owner_sid: self.launch.owner_sid,
                            tier_sid: self.launch.tier_sid,
                        },
                        station_name: &station,
                        desktop_name: &desktop,
                    },
                )?);
                Ok(())
            }
            HandoffStep::AdoptSupervisor => {
                let handoff = self.handoff()?;
                self.supervisor = Some(adopt_supervisor(
                    self.launch.bootstrap.process().raw(),
                    &handoff,
                    self.launch.role_job.job(),
                    &SupervisorExpectation {
                        tier_sid: self.launch.tier_sid,
                        image: self.launch.launcher,
                        object_owner_sid: self.launch.tier_sid,
                    },
                )?);
                self.launch.role_job.note_verified_at_creation(true);
                Ok(())
            }
            HandoffStep::VerifySupervisorDesktop => {
                let (Some(desktop), Some(supervisor)) = (&self.desktop, &self.supervisor) else {
                    return Err(io::Error::other("no desktop and supervisor were adopted"));
                };
                // SAFETY: The duplicated process handle is live and owned by `supervisor`, which
                // outlives this borrow.
                let process = unsafe { BorrowedHandle::borrow_raw(supervisor.process.raw()) };
                let actual = desktop_info(process)?;
                require_desktop(&actual, desktop.path())?;
                self.supervisor_desktop_info = Some(actual);
                Ok(())
            }
            HandoffStep::ReleaseBootstrap => {
                let code = bootstrap.end(BOOTSTRAP_RELEASED_EXIT_CODE, RELEASE_TIMEOUT)?;
                if code != BOOTSTRAP_RELEASED_EXIT_CODE {
                    return Err(io::Error::other(format!(
                        "the tier bootstrap had already ended with {code:#x}{}",
                        bootstrap_step_text(code)
                    )));
                }
                Ok(())
            }
            HandoffStep::SealUiLimits => self.launch.role_job.seal_ui_limits(),
            HandoffStep::ResumeSupervisor => {
                let supervisor = self
                    .supervisor
                    .as_ref()
                    .ok_or_else(|| io::Error::other("no supervisor was adopted"))?;
                // SAFETY: The duplicated thread handle carries THREAD_SUSPEND_RESUME, and the
                // supervisor was created suspended. The owner resumes it once, here; a same-tier
                // process can also resume it (#3713), which the count check refuses.
                match unsafe { ResumeThread(supervisor.thread.raw()) } {
                    u32::MAX => Err(io::Error::last_os_error()),
                    1 => Ok(()),
                    previous => Err(io::Error::other(format!(
                        "the supervisor's primary thread had suspend count {previous} before resume"
                    ))),
                }
            }
        }
    }
}

impl BootstrapHandoff<'_> {
    fn handoff(&self) -> io::Result<Handoff> {
        self.handoff
            .ok_or_else(|| io::Error::other("no handoff was received"))
    }

    /// The handoff frame, from the process this launch created and nobody else. Waiting for the
    /// connection looks at the bootstrap between short waits, so one that exits is reported at once and by
    /// the step its exit code names, rather than as a pipe that never connected.
    fn receive(&mut self) -> io::Result<Handoff> {
        let deadline = Instant::now() + HANDOFF_TIMEOUT;
        loop {
            match self
                .launch
                .pipe
                .await_client(deadline.min(Instant::now() + HANDOFF_POLL))
            {
                Ok(()) => break,
                Err(error) if error.kind() == io::ErrorKind::TimedOut => {
                    if let Some(ended) = self.bootstrap_ended()? {
                        return Err(ended);
                    }
                    if Instant::now() >= deadline {
                        return Err(error);
                    }
                }
                Err(error) => return Err(error),
            }
        }
        let bootstrap = &self.launch.bootstrap;
        self.launch
            .pipe
            .bind(bootstrap.pid(), bootstrap.process(), self.launch.tier_sid)?;
        let body = match self.launch.pipe.receive_handoff(deadline)? {
            Some(body) => body,
            None => {
                return Err(self.bootstrap_ended()?.unwrap_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "the tier bootstrap closed its handoff pipe without a frame",
                    )
                }));
            }
        };
        Ok(tier_handoff::open(
            &body,
            self.launch.tier.as_str(),
            self.launch.key,
        )?)
    }

    /// The refusal for a bootstrap that has already exited, or `None` while it runs.
    fn bootstrap_ended(&mut self) -> io::Result<Option<io::Error>> {
        match self.launch.bootstrap.wait(Duration::ZERO) {
            Ok(code) => Ok(Some(io::Error::other(format!(
                "the tier bootstrap exited with {code:#x} before its handoff{}",
                bootstrap_step_text(code)
            )))),
            Err(error) if error.kind() == io::ErrorKind::TimedOut => Ok(None),
            Err(error) => Err(error),
        }
    }
}

/// `: <what failed>` for a bootstrap exit code that names one of its steps.
fn bootstrap_step_text(code: u32) -> String {
    BootstrapStep::from_exit_code(code)
        .map(|step| format!(": {}", step.describe()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::{DEFERRED_UI_RESTRICTION, JobLimitProfile};
    use crate::launcher::role_job::RoleJob;

    /// Records every step it is asked to perform and fails the one it was told to.
    struct Recorder {
        performed: Vec<HandoffStep>,
        fail_at: Option<HandoffStep>,
        job: RoleJob,
        limits_at: Vec<(HandoffStep, u32)>,
    }

    impl Recorder {
        fn new(fail_at: Option<HandoffStep>) -> Self {
            Self {
                performed: Vec::new(),
                fail_at,
                job: RoleJob::create_deferring_desktop_limit(JobLimitProfile::FixedSleepTest)
                    .expect("job"),
                limits_at: Vec::new(),
            }
        }
    }

    impl HandoffSteps for Recorder {
        fn perform(&mut self, step: HandoffStep) -> io::Result<()> {
            self.performed.push(step);
            self.limits_at
                .push((step, self.job.ui_restrictions().expect("read the Job")));
            if self.fail_at == Some(step) {
                return Err(io::Error::other(format!("injected at {step:?}")));
            }
            if step == HandoffStep::SealUiLimits {
                self.job.seal_ui_limits()?;
            }
            Ok(())
        }
    }

    #[test]
    fn every_step_runs_once_in_the_designed_order() {
        let mut recorder = Recorder::new(None);
        run_handoff(&mut recorder).expect("no step fails");
        assert_eq!(recorder.performed, HandoffStep::SEQUENCE);
        let position = |step| {
            HandoffStep::SEQUENCE
                .iter()
                .position(|candidate| *candidate == step)
                .expect("in the sequence")
        };
        assert!(position(HandoffStep::ProtectBootstrap) < position(HandoffStep::ResumeBootstrap));
        assert!(position(HandoffStep::AssignBootstrap) < position(HandoffStep::ResumeBootstrap));
        assert!(position(HandoffStep::AdoptDesktop) < position(HandoffStep::ReleaseBootstrap));
        assert!(
            position(HandoffStep::AdoptDesktop) < position(HandoffStep::VerifySupervisorDesktop)
        );
        assert!(
            position(HandoffStep::AdoptSupervisor) < position(HandoffStep::VerifySupervisorDesktop)
        );
        // The bootstrap needs the desktop limit absent only until it has sent the handoff, so the seal
        // comes straight after it.
        assert_eq!(
            position(HandoffStep::SealUiLimits),
            position(HandoffStep::ReceiveHandoff) + 1
        );
        // The bootstrap holds a full-access handle to the supervisor until it is gone, so the desktop is
        // read only after it has ended, and nothing comes between the read and the resume.
        assert!(
            position(HandoffStep::ReleaseBootstrap)
                < position(HandoffStep::VerifySupervisorDesktop)
        );
        assert_eq!(
            &HandoffStep::SEQUENCE[position(HandoffStep::VerifySupervisorDesktop)..],
            &[
                HandoffStep::VerifySupervisorDesktop,
                HandoffStep::ResumeSupervisor,
            ]
        );
    }

    /// The Job read back at every step, before the step runs: seven limits, without the desktop one, up to
    /// and including the seal; all eight at every step after it, the bootstrap's release and the
    /// supervisor's resume included.
    #[test]
    fn the_job_holds_seven_ui_limits_until_the_seal_and_eight_from_the_next_step_on() {
        let mut recorder = Recorder::new(None);
        run_handoff(&mut recorder).expect("no step fails");
        let seal = HandoffStep::SEQUENCE
            .iter()
            .position(|step| *step == HandoffStep::SealUiLimits)
            .expect("in the sequence");
        for (index, (step, limits)) in recorder.limits_at.iter().enumerate() {
            if index > seal {
                assert_eq!(limits.count_ones(), 8, "{step:?}");
            } else {
                assert_eq!(limits.count_ones(), 7, "{step:?}");
                assert_eq!(limits & DEFERRED_UI_RESTRICTION, 0, "{step:?}");
            }
        }
        for step in [HandoffStep::ReleaseBootstrap, HandoffStep::ResumeSupervisor] {
            let limits = recorder
                .limits_at
                .iter()
                .find(|(seen, _)| *seen == step)
                .map(|(_, limits)| *limits)
                .expect("the step ran");
            assert_eq!(limits.count_ones(), 8, "{step:?}");
        }
        assert_eq!(
            recorder.job.ui_restrictions().expect("read").count_ones(),
            8
        );
    }

    /// A failure at any step is that step's typed refusal, and nothing after it runs: in particular the
    /// supervisor is never resumed, which is the only way a launch could fall back to anything.
    #[test]
    fn a_failure_at_any_step_is_a_typed_refusal_and_no_later_step_runs() {
        for (index, step) in HandoffStep::SEQUENCE.iter().enumerate() {
            let mut recorder = Recorder::new(Some(*step));
            let failure = run_handoff(&mut recorder).expect_err("the injected step fails");
            assert_eq!(failure.step, *step);
            assert_eq!(recorder.performed, HandoffStep::SEQUENCE[..=index]);
            if *step != HandoffStep::ResumeSupervisor {
                assert!(!recorder.performed.contains(&HandoffStep::ResumeSupervisor));
            }
            let refusal = handoff_refusal(&failure);
            assert_eq!(refusal.reason, TierLaunchRefusalReason::WindowsApiFailure);
            assert!(
                refusal.detail.starts_with(PRIVATE_DESKTOP_FAILURE),
                "{}",
                refusal.detail
            );
            assert!(
                refusal.detail.contains(step.describe()),
                "{}",
                refusal.detail
            );
            assert!(refusal.detail.contains("injected at"), "{}", refusal.detail);
        }
    }

    #[test]
    fn every_step_has_its_own_description() {
        let descriptions: Vec<&str> = HandoffStep::SEQUENCE
            .iter()
            .map(|step| step.describe())
            .collect();
        for (index, description) in descriptions.iter().enumerate() {
            assert!(
                !descriptions[..index].contains(description),
                "{description}"
            );
        }
    }
}
