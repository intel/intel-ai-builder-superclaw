#!/usr/bin/env python3
"""Per-phase breakdown of installed-app launches, read from each launch's own logs.

    python scripts/native-backend/startup_phases.py run --out-dir RUN --tauri-log T \\
        [--servicehub-log S] [--manager-log M] [--bootstrap-log B] [--meta META.json]
    python scripts/native-backend/startup_phases.py summary OUTDIR [OUTDIR ...] [--out summary.md]

`run` writes RUN/run.json and a copy of every log it read to RUN/logs/, minus every line that prints
a credential; those are dropped before anything is parsed, stored or printed. A phase the logs do
not show is null, never zero. Durations are milliseconds; `*_at_ms` values are offsets from
`meta.launched_at`, or from the tauri log's first line when the launch time is unknown.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import statistics
import sys
from typing import Any, Iterable, Iterator, NamedTuple

SCHEMA = 2
# The --<kind>-log flags; measure-installed-startup.ps1's $LogDirs uses the same keys.
LOG_KINDS = ("tauri", "servicehub", "manager", "bootstrap")

# Credential prints, redacted or not: `Host admin token: ...`, `"hostToken": ...`,
# `X-OpenWork-Host-Token: ...`, `--host-token <value>`, `Authorization: Bearer ...`, and
# `OpenCode auth: <user> / <redacted, abcd… len=N>`, whose redaction keeps a password prefix. They
# must not over-match either: `owt_unavailable` and `role=token_service_executable` have to survive.
_SECRET_LINE = re.compile(
    r"(?i)admin.{0,3}token|host.?token|token[\"']?\s*[:=]|--[\w-]*token\b|\bbearer\s+\S"
    r"|opencode auth:|password"
)

_STAMP = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})")
_CLIENT_TS = re.compile(r"\bclient_ts_ms=(\d+)")
_DECODER = json.JSONDecoder()

# tauri log: its own lines, the UI's forwarded lines, and a mirror of ServiceHub's
_STEP = re.compile(r"startup step complete step=(\S+) duration_ms=(\d+)")
# measure-installed-startup.ps1's $CompleteMarker waits for this same line.
_COMPLETE = re.compile(r"startup complete outcome=(\S+) total_ms=(\d+)")
_HANDSHAKE = re.compile(r"boot state spawn -> handshake\.complete \(\+(\d+)ms\)")
_BOOT_READY = re.compile(r"boot state handshake\.complete -> ready \(\+(\d+)ms\)")
_DATAPLANE_READY = re.compile(r"Sandbox data plane is ready")

# ServiceHub log
_BARRIER = re.compile(r"startup\.barrier\.complete elapsed_ms=(\d+) .*?\bready=(\S+)")

# sandbox_manager log (sbms-*.log)
_BACKEND_MODE = re.compile(r"backend mode: (\w+)")
_LAUNCH_BEGIN = re.compile(r"native-backend: verifying payload source")
_PHASE = re.compile(r"startup phase=(\w+) event=(begin|end|started)\b")
_READY = re.compile(r"startup phase=ready event=end elapsed_ms=(\d+)")
# When each health predicate was first seen true, in ms after `phase=health event=begin`.
_HEALTH_OBSERVED = re.compile(r"startup phase=health event=observed (.*)")
_FIELD = re.compile(r"(\w+)=(\d+)\b")
_PAYLOAD_VERSION = re.compile(r"startup phase=payload event=ready payload_version=(\S+)")
_PROFILE = re.compile(r"product_profile_id=(\S+)")
_LAYOUT = re.compile(r"runtime writable layout phase=prepare event=(begin|end)\b")
_ROLE = re.compile(r"role lifecycle phase=start event=(begin|started) role=(\S+)")
_PUBLICATION = re.compile(r"native-backend: publication (wait|confirmed)\b")
_SESSION = re.compile(r"native-provision: phase=session event=(begin|completed)\b")
_OTHER_SPANS = (("layout", _LAYOUT, "begin"), ("publication_wait", _PUBLICATION, "wait"), ("provision_session", _SESSION, "begin"))
# UAC prompts. A build with #3142 writes a begin/end pair around each broker elevation:
#   elevation: op=<op> event=end outcome=<o> started_at=<iso> wall_ms=<n> [consent_ms=<n> work_ms=<n>]
# Without it only the provision session logs `native-provision: phase=elevation event=begin|started`.
_ELEVATION_LOG = re.compile(r"\belevation: op=(\S+) event=(begin|end)\b")
_ELEVATION_FIELD = re.compile(r"\b(outcome|wall_ms|consent_ms|work_ms)=(\S+)")
_ELEVATION = re.compile(r"([\w-]+): phase=elevation event=(begin|started)\b")
STARTUP_DIAG = "STARTUP_DIAG="

# bootstrap tier log (the orchestrator; its lines carry no timestamps)
PUBLICATION_DIAG = "PUBLICATION_DIAG="
_RUNTIME_READY = re.compile(r"(?:Container r|R)untime ready total_ms=(\d+)")
# The supervisor's own start-up steps, in ms after it confirmed publication.
_MARK = re.compile(r"Startup mark step=(\S+) at=\S+ elapsed_ms=(\d+)")

LineMatch = tuple[int, re.Match[str]]


# ---- reading -----------------------------------------------------------------------


def sanitize(lines: Iterable[str]) -> list[str]:
    return [line for line in lines if not _SECRET_LINE.search(line)]


def read_log(path: Path) -> list[str]:
    return sanitize(path.read_text(encoding="utf-8-sig", errors="replace").splitlines())


def _stamp(line: str) -> datetime | None:
    """The ISO timestamp a line starts with."""
    match = _STAMP.match(line)
    if match is None:
        return None
    base, fraction, zone = match.groups()
    # Tauri trims trailing zeros, so its fractions run 4-7 digits; before 3.11 `fromisoformat`
    # takes exactly 3 or 6. Always hand it six.
    digits = (fraction or ".")[1:7].ljust(6, "0")
    return datetime.fromisoformat(f"{base}.{digits}{'+00:00' if zone == 'Z' else zone}")


def _event_time(line: str) -> datetime | None:
    """A UI line reaches the tauri log in batches, seconds late, so its own `client_ts_ms` wins."""
    client = _CLIENT_TS.search(line)
    if client:
        return datetime.fromtimestamp(int(client.group(1)) / 1000, timezone.utc)
    return _stamp(line)


def _ms(start: datetime | None, end: datetime | None) -> int | None:
    if start is None or end is None:
        return None
    return round((end - start).total_seconds() * 1000)


def _first(lines: list[str], pattern: re.Pattern[str], start: int = 0) -> LineMatch | None:
    return next(((i, match) for i in range(start, len(lines)) if (match := pattern.search(lines[i]))), None)


def _group(found: LineMatch | None, index: int = 1) -> str | None:
    return found[1].group(index) if found else None


def _int(found: LineMatch | None, index: int = 1) -> int | None:
    return int(found[1].group(index)) if found else None


def _json_events(lines: Iterable[str], marker: str) -> Iterator[dict[str, Any]]:
    for line in lines:
        _, found, tail = line.partition(marker)
        if not found:
            continue
        try:
            event, _ = _DECODER.raw_decode(tail)
        except ValueError:
            continue
        if isinstance(event, dict):
            yield event


def _pairs(text: str) -> dict[str, int]:
    """`a:1|b:2` -> {"a": 1, "b": 2}."""
    pairs = (item.rpartition(":") for item in text.split("|") if ":" in item)
    return {name: int(value) for name, _, value in pairs if value.isdigit()}


# ---- parsing -----------------------------------------------------------------------


def parse_ui(lines: list[str], reference: datetime | None) -> dict[str, Any]:
    steps: dict[str, int] = {}
    for line in lines:
        if step := _STEP.search(line):
            steps.setdefault(step.group(1), int(step.group(2)))
    complete = _first(lines, _COMPLETE)
    dataplane = _first(lines, _DATAPLANE_READY)
    return {
        "outcome": _group(complete),
        "total_ms": _int(complete, 2),
        "steps": steps,
        "servicehub_handshake_ms": _int(_first(lines, _HANDSHAKE)),
        # Since ServiceHub was spawned: what the tauri log calls ServiceHub being ready.
        "servicehub_ready_ms": _int(_first(lines, _BOOT_READY)),
        "dataplane_ready_at_ms": _ms(reference, _event_time(lines[dataplane[0]])) if dataplane else None,
        "complete_at_ms": _ms(reference, _event_time(lines[complete[0]])) if complete else None,
    }


def parse_servicehub(lines: list[str]) -> dict[str, Any]:
    barrier = _first(lines, _BARRIER)
    return {"barrier_ms": _int(barrier), "children": _pairs(barrier[1].group(2)) if barrier else {}}


def _diag_end(lines: list[str], stage: str) -> dict[str, Any] | None:
    found = None
    for event in _json_events(lines, STARTUP_DIAG):
        if event.get("stage") == stage and event.get("event") == "end":
            found = {key: value for key, value in event.items() if key not in {"stage", "event"}}
    return found


def _elevations(lines: list[str]) -> list[dict[str, Any]]:
    """One entry per UAC prompt the log shows.

    When any `elevation: op=` line is present only those count: the session's legacy pair sits next
    to its new pair, so adding both would count that prompt twice. Prompt time is `consent_ms`
    (only a provision session has it); legacy logs have `wait_ms`, begin -> elevated process started.
    """

    def entry(operation: str) -> dict[str, Any]:
        return {"operation": operation, **dict.fromkeys(("outcome", "wall_ms", "consent_ms", "work_ms", "wait_ms"))}

    found: list[dict[str, Any]] = []
    op_lines = [match for line in lines if (match := _ELEVATION_LOG.search(line))]
    for match in op_lines:
        operation, event = match.groups()
        current = next((e for e in reversed(found) if e["operation"] == operation and e["outcome"] is None), None)
        if event == "begin" or current is None:  # an end without its begin: the log was cut
            current = entry(operation)
            found.append(current)
        if event == "end":
            for key, value in _ELEVATION_FIELD.findall(match.string[match.end() :]):
                current[key] = value if key == "outcome" else int(value) if value.isdigit() else None
    if op_lines:
        return found

    requested: datetime | None = None
    for line in lines:
        if (match := _ELEVATION.search(line)) is None:
            continue
        if match.group(2) == "begin":
            requested = _stamp(line)
            found.append(entry(match.group(1)))
        elif found and found[-1]["wait_ms"] is None:
            found[-1]["wait_ms"] = _ms(requested, _stamp(line))
    return found


class _Spans:
    """Durations by name, in log order: the first begin to the first end after it."""

    def __init__(self) -> None:
        self.begins: dict[str, datetime | None] = {}
        self.ms: dict[str, int | None] = {}

    def mark(self, name: str, begin: bool, stamp: datetime | None) -> None:
        if begin:
            self.begins.setdefault(name, stamp)
            self.ms.setdefault(name, None)
        elif name in self.begins and self.ms[name] is None:
            self.ms[name] = _ms(self.begins[name], stamp)


def parse_manager(lines: list[str]) -> dict[str, Any]:
    # The first launch in this log: from payload verification to the ready line.
    begin = _first(lines, _LAUNCH_BEGIN)
    start = begin[0] if begin else len(lines)
    ready = _first(lines, _READY, start)
    window = lines[start : ready[0] + 1] if ready else lines[start:]

    phases, roles, other = _Spans(), _Spans(), _Spans()
    for line in window:
        stamp = _stamp(line)
        if match := _PHASE.search(line):  # roles end with `started`, the rest with `end`
            phases.mark(match.group(1), match.group(2) == "begin", stamp)
        if match := _ROLE.search(line):
            roles.mark(match.group(2), match.group(1) == "begin", stamp)
        for name, pattern, opener in _OTHER_SPANS:
            if match := pattern.search(line):
                other.mark(name, match.group(1) == opener, stamp)
    if ready:  # health has no end line of its own: `startup phase=ready` carries its elapsed time
        phases.ms["health"] = int(ready[1].group(1))

    elevations = _elevations(window)
    observed = _first(window, _HEALTH_OBSERVED)
    return {
        # Logged once at process start, before the window opens.
        "backend_mode": _group(_first(lines, _BACKEND_MODE)),
        "payload_version": _group(_first(window, _PAYLOAD_VERSION)),
        "product_profile": _group(_first(window, _PROFILE)),
        "runtime_ms": _ms(_stamp(window[0]), _stamp(window[-1])) if begin and ready else None,
        "phases": phases.ms,
        "health_observed": {k: int(v) for k, v in _FIELD.findall(observed[1].group(1))} if observed else {},
        "stage_payload": _diag_end(window, "stage_payload"),
        "copy_payload": _diag_end(window, "copy_payload"),
        "layout_ms": other.ms.get("layout"),
        "roles": roles.ms,
        "publication_wait_ms": other.ms.get("publication_wait"),
        "provision_session_ms": other.ms.get("provision_session"),
        "elevation_count": len(elevations),
        "elevations": elevations,
    }


def parse_bootstrap(lines: list[str]) -> dict[str, Any]:
    copies = [
        event.get("elapsed_ms")
        for event in _json_events(lines, PUBLICATION_DIAG)
        if event.get("stage") == "copy_dependencies" and event.get("event") == "end"
    ]
    marks: dict[str, int] = {}
    for line in lines:
        if mark := _MARK.search(line):
            marks.setdefault(mark.group(1), int(mark.group(2)))
    return {
        "copy_dependencies_ms": sum(ms for ms in copies if isinstance(ms, int)) if copies else None,
        "runtime_ready_ms": _int(_first(lines, _RUNTIME_READY)),
        "marks": marks,
    }


def build_run(logs: dict[str, list[Path]], meta: dict[str, Any], out_dir: Path) -> dict[str, Any]:
    """Parse one launch, writing sanitised copies of its logs to `out_dir/logs`."""
    copies = out_dir / "logs"
    copies.mkdir(parents=True, exist_ok=True)
    lines: dict[str, list[str]] = {}
    for kind, paths in logs.items():
        for path in paths:
            kept = read_log(path)
            (copies / path.name).write_text("".join(f"{line}\n" for line in kept), encoding="utf-8")
            lines.setdefault(kind, []).extend(kept)

    tauri = lines.get("tauri", [])
    launched = _stamp(meta["launched_at"]) if isinstance(meta.get("launched_at"), str) else None
    return {
        "schema": SCHEMA,
        "meta": meta,
        "ui": parse_ui(tauri, launched or (_stamp(tauri[0]) if tauri else None)),
        # ServiceHub keeps only its newest few logs; the tauri log mirrors every line it writes.
        "servicehub": parse_servicehub(lines.get("servicehub") or tauri),
        "manager": parse_manager(lines.get("manager", [])),
        "bootstrap": parse_bootstrap(lines.get("bootstrap", [])),
    }


# ---- summary -----------------------------------------------------------------------

class _Row(NamedTuple):
    """A per_key row expands to one row per key of the dict at `path`, its label the prefix of each."""

    label: str
    path: tuple[str, ...]
    per_key: bool = False


_ROWS = (
    _Row("outcome", ("ui", "outcome")),
    _Row("staging outcome", ("manager", "stage_payload", "outcome")),
    _Row("staging files (count)", ("manager", "stage_payload", "files")),
    _Row("**startup complete `total_ms`**", ("ui", "total_ms")),
    _Row("UI ", ("ui", "steps"), per_key=True),
    _Row("ServiceHub spawn -> handshake", ("ui", "servicehub_handshake_ms")),
    _Row("ServiceHub spawn -> ready", ("ui", "servicehub_ready_ms")),
    _Row("ServiceHub `startup.barrier.complete`", ("servicehub", "barrier_ms")),
    _Row("- ready: ", ("servicehub", "children"), per_key=True),
    _Row("sbms verifying payload -> `startup phase=ready`", ("manager", "runtime_ms")),
    _Row("- phase ", ("manager", "phases"), per_key=True),
    _Row("- health first true: ", ("manager", "health_observed"), per_key=True),
    _Row("- staging: `stage_payload`", ("manager", "stage_payload", "elapsed_ms")),
    _Row("- staging: `copy_payload`", ("manager", "copy_payload", "elapsed_ms")),
    _Row("- writable layout", ("manager", "layout_ms")),
    _Row("- role start: ", ("manager", "roles"), per_key=True),
    _Row("- supervisor started -> publication confirmed", ("manager", "publication_wait_ms")),
    _Row("elevated provision session", ("manager", "provision_session_ms")),
    _Row("elevation prompts logged (count)", ("manager", "elevation_count")),
    _Row("bootstrap `copy_dependencies`", ("bootstrap", "copy_dependencies_ms")),
    _Row("bootstrap runtime ready", ("bootstrap", "runtime_ready_ms")),
    _Row("- bootstrap at: ", ("bootstrap", "marks"), per_key=True),
    _Row("at: sandbox data plane ready", ("ui", "dataplane_ready_at_ms")),
    _Row("at: startup complete", ("ui", "complete_at_ms")),
)


def _dig(node: Any, path: Iterable[str]) -> Any:
    for key in path:
        node = node.get(key) if isinstance(node, dict) else None
    return node


def _number(value: Any) -> float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _fmt(value: Any) -> str:
    number = _number(value)
    if number is not None:
        return f"{round(number):,}"
    return "" if value is None else str(value)


def _rows(reports: list[dict[str, Any]]) -> Iterator[tuple[str, list[Any]]]:
    for label, path, per_key in _ROWS:
        if not per_key:
            yield label, [_dig(report, path) for report in reports]
            continue
        keys: list[str] = []
        for report in reports:
            keys.extend(key for key in _dig(report, path) or {} if key not in keys)
        for key in keys:
            yield f"{label}`{key}`", [_dig(report, (*path, key)) for report in reports]


def _distinct(reports: list[dict[str, Any]], path: tuple[str, ...]) -> list[str]:
    values: list[str] = []
    for report in reports:
        value = _dig(report, path)
        if value is not None and str(value) not in values:
            values.append(str(value))
    return values


def render_summary(reports: list[dict[str, Any]]) -> str:
    facts = {
        "App version": _distinct(reports, ("meta", "app_version")),
        "Payload version": _distinct(reports, ("manager", "payload_version")),
        "Launch mode": _distinct(reports, ("meta", "mode")),
        "Backend mode": _distinct(reports, ("manager", "backend_mode")),
        "Product Profile": _distinct(reports, ("manager", "product_profile")),
    }
    out = ["# Installed start-up", ""]
    out += [f"- {name}: {', '.join(values) or 'unknown'}" for name, values in facts.items()]
    mixed = [name for name, values in facts.items() if len(values) > 1]
    if mixed:
        out += ["", f"**Warning: these runs differ in {', '.join(mixed)}; the medians mix them.**"]
    out += [
        "",
        f"{len(reports)} run(s). Milliseconds from each run's own logs; an empty cell means the run did "
        "not log that phase. `at:` rows are offsets from the launch.",
        "",
    ]
    heads = [f"r{_fmt(_dig(r, ('meta', 'run'))) or i + 1}" for i, r in enumerate(reports)]
    out.append("| Phase (ms) | " + " | ".join(heads) + " | median | min | max |")
    out.append("|---|" + "---:|" * (len(heads) + 3))
    for label, values in _rows(reports):
        numbers = [n for n in (_number(v) for v in values) if n is not None]
        stats = [statistics.median(numbers), min(numbers), max(numbers)] if numbers else [None] * 3
        out.append(f"| {label} | " + " | ".join(_fmt(v) for v in [*values, *stats]) + " |")
    return "\n".join(out) + "\n"


def collect_reports(paths: Iterable[Path]) -> list[dict[str, Any]]:
    """The `run-<n>/run.json` reports under harness output directories, in run order."""

    def number(path: Path) -> int:
        suffix = path.parent.name.rpartition("-")[2]
        return int(suffix) if suffix.isdigit() else 0

    found = [report for path in paths for report in sorted(path.glob("run-*/run.json"), key=number)]
    return [json.loads(report.read_text(encoding="utf-8")) for report in found]


# ---- cli ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="parse one launch's logs into RUN/run.json")
    run.add_argument("--out-dir", type=Path, required=True)
    run.add_argument("--meta", type=Path, help="JSON written by the harness (launch time, version, load)")
    for kind in LOG_KINDS:
        run.add_argument(f"--{kind}-log", type=Path, action="append", default=[])
    summary = sub.add_parser("summary", help="median/min/max table over the run-<n> directories of OUTDIRs")
    summary.add_argument("dirs", type=Path, nargs="+")
    summary.add_argument("--out", type=Path, help="also write the table here")
    args = parser.parse_args(argv)

    if args.command == "summary":
        reports = collect_reports(args.dirs)
        if not reports:
            print(f"no run.json under {', '.join(map(str, args.dirs))}", file=sys.stderr)
            return 1
        table = render_summary(reports)
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(table, encoding="utf-8")
        print(table, end="")
        return 0

    if not args.tauri_log:
        parser.error("run needs --tauri-log: it is the one log every launch writes")
    meta = json.loads(args.meta.read_text(encoding="utf-8-sig")) if args.meta else {}
    logs = {kind: getattr(args, f"{kind}_log") for kind in LOG_KINDS}
    report = build_run(logs, meta, args.out_dir)
    (args.out_dir / "run.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    total = _fmt(_dig(report, ("ui", "total_ms")))
    print(f"run {meta.get('run', '?')}: total {total or 'n/a'} ms, elevations {report['manager']['elevation_count']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
