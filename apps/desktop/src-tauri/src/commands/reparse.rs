use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

/// Refuses `target` if any existing component below `root` is a symlink,
/// junction or other reparse point (#3666). A sandbox tier can plant a junction
/// inside the projects root; an owner-side open that follows it reaches
/// wherever the junction points. Components that do not exist yet pass (the
/// caller creates them as real directories). `root` itself is not checked.
///
/// Point-in-time check: a component swapped for a junction between this call
/// and the caller's open is still followed. That check-to-use race is a known
/// residual.
pub(super) fn reject_reparse_components(root: &Path, target: &Path) -> Result<(), String> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| format!("{} is outside {}", target.display(), root.display()))?;
    // All components first: returning at a missing one must not skip a later
    // `..`, which Windows would resolve on open.
    let parts = relative
        .components()
        .map(|component| match component {
            Component::Normal(part) => Ok(part),
            _ => Err(format!("Invalid path {}", target.display())),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut current = root.to_path_buf();
    for part in parts {
        current.push(part);
        let meta = match fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(format!("Failed to stat {}: {e}", current.display())),
        };
        if is_reparse_point(&meta) {
            tracing::warn!(path = %current.display(), "refused a reparse point under the projects root");
            return Err(format!(
                "Refusing to follow a link or junction at {}",
                current.display()
            ));
        }
    }
    Ok(())
}

/// `reject_reparse_components` from `~/SuperClawProjects` when `target` is
/// under it. Paths elsewhere (a file the user picked) are not checked.
pub(super) fn reject_reparse_under_projects_root(target: &Path) -> Result<(), String> {
    #[cfg(all(test, windows))]
    if let Some(root) = test_support::PROJECTS_ROOT.with(|root| root.borrow().clone()) {
        return reject_reparse_if_under(&root, target);
    }
    let Some(home) = crate::paths::home_dir() else {
        return Ok(());
    };
    reject_reparse_if_under(&home.join("SuperClawProjects"), target)
}

