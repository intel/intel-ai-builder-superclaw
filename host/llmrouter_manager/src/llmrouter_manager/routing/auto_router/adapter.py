"""Latency router adapter — wraps the trained ``latentfactorrouter`` for ``auto`` dispatch.

The adapter loads the trained ``latentfactorrouter`` pickle + PCA reducer
and exposes a single method, ``resolve_auto(query) -> str | RouterFailure``:

- On success it returns a string alias (``"local-model"`` or ``"cloud-model"``)
  picked by the latency router for that query.
- On any failure (no pickle, no PCA, no edge slot, embedding endpoint down,
  predict raises, predicted name not in ``router_model_map.json``) it returns
  a ``RouterFailure`` descriptor; the caller decides what to do with it.

Caller policy at the proxy level (``routing/proxy.py::chat_completions``) —
graceful fallback per Decision #9 of the redesign plan:

- Invoke the adapter ONLY when both cloud-model and the local slot are
  configured (otherwise there is nothing to decide between).
- On ``RouterFailure``, log a warning and fall back to ``cloud-model`` —
  ``auto`` must produce a working result whenever at least one slot is
  configured. The only 503 path is when neither slot is configured.

Two artefacts ship with the package under ``llmrouter_manager/data/``:
- ``latent_factor_artefacts.pkl`` — the trained ``LatentFactorModel`` bundle
- ``pca_model.pkl`` — the sklearn ``PCA`` reducing raw edge embeddings to the
  dim the latent model was trained on

Per-user overrides at ``%LOCALAPPDATA%/SuperClaw/llmrouter_manager/state/``
take priority over the shipped artefacts so retrained models can be A/B-tested
without reinstalling.
"""

from __future__ import annotations

import errno
import json
import pickle
import sys
import threading
import time
import warnings
from pathlib import Path
from typing import Any, NamedTuple

import joblib
import numpy as np
from loguru import logger
from opentelemetry.trace import get_current_span

from ...common.events import EventType, record_event, should_write
from ...telemetry import tracing

from . import _runtime_stubs  # noqa: F401  must run before any latentfactorrouter import


_AUTO_ROUTER_DIR = Path(__file__).parent
_DATA_DIR = _AUTO_ROUTER_DIR.parent.parent / "data"
_PKL_NAME = "latent_factor_artefacts.pkl"
_PCA_NAME = "pca_model.pkl"


class RouterFailure(NamedTuple):
    """Failure descriptor returned by ``resolve_auto``.

    Carries an ``error`` code (one of the documented failure modes) and a
    human-readable ``hint``. The proxy logs these and falls back to
    ``cloud-model`` rather than surfacing them as HTTP errors.
    """

    error: str
    hint: str


_MAX_RECORDED_SCORES = 8


def _score_map(result: dict[str, Any] | None) -> dict[str, float] | None:
    """``{model_name: balance_score}`` for the top few candidates.

    ``route_single`` returns ``selected_models`` / ``balance_scores`` as parallel
    lists, already ordered best-first; the short-circuit paths return them empty.
    Truncated to ``_MAX_RECORDED_SCORES`` and coerced to plain floats so a numpy
    scalar does not land in the store as a string. Only ever called once the
    caller knows the row will be written — see ``_record_route_decision``.
    """
    if not isinstance(result, dict):
        return None
    names = result.get("selected_models") or []
    scores = result.get("balance_scores") or []
    if not names or not scores:
        return None
    out: dict[str, float] = {}
    for name, score in list(zip(names, scores))[:_MAX_RECORDED_SCORES]:
        try:
            out[str(name)] = float(score)
        except (TypeError, ValueError):
            continue
    return out or None


