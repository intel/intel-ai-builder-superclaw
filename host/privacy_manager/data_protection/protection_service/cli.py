"""CLI entry point: ``python -m protection_service`` or ``protection-service``.

Boots the FastAPI app via uvicorn after loading and validating the YAML
config.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from dataclasses import replace
from pathlib import Path

import uvicorn

from protection_service.config import ConfigError, load_config
from protection_service.data_plane_key import load_standalone_data_plane_key
from protection_service.server import create_app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="protection-service",
        description="Run the merged protection-service (file redact + text sanitize) HTTP API.",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="Path to YAML config file. Omit to start with empty defaults.",
    )
    parser.add_argument("--host", default=None, help="Override server.host from config.")
    parser.add_argument("--port", type=int, default=None, help="Override server.port from config.")
    parser.add_argument(
        "--redacts-dir",
        type=Path,
        default=None,
        help="Override redact.redacts_dir. Same effect as PII_APP_REDACTS_DIR env var.",
    )
    parser.add_argument(
        "--log-level",
        default=None,
        help="Override logging.level from config (DEBUG / INFO / WARNING / ERROR).",
    )
    parser.add_argument(
        "--no-sanitize",
        action="store_true",
        help="Disable the text-sanitize pipeline at startup. /v1/text/redact will return 503. "
             "Useful for lightweight deployments without OpenVINO models.",
    )
    parser.add_argument(
        "--probe-device",
        action="store_true",
        help="Probe the host hardware, print the resolved strict device "
             "token (INTEL_GPU / INTEL_NPU / DIRECTML / CUDA / COREML / "
             "CPU) on a single line to stdout, then exit. Used by "
             "tools/resolve-device.ps1 (et al.) to pin the config "
             "without booting the service. Exit code 0 on any successful "
             "resolution, 1 on probe failure.",
    )
    args = parser.parse_args(argv)

    if args.probe_device:
        return _probe_device()

    try:
        config = load_config(args.config)
    except ConfigError as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        return 2

    if args.redacts_dir is not None:
        config = replace(
            config,
            redact=replace(config.redact, redacts_dir=args.redacts_dir),
        )
    if args.no_sanitize:
        config = replace(config, sanitize=replace(config.sanitize, enabled=False))

    log_level = (args.log_level or config.log_level).upper()
    boot_id = (os.environ.get("SUPERCLAW_BOOT_ID") or "").strip() or "-"
    formatter = logging.Formatter(
        f"%(asctime)s.%(msecs)03dZ [%(levelname)s] "
        f"boot_id={boot_id} %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    formatter.converter = time.gmtime
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(formatter)
    logging.basicConfig(level=log_level, handlers=[handler], force=True)

    try:
        data_plane_key = load_standalone_data_plane_key()
    except RuntimeError as exc:
        parser.error(str(exc))
    app = create_app(config, data_plane_key)

    host = args.host or config.server.host
    port = args.port or config.server.port

    logging.getLogger("protection_service").info(
        "Starting protection-service on %s:%d (redacts_dir=%s, sanitize=%s)",
        host, port, config.redact.redacts_dir,
        "enabled" if config.sanitize.enabled else "disabled",
    )
    uvicorn.run(app, host=host, port=port, log_level=log_level.lower())
    return 0


def _probe_device() -> int:
    """Print the strict device token AUTO would resolve to on this host.

    Side-effect-free except for a single line of stdout. Used by the
    partner-side install script to pin ``device:`` in config.yaml so
    later boots fail loudly if the hardware changed instead of silently
    falling back to CPU. The strict tokens map back into
    ``resolve_providers`` 1:1 — no AUTO ambiguity in the pinned config.
    """
    try:
        from text_protection.onnx_providers import resolve_providers
        resolved = resolve_providers("AUTO", ov_cache_dir=None)
        # Map the resolved provider list back to the strict token a
        # human-edited config would use. The first non-CPU provider in
        # the list dictates the choice.
        first = resolved.providers[0] if resolved.providers else "CPUExecutionProvider"
        if first == "OpenVINOExecutionProvider":
            # The provider_options[0] dict carries the OV target
            # ("GPU" / "NPU" / "CPU"); read it back so we pin the
            # right strict token.
            opts = resolved.provider_options[0] if resolved.provider_options else {}
            target = (opts.get("device_type") or "").upper()
            if "GPU" in target:
                token = "INTEL_GPU"
            elif "NPU" in target:
                token = "INTEL_NPU"
            else:
                token = "CPU"  # OpenVINO CPU EP — same as plain CPU for the user
        elif first == "DmlExecutionProvider":
            token = "DIRECTML"
        elif first == "CUDAExecutionProvider":
            token = "CUDA"
        elif first == "CoreMLExecutionProvider":
            token = "COREML"
        else:
            token = "CPU"
        print(token)
        return 0
    except Exception as exc:
        print(f"PROBE_FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
