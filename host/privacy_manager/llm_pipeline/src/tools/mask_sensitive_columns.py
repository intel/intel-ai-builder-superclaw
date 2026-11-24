"""Tool for masking sensitive columns in CSV, Excel, and Parquet files and saving a reversible value registry."""
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Set, Tuple

import pandas as pd
from llm_pipeline.utils.logger import setup_logger
from llm_pipeline.utils.paths import (
    WORKSPACE_ROOT,
    FileIdentity,
    capture_file_identity,
    reject_reparse_components,
    resolve_authorized_source_file,
    verify_open_file_identity,
)
from llm_pipeline.utils.registry_io import write_registry_json

logger = setup_logger(__name__)

# Support format for PII Protected Masking
SUPPORTED_EXCEL_EXTENSIONS = (".xlsx", ".xls", ".xlsm")

HYBRID_CODING_WORKSPACE = WORKSPACE_ROOT / "data_protection_workspace"


def generate_timestamp() -> str:
    """
    Generate a timestamp string for output file and registry naming.

    Uses local system time so the folder name matches the wall clock the user
    sees. Must stay on the same clock as DPS's
    ``build_workspace_masked_output_path``; if the two writers disagreed, a
    hybrid-mode DPS-then-LLM fallback could land the two attempts in two
    different timestamped folders under ``masked_datasets/``.

    Returns:
        str: Timestamp formatted as ``YYYYMMDD_HHMMSS``.
    """
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def generate_masked_dataset_folder_path(source_file_path: Path, timestamp: str) -> Path:
    """
    Generate the output folder path for masked files under the hybrid coding workspace.

    Args:
        source_file_path (Path): Path to the source file.
        timestamp (str): Timestamp string formatted as ``YYYYMMDD_HHMMSS``.

    Returns:
        Path: e.g. ``workspace/data_protection_workspace/masked_datasets/customers/20260615_112233/``.
    """
    return HYBRID_CODING_WORKSPACE / "masked_datasets" / source_file_path.stem / timestamp


def generate_registry_folder_path(source_file_path: Path, timestamp: str) -> Path:
    """
    Generate the output folder path for mask registry JSON files under the hybrid coding workspace.

    Args:
        source_file_path (Path): Path to the source file.
        timestamp (str): Timestamp string formatted as ``YYYYMMDD_HHMMSS``.

    Returns:
        Path: e.g. ``workspace/data_protection_workspace/mask_registries/customers/20260615_112233/``.
    """
    return HYBRID_CODING_WORKSPACE / "mask_registries" / source_file_path.stem / timestamp


def generate_masked_output_path(
    source_file_path: Path, output_folder_path: Path
) -> Path:
    """
    Generate the masked output file path inside the output folder.

    Args:
        source_file_path (Path): Path to the original source file.
        output_folder_path (Path): Path to the timestamped output folder.

    Returns:
        Path: Path to the masked output file, e.g. ``customers_20260615_112233/customers_masked.csv``.

    Raises:
        ValueError: If the file extension is not supported.
    """
    file_stem = source_file_path.stem
    file_extension = source_file_path.suffix.lower()

    if file_extension == ".csv":
        return output_folder_path / f"{file_stem}_masked.csv"

    if file_extension == ".parquet":
        return output_folder_path / f"{file_stem}_masked.parquet"

    if file_extension in SUPPORTED_EXCEL_EXTENSIONS:
        return output_folder_path / f"{file_stem}_masked{file_extension}"

    raise ValueError(f"Unsupported file extension: {file_extension}")


def generate_mask_registry_path(
    source_file_path: Path, output_folder_path: Path
) -> Path:
    """
    Generate the mask registry JSON file path inside the output folder.

    Args:
        source_file_path (Path): Path to the original source file.
        output_folder_path (Path): Path to the timestamped output folder.

    Returns:
        Path: Path to the registry JSON file, e.g. ``customers_20260615_112233/customers_mask_registry.json``.
    """
    file_stem = source_file_path.stem
    return output_folder_path / f"{file_stem}_mask_registry.json"


def save_masked_value_registry(
    masked_value_registry: Dict[str, str],
    registry_output_path: Path,
) -> None:
    """
    Save the masked value registry to a JSON file.

    Args:
        masked_value_registry (Dict[str, str]): Mapping of placeholder keys to their original values.
        registry_output_path (Path): Destination path for the registry JSON file.

    Raises:
        OSError: If the file cannot be opened or written.
    """
    write_registry_json(masked_value_registry, registry_output_path, indent=4)


