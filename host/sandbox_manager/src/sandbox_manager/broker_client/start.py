"""Closed product client for the unelevated native-isolation launcher."""

from __future__ import annotations

import hashlib
import json
import os
import queue
import struct
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Callable, Literal, Mapping

from contracts.broker_start_request import BrokerStartRequest
from contracts.broker_connector_client_config import BrokerConnectorClientConfig
from contracts.broker_startup_catalog_data import (
    BROKER_LAUNCH_ROLE_TIER,
    BROKER_STARTUP_CATALOG,
    BROKER_STARTUP_CATALOG_DIGEST,
    BROKER_STARTUP_CONTRACT_VERSION,
    BROKER_STARTUP_MANIFEST_VERSION,
)
from contracts.broker_tier_launch_refusal import BrokerTierLaunchRefusal
from contracts.broker_tier_launch_completed import BrokerTierLaunchCompleted
from contracts.broker_tier_launch_started import BrokerTierLaunchStarted
from loguru import logger
from pydantic import ValidationError

from ..payload_integrity import VerifiedPayload
from .cache_quarantine import purge_cache_quarantine_in_background, quarantine_disposable_caches
from .errors import BrokerClientRefusal, BrokerRefusalReason
from .isolation_evidence import EVIDENCE
from .paths import resolve_launcher_executable
from .provision import ensure_workspace_acl_provisioned
from .provision import ensure_owner_tier_identities

LaunchRole = Literal[
    "supervisor_executable",
    "token_service_executable",
    "connector_executable",
    "runtime_executable",
    "connector_service",
    "hdr_sidecar",
]

_START_TIMEOUT_SECONDS = 30.0
_STOP_TIMEOUT_SECONDS = 30.0
_MAX_CONTROL_BYTES = 64 * 1024
_MAX_REPORT_BYTES = 64 * 1024


@dataclass(frozen=True)
class BrokerStartPolicy:
    path_set: dict[str, object]
    acl_plan: dict[str, object]


class BrokerLaunch:
    """One launcher process and the only owner of its stdin control writer."""

    def __init__(
        self,
        *,
        process: subprocess.Popen[bytes],
        control: BinaryIO,
        reports: queue.Queue[bytes | None],
        started: BrokerTierLaunchStarted,
        connector_config: BrokerConnectorClientConfig | None = None,
        diagnostics: queue.Queue[bytes | None] | None = None,
    ) -> None:
        self._process = process
        self._control = control
        self._reports = reports
        self._started = started
        self._diagnostics = diagnostics
        self._exit_logged = False
        self.connector_config = connector_config
        self.pid = started.role_pid
        EVIDENCE.register_launch(
            started,
            lambda: self._process.poll() is None and not self._control.closed,
        )

    @property
    def returncode(self) -> int | None:
        return self._process.returncode

    def poll(self) -> int | None:
        code = self._process.poll()
        if code is not None and not self._exit_logged:
            self._exit_logged = True
            logger.error(
                "native-launcher: event=exited role={} role_pid={} launcher_code={} diagnostics={}",
                self._started.launch_role.value,
                self.pid,
                code,
                _safe_lifecycle_diagnostics(self._diagnostics),
            )
        return code

    def wait(self, timeout: float | None = None) -> int:
        return self._process.wait(timeout=timeout)

    def stop(self, timeout: float = _STOP_TIMEOUT_SECONDS) -> None:
        if self._control.closed:
            return
        requested = time.monotonic()
        try:
            self._control.write(_frame({"op": "stop"}))
            self._control.flush()
        finally:
            self._control.close()
        try:
            completion = self._reports.get(timeout=timeout)
            if completion is None:
                raise OSError("native isolation launcher closed stdout before completion")
            completed = _parse_completed(completion, started=self._started)
            logger.info(
                "native-launcher: event=stopped role={} runner_pid={} owner_cleanup_ms={} "
                "stop_to_report_ms={}",
                self._started.launch_role.value,
                completed.runner_pid,
                completed.owner_job.cleanup_elapsed_ms,
                round((time.monotonic() - requested) * 1000),
            )
            if self._reports.get(timeout=timeout) is not None:
                raise OSError("native isolation launcher emitted an extra lifecycle report")
            code = self._process.wait(timeout=timeout)
        except (queue.Empty, subprocess.TimeoutExpired, ValidationError, ValueError) as exc:
            _abort_start(self._process)
            raise OSError(f"native isolation launcher completion was not confirmed: {exc}") from None
        except OSError:
            _abort_start(self._process)
            raise
        if code != 0:
            raise OSError(f"native isolation launcher exited with code {code}")

    def terminate(self) -> None:
        self.stop()

    def kill(self) -> None:
        if not self._control.closed:
            self._control.close()
        if self._process.poll() is None:
            self._process.kill()
        self._process.wait(timeout=_STOP_TIMEOUT_SECONDS)


