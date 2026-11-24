"""Restore module — reverses placeholder masking using a forward registry.

Two modes:
  - text mode: replace placeholders in a free-form string (used for inline
    restoration of a downstream model's response)
  - file mode: replace placeholders across every string column of a tabular
    file (CSV / Parquet)
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Mapping

from file_protection.io import load_table
from file_protection.registry import RegistryError, load_registry


# Strict registry-key regex: accepts only canonical `<CATEGORY_N>` keys.
PLACEHOLDER_PATTERN = re.compile(r"<[A-Za-z_]+_\d+>")

# Restore scan regex: accepts `<CATEGORY_N>` and extra-wrapped forms like
# `<<CATEGORY_N>>`, then normalizes lookups to `<CATEGORY_N>`.
PLACEHOLDER_SCAN_PATTERN = re.compile(r"<+([A-Za-z_]+_\d+)>+")


def _is_textlike(series) -> bool:
    """Return True if ``series`` holds string-like values.

    Uses ``pandas.api.types`` so we accept numpy ``object``, pandas
    ``StringDtype``, and any other dtype pandas treats as string-compatible.
    """
    from pandas.api.types import is_object_dtype, is_string_dtype

    return is_string_dtype(series) or is_object_dtype(series)


@dataclass
class TextRestoreResult:
    text: str
    replacements: int
    unmatched: list[str]


@dataclass
class FileRestoreResult:
    output_path: Path
    rows: int
    replacements: int
    unmatched: list[str]


def restore_text(
    text: str,
    registry: Mapping[str, str],
) -> TextRestoreResult:
    """Replace every placeholder in ``text`` with its registered original.

    The incoming text is normalized to Unicode NFC before scanning. LLMs
    frequently return NFD (``e`` + combining accent) even when given NFC
    input; the masker stores NFC in the registry, so normalizing here
    lets a placeholder-adjacent value round-trip byte-for-byte through the
    model. Placeholders themselves are ASCII, so NFC does not perturb the
    regex match.

    Args:
        text: Free-form string that may contain placeholders.
        registry: Forward registry ``{placeholder: original}``.

    Returns:
        Restored text, count of replacements, and a list of placeholders that
        appeared in the text but were not present in the registry.
    """
    if not isinstance(text, str):
        raise TypeError(f"text must be str; got {type(text).__name__}")

    text = unicodedata.normalize("NFC", text)

    # Replace placeholders in one regex pass so restored values are not matched again if they look like placeholders.
    found = PLACEHOLDER_SCAN_PATTERN.findall(text)
    if not found:
        return TextRestoreResult(text=text, replacements=0, unmatched=[])

    replacements = 0
    unmatched: list[str] = []
    seen_unmatched: set[str] = set()

    def _sub(m: "re.Match[str]") -> str:
        nonlocal replacements
        ph = f"<{m.group(1)}>"  # canonical single-bracket key, however many <>/> matched
        if ph in registry:
            replacements += 1
            return str(registry[ph])
        if ph not in seen_unmatched:
            seen_unmatched.add(ph)
            unmatched.append(ph)
        return m.group(0)  # leave unknown placeholders untouched, brackets and all

    out = PLACEHOLDER_SCAN_PATTERN.sub(_sub, text)
    return TextRestoreResult(text=out, replacements=replacements, unmatched=unmatched)


def restore_file(
    masked_file: str | Path,
    registry: Mapping[str, str] | str | Path,
    output_dir: str | Path,
    output_format: str = "csv",
) -> FileRestoreResult:
    """Restore a masked CSV or Parquet file using the registry.

    Args:
        masked_file: Path to the masked CSV or Parquet file.
        registry: Either a forward registry mapping or a path to a registry
            JSON file.
        output_dir: Directory to write the restored file to. Created if absent.
        output_format: ``"csv"`` (default) or ``"parquet"``.

    Returns:
        :class:`FileRestoreResult` describing the output location, row count,
        replacement count, and any unmatched placeholders.
    """
    masked_path = Path(masked_file).expanduser().resolve()
    if not masked_path.exists():
        raise FileNotFoundError(f"Masked file not found: {masked_path}")

    suffix = masked_path.suffix.lower()
    if suffix not in (".csv", ".parquet"):
        raise ValueError(
            f"Unsupported masked file format: {suffix}. Expected .csv or .parquet."
        )

    if output_format not in ("csv", "parquet"):
        raise ValueError(f"Unsupported output_format: {output_format}")

    registry_map: dict[str, str]
    if isinstance(registry, (str, Path)):
        registry_map = load_registry(registry)
    elif isinstance(registry, Mapping):
        if not registry:
            raise RegistryError("Registry mapping is empty")
        registry_map = dict(registry)
    else:
        raise TypeError(
            "registry must be a mapping or a path to a registry JSON file"
        )

    # ``force_str=True``: masked files are already string-only; preserve every
    # cell as text so placeholder regexes match without numeric coercion.
    df = load_table(masked_path, force_str=True)

    rows = len(df)

    # Single-pass replacement: for each text-like column, run one vectorized
    # ``Series.str.replace`` against the *generic* placeholder regex. The
    # callback substitutes registry hits, records the count, and tracks
    # unmatched placeholders in the same walk — pandas visits every cell once
    # for the replace, so no separate discovery pass is needed.

    found: set[str] = set()
    replacements = 0

    def _sub(match: "re.Match[str]") -> str:
        nonlocal replacements
        ph = f"<{match.group(1)}>"  # canonical single-bracket key
        found.add(ph)
        original = registry_map.get(ph)
        if original is None:
            return match.group(0)  # unknown placeholder — leave untouched, brackets and all
        replacements += 1
        return str(original)

    for col in df.columns:
        if not _is_textlike(df[col]):
            continue
        try:
            df[col] = df[col].astype(str).str.replace(
                PLACEHOLDER_SCAN_PATTERN, _sub, regex=True
            )
        except (AttributeError, TypeError):
            continue

    unmatched = sorted(found - registry_map.keys())

    out_dir = Path(output_dir).expanduser().resolve()
    out_path = _build_restored_path(out_dir, output_format)
    if output_format == "parquet":
        df.to_parquet(out_path, index=False)
    else:
        df.to_csv(out_path, index=False)

    return FileRestoreResult(
        output_path=out_path,
        rows=rows,
        replacements=replacements,
        unmatched=unmatched,
    )


def _build_restored_path(out_dir: Path, output_format: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    suffix = ".parquet" if output_format == "parquet" else ".csv"
    return out_dir / f"restored_{timestamp}{suffix}"
