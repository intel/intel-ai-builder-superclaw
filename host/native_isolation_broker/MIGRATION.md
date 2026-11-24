# L3 convergence: plan of record

This document is the plan of record for who owns native Windows privileged isolation.
It was written because that ownership was undeclared and work kept landing in the legacy fixed-account crate scheduled for removal.
TL-P8 deleted that crate; its source remains in git history before #2872.

**Target state.**
`native_isolation_broker` is the only product L3 for native Windows isolation.
`sandbox_manager` remains the only Sandbox lifecycle owner.
The privileged mechanism is an on-demand, signed, elevated executable invoked for a closed operation.
It is not a persistent Windows service and it never stores administrator credentials.

**Current state, as of this document.**
The broker now contains the product-side elevation, owner-by-tier identity, protected state,
handle-based DACL, Job, and stdio primitives required by removal gate 1.
Sandbox Manager now calls its closed provision operation and starts its production roles through the
launcher from the shipped launch catalog, and the installer clean flow calls its closed revoke
operation. It still has no signed installed evidence. The WFP applier (`src/wfp/`) is on the provision
path, after the ACL receipt, but installs only the persistent presence anchor - our sublayer, tagged with
the plan's `providerData` - and zero filters: `wfp::check_installable` refuses any plan that holds one.
The crate also builds the unelevated `native_isolation_launcher`, the same Sandbox adapter's
unelevated artifact for tier-local launch.
It is not a second product L3, not a second privileged component and not a second Sandbox lifecycle
owner; it exists because the elevated broker's token cannot hold
`SeAssignPrimaryTokenPrivilege`, so two hops that each stay inside one account replace the privilege
rather than acquiring it.
Both hops now exist: the owner hop logs the tier account on with `CreateProcessWithLogonW`, and the tier
hop starts the role with plain `CreateProcessW` inside that account.
P7 of the historical tier-local launch execution plan moved product traffic onto the launcher, and P8 deleted the broker's own `--launch-start` path and its explicit-token `CreateProcessAsUserW` launch.
The elevated broker now launches nothing into a tier account; its only process creation is the same-account Job launch behind `--self-test`.
TL-P8 then deleted the legacy crate, its Tauri startup bridge, its `setup`/`runner`/`connector-launcher` sidecars and their installer staging.
Every row below is done, and both removal gates are closed.

## History: the freeze on the legacy crate

While it existed, the legacy crate was a temporary source of measured Win32 primitives and was frozen against new product entry points.
Two changes landed in it after the L3 direction was set but before it was written down anywhere visible:
#2243 added 1729 lines across seven files plus two new ones, and #2252 added a fourth CLI surface and an installer dependency on it.
#2268 (`89c3fcb7a`) added `bootstrap-launcher` and `filetool-launcher` plus `launch.rs` / `setup_args.rs` as live product entry points after #2273 froze new bins.
Those were **freeze exceptions**, each tracked by a row in the disposition table below until TL-P8 deleted it.
Neither author had any way to know the crate was scheduled for removal, because nobody had said so outside an unmerged branch.

## Primitive disposition

The `Method` column records how each primitive reached this crate.
A primitive marked **move** was to be relocated with `git mv` so `git log --follow` and `git blame` keep working.
A primitive marked **replace** is a different primitive, not an evolution of the old one, and was written fresh; nothing was in the end moved.

