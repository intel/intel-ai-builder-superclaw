"""Native Supervisor evidence adapter; readiness is not inferred from process survival."""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from collections.abc import Mapping

from contracts.runtime_deployment_spec import RuntimeDeploymentSpec
from contracts.runtime_supervisor_ready import RuntimeSupervisorReady


def deployment_snapshot(value: object) -> dict[str, object]:
    """Validate and detach the committed deployment from mutable Store values."""
    try:
        return RuntimeDeploymentSpec.model_validate_json(
            json.dumps(value, allow_nan=False), strict=True
        ).model_dump(mode="json")
    except (TypeError, ValueError):
        raise RuntimeError("committed Runtime Deployment is invalid or unavailable") from None


def fingerprint(deployment: Mapping[str, object]) -> str:
    content = json.dumps(deployment, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def read_supervisor_ready(path: Path | None, context: Mapping[str, str] | None) -> dict[str, object] | None:
    if path is None or context is None:
        return None
    try:
        if path.is_symlink():
            return None
        with path.open("rb") as stream:
            payload = stream.read(8193)
        if len(payload) > 8192:
            return None
        evidence = RuntimeSupervisorReady.model_validate_json(payload, strict=True).model_dump(mode="json")
        deployment = deployment_snapshot(json.loads(base64.b64decode(context["runtime_deployment_b64"], validate=True)))
        expected = {
            "deployment_id": deployment["deployment_id"],
            "desired_fingerprint": context["runtime_desired_fingerprint"],
            "runtime_instance_id": context["runtime_instance_id"],
            "launch_attempt_id": context["runtime_launch_attempt_id"],
            "product_profile_id": deployment["product_profile_id"],
            "product_profile_digest": deployment["product_profile_digest"],
            "profile_revision": deployment["profile_revision"],
        }
        matches = (
            fingerprint(deployment) == expected["desired_fingerprint"]
            and all(evidence[key] == value for key, value in expected.items())
            and evidence["components"] == {"opencode": True, "openwork": True}
        )
        return evidence if matches else None
    except (OSError, ValueError, KeyError, TypeError, RuntimeError):
        return None


def supervisor_ready(path: Path | None, context: Mapping[str, str] | None) -> bool:
    return read_supervisor_ready(path, context) is not None