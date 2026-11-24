//! Shipped startup catalog validation (contracts PR2 / `refuseBrokerStartRequest`).

use crate::broker_wire::{
    BROKER_WIRE_CONTRACT_VERSION, BrokerPathPlaceholder, BrokerScalarPlaceholder,
    BrokerStartRequest, ScalarBindingValue,
};
use crate::scalar_rules::{ScalarRules, scalar_range_issue};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

#[path = "launch_catalog_canonical_json.rs"]
mod canonical;
use canonical::canonical_json;
#[path = "launch_catalog_debug.rs"]
mod debug;
#[cfg(test)]
#[path = "launch_catalog_path_tests.rs"]
mod path_tests;

const CATALOG_BUNDLE_JSON: &str =
    include_str!("../../../shared/contracts/generated/data/broker-startup-catalog.json");

/// Digest of the embedded `catalog` object (matches `catalog_digest` in the bundle file).
pub const SHIPPED_CATALOG_DIGEST: &str =
    "3a6e4d3e98904c7939f4515789c330a27f022c036f90257176fcfec0656c8520";

const BROKER_STARTUP_MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolRefusal {
    pub reason: &'static str,
    pub detail: String,
}

impl ProtocolRefusal {
    pub fn new(reason: &'static str, detail: impl Into<String>) -> Self {
        Self {
            reason,
            detail: detail.into(),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ValidatedStartRequest {
    pub request: BrokerStartRequest,
    pub paths: HashMap<BrokerPathPlaceholder, String>,
    pub scalars: HashMap<BrokerScalarPlaceholder, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogBundle {
    #[allow(dead_code)]
    contract_version: u32,
    catalog: CatalogBody,
    catalog_digest: String,
    #[allow(dead_code)]
    canonicalization: String,
    scalar_rules: ScalarRules,
    role_log_rules: RoleLogRules,
}

/// `BROKER_ROLE_LOG_RULES` defines log names for `role_log.rs` and owner retention.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleLogRules {
    pub launch_id_hex_chars: usize,
    pub extension: String,
}

pub fn shipped_role_log_rules() -> &'static RoleLogRules {
    &shipped_bundle().role_log_rules
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogBody {
    #[allow(dead_code)]
    contract_version: u32,
    #[allow(dead_code)]
    manifest_version: u32,
    entries: Vec<CatalogEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogEntry {
    pub launch_role: String,
    pub executable_sha256: String,
    pub identity_id: String,
    #[allow(dead_code)]
    pub policy_id: String,
    pub path_placeholders: Vec<BrokerPathPlaceholder>,
    pub scalar_placeholders: Vec<BrokerScalarPlaceholder>,
}

pub fn catalog_entry_for_role(role: &str) -> Option<CatalogEntry> {
    shipped_entries()
        .iter()
        .find(|entry| entry.launch_role == role)
        .cloned()
}

pub fn validate_start_request_bytes(
    payload: &[u8],
) -> Result<ValidatedStartRequest, ProtocolRefusal> {
    let value: Value = serde_json::from_slice(payload)
        .map_err(|_| wire_refusal("request_shape_invalid", "invalid JSON"))?;
    if let Some(refusal) = forbidden_start_field_refusal(&value) {
        return Err(refusal);
    }
    let request: BrokerStartRequest = serde_json::from_value(value).map_err(|_| {
        wire_refusal(
            "request_shape_invalid",
            "start request does not match the wire schema",
        )
    })?;
    validate_parsed_start_request(&request)
}

pub fn validate_parsed_start_request(
    request: &BrokerStartRequest,
) -> Result<ValidatedStartRequest, ProtocolRefusal> {
    if request.contract_version != BROKER_WIRE_CONTRACT_VERSION {
        return Err(ProtocolRefusal::new(
            "unsupported_contract_version",
            "contract version is not supported",
        ));
    }
    if request.manifest_version != BROKER_STARTUP_MANIFEST_VERSION {
        return Err(ProtocolRefusal::new(
            "manifest_version_unknown",
            "manifest version is not in the shipped catalog",
        ));
    }
    if request.manifest_digest != SHIPPED_CATALOG_DIGEST {
        return Err(ProtocolRefusal::new(
            "manifest_digest_mismatch",
            "manifest digest does not match the catalog bytes",
        ));
    }

    let entry = catalog_entry_for_role(&request.launch_role).ok_or_else(|| {
        ProtocolRefusal::new(
            "launch_role_unknown",
            "launch role is not in the startup catalog",
        )
    })?;

    let needs_workspace_root = entry
        .path_placeholders
        .contains(&BrokerPathPlaceholder::WorkspaceRoot);
    if needs_workspace_root && request.workspace_root_id.is_none() {
        return Err(ProtocolRefusal::new(
            "workspace_root_id_required",
            "workspace_root placeholder requires workspace_root_id",
        ));
    }
    if !needs_workspace_root && request.workspace_root_id.is_some() {
        return Err(ProtocolRefusal::new(
            "workspace_root_id_forbidden",
            "workspace_root_id is not used for this launch role",
        ));
    }

    let allowed_path: HashSet<&str> = entry
        .path_placeholders
        .iter()
        .map(|placeholder| placeholder_label(placeholder))
        .collect();
    let allowed_scalar: HashSet<&str> = entry
        .scalar_placeholders
        .iter()
        .map(|placeholder| scalar_label(placeholder))
        .collect();
    let mut seen_path = HashSet::new();
    let mut paths = HashMap::new();
    for binding in &request.path_bindings {
        let label = placeholder_label(&binding.placeholder);
        if !allowed_path.contains(label) {
            return Err(ProtocolRefusal::new(
                "placeholder_not_declared",
                format!(
                    "path placeholder {label} is not declared for {}",
                    request.launch_role
                ),
            ));
        }
        if !seen_path.insert(label) {
            return Err(ProtocolRefusal::new(
                "placeholder_duplicate",
                format!("duplicate path placeholder {label}"),
            ));
        }
        let canonical = canonicalize_local_windows_path(&binding.path).map_err(|_| {
            ProtocolRefusal::new(
                "path_not_canonical",
                format!("path for {label} is not canonical"),
            )
        })?;
        paths.insert(binding.placeholder, canonical);
    }

    let mut seen_scalar = HashSet::new();
    let mut scalars = HashMap::new();
    for binding in &request.scalar_bindings {
        let label = scalar_label(&binding.placeholder);
        if !allowed_scalar.contains(label) {
            return Err(ProtocolRefusal::new(
                "placeholder_not_declared",
                format!(
                    "scalar placeholder {label} is not declared for {}",
                    request.launch_role
                ),
            ));
        }
        if !seen_scalar.insert(label) {
            return Err(ProtocolRefusal::new(
                "placeholder_duplicate",
                format!("duplicate scalar placeholder {label}"),
            ));
        }
        if let Some(issue) = scalar_range_issue(
            binding.placeholder,
            &binding.value,
            &shipped_bundle().scalar_rules,
        ) {
            return Err(ProtocolRefusal::new(
                "scalar_out_of_range",
                format!("{label}: {issue}"),
            ));
        }
        scalars.insert(binding.placeholder, scalar_to_string(&binding.value));
    }

    for placeholder in &entry.path_placeholders {
        if !paths.contains_key(placeholder) {
            return Err(ProtocolRefusal::new(
                "placeholder_missing",
                format!(
                    "missing required path placeholder {}",
                    placeholder_label(placeholder)
                ),
            ));
        }
    }
    for placeholder in &entry.scalar_placeholders {
        if !scalars.contains_key(placeholder) {
            return Err(ProtocolRefusal::new(
                "placeholder_missing",
                format!(
                    "missing required scalar placeholder {}",
                    scalar_label(placeholder)
                ),
            ));
        }
    }

    if let Some(escape) = path_placeholder_escape(&paths) {
        return Err(escape);
    }

    Ok(ValidatedStartRequest {
        request: request.clone(),
        paths,
        scalars,
    })
}

fn forbidden_start_field_refusal(value: &Value) -> Option<ProtocolRefusal> {
    scan_forbidden(value)
}

fn forbidden_field_reason(key: &str) -> Option<&'static str> {
    match key {
        "executable" | "executable_path" | "program" | "program_path" => {
            Some("forbidden_executable_path")
        }
        "command_line" | "commandline" | "argv" => Some("forbidden_command_line"),
        "shell" => Some("forbidden_shell"),
        "env" | "environment" => Some("forbidden_free_env"),
        _ => None,
    }
}

fn scan_forbidden(value: &Value) -> Option<ProtocolRefusal> {
    match value {
        Value::Array(items) => {
            for item in items {
                if let Some(refusal) = scan_forbidden(item) {
                    return Some(refusal);
                }
            }
            None
        }
        Value::Object(map) => {
            for (key, member) in map {
                if let Some(reason) = forbidden_field_reason(key) {
                    return Some(ProtocolRefusal::new(
                        reason,
                        format!("field {:?} is not allowed on the broker wire", key),
                    ));
                }
                if let Some(refusal) = scan_forbidden(member) {
                    return Some(refusal);
                }
            }
            None
        }
        _ => None,
    }
}

fn wire_refusal(reason: &'static str, detail: &str) -> ProtocolRefusal {
    ProtocolRefusal::new(reason, detail)
}

fn scalar_to_string(value: &ScalarBindingValue) -> String {
    match value {
        ScalarBindingValue::Text(text) => text.clone(),
        ScalarBindingValue::Number(number) => number.to_string(),
    }
}

fn path_placeholder_escape(
    paths: &HashMap<BrokerPathPlaceholder, String>,
) -> Option<ProtocolRefusal> {
    let payload = paths.get(&BrokerPathPlaceholder::PayloadRoot);
    let isolation = paths.get(&BrokerPathPlaceholder::IsolationRoot);
    if let (Some(payload), Some(isolation)) = (payload, isolation)
        && path_is_at_or_under(payload, isolation)
    {
        return Some(ProtocolRefusal::new(
            "path_placeholder_escape",
            "isolation_root must not be inside payload_root",
        ));
    }
    None
}

fn path_is_at_or_under(root: &str, path: &str) -> bool {
    let mut path_components = path.trim_end_matches('\\').split('\\');
    root.trim_end_matches('\\').split('\\').all(|component| {
        path_components
            .next()
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(component))
    })
}

pub fn canonicalize_local_windows_path(value: &str) -> Result<String, ()> {
    if is_volume_root(value) {
        return Err(());
    }
    let ordinary = value.strip_prefix(r"\\?\").unwrap_or(value);
    if ordinary.len() < 3 || ordinary.as_bytes()[1] != b':' || ordinary.as_bytes()[2] != b'\\' {
        return Err(());
    }
    if !ordinary.as_bytes()[0].is_ascii_alphabetic() {
        return Err(());
    }
    for component in ordinary.split('\\').skip(1) {
        if component.is_empty() || component == "." || component == ".." {
            return Err(());
        }
        if component
            .chars()
            .any(|character| character <= '\u{1f}' || r#"<>:"/|?*"#.contains(character))
        {
            return Err(());
        }
        if component.ends_with('.') || component.ends_with(' ') {
            return Err(());
        }
        if reserved_dos_name(component) || short_name_alias(component) {
            return Err(());
        }
    }
    let drive = ordinary.as_bytes()[0].to_ascii_uppercase() as char;
    Ok(format!("{drive}{}", &ordinary[1..]))
}

fn is_volume_root(value: &str) -> bool {
    let ordinary = value.strip_prefix(r"\\?\").unwrap_or(value);
    ordinary.len() == 3
        && ordinary.as_bytes()[1] == b':'
        && ordinary.as_bytes()[2] == b'\\'
        && ordinary.as_bytes()[0].is_ascii_alphabetic()
}

fn reserved_dos_name(component: &str) -> bool {
    let lower = component
        .split_once('.')
        .map_or(component, |(stem, _)| stem)
        .to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
            | "clock$"
    )
}

fn short_name_alias(component: &str) -> bool {
    let (stem, extension) = component
        .split_once('.')
        .map_or((component, None), |(stem, extension)| {
            (stem, Some(extension))
        });
    if extension
        .is_some_and(|value| value.is_empty() || value.chars().count() > 3 || value.contains('.'))
    {
        return false;
    }
    let Some((prefix, digits)) = stem.rsplit_once('~') else {
        return false;
    };
    prefix.chars().count() <= 6
        && (1..=6).contains(&digits.len())
        && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// The wire name of a path placeholder. Shared with `launcher::drift`, which reports drift by
/// placeholder name rather than by path, so both spell the same names from one table.
pub(crate) fn placeholder_label(placeholder: &BrokerPathPlaceholder) -> &'static str {
    match placeholder {
        BrokerPathPlaceholder::PayloadRoot => "payload_root",
        BrokerPathPlaceholder::WorkspaceRoot => "workspace_root",
        BrokerPathPlaceholder::StateConfigRoot => "state_config_root",
        BrokerPathPlaceholder::StateDataRoot => "state_data_root",
        BrokerPathPlaceholder::StateLogsRoot => "state_logs_root",
        BrokerPathPlaceholder::StateTempRoot => "state_temp_root",
        BrokerPathPlaceholder::StateProtectedRoot => "state_protected_root",
        BrokerPathPlaceholder::IsolationRoot => "isolation_root",
    }
}

pub(crate) fn scalar_label(placeholder: &BrokerScalarPlaceholder) -> &'static str {
    match placeholder {
        BrokerScalarPlaceholder::LoopbackHost => "loopback_host",
        BrokerScalarPlaceholder::SupervisorPort => "supervisor_port",
        BrokerScalarPlaceholder::RuntimePort => "runtime_port",
        BrokerScalarPlaceholder::RouterHealthPort => "router_health_port",
        BrokerScalarPlaceholder::ConnectorPort => "connector_port",
        BrokerScalarPlaceholder::EgressProxyShellPort => "egress_proxy_shell_port",
        BrokerScalarPlaceholder::EgressProxyChannelPort => "egress_proxy_channel_port",
        BrokerScalarPlaceholder::HdrPort => "hdr_port",
        BrokerScalarPlaceholder::LlmrouterPort => "llmrouter_port",
        BrokerScalarPlaceholder::HdrApiToken => "hdr_api_token",
        BrokerScalarPlaceholder::HdrReadyToken => "hdr_ready_token",
        BrokerScalarPlaceholder::HdrEnabled => "hdr_enabled",
        BrokerScalarPlaceholder::HostToken => "host_token",
        BrokerScalarPlaceholder::HostTokenSha256 => "host_token_sha256",
        BrokerScalarPlaceholder::OpenworkToken => "openwork_token",
        BrokerScalarPlaceholder::RouterControlToken => "router_control_token",
        BrokerScalarPlaceholder::RouterScopedToken => "router_scoped_token",
        BrokerScalarPlaceholder::LrmApiKey => "lrm_api_key",
        BrokerScalarPlaceholder::PrivacyApiKey => "privacy_api_key",
        BrokerScalarPlaceholder::RuntimePassword => "runtime_password",
        BrokerScalarPlaceholder::IntentClassifierToken => "intent_classifier_token",
        BrokerScalarPlaceholder::RuntimeDeploymentB64 => "runtime_deployment_b64",
        BrokerScalarPlaceholder::RuntimeDesiredFingerprint => "runtime_desired_fingerprint",
        BrokerScalarPlaceholder::RuntimeInstanceId => "runtime_instance_id",
        BrokerScalarPlaceholder::RuntimeLaunchAttemptId => "runtime_launch_attempt_id",
        BrokerScalarPlaceholder::LocalProxyUrl => "local_proxy_url",
        BrokerScalarPlaceholder::LocalProxyBypass => "local_proxy_bypass",
    }
}

fn shipped_bundle() -> &'static CatalogBundle {
    static BUNDLE: std::sync::OnceLock<CatalogBundle> = std::sync::OnceLock::new();
    BUNDLE.get_or_init(|| {
        let bundle: CatalogBundle =
            serde_json::from_str(CATALOG_BUNDLE_JSON).expect("embedded catalog bundle must parse");
        assert_eq!(
            bundle.catalog_digest, SHIPPED_CATALOG_DIGEST,
            "embedded catalog_digest must match SHIPPED_CATALOG_DIGEST"
        );
        let root: Value = serde_json::from_str(CATALOG_BUNDLE_JSON).expect("bundle json");
        let catalog_value = root.get("catalog").expect("catalog key");
        let computed = hex::encode(Sha256::digest(canonical_json(catalog_value).as_bytes()));
        assert_eq!(
            computed, SHIPPED_CATALOG_DIGEST,
            "embedded catalog object digest must match SHIPPED_CATALOG_DIGEST"
        );
        bundle
    })
}

fn shipped_entries() -> &'static [CatalogEntry] {
    &shipped_bundle().catalog.entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn fixture(name: &str) -> Vec<u8> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("shared")
            .join("contracts")
            .join("fixtures")
            .join("native-isolation-broker")
            .join(name);
        fs::read(path).expect("fixture should exist")
    }

