mod backend_progress;
mod bun_env;
mod commands;
mod config;
mod elevation_preflight;
mod engine;
mod fs;
mod http_proxy;
#[cfg(windows)]
mod installer_authenticode;
#[cfg(windows)]
mod installer_relaunch;
mod installer_staging;
mod installer_update;
mod logging;
mod opencode_router;
mod openwork_server;
mod opkg;
mod orchestrator;
mod paths;
mod platform;
pub mod port_preflight;
mod servicehub;
mod telemetry;
#[cfg(test)]
mod test_process_env;
mod types;
mod updater;
mod utils;
mod workspace;

pub use types::*;

/// Run the startup port gate and return its verdict, for integration tests.
///
/// Exposed because the probe is otherwise only reachable from `setup()`, which
/// an integration test cannot drive without a full Tauri app.
pub fn port_preflight_report_for_tests() -> port_preflight::PortPreflightReport {
    port_preflight::run_preflight(port_preflight::resolve_servicehub_dir().as_deref())
}

use std::sync::atomic::{AtomicBool, Ordering};

use backend_progress::ServiceHubBootState;
use commands::app_prefs::{cache_target_bundle_id, read_app_prefs, reset_install_id, write_app_prefs};
use commands::command_files::{
    opencode_command_delete, opencode_command_list, opencode_command_write,
};
use commands::config::{read_opencode_config, write_opencode_config};
use commands::elevation_preflight::get_elevation_blocked;
use commands::engine::{
    engine_doctor, engine_info, engine_install, engine_start, engine_stop,
};
use commands::feedback::{
    collect_recent_logs, create_bug_gist, gh_available, read_log_file, superclaw_log_root,
};
use commands::feedback_ingest::{feedback_issue_repo_slug, submit_feedback};
use commands::gmail_setup::{find_gmail_client_download, remove_gmail_client_download};
use commands::local_pick::pick_local_file;
use commands::logging::ingest_ui_log;
use commands::mcp_probe::mcp_diagnostic_line;
use commands::misc::{
    app_build_info, authorize_composer_dropped_files, obsidian_is_available,
    open_in_file_explorer, open_in_obsidian, opencode_db_migrate, opencode_mcp_auth, read_env_var,
    read_local_file_bytes, read_local_file_chunk, read_local_folder_files, read_obsidian_mirror_file, read_workspace_file,
    read_workspace_file_base64, read_dropped_file, read_dropped_image, reset_opencode_cache, scan_local_folder, scan_skill_folder,
    start_mcp_oauth_listener, stop_mcp_oauth_listener, workspace_file_exists,
    validate_obsidian_vault, write_gmail_credentials_template, write_obsidian_mirror_file,
    McpOauthListenerCancel,
};
use commands::opencode_router::{
    opencodeRouter_config_set, opencodeRouter_info, opencodeRouter_start, opencodeRouter_status,
    opencodeRouter_stop,
};
use commands::openwork_server::{openwork_server_info, openwork_server_restart};
use commands::opkg::{import_skill, opkg_install};
use commands::orchestrator::{orchestrator_instance_dispose, orchestrator_workspace_activate};
use commands::port_preflight::get_port_preflight_report;
use commands::scheduler::{scheduler_delete_job, scheduler_list_jobs};
use commands::voice_dictionary::write_voice_dictionary_export;
use commands::mask_registries::mask_registries_list;
use commands::sensitive_files::{sensitive_files_delete, sensitive_files_import, sensitive_files_list};
use commands::workspace_file_size::workspace_file_size;
use commands::servicehub::{
    get_backend_system_status, get_debug_build_commit, get_servicehub_boot_snapshot, get_servicehub_status,
    get_workspace_cleanup_policy,  get_workspace_cleanup_status, preview_workspace_cleanup, retry_servicehub_boot,
    run_workspace_cleanup_now, get_workspace_cleanup_settings, set_workspace_cleanup_settings,
    start_servicehub, stop_servicehub,
};
use commands::skills::{
    install_skill_template, list_local_skills, read_local_skill, read_skill_from_path,
    uninstall_skill, write_local_skill,
};
use commands::updater::{
    check_app_update, download_app_update, get_app_update_progress, get_product_version,
    install_app_update, updater_environment,
};
use commands::window::{
    allow_browser_foreground, set_window_decorations, set_window_min_size, set_window_size,
};
use commands::workspace::{
    workspace_add_authorized_root, workspace_bootstrap, workspace_create, workspace_create_remote,
    workspace_export_config, workspace_forget, workspace_import_config, workspace_openwork_read,
    workspace_openwork_write, workspace_set_active, workspace_update_display_name,
    workspace_update_remote,
};
use engine::manager::EngineManager;
use opencode_router::manager::OpenCodeRouterManager;
use openwork_server::manager::OpenworkServerManager;
use orchestrator::manager::OrchestratorManager;
use port_preflight::PortPreflightState;
use servicehub::manager::ServiceHubManager;
use tauri::Manager;
use telemetry::emit_telemetry;
use workspace::watch::WorkspaceWatchState;

