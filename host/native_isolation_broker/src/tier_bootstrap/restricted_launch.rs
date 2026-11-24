//! The supervisor's restricted token and its creation (#3499, #3400): the only place in this crate that
//! calls `CreateRestrictedToken` or `CreateProcessAsUserW`.
//!
//! # Why this is not a token launch in the sense the launcher forbids
//!
//! The token is a restricted copy of this process's own primary token, made here, and nothing else.
//! Windows lets an unprivileged process start a child with such a copy without
//! `SeAssignPrimaryTokenPrivilege`, so no privilege is held, asked for or adjusted, no logon is
//! performed and no foreign token is ever in reach. By default the copy keeps its logon SID enabled -
//! that is what lets the supervisor's children create the session's named kernel objects (#3805).
//! `SUPERCLAW_NATIVE_ROLE_DESKTOP_BOUNDARY=1`, decided by the owner and passed as a closed bootstrap
//! argument, instead makes every logon SID deny-only after the owner grants the tier SID KernelBase's
//! exact `0x2000f` open mask on this session's named-object directory (#3838). #3714 had made every
//! logon SID deny-only, which denied creation on the session `BaseNamedObjects` root and left the Office
//! preview's `soffice` retrying its IPC forever; a write-restricted variant (restricting SIDs) was tried
//! in its place and measured not to start the supervisor at all, consistent with the long-standing finding
//! that `user32` does not initialize under any restricting variant. So the only restriction the copy
//! carries is its default DACL. The cost of an enabled logon SID is that the token can open `WinSta0`, the
//! owner's desktop, and - its DACL granting that same SID - an owner process by name (#3400). The private
//! desktop the supervisor starts on is initial placement, not a boundary against reopening
//! `WinSta0\Default`. What remains for GUI operations is the role Job's UI limits - the clipboard, global
//! atoms, USER handles of processes outside the Job and, once sealed, desktop creation and switching - and
//! they do not cover `SendInput` or screen capture (#3499). Nothing here stops a tier process from opening
//! an owner process and reading its memory: no control applies to `OpenProcess` or `ReadProcessMemory`.
//! The role-level boundary is unresolved and tracked in #3838. This aligns the shape with Codex.
//!
//! The copy's default DACL is the tier account and SYSTEM, read back exactly, so the objects every role
//! creates grant neither the owner's logon SID nor anyone else.
//!
//! # The creation
//!
//! Suspended, with no console (`DETACHED_PROCESS`), an explicit environment block, `lpDesktop` naming the
//! private desktop, and no inherited handle at all: `bInheritHandles` is false, so the handle list is
//! empty by construction rather than by attribute. The owner resumes the supervisor, never this process.

use crate::launch_environment::encode_environment_block;
use crate::object_descriptor::{dacl_of, security_descriptor};
use crate::process_win32::{JOB_EXIT_CODE, OwnedHandle, wide_null};
use crate::tier_desktop_policy::{supervisor_default_dacl, supervisor_default_dacl_sddl};
use crate::token_info::{
    default_dacl, enabled_logon_sid, logon_groups, require_logon_sids_deny_only,
    require_no_enabled_package_groups, restricted_sids, token_groups, token_user,
    with_logon_sid_entries,
};
use std::io;
use std::path::Path;
use std::ptr::null;
use windows_sys::Win32::Security::{
    CreateRestrictedToken, SetTokenInformation, TOKEN_DEFAULT_DACL, TokenDefaultDacl,
};
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW, DETACHED_PROCESS,
    PROCESS_INFORMATION, STARTUPINFOW, TerminateProcess, WaitForSingleObject,
};

/// How long a dropped supervisor is given to die before its handle is closed anyway.
const DROP_TERMINATE_WAIT_MS: u32 = 2_000;

/// What one supervisor creation needs. Every field is derived by the bootstrap, none is caller input.
pub struct SupervisorSpec<'a> {
    pub image: &'a Path,
    pub command: &'a str,
    pub current_directory: &'a Path,
    pub environment: &'a [(String, String)],
    /// `station\desktop`.
    pub desktop: &'a str,
}

/// The suspended supervisor. Terminated on drop unless the process ends first, so a bootstrap that fails
/// after creating it leaves nothing behind even before the owner's Job is closed.
pub struct Supervisor {
    pub process: OwnedHandle,
    pub thread: OwnedHandle,
    pub pid: u32,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        // SAFETY: The handle is owned here and still open. Terminating a process that already exited
        // fails harmlessly, and there is no caller left to report a failure to.
        unsafe {
            TerminateProcess(self.process.raw(), JOB_EXIT_CODE);
            WaitForSingleObject(self.process.raw(), DROP_TERMINATE_WAIT_MS);
        }
    }
}

