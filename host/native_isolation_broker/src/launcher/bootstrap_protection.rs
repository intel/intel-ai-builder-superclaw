//! The owner's bootstrap DACL write (#3499): its process and primary thread, before it resumes.
//!
//! `CreateProcessWithLogonW` gives the bootstrap a descriptor derived from the tier token's default DACL:
//! the tier account and SYSTEM in full, and the owner's interactive logon SID `GENERIC_READ |
//! GENERIC_EXECUTE` (measured: `0x121411` on the process, `0x121848` on the primary thread). Flag-off
//! roles hold that logon SID enabled. So while the bootstrap is still suspended, and before anything of
//! it has run, the owner replaces both DACLs with a protected one naming SYSTEM, the bootstrap's own
//! tier account and `OWNER RIGHTS` `READ_CONTROL` (`tier_desktop_policy::bootstrap_object_sddl`), and reads
//! both back exactly. That drops the logon SID's entry, so no other tier can newly open the bootstrap
//! while it runs on `WinSta0` with that SID. A mismatch is a refusal, and the suspended bootstrap dies
//! with its creation guard.
//!
//! It does not exclude the same tier: any process of the bootstrap's own tier - a role of an earlier
//! launch - can open the bootstrap's process and threads for its whole life, write into it, or take its
//! token. Nor does it close the creation-time window: until the replacement, a process of any tier can
//! open the process and primary thread with that read and execute access - read the bootstrap's memory,
//! query or terminate it, read the thread's context or resume it - and a handle opened then keeps that
//! access afterwards. The threads the loader creates after resume carry the same creation-time default
//! DACL until the bootstrap's own `protect_self` protects them (`tier_bootstrap/self_protection.rs`).
//! That span, from `CreateProcessWithLogonW` until `protect_self` completes, is open residual risk,
//! tracked in #3713.
//!
//! Under the #3838 spike flag, the protected DACL grants the owner's logon SID instead of the tier SID.
//! The bootstrap needs that enabled SID to open real thread handles for self-protection; flagged roles
//! carry it deny-only, so neither that SID nor their tier SID can open the bootstrap.
//!
//! Both objects were created by this launch, through handles that carry full access whatever the
//! descriptor says. This module writes nothing else; the launcher's separate, flag-gated foreign-object
//! exception is `session_named_objects.rs`.

use crate::object_descriptor::{
    ObjectDescriptor, ObjectKind, dacl_of, read_descriptor, require_exact, security_descriptor,
};
use crate::process_win32::OwnedHandle;
use crate::sid_win32::canonical_sid;
use crate::tier_desktop_policy::{
    bootstrap_object_descriptor, bootstrap_object_sddl, boundary_bootstrap_object_descriptor,
    boundary_bootstrap_object_sddl,
};
use std::io;
use std::ptr::null_mut;
use windows_sys::Win32::Security::Authorization::{SE_KERNEL_OBJECT, SetSecurityInfo};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
};

/// Replaces and verifies the bootstrap's process and primary-thread DACLs.
pub(super) fn protect_bootstrap(
    process: &OwnedHandle,
    thread: &OwnedHandle,
    tier_sid: &str,
    owner_logon_sid: Option<&str>,
) -> io::Result<()> {
    let (sddl, expected) = if let Some(logon_sid) = owner_logon_sid {
        let logon_sid = canonical_sid(logon_sid)?;
        (
            boundary_bootstrap_object_sddl(&logon_sid),
            boundary_bootstrap_object_descriptor(&logon_sid)?,
        )
    } else {
        let tier = canonical_sid(tier_sid)?;
        (
            bootstrap_object_sddl(&tier),
            bootstrap_object_descriptor(&tier)?,
        )
    };
    replace_and_verify(process, "the tier bootstrap's process", &sddl, &expected)?;
    replace_and_verify(
        thread,
        "the tier bootstrap's primary thread",
        &sddl,
        &expected,
    )
}

