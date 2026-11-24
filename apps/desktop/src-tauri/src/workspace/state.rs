use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::types::{
    WorkspaceInfo, WorkspaceState, WorkspaceType, DEFAULT_CONTAINER_PATH, WORKSPACE_STATE_VERSION,
};

pub fn stable_workspace_id(path: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    format!("ws-{:x}", hasher.finish())
}

pub fn openwork_state_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let file_path = data_dir.join("openwork-workspaces.json");
    Ok((data_dir, file_path))
}

pub fn load_workspace_state(app: &tauri::AppHandle) -> Result<WorkspaceState, String> {
    let (_, path) = openwork_state_paths(app)?;
    if !path.exists() {
        return Ok(WorkspaceState::default());
    }

    let raw =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let mut state: WorkspaceState = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;

    if state.version < WORKSPACE_STATE_VERSION {
        migrate_workspace_state(&mut state);
        state.version = WORKSPACE_STATE_VERSION;
    }

    Ok(state)
}

/// Apply in-place migrations to bring an older `WorkspaceState` up to the
/// current schema. Each migration step is keyed off the from-version so we
/// only touch fields that need it.
fn migrate_workspace_state(state: &mut WorkspaceState) {
    // v4 → v5: introduce `container_path`. Local workspaces get the
    // backend-manager default fallback (container-side mount path); remote
    // workspaces leave it as None — their `directory` field already encodes
    // the equivalent meaning. See docs/fixes/2026-04-30-windows-path-leak/.
    if state.version < 5 {
        for ws in state.workspaces.iter_mut() {
            if ws.container_path.is_none() && ws.workspace_type == WorkspaceType::Local {
                ws.container_path = Some(DEFAULT_CONTAINER_PATH.to_string());
            }
        }
    }

    if state.version < 6 {
        migrate_workspace_state_v5_to_v6(state);
    }
}

// v5 → v6: rewrite workspace ids to their canonical form (using the
// post-fix `normalize_host_url` so `localhost` and `127.0.0.1` resolve to
// the same id), then dedupe by id.
//
// Pre-fix, `stable_workspace_id_for_openwork` hashed the URL verbatim, so
// the same backend reachable as `localhost:8787` and `127.0.0.1:8787`
// produced two distinct ids and the dedupe layer (which compares ids)
// never collapsed them. Just removing the dup row isn't enough — if we
// keep the legacy id on the surviving entry, the next
// `workspace_create_remote` call computes the canonical id, doesn't match
// the legacy id, and silently re-introduces the duplicate.
//
// Rewriting ids can make every duplicate share `state.active_id`, so we
// capture the active entry's original index before the rewrite and use that
// to preserve the user's selected workspace fields during dedupe.
fn migrate_workspace_state_v5_to_v6(state: &mut WorkspaceState) {
    use std::collections::HashMap;

    let active_idx_before_rewrite = state
        .workspaces
        .iter()
        .position(|ws| ws.id == state.active_id);

    for ws in state.workspaces.iter_mut() {
        if let Some(canonical) = canonical_id_for(ws) {
            if ws.id != canonical {
                if state.active_id == ws.id {
                    state.active_id = canonical.clone();
                }
                ws.id = canonical;
            }
        }
    }

    let mut keeper_idx_by_id: HashMap<String, usize> = HashMap::new();
    let mut to_remove: Vec<usize> = Vec::new();
    for (idx, ws) in state.workspaces.iter().enumerate() {
        if let Some(&existing_idx) = keeper_idx_by_id.get(&ws.id) {
            if Some(idx) == active_idx_before_rewrite
                && Some(existing_idx) != active_idx_before_rewrite
            {
                to_remove.push(existing_idx);
                keeper_idx_by_id.insert(ws.id.clone(), idx);
            } else {
                to_remove.push(idx);
            }
        } else {
            keeper_idx_by_id.insert(ws.id.clone(), idx);
        }
    }

    if !to_remove.is_empty() {
        to_remove.sort_by(|a, b| b.cmp(a));
        for idx in to_remove {
            state.workspaces.remove(idx);
        }
    }
}

/// Compute the canonical workspace id for an entry — i.e. what the current
/// `workspace_create_*` paths would assign if this workspace were registered
/// today. Returns `None` when there isn't enough information to canonicalize
/// (e.g. a remote workspace with no URL fields at all), so the caller leaves
/// the existing id alone.
///
/// Kept in lockstep with `workspace_create` (local), `workspace_create_remote`
/// (remote/openwork), and `ensure_starter_workspace` so the migration's
/// rewrite agrees with what every other create path computes.
fn canonical_id_for(ws: &WorkspaceInfo) -> Option<String> {
    match ws.workspace_type {
        WorkspaceType::Local => Some(stable_workspace_id(&ws.path)),
        WorkspaceType::Remote => {
            if let Some(host_url) = ws.openwork_host_url.as_deref() {
                Some(stable_workspace_id_for_openwork(
                    host_url,
                    ws.openwork_workspace_id.as_deref(),
                ))
            } else if let Some(base_url) = ws.base_url.as_deref() {
                Some(stable_workspace_id_for_remote(
                    base_url,
                    ws.directory.as_deref(),
                ))
            } else {
                None
            }
        }
    }
}

