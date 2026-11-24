"""Tool for inspecting CSV, Excel, and Parquet dataset files and generating structured previews."""
from pathlib import Path
from typing import Any

import pandas as pd
from llm_pipeline.utils.logger import setup_logger
from llm_pipeline.utils.paths import (
    FileIdentity,
    capture_file_identity,
    resolve_authorized_source_file,
    verify_open_file_identity,
)

SUPPORTED_FILE_TYPES = ("csv", "xls", "xlsx", "xlsm", "parquet")
SAMPLE_ROW_LIMIT = 10

logger = setup_logger(__name__)


def validate_file_path(source_file_path: str) -> dict[str, Any]:
    """
    Validate that a file path points to a supported file.

    Args:
        source_file_path (str): Path to the input file.

    Returns:
        dict[str, Any]: Validation result containing success flag, error details, file path, file name, and file type.
    """
    path = Path(source_file_path)
    file_type = path.suffix.lower().replace(".", "")

    if not path.exists():
        return {
            "success": False,
            "error_message": "Source file not found.",
            "file_path": None,
            "file_name": path.name,
            "file_type": file_type,
        }

    if not path.is_file():
        return {
            "success": False,
            "error_message": "Source is not a regular file.",
            "file_path": None,
            "file_name": path.name,
            "file_type": file_type,
        }

    if file_type not in SUPPORTED_FILE_TYPES:
        return {
            "success": False,
            "error_message": (
                f"Unsupported file type: {file_type}. "
                "Only CSV, Excel, and Parquet files are supported."
            ),
            "file_path": str(path),
            "file_name": path.name,
            "file_type": file_type,
        }

    return {
        "success": True,
        "error_message": None,
        "file_path": str(path),
        "file_name": path.name,
        "file_type": file_type,
    }


def build_file_metadata(source_file_path: str) -> dict[str, str]:
    """
    Build metadata for a supported dataset file.

    Args:
        source_file_path (str): Path to the input file.

    Returns:
        dict[str, str]: File metadata containing path, name, type, and normalized format.
    """
    path = Path(source_file_path)
    file_type = path.suffix.lower().replace(".", "")

    if file_type == "csv":
        file_format = "csv"
    elif file_type in ["xls", "xlsx"]:
        file_format = "excel"
    elif file_type == "parquet":
        file_format = "parquet"
    else:
        file_format = "unsupported"

    return {
        "file_path": str(path),
        "file_name": path.name,
        "file_type": file_type,
        "file_format": file_format,
    }


def build_tabular_summary(dataframe: pd.DataFrame) -> dict[str, Any]:
    """
    Build a summary for a tabular pandas DataFrame.

    Args:
        dataframe (pd.DataFrame): DataFrame to summarize.

    Returns:
        dict[str, Any]: Summary containing row count, column count, column names, and sample rows converted to strings.
    """
    return {
        "row_count": len(dataframe),
        "column_count": len(dataframe.columns),
        "columns": dataframe.columns.tolist(),
        "sample_rows": dataframe.head(SAMPLE_ROW_LIMIT)
        .astype(str)
        .to_dict(orient="records"),
    }


def inspect_csv_file(
    source_file_path: Any,
    file_metadata: dict[str, str],
) -> tuple[pd.DataFrame, dict[str, str], dict[str, Any]]:
    """
    Inspect a CSV file and summarize its structure.

    Args:
        source_file_path (str): Path to the CSV file.
        file_metadata (dict[str, str]): Metadata describing the input file.

    Returns:
        tuple[pd.DataFrame, dict[str, str], dict[str, Any]]: The loaded DataFrame, file metadata, and dataset summary.
    """
    dataframe = pd.read_csv(source_file_path)
    dataset_summary = build_tabular_summary(dataframe)

    return dataframe, file_metadata, dataset_summary


