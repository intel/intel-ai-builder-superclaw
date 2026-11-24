//! Which objects an ACL plan is allowed to name, decided by the elevated broker rather than by the plan.
//!
//! # The escalation this module exists to close
//!
//! An ACL plan arrives over the provision pipe from an unprivileged owner, and it carries paths. The
//! descriptor it asks for is pinned to the shipped policy elsewhere (`acl_descriptor`), which stops a
//! caller from *inventing* a grant - but a pinned descriptor written onto an object of the caller's
//! choosing is still an escalation. The shipped managed-root descriptor is protected, so it drops every
//! inherited ACE, and it grants `host_user` `WRITE_DAC` and `WRITE_OWNER` outright. Applied to
//! `C:\Windows\System32` it would replace that directory's access control wholesale and leave a standard
//! user able to rewrite what is left. No apply writes an object owner the caller named - see
//! `RootBinding::ownership` - so the escalation is entirely in the DACL, and that is enough.
//!
//! So "which object" has to be a decision this side makes. There are exactly two ways to make it, and
//! both are used, because neither covers the other:
//!
//! - **Derived.** For the two roots that live under `%ProgramData%` the broker computes the path itself
//!   and requires the plan to name exactly that. These are the roots whose whole purpose is to hold state
//!   the owner cannot reach, so they cannot be left to the owner to name. The derivation asks the shell
//!   for the common application data folder rather than reading `%PROGRAMDATA%`, because
//!   `ShellExecuteExW` hands this process the *caller's* environment block; see
//!   `state::program_data_dir`. Their object owner is `Administrators`, not the requester: see
//!   `RootBinding::ownership`.
//! - **Owner-owned.** For everything else - the backend roots under the owner's own local application
//!   data, and workspace roots, which are arbitrary by nature - the object must already exist and its
//!   owner must be the requesting owner. An owner already holds `READ_CONTROL` and `WRITE_DAC` on what it
//!   owns, whatever the DACL says, and `WRITE_DAC` is enough to grant itself the rest, so applying the
//!   shipped descriptor there confers nothing it could not have done itself. The
//!   ownership question is asked of the *apply handle*, not of a path, so there is no window in which the
//!   answer could stop being true.
//!
//! Two alternatives were considered and both are wrong. A uniform "the owner owns the object" rule
//! refuses the legitimately Administrators-owned `%ProgramData%` roots. A "the owner already holds
//! `WRITE_DAC`" rule refuses the first apply onto a root whose descriptor has not been written yet.
//!
//! # Why nothing here creates a directory
//!
//! The owner-owned rule requires the object to exist already. That is not an inconvenience to work
//! around, it is the rule doing its job: an elevated process that creates a directory at a path the
//! caller chose is exercising a capability of its own, and the freshly created directory would be owned
//! by the elevated token rather than by the owner, which would make the ownership question unanswerable
//! at exactly the moment it matters. The unprivileged client creates its own backend roots, as the owner,
//! before it asks for a provision.
//!
//! Objects *inside* an authorized root are different and the broker does create those: a tier subtree or
//! a protected placeholder is named by the shipped descriptor, is a single validated component or
//! relative path below a root that has already been authorized, and is reparse-checked on every
//! component like everything else.

use crate::acl_policy_apply::ObjectOwnership;
use crate::state::program_data_dir;
use std::io;
use std::path::{Path, PathBuf};

/// Every managed root scope a path set carries, in the order the contract lists them.
///
/// Test-only, and it earns its place there: the test that walks it is what makes a scope added to the
/// contract without a binding rule fail here rather than at provision time on a customer's machine.
/// Production never iterates the scopes; it is handed one and asks for its rule.
#[cfg(test)]
pub const MANAGED_ROOT_SCOPES: &[&str] = &[
    "backend_root",
    "payload_container_root",
    "temp_container_root",
    "config_root",
    "data_root",
    "logs_root",
    "payload_root",
    "temp_root",
    "protected_root",
    "isolation_root",
];

/// How the broker decides that one object may be written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootBinding {
    /// The broker computes this path; the plan must name exactly it.
    Derived(PathBuf),
    /// The plan names this path; the object must exist and be owned by the requesting owner.
    OwnerOwned,
}

