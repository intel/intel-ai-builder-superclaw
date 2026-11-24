"""Factory for ONNX Runtime inference sessions.

Pipelines handle the direct OpenVINO path before calling this module. By the
time execution reaches ``make_session()``, providers should be normal ONNX
Runtime execution providers only.

``OpenVINOExecutionProvider`` is not accepted here. It is a routing signal for
the pipeline-level OpenVINO loader, not a provider this factory should pass to
ONNX Runtime.
"""

from __future__ import annotations

import logging
from typing import Any

from text_protection.onnx_providers import ResolvedProviders


logger = logging.getLogger(__name__)


def make_session(
    model_path: str,
    *,
    sess_options: Any,
    resolved: ResolvedProviders,
) -> Any:
    """Create an ONNX Runtime session for the resolved non-OpenVINO providers."""
    if not resolved.providers:
        raise RuntimeError("ResolvedProviders.providers is empty; nothing to load")

    providers = list(resolved.providers)
    provider_options = list(resolved.provider_options)

    if providers[0] == "OpenVINOExecutionProvider":
        # OpenVINO must be handled by the pipeline before this ORT factory.
        raise RuntimeError(
            "make_session() was called with OpenVINOExecutionProvider. "
            "OpenVINO providers must be handled by the pipeline's "
            "optimum.intel loader, not this ORT factory. This is a "
            "code-flow bug, not a config problem."
        )

    import onnxruntime as ort
    logger.info(
        "Inference backend: onnxruntime — providers=%s",
        providers,
    )
    return ort.InferenceSession(
        model_path,
        sess_options=sess_options,
        providers=providers,
        provider_options=provider_options,
    )
