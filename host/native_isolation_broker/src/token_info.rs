//! Read-only questions about a token (#3499, #3400): its user, its logon SIDs and their attributes, its
//! logon session, and its default DACL.
//!
//! Shared by both tier hops. The bootstrap asks them of its own token and of the restricted copy it makes
//! for the supervisor; the owner asks them of its own token, of the bootstrap's through the process handle
//! it kept from creation, and of the supervisor's through the handle it duplicated. Nothing here creates,
//! changes or duplicates a token.

use crate::object_descriptor::{DaclEntry, decode_acl};
use crate::process_win32::OwnedHandle;
use crate::sid_win32::{canonical_sid, sid_to_string};
use std::ffi::c_void;
use std::io;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, GetLastError, HANDLE};
use windows_sys::Win32::Security::{
    GetTokenInformation, SID_AND_ATTRIBUTES, TOKEN_DEFAULT_DACL, TOKEN_GROUPS,
    TOKEN_INFORMATION_CLASS, TOKEN_OWNER, TOKEN_STATISTICS, TOKEN_USER, TokenDefaultDacl,
    TokenGroups, TokenOwner, TokenRestrictedSids, TokenStatistics, TokenUser,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub const SE_GROUP_ENABLED: u32 = 0x0000_0004;
pub const SE_GROUP_USE_FOR_DENY_ONLY: u32 = 0x0000_0010;
pub const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;

/// One group of a token, as canonical SID text and its attribute bits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenGroup {
    pub sid: String,
    pub attributes: u32,
}

impl TokenGroup {
    pub const fn is_deny_only(&self) -> bool {
        self.attributes & SE_GROUP_USE_FOR_DENY_ONLY != 0 && self.attributes & SE_GROUP_ENABLED == 0
    }
}

/// Opens `process`'s token with `access`. The process handle needs `PROCESS_QUERY_LIMITED_INFORMATION`.
pub(crate) fn open_process_token(process: HANDLE, access: u32) -> io::Result<OwnedHandle> {
    let mut token = null_mut();
    // SAFETY: The caller's process handle is live; the token handle is owned by the return value.
    if unsafe { OpenProcessToken(process, access, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    OwnedHandle::new(token)
}

/// This process's own token.
pub fn current_process_token(access: u32) -> io::Result<OwnedHandle> {
    // SAFETY: The pseudo-handle is valid in this process.
    open_process_token(unsafe { GetCurrentProcess() }, access)
}

/// One token information class, in a buffer aligned for the structures it holds and keeping alive every
/// SID they point to.
struct TokenInformation(Vec<u64>);

impl TokenInformation {
    fn read(token: &OwnedHandle, class: TOKEN_INFORMATION_CLASS) -> io::Result<Self> {
        let mut required = 0;
        // SAFETY: A sizing call with no buffer.
        let first =
            unsafe { GetTokenInformation(token.raw(), class, null_mut(), 0, &mut required) };
        // SAFETY: Read immediately after the failed sizing call.
        if first != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0u64; (required as usize).div_ceil(8)];
        // SAFETY: The buffer holds at least `required` bytes and is 8-byte aligned.
        if unsafe {
            GetTokenInformation(
                token.raw(),
                class,
                buffer.as_mut_ptr().cast::<c_void>(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(buffer))
    }

    /// # Safety
    ///
    /// The buffer must have been read for a class whose structure is `T`.
    unsafe fn header<T>(&self) -> &T {
        // SAFETY: The caller names the structure the class wrote at the start of the buffer.
        unsafe { &*self.0.as_ptr().cast::<T>() }
    }

    /// The groups of a `TokenGroups` read.
    fn groups(&self) -> &[SID_AND_ATTRIBUTES] {
        // SAFETY: Only `TokenGroups` reads call this, which wrote a TOKEN_GROUPS and its entries.
        unsafe {
            let header = self.header::<TOKEN_GROUPS>();
            std::slice::from_raw_parts(header.Groups.as_ptr(), header.GroupCount as usize)
        }
    }
}

pub fn token_user(token: &OwnedHandle) -> io::Result<String> {
    let information = TokenInformation::read(token, TokenUser)?;
    // SAFETY: A `TokenUser` read wrote a TOKEN_USER.
    sid_to_string(unsafe { information.header::<TOKEN_USER>() }.User.Sid)
}

/// The owner the token gives the objects it creates.
pub fn token_owner(token: &OwnedHandle) -> io::Result<String> {
    let information = TokenInformation::read(token, TokenOwner)?;
    // SAFETY: A `TokenOwner` read wrote a TOKEN_OWNER.
    sid_to_string(unsafe { information.header::<TOKEN_OWNER>() }.Owner)
}

/// Every group whose attributes mark it as a logon SID, in token order.
pub fn token_groups(token: &OwnedHandle) -> io::Result<Vec<TokenGroup>> {
    let information = TokenInformation::read(token, TokenGroups)?;
    information
        .groups()
        .iter()
        .map(|group| {
            Ok(TokenGroup {
                sid: sid_to_string(group.Sid)?,
                attributes: group.Attributes,
            })
        })
        .collect()
}

/// Every group whose attributes mark it as a logon SID, in token order.
pub fn logon_groups(token: &OwnedHandle) -> io::Result<Vec<TokenGroup>> {
    Ok(token_groups(token)?
        .into_iter()
        .filter(|group| group.attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID)
        .collect())
}

/// The token's one enabled logon SID. None, or more than one, is refused.
pub fn enabled_logon_sid(token: &OwnedHandle) -> io::Result<String> {
    let enabled: Vec<TokenGroup> = logon_groups(token)?
        .into_iter()
        .filter(|group| group.attributes & SE_GROUP_ENABLED != 0)
        .collect();
    match enabled.as_slice() {
        [only] => Ok(only.sid.clone()),
        other => Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "the token has {} enabled logon SIDs, not exactly one",
                other.len()
            ),
        )),
    }
}

