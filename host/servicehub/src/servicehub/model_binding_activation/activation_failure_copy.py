"""The user-facing text of an activation failure, for every code and every internal cause.

The sentences are authored once in the activation contract and generated into Python data. This looks a
word up and never builds text from evidence free text, paths, SIDs or exception messages. A word the
contract does not list keeps the generic fallback sentence, which stays valid for every console.
"""

from __future__ import annotations

from contracts.activation_error_copy_data import (
    ACTIVATION_FAILURE_CAUSE_MESSAGE,
    ACTIVATION_FALLBACK_MESSAGE,
    MODEL_BINDING_ACTIVATION_ERROR_COPY,
)


def activation_failure_message(code: object) -> str:
    """The curated sentence for a public activation code or an internal failure cause, else the fallback.

    A cause's sentence already ends with the cause word, because that word is not on the wire: the public
    error folds the cause into ``safe_error``.
    """
    if isinstance(code, str):
        if code in ACTIVATION_FAILURE_CAUSE_MESSAGE:
            return ACTIVATION_FAILURE_CAUSE_MESSAGE[code]
        if code in MODEL_BINDING_ACTIVATION_ERROR_COPY:
            return MODEL_BINDING_ACTIVATION_ERROR_COPY[code]
    return ACTIVATION_FALLBACK_MESSAGE


def activation_failure_error(code: str) -> dict[str, object]:
    """The receipt error for ``code``: the word as written today, with its curated sentence as the message."""
    return {"code": code, "message": activation_failure_message(code)}
