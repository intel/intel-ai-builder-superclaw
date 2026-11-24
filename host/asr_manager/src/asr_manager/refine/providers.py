"""Which model answers a refine call, and which upstream endpoints may serve it.

THE HARD CONSTRAINT. The clean-up task has no use for hidden chain-of-thought:
the answer is a tidied copy of the input. A model that reasons anyway spends 3-5x
the completion tokens on tokens the user never sees and adds its whole reasoning
pass to the latency of every dictation. So when *this service* chooses the model
(the dictation preset) it must choose one whose reasoning can be switched off --
which rules out Gemini, the model family that ignores the off switch.

WHERE THAT CONSTRAINT DOES NOT APPLY. In ``agent`` mode the model is whatever the
user already configured for their agent. Refusing to refine because they happen
to use Gemini would present as "the feature is broken", so that path proceeds:
it asks for the off switch anyway (harmless when ignored), relies on the scaled
budget in :func:`prompt.output_budget` so nothing is truncated, and lets the UI
say once that this model is slower and dearer per dictation.
:func:`reasoning_support` is what both paths ask; only the preset path treats
``NO`` as disqualifying.

ASKING FOR THE OFF SWITCH IS NOT THIS MODULE'S JOB. LRM already owns it: a
``disable_thinking: true`` member on the chat-completions body becomes
``extra_body["reasoning"] = {"effort": "none"}`` for OpenRouter
(``cloud/dispatch.py::_build_litellm_kwargs``), and a model that rejects it with
a mandatory-reasoning 400 is retried once without it by
``_drop_reasoning_override``. So the client sends one boolean and inherits that
handling, instead of this service growing a second, diverging copy of
per-provider reasoning fields. What is left here is the *selection* question LRM
cannot answer: is this model eligible for us to pick, and which endpoints may
serve it.

TWO LISTS, TWO HOMES. OpenRouter routes one model id to many upstream endpoints:

  * :data:`REASONING_VIOLATORS` -- endpoints measured to ignore the off switch --
    is here, in code. It is a correctness and cost guard, not a preference, and
    it must survive a missing or malformed data file.
  * The preferred ORDER among the compliant endpoints is a latency/cost
    preference and lives in the optional ``endpoints.json``. Absent, routing
    falls back to OpenRouter's own balancing, which still works.

That split is the whole reason the data file can be optional without weakening
the guarantee.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import Any

PRESET_PROVIDER = "openrouter"
PRESET_MODEL = "minimax/minimax-m3"
"""The dictation preset: the one provider/model pair this service will pick on
the user's behalf.

Reached THROUGH OpenRouter rather than as LRM's own ``minimax`` provider on
purpose -- that catalog entry speaks the Anthropic wire protocol against
``api.minimax.io/anthropic`` (``cloud/catalog.py``), which is a different API
from the OpenRouter route these endpoint measurements were taken on.

M3 and not M2 because the preset is the path that must satisfy the hard
constraint: M2 rejects the reasoning off switch with an HTTP 400, so it is not
eligible to be chosen."""

REASONING_VIOLATORS = ("Parasail", "Together", "Novita")
"""OpenRouter endpoints measured to ignore the reasoning off switch.

