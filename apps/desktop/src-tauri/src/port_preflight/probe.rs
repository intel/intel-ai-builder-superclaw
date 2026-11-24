//! Best-effort identification of the processes holding conflicting ports.
//!
//! Purely diagnostic: it makes the dialog say "18321 — held by python.exe (PID
//! 12345)" instead of just "18321". Every failure path degrades gracefully and an
//! unresolved holder never blocks startup. Nothing here kills or modifies
//! anything — that is ServiceHub's `_ensure_fixed_ports_bindable` territory, and
//! it deliberately stays there.
//!
//! ## Why one batched `netstat`, not one per port
//!
//! `netstat -ano` enumerates every connection on the machine, so it costs the
//! same whether we want one port or five. Calling it per port multiplied that
//! cost by the number of conflicts and, on a loaded CI runner, timed out for most
//! of them — reporting "unknown owner" for ports whose holder was plainly one of
//! our own services, and adding seconds of startup latency per conflicting port.
//! It now runs once, and a single `tasklist` resolves all the PIDs it found.
//!
//! Uses `netstat -ano` + `tasklist`, both of which work unelevated on Windows.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use crate::platform::command_for_program;

/// Cap each helper subprocess so a wedged system tool cannot stall the gate.
///
/// Generous on purpose: `netstat -ano` walks the whole connection table and can
/// take many seconds on a busy machine (a CI runner mid-test, for instance).
/// Because the result only *enriches* the message — an unresolved holder never
/// blocks startup — a longer wait is cheap insurance against a needlessly vague
/// dialog, and it is now paid at most twice per launch rather than once per port.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone)]
pub struct PortOwner {
    pub pid: u32,
    pub name: Option<String>,
}

/// Result of one owner-probe pass, including enough diagnostics to explain a
/// failure from the log alone.
///
/// `netstat_ok` is load-bearing, not just informational. It separates two states
/// that must never be collapsed — the exact mistake
/// `process_manager._port_owner_pid` documents:
///
/// * `netstat_ok == true` and a port absent from `owners` → the tool ran cleanly
///   and **nothing is listening**. That is positive (if negative-form) evidence:
///   there is no live competitor, which is the signature of a lingering
///   `TIME_WAIT` or a reserved port range. ServiceHub reports it as ownerless.
/// * `netstat_ok == false` → the tool could not be run or parsed, so ownership is
///   **unknown**. ServiceHub treats this as an unverifiable blocker.
#[derive(Debug, Default)]
pub struct ProbeResult {
    pub owners: HashMap<u16, PortOwner>,
    /// True when `netstat` ran to completion and its output was parsed.
    pub netstat_ok: bool,
    /// Line count of the netstat output, to spot a truncated/empty read.
    pub netstat_rows: usize,
}

/// Resolve who is LISTENING on each of `ports`, in a single pass.
///
/// Ports with no resolvable holder are simply absent from `owners`.
pub fn port_owners(ports: &[u16]) -> ProbeResult {
    let mut result = ProbeResult::default();
    if ports.is_empty() {
        return result;
    }

    let Some(stdout) = run_capture("netstat", &["-ano"]) else {
        return result;
    };
    result.netstat_ok = true;
    result.netstat_rows = stdout.lines().count();

    let pids = parse_netstat_listening_pids(&stdout, ports);
    if pids.is_empty() {
        return result;
    }

    let mut unique: Vec<u32> = pids.values().copied().collect();
    unique.sort_unstable();
    unique.dedup();
    let names = process_names(&unique);

    for (port, pid) in pids {
        result.owners.insert(
            port,
            PortOwner {
                pid,
                name: names.get(&pid).cloned(),
            },
        );
    }
    result
}

/// Map each wanted port to the PID LISTENING on it, from `netstat -ano` output.
///
/// Only `LISTENING` rows count. Both `TCP` and `TCPv6` are matched: passing
/// `-p TCP` to netstat filters out IPv6 rows, so an IPv6-only listener would be
/// missed entirely.
pub(super) fn parse_netstat_listening_pids(stdout: &str, ports: &[u16]) -> HashMap<u16, u32> {
    let suffixes: Vec<(u16, String)> =
        ports.iter().map(|port| (*port, format!(":{port}"))).collect();
    let mut found: HashMap<u16, u32> = HashMap::new();

    for line in stdout.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // Expected TCP row: proto local remote state pid
        if fields.len() < 5 {
            continue;
        }
        if !matches!(fields[0].to_ascii_uppercase().as_str(), "TCP" | "TCPV6") {
            continue;
        }

        let local = fields[1];
        let state = fields[fields.len() - 2];
        let pid_field = fields[fields.len() - 1];

        if !state.eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        // A PID of 0 is the TIME_WAIT / system placeholder, not a real owner.
        let Some(pid) = pid_field.parse::<u32>().ok().filter(|pid| *pid > 0) else {
            continue;
        };

        for (port, suffix) in &suffixes {
            if local.ends_with(suffix.as_str()) {
                found.entry(*port).or_insert(pid);
            }
        }
    }

    found
}

