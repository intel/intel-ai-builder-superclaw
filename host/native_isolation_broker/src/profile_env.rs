//! Initializes a newly provisioned tier account profile without persisting caller environment.

use crate::wide::to_wide;
use std::io;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Security::{
    LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT, LogonUserW,
};
use windows_sys::Win32::UI::Shell::{LoadUserProfileW, PROFILEINFOW, UnloadUserProfile};

pub fn initialize_profile(account_name: &str, password: &str) -> io::Result<()> {
    let account = to_wide(account_name);
    let domain = to_wide(".");
    let password = to_wide(password);
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: all strings are NUL-terminated and token is a writable out-pointer.
    if unsafe {
        LogonUserW(
            account.as_ptr(),
            domain.as_ptr(),
            password.as_ptr(),
            LOGON32_LOGON_INTERACTIVE,
            LOGON32_PROVIDER_DEFAULT,
            &mut token,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedHandle(token);

    let mut account = to_wide(account_name);
    let mut profile = PROFILEINFOW {
        dwSize: size_of::<PROFILEINFOW>() as u32,
        lpUserName: account.as_mut_ptr(),
        ..Default::default()
    };
    // SAFETY: token is a valid logon token; profile points to live writable storage.
    if unsafe { LoadUserProfileW(token.0, &mut profile) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: LoadUserProfileW populated hProfile for this token.
    if unsafe { UnloadUserProfile(token.0, profile.hProfile) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: LogonUserW returned this token and OwnedHandle is its sole owner.
        unsafe {
            CloseHandle(self.0);
        }
    }
}
