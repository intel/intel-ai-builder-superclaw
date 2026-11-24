//! Host-path feedback submission.
//!
//! `submit_feedback` is the sole network egress point for in-app feedback when the
//! UI enables AWS ingest (`FEEDBACK_AWS_INGEST_SHIPPING_ENABLED` / debug builds in
//! `apps/ui/src/app/lib/feedback-ingest-host.ts`). It sanitizes the body (reusing the
//! same scrubber as crash telemetry), then POSTs to `{OTEL_EXPORTER_OTLP_ENDPOINT}/feedback`
//! on the shared telemetry ALB. The webview never talks to the ingest endpoint directly.
//!
//! Shipping installers default to GitHub until `FEEDBACK_AWS_INGEST_SHIPPING_ENABLED` is flipped
//! in the UI **and** in the `FEEDBACK_AWS_INGEST_SHIPPING_ENABLED` const below (keep in sync).
//! Debug builds (`cfg(debug_assertions)`, i.e. `tauri dev` / `tauri build --debug`) may POST.
//! Release MSI aligns with the UI: `tauri-before-build.mjs` strips `BUILD_DEBUG` for release UI
//! while Rust ships without `debug_assertions`. The host returns `{ status: "no_endpoint" }`
//! when the product gate or OTLP URL blocks ingest; the UI falls back to GitHub, then mailto.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::telemetry::{feedback_ingest_endpoint, scrub_crash_text};

const MAX_MESSAGE_CHARS: usize = 4_000;
const MAX_DEBUG_REPORT_CHARS: usize = 8_000;
const REQUEST_TIMEOUT_SECS: u64 = 10;

/// Keep in sync with `FEEDBACK_AWS_INGEST_SHIPPING_ENABLED` in
/// `apps/ui/src/app/lib/feedback-ingest-host.ts`.
const FEEDBACK_AWS_INGEST_SHIPPING_ENABLED: bool = false;

/// Mirrors `feedbackAwsIngestEnabledForBuild` in the UI (unit-tested).
fn feedback_aws_ingest_allowed_for_build(build_debug: bool, shipping_ingest_enabled: bool) -> bool {
    build_debug || shipping_ingest_enabled
}

fn feedback_aws_ingest_product_enabled() -> bool {
    feedback_aws_ingest_allowed_for_build(
        cfg!(debug_assertions),
        FEEDBACK_AWS_INGEST_SHIPPING_ENABLED,
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSubmission {
    pub message: String,
    pub category: String,
    pub app_version: String,
    pub install_id: Option<String>,
    pub os: String,
    pub channel: String,
    pub optional_debug_report: Option<String>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSubmitResult {
    /// "accepted" | "no_endpoint" | "quota_exceeded" (mirrors the ingest API
    /// response contract).
    pub status: String,
    pub feedback_id: Option<String>,
}

/// Closed enum for feedback category; unknown values collapse to "other"
/// rather than forwarding arbitrary client-supplied strings.
/// Must match `shared/contracts/src/data/feedback-ingest-categories.json` (+ legacy `feature` → `idea`).
fn normalize_category(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "bug" => "bug",
        // Match Lambda closed enum (`infra/lambda/feedback-ingest/validation.mjs`).
        "idea" => "idea",
        "feature" => "idea",
        "question" => "question",
        _ => "other",
    }
}

/// Must match `shared/contracts/src/data/feedback-ingest-os.json`.
fn host_feedback_ingest_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "linux"
    }
}

fn normalize_os(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "windows" => "windows",
        "macos" => "macos",
        "linux" => "linux",
        _ => host_feedback_ingest_os(),
    }
}

fn feedback_endpoint() -> Option<String> {
    feedback_ingest_endpoint()
}

