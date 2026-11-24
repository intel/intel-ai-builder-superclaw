
"""
Orchestrates protected file inspection, masking, and final response generation.
"""
import json
import os
import re
import uuid
from typing import Any, Dict, List
from llm_pipeline.src.clients.llm_client import LLMClient, NoLocalProviderError
from llm_pipeline.utils.logger import setup_logger
from llm_pipeline.utils.paths import FileIdentity
from llm_pipeline.src.pipeline.tool_calls import (
    build_tool_response_message,
    execute_function_call,
    extract_function_details,
    extract_tool_calls,
    parse_final_response,
    validate_masking_function_call,
)
from llm_pipeline.src.prompts.llm_pipeline_prompt import (
    MASKED_SENSITIVE_COLUMN_SYSTEM_PROMPT,
)
from llm_pipeline.src.schemas.responses import FinalResponse
from llm_pipeline.src.schemas.tool_schemas import (
    MASK_SENSITIVE_COLUMNS_TOOL_SCHEMA,
)
logger = setup_logger(__name__)

_REGISTRY_PATH_RE = re.compile(
    r"[^\s\"'`]*data_protection_workspace[/\\]mask_registries[/\\][^\s\"'`]*",
    re.IGNORECASE,
)

def _scrub_registry_path_mentions(text: str) -> str:
    """Strip any mask-registry file path from agent-facing text.
    Defense-in-depth backstop: the registry holds raw, unmasked PII values,
    so any accidental mention of its path (which the model was told never
    to include) must be removed before the text reaches the container.
    """
    return _REGISTRY_PATH_RE.sub("[registry path omitted]", text)

def _dump(value: Any) -> str:
    """Serialize a value to indented JSON for debug logging; falls back to str() on failure."""
    try:
        return json.dumps(value, ensure_ascii=False, default=str, indent=2)
    except (TypeError, ValueError):
        return str(value)

def build_masking_result_summary_message(mask_result: Dict[str, Any]) -> Dict[str, Any]:
    """Build canonical masking evidence for the final structured response."""
    result = mask_result.get("result") or {}
    masked_columns = result.get("masked_columns") or result.get("columns_to_mask") or []
    summary = {
        "masking_performed": bool(result.get("success") and masked_columns),
        "masked_columns_count": len(masked_columns),
        "masked_columns": masked_columns,
        "masked_file_path": result.get("masked_file_path"),
        "mask_registry_file_path": result.get("registry_file_path"),
    }
    
    return {
        "role": "user",
        "content": (
            "Use this canonical masking result when writing the final JSON response. "
            "If masking_performed is true, do not say that no sensitive columns were found.\n"
            f"{json.dumps(summary, ensure_ascii=False)}"
        ),
    }

async def request_llm_assistant_message(
    llm_client: LLMClient,
    chat_messages: List[Dict[str, Any]],
    tools: List[Dict[str, Any]] | None = None,
    pydantic_response_format: Any | None = None,
    tool_choice: str = "auto",
    use_stream: bool = False,
    step_name: str = "",
    session_id: str | None = None,
) -> Dict[str, Any]:
    """
    Request an assistant message using either normal or streaming chat.
    Returns a normalized response so orchestration logic can keep working with
    assistant messages while optionally collecting streaming metrics.
    """
    logged_step = step_name or "llm_request"
    if tools:
        logger.debug("[{}] Tool schemas offered to local model: {}", logged_step, _dump(tools))
    if use_stream:
        stream_result = await llm_client.chat_stream(
            chat_messages=chat_messages,
            tools=tools,
            pydantic_response_format=pydantic_response_format,
            tool_choice=tool_choice,
            session_id=session_id,
        )
        metrics = stream_result.get("metrics") or {}
        assistant_message = stream_result["assistant_message"]
        if metrics:
            logger.debug("[{}] Stream metrics: {}", logged_step, _dump(metrics))
        return {
            "assistant_message": assistant_message
        }
    assistant_message = await llm_client.chat(
        chat_messages=chat_messages,
        tools=tools,
        pydantic_response_format=pydantic_response_format,
        tool_choice=tool_choice,
        session_id=session_id,
    )
    return {
        "assistant_message": assistant_message
    }

