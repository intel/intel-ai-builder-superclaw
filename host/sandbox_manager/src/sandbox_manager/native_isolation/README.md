# Native isolation: path policy, containment and the isolation report

Host-side modules for reasoning about paths on the native Windows backend, and the producer of the
isolation report.

- **Owner:** Sandbox Manager, native backend lifecycle.
- **Contracts:** the Windows local-drive path grammar and `NativePathSet` shared with
  `shared/contracts`, and the isolation report in `RuntimeStatus`.
- **Allowed dependencies:** the standard library (including `ctypes` for Win32), generated contracts,
  Pydantic, `sandbox_policy`, loguru. Nothing here imports `broker_client`; evidence arrives as plain
  values. `egress_evidence.py` and `isolation_report_rules.py` are the report's egress overlay and
  validator.

## Path policy (`path_policy.py`, `paths.py`)

A lexical policy: the path grammar shared with `shared/contracts`, construction of the host-only
`NativePathSet` (backend and workspace roots, with the `SUPERCLAW_NATIVE_BACKEND_STATE_DIR` and
`WINDOWS_SUPERCLAW_PATH` overrides), and point-in-time nearest-existing-ancestor and reparse inspection.
It reasons about path text only.

## Containment (`containment.py`)

A kernel-verified containment primitive. String checks cannot see a junction placed mid-path, a hard
link, or a case or spelling alias that resolves elsewhere. `open_managed_root` opens a managed root as a
directory handle and walks into it one component at a time relative to the previous handle, so every
open is verified by construction. A full-path `CreateFileW` cannot give that guarantee: it suppresses
reparse only on the final component.

### Scope limits

- Containment is about object identity, not content: a contained file's bytes can still change.
- Hard links are refused; a link created after verification is not caught.
- A root's ancestors are walked once, not pinned; moving one mid-walk is an availability failure, not
  an escape.
- A drive letter can be redirected session-locally, or (unelevated) by mounting a new volume. Placing
  roots where an adversary cannot do this is the job of root placement and ACLs, not this primitive.
- It stops working entirely if the host loses `SeChangeNotifyPrivilege`, and assumes the host process
  is unelevated.
- Case-sensitive directories and Unicode composition twins (NFC/NFD) can let two spellings coexist;
  callers must match on-disk spelling exactly. Below a root, treat the kernel `final_path` as
  authoritative.
- Reparse-tag hiding (WOF/WIM/dedup) and tagless filesystem filters (`bindflt`) are not detected.
- Non-NTFS and redirected volumes (SMB, ReFS/Dev Drive) are refused.
- An access mask bounds what a caller may do to the object it named, not beneath it: a read-only
  directory handle does not stop children being created or deleted under their own ACLs.
- Handles are never inheritable, and a managed root and everything opened from it are confined to one
  thread; both are caller contracts, not enforced.
- The read/list access that pins handles also lets an unprivileged process deny containment by holding
  a root open without sharing.
- Re-parenting a `ContainedEntry` onto an outer `ExitStack` keeps it usable after its root context
  exits, but the root is no longer pinned.
- No ACLs, integrity labels, placement or egress policy here; containment alone does not establish any
  isolation level.

## Isolation report (`isolation_report_producer.py`)

Assembles the isolation report served in `GET /sandbox-manager/v1/agent/sandbox/diagnostics` (wiring:
`sandbox_manager/native_isolation_report.py`, with the WFP readback overlaid by
`native_egress_status.py`). It is a pure leaf: it decides what the recorded evidence lets the report
claim and always runs the result through `validate_isolation_report`. If the validator refuses, the
reasons are logged and the fail-closed report is published, so a producer bug reads as an absence of
containment.

What the report says today:

- **`isolation_level` is always `not_established`.** Naming a level needs a passing attestation, and
  nothing produces one yet. Warnings give the reasons the validator can back
  (`native_isolation_not_applied`, `policy_version_unavailable`, `attestation_not_passing`,
  `tier_launch_evidence_incomplete`). `isolation_token_shape` is `unknown`.
- `isolation_policy_version`: the ACL policy version of the latest verified provision, published only
  while the launcher's ACL readback agrees the roots carry the shipped descriptor (a marker alone is an
  owner-writable hint). Null when nothing was provisioned in this process's lifetime.
- `isolation_egress_policy_version`: the shipped egress descriptor's label (`v<N>/permissive`), boundary
  state `declared_permissive_no_rules`, and no enforced tiers. Its readback is `not_read` until the
  launcher's `--wfp-readback` has run; then it carries that verdict, and drift adds an
  `egress_policy_drifted` warning. An open loopback range adds `loopback_dynamic_range_open`.
- `isolation_workspace_root_count` / `_classes`: from the current path set, classes only.
- `isolation_tier_evidence`: one entry per tier with a running role. Identity is
  `owner_kernel_verified` only when the launcher's runner SID equals the SID resolved for that tier's
  account and differs from the owner's and every other tier's. `acl_readback` is the launcher's
  read-only readback (cached about 5 s, bounded by a timeout); one that did not run is `not_read`.
  `job` is `tier_reported_verified` only when the launch reported Job evidence; otherwise
  `not_reported`.
- `host_mcp_execution_enabled` is warned while the host MCP gateway runs servers or the browser
  outside every tier.

`current_attestation()` is the seam for the runtime policy probes. It returns `stale` with no probe set
and no coverage. A real implementation must read a probe run the control plane executed from outside
the restricted process (never a restricted process's own report) and return `pass` with the
`pst_<sha256>` probe-set id, the RFC 3339 UTC last-pass instant and exactly the covered categories, or
`fail`/`stale` with no coverage.

## Tests

From the repo root:

```powershell
pnpm --filter @different-ai/openwork-contracts test -- native-path-contract
uv run --directory host\sandbox_manager pytest tests\unit\test_native_path_policy.py tests\unit\test_native_isolation_paths.py tests\unit\test_native_containment.py tests\unit\test_native_isolation_report_producer.py
```

The Windows-specific cases (real junctions, hard links, kernel case-table comparisons) are marked
`windows_only` and excluded by default. Run them on a Windows machine:

```powershell
uv run --directory host\sandbox_manager pytest -m windows_only -rs tests\unit
```
