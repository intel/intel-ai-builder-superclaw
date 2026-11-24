//! The role's Job, created and held by the owner-side launcher (#3010).
//!
//! # Why the owner holds it
//!
//! A Job handle in the tier account is a Job handle any process in that account can take: a role shares
//! the runner's account, so it can open the runner and duplicate whatever the runner holds. A role that
//! held its own Job's handle could keep the tree alive past a stop by keeping the last handle open, or
//! loosen the limits a stop and a cleanup count depend on. So the Job is created here, in the owner's
//! account, unnamed and non-inheritable, and no handle to it ever crosses the hop. The owner process
//! is not openable by the tier account, so there is nothing to duplicate it from either.
//!
//! # The order, and what each step proves
//!
//! 1. The Job is created before the runner, so a Job that cannot be created costs no tier process.
//! 2. The runner is created suspended. In production the first hop starts the tier bootstrap, which the
//!    owner assigns with `AssignProcessToJobObject` through the creation handle `CreateProcessWithLogonW`
//!    returns; the supervisor the bootstrap starts - the production runner - inherits the Job, and the
//!    owner reads its membership back through the handle it duplicated before resuming it (#3499). The
//!    loopback mode names the Job in the runner's creation itself. Either way membership is read back
//!    before the owner resumes the runner.
//!
//!    The production Job is created with seven of its eight UI limits, because
//!    `JOB_OBJECT_UILIMIT_DESKTOP` refuses the bootstrap's `CreateDesktopW`. The owner applies the eighth
//!    and reads all eight back as soon as the bootstrap's handoff arrives, so from then on all eight
//!    apply to every process in the Job, the still-running bootstrap included, and on the
//!    owner-controlled path before any supervisor or role instruction runs. Until then (#3713), a process
//!    that gets into the bootstrap, or a process of the same tier that resumes the suspended supervisor
//!    early, can make code run under seven; the owner refuses an early resume but cannot undo what ran.
//! 3. The runner starts the role, which inherits the Job; the Job forbids breakaway, so it cannot leave.
//! 4. The role the runner reports must be in this Job's own process list and must not be the runner.
//!    That is the owner's check of a tier claim, made without any handle to the role.
//! 5. Stop is `TerminateJobObject` here, then the Job's own count reaching zero. Nothing in it waits on
//!    the runner, so a runner that is suspended, hung or lying cannot delay or fake a stop.
//!
//! If the owner dies, the Job's last handle closes with it and kill-on-close ends the tree. The one gap
//! is a crash between creation and assignment, when the suspended runner is in no Job of the owner's;
//! `LogonChild` terminates it on drop for the failures this process survives, and a suspended runner
//! whose owner did not survive can only find its pipes gone if something resumes it.

use super::logon::LogonChild;
use super::wire::{OWNER_KERNEL, OwnerJobEvidence, TierFrame};
use crate::job::{Job, JobLimitProfile};
use crate::process_win32::JOB_EXIT_CODE;
use std::io;
use std::thread;
use std::time::{Duration, Instant};

/// How long the role's process tree is given to stop changing size before the role is reported
/// started. A role that spawns helpers does so immediately; this is not a startup budget.
const SETTLE_TIMEOUT: Duration = Duration::from_secs(5);
const SETTLE_SAMPLE_INTERVAL: Duration = Duration::from_millis(50);
/// Consecutive equal samples required to call the tree settled, and the shortest wall-clock window
/// those samples may span.
///
/// Stability on its own is a timing assumption: three 50ms samples give a role only 150ms to get its
/// first child started, and on a loaded machine the count can settle at the wrong value before that
/// child appears. Requiring a minimum observation window as well widens that margin substantially and
/// still needs to know nothing at all about the role. It stays a heuristic either way; the claim with
/// kernel backing is Job membership, not this count.
const SETTLE_STABLE_SAMPLES: u32 = 3;
const SETTLE_MINIMUM_OBSERVATION: Duration = Duration::from_millis(400);
/// The fewest processes a started launch can have in its Job: the runner and the role.
const MINIMUM_STARTED_PROCESSES: u32 = 2;
/// How long the Job is given to drain after termination before cleanup is reported as failed.
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) struct RoleJob {
    job: Job,
    profile: JobLimitProfile,
    runner_verified_before_resume: bool,
    role_verified: bool,
    active_at_ready: u32,
}

impl RoleJob {
    pub(super) fn create(profile: JobLimitProfile) -> io::Result<Self> {
        Ok(Self {
            job: Job::create(profile)?,
            profile,
            runner_verified_before_resume: false,
            role_verified: false,
            active_at_ready: 0,
        })
    }