    #[test]
    fn shipped_catalog_digest_matches_contracts() {
        assert_eq!(SHIPPED_CATALOG_DIGEST.len(), 64);
        assert!(!shipped_entries().is_empty());
    }

    #[test]
    fn valid_start_request_fixture_accepts() {
        let payload = fixture("valid-start-request.json");
        let validated = validate_start_request_bytes(&payload).expect("valid request");
        assert_eq!(validated.request.launch_role, "test_fixed_sleep_child");
    }

    fn cases_table() -> Value {
        let cases_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("shared")
            .join("contracts")
            .join("test-fixtures")
            .join("native-isolation-broker-cases.json");
        serde_json::from_slice(&fs::read(cases_path).expect("cases file")).expect("cases json")
    }

    /// Every role the catalog declares has a request the broker accepts, and it resolves to the
    /// tier the shared table says it does.
    #[test]
    fn golden_accepted_cases_cover_every_shipped_role() {
        let cases = cases_table();
        let positives = cases
            .get("valid_starts")
            .and_then(Value::as_array)
            .expect("valid_starts array");
        let mut covered: Vec<String> = Vec::new();
        for positive in positives {
            let name = positive
                .get("name")
                .and_then(Value::as_str)
                .expect("case name");
            let request = positive.get("request").expect("request");
            let payload = serde_json::to_vec(request).expect("serialize request");
            let validated = validate_start_request_bytes(&payload).expect(name);
            let role = positive
                .get("launch_role")
                .and_then(Value::as_str)
                .expect("launch role");
            assert_eq!(validated.request.launch_role, role, "case {name}");
            assert!(
                validated
                    .paths
                    .contains_key(&BrokerPathPlaceholder::StateLogsRoot),
                "case {name} must bind the log root every role writes to"
            );
            covered.push(role.to_owned());
        }
        covered.sort();
        let mut declared: Vec<String> = shipped_entries()
            .iter()
            .map(|entry| entry.launch_role.clone())
            .collect();
        declared.sort();
        assert_eq!(covered, declared);
    }

