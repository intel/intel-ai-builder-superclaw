//! Manual, unelevated diagnostic only; never an installed-launch or security assertion.
//! Stage a fresh 32-lowercase-hex directory under the owner's LOCALAPPDATA + BASE.
//! input.json selects only closed scratch/generation cases; all paths are derived here.
//! Uses the existing token-data smoke payload and staged standard Profile as fixed inputs.
//! No ACL repair, credential export, configurable argv, or production catalog entry exists here.
//! Staging must be quiescent: path checks reject reparses, not hostile same-account rename races.
//! Owner unwinding drops its runner guard; abrupt owner death does NOT signal product control EOF.
//! In that case the runner's own timeout is the fallback, NOT equivalent lifecycle evidence.

use crate::credential_read::{credential_path, read_credential_for_owner};
use crate::job::{Job, JobLimitProfile};
use crate::launcher::logon::{LogonAttemptError, TierLogonSpec, spawn_with_logon};
use crate::managed_root_path::{verify_handle_is_path, verify_managed_path_chain};
use crate::process_same_account::{RoleStdio, SameAccountSpawn, spawn_same_account};
use crate::role_log::{LaunchId, RoleLogTarget};
use crate::sid_win32::{current_process_sid, local_user_account_sid, token_sid_for_owned_process};
use crate::{IsolationTier, identity_name, secrets, state, zeroize::ZeroizedWide};
use serde::Deserialize;
use serde_json::{Value, json};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::windows::{fs::MetadataExt, fs::OpenOptionsExt, io::AsRawHandle};
use std::path::{Path, PathBuf};
use std::time::Duration;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
};

const BASE: &str = r"SuperClaw\backend\tmp\broker-start\bootstrap\rename-probe";
const HARNESS: &str = "rename-probe-tests.exe";
const WORKER: &str = "rename-probe-worker.exe";
const ROOT_ENV: &str = "SC_RENAME_PROBE_ROOT";
const SID_ENV: &str = "SC_RENAME_PROBE_EXPECTED_SID";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    case_root: String,
    scratch: Scratch,
    #[serde(default)]
    generation: Generation,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Scratch {
    Fixed,
    Fresh,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Generation {
    #[default]
    Scratch,
    Config,
}

fn generation_root(root: &Path, generation: &Generation) -> io::Result<PathBuf> {
    match generation {
        Generation::Scratch => Ok(root.join("case")),
        Generation::Config => {
            let id = root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            LaunchId::from_pipe_id(id)?;
            Ok(backend(root)?
                .join("config/bootstrap/runtime-generations")
                .join(format!("rename-probe-{id}")))
        }
    }
}

#[test]
fn diagnostic_generation_paths_are_closed_and_separate() {
    let id = "0123456789abcdef0123456789abcdef";
    let base = PathBuf::from(r"C:\Users\owner\AppData\Local\SuperClaw\backend");
    let root = base
        .join("tmp/broker-start/bootstrap/rename-probe")
        .join(id);
    assert_eq!(
        generation_root(&root, &Generation::Scratch).unwrap(),
        root.join("case")
    );
    assert_eq!(
        generation_root(&root, &Generation::Config).unwrap(),
        base.join("config/bootstrap/runtime-generations")
            .join(format!("rename-probe-{id}"))
    );
    assert!(
        serde_json::from_str::<Input>(
            r#"{"case_root":"case","scratch":"fixed","generation":"C:\\other"}"#
        )
        .is_err()
    );
    assert!(
        serde_json::from_str::<Input>(
            r#"{"case_root":"case","scratch":"fixed","generation":"config","path":"other"}"#
        )
        .is_err()
    );
}

fn require(ok: bool, message: &'static str) -> io::Result<()> {
    if ok {
        Ok(())
    } else {
        Err(io::Error::other(message))
    }
}

fn env(name: &str) -> io::Result<String> {
    std::env::var(name).map_err(|_| io::Error::other("required diagnostic environment missing"))
}

fn text(path: &Path) -> io::Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| io::Error::other("non-Unicode path"))
}

