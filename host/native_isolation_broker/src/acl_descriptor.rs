//! The shipped ACL policy descriptor, embedded and turned into the DACL an object must carry.
//!
//! # Why the launcher needs this
//!
//! The unelevated launcher has to decide, before it starts anything, whether the managed roots the
//! request binds really carry the descriptor the elevated broker was supposed to apply. It cannot ask
//! the broker: that would be a UAC prompt on every start. It cannot read the broker's own records:
//! they are DACL-protected to SYSTEM + Administrators. And it must not trust the provision marker,
//! which is a hint about whether to prompt and not evidence of anything.
//!
//! What is left is to read the DACL off the object and compare it with the descriptor that shipped in
//! this build. That is what this module supplies: the descriptor is embedded with `include_str!` and
//! pinned by digest, exactly as `launch_catalog.rs` embeds the startup catalog, so the expectation
//! cannot be edited on disk by the account being checked.
//!
//! # The one thing the launcher cannot verify
//!
//! A tier account's SID is minted during provision and recorded under
//! `%ProgramData%\SuperClaw\isolation`, which the owner cannot read. So the launcher knows the *mask*
//! and *inheritance* every tier ACE must have and its *position* in the DACL, but not which SID a
//! tier ACE should name. `managed_root_dacl.rs` therefore requires a tier position to name a SID that
//! is neither a recovery principal nor any broad well-known trustee, and the elevated broker's own
//! byte-exact readback at apply time is what pins the tier SIDs themselves.

use crate::acl_rights::{inheritance_to_ace_flags, rights_to_mask};
use crate::broker_wire::canonical_wire_json;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io;
use std::sync::OnceLock;

const DESCRIPTOR_BUNDLE_JSON: &str =
    include_str!("../../../shared/contracts/generated/data/acl-policy-descriptor.json");

/// Digest of the embedded `descriptor` object, matching `rules.descriptor_digest` in the bundle and
/// `sandbox_policy.acl_descriptors.descriptor_digest()` on the Python side.
pub const SHIPPED_ACL_DESCRIPTOR_DIGEST: &str =
    "6aebf02b7f9c15e366a019292debe332df46745ec0e4a6c1812022d4d87d016f";

/// The principals whose SID the launcher can compute without reading any broker state.
pub const RECOVERY_PRINCIPALS: &[&str] = &["host_user", "local_system", "administrators"];

/// One ACE as the descriptor specifies it, with the right names already folded into a mask and the
/// inheritance word already folded into ACE flags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedAce {
    pub allow: bool,
    pub principal: String,
    pub mask: u32,
    pub flags: u8,
}

impl ExpectedAce {
    /// Whether this ACE names a principal whose SID a caller holding no broker state can resolve.
    pub fn principal_is_recoverable(&self) -> bool {
        RECOVERY_PRINCIPALS.contains(&self.principal.as_str())
    }
}

/// One object's whole required DACL, in descriptor order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedDacl {
    pub protected: bool,
    pub aces: Vec<ExpectedAce>,
}

fn descriptor_bundle() -> io::Result<&'static Value> {
    static BUNDLE: OnceLock<io::Result<Value>> = OnceLock::new();
    match BUNDLE.get_or_init(load_bundle) {
        Ok(value) => Ok(value),
        Err(error) => Err(io::Error::new(error.kind(), error.to_string())),
    }
}

/// Parses the embedded bundle once and refuses it unless the descriptor digests to the pinned value.
///
/// The digest check is not about tampering on disk - the file is compiled in - but about a
/// regenerated contract landing in the tree without the constant above being updated with it. A
/// launcher enforcing an expectation nobody re-derived is worse than one that fails to start.
fn load_bundle() -> io::Result<Value> {
    let bundle: Value = serde_json::from_str(DESCRIPTOR_BUNDLE_JSON)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    let descriptor = bundle.get("descriptor").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "the ACL policy bundle has no descriptor",
        )
    })?;
    let canonical = canonical_wire_json(descriptor).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "the descriptor does not canonicalize",
        )
    })?;
    let computed = hex::encode(Sha256::digest(canonical.as_bytes()));
    if computed != SHIPPED_ACL_DESCRIPTOR_DIGEST {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the embedded ACL policy descriptor does not match SHIPPED_ACL_DESCRIPTOR_DIGEST",
        ));
    }
    Ok(bundle)
}

