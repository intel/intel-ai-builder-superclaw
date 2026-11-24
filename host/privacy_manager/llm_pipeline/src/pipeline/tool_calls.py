"""
Utilities for parsing, executing, and responding to LLM tool calls.
"""

import json
from typing import Any, Dict, List, Literal

from pydantic import BaseModel, ConfigDict, StrictStr, ValidationError

from llm_pipeline.src.pipeline.registry import PROTECTED_FILE_PIPELINE_TOOL_REGISTRY
from llm_pipeline.utils.logger import setup_logger
from llm_pipeline.utils.paths import FileIdentity

logger = setup_logger(__name__)
from llm_pipeline.src.schemas.responses import FinalResponse


class _InspectArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    source_file_path: StrictStr


class _MaskColumn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    column: StrictStr
    category: StrictStr
    sheet_name: StrictStr | None = None


class _MaskArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    source_file_path: StrictStr
    file_format: Literal["csv", "xlsx", "xls", "xlsm", "parquet"]
    columns_to_mask: list[_MaskColumn]


class _MaskDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    columns_to_mask: list[_MaskColumn]


_TOOL_ARGUMENT_MODELS: dict[str, type[BaseModel]] = {
    "inspect_dataset_file": _InspectArguments,
    "mask_sensitive_columns": _MaskArguments,
}


def extract_tool_calls(assistant_message: Any) -> List[Any]:
    """
    Extract tool calls from an assistant message.

    Args:
        assistant_message (Any): Assistant response returned by the LLM client.

    Returns:
        List[Any]: Tool-call entries from the assistant message, or an empty list when no tool calls are present.

    Examples:
        >>> assistant_message = {
        ...     "content": "",
        ...     "role": "assistant",
        ...     "tool_calls": [
        ...         {
        ...             "function": {
        ...                 "arguments": "{<tool_arguments>}",
        ...                 "name": "<tool_name>",
        ...             },
        ...             "id": "<tool_call_id>",
        ...             "type": "function",
        ...         }
        ...     ],
        ... }
        >>> extract_tool_calls(assistant_message)
        [{'function': {'arguments': '{<tool_arguments>}', 'name': '<tool_name>'}, 'id': '<tool_call_id>', 'type': 'function'}]
    """
    if isinstance(assistant_message, dict):
        return assistant_message.get("tool_calls") or []

    if hasattr(assistant_message, "tool_calls"):
        return getattr(assistant_message, "tool_calls") or []

    return []


def parse_tool_arguments(raw_arguments: Any) -> Dict[str, Any]:
    """
    Parse raw tool-call arguments into a dictionary.

    Args:
        raw_arguments (Any): Raw argument payload from the tool call.

    Returns:
        Dict[str, Any]: Parsed tool arguments ready to pass to the selected tool function.

    Examples:
        >>> raw_arguments = '{"source_file_path": "<file_path>"}'
        >>> parse_tool_arguments(raw_arguments)
        {'source_file_path': '<file_path>'}

    Raises:
        json.JSONDecodeError: If ``raw_arguments`` is a non-empty string that is not valid JSON.
        ValueError: If ``raw_arguments`` is not a supported type.
    """
    if raw_arguments is None:
        return {}

    if isinstance(raw_arguments, dict):
        return raw_arguments

    # Convert a JSON string payload to a dictionary.
    if isinstance(raw_arguments, str):
        if not raw_arguments.strip():
            return {}

        parsed_arguments = json.loads(raw_arguments)
        if not isinstance(parsed_arguments, dict):
            raise ValueError("Tool arguments must be a JSON object.")
        return parsed_arguments

    raise ValueError(f"Unsupported tool arguments type: {type(raw_arguments)}")


def _validate_tool_arguments(tool_name: str, tool_arguments: Any) -> Dict[str, Any]:
    argument_model = _TOOL_ARGUMENT_MODELS.get(tool_name)
    if argument_model is None:
        raise ValueError(f"Unknown tool requested: {tool_name}")
    try:
        return argument_model.model_validate(tool_arguments).model_dump(exclude_none=True)
    except ValidationError as exc:
        raise ValueError(f"Invalid arguments for tool: {tool_name}") from exc


def validate_masking_function_call(
    function_detail: Dict[str, Any],
    *,
    source_file_path: str,
    file_format: str,
) -> Dict[str, Any]:
    """Validate a masking call and bind it to trusted workflow state."""
    if function_detail.get("tool_name") != "mask_sensitive_columns":
        raise ValueError("Unexpected tool requested during masking.")

    try:
        decision = _MaskDecision.model_validate(
            function_detail.get("tool_arguments")
        ).model_dump(exclude_none=True)
    except ValidationError as exc:
        raise ValueError("Invalid arguments for tool: mask_sensitive_columns") from exc

    return {
        "tool_id": function_detail.get("tool_id"),
        "tool_name": "mask_sensitive_columns",
        "tool_arguments": {
            "source_file_path": source_file_path,
            "file_format": file_format,
            "columns_to_mask": decision["columns_to_mask"],
        },
    }


