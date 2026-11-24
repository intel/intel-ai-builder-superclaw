use super::*;

#[test]
fn parse_reuse_handshake_rejects_missing_or_invalid_pid() {
    for line in [
        r#"REUSE {"port":18830,"token":"abc"}"#,
        r#"REUSE {"port":18830,"token":"abc","pid":0}"#,
        r#"REUSE {"port":18830,"token":"abc","pid":4294967296}"#,
    ] {
        assert_eq!(parse_servicehub_ready(line), None, "{line}");
    }
}

#[test]
fn packaged_servicehub_identity_requires_hub_role() {
    let root = std::env::temp_dir().join(format!("sh_role_identity_{}", std::process::id()));
    let servicehub_dir = root.join("SuperClaw").join("servicehub");
    std::fs::create_dir_all(&servicehub_dir).unwrap();
    let executable = servicehub_dir.join(SERVICEHUB_EXE_NAME);
    std::fs::write(&executable, b"test executable").unwrap();
    let image = executable.to_string_lossy();

    assert!(servicehub_reuse_process_matches(
        &image,
        &format!("\"{image}\" --service servicehub --port 0"),
    ));
    assert!(!servicehub_reuse_process_matches(
        &image,
        &format!("\"{image}\" --service sandbox_manager --port 0"),
    ));
    assert!(!servicehub_reuse_process_matches(
        &image,
        &format!("\"{image}\" --port 0"),
    ));

    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "windows")]
#[test]
fn packaged_servicehub_role_parses_quoted_windows_arguments() {
    let executable = r#"C:\Program Files\SuperClaw\servicehub\superclaw-services.exe"#;
    assert!(servicehub_dispatch_role_is_servicehub(&format!(
        r#""{executable}" "--service" "servicehub" --port 0"#
    )));
    assert!(!servicehub_dispatch_role_is_servicehub(&format!(
        r#""{executable}" "--service" "sandbox_manager" --port 0"#
    )));
}

#[cfg(target_os = "windows")]
#[test]
fn reuse_python_module_must_be_the_actual_invocation() {
    for command in [
        r#"python.exe script.py -m servicehub"#,
        r#"python.exe -c "print('-m servicehub')""#,
        r#"python.exe -m other_module -m servicehub"#,
        r#"python.exe -m servicehub.fake"#,
        r#"python.exe -W "-m servicehub" script.py"#,
    ] {
        assert!(
            !servicehub_module_invocation_in_cmdline(command),
            "{command}"
        );
    }
    assert!(servicehub_module_invocation_in_cmdline(
        r#""C:\Python Tools\python.exe" -u -X utf8 -m servicehub --port 0"#
    ));
}

#[cfg(target_os = "windows")]
#[test]
fn reuse_python_identity_accepts_only_configured_venv_redirector_base_image() {
    let root = std::env::temp_dir().join(format!("sh_venv_identity_{}", std::process::id()));
    let base_dir = root.join("base-python");
    let venv_scripts = root.join("venv").join("Scripts");
    let unrelated_base = root.join("unrelated-python");
    std::fs::create_dir_all(&base_dir).unwrap();
    std::fs::create_dir_all(&venv_scripts).unwrap();
    std::fs::create_dir_all(&unrelated_base).unwrap();
    let base_python = base_dir.join("python.exe");
    let redirector = venv_scripts.join("python.exe");
    std::fs::write(&base_python, b"base interpreter").unwrap();
    std::fs::write(&redirector, b"venv redirector").unwrap();
    let config = venv_scripts.parent().unwrap().join("pyvenv.cfg");
    std::fs::write(&config, format!("home = {}\n", base_dir.display())).unwrap();

    let image = base_python.to_string_lossy();
    let command = format!("\"{}\" -u -m servicehub --port 0", redirector.display());
    assert!(servicehub_reuse_process_matches(&image, &command));

    std::fs::write(&config, format!("home = {}\n", unrelated_base.display())).unwrap();
    assert!(!servicehub_reuse_process_matches(&image, &command));

    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "windows")]
