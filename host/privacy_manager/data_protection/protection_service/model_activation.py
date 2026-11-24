"""Which model directories the sanitizer loads, and the gates that fail closed.

``SanitizeManager`` delegates here. A model directory is used only when it
holds every pinned file at its pinned size (or is the verified per-user
download), and model delivery counts a model as present by the same rule, so
the gate and the loader always agree on the directory.

Requests that need NER call :func:`require_pii_model` (the model is installed)
or :func:`require_ner_loaded` (and the sanitizer actually loaded it). Both
raise ``PiiModelNotReady``: missing or unloadable PII assets must not silently
turn protection off.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from common.errors import PiiModelNotReady
from common.model_names import ov_sibling_name

from protection_service.model_delivery import FAILED, PENDING, ModelDelivery

if TYPE_CHECKING:
    from text_protection._sanitizer_caches import TieredCache

    from protection_service.config import SanitizeConfig
    from protection_service.sanitize_state import SanitizeManager

logger = logging.getLogger(__name__)

# ner_backend_label() values meaning NER is not running.
NER_UNLOADED_LABELS = frozenset({"none", "unknown"})


# --------------------------------------------------------------------------
# Directory resolution
# --------------------------------------------------------------------------


def exe_dir() -> str:
    return str(Path(sys.executable).resolve().parent)


def _bundle_dir() -> str | None:
    return getattr(sys, "_MEIPASS", None)


def _script_dir() -> str:
    return str(Path(__file__).resolve().parent)


def candidate_anchors() -> list[str]:
    anchors = [str(Path.cwd()), exe_dir()]
    bundle = _bundle_dir()
    if bundle:
        anchors.append(bundle)
    anchors.append(_script_dir())
    seen: set[str] = set()
    out: list[str] = []
    for a in anchors:
        if a and a not in seen:
            seen.add(a)
            out.append(a)
    return out


def resolve_path(value: str | None, anchors: list[str]) -> str:
    if not value:
        return value or ""
    if Path(value).is_absolute():
        return value
    for anchor in anchors:
        candidate = Path(anchor) / value
        if candidate.exists() or _ov_sibling_exists(candidate):
            return str(candidate)
    return str(Path(anchors[0]) / value)


def _ov_sibling_exists(path: Path) -> bool:
    """The embedding path names an ONNX dir; only its OpenVINO sibling exists."""
    sibling = ov_sibling_name(path.name)
    return sibling is not None and (path.parent / sibling).is_dir()


def _candidates(
    models: ModelDelivery, value: str | None, anchors: list[str]
) -> tuple[str, list[tuple[Path, str]]] | None:
    """``(manifest model, [(directory holding its files, path for the
    sanitizer)])`` for a relative configured model path, else ``None``."""
    if not value or Path(value).is_absolute():
        return None
    configured = Path(value)
    name = models.manifest_name_for(configured.name)
    if name is None:
        return None
    out = []
    for anchor in anchors:
        path = Path(anchor) / configured
        out.append((path.parent / name, str(path)))
    return name, out


def resolve_model_path(models: ModelDelivery, value: str, anchors: list[str]) -> str:
    """The directory to load a configured model from.

    The verified per-user download wins, then the first anchor whose copy
    matches the manifest. A path naming no manifest model, or a model with no
    matching copy anywhere, resolves as before.
    """
    found = _candidates(models, value, anchors)
    if found is not None:
        name, candidates = found
        spec = models.spec(name)
        if models.is_installed(name):
            return str(models.models_dir / Path(value).name)
        for model_dir, path in candidates:
            if spec is not None and models.directory_verified(name, model_dir):
                return path
    return resolve_path(value, anchors)


def model_requirements(
    config: SanitizeConfig, models: ModelDelivery
) -> tuple[dict[str, list[Path]], str | None]:
    """Manifest models the config uses, with the directories outside the
    per-user download that may hold each; and the PII model's name."""
    anchors = candidate_anchors()
    found = _candidates(models, config.ner_model_path, anchors)
    if found is None:
        return {}, None
    name, candidates = found
    return {name: [model_dir for model_dir, _ in candidates]}, name


def unsupported_model_paths(config: SanitizeConfig, models: ModelDelivery) -> tuple[str, ...]:
    """Configured model paths that the pinned-manifest downloader cannot verify."""
    anchors = candidate_anchors()
    if _candidates(models, config.ner_model_path, anchors) is None:
        return ("ner_model_path",)
    return ()


def existing_models_present(mgr: SanitizeManager) -> bool:
    """Check every configured privacy model against the pinned manifest without downloading."""
    if not mgr.sanitize_enabled or unsupported_model_paths(mgr.config, mgr.models):
        return False
    needed, _ = model_requirements(mgr.config, mgr.models)
    return mgr.models.all_present(needed)


