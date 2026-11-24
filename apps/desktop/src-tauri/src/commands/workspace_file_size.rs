use std::fs;
use std::path::Path;

/// Size in bytes of a regular file within a workspace root, or `None` when it
/// is missing, not a file, or outside the root. Reads metadata only.
#[tauri::command]
pub fn workspace_file_size(file_path: String, workspace_root: String) -> Option<u64> {
    let file_trimmed = file_path.trim();
    let root_trimmed = workspace_root.trim();
    if file_trimmed.is_empty() || root_trimmed.is_empty() {
        return None;
    }

    let canonical_root = Path::new(root_trimmed).canonicalize().ok()?;
    let canonical_target = Path::new(file_trimmed).canonicalize().ok()?;
    if !canonical_target.starts_with(&canonical_root) {
        return None;
    }
    let meta = fs::metadata(&canonical_target).ok()?;
    meta.is_file().then(|| meta.len())
}

#[cfg(test)]
mod tests {
    use super::workspace_file_size;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn workspace_file_size_reports_files_inside_the_root_only() {
        let base = std::env::temp_dir().join(format!("superclaw-size-{}", uuid::Uuid::new_v4()));
        let root = base.join("workspace");
        fs::create_dir_all(root.join("docs")).expect("create workspace");
        fs::write(root.join("docs").join("notes.md"), b"hello").expect("write inside");
        fs::write(base.join("outside.txt"), b"secret!").expect("write outside");
        let root_str = root.to_string_lossy().into_owned();
        let path = |p: PathBuf| p.to_string_lossy().into_owned();

        assert_eq!(
            workspace_file_size(path(root.join("docs").join("notes.md")), root_str.clone()),
            Some(5)
        );
        assert_eq!(workspace_file_size(path(base.join("outside.txt")), root_str.clone()), None);
        assert_eq!(
            workspace_file_size(
                path(root.join("docs").join("..").join("..").join("outside.txt")),
                root_str.clone()
            ),
            None
        );
        assert_eq!(workspace_file_size(path(root.join("docs")), root_str.clone()), None);
        assert_eq!(workspace_file_size(path(root.join("missing.md")), root_str), None);

        let _ = fs::remove_dir_all(&base);
    }
}
