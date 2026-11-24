"""What the broker client has observed, held for the isolation report.

Contract touched: ``RuntimeStatus`` (the isolation report). Adapter: this module is the one place the
provision and start paths leave their evidence; ``sandbox_manager.native_isolation_report`` reads it.

Three things are recorded, each from a source the control plane owns:

* the provision that applied (or, on a marker hit, was already recorded for) the current plan: the ACL
  policy version of the plan, the workspace roots' policy classes, and the roots themselves so the
  launcher can read them back later;
* the parsed started line of every role launch, with a liveness probe, so a role that exited stops
  counting;
* nothing a restricted process said about itself beyond the started line's job fact, which is carried
  as tier-reported.

Recording never fails a provision or a start: a record that cannot be made is logged and skipped, and
the report then has less evidence, which is the safe direction. The roots held here contain paths and so
stay out of ``repr``; the report never receives them.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Mapping
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from contracts.broker_tier_launch_started import BrokerTierLaunchStarted
from contracts.native_path_set import PolicyClass
from loguru import logger

from ..payload_integrity import VerifiedPayload
from .paths import resolve_launcher_executable

ProvisionSource = Literal["receipt", "marker"]

_WORKSPACE_CLASSES = frozenset(member.value for member in PolicyClass)


@dataclass(frozen=True)
class ProvisionRecord:
    """The latest provision evidence of this process's lifetime."""

    source: ProvisionSource
    owner_sid: str = field(repr=False)
    acl_policy_version: int
    workspace_root_classes: tuple[str, ...]
    path_set: Mapping[str, object] = field(repr=False)
    launcher: Path | None = field(repr=False)


@dataclass(frozen=True)
class LaunchRecord:
    """One started role launch and whether its launcher is still running."""

    tier: str
    owner_sid: str = field(repr=False)
    runner_sid: str = field(repr=False)
    job_verified: bool
    started_at: str
    alive: Callable[[], bool] = field(repr=False, compare=False)


class IsolationEvidence:
    """Thread-safe holder for the provision record and the running launches."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._provision: ProvisionRecord | None = None
        self._launches: list[LaunchRecord] = []

    def record_provision(
        self,
        *,
        owner_sid: str,
        path_set: Mapping[str, object],
        acl_plan: Mapping[str, object],
        payload_root: Path | None,
        verified_payload: VerifiedPayload | None,
        source: ProvisionSource,
    ) -> None:
        try:
            record = _provision_record(
                owner_sid, path_set, acl_plan, payload_root, verified_payload, source
            )
        except (KeyError, TypeError, ValueError, OSError) as exc:
            logger.warning(
                "isolation-evidence: event=provision_not_recorded reason={}",
                type(exc).__name__,
            )
            return
        with self._lock:
            self._provision = record

    def register_launch(
        self, started: BrokerTierLaunchStarted, alive: Callable[[], bool]
    ) -> None:
        job = started.evidence.job if started.evidence is not None else None
        record = LaunchRecord(
            tier=started.tier.value,
            owner_sid=started.owner_sid,
            runner_sid=started.runner_sid,
            job_verified=job is not None and job.membership_verified_before_resume,
            started_at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            alive=alive,
        )
        with self._lock:
            self._launches = [item for item in self._launches if _is_alive(item)]
            self._launches.append(record)

    def provision(self) -> ProvisionRecord | None:
        with self._lock:
            return self._provision

    def clear_provision(self) -> None:
        """Drop the provision record before a provision attempt, so a refused one leaves none behind."""
        with self._lock:
            self._provision = None

    def running_launches(self) -> list[LaunchRecord]:
        with self._lock:
            self._launches = [item for item in self._launches if _is_alive(item)]
            return list(self._launches)

    def reset(self) -> None:
        with self._lock:
            self._provision = None
            self._launches = []


def _is_alive(record: LaunchRecord) -> bool:
    try:
        return record.alive()
    except (OSError, ValueError):
        return False


def _provision_record(
    owner_sid: str,
    path_set: Mapping[str, object],
    acl_plan: Mapping[str, object],
    payload_root: Path | None,
    verified_payload: VerifiedPayload | None,
    source: ProvisionSource,
) -> ProvisionRecord:
    version = acl_plan["policy_version"]
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise ValueError("the ACL plan carries no policy version")
    roots: Any = path_set["workspace_roots"]
    classes = tuple(str(root["policy_class"]) for root in roots)
    if not _WORKSPACE_CLASSES.issuperset(classes):
        raise ValueError("a workspace root carries an unknown policy class")
    return ProvisionRecord(
        source=source,
        owner_sid=owner_sid,
        acl_policy_version=version,
        workspace_root_classes=classes,
        path_set=deepcopy(dict(path_set)),
        launcher=resolve_launcher_executable(
            payload_root=payload_root, verified=verified_payload
        ),
    )


#: The process-wide record the provision and start paths write and the isolation report reads.
EVIDENCE = IsolationEvidence()
