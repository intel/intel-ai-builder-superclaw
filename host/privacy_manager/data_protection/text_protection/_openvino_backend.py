"""OpenVINO inference backend: a session over pre-converted OpenVINO IR.

Why not optimum.intel
---------------------
``optimum.intel`` wraps OpenVINO models in a ``transformers``-compatible API,
but it does an unguarded module-scope ``import torch``
(``optimum/intel/openvino/modeling.py``) solely to provide that wrapper. That
dragged a ~360 MB CPU torch wheel into the installer for a model that was never
executed through torch.

This module loads the same IR through ``openvino.Core`` and returns an object
exposing the slice of the ``onnxruntime.InferenceSession`` API the pipelines
already consume, so the OpenVINO and ORT paths share one post-processing chain.
Neither torch nor ``transformers.pipeline`` is needed; only ``AutoTokenizer``
is still required and it is backed by Rust tokenizers.

Module shape
------------
  ``load_ov_ner(model_dir, device, ov_cache_dir)``
  ``load_ov_embedding(model_dir, device, ov_cache_dir)``
  ``load_ov_pplx(model_dir, device, ov_cache_dir)``
      All return ``(session, tokenizer)``. The caller drives tokenization and
      post-processing exactly as it does for an ONNX session. Model file:
      ``openvino_model.xml``.

Measured behaviour that shaped this implementation, on an Intel iGPU box
(OpenVINO 2026.2.1) against a shipped OpenVINO IR NER model:

* **Never use ``CompiledModel.__call__``.** It reuses one internal
  ``InferRequest`` and raised ``RuntimeError: Infer Request is busy`` in 180 of
    200 calls across 8 threads. ``PplxNerPipeline.run`` catches ``Exception`` and
  returns ``[]``, so that would make concurrent requests silently detect ZERO
  PII while only logging a warning. Inference borrows from a bounded pool of
  explicit requests instead.
* **Pool is sized from the device hint, not the thread count.** Concurrency
  buys no throughput (0.98x vs single-threaded; the CPU plugin already
  saturates cores and reports ``OPTIMAL_NUMBER_OF_INFER_REQUESTS=1``), so a
  request per worker thread would only multiply activation memory for a 266 MB
  model.
* **No precision hint is set.** The device already selects ``float16`` on GPU
  and ``float32`` on CPU, GPU output was finite with a 100% argmax match
  against CPU, and ``int8`` is not a legal value for the hint.
"""

from __future__ import annotations

import logging
import os
import queue
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

logger = logging.getLogger(__name__)


# OpenVINO IR file present in pre-converted model directories. Distinct
# from ``model.onnx`` so the higher layer can pick which directory to
# load based on the runtime backend.
OV_IR_MODEL_FILE = "openvino_model.xml"
OV_IR_WEIGHTS_FILE = "openvino_model.bin"

# Upper bound on pooled InferRequests. The device hint is 1 under the LATENCY
# performance hint and concurrency was measured to add no throughput, so this
# cap only stops an unusual hint from allocating many activation buffers.
_MAX_POOLED_REQUESTS = 4


def is_ov_ir_dir(model_dir: str) -> bool:
    """Return True if ``model_dir`` contains pre-converted OpenVINO IR.

    A complete IR export ships ``openvino_model.xml`` + ``.bin``
    alongside the HF tokenizer files. ONNX-only directories don't have
    these files — fall back to the ORT path in that case.
    """
    xml = os.path.join(model_dir, OV_IR_MODEL_FILE)
    bin_ = os.path.join(model_dir, OV_IR_WEIGHTS_FILE)
    return (
        os.path.isfile(xml)
        and os.path.getsize(xml) > 0
        and os.path.isfile(bin_)
        and os.path.getsize(bin_) > 0
    )


