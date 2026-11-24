//! Exact DACL readback for a managed root, against the shipped descriptor, with `READ_CONTROL` only.
//!
//! # What "exact" means here
//!
//! The comparison is positional and total: the observed DACL must have the same number of ACEs as the
//! descriptor requires, in the same order, each with the same type, the same access mask and the same
//! inheritance flags. The DACL must be present and protected, and no ACE may be inherited. There is no
//! "at least these rights" anywhere: a superset is drift, because an extra right on a managed root is
//! precisely what an attacker would add.
//!
//! # The single relaxation, and why it is safe
//!
//! A tier account's SID is minted during provision and stored where the owner cannot read it, so an
//! ACE whose descriptor principal is `sandbox_tier_*` is checked for everything except *which* SID it
//! names. To keep that from becoming a hole, such an ACE must name a SID that is neither a recovery
//! principal (which would silently widen the owner's, SYSTEM's or Administrators' grant) nor any broad
//! well-known trustee from the closed list below. So the relaxation admits exactly one thing: a
//! locally-minted account SID this process cannot attribute to a tier.
//!
//! The on-demand readback closes the relaxation: its caller (the Sandbox Manager) resolves the tier
//! SIDs unelevated, by account name, and passes them in (`compare_dacl_with`, `TierSids`). Each tier
//! ACE must then name its own principal's SID (`TierPrincipalMismatch`, or `TierSidUnavailable` if
//! none was supplied), on top of the guards above. Start-time launch checks pass no SIDs.
//!
//! The elevated broker closes that gap from the other side. During provision it resolves the tier SIDs
//! from its own records and performs a byte-exact readback of the descriptor it just applied
//! (`security_descriptor::apply_sddl_security_descriptor_and_verify`), so the tier SIDs are pinned at
//! the moment they are written. This module is the unelevated check that they have not changed since.
//!
//! # Why this cannot repair anything
//!
//! Every entry point takes a handle from `managed_root_path::open_managed_root_for_read_control`,
//! which requests `READ_CONTROL` and nothing else. A `SetSecurityInfo` on such a handle fails with
//! `ERROR_ACCESS_DENIED`, so "the launcher reports drift and never fixes it" is enforced by the access
//! mask rather than by convention.

use crate::acl_descriptor::{ExpectedDacl, managed_root_expectation, workspace_root_expectations};
use crate::acl_rights::{
    ACCESS_ALLOWED_ACE_TYPE, ADMINISTRATORS_SID, INHERITED_ACE_FLAG, LOCAL_SYSTEM_SID,
};
use crate::process_win32::OwnedHandle;
use crate::sid_win32::{LocalAllocation, sid_to_string};
use std::collections::HashMap;
use std::ffi::c_void;
use std::io;
use std::ptr::null_mut;
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, GetAce,
    GetSecurityDescriptorControl, GetSecurityDescriptorDacl, PSECURITY_DESCRIPTOR,
    SE_DACL_PROTECTED,
};

/// Trustees that must never appear on a managed root, in the position the descriptor reserves for a
/// tier account or anywhere else.
///
/// Every one of them names a group the owner is (or could arrange to be) a member of, so an ACE for
/// one is indistinguishable from a grant to the owner's own code running outside a tier. The list is
/// closed on purpose: a check that tried to decide "is this SID broad?" structurally would have to
/// guess, and guessing wrong in the permissive direction is the only failure that matters.
pub const BROAD_TRUSTEE_SIDS: &[&str] = &[
    "S-1-1-0",      // Everyone
    "S-1-2-0",      // LOCAL
    "S-1-2-1",      // CONSOLE LOGON
    "S-1-5-1",      // DIALUP
    "S-1-5-2",      // NETWORK
    "S-1-5-3",      // BATCH
    "S-1-5-4",      // INTERACTIVE
    "S-1-5-6",      // SERVICE
    "S-1-5-7",      // ANONYMOUS LOGON
    "S-1-5-11",     // Authenticated Users
    "S-1-5-12",     // RESTRICTED
    "S-1-5-13",     // TERMINAL SERVER USER
    "S-1-5-14",     // REMOTE INTERACTIVE LOGON
    "S-1-5-15",     // This Organization
    "S-1-5-19",     // LOCAL SERVICE
    "S-1-5-20",     // NETWORK SERVICE
    "S-1-5-113",    // Local account
    "S-1-5-114",    // Local account and member of Administrators group
    "S-1-5-32-545", // Users
    "S-1-5-32-546", // Guests
    "S-1-5-32-547", // Power Users
    "S-1-5-32-555", // Remote Desktop Users
    "S-1-5-32-558", // Performance Monitor Users
    "S-1-5-32-559", // Performance Log Users
];

