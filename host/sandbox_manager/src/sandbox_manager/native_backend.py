"""Windows-native agent backend lifecycle (the only SANDBOX backend).

``sandbox_manager.main`` wires :class:`NativeBackendLifecycle` as
``app.state.lifecycle``; the FastAPI layer calls ``ensure_ready`` /
``control`` / ``shutdown`` / ``status`` on it.

:class:`NativeBackendLifecycle` supervises five native backend roles:

* :meth:`NativeBackendLifecycle.ensure_ready` - verify the native payload
    against its manifest, build the native path and ACL policy, provision the
    owner's tier identities and empty backend roots, stage the payload, seed the
    selected Product Profile, start the roles, wait for health, and issue an OWT
    via :class:`~sandbox_manager.owt_cache.OwtCache`.
* :meth:`NativeBackendLifecycle.control` - start / stop / restart (RunManager
  run ids, polled through ``/operations``).
* :meth:`NativeBackendLifecycle.shutdown` - tear down the owned roles.
* :meth:`NativeBackendLifecycle.status` - the sandbox status APIs.

Each role starts through :func:`~sandbox_manager.broker_client.start_role`, which
runs it in its tier account and its own Job under the unelevated
``native_isolation_launcher``. The launcher's standard-input control stream binds
the role's lifetime to this process. Networking is loopback-only.

**Caller-visible contracts:**

* OWT issuance goes through ``owt_cache.issue()`` and ``POST /tokens``
  with a per-boot host token (ServiceHub → UI trust model).
* Capability materialization commits the ProfileSnapshot to the locator file on
  disk.

Dev binaries resolve from ``build/native-backend/bin`` before packaged payload dirs,
and the OpenCode config tree from the Product Profile the committed Runtime
Deployment selected (``sandbox/agent_config/profiles/<id>`` in a source checkout).
Every payload, a source-checkout build included, must carry a manifest; the
payload ships pre-baked ``node_modules``. Native isolation uses the tier-account
and per-role Job launch path described above.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import secrets
import shutil
import stat
import sys
import threading
import time
from functools import partial
from pathlib import Path
from typing import Any, NoReturn

import httpx
from loguru import logger

from contracts.connector_ipc_data import CONNECTOR_IPC_CONTRACT_VERSION
from contracts.egress_loopback_ports_data import EGRESS_LOOPBACK_PORT_RULES
from contracts.runtime_instance_evidence import RuntimeInstanceEvidence

from .broker_client import (
    BrokerClientRefusal,
    BrokerLaunch,
    PreparedBrokerPolicy,
    ProvisionRepair,
    ensure_tier_identities_and_workspace_acl,
    is_workspace_acl_refusal,
    owner_tiers_fully_provisioned,
    start_role,
    stop_launches_by_identity,
)
from .broker_client.errors import BrokerRefusalReason
from .broker_client.egress_wfp_inputs import use_upstream_reader
from .broker_client.policy import build_broker_start_policy
from .broker_client.provision import (
    create_owner_owned_backend_roots,
    current_owner_sid,
    provision_steps_due,
)
from .broker_client.start import BrokerStartPolicy, ensure_workspace_acl_with_identity_repair
from .connector_projection import project_connector_search_module
from .dpapi_secret_file import write_sealed_json
from .loopback_ports import allocate_fixed_port, tcp_dynamic_port_range
from .native_egress_wiring import (
    connector_proxy_env,
    egress_proxy_config,
    egress_proxy_mode,
    egress_proxy_session_key,
    local_proxy_url,
    wait_for_listeners,
)
from .lrm_credentials import resolve_lrm_api_key
from .privacy_credentials import resolve_privacy_api_key
from .native_log_retention import prune_native_isolation_logs, rotate_audit_log
from .native_role_launch import start_role_logged, start_roles_concurrently
from .native_runtime_generation_cleanup import GenerationPrune
from .native_startup_health import wait_for_startup_health
from .payload_integrity import (
    PayloadFailureReason,
    PayloadIntegrityError,
    VerifiedPayload,
    verify_payload,
)
from .payload_archive import (
    ARCHIVE_NAME,
    InstalledPayloadArchive,
    InstalledSource,
    is_installed_archive,
    open_installed_archive,
    stage_installed_archive,
)
from .payload_failure import (
    PAYLOAD_IN_USE,
    PayloadFailure,
    error_status,
    payload_failure,
    safe_payload_reason,
)
from .payload_staging import (
    PayloadInUseError,
    remove_legacy_payload_dirs,
    stage_verified_payload,
)
from .product_profile_source import (
    PRODUCT_PROFILE_IDS,
    ProductProfileDigestError,
    compute_product_profile_digest,
)
from .runs import (
    KIND_SANDBOX_CONTROL,
    RunHandle,
    RunManager,
)
from .runtime_global_config import seed_runtime_global_config
from .runtime_python import prepare_runtime_python
from .store import RUNTIME_DEPLOYMENT_CONFIG_KEY
from .channel_config import ROUTER_CONFIG_RELATIVE_PATH
from .channel_router_files import prepare_channel_tier, seal_router_approval
from .tavily_api_key_store import TavilyApiKeyUnreadable
from .trajectory_inspector import TrajectoryInspector
from .upstream_proxy import UpstreamProxy, read_system_proxy, resolve_upstream
from .v1_import import import_v1_state_once

_LLMROUTER_PORT = 18321
_CONNECTOR_AUDIT_FILE_NAME = "connector-audit.jsonl"
_PROXY_AUDIT_FILE_NAME = "proxy-audit.jsonl"
_EGRESS_PROXY_CONFIG_FILE_NAME = "egress-proxy.json"
# Pauses between the tries to re-seal the Connector's provider config after a key change.
_RESEAL_PAUSES_S = (0.05, 0.25)
# Publishing the pro Profile can spend more than 120s in per-file Windows
# flushes before the generation receipt becomes visible.
_HEALTH_TIMEOUT_S = 300.0
_HEALTH_POLL_S = 0.5
# Windows refuses a closed loopback port only after ~2 s, so a longer connect
# timeout on the listener probe is pure waiting.
_HEALTH_PROBE_TIMEOUT_S = 2.0
_HEALTH_PROBE_CONNECT_TIMEOUT_S = 0.25
# HDR /readyz has an 8s overall server budget (reader/cleanup + Connector + LRM
# + file work). Allow 2s transport margin; match the Supervisor managed probe.
_HDR_READY_TIMEOUT_S = 10.0
# Refresh early enough to cover a full probe plus the 2s status polling cadence.
_HDR_STATUS_FRESHNESS_S = 15.0
_HDR_STATUS_REFRESH_S = 2.0
_PROCESS_STOP_TIMEOUT_S = 5.0
# ServiceHub's boot reconcile commits a Runtime Deployment for a changed Product Profile by
# re-driving the committed model binding, which re-prepares the primary bundle: 55-65 s for a
# local model on a dev laptop (#3526), a few seconds for a cloud one. The wait has to outlast
# that, or the first start after an upgrade that changes a Profile fails once before the retry
# converges. It stays bounded so a genuinely mismatched Profile still fails closed, and well
# inside the UI's local boot connect budget (LOCAL_BOOT_CONNECT_HEALTH_TIMEOUT_MS, 180 s).
_PROFILE_RECONCILE_WAIT_S = 120.0
_PROFILE_RECONCILE_POLL_S = 0.5
_MAX_CONNECTOR_RESPONSE_BYTES = 128 * 1024
_LOCKFILE_NAME = "native-backend.lock"

# Launch order, the last three (and on pro HDR with them) starting together; cleanup always visits
# every owned handle, independent of the current Profile roster (which may already have been cleared
# by a failed stop).
_BROKER_ROLE_FIELDS = (
    ("supervisor_executable", "_proc"),
    ("connector_service", "_connector_proc"),
    ("egress_proxy", "_egress_proxy_proc"),
    ("hdr_sidecar", "_hdr_proc"),
    ("runtime_executable", "_runtime_proc"),
    ("connector_executable", "_router_proc"),
    ("token_service_executable", "_openwork_server_proc"),
)

_ENV_BIN_DIR = "SUPERCLAW_NATIVE_BACKEND_BIN_DIR"
_ENV_STATE_DIR = "SUPERCLAW_NATIVE_BACKEND_STATE_DIR"
_ENV_CONFIG_SOURCE = "SUPERCLAW_NATIVE_BACKEND_CONFIG_SOURCE"
_ENV_PROFILES_ROOT = "SUPERCLAW_NATIVE_BACKEND_PROFILES_ROOT"
# Provisions the owner's tier identities before the roles start. On by default; "0" skips
# provisioning (and its UAC prompt) for a machine whose identities are already in place.
# It does not select a different launch path: the roles always start in their tier accounts.
_ENV_BOOTSTRAP_TIER = "SUPERCLAW_NATIVE_BOOTSTRAP_TIER"
# How many pre-`payload/current` payload directories to keep, most recent first. Default 0:
# nothing points at them any more, so a kept one only costs about a gigabyte.
_ENV_LEGACY_PAYLOAD_KEEP = "SUPERCLAW_NATIVE_LEGACY_PAYLOAD_KEEP"
_SOURCE_MODULE_PATH = Path(
    "host/sandbox_manager/src/sandbox_manager/native_backend.py"
)


# Recovery hint per typed broker refusal: a not-found refusal never shows UAC,
# so "retry after admin provision" would send the user toward the wrong action.
_TIER_IDENTITY_RECOVERY: dict[BrokerRefusalReason, str] = {
    BrokerRefusalReason.broker_not_found: "reinstall_native_payload",
    BrokerRefusalReason.owner_sid_unavailable: "restart_required",
}


class _ProductProfileDigestPending(Exception):
    """The installed Profile differs from the committed deployment's digest; not yet a failure."""


def _tier_identity_recovery(refusal: BrokerClientRefusal) -> str:
    for item in refusal.items:
        mapped = _TIER_IDENTITY_RECOVERY.get(item.reason)
        if mapped is not None:
            return mapped
    return "retry_after_admin_provision"


# --------------------------------------------------------------------------- path resolution


def _repo_root_from_here() -> Path | None:
    """Return the checkout root only for this module's exact source-tree copy."""
    module_path = Path(__file__).resolve()
    for parent in module_path.parents:
        if not (
            (parent / "pnpm-workspace.yaml").is_file()
            or (parent / ".git").exists()
        ):
            continue
        try:
            expected_module = (parent / _SOURCE_MODULE_PATH).resolve(strict=True)
        except OSError:
            continue
        if expected_module == module_path:
            return parent
    return None


def _source_development_runtime() -> bool:
    """Whether this process is executing the module from an exact source checkout."""
    return not bool(getattr(sys, "frozen", False)) and _repo_root_from_here() is not None


def resolve_bin_dir(resources_dir: Path | None = None) -> Path | None:
    """First existing dir containing ``openwork.exe``, or the installed payload archive.

    Order: env override → **installed archive, then tree, beside our own exe** →
    the dev repo build tree → the ``resources`` data dir. The installer ships the
    payload as ``<install>\\servicehub\\native-backend.zip``; staging
    extracts it, so callers must not treat a returned archive as a directory.

    The repo candidates sit ahead of ``resources_dir`` even though it is the
    older arrangement, because they exist *only* on a source-development runtime
    (:func:`_repo_root_from_here` matches this module's exact source copy, so a
    frozen install never reaches them) and because ``resources_dir`` is no
    longer refreshed for the native payload: ``build-superclaw.ps1`` builds the
    Debug payload beside ``superclaw-services.exe`` and passes
    ``-SkipResourceSync``, so whatever native payload is left under
    ``%LOCALAPPDATA%`` is a leftover from an older build. Preferring it would
    silently run ``pnpm dev`` — which builds no payload of its own — against a
    stale backend.
    """
    candidates: list[Path] = []
    if os.environ.get(_ENV_BIN_DIR):
        if _source_development_runtime():
            candidates.append(Path(os.environ[_ENV_BIN_DIR]))
        else:
            logger.warning("Ignoring {} in an installed build: {}", _ENV_BIN_DIR, os.environ[_ENV_BIN_DIR])
    # Frozen: <install>/servicehub/sandbox_manager/sandbox_manager.exe → look in
    # our own dir and one level up (the servicehub payload root).
    try:
        exe_dir = Path(sys.executable).resolve().parent
        candidates += [exe_dir / ARCHIVE_NAME, exe_dir.parent / ARCHIVE_NAME]
        candidates += [exe_dir / "native-backend", exe_dir.parent / "native-backend"]
    except Exception:  # noqa: BLE001 - path resolution must never break startup
        pass
    repo = _repo_root_from_here()
    if repo is not None:
        # Where build-superclaw.ps1 puts it, Debug first because that is the
        # configuration `pnpm dev` is for; then the default OutDir used when
        # build-native-backend.ps1 is run on its own.
        candidates.append(repo / "build" / "Debug" / "servicehub" / "native-backend")
        candidates.append(repo / "build" / "Release" / "servicehub" / "native-backend")
        candidates.append(repo / "build" / "native-backend" / "bin")
    if resources_dir is not None:
        candidates.append(Path(resources_dir) / "native-backend")
    for c in candidates:
        if is_installed_archive(c) or (c / "openwork.exe").exists():
            return c
    return None


