//! Descriptor-shaped ACL plans → SDDL apply and contract observation readback.

use crate::acl_descriptor::{ExpectedDacl, shipped_policy_version};
use crate::acl_rights::{
    ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE, inheritance_from_flags,
    inheritance_to_sddl_flags, mask_to_rights,
};
use crate::identity_windows::{IdentityStatus, IsolationTier, WindowsTierIdentity};
use crate::security_descriptor::{read_security_descriptor_for_handle, sid_to_string};
use crate::security_descriptor_apply::{
    AclApplyOutcome, apply_sddl_security_descriptor_and_verify, file_link_count,
    open_path_for_dacl_apply, open_path_for_dacl_apply_preserving_owner,
    open_path_for_dacl_apply_with_file_attributes,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::ffi::c_void;
use std::io;
use std::path::Path;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACCESS_DENIED_ACE, ACE_HEADER, ACL, GetAce,
};

// The right names, ACE types, inheritance words and recovery SIDs live in `acl_rights` because the
// unelevated launcher has to compute exactly the masks this module applies; see that module's header.
pub use crate::acl_rights::{ADMINISTRATORS_SID, LOCAL_SYSTEM_SID};

#[derive(Debug, Clone)]
pub struct PrincipalResolver {
    owner_sid: String,
    tier_account_sids: HashMap<String, String>,
}

impl PrincipalResolver {
    #[allow(dead_code)]
    pub fn host_only(owner_sid: String) -> Self {
        Self {
            owner_sid,
            tier_account_sids: HashMap::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_tier_sids(owner_sid: &str, tier_sids: &[(&str, &str)]) -> Self {
        Self {
            owner_sid: owner_sid.to_owned(),
            tier_account_sids: tier_sids
                .iter()
                .map(|(tier, sid)| ((*tier).to_owned(), (*sid).to_owned()))
                .collect(),
        }
    }

    pub fn for_owner(owner_sid: &str, state_dir: &Path) -> io::Result<Self> {
        let mut tier_account_sids = HashMap::new();
        for tier in IsolationTier::ALL {
            let identity = WindowsTierIdentity::new(owner_sid, tier, state_dir.to_path_buf())?;
            if let IdentityStatus::Provisioned(provisioned) = identity.status()? {
                tier_account_sids.insert(tier.as_str().to_owned(), provisioned.account_sid);
            }
        }
        Ok(Self {
            owner_sid: owner_sid.to_owned(),
            tier_account_sids,
        })
    }

    pub fn resolve_principal(&self, principal: &str) -> io::Result<String> {
        match principal {
            "host_user" => Ok(self.owner_sid.clone()),
            "local_system" => Ok(LOCAL_SYSTEM_SID.to_owned()),
            "administrators" => Ok(ADMINISTRATORS_SID.to_owned()),
            "sandbox_tier_bootstrap" => self.tier_sid("bootstrap"),
            "sandbox_tier_file_tool" => self.tier_sid("file_tool"),
            "sandbox_tier_network_connector" => self.tier_sid("network_connector"),
            "sandbox_tier_channel" => self.tier_sid("channel"),
            other => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("unknown ACL principal: {other}"),
            )),
        }
    }

    pub fn principal_for_sid(&self, sid: &str) -> Option<&'static str> {
        if sid == self.owner_sid {
            return Some("host_user");
        }
        if sid == LOCAL_SYSTEM_SID {
            return Some("local_system");
        }
        if sid == ADMINISTRATORS_SID {
            return Some("administrators");
        }
        for (tier, account_sid) in &self.tier_account_sids {
            if account_sid == sid {
                return Some(match tier.as_str() {
                    "bootstrap" => "sandbox_tier_bootstrap",
                    "file_tool" => "sandbox_tier_file_tool",
                    "network_connector" => "sandbox_tier_network_connector",
                    "channel" => "sandbox_tier_channel",
                    _ => return None,
                });
            }
        }
        None
    }

    pub fn tier_account_sids(&self) -> Vec<String> {
        let mut values: Vec<_> = self.tier_account_sids.values().cloned().collect();
        values.sort();
        values
    }

    fn tier_sid(&self, tier: &str) -> io::Result<String> {
        self.tier_account_sids.get(tier).cloned().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("tier identity is not provisioned: {tier}"),
            )
        })
    }
}

