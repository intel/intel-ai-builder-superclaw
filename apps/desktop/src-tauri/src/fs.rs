use std::fs;
use std::path::Path;

/// Copies `src` into `dest`, skipping files rejected by `is_allowed` (called
/// with each file's name). Returns the number of skipped files.
pub fn copy_dir_recursive_filtered(
    src: &Path,
    dest: &Path,
    is_allowed: &dyn Fn(&str) -> bool,
) -> Result<u64, String> {
    if !src.is_dir() {
        return Err(format!("Source is not a directory: {}", src.display()));
    }

    fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create dir {}: {e}", dest.display()))?;

    let mut skipped = 0u64;
    for entry in
        fs::read_dir(src).map_err(|e| format!("Failed to read dir {}: {e}", src.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;

        let from = entry.path();
        let to = dest.join(entry.file_name());

        if file_type.is_dir() {
            skipped += copy_dir_recursive_filtered(&from, &to, is_allowed)?;
            continue;
        }

        if file_type.is_file() {
            let name = entry.file_name();
            if !is_allowed(&name.to_string_lossy()) {
                skipped += 1;
                continue;
            }
            fs::copy(&from, &to).map_err(|e| {
                format!("Failed to copy {} -> {}: {e}", from.display(), to.display())
            })?;
            continue;
        }

        // Skip symlinks and other non-regular entries.
    }

    Ok(skipped)
}

#[cfg(test)]
mod tests {
    use super::copy_dir_recursive_filtered;
    use std::fs;

    #[test]
    fn skips_disallowed_files_and_copies_the_rest() {
        let root = std::env::temp_dir().join(format!("copy-dir-filtered-{}", uuid::Uuid::new_v4()));
        let src = root.join("src");
        let dest = root.join("dest");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("SKILL.md"), "hello").unwrap();
        fs::write(src.join(".env"), "SECRET=1").unwrap();
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("nested").join("server.pem"), "key").unwrap();

        let skipped =
            copy_dir_recursive_filtered(&src, &dest, &|name| name != ".env" && name != "server.pem").unwrap();

        assert_eq!(skipped, 2);
        assert!(dest.join("SKILL.md").exists());
        assert!(!dest.join(".env").exists());
        assert!(!dest.join("nested").join("server.pem").exists());

        fs::remove_dir_all(&root).ok();
    }
}
