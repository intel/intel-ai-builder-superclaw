#!/usr/bin/env python3
"""CLI script to extract text content from PDF/DOCX/PPTX/XLSX/CSV files.

Usage:
    python extract_text.py <file_path> [options]

Options:
    --info              Only return metadata, no text. Works for any file type:
                        always returns at least {file, size_bytes, type}, plus
                        type-specific fields when available (e.g. slide/sheet/row
                        counts, column names).
    --pages N or N-M    Extract specific PDF pages (1-based).
    --slides N or N-M   Extract specific PPTX slides (1-based).
    --sheet NAME        Extract a specific Excel sheet by name.
    --rows N or N-M     Extract specific rows (1-based, for xlsx/csv).
    --cols N or N-M     Extract specific columns (1-based, for xlsx/csv).
    --advanced          Use advanced PDF parsing (better table extraction).

Outputs JSON to stdout:
    {"ok": true, "text": "...", "pages": 5, "format": "markdown"}
    {"ok": true, "type": ".pptx", "total_slides": 5, "size_bytes": 102400, "file": "..."}   (--info)
    {"ok": false, "error": "..."}
"""
import json
import sys
import logging
from pathlib import Path

logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)


def _parse_page_range(spec: str):
    """Parse a page range spec like '3' or '2-5' into (start, end) 1-based inclusive."""
    if '-' in spec:
        parts = spec.split('-', 1)
        return int(parts[0]), int(parts[1])
    n = int(spec)
    return n, n


def extract_pdf(file_path: str, advanced: bool = False, page_range=None) -> dict:
    """Extract text and tables from a PDF via SuperPDFReader.

    Output is markdown with ``<!-- Page N -->`` headers; tables become markdown
    tables (small) or key=value rows (large). ``advanced`` is accepted for API
    compatibility but pdfplumber always runs its best table extraction.
    """
    from pdf_reader import SuperPDFReader

    reader = SuperPDFReader(advanced_parsing=advanced)
    parsed = reader.extract_markdown(file_path, page_range=page_range)
    result = {"ok": True, "text": parsed["text"], "pages": parsed["pages"], "format": "markdown"}
    if page_range is not None:
        result["page_range"] = f"{page_range[0]}-{page_range[1]}"
    return result


def extract_docx(file_path: str) -> dict:
    from docx_reader import SuperDocxReader

    reader = SuperDocxReader()
    docs = reader.load_data(file=Path(file_path))
    if not docs:
        return {"ok": False, "error": "No content extracted from DOCX"}

    parts = []
    for doc in docs:
        text = doc.text if isinstance(doc.text, str) else doc.text.decode("utf-8", errors="replace")
        text = text.strip()
        if text:
            parts.append(text)

    full_text = "\n\n".join(parts).strip()
    return {"ok": True, "text": full_text, "pages": 0, "format": "markdown"}


def extract_pptx(file_path: str, slide_range=None) -> dict:
    from pptx_reader import SuperPptxReader

    reader = SuperPptxReader()
    docs = reader.load_data(file=Path(file_path))
    if not docs:
        return {"ok": False, "error": "No content extracted from PPTX"}

    # Count total slides (Documents whose text starts with "Slide #")
    slide_docs = [d for d in docs if d.text.strip().startswith("Slide #")]
    total_slides = len(slide_docs)

    parts = []
    for doc in docs:
        text = doc.text if isinstance(doc.text, str) else doc.text.decode("utf-8", errors="replace")
        text = text.strip()
        if not text:
            continue
        # Filter by slide range if specified
        if slide_range is not None and text.startswith("Slide #"):
            try:
                slide_num = int(text.split("Slide #")[1].split(":")[0].strip())
            except (ValueError, IndexError):
                slide_num = None
            if slide_num is not None and (slide_num < slide_range[0] or slide_num > slide_range[1]):
                continue
        # Table content from a skipped slide should also be filtered
        skip = doc.extra_info.get("skip_splitter", False) if hasattr(doc, 'extra_info') else False
        if skip and slide_range is not None:
            # Table docs contain "Table in slide #N"
            try:
                tbl_slide = int(text.split("slide #")[1].split(":")[0].strip())
            except (ValueError, IndexError):
                tbl_slide = None
            if tbl_slide is not None and (tbl_slide < slide_range[0] or tbl_slide > slide_range[1]):
                continue
        parts.append(text)

    full_text = "\n\n".join(parts).strip()
    result = {"ok": True, "text": full_text, "total_slides": total_slides, "format": "markdown"}
    if slide_range is not None:
        result["slide_range"] = f"{slide_range[0]}-{slide_range[1]}"
    return result


