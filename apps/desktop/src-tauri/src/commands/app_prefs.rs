//! App preferences persisted to disk so the Rust shutdown path can read them
//! synchronously even when the webview has already torn down.
//!
//! Storage:
//!   <app_config_dir>/app_prefs.json
//!
//! Schema:
//!   {
//!     "keepBackendOnExit": bool,        // default false (stop backend on exit)
//!     "fullTelemetryEnabled": bool,     // default false (opt-in full telemetry, external)
//!     "baselineTelemetryEnabled": bool, // default true after installation consent (opt-out in Settings)
//!     "installTelemetryConsentCompleted": bool, // Rust-managed; set on first launch in setup
//!     "installTelemetryConsentRevision": string | null, // last installer choice applied
//!     "installId": string | null,       // pseudonymous UUIDv4; minted when baseline or telemetry is on
//!     "lastHeartbeatAt": number | null, // epoch millis of last active_install heartbeat
//!     "committedBundleId": string | null, // cached from ServiceHub after sandbox ready; read by host telemetry
//!     "cachedProductVersion": string | null // last sandbox-manager product version; read by host telemetry
//!   }
//!
//! The single `keepBackendOnExit` flag controls ALL local backend services
//! (backend-manager sidecar, llama-server children, sandbox services).
//! When true, `stop_managed_services` short-circuits and leaves everything
//! running so the next app launch can reuse the live processes via the
//! existing REUSE handshake.
//!
//! Telemetry is two-tiered. Baseline is on after install consent is acknowledged
//! unless the user turns it off in Settings.
//! Full / crash telemetry follows installer choice (seeded into prefs) and Settings.
//! First launch sets `installTelemetryConsentCompleted` in setup when still pending
//! (no first-run consent UI). Crash/full telemetry stays opt-in via Settings.
//! `installId` and `lastHeartbeatAt` are Rust-managed: the frontend never
//! authors them, and `write_app_prefs` preserves them across a UI round-trip so
//! a stale frontend payload cannot drop the install ID. See `write_app_prefs`
//! and `ensure_install_id`.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const PREFS_FILE: &str = "app_prefs.json";
const HEARTBEAT_INTERVAL_MS: i64 = 24 * 60 * 60 * 1_000;
static RUNTIME_INSTALL_ID_CACHE: OnceLock<Mutex<Option<Option<String>>>> = OnceLock::new();
static RUNTIME_INSTALL_ID_RESOLVE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn runtime_install_id_cache() -> &'static Mutex<Option<Option<String>>> {
    RUNTIME_INSTALL_ID_CACHE.get_or_init(|| Mutex::new(None))
}

fn runtime_install_id_resolve_lock() -> &'static Mutex<()> {
    RUNTIME_INSTALL_ID_RESOLVE_LOCK.get_or_init(|| Mutex::new(()))
}

fn clear_runtime_install_id_cache() {
    if let Ok(mut cache) = runtime_install_id_cache().lock() {
        // `None` means unresolved for this process. The next caller recomputes
        // from prefs under the new consent flags.
        *cache = None;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstallerCrashLogsConsent {
    enabled: bool,
    revision: Option<String>,
    /// `None` when the installer predates `BaselineTelemetryConsent` in HKLM.
    baseline_enabled: Option<bool>,
}

static FAILED_INSTALLER_CONSENT_HANDOFF: OnceLock<Mutex<Option<InstallerCrashLogsConsent>>> =
    OnceLock::new();

fn failed_installer_consent_handoff() -> &'static Mutex<Option<InstallerCrashLogsConsent>> {
    FAILED_INSTALLER_CONSENT_HANDOFF.get_or_init(|| Mutex::new(None))
}

fn remember_failed_installer_consent_handoff(consent: InstallerCrashLogsConsent) {
    if let Ok(mut handoff) = failed_installer_consent_handoff().lock() {
        *handoff = Some(consent);
    }
}

fn clear_failed_installer_consent_handoff() {
    if let Ok(mut handoff) = failed_installer_consent_handoff().lock() {
        *handoff = None;
    }
}

/// The installer hand-off that could not be persisted to prefs, if any.
pub(crate) fn pending_installer_consent_handoff() -> Option<InstallerCrashLogsConsent> {
    failed_installer_consent_handoff()
        .lock()
        .ok()
        .and_then(|handoff| handoff.clone())
}

#[cfg(test)]
pub(crate) fn installer_consent_handoff_for_test(
    enabled: bool,
    baseline_enabled: Option<bool>,
    revision: Option<&str>,
) -> InstallerCrashLogsConsent {
    InstallerCrashLogsConsent {
        enabled,
        revision: revision.map(str::to_string),
        baseline_enabled,
    }
}

/// Full/crash telemetry gate with an optional in-memory installer hand-off.
///
/// When prefs could not be persisted after a reinstall **opt-out**, the hand-off
/// forces telemetry off until disk catches up. It does not force opt-in on a
/// failed persist (Settings and on-disk prefs remain authoritative).
pub(crate) fn resolve_full_telemetry_enabled_for_gating_with_pending(
    prefs: &AppPrefs,
    pending: Option<&InstallerCrashLogsConsent>,
) -> bool {
    if !prefs.install_telemetry_consent_completed {
        return false;
    }
    if let Some(pending) = pending {
        let stale_revision = pending.revision.as_deref()
            != prefs.install_telemetry_consent_revision.as_deref();
        if stale_revision && !pending.enabled {
            return false;
        }
    }
    prefs.full_telemetry_enabled
}

pub(crate) fn resolve_full_telemetry_enabled_for_gating(prefs: &AppPrefs) -> bool {
    let pending = pending_installer_consent_handoff();
    resolve_full_telemetry_enabled_for_gating_with_pending(prefs, pending.as_ref())
}

/// Baseline telemetry gate with the same in-memory installer hand-off semantics as
/// [`resolve_full_telemetry_enabled_for_gating_with_pending`].
pub(crate) fn resolve_baseline_telemetry_enabled_for_gating_with_pending(
    prefs: &AppPrefs,
    pending: Option<&InstallerCrashLogsConsent>,
) -> bool {
    if !prefs.install_telemetry_consent_completed {
        return false;
    }
    if let Some(pending) = pending {
        let stale_revision = pending.revision.as_deref()
            != prefs.install_telemetry_consent_revision.as_deref();
        if stale_revision && pending.baseline_enabled == Some(false) {
            return false;
        }
    }
    prefs.baseline_telemetry_enabled
}

pub(crate) fn resolve_baseline_telemetry_enabled_for_gating(prefs: &AppPrefs) -> bool {
    let pending = pending_installer_consent_handoff();
    resolve_baseline_telemetry_enabled_for_gating_with_pending(prefs, pending.as_ref())
}

#[cfg(windows)]
pub(crate) fn current_windows_user_sid_string() -> Option<String> {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }

        let mut buffer_size: u32 = 0;
        let _ = GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut buffer_size);
        if buffer_size == 0 {
            windows_sys::Win32::Foundation::CloseHandle(token);
            return None;
        }

        let word_count = (buffer_size as usize).div_ceil(std::mem::size_of::<usize>());
        let mut buffer = vec![0_usize; word_count];
        let token_info_ok = GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr() as *mut c_void,
            buffer_size,
            &mut buffer_size,
        ) != 0;
        windows_sys::Win32::Foundation::CloseHandle(token);
        if !token_info_ok {
            return None;
        }

        let token_user =
            &*(buffer.as_ptr() as *const windows_sys::Win32::Security::TOKEN_USER);
        let mut sid_string = std::ptr::null_mut();
        if ConvertSidToStringSidW(token_user.User.Sid, &mut sid_string) == 0 {
            return None;
        }
        let mut len = 0_usize;
        while *sid_string.add(len) != 0 {
            len += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(sid_string, len));
        LocalFree(sid_string as *mut c_void);
        Some(sid)
    }
}

