"""The one error envelope this service is allowed to emit.

    {"error": {"code": "<snake_case>", "message": "<human readable>"}}

THIS SHAPE IS LOAD-BEARING, not a style choice. Every response from a child goes
through ServiceHub's proxy, whose ``error_normalizer._standard_error_envelope()``
passes an upstream error body through **only** when the body has an ``error`` (or
``detail.error``) member that is a dict whose ``code`` and ``message`` are both
strings. Anything else -- a flat ``{"error": "text"}``, a bare-string
``HTTPException(detail=...)``, FastAPI's default 422 ``{"detail": [...]}`` -- is
DISCARDED and replaced with a generic ``upstream_error``. The UI switches on
``.error.code`` (``model_not_downloaded`` opens the consent dialog,
``unsupported_language`` explains English-only, ``audio_too_long`` names the cap),
so a dropped code is not cosmetic: it turns an actionable message into "something
went wrong".

tts_manager returns flat ``{"error": "model not loaded; ..."}`` from every failure
path, which means every TTS error the user sees through the hub is
``upstream_error`` with the reason destroyed. That is the one thing from the
reference implementation deliberately NOT copied.

The helpers are duplicated here rather than imported from
``servicehub.common.errors``: asr_manager is a separate uv workspace member and
must not depend on the supervisor it runs under (servicehub imports the child
config, so a dependency the other way would be circular). The shape is pinned by
``tests/test_error_envelope.py`` instead.
"""

from __future__ import annotations

from fastapi.responses import JSONResponse


def error_body(code: str, message: str) -> dict[str, dict[str, str]]:
    """The envelope as a plain dict -- for ``HTTPException(detail=...)`` (the
    normalizer accepts ``detail.error``) and for tests."""
    return {"error": {"code": str(code), "message": str(message)}}


def error_response(status: int, code: str, message: str) -> JSONResponse:
    """The envelope as a response. Preferred over ``raise HTTPException`` in route
    bodies so the status/code pairing is visible at the return site."""
    return JSONResponse(error_body(code, message), status_code=int(status))
