//! Resolve validated start requests into closed launch specs (no caller argv/path).
//!
//! This module decides *which* role a request is and what its tier and Job profile are. What each
//! role actually runs lives in `catalog_roles`, so the dispatch stays readable beside the assembly.

use crate::catalog_roles::{
    log_directory, resolve_connector, resolve_egress_proxy, resolve_hdr_sidecar,
    resolve_opencode_router, resolve_openwork_server, resolve_runtime, resolve_supervisor,
};
use crate::job::JobLimitProfile;
use crate::launch_catalog::{ValidatedStartRequest, catalog_entry_for_role};
use crate::launch_spec::{CatalogLaunchSpec, RoleStdin, command_line};
use crate::tier::IsolationTier;
use std::io;

pub const TEST_BROKER_EXE_DIGEST: &str =
    "0000000000000000000000000000000000000000000000000000000000000001";

#[derive(Debug, Clone)]
pub struct ResolvedCatalogLaunch {
    pub launch_role: String,
    pub tier: IsolationTier,
    #[allow(dead_code)]
    pub executable_sha256: String,
    pub spec: CatalogLaunchSpec,
}

pub fn resolve_validated_start(
    validated: &ValidatedStartRequest,
) -> io::Result<ResolvedCatalogLaunch> {
    let entry = catalog_entry_for_role(&validated.request.launch_role).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "launch role is not in the startup catalog",
        )
    })?;
    let tier = identity_tier_for_id(&entry.identity_id)?;

    // Each role's own resolution decides its Job profile, from the tier the catalog gave it. There is
    // no second table here mapping role to profile: two tables would be two places for the same
    // decision, and the one that was not edited would win silently.
    let spec = match validated.request.launch_role.as_str() {
        "test_fixed_sleep_child" => {
            resolve_test_fixed_sleep_child(&entry.executable_sha256, validated, tier)?
        }
        "supervisor_executable" => resolve_supervisor(validated, tier)?,
        "token_service_executable" => resolve_openwork_server(validated, tier)?,
        "connector_executable" => resolve_opencode_router(validated, tier)?,
        "runtime_executable" => resolve_runtime(validated, tier)?,
        "connector_service" => resolve_connector(validated, tier)?,
        "egress_proxy" => resolve_egress_proxy(validated, tier)?,
        "hdr_sidecar" => resolve_hdr_sidecar(validated, tier)?,
        role => {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                format!("the shipped catalog declares no launch assembly for {role}"),
            ));
        }
    };

    Ok(ResolvedCatalogLaunch {
        launch_role: validated.request.launch_role.clone(),
        tier,
        executable_sha256: entry.executable_sha256.clone(),
        spec,
    })
}

fn resolve_test_fixed_sleep_child(
    expected_digest: &str,
    validated: &ValidatedStartRequest,
    tier: IsolationTier,
) -> io::Result<CatalogLaunchSpec> {
    if expected_digest != TEST_BROKER_EXE_DIGEST {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "test_fixed_sleep_child catalog digest does not match the broker test sentinel",
        ));
    }
    let executable = std::env::current_exe()?.with_file_name(format!(
        "native_isolation_test_child{}",
        std::env::consts::EXE_SUFFIX
    ));
    // The only role whose working directory comes from where its program sits rather than from a bound
    // root: it is the broker's own test child, shipped beside the broker, and it binds no workspace.
    let current_directory = executable
        .parent()
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "the test child executable has no parent directory",
            )
        })?
        .to_owned();
    let arguments = vec!["--sleep-ms".to_owned(), "60000".to_owned()];
    Ok(CatalogLaunchSpec {
        command: command_line(&executable, &arguments)?,
        executable,
        current_directory,
        job_profile: JobLimitProfile::FixedSleepTest,
        // Declared here for the same reason the command line is: this role's whole surface is fixed
        // by the adapter, never by the caller. The probe makes the test child spawn one grandchild so
        // the Job boundary can be exercised against a process this adapter did not launch. Only the
        // same-account path applies the overlay, so the foreign-token path is unaffected.
        environment: vec![("SUPERCLAW_TEST_ROLE_PROBE".to_owned(), "1".to_owned())],
        stdin: RoleStdin::Eof,
        // The test role goes through exactly the same derivation as a production one. That is the point
        // of it: the launch path that the integration tests exercise is the launch path that ships.
        log_directory: log_directory(validated, tier)?,
    })
}

