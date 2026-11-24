# Manual acceptance-gate drivers

Scripts that collect evidence only a provisioned Windows machine can give: real tier accounts, an
elevated apply writing the shipped DACLs, and role processes running as tier accounts. Elevated evidence
cannot run in CI, so these criteria close on operator output recorded in a PR description; a driver makes
that output reproducible.

Nothing here is compiled, shipped, or reachable from either binary, and no product path may call one.

- **Owner:** the crate's reviewers.
- **Contract:** none. These exercise the Sandbox contract's native-isolation adapter from outside and
  report what they saw.
- **Allowed dependencies:** unlike the crate, a driver may import other repository packages, because its
  job is to drive the product's own path rather than restate it. Each driver names its imports and its
  deviations from the product path in its docstring and in the table below. A driver that needs a private
  name says so here and must not be given a product caller to make the import look ordinary.
- **Tests:** none; these are not collected by any lane (see [Automated counterparts](#automated-counterparts)).

| Driver | Imports outside the crate | Deviation from the product path |
|---|---|---|
| `p6_manual_gate.py --broker <exe> --launcher <exe> [--keep]` | `sandbox_manager.broker_client.{identity,provision}`, `sandbox_manager.native_isolation.paths`, `sandbox_policy.acl_plan`, the generated `broker-startup-catalog.json` | Calls `provision._run_provision_session` directly instead of the `ensure_workspace_acl_provisioned` wrapper, because it measures the elevated apply itself. Path set, plan, apply, pipe and readback are the product's. Run unelevated from the repo root. |
| `job_handle_probe.ps1 -Account <tier account> [-Targets ...] [-Out ...]` | none | Takes the tier account name as an argument rather than deriving it. The credential read and `CreateProcessWithLogonW` hop are the product's; the probe then acts as a hostile role and tries to duplicate a handle to a role's Job out of every process in that account and each owner launcher. |
| `gui_isolation_acceptance.ps1` (+ `gui_isolation_lane_checks.ps1`, `gui_isolation_{probe,checks,hop,native}.cs`) | `scripts/native-isolation/broker-account-name.ps1` (the golden-vector-checked mirror of `identity_name::account_name_for`). The C# is compiled at run time with the .NET Framework `csc.exe` into `%TEMP%`. | See below. |

## `gui_isolation_acceptance.ps1`

Checks whether each tier's private window station and desktop keep it away from the signed-in owner's
desktop, against the roles of a running app: 0 placement and token shape; 1 `SendInput` into the
focused owner window; 2–3 screen capture (BitBlt, Desktop Duplication); 4 a low-level keyboard hook;
5 window messages to the owner window; 6 opening `WinSta0`, its desktops and the clipboard, and
enumerating the owner's windows; 7 (only with `-RoleDesktopBoundary`) the full `WinSta0\Default` attach
sequence; R rows record what stays reachable without judging it. The launcher accepts only catalog roles, so the probe program is not
started by the launcher. Instead, per tier, the product's first hop (`CreateProcessWithLogonW`,
owner-readable credential, logon flags 0, null `lpDesktop`) starts a hop process as the tier account. The
hop picks a live product role of that tier (a direct child of a `--tier-runner` supervisor, its image under
that supervisor's payload root, on a `SuperClawTier-<pipe id>` desktop it holds handles to) and starts the
probe there the way the bootstrap starts the supervisor: `CreateRestrictedToken` with nothing disabled
and default DACL tier + SYSTEM, then `CreateProcessAsUserW`. The hop reads that token back; any difference
from the product supervisor's token makes the lane INCONCLUSIVE. These direct-lane probes run without a
Job, so without Job UI limits.

Parameters: `-Tier` (default `bootstrap`, `file_tool`, `network_connector`), `-Checks` (rerun a subset;
others report NOT RUN), `-AgentShell` (adds a file_tool lane in which the operator has the app's own agent
shell start the probe, inside the product Job with its UI limits), `-AgentShellOnly`,
`-RoleDesktopBoundary` (reproduces the `SUPERCLAW_NATIVE_ROLE_DESKTOP_BOUNDARY` flag's deny-only logon
SID), `-ProductProfileId`, `-Out`, and `-SelfTest` (a lookalike station and desktop in the hop's own
session; it debugs the driver and is never evidence).

Guarantees:

- The owner runs every check first with the same program; a check whose owner control fails is
  INCONCLUSIVE, never PASS. A tier result counts only with positive evidence that the check ran or a
  refusal with the expected error code (DENIED).
- Check 7 uses only VK_F24 and an in-memory one-pixel BitBlt; nothing is typed or saved.
- The placement check excludes only the hop and its console host; any other process of the tier account
  on `WinSta0` is FAIL and named.
- It writes security only on its own `%TEMP%` work folder (tier grants via `icacls`) and deletes it,
  revoking the grants if deletion fails. It copies every clipboard format and restores them after the one
  check that replaces the clipboard, and refuses to touch a clipboard it cannot copy.
- Every test process is tracked from creation and ended at cleanup; tier processes are reaped through the
  same first hop, matching image path, tier SID and creation time. A clipboard not restored or a
  leftover process or folder fails the run (exit 3).

The attack effects in checks 1–6 need a displayed, unlocked session and an operator.

## Automated counterparts

A driver mistake shows up as a refusal from the product code it drives (for `p6_manual_gate.py`, a
`provision_required` at the launch step), not as a false pass. The automated equivalents are
`host/native_isolation_broker/tests/tier_launcher.rs` and
`host/sandbox_manager/tests/unit/test_native_log_retention.py` (for `p6_manual_gate.py`),
`host/native_isolation_broker/tests/owner_job.rs` (the same-account half of the Job-handle probe; only
the cross-account half needs a provisioned host), and `tests/tier_desktop.rs` plus the crate's unit tests
(GUI placement, descriptors and token shape).
