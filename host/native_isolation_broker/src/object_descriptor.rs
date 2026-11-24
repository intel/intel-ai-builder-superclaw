//! Reading a kernel or window object's security descriptor back and comparing it exactly (#3499).
//!
//! Every DACL the tier hops write or create with is read back from the kernel and compared with what was
//! meant, entry by entry: the owner, the protection bit, and each entry's type, trustee, mask and flags,
//! in order, with nothing extra. A mismatch is a refusal and never a repair, because the code that would
//! repair it is the code whose result just failed to verify.
//!
//! Read-only: this module opens nothing, writes nothing and decides nothing beyond equality. The writers
//! are `launcher/bootstrap_protection.rs`, the flag-gated foreign-object exception in
//! `launcher/session_named_objects.rs`, and `tier_bootstrap/self_protection.rs`; closure tests pin that
//! set in each binary.

use crate::process_win32::wide_null;
use crate::sid_win32::{LocalAllocation, canonical_sid, sid_to_string};
use std::ffi::c_void;
use std::io;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
    SE_KERNEL_OBJECT, SE_WINDOW_OBJECT,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, GetAce,
    GetSecurityDescriptorControl, GetSecurityDescriptorDacl, OWNER_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED,
};

/// One decoded access-control entry: allow or deny, the trustee as canonical SID text, the exact mask,
/// and the inheritance flags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaclEntry {
    pub allow: bool,
    pub sid: String,
    pub mask: u32,
    pub flags: u8,
}

impl DaclEntry {
    /// An allow entry with no inheritance flags, the only kind these objects carry.
    pub fn allow(sid: &str, mask: u32) -> io::Result<Self> {
        Ok(Self {
            allow: true,
            sid: canonical_sid(sid)?,
            mask,
            flags: 0,
        })
    }
}

/// What a descriptor says, in the terms the comparison uses. `owner` is `None` when it was not read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectDescriptor {
    pub owner: Option<String>,
    pub protected: bool,
    pub entries: Vec<DaclEntry>,
}

/// Which `SE_OBJECT_TYPE` the handle denotes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectKind {
    /// Processes, threads and other kernel objects.
    Kernel,
    /// Window stations and desktops.
    Window,
}

/// Reads `handle`'s DACL, and its owner when `with_owner`. The handle needs `READ_CONTROL`.
pub(crate) fn read_descriptor(
    handle: HANDLE,
    kind: ObjectKind,
    with_owner: bool,
) -> io::Result<ObjectDescriptor> {
    let object_type = match kind {
        ObjectKind::Kernel => SE_KERNEL_OBJECT,
        ObjectKind::Window => SE_WINDOW_OBJECT,
    };
    let mut information = DACL_SECURITY_INFORMATION;
    if with_owner {
        information |= OWNER_SECURITY_INFORMATION;
    }
    let mut owner: PSID = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: The handle is live with READ_CONTROL; the unused outputs are documented as optional and the
    // descriptor receives LocalAlloc memory owned below. `owner` points into that descriptor.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            object_type,
            information,
            if with_owner { &mut owner } else { null_mut() },
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let descriptor = LocalAllocation::new(descriptor)?;
    let owner = if with_owner {
        if owner.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the object has no owner",
            ));
        }
        Some(sid_to_string(owner)?)
    } else {
        None
    };
    let mut control = 0;
    let mut revision = 0;
    // SAFETY: The descriptor is valid and both outputs are writable.
    if unsafe { GetSecurityDescriptorControl(descriptor.pointer(), &mut control, &mut revision) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    let acl = dacl_of(&descriptor)?;
    Ok(ObjectDescriptor {
        owner,
        protected: control & SE_DACL_PROTECTED != 0,
        // SAFETY: The ACL lives inside `descriptor`, which is alive for this call.
        entries: unsafe { decode_acl(acl) }?,
    })
}

/// Decodes an ACL's entries in stored order. Only plain allow and deny entries are decoded; any other
/// type is refused rather than guessed at.
///
/// # Safety
///
/// `acl` must point at a well-formed ACL that stays alive for the call.
pub unsafe fn decode_acl(acl: *const ACL) -> io::Result<Vec<DaclEntry>> {
    // SAFETY: The caller guarantees a live ACL.
    let count = unsafe { (*acl).AceCount };
    let mut entries = Vec::with_capacity(usize::from(count));
    for index in 0..count {
        let mut ace: *mut c_void = null_mut();
        // SAFETY: `index` is below AceCount and `ace` receives an interior pointer.
        if unsafe { GetAce(acl, u32::from(index), &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: GetAce returned a pointer to a well-formed ACE within the ACL.
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        if header.AceType > 1 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "the DACL holds an entry of type {} this check cannot decode",
                    header.AceType
                ),
            ));
        }
        // SAFETY: Allow and deny entries share this layout: header, mask, then the SID inline.
        let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        let sid = std::ptr::addr_of!(allowed.SidStart).cast_mut().cast();
        entries.push(DaclEntry {
            allow: header.AceType == 0,
            sid: sid_to_string(sid)?,
            mask: allowed.Mask,
            flags: header.AceFlags,
        });
    }
    Ok(entries)
}