| Source (legacy crate) | Destination (`host/native_isolation_broker/src`) | Method | Disposition |
| --- | --- | --- | --- |
| `windows/job.rs` | `job.rs` (`Job::create`) | **replace, done** | `Job` is a strict superset of the old `SandboxJob`: same kill-on-close, assign, `IsProcessInJob` verification and confirmed-terminate, plus active-process, per-process and per-job memory, hard CPU-rate and eight UI restrictions, RAII handles and a kill-guard for a launch that fails while still suspended. The source was deleted with the crate. |
| `windows/process.rs` | `process.rs`, `process_win32.rs`, `process_same_account.rs` | **split, done** | Stdio plumbing and the `STARTUPINFOEXW` attribute list exist once, in `process_win32.rs`. TL-P8 deleted `process.rs`'s explicit-token `CreateProcessAsUserW` path; what remains there is the broker's same-account Job launch for `--self-test`. `process_same_account.rs` is the same-account `CreateProcessW` path the tier runner uses, physically separated so the unelevated launcher has no token API in its module closure. `launcher/logon.rs` is the `CreateProcessWithLogonW` first hop. |
| `windows/dpapi.rs`, `windows/store.rs` | `secrets.rs`, `state.rs` | **replace, done** | The broker retains machine-scoped DPAPI, creates SYSTEM/Administrators-only files (tier credential blobs additionally carry an owner read-only ACE), verifies their DACLs by handle, and authenticates owner records. The source pair was deleted with the crate. |
| `windows/random.rs`, `windows/wide.rs` | `random.rs`, `wide.rs` | **replace, done** | The measured rejection sampling and UTF-16 behaviour are retained. The old helpers were deleted with the crate. |
| `windows/profile_env.rs` | `profile_env.rs` | **replace, done** | The broker retains `LoadUserProfileW` initialization for new accounts: it loads and unloads the profile once, at provision, and no launch loads one (`TIER_LOGON_FLAGS = 0`). It is load-bearing: launches strip `USERPROFILE`, so Bun's `os.homedir()` in openwork-server and opencode-router resolves through the account's profile directory and fails without one. Revoke deletes the profile (`tier_profile.rs`). The old helper was deleted with the crate. |
| `windows/identity.rs` | `identity_windows.rs` | **replace, done** | The broker uses stable owner-by-tier SAM names, authenticated `owner SID + tier -> account SID` records, transactional first provision, fail-closed half-state handling, and revocation. First release rotates only by revoke-and-reprovision, per the authority decision. The machine-global fixed accounts are gone; `reset-windows-sandbox-accounts.ps1` removes any a machine still carries. |
| `build.rs`, `setup.manifest` | `build.rs`, `broker.manifest` | **replace, done** | The broker has its own `requireAdministrator` manifest with `/MANIFEST:EMBED` plus `/MANIFESTUAC:NO`. The old pair was deleted with the crate. |
| `windows/acl.rs` | `acl_windows.rs` | **replace, done** | Additive path-based grants are replaced by exact, protected DACL application on an already-open handle with immediate byte-for-byte readback. Broker credential and owner-record files are born with the restricted descriptor. The old path API had no caller left and was deleted with the crate. |
| `ipc.rs`, `runner_client.rs`, `bin/runner.rs` | `frame.rs`, `protocol.rs`, `launcher/wire.rs`, launcher `--tier-runner` | **replace, done** | Free-standing runner ownership became bounded, authenticated operations. The framing, MAC construction and nonce rule exist once, in `frame.rs`; `protocol.rs` is the test boundary's protocol and `launcher/wire.rs` the launcher-to-tier-runner one. |
| `bin/setup.rs` | broker `--provision` / `--provision-session` / `--provision-identities-and-session` / `--revoke` | **replace, done** | Sandbox Manager provisions through the broker and the installer revokes through it. The Tauri startup bridge that ran `setup.exe` was deleted; fixed-account cleanup is PowerShell-only in `reset-windows-sandbox-accounts.ps1`. |
| `bin/connector-launcher.rs`, `bin/launch_opencode.rs` | `connector_service` catalog role | **replace, done** | No helper survived: the Connector is a catalog role the tier runner starts inside the Job the owner-side launcher holds. |
| `bin/bootstrap-launcher.rs` | bootstrap catalog roles via `native_isolation_launcher` | **replace, done** | **#2268 freeze exception, closed.** The bootstrap tier (OpenWork) is started by the tier runner from the launch catalog. |
| `bin/filetool-launcher.rs` | file_tool catalog roles via `native_isolation_launcher` | **replace, done** | **#2268 freeze exception, closed.** Same replacement as bootstrap-launcher. |
| `src/launch.rs` | `launch_catalog.rs`, `catalog_start.rs`, `catalog_roles/` | **replace, done** | **#2268 freeze exception, closed.** Launch assembly is resolved from the closed catalog, not a separate product surface. |
| `src/setup_args.rs` | `broker_wire.rs` start request, provision CLI | **replace, done** | **#2268 freeze exception, closed.** Argv/env forwarding became typed, catalog-validated start fields, not a parallel protocol. |

Where this table and the code disagree, the table is wrong and should be corrected in the same PR that makes them disagree.

## The duplication that actually needs watching is inside this crate

The `job.rs` and `process.rs` rows above were both written as `move` and then corrected, because checking them found the real problem somewhere else.

Job ownership was split across three mechanisms: the legacy crate's `SandboxJob` in its runner,
Sandbox Manager's outer kill-on-close Job, and this broker's measured Job boundary. TL-P8 deleted
the first two; each role's Job is now created from `job.rs` by the owner-side launcher, which holds it
for the role's lifetime (#3010; before that, the tier runner created it). When this section was
written, the first two applied kill-on-close only; contrary to an earlier version of this document,
there was no production `create_tier_job`, no second `JOB_MEMORY_LIMIT`, and no reviewed production
tier CPU/memory/UI budget in the tree.

The broker's measured limits therefore remain explicitly named `FixedSleepTest`, and only the test
boundary uses them. They must not be silently reused for OpenWork, OpenCode, or Connector: a limit
sized for one sleeping test child is not a product tier policy. The production roles instead take the
profile of their tier from `JobLimitProfile::for_tier` - `BootstrapTier`, `FileToolTier` or
`ConnectorTier`, sized in `job.rs`.

The convergence should therefore land one Job module with named limit profiles per reviewed
purpose, and one stdio-plumbing module, rather than moving another copy in from the legacy crate.
Consolidating these was a precondition for the removal gate below, not a follow-up.