/// Why one plan entry could not be written.
///
/// Three classes rather than one `io::Error`, because the caller has to be able to tell them apart. A
/// missing object and an object owned by somebody else are decisions about what this side is willing to
/// do; only the third is a failure of an operation that was attempted.
#[derive(Debug)]
pub enum AclWriteFailure {
    /// The object exists, but its owner is not the owner this provision authenticated as.
    ObjectNotOwnedByOwner(Option<String>),
    /// The object does not exist. This side does not create objects at caller-named paths.
    ObjectMissing,
    /// The file has more than one hard link, so its security descriptor is shared with a name this side
    /// did not authorize. Nothing was written.
    MultiplyLinked,
    Io(io::Error),
}

impl From<io::Error> for AclWriteFailure {
    fn from(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::NotFound {
            Self::ObjectMissing
        } else {
            Self::Io(error)
        }
    }
}

/// Which principal owns the object an apply writes, and whether that ownership is a precondition or a
/// thing this side writes.
///
/// The two questions are separate because an object owner holds `WRITE_DAC` implicitly, whatever the DACL
/// says. So the SID in `O:` is a grant of its own, and it cannot simply be "whoever asked".
///
/// # Why no rule writes the requester as an owner
///
/// There are exactly two rules and neither of them writes a requester SID into `O:`, which is what makes
/// the enum this short:
///
/// - An object the caller named is authorized *because* the requester already owns it, so writing that
///   same SID back would confer nothing and change nothing. The apply leaves the owner alone and writes
///   the DACL.
/// - An object this side derived or created is owned by `Administrators`, because the requester must not
///   inherit `WRITE_DAC` on it by owning it.
///
/// Writing a requester SID would also fail on a machine this product supports. `SetSecurityInfo` accepts a
/// new owner only when it is the caller's token user or a token group carrying `SE_GROUP_OWNER`, unless
/// `SeRestorePrivilege` is enabled - and nothing here enables it. When a standard-user owner satisfies UAC
/// with a *different* administrator's credentials, the elevated token's user is that administrator, so
/// `O:<requester>` returns `ERROR_INVALID_OWNER` and the whole provision fails closed. `Administrators` is
/// in that elevated token's groups either way, which is why the rule this side does write always succeeds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectOwnership {
    /// The requesting owner must already own the object - asked of the apply handle - and the apply writes
    /// no owner at all. This is the rule for every object whose existence and ownership are the owner's
    /// evidence that it named its own directory.
    OwnedByRequester,
    /// The apply writes `Administrators`, and requires nothing of the object's current owner because this
    /// side either derived the path or created the object a moment ago. `isolation_root` is why the SID is
    /// `Administrators` rather than the requester: it grants `host_user` read and deliberately not
    /// `WRITE_DAC`, and an owner would hold that right anyway.
    OwnedByAdministrators,
}

impl ObjectOwnership {
    /// The SID this rule writes into `O:`, or `None` when the apply must not write an owner at all.
    fn object_owner_sid(self) -> Option<&'static str> {
        match self {
            Self::OwnedByRequester => None,
            Self::OwnedByAdministrators => Some(ADMINISTRATORS_SID),
        }
    }

    /// Whether the object must already be owned by the requester before anything is written to it.
    fn requires_existing_owner(self) -> bool {
        matches!(self, Self::OwnedByRequester)
    }
}