/// Refuses unless `actual` is exactly `expected`, naming `what` and the first difference.
///
/// `expected.owner` of `None` means the owner is not part of the claim and is not compared.
pub fn require_exact(
    what: &str,
    actual: &ObjectDescriptor,
    expected: &ObjectDescriptor,
) -> io::Result<()> {
    let mismatch = |difference: String| {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{what} does not carry the descriptor it must: {difference}"),
        ))
    };
    if let Some(owner) = &expected.owner
        && actual.owner.as_ref() != Some(owner)
    {
        return mismatch(format!("owner {:?}, expected {owner}", actual.owner));
    }
    if actual.protected != expected.protected {
        return mismatch(format!(
            "the DACL is {}protected, expected {}protected",
            if actual.protected { "" } else { "not " },
            if expected.protected { "" } else { "not " }
        ));
    }
    if actual.entries != expected.entries {
        return mismatch(format!(
            "entries {:?}, expected {:?}",
            actual.entries, expected.entries
        ));
    }
    Ok(())
}

/// Converts SDDL into a self-relative descriptor for a creation's `SECURITY_ATTRIBUTES`.
pub fn security_descriptor(sddl: &str) -> io::Result<LocalAllocation> {
    let wide = wide_null(sddl);
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: NUL-terminated input; the output receives LocalAlloc memory owned by the return value.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    LocalAllocation::new(descriptor)
}

/// The DACL inside a descriptor built by `security_descriptor`, for a call that takes an ACL.
pub fn dacl_of(descriptor: &LocalAllocation) -> io::Result<*mut ACL> {
    let (mut present, mut defaulted, mut dacl) = (0, 0, null_mut::<ACL>());
    // SAFETY: The descriptor is live and every output is writable.
    if unsafe {
        GetSecurityDescriptorDacl(
            descriptor.pointer(),
            &mut present,
            &mut dacl,
            &mut defaulted,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if present == 0 || dacl.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the descriptor has no DACL, which grants everyone access",
        ));
    }
    Ok(dacl)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "S-1-5-21-1-2-3-1001";
    const TIER: &str = "S-1-5-21-1-2-3-2002";

    fn expected() -> ObjectDescriptor {
        ObjectDescriptor {
            owner: Some(TIER.to_owned()),
            protected: true,
            entries: vec![
                DaclEntry::allow("S-1-5-18", 0x000F_01FF).expect("SID"),
                DaclEntry::allow(OWNER, 0x0002_0000).expect("SID"),
                DaclEntry::allow(TIER, 0x0002_01FF).expect("SID"),
                DaclEntry::allow("S-1-3-4", 0x0002_0000).expect("SID"),
            ],
        }
    }

    fn refused(actual: ObjectDescriptor) -> String {
        let error = require_exact("the desktop", &actual, &expected())
            .expect_err("a descriptor that differs must be refused");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("the desktop"), "{error}");
        error.to_string()
    }

    #[test]
    fn an_identical_descriptor_is_accepted() {
        assert!(require_exact("the desktop", &expected(), &expected()).is_ok());
        let mut unread_owner = expected();
        unread_owner.owner = None;
        assert!(
            require_exact("the desktop", &expected(), &unread_owner).is_ok(),
            "an owner that is not part of the claim is not compared"
        );
    }

    #[test]
    fn an_extra_entry_is_refused() {
        let mut actual = expected();
        actual
            .entries
            .push(DaclEntry::allow("S-1-1-0", 0x0002_0000).expect("SID"));
        refused(actual);
    }

    #[test]
    fn a_wrong_mask_is_refused() {
        let mut actual = expected();
        actual.entries[2].mask = 0x000F_01FF;
        refused(actual);
    }

    #[test]
    fn a_missing_owner_rights_entry_is_refused() {
        let mut actual = expected();
        actual.entries.pop();
        refused(actual);
    }

    #[test]
    fn an_unprotected_dacl_is_refused() {
        let mut actual = expected();
        actual.protected = false;
        let text = refused(actual);
        assert!(text.contains("protected"), "{text}");
    }

    #[test]
    fn a_different_owner_reordered_entries_flags_or_a_deny_entry_are_refused() {
        let mut owner = expected();
        owner.owner = Some(OWNER.to_owned());
        refused(owner);
        let mut unread = expected();
        unread.owner = None;
        refused(unread);
        let mut reordered = expected();
        reordered.entries.swap(1, 2);
        refused(reordered);
        let mut inherited = expected();
        inherited.entries[1].flags = 0x10;
        refused(inherited);
        let mut deny = expected();
        deny.entries[1].allow = false;
        refused(deny);
    }

    /// A DACL built from SDDL decodes back to the entries it was written as, so the comparison above is
    /// fed by a decoder that reads what was stored.
    #[test]
    fn an_sddl_dacl_decodes_to_its_entries_in_order() {
        let descriptor = security_descriptor(&format!(
            "D:P(A;;0x000f01ff;;;S-1-5-18)(A;;0x00020000;;;{OWNER})(A;;0x000201ff;;;{TIER})\
             (A;;0x00020000;;;S-1-3-4)"
        ))
        .expect("SDDL converts");
        let acl = dacl_of(&descriptor).expect("the descriptor has a DACL");
        // SAFETY: The ACL lives inside `descriptor`, which outlives the call.
        let entries = unsafe { decode_acl(acl) }.expect("the DACL decodes");
        assert_eq!(entries, expected().entries);
    }
}
