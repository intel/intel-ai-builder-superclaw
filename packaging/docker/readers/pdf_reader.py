import hashlib
import json
import logging
from pathlib import Path
from typing import Dict, List, Optional, Union

import pandas as pd
from llama_index.core.readers.base import BaseReader
from llama_index.core.schema import Document

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Parse-result cache (PDF only)
# ---------------------------------------------------------------------------
# Extracted markdown is written under PDF_MD_DIR; a small JSON fingerprint under
# PDF_CACHE_DIR maps (file mtime/size + parse args) -> md_path. Stale entries are
# ignored on key mismatch.

# Anchor the cache/markdown output under the real workspace root. In the
# container SUPERCLAW_PATH=/workspace (docker-compose.backend.yml); natively the
# broker catalog sets OPENCODE_DIRECTORY to the Windows SuperClawProjects dir. The
# md must land inside the workspace so the agent's Read tool (workspace-scoped)
# can read it back, and so the Low-IL sandbox is allowed to write it. Falls back
# to /workspace to preserve container behaviour when the env is unset.
import os

_WORKSPACE_ROOT = Path(
    os.environ.get("SUPERCLAW_PATH") or os.environ.get("OPENCODE_DIRECTORY") or "/workspace"
)
PDF_CACHE_DIR = _WORKSPACE_ROOT / "tmp" / "pdf_cache"
PDF_MD_DIR = _WORKSPACE_ROOT / "tmp" / "pdf_md"


def md_path(file_path: str) -> Path:
    """Return a stable markdown output path derived from the source file path.

    Format: <stem>_<id>.md  e.g. report_3a7f2b1c9d4e.md
    The id is a 12-char sha256 prefix of the full file path, ensuring uniqueness
    while keeping the filename human-readable.
    """
    stem = Path(file_path).stem
    key = hashlib.sha256(file_path.encode()).hexdigest()[:12]
    return PDF_MD_DIR / f"{stem}_{key}.md"


def write_md(file_path: str, text: str) -> Path:
    """Write extracted text to a markdown file and return its path.

    Write failures propagate so callers fail loudly rather than returning a
    path to a file that doesn't exist.
    """
    path = md_path(file_path)
    PDF_MD_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def cache_key(file_path: str, extra: str) -> str:
    p = Path(file_path)
    stat = p.stat()
    raw = f"{file_path}|{stat.st_mtime_ns}|{stat.st_size}|{extra}"
    return hashlib.sha256(raw.encode()).hexdigest()


def read_cache(key: str) -> Optional[dict]:
    cache_file = PDF_CACHE_DIR / f"{key}.json"
    try:
        return json.loads(cache_file.read_text(encoding="utf-8"))
    except Exception:
        return None


def write_cache(key: str, result: dict) -> None:
    try:
        PDF_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (PDF_CACHE_DIR / f"{key}.json").write_text(
            json.dumps(result, ensure_ascii=False), encoding="utf-8"
        )
    except Exception as e:
        logger.debug("Cache write failed: %s", e)


