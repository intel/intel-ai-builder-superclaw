"""I/O helpers for tabular files (CSV / Parquet / Excel).

Centralised here so the agent modules and the CLI scripts share one
implementation of read / write / verify logic.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

SUPPORTED_INPUT_SUFFIXES = (".csv", ".parquet", ".xlsx", ".xls")


def load_table(path: str | Path, *, force_str: bool = False):
    """Read a tabular file into a pandas DataFrame.

    Args:
        path: Path to the file. Suffix determines the reader.
        force_str: If ``True``, force every column to be read as string
            (preserves placeholder text in already-masked files). Defaults to
            ``False`` so pandas can infer numeric / datetime dtypes for source
            data — saving 2-3x memory on numeric-heavy datasets.

    Raises:
        FileNotFoundError: If the file does not exist.
        ValueError: If the suffix is not supported.
    """
    import pandas as pd

    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise FileNotFoundError(f"File not found: {p}")

    suffix = p.suffix.lower()
    if suffix not in SUPPORTED_INPUT_SUFFIXES:
        raise ValueError(
            f"Unsupported file format: {suffix}. "
            f"Expected one of {SUPPORTED_INPUT_SUFFIXES}"
        )

    if suffix == ".parquet":
        # Parquet preserves dtypes natively; ``force_str`` would require an
        # explicit ``.astype(str)`` so just fall back to that when asked.
        df = pd.read_parquet(p)
        return df.astype(str) if force_str else df
    if suffix in (".xlsx", ".xls"):
        # xlsx is a ZIP archive; guard against decompression bombs before
        # openpyxl walks the sheet XML.
        if suffix == ".xlsx":
            from file_protection.documents import check_zip_safety
            check_zip_safety(p)
        return pd.read_excel(p, dtype=str if force_str else None)
    return pd.read_csv(p, dtype=str if force_str else None)


def _resolve_out_path(
    out_dir: Path, prefix: str, output_format: str
) -> Path:
    """Build a timestamped output path inside ``out_dir``."""
    out_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    suffix = ".parquet" if output_format == "parquet" else ".csv"
    return out_dir / f"{prefix}_{timestamp}{suffix}"


def save_dataframe(
    df,
    output_dir: str | Path,
    prefix: str,
    output_format: str = "csv",
) -> Path:
    """Persist a pandas DataFrame directly to a timestamped CSV / Parquet."""
    if output_format not in ("csv", "parquet"):
        raise ValueError(f"Unsupported output_format: {output_format}")

    out_dir = Path(output_dir).expanduser().resolve()
    out_path = _resolve_out_path(out_dir, prefix, output_format)
    if output_format == "parquet":
        df.to_parquet(out_path, index=False)
    else:
        df.to_csv(out_path, index=False)
    return out_path
