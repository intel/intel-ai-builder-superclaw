use super::*;

/// The network connector tier's second process: the staged agent Python interpreter running
/// `sandbox_manager.egress_proxy`, the CONNECT proxy for the shell's and the router's general egress.
///
/// Interpreter, working directory and environment are the Connector's, for the Connector's reasons.
/// Two listeners rather than one, because the port a connection arrives on is how the proxy tells the
/// shell from the router.
pub fn resolve_egress_proxy(
    validated: &ValidatedStartRequest,
    tier: IsolationTier,
) -> io::Result<CatalogLaunchSpec> {
    let payload_root = path(validated, BrokerPathPlaceholder::PayloadRoot)?;
    let config = tier_directory(validated, BrokerPathPlaceholder::StateConfigRoot, tier)?;
    let temp = tier_directory(validated, BrokerPathPlaceholder::StateTempRoot, tier)?;
    let loopback = loopback_host(validated)?;
    let shell_port = port(validated, BrokerScalarPlaceholder::EgressProxyShellPort)?;
    let channel_port = port(validated, BrokerScalarPlaceholder::EgressProxyChannelPort)?;

    let executable = agent_python_directory(payload_root).join("python.exe");
    // The upstream proxy and the audit path, written by the owner beside `connector-provider.json`
    // before this role starts. It holds no key, which is why this role reads nothing on stdin.
    let config_file = config.join("superclaw").join("egress-proxy.json");
    let arguments = vec![
        "-m".to_owned(),
        "sandbox_manager.egress_proxy".to_owned(),
        "--host".to_owned(),
        loopback.to_owned(),
        "--shell-port".to_owned(),
        shell_port.to_owned(),
        "--channel-port".to_owned(),
        channel_port.to_owned(),
        "--config-file".to_owned(),
        text(&config_file)?,
    ];

    Ok(CatalogLaunchSpec {
        command: command_line(&executable, &arguments)?,
        executable,
        current_directory: payload_root.join("connector-service"),
        job_profile: JobLimitProfile::for_tier(tier),
        environment: declared(&[
            ("PYTHONDONTWRITEBYTECODE", "1".to_owned()),
            ("PYTHONUNBUFFERED", "1".to_owned()),
            ("TEMP", text(&temp)?),
            ("TMP", text(&temp)?),
        ]),
        stdin: RoleStdin::Eof,
        log_directory: log_directory(validated, tier)?,
    })
}
