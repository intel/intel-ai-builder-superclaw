//! Unit tests for the startup port-conflict gate.
//!
//! Parsing and port-set resolution are covered directly. Live bind probing is
//! exercised via a real ephemeral listener so the "occupied" path is tested
//! without depending on any of the app's own services being up.

use std::net::TcpListener;

use super::*;

// ── service_cfg.json parsing ───────────────────────────────────────────────

const SERVICE_CFG: &str = r#"{
  "services": [
    { "name": "llmrouter_manager", "port": 18321, "bind_host": "127.0.0.1" },
    { "name": "privacy_manager",  "port": 18826, "bind_host": "127.0.0.1" },
    { "name": "sandbox_manager",   "port": 18821, "bind_host": "127.0.0.1" }
  ]
}"#;

#[test]
fn parses_ports_and_bind_hosts_from_service_cfg() {
    let parsed = ports::parse_service_cfg(SERVICE_CFG).expect("valid cfg must parse");

    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0].port, 18321);
    assert_eq!(parsed[0].bind_host, "127.0.0.1");
    assert_eq!(parsed[0].service, "llmrouter_manager");
    // sandbox_manager binds loopback only — probing 0.0.0.0 would misreport it.
    assert_eq!(parsed[2].port, 18821);
    assert_eq!(parsed[2].bind_host, "127.0.0.1");
}

#[test]
fn service_cfg_bind_host_defaults_to_loopback_when_absent() {
    let raw = r#"{ "services": [ { "name": "svc", "port": 12345 } ] }"#;
    let parsed = ports::parse_service_cfg(raw).expect("must parse");
    assert_eq!(parsed[0].bind_host, "127.0.0.1");
}

#[test]
fn malformed_service_cfg_yields_none_rather_than_panicking() {
    assert!(ports::parse_service_cfg("not json").is_none());
    assert!(ports::parse_service_cfg(r#"{"no_services": []}"#).is_none());
}

#[test]
fn service_cfg_with_a_utf8_bom_still_parses() {
    // Regression: the shipped service_cfg.json carried a BOM, `serde_json` rejects
    // one, and the only symptom was a single WARN before the gate silently fell back
    // to the compiled-in port list — so the config stopped being the source of truth
    // while the app looked healthy. ServiceHub's own loader reads this same file with
    // `encoding="utf-8-sig"`, so the two readers have to agree.
    let raw = format!("\u{feff}{SERVICE_CFG}");
    let parsed = ports::parse_service_cfg(&raw).expect("a BOM must not defeat the parse");
    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0].port, 18321);
}

#[test]
fn on_demand_services_are_excluded_from_the_startup_gate() {
    // An on-demand child (e.g. tts_manager on 18827) is not started during boot
    // and must never gate app startup, so its port is not preflighted. The
    // two required services around it still are.
    let raw = r#"{
      "services": [
        { "name": "privacy_manager", "port": 18826, "bind_host": "0.0.0.0" },
        { "name": "tts_manager", "port": 18827, "bind_host": "127.0.0.1", "startup": "on_demand" },
        { "name": "sandbox_manager", "port": 18821, "bind_host": "127.0.0.1" }
      ]
    }"#;
    let parsed = ports::parse_service_cfg(raw).expect("valid cfg must parse");

    assert_eq!(parsed.len(), 2, "the on-demand service must be dropped");
    assert!(
        parsed.iter().all(|p| p.service != "tts_manager"),
        "tts_manager (on-demand) must not be in the preflight set"
    );
    assert!(parsed.iter().any(|p| p.port == 18826));
    assert!(parsed.iter().any(|p| p.port == 18821));
    assert!(
        !parsed.iter().any(|p| p.port == 18827),
        "port 18827 must never be gated"
    );
}

