//! The verified installer an in-app update downloaded, held until the user chooses to install it.
//!
//! Between the two steps the file sits in the user's temp directory, where anything running as the
//! user can replace it. So the install step opens it without write or delete sharing, checks that
//! its size and SHA-256 still match what was recorded when its signature was verified, verifies the
//! signature again, and keeps that handle open until the installer has started.

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Fingerprint {
    size: u64,
    sha256: [u8; 32],
}

#[derive(Debug)]
struct StagedInstaller {
    version: String,
    path: PathBuf,
    fingerprint: Fingerprint,
}

/// Why [`Staging::take_reverified`] refused.
#[derive(Debug, PartialEq, Eq)]
pub enum ReverifyError {
    /// No verified installer for this version: nothing was downloaded, or it was already taken.
    NotReady,
    /// The file is not the one that was verified, or its signature no longer verifies.
    Changed(String),
}

/// A reverified installer and the handle that keeps it unchanged. Start the installer before
/// dropping it.
#[derive(Debug)]
pub struct ReverifiedInstaller {
    pub path: PathBuf,
    /// Never read: holding it is the point.
    _lock: File,
}

/// At most one staged installer: a new download replaces the previous one.
pub struct Staging(Mutex<Option<StagedInstaller>>);

pub static STAGING: Staging = Staging::new();

impl Staging {
    pub const fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn clear(&self) {
        *self.slot() = None;
    }