#[cfg(not(windows))]
pub(crate) fn current_windows_user_sid_string() -> Option<String> {
    None
}

/// When the installer records an interactive user's SID, only that user may
/// consume HKLM crash-log consent. Empty/missing SID keeps legacy machine-wide
/// hand-off (unattended installs that run elevated as SYSTEM).
pub(crate) fn crash_logs_registry_applies_to_current_user(
    installer_user_sid: Option<&str>,
) -> bool {
    match installer_user_sid {
        None | Some("") => true,
        Some(expected) => current_windows_user_sid_string()
            .is_some_and(|current| current.eq_ignore_ascii_case(expected)),
    }
}

/// Marks install consent complete on first launch when no consent UI is shown.
/// Seeds `fullTelemetryEnabled` from the installer's Crash Logs consent choice
/// (Windows only, via `read_crash_logs_consent_from_registry`); other platforms
/// and installs predating that registry key keep the default-false opt-in
/// behavior.
pub fn acknowledge_install_telemetry_consent_if_pending(app: &AppHandle) -> Result<(), String> {
    let path = prefs_path(app)?;
    let consent_newly_acknowledged = acknowledge_install_telemetry_consent_if_pending_at(
        &path,
        read_crash_logs_consent_from_registry(),
    )?;
    if consent_newly_acknowledged {
        clear_runtime_install_id_cache();
    }
    Ok(())
}

/// Path-based core logic shared by the command above and unit tests.
/// Returns `true` when this call performed the pending -> complete
/// transition (i.e. a write happened), `false` when consent was already
/// completed and nothing changed.
fn acknowledge_install_telemetry_consent_if_pending_at(
    path: &PathBuf,
    crash_logs_consent: Option<InstallerCrashLogsConsent>,
) -> Result<bool, String> {
    let (mut prefs, read_state) = read_prefs_at_detailed(path);
    if read_state == PrefsReadState::Corrupt {
        // Do not treat a damaged prefs file like a first launch (would re-seed
        // install consent and baseline opt-in defaults).
        return Ok(false);
    }
    let has_new_installer_revision = crash_logs_consent
        .as_ref()
        .and_then(|consent| consent.revision.as_deref())
        .is_some_and(|revision| {
            prefs.install_telemetry_consent_revision.as_deref() != Some(revision)
        });
    if prefs.install_telemetry_consent_completed && !has_new_installer_revision {
        return Ok(false);
    }
    prefs.install_telemetry_consent_completed = true;
    let installer_handoff = crash_logs_consent.clone();
    if let Some(consent) = crash_logs_consent {
        prefs.full_telemetry_enabled = consent.enabled;
        if let Some(baseline_enabled) = consent.baseline_enabled {
            prefs.baseline_telemetry_enabled = baseline_enabled;
        }
        if let Some(revision) = consent.revision {
            prefs.install_telemetry_consent_revision = Some(revision);
        }
    }
    match write_prefs_atomic(path, &prefs) {
        Ok(()) => {
            clear_failed_installer_consent_handoff();
            Ok(true)
        }
        Err(err) => {
            if let Some(consent) = installer_handoff {
                remember_failed_installer_consent_handoff(consent);
            }
            Err(err)
        }
    }
}

/// Reads a `REG_SZ` value from an open registry key, sizing the buffer from
/// `RegQueryValueExW` (avoids treating `ERROR_MORE_DATA` as a missing value).
#[cfg(windows)]
fn read_registry_string(
    hkey: windows_sys::Win32::System::Registry::HKEY,
    value_name: &[u16],
) -> Option<String> {
    use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{RegQueryValueExW, REG_SZ};

    unsafe {
        let mut value_type: u32 = 0;
        let mut data_size: u32 = 0;
        let probe = RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut data_size,
        );
        if probe != ERROR_SUCCESS && probe != ERROR_MORE_DATA {
            return None;
        }
        if value_type != 0 && value_type != REG_SZ {
            return None;
        }

        let wchar_capacity = (data_size as usize)
            .div_ceil(std::mem::size_of::<u16>())
            .max(1);
        let mut buffer = vec![0_u16; wchar_capacity];
        let mut data_size = (buffer.len() * std::mem::size_of::<u16>()) as u32;
        let query = RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut value_type,
            buffer.as_mut_ptr() as *mut u8,
            &mut data_size,
        );
        if query != ERROR_SUCCESS || value_type != REG_SZ {
            return None;
        }

        let length = (data_size as usize / std::mem::size_of::<u16>()).min(buffer.len());
        let value = String::from_utf16_lossy(&buffer[..length])
            .trim_end_matches('\0')
            .trim()
            .to_owned();
        Some(value)
    }
}

