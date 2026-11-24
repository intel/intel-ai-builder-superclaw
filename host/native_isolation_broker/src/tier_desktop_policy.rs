//! The security of every object the tier hops create (#3499, #3400): the tier's private window station
//! and desktop, the bootstrap's process and primary thread, and the two default DACLs.
//!
//! Pure data. The bootstrap creates the station and desktop with these descriptors and nothing else -
//! their security is set at creation and never written afterwards - and the owner reads both back and
//! requires exactly these. Each descriptor exists twice on purpose: as the SDDL a creation is given, and
//! as an `ObjectDescriptor` built from the same parameters but not from the SDDL text, so a mistake in
//! one cannot produce a matching expectation in the other.
//!
//! # Who gets what
//!
//! - **Station.** SYSTEM in full; the owner `READ_CONTROL | WINSTA_READATTRIBUTES`, enough to read it
//!   back; and the tier account `STATION_ACCESS`, every window-station right plus `READ_CONTROL`:
//!   `WINSTA_ENUMDESKTOPS`, `WINSTA_READATTRIBUTES`, `WINSTA_ACCESSCLIPBOARD`, `WINSTA_CREATEDESKTOP`,
//!   `WINSTA_WRITEATTRIBUTES`, `WINSTA_ACCESSGLOBALATOMS`, `WINSTA_EXITWINDOWS`, `WINSTA_ENUMERATE` and
//!   `WINSTA_READSCREEN`. That is the access the bootstrap, which runs as that account, creates the
//!   desktop with, and the supervisor and every role of the same tier hold it too. The owner's
//!   interactive logon SID, which every tier's supervisor and roles hold enabled (#3805), has no entry,
//!   so no other tier can open the station. This DACL does not limit the tier's own processes on it: the
//!   role Job's UI limits are what hold off the clipboard, global atoms and desktop creation, and the
//!   desktop-creation limit (`JOB_OBJECT_UILIMIT_DESKTOP`) applies only from the owner's `SealUiLimits`
//!   on, so a supervisor its own tier resumes early (#3713) can create desktops on the station before
//!   that.
//! - **Desktop.** SYSTEM in full; the owner `READ_CONTROL`; the tier account every desktop-specific right
//!   plus `READ_CONTROL`, because the supervisor's console-free children and role descendants may create
//!   hidden or message windows. Never `DELETE`, `WRITE_DAC` or `WRITE_OWNER`.
//! - **Both** carry `OWNER RIGHTS` `READ_CONTROL`. The tier account owns what its bootstrap creates, and
//!   an owner otherwise holds `WRITE_DAC` implicitly whatever the DACL says (measured: with the entry, a
//!   role's `WRITE_DAC` open and `SetSecurityInfo` fail with 5).
//! - **Bootstrap process and primary thread.** SYSTEM, the bootstrap's own tier account, `OWNER RIGHTS`
//!   `READ_CONTROL`. The tier entry is what lets the bootstrap open and re-protect its own threads, and it
//!   means a process of the same tier can open the bootstrap for its whole life. No other tier can, since
//!   none holds this tier's SID; the owner's interactive logon SID, which every tier's supervisor and
//!   roles hold enabled (#3805), has no entry.
//! - **Default DACLs.** The bootstrap's own token gets the same three trustees, so threads it creates
//!   later are open to its own tier and to no other; the supervisor's restricted token gets the tier
//!   account and SYSTEM, which is what every role object inherits.

use crate::object_descriptor::{DaclEntry, ObjectDescriptor};
use std::io;

pub const LOCAL_SYSTEM_SID: &str = "S-1-5-18";
/// `OWNER RIGHTS`: the entry that replaces an object owner's implicit `READ_CONTROL | WRITE_DAC`.
pub const OWNER_RIGHTS_SID: &str = "S-1-3-4";

pub const READ_CONTROL: u32 = 0x0002_0000;
pub const GENERIC_ALL: u32 = 0x1000_0000;

/// Every window-station right plus `STANDARD_RIGHTS_REQUIRED`.
pub const STATION_SYSTEM_RIGHTS: u32 = 0x000F_037F;
/// `READ_CONTROL | WINSTA_READATTRIBUTES`: the owner reads the station back and nothing more.
pub const STATION_OWNER_RIGHTS: u32 = 0x0002_0002;
/// Every window-station right plus `READ_CONTROL`: what the tier account is granted and what the
/// bootstrap asks for on its station handle. `CreateDesktopW` checks `WINSTA_CREATEDESKTOP` against this
/// entry.
pub const STATION_ACCESS: u32 = 0x0002_037F;

