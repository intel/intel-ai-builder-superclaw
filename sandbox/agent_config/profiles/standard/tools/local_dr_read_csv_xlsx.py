#!/usr/bin/env python3
"""
Read a CSV or XLSX file and render it as markdown — with automatic
group-by aggregations appended for any low-cardinality categorical
column paired with numeric columns.

Designed for small-LLM consumers: the model sees the schema, a sample of
rows, AND deterministic group sums in one tool call, so it doesn't have
to re-derive aggregations by inspection (which it gets wrong on tables
larger than ~30 rows).

Usage:
  python3 local_dr_read_csv_xlsx.py '<json_spec>'

Spec:
  { "path": "<absolute path to .csv or .xlsx>" }

For XLSX: every sheet is rendered. The full sheet list appears at the top
so the agent always sees what's available.

Output is bounded — schema + auto-aggregations, plus a full table only for
small sheets (rows × cols ≤ 1000). For larger sheets the raw rows are
suppressed and the agent must use `query_table` for any specific row,
filtered subset, or top-N over high-cardinality columns.

  ## Auto-aggregations
  ### By <categorical>
  | <cat> | <numeric>_sum | ... |
  | TOTAL | ... |

Requires: pandas, openpyxl.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pandas as pd


_DEFAULT_MAX_ROWS = 200
_AUTO_CARDINALITY_LIMIT = 20      # categorical column auto-detect threshold
_AUTO_AGG_MAX_GROUPS = 30         # cap rows in an auto-aggregation
_AUTO_AGG_MAX_NUMERIC_COLS = 6    # cap how many numeric cols we sum per categorical


def _md_table(df: pd.DataFrame, max_rows: int | None = None) -> str:
    """Render a DataFrame as a markdown table. Truncates rows past max_rows."""
    n_total = len(df)
    truncated = False
    if max_rows is not None and n_total > max_rows:
        df = df.head(max_rows)
        truncated = True
    if df.empty:
        return "*(no rows)*"
    cols = list(df.columns)

    def _fmt(v: Any) -> str:
        if v is None or (isinstance(v, float) and pd.isna(v)):
            return ""
        s = str(v).replace("\n", " ").replace("|", "\\|")
        return s

    lines = []
    lines.append("| " + " | ".join(_fmt(c) for c in cols) + " |")
    lines.append("| " + " | ".join("---" for _ in cols) + " |")
    for _, row in df.iterrows():
        lines.append("| " + " | ".join(_fmt(row[c]) for c in cols) + " |")
    if truncated:
        lines.append(f"\n*(showing first {max_rows} of {n_total} rows)*")
    return "\n".join(lines)


def _detect_categorical_cols(df: pd.DataFrame) -> list[str]:
    """Pick string columns whose distinct-value count is below the threshold."""
    cats: list[str] = []
    for c in df.columns:
        s = df[c]
        if pd.api.types.is_object_dtype(s) or pd.api.types.is_string_dtype(s):
            n_unique = s.nunique(dropna=True)
            if 1 < n_unique <= _AUTO_CARDINALITY_LIMIT:
                cats.append(c)
    return cats


def _detect_numeric_cols(df: pd.DataFrame) -> list[str]:
    """Numeric columns suitable for sum aggregation."""
    return [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])]


def _format_groupby_block(df: pd.DataFrame, cat_col: str, numeric_cols: list[str]) -> str:
    """Build the markdown for a single 'By <categorical>' aggregation block."""
    if not numeric_cols:
        return ""
    g = df.groupby(cat_col, dropna=False)[numeric_cols].sum().reset_index()
    # Sort by first numeric column descending for readability
    g = g.sort_values(numeric_cols[0], ascending=False)
    truncated = False
    if len(g) > _AUTO_AGG_MAX_GROUPS:
        g = g.head(_AUTO_AGG_MAX_GROUPS)
        truncated = True
    # Append a TOTAL row
    totals = {numeric_cols[0]: float(df[numeric_cols[0]].sum())}
    for nc in numeric_cols[1:]:
        totals[nc] = float(df[nc].sum())
    total_row = {cat_col: "**TOTAL**", **totals}
    g = pd.concat([g, pd.DataFrame([total_row])], ignore_index=True)
    md = _md_table(g)
    if truncated:
        md += f"\n*(showing top {_AUTO_AGG_MAX_GROUPS} groups by {numeric_cols[0]}; total row reflects ALL rows)*"
    return md


_SHOW_FULL_TABLE_CELL_LIMIT = 1000


def _render_sheet(df: pd.DataFrame) -> str:
    """Render schema + auto-aggregations. The full table is included only
    when rows × cols ≤ _SHOW_FULL_TABLE_CELL_LIMIT (default 1000). For
    larger sheets, raw rows are suppressed and the agent must call
    `query_table` to retrieve specific values, filtered subsets, or
    top-N over high-cardinality columns."""
    parts: list[str] = []

    # ── shape + columns ────────────────────────────────────────────────────
    parts.append(f"**Shape:** {len(df)} rows × {len(df.columns)} columns")
    col_lines = []
    skipped_cardinality: list[tuple[str, int]] = []
    for c in df.columns:
        s = df[c]
        if pd.api.types.is_numeric_dtype(s):
            kind = f"numeric (range {s.min()}{'..'}{s.max()})" if not s.empty else "numeric"
        elif pd.api.types.is_datetime64_any_dtype(s):
            kind = "datetime"
        else:
            n_unique = s.nunique(dropna=True)
            kind = f"text ({n_unique} unique)"
            if n_unique > _AUTO_CARDINALITY_LIMIT:
                skipped_cardinality.append((c, int(n_unique)))
        col_lines.append(f"- `{c}` ({kind})")
    parts.append("**Columns:**\n" + "\n".join(col_lines))

    # ── full table (only if rows × cols ≤ threshold) ──────────────────────
    n_cells = len(df) * len(df.columns)
    if n_cells <= _SHOW_FULL_TABLE_CELL_LIMIT:
        parts.append(f"\n### Full table\n\n{_md_table(df)}")
    else:
        parts.append(
            "\n*(Table not shown. Use `query_table` to retrieve specific rows or filtered subsets.)*"
        )

    # ── auto-aggregations (always; default detection) ─────────────────────
    cats = _detect_categorical_cols(df)
    numerics = _detect_numeric_cols(df)[:_AUTO_AGG_MAX_NUMERIC_COLS]
    if cats and numerics:
        parts.append("\n### Auto-aggregations\n")
        parts.append(
            f"*Sums of {numerics} grouped by every low-cardinality categorical "
            "column. Use these directly — do not re-sum rows.*\n"
        )
        for cat in cats:
            block = _format_groupby_block(df, cat, numerics)
            if block:
                parts.append(f"\n#### By `{cat}`\n\n{block}")
    else:
        parts.append("\n*(no auto-aggregations: needs ≥1 categorical column with ≤"
                     f"{_AUTO_CARDINALITY_LIMIT} unique values AND ≥1 numeric column)*")

    # ── columns that didn't auto-aggregate (so agent knows to use query_table) ──
    if skipped_cardinality:
        skipped_str = ", ".join(f"`{c}` ({n} unique)" for c, n in skipped_cardinality)
        parts.append(
            f"\n### Columns above the auto-aggregation threshold ({_AUTO_CARDINALITY_LIMIT}):\n"
            f"{skipped_str}\n\n"
            f"→ For sums / top-N / filtered queries on these columns, call `query_table`."
        )

    return "\n".join(parts)


def _detect_header_row(raw: pd.DataFrame, max_scan: int = 10) -> int:
    """Detect the header row of a sheet that may have title rows above the
    real header. Heuristic: among the first `max_scan` rows, pick the row
    with the most non-null cells (n_nonnull >= 2 and next row width >= 50%
    of candidate width). On ties, prefer the EARLIEST row — clean tables
    with the header in row 0 should not be displaced by an identical-width
    data row a few rows below."""
    if len(raw) == 0:
        return 0
    best = 0
    best_score = -1
    for h in range(min(max_scan, len(raw))):
        n_nonnull = int(raw.iloc[h].notna().sum())
        if n_nonnull < 2:
            continue
        if h + 1 >= len(raw):
            continue
        next_nonnull = int(raw.iloc[h + 1].notna().sum())
        if next_nonnull < max(2, n_nonnull * 0.5):
            continue
        # Earlier rows win ties: subtract h.
        score = n_nonnull * 1000 - h
        if score > best_score:
            best_score = score
            best = h
    return best


def _read_table(p: Path, sheet: str | None, suffix: str) -> tuple[pd.DataFrame, int]:
    """Return (df, header_row_index_used). For CSV: header=0 always.
    For XLSX: detect from the raw sheet."""
    if suffix == ".csv":
        return pd.read_csv(p), 0
    # XLSX: read raw, detect, re-read with detected header
    raw = pd.read_excel(p, sheet_name=sheet, header=None)
    h = _detect_header_row(raw)
    df = pd.read_excel(p, sheet_name=sheet, header=h)
    return df, h


def render(spec: dict) -> str:
    path = spec["path"]
    p = Path(path)
    if not p.exists():
        raise ValueError(f"file not found: {path}")
    suffix = p.suffix.lower()
    if suffix not in (".csv", ".xlsx", ".xlsm"):
        raise ValueError(f"unsupported file type: {suffix} (only .csv / .xlsx)")

    parts: list[str] = []
    parts.append(f"# {p.name}")

    if suffix == ".csv":
        df, _ = _read_table(p, None, suffix)
        parts.append(_render_sheet(df))
    else:
        xls = pd.ExcelFile(p)
        sheet_names = xls.sheet_names
        # Always show the full workbook sheet list — agent should know what's available.
        parts.append(f"**All sheets in workbook ({len(sheet_names)}):** {sheet_names}\n")
        for sn in sheet_names:
            parts.append(f"\n## Sheet: `{sn}`\n")
            try:
                df, h = _read_table(p, sn, suffix)
            except Exception as e:
                parts.append(f"*(failed to read: {e})*")
                continue
            if h > 0:
                # Show the title rows verbatim so the agent doesn't lose
                # context (e.g. "TaskForge Inc. — Compensation Benchmarks").
                raw = pd.read_excel(p, sheet_name=sn, header=None)
                preamble: list[str] = []
                for i in range(h):
                    row_vals = [str(v) for v in raw.iloc[i] if pd.notna(v)]
                    if row_vals:
                        preamble.append(f"> {' | '.join(row_vals)}")
                if preamble:
                    parts.append("**Preamble (title rows above the header):**")
                    parts.extend(preamble)
                    parts.append("")
            parts.append(_render_sheet(df))

    return "\n".join(parts)


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: local_dr_read_csv_xlsx.py '<json_spec>'"}), file=sys.stderr)
        return 2
    try:
        spec = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid JSON spec: {e}"}), file=sys.stderr)
        return 2
    try:
        out = render(spec)
    except (KeyError, ValueError) as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        return 1
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}), file=sys.stderr)
        return 1
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