    /// Verify the downloaded `path` and, if it passes, stage it for `version`. The size and hash
    /// are read through the same locked handle the signature is verified under, so they describe
    /// the bytes that were verified.
    pub fn stage_verified(
        &self,
        version: &str,
        path: &Path,
        verify_signature: impl Fn(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        self.clear();
        let (_lock, fingerprint) = verify_locked(path, None, verify_signature)?;
        *self.slot() = Some(StagedInstaller {
            version: version.to_string(),
            path: path.to_path_buf(),
            fingerprint,
        });
        Ok(())
    }

    /// Take the staged installer for `version` after checking that it is still the file that was
    /// verified, and verifying its signature again. It is taken either way: a refused file must
    /// be downloaded again.
    pub fn take_reverified(
        &self,
        version: &str,
        verify_signature: impl Fn(&Path) -> Result<(), String>,
    ) -> Result<ReverifiedInstaller, ReverifyError> {
        let staged = {
            let mut slot = self.slot();
            match slot.take() {
                Some(staged) if staged.version == version => staged,
                other => {
                    *slot = other;
                    return Err(ReverifyError::NotReady);
                }
            }
        };
        let (lock, _) = verify_locked(&staged.path, Some(&staged.fingerprint), verify_signature)
            .map_err(ReverifyError::Changed)?;
        Ok(ReverifiedInstaller {
            path: staged.path,
            _lock: lock,
        })
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<StagedInstaller>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Read `path` through a locked handle, refuse it if it is not the `expected` file, then verify its
/// signature while the lock is held.
fn verify_locked(
    path: &Path,
    expected: Option<&Fingerprint>,
    verify_signature: impl Fn(&Path) -> Result<(), String>,
) -> Result<(File, Fingerprint), String> {
    let mut lock =
        open_locked(path).map_err(|e| format!("Could not open the downloaded installer: {e}"))?;
    let fingerprint = fingerprint(&mut lock)
        .map_err(|e| format!("Could not read the downloaded installer: {e}"))?;
    if expected.is_some_and(|expected| *expected != fingerprint) {
        return Err("The downloaded installer changed after it was verified.".to_string());
    }
    verify_signature(path)?;
    Ok((lock, fingerprint))
}

/// Open `path` for reading so that, while the handle lives, nothing can open it for writing,
/// rename it or delete it. Starting it as a process only reads it, so that still works.
fn open_locked(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        options.share_mode(FILE_SHARE_READ);
    }
    options.open(path)
}

fn fingerprint(file: &mut File) -> std::io::Result<Fingerprint> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut size = 0u64;
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        hasher.update(&buffer[..n]);
    }
    Ok(Fingerprint {
        size,
        sha256: hasher.finalize().into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn installer(bytes: &[u8]) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("superclaw-staging-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create dir");
        let path = dir.join("SuperClaw-Setup.exe");
        std::fs::write(&path, bytes).expect("write installer");
        path
    }

    fn signed(_: &Path) -> Result<(), String> {
        Ok(())
    }

    fn staged(bytes: &[u8]) -> (Staging, PathBuf) {
        let staging = Staging::new();
        let path = installer(bytes);
        staging
            .stage_verified("2.1.0", &path, signed)
            .expect("stage");
        (staging, path)
    }

    fn changed(result: Result<ReverifiedInstaller, ReverifyError>) -> String {
        match result {
            Err(ReverifyError::Changed(message)) => message,
            other => panic!("expected Changed, got {other:?}"),
        }
    }

    #[test]
    fn an_unchanged_installer_is_reverified_once() {
        let (staging, path) = staged(b"signed installer");
        let checks = Cell::new(0);
        let count = |_: &Path| {
            checks.set(checks.get() + 1);
            Ok(())
        };
        let ready = staging.take_reverified("2.1.0", count).expect("reverified");
        assert_eq!(ready.path, path);
        assert_eq!(
            checks.get(),
            1,
            "the signature is verified again before launch"
        );
        assert_eq!(
            staging.take_reverified("2.1.0", signed).unwrap_err(),
            ReverifyError::NotReady
        );
    }

    #[test]
    fn a_refused_signature_is_not_staged() {
        let staging = Staging::new();
        let path = installer(b"unsigned");
        let error = staging
            .stage_verified("2.1.0", &path, |_| Err("not signed".to_string()))
            .unwrap_err();
        assert_eq!(error, "not signed");
        assert_eq!(
            staging.take_reverified("2.1.0", signed).unwrap_err(),
            ReverifyError::NotReady
        );
    }

    #[test]
    fn only_the_staged_version_can_be_installed() {
        let (staging, _) = staged(b"signed installer");
        assert_eq!(
            staging.take_reverified("2.2.0", signed).unwrap_err(),
            ReverifyError::NotReady
        );
        assert!(
            staging.take_reverified("2.1.0", signed).is_ok(),
            "a wrong version leaves it staged"
        );
    }

    #[test]
    fn a_new_download_replaces_the_staged_installer() {
        let (staging, _) = staged(b"first");
        let second = installer(b"second");
        assert!(staging
            .stage_verified("2.2.0", &second, |_| Err("bad".to_string()))
            .is_err());
        assert_eq!(
            staging.take_reverified("2.1.0", signed).unwrap_err(),
            ReverifyError::NotReady
        );
    }

    #[test]
    fn same_size_different_bytes_is_refused_before_the_signature_check() {
        let (staging, path) = staged(b"signed installer");
        std::fs::write(&path, b"Signed installer").unwrap();
        let checked = Cell::new(false);
        let result = staging.take_reverified("2.1.0", |_| {
            checked.set(true);
            Ok(())
        });
        assert!(changed(result).contains("changed after it was verified"));
        assert!(
            !checked.get(),
            "a swapped file is refused on its hash alone"
        );
        assert_eq!(
            staging.take_reverified("2.1.0", signed).unwrap_err(),
            ReverifyError::NotReady
        );
    }

    #[test]
    fn appended_bytes_are_refused() {
        let (staging, path) = staged(b"signed installer");
        std::fs::write(&path, b"signed installer plus").unwrap();
        changed(staging.take_reverified("2.1.0", signed));
    }

    #[test]
    fn a_missing_installer_is_refused() {
        let (staging, path) = staged(b"signed installer");
        std::fs::remove_file(&path).unwrap();
        assert!(changed(staging.take_reverified("2.1.0", signed)).contains("Could not open"));
    }

    #[test]
    fn a_signature_that_no_longer_verifies_is_refused() {
        let (staging, _) = staged(b"signed installer");
        let message = changed(staging.take_reverified("2.1.0", |_| Err("revoked".to_string())));
        assert_eq!(message, "revoked");
    }

    /// The lock must stop a swap but not the launch.
    #[cfg(windows)]
    #[test]
    fn the_reverified_installer_cannot_be_replaced_but_can_be_started() {
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        let bytes =
            std::fs::read(Path::new(&system).join(r"System32\cmd.exe")).expect("read cmd.exe");
        let (staging, path) = staged(&bytes);
        let authenticode =
            |path: &Path| crate::installer_authenticode::verify_signed_installer(path, "O=Intel");
        let unlocked = authenticode(&path).unwrap_err();
        let ready = staging
            .take_reverified("2.1.0", signed)
            .expect("reverified");

        // cmd.exe is catalog-signed, so WinVerifyTrust refuses it the same way with or without
        // the lock; a sharing violation would be a different error.
        assert_eq!(authenticode(&path).unwrap_err(), unlocked);
        assert!(
            OpenOptions::new().write(true).open(&path).is_err(),
            "opened for writing"
        );
        assert!(std::fs::remove_file(&path).is_err(), "deleted");
        assert!(
            std::fs::rename(&path, path.with_extension("old")).is_err(),
            "renamed"
        );
        let status = std::process::Command::new(&path)
            .args(["/d", "/c", "exit 7"])
            .status()
            .expect("start the locked installer");
        assert_eq!(status.code(), Some(7));

        drop(ready);
        std::fs::remove_file(&path).expect("deletable once released");
    }
}