#[test]
fn reuse_identity_matches_relative_argv0_without_assuming_launch_cwd() {
    let root = std::env::temp_dir().join(format!("sh_relative_argv0_{}", std::process::id()));
    let python_dir = root.join(".venv").join("Scripts");
    std::fs::create_dir_all(&python_dir).unwrap();
    let python = python_dir.join("python.exe");
    std::fs::write(&python, b"test").unwrap();
    let python_path = python.to_string_lossy();
    assert!(servicehub_reuse_process_matches_launch_target_with_command(
        &python_path,
        r#".\.venv\Scripts\python.exe -u -m servicehub --port 0"#,
        &python_path,
    ));

    let packaged_dir = root.join("SuperClaw").join("servicehub");
    std::fs::create_dir_all(&packaged_dir).unwrap();
    let packaged_exe = packaged_dir.join(SERVICEHUB_EXE_NAME);
    std::fs::write(&packaged_exe, b"test").unwrap();
    let packaged_path = packaged_exe.to_string_lossy();
    assert!(servicehub_reuse_process_matches_launch_target_with_command(
        &packaged_path,
        r#"servicehub\superclaw-services.exe --service servicehub --port 0"#,
        &packaged_path,
    ));

    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn authenticated_readiness_retries_up_to_five_attempts() {
    let cancel = AtomicBool::new(false);
    let mut attempts = 0;
    assert!(retry_authenticated_readiness(
        &cancel,
        Duration::ZERO,
        |_| {
            attempts += 1;
            attempts == 5
        }
    ));
    assert_eq!(attempts, 5);
}

#[test]
fn authenticated_readiness_stops_retrying_when_cancelled() {
    let cancel = AtomicBool::new(false);
    let mut attempts = 0;
    assert!(!retry_authenticated_readiness(
        &cancel,
        Duration::ZERO,
        |_| {
            attempts += 1;
            cancel.store(true, Ordering::SeqCst);
            false
        }
    ));
    assert_eq!(attempts, 1);
}

#[test]
fn reuse_listener_decision_waits_recovers_or_rejects_by_state() {
    assert_eq!(
        reuse_listener_decision(TcpListenerStatus::Missing, false),
        ReuseListenerDecision::Wait
    );
    assert_eq!(
        reuse_listener_decision(TcpListenerStatus::Missing, true),
        ReuseListenerDecision::Recover
    );
    assert_eq!(
        reuse_listener_decision(TcpListenerStatus::Unavailable, false),
        ReuseListenerDecision::Reject
    );
}

#[test]
fn owned_listener_runs_readiness_probe_before_attach() {
    let mut readiness_probed = false;
    let result = run_reuse_listener_preflight(
        Some(TcpListenerStatus::Owned),
        false,
        || {
            readiness_probed = true;
            true
        },
        || panic!("an owned listener must not start recovery"),
        |_, _| panic!("an owned listener must not be rejected"),
    );
    assert_eq!(result, ReuseListenerPreflight::Ready);
    assert!(readiness_probed);
}

#[test]
fn tcp_listener_rows_reject_competing_loopback_and_wildcard_owners() {
    let loopback = u32::from_ne_bytes([127, 0, 0, 1]);
    for rows in [
        vec![(18_830, loopback, 101), (18_830, loopback, 202)],
        vec![(18_830, 0, 101), (18_830, loopback, 202)],
        vec![(18_830, loopback, 101), (18_830, 0, 202)],
    ] {
        assert_eq!(
            classify_tcp_listener_rows(18_830, 101, rows),
            TcpListenerStatus::DifferentOwner
        );
    }
}

#[test]
fn tcp_listener_rows_ignore_unrelated_local_addresses() {
    let loopback = u32::from_ne_bytes([127, 0, 0, 1]);
    let other_address = u32::from_ne_bytes([192, 168, 1, 10]);
    assert_eq!(
        classify_tcp_listener_rows(
            18_830,
            101,
            [(18_829, loopback, 202), (18_830, other_address, 202)]
        ),
        TcpListenerStatus::Missing
    );
    assert_eq!(
        classify_tcp_listener_rows(
            18_830,
            101,
            [(18_830, other_address, 202), (18_830, loopback, 101)]
        ),
        TcpListenerStatus::Owned
    );
}

#[test]
fn mismatched_lockfile_identity_rejects_before_readiness_probe() {
    let port = 18_830;
    let token = "expected-token";
    let pid = 4_242;
    let matching_lockfile = serde_json::json!({"port": port, "token": token, "pid": pid});
    assert!(servicehub_lockfile_identity_matches(
        &matching_lockfile,
        port,
        token,
        pid,
    ));

    for lockfile in [
        serde_json::json!({"port": port + 1, "token": token, "pid": pid}),
        serde_json::json!({"port": port, "token": "different-token", "pid": pid}),
        serde_json::json!({"port": port, "token": token, "pid": pid + 1}),
    ] {
        let lockfile_matches = servicehub_lockfile_identity_matches(&lockfile, port, token, pid);
        assert!(!lockfile_matches);

        let process_check_called = std::cell::Cell::new(false);
        let listener_check_called = std::cell::Cell::new(false);
        let status = reuse_handoff_identity_status_with_checks(
            lockfile_matches,
            || {
                process_check_called.set(true);
                true
            },
            || {
                process_check_called.set(true);
                true
            },
            || {
                listener_check_called.set(true);
                TcpListenerStatus::Owned
            },
        );
        assert_eq!(status, TcpListenerStatus::Unavailable);
        assert!(!process_check_called.get());
        assert!(!listener_check_called.get());

        let readiness_probed = std::cell::Cell::new(false);
        let rejected = std::cell::Cell::new(false);
        let result = run_reuse_listener_preflight(
            Some(status),
            false,
            || {
                readiness_probed.set(true);
                true
            },
            || panic!("a lockfile mismatch must not start recovery"),
            |code, _| {
                assert_eq!(code, "reuse.identity.rejected");
                rejected.set(true);
            },
        );

        assert_eq!(result, ReuseListenerPreflight::Rejected);
        assert!(rejected.get());
        assert!(!readiness_probed.get());
    }
}

#[test]
fn changed_listener_owner_after_successful_probe_rejects_reuse() {
    let readiness_probed = std::cell::Cell::new(false);
    let result = run_reuse_listener_preflight(
        Some(TcpListenerStatus::Owned),
        false,
        || {
            readiness_probed.set(true);
            true
        },
        || panic!("an owned listener must not start recovery"),
        |_, _| panic!("the initial owned identity must not be rejected"),
    );

    assert_eq!(result, ReuseListenerPreflight::Ready);
    assert!(readiness_probed.get());

    let identity_rechecked = std::cell::Cell::new(false);
    let rejection_code = std::cell::Cell::new(None);
    let accepted = accept_reuse_after_identity_recheck(
        || {
            assert!(readiness_probed.get());
            identity_rechecked.set(true);
            TcpListenerStatus::DifferentOwner
        },
        || false,
        |code, _| rejection_code.set(Some(code)),
    );

    assert!(!accepted);
    assert!(identity_rechecked.get());
    assert_eq!(rejection_code.get(), Some("reuse.identity.rejected"));
}

#[test]
fn cancellation_during_identity_recheck_stops_attach_without_rejection() {
    let cancelled = AtomicBool::new(false);
    let identity_rechecked = std::cell::Cell::new(false);
    let rejection_emitted = std::cell::Cell::new(false);

    let accepted = accept_reuse_after_identity_recheck(
        || {
            identity_rechecked.set(true);
            cancelled.store(true, Ordering::SeqCst);
            TcpListenerStatus::Owned
        },
        || cancelled.load(Ordering::SeqCst),
        |_, _| rejection_emitted.set(true),
    );

    assert!(!accepted);
    assert!(identity_rechecked.get());
    assert!(!rejection_emitted.get());
}