# Step 1: Dataset inspection
async def run_dataset_inspection_step(
    conversation_messages: List[Dict[str, Any]],
    file_path: str,
    authorized_source_file_path: str | None = None,
    authorized_source_file_identity: FileIdentity | None = None,
) -> Dict[str, Any]:
    """
    Run the dataset inspection step for the user-provided file path.
 
    Args:
        conversation_messages (List[Dict[str, Any]]): Conversation history for the pipeline.
        file_path (str): Absolute source path to inspect. Passed through verbatim.
        authorized_source_file_path: Canonical source authorized by the
            integrated Privacy Manager route, if present.
    Returns:
        Dict[str, Any]: Step result with ``success``, ``tool_result``, ``conversation_messages``, and ``error_message`` keys.
    """
    logger.info("[Step 1] Starting dataset inspection. mode=deterministic")

    tool_call_id = f"inspect-{uuid.uuid4().hex[:16]}"
    tool_arguments = {"source_file_path": file_path}
    assistant_message: Dict[str, Any] = {
        "role": "assistant",
        "content": "",
        "tool_calls": [
            {
                "id": tool_call_id,
                "type": "function",
                "function": {
                    "name": "inspect_dataset_file",
                    "arguments": json.dumps(tool_arguments, ensure_ascii=False),
                },
            }
        ],
    }
    conversation_messages.append(assistant_message)
    function_call = {
        "tool_id": tool_call_id,
        "tool_name": "inspect_dataset_file",
        "tool_arguments": tool_arguments,
    }
    logger.info("[Step 1] Inspect tool call synthesized. tool_name={}", function_call["tool_name"])

    try:
        tool_result = execute_function_call(
            function_call,
            authorized_source_file_path=authorized_source_file_path,
            authorized_source_file_identity=authorized_source_file_identity,
        )
        tool_message = build_tool_response_message(
            tool_id=tool_result["tool_call_id"],
            tool_name=tool_result["tool_name"],
            tool_result=tool_result,
        )
        inspected_summary = (
            (tool_result["result"].get("inspected_context") or {}).get("dataset_summary") or {}
        )
        
        conversation_messages.append(tool_message)
        if not tool_result["result"].get("success"):
            error_message = tool_result["result"].get("error_message")
            logger.warning("[Step 1] Inspect failed. error={}", error_message)
            return {
                "success": False,
                "tool_result": tool_result,
                "conversation_messages": conversation_messages,
                "error_message": error_message,
            }
        logger.info("[Step 1] Dataset inspection completed successfully.")
        
        return {
            "success": True,
            "tool_result": tool_result,
            "conversation_messages": conversation_messages,
            "error_message": None
        }
    except Exception as error:
        logger.exception("[Step 1] Inspect tool execution failed.")
        
        error_message = str(error)
        tool_result = {
            "tool_call_id": function_call["tool_id"],
            "tool_name": function_call["tool_name"],
            "result": {
                "success": False,
                "error_message": error_message,
            },
        }
        conversation_messages.append(
            {
                "role": "tool",
                "tool_call_id": function_call["tool_id"],
                "name": function_call["tool_name"],
                "content": json.dumps(
                    {"success": False, "error_message": error_message},
                    ensure_ascii=False,
                ),
            }
        )
        return {
            "success": False,
            "tool_result": tool_result,
            "conversation_messages": conversation_messages,
            "error_message": error_message
        }

