//! In-app download + launch of the signed Advanced Installer package a GitHub Release offers.
//! URL policy mirrors `apps/ui/src/shared/util/update-manifest.ts`.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use url::Url;

pub const APP_UPDATE_PROGRESS_EVENT: &str = "superclaw://app-update-progress";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateProgressPayload {
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_downloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pct: Option<f64>,
}

static INSTALL_PROGRESS: OnceLock<Mutex<Option<AppUpdateProgressPayload>>> = OnceLock::new();

fn install_progress_slot() -> &'static Mutex<Option<AppUpdateProgressPayload>> {
    INSTALL_PROGRESS.get_or_init(|| Mutex::new(None))
}

pub fn clear_install_progress() {
    if let Ok(mut slot) = install_progress_slot().lock() {
        *slot = None;
    }
}

pub fn publish_install_progress(payload: AppUpdateProgressPayload) {
    if let Ok(mut slot) = install_progress_slot().lock() {
        *slot = Some(payload);
    }
}

pub fn read_install_progress() -> Option<AppUpdateProgressPayload> {
    install_progress_slot()
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
}

const GITHUB_HOST: &str = "github.com";
/// Where github.com redirects a release asset download; trusted only as the end of a redirect.
const RELEASE_ASSET_HOSTS: [&str; 2] = ["release-assets.githubusercontent.com", "objects.githubusercontent.com"];
/// Required `SignerCertificate.Subject` organization (Authenticode DN).
const EXPECTED_INSTALLER_SIGNER_ORG: &str = "O=Intel Corporation";
/// Cap installer download size (bytes).
const MAX_INSTALLER_BYTES: u64 = 3 * 1024 * 1024 * 1024;

/// Where update files may come from: the Releases of one GitHub repository and, in Debug and OTA
/// test-channel builds only, a loopback server.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UpdateOrigin {
    /// `owner/name`; `None` for a loopback test server.
    pub releases_repo: Option<String>,
    pub allow_test_loopback: bool,
}

impl UpdateOrigin {
    /// HTTPS under `https://github.com/<releases_repo>/releases/`, or (only when
    /// `allow_test_loopback`) `http://localhost` / `http://127.0.0.1` on any port.
    pub(crate) fn allows(&self, url: &Url) -> bool {
        if self.allow_test_loopback && url.scheme() == "http" && is_loopback_host(url.host()) {
            return true;
        }
        url.scheme() == "https"
            && self
                .releases_repo
                .as_deref()
                .is_some_and(|repo| is_repo_releases_url(url, repo))
    }

    /// A redirect may end where [`Self::allows`], or on GitHub's release asset CDN.
    fn allows_redirect_target(&self, url: &Url) -> bool {
        self.allows(url)
            || (self.releases_repo.is_some()
                && url.scheme() == "https"
                && url
                    .host_str()
                    .is_some_and(|host| RELEASE_ASSET_HOSTS.iter().any(|cdn| host.eq_ignore_ascii_case(cdn))))
    }
}

fn is_repo_releases_url(url: &Url, repo: &str) -> bool {
    url.host_str().is_some_and(|host| host.eq_ignore_ascii_case(GITHUB_HOST))
        && url.port().is_none()
        && url
            .path()
            .to_ascii_lowercase()
            .starts_with(&format!("/{}/releases/", repo.to_ascii_lowercase()))
}

/// Returns the normalized URL string if `origin` allows it and it names an `.exe`, else None.
pub fn normalize_install_url(raw: &str, origin: &UpdateOrigin) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = Url::parse(trimmed).ok()?;
    if !origin.allows(&parsed) {
        return None;
    }
    let path = parsed.path().to_ascii_lowercase();
    if !path.ends_with(".exe") {
        return None;
    }
    Some(parsed.to_string())
}

fn updates_dir() -> PathBuf {
    std::env::temp_dir().join("SuperClaw").join("updates")
}