#[test]
fn the_shipped_service_cfg_gates_required_ports_only() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../host/servicehub/service_cfg.json");
    let raw = std::fs::read_to_string(&path).expect("read the shipped service_cfg.json");
    let gated: Vec<u16> = ports::parse_service_cfg(&raw)
        .expect("the shipped service_cfg.json must parse")
        .iter()
        .map(|p| p.port)
        .collect();

    for required in [18321u16, 18826, 18821] {
        assert!(gated.contains(&required), "required port {required} must be gated");
    }
    for on_demand in [18827u16, 18829, 18831] {
        assert!(
            !gated.contains(&on_demand),
            "on-demand port {on_demand} must never gate startup"
        );
    }
}

#[test]
fn startup_required_is_treated_as_required() {
    // Explicit required startup (and the default when absent) keeps the port in
    // the gate.
    let raw =
        r#"{ "services": [ { "name": "svc", "port": 12345, "startup": "required" } ] }"#;
    let parsed = ports::parse_service_cfg(raw).expect("must parse");
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].port, 12345);
}

#[test]
fn deduplicates_non_adjacent_duplicate_ports() {
    // Regression: `Vec::dedup_by` only removes ADJACENT duplicates, so a config
    // repeating a (port, bind_host) pair with another entry in between would make
    // the dialog list the same port twice.
    let raw = r#"{
      "services": [
        { "name": "a", "port": 18321, "bind_host": "0.0.0.0" },
        { "name": "b", "port": 18826, "bind_host": "0.0.0.0" },
        { "name": "c", "port": 18321, "bind_host": "0.0.0.0" }
      ]
    }"#;
    let dir = ScratchDir::with_service_cfg("dedup-nonadjacent", raw);
    let entries =
        ports::required_ports(Some(dir.path()));

    let occurrences = entries.iter().filter(|entry| entry.port == 18321).count();
    assert_eq!(
        occurrences, 1,
        "18321 must appear once despite a non-adjacent duplicate; got {:?}",
        entries.iter().map(|e| e.port).collect::<Vec<_>>()
    );
}

#[test]
fn keeps_same_port_on_different_bind_hosts() {
    // De-duplication is keyed on (port, bind_host): the same port on 0.0.0.0 and
    // on 127.0.0.1 are genuinely different probes and both must survive.
    let raw = r#"{
      "services": [
        { "name": "a", "port": 19999, "bind_host": "0.0.0.0" },
        { "name": "b", "port": 19999, "bind_host": "127.0.0.1" }
      ]
    }"#;
    let dir = ScratchDir::with_service_cfg("dedup-bindhosts", raw);
    let entries =
        ports::required_ports(Some(dir.path()));

    assert_eq!(
        entries.iter().filter(|entry| entry.port == 19999).count(),
        2,
        "the same port on two interfaces must both be probed"
    );
}

/// Throwaway directory holding a `service_cfg.json`, removed on drop.
///
/// Hand-rolled rather than pulling in `tempfile`, which is not a dependency of
/// this crate. The name is suffixed with the process id so concurrent test
/// binaries cannot collide.
struct ScratchDir(std::path::PathBuf);

