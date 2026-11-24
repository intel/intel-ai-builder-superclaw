//! Startup gate that refuses a release build running with an elevated admin token (#3176).
//!
//! An elevated launch creates the native backend roots owned by `Administrators`, which the isolation
//! broker refuses to provision. That covers "Run as administrator" and an administrator with UAC turned
//! off, whose every launch is elevated. Debug builds are let through for elevated dev shells (#2899).

use std::sync::OnceLock;

/// Whether this launch must be refused. A probe that failed (`None`) never refuses.
pub fn is_blocking(elevated: Option<bool>, debug_build: bool) -> bool {
    !debug_build && elevated == Some(true)
}

/// The verdict for this process, decided once.
pub fn blocked() -> bool {
    static BLOCKED: OnceLock<bool> = OnceLock::new();
    *BLOCKED.get_or_init(|| is_blocking(token_is_elevated(), cfg!(debug_assertions)))
}

#[cfg(windows)]
fn token_is_elevated() -> Option<bool> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo-handle; `token` is a valid out pointer.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let mut elevated: u32 = 0;
    let mut returned: u32 = 0;
    // SAFETY: `elevated` is a TOKEN_ELEVATION-sized buffer and `token` is open for TOKEN_QUERY.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            (&mut elevated as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
            &mut returned,
        )
    };
    // SAFETY: `token` was opened above and is closed exactly once.
    unsafe { CloseHandle(token) };
    (ok != 0).then_some(elevated != 0)
}

#[cfg(not(windows))]
fn token_is_elevated() -> Option<bool> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_elevated_token_is_refused_only_in_release_builds() {
        assert!(is_blocking(Some(true), false)); // Run as administrator, or UAC off
        assert!(!is_blocking(Some(true), true)); // debug build
        assert!(!is_blocking(Some(false), false)); // normal launch, or a standard user
        assert!(!is_blocking(None, false)); // probe failed: fail open
    }
}