/// One object's whole write: open once, authorize on the handle, apply the shipped descriptor, read it
/// back, and report what the object carries.
///
/// # Why the handle is opened exactly once
///
/// This used to be three separate opens - one to measure the object, one to apply, one to observe - each
/// resolving the same *name* again. Three resolutions of one name are three chances for the name to mean
/// something different, and the last of them decided what the receipt said. Now the name is resolved
/// once, the handle proves which object it holds (`open_path_for_dacl_apply`), and every later question
/// is asked of that handle.
///
/// # Why `expected` is not the plan's own descriptor
///
/// `expected` comes from the shipped policy descriptor, not from the plan. The caller has already
/// required the plan to agree with it; what is composed into SDDL here is the shipped value either way,
/// so there is no path from a plan's bytes to an ACE. `owner_sid` is the SID this provision
/// authenticated as, not a field of the plan, and `ownership` decides whether the object has to be owned
/// by it already and which owner, if any, is written.
pub fn apply_expected_and_observe(
    path: &Path,
    directory: bool,
    expected: &ExpectedDacl,
    owner_sid: &str,
    ownership: ObjectOwnership,
    resolver: &PrincipalResolver,
) -> Result<(AclApplyOutcome, Value), AclWriteFailure> {
    let handle = match ownership.object_owner_sid() {
        Some(_) => open_path_for_dacl_apply(path, directory)?,
        None => open_path_for_dacl_apply_preserving_owner(path, directory)?,
    };
    if ownership.requires_existing_owner() {
        require_object_owner(handle.raw(), owner_sid)?;
    }
    let sddl = expected_to_sddl(expected, ownership.object_owner_sid(), resolver, directory)
        .map_err(AclWriteFailure::Io)?;
    let outcome = apply_sddl_security_descriptor_and_verify(handle.raw(), &sddl)
        .map_err(AclWriteFailure::Io)?;
    let observation = observe_security_from_handle(handle.raw(), resolver)?;
    Ok((outcome, observation))
}

/// [`apply_expected_and_observe`] for an object a tier process created under its own subtree (#2957),
/// always `Administrators`-owned.
///
/// A file with more than one hard link is refused before any write. Hard links are not reparse points,
/// so the path checks pass them, but every name shares one security descriptor: a link into the subtree
/// from a file outside it would have that outside file rewritten by this elevated apply. Checked on the
/// handle the write would use.
pub fn apply_expected_to_descendant(
    path: &Path,
    directory: bool,
    expected: &ExpectedDacl,
    resolver: &PrincipalResolver,
) -> Result<AclApplyOutcome, AclWriteFailure> {
    let handle = open_path_for_dacl_apply_with_file_attributes(path, directory)?;
    if !directory && file_link_count(handle.raw()).map_err(AclWriteFailure::Io)? > 1 {
        return Err(AclWriteFailure::MultiplyLinked);
    }
    let owner = ObjectOwnership::OwnedByAdministrators.object_owner_sid();
    let sddl =
        expected_to_sddl(expected, owner, resolver, directory).map_err(AclWriteFailure::Io)?;
    apply_sddl_security_descriptor_and_verify(handle.raw(), &sddl).map_err(AclWriteFailure::Io)
}

/// Requires the object behind `handle` to be owned by `owner_sid`.
///
/// Asked of the handle rather than of a path on purpose: an ownership check on a name is only true for as
/// long as the name means the same object, and the whole point of asking is to decide whether to write
/// through this handle.
fn require_object_owner(handle: HANDLE, owner_sid: &str) -> Result<(), AclWriteFailure> {
    let descriptor = read_security_descriptor_for_handle(handle).map_err(AclWriteFailure::Io)?;
    let observed = descriptor.owner_sid_string().map_err(AclWriteFailure::Io)?;
    if observed.as_deref() == Some(owner_sid) {
        Ok(())
    } else {
        Err(AclWriteFailure::ObjectNotOwnedByOwner(observed))
    }
}