def extract_function_details(tool_calls: List[Any]) -> List[Dict[str, Any]]:
    """
    Extract executable function details from tool-call payloads.

    Args:
        tool_calls (List[Any]): Tool-call entries extracted from an assistant message.

    Returns:
        List[Dict[str, Any]]: Normalized function-call details. Each item has ``tool_id``, ``tool_name``, and ``tool_arguments`` keys.

    Examples:
        >>> tool_calls = [
        ...     {
        ...         "function": {
        ...             "arguments": "{\"source_file_path\": \"<file_path>\"}",
        ...             "name": "inspect_dataset_file",
        ...         },
        ...         "id": "chatcmpl-tool-9ecca75031a33e76",
        ...         "type": "function",
        ...     }
        ... ]
        >>> extract_function_details(tool_calls)
        [{'tool_id': 'chatcmpl-tool-9ecca75031a33e76', 'tool_name': 'inspect_dataset_file', 'tool_arguments': {'source_file_path': '<file_path>'}}]

    Raises:
        json.JSONDecodeError: If a tool-call argument string contains invalid JSON.
        ValueError: If a tool-call argument payload has an unsupported type.
    """
    function_details: List[Dict[str, Any]] = []

    for tool_call in tool_calls:
        function_info = tool_call.get("function", {})

        tool_id = tool_call.get("id")
        tool_name = function_info.get("name")
        raw_arguments = function_info.get("arguments", "{}")

        tool_arguments = parse_tool_arguments(raw_arguments)

        function_details.append(
            {
                "tool_id": tool_id,
                "tool_name": tool_name,
                "tool_arguments": tool_arguments,
            }
        )

    return function_details


def execute_function_call(
    function_detail: Dict[str, Any],
    *,
    authorized_source_file_path: str | None = None,
    authorized_source_file_identity: FileIdentity | None = None,
) -> Dict[str, Any]:
    """
    Execute tool call based on the provided function details.

    Args:
        function_detail (Dict[str, Any]): Function-call details containing ``tool_id``, ``tool_name``, and ``tool_arguments`` keys.

    Returns:
        Dict[str, Any]: Tool execution result containing ``tool_call_id``, ``tool_name``, and ``result``.

    Examples:
        >>> function_detail = {
        ...     "tool_id": "chatcmpl-tool-9ecca75031a33e76",
        ...     "tool_name": "inspect_dataset_file",
        ...     "tool_arguments": {
        ...         "source_file_path": "E:\\\\pii-agent\\\\notebooks\\\\dataset\\\\healthcare_patient_visits.csv"
        ...     },
        ... }
        >>> execute_function_call(function_detail)
        {'tool_call_id': 'chatcmpl-tool-9ecca75031a33e76', 'tool_name': 'inspect_dataset_file', 'result': {...}}

    Raises:
        KeyError: If required keys are missing from ``function_detail``.
        ValueError: If the requested tool name is not registered.
        TypeError: If the registered tool cannot be called with the provided arguments.
    """
    tool_name = function_detail["tool_name"]
    tool_arguments = _validate_tool_arguments(
        tool_name, function_detail.get("tool_arguments")
    )

    tool_function = PROTECTED_FILE_PIPELINE_TOOL_REGISTRY.get(tool_name)

    if tool_function is None:
        raise ValueError(f"Unknown tool requested: {tool_name}")

    if (
        authorized_source_file_path is None
        and authorized_source_file_identity is None
    ):
        result = tool_function(**tool_arguments)
    else:
        result = tool_function(
            **tool_arguments,
            authorized_source_file_path=authorized_source_file_path,
            authorized_source_file_identity=authorized_source_file_identity,
        )

    return {
        "tool_call_id": function_detail["tool_id"],
        "tool_name": tool_name,
        "result": result,
    }


def build_tool_response_message(
    tool_id: str,
    tool_name: str,
    tool_result: Any,
) -> Dict[str, Any]:
    """
    Build a tool response message for the LLM conversation.

    Args:
        tool_id (str): ID of the tool call being answered.
        tool_name (str): Name of the executed tool.
        tool_result (Any): Result payload returned by the tool.

    Returns:
        Dict[str, Any]: Chat message with ``role`` set to ``tool`` and JSON content containing the serialized tool result.

    Examples:
        >>> build_tool_response_message(
        ...     tool_id="chatcmpl-tool-9ecca75031a33e76",
        ...     tool_name="inspect_dataset_file",
        ...     tool_result={"success": True},
        ... )
        {'role': 'tool', 'tool_call_id': 'chatcmpl-tool-9ecca75031a33e76', 'name': 'inspect_dataset_file', 'content': '{"success": true}'}
    """
    return {
        "role": "tool",
        "tool_call_id": tool_id,
        "name": tool_name,
        "content": json.dumps(tool_result, ensure_ascii=False, default=str),
    }


def parse_final_response(assistant_message: Any) -> FinalResponse:
    """
    Parse the final assistant message into ``FinalResponse`` based on the final protected file response schema.

    Args:
        assistant_message (Any): Final assistant message returned after all tool calls are complete.

    Returns:
        FinalResponse: Validated final pipeline response.

    Raises:
        ValueError: If the final response cannot be read from the assistant message
            or does not match the ``FinalResponse`` schema.
    """
    try:
        if isinstance(assistant_message, FinalResponse):
            return assistant_message

        if isinstance(assistant_message, dict):
            content = assistant_message.get("content", assistant_message)
        elif hasattr(assistant_message, "content"):
            content = getattr(assistant_message, "content")
        else:
            content = assistant_message

        if isinstance(content, str):
            # Local models (e.g. Qwen3-Coder-Next) prepend a "[ModelName] " tag before the JSON payload.  Strip it so that
            # Strip the prefix model name to prevent JSON parsing errors.  
            stripped = content.lstrip()
            if stripped.startswith("[") and "]" in stripped:
                bracket_end = stripped.index("]")
                candidate = stripped[bracket_end + 1:].lstrip()
                if candidate.startswith("{") or candidate.startswith("["):
                    content = candidate
            content = json.loads(content)

        if isinstance(content, FinalResponse):
            return content

        if hasattr(FinalResponse, "model_validate"):
            response = FinalResponse.model_validate(content)
        else:
            response = FinalResponse(**content)
        return response
    except Exception as error:
        raise ValueError(f"Failed to parse final response: {error}") from error
