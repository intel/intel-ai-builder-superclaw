//! The start-time check that the roots a request binds still carry the descriptor provision applied.
//!
//! # Why the launcher checks anything at all
//!
//! Provision is elevated and start is not, so between them there is a window in which the owner - or
//! anything running as the owner - can rewrite a managed root's DACL, because the owner holds
//! `WRITE_DAC` on every managed root but the isolation root. If start trusted the provision marker, that
//! rewrite would be invisible: the marker would still say "provisioned" and the tier would be launched
//! into a tree whose access control had been undone.
//!
//! So the marker is not consulted here at all. This module opens each bound root for `READ_CONTROL`,
//! reads the DACL that is on it right now, and compares it exactly with the shipped descriptor
//! (`managed_root_dacl.rs`). The marker's only job is to tell the *client* whether to expect a UAC
//! prompt; it is never authorization evidence, and there is no mode in which a valid marker substitutes
//! for this check.
//!
//! # What this check does not compare, and why
//!
//! Ownership matters as much as the DACL, because an object owner holds `WRITE_DAC` implicitly: a root
//! carrying the exact shipped DACL while owned by a principal that should not have it is a root that
//! principal can rewrite the moment this check has passed. This module nevertheless compares only the DACL.
//!
//! The reason is that the invariant is established where it is enforceable, by `acl_authorized_root`'s two
//! rules (see `RootBinding::ownership`). A root the owner named is authorized *because* the authenticated
//! owner already owns it, asked of the apply handle (`acl_policy_apply::require_object_owner`); the two
//! `%ProgramData%` roots this side derives are written to `Administrators`, which is why `isolation_root`
//! does not become owner-writable. After that, the applied DACL is protected and grants `WRITE_OWNER` to
//! nobody outside that set, and Windows will not let a standard token hand its ownership to a third
//! principal it does not carry as a group. A start-time owner comparison would add depth against the owner,
//! `LOCAL_SYSTEM` or `Administrators` changing an owner behind provision's back, and nothing else.
//!
//! The unelevated loopback tests cannot add a start-time owner comparison without an exemption: the only
//! SID they can make an object's owner is their own token user, which is already the runner SID, while
//! the pipe ACL correctly refuses to let owner and tier be the same principal. Production's P4 path does
//! use a distinct tier account, but keeping the same unconditional check in both paths is more valuable
//! than adding an owner check exercised only by elevated acceptance.
//!
//! # Why it cannot repair
//!
//! Every open goes through `managed_root_path::open_managed_root_for_read_control`, which requests
//! `READ_CONTROL` and nothing else, and this binary contains no `SetSecurityInfo` call site at all
//! (`launcher_main.rs` excludes `security_descriptor_apply.rs`; `tests/launcher_closure.rs` enforces it). A
//! drifted root is therefore reported as a typed `provision_required` refusal and left exactly as it
//! was found. Repair is the elevated broker's job, reached through provision, with a UAC decision the
//! user makes.
//!
//! # Why every root is reported, not just the first
//!
//! A client that provisions and retries once needs to know the retry has a chance of succeeding. One
//! finding at a time would turn a tree with three drifted roots into three prompts, so the whole set is
//! collected and reported together.

use super::refusal::{RefusalContext, TierLaunchRefusal, TierLaunchRefusalReason, refuse};
use crate::acl_descriptor::SHIPPED_ACL_DESCRIPTOR_DIGEST;
use crate::broker_wire::BrokerPathPlaceholder;
use crate::identity_name::account_name_for;
use crate::launch_catalog::placeholder_label;
use crate::managed_root_dacl::{
    TierSids, verify_managed_root_dacl_with, verify_workspace_root_dacl,
    verify_workspace_root_dacl_for_class,
};
use crate::managed_root_path::open_managed_root_for_read_control;
use crate::sid_win32::local_user_account_sid;
use crate::tier::IsolationTier;
use std::collections::HashMap;
use std::io;
use std::path::Path;

