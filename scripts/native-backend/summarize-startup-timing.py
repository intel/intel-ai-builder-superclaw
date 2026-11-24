#!/usr/bin/env python3
"""Turn one boot's startup diagnostics into a per-stage table.

The orchestrator emits `PUBLICATION_DIAG=` lines into the bootstrap tier log and the
manager emits `STARTUP_DIAG=` lines into its own log. Both are one JSON object per line.
Reading three smoke runs by eye is how a stage gets misattributed, so this collates them
instead: every stage with its occurrence count, total duration, and the files/bytes it
moved or inspected.

Usage (defaults discover the newest log of each kind under %LOCALAPPDATA%):

    python scripts/native-backend/summarize-startup-timing.py
    python scripts/native-backend/summarize-startup-timing.py --json > run-1.json
    python scripts/native-backend/summarize-startup-timing.py \
        --bootstrap-log <path> --manager-log <path>

This only reads logs. It does not start, stop or modify the product, and it reports what
the run recorded rather than deriving a verdict: a stage absent from a run is absent from
the table, not assumed to be zero.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
from typing import Any, Iterable, Iterator

PUBLICATION_MARKER = "PUBLICATION_DIAG="
STARTUP_MARKER = "STARTUP_DIAG="
_DECODER = json.JSONDecoder()


def _events(paths: Iterable[Path], marker: str) -> Iterator[dict[str, Any]]:
    """Yield each JSON object following `marker`, ignoring any log prefix or suffix."""
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as error:
            print(f"warning: cannot read {path}: {error}", file=sys.stderr)
            continue
        for line in text.splitlines():
            start = line.find(marker)
            if start < 0:
                continue
            try:
                event, _ = _DECODER.raw_decode(line[start + len(marker) :])
            except ValueError:
                continue
            if isinstance(event, dict):
                yield event


@dataclass
class StageTotals:
    count: int = 0
    elapsed_ms: int = 0
    files: int = 0
    directories: int = 0
    bytes: int = 0
    outcomes: list[str] = field(default_factory=list)
    extra_ms: dict[str, int] = field(default_factory=lambda: defaultdict(int))

    def add(self, event: dict[str, Any]) -> None:
        self.count += 1
        for key in ("elapsed_ms", "files", "directories", "bytes"):
            value = event.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                setattr(self, key, getattr(self, key) + value)
        outcome = event.get("outcome")
        if isinstance(outcome, str):
            self.outcomes.append(outcome)
        for key, value in event.items():
            if key.endswith("_ms") and key != "elapsed_ms" and isinstance(value, int):
                self.extra_ms[key] += value

    def as_dict(self) -> dict[str, Any]:
        record: dict[str, Any] = {"count": self.count, "elapsed_ms": self.elapsed_ms}
        for key in ("files", "directories", "bytes"):
            if getattr(self, key):
                record[key] = getattr(self, key)
        if self.outcomes:
            record["outcomes"] = self.outcomes
        if self.extra_ms:
            record["phase_ms"] = dict(self.extra_ms)
        return record


def _collate(events: Iterable[dict[str, Any]]) -> dict[str, StageTotals]:
    stages: dict[str, StageTotals] = {}
    for event in events:
        stage = event.get("stage")
        # `begin` carries no measurement; totalling it would double every stage's count.
        if not isinstance(stage, str) or event.get("event") not in {"end", "observed", "failed"}:
            continue
        stages.setdefault(stage, StageTotals()).add(event)
    return stages


def _newest(directory: Path, pattern: str) -> list[Path]:
    if not directory.is_dir():
        return []
    candidates = sorted(
        (path for path in directory.glob(pattern) if path.is_file()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return candidates[:1]


def _log_identity(path: Path) -> dict[str, Any]:
    try:
        stat = path.stat()
    except OSError:
        return {"path": str(path), "modified": "unknown", "bytes": None}
    modified = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(timespec="seconds")
    return {"path": str(path), "modified": modified, "bytes": stat.st_size}


def _default_logs() -> tuple[list[Path], list[Path]]:
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        return [], []
    root = Path(local) / "SuperClaw"
    bootstrap = _newest(root / "backend" / "logs" / "bootstrap", "*.log")
    manager = _newest(root / "sandbox_manager" / "logs" / "manager", "sbms-*.log")
    return bootstrap, manager


def _render(title: str, stages: dict[str, StageTotals]) -> None:
    print(f"\n{title}")
    if not stages:
        print("  (no events found)")
        return
    ordered = sorted(stages.items(), key=lambda item: item[1].elapsed_ms, reverse=True)
    width = max(len(name) for name, _ in ordered)
    print(f"  {'stage'.ljust(width)}  {'n':>3}  {'total_ms':>9}  detail")
    for name, totals in ordered:
        detail: list[str] = []
        if totals.files:
            detail.append(f"files={totals.files}")
        if totals.directories:
            detail.append(f"dirs={totals.directories}")
        if totals.bytes:
            detail.append(f"MiB={totals.bytes / (1024 * 1024):.1f}")
        if totals.extra_ms:
            detail.append(
                " ".join(f"{key}={value}" for key, value in sorted(totals.extra_ms.items()))
            )
        if totals.outcomes:
            detail.append(f"outcome={','.join(totals.outcomes)}")
        print(
            f"  {name.ljust(width)}  {totals.count:>3}  {totals.elapsed_ms:>9}  "
            f"{'  '.join(detail)}"
        )
    # Not a wall-clock total: reconcile_profile contains copy_* and flush_next, and
    # stage_payload contains copy_payload and several verify_payload passes, so summing
    # every stage counts the nested ones twice. Read the outermost stage for elapsed time.
    print(
        f"  {'-' * width}  {'':>3}  {sum(t.elapsed_ms for t in stages.values()):>9}  "
        f"sum of stages (nested stages double-count; not wall clock)"
    )


def _provenance_warnings(
    publication: dict[str, StageTotals], staging: dict[str, StageTotals]
) -> list[str]:
    """Catch a run that measured binaries older than the instrumentation.

    A stale payload produces a plausible-looking table with real durations and no counts,
    which is indistinguishable from a good run unless it is called out. Every whole-tree
    publication stage reports `files`, and staging reports at least one `verify_payload`,
    so the absence of either means the running binary predates this instrumentation and
    the numbers describe different code than the tree being worked on.
    """
    warnings: list[str] = []
    if publication and not any(totals.files for totals in publication.values()):
        warnings.append(
            "publication events carry no file counts: the orchestrator that produced this "
            "log predates the counting instrumentation, so the running payload is stale."
        )
    if not staging:
        warnings.append(
            "no STARTUP_DIAG events: the sandbox_manager bundle that produced this log "
            "predates the staging instrumentation, so staging was not measured."
        )
    return warnings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bootstrap-log", type=Path, action="append", default=[],
                        help="bootstrap tier log holding PUBLICATION_DIAG lines (repeatable)")
    parser.add_argument("--manager-log", type=Path, action="append", default=[],
                        help="sandbox_manager log holding STARTUP_DIAG lines (repeatable)")
    parser.add_argument("--json", action="store_true", help="emit collated totals as JSON")
    args = parser.parse_args(argv)

    bootstrap_logs = args.bootstrap_log
    manager_logs = args.manager_log
    if not bootstrap_logs and not manager_logs:
        bootstrap_logs, manager_logs = _default_logs()
        if not bootstrap_logs and not manager_logs:
            parser.error("no logs found; pass --bootstrap-log and/or --manager-log")

    publication = _collate(_events(bootstrap_logs, PUBLICATION_MARKER))
    staging = _collate(_events(manager_logs, STARTUP_MARKER))

    warnings = _provenance_warnings(publication, staging)

    if args.json:
        json.dump(
            {
                # Identity, not just a path: two runs summarised from the same log produce
                # byte-identical output, and only the source makes that visible.
                "bootstrap_logs": [_log_identity(path) for path in bootstrap_logs],
                "manager_logs": [_log_identity(path) for path in manager_logs],
                "warnings": warnings,
                "publication": {name: totals.as_dict() for name, totals in publication.items()},
                "staging": {name: totals.as_dict() for name, totals in staging.items()},
            },
            sys.stdout,
            indent=2,
        )
        print()
        for warning in warnings:
            print(f"warning: {warning}", file=sys.stderr)
        return 0

    for label, paths in (("bootstrap", bootstrap_logs), ("manager", manager_logs)):
        for path in paths:
            identity = _log_identity(path)
            print(f"{label} log: {identity['path']}  (modified {identity['modified']})")
    for warning in warnings:
        print(f"\nwarning: {warning}")
    _render("publication (PUBLICATION_DIAG)", publication)
    _render("staging (STARTUP_DIAG)", staging)

    walks = publication.get("validate_tree")
    if walks and walks.count > 1:
        print(
            f"\nnote: validate_tree ran {walks.count} times for {walks.elapsed_ms} ms total"
            f" over {walks.files} file visits -- repeated passes over the same tree."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
