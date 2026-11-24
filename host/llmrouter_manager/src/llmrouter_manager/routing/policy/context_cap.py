"""Context-cap derivation + live-server n_ctx probe.

Ported verbatim (behaviour-preserving) from ``D:/routing_service/sidecar.py``
(``resolve_policy_token_cap``, ``resolve_effective_n_ctx``,
``_probe_server_n_ctx``, ``_SAFETY_MARGIN``). Pure functions — no shared state,
no server dependency beyond a best-effort httpx probe. See
docs/design/routing_service_integration_plan.md §4 / §5c.

The cap keeps the local upstream from being handed a prompt longer than its
context window. It is auto-derived from the LIVE server's context length so it
can never drift from ``-c`` / ``--max-model-len`` (the failure that let a 54k
prompt hit a 49k server).
"""
from __future__ import annotations

from typing import Any, Optional

from loguru import logger

# Subtracted (with output_reserve) from the server's total context to leave room
# for a full-length generation plus per-request template/tool-schema overhead the
# token estimate can't see exactly. Widened from 256 to 1024 after a ~257-token
# estimate-vs-vLLM undercount produced a 65537>65536 400.
_SAFETY_MARGIN = 1024

# Default output budget reserved from the context window (mirrors opencode's
# local ``output`` limit) so a full generation still fits without truncation.
_DEFAULT_OUTPUT_RESERVE = 8192


def resolve_policy_token_cap(
    routing_cfg: dict[str, Any],
    upstream_cap: Optional[int] = None,
    server_n_ctx: Optional[int] = None,
    output_reserve: int = _DEFAULT_OUTPUT_RESERVE,
    safety: int = _SAFETY_MARGIN,
) -> Optional[int]:
    """Max prompt tokens for the local upstream. Precedence:

      1. ``routing.max_input_tokens`` — explicit operator override (wins if set).
      2. auto: ``server_n_ctx - output_reserve - safety`` — derived from the LIVE
         server's context length (llama.cpp ``n_ctx`` via /props, or vLLM
         ``max_model_len`` via /v1/models). DEFAULT path; cannot drift.
      3. ``upstream_cap`` — static fallback, used only when the probe was
         skipped/failed (server unreachable at startup).
      4. None — no sidecar cap; the server's own limit hard-gates.

    When ``server_n_ctx`` is None (no probe) the auto tier is skipped and this
    matches the original config>upstream>None resolution.
    """
    v = routing_cfg.get("max_input_tokens")
    if v is not None:
        try:
            return int(v)
        except (TypeError, ValueError):
            logger.warning("bad routing.max_input_tokens={!r}; falling back", v)
    if server_n_ctx and int(server_n_ctx) > 0:
        derived = int(server_n_ctx) - int(output_reserve) - int(safety)
        if derived > 0:
            return derived
        logger.warning(
            "auto token cap non-positive (n_ctx={} - reserve={} - safety={}); "
            "falling back to static cap", server_n_ctx, output_reserve, safety)
    return int(upstream_cap) if upstream_cap is not None else None


def resolve_effective_n_ctx(
    routing_cfg: dict[str, Any],
    probed_n_ctx: Optional[int],
    env_value: Optional[str] = None,
) -> Optional[int]:
    """Effective total context to feed the cap derivation.

    Lets an operator SIMULATE a smaller context than the server serves (e.g.
    remote pinned at ``-c 65536`` while sweeping "what if 32768?") without
    restarting it. Precedence: env ``LATENTFACTOR_MAX_CONTEXT`` >
    ``routing.max_context`` > probed value. SAFETY: with both an override and a
    probe present, the override is CLAMPED to the probed value — it can only
    SHRINK the effective context, never exceed the real server. When the probe
    failed (remote unreachable), the override is trusted as-is.
    """
    override: Optional[int] = None
    raw = env_value if env_value else routing_cfg.get("max_context")
    if raw is not None:
        try:
            override = int(raw)
        except (TypeError, ValueError):
            logger.warning("bad max_context={!r}; ignoring override", raw)
            override = None
    if override is not None and override > 0:
        if probed_n_ctx and override > probed_n_ctx:
            logger.warning(
                "max_context={} exceeds probed server context={}; clamping to "
                "the server (override can only shrink, never exceed)",
                override, probed_n_ctx)
            return probed_n_ctx
        logger.info("max_context override in effect: {} (probed={})",
                    override, probed_n_ctx)
        return override
    return probed_n_ctx


def _probe_trust_env(base_url: str) -> bool:
    """Whether the n_ctx probe should honour the ambient proxy environment.

    A loopback upstream must NOT go through a corporate proxy — that is what the
    original hardcoded ``trust_env=False`` protected against, and it stays the
    behaviour for every loopback slot (the normal local llama-server).

    A non-loopback upstream is the opposite case: an edge server, or the dev
    OpenRouter stand-in used by ``LRM_MOCK_LOCAL_BUNDLE``. On a proxied network
    those hosts are reachable ONLY through the proxy, so ignoring it does not
    protect anything — it guarantees a connect timeout, and the probe is on the
    request path, so every affected turn stalls for the full timeout (measured
    ~6.1s per probe, ~12.1s per turn against openrouter.ai).
    """
    import ipaddress
    from urllib.parse import urlparse

    host = (urlparse(base_url).hostname or "").lower()
    if not host:
        return False
    if host == "localhost":
        return False
    try:
        return not ipaddress.ip_address(host).is_loopback
    except ValueError:
        # A named, non-loopback host (edge server, openrouter.ai): needs the proxy.
        return True