/// The placeholders whose DACL is checked before anything is launched, in the order they are reported.
///
/// Every path placeholder the catalog can bind is here. A managed root that was worth applying a
/// descriptor to is worth verifying, and a fixed order makes the refusal deterministic rather than
/// dependent on how the bindings happened to hash.
const CHECKED_PLACEHOLDERS: &[BrokerPathPlaceholder] = &[
    BrokerPathPlaceholder::WorkspaceRoot,
    BrokerPathPlaceholder::PayloadRoot,
    BrokerPathPlaceholder::StateConfigRoot,
    BrokerPathPlaceholder::StateDataRoot,
    BrokerPathPlaceholder::StateLogsRoot,
    BrokerPathPlaceholder::StateTempRoot,
    BrokerPathPlaceholder::StateProtectedRoot,
    BrokerPathPlaceholder::IsolationRoot,
];

/// One root that is not in the state provision leaves it in.
///
/// Carries the placeholder name and a reason code, never the path: this is written to stdout and read
/// by a client that already knows which path it bound to which placeholder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootDrift {
    pub placeholder: &'static str,
    pub reason: &'static str,
    pub detail: String,
}

/// The managed-root scope in the shipped descriptor that a path placeholder names.
///
/// `WorkspaceRoot` has no single scope: its DACL depends on the policy class the owner granted, which
/// is recorded in broker state this process cannot read, so it is checked against every class instead.
fn managed_scope(placeholder: &BrokerPathPlaceholder) -> Option<&'static str> {
    match placeholder {
        BrokerPathPlaceholder::WorkspaceRoot => None,
        BrokerPathPlaceholder::PayloadRoot => Some("payload_root"),
        BrokerPathPlaceholder::StateConfigRoot => Some("config_root"),
        BrokerPathPlaceholder::StateDataRoot => Some("data_root"),
        BrokerPathPlaceholder::StateLogsRoot => Some("logs_root"),
        BrokerPathPlaceholder::StateTempRoot => Some("temp_root"),
        BrokerPathPlaceholder::StateProtectedRoot => Some("protected_root"),
        BrokerPathPlaceholder::IsolationRoot => Some("isolation_root"),
    }
}

/// Checks one root and returns what is wrong with it, if anything.
fn verify_root(
    placeholder: &BrokerPathPlaceholder,
    path: &Path,
    owner_sid: &str,
    tier_sids: Option<&TierSids>,
) -> Option<RootDrift> {
    let label = placeholder_label(placeholder);
    // The chain walk happens here, inside the open: a junction anywhere above the root means the DACL
    // that would be read belongs to an object the owner chose, so it is refused before it is read.
    let handle = match open_managed_root_for_read_control(path) {
        Ok(handle) => handle,
        Err(refusal) => {
            return Some(RootDrift {
                placeholder: label,
                reason: refusal.code(),
                detail: refusal.detail(),
            });
        }
    };
    let outcome = match managed_scope(placeholder) {
        Some(scope) => verify_managed_root_dacl_with(&handle, scope, owner_sid, tier_sids),
        None => verify_workspace_root_dacl(&handle, owner_sid),
    };
    outcome.err().map(|drift| RootDrift {
        placeholder: label,
        reason: drift.code(),
        detail: drift.detail(),
    })
}

/// Checks one workspace root against the policy class it was granted, for the on-demand readback.
///
/// Start-time launch keeps the class-blind `verify_request_roots`, because the launcher is not told a
/// class there. The readback is, and compares only against that class, and it also pins each tier ACE
/// to its exact SID.
pub fn verify_workspace_root_for_class(
    path: &Path,
    owner_sid: &str,
    class: &str,
    tier_sids: Option<&TierSids>,
) -> Option<RootDrift> {
    let label = placeholder_label(&BrokerPathPlaceholder::WorkspaceRoot);
    let finding = |reason, detail| RootDrift {
        placeholder: label,
        reason,
        detail,
    };
    let handle = match open_managed_root_for_read_control(path) {
        Ok(handle) => handle,
        Err(refusal) => return Some(finding(refusal.code(), refusal.detail())),
    };
    verify_workspace_root_dacl_for_class(&handle, owner_sid, class, tier_sids)
        .err()
        .map(|drift| finding(drift.code(), drift.detail()))
}

/// Checks every bound root and returns the drifted ones in the fixed reporting order.
pub fn verify_request_roots(
    paths: &HashMap<BrokerPathPlaceholder, String>,
    owner_sid: &str,
) -> Vec<RootDrift> {
    verify_request_roots_with(paths, owner_sid, None)
}

