//! OTLP endpoint + edge-auth env wiring.
//!
//! **Precedence:** process env (non-empty) ? installer CI bake (`apply_packaged_observability_env`).
//! There is no in-source credential or endpoint fallback: both edge credentials and the collector
//! endpoint come only from the environment (`OTEL_EXPORTER_OTLP_ENDPOINT` /
//! `SUPERCLAW_EDGE_CREDENTIAL_ID` / `SUPERCLAW_OTLP_EDGE_TOKEN` / `SUPERCLAW_FEEDBACK_EDGE_TOKEN`)
//! or the CI/installer bake in [`build.rs`](../../../build.rs), which itself is sourced from a
//! CI/repo variable (see `.github/workflows/installer-build.yml`). Without either, export stays
//! unconfigured (fail closed) — see [`ensure_process_otlp_env_for_export`]. Debug builds also
//! read a gitignored `.env` file (see `.env.example`) as a convenience, never release builds.

fn baked_observability_stable_channel() -> bool {
    option_env!("SUPERCLAW_BAKED_BUILD_CHANNEL").is_some_and(|channel| channel.trim() == "stable")
}

fn baked_observability_value_present(value: Option<&'static str>) -> bool {
    value.is_some_and(|entry| !entry.trim().is_empty())
}

/// Any stable-channel bake field set without the full validated prod pack.
fn stable_baked_observability_partial_configuration() -> bool {
    let any_observability_bake = [
        option_env!("SUPERCLAW_BAKED_OTLP_ENDPOINT"),
        option_env!("SUPERCLAW_BAKED_OTLP_EDGE_TOKEN"),
        option_env!("SUPERCLAW_BAKED_FEEDBACK_EDGE_TOKEN"),
        option_env!("SUPERCLAW_BAKED_EDGE_CREDENTIAL_ID"),
        option_env!("SUPERCLAW_BAKED_EDGE_CREDENTIAL_REGISTRY"),
    ]
    .iter()
    .any(|value| baked_observability_value_present(*value));
    any_observability_bake && !baked_observability_targets_prod_registry()
}

/// Stable-channel installer bakes must include prod ingress URL, tokens, id, and registry together.
fn baked_observability_apply_allowed() -> bool {
    if !baked_observability_stable_channel() {
        return true;
    }
    let baked_credential_id = baked_observability_value_present(option_env!("SUPERCLAW_BAKED_EDGE_CREDENTIAL_ID"));
    if !baked_credential_id {
        return !stable_baked_observability_partial_configuration();
    }
    baked_observability_targets_prod_registry()
}

/// https scheme, no userinfo, no query/fragment — baseline shape for any collector URL this
/// module is willing to treat as a clean origin (no extra user-suppliable redirect/injection
/// surface). Does not anchor against any known host: there is no in-source "the real prod
/// domain" literal, so shape is all that can be verified in isolation.
fn is_structurally_clean_otlp_url(parsed: &url::Url) -> bool {
    parsed.scheme() == "https"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query().is_none()
        && parsed.fragment().is_none()
}

/// Baked base URL only (no `/v1/*` suffix) — used when validating the CI/installer bake's shape.
fn is_exact_stable_prod_otlp_endpoint(endpoint: &str) -> bool {
    let Ok(parsed) = url::Url::parse(endpoint.trim()) else {
        return false;
    };
    if !is_structurally_clean_otlp_url(&parsed) {
        return false;
    }
    matches!(parsed.path(), "" | "/")
}

/// Stable-channel baked endpoint, only once it passes the full validated prod pack check
/// ([`baked_observability_targets_prod_registry`]). This is the "known-good prod origin" used to
/// pair runtime endpoints against — sourced from whatever CI/repo variable this specific binary
/// was built with, not a hardcoded literal.
fn baked_stable_prod_otlp_origin() -> Option<&'static str> {
    if !baked_observability_targets_prod_registry() {
        return None;
    }
    option_env!("SUPERCLAW_BAKED_OTLP_ENDPOINT")
}

/// Pure comparison backing [`is_stable_prod_otlp_ingress`], split out so the anchor can be
/// injected directly in unit tests instead of coming from the compile-time `option_env!` bake
/// (which `cargo test` never has set — see [`baked_stable_prod_otlp_origin`]). `anchor` is the
/// known-good prod origin (`Some`) when this binary was baked with one, or `None` to fall back to
/// structural validation only.
fn is_stable_prod_otlp_ingress_against_anchor(endpoint: &str, anchor: Option<&str>) -> bool {
    let Ok(parsed) = url::Url::parse(endpoint.trim()) else {
        return false;
    };
    if !is_structurally_clean_otlp_url(&parsed) {
        return false;
    }
    if !matches!(
        parsed.path(),
        "" | "/" | "/v1/logs" | "/v1/metrics" | "/v1/traces"
    ) {
        return false;
    }
    let Some(anchor) = anchor else {
        return true;
    };
    let Ok(anchor) = url::Url::parse(anchor) else {
        return false;
    };
    parsed.host_str() == anchor.host_str()
        && parsed.port_or_known_default() == anchor.port_or_known_default()
}

/// Runtime export URLs: when this binary was baked with a validated prod endpoint, requires the
/// same origin (including OTLP HTTP signal paths); otherwise falls back to structural validation
/// only, trusting an operator's own explicit (non-baked) endpoint + registry configuration.
fn is_stable_prod_otlp_ingress(endpoint: &str) -> bool {
    is_stable_prod_otlp_ingress_against_anchor(endpoint, baked_stable_prod_otlp_origin())
}

/// True when the URL is an OTLP HTTP signal endpoint, not a collector base for `/feedback`.
fn otlp_endpoint_has_v1_signal_path(endpoint: &str) -> bool {
    let Ok(parsed) = url::Url::parse(endpoint.trim()) else {
        return false;
    };
    let path = parsed.path().trim_end_matches('/');
    matches!(path, "/v1/logs" | "/v1/metrics" | "/v1/traces")
}

/// Collector base suitable for appending [`FEEDBACK_INGRESS_PATH`] (not OTLP `/v1/*` signal URLs).
fn is_valid_feedback_ingest_otlp_base(base: &str, channel: &str) -> bool {
    if otlp_endpoint_has_v1_signal_path(base) {
        return false;
    }
    // [`is_stable_prod_otlp_ingress`] allows signal paths for export; feedback needs origin-only base.
    if channel == "stable"
        && is_stable_prod_otlp_ingress(base)
        && !is_exact_stable_prod_otlp_endpoint(base)
    {
        return false;
    }
    true
}

fn baked_observability_targets_prod_registry() -> bool {
    let Some(endpoint) = option_env!("SUPERCLAW_BAKED_OTLP_ENDPOINT") else {
        return false;
    };
    if !is_exact_stable_prod_otlp_endpoint(endpoint) {
        return false;
    }
    baked_observability_value_present(option_env!("SUPERCLAW_BAKED_OTLP_EDGE_TOKEN"))
        && baked_observability_value_present(option_env!("SUPERCLAW_BAKED_FEEDBACK_EDGE_TOKEN"))
        && baked_observability_value_present(option_env!("SUPERCLAW_BAKED_EDGE_CREDENTIAL_ID"))
        && option_env!("SUPERCLAW_BAKED_EDGE_CREDENTIAL_REGISTRY")
            .is_some_and(|value| value.trim() == "prod")
}

