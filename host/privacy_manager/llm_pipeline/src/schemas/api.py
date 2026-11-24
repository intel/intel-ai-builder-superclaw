"""
Pydantic request and response models for the protected file pipeline API.
"""

from typing import Any

from pydantic import BaseModel, Field


class PipelineApiRequest(BaseModel):
    source_file_path: str = Field(
        ...,
        description="Original source file path provided by the user, used by the protected file pipeline for dataset inspection and optional masking.",
    )
    session_id: str | None = Field(
        default=None,
        description="OpenCode session id of the caller, forwarded to llmrouter_manager as X-Opencode-Session-Id so token usage is attributed to the right session.",
    )


class PipelineApiResponse(BaseModel):
    success: bool = Field(
        ..., description="Whether the API request completed successfully."
    )
    masked_file_path: str | None = Field(
        default=None,
        description="Path to the masked output file, or null if masking was not performed.",
    )
    final_answer: Any | None = Field(
        default=None,
        description="Final answer produced by the pipeline, or null if unavailable.",
    )
    error_message: str | None = Field(
        default=None,
        description="Error details when the pipeline fails. Null on success.",
    )
