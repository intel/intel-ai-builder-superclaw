//! Removes the Windows user profiles that deleted tier accounts left behind.
//!
//! Provisioning creates one profile per tier account (see `profile_env.rs`), and `NetUserDel` does not
//! remove it, so revoke has to. Earlier builds did not, and Windows gives a re-created account a
//! suffixed folder while the old folder still exists, so one derived name can own `<name>`,
//! `<name>.<COMPUTERNAME>`, `<name>.<COMPUTERNAME>.000` and so on.
//!
//! A profile is removed only when its folder is one of those names *and* its SID maps to no account
//! on this machine. The second condition is the one that matters on the elevated side: whatever a
//! folder is called, a profile somebody can still log on with is never touched.
//!
//! It also answers where an owner's own profile is, which `profile_ancestor_apply` binds its writes to.
//!
//! Elevated only. `DeleteProfileW` needs administrator rights, and the unelevated launcher has no
//! business deleting anything, so this module stays out of `launcher_main.rs`'s closure.

use crate::sid_win32::{LocalAllocation, canonical_sid};
use crate::wide::to_wide;
use std::io;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER, ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS,
    ERROR_NONE_MAPPED, ERROR_SUCCESS, GetLastError,
};
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::{LookupAccountSidW, PSID, SID_NAME_USE};
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_SZ, RegCloseKey, RegEnumKeyExW, RegGetValueW,
    RegOpenKeyExW,
};
use windows_sys::Win32::UI::Shell::DeleteProfileW;

const PROFILE_LIST_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList";

/// Registry key names are at most 255 characters.
const MAX_KEY_NAME: usize = 256;