#[cfg(target_os = "macos")]
fn set_dev_app_name() {
    if std::env::var("OPENWORK_DEV_MODE").ok().as_deref() != Some("1") {
        return;
    }

    let Some(_mtm) = objc2::MainThreadMarker::new() else {
        return;
    };

    objc2_foundation::NSProcessInfo::processInfo()
        .setProcessName(&objc2_foundation::NSString::from_str("OpenWork - Dev"));
}

#[cfg(not(target_os = "macos"))]
fn set_dev_app_name() {}

/// Re-entrancy guard: `stop_managed_services` can fire from both
/// `CloseRequested` and `ExitRequested`/`Exit` events.  Run exactly once.
static SERVICES_STOPPED: AtomicBool = AtomicBool::new(false);

/// Windows console control handler.
///
/// `pnpm dev` runs the app under a console (`tauri dev`). When the developer
/// presses **Ctrl+C**, or the Vite/Cargo watcher kills the process on a
/// hot-restart, or the console window is closed, Windows delivers a console
/// control event **instead of** a Tauri window/run event — so the normal
/// `RunEvent::CloseRequested | ExitRequested | Exit` cleanup path
/// (`stop_managed_services`) never runs, orphaning the ServiceHub child tree
/// (Python + llama-server) on their fixed ports.
///
/// Installing a `SetConsoleCtrlHandler` lets us run the same cleanup on those
/// events. It shares the `SERVICES_STOPPED` guard with the Tauri path, so
/// whichever fires first wins and the other is a no-op.
///
/// Notes / limits (Windows-specific):
/// * The handler runs on a **separate OS thread** the OS spawns for it. Unlike
///   Unix signal handlers there is no async-signal-safety constraint, so locks,
///   HTTP, and spawning subprocesses are legal here (subject only to the
///   close/shutdown time limit below).
/// * **Ctrl+C / Ctrl+Break**: returning TRUE *cancels* the OS's default process
///   termination, so the handler explicitly requests exit via `app.exit(0)` and
///   lets Tauri's main loop run the (heavy) cleanup with no time limit.
/// * **Close / logoff / shutdown**: Windows force-terminates the process the
///   moment the handler returns, or after a ~5s hard limit. There is no main-
///   loop turn left, so cleanup runs synchronously in the handler. If it is
///   force-killed mid-cleanup, the *next* launch self-heals (stale-REUSE
///   recovery + fixed-port orphan reaping), so this path is best-effort.
/// * Shares the `SERVICES_STOPPED` guard with the Tauri RunEvent path, so
///   whichever fires first wins and the other is a no-op.
#[cfg(windows)]
mod console_ctrl {
    use std::sync::OnceLock;

    // Win32 constants (avoids a dependency; these are ABI-stable).
    const CTRL_C_EVENT: u32 = 0;
    const CTRL_BREAK_EVENT: u32 = 1;
    const CTRL_CLOSE_EVENT: u32 = 2;
    const CTRL_LOGOFF_EVENT: u32 = 5;
    const CTRL_SHUTDOWN_EVENT: u32 = 6;

