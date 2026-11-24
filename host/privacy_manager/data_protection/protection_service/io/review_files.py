"""Format-specific preview and string rewriting for masked output files.

Used by the post-masking review: ``render_preview`` produces text the UI can show, and
``transform_strings`` applies a string function to every text value in the file.
Supported: text-like files (.csv .txt .md .html .htm), Excel (.xlsx .xlsm), .parquet, .docx.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Iterable
from pathlib import Path

TEXT_EXTENSIONS = frozenset({".csv", ".txt", ".md", ".html", ".htm"})
EXCEL_EXTENSIONS = frozenset({".xlsx", ".xlsm"})
SUPPORTED_EXTENSIONS = TEXT_EXTENSIONS | EXCEL_EXTENSIONS | {".parquet", ".docx"}


def _cell(value: object) -> str:
    text = "" if value is None else str(value)
    return text.replace("|", "\\|").replace("\r", " ").replace("\n", " ").strip()


def _markdown_table(rows: Iterable[list[str]], budget: int) -> tuple[str, bool]:
    """Render rows (first row = header) as a markdown table within ``budget`` characters."""
    collected: list[list[str]] = []
    used = 0
    truncated = False
    for row in rows:
        cells = [_cell(v) for v in row]
        while cells and not cells[-1]:
            cells.pop()
        if not cells and not collected:
            continue
        used += sum(len(c) + 3 for c in cells) + 2
        if used > budget:
            truncated = True
            break
        collected.append(cells)
    if not collected:
        return "", truncated
    width = max(len(r) for r in collected)
    padded = [r + [""] * (width - len(r)) for r in collected]
    lines = ["| " + " | ".join(padded[0]) + " |", "|" + " --- |" * width]
    lines += ["| " + " | ".join(r) + " |" for r in padded[1:]]
    return "\n".join(lines), truncated


def _preview_excel(path: Path, budget: int) -> tuple[str, bool]:
    from openpyxl import load_workbook

    workbook = load_workbook(path, read_only=True, data_only=True)
    parts: list[str] = []
    truncated = False
    try:
        for sheet in workbook.worksheets:
            table, cut = _markdown_table(sheet.iter_rows(values_only=True), budget)
            parts.append(f"## {sheet.title}\n\n{table}" if table else f"## {sheet.title}")
            budget -= len(table)
            if cut or budget <= 0:
                truncated = True
                break
    finally:
        workbook.close()
    return "\n\n".join(parts), truncated


def _preview_parquet(path: Path, budget: int) -> tuple[str, bool]:
    import pandas as pd

    df = pd.read_parquet(path)
    rows = [list(map(str, df.columns))] + df.astype(object).values.tolist()
    return _markdown_table(rows, budget)


def _preview_docx(path: Path, budget: int) -> tuple[str, bool]:
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    parts: list[str] = []
    used = 0
    for block in docx.Document(str(path)).iter_inner_content():
        if isinstance(block, Paragraph):
            text = block.text.strip()
            if not text:
                continue
            style = block.style.name if block.style is not None else ""
            level = style.removeprefix("Heading ").strip()
            piece = f"{'#' * int(level)} {text}" if style.startswith("Heading ") and level.isdigit() else text
            parts.append(piece)
            used += len(piece)
        elif isinstance(block, Table):
            table, cut = _markdown_table(
                ([_cell_text(c) for c in row.cells] for row in block.rows), max(budget - used, 0)
            )
            if table:
                parts.append(table)
                used += len(table)
            if cut:
                return "\n\n".join(parts), True
        if used > budget:
            return "\n\n".join(parts)[:budget], True
    return "\n\n".join(parts), False


def _cell_text(cell: object) -> str:
    """Cell text including any nested tables, so the preview shows what masking can reach."""
    texts = [cell.text]  # type: ignore[attr-defined]
    for table in cell.tables:  # type: ignore[attr-defined]
        for row in table.rows:
            texts.extend(_cell_text(c) for c in row.cells)
    return " ".join(t for t in texts if t)


def render_preview(path: Path, budget: int) -> tuple[str, str, bool]:
    """Return ``(text, format, truncated)``; ``format`` is ``"markdown"`` or ``"text"``."""
    ext = path.suffix.lower()
    if ext in TEXT_EXTENSIONS:
        raw = path.read_text(encoding="utf-8")
        return raw[:budget], "markdown" if ext == ".md" else "text", len(raw) > budget
    if ext in EXCEL_EXTENSIONS:
        text, truncated = _preview_excel(path, budget)
    elif ext == ".parquet":
        text, truncated = _preview_parquet(path, budget)
    elif ext == ".docx":
        text, truncated = _preview_docx(path, budget)
    else:
        raise ValueError(f"unsupported extension {ext}")
    return text, "markdown", truncated


def _tmp_sibling(path: Path) -> Path:
    return path.with_name(f"{path.stem}.review-tmp{path.suffix}")


def _transform_excel(path: Path, fn: Callable[[str], str], write: bool) -> None:
    from openpyxl import load_workbook

    workbook = load_workbook(path, keep_vba=path.suffix.lower() == ".xlsm")
    for sheet in workbook.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                value = cell.value
                # Formulas are left alone: rewriting text inside them could break the workbook.
                if isinstance(value, str) and value and not value.startswith("="):
                    new = fn(value)
                    if write and new != value:
                        cell.value = new
    if write:
        tmp = _tmp_sibling(path)
        workbook.save(tmp)
        os.replace(tmp, path)


def _dedupe_names(names: list[object]) -> list[object]:
    """Keep column names unique after masking, e.g. two headers that both became a placeholder."""
    seen: dict[object, int] = {}
    unique: list[object] = []
    for name in names:
        seen[name] = seen.get(name, 0) + 1
        unique.append(name if seen[name] == 1 else f"{name}_{seen[name]}")
    return unique


def _transform_parquet(path: Path, fn: Callable[[str], str], write: bool) -> None:
    import pandas as pd

    df = pd.read_parquet(path)
    # Headers are shown in the preview, so they are scanned and rewritten like cell values.
    renamed = [fn(c) if isinstance(c, str) and c else c for c in df.columns]
    for col in df.columns:
        if pd.api.types.is_string_dtype(df[col]) or pd.api.types.is_object_dtype(df[col]):
            df[col] = df[col].map(lambda v: fn(v) if isinstance(v, str) and v else v)
    if write:
        df.columns = _dedupe_names(renamed)
        tmp = _tmp_sibling(path)
        df.to_parquet(tmp, index=False)
        os.replace(tmp, path)


def _transform_paragraph(paragraph: object, fn: Callable[[str], str], write: bool) -> None:
    original = paragraph.text  # type: ignore[attr-defined]
    if not original:
        return
    new = fn(original)
    runs = paragraph.runs  # type: ignore[attr-defined]
    if not write or new == original or not runs:
        return
    run_texts = [fn(r.text) if r.text else r.text for r in runs]
    if "".join(run_texts) == new:
        for run, text in zip(runs, run_texts):
            run.text = text
        return
    # The match spans runs, so formatting inside this one paragraph is flattened.
    runs[0].text = new
    for run in runs[1:]:
        run.text = ""


def _transform_tables(tables: Iterable[object], fn: Callable[[str], str], write: bool) -> None:
    for table in tables:
        for row in table.rows:  # type: ignore[attr-defined]
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    _transform_paragraph(paragraph, fn, write)
                _transform_tables(cell.tables, fn, write)


def _transform_docx(path: Path, fn: Callable[[str], str], write: bool) -> None:
    import docx

    document = docx.Document(str(path))
    containers: list[object] = [document]
    for section in document.sections:
        containers += [section.header, section.footer]
    for container in containers:
        for paragraph in container.paragraphs:  # type: ignore[attr-defined]
            _transform_paragraph(paragraph, fn, write)
        _transform_tables(container.tables, fn, write)  # type: ignore[attr-defined]
    if write:
        tmp = _tmp_sibling(path)
        document.save(str(tmp))
        os.replace(tmp, path)


def transform_strings(path: Path, fn: Callable[[str], str], *, write: bool) -> None:
    """Apply ``fn`` to every text value in ``path``; persist the results only if ``write``.

    With ``write=False`` this is a read-only scan, so ``fn`` can be used to detect matches.
    """
    ext = path.suffix.lower()
    if ext in TEXT_EXTENSIONS:
        text = path.read_text(encoding="utf-8")
        new = fn(text)
        if write and new != text:
            path.write_text(new, encoding="utf-8")
    elif ext in EXCEL_EXTENSIONS:
        _transform_excel(path, fn, write)
    elif ext == ".parquet":
        _transform_parquet(path, fn, write)
    elif ext == ".docx":
        _transform_docx(path, fn, write)
    else:
        raise ValueError(f"unsupported extension {ext}")