#[cfg(windows)]
fn optional_non_empty_registry_string(
    hkey: windows_sys::Win32::System::Registry::HKEY,
    value_name: &[u16],
) -> Option<String> {
    read_registry_string(hkey, value_name).and_then(|value| {
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    })
}

/// Reads the Crash Logs consent choice written by the MSI installer's
/// `CrashLogsConsentDlg` (see `SC_CRASH_LOGS_REGISTRY_VALUE` in `SuperClaw.aip`).
/// Returns `None` when the value is absent (dev builds, non-MSI installs, or
/// a pre-existing install predating this registry key), in which case the
/// caller keeps the default-false opt-in behavior.
#[cfg(windows)]
fn read_crash_logs_consent_from_registry() -> Option<InstallerCrashLogsConsent> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
        KEY_WOW64_64KEY, REG_DWORD,
    };

    let sub_key: Vec<u16> = "Software\\Intel\\SuperClaw\\Install\0"
        .encode_utf16()
        .collect();
    let value_name: Vec<u16> = "CrashLogsConsent\0".encode_utf16().collect();
    let baseline_value_name: Vec<u16> = "BaselineTelemetryConsent\0".encode_utf16().collect();
    let revision_name: Vec<u16> = "CrashLogsConsentRevision\0".encode_utf16().collect();
    let installer_sid_name: Vec<u16> = "CrashLogsConsentInstallerUserSid\0"
        .encode_utf16()
        .collect();

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            sub_key.as_ptr(),
            0,
            KEY_READ | KEY_WOW64_64KEY,
            &mut hkey,
        ) != ERROR_SUCCESS
        {
            return None;
        }

        let mut data: u32 = 0;
        let mut data_size: u32 = std::mem::size_of::<u32>() as u32;
        let mut value_type: u32 = 0;
        let query_result = RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut value_type,
            &mut data as *mut u32 as *mut u8,
            &mut data_size,
        );
        if query_result != ERROR_SUCCESS || value_type != REG_DWORD {
            RegCloseKey(hkey);
            return None;
        }

        let installer_user_sid =
            optional_non_empty_registry_string(hkey, &installer_sid_name);

        if !crash_logs_registry_applies_to_current_user(installer_user_sid.as_deref()) {
            RegCloseKey(hkey);
            return None;
        }

        let mut baseline_data: u32 = 0;
        let mut baseline_size: u32 = std::mem::size_of::<u32>() as u32;
        let mut baseline_type: u32 = 0;
        let baseline_query = RegQueryValueExW(
            hkey,
            baseline_value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut baseline_type,
            &mut baseline_data as *mut u32 as *mut u8,
            &mut baseline_size,
        );
        let baseline_enabled = if baseline_query == ERROR_SUCCESS && baseline_type == REG_DWORD {
            Some(baseline_data != 0)
        } else {
            None
        };

        let revision = optional_non_empty_registry_string(hkey, &revision_name);
        RegCloseKey(hkey);

        Some(InstallerCrashLogsConsent {
            enabled: data != 0,
            revision,
            baseline_enabled,
        })
    }
}

#[cfg(not(windows))]
fn read_crash_logs_consent_from_registry() -> Option<InstallerCrashLogsConsent> {
    None
}

fn install_identity_active(app: &AppHandle) -> bool {
    crate::telemetry::effective_baseline_telemetry_enabled(app)
        || crate::telemetry::effective_full_telemetry_enabled(app)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPrefs {
    #[serde(default)]
    pub keep_backend_on_exit: bool,

    /// Full telemetry consent gate. Default false (opt-in).
    #[serde(default, alias = "telemetryEnabled")]
    pub full_telemetry_enabled: bool,

    /// Baseline telemetry gate. Defaults to true after installation consent; end users can opt out in Settings.
    #[serde(default = "default_true")]
    pub baseline_telemetry_enabled: bool,

    /// Per-install telemetry consent flow completed (external + internal).
    #[serde(default)]
    pub install_telemetry_consent_completed: bool,

    /// Installer consent record last applied to this persisted preference file.
    #[serde(default)]
    pub install_telemetry_consent_revision: Option<String>,

    /// Pseudonymous install UUIDv4. `None` until baseline or full telemetry is active.
    /// Rust-managed: minted by `ensure_install_id`, never authored by the frontend.
    #[serde(default)]
    pub install_id: Option<String>,

    /// Epoch millis of the last `active_install` heartbeat (dedupe cursor).
    /// Rust-managed.
    #[serde(default)]
    pub last_heartbeat_at: Option<i64>,

    /// Committed primary Bundle ID cached after ServiceHub reports sandbox ready.
    /// Written by `cache_committed_bundle_id`; read by host telemetry at emit time.
    #[serde(default)]
    pub committed_bundle_id: Option<String>,

    /// Last non-empty product version observed from sandbox_manager
    /// `/v1/system/status`.
    ///
    /// Rust-managed: written by `cache_product_version`; frontend payloads do
    /// not author this value.
    #[serde(default)]
    pub cached_product_version: Option<String>,

    /// The bundle ID the frontend is switching to, reported before the switch
    /// commits (download/verify may still be in flight or may fail). This is a
    /// low-confidence fallback only: host telemetry prefers `committed_bundle_id`
    /// and only falls back to this value when nothing has committed yet.
    /// Written by `cache_target_bundle_id`.
    #[serde(default)]
    pub target_bundle_id: Option<String>,
}

fn default_true() -> bool {
    true
}

impl Default for AppPrefs {
    fn default() -> Self {
        Self {
            keep_backend_on_exit: false,
            full_telemetry_enabled: false,
            baseline_telemetry_enabled: true,
            install_telemetry_consent_completed: false,
            install_telemetry_consent_revision: None,
            install_id: None,
            last_heartbeat_at: None,
            committed_bundle_id: None,
            cached_product_version: None,
            target_bundle_id: None,
        }
    }
}

fn prefs_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve app config dir: {e}"))?;
    Ok(dir.join(PREFS_FILE))
}

