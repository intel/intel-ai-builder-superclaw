//! The Supervisor's LRM bindings, kept out of `tests.rs` so that file stays under the crate's line limit.

use super::tests::{validated, value};
use super::*;

/// The intent classifier inherits the Supervisor's environment, so the LRM endpoint and key it calls
/// are declared there (#2898), and the key never reaches the command line.
#[test]
fn the_supervisor_declares_the_lrm_endpoint_and_key_for_its_classifier() {
    let request = validated("supervisor_executable");
    let key = request.scalars[&BrokerScalarPlaceholder::LrmApiKey].clone();
    let spec = resolve_supervisor(&request, IsolationTier::Bootstrap)
        .expect("the shared supervisor request resolves");

    assert_eq!(value(&spec, "LRM_API_BASE_URL"), "http://127.0.0.1:18321");
    assert_eq!(value(&spec, "LRM_API_KEY"), key);
    assert!(!spec.command.contains(&key));
}
