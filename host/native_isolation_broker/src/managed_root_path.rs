//! Whole-chain path guards for managed roots: shape, depth, reparse state and object type.
//!
//! # The gap this closes
//!
//! Before this module the ACL path checks were string-only. `workspace_grant.rs` refused a
//! `relative_path` containing `..` and a `tier` containing a separator, and
//! `security_descriptor::verify_plain_handle` refused a reparse point on the *final* object. Nothing
//! looked at the components in between, and the observation the broker emitted asserted
//! `"is_reparse_point": false` rather than measuring it.
//!
//! That leaves a real attack. A managed root is `…\SuperClaw\isolation\data\<something>`; if the
//! owner can replace any *directory above* the leaf with a junction, then a path that passes every
//! string check resolves somewhere else entirely, and an elevated `WRITE_DAC` lands on an object the
//! owner chose. So every component from the volume root down is opened and checked here, and both
//! the elevated apply and the unelevated readback go through it.
//!
//! # Why the volume root is not checked
//!
//! A volume root is the one component every path on a volume shares and the one component NTFS never
//! tags as a reparse point: a mount point is a *directory inside* a volume, so `C:\mnt` is checked
//! and `C:\` is not. Checking it would add a syscall that can only ever succeed.
//!
//! # What this module deliberately cannot do
//!
//! Nothing here asks for `WRITE_DAC` or `WRITE_OWNER`. The strongest access it requests is
//! `READ_CONTROL`, and the chain walk asks for no access at all - only the query-attributes access
//! `CreateFileW` grants for free. That is what lets the unelevated launcher share this code with the
//! elevated broker: see `launcher_main.rs`, whose module closure includes this file and excludes
//! `security_descriptor.rs`.
//!
//! # Why the chain walk is not the guarantee
//!
//! The walk opens each component by *name* and closes it again, so between the walk and whoever opens
//! the leaf next, every one of those names can be repointed. It is a cheap early refusal and nothing
//! more. What actually binds a decision to an object is `verify_handle_is_path`: it asks the kernel
//! which path the handle it already holds resolves to, and refuses unless that is the path that was
//! requested. That question cannot be raced, because the handle *is* the object - a rename after the
//! call cannot retroactively change which object the handle refers to.

use crate::process_win32::OwnedHandle;
use crate::wide::to_wide;
use std::io;
use std::mem::size_of;
use std::path::{Component, Path, PathBuf, Prefix};
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_NORMALIZED,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileAttributeTagInfo,
    GetFileInformationByHandleEx, GetFinalPathNameByHandleW, OPEN_EXISTING, READ_CONTROL,
    VOLUME_NAME_DOS,
};

/// The `\\?\` prefix `GetFinalPathNameByHandleW` puts on every path it returns.
const VERBATIM_PREFIX: &str = "\\\\?\\";

/// How deep a managed root may be. Well past any real workspace or state path, and low enough that a
/// pathological plan cannot make the chain walk into thousands of opens.
pub const MAX_MANAGED_PATH_COMPONENTS: usize = 64;

/// Why a managed-root path was refused. One code per class, because "this path is shaped wrong" and
/// "something on this path is a junction" are different findings and a caller has to be able to tell
/// them apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedPathRefusal {
    NotAbsolute,
    TooDeep {
        components: usize,
        limit: usize,
    },
    ComponentNotNormal,
    ReparsePointInPath,
    /// The handle that was opened does not refer to the path that was asked for.
    ///
    /// Every name check in this module is a check on a string, and a string is re-resolved by whoever
    /// opens it next. This refusal is what the checks are worth: the kernel was asked, about a handle
    /// already held, which object it actually points at.
    PathIdentityMismatch,
    ObjectTypeMismatch,
    Unreadable {
        kind: UnreadableKind,
        message: String,
    },
}

/// The `io::ErrorKind` an `Unreadable` refusal came from, kept as a closed set so this type stays
/// comparable in tests and so mapping back to `io::Error` cannot invent a kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnreadableKind {
    NotFound,
    PermissionDenied,
    Other,
}