def inspect_parquet_file(
    source_file_path: Any,
    file_metadata: dict[str, str],
) -> tuple[pd.DataFrame, dict[str, str], dict[str, Any]]:
    """
    Inspect a Parquet file and summarize its structure.

    Args:
        source_file_path (str): Path to the Parquet file.
        file_metadata (dict[str, str]): Metadata describing the input file.

    Returns:
        tuple[pd.DataFrame, dict[str, str], dict[str, Any]]: The loaded DataFrame, file metadata, and dataset summary.
    """
    dataframe = pd.read_parquet(source_file_path)
    dataset_summary = build_tabular_summary(dataframe)

    return dataframe, file_metadata, dataset_summary


def inspect_excel_file(
    source_file_path: Any,
    file_metadata: dict[str, str],
) -> tuple[dict[str, pd.DataFrame], dict[str, str], dict[str, Any]]:
    """
    Inspect an Excel workbook and summarize each sheet.

    Args:
        source_file_path (str): Path to the Excel workbook.
        file_metadata (dict[str, str]): Metadata describing the input file.

    Returns:
        tuple[dict[str, pd.DataFrame], dict[str, str], dict[str, Any]]: Loaded sheets keyed by sheet name, file metadata, and workbook summary.
    """
    workbook_sheets = pd.read_excel(source_file_path, sheet_name=None)

    sheet_summaries: dict[str, Any] = {}

    for sheet_name, dataframe in workbook_sheets.items():
        sheet_summaries[sheet_name] = build_tabular_summary(dataframe)

    dataset_summary = {
        "sheet_count": len(workbook_sheets),
        "sheet_names": list(workbook_sheets.keys()),
        "sheets": sheet_summaries,
    }

    return workbook_sheets, file_metadata, dataset_summary


def build_dataset_preview_text(inspected_context: dict[str, Any]) -> str:
    """
    Build a structured dataset preview text based on the inspected file context from a user-given CSV or Excel file.

    Args:
        inspected_context (dict[str, Any]): File metadata and dataset summary returned by an inspection function.

    Returns:
        str: Formatted dataset preview text.
    """
    file_metadata = inspected_context["file_metadata"]
    dataset_summary = inspected_context["dataset_summary"]

    lines: list[str] = []

    lines.append("DATASET PREVIEW")
    lines.append("=" * 60)

    lines.append("\nFILE METADATA")
    lines.append("-" * 60)
    lines.append(f"File Name: {file_metadata.get('file_name')}")
    lines.append(f"File Type: {file_metadata.get('file_type')}")
    lines.append(f"File Format: {file_metadata.get('file_format')}")

    if file_metadata.get("file_format") in ("csv", "parquet"):
        lines.append("\nDATASET SUMMARY")
        lines.append("-" * 60)
        lines.append(f"Row Count: {dataset_summary.get('row_count')}")
        lines.append(f"Column Count: {dataset_summary.get('column_count')}")
        lines.append(f"Columns: {dataset_summary.get('columns')}")

        lines.append("\nSAMPLE ROWS")
        lines.append("-" * 60)

        for index, row in enumerate(dataset_summary.get("sample_rows", []), start=1):
            lines.append(f"Row {index}: {row}")

    elif file_metadata.get("file_format") == "excel":
        lines.append("\nWORKBOOK SUMMARY")
        lines.append("-" * 60)
        lines.append(f"Sheet Count: {dataset_summary.get('sheet_count')}")
        lines.append(f"Sheet Names: {dataset_summary.get('sheet_names')}")

        for sheet_name, sheet_summary in dataset_summary.get("sheets", {}).items():
            lines.append("\n" + "=" * 60)
            lines.append(f"SHEET: {sheet_name}")
            lines.append("=" * 60)
            lines.append(f"Row Count: {sheet_summary.get('row_count')}")
            lines.append(f"Column Count: {sheet_summary.get('column_count')}")
            lines.append(f"Columns: {sheet_summary.get('columns')}")

            lines.append("\nSAMPLE ROWS")
            lines.append("-" * 60)

            for index, row in enumerate(
                sheet_summary.get("sample_rows", []),
                start=1,
            ):
                lines.append(f"Row {index}: {row}")

    return "\n".join(lines)