/// Look up the image names of `pids` with one `tasklist` call.
///
/// `tasklist` is preferred over `wmic` (deprecated and absent on newer Windows)
/// and over PowerShell (slow to spin up, and this runs on the startup path). We
/// only need image names, not command lines.
///
/// Listing everything and filtering locally beats one `/FI "PID eq N"` invocation
/// per PID: the process table is small, whereas each extra subprocess costs real
/// startup latency and another chance to hit the timeout.
fn process_names(pids: &[u32]) -> HashMap<u32, String> {
    let mut names = HashMap::new();
    if pids.is_empty() {
        return names;
    }
    let Some(stdout) = run_capture("tasklist", &["/FO", "CSV", "/NH"]) else {
        return names;
    };
    for (pid, name) in parse_tasklist_rows(&stdout) {
        if pids.contains(&pid) {
            names.insert(pid, name);
        }
    }
    names
}

/// Parse `(pid, image name)` pairs from headerless `tasklist /FO CSV` output,
/// e.g. `"python.exe","12345","Console","1","24,180 K"` → `(12345, python.exe)`.
pub(super) fn parse_tasklist_rows(stdout: &str) -> Vec<(u32, String)> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('"'))
        .filter_map(|line| {
            // Quoted CSV with no embedded quotes: splitting on '"' yields
            // ["", name, ",", pid, ...].
            let parts: Vec<&str> = line.split('"').collect();
            let name = parts.get(1)?.trim();
            let pid = parts.get(3)?.trim().parse::<u32>().ok()?;
            // `tasklist` prints "INFO: No tasks are running..." on an empty match.
            if name.is_empty() || name.starts_with("INFO:") {
                return None;
            }
            Some((pid, name.to_string()))
        })
        .collect()
}

/// Read `pid`'s full command line, or `None` if it cannot be read.
///
/// Tries `wmic` first, then PowerShell `Get-CimInstance` — `wmic` is deprecated
/// and absent on newer Windows builds. Mirrors
/// `process_manager._port_owner_cmdline`. Neither backend requires elevation.
///
/// Only consulted when the image-path check has already failed, so the cost of
/// spawning PowerShell is paid rarely.
pub fn process_cmdline(pid: u32) -> Option<String> {
    cmdline_via_wmic(pid).or_else(|| cmdline_via_powershell(pid))
}

fn cmdline_via_wmic(pid: u32) -> Option<String> {
    let stdout = run_capture(
        "wmic",
        &[
            "process",
            "where",
            &format!("processid={pid}"),
            "get",
            "commandline",
        ],
    )?;
    // wmic prints a "CommandLine" header row followed by the value row(s); join
    // the non-header lines so a wrapped command line still matches.
    let value = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.eq_ignore_ascii_case("commandline"))
        .collect::<Vec<_>>()
        .join(" ");
    (!value.is_empty()).then_some(value)
}

fn cmdline_via_powershell(pid: u32) -> Option<String> {
    let script = format!("(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine");
    let stdout = run_capture(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", &script],
    )?;
    let value = stdout.trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// Run a helper command with a hard timeout, returning its stdout on success.
///
/// ## Why stdout is drained on a separate thread
///
/// A piped stdout has a finite OS buffer (a few KB on Windows). Polling
/// `try_wait()` without reading that pipe deadlocks as soon as the child fills
/// it: the child blocks writing, so it never exits, so the poll loop never ends —
/// and the only way out is the timeout. `netstat -ano` output easily exceeds the
/// buffer on a busy machine, which is exactly how this manifested in CI: three
/// consecutive probes reported `elapsed_ms` of 20020/20020/20035, i.e. pinned to
/// the timeout rather than merely slow. Reproduced locally: polling without
/// reading gives `exited=False ms=20050`, while draining the pipe finishes the
/// same command in 58ms.
///
/// So a reader thread consumes stdout to EOF while the main thread waits on it
/// with a deadline. EOF arrives when the child closes its handle (i.e. exits), so
/// joining the reader is equivalent to waiting for the child, minus the deadlock.
fn run_capture(program: &str, args: &[&str]) -> Option<String> {
    run_capture_with_timeout(program, args, PROBE_TIMEOUT)
}

/// As [`run_capture`], with an explicit timeout.
pub(super) fn run_capture_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Option<String> {
    let mut command = command_for_program(&PathBuf::from(program));
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());

    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;

    // Drain the pipe off-thread so the child is never blocked on a full buffer.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let mut reader = stdout;
        let _ = std::io::Read::read_to_end(&mut reader, &mut buffer);
        // A closed receiver just means we timed out; nothing to do about it.
        let _ = tx.send(buffer);
    });

    let output = match rx.recv_timeout(timeout) {
        Ok(bytes) => bytes,
        Err(_) => {
            // Timed out: kill the child so the reader thread reaches EOF and can
            // exit rather than lingering for the life of the process.
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };

    // The child has closed stdout, so it has either exited or is about to.
    let status = child.wait().ok()?;
    status
        .success()
        .then(|| String::from_utf8_lossy(&output).to_string())
}