    // BOOL is i32; TRUE = 1 means "handled".
    extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }

    /// The app handle the C callback needs; set once during setup.
    static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

    unsafe extern "system" fn handler(ctrl_type: u32) -> i32 {
        match ctrl_type {
            // Ctrl+C / Ctrl+Break: returning TRUE *cancels* the OS's default
            // process termination outright, so we must trigger the exit
            // ourselves. Delegate to Tauri's normal teardown via `app.exit(0)`
            // (safe to call from this OS-spawned handler thread): the main event
            // loop then runs `stop_managed_services` through
            // `RunEvent::ExitRequested`/`Exit` with NO time limit, so the heavy
            // HTTP/kill work happens on the main loop, not here.
            CTRL_C_EVENT | CTRL_BREAK_EVENT => {
                eprintln!("[shutdown] console Ctrl+C/Break — requesting app exit");
                if let Some(app) = APP_HANDLE.get() {
                    app.exit(0);
                }
                1 // handled; do NOT let the default terminator run
            }
            // Console close / logoff / shutdown: Windows terminates the process
            // the moment this handler returns (or after a ~5s hard limit,
            // whichever comes first). There is no main-loop turn left to rely on,
            // so we MUST run cleanup synchronously here to buy what time the OS
            // allows. If we exceed ~5s and get force-killed mid-cleanup, the
            // next launch self-heals (stale-REUSE recovery + fixed-port orphan
            // reaping), so this is best-effort.
            CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT => {
                eprintln!("[shutdown] console close/logoff/shutdown — cleaning up synchronously");
                if let Some(app) = APP_HANDLE.get() {
                    super::stop_managed_services(app);
                }
                1 // handled (the OS still terminates us right after we return)
            }
            _ => 0, // not handled; let the default handler run
        }
    }

    /// Install the console control handler. Idempotent-safe to call once.
    pub fn install(app_handle: tauri::AppHandle) {
        // Ignore a second call: the first stored handle is the one we use.
        let _ = APP_HANDLE.set(app_handle);
        // SAFETY: `handler` is a valid `extern "system"` fn; passing add=TRUE
        // registers it. The call has no other invariants.
        let ok = unsafe { SetConsoleCtrlHandler(Some(handler), 1) };
        if ok == 0 {
            eprintln!("[shutdown] SetConsoleCtrlHandler failed; Ctrl+C cleanup unavailable");
        }
    }
}

fn stop_managed_services(app_handle: &tauri::AppHandle) {
    if SERVICES_STOPPED.swap(true, Ordering::SeqCst) {
        // Expected: Tauri fires CloseRequested, ExitRequested, and Exit
        // sequentially — only the first call does real work.
        return;
    }

    // ── User preference: keep all backend services running across app exits ──
    // When `keepBackendOnExit` is true the user has opted into a faster cold
    // start: we leave the active backend supervisor alive. In ServiceHub mode
    // that means ServiceHub plus its fixed-port children (LRM, SandboxManager,
    // Security/FileGuard); in legacy mode that means backend-manager and its
    // llama-server children. Next launch hits the
    // supervisor singleton lockfile, prints "REUSE {port,token}", and reconnects.
    let prefs = commands::app_prefs::read_prefs_sync(app_handle);
    if prefs.keep_backend_on_exit {
        eprintln!(
            "[shutdown] keepBackendOnExit=true — leaving backend supervisor and children alive for next launch"
        );
        return;
    }

    // ── Graceful HTTP shutdown of ServiceHub ──
    let servicehub_shutdown = app_handle
        .state::<ServiceHubManager>()
        .inner
        .lock()
        .ok()
        .and_then(|sh_state| {
            let port = sh_state.hub_port?;
            let token = sh_state.hub_token.clone()?;
            Some((port, token))
        });
    if let Some((port, token)) = servicehub_shutdown {
        eprintln!(
            "[shutdown] Starting graceful shutdown of ServiceHub (port {})",
            port
        );
        servicehub::graceful_shutdown_sync(port, &token);
    }

    // ── Kill all managed child processes ──
    if let Ok(mut sh) = app_handle.state::<ServiceHubManager>().inner.lock() {
        ServiceHubManager::stop_locked(&mut sh);
    }
    if let Ok(mut engine) = app_handle.state::<EngineManager>().inner.lock() {
        EngineManager::stop_locked(&mut engine);
    }
    if let Ok(mut orchestrator) = app_handle.state::<OrchestratorManager>().inner.lock() {
        OrchestratorManager::stop_locked(&mut orchestrator);
    }
    if let Ok(mut openwork_server) = app_handle.state::<OpenworkServerManager>().inner.lock() {
        OpenworkServerManager::stop_locked(&mut openwork_server);
    }
    if let Ok(mut opencode_router) = app_handle.state::<OpenCodeRouterManager>().inner.lock() {
        OpenCodeRouterManager::stop_locked(&mut opencode_router);
    }
}

