//! The tier's private window station and desktop (#3499, #3400), and the one place `user32` is reached
//! from the bootstrap.
//!
//! # Why `user32` is loaded rather than imported
//!
//! A statically imported `user32` initializes before `main`, which is before the bootstrap has protected
//! itself, and connects the process to its window station at the same time. Loading it here keeps that
//! until after `self_protection.rs` has protected the bootstrap's own threads and default DACL; it does
//! nothing about a handle the tier opened to the process or a thread before that protection (#3713).
//! `tests/bootstrap_closure.rs` reads the built image's import table and refuses a static `user32`,
//! `gdi32` or `shell32`.
//!
//! # The station is created, never joined
//!
//! `CreateWindowStationW` with no name creates the station of the caller's logon session, and with
//! `CWF_CREATE_ONLY` it fails rather than return one that already exists. The bootstrap's logon session is
//! the fresh one Secondary Logon made for this launch, so the station cannot already exist; if it does,
//! something else made it, with a descriptor nobody here chose, and the launch is refused. There is no
//! join path: without `CWF_CREATE_ONLY` Windows ignores the supplied descriptor on an existing station.
//!
//! # The desktop needs the process on the station for one call
//!
//! `CreateDesktopW` creates on the calling process's current window station, so the process switches to
//! the new station, creates the desktop, and switches back. The switch is process-wide and fails if any
//! thread owns a window or a hook; the bootstrap has neither. A switch back that fails fails the launch.

use crate::object_descriptor::security_descriptor;
use crate::process_win32::wide_null;
use crate::tier_desktop_policy::{DESKTOP_ACCESS, STATION_ACCESS};
use std::ffi::c_void;
use std::io;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{FreeLibrary, HANDLE, HMODULE};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::LibraryLoader::{
    GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
};
use windows_sys::core::BOOL;

/// `CWF_CREATE_ONLY`, spelled here so the bootstrap needs no `Win32_UI_WindowsAndMessaging` feature.
pub const CWF_CREATE_ONLY: u32 = 1;

/// `UOI_NAME`.
const OBJECT_NAME: i32 = 2;

type CreateWindowStation = unsafe extern "system" fn(
    name: *const u16,
    flags: u32,
    access: u32,
    attributes: *const SECURITY_ATTRIBUTES,
) -> HANDLE;
type CreateDesktop = unsafe extern "system" fn(
    name: *const u16,
    device: *const u16,
    mode: *const c_void,
    flags: u32,
    access: u32,
    attributes: *const SECURITY_ATTRIBUTES,
) -> HANDLE;
type SetProcessWindowStation = unsafe extern "system" fn(station: HANDLE) -> BOOL;
type GetProcessWindowStation = unsafe extern "system" fn() -> HANDLE;
type GetUserObjectInformation = unsafe extern "system" fn(
    object: HANDLE,
    index: i32,
    information: *mut c_void,
    length: u32,
    needed: *mut u32,
) -> BOOL;
type CloseUserObject = unsafe extern "system" fn(object: HANDLE) -> BOOL;

/// The `user32` entry points the bootstrap uses, resolved after self-protection.
pub struct User32 {
    module: HMODULE,
    create_window_station: CreateWindowStation,
    create_desktop: CreateDesktop,
    set_process_window_station: SetProcessWindowStation,
    get_process_window_station: GetProcessWindowStation,
    get_user_object_information: GetUserObjectInformation,
    close_desktop: CloseUserObject,
    close_window_station: CloseUserObject,
}

/// Resolves one export of `module` as `T`.
///
/// # Safety
///
/// `T` must be the export's exact function pointer type.
unsafe fn export<T: Copy>(module: HMODULE, name: &'static [u8]) -> io::Result<T> {
    // SAFETY: `name` is NUL-terminated and `module` is loaded.
    let address = unsafe { GetProcAddress(module, name.as_ptr()) }.ok_or_else(|| {
        io::Error::other(format!(
            "user32 exports no {}",
            String::from_utf8_lossy(&name[..name.len() - 1])
        ))
    })?;
    // SAFETY: The caller names the export's exact signature; both are plain function pointers.
    Ok(unsafe { std::mem::transmute_copy::<unsafe extern "system" fn() -> isize, T>(&address) })
}