/// The logon session the token belongs to, as `(HighPart, LowPart)` of its authentication id.
pub fn authentication_id(token: &OwnedHandle) -> io::Result<(i32, u32)> {
    let mut statistics = TOKEN_STATISTICS::default();
    let mut returned = 0;
    // SAFETY: The class's structure has a fixed size, which is the buffer passed.
    if unsafe {
        GetTokenInformation(
            token.raw(),
            TokenStatistics,
            (&raw mut statistics).cast(),
            size_of::<TOKEN_STATISTICS>() as u32,
            &mut returned,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok((
        statistics.AuthenticationId.HighPart,
        statistics.AuthenticationId.LowPart,
    ))
}

/// The token's default DACL, in stored order.
pub fn default_dacl(token: &OwnedHandle) -> io::Result<Vec<DaclEntry>> {
    let information = TokenInformation::read(token, TokenDefaultDacl)?;
    // SAFETY: A `TokenDefaultDacl` read wrote a TOKEN_DEFAULT_DACL whose ACL lives in the same buffer.
    let acl = unsafe { information.header::<TOKEN_DEFAULT_DACL>() }.DefaultDacl;
    if acl.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the token has no default DACL",
        ));
    }
    // SAFETY: The ACL lives inside `information`, which outlives the call.
    unsafe { decode_acl(acl) }
}

/// The token's restricting SIDs, in stored order. Empty for a token that is not write-restricted.
pub fn restricted_sids(token: &OwnedHandle) -> io::Result<Vec<String>> {
    let information = TokenInformation::read(token, TokenRestrictedSids)?;
    information
        .groups()
        .iter()
        .map(|group| sid_to_string(group.Sid))
        .collect()
}

/// Refuses unless `denied` is among the logon groups and every logon group is deny-only.
pub fn require_logon_sids_deny_only(groups: &[TokenGroup], denied: &str) -> io::Result<()> {
    let denied = canonical_sid(denied)?;
    let refused = |detail: String| Err(io::Error::new(io::ErrorKind::PermissionDenied, detail));
    if let Some(usable) = groups.iter().find(|group| !group.is_deny_only()) {
        return refused(format!(
            "the token's logon SID {} is usable (attributes {:#x}), not deny-only",
            usable.sid, usable.attributes
        ));
    }
    if !groups.iter().any(|group| group.sid == denied) {
        return refused(format!(
            "the token does not deny the logon SID {denied}: {groups:?}"
        ));
    }
    Ok(())
}

