//! Product wire types for sandbox_manager → broker (contracts PR2).
//!
//! JSON shapes are shared with `shared/contracts` golden fixtures. This module does not
//! perform Win32 work; it validates and refuses forbidden caller fields.

use serde::Deserialize;
use serde_json::Value;
use std::fmt;

pub const BROKER_WIRE_CONTRACT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerWireError {
    InvalidJson,
    InvalidField,
    UnknownField,
    ForbiddenCallerField {
        field: String,
        reason_code: &'static str,
    },
}

impl BrokerWireError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid_json",
            Self::InvalidField => "invalid_field",
            Self::UnknownField => "unknown_field",
            Self::ForbiddenCallerField { reason_code, .. } => reason_code,
        }
    }

    pub fn is_permission_class(&self) -> bool {
        matches!(self, Self::InvalidField | Self::InvalidJson)
    }
}

const FORBIDDEN_FIELD_CODES: &[(&str, &str)] = &[
    ("executable", "forbidden_executable_path"),
    ("executable_path", "forbidden_executable_path"),
    ("program", "forbidden_executable_path"),
    ("program_path", "forbidden_executable_path"),
    ("command_line", "forbidden_command_line"),
    ("commandline", "forbidden_command_line"),
    ("argv", "forbidden_command_line"),
    ("shell", "forbidden_shell"),
    ("env", "forbidden_free_env"),
    ("environment", "forbidden_free_env"),
];

/// Refuses a payload that carries an executable path, a command line, a shell or a free environment
/// anywhere inside it, at any depth.
///
/// Public because the provision pipe needs exactly this scan and cannot get it from a parse: its two
/// payloads are contract objects it forwards to a validator rather than fields it deserializes into a
/// struct, so `deny_unknown_fields` never sees them. The elevated broker is the one process where a
/// smuggled `command_line` would matter most, so it runs the same closed list every other wire entry does
/// rather than a copy of it.
pub fn scan_forbidden_caller_fields(value: &Value) -> Option<BrokerWireError> {
    scan_forbidden_fields(value)
}

