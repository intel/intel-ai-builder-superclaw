//! The classifier credential's environment carrier.
//!
//! The environment is the only carrier, and the opaque scalar carries a redaction obligation.

use super::*;

pub(super) fn intent_classifier_auth_environment(
    validated: &ValidatedStartRequest,
) -> io::Result<Vec<(String, String)>> {
    let token = scalar(validated, BrokerScalarPlaceholder::IntentClassifierToken)?;
    Ok(declared(&[("INTENT_CLASSIFIER_TOKEN", token.to_owned())]))
}
