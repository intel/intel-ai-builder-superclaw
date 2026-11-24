"""Excel parser using openpyxl + pandas.

Ported from superbuilder pybackend/components/readers/xlsx_reader.py.
"""
import logging
import importlib
from pathlib import Path
from typing import Dict, List, Optional
from fsspec import AbstractFileSystem

import pandas as pd
from llama_index.core.schema import Document
from llama_index.core.readers.base import BaseReader

logger = logging.getLogger(__name__)


class SuperPandasExcelReader(BaseReader):
    """Pandas-based Excel parser.

    Each row becomes a separate Document with column headers prepended.
    Supports multiple sheets.
    """

    def __init__(self, concat_rows: bool = False, sheet_name=None, pandas_config: Optional[Dict] = None):
        self._concat_rows = concat_rows
        self._sheet_name = sheet_name
        self._pandas_config = pandas_config or {}

    def load_data(
        self,
        file: Path,
        extra_info: Optional[Dict] = None,
        fs: Optional[AbstractFileSystem] = None,
    ) -> List[Document]:
        """Parse file."""
        openpyxl_spec = importlib.util.find_spec("openpyxl")
        if openpyxl_spec is None:
            raise ImportError(
                "Please install openpyxl to read Excel files: `pip install openpyxl`"
            )

        try:
            if fs:
                with fs.open(file) as f:
                    dfs = pd.read_excel(f, self._sheet_name, **self._pandas_config)
            else:
                dfs = pd.read_excel(file, self._sheet_name, **self._pandas_config)
        except Exception as e:
            logger.warning(f"An error occurred while reading the file {file}: {e}")
            return []

        documents = []

        try:
            if not self._concat_rows:
                if extra_info:
                    extra_info["skip_splitter"] = True
                else:
                    extra_info = {"skip_splitter": True}

            if isinstance(dfs, pd.DataFrame):
                df = dfs.fillna("")
                headers = df.columns.tolist()

                text_list = df.apply(
                    lambda row: f"Row {row.name + 1}: "
                    + " | ".join(
                        [
                            f"{header} = {value}"
                            for header, value in zip(headers, row.astype(str))
                        ]
                    ),
                    axis=1,
                ).tolist()

                if self._concat_rows:
                    documents.append(
                        Document(text="\n".join(text_list), metadata=extra_info or {})
                    )
                else:
                    documents.extend(
                        [
                            Document(text=text, metadata=extra_info or {})
                            for text in text_list
                        ]
                    )
            else:
                for sheet_name, df in dfs.items():
                    try:
                        if df.empty:
                            logger.info(f"Skipping empty sheet: {sheet_name}")
                            continue

                        df = df.fillna("")
                        headers = df.columns.tolist()

                        text_list = df.apply(
                            lambda row: f"Row {row.name + 1}: "
                            + " | ".join(
                                [
                                    f"{header} = {value}"
                                    for header, value in zip(headers, row.astype(str))
                                ]
                            ),
                            axis=1,
                        ).tolist()

                        sheet_extra = dict(extra_info or {})
                        sheet_extra["sheet_name"] = sheet_name

                        if self._concat_rows:
                            documents.append(
                                Document(
                                    text="\n".join(text_list), metadata=sheet_extra
                                )
                            )
                        else:
                            documents.extend(
                                [
                                    Document(text=text, metadata=sheet_extra)
                                    for text in text_list
                                ]
                            )
                    except Exception as e:
                        logger.debug(
                            f"An error occurred while processing sheet {sheet_name}: {e}"
                        )

            return documents

        except Exception as e:
            logger.warning(
                f"An error occurred while processing the excel file {file}: {e}"
            )
            return []
