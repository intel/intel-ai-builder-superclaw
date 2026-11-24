//! Fixed product-layout ancestors, shared by provision and unelevated readback.
//! No environment lookup, filesystem write, or caller-selected parent depth.

use std::io;
use std::path::{Path, PathBuf};

pub const SCOPES: [&str; 3] = [
    "backend_root",
    "payload_container_root",
    "temp_container_root",
];

pub fn derive(
    config: &Path,
    data: &Path,
    logs: &Path,
    payload: &Path,
    temp: &Path,
) -> io::Result<[PathBuf; 3]> {
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "backend roots do not match the fixed product layout",
        )
    };
    let parent_named = |path: &Path, name: &str| -> io::Result<PathBuf> {
        if !path
            .file_name()
            .is_some_and(|value| value.to_string_lossy().eq_ignore_ascii_case(name))
        {
            return Err(invalid());
        }
        let parent = path.parent().ok_or_else(invalid)?;
        // Never grant a volume root; the backend is an actual directory component.
        if parent.file_name().is_none() {
            return Err(invalid());
        }
        Ok(parent.to_path_buf())
    };
    let backend = parent_named(config, "config")?;
    let payload_container = payload.parent().ok_or_else(invalid)?.to_path_buf();
    let temp_container = temp.parent().ok_or_else(invalid)?.to_path_buf();
    for other in [
        parent_named(data, "data")?,
        parent_named(logs, "logs")?,
        parent_named(&payload_container, "payload")?,
        parent_named(&temp_container, "tmp")?,
    ] {
        if !crate::managed_root_path::same_managed_path(&backend, &other) {
            return Err(invalid());
        }
    }
    Ok([backend, payload_container, temp_container])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_only_the_three_fixed_parents() {
        let result = derive(
            Path::new(r"C:\state\config"),
            Path::new(r"C:\state\data"),
            Path::new(r"C:\state\logs"),
            Path::new(r"C:\state\payload\v1"),
            Path::new(r"C:\state\tmp\broker-start"),
        )
        .unwrap();
        assert_eq!(
            result,
            [
                PathBuf::from(r"C:\state"),
                PathBuf::from(r"C:\state\payload"),
                PathBuf::from(r"C:\state\tmp")
            ]
        );
    }

    #[test]
    fn rejects_split_or_malformed_layouts() {
        for data in [r"D:\state\data", r"C:\state\other", r"C:\elsewhere\data"] {
            assert!(
                derive(
                    Path::new(r"C:\state\config"),
                    Path::new(data),
                    Path::new(r"C:\state\logs"),
                    Path::new(r"C:\state\payload\v1"),
                    Path::new(r"C:\state\tmp\broker-start")
                )
                .is_err()
            );
        }
        assert!(
            derive(
                Path::new(r"C:\state\config"),
                Path::new(r"C:\state\data"),
                Path::new(r"C:\state\logs"),
                Path::new(r"C:\Program Files\SuperClaw\servicehub\native-backend"),
                Path::new(r"C:\state\tmp\broker-start"),
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_volume_roots_and_wrong_intermediate_names() {
        assert!(
            derive(
                Path::new(r"C:\config"),
                Path::new(r"C:\data"),
                Path::new(r"C:\logs"),
                Path::new(r"C:\payload\v1"),
                Path::new(r"C:\tmp\session")
            )
            .is_err()
        );
        assert!(
            derive(
                Path::new(r"C:\state\config"),
                Path::new(r"C:\state\data"),
                Path::new(r"C:\state\logs"),
                Path::new(r"C:\state\other\v1"),
                Path::new(r"C:\state\tmp\session")
            )
            .is_err()
        );
    }
}
