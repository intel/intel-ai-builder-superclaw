//! Naming and access control for the production launcher-to-tier-runner pipes.
//!
//! # Why the rights are direction-specific
//!
//! There are two pipes because there are two directions, and each pipe grants the tier account exactly
//! the one right that direction needs: read on the control pipe, write on the report pipe. The tier
//! never receives `GENERIC_ALL`, and it never receives the right belonging to the other direction, so a
//! runner cannot write onto the channel it is supposed to be listening on or read the channel it is
//! supposed to be reporting on. A single duplex pipe with full access would have collapsed both of those
//! into one grant, and would also have deadlocked: a pending read on one duplicate handle blocks a write
//! issued on another handle of the same pipe.
//!
//! # Why the ACL is read back
//!
//! Building an SDDL string proves that a string was built. Comparing a decoded read-back DACL against an
//! expected list of `(SID, mask)` pairs proves what the kernel actually stored, which is the only claim
//! worth anything. The expected list is constructed independently of the SDDL text so the two cannot
//! agree by construction.

use crate::process_win32::wide_null;
use crate::sid_win32::{LocalAllocation, canonical_sid, sid_to_string};
use std::ffi::c_void;
use std::io;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
    SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, GetAce,
    GetSecurityDescriptorControl, GetSecurityDescriptorDacl, PSECURITY_DESCRIPTOR,
    SE_DACL_PROTECTED,
};

/// Production pipes get their own namespace prefix, distinct from the test transport's, so a test pipe
/// and a production pipe can never be confused for one another by name.
pub const TIER_PIPE_PREFIX: &str = r"\\.\pipe\SuperClawTierRunner-";

/// `FILE_ALL_ACCESS`, granted to SYSTEM, the local Administrators group and the launching owner. Spelled
/// numerically rather than as SDDL `GA` so the value written and the value compared on read-back are the
/// same number, with no generic-to-specific mapping in between.
pub const FULL_PIPE_RIGHTS: u32 = 0x001F_01FF;

/// `SYNCHRONIZE | FILE_READ_ATTRIBUTES`: the floor NPFS itself imposes on a client open.
///
/// This is not a right the runner asks for or uses. It is what the named pipe file system requires the
/// DACL to grant before `CreateFileW` on the client end will succeed *at all*, independently of the
/// access the client requests: a grant of `FILE_READ_DATA | SYNCHRONIZE` alone is refused with
/// `ERROR_ACCESS_DENIED` even when the client asks for exactly that, and adding `FILE_READ_ATTRIBUTES`
/// is what makes the same open succeed. Both bits are therefore part of the minimum rather than slack,
/// and `tests/tier_pipe.rs` proves that removing either one breaks the open, so a later tidy-up cannot
/// quietly drop them and cannot quietly add anything either.
///
/// Neither bit crosses the direction boundary: `FILE_READ_ATTRIBUTES` permits querying the pipe's
/// attributes, not reading its data, and `PeekNamedPipe` needs `FILE_READ_DATA` it does not have.
const PIPE_OPEN_MINIMUM: u32 = 0x0010_0080;

/// `FILE_READ_DATA` on top of the open floor: everything the runner needs to read the control pipe, and
/// nothing else.
pub const TIER_READ_RIGHTS: u32 = PIPE_OPEN_MINIMUM | 0x0000_0001;

/// `FILE_WRITE_DATA` on top of the open floor: everything the runner needs to write the report pipe, and
/// nothing else.
pub const TIER_WRITE_RIGHTS: u32 = PIPE_OPEN_MINIMUM | 0x0000_0002;

const LOCAL_SYSTEM_SID: &str = "S-1-5-18";
const BUILTIN_ADMINISTRATORS_SID: &str = "S-1-5-32-544";

/// Which one-way pipe this is, named for what the tier account does with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipeRole {
    /// Launcher writes, runner reads. Carries `Start`; closing it is the runner's only other signal.
    Control,
    /// Runner writes, launcher reads. Carries `Started`.
    Report,
    /// Connector runner writes, launcher reads. Carries one authenticated client configuration.
    ConnectorSecret,
    /// Tier bootstrap writes, launcher reads. Carries the one handoff frame (`tier_handoff.rs`).
    Handoff,
}

impl PipeRole {
    pub const fn suffix(self) -> &'static str {
        match self {
            Self::Control => "control",
            Self::Report => "report",
            Self::ConnectorSecret => "connector-secret",
            Self::Handoff => crate::tier_handoff::HANDOFF_PIPE_SUFFIX,
        }
    }

    /// The single right the tier account receives on this pipe.
    pub const fn tier_rights(self) -> u32 {
        match self {
            Self::Control => TIER_READ_RIGHTS,
            Self::Report | Self::ConnectorSecret | Self::Handoff => TIER_WRITE_RIGHTS,
        }
    }
}

