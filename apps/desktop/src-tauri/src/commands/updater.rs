 use std::path::Path;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use url::Url;

use crate::commands::app_prefs::{self, AppPrefs, InstallerCrashLogsConsent};
use crate::installer_staging::{ReverifyError, STAGING};
use crate::installer_update::{
    self, AppUpdateProgressPayload, FetchError, InstallerConsent, UpdateOrigin, APP_UPDATE_PROGRESS_EVENT,
};
use crate::types::{AppUpdateManifest, UpdaterEnvironment};
use crate::updater::updater_environment as updater_environment_inner;

/// The GitHub repository (`owner/name`) whose latest Release carries the update manifest, per
/// channel. Empty: the build does not check for updates. Must be public: unauthenticated clients
/// cannot read the Releases of a private repository. `promote-main.yml` reads the prod value from
/// this line to generate the manifest, so keep it a single-line string literal.
const PROD_RELEASES_REPO: &str = "intel/intel-ai-builder-superclaw";
const STAGING_RELEASES_REPO: &str = "";
/// The Release asset `promote-main.yml` attaches.
const MANIFEST_ASSET: &str = "SuperClawManifest.xml";
const MAX_VERSION_LEN: usize = 64;

#[tauri::command]
pub fn updater_environment(_app: tauri::AppHandle) -> UpdaterEnvironment {
    updater_environment_inner()
}

/// Fetch the XML upgrade manifest from the latest GitHub Release of the channel's repository.
/// The channel is selected by the `SUPERCLAW_UPDATE_CHANNEL` env var (`staging` -> staging
/// repository, anything else -> prod). Returns the raw XML; TypeScript parses and selects a version.
///
/// Debug builds and QA builds compiled with `SUPERCLAW_OTA_TEST_CHANNEL=1` only:
/// `SUPERCLAW_UPDATE_MANIFEST_URL` replaces the channel URL (channel `override`)
/// so OTA can be tested against a local server or another repository's Releases.
#[tauri::command]
pub async fn check_app_update(_app: tauri::AppHandle) -> Result<AppUpdateManifest, String> {
    tauri::async_runtime::spawn_blocking(check_app_update_blocking)
        .await
        .map_err(|e| format!("Update check task failed to run: {e}"))?
}

fn check_app_update_blocking() -> Result<AppUpdateManifest, String> {
    let Some(installed_version) = installed_product_version() else {
        log_decision("skipped", None, "build_version_unknown");
        return Err("This build has no product version, so it cannot check for updates.".to_string());
    };
    let source = update_source().ok_or_else(|| {
        log_decision("skipped", None, "no_update_source");
        NO_UPDATE_SOURCE.to_string()
    })?;

    // The manifest is the trust root (no signature), so its redirects must end on
    // the same repository's Releases or GitHub's release asset CDN.
    let response = installer_update::fetch_update_url(
        &source.manifest_url,
        "update manifest",
        &source.origin,
        Duration::from_secs(5),
        Duration::from_secs(15),
    )
    .map_err(|error| {
        let reason = match &error {
            FetchError::UntrustedRedirect(_) => "untrusted_redirect",
            FetchError::Failed(_) => "manifest_fetch",
        };
        log_decision("refused", None, reason);
        format!("Failed to fetch update manifest: {error}")
    })?;
    let xml = response.into_string().map_err(|e| {
        log_decision("refused", None, "manifest_fetch");
        format!("Failed to read update manifest: {e}")
    })?;

    Ok(AppUpdateManifest {
        manifest_url: source.manifest_url,
        channel: source.channel.to_string(),
        releases_repo: source.origin.releases_repo,
        xml,
        installed_version: installed_version.to_string(),
    })
}

const NO_UPDATE_SOURCE: &str = "This build has no update source configured, so it cannot check for updates.";

#[derive(Debug, PartialEq)]
struct UpdateSource {
    channel: &'static str,
    manifest_url: String,
    origin: UpdateOrigin,
}

fn update_source() -> Option<UpdateSource> {
    resolve_update_source(
        PROD_RELEASES_REPO,
        STAGING_RELEASES_REPO,
        std::env::var("SUPERCLAW_UPDATE_CHANNEL").ok().as_deref(),
        std::env::var("SUPERCLAW_UPDATE_MANIFEST_URL").ok().as_deref(),
        ota_test_channel(),
    )
}

