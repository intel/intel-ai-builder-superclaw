//! Startup port-conflict preflight — the FIRST gate in the boot sequence.
//!
//! Runs synchronously in `lib.rs::run()`'s `setup()` **before** ServiceHub is
//! spawned. If any port the app hard-depends on is already taken, we do not
//! start a single managed service; the frontend renders a blocking dialog whose
//! only action is to exit.
//!
//! Why this cannot live in the frontend: ServiceHub is spawned from `setup()`,
//! which runs before the WebView loads. A SolidJS-side gate would fire *after*
//! the sidecar tree is already coming up. Additionally, a browser context has
//! no raw sockets, so "is this TCP port bindable" is not answerable there.
//!
//! ## Which ports are checked
//!
//! Only ports whose occupancy is a genuine *hard* startup failure — i.e. the
//! owning component fails fast instead of falling back to another port:
//!
//! | Port    | Owner              | Source of truth                     |
//! |---------|--------------------|-------------------------------------|
//! | 18321   | llmrouter_manager  | `host/servicehub/service_cfg.json`  |
//! | 18826   | privacy_manager   | `host/servicehub/service_cfg.json`  |
//! | 18821   | sandbox_manager    | `host/servicehub/service_cfg.json`  |
//! | 18103   | llama-server       | `LLAMA_ROUTER_PORT` env / default   |
//!
//! `tts_manager` (18827) is deliberately absent: it starts on demand, so
//! `parse_service_cfg` excludes it and a conflict on 18827 never gates startup.
//!
//! ## The gate's core rule
//!
//! An occupied port is classified from the same evidence ServiceHub's
//! `_ensure_fixed_ports_bindable` uses:
//!
//! | Evidence | ServiceHub | This gate |
//! |---|---|---|
//! | Holder verified as ours | reaps it and continues | allow |
//! | `netstat` clean, **nothing** listening | fails a required child with an actionable error | allow; left to ServiceHub |
//! | `netstat` failed (owner unverifiable) | `blocker` → fails | **block** |
//! | Holder is an unrelated process | `blocker` → fails | **block** |
//!
//! The middle row is the subtle one: "no listener" is *negative evidence* that no
//! live competitor exists (a lingering `TIME_WAIT` or a reserved port range),
//! which is different from "we could not find out". The gate blocks only on a
//! live or unknown holder. See [`probe::ProbeResult`] for how the two are kept
//! apart.
//!
//! Ownership itself is verified by the same two proofs ServiceHub accepts before
//! it will kill a process — see [`identity`].
//!
//! Deliberately NOT checked, because these self-heal by picking another port and
//! flagging them would be a false alarm that blocks a perfectly bootable app:
//!
//! * `3005` (`opencode_router`) — always ephemeral.
//! * `engine` / `orchestrator` ports — allocated via `bind(port 0)`.
//! * `8080` (`models.builtin.json::default_port`) — never actually bound; it is
//!   only echoed in the LRM `/system/preflight` `ports` check text.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

mod identity;
mod ports;
mod probe;

#[cfg(test)]
mod tests;

/// A port the app hard-depends on, plus the interface its owner binds.
///
/// `bind_host` matters: a listener on `0.0.0.0:P` does not block a
/// `127.0.0.1:P` bind, so probing the wrong interface silently reports a taken
/// port as free. Mirrors the reasoning in ServiceHub's
/// `process_manager._is_port_free`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequiredPort {
    pub port: u16,
    pub bind_host: String,
    /// Stable identifier surfaced to the frontend for i18n lookup.
    pub service: String,
    /// Module/entrypoint name, used for the `-m <entrypoint>` command-line check.
    pub entrypoint: String,
    /// Executable names this service may run as, for image-path and command-line
    /// matching. Mirrors `process_manager._configured_exe_names`.
    pub exe_names: Vec<String>,
    /// Role token for a service hosted in a shared multi-role bundle
    /// (`launch.kind = "role"`), i.e. the value of its `--service` flag. `None`
    /// for a service with an executable of its own. Mirrors
    /// `process_manager._launch_role`.
    pub role: Option<String>,
}

/// One occupied port, with a best-effort hint about who is holding it.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortConflict {
    pub port: u16,
    pub service: String,
    pub bind_host: String,
    /// Process image name of the holder (e.g. `python.exe`), when resolvable.
    pub owner_name: Option<String>,
    /// PID of the holder, when resolvable.
    pub owner_pid: Option<u32>,
}