/// As [`verify_request_roots`]; with `tier_sids` every tier ACE (roots and backend ancestors) must name
/// its principal's exact SID. Only the on-demand readback passes them.
pub fn verify_request_roots_with(
    paths: &HashMap<BrokerPathPlaceholder, String>,
    owner_sid: &str,
    tier_sids: Option<&TierSids>,
) -> Vec<RootDrift> {
    let mut findings: Vec<RootDrift> = CHECKED_PLACEHOLDERS
        .iter()
        .filter_map(|placeholder| {
            let path = paths.get(placeholder)?;
            verify_root(placeholder, Path::new(path), owner_sid, tier_sids)
        })
        .collect();
    // Product roles bind payload/data/logs/temp. Router does not consume config;
    // derive its config anchor lexically from data, without granting config access.
    if (paths.contains_key(&BrokerPathPlaceholder::PayloadRoot)
        && paths.contains_key(&BrokerPathPlaceholder::StateDataRoot))
        || paths.contains_key(&BrokerPathPlaceholder::StateConfigRoot)
    {
        let ancestors = (|| {
            let get = |key| {
                paths.get(&key).map(Path::new).ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "backend layout binding missing",
                    )
                })
            };
            let data = get(BrokerPathPlaceholder::StateDataRoot)?;
            let config_anchor = data.parent().unwrap_or(data).join("config");
            let config = paths
                .get(&BrokerPathPlaceholder::StateConfigRoot)
                .map(Path::new)
                .unwrap_or(&config_anchor);
            crate::backend_ancestors::derive(
                config,
                data,
                get(BrokerPathPlaceholder::StateLogsRoot)?,
                get(BrokerPathPlaceholder::PayloadRoot)?,
                get(BrokerPathPlaceholder::StateTempRoot)?,
            )
        })();
        match ancestors {
            Err(_) => findings.push(RootDrift {
                placeholder: "backend_root",
                reason: "backend_layout_invalid",
                detail: "backend roots do not match the fixed product layout".to_owned(),
            }),
            Ok(ancestors) => {
                findings.extend(verify_profile_ancestors(&ancestors[0], owner_sid));
                for (scope, path) in crate::backend_ancestors::SCOPES.into_iter().zip(ancestors) {
                    let result = match open_managed_root_for_read_control(&path) {
                        Ok(handle) => {
                            verify_managed_root_dacl_with(&handle, scope, owner_sid, tier_sids)
                                .err()
                                .map(|error| (error.code(), error.detail()))
                        }
                        Err(error) => Some((error.code(), error.detail())),
                    };
                    if let Some((reason, detail)) = result {
                        findings.push(RootDrift {
                            placeholder: scope,
                            reason,
                            detail,
                        });
                    }
                }
            }
        }
    }
    findings
}

/// Whether each folder between the user profile and `backend` still carries the one ACE provision adds.
///
/// Presence only, read with `READ_CONTROL`: the rest of a profile folder's DACL is the user's. A backend
/// outside the fixed profile shape has no profile ancestors, so there is nothing to report. The tier SID
/// is resolved from the derived account name, exactly as the owner hop resolves the runner's.
fn verify_profile_ancestors(backend: &Path, owner_sid: &str) -> Vec<RootDrift> {
    let finding = |reason, detail| RootDrift {
        placeholder: "profile_ancestor",
        reason,
        detail,
    };
    let grants = match crate::acl_descriptor::profile_ancestor_grants() {
        Ok(grants) => grants,
        Err(error) => {
            return vec![finding(
                "profile_ancestor_policy_unreadable",
                error.to_string(),
            )];
        }
    };
    let Some(paths) = crate::profile_ancestors::derive(backend, &grants) else {
        return Vec::new();
    };
    paths
        .iter()
        .zip(&grants)
        .filter_map(|(path, grant)| {
            let tier = grant
                .ace
                .principal
                .strip_prefix("sandbox_tier_")
                .and_then(IsolationTier::from_wire)?;
            let sid = match local_user_account_sid(&account_name_for(owner_sid, tier)) {
                Ok(sid) => sid,
                Err(error) => {
                    return Some(finding(
                        "profile_ancestor_principal_unresolved",
                        format!("the {} account does not resolve: {error}", tier.as_str()),
                    ));
                }
            };
            match crate::profile_ancestors::carries_grant(path, &grant.ace, &sid) {
                Ok(true) => None,
                Ok(false) => Some(finding(
                    "profile_ancestor_ace_absent",
                    format!(
                        "{} does not let the {} tier read its attributes",
                        grant.profile_relative_path,
                        tier.as_str()
                    ),
                )),
                Err((reason, detail)) => Some(finding(reason, detail)),
            }
        })
        .collect()
}