/// Refuses the enabled principals that would give a restricted role ambient package authority.
pub fn require_no_enabled_package_groups(groups: &[TokenGroup]) -> io::Result<()> {
    if let Some(group) = groups.iter().find(|group| {
        group.attributes & SE_GROUP_ENABLED != 0
            && (group.sid == "S-1-5-12" || group.sid.starts_with("S-1-5-101-"))
    }) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "the restricted token keeps forbidden package group {} enabled (attributes {:#x})",
                group.sid, group.attributes
            ),
        ));
    }
    Ok(())
}

/// Calls `use_entries` with the token's logon SIDs as entries whose SIDs stay alive for the call.
pub(crate) fn with_logon_sid_entries<R>(
    token: &OwnedHandle,
    use_entries: impl FnOnce(&[SID_AND_ATTRIBUTES]) -> R,
) -> io::Result<R> {
    let information = TokenInformation::read(token, TokenGroups)?;
    let entries: Vec<SID_AND_ATTRIBUTES> = information
        .groups()
        .iter()
        .filter(|group| group.Attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID)
        .map(|group| SID_AND_ATTRIBUTES {
            Sid: group.Sid,
            Attributes: 0,
        })
        .collect();
    Ok(use_entries(&entries))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sid_win32::current_process_sid;
    use windows_sys::Win32::Security::TOKEN_QUERY;

    const LOGON: &str = "S-1-5-5-0-7270000";

    fn group(sid: &str, attributes: u32) -> TokenGroup {
        TokenGroup {
            sid: sid.to_owned(),
            attributes,
        }
    }

    #[test]
    fn only_a_denied_and_disabled_logon_sid_passes() {
        let deny_only = SE_GROUP_LOGON_ID | SE_GROUP_USE_FOR_DENY_ONLY;
        assert!(require_logon_sids_deny_only(&[group(LOGON, deny_only)], LOGON).is_ok());
        for groups in [
            vec![],
            vec![group(LOGON, SE_GROUP_LOGON_ID | SE_GROUP_ENABLED)],
            vec![group(LOGON, deny_only | SE_GROUP_ENABLED)],
            vec![group("S-1-5-5-0-1", deny_only)],
        ] {
            assert_eq!(
                require_logon_sids_deny_only(&groups, LOGON)
                    .expect_err("not the exact deny-only shape")
                    .kind(),
                io::ErrorKind::PermissionDenied
            );
        }
    }

    #[test]
    fn enabled_package_groups_are_refused() {
        for sid in ["S-1-5-12", "S-1-5-101-1", "S-1-5-101-9-8-7"] {
            assert_eq!(
                require_no_enabled_package_groups(&[group(sid, SE_GROUP_ENABLED)])
                    .expect_err("enabled package group")
                    .kind(),
                io::ErrorKind::PermissionDenied
            );
            require_no_enabled_package_groups(&[group(sid, SE_GROUP_USE_FOR_DENY_ONLY)])
                .expect("deny-only is not enabled");
        }
        require_no_enabled_package_groups(&[group("S-1-5-32-545", SE_GROUP_ENABLED)])
            .expect("ordinary enabled group");
    }

    #[test]
    fn this_process_s_token_answers_every_question() {
        let token = current_process_token(TOKEN_QUERY).expect("own token");
        assert_eq!(
            token_user(&token).expect("user"),
            current_process_sid().expect("sid")
        );
        assert!(authentication_id(&token).is_ok());
        assert!(!default_dacl(&token).expect("default DACL").is_empty());
        for logon in logon_groups(&token).expect("groups") {
            assert!(logon.sid.starts_with("S-1-5-5-"), "{logon:?}");
        }
        // This process is not write-restricted, so it carries no restricting SIDs.
        assert!(restricted_sids(&token).expect("restricted SIDs").is_empty());
    }
}