The stdio-plumbing half of that is now done inside this crate.
`process_win32.rs` is the single implementation of handle ownership, stdio pipe inheritance and the
`STARTUPINFOEXW` attribute list, and both launch paths, the broker's `--self-test` launch and the tier runner's, build on it.
Splitting the launch paths into two files is not a fourth Job mechanism: `job.rs` remains the one Job
module, and both paths use it.

The same consolidation has now happened to the pipe protocols.
This crate has three of them - the test boundary's, the launcher-to-runner transport's and the provision
session's - and will keep them apart, because the test boundary's lease actions have no business
in a production frame set; what it must not have is two implementations of length-prefixed framing, two
HMAC constructions and two nonce rules.
`frame.rs` is the single implementation of all three, and `protocol.rs`, `launcher/wire.rs` and
`provision_session/wire.rs` all build on it.
The one thing it deliberately does not centralise is the frame budget: each boundary is handed its own,
because 16 KiB, 64 KiB and 96 KiB are all correct answers for different boundaries and a single constant
would have to be wrong for two of them.
`sid_win32.rs` and `random_bytes.rs` are the same story on a smaller scale - one SID-text implementation
and one CSPRNG helper the launcher's module closure can reach without linking the broker library.

## Product wire

The only allowed product call graph is:

```text
ServiceHub
  -> sandbox_manager (L2 lifecycle owner)
    -> sandbox_policy (L1 plan)
    -> native_isolation_broker (L3 apply/start)
    <- evidence receipt
  <- RuntimeStatus (L2b verified attestation)

installer clean
  -> native_isolation_broker (closed revoke only)
```

`native_isolation_launcher` does not appear in that graph and must not be added to it as a caller.
It is an implementation detail of the L3 apply/start step above: Sandbox Manager's
`broker_client.start_role` invokes the launcher, and the launcher invokes itself for the second hop.
Nothing else may invoke it.

## Two new host dependencies

The tier-local launch takes on two environment dependencies the token-based launch did not have, both
identified during the launch-authority privilege review.

The Secondary Logon service (`seclogon`) must be startable, because it is what implements
`CreateProcessWithLogonW`.
Its shipped start type is Manual, which is sufficient - Windows starts it on demand - but an image that
has disabled it cannot perform the first hop at all.
The tier accounts must also retain the right to log on locally, which the default `Users` grant provides
and a `Deny log on locally` policy can remove.

Neither is checked ahead of a launch, because a check that passed a moment before the call would prove
nothing about the call.
Both instead have their own refusal reason, `seclogon_unavailable` and `local_logon_denied`, each
carrying the operator action; an install that hardens either setting therefore fails loudly with a
remedy rather than emitting a Win32 code.

No Tauri, ServiceHub, runtime, plugin, or guard code may call the broker directly. The installer
exception is limited to cleanup revoke and does not confer lifecycle ownership.

Until TL-P8 the Tauri shell violated that boundary through a path dependency on the legacy crate and a
startup bridge that ran its elevated `setup` sidecar. TL-P8 deleted both; the shell now only starts
ServiceHub.

## Removal gate (closed by TL-P8)

The legacy crate could be deleted once all of the following held. All four do, and it was deleted.

1. The broker has tests for owner-by-tier identity, credential-file ACLs, handle-based ACL apply with readback, suspended Job launch, and cleanup.
   Job construction and stdio plumbing exist once each, with limit values named rather than inlined, per the section above.
2. The installer calls a signed broker operation for owner-by-tier revoke.
   `packaging/installer/reset-windows-sandbox-accounts.ps1` invokes broker `--revoke` (no Authenticode check: a
   locally built broker is unsigned), then verifies the current owner's accounts and protected state are gone.
   It then removes any leftover legacy fixed accounts, their profiles and their credential directory
   with PowerShell alone, and fails if any of them remain.
   `--revoke` also removes the WFP filters and sublayer this product owns (EG2-13); the post-revoke
   verification above does not check WFP, so a refusal naming `wfp` is the only signal that they remain.
3. **Closed.** `apps/desktop/src-tauri` no longer depends on the crate and starts ServiceHub directly.
   Provisioning belongs to Sandbox Manager, which calls broker `--provision` / `--provision-session`,
   or `--provision-identities-and-session` for a first start that needs both.
   The equivalent of the old bridge's per-tier logon check is every launch itself: hop 1 is
   `CreateProcessWithLogonW` into the tier account, and a logon that cannot succeed is refused with a
   typed `provision_required` (account, credential or its protection not as provisioning left it, or
   the logon still rejected after the one credential reread) or `local_logon_denied` (policy forbids
   the tier account a local logon) reason from `src/launcher/refusal.rs`, rather than a
   startup-time probe that proves nothing about the next launch.
4. **Closed.** Every row in **Primitive disposition** is marked done.

No connector helper remained: the Connector is a catalog role the tier runner launches, in a Job whose membership and lifetime the owner-side launcher owns.