pub fn save_workspace_state(app: &tauri::AppHandle, state: &WorkspaceState) -> Result<(), String> {
    let (dir, path) = openwork_state_paths(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    fs::write(
        &path,
        serde_json::to_string_pretty(state).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

/// One-time cleanup for the auto-created local "Starter" workspace, which
/// this app no longer creates (see the removal of `ensure_starter_workspace`,
/// 2026-09-07). Older installs may still have that exact entry registered
/// (with a stale on-disk `.opencode` folder that predates the
/// chrome-devtools-mcp removal and is never refreshed once seeded). Rather
/// than migrating that stale content in place, this deregisters the entry
/// and deletes its folder outright — it was never user-facing content the
/// user deliberately created.
///
/// Matches only the specific legacy entry pinned to the app-managed starter
/// folder — by its `path`, or by the `id` that `workspace_create` would have
/// derived from that same path — NOT every entry with `preset == "starter"`.
/// `"starter"` is also the default preset `workspace_create` assigns when a
/// caller passes an empty preset, so an entry can legitimately carry that
/// preset while living at a user-chosen folder; matching on preset alone
/// would wrongly deregister (and delete the folder of) such an entry. The
/// on-disk folder is only removed once the legacy entry has actually been
/// found/removed, so we never touch disk for a workspace we didn't own.
///
/// Idempotent: a no-op once the entry/folder are gone (e.g. on every launch
/// after the first, or on a fresh install that never had one).
pub fn remove_legacy_starter_workspace(
    app: &tauri::AppHandle,
    state: &mut WorkspaceState,
) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let starter_dir = data_dir.join("workspaces").join("starter");
    remove_legacy_starter_workspace_at(state, &starter_dir)
}

/// Pure, testable core of [`remove_legacy_starter_workspace`]: takes the
/// resolved starter folder path directly instead of an `AppHandle` so it
/// can be exercised in unit tests without a Tauri runtime.
fn remove_legacy_starter_workspace_at(
    state: &mut WorkspaceState,
    starter_dir: &Path,
) -> Result<(), String> {
    let starter_dir_str = starter_dir.to_string_lossy().into_owned();
    let starter_id = stable_workspace_id(&starter_dir_str);

    let before = state.workspaces.len();
    state
        .workspaces
        .retain(|ws| ws.id != starter_id && ws.path != starter_dir_str);
    let legacy_entry_removed = before != state.workspaces.len();

    if legacy_entry_removed && !state.workspaces.iter().any(|ws| ws.id == state.active_id) {
        state.active_id = state
            .workspaces
            .first()
            .map(|entry| entry.id.clone())
            .unwrap_or_else(|| "".to_string());
    }

    // Only delete the on-disk folder once we've confirmed the legacy entry
    // was actually the one registered here — never touch disk for a folder we
    // didn't own. Best-effort: a transient failure (permissions / AV lock)
    // must not abort bootstrap or block persisting the state cleanup above,
    // so log and continue rather than propagating the error.
    if legacy_entry_removed && starter_dir.exists() {
        if let Err(e) = fs::remove_dir_all(starter_dir) {
            tracing::warn!(
                component = "workspace",
                stage = "legacy_starter_cleanup",
                path = %starter_dir.display(),
                error = %e,
                "failed to delete legacy starter folder; leaving it on disk \
                 (state cleanup still persisted)"
            );
        }
    }

    Ok(())
}

/// Deregister workspaces created by the retired Docker sandbox backend
/// (`sandboxBackend: "docker"`). Their stored URL points at a container that
/// no longer exists, and an active one would send the backend-ready token
/// refresh to that dead URL instead of the native workspace.
///
/// When the active workspace is dropped, the first remaining workspace becomes
/// active. Logs one line per removed id and returns the ids. Idempotent: a
/// no-op once the entries are gone.
pub fn remove_retired_docker_workspaces(state: &mut WorkspaceState) -> Vec<String> {
    let removed: Vec<String> = state
        .workspaces
        .iter()
        .filter(|ws| ws.sandbox_backend.as_deref() == Some("docker"))
        .map(|ws| ws.id.clone())
        .collect();
    if removed.is_empty() {
        return removed;
    }

    state
        .workspaces
        .retain(|ws| ws.sandbox_backend.as_deref() != Some("docker"));
    for id in &removed {
        tracing::info!(
            component = "workspace",
            stage = "retired_docker_workspace_removed",
            workspace_id = %id,
            "removed a workspace of the retired Docker sandbox backend"
        );
    }

    if !state.workspaces.iter().any(|ws| ws.id == state.active_id) {
        state.active_id = state
            .workspaces
            .first()
            .map(|entry| entry.id.clone())
            .unwrap_or_default();
    }

    removed
}

/// Resolve the container-side workspace path for a newly-created local
/// workspace. Queries sandbox_manager's `GET /agent/sandbox/config` through the
/// ServiceHub proxy if reachable; falls back to `DEFAULT_CONTAINER_PATH` if not
/// (e.g. workspace created before ServiceHub finished booting).
///
/// See `docs/fixes/2026-04-30-windows-path-leak/` for context.
pub fn resolve_container_path(app: &tauri::AppHandle) -> String {
    app.try_state::<crate::servicehub::manager::ServiceHubManager>()
        .and_then(|manager| {
            crate::servicehub::sandbox_proxy::fetch_workspace_container_path(&manager).ok()
        })
        .unwrap_or_else(|| DEFAULT_CONTAINER_PATH.to_string())
}

/// Canonicalize a URL for stable-id hashing.
///
/// Two URLs that resolve to the same backend should produce the same
/// stable id; otherwise the dedupe layer above (which compares ids) lets
/// the same backend register twice. This was happening with
/// `http://localhost:8787` vs `http://127.0.0.1:8787` — both point at the
/// same local backend, but the verbatim hash treated them as
/// distinct, leaving the user with two "workspace" entries in the sidebar
/// (see openwork-workspaces.json:24-61 of the original repro).
///
/// Rules (intentionally narrow — purely textual, no DNS lookups):
///   1. Trim leading/trailing whitespace and trailing slashes.
///   2. Lowercase the scheme + authority (host[:port]); leave path case
///      alone since some upstreams have case-sensitive paths.
///   3. Replace bare `localhost` in the authority with `127.0.0.1`. This
///      is the only true alias; everything else (custom hostnames, etc.) is
///      left as-is — those need real DNS.
///
/// If the input doesn't have a `://` separator, the whole thing is
/// trimmed + lowercased and returned (covers paths-only inputs that we
/// can't safely normalize further).
fn normalize_host_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');

    let scheme_end = match trimmed.find("://") {
        Some(idx) => idx + 3,
        None => return trimmed.to_lowercase(),
    };
    let (scheme_part, rest) = trimmed.split_at(scheme_end);

    // Authority ends at the first `/`, `?`, or `#` — keep path case as-is.
    let authority_end = rest
        .find(|c: char| c == '/' || c == '?' || c == '#')
        .unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);

    let mut canonical_authority = authority.to_lowercase();
    // `localhost` ↔ `127.0.0.1`. Only canonicalize when it appears as the
    // host (before an optional `:port`); a string like `localhostfoo` is
    // some other host and must not be touched.
    if canonical_authority == "localhost" || canonical_authority.starts_with("localhost:") {
        canonical_authority = canonical_authority.replacen("localhost", "127.0.0.1", 1);
    }

    format!(
        "{}{}{}",
        scheme_part.to_lowercase(),
        canonical_authority,
        tail
    )
}