class ProvisionRepair:
    """The forced provision that answers ``provision_required``, shared by the launches of one start.

    ``start_role`` answers that refusal by provisioning once and retrying once, so launches started one
    after another show one UAC prompt for one drift. Launches started concurrently would each ask for
    their own, because each reads the drifted roots before the first repair finishes. A launch therefore
    notes the repair generation it started under, and a repair that completed after that answers it too:
    a provisioned repair lets it retry, and a failed one - a refusal or a declined prompt included - is its
    failure as well, so the user is not asked again and nothing retries against unrepaired roots. A launch
    that starts after a repair and still reports drift gets a repair of its own.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._generation = 0
        self._failure: Exception | None = None

    @property
    def generation(self) -> int:
        return self._generation

    def repair(self, observed: int, *, role: str, provision: Callable[[], object]) -> None:
        with self._lock:
            if self._generation == observed:
                self._failure = None
                try:
                    provision()
                except Exception as exc:
                    self._failure = exc
                    raise
                finally:
                    self._generation += 1
                return
            failure = self._failure
        logger.info(
            "native-launcher: event=provision_shared role={} outcome={}",
            role,
            "retrying" if failure is None
            else "refused" if isinstance(failure, BrokerClientRefusal)
            else "failed",
        )
        if isinstance(failure, BrokerClientRefusal):
            raise BrokerClientRefusal(failure.items) from failure
        if failure is not None:
            raise RuntimeError(
                f"the shared workspace provision failed with {type(failure).__name__}"
            ) from failure


def _repair_tier_identities(
    *,
    owner_sid: str,
    policy: BrokerStartPolicy,
    payload_root: Path,
    verified_payload: VerifiedPayload | None,
) -> None:
    """Recreates tier accounts a stale marker hid, moving the rebuildable caches aside first.

    The ACL provision that follows rewrites every file under the kept data roots for the new SIDs, so the
    caches must not be in the tree when it starts.
    """
    quarantine_disposable_caches(policy.path_set)
    ensure_owner_tier_identities(
        owner_sid=owner_sid,
        payload_root=payload_root,
        verified_payload=verified_payload,
        force=True,
    )


def start_role(
    *,
    role: LaunchRole,
    owner_sid: str,
    payload_root: Path,
    verified_payload: VerifiedPayload | None,
    policy: BrokerStartPolicy,
    scalars: Mapping[str, str | int],
    provision_repair: ProvisionRepair | None = None,
) -> BrokerLaunch:
    try:
        ensure_workspace_acl_provisioned(
            owner_sid=owner_sid,
            path_set=policy.path_set,
            acl_plan=policy.acl_plan,
            payload_root=payload_root,
            verified_payload=verified_payload,
        )
    except BrokerClientRefusal as refusal:
        stale_identity_marker = any(
            item.reason is BrokerRefusalReason.provision_refused
            and item.detail == "provision_precondition_missing"
            for item in refusal.items
        )
        if not stale_identity_marker:
            raise
        _repair_tier_identities(
            owner_sid=owner_sid,
            policy=policy,
            payload_root=payload_root,
            verified_payload=verified_payload,
        )
        ensure_workspace_acl_provisioned(
            owner_sid=owner_sid,
            path_set=policy.path_set,
            acl_plan=policy.acl_plan,
            payload_root=payload_root,
            verified_payload=verified_payload,
            force=True,
        )
    purge_cache_quarantine_in_background(policy.path_set)
    repair = ProvisionRepair() if provision_repair is None else provision_repair
    observed = repair.generation
    try:
        return _start_once(
            role=role,
            owner_sid=owner_sid,
            payload_root=payload_root,
            verified_payload=verified_payload,
            policy=policy,
            scalars=scalars,
        )
    except BrokerClientRefusal as refusal:
        if not any(
            item.reason is BrokerRefusalReason.provision_required
            for item in refusal.items
        ):
            raise
        logger.warning(
            "native-launcher: event=provision_required role={} detail={}; "
            "provisioning the workspace access control and retrying once",
            role,
            "; ".join(item.detail for item in refusal.items),
        )
    repair.repair(
        observed,
        role=role,
        provision=lambda: ensure_workspace_acl_with_identity_repair(
            owner_sid=owner_sid,
            policy=policy,
            payload_root=payload_root,
            verified_payload=verified_payload,
            force=True,
        ),
    )
    return _start_once(
        role=role,
        owner_sid=owner_sid,
        payload_root=payload_root,
        verified_payload=verified_payload,
        policy=policy,
        scalars=scalars,
    )


def ensure_workspace_acl_with_identity_repair(
    *,
    owner_sid: str,
    policy: BrokerStartPolicy,
    payload_root: Path,
    verified_payload: VerifiedPayload | None,
    force: bool = False,
) -> None:
    try:
        ensure_workspace_acl_provisioned(
            owner_sid=owner_sid,
            path_set=policy.path_set,
            acl_plan=policy.acl_plan,
            payload_root=payload_root,
            verified_payload=verified_payload,
            force=force,
        )
    except BrokerClientRefusal as refusal:
        stale_identity_marker = any(
            item.reason is BrokerRefusalReason.provision_refused
            and item.detail == "provision_precondition_missing"
            for item in refusal.items
        )
        if not stale_identity_marker:
            raise
        _repair_tier_identities(
            owner_sid=owner_sid,
            policy=policy,
            payload_root=payload_root,
            verified_payload=verified_payload,
        )
        ensure_workspace_acl_provisioned(
            owner_sid=owner_sid,
            path_set=policy.path_set,
            acl_plan=policy.acl_plan,
            payload_root=payload_root,
            verified_payload=verified_payload,
            force=True,
        )
    # Whatever the provision above made unnecessary to walk is deleted off this path.
    purge_cache_quarantine_in_background(policy.path_set)


def _start_once(
    *,
    role: LaunchRole,
    owner_sid: str,
    payload_root: Path,
    verified_payload: VerifiedPayload | None,
    policy: BrokerStartPolicy,
    scalars: Mapping[str, str | int],
) -> BrokerLaunch:
    launcher = resolve_launcher_executable(
        payload_root=payload_root,
        verified=verified_payload,
    )
    if launcher is None:
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.launcher_not_found,
            "native_isolation_launcher.exe is missing",
        )

    request = _build_start_request(role=role, policy=policy, scalars=scalars)
    command = [
            str(launcher.resolve()),
            "--launch-tier",
            "--owner-sid",
            owner_sid,
            "--tier",
            BROKER_LAUNCH_ROLE_TIER[role],
        ]
    secret_reader: BinaryIO | None = None
    secret_writer: BinaryIO | None = None
    startupinfo = None
    if role == "connector_service":
        secret_reader, secret_writer = _connector_secret_pipe()
        command.extend(["--connector-client-handle", str(_windows_handle(secret_writer))])
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.lpAttributeList = {"handle_list": [_windows_handle(secret_writer)]}
    try:
        process = subprocess.Popen(  # noqa: S603 - argv is resolved out of the verified payload
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            close_fds=True,
            startupinfo=startupinfo,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        if secret_reader is not None:
            secret_reader.close()
        raise
    finally:
        if secret_writer is not None:
            os.set_handle_inheritable(_windows_handle(secret_writer), False)
            secret_writer.close()
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None
    _make_control_writer_non_inheritable(process.stdin)
    reports: queue.Queue[bytes | None] = queue.Queue()
    _drain_lines(process.stdout, reports)
    diagnostics: queue.Queue[bytes | None] = queue.Queue()
    _drain_lines(process.stderr, diagnostics)
    try:
        process.stdin.write(_frame(request))
        process.stdin.flush()
        first = reports.get(timeout=_START_TIMEOUT_SECONDS)
    except (BrokenPipeError, OSError, queue.Empty) as exc:
        _abort_start(process)
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.launch_refused,
            f"native isolation launcher did not report startup: {exc}",
        ) from exc
    if first is None:
        detail = _queued_diagnostics(diagnostics) or "launcher closed stdout before startup"
        _abort_start(process)
        raise BrokerClientRefusal.single(BrokerRefusalReason.launch_refused, detail)

    try:
        started = _parse_started_or_refusal(first, role=role, owner_sid=owner_sid)
        connector_config = (
            _read_connector_config(secret_reader)
            if secret_reader is not None
            else None
        )
    except (BrokerClientRefusal, ValueError):
        _abort_start(process)
        raise
    # One unelevated WFP readback per start, off this thread: the start never waits for it and a failure
    # of it is a `not_read` verdict, not an error.
    from ..native_egress_status import schedule_readback

    schedule_readback(owner_sid, launcher.resolve())
    logger.info(
        "native-launcher: event=started role={} lifecycle={}",
        started.launch_role.value,
        _bootstrap_created_line(diagnostics),
    )
    return BrokerLaunch(
        process=process,
        control=process.stdin,
        reports=reports,
        started=started,
        connector_config=connector_config,
        diagnostics=diagnostics,
    )


def _build_start_request(
    *,
    role: LaunchRole,
    policy: BrokerStartPolicy,
    scalars: Mapping[str, str | int],
) -> dict[str, object]:
    entry = next(
        item for item in BROKER_STARTUP_CATALOG["entries"] if item["launch_role"] == role
    )
    path_set = policy.path_set
    workspace_root_id: str | None = None
    workspace_path: str | None = None
    roots = path_set.get("workspace_roots")
    if isinstance(roots, list) and len(roots) == 1 and isinstance(roots[0], dict):
        root_id = roots[0].get("root_id")
        root_path = roots[0].get("path")
        if isinstance(root_id, str) and isinstance(root_path, str):
            workspace_root_id = root_id
            workspace_path = root_path

    paths: dict[str, object] = {
        "payload_root": path_set.get("payload_root"),
        "workspace_root": workspace_path,
        "state_config_root": path_set.get("config_root"),
        "state_data_root": path_set.get("data_root"),
        "state_logs_root": path_set.get("logs_root"),
        "state_temp_root": path_set.get("temp_root"),
        "isolation_root": path_set.get("isolation_root"),
    }
    required_paths = list(entry["path_placeholders"])
    required_scalars = list(entry["scalar_placeholders"])
    host_token = scalars.get("host_token")
    if "host_token_sha256" in required_scalars and isinstance(host_token, str) and host_token:
        # The tier runner holds the whole start request, so a role that only checks the host token is
        # bound its hash and never the plaintext (#3498).
        digest = hashlib.sha256(host_token.encode("utf-8")).hexdigest()
        scalars = {**scalars, "host_token_sha256": digest}
    if any(not isinstance(paths.get(name), str) for name in required_paths):
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.launch_refused,
            f"start policy is missing path bindings for {role}",
        )
    if any(name not in scalars for name in required_scalars):
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.launch_refused,
            f"start request is missing scalar bindings for {role}",
        )
    request = {
        "contract_version": BROKER_STARTUP_CONTRACT_VERSION,
        "manifest_version": BROKER_STARTUP_MANIFEST_VERSION,
        "manifest_digest": BROKER_STARTUP_CATALOG_DIGEST,
        "launch_role": role,
        "workspace_root_id": workspace_root_id if "workspace_root" in required_paths else None,
        "path_bindings": [
            {"placeholder": name, "path": paths[name]} for name in required_paths
        ],
        "scalar_bindings": [
            {"placeholder": name, "value": scalars[name]} for name in required_scalars
        ],
    }
    encoded = json.dumps(request, separators=(",", ":"), allow_nan=False)
    return BrokerStartRequest.model_validate_json(encoded, strict=True).model_dump(mode="json")


def _frame(value: Mapping[str, object]) -> bytes:
    payload = json.dumps(
        dict(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    if not payload or len(payload) > _MAX_CONTROL_BYTES:
        raise ValueError("launcher control frame is outside the 64 KiB bound")
    return struct.pack("<I", len(payload)) + payload


def _parse_started_or_refusal(
    payload: bytes,
    *,
    role: LaunchRole,
    owner_sid: str,
) -> BrokerTierLaunchStarted:
    try:
        started = BrokerTierLaunchStarted.model_validate_json(payload, strict=True)
    except ValidationError:
        try:
            refusal = BrokerTierLaunchRefusal.model_validate_json(payload, strict=True)
        except ValidationError as exc:
            raise BrokerClientRefusal.single(
                BrokerRefusalReason.launch_refused,
                "launcher startup report does not match a governed schema",
            ) from exc
        item = refusal.refusals[0]
        reason = (
            BrokerRefusalReason.provision_required
            if item.reason.value == "provision_required"
            else BrokerRefusalReason.launch_refused
        )
        raise BrokerClientRefusal.single(
            reason,
            f"{item.reason.value}: {item.detail}; {item.remedy}",
        )
    if (
        started.owner_sid != owner_sid
        or started.launch_role.value != role
        or started.tier.value != BROKER_LAUNCH_ROLE_TIER[role]
    ):
        raise BrokerClientRefusal.single(
            BrokerRefusalReason.launch_refused,
            "launcher startup report is not bound to the requested owner, tier, and role",
        )
    return started


def _parse_completed(
    payload: bytes, *, started: BrokerTierLaunchStarted
) -> BrokerTierLaunchCompleted:
    completed = BrokerTierLaunchCompleted.model_validate_json(payload, strict=True)
    # The schema admits one runner frame and owner-held Job evidence whose cleanup is confirmed.
    (first,) = completed.runner_frames
    if (
        first.op != "started"
        or completed.owner_sid != started.owner_sid
        or completed.runner_sid != started.runner_sid
        or completed.launch_role.value != started.launch_role.value
        or completed.tier.value != started.tier.value
        or completed.runner_pid != started.runner_pid
        or first.launch_role.value != started.launch_role.value
        or first.tier.value != started.tier.value
        or first.role_pid != started.role_pid
    ):
        raise ValueError("launcher completion is not bound to its startup report")
    return completed


def _drain_lines(stream: BinaryIO, destination: queue.Queue[bytes | None]) -> None:
    def run() -> None:
        try:
            while line := stream.readline(_MAX_REPORT_BYTES + 1):
                if len(line) > _MAX_REPORT_BYTES:
                    destination.put(None)
                    return
                destination.put(line)
        finally:
            destination.put(None)
            stream.close()

    threading.Thread(target=run, name="native-launcher-output", daemon=True).start()


def _queued_diagnostics(diagnostics: queue.Queue[bytes | None]) -> str:
    parts: list[bytes] = []
    while True:
        try:
            value = diagnostics.get_nowait()
        except queue.Empty:
            break
        if value:
            parts.append(value)
    return b"".join(parts).decode("utf-8", errors="replace").strip()


def _safe_lifecycle_diagnostics(
    diagnostics: queue.Queue[bytes | None] | None,
) -> str:
    if diagnostics is None:
        return "unavailable"
    lines = _queued_diagnostics(diagnostics).splitlines()
    safe = [
        line.strip()[:512]
        for line in lines
        if line.startswith("native_launcher_lifecycle ")
        or line.startswith("native_role_lifecycle ")
    ]
    return " | ".join(safe[-4:]) or "unavailable"


def _bootstrap_created_line(diagnostics: queue.Queue[bytes | None]) -> str:
    # A snapshot under the queue's lock, so the lines stay queued for the exit diagnostics.
    with diagnostics.mutex:
        queued = list(diagnostics.queue)
    for value in queued:
        line = (value or b"").decode("utf-8", errors="replace").strip()
        if line.startswith("native_launcher_lifecycle ") and " event=bootstrap_created " in line:
            return line[:512]
    return "unavailable"


def _abort_start(process: subprocess.Popen[bytes]) -> None:
    if process.stdin is not None and not process.stdin.closed:
        process.stdin.close()
    if process.poll() is None:
        process.kill()
    process.wait(timeout=_STOP_TIMEOUT_SECONDS)


def _make_control_writer_non_inheritable(control: BinaryIO) -> None:
    if os.name != "nt":
        return
    import msvcrt

    os.set_handle_inheritable(msvcrt.get_osfhandle(control.fileno()), False)


def _connector_secret_pipe() -> tuple[BinaryIO, BinaryIO]:
    if os.name != "nt":
        raise OSError("Connector secret pipe requires Windows")
    reader_fd, writer_fd = os.pipe()
    reader = os.fdopen(reader_fd, "rb", buffering=0)
    writer = os.fdopen(writer_fd, "wb", buffering=0)
    os.set_inheritable(reader_fd, False)
    os.set_inheritable(writer_fd, True)
    return reader, writer


def _windows_handle(stream: BinaryIO) -> int:
    import msvcrt

    return msvcrt.get_osfhandle(stream.fileno())


def _read_connector_config(reader: BinaryIO) -> BrokerConnectorClientConfig:
    try:
        prefix = reader.read(4)
        if len(prefix) != 4:
            raise ValueError("Connector client configuration prefix is incomplete")
        length = struct.unpack("<I", prefix)[0]
        if length == 0 or length > 1024:
            raise ValueError("Connector client configuration length is outside its bound")
        payload = reader.read(length)
        if len(payload) != length or reader.read(1) not in (b"", None):
            raise ValueError("Connector client configuration frame is incomplete or has trailing bytes")
        return BrokerConnectorClientConfig.model_validate_json(payload, strict=True)
    finally:
        reader.close()