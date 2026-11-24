r"""The clean-up model, held HOST-SIDE because the caller may not choose it.

WHY THIS MODULE EXISTS AT ALL -- IT IS A SECURITY BOUNDARY, NOT A CONVENIENCE.
``/refine`` used to take the model in its request body, and ``asr_manager``
holds ``LRM_HOST_API_KEY`` -- the credential ``process_manager.py`` grants to
this service alone, specifically to keep agent-authored code off
``/v1/chat/completions/pinned``:

    # The shared key ONLY. SandboxManager passes its credential into the
    # container, so anything granted here is reachable by agent-authored code
    # -- which is exactly what the host key exists to exclude from
    # `/v1/chat/completions/pinned`.

But this service binds ``127.0.0.1:18829`` with no caller authentication --
ServiceHub terminates App auth at its proxy and its forwarder strips
``authorization`` without adding anything in its place, so this process cannot
tell a proxied request from a direct one. Reproduced on the installed app
(superclaw#3027): with NO ``Authorization`` header at all, a local caller sent
``{"mode":"preset","model":"qwen/qwen3-max"}`` and got a 200 -- an arbitrary
connected model, billed to the user, recorded under ``dictation-refine``.

So the credential split closed ``sandbox -> LRM /pinned`` and did nothing about
``sandbox -> asr_manager /refine -> LRM /pinned``. The capability the host key
was created to deny was reachable one hop earlier.

THE FIX IS TO REMOVE THE CAPABILITY, NOT TO GUARD IT. Authenticating this hop
is the right platform change and it is not ours to make here -- it needs the
proxy to thread each service's process credential, which affects every proxied
service (AGENTS.md §5b puts that in middleware, C2 keeps it out of a feature
PR). What IS ours is that the model was ever caller-supplied. With the
preference read from here instead, an unauthenticated caller can still trigger
a clean-up, but only against the model the user chose and already pays for.
Arbitrary-model spend stops existing rather than being defended.

This mirrors how the alias route resolves a committed selection: the caller
names an intent, the host resolves what serves it.

WHY A FILE AND NOT THE RENDERER'S ``localStorage``. That is where it lived, and
it is exactly the wrong place: a value the renderer holds is a value the
request carries, and a value the request carries is one an attacker supplies.
The renderer now writes it through the control plane
(``PUT /speech-to-text/v1/refine/preference``) and the dictation path never
reads a model off the wire.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path

from . import providers

_ENV_OVERRIDE = "ASR_REFINE_PREFERENCE_PATH"
_FILE = "refine-preference.json"

_MAX_MODEL_ID_CHARS = 128

_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9._/:@-]+$")
"""A CHARACTER allow-list, not a model allow-list.

Listing the models would be a second copy of OpenRouter's ~389-entry catalog
that is wrong the week after it is written. These are the characters every id in
that catalog is built from -- ``vendor/model`` with the ``:free`` / ``:nitro``
variant suffixes -- and it is what rejects whitespace, control characters, path
traversal and the braces and quotes of a JSON blob.

Moved here from the renderer's ``isPlausibleModelId``. It has to hold on THIS
side now: the renderer is no longer the only writer, and a validator that lives
only in the thing being protected from is not a validator.
"""


class PreferenceError(ValueError):
    """A rejected write, with the wire code the route must report."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _default_path() -> Path:
    r"""``%LOCALAPPDATA%\SuperClaw\asr_manager\refine-preference.json`` on
    Windows, else ``~/.superclaw/asr_manager/...`` -- the same shape
    ``recognize.model_state._host_model_dir_default`` uses, under this service's
    own name rather than ``parakeet``, which is the ASR weights' directory and
    not a state root."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "SuperClaw" / "asr_manager" / _FILE
    return Path.home() / ".superclaw" / "asr_manager" / _FILE


def path() -> Path:
    """Env override first, else the host default.

    Read at call time rather than at import, matching ``model_state.model_dir``
    so a test (or a repointed install) does not need a restart.
    """
    override = os.environ.get(_ENV_OVERRIDE, "").strip()
    return Path(override) if override else _default_path()


def validate_model_id(raw: object) -> str:
    """The stored form of ``raw``, or raise :class:`PreferenceError`.

    Rejects rather than silently substituting the default: a write is an
    explicit user action, and answering "stored" while keeping something else
    would make the picker look like it had forgotten the choice.
    """
    if not isinstance(raw, str):
        raise PreferenceError("invalid_model", "'model' must be a string")
    trimmed = raw.strip()
    if not trimmed:
        raise PreferenceError("invalid_model", "'model' must not be empty")
    if len(trimmed) > _MAX_MODEL_ID_CHARS:
        raise PreferenceError(
            "invalid_model",
            f"'model' is {len(trimmed)} characters; the cap is {_MAX_MODEL_ID_CHARS}",
        )
    if not _MODEL_ID_RE.match(trimmed):
        raise PreferenceError(
            "invalid_model", "'model' contains characters no model id uses"
        )
    return trimmed


def read_model() -> str:
    """The user's clean-up model, or the dictation default.

    EVERY failure collapses to :data:`providers.PRESET_MODEL`: a missing file is
    the ordinary first-run state, and a corrupted one must not be able to stop
    dictation clean-up working. The stored value is re-validated on read rather
    than trusted, because it is about to be sent to a provider as a model id and
    the file is writable by anything running as this user.
    """
    try:
        raw = json.loads(path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return providers.PRESET_MODEL
    if not isinstance(raw, dict):
        return providers.PRESET_MODEL
    try:
        return validate_model_id(raw.get("model"))
    except PreferenceError:
        return providers.PRESET_MODEL


def write_model(raw: object) -> str:
    """Persist the clean-up model and return the stored form.

    Written to a temp file in the same directory and then ``os.replace``d, which
    is atomic on Windows and POSIX alike. A half-written JSON file would read
    back as the default on the next dictation -- i.e. the user's choice would
    appear to have been forgotten after a crash mid-write.
    """
    model = validate_model_id(raw)
    target = path()
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"model": model}, ensure_ascii=False) + "\n"
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=str(target.parent),
        prefix=f".{_FILE}.",
        suffix=".tmp",
        delete=False,
    )
    try:
        with handle as tmp:
            tmp.write(payload)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(handle.name, target)
    except BaseException:
        Path(handle.name).unlink(missing_ok=True)
        raise
    return model
