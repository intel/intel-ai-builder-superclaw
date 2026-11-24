"""The outbound half of refine: one chat completion against LRM's data plane.

WHY THIS SERVICE MAKES THE CALL AND NOT THE UI. LRM's ``/v1/*`` data plane is
bearer-authenticated against an inference key that ServiceHub fetches from LRM
and injects, as ``LRM_API_KEY``, only into services that declare
``depends_on: ["llmrouter_manager"]`` (``supervisor/process_manager.py``). The
hub's proxy strips ``authorization`` from every request it forwards
(``proxy/forwarder.py``), so the renderer cannot reach that data plane at all --
by design, and the design is right: it means no cloud credential and no
inference key ever lives in a WebView. asr_manager already holds the dictation
audio, so it is the natural place for the pass that follows it.

THREE MODES, ONE DIFFERENCE. All send the same scaled budget and the same
reasoning off switch; they differ in which model answers and -- for the local
mode only -- which prompt file is sent.

  ``agent``  -- ``model: "cloud-model"``, LRM's existing alias for whatever cloud
                provider/model the user configured for their agent. Nothing new
                is needed on the LRM side, so this mode works against today's
                data plane.
  ``preset``  -- an OpenRouter model the user picked, defaulting to the measured
                dictation default (MiniMax M3), with the endpoint-routing
                preference measured for THAT model. LRM's ``/v1/chat/completions``
                accepts only the three aliases ``auto``/``local-model``/
                ``cloud-model``, so this mode goes to the pinned-completion route
                instead. See ``routing/pinned.py``.
  ``local``   -- ``model: "local-model"``, LRM's alias for the committed primary
                bundle: the GGUF the user's hardware was gated onto (a 4B on a
                32 GB PTL box). Nothing is dictated to the cloud at all on this
                path, and nothing is billed.

WHY THE LOCAL MODE NEEDS NO NEW ENGINE, NO NEW DOWNLOAD AND NO NEW FLAGS. It is
the alias route again, so the model is whichever bundle the
``hardware -> eligible Model Bundles -> committed Binding`` chain already
selected -- this service neither picks nor ranks it (AGENTS.md §5c). And the one
property the clean-up task actually demands of a model, a reasoning off switch,
is already satisfied server-side: ``local/supervisor.py`` launches llama-server
with ``--reasoning off --reasoning-budget 0 --jinja --chat-template-kwargs
{"enable_thinking":false}``. So the hard constraint ``providers.py`` spends its
whole docstring enforcing for cloud models is, on this path, a property of the
process the bundle already runs in.

WHICH IS WHY THE LOCAL BODY OMITS TWO MEMBERS THE CLOUD BODIES CARRY. The local
dispatch forwards the request body VERBATIM to llama-server -- ``proxy.py``'s
``_httpx_chat_completions`` does ``llm_body = dict(body)`` and rewrites only
``model``, where the cloud path rebuilds its kwargs from an allow-list. So
anything sent here arrives at llama.cpp, and both of these would arrive as dead
weight:

  * ``disable_thinking`` is acted on for OpenRouter alone
    (``cloud/dispatch.py::_build_litellm_kwargs``) and would be redundant anyway
    against the launch flags above.
  * ``usage_alias`` is read only by the pinned route (``routing/pinned.py``), and
    a local completion is not billed, so there is no spend for it to separate.

Omitting them is not a micro-optimisation: it is declining to send an inference
server fields whose handling is not ours to assume. llama.cpp is permissive about
unknown members today, but that is a property of a vendored upstream rather than
a contract this service is entitled to depend on, and the failure if it ever
tightens is every local dictation 400ing at once. The cloud bodies are left
byte-identical, which is what ``test_refine_client`` pins.

WHAT THE LOCAL MODE TRADES. Tokens are produced by the user's own iGPU, so the
wall clock is hardware-bound rather than network-bound: a cold or busy local
server can exceed :data:`_TIMEOUT_S` where the measured cloud preset took ~1 s.
That degrades exactly as every other failure here does -- to the raw ASR
transcript, which the renderer still holds -- so the cost of a slow local model
is a dictation that is not polished, never one that is lost. The scaled
``prompt.output_budget`` ceiling is a CAP and not an allocation, so it does not
need re-deriving per tier: with reasoning off the completion is about as long as
the transcript, and the timeout is what decides "too slow" on every mode.

DEGRADATION IS THE CALLER'S JOB, NOT THIS MODULE'S. Everything here raises
:class:`RefineError` with a status/code/message triple, exactly as
``recognize.audio.AudioError`` does, and the route maps it 1:1 onto the service's
one error envelope. The renderer still holds the raw ASR text from
``/transcribe``, so an error here costs the user their *polish*, never their
dictation -- which is why no fallback text is invented at this layer.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Literal

from . import preference, providers
from .prompt import (
    LOCAL_PROMPT_ID,
    PROMPT_ID,
    PromptError,
    output_budget,
    system_prompt,
    wrap_transcript,
)

RefineMode = Literal["agent", "preset", "local"]

_DEFAULT_BASE_URL = "http://127.0.0.1:18321"
_BASE_URL_ENV = "LRM_BASE_URL"
_API_KEY_ENV = "LRM_API_KEY"
_HOST_API_KEY_ENV = "LRM_HOST_API_KEY"
"""The host-only data-plane credential, for ``/v1/chat/completions/pinned``.