fn scan_forbidden_fields(value: &Value) -> Option<BrokerWireError> {
    match value {
        Value::Array(items) => {
            for item in items {
                if let Some(error) = scan_forbidden_fields(item) {
                    return Some(error);
                }
            }
            None
        }
        Value::Object(map) => {
            for (key, member) in map {
                for (forbidden, code) in FORBIDDEN_FIELD_CODES {
                    if key == forbidden {
                        return Some(BrokerWireError::ForbiddenCallerField {
                            field: key.clone(),
                            reason_code: code,
                        });
                    }
                }
                if let Some(error) = scan_forbidden_fields(member) {
                    return Some(error);
                }
            }
            None
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerPathPlaceholder {
    PayloadRoot,
    WorkspaceRoot,
    StateConfigRoot,
    StateDataRoot,
    StateLogsRoot,
    StateTempRoot,
    StateProtectedRoot,
    IsolationRoot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerScalarPlaceholder {
    LoopbackHost,
    SupervisorPort,
    RuntimePort,
    RouterHealthPort,
    ConnectorPort,
    EgressProxyShellPort,
    EgressProxyChannelPort,
    HdrPort,
    LlmrouterPort,
    HdrApiToken,
    HdrReadyToken,
    HdrEnabled,
    HostToken,
    HostTokenSha256,
    OpenworkToken,
    RouterControlToken,
    RouterScopedToken,
    LrmApiKey,
    PrivacyApiKey,
    RuntimePassword,
    IntentClassifierToken,
    RuntimeDeploymentB64,
    RuntimeDesiredFingerprint,
    RuntimeInstanceId,
    RuntimeLaunchAttemptId,
    LocalProxyUrl,
    LocalProxyBypass,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerPathPlaceholderBinding {
    pub placeholder: BrokerPathPlaceholder,
    pub path: String,
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerScalarPlaceholderBinding {
    pub placeholder: BrokerScalarPlaceholder,
    pub value: ScalarBindingValue,
}

impl fmt::Debug for BrokerScalarPlaceholderBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BrokerScalarPlaceholderBinding")
            .field("placeholder", &self.placeholder)
            .field("value", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum ScalarBindingValue {
    Text(String),
    Number(u64),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerStartRequest {
    pub contract_version: u32,
    pub manifest_version: u32,
    pub manifest_digest: String,
    pub launch_role: String,
    pub workspace_root_id: Option<String>,
    pub path_bindings: Vec<BrokerPathPlaceholderBinding>,
    pub scalar_bindings: Vec<BrokerScalarPlaceholderBinding>,
}

// There is deliberately no request type here to match `BrokerAclApplyWireResponse`. An ACL plan reaches
// the elevated side over the provision pipe and nowhere else, so a second parser for a second shape of ACL
// apply request would be a privileged entry point with no caller - and the next person to need one would
// find it already written.

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerAclApplyWireResponse {
    pub contract_version: u32,
    pub operation_id: String,
    pub observation: Value,
}

pub fn parse_start_request(payload: &[u8]) -> Result<BrokerStartRequest, BrokerWireError> {
    let value: Value = serde_json::from_slice(payload).map_err(|_| BrokerWireError::InvalidJson)?;
    if let Some(error) = scan_forbidden_fields(&value) {
        return Err(error);
    }
    serde_json::from_value(value).map_err(|_| BrokerWireError::InvalidField)
}

pub fn parse_acl_apply_response(
    payload: &[u8],
) -> Result<BrokerAclApplyWireResponse, BrokerWireError> {
    let value: Value = serde_json::from_slice(payload).map_err(|_| BrokerWireError::InvalidJson)?;
    serde_json::from_value(value).map_err(|_| BrokerWireError::InvalidField)
}

pub fn canonical_wire_json(value: &Value) -> Result<String, BrokerWireError> {
    fn canonicalize(value: &Value) -> Result<String, BrokerWireError> {
        match value {
            Value::Array(items) => {
                let parts: Result<Vec<_>, _> = items.iter().map(canonicalize).collect();
                Ok(format!("[{}]", parts?.join(",")))
            }
            Value::Object(map) => {
                let mut keys: Vec<_> = map.keys().collect();
                keys.sort();
                let mut parts = Vec::with_capacity(keys.len());
                for key in keys {
                    let member = map.get(key).expect("key present");
                    parts.push(format!(
                        "{}:{}",
                        serde_json::to_string(key).map_err(|_| BrokerWireError::InvalidJson)?,
                        canonicalize(member)?
                    ));
                }
                Ok(format!("{{{}}}", parts.join(",")))
            }
            _ => serde_json::to_string(value).map_err(|_| BrokerWireError::InvalidJson),
        }
    }
    canonicalize(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn forbidden_launch_fields_use_distinct_reason_codes() {
        let executable = serde_json::json!({
            "contract_version": 1,
            "manifest_version": 1,
            "manifest_digest": "00".repeat(32),
            "launch_role": "test_fixed_sleep_child",
            "workspace_root_id": null,
            "path_bindings": [],
            "scalar_bindings": [],
            "executable": "C:\\\\Windows\\\\System32\\\\cmd.exe"
        });
        let error =
            parse_start_request(&serde_json::to_vec(&executable).expect("value should serialize"))
                .expect_err("executable field should be refused");
        assert_eq!(
            error,
            BrokerWireError::ForbiddenCallerField {
                field: "executable".to_owned(),
                reason_code: "forbidden_executable_path",
            }
        );
        assert_ne!(
            error.reason_code(),
            crate::protocol::ProtocolError::InvalidField.code()
        );
    }

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
    fn valid_start_request_fixture_parses() {
        let request = parse_start_request(&fixture("valid-start-request.json"))
            .expect("valid start request should parse");
        assert_eq!(request.contract_version, BROKER_WIRE_CONTRACT_VERSION);
        assert_eq!(request.launch_role, "test_fixed_sleep_child");
    }

    #[test]
    fn forbidden_executable_field_is_distinct_from_invalid_field() {
        let error = parse_start_request(&fixture("invalid-forbidden-executable.json"))
            .expect_err("forbidden executable should be rejected");
        assert_eq!(error.reason_code(), "forbidden_executable_path");
        assert!(!error.is_permission_class());
    }

    #[test]
    fn forbidden_command_line_fixture() {
        let error = parse_start_request(&fixture("invalid-forbidden-command-line.json"))
            .expect_err("command line should be rejected");
        assert_eq!(error.reason_code(), "forbidden_command_line");
    }

    #[test]
    fn forbidden_shell_fixture() {
        let error = parse_start_request(&fixture("invalid-forbidden-shell.json"))
            .expect_err("shell should be rejected");
        assert_eq!(error.reason_code(), "forbidden_shell");
    }

    #[test]
    fn forbidden_free_env_fixture() {
        let error = parse_start_request(&fixture("invalid-forbidden-env.json"))
            .expect_err("free env should be rejected");
        assert_eq!(error.reason_code(), "forbidden_free_env");
    }

    #[test]
    fn unknown_top_level_field_rejected() {
        let error = parse_start_request(&fixture("invalid-unknown-field.json"))
            .expect_err("unknown field should be rejected");
        assert_eq!(error, BrokerWireError::InvalidField);
    }

    #[test]
    fn acl_apply_wire_response_fixture_parses() {
        let response = parse_acl_apply_response(&fixture("valid-acl-apply-wire-response.json"))
            .expect("apply response should parse");
        assert_eq!(response.operation_id, "sm:apply-acl-1");
        assert!(response.observation.is_object());
    }

    #[test]
    fn canonical_wire_json_matches_fixture() {
        let value: Value =
            serde_json::from_slice(&fixture("valid-start-request.json")).expect("fixture json");
        let canonical = canonical_wire_json(&value).expect("canonicalize");
        assert!(canonical.contains("\"contract_version\":1"));
    }
}