impl ScratchDir {
    fn with_service_cfg(label: &str, raw: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "superclaw-portgate-{label}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        std::fs::write(dir.join("service_cfg.json"), raw).expect("write service_cfg.json");
        Self(dir)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn servicehub_exe_outranks_servicehub_dir() {
    // The gate must read the SAME service_cfg.json ServiceHub will launch from.
    // `resolve_servicehub_launch_target` checks SERVICEHUB_EXE first, so if this
    // resolver preferred SERVICEHUB_DIR the gate would probe a different payload's
    // ports than the one actually starting.
    //
    // Serialized via a mutex because env vars are process-global: a concurrent
    // test mutating them would make this flaky.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let exe_dir = ScratchDir::with_service_cfg(
        "resolver-exe",
        r#"{ "services": [ { "name": "from_exe", "port": 11111 } ] }"#,
    );
    let dir_dir = ScratchDir::with_service_cfg(
        "resolver-dir",
        r#"{ "services": [ { "name": "from_dir", "port": 22222 } ] }"#,
    );

    let prev_exe = std::env::var_os("SERVICEHUB_EXE");
    let prev_dir = std::env::var_os("SERVICEHUB_DIR");

    // SERVICEHUB_EXE points AT the executable; the cfg sits beside it.
    std::env::set_var(
        "SERVICEHUB_EXE",
        exe_dir.path().join(crate::servicehub::SERVICEHUB_EXE_NAME),
    );
    std::env::set_var("SERVICEHUB_DIR", dir_dir.path());

    let resolved = resolve_servicehub_dir();

    match prev_exe {
        Some(value) => std::env::set_var("SERVICEHUB_EXE", value),
        None => std::env::remove_var("SERVICEHUB_EXE"),
    }
    match prev_dir {
        Some(value) => std::env::set_var("SERVICEHUB_DIR", value),
        None => std::env::remove_var("SERVICEHUB_DIR"),
    }

    assert_eq!(
        resolved.as_deref(),
        Some(exe_dir.path()),
        "SERVICEHUB_EXE must win over SERVICEHUB_DIR, matching ServiceHub's own resolver"
    );
}

// ── own-leftover vs foreign discrimination ─────────────────────────────────
//
// The gate's core rule: only an EXTERNAL program blocks startup; SuperClaw's own
// leftover processes never do.

#[test]
fn exact_image_path_proves_ownership() {
    // Strongest proof, and the one that needs no external tooling: the holder is
    // running from precisely where we would have launched it.
    let dir = Path::new(r"C:\Program Files\SuperClaw\servicehub");
    let expected = identity::expected_child_image_path(dir, "llmrouter_manager.exe");
    assert_eq!(
        expected,
        dir.join("llmrouter_manager").join("llmrouter_manager.exe"),
        "must mirror _expected_frozen_child_image_path's <dir>/<stem>/<exe> layout"
    );
    assert!(identity::image_path_is_ours(
        r"C:\Program Files\SuperClaw\servicehub\llmrouter_manager\llmrouter_manager.exe",
        &expected
    ));
}

#[test]
fn image_path_comparison_normalises_case_and_separators() {
    let expected = identity::expected_child_image_path(
        Path::new(r"C:\SuperClaw\servicehub"),
        "sandbox_manager.exe",
    );
    assert!(identity::image_path_is_ours(
        r"c:/superclaw/servicehub/sandbox_manager/SANDBOX_MANAGER.EXE",
        &expected
    ));
}

#[test]
fn an_identically_named_binary_elsewhere_is_not_ours() {
    // Exact path comparison, not a name check: this is what stops a stray
    // `llama-server.exe` in a download folder from being waved through.
    let expected =
        identity::expected_child_image_path(Path::new(r"C:\SuperClaw\servicehub"), "llama-server.exe");
    assert!(!identity::image_path_is_ours(
        r"C:\Users\bob\Downloads\llama-server\llama-server.exe",
        &expected
    ));
}

#[test]
fn cmdline_needs_both_a_service_reference_and_an_ownership_marker() {
    let exes = vec!["llmrouter_manager.exe".to_string()];

    // Both present → ours.
    assert!(identity::cmdline_is_ours(
        r#""C:\SuperClaw\servicehub\llmrouter_manager\llmrouter_manager.exe" --port 18321"#,
        "llmrouter_manager",
        &exes,
        None
    ));
    // Module launch from the dev tree.
    assert!(identity::cmdline_is_ours(
        r"C:\proj\applications.ai.superclaw\host\.venv\python.exe -m llmrouter_manager",
        "llmrouter_manager",
        &exes,
        None
    ));

    // Service reference but NO ownership marker → a clone outside our tree.
    assert!(!identity::cmdline_is_ours(
        r"C:\Users\bob\clone\llmrouter_manager.exe --port 18321",
        "llmrouter_manager",
        &exes,
        None
    ));
    // Ownership marker but no service reference → some other SuperClaw-adjacent
    // process that happens to hold the port.
    assert!(!identity::cmdline_is_ours(
        r"C:\SuperClaw\unrelated\tool.exe --serve",
        "llmrouter_manager",
        &exes,
        None
    ));
}

#[test]
fn a_users_own_http_server_never_matches() {
    // The canonical false-positive `_is_our_orphan_cmdline` is designed to reject.
    assert!(!identity::cmdline_is_ours(
        r"C:\Python312\python.exe -m http.server 18321",
        "llmrouter_manager",
        &["llmrouter_manager.exe".to_string()],
        None
    ));
}

/// Command line of a role hosted by the shared multi-role bundle.
fn role_cmdline(role: &str, port: u16) -> String {
    format!(
        r#""C:\Program Files\Intel\SuperClaw\servicehub\servicehub\superclaw-services.exe" --service {role} --host 127.0.0.1 --port {port}"#
    )
}

#[test]
fn role_cmdline_matches_only_its_own_role() {
    // Every role in the bundle shares one image path AND one exe name, so the
    // `--service` token is the only thing that distinguishes them. Without this
    // check a tts_manager process would be accepted as sandbox_manager's orphan.
    let exes = vec!["superclaw-services.exe".to_string()];

    assert!(identity::cmdline_is_ours(
        &role_cmdline("sandbox_manager", 18821),
        "sandbox_manager",
        &exes,
        Some("sandbox_manager")
    ));
    assert!(!identity::cmdline_is_ours(
        &role_cmdline("tts_manager", 18827),
        "sandbox_manager",
        &exes,
        Some("sandbox_manager")
    ));
    // A role name that merely starts with ours must not match, or a prefix
    // collision between two services becomes a wrong force-kill.
    assert!(!identity::cmdline_is_ours(
        &role_cmdline("sandbox_manager_backup", 18821),
        "sandbox_manager",
        &exes,
        Some("sandbox_manager")
    ));
}

#[test]
fn role_cmdline_without_a_service_flag_is_not_attributable() {
    // A role bundle launched with no role cannot be attributed to any single
    // service, so the gate must decline rather than guess.
    assert!(!identity::cmdline_is_ours(
        r#""C:\Program Files\Intel\SuperClaw\servicehub\servicehub\superclaw-services.exe" --host 127.0.0.1 --port 18821"#,
        "sandbox_manager",
        &["superclaw-services.exe".to_string()],
        Some("sandbox_manager")
    ));
}

#[test]
fn role_is_parsed_from_service_cfg_launch_kind() {
    let raw = r#"{
      "services": [
        {
          "name": "sandbox_manager",
          "entrypoint": "sandbox_manager",
          "proxy_prefix": "/sandbox-manager",
          "port": 18821,
          "bind_host": "127.0.0.1",
          "launch": { "kind": "role", "exe_name": "superclaw-services.exe" }
        },
        {
          "name": "solo_service",
          "entrypoint": "solo_service",
          "proxy_prefix": "/solo",
          "port": 18999,
          "launch": { "kind": "exe", "exe_name": "solo_service.exe" }
        }
      ]
    }"#;

