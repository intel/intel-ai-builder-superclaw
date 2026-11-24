"""Async HTTP client for the llmrouter_manager sidecar (chat completions, streaming, health)."""
import json
import logging
import math
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from superclaw_host_observability.log_masking import mask_url_for_log as _mask_url_for_log
import httpx
from llm_pipeline.utils.logger import setup_logger

logger = setup_logger(__name__)


_LLMROUTER_SERVICE_NAME = "llmrouter_manager"
_DEFAULT_TIMEOUT_SECONDS = 200.0
_MAX_TIMEOUT_SECONDS = 3600.0


def _timeout_from_env() -> float:
    """Reads ``LLMROUTER_TIMEOUT`` (seconds); falls back to the default when unset or invalid.

    Invalid means not a number, non-finite, not positive, or above the maximum.
    A bad value must never prevent the service from starting.
    """
    raw = os.getenv("LLMROUTER_TIMEOUT")
    if raw is None or not raw.strip():
        return _DEFAULT_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not math.isfinite(value) or not 0 < value <= _MAX_TIMEOUT_SECONDS:
        logger.warning(
            "Ignoring invalid LLMROUTER_TIMEOUT={!r}; expected a number in (0, {:g}]. Using default {:g}s",
            raw[:64],
            _MAX_TIMEOUT_SECONDS,
            _DEFAULT_TIMEOUT_SECONDS,
        )
        return _DEFAULT_TIMEOUT_SECONDS
    return value


class NoLocalProviderError(RuntimeError):
    """Raised when llmrouter_manager has no local-model provider configured.

    Signals the router's ``424 no_provider_available`` for the ``local-model``
    alias specifically (as opposed to any other chat failure), so callers that
    pin to local on purpose (e.g. the privacy-preserving file pipeline, which
    must never fall through to ``cloud-model``) can tell "no local model is
    configured" apart from a transient/unexpected error and degrade accordingly.
    """


def _is_no_provider_available(body_text: str) -> bool:
    """Checks whether a 424 error body is llmrouter_manager's `no_provider_available`."""
    try:
        data = json.loads(body_text)
    except json.JSONDecodeError:
        return False
    error = data.get("error") if isinstance(data, dict) else None
    return isinstance(error, dict) and error.get("code") == "no_provider_available"


def _truncate_for_log(text: str, limit: int = 200) -> str:
    """Truncate a payload snippet for logging; secrets should already be masked by caller."""
    text = text or ""
    if len(text) <= limit:
        return text
    return text[:limit] + f"…<truncated, total_len={len(text)}>"


def _urls_from_service_cfg() -> Optional[Tuple[str, str]]:
    """
    Get LLM endpoint chat and health URLs from the llmrouter_manager entry in service_cfg.json.

    Reads the config file path from the ``SERVICEHUB_CFG_PATH`` environment variable.

    Returns:
        Optional[Tuple[str, str]]: A ``(chat_url, health_url)`` pair derived from the
        service config, or ``None`` if the environment variable is unset, the file is
        missing or malformed, or the ``llmrouter_manager`` entry is absent.
    """
    cfg_path_str = os.getenv("SERVICEHUB_CFG_PATH")
    if not cfg_path_str:
        logger.debug("SERVICEHUB_CFG_PATH is not set; using LLM router defaults")
        return None
    cfg_path = Path(cfg_path_str)
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Could not load service_cfg from {}: {}", cfg_path, exc)
        return None

    for svc in cfg.get("services", []):
        if svc.get("name") != _LLMROUTER_SERVICE_NAME:
            continue
        bind_host: str = svc.get("bind_host", "127.0.0.1")

        # 0.0.0.0 means "listen on all interfaces"; connect via loopback
        host = "127.0.0.1" if bind_host == "0.0.0.0" else bind_host
        port: int = svc.get("port", 18321)
        proxy_prefix: str = svc.get("proxy_prefix", "/llm-router")
        base = f"http://{host}:{port}"
        logger.info(
            "Resolved LLM router endpoints from service_cfg path=%s host=%s port=%d proxy_prefix=%s",
            cfg_path,
            host,
            port,
            proxy_prefix,
        )
        return f"{base}/v1/chat/completions", f"{base}{proxy_prefix}/v1/health"

    logger.warning("service_cfg has no '{}' entry; falling back to defaults", _LLMROUTER_SERVICE_NAME)
    return None