/// Resolve the complete edge credential pair required by the feedback endpoint.
fn feedback_edge_auth() -> Option<[(&'static str, String); 2]> {
    crate::telemetry::ensure_process_otlp_env_for_export();
    let cred_id = std::env::var("SUPERCLAW_EDGE_CREDENTIAL_ID").ok()?;
    let token = std::env::var("SUPERCLAW_FEEDBACK_EDGE_TOKEN").ok()?;
    let cred_id = cred_id.trim().to_string();
    let token = token.trim().to_string();
    if cred_id.is_empty() || token.is_empty() {
        return None;
    }
    Some([
        ("x-superclaw-credential-id", cred_id),
        ("x-superclaw-edge-token", token),
    ])
}

fn submit_feedback_sync(submission: FeedbackSubmission) -> Result<FeedbackSubmitResult, String> {
    let trimmed_message = submission.message.trim();
    if trimmed_message.is_empty() {
        return Err("message is required".to_string());
    }
    let message = scrub_crash_text(trimmed_message, MAX_MESSAGE_CHARS);

    if !feedback_aws_ingest_product_enabled() {
        return Ok(FeedbackSubmitResult {
            status: "no_endpoint".to_string(),
            feedback_id: None,
        });
    }

    let Some(endpoint) = feedback_endpoint() else {
        // No ingest endpoint configured (dev, or backend not deployed yet) — the
        // frontend falls back to mailto on this status, never treats it as an error.
        return Ok(FeedbackSubmitResult {
            status: "no_endpoint".to_string(),
            feedback_id: None,
        });
    };

    let Some(auth_headers) = feedback_edge_auth() else {
        return Ok(FeedbackSubmitResult {
            status: "no_endpoint".to_string(),
            feedback_id: None,
        });
    };

    let debug_report = submission
        .optional_debug_report
        .as_deref()
        .map(|value| scrub_crash_text(value, MAX_DEBUG_REPORT_CHARS));

    let body = json!({
        "message": message,
        "category": normalize_category(&submission.category),
        "appVersion": submission.app_version.trim(),
        "installId": submission.install_id,
        "os": normalize_os(&submission.os),
        "channel": submission.channel.trim(),
        "optionalDebugReport": debug_report,
    });

    let agent = crate::http_proxy::apply_env_proxy_for_url(
        ureq::AgentBuilder::new().timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS)),
        &endpoint,
    )
    .build();

    let mut request = agent
        .post(&endpoint)
        .set("Content-Type", "application/json");

    for (key, value) in &auth_headers {
        request = request.set(key, value);
    }
    if let Some(key) = submission
        .idempotency_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.set("X-Idempotency-Key", key);
    }

    let response = match request.send_json(body) {
        Ok(response) => response,
        // The edge answers 429 when the per-IP submission quota is spent. ureq
        // reports every non-2xx as a transport error, so without this branch a
        // throttled submission is indistinguishable from the network being down.
        Err(ureq::Error::Status(429, _)) => {
            return Ok(FeedbackSubmitResult {
                status: "quota_exceeded".to_string(),
                feedback_id: None,
            })
        }
        Err(error) => return Err(format!("feedback ingest request failed: {error}")),
    };

    let parsed: Value = response
        .into_json()
        .map_err(|error| format!("feedback ingest response was not valid JSON: {error}"))?;

    let status = parsed
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("accepted")
        .to_string();
    let feedback_id = parsed
        .get("feedbackId")
        .and_then(Value::as_str)
        .map(str::to_string);

    Ok(FeedbackSubmitResult {
        status,
        feedback_id,
    })
}

#[tauri::command]
pub async fn submit_feedback(
    submission: FeedbackSubmission,
) -> Result<FeedbackSubmitResult, String> {
    tauri::async_runtime::spawn_blocking(move || submit_feedback_sync(submission))
        .await
        .map_err(|_| "feedback ingest task failed".to_string())?
}

pub(crate) fn feedback_internal_from_corp_dns_resolves(resolves: bool) -> bool {
    resolves
}

/// True when the baked enterprise probe host resolves. An empty bake is false and does not resolve.
#[cfg(windows)]
fn host_is_internal_feedback_user() -> bool {
    use crate::platform::enterprise_probe_resolves;
    feedback_internal_from_corp_dns_resolves(enterprise_probe_resolves())
}

#[cfg(not(windows))]
fn host_is_internal_feedback_user() -> bool {
    false
}

fn is_github_slug_part(part: &str) -> bool {
    !part.is_empty()
        && part != "."
        && part != ".."
        && part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn is_github_issue_repo_slug(slug: &str) -> bool {
    let Some((owner, name)) = slug.split_once('/') else {
        return false;
    };
    !name.contains('/') && is_github_slug_part(owner) && is_github_slug_part(name)
}

/// Source default for debug, source, and fork builds. A release bake of
/// `SUPERCLAW_FEEDBACK_ISSUE_REPO_PUBLIC` overrides it.
const FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT: &str = "intel/intel-ai-builder";

/// Baked public target when it is `owner/name`; otherwise the source default.
fn resolve_public_feedback_repo(baked: Option<&str>) -> Option<&str> {
    baked
        .map(str::trim)
        .filter(|slug| is_github_issue_repo_slug(slug))
        .or(Some(FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT))
}

fn public_feedback_repo() -> Option<&'static str> {
    resolve_public_feedback_repo(option_env!("SUPERCLAW_BAKED_FEEDBACK_ISSUE_REPO_PUBLIC"))
}