impl User32 {
    /// Loads `user32` from the system directory only.
    pub fn load() -> io::Result<Self> {
        let name = wide_null("user32.dll");
        // SAFETY: NUL-terminated name, no file handle, and a search confined to System32.
        let module =
            unsafe { LoadLibraryExW(name.as_ptr(), null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32) };
        if module.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: Every type below is the documented signature of the export it names.
        let resolved = unsafe {
            (|| {
                Ok(Self {
                    module,
                    create_window_station: export(module, b"CreateWindowStationW\0")?,
                    create_desktop: export(module, b"CreateDesktopW\0")?,
                    set_process_window_station: export(module, b"SetProcessWindowStation\0")?,
                    get_process_window_station: export(module, b"GetProcessWindowStation\0")?,
                    get_user_object_information: export(module, b"GetUserObjectInformationW\0")?,
                    close_desktop: export(module, b"CloseDesktop\0")?,
                    close_window_station: export(module, b"CloseWindowStation\0")?,
                })
            })()
        };
        if resolved.is_err() {
            // SAFETY: Loaded above and released exactly once on this path.
            unsafe { FreeLibrary(module) };
        }
        resolved
    }

    /// The name of a window station or desktop.
    pub(crate) fn object_name(&self, object: HANDLE) -> io::Result<String> {
        let mut buffer = [0u16; 256];
        let mut needed = 0;
        // SAFETY: `object` is a live station or desktop handle; the length is the buffer's bytes.
        if unsafe {
            (self.get_user_object_information)(
                object,
                OBJECT_NAME,
                buffer.as_mut_ptr().cast(),
                size_of_val(&buffer) as u32,
                &mut needed,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let length = buffer
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(buffer.len());
        String::from_utf16(&buffer[..length])
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "object name is not UTF-16"))
    }

    /// `station\desktop` of this process's current station and its calling thread's desktop.
    #[cfg(test)]
    pub fn current_desktop_path(&self) -> io::Result<String> {
        type GetThreadDesktop = unsafe extern "system" fn(thread: u32) -> HANDLE;
        // SAFETY: The documented signature of the export.
        let thread_desktop: GetThreadDesktop =
            unsafe { export(self.module, b"GetThreadDesktop\0") }?;
        // SAFETY: Both are this process's and thread's own, which must not be closed.
        let (station, desktop) = unsafe {
            (
                (self.get_process_window_station)(),
                thread_desktop(windows_sys::Win32::System::Threading::GetCurrentThreadId()),
            )
        };
        Ok(format!(
            "{}\\{}",
            self.object_name(station)?,
            self.object_name(desktop)?
        ))
    }
}

impl Drop for User32 {
    fn drop(&mut self) {
        // SAFETY: Loaded by `load` and released exactly once.
        unsafe { FreeLibrary(self.module) };
    }
}

/// A window station or desktop handle this process created, closed on drop.
pub struct UserObject<'a> {
    user32: &'a User32,
    handle: HANDLE,
    station: bool,
}

impl UserObject<'_> {
    pub const fn raw(&self) -> HANDLE {
        self.handle
    }
}

impl Drop for UserObject<'_> {
    fn drop(&mut self) {
        // SAFETY: The handle came from its creation call and is closed exactly once, here.
        unsafe {
            if self.station {
                (self.user32.close_window_station)(self.handle);
            } else {
                (self.user32.close_desktop)(self.handle);
            }
        }
    }
}

fn attributes(descriptor: &crate::sid_win32::LocalAllocation) -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.pointer(),
        bInheritHandle: 0,
    }
}

/// Creates the caller's logon-session window station with `sddl` as its whole security, refusing one that
/// already exists.
pub fn create_station<'a>(user32: &'a User32, sddl: &str) -> io::Result<UserObject<'a>> {
    let descriptor = security_descriptor(sddl)?;
    let attributes = attributes(&descriptor);
    // SAFETY: No name asks for the logon session's station; the attributes outlive the call.
    let handle = unsafe {
        (user32.create_window_station)(null(), CWF_CREATE_ONLY, STATION_ACCESS, &attributes)
    };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(UserObject {
        user32,
        handle,
        station: true,
    })
}

