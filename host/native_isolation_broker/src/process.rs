//! The elevated broker's own Job launch, used only by `--self-test`.
//!
//! It starts the broker's fixed `--test-child` in a `FixedSleepTest` Job as the broker's own account,
//! so the test boundary can prove suspended creation, Job assignment before resume and confirmed
//! termination. It takes no token and launches no role: every tier launch goes through
//! `process_same_account.rs` inside the tier runner, which is where new launch work belongs.

use crate::job::{Job, JobLimitProfile};
use crate::process_win32::{
    OwnedHandle, ProcThreadAttributes, StdioPipes, SuspendedProcess, wide_null,
};
use std::io;
use std::mem::size_of;
use std::path::Path;
use std::ptr::null;
use std::time::Duration;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, EXTENDED_STARTUPINFO_PRESENT,
    PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

pub struct JobChild {
    job: Job,
    process: OwnedHandle,
    _stdio: StdioPipes,
    pub pid: u32,
    terminated: bool,
}

impl JobChild {
    pub fn launch_fixed(executable: &Path) -> io::Result<Self> {
        let command = format!("\"{}\" --test-child --sleep-ms 60000", executable.display());
        Self::launch(executable, &command, JobLimitProfile::FixedSleepTest)
    }

    fn launch(
        executable: &Path,
        fixed_command: &str,
        job_profile: JobLimitProfile,
    ) -> io::Result<Self> {
        let job = Job::create(job_profile)?;
        let mut stdio = StdioPipes::create()?;
        let child_handles = stdio.child_handles();
        let mut handle_list = ProcThreadAttributes::new(child_handles.to_vec(), Vec::new())?;

        let application = wide_null(
            executable
                .to_str()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "non-Unicode exe"))?,
        );
        let mut command = wide_null(fixed_command);
        let current_directory = executable.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "executable has no parent directory",
            )
        })?;
        let current_directory = wide_null(current_directory.to_str().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "non-Unicode working directory")
        })?);
        let mut desktop = wide_null(r"winsta0\default");
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = child_handles[0];
        startup.StartupInfo.hStdOutput = child_handles[1];
        startup.StartupInfo.hStdError = child_handles[2];
        startup.StartupInfo.lpDesktop = desktop.as_mut_ptr();
        startup.lpAttributeList = handle_list.as_mut_ptr();
        let mut process_info = PROCESS_INFORMATION::default();

        // SAFETY: The executable and fixed command are NUL-terminated; the explicit handle list
        // limits inheritance to the three stdio handles, lpDesktop is explicit, and the child
        // starts suspended.
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                null(),
                current_directory.as_ptr(),
                &startup.StartupInfo,
                &mut process_info,
            )
        };
        stdio.close_child_ends();
        drop(handle_list);
        if created == 0 {
            return Err(io::Error::last_os_error());
        }

        let process = OwnedHandle::new(process_info.hProcess)?;
        let mut suspended = SuspendedProcess::arm(process.raw());
        let thread = OwnedHandle::new(process_info.hThread)?;

        job.assign_and_verify(process.raw())?;
        // SAFETY: The primary thread is suspended exactly once.
        if unsafe { ResumeThread(thread.raw()) } == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        suspended.disarm();

        Ok(Self {
            job,
            process,
            _stdio: stdio,
            pid: process_info.dwProcessId,
            terminated: false,
        })
    }

    pub fn terminate(&mut self) -> io::Result<()> {
        if self.terminated {
            return Ok(());
        }
        self.job
            .terminate_and_confirm(self.process.raw(), Duration::from_secs(2))?;
        self.terminated = true;
        Ok(())
    }
}

impl Drop for JobChild {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The process joins its Job through `assign_and_verify` after a suspended create, not through a
    /// `PROC_THREAD_ATTRIBUTE_JOB_LIST` attribute. The test binary cannot answer `--test-child`, so this
    /// drives the same `launch` with the unelevated test child's own fixed sleeping command line.
    #[test]
    fn launch_reaches_its_job_through_assign_and_verify_not_a_job_list_attribute() {
        let executable = std::env::current_exe()
            .expect("current exe")
            .with_file_name(format!(
                "native_isolation_test_child{}",
                std::env::consts::EXE_SUFFIX
            ));
        let command = format!("\"{}\" --sleep-ms 60000", executable.display());
        let mut child = JobChild::launch(&executable, &command, JobLimitProfile::FixedSleepTest)
            .expect("the launch path should succeed");
        assert_eq!(
            child
                .job
                .active_processes()
                .expect("Job accounting should be readable"),
            1,
            "the child must reach the Job through assign_and_verify after creation"
        );
        child.terminate().expect("the Job should terminate cleanly");
    }
}