/// Deletes every orphaned profile whose folder belongs to `account_name`.
///
/// Attempts every orphan even when one fails, and reports the first failure, so a single profile that
/// is still in use does not leave the rest behind.
pub fn remove_orphaned_profiles(account_name: &str) -> io::Result<()> {
    let mut first_error = None;
    for sid in orphaned_profiles_named_for(account_name)? {
        if let Err(error) = delete_profile(&sid) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn orphaned_profiles_named_for(account_name: &str) -> io::Result<Vec<String>> {
    let mut orphans = Vec::new();
    for entry in profile_entries()? {
        if !is_profile_folder_for(profile_folder_name(&entry.path), account_name) {
            continue;
        }
        // ProfileList also holds `<SID>.bak` keys from interrupted profile loads. They are not SIDs,
        // `DeleteProfileW` cannot name them, and they must not turn every later revoke into a failure.
        let Ok(sid) = canonical_sid(&entry.sid) else {
            continue;
        };
        if !sid_maps_to_account(&sid)? {
            orphans.push(sid);
        }
    }
    Ok(orphans)
}

/// Whether `folder` is the profile folder Windows would give an account named `account_name`: the
/// name itself, or the name followed by the `.`-separated suffix it adds when that folder is taken.
fn is_profile_folder_for(folder: &str, account_name: &str) -> bool {
    let Some(rest) = folder.get(account_name.len()..) else {
        return false;
    };
    folder[..account_name.len()].eq_ignore_ascii_case(account_name)
        && (rest.is_empty() || rest.starts_with('.'))
}

fn profile_folder_name(path: &str) -> &str {
    path.trim_end_matches('\\')
        .rsplit('\\')
        .next()
        .unwrap_or_default()
}

struct ProfileEntry {
    sid: String,
    path: String,
}

struct RegistryKey(HKEY);

impl Drop for RegistryKey {
    fn drop(&mut self) {
        // SAFETY: RegOpenKeyExW opened this key and RegistryKey is its sole owner.
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

fn open_profile_list() -> io::Result<RegistryKey> {
    let path = to_wide(PROFILE_LIST_KEY);
    let mut handle: HKEY = null_mut();
    // SAFETY: path is NUL-terminated and handle is a writable out-pointer.
    let status =
        unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.as_ptr(), 0, KEY_READ, &mut handle) };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    Ok(RegistryKey(handle))
}

/// The profile folder Windows records for `sid`, or `None` when it has no ProfileList entry.
///
/// Read from `HKLM`, not from the caller's environment, so a requester cannot name its own answer.
pub fn profile_path_for(sid: &str) -> io::Result<Option<String>> {
    let key = open_profile_list()?;
    match profile_image_path(&key, &to_wide(sid)) {
        Ok(path) => Ok(Some(path)),
        Err(error) if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Every ProfileList entry that has a `ProfileImagePath`.
fn profile_entries() -> io::Result<Vec<ProfileEntry>> {
    let key = open_profile_list()?;

    let mut entries = Vec::new();
    for index in 0u32.. {
        let mut name = [0u16; MAX_KEY_NAME];
        let mut length = MAX_KEY_NAME as u32;
        // SAFETY: name is valid for `length` characters; the optional outputs are null.
        let status = unsafe {
            RegEnumKeyExW(
                key.0,
                index,
                name.as_mut_ptr(),
                &mut length,
                null(),
                null_mut(),
                null_mut(),
                null_mut(),
            )
        };
        match status {
            ERROR_SUCCESS => {}
            ERROR_NO_MORE_ITEMS => break,
            error => return Err(io::Error::from_raw_os_error(error as i32)),
        }
        let sid = String::from_utf16(&name[..length as usize]).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "ProfileList key is not UTF-16")
        })?;
        match profile_image_path(&key, &name[..=length as usize]) {
            Ok(path) => entries.push(ProfileEntry { sid, path }),
            // An entry without a path, or one deleted since the enumeration, names no folder.
            Err(error) if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(entries)
}

/// `ProfileImagePath` of one ProfileList subkey, with its `REG_EXPAND_SZ` references expanded.
fn profile_image_path(list: &RegistryKey, subkey: &[u16]) -> io::Result<String> {
    let value = to_wide("ProfileImagePath");
    let mut buffer: Vec<u16> = Vec::new();
    loop {
        let mut bytes = u32::try_from(buffer.len() * 2).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "ProfileImagePath is too large")
        })?;
        // SAFETY: subkey and value are NUL-terminated; buffer is valid for `bytes` bytes, and a null
        // data pointer with zero bytes is the documented sizing call.
        let status = unsafe {
            RegGetValueW(
                list.0,
                subkey.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                null_mut(),
                if buffer.is_empty() {
                    null_mut()
                } else {
                    buffer.as_mut_ptr().cast()
                },
                &mut bytes,
            )
        };
        match status {
            ERROR_SUCCESS if !buffer.is_empty() => {
                let text = &buffer[..(bytes as usize / 2).min(buffer.len())];
                let end = text
                    .iter()
                    .position(|&unit| unit == 0)
                    .unwrap_or(text.len());
                return String::from_utf16(&text[..end]).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "ProfileImagePath is not UTF-16")
                });
            }
            // The expanded value can outgrow the size the previous call reported, so size again.
            ERROR_SUCCESS | ERROR_MORE_DATA => buffer.resize((bytes as usize).div_ceil(2) + 1, 0),
            error => return Err(io::Error::from_raw_os_error(error as i32)),
        }
    }
}

/// Whether this machine maps `sid` to any account. Only "maps to nothing" counts as orphaned: any
/// other lookup failure is returned, because guessing on the side of deletion is not acceptable here.
fn sid_maps_to_account(sid: &str) -> io::Result<bool> {
    let wide = to_wide(sid);
    let mut binary: PSID = null_mut();
    // SAFETY: input is NUL-terminated and output receives LocalAlloc memory.
    if unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut binary) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "profile SID is not valid",
        ));
    }
    let binary = LocalAllocation::new(binary)?;
    let mut name_length = 0;
    let mut domain_length = 0;
    let mut sid_use: SID_NAME_USE = 0;
    // SAFETY: sizing call; the SID is valid and every out-parameter is writable.
    unsafe {
        LookupAccountSidW(
            null(),
            binary.pointer(),
            null_mut(),
            &mut name_length,
            null_mut(),
            &mut domain_length,
            &mut sid_use,
        );
    }
    match unsafe { GetLastError() } {
        ERROR_INSUFFICIENT_BUFFER => Ok(true),
        ERROR_NONE_MAPPED => Ok(false),
        error => Err(io::Error::from_raw_os_error(error as i32)),
    }
}