fn installer_filename(url: &Url) -> String {
    let segment = url
        .path_segments()
        .and_then(|mut s| s.next_back())
        .unwrap_or("SuperClaw-Setup.exe");
    let mut name = segment
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect::<String>();
    if !name.to_ascii_lowercase().ends_with(".exe") {
        name.push_str(".exe");
    }
    if name.is_empty() {
        name = "SuperClaw-Setup.exe".to_string();
    }
    name
}

fn pct_from_bytes(downloaded: u64, total: Option<u64>) -> Option<f64> {
    let total = total?;
    if total == 0 {
        return None;
    }
    Some((downloaded as f64 / total as f64) * 100.0)
}

/// The downloaded installer still has to pass [`verify_installer_signature`], whatever `origin` allows.
pub fn download_installer<F>(
    install_url: &str,
    origin: &UpdateOrigin,
    mut on_progress: Option<F>,
) -> Result<PathBuf, String>
where
    F: FnMut(AppUpdateProgressPayload),
{
    let normalized = normalize_install_url(install_url, origin)
        .ok_or_else(|| "Installer URL is missing or not on a trusted host.".to_string())?;
    let parsed =
        Url::parse(&normalized).map_err(|e| format!("Invalid installer URL: {e}"))?;

    let response = fetch_update_url(
        &normalized,
        "installer",
        origin,
        Duration::from_secs(30),
        Duration::from_secs(3600),
    )
    .map_err(|e| e.to_string())?;

    let bytes_total = response
        .header("Content-Length")
        .and_then(|value| value.trim().parse::<u64>().ok());

    if let Some(ref mut progress) = on_progress {
        let initial = AppUpdateProgressPayload {
            phase: "download".to_string(),
            bytes_downloaded: Some(0),
            bytes_total,
            pct: Some(0.0),
        };
        publish_install_progress(initial.clone());
        progress(initial);
    }

    let dir = updates_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create update directory: {e}"))?;
    let dest = dir.join(installer_filename(&parsed));
    let partial = dest.with_extension("exe.part");

    let mut reader = response.into_reader();
    let mut file = fs::File::create(&partial)
        .map_err(|e| format!("Failed to write installer to disk: {e}"))?;

    let mut buffer = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    let mut last_emit = Instant::now();
    const EMIT_INTERVAL: Duration = Duration::from_millis(250);
    const EMIT_BYTE_STEP: u64 = 512 * 1024;
    let mut last_emit_bytes: u64 = 0;

    let mut maybe_emit = |downloaded: u64, force: bool| {
        let Some(ref mut progress) = on_progress else {
            return;
        };
        if !force {
            let elapsed = last_emit.elapsed();
            let bytes_since = downloaded.saturating_sub(last_emit_bytes);
            if elapsed < EMIT_INTERVAL && bytes_since < EMIT_BYTE_STEP {
                return;
            }
        }
        last_emit = Instant::now();
        last_emit_bytes = downloaded;
        let payload = AppUpdateProgressPayload {
            phase: "download".to_string(),
            bytes_downloaded: Some(downloaded),
            bytes_total,
            pct: pct_from_bytes(downloaded, bytes_total),
        };
        publish_install_progress(payload.clone());
        progress(payload);
    };

    loop {
        let n = reader
            .read(&mut buffer)
            .map_err(|e| format!("Failed while reading installer: {e}"))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > MAX_INSTALLER_BYTES {
            let _ = fs::remove_file(&partial);
            return Err("Installer download exceeds the maximum allowed size.".to_string());
        }
        file.write_all(&buffer[..n])
            .map_err(|e| format!("Failed while writing installer: {e}"))?;
        maybe_emit(total, false);
    }
    maybe_emit(total, true);
    file.sync_all()
        .map_err(|e| format!("Failed to flush installer file: {e}"))?;
    drop(file);

    if dest.exists() {
        fs::remove_file(&dest).map_err(|e| format!("Failed to replace prior installer: {e}"))?;
    }
    fs::rename(&partial, &dest).map_err(|e| format!("Failed to finalize installer path: {e}"))?;

    Ok(dest)
}