/// Outcome of the startup probe, cached in Tauri state for the frontend.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortPreflightReport {
    /// Every conflicting port. Empty means the gate passed.
    pub conflicts: Vec<PortConflict>,
    /// Ports that were probed, for diagnostics.
    pub checked_ports: Vec<u16>,
}

impl PortPreflightReport {
    pub fn is_blocked(&self) -> bool {
        !self.conflicts.is_empty()
    }
}

/// Tauri-managed cache of the preflight result.
///
/// Written once from `setup()` before ServiceHub is spawned, then read by the
/// `get_port_preflight_report` command. A `Mutex<Option<..>>` (rather than
/// `OnceLock`) keeps the "not yet run" state distinguishable from "ran and
/// found nothing", which the frontend needs in order to fail open.
#[derive(Default)]
pub struct PortPreflightState {
    inner: Mutex<Option<PortPreflightReport>>,
}

impl PortPreflightState {
    pub fn set(&self, report: PortPreflightReport) {
        match self.inner.lock() {
            Ok(mut guard) => *guard = Some(report),
            Err(poisoned) => *poisoned.into_inner() = Some(report),
        }
    }

    pub fn get(&self) -> Option<PortPreflightReport> {
        match self.inner.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }
}

/// Return `true` when `bind_host:port` can be exclusively bound right now.
///
/// No `SO_REUSEADDR` — we want true exclusive bindability, matching what the
/// owning service's own bind will attempt. The listener is dropped immediately
/// so the port is released for its real owner to claim.
fn is_port_free(port: u16, bind_host: &str) -> bool {
    TcpListener::bind((bind_host, port)).is_ok()
}

/// Whether the port is held by one of SuperClaw's own leftover processes,
/// verified to the same standard ServiceHub uses before reaping such a process.
///
/// Accepts on EITHER proof (mirroring `_ensure_fixed_ports_bindable`):
///
/// * **Image path** exactly equals `<servicehub_dir>\<name>\<name>.exe`, read via
///   `QueryFullProcessImageNameW`. Strongest signal, needs no external tooling,
///   and cannot be spoofed by naming a stray binary `llama-server.exe`.
/// * **Command line** references this service AND carries a SuperClaw ownership
///   marker. Both are required, exactly as in `_is_our_orphan_cmdline`.
///
/// Returns `false` for anything unverified, including a holder whose identity
/// cannot be read. ServiceHub fails safe by declining to kill; we fail safe by
/// reporting the conflict. Neither acts on an unverified process.
///
/// `verdict` collects why the decision came out as it did, for the diagnostic log.
fn is_own_service_owner(
    entry: &RequiredPort,
    pid: u32,
    servicehub_dir: Option<&Path>,
    verdict: &mut OwnershipVerdict,
) -> bool {
    // 1. Image path — exact match against where we would have launched it.
    let image_path = identity::process_image_path(pid);
    verdict.image_path = image_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());

    // A role token only reaches the command line when ServiceHub runs as the
    // PACKAGED executable: in a source checkout it spawns `python -m <entrypoint>`
    // with no `--service`, and there the entrypoint already identifies the service
    // on its own. `servicehub_dir` alone cannot tell the two apart - it is also the
    // development source directory - so gate on the exe existing, mirroring
    // `servicehub::resolve` and ServiceHub's own `sys.frozen` check in
    // `process_manager._launch_role`. Demanding a token that is never present in a
    // source checkout would make us report our own orphan as a foreign conflict.
    let packaged = servicehub_is_packaged(servicehub_dir);
    let role = if packaged { entry.role.as_deref() } else { None };

    // A role service shares ONE image path and ONE image name with every other
    // service in its bundle, so neither image-path proof can say WHICH service
    // this is. Skip straight to the command line, where the role actually is.
    // Mirrors the same guard in `_ensure_fixed_ports_bindable`.
    if role.is_none() {
        if let (Some(path), Some(dir)) = (image_path.as_ref(), servicehub_dir) {
            for exe_name in &entry.exe_names {
                let expected = identity::expected_child_image_path(dir, exe_name);
                if identity::image_path_is_ours(&path.to_string_lossy(), &expected) {
                    verdict.matched = Some("image-path-exact");
                    return true;
                }
            }
            // A packaged child launched from an unexpected location still counts when
            // the path itself carries an ownership marker — the dev tree and
            // %LOCALAPPDATA% layouts do not match the frozen sibling pattern.
            let name_matches = entry.exe_names.iter().any(|exe| {
                path.file_name()
                    .map(|f| f.to_string_lossy().eq_ignore_ascii_case(exe))
                    .unwrap_or(false)
            });
            if name_matches && identity::has_ownership_marker(&path.to_string_lossy()) {
                verdict.matched = Some("image-path-marker");
                return true;
            }
        }
    }

    // 2. Command line — service reference AND ownership marker, both required,
    //    plus the role token for a shared multi-role bundle.
    let cmdline = probe::process_cmdline(pid);
    verdict.cmdline_readable = cmdline.is_some();
    if let Some(cmdline) = cmdline.as_deref() {
        if identity::cmdline_is_ours(cmdline, &entry.entrypoint, &entry.exe_names, role) {
            verdict.matched = Some("cmdline");
            return true;
        }
    }

    false
}

