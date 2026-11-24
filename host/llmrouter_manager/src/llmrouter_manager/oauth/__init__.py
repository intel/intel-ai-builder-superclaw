"""OAuth PKCE subsystem — ChatGPT (Codex subscription) via LiteLLM.

Login / refresh / DPAPI storage are owned HERE and are authoritative. Dispatch
delegates the Chat-Completions <-> Codex-Responses translation to LiteLLM's
built-in ``chatgpt/`` provider (see ``providers/openai.py`` + ``litellm_bridge``).
"""

from __future__ import annotations

from .constants import OAUTH_PROVIDER_IDS

__all__ = ["OAUTH_PROVIDER_IDS"]
