//! Range-checking of bound scalars against the generated shared rule table.
//!
//! The table lives in `shared/contracts` and is read rather than restated, because three validators
//! need it and only one of them is Rust: the contract wire check, this broker, and the Sandbox
//! Manager's fixture leg. A bound written out three times is three bounds that agree until one is
//! edited.
//!
//! This is its own module rather than a pair of items inside `launch_catalog` because the opaque class
//! below makes it more than a range check: it is the one place that decides what may be said about a
//! secret, and that decision should be findable by name.

use crate::broker_wire::{BrokerScalarPlaceholder, ScalarBindingValue};
use serde::Deserialize;

/// How a bound scalar is checked, deserialized from the shipped catalog bundle.
///
/// `deny_unknown_fields` so that a rule class added on the contract side cannot be silently ignored
/// here: a new class means new checking, and a validator that quietly drops the field would accept
/// values nobody checked.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ScalarRules {
    pub text_placeholders: Vec<String>,
    pub opaque_placeholders: Vec<String>,
    pub opaque_min_chars: usize,
    pub opaque_max_chars: usize,
    pub port_placeholders: Vec<String>,
    pub port_min: u64,
    pub port_max: u64,
}

/// Why a bound value is not acceptable for its placeholder, or `None` when it is.
///
/// Every returned string is safe to put in a refusal, which for the opaque class means it states the
/// rule and never the value. A refusal that echoed a rejected token would publish it to whatever reads
/// refusals, which is the one thing binding a secret is supposed to avoid.
pub(crate) fn scalar_range_issue(
    placeholder: BrokerScalarPlaceholder,
    value: &ScalarBindingValue,
    rules: &ScalarRules,
) -> Option<String> {
    let label = crate::launch_catalog::scalar_label(&placeholder);

    if rules.opaque_placeholders.iter().any(|name| name == label) {
        let ScalarBindingValue::Text(secret) = value else {
            return Some("must be a string".to_owned());
        };
        // Length is counted in bytes, and the charset below is what makes that the same as counting
        // characters: every accepted byte is single-byte in UTF-8, so there is no encoding under which
        // a value that passes here is a different length than it looks.
        if !(rules.opaque_min_chars..=rules.opaque_max_chars).contains(&secret.len()) {
            return Some(format!(
                "must be between {} and {} characters",
                rules.opaque_min_chars, rules.opaque_max_chars
            ));
        }
        // URL-safe base64's alphabet, which is what `secrets.token_urlsafe` on the owner side produces.
        // Restricting the charset is not about the secret's strength; it is what lets this value be
        // carried as an environment variable and compared as bytes without any quoting question.
        if !secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Some("must use only ASCII letters, digits, underscore and hyphen".to_owned());
        }
        return None;
    }

    if rules.text_placeholders.iter().any(|name| name == label) {
        return match value {
            ScalarBindingValue::Text(text) if !text.is_empty() => None,
            _ => Some("must be a non-empty string".to_owned()),
        };
    }

    // Fail closed rather than fall through to the port check. A scalar in neither list is one the
    // shipped rules have nothing to say about, and guessing which check it wanted is how an unchecked
    // value reaches a command line.
    if !rules.port_placeholders.iter().any(|name| name == label) {
        return Some("has no scalar rule in the shipped catalog".to_owned());
    }
    let ScalarBindingValue::Number(port) = value else {
        return Some("must be a non-negative integer port".to_owned());
    };
    if !(rules.port_min..=rules.port_max).contains(port) {
        return Some(format!(
            "port must be between {} and {}",
            rules.port_min, rules.port_max
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launch_catalog::scalar_label;

    fn shipped_rules() -> ScalarRules {
        let bundle: serde_json::Value = serde_json::from_str(include_str!(
            "../../../shared/contracts/generated/data/broker-startup-catalog.json"
        ))
        .expect("embedded catalog bundle must parse");
        serde_json::from_value(bundle["scalar_rules"].clone()).expect("shipped scalar rules")
    }

    /// Every opaque placeholder the shipped rules name is refused without its value, a prefix of it or
    /// its length appearing in the refusal.
    ///
    /// Driven off the shipped list rather than one named token, so a secret added on the contract side
    /// is covered here without anyone remembering to list it. `launch_catalog` pins one token; this
    /// pins the set.
    #[test]
    fn no_opaque_refusal_echoes_the_rejected_value() {
        let rules = shipped_rules();
        assert!(
            rules
                .opaque_placeholders
                .iter()
                .any(|name| name == "runtime_password")
        );
        for name in &rules.opaque_placeholders {
            let placeholder: BrokerScalarPlaceholder =
                serde_json::from_value(serde_json::Value::String(name.clone())).expect(name);
            // Too short (27), and long enough (33) but outside the URL-safe alphabet. `zq7x` is a prefix
            // no refusal wording contains, and neither length appears in the bound it states.
            for secret in [
                "zq7x-short-secret-012345678",
                "zq7x+secret/0123456789abcdefghij=",
            ] {
                let issue = scalar_range_issue(
                    placeholder,
                    &ScalarBindingValue::Text(secret.to_owned()),
                    &rules,
                )
                .unwrap_or_else(|| panic!("{name} accepted a value outside the opaque rule"));
                assert!(
                    !issue.contains(secret)
                        && !issue.contains(&secret[..4])
                        && !issue.contains(&secret.len().to_string()),
                    "{name} refusal echoed the rejected value, a prefix of it or its length"
                );
            }
        }
    }

    /// Every scalar the wire can name is classified by the shipped rules.
    ///
    /// The fail-closed arm in `scalar_range_issue` is the thing under test: a scalar added to the
    /// vocabulary and left out of both rule lists would be accepted by no check at all, and this is
    /// what turns that into a failing test rather than an unchecked value on a command line.
    #[test]
    fn every_scalar_placeholder_has_a_rule() {
        let rules = &shipped_rules();
        for placeholder in [
            BrokerScalarPlaceholder::LoopbackHost,
            BrokerScalarPlaceholder::SupervisorPort,
            BrokerScalarPlaceholder::RuntimePort,
            BrokerScalarPlaceholder::RouterHealthPort,
            BrokerScalarPlaceholder::ConnectorPort,
            BrokerScalarPlaceholder::EgressProxyShellPort,
            BrokerScalarPlaceholder::EgressProxyChannelPort,
            BrokerScalarPlaceholder::HdrPort,
            BrokerScalarPlaceholder::LlmrouterPort,
            BrokerScalarPlaceholder::HdrApiToken,
            BrokerScalarPlaceholder::HdrReadyToken,
            BrokerScalarPlaceholder::HdrEnabled,
            BrokerScalarPlaceholder::HostToken,
            BrokerScalarPlaceholder::HostTokenSha256,
            BrokerScalarPlaceholder::OpenworkToken,
            BrokerScalarPlaceholder::RouterControlToken,
            BrokerScalarPlaceholder::RouterScopedToken,
            BrokerScalarPlaceholder::LrmApiKey,
            BrokerScalarPlaceholder::RuntimePassword,
            BrokerScalarPlaceholder::IntentClassifierToken,
            BrokerScalarPlaceholder::RuntimeDeploymentB64,
            BrokerScalarPlaceholder::RuntimeDesiredFingerprint,
            BrokerScalarPlaceholder::RuntimeInstanceId,
            BrokerScalarPlaceholder::RuntimeLaunchAttemptId,
            BrokerScalarPlaceholder::LocalProxyUrl,
            BrokerScalarPlaceholder::LocalProxyBypass,
        ] {
            // Long enough to satisfy the opaque bound and test classification rather than length.
            let text = scalar_range_issue(
                placeholder,
                &ScalarBindingValue::Text("a".repeat(32)),
                rules,
            );
            let number =
                scalar_range_issue(placeholder, &ScalarBindingValue::Number(47_821), rules);
            let unclassified = "has no scalar rule in the shipped catalog";
            assert!(
                text.as_deref() != Some(unclassified) && number.as_deref() != Some(unclassified),
                "{} is in neither rule list",
                scalar_label(&placeholder)
            );
            // One of the two shapes has to be the accepted one, or the placeholder is unusable.
            assert!(
                text.is_none() || number.is_none(),
                "{} accepts no value at all",
                scalar_label(&placeholder)
            );
        }
    }
}