fn is_loopback_host(host: Option<url::Host<&str>>) -> bool {
    match host {
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
        _ => false,
    }
}

#[derive(Debug)]
pub(crate) enum FetchError {
    /// A redirect left HTTPS or ended outside [`UpdateOrigin::allows_redirect_target`].
    UntrustedRedirect(String),
    Failed(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UntrustedRedirect(message) | Self::Failed(message) => f.write_str(message),
        }
    }
}

const MAX_UPDATE_REDIRECTS: u32 = 5;

/// GET an update URL (manifest or installer) whose start URL
/// the caller already validated. Redirects are followed, but every hop of an
/// HTTPS start must stay HTTPS and the final URL must pass
/// [`UpdateOrigin::allows_redirect_target`].
///
/// The env proxy applies to every target except loopback (Debug local servers).
pub(crate) fn fetch_update_url(
    url: &str,
    what: &str,
    origin: &UpdateOrigin,
    timeout_connect: Duration,
    timeout_read: Duration,
) -> Result<ureq::Response, FetchError> {
    let start = Url::parse(url).map_err(|e| FetchError::Failed(format!("Invalid {what} URL: {e}")))?;
    let agent = update_agent(&start, timeout_connect, timeout_read);
    let response = agent.get(url).call().map_err(|e| call_error(e, what))?;
    let final_url = Url::parse(response.get_url()).map_err(|_| untrusted_redirect(what))?;
    if !origin.allows_redirect_target(&final_url) {
        return Err(untrusted_redirect(what));
    }

    let status = response.status();
    if !(200..300).contains(&status) {
        return Err(FetchError::Failed(format!(
            "Download of {what} failed with HTTP {status}"
        )));
    }
    Ok(response)
}

/// ureq applies `https_only` to every hop it opens, redirects included.
fn update_agent(start: &Url, timeout_connect: Duration, timeout_read: Duration) -> ureq::Agent {
    let builder = ureq::AgentBuilder::new()
        .redirects(MAX_UPDATE_REDIRECTS)
        .https_only(start.scheme() == "https")
        .timeout_connect(timeout_connect)
        .timeout_read(timeout_read);
    crate::http_proxy::apply_env_proxy_for_url(builder, start.as_str()).build()
}

fn untrusted_redirect(what: &str) -> FetchError {
    FetchError::UntrustedRedirect(format!("Download of {what} was redirected to an untrusted location."))
}

fn call_error(error: ureq::Error, what: &str) -> FetchError {
    if error.kind() == ureq::ErrorKind::InsecureRequestHttpsOnly {
        untrusted_redirect(what)
    } else {
        FetchError::Failed(format!("Failed to download {what}: {error}"))
    }
}

fn skip_signature_check_requested() -> bool {
    match std::env::var("SUPERCLAW_SKIP_INSTALLER_SIGNATURE_CHECK") {
        Ok(value) => {
            let v = value.trim();
            v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("yes")
        }
        Err(_) => false,
    }
}

#[cfg(windows)]
pub fn verify_installer_signature(path: &Path) -> Result<(), String> {
    if cfg!(debug_assertions) && skip_signature_check_requested() {
        return Ok(());
    }

    crate::installer_authenticode::verify_signed_installer(path, EXPECTED_INSTALLER_SIGNER_ORG)
        .map_err(|detail| format!("Installer signature verification failed. {detail}"))
}

#[cfg(not(windows))]
pub fn verify_installer_signature(_path: &Path) -> Result<(), String> {
    Err("In-app installer launch is supported on Windows only.".to_string())
}