/// The manifest URL and the origin its installer must come from. `None` when the channel has no
/// repository. An override the build does not honour is ignored, as before.
fn resolve_update_source(
    prod_repo: &str,
    staging_repo: &str,
    channel_env: Option<&str>,
    override_env: Option<&str>,
    test_channel: bool,
) -> Option<UpdateSource> {
    if let Some((manifest_url, releases_repo)) = manifest_url_override(override_env, test_channel) {
        return Some(UpdateSource {
            channel: "override",
            manifest_url,
            origin: UpdateOrigin { releases_repo, allow_test_loopback: test_channel },
        });
    }
    let (channel, repo) = match channel_env {
        Some(value) if value.trim().eq_ignore_ascii_case("staging") => ("staging", staging_repo),
        _ => ("prod", prod_repo),
    };
    is_valid_releases_repo(repo).then(|| UpdateSource {
        channel,
        manifest_url: format!("https://github.com/{repo}/releases/latest/download/{MANIFEST_ASSET}"),
        origin: UpdateOrigin { releases_repo: Some(repo.to_string()), allow_test_loopback: test_channel },
    })
}

/// `owner/name` as GitHub spells them.
fn is_valid_releases_repo(repo: &str) -> bool {
    let Some((owner, name)) = repo.split_once('/') else {
        return false;
    };
    !owner.is_empty()
        && owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !name.is_empty()
        && name != "."
        && name != ".."
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// The product version the release build stamped into this binary (`SUPERCLAW_BUILD_VERSION`,
/// the installer's own version). The Tauri crate version is not one: it does not move per build.
fn installed_product_version() -> Option<&'static str> {
    product_version(option_env!("SUPERCLAW_BUILD_VERSION"))
}

fn product_version(build_version: Option<&'static str>) -> Option<&'static str> {
    build_version.map(str::trim).filter(|version| is_valid_version(version))
}

/// The installer's version for display (e.g. `2.0.0.1117`), or None for a build without one.
#[tauri::command]
pub fn get_product_version() -> Option<String> {
    installed_product_version().map(str::to_string)
}

#[tauri::command]
pub fn get_app_update_progress() -> Option<AppUpdateProgressPayload> {
    installer_update::read_install_progress()
}

/// Step 1 of an in-app update: download the installer `.exe` the manifest offers, verify its
/// Authenticode signature (Windows) and stage it. Nothing is launched; the app keeps running
/// until the user chooses [`install_app_update`].
///
/// Progress is emitted on `superclaw://app-update-progress`. Blocking work runs on
/// the blocking thread pool so the window stays responsive.
#[tauri::command]
pub async fn download_app_update(app: AppHandle, install_url: String, version: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || download_app_update_blocking(app, install_url, version))
        .await
        .map_err(|e| format!("Installer task failed to run: {e}"))?
}

/// Step 2: re-verify the staged installer and launch it. The frontend should exit after
/// success so files are not locked.
#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    install_parameters: Option<String>,
    version: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install_app_update_blocking(app, install_parameters, version))
        .await
        .map_err(|e| format!("Installer task failed to run: {e}"))?
}

fn emit_update_progress(app: &AppHandle, payload: AppUpdateProgressPayload) {
    installer_update::publish_install_progress(payload.clone());
    let _ = app.emit(APP_UPDATE_PROGRESS_EVENT, payload);
}

fn refused(version: &str, reason: &str, message: String) -> String {
    log_decision("refused", Some(version), reason);
    message
}

fn download_app_update_blocking(app: AppHandle, install_url: String, version: String) -> Result<(), String> {
    installer_update::clear_install_progress();
    STAGING.clear();
    let emit = |payload: AppUpdateProgressPayload| emit_update_progress(&app, payload);

    let source = update_source()
        .ok_or_else(|| refused(&version, "no_update_source", NO_UPDATE_SOURCE.to_string()))?;
    let path = installer_update::download_installer(&install_url, &source.origin, Some(|progress| {
        emit(progress);
    }))
    .map_err(|message| refused(&version, "download_failed", message))?;
    log_decision("downloaded", Some(&version), "installer");

    emit(AppUpdateProgressPayload {
        phase: "verifying".to_string(),
        bytes_downloaded: None,
        bytes_total: None,
        pct: Some(100.0),
    });
    STAGING
        .stage_verified(&version, &path, installer_update::verify_installer_signature)
        .map_err(|message| refused(&version, "signature_invalid", message))?;
    log_decision("verified", Some(&version), "authenticode");
    log_decision("ready", Some(&version), "awaiting_restart");
    Ok(())
}

