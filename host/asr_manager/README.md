# asr_manager — on-device speech-to-text

Local English speech recognition for the composer microphone: Parakeet TDT 0.6B v2 (int8 ONNX
export) on the CPU through onnxruntime. Audio never leaves the machine. An optional second step,
[`refine/`](src/asr_manager/refine/README.md), asks LRM to clean up the transcript.

- **ServiceHub child** `asr_manager`: port `18829`, proxy prefix `/speech-to-text`,
  `startup: on_demand`, depends on `llmrouter_manager` (so ServiceHub injects `LRM_API_KEY` and
  the host-only `LRM_HOST_API_KEY` that refine needs). It follows the `tts_manager` on-demand
  pattern: download on consent, lazy load, idle unload.
- **Contract:** the transcribe wire contract below, shared with the UI
  (`apps/ui/src/features/voice-input/`), and the ServiceHub child lifecycle contract.
- **Allowed dependencies:** numpy and onnxruntime (no torch, no sherpa-onnx), FastAPI/uvicorn,
  httpx, loguru, `superclaw-host-observability`, and `llmrouter-manager` for exactly one function,
  `llmrouter_manager.local.hf_endpoint.resolve_hf_endpoint()`, imported lazily.

## HTTP surface

All paths are under `/speech-to-text/v1` and are called through ServiceHub. Every route except
`GET /health` and `GET /version` (including `/docs` and `/openapi.json`) requires
`X-SuperClaw-Process-Credential`, which ServiceHub's proxy adds after checking the hub token
([`auth.py`](src/asr_manager/auth.py)); a direct caller gets `401 management_credential_required`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness plus model snapshot (`model_loaded`, `weights_present`, `model_status`, `model`, `language`, `sample_rate`). Does not wake a dormant service. |
| GET | `/version` | `{version}`. Does not wake the service. |
| GET | `/status` | ServiceHub template status `{state, version, summary}`; `summary.asr.total_download_bytes` has the exact download size. |
| POST | `/shutdown` | Graceful drain. |
| GET | `/download/status` | Progress snapshot (`state`: `idle`/`downloading`/`verifying`/`loading`/`ready`/`error`, `error`, `model_loaded`, `weights_present`, byte counts). **The call the UI polls, and the one that wakes the service.** |
| POST | `/download` | `202`. Consent-gated ~630 MB fetch, then load. From the error state it re-verifies every file and re-fetches the bad ones. |
| POST | `/prepare` | `202`. Load already-present weights; also the activity ping. |
| POST | `/transcribe` | Inference (below). |
| POST | `/refine` | Optional LLM clean-up of a transcript; see [`refine/README.md`](src/asr_manager/refine/README.md). |
| GET | `/refine/model` | Whether a provider/model's reasoning can be switched off. |
| GET, PUT | `/refine/preference` | The clean-up model, stored host-side. |

ServiceHub answers `503 service_dormant` for `/health` on a dormant on-demand child instead of
starting it, so a 503 there cannot distinguish "not running" from "not downloaded". That is why
`weights_present` is also on `/download/status`.

`/health` `status` is always `"ok"` once the server answers: ServiceHub's readiness gate keys on
it. Model state is in `model_status`, which has exactly three values: `ok` (resident, or weights on
disk ready to load), `loading`, and `needs_download` (no weights, or the last download or load
failed). `total_bytes` on `/download/status` is `0` until a download is in flight.

## `POST /transcribe`

```json
{
  "audio": "<base64>",
  "encoding": "pcm_s16le",
  "sample_rate": 16000,
  "channels": 1,
  "language": "en",
  "dictionary": ["NVMe", "SuperClaw"]
}
```