fn replace_and_verify(
    object: &OwnedHandle,
    what: &str,
    sddl: &str,
    expected: &ObjectDescriptor,
) -> io::Result<()> {
    let descriptor = security_descriptor(sddl)?;
    let dacl = dacl_of(&descriptor)?;
    // SAFETY: The creation handle carries WRITE_DAC; the ACL lives inside `descriptor` for the call.
    let status = unsafe {
        SetSecurityInfo(
            object.raw(),
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            dacl,
            null_mut(),
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    require_exact(
        what,
        &read_descriptor(object.raw(), ObjectKind::Kernel, false)?,
        expected,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object_descriptor::{ObjectKind, read_descriptor};
    use crate::process_win32::wide_null;
    use crate::sid_win32::current_process_sid;
    use crate::tier_desktop_policy::bootstrap_object_descriptor;
    use std::ptr::null;
    use windows_sys::Win32::System::Threading::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW,
        TerminateProcess,
    };

    /// A suspended test child and its primary thread, terminated on drop.
    struct Suspended {
        process: OwnedHandle,
        thread: OwnedHandle,
    }

    impl Drop for Suspended {
        fn drop(&mut self) {
            // SAFETY: The handle is live and owned here.
            unsafe { TerminateProcess(self.process.raw(), 1) };
        }
    }

    fn suspended_child() -> Suspended {
        let image = std::env::current_exe()
            .expect("exe")
            .with_file_name("native_isolation_test_child.exe");
        let application = wide_null(&image.display().to_string());
        let mut command = wide_null(&format!("\"{}\" --sleep-ms 60000", image.display()));
        let startup = STARTUPINFOW {
            cb: size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };
        let mut info = PROCESS_INFORMATION::default();
        // SAFETY: Every string is NUL-terminated and outlives the call; nothing is inherited.
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                0,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                null(),
                null(),
                &startup,
                &mut info,
            )
        };
        assert_ne!(created, 0, "{}", io::Error::last_os_error());
        Suspended {
            process: OwnedHandle::new(info.hProcess).expect("process"),
            thread: OwnedHandle::new(info.hThread).expect("thread"),
        }
    }

    #[test]
    fn a_suspended_child_s_process_and_thread_read_back_exactly_protected() {
        let tier = current_process_sid().expect("this process's SID");
        let child = suspended_child();
        protect_bootstrap(&child.process, &child.thread, &tier, None).expect("protected");
        let expected = bootstrap_object_descriptor(&tier).expect("expected");
        for handle in [&child.process, &child.thread] {
            let read = read_descriptor(handle.raw(), ObjectKind::Kernel, false).expect("read");
            assert!(read.protected);
            assert_eq!(read.entries, expected.entries);
        }
    }

    #[test]
    fn a_tier_sid_that_is_not_a_sid_is_refused_before_anything_is_written() {
        let child = suspended_child();
        let before = read_descriptor(child.process.raw(), ObjectKind::Kernel, false).expect("read");
        assert!(protect_bootstrap(&child.process, &child.thread, "not-a-sid", None).is_err());
        assert_eq!(
            read_descriptor(child.process.raw(), ObjectKind::Kernel, false).expect("read"),
            before,
            "a refused protection must not have written half of itself"
        );
    }

    #[test]
    fn a_flagged_bootstrap_grants_the_owner_logon_sid_not_the_tier() {
        let tier = current_process_sid().expect("this process's SID");
        let logon = "S-1-5-5-0-7270000";
        let child = suspended_child();
        protect_bootstrap(&child.process, &child.thread, &tier, Some(logon)).expect("protected");
        let expected = boundary_bootstrap_object_descriptor(logon).expect("expected");
        for handle in [&child.process, &child.thread] {
            let read = read_descriptor(handle.raw(), ObjectKind::Kernel, false).expect("read");
            assert_eq!(read.entries, expected.entries);
            assert!(read.entries.iter().all(|entry| entry.sid != tier));
        }
    }
}