/// One decoded access-control entry, in the only terms this module compares: allow or deny, the trustee
/// as canonical SID text, the exact mask, and the inheritance flags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ace {
    pub allow: bool,
    pub sid: String,
    pub mask: u32,
    pub flags: u8,
}

impl Ace {
    fn allow(sid: &str, mask: u32) -> io::Result<Self> {
        Ok(Self {
            allow: true,
            sid: canonical_sid(sid)?,
            mask,
            flags: 0,
        })
    }
}

/// Validates a pipe id and builds one pipe's full name.
///
/// The id is what makes a production pipe name unguessable, so its character set is closed: an id that
/// could contain a path separator or a namespace escape would be an id that could name a different
/// object than the caller meant.
pub fn pipe_name(pipe_id: &str, role: PipeRole) -> io::Result<String> {
    if pipe_id.is_empty()
        || pipe_id.len() > 64
        || !pipe_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "pipe ID must be 1-64 ASCII letters, digits, '-' or '_'",
        ));
    }
    Ok(format!("{TIER_PIPE_PREFIX}{pipe_id}-{}", role.suffix()))
}

/// The SDDL for one pipe: a protected DACL with exactly four allow entries.
///
/// `owner_sid` and `tier_sid` must denote different principals. If they were the same, the two entries
/// would union into full access for the tier and the direction-specific grant would be decoration; that
/// is refused rather than silently accepted.
pub fn pipe_sddl(owner_sid: &str, tier_sid: &str, role: PipeRole) -> io::Result<String> {
    let owner = canonical_sid(owner_sid)?;
    let tier = canonical_sid(tier_sid)?;
    for reserved in [owner.as_str(), LOCAL_SYSTEM_SID, BUILTIN_ADMINISTRATORS_SID] {
        if tier == reserved {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "the tier SID {tier} also appears as a full-access trustee ({reserved}), so the \
                     direction-specific grant would be unioned away"
                ),
            ));
        }
    }
    Ok(format!(
        "D:P(A;;0x{FULL_PIPE_RIGHTS:08x};;;{LOCAL_SYSTEM_SID})\
         (A;;0x{FULL_PIPE_RIGHTS:08x};;;{BUILTIN_ADMINISTRATORS_SID})\
         (A;;0x{FULL_PIPE_RIGHTS:08x};;;{owner})\
         (A;;0x{tier_rights:08x};;;{tier})",
        tier_rights = role.tier_rights()
    ))
}

/// The four entries a correctly created pipe must have, in order, built from the parameters rather than
/// from the SDDL string, so a mistake in the SDDL cannot also produce a matching expectation.
pub fn expected_aces(owner_sid: &str, tier_sid: &str, role: PipeRole) -> io::Result<Vec<Ace>> {
    Ok(vec![
        Ace::allow(LOCAL_SYSTEM_SID, FULL_PIPE_RIGHTS)?,
        Ace::allow(BUILTIN_ADMINISTRATORS_SID, FULL_PIPE_RIGHTS)?,
        Ace::allow(owner_sid, FULL_PIPE_RIGHTS)?,
        Ace::allow(tier_sid, role.tier_rights())?,
    ])
}

/// Reads back a kernel object's DACL and refuses anything but the expected protected, four-entry list.
pub fn verify_pipe_dacl(
    handle: HANDLE,
    owner_sid: &str,
    tier_sid: &str,
    role: PipeRole,
) -> io::Result<()> {
    let (protected, actual) = read_dacl(handle)?;
    if !protected {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the pipe's DACL is not protected, so an inherited entry could widen it",
        ));
    }
    let expected = expected_aces(owner_sid, tier_sid, role)?;
    if actual != expected {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "the {} pipe's DACL read back as {actual:?}, expected {expected:?}",
                role.suffix()
            ),
        ));
    }
    Ok(())
}

