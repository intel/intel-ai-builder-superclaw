//! The read-only ACL readback: `--acl-readback --owner-sid <sid>`, the roots on standard input.
//!
//! # What it is for
//!
//! `drift` checks the roots a start binds, but only at start, and only as a refusal. The Sandbox
//! Manager's isolation report needs the same answer on demand, between starts, as evidence rather than
//! as a gate: whether each root still carries the descriptor provision applied *now*. This mode runs
//! exactly `verify_request_roots` - the same `READ_CONTROL` open, the same chain walk, the same exact
//! DACL comparison - and prints what it found.
//!
//! # Which SID each tier ACE must name
//!
//! The request carries `tier_sids`, the SID the caller resolved for each tier account by name. Every
//! tier ACE on a managed root, a backend ancestor or a workspace root must name exactly its principal's
//! SID; another tier's SID with the same rights is drift (`dacl_tier_principal_mismatch`). A request
//! without a SID for every tier principal the shipped descriptor names is refused (`acl_readback_tier_sids_missing`) rather than read with the relaxed
//! start-time check. The SIDs arrive on standard input and are never echoed.
//!
//! # What it cannot do
//!
//! It opens every root through `open_managed_root_for_read_control`, which asks for `READ_CONTROL` and
//! nothing else, and this binary has no `SetSecurityInfo` call site (`tests/launcher_closure.rs`). It
//! therefore runs as the unelevated owner, requests no elevation, and repairs nothing: a drifted root is
//! reported as drifted and left as it was found.
//!
//! # What the output carries
//!
//! One JSON line, with no path and no SID in it. A root is named by its placeholder label, or by its
//! `root_id` for a workspace root - the same names the governed started-line evidence uses - and a
//! drifted one carries the drift's reason code and not its detail, because the detail can name a path.
//! The shipped descriptor's digest is included so the caller can check this build compared against the
//! policy its own plan came from.

use super::drift::{RootDrift, verify_request_roots_with, verify_workspace_root_for_class};
use crate::acl_descriptor::{
    SHIPPED_ACL_DESCRIPTOR_DIGEST, tier_principals, workspace_root_expectations,
};
use crate::broker_wire::BrokerPathPlaceholder;
use crate::launch_catalog::placeholder_label;
use crate::sid_win32::require_current_process_owner_sid;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use std::io::{self, Read, Write};
use std::path::Path;

/// The most request bytes taken from standard input. Eight workspace roots and eight bindings are far
/// below it; the bound is only here so a stuck or hostile writer cannot make this mode read forever.
const MAX_REQUEST_BYTES: u64 = 64 * 1024;

/// The contract's bound on workspace roots in one path set.
const MAX_WORKSPACE_ROOTS: usize = 8;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    placeholder: BrokerPathPlaceholder,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceRoot {
    root_id: String,
    path: String,
    /// The policy class the root was granted, which it is compared with and no other.
    policy_class: String,
}

/// The roots to read, and the SID each tier principal is expected to resolve to. Workspace roots travel
/// apart from the placeholder bindings because the launcher's own binding map has one `workspace_root`
/// slot and a path set can hold several.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    path_bindings: Vec<Binding>,
    #[serde(default)]
    workspace_roots: Vec<WorkspaceRoot>,
    /// Descriptor principal name (`sandbox_tier_file_tool`, ...) to the SID the caller resolved for that
    /// tier account. Absent or incomplete is a refusal: the readback never falls back to the relaxed
    /// tier check, so it cannot report a match it did not pin.
    #[serde(default)]
    tier_sids: HashMap<String, String>,
}

/// A SID for exactly the tier principals the shipped descriptor names, no more and no fewer.
fn tier_sids_complete(tier_sids: &HashMap<String, String>, required: &BTreeSet<String>) -> bool {
    tier_sids.len() == required.len()
        && required.iter().all(|principal| {
            tier_sids
                .get(principal)
                .is_some_and(|sid| sid.starts_with("S-1-"))
        })
}

pub fn run(owner_sid: &str) -> io::Result<()> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let owner_sid = require_current_process_owner_sid(owner_sid)?;
    let output = if bytes.len() as u64 > MAX_REQUEST_BYTES {
        refused("acl_readback_request_oversized")
    } else {
        match serde_json::from_slice::<Request>(&bytes) {
            Ok(request) => read_back(&request, &owner_sid),
            Err(_) => refused("acl_readback_request_invalid"),
        }
    };
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &output).map_err(io::Error::other)?;
    stdout.write_all(b"\n")
}

fn refused(error_code: &str) -> Value {
    json!({"ok": false, "phase": "acl_readback", "error_code": error_code})
}

