# Sandbox Manager broker client

The only product caller of `native_isolation_broker.exe` (elevated, on demand) and
`native_isolation_launcher.exe` (unelevated, one per role launch). It provisions the owner's tier
identities and workspace ACLs, starts and stops roles, and records the evidence the isolation report
reads. The broker side of every exchange is described in
[`host/native_isolation_broker/README.md`](../../../../native_isolation_broker/README.md).

- **Owner:** Sandbox Manager, native backend lifecycle. Sandbox Manager stays the sole lifecycle owner;
  the broker and launcher are leaf adapters.
- **Contract:** the Sandbox lifecycle adapter. Elevated command shapes are `BROKER_ELEVATED_OPERATIONS`
  in `shared/contracts`; the wire stays JSON.
- **Allowed dependencies:** the Python standard library and `sandbox_manager.payload_integrity` (the
  `VerifiedPayload` handle used to resolve paths). Generated contract types are not required.
- **Forbidden:** importing `sandbox_manager.native_isolation`; importing Tauri, ServiceHub, OpenCode or
  UI layers; free-form argv; a second pipe to the broker; reading a provisioning marker anywhere but
  `markers.py`, or letting one authorize anything.

## Contract

- **Resolution.** `paths.py` resolves the broker and launcher and refuses with `broker_not_found` /
  `launcher_not_found` before any elevation. An installed (frozen) Sandbox Manager resolves the elevated
  broker only from its install directory, never from the payload root under `%LOCALAPPDATA%`, which the
  user can write. A source checkout uses the env override, then the payload tree, then the crate's
  `target\release` build.
- **No signature check.** Nothing here hashes the binaries against the payload roster or reads their
  Authenticode status. A same-user attacker can already write the managed payload root and its roster,
  so such a check would not raise the bar. A release signer policy, if added, belongs in the broker and
  must be rooted in `LocalMachine`.
- **Closed CLI surfaces only.** `--provision --owner-sid <sid>` (tier identities),
  `--provision-session --owner-sid <sid> --pipe-id <id> --auth-key <hex>` (workspace ACLs), and
  `--provision-identities-and-session` with the same three values when a start needs both. None carries
  a path, a plan or free text. The launcher is invoked with its own closed forms (`--launch-tier`,
  `--acl-readback`, `--wfp-readback`).
- **One UAC prompt on a first start.** When neither marker matches (no identity marker, no receipt for
  these payloads, or a newly created backend root), `ensure_tier_identities_and_workspace_acl` runs the
  combined operation and writes both markers from its one receipt. Other starts run the two steps
  separately.
- **Drift repair.** A launcher's `provision_required` forces one provision and one retry. Concurrent
  launches in one start share a `ProvisionRepair`, so one drift costs one elevation, and a refused
  repair is every waiting launch's refusal.
- **Typed refusals.** Failures are typed and surface through RuntimeStatus messages.
- **Markers.** The broker's identity records under `%ProgramData%\SuperClaw\isolation` are readable only
  by SYSTEM and Administrators (tier credential blobs also grant the owner read-only access). So whether
  an owner is provisioned is tracked by a non-secret marker under
  `%LOCALAPPDATA%\SuperClaw\isolation\provisioned` (`markers.py`), written only after the broker reports
  success. The marker only decides whether to show UAC; the launcher's own `READ_CONTROL` DACL readback
  is the evidence at launch, and marker-only operation is not a fallback.

## The provision pipe

Applying an ACL plan needs elevation, and the plan is too large and structured for a command line, so
it travels over a named pipe. This is the only pipe between Sandbox Manager and the broker: one
instance per attempt, one request, one receipt, then closed, and no lifecycle traffic.

The topology is inverted: the **unprivileged owner is the server** and the elevated broker the client,
so the owner chooses the kernel object's DACL. `provision_pipe.py` creates it with
`FILE_FLAG_FIRST_PIPE_INSTANCE`, one instance and `PIPE_REJECT_REMOTE_CLIENTS`, under a protected DACL
granting only SYSTEM, Administrators and the owner, and never disconnects it. A pipe name is random per
attempt and never reused.

The peers are bound by two kernel facts, not by frame fields:

- the owner accepts only the process id `ShellExecuteExW` returned, holding that handle open so the id
  cannot be recycled;
- the broker accepts only a pipe whose server process token SID is the owner SID it was asked to
  provision.

The HMAC on each frame (`provision_wire.py`) is integrity and session binding, not identity: the auth
key is on a command line any process running as the owner can read.

The broker re-validates everything (plan shape, owner binding, authorized roots, coverage, object type,
reparse state), applies by handle and reads the result back. Its refusals are a closed vocabulary
mirrored in `provision_wire.py` and reach the caller in `BrokerClientRefusalItem.broker_refusal`, never
parsed from `detail`. `descriptor_not_the_shipped_policy`, `managed_root_not_authorized` and
`provision_precondition_missing` report a rejected plan. `tier_identity_provision_failed` comes only
from the combined operation (its identity step failed; nothing was applied) and is reported as a tier
identity failure; every other failure (declined prompt, pipe timeout, broker exit, root creation
failure, refused plan) is a `WorkspaceAclRefusal` with the ACL step's recovery codes.

## Why this side creates the backend roots

The broker never creates a directory at a caller-named path. It authorizes the five backend roots
(`config_root`, `data_root`, `logs_root`, `payload_root`, `temp_root`) and every workspace root by
reading ownership off its own apply handle, so they must already exist and be owned by the owner.
`provision.py` creates them as the owner before elevation, and refuses before the UAC prompt if the
path set lacks one. The broker derives and creates `protected_root` and `isolation_root` under
`%ProgramData%` itself and writes `Administrators` as their owner: an owner who pre-created one would
hold `WRITE_DAC` implicitly, which that rewrite takes back. Creating a directory here is not evidence of
anything; reparse state, placement and ownership are decided on the elevated side, on a handle.

## Cold-start ordering

The native backend verifies the payload and builds the path set and ACL plan without copying files,
provisions tier identities, creates the empty owner-owned backend roots, and has the broker apply the
ACL plan (a newly created root forces the apply even if a marker matches). Only after a verified
receipt does Sandbox Manager stage the payload into `payload/current`, seed configuration and data, and
scaffold the workspace, so new files inherit their tier access without a recursive ACL update. Role
startup keeps its own provision check as a drift safety net.

## Isolation evidence

`isolation_evidence.py` records what the isolation report reads: the plan version and workspace root
classes of the latest verified receipt (or a marker hit, flagged as such), and each started role launch.
It never fails a provision or start. `acl_readback.py` runs the launcher's read-only
`--acl-readback --owner-sid <sid>` with the roots on standard input and returns `not_read` for anything
that did not run; `egress_readback.py` does the same for `--wfp-readback`; `account_sid.py` resolves
tier account names to SIDs. `native_isolation_report.py` and `native_egress_status.py` combine them with
`native_isolation.isolation_report_producer`.

## Tests

From `host\sandbox_manager`:

```powershell
uv run pytest tests/unit -k "broker_client or egress_readback"
uv run pytest -m windows_only tests/unit/test_broker_client_provision_pipe.py   # real named pipe
```
