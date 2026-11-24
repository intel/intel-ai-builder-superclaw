r"""Smoke-test cloud provider model listing.

Usage from repo root:

    $env:MINIMAX_API_KEY = "..."
    uv run --directory host\llmrouter_manager python scripts/smoke_provider_models.py \
      --provider-id minimax-cn \
      --base-url https://api.minimaxi.com/v1 \
      --litellm-provider minimax

The script prints no API key material. It checks:
1. Direct OpenAI-compatible GET <base_url>/models.
2. LiteLLM scoped get_valid_models(...).
3. The LRM TestClient endpoint GET /llm-router/v1/cloud/providers/{id}/models.
"""

from __future__ import annotations

# pyright: reportMissingImports=false

import argparse
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
import litellm
from fastapi.testclient import TestClient

from llmrouter_manager.app import build_app
from llmrouter_manager.cloud.catalog import get_litellm_provider
from llmrouter_manager.common.management_auth import PROCESS_CREDENTIAL_HEADER
from llmrouter_manager.config import RuntimeConfig

_SMOKE_PROCESS_CREDENTIAL = "smoke-process-credential"

def _redact(value: str) -> str:
    if not value:
        return "<empty>"
    if len(value) <= 8:
        return "<redacted>"
    return f"{value[:4]}...{value[-4:]}"


def _models_url(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if not normalized.endswith("/v1"):
        normalized = f"{normalized}/v1"
    return f"{normalized}/models"


def _summarize_data(data: Any) -> list[str]:
    if not isinstance(data, list):
        return []
    ids: list[str] = []
    for item in data:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            ids.append(item["id"])
        elif isinstance(item, str):
            ids.append(item)
    return ids


def smoke_direct_models(base_url: str, api_key: str, timeout_s: float) -> None:
    url = _models_url(base_url)
    print(f"\n[direct] GET {url}")
    response = httpx.get(
        url,
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=timeout_s,
    )
    print(f"[direct] HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError:
        print(f"[direct] non-json body prefix: {response.text[:200]!r}")
        return

    if isinstance(payload, dict):
        ids = _summarize_data(payload.get("data"))
        print(f"[direct] model_count={len(ids)}")
        for model_id in ids[:30]:
            print(f"  - {model_id}")
        if not ids:
            print(f"[direct] payload keys={sorted(payload.keys())}")
    else:
        print(f"[direct] unexpected JSON type: {type(payload).__name__}")


def smoke_litellm_models(
    litellm_provider: str,
    base_url: str,
    api_key: str,
) -> None:
    print(
        f"\n[litellm] get_valid_models(provider={litellm_provider!r}, api_base={base_url!r})"
    )
    models = litellm.get_valid_models(
        check_provider_endpoint=True,
        custom_llm_provider=litellm_provider,
        api_key=api_key,
        api_base=base_url,
    )
    print(f"[litellm] model_count={len(models)}")
    for model_id in [str(model) for model in models[:30]]:
        print(f"  - {model_id}")


def smoke_lrm_endpoint(provider_id: str, base_url: str, api_key: str) -> None:
    print(f"\n[lrm] TestClient provider_id={provider_id!r} base_url={base_url!r}")

    with TemporaryDirectory() as tmp:
        os.environ["LOCALAPPDATA"] = str(Path(tmp))
        client = TestClient(
            build_app(
                RuntimeConfig(
                    host="127.0.0.1",
                    port=18321,
                    service_name="llmrouter_manager",
                    instance_id="smoke-provider-models",
                    process_credential=_SMOKE_PROCESS_CREDENTIAL,
                )
            ),
            headers={PROCESS_CREDENTIAL_HEADER: _SMOKE_PROCESS_CREDENTIAL},
        )
        put_response = client.put(
            f"/llm-router/v1/cloud/providers/{provider_id}",
            json={"api_key": api_key, "base_url": base_url},
        )
        print(f"[lrm] configure HTTP {put_response.status_code}")
        if put_response.status_code >= 300:
            print(f"[lrm] configure body={put_response.text[:500]}")
            return

        response = client.get(f"/llm-router/v1/cloud/providers/{provider_id}/models")
        print(f"[lrm] models HTTP {response.status_code}")
        try:
            payload = response.json()
        except ValueError:
            print(f"[lrm] non-json body prefix: {response.text[:200]!r}")
            return

        if isinstance(payload, dict):
            print(f"[lrm] source={payload.get('source')!r} provider={payload.get('provider')!r}")
            ids = _summarize_data(payload.get("data"))
            print(f"[lrm] model_count={len(ids)}")
            for model_id in ids[:30]:
                print(f"  - {model_id}")
            if not ids:
                print(f"[lrm] payload={payload}")
        else:
            print(f"[lrm] unexpected JSON type: {type(payload).__name__}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider-id", default="minimax-cn")
    parser.add_argument("--base-url", default="https://api.minimaxi.com/v1")
    parser.add_argument(
        "--api-key",
        default=os.environ.get("MINIMAX_API_KEY") or os.environ.get("LRM_PROVIDER_API_KEY"),
    )
    parser.add_argument(
        "--litellm-provider",
        default=None,
        help="Override LiteLLM provider. Defaults to catalog mapping for provider-id.",
    )
    parser.add_argument("--timeout-s", type=float, default=20.0)
    parser.add_argument("--skip-direct", action="store_true")
    parser.add_argument("--skip-litellm", action="store_true")
    parser.add_argument("--skip-lrm", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    api_key = args.api_key
    if not isinstance(api_key, str) or not api_key:
        print("Missing API key. Set MINIMAX_API_KEY or pass --api-key.")
        return 2

    litellm_provider = args.litellm_provider or get_litellm_provider(args.provider_id)
    print("Provider model-list smoke")
    print(f"provider_id={args.provider_id!r}")
    print(f"base_url={args.base_url!r}")
    print(f"litellm_provider={litellm_provider!r}")
    print(f"api_key={_redact(api_key)}")

    if not args.skip_direct:
        smoke_direct_models(args.base_url, api_key, args.timeout_s)
    if not args.skip_litellm:
        smoke_litellm_models(litellm_provider, args.base_url, api_key)
    if not args.skip_lrm:
        smoke_lrm_endpoint(args.provider_id, args.base_url, api_key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