# Step 2: Sensitive column masking
async def run_sensitive_column_masking_step(
    llm_client,
    conversation_messages: List[Dict[str, Any]],
    source_file_path: str,
    file_format: str,
    use_stream: bool = False,
    session_id: str | None = None,
    *,
    authorized_source_file_path: str | None = None,
    authorized_source_file_identity: FileIdentity | None = None,
) -> Dict[str, Any]:
    """
    Run the sensitive-column masking step for the inspected dataset.
    Requests a ``mask_sensitive_columns`` tool call from the LLM, executes the
    tool, and appends the assistant message and tool response to the conversation history.
    Args:
        llm_client (LLMClient): Initialized LLM client used to request the masking tool call.
        conversation_messages (List[Dict[str, Any]]): Conversation history from the previous pipeline steps.
        source_file_path (str): Canonical source path established by inspection.
        file_format (str): Source format derived from the inspected file suffix.
        authorized_source_file_path: Canonical source authorized by the
            integrated Privacy Manager route, if present.
    Returns:
        Dict[str, Any]: Step result with ``success``, ``tool_result``, ``conversation_messages``, and ``error_message`` keys.
    """
    logger.info("[Step 2] Starting sensitive column masking.")
    llm_result = await request_llm_assistant_message(
        llm_client=llm_client,
        chat_messages=conversation_messages,
        tools=MASK_SENSITIVE_COLUMNS_TOOL_SCHEMA,
        tool_choice="required",
        use_stream=use_stream,
        step_name="mask",
        session_id=session_id,
    )
    assistant_message = llm_result["assistant_message"]
    logger.info("[Step 2] Mask model response received.")
    conversation_messages.append(assistant_message)
    tool_calls = extract_tool_calls(assistant_message)
    function_calls = extract_function_details(tool_calls)
    if len(function_calls) != 1:
        logger.warning("[Step 2] Expected exactly one masking tool call.")
        return {"success": False, "tool_result": None, "conversation_messages": conversation_messages, "error_message": "Exactly one masking tool call is required."}
    try:
        function_call = validate_masking_function_call(
            function_calls[0],
            source_file_path=source_file_path,
            file_format=file_format,
        )
    except ValueError as error:
        return {
            "success": False,
            "tool_result": None,
            "conversation_messages": conversation_messages,
            "error_message": str(error),
        }
    logger.info("[Step 2] Mask tool call extracted. tool_name={}", function_call.get("tool_name"))
    requested_columns = (function_call.get("tool_arguments") or {}).get("columns_to_mask") or []
    
    try:
        tool_result = execute_function_call(
            function_call,
            authorized_source_file_path=authorized_source_file_path,
            authorized_source_file_identity=authorized_source_file_identity,
        )
        
        masked_columns = (
            tool_result["result"].get("masked_columns")
            or tool_result["result"].get("columns_to_mask")
            or []
        )
        tool_message = build_tool_response_message(
            tool_id=tool_result["tool_call_id"],
            tool_name=tool_result["tool_name"],
            tool_result=tool_result,
        )
        logger.info(
            "[Step 2] Mask tool executed. tool_name={} success={}",
            tool_result["tool_name"],
            tool_result["result"].get("success"),
        )

        conversation_messages.append(tool_message)
        if tool_result["result"].get("success") and not masked_columns:
            logger.info("[Step 2] Masking tool found no sensitive columns. Proceeding with unmasked file.")
        if not tool_result["result"].get("success"):
            error_message = tool_result["result"].get("error_message")
            logger.warning("[Step 2] Masking failed. error={}", error_message)
            return {
                "success": False,
                "tool_result": tool_result,
                "conversation_messages": conversation_messages,
                "error_message": error_message,
            }
        logger.info("[Step 2] Sensitive column masking completed successfully.")
        
        return {
            "success": True,
            "tool_result": tool_result,
            "conversation_messages": conversation_messages,
            "error_message": None,
        }
    except Exception as error:
        logger.exception("[Step 2] Mask tool execution failed.")
        
        error_message = str(error)
        tool_result = {
            "tool_call_id": function_call["tool_id"],
            "tool_name": function_call["tool_name"],
            "result": {
                "success": False,
                "error_message": error_message,
            },
        }
        conversation_messages.append(
            {
                "role": "tool",
                "tool_call_id": function_call["tool_id"],
                "name": function_call["tool_name"],
                "content": json.dumps(
                    {"success": False, "error_message": error_message},
                    ensure_ascii=False,
                ),
            }
        )
        return {
            "success": False,
            "tool_result": tool_result,
            "conversation_messages": conversation_messages,
            "error_message": error_message
        }