ServiceHub grants this to host services and **withholds it from the sandbox
container**, which is what lets LRM refuse a pinned completion to
agent-authored code -- that route names its own provider, model and usage
label, so on the shared key sandboxed code could spend the user's cloud
credential on any connected model and file it under ``dictation-refine``.

Falls back to :data:`_API_KEY_ENV` when unset, so an ``asr-manager`` running
against a standalone LRM (no sandbox, therefore no privilege boundary) still
works -- and so this PR does not become a hard dependency on a ServiceHub that
has not shipped the split yet."""

# NOTE THE MISSING `/llm-router` PREFIX, WHICH IS NOT AN OVERSIGHT. LRM mounts its
# CONTROL plane under `/llm-router/v1/...` but its inference DATA plane at plain
# `/v1/...` (`routing/api.py`: `APIRouter(prefix="/v1")`). Both are reachable on
# the same port, so the wrong prefix does not fail loudly -- it returns FastAPI's
# default 404 `{"detail": ...}`, which is not LRM's error envelope, so it would
# surface as a generic upstream failure and every dictation would silently
# degrade to raw ASR. Verified against the running app: `/llm-router/v1/chat/
# completions` -> 404, `/v1/chat/completions` -> the real handler.
#
# This is also why these are DIRECT URLs and not ServiceHub proxy paths: the hub
# strips `authorization` from everything it forwards, so the inference bearer
# could not survive the hop. asr_manager talks to LRM on loopback instead.
_CHAT_PATH = "/v1/chat/completions"
_PINNED_PATH = "/v1/chat/completions/pinned"

_USAGE_ALIAS = "dictation-refine"
"""Written to the usage ledger's free-text ``alias`` column so dictation spend is
separable from agent spend. It cannot go in ``source``, which is CHECK-constrained
to ``cloud|local|edge`` (``common/usage_store.py``)."""

_TIMEOUT_S = 20.0
"""Deliberately under ServiceHub's 30 s upstream read timeout.

