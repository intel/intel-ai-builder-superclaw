use super::*;

/// The Connector's service process: the staged agent Python interpreter running
/// `sandbox_manager.connector`.
pub fn resolve_connector(
    validated: &ValidatedStartRequest,
    tier: IsolationTier,
) -> io::Result<CatalogLaunchSpec> {
    let payload_root = path(validated, BrokerPathPlaceholder::PayloadRoot)?;
    let config = tier_directory(validated, BrokerPathPlaceholder::StateConfigRoot, tier)?;
    let data = tier_directory(validated, BrokerPathPlaceholder::StateDataRoot, tier)?;
    let temp = tier_directory(validated, BrokerPathPlaceholder::StateTempRoot, tier)?;
    let loopback = loopback_host(validated)?;
    let connector_port = port(validated, BrokerScalarPlaceholder::ConnectorPort)?;

    let executable = agent_python_directory(payload_root).join("python.exe");
    // The provider configuration lives in the Connector tier's owner-written, read-only config
    // subtree. The Connector requires the file to exist and
    // re-exports its path as `SC_RUNTIME_CONFIG_FILE` itself, which is why nothing here sets that
    // variable.
    //
    // `native_backend.py::_start_broker_roles` writes it at exactly this path, as the owner, before it
    // starts this role. The ordering is load-bearing and worth stating: `connector.py` calls
    // `parser.error` and exits 2 on a missing runtime config file *before* it reads its bootstrap line,
    // so a write that landed after the launch would present as a broken stdin pipe or as a process that
    // left its Job before settling rather than as a missing file.
    let runtime_config = config.join("superclaw").join("connector-provider.json");
    let arguments = vec![
        "-m".to_owned(),
        "sandbox_manager.connector".to_owned(),
        "--host".to_owned(),
        loopback.to_owned(),
        "--port".to_owned(),
        connector_port.to_owned(),
        "--runtime-config-file".to_owned(),
        text(&runtime_config)?,
    ];

    Ok(CatalogLaunchSpec {
        command: command_line(&executable, &arguments)?,
        executable,
        // `python -m` puts the working directory at the front of `sys.path`, and the packaged service
        // tree is what contains the `sandbox_manager` package. That is why the working directory is
        // load-bearing here and why no `PYTHONPATH` is declared: one mechanism, not two.
        current_directory: payload_root.join("connector-service"),
        job_profile: JobLimitProfile::for_tier(tier),
        environment: declared(&[
            // The payload tree is read-only to every tier, so a bytecode write would fail on every
            // import. Refusing to try is quieter than failing repeatedly.
            ("PYTHONDONTWRITEBYTECODE", "1".to_owned()),
            // Standard output is a file here, so CPython would block-buffer it and a log would lag
            // its process by kilobytes - including across a crash, which is the moment the log is
            // read.
            ("PYTHONUNBUFFERED", "1".to_owned()),
            ("TEMP", text(&temp)?),
            ("TMP", text(&temp)?),
        ]),
        // Named, not generated. The bootstrap carries two symmetric keys, and both hops resolve this
        // same request: generating it here would mint a live key pair inside the owner process as well,
        // which would then be discarded unused. The tier runner is the only place that mints one.
        stdin: RoleStdin::ConnectorBootstrap {
            search_module: data.join("superclaw").join("sc_tavily_search.py"),
            endpoint: format!("http://{loopback}:{connector_port}/v1/connector"),
        },
        log_directory: log_directory(validated, tier)?,
    })
}