/// The refusal a client parses to decide whether to provision and retry once.
///
/// It is the governed `tier_launch_refused` envelope with reason `provision_required`, the one reason the
/// client answers by provisioning. An envelope of its own would not parse as `BrokerTierLaunchRefusal`,
/// so the client would report a schema mismatch and never reach the retry this refusal asks for.
///
/// The detail names every drifted placeholder and the descriptor this build enforces. With the digest in
/// hand an operator can tell "provision has not run" from "provision ran against another policy".
pub fn provision_required_refusal(findings: &[RootDrift]) -> TierLaunchRefusal {
    TierLaunchRefusal::new(
        TierLaunchRefusalReason::ProvisionRequired,
        format!(
            "{} managed root(s) do not carry the provisioned access control ({}) under policy {}; \
             provision the workspace access control and retry once",
            findings.len(),
            findings
                .iter()
                .map(|finding| format!("{}={}", finding.placeholder, finding.reason))
                .collect::<Vec<_>>()
                .join(", "),
            SHIPPED_ACL_DESCRIPTOR_DIGEST,
        ),
    )
}

/// Refuses the launch if any bound root has drifted, writing the typed refusal first.
///
/// The refusal goes to stdout as one JSON line and the error goes to the exit status, exactly as every
/// other owner-hop refusal does: a caller that parses output and a caller that only checks the exit
/// code both see the same decision. Nothing is launched and nothing is repaired.
pub fn require_provisioned_roots(
    paths: &HashMap<BrokerPathPlaceholder, String>,
    tier: IsolationTier,
    owner_sid: &str,
) -> io::Result<()> {
    let findings = verify_request_roots(paths, owner_sid);
    if findings.is_empty() {
        return Ok(());
    }
    let account_name = account_name_for(owner_sid, tier);
    let context = RefusalContext {
        tier,
        owner_sid,
        account_name: &account_name,
    };
    Err(refuse(&context, provision_required_refusal(&findings)))
}

