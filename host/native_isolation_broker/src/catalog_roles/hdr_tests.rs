//! Resolution tests for `hdr_sidecar`, split from `tests.rs` for the crate's line limit.

use super::tests::{
    CONFIG, DATA, HDR_READY_TOKEN, HOST_TOKEN, LOGS, LRM_API_KEY, PAYLOAD, TEMP, WORKSPACE,
    validated, value,
};
use super::*;
use std::collections::BTreeSet;
use std::path::PathBuf;

#[test]
fn the_hdr_sidecar_launch_is_fixed_by_its_role() {
    let spec = resolve_hdr_sidecar(&validated("hdr_sidecar"), IsolationTier::FileTool)
        .expect("the shared HDR request resolves");

    assert_eq!(
        spec.executable,
        PathBuf::from(PAYLOAD)
            .join("py")
            .join("hybrid-dr-venv")
            .join("Scripts")
            .join("python.exe")
    );
    assert_eq!(
        spec.command,
        format!(
            r"{PAYLOAD}\py\hybrid-dr-venv\Scripts\python.exe -m uvicorn hybrid_dr_orchestrator.api.serve:make_app --factory --host 127.0.0.1 --port 47825"
        )
    );
    assert_eq!(
        spec.current_directory,
        PathBuf::from(TEMP).join("file_tool")
    );
    assert_eq!(spec.log_directory, PathBuf::from(LOGS).join("file_tool"));
    assert_eq!(spec.job_profile, JobLimitProfile::FileToolTier);
    assert_eq!(spec.stdin, RoleStdin::Eof);
    assert_eq!(
        value(&spec, "HYBRID_DR_SESSION_ROOT"),
        format!(r"{DATA}\file_tool\hybrid-dr\sessions")
    );
    // The only root HDR may authorize local research files under, taken verbatim from the bound
    // `workspace_root` placeholder. No request field, argument or other variable names a root.
    assert_eq!(value(&spec, "HYBRID_DR_WORKSPACE_ROOT"), WORKSPACE);
    assert_eq!(
        value(&spec, "HYBRID_DR_LLMROUTER_URL"),
        "http://127.0.0.1:18321"
    );
    assert_eq!(
        value(&spec, "SUPERCLAW_CONNECTOR_CONFIG"),
        format!(r"{CONFIG}\file_tool\superclaw\connector-client.json")
    );
    assert_eq!(
        value(&spec, "SUPERCLAW_CONNECTOR_READER_PYTHON"),
        format!(r"{PAYLOAD}\py\agent-python-venv\Scripts\python.exe")
    );
    assert_eq!(
        value(&spec, "SUPERCLAW_CONNECTOR_READER_ROOT"),
        format!(r"{PAYLOAD}\connector-service")
    );
    assert_eq!(value(&spec, "PYTHONDONTWRITEBYTECODE"), "1");
    assert_eq!(value(&spec, "PYTHONUNBUFFERED"), "1");
    assert_eq!(value(&spec, "HYBRID_DR_NATIVE_MANAGED"), "1");
    assert_eq!(value(&spec, "HYBRID_DR_API_TOKEN"), HOST_TOKEN);
    assert_eq!(value(&spec, "HYBRID_DR_RUN_BUDGET_S"), HDR_RUN_BUDGET_S);
    assert_eq!(value(&spec, "LRM_API_KEY"), LRM_API_KEY);
    assert_eq!(value(&spec, "HYBRID_DR_READY_TOKEN"), HDR_READY_TOKEN);
    assert!(!spec.command.contains(HDR_READY_TOKEN));
    assert!(!spec.command.contains(HOST_TOKEN));
    assert!(!spec.command.contains(LRM_API_KEY));
    assert!(!spec.command.contains(WORKSPACE));
    assert_eq!(value(&spec, "TEMP"), format!(r"{TEMP}\file_tool"));
    assert_eq!(value(&spec, "TMP"), format!(r"{TEMP}\file_tool"));
    assert_eq!(value(&spec, "TMPDIR"), format!(r"{TEMP}\file_tool"));

    // The whole declared set, so a later variable - a second root, an endpoint, a credential - is a
    // reviewed change to this list rather than something the resolver can grow silently.
    let declared: BTreeSet<&str> = spec
        .environment
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    let expected: BTreeSet<&str> = [
        "HYBRID_DR_API_TOKEN",
        "HYBRID_DR_LLMROUTER_URL",
        "HYBRID_DR_NATIVE_MANAGED",
        "HYBRID_DR_READY_TOKEN",
        "HYBRID_DR_RUN_BUDGET_S",
        "HYBRID_DR_SESSION_ROOT",
        "HYBRID_DR_WORKSPACE_ROOT",
        "LRM_API_KEY",
        "PYTHONDONTWRITEBYTECODE",
        "PYTHONUNBUFFERED",
        "SUPERCLAW_CONNECTOR_CONFIG",
        "SUPERCLAW_CONNECTOR_READER_PYTHON",
        "SUPERCLAW_CONNECTOR_READER_ROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
    ]
    .into_iter()
    .collect();
    assert_eq!(declared, expected);
    assert_eq!(
        declared.len(),
        spec.environment.len(),
        "no variable is declared twice"
    );
}

/// The root HDR is told is the bound placeholder and nothing a caller can steer around it: a
/// request that binds a different workspace path yields exactly that path, and a request without
/// one is refused rather than launched with no root.
#[test]
fn the_hdr_workspace_root_is_the_bound_placeholder() {
    let mut request = validated("hdr_sidecar");
    let other = r"C:\Users\tester\Projects\other";
    request
        .paths
        .insert(BrokerPathPlaceholder::WorkspaceRoot, other.to_owned());
    let spec =
        resolve_hdr_sidecar(&request, IsolationTier::FileTool).expect("a bound workspace resolves");
    assert_eq!(value(&spec, "HYBRID_DR_WORKSPACE_ROOT"), other);

    request.paths.remove(&BrokerPathPlaceholder::WorkspaceRoot);
    let refusal = resolve_hdr_sidecar(&request, IsolationTier::FileTool)
        .expect_err("HDR without a bound workspace root is refused");
    assert_eq!(refusal.kind(), io::ErrorKind::InvalidData);
    assert!(refusal.to_string().contains("workspace_root"), "{refusal}");
}