def create_placeholder_mapping(
    values: pd.Series,
    category: str,
    start_index: int,
) -> Tuple[Dict[Any, str], Dict[str, str], int]:
    """
    Create placeholder mappings for a column's unique values, e.g. mapping "John Doe" to "PERSON_1".

    Args:
        values (pd.Series): Column values to map; NaN values are ignored.
        category (str): Placeholder prefix, e.g. ``"NAME"``.
        start_index (int): Starting integer for placeholder suffixes.

    Returns:
        Tuple[Dict[Any, str], Dict[str, str], int]: A 3-tuple of:
            - original_to_placeholder: maps original values to placeholders.
            - placeholder_to_original: maps placeholders back to original values.
            - next_index: the next available placeholder index.
    """
    original_value_to_placeholder: Dict[Any, str] = {}
    placeholder_to_original_value: Dict[str, str] = {}
    current_index = start_index

    unique_values = values.dropna().unique()

    for original_value in unique_values:
        placeholder = f"<{category}_{current_index}>"

        original_value_to_placeholder[original_value] = placeholder
        placeholder_to_original_value[placeholder] = str(original_value)

        current_index += 1

    return original_value_to_placeholder, placeholder_to_original_value, current_index


# A compliance-domain word says nothing about what a column holds, so a
# placeholder built from one (``<PII_1>``) is unreadable downstream. The model is
# asked for a specific category but frequently answers with one of these.
_GENERIC_CATEGORIES = frozenset({
    "PII", "PHI", "PCI", "SPI", "GDPR", "HIPAA",
    "SENSITIVE", "CONFIDENTIAL", "PRIVATE", "PERSONAL", "SECRET",
    "DATA", "VALUE", "FIELD", "COLUMN", "MASK", "MASKED", "REDACTED", "UNKNOWN",
})

# Restore matches ``<CATEGORY_N>`` with a letters/underscore category, so digits
# and punctuation must never reach the placeholder prefix.
_NON_LETTER_RE = re.compile(r"[^A-Za-z]+")

_FALLBACK_CATEGORY = "FIELD"


def derive_category_from_column(column_name: Any) -> str:
    """
    Build an uppercase, letters-only placeholder category from a column name.

    Args:
        column_name (Any): Source column name, e.g. ``"contact_email"``.

    Returns:
        str: Category such as ``"CONTACT_EMAIL"``, or ``"FIELD"`` when the name
        carries no letters.
    """
    slug = _NON_LETTER_RE.sub("_", str(column_name)).strip("_").upper()
    return slug or _FALLBACK_CATEGORY


def resolve_placeholder_category(
    requested_category: Any,
    column_name: Any,
    used_categories: Set[str],
) -> str:
    """
    Pick the placeholder category for one column: specific, and unique per file.

    Falls back to the column name whenever the model supplied nothing or a
    generic compliance word. Uniqueness matters beyond readability: the
    placeholder counter restarts per column, so two columns sharing a category
    would emit the same ``<CATEGORY_1>`` and overwrite each other in the registry.

    Args:
        requested_category (Any): ``category`` from the model's masking config.
        column_name (Any): Column being masked, used to derive a specific name.
        used_categories (Set[str]): Categories already assigned for this file.

    Returns:
        str: An uppercase, letters-only category not present in ``used_categories``.
    """
    candidate = _NON_LETTER_RE.sub("_", str(requested_category or "")).strip("_").upper()
    if not candidate or candidate in _GENERIC_CATEGORIES:
        candidate = derive_category_from_column(column_name)

    if candidate not in used_categories:
        return candidate

    column_candidate = derive_category_from_column(column_name)
    if column_candidate not in used_categories:
        return column_candidate

    unique = candidate
    suffix = ""
    while unique in used_categories:
        suffix += "X"
        unique = f"{candidate}_{suffix}"
    return unique


def mask_dataframe_columns(
    dataframe: pd.DataFrame,
    columns_to_mask: List[Dict[str, Any]],
    masked_value_registry: Dict[str, str],
    placeholder_start_index: int = 1,
) -> List[Dict[str, Any]]:
    """
    Mask selected columns in a DataFrame in-place.

    Args:
        dataframe (pd.DataFrame): DataFrame to mutate.
        columns_to_mask (List[Dict[str, Any]]): Masking configs, each with ``column`` (str) and optional ``category`` (str).
        masked_value_registry (Dict[str, str]): Registry updated in-place with placeholder-to-original mappings.
        placeholder_start_index (int): Starting index for placeholder values. Defaults to 1.

    Returns:
        List[Dict[str, Any]]: The masking configs that were actually applied, each with ``column`` and ``category``.
    """
    applied_columns: List[Dict[str, Any]] = []
    used_categories: Set[str] = set()

    for masking_config in columns_to_mask:
        placeholder_index = placeholder_start_index
        column_name = masking_config.get("column")

        if not column_name:
            continue

        if column_name not in dataframe.columns:
            continue

        data_category = resolve_placeholder_category(
            masking_config.get("category"), column_name, used_categories
        )
        used_categories.add(data_category)
        value_to_placeholder, placeholder_to_value, placeholder_index = (
            create_placeholder_mapping(
                values=dataframe[column_name],
                category=data_category,
                start_index=placeholder_index,
            )
        )

        if not value_to_placeholder:
            continue

        masked_value_registry.update(placeholder_to_value)

        dataframe[column_name] = (
            dataframe[column_name]
            .map(value_to_placeholder)
            .fillna(dataframe[column_name])
        )

        applied_columns.append({"column": column_name, "category": data_category})

    return applied_columns