def _probe_server_n_ctx(
    base_url: str,
    timeout: float = 3.0,
    api_key: str = "",
    model: Optional[str] = None,
) -> Optional[int]:
    """Best-effort read of the local server's live total context budget.

    Backend-agnostic — tries the known engines in order and returns the first
    usable value:
      1. llama.cpp single-model ``GET /props`` → ``default_generation_settings.n_ctx``.
      2. vLLM ``GET /v1/models`` → the served model's ``max_model_len``.
      3. llama.cpp multi-model router ``GET /v1/models`` → the served model's
         ``meta.n_ctx``. The router front-end reports ``n_ctx:0`` on ``/props``
         (it binds no single model) and its ``/v1/models`` entries carry no
         ``max_model_len``, so the real per-model window lives under ``meta``.
         When ``model`` matches an entry that entry's ``meta.n_ctx`` is used;
         otherwise the largest ``meta.n_ctx`` among LOADED, non-embedding entries
         (``--embeddings`` excluded) is chosen, so the probe never latches onto
         an embedding slot's small ctx.

    ``base_url`` is the OpenAI base (``…/v1``). ``/props`` lives at the server
    ROOT so we strip the version segment for it. Proxy handling follows the
    target (``_probe_trust_env``): ``trust_env=False`` for a loopback upstream so
    a corporate proxy can't intercept it, the ambient proxy for a non-loopback one
    that is only reachable through it. Never raises — any total failure returns
    None and the caller falls back to the static cap.
    """
    import httpx

    trust_env = _probe_trust_env(base_url)

    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    base = base_url.rstrip("/")
    root = base
    for suffix in ("/v1", "/v3", "/v2"):
        if root.endswith(suffix):
            root = root[: -len(suffix)]
            break

    # 1) llama.cpp /props
    try:
        with httpx.Client(timeout=timeout, trust_env=trust_env) as c:
            r = c.get(root + "/props", headers=headers)
        if r.status_code == 200:
            n_ctx = (r.json().get("default_generation_settings") or {}).get("n_ctx")
            if isinstance(n_ctx, int) and n_ctx > 0:
                logger.info("ctx probe (llama.cpp /props) {}: n_ctx={}",
                            root + "/props", n_ctx)
                return n_ctx
    except Exception as exc:  # noqa: BLE001
        logger.debug("props probe {} not usable ({}: {}); trying /v1/models",
                     root + "/props", exc.__class__.__name__, exc)

    # 2) /v1/models. Two shapes:
    #    a) vLLM       -> entry["max_model_len"]
    #    b) llama.cpp  -> entry["meta"]["n_ctx"]  (the llama.cpp multi-model
    #       router front-end reports n_ctx:0 on /props because it binds no single
    #       model, but each entry in /v1/models carries the real per-model n_ctx
    #       under `meta`. Without this branch the router topology defeats the
    #       probe entirely and the context-cap guard never engages.)
    try:
        with httpx.Client(timeout=timeout, trust_env=trust_env) as c:
            r = c.get(base + "/models", headers=headers)
        if r.status_code == 200:
            entries = r.json().get("data") or []
            chosen = None
            if model:
                chosen = next((e for e in entries if e.get("id") == model), None)
            if chosen is None and entries:
                chosen = entries[0]

            # a) vLLM max_model_len (exact/first entry — unchanged).
            mml = (chosen or {}).get("max_model_len")
            if isinstance(mml, int) and mml > 0:
                logger.info("ctx probe (vLLM /v1/models) {}: max_model_len={} "
                            "(model={})", base + "/models", mml,
                            (chosen or {}).get("id"))
                return mml

            # b) llama.cpp meta.n_ctx. Prefer the entry matching `model`; else
            #    pick the loaded, non-embedding entry with the largest n_ctx so
            #    we never latch onto an embedding slot's small ctx (e.g. KaLM at
            #    8192) when the chat model (e.g. qwen at 32768) is what serves.
            def _meta_n_ctx(e: dict) -> int:
                v = ((e or {}).get("meta") or {}).get("n_ctx")
                return v if isinstance(v, int) and v > 0 else 0

            def _is_embedding(e: dict) -> bool:
                args = ((e or {}).get("status") or {}).get("args") or []
                return "--embeddings" in args

            def _is_loaded(e: dict) -> bool:
                st = (e or {}).get("status") or {}
                return st.get("value") == "loaded" if isinstance(st, dict) else False

            meta_ctx = _meta_n_ctx(chosen) if model and chosen \
                and chosen.get("id") == model else 0
            chosen_id = (chosen or {}).get("id")
            if meta_ctx <= 0:
                candidates = [
                    (e.get("id"), _meta_n_ctx(e)) for e in entries
                    if _is_loaded(e) and not _is_embedding(e) and _meta_n_ctx(e) > 0
                ]
                if candidates:
                    chosen_id, meta_ctx = max(candidates, key=lambda kv: kv[1])
            if meta_ctx > 0:
                logger.info("ctx probe (llama.cpp /v1/models meta) {}: n_ctx={} "
                            "(model={})", base + "/models", meta_ctx, chosen_id)
                return meta_ctx

            logger.warning("/v1/models {}: no usable max_model_len or meta.n_ctx "
                           "(entries={})", base + "/models",
                           [e.get("id") for e in entries])
    except Exception as exc:  # noqa: BLE001
        logger.warning("ctx probe failed for {} ({}: {}); using static cap",
                       base_url, exc.__class__.__name__, exc)

    logger.warning("ctx probe: no context length from /props or /v1/models at "
                   "{}; using static cap", base_url)
    return None
