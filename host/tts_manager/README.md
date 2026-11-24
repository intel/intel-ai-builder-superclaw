# tts_manager

On-device Kokoro-82M text-to-speech for reply narration, on the host CPU through onnxruntime (no
torch). ServiceHub child `tts_manager`: port `18827`, proxy prefix `/tts-narration`,
`startup: "on_demand"`, loopback bind. It is the reference on-demand implementation named in
[`../servicehub/ADDING_A_SERVICE.md`](../servicehub/ADDING_A_SERVICE.md).

- **Contract:** the ServiceHub child lifecycle contract and the narration API below, called by the
  UI through ServiceHub. No sandbox role reaches this service.
- **Allowed dependencies:** onnxruntime, numpy, misaki (no extras) with spaCy `en_core_web_sm` and
  `num2words`, FastAPI/uvicorn, `superclaw-host-observability`. No torch, no `kokoro-onnx`, nothing
  GPL (see below).

## HTTP surface

All under `/tts-narration/v1`. Every route except `GET /health` and `GET /version` requires
`X-SuperClaw-Process-Credential`, which ServiceHub's proxy adds after checking the hub token
([`auth.py`](src/tts_manager/auth.py)); a direct caller gets `401`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. `status` is always `"ok"`; model state is in `model_loaded`, `weights_present`, `model_status`. Does not wake a dormant service. |
| GET | `/version` | `{version}`. |
| GET | `/status` | ServiceHub template status. |
| POST | `/shutdown` | Graceful exit. |
| GET | `/download/status` | Download and load progress. |
| POST | `/download` | `202`. Consent-gated ~350 MB download, then load. |
| POST | `/prepare` | `202`. Load present weights. |
| POST | `/tts` | `{"text", "voice"?, "language"?, "speed"?}` → `audio/wav` (24 kHz), with `X-Synth-Seconds` and `X-RTF` headers. |

Errors use a flat `{"error": "..."}` body. `/tts` before the model is resident returns `503`; if
the weights are on disk it also starts a background reload, so later segments succeed.

## Lifecycle

- **On demand:** ServiceHub lists the service in its catalog but starts it only on the first
  authenticated business request.
- **Lazy residency:** the port binds and `/health` answers before any model load.
- **Download:** `kokoro-v1.0.onnx` (~325 MB) and `voices-v1.0.bin` (~27 MB) from the kokoro-onnx
  `model-files-v1.0` GitHub release, sha256-pinned, into `%LOCALAPPDATA%\SuperClaw\kokoro`. TLS
  verification is always on. Model files load only from the local directory; there is no network
  fallback at synthesis time.
- **Idle unload** after 3600 s without `/tts`, `/prepare` or `/download`.

## Inference path

Narration is English only (American `a`, British `b`); the UI sends the `english` voice. Chinese
(`z`) and Japanese (`j`) voices are rejected with `400`.

1. misaki `en.G2P(trf=False)` turns text into phonemes.
2. `kokoro_helper.py` splits them at `.,!?;` into chunks under 510 phonemes, maps each chunk to
   token ids with `kokoro_vocab.json`, and picks the voice style row for that token count from
   `voices-v1.0.bin`. `voices.py` / `voices.json` map friendly voice keys to Kokoro voice ids.
3. One onnxruntime session run per chunk (CPU, pinned threads), silence trimmed, chunks
   concatenated at 24 kHz.

## No PyTorch, no GPL

misaki's `en.G2P(trf=False)` uses the small `en_core_web_sm` spaCy model, so the transformer
POS-tagger chain (`spacy-curated-transformers → curated-transformers → torch`) never loads. The
workspace root keeps that chain out of `host/uv.lock` with `override-dependencies`, and pins any
reintroduced torch to the CPU index.

`kokoro-onnx` and misaki's `[en]` extra both require `phonemizer-fork` and `espeakng-loader`
(GPL-3.0), so neither is a dependency. `kokoro_helper.py` does what kokoro-onnx did, and
`tests/test_kokoro_parity.py` checks its output against a kokoro-onnx 0.5.0 reference.

- `tests/test_no_gpl_dependencies.py` keeps the GPL packages out of `host/uv.lock`.
- `packaging/installer/build-gpl-gate.ps1` (run by `build-servicehub.ps1`) fails the build if a
  `phonemizer` or `espeak` module or file reaches the bundle.
- `num2words` is LGPL, not GPL, and `misaki.en` needs it.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `KOKORO_TTS_THREADS` | `6` (set in `service_cfg.json`) | onnxruntime intra-op threads. |
| `KOKORO_TTS_IDLE_UNLOAD_SECONDS` | `3600` | `<= 0` disables idle unload. |
| `KOKORO_MODEL_DIR` | `%LOCALAPPDATA%\SuperClaw\kokoro` | Model directory. |
| `KOKORO_WEIGHTS_PATH`, `KOKORO_VOICES_PATH` | in the model directory | Individual file paths. |
| `KOKORO_WEIGHTS_URL`, `KOKORO_VOICES_URL` | the GitHub release | Download source (for an allow-listed mirror). |
| `KOKORO_WEIGHTS_SHA256`, `KOKORO_VOICES_SHA256` | pinned | Hash override; blank falls back to the pin. |

## Run and test

```powershell
cd host
$env:SERVICEHUB_PROCESS_CREDENTIAL = "dev-only-credential"   # every route but health/version needs it
uv run python -u -m tts_manager --port 18827

uv run --directory tts_manager pytest -q
```

`--port` is required; `--host` defaults to `127.0.0.1`. Outside ServiceHub the identity falls back
to `tts_manager` / `dev-instance`.