def resolve_product_profiles_root() -> Path | None:
    """First existing Product Profile root (the v1.2 OpenCode config authority).

    Order mirrors :func:`resolve_bin_dir`: env override (source checkouts only) →
    **installed layout beside our own exe** → the dev repo tree.

    The installed candidates are siblings of the native payload:
    ``build-servicehub.ps1`` mirrors the profiles to ``<install>/servicehub/
    agent-config/profiles`` while sandbox_manager's own exe lives at
    ``<install>/servicehub/sandbox_manager/``, so both ``exe_dir`` and its parent
    are checked for the same reason ``resolve_bin_dir`` checks both.
    """
    candidates: list[Path] = []
    source_development = _source_development_runtime()
    if source_development and os.environ.get(_ENV_PROFILES_ROOT):
        candidates.append(Path(os.environ[_ENV_PROFILES_ROOT]))
    try:
        exe_dir = Path(sys.executable).resolve().parent
        candidates.append(exe_dir / "agent-config" / "profiles")
        candidates.append(exe_dir.parent / "agent-config" / "profiles")
    except Exception:  # noqa: BLE001 - path resolution must never break startup
        pass
    repo = _repo_root_from_here() if source_development else None
    if repo is not None:
        candidates.append(repo / "sandbox" / "agent_config" / "profiles")
    return next((c for c in candidates if c.is_dir()), None)


def resolve_config_source(bin_dir: Path | None = None) -> Path | None:
    """Resolve the payload's offline OpenCode dependency tree.

    Since v1.2 the OpenCode *config* tree comes from the selected Product Profile
    (:func:`resolve_product_profiles_root`), which declares its dependencies but
    ships no ``node_modules``. This tree supplies that pre-baked ``node_modules``,
    so its dependency manifest - not ``opencode.jsonc`` - identifies it.

    Overrides are available only to exact source checkouts.
    """
    if _source_development_runtime() and os.environ.get(_ENV_CONFIG_SOURCE):
        p = Path(os.environ[_ENV_CONFIG_SOURCE])
        return p if (p / "package.json").exists() else None
    if bin_dir is not None:
        p = bin_dir / "config-source"
        if (p / "package.json").exists():
            return p
    return None


def default_state_dir() -> Path:
    if os.environ.get(_ENV_STATE_DIR):
        return Path(os.environ[_ENV_STATE_DIR])
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    return Path(base) / "SuperClaw" / "backend"


def _bootstrap_tier_enabled() -> bool:
    return os.environ.get(_ENV_BOOTSTRAP_TIER, "1").strip() == "1"


def _legacy_payload_keep() -> int:
    try:
        return max(int(os.environ.get(_ENV_LEGACY_PAYLOAD_KEEP, "0")), 0)
    except ValueError:
        return 0


def _tier_identity_provision_enabled() -> bool:
    return _bootstrap_tier_enabled() and os.name == "nt"


def _workspace_dir() -> Path:
    override = os.environ.get("WINDOWS_SUPERCLAW_PATH")
    if override:
        return Path(override)
    return Path.home() / "SuperClawProjects"


#: The default runtime configuration written into a workspace that has none.
#:
#: Byte-identical to what the orchestrator used to write, including the trailing newline, so that a
#: workspace scaffolded by this owner-side step is indistinguishable from one an older build made.
_DEFAULT_WORKSPACE_CONFIG = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'

#: The two names a runtime configuration may already have. Either one means the workspace is configured.
_WORKSPACE_CONFIG_NAMES = ("opencode.jsonc", "opencode.json")


def _path_present(path: Path) -> bool:
    """Whether a path exists, refusing to answer when it cannot be determined.

    ``lstat`` rather than ``exists``: only absence may answer "no". A denying ACL or an I/O error means
    the question is unanswerable, and reporting "absent" there is what turns a guard into a hazard - the
    caller's next move is to write the file it just decided was missing.
    """
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    return True


def scaffold_workspace(workspace: Path) -> None:
    """Create the workspace and its default runtime configuration, as the owner.

    This used to be the orchestrator's first act (``ensureWorkspace``), and it moved here for three
    reasons. The workspace and its default ``opencode.jsonc`` are user-visible artifacts, so they should
    be owned by the user rather than by whichever sandbox account happened to create them. No isolation
    tier then needs a workspace *creation* grant it would otherwise have to be given. And if the runtime
    reads ``opencode.jsonc`` at startup, scaffolding has to precede *every* role - an ordering that only
    a step outside all of them can provide, which is what this is.

    Never overwrites. The exclusive-create mode is what guarantees that rather than the check above it:
    the check decides whether to write ``.jsonc`` when ``.json`` already answers for the workspace, and
    ``"x"`` makes losing a race with a concurrent creator harmless instead of destructive.
    """
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "tmp").mkdir(parents=True, exist_ok=True)  # agent scratch (TEMP/TMP)
    if any(_path_present(workspace / name) for name in _WORKSPACE_CONFIG_NAMES):
        return
    try:
        with open(
            workspace / "opencode.jsonc", "x", encoding="utf-8", newline="\n"
        ) as handle:
            handle.write(_DEFAULT_WORKSPACE_CONFIG)
    except FileExistsError:
        return


# --------------------------------------------------------------------------- lifecycle


def _pause(seconds: float) -> None:
    time.sleep(seconds)