#[cfg(windows)]
fn encode_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn encode_wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Advanced Installer bootstrapper switch, always first: its own switches must precede msiexec's.
/// `/exenoui`, never `/exebasicui`: the bootstrapper's own UI sets taskbar progress per file,
/// which pegs explorer.exe and freezes the taskbar for minutes.
const BOOTSTRAPPER_SWITCH: &str = "/exenoui";
/// Always last among the switches: an update never reboots the machine on its own.
const NO_RESTART_SWITCH: &str = "/norestart";
/// `/qb` shows progress, Cancel and error boxes, but no wizard pages and no completion box.
const DEFAULT_UI_LEVEL: &str = "/qb";

/// The msiexec UI levels a manifest may choose; nothing else of the command line is its to set.
const MANIFEST_UI_LEVELS: [&str; 5] = ["/qb", "/qb-", "/qb!", "/qn", "/passive"];

/// The UI level `parameters` names, in its allowlisted spelling. A manifest may repeat the two
/// switches that are always emitted; anything else, or more than one UI level, is `None`.
pub fn manifest_ui_level(parameters: &str) -> Option<&'static str> {
    let mut levels = parameters.split_whitespace().filter(|token| {
        !token.eq_ignore_ascii_case(BOOTSTRAPPER_SWITCH) && !token.eq_ignore_ascii_case(NO_RESTART_SWITCH)
    });
    let level = levels.next()?;
    if levels.next().is_some() {
        return None;
    }
    MANIFEST_UI_LEVELS
        .into_iter()
        .find(|allowed| allowed.eq_ignore_ascii_case(level))
}

/// The user's current consent, handed to the installer's consent custom action. Without a
/// wizard that action writes its dialog defaults (Yes) under a new revision, which the app
/// then re-seeds into prefs on first launch.
pub struct InstallerConsent {
    pub crash_logs: bool,
    pub baseline_telemetry: bool,
    pub user_sid: Option<String>,
}

/// `manifest_parameters` choose only the msiexec UI level, when [`manifest_ui_level`] accepts
/// them; the properties are always appended. `SC_RELAUNCH_APP=1` makes the installer start
/// SuperClaw after a successful non-wizard install (`SC_LaunchSuperClaw` in `SuperClaw.aip`).
pub fn installer_command_line(manifest_parameters: Option<&str>, consent: &InstallerConsent) -> String {
    let ui_level = manifest_parameters
        .and_then(manifest_ui_level)
        .unwrap_or(DEFAULT_UI_LEVEL);
    let yes_no = |enabled: bool| if enabled { "Yes" } else { "No" };
    let mut line = format!(
        "{BOOTSTRAPPER_SWITCH} {ui_level} {NO_RESTART_SWITCH} SC_RELAUNCH_APP=1 SC_CRASH_LOGS_CHOICE={} \
         SC_BASELINE_TELEMETRY_CHOICE={}",
        yes_no(consent.crash_logs),
        yes_no(consent.baseline_telemetry),
    );
    if let Some(sid) = consent.user_sid.as_deref().filter(|sid| is_sid_string(sid)) {
        line.push_str(" SC_CRASH_LOGS_INSTALLER_USER_SID=");
        line.push_str(sid);
    }
    line
}

fn is_sid_string(value: &str) -> bool {
    value.strip_prefix("S-").is_some_and(|rest| {
        rest.split('-').count() >= 2
            && rest
                .split('-')
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    })
}

#[cfg(windows)]
pub type InstallerProcess = std::os::windows::io::OwnedHandle;
#[cfg(not(windows))]
pub type InstallerProcess = std::convert::Infallible;