fn identity_tier_for_id(identity_id: &str) -> io::Result<IsolationTier> {
    match identity_id {
        "ibid:tier_bootstrap" => Ok(IsolationTier::Bootstrap),
        "ibid:tier_file_tool" => Ok(IsolationTier::FileTool),
        "ibid:tier_network_connector" => Ok(IsolationTier::NetworkConnector),
        "ibid:tier_channel" => Ok(IsolationTier::Channel),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "catalog identity_id is not recognized",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker_wire::parse_start_request;
    use crate::launch_catalog::validate_start_request_bytes;
    use std::fs;
    use std::path::PathBuf;

    fn valid_fixture_bytes() -> Vec<u8> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("shared")
            .join("contracts")
            .join("fixtures")
            .join("native-isolation-broker")
            .join("valid-start-request.json");
        fs::read(path).expect("fixture")
    }

    #[test]
    fn test_fixed_sleep_child_resolves_to_broker_sentinel_digest() {
        let validated = validate_start_request_bytes(&valid_fixture_bytes()).expect("valid");
        let resolved = resolve_validated_start(&validated).expect("resolve");
        assert_eq!(resolved.launch_role, "test_fixed_sleep_child");
        assert_eq!(resolved.executable_sha256, TEST_BROKER_EXE_DIGEST);
        assert_eq!(resolved.spec.job_profile, JobLimitProfile::FixedSleepTest);
        assert_eq!(
            resolved
                .spec
                .executable
                .file_stem()
                .and_then(|value| value.to_str()),
            Some("native_isolation_test_child")
        );
        assert_eq!(
            resolved.spec.environment,
            vec![("SUPERCLAW_TEST_ROLE_PROBE".to_owned(), "1".to_owned())],
            "the test role declares its whole environment overlay in the resolution, not in a request"
        );
    }

    #[test]
    fn bootstrap_stage_uses_named_job_profile() {
        assert_eq!(
            JobLimitProfile::for_tier(IsolationTier::Bootstrap),
            JobLimitProfile::BootstrapTier
        );
    }

    /// Every role the catalog declares resolves, and each one lands in the tier, Job profile and
    /// tier-scoped log directory its own catalog entry implies.
    ///
    /// Driven off the shipped entries rather than a list here, so a role added to the catalog without a
    /// resolution fails as an `Unsupported` refusal in this test rather than at a caller.
    #[test]
    fn every_shipped_role_resolves_into_its_own_tier() {
        // `launch_catalog` proves the shared table covers every declared role; this guard is only so a
        // table that shrank to nothing could not make the loop below pass by never running.
        let positives = shared_positive_requests();
        assert!(
            positives.len() >= 4,
            "{} accepted requests",
            positives.len()
        );
        for positive in positives {
            let validated = validate_start_request_bytes(&positive).expect("an accepted request");
            let role = validated.request.launch_role.clone();
            let resolved = resolve_validated_start(&validated).unwrap_or_else(|error| {
                panic!("{role} is declared by the catalog and must resolve: {error}")
            });
            assert_eq!(resolved.tier, expected_tier(&role), "{role}");
            assert_eq!(
                resolved.spec.job_profile,
                if role == "test_fixed_sleep_child" {
                    JobLimitProfile::FixedSleepTest
                } else {
                    JobLimitProfile::for_tier(resolved.tier)
                },
                "{role}"
            );
            assert_eq!(
                resolved.spec.log_directory.file_name(),
                Some(std::ffi::OsStr::new(resolved.tier.as_str())),
                "{role} must log inside its own tier's subtree"
            );
            assert!(
                resolved.spec.executable.is_absolute(),
                "{role} resolved a relative program: {}",
                resolved.spec.executable.display()
            );
            assert!(
                resolved.spec.current_directory.is_absolute(),
                "{role} resolved a relative working directory"
            );
        }
    }

    /// Resolving the same request twice gives the same launch, for every shipped role.
    ///
    /// Both hops resolve the same request independently, so resolution has to be a pure function of it -
    /// otherwise the owner hop verifies and reports one launch while the runner performs another. This is
    /// also what keeps secret material out of the owner process: a resolution that generated the
    /// Connector's bootstrap would mint a live key pair in both hops, and it would fail here, because two
    /// bootstraps never match.
    #[test]
    fn resolving_the_same_request_twice_gives_the_same_launch() {
        for positive in shared_positive_requests() {
            let validated = validate_start_request_bytes(&positive).expect("an accepted request");
            let first = resolve_validated_start(&validated).expect("resolves");
            let second = resolve_validated_start(&validated).expect("resolves");
            let role = &validated.request.launch_role;
            assert_eq!(first.tier, second.tier, "{role}");
            assert_eq!(first.spec.executable, second.spec.executable, "{role}");
            assert_eq!(first.spec.command, second.spec.command, "{role}");
            assert_eq!(
                first.spec.current_directory, second.spec.current_directory,
                "{role}"
            );
            assert_eq!(first.spec.environment, second.spec.environment, "{role}");
            assert_eq!(
                first.spec.log_directory, second.spec.log_directory,
                "{role}"
            );
            assert_eq!(
                first.spec.stdin, second.spec.stdin,
                "{role} resolved a different standard input the second time, so resolution is not a \
                 pure function of the request"
            );
        }
    }

    #[test]
    fn bound_secrets_are_redacted_from_every_debug_layer() {
        for (role, placeholder, debug_name, env_name) in [
            (
                "hdr_sidecar",
                "hdr_api_token",
                "HdrApiToken",
                "HYBRID_DR_API_TOKEN",
            ),
            (
                "hdr_sidecar",
                "hdr_ready_token",
                "HdrReadyToken",
                "HYBRID_DR_READY_TOKEN",
            ),
            (
                "token_service_executable",
                "hdr_api_token",
                "HdrApiToken",
                "HYBRID_DR_API_TOKEN",
            ),
            (
                "supervisor_executable",
                "runtime_password",
                "RuntimePassword",
                "OPENWORK_OPENCODE_PASSWORD",
            ),
            (
                "token_service_executable",
                "runtime_password",
                "RuntimePassword",
                "OPENWORK_OPENCODE_PASSWORD",
            ),
            (
                "connector_executable",
                "runtime_password",
                "RuntimePassword",
                "OPENCODE_SERVER_PASSWORD",
            ),
            (
                "runtime_executable",
                "runtime_password",
                "RuntimePassword",
                "OPENCODE_SERVER_PASSWORD",
            ),
            (
                "supervisor_executable",
                "intent_classifier_token",
                "IntentClassifierToken",
                "INTENT_CLASSIFIER_TOKEN",
            ),
            (
                "token_service_executable",
                "intent_classifier_token",
                "IntentClassifierToken",
                "INTENT_CLASSIFIER_TOKEN",
            ),
            (
                "connector_executable",
                "intent_classifier_token",
                "IntentClassifierToken",
                "INTENT_CLASSIFIER_TOKEN",
            ),
        ] {
            let secret = "hdr-secret-SENTINEL-0123456789abcdef";
            let mut request: serde_json::Value = shared_positive_requests()
                .into_iter()
                .map(|payload| serde_json::from_slice(&payload).expect("fixture request"))
                .find(|request: &serde_json::Value| request["launch_role"] == role)
                .expect("the shared table carries the role");
            let binding = request["scalar_bindings"]
                .as_array_mut()
                .expect("scalar bindings")
                .iter_mut()
                .find(|binding| binding["placeholder"] == placeholder)
                .expect("the fixture binds the secret");
            binding["value"] = serde_json::Value::String(secret.to_owned());
            let payload = serde_json::to_vec(&request).expect("serialize request");

            let parsed = parse_start_request(&payload).expect("wire request parses");
            let validated = validate_start_request_bytes(&payload).expect("request validates");
            let resolved = resolve_validated_start(&validated).expect("the role resolves");

            for formatted in [
                format!("{parsed:?}"),
                format!("{validated:?}"),
                format!("{resolved:?}"),
            ] {
                assert!(
                    !formatted.contains(secret),
                    "secret reached Debug: {formatted}"
                );
            }
            assert!(format!("{parsed:?}").contains(debug_name));
            assert!(
                format!("{resolved:?}").contains(env_name),
                "the environment name remains diagnosable while its value is redacted"
            );
        }
    }

    /// A role name outside the catalog is refused rather than launched, which is what keeps the closed
    /// catalog closed. `shell_executable` is in the vocabulary and is started by the runtime rather than
    /// the broker, so it is the case most likely to be added here by mistake.
    ///
    /// `connector_executable` and `token_service_executable` used to be listed here. They have entries
    /// now, and the positive cases in the shared table are what asserts they resolve; leaving them here
    /// would have been a test that passed by describing the tree as it no longer is.
    #[test]
    fn a_role_the_catalog_declares_no_entry_for_is_refused() {
        let mut request: serde_json::Value =
            serde_json::from_slice(&valid_fixture_bytes()).expect("fixture json");
        let role = "shell_executable";
        request["launch_role"] = serde_json::Value::String(role.to_owned());
        let refusal =
            validate_start_request_bytes(&serde_json::to_vec(&request).expect("serialize"))
                .expect_err("only a declared role may start");
        assert_eq!(refusal.reason, "launch_role_unknown", "{role}");
    }

    fn expected_tier(role: &str) -> IsolationTier {
        let entry = crate::launch_catalog::catalog_entry_for_role(role).expect("a shipped entry");
        identity_tier_for_id(&entry.identity_id).expect("a known identity")
    }

    /// The shared cross-language accepted requests, one per shipped role.
    fn shared_positive_requests() -> Vec<Vec<u8>> {
        let cases: serde_json::Value = serde_json::from_slice(
            &fs::read(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("..")
                    .join("shared")
                    .join("contracts")
                    .join("test-fixtures")
                    .join("native-isolation-broker-cases.json"),
            )
            .expect("the shared case table should be readable"),
        )
        .expect("the shared case table should be JSON");
        cases["valid_starts"]
            .as_array()
            .expect("valid_starts array")
            .iter()
            .map(|positive| serde_json::to_vec(&positive["request"]).expect("serialize"))
            .collect()
    }
}