/// A copy of `own` whose logon SID is enabled by default and deny-only under the spike flag. Both forms
/// carry no restricting SID and use an exactly verified default DACL of `tier_sid` and SYSTEM.
pub fn restricted_token(
    own: &OwnedHandle,
    tier_sid: &str,
    logon_sid: &str,
    role_desktop_boundary: bool,
) -> io::Result<OwnedHandle> {
    let mut restricted = std::ptr::null_mut();
    // SAFETY: The optional entries point at SIDs inside token information kept alive for the call. No
    // privilege is deleted and no restricting SID is added.
    let created = if role_desktop_boundary {
        with_logon_sid_entries(own, |disable| unsafe {
            CreateRestrictedToken(
                own.raw(),
                0,
                disable.len() as u32,
                disable.as_ptr(),
                0,
                null(),
                0,
                null(),
                &mut restricted,
            )
        })?
    } else {
        // SAFETY: No SID is disabled, no privilege deleted and no restricting SID added.
        unsafe {
            CreateRestrictedToken(
                own.raw(),
                0,
                0,
                null(),
                0,
                null(),
                0,
                null(),
                &mut restricted,
            )
        }
    };
    if created == 0 {
        return Err(io::Error::last_os_error());
    }
    let restricted = OwnedHandle::new(restricted)?;
    if role_desktop_boundary {
        require_logon_sids_deny_only(&logon_groups(&restricted)?, logon_sid)?;
        require_no_enabled_package_groups(&token_groups(&restricted)?)?;
    } else if enabled_logon_sid(&restricted)? != crate::sid_win32::canonical_sid(logon_sid)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the restricted copy did not keep the owner's logon SID enabled",
        ));
    }
    if !restricted_sids(&restricted)?.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the restricted copy is unexpectedly write-restricted",
        ));
    }
    if token_user(&restricted)? != token_user(own)? {
        return Err(io::Error::other(
            "the restricted copy is not of this process's own account",
        ));
    }

    let descriptor = security_descriptor(&supervisor_default_dacl_sddl(tier_sid))?;
    let default = TOKEN_DEFAULT_DACL {
        DefaultDacl: dacl_of(&descriptor)?,
    };
    // SAFETY: The ACL lives inside `descriptor`, which outlives the call; the kernel copies it.
    if unsafe {
        SetTokenInformation(
            restricted.raw(),
            TokenDefaultDacl,
            (&raw const default).cast(),
            size_of::<TOKEN_DEFAULT_DACL>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let expected = supervisor_default_dacl(tier_sid)?;
    let actual = default_dacl(&restricted)?;
    if actual != expected {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("the restricted token's default DACL read back as {actual:?}"),
        ));
    }
    Ok(restricted)
}