/// One ACE as it was actually read off the object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedAce {
    pub allow: bool,
    pub sid: String,
    pub mask: u32,
    pub flags: u8,
}

/// One object's DACL as it was actually read off the object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedDacl {
    pub protected: bool,
    pub aces: Vec<ObservedAce>,
}

/// Why an observed DACL is not the one the shipped descriptor requires.
///
/// Each variant carries an index rather than a SID or a path: this is reported through a refusal that
/// is logged, and the locator a caller needs is the placeholder name it already has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaclDrift {
    DaclAbsent,
    DaclNotProtected,
    InheritedAce {
        index: usize,
    },
    UndecodableAce {
        index: usize,
        ace_type: u8,
    },
    AceCountMismatch {
        observed: usize,
        required: usize,
    },
    AceShapeMismatch {
        index: usize,
    },
    RecoveryPrincipalMismatch {
        index: usize,
    },
    TierAceNamesRecoveryPrincipal {
        index: usize,
    },
    TierAceNamesBroadTrustee {
        index: usize,
    },
    /// Only from an exact-SID comparison: the tier ACE names a SID other than its principal's.
    TierPrincipalMismatch {
        index: usize,
    },
    /// Only from an exact-SID comparison: no SID was supplied for the ACE's tier principal.
    TierSidUnavailable {
        index: usize,
    },
    NoWorkspacePolicyClassMatches,
    WorkspacePolicyClassMismatch,
    Unreadable(String),
}

impl DaclDrift {
    pub fn code(&self) -> &'static str {
        match self {
            Self::DaclAbsent => "dacl_absent",
            Self::DaclNotProtected => "dacl_not_protected",
            Self::InheritedAce { .. } => "dacl_inherited_ace",
            Self::UndecodableAce { .. } => "dacl_undecodable_ace",
            Self::AceCountMismatch { .. } => "dacl_ace_count_mismatch",
            Self::AceShapeMismatch { .. } => "dacl_ace_shape_mismatch",
            Self::RecoveryPrincipalMismatch { .. } => "dacl_recovery_principal_mismatch",
            Self::TierAceNamesRecoveryPrincipal { .. } => "dacl_tier_ace_names_recovery_principal",
            Self::TierAceNamesBroadTrustee { .. } => "dacl_tier_ace_names_broad_trustee",
            Self::TierPrincipalMismatch { .. } => "dacl_tier_principal_mismatch",
            Self::TierSidUnavailable { .. } => "dacl_tier_sid_unavailable",
            Self::NoWorkspacePolicyClassMatches => "dacl_no_workspace_policy_class_matches",
            Self::WorkspacePolicyClassMismatch => "workspace_policy_class_mismatch",
            Self::Unreadable(_) => "dacl_unreadable",
        }
    }

    /// Detail that names no SID and no path, only what was wrong and where in the DACL.
    pub fn detail(&self) -> String {
        match self {
            Self::DaclAbsent => "this root has no DACL, which grants everyone access".to_owned(),
            Self::DaclNotProtected => {
                "this root's DACL is not protected, so an inherited entry could widen it".to_owned()
            }
            Self::InheritedAce { index } => {
                format!("ACE {index} arrived by inheritance rather than being applied")
            }
            Self::UndecodableAce { index, ace_type } => {
                format!("ACE {index} has type {ace_type}, which this check cannot decode")
            }
            Self::AceCountMismatch { observed, required } => {
                format!("this root carries {observed} ACEs but the policy requires {required}")
            }
            Self::AceShapeMismatch { index } => {
                format!(
                    "ACE {index} does not have the type, rights and inheritance the policy requires"
                )
            }
            Self::RecoveryPrincipalMismatch { index } => {
                format!("ACE {index} does not name the principal the policy requires")
            }
            Self::TierAceNamesRecoveryPrincipal { index } => {
                format!("ACE {index} should name a tier account but names a recovery principal")
            }
            Self::TierAceNamesBroadTrustee { index } => {
                format!("ACE {index} should name a tier account but names a broad trustee")
            }
            Self::TierPrincipalMismatch { index } => {
                format!("ACE {index} names a tier account other than the one the policy requires")
            }
            Self::TierSidUnavailable { index } => {
                format!("ACE {index} names a tier account whose expected SID was not supplied")
            }
            Self::NoWorkspacePolicyClassMatches => {
                "this workspace root's DACL matches no shipped workspace policy class".to_owned()
            }
            Self::WorkspacePolicyClassMismatch => {
                "this workspace root carries the DACL of a different policy class than the one granted"
                    .to_owned()
            }
            Self::Unreadable(message) => {
                format!("this root's DACL could not be read: {message}")
            }
        }
    }
}

