"""Lightweight, dependency-free language heuristic.

Used by the file span provider's optional spaCy language gate. The bundled
spaCy model is English-only and over-fires on non-English prose (tagging
Spanish/German finance-contract phrases as names/orgs), while the multilingual
ONNX NER handles other languages natively. Detecting "probably not English"
lets the provider drop spaCy-origin spans exactly where they are noise.

Deliberately a coarse, stdlib-only heuristic (no model, no network, no new
dependency — honoring the air-gapped / MIT-Apache constraint). It only needs to
separate English from the Western-European languages that appear in the
finance-doc corpus (Spanish / German / French / Portuguese / Italian), and it
is intentionally CONSERVATIVE: when the signal is weak it returns English, so
the gate never drops English spaCy spans (which carry real recall) on a guess.
"""

from __future__ import annotations

import re

# Common English function words — presence is positive evidence for English.
_EN_STOP = frozenset({
    "the", "and", "of", "to", "in", "for", "is", "on", "with", "at", "by",
    "from", "as", "that", "this", "are", "was", "be", "or", "an", "it", "has",
    "have", "will", "shall", "not", "which", "their", "its",
})

# Function words distinctive to the Western-European languages in the corpus.
# Deliberately excludes tokens that are also common English (e.g. "a", "no").
_NON_EN_STOP = frozenset({
    # Spanish
    "de", "la", "el", "los", "las", "del", "por", "para", "con", "una", "uno",
    "y", "en", "según", "propiedad", "descripción", "ubicación",
    # German
    "und", "der", "die", "das", "für", "mit", "von", "den", "dem", "ein",
    "eine", "ist", "nicht", "auch", "rück",
    # French
    "les", "des", "du", "et", "dans", "pour", "avec", "que", "sur", "aux",
    # Portuguese
    "da", "do", "dos", "uma", "um", "não", "são", "como",
    # Italian
    "il", "lo", "gli", "della", "dei", "che", "per", "sono",
})

# Diacritics common in the target non-English languages but rare in English.
_DIACRITIC_RE = re.compile(r"[áéíóúñüöäçàèìòùâêîôûãõ]", re.IGNORECASE)
_WORD_RE = re.compile(r"[A-Za-zÀ-ÿ]+")


def looks_english(text: str) -> bool:
    """Coarse English detector. True (English) when the signal is weak.

    Returns False only when there is clear non-English evidence — either
    non-English function words outnumbering English ones with corroboration, or
    a run of diacritics with no English function words. This bias means the
    spaCy gate stays inert on ambiguous / short / clearly-English text and only
    fires when a cell is confidently foreign.
    """
    if not text or not text.strip():
        return True
    words = _WORD_RE.findall(text.lower())
    if not words:
        return True
    en = sum(1 for w in words if w in _EN_STOP)
    non_en = sum(1 for w in words if w in _NON_EN_STOP)
    diacritics = len(_DIACRITIC_RE.findall(text))
    # Clear non-English: foreign function words dominate, with corroboration
    # (a second foreign hit or a diacritic) so a single stray token can't flip
    # an English cell.
    if non_en > en and (non_en >= 2 or diacritics >= 1):
        return False
    # Diacritic-heavy with zero English function words -> foreign.
    if diacritics >= 3 and en == 0:
        return False
    return True