/// Whether the DACL is protected, and its entries in stored order.
///
/// Crate-internal: the readback a test needs is `TierPipeServer::dacl`, which supplies a handle it owns.
/// A public function taking a bare `HANDLE` would be a raw pointer an outside caller could get wrong.
pub(crate) fn read_dacl(handle: HANDLE) -> io::Result<(bool, Vec<Ace>)> {
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: The handle is a live kernel object opened with READ_CONTROL, the four unused
    // out-parameters are documented as optional, and the descriptor receives LocalAlloc memory.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
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

    let mut control = 0;
    let mut revision = 0;
    // SAFETY: The descriptor is valid and both outputs are writable.
    if unsafe { GetSecurityDescriptorControl(descriptor.pointer(), &mut control, &mut revision) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    let protected = control & SE_DACL_PROTECTED != 0;

    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl: *mut ACL = null_mut();
    // SAFETY: The descriptor is valid and all three outputs are writable.
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
            "the pipe has no DACL, which grants everyone access",
        ));
    }

    // SAFETY: The DACL pointer is inside the descriptor allocation, which is alive for this scope.
    let count = unsafe { (*dacl).AceCount };
    let mut entries = Vec::with_capacity(count as usize);
    for index in 0..count {
        let mut ace: *mut c_void = null_mut();
        // SAFETY: index is below AceCount and ace receives an interior pointer.
        if unsafe { GetAce(dacl, u32::from(index), &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: GetAce returned a pointer to a well-formed ACE within the DACL.
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        // Only the two ACE types that carry a plain mask and SID are decoded. Anything else - an
        // object ACE, a callback ACE, an audit ACE - has a different layout, and guessing at its
        // trustee would be worse than refusing the pipe.
        if header.AceType > 1 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "the pipe's DACL contains an ACE of type {} this check cannot decode",
                    header.AceType
                ),
            ));
        }
        // SAFETY: Both ACCESS_ALLOWED_ACE and ACCESS_DENIED_ACE begin with the header followed by the
        // mask and then the SID, so this layout is correct for either type.
        let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        // `SidStart` is the first field of a variable-length SID stored inline in the ACE, so its
        // address is the SID's address. Taking it does not read past the field, which is why no unsafe
        // block is needed here even though the pointer is later handed to a Win32 call.
        let sid = std::ptr::addr_of!(allowed.SidStart).cast_mut().cast();
        entries.push(Ace {
            allow: header.AceType == 0,
            sid: sid_to_string(sid)?,
            mask: allowed.Mask,
            flags: header.AceFlags,
        });
    }
    Ok((protected, entries))
}