    #[test]
    fn golden_refusal_cases_match_contracts() {
        let cases = cases_table();
        let valid_start = cases.get("valid_start").expect("valid_start").clone();
        let case_list = cases
            .get("cases")
            .and_then(Value::as_array)
            .expect("cases array");
        for case in case_list {
            let name = case.get("name").and_then(Value::as_str).expect("case name");
            let overrides = case.get("overrides").expect("overrides");
            let expected = case
                .get("expected_reasons")
                .and_then(Value::as_array)
                .expect("expected_reasons");
            let mut merged = valid_start.clone();
            if let (Value::Object(base), Value::Object(patch)) = (&mut merged, overrides) {
                for (key, value) in patch {
                    base.insert(key.clone(), value.clone());
                }
            }
            let payload = serde_json::to_vec(&merged).expect("serialize case");
            let refusal = validate_start_request_bytes(&payload).expect_err(name);
            let expected_reasons: Vec<String> = expected
                .iter()
                .map(|value| value.as_str().expect("reason").to_owned())
                .collect();
            assert_eq!(refusal.reason, expected_reasons[0], "case {name}");
        }
    }

    #[test]
    fn forbidden_fixture_files_are_refused() {
        for file in [
            "invalid-forbidden-executable.json",
            "invalid-forbidden-command-line.json",
        ] {
            let refusal = validate_start_request_bytes(&fixture(file)).expect_err(file);
            assert!(!refusal.detail.is_empty());
        }
    }

