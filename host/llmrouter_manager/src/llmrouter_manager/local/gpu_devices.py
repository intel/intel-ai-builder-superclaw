"""Map a physical GPU adapter onto the device index llama.cpp uses.

``--main-gpu`` / ``--split-mode none`` take a *backend device index*, not an
adapter name, and nothing guarantees that index 0 is the dedicated board: the
WMI probe in :mod:`.hardware` enumerates ``Win32_VideoController`` in its own
order, while the SYCL backend enumerates through Level Zero. On a workstation
that has both an iGPU and a discrete B70 the two orders can disagree, and
pinning the wrong one loads a 19 GB model onto shared memory.

So the index is resolved from llama.cpp's own view of the machine
(``llama-server --list-devices``) by matching the adapter name, rather than
assumed. Output shape (llama.cpp b9982)::

    Available devices:
      SYCL0: Intel(R) Arc(TM) B390 Graphics (15000 MiB, 14500 MiB free)
      SYCL1: Intel(R) Arc(TM) Pro B70 (16384 MiB, 16000 MiB free)

Both helpers are pure/fail-soft: the caller decides what a missing device
means (see ``RouterSupervisor._resolve_main_gpu_index``).
"""

from __future__ import annotations

import re
import subprocess
from collections.abc import Iterable
from pathlib import Path

from loguru import logger

# "  SYCL0: Intel(R) Arc(TM) Pro B70 (16384 MiB, 16000 MiB free)"
#   -> id="SYCL0", description="Intel(R) Arc(TM) Pro B70"
_DEVICE_LINE = re.compile(r"^\s+(?P<id>[A-Za-z][A-Za-z0-9_]*)\s*:\s*(?P<desc>\S.*?)\s*$")
# Only the trailing MEMORY parenthetical is dropped - adapter names carry their
# own brackets ("Intel(R) Arc(TM)"), so a generic "strip from the first (" would
# truncate every description to "Intel". Rows without it (CPU/BLAS) keep their
# full text; keyword matching is substring-based either way.
_TRAILING_MEMORY = re.compile(r"\s*\([^()]*\bMiB\b[^()]*\)$")

# Device enumeration spins up the Level Zero runtime, which on a cold driver can
# take several seconds. Generous, but bounded: the caller keeps the registry's
# pin when this expires rather than failing the launch.
LIST_DEVICES_TIMEOUT_S = 30.0


def list_llama_devices(
    exe: Path, *, timeout_s: float = LIST_DEVICES_TIMEOUT_S
) -> list[tuple[str, str]]:
    """``(device_id, description)`` pairs as llama.cpp enumerates them.

    Returns ``[]`` when the listing cannot be obtained (non-zero exit, timeout,
    unparseable output) - never raises. Blocking; call off the event loop.
    """
    try:
        proc = subprocess.run(
            [str(exe), "--list-devices"],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("llama-server --list-devices failed to run: {!r}", exc)
        return []
    if proc.returncode != 0:
        logger.warning(
            "llama-server --list-devices exited {}: {}",
            proc.returncode,
            (proc.stderr or "").strip()[:400],
        )
        return []

    # llama.cpp logs to stderr; keep stdout too in case a future build moves it.
    devices: list[tuple[str, str]] = []
    in_list = False
    for line in ((proc.stderr or "") + "\n" + (proc.stdout or "")).splitlines():
        if line.strip().lower().startswith("available devices"):
            in_list = True
            continue
        if not in_list:
            continue
        match = _DEVICE_LINE.match(line)
        if match is None:
            # First non-device line ends the block; anything after it (timings,
            # warnings) must not be mistaken for a device.
            if line.strip():
                in_list = False
            continue
        devices.append(
            (match.group("id"), _TRAILING_MEMORY.sub("", match.group("desc")))
        )
    return devices


def resolve_device_index(
    devices: Iterable[tuple[str, str]], keywords: Iterable[str]
) -> int | None:
    """Backend index of the first device whose description matches a *keyword*.

    Keywords are matched case-insensitively as substrings, the same shape as
    the registry's ``igpu_keywords``. The index comes from the device id's own
    ordinal (``SYCL1`` -> 1) rather than the row position, so a listing that
    also carries non-GPU rows cannot shift the pin; position is the fallback
    for an unnumbered id. ``None`` = no device matched.
    """
    wanted = [keyword.strip().lower() for keyword in keywords if keyword.strip()]
    if not wanted:
        return None
    for position, (device_id, description) in enumerate(devices):
        lowered = description.lower()
        if not any(keyword in lowered for keyword in wanted):
            continue
        ordinal = re.search(r"(\d+)$", device_id)
        return int(ordinal.group(1)) if ordinal else position
    return None
