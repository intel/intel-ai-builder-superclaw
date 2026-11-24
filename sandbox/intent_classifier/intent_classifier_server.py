"""
Intent Classifier Server v3 for Superclaw

Classification into categories:
  - greeting: canned response, no agent
  - ambiguous: ask user for clarification (not cached)
  - coding: route to coding-agent (any code/dev task)
  - email: route to email-agent (email/inbox/calendar/scheduling)
  - default: silent pass-through to superclaw-default (handles everything else)

Key insight: any task whose primary intent is writing/editing code, running dev
tools, or git operations goes to coding-agent; email/inbox/calendar tasks go to
email-agent. superclaw-default handles file analysis, reports, web search,
writing, and memory.

Two-layer classification:
  Layer 1: Rule-based (greetings only — instant, zero cost)
    Layer 2: LLM classification (distinguishes ambiguous vs coding vs default)
"""

import collections
import contextvars
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from starlette.types import ASGIApp, Receive, Scope, Send

logging.basicConfig(
    level=logging.INFO,
    format="[intent-classifier] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("intent-classifier")

# ---------------------------------------------------------------------------
# Configuration (from environment)
# ---------------------------------------------------------------------------

LLM_BASE_URL = os.getenv("LRM_API_BASE_URL", "http://127.0.0.1:18321").rstrip("/") + "/v1"
LLM_API_KEY = os.getenv("LRM_API_KEY", "").strip()
LLM_MODEL = os.getenv("LRM_LOCAL_MODEL", "local-model")

def _resolve_bind_host(value: str | None) -> str:
    """Every caller is on this machine, so loopback unless a host is named.

    A blank value counts as unset: uvicorn binds every interface for an empty host.
    """
    return (value or "").strip() or "127.0.0.1"


PORT = int(os.getenv("CLASSIFIER_PORT", "18791"))
HOST = _resolve_bind_host(os.getenv("CLASSIFIER_HOST"))
CONFIDENCE_THRESHOLD = float(os.getenv("CLASSIFIER_CONFIDENCE_THRESHOLD", "0.6"))
CLASSIFICATION_MODE = os.getenv("CLASSIFIER_CLASSIFICATION_MODE", "enabled").strip().lower()
if CLASSIFICATION_MODE not in {"enabled", "bypass"}:
    raise ValueError(
        "CLASSIFIER_CLASSIFICATION_MODE must be 'enabled' or 'bypass'"
    )

# Whether the Hybrid Deep Research sidecar is available for this Runtime. Set by
# the orchestrator from the validated Product Profile's feature flags. When
# disabled, hybrid_deep_research routes fall
# back to the pure-local deep research agent (which needs no sidecar). Defaults to
# false (fail-safe): if the orchestrator did not explicitly signal an available
# sidecar, route to the pure-local agent rather than a hybrid agent that may have
# no sidecar behind it. The orchestrator always sets this explicitly.
HYBRID_DR_ENABLED = (os.getenv("CLASSIFIER_HYBRID_DR_ENABLED", "false").strip().lower() == "true")


def _deep_research_agent() -> str:
    """Single source of truth for the hybrid_deep_research route target.

    Routes to the hybrid (local+cloud) agent when the HDR sidecar is available,
    otherwise degrades to the pure-local deep research agent.
    """
    return "hybrid-deep-research" if HYBRID_DR_ENABLED else "local-deep-research"

# ---------------------------------------------------------------------------
# Canned Responses
# ---------------------------------------------------------------------------

CANNED_GREETING = (
    "Hello! I'm SuperClaw, your AI assistant at Intel. How can I help you today?"
)
CANNED_IDENTITY = "I'm SuperClaw, an AI assistant built by the SuperClaw team at Intel. I can help with research, email, coding, and general questions."
CANNED_THANKS = "You're welcome! Let me know if there's anything else I can help with."
CANNED_THINKING = "Picking the best approach..."
CANNED_AMBIGUOUS = (
    "I'd like to help, but I need a bit more context:\n"
    "- **Where** should I look? (your emails, a specific file, the web, your calendar)\n"
    "- **What specifically?** (which file/person/project are you referring to?)\n\n"
    "For example, you could say:\n"
    '- "Check my **email** for messages from **John at Acme Corp**"\n'
    '- "Summarize **/projects/q4_report.pdf**"\n'
    '- "Refactor the code in **/projects/myapp/**"\n'
)
CANNED_CODING = "Routing to **Hybrid Coding**..."
CANNED_DEEP_RESEARCH = "Routing to **Deep Research**..."
CANNED_EMAIL = "Routing to **Email & Calendar**..."
CANNED_GENERAL_ASSISTANT = "Routing to **General Assistant**..."
CANNED_INTAKE_FALLBACK = "Tell me a bit more so I can route this correctly."

INTAKE_AGENT_NAME = "intake-agent"
MAX_INTAKE_TURNS = 3
MAX_TRANSCRIPT_WINDOW = 6

INTAKE_PROMPT = """You are the front-door conversational assistant for SuperClaw, an AI workbench at Intel.

Your job in this conversation is:

1. Understand what the user wants.
2. Have a brief natural conversation if their goal is still forming.
3. Once you understand their goal clearly, tell them what you are routing to and why.

You are NOT responsible for actually doing the task. You hand it off.

You run on a lightweight local model. Keep responses short and focused.

When asked who you are or what model you are, say: \"I'm SuperClaw.\"
Do NOT claim to be OpenCode, Qwen, GPT, Claude, or any other model.

Conversation modes:

Mode 1: Fast reply (greetings, identity, thanks, empty input). Reply naturally and briefly.

Mode 2: Intake conversation. Ask at most ONE clarifying question per turn. Do not ask multiple questions at once. Do not try to answer the actual task. Your goal is routing, not execution.

Mode 3: Route-ready handoff. When the route is clear, confirm where you are routing in one sentence and stop asking questions.

Route targets:
- Coding: any task requiring code writing, editing, running, debugging, git, or shell commands
- Deep Research: long comprehensive reports requiring web research across multiple sources
- Email & Calendar: reading, searching, sending, or replying to email/inbox, or viewing/scheduling calendar events and meetings
- General Assistant: everything else — file analysis, web lookups, writing, memory, general questions, using MCP tools, running skills or custom skills, and any task that does not primarily require code writing/editing or deep multi-source research

Note: Route to Coding if the primary goal is writing, editing, debugging, or running code — even if the task also uses a skill, MCP tool, or mentions building/developing one. Route to General Assistant when the task uses an existing tool or skill rather than creating one.

If after 3 turns the intent is still unclear, route to General Assistant.
"""

# ---------------------------------------------------------------------------
# Layer 1: Rule-Based Classification (greetings only)
# ---------------------------------------------------------------------------

_GREETING_PATTERNS = re.compile(
    r"^(hi|hello|hey(\s+there)?|howdy|sup|yo|good\s*(morning|afternoon|evening)|what'?s\s*up|hola"
    r"|你好|嗨|嘿|哈喽|早上好|下午好|晚上好|在吗|hey你好)[\s!?.，。！？]*$",
    re.IGNORECASE,
)

_IDENTITY_PATTERNS = re.compile(
    r"^(who\s+are\s+you|what\s+are\s+you|what\s+model|what\s+llm|are\s+you\s+(gpt|claude|qwen|gemini)"
    r"|你是谁|你是什么模型|你是什么AI|你是哪个模型)[\s!?.，。！？]*$",
    re.IGNORECASE,
)

_THANKS_PATTERNS = re.compile(
    r"^(thanks?|thank\s+you|thx|ty|cheers|谢谢|谢啦|多谢|感谢)[\s!?.，。！？]*$",
    re.IGNORECASE,
)

_SELECTED_CONTEXT_PATTERN = re.compile(
    r"\[Selected (?:file|folder):\s*/workspace/[^\]\r\n]+\]",
    re.IGNORECASE,
)

@dataclass
class RuleResult:
    category: str
    canned_response: str | None = None
    rule_name: str | None = None


def classify_by_rules(text: str) -> RuleResult | None:
    stripped = text.strip()

    if not stripped:
        return RuleResult(
            "greeting", canned_response=CANNED_GREETING, rule_name="empty"
        )

    if _GREETING_PATTERNS.match(stripped):
        return RuleResult(
            "greeting", canned_response=CANNED_GREETING, rule_name="greeting"
        )

    if _IDENTITY_PATTERNS.match(stripped):
        return RuleResult(
            "greeting", canned_response=CANNED_IDENTITY, rule_name="identity"
        )

    if _THANKS_PATTERNS.match(stripped):
        return RuleResult("greeting", canned_response=CANNED_THANKS, rule_name="thanks")

    return None


def _normalize_selected_context_category(category: str, text: str) -> str:
    if category == "ambiguous" and _SELECTED_CONTEXT_PATTERN.search(text):
        return "default"
    return category


# ---------------------------------------------------------------------------
# Layer 2: LLM Classification
# ---------------------------------------------------------------------------

CLASSIFY_PROMPT = """Classify this user request into exactly one category.

CATEGORIES:

1. "ambiguous" — The request is unclear: the user refers to their data without specifying where it lives, lacks critical context, or is too vague to act on.
   - Examples: "Find my outstanding action items" (email? calendar? files?), "What did Mike say about the deadline?" (which channel? which Mike?)
   - When in doubt about the data source, prefer "ambiguous".
   - NOT ambiguous: if user mentions "email/inbox/calendar/meeting/reply/schedule" (source = email/calendar → "email"), or asks about public topics/news/companies (source = web).

2. "hybrid_deep_research" — A LONG comprehensive report (1000+ words) that requires web research across multiple sources, and optionally local file search. Both must be true:
   - The output is a long-form report (not a short answer, not a few paragraphs, not a summary)
   - The task requires searching the web across multiple sources (not just reading local files)
   - NOT hybrid_deep_research → "default": quick web lookups, short answers, local-only file analysis (even if structured/detailed), one-pagers, summaries, simple comparisons

3. "coding" — ANY step requires developer tools (bash, git, code editing). Includes: bug fixes, code generation, refactoring, git ops, test generation, shell tasks, infrastructure code (YAML, CI, Dockerfiles).
   - Multi-step: if ANY step needs code/commands, classify as "coding" (e.g., "read the spec then implement the endpoint" → coding)
   - EXCEPTION: even if a task also touches email/calendar, if ANY step needs code/commands classify as "coding" (e.g., "find the bug and email the fix" → coding).
   - Creating, implementing, editing, debugging, or testing an MCP server or skill is "coding".
   - NOT coding → "default": writing prose, data analysis from files, web search, reading/parsing files without code execution, or using an already-existing MCP tool, built-in skill, or custom skill.
   - A local file path does not prevent coding classification. If the primary goal is writing, editing, running, debugging, or testing code or scripts, classify as "coding" even when a file path is present (e.g., "Run /workspace/run.py", "Edit /workspace/package.json", "Implement the spec in /workspace/spec.docx").

4. "email" — The request's primary intent is reading, searching, sending, or replying to email/inbox messages, OR viewing/creating/scheduling calendar events and meetings.
   - Examples: "check my email", "any urgent emails?", "draft a reply to Sarah's email", "what's on my calendar today", "schedule a meeting with John tomorrow at 2pm".
   - EXCEPTION: if the request references a local file path (e.g. "send /projects/x.csv to John"), classify as "default" — file-referencing requests are always "default".
   - EXCEPTION: if any step needs code/commands, classify as "coding".

5. "default" — EVERYTHING ELSE: file analysis, web search, memory, prose writing, log/CSV/PDF analysis.
   - Requests that reference a local file path and whose primary goal is to READ, SUMMARIZE, EXTRACT, ANALYZE, or COMPARE the file's content (not to write/run/debug code) are "default".
   - Using an existing MCP tool, built-in skill, or custom skill is "default" when the request is otherwise actionable. Do not classify a request as "coding" merely because it mentions a tool, MCP, or skill.
   - A named MCP or skill is a sufficient data source. For example, "use the GitHub MCP to list my pull requests" and "run the docx skill on this report" are not ambiguous.

Request: "{text}"

Answer with ONE word only — ambiguous, hybrid_deep_research, coding, email, or default:"""

VALID_CATEGORIES = {"ambiguous", "hybrid_deep_research", "coding", "email", "default"}


class ClassifierCredentialError(Exception):
    """An LLM credential failure that /classify reports instead of degrading to default."""

    code: str


class LocalLlmConfigError(ClassifierCredentialError):
    """The user's Local LLM settings are wrong; the user can fix this."""

    code = "intent_classifier_local_llm_config_error"


class LrmAuthError(ClassifierCredentialError):
    """The classifier's own LRM credential is missing or rejected; an internal fault."""

    code = "intent_classifier_lrm_auth_error"


# LRM's error code for a missing or wrong inference key (`routing/auth.py`).
_LRM_INVALID_CREDENTIAL_CODE = "invalid_inference_credential"


@dataclass
class LlmConfig:
    base_url: str
    api_key: str
    model: str


@dataclass
class HandoffSummary:
    handoff_version: str
    source_agent: str
    target_agent: str
    routing_reason: str
    user_goal: str
    task_type: str
    clarity_state: str
    confirmed_facts: list[str]
    open_questions: list[str]
    transcript_window: list[dict[str, str]]


def _httpx_verify_setting() -> bool | str:
    insecure = (os.getenv("LRM_TLS_INSECURE") or "").strip().lower()
    if insecure in {"1", "true", "yes"}:
        return False
    cert_file = (os.getenv("SSL_CERT_FILE") or os.getenv("REQUESTS_CA_BUNDLE") or "").strip()
    if cert_file:
        return cert_file
    return True


def _httpx_trust_env_setting(base_url: str) -> bool:
    hostname = (urlparse(base_url).hostname or "").lower()
    if hostname.endswith(".intel.com"):
        return False
    return True


def _strip_jsonc_comments(raw: str) -> str:
    out: list[str] = []
    i = 0
    in_string = False
    escape = False
    while i < len(raw):
        ch = raw[i]
        nxt = raw[i + 1] if i + 1 < len(raw) else ""
        if in_string:
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and nxt == "/":
            i += 2
            while i < len(raw) and raw[i] not in "\r\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            i += 2
            while i + 1 < len(raw) and not (raw[i] == "*" and raw[i + 1] == "/"):
                i += 1
            i = min(i + 2, len(raw))
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _resolve_env_token(value: str, field: str) -> str:
    match = re.fullmatch(r"\{env:([A-Za-z_][A-Za-z0-9_]*)\}", value.strip())
    if not match:
        return value
    env_name = match.group(1)
    resolved = os.getenv(env_name, "").strip()
    if not resolved:
        raise LocalLlmConfigError(
            f"Local LLM {field} references unset environment variable {env_name}"
        )
    return resolved


def _model_from_config(config: dict[str, object], local_llm: dict[str, object] | None = None) -> str | None:
    if local_llm is None:
        provider = config.get("provider")
        local_llm = provider.get("local-llm") if isinstance(provider, dict) else None
    models = local_llm.get("models") if isinstance(local_llm, dict) else None
    if isinstance(models, dict) and models:
        return next(iter(models.keys()))
    small_model = config.get("small_model")
    if isinstance(small_model, str) and small_model.startswith("local-llm/"):
        model = _resolve_env_token(small_model.split("/", 1)[1], "model").strip()
        if model:
            return model.split(",", 1)[0].strip()
    return None


def _load_llm_config() -> LlmConfig:
    config_dir = os.getenv("OPENCODE_CONFIG_DIR", "").strip()
    if config_dir:
        config_path = Path(config_dir) / "opencode.jsonc"
        if config_path.is_file():
            try:
                config = json.loads(
                    _strip_jsonc_comments(config_path.read_text(encoding="utf-8"))
                )
                provider = config.get("provider") if isinstance(config, dict) else None
                local_llm = (
                    provider.get("local-llm") if isinstance(provider, dict) else None
                )
                options = (
                    local_llm.get("options") if isinstance(local_llm, dict) else None
                )
                if isinstance(options, dict):
                    base_url = (
                        _resolve_env_token(str(options.get("baseURL") or ""), "baseURL")
                        .strip()
                        .rstrip("/")
                    )
                    api_key = _resolve_env_token(
                        str(options.get("apiKey") or ""), "apiKey"
                    ).strip()
                    model = _model_from_config(config, local_llm) or LLM_MODEL
                    if base_url and model:
                        return LlmConfig(
                            base_url=base_url, api_key=api_key or "unused", model=model
                        )
            except LocalLlmConfigError:
                raise
            except Exception as e:
                log.warning(
                    "Failed to read local-llm config from %s: %s", config_path, e
                )
    if not LLM_API_KEY:
        message = "LRM_API_KEY is not provisioned for the intent classifier"
        _record_llm_error("credential", LLM_BASE_URL, None, message)
        raise LrmAuthError(message)
    return LlmConfig(base_url=LLM_BASE_URL, api_key=LLM_API_KEY, model=LLM_MODEL)


def _error_envelope_code(body: str) -> str | None:
    try:
        payload = json.loads(body)
    except ValueError:
        return None
    error = payload.get("error") if isinstance(payload, dict) else None
    code = error.get("code") if isinstance(error, dict) else None
    return code if isinstance(code, str) else None


async def _raise_if_credential_error(resp: httpx.Response) -> None:
    if resp.status_code < 400:
        return
    text = (await resp.aread()).decode("utf-8", errors="ignore")
    if (
        resp.status_code == 401
        and _error_envelope_code(text) == _LRM_INVALID_CREDENTIAL_CODE
    ):
        raise LrmAuthError(
            "LLM Router Manager rejected the classifier's inference credential (HTTP 401)"
        )
    if resp.status_code in (401, 403):
        raise LocalLlmConfigError(
            f"Local LLM rejected credentials with HTTP {resp.status_code}"
        )
    lowered = text.lower()
    if any(
        token in lowered
        for token in (
            "api key",
            "apikey",
            "credential",
            "unauthorized",
            "forbidden",
            "authentication",
        )
    ):
        raise LocalLlmConfigError(
            "Local LLM returned an authentication/configuration error"
        )


def _langfuse_correlation_headers(
    session_id: str | None, call_kind: str
) -> dict[str, str]:
    """Session id + call-kind headers so this call's Langfuse trace joins the
    user's OpenCode session (see routing/proxy.py) instead of landing as an
    anonymous orphan trace, and is named after ``call_kind``."""
    headers: dict[str, str] = {}
    if session_id:
        headers["X-Opencode-Session-Id"] = session_id
    headers["X-Superclaw-Call-Kind"] = call_kind
    return headers


async def classify_with_llm(
    text: str, session_id: str | None = None
) -> tuple[str, float, str] | None:
    """Returns (category, confidence, raw_response) or None on failure.

    ``session_id``: the originating OpenCode session id. Forwarded to the
    router as ``X-Opencode-Session-Id`` so the classifier's Langfuse trace
    joins the same session as the user's chat turns instead of landing as
    an anonymous orphan trace with a random id and no session.
    """
    prompt = CLASSIFY_PROMPT.format(text=text[:20000])
    llm_config = _load_llm_config()
    prompt_logging_enabled = _debug_observability_enabled()

    if prompt_logging_enabled:
        log.info(
            "Intent classifier prompt length=%d sha256_12=%s",
            len(prompt),
            hashlib.sha256(prompt.encode("utf-8", errors="replace")).hexdigest()[:12],
        )
    else:
        log.info("Intent classifier prompt length=%d", len(prompt))

    payload = {
        "model": llm_config.model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 256,
        "temperature": 0,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {llm_config.api_key}"}
    headers.update(_langfuse_correlation_headers(session_id, "intent-classification"))

    _t0 = time.perf_counter()
    resp = None
    try:
        # egress-surface: intent_classifier_lrm_chat
        async with httpx.AsyncClient(
            timeout=30.0,
            proxy=None,
            verify=_httpx_verify_setting(),
            trust_env=_httpx_trust_env_setting(llm_config.base_url),
        ) as client:
            resp = await client.post(
                f"{llm_config.base_url}/chat/completions",
                json=payload,
                headers=headers,
            )
            await _raise_if_credential_error(resp)
            resp.raise_for_status()
    except ClassifierCredentialError as e:
        # Auth/credential failure (e.g. the configured endpoint rejected the key,
        # like an edge endpoint returning 403). Record it for observability, then
        # re-raise so the /classify handler emits its explicit error event / 502
        # instead of the request silently degrading to "default".
        _record_llm_error(
            "credential",
            llm_config.base_url,
            getattr(resp, "status_code", None),
            str(e),
        )
        raise
    except httpx.TimeoutException as e:
        _record_llm_error("timeout", llm_config.base_url, None, str(e))
        return None
    except httpx.HTTPError as e:
        status = getattr(
            getattr(e, "response", None),
            "status_code",
            getattr(resp, "status_code", None),
        )
        _record_llm_error("http", llm_config.base_url, status, str(e))
        return None

    # The classification call succeeded — record it for the trajectory (issue
    # #655 item 2). With the local-llm provider this goes direct to the configured
    # endpoint (e.g. superrouter), bypassing the :18321 router, so it would
    # otherwise be invisible.
    _last_intent_llm_meta.set(
        {
            "model": llm_config.model,
            "provider": urlparse(llm_config.base_url).hostname or llm_config.base_url,
            "latency_ms": int((time.perf_counter() - _t0) * 1000),
        }
    )

    data = resp.json()
    message = data["choices"][0]["message"]
    raw = (message.get("content") or "").strip().lower()
    reasoning = (message.get("reasoning") or "")
    if prompt_logging_enabled:
        log.info(
            "LLM raw content length=%d sha256_12=%s reasoning length=%d",
            len(raw),
            hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:12],
            len(reasoning),
        )
    else:
        log.info(
            "LLM raw content length=%d reasoning length=%d",
            len(raw),
            len(reasoning),
        )

    # If content is empty but reasoning has the answer, extract from reasoning
    if not raw and reasoning:
        reasoning = reasoning.lower()
        for cat in VALID_CATEGORIES:
            if (
                reasoning.rstrip().endswith(cat)
                or f"answer: {cat}" in reasoning
                or f"category: {cat}" in reasoning
            ):
                return (cat, 0.85, reasoning[:200])

    first_word = raw.split()[0].strip(".,!?:;\"'") if raw.split() else ""

    if first_word in VALID_CATEGORIES:
        return (first_word, 0.9, raw)

    for cat in VALID_CATEGORIES:
        if cat in raw:
            return (cat, 0.7, raw)

    # If no category found, default is safest
    return ("default", 0.6, raw)


async def continue_intake_conversation(
    history: list[dict[str, str]], session_id: str | None = None
) -> str:
    """``session_id``: forwarded as ``X-Opencode-Session-Id`` (see
    classify_with_llm) so intake turns join the user's Langfuse session."""
    llm_config = _load_llm_config()

    messages = [{"role": "system", "content": INTAKE_PROMPT}]
    messages.extend(history)

    log.info("Intake conversation turns=%d", len(history))

    payload = {
        "model": llm_config.model,
        "messages": messages,
        "max_tokens": 256,
        "temperature": 0,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {llm_config.api_key}"}
    headers.update(_langfuse_correlation_headers(session_id, "intent-intake"))

    try:
        # egress-surface: intent_classifier_lrm_chat
        async with httpx.AsyncClient(
            timeout=30.0,
            proxy=None,
            verify=_httpx_verify_setting(),
            trust_env=_httpx_trust_env_setting(llm_config.base_url),
        ) as client:
            resp = await client.post(
                f"{llm_config.base_url}/chat/completions",
                json=payload,
                headers=headers,
            )
            await _raise_if_credential_error(resp)
            resp.raise_for_status()

        data = resp.json()
        message = data["choices"][0]["message"]
    except ClassifierCredentialError:
        raise
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
        log.warning("Intake conversation LLM call failed; using fallback prompt: %s", exc)
        return CANNED_INTAKE_FALLBACK

    reply = (message.get("content") or "").strip()
    if reply:
        return reply
    reasoning = (message.get("reasoning") or "").strip()
    if reasoning:
        return reasoning.splitlines()[0][:400]
    return CANNED_INTAKE_FALLBACK


def _route_for_category(category: str) -> tuple[str, str, str, str | None]:
    if category == "coding":
        return ("build", "coding", "clear", CANNED_CODING)
    if category == "hybrid_deep_research":
        return (_deep_research_agent(), "deep_research", "clear", CANNED_DEEP_RESEARCH)
    if category == "email":
        return ("email-agent", "email", "clear", CANNED_EMAIL)
    return ("general-task-agent", "general_task", "clear", CANNED_GENERAL_ASSISTANT)


def generate_handoff_summary(
    session_state: "SessionState",
    target_agent: str,
    routing_reason: str,
    task_type: str,
    clarity_state: str,
    max_transcript_turns: int = MAX_TRANSCRIPT_WINDOW,
) -> HandoffSummary:
    transcript_window = session_state.history[-max_transcript_turns:]
    user_turns = [m for m in session_state.history if m.get("role") == "user"]
    user_goal = user_turns[-1]["content"] if user_turns else ""
    return HandoffSummary(
        handoff_version="v1",
        source_agent=INTAKE_AGENT_NAME,
        target_agent=target_agent,
        routing_reason=routing_reason,
        user_goal=user_goal,
        task_type=task_type,
        clarity_state=clarity_state,
        confirmed_facts=[],
        open_questions=[],
        transcript_window=transcript_window,
    )


def _build_classify_text(req: "ClassifyRequest", max_chars: int = 20000) -> str:
    classify_text = req.text[:max_chars]
    session = _sessions.get(req.session_id)
    if not session or not session.history:
        return classify_text

    history_entries = [
        entry.get("content", "")
        for entry in session.history
        if entry.get("role") == "user"
    ]
    if history_entries and history_entries[-1] == req.text:
        history_entries.pop()
    history = history_entries[-2:]
    current_part = f"Current message: {req.text[:max_chars]}"
    wrapper_overhead = 22  # "[Previous messages: " + "] "
    remaining = max_chars - len(current_part) - wrapper_overhead
    included = []
    for prev in reversed(history):
        if remaining <= 0:
            break
        truncated = prev[:remaining]
        included.insert(0, truncated)
        remaining -= len(truncated) + 3  # " | " separator
    if included:
        context = " | ".join(included)
        classify_text = f"[Previous messages: {context}] {current_part}"
        log.info("Prepending %d prior prompts as context (%d chars total)", len(included), len(classify_text))
    return classify_text


# ---------------------------------------------------------------------------
# FastAPI Application
# ---------------------------------------------------------------------------


class ClassifyRequest(BaseModel):
    text: str
    session_id: str
    # One-shot callers (Agent Lab automations) have no one to answer a
    # clarification: the call neither reads nor keeps intake history for
    # session_id, asks no clarifying question, and records no display turn
    # for a UI to hydrate.
    stateless: bool = False


class ClassifyResponse(BaseModel):
    category: str  # "greeting", "ambiguous", "coding", "email", "default"
    agent: str | None
    response: str | None
    confidence: float
    rule_matched: str | None
    latency_ms: float
    # Non-null when the classifier's own LLM call failed. Carries the sanitized
    # failure detail (kind/endpoint/status/message) so a failure is explicit
    # rather than masquerading as a real "default". Surfaced to UI + trajectory.
    llm_error: dict[str, object] | None = None
    intake_state: str | None = None
    turn_count: int = 0
    handoff_summary: dict[str, object] | None = None


# ---------------------------------------------------------------------------
# Session State
# - Resolved sessions: cached agent (no re-classification needed)
# - Ambiguous sessions: stored prompt history (prepended on re-classify)
# ---------------------------------------------------------------------------


@dataclass
class SessionState:
    history: list[dict[str, str]]
    turn_count: int = 0
    intake_state: str = "intake_chat"


_sessions: dict[str, SessionState] = {}  # session_id → ambiguous history only

# ---------------------------------------------------------------------------
# Session display cache (UI / Slack parity — issue #1726)
# ---------------------------------------------------------------------------
# When the channel bridge handles a canned classifier reply in Slack only, the
# desktop app still opens the OpenCode session but has an empty transcript.
# Record canned turns here (keyed by opencode session_id) so OpenWork can hydrate
# synthetic classifier rows without changing the router.

_DISPLAY_MAX_SESSIONS = max(1, int(os.getenv("INTENT_CLASSIFIER_DISPLAY_MAX_SESSIONS", "500") or "500"))
_DISPLAY_MAX_TURNS_PER_SESSION = max(1, int(os.getenv("INTENT_CLASSIFIER_DISPLAY_MAX_TURNS", "32") or "32"))
# Cap per-field text so the cache can't retain (or serve) large user prompts;
# canned replies and the prompts that trigger them are short in practice.
_DISPLAY_MAX_TEXT_CHARS = max(1, int(os.getenv("INTENT_CLASSIFIER_DISPLAY_MAX_TEXT_CHARS", "2000") or "2000"))
_session_display: dict[str, list[dict[str, object]]] = {}


def _clip_display_text(text: str) -> str:
    return text if len(text) <= _DISPLAY_MAX_TEXT_CHARS else text[:_DISPLAY_MAX_TEXT_CHARS]


def _display_turn_kind(result: ClassifyResponse) -> str | None:
    if not (result.response and str(result.response).strip()):
        return None
    if result.agent:
        return None
    if result.category == "ambiguous" or result.intake_state == "intake_chat":
        return "ambiguous"
    if result.category == "greeting":
        return "greeting"
    return "generic"


def _record_session_display(req: ClassifyRequest, result: ClassifyResponse) -> None:
    kind = _display_turn_kind(result)
    if not kind:
        return
    sid = req.session_id.strip()
    if not sid:
        return
    while len(_session_display) >= _DISPLAY_MAX_SESSIONS and sid not in _session_display:
        _session_display.pop(next(iter(_session_display)))
    turns = _session_display.setdefault(sid, [])
    turns.append(
        {
            "user_text": _clip_display_text(req.text),
            "response": _clip_display_text(str(result.response).strip()),
            "kind": kind,
            "category": result.category,
            "recorded_at_ms": int(time.time() * 1000),
        }
    )
    if len(turns) > _DISPLAY_MAX_TURNS_PER_SESSION:
        del turns[: len(turns) - _DISPLAY_MAX_TURNS_PER_SESSION]


def _session_display_payload(session_id: str) -> dict[str, object]:
    sid = session_id.strip()
    turns = _session_display.get(sid, [])
    return {"session_id": sid, "turns": list(turns)}


# INTENT_CLASSIFIER_TOKEN gates every route except GET/HEAD /health. The display
# cache still holds raw user text, so _require_loopback_for_display remains as
# defence in depth on top of the caller credential (OpenWork proxy is loopback).
_LOOPBACK_DISPLAY_CLIENTS = frozenset(
    {"127.0.0.1", "::1", "localhost", "testclient"}
)


def _require_loopback_for_display(request: Request) -> None:
    client = request.client
    if client is None or client.host not in _LOOPBACK_DISPLAY_CLIENTS:
        raise HTTPException(status_code=403, detail="forbidden")


# ---------------------------------------------------------------------------
# Debug observability (gated by SUPERCLAW_DEBUG_OBSERVABILITY=1)
# ---------------------------------------------------------------------------
# A bounded ring buffer of recent classification decisions, exposed at
# GET /debug/intent for the SuperClaw trajectory inspector. This is the
# "intent" stage of the request chain (UI prompt → intent → agent → ...).
# Mirrors the llmrouter's debug trace contract: default OFF; when ON, never
# store raw prompt text — only length + a sha256[:12] join key the inspector
# recomputes from the opencode user message (see `shaKey` in
# tools/trajectory/src/turns.ts). Unlike the llmrouter, the classifier receives
# the real opencode `session_id`, so it is safe to expose for correlation.

_DEBUG_BUFFER_SIZE = max(1, int(os.getenv("SUPERCLAW_DEBUG_TRACE_BUFFER_SIZE", "50") or "50"))
_intent_trace_buffer: "collections.deque[dict[str, object]]" = collections.deque(maxlen=_DEBUG_BUFFER_SIZE)

# Per-request metadata for the intent-classification LLM call (the classifier's
# own call to the configured model — a real LLM call that must be observable;
# issue #655 item 2). Set in classify_with_llm, read in _record_intent_trace.
# ContextVar is async-task-local (one per FastAPI request), so no cross-request
# bleed; unset (None) on the rule/greeting path, which makes no LLM call.
_last_intent_llm_meta: "contextvars.ContextVar[dict[str, object] | None]" = contextvars.ContextVar(
    "_last_intent_llm_meta", default=None
)

# Counterpart to _last_intent_llm_meta for FAILED classifier LLM calls. The naive
# path logged WARNING and returned a clean "default" — the failure was invisible to
# the trace, the trajectory inspector, and the user. Capture every failure here so
# it is surfaced everywhere (ERROR log + ClassifyResponse.llm_error + debug trace).
_last_intent_llm_error: "contextvars.ContextVar[dict[str, object] | None]" = contextvars.ContextVar(
    "_last_intent_llm_error", default=None
)


def _record_llm_error(kind: str, base_url: str, status: int | None, message: str) -> dict[str, object]:
    """Stash + ERROR-log an intent-classifier LLM-call failure (no secrets). Returns
    the sanitized detail dict so callers can also attach it to the response."""
    endpoint = urlparse(base_url).hostname or base_url
    detail: dict[str, object] = {
        "kind": kind,            # "credential" | "http" | "timeout"
        "endpoint": endpoint,
        "status": status,
        "message": (message or "")[:300],
    }
    _last_intent_llm_error.set(detail)
    log.error(
        "intent-classifier LLM call FAILED (kind=%s endpoint=%s status=%s): %s",
        kind,
        endpoint,
        status,
        detail["message"],
    )
    return detail


def _debug_observability_enabled() -> bool:
    """Read the debug flag fresh each call so tests can toggle without reload."""
    return (os.environ.get("SUPERCLAW_DEBUG_OBSERVABILITY") or "").strip() == "1"


def _sha_text(text: str) -> str:
    """sha256(text)[:12] — the per-turn join key the inspector recomputes."""
    if not text:
        return ""
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:12]


def _record_intent_trace(req: "ClassifyRequest", result: "ClassifyResponse") -> None:
    """Record a sanitized classification decision. No-op unless the debug flag
    is set, so production pays ~zero cost. Never stores raw prompt text."""
    if not _debug_observability_enabled():
        return
    _intent_trace_buffer.append(
        {
            "trace_id": secrets.token_hex(8),
            "started_at_ms": int(time.time() * 1000),
            "session_id": req.session_id,
            "user_query_len": len(req.text or ""),
            "user_query_sha": _sha_text(req.text or ""),
            "category": result.category,
            "agent": result.agent,
            "confidence": result.confidence,
            "rule_matched": result.rule_matched,
            "latency_ms": result.latency_ms,
            "intake_state": result.intake_state,
            "turn_count": result.turn_count,
            # The classifier's own LLM call (the configured model). None on the
            # rule/greeting path (no LLM call). See #655 item 2.
            "llm_model": (_last_intent_llm_meta.get() or {}).get("model"),
            "llm_provider": (_last_intent_llm_meta.get() or {}).get("provider"),
            "llm_latency_ms": (_last_intent_llm_meta.get() or {}).get("latency_ms"),
            # Non-null when the classifier's LLM call failed (auth/http/timeout).
            # The trajectory inspector highlights this as an API error.
            "llm_error": result.llm_error or _last_intent_llm_error.get(),
        }
    )


def _configured_caller_token() -> str | None:
    token = (os.environ.get("INTENT_CLASSIFIER_TOKEN") or "").strip()
    return token or None


def _caller_auth_health_exempt(scope: Scope) -> bool:
    if scope["type"] != "http":
        return False
    method = scope.get("method", "").upper()
    path = scope.get("path", "")
    return method in ("GET", "HEAD") and path == "/health"


class IntentClassifierCallerAuthMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope_type = scope["type"]
        if scope_type == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope_type == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        if scope_type != "http":
            return
        if _caller_auth_health_exempt(scope):
            await self.app(scope, receive, send)
            return
        token = _configured_caller_token()
        if token is None:
            response = JSONResponse(
                status_code=503,
                content={
                    "code": "intent_classifier_auth_unconfigured",
                    "message": "Intent classifier has no caller credential configured",
                },
            )
            await response(scope, receive, send)
            return
        auth_values = [
            value.decode("latin-1")
            for name, value in scope.get("headers", [])
            if name.lower() == b"authorization"
        ]
        if len(auth_values) != 1:
            await self._unauthorized(scope, receive, send)
            return
        scheme, separator, credential = auth_values[0].partition(" ")
        if (
            separator != " "
            or scheme.lower() != "bearer"
            or not credential
            or not hmac.compare_digest(credential.encode("utf-8"), token.encode("utf-8"))
        ):
            await self._unauthorized(scope, receive, send)
            return
        await self.app(scope, receive, send)

    async def _unauthorized(self, scope: Scope, receive: Receive, send: Send) -> None:
        response = JSONResponse(
            status_code=401,
            content={
                "code": "intent_classifier_unauthorized",
                "message": "Missing or invalid intent classifier credential",
            },
            headers={"WWW-Authenticate": "Bearer"},
        )
        await response(scope, receive, send)


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info(
        "Intent classifier v2 starting on %s:%d (model=%s, classification_mode=%s)",
        HOST,
        PORT,
        LLM_MODEL,
        CLASSIFICATION_MODE,
    )
    if _configured_caller_token() is None:
        log.warning(
            "Intent classifier caller credential (INTENT_CLASSIFIER_TOKEN) is not configured"
        )
    yield
    log.info("Intent classifier shutting down")


app = FastAPI(title="Intent Classifier", lifespan=lifespan)
app.add_middleware(IntentClassifierCallerAuthMiddleware)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "intent-classifier",
        "version": "2",
        "classification_mode": CLASSIFICATION_MODE,
    }


