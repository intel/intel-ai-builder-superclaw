"""PowerPoint parser using python-pptx.

Ported from superbuilder pybackend/components/readers/pptx_reader.py.
"""
import logging
from pathlib import Path
from typing import Dict, List, Optional
from fsspec import AbstractFileSystem
from llama_index.core.schema import Document
from llama_index.core.readers.base import BaseReader

logger = logging.getLogger(__name__)


class SuperPptxReader(BaseReader):
    """PowerPoint parser: extracts text and tables per slide.

    Tables have merged cells unmerged and are formatted as header=value rows.
    Each slide becomes a separate Document.
    """

    def __init__(self) -> None:
        self.parser_config = {}

    def _get_headers(self, table):
        try:
            headers = []
            for cell in table.rows[0].cells:
                headers.append(cell.text)
            return headers
        except Exception as e:
            logger.warning(f"An error occurred while getting table headers in pptx: {e}")
            return None

    def _unmerge_table_cells(self, table):
        try:
            for r_idx, row in enumerate(table.rows):
                for c_idx, cell in enumerate(row.cells):
                    if cell.span_width > 1 or cell.span_height > 1:
                        text = cell.text
                        col_span = cell.span_height if cell.span_height else 1
                        row_span = cell.span_width if cell.span_width else 1

                        for i in range(row_span):
                            for j in range(col_span):
                                if i == 0 and j == 0:
                                    continue
                                table.rows[r_idx + j].cells[c_idx + i].text = text
        except Exception as e:
            logger.warning(f"An error occurred while unmerging table cells in pptx: {e}")
            return None
        return table

    def _process_tables(self, table, slide_number):
        self._unmerge_table_cells(table)
        table_headers = self._get_headers(table)
        table_contents = f"Table in slide #{slide_number} : \n"
        for row_num, row in enumerate(table.rows):
            if row_num == 0:
                continue
            row_text = []
            for cell_idx, cell in enumerate(row.cells):
                row_text.append(f"{table_headers[cell_idx]} = {cell.text}")
            table_contents += f"Row {row_num}: {' | '.join(row_text)}\n"

        return table_contents

    def load_data(
        self,
        file: Path,
        extra_info: Optional[Dict] = None,
        fs: Optional[AbstractFileSystem] = None,
        slide_number: Optional[int] = None,
    ) -> List[Document]:
        """Parse file."""
        from pptx import Presentation

        if fs:
            try:
                with fs.open(file) as f:
                    presentation = Presentation(f)
            except Exception as e:
                logger.debug(f"An error occurred while opening the file with fs: {e}")
                raise
        else:
            try:
                presentation = Presentation(file)
            except Exception as e:
                logger.debug(f"An error occurred while opening the file: {e}")
                raise

        if extra_info is None:
            extra_info = {}

        documents = []

        for i, slide in enumerate(presentation.slides):
            if slide_number is not None and i + 1 != slide_number:
                continue
            slide_contents = f"\n\nSlide #{i+1}: \n"
            for shape in slide.shapes:
                # Table processing
                try:
                    if hasattr(shape, "table"):
                        table = shape.table
                        table_contents = self._process_tables(
                            table=table, slide_number=i + 1
                        )
                        documents.append(
                            Document(
                                text=table_contents,
                                extra_info=dict(
                                    extra_info,
                                    **{"skip_splitter": True},
                                    metadata=extra_info or {},
                                ),
                            )
                        )
                except Exception as e:
                    logger.warning(
                        f"An error occurred while processing tables in pptx: {e}, Slide: {i+1}"
                    )

                # Text processing
                if hasattr(shape, "text"):
                    slide_contents += f"{shape.text}\n"

            documents.append(Document(text=slide_contents, metadata=extra_info or {}))

        return documents