/// Prepared corp-network target, if this release binary baked a valid slug other
/// than the baked public repository.
fn prepared_internal_feedback_repo<'a>(
    baked: Option<&'a str>,
    public_repo: Option<&str>,
) -> Option<&'a str> {
    baked.map(str::trim).filter(|slug| {
        if !is_github_issue_repo_slug(slug) {
            return false;
        }
        match public_repo {
            Some(public) => !slug.eq_ignore_ascii_case(public),
            None => true,
        }
    })
}

fn baked_feedback_issue_repo() -> Option<&'static str> {
    prepared_internal_feedback_repo(
        option_env!("SUPERCLAW_BAKED_FEEDBACK_ISSUE_REPO_INTERNAL"),
        public_feedback_repo(),
    )
}

/// Baked public repository unless `baked_internal` is set, this build is
/// Intel-signed, and `internal_host` is true. The enterprise probe runs only in
/// that last case, and only when a probe host was baked. No baked public
/// repository uses `intel/intel-ai-builder`.
fn feedback_issue_repo_for<'a>(
    intel_signed: bool,
    baked_internal: Option<&'a str>,
    internal_host: impl FnOnce() -> bool,
) -> Option<&'a str> {
    select_feedback_issue_repo(
        intel_signed,
        baked_internal,
        public_feedback_repo(),
        internal_host,
    )
}

fn select_feedback_issue_repo<'a>(
    intel_signed: bool,
    baked_internal: Option<&'a str>,
    public_repo: Option<&'a str>,
    internal_host: impl FnOnce() -> bool,
) -> Option<&'a str> {
    let Some(repo) = prepared_internal_feedback_repo(baked_internal, public_repo) else {
        return public_repo;
    };
    if intel_signed && internal_host() {
        Some(repo)
    } else {
        public_repo
    }
}

/// Same Authenticode organization the installer requires of an official package.
const INTEL_SIGNER_ORG: &str = "O=Intel Corporation";

static RUNNING_BUILD_INTEL_SIGNED: OnceLock<bool> = OnceLock::new();

/// True when this executable is signed by Intel. Checked on first feedback
/// lookup, off the UI thread, and cached. A source build is false.
fn running_build_is_intel_signed() -> bool {
    *RUNNING_BUILD_INTEL_SIGNED.get_or_init(|| {
        let started = Instant::now();
        let signed = current_exe_is_intel_signed();
        tracing::info!(
            component = "tauri",
            stage = "official_build",
            "official_build intel_signed={signed} check_ms={}",
            started.elapsed().as_millis()
        );
        signed
    })
}

#[cfg(windows)]
fn current_exe_is_intel_signed() -> bool {
    std::env::current_exe().is_ok_and(|exe| {
        crate::installer_authenticode::verify_signed_installer(&exe, INTEL_SIGNER_ORG).is_ok()
    })
}

#[cfg(not(windows))]
fn current_exe_is_intel_signed() -> bool {
    false
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackIssueRepoSlug {
    pub slug: String,
    pub public_slug: String,
    /// True only when `slug` is the baked corp-network repository.
    pub internal: bool,
    pub email: String,
}

fn feedback_issue_repo_is_internal(slug: &str, baked_internal: Option<&str>) -> bool {
    baked_internal.is_some_and(|repo| slug.eq_ignore_ascii_case(repo))
}

fn feedback_issue_repo_slug_blocking() -> FeedbackIssueRepoSlug {
    let public_slug = public_feedback_repo()
        .unwrap_or(FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT)
        .to_string();
    let baked = baked_feedback_issue_repo();
    let slug = if baked.is_none() {
        public_slug.clone()
    } else {
        feedback_issue_repo_for(
            running_build_is_intel_signed(),
            baked,
            host_is_internal_feedback_user,
        )
        .unwrap_or(FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT)
        .to_string()
    };
    let internal = feedback_issue_repo_is_internal(&slug, baked);
    tracing::info!(component = "tauri", stage = "feedback", "feedback issue_repo={slug}");
    FeedbackIssueRepoSlug {
        slug,
        public_slug,
        internal,
        email: baked_feedback_email().unwrap_or("").to_string(),
    }
}

fn baked_feedback_email() -> Option<&'static str> {
    option_env!("SUPERCLAW_BAKED_FEEDBACK_EMAIL")
        .map(str::trim)
        .filter(|email| !email.is_empty())
}