Above it the hub returns its own 504 and the real cause -- a slow endpoint -- is
reported as a gateway failure of *this* service. 20 s is ~20x the measured median
for the preset (0.97 s on the preferred endpoint), so it bites only on a genuinely
stuck call."""


class RefineError(RuntimeError):
    """A refine attempt that failed, pre-mapped to the service's error envelope.

    Carries the same ``status``/``code``/``message`` triple as
    ``recognize.audio.AudioError`` so the route can map it without a second
    translation table.
    """

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


@dataclass(frozen=True)
class RefineResult:
    text: str
    model: str
    """What actually answered, as LRM reports it. Not what was asked for: in
    ``agent`` mode the alias hides the model, and in ``preset`` mode fallbacks are
    deliberately left on, so "which model produced this text" is otherwise
    unanswerable from a log."""
    prompt_id: str
    served_by: str
    """The upstream endpoint OpenRouter used, when it says. Empty otherwise.

    Recorded because the endpoint order is a *preference* with fallbacks on:
    without this there is no way to tell a dictation that went to the preferred
    endpoint from one that fell through to a slow one -- which is exactly the
    question a slow dictation raises."""


def is_configured() -> bool:
    """Whether this process was given an inference key at all.

    False means the ``depends_on`` wiring is missing (or this is a bare
    ``asr-manager`` run outside ServiceHub). Checked before building a request so
    the failure is "refine is not available on this install", not a 401 from a
    service the user has never heard of.
    """
    return bool(os.environ.get(_API_KEY_ENV, "").strip())


def _base_url() -> str:
    return os.environ.get(_BASE_URL_ENV, _DEFAULT_BASE_URL).rstrip("/")


def _prompt_id(mode: RefineMode) -> str:
    """Which prompt file serves ``mode``.

    Only the local mode differs, and it differs because its model does: the
    cloud prompt is DSPy-optimised against MiniMax M3 and is unmeasured on a 4B.
    See ``prompt.py``'s module docstring for both measurements.

    KEYED ON THE MODE, NOT ON THE COMMITTED BUNDLE, AND THAT IS DELIBERATE. The
    local slot is not always a 4B -- the supported set on one v2.0 box is
    ``local-35b`` / ``local-4b`` / ``local-0-8b``, and the *recommended* bundle
    on a capable machine is the 35B. So on many installs this sends a
    4B-optimised prompt to a larger model. Two reasons that is the right default
    rather than an oversight:

      * Reading the committed bundle to pick a prompt would make this service
        branch on Bundle identity, which AGENTS.md §5c forbids -- bundle
        metadata is not for feature behaviour, and a second ranking of models
        here would be exactly the duplicated gating chain that rule exists to
        prevent.
      * The direction of the mismatch is the safe one. A prompt tuned for the
        weakest tier is strictly more explicit than one tuned for a strong
        model, so a larger local model following it loses little; the reverse --
        M3's terser prompt on a 0.8B -- is the failure this split was introduced
        to avoid, and it is the case that cannot happen now.

    THAT SECOND REASON IS NOW MEASURED, NOT ASSERTED. The same two prompts, on
    the v2 TEST set (23 cases, 9 of them injection), sent in this exact shape --
    one system turn with demos inline plus ``wrap_transcript()``:

        prompt                        Qwen3.5-4B      Qwen3.8-27B
                                      judge / inj F1  judge / inj F1
        cleanup-qwen4b-dspy-mipro-v1  81.13 / 74.8    92.48 / 94.4
        cleanup-m3-dspy-combo-v1      87.00 / 90.9    93.74 / 100.0

    A bigger local model given the smaller tier's prompt loses **1.26 judge**,
    which is inside this suite's noise at N=1. The mismatch really is cheap in
    the direction it can occur, so keying on the mode costs almost nothing --
    and the saving is a whole model-ranking this service does not have to own.

    Picking the prompt from the active local model was considered and is still
    rejected: it would need a model-id branch here (AGENTS.md §5c), and there is
    no per-model prompt to select anyway -- ``typeless-tasks/v2/runs/`` contains
    exactly one optimisation run, MiniMax-M3's. A map whose fallback always
    fires buys nothing.
    """
    return LOCAL_PROMPT_ID if mode == "local" else PROMPT_ID


def _request_body(text: str, mode: RefineMode) -> tuple[str, dict[str, Any], str]:
    """``(path, body, prompt_id)`` for one refine call.

    The prompt id is RETURNED rather than re-derived by the caller so the
    ``/refine`` response reports the prompt that actually built this body. With
    two prompt files in the tree, a response field computed independently of the
    request is the shape that eventually attributes a transcript to a prompt that
    never saw it.

    TAKES NO MODEL. ``preset`` mode's model is read from host-side state, not
    from the caller -- see ``preference.py``, which exists because a
    caller-supplied model on this unauthenticated port was an arbitrary-model
    spend against the user's key. The two ALIAS modes never had one: the model
    there is one of LRM's fixed aliases, and naming one would be a 400
    ``invalid_model`` from the data plane.
    """
    prompt_id = _prompt_id(mode)
    messages = [
        {"role": "system", "content": system_prompt(prompt_id)},
        {"role": "user", "content": wrap_transcript(text)},
    ]
    body: dict[str, Any] = {
        "messages": messages,
        "max_tokens": output_budget(text),
        # Clean-up is a transformation, not generation: there is one right answer
        # and sampling can only move away from it.
        "temperature": 0.0,
    }

    # The local body stops here. Everything below is acted on by a cloud path
    # only, and the local dispatch forwards the body verbatim to llama-server --
    # see the module docstring for why that makes "harmless extra field" a claim
    # about a vendored upstream rather than about this service.
    if mode == "local":
        body["model"] = "local-model"
        return _CHAT_PATH, body, prompt_id

    # LRM's own off switch -- see providers.py for why this is one boolean rather
    # than a per-provider body fragment built here.
    body["disable_thinking"] = True
    body["usage_alias"] = _USAGE_ALIAS

    if mode == "agent":
        # The data plane accepts only `auto` / `local-model` / `cloud-model`, so
        # this string is a contract rather than a default -- and an alias has no
        # endpoint to choose behind it, hence no `provider_routing`.
        body["model"] = "cloud-model"
        return _CHAT_PATH, body, prompt_id

    # Read ONCE, here, and used for both the pinned model and the routing
    # lookup. The endpoint order in ``endpoints.json`` is keyed BY MODEL, so
    # reading the preference for anything other than the model actually being
    # sent would apply one model's measured endpoint names to another whose pool
    # may not contain them -- OpenRouter reads that as "no acceptable provider".
    # A second `read_model()` below would also be a second chance for the file
    # to change between the two.
    chosen = preference.read_model()
    body["provider"] = providers.PRESET_PROVIDER
    body["model"] = chosen
    body["provider_routing"] = providers.endpoint_preference(
        providers.PRESET_PROVIDER, chosen
    ).as_body()
    return _PINNED_PATH, body, prompt_id


def _extract_text(payload: Any) -> str:
    """The assistant message, or a :class:`RefineError` naming what arrived.

    An empty, truncated or shape-unexpected 200 is treated as a failure rather
    than as a refinement: returning "" would wipe the user's dictation and
    returning a fragment would silently shorten it, and neither is an outcome
    this feature may produce.
    """
    if not isinstance(payload, dict):
        raise RefineError(502, "refine_bad_response", "clean-up service returned non-JSON")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RefineError(502, "refine_bad_response", "clean-up response had no choices")
    first = choices[0]
    message = first.get("message") if isinstance(first, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    text = content.strip() if isinstance(content, str) else ""
    finish = first.get("finish_reason") if isinstance(first, dict) else None

    # Checked BEFORE `text`, not only when it is empty. The usual truncation has
    # content -- the model wrote most of a sentence and hit the ceiling -- and
    # accepting it would hand the caller a fragment, which `/refine` would report
    # as a successful clean-up and the composer would substitute for the user's
    # COMPLETE dictation. Clean-up is allowed to decline; it is not allowed to
    # shorten. Raising instead routes the caller to the raw-transcript fallback.
    if finish == "length":
        raise RefineError(
            502,
            "refine_budget_exhausted",
            # Two causes, one code: the empty case is a reasoning model burning
            # the budget before it answers, and naming that beats "empty
            # response" because the fix -- a model whose reasoning can be
            # switched off -- is otherwise unguessable.
            "the clean-up model spent its whole output budget before answering; "
            "it is probably reasoning despite being asked not to"
            if not text
            else "the clean-up model hit its output ceiling mid-answer, so the "
            "result is truncated and would have replaced the dictation with a "
            "fragment",
        )
    if not text:
        raise RefineError(502, "refine_empty", "clean-up model returned no text")
    return text


async def refine(text: str, mode: RefineMode) -> RefineResult:
    """Run one clean-up pass. Raises :class:`RefineError` on any failure.

    The caller supplies the transcript and the mode and nothing else. Which
    model serves ``preset`` is host-side state (``preference.read_model()``),
    because this port has no caller authentication and the model is the field
    that decides what gets spent.
    """
    api_key = os.environ.get(_API_KEY_ENV, "").strip()
    if not api_key:
        raise RefineError(
            424,
            "refine_not_configured",
            "this install cannot reach the clean-up service "
            f"({_API_KEY_ENV} is not set for asr_manager)",
        )

    try:
        path, body, prompt_id = _request_body(text, mode)
    except PromptError as exc:
        # The packaged prompt is missing or empty, i.e. a broken build. 500 and
        # not 424: there is nothing the user can configure to fix it.
        raise RefineError(500, "refine_prompt_missing", str(exc)) from exc

    # The pinned route requires the host-only credential; the alias route takes
    # either. Chosen from the PATH rather than from `mode` so the two cannot
    # drift -- `_request_body` already decides which route serves which mode,
    # and duplicating that decision here is how a 401 on preset mode would be
    # introduced by a later edit to one of them.
    if path == _PINNED_PATH:
        host_key = os.environ.get(_HOST_API_KEY_ENV, "").strip()
        if host_key:
            api_key = host_key
        elif os.environ.get("SERVICEHUB_MANAGED") == "1":
            # Managed means a sandbox exists, so the host key SHOULD have been
            # granted. Refusing beats falling back to the shared key: that key
            # is also inside the sandbox container, so sending it is both a
            # guaranteed 401 and a request to be let through a boundary this
            # process is not entitled to cross. 424 with a nameable cause, not a
            # bare upstream failure, because nothing the user can configure
            # fixes it.
            # ITS OWN CODE, NOT `refine_not_configured`. That code means "this
            # install cannot refine at all", and the renderer acts on it by
            # LATCHING clean-up off for the session
            # (`voice-error.classifyVoiceRefineError` -> `unsupported: true` ->
            # `noteRefineUnsupported`). Reusing it here would let a single
            # PRESET attempt disable `agent` and `local` too -- and both still
            # work, because the alias route takes the shared key this process
            # already has. Losing the on-device mode, which needs no cloud
            # credential whatsoever, because a cloud credential is missing is
            # precisely backwards. Raised by Copilot on superclaw#3027.
            raise RefineError(
                424,
                "refine_host_key_missing",
                "this install cannot clean up with a model you chose "
                f"({_HOST_API_KEY_ENV} was not granted to asr_manager)",
            )
        # Unmanaged: a standalone LRM has no sandbox and issues one key for both
        # planes, so the shared key already in `api_key` is correct.

    # `local` mode promises the user the text does not leave the machine, and
    # the `local-model` alias does NOT guarantee that on its own: it resolves to
    # a remote server when the committed primary bundle is an edge bundle. So
    # the promise is asserted on the request and LRM refuses rather than
    # silently shipping the transcript off-device. Asserted here rather than
    # pre-checked in the UI because the binding can change between a probe and
    # the request.
    on_device_headers = (
        {"X-SuperClaw-Require-On-Device": "1"} if mode == "local" else {}
    )

    # Imported here, not at module scope, for the reason recognize/download.py
    # imports its own dependency lazily: a bare `asr-manager` with refine never
    # used must not pay the import, and `app.py` must stay importable on a tree
    # where the dependency has not been synced.
    import httpx

    try:
        # trust_env=False: LRM is a loopback sidecar on 127.0.0.1. A corporate
        # HTTP_PROXY must not intercept it, and httpx does not honour NO_PROXY
        # CIDR entries such as 127.0.0.0/8, so the proxy has to be refused here
        # rather than excluded. Same reasoning as privacy_manager's call.
        async with httpx.AsyncClient(timeout=_TIMEOUT_S, trust_env=False) as client:
            response = await client.post(
                f"{_base_url()}{path}",
                json=body,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    # Suppress LRM's `[model-id] ` label. It is a chat-UI
                    # affordance that the frontend strips on arrival; this
                    # completion goes straight into the user's composer, so with
                    # SUPERCLAW_LRM_MODEL_PREFIX=1 the label would be inserted as
                    # if it had been dictated. Sent on EVERY mode, not just the
                    # alias-route ones: the pinned route suppresses it on its own
                    # too, and a header that depends on the route is a header
                    # someone forgets when a fourth mode is added.
                    "X-SuperClaw-Suppress-Model-Prefix": "1",
                    **on_device_headers,
                },
            )
    except httpx.TimeoutException as exc:
        raise RefineError(
            504, "refine_timeout", f"clean-up timed out after {_TIMEOUT_S:.0f}s"
        ) from exc
    except httpx.HTTPError as exc:
        raise RefineError(
            502, "refine_unreachable", f"clean-up service unreachable: {exc}"
        ) from exc

    if response.status_code >= 400:
        raise RefineError(*_upstream_failure(response))

    try:
        payload: Any = response.json()
    except ValueError as exc:
        raise RefineError(
            502, "refine_bad_response", "clean-up service returned non-JSON"
        ) from exc

    return RefineResult(
        text=_extract_text(payload),
        model=str(payload.get("model") or ""),
        prompt_id=prompt_id,
        # OpenRouter names the endpoint that served the request; LRM passes the
        # upstream payload through, so it survives when present.
        served_by=str(payload.get("provider") or ""),
    )


def _upstream_failure(response: Any) -> tuple[int, str, str]:
    """Map an LRM error onto this service's triple.

    LRM emits the same ``{"error": {"code", "message"}}`` envelope, so its code is
    carried through under a ``refine_`` prefix rather than flattened: "the user
    has no cloud model configured" (424) and "the provider rejected the key"
    (502) need different UI, and collapsing both to ``refine_failed`` would make
    the first indistinguishable from an outage.
    """
    code = ""
    message = ""
    try:
        payload = response.json()
        error = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(error, dict):
            code = str(error.get("code") or "")
            message = str(error.get("message") or "")
    except ValueError:
        pass

    if not message:
        message = f"clean-up service returned HTTP {response.status_code}"

    # Its own code, ahead of the generic 424: the cause is not "nothing is
    # configured" but "what is configured is not on this machine", and the two
    # need different words. Reporting this as `refine_no_model` would tell a
    # user to configure a local model they have already configured, while
    # concealing that the reason clean-up declined is that it would have sent
    # their text to a remote edge server.
    if code == "on_device_required":
        return 424, "refine_not_on_device", message
    # 424 is LRM's "nothing is configured to serve this" and is the one failure a
    # user can act on, so it keeps its own code all the way to the UI.
    if response.status_code == 424:
        return 424, "refine_no_model", message
    if response.status_code in (401, 403):
        # The inference key this service was handed is wrong or stale -- an
        # install/supervision fault, not anything the user did.
        return 502, "refine_unauthorized", message
    return 502, f"refine_upstream_{code}" if code else "refine_upstream", message
