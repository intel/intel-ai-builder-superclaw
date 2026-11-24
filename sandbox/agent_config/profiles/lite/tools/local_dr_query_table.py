#!/usr/bin/env python3
"""
Deterministic CSV / XLSX aggregation tool (local_dr variant).

Usage:
  python3 local_dr_query_table.py '<json_spec>'

The JSON spec:
  {
    "path":              "<absolute path to .csv or .xlsx>",
    "sheet":             "<sheet name>"            // xlsx only; default first
    "filter":            [{"col":..., "op":..., "val":...}, ...],
    "group_by":          ["col1", ...],
    "aggregate":         [{"col":..., "op":...}, ...],
    "sort_by":           {"col":..., "dir":"asc"|"desc"},
    "limit":             <int>,
    "add_pct_of_total":  true|false
  }

filter ops:    "==" "!=" ">" "<" ">=" "<=" "in" "contains" "isnull" "notnull"
aggregate ops: "sum" "mean" "count" "min" "max" "first" "nunique"

Output (always JSON):
  {
    "shape_in":   [n_rows, n_cols],
    "columns_in": [...],
    "rows":       [...],
    "grand_total": {col: total},          // sum across rows of each agg col
    "n_rows_out": int,
    "warnings":   [...]                   // empty if all good
  }

On error: prints {"error": "...", "available_columns": [...]} and exits 1.
The TS wrapper relays both shapes back to the agent.

Requires: pandas, openpyxl.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pandas as pd


def _load(path: str, sheet: str | None) -> pd.DataFrame:
    p = Path(path)
    if not p.exists():
        raise ValueError(f"file not found: {path}")
    if p.suffix.lower() == ".csv":
        return pd.read_csv(p)
    if p.suffix.lower() in (".xlsx", ".xlsm"):
        return pd.read_excel(p, sheet_name=sheet) if sheet else pd.read_excel(p)
    raise ValueError(f"unsupported file type: {p.suffix} (only .csv / .xlsx)")


def _check_col(df: pd.DataFrame, col: str, role: str) -> None:
    if col not in df.columns:
        raise KeyError(
            f"column {col!r} not found ({role}). available columns: "
            f"{list(df.columns)}"
        )


_FILTER_OPS = {
    "==": lambda s, v: s == v,
    "!=": lambda s, v: s != v,
    ">":  lambda s, v: s > v,
    "<":  lambda s, v: s < v,
    ">=": lambda s, v: s >= v,
    "<=": lambda s, v: s <= v,
    "in": lambda s, v: s.isin(v if isinstance(v, list) else [v]),
    "contains": lambda s, v: s.astype(str).str.contains(str(v), case=False, na=False),
    "isnull":  lambda s, v: s.isna(),
    "notnull": lambda s, v: s.notna(),
}

# Forgive common operator slips so a single mistaken token does not waste an
# agent step. These map to the canonical ops above; they add no new behaviour.
_FILTER_OP_ALIASES = {
    "=":   "==",
    "<>":  "!=",
    "!==": "!=",
    "=>":  ">=",
    "=<":  "<=",
    "eq":  "==",
    "ne":  "!=",
    "gt":  ">",
    "lt":  "<",
    "ge":  ">=",
    "le":  "<=",
}

_AGG_OPS = {"sum", "mean", "count", "min", "max", "first", "nunique"}


def query_table(spec: dict) -> dict:
    path = spec["path"]
    sheet = spec.get("sheet")
    df = _load(path, sheet)
    shape_in = list(df.shape)
    cols_in = list(df.columns)

    warnings: list[str] = []

    # ── filter ──────────────────────────────────────────────────────────────
    for f in spec.get("filter") or []:
        col, op, val = f.get("col"), f.get("op"), f.get("val")
        _check_col(df, col, "filter")
        op = _FILTER_OP_ALIASES.get(op, op)
        if op not in _FILTER_OPS:
            raise ValueError(f"unknown filter op: {op}. valid: {list(_FILTER_OPS)}")
        df = df[_FILTER_OPS[op](df[col], val)]

    # ── group_by + aggregate ────────────────────────────────────────────────
    group_by = spec.get("group_by") or []
    aggregate = spec.get("aggregate") or []
    for g in group_by:
        _check_col(df, g, "group_by")
    for a in aggregate:
        _check_col(df, a["col"], "aggregate")
        if a["op"] not in _AGG_OPS:
            raise ValueError(f"unknown aggregate op: {a['op']}. valid: {sorted(_AGG_OPS)}")

    if group_by and aggregate:
        agg_dict: dict[str, list[str]] = {}
        for a in aggregate:
            agg_dict.setdefault(a["col"], []).append(a["op"])
        out = df.groupby(group_by, dropna=False).agg(agg_dict)
        # flatten multi-level columns to "<col>_<op>"
        out.columns = [f"{c}_{op}" for c, op in out.columns]
        out = out.reset_index()
    elif aggregate and not group_by:
        # whole-frame aggregation → single-row dataframe
        agg_row: dict[str, Any] = {}
        for a in aggregate:
            agg_row[f"{a['col']}_{a['op']}"] = getattr(df[a["col"]], a["op"])()
        out = pd.DataFrame([agg_row])
    elif group_by and not aggregate:
        # group counts
        out = df.groupby(group_by, dropna=False).size().reset_index(name="count")
    else:
        out = df.copy()

    # ── add_pct_of_total ────────────────────────────────────────────────────
    grand_total: dict[str, float] = {}
    if spec.get("add_pct_of_total"):
        # add a pct column for each numeric *_sum / *_count column
        for col in list(out.columns):
            if col in group_by:
                continue
            if pd.api.types.is_numeric_dtype(out[col]) and (
                col.endswith("_sum") or col.endswith("_count")
            ):
                tot = float(out[col].sum())
                if tot != 0:
                    out[f"{col}_pct"] = (out[col] / tot * 100).round(2)
                    grand_total[col] = tot
    else:
        for col in out.columns:
            if col in group_by:
                continue
            if pd.api.types.is_numeric_dtype(out[col]) and col.endswith("_sum"):
                grand_total[col] = float(out[col].sum())

    # ── sort_by ─────────────────────────────────────────────────────────────
    sort_by = spec.get("sort_by")
    if sort_by:
        sc = sort_by["col"]
        if sc not in out.columns:
            raise KeyError(
                f"sort_by column {sc!r} not in result. available output columns: "
                f"{list(out.columns)}"
            )
        out = out.sort_values(sc, ascending=(sort_by.get("dir", "asc") == "asc"))

    # ── limit ───────────────────────────────────────────────────────────────
    n_full = len(out)
    limit = spec.get("limit")
    if limit is not None and n_full > limit:
        out = out.head(limit)
        warnings.append(f"result truncated to {limit} of {n_full} rows by limit")

    # ── format output ──────────────────────────────────────────────────────
    rows: list[dict] = []
    for _, r in out.iterrows():
        row: dict[str, Any] = {}
        for c in out.columns:
            v = r[c]
            if pd.isna(v):
                row[c] = None
            elif isinstance(v, (pd.Timestamp,)):
                row[c] = str(v)
            elif hasattr(v, "item"):  # numpy scalars
                row[c] = v.item()
            else:
                row[c] = v
        rows.append(row)

    return {
        "shape_in":    shape_in,
        "columns_in":  cols_in,
        "rows":        rows,
        "grand_total": grand_total,
        "n_rows_out":  len(rows),
        "warnings":    warnings,
    }


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: local_dr_query_table.py '<json_spec>'"}), file=sys.stderr)
        return 2
    try:
        spec = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid JSON spec: {e}"}), file=sys.stderr)
        return 2

    try:
        result = query_table(spec)
    except (KeyError, ValueError) as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        return 1
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}), file=sys.stderr)
        return 1

    print(json.dumps(result, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
