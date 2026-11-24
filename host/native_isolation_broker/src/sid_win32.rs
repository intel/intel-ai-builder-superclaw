//! Textual SID conversion, token-user lookup and name-to-SID resolution, shared by the elevated
//! broker and the unelevated launcher.
//!
//! Nothing here creates a token or changes a privilege. Every function is either a pure string
//! conversion (`ConvertStringSidToSidW`, `ConvertSidToStringSidW`), a read-only `TOKEN_QUERY` on a
//! handle the caller already holds, or a read-only account lookup (`LookupAccountNameW`) that any
//! caller may perform. That is what makes this module safe for the launcher's module closure while
//! `win32.rs` and `identity_windows.rs` are not: both peers of a named pipe have to be able to say
//! *who* connected, and the launcher has to turn the account name it derives into the SID it will
//! bind a pipe to, and none of that needs any authority.
//!
//! `sid_text.rs` is the syntax-only counterpart and stays that way. It runs where no Win32 call is
//! wanted at all, including on the non-Windows test build.

use crate::process_win32::{OwnedHandle, wide_null};
use std::ffi::c_void;
use std::io;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, GetLastError, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSidToSidW};
use windows_sys::Win32::Security::{
    GetTokenInformation, LookupAccountNameW, PSID, SID_NAME_USE, SidTypeUser, TOKEN_QUERY,
    TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// A `LocalAlloc` block returned by a Windows conversion API, freed exactly once on drop.
pub struct LocalAllocation(*mut c_void);

impl LocalAllocation {
    pub fn new(pointer: *mut c_void) -> io::Result<Self> {
        if pointer.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(pointer))
        }
    }

    pub const fn pointer(&self) -> *mut c_void {
        self.0
    }
}

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: The pointer came from a Windows conversion API documented for LocalFree.
        unsafe {
            LocalFree(self.0);
        }
    }
}

/// Round-trips a textual SID through the binary form so two strings that denote the same principal
/// compare equal. Comparing the caller's spelling directly would let a differently-cased or
/// differently-padded spelling of the expected SID fail a match it should pass, or pass one it should
/// fail.
pub fn canonical_sid(value: &str) -> io::Result<String> {
    let wide = wide_null(value);
    let mut sid: PSID = null_mut();
    // SAFETY: Input is NUL-terminated and output receives LocalAlloc memory.
    if unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "SID is not valid",
        ));
    }
    let sid_owner = LocalAllocation::new(sid)?;
    sid_to_string(sid_owner.pointer())
}

/// Prefixes of the SID forms an owner may take: local and domain accounts, and Entra ID accounts.
const OWNER_SID_PREFIXES: [&str; 2] = ["S-1-5-21-", "S-1-12-1-"];

/// The SID prefix a local SAM account always has. Tier accounts are created by `NetUserAdd` on this
/// machine, so a resolved tier account SID outside this space is not the account that was
/// provisioned, whatever the name lookup said.
const LOCAL_ACCOUNT_SID_PREFIX: &str = "S-1-5-21-";

/// Canonicalizes an owner SID and refuses any SID that cannot be an account.
///
/// `canonical_sid` alone is not enough, because `ConvertStringSidToSidW` also accepts SDDL aliases
/// and well-known SIDs: `WD` becomes `S-1-1-0` (Everyone), `BU` becomes `S-1-5-32-545` (Users), `AU`
/// becomes `S-1-5-11` (Authenticated Users). Each is a valid SID and none of them is an owner. That
/// distinction became load-bearing in P3, which puts the owner SID in a credential DACL with read
/// rights: one of those SIDs there would hand every local principal - including every tier
/// account - every tier password, silently inverting the boundary the descriptor exists to draw.
///
/// The check here is structural on purpose: it needs no name resolution, so it cannot stall or fail
/// on an unreachable domain, and it holds for an owner whose account was already deleted. That is
/// what lets it run on every descriptor build, including every credential read - including the read
/// the unelevated launcher performs, which is why this lives here rather than in `identity_windows`.
/// What it cannot do is tell a user from a group - both share the `S-1-5-21-` RID space - so it is
/// only half the gate; `identity_windows::verify_owner_sid_names_a_user` is the other half and runs
/// wherever an owner ACE is written.
pub fn canonical_owner_sid(value: &str) -> io::Result<String> {
    let canonical = canonical_sid(value)?;
    let is_account = OWNER_SID_PREFIXES
        .iter()
        .any(|prefix| canonical.len() > prefix.len() && canonical.starts_with(prefix));
    if !is_account {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("owner SID must be an account SID, got {canonical}"),
        ));
    }
    Ok(canonical)
}

