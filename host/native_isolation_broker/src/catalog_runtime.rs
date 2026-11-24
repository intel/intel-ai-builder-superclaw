//! Fixed Runtime environment entries for reading DPAPI-sealed Connector configuration.

use std::io;
use std::path::Path;

pub(crate) fn connector_reader_environment(
    payload_root: &Path,
    config: &Path,
) -> io::Result<Vec<(String, String)>> {
    let text = |path: &Path| {
        path.to_str().map(str::to_owned).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Runtime path must be Unicode")
        })
    };
    Ok(vec![
        (
            "SUPERCLAW_CONNECTOR_CONFIG".to_owned(),
            text(&config.join("superclaw").join("connector-client.json"))?,
        ),
        (
            "SUPERCLAW_CONNECTOR_READER_PYTHON".to_owned(),
            text(&crate::payload_paths::agent_python_directory(payload_root).join("python.exe"))?,
        ),
        (
            "SUPERCLAW_CONNECTOR_READER_ROOT".to_owned(),
            text(&payload_root.join("connector-service"))?,
        ),
    ])
}
