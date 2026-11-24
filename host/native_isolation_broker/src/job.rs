use crate::process_win32::JOB_EXIT_CODE;
use std::ffi::c_void;
use std::io;
use std::ptr::null;
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOB_OBJECT_UILIMIT_DESKTOP,
    JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS,
    JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES, JOB_OBJECT_UILIMIT_READCLIPBOARD,
    JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS, JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_UI_RESTRICTIONS,
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList, JobObjectBasicUIRestrictions,
    JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::WaitForSingleObject;

/// How often the drain check re-reads the Job's accounting state. Short enough that an orderly
/// stop stays sub-100ms in practice, long enough not to spin a core while the kernel tears the
/// tree down.
const DRAIN_POLL_INTERVAL: Duration = Duration::from_millis(10);
const JOB_LIMIT_FLAGS: u32 = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
    | JOB_OBJECT_LIMIT_PROCESS_MEMORY
    | JOB_OBJECT_LIMIT_JOB_MEMORY;
const ALL_UI_RESTRICTIONS: u32 = JOB_OBJECT_UILIMIT_HANDLES
    | JOB_OBJECT_UILIMIT_READCLIPBOARD
    | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
    | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
    | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
    | JOB_OBJECT_UILIMIT_GLOBALATOMS
    | JOB_OBJECT_UILIMIT_DESKTOP
    | JOB_OBJECT_UILIMIT_EXITWINDOWS;

/// The one UI limit a tier launch's Job starts without (#3499). `JOB_OBJECT_UILIMIT_DESKTOP` refuses
/// `CreateDesktopW`, and the tier bootstrap creates the launch's private desktop from inside the Job, so
/// the owner applies it as soon as the bootstrap's handoff arrives, which the bootstrap sends after that
/// call. On the owner-controlled path no supervisor or role code runs under fewer than all eight; until
/// the seal (#3713), a process that gets into the bootstrap, or of the same tier that resumes the
/// suspended supervisor early, can make code run under seven.
pub const DEFERRED_UI_RESTRICTION: u32 = JOB_OBJECT_UILIMIT_DESKTOP;

/// Processes every tier Job holds besides the role's own tree. On the production path these are the tier
/// bootstrap and the supervisor it starts, which overlap only until the owner ends the bootstrap (#3499);
/// neither has a console. On the loopback path only the runner is one of them: it is created
/// `DETACHED_PROCESS`, so it has no console host. Added to each profile so the role keeps the whole
/// budget it had when the runner sat outside the Job.
const RUNNER_PROCESSES: u32 = 2;

/// Ids one process-list query can return. Above every profile's active-process limit, so a full list is
/// always the whole list.
const PROCESS_ID_LIST_CAPACITY: usize = 64;