/// Containment is decided by identity, not spelling: Windows has many names for
/// one folder (case, `\\?\` and `\\.\` prefixes, 8.3 short names, and
/// `\\localhost\C$` shares, which canonicalize to `\\?\UNC\...` rather than
/// `\\?\C:\...`). `std::path::absolute` first applies `..` and `.` the way an
/// open would; then each prefix of `target`, shortest first, is opened and its
/// file identity (volume serial number + file index) compared with the root's.
/// Opening a prefix follows links *above* the root, which is fine; everything
/// below the matching prefix is walked without following.
fn reject_reparse_if_under(root: &Path, target: &Path) -> Result<(), String> {
    let root = match same_file::Handle::from_path(root) {
        Ok(handle) => handle,
        // No projects root yet, so nothing can be planted in it.
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        // Any other failure leaves containment unanswerable: refuse, not pass.
        Err(e) => return Err(format!("Failed to open {}: {e}", root.display())),
    };
    let target = std::path::absolute(target)
        .map_err(|e| format!("Invalid path {}: {e}", target.display()))?;
    let mut prefix = PathBuf::new();
    for component in target.components() {
        prefix.push(component);
        if same_file::Handle::from_path(&prefix).is_ok_and(|handle| handle == root) {
            return reject_reparse_components(&prefix, &target);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// Test fixtures shared by the commands that call `reject_reparse_components`.
#[cfg(all(test, windows))]
pub(super) mod test_support {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    thread_local! {
        /// Per test thread, so tests never touch the real `~/SuperClawProjects`
        /// or race each other over `HOME`.
        pub static PROJECTS_ROOT: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    }

    /// Points `reject_reparse_under_projects_root` at `root` for this test.
    pub fn use_projects_root(root: &Path) {
        PROJECTS_ROOT.with(|cell| *cell.borrow_mut() = Some(root.to_path_buf()));
    }

    /// A fresh `<temp>/<uuid>` holding an empty `SuperClawProjects` and `outside`.
    pub fn layout() -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("superclaw-reparse-{}", uuid::Uuid::new_v4()));
        let root = base.join("SuperClawProjects");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::create_dir_all(&outside).expect("create outside");
        (root, outside)
    }

    /// Rust tests cannot skip, so a failed junction panics as INCONCLUSIVE rather than passing.
    pub fn junction(link: &Path, target: &Path) {
        let out = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("run mklink");
        assert!(
            out.status.success(),
            "INCONCLUSIVE: could not create a junction: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Needs Developer Mode or admin, so its tests are `#[ignore]`d by default; run with
    /// `--ignored`. Without the privilege it panics as INCONCLUSIVE, like `junction`.
    pub fn symlink(link: &Path, target: &Path) {
        let created = if target.is_dir() {
            std::os::windows::fs::symlink_dir(target, link)
        } else {
            std::os::windows::fs::symlink_file(target, link)
        };
        if let Err(e) = created {
            panic!("INCONCLUSIVE: could not create a symlink: {e}");
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::test_support::{junction, layout, symlink};
    use super::{reject_reparse_components, reject_reparse_if_under};

    #[test]
    fn refuses_junction_component() {
        let (root, outside) = layout();
        junction(&root.join("sensitive"), &outside);
        let err = reject_reparse_components(&root, &root.join("sensitive").join("a.txt"))
            .expect_err("junction must be refused");
        assert!(err.contains("Refusing to follow"), "{err}");
    }

    #[test]
    #[ignore = "needs symlink privilege (Developer Mode or admin): cargo test reparse -- --ignored"]
    fn refuses_directory_symlink_component() {
        let (root, outside) = layout();
        symlink(&root.join("sensitive"), &outside);
        let err = reject_reparse_components(&root, &root.join("sensitive").join("a.txt"))
            .expect_err("directory symlink must be refused");
        assert!(err.contains("Refusing to follow"), "{err}");
    }

    #[test]
    #[ignore = "needs symlink privilege (Developer Mode or admin): cargo test reparse -- --ignored"]
    fn refuses_file_symlink() {
        let (root, outside) = layout();
        std::fs::write(outside.join("secret.txt"), "owner data").unwrap();
        std::fs::create_dir(root.join("sensitive")).unwrap();
        let link = root.join("sensitive").join("a.txt");
        symlink(&link, &outside.join("secret.txt"));
        let err = reject_reparse_components(&root, &link).expect_err("file symlink must be refused");
        assert!(err.contains("Refusing to follow"), "{err}");
    }

    #[test]
    fn allows_real_and_missing_components() {
        let (root, _) = layout();
        std::fs::create_dir(root.join("sensitive")).unwrap();
        reject_reparse_components(&root, &root.join("sensitive").join("new").join("a.txt"))
            .expect("real and missing components pass");
    }

    #[test]
    fn nested_root_junction_is_refused_but_outside_paths_pass() {
        // A preview passes `SuperClawProjects\sensitive` as its root; the root
        // itself being a junction must not let canonicalize follow it.
        let (root, outside) = layout();
        std::fs::write(outside.join("secret.txt"), "owner data").unwrap();
        junction(&root.join("sensitive"), &outside);
        let planted = root.join("sensitive").join("secret.txt");
        assert!(reject_reparse_if_under(&root, &planted).is_err());
        assert!(reject_reparse_if_under(&root, &outside.join("secret.txt")).is_ok());
    }

    #[test]
    fn respelled_paths_still_reach_the_check() {
        let (root, outside) = layout();
        std::fs::write(outside.join("secret.txt"), "owner data").unwrap();
        junction(&root.join("sensitive"), &outside);
        let tail = std::path::Path::new("sensitive").join("secret.txt");
        let root_text = root.to_string_lossy();
        for target in [
            root.join("missing").join("..").join(&tail),
            std::path::PathBuf::from(root_text.to_uppercase()).join(&tail),
            std::path::PathBuf::from(format!(r"\\?\{root_text}")).join(&tail),
            std::path::PathBuf::from(format!(r"\\.\{root_text}")).join(&tail),
        ] {
            let error = reject_reparse_if_under(&root, &target)
                .expect_err(&format!("must be refused: {}", target.display()));
            assert!(
                error.contains("Refusing to follow"),
                "{}: {error}",
                target.display()
            );
        }
    }

    #[test]
    fn admin_share_spelling_still_reaches_the_check() {
        // `\\localhost\C$\...` canonicalizes to `\\?\UNC\localhost\C$\...`, which
        // never equals the local `\\?\C:\...` root; only file identity matches it.
        let (root, outside) = layout();
        std::fs::write(outside.join("secret.txt"), "owner data").unwrap();
        junction(&root.join("sensitive"), &outside);
        let root_text = root.to_string_lossy();
        let (drive, rest) = root_text.split_once(':').expect("temp dir is on a drive");
        let share_root = std::path::PathBuf::from(format!(r"\\localhost\{drive}${rest}"));
        assert!(
            share_root.is_dir(),
            "INCONCLUSIVE: the admin share {} is not reachable",
            share_root.display()
        );
        let target = share_root.join("sensitive").join("secret.txt");
        let error = reject_reparse_if_under(&root, &target)
            .expect_err(&format!("must be refused: {}", target.display()));
        assert!(
            error.contains("Refusing to follow"),
            "{}: {error}",
            target.display()
        );
    }

    #[test]
    fn missing_root_passes_but_unopenable_root_is_refused() {
        let (root, _) = layout();
        let target = root.join("sensitive").join("a.txt");
        assert!(reject_reparse_if_under(&root.join("missing"), &target).is_ok());
        // `|` is an invalid name on Windows: the open fails with something other than NotFound.
        let error = reject_reparse_if_under(&root.join("bad|name"), &target)
            .expect_err("an unopenable root must be refused");
        assert!(error.contains("Failed to open"), "{error}");
    }

    #[test]
    fn refuses_parent_traversal() {
        let (root, _) = layout();
        assert!(reject_reparse_components(&root, &root.join("..").join("x")).is_err());
    }
}