    let parsed = ports::parse_service_cfg(raw).expect("cfg parses");

    let role_entry = parsed
        .iter()
        .find(|entry| entry.service == "sandbox_manager")
        .expect("role entry present");
    assert_eq!(role_entry.role.as_deref(), Some("sandbox_manager"));
    // exe_names is NOT special-cased for a role entry: it stays an exact mirror of
    // `process_manager._configured_exe_names`, and the role token is what
    // disambiguates the shared bundle.
    assert!(role_entry.exe_names.contains(&"superclaw-services.exe".to_string()));

    let solo_entry = parsed
        .iter()
        .find(|entry| entry.service == "solo_service")
        .expect("exe entry present");
    assert_eq!(solo_entry.role, None);
    assert!(solo_entry.exe_names.contains(&"solo_service.exe".to_string()));
}

#[test]
fn ownership_markers_cover_dev_packaged_and_appdata_layouts() {
    for path in [
        r"C:\proj\applications.ai.superclaw\host\servicehub",
        r"C:\Program Files\SuperClaw\servicehub\x.exe",
        r"C:\Users\bob\AppData\Local\SuperClaw\llmrouter_manager",
    ] {
        assert!(
            identity::has_ownership_marker(path),
            "{path} must carry an ownership marker"
        );
    }
    assert!(!identity::has_ownership_marker(r"C:\Users\bob\Downloads\thing.exe"));
}