/// Converts an SDDL string into a security descriptor the caller can hand to `CreateNamedPipeW`.
pub fn security_descriptor_from_sddl(sddl: &str) -> io::Result<LocalAllocation> {
    let wide = wide_null(sddl);
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: Input is NUL-terminated UTF-16 and the output receives LocalAlloc memory.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sid_win32::current_process_sid;

    const OWNER: &str = "S-1-5-21-1-2-3-1001";
    const TIER: &str = "S-1-5-21-1-2-3-2002";

    #[test]
    fn the_two_directions_grant_two_different_single_rights() {
        assert_eq!(PipeRole::Control.tier_rights(), TIER_READ_RIGHTS);
        assert_eq!(PipeRole::Report.tier_rights(), TIER_WRITE_RIGHTS);
        assert_ne!(TIER_READ_RIGHTS, TIER_WRITE_RIGHTS);
        // Neither direction's grant contains the other's data right, and neither is full access.
        assert_eq!(TIER_READ_RIGHTS & 0x0000_0002, 0);
        assert_eq!(TIER_WRITE_RIGHTS & 0x0000_0001, 0);
        for rights in [TIER_READ_RIGHTS, TIER_WRITE_RIGHTS] {
            assert_ne!(rights, FULL_PIPE_RIGHTS);
            assert_eq!(rights & 0x1000_0000, 0, "GENERIC_ALL must never be granted");
            assert_eq!(
                rights & 0x000F_0000,
                0,
                "no standard right beyond SYNCHRONIZE"
            );
            // The whole grant is the NPFS open floor plus exactly one data bit. Stated as an
            // equality so a fourth bit cannot be added without this line changing.
            assert_eq!((rights & !PIPE_OPEN_MINIMUM).count_ones(), 1);
        }
        assert_eq!(TIER_READ_RIGHTS, 0x0010_0081);
        assert_eq!(TIER_WRITE_RIGHTS, 0x0010_0082);
    }

    #[test]
    fn the_sddl_names_four_trustees_and_no_generic_all() {
        let sddl = pipe_sddl(OWNER, TIER, PipeRole::Control).expect("SDDL should build");
        assert_eq!(
            sddl,
            "D:P(A;;0x001f01ff;;;S-1-5-18)(A;;0x001f01ff;;;S-1-5-32-544)\
             (A;;0x001f01ff;;;S-1-5-21-1-2-3-1001)(A;;0x00100081;;;S-1-5-21-1-2-3-2002)"
        );
        assert!(!sddl.contains("GA"));
        assert_eq!(sddl.matches("(A;;").count(), 4);
        assert!(
            pipe_sddl(OWNER, TIER, PipeRole::Report)
                .expect("SDDL should build")
                .ends_with("(A;;0x00100082;;;S-1-5-21-1-2-3-2002)")
        );
    }

    #[test]
    fn a_tier_sid_that_is_already_a_full_access_trustee_is_refused() {
        for collision in [OWNER, "S-1-5-18", "S-1-5-32-544"] {
            assert_eq!(
                pipe_sddl(OWNER, collision, PipeRole::Control)
                    .expect_err("a unioned grant must not be built")
                    .kind(),
                io::ErrorKind::InvalidInput,
                "accepted tier SID {collision}"
            );
        }
        assert!(pipe_sddl(OWNER, TIER, PipeRole::Control).is_ok());
    }

    #[test]
    fn expected_entries_are_canonical_and_ordered() {
        let aces = expected_aces("s-1-5-21-1-2-3-1001", TIER, PipeRole::Report)
            .expect("expectations should build");
        assert_eq!(
            aces.iter().map(|ace| ace.sid.as_str()).collect::<Vec<_>>(),
            ["S-1-5-18", "S-1-5-32-544", OWNER, TIER]
        );
        assert_eq!(
            aces.iter().map(|ace| ace.mask).collect::<Vec<_>>(),
            [
                FULL_PIPE_RIGHTS,
                FULL_PIPE_RIGHTS,
                FULL_PIPE_RIGHTS,
                TIER_WRITE_RIGHTS
            ]
        );
        assert!(aces.iter().all(|ace| ace.allow && ace.flags == 0));
    }

    /// The bootstrap cannot reach this module, so it names and opens the handoff pipe from
    /// `tier_handoff`; these are the two definitions it must agree with.
    #[test]
    fn the_handoff_pipe_is_named_and_granted_as_the_bootstrap_opens_it() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            pipe_name(id, PipeRole::Handoff).expect("a launch id"),
            crate::tier_handoff::handoff_pipe_name(id).expect("a launch id")
        );
        assert_eq!(
            PipeRole::Handoff.tier_rights(),
            crate::tier_handoff::HANDOFF_CLIENT_RIGHTS
        );
        assert!(
            crate::tier_handoff::handoff_pipe_name(id)
                .expect("a launch id")
                .starts_with(TIER_PIPE_PREFIX)
        );
    }

    #[test]
    fn pipe_names_are_role_specific_and_reject_a_hostile_id() {
        assert_eq!(
            pipe_name("abc123", PipeRole::Control).expect("a clean id should be accepted"),
            r"\\.\pipe\SuperClawTierRunner-abc123-control"
        );
        assert_eq!(
            pipe_name("abc123", PipeRole::Report).expect("a clean id should be accepted"),
            r"\\.\pipe\SuperClawTierRunner-abc123-report"
        );
        for hostile in ["", "..\\other", "a/b", "a b", &"x".repeat(65)] {
            assert!(
                pipe_name(hostile, PipeRole::Control).is_err(),
                "accepted {hostile:?}"
            );
        }
    }

    /// The read-back path against a real pipe, so the decoding is exercised rather than only the
    /// expectation.
    ///
    /// It has to be a pipe. An earlier version of this test used an unnamed event, which was convenient
    /// and wrong: the kernel stores an access mask against the object type's own valid-access set, and an
    /// event silently reduced `0x001f01ff` to `0x001f01c3`. A DACL check that passes on the wrong object
    /// type is worse than no check, because it reads as coverage.
    #[test]
    fn a_protected_sddl_dacl_decodes_back_to_the_entries_it_was_built_from() {
        use crate::process_win32::OwnedHandle;
        use std::mem::size_of;
        use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_OUTBOUND,
        };
        use windows_sys::Win32::System::Pipes::{
            CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
            PIPE_WAIT,
        };

        let owner = current_process_sid().expect("this process has a SID");
        let sddl = pipe_sddl(&owner, TIER, PipeRole::Control).expect("SDDL should build");
        let descriptor = security_descriptor_from_sddl(&sddl).expect("SDDL should convert");
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.pointer(),
            bInheritHandle: 0,
        };
        let name = wide_null(
            &pipe_name(
                &crate::random_bytes::random_hex(16).expect("RNG"),
                PipeRole::Control,
            )
            .expect("a random id is a legal id"),
        );
        // SAFETY: The name and the security attributes stay alive across the call.
        let pipe = OwnedHandle::new(unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                4096,
                4096,
                0,
                &attributes,
            )
        })
        .expect("a fresh pipe name should be creatable");

        let (protected, actual) = read_dacl(pipe.raw()).expect("the DACL should read back");
        assert!(protected, "a `D:P` descriptor must read back as protected");
        assert_eq!(
            actual,
            expected_aces(&owner, TIER, PipeRole::Control).expect("expectations should build"),
            "the kernel stored something other than what the SDDL asked for"
        );
    }
}