impl ManagedPathRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotAbsolute => "managed_path_not_absolute",
            Self::TooDeep { .. } => "managed_path_too_deep",
            Self::ComponentNotNormal => "managed_path_component_not_normal",
            Self::ReparsePointInPath => "managed_path_reparse_point",
            Self::PathIdentityMismatch => "managed_path_identity_mismatch",
            Self::ObjectTypeMismatch => "managed_path_object_type",
            Self::Unreadable { .. } => "managed_path_unreadable",
        }
    }

    /// Human-readable detail that never contains the path.
    ///
    /// A refusal is logged and handed around, and a managed root is an absolute path in the owner's
    /// profile. The locator a caller needs is the placeholder name, which the caller already knows,
    /// so this says what went wrong and not where.
    pub fn detail(&self) -> String {
        match self {
            Self::NotAbsolute => {
                "a managed root must be an absolute path on a local volume".to_owned()
            }
            Self::TooDeep { components, limit } => {
                format!("a managed root of {components} components exceeds the limit of {limit}")
            }
            Self::ComponentNotNormal => {
                "a managed root must contain only plain path components".to_owned()
            }
            Self::ReparsePointInPath => {
                "a component of this managed root is a reparse point".to_owned()
            }
            Self::PathIdentityMismatch => {
                "the object opened here is not the managed root that was requested".to_owned()
            }
            Self::ObjectTypeMismatch => "this managed root has the wrong object type".to_owned(),
            Self::Unreadable { message, .. } => {
                format!("this managed root could not be opened for inspection: {message}")
            }
        }
    }
}

impl From<ManagedPathRefusal> for io::Error {
    fn from(refusal: ManagedPathRefusal) -> Self {
        let kind = match &refusal {
            ManagedPathRefusal::ReparsePointInPath | ManagedPathRefusal::PathIdentityMismatch => {
                io::ErrorKind::PermissionDenied
            }
            ManagedPathRefusal::Unreadable { kind, .. } => match kind {
                UnreadableKind::NotFound => io::ErrorKind::NotFound,
                UnreadableKind::PermissionDenied => io::ErrorKind::PermissionDenied,
                UnreadableKind::Other => io::ErrorKind::Other,
            },
            _ => io::ErrorKind::InvalidInput,
        };
        io::Error::new(kind, format!("{}: {}", refusal.code(), refusal.detail()))
    }
}

fn unreadable(error: io::Error) -> ManagedPathRefusal {
    let kind = match error.kind() {
        io::ErrorKind::NotFound => UnreadableKind::NotFound,
        io::ErrorKind::PermissionDenied => UnreadableKind::PermissionDenied,
        _ => UnreadableKind::Other,
    };
    ManagedPathRefusal::Unreadable {
        kind,
        message: error.to_string(),
    }
}

/// Refuses anything that is not an absolute path on a local disk made of plain components.
///
/// UNC, verbatim (`\\?\`) and device prefixes are refused along with `.` and `..`: a managed root is
/// always a local directory this product created, and every other shape is either something the
/// checks below cannot reason about or a way to say the same path twice.
pub fn validate_managed_path_shape(path: &Path) -> Result<(), ManagedPathRefusal> {
    let mut components = path.components();
    match components.next() {
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)) => {}
        _ => return Err(ManagedPathRefusal::NotAbsolute),
    }
    if components.next() != Some(Component::RootDir) {
        return Err(ManagedPathRefusal::NotAbsolute);
    }
    let mut count = 2usize;
    for component in components {
        if !matches!(component, Component::Normal(_)) {
            return Err(ManagedPathRefusal::ComponentNotNormal);
        }
        count += 1;
        if count > MAX_MANAGED_PATH_COMPONENTS {
            return Err(ManagedPathRefusal::TooDeep {
                components: count,
                limit: MAX_MANAGED_PATH_COMPONENTS,
            });
        }
    }
    if count < 3 {
        // A bare volume root is not a managed root; refusing it here keeps the chain walk from
        // being asked to prove something about a component it deliberately does not check.
        return Err(ManagedPathRefusal::NotAbsolute);
    }
    Ok(())
}

/// Opens every component of `path` below the volume root and refuses if any is a reparse point.
///
/// The final component is included, so a caller that has run this does not need a separate leaf
/// check for reparse state.
pub fn verify_managed_path_chain(path: &Path) -> Result<(), ManagedPathRefusal> {
    validate_managed_path_shape(path)?;
    let mut chain: Vec<&Path> = path
        .ancestors()
        .filter(|ancestor| ancestor.parent().is_some())
        .collect();
    chain.reverse();
    for component_path in chain {
        if attributes_of(component_path)? & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(ManagedPathRefusal::ReparsePointInPath);
        }
    }
    Ok(())
}