#[cfg(test)]
mod tests {
    use super::super::refusal::{
        TIER_LAUNCH_REFUSED_EVENT, TierLaunchRefusalReport, write_refusal,
    };
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is after the epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "superclaw-drift-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("the directory should be creatable");
        path
    }

    fn owner() -> String {
        crate::sid_win32::current_process_sid().expect("this process has a token user")
    }

    #[test]
    fn every_path_placeholder_is_checked_and_mapped_to_a_shipped_scope() {
        for placeholder in CHECKED_PLACEHOLDERS {
            if let Some(scope) = managed_scope(placeholder) {
                crate::acl_descriptor::managed_root_expectation(scope)
                    .unwrap_or_else(|error| panic!("{scope}: {error}"));
            }
        }
        // Every placeholder the catalog can bind must appear, or a root would be launched against
        // without ever being verified.
        for label in [
            "workspace_root",
            "payload_root",
            "state_config_root",
            "state_data_root",
            "state_logs_root",
            "state_temp_root",
            "state_protected_root",
            "isolation_root",
        ] {
            assert!(
                CHECKED_PLACEHOLDERS
                    .iter()
                    .any(|placeholder| placeholder_label(placeholder) == label),
                "{label} is bindable but unchecked"
            );
        }
    }

    /// The fail-closed case: ordinary directories that provision never touched.
    #[test]
    fn product_layout_checks_all_three_unprovisioned_ancestors() {
        let root = temp_dir("backend-parents");
        let bindings = [
            (BrokerPathPlaceholder::StateConfigRoot, "config"),
            (BrokerPathPlaceholder::StateDataRoot, "data"),
            (BrokerPathPlaceholder::StateLogsRoot, "logs"),
            (BrokerPathPlaceholder::PayloadRoot, "payload/v1"),
            (BrokerPathPlaceholder::StateTempRoot, "tmp/broker-start"),
        ];
        let paths = bindings
            .into_iter()
            .map(|(key, relative)| {
                let path = root.join(relative);
                fs::create_dir_all(&path).unwrap();
                (key, path.display().to_string())
            })
            .collect();
        let findings = verify_request_roots(&paths, &owner());
        for scope in crate::backend_ancestors::SCOPES {
            assert!(
                findings
                    .iter()
                    .any(|item| item.placeholder == scope && item.reason == "dacl_not_protected")
            );
        }
        assert!(
            !findings
                .iter()
                .any(|item| item.placeholder == "profile_ancestor"),
            "a backend outside the profile shape has no profile ancestors to report"
        );
        let mut router_paths = paths;
        router_paths.remove(&BrokerPathPlaceholder::StateConfigRoot);
        let router_findings = verify_request_roots(&router_paths, &owner());
        for scope in crate::backend_ancestors::SCOPES {
            assert!(router_findings.iter().any(|item| item.placeholder == scope));
        }
        fs::remove_dir_all(root).unwrap();
    }

    /// Fail closed: profile folders provision never granted are each reported, by relative name only.
    #[test]
    fn a_profile_shaped_backend_reports_every_ungranted_profile_ancestor() {
        let root = temp_dir("profile-shape");
        let backend = root.join(r"someone\AppData\Local\SuperClaw\backend");
        let paths = [
            (BrokerPathPlaceholder::StateConfigRoot, "config"),
            (BrokerPathPlaceholder::StateDataRoot, "data"),
            (BrokerPathPlaceholder::StateLogsRoot, "logs"),
            (BrokerPathPlaceholder::PayloadRoot, "payload/v1"),
            (BrokerPathPlaceholder::StateTempRoot, "tmp/broker-start"),
        ]
        .into_iter()
        .map(|(key, relative)| {
            let path = backend.join(relative);
            fs::create_dir_all(&path).unwrap();
            (key, path.display().to_string())
        })
        .collect();
        let findings = verify_request_roots(&paths, &owner());
        let profile: Vec<&RootDrift> = findings
            .iter()
            .filter(|item| item.placeholder == "profile_ancestor")
            .collect();
        assert_eq!(profile.len(), 3, "{findings:?}");
        let text = provision_required_refusal(&findings).detail;
        assert!(!text.contains(&root.display().to_string()), "{text}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incomplete_product_bindings_refuse_ancestor_derivation() {
        let root = temp_dir("incomplete-backend");
        let paths = HashMap::from([(
            BrokerPathPlaceholder::StateConfigRoot,
            root.display().to_string(),
        )]);
        assert!(verify_request_roots(&paths, &owner()).iter().any(|item| {
            item.placeholder == "backend_root" && item.reason == "backend_layout_invalid"
        }));
        fs::remove_dir_all(root).unwrap();
    }

    /// The fail-closed case: ordinary directories that provision never touched.
    #[test]
    fn unprovisioned_roots_are_all_reported_and_refuse_the_launch() {
        let workspace = temp_dir("workspace");
        let data = temp_dir("data");
        let paths = HashMap::from([
            (
                BrokerPathPlaceholder::WorkspaceRoot,
                workspace.display().to_string(),
            ),
            (
                BrokerPathPlaceholder::StateDataRoot,
                data.display().to_string(),
            ),
        ]);

        let findings = verify_request_roots(&paths, &owner());
        assert_eq!(
            findings
                .iter()
                .map(|finding| finding.placeholder)
                .collect::<Vec<_>>(),
            ["workspace_root", "state_data_root"],
            "both roots drift, in the fixed reporting order"
        );
        assert!(findings.iter().all(|finding| finding.reason
            == crate::managed_root_dacl::DaclDrift::DaclNotProtected.code()));

        let refusal = provision_required_refusal(&findings);
        assert_eq!(refusal.reason, TierLaunchRefusalReason::ProvisionRequired);
        assert!(refusal.detail.starts_with("2 managed root(s)"));
        assert!(refusal.detail.contains("workspace_root=dacl_not_protected"));
        assert!(
            refusal
                .detail
                .contains("state_data_root=dacl_not_protected")
        );
        assert!(refusal.detail.contains(SHIPPED_ACL_DESCRIPTOR_DIGEST));

        let owner_sid = owner();
        let error = require_provisioned_roots(&paths, IsolationTier::FileTool, &owner_sid)
            .expect_err("a drifted root must refuse the launch");
        assert!(error.to_string().starts_with("provision_required: "));

        fs::remove_dir_all(&workspace).ok();
        fs::remove_dir_all(&data).ok();
    }

    /// The client parses a launch refusal only as the governed `BrokerTierLaunchRefusal`, and answers
    /// `provision_required` by provisioning and retrying once. A drift report in any other envelope
    /// failed that parse as `launch_refused`, so a root that lost its access control stranded the start
    /// instead of costing one UAC prompt.
    #[test]
    fn a_drift_refusal_is_the_governed_tier_launch_refusal_envelope() {
        let workspace = temp_dir("governed");
        let paths = HashMap::from([(
            BrokerPathPlaceholder::WorkspaceRoot,
            workspace.display().to_string(),
        )]);
        let owner_sid = owner();
        let refusal = provision_required_refusal(&verify_request_roots(&paths, &owner_sid));

        let mut output = Vec::new();
        write_refusal(&mut output, &context(&owner_sid), &refusal).expect("the refusal writes");
        let line = String::from_utf8(output).expect("the refusal is UTF-8");
        let report: TierLaunchRefusalReport =
            serde_json::from_str(line.trim_end()).expect("the refusal is the governed envelope");
        assert_eq!(report.event, TIER_LAUNCH_REFUSED_EVENT);
        assert_eq!(report.tier, "file_tool");
        assert_eq!(report.owner_sid, owner_sid);
        assert_eq!(report.refusals.len(), 1);
        assert_eq!(report.refusals[0].reason, "provision_required");
        assert!(
            report.refusals[0]
                .detail
                .contains("workspace_root=dacl_not_protected")
        );
        assert!(
            report.refusals[0]
                .remedy
                .contains("reapplies the workspace access control"),
            "the remedy must describe the recovery the client performs for drift"
        );

        fs::remove_dir_all(&workspace).ok();
    }

    fn context(owner_sid: &str) -> RefusalContext<'_> {
        RefusalContext {
            tier: IsolationTier::FileTool,
            owner_sid,
            account_name: "SCBFHEC353DKTS3MJ567",
        }
    }

    /// A missing root is drift too, not an excuse to continue: "the tree is not there yet" and "the
    /// tree is there with the wrong access control" both mean provision has to run.
    #[test]
    fn a_root_that_does_not_exist_is_drift_rather_than_a_skipped_check() {
        let root = temp_dir("absent");
        let missing = root.join("never-created");
        let paths = HashMap::from([(
            BrokerPathPlaceholder::IsolationRoot,
            missing.display().to_string(),
        )]);
        let findings = verify_request_roots(&paths, &owner());
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].placeholder, "isolation_root");
        assert_eq!(findings[0].reason, "managed_path_unreadable");
        fs::remove_dir_all(&root).ok();
    }

    /// The reason a root is refused before its DACL is read: a junction above it means the descriptor
    /// that would be read is not the descriptor of the object the request bound.
    #[test]
    fn a_junction_above_a_root_is_refused_before_its_dacl_is_read() {
        let root = temp_dir("junction");
        let real = root.join("real");
        fs::create_dir_all(&real).expect("the real tree should be creatable");
        let linked = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(root.join("link"))
            .arg(&real)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if linked {
            let paths = HashMap::from([(
                BrokerPathPlaceholder::StateTempRoot,
                root.join("link").display().to_string(),
            )]);
            let findings = verify_request_roots(&paths, &owner());
            assert_eq!(findings.len(), 1);
            assert_eq!(findings[0].reason, "managed_path_reparse_point");
        }
        fs::remove_dir_all(&root).ok();
    }

    /// No refusal may name a path. The launcher's stdout is read and logged by the client, and the
    /// placeholder name is the locator the client already has.
    #[test]
    fn no_reported_finding_names_a_path() {
        let root = temp_dir("no-paths");
        let paths = HashMap::from([(
            BrokerPathPlaceholder::StateLogsRoot,
            root.display().to_string(),
        )]);
        let text = provision_required_refusal(&verify_request_roots(&paths, &owner())).detail;
        assert!(
            !text.contains(&root.display().to_string().replace('\\', "\\\\")),
            "the refusal leaked the root path: {text}"
        );
        assert!(!text.contains(":\\\\"), "the refusal leaked a drive letter");
        fs::remove_dir_all(&root).ok();
    }
}