impl RootBinding {
    /// Which principal owns an object authorized by this rule once the apply is done.
    ///
    /// It belongs beside the binding rather than at the apply, because it is the same question asked one
    /// step further: an object owner holds `WRITE_DAC` implicitly, whatever the DACL says, so the SID in
    /// `O:` is a grant and not a label. On an owner-owned root the requester is already the owner, and that
    /// is what authorized the write, so the apply leaves it alone. On a derived root the requester owning it
    /// would confer everything the descriptor withholds - `isolation_root` grants `host_user` read and no
    /// more, and it holds the identity records and tier credential blobs that grant is drawn around - so
    /// those two roots are written to `Administrators`.
    ///
    /// `%ProgramData%` lets an ordinary user create a subdirectory, so writing that owner is a repair and
    /// not only a default: an owner that gets to a derived root's name first is its creator, and a creator
    /// is an owner until this apply says otherwise.
    pub fn ownership(&self) -> ObjectOwnership {
        match self {
            RootBinding::Derived(_) => ObjectOwnership::OwnedByAdministrators,
            RootBinding::OwnerOwned => ObjectOwnership::OwnedByRequester,
        }
    }
}

/// The binding rule for one managed root scope.
pub fn managed_root_binding(scope: &str, owner_sid: &str) -> io::Result<RootBinding> {
    match scope {
        "isolation_root" => Ok(RootBinding::Derived(
            program_data_dir()?.join("SuperClaw").join("isolation"),
        )),
        "protected_root" => Ok(RootBinding::Derived(
            program_data_dir()?
                .join("SuperClaw")
                .join("protected")
                .join(owner_sid),
        )),
        "config_root"
        | "data_root"
        | "logs_root"
        | "payload_root"
        | "temp_root"
        | "backend_root"
        | "payload_container_root"
        | "temp_container_root" => Ok(RootBinding::OwnerOwned),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{other} is not a managed root scope"),
        )),
    }
}

/// The two `%ProgramData%` roots this build derives, without a scope in hand.
///
/// Test-only, for the same reason as `MANAGED_ROOT_SCOPES`: production is always asking about one scope it
/// was given, and `managed_root_binding` is the only place the rule is applied. This exists so the tests
/// can pin the shape of both derived paths against the path set builder that has to agree with them.
#[cfg(test)]
pub fn derived_program_data_roots(owner_sid: &str) -> io::Result<Vec<(&'static str, PathBuf)>> {
    let mut roots = Vec::new();
    for scope in ["protected_root", "isolation_root"] {
        if let RootBinding::Derived(path) = managed_root_binding(scope, owner_sid)? {
            roots.push((scope, path));
        }
    }
    Ok(roots)
}

