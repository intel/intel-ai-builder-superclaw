"""Cloud provider catalog.

Mirrors ``SETTINGS_PROVIDER_PREFIXES`` in ``packages/app/src/app/app.tsx``
against the opencode ``/provider`` list. Edit ``CATALOG`` by hand when
adding a provider.

Why no separate ``protocol`` field: the ``litellm_provider`` string IS the
protocol identifier (industry pattern — opencode encodes via ``api.npm``,
LiteLLM via ``custom_llm_provider``, Continue via per-provider adapter
classes). Set to a native LiteLLM provider name when one exists in
``litellm.provider_list``, else ``openai`` (OpenAI-compat fallback).

``default_base_url`` is stored in LiteLLM-adapter convention — for
``litellm_provider="anthropic"`` the trailing ``/v1`` MUST be stripped
because LiteLLM's anthropic adapter appends ``/v1/messages`` itself
(locked by ``tests/test_cloud_catalog.py::test_anthropic_provider_entries_use_litellm_url_convention``).
An empty value means the LiteLLM provider has its own built-in endpoint; it is
passed as ``None`` to LiteLLM rather than treated as a missing configuration.

``litellm_provider`` is NOT exposed by ``GET /llm-router/v1/cloud/catalog``
(per plan §6.9).
"""

from __future__ import annotations

from typing import Any