fn descriptor() -> io::Result<&'static Value> {
    descriptor_bundle()?.get("descriptor").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "the ACL policy bundle has no descriptor",
        )
    })
}

pub fn shipped_policy_version() -> io::Result<u64> {
    descriptor()?
        .get("policy_version")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "the ACL policy descriptor has no policy_version",
            )
        })
}

/// Every tier account principal (`sandbox_tier_*`) an ACE anywhere in the shipped descriptor names.
///
/// This is what a readback must be given a SID for: the set follows the shipped descriptor rather than a
/// list kept beside it, so a tier the descriptor starts to use is required without another edit.
pub fn tier_principals() -> io::Result<BTreeSet<String>> {
    fn collect(value: &Value, found: &mut BTreeSet<String>) {
        match value {
            Value::Object(map) => {
                for (key, item) in map {
                    match item.as_str() {
                        Some(name) if key == "principal" && name.starts_with("sandbox_tier_") => {
                            found.insert(name.to_owned());
                        }
                        _ => collect(item, found),
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| collect(item, found)),
            _ => {}
        }
    }
    let mut found = BTreeSet::new();
    collect(descriptor()?, &mut found);
    Ok(found)
}

/// The DACL the descriptor requires on one managed root, named by its contract scope.
pub fn managed_root_expectation(scope: &str) -> io::Result<ExpectedDacl> {
    expected_dacl(managed_root_policy(scope)?.get("root_dacl"))
}

fn managed_root_policy(scope: &str) -> io::Result<&'static Value> {
    let policies = descriptor()?
        .get("managed_root_policies")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "the ACL policy descriptor has no managed_root_policies",
            )
        })?;
    policies
        .iter()
        .find(|policy| policy.get("managed_root_scope").and_then(Value::as_str) == Some(scope))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{scope} is not a managed root scope in the shipped descriptor"),
            )
        })
}

/// The DACL the descriptor requires on the `tier` subtree of one managed root.
///
/// A tier the descriptor does not declare under this scope is an error rather than an empty result, and
/// that is the point of looking it up here at all: which subtrees exist under a managed root is a
/// property of the shipped policy, not something a plan gets to choose.
pub fn managed_root_tier_expectation(scope: &str, tier: &str) -> io::Result<ExpectedDacl> {
    let subtrees = managed_root_policy(scope)?
        .get("tier_subtree_dacls")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{scope} has no tier_subtree_dacls in the shipped descriptor"),
            )
        })?;
    let subtree = subtrees
        .iter()
        .find(|subtree| subtree.get("tier").and_then(Value::as_str) == Some(tier))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("the shipped descriptor declares no {tier} subtree under {scope}"),
            )
        })?;
    expected_dacl(subtree.get("dacl"))
}

/// The DACL the descriptor requires on one opening below the `tier` subtree of one managed root.
///
/// An opening the descriptor does not declare is an error for the same reason an undeclared tier is: which
/// directories another tier is let into is the shipped policy's decision, not a plan's.
pub fn managed_root_opening_expectation(
    scope: &str,
    tier: &str,
    relative_path: &str,
) -> io::Result<ExpectedDacl> {
    let openings = managed_root_policy(scope)?
        .get("tier_openings")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{scope} has no tier_openings in the shipped descriptor"),
            )
        })?;
    let opening = openings
        .iter()
        .find(|opening| {
            opening.get("tier").and_then(Value::as_str) == Some(tier)
                && opening.get("relative_path").and_then(Value::as_str) == Some(relative_path)
        })
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "the shipped descriptor declares no {tier}/{relative_path} opening under {scope}"
                ),
            )
        })?;
    expected_dacl(opening.get("dacl"))
}

/// The DACL the descriptor requires on a workspace root of one policy class.
pub fn workspace_root_expectation(class: &str) -> io::Result<ExpectedDacl> {
    expected_dacl(workspace_root_policy(class)?.get("root_dacl"))
}

