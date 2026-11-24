"""Tool registry mapping LLM tool-call names to their handler functions."""
from llm_pipeline.src.tools.inspect_dataset_file import (
    inspect_dataset_file,
)
from llm_pipeline.src.tools.mask_sensitive_columns import (
    mask_sensitive_columns,
)

PROTECTED_FILE_PIPELINE_TOOL_REGISTRY = {
    "inspect_dataset_file": inspect_dataset_file,
    "mask_sensitive_columns": mask_sensitive_columns,
}