/// Read prefs synchronously. Missing file → install defaults; corrupt file →
/// telemetry fail-closed recovery prefs (see `read_prefs_at_detailed`).
pub fn read_prefs_sync(app: &AppHandle) -> AppPrefs {
    let Ok(path) = prefs_path(app) else {
        return AppPrefs::default();
    };
    read_prefs_at(&path)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PrefsReadState {
    Missing,
    Valid,
    Corrupt,
}

/// Prefs used when the on-disk file exists but cannot be parsed. Telemetry stays
/// off until the user opts in again; install consent is not auto-completed.
fn app_prefs_fail_closed_recovery() -> AppPrefs {
    AppPrefs {
        keep_backend_on_exit: false,
        full_telemetry_enabled: false,
        baseline_telemetry_enabled: false,
        install_telemetry_consent_completed: false,
        install_telemetry_consent_revision: None,
        install_id: None,
        last_heartbeat_at: None,
        committed_bundle_id: None,
        cached_product_version: None,
        target_bundle_id: None,
    }
}

/// Path-based read used by the `AppHandle` commands and unit tests.
fn read_prefs_at_detailed(path: &PathBuf) -> (AppPrefs, PrefsReadState) {
    if !path.exists() {
        return (AppPrefs::default(), PrefsReadState::Missing);
    }
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return (app_prefs_fail_closed_recovery(), PrefsReadState::Corrupt),
    };
    match serde_json::from_str::<AppPrefs>(&content) {
        Ok(prefs) => (prefs, PrefsReadState::Valid),
        Err(_) => (app_prefs_fail_closed_recovery(), PrefsReadState::Corrupt),
    }
}

pub(crate) fn read_prefs_at(path: &PathBuf) -> AppPrefs {
    read_prefs_at_detailed(path).0
}

/// Atomic write: write to <path>.tmp then rename. Avoids torn reads if the
/// process is killed mid-write.
fn write_prefs_atomic(path: &PathBuf, prefs: &AppPrefs) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create prefs dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(prefs)
        .map_err(|e| format!("Failed to serialize prefs: {e}"))?;

    let tmp = path.with_extension("json.tmp");
    {
        let mut f =
            fs::File::create(&tmp).map_err(|e| format!("Failed to create temp prefs file: {e}"))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("Failed to write prefs: {e}"))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, path).map_err(|e| format!("Failed to rename prefs file: {e}"))?;
    Ok(())
}

// ── Path-based core logic (shared by commands and unit tests) ────────────────

/// Merge frontend-supplied prefs over the on-disk state at `path`.
/// Takes user-facing flags from `incoming`; preserves Rust-managed fields from disk.
fn user_prefs_write_clears_failed_installer_handoff(
    prior_full_telemetry: bool,
    incoming_full_telemetry: bool,
    prior_baseline_telemetry: bool,
    incoming_baseline_telemetry: bool,
) -> bool {
    prior_full_telemetry != incoming_full_telemetry
        || prior_baseline_telemetry != incoming_baseline_telemetry
}

fn merge_and_write_at(path: &PathBuf, incoming: &AppPrefs) -> Result<(), String> {
    let mut merged = read_prefs_at(path);
    let prior_full_telemetry = merged.full_telemetry_enabled;
    let prior_baseline_telemetry = merged.baseline_telemetry_enabled;
    merged.keep_backend_on_exit = incoming.keep_backend_on_exit;
    merged.full_telemetry_enabled = incoming.full_telemetry_enabled;
    merged.baseline_telemetry_enabled = incoming.baseline_telemetry_enabled;
    // Installer consent metadata / install_id / last_heartbeat_at: disk only.
    write_prefs_atomic(path, &merged)?;
    if user_prefs_write_clears_failed_installer_handoff(
        prior_full_telemetry,
        merged.full_telemetry_enabled,
        prior_baseline_telemetry,
        merged.baseline_telemetry_enabled,
    ) {
        clear_failed_installer_consent_handoff();
    }
    Ok(())
}

/// Return the existing non-empty install ID at `path`, or mint, persist, and
/// return a fresh one. Idempotent.
fn ensure_install_id_at(path: &PathBuf) -> Result<String, String> {
    let mut prefs = read_prefs_at(path);
    if let Some(existing) = prefs.install_id.as_ref() {
        if !existing.is_empty() {
            return Ok(existing.clone());
        }
    }
    let id = Uuid::new_v4().to_string();
    prefs.install_id = Some(id.clone());
    // A brand-new identity starts with a clean heartbeat cursor so its first
    // `active_install` heartbeat is not suppressed by a stale dedupe timestamp.
    prefs.last_heartbeat_at = None;
    write_prefs_atomic(path, &prefs)?;
    Ok(id)
}

/// Mint a fresh install ID at `path` unconditionally, persist, and return it.
fn reset_install_id_at(path: &PathBuf) -> Result<String, String> {
    let mut prefs = read_prefs_at(path);
    let id = Uuid::new_v4().to_string();
    prefs.install_id = Some(id.clone());
    // Reset the heartbeat dedupe cursor too: the new ID must be able to emit an
    // `active_install` heartbeat immediately rather than inheriting the old
    // identity's 24h suppression window.
    prefs.last_heartbeat_at = None;
    write_prefs_atomic(path, &prefs)?;
    Ok(id)
}

/// Ensure a pseudonymous install ID exists, minting one on first need.
fn heartbeat_due_at(path: &PathBuf, now_ms: i64) -> bool {
    let prefs = read_prefs_at(path);
    match prefs.last_heartbeat_at {
        None => true,
        Some(last_ms) => now_ms.saturating_sub(last_ms) >= HEARTBEAT_INTERVAL_MS,
    }
}

fn mark_heartbeat_emitted_at(path: &PathBuf, emitted_at_ms: i64) -> Result<(), String> {
    let mut prefs = read_prefs_at(path);
    prefs.last_heartbeat_at = Some(emitted_at_ms);
    write_prefs_atomic(path, &prefs)
}

/// Ensure a pseudonymous install ID exists, minting one on first need.
///
/// Idempotent: an existing ID is returned unchanged. Call this when either the
/// baseline telemetry (default-on) or full telemetry (opt-in) is active - i.e.
/// whenever a launch needs an ID before spawning the backend. When both are
/// off, no ID is minted.
pub fn ensure_install_id(app: &AppHandle) -> Result<String, String> {
    let path = prefs_path(app)?;
    ensure_install_id_at(&path)
}