#[test]
fn probe_result_separates_tool_failure_from_no_listener() {
    // These two states must stay distinguishable, because they get OPPOSITE
    // verdicts: "netstat ran and found nothing" is an HNS ghost / TIME_WAIT that
    // ServiceHub recovers, while "netstat failed" is an unverifiable owner that
    // ServiceHub treats as a blocker. Collapsing them is the mistake
    // `_port_owner_pid` documents.
    let tool_failed = probe::ProbeResult::default();
    assert!(!tool_failed.netstat_ok);
    assert!(tool_failed.owners.is_empty());

    let ran_but_empty = probe::ProbeResult {
        owners: Default::default(),
        netstat_ok: true,
        netstat_rows: 120,
    };
    assert!(ran_but_empty.netstat_ok);
    assert!(
        ran_but_empty.owners.is_empty(),
        "a clean run with no listener is the ghost signature, not a failure"
    );
}

#[test]
fn a_clean_netstat_with_no_matching_row_yields_no_owner() {
    // The ghost case as it actually arrives: netstat output is valid and complete,
    // it simply contains no LISTENING row for the port. Compare with a TIME_WAIT
    // row, where the port appears only in the Foreign Address column with PID 0.
    let netstat = "\
  TCP    127.0.0.1:54137        127.0.0.1:18333        TIME_WAIT       0
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       912
";
    assert!(
        probe::parse_netstat_listening_pids(netstat, &[18333]).is_empty(),
        "18333 appears only as a TIME_WAIT peer, so it has no listening owner"
    );
}

#[test]
#[cfg(windows)]
fn a_child_whose_output_exceeds_the_pipe_buffer_still_completes() {
    // Regression: `run_capture` used to poll `try_wait()` without reading stdout.
    // A piped stdout has a small OS buffer, so any child producing more than that
    // blocks on write, never exits, and the poll loop can only end at the timeout.
    // In CI this pinned three consecutive probes at exactly the 20s limit; locally
    // it reproduces as `exited=False ms=20050` versus 58ms when the pipe is read.
    //
    // `netstat -ano` is the real-world trigger, but its size varies by machine, so
    // drive the buffer deliberately with a large, deterministic output instead.
    let started = std::time::Instant::now();
    let out = probe::run_capture_with_timeout(
        "cmd",
        &["/C", "for /L %i in (1,1,4000) do @echo padding-line-%i"],
        std::time::Duration::from_secs(30),
    );
    let elapsed = started.elapsed();

    let out = out.expect("a child that outruns the pipe buffer must still be captured");
    assert!(
        out.len() > 64 * 1024,
        "expected output well past any pipe buffer, got {} bytes",
        out.len()
    );
    assert!(
        elapsed < std::time::Duration::from_secs(20),
        "completing only at the timeout means the pipe deadlock is back (took {elapsed:?})"
    );
}

// ── netstat / tasklist parsing ─────────────────────────────────────────────

#[test]
fn finds_listening_pid_for_port() {
    let netstat = "\
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:18321          0.0.0.0:0              LISTENING       4242
  TCP    0.0.0.0:18826          0.0.0.0:0              LISTENING       777
";
    let found = probe::parse_netstat_listening_pids(netstat, &[18321, 18826, 19999]);
    assert_eq!(found.get(&18321), Some(&4242));
    assert_eq!(found.get(&18826), Some(&777));
    assert_eq!(found.get(&19999), None);
}