fn workspace_root_policy(class: &str) -> io::Result<&'static Value> {
    let policies = descriptor()?
        .get("workspace_root_policies")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "the ACL policy descriptor has no workspace_root_policies",
            )
        })?;
    policies
        .iter()
        .find(|policy| policy.get("policy_class").and_then(Value::as_str) == Some(class))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{class} is not a workspace policy class in the shipped descriptor"),
            )
        })
}

/// One protected placeholder as the descriptor declares it under a workspace policy class.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedPlaceholder {
    pub relative_path: String,
    pub role: String,
    pub dacl: ExpectedDacl,
}

/// The placeholder the descriptor declares at `relative_path` under a workspace root of `class`.
///
/// Looking the relative path up in the descriptor rather than accepting the one a plan carries is what
/// keeps the *set* of placeholder directories a property of the shipped policy. Otherwise a plan could
/// name any relative path under an authorized root and have a protected descriptor written onto it.
pub fn workspace_placeholder_expectation(
    class: &str,
    relative_path: &str,
) -> io::Result<ExpectedPlaceholder> {
    workspace_placeholder_expectations(class)?
        .into_iter()
        .find(|placeholder| placeholder.relative_path == relative_path)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "the shipped descriptor declares no {relative_path:?} placeholder for {class}"
                ),
            )
        })
}

/// Every protected placeholder the descriptor declares under one workspace policy class.
pub fn workspace_placeholder_expectations(class: &str) -> io::Result<Vec<ExpectedPlaceholder>> {
    let placeholders = workspace_root_policy(class)?
        .get("protected_placeholders")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{class} has no protected_placeholders in the shipped descriptor"),
            )
        })?;
    placeholders
        .iter()
        .map(|placeholder| {
            let field = |name: &str| {
                placeholder
                    .get(name)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!("a descriptor placeholder has no {name}"),
                        )
                    })
            };
            Ok(ExpectedPlaceholder {
                relative_path: field("relative_path")?,
                role: field("placeholder_role")?,
                dacl: expected_dacl(placeholder.get("dacl"))?,
            })
        })
        .collect()
}

/// One profile ancestor and the single ACE the descriptor adds to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileAncestorGrant {
    pub profile_relative_path: String,
    pub ace: ExpectedAce,
}

/// Every profile ancestor grant, parents first, as the descriptor declares them.
pub fn profile_ancestor_grants() -> io::Result<Vec<ProfileAncestorGrant>> {
    let invalid = |message: &str| io::Error::new(io::ErrorKind::InvalidData, message.to_owned());
    descriptor()?
        .get("profile_ancestor_grants")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("the ACL policy descriptor has no profile_ancestor_grants"))?
        .iter()
        .map(|grant| {
            Ok(ProfileAncestorGrant {
                profile_relative_path: grant
                    .get("profile_relative_path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        invalid("a profile ancestor grant has no profile_relative_path")
                    })?
                    .to_owned(),
                ace: expected_ace(
                    grant
                        .get("added_ace")
                        .ok_or_else(|| invalid("a profile ancestor grant has no added_ace"))?,
                )?,
            })
        })
        .collect()
}

/// Folds a plan's `required` object into the same shape a shipped descriptor DACL folds into.
///
/// The two shapes are deliberately the same modulo `owner_sid` and `policy_version`, which is what makes
/// "is this plan the shipped policy" a comparison rather than a translation. Anything the fold cannot
/// make sense of - an unknown right, an unknown inheritance word, an unknown ACE kind - is an error here,
/// so a plan carrying one is refused instead of being partially understood.
pub fn expected_dacl_from_plan(required: &Value) -> io::Result<ExpectedDacl> {
    expected_dacl(Some(required))
}

