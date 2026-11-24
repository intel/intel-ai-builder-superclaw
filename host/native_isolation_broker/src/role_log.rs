//! Where a role's log goes, and the handle the tier runner opens for it.
//!
//! # Why the tier opens the file
//!
//! A role's standard output has to end up somewhere a person can read. The alternative to opening the
//! file here is to hand the role a pipe and copy from it, which is what the runner did before this
//! module existed: that costs two threads per launch and puts every byte through a process that has no
//! reason to see them. Opening the destination and letting the kernel connect the role's handles to it
//! directly is both smaller and less to get wrong.
//!
//! # Why the name cannot come from the caller
//!
//! The file name is derived from the launch's own pipe identifier, which `launcher::owner` drew from
//! `BCryptGenRandom` for this one launch and passed to the runner on its command line. No wire field,
//! session identifier or caller-supplied string reaches it. That is what makes collisions impossible
//! between concurrent launches without any coordination, and it is why `LaunchId` validates the value
//! it is given instead of trusting the argument: the same grammar that makes a name safe as a path
//! component is the one that makes it unguessable.
//!
//! Combined with `CREATE_NEW`, a repeated launch cannot append to another launch's log either: a name
//! that already exists is a failed open rather than a shared file.
//!
//! # What a log is not
//!
//! It is tier self-report. The tier account creates the file, so the tier owns it, and an object owner
//! holds `WRITE_DAC` implicitly no matter what the shipped DACL says. Nothing in the product may
//! treat a role log as evidence of what a role did.

use crate::launch_catalog::{canonicalize_local_windows_path, shipped_role_log_rules};
use crate::process_win32::OwnedHandle;
use crate::tier::IsolationTier;
use crate::wide::to_wide;
use std::io;
use std::mem::size_of;
use std::path::{Path, PathBuf};
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CREATE_NEW, CreateFileW, FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_SHARE_DELETE, FILE_SHARE_READ, SYNCHRONIZE,
};

/// The identifier a launch's log file is named after: bounded lowercase hex, nothing else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchId(String);

impl LaunchId {
    /// Validates the pipe identifier this launch was started with as a launch identifier.
    ///
    /// The refusal deliberately does not quote the value. There is nothing secret about a pipe id -
    /// it is on the runner's command line - but a refusal that echoes an attacker-chosen string into a
    /// report frame is a habit worth not having, and the length and alphabet say everything an operator
    /// needs.
    pub fn from_pipe_id(pipe_id: &str) -> io::Result<Self> {
        let expected = shipped_role_log_rules().launch_id_hex_chars;
        let well_formed = pipe_id.len() == expected
            && pipe_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if !well_formed {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "a launch identifier must be exactly {expected} lowercase hexadecimal characters"
                ),
            ));
        }
        Ok(Self(pipe_id.to_owned()))
    }

    /// Test-only: production code asks for the file name, never for the identifier on its own.
    #[cfg(test)]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The one file name this launch may produce.
    pub fn log_file_name(&self) -> String {
        format!("{}{}", self.0, shipped_role_log_rules().extension)
    }
}

/// The tier's own log directory under a validated log root: `<state_logs_root>\<tier>`.
///
/// The root is re-canonicalized here even though the start request's validation already did it, so this
/// function is safe on its own terms: a root with a `..` component, a device name or a short-name alias
/// is refused before it is ever joined to anything.
///
/// Provision apply creates this directory and writes its DACL. Nothing here creates it, and that
/// is deliberate: the tier account holds no add-subdirectory right on the log root, so a runner that
/// tried would fail anyway, and a runner that succeeded would have created a directory carrying
/// whatever DACL it inherited rather than the one the shipped policy specifies.
pub fn tier_log_directory(state_logs_root: &str, tier: IsolationTier) -> io::Result<PathBuf> {
    let root = canonicalize_local_windows_path(state_logs_root).map_err(|()| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "the log root is not a canonical local Windows path",
        )
    })?;
    Ok(PathBuf::from(root).join(tier.as_str()))
}

/// The exact file one launch writes, and the open that produces its handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleLogTarget {
    path: PathBuf,
}

impl RoleLogTarget {
    /// Composes the log path from a tier log directory and a validated launch identifier.
    ///
    /// Both halves are already closed: the directory came from `tier_log_directory`, and the file name
    /// is bounded hex plus a fixed extension, so there is no string a caller could steer through here.
    pub fn new(tier_log_directory: &Path, launch_id: &LaunchId) -> Self {
        Self {
            path: tier_log_directory.join(launch_id.log_file_name()),
        }
    }