fn root() -> io::Result<(PathBuf, LaunchId)> {
    let root = PathBuf::from(env(ROOT_ENV)?);
    let spelling = text(&root)?;
    require(
        crate::launch_catalog::canonicalize_local_windows_path(&spelling).is_ok(),
        "invalid root",
    )?;
    require(
        root.parent().is_some_and(|p| p.ends_with(BASE)),
        "root outside diagnostic layout",
    )?;
    let id = LaunchId::from_pipe_id(root.file_name().and_then(|n| n.to_str()).unwrap_or(""))?;
    crate::managed_root_path::validate_managed_path_shape(&root)?;
    require(
        fs::symlink_metadata(&root)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        "root reparse refused",
    )?;
    require(root.is_dir(), "root is not a directory")?;
    Ok((root, id))
}

fn backend(root: &Path) -> io::Result<&Path> {
    root.ancestors()
        .nth(5)
        .ok_or_else(|| io::Error::other("diagnostic layout incomplete"))
}

// Walk staged inputs only, before starting anything. Never retain directory handles across rename.
fn check_tree(path: &Path, budget: &mut usize) -> io::Result<()> {
    require(*budget > 0, "staged tree exceeds 20000 objects")?;
    *budget -= 1;
    let metadata = fs::symlink_metadata(path)?;
    require(
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        "reparse refused",
    )?;
    require(
        metadata.is_dir() || metadata.is_file(),
        "not a plain file or directory",
    )?;
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            check_tree(&entry?.path(), budget)?;
        }
    }
    Ok(())
}

fn read_json(path: &Path) -> io::Result<Value> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    verify_handle_is_path(file.as_raw_handle(), path)?;
    require(file.metadata()?.is_file(), "JSON must be a file")?;
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    require(bytes.len() <= 4096, "JSON exceeds size bound")?;
    serde_json::from_slice(&bytes).map_err(|_| io::Error::other("invalid diagnostic JSON"))
}

fn validate_inputs(root: &Path) -> io::Result<()> {
    check_tree(root, &mut 20_000)?;
    let input: Input = serde_json::from_value(read_json(&root.join("input.json"))?)
        .map_err(|_| io::Error::other("input schema mismatch"))?;
    require(input.case_root == "case", "case_root must be case")?;
    for dir in ["case", "temp"] {
        require(root.join(dir).is_dir(), "required staged directory missing")?;
    }
    require(root.join(WORKER).is_file(), "fixed worker missing")
}

fn new_file(root: &Path, name: &str) -> io::Result<File> {
    let path = root.join(name);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&path)?;
    verify_handle_is_path(file.as_raw_handle(), &path)?;
    Ok(file)
}

// Never serialize error strings or input values: failures carry only kind and OS code.
fn error_value(error: &io::Error) -> Value {
    json!({"kind": format!("{:?}", error.kind()), "os_code": error.raw_os_error()})
}

fn finish(mut file: File, mut report: Value, result: io::Result<()>) -> io::Result<()> {
    report["ok"] = json!(result.is_ok());
    if let Err(error) = &result {
        report["error"] = error_value(error);
    }
    serde_json::to_writer(&mut file, &report)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    result
}

fn runner_environment(root: &Path, sid: &str) -> io::Result<Vec<(String, String)>> {
    // Deliberately no owner PATH, profile, secrets, Bun options, or arbitrary input overlay.
    let system = PathBuf::from(env("SYSTEMROOT")?);
    verify_managed_path_chain(&system)?;
    Ok(vec![
        ("SYSTEMROOT".into(), text(&system)?),
        ("WINDIR".into(), text(&system)?),
        ("PATH".into(), text(&system.join("System32"))?),
        ("TEMP".into(), text(&root.join("temp"))?),
        ("TMP".into(), text(&root.join("temp"))?),
        (ROOT_ENV.into(), text(root)?),
        (SID_ENV.into(), sid.into()),
    ])
}