#[test]
fn resolves_every_wanted_port_from_one_netstat_sweep() {
    // The batched call is what keeps the probe inside its timeout on a loaded
    // machine; a per-port sweep is what produced "unknown owner" in CI.
    let netstat = "\
  TCP    0.0.0.0:18321          0.0.0.0:0              LISTENING       1
  TCP    0.0.0.0:18826          0.0.0.0:0              LISTENING       2
  TCP    127.0.0.1:18821        0.0.0.0:0              LISTENING       3
  TCP    127.0.0.1:18103        0.0.0.0:0              LISTENING       4
";
    let found = probe::parse_netstat_listening_pids(netstat, &[18321, 18826, 18821, 18103]);
    assert_eq!(found.len(), 4, "all four ports must resolve in one pass");
}

#[test]
fn matches_ipv6_listeners() {
    // netstat labels IPv6 rows TCPv6; missing them would misread an IPv6-only
    // listener as an ownerless HNS ghost.
    let netstat = "  TCPv6   [::]:18321             [::]:0                 LISTENING       991\n";
    let found = probe::parse_netstat_listening_pids(netstat, &[18321]);
    assert_eq!(found.get(&18321), Some(&991));
}

#[test]
fn ignores_non_listening_and_zero_pid_rows() {
    let netstat = "\
  TCP    127.0.0.1:18321        127.0.0.1:5000         TIME_WAIT       0
  TCP    127.0.0.1:18321        127.0.0.1:5001         ESTABLISHED     123
";
    assert!(probe::parse_netstat_listening_pids(netstat, &[18321]).is_empty());
}

#[test]
fn does_not_confuse_a_port_that_is_a_suffix_of_another() {
    // ":8321" must not match a row for ":18321".
    let netstat = "  TCP    0.0.0.0:18321          0.0.0.0:0              LISTENING       4242\n";
    assert!(probe::parse_netstat_listening_pids(netstat, &[8321]).is_empty());
}

#[test]
fn extracts_pid_and_image_name_from_tasklist_csv() {
    let rows = "\
\"python.exe\",\"12345\",\"Console\",\"1\",\"24,180 K\"
\"node.exe\",\"777\",\"Console\",\"1\",\"9,000 K\"
";
    let parsed = probe::parse_tasklist_rows(rows);
    assert_eq!(parsed.len(), 2);
    assert!(parsed.contains(&(12345, "python.exe".to_string())));
    assert!(parsed.contains(&(777, "node.exe".to_string())));
}

#[test]
fn returns_nothing_when_tasklist_finds_no_task() {
    assert!(
        probe::parse_tasklist_rows("INFO: No tasks are running which match the criteria.\n")
            .is_empty()
    );
    assert!(probe::parse_tasklist_rows("").is_empty());
}

// ── live bind probing ──────────────────────────────────────────────────────

#[test]
fn reports_a_bound_port_as_occupied_and_a_free_one_as_free() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("must bind ephemeral port");
    let occupied = listener.local_addr().expect("addr").port();

    assert!(
        !is_port_free(occupied, "127.0.0.1"),
        "a port we are holding must probe as occupied"
    );

    drop(listener);
    assert!(
        is_port_free(occupied, "127.0.0.1"),
        "the port must be free again once the listener is dropped"
    );
}

#[test]
fn probe_releases_the_port_it_tested() {
    // The gate must not hold the ports it probes, or the real services could not
    // claim them afterwards.
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);

    assert!(is_port_free(port, "127.0.0.1"));
    assert!(
        TcpListener::bind(("127.0.0.1", port)).is_ok(),
        "port must still be claimable after being probed"
    );
}

// ── report semantics ───────────────────────────────────────────────────────

#[test]
fn empty_conflicts_means_the_gate_passes() {
    let report = PortPreflightReport {
        conflicts: vec![],
        checked_ports: vec![18321, 18826],
    };
    assert!(!report.is_blocked());
}