fn install_app_update_blocking(
    app: AppHandle,
    install_parameters: Option<String>,
    version: String,
) -> Result<(), String> {
    // Held until the installer has started, so the file cannot be swapped after this check.
    let staged = STAGING
        .take_reverified(&version, installer_update::verify_installer_signature)
        .map_err(|error| match error {
            ReverifyError::NotReady => refused(
                &version,
                "not_ready",
                "No verified installer is ready for this update. Download it again.".to_string(),
            ),
            ReverifyError::Changed(message) => refused(&version, "signature_invalid", message),
        })?;
    log_decision("verified", Some(&version), "prelaunch");

    let params = install_parameters.as_deref().filter(|p| !p.trim().is_empty());
    let params_accepted = params.and_then(installer_update::manifest_ui_level).is_some();
    if params.is_some() && !params_accepted {
        log_decision("refused", Some(&version), "install_parameters");
    }
    let consent = installer_consent(
        &app_prefs::read_prefs_sync(&app),
        app_prefs::pending_installer_consent_handoff().as_ref(),
        app_prefs::current_windows_user_sid_string(),
    );
    let command_line = installer_update::installer_command_line(params, &consent);
    let installer = installer_update::launch_installer(&staged.path, Some(&command_line))
        .map_err(|message| refused(&version, "launch_failed", message))?;
    drop(staged);
    let ui = if params_accepted { "manifest_parameters" } else { "basic_ui" };
    log_decision("launched", Some(&version), ui);
    start_relaunch_watcher(installer.as_ref());
    Ok(())
}

/// The installer relaunches SuperClaw only after a successful install; the watcher covers a
/// cancelled or failed one. Without it the update still proceeds, as it did before.
#[cfg(windows)]
fn start_relaunch_watcher(installer: Option<&installer_update::InstallerProcess>) {
    let outcome = match installer.map(crate::installer_relaunch::start) {
        Some(Ok(pid)) => format!("relaunch_watcher=started pid={pid}"),
        Some(Err(reason)) => format!("relaunch_watcher=not_started reason={reason}"),
        None => "relaunch_watcher=not_started reason=no_installer_process_handle".to_string(),
    };
    tracing::info!(component = "tauri", stage = "ota", "ota {outcome}");
}

#[cfg(not(windows))]
fn start_relaunch_watcher(_installer: Option<&installer_update::InstallerProcess>) {}

/// The effective telemetry gates, not the raw prefs: consent the user never completed, or an
/// installer opt-out that did not persist, must reach the installer as No.
fn installer_consent(
    prefs: &AppPrefs,
    pending: Option<&InstallerCrashLogsConsent>,
    user_sid: Option<String>,
) -> InstallerConsent {
    InstallerConsent {
        crash_logs: app_prefs::resolve_full_telemetry_enabled_for_gating_with_pending(prefs, pending),
        baseline_telemetry: app_prefs::resolve_baseline_telemetry_enabled_for_gating_with_pending(
            prefs, pending,
        ),
        user_sid,
    }
}

/// Whether the OTA test channel (manifest URL override, http loopback update
/// URLs) is on: Debug builds, or QA builds compiled with
/// `SUPERCLAW_OTA_TEST_CHANNEL=1`. Never widens the installer signature skip.
fn ota_test_channel_enabled(debug_build: bool, test_channel_env: Option<&str>) -> bool {
    debug_build || test_channel_env == Some("1")
}

/// [`ota_test_channel_enabled`] for this binary. The env var is read at
/// compile time; setting it on an installed app does nothing.
fn ota_test_channel() -> bool {
    ota_test_channel_enabled(
        cfg!(debug_assertions),
        option_env!("SUPERCLAW_OTA_TEST_CHANNEL"),
    )
}

/// The `SUPERCLAW_UPDATE_MANIFEST_URL` override and the repository it names: a loopback URL
/// (no repository) or `https://github.com/<owner>/<name>/releases/...`. `None` unless the OTA
/// test channel is on.
fn manifest_url_override(raw: Option<&str>, test_channel: bool) -> Option<(String, Option<String>)> {
    if !test_channel {
        return None;
    }
    let parsed = Url::parse(raw?.trim()).ok()?;
    let loopback = UpdateOrigin { releases_repo: None, allow_test_loopback: true };
    if loopback.allows(&parsed) {
        return Some((parsed.to_string(), None));
    }
    let mut segments = parsed.path_segments()?;
    let repo = format!("{}/{}", segments.next()?, segments.next()?);
    let github = UpdateOrigin { releases_repo: Some(repo.clone()), allow_test_loopback: false };
    (is_valid_releases_repo(&repo) && github.allows(&parsed)).then(|| (parsed.to_string(), Some(repo)))
}

