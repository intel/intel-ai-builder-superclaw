//! The user-profile folders between the profile root and `backend_root`, and the read-only check that
//! one of them carries the single ACE the descriptor adds to it.
//!
//! Shared by provision, revoke and the unelevated readback. No environment lookup and no caller-chosen
//! depth: the folder names come from the descriptor's fixed chain, the folders themselves from the
//! backend root's own path. Nothing here writes; `profile_ancestor_apply` is the elevated half.

use crate::acl_descriptor::{ExpectedAce, ProfileAncestorGrant};
use crate::managed_root_dacl::read_decodable_dacl;
use crate::managed_root_path::open_managed_root_for_read_control;
use std::path::{Path, PathBuf};

/// The folder for each grant, parents first, or `None` when `backend` is not
/// `<profile>\<deepest declared ancestor>\backend`.
///
/// `None` is a refusal to derive, never a guess: a backend placed anywhere else has no profile
/// ancestors this side recognises. The profile root must itself be a named directory, so neither the
/// volume root nor the folder holding every profile can come out of this, and the profile root is never
/// in the result.
pub fn derive(backend: &Path, grants: &[ProfileAncestorGrant]) -> Option<Vec<PathBuf>> {
    let named = |path: &Path, name: &str| {
        path.file_name()
            .is_some_and(|value| value.to_string_lossy().eq_ignore_ascii_case(name))
    };
    if !backend.is_absolute() || !named(backend, "backend") {
        return None;
    }
    let deepest = grants
        .last()?
        .profile_relative_path
        .split('/')
        .collect::<Vec<_>>();
    let chain: Vec<&Path> = backend.ancestors().skip(1).take(deepest.len()).collect();
    if chain.len() != deepest.len()
        || !chain
            .iter()
            .zip(deepest.iter().rev())
            .all(|(path, name)| named(path, name))
    {
        return None;
    }
    chain.last()?.parent()?.file_name()?;
    // The contract checks the chain is contiguous; restated so a malformed one cannot pick a folder.
    if grants.len() != chain.len()
        || grants
            .iter()
            .enumerate()
            .any(|(index, grant)| grant.profile_relative_path.split('/').count() != index + 1)
    {
        return None;
    }
    Some(chain.into_iter().rev().map(Path::to_path_buf).collect())
}

/// Whether `path` carries `ace` naming `sid`, read with `READ_CONTROL` only.
///
/// Presence and nothing more: every other ACE on a profile folder belongs to the user profile and is
/// none of this side's business, including one of a type the reader cannot decode. The error is a
/// `(code, detail)` pair that names no path.
pub fn carries_grant(
    path: &Path,
    ace: &ExpectedAce,
    sid: &str,
) -> Result<bool, (&'static str, String)> {
    let handle = open_managed_root_for_read_control(path)
        .map_err(|refusal| (refusal.code(), refusal.detail()))?;
    let dacl = read_decodable_dacl(&handle).map_err(|drift| (drift.code(), drift.detail()))?;
    Ok(dacl.aces.iter().any(|observed| {
        observed.allow == ace.allow
            && observed.mask == ace.mask
            && observed.flags == ace.flags
            && observed.sid == sid
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acl_descriptor::profile_ancestor_grants;

    fn grants() -> Vec<ProfileAncestorGrant> {
        profile_ancestor_grants().expect("the shipped grants")
    }

    #[test]
    fn derives_the_three_folders_between_profile_and_backend() {
        let derived = derive(
            Path::new(r"C:\Users\someone\AppData\Local\SuperClaw\backend"),
            &grants(),
        );
        assert_eq!(
            derived,
            Some(vec![
                PathBuf::from(r"C:\Users\someone\AppData"),
                PathBuf::from(r"C:\Users\someone\AppData\Local"),
                PathBuf::from(r"C:\Users\someone\AppData\Local\SuperClaw"),
            ])
        );
        let mixed = derive(
            Path::new(r"D:\Profiles\x\appdata\LOCAL\superclaw\Backend"),
            &grants(),
        );
        assert_eq!(
            mixed.map(|paths| paths[0].clone()),
            Some(PathBuf::from(r"D:\Profiles\x\appdata"))
        );
    }

    #[test]
    fn never_yields_the_volume_root_the_profiles_folder_or_the_profile_root() {
        let derived = derive(
            Path::new(r"C:\Users\someone\AppData\Local\SuperClaw\backend"),
            &grants(),
        )
        .expect("the fixed shape derives");
        for refused in [r"C:\", r"C:\Users", r"C:\Users\someone"] {
            assert!(!derived.contains(&PathBuf::from(refused)), "{refused}");
        }
        assert_eq!(
            derive(Path::new(r"C:\AppData\Local\SuperClaw\backend"), &grants()),
            None,
            "a profile at the volume root is not a profile"
        );
    }

    #[test]
    fn refuses_every_other_backend_location() {
        for backend in [
            r"C:\ProgramData\SuperClaw-p6-gate\backend",
            r"C:\Users\someone\AppData\Local\SuperClaw\state",
            r"C:\Users\someone\AppData\Roaming\SuperClaw\backend",
            r"C:\Users\someone\AppData\Local\Other\backend",
            r"C:\Users\someone\Local\SuperClaw\backend",
            r"Users\someone\AppData\Local\SuperClaw\backend",
            r"\\server\share\AppData\Local\SuperClaw\backend",
        ] {
            assert_eq!(derive(Path::new(backend), &grants()), None, "{backend}");
        }
    }

    #[test]
    fn refuses_a_chain_that_is_not_contiguous() {
        let mut gapped = grants();
        gapped.remove(1);
        assert_eq!(
            derive(
                Path::new(r"C:\Users\someone\AppData\Local\SuperClaw\backend"),
                &gapped
            ),
            None
        );
        assert_eq!(
            derive(
                Path::new(r"C:\Users\x\AppData\Local\SuperClaw\backend"),
                &[]
            ),
            None
        );
    }
}
