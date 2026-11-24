"""CSV parser using pandas.

Ported from superbuilder pybackend/components/readers/csv_reader.py.
"""
import logging
from pathlib import Path
from typing import Dict, List, Optional
from fsspec import AbstractFileSystem

import pandas as pd
from llama_index.core.schema import Document
from llama_index.core.readers.base import BaseReader

logger = logging.getLogger(__name__)


class SuperPandasCSVReader(BaseReader):
    """Pandas-based CSV parser.

    Each row becomes a separate Document with column headers prepended.
    Auto-detects separator via pandas. Falls back to plain text on parse errors.
    """

    def __init__(self, concat_rows: bool = False, col_joiner: str = " | ", pandas_config: Optional[Dict] = None):
        self._concat_rows = concat_rows
        self._col_joiner = col_joiner
        self._row_joiner = "\n"
        self._pandas_config = pandas_config or {}

    def load_data(
        self,
        file: Path,
        extra_info: Optional[Dict] = None,
        fs: Optional[AbstractFileSystem] = None,
    ) -> List[Document]:
        """Parse file."""
        try:
            if fs:
                with fs.open(file) as f:
                    df = pd.read_csv(f, **self._pandas_config)
            else:
                df = pd.read_csv(file, **self._pandas_config)
        except Exception as e:
            logger.warning(f"An error occurred while reading the file {file}: {e}")
            logger.warning(
                "Fallback to read the CSV file as plain text. "
                "Please verify the file format and content structure."
            )
            try:
                # Fallback: read as plain text
                text = Path(file).read_text(errors="replace")
                return [Document(text=text, metadata=extra_info or {})]
            except Exception as e2:
                logger.warning(f"Fallback also failed for {file}: {e2}")
                return []

        try:
            headers = df.columns.tolist()

            text_list = df.apply(
                lambda row: f"Row {row.name + 1}: "
                + (self._col_joiner).join(
                    [
                        f"{header} = {value}"
                        for header, value in zip(headers, row.astype(str))
                    ]
                ),
                axis=1,
            ).tolist()

            if not self._concat_rows:
                if extra_info:
                    extra_info["skip_splitter"] = True
                else:
                    extra_info = {"skip_splitter": True}

            if self._concat_rows:
                return [
                    Document(
                        text=(self._row_joiner).join(text_list),
                        metadata=extra_info or {},
                    )
                ]
            else:
                return [
                    Document(text=text, metadata=extra_info or {}) for text in text_list
                ]
        except Exception as e:
            logger.warning(f"An error occurred while processing CSV {file}: {e}")
            return []
