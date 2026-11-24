use super::*;
use std::fs;

#[test]
fn telemetry_setup_errors_are_not_startup_failures() {
    assert!(!is_startup_failure_stage("telemetry.install_id"));
    assert!(is_startup_failure_stage("spawn.failed"));
    assert!(is_startup_failure_stage("health.failed"));
}

#[test]
fn capability_profile_required_is_recognized_as_managed_sandbox_deferral() {
    let payload = serde_json::json!({
        "error": {"code": "capability_profile_required"}
    });

    assert!(is_capability_profile_required(&payload));
}

#[test]
fn unrelated_sandbox_provision_errors_are_not_treated_as_capability_deferrals() {
    let conflict = serde_json::json!({"error": {"code": "provisions_already_running"}});
    let malformed = serde_json::json!({"error": "capability_profile_required"});

    assert!(!is_capability_profile_required(&conflict));
    assert!(!is_capability_profile_required(&malformed));
}

#[test]
fn active_activation_discovery_accepts_every_applying_stage() {
    for stage in ["preparing", "activating", "aligning_runtime"] {
        let payload = serde_json::json!({
            "contract_version": 1,
            "operation": {
                "contract_version": 1,
                "operation_id": "hub:activation-resumed",
                "status": "applying",
                "stage": stage,
                "progress": {"pct": 20}
            }
            });

        assert_eq!(parse_active_model_binding_activation(&payload), Ok(true));
    }
}

#[test]
fn active_activation_discovery_accepts_no_active_operation() {
    let payload = serde_json::json!({"contract_version": 1, "operation": null});

    assert_eq!(parse_active_model_binding_activation(&payload), Ok(false));
}

#[test]
fn active_activation_discovery_rejects_removed_journal_projection_fields() {
    let payload = serde_json::json!({
        "contract_version": 1,
        "operation": {
            "operation_id": "hub:activation-resumed",
            "phase": "lrm_preparing",
            "state": "running"
        }
    });

    assert_eq!(
        parse_active_model_binding_activation(&payload),
        Err("activation discovery returned an invalid operation projection".to_owned())
    );
}

#[test]
fn active_activation_discovery_rejects_terminal_operation() {
    let payload = serde_json::json!({
        "contract_version": 1,
        "operation": {
            "contract_version": 1,
            "operation_id": "hub:activation-resumed",
            "status": "succeeded",
            "runtime_transition_required": false
        }
    });

    assert_eq!(
        parse_active_model_binding_activation(&payload),
        Err("activation discovery returned an invalid operation projection".to_owned())
    );
}

#[test]
fn active_activation_discovery_rejects_retired_handoff_envelope() {
    let payload = serde_json::json!({
        "contract_version": 1,
        "disposition": "handoff",
        "operation": null
    });

    assert_eq!(
        parse_active_model_binding_activation(&payload),
        Err("activation discovery returned retired handoff fields".to_owned())
    );
}

// ── Positive: handshake parsing ────────────────────────────────────