def resolve_target_sheets(
    workbook_sheets: Dict[str, pd.DataFrame],
    requested_sheet_name: Any,
    column_name: str,
) -> List[str]:
    """
    Resolve which sheets a masking config should apply to.

    A weak model may omit ``sheet_name`` for Excel files, so fall back to resolving
    the target sheet from the column instead of skipping the config entirely.

    Args:
        workbook_sheets (Dict[str, pd.DataFrame]): Sheets keyed by sheet name.
        requested_sheet_name (Any): Sheet name from the masking config, may be None or missing.
        column_name (str): Column the config wants to mask.

    Returns:
        List[str]: Sheet names to apply the masking config to.
            - An explicitly named, existing sheet is honored as-is.
            - When the sheet name is missing/invalid and there is a single sheet, that sheet is used.
            - Otherwise every sheet that contains ``column_name`` is targeted.
    """
    if requested_sheet_name and requested_sheet_name in workbook_sheets:
        return [requested_sheet_name]

    if len(workbook_sheets) == 1:
        return list(workbook_sheets.keys())

    return [
        sheet_name
        for sheet_name, sheet_dataframe in workbook_sheets.items()
        if column_name in sheet_dataframe.columns
    ]


def mask_excel_columns(
    workbook_sheets: Dict[str, pd.DataFrame],
    columns_to_mask: List[Dict[str, Any]],
    masked_value_registry: Dict[str, str],
) -> List[Dict[str, Any]]:
    """
    Mask selected columns across Excel sheets in-place.

    Args:
        workbook_sheets (Dict[str, pd.DataFrame]): Sheets keyed by sheet name.
        columns_to_mask (List[Dict[str, Any]]): Masking configs, each with ``column`` (str), optional ``category`` (str),
            and optional ``sheet_name`` (str). When ``sheet_name`` is missing, the target sheet is resolved from the column.
        masked_value_registry (Dict[str, str]): Registry updated in-place with placeholder-to-original mappings.

    Returns:
        List[Dict[str, Any]]: The masking configs that were actually applied, each with ``column``,
            ``category``, and the resolved ``sheet_name``.
    """
    applied_columns: List[Dict[str, Any]] = []

    for masking_config in columns_to_mask:
        column_name = masking_config.get("column")
        data_category = (masking_config.get("category") or "PII").upper()

        if not column_name:
            continue

        target_sheets = resolve_target_sheets(
            workbook_sheets=workbook_sheets,
            requested_sheet_name=masking_config.get("sheet_name"),
            column_name=column_name,
        )

        for sheet_name in target_sheets:
            sheet_dataframe = workbook_sheets[sheet_name]

            if column_name not in sheet_dataframe.columns:
                continue

            value_to_placeholder, placeholder_to_value, _ = create_placeholder_mapping(
                values=sheet_dataframe[column_name],
                category=data_category,
                start_index=1,
            )

            if not value_to_placeholder:
                continue

            masked_value_registry.update(placeholder_to_value)

            sheet_dataframe[column_name] = (
                sheet_dataframe[column_name]
                .map(value_to_placeholder)
                .fillna(sheet_dataframe[column_name])
            )

            workbook_sheets[sheet_name] = sheet_dataframe
            applied_columns.append(
                {
                    "column": column_name,
                    "category": data_category,
                    "sheet_name": sheet_name,
                }
            )

    return applied_columns