/// Every desktop right plus `STANDARD_RIGHTS_REQUIRED`.
pub const DESKTOP_SYSTEM_RIGHTS: u32 = 0x000F_01FF;
pub const DESKTOP_OWNER_RIGHTS: u32 = READ_CONTROL;
/// Every desktop-specific right plus `READ_CONTROL`: the tier's grant, and what the bootstrap asks for.
pub const DESKTOP_TIER_RIGHTS: u32 = 0x0002_01FF;
pub const DESKTOP_ACCESS: u32 = DESKTOP_TIER_RIGHTS;

/// `PROCESS_ALL_ACCESS` and `THREAD_ALL_ACCESS`, which have the same value.
pub const PROCESS_THREAD_ALL_ACCESS: u32 = 0x001F_FFFF;

/// The per-launch desktop's name prefix; the launch's pipe id follows it.
pub const DESKTOP_NAME_PREFIX: &str = "SuperClawTier-";

/// The trustees a station or desktop names.
pub struct DesktopTrustees<'a> {
    pub owner_sid: &'a str,
    pub tier_sid: &'a str,
}

pub fn station_sddl(trustees: &DesktopTrustees<'_>) -> String {
    format!(
        "D:P(A;;0x{STATION_SYSTEM_RIGHTS:08x};;;{LOCAL_SYSTEM_SID})\
         (A;;0x{STATION_OWNER_RIGHTS:08x};;;{})\
         (A;;0x{STATION_ACCESS:08x};;;{})\
         (A;;0x{READ_CONTROL:08x};;;{OWNER_RIGHTS_SID})",
        trustees.owner_sid, trustees.tier_sid
    )
}

/// The station as it must read back: owned by the tier account that created it.
pub fn station_descriptor(trustees: &DesktopTrustees<'_>) -> io::Result<ObjectDescriptor> {
    Ok(ObjectDescriptor {
        owner: Some(crate::sid_win32::canonical_sid(trustees.tier_sid)?),
        protected: true,
        entries: vec![
            DaclEntry::allow(LOCAL_SYSTEM_SID, STATION_SYSTEM_RIGHTS)?,
            DaclEntry::allow(trustees.owner_sid, STATION_OWNER_RIGHTS)?,
            DaclEntry::allow(trustees.tier_sid, STATION_ACCESS)?,
            DaclEntry::allow(OWNER_RIGHTS_SID, READ_CONTROL)?,
        ],
    })
}

pub fn desktop_sddl(trustees: &DesktopTrustees<'_>) -> String {
    format!(
        "D:P(A;;0x{DESKTOP_SYSTEM_RIGHTS:08x};;;{LOCAL_SYSTEM_SID})\
         (A;;0x{DESKTOP_OWNER_RIGHTS:08x};;;{})\
         (A;;0x{DESKTOP_TIER_RIGHTS:08x};;;{})\
         (A;;0x{READ_CONTROL:08x};;;{OWNER_RIGHTS_SID})",
        trustees.owner_sid, trustees.tier_sid
    )
}

pub fn desktop_descriptor(trustees: &DesktopTrustees<'_>) -> io::Result<ObjectDescriptor> {
    Ok(ObjectDescriptor {
        owner: Some(crate::sid_win32::canonical_sid(trustees.tier_sid)?),
        protected: true,
        entries: vec![
            DaclEntry::allow(LOCAL_SYSTEM_SID, DESKTOP_SYSTEM_RIGHTS)?,
            DaclEntry::allow(trustees.owner_sid, DESKTOP_OWNER_RIGHTS)?,
            DaclEntry::allow(trustees.tier_sid, DESKTOP_TIER_RIGHTS)?,
            DaclEntry::allow(OWNER_RIGHTS_SID, READ_CONTROL)?,
        ],
    })
}

/// The descriptor the owner gives the bootstrap's process and primary thread before resuming it.
pub fn bootstrap_object_sddl(tier_sid: &str) -> String {
    format!(
        "D:P(A;;0x{PROCESS_THREAD_ALL_ACCESS:08x};;;{LOCAL_SYSTEM_SID})\
         (A;;0x{PROCESS_THREAD_ALL_ACCESS:08x};;;{tier_sid})\
         (A;;0x{READ_CONTROL:08x};;;{OWNER_RIGHTS_SID})"
    )
}