def _record_route_decision(
    chose: str,
    *,
    predicted: str | None,
    perf_weight: float | None,
    short_circuit: str | None = None,
    result: dict[str, Any] | None = None,
    route_ms: int | None = None,
) -> None:
    """Typed row beside the ``[LatencyRouter]`` log lines below.

    ``scores`` is resolved lazily: building it walks the candidate panel, and
    ``auto`` runs this on every request, so nothing is computed unless the
    ``info`` severity is actually being written
    (``SUPERCLAW_DEBUG_OBSERVABILITY=1``). ``record_event`` swallows its own
    errors, so this can never cost a route.
    """
    scores = _score_map(result) if should_write("info") else None
    record_event(
        EventType.ROUTE_DECISION,
        attrs={
            "chose": chose,
            "predicted": predicted,
            "perf_weight": perf_weight,
            "short_circuit": short_circuit,
            "scores": scores,
            "route_ms": route_ms,
        },
    )


class _PcaEdgeEmbedder:
    """Embedder shim that satisfies ``LatentFactorRouter._embed`` while keeping
    SuperClaw's SERVED-URL embedding.

    The router calls ``self.embedder.batch(queries)`` and expects vectors in the
    space the latent model was trained on (post-PCA). SuperClaw embeds via the
    edge ``/embeddings`` HTTP endpoint (raw space), then reduces with the shipped
    PCA — exactly what the old adapter did inline. This wrapper composes the two
    so the router's ``route_single`` → ``_route_query`` → ``predict`` chain runs
    unchanged, with no in-process OpenVINO.
    """

    def __init__(self, edge_client: Any, pca_model: Any) -> None:
        self._edge = edge_client
        self._pca = pca_model

    def batch(self, queries: list[str]) -> list[list[float]]:
        raw = self._edge.batch(queries)
        if not raw or not raw[0]:
            raise RuntimeError("edge /embeddings returned empty result")
        reduced = self._pca.transform(np.asarray(raw, dtype=np.float32))
        return reduced.tolist()


def _install_legacy_module_aliases() -> None:
    """Alias legacy module names to our canonical package so ``pickle.load``
    finds the class by its saved module path.

    Shipped artefacts have been saved under two legacy layouts:
      * ``latentfactorrouter.*``               (older vendored layout)
      * ``custom_routers.latentfactorrouter.*`` (routing_service training repo)
    After vendoring, the classes live at
    ``llmrouter_manager.routing.auto_router.latentfactorrouter.*``. Registering
    both legacy paths in ``sys.modules`` lets either artefact deserialize.
    """
    if "latentfactorrouter.latent_factor_model" in sys.modules:
        return
    from llmrouter_manager.routing.auto_router import latentfactorrouter as _lfr
    from llmrouter_manager.routing.auto_router.latentfactorrouter import (
        latent_factor_model as _lfm,
    )

    # Legacy layout 1: latentfactorrouter.*
    sys.modules["latentfactorrouter"] = _lfr
    sys.modules["latentfactorrouter.latent_factor_model"] = _lfm

    # Legacy layout 2: custom_routers.latentfactorrouter.* (routing_service
    # training repo — the current artefact bundle at D:/routing_service/artefacts).
    import types

    if "custom_routers" not in sys.modules:
        sys.modules["custom_routers"] = types.ModuleType("custom_routers")
    sys.modules["custom_routers.latentfactorrouter"] = _lfr
    sys.modules["custom_routers.latentfactorrouter.latent_factor_model"] = _lfm


def _default_pickle_paths() -> tuple[Path | None, Path | None]:
    """Resolve ``(artefacts_path, pca_path)``. Per-user state has priority over shipped.

    Returns ``(None, None)`` if either file is missing — caller treats as fail-shipped.
    """
    artefact_candidates: list[Path] = []
    pca_candidates: list[Path] = []
    try:
        from ...common.state import default_state_root

        artefact_candidates.append(default_state_root() / _PKL_NAME)
        pca_candidates.append(default_state_root() / _PCA_NAME)
    except Exception:
        pass
    artefact_candidates.append(_DATA_DIR / _PKL_NAME)
    pca_candidates.append(_DATA_DIR / _PCA_NAME)

    def _first(candidates: list[Path]) -> Path | None:
        for p in candidates:
            if p.exists():
                return p
        return None

    return _first(artefact_candidates), _first(pca_candidates)


