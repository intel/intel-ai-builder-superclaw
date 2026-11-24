import logging
from typing import Dict, List, Optional
from pathlib import Path
from fsspec import AbstractFileSystem
from llama_index.core.readers.base import BaseReader
from llama_index.core.schema import Document
from docx.table import Table

logger = logging.getLogger(__name__)


class SuperDocxReader(BaseReader):
    """Docx parser using python-docx for structured extraction.

    Preserves paragraph text and tables (converted to Markdown).
    Ported from superbuilder pybackend/components/readers/docx_reader.py.
    """

    def __init__(self, table_rows_threshold=10):
        self.table_rows_threshold = table_rows_threshold

    def _process_texts(self, docx_document):
        try:
            text = ""
            for paragraph in docx_document.paragraphs:
                text += paragraph.text + "\n"
            return text
        except Exception as e:
            logger.warning(f"An error occurred while processing texts in docx: {e}")
            return None

    def _process_tables(self, docx_document) -> List[str]:
        try:
            rows = []
            for table in docx_document.tables:
                headers = []
                table_description = self._get_previous_text_of_table(table)

                if len(table.rows) <= self.table_rows_threshold:
                    markdown_table = self._convert_table_to_markdown(table)
                    rows.append(
                        f"Table description: {table_description} \n Table: \n {markdown_table}"
                    )
                else:
                    for i, row in enumerate(table.rows):
                        if i == 0:
                            headers = [
                                cell.text.replace("\n", " ").strip()
                                for cell in row.cells
                            ]
                            continue
                        row_text = (
                            f"Table description: {table_description} \n Row {i} : "
                        )
                        for j, cell in enumerate(row.cells):
                            cell_text = cell.text.replace("\n", " ").strip()
                            row_text += f"{headers[j]} = {cell_text} | "
                        rows.append(row_text)
            return rows
        except Exception as e:
            logger.warning(f"An error occurred while processing tables in docx: {e}")
            return None

    def _convert_table_to_markdown(self, table):
        try:
            markdown = ""
            headers = [
                cell.text.replace("\n", " ").strip() for cell in table.rows[0].cells
            ]
            markdown += " | " + " | ".join(headers) + " | \n"
            markdown += " | " + " | ".join(["---"] * len(headers)) + " | \n"
            for row in table.rows[1:]:
                row_cells = [cell.text.replace("\n", " ").strip() for cell in row.cells]
                markdown += " | " + " | ".join(row_cells) + " | \n"
            return markdown
        except Exception as e:
            logger.warning(f"An error occurred while converting table to markdown: {e}")
            return ""

    def _get_previous_text_of_table(self, table: Table) -> str:
        try:
            parent_element = table._element.getparent()
            table_index = list(parent_element).index(table._element)
            previous_element = parent_element[table_index - 1]
            if previous_element.tag.endswith("p"):
                previous_paragraph = previous_element.text
                return previous_paragraph
        except Exception as e:
            logger.warning(
                f"An error occurred while getting the text before the table: {e}"
            )
        return ""

    def load_data(
        self,
        file: Path,
        extra_info: Optional[Dict] = None,
        fs: Optional[AbstractFileSystem] = None,
    ) -> List[Document]:
        """Parse file."""
        if not isinstance(file, Path):
            file = Path(file)

        try:
            from docx import Document as DocxDocument
        except ImportError:
            raise ImportError(
                "python-docx is required to read Microsoft Word files: "
                "`pip install python-docx`"
            )

        if extra_info is None:
            extra_info = {}

        documents = []

        metadata = {"file_name": file.name}
        if extra_info is not None:
            metadata.update(extra_info)

        docx_document = DocxDocument(file)

        # Process Texts
        try:
            text = self._process_texts(docx_document)
            if text:
                documents.append(Document(text=text, metadata=metadata))
            else:
                logger.warning("No text was extracted from the docx document.")
        except Exception as e:
            logger.warning(f"An error occurred while processing texts in docx: {e}")

        # Process Tables
        try:
            table_rows = self._process_tables(docx_document)
            if table_rows:
                for row in table_rows:
                    document = Document(
                        text=row,
                        extra_info=dict(
                            extra_info,
                            **{"skip_splitter": True},
                            metadata=metadata or {},
                        ),
                    )
                    documents.append(document)
        except Exception as e:
            logger.warning(f"An error occurred while processing tables in docx: {e}")

        return documents