def prepare_models(mgr: SanitizeManager) -> str:
    """Wake the sanitizer and ensure missing models are delivered after consent."""
    if not mgr.sanitize_enabled:
        mgr.models.disable()
        return "disabled"
    if unsupported_model_paths(mgr.config, mgr.models):
        return "unsupported"
    mgr.start_initialize()
    needed, gate_model = model_requirements(mgr.config, mgr.models)
    if not mgr.models.retry_if_due(needed, mgr.reload_models, gate_model=gate_model, force=True):
        mgr.models.start_if_missing(needed, mgr.reload_models, gate_model=gate_model)
    return "preparing"


# --------------------------------------------------------------------------
# Delivery and gates
# --------------------------------------------------------------------------


def start_delivery(mgr: SanitizeManager) -> None:
    """Activate already-verified models; missing ones download only via ``prepare_models``."""
    if not mgr.sanitize_enabled:
        mgr.models.disable()
        return
    needed, gate_model = model_requirements(mgr.config, mgr.models)
    if not mgr.models.all_present(needed):
        return
    mgr.start_initialize()
    if mgr.models.state == PENDING:
        mgr.models.start(needed, mgr.reload_models, gate_model=gate_model)


def _status_extra(models: ModelDelivery) -> dict[str, object]:
    status = models.snapshot()
    return {
        "models_state": status["state"],
        "models_done_bytes": status["done_bytes"],
        "models_total_bytes": status["total_bytes"],
    }


def require_pii_model(mgr: SanitizeManager) -> None:
    """Raise ``PiiModelNotReady`` unless the PII model is installed and active.

    A failed download is retried from here, in the background, once
    ``RETRY_AFTER_FAILURE_S`` has passed since the last attempt.
    """
    start_delivery(mgr)
    models = mgr.models
    if models.state == FAILED:
        needed, gate_model = model_requirements(mgr.config, models)
        models.retry_if_due(needed, mgr.reload_models, gate_model=gate_model)
    if models.gate_open():
        return
    status = models.snapshot()
    if status["state"] == FAILED:
        message = f"PII model unavailable: {status['error']}. The download is retried periodically."
    else:
        message = (
            f"PII model not ready (models_state={status['state']}); retry once "
            f"/health reports models_state=ready"
        )
    raise PiiModelNotReady(message, extra=_status_extra(models))


def require_ner_loaded(mgr: SanitizeManager) -> None:
    """:func:`require_pii_model`, and the sanitizer must have loaded NER."""
    require_pii_model(mgr)
    if not mgr.sanitize_enabled:
        return
    label = mgr.ner_backend_label()
    if mgr.ready and label not in NER_UNLOADED_LABELS:
        return
    reason = mgr.load_error or "the NER model did not load (see the service log)"
    raise PiiModelNotReady(
        f"PII model installed but NER failed to load: {reason}",
        extra={**_status_extra(mgr.models), "ner_backend": label},
    )


def pii_unavailable(mgr: SanitizeManager) -> bool:
    """Whether ``sanitize_degraded_reason`` should read ``pii_model_not_ready``."""
    if not mgr.sanitize_enabled or mgr.models.state == PENDING:
        return False
    if not mgr.models.gate_open():
        return True
    return not mgr.warming_up and (not mgr.ready or mgr.ner_backend_label() in NER_UNLOADED_LABELS)


# --------------------------------------------------------------------------
# Reload
# --------------------------------------------------------------------------


def reload_sanitizer(mgr: SanitizeManager) -> None:
    """Rebuild ``mgr``'s sanitizer in-process once downloaded models are in place.

    Runs on the download thread; a failed rebuild raises and leaves the old
    sanitizer serving. Sessions live on the manager, not the sanitizer, so
    they survive. A rebuild that comes up without NER while the PII model is
    present also raises, without being swapped in, so model delivery asks
    ServiceHub for one restart.
    """
    if not mgr.sanitize_enabled:
        return
    # A rebuild without NER is refused before it is swapped in, so a request that already passed
    # the NER gate never runs on a regex-only replacement.
    close_caches(mgr.rebuild_sanitizer(require_ner=mgr.models.pii_model_present()))
    logger.info(
        "Text sanitizer reloaded with downloaded models (ner_backend=%s)",
        mgr.ner_backend_label(),
    )


def sanitizer_lacks_ner(sanitizer: object) -> bool:
    """Whether a built sanitizer reports no NER backend."""
    try:
        label = sanitizer.ner_backend_label()  # type: ignore[attr-defined]
    except Exception:
        return True
    return label in NER_UNLOADED_LABELS


def close_caches(caches: list[TieredCache]) -> None:
    for cache in caches:
        try:
            cache.close()
        except Exception:
            logger.debug("Error closing tiered cache", exc_info=True)