Sent as the ``ignore`` list on every preset request. On the same list price as
compliant endpoints these billed $0.84-$1.30 per 1000 dictations against
$0.21-$0.29, purely in tokens the user never sees -- see the table in
``endpoints.json``. In code, not data, so a missing data file cannot drop it."""


class ReasoningSupport(str, Enum):
    YES = "yes"
    """Confirmed to honour an off switch."""

    NO = "no"
    """Confirmed to ignore or reject it."""

    UNKNOWN = "unknown"
    """Not characterised. Read as NO when *choosing* a model and as "proceed,
    but warn" when honouring the user's choice -- the conservative direction
    differs by caller, which is why this is not a bool."""


_CANNOT_DISABLE_PREFIXES = (
    # Gemini ignores the field entirely. It does not even error, so there is no
    # signal at request time that reasoning is still on -- which is exactly why
    # it has to be named here rather than detected.
    "google/",
    "gemini",
    # M2 is the opposite failure: it 400s on the off switch instead of ignoring
    # it. Either way the switch does not work, so both belong in one list.
    "minimax/minimax-m2",
)

_CAN_DISABLE_PREFIXES = ("minimax/minimax-m3",)


def reasoning_support(provider: str, model: str) -> ReasoningSupport:
    """Whether ``model`` can have its reasoning switched off.

    Matched on model-id prefixes rather than an exhaustive table: the catalog
    holds hundreds of models and an exhaustive list would be wrong the week after
    it was written. Non-OpenRouter providers report ``UNKNOWN`` rather than
    ``NO`` -- LRM only wires the off switch for OpenRouter today, so for the rest
    "we cannot ask" is the honest answer, not "it reasons".
    """
    if provider != "openrouter":
        return ReasoningSupport.UNKNOWN
    lowered = model.lower()
    if any(lowered.startswith(prefix) for prefix in _CANNOT_DISABLE_PREFIXES):
        return ReasoningSupport.NO
    if any(lowered.startswith(prefix) for prefix in _CAN_DISABLE_PREFIXES):
        return ReasoningSupport.YES
    return ReasoningSupport.UNKNOWN


@dataclass(frozen=True)
class EndpointPreference:
    """The OpenRouter ``provider`` routing block for one request."""

    order: tuple[str, ...]
    ignore: tuple[str, ...]
    allow_fallbacks: bool

    def as_body(self) -> dict[str, Any]:
        """Serialise, omitting an empty ``order``.

        An empty ``order`` must be left OUT rather than sent as ``[]``: an empty
        allow-list reads to OpenRouter as "no provider is acceptable", a hard
        failure, where omitting the key means "you choose". That is precisely the
        no-data-file case, so getting this wrong would make the optional file
        mandatory in practice.
        """
        body: dict[str, Any] = {"allow_fallbacks": self.allow_fallbacks}
        if self.order:
            body["order"] = list(self.order)
        if self.ignore:
            body["ignore"] = list(self.ignore)
        return body


_ENV_OVERRIDE = "DICTATION_REFINE_ENDPOINTS"
_PACKAGED = Path(__file__).resolve().parent / "endpoints.json"


def _config_path() -> Path:
    """Env var wins, else the packaged file.

    Same shape as ``recognize.model_state.model_dir()``: one accessor, env first,
    packaged default second, read at call time rather than at import so a
    restart is not required to repoint it.
    """
    override = os.environ.get(_ENV_OVERRIDE, "").strip()
    return Path(override) if override else _PACKAGED


@lru_cache(maxsize=None)
def _measured() -> dict[str, Any]:
    """Parsed ``endpoints.json``, or ``{}`` when absent or unusable.

    Every failure collapses to ``{}`` -- the whole point of the file being
    optional. A malformed file is treated exactly like a missing one and warned
    about once, because the alternative (refusing to refine) would turn a
    cosmetic data problem into a broken feature.
    """
    path = _config_path()
    try:
        raw: Any = json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        return {}
    except json.JSONDecodeError as exc:
        print(
            f"[asr-manager] WARNING: {path} is not valid JSON ({exc}); refine will "
            "use the provider's own endpoint balancing",
            flush=True,
        )
        return {}
    if not isinstance(raw, dict):
        return {}
    models = raw.get("models")
    return models if isinstance(models, dict) else {}


def endpoint_preference(provider: str, model: str) -> EndpointPreference:
    """Routing block for ``provider``/``model``.

    The violator ``ignore`` list applies to every OpenRouter request whether or
    not the data file had anything to say; only ``order`` comes from the file.
    Keyed by model id so a measurement taken on one model is never silently
    applied to another, whose endpoint pool may not even contain those names.
    """
    if provider != "openrouter":
        # Every other catalog provider IS its own endpoint, so there is nothing
        # to order and an `ignore` list would name endpoints it has never heard
        # of.
        return EndpointPreference(order=(), ignore=(), allow_fallbacks=True)

    entry = _measured().get(model)
    order: tuple[str, ...] = ()
    # Fallbacks stay ON by default: a dead preferred endpoint must degrade to "a
    # slower dictation", never to "no dictation".
    allow_fallbacks = True
    if isinstance(entry, dict):
        raw_order = entry.get("order")
        if isinstance(raw_order, list):
            order = tuple(
                name for name in raw_order if isinstance(name, str) and name.strip()
            )
        if isinstance(entry.get("allow_fallbacks"), bool):
            allow_fallbacks = entry["allow_fallbacks"]

    return EndpointPreference(
        order=order, ignore=REASONING_VIOLATORS, allow_fallbacks=allow_fallbacks
    )
