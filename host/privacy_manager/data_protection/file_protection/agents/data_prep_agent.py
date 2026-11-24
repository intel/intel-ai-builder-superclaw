"""Data Prep Agent — loads a source file and extracts the requested subset.

The first step in the pipeline: take a file path, a list of relevant
columns, and (optionally) a row filter, then write the extracted subset to a
staging directory.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

from file_protection.io import load_table, save_dataframe


def prepare_dataframe(
    df,
    *,
    columns: Sequence[str] | None = None,
    filter_col: str | None = None,
    filter_val: str | None = None,
):
    """Project + row-filter a DataFrame — the disk-free core of DataPrepAgent.

    Selects ``columns`` (all if ``None``) and applies an optional equality
    filter (``filter_col == filter_val``, string-compared). Returns a new
    DataFrame; the input is not mutated.

    Raises:
        ValueError: If a requested column / filter column is absent, or the
            projection+filter yields 0 rows.
    """
    if columns:
        missing = [c for c in columns if c not in df.columns]
        if missing:
            raise ValueError(
                f"Columns not found: {missing}. Available: {list(df.columns)}"
            )
        df = df[list(columns)]

    if filter_col and filter_val is not None:
        if filter_col not in df.columns:
            raise ValueError(f"Filter column '{filter_col}' not in {list(df.columns)}")
        df = df[df[filter_col].astype(str) == str(filter_val)]

    if df.empty:
        raise ValueError(
            "Extraction resulted in 0 rows. Check the columns/filter values."
        )
    return df


def read_source(source_file: str | Path, *, sheet: str | int = 0):
    """Read a tabular source into a DataFrame, honoring Excel sheet selection.

    Excel sheets are read as all-string (``dtype=str``) so cell text is
    preserved verbatim; csv/parquet keep native dtypes (no ``force_str``) so
    numeric columns stay numeric — saving 2-3x memory on numeric-heavy data.
    """
    path = Path(source_file).expanduser().resolve()
    if path.suffix.lower() in (".xlsx", ".xls"):
        return _read_sheet(path, sheet)
    return load_table(path)


@dataclass
class DataPrepResult:
    """Summary returned to the orchestrator."""

    source_file: Path
    sheet_used: str | int | None
    rows_extracted: int
    columns_extracted: list[str]
    suspected_sensitive_columns: list[str]
    extracted_file: Path
    status: str = "success"
    error: str | None = None

    def as_summary(self) -> str:
        """Format as a human-readable handoff block."""
        return (
            "Data Prep Complete\n"
            "-----------------------------------------------------\n"
            f"Source File        : {self.source_file}\n"
            f"Sheet Used         : {self.sheet_used}\n"
            f"Rows Extracted     : {self.rows_extracted}\n"
            f"Columns Extracted  : {self.columns_extracted}\n"
            f"Suspected PII Cols : {self.suspected_sensitive_columns}\n"
            f"Extracted File     : {self.extracted_file}\n"
            f"Status             : {self.status}"
        )


@dataclass
class DataPrepAgent:
    """Tabular extraction agent.

    Attributes:
        output_dir: Directory where extracted files are written.
        output_format: ``"csv"`` (default) or ``"parquet"``.
    """

    output_dir: Path
    output_format: str = "csv"

    def __post_init__(self) -> None:
        self.output_dir = Path(self.output_dir).expanduser().resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def run(
        self,
        source_file: str | Path,
        *,
        columns: Sequence[str] | None = None,
        filter_col: str | None = None,
        filter_val: str | None = None,
        sheet: str | int = 0,
        suspected_sensitive_columns: Sequence[str] = (),
    ) -> DataPrepResult:
        """Load ``source_file``, optionally filter, and persist to ``output_dir``.

        Args:
            source_file: Path to an xlsx/xls/csv/parquet file.
            columns: Columns to keep. ``None`` keeps all columns.
            filter_col: Column to apply an equality filter on.
            filter_val: Value to match for ``filter_col``.
            sheet: Excel sheet name or index (ignored for csv/parquet).
            suspected_sensitive_columns: Columns the orchestrator flagged as PII.

        Returns:
            :class:`DataPrepResult` describing what was written.
        """
        path = Path(source_file).expanduser().resolve()
        df = read_source(path, sheet=sheet)
        df = prepare_dataframe(
            df, columns=columns, filter_col=filter_col, filter_val=filter_val
        )

        out_path = save_dataframe(
            df,
            output_dir=self.output_dir,
            prefix="extracted",
            output_format=self.output_format,
        )

        return DataPrepResult(
            source_file=path,
            sheet_used=sheet if path.suffix.lower() in (".xlsx", ".xls") else None,
            rows_extracted=len(df),
            columns_extracted=list(df.columns),
            suspected_sensitive_columns=list(suspected_sensitive_columns),
            extracted_file=out_path,
        )


def _read_sheet(path: Path, sheet: str | int):
    import pandas as pd

    return pd.read_excel(path, sheet_name=sheet, dtype=str)