/// Loopback hosts that must never be routed through an HTTP proxy: every
/// SuperClaw service (ServiceHub, LRM, sandbox, opencode-router) is reached over
/// 127.0.0.1 on the host.
const LOOPBACK_NO_PROXY_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// Pure core of [`ensure_loopback_no_proxy`]: given the current `NO_PROXY`
/// value, return `Some((merged, added))` when one or more loopback hosts are
/// missing, or `None` when nothing needs to change. Split out so the merge rule
/// is unit-testable without mutating process-global env state.
fn merge_loopback_no_proxy(existing: &str) -> Option<(String, Vec<&'static str>)> {
    let mut entries: Vec<String> = existing
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect();

    let mut added = Vec::new();
    for host in LOOPBACK_NO_PROXY_HOSTS {
        let already = entries.iter().any(|entry| entry.eq_ignore_ascii_case(host));
        if !already {
            entries.push(host.to_string());
            added.push(host);
        }
    }

    if added.is_empty() {
        None
    } else {
        Some((entries.join(","), added))
    }
}

/// Ensure the app process's own `NO_PROXY` exempts loopback, merging into (not
/// clobbering) whatever the machine already has.
///
/// On a corporate machine `HTTP_PROXY` points at a DMZ proxy. The Tauri HTTP
/// plugin issues its requests through `reqwest`, whose system matcher honors
/// `HTTP_PROXY` from the environment - so loopback calls to our own sidecars get
/// routed through the proxy and 403'd unless `NO_PROXY` lists the loopback hosts
/// *literally* (a CIDR like `127.0.0.0/8` is honored by reqwest but users often
/// only have the CIDR form, and other machines may lack it entirely). Rather
/// than depend on each machine's `NO_PROXY` shape, we bake the loopback hosts
/// into this process's env before any HTTP client is built. This runs before
/// `tauri_plugin_http::init()` and before any child sidecar is spawned, so both
/// the WebView's `tauriFetch` calls and any inherited child env pick it up.
///
/// `HTTP_PROXY` itself is left untouched, so genuinely external fetches (update
/// manifest, provider key probes, shared-bundle imports) still use the proxy.
fn ensure_loopback_no_proxy() {
    // Match reqwest/hyper-util precedence: uppercase `NO_PROXY` first, then the
    // lowercase form, so we merge into whichever the machine actually set.
    let existing = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();

    let Some((merged, added)) = merge_loopback_no_proxy(&existing) else {
        return;
    };

    // Set the canonical uppercase name (read first by reqwest); on Windows env
    // names are case-insensitive so this also satisfies a lowercase lookup.
    std::env::set_var("NO_PROXY", &merged);
    tracing::info!(
        component = "tauri",
        stage = "proxy.no_proxy.loopback",
        added = ?added,
        "ensured loopback hosts bypass any HTTP proxy (NO_PROXY merged)"
    );
}

/// Bring the running instance's windows forward when a second launch is
/// rejected by the single-instance lock.
///
/// `set_focus()` alone only raises a window that is already visible, so
/// `unminimize()` and `show()` cover the minimized and hidden cases. Iterating
/// `webview_windows()` avoids depending on the `"main"` label.
#[cfg(desktop)]
fn focus_existing_windows(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        let _ = window.unminimize();
        let _ = window.show();
        if let Err(e) = window.set_focus() {
            tracing::warn!(
                component = "tauri",
                stage = "single_instance.focus",
                window = %label,
                error = %e,
                "failed to focus existing window on second launch"
            );
        }
    }
}

