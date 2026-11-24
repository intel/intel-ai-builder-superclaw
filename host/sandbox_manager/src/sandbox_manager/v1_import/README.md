# SuperClaw 1.x session import (`v1_import/`)

Carries a SuperClaw 1.1–1.3 (WSL) install's OpenCode sessions into the native backend, once, on the
first native cold start that finds one, before the runtime role starts.

- **Owner:** Sandbox Manager, native backend lifecycle.
- **Contract:** the volume copy-out ledger in `state_migration.py` (planner, ledger states, conflict
  outcomes). This package is that contract's lifecycle adapter and adds no second ledger format.
- **Allowed dependencies:** `state_migration` / `state_migration_io`, `owner_dpapi.atomic_write`, the
  standard library (`winreg`, `subprocess`, `tarfile`, `sqlite3`) and loguru. Nothing here talks to
  ServiceHub, the broker or the UI. `native_backend.py` calls `import_v1_state_once` and nothing else.

## What runs

1. `detect.py` looks under `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss` for a distro named
   `superclaw-docker`. Without one nothing is spawned. With one and no ledger yet, a native
   `opencode.db` that already holds sessions ends the import (`native_sessions_exist`) before WSL is
   touched.
2. The adapter runs `wsl.exe --terminate superclaw-docker` so a running 1.x app cannot write the volume
   (that app loses its backend); if the terminate does not report success, nothing is copied.
   `copy_out.py` then streams `opencode/opencode.db` and its `-wal` out of the `superclaw-workspace-data`
   volume with `wsl.exe -d superclaw-docker -u root --exec tar ...` (no Docker daemon), and terminates
   the distro again. The volume is only read. The stream is capped at 2 GiB and killed if no byte
   arrives within 45 s, or nothing for 30 s after that.
3. `opencode_db.py` refuses a file that fails `quick_check`, holds a trigger, view or virtual table, or
   lacks a table or column the rewrite needs. It folds the WAL in and rewrites the container paths
   OpenCode keeps as locators (`session.directory`/`path`, `project.worktree`/`sandboxes`,
   `project_directory.directory`, `workspace.directory`, message `path.cwd`/`root`): `/workspace/...`
   becomes the native workspace root, and other paths are left as they are and counted. OpenCode's
   `credential` table is emptied in the staged copy with `secure_delete` on (logged as
   `credential_rows`).
4. `adapter.py` sets aside an empty native database (below), plans with `plan_migration`, saves the
   ledger, promotes the staged file with a hard link (which never replaces a file), verifies it, and
   marks the ledger `completed`.

**Start-up cost.** The import runs before the roles start. It took 2.2 s for three chats on a test
machine. If WSL hangs, a start waits at most about 75 s (10 s terminate, 45 s first byte, up to 8 s to
kill and reap `wsl.exe`, 12 s for the second terminate); a stream that keeps moving is bounded only by
the byte cap. Only installs that had 1.x pay this, and only until the import completes.

## Where things live

| What | Path | Why there |
|---|---|---|
| Ledger, attempt record | `<backend>\migrations\` | Only owner, SYSTEM and Administrators can open it; `reset` deletes only `config\` and `data\`, so it does not re-import |
| Staging | `<backend>\data\file_tool\opencode\v1-import-staging\` | Same parent ACL as the destination, so the runtime tier can open the promoted file |
| Destination | `<backend>\data\file_tool\opencode\opencode.db` | The runtime's `XDG_DATA_HOME\opencode` |
| Set-aside database | `opencode.db.set-aside-<UTC time>` (with its `-wal`, `-shm`, `-journal`) beside the destination | Renamed in place, never deleted; listed in the attempt record |

## Outcomes

- A `completed` or `blocked` ledger ends the import for good.
- A native `opencode.db` with sessions or messages is never replaced or merged into; the import ends as
  `native_sessions_exist` and the 1.x sessions stay in the distro.
- An empty native `opencode.db` (what the runtime creates after a failed import) is renamed aside with
  its sidecars, and the import plans as if there were none. An orphan `-wal`, `-shm` or `-journal` is
  renamed aside the same way, because SQLite would replay it into the imported file; one that appears
  later stops the promote as `promote_failed`.
- **Final reasons** stop at once: sessions already in the native database, no `wsl.exe`, no database
  in the volume, too large, an unsafe archive, or a file that is not OpenCode's schema or fails its
  integrity check.
- **Everything else** (disk, I/O and lock errors, unexpected entries in staging, a distro that will not
  stop, timeouts) is retried, up to three failed runs. No outcome stops the native start.

A retry only helps while the native database is still empty, and the runtime writes the first session
on the first prompt. If a start's import fails with a retryable reason and the user then chats, the
next start ends the import (`native_sessions_exist`, or `destination_content_changed` after
`promote_failed`) and later starts log `skipped reason=ledger_blocked`.

**When testing an upgrade:** check that the log reads `v1-import: outcome=imported` before chatting on
the first native start, and restart the app first if it reads `outcome=failed`.

## Removing the 1.x distro

The start after the one that imported finds the ledger `completed` and runs
`wsl.exe --unregister superclaw-docker` (which deletes its `ext4.vhdx`) on a background thread with a
30 s limit, logging `v1-import: unregistered superclaw-docker`; a failure is retried on the next start.
It does so only when the registry GUID is the one the ledger recorded, the imported `opencode.db` is
still at the destination, and `wsl.exe` is found. After a backend `reset` the distro is kept until
OpenCode has created a new `opencode.db`, then removed on a later start.

A ledger that is not `completed` never removes the distro: it may hold the only copy of the user's
sessions.

## Not imported

- `/config/opencode`: native OpenCode config is the digest-checked Product Profile projection. User
  config lived in the project folder (`/workspace/opencode.jsonc`) and carries over by itself.
- Credentials and sign-ins: `/data/opencode/auth.json`, `/data/opencode/mcp-auth.json`,
  `superclaw-runtime-config.json`, `/config/gh`, `/config/gmail` (provider keys, MCP OAuth tokens, the
  Tavily key, GitHub and Gmail sign-ins). Moving a credential needs an audited secret move, so users
  sign in again after the upgrade.
- `storage/`, `snapshot/` (revert repos bound to container paths), `tool-output/`, logs and PII models.
  Old turns cannot be reverted, and file paths inside message text keep their container form.

These go away with the distro.

## Tests

From `host\sandbox_manager`:

```powershell
uv run pytest tests/unit -k v1_import
uv run pytest tests/unit/test_native_supervision.py -k v1_sessions   # ordering against the role start
uv run pytest -m "windows_only and not integration and not gpu" tests/unit -k v1_import   # real registry
```

The registry, `wsl.exe` and the clock are injected; the tar stream and SQLite database are real. The
registry case writes and deletes a throwaway `HKCU\Software` key. The GNU tar case needs GNU `tar` on
`PATH`. `tests/unit/conftest.py` stubs the import out of every other native start.