/// One `ota decision=<word> version=<v> reason=<word>` line. The version comes from the
/// manifest, so anything that is not a dotted version is logged as `invalid`; `none` is a
/// decision made before any manifest version was read.
fn log_decision(decision: &str, version: Option<&str>, reason: &str) {
    let version = match version {
        None => "none",
        Some(version) if is_valid_version(version) => version,
        Some(_) => "invalid",
    };
    tracing::info!(
        component = "tauri",
        stage = "ota",
        "ota decision={decision} version={version} reason={reason}"
    );
}

/// Dotted numeric, 1-4 parts: what the UI's manifest parser accepts.
fn is_valid_version(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    value.len() <= MAX_VERSION_LEN
        && (1..=4).contains(&parts.len())
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use crate::commands::app_prefs::{self, AppPrefs};
    use crate::installer_update::installer_command_line;
    use crate::installer_update::UpdateOrigin;
    use super::{
        is_valid_releases_repo, is_valid_version, manifest_url_override, ota_test_channel,
        ota_test_channel_enabled, product_version, resolve_update_source, PROD_RELEASES_REPO,
    };

    fn consent_line(prefs: &AppPrefs, pending: Option<&app_prefs::InstallerCrashLogsConsent>) -> String {
        installer_command_line(None, &super::installer_consent(prefs, pending, None))
    }

    fn assert_consent(line: &str, crash_logs: &str, baseline: &str) {
        assert!(line.contains(&format!(" SC_CRASH_LOGS_CHOICE={crash_logs} ")), "{line}");
        assert!(line.ends_with(&format!(" SC_BASELINE_TELEMETRY_CHOICE={baseline}")), "{line}");
    }

    fn consented_prefs() -> AppPrefs {
        AppPrefs {
            full_telemetry_enabled: true,
            baseline_telemetry_enabled: true,
            install_telemetry_consent_completed: true,
            install_telemetry_consent_revision: Some("install-1".to_string()),
            ..AppPrefs::default()
        }
    }

    fn unique_prefs_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("superclaw-updater-test-{}.json", uuid::Uuid::new_v4()))
    }

    #[test]
    fn missing_prefs_send_no_consent_to_the_installer() {
        let prefs = app_prefs::read_prefs_at(&unique_prefs_path());
        assert!(prefs.baseline_telemetry_enabled && !prefs.install_telemetry_consent_completed);
        assert_consent(&consent_line(&prefs, None), "No", "No");
    }

    #[test]
    fn corrupt_prefs_send_no_consent_to_the_installer() {
        let path = unique_prefs_path();
        std::fs::write(&path, "{not json").expect("write");
        let prefs = app_prefs::read_prefs_at(&path);
        let _ = std::fs::remove_file(&path);
        assert_consent(&consent_line(&prefs, None), "No", "No");
    }

    #[test]
    fn an_unpersisted_installer_opt_out_reaches_the_installer_as_no() {
        let pending = app_prefs::installer_consent_handoff_for_test(false, Some(false), Some("install-2"));
        assert_consent(&consent_line(&consented_prefs(), Some(&pending)), "No", "No");
    }

    #[test]
    fn completed_consent_reaches_the_installer_unchanged() {
        assert_consent(&consent_line(&consented_prefs(), None), "Yes", "Yes");
        let prefs = AppPrefs {
            full_telemetry_enabled: false,
            ..consented_prefs()
        };
        assert_consent(&consent_line(&prefs, None), "No", "Yes");
    }

    #[test]
    fn ota_test_channel_is_debug_or_an_exact_build_flag() {
        assert!(ota_test_channel_enabled(true, None));
        assert!(ota_test_channel_enabled(false, Some("1")));
        assert!(!ota_test_channel_enabled(false, None));
        for value in ["", "0", "true", "yes", " 1"] {
            assert!(!ota_test_channel_enabled(false, Some(value)), "enabled by {value:?}");
        }
        // Test builds have debug_assertions, so the compiled-in decision is on.
        assert!(ota_test_channel());
    }

    #[test]
    fn manifest_override_is_debug_only() {
        let local = "http://127.0.0.1:8000/SuperClawManifest.xml";
        assert_eq!(manifest_url_override(Some(local), false), None);
        assert_eq!(manifest_url_override(Some(local), true), Some((local.to_string(), None)));
        assert_eq!(manifest_url_override(Some("http://evil.example/m.xml"), true), None);
        assert_eq!(manifest_url_override(None, true), None);
    }

    #[test]
    fn a_manifest_override_may_name_another_repositorys_releases() {
        let staging = "https://github.com/qa-org/superclaw-ota-staging/releases/download/v2.0.0.1002/SuperClawManifest.xml";
        assert_eq!(
            manifest_url_override(Some(staging), true),
            Some((staging.to_string(), Some("qa-org/superclaw-ota-staging".to_string())))
        );
        assert_eq!(manifest_url_override(Some(staging), false), None);
        for refused in [
            "http://github.com/qa-org/x/releases/latest/download/SuperClawManifest.xml",
            "https://github.com/qa-org/x/blob/main/SuperClawManifest.xml",
            "https://github.com/qa-org/releases/latest",
            "https://raw.githubusercontent.com/qa-org/x/main/SuperClawManifest.xml",
            "https://evil.example/qa-org/x/releases/SuperClawManifest.xml",
        ] {
            assert_eq!(manifest_url_override(Some(refused), true), None, "{refused}");
        }
    }

    const PROD: &str = "example-org/superclaw";
    const STAGING: &str = "example-org/superclaw-ota-staging";

    #[test]
    fn each_channel_reads_the_latest_release_of_its_repository() {
        let prod = resolve_update_source(PROD, STAGING, None, None, false).expect("prod");
        assert_eq!(prod.channel, "prod");
        assert_eq!(
            prod.manifest_url,
            "https://github.com/example-org/superclaw/releases/latest/download/SuperClawManifest.xml"
        );
        assert_eq!(prod.origin, UpdateOrigin { releases_repo: Some(PROD.to_string()), allow_test_loopback: false });

        let staging = resolve_update_source(PROD, STAGING, Some(" Staging "), None, false).expect("staging");
        assert_eq!(staging.channel, "staging");
        assert_eq!(
            staging.manifest_url,
            "https://github.com/example-org/superclaw-ota-staging/releases/latest/download/SuperClawManifest.xml"
        );
        assert_eq!(resolve_update_source(PROD, STAGING, Some("beta"), None, false).unwrap().channel, "prod");
    }

    #[test]
    fn the_shipped_prod_repository_is_valid() {
        assert!(is_valid_releases_repo(PROD_RELEASES_REPO), "{PROD_RELEASES_REPO:?}");
    }

    #[test]
    fn a_channel_without_a_repository_has_no_update_source() {
        assert_eq!(resolve_update_source("", STAGING, None, None, false), None);
        assert_eq!(resolve_update_source(PROD, "", Some("staging"), None, false), None);
        for bad in ["superclaw", "a/b/c", "/superclaw", "org/", "org/..", "org name/x", "org/x?y"] {
            assert_eq!(resolve_update_source(bad, STAGING, None, None, false), None, "{bad}");
        }
    }

    #[test]
    fn an_honoured_override_replaces_the_channel() {
        let local = Some("http://127.0.0.1:8765/SuperClawManifest.xml");
        let source = resolve_update_source("", "", None, local, true).expect("override");
        assert_eq!(source.channel, "override");
        assert_eq!(source.origin, UpdateOrigin { releases_repo: None, allow_test_loopback: true });
        assert_eq!(resolve_update_source(PROD, STAGING, None, local, false).unwrap().channel, "prod");
        assert_eq!(resolve_update_source(PROD, STAGING, None, Some("not a url"), true).unwrap().channel, "prod");
    }

    #[test]
    fn the_installed_version_is_only_a_stamped_dotted_build_version() {
        assert_eq!(product_version(Some("0.1.0.1009")), Some("0.1.0.1009"));
        assert_eq!(product_version(Some(" 2.0.1.1001\n")), Some("2.0.1.1001"));
        for unknown in [None, Some(""), Some("  "), Some("2.0.1-dev")] {
            assert_eq!(product_version(unknown), None, "{unknown:?}");
        }
    }

    #[test]
    fn versions_are_dotted_numeric_with_one_to_four_parts() {
        for ok in ["2", "2.0", "2.0.1", "2.0.1.617", "10.20.30.40"] {
            assert!(is_valid_version(ok), "refused {ok}");
        }
        for bad in [
            "", ".", "2.", ".2", "2..1", "2.0.1.5.6", "2.0.1-rc1", "2.0.1+build", "v2.0.1", "2.0.x",
            " 2.0.1", "２.0.1",
        ] {
            assert!(!is_valid_version(bad), "accepted {bad:?}");
        }
    }
}
