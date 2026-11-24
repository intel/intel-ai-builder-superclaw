"""Text-based protection backend — ML-driven.

Detect and mask PII in free-form text via ONNX NER + spaCy + finance
similarity embeddings. Loads the model stack at construction time.

The public engine is ``ConsistentSanitizer``; it is parameterized entirely
by explicit constructor arguments and imports nothing from the FastAPI
service layer. Lifecycle/config wiring lives in
``protection_service.sanitize_state`` (the service adapter), keeping this
package a pure, service-agnostic engine.

  - sanitizer:            ConsistentSanitizer (public API)
  - _stages:              Stage 1/2/3 over the per-call context
  - _detectors:           Stage-1 Detector Protocol implementations
  - _pplx_pipeline:       ONNX PPLX session + Viterbi decode + repairs
  - _embedding_pipeline:  ONNX sentence-embedding session + cache
  - onnx_providers:       device token -> ONNX Runtime providers
  - _openvino_backend / _inference_backend: backend session factories
"""

__version__ = "0.1.0"
