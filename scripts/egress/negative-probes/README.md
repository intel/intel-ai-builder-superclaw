# Egress negative probes

A harness that asks, from a process **running inside each tier account**, whether an enforcing
build refuses what the egress policy says it refuses and still allows what it declares. It is
the measurement behind a future isolation-report attestation for the WFP boundary.

> **Not run in CI, and not run by default.** It needs an **installed build with WFP enforcement
> on** and the egress proxy in `mode=enforce` (the EG2-11 rollout in
> [`host/native_isolation_broker/README.md`](../../../host/native_isolation_broker/README.md)),
> and the machine owner's approval. No shipped build has enforcement on, so against a shipped
> build the block cases FAIL by design. Nothing here is called by the product, the installer or
> any workflow.

## Ownership, dependencies, contract

- **Owner:** the native egress isolation work. **Contract:** leaf change; it reads nothing from
  the product and implements no contract. It judges against the egress policy descriptor's
  dispositions ([`shared/contracts/src/egress-policy-descriptor.ts`](../../../shared/contracts/src/egress-policy-descriptor.ts)).
- **Reuses** `scripts/native-isolation/egress-bench/`: its tier launcher (`Invoke-BenchBatch`,
  the same `CreateProcessWithLogonW` shape the product's tiers use), its `probe.ps1` /
  `probes.ps1` probe library, and its control-paired verdicts (`Resolve-BenchVerdict`, identity
  check, overall and exit codes). Windows PowerShell 5.1 and Pester 3.4 (in-box) only.

## What it changes

Nothing system-wide, and it never runs elevated. It creates `-OutDir`, grants each tier account
Modify on its own work directory under it, and writes one JSON report. The tier credentials are
the DPAPI blobs that `scripts/native-isolation/export-tier-credentials.ps1` exported (an
elevated step the owner runs; `run.ps1 -CredentialDir` defaults to
`%ProgramData%\SuperClaw\isolation\probe-logon-flags`). Passwords stay in memory for one logon.

## Cases

Each case runs as the owner first (the control) and then as its tier. A block counts only when
the control connected (otherwise INCONCLUSIVE, never PASS), and a probe that did not run as the
tier's account is INVALID.

| Id | Tier | Asserts |
|---|---|---|
| FT1 | file_tool | direct TCP to a public host fails |
| FT2 | file_tool | via the shell proxy (`CONNECT`), an unlisted host is refused or held |
| FT3 | file_tool | via the shell proxy, a listed host works |
| FT4, FT5 | file_tool | the channel proxy's port and the Sandbox Manager's port are not reachable |
| CH1 | channel | direct TCP to a public host fails |
| CH2 | channel | its own proxy port is reachable |
| CH3, CH4 | channel | the shell proxy's port and the Sandbox Manager's port are not reachable |
| NC1.n | network_connector | each upstream / PAC endpoint the plan permitted is reachable |
| NC2 | network_connector | an internal address that is not one of them is not reachable |
| NC3 | network_connector | loopback (the shell proxy's port) is not reachable |
| NC4 | network_connector | direct TCP works when the plan has no upstream (`not_applicable` when the network has none) |
| FT6, CH5, NC5 | each tier | a loopback self-connect inside the host's dynamic range works |

FT6, CH5 and NC5 are the socketpair shape: listen on `127.0.0.1` port 0 and connect to it from
the same process (the egress bench's `socketpair` probe kind). CPython's `socket.socketpair()`
on Windows is exactly that, and the enforcing WFP plan leaves loopback TCP inside the host's
dynamic port range open to every tier for it. A FAIL here means a tier cannot run asyncio.

FT2 and FT3 use `https` through the proxy so that a refusal is a failed `CONNECT`; a plain
`http` request would carry the proxy's 403 back as a status and read as "connected". Their
control is a TCP connect to the proxy's listener, so "refused or held" is judged against a live
proxy. FT3 needs the shell listener to accept an uncredentialed `CONNECT` for a listed host (no
approvals mode); if the proxy asks for a credential it reports FAIL, not a wrong PASS. A held
request (waiting for an approval) times out and counts as stopped.

## Running

```powershell
# The pure logic (config validation, case matrix, verdict rows, report shaping). No tier, no network.
powershell.exe -NoProfile -Command "Invoke-Pester scripts\egress\negative-probes\tests"

# Show the cases for a config without running anything.
powershell -ExecutionPolicy Bypass -File scripts\egress\negative-probes\run.ps1 `
    -ConfigFile <your-config>.json -OutDir <out-dir> -DryRun

# The real run: installed enforcing build, unelevated, with the owner's approval.
powershell -ExecutionPolicy Bypass -File scripts\egress\negative-probes\run.ps1 `
    -ConfigFile <your-config>.json -OutDir <out-dir> -OwnerApproved
```

Copy `config.example.json`, fill it for the machine and network under test, and keep the copy
out of the repository (it names internal addresses). Without `-OwnerApproved` the script prints
the cases and stops; it also refuses to run in CI and when elevated.

## The report

`negative-probes-<stamp>.json` carries `schema`, `kind: egress_negative_probe_report`,
`run_in_ci: false`, the tier account SIDs, one row per case (verdict, the control's and the
tier's outcome and code, a target *label*), the verdict counts, `overall` (`pass`, `fail`,
`incomplete`, `invalid`), `exit_code` (0, 1, 2, 1 respectively) and an `attestation` block:

- `attestable` is true only when every tier passed completely **and** the host's open loopback
  range was read; `tiers_attested` and `tiers_not_attested` name the tiers.
- `open_loopback_tcp_range: {first, last}` is the host's IPv4 TCP dynamic range, read
  unelevated from `netsh int ipv4 show dynamicport tcp`, and the `claim` adds "and loopback TCP
  `<first>`-`<last>` (the host's dynamic range) is open to every tier".
- If the range cannot be read, `open_loopback_tcp_range` is `null`,
  `open_loopback_tcp_range_reason` says why, the claim drops the loopback sentence and
  `attestable` is false: an attestation must not stay silent about the open range.

The report carries no address, URL, host name or credential. Wiring it into the isolation
report is a later step and needs a contract change first.

## Running on a host with a moved dynamic range

The default range is 49152-65535 (`start=49152 num=16384`). To see the open range move, the
owner can run the harness on a host whose range was moved; the harness never changes it.
Elevated:

```powershell
netsh int ipv4 set dynamicport tcp start=20000 num=10000   # range 20000-29999
# ... run the harness unelevated with -OwnerApproved (the attestation then states 20000-29999) ...
netsh int ipv4 set dynamicport tcp start=49152 num=16384   # restore the default
```

The attestation reports what the host says, not what the plan installed, so re-check the
enforcing plan's open loopback range after moving it.