    /// A log root a caller spelled to walk out of the state tree is refused before anything opens.
    ///
    /// Rust-only rather than in the shared table because the two ends report different reasons for
    /// the same bytes: here the path is a plain string and canonicalization is the first thing that
    /// looks at it, while the contract's own schema rejects the spelling before its validator gets
    /// that far. Both refuse; only the reason differs, and a shared case can carry one reason.
    #[test]
    fn a_log_root_that_escapes_the_state_tree_is_refused() {
        for path in [
            r"C:\ProgramData\SuperClaw\state\..\..\logs",
            r"C:\ProgramData\SuperClaw\state\logs\CON",
            r"C:\",
        ] {
            let request = serde_json::json!({
                "contract_version": 1,
                "manifest_version": 1,
                "manifest_digest": SHIPPED_CATALOG_DIGEST,
                "launch_role": "test_fixed_sleep_child",
                "workspace_root_id": null,
                "path_bindings": [
                    { "placeholder": "payload_root", "path": r"C:\Users\tester\SuperClaw\payload" },
                    { "placeholder": "state_logs_root", "path": path },
                    { "placeholder": "isolation_root", "path": r"C:\ProgramData\SuperClaw\isolation" },
                ],
                "scalar_bindings": [],
            });
            let payload = serde_json::to_vec(&request).expect("serialize request");
            let refusal = validate_start_request_bytes(&payload).expect_err(path);
            assert_eq!(refusal.reason, "path_not_canonical", "path {path:?}");
        }
    }