/// The measured reparse state of the object at `path` itself, after the whole chain has been checked.
///
/// This exists so an observation can report a measurement rather than an assertion. It is always
/// `false` when it returns `Ok`, because the chain walk refuses a reparse point before this can be
/// reached; that is the point. The value used to be a literal in the observation JSON, which meant a
/// junction would have been reported as "not a junction" by the very receipt that proves the apply
/// was safe.
pub fn measure_reparse_state(path: &Path) -> Result<bool, ManagedPathRefusal> {
    verify_managed_path_chain(path)?;
    Ok(attributes_of(path)? & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

/// Opens a managed root for DACL *reading* only, after checking its whole chain.
///
/// `READ_CONTROL` and nothing else. This is the strongest access the unelevated drift check is
/// allowed to hold, and asking for exactly it is what makes "the launcher cannot repair a drifted
/// DACL, only report it" a property of the handle rather than a promise in a comment.
pub fn open_managed_root_for_read_control(path: &Path) -> Result<OwnedHandle, ManagedPathRefusal> {
    verify_managed_path_chain(path)?;
    let handle = open_path(path, READ_CONTROL)?;
    verify_managed_directory_handle(handle.raw(), path)?;
    Ok(handle)
}

/// The checks every managed-root handle must pass, whatever access it was opened for.
///
/// Identity first, then object type. A handle that turned out to be a different object than the one
/// requested should be refused as such rather than as "the wrong object type", because the two say very
/// different things about what happened.
pub fn verify_managed_directory_handle(
    handle: HANDLE,
    requested: &Path,
) -> Result<(), ManagedPathRefusal> {
    verify_handle_is_path(handle, requested)?;
    let attributes = attributes_of_handle(handle)?;
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(ManagedPathRefusal::ReparsePointInPath);
    }
    if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(ManagedPathRefusal::ObjectTypeMismatch);
    }
    Ok(())
}

/// Refuses `handle` unless the kernel says it refers to exactly `requested`.
///
/// This is the one check in the module that a rename cannot defeat. `verify_managed_path_chain` proves
/// something about names at the moment it runs and nothing afterwards; asking an open handle for its own
/// path proves something about the object, and the answer stays true for as long as the handle is held.
/// So a junction swapped in after the walk and before the open is caught here: the handle resolves to the
/// junction's target, which is not the path that was asked for.
///
/// Refusing is deliberately strict. Comparison is component by component and case-insensitive over ASCII
/// only, which means a short (8.3) name, a `subst` drive or an unusual spelling of a non-ASCII component
/// is refused rather than normalized. A managed root is a path this product built out of a profile
/// directory and fixed segments, so every one of those is a caller doing something it has no reason to do.
pub fn verify_handle_is_path(handle: HANDLE, requested: &Path) -> Result<(), ManagedPathRefusal> {
    let resolved = handle_final_path(handle)?;
    if !same_managed_path(&resolved, requested) {
        return Err(ManagedPathRefusal::PathIdentityMismatch);
    }
    Ok(())
}

