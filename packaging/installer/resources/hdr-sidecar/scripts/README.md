# HDR sidecar developer scripts

Developer tools for the Hybrid Deep Research sidecar. Nothing here ships in the installer: the wheel packages only `src/hybrid_dr_orchestrator`.

- **Owner:** HDR sidecar maintainers (same as `src/`).
- **Allowed dependencies:** the `hybrid_dr_orchestrator` package and its declared dependencies. Run with the sidecar environment (`uv run --extra dev python scripts/<name>.py`).
- **Contract:** none. These scripts call the sidecar's own phase functions and a running `llmrouter_manager`; they change no product behaviour.
- **Tests:** none of their own. The phase functions they call are covered by `tests/`.

## `model_check.py` — per-phase model compatibility

Replays every cloud-model phase of the HDR pipeline (sub-question derivation, web synthesis, plan, section writer, section reviewer, conclusion writer, conclusion scorer, polish) against one or more models, and reports per phase whether the sidecar's own parser accepted the model's real output, plus `finish_reason` and reasoning-token use. Inputs come from a completed HDR session directory, so each phase sees realistic material without a full run.

A model can complete an HDR run and still produce no real report when a phase's output is silently rejected and a fallback takes over; this check names the phase and the reason.

```powershell
# Host inference key of the running llmrouter_manager (DPAPI, current user).
Add-Type -AssemblyName System.Security
$rec = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect(
  [IO.File]::ReadAllBytes("$env:LOCALAPPDATA\SuperClaw\llmrouter_manager\state\inference-key.bin"), $null, 'CurrentUser')) | ConvertFrom-Json
$env:LRM_API_KEY = $rec.host_api_key

uv run --extra dev python scripts/model_check.py `
  --fixture "$env:LOCALAPPDATA\SuperClaw\backend\data\file_tool\hybrid-dr\sessions\<completed session id>" `
  --query "<the question that session answered>" `
  --target openrouter:z-ai/glm-5 --target deepseek:deepseek-flash --target cloud-model `
  --out model_check.json
```

- `provider:model` targets use `/v1/chat/completions/pinned`, so the user's selected `cloud-model` is not changed. Only API-key providers are reachable this way.
- `cloud-model` uses the current selection; it is the only way to check an OAuth provider (GitHub Copilot, OpenAI OAuth).
- Each phase is judged on the content the sidecar's parser received. Checks marked `strict` also require the phase's delimiter block, which production would otherwise recover from with a lenient fallback.
- Exit code is non-zero when any phase fails.
