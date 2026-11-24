#!/usr/bin/env python3
"""Seed llmrouter_manager state — env-var one-click mode + JSON fallback.

Two input modes, applied in order (env vars WIN per-section over JSON):

1. **Env-var mode (one-click, no frontend)** — recommended for headless deploy:

   Edge (surfaces as ``local-model`` alias + drives the ``auto`` latency router):
     - ``LOCAL_LLM_API_BASE``               → edge.base_url  (required)
     - ``LOCAL_LLM_API_KEY``                → edge.api_key   (required)
     - ``LOCAL_LLM_MODEL_NAME``             → edge.model_name           (optional; server default: ``Qwen3-Coder-Next``)
     - ``LOCAL_LLM_EMBEDDING_MODEL_NAME``   → edge.embedding_model_name (optional; server default: ``KaLM-embedding-v2.5``)

   Cloud (surfaces as ``cloud-model`` alias):
     - ``CLOUD_LLM_PROVIDER``               → provider id, e.g. ``anthropic`` (required)
     - ``CLOUD_LLM_APIKEY``                 → provider api_key           (required)
     - ``CLOUD_LLM_MODEL_NAME``             → cloud-model model id       (required)
     - ``CLOUD_LLM_BASE_URL``               → provider base_url override (optional; falls
                                              back to catalog default for known providers,
                                              then empty string — LiteLLM native adapters
                                              such as anthropic/openai/gemini/xai handle
                                              their own base URL when empty)

   With BOTH edge + cloud env-var sets present, all three LRM aliases work
   end-to-end: ``auto`` (latency router decides), ``local-model`` (edge),
   ``cloud-model`` (cloud). Missing/partial env-var sections are SILENTLY
   skipped — env vars often exist for unrelated reasons, so partial config
   is not an error.

2. **JSON mode (backward-compat for integration tests + advanced dev)** —
   pass ``--input path.json`` with the shape shown by ``--help`` / by the
   "Option B" block printed when no config is found.

Merge order: JSON file loaded first (if present at ``--input`` path), then
env-var-derived sections replace matching top-level keys. So env-var mode is
strictly stronger than JSON for the sections it covers.

This script is dev-only — it goes away once the SuperClaw-native
cloud-provider UI ships through ServiceHub.

Usage (env-var one-click)::

    # 1. Set env vars once (Windows machine-scope; elevated PowerShell):
    [Environment]::SetEnvironmentVariable("LOCAL_LLM_API_BASE",    "https://edge.example.com/v1", "Machine")
    [Environment]::SetEnvironmentVariable("LOCAL_LLM_API_KEY",     "sk-edge-...",                  "Machine")
    [Environment]::SetEnvironmentVariable("CLOUD_LLM_PROVIDER",    "anthropic",                    "Machine")
    [Environment]::SetEnvironmentVariable("CLOUD_LLM_APIKEY",      "sk-ant-...",                   "Machine")
    [Environment]::SetEnvironmentVariable("CLOUD_LLM_MODEL_NAME",  "claude-3-5-sonnet-20241022",   "Machine")

    # 2. Start the LRM service in another shell:
    $env:LRM_API_KEY="dev-only-secret"
    $env:SERVICEHUB_PROCESS_CREDENTIAL="dev-only-credential"
    uv run --directory host/llmrouter_manager python -u -m llmrouter_manager --port 18321

    # 3. Seed via this script (same SERVICEHUB_PROCESS_CREDENTIAL in this shell):
    uv run --directory host/llmrouter_manager python scripts/dev_bootstrap.py \\
        --url http://127.0.0.1:18321
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from llmrouter_manager.common.state import default_state_root
from llmrouter_manager.common.store import Store, default_db_path


HEALTH_POLL_TIMEOUT_SECONDS = 30.0
HEALTH_POLL_INTERVAL_SECONDS = 1.0
HTTP_REQUEST_TIMEOUT_SECONDS = 10.0

# The LRM control plane is a loopback sidecar (127.0.0.1). urllib honors *_proxy
# env vars via getproxies(), and its proxy_bypass_environment does NOT parse
# CIDR NO_PROXY entries such as 127.0.0.0/8 - so on a corporate machine these
# loopback calls would be routed through (and 403'd by) the HTTP proxy. Use an
# opener with an empty ProxyHandler to force direct connections.
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# --provision-local pacing: operation poll interval, and the post-"done" grace
# window for the chat server to answer /probes (model load can lag the op).
PROVISION_POLL_INTERVAL_SECONDS = 2.0
PROVISION_PROBE_TIMEOUT_SECONDS = 120.0

# --provision-local sentinel: instead of pinning a model id, ask the host which
# chat model its hardware selects (GET /system/hardware -> selected_chat_model_id,
# i.e. policy.select_chat_model). A real catalog id always overrides this.
PROVISION_AUTO_MODEL = "auto"


def _http_request(
    method: str,
    url: str,
    *,
    body: dict | None = None,
) -> tuple[int, str]:
    """Send a JSON request to the LRM control plane. Returns (status, body_text).

    No bearer token is sent. LRM's trust boundary is the bind interface +
    the ServiceHub proxy layer, not a child-service bearer (contract §2 / §8).
    """
    headers: dict[str, str] = {}
    credential = os.environ.get("SERVICEHUB_PROCESS_CREDENTIAL", "")
    if credential:
        headers["X-SuperClaw-Process-Credential"] = credential
    data: bytes | None = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with _NO_PROXY_OPENER.open(req, timeout=HTTP_REQUEST_TIMEOUT_SECONDS) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        try:
            err_body = exc.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = ""
        return exc.code, err_body


def _wait_for_lrm(base_url: str, timeout: float = HEALTH_POLL_TIMEOUT_SECONDS) -> bool:
    """Poll /llm-router/v1/health until 200 or timeout (contract §5)."""
    deadline = time.monotonic() + timeout
    url = f"{base_url.rstrip('/')}/llm-router/v1/health"
    while time.monotonic() < deadline:
        try:
            with _NO_PROXY_OPENER.open(url, timeout=2.0) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(HEALTH_POLL_INTERVAL_SECONDS)
    return False


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="dev-bootstrap",
        description=(
            "Seed llmrouter_manager state. Env-var mode (LOCAL_LLM_* / "
            "CLOUD_LLM_*) is the default; --input JSON is optional and "
            "merged as a lower-priority fallback."
        ),
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=Path("dev_bootstrap.json"),
        help=(
            "Optional JSON config path (default: ./dev_bootstrap.json). "
            "Silently ignored if missing. Env vars override JSON per-section."
        ),
    )
    parser.add_argument(
        "--url",
        default=os.environ.get("LRM_URL", "http://127.0.0.1:18321"),
        help="LRM base URL (default: http://127.0.0.1:18321 or env LRM_URL)",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help=(
            "After seeding, probe each configured alias with a small "
            "POST /v1/chat/completions and log OK / FAIL per alias. "
            "Exits 4 if any probe failed."
        ),
    )
    parser.add_argument(
        "--provision-local",
        metavar="MODEL_ID",
        default=None,
        help=(
            "Provision a local llama-cpp CHAT model end-to-end (pin selection, "
            "GGUF download + llama-server spawn, wait until healthy), then add "
            "local-model to --verify. Pass 'auto' to let the host pick by "
            "hardware (GET /system/hardware -> selected_chat_model_id). "
            "Provision returns 'skipped' on an ineligible host. "
            "Exits 5 on failure."
        ),
    )
    parser.add_argument(
        "--provision-timeout-min",
        type=float,
        default=30.0,
        help="Minutes to wait for the download+launch op (default: 30).",
    )
    return parser.parse_args(argv)


def _catalog_default_base_url(provider_id: str) -> str:
    """Look up default base_url from the shipped catalog. Empty string if unknown.

    Lazy import so this script stays runnable in environments where the
    ``llmrouter_manager`` package might not have all cloud deps installed
    (defensive — the top-level already imports common.state/store, which is
    the actual hard requirement).
    """
    try:
        from llmrouter_manager.cloud.catalog import CATALOG
    except Exception:
        return ""
    for entry in CATALOG:
        if entry.get("id") == provider_id:
            return str(entry.get("default_base_url") or "")
    return ""


def _build_config_from_env() -> dict[str, Any]:
    """Build a bootstrap config dict from env vars.

    Only produces a section when all REQUIRED env vars for that section are
    present and non-empty. Partial configuration is silently skipped —
    ``LOCAL_LLM_API_BASE`` set without ``LOCAL_LLM_API_KEY`` produces NO
    edge section, no error. Rationale: env vars often exist in the ambient
    shell for unrelated reasons, and this script is a one-click tool.
    """
    config: dict[str, Any] = {}

    # --- Edge (local-model + auto latency router) from LOCAL_LLM_* ---------
    local_base = os.environ.get("LOCAL_LLM_API_BASE", "").strip()
    local_key = os.environ.get("LOCAL_LLM_API_KEY", "").strip()
    if local_base and local_key:
        config["edge"] = {
            "enabled": True,
            "base_url": local_base,
            "api_key": local_key,
            # Empty string tells the server "use your default" — see
            # edge/api.py::put_edge (Qwen3-Coder-Next / KaLM-embedding-v2.5).
            "model_name": os.environ.get("LOCAL_LLM_MODEL_NAME", "").strip(),
            "embedding_model_name": os.environ.get(
                "LOCAL_LLM_EMBEDDING_MODEL_NAME", ""
            ).strip(),
        }

    # --- Cloud (cloud-model) from CLOUD_LLM_* ------------------------------
    cloud_provider = os.environ.get("CLOUD_LLM_PROVIDER", "").strip()
    cloud_apikey = os.environ.get("CLOUD_LLM_APIKEY", "").strip()
    cloud_model_name = os.environ.get("CLOUD_LLM_MODEL_NAME", "").strip()
    if cloud_provider and cloud_apikey and cloud_model_name:
        # base_url resolution: explicit env override → catalog default → "".
        # Empty string is accepted by PUT /cloud/providers/{id} and is the
        # correct value for LiteLLM-native providers (anthropic, openai,
        # gemini, xai, mistral, perplexity — their adapters own the URL).
        base_url = os.environ.get("CLOUD_LLM_BASE_URL", "").strip()
        if not base_url:
            base_url = _catalog_default_base_url(cloud_provider)
        config["providers"] = {
            cloud_provider: {"api_key": cloud_apikey, "base_url": base_url}
        }
        config["cloud_model"] = {
            "provider": cloud_provider,
            "model": cloud_model_name,
        }

    return config


def _merge_config(
    base: dict[str, Any], overlay: dict[str, Any]
) -> dict[str, Any]:
    """Shallow merge: overlay REPLACES matching top-level keys in base.

    Intentionally NOT a deep merge. Env-var mode configures a single cloud
    provider; if the user also has a JSON with additional providers, the
    env-var provider fully replaces the JSON providers block. Users who
    need multiple providers should stick to JSON-only mode.
    """
    out = dict(base)
    for k, v in overlay.items():
        out[k] = v
    return out


def _seed_cloud(
    config: dict, *, base_url: str
) -> list[tuple[str, str]]:
    """Seed providers + cloud-model via HTTP. Returns per-section result lines.

    Providers are PUT first because PUT /cloud/model returns 422
    ``provider_not_configured`` if the provider isn't registered yet.
    """
    results: list[tuple[str, str]] = []
    base = base_url.rstrip("/")

    providers = config.get("providers") or {}
    if providers:
        for pid, pdata in providers.items():
            payload = {
                "api_key": pdata.get("api_key", ""),
                "base_url": pdata.get("base_url", ""),
            }
            status, body_text = _http_request(
                "PUT",
                f"{base}/llm-router/v1/cloud/providers/{pid}",
                body=payload,
            )
            if 200 <= status < 300:
                results.append((f"providers.{pid}", f"PUT ok (status={status})"))
            else:
                results.append(
                    (
                        f"providers.{pid}",
                        f"PUT failed (status={status}, body={body_text[:160]})",
                    )
                )
    else:
        results.append(("providers", "skipped (no providers section)"))

    cloud_model = config.get("cloud_model")
    if cloud_model:
        status, body_text = _http_request(
            "PUT",
            f"{base}/llm-router/v1/cloud/model",
            body=cloud_model,
        )
        if 200 <= status < 300:
            results.append(("cloud_model", f"PUT ok (status={status})"))
        else:
            results.append(
                (
                    "cloud_model",
                    f"PUT failed (status={status}, body={body_text[:160]})",
                )
            )
    else:
        results.append(("cloud_model", "skipped (no cloud_model section)"))

    return results


def _seed_edge_http(
    config: dict, *, base_url: str
) -> list[tuple[str, str]]:
    """Seed edge via ``PUT /llm-router/v1/edge``.

    Mirrors the cloud-section HTTP-wrapper pattern: parses the same
    ``edge`` shape a direct-write version would consume, but writes via the
    HTTP API so the same code path the eventual frontend uses is exercised
    end-to-end.

    ``embedding_model_name`` is forwarded so the latency router (``auto``
    routing) can call ``<edge_base_url>/embeddings`` with the right model
    id. Empty string means "let the server apply the default"
    (``Qwen3-Coder-Next`` for ``model_name``, ``KaLM-embedding-v2.5`` for
    ``embedding_model_name``).
    """
    results: list[tuple[str, str]] = []
    edge = config.get("edge") or {}
    if not edge.get("enabled"):
        results.append(("edge", "skipped (not enabled)"))
        return results

    payload = {
        "base_url": edge.get("base_url", ""),
        "api_key": edge.get("api_key", ""),
        "model_name": edge.get("model_name", ""),
        "embedding_model_name": edge.get("embedding_model_name", ""),
    }
    status, body_text = _http_request(
        "PUT",
        f"{base_url.rstrip('/')}/llm-router/v1/edge",
        body=payload,
    )
    if 200 <= status < 300:
        results.append(("edge", f"PUT ok (status={status})"))
    else:
        results.append(
            (
                "edge",
                f"PUT failed (status={status}, body={body_text[:160]})",
            )
        )
    return results


def _seed_llama_cpp_sqlite(config: dict) -> list[tuple[str, str]]:
    """Direct write for llama-cpp active model id (no HTTP API for llama-cpp yet).

    The ``local-model`` alias resolves to llama-cpp first, then edge — so
    this section only matters when an actual local ``llama-server``
    subprocess is running and LRM needs to be told which chat model it is
    serving. When only edge is configured, ``local-model`` routes through
    edge and this write is skipped.

    Accepts config key ``"llama-cpp"`` (preferred) and legacy ``"local"``
    for backward-compat with existing JSON configs. Goes away once
    ``/llm-router/v1/model-selections/*`` wires in.
    """
    results: list[tuple[str, str]] = []
    section = config.get("llama-cpp") or config.get("local") or {}
    active_chat = section.get("active_chat_model_id")
    if active_chat:
        store = Store(default_db_path())
        try:
            store.set_config("active_chat_model_id", active_chat)
            results.append(
                (
                    "llama-cpp",
                    f"set active_chat_model_id={active_chat!r} in SQLite (no HTTP API for llama-cpp yet)",
                )
            )
        finally:
            store.close()
    else:
        results.append(
            (
                "llama-cpp",
                "skipped (not running locally; local-model resolves via edge)",
            )
        )

    return results


def _post_chat_verify(
    base_url: str, alias: str, timeout: float = 90.0
) -> tuple[bool, str]:
    """POST a small chat completion to /v1/chat/completions. Returns (ok, detail).

    Data plane is unauthenticated. Timeout defaults to 90 s because ``auto``
    routing adds an edge-embedding round-trip + latency-router inference on top
    of the upstream chat call.
    """
    url = f"{base_url.rstrip('/')}/v1/chat/completions"
    body = json.dumps(
        {
            "model": alias,
            "messages": [
                {"role": "user", "content": "Reply with exactly two words: ping ok"}
            ],
            "max_tokens": 20,
            "stream": False,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.monotonic()
    try:
        with _NO_PROXY_OPENER.open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        dt = time.monotonic() - t0
        try:
            err_body = exc.read().decode("utf-8", errors="replace")[:200]
        except Exception:
            err_body = ""
        return False, f"HTTP {exc.code} in {dt:.2f}s — {err_body}"
    except Exception as exc:
        dt = time.monotonic() - t0
        return False, f"{type(exc).__name__} in {dt:.2f}s — {str(exc)[:200]}"

    dt = time.monotonic() - t0
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        return False, f"invalid JSON in {dt:.2f}s — {exc}"
    upstream = parsed.get("model", "?")
    content = ""
    try:
        content = str(parsed["choices"][0]["message"]["content"] or "")[:60].replace(
            "\n", " "
        )
    except (KeyError, IndexError, TypeError):
        pass
    return True, f"upstream={upstream}, {dt:.2f}s, content={content!r}"


def _verify_aliases(config: dict, base_url: str) -> list[tuple[str, str]]:
    """Probe each configured alias via /v1/chat/completions.

    Aliases probed based on what was seeded:
    - ``cloud-model`` — if ``providers`` + ``cloud_model`` sections both present
    - ``local-model`` — if ``edge.enabled`` OR ``llama-cpp.active_chat_model_id`` set
    - ``auto`` — only if BOTH cloud AND local are present (latency router has
      both slots to decide between; single-slot cases just fall back to that slot
      so testing ``auto`` there is redundant with the single-slot probe already)
    """
    results: list[tuple[str, str]] = []

    has_cloud = bool(config.get("cloud_model") and config.get("providers"))
    has_edge = bool((config.get("edge") or {}).get("enabled"))
    has_llama = bool(
        (config.get("llama-cpp") or config.get("local") or {}).get(
            "active_chat_model_id"
        )
    )
    has_local = has_edge or has_llama

    aliases: list[str] = []
    if has_cloud:
        aliases.append("cloud-model")
    if has_local:
        aliases.append("local-model")
    if has_cloud and has_local:
        aliases.append("auto")

    if not aliases:
        results.append(("verify", "skipped — nothing configured to test"))
        return results

    for alias in aliases:
        ok, detail = _post_chat_verify(base_url, alias)
        tag = "OK" if ok else "FAIL"
        results.append((f"verify.{alias}", f"{tag} — {detail}"))

    return results


def _select_hardware_chat_model(base_url: str) -> tuple[str | None, str]:
    """Ask LRM which chat model this host's hardware selects.

    ``GET /system/hardware`` returns ``selected_chat_model_id`` from
    ``policy.select_chat_model`` — the most demanding chat model whose
    ``requirements`` the probed hardware satisfies, falling back to the
    universal baseline. This is the same verdict the Tauri shell shows, so
    ``--provision-local auto`` provisions exactly what the app would pick.

    Returns ``(model_id, detail)``; ``model_id`` is ``None`` on any transport
    or shape failure, with ``detail`` explaining why.
    """
    api = f"{base_url.rstrip('/')}/llm-router/v1"
    status, body_text = _http_request("GET", f"{api}/system/hardware")
    if not (200 <= status < 300):
        return None, f"GET /system/hardware status={status}, body={body_text[:160]}"
    try:
        info = json.loads(body_text)
    except json.JSONDecodeError as exc:
        return None, f"invalid JSON (status={status}): {exc}"
    model_id = info.get("selected_chat_model_id")
    if not model_id:
        return None, f"no selected_chat_model_id in response: {body_text[:160]}"
    detected = info.get("detected")
    return str(model_id), f"selected_chat_model_id={model_id!r} (hardware detected={detected})"


def _provision_local(
    base_url: str,
    chat_model_id: str,
    *,
    timeout_min: float,
) -> tuple[bool, list[tuple[str, str]], str | None]:
    """Drive the local llama-cpp control plane to a serving chat model.

    Same flow the Tauri shell uses, all via :func:`_http_request` (each call
    returns fast; the long download+launch runs server-side as an operation we
    poll): ``PUT /model-selections/chat`` (pins ``active_chat_model_id``, the
    proxy's local-model key) -> ``POST /inference-servers/provisions`` (GGUF
    download + ``llama-server`` spawn; ``state="skipped"`` = ineligible host) ->
    poll ``GET /operations/{operation_id}`` to a terminal state -> wait for
    ``GET /inference-servers/chat/probes`` to report ``healthy``.

    Returns ``(ok, result_lines, active_chat_model_id)``; the id is echoed on
    success so the caller can register a synthetic ``llama-cpp`` section for
    alias verification, else ``None``.
    """
    results: list[tuple[str, str]] = []
    api = f"{base_url.rstrip('/')}/llm-router/v1"

    # 1. Pin the chat selection.
    status, body_text = _http_request(
        "PUT",
        f"{api}/model-selections/chat",
        body={"model_id": chat_model_id},
    )
    if not (200 <= status < 300):
        results.append(
            ("provision.select", f"FAIL — PUT status={status}, body={body_text[:160]}")
        )
        return False, results, None
    results.append(("provision.select", f"active_chat_model_id={chat_model_id!r}"))

    # 2. Kick off provisioning. 202=running, 200=ready/skipped.
    status, body_text = _http_request("POST", f"{api}/inference-servers/provisions")
    try:
        prov = json.loads(body_text)
    except json.JSONDecodeError as exc:
        results.append(
            ("provision.start", f"FAIL — invalid JSON (status={status}): {exc}")
        )
        return False, results, None
    state = str(prov.get("state", "?"))
    operation_id = prov.get("operation_id")
    reason = prov.get("reason")
    results.append(
        ("provision.start", f"state={state} operation_id={operation_id} reason={reason}")
    )
    if state == "skipped":
        # reason (printed above) is the server's own explanation: the
        # eligibility verdict for an ineligible host.
        results.append(("provision.start", f"FAIL — skipped: {reason}"))
        return False, results, None

    # 3. Poll the operation to a terminal state (skipped when already "ready").
    if state == "running" and operation_id:
        deadline = time.monotonic() + timeout_min * 60.0
        last_line = ""
        while True:
            if time.monotonic() > deadline:
                results.append(
                    ("provision.wait", f"FAIL — timed out after {timeout_min:g} min")
                )
                return False, results, None
            time.sleep(PROVISION_POLL_INTERVAL_SECONDS)
            st, op_text = _http_request("GET", f"{api}/operations/{operation_id}")
            if not (200 <= st < 300):
                results.append(
                    ("provision.wait", f"FAIL — operation GET status={st}")
                )
                return False, results, None
            try:
                op = json.loads(op_text)
            except json.JSONDecodeError as exc:
                results.append(
                    ("provision.wait", f"FAIL — invalid operation JSON: {exc}")
                )
                return False, results, None
            op_state = str(op.get("state", "?"))
            pct = int(op.get("pct") or 0)
            line = f"[{pct:3d}%] {op_state} — {op.get('message')}"
            if line != last_line:
                results.append(("provision.wait", line))
                last_line = line
            if op_state in ("done", "error", "cancelled"):
                if op_state != "done":
                    results.append(
                        (
                            "provision.wait",
                            f"FAIL — operation ended {op_state!r}: {op.get('message')}",
                        )
                    )
                    return False, results, None
                break

    # 4. Wait for the chat llama-server to actually serve.
    probe_deadline = time.monotonic() + PROVISION_PROBE_TIMEOUT_SECONDS
    while time.monotonic() < probe_deadline:
        st, probe_text = _http_request("GET", f"{api}/inference-servers/chat/probes")
        if 200 <= st < 300:
            try:
                probe = json.loads(probe_text)
            except json.JSONDecodeError:
                probe = {}
            if probe.get("healthy"):
                results.append(("provision.probe", "chat server healthy"))
                return True, results, chat_model_id
        time.sleep(PROVISION_POLL_INTERVAL_SECONDS)

    results.append(("provision.probe", "FAIL — chat server never reached healthy"))
    return False, results, None


def _print_usage_sample() -> None:
    """Print env-var + JSON sample to stderr when nothing is configured."""
    print(
        "No bootstrap sections found (neither env vars nor --input JSON).",
        file=sys.stderr,
    )
    print("", file=sys.stderr)
    print("Option A — env-var one-click (no JSON needed):", file=sys.stderr)
    print("  Edge  (local-model + auto latency router):", file=sys.stderr)
    print("    LOCAL_LLM_API_BASE                (required)", file=sys.stderr)
    print("    LOCAL_LLM_API_KEY                 (required)", file=sys.stderr)
    print(
        "    LOCAL_LLM_MODEL_NAME              (optional; server default: Qwen3-Coder-Next)",
        file=sys.stderr,
    )
    print(
        "    LOCAL_LLM_EMBEDDING_MODEL_NAME    (optional; server default: KaLM-embedding-v2.5)",
        file=sys.stderr,
    )
    print("  Cloud (cloud-model):", file=sys.stderr)
    print(
        "    CLOUD_LLM_PROVIDER                (required; e.g. anthropic / openai / deepseek)",
        file=sys.stderr,
    )
    print("    CLOUD_LLM_APIKEY                  (required)", file=sys.stderr)
    print(
        "    CLOUD_LLM_MODEL_NAME              (required; e.g. claude-3-5-sonnet-20241022)",
        file=sys.stderr,
    )
    print(
        "    CLOUD_LLM_BASE_URL                (optional; overrides catalog default)",
        file=sys.stderr,
    )
    print("", file=sys.stderr)
    print("Option B — JSON via --input path.json (shape):", file=sys.stderr)
    sample = {
        "cloud_model": {
            "provider": "anthropic",
            "model": "claude-3-5-sonnet-20241022",
            "max_tokens": 4096,
            "context_limit": 196608,
        },
        "providers": {
            "anthropic": {
                "api_key": "sk-test",
                "base_url": "https://api.anthropic.com/v1",
            }
        },
        "edge": {
            "enabled": False,
            "base_url": "",
            "api_key": "",
            "model_name": "",
            "embedding_model_name": "",
        },
        "llama-cpp": {"active_chat_model_id": None},
    }
    print(json.dumps(sample, indent=2), file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    # 1. Env-var-derived config (may be empty if no relevant env vars set).
    env_config = _build_config_from_env()

    # 2. JSON file config (optional; silently absent is fine now).
    file_config: dict[str, Any] = {}
    if args.input.exists():
        try:
            file_config = json.loads(args.input.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"ERROR: invalid JSON in {args.input}: {exc}", file=sys.stderr)
            return 2
        if not isinstance(file_config, dict):
            print(
                f"ERROR: input must be a JSON object, got {type(file_config).__name__}",
                file=sys.stderr,
            )
            return 2

    # 3. Merge: env vars WIN per-section over JSON.
    config = _merge_config(file_config, env_config)

    # --provision-local is a valid reason to run with no seed sections at all
    # (local slot only): don't bail to the usage sample in that case.
    if not config and not args.provision_local:
        _print_usage_sample()
        return 2

    # Provenance banner: show which top-level sections came from where so the
    # user can tell at a glance whether env vars actually kicked in.
    env_sections = sorted(env_config.keys())
    json_only_sections = sorted(
        set(file_config.keys()) - set(env_config.keys())
    )

    has_http_sections = bool(
        config.get("providers")
        or config.get("cloud_model")
        or (config.get("edge") or {}).get("enabled")
    )

    print(f"[dev-bootstrap] LRM URL:    {args.url}")
    print(f"[dev-bootstrap] State root: {default_state_root()}")
    print(f"[dev-bootstrap] DB path:    {default_db_path()}")
    if env_sections:
        print(f"[dev-bootstrap] From env:   {', '.join(env_sections)}")
    if json_only_sections:
        print(
            f"[dev-bootstrap] From JSON:  {', '.join(json_only_sections)} "
            f"({args.input})"
        )
    print()

    # A live LRM is needed for the cloud/edge HTTP seeding AND for
    # --provision-local (which drives the control plane over HTTP).
    need_lrm = has_http_sections or bool(args.provision_local)
    if need_lrm:
        print(f"[dev-bootstrap] Waiting for LRM at {args.url}/llm-router/v1/health ...")
        if not _wait_for_lrm(args.url):
            print(
                f"ERROR: LRM not reachable at {args.url} within "
                f"{HEALTH_POLL_TIMEOUT_SECONDS}s. Start it via: "
                "uv run --directory host/llmrouter_manager python -u -m "
                "llmrouter_manager --port 18321",
                file=sys.stderr,
            )
            return 3
        print("[dev-bootstrap] LRM ready.")

    if has_http_sections:
        for section, msg in _seed_cloud(config, base_url=args.url):
            print(f"  {section}: {msg}")
        for section, msg in _seed_edge_http(config, base_url=args.url):
            print(f"  {section}: {msg}")

    for section, msg in _seed_llama_cpp_sqlite(config):
        print(f"  {section}: {msg}")

    provision_failed = False
    if args.provision_local:
        target_model: str | None = args.provision_local
        if target_model == PROVISION_AUTO_MODEL:
            print()
            print(
                f"[dev-bootstrap] Auto-selecting local chat model from "
                f"{args.url}/llm-router/v1/system/hardware ..."
            )
            resolved, detail = _select_hardware_chat_model(args.url)
            print(f"  provision.auto: {detail}")
            if resolved:
                target_model = resolved
            else:
                print("  provision.auto: FAIL — could not resolve a model id")
                target_model = None
                provision_failed = True
        if target_model is not None:
            print()
            print(
                f"[dev-bootstrap] Provisioning local llama-cpp chat model "
                f"{target_model!r} (timeout {args.provision_timeout_min:g} min; "
                "first run downloads GGUF weights) ..."
            )
            ok, prov_results, provisioned_id = _provision_local(
                args.url,
                target_model,
                timeout_min=args.provision_timeout_min,
            )
            for section, msg in prov_results:
                print(f"  {section}: {msg}")
            if ok and provisioned_id:
                # In-memory ONLY: _provision_local's selection PUT already persisted
                # active_chat_model_id to SQLite, so this just tells _verify_aliases
                # to probe the local-model alias (no redundant second write).
                config["llama-cpp"] = {"active_chat_model_id": provisioned_id}
            else:
                provision_failed = True

    verify_had_failure = False
    if args.verify:
        print()
        print(
            f"[dev-bootstrap] Verifying aliases at {args.url}/v1/chat/completions ..."
        )
        for section, msg in _verify_aliases(config, args.url):
            print(f"  {section}: {msg}")
            if msg.startswith("FAIL"):
                verify_had_failure = True

    print()
    print("[dev-bootstrap] Done.")
    if provision_failed:
        return 5
    return 4 if verify_had_failure else 0


if __name__ == "__main__":
    sys.exit(main())