/// Resolve this process's runtime install ID once, then reuse it.
///
/// The value is cached per process to keep host events and ServiceHub env
/// injection consistent within a launch. Cache invalidation happens when
/// consent flags change (write_app_prefs) or when reset_install_id writes a new
/// value.
pub fn resolve_runtime_install_id(app: &AppHandle) -> Result<Option<String>, String> {
    let _resolve_guard = runtime_install_id_resolve_lock()
        .lock()
        .map_err(|_| "runtime install ID resolve lock poisoned".to_string())?;

    if let Ok(cache) = runtime_install_id_cache().lock() {
        if let Some(cached) = cache.clone() {
            return Ok(cached);
        }
    }

    let resolved = if install_identity_active(app) {
        Some(ensure_install_id_at(&prefs_path(app)?)?)
    } else {
        None
    };

    if let Ok(mut cache) = runtime_install_id_cache().lock() {
        *cache = Some(resolved.clone());
    }
    Ok(resolved)
}

pub fn heartbeat_due(app: &AppHandle, now_ms: i64) -> Result<bool, String> {
    Ok(heartbeat_due_at(&prefs_path(app)?, now_ms))
}

pub fn mark_heartbeat_emitted(app: &AppHandle, emitted_at_ms: i64) -> Result<(), String> {
    mark_heartbeat_emitted_at(&prefs_path(app)?, emitted_at_ms)
}

/// Cache the committed Bundle ID obtained from ServiceHub after sandbox is ready.
/// Called once per ServiceHub boot; safe to call again on Bundle switch restart.
pub fn cache_committed_bundle_id(app: &AppHandle, bundle_id: &str) -> Result<(), String> {
    let path = prefs_path(app)?;
    let mut prefs = read_prefs_at(&path);
    let trimmed = bundle_id.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if prefs.committed_bundle_id.as_deref() == Some(trimmed) {
        return Ok(());
    }
    prefs.committed_bundle_id = Some(trimmed.to_owned());
    write_prefs_atomic(&path, &prefs)
}

/// Cache the frontend-reported switch target Bundle ID (pre-commit, may never
/// land). Overwritten on every switch attempt so a stale target cannot outlive
/// its own switch; cleared implicitly once `cache_committed_bundle_id` commits
/// the same ID.
#[tauri::command]
pub fn cache_target_bundle_id(app: AppHandle, bundle_id: String) -> Result<(), String> {
    let path = prefs_path(&app)?;
    let mut prefs = read_prefs_at(&path);
    let trimmed = bundle_id.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if prefs.target_bundle_id.as_deref() == Some(trimmed) {
        return Ok(());
    }
    prefs.target_bundle_id = Some(trimmed.to_owned());
    write_prefs_atomic(&path, &prefs)
}

/// Cache the product version obtained from sandbox_manager `/v1/system/status`.
pub fn cache_product_version(app: &AppHandle, product_version: &str) -> Result<(), String> {
    let path = prefs_path(app)?;
    let mut prefs = read_prefs_at(&path);
    let trimmed = product_version.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if prefs.cached_product_version.as_deref() == Some(trimmed) {
        return Ok(());
    }
    prefs.cached_product_version = Some(trimmed.to_owned());
    write_prefs_atomic(&path, &prefs)
}

/// Return the last cached product version when available.
pub fn read_cached_product_version(app: &AppHandle) -> Option<String> {
    read_prefs_sync(app)
        .cached_product_version
        .and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_owned())
            }
        })
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn read_app_prefs(app: AppHandle) -> Result<AppPrefs, String> {
    Ok(read_prefs_sync(&app))
}

/// Persist prefs from the frontend, merging over the on-disk state.
///
/// User-facing flags are taken from the incoming payload. Rust-managed fields
/// (`install_telemetry_consent_completed`,
/// `install_id`, `last_heartbeat_at`, bundle/version caches) are preserved from disk.
#[tauri::command]
pub fn write_app_prefs(app: AppHandle, prefs: AppPrefs) -> Result<(), String> {
    let before = read_prefs_sync(&app);
    let path = prefs_path(&app)?;
    merge_and_write_at(&path, &prefs)?;
    let after = read_prefs_sync(&app);
    if before.full_telemetry_enabled != after.full_telemetry_enabled
        || before.baseline_telemetry_enabled != after.baseline_telemetry_enabled
        || before.install_telemetry_consent_completed != after.install_telemetry_consent_completed
    {
        clear_runtime_install_id_cache();
    }
    Ok(())
}

