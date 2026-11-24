# Native isolation broker

Windows-only Rust crate behind the native sandbox. It owns the owner-by-tier identities (one local
account per tier per owner), their protected credentials, handle-based DACL apply and readback, the WFP
presence anchor, and the unelevated launcher that starts every sandbox role in its tier account and Job.

- **Ownership:** a leaf adapter of the `Sandbox` lifecycle contract. Sandbox Manager
  (`host/sandbox_manager/src/sandbox_manager/broker_client/`) is the only product caller and the only
  lifecycle owner; the installer's uninstall/clean flow calls `--revoke` only.
- **Contracts:** the closed command lines in `BROKER_ELEVATED_OPERATIONS`, the startup catalog
  (`shared/contracts/generated/data/broker-startup-catalog.json`), the ACL and egress policy
  descriptors, and the refusal envelopes (`BrokerTierLaunchRefusalSchema`), all in `shared/contracts`.
  [`MIGRATION.md`](MIGRATION.md) records how the product wire converged on this crate.
- **Allowed dependencies:** Serde/JSON, HMAC-SHA256 (`hmac`, `sha2`), `hex`, and `windows-sys`. No
  Tauri, async runtime, service framework, or other repository package. `embed-resource` is a
  build-dependency only. `tools/` is the one exception (see [`tools/README.md`](tools/README.md)).