pub fn run() {
    // Initialize unified startup logging first so every subsequent line carries
    // the launch boot_id and lands in %LOCALAPPDATA%\SuperClaw\app\tauri_<ts>.log
    // (installed builds have no console). See docs/design/2026-07-21_startup_logging_unification_design.md.
    logging::init();
    let boot_id = logging::boot_id().to_string();

    // Exempt loopback from any corporate HTTP proxy before the HTTP plugin or
    // any sidecar is created, so reqwest/tauriFetch calls to our own 127.0.0.1
    // services never get proxied (and 403'd). See ensure_loopback_no_proxy.
    ensure_loopback_no_proxy();

    // Seed the v1.2 cutover before any sidecar is spawned. Debug and Release
    // use the same Capability/Profile-managed model and Sandbox startup path.
    // The legacy path is incompatible with the Profile Snapshot contract.
    std::env::set_var("CAPABILITY_GATING_V1", "1");

    tracing::info!(
        boot_id = %boot_id,
        component = "tauri",
        stage = "app.setup.start",
        "SuperClaw run() starting"
    );

    let builder = tauri::Builder::default();

    // Must be registered before every other plugin: it decides whether this
    // process owns the app or is a duplicate, and a duplicate must be turned
    // away before anything else starts doing work. A second process would
    // otherwise attach to the first one's ServiceHub via the REUSE handshake
    // and then tear it down on close, stranding the original GUI.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        tracing::info!(
            component = "tauri",
            stage = "single_instance.second_launch",
            "second launch rejected; focusing the running instance"
        );
        focus_existing_windows(app);
    }));

    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init());

    let app = builder
        .setup(|app| {
            set_dev_app_name();
            if let Err(err) =
                commands::app_prefs::acknowledge_install_telemetry_consent_if_pending(app.handle())
            {
                tracing::warn!(
                    component = "tauri",
                    stage = "app_prefs.acknowledge_install_consent",
                    error = %err,
                    "failed to persist install telemetry consent flag"
                );
            }
            telemetry::apply_packaged_observability_env();
            telemetry::install_panic_hook(app.handle().clone());
            telemetry::emit_app_start(app.handle().clone());
            tracing::info!(
                boot_id = %logging::boot_id(),
                component = "tauri",
                stage = "plugins.init",
                "plugins initialized; entering setup"
            );

            // Install the Windows console-control handler so Ctrl+C / console
            // close / watcher-restart under `pnpm dev` runs the same managed-
            // service cleanup as a normal window close, preventing orphaned
            // ServiceHub/child processes on their fixed ports.
            #[cfg(windows)]
            console_ctrl::install(app.handle().clone());

            // An elevated release launch would create the backend roots owned by Administrators,
            // which the isolation broker refuses (#3176). Start nothing; the frontend shows an exit-only dialog.
            let elevation_blocked = elevation_preflight::blocked();
            if elevation_blocked {
                tracing::error!(
                    boot_id = %logging::boot_id(),
                    component = "tauri",
                    stage = "elevation_preflight.blocked",
                    "startup blocked: running with an elevated token; no service will be started"
                );
            }

            // ── STARTUP GATE 0: port-conflict preflight ────────────────────
            // This MUST run, synchronously, before any managed service is
            // spawned. If a port the app hard-depends on is already taken, we
            // start nothing at all and let the frontend render a blocking
            // exit-only dialog. Running it here (rather than in the frontend)
            // is what makes the gate actually authoritative: ServiceHub is
            // spawned below, before the WebView has even loaded, so a
            // SolidJS-side check could only ever react after the fact.
            let port_report =
                port_preflight::run_preflight(port_preflight::resolve_servicehub_dir().as_deref());
            let ports_blocked = port_report.is_blocked();
            if ports_blocked {
                let conflicts: Vec<String> = port_report
                    .conflicts
                    .iter()
                    .map(|conflict| {
                        let owner = match (&conflict.owner_name, conflict.owner_pid) {
                            (Some(name), Some(pid)) => format!("{name} PID {pid}"),
                            (None, Some(pid)) => format!("PID {pid}"),
                            _ => "unknown owner".to_string(),
                        };
                        format!("{} ({}, {owner})", conflict.port, conflict.service)
                    })
                    .collect();
                tracing::error!(
                    boot_id = %logging::boot_id(),
                    component = "tauri",
                    stage = "port_preflight.blocked",
                    conflicts = %conflicts.join(", "),
                    "startup blocked: required ports are in use; no service will be started"
                );
            } else {
                tracing::info!(
                    boot_id = %logging::boot_id(),
                    component = "tauri",
                    stage = "port_preflight.passed",
                    checked = ?port_report.checked_ports,
                    "all required ports are free"
                );
            }
            app.state::<PortPreflightState>().set(port_report);

            // ServiceHub is the sole control-plane sidecar. (Legacy backend-manager
            // fallback removed 2026-07-04 — see docs/superpowers/plans/2026-07-04-retire-backend-manager.md)
            //
            // Skipped entirely when the port gate failed: starting the Hub would
            // just reproduce the same conflict deeper in the stack (its own
            // `_ensure_fixed_ports_bindable` would abort), and the user has no
            // action available other than exiting.
            if !ports_blocked && !elevation_blocked {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    tracing::info!(
                        boot_id = %logging::boot_id(),
                        component = "tauri",
                        stage = "servicehub.spawn.start",
                        "auto-starting ServiceHub"
                    );
                    let manager = app_handle.state::<ServiceHubManager>();
                    if let Err(e) = servicehub::start_servicehub(&app_handle, &manager) {
                        // `start_servicehub` already records and emits this failure.
                        tracing::error!(
                            boot_id = %logging::boot_id(),
                            component = "tauri",
                            stage = "servicehub.spawn.failed",
                            error = %e,
                            "ServiceHub auto-start failed"
                        );
                    }
                });
            }

            // Right Alt is the dictation hotkey. Windows otherwise keeps the
            // first press as a menu key, so the page never sees the release.
            #[cfg(windows)]
            for (label, window) in app.webview_windows() {
                tracing::info!(
                    component = "tauri",
                    stage = "webview.accelerator_keys",
                    window = %label,
                    "replaying Right Alt so the dictation hotkey sees the release"
                );
                platform::release_alt_key(&window);
            }

            tracing::info!(
                boot_id = %logging::boot_id(),
                component = "tauri",
                stage = "tauri.setup.complete",
                "tauri setup complete"
            );
            Ok(())
        })
        .manage(ServiceHubManager::default())
        .manage(ServiceHubBootState::default())
        .manage(PortPreflightState::default())
        .manage(EngineManager::default())
        .manage(OrchestratorManager::default())
        .manage(OpenworkServerManager::default())
        .manage(OpenCodeRouterManager::default())
        .manage(WorkspaceWatchState::default())
        .manage(McpOauthListenerCancel::default())
        .invoke_handler(tauri::generate_handler![
            get_backend_system_status,
            get_debug_build_commit,
            run_workspace_cleanup_now,
            preview_workspace_cleanup,
            get_workspace_cleanup_settings,
            set_workspace_cleanup_settings,
            get_workspace_cleanup_status,
            get_workspace_cleanup_policy,
            engine_start,
            engine_stop,
            engine_info,
            engine_doctor,
            engine_install,
            mcp_diagnostic_line,
            orchestrator_workspace_activate,
            orchestrator_instance_dispose,
            openwork_server_info,
            openwork_server_restart,
            opencodeRouter_info,
            opencodeRouter_start,
            opencodeRouter_stop,
            opencodeRouter_status,
            opencodeRouter_config_set,
            workspace_bootstrap,
            workspace_set_active,
            workspace_create,
            workspace_create_remote,
            workspace_update_display_name,
            workspace_update_remote,
            workspace_forget,
            workspace_add_authorized_root,
            workspace_export_config,
            workspace_import_config,
            opencode_command_list,
            opencode_command_write,
            opencode_command_delete,
            workspace_openwork_read,
            workspace_openwork_write,
            opkg_install,
            import_skill,
            install_skill_template,
            list_local_skills,
            read_local_skill,
            read_skill_from_path,
            uninstall_skill,
            write_local_skill,
            read_opencode_config,
            write_opencode_config,
            updater_environment,
            check_app_update,
            download_app_update,
            install_app_update,
            get_app_update_progress,
            get_product_version,
            app_build_info,
            obsidian_is_available,
            validate_obsidian_vault,
            open_in_obsidian,
            open_in_file_explorer,
            write_gmail_credentials_template,
            find_gmail_client_download,
            remove_gmail_client_download,
            write_voice_dictionary_export,
            write_obsidian_mirror_file,
            read_obsidian_mirror_file,
            read_local_file_bytes,
            read_local_file_chunk,
            read_local_folder_files,
            authorize_composer_dropped_files,
            read_dropped_file,
            read_dropped_image,
            pick_local_file,
            scan_local_folder,
            scan_skill_folder,
            read_workspace_file,
            read_workspace_file_base64,
            workspace_file_exists,
            workspace_file_size,
            reset_opencode_cache,
            opencode_db_migrate,
            opencode_mcp_auth,
            start_mcp_oauth_listener,
            stop_mcp_oauth_listener,
            read_env_var,
            scheduler_list_jobs,
            scheduler_delete_job,
            allow_browser_foreground,
            set_window_decorations,
            set_window_min_size,
            set_window_size,
            read_app_prefs,
            write_app_prefs,
            reset_install_id,
            cache_target_bundle_id,
            emit_telemetry,
            submit_feedback,
            feedback_issue_repo_slug,
            start_servicehub,
            retry_servicehub_boot,
            get_servicehub_status,
            stop_servicehub,
            get_servicehub_boot_snapshot,
            get_port_preflight_report,
            get_elevation_blocked,
            ingest_ui_log,
            sensitive_files_list,
            sensitive_files_import,
            sensitive_files_delete,
            mask_registries_list,
            collect_recent_logs,
            gh_available,
            create_bug_gist,
            superclaw_log_root,
            read_log_file
        ])
        .on_window_event(|_window, event| {
            // Grant one-time reads only for paths supplied by native drop events.
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) =
                event
            {
                commands::misc::record_dropped_files(paths);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building OpenWork");

    // Best-effort cleanup on app exit. Without this, background sidecars can keep
    // running after the UI quits (especially during dev), leading to multiple
    // orchestrator/opencode/openwork-server processes and stale ports.
    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            stop_managed_services(&app_handle);
        }
        tauri::RunEvent::Exit => {
            stop_managed_services(&app_handle);
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } => {
            if let Some(window) = app_handle.get_webview_window(&label) {
                let _ = window.hide();
            }
            stop_managed_services(&app_handle);
        }
        _ => {}
    });
}