@app.get("/session/{session_id}/display")
async def session_display(session_id: str, request: Request) -> dict[str, object]:
    """Canned classifier turns for an OpenCode session (Slack/Telegram UI hydrate)."""
    _require_loopback_for_display(request)
    return _session_display_payload(session_id)


@app.get("/debug/intent")
async def debug_intent():
    """Recent classification decisions for the trajectory inspector. Returns 404
    unless SUPERCLAW_DEBUG_OBSERVABILITY=1 (mirrors the llmrouter contract)."""
    if not _debug_observability_enabled():
        return JSONResponse(
            status_code=404, content={"detail": "debug observability disabled"}
        )
    traces = list(_intent_trace_buffer)
    return {"enabled": True, "count": len(traces), "traces": traces}


def _sse_event(data: dict[str, object]) -> str:
    return f"data: {json.dumps(data)}\n\n"


async def _classify_core(req: ClassifyRequest) -> tuple[ClassifyResponse, bool]:
    """Core classification logic. Returns (response, used_llm)."""
    start = time.perf_counter()
    MAX_CLASSIFY_CHARS = 20000

    if CLASSIFICATION_MODE == "bypass":
        _sessions.pop(req.session_id, None)
        elapsed = (time.perf_counter() - start) * 1000
        log.info("Classification bypassed → default (%.1fms)", elapsed)
        return ClassifyResponse(
            category="default",
            agent="superclaw-default",
            response=None,
            confidence=1.0,
            rule_matched="profile_bypass",
            latency_ms=elapsed,
        ), False

    # Layer 1: Rule-based fast paths
    rule_result = classify_by_rules(req.text)
    if rule_result:
        elapsed = (time.perf_counter() - start) * 1000
        log.info(
            "Rule '%s' matched -> %s (%.1fms)",
            rule_result.rule_name,
            rule_result.category,
            elapsed,
        )
        if rule_result.category == "default":
            _sessions.pop(req.session_id, None)
            return ClassifyResponse(
                category="default",
                agent="general-task-agent",
                response=rule_result.canned_response,
                confidence=1.0,
                rule_matched=rule_result.rule_name,
                latency_ms=elapsed,
                intake_state="route_ready",
                handoff_summary=asdict(
                    generate_handoff_summary(
                        SessionState(history=[{"role": "user", "content": req.text}], turn_count=1, intake_state="route_ready"),
                        target_agent="general-task-agent",
                        routing_reason=f"Rule '{rule_result.rule_name}' resolved to default/general task route.",
                        task_type="general_task",
                        clarity_state="clear",
                    )
                ),
            ), False
        return ClassifyResponse(
            category=rule_result.category,
            agent=None,
            response=rule_result.canned_response,
            confidence=1.0,
            rule_matched=rule_result.rule_name,
            latency_ms=elapsed,
            intake_state="fast_reply",
        ), False

    session = _sessions.get(req.session_id)
    if session and session.intake_state == "intake_chat":
        session.history.append({"role": "user", "content": req.text})
        session.turn_count += 1

        if session.turn_count >= MAX_INTAKE_TURNS:
            summary = generate_handoff_summary(
                session,
                target_agent="general-task-agent",
                routing_reason="Intake reached max clarification turns without a specialist-ready route.",
                task_type="general_task",
                clarity_state="needs_followup",
            )
            session.intake_state = "route_ready"
            _sessions.pop(req.session_id, None)
            elapsed = (time.perf_counter() - start) * 1000
            return ClassifyResponse(
                category="default",
                agent="general-task-agent",
                response=CANNED_GENERAL_ASSISTANT,
                confidence=0.5,
                rule_matched=None,
                latency_ms=elapsed,
                intake_state="route_ready",
                turn_count=session.turn_count,
                handoff_summary=asdict(summary),
            ), True

        llm_result = await classify_with_llm(
            _build_classify_text(req, MAX_CLASSIFY_CHARS), session_id=req.session_id
        )
        elapsed = (time.perf_counter() - start) * 1000
        if llm_result is None:
            err = _last_intent_llm_error.get()
            return ClassifyResponse(
                category="default",
                agent="general-task-agent",
                response=CANNED_GENERAL_ASSISTANT,
                confidence=0.5,
                rule_matched=None,
                latency_ms=elapsed,
                llm_error=err,
                intake_state="route_ready",
                turn_count=session.turn_count,
                handoff_summary=asdict(
                    generate_handoff_summary(
                        session,
                        target_agent="general-task-agent",
                        routing_reason="Classifier LLM failed during intake; escalating to general tasks.",
                        task_type="general_task",
                        clarity_state="needs_followup",
                    )
                ),
            ), True

        category, confidence, _ = llm_result
        category = _normalize_selected_context_category(category, req.text)
        if category != "ambiguous":
            target_agent, task_type, clarity_state, response = _route_for_category(category)
            routing_reason = f"Intake resolved to {category}."
            summary = generate_handoff_summary(
                session,
                target_agent=target_agent,
                routing_reason=routing_reason,
                task_type=task_type,
                clarity_state=clarity_state,
            )
            _sessions.pop(req.session_id, None)
            return ClassifyResponse(
                category=category if category != "default" else "default",
                agent=target_agent,
                response=response,
                confidence=confidence,
                rule_matched=None,
                latency_ms=elapsed,
                intake_state="route_ready",
                turn_count=session.turn_count,
                handoff_summary=asdict(summary),
            ), True

        reply = await continue_intake_conversation(
            session.history, session_id=req.session_id
        )
        session.history.append({"role": "assistant", "content": reply})
        return ClassifyResponse(
            category="ambiguous",
            agent=None,
            response=reply,
            confidence=confidence,
            rule_matched=None,
            latency_ms=elapsed,
            intake_state="intake_chat",
            turn_count=session.turn_count,
        ), True

    # Build context from previous user prompts (if any) before first-pass LLM classification.
    classify_text = _build_classify_text(req, MAX_CLASSIFY_CHARS)

    # Layer 2: LLM classification
    llm_result = await classify_with_llm(classify_text, session_id=req.session_id)
    elapsed = (time.perf_counter() - start) * 1000

    if llm_result is None:
        # The classifier's LLM call FAILED (already ERROR-logged + recorded by
        # _record_llm_error). We still fall back to the default agent so the request
        # proceeds, but the failure is now explicit on the response (llm_error) so it
        # is no longer a silent default — the UI + trajectory surface it.
        err = _last_intent_llm_error.get()
        log.error(
            "LLM classification FAILED, degrading to default agent (%.1fms): %s",
            elapsed,
            err,
        )
        return ClassifyResponse(
            category="default",
            agent="general-task-agent",
            response=None,
            confidence=0.5,
            rule_matched=None,
            latency_ms=elapsed,
            llm_error=err,
            intake_state="route_ready",
            handoff_summary=asdict(
                generate_handoff_summary(
                    SessionState(history=[{"role": "user", "content": req.text}], turn_count=1, intake_state="route_ready"),
                    target_agent="general-task-agent",
                    routing_reason="Classifier LLM failed before route determination; falling back to general tasks.",
                    task_type="general_task",
                    clarity_state="needs_followup",
                )
            ),
        ), True

    category, confidence, raw = llm_result
    category = _normalize_selected_context_category(category, req.text)

    if category == "ambiguous":
        if req.stateless:
            log.info("LLM → ambiguous (conf=%.2f, %.1fms, stateless)", confidence, elapsed)
            return ClassifyResponse(
                category="ambiguous",
                agent=None,
                response=None,
                confidence=confidence,
                rule_matched=None,
                latency_ms=elapsed,
            ), True
        if req.session_id not in _sessions:
            _sessions[req.session_id] = SessionState(history=[{"role": "user", "content": req.text}], turn_count=1)
        else:
            _sessions[req.session_id].history.append({"role": "user", "content": req.text})
            _sessions[req.session_id].turn_count += 1
        log.info(
            "LLM → ambiguous (conf=%.2f, %.1fms, history=%d)",
            confidence,
            elapsed,
            len(_sessions[req.session_id].history),
        )
        reply = await continue_intake_conversation(_sessions[req.session_id].history)
        _sessions[req.session_id].history.append({"role": "assistant", "content": reply})
        return ClassifyResponse(
            category="ambiguous",
            agent=None,
            response=reply,
            confidence=confidence,
            rule_matched=None,
            latency_ms=elapsed,
            intake_state="intake_chat",
            turn_count=_sessions[req.session_id].turn_count,
        ), True

    # Clear ambiguous history on resolution
    _sessions.pop(req.session_id, None)

    if category == "hybrid_deep_research":
        log.info("LLM → hybrid_deep_research (conf=%.2f, %.1fms)", confidence, elapsed)
        deep_research_agent = _deep_research_agent()
        return ClassifyResponse(
            category="hybrid_deep_research",
            agent=deep_research_agent,
            response=CANNED_DEEP_RESEARCH,
            confidence=confidence,
            rule_matched=None,
            latency_ms=elapsed,
            intake_state="route_ready",
            handoff_summary=asdict(
                generate_handoff_summary(
                    SessionState(history=[{"role": "user", "content": req.text}], turn_count=1, intake_state="route_ready"),
                    target_agent=deep_research_agent,
                    routing_reason="Classifier resolved to hybrid_deep_research.",
                    task_type="deep_research",
                    clarity_state="clear",
                )
            ),
        ), True

    if category == "coding":
        log.info("LLM → coding (conf=%.2f, %.1fms)", confidence, elapsed)
        return ClassifyResponse(
            category="coding",
            agent="build",
            response=CANNED_CODING,
            confidence=confidence,
            rule_matched=None,
            latency_ms=elapsed,
            intake_state="route_ready",
            handoff_summary=asdict(
                generate_handoff_summary(
                    SessionState(history=[{"role": "user", "content": req.text}], turn_count=1, intake_state="route_ready"),
                    target_agent="build",
                    routing_reason="Classifier resolved to coding.",
                    task_type="coding",
                    clarity_state="clear",
                )
            ),
        ), True

    if category == "email":
        log.info("LLM → email (conf=%.2f, %.1fms)", confidence, elapsed)
        return ClassifyResponse(
            category="email",
            agent="email-agent",
            response=CANNED_EMAIL,
            confidence=confidence,
            rule_matched=None,
            latency_ms=elapsed,
            intake_state="route_ready",
            handoff_summary=asdict(
                generate_handoff_summary(
                    SessionState(history=[{"role": "user", "content": req.text}], turn_count=1, intake_state="route_ready"),
                    target_agent="email-agent",
                    routing_reason="Classifier resolved to email.",
                    task_type="email",
                    clarity_state="clear",
                )
            ),
        ), True

    # default — silent pass-through
    log.info("LLM → default (conf=%.2f, %.1fms)", confidence, elapsed)
    return ClassifyResponse(
        category="default",
        agent="general-task-agent",
        response=None,
        confidence=confidence,
        rule_matched=None,
        latency_ms=elapsed,
        intake_state="route_ready",
        handoff_summary=asdict(
            generate_handoff_summary(
                SessionState(history=[{"role": "user", "content": req.text}], turn_count=1, intake_state="route_ready"),
                target_agent="general-task-agent",
                routing_reason="Classifier resolved to default/general task route.",
                task_type="general_task",
                clarity_state="clear",
            )
        ),
    ), True


