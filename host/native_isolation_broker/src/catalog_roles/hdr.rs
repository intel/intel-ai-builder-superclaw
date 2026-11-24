use super::*;

pub(super) const HDR_RUN_BUDGET_S: &str = "3600";

pub(super) fn binary_flag(
    validated: &ValidatedStartRequest,
    placeholder: BrokerScalarPlaceholder,
    label: &str,
) -> io::Result<bool> {
    match scalar(validated, placeholder)? {
        "0" => Ok(false),
        "1" => Ok(true),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{label} must be 0 or 1"),
        )),
    }
}

/// Hybrid Deep Research HTTP sidecar under the file-tool identity.
///
/// Sandbox Manager launches this role for the `pro` Product Profile since #2662.
pub fn resolve_hdr_sidecar(
    validated: &ValidatedStartRequest,
    tier: IsolationTier,
) -> io::Result<CatalogLaunchSpec> {
    let payload_root = path(validated, BrokerPathPlaceholder::PayloadRoot)?;
    let workspace_root = path(validated, BrokerPathPlaceholder::WorkspaceRoot)?;
    let config = tier_directory(validated, BrokerPathPlaceholder::StateConfigRoot, tier)?;
    let data = tier_directory(validated, BrokerPathPlaceholder::StateDataRoot, tier)?;
    let temp = tier_directory(validated, BrokerPathPlaceholder::StateTempRoot, tier)?;
    let loopback = loopback_host(validated)?;
    let hdr_port = port(validated, BrokerScalarPlaceholder::HdrPort)?;
    let llmrouter_port = port(validated, BrokerScalarPlaceholder::LlmrouterPort)?;
    let api_token = scalar(validated, BrokerScalarPlaceholder::HdrApiToken)?;
    let lrm_api_key = scalar(validated, BrokerScalarPlaceholder::LrmApiKey)?;
    let ready_token = scalar(validated, BrokerScalarPlaceholder::HdrReadyToken)?;
    if api_token == ready_token {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "HDR tokens must be distinct",
        ));
    }

    let executable = payload_root
        .join("py")
        .join("hybrid-dr-venv")
        .join("Scripts")
        .join("python.exe");
    let arguments = vec![
        "-m".to_owned(),
        "uvicorn".to_owned(),
        "hybrid_dr_orchestrator.api.serve:make_app".to_owned(),
        "--factory".to_owned(),
        "--host".to_owned(),
        loopback.to_owned(),
        "--port".to_owned(),
        hdr_port.to_owned(),
    ];

    let mut environment = declared(&[
        ("HYBRID_DR_NATIVE_MANAGED", "1".to_owned()),
        ("HYBRID_DR_API_TOKEN", api_token.to_owned()),
        ("HYBRID_DR_READY_TOKEN", ready_token.to_owned()),
        (
            "HYBRID_DR_SESSION_ROOT",
            text(&data.join("hybrid-dr").join("sessions"))?,
        ),
        // The one root managed HDR authorizes local research files under. HDR takes it from here
        // only; no request field or tool argument can name another.
        ("HYBRID_DR_WORKSPACE_ROOT", text(workspace_root)?),
        (
            "HYBRID_DR_LLMROUTER_URL",
            format!("http://{loopback}:{llmrouter_port}"),
        ),
        ("HYBRID_DR_RUN_BUDGET_S", HDR_RUN_BUDGET_S.to_owned()),
        ("LRM_API_KEY", lrm_api_key.to_owned()),
        ("PYTHONDONTWRITEBYTECODE", "1".to_owned()),
        ("PYTHONUNBUFFERED", "1".to_owned()),
        ("TEMP", text(&temp)?),
        ("TMP", text(&temp)?),
        ("TMPDIR", text(&temp)?),
    ]);
    environment.extend(crate::catalog_runtime::connector_reader_environment(
        payload_root,
        &config,
    )?);

    Ok(CatalogLaunchSpec {
        command: command_line(&executable, &arguments)?,
        executable,
        // The tier root already exists before launch. A deeper HDR scratch directory is runtime state
        // and must not become a launch precondition the broker silently creates.
        current_directory: temp.clone(),
        job_profile: JobLimitProfile::for_tier(tier),
        environment,
        stdin: RoleStdin::Eof,
        log_directory: log_directory(validated, tier)?,
    })
}