/// GitHub target for in-app feedback / bug-report prefills (issue #1809).
/// Called from the UI on feedback-modal lifecycle and submit only (not background polling).
#[tauri::command]
pub async fn feedback_issue_repo_slug() -> FeedbackIssueRepoSlug {
    tauri::async_runtime::spawn_blocking(feedback_issue_repo_slug_blocking)
        .await
        .unwrap_or_else(|_| FeedbackIssueRepoSlug {
            slug: FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT.to_string(),
            public_slug: FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT.to_string(),
            internal: false,
            email: String::new(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::TcpListener;
    use crate::test_process_env::ENV_MUTEX;

    #[test]
    fn normalize_os_maps_closed_values_and_falls_back_to_host() {
        assert_eq!(normalize_os("macOS"), "macos");
        assert_eq!(normalize_os("linux"), "linux");
        let fallback = normalize_os("freebsd");
        assert!(["windows", "macos", "linux"].contains(&fallback));
    }

    fn submission(message: &str) -> FeedbackSubmission {
        FeedbackSubmission {
            message: message.to_string(),
            category: "bug".to_string(),
            app_version: "1.1.0".to_string(),
            install_id: Some("install-123".to_string()),
            os: "windows".to_string(),
            channel: "stable".to_string(),
            optional_debug_report: None,
            idempotency_key: None,
        }
    }

    #[test]
    fn rejects_empty_message() {
        let error = submit_feedback_sync(submission("   ")).unwrap_err();
        assert!(error.contains("message is required"));
    }

    #[test]
    fn feedback_aws_ingest_product_gate_matches_ui() {
        assert!(!feedback_aws_ingest_allowed_for_build(false, false));
        assert!(feedback_aws_ingest_allowed_for_build(true, false));
        assert!(feedback_aws_ingest_allowed_for_build(false, true));
        assert!(!FEEDBACK_AWS_INGEST_SHIPPING_ENABLED);
    }

    #[test]
    fn feedback_ingest_fails_closed_without_bake_when_env_cleared() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let prev_otlp = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_skip_debug_env_file =
            std::env::var_os(crate::telemetry::otlp_env::SKIP_DEBUG_ENV_FILE_VAR);
        std::env::set_var(crate::telemetry::otlp_env::SKIP_DEBUG_ENV_FILE_VAR, "1");
        std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT");
        crate::telemetry::ensure_process_otlp_env_for_export();
        // With no CI bake and no local `.env` entry, there is nothing left to default to — the
        // endpoint (and therefore the feedback ingest URL) must stay unconfigured.
        assert!(
            std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .is_none(),
        );
        assert!(crate::telemetry::feedback_ingest_endpoint().is_none());
        match prev_otlp {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_skip_debug_env_file {
            Some(v) => std::env::set_var(crate::telemetry::otlp_env::SKIP_DEBUG_ENV_FILE_VAR, v),
            None => std::env::remove_var(crate::telemetry::otlp_env::SKIP_DEBUG_ENV_FILE_VAR),
        }
    }

    #[test]
    fn category_normalizes_to_lambda_closed_enum() {
        assert_eq!(normalize_category("BUG"), "bug");
        assert_eq!(normalize_category("Idea"), "idea");
        assert_eq!(normalize_category("idea"), "idea");
        assert_eq!(normalize_category("feature"), "idea");
        assert_eq!(normalize_category("question"), "question");
        assert_eq!(normalize_category("other"), "other");
        assert_eq!(normalize_category("not-a-real-category"), "other");
        // Must never emit legacy "feature" — Lambda rejects it (invalid_category).
        for input in ["bug", "idea", "question", "other", "feature", "Idea"] {
            assert_ne!(normalize_category(input), "feature");
        }
    }

    #[test]
    fn posts_idea_category_in_json_body_for_lambda() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        use std::io::BufRead;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = format!("http://{address}");
        let prev_otlp = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_cred = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        let prev_token = std::env::var_os("SUPERCLAW_FEEDBACK_EDGE_TOKEN");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint);
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", "test-build-credential");
        std::env::set_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN", "test-feedback-token");

        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(&stream);
            let mut content_length: usize = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line == "\n" {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if lower.starts_with("content-length:") {
                    content_length = lower
                        .trim_start_matches("content-length:")
                        .trim()
                        .parse()
                        .unwrap_or(0);
                }
            }
            let mut body_buf = vec![0u8; content_length];
            std::io::Read::read_exact(&mut reader, &mut body_buf).unwrap_or(());
            let captured = String::from_utf8_lossy(&body_buf).into_owned();
            let resp_body = br#"{"status":"accepted","feedbackId":"fb-idea"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                resp_body.len()
            );
            let mut writer = std::io::BufWriter::new(&stream);
            use std::io::Write as _;
            writer.write_all(resp.as_bytes()).unwrap();
            writer.write_all(resp_body).unwrap();
            writer.flush().unwrap();
            captured
        });

        let mut payload = submission("feature request: dark mode");
        payload.category = "idea".to_string();
        let result = submit_feedback_sync(payload).unwrap();
        let body = server.join().unwrap();

        assert_eq!(result.status, "accepted");
        assert!(
            body.contains(r#""category":"idea""#),
            "expected Lambda-accepted category in POST body, got: {body}"
        );
        assert!(
            !body.contains(r#""category":"feature""#),
            "must not forward legacy feature slug: {body}"
        );

        match prev_otlp {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_cred {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
        match prev_token {
            Some(v) => std::env::set_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN", v),
            None => std::env::remove_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN"),
        }
    }

    #[test]
    fn posts_scrubbed_body_and_parses_accepted_response() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        use std::io::BufRead;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = format!("http://{address}");
        let prev_otlp = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_cred = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        let prev_token = std::env::var_os("SUPERCLAW_FEEDBACK_EDGE_TOKEN");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint);
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", "test-build-credential");
        std::env::set_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN", "test-feedback-token");

        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(&stream);
            let mut header_text = String::new();
            let mut content_length: usize = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line == "\n" { break; }
                let lower = line.to_ascii_lowercase();
                if lower.starts_with("content-length:") {
                    content_length = lower.trim_start_matches("content-length:").trim().parse().unwrap_or(0);
                }
                header_text.push_str(&line);
            }
            let mut body_buf = vec![0u8; content_length];
            std::io::Read::read_exact(&mut reader, &mut body_buf).unwrap_or(());
            let full_request = format!("{}\r\n{}", header_text, String::from_utf8_lossy(&body_buf));
            let body = br#"{"status":"accepted","feedbackId":"fb-1"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let mut writer = std::io::BufWriter::new(&stream);
            writer.write_all(resp.as_bytes()).unwrap();
            writer.write_all(body).unwrap();
            writer.flush().unwrap();
            full_request
        });

        let mut payload = submission("crash at C:\\Users\\alice\\project\\app.rs");
        payload.message = "crash at C:\\Users\\alice\\project\\app.rs".to_string();
        let result = submit_feedback_sync(payload).unwrap();
        let request = server.join().unwrap();

        assert_eq!(result.status, "accepted");
        assert_eq!(result.feedback_id, Some("fb-1".to_string()));
        assert!(request.contains("POST /feedback HTTP/1.1"));
        assert!(!request.contains("C:\\Users\\alice"));

        match prev_otlp {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_cred {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
        match prev_token {
            Some(v) => std::env::set_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN", v),
            None => std::env::remove_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN"),
        }
    }

    #[test]
    fn feedback_post_carries_edge_auth_headers_when_credentials_present() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        use std::io::BufRead;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = format!("http://{address}");

        let prev_otlp = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_cred = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        let prev_token = std::env::var_os("SUPERCLAW_FEEDBACK_EDGE_TOKEN");

        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint);
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", "build-1-1-0-stable");
        std::env::set_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN", "fbk_tok_xyz789");

        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(&stream);
            let mut header_text = String::new();
            let mut content_length: usize = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line == "\n" { break; }
                let lower = line.to_ascii_lowercase();
                if lower.starts_with("content-length:") {
                    content_length = lower.trim_start_matches("content-length:").trim().parse().unwrap_or(0);
                }
                header_text.push_str(&line);
            }
            let mut body_buf = vec![0u8; content_length];
            std::io::Read::read_exact(&mut reader, &mut body_buf).unwrap_or(());
            let body = br#"{"status":"accepted","feedbackId":"fb-edge-1"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let mut writer = std::io::BufWriter::new(&stream);
            writer.write_all(resp.as_bytes()).unwrap();
            writer.write_all(body).unwrap();
            use std::io::Write as _;
            writer.flush().unwrap();
            header_text
        });

        let result = submit_feedback_sync(submission("test auth headers")).unwrap();
        let headers = server.join().unwrap();

        assert_eq!(result.status, "accepted");
        assert!(
            headers.contains("x-superclaw-credential-id: build-1-1-0-stable"),
            "credential-id header missing:\n{headers}"
        );
        assert!(
            headers.contains("x-superclaw-edge-token: fbk_tok_xyz789"),
            "edge-token header missing:\n{headers}"
        );

        match prev_otlp {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_cred {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
        match prev_token {
            Some(v) => std::env::set_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN", v),
            None => std::env::remove_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN"),
        }
    }

    #[test]
    fn feedback_post_forwards_idempotency_key_header_when_set() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        use std::io::BufRead;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = format!("http://{address}");

        let prev_otlp = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_cred = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        let prev_token = std::env::var_os("SUPERCLAW_FEEDBACK_EDGE_TOKEN");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint);
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", "test-build-credential");
        std::env::set_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN", "test-feedback-token");

        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(&stream);
            let mut header_text = String::new();
            let mut content_length: usize = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line == "\n" {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if lower.starts_with("content-length:") {
                    content_length = lower
                        .trim_start_matches("content-length:")
                        .trim()
                        .parse()
                        .unwrap_or(0);
                }
                header_text.push_str(&line);
            }
            let mut body_buf = vec![0u8; content_length];
            std::io::Read::read_exact(&mut reader, &mut body_buf).unwrap_or(());
            let body = br#"{"status":"accepted","feedbackId":"fb-idem-1"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let mut writer = std::io::BufWriter::new(&stream);
            writer.write_all(resp.as_bytes()).unwrap();
            writer.write_all(body).unwrap();
            use std::io::Write as _;
            writer.flush().unwrap();
            header_text
        });

        let mut payload = submission("idempotency header test");
        payload.idempotency_key = Some("  client-key-abc  ".to_string());
        let result = submit_feedback_sync(payload).unwrap();
        let headers = server.join().unwrap();

        assert_eq!(result.status, "accepted");
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("x-idempotency-key: client-key-abc"),
            "idempotency header missing:\n{headers}"
        );

        match prev_otlp {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_cred {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
        match prev_token {
            Some(v) => std::env::set_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN", v),
            None => std::env::remove_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN"),
        }
    }

    #[test]
    fn feedback_post_returns_no_endpoint_without_complete_credentials() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = format!("http://{address}");

        let prev_otlp = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_cred = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        let prev_token = std::env::var_os("SUPERCLAW_FEEDBACK_EDGE_TOKEN");
        let prev_skip_debug_env_file =
            std::env::var_os(crate::telemetry::otlp_env::SKIP_DEBUG_ENV_FILE_VAR);

        std::env::set_var(crate::telemetry::otlp_env::SKIP_DEBUG_ENV_FILE_VAR, "1");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint);
        let (request_finished_sender, request_finished_receiver) = std::sync::mpsc::channel();

        let server = std::thread::spawn(move || {
            let mut request_count = 0;
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        request_count += 1;
                        let body = br#"{"status":"accepted","feedbackId":"fb-unexpected"}"#;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        std::io::Write::write_all(&mut stream, response.as_bytes()).unwrap();
                        std::io::Write::write_all(&mut stream, body).unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        match request_finished_receiver.try_recv() {
                            Ok(()) | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                                return request_count;
                            }
                            Err(std::sync::mpsc::TryRecvError::Empty) => {
                                std::thread::sleep(std::time::Duration::from_millis(5));
                            }
                        }
                    }
                    Err(error) => panic!("feedback test listener failed: {error}"),
                }
            }
        });

        let credential_cases = [
            (None, None),
            (Some("test-build-credential"), None),
            (None, Some("test-feedback-token")),
        ];
        let mut statuses = Vec::with_capacity(credential_cases.len());
        for (credential_id, token) in credential_cases {
            match credential_id {
                Some(value) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", value),
                None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
            }
            match token {
                Some(value) => std::env::set_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN", value),
                None => std::env::remove_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN"),
            }
            statuses.push(
                submit_feedback_sync(submission("incomplete credentials test"))
                    .unwrap()
                    .status,
            );
        }
        request_finished_sender.send(()).unwrap();
        let request_count = server.join().unwrap();

        match prev_otlp {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_cred {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
        match prev_token {
            Some(v) => std::env::set_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN", v),
            None => std::env::remove_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN"),
        }
        match prev_skip_debug_env_file {
            Some(v) => std::env::set_var(crate::telemetry::otlp_env::SKIP_DEBUG_ENV_FILE_VAR, v),
            None => std::env::remove_var(crate::telemetry::otlp_env::SKIP_DEBUG_ENV_FILE_VAR),
        }

        assert!(
            statuses.iter().all(|status| status == "no_endpoint"),
            "incomplete credentials should return no_endpoint, got: {statuses:?}"
        );
        assert_eq!(
            request_count, 0,
            "feedback was sent without complete credentials"
        );
    }

    #[test]
    fn throttled_submission_reports_quota_exceeded_not_transport_error() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        use std::io::BufRead;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = format!("http://{address}");
        let prev_otlp = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_cred = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        let prev_token = std::env::var_os("SUPERCLAW_FEEDBACK_EDGE_TOKEN");
        std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", &endpoint);
        std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", "test-build-credential");
        std::env::set_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN", "test-feedback-token");

        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(&stream);
            let mut content_length: usize = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line == "\n" {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if lower.starts_with("content-length:") {
                    content_length = lower
                        .trim_start_matches("content-length:")
                        .trim()
                        .parse()
                        .unwrap_or(0);
                }
            }
            let mut body_buf = vec![0u8; content_length];
            std::io::Read::read_exact(&mut reader, &mut body_buf).unwrap_or(());
            let body = br#"{"status":"quota_exceeded"}"#;
            let resp = format!(
                "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: 28800\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let mut writer = std::io::BufWriter::new(&stream);
            writer.write_all(resp.as_bytes()).unwrap();
            writer.write_all(body).unwrap();
            writer.flush().unwrap();
        });

        let result = submit_feedback_sync(submission("throttled")).unwrap();
        server.join().unwrap();

        assert_eq!(result.status, "quota_exceeded");
        assert_eq!(result.feedback_id, None);

        match prev_otlp {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_cred {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
        match prev_token {
            Some(v) => std::env::set_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN", v),
            None => std::env::remove_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN"),
        }
    }

    #[test]
    fn feedback_internal_from_corp_dns_resolves_maps_bool() {
        assert!(feedback_internal_from_corp_dns_resolves(true));
        assert!(!feedback_internal_from_corp_dns_resolves(false));
    }

    #[test]
    fn feedback_issue_repo_slug_public_when_not_internal() {
        // cargo test is not a release build, so it never bakes a feedback repository
        // and must not probe corp DNS. The source default is the public repository.
        let choice = feedback_issue_repo_slug_blocking();
        assert_eq!(choice.slug, FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT);
        assert_eq!(choice.public_slug, FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT);
        assert!(!choice.internal);
        assert_eq!(choice.email, "");
        assert!(!feedback_issue_repo_is_internal(
            FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT,
            Some("prepared/feedback-target"),
        ));
        assert!(feedback_issue_repo_is_internal(
            "prepared/feedback-target",
            Some("Prepared/Feedback-Target"),
        ));
        assert!(!feedback_issue_repo_is_internal(
            "other/repo",
            Some("prepared/feedback-target"),
        ));
        assert!(!feedback_issue_repo_is_internal(
            "prepared/feedback-target",
            None,
        ));
    }

    #[test]
    fn baked_public_repo_is_the_only_public_target() {
        let public_repo = "acme/public-target";
        assert_eq!(
            resolve_public_feedback_repo(None),
            Some(FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT)
        );
        assert_eq!(
            resolve_public_feedback_repo(Some("not a slug")),
            Some(FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT)
        );
        assert_eq!(
            resolve_public_feedback_repo(Some("prepared/..")),
            Some(FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT)
        );
        assert_eq!(
            resolve_public_feedback_repo(Some(public_repo)),
            Some(public_repo)
        );
        assert_eq!(
            select_feedback_issue_repo(
                false,
                Some("prepared/feedback-target"),
                Some(public_repo),
                || panic!("corp DNS probed")
            ),
            Some(public_repo),
        );
        assert_eq!(
            select_feedback_issue_repo(true, Some("Acme/Public-Target"), Some(public_repo), || {
                panic!("public bake probed DNS")
            }),
            Some(public_repo),
        );
        assert_eq!(
            select_feedback_issue_repo(
                true,
                Some("prepared/feedback-target"),
                Some(public_repo),
                || true
            ),
            Some("prepared/feedback-target"),
        );
        assert_eq!(
            select_feedback_issue_repo(
                true,
                Some("prepared/feedback-target"),
                Some(public_repo),
                || false
            ),
            Some(public_repo),
        );
    }

    #[test]
    fn source_builds_use_the_public_default_without_a_public_bake() {
        let prepared = Some("prepared/feedback-target");
        let public_default = Some(FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT);
        assert_eq!(
            feedback_issue_repo_for(false, None, || panic!("corp DNS probed")),
            public_default
        );
        assert_eq!(
            feedback_issue_repo_for(true, None, || panic!("corp DNS probed without a baked repo")),
            public_default
        );
        assert_eq!(
            feedback_issue_repo_for(false, prepared, || {
                panic!("corp DNS probed on an unsigned build")
            }),
            public_default
        );
        assert_eq!(
            feedback_issue_repo_for(true, Some("not a slug"), || panic!("invalid bake probed DNS")),
            public_default
        );
        for dot_segment in ["prepared/..", "./feedback-target", "prepared/.", "../name"] {
            assert_eq!(
                feedback_issue_repo_for(true, Some(dot_segment), || {
                    panic!("dot segment probed DNS")
                }),
                public_default,
                "{dot_segment}"
            );
        }
    }

    #[test]
    fn signed_build_uses_the_baked_repo_only_when_corp_dns_resolves() {
        let prepared = Some("prepared/feedback-target");
        assert_eq!(
            feedback_issue_repo_for(true, prepared, || true),
            Some("prepared/feedback-target"),
        );
        assert_eq!(
            feedback_issue_repo_for(true, prepared, || false),
            Some(FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT)
        );
    }

    /// Manual smoke against AWS dev ingest (corp proxy required on Intel network).
    /// Run: `cargo test live_dev_feedback_ingest -- --ignored --nocapture`
    #[test]
    #[ignore = "live network; hits telemetry-dev"]
    #[cfg(debug_assertions)]
    fn live_dev_feedback_ingest() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let prev_otlp = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT");
        let prev_cred = std::env::var_os("SUPERCLAW_EDGE_CREDENTIAL_ID");
        let prev_token = std::env::var_os("SUPERCLAW_FEEDBACK_EDGE_TOKEN");

        crate::telemetry::ensure_process_otlp_env_for_export();

        let result = submit_feedback_sync(FeedbackSubmission {
            message: "superclaw live_dev_feedback_ingest cargo test".to_string(),
            category: "other".to_string(),
            app_version: "0.0.0-live-test".to_string(),
            install_id: Some("live-test".to_string()),
            os: "windows".to_string(),
            channel: "dev".to_string(),
            optional_debug_report: None,
            idempotency_key: None,
        })
        .unwrap_or_else(|e| panic!("live ingest failed: {e}"));

        eprintln!("live_dev_feedback_ingest: status={} feedback_id={:?}", result.status, result.feedback_id);
        assert_eq!(result.status, "accepted", "expected accepted from dev ingest");
        assert!(result.feedback_id.is_some());

        match prev_otlp {
            Some(v) => std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", v),
            None => std::env::remove_var("OTEL_EXPORTER_OTLP_ENDPOINT"),
        }
        match prev_cred {
            Some(v) => std::env::set_var("SUPERCLAW_EDGE_CREDENTIAL_ID", v),
            None => std::env::remove_var("SUPERCLAW_EDGE_CREDENTIAL_ID"),
        }
        match prev_token {
            Some(v) => std::env::set_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN", v),
            None => std::env::remove_var("SUPERCLAW_FEEDBACK_EDGE_TOKEN"),
        }
    }
}