/// Whether `servicehub_dir` holds a PACKAGED ServiceHub rather than a source checkout.
///
/// `servicehub_dir` is resolved from `SERVICEHUB_DIR` or by walking up to the
/// repo, so it is equally the development source directory - its presence proves
/// nothing about how ServiceHub will run. Only the exe being there does, matching
/// `servicehub::resolve`.
pub(super) fn servicehub_is_packaged(servicehub_dir: Option<&Path>) -> bool {
    servicehub_dir
        .map(|dir| dir.join(crate::servicehub::SERVICEHUB_EXE_NAME).is_file())
        .unwrap_or(false)
}

/// Why an ownership decision came out the way it did, for the diagnostic log.
///
/// Recorded on every non-trivial path so a CI failure can be diagnosed from the
/// log alone, instead of guessing at which probe stage lost the information.
#[derive(Default)]
struct OwnershipVerdict {
    image_path: Option<String>,
    cmdline_readable: bool,
    matched: Option<&'static str>,
}

/// Probe every hard-dependency port and return the conflicts.
///
/// Never panics and never fails: a port whose requirement list cannot be read
/// falls back to the compiled-in defaults (see [`ports::required_ports`]), so a
/// missing/corrupt `service_cfg.json` degrades to "check the known ports"
/// instead of blocking startup outright.
pub fn run_preflight(servicehub_dir: Option<&Path>) -> PortPreflightReport {
    let required = ports::required_ports(servicehub_dir);
    let checked_ports = required.iter().map(|entry| entry.port).collect();

    // Bind-probe first, then resolve owners for the occupied ports only, in one
    // batched call. Probing owners per port meant one whole-machine `netstat`
    // sweep each, which on a loaded CI runner timed out for most of them.
    let occupied: Vec<&RequiredPort> = required
        .iter()
        .filter(|entry| !is_port_free(entry.port, &entry.bind_host))
        .collect();
    if occupied.is_empty() {
        return PortPreflightReport {
            conflicts: Vec::new(),
            checked_ports,
        };
    }

    let occupied_ports: Vec<u16> = occupied.iter().map(|entry| entry.port).collect();
    let probe_started = std::time::Instant::now();
    let probe = probe::port_owners(&occupied_ports);
    let probe_ms = probe_started.elapsed().as_millis();

    // Diagnostics for the whole probe, so a CI failure is explainable from the log
    // without re-running anything. `netstat_ok` distinguishes "the tool failed" from
    // "the tool ran and found no listener" — collapsing those is exactly the mistake
    // `process_manager._port_owner_pid` warns against.
    tracing::info!(
        component = "port_preflight",
        stage = "probe.summary",
        occupied = ?occupied_ports,
        resolved = ?probe.owners.keys().collect::<Vec<_>>(),
        netstat_ok = probe.netstat_ok,
        netstat_rows = probe.netstat_rows,
        elapsed_ms = probe_ms,
        "port owner probe finished"
    );

    let conflicts = occupied
        .into_iter()
        .filter_map(|entry| {
            let owner = probe.owners.get(&entry.port);

            let Some(owner) = owner else {
                // Occupied, but no LISTENING owner in the netstat snapshot. Which
                // of the two possible meanings applies is decided by `netstat_ok`
                // — collapsing them is what `_port_owner_pid` warns against.
                if probe.netstat_ok {
                    // The tool ran cleanly and found NOTHING listening. There is
                    // no live competitor: this is a lingering TIME_WAIT or a
                    // reserved port range. The gate does not block on it;
                    // ServiceHub's own fixed-port check decides.
                    tracing::info!(
                        component = "port_preflight",
                        stage = "port.no_listener",
                        port = entry.port,
                        service = %entry.service,
                        "port unbindable but nothing is listening (TIME_WAIT / reserved range); \
                         leaving it to ServiceHub"
                    );
                    return None;
                }

                // The probe itself failed, so ownership is genuinely unknown.
                // ServiceHub treats an unverifiable owner as a blocker; so do we.
                tracing::warn!(
                    component = "port_preflight",
                    stage = "port.owner_unverifiable",
                    port = entry.port,
                    service = %entry.service,
                    "port occupied and the owner probe failed; reporting as a conflict"
                );
                return Some(PortConflict {
                    port: entry.port,
                    service: entry.service.clone(),
                    bind_host: entry.bind_host.clone(),
                    owner_name: None,
                    owner_pid: None,
                });
            };

            // Verified as ours, to ServiceHub's standard → not a conflict.
            let mut verdict = OwnershipVerdict::default();
            if is_own_service_owner(entry, owner.pid, servicehub_dir, &mut verdict) {
                tracing::info!(
                    component = "port_preflight",
                    stage = "port.own_orphan",
                    port = entry.port,
                    service = %entry.service,
                    pid = owner.pid,
                    owner = owner.name.as_deref().unwrap_or("unknown"),
                    matched = verdict.matched.unwrap_or("?"),
                    image_path = verdict.image_path.as_deref().unwrap_or(""),
                    "port held by our own verified leftover process; not a conflict"
                );
                return None;
            }

            tracing::warn!(
                component = "port_preflight",
                stage = "port.foreign_holder",
                port = entry.port,
                service = %entry.service,
                pid = owner.pid,
                owner = owner.name.as_deref().unwrap_or("unknown"),
                image_path = verdict.image_path.as_deref().unwrap_or(""),
                cmdline_readable = verdict.cmdline_readable,
                "port held by a process that is not verifiably ours; reporting as a conflict"
            );

            Some(PortConflict {
                port: entry.port,
                service: entry.service.clone(),
                bind_host: entry.bind_host.clone(),
                owner_name: owner.name.clone(),
                owner_pid: Some(owner.pid),
            })
        })
        .collect();

    PortPreflightReport {
        conflicts,
        checked_ports,
    }
}

