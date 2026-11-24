"""Drive the P6 manual acceptance gate on a real Windows host.

P6's automated tests prove the log path, the handle inheritance, the stdin delivery and the ACL
*expectations* against a temporary tree this process owns. What they cannot prove is the one thing only a
provisioned machine has: real tier accounts, the elevated apply writing the shipped DACLs, and a
role process running as a tier account that has to create its own log under those DACLs.

This script does exactly that and nothing else:

1. resolves this account's SID and a scratch state tree, so nothing here touches an installed backend;
2. provisions the tier identities through the elevated broker (**UAC prompt 1**);
3. applies the shipped ACL policy to that tree through the merged P5 provision session (**UAC prompt 2**);
4. runs a real two-hop launch of the chosen role as its tier account, unelevated;
5. reads the evidence back: the log the tier created and what the role wrote into it, the tier's rights on
   its own log directory, and whether this unelevated account can delete the log the tier wrote;
6. revokes the identities and removes the scratch tree (**UAC prompt 3**).

`--role` chooses what is launched, and the tier is **not** a separate flag: it comes from the entry's
`identity_id`, because the launcher refuses a requested tier that disagrees with the catalog. Every binding
comes from the entry's own declared placeholders too, so a role whose entry needs something this script
cannot supply fails loudly rather than launching with a different binding set than the product would send.

Roles other than `test_fixed_sleep_child` run a payload binary rather than an artifact of this crate, so
they need `--payload-source`:

    powershell -ExecutionPolicy Bypass -File scripts\\native-backend\\build-native-backend.ps1 -SkipOpencode
    ... --role token_service_executable --payload-source build\\native-backend\\bin

Note what a passing launch does and does not mean for a server role. The owner hop sends `Start`, waits for
`Started`, then immediately sends `Stop` (`launcher/owner.rs`), so the role is torn down within the same
call. That is enough to prove it started as the tier account, entered its Job before its first instruction,
and left no orphan - and enough for the log it wrote to show whether it could reach the workspace. It is not
steady state, and it cannot show three roles alive at once or one being killed while its peers survive.
Those need the persistent control stream that P7 adds.

Nothing here reimplements a policy decision. The plan comes from `sandbox_policy.acl_plan`, the paths from
`sandbox_manager.native_isolation.paths`, the masks from the generated descriptor by way of the broker, and
the pass/fail of the DACLs is the launcher's own start-time readback: a launch that succeeds is a launch
whose every bound root carried exactly the shipped descriptor. A mistake in this script shows up as a
`provision_required` refusal in step 4, not as a false pass.

Run it unelevated, in a terminal you can click UAC prompts from. Absolute paths for the two binaries,
because they live under the crate's own target directory rather than a repo-root one:

    cd host\\sandbox_manager
    uv run python ..\\native_isolation_broker\\tools\\p6_manual_gate.py ^
        --broker   <repo>\\host\\native_isolation_broker\\target\\debug\\native_isolation_broker.exe ^
        --launcher <repo>\\host\\native_isolation_broker\\target\\debug\\native_isolation_launcher.exe

Add `--keep` to leave the scratch tree and the identities in place, which is what you want when running
several roles in a row: provisioning is idempotent, so only the first run needs its two prompts.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]


#: Which payload executable each launchable role runs.
#:
#: Restated here rather than read from anywhere, because nothing publishes it: the program is assembled by
#: the broker's own resolver (`catalog_roles/mod.rs`) and never appears in the catalog, which is the whole
#: point of a catalog that binds placeholders instead of naming programs. A mistake here is loud rather
#: than subtle - the launch fails because the file is not in the staged payload root.
#:
#: `connector_service` is absent on purpose. Its program is a staged Python interpreter under a venv tree,
#: so staging it means copying a directory rather than a file, and its own CLI exits before reading its
#: bootstrap while no build writes the runtime config file it requires. It is not a role this gate can
#: launch today, and pretending otherwise would produce a failure that says nothing about isolation.
_ROLE_EXECUTABLES: dict[str, str] = {
    "test_fixed_sleep_child": "native_isolation_test_child.exe",
    "supervisor_executable": "openwork.exe",
    "token_service_executable": "openwork-server.exe",
    "connector_executable": "opencode-router.exe",
    "runtime_executable": "opencode.exe",
}
_LAUNCHABLE_ROLES = frozenset(_ROLE_EXECUTABLES)

#: The tier each catalog `identity_id` names.
_TIER_BY_IDENTITY: dict[str, str] = {
    "ibid:tier_bootstrap": "bootstrap",
    "ibid:tier_file_tool": "file_tool",
    "ibid:tier_network_connector": "network_connector",
}


def _free_port() -> int:
    """A port nothing is listening on, inside the range the scalar rules accept.

    Bound and released rather than invented, so two roles in one run cannot be handed the same number. The
    role is terminated moments after it starts, so the window between this and the bind is not a problem
    worth solving here.
    """
    import socket  # noqa: PLC0415

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        port = int(listener.getsockname()[1])
    if not 1024 <= port <= 65535:
        _fail(f"the OS handed out port {port}, which the shipped scalar rules refuse")
    return port


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--broker", required=True, type=Path)
    parser.add_argument("--launcher", required=True, type=Path)
    # The tier is not a flag. It is whatever the catalog entry's `identity_id` says, because the launcher
    # refuses a requested tier that disagrees with the catalog - correctly, and that refusal is the only
    # thing a `--tier` flag could ever produce for a role whose tier it did not match.
    parser.add_argument(
        "--role",
        default="test_fixed_sleep_child",
        choices=sorted(_LAUNCHABLE_ROLES),
        help="which catalog role to launch; its tier and its bindings both come from the entry",
    )
    parser.add_argument(
        "--payload-source",
        type=Path,
        help=(
            "directory holding the built payload executables (build\\native-backend\\bin). Required for "
            "every role except test_fixed_sleep_child, whose binary sits beside the launcher."
        ),
    )
    parser.add_argument("--keep", action="store_true", help="skip revoke and scratch-tree removal")
    arguments = parser.parse_args()

    if os.name != "nt":
        _fail("this gate measures Windows access control and needs a Windows host")
    broker = arguments.broker.resolve()
    launcher = arguments.launcher.resolve()
    for binary in (broker, launcher):
        if not binary.is_file():
            _fail(f"{binary} does not exist; build first with `cargo build --bins --locked`")

    # Imports after the argument check so `--help` works anywhere.
    sys.path.insert(0, str(REPO_ROOT / "host" / "sandbox_policy" / "src"))
    from sandbox_manager.broker_client.identity import tier_account_name  # noqa: PLC0415
    from sandbox_manager.broker_client.provision import (  # noqa: PLC0415
        _create_owner_owned_backend_roots,
        _run_provision_session,
        current_owner_sid,
    )
    from sandbox_manager.native_backend import scaffold_workspace  # noqa: PLC0415
    from sandbox_manager.native_isolation.paths import (  # noqa: PLC0415
        WorkspaceRootFacts,
        build_native_path_set,
    )
    from sandbox_policy.acl_plan import plan_acl_policy  # noqa: PLC0415

    owner_sid = current_owner_sid()
    _say(f"owner SID: {owner_sid}")

    # Not under `TEMP`: the path-set rules refuse any managed member under the LocalAppData root, which is
    # where `TEMP` lives, and rightly so - that is a per-user tree the product must not put managed state
    # in. ProgramData is where an installed backend's roots live and is writable by a standard user, and a
    # workspace under the profile is the shape the product's own default has.
    program_data = os.environ.get("PROGRAMDATA")
    user_profile = os.environ.get("USERPROFILE")
    if not program_data or not user_profile:
        _fail("PROGRAMDATA and USERPROFILE must both be set")
    scratch = Path(program_data) / "SuperClaw-p6-gate"
    backend_root = scratch / "backend"
    workspace_root = Path(user_profile) / "superclaw-p6-gate-workspace"
    # The product's own owner-side step rather than a bare `mkdir`, so a role that reads `opencode.jsonc` at
    # startup finds one, and so this gate exercises the scaffolding P6.5 moved out of the supervisor instead
    # of quietly doing something else.
    scaffold_workspace(workspace_root)
    _say(f"scratch state tree:  {backend_root}")
    _say(f"scratch workspace:   {workspace_root}")

    # `build_native_path_set` reads the environment, so the scratch tree is expressed the way the product
    # expresses an installed one: through the same two overrides the backend itself honours.
    environment = dict(os.environ)
    # `os.environ` is case-insensitive on Windows and a plain dict is not, so the names the path set
    # requires are re-added in the exact spelling it looks them up by. Without this the copy loses
    # `SystemRoot` on any shell that exported it as `SYSTEMROOT`.
    for name in ("SystemRoot", "PROGRAMDATA", "USERPROFILE", "LOCALAPPDATA"):
        value = os.environ.get(name)
        if value:
            environment[name] = value
    environment["SUPERCLAW_NATIVE_BACKEND_STATE_DIR"] = str(backend_root)
    environment["WINDOWS_SUPERCLAW_PATH"] = str(workspace_root)
    path_set = build_native_path_set(
        owner_sid=owner_sid,
        session_id="p6gate",
        payload_version="p6gate",
        managed_default_facts=WorkspaceRootFacts(
            volume_verdict="fixed_ntfs",
            ancestry_verdict="no_reparse_point_observed",
        ),
        env=environment,
    )
    path_set_payload = path_set.model_dump(mode="json")
    logs_root = Path(str(path_set_payload["logs_root"]))
    payload_root = Path(str(path_set_payload["payload_root"]))
    isolation_root = Path(str(path_set_payload["isolation_root"]))

    # The role, its entry and its tier, resolved before anything is provisioned so a typo costs no UAC.
    entry = _catalog_entry(arguments.role)
    tier = _TIER_BY_IDENTITY.get(str(entry["identity_id"]))
    if tier is None:
        _fail(f"the catalog gives {arguments.role} identity {entry['identity_id']!r}, which names no tier")
    tier_logs = logs_root / tier
    _say(f"role:                {arguments.role}")
    _say(f"tier (from catalog): {tier}")
    _say(f"program:             {_ROLE_EXECUTABLES[arguments.role]}")
    # The isolation root is derived from ProgramData directly rather than from the backend root, so this is
    # the machine's real one and the apply below writes the shipped DACL onto it. That is the same object an
    # installed backend uses; it holds authorization records, not sandbox data, and step 6 revokes what this
    # run recorded. Stated here because it is the one path this gate touches that is not scratch.
    _say(f"isolation root:      {isolation_root}  (real, not scratch)")

    plan = plan_acl_policy(
        workspace_roots=path_set_payload["workspace_roots"], owner_sid=owner_sid
    )
    plan_payload = plan.model_dump(mode="json")
    _say(f"ACL plan: policy version {plan_payload['policy_version']}, "
         f"{len(plan_payload['managed_root_plans'])} managed roots")

    # ---------------------------------------------------------------- step 2: tier identities (UAC 1)
    _step("provisioning the tier identities (expect a UAC prompt)")
    exit_code = _elevated_broker_exit_code(broker, ["--provision", "--owner-sid", owner_sid])
    if exit_code != 0:
        _fail(
            f"the elevated broker exited {exit_code}. Its refusal JSON went to a standard output this "
            "process cannot read - run it in an elevated console to see it:\n"
            f"  {broker} --provision --owner-sid {owner_sid}"
        )
    # Derived here rather than read back from the elevated side, using the same algorithm the broker used
    # to create them (`broker_client.identity.tier_account_name`, one definition shared with the Rust
    # `identity_name`). If the two ever disagreed the account would simply not be found on the DACL below,
    # which is a failure this gate reports rather than one it hides.
    tier_account = tier_account_name(owner_sid, tier)
    # `provisioned` rather than `tier`: this loop only prints, and reusing the name would rebind the tier
    # the launch actually uses to whichever one happened to be printed last.
    for provisioned in ("bootstrap", "file_tool", "network_connector", "channel"):
        _say(f"  {provisioned}: {tier_account_name(owner_sid, provisioned)}")

    # ------------------------------------------------------------------- step 3: ACL apply (UAC 2)
    _step("applying the shipped ACL policy through the provision session (expect a UAC prompt)")
    # The owner creates the backend roots before elevating, because the broker refuses to create a
    # directory at a path a caller named: the owner having created it is the fact the elevated side then
    # reads off its own apply handle to authorize the write. Skipping this is what a `managed_path_refused`
    # refusal from the elevated broker means.
    _create_owner_owned_backend_roots(path_set_payload)
    # `_run_provision_session` rather than `ensure_workspace_acl_provisioned`, deliberately: the latter
    # goes through the higher-level provisioning wrapper, which this script does not need: it measures the
    # elevated apply itself. Everything below still runs against the real elevated apply.
    receipt = _run_provision_session(broker, owner_sid, path_set_payload, plan_payload)
    _say(f"  receipt: {json.dumps(receipt)}")
    if not tier_logs.is_dir():
        _fail(
            f"{tier_logs} does not exist after the apply; the tier log subtree is what P5 must create, "
            "and the runner is required never to create it"
        )
    _say(f"  tier log directory exists: {tier_logs}")

    # -------------------------------------------------------- step 4: a real cross-account launch
    _step(f"launching {arguments.role} as the {tier} tier account (unelevated, no UAC)")
    # The payload root has to hold the launcher the tier account executes, and the tier account can only
    # read what the payload root's DACL allows - which is why the launcher is copied there rather than run
    # from the build directory.
    payload_root.mkdir(parents=True, exist_ok=True)
    staged_launcher = payload_root / launcher.name
    staged_launcher.write_bytes(launcher.read_bytes())

    program = _ROLE_EXECUTABLES[arguments.role]
    if arguments.role == "test_fixed_sleep_child":
        program_source = launcher.with_name(program)
        if not program_source.is_file():
            _fail(f"{program_source} does not exist; build with `cargo build --bins --locked`")
    else:
        if arguments.payload_source is None:
            _fail(
                f"{arguments.role} runs {program}, which is a payload binary rather than a build artifact "
                "of this crate. Pass --payload-source pointing at build\\native-backend\\bin, built with "
                "`scripts\\native-backend\\build-native-backend.ps1 -SkipOpencode`."
            )
        program_source = arguments.payload_source.resolve() / program
        if not program_source.is_file():
            _fail(f"{program_source} does not exist; build the payload first")
    (payload_root / program).write_bytes(program_source.read_bytes())
    _say(f"  staged {program} from {program_source.parent}")

    # Every binding comes from the entry's own declarations rather than a list written out per role. That is
    # the property worth having in a gate: a role whose entry declares a placeholder this script cannot
    # supply fails here, loudly, instead of being launched with a binding set that happens to differ from
    # what the product would send.
    secrets_bound = _secret_scalars(entry)
    request = {
        "contract_version": 1,
        "manifest_version": 1,
        "manifest_digest": _shipped_catalog_digest(),
        "launch_role": arguments.role,
        # Required exactly when the entry binds a workspace root, and forbidden otherwise - the wire check
        # refuses both mistakes, so this follows the entry rather than guessing.
        "workspace_root_id": (
            str(path_set_payload["workspace_roots"][0]["root_id"])
            if "workspace_root" in entry["path_placeholders"]
            else None
        ),
        "path_bindings": _path_bindings(entry, path_set_payload, payload_root),
        "scalar_bindings": _scalar_bindings(entry, secrets_bound),
    }
    # The owner hop reads one length-prefixed frame from standard input, not raw JSON: four bytes of
    # little-endian length and then the body (`launcher::wire::read_frame`). Sending the JSON alone makes
    # the launcher read its first four characters as a length, which is what
    # "frame declares 1868767867 bytes" means.
    body = json.dumps(request).encode("utf-8")
    frame = len(body).to_bytes(4, "little") + body
    launch = subprocess.run(
        [str(staged_launcher), "--launch-tier", "--owner-sid", owner_sid, "--tier", tier],
        input=frame,
        capture_output=True,
        check=False,
    )
    stdout = launch.stdout.decode("utf-8", errors="replace").strip()
    stderr = launch.stderr.decode("utf-8", errors="replace").strip()
    _say(f"  exit code: {launch.returncode}")
    _say(f"  report: {stdout or '(none)'}")
    if stderr:
        _say(f"  diagnostics: {stderr}")
    if launch.returncode != 0:
        # The role's own log first, because it is usually the only place the real reason appears. A role
        # that exits during startup fails the runner's settle check, and the owner side then reports a
        # closed report pipe - true, and silent about why. The log is written before any of that.
        _dump_role_log(tier_logs)
        _fail(
            "the launch failed. Read the two lines above before anything else: a `provision_required` "
            "refusal on standard output is the launcher's own DACL readback, and its `roots` array names "
            "the placeholder and the reason; anything on standard error is the launcher refusing before it "
            "got that far."
        )
    report = json.loads(stdout)
    if report.get("launch_path") != "tier_logon":
        _fail(
            f"launch_path is {report.get('launch_path')!r}, so this was not a cross-account launch and "
            "proves nothing about a tier account"
        )

    # --------------------------------------------------------------------- step 5: the evidence
    _step("reading the evidence back")
    logs = sorted(path for path in tier_logs.iterdir())
    _say(f"  entries in {tier_logs}: {[path.name for path in logs]}")
    if len(logs) != 1:
        _fail("exactly one launch should have produced exactly one log")
    log = logs[0]
    # Built from the published rules rather than spelled out here, for the same reason
    # `native_log_retention.py` does it: this is a Python process with the contracts binding importable,
    # so a hand-written `32` and alphabet would be a fourth copy of a grammar that is published once.
    if not _published_log_name().fullmatch(log.name):
        _fail(f"{log.name} is not the launch-identifier grammar the contract publishes")
    _say(f"  GATE 1 PASS: the tier created its own log under the shipped DACL: {log.name}")

    # The log's contents, not just its name. For the test role this is a line or two and adds little; for a
    # production role it is the evidence that matters most, because it is the role saying what it managed to
    # do as a tier account before the Job came down. An access-denied on the workspace shows up here and
    # nowhere else, and a role that got as far as binding its port has proven the workspace grant.
    written = log.read_text(encoding="utf-8", errors="replace")
    if written.strip():
        _say(f"  what the role wrote to its own log ({len(written)} bytes):")
        for line in written.splitlines()[:40]:
            _say(f"    | {line}")
    else:
        _say("  the role wrote nothing before the Job came down, which is expected for a fast role")

    # No bound secret may appear in the role's self-report. The Rust tests assert the tokens stay off the
    # command line; this asserts they also do not arrive in the one file the tier itself writes, which is
    # the leak a unit test cannot see.
    for name, value in secrets_bound.items():
        if value in written:
            _fail(f"GATE 5 FAIL: the bound {name} appears in the role's own log")
    if secrets_bound:
        _say(f"  GATE 5 PASS: no bound secret ({', '.join(sorted(secrets_bound))}) reached the log")

    rights = subprocess.run(
        ["icacls", str(tier_logs)], capture_output=True, text=True, check=False
    ).stdout
    _say("  icacls output for the tier log directory:")
    for line in rights.splitlines():
        if line.strip():
            _say(f"    {line.strip()}")
    _check_tier_rights(rights, tier, tier_account)

    try:
        log.unlink()
    except OSError as failure:
        _fail(f"GATE 3 FAIL: the unelevated owner could not delete a tier-created log: {failure}")
    _say("  GATE 3 PASS: the unelevated owner deleted the tier-created log")

    # ------------------------------------------------------------------------ step 6: cleanup
    if arguments.keep:
        _say(f"\n--keep given: leaving {scratch} and the tier identities in place")
        _say(f"revoke later with: {broker} --revoke --owner-sid {owner_sid}  (elevated)")
        return 0

    _step("revoking the tier identities (expect a UAC prompt)")
    revoke_code = _elevated_broker_exit_code(broker, ["--revoke", "--owner-sid", owner_sid])
    _say(f"  exit code {revoke_code}" if revoke_code == 0 else f"  NOTE: revoke exited {revoke_code}; the tier accounts may remain")
    _say("removing the scratch trees")
    # `rmdir` rather than `shutil.rmtree`: every root now carries a protected DACL, and the one principal it
    # grants full control to is the host user running this - which is what makes the removal possible at all
    # and is itself a small confirmation of the recovery grant.
    for tree in (scratch, workspace_root):
        subprocess.run(["cmd", "/c", "rmdir", "/s", "/q", str(tree)], check=False)
        if tree.exists():
            _say(f"  NOTE: {tree} survived removal; delete it by hand")
    leftovers = subprocess.run(
        ["tasklist", "/FI", f"IMAGENAME eq {program}"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout
    _say(
        f"  GATE 4 PASS: no {program} process remains"
        if Path(program).stem not in leftovers
        else f"  GATE 4 FAIL: a {program} process survived the launch"
    )
    _say("\nAll automated gate checks passed. Paste this output into the PR's manual-gate section.")
    return 0


#: The rights the shipped policy must not grant a tier on its own log directory, as `icacls` spells them
#: and as the bits behind them.
#:
#: Both spellings are needed. `icacls` prints its own abbreviations when a mask matches a combination it
#: has a name for, and a raw `(0x…)` mask when it does not - and the P6 grant (add-file, traverse,
#: read-attributes, synchronize) is very likely the second case. A check that only read letters would then
#: pass by finding nothing, which is the way this check would fail silently.
_FORBIDDEN_TIER_RIGHTS: tuple[tuple[str, str, int], ...] = (
    ("RD", "list the directory", 0x0000_0001),
    ("DE", "delete the directory", 0x0001_0000),
    ("DC", "delete a file in it", 0x0000_0040),
    ("WDAC", "rewrite its access control", 0x0004_0000),
    ("WO", "take ownership of it", 0x0008_0000),
)


def _check_tier_rights(icacls_output: str, tier: str, name: str) -> None:
    """Assert the tier's own entry grants none of the rights P6 removed from it.

    Asserted rather than left to the reader, because this is the one gate that measures the P6 ACL change
    against a real object. `icacls` names local accounts by name, so the entry is found by the derived tier
    account name - not by a pattern that could match a recovery principal too.
    """
    lines = [line.strip() for line in icacls_output.splitlines() if name.lower() in line.lower()]
    if not lines:
        _fail(
            f"no access control entry for {name} appears on the tier log directory, so the tier could not "
            "have created a log there and something else did"
        )
    granted: set[str] = set()
    masks: list[int] = []
    for line in lines:
        for group in re.findall(r"\(([^()]*)\)", line):
            for token in group.split(","):
                token = token.strip()
                if token.lower().startswith("0x"):
                    masks.append(int(token, 16))
                elif token:
                    granted.add(token.upper())
    for letters, description, bit in _FORBIDDEN_TIER_RIGHTS:
        if letters in granted or any(mask & bit for mask in masks):
            _fail(
                f"GATE 2 FAIL: the {tier} tier may {description} through the explicit "
                f"DACL, which the shipped policy removed: {lines}"
            )
    _say(
        f"  GATE 2 PASS: {name} may not list, delete, or re-secure its own log directory "
        f"(entries: {lines})"
    )


def _elevated_broker_exit_code(broker: Path, arguments: list[str]) -> int:
    """Runs one closed broker operation elevated and returns its exit code, which is all there is to get.

    # Why the exit code and nothing else

    An earlier version of this captured the broker's JSON to a file so the receipts could be printed.
    Two platform facts defeat that, and both are worth recording because the product's own
    `run_broker_provision_elevated` is exit-code-only for exactly the same reasons:

    * `Start-Process -Verb RunAs` and `-RedirectStandardOutput` are in mutually exclusive parameter sets,
      so the launcher cannot capture the child's output;
    * having the elevated side write the file instead does not help when the owner is *not* an
      administrator. UAC then prompts for a different account, the elevated broker runs as that account,
      and the file it creates is owned by it - the invoking user gets `PermissionError` reading its own
      temporary directory. This is the ordinary case on a standard-user machine, not an edge case.

    So this asks the unelevated PowerShell host for `$p.ExitCode`, which it reads from a process handle it
    holds itself, and the gate derives the tier account names locally instead of reading them back.
    """
    for argument in arguments:
        # Everything elevated here is a flag or a SID. Refusing anything else keeps the command line free
        # of quoting questions: there is no escaping scheme in this script, by construction.
        if not all(character.isalnum() or character in "-_." for character in argument):
            _fail(f"{argument!r} is not a shape this gate will elevate")
    listed = ",".join(f"'{argument}'" for argument in arguments)
    script = (
        "$ErrorActionPreference = 'Stop' ; "
        f"$p = Start-Process -FilePath '{broker}' -ArgumentList @({listed}) "
        "-Verb RunAs -Wait -PassThru -WindowStyle Hidden ; "
        "Write-Output $p.ExitCode"
    )
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        _fail(
            "the elevated broker could not be launched. A cancelled UAC prompt looks like this.\n"
            f"  PowerShell said: {completed.stderr.strip() or completed.stdout.strip() or '(nothing)'}"
        )
    try:
        return int(completed.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        _fail(f"the elevated broker reported no exit code: {completed.stdout.strip()!r}")
        raise  # unreachable; `_fail` exits, and this keeps the return type honest


def _shipped_catalog_digest() -> str:
    return str(_catalog_bundle()["catalog_digest"])


def _dump_role_log(tier_logs: Path) -> None:
    """Print whatever the role wrote, on the failure path where it is the only account of what happened.

    Best effort by design: this runs while reporting a failure, so a directory that cannot be read must not
    replace the failure being reported with a different one.
    """
    try:
        logs = sorted(tier_logs.iterdir())
    except OSError as failure:
        _say(f"  (could not read {tier_logs}: {failure})")
        return
    if not logs:
        _say(f"  the role wrote no log in {tier_logs}, so it did not get as far as starting")
        return
    for log in logs:
        try:
            written = log.read_text(encoding="utf-8", errors="replace")
        except OSError as failure:
            _say(f"  (could not read {log.name}: {failure})")
            continue
        _say(f"  what the role wrote to {log.name} before the launch failed:")
        for line in written.splitlines()[:40] or ["(empty)"]:
            _say(f"    | {line}")


def _catalog_entry(role: str) -> dict[str, Any]:
    """The shipped entry for a role, or a failure naming what the catalog does carry."""
    entries = _catalog_bundle()["catalog"]["entries"]
    for entry in entries:
        if entry["launch_role"] == role:
            return dict(entry)
    shipped = ", ".join(sorted(str(entry["launch_role"]) for entry in entries))
    _fail(f"the shipped catalog has no entry for {role}. It carries: {shipped}")
    raise AssertionError("unreachable")  # `_fail` exits; this keeps the return type honest


#: Which path-set member each path placeholder is bound from.
#:
#: `payload_root` is the exception and is passed in rather than read from the path set, because the gate
#: stages its binaries into a scratch payload root it built itself.
_PATH_SET_MEMBER: dict[str, str] = {
    "workspace_root": "workspace_roots",
    "state_config_root": "config_root",
    "state_data_root": "data_root",
    "state_logs_root": "logs_root",
    "state_temp_root": "temp_root",
    "state_protected_root": "protected_root",
    "isolation_root": "isolation_root",
}


def _path_bindings(
    entry: dict[str, Any], path_set: dict[str, Any], payload_root: Path
) -> list[dict[str, str]]:
    bindings: list[dict[str, str]] = []
    for placeholder in entry["path_placeholders"]:
        name = str(placeholder)
        if name == "payload_root":
            bindings.append({"placeholder": name, "path": str(payload_root)})
            continue
        member = _PATH_SET_MEMBER.get(name)
        if member is None:
            _fail(
                f"{entry['launch_role']} declares path placeholder {name}, which this gate does not know "
                "how to bind. Add it to _PATH_SET_MEMBER rather than dropping it: an unbound declared root "
                "is a root the launcher never checks for drift."
            )
        if member == "workspace_roots":
            bindings.append({"placeholder": name, "path": str(path_set["workspace_roots"][0]["path"])})
        else:
            bindings.append({"placeholder": name, "path": str(path_set[member])})
    return bindings


def _secret_scalars(entry: dict[str, Any]) -> dict[str, str]:
    """One freshly minted value per opaque scalar the entry declares.

    Minted here because that is who mints them in production too: the owner. Length and alphabet come from
    `secrets.token_urlsafe`, which lands inside the published opaque bounds without this script restating
    them.
    """
    import secrets  # noqa: PLC0415

    rules = _catalog_bundle()["scalar_rules"]
    opaque = {str(name) for name in rules.get("opaque_placeholders", ())}
    return {
        str(placeholder): secrets.token_urlsafe(32)
        for placeholder in entry["scalar_placeholders"]
        if str(placeholder) in opaque
    }


def _scalar_bindings(entry: dict[str, Any], secrets_bound: dict[str, str]) -> list[dict[str, Any]]:
    """One binding per declared scalar, typed the way the wire check requires.

    Ports are JSON numbers and text is a JSON string; the classification is read from the shipped rules
    rather than inferred from the name, so a scalar that changes class on the contract side changes here
    with it.
    """
    rules = _catalog_bundle()["scalar_rules"]
    text = {str(name) for name in rules["text_placeholders"]}
    ports = {str(name) for name in rules["port_placeholders"]}
    bindings: list[dict[str, Any]] = []
    for placeholder in entry["scalar_placeholders"]:
        name = str(placeholder)
        if name in secrets_bound:
            bindings.append({"placeholder": name, "value": secrets_bound[name]})
        elif name == "loopback_host":
            bindings.append({"placeholder": name, "value": "127.0.0.1"})
        elif name == "host_token_sha256":
            import hashlib  # noqa: PLC0415
            import secrets  # noqa: PLC0415

            # The owner binds the hash of the host token it minted; this gate mints one the same way.
            token = secrets.token_urlsafe(32)
            bindings.append({"placeholder": name, "value": hashlib.sha256(token.encode()).hexdigest()})
        elif name in ports:
            bindings.append({"placeholder": name, "value": _free_port()})
        elif name in text:
            _fail(
                f"{entry['launch_role']} declares text scalar {name}, which this gate has no value for. "
                "Give it one here rather than binding something arbitrary."
            )
        else:
            _fail(f"{name} is in neither rule list, so the shipped rules would refuse whatever was bound")
    return bindings


def _published_log_name() -> re.Pattern[str]:
    """The one grammar a launcher can produce, assembled from the published rules.

    Same two rules the runner builds the name from and the retention helper deletes by, read here rather
    than restated, so a gate run on a tree whose grammar changed fails on the mismatch instead of
    agreeing with a number this file happens to carry.
    """
    rules = _catalog_bundle()["role_log_rules"]
    return re.compile(
        r"[0-9a-f]{%d}%s" % (int(rules["launch_id_hex_chars"]), re.escape(str(rules["extension"])))
    )


def _catalog_bundle() -> dict[str, Any]:
    data = json.loads(
        (REPO_ROOT / "shared/contracts/generated/data/broker-startup-catalog.json").read_text(
            encoding="utf-8"
        )
    )
    assert isinstance(data, dict)
    return data


def _step(message: str) -> None:
    print(f"\n=== {message}", flush=True)


def _say(message: str) -> None:
    print(message, flush=True)


def _fail(message: str) -> None:
    print(f"\nGATE FAILED: {message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


if __name__ == "__main__":
    raise SystemExit(main())