class NativeBackendLifecycle:
    """The SANDBOX lifecycle behind ``app.state.lifecycle``.

    Implements the surface api/v1/sandbox.py actually calls: ``ensure_ready()``,
    ``control(action)``, ``shutdown()`` — plus ``status()`` for
    ``GET /agent/sandbox``.
    """

    def __init__(
        self,
        *,
        cfg: Any,
        store: Any,
        run_manager: RunManager,
        owt_cache: Any,
        tavily_api_key_store: Any | None = None,
        egress_approval_broker: Any | None = None,
        channel_credentials: Any | None = None,
        control_audit: Any | None = None,
    ):
        self._cfg = cfg
        self._store = store
        self._runs = run_manager
        self._owt = owt_cache
        self._state_dir = default_state_dir()
        self._port = int(getattr(cfg, "sandbox_port", 8787))
        self._proc: BrokerLaunch | None = None
        self._connector_proc: BrokerLaunch | None = None
        self._egress_proxy_proc: BrokerLaunch | None = None
        self._hdr_proc: BrokerLaunch | None = None
        self._runtime_proc: BrokerLaunch | None = None
        self._router_proc: BrokerLaunch | None = None
        self._openwork_server_proc: BrokerLaunch | None = None
        self._connector_port: int | None = None
        self._egress_proxy_shell_port: int | None = None
        self._egress_proxy_channel_port: int | None = None
        self._egress_proxy_asks = False
        # The host's one upstream proxy, read once per start for the proxy, the Connector and the bypass list.
        self._upstream: UpstreamProxy | None = None
        self._hdr_port: int | None = None
        self._runtime_port: int | None = None
        self._router_health_port: int | None = None
        self._runtime_launch_context: dict[str, str] | None = None
        self._runtime_evidence_path: Path | None = None
        self._connector_config: dict[str, Any] | None = None
        self._hdr_api_token: str | None = None
        self._hdr_ready_token: str | None = None
        self._required_sidecars: frozenset[str] = frozenset()
        self._hdr_health_observation: tuple[tuple[Any, ...], float, bool] | None = None
        self._hdr_status_task: asyncio.Task[bool] | None = None
        self._hdr_status_generation = 0
        self._hdr_status_lock = threading.Lock()
        self._connector_client_config_path: Path | None = None
        self._connector_provider_config_path: Path | None = None
        self._runtime_settings_path: Path | None = None
        self._connector_audit_log_path: Path | None = None
        self._tavily_api_key_store: Any | None = None
        self._egress_approval_broker: Any | None = None
        self._channel_credentials: Any | None = channel_credentials
        self._control_audit: Any | None = control_audit
        self._host_token: str | None = None
        self._openwork_token: str | None = None
        self._payload_root: Path | None = None
        self._owner_sid: str | None = None
        self._payload_status_message: str | None = None
        self._payload_failure: PayloadFailure | None = None
        self._payload_integrity_failed = False
        self._termination_unconfirmed = False
        self._lock = asyncio.Lock()
        self._shutdown_requested = threading.Event()
        self._startup_abort = threading.Event()
        self._connector_config_io_lock = threading.RLock()
        self._generation_prune = GenerationPrune(self._shutdown_requested.is_set, self._raise_if_shutdown_requested)
        # Host-side trajectory inspector (debug tool). Brought up after the
        # backend reaches Ready when SUPERCLAW_DEBUG_OBSERVABILITY=1; idempotent.
        self._inspector = TrajectoryInspector(cfg)
        self._inspector_task: asyncio.Task[None] | None = None
        from .native_deployment import NativeDeployment
        from .native_supervision import NativeSupervision

        self._deployment_adapter = NativeDeployment(self)
        self._supervision = NativeSupervision(self)
        if tavily_api_key_store is not None:
            self.use_tavily_api_key_store(tavily_api_key_store)
        if egress_approval_broker is not None:
            self.use_egress_approval_broker(egress_approval_broker)

    def use_channel_credentials(self, service: Any) -> None:
        """Take the host's channel credential service, attached to the router while the roles run (EG2-6)."""
        self._channel_credentials = service

    def _attach_channel_credentials(self, prepared: Any, router_control_token: str) -> None:
        """Tell the credential service where the router's config is and how to reach the running router.

        The config sits in the channel tier's data directory, where the router reads it and no tier that
        runs the agent can; the host writes it as the owner. The service is let go of when the roles stop,
        so a save with no router to tell about is refused rather than half done.
        """
        service = self._channel_credentials
        if service is None or self._router_health_port is None:
            return
        service.attach(
            config_path=Path(prepared.path_set.data_root) / ROUTER_CONFIG_RELATIVE_PATH,
            router_port=self._router_health_port,
            control_token=router_control_token,
            workspace=_workspace_dir(),
        )

    def use_egress_approval_broker(self, broker: Any) -> None:
        """Tell the Connector this start's approval key, boot id and admin secret, and ask it what it holds.

        The section goes into the sealed provider config, so it is the same across a re-seal for a new Tavily
        key; the broker is pointed at the Connector once the Connector is launched, and let go of when the
        roles stop (EG1-7, design 6.3).
        """
        self._egress_approval_broker = broker

    def use_tavily_api_key_store(self, store: Any) -> None:
        """Take the Tavily API key from the host's store, and re-seal the Connector's copy when it changes.

        Settings saves the key through the host (EG1-3, #12), not into openwork-server's runtime settings.
        A change while the backend is stopped waits for the next start, which seals the config anyway.
        """
        self._tavily_api_key_store = store
        store.subscribe(self._reseal_connector_provider_config)

    def _reseal_connector_provider_config(self) -> None:
        with self._connector_config_io_lock:
            destination = self._connector_provider_config_path
            audit_log = self._connector_audit_log_path
            store = self._tavily_api_key_store
            if destination is None or audit_log is None or store is None:
                return
            tavily_key = self._stored_tavily_key(store)
            for pause in (*_RESEAL_PAUSES_S, None):
                try:
                    self._seal_connector_provider_config(destination, tavily_key, audit_log)
                    return
                except OSError as exc:
                    # The Connector reads this file, and on Windows a replace fails while it is open.
                    if pause is None:
                        logger.error(
                            "native-backend: connector provider config event=reseal outcome=failed "
                            "exception_type={}; the Connector keeps the key it had until the backend restarts",
                            type(exc).__name__,
                        )
                        return
                    _pause(pause)

    def _start_broker_roles(self, prepared: Any) -> None:
        """Start the profile-governed broker roles; unwind independent Jobs in reverse."""
        owner_sid = prepared.path_set.owner_sid
        payload_root, verified_payload = self._trust_payload(
            prepared.payload.payload_root,
            phase="pre_spawn",
        )
        if verified_payload.payload_version != prepared.payload.payload_version:
            self._raise_payload_failure(
                phase="pre_spawn", reason="verified_payload_changed"
            )
        self._generation_prune.join(check=self._raise_if_shutdown_requested)
        common = {
            "owner_sid": owner_sid,
            "payload_root": payload_root,
            "verified_payload": verified_payload,
            "policy": prepared.policy,
            # One per start, so roles launched together answer one drift with one elevated repair.
            "provision_repair": ProvisionRepair(),
        }
        launch_role_logged = partial(start_role_logged, start_role)
        started: list[BrokerLaunch] = []
        try:
            self._raise_if_shutdown_requested()
            runtime_launch_context = self._runtime_launch_context
            if runtime_launch_context is None:
                raise RuntimeError("Runtime launch context was not prepared before role start")
            self._runtime_evidence_path = Path(prepared.path_set.data_root) / "bootstrap" / "runtime" / "runtime-instance-evidence.json"
            self._connector_client_config_path = (
                Path(prepared.path_set.config_root)
                / "file_tool"
                / "superclaw"
                / "connector-client.json"
            )
            self._connector_provider_config_path = (
                Path(prepared.path_set.config_root)
                / "network_connector"
                / "superclaw"
                / "connector-provider.json"
            )
            # Where Settings saved the Tavily API key: openwork-server's own
            # `SC_RUNTIME_CONFIG_DIR`, declared on `token_service_executable` in the broker's
            # role catalog. The two must name the same directory - a read path that does not
            # match the write path is a key that reaches nothing, which is issue #2648.
            #
            # Deliberately not the per-generation
            # `bootstrap/runtime-generations/<id>/opencode` directory this used to read: that
            # tree is rebuilt under a fresh instance id on every boot, so a key saved into it
            # could not survive a restart even if something wrote it there.
            self._runtime_settings_path = (
                Path(prepared.path_set.data_root)
                / "file_tool"
                / "superclaw"
                / "runtime"
                / "superclaw-runtime-config.json"
            )
            for stale in (
                self._connector_client_config_path,
                self._connector_provider_config_path,
            ):
                stale.unlink(missing_ok=True)
            dynamic_range = tcp_dynamic_port_range()
            # openwork-server listens on its configured port only once the supervisor starts it.
            reserved = frozenset({self._port})
            self._runtime_port = allocate_fixed_port(
                "runtime_port", dynamic_range=dynamic_range, reserved=reserved
            )
            self._router_health_port = allocate_fixed_port(
                "router_health_port", dynamic_range=dynamic_range, reserved=reserved
            )
            hdr_enabled = "hdr-sidecar" in self._required_sidecars
            # The broker wants an hdr_port scalar for every role; a Profile without hdr-sidecar never
            # listens on it, so it takes the first contract candidate unprobed and cannot fail to start.
            self._hdr_port = (
                allocate_fixed_port("hdr_port", dynamic_range=dynamic_range, reserved=reserved)
                if hdr_enabled
                else EGRESS_LOOPBACK_PORT_RULES["fixed_port_candidates"]["hdr_port"][0]
            )
            self._hdr_api_token = secrets.token_urlsafe(32)
            self._hdr_ready_token = secrets.token_urlsafe(32)
            if self._hdr_ready_token == self._hdr_api_token:
                raise RuntimeError("HDR tokens must be distinct")
            # Runtime's Basic-auth password, for the four roles that call it. Local on purpose:
            # a role-set restart mints a new one, and a per-role retry reuses these scalars.
            runtime_password = secrets.token_urlsafe(32)
            intent_classifier_token = secrets.token_urlsafe(32)
            lrm_api_key = resolve_lrm_api_key(self._store)
            privacy_api_key = resolve_privacy_api_key(managed=self._cfg.managed)
            shared_service_scalars = {
                "loopback_host": "127.0.0.1",
                "supervisor_port": self._port,
                "runtime_port": self._runtime_port,
                "router_health_port": self._router_health_port,
                "host_token": self._host_token or "",
                "openwork_token": self._openwork_token or "",
                "runtime_password": runtime_password,
                "intent_classifier_token": intent_classifier_token,
            }
            self._prune_role_logs(prepared.path_set.logs_root, "bootstrap")
            self._proc = launch_role_logged(
                role="supervisor_executable",
                scalars={
                    **shared_service_scalars,
                    **runtime_launch_context,
                    "hdr_enabled": "1" if hdr_enabled else "0",
                    "hdr_port": self._hdr_port,
                    "hdr_ready_token": self._hdr_ready_token,
                    "llmrouter_port": _LLMROUTER_PORT,
                    "lrm_api_key": lrm_api_key,
                },
                **common,
            )
            started.append(self._proc)
            # The Connector reads nothing the supervisor publishes - its provider source is the
            # settings file above and its search module was projected during staging - so it starts
            # while the supervisor publishes. Both Connector configs are sealed before Runtime starts.
            self._connector_port = allocate_fixed_port(
                "connector_port", dynamic_range=dynamic_range, reserved=reserved
            )
            connector_audit_log = (
                Path(prepared.path_set.logs_root)
                / "network_connector"
                / _CONNECTOR_AUDIT_FILE_NAME
            )
            self._upstream = resolve_upstream(self._resolve_proxy_setting, read_system_proxy())
            self._write_connector_provider_config(
                self._connector_provider_config_path,
                runtime_config=self._runtime_settings_path,
                audit_log=connector_audit_log,
            )
            self._prune_role_logs(
                prepared.path_set.logs_root, "network_connector"
            )
            self._rotate_audit_log(connector_audit_log)
            self._connector_proc = launch_role_logged(
                role="connector_service",
                scalars={
                    "loopback_host": "127.0.0.1",
                    "connector_port": self._connector_port,
                },
                **common,
            )
            started.append(self._connector_proc)
            if self._egress_approval_broker is not None:
                self._egress_approval_broker.attach(self._connector_port)
            if self._connector_proc.connector_config is None:
                raise RuntimeError("Connector launcher returned no client configuration")
            self._connector_config = self._connector_proc.connector_config.model_dump(mode="json")
            self._write_connector_client_config(
                self._connector_client_config_path
            )
            self._egress_proxy_shell_port = allocate_fixed_port(
                "egress_proxy_shell_port", dynamic_range=dynamic_range, reserved=reserved
            )
            self._egress_proxy_channel_port = allocate_fixed_port(
                "egress_proxy_channel_port", dynamic_range=dynamic_range, reserved=reserved
            )
            proxy_audit_log = (
                Path(prepared.path_set.logs_root) / "network_connector" / _PROXY_AUDIT_FILE_NAME
            )
            self._write_egress_proxy_config(
                Path(prepared.path_set.config_root)
                / "network_connector"
                / "superclaw"
                / _EGRESS_PROXY_CONFIG_FILE_NAME,
                audit_log=proxy_audit_log,
            )
            self._rotate_audit_log(proxy_audit_log)
            self._egress_proxy_proc = launch_role_logged(
                role="egress_proxy",
                scalars={
                    "loopback_host": "127.0.0.1",
                    "egress_proxy_shell_port": self._egress_proxy_shell_port,
                    "egress_proxy_channel_port": self._egress_proxy_channel_port,
                },
                **common,
            )
            started.append(self._egress_proxy_proc)
            self._raise_if_shutdown_requested()
            self._wait_for_runtime_generation(
                Path(prepared.path_set.config_root),
                runtime_launch_context["runtime_instance_id"],
            )
            self._raise_if_shutdown_requested()
            self._prune_role_logs(prepared.path_set.logs_root, "file_tool")
            # The router's inbox and outbox, its agent definition, and an earlier release's identities, all made or
            # carried over here as the owner, because the channel tier can write none of them itself.
            prepare_channel_tier(
                data_root=Path(prepared.path_set.data_root),
                config_root=Path(prepared.path_set.config_root),
                workspace=_workspace_dir(),
                audit=self._control_audit,
            )
            # The router refuses to start its health server without a control token. That one is the admin
            # bearer: this process keeps a copy and the router gets one, and no tier that runs the agent.
            # openwork-server and Runtime get the scoped bearer, which reads status and sends and nothing
            # else (EG2-7).
            router_control_token = secrets.token_urlsafe(32)
            router_scoped_token = secrets.token_urlsafe(32)
            # The key, boot id and admin secret the router checks approvals against, sealed into its own
            # config before it starts; with no broker the section is removed rather than left stale.
            seal_router_approval(
                Path(prepared.path_set.data_root),
                self._egress_approval_broker.provider_config("router")
                if self._egress_approval_broker is not None
                else None,
            )

            def adopt(role: str, launch: BrokerLaunch) -> None:
                setattr(self, dict(_BROKER_ROLE_FIELDS)[role], launch)
                started.append(launch)

            # Neither carrier of general egress starts without its proxy: there is no direct form. The
            # shell port serves Runtime and openwork-server, the channel port the router.
            self._wait_for_egress_proxy_ready()
            if self._egress_proxy_asks and self._egress_approval_broker is not None:
                self._egress_approval_broker.attach(self._egress_proxy_shell_port, "egress_proxy")
            local_proxy_bypass = self._current_upstream().no_proxy
            shell_proxy = {
                "local_proxy_url": local_proxy_url(self._egress_proxy_shell_port),
                "local_proxy_bypass": local_proxy_bypass,
            }
            channel_proxy = {
                "local_proxy_url": local_proxy_url(self._egress_proxy_channel_port),
                "local_proxy_bypass": local_proxy_bypass,
            }
            # None of these three reads a port, token or file another of them produces - the ports and
            # tokens are minted above - and none needs another listening when it starts: launched one
            # after another, they never were. What they read is in place: the publication and the
            # Connector client config. That includes HDR on pro: Runtime and openwork-server only call
            # it for a tool or a progress read, never at start, so HDR starts with them and is waited
            # on below, once all are in flight. It leads the list, so a refusal from it is the one raised
            # when more than one fails - the one the serial start it replaced would have stopped at.
            hdr_roles = []
            if hdr_enabled:
                hdr_roles.append(("hdr_sidecar", {
                    "loopback_host": "127.0.0.1",
                    "hdr_port": self._hdr_port,
                    "llmrouter_port": _LLMROUTER_PORT,
                    "hdr_api_token": self._hdr_api_token,
                    "lrm_api_key": lrm_api_key,
                    "hdr_ready_token": self._hdr_ready_token,
                }))
            start_roles_concurrently(
                (
                    *hdr_roles,
                    ("runtime_executable", {
                        "loopback_host": "127.0.0.1",
                        "runtime_port": self._runtime_port,
                        "runtime_instance_id": runtime_launch_context["runtime_instance_id"],
                        # The role's Product Profile names the model endpoint as a URL, so the port has
                        # to reach it.
                        "llmrouter_port": _LLMROUTER_PORT,
                        "lrm_api_key": lrm_api_key,
                        "privacy_api_key": privacy_api_key,
                        "hdr_enabled": "1" if hdr_enabled else "0",
                        "hdr_port": self._hdr_port,
                        "hdr_api_token": self._hdr_api_token,
                        "runtime_password": runtime_password,
                        # The managed send and status tools call the router from here: its port and the
                        # scoped token, never the control token.
                        "router_health_port": self._router_health_port,
                        "router_scoped_token": router_scoped_token,
                        **shell_proxy,
                        # openwork-server's port: the Gmail tools' OAuth callback is built on it (EG1-8).
                        "supervisor_port": self._port,
                    }),
                    ("connector_executable", {
                        "loopback_host": "127.0.0.1",
                        "runtime_port": self._runtime_port,
                        "router_health_port": self._router_health_port,
                        "router_control_token": router_control_token,
                        "router_scoped_token": router_scoped_token,
                        "runtime_password": runtime_password,
                        "intent_classifier_token": intent_classifier_token,
                        # Slack and Telegram leave through the proxy's channel port.
                        **channel_proxy,
                    }),
                    ("token_service_executable", {
                        **shared_service_scalars,
                        "router_scoped_token": router_scoped_token,
                        "privacy_api_key": privacy_api_key,
                        "hdr_enabled": "1" if hdr_enabled else "0",
                        "hdr_port": self._hdr_port,
                        "hdr_api_token": self._hdr_api_token,
                        # Runtime's generation, so openwork-server lists the tools and skills
                        # of the Profile Runtime actually runs (#2985).
                        "runtime_instance_id": runtime_launch_context["runtime_instance_id"],
                        # GitHub sign-in, the skill hub and the Telegram token check go out through the
                        # proxy's shell port, as Runtime's egress does.
                        **shell_proxy,
                    }),
                ),
                start=lambda role, scalars: launch_role_logged(role=role, scalars=scalars, **common),
                adopt=adopt,
            )
            if hdr_enabled:
                self._wait_for_hdr_ready()
            self._attach_channel_credentials(prepared, router_control_token)
            if self._egress_approval_broker is not None and self._router_health_port is not None:
                self._egress_approval_broker.attach(self._router_health_port, "router")
            self._payload_root = payload_root
        except Exception:
            try:
                self._stop_broker_roles()
            finally:
                self._runtime_launch_context = None
                self._host_token = None
                self._openwork_token = None
            raise

    def _supervisor_ready(self) -> bool:
        from .native_runtime_evidence import supervisor_ready

        return self._broker_roles_complete_and_alive() and supervisor_ready(
            self._runtime_evidence_path, self._runtime_launch_context
        )

    def _deployment_still_current(self) -> bool:
        from .native_runtime_evidence import deployment_snapshot, fingerprint

        if self._runtime_launch_context is None:
            return False
        try:
            current = deployment_snapshot(self._store.get_config(RUNTIME_DEPLOYMENT_CONFIG_KEY))
            return fingerprint(current) == self._runtime_launch_context["runtime_desired_fingerprint"]
        except (RuntimeError, OSError, ValueError):
            return False

    def _wait_for_runtime_generation(self, config_root: Path, instance_id: str) -> None:
        from contracts.runtime_generation_published import RuntimeGenerationPublished
        from pydantic import ValidationError

        context = self._runtime_launch_context
        if context is None or context["runtime_instance_id"] != instance_id:
            raise RuntimeError("Runtime launch context does not match the requested generation")
        deployment = json.loads(base64.b64decode(context["runtime_deployment_b64"], validate=True))
        expected = {
            "schema_version": 1,
            "status": "published",
            "deployment_id": deployment["deployment_id"],
            "desired_fingerprint": context["runtime_desired_fingerprint"],
            "runtime_instance_id": instance_id,
            "launch_attempt_id": context["runtime_launch_attempt_id"],
            "product_profile_id": deployment["product_profile_id"],
            "product_profile_digest": deployment["product_profile_digest"],
            "profile_revision": deployment["profile_revision"],
        }
        marker = (
            config_root
            / "bootstrap"
            / "runtime-generations"
            / instance_id
            / "generation-published.json"
        )
        deadline = time.monotonic() + _HEALTH_TIMEOUT_S
        started_at = time.monotonic()
        logger.info(
            "native-backend: publication wait instance={} attempt={} timeout_s={}",
            instance_id, context["runtime_launch_attempt_id"], _HEALTH_TIMEOUT_S,
        )
        observed_at = time.monotonic()
        while observed_at < deadline:
            self._raise_if_shutdown_requested()
            if self._proc is None or self._proc.poll() is not None:
                raise RuntimeError(
                    "Supervisor exited before publishing the Runtime generation"
                )
            try:
                if marker.is_symlink():
                    raise RuntimeError("Runtime generation publication must be a regular file")
                with marker.open("rb") as stream:
                    payload = stream.read(4097)
            except (FileNotFoundError, PermissionError):  # Windows denies opens while delete-pending or mid-replace
                time.sleep(_HEALTH_POLL_S)
                observed_at = time.monotonic()
                continue
            if len(payload) > 4096:
                raise RuntimeError("Runtime generation publication exceeds the size limit")
            try:
                published = RuntimeGenerationPublished.model_validate_json(payload, strict=True)
            except ValidationError:
                raise RuntimeError("Runtime generation publication has an invalid shape") from None
            if published.model_dump(mode="json") != expected:
                raise RuntimeError("Runtime generation publication does not match this launch")
            if self._proc.poll() is not None:
                raise RuntimeError("Supervisor exited while publishing the Runtime generation")
            logger.info("native-backend: publication confirmed instance={}", instance_id)
            return
        logger.error(
            "native-backend: publication timeout instance={} attempt={}; "
            "elapsed_ms={} marker_exists={} marker_is_file={} supervisor_launcher_code={}; "
            "inspect matching PUBLICATION_DIAG in bootstrap logs",
            instance_id,
            context["runtime_launch_attempt_id"],
            round((observed_at - started_at) * 1000),
            marker.exists(),
            marker.is_file(),
            None if self._proc is None else self._proc.poll(),
        )
        raise RuntimeError("Supervisor did not publish the Runtime generation in time")

    def _runtime_launch_context_scalars(self, deployment: dict[str, object] | None = None) -> dict[str, str]:
        if deployment is None:
            deployment = self._store.get_config(RUNTIME_DEPLOYMENT_CONFIG_KEY)
        if not isinstance(deployment, dict):
            raise RuntimeError("committed Runtime Deployment is unavailable")
        encoded_json = json.dumps(
            deployment,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode("utf-8")
        import hashlib

        return {
            "runtime_deployment_b64": base64.b64encode(encoded_json).decode("ascii"),
            "runtime_desired_fingerprint": hashlib.sha256(encoded_json).hexdigest(),
            "runtime_instance_id": f"runtime-instance-{secrets.token_hex(16)}",
            "runtime_launch_attempt_id": f"runtime-attempt-{secrets.token_hex(16)}",
        }

    @staticmethod
    def _required_sidecars_for_profile(profile_source: Path, expected_profile: str) -> frozenset[str]:
        from contracts.product_profile_descriptor import ProductProfileDescriptor
        from pydantic import ValidationError

        descriptor_path = profile_source / "profile.json"
        if descriptor_path.is_symlink() or not descriptor_path.is_file():
            raise RuntimeError("Product Profile descriptor must be a regular file")
        payload = descriptor_path.read_bytes()
        if not payload or len(payload) > 64 * 1024:
            raise RuntimeError("Product Profile descriptor is outside the size limit")
        try:
            descriptor = ProductProfileDescriptor.model_validate_json(payload, strict=True)
        except ValidationError:
            raise RuntimeError("Product Profile descriptor has an invalid shape") from None
        if descriptor.profile.value != expected_profile:
            raise RuntimeError("Product Profile descriptor does not match the deployment")
        required = frozenset(item.value for item in descriptor.required_sidecars)
        if descriptor.feature_flags.hybrid_deep_research_agent != ("hdr-sidecar" in required):
            raise RuntimeError("Product Profile HDR feature and required sidecar disagree")
        if descriptor.feature_flags.intent_classifier != ("intent-classifier" in required):
            raise RuntimeError("Product Profile classifier feature and required sidecar disagree")
        return required

    def _wait_for_egress_proxy_ready(self) -> None:
        """Both listeners accepting; a probe sends nothing, so the proxy audits no request for it."""
        proc = self._egress_proxy_proc
        wait_for_listeners(
            (self._egress_proxy_shell_port, self._egress_proxy_channel_port),
            process_alive=lambda: proc is not None and proc.poll() is None,
            check_shutdown=self._raise_if_shutdown_requested,
            timeout_s=_HEALTH_TIMEOUT_S,
        )

    def _wait_for_hdr_ready(self) -> None:
        deadline = time.monotonic() + _HEALTH_TIMEOUT_S
        while time.monotonic() < deadline:
            self._raise_if_shutdown_requested()
            if self._hdr_proc is None or self._hdr_proc.poll() is not None:
                raise RuntimeError("HDR sidecar exited before readiness")
            # Launch runs on a worker thread, never the API event loop.
            if asyncio.run(self._hdr_healthy()):
                return
            time.sleep(_HEALTH_POLL_S)
        raise RuntimeError("HDR sidecar did not become ready in time")

    async def _probe_hdr_readiness(self) -> bool:
        if self._startup_abort.is_set() or self._shutdown_requested.is_set():
            return False
        if "hdr-sidecar" not in self._required_sidecars:
            return self._hdr_proc is None
        context = self._hdr_health_context()
        proc = self._hdr_proc
        port = self._hdr_port
        token = self._hdr_ready_token
        if proc is None or proc.poll() is not None or port is None or token is None:
            return False
        try:
            deadline = time.monotonic() + _HDR_READY_TIMEOUT_S
            async with asyncio.timeout(_HDR_READY_TIMEOUT_S):
                async with httpx.AsyncClient(trust_env=False, timeout=_HDR_READY_TIMEOUT_S) as client:
                    async with client.stream(
                        "GET", f"http://127.0.0.1:{port}/readyz",
                        headers={"Authorization": f"Bearer {token}"},
                    ) as response:
                        if response.status_code != 200:
                            return False
                        body = bytearray()
                        # Bound raw bytes before buffering or decompression.
                        async for chunk in response.aiter_raw():
                            if time.monotonic() >= deadline or len(body) + len(chunk) > 4096:
                                return False
                            body.extend(chunk)

                        def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
                            result = dict(pairs)
                            if len(result) != len(pairs):
                                raise ValueError("duplicate readiness key")
                            return result

                        ready = json.loads(body.decode("utf-8"), object_pairs_hook=unique_object) == {
                            "status": "ready", "mode": "native_managed",
                        }
            return (ready and time.monotonic() < deadline
                    and context == self._hdr_health_context() and proc.poll() is None)
        except (TimeoutError, httpx.HTTPError, ValueError, RecursionError):
            return False

    async def _hdr_healthy(self, generation: int | None = None) -> bool:
        generation = self._hdr_status_generation if generation is None else generation
        context = self._hdr_health_context()
        healthy = await self._probe_hdr_readiness()
        with self._hdr_status_lock:
            if (generation != self._hdr_status_generation
                    or context != self._hdr_health_context()):
                return False
            self._hdr_health_observation = (context, time.monotonic(), healthy)
        if healthy:
            # A recovery seen here ends the miss window too, not only one seen by evidence (#3658).
            self._deployment_adapter.hdr_ready_again()
        return healthy

    def _hdr_health_context(self) -> tuple[Any, ...]:
        return (self._hdr_proc, self._hdr_port, self._hdr_api_token, self._hdr_ready_token,
            self._required_sidecars,
            tuple(sorted((self._runtime_launch_context or {}).items())),
            self._startup_abort.is_set(), self._shutdown_requested.is_set())

    def _hdr_status_health(self) -> bool | None:
        """Bounded-age observation only; status() also runs on the API event loop.

        Public ensure/evidence always probe afresh. A synchronous status caller
        cannot await HTTP: expired or missing observations are pending, never
        inferred healthy from a live launcher or the Supervisor's ready file.
        """
        if self._startup_abort.is_set() or self._shutdown_requested.is_set():
            return False
        if "hdr-sidecar" not in self._required_sidecars:
            return self._hdr_proc is None
        if self._hdr_proc is None or self._hdr_proc.poll() is not None:
            return False
        observation = self._hdr_health_observation
        age = (time.monotonic() - observation[1]
               if observation is not None and observation[0] == self._hdr_health_context()
               else float("inf"))
        health = observation[2] if observation is not None and age < _HDR_STATUS_FRESHNESS_S else None
        if age < _HDR_STATUS_REFRESH_S:
            return health
        if not self._startup_abort.is_set() and not self._shutdown_requested.is_set():
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                return health
            if self._hdr_status_task is None or self._hdr_status_task.done():
                generation = self._hdr_status_generation
                self._hdr_status_task = loop.create_task(self._hdr_healthy(generation))
                self._hdr_status_task.add_done_callback(self._drain_hdr_status_task)
        return health

    def _drain_hdr_status_task(self, task: asyncio.Task[bool]) -> None:
        if self._hdr_status_task is task:
            self._hdr_status_task = None
        if not task.cancelled() and task.exception() is not None:
            logger.warning("native-backend: HDR status probe failed")

    def _detach_hdr_status_task(self) -> None:
        """Fence an in-flight observation without cancelling it from a worker thread."""
        with self._hdr_status_lock:
            self._hdr_status_generation += 1
            self._hdr_status_task = None
            self._hdr_health_observation = None

    @staticmethod
    def _prune_role_logs(logs_root: str, tier: str) -> None:
        try:
            outcomes = prune_native_isolation_logs(Path(logs_root), [tier])
            outcome = outcomes[tier]
            if outcome.failed:
                logger.warning(
                    "native-backend: role log retention incomplete tier={} failed_count={}",
                    tier,
                    len(outcome.failed),
                )
        except Exception as exc:  # noqa: BLE001 - retention never blocks launch
            logger.warning(
                "native-backend: role log retention failed tier={} exception_type={}",
                tier,
                type(exc).__name__,
            )

    @staticmethod
    def _rotate_audit_log(path: Path) -> None:
        try:
            rotate_audit_log(path)
        except OSError as exc:  # retention never blocks launch
            logger.warning(
                "native-backend: audit log rotation failed file={} exception_type={}",
                path.name,
                type(exc).__name__,
            )

    def _stop_broker_roles(self) -> None:
        if self._channel_credentials is not None:
            self._channel_credentials.detach()
        if self._egress_approval_broker is not None:
            self._egress_approval_broker.detach()
        self._detach_hdr_status_task()
        intent_recorded = self._supervision.record_cleanup_intent()
        failures = stop_launches_by_identity(
            [(role, name, getattr(self, name)) for role, name in reversed(_BROKER_ROLE_FIELDS)],
            timeout=_PROCESS_STOP_TIMEOUT_S,
        )
        for _role, name in _BROKER_ROLE_FIELDS:
            if name not in failures:
                setattr(self, name, None)
        self._runtime_port = None
        self._connector_port = None
        self._egress_proxy_shell_port = None
        self._egress_proxy_channel_port = None
        self._egress_proxy_asks = False
        self._upstream = None
        self._hdr_port = None
        self._hdr_api_token = None
        self._hdr_ready_token = None
        self._router_health_port = None
        self._connector_config = None
        self._remove_connector_config_files()
        self._connector_client_config_path = None
        self._connector_provider_config_path = None
        self._runtime_evidence_path = None
        self._required_sidecars = frozenset()
        if failures:
            self._termination_unconfirmed = True
            self._payload_integrity_failed = True
            # Keep the failure that caused this stop (a reuse-time integrity failure,
            # say) visible rather than replacing it with the cleanup outcome.
            prior = self._payload_status_message
            self._payload_status_message = (
                f"{prior}; cleanup=termination_unconfirmed recovery=retry_stop"
                if prior is not None and "termination_unconfirmed" not in prior
                else (
                    "native backend termination failure "
                    "reason=termination_unconfirmed recovery=retry_stop"
                )
            )
            logger.error(
                "native-backend: role lifecycle phase=stop event=termination_unconfirmed "
                "roles={}",
                ",".join(failures),
            )
            raise RuntimeError(self._payload_status_message)
        self._termination_unconfirmed = False
        if intent_recorded:
            self._supervision.clear_cleanup_intent()

    def _broker_role_launches(self) -> tuple[tuple[str, Any], ...]:
        return tuple(
            (role, getattr(self, field)) for role, field in _BROKER_ROLE_FIELDS
            if role != "hdr_sidecar" or "hdr-sidecar" in self._required_sidecars
            or self._hdr_proc is not None
        )

    def _broker_roles_complete_and_alive(self) -> bool:
        if "hdr-sidecar" not in self._required_sidecars and self._hdr_proc is not None:
            return False
        return all(
            launch is not None and launch.poll() is None
            for _role, launch in self._broker_role_launches()
        )

    def _has_broker_roles(self) -> bool:
        return self._runtime_evidence_path is not None or any(
            launch is not None for _role, launch in self._broker_role_launches()
        )

    def _raise_if_broker_role_exited(self) -> None:
        for role, launch in self._broker_role_launches():
            if launch is None:
                raise RuntimeError(f"native backend role set is incomplete: {role}")
            code = launch.poll()
            if code is not None:
                logger.error(
                    "native-backend: role lifecycle phase=health event=launcher_exited "
                    "role={} role_pid={} launcher_code={}",
                    role,
                    launch.pid,
                    code,
                )
                raise RuntimeError(f"native backend role exited early: {role} code={code}")

    # ------------------------------------------------------------- public: status

    def status(self) -> dict[str, Any]:
        # The current run's broker refusal, wherever in the start it came from: the deployment adapter
        # records it for the whole run, so a refusal `start_role` raises needs no handling of its own here.
        refusal = self._deployment_adapter.refusal
        if (
            self._payload_integrity_failed or self._termination_unconfirmed
        ) and self._payload_status_message is not None:
            message = self._payload_status_message
            return error_status(message, self._payload_failure, (refusal, message) if refusal else None)
        recovery = self._supervision.status_override()
        if recovery is not None:
            return recovery
        if refusal is not None:
            # A refusal while the roles start leaves no status message; this one carries only the word.
            message = f"native backend start refused reason={refusal} recovery=retry"
            return error_status(message, None, (refusal, message))
        broker_running = self._broker_roles_complete_and_alive()
        if "hdr-sidecar" not in self._required_sidecars and self._hdr_proc is not None:
            return {"phase": "error", "mode": "native", "message": "unexpected native HDR role; recovery=restart_required"}
        if self._runtime_evidence_path is not None and any(
            launch is not None and launch.poll() is not None
            for _role, launch in self._broker_role_launches()
        ):
            return {"phase": "error", "mode": "native", "message": "native backend role exited; recovery=restart_required"}
        if self._runtime_evidence_path is not None and not self._supervisor_ready():
            return {"phase": "starting", "mode": "native", "message": "waiting for current Supervisor readiness"}
        if broker_running:
            hdr_health = self._hdr_status_health()
            if hdr_health is None:
                return {"phase": "starting", "mode": "native", "message": "waiting for current HDR readiness"}
            if not hdr_health:
                return {"phase": "error", "mode": "native", "message": "native HDR is not ready; recovery=restart_required"}
            result: dict[str, Any] = {
                "phase": "running",
                "pid": self._proc.pid,
                "mode": "native",
            }
            if self._payload_status_message is not None:
                result["message"] = self._payload_status_message
            return result
        if self._has_broker_roles():
            return {
                "phase": "error",
                "mode": "native",
                "message": "native backend role set incomplete; recovery=restart_required",
            }
        if self._read_lockfile() is not None:
            return {
                "phase": "stopped",
                "mode": "native",
                "message": (
                    "native backend lockfile is diagnostic only; "
                    "recovery=restart_required"
                ),
            }
        if resolve_bin_dir(getattr(self._cfg, "resources_dir", None)) is None:
            return {"phase": "missing", "mode": "native", "message": "native backend binaries not found"}
        result = {"phase": "stopped", "mode": "native"}
        if self._payload_status_message is not None:
            result["message"] = self._payload_status_message
        return result

    # ------------------------------------------------------------- public: ensure_ready

    async def ensure_ready(self) -> str:
        return (await self.ensure_runtime_deployment())[0]

    async def ensure_runtime_deployment(self) -> tuple[str, str, str, str, str]:
        return await self._deployment_adapter.ensure()

    async def prepare_runtime_infrastructure(self) -> str:
        return await self._deployment_adapter.prepare()

    async def revoke_runtime_deployment(self, deployment: dict[str, object]) -> str:
        return await self._deployment_adapter.revoke(deployment)

    async def rearm_after_provision_refusal(self) -> bool:
        """Let an explicit user Retry ask again after a refused or declined provision.

        A failed deployment is not relaunched for the same fingerprint, so a Retry that reached
        `ensure` would only be told it had failed again. Only a run that a broker refusal failed is
        re-armed, and only once it has finished, so another failure keeps its own handling.
        """
        adapter = self._deployment_adapter
        if adapter.refusal is None:
            return False
        await adapter.resume()
        return True

    async def complete_outstanding_cleanup(self) -> None:
        """Finish a previous process's interrupted stop; runs before any new start."""
        async with self._lock:
            await asyncio.to_thread(self._supervision.complete_outstanding_cleanup)

    async def runtime_instance_evidence(self):
        return await self._deployment_adapter.evidence()

    async def runtime_readiness_evidence(self) -> RuntimeInstanceEvidence:
        """App projection only; never used as ensure/reuse or instance authority."""
        return await self._deployment_adapter.readiness_evidence()

    # ------------------------------------------------- trajectory inspector

    def _schedule_trajectory_inspector(self, *, reason: str) -> None:
        """Fire-and-forget the debug trajectory-inspector bring-up on a ready transition.

        Debug-gated, idempotent and fail-safe inside ``ensure_running()``.

        Detached on purpose. Every native ready transition holds a lock: the two
        worker exits run under ``self._lock`` and the reuse fast path runs on the
        API request path under the deployment adapter's lock, while
        ``ensure_running()`` can spend seconds probing the port, spawning the exe
        and waiting for ``/health``.
        """
        if self._shutdown_requested.is_set():
            return
        existing = self._inspector_task
        if existing is not None and not existing.done():
            # A bring-up is already in flight; ensure_running() is idempotent, so
            # dropping the duplicate is the same outcome as serializing it.
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.debug("[trajectory] no running loop; skipping inspector bring-up")
            return
        logger.info("[trajectory] scheduling inspector bring-up reason={}", reason)
        task = loop.create_task(
            self._inspector.ensure_running(),
            name=f"trajectory.inspector.ensure:{reason}",
        )
        self._inspector_task = task
        task.add_done_callback(self._drain_inspector_task)

    def _drain_inspector_task(self, task: asyncio.Task) -> None:
        if self._inspector_task is task:
            self._inspector_task = None
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            # ensure_running() swallows everything; this is belt and braces so a
            # future refactor cannot turn the debug aid into a silent dropped task.
            logger.opt(exception=exc).warning(
                "[trajectory] inspector bring-up task failed"
            )

    async def _ensure_worker(
        self, handle: RunHandle, *, deployment: dict[str, object] | None = None,
        launch_context: dict[str, str] | None = None,
    ) -> None:
        async with self._lock:
            self._raise_if_shutdown_requested()
            handle.message("native backend: checking current state")
            if self._termination_unconfirmed:
                raise RuntimeError(
                    self._payload_status_message
                    or (
                        "native backend termination failure "
                        "reason=termination_unconfirmed recovery=retry_stop"
                    )
                )
            if self._has_broker_roles() and not self._broker_roles_complete_and_alive():
                await self._owt.clear()
                self._kill_tree(clear_status=True)
            if self._broker_roles_complete_and_alive():
                try:
                    if self._host_token is None or self._payload_root is None:
                        self._raise_unowned_listener(
                            "current_process_state_incomplete"
                        )
                    trusted_root, _verified = await asyncio.to_thread(
                        self._trust_payload,
                        self._payload_root,
                        phase="reuse",
                    )
                except RuntimeError:
                    await self._owt.clear()
                    self._kill_tree()
                    raise
                self._payload_root = trusted_root
                # A running tree is not ready if its owner tier identities went
                # away. This is a cheap marker check against the SID captured at
                # cold-start (no elevation, no PowerShell on the hot path); a
                # genuine repair happens on the next cold start.
                if (
                    _tier_identity_provision_enabled()
                    and self._owner_sid is not None
                    and not owner_tiers_fully_provisioned(self._owner_sid)
                ):
                    await self._owt.clear()
                    self._kill_tree()
                    self._raise_tier_identity_failure(
                        reason="tier_identity_missing_on_reuse",
                        detail="owner tier identities are no longer provisioned",
                    )
                if ((launch_context is None or launch_context == self._runtime_launch_context)
                    and await self._healthy() and await self._connector_healthy()
                    and await self._hdr_healthy()
                    and self._supervisor_ready() and self._deployment_still_current()):
                    await self._issue_owt()
                    handle.raise_if_cancelled()
                    self._raise_if_shutdown_requested()
                    handle.done()
                    self._schedule_trajectory_inspector(reason="reuse_owned_tree")
                    return
                logger.warning("native-backend: manager-owned tree is unhealthy; recycling")
                await self._owt.clear()
                self._kill_tree(clear_status=True)
            elif await self._healthy():
                await self._owt.clear()
                self._raise_unowned_listener("external_listener_not_owned")

            bin_dir = resolve_bin_dir(getattr(self._cfg, "resources_dir", None))
            if bin_dir is None:
                if _source_development_runtime():
                    raise RuntimeError(
                        "native backend binaries not found (set "
                        f"{_ENV_BIN_DIR} or run scripts/native-backend/build-native-backend.ps1)"
                    )
                self._raise_payload_failure(phase="setup", reason="installed_payload_missing")
            # Checkpoints between cold start and tier-identity provisioning:
            # each can take minutes (hashing every payload file, twice) with
            # no other progress signal, so a slow-but-alive run and a stuck
            # one otherwise look identical from the status API.
            handle.message("verifying native backend payload source")
            logger.info("native-backend: verifying payload source root={}", bin_dir)
            bin_dir, verified = await asyncio.to_thread(
                self._trust_payload,
                bin_dir,
                phase="setup",
            )
            logger.info(
                "native-backend: startup phase=payload event=ready payload_version={}",
                verified.payload_version,
            )
            owner_sid = current_owner_sid()
            handle.message("preparing native backend policy")
            path_set, policy = await asyncio.to_thread(
                build_broker_start_policy,
                owner_sid=owner_sid,
                # Backend roots are provisioned across starts. Per-start randomness
                # belongs to Runtime instance/attempt and launcher pipe IDs.
                session_id="broker-start",
            )
            source_root: Path = bin_dir
            source_verified: VerifiedPayload | None = None
            if isinstance(verified, InstalledPayloadArchive):
                # The broker is not in the archive: it is installed beside it.
                source_root = verified.archive.parent
            else:
                source_verified = verified
            use_upstream_reader(self._current_upstream)
            if _tier_identity_provision_enabled():
                config_root = policy.path_set.get("config_root")
                if config_root is not None:
                    keep = (launch_context or self._runtime_launch_context or {}).get("runtime_instance_id")
                    # Inline before a provision that will elevate, as it walks and re-ACLs this tree; otherwise
                    # held until both provision steps are done, then joined before any role launch.
                    due = await asyncio.to_thread(provision_steps_due, owner_sid, path_set=policy.path_set, acl_plan=policy.acl_plan)
                    await self._generation_prune.schedule(Path(str(config_root)), keep, inline=due)
                handle.message("ensuring Windows tier identities (and folder permissions on a first start)")
                logger.info("native-backend: startup phase=provision event=begin")
                try:
                    await asyncio.to_thread(
                        self._ensure_tier_identities_and_workspace_acl, source_root, source_verified, policy
                    )
                except BrokerClientRefusal as refusal:
                    if is_workspace_acl_refusal(refusal):
                        self._raise_acl_provision_failure(refusal)
                    self._raise_tier_identity_failure(
                        reason="tier_identity_refused",
                        detail=refusal.readable_message(),
                        recovery=_tier_identity_recovery(refusal),
                    )
                logger.info("native-backend: startup phase=provision event=end")
            handle.message("setting up folder permissions")
            logger.info(
                "native-backend: startup phase=acl_provision event=begin"
            )
            try:
                created = await asyncio.to_thread(
                    create_owner_owned_backend_roots,
                    policy.path_set,
                )
                await asyncio.to_thread(
                    ensure_workspace_acl_with_identity_repair,
                    owner_sid=owner_sid,
                    policy=policy,
                    payload_root=source_root,
                    verified_payload=source_verified,
                    force=bool(created),
                )
            except BrokerClientRefusal as refusal:
                self._raise_acl_provision_failure(refusal)
            logger.info(
                "native-backend: startup phase=acl_provision event=end forced={}",
                bool(created),
            )
            await self._generation_prune.release()
            handle.message("staging native backend payload")
            logger.info("native-backend: startup phase=staging event=begin")
            try:
                staged = await asyncio.to_thread(
                    stage_installed_archive
                    if isinstance(verified, InstalledPayloadArchive)
                    else stage_verified_payload,
                    verified,
                    path_set,
                )
            except PayloadInUseError as exc:
                self._raise_payload_in_use(exc)
            except (PayloadIntegrityError, OSError) as exc:
                self._raise_payload_failure(phase="staging", reason=safe_payload_reason(exc))
            prepared = PreparedBrokerPolicy(
                path_set=path_set,
                policy=policy,
                payload=staged,
            )
            bin_dir, verified = staged.payload_root, staged
            logger.info(
                "native-backend: startup phase=staging event=end payload_version={}",
                verified.payload_version,
            )
            config_source = self._config_source_for_trusted_payload(
                bin_dir, verified
            )
            verified_config = (
                config_source.resolve() == verified.payload_root / "config-source"
            )
            from .native_runtime_evidence import deployment_snapshot

            deployment = deployment_snapshot(
                self._store.get_config(RUNTIME_DEPLOYMENT_CONFIG_KEY) if deployment is None else deployment
            )
            deployment, profile_source = await self._select_reconciled_product_profile(
                deployment, handle
            )
            self._required_sidecars = await asyncio.to_thread(
                self._required_sidecars_for_profile,
                profile_source,
                str(deployment["product_profile_id"]),
            )
            self._runtime_launch_context = launch_context or self._runtime_launch_context_scalars(deployment)
            logger.info(
                "native-backend: startup phase=profile event=selected profile={} instance={} attempt={}",
                deployment["product_profile_id"],
                self._runtime_launch_context["runtime_instance_id"],
                self._runtime_launch_context["runtime_launch_attempt_id"],
            )
            handle.progress(10.0)
            handle.message("seeding config")
            try:
                profile_id = str(deployment["product_profile_id"])
                profile_target = (
                    Path(prepared.path_set.config_root)
                    / "bootstrap"
                    / "product-profiles"
                    / profile_id
                )
                if profile_target.exists():
                    self._remove_config_path(profile_target)
                shutil.copytree(profile_source, profile_target)
                # Supervisor owns generation publication, including its dependency layout.
                # The owner prepares only the verified input, never a competing live config.
                project_connector_search_module(
                    profile_root=profile_source,
                    data_root=Path(prepared.path_set.data_root),
                )
                # Seeding the global config can copy for 10+ s on the first start after an
                # update; on the loop it stalled every API request meanwhile (#3658, cf. #3179).
                await asyncio.to_thread(
                    self._prepare_runtime_writable_layout,
                    config_source=config_source,
                    data_dir=Path(prepared.path_set.data_root),
                    payload_root=bin_dir,
                )
            except RuntimeError:
                await self._owt.clear()
                raise
            except Exception as exc:
                if not verified_config:
                    raise
                logger.warning(
                    "native-backend: packaged config staging failed "
                    "exception_type={}",
                    type(exc).__name__,
                )
                await self._owt.clear()
                self._raise_payload_setup_failure(
                    reason="config_staging_failed"
                )
            handle.progress(30.0)

            await self._owt.clear()
            self._host_token = secrets.token_urlsafe(32)
            self._openwork_token = secrets.token_urlsafe(32)
            self._raise_if_shutdown_requested()
            await asyncio.to_thread(scaffold_workspace, _workspace_dir())
            handle.message("checking for SuperClaw 1.x sessions to import")
            await asyncio.to_thread(
                import_v1_state_once,
                data_root=Path(prepared.path_set.data_root),
                workspace_root=Path(prepared.path_set.workspace_roots[0].path),
            )
            self._raise_if_shutdown_requested()
            handle.message("starting isolated native backend roles")
            role_count = 5 + int("hdr-sidecar" in self._required_sidecars)
            logger.info(
                "native-backend: startup phase=roles event=begin count={}",
                role_count,
            )
            await asyncio.to_thread(self._start_broker_roles, prepared)
            logger.info(
                "native-backend: startup phase=roles event=started count={}",
                role_count,
            )
            handle.progress(50.0)

            try:
                handle.message("waiting for openwork-server health")
                t0 = time.monotonic()
                logger.info(
                    "native-backend: startup phase=health event=begin timeout_s={}",
                    _HEALTH_TIMEOUT_S,
                )
                await wait_for_startup_health(
                    started=t0, timeout_s=_HEALTH_TIMEOUT_S, poll_s=_HEALTH_POLL_S,
                    probes={"openwork": self._healthy, "connector": self._connector_healthy,
                            "hdr": self._hdr_healthy},
                    supervisor_ready=self._supervisor_ready,
                    checks=(handle.raise_if_cancelled, self._raise_if_shutdown_requested,
                            self._raise_if_broker_role_exited),
                    role_logs_root=self._role_logs_root,
                )
                if not self._deployment_still_current():
                    raise RuntimeError("Runtime Deployment changed during startup; retry required")
                handle.progress(90.0)
                self._write_lockfile()
                await self._issue_owt()
                logger.info(
                    "native-backend: startup phase=ready event=end elapsed_ms={} instance={} attempt={}",
                    round((time.monotonic() - t0) * 1000),
                    self._runtime_launch_context["runtime_instance_id"],
                    self._runtime_launch_context["runtime_launch_attempt_id"],
                )
                handle.raise_if_cancelled()
                self._raise_if_shutdown_requested()
                handle.done()
                self._schedule_trajectory_inspector(reason="fresh_start")
            except Exception:
                await self._owt.clear()
                self._kill_tree()
                raise
            # Deleting gigabytes is slow, so it starts only once the backend is ready. A daemon
            # thread rather than a task: a delete still running must never hold up shutdown.
            threading.Thread(
                target=remove_legacy_payload_dirs,
                args=(Path(prepared.path_set.payload_root).parent, _legacy_payload_keep()),
                name="legacy-payload-cleanup",
                daemon=True,
            ).start()
            return

    # ------------------------------------------------------------- public: control

    async def control(self, action: str) -> str:
        if action not in {"start", "stop", "restart", "reset"}:
            raise ValueError("unsupported native control action")
        if action == "start":
            await self._deployment_adapter.resume()
            return (await self.ensure_runtime_deployment())[0]

        async def _worker(handle: RunHandle) -> None:
            handle.raise_if_cancelled()
            await self._deployment_adapter.stop()
            if action == "reset":
                await self._generation_prune.stop(must_finish=True)
                for sub in ("config", "data"):
                    path = self._state_dir / sub
                    if path.exists():
                        shutil.rmtree(path)
            if action == "restart":
                await self._deployment_adapter.resume()
                run_id = (await self.ensure_runtime_deployment())[0]
                await self._deployment_adapter.finished.wait()
                row = self._store.get_run(run_id)
                if self._deployment_adapter.failed or (row and row["state"] in {"error", "cancelled"}):
                    raise RuntimeError("native restart did not converge")
            handle.raise_if_cancelled()
            handle.done()

        run_id = await self._runs.spawn(kind=KIND_SANDBOX_CONTROL, worker=_worker)
        self._deployment_adapter.run_ids.add(run_id)
        return run_id

    async def shutdown(self) -> None:
        self._shutdown_requested.set()
        try:
            await self._deployment_adapter.stop()
        finally:
            await self._deployment_adapter.drain()
            await self._supervision.aclose()
            await self._generation_prune.stop()

    def prepare_shutdown(self) -> None:
        """Revoke per-boot Connector client material before HTTP shutdown returns.

        ServiceHub may terminate this process before uvicorn reaches lifespan cleanup when
        long-lived requests are still draining. Job close still kills the process tree, but
        these files must not survive that timing window.
        """
        self._shutdown_requested.set()
        with self._connector_config_io_lock:
            self._remove_connector_config_files_locked()
            self._connector_config = None

    # ------------------------------------------------------------- internals

    def _role_logs_root(self) -> Path:
        return self._state_dir / "logs"

    def _raise_payload_failure(
        self, *, phase: str, reason: PayloadFailureReason, detail: str | None = None
    ) -> NoReturn:
        self._payload_failure = payload_failure(phase, reason, detail)
        message = self._payload_failure.message
        self._host_token = None
        self._openwork_token = None
        self._runtime_launch_context = None
        self._payload_root = None
        self._payload_status_message = message
        self._payload_integrity_failed = True
        logger.error("native-backend: {}", message)
        raise RuntimeError(message)

    def _raise_payload_in_use(self, error: PayloadInUseError) -> NoReturn:
        """Report a payload update refused because the previous backend still holds files."""
        message = PAYLOAD_IN_USE.message
        self._payload_failure = PAYLOAD_IN_USE
        self._payload_status_message = message
        self._payload_integrity_failed = True
        logger.error("native-backend: {}: {}", message, error)
        raise RuntimeError(message) from error

    def _raise_payload_setup_failure(self, *, reason: str) -> NoReturn:
        message = (
            "native backend payload setup failure "
            f"phase=config_staging reason={reason} "
            "recovery=rebuild_or_reinstall_native_payload"
        )
        self._host_token = None
        self._openwork_token = None
        self._runtime_launch_context = None
        self._payload_root = None
        self._payload_status_message = message
        self._payload_integrity_failed = True
        logger.error("native-backend: {}", message)
        raise RuntimeError(message)

    def _raise_product_profile_failure(
        self, *, reason: str, recovery: str
    ) -> NoReturn:
        message = (
            "native backend Product Profile selection failure "
            f"phase=config_source reason={reason} recovery={recovery}"
        )
        self._host_token = None
        self._openwork_token = None
        self._runtime_launch_context = None
        self._payload_root = None
        self._payload_status_message = message
        self._payload_integrity_failed = True
        logger.error("native-backend: {}", message)
        raise RuntimeError(message)

    def _raise_tier_identity_failure(
        self, *, reason: str, detail: str, recovery: str = "retry_after_admin_provision"
    ) -> NoReturn:
        message = (
            "native Windows tier identity refused "
            f"reason={reason} detail={detail} "
            f"recovery={recovery}"
        )
        self._host_token = None
        self._openwork_token = None
        self._runtime_launch_context = None
        self._payload_root = None
        self._payload_status_message = message
        self._payload_integrity_failed = True
        logger.error("native-backend: {}", message)
        raise RuntimeError(message)

    def _raise_acl_provision_failure(
        self, refusal: BrokerClientRefusal
    ) -> NoReturn:
        reasons = {item.reason for item in refusal.items}
        if BrokerRefusalReason.provision_elevation_declined in reasons:
            recovery = "approve_uac_and_retry"
        elif BrokerRefusalReason.broker_not_found in reasons:
            recovery = "reinstall_native_payload"
        elif BrokerRefusalReason.provision_frame_timeout in reasons:
            recovery = "retry"
        else:
            recovery = "retry_after_admin_provision"
        reason = ",".join(sorted(item.value for item in reasons))
        message = (
            "native folder permission setup refused "
            f"reason={reason} detail={refusal.readable_message()} "
            f"recovery={recovery}"
        )
        self._host_token = None
        self._openwork_token = None
        self._runtime_launch_context = None
        self._payload_root = None
        self._payload_status_message = message
        self._payload_integrity_failed = True
        logger.error("native-backend: {}", message)
        raise RuntimeError(message)

    def _ensure_tier_identities_and_workspace_acl(
        self, bin_dir: Path, verified: VerifiedPayload | None, policy: BrokerStartPolicy
    ) -> None:
        owner_sid = current_owner_sid()
        # Cache for the reuse-path marker check.
        self._owner_sid = owner_sid
        ensure_tier_identities_and_workspace_acl(
            owner_sid=owner_sid, path_set=policy.path_set, acl_plan=policy.acl_plan,
            payload_root=bin_dir, verified_payload=verified,
        )

    def _raise_unowned_listener(self, reason: str) -> NoReturn:
        message = (
            "native backend listener is not owned by this manager "
            f"reason={reason} recovery=restart_required"
        )
        self._host_token = None
        self._openwork_token = None
        self._runtime_launch_context = None
        self._payload_root = None
        self._payload_status_message = message
        self._payload_integrity_failed = True
        logger.error("native-backend: {}", message)
        raise RuntimeError(message)

    def _trust_payload(
        self, payload_root: Path, *, phase: str
    ) -> tuple[Path, InstalledSource]:
        """Verify one trust transition; success is intentionally not cached.

        A source checkout gets no exemption: the roles launch only from a verified payload,
        so a partial build fails here like an installed one, with the build script named.
        """
        archive = is_installed_archive(payload_root)
        try:
            verified = (open_installed_archive if archive else verify_payload)(payload_root)
        except (PayloadIntegrityError, OSError) as exc:
            self._raise_payload_failure(
                phase=phase,
                reason=safe_payload_reason(exc),
                detail=(
                    "build a complete payload with "
                    "scripts/native-backend/build-native-backend.ps1"
                    if _source_development_runtime()
                    else None
                ),
            )
        self._payload_status_message = None
        self._payload_integrity_failed = False
        logger.info(
            "native-backend: payload integrity phase={} result={} "
            "payload_version={} file_count={} "
            "residual_toctou=hash_to_exec_not_closed",
            phase,
            "opened" if archive else "verified",
            verified.payload_version,
            verified.file_count,
        )
        if isinstance(verified, InstalledPayloadArchive):
            return verified.archive, verified
        return verified.payload_root, verified

    def _config_source_for_trusted_payload(
        self, payload_root: Path, verified: VerifiedPayload
    ) -> Path:
        source_development = _source_development_runtime()
        source = (
            resolve_config_source(payload_root)
            if source_development
            else verified.payload_root / "config-source"
        )
        if source is None:
            return self._raise_payload_failure(
                phase="setup", reason="config_source_unavailable"
            )
        if not (source / "package.json").is_file():
            self._raise_payload_failure(
                phase="setup", reason="config_source_unavailable"
            )
        if (
            source_development
            and source.resolve() != verified.payload_root / "config-source"
        ):
            logger.warning(
                "native-backend: source-development config override is outside "
                "the verified payload; result=allowed_not_promotion_eligible"
            )
        return source

    async def _select_reconciled_product_profile(
        self, deployment: dict[str, object], handle: RunHandle
    ) -> tuple[dict[str, object], Path]:
        """Select ``deployment``'s Product Profile once ServiceHub has had a chance to reconcile it.

        An update that changes a Product Profile leaves the stored deployment naming the
        old digest until ServiceHub's boot reconcile commits a new one, seconds after this
        process resumed the old deployment. A newer commit supersedes this run and the
        adapter converges on it; only a mismatch that outlasts the wait fails closed.
        The bounded wait deliberately holds the lifecycle lock, so even a genuinely
        corrupt Profile fails closed after the reconciliation budget rather than allowing
        another startup to use an unverified Profile concurrently.
        """
        current = self._raise_if_deployment_superseded(deployment)
        try:
            profile_source = await asyncio.to_thread(
                self._selected_product_profile,
                current,
                defer_digest_mismatch=True,
            )
        except _ProductProfileDigestPending:
            profile_source = None
        if profile_source is not None:
            self._raise_if_deployment_superseded(current)
            return current, profile_source
        logger.warning(
            "native-backend: installed Product Profile does not match the committed deployment "
            "product_profile_id={}; waiting up to {}s for ServiceHub to commit a reconciled deployment",
            deployment["product_profile_id"],
            _PROFILE_RECONCILE_WAIT_S,
        )
        handle.message("waiting for ServiceHub to reconcile the Product Profile")
        deadline = time.monotonic() + _PROFILE_RECONCILE_WAIT_S
        while time.monotonic() < deadline:
            await asyncio.sleep(_PROFILE_RECONCILE_POLL_S)
            handle.raise_if_cancelled()
            self._raise_if_shutdown_requested()
            self._raise_if_deployment_superseded(deployment)
        current = self._raise_if_deployment_superseded(deployment)
        try:
            profile_source = await asyncio.to_thread(
                self._selected_product_profile, current
            )
        except RuntimeError as exc:
            if "reason=product_profile_digest_mismatch" not in str(exc):
                raise
            # ServiceHub may have committed the reconciled deployment while the
            # final digest was being computed. Treat that mismatch as
            # supersession so the follow-up converges on the new deployment.
            self._raise_if_deployment_superseded(current)
            raise
        self._raise_if_deployment_superseded(current)
        return current, profile_source

    def _raise_if_deployment_superseded(
        self, deployment: dict[str, object]
    ) -> dict[str, object]:
        from .native_deployment import NativeDeploymentSuperseded
        from .native_runtime_evidence import deployment_snapshot, fingerprint

        current = deployment_snapshot(self._store.get_config(RUNTIME_DEPLOYMENT_CONFIG_KEY))
        if fingerprint(current) != fingerprint(deployment):
            raise NativeDeploymentSuperseded(
                "native deployment changed before Product Profile selection"
            )
        return current

    def _selected_product_profile(
        self,
        deployment: dict[str, object] | None = None,
        *,
        defer_digest_mismatch: bool = False,
    ) -> Path:
        """The Product Profile directory the committed Runtime Deployment selected.

        Mirrors the orchestrator's ``bootstrapRuntimeDeployment``
        (``sandbox/orchestrator/src/runtime-deployment.ts``): the deployment names
        the Product Profile, and the packaged tree's digest must equal the
        deployment's ``product_profile_digest`` before any of it is seeded. Every
        refusal below names its own reason — a gated Profile must be
        distinguishable from a missing payload and from a crash.
        """
        try:
            if deployment is None:
                deployment = self._store.get_config(RUNTIME_DEPLOYMENT_CONFIG_KEY)
        except Exception as exc:  # noqa: BLE001 - a store fault is not a digest fault
            logger.warning(
                "native-backend: runtime deployment unreadable exception_type={}",
                type(exc).__name__,
            )
        if not isinstance(deployment, dict):
            self._raise_product_profile_failure(
                reason="runtime_deployment_not_committed",
                recovery="commit_a_runtime_deployment_then_retry",
            )
        profile_id = deployment.get("product_profile_id")
        expected_digest = deployment.get("product_profile_digest")
        if (
            not isinstance(profile_id, str)
            or profile_id not in PRODUCT_PROFILE_IDS
            or not isinstance(expected_digest, str)
            or not expected_digest
        ):
            self._raise_product_profile_failure(
                reason="runtime_deployment_profile_selection_invalid",
                recovery="recommit_a_runtime_deployment_then_retry",
            )
        profiles_root = resolve_product_profiles_root()
        if profiles_root is None:
            self._raise_product_profile_failure(
                reason="product_profile_root_unavailable",
                recovery="reinstall_or_set_profiles_root_override",
            )
            raise AssertionError("Product Profile failure helper returned")
        directory = profiles_root / profile_id
        if not directory.is_dir() or not (directory / "opencode.jsonc").is_file():
            self._raise_product_profile_failure(
                reason="selected_product_profile_missing",
                recovery="reinstall_product_profiles",
            )
        try:
            digest = compute_product_profile_digest(directory)
        except (ProductProfileDigestError, OSError):
            self._raise_product_profile_failure(
                reason="product_profile_digest_unreadable",
                recovery="reinstall_product_profiles",
            )
        if digest != expected_digest:
            # Source checkouts edit Profile files between activations, so digest mismatches
            # are tolerated there: loud, recorded, never promotion eligible. Installed
            # builds fail closed.
            if not _source_development_runtime():
                if defer_digest_mismatch:
                    raise _ProductProfileDigestPending
                self._raise_product_profile_failure(
                    reason="product_profile_digest_mismatch",
                    recovery="reactivate_the_model_binding_or_reinstall",
                )
            message = (
                "native backend source-development Product Profile does not match the "
                "committed digest; partial config allowed but not promotion eligible"
            )
            self._payload_status_message = message
            logger.warning(
                "native-backend: product profile digest mismatch "
                "mode=source-development product_profile_id={} result=allowed; {}",
                profile_id,
                message,
            )
            return directory
        logger.info(
            "native-backend: product profile selected product_profile_id={} "
            "digest_verified=true",
            profile_id,
        )
        return directory

    @staticmethod
    def _remove_config_path(path: Path) -> None:
        metadata = path.lstat()
        reparse_attribute = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        file_attributes = getattr(metadata, "st_file_attributes", 0)
        if path.is_symlink() or bool(file_attributes & reparse_attribute):
            try:
                path.rmdir()
            except OSError:
                path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()

    def _seed_runtime_plugin_cache(
        self,
        *,
        config_source: Path,
        data_dir: Path,
    ) -> None:
        """Give the runtime role a plugin cache it can read without a registry.

        opencode does not load a declared plugin out of the config tree's
        ``node_modules``. It resolves each one through its own cache at
        ``$XDG_CACHE_HOME/opencode/packages/<spec>`` and installs from npm when the
        entry is absent, which is the one thing that makes startup need the network.

        The payload ships each entry's manifest only; the dependency tree it names is
        the same ``config-source`` tree seeded above, so the two are composed here
        rather than shipped twice. The destination is the runtime role's own tier
        subtree because that is what its ``XDG_CACHE_HOME`` names and the one cache
        root the shipped policy grants it.
        """
        # `config-source` and `opencode-cache` are siblings in the payload, which is
        # what `resolve_config_source` returns the first of.
        staged = config_source.parent / "opencode-cache" / "packages"
        if not staged.is_dir():
            # Payloads built before the seeding step carry no entry. The runtime then
            # resolves plugins from the registry exactly as it did before, so this is
            # not fatal - but it is the difference between an offline start and one
            # that hangs on a host with no usable network, so it is not silent either.
            logger.warning(
                "native-backend: payload ships no opencode plugin cache at {}; "
                "the runtime will resolve declared plugins from the npm registry",
                staged,
            )
            return

        packaged_node_modules = config_source / "node_modules"
        # The runtime role runs in file_tool; see `catalog_roles::resolve_runtime`.
        packages = data_dir / "file_tool" / "cache" / "opencode" / "packages"
        copied = 0
        reused = 0
        for entry in sorted(staged.iterdir()):
            manifest = entry / "package.json"
            if not manifest.is_file():
                continue
            destination = packages / entry.name
            installed = destination / "package.json"
            modules = destination / "node_modules"
            if (
                modules.is_dir()
                and installed.is_file()
                and installed.read_bytes() == manifest.read_bytes()
            ):
                reused += 1
                continue
            if modules.exists():
                shutil.rmtree(modules)
            destination.mkdir(parents=True, exist_ok=True)
            shutil.copy2(manifest, installed)
            shutil.copytree(packaged_node_modules, modules)
            copied += 1
            logger.info("native-backend: seeded opencode plugin cache entry {}", entry.name)
        logger.info(
            "native-backend: runtime plugin cache phase=seed event=end "
            "copied={} reused={}",
            copied,
            reused,
        )

    def _prepare_runtime_writable_layout(
        self,
        *,
        config_source: Path,
        data_dir: Path,
        payload_root: Path,
    ) -> None:
        logger.info("native-backend: runtime writable layout phase=prepare event=begin")
        try:
            file_tool_data = data_dir / "file_tool"
            for directory in (
                file_tool_data / "home" / "AppData" / "Roaming",
                file_tool_data / "home" / "AppData" / "Local",
                file_tool_data / "home" / ".local" / "bin",
                file_tool_data / "home" / ".local" / "tools",
                file_tool_data / "config",
                file_tool_data / "state",
                file_tool_data / "cache" / "npm",
                file_tool_data / "opencode" / "logs",
            ):
                directory.mkdir(parents=True, exist_ok=True)
            prepare_runtime_python(payload_root=payload_root, data_dir=data_dir)
            seed_runtime_global_config(config_source=config_source, data_dir=data_dir)
            self._seed_runtime_plugin_cache(
                config_source=config_source,
                data_dir=data_dir,
            )
        except Exception as exc:
            logger.error(
                "native-backend: runtime writable layout phase=prepare "
                "event=failed exception_type={}",
                type(exc).__name__,
            )
            raise
        logger.info("native-backend: runtime writable layout phase=prepare event=end")

    async def _healthy(self) -> bool:
        try:
            timeout = httpx.Timeout(
                _HEALTH_PROBE_TIMEOUT_S, connect=_HEALTH_PROBE_CONNECT_TIMEOUT_S
            )
            async with httpx.AsyncClient(trust_env=False, timeout=timeout) as client:
                r = await client.get(f"http://127.0.0.1:{self._port}/health")
                return r.status_code == 200
        except Exception:  # noqa: BLE001
            return False

    async def _issue_owt(self) -> None:
        assert self._host_token is not None
        await self._owt.issue(
            sandbox_url=f"http://127.0.0.1:{self._port}",
            host_token=self._host_token,
        )

    def _resolve_connector_proxy_env(self) -> dict[str, str]:
        """Resolve the outbound proxy configuration the Connector needs to egress.

        The isolation broker launches the Connector with a closed declared
        environment, so this is the only way the host's proxy settings reach it.
        Without them every web search times out and - because the search backend
        cannot tell a timeout from an empty page - the model is told the web was
        searched successfully and found nothing.

        Resolution order: explicit operator override in the config store first,
        then this process's environment. A non-string override is ignored rather
        than coerced.
        """
        resolve = self._resolve_proxy_setting
        proxy: dict[str, str] = {}
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
            value = resolve(name)
            if not value:
                continue
            # 4096 is the bound the Connector enforces; a longer value would be
            # refused there, which presents as a role that starts and exits.
            if len(value) > 4096:
                logger.warning("native-backend: ignoring oversized {} proxy value", name)
                continue
            # A scheme is what makes this a proxy URL. The common sloppy form
            # `user:pass@host:port` cannot work as one, and a client that rejects it
            # may quote it back -- with the password -- into text that reaches the
            # model. Refuse it here rather than propagate a value that can only
            # fail. The variable is named; the value never is, since it may carry
            # credentials.
            if "://" not in value:
                logger.warning(
                    "native-backend: ignoring {} proxy value with no URL scheme "
                    "(expected e.g. http://host:port)",
                    name,
                )
                continue
            proxy[name] = value
            proxy[name.lower()] = value
        if not proxy:
            # No proxy means no NO_PROXY to reason about. Emitting one anyway would
            # change behaviour on machines that never needed this.
            return proxy
        # Loopback must never go through the proxy: `requests` honours NO_PROXY for
        # every URL including 127.0.0.1, and a corporate NO_PROXY that omits
        # loopback would turn a local call into a proxy 502.
        tokens = ["127.0.0.1", "localhost", "::1"]
        for raw in (resolve("NO_PROXY") or "").split(","):
            token = raw.strip()
            if token and token not in tokens:
                tokens.append(token)
        merged = ",".join(tokens)
        if len(merged) > 4096:
            # Dropping the whole value would take the loopback entries with it,
            # which is the one part that must not be lost.
            merged = ",".join(tokens[:3])
        proxy["NO_PROXY"] = merged
        proxy["no_proxy"] = merged
        return proxy

    def _resolve_proxy_setting(self, name: str) -> str | None:
        """One host proxy setting: the config store's override, else this process's environment.

        The Connector, the egress proxy and the bypass list all read through here, so they never
        disagree about which proxy the host configured. A non-string override is ignored rather than
        coerced, and an unreadable store falls through to the environment.
        """
        override = None
        try:
            override = self._store.get_config(name)
        except Exception:  # noqa: BLE001
            # An unreadable store must not cost the Connector its egress.
            pass
        # The store is untyped: coercing a non-string would hand the Connector a nonsense proxy that
        # fails every request.
        if isinstance(override, str) and override.strip():
            return override.strip()
        return os.environ.get(name) or os.environ.get(name.lower()) or None

    def _current_upstream(self) -> UpstreamProxy:
        """The decision read at this start; read now when a re-seal comes between starts."""
        if self._upstream is None:
            self._upstream = resolve_upstream(self._resolve_proxy_setting, read_system_proxy())
        return self._upstream

    def _write_egress_proxy_config(self, destination: Path, *, audit_log: Path) -> Path:
        decision = self._current_upstream()
        if decision.pac is not None:
            # Names the setting's shape only: the script URL names an internal host.
            logger.info(
                "native-backend: host proxy PAC/WPAD is resolved per target by the egress proxy "
                "script={} auto_detect={}",
                decision.pac.auto_config_url is not None,
                decision.pac.auto_detect,
            )
        if decision.unsupported is not None and not (
            decision.pac is not None and decision.unsupported == "proxy_auto_config"
        ):
            # The kind, never the value: it may carry a password.
            logger.warning(
                "native-backend: host upstream proxy unsupported source={} kind={}; log_only keeps the "
                "route it had before the proxy (credentialed: chained through; otherwise direct), audited",
                decision.source,
                decision.unsupported,
            )
        if decision.dropped_bypass_entries:
            # A count only: an entry can name an internal host.
            logger.warning(
                "native-backend: {} host proxy bypass entries are outside the grammar or IPv6 ranges, not bound",
                decision.dropped_bypass_entries,
            )
        mode = egress_proxy_mode(os.environ)
        if mode != "log_only":
            logger.warning("native-backend: egress proxy mode={} (internal setting, not a shipped default)", mode)
        # Enforce lets the shell listener ask the user about an unlisted destination (EG2-4b): the proxy is
        # sealed the broker's verifier section and the key its command credentials are checked with.
        asks = (
            mode == "enforce"
            and self._egress_approval_broker is not None
            and self._connector_config is not None
        )
        self._egress_proxy_asks = asks
        with self._connector_config_io_lock:
            self._raise_if_shutdown_requested()
            destination.parent.mkdir(parents=True, exist_ok=True)
            write_sealed_json(
                destination,
                egress_proxy_config(
                    decision,
                    str(audit_log),
                    mode,
                    approval=self._egress_approval_broker.provider_config("egress_proxy") if asks else None,
                    session_key=egress_proxy_session_key(self._connector_config["caller_key_b64"]) if asks else None,
                ),
            )
            return destination
    def _read_tavily_key(self, runtime_config: Path) -> str:
        """Read the saved Tavily API key, and say in the log which case this was.

        Sealing an empty key in silence is what hid issue #2648 for a whole release: a
        settings file the product wrote to a path nothing read was indistinguishable, from
        inside the product, from a user who had configured no key at all. Both presented as
        `[via DuckDuckGo]` with a Settings badge that said the key was set. So every outcome
        gets a line naming the file. The key itself never appears in one.
        """
        store = self._tavily_api_key_store
        if store is not None:
            # The settings file is read only to move a key an older openwork-server saved into the store.
            store.adopt_runtime_settings_key(runtime_config)
            return self._stored_tavily_key(store)
        tavily_key = ""
        try:
            parsed = json.loads(runtime_config.read_text(encoding="utf-8"))
        except FileNotFoundError:
            # Expected until the first save, and the whole diagnosis when it is not.
            outcome = "no_settings_file"
        except (OSError, ValueError) as exc:
            outcome = f"unreadable:{type(exc).__name__}"
        else:
            search = parsed.get("search") if isinstance(parsed, dict) else None
            if isinstance(search, dict):
                tavily_key = str(search.get("tavilyApiKey") or "").strip()
            outcome = "present" if tavily_key else "no_key_configured"
        if tavily_key:
            logger.info(
                "native-backend: connector provider config event=runtime_settings "
                "outcome={} path={}",
                outcome,
                runtime_config,
            )
        else:
            logger.warning(
                "native-backend: connector provider config event=runtime_settings "
                "outcome={} path={}; web search will fall back to DuckDuckGo",
                outcome,
                runtime_config,
            )
        return tavily_key

    @staticmethod
    def _stored_tavily_key(store: Any) -> str:
        """The key the host holds, and in the log which case this was; the key itself never appears."""
        try:
            tavily_key = (store.read() or "").strip() if (enabled := store.is_enabled()) else ""
        except TavilyApiKeyUnreadable as exc:
            logger.warning(
                "native-backend: connector provider config event=tavily_key_store "
                "outcome=unreadable:{} path={}; web search will fall back to DuckDuckGo",
                exc,
                store.path,
            )
            return ""
        if tavily_key:
            logger.info(
                "native-backend: connector provider config event=tavily_key_store "
                "outcome=present path={}",
                store.path,
            )
        else:
            logger.warning(
                "native-backend: connector provider config event=tavily_key_store "
                "outcome={} path={}; web search will fall back to DuckDuckGo",
                "no_key_configured" if enabled else "paused", store.path,
            )
        return tavily_key

    def _write_connector_provider_config(
        self,
        destination: Path,
        *,
        runtime_config: Path,
        audit_log: Path,
    ) -> Path:
        with self._connector_config_io_lock:
            self._raise_if_shutdown_requested()
            self._connector_audit_log_path = audit_log
            # Read inside the lock: a key saved from here on finds a path to re-seal, and its re-seal waits
            # for this seal instead of returning early and leaving the older key sealed.
            tavily_key = self._read_tavily_key(runtime_config)
            return self._seal_connector_provider_config(destination, tavily_key, audit_log)

    def _seal_connector_provider_config(
        self, destination: Path, tavily_key: str, audit_log: Path
    ) -> Path:
        with self._connector_config_io_lock:
            self._raise_if_shutdown_requested()
            destination.parent.mkdir(parents=True, exist_ok=True)
            decision = self._current_upstream()
            config: dict[str, Any] = {
                "search": {"tavilyApiKey": tavily_key},
                "proxy": connector_proxy_env(decision, self._resolve_connector_proxy_env),
                "audit": {"path": str(audit_log)},
            }
            if self._egress_approval_broker is not None:
                config["approval"] = self._egress_approval_broker.provider_config()
            write_sealed_json(destination, config)
            return destination

    def _write_connector_client_config(self, destination: Path) -> Path:
        with self._connector_config_io_lock:
            self._raise_if_shutdown_requested()
            if self._connector_config is None:
                raise RuntimeError("Connector boot configuration is unavailable")
            destination.parent.mkdir(parents=True, exist_ok=True)
            write_sealed_json(destination, self._connector_config)
            return destination

    async def _connector_healthy(self) -> bool:
        config = self._connector_config
        proc = self._connector_proc
        if config is None or proc is None or proc.poll() is not None:
            return False
        import hashlib
        import hmac

        from .connector import _mac_payload

        request = {
            "contract_version": CONNECTOR_IPC_CONTRACT_VERSION,
            "operation": "health",
            "direction": "request",
            "caller_key_id": config["caller_key_id"],
            "boot_id": config["boot_id"],
            "session_id": "sandbox-manager",
            "request_id": f"health-{secrets.token_hex(8)}",
            "nonce": base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode(),
            "deadline_ms": int(time.time() * 1000) + 2_000,
            "body": {},
            "auth_tag": "0" * 64,
        }
        key = base64.b64decode(config["caller_key_b64"])
        request["auth_tag"] = hmac.new(key, _mac_payload(request), hashlib.sha256).hexdigest()
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=2.0) as client:
                response = await client.post(config["endpoint"], json=request)
                if response.status_code != 200 or len(response.content) > _MAX_CONNECTOR_RESPONSE_BYTES:
                    return False
                message = response.json()
                expected_fields = (
                    message.get("contract_version") == CONNECTOR_IPC_CONTRACT_VERSION
                    and message.get("operation") == "health"
                    and message.get("direction") == "response"
                    and message.get("caller_key_id") == config["caller_key_id"]
                    and message.get("response_key_id") == config["response_key_id"]
                    and message.get("boot_id") == config["boot_id"]
                    and message.get("session_id") == request["session_id"]
                    and message.get("request_id") == request["request_id"]
                    and message.get("nonce") == request["nonce"]
                    and message.get("deadline_ms") == request["deadline_ms"]
                )
                if not expected_fields:
                    return False
                response_key = base64.b64decode(config["response_key_b64"])
                expected_tag = hmac.new(
                    response_key, _mac_payload(message), hashlib.sha256
                ).hexdigest()
                return hmac.compare_digest(expected_tag, str(message.get("auth_tag", "")))
        except Exception:  # noqa: BLE001
            return False

    def _remove_connector_config_files(self) -> None:
        with self._connector_config_io_lock:
            self._remove_connector_config_files_locked()

    def _remove_connector_config_files_locked(self) -> None:
        paths: set[Path] = set()
        if self._connector_client_config_path is not None:
            paths.add(self._connector_client_config_path)
        if self._connector_provider_config_path is not None:
            paths.add(self._connector_provider_config_path)
        for path in paths:
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                logger.warning(
                    "native-backend: failed to revoke Connector boot config "
                    "file={} exception_type={}",
                    path.name,
                    type(exc).__name__,
                )
        self._connector_client_config_path = None
        self._connector_provider_config_path = None

    def _raise_if_shutdown_requested(self) -> None:
        if self._shutdown_requested.is_set() or self._startup_abort.is_set():
            raise RuntimeError("native backend shutdown requested")

    def _kill_tree(self, *, clear_status: bool = False) -> None:
        try:
            self._stop_broker_roles()
        finally:
            self._host_token = None
            self._openwork_token = None
            self._runtime_launch_context = None
            self._payload_root = None
            try:
                (self._state_dir / _LOCKFILE_NAME).unlink(missing_ok=True)
            except OSError:
                pass
            if clear_status and not self._termination_unconfirmed:
                self._payload_status_message = None
                self._payload_integrity_failed = False

    # Diagnostic only. It never restores process, token, or payload trust.
    def _write_lockfile(self) -> None:
        assert self._proc is not None and self._host_token is not None
        payload = {"pid": self._proc.pid, "port": self._port}
        path = self._state_dir / _LOCKFILE_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")

    def _read_lockfile(self) -> dict[str, Any] | None:
        try:
            raw = (self._state_dir / _LOCKFILE_NAME).read_bytes()
            if len(raw) > 4096:
                return None
            value = json.loads(raw)
            if not isinstance(value, dict):
                return None
            return {"pid": value.get("pid"), "port": value.get("port")}
        except Exception:  # noqa: BLE001
            return None