# Step 3: Final response generation
async def generate_final_pipeline_response(
    llm_client,
    conversation_messages: List[Dict[str, Any]],
    use_stream: bool = False,
    session_id: str | None = None,
) -> Dict[str, Any]:
    """
    Generate the final answer and parse it into ``FinalResponse``.
    Args:
        llm_client (LLMClient): Initialized LLM client used to request the final structured response.
        conversation_messages (List[Dict[str, Any]]): Conversation history produced by the protected file pipeline.
    Returns:
        Dict[str, Any]: Final generation result with the following keys:
            success: Whether the final response was generated and parsed.
            final_response: Parsed ``FinalResponse`` instance, or ``None`` when generation or parsing fails.
            error_message: Error details when ``success`` is ``False``; otherwise ``None``.
    """
    logger.info("[Step 3] Starting final response generation.")
    try:
        llm_result = await request_llm_assistant_message(
            llm_client=llm_client,
            chat_messages=conversation_messages,
            tools=None,
            pydantic_response_format=FinalResponse,
            use_stream=use_stream,
            step_name="final_response",
            session_id=session_id,
        )
        final_assistant_message = llm_result["assistant_message"]
        logger.info("[Step 3] Final model response received.")
        

        final_response = parse_final_response(final_assistant_message)
        conversation_messages.append(final_assistant_message)
        logger.info(
            "[Step 3] Final response parsed successfully."
        )
        
        return {
            "success": True,
            "final_response": final_response,
            "error_message": None
        }
    except NoLocalProviderError:
        # Let the caller (protect_routes.py) decide whether to fall back to
        # deterministic-only masking instead of swallowing this into a plain
        # string the caller can't distinguish from any other LLM failure.
        raise
    except Exception as error:
        error_message = str(error)
        logger.exception("[Step 3] Final response generation failed.")
        return {
            "success": False,
            "final_response": None,
            "error_message": error_message
        }

# Main protected file pipeline orchestrator
async def run_protected_file_pipeline(
    file_path: str,
    llm_client,
    use_stream: bool = False,
    session_id: str | None = None,
    *,
    authorized_source_file_path: str | None = None,
    authorized_source_file_identity: FileIdentity | None = None,
) -> Dict[str, Any]:
    """
    Run inspection and optional masking for a user-provided file path.
    Returns the workflow state and tool results.
    Call ``generate_final_pipeline_response`` to create the final structured response.
    Args:
        file_path (str): Path to the source CSV or Excel file to inspect and protect.
        llm_client (LLMClient): Initialized LLM client used by each workflow step.
        authorized_source_file_path: Canonical source authorized by the
            integrated Privacy Manager route, if present.
    Returns:
        Dict[str, Any]: Workflow result with the following keys:
            success: Whether all workflow steps completed successfully.
            conversation_messages: Conversation history accumulated during the workflow.
            inspect_result: Wrapped inspection tool result, or ``None`` if inspection failed.
            mask_result: Wrapped masking tool result, or ``None`` if masking was skipped or failed.
            error_message: Error details when ``success`` is ``False``; otherwise ``None``.
    Raises:
        ValueError: If ``file_path`` is empty or only whitespace.
    """
    logger.info("[Pipeline] Starting protected file workflow.")
    if not file_path.strip():
        logger.warning("[Pipeline] Rejected empty file path.")
        raise ValueError("file_path is empty. Please provide a valid file path.")
    conversation_messages = [
        {"role": "system", "content": MASKED_SENSITIVE_COLUMN_SYSTEM_PROMPT},
        {"role": "user", "content": file_path},
    ]
    
    # Step 1: Dataset inspection
    inspect_step_result = await run_dataset_inspection_step(
        conversation_messages=conversation_messages,
        file_path=file_path,
        authorized_source_file_path=authorized_source_file_path,
        authorized_source_file_identity=authorized_source_file_identity,
    )
    conversation_messages = inspect_step_result["conversation_messages"]
    inspect_result = inspect_step_result["tool_result"]

    if not inspect_step_result["success"]:
        logger.warning(
            "[Pipeline] Stopping workflow because dataset inspection failed. error={}",
            inspect_step_result["error_message"],
        )
        return {
            "success": False,
            "conversation_messages": conversation_messages,
            "inspect_result": inspect_result,
            "mask_result": {
                "tool_call_id": None,
                "tool_name": "mask_sensitive_columns",
                "result": {
                    "success": False,
                    "error_message": "Masking skipped because dataset inspection failed.",
                },
            },
            "error_message": inspect_step_result["error_message"]
        }
    # Step 2: Sensitive column masking
    logger.debug("[Pipeline] Appended masking instruction prompt before step 2.")
    mask_step_result = await run_sensitive_column_masking_step(
        llm_client=llm_client,
        conversation_messages=conversation_messages,
        source_file_path=inspect_result["result"]["inspected_context"]["file_metadata"]["file_path"],
        file_format=inspect_result["result"]["inspected_context"]["file_metadata"]["file_type"],
        authorized_source_file_path=authorized_source_file_path,
        authorized_source_file_identity=authorized_source_file_identity,
        use_stream=use_stream,
        session_id=session_id,
    )
    conversation_messages = mask_step_result["conversation_messages"]
    mask_result = mask_step_result["tool_result"]
    
    if not mask_step_result["success"]:
        logger.warning(
            "[Pipeline] Stopping workflow because sensitive column masking failed. error={}",
            mask_step_result["error_message"],
        )
        return {
            "success": False,
            "conversation_messages": conversation_messages,
            "inspect_result": inspect_result,
            "mask_result": mask_result,
            "error_message": mask_step_result["error_message"]
        }
    logger.info("[Pipeline] Protected file workflow completed successfully.")
    return {
        "success": True,
        "conversation_messages": conversation_messages,
        "inspect_result": inspect_result,
        "mask_result": mask_result,
        "error_message": None
    }