/// Every DACL the descriptor allows on a workspace root, paired with the policy class it belongs to.
///
/// The launcher is given a path, not a policy class: the class is recorded in the broker's grant
/// store, which the owner cannot read. So the check is "the observed DACL is exactly one of these"
/// rather than "the observed DACL is the one for class X". A drifted DACL still matches none of them,
/// which is what the check is for; the class the owner actually granted is pinned by the broker's own
/// exact readback during provision.
pub fn workspace_root_expectations() -> io::Result<Vec<(String, ExpectedDacl)>> {
    let policies = descriptor()?
        .get("workspace_root_policies")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "the ACL policy descriptor has no workspace_root_policies",
            )
        })?;
    policies
        .iter()
        .map(|policy| {
            let class = policy
                .get("policy_class")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "a workspace root policy has no policy_class",
                    )
                })?
                .to_owned();
            Ok((class, expected_dacl(policy.get("root_dacl"))?))
        })
        .collect()
}

fn expected_dacl(dacl: Option<&Value>) -> io::Result<ExpectedDacl> {
    let dacl = dacl.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "a descriptor policy carries no DACL",
        )
    })?;
    let protected = dacl
        .get("dacl_protected")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "a descriptor DACL has no dacl_protected",
            )
        })?;
    let aces = dacl
        .get("aces")
        .and_then(Value::as_array)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "a descriptor DACL has no aces"))?
        .iter()
        .map(expected_ace)
        .collect::<io::Result<Vec<_>>>()?;
    Ok(ExpectedDacl { protected, aces })
}

