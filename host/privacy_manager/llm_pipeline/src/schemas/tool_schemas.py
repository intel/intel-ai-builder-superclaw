"""
LLM tool schemas for protected file inspection and masking operations.
"""

INSPECT_DATASET_FILE_TOOL_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "inspect_dataset_file",
            "description": (
                "Load and inspect a supported CSV, Excel, or Parquet dataset. Use this tool first when the user provides a file path and you need to understand the dataset structure before selecting or masking columns. "
                "The tool returns file metadata, row counts, column names, Excel sheet names, sample rows, and a human-readable dataset preview."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "source_file_path": {
                        "type": "string",
                        "description": (
                            "Input file path provided by the user. Pass it **exactly** as given. "
                            "DO NOT shorten, rename, normalize, or remove any folder segments. "
                        ),
                    },
                },
                "required": ["source_file_path"],
                "additionalProperties": False,
            },
        },
    }
]


MASK_SENSITIVE_COLUMNS_TOOL_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "mask_sensitive_columns",
            "description": (
                "Mask sensitive or confidential values in selected columns of the given CSV, Excel, or Parquet dataset. "
                "Use this tool after identifying which columns contain PII, PHI, PCI, confidential, or other high-risk data. "
                "The tool replaces original cell values with generated placeholders such as PERSON_NAME_1, CUSTOMER_EMAIL_1, or ACCOUNT_NUMBER_1. "
                "Then saves a masked output file and a JSON mask registry that maps each placeholder back to its original value."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "columns_to_mask": {
                        "type": "array",
                        "description": (
                            "Columns that should be masked. Each item must specify the exact column name and a unique masking category. "
                            "For Excel files, include the exact sheet name from the inspection result."
                        ),
                        "items": {
                            "type": "object",
                            "properties": {
                                "column": {
                                    "type": "string",
                                    "description": (
                                        "Exact column name to mask. Must match a column from the inspected file structure."
                                    ),
                                },
                                "category": {
                                    "type": "string",
                                    "description": (
                                        "UNIQUE uppercase masking category used as the placeholder prefix. "
                                        "DO NOT reuse the same category for another column. "
                                        "USE meaningful category names that clearly reflect the column's content, such as "
                                        "PERSON_NAME, CUSTOMER_EMAIL, PHONE, ACCOUNT_NUMBER, CUSTOMER_ID, ADDRESS, or ORGANIZATION."
                                    ),
                                },
                                "sheet_name": {
                                    "type": ["string", "null"],
                                    "description": (
                                        "Excel sheet name where the column exists. "
                                        "Use null or omit this field for CSV and Parquet files."
                                    ),
                                },
                            },
                            "required": ["column", "category"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["columns_to_mask"],
                "additionalProperties": False,
            },
        },
    },
]