def mask_sensitive_columns(
    source_file_path: str,
    file_format: Literal["csv", "xlsx", "xls", "xlsm", "parquet"],
    columns_to_mask: List[Dict[str, Any]],
    *,
    authorized_source_file_path: str | Path | None = None,
    authorized_source_file_identity: FileIdentity | None = None,
) -> Dict[str, Any]:
    """
    Mask sensitive columns in a CSV, Excel, or Parquet file and save the registry into a JSON file.

    Args:
        source_file_path (str): Path to the source CSV, Excel, or Parquet file.
        file_format (Literal["csv", "xlsx", "xls", "xlsm", "parquet"]): Format of the source file.

        columns_to_mask (List[Dict[str, Any]]): Masking configuration dicts.
            CSV/Parquet format — each dict requires:
                - ``column`` (str): Column name to mask.
                - ``category`` (str, optional): Placeholder prefix, e.g. ``"PERSON"``. Defaults to ``"PII"``.

            Excel format — each dict requires:
                - ``sheet_name`` (str): Sheet containing the column.
                - ``column`` (str): Column name to mask.
                - ``category`` (str, optional): Placeholder prefix. Defaults to ``"PII"``.

        authorized_source_file_path: Exact canonical file authorized by the
            integrated Privacy Manager route. When omitted, the standalone
            pipeline remains confined to the default workspace.

    Returns:
        A dict containing:
            - success (bool): Whether the operation succeeded.
            - error_message (Optional[str]): Error details if success is False, else None.
            - masked_file_path (Optional[str]): Path to the masked output file.
            - registry_file_path (Optional[str]): Path to the mask registry JSON file.
            - source_file_path (str): Resolved path to the source file.
            - source_file_name (str): Name of the source file.
            - file_format (str): Normalized file format used.
    """
    try:
        source_file_path = resolve_authorized_source_file(
            str(source_file_path),
            authorized_source_file_path,
            authorized_source_file_identity,
        )
        expected_identity = (
            authorized_source_file_identity
            or capture_file_identity(source_file_path)
        )
        normalized_file_format = source_file_path.suffix.lower().removeprefix(".")
        if file_format.lower() != normalized_file_format:
            raise ValueError("File format does not match the source file.")
        timestamp = generate_timestamp()
        masked_value_registry: Dict[str, str] = {}
        applied_columns: List[Dict[str, Any]] = []

        masked_dataset_folder = generate_masked_dataset_folder_path(
            source_file_path=source_file_path, timestamp=timestamp
        )
        registry_folder = generate_registry_folder_path(
            source_file_path=source_file_path, timestamp=timestamp
        )

        masked_output_file_path = generate_masked_output_path(
            source_file_path=source_file_path, output_folder_path=masked_dataset_folder
        )

        registry_output_path = generate_mask_registry_path(
            source_file_path=source_file_path, output_folder_path=registry_folder
        )

        reject_reparse_components(masked_output_file_path)
        reject_reparse_components(registry_output_path)
        masked_dataset_folder.mkdir(parents=True, exist_ok=True)
        registry_folder.mkdir(parents=True, exist_ok=True)

        with source_file_path.open("rb") as source_file:
            verify_open_file_identity(source_file, expected_identity)

            # Mask CSV file
            if normalized_file_format == "csv":
                dataframe = pd.read_csv(source_file)

                applied_columns = mask_dataframe_columns(
                    dataframe=dataframe,
                    columns_to_mask=columns_to_mask,
                    masked_value_registry=masked_value_registry,
                )

                verify_open_file_identity(source_file, expected_identity)
                dataframe.to_csv(masked_output_file_path, index=False)

            # Mask Parquet file
            elif normalized_file_format == "parquet":
                dataframe = pd.read_parquet(source_file)

                applied_columns = mask_dataframe_columns(
                    dataframe=dataframe,
                    columns_to_mask=columns_to_mask,
                    masked_value_registry=masked_value_registry,
                )

                verify_open_file_identity(source_file, expected_identity)
                dataframe.to_parquet(masked_output_file_path, index=False)

            # Mask Excel file
            elif normalized_file_format in ("xlsx", "xls", "xlsm"):
                workbook_sheets = pd.read_excel(source_file, sheet_name=None)

                applied_columns = mask_excel_columns(
                    workbook_sheets=workbook_sheets,
                    columns_to_mask=columns_to_mask,
                    masked_value_registry=masked_value_registry,
                )

                verify_open_file_identity(source_file, expected_identity)
                with pd.ExcelWriter(masked_output_file_path, engine="openpyxl") as writer:
                    for sheet_name, sheet_dataframe in workbook_sheets.items():
                        sheet_dataframe.to_excel(writer, sheet_name=sheet_name, index=False)
            else:
                raise ValueError(f"Unsupported file format: {file_format}")

        save_masked_value_registry(
            masked_value_registry=masked_value_registry,
            registry_output_path=registry_output_path,
        )
        logger.debug(
            "Masked columns written to the registry: {}",
            sorted({str(masking_config["column"]) for masking_config in applied_columns}),
        )

        return {
            "success": True,
            "error_message": None,
            "masked_columns": columns_to_mask,
            "masked_file_path": str(masked_output_file_path),
            "registry_file_path": str(registry_output_path),
            "source_file_path": str(source_file_path),
            "source_file_name": source_file_path.name,
            "file_format": normalized_file_format,
        }

    except Exception as error:
        logger.error("Masking failed. error_type={}", type(error).__name__)
        return {
            "success": False,
            "error_message": "Source file could not be masked.",
            "masked_file_path": None,
            "registry_file_path": None,
            "masked_columns": None,
            "source_file_path": None,
            "source_file_name": None,
            "file_format": file_format,
        }