    /// The production launch's Job: every limit but `job::DEFERRED_UI_RESTRICTION`, which `seal_ui_limits`
    /// adds once the bootstrap that creates the private desktop has gone (#3499).
    pub(super) fn create_deferring_desktop_limit(profile: JobLimitProfile) -> io::Result<Self> {
        Ok(Self {
            job: Job::create_deferring_desktop_limit(profile)?,
            profile,
            runner_verified_before_resume: false,
            role_verified: false,
            active_at_ready: 0,
        })
    }

    /// Applies the profile's whole UI restriction set and requires it to read back, before the supervisor
    /// is resumed.
    pub(super) fn seal_ui_limits(&self) -> io::Result<()> {
        self.job.apply_all_ui_restrictions(self.profile)
    }

    /// The UI restrictions the Job holds now, read from the kernel.
    pub(super) fn ui_restrictions(&self) -> io::Result<u32> {
        self.job.ui_restrictions()
    }

    /// Assigns the suspended tier bootstrap to this Job and reads membership back. It is resumed by the
    /// owner's handoff sequence, not here.
    pub(super) fn adopt_bootstrap(&self, bootstrap: &LogonChild) -> io::Result<()> {
        self.job.assign_and_verify(bootstrap.process().raw())
    }

    /// The Job, for the loopback mode to name in its runner's creation and for the owner to check the
    /// supervisor's membership against.
    pub(super) const fn job(&self) -> &Job {
        &self.job
    }

    /// Records the pre-resume membership check of the runner: the loopback creation's own, which named
    /// this Job, or the owner's of the suspended supervisor.
    pub(super) fn note_verified_at_creation(&mut self, verified: bool) {
        self.runner_verified_before_resume = verified;
    }

    /// Confirms the role the runner reported is a member of this Job, then waits for the tree to settle.
    pub(super) fn verify_started(&mut self, runner_pid: u32, role_pid: u32) -> io::Result<()> {
        if role_pid == runner_pid || !self.job.lists_process(role_pid)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("the reported role process {role_pid} is not a role in the owner's Job"),
            ));
        }
        self.role_verified = true;
        self.active_at_ready = self.settle()?;
        Ok(())
    }

    /// Terminates the Job and confirms from its own accounting that nothing is left. `requested_at` is
    /// when the stop instruction arrived, so the elapsed time covers this process noticing it too.
    pub(super) fn terminate(&self, requested_at: Instant) -> io::Result<OwnerJobEvidence> {
        let before = self.job.active_processes()?;
        let after = self.job.terminate_and_confirm_drained(CLEANUP_TIMEOUT)?;
        Ok(OwnerJobEvidence {
            source: OWNER_KERNEL.to_owned(),
            runner_membership_verified_before_resume: self.runner_verified_before_resume,
            role_membership_verified: self.role_verified,
            active_processes_at_ready: self.active_at_ready,
            active_processes_before_cleanup: before,
            active_processes_after_cleanup: after,
            cleanup_confirmed: after == 0,
            cleanup_elapsed_ms: requested_at.elapsed().as_millis() as u64,
        })
    }

    /// Polls the Job's accounting until the process count stops changing, and returns it.
    ///
    /// The count includes the runner - the supervisor in production. Falling below two means the runner
    /// or the role left during startup, which is a launch failure rather than a settled tree.
    fn settle(&self) -> io::Result<u32> {
        let started = Instant::now();
        let deadline = started + SETTLE_TIMEOUT;
        let mut last = self.job.active_processes()?;
        let mut stable = 1;
        loop {
            if last < MINIMUM_STARTED_PROCESSES {
                return Err(io::Error::other(
                    "the runner or the role left the Job before the process tree settled",
                ));
            }
            if stable >= SETTLE_STABLE_SAMPLES && started.elapsed() >= SETTLE_MINIMUM_OBSERVATION {
                return Ok(last);
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("the role's process tree was still changing size at {last} processes"),
                ));
            }
            thread::sleep(SETTLE_SAMPLE_INTERVAL);
            let current = self.job.active_processes()?;
            stable = if current == last { stable + 1 } else { 1 };
            last = current;
        }
    }
}