class SuperPDFReader(BaseReader):
    """PDF parser using pypdfium2 for text extraction and pdfplumber for table extraction.

    Ported from superbuilder pybackend/components/readers/pdf_reader.py.
    """

    def __init__(self, advanced_parsing=False, table_rows_threshold=10):
        self.advanced_parsing = advanced_parsing
        self.table_rows_threshold = table_rows_threshold

    def _convert_table_to_rows(self, tab_df: pd.DataFrame) -> List[str]:
        try:
            headers = tab_df.columns.tolist()
            text_list = tab_df.apply(
                lambda row: f"Row {row.name + 1}: "
                + (" | ").join(
                    [
                        "{} = {}".format(
                            str(header).replace("\n", " ").strip(),
                            str(value).replace("\n", " ").strip(),
                        )
                        for header, value in zip(headers, row.astype(str))
                    ]
                ),
                axis=1,
            ).tolist()
            return text_list
        except Exception as e:
            logger.warning(f"An error occurred while converting table to rows: {e}")
            return []

    def _convert_table_to_markdown(self, tab_df: pd.DataFrame) -> str:
        try:
            headers = [
                str(header).replace("\n", " ").strip()
                for header in tab_df.columns.tolist()
            ]
            markdown = "| " + " | ".join(headers) + " |\n"
            markdown += "| " + " | ".join(["---"] * len(headers)) + " |\n"

            for _, row in tab_df.iterrows():
                cleaned_row = [
                    str(cell).replace("\n", " ").strip() for cell in row.astype(str)
                ]
                markdown += "| " + " | ".join(cleaned_row) + " |\n"

            return markdown
        except Exception as e:
            logger.warning(f"An error occurred while converting table to markdown: {e}")
            return ""

    def _extract_tables_from_page(self, page, page_number: int) -> List[str]:
        try:
            rows_or_tables = []
            tables = page.extract_tables()

            for table in tables:
                if not table:
                    continue

                headers = [str(h) if h else "" for h in table[0]]
                data_rows = table[1:] if len(table) > 1 else []
                tab_df = pd.DataFrame(data_rows, columns=headers)

                if tab_df.empty:
                    continue

                tab_df = tab_df.fillna("")
                num_rows = tab_df.shape[0]

                if num_rows <= self.table_rows_threshold:
                    markdown_string = self._convert_table_to_markdown(tab_df)
                    if len(markdown_string) > 0:
                        rows_or_tables.append(markdown_string)
                else:
                    row_strings = self._convert_table_to_rows(tab_df)
                    if len(row_strings) > 0:
                        rows_or_tables.extend(row_strings)

            return rows_or_tables
        except Exception as e:
            logger.warning(
                f"An error occurred while extracting tables from page {page_number} in pdf: {e}"
            )
            return []

    def load(
        self,
        file_path: Union[Path, str],
        metadata: bool = True,
        extra_info: Optional[Dict] = None,
        page_number: Optional[int] = None,
    ) -> List[Document]:
        """Load list of documents from a PDF file."""
        import pypdfium2

        if not isinstance(file_path, str) and not isinstance(file_path, Path):
            raise TypeError("file_path must be a string or Path.")

        documents = []
        plumber_pdf = None
        pdf = None

        try:
            pdf = pypdfium2.PdfDocument(str(file_path))
            total_pages = len(pdf)

            if extra_info:
                if not isinstance(extra_info, dict):
                    raise TypeError("extra_info must be a dictionary.")

            if metadata:
                if not extra_info:
                    extra_info = {}
                extra_info["total_pages"] = total_pages
                extra_info["file_path"] = str(file_path)

            if self.advanced_parsing:
                import pdfplumber
                plumber_pdf = pdfplumber.open(str(file_path))

            if page_number:
                page_indices = [page_number - 1]
            else:
                page_indices = list(range(total_pages))

            for page_idx in page_indices:
                pdf_page = pdf[page_idx]
                textpage = pdf_page.get_textpage()
                page_text = textpage.get_text_bounded() or ""

                documents.append(
                    Document(
                        text=page_text.encode("utf-8"),
                        extra_info=(
                            dict(
                                extra_info,
                                **{"source": f"{page_idx + 1}"},
                            )
                            if metadata
                            else extra_info or {}
                        ),
                    )
                )

                if self.advanced_parsing and plumber_pdf:
                    plumber_page = plumber_pdf.pages[page_idx]
                    table_rows = self._extract_tables_from_page(
                        plumber_page, page_idx + 1
                    )
                    for row in table_rows:
                        documents.append(
                            Document(
                                text=row.encode("utf-8"),
                                extra_info=(
                                    dict(
                                        extra_info,
                                        **{
                                            "source": f"{page_idx + 1}",
                                            "skip_splitter": True,
                                        },
                                    )
                                    if metadata
                                    else extra_info or {}
                                ),
                            )
                        )

        except Exception as e:
            logger.warning(f"An error occurred while processing the PDF file: {e}")

        finally:
            if plumber_pdf:
                plumber_pdf.close()
            if pdf:
                pdf.close()

        return documents

    def load_data(
        self,
        file: Union[Path, str],
        extra_info: Optional[Dict] = None,
        **kwargs,
    ) -> List[Document]:
        """BaseReader interface used by SimpleDirectoryReader."""
        return self.load(file_path=file, extra_info=extra_info)

    def extract_markdown(
        self,
        file_path: Union[Path, str],
        page_range: Optional[tuple] = None,
    ) -> Dict:
        """Extract a PDF to a single markdown string.

        Pages are separated by ``<!-- Page N -->`` headers; tables are rendered
        as markdown (small) or key=value rows (large). ``page_range`` is a
        1-based inclusive (start, end) tuple, or None for all pages. Returns
        ``{"text": <markdown>, "pages": <total_pages>}``.
        """
        import pypdfium2
        import pdfplumber

        pdf = pypdfium2.PdfDocument(str(file_path))
        total_pages = len(pdf)
        parts: List[str] = []

        try:
            with pdfplumber.open(str(file_path)) as plumber_pdf:
                for page_idx in range(total_pages):
                    page_num = page_idx + 1
                    if page_range is not None and (
                        page_num < page_range[0] or page_num > page_range[1]
                    ):
                        continue

                    textpage = pdf[page_idx].get_textpage()
                    text = (textpage.get_text_bounded() or "").strip()
                    tables = self._extract_tables_from_page(
                        plumber_pdf.pages[page_idx], page_num
                    )

                    if not text and not tables:
                        continue

                    parts.append(f"<!-- Page {page_num} -->")
                    if text:
                        parts.append(text)
                    for tbl in tables:
                        parts.append(tbl.strip())
        finally:
            pdf.close()

        return {"text": "\n\n".join(parts).strip(), "pages": total_pages}