/// Composes the SDDL for one shipped descriptor DACL, with or without an `O:` clause.
///
/// Everything in the output comes from either the embedded descriptor or the fixed `Administrators` SID
/// that `ObjectOwnership` selects. The principal names are resolved through `PrincipalResolver`, which
/// accepts a closed set of six words, so a SID cannot be smuggled in as a principal either.
///
/// `object_owner_sid` is deliberately not the resolver's `host_user`, and `None` is not the same as "the
/// requester": an omitted `O:` leaves the object's existing owner alone, which for an owner-owned object is
/// the requester the apply handle was just checked against. See `ObjectOwnership` for why no rule writes
/// that SID.
fn expected_to_sddl(
    expected: &ExpectedDacl,
    object_owner_sid: Option<&str>,
    resolver: &PrincipalResolver,
    directory: bool,
) -> io::Result<String> {
    let mut dacl = if expected.protected {
        "D:P".to_owned()
    } else {
        "D:".to_owned()
    };
    for ace in &expected.aces {
        let inheritance = inheritance_from_flags(ace.flags);
        // An inherit-only ACE grants nothing to the object itself - only to children a file cannot
        // have - so NTFS keeps no record of it on a file and composing one here would never match.
        if !directory && inheritance == "children_only" {
            continue;
        }
        let sid = resolver.resolve_principal(&ace.principal)?;
        let flags = if directory {
            inheritance_to_sddl_flags(inheritance)
        } else {
            // The ACE still grants its rights to the file itself; only the propagation flags are
            // meaningless on an object with no children, and meaningless is what NTFS normalizes them
            // to - away, not retained.
            ""
        };
        let prefix = if ace.allow { "A" } else { "D" };
        let mask = ace.mask;
        dacl.push_str(&format!("({prefix};{flags};{mask:#x};;;{sid})"));
    }
    Ok(match object_owner_sid {
        Some(owner) => format!("O:{owner}{dacl}"),
        None => dacl,
    })
}

/// The C3 observation for whatever object `handle` holds.
///
/// `policy_version` is the shipped one rather than the plan's, for the same reason the DACL is: an
/// observation that quoted the caller's version number would be reporting the caller's claim back to it.
pub fn observe_security_from_handle(
    handle: HANDLE,
    resolver: &PrincipalResolver,
) -> io::Result<Value> {
    let descriptor = read_security_descriptor_for_handle(handle)?;
    let owner_sid = descriptor
        .owner_sid_string()?
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "object has no owner SID"))?;
    let dacl_protected = descriptor.dacl_is_protected()?;
    let aces = aces_from_dacl(descriptor.dacl()?, resolver)?;
    Ok(json!({
        "owner_sid": owner_sid,
        "policy_version": shipped_policy_version()?,
        "dacl_protected": dacl_protected,
        "aces": aces,
    }))
}

fn aces_from_dacl(dacl: *mut ACL, resolver: &PrincipalResolver) -> io::Result<Vec<Value>> {
    if dacl.is_null() {
        return Ok(Vec::new());
    }
    let ace_count = unsafe { (*dacl).AceCount };
    let mut aces = Vec::with_capacity(ace_count as usize);
    for index in 0..ace_count {
        let mut ace_ptr: *mut c_void = null_mut();
        if unsafe { GetAce(dacl, index as u32, &mut ace_ptr) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let header = unsafe { &*(ace_ptr as *const ACE_HEADER) };
        let (ace_kind, mask) = if header.AceType == ACCESS_ALLOWED_ACE_TYPE {
            let allowed = unsafe { &*(ace_ptr as *const ACCESS_ALLOWED_ACE) };
            ("allow", allowed.Mask)
        } else if header.AceType == ACCESS_DENIED_ACE_TYPE {
            let denied = unsafe { &*(ace_ptr as *const ACCESS_DENIED_ACE) };
            ("deny", denied.Mask)
        } else {
            continue;
        };
        let sid_ptr = ace_sid_start(ace_ptr, header.AceType)?;
        let sid = sid_to_string(sid_ptr)?;
        let principal = resolver.principal_for_sid(&sid).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("observed ACE names an unmapped SID: {sid}"),
            )
        })?;
        aces.push(json!({
            "ace_kind": ace_kind,
            "principal": principal,
            "rights": mask_to_rights(mask),
            "inheritance": inheritance_from_flags(header.AceFlags),
        }));
    }
    Ok(aces)
}

