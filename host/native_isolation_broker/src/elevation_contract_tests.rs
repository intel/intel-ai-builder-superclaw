//! The elevated broker's two contract surfaces, read from `shared/contracts` rather than restated.
//!
//! - Every golden command line in `valid-elevated-operations.json` is recognized as exactly its operation,
//!   by exactly one parser, and every refused shape in it by neither.
//! - `ProvisionRefusal` spells exactly the reasons `BrokerProvisionRefusalReasonSchema` publishes. This pins
//!   the Rust side only; the client's `REFUSAL_REASONS` is pinned to the same schema by the client layer.

use crate::cli_acl;
use crate::cli_provision::{self, ProvisionCommand};
use crate::provision_session::IdentityStep;
use crate::provision_session::wire::ProvisionRefusal;
use serde_json::Value;
use std::path::PathBuf;

fn contract_file(relative: &[&str]) -> Value {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("shared")
        .join("contracts");
    path.extend(relative);
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|error| panic!("contract file {path:?} should be readable: {error}"));
    serde_json::from_slice(&bytes)
        .unwrap_or_else(|error| panic!("contract file {path:?} should be JSON: {error}"))
}

fn operations_fixture() -> Value {
    contract_file(&[
        "fixtures",
        "native-isolation-broker",
        "valid-elevated-operations.json",
    ])
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("a JSON array")
        .iter()
        .map(|member| member.as_str().expect("a JSON string").to_owned())
        .collect()
}

/// The contract's name for whatever operation a command line is, or `None` when no parser claims it.
fn operation(argv: &[String]) -> Option<&'static str> {
    let provision = cli_provision::parse(argv).map(|command| match command {
        ProvisionCommand::Provision { .. } => "provision",
        ProvisionCommand::Session {
            identity: IdentityStep::Skip,
            ..
        } => "provision_session",
        ProvisionCommand::Session {
            identity: IdentityStep::ProvisionOwner,
            ..
        } => "provision_identities_and_session",
        ProvisionCommand::Revoke { .. } => "revoke",
    });
    let acl = cli_acl::parse(argv).map(|_| "revoke_workspace_authorization");
    assert!(
        provision.is_none() || acl.is_none(),
        "two parsers claimed {argv:?}"
    );
    provision.or(acl)
}

#[test]
fn every_golden_command_line_is_recognized_as_exactly_its_operation() {
    let fixture = operations_fixture();
    let entries = fixture["operations"].as_array().expect("operations");
    assert_eq!(entries.len(), 5, "one golden command line per operation");
    for entry in entries {
        let argv = strings(&entry["argv"]);
        assert_eq!(
            operation(&argv),
            Some(entry["operation"].as_str().expect("an operation name")),
            "{argv:?}"
        );
    }
}

/// The combined operation hands its three values to the session exactly where `--provision-session` does,
/// so nothing about the pipe or the key changes when the identity step rides along, and the parsed
/// `identity` is what `try_run` hands to the session: the golden combined command line selects the identity
/// step and the golden session command line skips it.
#[test]
fn the_combined_operation_carries_the_session_values_unchanged() {
    let fixture = operations_fixture();
    let value = |name: &str| fixture["values"][name].as_str().expect("a fixture value");
    let argv_of = |name: &str| {
        let entry = fixture["operations"]
            .as_array()
            .expect("operations")
            .iter()
            .find(|entry| entry["operation"] == name)
            .expect("the operation has a golden command line");
        strings(&entry["argv"])
    };
    let combined = argv_of("provision_identities_and_session");
    let session = argv_of("provision_session");
    assert_eq!(
        cli_provision::parse(&combined),
        Some(ProvisionCommand::Session {
            owner_sid: value("owner_sid"),
            pipe_id: value("pipe_id"),
            auth_key: value("auth_key"),
            identity: IdentityStep::ProvisionOwner,
        })
    );
    assert_eq!(
        cli_provision::parse(&session),
        Some(ProvisionCommand::Session {
            owner_sid: value("owner_sid"),
            pipe_id: value("pipe_id"),
            auth_key: value("auth_key"),
            identity: IdentityStep::Skip,
        })
    );
}

#[test]
fn every_refused_shape_is_recognized_by_no_parser() {
    let fixture = operations_fixture();
    let refused = fixture["refused_argv"].as_array().expect("refused_argv");
    assert!(!refused.is_empty());
    for argv in refused {
        let argv = strings(argv);
        assert_eq!(operation(&argv), None, "{argv:?}");
    }
}

#[test]
fn the_provision_refusal_vocabulary_is_exactly_the_contracts() {
    let schema = contract_file(&["generated", "json-schema", "broker-provision-refusal.json"]);
    let mut published = strings(&schema["properties"]["reason"]["enum"]);
    published.sort();
    let mut spelled: Vec<String> = ProvisionRefusal::ALL
        .iter()
        .map(|refusal| refusal.code().to_owned())
        .collect();
    spelled.sort();
    spelled.dedup();
    assert_eq!(spelled.len(), ProvisionRefusal::ALL.len(), "a variant is listed twice");
    assert_eq!(spelled, published);
    for refusal in ProvisionRefusal::ALL {
        assert_eq!(
            serde_json::to_value(refusal).expect("a refusal serializes"),
            Value::String(refusal.code().to_owned()),
            "the wire spelling of {refusal:?} is its code"
        );
    }
}