async def _classify_request(req: ClassifyRequest) -> ClassifyResponse:
    if not req.stateless:
        result, _ = await _classify_core(req)
        _record_session_display(req, result)
        return result
    _sessions.pop(req.session_id, None)
    try:
        result, _ = await _classify_core(req)
    finally:
        _sessions.pop(req.session_id, None)
    return result


@app.post("/classify")
async def classify(req: ClassifyRequest, request: Request):
    accept = request.headers.get("accept", "")

    if "text/event-stream" in accept:

        async def _stream():
            # Bypass mode skips all rules and LLM classification.
            rule_result = classify_by_rules(req.text) if CLASSIFICATION_MODE == "enabled" else None
            needs_llm = CLASSIFICATION_MODE == "enabled" and rule_result is None

            if needs_llm:
                yield _sse_event({"type": "thinking", "message": CANNED_THINKING})

            try:
                result = await _classify_request(req)
            except ClassifierCredentialError as e:
                err = _last_intent_llm_error.get() or {"kind": "credential", "message": str(e)}
                _record_intent_trace(req, ClassifyResponse(
                    category="error", agent=None, response=None, confidence=0.0,
                    rule_matched=None, latency_ms=0.0, llm_error=err, turn_count=0,
                ))
                yield _sse_event(
                    {
                        "type": "error",
                        "code": e.code,
                        "message": str(e),
                        "llm_error": err,
                    }
                )
                return
            _record_intent_trace(req, result)
            yield _sse_event(
                {
                    "type": "result",
                    "category": result.category,
                    "agent": result.agent,
                    "response": result.response,
                    "confidence": result.confidence,
                    "rule_matched": result.rule_matched,
                    "latency_ms": result.latency_ms,
                    "intake_state": result.intake_state,
                    "turn_count": result.turn_count,
                    "handoff_summary": result.handoff_summary,
                }
            )

        return StreamingResponse(_stream(), media_type="text/event-stream")
    else:
        try:
            result = await _classify_request(req)
            _record_intent_trace(req, result)
            return result
        except ClassifierCredentialError as e:
            err = _last_intent_llm_error.get() or {
                "kind": "credential",
                "message": str(e),
            }
            # These error paths return before the normal _record_intent_trace above,
            # so record the failure here too — the trajectory must show it.
            _record_intent_trace(req, ClassifyResponse(
                category="error", agent=None, response=None, confidence=0.0,
                rule_matched=None, latency_ms=0.0, llm_error=err, turn_count=0,
            ))
            return JSONResponse(
                status_code=502,
                content={
                    "code": e.code,
                    "message": str(e),
                    "llm_error": err,
                },
            )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from importlib import import_module

    uvicorn = import_module("uvicorn")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