/// Reads a DACL off a handle opened for `READ_CONTROL`.
///
/// Takes the owned wrapper rather than a raw `HANDLE` so the only way to reach this is with a handle
/// some opener produced and still owns - in practice
/// `managed_root_path::open_managed_root_for_read_control`, which has already walked the chain.
///
/// Refuses rather than skips an ACE type it cannot decode: an object ACE, a callback ACE or an audit
/// entry has a different layout, and guessing at its trustee would be worse than failing the check.
pub fn read_dacl(handle: &OwnedHandle) -> Result<ObservedDacl, DaclDrift> {
    read_dacl_with(handle, false)
}

/// `read_dacl`, but an ACE type it cannot decode is left out instead of refused.
///
/// Only for a presence check on an object this side does not own, such as a user-profile folder:
/// there a foreign ACE is not drift, and the ACE being looked for is always an ordinary one.
pub fn read_decodable_dacl(handle: &OwnedHandle) -> Result<ObservedDacl, DaclDrift> {
    read_dacl_with(handle, true)
}

fn read_dacl_with(handle: &OwnedHandle, skip_undecodable: bool) -> Result<ObservedDacl, DaclDrift> {
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: The handle is live and opened with READ_CONTROL, the unused out-parameters are
    // documented as optional, and the descriptor receives LocalAlloc memory.
    let status = unsafe {
        GetSecurityInfo(
            handle.raw(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(unreadable(io::Error::from_raw_os_error(status as i32)));
    }
    let descriptor = LocalAllocation::new(descriptor).map_err(unreadable)?;

    let mut control = 0;
    let mut revision = 0;
    // SAFETY: The descriptor is valid and both outputs are writable.
    if unsafe { GetSecurityDescriptorControl(descriptor.pointer(), &mut control, &mut revision) }
        == 0
    {
        return Err(unreadable(io::Error::last_os_error()));
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
        return Err(unreadable(io::Error::last_os_error()));
    }
    if present == 0 || dacl.is_null() {
        return Err(DaclDrift::DaclAbsent);
    }

    // SAFETY: The DACL pointer is interior to the descriptor allocation, which is alive here.
    let count = unsafe { (*dacl).AceCount };
    let mut aces = Vec::with_capacity(count as usize);
    for index in 0..count {
        let mut ace: *mut c_void = null_mut();
        // SAFETY: index is below AceCount and ace receives an interior pointer.
        if unsafe { GetAce(dacl, u32::from(index), &mut ace) } == 0 {
            return Err(unreadable(io::Error::last_os_error()));
        }
        // SAFETY: GetAce returned a pointer to a well-formed ACE within the DACL.
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        if header.AceType > 1 {
            if skip_undecodable {
                continue;
            }
            return Err(DaclDrift::UndecodableAce {
                index: index as usize,
                ace_type: header.AceType,
            });
        }
        // SAFETY: ACCESS_ALLOWED_ACE and ACCESS_DENIED_ACE share the header/mask/SID layout, so this
        // view is correct for either type.
        let decoded = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        // `SidStart` is the first field of a variable-length SID stored inline, so its address is the
        // SID's address; taking it reads nothing past the field.
        let sid = std::ptr::addr_of!(decoded.SidStart).cast_mut().cast();
        aces.push(ObservedAce {
            allow: header.AceType == ACCESS_ALLOWED_ACE_TYPE,
            sid: sid_to_string(sid).map_err(unreadable)?,
            mask: decoded.Mask,
            flags: header.AceFlags,
        });
    }
    Ok(ObservedDacl { protected, aces })
}

fn unreadable(error: io::Error) -> DaclDrift {
    DaclDrift::Unreadable(error.to_string())
}

/// The SID each tier principal is expected to resolve to, keyed by descriptor principal name
/// (`sandbox_tier_file_tool`, ...). Supplied only by the on-demand readback.
pub type TierSids = HashMap<String, String>;

/// Compares an observed DACL against one required DACL, positionally and totally, with the tier
/// positions relaxed as described in the module docs.
pub fn compare_dacl(
    observed: &ObservedDacl,
    required: &ExpectedDacl,
    owner_sid: &str,
) -> Result<(), DaclDrift> {
    compare_dacl_with(observed, required, owner_sid, None)
}

/// As [`compare_dacl`], and when `tier_sids` is given each tier position must name exactly the SID
/// expected for its principal. A principal without an entry cannot be verified and is drift.
pub fn compare_dacl_with(
    observed: &ObservedDacl,
    required: &ExpectedDacl,
    owner_sid: &str,
    tier_sids: Option<&TierSids>,
) -> Result<(), DaclDrift> {
    if required.protected && !observed.protected {
        return Err(DaclDrift::DaclNotProtected);
    }
    if observed.aces.len() != required.aces.len() {
        return Err(DaclDrift::AceCountMismatch {
            observed: observed.aces.len(),
            required: required.aces.len(),
        });
    }
    for (index, (actual, expected)) in observed.aces.iter().zip(&required.aces).enumerate() {
        if actual.flags & INHERITED_ACE_FLAG != 0 {
            return Err(DaclDrift::InheritedAce { index });
        }
        if actual.allow != expected.allow
            || actual.mask != expected.mask
            || actual.flags != expected.flags
        {
            return Err(DaclDrift::AceShapeMismatch { index });
        }
        match expected.principal.as_str() {
            "host_user" => require_sid(actual, owner_sid, index)?,
            "local_system" => require_sid(actual, LOCAL_SYSTEM_SID, index)?,
            "administrators" => require_sid(actual, ADMINISTRATORS_SID, index)?,
            principal => require_tier_sid(actual, owner_sid, tier_sids, principal, index)?,
        }
    }
    Ok(())
}

fn require_tier_sid(
    actual: &ObservedAce,
    owner_sid: &str,
    tier_sids: Option<&TierSids>,
    principal: &str,
    index: usize,
) -> Result<(), DaclDrift> {
    require_tier_like_sid(actual, owner_sid, index)?;
    match tier_sids.map(|sids| sids.get(principal)) {
        None => Ok(()),
        Some(None) => Err(DaclDrift::TierSidUnavailable { index }),
        Some(Some(expected)) if *expected == actual.sid => Ok(()),
        Some(Some(_)) => Err(DaclDrift::TierPrincipalMismatch { index }),
    }
}

fn require_sid(actual: &ObservedAce, expected: &str, index: usize) -> Result<(), DaclDrift> {
    if actual.sid == expected {
        Ok(())
    } else {
        Err(DaclDrift::RecoveryPrincipalMismatch { index })
    }
}

/// The one position whose SID cannot be verified: it must at least not be a principal that would
/// widen someone the launcher *can* name.
fn require_tier_like_sid(
    actual: &ObservedAce,
    owner_sid: &str,
    index: usize,
) -> Result<(), DaclDrift> {
    if actual.sid == owner_sid || actual.sid == LOCAL_SYSTEM_SID || actual.sid == ADMINISTRATORS_SID
    {
        return Err(DaclDrift::TierAceNamesRecoveryPrincipal { index });
    }
    if BROAD_TRUSTEE_SIDS.contains(&actual.sid.as_str()) {
        return Err(DaclDrift::TierAceNamesBroadTrustee { index });
    }
    Ok(())
}

/// Verifies one managed root's DACL against the scope's shipped policy.
pub fn verify_managed_root_dacl(
    handle: &OwnedHandle,
    scope: &str,
    owner_sid: &str,
) -> Result<(), DaclDrift> {
    verify_managed_root_dacl_with(handle, scope, owner_sid, None)
}

/// As [`verify_managed_root_dacl`], pinning each tier ACE to its exact SID when `tier_sids` is given.
pub fn verify_managed_root_dacl_with(
    handle: &OwnedHandle,
    scope: &str,
    owner_sid: &str,
    tier_sids: Option<&TierSids>,
) -> Result<(), DaclDrift> {
    let required = managed_root_expectation(scope).map_err(unreadable)?;
    compare_dacl_with(&read_dacl(handle)?, &required, owner_sid, tier_sids)
}

/// Verifies a workspace root's DACL against the shipped policy classes, accepting an exact match with
/// any one of them.
pub fn verify_workspace_root_dacl(handle: &OwnedHandle, owner_sid: &str) -> Result<(), DaclDrift> {
    let classes = workspace_root_expectations().map_err(unreadable)?;
    let observed = read_dacl(handle)?;
    // A structural problem is reported as itself rather than as "matched no class": "this root has no
    // DACL at all" and "this root has a DACL for a class you did not grant" are different findings.
    if !observed.protected {
        return Err(DaclDrift::DaclNotProtected);
    }
    for (_, required) in &classes {
        if compare_dacl(&observed, required, owner_sid).is_ok() {
            return Ok(());
        }
    }
    Err(DaclDrift::NoWorkspacePolicyClassMatches)
}

/// Verifies a workspace root's DACL against the one policy class it was granted.
///
/// The class-blind check above cannot tell a read-only root whose tier entry was widened to the
/// read-write pair from a root granted read-write. A caller that knows the class (the isolation report's
/// readback, from the provision record) uses this: a DACL that is exactly another class's is
/// `WorkspacePolicyClassMismatch`, and one that is no class's is reported as the finding it is. The
/// readback also passes the tier SIDs, so a tier ACE naming another tier's account is drift too.
pub fn verify_workspace_root_dacl_for_class(
    handle: &OwnedHandle,
    owner_sid: &str,
    class: &str,
    tier_sids: Option<&TierSids>,
) -> Result<(), DaclDrift> {
    let classes = workspace_root_expectations().map_err(unreadable)?;
    classify_workspace_dacl(&read_dacl(handle)?, &classes, owner_sid, class, tier_sids)
}

fn classify_workspace_dacl(
    observed: &ObservedDacl,
    classes: &[(String, ExpectedDacl)],
    owner_sid: &str,
    class: &str,
    tier_sids: Option<&TierSids>,
) -> Result<(), DaclDrift> {
    if !observed.protected {
        return Err(DaclDrift::DaclNotProtected);
    }
    let Some((_, required)) = classes.iter().find(|(name, _)| name == class) else {
        return Err(DaclDrift::Unreadable(
            "the workspace policy class is not in the shipped descriptor".to_owned(),
        ));
    };
    let own = compare_dacl_with(observed, required, owner_sid, tier_sids);
    if own.is_ok() {
        return Ok(());
    }
    let matches_another = classes.iter().any(|(name, other)| {
        name != class && compare_dacl_with(observed, other, owner_sid, tier_sids).is_ok()
    });
    if matches_another {
        return Err(DaclDrift::WorkspacePolicyClassMismatch);
    }
    own
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acl_descriptor::ExpectedAce;
    use crate::acl_rights::{inheritance_to_ace_flags, rights_to_mask};

    const OWNER: &str = "S-1-5-21-1-2-3-1001";
    const TIER: &str = "S-1-5-21-1-2-3-2002";

    /// Masks and flags are built from the descriptor vocabulary rather than written as hex, so a
    /// fixture cannot accidentally spell a mask that already contains the bit a test then adds.
    fn mask(names: &[&str]) -> u32 {
        rights_to_mask(names.iter().copied()).expect("these are descriptor rights")
    }

    fn flags(inheritance: &str) -> u8 {
        inheritance_to_ace_flags(inheritance).expect("this is a descriptor inheritance word")
    }

    fn owner_mask() -> u32 {
        mask(&["FILE_READ_DATA", "READ_CONTROL", "WRITE_DAC"])
    }

    fn tier_mask() -> u32 {
        mask(&["FILE_READ_DATA", "FILE_WRITE_DATA", "FILE_EXECUTE"])
    }

    fn required() -> ExpectedDacl {
        ExpectedDacl {
            protected: true,
            aces: vec![
                ExpectedAce {
                    allow: true,
                    principal: "host_user".to_owned(),
                    mask: owner_mask(),
                    flags: flags("this_object_and_children"),
                },
                ExpectedAce {
                    allow: true,
                    principal: "sandbox_tier_bootstrap".to_owned(),
                    mask: tier_mask(),
                    flags: flags("this_object_only"),
                },
            ],
        }
    }

    fn observed() -> ObservedDacl {
        ObservedDacl {
            protected: true,
            aces: vec![
                ObservedAce {
                    allow: true,
                    sid: OWNER.to_owned(),
                    mask: owner_mask(),
                    flags: flags("this_object_and_children"),
                },
                ObservedAce {
                    allow: true,
                    sid: TIER.to_owned(),
                    mask: tier_mask(),
                    flags: flags("this_object_only"),
                },
            ],
        }
    }

    #[test]
    fn the_descriptor_the_broker_applied_is_the_one_this_check_accepts() {
        compare_dacl(&observed(), &required(), OWNER).expect("a converged root must pass");
    }

    #[test]
    fn an_unprotected_dacl_is_drift_even_when_every_ace_is_right() {
        let mut drifted = observed();
        drifted.protected = false;
        assert_eq!(
            compare_dacl(&drifted, &required(), OWNER),
            Err(DaclDrift::DaclNotProtected)
        );
    }

    /// A superset is drift. This is the case a "minimum rights" check would pass and the reason the
    /// comparison is exact.
    #[test]
    fn one_extra_right_on_the_owner_ace_is_drift() {
        let mut drifted = observed();
        drifted.aces[0].mask |= mask(&["FILE_WRITE_DATA"]);
        assert_eq!(
            compare_dacl(&drifted, &required(), OWNER),
            Err(DaclDrift::AceShapeMismatch { index: 0 })
        );
    }

    #[test]
    fn an_extra_ace_is_drift_even_if_it_grants_nothing_new() {
        let mut drifted = observed();
        drifted.aces.push(ObservedAce {
            allow: true,
            sid: OWNER.to_owned(),
            mask: 0,
            flags: 0,
        });
        assert_eq!(
            compare_dacl(&drifted, &required(), OWNER),
            Err(DaclDrift::AceCountMismatch {
                observed: 3,
                required: 2,
            })
        );
    }

    #[test]
    fn reordering_two_correct_aces_is_drift() {
        let mut drifted = observed();
        drifted.aces.swap(0, 1);
        assert!(compare_dacl(&drifted, &required(), OWNER).is_err());
    }

    #[test]
    fn an_inherited_ace_is_drift_before_its_contents_are_even_compared() {
        let mut drifted = observed();
        drifted.aces[0].flags |= INHERITED_ACE_FLAG;
        assert_eq!(
            compare_dacl(&drifted, &required(), OWNER),
            Err(DaclDrift::InheritedAce { index: 0 })
        );
    }

    #[test]
    fn a_recovery_ace_naming_the_wrong_principal_is_drift() {
        let mut drifted = observed();
        drifted.aces[0].sid = TIER.to_owned();
        assert_eq!(
            compare_dacl(&drifted, &required(), OWNER),
            Err(DaclDrift::RecoveryPrincipalMismatch { index: 0 })
        );
    }

    /// The relaxation for tier positions must not become a way to grant the owner a second, wider ACE
    /// under a name the launcher cannot resolve.
    #[test]
    fn a_tier_position_may_not_name_a_principal_the_launcher_can_resolve() {
        for (sid, expected) in [
            (OWNER, DaclDrift::TierAceNamesRecoveryPrincipal { index: 1 }),
            (
                LOCAL_SYSTEM_SID,
                DaclDrift::TierAceNamesRecoveryPrincipal { index: 1 },
            ),
            (
                ADMINISTRATORS_SID,
                DaclDrift::TierAceNamesRecoveryPrincipal { index: 1 },
            ),
        ] {
            let mut drifted = observed();
            drifted.aces[1].sid = sid.to_owned();
            assert_eq!(compare_dacl(&drifted, &required(), OWNER), Err(expected));
        }
    }

    #[test]
    fn a_tier_position_may_not_name_a_broad_well_known_group() {
        for sid in BROAD_TRUSTEE_SIDS {
            let mut drifted = observed();
            drifted.aces[1].sid = (*sid).to_owned();
            assert_eq!(
                compare_dacl(&drifted, &required(), OWNER),
                Err(DaclDrift::TierAceNamesBroadTrustee { index: 1 }),
                "{sid} was accepted in a tier position"
            );
        }
    }

    /// Everyone and Authenticated Users are the two grants that would most obviously hand a managed
    /// root back to unconstrained owner code, so they are named explicitly rather than only covered by
    /// the loop above.
    #[test]
    fn the_two_widest_well_known_groups_are_in_the_closed_list() {
        assert!(BROAD_TRUSTEE_SIDS.contains(&"S-1-1-0"));
        assert!(BROAD_TRUSTEE_SIDS.contains(&"S-1-5-11"));
        assert!(
            !BROAD_TRUSTEE_SIDS.contains(&ADMINISTRATORS_SID),
            "Administrators is a recovery principal and is checked by position, not by breadth"
        );
    }

    /// A DACL an elevated apply of `expected` would leave, with the tier positions bound to `TIER`.
    fn observed_from(expected: &ExpectedDacl) -> ObservedDacl {
        ObservedDacl {
            protected: expected.protected,
            aces: expected
                .aces
                .iter()
                .map(|ace| ObservedAce {
                    allow: ace.allow,
                    sid: match ace.principal.as_str() {
                        "host_user" => OWNER.to_owned(),
                        "local_system" => LOCAL_SYSTEM_SID.to_owned(),
                        "administrators" => ADMINISTRATORS_SID.to_owned(),
                        _ => TIER.to_owned(),
                    },
                    mask: ace.mask,
                    flags: ace.flags,
                })
                .collect(),
        }
    }

    /// The class-blind check accepts a read-only root whose tier entry was widened to the read-write
    /// pair; the class-aware one does not.
    #[test]
    fn a_workspace_root_is_compared_only_with_the_class_it_was_granted() {
        let classes = workspace_root_expectations().expect("shipped classes");
        let expected = |name: &str| &classes.iter().find(|(c, _)| c == name).expect(name).1;
        let rw = observed_from(expected("user_granted_rw"));
        let ro = observed_from(expected("user_granted_ro"));

        assert_eq!(
            classify_workspace_dacl(&ro, &classes, OWNER, "user_granted_ro", None),
            Ok(())
        );
        assert_eq!(
            classify_workspace_dacl(&rw, &classes, OWNER, "user_granted_rw", None),
            Ok(())
        );
        for (observed, granted) in [(&rw, "user_granted_ro"), (&ro, "user_granted_rw")] {
            assert_eq!(
                classify_workspace_dacl(observed, &classes, OWNER, granted, None),
                Err(DaclDrift::WorkspacePolicyClassMismatch),
                "a DACL of another class passed as {granted}"
            );
        }
    }

    #[test]
    fn a_class_aware_check_still_reports_structure_and_unknown_classes_as_themselves() {
        let classes = workspace_root_expectations().expect("shipped classes");
        let mut ro = observed_from(
            &classes
                .iter()
                .find(|(c, _)| c == "user_granted_ro")
                .unwrap()
                .1,
        );
        assert!(matches!(
            classify_workspace_dacl(&ro, &classes, OWNER, "made_up", None),
            Err(DaclDrift::Unreadable(_))
        ));
        ro.aces[0].mask ^= mask(&["FILE_WRITE_DATA"]);
        assert_eq!(
            classify_workspace_dacl(&ro, &classes, OWNER, "user_granted_ro", None),
            Err(DaclDrift::AceShapeMismatch { index: 0 })
        );
        ro.protected = false;
        assert_eq!(
            classify_workspace_dacl(&ro, &classes, OWNER, "user_granted_ro", None),
            Err(DaclDrift::DaclNotProtected)
        );
    }

    #[test]
    fn every_drift_class_has_a_distinct_code_and_leaks_no_locator() {
        let drifts = [
            DaclDrift::DaclAbsent,
            DaclDrift::DaclNotProtected,
            DaclDrift::InheritedAce { index: 1 },
            DaclDrift::UndecodableAce {
                index: 2,
                ace_type: 9,
            },
            DaclDrift::AceCountMismatch {
                observed: 4,
                required: 5,
            },
            DaclDrift::AceShapeMismatch { index: 0 },
            DaclDrift::RecoveryPrincipalMismatch { index: 0 },
            DaclDrift::TierAceNamesRecoveryPrincipal { index: 3 },
            DaclDrift::TierAceNamesBroadTrustee { index: 3 },
            DaclDrift::TierPrincipalMismatch { index: 3 },
            DaclDrift::TierSidUnavailable { index: 3 },
            DaclDrift::NoWorkspacePolicyClassMatches,
            DaclDrift::WorkspacePolicyClassMismatch,
        ];
        let mut codes: Vec<&str> = drifts.iter().map(DaclDrift::code).collect();
        let total = codes.len();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), total, "two drift classes share a code");
        for drift in &drifts {
            let detail = drift.detail();
            assert!(!detail.contains("S-1-"), "{} leaks a SID", drift.code());
            assert!(!detail.contains('\\'), "{} leaks a path", drift.code());
        }
    }

    mod readback;
}