class LLMClient:
    """
    Client for protected file pipeline LLM router requests.

    Provides health checks and simple chat completion requests for production use.
    """

    def __init__(self) -> None:
        """
        Initializes endpoint URLs and request timeout.
        """
        cfg_urls = _urls_from_service_cfg()
        default_chat_url, default_health_url = cfg_urls or (
            "http://127.0.0.1:18321/v1/chat/completions",
            "http://127.0.0.1:18321/llm-router/v1/health",
        )
        self.health_url = os.getenv("LLMROUTER_HEALTH_URL", default_health_url)
        self.chat_url = os.getenv("LLMROUTER_CHAT_URL", default_chat_url)
        self.timeout = _timeout_from_env()
        logger.info(
            "LLM client configured chat_url=%s health_url=%s timeout_seconds=%.1f source=%s chat_env_override=%s health_env_override=%s",
            _mask_url_for_log(self.chat_url),
            _mask_url_for_log(self.health_url),
            self.timeout,
            "service_cfg" if cfg_urls else "defaults",
            bool(os.getenv("LLMROUTER_CHAT_URL")),
            bool(os.getenv("LLMROUTER_HEALTH_URL")),
        )

    def _headers(self, session_id: Optional[str] = None) -> Dict[str, str]:
        """
        Builds headers used for JSON requests to the LLM router.

        Args:
            session_id (Optional[str]): OpenCode session id for the caller that
                triggered this pipeline run. Forwarded as ``X-Opencode-Session-Id``
                so llmrouter_manager's usage tracking (``record_usage``) can
                attribute these tokens to the right session -- without it, the
                request looks anonymous and its tokens are recorded but never
                show up in the UI's per-session usage panel.

        Returns:
            Dict[str, str]: HTTP headers for JSON requests.
        """
        headers = {"Content-Type": "application/json"}
        api_key = os.getenv("LRM_API_KEY", "").strip()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        if session_id:
            headers["X-Opencode-Session-Id"] = session_id
        return headers

    def _build_payload(
        self,
        chat_messages: List[Dict[str, Any]],
        temperature: Optional[float],
        max_tokens: Optional[int],
        tools: Optional[List[Dict[str, Any]]],
        pydantic_response_format: Optional[Any],
        tool_choice: str,
        stream: bool,
        repeat_penalty: Optional[float] = None,
        repeat_last_n: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Builds the JSON payload for a chat completion request.

        Args:
            chat_messages (List[Dict[str, Any]]): Conversation messages in OpenAI chat format.
            temperature (Optional[float]): Sampling temperature.
            max_tokens (Optional[int]): Maximum number of tokens to generate.
            tools (Optional[List[Dict[str, Any]]]): Tool schemas to pass to the model.
            pydantic_response_format (Optional[Any]): Pydantic model class for structured
                JSON output; adds a ``response_format`` block when provided.
            tool_choice (str): Tool choice strategy (``"auto"``, ``"required"``, ``"none"``).
            stream (bool): Whether to request a streaming response.
            repeat_penalty (Optional[float]): llama.cpp-style penalty applied to tokens
                that already appeared within the ``repeat_last_n`` window, discouraging
                degenerate repetition loops. Omitted from the payload when ``None``.
            repeat_last_n (Optional[int]): Number of trailing tokens considered for
                ``repeat_penalty``; ``-1`` tells llama.cpp to consider the whole context
                generated so far, which is needed to catch repeated blocks longer than
                llama.cpp's small default window. Omitted from the payload when ``None``.

        Returns:
            Dict[str, Any]: Request payload ready to be serialised and posted to the
            chat completions endpoint.
        """
        payload: Dict[str, Any] = {
            "model": "local-model",
            "messages": chat_messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": stream,
        }
        if repeat_penalty is not None:
            payload["repeat_penalty"] = repeat_penalty
        if repeat_last_n is not None:
            payload["repeat_last_n"] = repeat_last_n
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice
        if pydantic_response_format is not None:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": pydantic_response_format.__name__,
                    "schema": pydantic_response_format.model_json_schema(),
                    "strict": True,
                },
            }
        return payload


    async def get_model_health(self) -> Dict[str, Any]:
        """
        Fetches the configured LLM health status.

        Returns:
            Dict[str, Any]: Parsed JSON response from the health endpoint.

        Raises:
            RuntimeError: If the health endpoint returns an error response.
            httpx.HTTPError: If the health request fails.
        """
        started_at = time.monotonic()
        logger.info("Checking LLM router health url={}", _mask_url_for_log(self.health_url) )

        # trust_env=False: the LLM router is a loopback sidecar (127.0.0.1). A
        # corporate HTTP_PROXY must never intercept it - and NO_PROXY CIDR
        # entries like 127.0.0.0/8 are NOT honored by httpx, so relying on the
        # env to exempt loopback is unsafe. Pin a direct connection.
        async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
            response = await client.get(self.health_url, headers=self._headers())
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                logger.warning(
                    "LLM health check failed status={} elapsed_seconds={:.3f}",
                    exc.response.status_code,
                    time.monotonic() - started_at,
                )
                raise RuntimeError(
                    "LLM health check failed with status code "
                    f"{exc.response.status_code}: {_truncate_for_log(exc.response.text)}"
                ) from exc

            logger.info(
                "LLM health check succeeded status=%d elapsed_seconds=%.3f",
                response.status_code,
                time.monotonic() - started_at,
            )
            return response.json()

    async def chat(
        self,
        chat_messages: List[Dict[str, Any]],
        temperature: Optional[float] = 0.1,
        max_tokens: Optional[int] = 10000,
        tools: Optional[List[Dict[str, Any]]] = None,
        pydantic_response_format: Optional[Any] = None,
        tool_choice: str = "auto",
        session_id: Optional[str] = None,
        repeat_penalty: Optional[float] = 1.15,
        repeat_last_n: Optional[int] = 1024,
    ) -> Dict[str, Any]:
        """
        Sends a chat completion request to the configured LLM router.

        Args:
            chat_messages: Conversation messages in OpenAI chat format.
            temperature: Sampling temperature.
            max_tokens: Maximum number of tokens to generate.
            tools: Optional list of tool schemas to pass to the model.
            pydantic_response_format: Optional Pydantic model class for structured JSON output.
            tool_choice: Tool choice strategy (``"auto"``, ``"required"``, ``"none"``).
            session_id: OpenCode session id to attribute usage to (see ``_headers``).
            repeat_penalty: llama.cpp-style repetition penalty; discourages the model
                from re-emitting tokens it already produced. ``None`` omits the field
                and defers to the upstream server's own default.
            repeat_last_n: Trailing-token window considered for ``repeat_penalty``.
                Bounded to recent generation history (default 1024) rather than the
                whole context, since llama.cpp counts prompt tokens too - a whole-context
                window would penalize the model for correctly echoing input content
                (e.g. column names) that legitimately repeats in the prompt. 1024 is
                still comfortably larger than the observed degenerate repeat blocks
                (300-800 tokens per repeated paragraph).

        Returns:
            The full assistant message dict from the response (including any tool_calls).

        Raises:
            RuntimeError: If the response status or payload format is invalid.
            httpx.HTTPError: If the chat request fails.
        """
        payload = self._build_payload(
            chat_messages=chat_messages,
            temperature=temperature,
            max_tokens=max_tokens,
            tools=tools,
            pydantic_response_format=pydantic_response_format,
            tool_choice=tool_choice,
            stream=False,
            repeat_penalty=repeat_penalty,
            repeat_last_n=repeat_last_n,
        )
        started_at = time.monotonic()
        logger.info(
            "Sending LLM chat request model={} messages={} tools={} structured_response={} max_tokens={} temperature={} repeat_penalty={} repeat_last_n={} session_id={}",
            payload.get("model"),
            len(chat_messages),
            len(tools or []),
            pydantic_response_format is not None,
            max_tokens,
            temperature,
            repeat_penalty,
            repeat_last_n,
            session_id or "-",
        )

        # trust_env=False: loopback LLM router, must bypass any corporate proxy
        # (see get_model_health for the NO_PROXY-CIDR rationale).
        async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
            response = await client.post(self.chat_url, headers=self._headers(session_id), json=payload)
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                logger.warning(
                    "LLM chat request failed status={} elapsed_seconds={:.3f} body={}",
                    exc.response.status_code,
                    time.monotonic() - started_at,
                    _truncate_for_log(exc.response.text, 1000),
                )
                if exc.response.status_code == 424 and _is_no_provider_available(exc.response.text):
                    raise NoLocalProviderError(
                        "llmrouter_manager has no local-model provider configured "
                        f"(model={payload.get('model')!r})"
                    ) from exc
                raise RuntimeError(
                    f"LLM chat request failed with status {exc.response.status_code}: {_truncate_for_log(exc.response.text)}"
                ) from exc

            data = response.json()
            
            try:
                assistant_message = data["choices"][0]["message"]
                logger.info(
                    "LLM chat request succeeded model={} status={} elapsed_seconds={:.3f} finish_reason={} tool_calls={} usage={}",
                    data.get("model", payload.get("model")),
                    response.status_code,
                    time.monotonic() - started_at,
                    data["choices"][0].get("finish_reason"),
                    len(assistant_message.get("tool_calls") or []) if isinstance(assistant_message, dict) else 0,
                    data.get("usage"),
                )
                return assistant_message  # type: ignore[no-any-return]
            except (KeyError, IndexError, TypeError) as exc:
                logger.exception("Failed to parse LLM response payload.")
                raise RuntimeError(
                    f"Failed to parse LLM response: keys={list(data.keys()) if isinstance(data, dict) else type(data).__name__} size={len(str(data))}"
                ) from exc

    async def chat_stream(
        self,
        chat_messages: List[Dict[str, Any]],
        temperature: Optional[float] = 0.1,
        max_tokens: Optional[int] = 20000,
        tools: Optional[List[Dict[str, Any]]] = None,
        pydantic_response_format: Optional[Any] = None,
        tool_choice: str = "auto",
        session_id: Optional[str] = None,
        repeat_penalty: Optional[float] = 1.15,
        repeat_last_n: Optional[int] = 1024,
    ) -> Dict[str, Any]:
        """
        Streams a chat completion and assembles the full assistant message.

        Args:
            chat_messages (List[Dict[str, Any]]): Conversation messages in OpenAI chat format.
            temperature (Optional[float]): Sampling temperature.
            max_tokens (Optional[int]): Maximum number of tokens to generate.
            tools (Optional[List[Dict[str, Any]]]): Tool schemas to pass to the model.
            pydantic_response_format (Optional[Any]): Pydantic model class for structured
                JSON output; adds a ``response_format`` block when provided.
            tool_choice (str): Tool choice strategy (``"auto"``, ``"required"``, ``"none"``).
            session_id: OpenCode session id to attribute usage to (see ``_headers``).
            repeat_penalty: llama.cpp-style repetition penalty; discourages the model
                from re-emitting tokens it already produced. ``None`` omits the field
                and defers to the upstream server's own default.
            repeat_last_n: Trailing-token window considered for ``repeat_penalty``.
                Bounded to recent generation history (default 1024) rather than the
                whole context, since llama.cpp counts prompt tokens too - a whole-context
                window would penalize the model for correctly echoing input content
                (e.g. column names) that legitimately repeats in the prompt. 1024 is
                still comfortably larger than the observed degenerate repeat blocks
                (300-800 tokens per repeated paragraph).

        Returns:
            Dict with ``assistant_message`` (full message dict), ``metrics``
            (latency + finish_reason), and ``usage`` (token counts if provided).

        Raises:
            RuntimeError: If the stream response status is an error.
        """
        payload = self._build_payload(
            chat_messages=chat_messages,
            temperature=temperature,
            max_tokens=max_tokens,
            tools=tools,
            pydantic_response_format=pydantic_response_format,
            tool_choice=tool_choice,
            stream=True,
            repeat_penalty=repeat_penalty,
            repeat_last_n=repeat_last_n,
        )

        content_parts: List[str] = []
        tool_calls_map: Dict[int, Dict[str, Any]] = {}
        usage: Optional[Dict[str, Any]] = None
        finish_reason: Optional[str] = None
        t_start = time.monotonic()
        logger.info(
            "Starting LLM chat stream model=%s messages=%d tools=%d structured_response=%s max_tokens=%s temperature=%s repeat_penalty=%s repeat_last_n=%s session_id=%s",
            payload.get("model"),
            len(chat_messages),
            len(tools or []),
            pydantic_response_format is not None,
            max_tokens,
            temperature,
            repeat_penalty,
            repeat_last_n,
            session_id or "-",
        )
        
        # trust_env=False: loopback LLM router, must bypass any corporate proxy
        # (see get_model_health for the NO_PROXY-CIDR rationale).
        async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
            async with client.stream("POST", self.chat_url, headers=self._headers(session_id), json=payload) as response:
                try:
                    response.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    body = await exc.response.aread()
                    body_text = body.decode(errors="replace")
                    logger.warning(
                        "LLM chat stream failed status=%d elapsed_seconds=%.3f",
                        exc.response.status_code,
                        time.monotonic() - t_start,
                    )
                    if exc.response.status_code == 424 and _is_no_provider_available(body_text):
                        raise NoLocalProviderError(
                            "llmrouter_manager has no local-model provider configured "
                            f"(model={payload.get('model')!r})"
                        ) from exc
                    raise RuntimeError(
                        f"LLM stream request failed with status {exc.response.status_code}: {_truncate_for_log(body_text)}"
                    ) from exc

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[len("data:"):].strip()
                    if raw == "[DONE]":
                        break
                    try:
                        chunk = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    if chunk.get("usage"):
                        usage = chunk["usage"]

                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta", {})
                    finish_reason = choices[0].get("finish_reason") or finish_reason

                    if delta.get("content"):
                        content_parts.append(delta["content"])

                    for tc_delta in delta.get("tool_calls") or []:
                        idx: int = tc_delta["index"]
                        if idx not in tool_calls_map:
                            tool_calls_map[idx] = {
                                "id": tc_delta.get("id", ""),
                                "type": "function",
                                "function": {"name": "", "arguments": ""},
                            }
                        tc = tool_calls_map[idx]
                        func = tc_delta.get("function", {})
                        if func.get("name"):
                            tc["function"]["name"] += func["name"]
                        if func.get("arguments"):
                            tc["function"]["arguments"] += func["arguments"]
                        if tc_delta.get("id"):
                            tc["id"] = tc_delta["id"]

        elapsed = time.monotonic() - t_start
        assistant_message: Dict[str, Any] = {
            "role": "assistant",
            "content": "".join(content_parts) or None,
        }
        if tool_calls_map:
            assistant_message["tool_calls"] = [
                tool_calls_map[i] for i in sorted(tool_calls_map)
            ]

        logger.info(
            "LLM chat stream completed elapsed_seconds=%.3f finish_reason=%s content_chars=%d tool_calls=%d usage_present=%s",
            elapsed,
            finish_reason,
            len("".join(content_parts)),
            len(tool_calls_map),
            usage is not None,
        )

        return {
            "assistant_message": assistant_message,
            "metrics": {"latency_seconds": round(elapsed, 3), "finish_reason": finish_reason},
            "usage": usage,
        }

