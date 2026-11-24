//! Shared forwarding logic for the payload's venv-launcher shims: `python.exe`, `python3.exe`
//! and `pip.exe` under `py/venv-launcher`, on the file_tool runtime's `PATH` ahead of the
//! read-only `agent-python-venv` interpreter (fixes #3876 without the risk #3897's `launchers`
//! copy carried: a tier-writable directory pinned ahead of the machine `PATH`).
//!
//! Each shim resolves the file_tool tier's writable task venv through `VIRTUAL_ENV`
//! (`runtime.rs` sets it unconditionally to `<home>\.local\python`, whether or not Sandbox
//! Manager actually prepared one there this start) and falls back to the payload's own
//! `agent-python-venv` interpreter - a sibling of this shim's own directory - when the venv isn't
//! ready: either its interpreter isn't there, or it's there but the venv was never finished (a
//! failed, unretryable preparation can leave `Scripts/python.exe` behind without ever writing
//! Sandbox Manager's own completion marker). The venv path is only ever checked for existence,
//! never executed as part of resolving it, so a `.local\python` the tier redirected cannot make
//! this shim run anything placed on the other side of that redirect.
//!
//! This shim itself lives in the read-only payload: the tier can read and execute it but never
//! write to it, so - unlike the venv's own `Scripts` directory, where a later `pip install`
//! lands console scripts - nothing the tier does after this binary is built can change what it
//! resolves to or runs.

use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{exit, Command};

/// Where the task venv's own interpreter would be, if `VIRTUAL_ENV` names one.
fn venv_candidate(virtual_env: &OsStr) -> PathBuf {
    Path::new(virtual_env).join("Scripts").join("python.exe")
}

/// Whether `venv` is one Sandbox Manager actually finished preparing, not a tree a failed,
/// unretryable preparation left behind.
///
/// `runtime_python.py` writes this marker (`.superclaw-python.json`) only after the venv is
/// fully created - `Scripts/python.exe` alone can exist on a tree a failed creation or a refused
/// quarantine left in place (Sandbox Manager returns `None` and gives up, but doesn't always
/// clean up what's there), and `VIRTUAL_ENV` still names it either way. Checking for the
/// interpreter alone would pick that rejected or incomplete environment over the payload
/// fallback.
fn is_prepared(venv: &Path) -> bool {
    venv.join(".superclaw-python.json").is_file()
}

/// The payload's read-only interpreter, a sibling of `py/venv-launcher` (this shim's own
/// directory) under `py/`.
fn payload_candidate(shim_directory: &Path) -> PathBuf {
    let py = shim_directory.parent().unwrap_or(shim_directory);
    py.join("agent-python-venv").join("Scripts").join("python.exe")
}

/// `-m pip`, ahead of whatever the caller passed: forwarding through the resolved interpreter's
/// own pip module means this never depends on a `pip.exe` console script existing in either the
/// venv or the payload.
fn pip_args(rest: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
    let mut args = vec![OsString::from("-m"), OsString::from("pip")];
    args.extend(rest);
    args
}

fn resolve_python() -> PathBuf {
    if let Some(virtual_env) = env::var_os("VIRTUAL_ENV") {
        let candidate = venv_candidate(&virtual_env);
        if is_prepared(Path::new(&virtual_env)) && candidate.is_file() {
            return candidate;
        }
    }
    let shim_directory = env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let fallback = payload_candidate(&shim_directory);
    if fallback.is_file() {
        return fallback;
    }
    eprintln!("venv-launcher: no Python interpreter found (checked VIRTUAL_ENV and the payload)");
    exit(127);
}

fn run(target: &Path, args: Vec<OsString>) -> ! {
    match Command::new(target).args(args).status() {
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("venv-launcher: cannot run {}: {error}", target.display());
            exit(127);
        }
    }
}

pub fn forward_to_python() -> ! {
    let target = resolve_python();
    run(&target, env::args_os().skip(1).collect());
}

pub fn forward_to_pip() -> ! {
    let target = resolve_python();
    run(&target, pip_args(env::args_os().skip(1)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn venv_candidate_is_scripts_python_under_virtual_env() {
        assert_eq!(
            venv_candidate(OsStr::new(r"C:\data\file_tool\home\.local\python")),
            PathBuf::from(r"C:\data\file_tool\home\.local\python\Scripts\python.exe"),
        );
    }

    #[test]
    fn payload_candidate_is_a_sibling_of_the_shims_own_directory() {
        assert_eq!(
            payload_candidate(Path::new(r"C:\payload\py\venv-launcher")),
            PathBuf::from(r"C:\payload\py\agent-python-venv\Scripts\python.exe"),
        );
    }

    #[test]
    fn payload_candidate_falls_back_to_its_own_directory_when_it_has_no_parent() {
        // `Path::parent()` returns `None` only for a path with no components at all, not for a
        // single relative component (`Path::new("x").parent()` is `Some("")`) - this exercises
        // that actual `None` case, where the `unwrap_or` fallback is reached.
        assert_eq!(
            payload_candidate(Path::new("")),
            PathBuf::from("agent-python-venv/Scripts/python.exe"),
        );
    }

    #[test]
    fn pip_args_puts_the_module_invocation_first_and_keeps_the_rest_in_order() {
        let rest = ["install", "cowsay"].map(OsString::from);
        assert_eq!(
            pip_args(rest),
            ["-m", "pip", "install", "cowsay"].map(OsString::from).to_vec(),
        );
    }

    /// A scratch directory under the system temp dir, removed when it drops - std-only stand-in
    /// for a `tempfile` crate, consistent with this crate's no-dependencies-beyond-std rule.
    struct ScratchDir(PathBuf);

    impl ScratchDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "venv-launcher-shim-test-{name}-{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create scratch dir");
            Self(path)
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn is_prepared_is_false_when_python_exe_exists_but_the_marker_does_not() {
        let venv = ScratchDir::new("incomplete");
        std::fs::create_dir_all(venv.0.join("Scripts")).unwrap();
        std::fs::write(venv.0.join("Scripts").join("python.exe"), b"").unwrap();

        // A failed or refused-quarantine preparation can leave `python.exe` behind without ever
        // writing the marker - this must not be mistaken for a ready venv.
        assert!(!is_prepared(&venv.0));
    }

    #[test]
    fn is_prepared_is_true_once_the_marker_sandbox_manager_writes_last_exists() {
        let venv = ScratchDir::new("complete");
        std::fs::write(venv.0.join(".superclaw-python.json"), b"{}").unwrap();

        assert!(is_prepared(&venv.0));
    }
}
