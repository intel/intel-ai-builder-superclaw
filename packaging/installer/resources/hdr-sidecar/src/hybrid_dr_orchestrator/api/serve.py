"""FastAPI app — HTTP surface the opencode bridge plugin calls.

Endpoints:

  POST  /v1/hybrid-dr/sessions                       — create a session
  POST  /v1/hybrid-dr/sessions/{sid}/advance         — drive 1 phase
  POST  /v1/hybrid-dr/sessions/{sid}/run             — start/resume background run
  GET   /v1/hybrid-dr/sessions/{sid}/run             — inspect background run
  GET   /v1/hybrid-dr/sessions/{sid}/state           — current state
  POST  /v1/hybrid-dr/sessions/{sid}/cancel          — mark CANCELLED
  GET   /healthz                                     — liveness

The sidecar holds session state in-memory + on-disk legacy file. Across
restarts, state is recovered from `pipeline_state.json` on disk so the
opencode bridge can resume after a sidecar restart without losing
position.

The LLM / search clients are dependency-injected at startup so tests
can wire `MockLLMClient` / `MockSearchClient`.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from ..connector_reader import ConnectorConfigUnavailable
from ..llm import HTTPLLMClient, LLMClient, LLMEndpointConfig
from ..managed_paths import AuthorizedFile, DataPathRefusal, authorize_data_paths
from ..persistence import load_legacy, save_legacy
from ..runner import Runner, SessionConfig, SessionLayout, _summarize_exc
from ..search import (
    ConnectorSearchClient,
    ConnectorSearchError,
    DegradingConnectorSearchClient,
    DuckDuckGoSearchClient,
    FallbackSearchClient,
    SearchClient,
    TavilySearchClient,
)
from ..state import (
    Phase,
    PipelineState,
    PrivacyTier,
    TaskClass,
)

logger = logging.getLogger(__name__)


DEFAULT_SESSION_ROOT = "/workspace/deep-research-workspaces/sessions"
_MANAGED_TRUE, _TOKEN_RE = "1", re.compile(r"^[A-Za-z0-9_-]{32,256}$")
_SESSION_ID_RE = re.compile(r"^ses_[0-9a-f]{24}$")

# Serial readiness allowance: Connector 2s + LRM 2s + 1s for local file
# work/scheduling once the client configuration is cached. The one cold unseal
# (reader 5s + cleanup 1s) may outrun it; that probe's 503 leaves the cache warm
# for the next. SM and Supervisor callers allow 10s.
# The overall deadline also bounds trickling HTTP responses and thread waits.
_MANAGED_READY_TIMEOUT_S = 8.0
_READY_DEPENDENCY_TIMEOUT_S = 2.0

# Admission control. Concurrent DR sessions share one cloud account; the
# upstream serves each call slower under load, so N sessions running at once
# make each other time out (contention grows super-linearly). Capping the
# number of in-flight sessions lets each admitted DR run without contention;
# excess creates block at the gate until a slot frees, so the wait is taken
# up-front (queued) instead of interleaved across every phase (which would
# only spread the slowdown, as capping individual cloud calls does). Default
# allows a small amount of concurrency; set to 1 for strict no-contention.
_MAX_CONCURRENT_SESSIONS = max(1, int(os.environ.get("HYBRID_DR_MAX_CONCURRENT_SESSIONS", "2")))
# A held slot is reclaimed if its session goes this long without advancing,
# so a client that abandons a session mid-run cannot deadlock the gate.
_SESSION_STALE_S = float(os.environ.get("HYBRID_DR_SESSION_STALE_S", "1800"))

# Guard 6: in-place retries for a transiently-failed phase before the DR
# aborts, so a single flaky cloud response does not kill the whole run. Env-
# tunable; 0 disables (fail-fast). Applied to production sessions only —
# test-injected deps keep fail-fast so unit tests stay deterministic + fast.
_PHASE_MAX_RETRIES = max(0, int(os.environ.get("HYBRID_DR_PHASE_MAX_RETRIES", "2")))
# Wall-clock ceiling for a whole background run. A model or web-search backend
# that goes slow or unreachable makes a phase (observed: input_web) retry on the
# per-call connect/read timeouts until the driver's turn budget is gone, and the
# user is left staring at "still running" with no report and no clear failure
# (issue #1633 Path B: a transient connectivity blip stretched a run past 8 min).
# This deadline converts that unbounded stall into a fast, terminal, legible
# failure. Generous by default so a genuinely-slow-but-progressing on-device run
# still finishes; tunable per deployment.
_RUN_BUDGET_S = float(os.environ.get("HYBRID_DR_RUN_BUDGET_S", "600"))
_CANCEL_WAIT_S = 5.0


# ───── request / response shapes ───────────────────────────────────────


class CreateSessionRequest(BaseModel):
    user_query: str = Field(..., min_length=1)
    task_id: str | None = None
    task_class: TaskClass = TaskClass.DEEP_RESEARCH
    privacy_tier: PrivacyTier = PrivacyTier.L2
    data_paths: list[str] = Field(default_factory=list)
    title: str = "Assembled Report"
    cloud_model: str | None = None
    cloud_llm: LLMEndpointConfig | None = None
    local_llm: LLMEndpointConfig | None = None
    llmrouter_url: str | None = None
    opencode_session_id: str | None = None
    # The OpenCode assistant-message id of the turn that dispatched this run
    # (msg_...). llmrouter keys Langfuse trace ids off that message id, so
    # using it as this run's X-Hybrid-DR-Run-Id merges the whole HDR pipeline
    # into the dispatch turn's existing trace (title-gen + dispatch ack +
    # every hdr-* generation) instead of a second disconnected trace.
    opencode_message_id: str | None = None
    tavily_api_key: str | None = None
    session_root: str | None = None


class CreateSessionResponse(BaseModel):
    session_id: str
    root_dir: str
    state: dict[str, Any]


class StateResponse(BaseModel):
    session_id: str
    state: dict[str, Any]


class AdvanceResponse(BaseModel):
    session_id: str
    state: dict[str, Any]
    error: str | None = None


class RunResponse(BaseModel):
    session_id: str
    run_id: str | None = None
    status: str
    state: dict[str, Any]
    error: str | None = None


# ───── app factory ─────────────────────────────────────────────────────


@dataclass
class AppDeps:
    """Dependencies injected by tests. Production builds request-scoped clients."""

    llm: LLMClient
    search: SearchClient
    session_root: Path


@dataclass(frozen=True)
class DeploymentPolicy:
    native_managed: bool
    api_token: str | None = field(repr=False)
    ready_token: str | None = field(repr=False)
    session_root: Path
    llmrouter_url: str
    lrm_api_key: str = field(repr=False)
    connector_config: Path | None
    connector_reader_python: Path | None
    connector_reader_root: Path | None
    workspace_root: Path | None = None


def _deployment_policy_from_env() -> DeploymentPolicy:
    managed_value = os.environ.get("HYBRID_DR_NATIVE_MANAGED", "").strip()
    if managed_value not in ("", _MANAGED_TRUE):
        raise RuntimeError("HDR deployment mode is invalid")
    managed = managed_value == _MANAGED_TRUE
    session_root_value = os.environ.get("HYBRID_DR_SESSION_ROOT", "").strip()
    llmrouter_value = os.environ.get("HYBRID_DR_LLMROUTER_URL", "").strip()
    connector_value = os.environ.get("SUPERCLAW_CONNECTOR_CONFIG", "").strip()
    lrm_api_key = os.environ.get("LRM_API_KEY", "").strip()
    reader_python_value = os.environ.get("SUPERCLAW_CONNECTOR_READER_PYTHON", "").strip()
    reader_root_value = os.environ.get("SUPERCLAW_CONNECTOR_READER_ROOT", "").strip()
    workspace_root_value = os.environ.get("HYBRID_DR_WORKSPACE_ROOT", "").strip()
    session_root = Path(session_root_value or DEFAULT_SESSION_ROOT)
    llmrouter_url = (llmrouter_value or "http://127.0.0.1:18321").rstrip("/")
    connector_config = Path(connector_value) if connector_value else None
    connector_reader_python = Path(reader_python_value) if reader_python_value else None
    connector_reader_root = Path(reader_root_value) if reader_root_value else None
    token = os.environ.get("HYBRID_DR_API_TOKEN", "").strip() or None
    ready_token = os.environ.get("HYBRID_DR_READY_TOKEN", "").strip() or None
    if not managed and (token is not None or ready_token is not None):
        raise RuntimeError("HDR deployment mode and API tokens are inconsistent")
    if managed:
        if token is None or not _TOKEN_RE.fullmatch(token):
            raise RuntimeError("Native managed HDR requires a valid API token")
        if ready_token is None or not _TOKEN_RE.fullmatch(ready_token):
            raise RuntimeError("Native managed HDR requires a valid readiness token")
        if hmac.compare_digest(token, ready_token):
            raise RuntimeError("Native managed HDR requires distinct API and readiness tokens")
        if not session_root_value:
            raise RuntimeError("Native managed HDR requires an explicit session root")
        if not session_root.is_absolute():
            raise RuntimeError("Native managed HDR requires an absolute session root")
        if not workspace_root_value:
            raise RuntimeError("Native managed HDR requires a bound workspace root")
        if not Path(workspace_root_value).is_absolute():
            raise RuntimeError("Native managed HDR requires an absolute workspace root")
        if not llmrouter_value:
            raise RuntimeError("Native managed HDR requires an explicit LLMRouter URL")
        if not _TOKEN_RE.fullmatch(lrm_api_key):
            raise RuntimeError("Native managed HDR requires a valid LRM API key")
        if connector_config is None or not connector_config.is_absolute():
            raise RuntimeError("Native managed HDR requires an absolute Connector configuration path")
        if connector_reader_python is None or not connector_reader_python.is_absolute():
            raise RuntimeError("Native managed HDR requires an absolute Connector reader Python")
        if connector_reader_root is None or not connector_reader_root.is_absolute():
            raise RuntimeError("Native managed HDR requires an absolute Connector reader root")
        parsed = urlsplit(llmrouter_url)
        try:
            port = parsed.port
        except ValueError as exc:
            raise RuntimeError("Native managed HDR requires a fixed loopback LLMRouter URL") from exc
        if (
            parsed.scheme != "http"
            or parsed.hostname != "127.0.0.1"
            or port is None
            or not 1024 <= port <= 65535
            or parsed.path not in ("", "/")
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise RuntimeError("Native managed HDR requires a fixed loopback LLMRouter URL")
    return DeploymentPolicy(
        native_managed=managed,
        api_token=token,
        ready_token=ready_token,
        session_root=session_root,
        llmrouter_url=llmrouter_url,
        lrm_api_key=lrm_api_key,
        connector_config=connector_config,
        connector_reader_python=connector_reader_python,
        connector_reader_root=connector_reader_root,
        # Legacy/Container mode has no bound root and keeps its own data_paths semantics.
        workspace_root=Path(workspace_root_value) if managed else None,
    )


def _validate_managed_request(
    req: CreateSessionRequest, policy: DeploymentPolicy,
) -> tuple[AuthorizedFile, ...] | None:
    """Refuse managed overrides, then authorize ``data_paths`` against the bound root.

    Returns None in legacy mode. Refusals are typed and carry the entry index, never the path.
    """
    if not policy.native_managed:
        return None
    forbidden = [
        name
        for name, value in (
            ("session_root", req.session_root),
            ("tavily_api_key", req.tavily_api_key),
            ("llmrouter_url", req.llmrouter_url),
            ("cloud_llm", req.cloud_llm),
            ("local_llm", req.local_llm),
        )
        if value is not None
    ]
    if forbidden:
        raise HTTPException(
            status_code=400,
            detail=f"Native managed HDR rejects request overrides: {', '.join(forbidden)}",
        )
    if policy.workspace_root is None:
        raise RuntimeError("Native managed HDR has no bound workspace root")
    try:
        authorized = authorize_data_paths(req.data_paths, policy.workspace_root)
    except DataPathRefusal as refusal:
        logger.warning(
            "hybrid_dr.data_paths.refused reason=%s index=%s requested=%s",
            refusal.reason,
            refusal.index,
            len(req.data_paths),
        )
        raise HTTPException(
            status_code=400,
            detail={"code": "data_path_refused", "reason": refusal.reason, "index": refusal.index},
        ) from None
    if req.data_paths:
        logger.info(
            "hybrid_dr.data_paths.authorized count=%s requested=%s",
            len(authorized),
            len(req.data_paths),
        )
    return authorized


def _production_search_client(
    sid: str,
    req: CreateSessionRequest,
    policy: DeploymentPolicy,
) -> SearchClient:
    if policy.connector_config is not None:
        if policy.native_managed:
            connector = ConnectorSearchClient(
                config_path=policy.connector_config,
                session_id=sid,
                reader_python=policy.connector_reader_python,
                reader_root=policy.connector_reader_root,
            )
        else:
            connector = ConnectorSearchClient(
                config_path=policy.connector_config,
                session_id=sid,
            )
        return DegradingConnectorSearchClient(
            connector=connector
        )
    if policy.native_managed:
        raise RuntimeError("Native managed HDR requires a Connector configuration")
    return FallbackSearchClient(
        primary=TavilySearchClient(api_key=req.tavily_api_key or ""),
        fallback=DuckDuckGoSearchClient(),
    )


def _production_llm_client(
    sid: str,
    req: CreateSessionRequest,
    policy: DeploymentPolicy | None = None,
) -> LLMClient:
    return HTTPLLMClient(
        base_url=_llmrouter_url(req, policy),
        opencode_session_id=req.opencode_session_id,
        # Only set when the dispatching turn actually forwarded a
        # real OpenCode message id -- never a fallback -- so
        # llmrouter can trust X-Opencode-Message-Id at face value
        # (no id-shape guessing needed on that side).
        opencode_message_id=(req.opencode_message_id or "").strip() or None,
        # Always set (falls back to the sidecar's own session id)
        # purely for Langfuse trace grouping -- every call in this
        # run shares one trace regardless of whether a real message
        # id was available.
        hdr_run_id=(req.opencode_message_id or "").strip() or sid,
    )


def _llmrouter_url(
    req: CreateSessionRequest,
    policy: DeploymentPolicy | None = None,
) -> str:
    if policy is not None and policy.native_managed:
        return policy.llmrouter_url
    return (
        req.llmrouter_url
        or os.environ.get("HYBRID_DR_LLMROUTER_URL", "").strip()
        or "http://127.0.0.1:18321"
    ).rstrip("/")


def _probe_session_root(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    if not root.is_dir():
        raise OSError("session root is not a directory")
    probe = root / f".ready-{uuid.uuid4().hex}.tmp"
    try:
        with probe.open("xb") as stream:
            stream.write(b"ready")
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        probe.unlink(missing_ok=True)


async def _assert_managed_ready(policy: DeploymentPolicy) -> None:
    # Which dependency a 503 came from, so a miss after startup explains itself (#3658).
    dependency = "session_root"
    started = stage_started = time.monotonic()

    def enter(name: str) -> None:
        nonlocal dependency, stage_started
        dependency, stage_started = name, time.monotonic()

    try:
        async with asyncio.timeout(_MANAGED_READY_TIMEOUT_S):
            # Cancelling a thread wait cannot interrupt OS file I/O. Keep cleanup
            # in the worker's finally; the reader has its own bounded kill/reap.
            await asyncio.to_thread(_probe_session_root, policy.session_root)
            enter("connector_reader")
            if policy.connector_config is None:
                raise ValueError("Connector config is absent")
            connector = await asyncio.to_thread(
                ConnectorSearchClient,
                config_path=policy.connector_config,
                session_id="hdr-readiness",
                timeout_s=_READY_DEPENDENCY_TIMEOUT_S,
                reader_python=policy.connector_reader_python,
                reader_root=policy.connector_reader_root,
            )
            enter("connector")
            async with asyncio.timeout(_READY_DEPENDENCY_TIMEOUT_S):
                if not await connector.health():
                    raise ValueError("Connector is not ready")
            enter("lrm")
            async with asyncio.timeout(_READY_DEPENDENCY_TIMEOUT_S):
                # egress-surface: hdr_lrm_models_ready
                async with httpx.AsyncClient(
                    trust_env=False, timeout=_READY_DEPENDENCY_TIMEOUT_S,
                ) as client:
                    response = await client.get(
                        f"{policy.llmrouter_url}/v1/models",
                        headers={"Authorization": f"Bearer {policy.lrm_api_key}"},
                    )
                    response.raise_for_status()
    except (TimeoutError, OSError, ValueError, ConnectorSearchError, httpx.HTTPError) as exc:
        now = time.monotonic()
        logger.warning(
            "hybrid_dr.readiness.not_ready dependency=%s error_type=%s status=%s "
            "dependency_ms=%d elapsed_ms=%d",
            dependency,
            type(exc).__name__,
            exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else "-",
            round((now - stage_started) * 1000),
            round((now - started) * 1000),
        )
        raise HTTPException(status_code=503, detail="HDR dependencies are not ready") from exc


def make_app(deps: AppDeps | None = None) -> FastAPI:
    injected_deps = deps
    policy = _deployment_policy_from_env()

    app = FastAPI(
        title="hybrid_dr_orchestrator",
        version="0.1.0",
        docs_url="/docs",
        redoc_url=None,
    )

    @app.exception_handler(RequestValidationError)
    async def redact_request_validation_error(
        request: Request,
        exc: RequestValidationError,
    ) -> Response:
        if not policy.native_managed:
            return await request_validation_exception_handler(request, exc)
        detail = [
            {
                "loc": list(error.get("loc", ())),
                "type": str(error.get("type", "invalid_request")),
                "msg": "Invalid request field",
            }
            for error in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": detail})

    @app.middleware("http")
    async def authenticate_managed_request(
        request: Request,
        call_next: RequestResponseEndpoint,
    ) -> Response:
        if not policy.native_managed or request.url.path == "/healthz":
            return await call_next(request)
        authorization = request.headers.get("authorization", "")
        scheme, separator, credential = authorization.partition(" ")
        allowed_tokens = [policy.api_token]
        if request.method == "GET" and request.url.path == "/readyz":
            allowed_tokens.append(policy.ready_token)
        if (
            len(request.headers.getlist("authorization")) != 1
            or
            separator != " "
            or scheme.lower() != "bearer"
            or not credential.isascii()
            or not any(
                token is not None and hmac.compare_digest(
                    credential.encode("ascii"), token.encode("ascii"),
                )
                for token in allowed_tokens
            )
        ):
            logger.warning(
                "hybrid_dr.auth.failed method=%s",
                request.method,
            )
            return JSONResponse(
                status_code=401,
                content={"detail": "Unauthorized"},
                headers={"WWW-Authenticate": "Bearer"},
            )
        return await call_next(request)

    # In-memory session registry. Disk file is the source of truth across
    # restarts; this map is a cache for the current process.
    sessions: dict[str, PipelineState] = {}
    session_roots: dict[str, Path] = {}

    # Admission control (see module constants). A session holds one slot from
    # create until it reaches a terminal phase or is cancelled; `_admitted`
    # maps a holding sid to its last-activity time for stale-slot reclaim.
    _admission = asyncio.Semaphore(_MAX_CONCURRENT_SESSIONS)
    _admitted: dict[str, float] = {}
    _session_locks: dict[str, asyncio.Lock] = {}
    _cancel_requested: set[str] = set()
    _run_tasks: dict[str, asyncio.Task[None]] = {}
    _initializing: dict[str, asyncio.Task[Runner]] = {}
    _advancing: dict[str, asyncio.Task[PipelineState]] = {}
    _run_ids: dict[str, str] = {}
    _run_errors: dict[str, str] = {}

    def _touch(sid: str) -> None:
        if sid in _admitted:
            _admitted[sid] = time.monotonic()

    def _release_slot(sid: str) -> None:
        # Idempotent: only a session still holding a slot releases one.
        if _admitted.pop(sid, None) is not None:
            _admission.release()

    def _lock_for(sid: str) -> asyncio.Lock:
        lock = _session_locks.get(sid)
        if lock is None:
            lock = asyncio.Lock()
            _session_locks[sid] = lock
        return lock

    def _cancelled_state(state: PipelineState) -> PipelineState:
        return state.model_copy(
            update={
                "current_phase": Phase.CANCELLED,
                "extras": {**state.extras, "cancel_reason": "user_cancelled"},
            }
        )

    def _persist_cancelled(sid: str, state: PipelineState) -> PipelineState:
        cancelled = _cancelled_state(state)
        save_legacy(cancelled, _layout_for(sid).local_intermediate_dir)
        sessions[sid] = cancelled
        _cancel_requested.discard(sid)
        _release_slot(sid)
        return cancelled

    def _run_status_for(sid: str, state: PipelineState) -> str:
        task = _run_tasks.get(sid)
        if task is not None and not task.done():
            return "running"
        if state.current_phase is Phase.DONE:
            return "done"
        if state.current_phase is Phase.FAILED:
            return "failed"
        if state.current_phase is Phase.CANCELLED:
            return "cancelled"
        return "idle"

    def _forget_finished_run(sid: str) -> None:
        task = _run_tasks.get(sid)
        if task is not None and task.done():
            _run_tasks.pop(sid, None)

    def _persist_deadline_failure(sid: str, req: CreateSessionRequest) -> None:
        """Mark a run terminally FAILED because it blew its wall-clock budget,
        with a message the driver can surface instead of an endless 'still
        running' (issue #1633 Path B)."""
        sessions.pop(sid, None)
        reloaded = _load_state_or_404(sid, req)
        stuck_phase = reloaded.current_phase
        message = (
            f"Hybrid deep research exceeded its {_RUN_BUDGET_S:.0f}s time budget at "
            f"phase {stuck_phase.value}: the model or web-search backend is "
            f"temporarily slow or unreachable. No report was produced. Please retry."
        )
        # record_failure BEFORE flipping to FAILED so failed_phases names the
        # phase that actually stalled and the reason persists to disk via the
        # legacy dict's last_error (rc.3 repro 2026-07-29: state showed
        # current_phase=failed with failed_phases=[] and no reason anywhere,
        # so the driver could only say "failed at phase failed").
        failed = reloaded
        if not failed.is_terminal():
            failed = failed.record_failure(stuck_phase, message)
        failed = failed.model_copy(update={"current_phase": Phase.FAILED})
        save_legacy(failed, _layout_for(sid, req).local_intermediate_dir)
        sessions[sid] = failed
        _run_errors[sid] = message
        _cancel_requested.discard(sid)
        _release_slot(sid)
        logger.warning(
            "hybrid_dr.run.deadline session_id=%s phase=%s budget_s=%s",
            sid,
            stuck_phase.value,
            _RUN_BUDGET_S,
        )

    def _persist_run_failure(sid: str, req: CreateSessionRequest, message: str) -> PipelineState:
        try:
            sessions.pop(sid, None)
            failed = _load_state_or_404(sid, req)
            # Phase execution may already have recorded its failure. Initialization
            # has not: persist its safe reason before making the session terminal.
            if not failed.is_terminal() and not failed.failed_phases:
                failed = failed.record_failure(failed.current_phase, message)
            failed = failed.model_copy(update={"current_phase": Phase.FAILED})
            save_legacy(failed, _layout_for(sid, req).local_intermediate_dir)
            sessions[sid] = failed
            _run_errors[sid] = message
            _cancel_requested.discard(sid)
            return failed
        finally:
            _release_slot(sid)

    async def _advance_once(
        sid: str,
        req: CreateSessionRequest,
        state: PipelineState,
        budget: float,
        authorized: tuple[AuthorizedFile, ...] | None,
    ) -> PipelineState:
        async with asyncio.timeout(budget):
            task = asyncio.create_task(_runner_for(sid, req=req, authorized=authorized))
            _initializing[sid] = task
            try:
                runner = await task
            except Exception as exc:
                # Do not pass constructor exceptions to _summarize_exc: reader
                # stderr, arbitrary paths and Connector keys are not safe text.
                logger.warning(
                    "hybrid_dr.run.init_failed session_id=%s error_type=%s", sid, type(exc).__name__,
                )
                if isinstance(exc, ConnectorConfigUnavailable):
                    raise RuntimeError(
                        "Web search configuration could not be loaded. Please retry."
                    ) from None
                raise RuntimeError("Hybrid deep research initialization failed. Please retry.") from None
            finally:
                _initializing.pop(sid, None)
            if sid in _cancel_requested:
                raise asyncio.CancelledError
            phase_task = asyncio.create_task(runner.advance(state))
            _advancing[sid] = phase_task
            try:
                return await phase_task
            finally:
                if _advancing.get(sid) is phase_task:
                    _advancing.pop(sid, None)

    async def _background_run(
        sid: str,
        req: CreateSessionRequest,
        authorized: tuple[AuthorizedFile, ...] | None,
    ) -> None:
        run_started = time.monotonic()
        try:
            for _ in range(32):
                _touch(sid)
                async with _lock_for(sid):
                    state = _load_state_or_404(sid, req)
                    if state.is_terminal():
                        _release_slot(sid)
                        return
                    if sid in _cancel_requested:
                        _persist_cancelled(sid, state)
                        return
                    remaining = _RUN_BUDGET_S - (time.monotonic() - run_started)
                    try:
                        if remaining <= 0:
                            raise TimeoutError
                        # Initialization and phase execution consume the same
                        # remaining wall-clock budget, not independent allowances.
                        state = await _advance_once(sid, req, state, remaining, authorized)
                    except asyncio.CancelledError:
                        _persist_cancelled(sid, state)
                        return
                    except TimeoutError:
                        if sid in _cancel_requested:
                            _persist_cancelled(sid, state)
                        else:
                            _persist_deadline_failure(sid, req)
                        return
                    except Exception as exc:
                        if sid in _cancel_requested:
                            _persist_cancelled(sid, state)
                        else:
                            _persist_run_failure(sid, req, _summarize_exc(exc))
                        return
                    if sid in _cancel_requested:
                        _persist_cancelled(sid, state)
                        return
                    sessions[sid] = state
                    if state.is_terminal():
                        _release_slot(sid)
                        return
            async with _lock_for(sid):
                state = _load_state_or_404(sid, req)
                message = "background run exceeded max advance budget"
                failed = state
                if not failed.is_terminal():
                    failed = failed.record_failure(failed.current_phase, message)
                failed = failed.model_copy(update={"current_phase": Phase.FAILED})
                save_legacy(failed, _layout_for(sid, req).local_intermediate_dir)
                sessions[sid] = failed
                _run_errors[sid] = message
                _release_slot(sid)
        except asyncio.CancelledError:
            async with _lock_for(sid):
                state = _load_state_or_404(sid, req)
                if not state.is_terminal():
                    _persist_cancelled(sid, state)
        finally:
            _release_slot(sid)
            _run_tasks.pop(sid, None)

    def _reclaim_stale_slots() -> None:
        now = time.monotonic()
        for sid, last in list(_admitted.items()):
            if now - last > _SESSION_STALE_S:
                _release_slot(sid)

    # ───── helpers ────────────────────────────────────────────────────

    def _session_root_from(req: CreateSessionRequest | None = None) -> Path:
        if injected_deps is not None:
            return deps.session_root
        if policy.native_managed:
            return policy.session_root
        if req and req.session_root and req.session_root.strip():
            return Path(req.session_root)
        return policy.session_root

    def _layout_for(sid: str, req: CreateSessionRequest | None = None) -> SessionLayout:
        if not _SESSION_ID_RE.fullmatch(sid):
            raise HTTPException(status_code=404, detail="session not found")
        root = session_roots.get(sid) or _session_root_from(req)
        session_roots[sid] = root
        session_dir = root / sid
        if policy.native_managed:
            resolved_root = policy.session_root.resolve()
            resolved_session = session_dir.resolve()
            try:
                resolved_session.relative_to(resolved_root)
            except ValueError as exc:
                raise HTTPException(status_code=404, detail="session not found") from exc
            if resolved_session == resolved_root:
                raise HTTPException(status_code=404, detail="session not found")
        return SessionLayout(root_dir=session_dir)

    def _load_state_or_404(sid: str, req: CreateSessionRequest | None = None) -> PipelineState:
        if sid in sessions:
            return sessions[sid]
        state = load_legacy(_layout_for(sid, req).local_intermediate_dir)
        if state is None:
            raise HTTPException(status_code=404, detail=f"session {sid!r} not found")
        sessions[sid] = state
        return state

    async def _runner_for(
        sid: str,
        *,
        req: CreateSessionRequest,
        authorized: tuple[AuthorizedFile, ...] | None,
    ) -> Runner:
        # Resolve registry-backed layout on the event loop. The worker only
        # constructs clients/runner; it must never advance or persist a session
        # after cancellation/timeout abandons its result. The production reader
        # separately bounds its subprocess and cleanup; cancelling to_thread
        # cannot interrupt synchronous OS work already underway.
        layout = _layout_for(sid, req)
        session_cfg = _session_cfg_from(req, policy, authorized)

        def build_runner() -> Runner:
            llm = (
                injected_deps.llm
                if injected_deps is not None
                 else _production_llm_client(sid, req, policy)
            )
            search = (
                injected_deps.search
                if injected_deps is not None
                else _production_search_client(sid, req, policy)
            )
            return Runner(
                layout=layout,
                session_config=session_cfg,
                llm=llm,
                search=search,
                # Injected test dependencies retain fail-fast execution.
                phase_max_retries=0 if injected_deps is not None else _PHASE_MAX_RETRIES,
            )

        return await asyncio.to_thread(build_runner)

    # ───── routes ─────────────────────────────────────────────────────

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok", "version": app.version}

    @app.get("/readyz")
    async def readyz() -> dict[str, str]:
        if policy.native_managed:
            await _assert_managed_ready(policy)
        return {"status": "ready", "mode": "native_managed" if policy.native_managed else "legacy"}

    @app.post(
        "/v1/hybrid-dr/sessions",
        response_model=CreateSessionResponse,
        status_code=201,
    )
    async def create_session(req: CreateSessionRequest) -> CreateSessionResponse:
        _validate_managed_request(req, policy)
        # Admission gate: reclaim slots from abandoned sessions, then block
        # until one is free so the new DR starts only when it can run without
        # cloud contention. `postJson` on the driver side has no client
        # timeout, so a multi-minute queue wait here is safe.
        _reclaim_stale_slots()
        await _admission.acquire()
        sid = "ses_" + uuid.uuid4().hex[:24]
        try:
            state = PipelineState(
                task_id=req.task_id or sid,
                task_class=req.task_class,
                privacy_tier=req.privacy_tier,
            )
            layout = _layout_for(sid, req)
            layout.local_intermediate_dir.mkdir(parents=True, exist_ok=True)
            save_legacy(state, layout.local_intermediate_dir)
        except Exception:
            _admission.release()
            raise
        _admitted[sid] = time.monotonic()
        sessions[sid] = state
        return CreateSessionResponse(
            session_id=sid,
            root_dir=str(layout.root_dir),
            state=state.to_legacy_dict(),
        )

    @app.get(
        "/v1/hybrid-dr/sessions/{sid}/state",
        response_model=StateResponse,
    )
    def get_state(sid: str) -> StateResponse:
        state = _load_state_or_404(sid)
        return StateResponse(session_id=sid, state=state.to_legacy_dict())

    @app.post(
        "/v1/hybrid-dr/sessions/{sid}/advance",
        response_model=AdvanceResponse,
    )
    async def advance(sid: str, req: CreateSessionRequest) -> AdvanceResponse:
        authorized = _validate_managed_request(req, policy)
        task = _run_tasks.get(sid)
        if task is not None and not task.done():
            raise HTTPException(status_code=409, detail=f"session {sid!r} is running in background")
        _touch(sid)
        async with _lock_for(sid):
            state = _load_state_or_404(sid, req)
            if state.is_terminal():
                _release_slot(sid)
                return AdvanceResponse(session_id=sid, state=state.to_legacy_dict())
            if sid in _cancel_requested:
                cancelled = _persist_cancelled(sid, state)
                return AdvanceResponse(session_id=sid, state=cancelled.to_legacy_dict())
            try:
                state = await _advance_once(sid, req, state, _RUN_BUDGET_S, authorized)
                if sid in _cancel_requested:
                    cancelled = _persist_cancelled(sid, state)
                    return AdvanceResponse(session_id=sid, state=cancelled.to_legacy_dict())
                sessions[sid] = state
                if state.is_terminal():
                    _release_slot(sid)
                return AdvanceResponse(session_id=sid, state=state.to_legacy_dict())
            except asyncio.CancelledError:
                cancelled = _persist_cancelled(sid, state)
                return AdvanceResponse(session_id=sid, state=cancelled.to_legacy_dict())
            except Exception as exc:
                if sid in _cancel_requested:
                    cancelled = _persist_cancelled(sid, state)
                    return AdvanceResponse(session_id=sid, state=cancelled.to_legacy_dict())
                if isinstance(exc, TimeoutError):
                    _persist_deadline_failure(sid, req)
                    failed = sessions[sid]
                else:
                    failed = _persist_run_failure(sid, req, _summarize_exc(exc))
                return AdvanceResponse(
                    session_id=sid,
                    state=failed.to_legacy_dict(),
                    error=_run_errors[sid],
                )

    @app.post(
        "/v1/hybrid-dr/sessions/{sid}/run",
        response_model=RunResponse,
    )
    async def run_to_terminal(sid: str, req: CreateSessionRequest) -> RunResponse:
        authorized = _validate_managed_request(req, policy)
        _touch(sid)
        _forget_finished_run(sid)
        state = _load_state_or_404(sid, req)
        if state.is_terminal():
            return RunResponse(
                session_id=sid,
                run_id=_run_ids.get(sid),
                status=_run_status_for(sid, state),
                state=state.to_legacy_dict(),
                error=_run_errors.get(sid),
            )
        task = _run_tasks.get(sid)
        if task is None:
            _run_ids[sid] = "run_" + uuid.uuid4().hex[:24]
            _run_errors.pop(sid, None)
            _run_tasks[sid] = asyncio.create_task(_background_run(sid, req, authorized))
        return RunResponse(
            session_id=sid,
            run_id=_run_ids.get(sid),
            status="running",
            state=state.to_legacy_dict(),
        )

    @app.get(
        "/v1/hybrid-dr/sessions/{sid}/run",
        response_model=RunResponse,
    )
    def get_run(sid: str) -> RunResponse:
        _forget_finished_run(sid)
        state = _load_state_or_404(sid)
        return RunResponse(
            session_id=sid,
            run_id=_run_ids.get(sid),
            status=_run_status_for(sid, state),
            state=state.to_legacy_dict(),
            error=_run_errors.get(sid),
        )

    @app.post("/v1/hybrid-dr/sessions/{sid}/cancel")
    async def cancel(sid: str) -> dict[str, Any]:
        _load_state_or_404(sid)
        _cancel_requested.add(sid)
        initializing = _initializing.get(sid)
        if initializing is not None:
            initializing.cancel()
        advancing = _advancing.get(sid)
        if advancing is not None:
            advancing.cancel()
        run_task = _run_tasks.get(sid)
        if run_task is not None and not run_task.done():
            run_task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(run_task), timeout=_CANCEL_WAIT_S)
            except asyncio.CancelledError:
                pass
            except TimeoutError as exc:
                raise HTTPException(
                    status_code=503,
                    detail="HDR cancellation did not complete in time",
                ) from exc
        lock = _lock_for(sid)
        if not lock.locked():
            async with lock:
                state = _load_state_or_404(sid)
                if not state.is_terminal():
                    _persist_cancelled(sid, state)
        return {"session_id": sid, "cancelled": True}

    return app


