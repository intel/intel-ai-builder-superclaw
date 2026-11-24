use super::reparse::reject_reparse_under_projects_root;
use crate::fs::copy_dir_recursive_filtered;
use crate::opkg::opkg_install as opkg_install_inner;
use crate::types::ExecResult;

// Mirrors SKILL_PACKAGE_EXTENSIONS in shared/contracts/src/skill-package.ts;
// keep both lists in sync when changing what a skill folder may contain.
const SKILL_FILE_EXTENSIONS: &[&str] = &[
    "md", "mdx", "markdown", "txt", "text",
    "py", "sh", "bash", "zsh", "ps1",
    "js", "mjs", "cjs", "jsx", "ts", "tsx",
    "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties",
    "csv", "tsv", "xml", "html", "htm", "css", "scss",
    "sql", "rb", "go", "rs", "java", "kt", "c", "cc", "cpp", "h", "hpp",
    "r", "lua", "pl", "php", "swift", "gitignore", "example", "lock", "gradle", "dockerfile",
    "db", "sqlite", "sqlite3", "duckdb", "mdb", "accdb",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg",
    "pdf", "docx", "xlsx", "pptx",
    "bin", "dat", "parquet", "arrow", "npy", "npz",
    "zip", "gz", "tar",
    "ttf", "otf", "woff", "woff2", "wav", "mp3",
];
const SKILL_FILENAMES: &[&str] = &["license", "notice", "makefile", "dockerfile"];

fn is_supported_skill_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    if SKILL_FILENAMES.contains(&lower.as_str()) {
        return true;
    }
    match lower.rsplit_once('.') {
        Some((_, ext)) => SKILL_FILE_EXTENSIONS.contains(&ext),
        None => false,
    }
}

#[tauri::command]
pub fn opkg_install(project_dir: String, package: String) -> Result<ExecResult, String> {
    let project_dir = project_dir.trim().to_string();
    if project_dir.is_empty() {
        return Err("projectDir is required".to_string());
    }

    let package = package.trim().to_string();
    if package.is_empty() {
        return Err("package is required".to_string());
    }

    opkg_install_inner(&project_dir, &package)
}

#[tauri::command]
pub fn import_skill(
    project_dir: String,
    source_dir: String,
    overwrite: bool,
) -> Result<ExecResult, String> {
    let project_dir = project_dir.trim().to_string();
    if project_dir.is_empty() {
        return Err("projectDir is required".to_string());
    }

    let source_dir = source_dir.trim().to_string();
    if source_dir.is_empty() {
        return Err("sourceDir is required".to_string());
    }

    let src = std::path::PathBuf::from(&source_dir);
    let name = src
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Failed to infer skill name from directory".to_string())?;

    let dest = std::path::PathBuf::from(&project_dir)
        .join(".opencode")
        .join("skills")
        .join(name);
    reject_reparse_under_projects_root(&src)?;
    reject_reparse_under_projects_root(&dest)?;

    if dest.exists() {
        if overwrite {
            std::fs::remove_dir_all(&dest).map_err(|e| {
                format!(
                    "Failed to remove existing skill dir {}: {e}",
                    dest.display()
                )
            })?;
        } else {
            return Err(format!("Skill already exists at {}", dest.display()));
        }
    }

    let skipped = copy_dir_recursive_filtered(&src, &dest, &is_supported_skill_file)?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: if skipped > 0 {
            format!(
                "Imported skill to {} ({skipped} unsupported file(s) skipped)",
                dest.display()
            )
        } else {
            format!("Imported skill to {}", dest.display())
        },
        stderr: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::is_supported_skill_file;

    #[test]
    fn allows_known_extensions_and_bare_filenames() {
        assert!(is_supported_skill_file("SKILL.md"));
        assert!(is_supported_skill_file("script.py"));
        assert!(is_supported_skill_file("LICENSE"));
        assert!(is_supported_skill_file("Dockerfile"));
    }

    #[test]
    fn rejects_secret_and_key_material() {
        assert!(!is_supported_skill_file(".env"));
        assert!(!is_supported_skill_file("server.pem"));
        assert!(!is_supported_skill_file("server.crt"));
        assert!(!is_supported_skill_file("id_rsa.key"));
    }

    #[test]
    fn rejects_executables_and_unknown_extensions() {
        assert!(!is_supported_skill_file("tool.exe"));
        assert!(!is_supported_skill_file("resource.unknown-type"));
    }
}

#[cfg(all(test, windows))]
mod reparse_tests {
    use super::import_skill;
    use crate::commands::reparse::test_support::{junction, layout, use_projects_root};

    #[test]
    fn import_through_a_planted_opencode_junction_is_refused() {
        let (root, outside) = layout();
        use_projects_root(&root);
        let existing = outside.join("skills").join("demo");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(existing.join("keep.md"), "owner data").unwrap();
        junction(&root.join(".opencode"), &outside);
        let source = outside.parent().unwrap().join("demo");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("SKILL.md"), "new").unwrap();

        let result = import_skill(
            root.to_string_lossy().into(),
            source.to_string_lossy().into(),
            true,
        );

        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(existing.join("keep.md")).unwrap(),
            "owner data"
        );
    }

    #[test]
    fn import_of_a_planted_source_junction_is_refused() {
        let (root, outside) = layout();
        use_projects_root(&root);
        std::fs::write(outside.join("SKILL.md"), "owner data").unwrap();
        junction(&root.join("demo"), &outside);
        let target = root.parent().unwrap().join("other-workspace");

        let result = import_skill(
            target.to_string_lossy().into(),
            root.join("demo").to_string_lossy().into(),
            false,
        );

        assert!(result.is_err());
        assert!(!target.join(".opencode").exists());
    }

    #[test]
    fn import_works_into_a_real_directory() {
        let (root, outside) = layout();
        use_projects_root(&root);
        std::fs::write(outside.join("SKILL.md"), "new").unwrap();
        let result = import_skill(
            root.to_string_lossy().into(),
            outside.to_string_lossy().into(),
            false,
        );
        assert!(result.unwrap().ok);
        assert!(root
            .join(".opencode")
            .join("skills")
            .join("outside")
            .join("SKILL.md")
            .is_file());
    }
}
