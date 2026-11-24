//! Payload-relative path helpers shared across catalog modules.
//!
//! `test_no_deferred_tree_holds_a_broker_role_executable` scans this file along with
//! `catalog_roles/` for deferred-tree segment literals, and names `readers_venv` below as its one
//! explicit exception.

use std::path::{Path, PathBuf};

/// The directory holding the agent environment's interpreter inside a payload.
///
/// One function rather than the literal at each site: the Connector's executable, the runtime's
/// `OPENCODE_PYTHON`, the runtime's `PATH` entry and `SUPERCLAW_CONNECTOR_READER_PYTHON` must name
/// the same interpreter, and a second spelling is how they stop doing so.
pub(crate) fn agent_python_directory(payload_root: &Path) -> PathBuf {
    payload_root
        .join("py")
        .join("agent-python-venv")
        .join("Scripts")
}

/// `python.exe`, `python3.exe` and `pip.exe` shims (`shell-shims/venv-launcher`) that resolve the
/// file_tool tier's writable task venv through `VIRTUAL_ENV`, falling back to
/// `agent_python_directory` when the tier hasn't prepared one (#3897, fix for #3876).
///
/// Read-only like every other payload directory: the tier can run these but never write to them,
/// unlike the task venv's own `Scripts`, where `pip install` lands console scripts.
pub(crate) fn venv_launcher_directory(payload_root: &Path) -> PathBuf {
    payload_root.join("py").join("venv-launcher")
}

/// The GitHub CLI's directory inside a payload (EG1-11).
///
/// openwork-server is told the executable in it, for GitHub sign-in; the runtime gets the directory
/// on `PATH`, for the agent's `gh`. One function, so both name the binary the payload ships.
pub(crate) fn github_cli_directory(payload_root: &Path) -> PathBuf {
    payload_root.join("gh").join("bin")
}

/// The document and OCR reader environment inside a payload.
///
/// The directory, not its interpreter: `READERS_VENV` is a root, and the Profiles' reader tools
/// append `Scripts\python.exe` to it themselves on Windows.  No role executes anything inside it;
/// the runtime's reader tools do, on an agent request, and the deferred verification of this tree
/// settles before the runtime is reported ready.
pub(crate) fn readers_venv(payload_root: &Path) -> PathBuf {
    payload_root.join("py").join("readers-venv")
}

/// The pinned Node.js distribution: `node`, `npm` and `npx` for catalog stdio MCP servers.
pub(crate) fn node_directory(payload_root: &Path) -> PathBuf {
    payload_root.join("tools").join("node")
}

/// The pinned `uv` and `uvx` for catalog stdio MCP servers.
pub(crate) fn uv_directory(payload_root: &Path) -> PathBuf {
    payload_root.join("tools").join("uv")
}

/// The document reader scripts the `READERS_VENV` interpreter runs: the container's `/opt/readers`.
///
/// Named to the runtime as `READERS_DIR` so the Profiles' `parse_pdf` tool and document skills can
/// find `extract_text.py`; like the venv, no role executes anything inside it.
pub(crate) fn readers_directory(payload_root: &Path) -> PathBuf {
    payload_root.join("readers")
}