/// Resolves an account name to its canonical SID text and the type this machine says it is.
///
/// The plain lookup, with no policy applied: `LookupAccountNameW` twice, once to size the SID buffer
/// and once to fill it. Callers decide what they will accept, because the two of them want different
/// things - the elevated broker records whatever SID its own `NetUserAdd` produced, while the
/// launcher has to refuse anything that is not a local user account before it binds a pipe to it.
///
/// Unprivileged: resolving a name to a SID needs no authority at all, which is what lets the
/// launcher's first hop find the account it derived without an elevated round trip.
pub fn lookup_account_sid(account_name: &str) -> io::Result<(String, SID_NAME_USE)> {
    let name = wide_null(account_name);
    let mut sid_length = 0;
    let mut domain_length = 0;
    let mut sid_use: SID_NAME_USE = 0;
    // SAFETY: sizing call; all lengths are writable.
    unsafe {
        LookupAccountNameW(
            null_mut(),
            name.as_ptr(),
            null_mut(),
            &mut sid_length,
            null_mut(),
            &mut domain_length,
            &mut sid_use,
        );
    }
    if sid_length == 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return Err(io::Error::last_os_error());
    }
    let mut sid = vec![0u8; sid_length as usize];
    let mut domain = vec![0u16; domain_length.max(1) as usize];
    // SAFETY: both buffers were sized by the preceding call.
    if unsafe {
        LookupAccountNameW(
            null_mut(),
            name.as_ptr(),
            sid.as_mut_ptr().cast(),
            &mut sid_length,
            domain.as_mut_ptr(),
            &mut domain_length,
            &mut sid_use,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: sid contains a valid SID returned by LookupAccountNameW.
    let text = sid_to_string(sid.as_mut_ptr().cast())?;
    Ok((text, sid_use))
}

/// Resolves a local user account name to its SID, refusing anything that is not one.
///
/// This is what the launcher's first hop turns a derived tier account name into: the SID it will
/// require on the far end of both pipes, and the identity `CreateProcessWithLogonW` is expected to
/// produce. Three things are checked, and a failure of any of them means the derived name does not
/// denote the provisioned account:
///
/// - the name resolves at all, so a missing account is `NotFound` rather than a logon failure later;
/// - this machine calls it a *user*, so a group or alias that happened to take the name cannot stand
///   in for the account (`SidTypeUser` only - unlike the owner gate, a deleted account is no use
///   here, because the point is to log on as it);
/// - the SID is an account-domain SID (`S-1-5-21-…`), so a well-known or builtin principal cannot
///   stand in for one.
///
/// That third check is about well-known SIDs and nothing more. Domain user SIDs share the `S-1-5-21-`
/// prefix, so it does not by itself exclude a domain principal that answers the same name - what
/// excludes one is the `.` domain `launcher::logon` passes to `CreateProcessWithLogonW`, which resolves
/// only the local SAM. Do not read this check as the barrier against a domain account: it is not.
pub fn local_user_account_sid(account_name: &str) -> io::Result<String> {
    let (sid, sid_use) = lookup_account_sid(account_name)?;
    if sid_use != SidTypeUser {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{account_name} does not name a user account on this machine"),
        ));
    }
    if !sid.starts_with(LOCAL_ACCOUNT_SID_PREFIX) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{account_name} resolves to {sid}, which is not a local account SID"),
        ));
    }
    Ok(sid)
}

/// The user SID of this process's own token.
pub fn current_process_sid() -> io::Result<String> {
    // SAFETY: GetCurrentProcess returns a pseudo-handle valid in this process.
    token_sid_for_process(unsafe { GetCurrentProcess() })
}

/// Binds a caller-supplied owner selector to this process's token identity.
pub fn require_current_process_owner_sid(requested_owner_sid: &str) -> io::Result<String> {
    require_owner_sid_match(requested_owner_sid, &current_process_sid()?)
}

fn require_owner_sid_match(
    requested_owner_sid: &str,
    current_owner_sid: &str,
) -> io::Result<String> {
    let requested = canonical_owner_sid(requested_owner_sid)?;
    let current = canonical_owner_sid(current_owner_sid)?;
    if requested != current {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the requested owner SID does not match the launcher identity",
        ));
    }
    Ok(current)
}

