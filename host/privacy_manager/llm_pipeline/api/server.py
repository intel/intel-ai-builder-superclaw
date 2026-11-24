"""
FastAPI server for running the protected file pipeline integration.
"""

import os
from typing import Any, Dict

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from llm_pipeline.src.clients.llm_client import LLMClient
from llm_pipeline.utils.logger import setup_logger
from llm_pipeline.utils.paths import FileIdentity
from llm_pipeline.src.pipeline.orchestrator import run_full_protected_file_pipeline
from llm_pipeline.src.schemas.api import PipelineApiRequest, PipelineApiResponse

logger = setup_logger(__name__)


async def run_protected_file_pipeline(
    source_file_path: str,
    llm_client: LLMClient,
    session_id: str | None = None,
    authorized_source_file_path: str | None = None,
    authorized_source_file_identity: FileIdentity | None = None,
) -> dict[str, Any]:
    """
    Runs the protected file pipeline based on the provided source file path.

    Args:
        source_file_path (str): Path to the source file for the protected file pipeline.
        llm_client (LLMClient): Configured LLM client used by the orchestrator.
        session_id (str | None): OpenCode session id to attribute LLM token usage to.
        authorized_source_file_path: Canonical source authorized by the
            integrated Privacy Manager route. Standalone callers omit it.

    Returns:
        dict[str, Any]: Structured pipeline result returned by the orchestrator.
    """
    return await run_full_protected_file_pipeline(
        file_path=source_file_path,
        llm_client=llm_client,
        authorized_source_file_path=authorized_source_file_path,
        authorized_source_file_identity=authorized_source_file_identity,
        session_id=session_id,
    )


def create_app(*, service_name: str = "llm_pipeline", instance_id: str = "dev-instance") -> FastAPI:
    """
    Creates and configures the Protected File Pipeline FastAPI app.

    Returns:
        FastAPI: Configured FastAPI application instance.
    """
    logger.info("Creating Protected File Pipeline API application.")

    app = FastAPI(
        title="LLM Pipeline Pipeline API",
        description="API for serving the LLM Pipeline pipeline integration",
        version="1.0.0",
    )

    app.state.service_name = service_name
    app.state.instance_id = instance_id

    logger.info("Initializing LLM client for API requests.")
    app.llm_client = LLMClient()
    logger.info("LLM Pipeline Pipeline API application configured successfully.")

    @app.get("/file-guard/v1/health")
    def health_check(request: Request) -> dict[str, Any]:
        """ServiceHub readiness probe (contract §5).

        Returns the required shape: {service, status, pid, instance_id}.
        ServiceHub validates all four fields before marking the service running.
        """
        return {
            "service": request.app.state.service_name,
            "status": "ok",
            "pid": os.getpid(),
            "instance_id": request.app.state.instance_id,
        }

    @app.post("/file-guard/v1/shutdown")
    async def shutdown(request: Request) -> JSONResponse:
        """Graceful shutdown per contract §7.

        Flips uvicorn.Server.should_exit so the event loop drains and exits
        within shutdown_grace_s before ServiceHub force-kills the process.
        """
        server = getattr(request.app.state, "server", None)
        if server is not None:
            server.should_exit = True
        return JSONResponse({"state": "stopping"})

    @app.post("/file-guard/v1/run", response_model=PipelineApiResponse)
    async def run_protected_file_endpoint(request: PipelineApiRequest) -> PipelineApiResponse:
        """
        Runs the LLM Pipeline pipeline for an API request.

        Args:
            request (PipelineApiRequest): API request containing the source file path.

        Returns:
            dict: API response containing pipeline data or an error message.

        Raises:
            HTTPException: If the source file path is empty.
        """
        if not request.source_file_path.strip():
            logger.warning("Rejected empty LLM Pipeline pipeline request.")
            raise HTTPException(status_code=400, detail="Source file path cannot be empty.")

        try:
            logger.info("Starting LLM Pipeline pipeline request.")
            pipeline_result = await run_protected_file_pipeline(
                source_file_path=request.source_file_path,
                llm_client=app.llm_client,
                session_id=request.session_id,
            )
            logger.info("Pipeline completed. success={}", pipeline_result.get("final_generation_result", {}).get("success"))
            logger.debug("Raw pipeline result: {}", pipeline_result)

            final_response = pipeline_result.get("final_response")
            if final_response is None:
                logger.warning("Pipeline returned no final_response; masked_file_path and final_answer will be null.")

            final_answer = final_response.final_answer if final_response else None
            masked_file_path = final_response.masked_file_path if final_response else None
            logger.debug("Extracted fields — final_answer={!r}  masked_file_path={!r}", final_answer, masked_file_path)

            return PipelineApiResponse(
                success=pipeline_result.get("final_generation_result", {}).get("success", False),
                masked_file_path=masked_file_path,
                final_answer=final_answer,
                error_message=pipeline_result.get("error_message"),
            )

        except Exception as exc:
            logger.exception("LLM Pipeline pipeline request failed.")
            return PipelineApiResponse(
                success=False,
                masked_file_path=None,
                final_answer=None,
                error_message=str(exc),
            )

    return app