/// Refuses to report success unless the owner verified the start and confirmed the cleanup itself, and
/// the runner ended by the Job's termination rather than on its own. A launcher that printed a report
/// for an unconfirmed teardown would be worse than one that failed loudly.
pub(super) fn verify_runner_outcome(
    exit_code: u32,
    frames: &[TierFrame],
    owner_job: &OwnerJobEvidence,
) -> io::Result<()> {
    if exit_code != JOB_EXIT_CODE {
        return Err(io::Error::other(format!(
            "tier runner exited with code {exit_code}, not by the Job's termination"
        )));
    }
    let verified = owner_job.runner_membership_verified_before_resume
        && owner_job.role_membership_verified
        && owner_job.active_processes_after_cleanup == 0
        && owner_job.cleanup_confirmed;
    match frames {
        [TierFrame::Started { .. }] if verified => Ok(()),
        _ => Err(io::Error::other(format!(
            "the launch is not one verified start followed by a confirmed cleanup: {frames:?} \
             {owner_job:?}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn started() -> TierFrame {
        TierFrame::Started {
            tier: "bootstrap".to_owned(),
            launch_role: "test_fixed_sleep_child".to_owned(),
            role_pid: 4242,
            role_environment_names: vec!["SYSTEMROOT".to_owned()],
        }
    }

    fn evidence() -> OwnerJobEvidence {
        OwnerJobEvidence {
            source: OWNER_KERNEL.to_owned(),
            runner_membership_verified_before_resume: true,
            role_membership_verified: true,
            active_processes_at_ready: 3,
            active_processes_before_cleanup: 3,
            active_processes_after_cleanup: 0,
            cleanup_confirmed: true,
            cleanup_elapsed_ms: 5,
        }
    }

    #[test]
    fn a_verified_start_and_owner_confirmed_cleanup_is_the_only_success() {
        assert!(verify_runner_outcome(JOB_EXIT_CODE, &[started()], &evidence()).is_ok());
        let unverified_runner = OwnerJobEvidence {
            runner_membership_verified_before_resume: false,
            ..evidence()
        };
        let unverified_role = OwnerJobEvidence {
            role_membership_verified: false,
            ..evidence()
        };
        let survivor = OwnerJobEvidence {
            active_processes_after_cleanup: 1,
            ..evidence()
        };
        let unconfirmed = OwnerJobEvidence {
            cleanup_confirmed: false,
            ..evidence()
        };
        for (exit_code, frames, owner_job) in [
            (0, vec![started()], evidence()),
            (1, vec![started()], evidence()),
            (JOB_EXIT_CODE, vec![], evidence()),
            (JOB_EXIT_CODE, vec![started(), started()], evidence()),
            (JOB_EXIT_CODE, vec![started()], unverified_runner),
            (JOB_EXIT_CODE, vec![started()], unverified_role),
            (JOB_EXIT_CODE, vec![started()], survivor),
            (JOB_EXIT_CODE, vec![started()], unconfirmed),
        ] {
            assert!(
                verify_runner_outcome(exit_code, &frames, &owner_job).is_err(),
                "accepted exit {exit_code} with {frames:?} and {owner_job:?}"
            );
        }
    }

    #[test]
    fn a_role_the_job_does_not_list_is_refused_before_any_settling() {
        let mut role_job = RoleJob::create(JobLimitProfile::FixedSleepTest).expect("create");
        let me = std::process::id();
        for (runner_pid, role_pid) in [(me, me), (1, me)] {
            assert_eq!(
                role_job
                    .verify_started(runner_pid, role_pid)
                    .expect_err("an empty Job lists no role")
                    .kind(),
                io::ErrorKind::PermissionDenied
            );
        }
        assert!(!role_job.role_verified);
    }

    #[test]
    fn the_production_job_holds_seven_ui_limits_until_it_is_sealed() {
        let role_job = RoleJob::create_deferring_desktop_limit(JobLimitProfile::ConnectorTier)
            .expect("create");
        let before = role_job.ui_restrictions().expect("read");
        assert_eq!(before.count_ones(), 7);
        assert_eq!(before & crate::job::DEFERRED_UI_RESTRICTION, 0);
        role_job.seal_ui_limits().expect("seal");
        let after = role_job.ui_restrictions().expect("read");
        assert_eq!(after.count_ones(), 8);
        assert_eq!(after, before | crate::job::DEFERRED_UI_RESTRICTION);
    }

    #[test]
    fn the_loopback_job_holds_all_eight_from_creation() {
        let role_job = RoleJob::create(JobLimitProfile::FixedSleepTest).expect("create");
        assert_eq!(role_job.ui_restrictions().expect("read").count_ones(), 8);
    }

    #[test]
    fn an_empty_job_terminates_to_unconfirmed_start_evidence() {
        let role_job = RoleJob::create(JobLimitProfile::FixedSleepTest).expect("create");
        let evidence = role_job.terminate(Instant::now()).expect("terminate");
        assert_eq!(evidence.source, OWNER_KERNEL);
        assert_eq!(evidence.active_processes_after_cleanup, 0);
        assert!(evidence.cleanup_confirmed);
        assert!(
            !evidence.runner_membership_verified_before_resume
                && !evidence.role_membership_verified,
            "a Job that never admitted anything must not claim it did"
        );
    }
}