#[test]
#[ignore = "manual owner staging and already-provisioned bootstrap account required"]
fn owner_driver() -> io::Result<()> {
    let (root, id) = root()?;
    let expected_root = PathBuf::from(env("LOCALAPPDATA")?)
        .join(BASE)
        .join(id.as_str());
    require(
        root == expected_root,
        "root is not under this owner's LOCALAPPDATA",
    )?;
    verify_managed_path_chain(&root)?;
    validate_inputs(&root)?;
    require(
        fs::read_dir(root.join("case"))?.next().is_none(),
        "case directory must be empty",
    )?;
    let input: Input = serde_json::from_value(read_json(&root.join("input.json"))?)
        .map_err(|_| io::Error::other("input schema mismatch"))?;
    if matches!(input.generation, Generation::Config) {
        let destination = generation_root(&root, &input.generation)?;
        let parent = destination
            .parent()
            .ok_or_else(|| io::Error::other("missing parent"))?;
        verify_managed_path_chain(parent)?;
        require(parent.is_dir(), "existing config generation root required")?;
        require(
            !destination.try_exists()?,
            "diagnostic config case already exists",
        )?;
    }
    let report_file = new_file(&root, "owner-report.json")?;
    let mut report =
        json!({"scope":"diagnostic_only", "runner_sid_verified":false, "stage":"stage_harness"});
    let result = (|| {
        let harness = root.join(HARNESS);
        let mut destination = new_file(&root, HARNESS)?;
        io::copy(&mut File::open(std::env::current_exe()?)?, &mut destination)?;
        destination.sync_all()?;
        drop(destination);
        verify_managed_path_chain(&harness)?;
        report["stage"] = json!("derive_identity");
        let owner_sid = current_process_sid()?;
        let account = identity_name::account_name_for(&owner_sid, IsolationTier::Bootstrap);
        let sid = local_user_account_sid(&account)?;
        let environment = runner_environment(&root, &sid)?;
        let command = format!(
            "\"{}\" --ignored --exact rename_probe_tests::tier_runner --nocapture",
            text(&harness)?
        );
        require(
            crate::launcher::logon::TIER_LOGON_FLAGS == 0,
            "logon flags changed",
        )?;
        let credential = credential_path(&state::default_state_dir()?, &account);
        report["stage"] = json!("credential_read_verify_unprotect");
        let blob = read_credential_for_owner(&credential, &owner_sid)?;
        let decrypted = secrets::unprotect_zeroized(&blob)?;
        let password = ZeroizedWide::from_utf8(decrypted.as_slice())?;
        drop(decrypted);
        drop(blob);
        let outcome = spawn_with_logon(&TierLogonSpec {
            account_name: &account,
            password: &password,
            executable: &harness,
            command: &command,
            environment: &environment,
        });
        drop(password); // Before inspecting success OR failure; no credential-derived formatting.
        report["stage"] = json!("logon");
        let mut runner = outcome.map_err(|error| match error {
            LogonAttemptError::Preparation(error) => error,
            LogonAttemptError::Logon(code) => io::Error::from_raw_os_error(code as i32),
        })?;
        require(
            token_sid_for_owned_process(runner.process())? == sid,
            "runner SID mismatch",
        )?;
        report["runner_sid_verified"] = json!(true);
        report["runner_pid"] = json!(runner.pid());
        // The first hop creates the runner suspended for the owner's Job; this probe adopts none.
        runner.resume()?;
        report["stage"] = json!("wait_runner");
        let exit = runner.wait(Duration::from_secs(150))?;
        report["runner_exit_code"] = json!(exit);
        require(exit == 0, "runner failed")?;
        let tier_report = read_json(&root.join("runner-report.json"))?;
        require(
            tier_report["ok"] == true
                && tier_report["job_active_after_cleanup"] == 0
                && tier_report["worker_exit_code"] == 0
                && tier_report["job_membership_verified_before_resume"] == true,
            "runner report absent or unsuccessful",
        )?;
        report["stage"] = json!("complete");
        Ok(())
        // `runner` is retained through SID verification, wait, and report inspection.
    })();
    finish(report_file, report, result)
}

