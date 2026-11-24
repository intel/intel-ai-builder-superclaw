use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use super::reparse::reject_reparse_components;
use crate::paths::home_dir;

// Mirrors sensitive_files.rs, but the mask-registry output is nested as
// <stem>/<timestamp>/<stem>_mask_registry.json (see workspace_paths.py),
// unlike the flat sensitive/ drop folder, so listing must walk recursively.
#[derive(Debug, Serialize)]
pub struct MaskRegistryEntry {
    pub name: String,
    /// Path relative to the mask_registries root, e.g.
    /// "customers/20260615_112233/customers_mask_registry.json".
    pub rel_path: String,
    pub path: String,
    pub size: u64,
    pub modified_ms: Option<u128>,
}

fn entry_from_path(root: &Path, path: &Path) -> Result<MaskRegistryEntry, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Failed to stat {}: {e}", path.display()))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid file name: {}", path.display()))?
        .to_string();
    let rel_path = path
        .strip_prefix(root)
        .map_err(|e| format!("Failed to compute relative path: {e}"))?
        .to_string_lossy()
        .replace('\\', "/");
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());
    Ok(MaskRegistryEntry {
        name,
        rel_path,
        path: path.to_string_lossy().to_string(),
        size: meta.len(),
        modified_ms,
    })
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<MaskRegistryEntry>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| format!("Failed to read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("Failed to read mask registry entry: {e}"))?;
        let path = entry.path();
        // DirEntry::file_type does not follow links, so a junction or symlink
        // planted under the root is neither recursed into nor listed (#3666).
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to stat {}: {e}", path.display()))?;
        if file_type.is_dir() {
            walk(root, &path, out)?;
        } else if file_type.is_file() {
            out.push(entry_from_path(root, &path)?);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn mask_registries_list() -> Result<Vec<MaskRegistryEntry>, String> {
    let home = home_dir().ok_or_else(|| "Unable to resolve home directory".to_string())?;
    list_mask_registries(&home.join("SuperClawProjects"))
}

fn list_mask_registries(projects_root: &Path) -> Result<Vec<MaskRegistryEntry>, String> {
    let dir = projects_root
        .join("data_protection_workspace")
        .join("mask_registries");
    reject_reparse_components(projects_root, &dir)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    walk(&dir, &dir, &mut entries)?;
    entries.sort_by(|a, b| a.rel_path.to_lowercase().cmp(&b.rel_path.to_lowercase()));
    Ok(entries)
}

#[cfg(all(test, windows))]
mod tests {
    use super::list_mask_registries;
    use crate::commands::reparse::test_support::{junction, layout};

    #[test]
    fn junction_root_is_refused() {
        let (root, outside) = layout();
        std::fs::write(outside.join("x_mask_registry.json"), "{}").unwrap();
        std::fs::create_dir(root.join("data_protection_workspace")).unwrap();
        junction(
            &root
                .join("data_protection_workspace")
                .join("mask_registries"),
            &outside,
        );
        assert!(list_mask_registries(&root).is_err());
    }

    #[test]
    fn nested_junction_is_not_walked() {
        let (root, outside) = layout();
        std::fs::write(outside.join("x_mask_registry.json"), "{}").unwrap();
        let dir = root
            .join("data_protection_workspace")
            .join("mask_registries");
        std::fs::create_dir_all(dir.join("real")).unwrap();
        std::fs::write(dir.join("real").join("a_mask_registry.json"), "{}").unwrap();
        junction(&dir.join("planted"), &outside);
        let entries = list_mask_registries(&root).expect("list");
        let names: Vec<_> = entries.iter().map(|e| e.rel_path.as_str()).collect();
        assert_eq!(names, ["real/a_mask_registry.json"]);
    }
}