fn delete_profile(sid: &str) -> io::Result<()> {
    let wide = to_wide(sid);
    // SAFETY: wide is NUL-terminated; null path and computer name select the local profile by SID.
    if unsafe { DeleteProfileW(wide.as_ptr(), null(), null()) } != 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) {
        return Ok(());
    }
    Err(io::Error::new(
        error.kind(),
        format!("could not delete the profile of deleted tier account {sid}: {error}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sid_win32::current_process_sid;

    /// The bootstrap account of the golden owner pinned in `identity_name`'s tests.
    const ACCOUNT: &str = "SCBBZUMXK5U6MIU7VEA4";

    /// Well formed, structurally an account, and deliberately not an account on this machine.
    const UNRESOLVABLE_ACCOUNT_SID: &str = "S-1-5-21-1178594758-1067165089-3282905936-1013";

    #[test]
    fn a_folder_belongs_to_an_account_by_its_name_or_a_windows_suffix_of_it() {
        for folder in [
            ACCOUNT,
            "scbbzumxk5u6miu7vea4",
            "SCBBZUMXK5U6MIU7VEA4.HOST-1",
            "SCBBZUMXK5U6MIU7VEA4.HOST-1.002",
        ] {
            assert!(is_profile_folder_for(folder, ACCOUNT), "{folder}");
        }
        for folder in [
            "SCBBZUMXK5U6MIU7VEA",
            "SCBBZUMXK5U6MIU7VEA4X",
            "SCBFHEC353DKTS3MJ567",
            "XSCBBZUMXK5U6MIU7VEA4",
            "",
            // A multi-byte character straddling the name's length must not panic on slicing.
            "SCBBZUMXK5U6MIU7VEA\u{e9}",
        ] {
            assert!(!is_profile_folder_for(folder, ACCOUNT), "{folder}");
        }
    }

    #[test]
    fn the_folder_name_is_the_last_component_of_the_profile_path() {
        assert_eq!(
            profile_folder_name(r"C:\Users\SCBBZUMXK5U6MIU7VEA4.HOST-1.002"),
            "SCBBZUMXK5U6MIU7VEA4.HOST-1.002"
        );
        assert_eq!(profile_folder_name(r"C:\Users\jian\"), "jian");
        assert_eq!(profile_folder_name("jian"), "jian");
    }

    #[test]
    fn the_profile_list_is_read_with_its_paths_expanded() {
        // LocalSystem has a ProfileList entry on every Windows install, which makes it the positive
        // control for the enumeration: an empty or unreadable list would otherwise make every revoke
        // a silent no-op.
        let entries = profile_entries().expect("ProfileList is readable without elevation");
        let system = entries
            .iter()
            .find(|entry| entry.sid == "S-1-5-18")
            .expect("LocalSystem has a profile entry");
        assert!(
            system
                .path
                .to_ascii_lowercase()
                .ends_with(r"\systemprofile"),
            "{}",
            system.path
        );
        assert!(!system.path.contains('%'), "{}", system.path);
    }

    #[test]
    fn an_owner_profile_is_read_from_the_profile_list() {
        let own = profile_path_for(&current_process_sid().unwrap())
            .unwrap()
            .expect("the running user has a profile");
        let expected = std::env::var("USERPROFILE").expect("USERPROFILE is set");
        assert!(
            own.eq_ignore_ascii_case(expected.trim_end_matches('\\')),
            "{own} vs {expected}"
        );
        assert_eq!(profile_path_for(UNRESOLVABLE_ACCOUNT_SID).unwrap(), None);
    }

    #[test]
    fn only_a_sid_that_maps_to_no_account_counts_as_orphaned() {
        assert!(sid_maps_to_account(&current_process_sid().unwrap()).unwrap());
        assert!(sid_maps_to_account("S-1-5-18").unwrap());
        assert!(!sid_maps_to_account(UNRESOLVABLE_ACCOUNT_SID).unwrap());
    }

    #[test]
    fn a_profile_whose_account_still_exists_is_never_selected() {
        // `systemprofile` matches by folder name, and its SID is LocalSystem's, so the sweep sees a
        // name match and must still leave it alone.
        assert!(
            !orphaned_profiles_named_for("systemprofile")
                .unwrap()
                .contains(&"S-1-5-18".to_owned())
        );
    }

    #[test]
    fn a_name_with_no_profile_is_a_no_op() {
        // Reaches no `DeleteProfileW`, which is why this passes without elevation.
        remove_orphaned_profiles("SCBNOPROFILEEVERNAMED").unwrap();
    }
}