# Main entry pipeline execution with final response generation
async def run_full_protected_file_pipeline(
    file_path: str,
    llm_client: LLMClient,
    use_stream: bool = False,
    session_id: str | None = None,
    *,
    authorized_source_file_path: str | None = None,
    authorized_source_file_identity: FileIdentity | None = None,
) -> Dict[str, Any]:
    """
    Run the full protected file pipeline and generate the final response.
    Args:
        file_path (str): Path to the source CSV or Excel file to inspect and protect.
        llm_client (LLMClient): Initialized LLM client used by the pipeline.
        authorized_source_file_path: Canonical source authorized by the
            integrated Privacy Manager route, if present.
    Returns:
        Dict[str, Any]: Pipeline result containing the workflow step results, final generation result, and parsed final response.
    """
    logger.info("[Pipeline] Starting full protected file pipeline.")
    # Run the main protected file pipeline
    pipeline_result = await run_protected_file_pipeline(
        file_path=file_path,
        llm_client=llm_client,
        authorized_source_file_path=authorized_source_file_path,
        authorized_source_file_identity=authorized_source_file_identity,
        use_stream=use_stream,
        session_id=session_id,
    )
    if not pipeline_result["success"]:
        logger.warning(
            "[Pipeline] Full pipeline stopped before final response generation. error={}",
            pipeline_result.get("error_message"),
        )
        return pipeline_result
    pipeline_result["conversation_messages"].append(
        build_masking_result_summary_message(pipeline_result["mask_result"])
    )
    # Step 3: Generate the final response based on the conversation messages
    final_result = await generate_final_pipeline_response(
        llm_client=llm_client,
        conversation_messages=pipeline_result["conversation_messages"],
        use_stream=use_stream,
        session_id=session_id,
    )
    logger.info(
        "[Pipeline] Full protected file pipeline completed. final_generation_success={}",
        final_result["success"],
    )
    mask_registry_file_path = (
        pipeline_result.get("mask_result", {}).get("result", {}).get("registry_file_path")
    )
    mask_output_file_path = (
        pipeline_result.get("mask_result", {}).get("result", {}).get("masked_file_path")
    )
    if mask_registry_file_path:
        logger.info(
            "[Pipeline] Registry file basename: {}",
            os.path.basename(mask_registry_file_path),
        )
    final_response = final_result["final_response"]

    if final_response and mask_output_file_path and not final_response.masked_file_path:
        final_response = final_response.model_copy(
            update={"masked_file_path": mask_output_file_path}
        )
        final_result = {**final_result, "final_response": final_response}
        logger.info(
            "[Pipeline] Applied masked output path from masking tool to final response."
        )
    if final_response and mask_registry_file_path and not final_response.mask_registry_file_path:
        final_response = final_response.model_copy(
            update={"mask_registry_file_path": mask_registry_file_path}
        )
        final_result = {**final_result, "final_response": final_response}
        logger.info(
            "[Pipeline] Applied registry path from masking tool to final response."
        )
    if final_response and final_response.final_answer:
        scrubbed_answer = _scrub_registry_path_mentions(final_response.final_answer)
        if scrubbed_answer != final_response.final_answer:
            final_response = final_response.model_copy(
                update={"final_answer": scrubbed_answer}
            )
            final_result = {**final_result, "final_response": final_response}
            logger.warning(
                "[Pipeline] Scrubbed a mask-registry path mention from final_answer "
                "— the model should never include it (see FinalResponse.final_answer)."
            )
    return {
        "final_generation_result": final_result,
        "final_response": final_response,
        "mask_registry_file_path": mask_registry_file_path,
    }