def inspect_dataset_file(
    source_file_path: str,
    *,
    authorized_source_file_path: str | Path | None = None,
    authorized_source_file_identity: FileIdentity | None = None,
) -> dict[str, Any]:
    """
    Inspect a CSV or Excel file and return data, context, and preview text.

    Args:
        source_file_path (str): Path to the CSV or Excel file.
        authorized_source_file_path: Exact canonical file authorized by the
            integrated Privacy Manager route. When omitted, the standalone
            pipeline remains confined to the default workspace.

    Returns:
        A dict containing:
            - success (bool): Whether the operation succeeded.
            - error_message (Optional[str]): Error details if success is False, else None.
            - data (Optional[pd.DataFrame | dict[str, pd.DataFrame]]): Loaded data — a DataFrame for CSV files, or a dict of sheet name to DataFrame for Excel.
            - inspected_context (Optional[dict]): Dict with two keys:
                - "file_metadata" (dict): file_path, file_name, file_type, file_format.
                - "dataset_summary" (dict): row_count, column_count, columns, sample_rows for CSV; sheet_count, sheet_names, sheets for Excel.
            - dataset_preview (Optional[str]): Human-readable formatted preview of the file.
    """
    try:
        source_file_path = str(
            resolve_authorized_source_file(
                source_file_path,
                authorized_source_file_path,
                authorized_source_file_identity,
            )
        )
        expected_identity = (
            authorized_source_file_identity
            or capture_file_identity(source_file_path)
        )
    except ValueError:
        logger.warning("Rejected dataset path outside the workspace.")
        return {
            "success": False,
            "error_message": "Source file is not an allowed workspace file.",
            "data": None,
            "inspected_context": None,
            "dataset_preview": None,
        }
    validation_result = validate_file_path(source_file_path)

    if not validation_result["success"]:
        logger.warning(
            "File validation failed: %s",
            validation_result["error_message"],
        )
        return {
            "success": False,
            "error_message": validation_result["error_message"],
            "data": None,
            "inspected_context": None,
            "dataset_preview": None,
        }

    file_metadata = build_file_metadata(validation_result["file_path"])

    try:
        with Path(source_file_path).open("rb") as source_file:
            verify_open_file_identity(source_file, expected_identity)
            if file_metadata["file_format"] == "csv":
                loaded_data, file_metadata, dataset_summary = inspect_csv_file(
                    source_file,
                    file_metadata,
                )
                logger.info(
                    "Inspected CSV file '%s': %d row(s), %d column(s).",
                    file_metadata["file_name"],
                    dataset_summary["row_count"],
                    dataset_summary["column_count"],
                )

            elif file_metadata["file_format"] == "parquet":
                loaded_data, file_metadata, dataset_summary = inspect_parquet_file(
                    source_file,
                    file_metadata,
                )
                logger.info(
                    "Inspected Parquet file '%s': %d row(s), %d column(s).",
                    file_metadata["file_name"],
                    dataset_summary["row_count"],
                    dataset_summary["column_count"],
                )

            elif file_metadata["file_format"] == "excel":
                loaded_data, file_metadata, dataset_summary = inspect_excel_file(
                    source_file,
                    file_metadata,
                )
                logger.info(
                    "Inspected Excel file '%s': %d sheet(s).",
                    file_metadata["file_name"],
                    dataset_summary["sheet_count"],
                )

            else:
                return {
                    "success": False,
                    "error_message": (
                        f"Unsupported file type: {file_metadata['file_type']}. "
                        "Only CSV, Excel, and Parquet files are supported."
                    ),
                    "data": None,
                    "inspected_context": None,
                    "dataset_preview": None,
                }
            verify_open_file_identity(source_file, expected_identity)

        inspected_context = {
            "file_metadata": file_metadata,
            "dataset_summary": dataset_summary,
        }
        dataset_preview = build_dataset_preview_text(inspected_context)

        logger.debug("Dataset preview returned to the model:\n{}", dataset_preview)

        return {
            "success": True,
            "error_message": None,
            "data": loaded_data,
            "inspected_context": inspected_context,
            "dataset_preview": dataset_preview,
        }

    except Exception as error:
        logger.error("Inspection failed. error_type={}", type(error).__name__)
        return {
            "success": False,
            "error_message": "Source file could not be inspected.",
            "data": None,
            "inspected_context": None,
            "dataset_preview": None,
        }