fn ace_sid_start(ace_ptr: *mut c_void, ace_type: u8) -> io::Result<*mut c_void> {
    let offset = if ace_type == ACCESS_ALLOWED_ACE_TYPE {
        std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart)
    } else {
        std::mem::offset_of!(ACCESS_DENIED_ACE, SidStart)
    };
    Ok(unsafe { (ace_ptr as *const u8).add(offset) as *mut c_void })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acl_descriptor::managed_root_expectation;
    use crate::acl_rights::right_to_bit;
    use crate::managed_root_dacl::{compare_dacl, read_dacl};
    use crate::managed_root_path::open_managed_root_for_read_control;
    use crate::security_descriptor::unique_temp_path;
    use crate::security_descriptor_apply::{
        AclApplyOutcome, apply_sddl_security_descriptor_and_verify, dacl_writes_on_this_thread,
        open_path_for_dacl_apply,
    };
    use crate::sid_win32::current_process_sid;

    /// Stand-in tier account SIDs, because no tier identity is provisioned in an unelevated test run.
    ///
    /// The launcher's comparison cannot pin these values - they are minted during provision and stored
    /// where the owner cannot read them - so any SID that is neither a recovery principal nor a broad
    /// well-known trustee is as faithful here as a real one, and three distinct values keep a descriptor
    /// that collapsed two tiers into one entry visible.
    const TIER_SIDS: &[(&str, &str)] = &[
        ("bootstrap", "S-1-5-21-1-2-3-7001"),
        ("file_tool", "S-1-5-21-1-2-3-7002"),
        ("network_connector", "S-1-5-21-1-2-3-7003"),
        ("channel", "S-1-5-21-1-2-3-7004"),
    ];

    /// A descriptor names `sandbox_tier_channel`; the apply has to turn it into the channel account's
    /// SID, and a readback has to turn that SID back into the same principal.
    #[test]
    fn the_channel_principal_resolves_to_the_channel_account_and_back() {
        let resolver = resolver_for("S-1-5-21-1-2-3-1001");
        assert_eq!(
            resolver
                .resolve_principal("sandbox_tier_channel")
                .expect("the channel principal resolves"),
            "S-1-5-21-1-2-3-7004"
        );
        assert_eq!(
            resolver.principal_for_sid("S-1-5-21-1-2-3-7004"),
            Some("sandbox_tier_channel")
        );
    }

    fn resolver_for(owner_sid: &str) -> PrincipalResolver {
        PrincipalResolver {
            owner_sid: owner_sid.to_owned(),
            tier_account_sids: TIER_SIDS
                .iter()
                .map(|(tier, sid)| ((*tier).to_owned(), (*sid).to_owned()))
                .collect(),
        }
    }

    /// The apply the elevated broker performs and the readback the unelevated launcher performs agree
    /// on a real directory, and a converged root is written a second time by neither of them.
    ///
    /// The two halves are written against the same shipped descriptor but share no code: this side
    /// composes SDDL and hands it to `SetSecurityInfo`, the other side reads ACEs back through
    /// `GetSecurityInfo` and compares them positionally. Nothing but a test on a real object can catch a
    /// disagreement between them, and a disagreement means either that provision cannot converge or that
    /// every start after it reports drift.
    ///
    /// `payload_root` is the scope used because its `host_user` entry carries `WRITE_DAC`, `WRITE_OWNER`
    /// and `READ_CONTROL`: the account running the test can therefore still open the root after the
    /// protected descriptor is on it, which is what makes the second apply and the cleanup possible
    /// without an administrator token.
    ///
    /// Before the first apply, the fixture grants the owner full control except for an explicit
    /// `WRITE_OWNER` denial. That makes the old overbroad open fail while leaving path validation and
    /// every operation an owner-preserving DACL apply needs available.
    #[test]
    fn the_descriptor_the_broker_applies_is_the_one_the_launcher_accepts() {
        let owner_sid = current_process_sid().expect("this process has a token SID");
        let expected = managed_root_expectation("payload_root").expect("a shipped expectation");
        let resolver = resolver_for(&owner_sid);

        let root = unique_temp_path("policy-apply");
        std::fs::create_dir_all(&root).expect("the root should be creatable");
        let setup_handle =
            open_path_for_dacl_apply(&root, true).expect("the root should be writable");
        let setup_sddl = format!("O:{owner_sid}D:P(D;;WO;;;{owner_sid})(A;;FA;;;{owner_sid})");
        apply_sddl_security_descriptor_and_verify(setup_handle.raw(), &setup_sddl)
            .expect("the fixture must establish requester ownership without WRITE_OWNER");
        drop(setup_handle);

        match open_path_for_dacl_apply(&root, true) {
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {}
            Err(error) => panic!("the overbroad open failed for an unexpected reason: {error}"),
            Ok(_handle) => panic!("the fixture must withhold WRITE_OWNER from the requester"),
        }

        let applied = apply_expected_and_observe(
            &root,
            true,
            &expected,
            &owner_sid,
            ObjectOwnership::OwnedByRequester,
            &resolver,
        );
        let (outcome, observation) = match applied {
            Ok(result) => result,
            Err(error) => {
                std::fs::remove_dir_all(&root).ok();
                panic!(
                    "the shipped descriptor should apply to a directory this account owns: {error:?}"
                );
            }
        };
        assert_eq!(
            outcome,
            AclApplyOutcome::Applied,
            "a freshly created directory does not already carry the managed descriptor"
        );

        // Everything from here on is fallible against a root that now has a protected DACL, so the
        // result is captured and the tree removed before anything is asserted.
        let verdict = (|| {
            let handle = open_managed_root_for_read_control(&root)
                .map_err(|refusal| format!("{}: {}", refusal.code(), refusal.detail()))?;
            let observed = read_dacl(&handle)
                .map_err(|drift| format!("{}: {}", drift.code(), drift.detail()))?;
            compare_dacl(&observed, &expected, &owner_sid)
                .map_err(|drift| format!("{}: {}", drift.code(), drift.detail()))?;

            let writes_before = dacl_writes_on_this_thread();
            let (second, _) = apply_expected_and_observe(
                &root,
                true,
                &expected,
                &owner_sid,
                ObjectOwnership::OwnedByRequester,
                &resolver,
            )
            .map_err(|error| format!("the second apply failed: {error:?}"))?;
            Ok::<_, String>((second, writes_before, dacl_writes_on_this_thread()))
        })();
        std::fs::remove_dir_all(&root).expect("the owner can remove its own provisioned tree");

        let (second, writes_before, writes_after) = verdict.unwrap_or_else(|failure| {
            panic!("the launcher must accept the descriptor the broker just applied: {failure}")
        });
        assert_eq!(
            second,
            AclApplyOutcome::AlreadyConverged,
            "applying the same plan twice must converge rather than rewrite"
        );
        assert_eq!(
            writes_after, writes_before,
            "a converged root must be written zero times, not written again to the same value"
        );
        assert_eq!(
            observation["owner_sid"], owner_sid,
            "the receipt reports the owner the object carries"
        );
        assert_eq!(observation["dacl_protected"], true);
        assert_eq!(
            observation["aces"].as_array().map(Vec::len),
            Some(expected.aces.len()),
            "the readback reports every entry that was applied and no others"
        );
    }

    /// No composed SDDL ever names the requester as an object owner, and a derived root names
    /// `Administrators`.
    ///
    /// This is a composition test rather than a filesystem one, and the binding reason is the owner write
    /// itself rather than where the object lives: `SetSecurityInfo` takes a new owner only from the caller's
    /// own token, so writing `O:Administrators` at all needs a token carrying `Administrators` as a group
    /// owner, which means an elevated one. The object also happens to live under `%ProgramData%`, which no
    /// unelevated run can write either. So the write is proved by the manual elevated acceptance and what is
    /// proved here is which SDDL that branch composes. What it pins is the pair of facts
    /// that make the rule matter: the shipped `isolation_root` DACL withholds `WRITE_DAC` from `host_user`,
    /// and the SDDL this module composes for that scope names `Administrators` in `O:`. Either one alone
    /// proves nothing - a withheld right means nothing if the owner is the requester, because an owner
    /// holds `WRITE_DAC` implicitly.
    ///
    /// The owner-owned half is asserted as an absent `O:` rather than as the requester's SID, which is both
    /// the safe value and the only one `SetSecurityInfo` will take when UAC was satisfied by a different
    /// administrator than the owner.
    #[test]
    fn no_composed_descriptor_makes_the_requester_an_object_owner() {
        let owner_sid = "S-1-5-21-1-2-3-1001";
        let resolver = resolver_for(owner_sid);
        let expected = managed_root_expectation("isolation_root").expect("a shipped expectation");

        let host_user_mask = expected
            .aces
            .iter()
            .find(|ace| ace.principal == "host_user" && ace.allow)
            .map(|ace| ace.mask)
            .expect("the isolation root grants the host user something");
        let write_dac = right_to_bit("WRITE_DAC").expect("WRITE_DAC is a descriptor right");
        assert_eq!(
            host_user_mask & write_dac,
            0,
            "this test is only meaningful while the shipped isolation_root withholds WRITE_DAC"
        );

        let derived = expected_to_sddl(
            &expected,
            ObjectOwnership::OwnedByAdministrators.object_owner_sid(),
            &resolver,
            true,
        )
        .expect("the shipped descriptor composes");
        assert!(
            derived.starts_with(&format!("O:{ADMINISTRATORS_SID}D:P")),
            "a derived root is owned by Administrators, got {derived}"
        );

        let owner_owned = expected_to_sddl(
            &expected,
            ObjectOwnership::OwnedByRequester.object_owner_sid(),
            &resolver,
            true,
        )
        .expect("the shipped descriptor composes");
        assert!(
            owner_owned.starts_with("D:P"),
            "an owner-owned object keeps the owner it was authorized by, so no O: is written: got \
             {owner_owned}"
        );

        for (rule, sddl) in [
            (ObjectOwnership::OwnedByAdministrators, &derived),
            (ObjectOwnership::OwnedByRequester, &owner_owned),
        ] {
            assert!(
                !sddl.contains(&format!("O:{owner_sid}")),
                "an owner holds WRITE_DAC implicitly, so {rule:?} must not name the requester in O:"
            );
        }
    }

    /// An object the requesting owner does not own is not written, and nothing is written before the
    /// question is asked.
    ///
    /// This is the whole owner-owned half of the authorization rule, and it is asked of the apply handle.
    /// The negative case is produced by requesting the provision for a SID other than this process's own,
    /// which is exactly the shape the real refusal has: the object is real, the descriptor is the shipped
    /// one, and the only thing wrong is who is asking.
    #[test]
    fn an_object_the_requesting_owner_does_not_own_is_not_written() {
        let expected = managed_root_expectation("payload_root").expect("a shipped expectation");
        let stranger = "S-1-5-21-9999-9999-9999-9999";
        let resolver = resolver_for(stranger);

        let root = unique_temp_path("policy-owner");
        std::fs::create_dir_all(&root).expect("the root should be creatable");
        let writes_before = dacl_writes_on_this_thread();
        let refusal = apply_expected_and_observe(
            &root,
            true,
            &expected,
            stranger,
            ObjectOwnership::OwnedByRequester,
            &resolver,
        )
        .err();
        let writes_after = dacl_writes_on_this_thread();
        std::fs::remove_dir_all(&root).expect("the directory is untouched and removable");

        match refusal {
            Some(AclWriteFailure::ObjectNotOwnedByOwner(observed)) => assert_ne!(
                observed.as_deref(),
                Some(stranger),
                "the refusal reports the owner the object actually has"
            ),
            other => panic!("a directory this owner does not own must be refused: {other:?}"),
        }
        assert_eq!(
            writes_after, writes_before,
            "the ownership question is asked before anything is written, not after"
        );
    }
}