/// The same, as it must read back. The object owner is not part of the claim: the owner hop replaces the
/// DACL and leaves the owner the creation gave it.
pub fn bootstrap_object_descriptor(tier_sid: &str) -> io::Result<ObjectDescriptor> {
    Ok(ObjectDescriptor {
        owner: None,
        protected: true,
        entries: vec![
            DaclEntry::allow(LOCAL_SYSTEM_SID, PROCESS_THREAD_ALL_ACCESS)?,
            DaclEntry::allow(tier_sid, PROCESS_THREAD_ALL_ACCESS)?,
            DaclEntry::allow(OWNER_RIGHTS_SID, READ_CONTROL)?,
        ],
    })
}

/// Flagged bootstrap objects grant the enabled owner logon SID instead of the tier SID. The bootstrap
/// needs that grant to open real handles to its own threads for protection; the supervisor and roles
/// carry this SID deny-only and therefore cannot satisfy the allow ACE.
pub fn boundary_bootstrap_object_sddl(owner_logon_sid: &str) -> String {
    format!(
        "D:P(A;;0x{PROCESS_THREAD_ALL_ACCESS:08x};;;{LOCAL_SYSTEM_SID})\
         (A;;0x{PROCESS_THREAD_ALL_ACCESS:08x};;;{owner_logon_sid})\
         (A;;0x{READ_CONTROL:08x};;;{OWNER_RIGHTS_SID})"
    )
}

pub fn boundary_bootstrap_object_descriptor(owner_logon_sid: &str) -> io::Result<ObjectDescriptor> {
    Ok(ObjectDescriptor {
        owner: None,
        protected: true,
        entries: vec![
            DaclEntry::allow(LOCAL_SYSTEM_SID, PROCESS_THREAD_ALL_ACCESS)?,
            DaclEntry::allow(owner_logon_sid, PROCESS_THREAD_ALL_ACCESS)?,
            DaclEntry::allow(OWNER_RIGHTS_SID, READ_CONTROL)?,
        ],
    })
}

/// The supervisor's process and primary thread as they must read back: their DACL is the one the
/// restricted token's default DACL gives every object it creates, unprotected, and they are owned by
/// `owner_sid`, the token's owner - the tier account in production. The owner holds them with full access,
/// which is what `CreateProcessAsUserW` returns and the duplicate keeps. The same grant lets a process of
/// the same tier open, write and resume the suspended supervisor before the owner does (#3713).
pub fn supervisor_object_descriptor(
    owner_sid: &str,
    tier_sid: &str,
) -> io::Result<ObjectDescriptor> {
    Ok(ObjectDescriptor {
        owner: Some(crate::sid_win32::canonical_sid(owner_sid)?),
        protected: false,
        entries: vec![
            DaclEntry::allow(tier_sid, PROCESS_THREAD_ALL_ACCESS)?,
            DaclEntry::allow(LOCAL_SYSTEM_SID, PROCESS_THREAD_ALL_ACCESS)?,
        ],
    })
}

/// The bootstrap token's default DACL, set as its first instruction.
pub fn bootstrap_default_dacl_sddl(tier_sid: &str) -> String {
    format!(
        "D:(A;;0x{GENERIC_ALL:08x};;;{LOCAL_SYSTEM_SID})(A;;0x{GENERIC_ALL:08x};;;{tier_sid})\
         (A;;0x{READ_CONTROL:08x};;;{OWNER_RIGHTS_SID})"
    )
}

pub fn bootstrap_default_dacl(tier_sid: &str) -> io::Result<Vec<DaclEntry>> {
    Ok(vec![
        DaclEntry::allow(LOCAL_SYSTEM_SID, GENERIC_ALL)?,
        DaclEntry::allow(tier_sid, GENERIC_ALL)?,
        DaclEntry::allow(OWNER_RIGHTS_SID, READ_CONTROL)?,
    ])
}

pub fn boundary_bootstrap_default_dacl_sddl(owner_logon_sid: &str) -> String {
    format!(
        "D:(A;;0x{GENERIC_ALL:08x};;;{LOCAL_SYSTEM_SID})\
         (A;;0x{GENERIC_ALL:08x};;;{owner_logon_sid})\
         (A;;0x{READ_CONTROL:08x};;;{OWNER_RIGHTS_SID})"
    )
}