def extract_xlsx(file_path: str, sheet_name=None, row_range=None, col_range=None) -> dict:
    import pandas as pd

    try:
        dfs = pd.read_excel(file_path, sheet_name=sheet_name)
    except Exception as e:
        return {"ok": False, "error": f"Failed to read Excel file: {e}"}

    if isinstance(dfs, pd.DataFrame):
        dfs = {"Sheet1": dfs}

    parts = []
    for sname, df in dfs.items():
        if df.empty:
            continue
        df = df.fillna("")
        sliced = _slice_dataframe(df, row_range, col_range)
        text = _dataframe_to_text(sliced)
        if len(dfs) > 1:
            parts.append(f"--- Sheet: {sname} ---\n{text}")
        else:
            parts.append(text)

    full_text = "\n\n".join(parts).strip()
    result = {"ok": True, "text": full_text, "format": "table"}
    if row_range:
        result["row_range"] = f"{row_range[0]}-{row_range[1]}"
    if col_range:
        result["col_range"] = f"{col_range[0]}-{col_range[1]}"
    return result


def extract_csv(file_path: str, row_range=None, col_range=None) -> dict:
    import pandas as pd

    try:
        df = pd.read_csv(file_path)
    except Exception:
        try:
            text = Path(file_path).read_text(errors="replace")
            return {"ok": True, "text": text, "format": "plain"}
        except Exception as e2:
            return {"ok": False, "error": f"Failed to read CSV file: {e2}"}

    df = df.fillna("")
    sliced = _slice_dataframe(df, row_range, col_range)
    text = _dataframe_to_text(sliced)

    result = {"ok": True, "text": text, "format": "table"}
    if row_range:
        result["row_range"] = f"{row_range[0]}-{row_range[1]}"
    if col_range:
        result["col_range"] = f"{col_range[0]}-{col_range[1]}"
    return result


def _slice_dataframe(df, row_range=None, col_range=None):
    """Slice a DataFrame by 1-based row and column ranges."""
    if row_range is not None:
        start = row_range[0] - 1  # convert to 0-based
        end = row_range[1]        # iloc end is exclusive
        df = df.iloc[start:end]
    if col_range is not None:
        start = col_range[0] - 1
        end = col_range[1]
        df = df.iloc[:, start:end]
    return df