#[test]
fn any_conflict_blocks_startup() {
    let report = PortPreflightReport {
        conflicts: vec![PortConflict {
            port: 18321,
            service: "llmrouter_manager".to_string(),
            bind_host: "0.0.0.0".to_string(),
            owner_name: Some("python.exe".to_string()),
            owner_pid: Some(4242),
        }],
        checked_ports: vec![18321],
    };
    assert!(report.is_blocked());
}

#[test]
fn state_starts_empty_then_caches_the_report() {
    let state = PortPreflightState::default();
    // "Not yet run" must stay distinguishable from "ran, found nothing" so the
    // frontend can fail open.
    assert!(state.get().is_none());

    state.set(PortPreflightReport {
        conflicts: vec![],
        checked_ports: vec![18321],
    });
    let cached = state.get().expect("report must be cached");
    assert!(!cached.is_blocked());
    assert_eq!(cached.checked_ports, vec![18321]);
}

#[test]
fn required_ports_include_llama_router_and_are_deduplicated() {
    let entries = ports::required_ports(None);

    // Fallback ServiceHub ports + llama router are always present.
    for expected in [18321u16, 18826, 18821, 18103] {
        assert!(
            entries.iter().any(|entry| entry.port == expected),
            "port {expected} must be probed; got {:?}",
            entries.iter().map(|e| e.port).collect::<Vec<_>>()
        );
    }

    // 8080 is never actually bound by llama-server (it only appears in the LRM
    // preflight text), so probing it would be a false alarm.
    assert!(
        !entries.iter().any(|entry| entry.port == 8080),
        "8080 must NOT be probed"
    );

    // tts_manager (18827) is on demand: the parse path drops it, and the
    // compiled-in fallback (exercised here via `required_ports(None)`) must not
    // reintroduce it — otherwise an unreadable
    // service_cfg.json would let an on-demand narration port gate app startup.
    assert!(
        !entries.iter().any(|entry| entry.port == 18827),
        "on-demand tts_manager port 18827 must NOT be in the fallback gate"
    );

    let mut seen: Vec<(u16, &str)> = entries
        .iter()
        .map(|entry| (entry.port, entry.bind_host.as_str()))
        .collect();
    let before = seen.len();
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(before, seen.len(), "port list must not contain duplicates");
}

#[test]
fn a_source_checkout_is_not_treated_as_packaged() {
    // Regression guard for the role gate: service_cfg.json declares kind="role"
    // for every child, but ServiceHub only puts --service on argv when it runs
    // frozen. In a source checkout it spawns `python -m <entrypoint>`, so
    // requiring the role token there would reject our own orphan. servicehub_dir
    // is ALSO the dev source directory, so only the exe can tell them apart.
    let dir = ScratchDir::with_service_cfg("packaged-gate", "{}");

    assert!(!super::servicehub_is_packaged(None));
    assert!(
        !super::servicehub_is_packaged(Some(dir.path())),
        "a directory without the Hub exe is a source checkout, not packaged"
    );

    std::fs::write(
        dir.path().join(crate::servicehub::SERVICEHUB_EXE_NAME),
        b"",
    )
    .expect("write exe");
    assert!(super::servicehub_is_packaged(Some(dir.path())));
}

#[test]
fn role_entry_still_matches_a_module_launch_when_not_packaged() {
    // The dev-mode counterpart of role_cmdline_matches_only_its_own_role: with the
    // role suppressed (source checkout), a `-m <entrypoint>` orphan must still be
    // recognised as ours by entrypoint + ownership marker alone.
    let cmdline = r"C:\dev\applications.ai.superclaw\host\.venv\Scripts\python.exe -m sandbox_manager --host 127.0.0.1 --port 18821";

    assert!(identity::cmdline_is_ours(
        cmdline,
        "sandbox_manager",
        &["superclaw-services.exe".to_string()],
        None
    ));
    // ...and with the role enforced it would NOT match, which is exactly why the
    // packaged gate above has to suppress it.
    assert!(!identity::cmdline_is_ours(
        cmdline,
        "sandbox_manager",
        &["superclaw-services.exe".to_string()],
        Some("sandbox_manager")
    ));
}
