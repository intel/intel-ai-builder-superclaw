"""Dev-only mock: serve a local Bundle's chat role from a remote OpenAI endpoint.

Purpose
-------
Bringing up a Bundle whose chat model only runs on scarce hardware -- the
Qwen3.8 27B dense tier needs a B70 box -- blocks every downstream consumer
(agents, UI, evals) on machine availability rather than on the code being
ready. This module lets an ordinary dev box present that Bundle as
committed-and-ready while the tokens actually come from an OpenAI-compatible
cloud endpoint (OpenRouter by default), **under the Bundle's own model id**.

Nothing user-facing renames, and that is not a trick: ``PrimaryUpstream.model_id``
is only the *upstream wire name* (``routing/proxy.py`` sets
``body["model"] = cfg.model_id`` before forwarding), while the response reports
the canonical served id rather than the upstream's echo. Swapping the wire name
for ``qwen/qwen3.8-27b`` therefore leaves ``/status``, the capability profile,
opencode and the trajectory inspector all reading the Bundle's own id.

Scope: the CHAT role only. The embedding role keeps running for real on the
local llama-server -- KaLM is ~0.5 GB, declares no ``requirements`` and runs on
any box -- so the AutoRoute latency router keeps its real 896-dim embeddings and
``auto`` behaves as it does in production. This reuses the supervisor's existing
chat-rerouted launch plan (``_LaunchPlan(chat_entry=None, chat_rerouted=True)``)
rather than introducing a second substitution mechanism beside it.

Safety
------
* Armed only when ``LRM_MOCK_LOCAL_BUNDLE`` names a Bundle **and** the build
  channel is ``dev`` (``local/build_channel.py``). A ``release-candidate`` or
  ``main`` build refuses to arm and logs why, matching the booster's fidelity
  rule: outside dev, under-spec hardware must fail honestly.
* An incomplete configuration refuses to arm and names the missing variable, so
  a typo degrades to "mock off" loudly instead of silently falling through to a
  real multi-GB download attempt.
* Every armed process logs one WARNING naming the real upstream, so no trace or
  bug report can mistake mocked tokens for locally-served ones.

What this does NOT reproduce
----------------------------
Latency, tokens/sec, context behaviour under load, quantisation artifacts, and
llama-server-specific tool-call quirks. It unblocks feature work; it is not
evidence for performance, eval, or release sign-off.

Configuration
-------------
::

    LRM_MOCK_LOCAL_BUNDLE          local-27b
    LRM_MOCK_LOCAL_REGISTRY_DIR    host/llmrouter_manager/dev/mock-bundles/qwen3.8-27b
    LRM_MOCK_LOCAL_UPSTREAM_MODEL  qwen/qwen3.8-27b
    LRM_MOCK_LOCAL_API_KEY         sk-or-v1-...
    LRM_MOCK_LOCAL_API_BASE        https://openrouter.ai/api/v1   (default)
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from loguru import logger

from ..common.events import EventType, record_event
from .build_channel import detect_channel

ENV_BUNDLE: Final = "LRM_MOCK_LOCAL_BUNDLE"
ENV_REGISTRY_DIR: Final = "LRM_MOCK_LOCAL_REGISTRY_DIR"
ENV_UPSTREAM_MODEL: Final = "LRM_MOCK_LOCAL_UPSTREAM_MODEL"
ENV_API_KEY: Final = "LRM_MOCK_LOCAL_API_KEY"
ENV_API_BASE: Final = "LRM_MOCK_LOCAL_API_BASE"

DEFAULT_API_BASE: Final = "https://openrouter.ai/api/v1"

# Files the overlay directory replaces, at the two ``_builtin_path()`` seams.
BUNDLES_FILENAME: Final = "bundles.builtin.json"
MODELS_FILENAME: Final = "models.builtin.json"


@dataclass(frozen=True)
class MockedBundle:
    """A resolved, fully-validated mock configuration."""

    bundle_id: str
    registry_dir: Path
    base_url: str
    api_key: str
    upstream_model_id: str


# Memo keyed on the raw env snapshot: the config is read per call (so a test or
# an operator changing the environment is picked up) but neither re-validated
# nor re-logged while the environment stands still.
_cache_key: tuple[str, ...] | None = None
_cache_value: MockedBundle | None = None
_logged_keys: set[tuple[str, ...]] = set()
# Separate from ``_logged_keys``: a typed row may fail to write (no store yet at
# first resolve), and the log-once latch must not silence the retry.
_evented_keys: set[tuple[str, ...]] = set()
_last_refusal_reason: str | None = None


def _snapshot() -> tuple[str, ...]:
    return tuple(
        (os.environ.get(name) or "").strip()
        for name in (
            ENV_BUNDLE,
            ENV_REGISTRY_DIR,
            ENV_UPSTREAM_MODEL,
            ENV_API_KEY,
            ENV_API_BASE,
        )
    ) + (detect_channel(),)


def _refuse(key: tuple[str, ...], reason: str) -> None:
    """Log once why an attempted arming was refused. Never raises."""
    global _last_refusal_reason
    _last_refusal_reason = reason
    if key in _logged_keys:
        return
    _logged_keys.add(key)
    logger.warning(
        "local-bundle mock NOT armed ({}={!r}): {}. Serving the real local path.",
        ENV_BUNDLE,
        os.environ.get(ENV_BUNDLE, ""),
        reason,
    )


def _emit_mock_event(key: tuple[str, ...]) -> None:
    """Write ``mock.armed`` / ``mock.refused`` once per env snapshot.

    Emitted from ``config()`` rather than from ``_resolve`` so it survives the
    memo: ``_resolve`` runs once, possibly BEFORE ``app.py`` has wired the event
    store, and a run whose tokens did not come from local hardware must never be
    mistaken for one that did. The key is only marked done once a row was
    actually written, so an early call cannot swallow the record.
    """
    if key in _evented_keys:
        return
    mock = _cache_value
    if mock is not None:
        written = record_event(
            EventType.MOCK_ARMED,
            model=mock.upstream_model_id,
            attrs={
                "bundle": mock.bundle_id,
                "upstream": mock.base_url,
                "upstream_model": mock.upstream_model_id,
                "locally_served": False,
            },
        )
    elif (os.environ.get(ENV_BUNDLE) or "").strip():
        # Only a REQUESTED-but-refused mock is an event. The mock being off (no
        # LRM_MOCK_LOCAL_BUNDLE at all) is the normal shipping state, not news.
        written = record_event(
            EventType.MOCK_REFUSED,
            attrs={
                "bundle": (os.environ.get(ENV_BUNDLE) or "").strip(),
                "reason": _last_refusal_reason,
                "channel": detect_channel(),
                "locally_served": True,
            },
        )
    else:
        return
    if written:
        _evented_keys.add(key)


def config() -> MockedBundle | None:
    """Return the armed mock configuration, or ``None`` when the mock is off.

    Fail-soft by construction: every rejection path returns ``None`` (the real
    local path) and logs the reason, so a half-configured mock can never leave
    the service believing it is mocking when it is not.
    """
    global _cache_key, _cache_value

    key = _snapshot()
    if key != _cache_key:
        _cache_key = key
        _cache_value = _resolve(key)
    _emit_mock_event(key)
    return _cache_value


def _resolve(key: tuple[str, ...]) -> MockedBundle | None:
    bundle_id = (os.environ.get(ENV_BUNDLE) or "").strip()
    if not bundle_id:
        return None

    channel = detect_channel()
    if channel != "dev":
        _refuse(
            key,
            f"build channel is {channel!r}; the mock is dev-only so an RC or "
            "release build fails honestly on under-spec hardware",
        )
        return None

    registry_raw = (os.environ.get(ENV_REGISTRY_DIR) or "").strip()
    if not registry_raw:
        _refuse(key, f"{ENV_REGISTRY_DIR} is unset")
        return None
    registry_dir = Path(registry_raw)
    for filename in (BUNDLES_FILENAME, MODELS_FILENAME):
        if not (registry_dir / filename).is_file():
            _refuse(key, f"{registry_dir / filename} does not exist")
            return None

    upstream_model_id = (os.environ.get(ENV_UPSTREAM_MODEL) or "").strip()
    if not upstream_model_id:
        _refuse(key, f"{ENV_UPSTREAM_MODEL} is unset")
        return None

    api_key = (os.environ.get(ENV_API_KEY) or "").strip()
    if not api_key:
        _refuse(key, f"{ENV_API_KEY} is unset")
        return None

    base_url = (os.environ.get(ENV_API_BASE) or "").strip() or DEFAULT_API_BASE

    resolved = MockedBundle(
        bundle_id=bundle_id,
        registry_dir=registry_dir,
        base_url=base_url,
        api_key=api_key,
        upstream_model_id=upstream_model_id,
    )

    if key not in _logged_keys:
        _logged_keys.add(key)
        logger.warning(
            "LOCAL-BUNDLE MOCK ARMED: bundle {!r} presents as local but its CHAT "
            "role is served by {} as model {!r}. Embedding still runs locally. "
            "Tokens are NOT locally generated -- do not use this run as "
            "performance or release evidence.",
            resolved.bundle_id,
            resolved.base_url,
            resolved.upstream_model_id,
        )

    return resolved


def is_armed() -> bool:
    return config() is not None


def mocks_bundle(bundle_id: str) -> bool:
    """Whether ``bundle_id`` is the Bundle this process is mocking."""
    mock = config()
    return mock is not None and mock.bundle_id == bundle_id


def registry_file(filename: str) -> Path | None:
    """Overlay replacement for a packaged registry file, or ``None``.

    Consumed by the two ``_builtin_path()`` seams (``local/registry.py`` and
    ``capability/bundle_registry.py``). The overlay replaces the *builtin*
    layer, not the untrusted ``LRM_MODEL_REGISTRY_OVERRIDE`` layer -- which is
    what lets it carry the trusted KaLM embedding asset the supervisor needs,
    since that override rejects trusted asset ids outright.
    """
    mock = config()
    if mock is None:
        return None
    candidate = mock.registry_dir / filename
    return candidate if candidate.is_file() else None


def mocked_chat_asset_id() -> str | None:
    """The chat asset id of the mocked Bundle, read from the overlay itself.

    Deliberately parsed straight out of the overlay JSON rather than through
    ``capability.bundle_registry``: that module asks this one where its builtin
    file lives, so importing it back would close a cycle. It also keeps the
    overlay the single source of truth -- there is no second env var for the
    asset id to drift out of sync with the Bundle it belongs to.
    """
    mock = config()
    if mock is None:
        return None
    path = registry_file(BUNDLES_FILENAME)
    if path is None:
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for bundle in payload.get("bundles") or []:
            if isinstance(bundle, dict) and bundle.get("bundle_id") == mock.bundle_id:
                chat_model_id = bundle.get("chat_model_id")
                return chat_model_id if isinstance(chat_model_id, str) else None
    except (OSError, ValueError) as exc:
        # The strict loaders report a malformed overlay far better than we can;
        # here a parse failure only means "no asset is mocked", which fails
        # toward the real path.
        logger.warning("local-bundle mock: cannot read {}: {}", path, exc)
    return None


def mocks_chat_asset(asset_id: str) -> bool:
    """Whether ``asset_id`` is the mocked Bundle's chat asset.

    True means the asset is never downloaded, never verified and never loaded
    into llama-server, because a remote endpoint stands in for it.
    """
    mocked = mocked_chat_asset_id()
    return mocked is not None and mocked == asset_id


def reset_for_tests() -> None:
    """Drop the memo and the once-only log record."""
    global _cache_key, _cache_value, _last_refusal_reason
    _cache_key = None
    _cache_value = None
    _last_refusal_reason = None
    _logged_keys.clear()
    _evented_keys.clear()


def declared_chat_ctx() -> int | None:
    """The mocked chat asset's ``default_ctx``, or None when the mock is off.

    The n_ctx probe cannot learn a window from a remote OpenAI-compatible
    endpoint -- OpenRouter's ``/v1/models`` carries neither ``max_model_len`` nor
    ``meta.n_ctx`` -- so under the mock the probe fails and the context cap
    resolves to None, leaving the guard INERT. That is why a mocked run never
    reproduced the ContextOverflowError a real B70 hits: the ceiling the Bundle
    declares was never applied.

    The overlay already states the window (mirroring the shipped bundle since
    #2155), so read it from there and let the caller use it as the static cap.
    An operator ``LATENTFACTOR_MAX_CONTEXT`` still wins, because
    ``resolve_effective_n_ctx`` applies that ahead of any fallback.
    """
    path = registry_file(MODELS_FILENAME)
    chat_id = mocked_chat_asset_id()
    if path is None or not chat_id:
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    for entry in raw.get("models") or []:
        if entry.get("id") != chat_id:
            continue
        # A discrete board does NOT run the registry's `default_ctx`: the booster
        # overrides llama-server's -c to DISCRETE_GPU_CTX_SIZE, which is the point
        # of putting this tier on a dedicated GPU. Declaring `default_ctx` here
        # would make the mock enforce a ceiling ~162k tokens BELOW the hardware
        # it stands in for -- rejecting work a real B70 completes, which is the
        # same fidelity failure as being too permissive, just in the other
        # direction. Measured on hardware: at the 100000 window 8 of 116 agent
        # tasks failed on ContextOverflowError with 91k-103k-token inputs; at
        # 256K none did, and L2 went 0.766 -> 0.894.
        #
        # Keyed on the entry declaring a discrete board rather than on this host
        # having one -- the mock exists precisely because this host does not.
        if _targets_discrete_board(entry):
            from .booster import DISCRETE_GPU_CTX_SIZE

            return DISCRETE_GPU_CTX_SIZE
        ctx = entry.get("default_ctx")
        return ctx if isinstance(ctx, int) and ctx > 0 else None
    return None


def _targets_discrete_board(entry: dict) -> bool:
    """Whether a raw registry entry names a dedicated GPU in its requirements.

    Reads the raw JSON rather than a parsed ``ModelEntry`` because this module
    is what tells the registry loaders where their builtin file lives; importing
    them back would close a cycle. ``policy._DISCRETE_GPU_KEYWORDS`` stays the
    single source of truth for which keyword means dedicated.
    """
    from .policy import _DISCRETE_GPU_KEYWORDS

    keywords = {
        str(raw).strip().lower()
        for raw in ((entry.get("requirements") or {}).get("igpu_keywords") or [])
    }
    return bool(keywords & _DISCRETE_GPU_KEYWORDS)