# ───── helpers ─────────────────────────────────────────────────────────


def _session_cfg_from(
    req: CreateSessionRequest,
    policy: DeploymentPolicy | None = None,
    managed_inputs: tuple[AuthorizedFile, ...] | None = None,
) -> SessionConfig:
    if policy is not None and policy.native_managed:
        # Managed mode reads only validated files, never the request's raw paths.
        managed_inputs = managed_inputs or ()
        data_paths = [file.path for file in managed_inputs]
    else:
        managed_inputs = None
        data_paths = [Path(p) for p in req.data_paths if p.strip()]
    legacy_base_url = _llmrouter_url(req, policy) + "/v1"
    cloud_llm = req.cloud_llm
    local_llm = req.local_llm
    if cloud_llm is None:
        cloud_llm = LLMEndpointConfig(
            base_url=legacy_base_url,
            model=req.cloud_model or "cloud-model",
        )
    if local_llm is None:
        local_llm = LLMEndpointConfig(
            base_url=legacy_base_url,
            model="local-model",
        )
    return SessionConfig(
        user_query=req.user_query,
        data_paths=data_paths,
        title=req.title,
        cloud_model=req.cloud_model,
        cloud_llm=cloud_llm,
        local_llm=local_llm,
        managed_inputs=managed_inputs,
    )


__all__ = ["AppDeps", "make_app"]