/// The path the kernel resolves `handle` to, with the `\\?\` prefix stripped.
fn handle_final_path(handle: HANDLE) -> Result<PathBuf, ManagedPathRefusal> {
    // One more than the longest path `validate_managed_path_shape` can have accepted, so the common case
    // is a single call and a hostile depth still cannot make this allocate without bound.
    let mut buffer = vec![0u16; 1024];
    loop {
        // SAFETY: `handle` is a live handle this process owns and `buffer` is a writable buffer whose
        // declared length matches its allocation.
        let written = unsafe {
            GetFinalPathNameByHandleW(
                handle,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if written == 0 {
            return Err(unreadable(io::Error::last_os_error()));
        }
        if written < buffer.len() {
            buffer.truncate(written);
            break;
        }
        if written > 1 << 16 {
            return Err(unreadable(io::Error::new(
                io::ErrorKind::InvalidData,
                "the resolved path of this handle is implausibly long",
            )));
        }
        // `written` includes the terminator when the buffer was too small, so this always grows.
        buffer = vec![0u16; written + 1];
    }
    let text = String::from_utf16(&buffer).map_err(|_| {
        unreadable(io::Error::new(
            io::ErrorKind::InvalidData,
            "the resolved path of this handle is not valid UTF-16",
        ))
    })?;
    Ok(PathBuf::from(
        text.strip_prefix(VERBATIM_PREFIX).unwrap_or(&text),
    ))
}

/// Whether two managed paths name the same object, comparing component by component.
///
/// Deliberately strict. Only ASCII case is folded, so an 8.3 spelling, a `subst` drive or an unusual
/// non-ASCII spelling of the same directory compares unequal and is refused rather than normalized. A
/// comparison that tried to be clever here would be deciding, on the elevated side, that two names it
/// cannot fully reason about mean the same object.
pub fn same_managed_path(left: &Path, right: &Path) -> bool {
    let mut left = left.components();
    let mut right = right.components();
    loop {
        match (left.next(), right.next()) {
            (None, None) => return true,
            (Some(one), Some(other)) => {
                let one = one.as_os_str().to_string_lossy();
                let other = other.as_os_str().to_string_lossy();
                if !one.eq_ignore_ascii_case(&other) {
                    return false;
                }
            }
            _ => return false,
        }
    }
}

fn attributes_of(path: &Path) -> Result<u32, ManagedPathRefusal> {
    attributes_of_handle(open_path(path, 0)?.raw())
}

/// Opens one path without following a reparse point at the end of it.
///
/// `desired_access` is `0` for the chain walk: `CreateFileW` still grants the query-attributes access
/// that `GetFileInformationByHandleEx` needs, so the walk can inspect a component without holding any
/// right on it. Sharing is fully permissive because this only ever reads metadata and must not lock
/// out the very tree the product is about to use.
fn open_path(path: &Path, desired_access: u32) -> Result<OwnedHandle, ManagedPathRefusal> {
    let wide = to_wide(path);
    // SAFETY: `wide` is a null-terminated UTF-16 buffer that outlives the call, and every other
    // argument is a plain value or a null the API documents as optional.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            desired_access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(unreadable(io::Error::last_os_error()));
    }
    OwnedHandle::new(handle).map_err(unreadable)
}

fn attributes_of_handle(handle: HANDLE) -> Result<u32, ManagedPathRefusal> {
    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: `handle` is a live handle this process owns, and the buffer and its declared size
    // describe the same local `FILE_ATTRIBUTE_TAG_INFO`.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            (&raw mut info).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(unreadable(io::Error::last_os_error()));
    }
    Ok(info.FileAttributes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(label: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is after the epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "superclaw-managed-path-{label}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn only_an_absolute_local_path_of_plain_components_is_a_managed_root() {
        validate_managed_path_shape(Path::new("C:\\ProgramData\\SuperClaw\\isolation"))
            .expect("a plain absolute path is the shape a managed root has");
        for refused in [
            "relative\\path",
            "\\\\server\\share\\dir",
            "\\\\?\\C:\\dir",
            "C:\\",
            "C:",
        ] {
            assert!(
                validate_managed_path_shape(Path::new(refused)).is_err(),
                "accepted {refused}"
            );
        }
        assert_eq!(
            validate_managed_path_shape(Path::new("C:\\dir\\..\\other")),
            Err(ManagedPathRefusal::ComponentNotNormal)
        );
    }

    #[test]
    fn a_path_deeper_than_the_limit_is_refused_before_it_is_walked() {
        let deep = format!("C:\\{}", "a\\".repeat(MAX_MANAGED_PATH_COMPONENTS + 4));
        assert!(matches!(
            validate_managed_path_shape(Path::new(&deep)),
            Err(ManagedPathRefusal::TooDeep { .. })
        ));
    }

    /// The whole point of the module: a junction *above* the leaf is refused, even though every
    /// string check passes and the leaf itself is an ordinary directory.
    #[test]
    fn a_reparse_point_anywhere_in_the_chain_is_refused() {
        let root = temp_root("chain");
        let real = root.join("real");
        let leaf = root.join("link").join("leaf");
        fs::create_dir_all(real.join("leaf")).expect("the real tree should be creatable");
        assert!(
            verify_managed_path_chain(&real.join("leaf")).is_ok(),
            "an ordinary tree must pass"
        );

        let linked = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(root.join("link"))
            .arg(&real)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if linked {
            assert_eq!(
                verify_managed_path_chain(&leaf),
                Err(ManagedPathRefusal::ReparsePointInPath),
                "a junction above the leaf must be refused"
            );
            // A handle is not comparable, so the refusal is compared and the success case is not
            // reachable here by construction.
            assert_eq!(
                open_managed_root_for_read_control(&leaf).err(),
                Some(ManagedPathRefusal::ReparsePointInPath)
            );
            assert_eq!(
                verify_managed_path_chain(&root.join("link")),
                Err(ManagedPathRefusal::ReparsePointInPath),
                "the junction itself must be refused as the leaf too"
            );
        }
        fs::remove_dir_all(&root).ok();
    }

    /// What the chain walk cannot do, and why the handle is asked instead.
    ///
    /// This opens a handle through a junction directly, which is exactly the state a caller reaches by
    /// swapping the junction in *after* the walk has passed and before the open. The walk is not run here
    /// on purpose: the point is that the open on its own is not evidence, and that asking the handle where
    /// it landed turns a race that used to be invisible into a refusal.
    #[test]
    fn a_handle_that_resolved_through_a_junction_is_refused_by_its_own_path() {
        let root = temp_root("identity");
        let real = root.join("real");
        fs::create_dir_all(real.join("leaf")).expect("the real tree should be creatable");
        let linked = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(root.join("link"))
            .arg(&real)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if linked {
            let requested = root.join("link").join("leaf");
            let handle = open_path(&requested, 0).expect("the leaf opens through the junction");
            assert_eq!(
                verify_handle_is_path(handle.raw(), &requested),
                Err(ManagedPathRefusal::PathIdentityMismatch),
                "the handle resolved to the junction target, not to the path that was asked for"
            );
            // The positive half, so the check cannot be passing vacuously: the same leaf reached by its
            // real name proves its own identity.
            let honest = real.join("leaf");
            let handle = open_path(&honest, 0).expect("the real leaf opens");
            assert_eq!(verify_handle_is_path(handle.raw(), &honest), Ok(()));
            // Case differences in an ASCII component are the same object and must not be refused.
            let shouted = PathBuf::from(honest.display().to_string().to_uppercase());
            assert_eq!(verify_handle_is_path(handle.raw(), &shouted), Ok(()));
        }
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_missing_component_is_unreadable_rather_than_silently_accepted() {
        let missing = temp_root("missing");
        assert!(matches!(
            verify_managed_path_chain(&missing.join("child")),
            Err(ManagedPathRefusal::Unreadable {
                kind: UnreadableKind::NotFound,
                ..
            })
        ));
    }

    #[test]
    fn the_read_control_handle_refuses_a_file_and_measures_a_real_directory() {
        let root = temp_root("readcontrol");
        fs::create_dir_all(&root).expect("the directory should be creatable");
        let file = root.join("file.txt");
        fs::write(&file, b"managed").expect("the file should be writable");

        open_managed_root_for_read_control(&root).expect("a directory opens for READ_CONTROL");
        assert_eq!(
            open_managed_root_for_read_control(&file).err(),
            Some(ManagedPathRefusal::ObjectTypeMismatch),
            "a managed root is a directory, so a file must be refused"
        );
        assert!(
            !measure_reparse_state(&root).expect("an ordinary directory measures"),
            "the observation reports a measurement, and this tree really is not a junction"
        );
        fs::remove_dir_all(&root).ok();
    }

    /// Refusal detail is logged and handed around, so it must never carry the absolute path.
    #[test]
    fn no_refusal_detail_names_a_path() {
        let refusals = [
            ManagedPathRefusal::NotAbsolute,
            ManagedPathRefusal::TooDeep {
                components: 99,
                limit: MAX_MANAGED_PATH_COMPONENTS,
            },
            ManagedPathRefusal::ComponentNotNormal,
            ManagedPathRefusal::ReparsePointInPath,
            ManagedPathRefusal::PathIdentityMismatch,
            ManagedPathRefusal::ObjectTypeMismatch,
        ];
        for refusal in refusals {
            let detail = refusal.detail();
            assert!(
                !detail.contains(':'),
                "{} leaks a drive letter",
                refusal.code()
            );
            assert!(!detail.contains('\\'), "{} leaks a path", refusal.code());
        }
    }

    #[test]
    fn every_refusal_class_has_its_own_code_and_a_sensible_error_kind() {
        assert_eq!(
            io::Error::from(ManagedPathRefusal::ReparsePointInPath).kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            io::Error::from(ManagedPathRefusal::PathIdentityMismatch).kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            io::Error::from(ManagedPathRefusal::ComponentNotNormal).kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            io::Error::from(ManagedPathRefusal::Unreadable {
                kind: UnreadableKind::NotFound,
                message: "gone".to_owned(),
            })
            .kind(),
            io::ErrorKind::NotFound
        );
    }
}