/// Regenerate the anonymous install ID (the GDPR "reset your identifier"
/// control). Mints a fresh UUIDv4, persists it, and returns it.
#[tauri::command]
pub fn reset_install_id(app: AppHandle) -> Result<String, String> {
    let _resolve_guard = runtime_install_id_resolve_lock()
        .lock()
        .map_err(|_| "runtime install ID resolve lock poisoned".to_string())?;

    let path = prefs_path(&app)?;
    let id = reset_install_id_at(&path)?;
    if let Ok(mut cache) = runtime_install_id_cache().lock() {
        *cache = Some(Some(id.clone()));
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installer_consent(enabled: bool, revision: Option<&str>) -> InstallerCrashLogsConsent {
        installer_consent_with_baseline(enabled, revision, Some(true))
    }

    fn installer_consent_with_baseline(
        enabled: bool,
        revision: Option<&str>,
        baseline_enabled: Option<bool>,
    ) -> InstallerCrashLogsConsent {
        InstallerCrashLogsConsent {
            enabled,
            revision: revision.map(str::to_owned),
            baseline_enabled,
        }
    }

    fn unique_prefs_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "superclaw-appprefs-test-{}-{}",
            name,
            Uuid::new_v4()
        ))
    }

    #[test]
    fn dev_bootstrap_uses_existing_full_telemetry_pref_only() {
        let mut prefs = AppPrefs::default();
        assert!(!prefs.install_telemetry_consent_completed);
        assert!(!prefs.full_telemetry_enabled);
        prefs.install_telemetry_consent_completed = true;
        prefs.full_telemetry_enabled = true;
        assert!(prefs.install_telemetry_consent_completed);
        assert!(prefs.full_telemetry_enabled);
    }

    #[test]
    fn install_consent_seeds_baseline_telemetry_from_registry_choice() {
        let path = unique_prefs_path("baseline-consent-off");
        acknowledge_install_telemetry_consent_if_pending_at(
            &path,
            Some(installer_consent_with_baseline(false, Some("install-1"), Some(false))),
        )
        .unwrap();

        let after = read_prefs_at(&path);
        assert!(after.install_telemetry_consent_completed);
        assert!(
            !after.baseline_telemetry_enabled,
            "installer baseline opt-out must seed baselineTelemetryEnabled off in Settings"
        );

        fs::remove_file(&path).ok();
    }

    #[test]
    fn install_consent_seeds_full_telemetry_from_registry_choice() {
        let path = unique_prefs_path("consent-seed-on");
        let changed = acknowledge_install_telemetry_consent_if_pending_at(
            &path,
            Some(installer_consent(true, Some("install-1"))),
        )
        .unwrap();
        assert!(
            changed,
            "first call must perform the pending -> complete transition"
        );

        let after = read_prefs_at(&path);
        assert!(after.install_telemetry_consent_completed);
        assert_eq!(
            after.install_telemetry_consent_revision.as_deref(),
            Some("install-1")
        );
        assert!(
            after.full_telemetry_enabled,
            "a Crash Logs consent of true from the installer must seed full_telemetry_enabled"
        );

        fs::remove_file(&path).ok();
    }

    #[test]
    fn install_consent_without_registry_value_keeps_full_telemetry_default_off() {
        let path = unique_prefs_path("consent-seed-absent");
        acknowledge_install_telemetry_consent_if_pending_at(&path, None).unwrap();

        let after = read_prefs_at(&path);
        assert!(after.install_telemetry_consent_completed);
        assert!(
            !after.full_telemetry_enabled,
            "a missing registry value (dev builds, pre-existing installs) must not change the opt-in default"
        );

        fs::remove_file(&path).ok();
    }

    #[test]
    fn install_consent_is_idempotent_and_does_not_reapply_registry_choice_later() {
        let path = unique_prefs_path("consent-idempotent");
        acknowledge_install_telemetry_consent_if_pending_at(
            &path,
            Some(installer_consent(true, Some("install-1"))),
        )
        .unwrap();

        // Simulate the user later turning Crash Logs off via Settings — a
        // legitimate write_app_prefs round-trip, not the install-time seed.
        let mut prefs = read_prefs_at(&path);
        prefs.full_telemetry_enabled = false;
        write_prefs_atomic(&path, &prefs).unwrap();

        // A second acknowledge call (e.g. a later app launch) must not
        // reapply the registry choice and clobber the user's Settings change.
        let changed_again = acknowledge_install_telemetry_consent_if_pending_at(
            &path,
            Some(installer_consent(true, Some("install-1"))),
        )
        .unwrap();
        assert!(
            !changed_again,
            "consent is already completed; no write should happen"
        );

        let after = read_prefs_at(&path);
        assert!(
            !after.full_telemetry_enabled,
            "the user's Settings choice must survive; install-time seeding only applies once"
        );

        fs::remove_file(&path).ok();
    }

    #[test]
    fn reinstall_with_new_revision_reapplies_installer_choice_once() {
        let path = unique_prefs_path("consent-reinstall");
        acknowledge_install_telemetry_consent_if_pending_at(
            &path,
            Some(installer_consent(true, Some("install-1"))),
        )
        .unwrap();

        let changed = acknowledge_install_telemetry_consent_if_pending_at(
            &path,
            Some(installer_consent(false, Some("install-2"))),
        )
        .unwrap();
        assert!(changed, "a new installer revision must reapply consent");

        let after = read_prefs_at(&path);
        assert!(!after.full_telemetry_enabled);
        assert_eq!(
            after.install_telemetry_consent_revision.as_deref(),
            Some("install-2")
        );

        fs::remove_file(&path).ok();
    }

    /// If the installer only wrote Date+Time (minute resolution), a second install in the
    /// same minute would not re-seed crash consent — the native DLL appends a GUID per transaction.
    #[test]
    fn duplicate_minute_revision_does_not_reapply_installer_choice() {
        let path = unique_prefs_path("same-minute-dup");
        let minute_stamp = "2026-09-03 09:38";
        acknowledge_install_telemetry_consent_if_pending_at(
            &path,
            Some(installer_consent(true, Some(minute_stamp))),
        )
        .unwrap();

        let changed = acknowledge_install_telemetry_consent_if_pending_at(
            &path,
            Some(installer_consent(false, Some(minute_stamp))),
        )
        .unwrap();
        assert!(
            !changed,
            "identical revision strings must not reapply installer choice"
        );

        let after = read_prefs_at(&path);
        assert!(after.full_telemetry_enabled);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn same_minute_distinct_transaction_revisions_reapply() {
        let path = unique_prefs_path("same-minute-unique");
        let minute = "2026-09-03 09:38";
        acknowledge_install_telemetry_consent_if_pending_at(
            &path,
            Some(installer_consent(
                true,
                Some(&format!("{minute} {{A1111111-1111-1111-1111-111111111111}}")),
            )),
        )
        .unwrap();

        let changed = acknowledge_install_telemetry_consent_if_pending_at(
            &path,
            Some(installer_consent(
                false,
                Some(&format!("{minute} {{B2222222-2222-2222-2222-222222222222}}")),
            )),
        )
        .unwrap();
        assert!(
            changed,
            "distinct transaction revisions in the same minute must reapply installer choice"
        );

        let after = read_prefs_at(&path);
        assert!(!after.full_telemetry_enabled);
        assert_eq!(
            after.install_telemetry_consent_revision.as_deref(),
            Some("2026-09-03 09:38 {B2222222-2222-2222-2222-222222222222}")
        );

        fs::remove_file(&path).ok();
    }

    #[test]
    fn failed_installer_handoff_disables_full_telemetry_until_prefs_persist() {
        let pending = installer_consent(false, Some("install-2"));
        let prefs = AppPrefs {
            keep_backend_on_exit: false,
            full_telemetry_enabled: true,
            baseline_telemetry_enabled: true,
            install_telemetry_consent_completed: true,
            install_telemetry_consent_revision: Some("install-1".to_string()),
            install_id: None,
            last_heartbeat_at: None,
            committed_bundle_id: None,
            cached_product_version: None,
            target_bundle_id: None,
        };
        assert!(
            !super::resolve_full_telemetry_enabled_for_gating_with_pending(&prefs, Some(&pending)),
            "stale on-disk opt-in must not export full telemetry when installer hand-off failed to persist"
        );
    }

    #[test]
    fn failed_installer_handoff_disables_baseline_telemetry_until_prefs_persist() {
        let pending = installer_consent_with_baseline(true, Some("install-2"), Some(false));
        let prefs = AppPrefs {
            keep_backend_on_exit: false,
            full_telemetry_enabled: false,
            baseline_telemetry_enabled: true,
            install_telemetry_consent_completed: true,
            install_telemetry_consent_revision: Some("install-1".to_string()),
            install_id: None,
            last_heartbeat_at: None,
            committed_bundle_id: None,
            cached_product_version: None,
            target_bundle_id: None,
        };
        assert!(
            !super::resolve_baseline_telemetry_enabled_for_gating_with_pending(
                &prefs,
                Some(&pending),
            ),
            "stale on-disk baseline opt-in must not export when installer hand-off failed to persist"
        );
    }

    #[test]
    fn failed_installer_opt_in_handoff_does_not_force_telemetry_on() {
        let pending = installer_consent(true, Some("install-2"));
        let prefs = AppPrefs {
            keep_backend_on_exit: false,
            full_telemetry_enabled: false,
            baseline_telemetry_enabled: true,
            install_telemetry_consent_completed: true,
            install_telemetry_consent_revision: Some("install-1".to_string()),
            install_id: None,
            last_heartbeat_at: None,
            committed_bundle_id: None,
            cached_product_version: None,
            target_bundle_id: None,
        };
        assert!(
            !super::resolve_full_telemetry_enabled_for_gating_with_pending(&prefs, Some(&pending)),
            "failed persist of installer opt-in must not enable telemetry ahead of on-disk prefs"
        );
    }

    #[test]
    fn crash_logs_registry_scoped_to_installer_user_sid() {
        assert!(super::crash_logs_registry_applies_to_current_user(None));
        assert!(super::crash_logs_registry_applies_to_current_user(Some("")));
        assert!(!super::crash_logs_registry_applies_to_current_user(Some(
            "S-1-5-21-0000000000-0000000000-0000000000-9999"
        )));
        if let Some(sid) = super::current_windows_user_sid_string() {
            assert!(super::crash_logs_registry_applies_to_current_user(Some(&sid)));
        }
    }

    #[test]
    fn old_file_without_new_fields_reads_defaults() {
        // A prefs file written before the telemetry fields existed.
        let path = unique_prefs_path("legacy");
        fs::write(&path, r#"{ "keepBackendOnExit": false }"#).unwrap();

        let prefs = read_prefs_at(&path);
        assert!(!prefs.keep_backend_on_exit);
        assert!(!prefs.full_telemetry_enabled);
        assert!(prefs.baseline_telemetry_enabled);
        assert!(!prefs.install_telemetry_consent_completed);
        assert_eq!(prefs.install_id, None);
        assert_eq!(prefs.last_heartbeat_at, None);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_or_malformed_file_reads_defaults() {
        let missing = unique_prefs_path("missing");
        let prefs = read_prefs_at(&missing);
        assert!(!prefs.keep_backend_on_exit); // default false (stop backend on exit)
        assert!(!prefs.full_telemetry_enabled);
        assert!(prefs.baseline_telemetry_enabled);

        let malformed = unique_prefs_path("malformed");
        fs::write(&malformed, "not json at all {").unwrap();
        let prefs = read_prefs_at(&malformed);
        assert!(!prefs.keep_backend_on_exit);
        assert!(!prefs.baseline_telemetry_enabled);
        assert!(!prefs.install_telemetry_consent_completed);
        assert_eq!(prefs.install_id, None);
        fs::remove_file(&malformed).ok();
    }

    #[test]
    fn corrupt_prefs_do_not_reseed_install_telemetry_consent() {
        let path = unique_prefs_path("corrupt-consent");
        fs::write(&path, "{ not valid json").unwrap();
        let changed = acknowledge_install_telemetry_consent_if_pending_at(
            &path,
            Some(installer_consent(true, Some("install-1"))),
        )
        .unwrap();
        assert!(!changed);
        let prefs = read_prefs_at(&path);
        assert!(!prefs.install_telemetry_consent_completed);
        assert!(!prefs.baseline_telemetry_enabled);
        assert!(!prefs.full_telemetry_enabled);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn user_prefs_write_clears_installer_handoff_only_when_full_telemetry_changes() {
        assert!(!super::user_prefs_write_clears_failed_installer_handoff(true, true, true, true));
        assert!(!super::user_prefs_write_clears_failed_installer_handoff(false, false, true, true));
        assert!(super::user_prefs_write_clears_failed_installer_handoff(true, false, true, true));
        assert!(super::user_prefs_write_clears_failed_installer_handoff(false, true, true, true));
        assert!(super::user_prefs_write_clears_failed_installer_handoff(true, true, true, false));
        assert!(super::user_prefs_write_clears_failed_installer_handoff(true, true, false, true));
    }

    #[test]
    fn merge_updates_user_flags_without_touching_managed_fields() {
        let path = unique_prefs_path("handoff-merge");
        let seeded = AppPrefs {
            keep_backend_on_exit: false,
            full_telemetry_enabled: true,
            baseline_telemetry_enabled: true,
            install_telemetry_consent_completed: true,
            install_telemetry_consent_revision: Some("install-1".to_string()),
            install_id: None,
            last_heartbeat_at: None,
            committed_bundle_id: None,
            cached_product_version: None,
            target_bundle_id: None,
        };
        write_prefs_atomic(&path, &seeded).unwrap();

        merge_and_write_at(
            &path,
            &AppPrefs {
                keep_backend_on_exit: true,
                full_telemetry_enabled: true,
                ..AppPrefs::default()
            },
        )
        .unwrap();

        let after = read_prefs_at(&path);
        assert!(after.keep_backend_on_exit);
        assert!(after.full_telemetry_enabled);
        assert_eq!(
            after.install_telemetry_consent_revision.as_deref(),
            Some("install-1")
        );

        merge_and_write_at(
            &path,
            &AppPrefs {
                keep_backend_on_exit: true,
                full_telemetry_enabled: false,
                ..AppPrefs::default()
            },
        )
        .unwrap();

        let opted_out = read_prefs_at(&path);
        assert!(!opted_out.full_telemetry_enabled);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn merge_preserves_rust_managed_fields() {
        let path = unique_prefs_path("merge");
        // Seed disk with an install ID + heartbeat (Rust-managed state).
        let seeded = AppPrefs {
            keep_backend_on_exit: true,
            full_telemetry_enabled: true,
            baseline_telemetry_enabled: true,
            install_telemetry_consent_completed: true,
            install_telemetry_consent_revision: Some("install-1".to_string()),
            install_id: Some("seed-id-123".to_string()),
            last_heartbeat_at: Some(1_752_300_000_000),
            committed_bundle_id: None,
            cached_product_version: Some("1.2.0.811".to_string()),
            target_bundle_id: None,
        };
        write_prefs_atomic(&path, &seeded).unwrap();

        // Frontend round-trips a payload that omits (defaults) the managed fields.
        let from_frontend = AppPrefs {
            keep_backend_on_exit: false,
            full_telemetry_enabled: false,
            baseline_telemetry_enabled: false,
            install_telemetry_consent_completed: false,
            install_telemetry_consent_revision: None,
            install_id: None,        // stale/absent - must NOT clobber
            last_heartbeat_at: None, // stale/absent - must NOT clobber
            committed_bundle_id: None,
            cached_product_version: None,
            target_bundle_id: None,
        };
        merge_and_write_at(&path, &from_frontend).unwrap();

        let after = read_prefs_at(&path);
        // User-facing flags took the frontend values.
        assert!(!after.keep_backend_on_exit);
        assert!(!after.full_telemetry_enabled);
        assert!(!after.baseline_telemetry_enabled);
        assert!(after.install_telemetry_consent_completed);
        assert_eq!(
            after.install_telemetry_consent_revision.as_deref(),
            Some("install-1")
        );
        // Rust-managed fields preserved from disk.
        assert_eq!(after.install_id.as_deref(), Some("seed-id-123"));
        assert_eq!(after.last_heartbeat_at, Some(1_752_300_000_000));
        assert_eq!(after.cached_product_version.as_deref(), Some("1.2.0.811"));

        fs::remove_file(&path).ok();
    }

    #[test]
    fn ensure_install_id_is_idempotent() {
        let path = unique_prefs_path("ensure");
        let first = ensure_install_id_at(&path).unwrap();
        assert!(!first.is_empty());
        let second = ensure_install_id_at(&path).unwrap();
        assert_eq!(first, second, "existing ID must be returned unchanged");

        // Persisted and stable across reads.
        assert_eq!(
            read_prefs_at(&path).install_id.as_deref(),
            Some(first.as_str())
        );
        fs::remove_file(&path).ok();
    }

    #[test]
    fn ensure_install_id_mints_after_install_consent() {
        let path = unique_prefs_path("consented");
        let seeded = AppPrefs {
            full_telemetry_enabled: false,
            install_telemetry_consent_completed: true,
            ..AppPrefs::default()
        };
        write_prefs_atomic(&path, &seeded).unwrap();

        let id = ensure_install_id_at(&path).unwrap();
        assert!(!id.is_empty());
        let after = read_prefs_at(&path);
        assert_eq!(after.install_id.as_deref(), Some(id.as_str()));
        assert!(!after.full_telemetry_enabled);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn first_consented_run_must_be_evaluated_before_id_mint() {
        let path = unique_prefs_path("first-consented");
        let seeded = AppPrefs {
            full_telemetry_enabled: true,
            install_telemetry_consent_completed: true,
            ..AppPrefs::default()
        };
        write_prefs_atomic(&path, &seeded).unwrap();
        let before = read_prefs_at(&path);
        assert!(before.full_telemetry_enabled && before.install_id.is_none());

        ensure_install_id_at(&path).unwrap();

        let after = read_prefs_at(&path);
        assert!(after.install_id.is_some());
        assert!(
            !(after.full_telemetry_enabled && after.install_id.is_none()),
            "simulates emit_app_start after resolve_runtime_install_id — first_run gate dead"
        );
        fs::remove_file(&path).ok();
    }

    #[test]
    fn reset_install_id_changes_the_value_and_clears_heartbeat() {
        let path = unique_prefs_path("reset");
        let original = ensure_install_id_at(&path).unwrap();
        // Simulate a heartbeat having fired for the old identity.
        let mut prefs = read_prefs_at(&path);
        prefs.last_heartbeat_at = Some(1_752_300_000_000);
        write_prefs_atomic(&path, &prefs).unwrap();

        let reset = reset_install_id_at(&path).unwrap();
        assert_ne!(original, reset, "reset must mint a new ID");
        let after = read_prefs_at(&path);
        assert_eq!(after.install_id.as_deref(), Some(reset.as_str()));
        // The new identity must start with a clean heartbeat cursor.
        assert_eq!(
            after.last_heartbeat_at, None,
            "reset must clear the heartbeat dedupe cursor for the new ID"
        );
        fs::remove_file(&path).ok();
    }

    #[test]
    fn heartbeat_is_due_once_per_rolling_day() {
        let path = unique_prefs_path("heartbeat-due");
        let first_ms = 1_752_300_000_000;

        assert!(heartbeat_due_at(&path, first_ms));
        mark_heartbeat_emitted_at(&path, first_ms).unwrap();
        assert!(!heartbeat_due_at(
            &path,
            first_ms + HEARTBEAT_INTERVAL_MS - 1
        ));
        assert!(heartbeat_due_at(&path, first_ms + HEARTBEAT_INTERVAL_MS));

        fs::remove_file(&path).ok();
    }

    #[test]
    fn heartbeat_clock_rollback_does_not_emit_early() {
        let path = unique_prefs_path("heartbeat-clock-rollback");
        let first_ms = 1_752_300_000_000;
        mark_heartbeat_emitted_at(&path, first_ms).unwrap();

        assert!(!heartbeat_due_at(&path, first_ms - HEARTBEAT_INTERVAL_MS));
        assert_eq!(read_prefs_at(&path).last_heartbeat_at, Some(first_ms));

        fs::remove_file(&path).ok();
    }

    #[test]
    fn backend_is_stopped_by_default() {
        assert!(!AppPrefs::default().keep_backend_on_exit);
        assert!(
            !serde_json::from_str::<AppPrefs>("{}")
                .expect("empty preferences should use defaults")
                .keep_backend_on_exit
        );
    }
}