/// Whether `path` sits at or below `root`, comparing component by component with ASCII case folded.
///
/// The comparison is the strict one from `managed_root_path`, for the reason given there: an elevated
/// decision must not rest on two names being guessed to mean the same object.
pub fn path_is_within(path: &Path, root: &Path) -> bool {
    let mut components = path.components();
    for expected in root.components() {
        let Some(actual) = components.next() else {
            return false;
        };
        if !actual
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&expected.as_os_str().to_string_lossy())
        {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managed_root_path::same_managed_path;

    #[test]
    fn the_two_program_data_roots_are_derived_and_the_rest_are_owner_owned() {
        let owner = "S-1-5-21-1-2-3-1001";
        let program_data = program_data_dir().expect("the machine has a ProgramData folder");

        assert_eq!(
            managed_root_binding("isolation_root", owner).unwrap(),
            RootBinding::Derived(program_data.join("SuperClaw").join("isolation"))
        );
        assert_eq!(
            managed_root_binding("protected_root", owner).unwrap(),
            RootBinding::Derived(program_data.join("SuperClaw").join("protected").join(owner))
        );
        for scope in [
            "config_root",
            "data_root",
            "logs_root",
            "payload_root",
            "temp_root",
        ] {
            assert_eq!(
                managed_root_binding(scope, owner).unwrap(),
                RootBinding::OwnerOwned,
                "{scope} lives under the owner's own local application data"
            );
        }
        assert!(managed_root_binding("not_a_root", owner).is_err());
    }

    /// The requesting owner must not end up owning either `%ProgramData%` root.
    ///
    /// An object owner holds `WRITE_DAC` implicitly, so an owner-owned `isolation_root` would be an
    /// `isolation_root` the unprivileged owner can re-DACL at will - and the shipped descriptor for that
    /// scope grants `host_user` read and nothing else precisely because it holds the identity records and
    /// tier credential blobs. This pins the rule at the binding, where the apply reads it.
    #[test]
    fn the_program_data_roots_are_owned_by_administrators_and_the_rest_by_the_requester() {
        let owner = "S-1-5-21-1-2-3-1001";
        for scope in ["isolation_root", "protected_root"] {
            assert_eq!(
                managed_root_binding(scope, owner).unwrap().ownership(),
                ObjectOwnership::OwnedByAdministrators,
                "{scope} is derived, so the requester must not become its object owner"
            );
        }
        for scope in [
            "config_root",
            "data_root",
            "logs_root",
            "payload_root",
            "temp_root",
        ] {
            assert_eq!(
                managed_root_binding(scope, owner).unwrap().ownership(),
                ObjectOwnership::OwnedByRequester,
                "{scope} was authorized by the requester already owning it"
            );
        }
    }

    /// The two rules must not collapse into one. A single ownership answer for every scope is exactly the
    /// bug this pair exists to prevent, so the values are required to differ.
    #[test]
    fn the_two_ownership_rules_are_distinct() {
        let owner = "S-1-5-21-1-2-3-1001";
        assert_ne!(
            managed_root_binding("isolation_root", owner)
                .unwrap()
                .ownership(),
            managed_root_binding("data_root", owner)
                .unwrap()
                .ownership(),
        );
    }

    /// Every scope the contract defines must have a rule. A scope that fell through would be a root
    /// nobody decided about, which is the state this module exists to make impossible.
    #[test]
    fn every_contract_managed_root_scope_has_a_binding_rule() {
        for scope in MANAGED_ROOT_SCOPES {
            managed_root_binding(scope, "S-1-5-21-1-2-3-1001")
                .unwrap_or_else(|error| panic!("{scope} has no binding rule: {error}"));
        }
    }

    /// The derived paths must agree with `native_isolation/paths.py`, which is the counterpart that
    /// builds the path set the plan carries. If they ever disagree, provision refuses every real request
    /// while every test that supplies its own paths keeps passing, so the shape is pinned here.
    #[test]
    fn the_derived_program_data_roots_have_the_shape_the_path_set_builder_produces() {
        let owner = "S-1-5-21-1-2-3-1001";
        let roots = derived_program_data_roots(owner).expect("derivable roots");
        let program_data = program_data_dir().expect("a ProgramData folder");
        assert_eq!(roots.len(), 2);
        for (scope, path) in roots {
            assert!(
                path_is_within(&path, &program_data.join("SuperClaw")),
                "{scope} must sit under the product's own ProgramData directory, got {path:?}"
            );
        }
        let protected = &derived_program_data_roots(owner).unwrap()[0].1;
        assert!(
            same_managed_path(
                protected,
                &program_data.join("SuperClaw").join("protected").join(owner)
            ),
            "the protected root is per owner, so its last component is the owner SID"
        );
    }

    #[test]
    fn containment_is_by_component_and_refuses_a_prefix_that_is_not_a_component() {
        let root = Path::new("C:\\ProgramData\\SuperClaw");
        assert!(path_is_within(
            Path::new("C:\\ProgramData\\SuperClaw"),
            root
        ));
        assert!(path_is_within(
            Path::new("c:\\programdata\\superclaw\\isolation"),
            root
        ));
        assert!(
            !path_is_within(Path::new("C:\\ProgramData\\SuperClawEvil"), root),
            "a longer component name is not a child"
        );
        assert!(!path_is_within(Path::new("C:\\ProgramData"), root));
        assert!(!path_is_within(
            Path::new("D:\\ProgramData\\SuperClaw"),
            root
        ));
    }
}