#[cfg(test)]
mod no_proxy_tests {
    use super::merge_loopback_no_proxy;

    #[test]
    fn adds_all_loopback_hosts_to_empty_no_proxy() {
        let (merged, added) =
            merge_loopback_no_proxy("").expect("empty NO_PROXY must be augmented");
        assert_eq!(merged, "localhost,127.0.0.1,::1");
        assert_eq!(added, vec!["localhost", "127.0.0.1", "::1"]);
    }

    #[test]
    fn merges_into_existing_corporate_entries_without_clobbering() {
        // The real Intel machine value after the user removed the loopback hosts.
        let (merged, added) =
            merge_loopback_no_proxy("intel.com,.intel.com").expect("loopback hosts are missing");
        assert_eq!(merged, "intel.com,.intel.com,localhost,127.0.0.1,::1");
        assert_eq!(added, vec!["localhost", "127.0.0.1", "::1"]);
    }

    #[test]
    fn is_a_noop_when_all_loopback_hosts_present() {
        // Nothing to add -> None, so ensure_loopback_no_proxy leaves env untouched.
        assert!(merge_loopback_no_proxy("localhost,127.0.0.1,::1,intel.com").is_none());
    }

    #[test]
    fn treats_existing_hosts_case_insensitively_and_only_adds_the_gap() {
        // LOCALHOST already covers localhost; only 127.0.0.1 and ::1 are added.
        let (merged, added) =
            merge_loopback_no_proxy("LOCALHOST").expect("two loopback hosts still missing");
        assert_eq!(merged, "LOCALHOST,127.0.0.1,::1");
        assert_eq!(added, vec!["127.0.0.1", "::1"]);
    }

    #[test]
    fn ignores_whitespace_and_empty_segments() {
        let (merged, added) = merge_loopback_no_proxy(" intel.com , , 127.0.0.1 ")
            .expect("localhost and ::1 missing");
        assert_eq!(merged, "intel.com,127.0.0.1,localhost,::1");
        assert_eq!(added, vec!["localhost", "::1"]);
    }
}