fn expected_ace(ace: &Value) -> io::Result<ExpectedAce> {
    let invalid = |message: &str| io::Error::new(io::ErrorKind::InvalidData, message.to_owned());
    let ace_kind = ace
        .get("ace_kind")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("a descriptor ACE has no ace_kind"))?;
    let allow = match ace_kind {
        "allow" => true,
        "deny" => false,
        _ => return Err(invalid("a descriptor ACE has an unknown ace_kind")),
    };
    let principal = ace
        .get("principal")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("a descriptor ACE has no principal"))?
        .to_owned();
    let inheritance = ace
        .get("inheritance")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("a descriptor ACE has no inheritance"))?;
    let flags = inheritance_to_ace_flags(inheritance)
        .ok_or_else(|| invalid("a descriptor ACE has an unknown inheritance"))?;
    let rights = ace
        .get("rights")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("a descriptor ACE has no rights"))?;
    let names: Vec<&str> = rights
        .iter()
        .map(|right| right.as_str().unwrap_or_default())
        .collect();
    let mask = rights_to_mask(names)
        .map_err(|message| io::Error::new(io::ErrorKind::InvalidData, message))?;
    Ok(ExpectedAce {
        allow,
        principal,
        mask,
        flags,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acl_rights::right_to_bit;

    fn bit(name: &str) -> u32 {
        right_to_bit(name).unwrap_or_else(|| panic!("{name} is a descriptor right"))
    }

    #[test]
    fn the_embedded_descriptor_matches_its_pinned_digest() {
        assert_eq!(SHIPPED_ACL_DESCRIPTOR_DIGEST.len(), 64);
        let bundle = descriptor_bundle().expect("the embedded descriptor should load");
        assert_eq!(
            bundle
                .get("rules")
                .and_then(|rules| rules.get("descriptor_digest"))
                .and_then(Value::as_str),
            Some(SHIPPED_ACL_DESCRIPTOR_DIGEST),
            "the bundle's own rules must agree with the constant this crate enforces"
        );
        assert_eq!(shipped_policy_version().expect("a policy version"), 9);
    }

    #[test]
    fn every_managed_root_scope_in_the_snapshot_has_an_expectation() {
        for scope in [
            "config_root",
            "data_root",
            "logs_root",
            "payload_root",
            "temp_root",
            "protected_root",
            "isolation_root",
        ] {
            let expectation =
                managed_root_expectation(scope).unwrap_or_else(|error| panic!("{scope}: {error}"));
            assert!(
                expectation.protected,
                "{scope} must require a protected DACL"
            );
            assert!(!expectation.aces.is_empty(), "{scope} has no ACEs");
        }
        assert!(managed_root_expectation("not_a_root").is_err());
    }

    /// The owner must be able to *read* the DACL of every managed root, or the unelevated drift check
    /// could not run at all. This states that as a property of the shipped contract rather than an
    /// assumption in the launcher.
    #[test]
    fn the_owner_can_read_the_descriptor_it_is_asked_to_verify() {
        for scope in [
            "config_root",
            "data_root",
            "logs_root",
            "payload_root",
            "temp_root",
            "protected_root",
            "isolation_root",
        ] {
            let expectation = managed_root_expectation(scope).expect("an expectation");
            let owner = expectation
                .aces
                .iter()
                .find(|ace| ace.principal == "host_user")
                .unwrap_or_else(|| panic!("{scope} has no host_user ACE"));
            assert!(owner.allow, "{scope} denies the owner");
            assert!(
                owner.mask & bit("READ_CONTROL") != 0,
                "{scope} does not let the owner read its own DACL"
            );
        }
    }

    /// `isolation_root` is the one managed root the owner may read but must not be able to rewrite.
    /// If that ever changed, the unelevated launcher's "READ_CONTROL only" posture would be hiding a
    /// grant that made repair possible, so the asymmetry is asserted rather than assumed.
    #[test]
    fn the_owner_cannot_rewrite_the_descriptor_on_the_isolation_root() {
        let expectation = managed_root_expectation("isolation_root").expect("an expectation");
        let owner = expectation
            .aces
            .iter()
            .find(|ace| ace.principal == "host_user")
            .expect("a host_user ACE");
        assert_eq!(
            owner.mask & bit("WRITE_DAC"),
            0,
            "the owner must not hold WRITE_DAC on the broker's own isolation root"
        );
    }

    #[test]
    fn all_three_workspace_policy_classes_are_offered_as_expectations() {
        let expectations = workspace_root_expectations().expect("workspace expectations");
        let classes: Vec<&str> = expectations
            .iter()
            .map(|(class, _)| class.as_str())
            .collect();
        assert_eq!(
            classes,
            ["managed_default", "user_granted_rw", "user_granted_ro"]
        );
        for (class, expectation) in &expectations {
            assert!(expectation.protected, "{class} must require protection");
            assert!(
                expectation
                    .aces
                    .iter()
                    .any(|ace| ace.principal == "host_user"),
                "{class} has no owner ACE"
            );
        }
    }

    #[test]
    fn runtime_config_compatibility_grants_only_attribute_writes() {
        use windows_sys::Win32::Storage::FileSystem::{
            DELETE, FILE_APPEND_DATA, FILE_DELETE_CHILD, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA,
            FILE_WRITE_EA, WRITE_DAC, WRITE_OWNER,
        };

        let dacl = managed_root_tier_expectation("config_root", "bootstrap")
            .expect("bootstrap config policy");
        let runtime = dacl
            .aces
            .iter()
            .find(|ace| ace.principal == "sandbox_tier_file_tool")
            .expect("file-tool compatibility ACE");
        assert_ne!(runtime.mask & FILE_WRITE_ATTRIBUTES, 0);
        let forbidden = FILE_WRITE_DATA
            | FILE_APPEND_DATA
            | FILE_WRITE_EA
            | FILE_DELETE_CHILD
            | DELETE
            | WRITE_DAC
            | WRITE_OWNER;
        assert_eq!(runtime.mask & forbidden, 0);
    }

    #[test]
    fn profile_ancestors_get_one_non_inheriting_attribute_read_for_file_tool() {
        use windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES;

        let grants = profile_ancestor_grants().expect("the shipped profile ancestor grants");
        let paths: Vec<&str> = grants
            .iter()
            .map(|grant| grant.profile_relative_path.as_str())
            .collect();
        assert_eq!(
            paths,
            ["AppData", "AppData/Local", "AppData/Local/SuperClaw"]
        );
        for grant in &grants {
            assert_eq!(
                grant.ace,
                ExpectedAce {
                    allow: true,
                    principal: "sandbox_tier_file_tool".to_owned(),
                    mask: FILE_READ_ATTRIBUTES,
                    flags: 0,
                }
            );
        }
    }

    #[test]
    fn a_recoverable_principal_is_exactly_one_the_launcher_can_resolve() {
        let expectation = managed_root_expectation("data_root").expect("an expectation");
        for ace in &expectation.aces {
            assert_eq!(
                ace.principal_is_recoverable(),
                !ace.principal.starts_with("sandbox_tier_"),
                "{} is classified wrongly",
                ace.principal
            );
        }
    }
}