/// Locate the directory holding the `service_cfg.json` that ServiceHub will
/// actually use, so the fixed child ports are read from it instead of hardcoded.
///
/// The order below mirrors [`crate::servicehub`]'s `resolve_servicehub_launch_target`
/// **exactly**, including that `SERVICEHUB_EXE` outranks `SERVICEHUB_DIR`. This
/// matters: if both are set and the precedence here disagreed, the gate would
/// probe the ports of a payload other than the one about to be launched.
///
///   1. `SERVICEHUB_EXE` → packaged executable, `service_cfg.json` alongside it
///   2. `SERVICEHUB_DIR` → development source directory
///   3. exe-sibling `servicehub/` (installed production layout)
///   4. upward search from cwd for `host/servicehub`
///   5. upward search from `current_exe()` for `host/servicehub`
pub fn resolve_servicehub_dir() -> Option<PathBuf> {
    // 1. Explicit executable override — highest precedence, matching ServiceHub.
    if let Ok(exe) = std::env::var("SERVICEHUB_EXE") {
        if let Some(parent) = PathBuf::from(exe).parent() {
            if parent.join("service_cfg.json").is_file() {
                return Some(parent.to_path_buf());
            }
        }
    }

    // 2. Explicit development directory override.
    if let Ok(dir) = std::env::var("SERVICEHUB_DIR") {
        let path = PathBuf::from(dir);
        if path.is_dir() {
            return Some(path);
        }
    }

    // 3. Installed production layout: servicehub/ next to our own exe.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(app_dir) = exe.parent() {
            let candidate = app_dir.join("servicehub");
            if candidate.join("service_cfg.json").is_file() {
                return Some(candidate);
            }
        }
    }

    // 4/5. Repo layout: walk up from cwd, then from the executable.
    let from_cwd = std::env::current_dir()
        .ok()
        .and_then(|dir| find_repo_servicehub_dir(&dir));
    if from_cwd.is_some() {
        return from_cwd;
    }

    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .and_then(|dir| find_repo_servicehub_dir(&dir))
}

fn find_repo_servicehub_dir(start: &Path) -> Option<PathBuf> {
    start.ancestors().find_map(|dir| {
        let candidate = dir.join("host").join("servicehub");
        candidate.join("service_cfg.json").is_file().then_some(candidate)
    })
}