/// The user SID of the token of `pid`, opened with the least access that answers the question.
///
/// Only usable when the caller can still open that process. A process created by
/// `CreateProcessWithLogonW` cannot be assumed to be openable: the API gives the new process a security
/// descriptor derived from the *new* user's token, which need not admit the creator at all, so a caller
/// that already holds the handle the creation returned must use `token_sid_for_owned_process` instead of
/// coming back through a process id.
pub fn token_sid_for_pid(pid: u32) -> io::Result<String> {
    // SAFETY: OpenProcess takes a numeric PID and the handle is not inheritable.
    let process =
        OwnedHandle::new(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    token_sid_for_process(process.raw())
}

/// The user SID of the token of a process the caller already holds a handle to.
///
/// This is what a cross-account launch has to use. The handle `CreateProcessWithLogonW` returns is
/// documented to keep full access rights whatever the new process's own descriptor says, so reading the
/// token through it works where reopening the id would be refused - and it removes the id round-trip
/// entirely, so there is no window in which the id could denote anything else.
pub fn token_sid_for_owned_process(process: &OwnedHandle) -> io::Result<String> {
    token_sid_for_process(process.raw())
}

/// The user SID of `process`'s token. The handle needs `PROCESS_QUERY_LIMITED_INFORMATION`, which the
/// two wrappers above both hold.
///
/// Deliberately not exported. Both callers above already own their handle, and a `HANDLE` parameter on
/// a public safe function is a raw pointer a caller outside this module could get wrong.
fn token_sid_for_process(process: HANDLE) -> io::Result<String> {
    let mut token = null_mut();
    // SAFETY: The process handle has query rights and token output is writable.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedHandle::new(token)?;
    let mut required = 0;
    // SAFETY: Null buffer query obtains the required TOKEN_USER size.
    let first =
        unsafe { GetTokenInformation(token.raw(), TokenUser, null_mut(), 0, &mut required) };
    // SAFETY: GetLastError immediately follows the failed sizing call.
    if first != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0u8; required as usize];
    // SAFETY: Buffer is correctly sized by the preceding API query.
    if unsafe {
        GetTokenInformation(
            token.raw(),
            TokenUser,
            buffer.as_mut_ptr().cast::<c_void>(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: GetTokenInformation initialized a TOKEN_USER at the buffer start.
    let token_user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    sid_to_string(token_user.User.Sid)
}

/// Formats a binary SID as its canonical `S-1-...` text.
///
/// Crate-internal for the same reason as `token_sid_for_process`: the caller has to guarantee that
/// `sid` points at a live SID, and that is not a contract to hand to a test.
pub(crate) fn sid_to_string(sid: PSID) -> io::Result<String> {
    let mut string_sid = null_mut();
    // SAFETY: SID is valid for the duration of the call; output receives LocalAlloc memory.
    if unsafe { ConvertSidToStringSidW(sid, &mut string_sid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let owner = LocalAllocation::new(string_sid.cast())?;
    let mut length = 0;
    // SAFETY: ConvertSidToStringSidW returns a NUL-terminated UTF-16 string.
    let text = unsafe {
        while *string_sid.add(length) != 0 {
            length += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(string_sid, length))
    };
    drop(owner);
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_requested_owner_must_match_the_process_identity() {
        let current = "S-1-5-21-1-2-3-1001";
        assert_eq!(
            require_owner_sid_match(current, current).expect("matching owner should be accepted"),
            current
        );
        assert_eq!(
            require_owner_sid_match("S-1-5-21-1-2-3-1002", current)
                .expect_err("another owner must be refused")
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn a_textual_sid_survives_the_round_trip_and_a_malformed_one_is_refused() {
        let well_known = canonical_sid("S-1-5-18").expect("the SYSTEM SID should convert");
        assert_eq!(well_known, "S-1-5-18");
        assert_eq!(
            canonical_sid("s-1-5-18").expect("SDDL parsing is case insensitive"),
            "S-1-5-18",
            "canonicalization is what makes a spelling difference stop mattering"
        );
        assert_eq!(
            canonical_sid("not-a-sid")
                .expect_err("a malformed SID must not canonicalize")
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    /// The three ways of asking must agree, because the launcher swapped one for another: the pipe
    /// binding used to reopen a process id and now reads the token through the handle the creation call
    /// returned. That swap is only safe if the two answer identically where both work, which is inside
    /// one account - the case this test can construct.
    #[test]
    fn this_process_reports_the_same_sid_through_a_pid_and_through_a_handle() {
        let by_pseudo_handle = current_process_sid().expect("this process has a token");
        let by_pid = token_sid_for_pid(std::process::id()).expect("this process is openable");
        // SAFETY: OpenProcess takes a numeric pid and the returned handle is owned below.
        let opened = OwnedHandle::new(unsafe {
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, std::process::id())
        })
        .expect("this process can open itself for query");
        let by_handle = token_sid_for_owned_process(&opened).expect("the handle has query rights");
        assert_eq!(by_pseudo_handle, by_pid);
        assert_eq!(by_pseudo_handle, by_handle);
        assert!(
            by_pseudo_handle.starts_with("S-1-"),
            "unexpected SID text: {by_pseudo_handle}"
        );
    }
}