/// Launch the AdvInst setup via ShellExecute so Windows can show UAC for
/// `requireAdministrator` installers (`CreateProcess` / `Command::spawn` returns 740).
/// Returns the installer's process handle when the shell hands one back.
#[cfg(windows)]
pub fn launch_installer(path: &Path, install_parameters: Option<&str>) -> Result<Option<InstallerProcess>, String> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOW;

    let file = encode_wide_path(path);
    let operation = encode_wide("open");
    let parameters = install_parameters
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(encode_wide);

    // SAFETY: all-zero is a valid SHELLEXECUTEINFOW (null pointers, no optional members).
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = operation.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = parameters
        .as_ref()
        .map(|value| value.as_ptr())
        .unwrap_or(std::ptr::null());
    info.nShow = SW_SHOW;
    tracing::info!(component = "tauri", stage = "ota", "elevation: op=installer event=begin");
    let started_at = time::OffsetDateTime::now_utc();
    let started = Instant::now();
    let launched = unsafe { ShellExecuteExW(&mut info) } != 0;
    let last_error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
    let wall = started.elapsed();

    // Per ShellExecute docs, values <= 32 indicate failure.
    let code = info.hInstApp as isize;
    let outcome = installer_elevation_outcome(launched, last_error);
    tracing::info!(
        component = "tauri",
        stage = "ota",
        "{}",
        installer_elevation_end_line(&outcome, started_at, wall)
    );
    if launched {
        Ok((!info.hProcess.is_null()).then(|| unsafe { InstallerProcess::from_raw_handle(info.hProcess) }))
    } else {
        Err(format!(
            "Failed to start installer (ShellExecute error {code}). If you cancelled the permission prompt, try again."
        ))
    }
}

#[cfg(not(windows))]
pub fn launch_installer(_path: &Path, _install_parameters: Option<&str>) -> Result<Option<InstallerProcess>, String> {
    Err("In-app installer launch is supported on Windows only.".to_string())
}

/// `ERROR_CANCELLED`: the user dismissed the UAC prompt.
const ERROR_CANCELLED: u32 = 1223;

/// `succeeded`, `cancelled_by_user` or `failed:win32_<last_error>`, in the outcome grammar defined by
/// `host/sandbox_manager/src/sandbox_manager/broker_client/elevation_log.py`. `last_error` must be read
/// straight after `ShellExecuteExW` returns.
#[cfg_attr(not(windows), allow(dead_code))]
fn installer_elevation_outcome(launched: bool, last_error: u32) -> String {
    if launched {
        "succeeded".to_string()
    } else if last_error == ERROR_CANCELLED {
        "cancelled_by_user".to_string()
    } else {
        format!("failed:win32_{last_error}")
    }
}

