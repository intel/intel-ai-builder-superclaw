"""Voice registry for the resident TTS narration service.

Kokoro-82M ships fixed *voice packs* (e.g. ``af_heart`` American English female,
``bf_emma`` British English female) rather than reference-audio clones. This
module maps friendly keys / keywords onto a Kokoro ``(voice_id, lang_code)``
pair, read from ``voices.json`` beside this file in the service dir.

The Kokoro voice-id convention encodes the language in the first letter
(a=US-en, b=UK-en, z=zh, j=ja, e=es, f=fr, h=hi, i=it, p=pt) and gender in the
second (f/m). Any valid Kokoro voice id may also be passed straight through via
``--voice``; the language is then derived from that first letter.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

DEFAULT_LANG_CODE = "a"

# A pass-through Kokoro voice id: lowercase letters, digits and underscores only.
# Rejects anything with path separators or dots. Under ONNX the voice packs are
# looked up by id inside the single bundled voices-v1.0.bin (no per-voice file on
# disk), but the charset restriction is kept as defense-in-depth so a
# request-supplied voice can never be interpolated into a filesystem path
# downstream (see get_voice_info pass-through branch).
_VOICE_ID_RE = re.compile(r"^[a-z0-9_]+$")

# First letter of a Kokoro voice id -> Kokoro lang_code. Narration is English-only;
# "z" and "j" stay mapped so a pass-through zf_*/jf_* id resolves to its own
# language and api/tts.py rejects it, instead of falling back to English G2P.
_VOICE_PREFIX_TO_LANG = {
    "a": "a",  # American English
    "b": "b",  # British English
    "z": "z",  # Mandarin Chinese (rejected by api/tts.py)
    "j": "j",  # Japanese (rejected by api/tts.py)
    "e": "e",  # Spanish
    "f": "f",  # French
    "h": "h",  # Hindi
    "i": "i",  # Italian
    "p": "p",  # Brazilian Portuguese
}


def _lang_from_voice_id(voice_id: str) -> str:
    if not voice_id:
        return DEFAULT_LANG_CODE
    return _VOICE_PREFIX_TO_LANG.get(voice_id[0].lower(), DEFAULT_LANG_CODE)


def _normalize_keywords(raw: object, key: str) -> list:
    """Coerce a voices.json ``keywords`` value to a list.

    A bare string must be treated as a single keyword — ``list("english")`` would
    otherwise split it into per-character entries and break keyword matching. Only
    list/tuple values are used as-is; anything else falls back to ``[key]``.
    """
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, (list, tuple)):
        return list(raw)
    return [key]


def load_voices(ref_dir: Path) -> dict:
    """Return ``{key: {voice, lang, keywords, description}}`` from voices.json."""
    ref_dir = Path(ref_dir)
    voices_json = ref_dir / "voices.json"
    if not voices_json.exists():
        return {}
    try:
        config = json.loads(voices_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(config, dict):
        return {}

    voices: dict = {}
    for key, cfg in config.items():
        if not isinstance(cfg, dict):
            continue
        voice_id = cfg.get("voice", key)
        lang = cfg.get("lang") or _lang_from_voice_id(voice_id)
        voices[key] = {
            "voice": voice_id,
            "lang": lang,
            "keywords": _normalize_keywords(cfg.get("keywords"), key),
            "description": cfg.get("description", ""),
        }
    return voices


def get_voice_info(ref_dir: Path, voice_name: str | None) -> tuple[str, str, str]:
    """Resolve ``voice_name`` to ``(kokoro_voice_id, lang_code, resolved_key)``.

    Resolution order:
      1. Exact registry key match (case-insensitive).
      2. Keyword match (case-insensitive, either-direction substring).
      3. A raw Kokoro voice id passed straight through (e.g. ``am_michael``);
         language is derived from the id's first letter.
      4. Fallback to the ``default`` key, else the first registered voice.

    Raises ``ValueError`` if the registry is empty and no raw id was given.
    """
    voices = load_voices(Path(ref_dir))

    if voice_name:
        vl = voice_name.strip().lower()
        for name, v in voices.items():
            if vl == name.lower():
                return v["voice"], v["lang"], name
        for name, v in voices.items():
            for kw in v.get("keywords", [name]):
                kwl = str(kw).lower()
                if kwl == vl or kwl in vl or vl in kwl:
                    return v["voice"], v["lang"], name
        # Treat an unknown value that looks like a Kokoro voice id (e.g.
        # "af_bella", "am_adam") as a pass-through voice pack. Restrict to the
        # Kokoro id charset ([a-z0-9_]) so a crafted value can't smuggle path
        # separators or dots downstream. kokoro_helper resolves the id inside the
        # bundled voices-v1.0.bin, but keeping the charset tight means a value
        # like "../../x_y" can never be turned into a filesystem path elsewhere.
        if "_" in vl and _VOICE_ID_RE.match(vl):
            return vl, _lang_from_voice_id(vl), vl

    if "default" in voices:
        v = voices["default"]
        return v["voice"], v["lang"], "default"

    if voices:
        first = next(iter(voices))
        v = voices[first]
        return v["voice"], v["lang"], first

    raise ValueError(f"No voices registered in {ref_dir}")