/// `JOBOBJECT_BASIC_PROCESS_ID_LIST` with room for `PROCESS_ID_LIST_CAPACITY` ids; the system header
/// declares a one-element array and expects the caller to supply the rest.
#[repr(C)]
struct ProcessIdList {
    assigned: u32,
    listed: u32,
    ids: [usize; PROCESS_ID_LIST_CAPACITY],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobLimitProfile {
    FixedSleepTest,
    BootstrapTier,
    FileToolTier,
    ConnectorTier,
    ChannelTier,
}

impl JobLimitProfile {
    pub const fn for_tier(tier: crate::tier::IsolationTier) -> Self {
        match tier {
            crate::tier::IsolationTier::Bootstrap => Self::BootstrapTier,
            crate::tier::IsolationTier::FileTool => Self::FileToolTier,
            crate::tier::IsolationTier::NetworkConnector => Self::ConnectorTier,
            crate::tier::IsolationTier::Channel => Self::ChannelTier,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct JobLimits {
    active_processes: u32,
    process_memory_bytes: usize,
    job_memory_bytes: usize,
    cpu_rate: u32,
    ui_restrictions: u32,
}

impl JobLimitProfile {
    const fn limits(self) -> JobLimits {
        match self {
            Self::FixedSleepTest => JobLimits {
                active_processes: 4 + RUNNER_PROCESSES,
                process_memory_bytes: 256 * 1024 * 1024,
                job_memory_bytes: 512 * 1024 * 1024,
                cpu_rate: 2_000,
                ui_restrictions: ALL_UI_RESTRICTIONS,
            },
            Self::BootstrapTier => JobLimits {
                active_processes: 8 + RUNNER_PROCESSES,
                // Supervisor publication hit a Bun trap near the old 512 MiB
                // commit cap. Keep a bounded 2 GiB budget for the requested
                // retry; startup evidence must establish whether this fixes it.
                process_memory_bytes: 2048 * 1024 * 1024,
                job_memory_bytes: 2048 * 1024 * 1024,
                cpu_rate: 4_000,
                ui_restrictions: ALL_UI_RESTRICTIONS,
            },
            Self::FileToolTier => JobLimits {
                // MCP stdio servers are opencode children in this Job. On Windows an npx server
                // is five processes (cmd, conhost, npx node, cmd, server node), and so is a uvx
                // server (uvx, uv, the tool's launcher exe, two python); 16 was full with
                // OpenCode and three servers.
                active_processes: 48 + RUNNER_PROCESSES,
                // OpenCode 1.18.25/Bun 1.3.14 commits slightly over 1 GiB while
                // loading the shipped ACL-v6 generation. A 1 GiB process cap
                // reproducibly ended in Bun's illegal-instruction panic before
                // any user prompt; 2 GiB completed initialization, two primary
                // prompts and a Web-search tool call. A cold npx install can
                // exhaust a shared 2 GiB Job while OpenCode is resident. Both
                // caps are 8 GiB so a single process may use the whole Job.
                process_memory_bytes: 8192 * 1024 * 1024,
                job_memory_bytes: 8192 * 1024 * 1024,
                cpu_rate: 8_000,
                ui_restrictions: ALL_UI_RESTRICTIONS,
            },
            Self::ConnectorTier => JobLimits {
                active_processes: 8 + RUNNER_PROCESSES,
                process_memory_bytes: 512 * 1024 * 1024,
                job_memory_bytes: 1024 * 1024 * 1024,
                cpu_rate: 4_000,
                ui_restrictions: ALL_UI_RESTRICTIONS,
            },
            Self::ChannelTier => JobLimits {
                active_processes: 8,
                // Sized for opencode-router, one Bun process, before EG2-6 moves it here: the 2 GiB it
                // has under the file-tool profile today, since the supervisor's Bun trapped near a
                // 512 MiB cap. To be re-measured once the router runs in this tier.
                process_memory_bytes: 2048 * 1024 * 1024,
                job_memory_bytes: 2048 * 1024 * 1024,
                cpu_rate: 4_000,
                ui_restrictions: ALL_UI_RESTRICTIONS,
            },
        }
    }
}

pub struct Job {
    handle: HANDLE,
}

impl Job {
    pub fn create(profile: JobLimitProfile) -> io::Result<Self> {
        // SAFETY: Null security attributes create a non-inheritable unnamed Job handle.
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let job = Self { handle };
        job.apply(profile.limits())?;
        Ok(job)
    }

    /// `create` without `DEFERRED_UI_RESTRICTION`, which `apply_all_ui_restrictions` adds later.
    pub fn create_deferring_desktop_limit(profile: JobLimitProfile) -> io::Result<Self> {
        // SAFETY: Null security attributes create a non-inheritable unnamed Job handle.
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let job = Self { handle };
        let mut limits = profile.limits();
        limits.ui_restrictions &= !DEFERRED_UI_RESTRICTION;
        job.apply(limits)?;
        job.require_ui_restrictions(limits.ui_restrictions)?;
        Ok(job)
    }

    /// The UI restrictions the kernel holds for this Job, read back rather than remembered.
    pub fn ui_restrictions(&self) -> io::Result<u32> {
        let mut restrictions = JOBOBJECT_BASIC_UI_RESTRICTIONS::default();
        // SAFETY: The class matches the structure and its exact size; the output is writable.
        if unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicUIRestrictions,
                (&raw mut restrictions).cast(),
                size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(restrictions.UIRestrictionsClass)
    }

    /// Applies every UI restriction `profile` carries and requires the Job to read back exactly that.
    pub fn apply_all_ui_restrictions(&self, profile: JobLimitProfile) -> io::Result<()> {
        let restrictions = profile.limits().ui_restrictions;
        set_ui_restrictions(self.handle, restrictions)?;
        self.require_ui_restrictions(restrictions)
    }

    fn require_ui_restrictions(&self, expected: u32) -> io::Result<()> {
        let actual = self.ui_restrictions()?;
        if actual != expected {
            return Err(io::Error::other(format!(
                "the Job holds UI restrictions {actual:#x}, not {expected:#x}"
            )));
        }
        Ok(())
    }

    /// The Job handle itself, for `PROC_THREAD_ATTRIBUTE_JOB_LIST`. The handle stays owned by this
    /// object; a caller must not close it or hand it to an inheriting child.
    pub const fn raw(&self) -> HANDLE {
        self.handle
    }

    /// Number of processes currently accounted to this Job. This is kernel state, not a report
    /// from anything inside the Job, so it is usable as cleanup evidence.
    pub fn active_processes(&self) -> io::Result<u32> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let mut returned = 0;
        // SAFETY: The class matches the structure and its exact size; both out-pointers are live.
        if unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                (&raw mut accounting).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                &mut returned,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(accounting.ActiveProcesses)
    }

    /// Whether `pid` is one of this Job's processes, from the Job's own process list. Lets the holder
    /// of the Job confirm membership of a process it holds no handle to.
    pub fn lists_process(&self, pid: u32) -> io::Result<bool> {
        let mut list = ProcessIdList {
            assigned: 0,
            listed: 0,
            ids: [0; PROCESS_ID_LIST_CAPACITY],
        };
        // SAFETY: The class matches the structure, whose size is passed exactly; it is writable.
        if unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicProcessIdList,
                (&raw mut list).cast(),
                size_of::<ProcessIdList>() as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let listed = (list.listed as usize).min(PROCESS_ID_LIST_CAPACITY);
        Ok(list.ids[..listed].contains(&(pid as usize)))
    }

    /// Terminates the Job and confirms from the Job's own accounting state that no process is left,
    /// rather than only waiting on the root process handle. A descendant that outlives its parent
    /// would keep the count above zero, so a timeout here is a cleanup error, not a success.
    pub fn terminate_and_confirm_drained(&self, timeout: Duration) -> io::Result<u32> {
        // SAFETY: This object owns the valid Job handle.
        if unsafe { TerminateJobObject(self.handle, JOB_EXIT_CODE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let deadline = Instant::now() + timeout;
        loop {
            let active = self.active_processes()?;
            if active == 0 {
                return Ok(active);
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("Job still accounts for {active} process(es) after termination"),
                ));
            }
            thread::sleep(DRAIN_POLL_INTERVAL);
        }
    }

    /// Confirms the process is already a member, for the path that installs
    /// `PROC_THREAD_ATTRIBUTE_JOB_LIST` at creation. Membership from the first instruction is
    /// stronger than assigning afterwards, but only if it is actually checked before resume: a
    /// silent failure would otherwise leave an unconstrained process running.
    pub fn verify_membership(&self, process: HANDLE) -> io::Result<()> {
        let mut is_member = 0;
        // SAFETY: Both handles are valid and result points to writable storage.
        if unsafe { IsProcessInJob(process, self.handle, &mut is_member) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if is_member == 0 {
            return Err(io::Error::other(
                "process created with a Job list is not a member of that Job",
            ));
        }
        Ok(())
    }

    pub fn assign_and_verify(&self, process: HANDLE) -> io::Result<()> {
        // SAFETY: Both handles are valid and the process is still suspended.
        if unsafe { AssignProcessToJobObject(self.handle, process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut is_member = 0;
        // SAFETY: Both handles are valid and result points to writable storage.
        if unsafe { IsProcessInJob(process, self.handle, &mut is_member) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if is_member == 0 {
            return Err(io::Error::other(
                "pre-resume Job membership verification failed",
            ));
        }
        Ok(())
    }

    pub fn terminate_and_confirm(&self, process: HANDLE, timeout: Duration) -> io::Result<()> {
        // SAFETY: This object owns the valid Job handle.
        if unsafe { TerminateJobObject(self.handle, JOB_EXIT_CODE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: The retained process handle is valid for synchronization.
        match unsafe {
            WaitForSingleObject(process, timeout.as_millis().min(u32::MAX as u128) as u32)
        } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Job child did not exit after termination",
            )),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            result => Err(io::Error::other(format!(
                "unexpected Job child wait result: {result}"
            ))),
        }
    }

    fn apply(&self, profile: JobLimits) -> io::Result<()> {
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_LIMIT_FLAGS;
        limits.BasicLimitInformation.ActiveProcessLimit = profile.active_processes;
        limits.ProcessMemoryLimit = profile.process_memory_bytes;
        limits.JobMemoryLimit = profile.job_memory_bytes;
        set_job_information(
            self.handle,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>(),
        )?;

        let mut cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
            ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
            ..Default::default()
        };
        cpu.Anonymous.CpuRate = profile.cpu_rate;
        set_job_information(
            self.handle,
            JobObjectCpuRateControlInformation,
            &cpu as *const _ as *const c_void,
            size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>(),
        )?;

        set_ui_restrictions(self.handle, profile.ui_restrictions)
    }
}

fn set_ui_restrictions(job: HANDLE, restrictions: u32) -> io::Result<()> {
    let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
        UIRestrictionsClass: restrictions,
    };
    set_job_information(
        job,
        JobObjectBasicUIRestrictions,
        &ui as *const _ as *const c_void,
        size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>(),
    )
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: Job is the sole owner of this valid handle.
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

fn set_job_information(
    job: HANDLE,
    class: i32,
    value: *const c_void,
    size: usize,
) -> io::Result<()> {
    // SAFETY: The class matches the pointed-to structure and its exact size.
    if unsafe { SetInformationJobObject(job, class, value, size as u32) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::JobObjects::{
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };

    #[test]
    fn fixed_sleep_test_profile_keeps_measured_limits() {
        let limits = JobLimitProfile::FixedSleepTest.limits();
        assert_eq!(limits.active_processes, 4 + RUNNER_PROCESSES);
        assert_eq!(limits.process_memory_bytes, 256 * 1024 * 1024);
        assert_eq!(limits.job_memory_bytes, 512 * 1024 * 1024);
        assert_eq!(limits.cpu_rate, 2_000);
        assert_eq!(limits.ui_restrictions, ALL_UI_RESTRICTIONS);
    }

    #[test]
    fn file_tool_eight_gib_budget_reaches_kernel() {
        let limits = JobLimitProfile::FileToolTier.limits();
        assert_eq!(limits.active_processes, 48 + RUNNER_PROCESSES);
        assert_eq!(limits.process_memory_bytes, 8192 * 1024 * 1024);
        assert_eq!(limits.job_memory_bytes, 8192 * 1024 * 1024);
        let job = Job::create(JobLimitProfile::FileToolTier).expect("create file-tool Job");
        let mut actual = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // SAFETY: live Job handle and output buffer matching the information class.
        assert_ne!(
            unsafe {
                QueryInformationJobObject(
                    job.raw(),
                    JobObjectExtendedLimitInformation,
                    (&raw mut actual).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        assert_eq!(actual.ProcessMemoryLimit, limits.process_memory_bytes);
        assert_eq!(actual.JobMemoryLimit, limits.job_memory_bytes);
        assert_eq!(
            actual.BasicLimitInformation.ActiveProcessLimit,
            limits.active_processes
        );
        assert_eq!(actual.BasicLimitInformation.LimitFlags, JOB_LIMIT_FLAGS);
    }

    /// The channel tier will run opencode-router, a Bun process that today runs under the file-tool
    /// profile's 2 GiB, and the supervisor's Bun trapped near a 512 MiB cap. So the channel profile is
    /// its own, bootstrap-shaped: one Bun process's 2 GiB, a small process count and a 40% CPU cap.
    #[test]
    fn the_channel_tier_has_its_own_profile_sized_for_one_bun_process() {
        assert_eq!(
            JobLimitProfile::for_tier(crate::tier::IsolationTier::Channel),
            JobLimitProfile::ChannelTier
        );
        let limits = JobLimitProfile::ChannelTier.limits();
        assert_eq!(limits.active_processes, 8);
        assert_eq!(limits.process_memory_bytes, 2048 * 1024 * 1024);
        assert_eq!(limits.job_memory_bytes, 2048 * 1024 * 1024);
        assert_eq!(limits.cpu_rate, 4_000);
        assert_eq!(limits.ui_restrictions, ALL_UI_RESTRICTIONS);
    }

    #[test]
    fn ui_profile_retains_all_eight_restrictions() {
        assert_eq!(ALL_UI_RESTRICTIONS.count_ones(), 8);
    }

    /// Read back from the kernel, not from the profile: a full Job holds eight, a deferring one seven and
    /// not the desktop limit, and applying the rest leaves eight.
    #[test]
    fn a_deferring_job_holds_seven_ui_limits_until_the_eighth_is_applied() {
        let full = Job::create(JobLimitProfile::FileToolTier).expect("create");
        assert_eq!(full.ui_restrictions().expect("read"), ALL_UI_RESTRICTIONS);

        let job = Job::create_deferring_desktop_limit(JobLimitProfile::FileToolTier)
            .expect("create deferring");
        let held = job.ui_restrictions().expect("read");
        assert_eq!(held, ALL_UI_RESTRICTIONS & !DEFERRED_UI_RESTRICTION);
        assert_eq!(held.count_ones(), 7);
        assert_eq!(DEFERRED_UI_RESTRICTION, JOB_OBJECT_UILIMIT_DESKTOP);

        job.apply_all_ui_restrictions(JobLimitProfile::FileToolTier)
            .expect("apply the eighth");
        assert_eq!(job.ui_restrictions().expect("read"), ALL_UI_RESTRICTIONS);
        job.apply_all_ui_restrictions(JobLimitProfile::FileToolTier)
            .expect("applying again is the same state");
        assert_eq!(job.ui_restrictions().expect("read"), ALL_UI_RESTRICTIONS);
    }

    /// Deferring one UI limit defers nothing else: the memory, process and CPU limits are the profile's.
    #[test]
    fn a_deferring_job_keeps_every_other_limit() {
        let job = Job::create_deferring_desktop_limit(JobLimitProfile::BootstrapTier)
            .expect("create deferring");
        let mut actual = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // SAFETY: live Job handle and output buffer matching the information class.
        assert_ne!(
            unsafe {
                QueryInformationJobObject(
                    job.raw(),
                    JobObjectExtendedLimitInformation,
                    (&raw mut actual).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let limits = JobLimitProfile::BootstrapTier.limits();
        assert_eq!(actual.BasicLimitInformation.LimitFlags, JOB_LIMIT_FLAGS);
        assert_eq!(
            actual.BasicLimitInformation.ActiveProcessLimit,
            limits.active_processes
        );
        assert_eq!(actual.ProcessMemoryLimit, limits.process_memory_bytes);
    }

    #[test]
    fn bootstrap_two_gib_budget_preserves_other_limits_and_reaches_kernel() {
        let limits = JobLimitProfile::BootstrapTier.limits();
        assert_eq!(limits.process_memory_bytes, 2048 * 1024 * 1024);
        assert_eq!(limits.job_memory_bytes, 2048 * 1024 * 1024);
        assert_eq!(limits.active_processes, 8 + RUNNER_PROCESSES);
        assert_eq!(limits.cpu_rate, 4_000);
        assert_eq!(limits.ui_restrictions, ALL_UI_RESTRICTIONS);
        let job = Job::create(JobLimitProfile::BootstrapTier).expect("create bootstrap Job");
        let mut actual = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // SAFETY: live Job handle and output buffer matching the information class.
        assert_ne!(
            unsafe {
                QueryInformationJobObject(
                    job.raw(),
                    JobObjectExtendedLimitInformation,
                    (&raw mut actual).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        assert_eq!(actual.ProcessMemoryLimit, limits.process_memory_bytes);
        assert_eq!(actual.JobMemoryLimit, limits.job_memory_bytes);
        assert_eq!(
            actual.BasicLimitInformation.ActiveProcessLimit,
            8 + RUNNER_PROCESSES
        );
        assert_eq!(actual.BasicLimitInformation.LimitFlags, JOB_LIMIT_FLAGS);
    }

    /// The bootstrap and the supervisor ride on top of every role budget, and the process list can
    /// always hold a whole Job.
    #[test]
    fn every_profile_carries_the_runner_and_fits_one_process_list() {
        assert_eq!(RUNNER_PROCESSES, 2);
        for profile in [
            JobLimitProfile::FixedSleepTest,
            JobLimitProfile::BootstrapTier,
            JobLimitProfile::FileToolTier,
            JobLimitProfile::ConnectorTier,
        ] {
            let limit = profile.limits().active_processes;
            assert!(limit > RUNNER_PROCESSES, "{profile:?}");
            assert!(limit as usize <= PROCESS_ID_LIST_CAPACITY, "{profile:?}");
        }
        let job = Job::create(JobLimitProfile::FixedSleepTest).expect("Job should be creatable");
        assert!(
            !job.lists_process(std::process::id())
                .expect("an empty Job's list should be readable"),
            "an empty Job lists no process"
        );
    }

    #[test]
    fn empty_job_reports_zero_active_processes_and_drains() {
        let job = Job::create(JobLimitProfile::FixedSleepTest).expect("Job should be creatable");
        assert_eq!(
            job.active_processes()
                .expect("accounting should be readable"),
            0
        );
        assert_eq!(
            job.terminate_and_confirm_drained(Duration::from_secs(5))
                .expect("an empty Job should drain immediately"),
            0
        );
    }

    #[test]
    fn job_profile_forbids_breakaway() {
        assert_eq!(
            JOB_LIMIT_FLAGS
                & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK),
            0
        );
    }
}
