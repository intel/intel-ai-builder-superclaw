"""Model directory naming rules shared by the sanitizer and model delivery."""

from __future__ import annotations

_INFIX_FORMS = (("-onnx-", "-ov-"), ("_onnx-", "_ov-"), ("-onnx_", "-ov_"), ("_onnx_", "_ov_"))
_SUFFIX_FORMS = (("-onnx", "-ov"), ("_onnx", "_ov"))


def ov_sibling_name(name: str) -> str | None:
    """OpenVINO IR directory name for an ONNX model directory name.

    ``finance_embedding_onnx-int8`` -> ``finance_embedding_ov-int8``. Returns
    ``None`` when ``name`` follows none of the known patterns.
    """
    for old, new in _INFIX_FORMS:
        if old in name:
            return name.replace(old, new)
    for old, new in _SUFFIX_FORMS:
        if name.endswith(old):
            return name[: -len(old)] + new
    return None