pub fn boundary_bootstrap_default_dacl(owner_logon_sid: &str) -> io::Result<Vec<DaclEntry>> {
    Ok(vec![
        DaclEntry::allow(LOCAL_SYSTEM_SID, GENERIC_ALL)?,
        DaclEntry::allow(owner_logon_sid, GENERIC_ALL)?,
        DaclEntry::allow(OWNER_RIGHTS_SID, READ_CONTROL)?,
    ])
}

/// The supervisor's restricted token's default DACL, which every role object inherits.
pub fn supervisor_default_dacl_sddl(tier_sid: &str) -> String {
    format!("D:(A;;0x{GENERIC_ALL:08x};;;{tier_sid})(A;;0x{GENERIC_ALL:08x};;;{LOCAL_SYSTEM_SID})")
}

pub fn supervisor_default_dacl(tier_sid: &str) -> io::Result<Vec<DaclEntry>> {
    Ok(vec![
        DaclEntry::allow(tier_sid, GENERIC_ALL)?,
        DaclEntry::allow(LOCAL_SYSTEM_SID, GENERIC_ALL)?,
    ])
}

pub fn desktop_name(pipe_id: &str) -> String {
    format!("{DESKTOP_NAME_PREFIX}{pipe_id}")
}

/// The name Windows gives an unnamed window station created in the logon session `luid`.
pub fn station_name(luid_high: i32, luid_low: u32) -> String {
    format!("Service-0x{:x}-{luid_low:x}$", luid_high as u32)
}