- `audio`: base64 (the UI's shared transport only sends JSON).
- `encoding`: `pcm_s16le`, or `wav` (RIFF PCM-16, so `curl` can post a file).
- `sample_rate`: exactly `16000`; other rates are rejected, not resampled. `channels`: exactly `1`.
- `language`: absent or `"en"`. The model is English-only and hallucinates English on other
  speech, so an explicit non-English request is refused.
- `dictionary` (optional): up to 250 strings of up to 100 characters each (after trimming), biasing
  the decode toward names and jargon. Blanks and exact duplicates are dropped; each entry is biased
  in its verbatim, lowercase and Capitalised forms. Unknown fields are ignored.
- **Decoder per request:** any usable dictionary entry selects the contextual beam (4 paths,
  `"decode": "beam"`); none selects greedy (`"decode": "greedy"`), at exactly greedy's cost.
- At most **120 s** of audio. The limit comes from ServiceHub's 30 s upstream read timeout, not
  memory (see performance notes).

`200`:

```json
{
  "text": "hello world",
  "language": "en",
  "audio_seconds": 1.52,
  "transcribe_seconds": 0.09,
  "rtf": 0.0592,
  "model": "parakeet-tdt-0.6b-v2-int8",
  "decode": "greedy",
  "refine_gate": {"action": "...", "reason": "..."}
}
```

plus `X-Audio-Seconds`, `X-Transcribe-Seconds` and `X-RTF` headers. `refine_gate` is the audio-based
verdict on whether the clip is worth a clean-up call. **An empty transcript is a `200` with
`"text": ""`**: silence and mis-clicks are normal.

### Errors

Every error body is `{"error": {"code": "...", "message": "..."}}`. That shape matters: ServiceHub's
`error_normalizer` passes an upstream error through only when `code` and `message` are strings, and
replaces anything else with a generic `upstream_error`.

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed JSON or base64, missing field. |
| 400 | `unsupported_encoding` | Not `pcm_s16le`/`wav`, or a non-PCM16 WAV. |
| 400 | `unsupported_sample_rate` | Not 16000, or a WAV header that disagrees. |
| 400 | `unsupported_channels` | Not mono. |
| 400 | `unsupported_language` | Explicit non-English. |
| 400 | `invalid_dictionary` | Not an array of strings (a bare string is refused). |
| 400 | `dictionary_too_large` | Over 250 entries. |
| 400 | `dictionary_entry_too_long` | An entry over 100 characters; the message names its index. |
| 400 | `empty_audio` | Decoded to zero samples. |
| 413 | `audio_too_long` | Over 120 s. |
| 500 | `transcribe_failed` | Inference raised. |
| 503 | `model_not_downloaded` | No weights: show the consent dialog. |
| 503 | `model_loading` | Download, verify or load in flight: keep polling. |
| 503 | `model_load_failed` | Weights present but loading failed. Not retried per request. |
| 503 | `model_unloaded` | Idle-unloaded; a reload was started: retry shortly. |

ServiceHub can also return `service_start_failed`, `service_dormant`, `service_unavailable`,
`service_not_found`, `gateway_timeout`, `request_too_large` and `upstream_error`.

## Model lifecycle

```
no weights ──POST /download──> downloading ──> verifying ──> loading ──> ready
                                                                          │
present, not resident <──idle 900 s── resident <──POST /prepare──────────┘
```

- **Download:** `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx` and `tokens.txt`
  (~630 MB) from Hugging Face `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`. Each file's
  sha256 and byte size is pinned in `recognize/model_state.py` and verified while streaming, so
  progress totals are exact. The smallest files go first.
- **Source:** `resolve_hf_endpoint()` honours an operator-set `HF_ENDPOINT`; otherwise it probes
  huggingface.co and hf-mirror.com in parallel and prefers the official site.
- **Lazy residency:** the port binds and `/health` answers before any weights exist.
- **Idle unload** after 900 s without `/transcribe`, `/prepare` or `/download`. `/transcribe`
  after an unload starts the same background reload as `/prepare` and returns `model_unloaded`.
- **Native import warm-up:** `model_state.warm_native_imports()` runs on the main thread before the
  port binds. An endpoint-security DLL that hooks `LoadLibrary` can deadlock a first native import
  made from a secondary thread, so do not move it.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `PARAKEET_MODEL_DIR` | `%LOCALAPPDATA%\SuperClaw\parakeet` | Model directory. |
| `PARAKEET_ASR_THREADS` | half the physical cores, clamped to `[2, 6]` | onnxruntime intra-op threads; `0` lets onnxruntime decide. `service_cfg.json` deliberately does not pin it. |
| `PARAKEET_ASR_IDLE_UNLOAD_SECONDS` | `900` | `<= 0` disables idle unload. |
| `ASR_HF_REPO` | the pinned repo | Model source; change it together with the hash overrides. |
| `ASR_{ENCODER,DECODER,JOINER,TOKENS}_SHA256` | pinned | Per-file hash override. Blank falls back to the pinned hash; verification cannot be disabled. |
| `HF_ENDPOINT` | auto | Used as-is when set; no public fallback is added. |

Refine has its own variables; see [`refine/README.md`](src/asr_manager/refine/README.md).

The thread default (`__main__._default_threads`, physical cores estimated as logical ÷ 2) is
machine-relative because a fixed value is wrong at both ends: 4 threads is a sliver of a large
workstation and all of a 4-core box. On an 86-core Xeon, a 23.3 s clip took 3.26 s at 1 thread,
1.97 s at 2, 1.13 s at 6 and 0.95 s at 16. The curve is flat past 6, and those cores are what the
agent's `llama-server` uses while the user dictates.

## Run and test

```powershell
cd host
uv sync --all-packages
$env:SERVICEHUB_PROCESS_CREDENTIAL = "dev-only-credential"   # every route but health/version needs it
uv run python -u -m asr_manager --port 18829

# unit tests: no model, no network
uv run --directory host\asr_manager pytest -q
```

Through a running hub:

```powershell
$wav = [Convert]::ToBase64String([IO.File]::ReadAllBytes("sample16k.wav"))
Invoke-RestMethod http://127.0.0.1:<hub port>/speech-to-text/v1/transcribe -Method Post `
  -Headers @{ Authorization = "Bearer <hub token>" } -ContentType application/json `
  -Body (@{ audio = $wav; encoding = "wav"; sample_rate = 16000; channels = 1 } | ConvertTo-Json)
```

CI: `.github/workflows/unit-test-asr-manager.yml`. `tests/test_enc_pipeline_parity.py` checks the
offline and streaming encoder arms against each other.

## Performance notes

Measured on an 86-core Xeon, Windows, against the real export:

- **Post-stop latency is linear in utterance length.** `/transcribe` encodes the whole utterance
  after the user stops: end to end through ServiceHub, 0.20 s for 3.3 s of audio, 1.40 s for
  23.3 s, 6.85 s for 120 s (RTF 0.05–0.065; HTTP overhead ≤ 0.19 s). About one second after
  stopping holds only up to ~16 s of speech on this machine, and ~4–6 s on a box 3–4× slower.
- **The 120 s cap is a transport limit.** A 120 s clip decodes in ~6.1 s greedy and ~7.6 s with a
  dictionary (beam costs 1.2–1.3×, independent of dictionary size). A machine 4× slower is inside
  the 30 s proxy timeout with greedy but just over it with a dictionary. Lowering the cap or a
  per-path proxy timeout is the fix. A 115 s clip is 4.7 MB as base64 JSON (proxy limit 10 MiB).
- **The beam is not casing-neutral:** on 2 of 6 clips, a dictionary containing none of the spoken
  words still changed capitalisation.
- **Cold start:** download, verify and load ~75 s on a fast link; load from disk ~7 s; native
  warm-up 0.27 s.
- **Streaming arm:** `recognize/enc_stream.py` (`EncStream`, `ResumableTdt`) cuts post-stop time
  to 0.2–0.55 s for 66–264 s clips with byte-identical text, because the encode runs while the user
  speaks. **Nothing feeds it yet:** the UI sends one POST after the user stops. Using it needs an
  incremental upload surface (session id plus chunks), which is a wire-contract change.

## Layout

```
src/asr_manager/
  __main__.py               argv/env, native warm-up, idle monitor, uvicorn
  app.py, config.py, auth.py   app factory and error handlers, RuntimeConfig, process-credential gate
  api/errors.py             the error envelope
  api/meta.py               health, status, version, shutdown
  api/asr.py                download/status, download, prepare, transcribe
  api/refine.py             refine, refine/model, refine/preference
  recognize/model_state.py  residency, locks, idle unload, pinned hashes
  recognize/download.py     streaming fetch, sha256, endpoint resolution
  recognize/audio.py        base64 / pcm_s16le / wav → float32, contract validation
  recognize/enc_pipeline.py offline encoder pipeline
  recognize/enc_stream.py   streaming arm (not wired)
  recognize/tdt_beam.py     contextual beam decoder, reached only with a non-empty dictionary
  refine/                   optional LLM clean-up
```

`tdt_beam.py` and the arithmetic in `enc_pipeline.py` are verbatim ports from the upstream
dictation prototype, kept diffable against it.