/// Starts the supervisor suspended with `token`.
pub fn start_supervisor(token: &OwnedHandle, spec: &SupervisorSpec<'_>) -> io::Result<Supervisor> {
    let application = wide_null(spec.image.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "non-Unicode supervisor image")
    })?);
    let mut command = wide_null(spec.command);
    let directory = wide_null(spec.current_directory.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "non-Unicode working directory")
    })?);
    let mut environment = encode_environment_block(spec.environment)?;
    let mut desktop = wide_null(spec.desktop);
    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        lpDesktop: desktop.as_mut_ptr(),
        ..Default::default()
    };
    let mut info = PROCESS_INFORMATION::default();
    // SAFETY: Every string and the environment block are NUL-terminated and outlive the call. No handle
    // is inherited (`bInheritHandles` is false), and the process starts suspended.
    let created = unsafe {
        CreateProcessAsUserW(
            token.raw(),
            application.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_SUSPENDED | DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT,
            environment.as_mut_ptr().cast(),
            directory.as_ptr(),
            &startup,
            &mut info,
        )
    };
    if created == 0 {
        return Err(io::Error::last_os_error());
    }
    let process = OwnedHandle::new(info.hProcess)?;
    let thread = match OwnedHandle::new(info.hThread) {
        Ok(thread) => thread,
        Err(error) => {
            // SAFETY: The process exists and is owned here; it never ran.
            unsafe { TerminateProcess(process.raw(), JOB_EXIT_CODE) };
            return Err(error);
        }
    };
    Ok(Supervisor {
        process,
        thread,
        pid: info.dwProcessId,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch_environment::{current_process_environment, resolve_role_environment};
    use crate::sid_win32::{canonical_sid, current_process_sid};
    use crate::tier_desktop_policy::supervisor_default_dacl;
    use crate::token_info::{
        current_process_token, default_dacl, enabled_logon_sid, open_process_token,
        restricted_sids, token_user,
    };
    use windows_sys::Win32::Security::{
        TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY,
    };

    fn own_token() -> OwnedHandle {
        current_process_token(
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
        )
        .expect("own token")
    }

    /// The test process's logon SID, or `None` on a host whose token carries none (some CI services).
    fn own_logon_sid() -> Option<String> {
        enabled_logon_sid(&own_token()).ok()
    }

    #[test]
    fn the_restricted_copy_keeps_the_logon_sid_enabled_and_carries_no_restricting_sid() {
        let Some(logon) = own_logon_sid() else {
            eprintln!("skipped: this token carries no logon SID");
            return;
        };
        let tier = current_process_sid().expect("sid");
        let token = restricted_token(&own_token(), &tier, &logon, false).expect("restricted copy");
        assert_eq!(token_user(&token).expect("user"), tier);
        assert_eq!(
            enabled_logon_sid(&token).expect("logon"),
            canonical_sid(&logon).expect("canonical logon")
        );
        assert!(
            restricted_sids(&token)
                .expect("restricting SIDs")
                .is_empty(),
            "a restricting SID was measured not to start the supervisor (#3805)"
        );
        assert_eq!(
            default_dacl(&token).expect("default DACL"),
            supervisor_default_dacl(&tier).expect("expected")
        );
    }

    #[test]
    fn a_logon_sid_that_is_not_the_token_s_enabled_one_is_refused() {
        let tier = current_process_sid().expect("sid");
        assert!(restricted_token(&own_token(), &tier, "S-1-5-5-0-1", false).is_err());
        assert!(restricted_token(&own_token(), &tier, "S-1-5-5-0-1", true).is_err());
    }

    #[test]
    fn the_flagged_copy_makes_every_logon_sid_deny_only() {
        let Some(logon) = own_logon_sid() else {
            eprintln!("skipped: this token carries no logon SID");
            return;
        };
        let tier = current_process_sid().expect("sid");
        let token = restricted_token(&own_token(), &tier, &logon, true).expect("restricted copy");
        require_logon_sids_deny_only(&logon_groups(&token).expect("groups"), &logon)
            .expect("deny-only");
        require_no_enabled_package_groups(&token_groups(&token).expect("groups"))
            .expect("no package group");
        assert!(
            restricted_sids(&token)
                .expect("restricting SIDs")
                .is_empty()
        );
    }

    /// The real creation, against the test child, on this process's own desktop: suspended, restricted,
    /// and terminated when dropped.
    #[test]
    fn the_supervisor_starts_suspended_with_the_restricted_token_and_dies_on_drop() {
        let Some(logon) = own_logon_sid() else {
            eprintln!("skipped: this token carries no logon SID");
            return;
        };
        let tier = current_process_sid().expect("sid");
        let token = restricted_token(&own_token(), &tier, &logon, false).expect("restricted copy");
        let image = std::env::current_exe()
            .expect("exe")
            .with_file_name("native_isolation_test_child.exe");
        let command = format!("\"{}\" --sleep-ms 60000", image.display());
        let environment =
            resolve_role_environment(current_process_environment().expect("env").into_iter(), &[])
                .expect("environment");
        let directory = image.parent().expect("dir").to_owned();
        let desktop = current_desktop_path();
        let supervisor = start_supervisor(
            &token,
            &SupervisorSpec {
                image: &image,
                command: &command,
                current_directory: &directory,
                environment: &environment,
                desktop: &desktop,
            },
        )
        .expect("the supervisor is created");
        assert_ne!(supervisor.pid, 0);
        let child_token =
            open_process_token(supervisor.process.raw(), TOKEN_QUERY).expect("child token");
        assert_eq!(
            enabled_logon_sid(&child_token).expect("logon"),
            canonical_sid(&logon).expect("canonical logon"),
            "the child keeps the owner's logon SID enabled"
        );
        assert!(
            restricted_sids(&child_token)
                .expect("restricting SIDs")
                .is_empty()
        );
        let watched = duplicate(&supervisor.process);
        drop(supervisor);
        watched
            .wait(std::time::Duration::from_secs(10))
            .expect("the supervisor must not outlive its guard");
    }

    fn duplicate(handle: &OwnedHandle) -> OwnedHandle {
        use windows_sys::Win32::Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle};
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        let mut copy = std::ptr::null_mut();
        // SAFETY: Both process handles are this process's pseudo-handle; `handle` is live.
        let duplicated = unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                handle.raw(),
                GetCurrentProcess(),
                &mut copy,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        };
        assert_ne!(duplicated, 0, "{}", io::Error::last_os_error());
        OwnedHandle::new(copy).expect("a handle")
    }

    /// `station\desktop` for this test process.
    fn current_desktop_path() -> String {
        let user32 = super::super::station::User32::load().expect("user32");
        user32
            .current_desktop_path()
            .expect("this process has a desktop")
    }
}