/// `station\desktop`, as `lpDesktop` takes it.
pub fn desktop_path(station: &str, desktop: &str) -> String {
    format!("{station}\\{desktop}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "S-1-5-21-1-2-3-1001";
    const TIER: &str = "S-1-5-21-1-2-3-2002";
    const LOGON: &str = "S-1-5-5-0-7270000";

    fn trustees() -> DesktopTrustees<'static> {
        DesktopTrustees {
            owner_sid: OWNER,
            tier_sid: TIER,
        }
    }

    #[test]
    fn the_station_and_desktop_sddl_are_pinned() {
        assert_eq!(
            station_sddl(&trustees()),
            format!(
                "D:P(A;;0x000f037f;;;S-1-5-18)(A;;0x00020002;;;{OWNER})(A;;0x0002037f;;;{TIER})\
                 (A;;0x00020000;;;S-1-3-4)"
            )
        );
        assert_eq!(
            desktop_sddl(&trustees()),
            format!(
                "D:P(A;;0x000f01ff;;;S-1-5-18)(A;;0x00020000;;;{OWNER})(A;;0x000201ff;;;{TIER})\
                 (A;;0x00020000;;;S-1-3-4)"
            )
        );
        assert_eq!(
            bootstrap_object_sddl(TIER),
            format!(
                "D:P(A;;0x001fffff;;;S-1-5-18)(A;;0x001fffff;;;{TIER})(A;;0x00020000;;;S-1-3-4)"
            )
        );
    }

    /// The grants are exactly the ones the module comment names, stated bit by bit so a widened mask
    /// cannot pass as a renamed constant.
    #[test]
    fn the_tier_gets_no_right_beyond_its_grant() {
        assert_eq!(STATION_ACCESS, 0x037F | READ_CONTROL);
        let station = station_descriptor(&trustees()).expect("station");
        assert_eq!(
            station
                .entries
                .iter()
                .map(|entry| (entry.sid.as_str(), entry.mask))
                .collect::<Vec<_>>(),
            [
                (LOCAL_SYSTEM_SID, STATION_SYSTEM_RIGHTS),
                (OWNER, STATION_OWNER_RIGHTS),
                (TIER, STATION_ACCESS),
                (OWNER_RIGHTS_SID, READ_CONTROL),
            ],
            "the tier is the station's one grant beyond SYSTEM and the owner; no logon SID has an entry"
        );
        for forbidden in [0x0001_0000, 0x0004_0000, 0x0008_0000, GENERIC_ALL] {
            assert_eq!(STATION_ACCESS & forbidden, 0, "{forbidden:#x}");
            assert_eq!(DESKTOP_TIER_RIGHTS & forbidden, 0, "{forbidden:#x}");
        }
        assert_eq!(DESKTOP_TIER_RIGHTS, 0x01FF | READ_CONTROL);
        assert_eq!(STATION_OWNER_RIGHTS & !(READ_CONTROL | 0x2), 0);
        assert_eq!(DESKTOP_OWNER_RIGHTS, READ_CONTROL);
    }

    #[test]
    fn every_created_object_carries_owner_rights_read_control_last() {
        for descriptor in [
            station_descriptor(&trustees()).expect("station"),
            desktop_descriptor(&trustees()).expect("desktop"),
            bootstrap_object_descriptor(TIER).expect("bootstrap"),
        ] {
            assert!(descriptor.protected);
            let last = descriptor.entries.last().expect("entries");
            assert_eq!(
                (last.sid.as_str(), last.mask),
                (OWNER_RIGHTS_SID, READ_CONTROL)
            );
            assert!(
                descriptor
                    .entries
                    .iter()
                    .all(|entry| entry.allow && entry.flags == 0)
            );
        }
        let bootstrap = bootstrap_object_descriptor(TIER).expect("bootstrap");
        let default = bootstrap_default_dacl(TIER).expect("dacl");
        for (what, entries) in [
            ("descriptor", &bootstrap.entries),
            ("default DACL", &default),
        ] {
            assert!(
                entries.iter().any(|entry| entry.sid == TIER),
                "the bootstrap's {what} must grant its own tier"
            );
            assert!(
                entries.iter().all(|entry| entry.sid != LOGON),
                "the bootstrap's {what} must have no entry for the logon SID every tier shares"
            );
        }
        assert_eq!(default.last().map(|entry| entry.mask), Some(READ_CONTROL));
        assert!(
            supervisor_default_dacl(TIER)
                .expect("dacl")
                .iter()
                .all(|entry| entry.sid != LOGON)
        );
    }

    #[test]
    fn the_flagged_bootstrap_grants_the_logon_sid_and_not_the_tier() {
        let object = boundary_bootstrap_object_descriptor(LOGON).expect("object");
        let default = boundary_bootstrap_default_dacl(LOGON).expect("default");
        for entries in [&object.entries, &default] {
            assert!(entries.iter().any(|entry| entry.sid == LOGON));
            assert!(entries.iter().all(|entry| entry.sid != TIER));
            assert_eq!(
                entries.last().map(|entry| (entry.sid.as_str(), entry.mask)),
                Some((OWNER_RIGHTS_SID, READ_CONTROL))
            );
        }
        assert_eq!(
            boundary_bootstrap_object_sddl(LOGON),
            format!(
                "D:P(A;;0x001fffff;;;S-1-5-18)(A;;0x001fffff;;;{LOGON})\
                 (A;;0x00020000;;;S-1-3-4)"
            )
        );
    }

    /// The supervisor's objects grant exactly what its default DACL grants, and so never the owner's
    /// logon SID, which it holds enabled.
    #[test]
    fn the_supervisor_s_objects_carry_its_default_dacl_mapped_to_full_access() {
        let descriptor = supervisor_object_descriptor(TIER, TIER).expect("descriptor");
        assert_eq!(descriptor.owner.as_deref(), Some(TIER));
        assert!(!descriptor.protected);
        assert_eq!(
            descriptor
                .entries
                .iter()
                .map(|entry| (entry.sid.as_str(), entry.mask))
                .collect::<Vec<_>>(),
            [
                (TIER, PROCESS_THREAD_ALL_ACCESS),
                (LOCAL_SYSTEM_SID, PROCESS_THREAD_ALL_ACCESS)
            ]
        );
        let default = supervisor_default_dacl(TIER).expect("default");
        assert_eq!(
            descriptor
                .entries
                .iter()
                .map(|entry| &entry.sid)
                .collect::<Vec<_>>(),
            default.iter().map(|entry| &entry.sid).collect::<Vec<_>>()
        );
    }

    #[test]
    fn names_follow_the_launch_and_the_logon_session() {
        assert_eq!(desktop_name("ab12"), "SuperClawTier-ab12");
        assert_eq!(station_name(0, 0x6e_e570), "Service-0x0-6ee570$");
        assert_eq!(station_name(1, 0x3e7), "Service-0x1-3e7$");
        assert_eq!(
            desktop_path("Service-0x0-6ee570$", "SuperClawTier-ab12"),
            r"Service-0x0-6ee570$\SuperClawTier-ab12"
        );
    }
}