def _dataframe_to_text(df) -> str:
    """Convert a DataFrame to readable text with header=value format."""
    headers = df.columns.tolist()
    lines = []
    for _, row in df.iterrows():
        row_num = row.name + 1 if isinstance(row.name, int) else row.name
        line = f"Row {row_num}: " + " | ".join(
            f"{h} = {v}" for h, v in zip(headers, row.astype(str))
        )
        lines.append(line)
    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        json.dump({"ok": False, "error": "Usage: extract_text.py <file_path> [--advanced] [--pages N-M] [--slides N-M] [--sheet NAME] [--rows N-M] [--cols N-M] [--info]"}, sys.stdout)
        sys.exit(1)

    file_path = sys.argv[1]
    advanced = "--advanced" in sys.argv
    info_only = "--info" in sys.argv

    # Parse --pages argument
    page_range = None
    if "--pages" in sys.argv:
        idx = sys.argv.index("--pages")
        if idx + 1 < len(sys.argv):
            try:
                page_range = _parse_page_range(sys.argv[idx + 1])
            except ValueError:
                json.dump({"ok": False, "error": "Invalid --pages value. Use N or N-M (e.g. 1 or 1-5)"}, sys.stdout)
                sys.exit(1)

    # Parse --slides argument
    slide_range = None
    if "--slides" in sys.argv:
        idx = sys.argv.index("--slides")
        if idx + 1 < len(sys.argv):
            try:
                slide_range = _parse_page_range(sys.argv[idx + 1])
            except ValueError:
                json.dump({"ok": False, "error": "Invalid --slides value. Use N or N-M (e.g. 1 or 1-5)"}, sys.stdout)
                sys.exit(1)

    # Parse --sheet argument
    sheet_name = None
    if "--sheet" in sys.argv:
        idx = sys.argv.index("--sheet")
        if idx + 1 < len(sys.argv):
            sheet_name = sys.argv[idx + 1]

    # Parse --rows argument
    row_range = None
    if "--rows" in sys.argv:
        idx = sys.argv.index("--rows")
        if idx + 1 < len(sys.argv):
            try:
                row_range = _parse_page_range(sys.argv[idx + 1])
            except ValueError:
                json.dump({"ok": False, "error": "Invalid --rows value. Use N or N-M (e.g. 1 or 1-50)"}, sys.stdout)
                sys.exit(1)

    # Parse --cols argument
    col_range = None
    if "--cols" in sys.argv:
        idx = sys.argv.index("--cols")
        if idx + 1 < len(sys.argv):
            try:
                col_range = _parse_page_range(sys.argv[idx + 1])
            except ValueError:
                json.dump({"ok": False, "error": "Invalid --cols value. Use N or N-M (e.g. 1 or 3-5)"}, sys.stdout)
                sys.exit(1)

    if not Path(file_path).is_file():
        json.dump({"ok": False, "error": f"File not found: {file_path}"}, sys.stdout)
        sys.exit(1)

    ext = Path(file_path).suffix.lower()

    # --info mode: return metadata only
    if info_only:
        import pandas as pd
        size_bytes = Path(file_path).stat().st_size
        result = {"ok": True, "file": file_path, "size_bytes": size_bytes, "type": ext}
        if ext == ".pptx":
            try:
                from pptx import Presentation
                prs = Presentation(file_path)
                result["total_slides"] = len(prs.slides)
            except Exception:
                result["total_slides"] = None
        elif ext == ".xlsx":
            try:
                import openpyxl
                wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
                result["sheets"] = wb.sheetnames
                result["total_sheets"] = len(wb.sheetnames)
                ws = wb[wb.sheetnames[0]]
                result["total_rows"] = ws.max_row
                result["total_cols"] = ws.max_column
                # Read header row for column names
                header = [cell.value for cell in next(ws.iter_rows(min_row=1, max_row=1))]
                result["columns"] = header
                wb.close()
            except Exception:
                result["sheets"] = None
                result["total_rows"] = None
                result["total_cols"] = None
                result["columns"] = None
        elif ext == ".csv":
            try:
                df = pd.read_csv(file_path)
                result["total_rows"] = len(df)
                result["total_cols"] = len(df.columns)
                result["columns"] = df.columns.tolist()
            except Exception:
                result["total_rows"] = None
                result["total_cols"] = None
                result["columns"] = None
        json.dump(result, sys.stdout, ensure_ascii=False)
        return

    # Build a canonical string that captures all PDF extraction parameters
    is_pdf = ext == ".pdf"
    cache_key_val = None
    if is_pdf:
        from pdf_reader import cache_key, read_cache, md_path
        cache_key_val = cache_key(file_path, f"advanced={advanced}|pages={page_range}")
        cached = read_cache(cache_key_val)
        if cached is not None:
            md_file = md_path(file_path)
            if md_file.exists():
                out = {k: v for k, v in cached.items() if k != "text"}
                out["cached"] = True
                out["md_path"] = str(md_file)
                json.dump(out, sys.stdout, ensure_ascii=False)
                return
            # md file was cleaned up; ignore the stale cache and re-extract.

    try:
        if ext == ".pdf":
            result = extract_pdf(file_path, advanced=advanced, page_range=page_range)
        elif ext == ".docx":
            result = extract_docx(file_path)
        elif ext == ".pptx":
            result = extract_pptx(file_path, slide_range=slide_range)
        elif ext == ".xlsx":
            result = extract_xlsx(file_path, sheet_name=sheet_name, row_range=row_range, col_range=col_range)
        elif ext == ".csv":
            result = extract_csv(file_path, row_range=row_range, col_range=col_range)
        else:
            json.dump({"ok": False, "error": f"Unsupported file type: {ext}"}, sys.stdout)
            sys.exit(1)
    except Exception as e:
        logger.exception("Extraction failed")
        result = {"ok": False, "error": str(e)}

    if is_pdf and result.get("ok"):
        from pdf_reader import write_md, write_cache
        try:
            result["md_path"] = str(write_md(file_path, result.get("text", "")))
            del result["text"]
            # Cache metadata only (mtime/size fingerprint + md_path). The extracted
            # text lives in the md file under PDF_MD_DIR; storing it here too would
            # duplicate the full document (and any PII) in pdf_cache. On a cache hit
            # we return md_path and never read cached text, so dropping it is safe.
            write_cache(cache_key_val, result)
        except Exception as e:
            logger.exception("Markdown write failed")
            result = {"ok": False, "error": f"Failed to write markdown output: {e}"}

    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