#[test]
#[ignore = "only owner_driver's fixed cross-account invocation may run this diagnostic"]
fn tier_runner() -> io::Result<()> {
    let (root, id) = root()?;
    require(
        current_process_sid()? == env(SID_ENV)?,
        "current SID differs from expected bootstrap SID",
    )?;
    require(
        std::env::current_exe()? == root.join(HARNESS),
        "runner must be the staged harness",
    )?;
    validate_inputs(&root)?;
    let report_file = new_file(&root, "runner-report.json")?;
    let mut report = json!({"scope":"diagnostic_only", "sid_verified":true, "stage":"create_job"});
    let result = (|| {
        let job = Job::create(JobLimitProfile::BootstrapTier)?;
        // Even a launch/wait error must go through explicit Job terminate + accounting drain.
        let work = (|| {
            report["stage"] = json!("create_log");
            let log_target = RoleLogTarget::new(&root, &id);
            let log = log_target.create_for_role()?;
            verify_handle_is_path(log.raw(), log_target.path())?;
            let worker = root.join(WORKER);
            let command = format!("\"{}\"", text(&worker)?); // Fixed compiled Bun worker, NO argv.
            let input: Input = serde_json::from_value(read_json(&root.join("input.json"))?)
                .map_err(|_| io::Error::other("input schema mismatch"))?;
            let generation = generation_root(&root, &input.generation)?;
            if matches!(input.generation, Generation::Config) {
                report["stage"] = json!("create_config_case");
                // Created by bootstrap so inherited rights and ownership match its product writes.
                // create_dir refuses an existing object; never reuse or remove a product generation.
                fs::create_dir(&generation)?;
            }
            let scratch = match input.scratch {
                Scratch::Fixed => backend(&root)?.join("tmp/broker-start/bootstrap"),
                Scratch::Fresh => root.join("temp"),
            };
            let environment = vec![
                ("ROOT".into(), text(&generation)?),
                (
                    "CONFIG_SOURCE".into(),
                    text(
                        &backend(&root)?.join("payload/p7-token-data-smoke-20260916/config-source"),
                    )?,
                ),
                (
                    "PRODUCT_PROFILES_SOURCE".into(),
                    text(&backend(&root)?.join("config/bootstrap/product-profiles"))?,
                ),
                ("TEMP".into(), text(&scratch)?),
                ("TMP".into(), text(&scratch)?),
            ];
            report["stage"] = json!("spawn_worker");
            let mut child = spawn_same_account(SameAccountSpawn {
                executable: &worker,
                command: &command,
                current_directory: &scratch,
                declared_environment: &environment,
                job: Some(&job),
                stdio: RoleStdio::SharedLog(log),
            })?;
            drop(child.take_stdin_writer()?); // No stdin payload; stdout/stderr go directly to log.
            report["job_membership_verified_before_resume"] =
                json!(child.job_membership_verified_before_resume());
            require(
                token_sid_for_owned_process(child.process())? == env(SID_ENV)?,
                "worker SID mismatch",
            )?;
            report["stage"] = json!("wait_worker");
            let exit = child.wait(Duration::from_secs(120))?;
            report["worker_exit_code"] = json!(exit);
            require(exit == 0, "worker failed")
        })();
        let cleanup = job.terminate_and_confirm_drained(Duration::from_secs(5));
        match &cleanup {
            Ok(active) => report["job_active_after_cleanup"] = json!(active),
            Err(error) => report["cleanup_error"] = error_value(error),
        }
        if let Err(error) = &work {
            report["worker_error"] = error_value(error);
        }
        cleanup?;
        if work.is_ok() {
            report["stage"] = json!("complete");
        }
        work
    })();
    finish(report_file, report, result)
}
