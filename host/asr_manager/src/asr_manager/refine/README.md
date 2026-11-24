# `asr_manager.refine` — optional LLM clean-up of a dictation transcript

Owner: dictation (same owner as `asr_manager.recognize`).

Takes the raw Parakeet transcript and returns a tidied version: filler removed, self-corrections
resolved, punctuation and structure applied. Optional in every sense: off unless the user enables
it in the UI, unavailable when nothing can serve it, and every failure degrades to the raw
transcript.

## Modes, and which of them leave the machine

| Mode | LRM request | Model | Leaves the machine? |
|---|---|---|---|
| `agent` | `/v1/chat/completions`, `model: "cloud-model"` | the cloud model configured for agents | yes |
| `local` | `/v1/chat/completions`, `model: "local-model"`, `X-SuperClaw-Require-On-Device: 1` | the committed primary Bundle | **no** |
| `preset` | `/v1/chat/completions/pinned`, `provider: "openrouter"` | the stored preference, default `minimax/minimax-m3` | yes |

`local` adds no engine or download of its own: it is LRM's alias route, so the model is whatever
the committed Binding selected. LRM refuses it with `on_device_required` when `local-model`
resolves to a remote edge backend, reported here as `424 refine_not_on_device`. LRM's supervisor
already launches `llama-server` with reasoning off, which is the one property clean-up needs. The
`local` body omits `disable_thinking` and `usage_alias`, because the local dispatch forwards the
body verbatim to `llama-server`.

The transcript is split from `/transcribe` on purpose: the user gets the text at ASR speed, and a
slow or failed clean-up never delays or loses it.

## Contract

Implements, under `/speech-to-text/v1` ([`api/refine.py`](../api/refine.py)):

| Method | Path | Purpose |
|---|---|---|
| POST | `/refine` | `{text, mode}` → cleaned transcript. `mode` is `agent` (default), `preset` or `local`; `text` at most 20 000 characters (`400 text_too_long`). A `model` field is refused (`400 model_not_accepted`). |
| GET | `/refine/model?provider=&model=` | Whether that model's reasoning can be disabled (`reasoning_support`), plus the recommended preset. No arguments describes the preset. |
| GET, PUT | `/refine/preference` | The clean-up model `preset` mode uses, stored in `%LOCALAPPDATA%\SuperClaw\asr_manager\refine-preference.json`. |

The model is held host-side, never taken from the request, so a caller that reaches `/refine`
can only spend on the model the user chose. Like every `asr_manager` route these need the
ServiceHub process credential.

The audio-based gate rules run during `/transcribe` (which has the samples) and return as
`refine_gate`; `/refine` re-checks only the transcript length and does not trust the caller.

It is a client of LRM's data plane, reachable because `service_cfg.json` makes `asr_manager`
depend on `llmrouter_manager`, which makes ServiceHub inject the keys:

- **`LRM_API_KEY`**, the shared key (the sandbox has it too). Used by `agent` and `local`; the
  alias route resolves the user's committed selection, so the caller cannot pick a model.
- **`LRM_HOST_API_KEY`**, the host-only key ServiceHub withholds from the sandbox. Required by
  `preset`, because `/pinned` names its own provider, model and `usage_alias`
  (`dictation-refine`). Under ServiceHub (`SERVICEHUB_MANAGED=1`) a missing host key makes `preset`
  fail closed with `424 refine_not_configured`, never a retry on the shared key. Standalone, LRM
  issues one key for both planes.

| Env var | Effect |
|---|---|
| `LRM_BASE_URL` | LRM base URL (default `http://127.0.0.1:18321`). |
| `ASR_REFINE_PREFERENCE_PATH` | Override the preference file. |
| `DICTATION_REFINE_ENDPOINTS` | Replacement for `endpoints.json`. |

Error codes are `refine_*` (`refine_no_model`, `refine_not_on_device`, `refine_not_configured`,
`refine_timeout`, `refine_unreachable`, `refine_unauthorized`, …) in the standard
`{"error": {"code", "message"}}` envelope.

## Allowed dependencies

- `numpy` for the gate's amplitude maths; `httpx` for the loopback call to LRM (always
  `trust_env=False`).
- `api/refine.py` and `api/asr.py` may import from this package; **nothing here imports from
  `api/`**, so the gate and the client stay testable without a FastAPI app.
- No cloud SDK, provider client or credential store. Provider keys live in LRM and must never be
  read, cached or forwarded here.

## Modules

| Module | Job |
|---|---|
| `gate.py` | Whether a clip is worth a model call (pure, no I/O). |
| `prompt.py` | System prompts, the anti-injection fence (`wrap_transcript()`), the output budget. |
| `providers.py` | Which cloud model may be chosen and which endpoints may serve it; `REASONING_VIOLATORS`. |
| `preference.py` | The stored clean-up model. |
| `client.py` | The one outbound call. Raises `RefineError`; never invents text. |
| `prompts/cleanup-m3-dspy-mipro-v1.txt` | Prompt for `agent` and `preset`: MiniMax M3's DSPy/MIPROv2 winner. |
| `prompts/cleanup-m3-dspy-combo-v1.txt` | Prompt for `local`: the same plus one letter/salutation-layout sentence. |
| `prompts/cleanup-qwen4b-dspy-mipro-v1.txt` | Retired; kept so old `prompt_id` values resolve. |
| `endpoints.json` | Optional measured OpenRouter endpoint preferences (below). |

### Prompts

Both active prompts are M3-optimised. On the 23-case v2 test set (9 prompt-injection cases), on
Qwen3.5-4B, N=3 per arm with decode seeds 42/43/44:

| Prompt | judge | content-F1 | injection F1 |
|---|---:|---:|---:|
| `cleanup-qwen4b-dspy-mipro-v1` (retired) | 81.44 | 85.23 | 74.8 |
| `cleanup-m3-dspy-combo-v1` (`local`) | **86.87** | **90.37** | **90.7** |

On Qwen3.8-27B the same swap goes from 92.48 to 93.74 judge, so no per-model selection is needed.
Both files are read whole, with the `# ---- few-shot demos ----` block inside the system message.
That is how they were measured, and demo placement changes the scores. Prompt changes need
before/after numbers on the same set.

### `endpoints.json`

Ranks OpenRouter upstream endpoints for the preset model by measured latency and real token cost.
Delete it or point `DICTATION_REFINE_ENDPOINTS` elsewhere and refine still works, using the
provider's own balancing. Its contract is [`endpoints.schema.json`](./endpoints.schema.json); how
to measure and author one is in [`ENDPOINTS.md`](./ENDPOINTS.md).

`providers.REASONING_VIOLATORS` (endpoints measured to ignore the reasoning-off switch and bill
3–5× the tokens) is code, not data, so a missing data file cannot drop that guard.

## Tests

```powershell
uv run --directory host\asr_manager pytest -q tests/test_refine_gate.py tests/test_refine_providers.py tests/test_refine_client.py tests/test_refine_route.py
```

The route test drives `/refine` through `TestClient` with the outbound call patched; there is no
live-cloud test in this lane. CI runs the whole `asr_manager` suite through
`.github/workflows/unit-test-asr-manager.yml`.