fn valid_root_id(root_id: &str) -> bool {
    root_id.len() == 68
        && root_id.starts_with("wsr_")
        && root_id[4..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn entry(root: &str, finding: Option<&RootDrift>) -> Value {
    match finding {
        None => json!({"root": root, "verdict": "matches", "reason": null}),
        Some(drift) => json!({"root": root, "verdict": "drifted", "reason": drift.reason}),
    }
}

fn read_back(request: &Request, owner_sid: &str) -> Value {
    let mut paths: HashMap<BrokerPathPlaceholder, String> = HashMap::new();
    for binding in &request.path_bindings {
        if binding.placeholder == BrokerPathPlaceholder::WorkspaceRoot
            || paths
                .insert(binding.placeholder, binding.path.clone())
                .is_some()
        {
            return refused("acl_readback_request_invalid");
        }
    }
    let Ok(classes) = workspace_root_expectations() else {
        return refused("acl_readback_descriptor_unreadable");
    };
    let Ok(tier_principals) = tier_principals() else {
        return refused("acl_readback_descriptor_unreadable");
    };
    if !tier_sids_complete(&request.tier_sids, &tier_principals) {
        return refused("acl_readback_tier_sids_missing");
    }
    if request.workspace_roots.len() > MAX_WORKSPACE_ROOTS
        || request.workspace_roots.iter().any(|root| {
            !valid_root_id(&root.root_id)
                || !classes.iter().any(|(class, _)| *class == root.policy_class)
        })
        || (paths.is_empty() && request.workspace_roots.is_empty())
    {
        return refused("acl_readback_request_invalid");
    }

    let findings = verify_request_roots_with(&paths, owner_sid, Some(&request.tier_sids));
    let mut roots: Vec<Value> = Vec::new();
    let mut named: Vec<&str> = Vec::new();
    for binding in &request.path_bindings {
        let label = placeholder_label(&binding.placeholder);
        named.push(label);
        roots.push(entry(
            label,
            findings.iter().find(|finding| finding.placeholder == label),
        ));
    }
    // Findings about roots the request did not name: the backend ancestors and profile folders the
    // check derives from the bound roots.
    for finding in findings
        .iter()
        .filter(|finding| !named.contains(&finding.placeholder))
    {
        roots.push(entry(finding.placeholder, Some(finding)));
    }
    for root in &request.workspace_roots {
        roots.push(entry(
            &root.root_id,
            verify_workspace_root_for_class(
                Path::new(&root.path),
                owner_sid,
                &root.policy_class,
                Some(&request.tier_sids),
            )
            .as_ref(),
        ));
    }
    let drifted = roots.iter().any(|root| root["verdict"] == "drifted");
    json!({
        "ok": true,
        "phase": "acl_readback",
        "verdict": if drifted { "drifted" } else { "matches" },
        "descriptor_digest": SHIPPED_ACL_DESCRIPTOR_DIGEST,
        "roots": roots,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is after the epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "superclaw-acl-readback-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("the directory should be creatable");
        path
    }

    fn owner() -> String {
        crate::sid_win32::current_process_sid().expect("this process has a token user")
    }

    fn root_id() -> String {
        format!("wsr_{}", "a".repeat(64))
    }

    fn tiers() -> HashMap<String, String> {
        tier_principals()
            .expect("the shipped descriptor is readable")
            .iter()
            .enumerate()
            .map(|(index, principal)| {
                (
                    principal.to_owned(),
                    format!("S-1-5-21-7-8-9-{}", 3000 + index),
                )
            })
            .collect()
    }

    fn request(workspace: &Path, backend: Option<&Path>) -> Request {
        Request {
            tier_sids: tiers(),
            path_bindings: backend
                .map(|path| {
                    vec![Binding {
                        placeholder: BrokerPathPlaceholder::IsolationRoot,
                        path: path.display().to_string(),
                    }]
                })
                .unwrap_or_default(),
            workspace_roots: vec![WorkspaceRoot {
                root_id: root_id(),
                path: workspace.display().to_string(),
                policy_class: "managed_default".to_owned(),
            }],
        }
    }

    /// An ordinary directory provision never touched is the drifted case, and the output names it by
    /// root id and reason code only.
    #[test]
    fn an_unprovisioned_workspace_root_is_reported_drifted_without_its_path() {
        let workspace = temp_dir("workspace");
        let output = read_back(&request(&workspace, None), &owner());
        assert_eq!(output["ok"], true);
        assert_eq!(output["verdict"], "drifted");
        assert_eq!(output["roots"][0]["root"], root_id());
        assert_eq!(output["roots"][0]["verdict"], "drifted");
        assert!(output["roots"][0]["reason"].is_string());
        let text = output.to_string();
        assert!(!text.contains(&workspace.display().to_string()));
        assert!(!text.contains(&owner()));
        assert_eq!(output["descriptor_digest"], SHIPPED_ACL_DESCRIPTOR_DIGEST);
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn a_bound_managed_root_is_named_by_its_placeholder() {
        let workspace = temp_dir("workspace-bound");
        let isolation = temp_dir("isolation");
        let output = read_back(&request(&workspace, Some(isolation.as_path())), &owner());
        let names: Vec<&str> = output["roots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|root| root["root"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["isolation_root", &root_id()]);
        assert!(
            !output
                .to_string()
                .contains(&isolation.display().to_string())
        );
        fs::remove_dir_all(workspace).unwrap();
        fs::remove_dir_all(isolation).unwrap();
    }

    #[test]
    fn a_missing_root_is_drifted_rather_than_an_error() {
        let missing = std::env::temp_dir().join("superclaw-acl-readback-does-not-exist-9f3a");
        let output = read_back(&request(&missing, None), &owner());
        assert_eq!(output["ok"], true);
        assert_eq!(output["roots"][0]["verdict"], "drifted");
    }

    #[test]
    fn requests_outside_the_closed_shape_are_refused() {
        let workspace = temp_dir("refused");
        let bad_id = Request {
            tier_sids: tiers(),
            path_bindings: Vec::new(),
            workspace_roots: vec![WorkspaceRoot {
                root_id: "wsr_short".to_owned(),
                path: workspace.display().to_string(),
                policy_class: "managed_default".to_owned(),
            }],
        };
        let unknown_class = Request {
            tier_sids: tiers(),
            path_bindings: Vec::new(),
            workspace_roots: vec![WorkspaceRoot {
                root_id: root_id(),
                path: workspace.display().to_string(),
                policy_class: "made_up".to_owned(),
            }],
        };
        let workspace_binding = Request {
            tier_sids: tiers(),
            path_bindings: vec![Binding {
                placeholder: BrokerPathPlaceholder::WorkspaceRoot,
                path: workspace.display().to_string(),
            }],
            workspace_roots: Vec::new(),
        };
        let empty = Request {
            tier_sids: tiers(),
            path_bindings: Vec::new(),
            workspace_roots: Vec::new(),
        };
        for refused_request in [bad_id, unknown_class, workspace_binding, empty] {
            let output = read_back(&refused_request, &owner());
            assert_eq!(output["ok"], false);
            assert_eq!(output["error_code"], "acl_readback_request_invalid");
        }
        assert!(serde_json::from_str::<Request>(r#"{"path_bindings":[],"extra":1}"#).is_err());
        // A workspace root without its class is not a request: the readback never guesses one.
        assert!(
            serde_json::from_str::<Request>(&format!(
                r#"{{"path_bindings":[],"workspace_roots":[{{"root_id":"{}","path":"C:\\x"}}]}}"#,
                root_id()
            ))
            .is_err()
        );
        fs::remove_dir_all(workspace).unwrap();
    }

    /// The readback never falls back to the relaxed tier check: a request without every tier SID is
    /// refused, and the SIDs it does carry never reach the output.
    #[test]
    fn a_request_without_every_tier_sid_is_refused_and_sids_are_never_echoed() {
        let workspace = temp_dir("tier-sids");
        let mut incomplete = request(&workspace, None);
        incomplete.tier_sids.remove("sandbox_tier_file_tool");
        let mut bogus = request(&workspace, None);
        bogus
            .tier_sids
            .insert("sandbox_tier_file_tool".to_owned(), "not-a-sid".to_owned());
        let mut extra = request(&workspace, None);
        extra.tier_sids.insert("host_user".to_owned(), owner());
        for refused_request in [
            Request {
                tier_sids: HashMap::new(),
                ..request(&workspace, None)
            },
            incomplete,
            bogus,
            extra,
        ] {
            let output = read_back(&refused_request, &owner());
            assert_eq!(output["ok"], false);
            assert_eq!(output["error_code"], "acl_readback_tier_sids_missing");
        }
        let served = read_back(&request(&workspace, None), &owner()).to_string();
        assert!(!served.contains("S-1-5-21-7-8-9"));
        let parsed: Request = serde_json::from_str(
            r#"{"path_bindings":[],"tier_sids":{"sandbox_tier_bootstrap":"S-1-5-21-1"}}"#,
        )
        .unwrap();
        let required = tier_principals().expect("the shipped descriptor is readable");
        assert!(!tier_sids_complete(&parsed.tier_sids, &required));
        assert!(tier_sids_complete(&tiers(), &required));
        assert!(
            required.contains("sandbox_tier_channel"),
            "the channel tier's SID is required once the descriptor uses it"
        );
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn a_workspace_root_id_must_be_the_contract_shape() {
        assert!(valid_root_id(&root_id()));
        assert!(!valid_root_id(&format!("wsr_{}", "A".repeat(64))));
        assert!(!valid_root_id(&format!("wsr_{}", "a".repeat(63))));
        assert!(!valid_root_id("managed_default"));
    }
}