CATALOG: list[dict[str, Any]] = [
    {
        "id": 'deepseek',
        "display_name": 'DeepSeek',
        "default_base_url": 'https://api.deepseek.com',
        "litellm_provider": 'deepseek',
    },
    {
        "id": 'openai',
        "display_name": 'OpenAI',
        "default_base_url": 'https://api.openai.com/v1',
        "litellm_provider": 'openai',
    },
    {
        "id": 'anthropic',
        "display_name": 'Anthropic',
        "default_base_url": '',
        "litellm_provider": 'anthropic',
    },
    {
        "id": 'google',
        "display_name": 'Google',
        "default_base_url": '',
        "litellm_provider": 'gemini',
    },
    {
        "id": 'xai',
        "display_name": 'xAI',
        "default_base_url": '',
        "litellm_provider": 'xai',
    },
    {
        "id": 'mistral',
        "display_name": 'Mistral',
        "default_base_url": '',
        "litellm_provider": 'mistral',
    },
    {
        "id": 'perplexity',
        "display_name": 'Perplexity',
        "default_base_url": '',
        "litellm_provider": 'perplexity',
    },
    {
        "id": 'perplexity-agent',
        "display_name": 'Perplexity Agent',
        "default_base_url": 'https://api.perplexity.ai/v1',
        "litellm_provider": 'openai',
        "models_dev_provider": 'perplexity',
    },
    {
        "id": 'zhipuai',
        "display_name": 'Zhipu AI',
        "default_base_url": 'https://open.bigmodel.cn/api/paas/v4',
        "litellm_provider": 'openai',
    },
    {
        "id": 'zhipuai-coding-plan',
        "display_name": 'Zhipu AI Coding Plan',
        "default_base_url": 'https://open.bigmodel.cn/api/coding/paas/v4',
        "litellm_provider": 'openai',
        "models_dev_provider": 'zhipuai',
    },
    {
        "id": 'zai',
        "display_name": 'Z.AI',
        "default_base_url": 'https://api.z.ai/api/paas/v4',
        "litellm_provider": 'zai',
    },
    {
        "id": 'zai-coding-plan',
        "display_name": 'Z.AI Coding Plan',
        "default_base_url": 'https://api.z.ai/api/coding/paas/v4',
        "litellm_provider": 'zai',
        "models_dev_provider": 'zai',
    },
    {
        "id": 'minimax',
        "display_name": 'MiniMax (minimax.io)',
        "default_base_url": 'https://api.minimax.io/anthropic',
        "litellm_provider": 'anthropic',
    },
    {
        "id": 'minimax-cn',
        "display_name": 'MiniMax (minimaxi.com)',
        "default_base_url": 'https://api.minimaxi.com/anthropic',
        "litellm_provider": 'anthropic',
        "models_dev_provider": 'minimax',
    },
    {
        "id": 'minimax-cn-coding-plan',
        "display_name": 'MiniMax Token Plan (minimaxi.com)',
        "default_base_url": 'https://api.minimaxi.com/anthropic',
        "litellm_provider": 'anthropic',
        "models_dev_provider": 'minimax',
    },
    {
        "id": 'minimax-coding-plan',
        "display_name": 'MiniMax Token Plan (minimax.io)',
        "default_base_url": 'https://api.minimax.io/anthropic',
        "litellm_provider": 'anthropic',
        "models_dev_provider": 'minimax',
    },
    {
        "id": 'alibaba',
        "display_name": 'Alibaba',
        "default_base_url": 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        "litellm_provider": 'openai',
    },
    {
        "id": 'alibaba-cn',
        "display_name": 'Alibaba (China)',
        "default_base_url": 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        "litellm_provider": 'openai',
        "models_dev_provider": 'alibaba',
    },
    {
        "id": 'alibaba-coding-plan',
        "display_name": 'Alibaba Coding Plan',
        "default_base_url": 'https://coding-intl.dashscope.aliyuncs.com/v1',
        "litellm_provider": 'openai',
        "models_dev_provider": 'alibaba',
    },
    {
        "id": 'alibaba-coding-plan-cn',
        "display_name": 'Alibaba Coding Plan (China)',
        "default_base_url": 'https://coding.dashscope.aliyuncs.com/v1',
        "litellm_provider": 'openai',
        "models_dev_provider": 'alibaba',
    },
    {
        "id": 'alibaba-token-plan',
        "display_name": 'Alibaba Token Plan',
        "default_base_url": 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
        "litellm_provider": 'openai',
        "models_dev_provider": 'alibaba',
    },
    {
        "id": 'alibaba-token-plan-cn',
        "display_name": 'Alibaba Token Plan (China)',
        "default_base_url": 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        "litellm_provider": 'openai',
        "models_dev_provider": 'alibaba',
    },
    {
        "id": 'tencent-coding-plan',
        "display_name": 'Tencent Coding Plan (China)',
        "default_base_url": 'https://api.lkeap.cloud.tencent.com/coding/v3',
        "litellm_provider": 'openai',
    },
    {
        "id": 'tencent-tokenhub',
        "display_name": 'Tencent TokenHub',
        "default_base_url": 'https://tokenhub.tencentmaas.com/v1',
        "litellm_provider": 'openai',
    },
    {
        "id": 'xiaomi',
        "display_name": 'Xiaomi',
        "default_base_url": 'https://api.xiaomimimo.com/v1',
        "litellm_provider": 'xiaomi_mimo',
    },
    {
        "id": 'xiaomi-token-plan-ams',
        "display_name": 'Xiaomi Token Plan (Europe)',
        "default_base_url": 'https://token-plan-ams.xiaomimimo.com/v1',
        "litellm_provider": 'xiaomi_mimo',
        "models_dev_provider": 'xiaomi',
    },
    {
        "id": 'xiaomi-token-plan-cn',
        "display_name": 'Xiaomi Token Plan (China)',
        "default_base_url": 'https://token-plan-cn.xiaomimimo.com/v1',
        "litellm_provider": 'xiaomi_mimo',
        "models_dev_provider": 'xiaomi',
    },
    {
        "id": 'xiaomi-token-plan-sgp',
        "display_name": 'Xiaomi Token Plan (Singapore)',
        "default_base_url": 'https://token-plan-sgp.xiaomimimo.com/v1',
        "litellm_provider": 'xiaomi_mimo',
        "models_dev_provider": 'xiaomi',
    },
    {
        "id": 'openrouter',
        "display_name": 'OpenRouter',
        "default_base_url": 'https://openrouter.ai/api/v1',
        "litellm_provider": 'openrouter',
        # App attribution; without it LiteLLM identifies us as "liteLLM".
        "extra_headers": {
            "HTTP-Referer": 'https://github.com/intel/intel-ai-builder',
            "X-Title": 'SuperClaw',
            "X-OpenRouter-Title": 'SuperClaw',
        },
    },
]