fn env_var_nonempty(key: &str) -> bool {
    std::env::var(key)
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
}

fn set_process_env_if_unset(key: &str, value: Option<&'static str>) {
    if env_var_nonempty(key) {
        return;
    }
    let Some(value) = value else {
        return;
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    std::env::set_var(key, trimmed);
}

/// Non-empty compile-time bake field only when [`baked_observability_apply_allowed`].
fn baked_observability_static_value(value: Option<&'static str>) -> Option<&'static str> {
    if !baked_observability_apply_allowed() {
        return None;
    }
    value.filter(|entry| !entry.trim().is_empty())
}

/// Apply installer/CI-baked observability env when process env is unset (`export-build`).
pub fn apply_packaged_observability_env() {
    if !baked_observability_apply_allowed() {
        return;
    }
    set_process_env_if_unset("OTEL_EXPORTER_OTLP_ENDPOINT", baked_otlp_endpoint());
    set_process_env_if_unset(
        "SUPERCLAW_EDGE_CREDENTIAL_ID",
        baked_observability_static_value(option_env!("SUPERCLAW_BAKED_EDGE_CREDENTIAL_ID")),
    );
    set_process_env_if_unset(
        "SUPERCLAW_OTLP_EDGE_TOKEN",
        baked_observability_static_value(option_env!("SUPERCLAW_BAKED_OTLP_EDGE_TOKEN")),
    );
    set_process_env_if_unset(
        "SUPERCLAW_FEEDBACK_EDGE_TOKEN",
        baked_observability_static_value(option_env!("SUPERCLAW_BAKED_FEEDBACK_EDGE_TOKEN")),
    );
    set_process_env_if_unset(
        "SUPERCLAW_BUILD_CHANNEL",
        baked_observability_static_value(option_env!("SUPERCLAW_BAKED_BUILD_CHANNEL")),
    );
    set_process_env_if_unset(
        "SUPERCLAW_EDGE_CREDENTIAL_REGISTRY",
        baked_observability_static_value(option_env!("SUPERCLAW_BAKED_EDGE_CREDENTIAL_REGISTRY")),
    );
    ensure_process_otlp_headers_env();
}

/// Set-if-unset each `KEY=value` line from a `.env`-style string (blank lines, `#` comments,
/// and surrounding quotes on the value are ignored). Split out from [`load_debug_env_file`] so
/// the parsing/precedence logic can be unit tested without touching the real filesystem.
fn apply_debug_env_contents(contents: &str) {
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"');
        if key.is_empty() || env_var_nonempty(key) {
            continue;
        }
        std::env::set_var(key, value);
    }
}

/// Test-only escape hatch so tests asserting "no credentials configured" behavior are not
/// contaminated by a developer's local `.env` file (see [`load_debug_env_file`]).
#[cfg(test)]
pub(crate) const SKIP_DEBUG_ENV_FILE_VAR: &str = "SUPERCLAW_TEST_SKIP_DEBUG_ENV_FILE";

/// Debug-only convenience: load edge-auth env vars from a gitignored `.env` file next to this
/// crate's `Cargo.toml` when the process env does not already set them, so local testing does
/// not need real credentials exported in the shell. Never applies to release builds.
fn load_debug_env_file() {
    #[cfg(test)]
    if env_var_nonempty(SKIP_DEBUG_ENV_FILE_VAR) {
        return;
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env");
    let Ok(contents) = std::fs::read_to_string(path) else {
        return;
    };
    apply_debug_env_contents(&contents);
}

/// Env / CI bake, then debug-only in-source endpoint default. Does not set the release
/// source fallback (avoids treating every process as "collector configured" at startup).
pub fn ensure_process_otlp_env() {
    if cfg!(debug_assertions) {
        load_debug_env_file();
    }
    if !env_var_nonempty("OTEL_EXPORTER_OTLP_ENDPOINT") {
        if let Some(baked) = baked_otlp_endpoint() {
            std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", baked);
        }
        // No further default: without a `.env` entry (debug) or a CI bake (release), the
        // endpoint stays unset and export stays unconfigured (fail closed).
    }
    ensure_process_otlp_headers_env();
}

/// Call immediately before OTLP/feedback export or forwarding URL into ServiceHub children
/// when product telemetry consent is on.
pub fn ensure_process_otlp_env_for_export() {
    ensure_process_otlp_env();
    ensure_process_otlp_headers_env();
}

/// True when `credential_id` is known (by CI bake) to be prod-only, so an explicit
/// `SUPERCLAW_EDGE_CREDENTIAL_REGISTRY=dev` override cannot launder it onto a non-prod
/// endpoint - registry and credential id are validated independently otherwise.
fn is_known_stable_prod_credential_id(credential_id: &str) -> bool {
    let trimmed = credential_id.trim();
    if trimmed.is_empty() {
        return false;
    }
    baked_observability_targets_prod_registry()
        && option_env!("SUPERCLAW_BAKED_EDGE_CREDENTIAL_ID")
            .is_some_and(|baked| baked.trim() == trimmed)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResolvedEdgeCredentialRegistry {
    Prod,
    Dev,
    Unset,
    /// Non-empty registry value that is not `prod` or `dev` (typos must not fall through to ID heuristics).
    Invalid,
}

/// Parse a trimmed registry literal. Empty means "not set at this layer"; any other unknown value is [`Invalid`].
fn classify_edge_credential_registry_literal(
    trimmed: &str,
) -> Option<ResolvedEdgeCredentialRegistry> {
    match trimmed {
        "prod" => Some(ResolvedEdgeCredentialRegistry::Prod),
        "dev" => Some(ResolvedEdgeCredentialRegistry::Dev),
        "" => None,
        _ => Some(ResolvedEdgeCredentialRegistry::Invalid),
    }
}

/// Process `SUPERCLAW_EDGE_CREDENTIAL_REGISTRY` wins over compile-time bake / prod pack proof.
fn resolved_edge_credential_registry() -> ResolvedEdgeCredentialRegistry {
    if let Ok(value) = std::env::var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY") {
        if let Some(resolved) = classify_edge_credential_registry_literal(value.trim()) {
            return resolved;
        }
    }
    if !baked_observability_apply_allowed() {
        return ResolvedEdgeCredentialRegistry::Unset;
    }
    if let Some(baked_registry) = option_env!("SUPERCLAW_BAKED_EDGE_CREDENTIAL_REGISTRY") {
        match baked_registry.trim() {
            "prod" | "" => {}
            "dev" => return ResolvedEdgeCredentialRegistry::Dev,
            _ => return ResolvedEdgeCredentialRegistry::Invalid,
        }
    }
    if baked_observability_targets_prod_registry() {
        return ResolvedEdgeCredentialRegistry::Prod;
    }
    ResolvedEdgeCredentialRegistry::Unset
}

/// Derived from [`resolved_edge_credential_registry`] only (process env beats bake; never OR both).
fn edge_credentials_registry_is_prod() -> bool {
    matches!(
        resolved_edge_credential_registry(),
        ResolvedEdgeCredentialRegistry::Prod
    )
}

fn edge_credentials_registry_is_dev() -> bool {
    matches!(
        resolved_edge_credential_registry(),
        ResolvedEdgeCredentialRegistry::Dev
    )
}

fn unclassified_otlp_headers_mismatch(
    registry: ResolvedEdgeCredentialRegistry,
    headers_present: bool,
    on_prod_ingress: bool,
) -> bool {
    registry == ResolvedEdgeCredentialRegistry::Unset && headers_present && !on_prod_ingress
}

/// Stable release: endpoint and credential must target the same ingress (prod vs dev).
fn stable_prod_credentials_mismatch(endpoint: &str, channel: &str, debug_build: bool) -> bool {
    if debug_build {
        return false;
    }
    // Do not rely on `channel` alone: process env could override telemetry channel on a
    // stable installer. Baked-stable release binaries always enforce prod/dev pairing.
    if channel != "stable" && !baked_observability_stable_channel() {
        return false;
    }
    let on_prod_ingress = is_stable_prod_otlp_ingress(endpoint);
    // Checked before the registry match: a known-prod credential id must never pair with a
    // non-prod ingress even if SUPERCLAW_EDGE_CREDENTIAL_REGISTRY is (mis)set to claim otherwise
    // (an explicit "prod" marker is not proof the loaded credential values are actually prod).
    if let Ok(credential_id) = std::env::var("SUPERCLAW_EDGE_CREDENTIAL_ID") {
        if is_known_stable_prod_credential_id(&credential_id) && !on_prod_ingress {
            return true;
        }
    }
    let credential_registry = resolved_edge_credential_registry();
    match credential_registry {
        ResolvedEdgeCredentialRegistry::Invalid => return true,
        ResolvedEdgeCredentialRegistry::Prod => return !on_prod_ingress,
        ResolvedEdgeCredentialRegistry::Dev => return on_prod_ingress,
        ResolvedEdgeCredentialRegistry::Unset => {}
    }
    // No registry metadata and no known-prod credential id: there is no in-source fallback id
    // to exempt, so a set credential id paired with a non-prod endpoint fails closed (it may
    // be a stray dev credential); pairing with the prod endpoint is trusted by default.
    if let Ok(credential_id) = std::env::var("SUPERCLAW_EDGE_CREDENTIAL_ID") {
        if !credential_id.trim().is_empty() && !on_prod_ingress {
            return true;
        }
    }
    unclassified_otlp_headers_mismatch(
        credential_registry,
        env_var_nonempty("OTEL_EXPORTER_OTLP_HEADERS"),
        on_prod_ingress,
    )
}

const OTEL_PER_SIGNAL_EXPORT_ENDPOINT_VARS: &[&str] = &[
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
];

const OTEL_EXPORT_ENV_KEYS_FOR_CHILDREN: &[&str] = &[
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
];

/// Base URL from [`otlp_endpoint_for_spawn`] plus any signal-specific OTLP overrides.
fn configured_otlp_export_endpoints() -> Vec<String> {
    configured_otlp_export_endpoints_for_child(&[])
}

fn otlp_env_value_for_child(key: &str, launch_env: &[(&'static str, String)]) -> Option<String> {
    if let Some((_, value)) = launch_env.iter().find(|(name, _)| *name == key) {
        let trimmed = value.trim();
        return if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }
    std::env::var(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// Effective OTLP export URLs for a ServiceHub child (`launch_target.env` overrides process env).
fn configured_otlp_export_endpoints_for_child(
    launch_env: &[(&'static str, String)],
) -> Vec<String> {
    let mut endpoints = Vec::new();
    if let Some(base) = otlp_env_value_for_child("OTEL_EXPORTER_OTLP_ENDPOINT", launch_env) {
        endpoints.push(base);
    }
    for key in OTEL_PER_SIGNAL_EXPORT_ENDPOINT_VARS {
        if let Some(value) = otlp_env_value_for_child(key, launch_env) {
            endpoints.push(value);
        }
    }
    endpoints
}

/// True when prod/stable credentials must not be sent to this OTLP URL.
pub(crate) fn otlp_endpoint_fails_stable_prod_guard(endpoint: &str) -> bool {
    stable_prod_credentials_mismatch(endpoint, &super::release_channel(), cfg!(debug_assertions))
}

/// Diagnostic-only label for logging: whether the active edge credential id matches the
/// compile-time bake exactly (`"baked"`), came from somewhere else (`"env"`), or is unset.
/// Best-effort — not used for any export decision, only for evidence/log readability.
pub(crate) fn otlp_credential_source_label() -> &'static str {
    match (
        std::env::var("SUPERCLAW_EDGE_CREDENTIAL_ID")
            .ok()
            .filter(|value| !value.trim().is_empty()),
        option_env!("SUPERCLAW_BAKED_EDGE_CREDENTIAL_ID")
            .filter(|value| !value.trim().is_empty()),
    ) {
        (Some(active), Some(baked)) if active.trim() == baked.trim() => "baked",
        (Some(_), _) => "env",
        (None, _) => "none",
    }
}

/// Diagnostic-only reason label for why export was refused, for logging at the
/// [`super::post_otlp_json`] call site. Mirrors the checks in [`stable_prod_credentials_mismatch`]
/// without duplicating the fail-closed decision itself.
pub(crate) fn otlp_export_refusal_reason(endpoint: &str) -> &'static str {
    let registry = resolved_edge_credential_registry();
    if registry == ResolvedEdgeCredentialRegistry::Invalid {
        return "invalid_credential_registry";
    }
    // Checked before the generic `otlp_export_configured` fallback below: that check already
    // folds this same guard in (via stable_prod_credentials_mismatch), so a mismatch would
    // otherwise always be masked behind the generic "export_not_configured" reason.
    if otlp_endpoint_fails_stable_prod_guard(endpoint) {
        let on_prod_ingress = is_stable_prod_otlp_ingress(endpoint);
        if unclassified_otlp_headers_mismatch(
            registry,
            env_var_nonempty("OTEL_EXPORTER_OTLP_HEADERS"),
            on_prod_ingress,
        ) {
            return "unclassified_registry_with_headers_on_nonprod_ingress";
        }
        return "stable_prod_credential_ingress_mismatch";
    }
    if !otlp_export_configured() {
        return "export_not_configured";
    }
    "unknown"
}

fn ensure_process_otlp_headers_env() {
    if resolved_edge_credential_registry() == ResolvedEdgeCredentialRegistry::Invalid {
        return;
    }
    if std::env::var_os("OTEL_EXPORTER_OTLP_HEADERS").is_some() {
        return;
    }
    let credential_id = std::env::var("SUPERCLAW_EDGE_CREDENTIAL_ID")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let edge_token = std::env::var("SUPERCLAW_OTLP_EDGE_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let (Some(credential_id), Some(edge_token)) = (credential_id, edge_token) else {
        return;
    };
    std::env::set_var(
        "OTEL_EXPORTER_OTLP_HEADERS",
        format!(
            "X-SuperClaw-Credential-Id={},X-SuperClaw-Edge-Token={}",
            credential_id.trim(),
            edge_token.trim()
        ),
    );
}

/// Pure channel/endpoint pairing check backing [`baked_otlp_endpoint`], split out so it is
/// testable without compile-time `option_env!` bake values (those are fixed at compile time and
/// cannot be set from a unit test).
/// Stable-channel bakes must be a well-formed origin-only URL. There is no known-literal host to
/// pair non-stable (dev/beta) bakes against anymore — an operator-run CI is expected to source
/// each channel's endpoint from its own distinct git/repo variable, so that separation is kept by
/// configuration rather than by comparing against an in-source "real prod domain" value.
fn baked_endpoint_channel_pairing_ok(stable_channel: bool, endpoint: &str) -> bool {
    if stable_channel {
        is_exact_stable_prod_otlp_endpoint(endpoint)
    } else {
        true
    }
}

/// Compile-time bake endpoint only when [`baked_observability_apply_allowed`] (same gate as
/// [`apply_packaged_observability_env`]); stable-channel bakes must pass
/// [`is_exact_stable_prod_otlp_endpoint`]. Partial or malformed stable bakes are invisible here.
fn baked_otlp_endpoint() -> Option<&'static str> {
    let endpoint = baked_observability_static_value(option_env!("SUPERCLAW_BAKED_OTLP_ENDPOINT"))?;
    if !baked_endpoint_channel_pairing_ok(baked_observability_stable_channel(), endpoint) {
        return None;
    }
    Some(endpoint)
}

pub fn otlp_endpoint_for_spawn() -> Option<String> {
    if let Ok(value) = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    baked_otlp_endpoint().map(|value| value.to_string())
}

/// Shared ALB path for in-app feedback ingest (matches `FEEDBACK_INGRESS_PATH` in infra).
pub const FEEDBACK_INGRESS_PATH: &str = "/feedback";

/// `{OTEL}/feedback` when the resolved base is safe to post to.
///
/// Process env wins over the baked value, so a pre-set dev endpoint is not
/// rewritten by [`ensure_process_otlp_env_for_export`]. Reject that base here
/// (same prod/dev mismatch as [`otlp_export_configured`]) instead of only
/// refusing to install the source fallback.
fn feedback_ingest_url(base: &str, channel: &str, debug_build: bool) -> Option<String> {
    if resolved_edge_credential_registry() == ResolvedEdgeCredentialRegistry::Invalid {
        return None;
    }
    if stable_prod_credentials_mismatch(base, channel, debug_build) {
        return None;
    }
    if !is_valid_feedback_ingest_otlp_base(base, channel) {
        return None;
    }
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.ends_with(FEEDBACK_INGRESS_PATH) {
        return Some(trimmed.to_string());
    }
    Some(format!("{trimmed}{FEEDBACK_INGRESS_PATH}"))
}

/// Resolves `{OTEL}/feedback` for ingest POSTs.
pub fn feedback_ingest_endpoint() -> Option<String> {
    ensure_process_otlp_env_for_export();
    let base = otlp_endpoint_for_spawn()?;
    feedback_ingest_url(&base, &super::release_channel(), cfg!(debug_assertions))
}

pub fn otlp_headers_for_spawn() -> Option<String> {
    ensure_process_otlp_headers_env();
    std::env::var("OTEL_EXPORTER_OTLP_HEADERS")
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn is_loopback_otlp_endpoint(endpoint: &str) -> bool {
    let Ok(parsed) = url::Url::parse(endpoint.trim()) else {
        return false;
    };
    matches!(
        parsed.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("::1")
    )
}

fn otlp_export_configured_for_child_launch_env_inner(
    launch_env: &[(&'static str, String)],
    debug_build: bool,
) -> bool {
    if resolved_edge_credential_registry() == ResolvedEdgeCredentialRegistry::Invalid {
        return false;
    }
    let endpoints = configured_otlp_export_endpoints_for_child(launch_env);
    if endpoints.is_empty() {
        return false;
    }
    let channel = super::release_channel();
    if endpoints.iter().any(|endpoint| {
        stable_prod_credentials_mismatch(endpoint, &channel, debug_build)
    }) {
        return false;
    }
    let needs_headers = endpoints
        .iter()
        .any(|endpoint| !is_loopback_otlp_endpoint(endpoint));
    if !needs_headers {
        return true;
    }
    otlp_env_value_for_child("OTEL_EXPORTER_OTLP_HEADERS", launch_env)
        .is_some_and(|value| !value.trim().is_empty())
}

/// True when a collector URL is present and safe to export (remote endpoints need headers).
pub fn otlp_export_configured() -> bool {
    otlp_export_configured_for_child_launch_env_inner(&[], cfg!(debug_assertions))
}

fn otlp_export_env_key_set_in_launch(
    key: &str,
    launch_env: &[(&'static str, String)],
) -> bool {
    std::env::var_os(key).is_some() || launch_env.iter().any(|(name, _)| *name == key)
}

/// OTLP export env to apply when spawning ServiceHub (Tauri shell command).
pub(crate) struct OtlpChildExportEnvPatch {
    /// When true, set all [`OTEL_EXPORT_ENV_KEYS_FOR_CHILDREN`] to empty strings.
    pub strip_inherited: bool,
    pub endpoint: Option<String>,
    pub headers: Option<String>,
}

pub(crate) fn otlp_child_export_env_keys_to_strip() -> &'static [&'static str] {
    OTEL_EXPORT_ENV_KEYS_FOR_CHILDREN
}

fn otlp_child_export_env_patch_inner(
    launch_env: &[(&'static str, String)],
    debug_build: bool,
) -> OtlpChildExportEnvPatch {
    if !otlp_export_configured_for_child_launch_env_inner(launch_env, debug_build) {
        return OtlpChildExportEnvPatch {
            strip_inherited: true,
            endpoint: None,
            headers: None,
        };
    }
    OtlpChildExportEnvPatch {
        strip_inherited: false,
        endpoint: if otlp_export_env_key_set_in_launch("OTEL_EXPORTER_OTLP_ENDPOINT", launch_env) {
            None
        } else {
            otlp_endpoint_for_spawn()
        },
        headers: if otlp_export_env_key_set_in_launch("OTEL_EXPORTER_OTLP_HEADERS", launch_env) {
            None
        } else {
            otlp_headers_for_spawn()
        },
    }
}

/// Resolve child OTLP env: forward a validated endpoint + headers pair, or strip inherited
/// values when export is not configured (prod/dev mismatch, missing headers, etc.).
pub(crate) fn otlp_child_export_env_patch(
    launch_env: &[(&'static str, String)],
) -> OtlpChildExportEnvPatch {
    otlp_child_export_env_patch_inner(launch_env, cfg!(debug_assertions))
}

/// Env pairs to apply on ServiceHub spawn (empty values override inherited host OTLP config).
pub(crate) fn otlp_child_export_env_overrides(
    patch: &OtlpChildExportEnvPatch,
) -> Vec<(&'static str, String)> {
    if patch.strip_inherited {
        return OTEL_EXPORT_ENV_KEYS_FOR_CHILDREN
            .iter()
            .map(|key| (*key, String::new()))
            .collect();
    }
    let mut overrides = Vec::new();
    if let Some(endpoint) = &patch.endpoint {
        overrides.push(("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint.clone()));
    }
    if let Some(headers) = &patch.headers {
        overrides.push(("OTEL_EXPORTER_OTLP_HEADERS", headers.clone()));
    }
    overrides
}

#[cfg(test)]
mod tests {
    use super::*;

    // Example-only domains for tests; this module never hardcodes a real collector host.
    // `cargo test` never has a CI bake present, so `baked_stable_prod_otlp_origin()` is always
    // `None` here — these two names are illustrative only, not distinguished by the code itself.
    const TEST_STABLE_ENDPOINT: &str = "https://otlp.example.com";
    const TEST_DEV_ENDPOINT: &str = "https://otlp-dev.example.com";

    #[test]
    fn apply_debug_env_contents_sets_unset_vars_only() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_unset = std::env::var_os("SUPERCLAW_TEST_DEBUG_ENV_UNSET_VAR");
        let prev_already_set = std::env::var_os("SUPERCLAW_TEST_DEBUG_ENV_ALREADY_SET_VAR");
        let prev_quoted = std::env::var_os("SUPERCLAW_TEST_DEBUG_ENV_QUOTED_VAR");
        std::env::remove_var("SUPERCLAW_TEST_DEBUG_ENV_UNSET_VAR");
        std::env::set_var("SUPERCLAW_TEST_DEBUG_ENV_ALREADY_SET_VAR", "from-process-env");

        apply_debug_env_contents(
            "# a comment\n\n\
             SUPERCLAW_TEST_DEBUG_ENV_UNSET_VAR=from-dot-env\n\
             SUPERCLAW_TEST_DEBUG_ENV_ALREADY_SET_VAR=should-not-override\n\
             SUPERCLAW_TEST_DEBUG_ENV_QUOTED_VAR=\"quoted-value\"\n",
        );

        assert_eq!(
            std::env::var("SUPERCLAW_TEST_DEBUG_ENV_UNSET_VAR").as_deref(),
            Ok("from-dot-env"),
            "unset var should be populated from file contents"
        );
        assert_eq!(
            std::env::var("SUPERCLAW_TEST_DEBUG_ENV_ALREADY_SET_VAR").as_deref(),
            Ok("from-process-env"),
            "already-set process env must win over file contents"
        );
        assert_eq!(
            std::env::var("SUPERCLAW_TEST_DEBUG_ENV_QUOTED_VAR").as_deref(),
            Ok("quoted-value"),
            "surrounding quotes on the value should be trimmed"
        );

        match prev_quoted {
            Some(v) => std::env::set_var("SUPERCLAW_TEST_DEBUG_ENV_QUOTED_VAR", v),
            None => std::env::remove_var("SUPERCLAW_TEST_DEBUG_ENV_QUOTED_VAR"),
        }
        match prev_unset {
            Some(v) => std::env::set_var("SUPERCLAW_TEST_DEBUG_ENV_UNSET_VAR", v),
            None => std::env::remove_var("SUPERCLAW_TEST_DEBUG_ENV_UNSET_VAR"),
        }
        match prev_already_set {
            Some(v) => std::env::set_var("SUPERCLAW_TEST_DEBUG_ENV_ALREADY_SET_VAR", v),
            None => std::env::remove_var("SUPERCLAW_TEST_DEBUG_ENV_ALREADY_SET_VAR"),
        }
    }

    #[test]
    fn stable_prod_credentials_trust_default_without_baked_anchor() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_registry = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        let prev_credential = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        std::env::set_var(
            "SUPERCLAW_EDGE_CREDENTIAL_ID",
            "build-prod-only-credential-id",
        );
        // `cargo test` has no CI bake, so there is no known-good prod origin to compare
        // against: any well-formed https endpoint is trusted as "prod ingress" by default,
        // so an unset/non-baked registry with a credential id configured never mismatches.
        assert!(!stable_prod_credentials_mismatch(TEST_DEV_ENDPOINT, "stable", false));
        assert!(!stable_prod_credentials_mismatch(TEST_STABLE_ENDPOINT, "stable", false));
        assert!(!stable_prod_credentials_mismatch(TEST_DEV_ENDPOINT, "dev", false));
        assert!(!stable_prod_credentials_mismatch(TEST_DEV_ENDPOINT, "stable", true));
        // A structurally malformed endpoint (userinfo) can never be "prod ingress", so it
        // still fails closed when a credential id is configured.
        assert!(stable_prod_credentials_mismatch(
            "https://user:pass@otlp.example.com",
            "stable",
            false
        ));
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", "prod");
        assert!(
            !stable_prod_credentials_mismatch(TEST_STABLE_ENDPOINT, "stable", false),
            "an explicit prod registry is trusted against any well-formed endpoint without a \
             baked anchor to prove otherwise"
        );
        assert!(!stable_prod_credentials_mismatch(TEST_DEV_ENDPOINT, "stable", false));
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", "dev");
        assert!(
            stable_prod_credentials_mismatch(TEST_STABLE_ENDPOINT, "stable", false),
            "an explicit dev registry can never be proven safe without a baked anchor, so it \
             always fails closed"
        );
        assert!(stable_prod_credentials_mismatch(TEST_DEV_ENDPOINT, "stable", false));
        match prev_registry {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY"),
        }
        match prev_credential {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
    }

    #[test]
    fn unclassified_headers_fail_closed_on_nonprod_ingress() {
        assert!(unclassified_otlp_headers_mismatch(
            ResolvedEdgeCredentialRegistry::Unset,
            true,
            false,
        ));
        assert!(!unclassified_otlp_headers_mismatch(
            ResolvedEdgeCredentialRegistry::Unset,
            true,
            true,
        ));
        assert!(!unclassified_otlp_headers_mismatch(
            ResolvedEdgeCredentialRegistry::Unset,
            false,
            false,
        ));
        assert!(!unclassified_otlp_headers_mismatch(
            ResolvedEdgeCredentialRegistry::Dev,
            true,
            false,
        ));
        assert!(!unclassified_otlp_headers_mismatch(
            ResolvedEdgeCredentialRegistry::Prod,
            true,
            false,
        ));
    }

    #[test]
    fn invalid_explicit_registry_fails_closed_on_pairing() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_endpoint = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_headers = std::env::var_os("OTEL_EXPORTER_OTLP_HEADERS");
        let prev_registry = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        let prev_credential = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", TEST_DEV_ENDPOINT);
        std::env::set_var(
            "OTEL_EXPORTER_OTLP_HEADERS",
            "X-SuperClaw-Credential-Id=a,X-SuperClaw-Edge-Token=b",
        );
        std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", "unclassified-credential-id");
        assert!(
            !stable_prod_credentials_mismatch(TEST_DEV_ENDPOINT, "stable", false),
            "unset registry is trusted for stable channel without a baked anchor to disprove it"
        );
        assert!(otlp_export_configured());
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", "prodd");
        assert_eq!(
            resolved_edge_credential_registry(),
            ResolvedEdgeCredentialRegistry::Invalid,
        );
        assert!(
            stable_prod_credentials_mismatch(TEST_DEV_ENDPOINT, "stable", false),
            "invalid registry must fail closed instead of falling through to ID heuristics"
        );
        assert!(stable_prod_credentials_mismatch(TEST_STABLE_ENDPOINT, "stable", false));
        assert!(!otlp_export_configured());
        match prev_endpoint {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_headers {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_HEADERS", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS"),
        }
        match prev_registry {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY"),
        }
        match prev_credential {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
    }

    #[test]
    fn classify_edge_credential_registry_literal_rejects_typos() {
        assert_eq!(
            classify_edge_credential_registry_literal("prod"),
            Some(ResolvedEdgeCredentialRegistry::Prod),
        );
        assert_eq!(
            classify_edge_credential_registry_literal("prodd"),
            Some(ResolvedEdgeCredentialRegistry::Invalid),
        );
        assert_eq!(classify_edge_credential_registry_literal(""), None);
    }

    #[test]
    fn stable_partial_bake_disallowed_when_observability_fields_present_without_id() {
        if !baked_observability_stable_channel() {
            return;
        }
        if baked_observability_value_present(option_env!("SUPERCLAW_BAKED_EDGE_CREDENTIAL_ID")) {
            return;
        }
        if stable_baked_observability_partial_configuration() {
            assert!(
                !baked_observability_apply_allowed(),
                "partial stable observability bake must not apply or resolve endpoints"
            );
            assert!(baked_otlp_endpoint().is_none());
        }
    }

    #[test]
    fn explicit_dev_registry_resolves_dev_and_always_mismatches_without_anchor() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_registry = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        let prev_credential = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", "dev");
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", "unclassified-credential-id");
        assert_eq!(
            resolved_edge_credential_registry(),
            ResolvedEdgeCredentialRegistry::Dev,
        );
        assert!(!edge_credentials_registry_is_prod());
        assert!(edge_credentials_registry_is_dev());
        assert!(
            !(edge_credentials_registry_is_prod() && edge_credentials_registry_is_dev()),
            "prod/dev registry flags must be mutually exclusive"
        );
        // Without a baked anchor, no endpoint can be disproven to be "prod ingress" (any
        // well-formed https endpoint defaults to trusted-as-prod), so an explicit dev registry
        // can never be confirmed safe and always fails closed, regardless of which endpoint
        // string is given.
        assert!(stable_prod_credentials_mismatch(TEST_STABLE_ENDPOINT, "stable", false));
        assert!(stable_prod_credentials_mismatch(TEST_DEV_ENDPOINT, "stable", false));
        match prev_registry {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY"),
        }
        match prev_credential {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
    }

    // Note: the literal-known-prod/dev-credential-id heuristics these two tests exercised were
    // removed with the hardcoded fallback credentials; is_known_stable_prod_credential_id now
    // only recognizes a credential id via the compile-time CI bake, which unit tests cannot set.

    #[test]
    fn baked_endpoint_pairing_allows_any_well_formed_endpoint_on_non_stable_channel() {
        // There is no known-literal "real prod domain" anymore to guard dev/beta bakes against;
        // channel separation now relies on the operator sourcing each channel's endpoint from its
        // own distinct CI/repo variable rather than a single shared one. The stable channel still
        // requires the bake to be a clean origin-only https URL.
        assert!(baked_endpoint_channel_pairing_ok(false, TEST_STABLE_ENDPOINT));
        assert!(baked_endpoint_channel_pairing_ok(false, TEST_DEV_ENDPOINT));
        assert!(baked_endpoint_channel_pairing_ok(true, TEST_STABLE_ENDPOINT));
        assert!(!baked_endpoint_channel_pairing_ok(
            true,
            "https://otlp.example.com/v1/traces"
        ));
    }

    #[test]
    fn baked_otlp_endpoint_honors_apply_allowed_gate() {
        if baked_observability_stable_channel()
            && baked_observability_value_present(option_env!("SUPERCLAW_BAKED_EDGE_CREDENTIAL_ID"))
        {
            assert_eq!(
                baked_observability_apply_allowed(),
                baked_observability_targets_prod_registry(),
            );
            if !baked_observability_apply_allowed() {
                assert!(
                    baked_otlp_endpoint().is_none(),
                    "partial stable bake must not expose SUPERCLAW_BAKED_OTLP_ENDPOINT"
                );
            } else if let Some(endpoint) = baked_otlp_endpoint() {
                assert!(
                    is_exact_stable_prod_otlp_endpoint(endpoint),
                    "stable bake endpoint must be a clean origin-only https URL"
                );
            }
        }
    }

    #[test]
    fn partial_stable_bake_never_resolves_baked_endpoint_for_spawn() {
        if !baked_observability_stable_channel() {
            return;
        }
        if !stable_baked_observability_partial_configuration() {
            return;
        }
        assert!(!baked_observability_apply_allowed());
        assert!(baked_otlp_endpoint().is_none());
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_endpoint = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT");
        ensure_process_otlp_env();
        assert!(
            std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .is_none()
                || cfg!(debug_assertions),
            "partial stable bake must not materialize OTEL_EXPORTER_OTLP_ENDPOINT on release"
        );
        if !cfg!(debug_assertions) {
            assert!(otlp_endpoint_for_spawn().is_none());
        }
        match prev_endpoint {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
    }

    #[test]
    fn is_exact_stable_prod_otlp_endpoint_requires_clean_https_origin() {
        // There is no literal host to anchor against anymore; this check is now purely
        // structural (scheme/userinfo/query/fragment/path shape), trusting whatever host the
        // CI git variable supplied.
        assert!(is_exact_stable_prod_otlp_endpoint(TEST_STABLE_ENDPOINT));
        assert!(is_exact_stable_prod_otlp_endpoint("https://otlp.example.com/"));
        assert!(is_exact_stable_prod_otlp_endpoint(TEST_DEV_ENDPOINT));
        assert!(!is_exact_stable_prod_otlp_endpoint(
            "http://otlp.example.com",
        ), "must be https");
        assert!(!is_exact_stable_prod_otlp_endpoint(
            "https://user:pass@otlp.example.com",
        ), "must not carry userinfo");
        assert!(!is_exact_stable_prod_otlp_endpoint(
            "https://otlp.example.com/v1/traces",
        ), "must be origin-only, no signal path");
        assert!(!is_exact_stable_prod_otlp_endpoint(
            "https://otlp.example.com?redirect=https://evil.example",
        ), "must not carry a query");
        assert!(!is_exact_stable_prod_otlp_endpoint(
            "https://otlp.example.com#fragment",
        ), "must not carry a fragment");
        assert!(!is_exact_stable_prod_otlp_endpoint("not a url"));
    }

    #[test]
    fn stable_prod_ingress_against_anchor_requires_exact_host_and_port() {
        // `cargo test` never has a compile-time bake, so `is_stable_prod_otlp_ingress` itself
        // always exercises the no-anchor fallback branch below. This test drives the
        // anchor-present branch directly via the injectable helper, so the actual prod/dev
        // pairing guard (reject wrong host, lookalike-suffix host, wrong port) stays covered
        // even though no unit test can set `SUPERCLAW_BAKED_OTLP_ENDPOINT`.
        let anchor = "https://otlp.example.com";

        assert!(is_stable_prod_otlp_ingress_against_anchor(
            "https://otlp.example.com",
            Some(anchor)
        ), "exact origin match must pass");
        assert!(is_stable_prod_otlp_ingress_against_anchor(
            "https://otlp.example.com/",
            Some(anchor)
        ), "trailing slash is still the same origin");
        for path in ["/v1/logs", "/v1/metrics", "/v1/traces"] {
            assert!(
                is_stable_prod_otlp_ingress_against_anchor(
                    &format!("https://otlp.example.com{path}"),
                    Some(anchor)
                ),
                "signal path {path} on the matching origin must pass"
            );
        }

        assert!(!is_stable_prod_otlp_ingress_against_anchor(
            "https://otlp-dev.example.com",
            Some(anchor)
        ), "different host must fail");
        assert!(!is_stable_prod_otlp_ingress_against_anchor(
            "https://otlp.example.com.evil.example",
            Some(anchor)
        ), "lookalike suffix host must fail, not be treated as a match via substring");
        assert!(!is_stable_prod_otlp_ingress_against_anchor(
            "https://evil.example/otlp.example.com",
            Some(anchor)
        ), "anchor host appearing only in the path must fail");
        assert!(!is_stable_prod_otlp_ingress_against_anchor(
            "https://otlp.example.com:8443",
            Some(anchor)
        ), "different port must fail");
        assert!(!is_stable_prod_otlp_ingress_against_anchor(
            "https://user:pass@otlp.example.com",
            Some(anchor)
        ), "userinfo makes the endpoint structurally unclean regardless of anchor match");
        assert!(!is_stable_prod_otlp_ingress_against_anchor(
            "https://otlp.example.com/not-a-signal-path",
            Some(anchor)
        ), "non-signal path must fail even on the matching origin");

        // No anchor: falls back to trusting any structurally clean endpoint with an allowed path.
        assert!(is_stable_prod_otlp_ingress_against_anchor(
            "https://otlp-dev.example.com",
            None
        ), "without a baked anchor, any well-formed origin is trusted");
        assert!(!is_stable_prod_otlp_ingress_against_anchor(
            "https://user:pass@otlp-dev.example.com",
            None
        ), "structural validation still applies without an anchor");
    }

    #[test]
    fn configured_otlp_export_endpoints_includes_signal_overrides() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_base = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_logs = std::env::var_os("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT");
        let prev_metrics = std::env::var_os("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", TEST_STABLE_ENDPOINT);
        std::env::set_var(
            "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
            format!("{TEST_DEV_ENDPOINT}/v1/logs"),
        );
        std::env::set_var(
            "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
            format!("{TEST_DEV_ENDPOINT}/v1/metrics"),
        );
        let endpoints = configured_otlp_export_endpoints();
        assert!(endpoints.iter().any(|url| url == TEST_STABLE_ENDPOINT));
        assert!(
            endpoints
                .iter()
                .any(|url| url.contains("otlp-dev.example.com") && url.ends_with("/v1/logs"))
        );
        assert!(
            endpoints
                .iter()
                .any(|url| url.ends_with("/v1/metrics"))
        );
        match prev_base {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_logs {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"),
        }
        match prev_metrics {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"),
        }
    }

    #[test]
    fn stable_prod_otlp_ingress_trusts_well_formed_endpoints_without_baked_anchor() {
        // No CI bake is present when running `cargo test`, so there is no known-good prod origin
        // to compare against — every well-formed https candidate is trusted as "prod ingress" by
        // default until a CI bake supplies an anchor to disprove it (untestable at the unit
        // level; see baked_stable_prod_otlp_origin).
        assert!(is_stable_prod_otlp_ingress(TEST_STABLE_ENDPOINT));
        assert!(is_stable_prod_otlp_ingress(&format!(
            "{TEST_STABLE_ENDPOINT}/v1/logs"
        )));
        assert!(is_stable_prod_otlp_ingress(&format!(
            "{TEST_STABLE_ENDPOINT}/v1/metrics"
        )));
        assert!(is_stable_prod_otlp_ingress(&format!(
            "{TEST_STABLE_ENDPOINT}/v1/traces"
        )));
        // Structural rejections hold regardless of the anchor.
        assert!(!is_stable_prod_otlp_ingress(&format!(
            "{TEST_STABLE_ENDPOINT}/v1/unsupported"
        )));
        assert!(!is_stable_prod_otlp_ingress(
            "https://user:pass@otlp.example.com",
        ));
        assert!(!is_stable_prod_otlp_ingress("https://otlp.example.com?x=1"));
    }

    #[test]
    fn signal_specific_otlp_url_passes_stable_prod_guard_without_baked_anchor() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_registry = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        let prev_credential = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        std::env::set_var(
            "SUPERCLAW_EDGE_CREDENTIAL_ID",
            "build-prod-only-credential-id",
        );
        // A /v1/logs-suffixed endpoint is still structurally eligible for "prod ingress", and
        // without a baked anchor it's trusted by default, so the pairing guard does not fire.
        let logs_url = format!("{TEST_DEV_ENDPOINT}/v1/logs");
        assert!(!stable_prod_credentials_mismatch(&logs_url, "stable", false));
        match prev_registry {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY"),
        }
        match prev_credential {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
    }

    #[test]
    fn end_to_end_invalid_registry_blocks_export_and_child_otlp_strip() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_endpoint = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_headers = std::env::var_os("OTEL_EXPORTER_OTLP_HEADERS");
        let prev_registry = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        let prev_credential = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", TEST_DEV_ENDPOINT);
        std::env::set_var(
            "OTEL_EXPORTER_OTLP_HEADERS",
            "X-SuperClaw-Credential-Id=a,X-SuperClaw-Edge-Token=b",
        );
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", "prodd");
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", "unclassified-credential-id");
        assert!(!otlp_export_configured());
        let patch = otlp_child_export_env_patch(&[]);
        assert!(patch.strip_inherited);
        assert!(feedback_ingest_endpoint().is_none());
        match prev_endpoint {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_headers {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_HEADERS", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS"),
        }
        match prev_registry {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY"),
        }
        match prev_credential {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
    }

    #[test]
    fn end_to_end_valid_remote_export_configures_child_and_feedback() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_endpoint = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_headers = std::env::var_os("OTEL_EXPORTER_OTLP_HEADERS");
        let prev_registry = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", TEST_DEV_ENDPOINT);
        std::env::set_var(
            "OTEL_EXPORTER_OTLP_HEADERS",
            "X-SuperClaw-Credential-Id=a,X-SuperClaw-Edge-Token=b",
        );
        std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        assert!(otlp_export_configured());
        let patch = otlp_child_export_env_patch(&[]);
        assert!(!patch.strip_inherited);
        // Endpoint/headers already live in process env; spawn patch does not overwrite.
        assert!(patch.endpoint.is_none());
        assert!(patch.headers.is_none());
        assert_eq!(
            feedback_ingest_endpoint().as_deref(),
            Some("https://otlp-dev.example.com/feedback"),
        );
        match prev_endpoint {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_headers {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_HEADERS", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS"),
        }
        match prev_registry {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY"),
        }
    }

    #[test]
    fn child_otlp_strip_when_release_pairing_guard_fails_on_process_env() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_channel = std::env::var_os("SUPERCLAW_BUILD_CHANNEL");
        let prev_endpoint = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_headers = std::env::var_os("OTEL_EXPORTER_OTLP_HEADERS");
        let prev_registry = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        std::env::set_var("SUPERCLAW_BUILD_CHANNEL", "stable");
        // Without a baked anchor, an explicit dev registry can never be proven safe for a
        // stable-channel build (no anchor to confirm the endpoint isn't prod), so it always
        // fails closed regardless of the configured endpoint.
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", "dev");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", TEST_DEV_ENDPOINT);
        std::env::set_var(
            "OTEL_EXPORTER_OTLP_HEADERS",
            "X-SuperClaw-Credential-Id=a,X-SuperClaw-Edge-Token=b",
        );
        assert!(
            !otlp_export_configured_for_child_launch_env_inner(&[], false),
            "an explicit dev registry on a stable channel build fails closed without a baked \
             anchor"
        );
        let patch = otlp_child_export_env_patch_inner(&[], false);
        assert!(
            patch.strip_inherited,
            "ServiceHub spawn must strip inherited OTLP env when the guard fails"
        );
        match prev_channel {
            Some(v) => std::env::set_var("SUPERCLAW_BUILD_CHANNEL", v),
            None => std::env::remove_var("SUPERCLAW_BUILD_CHANNEL"),
        }
        match prev_endpoint {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_headers {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_HEADERS", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS"),
        }
        match prev_registry {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY"),
        }
    }

    #[test]
    fn child_otlp_strip_when_launch_env_overrides_endpoint_for_dev_registry() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_channel = std::env::var_os("SUPERCLAW_BUILD_CHANNEL");
        let prev_endpoint = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_headers = std::env::var_os("OTEL_EXPORTER_OTLP_HEADERS");
        let prev_registry = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        std::env::set_var("SUPERCLAW_BUILD_CHANNEL", "stable");
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", "dev");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", TEST_STABLE_ENDPOINT);
        std::env::set_var(
            "OTEL_EXPORTER_OTLP_HEADERS",
            "X-SuperClaw-Credential-Id=a,X-SuperClaw-Edge-Token=b",
        );
        // launch_target.env takes precedence over the inherited process env endpoint; an
        // explicit dev registry fails closed on a stable channel regardless of which endpoint
        // wins, since there is no baked anchor to prove either one isn't prod.
        let launch_env = [("OTEL_EXPORTER_OTLP_ENDPOINT", TEST_DEV_ENDPOINT.to_string())];
        assert!(
            !otlp_export_configured_for_child_launch_env_inner(&launch_env, false),
        );
        let patch = otlp_child_export_env_patch_inner(&launch_env, false);
        assert!(patch.strip_inherited);
        match prev_channel {
            Some(v) => std::env::set_var("SUPERCLAW_BUILD_CHANNEL", v),
            None => std::env::remove_var("SUPERCLAW_BUILD_CHANNEL"),
        }
        match prev_endpoint {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_headers {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_HEADERS", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS"),
        }
        match prev_registry {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY"),
        }
    }

    #[test]
    fn otlp_child_export_env_patch_strips_when_remote_endpoint_lacks_headers() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_endpoint = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_headers = std::env::var_os("OTEL_EXPORTER_OTLP_HEADERS");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", TEST_DEV_ENDPOINT);
        std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS");
        let patch = otlp_child_export_env_patch(&[]);
        assert!(patch.strip_inherited);
        assert!(patch.endpoint.is_none());
        assert!(patch.headers.is_none());
        match prev_endpoint {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_headers {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_HEADERS", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS"),
        }
    }

    #[test]
    fn otlp_export_configured_requires_headers_for_remote_endpoint() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_endpoint = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_headers = std::env::var_os("OTEL_EXPORTER_OTLP_HEADERS");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", TEST_DEV_ENDPOINT);
        std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS");
        assert!(!otlp_export_configured());
        std::env::set_var(
            "OTEL_EXPORTER_OTLP_HEADERS",
            "X-SuperClaw-Credential-Id=a,X-SuperClaw-Edge-Token=b",
        );
        assert!(otlp_export_configured());
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318");
        std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS");
        assert!(otlp_export_configured());
        match prev_endpoint {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_headers {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_HEADERS", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_HEADERS"),
        }
    }

    #[test]
    fn feedback_ingest_endpoint_appends_path_to_otlp_base() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        std::env::set_var(
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "https://telemetry.example.com",
        );
        assert_eq!(
            feedback_ingest_endpoint().as_deref(),
            Some("https://telemetry.example.com/feedback")
        );
        std::env::set_var(
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "https://telemetry.example.com/",
        );
        assert_eq!(
            feedback_ingest_endpoint().as_deref(),
            Some("https://telemetry.example.com/feedback")
        );
        match prev {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
    }

    #[test]
    fn feedback_ingest_trusts_well_formed_base_without_baked_anchor() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_registry = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        let prev_credential = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        std::env::set_var(
            "SUPERCLAW_EDGE_CREDENTIAL_ID",
            "build-prod-only-credential-id",
        );
        // No baked anchor exists to disprove either origin-only base as "prod ingress", so both
        // are trusted by default and resolve to a feedback URL.
        assert!(feedback_ingest_url(TEST_DEV_ENDPOINT, "stable", false).is_some());
        assert!(feedback_ingest_url(TEST_STABLE_ENDPOINT, "stable", false).is_some());
        // An explicit dev registry can never be proven safe without an anchor, so it still
        // fails closed regardless of the base.
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", "dev");
        assert!(
            feedback_ingest_url(TEST_STABLE_ENDPOINT, "stable", false).is_none(),
            "an explicit dev registry fails closed without a baked anchor"
        );
        assert!(
            feedback_ingest_url(TEST_DEV_ENDPOINT, "stable", true).is_some(),
            "debug builds bypass the guard"
        );
        match prev_registry {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY"),
        }
        match prev_credential {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
    }

    #[test]
    fn feedback_ingest_rejects_otlp_signal_path_as_base() {
        let _guard = crate::test_process_env::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev_registry = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        let prev_credential = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY");
        std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID");
        let logs_base = format!("{TEST_STABLE_ENDPOINT}/v1/logs");
        assert!(feedback_ingest_url(&logs_base, "stable", false).is_none());
        let dev_logs_base = format!("{TEST_DEV_ENDPOINT}/v1/metrics");
        assert!(feedback_ingest_url(&dev_logs_base, "dev", false).is_none());
        assert_eq!(
            feedback_ingest_url(TEST_STABLE_ENDPOINT, "stable", false).as_deref(),
            Some("https://otlp.example.com/feedback"),
        );
        match prev_registry {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_REGISTRY"),
        }
        match prev_credential {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
    }
}
