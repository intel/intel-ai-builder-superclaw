"""SuperClaw LLMRouter Manager service.

Single Windows-host service that owns local GGUF / llama-server lifecycle,
cloud provider configuration + per-request dispatch via LiteLLM, the
auto/local/cloud routing layer, and the PII boundary.
"""

__version__ = "0.1.0"