_NATIVE_MODELS_ENDPOINTS = {
    "anthropic": ("https://api.anthropic.com/v1/models", "anthropic"),
    "google": ("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", "google"),
    "xai": ("https://api.x.ai/v1/models", "openai"),
    "mistral": ("https://api.mistral.ai/v1/models", "openai"),
    "perplexity": ("https://api.perplexity.ai/v1/models", "openai"),
}


def public_catalog() -> list[dict[str, Any]]:
    """Catalog payload for ``GET /llm-router/v1/cloud/catalog``.

    Provider endpoints and LiteLLM adapter names are LRM implementation details:
    users connect a catalog provider with an API key only.
    """
    return [
        {"id": entry["id"], "display_name": entry["display_name"]}
        for entry in CATALOG
    ]


def get_catalog_entry(provider_id: str) -> dict[str, Any] | None:
    """Return the internal catalog record for a supported provider."""
    return next((entry for entry in CATALOG if entry["id"] == provider_id), None)


def is_catalog_provider(provider_id: str) -> bool:
    """Whether *provider_id* is a product-supported cloud provider."""
    return get_catalog_entry(provider_id) is not None


def get_provider_base_url(provider_id: str) -> str | None:
    """Resolve a catalog provider's fixed LiteLLM endpoint, if it needs one."""
    entry = get_catalog_entry(provider_id)
    if entry is None:
        raise ValueError(f"unsupported provider: {provider_id!r}")
    return str(entry["default_base_url"]) or None


def get_provider_models_url(provider_id: str) -> str:
    entry = get_catalog_entry(provider_id)
    if entry is None:
        raise ValueError(f"unsupported provider: {provider_id!r}")
    native = _NATIVE_MODELS_ENDPOINTS.get(provider_id)
    if native is not None:
        return native[0]
    base_url = str(entry["default_base_url"]).rstrip("/")
    if entry["litellm_provider"] == "anthropic":
        return f"{base_url}/v1/models"
    if not base_url.endswith("/v1"):
        base_url = f"{base_url}/v1"
    return f"{base_url}/models"


def get_provider_models_protocol(provider_id: str) -> str:
    entry = get_catalog_entry(provider_id)
    if entry is None:
        raise ValueError(f"unsupported provider: {provider_id!r}")
    native = _NATIVE_MODELS_ENDPOINTS.get(provider_id)
    if native is not None:
        return native[1]
    return "anthropic" if entry["litellm_provider"] == "anthropic" else "openai"


def get_litellm_provider(provider_id: str) -> str:
    """Look up the LiteLLM provider for a configured id.

    Must be a real LiteLLM provider name (in ``litellm.provider_list``) since
    dispatch builds the model string as ``f"{litellm_provider}/{model_id}"``.
    """
    entry = get_catalog_entry(provider_id)
    if entry is None:
        raise ValueError(f"unsupported provider: {provider_id!r}")
    return str(entry["litellm_provider"])


def get_provider_extra_headers(provider_id: str) -> dict[str, str]:
    """Extra HTTP headers a catalog provider needs on completion calls."""
    entry = get_catalog_entry(provider_id)
    if entry is None:
        return {}
    return dict(entry.get("extra_headers", {}))


def get_models_dev_provider(provider_id: str) -> str:
    entry = get_catalog_entry(provider_id)
    if entry is None:
        raise ValueError(f"unsupported provider: {provider_id!r}")
    return str(entry.get("models_dev_provider", provider_id))