/// Creates desktop `name` on `station` with `sddl` as its whole security.
pub fn create_desktop<'a>(
    user32: &'a User32,
    station: &UserObject<'_>,
    name: &str,
    sddl: &str,
) -> io::Result<UserObject<'a>> {
    // SAFETY: Returns this process's current station, which must not be closed.
    let original = unsafe { (user32.get_process_window_station)() };
    if original.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `station` is a live station handle this process created.
    if unsafe { (user32.set_process_window_station)(station.raw()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let created = create_desktop_here(user32, name, sddl);
    // SAFETY: `original` is this process's station from before the switch.
    if unsafe { (user32.set_process_window_station)(original) } == 0 {
        let error = io::Error::last_os_error();
        drop(created);
        return Err(io::Error::new(
            error.kind(),
            format!("the bootstrap could not switch back to its own window station ({error})"),
        ));
    }
    created
}

/// Creates desktop `name` on this process's current station.
pub(crate) fn create_desktop_here<'a>(
    user32: &'a User32,
    name: &str,
    sddl: &str,
) -> io::Result<UserObject<'a>> {
    let descriptor = security_descriptor(sddl)?;
    let attributes = attributes(&descriptor);
    let name = wide_null(name);
    // SAFETY: NUL-terminated name, no device or mode, attributes that outlive the call.
    let handle = unsafe {
        (user32.create_desktop)(
            name.as_ptr(),
            null(),
            null(),
            0,
            DESKTOP_ACCESS,
            &attributes,
        )
    };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(UserObject {
        user32,
        handle,
        station: false,
    })
}

/// Opens (or creates) the caller's logon-session station the way `CWF_CREATE_ONLY` refuses to, so a test
/// can make sure it already exists.
#[cfg(test)]
pub fn join_session_station(user32: &User32) -> io::Result<UserObject<'_>> {
    // SAFETY: No name and no attributes: the logon session's own station, opened or created.
    let handle = unsafe { (user32.create_window_station)(null(), 0, 0x0002_0002, null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(UserObject {
        user32,
        handle,
        station: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object_descriptor::{ObjectKind, read_descriptor, require_exact};
    use crate::random_bytes::random_hex;
    use crate::sid_win32::current_process_sid;
    use crate::tier_desktop_policy::{DesktopTrustees, desktop_descriptor, desktop_sddl};

    const OWNER: &str = "S-1-5-21-1-2-3-1001";

    #[test]
    fn user32_loads_and_names_this_process_s_station() {
        let user32 = User32::load().expect("user32 loads from System32");
        let station = join_session_station(&user32).expect("the session station opens");
        let name = user32.object_name(station.raw()).expect("named");
        assert!(
            name.starts_with("Service-0x") && name.ends_with('$'),
            "{name}"
        );
    }

    /// The station is never joined: once the logon session's station exists, creation is refused with
    /// `ERROR_ALREADY_EXISTS` instead of handing back a station whose descriptor nobody here chose.
    #[test]
    fn a_station_that_already_exists_is_refused_rather_than_joined() {
        let user32 = User32::load().expect("user32");
        let _existing = join_session_station(&user32).expect("the session station opens");
        let error = create_station(&user32, "D:P(A;;0x000f037f;;;S-1-5-18)")
            .map(|_| ())
            .expect_err("an existing station must not be joined");
        assert_eq!(error.raw_os_error(), Some(183), "{error}");
    }

    /// A desktop created with the policy's SDDL reads back as exactly the policy's descriptor.
    #[test]
    fn a_desktop_created_with_the_policy_reads_back_exactly() {
        let user32 = User32::load().expect("user32");
        let tier = current_process_sid().expect("sid");
        let trustees = DesktopTrustees {
            owner_sid: OWNER,
            tier_sid: &tier,
        };
        let name = format!("SuperClawTest-{}", random_hex(8).expect("rng"));
        let desktop = create_desktop_here(&user32, &name, &desktop_sddl(&trustees))
            .expect("the desktop is created");
        assert_eq!(user32.object_name(desktop.raw()).expect("named"), name);
        let actual = read_descriptor(desktop.raw(), ObjectKind::Window, false).expect("read");
        let mut expected = desktop_descriptor(&trustees).expect("expected");
        expected.owner = None;
        require_exact("the test desktop", &actual, &expected).expect("exact");
    }
}