def _build_ov_config(
    ov_cache_dir: Optional[str], device: Optional[str] = None
) -> Dict[str, str]:
    """Build the ``ov_config`` dict that OpenVINO forwards to the plugin.

    ``CACHE_DIR``: persist JIT-compiled GPU kernels between runs;
    without it the first /v1/text/redact after a restart pays a
    30-90s OpenCL JIT cost on Intel iGPU. The CPU plugin ignores it
    (harmless), so we set it unconditionally.

    We set ONLY ``CACHE_DIR`` and no ``INFERENCE_PRECISION_HINT``:
    on Intel GPU/NPU/CPU with the int8 IR model, adding a precision
    hint destabilizes int8 output — it either crashes (``int8`` isn't
    a valid value) or shifts argmax output between CPU and GPU on
    borderline classifications. Letting OpenVINO pick its own default
    keeps the int8 IR model correct across devices.

    The ``device`` parameter is kept in the signature (it affects logging)
    but does NOT influence ov_config.
    """
    config: Dict[str, str] = {}
    if ov_cache_dir:
        os.makedirs(ov_cache_dir, exist_ok=True)
        config["CACHE_DIR"] = os.path.abspath(ov_cache_dir)
    return config


class _OVInput:
    """Stand-in for onnxruntime's ``NodeArg``.

    Both pipelines only read ``.name`` (to project the tokenizer batch
    down to the graph's real inputs), so that is all this carries.
    """

    __slots__ = ("name",)

    def __init__(self, name: str) -> None:
        self.name = name

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"_OVInput(name={self.name!r})"


class OpenVinoSession:
    """``onnxruntime.InferenceSession``-shaped wrapper over OpenVINO IR.

    Thread-safe: each inference borrows an ``InferRequest`` from a bounded
    pool and returns it afterwards, so concurrent callers never share a
    request. Blocking on an empty pool is the intended behaviour — it
    serialises inference the same way a lock would, and measurement showed
    concurrency adds no throughput anyway.
    """

    def __init__(
        self,
        model_path: str,
        *,
        device: str,
        ov_cache_dir: Optional[str] = None,
    ) -> None:
        import openvino as ov

        self._device = device
        ov_config = _build_ov_config(ov_cache_dir, device=device)

        core = ov.Core()
        model = core.read_model(model_path)
        self._compiled = core.compile_model(model, device, ov_config)

        self._output_ports = list(self._compiled.outputs)
        self._input_names = [p.get_any_name() for p in self._compiled.inputs]

        pool_size = self._resolve_pool_size()
        self._pool: "queue.Queue[Any]" = queue.Queue(maxsize=pool_size)
        for _ in range(pool_size):
            self._pool.put(self._compiled.create_infer_request())

        logger.info(
            "OpenVINO session ready: device=%s inputs=%s requests=%d cache=%s",
            device,
            self._input_names,
            pool_size,
            ov_config.get("CACHE_DIR", "<none>"),
        )

    def _resolve_pool_size(self) -> int:
        """Size the request pool from the device's own recommendation."""
        try:
            optimal = int(
                self._compiled.get_property("OPTIMAL_NUMBER_OF_INFER_REQUESTS")
            )
        except Exception:
            # Property is optional; a single request is always valid and is
            # what the LATENCY hint recommends on CPU and GPU.
            optimal = 1
        return max(1, min(optimal, _MAX_POOLED_REQUESTS))

    # ------------------------------------------------------------------
    # onnxruntime-compatible surface
    # ------------------------------------------------------------------

    def get_inputs(self) -> List[_OVInput]:
        """Return the graph's inputs as ``.name``-bearing objects."""
        return [_OVInput(name) for name in self._input_names]

    def get_providers(self) -> List[str]:
        """Return a provider-style label. Diagnostics only."""
        return [f"OpenVINO:{self._device}"]

    def run(
        self,
        output_names: Optional[Sequence[str]],
        input_feed: Dict[str, np.ndarray],
    ) -> List[np.ndarray]:
        """Run inference and return every output as an owned numpy array.

        ``output_names`` must be ``None`` (every caller passes it); the
        parameter exists only to match ``ort.InferenceSession.run``'s
        signature so callers need not branch on the backend.

        The returned arrays are copies. OpenVINO hands back a view onto the
        borrowed ``InferRequest``'s output tensor, which is reused by the
        next inference on that request — returning the view would let a
        later call mutate an array the caller still holds. Copying also
        matches onnxruntime's contract of returning owned arrays.
        """
        if output_names is not None:
            raise NotImplementedError(
                "OpenVinoSession.run() only supports output_names=None; "
                f"got {output_names!r}."
            )
        request = self._pool.get()
        try:
            result = request.infer(input_feed)
            return [np.array(result[port], copy=True) for port in self._output_ports]
        finally:
            self._pool.put(request)


