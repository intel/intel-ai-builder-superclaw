# Experimental Bonsai local runtime on Windows

This change connects Ternary Bonsai 2.5 27B to SuperClaw's existing local
llama-server lifecycle. It does not implement an edge-server workaround or a
new hybrid router. The validated configuration is an Intel i7-4790K, 16 GB RAM,
and an NVIDIA RTX 3080 Ti with 12 GiB VRAM, using the standard product profile.

## Changes

| Area | Behavior |
| --- | --- |
| Model and bundle catalogs | Pin the Bonsai PTQ1_0 MTP GGUF revision, byte size and SHA-256; pair it with the existing KaLM embedding model. Admission is limited to the tested RTX 3080 Ti name and the declared memory thresholds. |
| Runtime discovery | `LRM_INFERENCE_DIR` selects an absolute directory containing `llama-server.exe`. An invalid explicit override errors instead of falling back to another runtime. With no override, existing SYCL discovery is unchanged. |
| GPU tuning | Bonsai uses 98,304 context tokens, one slot, Q4 KV, 512/256 batch/microbatch, no CPU KV pool and MTP draft maximum 3. Existing B70 tuning remains unchanged. |
| Launch compatibility | A model's explicit `--load-mode` removes the legacy `--no-mmap` option. Existing adapter-name matching pins the CUDA device. |
| Prompt compatibility | Bonsai participates in the Qwen single-system-message normalization and short local-agent prompt. The prompt distinguishes sandbox execution from available host browser tools. |
| Standard-profile permissions | Put an existing catch-all deny before specific rules for `superclaw-default`, preserving actions and nested patterns. OpenCode uses the last matching rule. No new permission grants are added. |
| Standard-profile context | Probe the router's applied context window at startup and before local/auto calls, cache successes for five seconds, and refuse calls when the applied window is unavailable. Persisted-but-unapplied settings are not trusted. Cloud and other providers are unaffected by this hook. |
| SYCL build compatibility | Catch `std::exception` during GPU enumeration so a missing GPU platform can use the existing no-device fallback. Update the patch hash and resulting tree lock. |

## Runtime prerequisite

The stock SYCL binary does not supply the Prism PTQ1_0 CUDA runtime used here.
Provide a trusted, compatible Prism llama.cpp runtime separately. The measured
runtime revision was `f70247610` (CUDA 12.4); no runtime executable or model
weights are added to this repository. `LRM_INFERENCE_DIR` is an operator-level
executable override, not a download or signature-verification mechanism.

Example environment for the process launching ServiceHub (adapt the paths):

```powershell
$env:LRM_INFERENCE_DIR = 'D:\runtimes\prism-llama-cuda'
$env:LRM_MODEL_DIR = 'D:\models\superclaw'
```

Select `local-bonsai-27b` through the existing model/bundle flow after the runtime
is installed. The catalog pins the artifact from
[Prism's Bonsai repository](https://huggingface.co/prism-ml/Ternary-Bonsai-2.5-27B-GGUF/tree/28a7093cc25bc151cc2b284c5570f12ce343fdcf).
Both chat and embedding must be available before evaluating Auto routing.
Embedding availability alone does not supply the trained router artifacts.

## Validation and remaining work

Focused Python and Bun regression tests accompany this change:

```powershell
# From the repository root, with host workspace dependencies installed:
$env:PYTHONPATH = "$PWD\host\llmrouter_manager\src"
& .\host\.venv\Scripts\python.exe -m unittest discover -s host/llmrouter_manager/tests -v
bun test sandbox/agent_config/tests/runtime_plugins.test.ts
```

Historical live measurements and their limits are in
[the evaluation report](bonsai-local-evaluation.md). Those runs used the working
prototype; the cleanup adds regression coverage and stricter context validation,
but has not rerun the full agent benchmarks or rebuilt a redistributable installer.

This remains a draft integration. Before release:

- Package or explicitly gate the compatible runtime: the current catalog checks
  hardware, not whether the installed runtime understands PTQ1_0. Installing the
  model alone on another RTX 3080 Ti machine is insufficient.
- Validate memory headroom on more machines. GPU names are not a free-VRAM probe;
  the full 98K allocation was not filled in the performance sweep.
- Supply and validate trained routing artifacts. Native Auto fell back to cloud
  in the measured installation; cloud-token savings are not established.
- Exercise context changes, server failures and the final cleaned hooks in a
  rebuilt app. A live probe can fail temporarily during startup or restart.
- Run broader platform and full integration checks. The new SYCL patch was
  verified against its source lock; the cleanup did not rebuild SYCL.

## Local configuration outside this PR

The following were part of the workstation experiments, not portable source
changes in this PR: drive layout, downloaded weights/runtime, Telegram token and
pairing, cloud credentials, speech-service settings, running session state, and
the temporary local-only model override used to audit calls. None are committed.
The earlier `SUPERCLAW_ALLOW_SLOW_RAM_CLOUD_ONLY` admission bypass is also omitted;
its original local modification is retained in the running checkout.

No new Telegram, microphone, TTS or general desktop-control implementation is
claimed here. Their setup and exploratory observations must not be confused with
source changes in this diff.
