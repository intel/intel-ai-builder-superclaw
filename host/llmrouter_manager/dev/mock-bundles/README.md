# Local-Bundle inference mock (dev only)

Run SuperClaw as if the `local-27b` Bundle were committed and serving on a B70 box, while the chat
tokens come from OpenRouter under the Bundle's own model id. It lets agents, UI and evals be
developed without that hardware. Implementation:
[`local/mock_bundle.py`](../../src/llmrouter_manager/local/mock_bundle.py).

## What is mocked

| | |
|---|---|
| **Chat** | Served upstream as `qwen/qwen3.8-27b`. Only the upstream wire name changes: `/status`, `/app/capability-profile`, OpenCode and the trajectory inspector still see `qwen3.8-27b` / `local-27b`. The chat role reports the `rerouted` state. |
| **Embedding** | Real. llama-server still runs KaLM locally (~0.5 GB, no hardware requirements), so `auto` routing sees genuine vectors. |
| **Hardware gates** | Bypassed for the mocked Bundle only. Every other Bundle keeps its real verdict (a 32 GB box is still refused `local-35b`). |

While armed, the mock also:

- **Pins `auto` to the local slot**, so a developer testing "the local model" does not silently
  measure a cloud/local mix. Explicit `cloud-model` requests still go to cloud.
- **Enforces the context ceiling.** The n_ctx probe cannot learn a window from a remote endpoint,
  so the mock supplies the one the hardware runs: the booster's discrete-GPU size (`262144`,
  `DISCRETE_GPU_CTX_SIZE`), about `252,928` effective after output reserve and margin. This
  reproduces the `ContextOverflowError` a B70 hits on large inputs. `LATENTFACTOR_MAX_CONTEXT`
  still overrides it.

## Setup

```powershell
# 1. Check the key and slug first: a bad slug becomes a silent 4xx at runtime.
$key = '<your OpenRouter key>'
$body = @{ model='qwen/qwen3.8-27b'
           messages=@(@{role='user'; content='reply with exactly: pong'})
           max_tokens=512 } | ConvertTo-Json -Compress
(Invoke-WebRequest 'https://openrouter.ai/api/v1/chat/completions' -Method POST `
  -Headers @{ Authorization="Bearer $key"; 'Content-Type'='application/json' } `
  -Body $body -UseBasicParsing).Content

# 2. Arm the mock (User scope; no elevation needed).
$repo = '<path to your checkout>'
[Environment]::SetEnvironmentVariable('LRM_MOCK_LOCAL_BUNDLE',        'local-27b', 'User')
[Environment]::SetEnvironmentVariable('LRM_MOCK_LOCAL_REGISTRY_DIR',  "$repo\host\llmrouter_manager\dev\mock-bundles\qwen3.8-27b", 'User')
[Environment]::SetEnvironmentVariable('LRM_MOCK_LOCAL_UPSTREAM_MODEL','qwen/qwen3.8-27b', 'User')
[Environment]::SetEnvironmentVariable('LRM_MOCK_LOCAL_API_KEY',       $key, 'User')
```

`LRM_MOCK_LOCAL_API_BASE` is optional (default `https://openrouter.ai/api/v1`); point it at any
OpenAI-compatible endpoint. Relaunch and commit the `local-27b` Bundle from the UI. Nothing is
downloaded: the mocked asset reports cached.

To disarm, clear `LRM_MOCK_LOCAL_BUNDLE`.

## Guardrails

- **Dev channel only.** With `SUPERCLAW_BUILD_CHANNEL` set to `release-candidate` or `main` the
  mock refuses to arm and logs why, so RC validation still fails honestly on under-spec hardware.
- **Fail-soft.** A missing variable or overlay directory refuses to arm and names the problem; it
  never half-applies.
- **Loud.** Every armed process logs one `WARNING` naming the real upstream.

## Caveats

- **Not evidence** for latency, tokens/sec, context behaviour under load, quantisation artefacts
  or llama-server tool-call quirks. Performance, eval and release sign-off need real hardware.
- **It bills real money.** `qwen/qwen3.8-27b` is a reasoning model: a one-word reply cost 31
  completion tokens, 26 of them reasoning tokens.
- **A small `max_tokens` returns empty content**, not short content: reasoning tokens use the same
  budget (`max_tokens: 32` gives an empty string with `finish_reason: "length"`). Hand-rolled probes
  should ask for a few hundred tokens. The product path uses `8192`.
- **Streaming chunks echo the upstream id** (`qwen/qwen3.8-27b`); only the non-streaming path
  rewrites `model`. Usage attribution always records the served id.

## The overlay

`qwen3.8-27b/` replaces the two packaged registry files (`bundles.builtin.json`,
`models.builtin.json`) at their builtin layer, so it passes the same strict validators as the
shipped data. It carries every shipped Bundle and asset.

- Its `qwen3.8-27b` asset must mirror the shipped one (`repo` `ggml-org/Qwen3.8-27B-GGUF`,
  `filename`, `size_bytes`, `sha256`, `default_ctx`, `requirements`: 32 GB, 4800 MT/s, `B70`), so a
  mocked box resolves the same window and policy a B70 does.
- Launch-only fields (the draft model and the B70 `extra_args`) are left empty: nothing launches
  locally under the mock.
- `local-27b` has `priority` 500 (shipped: 300) so it outranks `local-35b` (400) and is the Bundle
  picked.

When a B70 is available, disarm and use it.