pub fn stable_workspace_id_for_remote(base_url: &str, directory: Option<&str>) -> String {
    let mut key = format!("remote::{}", normalize_host_url(base_url));
    if let Some(dir) = directory {
        if !dir.trim().is_empty() {
            key.push_str("::");
            key.push_str(dir.trim());
        }
    }
    stable_workspace_id(&key)
}

pub fn stable_workspace_id_for_openwork(host_url: &str, workspace_id: Option<&str>) -> String {
    let mut key = format!("openwork::{}", normalize_host_url(host_url));
    if let Some(id) = workspace_id {
        if !id.trim().is_empty() {
            key.push_str("::");
            key.push_str(id.trim());
        }
    }
    stable_workspace_id(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_workspace(id: &str, ws_type: WorkspaceType) -> WorkspaceInfo {
        WorkspaceInfo {
            id: id.to_string(),
            name: id.to_string(),
            path: format!("C:\\Users\\test\\workspaces\\{id}"),
            preset: "starter".to_string(),
            workspace_type: ws_type,
            remote_type: None,
            base_url: None,
            directory: None,
            display_name: None,
            openwork_host_url: None,
            openwork_token: None,
            openwork_workspace_id: None,
            openwork_workspace_name: None,
            sandbox_backend: None,
            container_path: None,
        }
    }

    // ---------------------------------------------------------------- #
    //  normalize_host_url + stable_workspace_id_for_openwork dedupe
    // ---------------------------------------------------------------- #
    //
    // Regression coverage for the dup-workspace bug observed 2026-05-07:
    // openwork-workspaces.json contained two entries with the same
    // openworkWorkspaceId, identical token, and only differing in
    // `localhost:8787` vs `127.0.0.1:8787` baseUrl. The Tauri sidebar
    // then showed two "workspace" entries with identical session lists.
    //
    // Root cause: stable_workspace_id_for_openwork hashed the host_url
    // verbatim, so the two URLs hashed to different ids and the dedupe
    // layer (which compares ids) never realized they were the same.
    // Fix: normalize_host_url canonicalizes localhost → 127.0.0.1 before
    // the hash. These tests pin that contract.

    #[test]
    fn normalize_host_url_aliases_localhost_to_loopback() {
        assert_eq!(
            normalize_host_url("http://localhost:8787"),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            normalize_host_url("http://localhost:8787/w/x"),
            "http://127.0.0.1:8787/w/x"
        );
        // Bare `localhost` (no port) also aliased.
        assert_eq!(normalize_host_url("http://localhost"), "http://127.0.0.1");
    }

    #[test]
    fn normalize_host_url_lowercases_scheme_and_authority_only() {
        assert_eq!(
            normalize_host_url("HTTP://Localhost:8787/W/X"),
            "http://127.0.0.1:8787/W/X" // path case preserved
        );
        assert_eq!(
            normalize_host_url("https://EXAMPLE.com:443/PATH"),
            "https://example.com:443/PATH"
        );
    }

    #[test]
    fn normalize_host_url_does_not_alias_localhost_substring() {
        // `localhostfoo` is a different host — must not be touched.
        assert_eq!(
            normalize_host_url("http://localhostfoo:8787"),
            "http://localhostfoo:8787"
        );
    }

    #[test]
    fn normalize_host_url_trims_whitespace_and_trailing_slash() {
        assert_eq!(
            normalize_host_url("  http://localhost:8787/  "),
            "http://127.0.0.1:8787"
        );
    }

    #[test]
    fn normalize_host_url_handles_input_without_scheme() {
        // We can't safely normalize the host portion if there's no
        // `://` separator, so fall through to lowercase + trim only.
        assert_eq!(
            normalize_host_url("Localhost:8787/path"),
            "localhost:8787/path"
        );
    }

    #[test]
    fn stable_workspace_id_for_openwork_dedupes_localhost_aliases() {
        let id_a =
            stable_workspace_id_for_openwork("http://127.0.0.1:8787", Some("ws_c52ddf65534b"));
        let id_b =
            stable_workspace_id_for_openwork("http://localhost:8787", Some("ws_c52ddf65534b"));
        assert_eq!(
            id_a, id_b,
            "localhost and 127.0.0.1 must hash to the same workspace id; \
             otherwise the sidebar shows duplicate `workspace` entries \
             with identical session lists (regression of 2026-05-07 bug)."
        );
    }

    #[test]
    fn stable_workspace_id_for_openwork_does_not_collide_unrelated_hosts() {
        // Sanity: two genuinely different hosts must still hash distinctly.
        let id_local = stable_workspace_id_for_openwork("http://127.0.0.1:8787", Some("ws-x"));
        let id_remote = stable_workspace_id_for_openwork("http://10.0.0.5:8787", Some("ws-x"));
        assert_ne!(id_local, id_remote);
    }

    #[test]
    fn stable_workspace_id_for_remote_dedupes_localhost_aliases() {
        let id_a = stable_workspace_id_for_remote(
            "http://127.0.0.1:8787/w/x/opencode",
            Some("/workspace"),
        );
        let id_b = stable_workspace_id_for_remote(
            "http://localhost:8787/w/x/opencode",
            Some("/workspace"),
        );
        assert_eq!(id_a, id_b);
    }

    // ---------------------------------------------------------------- #
    //  v5 → v6 migration: dedupe legacy localhost/127.0.0.1 entries
    // ---------------------------------------------------------------- #

    fn openwork_remote_fixture(id: &str, host_url: &str, ws_id: &str) -> WorkspaceInfo {
        let mut ws = fixture_workspace(id, WorkspaceType::Remote);
        ws.preset = "remote".to_string();
        ws.path = "/workspace".to_string();
        ws.base_url = Some(format!("{}/w/{}/opencode", host_url, ws_id));
        ws.directory = Some("/workspace".to_string());
        ws.openwork_host_url = Some(host_url.to_string());
        ws.openwork_token = Some("owt_test".to_string());
        ws.openwork_workspace_id = Some(ws_id.to_string());
        ws.openwork_workspace_name = Some("workspace".to_string());
        ws.remote_type = Some(crate::types::RemoteType::Openwork);
        ws
    }

    #[test]
    fn migrate_v5_to_v6_dedupes_localhost_vs_loopback_remotes() {
        // Reproduces the exact 2026-05-07 user state: two openwork-remote
        // entries pointing at the same backend, one via 127.0.0.1 and one
        // via localhost. Active is the 127.0.0.1 one.
        let mut active = openwork_remote_fixture("ws-127", "http://127.0.0.1:8787", "ws_abc");
        active.openwork_token = Some("active-token".to_string());
        let mut stale = openwork_remote_fixture("ws-localhost", "http://localhost:8787", "ws_abc");
        stale.openwork_token = Some("stale-token".to_string());

        let mut state = WorkspaceState {
            version: 5,
            active_id: "ws-127".to_string(),
            workspaces: vec![active, stale],
        };

        migrate_workspace_state(&mut state);

        let canonical = stable_workspace_id_for_openwork("http://127.0.0.1:8787", Some("ws_abc"));
        assert_eq!(state.workspaces.len(), 1, "duplicate must be removed");
        assert_eq!(
            state.workspaces[0].id, canonical,
            "surviving entry's id must be rewritten to the canonical hash so future \
             workspace_create_remote calls dedupe correctly (Copilot review on PR #173)"
        );
        assert_eq!(state.active_id, canonical);
        assert_eq!(
            state.workspaces[0].openwork_token.as_deref(),
            Some("active-token"),
            "dedupe must preserve the originally active entry's fields"
        );
    }

    #[test]
    fn migrate_v5_to_v6_promotes_active_when_active_is_the_dup() {
        // Same shape, but this time the *active* one is the localhost
        // entry. After id rewrite both entries collapse to the same
        // canonical id; active_id is also rewritten.
        let mut stale = openwork_remote_fixture("ws-127", "http://127.0.0.1:8787", "ws_abc");
        stale.openwork_token = Some("stale-token".to_string());
        let mut active = openwork_remote_fixture("ws-localhost", "http://localhost:8787", "ws_abc");
        active.openwork_token = Some("active-token".to_string());

        let mut state = WorkspaceState {
            version: 5,
            active_id: "ws-localhost".to_string(),
            workspaces: vec![stale, active],
        };

        migrate_workspace_state(&mut state);

        let canonical = stable_workspace_id_for_openwork("http://127.0.0.1:8787", Some("ws_abc"));
        assert_eq!(state.workspaces.len(), 1);
        assert_eq!(state.workspaces[0].id, canonical);
        assert_eq!(state.active_id, canonical);
        assert_eq!(
            state.workspaces[0].openwork_token.as_deref(),
            Some("active-token"),
            "dedupe must preserve the originally active duplicate's fields"
        );
    }

    #[test]
    fn migrate_v5_to_v6_leaves_genuinely_distinct_remotes_alone() {
        // Two real backends — must not be merged.
        let mut state = WorkspaceState {
            version: 5,
            active_id: "ws-a".to_string(),
            workspaces: vec![
                openwork_remote_fixture("ws-a", "http://127.0.0.1:8787", "ws_alpha"),
                openwork_remote_fixture("ws-b", "http://10.0.0.5:8787", "ws_beta"),
            ],
        };

        migrate_workspace_state(&mut state);

        assert_eq!(state.workspaces.len(), 2);
    }

    #[test]
    fn migrate_v5_to_v6_handles_three_way_dup() {
        // Three entries that all point at the same backend via different
        // URL spellings. All but the active one must be dropped.
        let mut state = WorkspaceState {
            version: 5,
            active_id: "ws-a".to_string(),
            workspaces: vec![
                openwork_remote_fixture("ws-a", "http://127.0.0.1:8787", "ws_x"),
                openwork_remote_fixture("ws-b", "http://localhost:8787", "ws_x"),
                openwork_remote_fixture("ws-c", "HTTP://Localhost:8787/", "ws_x"),
            ],
        };

        migrate_workspace_state(&mut state);

        let canonical = stable_workspace_id_for_openwork("http://127.0.0.1:8787", Some("ws_x"));
        assert_eq!(state.workspaces.len(), 1);
        assert_eq!(state.workspaces[0].id, canonical);
        assert_eq!(state.active_id, canonical);
    }

    #[test]
    fn migrate_v5_to_v6_followed_by_create_remote_does_not_re_dup() {
        // The Copilot review concern (PR #173): even after dedupe, if the
        // surviving entry's id is the LEGACY hash (from the pre-fix verbatim
        // URL), a subsequent workspace_create_remote call computes the
        // canonical id, fails to find a match in `state.workspaces.retain(|w|
        // w.id != id)`, and re-introduces the duplicate.
        //
        // This test simulates the create flow's id assignment after migration
        // to confirm the surviving entry's id matches what the create path
        // would compute today — so the simple `id != id` retain works.
        let mut state = WorkspaceState {
            version: 5,
            active_id: "ws-127".to_string(),
            workspaces: vec![
                openwork_remote_fixture("ws-127", "http://127.0.0.1:8787", "ws_abc"),
                openwork_remote_fixture("ws-localhost", "http://localhost:8787", "ws_abc"),
            ],
        };

        migrate_workspace_state(&mut state);

        // Simulate workspace_create_remote computing the id for the same
        // backend (using either URL spelling — both must yield the same id
        // post-fix).
        let create_id_via_loopback =
            stable_workspace_id_for_openwork("http://127.0.0.1:8787", Some("ws_abc"));
        let create_id_via_localhost =
            stable_workspace_id_for_openwork("http://localhost:8787", Some("ws_abc"));

        assert_eq!(create_id_via_loopback, create_id_via_localhost);
        assert_eq!(
            state.workspaces[0].id, create_id_via_loopback,
            "surviving entry's id must equal the canonical id that \
             workspace_create_remote computes; otherwise the next create call \
             re-introduces the duplicate"
        );

        // Apply the production retain logic and confirm the surviving entry
        // is the only one left (i.e. no duplicate was added).
        state.workspaces.retain(|w| w.id != create_id_via_localhost);
        assert!(
            state.workspaces.is_empty(),
            "retain by canonical id must match the post-migration entry"
        );
    }

    #[test]
    fn migrate_v5_to_v6_does_not_touch_local_workspaces() {
        let mut state = WorkspaceState {
            version: 5,
            active_id: "ws-local".to_string(),
            workspaces: vec![
                fixture_workspace("ws-local", WorkspaceType::Local),
                fixture_workspace("ws-local-2", WorkspaceType::Local),
            ],
        };

        migrate_workspace_state(&mut state);

        // Both local workspaces retained — they have distinct paths.
        assert_eq!(state.workspaces.len(), 2);
    }

    #[test]
    fn migrate_v5_to_v6_full_serde_roundtrip_with_real_user_shape() {
        // Anchored to the real user-reproed file at
        // %APPDATA%/com.differentai.openwork/openwork-workspaces.json on
        // 2026-05-07: Starter local + two openwork-remote entries that
        // differ only by `localhost` vs `127.0.0.1`. Token + workspace id
        // are sanitized for the test fixture.
        //
        // This test guards the WHOLE production path:
        //   raw v5 JSON  →  serde::from_str  →  migrate_workspace_state
        //                →  version bump      →  serde::to_string_pretty
        //                →  serde::from_str (idempotent re-load)
        //
        // The struct-only migration tests above cover the core logic but
        // don't catch a serde rename, a missing #[serde(default)], or a
        // schema field added after the migration without a default value.
        let v5_json = r#"{
  "version": 5,
  "activeId": "ws-dc771de39ec632dd",
  "workspaces": [
    {
      "id": "ws-13942d564ba1f564",
      "name": "Starter",
      "path": "C:\\Users\\test\\workspaces\\starter",
      "preset": "starter",
      "workspaceType": "local",
      "remoteType": null,
      "baseUrl": null,
      "directory": null,
      "displayName": null,
      "openworkHostUrl": null,
      "openworkToken": null,
      "openworkWorkspaceId": null,
      "openworkWorkspaceName": null,
      "sandboxBackend": null,
      "sandboxRunId": null,
      "sandboxContainerName": null,
      "containerPath": null
    },
    {
      "id": "ws-dc771de39ec632dd",
      "name": "workspace",
      "path": "/workspace",
      "preset": "remote",
      "workspaceType": "remote",
      "remoteType": "openwork",
      "baseUrl": "http://127.0.0.1:8787/w/ws_abc/opencode",
      "directory": "/workspace",
      "displayName": null,
      "openworkHostUrl": "http://127.0.0.1:8787",
      "openworkToken": "owt_test",
      "openworkWorkspaceId": "ws_abc",
      "openworkWorkspaceName": "workspace",
      "sandboxBackend": null,
      "sandboxRunId": null,
      "sandboxContainerName": null,
      "containerPath": null
    },
    {
      "id": "ws-99b00b97296105dc",
      "name": "workspace",
      "path": "/workspace",
      "preset": "remote",
      "workspaceType": "remote",
      "remoteType": "openwork",
      "baseUrl": "http://localhost:8787/w/ws_abc/opencode",
      "directory": "/workspace",
      "displayName": null,
      "openworkHostUrl": "http://localhost:8787",
      "openworkToken": "owt_test",
      "openworkWorkspaceId": "ws_abc",
      "openworkWorkspaceName": "workspace",
      "sandboxBackend": null,
      "sandboxRunId": null,
      "sandboxContainerName": null,
      "containerPath": null
    }
  ]
}"#;

        // 1. Deserialize as production code does.
        let mut state: WorkspaceState =
            serde_json::from_str(v5_json).expect("real v5 user JSON must deserialize cleanly");
        assert_eq!(state.version, 5);
        assert_eq!(state.workspaces.len(), 3);

        // 2. Run the migration + version bump (mirroring load_workspace_state).
        if state.version < WORKSPACE_STATE_VERSION {
            migrate_workspace_state(&mut state);
            state.version = WORKSPACE_STATE_VERSION;
        }

        // 3. After migration: dup gone, active rewritten to canonical id.
        assert_eq!(state.version, 6);
        assert_eq!(
            state.workspaces.len(),
            2,
            "Starter + 1 remote (dup removed)"
        );

        // Local Starter id is rewritten to the canonical path-hash. In real
        // production state files the stored id already equals this (because
        // workspace_create wrote it that way), so this is a no-op for legit
        // users; the test fixture used a hand-picked hex blob to make the
        // test independent of the path-hash function's exact output, and the
        // migration now converges that to the canonical form.
        let starter_canonical = stable_workspace_id("C:\\Users\\test\\workspaces\\starter");
        let remote_canonical =
            stable_workspace_id_for_openwork("http://127.0.0.1:8787", Some("ws_abc"));
        let ids: Vec<&str> = state.workspaces.iter().map(|w| w.id.as_str()).collect();
        assert!(
            ids.contains(&starter_canonical.as_str()),
            "Starter must be kept"
        );
        assert!(
            ids.contains(&remote_canonical.as_str()),
            "active remote entry must be kept (with canonical id)"
        );
        assert_eq!(state.active_id, remote_canonical);

        // 4. Re-serialize and re-load: result must be a valid v6 file that
        //    re-deserializes to the same shape (idempotent on disk).
        let serialized =
            serde_json::to_string_pretty(&state).expect("post-migration state must serialize");
        assert!(serialized.contains("\"version\": 6"));
        let reloaded: WorkspaceState =
            serde_json::from_str(&serialized).expect("post-migration JSON must round-trip");
        assert_eq!(reloaded.version, 6);
        assert_eq!(reloaded.workspaces.len(), 2);
        assert_eq!(reloaded.active_id, state.active_id);

        // 5. Run migrate again on the reloaded v6 state — must be a no-op.
        let mut reloaded_mut = reloaded;
        let count_before = reloaded_mut.workspaces.len();
        migrate_workspace_state(&mut reloaded_mut);
        assert_eq!(reloaded_mut.workspaces.len(), count_before);
    }

    #[test]
    fn state_file_with_a_retired_docker_worker_still_loads() {
        // A workspace created by the retired detached Docker worker carries
        // `sandboxRunId` / `sandboxContainerName`, which the state no longer
        // models. The file must still load, keep the entry, and stop writing
        // the retired keys on the next save.
        let json = r#"{
  "version": 6,
  "activeId": "ws-legacy-worker",
  "workspaces": [
    {
      "id": "ws-legacy-worker",
      "name": "worker",
      "path": "",
      "preset": "remote",
      "workspaceType": "remote",
      "remoteType": "openwork",
      "baseUrl": "http://127.0.0.1:49152/opencode",
      "directory": "C:\\Users\\test\\worker",
      "openworkHostUrl": "http://127.0.0.1:49152",
      "sandboxBackend": "docker",
      "sandboxRunId": "run-1",
      "sandboxContainerName": "openwork-orchestrator-run-1"
    }
  ]
}"#;

        let state: WorkspaceState =
            serde_json::from_str(json).expect("a state file with retired sandbox keys must load");
        assert_eq!(state.workspaces.len(), 1);
        assert_eq!(state.workspaces[0].id, "ws-legacy-worker");
        assert_eq!(
            state.workspaces[0].openwork_host_url.as_deref(),
            Some("http://127.0.0.1:49152")
        );

        let saved = serde_json::to_string(&state).expect("state must serialize");
        assert!(!saved.contains("sandboxRunId"), "saved state: {saved}");
        assert!(!saved.contains("sandboxContainerName"), "saved state: {saved}");
    }

    fn workspace_with_backend(id: &str, sandbox_backend: Option<&str>) -> WorkspaceInfo {
        WorkspaceInfo {
            preset: "remote".to_string(),
            sandbox_backend: sandbox_backend.map(str::to_string),
            ..fixture_workspace(id, WorkspaceType::Remote)
        }
    }

    #[test]
    fn retired_docker_workspaces_are_dropped_and_an_active_one_is_replaced() {
        let mut state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "ws-legacy-worker".to_string(),
            workspaces: vec![
                workspace_with_backend("ws-legacy-worker", Some("docker")),
                workspace_with_backend("ws-native", Some("servicehub")),
                fixture_workspace("ws-local", WorkspaceType::Local),
            ],
        };

        let removed = remove_retired_docker_workspaces(&mut state);

        assert_eq!(removed, vec!["ws-legacy-worker".to_string()]);
        let ids: Vec<&str> = state.workspaces.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["ws-native", "ws-local"]);
        assert_eq!(state.active_id, "ws-native");
    }

    #[test]
    fn dropping_a_retired_docker_workspace_keeps_another_active_workspace() {
        let mut state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "ws-local".to_string(),
            workspaces: vec![
                workspace_with_backend("ws-legacy-worker", Some("docker")),
                fixture_workspace("ws-local", WorkspaceType::Local),
            ],
        };

        let removed = remove_retired_docker_workspaces(&mut state);

        assert_eq!(removed, vec!["ws-legacy-worker".to_string()]);
        assert_eq!(state.workspaces.len(), 1);
        assert_eq!(state.active_id, "ws-local");
    }

    #[test]
    fn dropping_the_only_workspace_leaves_no_active_id() {
        let mut state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "ws-legacy-worker".to_string(),
            workspaces: vec![workspace_with_backend("ws-legacy-worker", Some("docker"))],
        };

        remove_retired_docker_workspaces(&mut state);

        assert!(state.workspaces.is_empty());
        assert_eq!(state.active_id, "");
    }

    #[test]
    fn state_without_retired_docker_workspaces_is_left_alone() {
        let mut state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "ws-native".to_string(),
            workspaces: vec![
                workspace_with_backend("ws-native", Some("servicehub")),
                workspace_with_backend("ws-remote", None),
            ],
        };

        let removed = remove_retired_docker_workspaces(&mut state);

        assert!(removed.is_empty());
        assert_eq!(state.workspaces.len(), 2);
        assert_eq!(state.active_id, "ws-native");
    }

    #[test]
    fn migrate_v5_to_v6_orphan_remote_with_no_url_is_left_alone() {
        // A WorkspaceType::Remote entry with both openwork_host_url AND
        // base_url null. `canonical_id_for` returns None for these entries,
        // so the migration leaves their ids alone and the dedupe pass treats
        // them as distinct (since their stored ids differ). They must NOT
        // collapse with each other or with a real remote.
        let mut orphan_a = fixture_workspace("ws-orphan-a", WorkspaceType::Remote);
        orphan_a.preset = "remote".to_string();
        // base_url and openwork_host_url stay None from fixture defaults.
        let mut orphan_b = fixture_workspace("ws-orphan-b", WorkspaceType::Remote);
        orphan_b.preset = "remote".to_string();

        let mut state = WorkspaceState {
            version: 5,
            active_id: "ws-orphan-a".to_string(),
            workspaces: vec![orphan_a, orphan_b],
        };

        migrate_workspace_state(&mut state);

        // Both orphans must survive — they have no URL info to compare
        // against, so the safest behavior is to keep them as-is.
        assert_eq!(state.workspaces.len(), 2);
    }

    #[test]
    fn migrate_v5_to_v6_mixed_local_and_remote_dup() {
        // Mirrors the real user file's layout: 1 Starter + 2 dup remotes.
        // Local entry must NOT collide with the remotes even though their
        // path strings differ structurally.
        let mut state = WorkspaceState {
            version: 5,
            active_id: "ws-remote-127".to_string(),
            workspaces: vec![
                fixture_workspace("ws-starter", WorkspaceType::Local),
                openwork_remote_fixture("ws-remote-127", "http://127.0.0.1:8787", "ws_x"),
                openwork_remote_fixture("ws-remote-localhost", "http://localhost:8787", "ws_x"),
            ],
        };

        migrate_workspace_state(&mut state);

        assert_eq!(state.workspaces.len(), 2, "Starter + active remote");
        // Starter's id is rewritten to the canonical path-hash; the active
        // remote's id is rewritten to the canonical openwork hash. Verify by
        // type rather than by id string.
        let local_count = state
            .workspaces
            .iter()
            .filter(|w| w.workspace_type == WorkspaceType::Local)
            .count();
        let remote_count = state
            .workspaces
            .iter()
            .filter(|w| w.workspace_type == WorkspaceType::Remote)
            .count();
        assert_eq!(local_count, 1, "Starter local must survive");
        assert_eq!(remote_count, 1, "exactly one remote (dup removed)");
    }

    #[test]
    fn migrate_v5_to_v6_idempotent_on_clean_state() {
        // Running the migration on an already-deduped state must be a
        // no-op (so a v6 state file stays v6 across loads).
        let mut state = WorkspaceState {
            version: 5,
            active_id: "ws-127".to_string(),
            workspaces: vec![openwork_remote_fixture(
                "ws-127",
                "http://127.0.0.1:8787",
                "ws_x",
            )],
        };

        migrate_workspace_state(&mut state);
        let after_first = state.workspaces.len();

        migrate_workspace_state(&mut state);
        assert_eq!(state.workspaces.len(), after_first);
    }

    #[test]
    fn migrate_v4_to_v5_populates_container_path_for_local_only() {
        let mut state = WorkspaceState {
            version: 4,
            active_id: "ws-local".to_string(),
            workspaces: vec![
                fixture_workspace("ws-local", WorkspaceType::Local),
                fixture_workspace("ws-remote", WorkspaceType::Remote),
            ],
        };

        migrate_workspace_state(&mut state);

        // After v5→v6 ids are canonicalized; look up by type instead of by
        // the original hand-picked fixture ids.
        let local = state
            .workspaces
            .iter()
            .find(|w| w.workspace_type == WorkspaceType::Local)
            .unwrap();
        let remote = state
            .workspaces
            .iter()
            .find(|w| w.workspace_type == WorkspaceType::Remote)
            .unwrap();

        assert_eq!(
            local.container_path.as_deref(),
            Some(DEFAULT_CONTAINER_PATH),
            "local workspace should get the default container path"
        );
        assert!(
            remote.container_path.is_none(),
            "remote workspace must NOT receive a container_path; `directory` covers that role"
        );
    }

    #[test]
    fn migrate_preserves_explicit_container_path() {
        // If a workspace already has a container_path set (e.g. user edited the
        // JSON, or a future schema version repopulated it), the migration must
        // NOT overwrite it.
        let mut ws = fixture_workspace("ws-1", WorkspaceType::Local);
        ws.container_path = Some("/custom/mount".to_string());
        let mut state = WorkspaceState {
            version: 4,
            active_id: "ws-1".to_string(),
            workspaces: vec![ws],
        };

        migrate_workspace_state(&mut state);

        assert_eq!(
            state.workspaces[0].container_path.as_deref(),
            Some("/custom/mount")
        );
    }

    #[test]
    fn migrate_is_noop_at_current_version() {
        let mut ws = fixture_workspace("ws-1", WorkspaceType::Local);
        ws.container_path = Some("/workspace".to_string());
        let mut state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "ws-1".to_string(),
            workspaces: vec![ws],
        };
        let before = state.workspaces[0].container_path.clone();

        migrate_workspace_state(&mut state);

        assert_eq!(state.workspaces[0].container_path, before);
    }

    #[test]
    fn workspace_info_serde_roundtrips_with_container_path() {
        let mut ws = fixture_workspace("ws-1", WorkspaceType::Local);
        ws.container_path = Some("/workspace".to_string());

        let json = serde_json::to_string(&ws).unwrap();
        assert!(
            json.contains("\"containerPath\":\"/workspace\""),
            "expected camelCase serialization, got: {json}"
        );

        let parsed: WorkspaceInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.container_path.as_deref(), Some("/workspace"));
    }

    #[test]
    fn workspace_info_deserializes_legacy_v4_json_without_container_path() {
        // Pre-v5 state files lack the field entirely. With #[serde(default)]
        // they should still parse, with container_path = None.
        let legacy = r#"{
            "id": "ws-legacy",
            "name": "Legacy",
            "path": "C:\\Users\\test\\workspaces\\legacy",
            "preset": "starter",
            "workspaceType": "local"
        }"#;
        let parsed: WorkspaceInfo = serde_json::from_str(legacy).unwrap();
        assert!(parsed.container_path.is_none());
        assert_eq!(parsed.workspace_type, WorkspaceType::Local);
    }

    // ---------------------------------------------------------------- #
    //  remove_legacy_starter_workspace_at
    // ---------------------------------------------------------------- #
    //
    // Regression coverage for the "no migration" gap in the
    // chrome-devtools-mcp removal (PR #2148 review): this app no longer
    // auto-creates a local "Starter" workspace, but pre-existing installs
    // may still have one registered with a stale, never-refreshed
    // `.opencode` folder. These tests pin that the cleanup deregisters the
    // entry, deletes its folder, is idempotent, and leaves everything else
    // (including a non-starter active workspace) untouched.

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("superclaw-test-{label}-{nanos}"))
    }

    /// Builds a fixture `WorkspaceInfo` registered at exactly `starter_dir`,
    /// with its id derived the same way `workspace_create` would (so tests
    /// exercise the real id/path-based matching, not the old preset match).
    fn starter_fixture_at(starter_dir: &Path) -> WorkspaceInfo {
        let path = starter_dir.to_string_lossy().into_owned();
        let id = stable_workspace_id(&path);
        WorkspaceInfo {
            path,
            ..fixture_workspace(&id, WorkspaceType::Local)
        }
    }

    #[test]
    fn remove_legacy_starter_workspace_at_deregisters_starter_entry() {
        let starter_dir = unique_temp_dir("noop");
        let starter = starter_fixture_at(&starter_dir);
        let mut other = fixture_workspace("other-id", WorkspaceType::Local);
        other.preset = "blank".to_string();
        let mut state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "other-id".to_string(),
            workspaces: vec![starter, other],
        };

        remove_legacy_starter_workspace_at(&mut state, &starter_dir).unwrap();

        assert_eq!(state.workspaces.len(), 1);
        assert_eq!(state.workspaces[0].id, "other-id");
        // Active workspace was never the starter entry, so it's untouched.
        assert_eq!(state.active_id, "other-id");
    }

    #[test]
    fn remove_legacy_starter_workspace_at_preserves_user_workspace_with_starter_preset() {
        // Regression for the PR #2148 review: `workspace_create` assigns
        // `preset == "starter"` by default (empty preset) at ANY user-chosen
        // folder, and "starter" is also a selectable preset option. Such an
        // entry lives at a different path than the app-managed starter folder
        // and must survive cleanup — only path/id identifies the legacy one.
        let starter_dir = unique_temp_dir("legacy-only");
        let mut user_ws = fixture_workspace("user-workspace-id", WorkspaceType::Local);
        user_ws.preset = "starter".to_string();
        user_ws.path = "C:\\Users\\test\\Documents\\MyProject".to_string();
        let mut state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "user-workspace-id".to_string(),
            workspaces: vec![user_ws],
        };

        remove_legacy_starter_workspace_at(&mut state, &starter_dir).unwrap();

        assert_eq!(
            state.workspaces.len(),
            1,
            "a user workspace at an unrelated path must never be removed, \
             even though it shares preset == \"starter\""
        );
        assert_eq!(state.active_id, "user-workspace-id");
    }

    #[test]
    fn remove_legacy_starter_workspace_at_reassigns_active_id_when_it_was_starter() {
        let starter_dir = unique_temp_dir("noop");
        let starter = starter_fixture_at(&starter_dir);
        let starter_id = starter.id.clone();
        let mut other = fixture_workspace("other-id", WorkspaceType::Local);
        other.preset = "blank".to_string();
        let mut state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: starter_id,
            workspaces: vec![starter, other],
        };

        remove_legacy_starter_workspace_at(&mut state, &starter_dir).unwrap();

        assert_eq!(state.workspaces.len(), 1);
        assert_eq!(
            state.active_id, "other-id",
            "active_id must fall back to a surviving workspace once the \
             starter entry it pointed at is removed"
        );
    }

    #[test]
    fn remove_legacy_starter_workspace_at_leaves_empty_active_id_when_no_workspaces_remain() {
        let starter_dir = unique_temp_dir("noop");
        let starter = starter_fixture_at(&starter_dir);
        let starter_id = starter.id.clone();
        let mut state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: starter_id,
            workspaces: vec![starter],
        };

        remove_legacy_starter_workspace_at(&mut state, &starter_dir).unwrap();

        assert!(state.workspaces.is_empty());
        assert_eq!(state.active_id, "");
    }

    #[test]
    fn remove_legacy_starter_workspace_at_deletes_on_disk_folder() {
        let starter_dir = unique_temp_dir("delete");
        fs::create_dir_all(&starter_dir).unwrap();
        fs::write(
            starter_dir.join("marker.txt"),
            "stale seeded content from before the fix",
        )
        .unwrap();
        assert!(starter_dir.exists());

        // The folder is only deleted when the legacy entry is actually
        // registered here, so the state must contain the matching entry.
        let starter = starter_fixture_at(&starter_dir);
        let mut state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: starter.id.clone(),
            workspaces: vec![starter],
        };

        remove_legacy_starter_workspace_at(&mut state, &starter_dir).unwrap();

        assert!(
            !starter_dir.exists(),
            "stale starter folder must be deleted from disk"
        );
    }

    #[test]
    fn remove_legacy_starter_workspace_at_does_not_delete_folder_without_matching_entry() {
        // Guards the review requirement: only delete the on-disk folder when
        // the legacy entry was actually found in state. A folder with no
        // matching registered entry must be left on disk untouched.
        let starter_dir = unique_temp_dir("orphan-folder");
        fs::create_dir_all(&starter_dir).unwrap();
        assert!(starter_dir.exists());

        let mut user_ws = fixture_workspace("user-id", WorkspaceType::Local);
        user_ws.preset = "starter".to_string();
        user_ws.path = "C:\\Users\\test\\Documents\\Elsewhere".to_string();
        let mut state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "user-id".to_string(),
            workspaces: vec![user_ws],
        };

        remove_legacy_starter_workspace_at(&mut state, &starter_dir).unwrap();

        assert_eq!(state.workspaces.len(), 1, "user workspace must survive");
        assert!(
            starter_dir.exists(),
            "folder must NOT be deleted when no matching legacy entry was removed"
        );
        fs::remove_dir_all(&starter_dir).ok();
    }

    #[test]
    fn remove_legacy_starter_workspace_at_is_idempotent() {
        let starter_dir = unique_temp_dir("idempotent");
        fs::create_dir_all(&starter_dir).unwrap();

        let starter = starter_fixture_at(&starter_dir);
        let mut other = fixture_workspace("other-id", WorkspaceType::Local);
        other.preset = "blank".to_string();
        let mut state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "other-id".to_string(),
            workspaces: vec![starter, other],
        };

        remove_legacy_starter_workspace_at(&mut state, &starter_dir).unwrap();
        let after_first = state.clone();
        assert_eq!(after_first.workspaces.len(), 1, "starter entry removed, non-starter entry survives");

        // Second run: no starter entry left, folder already gone. Must
        // succeed as a no-op and leave state unchanged.
        remove_legacy_starter_workspace_at(&mut state, &starter_dir).unwrap();

        assert_eq!(state.workspaces.len(), after_first.workspaces.len());
        assert_eq!(state.active_id, after_first.active_id);
        assert!(!starter_dir.exists());
    }

    #[test]
    fn remove_legacy_starter_workspace_at_noop_when_nothing_to_clean() {
        let mut other = fixture_workspace("other-id", WorkspaceType::Local);
        other.preset = "blank".to_string();
        let mut state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "other-id".to_string(),
            workspaces: vec![other],
        };
        let starter_dir = unique_temp_dir("never-existed");

        remove_legacy_starter_workspace_at(&mut state, &starter_dir).unwrap();

        assert_eq!(state.workspaces.len(), 1);
        assert_eq!(state.active_id, "other-id");
    }

    #[test]
    fn remove_legacy_starter_workspace_at_preserves_non_starter_presets() {
        // A workspace with an unrelated preset at an unrelated path must
        // never be removed.
        let mut ws = fixture_workspace("custom-id", WorkspaceType::Local);
        ws.preset = "blank".to_string();
        let mut state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "custom-id".to_string(),
            workspaces: vec![ws],
        };
        let starter_dir = unique_temp_dir("noop");

        remove_legacy_starter_workspace_at(&mut state, &starter_dir).unwrap();

        assert_eq!(
            state.workspaces.len(),
            1,
            "a workspace with a non-starter preset must never be removed"
        );
    }
}