/// The `end` line for one installer elevation. No consent/work split: `ShellExecuteExW` returns once
/// the setup process exists, so the wall time is the consent wait. Carries no path, command line or SID.
#[cfg_attr(not(windows), allow(dead_code))]
fn installer_elevation_end_line(outcome: &str, started_at: time::OffsetDateTime, wall: Duration) -> String {
    let started_at = started_at
        .to_offset(time::UtcOffset::UTC)
        .format(time::macros::format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]+00:00"
        ))
        .unwrap_or_else(|_| "unknown".to_string());
    format!(
        "elevation: op=installer event=end outcome={outcome} started_at={started_at} wall_ms={}",
        (wall.as_secs_f64() * 1000.0).round() as u64
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPO: &str = "example-org/superclaw";

    fn origin(repo: Option<&str>, allow_test_loopback: bool) -> UpdateOrigin {
        UpdateOrigin {
            releases_repo: repo.map(str::to_string),
            allow_test_loopback,
        }
    }

    #[test]
    fn trusted_install_urls_accepted() {
        let release = origin(Some(REPO), false);
        for url in [
            "https://github.com/example-org/superclaw/releases/download/v2.0.0/SuperClaw-Setup-2.0.0.1030.exe",
            "https://github.com/Example-Org/SuperClaw/releases/latest/download/SuperClaw-Setup.exe",
        ] {
            assert_eq!(normalize_install_url(url, &release).as_deref(), Some(url));
        }
    }

    #[test]
    fn a_loopback_installer_url_is_accepted_only_by_test_builds() {
        let url = "http://127.0.0.1:8765/SuperClaw-Setup-1.3.0.1009.exe";
        assert!(normalize_install_url(url, &origin(Some(REPO), false)).is_none());
        assert_eq!(normalize_install_url(url, &origin(None, true)).as_deref(), Some(url));
        assert!(normalize_install_url("http://127.0.0.1:8765/setup.zip", &origin(None, true)).is_none());
    }

    /// Serve one connection on `listener` with the raw `response`, then close.
    fn serve_once(listener: std::net::TcpListener, response: String) {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let (mut stream, _) = listener.accept().expect("accept");
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            while reader.read_line(&mut line).unwrap_or(0) > 0 && line != "\r\n" {
                line.clear();
            }
            let _ = stream.write_all(response.as_bytes());
        });
    }

    /// `http://127.0.0.1:<a>/start.zip` answering 302 to `target_host`, which serves 200.
    fn redirect_to(target_host: &str) -> String {
        let target = std::net::TcpListener::bind((target_host, 0)).expect("bind target");
        let location = format!("http://{target_host}:{}/final.zip", target.local_addr().unwrap().port());
        serve_once(target, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_string());
        let start = std::net::TcpListener::bind("127.0.0.1:0").expect("bind start");
        let port = start.local_addr().unwrap().port();
        serve_once(
            start,
            format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
        );
        format!("http://127.0.0.1:{port}/start.zip")
    }

    fn fetch(url: &str, allow_test_loopback: bool) -> Result<ureq::Response, FetchError> {
        let origin = origin(Some(REPO), allow_test_loopback);
        fetch_update_url(url, "test", &origin, Duration::from_secs(5), Duration::from_secs(5))
    }

    #[test]
    fn release_rule_refuses_a_plain_http_url_even_on_loopback() {
        let result = fetch(&redirect_to("127.0.0.1"), false);
        assert!(matches!(result, Err(FetchError::UntrustedRedirect(_))), "{result:?}");
    }

    /// A unit test cannot serve HTTPS with a certificate ureq trusts, so this drives the agent an
    /// HTTPS start gets at the plain-HTTP hop a redirect would hand it: ureq opens every hop
    /// through the same `https_only` check, and refuses it before connecting.
    #[test]
    fn an_https_start_refuses_a_redirect_hop_to_plain_http() {
        let start = Url::parse("https://github.com/example-org/superclaw/releases/latest/download/SuperClawManifest.xml")
            .unwrap();
        let agent = update_agent(&start, Duration::from_secs(5), Duration::from_secs(5));
        let error = agent.get("http://127.0.0.1:9/final.zip").call().expect_err("plain http hop");
        assert_eq!(error.kind(), ureq::ErrorKind::InsecureRequestHttpsOnly);
        assert!(matches!(call_error(error, "test"), FetchError::UntrustedRedirect(_)));
    }

    #[test]
    fn debug_rule_follows_a_redirect_that_stays_on_loopback() {
        let response = fetch(&redirect_to("127.0.0.1"), true).expect("loopback redirect allowed in Debug");
        assert_eq!(response.status(), 200);
    }

    #[test]
    fn debug_rule_refuses_a_redirect_to_another_host() {
        let result = fetch(&redirect_to("127.0.0.2"), true);
        assert!(matches!(result, Err(FetchError::UntrustedRedirect(_))), "{result:?}");
    }

    #[test]
    fn update_origin_rules_per_build() {
        let allowed = |url: &str, debug: bool| origin(Some(REPO), debug).allows(&Url::parse(url).unwrap());
        assert!(allowed("https://github.com/example-org/superclaw/releases/download/v2/x.zip", false));
        assert!(!allowed("https://github.com/example-org/superclaw-evil/releases/download/v2/x.zip", false));
        assert!(!allowed("https://github.com/other-org/superclaw/releases/download/v2/x.zip", false));
        assert!(!allowed("https://github.com/example-org/superclaw/archive/main.zip", false));
        assert!(!allowed("https://github.com/example-org/superclaw/releases/../../../other-org/x/releases/x.zip", false));
        assert!(!allowed("https://github.com:8443/example-org/superclaw/releases/download/v2/x.zip", false));
        assert!(!allowed("https://github.com.evil.example/example-org/superclaw/releases/x.zip", false));
        assert!(!allowed("http://github.com/example-org/superclaw/releases/download/v2/x.zip", false));
        assert!(!allowed("https://release-assets.githubusercontent.com/x.zip", false));
        assert!(!allowed("https://evil.example/x.zip", false));
        assert!(!allowed("http://127.0.0.1:8000/x.zip", false));
        assert!(allowed("http://127.0.0.1:8000/x.zip", true));
        assert!(allowed("http://localhost/x.zip", true));
        assert!(!allowed("http://127.0.0.2/x.zip", true));
        assert!(!allowed("http://evil.example/x.zip", true));
        assert!(!allowed("https://localhost/x.zip", true));
        let no_repo = origin(None, false);
        assert!(!no_repo.allows(&Url::parse("https://github.com/example-org/superclaw/releases/x.exe").unwrap()));
    }

    #[test]
    fn a_redirect_may_end_on_the_release_asset_cdn_only() {
        let ends = |origin: &UpdateOrigin, url: &str| origin.allows_redirect_target(&Url::parse(url).unwrap());
        let release = origin(Some(REPO), false);
        assert!(ends(&release, "https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sig=x"));
        assert!(ends(&release, "https://objects.githubusercontent.com/github-production-release-asset-2e65be/1/2"));
        assert!(ends(&release, "https://github.com/example-org/superclaw/releases/download/v2/x.exe"));
        assert!(!ends(&release, "http://release-assets.githubusercontent.com/x"));
        assert!(!ends(&release, "https://raw.githubusercontent.com/example-org/superclaw/main/x.exe"));
        assert!(!ends(&release, "https://github.com/other-org/x/releases/download/v2/x.exe"));
        assert!(!ends(&origin(None, true), "https://release-assets.githubusercontent.com/x"));
    }

    fn consent(crash_logs: bool, baseline_telemetry: bool, user_sid: Option<&str>) -> InstallerConsent {
        InstallerConsent {
            crash_logs,
            baseline_telemetry,
            user_sid: user_sid.map(str::to_string),
        }
    }

    #[test]
    fn default_command_line_is_msi_basic_ui_with_the_users_consent() {
        let line = installer_command_line(None, &consent(false, true, Some("S-1-5-21-1-2-3-1001")));
        assert_eq!(
            line,
            "/exenoui /qb /norestart SC_RELAUNCH_APP=1 SC_CRASH_LOGS_CHOICE=No \
             SC_BASELINE_TELEMETRY_CHOICE=Yes SC_CRASH_LOGS_INSTALLER_USER_SID=S-1-5-21-1-2-3-1001"
        );
        assert_eq!(
            installer_command_line(Some("   "), &consent(true, false, None)),
            "/exenoui /qb /norestart SC_RELAUNCH_APP=1 SC_CRASH_LOGS_CHOICE=Yes \
             SC_BASELINE_TELEMETRY_CHOICE=No"
        );
    }

    #[test]
    fn manifest_parameters_choose_only_the_msi_ui_level() {
        for (parameters, ui) in [(" /exenoui /qn ", "/qn"), ("/qn", "/qn"), ("/QB!", "/qb!"), ("/passive /norestart", "/passive")] {
            assert_eq!(
                installer_command_line(Some(parameters), &consent(false, false, None)),
                format!(
                    "/exenoui {ui} /norestart SC_RELAUNCH_APP=1 SC_CRASH_LOGS_CHOICE=No SC_BASELINE_TELEMETRY_CHOICE=No"
                ),
                "{parameters:?}"
            );
        }
    }

    #[test]
    fn manifest_parameters_outside_the_allowlist_are_ignored() {
        for parameters in [
            "/qb \"",
            "TRANSFORMS=x.mst",
            "APPDIR=C:\\Evil",
            "/L*v x",
            "/qn APPDIR=C:\\x",
            "/exebasicui /qb",
            "/exebasicui",
            "/qn /qb",
            "/exenoui /norestart",
        ] {
            let line = installer_command_line(Some(parameters), &consent(false, false, None));
            assert!(line.starts_with("/exenoui /qb /norestart SC_RELAUNCH_APP=1 "), "{parameters:?}: {line}");
            assert!(manifest_ui_level(parameters).is_none(), "{parameters:?}");
        }
    }

    #[test]
    fn ui_levels_match_case_insensitively_in_their_allowlisted_spelling() {
        for level in MANIFEST_UI_LEVELS {
            assert_eq!(manifest_ui_level(&level.to_ascii_uppercase()), Some(level));
        }
        assert_eq!(manifest_ui_level(" /EXENOUI\t/qn /NORESTART "), Some("/qn"));
        assert_eq!(manifest_ui_level("   "), None);
    }

    #[test]
    fn a_malformed_sid_is_left_off_the_command_line() {
        for sid in ["", "S-1", "S-1-5-21 /qn", "X-1-5", "S-1--5", "S-1-5-\"a\""] {
            let line = installer_command_line(None, &consent(false, false, Some(sid)));
            assert!(!line.contains("SC_CRASH_LOGS_INSTALLER_USER_SID"), "{sid:?}: {line}");
        }
    }

    #[test]
    fn untrusted_install_urls_rejected() {
        let test_build = origin(Some(REPO), true);
        for url in [
            "http://github.com/example-org/superclaw/releases/download/v2/x.exe",
            "https://evil.example/setup.exe",
            "https://github.com/other-org/x/releases/download/v2/setup.exe",
            "https://github.com/example-org/superclaw/releases/download/v2/",
            "https://release-assets.githubusercontent.com/setup.exe",
        ] {
            assert!(normalize_install_url(url, &test_build).is_none(), "{url}");
        }
    }

    fn started_at() -> time::OffsetDateTime {
        time::macros::datetime!(2026-10-07 05:52:58.930 UTC)
    }

    #[test]
    fn an_installer_that_started_is_logged_as_succeeded() {
        assert_eq!(installer_elevation_outcome(true, ERROR_CANCELLED), "succeeded");
        assert_eq!(
            installer_elevation_end_line("succeeded", started_at(), Duration::from_micros(3_490_600)),
            "elevation: op=installer event=end outcome=succeeded started_at=2026-10-07T05:52:58.930+00:00 wall_ms=3491"
        );
    }

    #[test]
    fn a_dismissed_prompt_is_logged_as_cancelled_by_user() {
        assert_eq!(installer_elevation_outcome(false, 1223), "cancelled_by_user");
    }

    #[test]
    fn any_other_shell_execute_failure_carries_its_win32_error() {
        assert_eq!(installer_elevation_outcome(false, 2), "failed:win32_2");
        assert_eq!(installer_elevation_outcome(false, 1155), "failed:win32_1155");
        assert_eq!(installer_elevation_outcome(false, 5), "failed:win32_5");
    }

    #[test]
    fn the_end_line_is_utc_and_carries_no_path_or_sid() {
        let local = started_at().to_offset(time::macros::offset!(-7));
        let line = installer_elevation_end_line("failed:win32_2", local, Duration::from_millis(12));
        assert_eq!(
            line,
            "elevation: op=installer event=end outcome=failed:win32_2 started_at=2026-10-07T05:52:58.930+00:00 wall_ms=12"
        );
        let command_line = installer_command_line(None, &consent(true, true, Some("S-1-5-21-1-2-3-1001")));
        for secret in ["S-1-", "SC_", "\\", "/", ".exe", command_line.as_str()] {
            assert!(!line.contains(secret), "{secret:?} in {line}");
        }
    }
}