def _load_ov(
    model_dir: str, device: str, ov_cache_dir: Optional[str]
) -> Tuple[OpenVinoSession, Any]:
    if not is_ov_ir_dir(model_dir):
        raise FileNotFoundError(
            f"OpenVINO IR not found at {model_dir}. "
            f"Expected {OV_IR_MODEL_FILE} + {OV_IR_WEIGHTS_FILE}. "
            "Run optimum-cli export openvino, or use a model dir with "
            "the IR files in place."
        )
    from transformers import AutoTokenizer

    session = OpenVinoSession(
        os.path.join(model_dir, OV_IR_MODEL_FILE),
        device=device,
        ov_cache_dir=ov_cache_dir,
    )
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
    return session, tokenizer


def load_ov_ner(
    model_dir: str,
    device: str,
    ov_cache_dir: Optional[str],
) -> Tuple[OpenVinoSession, Any]:
    """Load a token-classification model as an ORT-shaped session.

    Returns ``(session, tokenizer)``. The caller drives tokenization,
    windowing and BIO aggregation exactly as it does for an ONNX session,
    so both backends share one post-processing chain.

    Args:
        model_dir: Directory with ``openvino_model.xml`` + ``.bin`` +
            tokenizer files. Pre-converted via
            ``optimum-cli export openvino`` or shipped that way.
        device: OpenVINO device token — ``GPU``, ``NPU``, ``CPU``, or
            an ``AUTO:GPU,CPU``-style fallback string.
        ov_cache_dir: Persistent kernel cache path. ``None`` disables.
    """
    logger.info("Loading OpenVINO NER model: dir=%s device=%s", model_dir, device)
    return _load_ov(model_dir, device, ov_cache_dir)


def load_ov_embedding(
    model_dir: str,
    device: str,
    ov_cache_dir: Optional[str],
) -> Tuple[OpenVinoSession, Any]:
    """Load a feature-extraction model as an ORT-shaped session.

    Returns ``(session, tokenizer)`` where ``session.run(None, feed)[0]``
    is the ``last_hidden_state`` of shape (batch, seq_len, hidden).
    Caller mean-pools and L2-normalizes it — same as the ORT path.
    """
    logger.info(
        "Loading OpenVINO embedding model: dir=%s device=%s", model_dir, device
    )
    return _load_ov(model_dir, device, ov_cache_dir)


def load_ov_pplx(
    model_dir: str,
    device: str,
    ov_cache_dir: Optional[str],
) -> Tuple[OpenVinoSession, Any]:
    """Load the PPLX PII-masking model as an ORT-shaped session.

    Returns ``(session, tokenizer)``. ``session.run(None, feed)`` yields
    ``[logits, sensitivity_logits]`` in that order (the ONNX graph's own
    output order); the caller Viterbi-decodes ``logits`` exactly as it
    does for the ONNX Runtime path. Unlike the NER/embedding models, PPLX
    ships as OpenVINO IR only — there is no ONNX sibling to fall back to.
    """
    logger.info("Loading OpenVINO PPLX model: dir=%s device=%s", model_dir, device)
    return _load_ov(model_dir, device, ov_cache_dir)


def device_from_resolved(resolved) -> str:
    """Extract the OpenVINO device token from a ResolvedProviders.

    The factory builds providers as
    ``[("OpenVINOExecutionProvider", {"device_type": "GPU"}), ...]``
    so we read the device_type out of the first provider's options.
    """
    if not resolved.providers or not resolved.provider_options:
        return "CPU"
    opts = resolved.provider_options[0] or {}
    return (opts.get("device_type") or "CPU").upper()
