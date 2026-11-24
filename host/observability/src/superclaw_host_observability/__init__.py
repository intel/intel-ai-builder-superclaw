"""Shared host observability adapters."""

from .crash import build_crash_record, install_crash_hooks, scrub_crash_text
from .version import resolve_app_version
from .log_masking import mask_url_for_log
__all__ = [
    "build_crash_record",
    "install_crash_hooks",
    "scrub_crash_text",
    "resolve_app_version",
    "mask_url_for_log",
]
