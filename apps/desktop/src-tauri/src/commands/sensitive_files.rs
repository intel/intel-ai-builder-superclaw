use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use super::reparse::{reject_reparse_components, reject_reparse_under_projects_root};
use crate::paths::home_dir;

#[derive(Debug, Serialize)]
pub struct SensitiveFileEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified_ms: Option<u128>,
}

fn ensure_sensitive_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "Unable to resolve home directory".to_string())?;
    ensure_sensitive_dir_in(&home.join("SuperClawProjects"))
}

fn ensure_sensitive_dir_in(root: &Path) -> Result<PathBuf, String> {
    let dir = root.join("sensitive");
    reject_reparse_components(root, &dir)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn entry_from_path(path: &Path) -> Result<SensitiveFileEntry, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Failed to stat {}: {e}", path.display()))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid file name: {}", path.display()))?
        .to_string();
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());
    Ok(SensitiveFileEntry {
        name,
        path: path.to_string_lossy().to_string(),
        size: meta.len(),
        modified_ms,
    })
}

fn unique_destination(dir: &Path, file_name: &str) -> PathBuf {
    let original = Path::new(file_name);
    let stem = original
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("file");
    let extension = original.extension().and_then(|ext| ext.to_str());
    let mut candidate = dir.join(file_name);
    let mut suffix = 1;
    // symlink_metadata, not exists(): a dangling link must count as taken, or
    // fs::copy writes through it to wherever it points.
    while fs::symlink_metadata(&candidate).is_ok() {
        let name = match extension {
            Some(ext) if !ext.is_empty() => format!("{stem} ({suffix}).{ext}"),
            _ => format!("{stem} ({suffix})"),
        };
        candidate = dir.join(name);
        suffix += 1;
    }
    candidate
}

fn list_entries(dir: &Path) -> Result<Vec<SensitiveFileEntry>, String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("Failed to read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("Failed to read sensitive file entry: {e}"))?;
        let path = entry.path();
        if path.is_file() {
            entries.push(entry_from_path(&path)?);
        }
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
pub fn sensitive_files_list() -> Result<Vec<SensitiveFileEntry>, String> {
    let dir = ensure_sensitive_dir()?;
    list_entries(&dir)
}

#[tauri::command]
pub fn sensitive_files_delete(name: String) -> Result<Vec<SensitiveFileEntry>, String> {
    let dir = ensure_sensitive_dir()?;
    let name = name.trim();
    if name.is_empty() {
        return Err("File name is required".to_string());
    }
    let target = dir.join(name);
    // Guard against traversal (e.g. "../../something") — the resolved parent
    // must stay exactly the sensitive dir.
    if target.parent() != Some(dir.as_path()) {
        return Err("Invalid file name".to_string());
    }
    if !target.is_file() {
        return Err(format!("Not a file: {}", target.display()));
    }
    fs::remove_file(&target).map_err(|e| format!("Failed to delete {}: {e}", target.display()))?;
    list_entries(&dir)
}

#[tauri::command]
pub fn sensitive_files_import(paths: Vec<String>) -> Result<Vec<SensitiveFileEntry>, String> {
    let dir = ensure_sensitive_dir()?;
    for source in paths {
        let source = PathBuf::from(source.trim());
        reject_reparse_under_projects_root(&source)?;
        if !source.is_file() {
            return Err(format!("Not a file: {}", source.display()));
        }
        let file_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("Invalid file name: {}", source.display()))?;
        let dest = unique_destination(&dir, file_name);
        fs::copy(&source, &dest).map_err(|e| {
            format!(
                "Failed to copy {} to {}: {e}",
                source.display(),
                dest.display()
            )
        })?;
    }
    list_entries(&dir)
}

#[cfg(all(test, windows))]
mod tests {
    use super::{ensure_sensitive_dir_in, unique_destination};
    use crate::commands::reparse::test_support::{junction, layout};

    #[test]
    fn sensitive_dir_junction_is_refused() {
        let (root, outside) = layout();
        junction(&root.join("sensitive"), &outside);
        assert!(ensure_sensitive_dir_in(&root).is_err());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn sensitive_dir_is_created_as_real_directory() {
        let (root, _) = layout();
        let dir = ensure_sensitive_dir_in(&root).expect("real dir");
        assert!(dir.is_dir());
    }

    #[test]
    fn dangling_link_counts_as_taken() {
        let (root, outside) = layout();
        junction(&root.join("a.txt"), &outside.join("missing"));
        assert_eq!(unique_destination(&root, "a.txt"), root.join("a (1).txt"));
    }
}