def _is_transient_load_error(exc: Exception) -> bool:
    """Retry only explicit temporary I/O errors, including Windows file locks."""
    return isinstance(exc, OSError) and (
        exc.errno in {errno.EAGAIN, errno.EBUSY, errno.EINTR, errno.ETIMEDOUT}
        or getattr(exc, "winerror", None) in {32, 33}  # Sharing / lock violation.
    )


def _load_router_map() -> dict[str, str]:
    """Load the trained-name → alias map; propagate transient I/O, else empty on failure."""
    map_path = _DATA_DIR / "router_model_map.json"
    try:
        with open(map_path, encoding="utf-8") as f:
            data = json.load(f)
        return {k: v for k, v in data.items() if not k.startswith("_")}
    except Exception as exc:
        logger.warning("[LatencyRouter] router_model_map.json load failed: {}", exc)
        if _is_transient_load_error(exc):
            raise
        return {}


class LatencyRouterAdapter:
    """Trained latency router facade: ``query -> alias | RouterFailure``.

    First ``resolve_auto`` call lazy-loads artefacts + PCA + map. Explicit temporary I/O errors allow another attempt on the next call; other load failures stay cached until process restart.

    Per-call failure modes (no edge / embedding down / predict raises /
    unmapped prediction) are NOT sticky — each call re-evaluates them.

    The proxy invokes this adapter ONLY when both cloud-model and the local
    slot are configured. ``RouterFailure`` at the adapter level becomes a
    graceful fall-back-to-cloud-model at the proxy level (NOT a 503).
    """

    # Default performance weight when neither persisted nor set (plan §13:
    # single global default of 0.7, quality-leaning).
    _DEFAULT_PERF_WEIGHT = 0.7

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._loaded = False
        self._load_failure: RouterFailure | None = None
        self._latent_model: Any = None
        self._pca_model: Any = None
        self._available_models: list[str] = []
        self._map: dict[str, str] = {}
        from .embedding_client import EdgeEmbeddingClient

        self._EdgeEmbeddingClient = EdgeEmbeddingClient
        # Worker-local routers/clients keep embedding I/O concurrent; read-only model/PCA state stays shared.
        self._thread_state = threading.local()
        # Live perf/cost balance weight. Seeded lazily from the persisted value
        # (Store config key) on first read; set live via set_perf_weight.
        self._perf_weight: float | None = None

    # ── perf_weight (quality-vs-cost balance dial; plan §12) ─────────────────
    def get_perf_weight(self) -> float:
        """Current performance weight in [0, 1]. Seeds from the persisted value
        (Store) once, then defaults to ``_DEFAULT_PERF_WEIGHT``."""
        with self._lock:
            if self._perf_weight is None:
                self._perf_weight = self._load_persisted_perf_weight()
            return float(self._perf_weight)

    def set_perf_weight(self, perf_weight: float) -> float:
        """Live-update the balance weight (clamped [0,1]). Returns the applied
        value. Does NOT persist — the endpoint persists first, then calls this."""
        with self._lock:
            pw = max(0.0, min(1.0, float(perf_weight)))
            self._perf_weight = pw
            logger.info("[LatencyRouter] perf_weight updated -> {:.3f}", pw)
            return pw

    def _load_persisted_perf_weight(self) -> float:
        """Read the persisted perf_weight from the Store KV, else the default.
        Never raises — a missing/invalid value falls back to the default."""
        try:
            from ...common.store import Store, default_db_path

            store = Store(default_db_path())
            try:
                raw = store.get_config("perf_weight")
            finally:
                store.close()
            if raw is not None:
                return max(0.0, min(1.0, float(raw)))
        except Exception:  # noqa: BLE001
            pass
        return self._DEFAULT_PERF_WEIGHT

    def _ensure_loaded(self) -> RouterFailure | None:
        with self._lock:
            if self._loaded:
                return self._load_failure

            pkl, pca = _default_pickle_paths()
            if pkl is None:
                self._load_failure = RouterFailure(
                    "router_model_not_shipped",
                    f"latent_factor_artefacts.pkl not found at {_DATA_DIR} or per-user state",
                )
                self._loaded = True
                return self._load_failure
            if pca is None:
                self._load_failure = RouterFailure(
                    "router_pca_not_shipped",
                    f"pca_model.pkl not found at {_DATA_DIR} or per-user state",
                )
                self._loaded = True
                return self._load_failure
            try:
                _install_legacy_module_aliases()
                with open(pkl, "rb") as f:
                    bundle = pickle.load(f)
                latent_model = bundle["latent_model"]
                available_models = list(bundle["available_models"])
            except Exception as exc:
                logger.exception("[LatencyRouter] artefact load failed: {}", pkl)
                self._load_failure = RouterFailure(
                    "router_artefacts_load_failed",
                    f"loading {pkl}: {exc}",
                )
                self._loaded = not _is_transient_load_error(exc)
                return self._load_failure
            try:
                with warnings.catch_warnings(record=True) as load_warnings:
                    warnings.simplefilter("always")
                    pca_model = joblib.load(str(pca))
            except Exception as exc:
                logger.exception("[LatencyRouter] PCA model load failed: {}", pca)
                self._load_failure = RouterFailure(
                    "router_pca_load_failed",
                    f"loading {pca}: {exc}",
                )
                self._loaded = not _is_transient_load_error(exc)
                return self._load_failure
            for warning in load_warnings:
                logger.warning(
                    "[LatencyRouter] startup.nonfatal PCA compatibility warning "
                    "category={} detail={}",
                    warning.category.__name__,
                    warning.message,
                )
            try:
                model_map = _load_router_map()
            except OSError as exc:
                self._load_failure = RouterFailure(
                    "router_map_load_failed",
                    f"loading router_model_map.json: {exc}",
                )
                self._loaded = not _is_transient_load_error(exc)
                return self._load_failure
            if not model_map:
                self._load_failure = RouterFailure(
                    "router_map_missing",
                    "router_model_map.json missing or empty",
                )
                self._loaded = True
                return self._load_failure

            self._latent_model = latent_model
            self._available_models = available_models
            self._pca_model = pca_model
            self._map = model_map
            self._load_failure = None
            self._loaded = True
            logger.info(
                "[LatencyRouter] loaded artefacts ({} models, PCA input_dim={} -> {} components) + map ({} entries) from {}",
                len(self._available_models),
                getattr(self._pca_model, "n_features_in_", "?"),
                getattr(self._pca_model, "n_components_", "?"),
                len(self._map),
                pkl,
            )
            return None

    def _get_edge_config(self) -> dict | None:
        from ...edge import config as edge_config

        return edge_config.get()

    def _local_provider(self) -> str | None:
        """Persisted local-provider selection (``"llamacpp"`` | ``"edge"`` | None)."""
        try:
            from ...common.store import Store, default_db_path
            from ...local.selections import get_local_provider

            store = Store(default_db_path())
            try:
                return get_local_provider(store)
            finally:
                store.close()
        except Exception:  # noqa: BLE001
            return None

    def _resolve_configured_local_model(self) -> str:
        """Return the model name the router should treat as "configured local"
        for gating (``_configured_excluded_models``). Follows the local-provider
        selection so gating tracks the LLM source, mirroring
        ``_resolve_embedder_cfg``:

          * ``llamacpp`` → Store's ``active_chat_model_id`` (the llama-server
            model actually loaded — e.g. ``qwen3.5-9b``).
          * ``edge``     → edge_config.model_name (e.g. ``qwen3-coder-next``).
          * unset        → fall back to the router's env-based lookup
            (``LOCAL_LLM_MODEL`` / ``LOCAL_LLM_MODELS``) — preserves the
            router.py default for standalone/CLI use.

        Prevents the bug where the router pins gating to the edge server's
        model name even when the host is serving via llamacpp — which caused
        ``configured local model 'qwen3-coder-next-80b-awq-02' did not match
        any trained label`` and made local exclusions no-op, so a llamacpp-
        served qwen3.5-9b query could score-lose to the panel's larger
        qwen3-coder-next label.
        """
        provider = self._local_provider()
        if provider == "llamacpp":
            try:
                from ...common.store import Store, default_db_path

                store = Store(default_db_path())
                try:
                    model_id = store.get_config("active_chat_model_id")
                finally:
                    store.close()
                if model_id:
                    return str(model_id)
            except Exception:  # noqa: BLE001
                pass
            return ""
        if provider == "edge":
            edge_cfg = self._get_edge_config()
            if edge_cfg:
                return str(edge_cfg.get("model_name", ""))
            return ""
        # No provider selected — let the router's env-based default apply.
        import os
        cfg = (os.environ.get("LOCAL_LLM_MODEL") or "").strip()
        if cfg:
            return cfg
        models_env = (os.environ.get("LOCAL_LLM_MODELS") or "").strip()
        if models_env:
            return models_env.split(",")[0].strip()
        return ""

    def _llamacpp_embedder_cfg(self) -> tuple[str, str, str] | None:
        """(base_url, api_key, model) for the LOCAL llama-router's embedding
        model, or None if no active embedding model. Mirrors proxy.
        _load_local_model_config's port resolution — the same llama-server that
        serves the local chat model also serves the embedding model (KaLM), so
        auto embeds through it when the local provider is ``llamacpp``."""
        try:
            import os

            from ...common.store import Store, default_db_path
            from ...local.llama_auth import llama_api_key

            store = Store(default_db_path())
            try:
                model_id = store.get_config("active_embedding_model_id")
            finally:
                store.close()
            if not model_id:
                return None
            port = int(os.environ.get("LLAMA_ROUTER_PORT", "18103"))
            return (f"http://127.0.0.1:{port}/v1", llama_api_key(), str(model_id))
        except Exception:  # noqa: BLE001
            return None

    def _resolve_embedder_cfg(self) -> tuple[str, str, str, bool] | None:
        """(base_url, api_key, model, is_local) from the committed Primary Bundle."""
        try:
            from ...common.store import Store, default_db_path
            from ..primary_bundle import resolve_primary

            store = Store(default_db_path())
            try:
                upstream = resolve_primary(type("State", (), {"store": store})(), role="embedding")
            finally:
                store.close()
        except Exception:  # noqa: BLE001
            return None
        if upstream is None:
            return None
        return (
            upstream.base_url,
            upstream.api_key,
            upstream.model_id,
            upstream.backend == "llama",
        )

    def _get_embedder(self) -> Any | None:
        cfg = self._resolve_embedder_cfg()
        if cfg is None or not cfg[0]:
            return None
        is_local = cfg[3]
        cache_key = cfg
        embedder = getattr(self._thread_state, "embedder", None)
        if getattr(self._thread_state, "embedder_cache_key", None) != cache_key:
            if embedder is not None:
                try:
                    embedder.close()
                except Exception:
                    pass
            embedder = self._EdgeEmbeddingClient(
                base_url=cfg[0],
                api_key=cfg[1],
                model_name=cfg[2],
                is_local=is_local,
            )
            self._thread_state.embedder = embedder
            self._thread_state.embedder_cache_key = cache_key
        return embedder

    def _build_router(self, edge_client: Any) -> Any:
        """Construct a LatentFactorRouter that drives the merged route_single()
        scoring, with SuperClaw's served-URL embedding injected.

        Built via ``object.__new__`` to bypass the heavy config/data-loading
        ``__init__`` — we already hold the trained ``latent_model`` +
        ``available_models`` from the bundle. Every attribute the
        ``route_single → _route_query → _score_models → _build_excluded_mask``
        chain reads is set here from the bundle + pool_metadata defaults. The
        embedder is a ``_PcaEdgeEmbedder`` so ``router._embed`` returns
        post-PCA vectors from the edge endpoint (no in-process OpenVINO).

        Rebuilt whenever the edge embedder changes; perf_weight is refreshed
        on every ``resolve_auto`` so the live dial (plan §12) takes effect.
        """
        from .latentfactorrouter.router import LatentFactorRouter

        r = object.__new__(LatentFactorRouter)
        # Trained artefacts (already loaded).
        r._latent_model = self._latent_model
        r._available_models = list(self._available_models)
        r._is_trained = True
        # Served-URL embedding + PCA, wrapped so _embed() returns trained space.
        r.embedder = _PcaEdgeEmbedder(edge_client, self._pca_model)
        # Scoring knobs (route_single reads these). perf_weight is refreshed
        # per call in resolve_auto; cost_weight derived alongside.
        r._perf_weight = self.get_perf_weight()
        r._cost_weight = 1.0 - r._perf_weight
        r.top_k = 1
        r.budget_limit = None
        r.min_acc_thresh = 0.0
        # Configured-model gating + capability scaling. Load pool_metadata the
        # same way the real __init__ does; degrade to empty on any failure so a
        # missing file never breaks routing (just disables gating/scaling).
        try:
            meta = LatentFactorRouter._load_pool_metadata()
        except Exception:  # noqa: BLE001
            meta = {}
        r._local_meta = {
            e["label"]: {"size_b": float(e["size_b"]),
                         "family": str(e["family"]).casefold()}
            for e in meta.get("locals", [])
        }
        r._LOCAL_MODELS = tuple(r._local_meta.keys())
        r._EXCLUDED_CLOUD_MODELS = tuple(meta.get("excluded_clouds", []))
        # Override the router's env-based configured-model lookup so gating
        # follows the local-provider selection. Router base class reads only
        # LOCAL_LLM_MODEL from os.environ; on SuperClaw that leaks the edge
        # server's model name (e.g. ``qwen3-coder-next-80b-awq-02``) into
        # llamacpp routing, disabling local exclusions.
        _configured = self._resolve_configured_local_model()
        r._configured_local_model = lambda _c=_configured: _c  # type: ignore[assignment]
        cap_cfg = meta.get("capability_scaling", {}) or {}
        r._capability_alpha = float(cap_cfg.get("alpha", 0.3))
        r._cross_family_scale = float(cap_cfg.get("cross_family_scale", 0.9))
        r._capability_scales = {}
        # Multi-turn ML state (topic-change detector reads these). Topic-change
        # detection is disabled here: the proxy manages session continuity, and
        # a stateful per-call router in the request path would need per-session
        # instances. Routing stays a pure per-query decision.
        r.last_request = ""
        r.last_route = ""
        r.last_history_embedding = None
        r._topic_change_enabled = False
        r._topic_change_threshold = 0.0
        return r

    def resolve_auto(self, query: str) -> str | RouterFailure:
        """Return alias on success, ``RouterFailure`` on any failure.

        Drives the merged ``LatentFactorRouter.route_single`` so scoring matches
        the routing_service benchmark exactly (perf/cost balance via
        ``_score_models`` + perf_weight extremes + capability scaling), while
        embedding stays on SuperClaw's served-URL path. On ``RouterFailure`` the
        proxy logs a warning and falls back to ``cloud-model``.
        """
        load_err = self._ensure_loaded()
        if load_err is not None:
            span = get_current_span()
            tracing.set_attributes(span, {"llmrouter.auto.failure_code": load_err.error})
            tracing.add_event(span, "load_failure", {"llmrouter.auto.failure_code": load_err.error})
            return load_err

        # perf_weight extremes hard-route WITHOUT embedding — mirrors
        # LatentFactorRouter.route_single (>= 1.0 → cloud, <= 0.0 → local). Done
        # here too so the edge embedder is not even constructed at the dial ends.
        pw = self.get_perf_weight()
        if pw >= 1.0:
            logger.info("[LatencyRouter] short-circuit -> cloud-model (perf_weight=1.0)")
            _record_route_decision(
                "cloud-model",
                predicted=None,
                perf_weight=pw,
                short_circuit="perf_weight=1.0",
            )
            return "cloud-model"
        if pw <= 0.0:
            logger.info("[LatencyRouter] short-circuit -> local-model (perf_weight=0.0)")
            _record_route_decision(
                "local-model",
                predicted=None,
                perf_weight=pw,
                short_circuit="perf_weight=0.0",
            )
            return "local-model"

        # Query embedding follows the local-provider selection (llamacpp → the
        # local llama-router's embedding model; edge → the edge endpoint). If
        # neither resolves an embedding endpoint, auto can't score → cloud.
        embedder = self._get_embedder()
        if embedder is None:
            span = get_current_span()
            tracing.set_attributes(span, {"llmrouter.auto.failure_code": "auto_requires_embedder"})
            return RouterFailure(
                "auto_requires_embedder",
                "model=auto needs a query-embedding endpoint: select a local "
                "provider (llamacpp with an embedding model, or a configured "
                "edge server).",
            )
        edge_client = embedder

        # Build (or rebuild if the edge client changed) the scoring router and
        # refresh the live perf_weight so the GUI dial takes effect immediately.
        router = getattr(self._thread_state, "router", None)
        if router is None or router.embedder._edge is not edge_client:
            router = self._thread_state.router = self._build_router(edge_client)
        router._perf_weight = pw
        router._cost_weight = 1.0 - pw

        span = get_current_span()
        try:
            started = time.monotonic()
            result = router.route_single({"query": query})
            route_ms = int((time.monotonic() - started) * 1000)
            tracing.set_attributes(span, {"llmrouter.auto.route_ms": route_ms})
            tracing.add_event(span, "route_done", {"llmrouter.auto.route_ms": route_ms})
        except Exception as exc:  # noqa: BLE001
            tracing.set_attributes(span, {"llmrouter.auto.failure_code": "router_route_failed"})
            return RouterFailure(
                "router_route_failed",
                f"route_single raised: {exc}",
            )
        predicted = result.get("predicted_llm")
        if not predicted:
            tracing.set_attributes(span, {"llmrouter.auto.failure_code": "router_predict_failed"})
            return RouterFailure(
                "router_predict_failed",
                "route_single returned no prediction",
            )
        # route_single's perf_weight-extreme short-circuits return the coarse
        # sentinels _CLOUD_ROUTE / _LOCAL_ROUTE ("cloud" / "local"); map those
        # to aliases directly. Otherwise map the predicted panel name.
        if predicted == "cloud":
            _record_route_decision(
                "cloud-model",
                predicted=predicted,
                perf_weight=pw,
                short_circuit=result.get("short_circuit"),
                result=result,
                route_ms=route_ms,
            )
            return "cloud-model"
        if predicted == "local":
            _record_route_decision(
                "local-model",
                predicted=predicted,
                perf_weight=pw,
                short_circuit=result.get("short_circuit"),
                result=result,
                route_ms=route_ms,
            )
            return "local-model"
        alias = self._map.get(predicted)
        if alias is None:
            tracing.set_attributes(span, {"llmrouter.auto.failure_code": "router_predicted_unmapped"})
            return RouterFailure(
                "router_predicted_unmapped",
                f"router predicted {predicted!r}; not in router_model_map.json",
            )
        logger.info("[LatencyRouter] auto -> {} (predicted {!r})", alias, predicted)
        _record_route_decision(
            alias,
            predicted=predicted,
            perf_weight=pw,
            short_circuit=result.get("short_circuit"),
            result=result,
            route_ms=route_ms,
        )
        tracing.set_attributes(span, {"llmrouter.auto.result_alias": alias})
        return alias


_ADAPTER: LatencyRouterAdapter | None = None
_ADAPTER_LOCK = threading.Lock()


def get_adapter() -> LatencyRouterAdapter:
    """Module-level singleton (only permanent load failures are sticky)."""
    global _ADAPTER
    with _ADAPTER_LOCK:
        if _ADAPTER is None:
            _ADAPTER = LatencyRouterAdapter()
        return _ADAPTER


def prewarm_adapter() -> RouterFailure | None:
    """Best-effort startup prewarm for the auto-router artefacts.

    This loads the shipped pickle/PCA/map before the first live `model=auto` request. Permanent failures stay cached; transient I/O failures allow the next call to retry the complete load under the initialization lock.
    """
    return get_adapter()._ensure_loaded()
