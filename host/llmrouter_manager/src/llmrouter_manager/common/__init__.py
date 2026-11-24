"""Shared utilities for llmrouter_manager subsystems.

- `cors.py` — CORS config
- `state.py` — atomic JSON state file I/O + DPAPI-encrypted variants
- `dpapi.py` — Windows DPAPI user-scope wrapper around win32crypt
- `store.py` — SQLite KV backing per-user config
- `logging.py` — loguru dual-sink logger (stdout + per-launch file) with
  stdlib ``InterceptHandler`` bridge for third-party libraries
- `usage.py` — token usage `record_usage` hook seam
- `api.py` — meta endpoints + ServiceHub template
"""