    /// The loopback bound the broker enforces is the one the contract publishes.
    #[test]
    fn the_port_bound_comes_from_the_shipped_rules() {
        let rules = &shipped_bundle().scalar_rules;
        assert_eq!((rules.port_min, rules.port_max), (1024, 65_535));
        for (port, accepted) in [(1023, false), (1024, true), (65_535, true), (65_536, false)] {
            let issue = scalar_range_issue(
                BrokerScalarPlaceholder::ConnectorPort,
                &ScalarBindingValue::Number(port),
                rules,
            );
            assert_eq!(issue.is_none(), accepted, "port {port}");
        }
    }

    /// The opaque bound and charset the broker enforces are the ones the contract publishes.
    ///
    /// A secret is the one bound value a validator cannot check against an expected value, so length
    /// and charset are the whole of what can be asserted. Both edges are tested rather than one,
    /// because an off-by-one on the upper bound would silently truncate nothing and reject a valid
    /// token instead.
    #[test]
    fn the_opaque_bound_comes_from_the_shipped_rules() {
        let rules = &shipped_bundle().scalar_rules;
        assert_eq!((rules.opaque_min_chars, rules.opaque_max_chars), (32, 256));
        for (token, accepted) in [
            ("a".repeat(31), false),
            ("a".repeat(32), true),
            ("a".repeat(256), true),
            ("a".repeat(257), false),
            // URL-safe base64's two non-alphanumeric characters are accepted; standard base64's are
            // not, because this value has to survive as an environment variable unquoted.
            (format!("{}-_", "a".repeat(30)), true),
            (format!("{}+/", "a".repeat(30)), false),
        ] {
            let issue = scalar_range_issue(
                BrokerScalarPlaceholder::HostToken,
                &ScalarBindingValue::Text(token.clone()),
                rules,
            );
            assert_eq!(issue.is_none(), accepted, "token {}", token.len());
        }
    }

    /// A refused opaque scalar is refused without its value appearing in the refusal.
    ///
    /// This is the assertion that keeps the redaction obligation in `BROKER_OPAQUE_SCALARS` from being
    /// a comment: a refusal that echoed the rejected token would publish it to every log that records
    /// refusals, which is exactly what binding a secret is meant to avoid.
    #[test]
    fn a_refused_opaque_scalar_does_not_appear_in_its_refusal() {
        let secret = "short-but-recognizable-secret";
        let issue = scalar_range_issue(
            BrokerScalarPlaceholder::HostToken,
            &ScalarBindingValue::Text(secret.to_owned()),
            &shipped_bundle().scalar_rules,
        )
        .expect("a 29 character token is below the bound");
        assert!(
            !issue.contains(secret),
            "refusal echoed the secret: {issue}"
        );
    }

    #[test]
    fn local_path_rules_match_contract_rejections() {
        for path in [
            r"C:\payload\CON.txt",
            r"C:\payload\PAYLOA~1",
            r"C:\payload\bad<name",
            "C:\\payload\\control\u{001f}name",
        ] {
            assert!(
                canonicalize_local_windows_path(path).is_err(),
                "accepted {path:?}"
            );
        }
    }
}