    /// The composed path. Test-only, deliberately: a role's log path is not something the runner reports,
    /// because a refusal frame that named it would put an absolute state path on the wire.
    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Creates the log file and returns an inheritable, append-only handle to it.
    ///
    /// `CREATE_NEW` is the collision control: a launch whose identifier somehow repeated fails here
    /// rather than writing into an existing log. It is also what makes the reparse case uninteresting -
    /// a link planted at this exact name is an existing object, so the open fails.
    ///
    /// `FILE_APPEND_DATA` without `FILE_WRITE_DATA` means every write lands at the end of the file, which
    /// is what lets one handle serve as both the role's standard output and its standard error: two
    /// handles to one file would each carry their own file pointer and overwrite each other.
    ///
    /// `FILE_SHARE_READ | FILE_SHARE_DELETE` lets the owner read a live log and lets owner-side retention
    /// delete one while a role still holds it open. `FILE_SHARE_WRITE` is deliberately absent: nothing but
    /// this launch has any business writing here.
    ///
    /// No security descriptor is passed, so the file's DACL is exactly what the tier log directory's
    /// inheritable ACEs give it - full control for the recovery principals, append for the tier - and no
    /// ACE is written here that the shipped policy did not specify.
    pub fn create_for_role(&self) -> io::Result<OwnedHandle> {
        let wide = to_wide(&self.path);
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        // SAFETY: `wide` is NUL-terminated and outlives the call, the attributes are a valid
        // SECURITY_ATTRIBUTES, and the returned handle is adopted by OwnedHandle below.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_APPEND_DATA | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_DELETE,
                &attributes,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let failure = io::Error::last_os_error();
            // The path is deliberately absent from the refusal, for the same reason `path()` is
            // test-only: this error is returned to `supervise`, which writes it to the runner's standard
            // error, and `launcher::owner::attach_diagnostics` splices that into the failure the owner
            // reports. Naming the file here would put an absolute state path on the wire on every
            // unprovisioned log directory. The OS reason is what an operator needs, and the directory is
            // `<state_logs_root>\<tier>` by construction, so nothing about it has to be quoted back.
            return Err(io::Error::new(
                failure.kind(),
                format!("the role log could not be created: {failure}"),
            ));
        }
        OwnedHandle::new(handle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOG_ROOT: &str = r"C:\ProgramData\SuperClaw\state\logs";

    fn launch_id() -> LaunchId {
        LaunchId::from_pipe_id(&"ab".repeat(16)).expect("32 lowercase hex characters")
    }

    /// The grammar the contract publishes is the one the runner enforces, and it is the hex length of
    /// the pipe identifier the launch already has. If those two ever disagreed, a perfectly good pipe
    /// id would be refused as a launch id and no role could start at all.
    #[test]
    fn the_launch_id_grammar_is_the_pipe_id_the_launcher_draws() {
        assert_eq!(
            shipped_role_log_rules().launch_id_hex_chars,
            crate::launcher::owner::PIPE_ID_BYTES * 2
        );
        assert_eq!(shipped_role_log_rules().extension, ".log");
        let id = LaunchId::from_pipe_id(
            &crate::random_bytes::random_hex(crate::launcher::owner::PIPE_ID_BYTES)
                .expect("the system RNG should be available"),
        )
        .expect("a freshly drawn pipe id is a valid launch id");
        assert_eq!(id.log_file_name().len(), 32 + ".log".len());
    }

    /// Everything a caller might hope to smuggle through the file name, refused before any path is
    /// built. The traversal cases matter most: they are the only way a name could name a file outside
    /// the tier's own log directory.
    #[test]
    fn a_launch_id_that_is_not_bounded_lowercase_hex_is_refused() {
        let thirty_one = "ab".repeat(15) + "a";
        let rejected: [String; 11] = [
            String::new(),
            "ab".to_owned(),
            // One character short, one too long, and the right length in the wrong case.
            "ab".repeat(15),
            "ab".repeat(17),
            "AB".repeat(16),
            // The right length, but one character outside the alphabet in each of three ways.
            format!("{thirty_one}g"),
            format!("{thirty_one} "),
            format!("{thirty_one}\0"),
            // A caller-supplied file name and two caller-supplied paths, at any length.
            "abababababababababababababab.log".to_owned(),
            r"..\..\..\Windows\System32\drivers\etc\hosts".to_owned(),
            "../../secret".to_owned(),
        ];
        for rejected in &rejected {
            assert_eq!(
                LaunchId::from_pipe_id(rejected)
                    .expect_err("only bounded lowercase hex is a launch identifier")
                    .kind(),
                io::ErrorKind::InvalidInput,
                "accepted {rejected:?}"
            );
        }
    }

    /// The derived path is under the tier's own directory, one level down, with the launch id as its
    /// whole stem. Asserted through the composed value rather than by string matching, so a change that
    /// reordered the join fails here.
    #[test]
    fn the_derived_path_is_the_tier_scoped_layout() {
        let id = launch_id();
        for tier in IsolationTier::ALL {
            let directory = tier_log_directory(LOG_ROOT, tier).expect("a canonical log root");
            let target = RoleLogTarget::new(&directory, &id);
            assert_eq!(target.path().parent(), Some(directory.as_path()));
            assert_eq!(
                directory.file_name().and_then(|name| name.to_str()),
                Some(tier.as_str())
            );
            assert_eq!(
                target.path().file_name().and_then(|name| name.to_str()),
                Some(format!("{}.log", id.as_str()).as_str())
            );
            assert!(target.path().starts_with(LOG_ROOT));
        }
    }

    /// A log root a caller spelled to walk somewhere else never becomes a directory to open in.
    #[test]
    fn a_log_root_that_is_not_canonical_is_refused() {
        for rejected in [
            r"C:\ProgramData\SuperClaw\state\..\..\logs",
            r"C:\ProgramData\SuperClaw\state\logs\CON",
            r"C:\",
            r"\\server\share\logs",
            "logs",
            "",
        ] {
            assert_eq!(
                tier_log_directory(rejected, IsolationTier::Bootstrap)
                    .expect_err("only a canonical local path is a log root")
                    .kind(),
                io::ErrorKind::InvalidInput,
                "accepted {rejected:?}"
            );
        }
    }

    /// The open creates the file, appends rather than truncates, and refuses a name that is already
    /// taken. All three in one test because they are one `CreateFileW`.
    #[test]
    fn the_open_creates_appends_and_refuses_a_second_launch_with_the_same_name() {
        use std::io::{Read, Write};

        let directory = std::env::temp_dir().join(format!(
            "superclaw-role-log-{}",
            crate::random_bytes::random_hex(8).expect("rng")
        ));
        std::fs::create_dir_all(&directory).expect("the test owns this directory");
        let target = RoleLogTarget::new(&directory, &launch_id());

        let first = target.create_for_role().expect("the first open creates");
        let mut writer = first.into_file();
        writer.write_all(b"first\n").expect("append");

        // Matched rather than `expect_err`ed because an open handle has no `Debug`, deliberately:
        // printing one would print a raw kernel handle value into a panic message.
        match target.create_for_role() {
            Ok(_) => panic!("a name that already exists is a collision, not a shared log"),
            Err(error) => assert_eq!(error.kind(), io::ErrorKind::AlreadyExists),
        }

        writer.write_all(b"second\n").expect("append again");
        drop(writer);
        let mut written = String::new();
        std::fs::File::open(target.path())
            .expect("the log exists")
            .read_to_string(&mut written)
            .expect("read back");
        assert_eq!(written, "first\nsecond\n");
        std::fs::remove_dir_all(&directory).expect("cleanup");
    }

    /// The handle the role inherits, stated as a property of the handle rather than of the call that
    /// produced it: the role's standard output is bound to this exact handle, so if it were not
    /// inheritable the role would start with no output at all.
    #[test]
    fn the_log_handle_is_inheritable_so_the_role_can_be_given_it() {
        use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};

        let directory = std::env::temp_dir().join(format!(
            "superclaw-role-log-{}",
            crate::random_bytes::random_hex(8).expect("rng")
        ));
        std::fs::create_dir_all(&directory).expect("the test owns this directory");
        let target = RoleLogTarget::new(&directory, &launch_id());
        let handle = target.create_for_role().expect("the open should succeed");

        let mut flags = 0;
        // SAFETY: the handle is open and `flags` points to writable storage.
        assert_ne!(
            unsafe { GetHandleInformation(handle.raw(), &mut flags) },
            0,
            "the log handle should be queryable"
        );
        assert_eq!(flags & HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        drop(handle);
        std::fs::remove_dir_all(&directory).expect("cleanup");
    }

    /// The runner never creates the directory it writes into, so a missing tier directory is a failed
    /// launch rather than a directory the tier made for itself with whatever DACL it would have got.
    #[test]
    fn a_missing_tier_directory_is_a_failure_rather_than_something_the_runner_creates() {
        let directory = std::env::temp_dir().join(format!(
            "superclaw-absent-{}",
            crate::random_bytes::random_hex(8).expect("rng")
        ));
        let target = RoleLogTarget::new(&directory, &launch_id());
        match target.create_for_role() {
            Ok(_) => panic!("P5 pre-creates the tier log directory; the runner must not"),
            Err(error) => {
                assert_eq!(error.kind(), io::ErrorKind::NotFound);
                // This is the failure that reaches the owner's reported error through the runner's
                // standard error, so it is the one that must not name the file. Asserted on the stem
                // and the directory separately, because either half alone would be a state path.
                let reported = error.to_string();
                assert!(
                    !reported.contains(launch_id().as_str())
                        && !reported.contains(&directory.display().to_string()),
                    "a refusal must not put an absolute state path on the wire: {reported}"
                );
            }
        }
        assert!(!directory.exists(), "the runner created a parent directory");
    }
}