- **Tests:** see [Verification](#verification).

## Binaries

| Binary | Manifest | Role |
|---|---|---|
| `native_isolation_broker` | `requireAdministrator` | On-demand elevated process: one closed operation per invocation, then exit. Not a service; stores no administrator credentials. |
| `native_isolation_launcher` | `asInvoker` | Unelevated, runs as the owner. Starts a role in its tier account (two hops), holds the role's Job, and serves the read-only ACL and WFP readbacks. |
| `native_isolation_tier_bootstrap` | `asInvoker` | First-hop image, runs briefly as the tier account to create the tier's private window station and desktop and start the restricted runner there. Must sit beside the launcher. |
| `native_isolation_test_child` | `asInvoker` | Fixed child used by self-tests and integration tests. |

Only the broker is in `build.rs` `ELEVATED_BINS`. `tests/launcher_closure.rs` checks, in the declared
source closure and in the linked bytes, that the launcher carries no `CreateProcessAsUserW`,
`AdjustTokenPrivileges`, `SeAssignPrimaryTokenPrivilege` or `LogonUserW`, and that it does carry
`CreateProcessWithLogonW`.

## What this does and does not establish today

Established by the code:

- each sandbox tier (`bootstrap`, `file_tool`, `network_connector`, `channel`) runs as its own local
  account, distinct from the owner and from each other;
- the backend and workspace roots carry the shipped ACL policy, applied elevated by handle and read back
  exactly, with drift answered by a typed `provision_required`;
- every role runs in a kill-on-close Job held by the owner-side launcher, with no breakaway and the
  Job's UI limits;
- each tier role starts on a private window station and desktop.

Not established:

- **The isolation report names no level.** Sandbox Manager reports `isolation_level: not_established`
  until a runtime policy attestation exists.
- **Network egress is not enforced.** Provisioning installs the WFP sublayer as a presence anchor with
  zero filters (see [Network egress (WFP)](#network-egress-wfp)). Tier processes can reach the network
  and any loopback port directly.
- **The desktop is not a role-level boundary.** Tier tokens keep the owner's interactive logon SID
  enabled by default, so a role can reopen `WinSta0` and the owner's desktop; the Job UI limits do not
  cover `SendInput` or screen capture. Restoring a boundary is #3838; an opt-in spike exists (see
  [Crossing into the tier account](#crossing-into-the-tier-account)).
- **Bootstrap creation race** (#3713): see the residual window below.
- **No measured payload.** Every executable digest in the startup catalog is still the unreleased
  sentinel (all zeros) a signed payload would replace, and nothing verifies the broker's or launcher's
  signature.
- The `--self-test` pipe receives its 32-byte HMAC key on the command line, readable by the owner. This
  is acceptable only for the test proof; production provisioning uses the provision pipe below.

## Elevated operations

| Command line | Caller | What it does |
|---|---|---|
| `--provision --owner-sid <sid>` | Sandbox Manager | Ensures the owner's tier accounts, credentials and records |
| `--provision-session --owner-sid <sid> --pipe-id <id> --auth-key <hex>` | Sandbox Manager | Applies the workspace ACL plan received over the provision pipe, then installs the WFP presence anchor |
| `--provision-identities-and-session` (same three values) | Sandbox Manager | Both of the above in one elevation, so a first start shows one UAC prompt |
| `--revoke --owner-sid <sid>` | Uninstall / clean | Removes everything provisioning created for the owner |
| `--revoke-workspace-authorization --owner-sid <sid>` | no product caller | Removes the owner's workspace authorization snapshot; takes no payload |
| `--self-test` | Developer, elevated terminal | Same-account Job and pipe proof (see [Test boundary](#test-boundary)) |

None takes a path, a plan or free text. `src/elevation_contract_tests.rs` parses the golden command
lines published in `shared/contracts`.

`--revoke` attempts every step even if one fails, in order: the recorded workspace ACEs, every tier
account in `IsolationTier::ALL` with its credential, record and profile, the workspace authorization
snapshot, and every WFP object in this product's sublayer (filters, then the sublayer, in one
transaction). Failed steps are named in the refusal's `detail` and the exit code is non-zero; rerunning
converges.

### The provision session

Applying the workspace ACL plan needs elevation, and a plan is too large and structured for a command
line, so it travels over a named pipe. The topology is inverted: the **unprivileged owner is the
server** and this elevated process the client, so the owner chooses the pipe's DACL (SYSTEM,
Administrators and itself, `FILE_FLAG_FIRST_PIPE_INSTANCE`, one instance,
`PIPE_REJECT_REMOTE_CLIENTS`). Production code here has no `CreateNamedPipeW` for provisioning; the
server in `src/provision_session/pipe.rs` exists only under `#[cfg(test)]`.

The peers are bound by kernel facts: the owner accepts only the process id `ShellExecuteExW` returned
(holding the handle so the id cannot be recycled), and the broker accepts only a pipe whose server
process token SID equals `--owner-sid`, checked before any request is read. Frames reuse `src/frame.rs`:
four-byte little-endian length, strict JSON rejecting unknown fields, HMAC-SHA256, non-repeating nonces,
at most four frames per connection. The HMAC is integrity and session binding, not identity. The
conversation is one request and one receipt; the pipe is never disconnected, so the single instance is
never returned to the namespace.

What arrives is caller input. The broker validates the plan's shape, owner binding, every root against
the authorized set, coverage bounds, object type and the reparse state of every component of every
managed-root path, applies on a verified handle, and reads back for an exact match. A converged plan is
a no-op. The receipt returns the normalized path-set and ACL-plan digests. Refusals that report a
rejected plan rather than a broken frame are `provision_precondition_missing`,
`descriptor_not_the_shipped_policy` and `managed_root_not_authorized`; a path set naming a root this
process cannot find is `managed_path_refused`.

In the combined operation the identity step runs after the pipe is bound, the request authenticated,
the forbidden-field scan passed and the owner binding checked, but before the plan's structure and
policy are checked; it is idempotent and scoped to the authenticated owner. If it fails, nothing is
recorded or applied and the receipt is `tier_identity_provision_failed` (never
`provision_precondition_missing`, which would make the client re-provision and prompt twice more).

**No object is created at a caller-named path.** `protected_root` and `isolation_root` are derived from
`%ProgramData%` and created here. The five backend roots (`config_root`, `data_root`, `logs_root`,
`payload_root`, `temp_root`) and every workspace root must already exist and be owned by the
authenticated owner, read off the apply handle. No apply writes a requester SID as an object owner: an
owner holds `WRITE_DAC` implicitly. Owner-owned roots keep their owner and get only their DACL; the two
derived roots and everything created inside an authorized root are owned by `Administrators`
(`isolation_root` holds the identity records and credential blobs, and grants the owner read only).
Writing `Administrators` also repairs a `%ProgramData%` folder an ordinary user created first, and is the
only owner `SetSecurityInfo` accepts when a standard user satisfied UAC with another administrator's
credentials.

The owner's `%LOCALAPPDATA%` provision marker is a UAC hint written by the client after a receipt;
nothing in this crate reads it. The launcher decides whether roots are provisioned by its own
`READ_CONTROL` exact DACL readback.

### ACL policy layout

The shipped ACL policy descriptor lives in `shared/contracts` (planned by `host/sandbox_policy`). The
backend roots must use the fixed layout `B/config`, `B/data`, `B/logs`, `B/payload/<name>` (the host
uses `current`) and `B/tmp/<session>`; split custom roots are refused. The parent directories are
derived and must already be owner-owned; their tier grants are read/traverse on the object only.

When the backend root is `<profile>\AppData\Local\SuperClaw\backend`, the folders `AppData`,
`AppData\Local` and `AppData\Local\SuperClaw` each get one allow ACE: `sandbox_tier_file_tool`,
`FILE_READ_ATTRIBUTES` (`0x80`), this folder only, no inheritance. Node's realpath `lstat`s every
component from the drive root, so without it every npm/npx run in the file_tool tier fails with
`EPERM lstat C:\Users\<user>\AppData`. The folders are derived from the fixed layout, and the profile must
be the owner's own as `HKLM\...\ProfileList\<owner SID>\ProfileImagePath` records it; a profile-shaped
backend anywhere else is refused as `managed_root_not_authorized`. The ACE is added only if missing,
with `SetKernelObjectSecurity` (not `SetNamedSecurityInfo`, which would re-propagate inheritance over
the whole profile), after every other root so a refused plan leaves nothing on the profile. Each ACE
actually inserted is recorded in `profile_ancestor_aces`; `--revoke` and tier SID rotation remove
exactly those. The launcher's readback reports a missing ACE as `profile_ancestor_ace_absent`.

## Network egress (WFP)

What ships is the presence anchor: after the ACL receipt, the provision session installs this product's
persistent WFP sublayer, tagged with the plan's `providerData`, and **zero filters**.
`wfp::check_installable` refuses any plan that holds a filter (`wfp_objects_not_installable`), so nothing
a provision writes can block traffic. A failed install is reported on the pipe and never fails the
provision. The launcher reads the anchor back with `--wfp-readback --owner-sid <sid>` (plan on standard
input). The enforcing path exists and is tested against a fake engine only. Enforcement is tracked in
#3355.

Turning enforcement on requires, in order:

1. **Descriptor switch.** Ship the enforcing egress descriptor in place of the permissive one
   (`EGRESS_POLICY_DESCRIPTOR`, a policy-version bump with a reviewed digest). Until then
   `SUPERCLAW_NATIVE_EGRESS_WFP_PLAN=enforcing` in Sandbox Manager selects the reference plan for
   development.
2. **Broker gate.** Lift `check_installable`'s "no filter" refusal, first for `log_only`, then
   `enforce`.
3. **Proxy mode.** Run the egress proxy in `enforce`: WFP closes the direct path and the proxy decides
   what goes through it. Enforcing WFP with a `log_only` proxy is not a boundary.

Before enabling it, verify on the installed build: every Python service in each tier starts (CPython's
`socketpair` needs the host's loopback dynamic range, which the reference plan leaves open to every
tier; check `netsh wfp show netevents` for `CLASSIFY_DROP`), including on a host whose dynamic port range
is not the default; the `#[ignore]`d real-engine tests in `src/wfp/tests/engine_tests.rs`, run by hand,
elevated, `log_only` first, on a machine you can recover; the UAC count of a first start and of a start
whose DNS or PAC answer changed (one elevation); start-up time with the plan resolved (PAC fetch and DNS
happen at plan-build time, cached 60 s); every feature on no-proxy, static-proxy and PAC hosts; and
`scripts/egress/negative-probes`.

## Unelevated launcher

An interactive elevated administrator token lacks `SeAssignPrimaryTokenPrivilege`, so the broker cannot
`CreateProcessAsUserW` into a tier account (Win32 1314). Instead of acquiring the privilege, the launcher
starts a role in two hops that each stay inside one account.

| Form | Runs as | Purpose |
|---|---|---|
| `--launch-tier --owner-sid <sid> --tier <tier>` | owner | Starts a catalog role in the tier account; Sandbox Manager drives start and stop over its standard input. The Connector's launch also takes `--connector-client-handle <decimal>`. |
| `--tier-runner --tier <tier> --pipe-id <id> --auth-key <hex>` | tier account | The runner (supervisor): starts the role with plain `CreateProcessW`. |
| `--acl-readback --owner-sid <sid>` | owner | Read-only exact DACL comparison of the roots (request on standard input). |
| `--wfp-readback --owner-sid <sid>` | owner | Read-only readback of the WFP anchor (plan on standard input). |
| `--tier-loopback-self-test --owner-sid <sid> --tier <tier> --runner-sid <sid>` | owner | Both hops in one account, for unelevated transport tests only. |

No form accepts an executable path, a command line, a shell or a free-form argument; every argument is a
SID, a tier name, a random pipe id, a session key or that handle number. Each role's program, arguments,
working directory and environment are assembled from validated catalog bindings
(`src/catalog_roles/`, `src/catalog_start.rs`).

The production forms take neither an account name nor a runner SID and refuse both. The account name is
derived from the owner SID and tier by `identity_name::account_name_for` (the single definition), and the
runner SID is resolved from it with `LookupAccountNameW` and must name a local user. `--owner-sid` must
equal the launcher's token user. Owner and runner SIDs must differ, because the pipe DACL grants the owner
full access and the runner one direction-specific right.

### Production roles

The startup catalog has seven production roles:

| Role | Tier |
|---|---|
| Supervisor (agent-runtime supervisor) | bootstrap |
| Runtime (`opencode serve`) | file_tool |
| openwork-server | file_tool |
| HDR sidecar (only when the Product Profile requires it) | file_tool |
| opencode-router (Slack/Telegram bridge) | channel |
| Connector service | network_connector |
| Egress proxy | network_connector |

openwork-server is in file_tool because it opens the workspace. opencode-router holds the Slack and
Telegram tokens, never opens the workspace, and reaches the project only through the inbox, outbox and
agent definition the ACL policy opens to the channel tier. The router has two bearers: the control token
(`router_control_token`, bindings and identities, bound to the router only) and the scoped token
(`router_scoped_token`, status and send, bound to the router, openwork-server and the runtime).
Credentials reach roles as owner-minted scalars in the environment, never in argv; the Connector's
client keys go back over its launch's third pipe (see [Role output](#role-output)).

### Crossing into the tier account

The first hop is `CreateProcessWithLogonW` with `TIER_LOGON_FLAGS = 0` (no profile hive is loaded at
launch; provisioning loads each tier profile once so its directory exists, and `--revoke` deletes it).
The password comes from the owner-readable credential file (`credential_read::read_credential_for_owner`),
DPAPI-unprotected into the zeroizing containers of `src/zeroize.rs`; every representation is wiped and
neither container implements `Debug`. The confidentiality boundary is the credential file's DACL plus
machine-scoped DPAPI. A logon is retried once against a freshly reread credential on
`ERROR_LOGON_FAILURE` or `ERROR_NO_SUCH_LOGON_SESSION`; a second failure is `provision_required`.

The bootstrap is created suspended. The owner assigns it to the role's Job and replaces its process and
primary-thread DACLs before it runs. The bootstrap creates the tier's private window station and a
per-launch desktop, and starts the runner there with a restricted copy of its own token. When the
bootstrap's handoff arrives, the owner adds the Job's eighth UI limit (desktop creation, which the
bootstrap needed for `CreateDesktopW`), verifies the station, desktop and the runner's process and
thread, ends the bootstrap, verifies the runner's `DesktopInfo`, and resumes the runner. It verifies the
runner's token at each pipe binding, by impersonation, before sending anything.

The runner's environment is explicit and never the owner's: `resolve_cross_account_environment` drops
`USERPROFILE`, `APPDATA`, `TEMP`, `TMP`, `USERNAME` and the rest of `PER_ACCOUNT_ENVIRONMENT`. With no
profile loaded, a role that needs a per-tier writable path must declare it; every production entry binds
`state_temp_root` and sets `TEMP`/`TMP` from it.

The tier account must be able to read and execute the launcher image and traverse its directory (a
default install under `Program Files` gets this from the `Users` ACE).

**Residual window (#3713).** From `CreateProcessWithLogonW` until the bootstrap's own protection
completes, a process of any tier can open the bootstrap's process and primary thread (until the owner
replaces their DACLs) and loader-created threads (until the bootstrap protects them) with the
`GENERIC_READ | GENERIC_EXECUTE` the tier token's default DACL gives the owner's logon SID; a handle
opened then survives the protection. The suspended runner grants its own tier full access by design, so
until the owner resumes it a same-tier process can write its memory or resume it; the owner refuses an
early resume it detects but cannot undo code that already ran (under seven of the eight UI limits if
before the seal).

**Desktop boundary flag (#3838).** `SUPERCLAW_NATIVE_ROLE_DESKTOP_BOUNDARY=1` (exactly `1`; anything
else is off) makes the supervisor/role token carry the owner's logon SID deny-only. The owner then adds
the tier SID to this session's `BaseNamedObjects` directory with exactly `0x2000f` (the mask KernelBase
requests), serialized by a bounded file lock under the backend root and never touching global
`\BaseNamedObjects`. The owner logs `role_desktop_boundary=on|off` on each `event=bootstrap_created`
line. It is off by default.

### Refusals

Each refusal is one JSON line on standard output plus a human-readable line on standard error
(`src/launcher/refusal.rs`): `provision_required` (anything on the account and credential path),
`seclogon_unavailable` (Secondary Logon not running), `local_logon_denied` (policy forbids the tier
account logging on locally), and `windows_api_failure` (everything else; for an unreadable launcher
image the detail names the file and the missing right). The envelope carries tier, owner SID, account
name, reason, detail and remedy, never anything derived from a credential, and is mirrored by
`BrokerTierLaunchRefusalSchema`; `shared/contracts/fixtures/native-isolation-broker/valid-tier-launch-refusal.json`
is parsed by both sides.

### The role's Job

The owner-side launcher creates the Job (unnamed, non-inheritable) before the runner exists, and the tier
never holds it: a role shares the runner's account, so a runner-held Job could be duplicated and kept
alive or loosened. The suspended bootstrap is assigned through its creation handle and membership read
back before resume; the runner is created suspended inside the Job and checked before resume. The role
and its descendants inherit the Job, which forbids breakaway. Each Job profile allows two processes on
top of the role's budget (`RUNNER_PROCESSES` in `src/job.rs`) for the bootstrap and supervisor.

What the runner reports is checked against the Job: the reported role must be in the Job's process list
and must not be the runner. Stop is `TerminateJobObject` in the owner followed by `ActiveProcesses`
reaching zero, so a hung or lying runner cannot delay or fake it; the completion report carries this as
`owner_job`. EOF on Sandbox Manager's control stream means the same as its `Stop` frame. A dead launcher
closes the Job's last handle (kill-on-close); a dead runner is seen on the next poll and the Job is
terminated. One window remains: a launcher killed between creating and assigning the suspended bootstrap
leaves a suspended process in no Job; if resumed it finds its pipes gone and exits without starting a
role.

A role is created suspended with `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, so it inherits only the read end of
its stdin pipe and its log handle. Its environment is an explicit UTF-16 block from a fixed allowlist plus
the catalog's declared variables (`lpEnvironment` is never `NULL`). Every wait is bounded and every pipe
drained.

### Launcher-to-runner transport

Two one-way named pipes (a Connector launch adds a third): the control pipe carries `Start`
(launcher → runner) and the report pipe carries `Started` (runner → launcher). The tier receives only
`FILE_READ_DATA` on the control pipe and `FILE_WRITE_DATA` on the report pipe, plus the `SYNCHRONIZE` and
`FILE_READ_ATTRIBUTES` NPFS requires; `tests/tier_pipe.rs` proves each grant minimal by removal. Each
pipe is single-instance, `FILE_FLAG_FIRST_PIPE_INSTANCE` and `PIPE_REJECT_REMOTE_CLIENTS`. Only the pipe
id is random, so a same-user process can squat a guessed name; the launcher then refuses the launch
rather than adopt the squatter's pipe (an availability effect only).

Each connection is bound separately to the runner's exact process id (`GetNamedPipeClientProcessId`) and
token SID. Frames are length-prefixed strict JSON, closed to `Start` and `Started`, HMAC-SHA256
authenticated with per-connection nonces and a 64-frame cap. The runner's report is tier self-report:
which primitive started it is reported as `launch_path` (`tier_logon` or `loopback_self_test`), and
kernel-checked claims are named as such. Byte movement (`src/pipe_io.rs`) is overlapped against
deadlines; an operation cancelled after moving bytes retires its endpoint.

### Role output

The runner opens the role's log and binds it to both output streams, so no thread copies role output.
The file is `<state_logs_root>\<tier>\<launch-id>.log`, where the launch id is this launch's hex pipe id
validated against `BROKER_ROLE_LOG_RULES`; it is opened `CREATE_NEW` and append-only (`src/role_log.rs`).
The runner never creates the directory: the ACL policy gives a tier add-file and traverse in its own log
subtree only. A role log is created and therefore owned by the tier, so it is **never security
evidence**. Pruning is the owner's job (`host/sandbox_manager/src/sandbox_manager/native_log_retention.py`,
called before each tier's roles launch; a failed prune never blocks a launch).

Standard input carries exactly one thing: the Connector's bootstrap line, generated in the runner and
written once. Its two symmetric keys are drawn in the runner; the caller's copy (its client
configuration) goes back over the Connector launch's third pipe, authenticated with the launch key, and
the launcher writes it to the handle passed as `--connector-client-handle`.

## Test boundary

`--self-test` starts the protected test pipe and a client under the current user. The private test
protocol has no executable or command field: `acquire` accepts only `fixed_sleep_child`, and the broker
starts its own fixed `--test-child --sleep-ms 60000` suspended, assigns it to a Job, verifies membership
with `IsProcessInJob`, then resumes it. The Job is kill-on-close with an active-process limit of 6, 256
MiB per process and 512 MiB per Job, a 20 % hard CPU cap, UI restrictions and no breakaway. The broker
holds the last Job handle; lease timeout, explicit release, pipe loss or broker exit terminates it.

Test requests are capped at 16 KiB and 64 per connection, reject unknown fields, and are authenticated
with HMAC-SHA256 and non-repeating nonces. The broker requires the pipe client's token SID to equal both
the configured owner SID and the request's `owner_sid`. Frame limits are per boundary: 16 KiB for the
test protocol, 64 KiB for a catalog start request, and a production envelope sized from that inner limit.

## Building

```powershell
cargo build --release      # broker, launcher, tier bootstrap and test child under target\release
```

The build needs the MSVC toolchain and Windows SDK (`rc.exe`, `mt.exe`). `embed-resource` compiles
`resources/*.rc` into the version info the UAC dialog shows, including `resources/superclaw.ico` (a copy
of `apps/desktop/src-tauri/icons/icon.ico`; refresh it when the app icon changes). The stamped version is
`SUPERCLAW_BUILD_VERSION` when set (four numeric parts, otherwise the build fails), else the crate
version; `scripts/native-backend/build-native-backend.ps1` always sets it.

For an inner loop, `cargo install cargo-watch` and run `cargo watch -x "build --release"` here, then
point a source-checkout Sandbox Manager at the result with `SUPERCLAW_NATIVE_ISOLATION_BROKER` and
`SUPERCLAW_NATIVE_ISOLATION_LAUNCHER` (see "Inner loop" in
[`host/sandbox_manager/README.md`](../sandbox_manager/README.md)). No signing step is needed. A rebuild
copied into a staged payload is also accepted as long as its size matches the payload manifest.

## Verification

From this directory. Unit tests run through the library target, so they need no elevation:

```powershell
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo run --bin native_isolation_broker -- --self-test   # elevated terminal
```

Criteria that need a provisioned host are collected outside CI, and their output belongs in a PR
description:

- `tests/tier_desktop.rs`, opt-in on a machine with provisioned tier accounts:
  `$env:SUPERCLAW_TIER_ACCOUNT_TESTS=1; cargo test --test tier_desktop -- --ignored`. It launches
  through the real two hops and checks the supervisor's and role's desktop, token and Job UI limits, and
  that repeated launches leave nothing behind.
- `tools/p6_manual_gate.py` (real tier accounts, the elevated apply, a tier creating its own log),
  `tools/job_handle_probe.ps1` (no tier process can duplicate a role's Job handle), and
  `tools/gui_isolation_acceptance.ps1` (GUI-boundary checks against a running app). See
  [`tools/README.md`](tools/README.md). A `-SelfTest` run of the GUI driver is never evidence.

Still outside this crate's proof: exact account logon rights, installed broker selection and signature
verification, restart-persistent replay defence, descendant/breakaway/elevated matrices, and
lifecycle-owner death on disposable elevated hardware.