#[test]
fn installed_sibling_servicehub_target_uses_exe_layout() {
    let root = std::env::temp_dir().join(format!(
        "superclaw-servicehub-target-{}",
        std::process::id()
    ));
    let release_dir = root.join("build").join("Release");
    let servicehub_dir = release_dir.join("servicehub");
    fs::create_dir_all(&servicehub_dir).expect("create servicehub test dir");
    let app_exe = release_dir.join("SuperClaw.exe");
    let servicehub_exe = servicehub_dir.join(SERVICEHUB_EXE_NAME);
    fs::write(&app_exe, b"").expect("write app exe placeholder");
    fs::write(&servicehub_exe, b"").expect("write servicehub exe placeholder");

    let target = installed_sibling_servicehub_target_from_exe(&app_exe, 18865)
        .expect("installed sibling target");

    assert_eq!(target.command, servicehub_exe.to_string_lossy());
    assert_eq!(target.cwd, servicehub_dir);
    // #51: the port the shell picked from the contract's candidates, never `0`.
    assert_eq!(
        target.args,
        vec![
            "--service",
            "servicehub",
            "--port",
            "18865",
            "--service-cfg",
            "service_cfg.json"
        ]
    );
    assert_eq!(
        target.description,
        format!("installed sibling {SERVICEHUB_EXE_NAME}")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn parse_valid_handshake() {
    let line = r#"SERVICEHUB_READY {"port":18830,"token":"abc123"}"#;
    let result = parse_servicehub_ready(line);
    assert_eq!(result, Some((18830, "abc123".to_string(), false, None)));
}

#[test]
fn parse_handshake_with_whitespace() {
    let line = r#"  SERVICEHUB_READY {"port":19000,"token":"xyz"}  "#;
    let result = parse_servicehub_ready(line);
    assert_eq!(result, Some((19000, "xyz".to_string(), false, None)));
}

#[test]
fn parse_handshake_port_zero() {
    let line = r#"SERVICEHUB_READY {"port":0,"token":"t"}"#;
    assert_eq!(parse_servicehub_ready(line), None);
}

#[test]
fn parse_handshake_high_port() {
    let line = r#"SERVICEHUB_READY {"port":65535,"token":"max"}"#;
    assert_eq!(
        parse_servicehub_ready(line),
        Some((65535, "max".to_string(), false, None))
    );
}

#[test]
fn parse_handshake_long_token() {
    let token = "a".repeat(128);
    let line = format!(r#"SERVICEHUB_READY {{"port":9999,"token":"{}"}}"#, token);
    assert_eq!(parse_servicehub_ready(&line), Some((9999, token, false, None)));
}

#[test]
fn parse_handshake_compact_json() {
    let line = r#"SERVICEHUB_READY {"port":18830,"token":"abc123"}"#;
    assert!(parse_servicehub_ready(line).is_some());
}

#[test]
fn parse_handshake_pretty_json() {
    let line = r#"SERVICEHUB_READY {"port": 18830, "token": "abc123"}"#;
    assert_eq!(
        parse_servicehub_ready(line),
        Some((18830, "abc123".to_string(), false, None))
    );
}

// ── Negative: handshake parsing ────────────────────────────────────

#[test]
fn parse_handshake_ignores_unrelated_lines() {
    assert_eq!(parse_servicehub_ready("some random output"), None);
    assert_eq!(parse_servicehub_ready("BACKEND_MANAGER_READY {}"), None);
    assert_eq!(parse_servicehub_ready(""), None);
}

#[test]
fn parse_handshake_rejects_malformed_json() {
    assert_eq!(parse_servicehub_ready("SERVICEHUB_READY not-json"), None);
    assert_eq!(
        parse_servicehub_ready(r#"SERVICEHUB_READY {"port":"abc"}"#),
        None
    );
}

#[test]
fn parse_handshake_rejects_missing_port() {
    assert_eq!(
        parse_servicehub_ready(r#"SERVICEHUB_READY {"token":"abc"}"#),
        None
    );
}

#[test]
fn parse_handshake_rejects_missing_token() {
    assert_eq!(
        parse_servicehub_ready(r#"SERVICEHUB_READY {"port":18830}"#),
        None
    );
}

#[test]
fn parse_handshake_rejects_null_token() {
    assert_eq!(
        parse_servicehub_ready(r#"SERVICEHUB_READY {"port":18830,"token":null}"#),
        None
    );
}

#[test]
fn parse_handshake_rejects_numeric_token() {
    assert_eq!(
        parse_servicehub_ready(r#"SERVICEHUB_READY {"port":18830,"token":12345}"#),
        None
    );
}

#[test]
fn parse_handshake_rejects_negative_port() {
    assert_eq!(
        parse_servicehub_ready(r#"SERVICEHUB_READY {"port":-1,"token":"x"}"#),
        None
    );
}

#[test]
fn parse_handshake_rejects_empty_json() {
    assert_eq!(parse_servicehub_ready("SERVICEHUB_READY {}"), None);
}

#[test]
fn parse_handshake_rejects_prefix_only() {
    assert_eq!(parse_servicehub_ready("SERVICEHUB_READY "), None);
    assert_eq!(parse_servicehub_ready("SERVICEHUB_READY"), None);
}

#[test]
fn parse_reuse_handshake_for_existing_servicehub() {
    assert_eq!(
        parse_servicehub_ready(r#"REUSE {"port":18830,"token":"abc","pid":4242}"#),
        Some((18830, "abc".to_string(), true, Some(4242)))
    );
}

#[test]
fn parse_distinguishes_ready_from_reuse() {
    // The is_reuse flag is what drives the stale-kept-alive-Hub self-heal, so it
    // must be false for READY and true for REUSE on otherwise-identical payloads.
    let ready_payload = r#"{"port":18830,"token":"abc"}"#;
    let reuse_payload = r#"{"port":18830,"token":"abc","pid":4242}"#;
    let ready = parse_servicehub_ready(&format!("SERVICEHUB_READY {ready_payload}"));
    let reuse = parse_servicehub_ready(&format!("REUSE {reuse_payload}"));
    assert_eq!(ready, Some((18830, "abc".to_string(), false, None)));
    assert_eq!(reuse, Some((18830, "abc".to_string(), true, Some(4242))));
}

#[test]
fn parse_reuse_with_whitespace_sets_reuse_flag() {
    assert_eq!(
        parse_servicehub_ready(r#"   REUSE {"port":19001,"token":"z","pid":4242}   "#),
        Some((19001, "z".to_string(), true, Some(4242)))
    );
}

#[test]
fn parse_handshake_rejects_partial_prefix() {
    assert_eq!(
        parse_servicehub_ready(r#"SERVICEHUB_READ {"port":1,"token":"t"}"#),
        None
    );
    assert_eq!(
        parse_servicehub_ready(r#"SERVICEHUB_READYY {"port":1,"token":"t"}"#),
        None
    );
}

#[test]
fn startup_detail_redacts_protocol_tokens_and_keeps_actionable_error() {
    let raw = concat!(
        "SERVICEHUB_READY {\"port\":18830,\"token\":\"ready-secret\"}\n",
        "Authorization: Bearer bearer-secret\n",
        "RuntimeError: ServiceHub child ports cannot be claimed: 18825\n",
    );

    let detail = sanitize_servicehub_startup_detail(raw).expect("safe detail");

    assert!(detail.contains("ports cannot be claimed: 18825"));
    assert!(!detail.contains("ready-secret"));
    assert!(!detail.contains("bearer-secret"));
    assert!(!detail.contains("SERVICEHUB_READY"));
}

#[test]
fn captured_stdout_redacts_handshake_token_and_keeps_reuse_error() {
    let handshake = safe_servicehub_stdout_line(
        "SERVICEHUB_READY {\"port\":18830,\"token\":\"ready-secret\"}\n",
    );
    let reuse_error = safe_servicehub_stdout_line(
        "REUSE {\"error\":\"another ServiceHub is running but lockfile is missing\"}\n",
    );

    assert_eq!(handshake, "SERVICEHUB_READY [redacted]\n");
    assert!(!handshake.contains("ready-secret"));
    assert!(reuse_error.contains("lockfile is missing"));
}

#[test]
fn captured_stderr_line_is_sanitized_before_persisting() {
    // Startup-logging unification (2026-07-21 §4.1): the child stderr transfer
    // path now routes through `safe_servicehub_stdout_line` before landing in
    // tauri.log. A protocol handshake line on stderr must be redacted just like
    // on stdout so no token is ever persisted.
    let stderr_handshake = safe_servicehub_stdout_line(
        "SERVICEHUB_READY {\"port\":18830,\"token\":\"stderr-secret\"}\n",
    );
    assert_eq!(stderr_handshake, "SERVICEHUB_READY [redacted]\n");
    assert!(!stderr_handshake.contains("stderr-secret"));

    // A REUSE protocol line spilled onto stderr is also redacted.
    let proto =
        safe_servicehub_stdout_line("REUSE {\"port\":18830,\"token\":\"proto-secret\"}\n");
    assert!(proto.contains("[redacted]"));
    assert!(!proto.contains("proto-secret"));
}

#[test]
fn ordinary_stderr_line_redacts_authorization_header_value() {
    // Startup-logging unification (2026-07-21 §4.1): a credential riding on an
    // ordinary (non-protocol) child stderr line must be redacted before it is
    // persisted to tauri.log. An `Authorization:` header value is dropped while
    // the surrounding traceback text is kept for debugging.
    let line = "  File \"client.py\", headers={'Authorization': Bearer sk-abc123DEF}\n";
    let safe = safe_servicehub_stdout_line(line);
    assert!(!safe.contains("sk-abc123DEF"), "token must not survive: {safe}");
    assert!(safe.contains("[redacted]"), "expected redaction marker: {safe}");
    // Non-secret context is preserved for triage.
    assert!(safe.contains("client.py"), "context must survive: {safe}");
    // Trailing newline preserved.
    assert!(safe.ends_with('\n'));
}

#[test]
fn ordinary_stderr_line_redacts_bare_bearer_token() {
    let line = "retrying request with Bearer eyJhbGciOiJIUzI1 header";
    let safe = safe_servicehub_stdout_line(line);
    assert!(!safe.contains("eyJhbGciOiJIUzI1"), "token must not survive: {safe}");
    assert!(safe.contains("Bearer [redacted]"), "expected redaction: {safe}");
    assert!(safe.contains("retrying request"), "context must survive: {safe}");
}

#[test]
fn ordinary_stderr_line_redacts_hub_token_flag_both_forms() {
    // Space-separated form.
    let spaced = safe_servicehub_stdout_line("spawn: servicehub --hub-token hunter2secret --port 9");
    assert!(!spaced.contains("hunter2secret"), "token must not survive: {spaced}");
    assert!(spaced.contains("--hub-token [redacted]"), "expected redaction: {spaced}");
    // The following unrelated flag must be preserved.
    assert!(spaced.contains("--port 9"), "later args must survive: {spaced}");

    // `=`-separated form.
    let eq = safe_servicehub_stdout_line("--hub-token=hunter2secret");
    assert!(!eq.contains("hunter2secret"), "token must not survive: {eq}");
    assert!(eq.contains("--hub-token=[redacted]"), "expected redaction: {eq}");
}

#[test]
fn ordinary_stderr_line_without_credentials_is_left_intact() {
    // No credential marker: the line must pass through unchanged (no false
    // positives that would maul ordinary business/traceback content).
    let line = "Traceback (most recent call last): KeyError: 'boot_id'";
    assert_eq!(safe_servicehub_stdout_line(line), line);
}

#[test]
fn credential_redaction_is_idempotent() {
    // Re-running the sanitizer on already-redacted output must not corrupt it.
    let once = safe_servicehub_stdout_line("--hub-token secret-xyz");
    let twice = safe_servicehub_stdout_line(&once);
    assert_eq!(once, twice);
    assert!(!twice.contains("secret-xyz"));
}


#[test]
fn handshake_failure_message_prefers_reuse_error_without_exposing_token() {
    let mut state = ServiceHubState::default();
    state.last_stdout = Some(
        concat!(
            "REUSE {\"error\":\"another ServiceHub is running but lockfile is missing\"}\n",
            "REUSE {\"port\":18830,\"token\":\"reuse-secret\"}\n",
        )
        .to_string(),
    );

    let message = compose_handshake_failed_message(&state);

    assert!(message.contains("lockfile is missing"));
    assert!(!message.contains("reuse-secret"));
}

#[test]
fn handshake_failure_message_prefers_captured_reuse_error_over_stderr() {
    let mut state = ServiceHubState::default();
    state.last_stdout = Some(
        "ServiceHub reuse error: another ServiceHub is running but lockfile is missing\n"
            .to_string(),
    );
    state.last_stderr = Some(
        "servicehub starting\nservicehub reuse handoff emitted\nServiceHub exited (code 0)."
            .to_string(),
    );

    let message = compose_handshake_failed_message(&state);

    assert!(message.contains("lockfile is missing"));
    assert!(!message.contains("reuse handoff emitted"));
}

#[test]
fn missing_lockfile_reuse_detection_uses_sanitized_stdout() {
    let mut state = ServiceHubState::default();
    state.last_stdout = Some(
        "ServiceHub reuse error: another ServiceHub is running but lockfile is missing\n"
            .to_string(),
    );

    assert!(missing_lockfile_reuse_detected(&state));

    state.last_stdout = Some("ServiceHub exited (code 0).".to_string());
    assert!(!missing_lockfile_reuse_detected(&state));
}

#[test]
fn tasklist_parser_returns_only_servicehub_process_candidates() {
    let output = concat!(
        "\"superclaw-services.exe\",\"21032\",\"Console\",\"1\",\"93,124 K\"\r\n",
        "\"servicehub.exe\",\"21033\",\"Console\",\"1\",\"93,124 K\"\r\n",
        "\"python.exe\",\"31415\",\"Console\",\"1\",\"42,000 K\"\r\n",
        "\"pythonw.exe\",\"27182\",\"Console\",\"1\",\"40,000 K\"\r\n",
        "\"notepad.exe\",\"99\",\"Console\",\"1\",\"10,000 K\"\r\n",
    );

    // The pre-rename image name stays a candidate: a Hub from an older build can
    // still be holding the singleton mutex, and it has to be reapable.
    assert_eq!(
        parse_servicehub_tasklist_candidates(output),
        vec![21032, 21033, 31415, 27182]
    );
}

#[test]
fn servicehub_command_line_ownership_requires_expected_layout() {
    assert!(servicehub_cmdline_is_ours(
        r#""C:\Program Files\Intel\SuperClaw\servicehub\superclaw-services.exe" --service servicehub --port 0"#
    ));
    assert!(servicehub_cmdline_is_ours(
        r#""C:\Program Files\Intel\SuperClaw\servicehub\servicehub.exe" --port 0"#
    ));
    assert!(servicehub_cmdline_is_ours(
        r#"C:\work\superclaw-dev\host\.venv\Scripts\python.exe -u -m servicehub --port 0"#
    ));
    assert!(servicehub_cmdline_is_ours(
        "/home/dev/superclaw/host/.venv/bin/python -u -m servicehub --port 0",
    ));
    assert!(!servicehub_cmdline_is_ours(
        r#""C:\OtherProduct\superclaw-services.exe" --port 0"#
    ));
    assert!(!servicehub_cmdline_is_ours(
        r#"python.exe -m servicehub --port 0"#
    ));
    assert!(!servicehub_cmdline_is_ours(
        "/tmp/superclaw/servicehub/superclaw-services.exe.bak --port 0",
    ));
    assert!(!servicehub_cmdline_is_ours(
        "grep /superclaw/servicehub/superclaw-services.exe /var/log/messages",
    ));
    assert!(!servicehub_cmdline_is_ours(
        "sh -c /opt/intel/superclaw/servicehub/superclaw-services.exe --port 0",
    ));
    assert!(!servicehub_cmdline_is_ours(
        "/tmp/superclaw-malware/python -m servicehub --port 0",
    ));
}

#[test]
fn servicehub_image_path_ownership_requires_exact_packaged_layout() {
    assert!(servicehub_image_path_is_ours(Path::new(
        r"C:\Program Files\Intel\SuperClaw\servicehub\superclaw-services.exe"
    )));
    assert!(servicehub_image_path_is_ours(Path::new(
        r"C:\Program Files\Intel\SuperClaw\servicehub\servicehub.exe"
    )));
    assert!(servicehub_image_path_is_ours(Path::new(
        "/opt/intel/SuperClaw/servicehub/superclaw-services.exe",
    )));
    assert!(!servicehub_image_path_is_ours(Path::new(
        r"C:\OtherProduct\servicehub\superclaw-services.exe"
    )));
    assert!(!servicehub_image_path_is_ours(Path::new(
        r"C:\Program Files\Intel\SuperClaw\servicehub\other.exe"
    )));
    assert!(!servicehub_image_path_is_ours(Path::new(
        "/tmp/superclaw/servicehub/servicehub.exe.bak",
    )));
}

#[test]
fn reuse_rejects_mismatched_lockfile_identity_before_readiness_probe() {
    let _lock = ENV_LOCK.get_or_init(|| StdMutex::new(())).lock().unwrap();
    let port = 18_830;
    let token = "expected-token";
    let pid = std::process::id();
    let tmp = std::env::temp_dir().join(format!("sh_reuse_identity_{}", pid));
    std::fs::create_dir_all(&tmp).unwrap();
    let _guard = EnvVarGuard::set("SERVICEHUB_DATA_DIR", &tmp.to_string_lossy());

    for (lock_port, lock_token, lock_pid) in [
        (port + 1, token, pid),
        (port, "different-token", pid),
        (port, token, pid.wrapping_add(1)),
    ] {
        std::fs::write(
            tmp.join("servicehub.lock"),
            serde_json::to_vec(&serde_json::json!({
                "port": lock_port,
                "token": lock_token,
                "pid": lock_pid,
            }))
            .unwrap(),
        )
        .unwrap();

        let status = reuse_handoff_identity_status(port, token, pid);
        assert_eq!(status, TcpListenerStatus::Unavailable);

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

    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn handshake_failure_message_includes_sanitized_stderr_detail() {
    let mut state = ServiceHubState::default();
    state.last_stderr =
        Some("Traceback\nRuntimeError: child port 18825 held by PID 16204\n".to_string());

    let message = compose_handshake_failed_message(&state);

    assert!(message.starts_with("ServiceHub process exited before sending handshake"));
    assert!(message.contains("child port 18825 held by PID 16204"));
}

#[test]
fn exit_status_append_preserves_existing_startup_error() {
    let combined = append_servicehub_exit_status(
        Some("RuntimeError: child startup failed".to_string()),
        Some(1),
    );

    assert!(combined.contains("RuntimeError: child startup failed"));
    assert!(combined.contains("ServiceHub exited (code 1)."));
}

// ── Child-service health summary formatting ────────────────────────

#[test]
fn format_child_health_line_includes_key_fields() {
    let service = serde_json::json!({
        "name": "sandbox_manager",
        "port": 18821,
        "state": "running",
        "healthy": true,
        "restart_attempts": 0,
        "instance_id": "abc123"
    });

    assert_eq!(
        format_child_health_line(&service),
        "OK name=sandbox_manager port=18821 state=running restart_attempts=0 instance_id=abc123"
    );
}

#[test]
fn format_child_health_line_marks_unhealthy_services() {
    let service = serde_json::json!({
        "name": "sandbox_manager",
        "port": 18821,
        "state": "error",
        "healthy": false,
        "restart_attempts": 2,
        "instance_id": "abc123"
    });

    assert_eq!(
        format_child_health_line(&service),
        "FAIL name=sandbox_manager port=18821 state=error restart_attempts=2 instance_id=abc123"
    );
}

#[test]
fn default_state_is_not_running() {
    let state = ServiceHubState::default();
    assert!(state.child.is_none());
    assert!(!state.child_exited);
    assert!(state.hub_port.is_none());
    assert!(state.hub_token.is_none());
    assert!(state.last_stdout.is_none());
    assert!(state.last_stderr.is_none());
    assert!(!state.boot_cancel.load(Ordering::SeqCst));
}

#[test]
fn snapshot_reports_not_running_when_no_child() {
    let mut state = ServiceHubState::default();
    let info = ServiceHubManager::snapshot_locked(&mut state);
    assert!(!info.running);
    assert!(info.pid.is_none());
    assert!(info.hub_port.is_none());
}

#[test]
fn snapshot_reflects_port_from_state() {
    let mut state = ServiceHubState::default();
    state.hub_port = Some(19000);
    let info = ServiceHubManager::snapshot_locked(&mut state);
    assert_eq!(info.hub_port, Some(19000));
}

#[test]
fn snapshot_reports_not_running_after_child_exited() {
    let mut state = ServiceHubState::default();
    state.child_exited = true;
    let info = ServiceHubManager::snapshot_locked(&mut state);
    assert!(!info.running);
}

#[test]
fn cancel_boot_signals_old_and_returns_fresh_token() {
    let mut state = ServiceHubState::default();
    let old_cancel = state.boot_cancel.clone();

    let new_token = ServiceHubManager::cancel_boot_and_new_token(&mut state);

    assert!(old_cancel.load(Ordering::SeqCst));
    assert!(!new_token.load(Ordering::SeqCst));
    assert!(Arc::ptr_eq(&state.boot_cancel, &new_token));
}

#[test]
fn stop_locked_clears_all_state() {
    let mut state = ServiceHubState::default();
    state.hub_port = Some(19000);
    state.hub_token = Some("secret".to_string());
    state.last_stdout = Some("output".to_string());
    state.last_stderr = Some("errors".to_string());
    state.child_exited = false;

    ServiceHubManager::stop_locked(&mut state);

    assert!(state.hub_port.is_none());
    assert!(state.hub_token.is_none());
    assert!(state.last_stdout.is_none());
    assert!(state.last_stderr.is_none());
    assert!(state.child_exited);
    assert!(state.boot_cancel.load(Ordering::SeqCst));
}

#[test]
fn stop_locked_drops_exited_handoff_child_without_kill() {
    let mut state = ServiceHubState::default();
    state.child_exited = true;

    ServiceHubManager::stop_locked(&mut state);

    assert!(state.child.is_none());
    assert!(state.child_exited);
}

// ── Negative: manager state ────────────────────────────────────────

#[test]
fn stop_locked_is_idempotent() {
    let mut state = ServiceHubState::default();
    ServiceHubManager::stop_locked(&mut state);
    ServiceHubManager::stop_locked(&mut state);
    assert!(state.child_exited);
}

#[test]
fn cancel_boot_twice_signals_both_tokens() {
    let mut state = ServiceHubState::default();
    let token1 = ServiceHubManager::cancel_boot_and_new_token(&mut state);
    let token2 = ServiceHubManager::cancel_boot_and_new_token(&mut state);

    assert!(token1.load(Ordering::SeqCst));
    assert!(!token2.load(Ordering::SeqCst));
}

// ── Launch target resolution ───────────────────────────────────────

#[test]
fn handshake_timeout_covers_cold_child_startup() {
    assert!(
        HANDSHAKE_TIMEOUT_SECS >= 300,
        "ServiceHub emits SERVICEHUB_READY only after child services pass readiness; cold frozen children need a wider startup budget"
    );
}

#[test]
fn resolve_finds_servicehub_from_cwd() {
    let cwd = std::env::current_dir().unwrap();
    let result = find_repo_servicehub_dir_from(cwd);
    if let Some(dir) = &result {
        assert!(dir.ends_with("servicehub") || dir.to_string_lossy().contains("servicehub"));
    }
}

#[test]
fn resolve_returns_none_for_nonexistent_dir() {
    let result = find_repo_servicehub_dir_from(std::path::PathBuf::from(r"C:\nonexistent"));
    assert!(result.is_none());
}

#[test]
fn python_launch_target_starts_configured_services() {
    let target = python_servicehub_target(
        // Build from path components so this parses on both Windows and Linux CI
        // runners; a `D:\...` backslash literal is a single component on Linux,
        // which makes `.parent()` empty and breaks the `cwd` assertions below.
        ["repo", "host", "servicehub"]
            .iter()
            .collect::<std::path::PathBuf>(),
        "test".to_string(),
        18864,
    );

    assert!(
        target.command == "uv"
            || target
                .command
                .to_ascii_lowercase()
                .ends_with(r"host\.venv\scripts\python.exe")
    );
    if target.command == "uv" {
        assert!(target
            .args
            .contains(&"servicehub/service_cfg.json".to_string()));
        assert!(target
            .args
            .windows(2)
            .any(|pair| pair == ["--port", "18864"]));
        assert!(target.cwd.ends_with("host"));
    } else {
        assert_eq!(target.args, vec!["-u", "-m", "servicehub", "--port", "18864"]);
        assert!(target.cwd.ends_with("host"));
        assert!(target.env.iter().any(|(k, v)| {
            *k == "SERVICEHUB_CFG" && v.ends_with(r"host\servicehub\service_cfg.json")
        }));
    }
    assert!(!target.args.contains(&"--no-spawn".to_string()));
}

#[test]
fn resolve_fails_with_bad_servicehub_exe_env() {
    let result = find_repo_servicehub_dir_from(std::path::PathBuf::from(r"Z:\nowhere\at\all"));
    assert!(result.is_none());
}

// ── Stale kept-alive Hub recovery: data dir + lockfile PID ──────────
//
// These tests mutate process-global env vars, so they serialize on a shared
// lock and restore the previous value on drop.

use std::sync::{Mutex as StdMutex, OnceLock};

static ENV_LOCK: OnceLock<StdMutex<()>> = OnceLock::new();

struct EnvVarGuard {
    key: &'static str,
    original: Option<String>,
}

impl EnvVarGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let original = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, original }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match &self.original {
            Some(v) => std::env::set_var(self.key, v),
            None => std::env::remove_var(self.key),
        }
    }
}

#[test]
fn resolve_servicehub_data_dir_prefers_explicit_env() {
    let _lock = ENV_LOCK.get_or_init(|| StdMutex::new(())).lock().unwrap();
    let expected = std::env::temp_dir().join(format!("sh_data_test_{}", std::process::id()));
    let _guard = EnvVarGuard::set("SERVICEHUB_DATA_DIR", &expected.to_string_lossy());
    assert_eq!(
        resolve_servicehub_lockfile_data_dir(),
        Some(expected)
    );
}

#[test]
fn resolve_servicehub_data_dir_resolves_relative_override_from_child_cwd() {
    let _lock = ENV_LOCK.get_or_init(|| StdMutex::new(())).lock().unwrap();
    let root = std::env::temp_dir().join(format!("sh_relative_data_test_{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let exe = root.join("servicehub.exe");
    std::fs::write(&exe, b"").unwrap();
    let _exe_guard = EnvVarGuard::set("SERVICEHUB_EXE", &exe.to_string_lossy());
    let relative_dir = std::path::PathBuf::from("relative-servicehub-data");
    let _data_guard = EnvVarGuard::set("SERVICEHUB_DATA_DIR", &relative_dir.to_string_lossy());

    assert_eq!(
        resolve_servicehub_lockfile_data_dir(),
        Some(root.join(relative_dir))
    );

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn resolve_servicehub_data_dir_falls_back_to_localappdata() {
    let _lock = ENV_LOCK.get_or_init(|| StdMutex::new(())).lock().unwrap();
    let _clear = EnvVarGuard::set("SERVICEHUB_DATA_DIR", ""); // empty => ignored
    let _local = EnvVarGuard::set("LOCALAPPDATA", r"C:\Users\dev\AppData\Local");
    assert_eq!(
        resolve_servicehub_lockfile_data_dir(),
        Some(
            std::path::PathBuf::from(r"C:\Users\dev\AppData\Local")
                .join("SuperClaw")
                .join("servicehub")
        )
    );
}

#[test]
fn resolve_servicehub_data_dir_falls_back_to_home_local_share() {
    let _lock = ENV_LOCK.get_or_init(|| StdMutex::new(())).lock().unwrap();
    let _clear_data = EnvVarGuard::set("SERVICEHUB_DATA_DIR", "");
    let _clear_local = EnvVarGuard::set("LOCALAPPDATA", "");
    let _home = EnvVarGuard::set("HOME", r"/home/dev");
    assert_eq!(
        resolve_servicehub_lockfile_data_dir(),
        Some(
            std::path::PathBuf::from(r"/home/dev")
                .join(".local")
                .join("share")
                .join("SuperClaw")
                .join("servicehub")
        )
    );
}

#[test]
fn read_servicehub_lockfile_pid_parses_pid() {
    let _lock = ENV_LOCK.get_or_init(|| StdMutex::new(())).lock().unwrap();
    let tmp = std::env::temp_dir().join(format!("sh_lock_test_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(
        tmp.join("servicehub.lock"),
        r#"{"pid":4242,"port":18830,"token":"t"}"#,
    )
    .unwrap();
    let _guard = EnvVarGuard::set("SERVICEHUB_DATA_DIR", &tmp.to_string_lossy());

    assert_eq!(read_servicehub_lockfile_pid(), Some(4242));

    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn read_servicehub_lockfile_pid_none_when_missing() {
    let _lock = ENV_LOCK.get_or_init(|| StdMutex::new(())).lock().unwrap();
    let tmp = std::env::temp_dir().join(format!("sh_lock_missing_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    // No lockfile written.
    let _guard = EnvVarGuard::set("SERVICEHUB_DATA_DIR", &tmp.to_string_lossy());

    assert_eq!(read_servicehub_lockfile_pid(), None);

    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn read_servicehub_lockfile_pid_none_on_malformed_json() {
    let _lock = ENV_LOCK.get_or_init(|| StdMutex::new(())).lock().unwrap();
    let tmp = std::env::temp_dir().join(format!("sh_lock_bad_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(tmp.join("servicehub.lock"), "not json at all").unwrap();
    let _guard = EnvVarGuard::set("SERVICEHUB_DATA_DIR", &tmp.to_string_lossy());

    assert_eq!(read_servicehub_lockfile_pid(), None);

    std::fs::remove_dir_all(&tmp).ok();
}

// ── Stale-REUSE restart limiter ────────────────────────────────────

/// Serialize limiter tests: they share the process-global attempt counter.
static LIMITER_LOCK: OnceLock<StdMutex<()>> = OnceLock::new();

fn reset_stale_reuse_limiter() {
    reset_stale_reuse_restart_budget();
}

#[test]
fn stale_reuse_allows_up_to_max_then_blocks() {
    let _lock = LIMITER_LOCK
        .get_or_init(|| StdMutex::new(()))
        .lock()
        .unwrap();
    reset_stale_reuse_limiter();

    // First MAX_STALE_REUSE_RESTARTS attempts within the window are allowed.
    for i in 1..=MAX_STALE_REUSE_RESTARTS {
        assert!(
            stale_reuse_restart_allowed(),
            "attempt {i} should be allowed"
        );
    }
    // The next one exceeds the budget.
    assert!(
        !stale_reuse_restart_allowed(),
        "attempt beyond max must be blocked"
    );
}

#[test]
fn stale_reuse_budget_resets_after_successful_convergence() {
    let _lock = LIMITER_LOCK
        .get_or_init(|| StdMutex::new(()))
        .lock()
        .unwrap();
    reset_stale_reuse_limiter();

    // Exhaust the budget.
    for _ in 0..MAX_STALE_REUSE_RESTARTS {
        assert!(stale_reuse_restart_allowed());
    }
    assert!(!stale_reuse_restart_allowed());

    reset_stale_reuse_restart_budget();
    assert!(
        stale_reuse_restart_allowed(),
        "successful convergence must reset the consecutive-attempt budget"
    );
}

// ── PID-reuse safety on non-Windows ────────────────────────────────

#[cfg(not(target_os = "windows"))]
#[test]
fn servicehub_pid_is_ours_fails_closed_for_missing_process() {
    // No process with this PID => cannot read cmdline => decline kill.
    assert!(!servicehub_pid_is_ours(4_242_424_242));
}

#[test]
fn local_tcp_port_probe_reflects_listener() {
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    assert!(local_tcp_port_accepting_connections(port));
    drop(listener);
    assert!(!local_tcp_port_accepting_connections(port));
}

// -- Reuse child-health classification via /app/readiness --------------------
//
// `readiness::classify_app_readiness` is the pure decision that drives whether a
// REUSE handoff attaches as-is, triggers an in-Hub restart, or falls through to
// the heavy kill + cold-restart self-heal. It replaced a `/app/services/health`
// classification that could not distinguish "process is running" from "serving
// its contract". Only required host_service components decide the verdict,
// because the verdict restarts Hub children and nothing else.

fn readiness_payload(components: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "contract_version": 1,
        "state": "ready",
        "retry_after_ms": null,
        "observed_at": "2026-08-31T10:00:00Z",
        "components": components,
    })
}

fn host_component(name: &str, state: &str, instance_id: &str) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "kind": "host_service",
        "startup": "required",
        "state": state,
        "instance_id": instance_id,
        "reason_code": null,
        "observed_at": null,
        "last_transition_at": null,
        "applied_revision": null,
        "active_revision": null,
    })
}

#[test]
fn classify_app_readiness_all_required_ready() {
    let payload = readiness_payload(serde_json::json!([
        host_component("llmrouter_manager", "ready", "lrm-instance"),
        host_component("sandbox_manager", "ready", "sandbox-instance"),
    ]));
    assert_eq!(
        readiness::classify_app_readiness(&payload),
        ChildHealthVerdict::AllHealthy
    );
}

// The stale data-plane case: a child stopped honoring its contract while the Hub
// was kept alive.
#[test]
fn classify_app_readiness_one_required_not_ready() {
    let payload = readiness_payload(serde_json::json!([
        host_component("llmrouter_manager", "ready", "lrm-instance"),
        host_component("sandbox_manager", "failed", "sandbox-instance"),
    ]));
    assert_eq!(
        readiness::classify_app_readiness(&payload),
        ChildHealthVerdict::SomeUnhealthy
    );
}

// `unknown` means evidence could not be established, which is not proof of health.
#[test]
fn classify_app_readiness_unknown_component_is_some_unhealthy() {
    let payload = readiness_payload(serde_json::json!([host_component(
        "sandbox_manager",
        "unknown",
        "sandbox-instance"
    )]));
    assert_eq!(
        readiness::classify_app_readiness(&payload),
        ChildHealthVerdict::SomeUnhealthy
    );
}

// A dormant or broken on-demand feature must never trigger a child restart.
#[test]
fn classify_app_readiness_ignores_on_demand_components() {
    let mut dormant = host_component("tts_manager", "dormant", "");
    dormant["startup"] = serde_json::json!("on_demand");
    dormant["instance_id"] = serde_json::Value::Null;
    let mut failed_optional = host_component("vision_manager", "failed", "");
    failed_optional["startup"] = serde_json::json!("on_demand");
    failed_optional["instance_id"] = serde_json::Value::Null;

    let payload = readiness_payload(serde_json::json!([
        host_component("sandbox_manager", "ready", "sandbox-instance"),
        dormant,
        failed_optional,
    ]));

    assert_eq!(
        readiness::classify_app_readiness(&payload),
        ChildHealthVerdict::AllHealthy
    );
}

// Runtime components are real, but restarting Hub children does not repair a
// stalled container or a wedged OpenCode, so they must not drive this verdict.
#[test]
fn classify_app_readiness_ignores_runtime_components() {
    let mut runtime = host_component("opencode_engine", "failed", "");
    runtime["kind"] = serde_json::json!("runtime");
    runtime["instance_id"] = serde_json::Value::Null;

    let payload = readiness_payload(serde_json::json!([
        host_component("sandbox_manager", "ready", "sandbox-instance"),
        runtime,
    ]));

    assert_eq!(
        readiness::classify_app_readiness(&payload),
        ChildHealthVerdict::AllHealthy
    );
}

// A healthy Hub always has its required children registered, so their absence
// means no meaningful snapshot was read.
#[test]
fn classify_app_readiness_without_required_host_services_is_unknown() {
    let payload = readiness_payload(serde_json::json!([]));
    assert_eq!(
        readiness::classify_app_readiness(&payload),
        ChildHealthVerdict::Unknown
    );
}

#[test]
fn classify_app_readiness_malformed_is_unknown() {
    for payload in [
        serde_json::json!({ "state": "ready" }),
        serde_json::json!({ "components": "nope" }),
        serde_json::json!({ "foo": "bar" }),
    ] {
        assert_eq!(
            readiness::classify_app_readiness(&payload),
            ChildHealthVerdict::Unknown
        );
    }
}

// -- Direct-probe target joining (readiness state + catalog addressing) -------
//
// Readiness alone cannot address a child: `proxy_prefix` lives in the catalog,
// which `ADDING_A_SERVICE.md` designates as the discovery surface. The direct
// probe is a trust check on the Hub itself, so an unjoinable pair degrades to
// `None` rather than probing a subset.

fn catalog_payload() -> serde_json::Value {
    serde_json::json!({
        "services": [
            { "name": "llmrouter_manager", "proxy_prefix": "/llm-router", "startup": "required", "state": "running" },
            { "name": "sandbox_manager", "proxy_prefix": "/sandbox-manager", "startup": "required", "state": "running" },
            { "name": "tts_manager", "proxy_prefix": "/tts-narration", "startup": "on_demand", "state": "dormant" }
        ]
    })
}

#[test]
fn child_health_targets_from_joins_readiness_and_catalog() {
    let readiness_doc = readiness_payload(serde_json::json!([
        host_component("llmrouter_manager", "ready", "lrm-instance"),
        host_component("sandbox_manager", "ready", "sandbox-instance"),
    ]));

    assert_eq!(
        readiness::child_health_targets_from(&readiness_doc, &catalog_payload()),
        Some(vec![
            ChildHealthTarget {
                name: "llmrouter_manager".to_string(),
                proxy_prefix: "/llm-router".to_string(),
                instance_id: "lrm-instance".to_string(),
            },
            ChildHealthTarget {
                name: "sandbox_manager".to_string(),
                proxy_prefix: "/sandbox-manager".to_string(),
                instance_id: "sandbox-instance".to_string(),
            },
        ])
    );
}

#[test]
fn child_health_targets_from_rejects_missing_or_empty_instance_id() {
    let missing = readiness_payload(serde_json::json!([{
        "name": "llmrouter_manager",
        "kind": "host_service",
        "startup": "required",
        "state": "ready",
        "instance_id": null,
        "reason_code": null,
        "observed_at": null,
        "last_transition_at": null,
        "applied_revision": null,
        "active_revision": null,
    }]));
    let empty = readiness_payload(serde_json::json!([host_component(
        "llmrouter_manager",
        "ready",
        ""
    )]));

    assert_eq!(
        readiness::child_health_targets_from(&missing, &catalog_payload()),
        None
    );
    assert_eq!(
        readiness::child_health_targets_from(&empty, &catalog_payload()),
        None
    );
}

#[test]
fn child_health_targets_from_rejects_child_absent_from_catalog() {
    let readiness_doc = readiness_payload(serde_json::json!([host_component(
        "ghost_manager",
        "ready",
        "ghost-instance"
    )]));

    assert_eq!(
        readiness::child_health_targets_from(&readiness_doc, &catalog_payload()),
        None
    );
}

#[test]
fn child_health_targets_from_rejects_root_or_empty_proxy_prefix() {
    let readiness_doc = readiness_payload(serde_json::json!([host_component(
        "llmrouter_manager",
        "ready",
        "lrm-instance"
    )]));
    for prefix in ["/", "", "llm-router"] {
        let catalog = serde_json::json!({
            "services": [ { "name": "llmrouter_manager", "proxy_prefix": prefix } ]
        });
        assert_eq!(
            readiness::child_health_targets_from(&readiness_doc, &catalog),
            None
        );
    }
}

#[test]
fn child_health_targets_from_skips_on_demand_children() {
    let mut dormant = host_component("tts_manager", "dormant", "");
    dormant["startup"] = serde_json::json!("on_demand");
    dormant["instance_id"] = serde_json::Value::Null;
    let readiness_doc = readiness_payload(serde_json::json!([
        host_component("sandbox_manager", "ready", "sandbox-instance"),
        dormant,
    ]));

    let targets =
        readiness::child_health_targets_from(&readiness_doc, &catalog_payload()).expect("targets");

    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].name, "sandbox_manager");
}

#[test]
fn format_readiness_blockers_names_only_required_non_ready() {
    let mut dormant = host_component("tts_manager", "failed", "");
    dormant["startup"] = serde_json::json!("on_demand");
    let mut stale = host_component("opencode_engine", "unknown", "");
    stale["kind"] = serde_json::json!("runtime");
    stale["reason_code"] = serde_json::json!("evidence_stale");

    let payload = readiness_payload(serde_json::json!([
        host_component("sandbox_manager", "ready", "sandbox-instance"),
        dormant,
        stale,
    ]));

    let rendered = readiness::format_readiness_blockers(&payload);

    assert!(rendered.contains("opencode_engine=unknown/evidence_stale"), "{rendered}");
    assert!(!rendered.contains("tts_manager"), "{rendered}");
    assert!(!rendered.contains("sandbox_manager"), "{rendered}");
}

#[test]
fn format_readiness_blockers_is_empty_when_all_required_ready() {
    let payload = readiness_payload(serde_json::json!([host_component(
        "sandbox_manager",
        "ready",
        "sandbox-instance"
    )]));

    assert_eq!(readiness::format_readiness_blockers(&payload), "");
}

#[test]
fn direct_child_health_matches_expected_service_and_instance() {
    let target = ChildHealthTarget {
        name: "llmrouter_manager".to_string(),
        proxy_prefix: "/llm-router".to_string(),
        instance_id: "expected-instance".to_string(),
    };
    let payload = serde_json::json!({
        "service": "llmrouter_manager",
        "status": "ok",
        "pid": 1234,
        "instance_id": "expected-instance"
    });

    assert!(direct_child_health_matches(&target, &payload));
}

#[test]
fn direct_child_health_rejects_stale_or_wrong_instance() {
    let target = ChildHealthTarget {
        name: "llmrouter_manager".to_string(),
        proxy_prefix: "/llm-router".to_string(),
        instance_id: "expected-instance".to_string(),
    };
    let payload = serde_json::json!({
        "service": "llmrouter_manager",
        "status": "ok",
        "pid": 1234,
        "instance_id": "old-instance"
    });

    assert!(!direct_child_health_matches(&target, &payload));
}

#[test]
fn direct_child_health_rejects_wrong_service_or_bad_status() {
    let target = ChildHealthTarget {
        name: "llmrouter_manager".to_string(),
        proxy_prefix: "/llm-router".to_string(),
        instance_id: "".to_string(),
    };
    assert!(!direct_child_health_matches(
        &target,
        &serde_json::json!({ "service": "sandbox_manager", "status": "ok" })
    ));
    assert!(!direct_child_health_matches(
        &target,
        &serde_json::json!({ "service": "llmrouter_manager", "status": "error" })
    ));
}

#[test]
fn hub_operation_id_extracts_restart_operation_id() {
    let payload = serde_json::json!({
        "operation_id": "hub:restart_1",
        "kind": "restart",
        "state": "running"
    });
    assert_eq!(
        hub_operation_id(&payload),
        Some("hub:restart_1".to_string())
    );
}

#[test]
fn hub_operation_id_ignores_missing_or_empty_id() {
    assert_eq!(
        hub_operation_id(&serde_json::json!({ "state": "running" })),
        None
    );
    assert_eq!(
        hub_operation_id(&serde_json::json!({ "operation_id": "" })),
        None
    );
}

#[test]
fn self_heal_decision_allows_unknown_before_restart_attempt() {
    assert!(!should_self_heal_after_child_probe(
        false,
        ChildHealthVerdict::Unknown
    ));
}

#[test]
fn self_heal_decision_requires_all_healthy_after_restart_attempt() {
    assert!(!should_self_heal_after_child_probe(
        true,
        ChildHealthVerdict::AllHealthy
    ));
    assert!(should_self_heal_after_child_probe(
        true,
        ChildHealthVerdict::Unknown
    ));
    assert!(should_self_heal_after_child_probe(
        true,
        ChildHealthVerdict::SomeUnhealthy
    ));
}

#[test]
fn reuse_restart_decision_restarts_when_child_health_unknown() {
    // Startup should fail closed: if a reused Hub cannot prove child health,
    // try the lightweight child restart before attaching. This avoids accepting
    // stale registry state after an abnormal child exit.
    assert!(should_restart_children_on_reuse(
        ChildHealthVerdict::Unknown
    ));
}

#[test]
fn reuse_restart_decision_restarts_when_child_unhealthy_only() {
    assert!(should_restart_children_on_reuse(
        ChildHealthVerdict::SomeUnhealthy
    ));
    assert!(!should_restart_children_on_reuse(
        ChildHealthVerdict::AllHealthy
    ));
}

// ── Lockfile-deletion race fix (Suggestion 2) ──────────────────────
//
// `lockfile_action_after_kill` encodes the fix: delete servicehub.lock ONLY when
// the stale Hub PID was actually killed. When the kill was declined (no PID, or
// an unverifiable PID we refused to touch), keep the lockfile so the next REUSE
// still finds valid {port,token} metadata instead of racing into a
// "lockfile missing" error while the old Hub may still hold the mutex.

// Positive path: kill succeeded → the lockfile is now orphaned → Delete.
#[test]
fn lockfile_action_deletes_when_killed() {
    assert_eq!(lockfile_action_after_kill(true), LockfileAction::Delete);
}

// Negative path (the actual bug fix): kill did NOT happen → Keep the lockfile.
#[test]
fn lockfile_action_keeps_when_not_killed() {
    assert_eq!(lockfile_action_after_kill(false), LockfileAction::Keep);
}

// The two outcomes must be distinct (guards against a regression that collapses
// both branches back to unconditional deletion — the pre-fix behavior).
#[test]
fn lockfile_action_distinguishes_kill_outcomes() {
    assert_ne!(
        lockfile_action_after_kill(true),
        lockfile_action_after_kill(false),
        "killed vs not-killed must map to different lockfile actions"
    );
}

// ── Data-plane active provisioning on reuse ────────────────────────
//
// `should_provision_sandbox` decides whether the reuse data-plane wait actively
// POSTs the (idempotent) provisions endpoint. This is the fix for the observed
// bug: when the sandbox stops under a kept-alive backend, the reused
// sandbox_manager reports children healthy but the SANDBOX is `phase=stopped`,
// and nothing restarts it, so a
// passive poll times out. Phases come from `GET .../agent/sandbox`.

// Positive: phases that will NOT recover on their own must trigger a provision.
#[test]
fn should_provision_when_sandbox_stopped() {
    // The exact phase from the failing test log.
    assert!(should_provision_sandbox("stopped"));
}

#[test]
fn should_provision_when_sandbox_error() {
    assert!(should_provision_sandbox("error"));
}

#[test]
fn should_provision_when_sandbox_missing() {
    assert!(should_provision_sandbox("missing"));
}

// Negative: `running` never needs a kick (the poll loop breaks on it anyway).
#[test]
fn should_not_provision_when_sandbox_running() {
    assert!(!should_provision_sandbox("running"));
}

// Negative: transient in-progress phases already have an ensure/provision in
// flight — kicking again would be wasteful and could interleave operations.
#[test]
fn should_not_provision_when_sandbox_starting() {
    assert!(!should_provision_sandbox("starting"));
}

#[test]
fn should_not_provision_when_sandbox_installing() {
    assert!(!should_provision_sandbox("installing"));
}

// Negative: an unknown/empty phase is handled conservatively (no provision) —
// the poll timeout still bounds the wait, and we avoid hammering provisions on a
// phase we don't understand.
#[test]
fn should_not_provision_on_unknown_phase() {
    assert!(!should_provision_sandbox(""));
    assert!(!should_provision_sandbox("some_future_phase"));
}

// Stopping a kept-alive Hub reaps the lockfile pid right after killing it; a held
// handle keeps the exited process openable, which must not read as still running.
#[cfg(target_os = "windows")]
#[test]
fn lockfile_pid_is_not_running_once_exited_even_while_a_handle_is_held() {
    let mut child = std::process::Command::new("cmd")
        .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
        .spawn()
        .expect("spawn");
    let pid = child.id();
    assert!(lockfile_pid_process_is_running(pid));
    child.kill().expect("kill");
    child.wait().expect("wait");
    assert!(!lockfile_pid_process_is_running(pid));
    drop(child);
}
