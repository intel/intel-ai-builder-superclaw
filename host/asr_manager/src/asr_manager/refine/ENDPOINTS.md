# Authoring `endpoints.json`

Written for: an agent (or engineer) asked to produce or refresh the dictation
clean-up endpoint table. Read this before measuring anything.

The machine-readable contract is [`endpoints.schema.json`](./endpoints.schema.json).
This document is the part a schema cannot carry: what to measure, what the
numbers do and do not license you to conclude, and what must never go in the file
at all.

## What the file is for

OpenRouter routes one model id to many upstream endpoints and picks one per
request. On the shipped model that pool spanned a **~16× latency range** and a
**~6× real-cost range**. Without a stated preference every dictation is a lottery
over that whole spread. This file names the preference.

## The one rule that is not negotiable

**An endpoint that ignores the reasoning off switch must never appear in
`order`** — whatever its latency.

Clean-up has no use for chain-of-thought; the answer is a tidied copy of the
input. An endpoint that reasons anyway spends several times the completion budget
on tokens the user never sees, and bills for them. In the shipped measurement the
three violators cost **$0.84–$1.30 per 1000 dictations against $0.21–$0.29** on
the *same list price*, purely in invisible tokens.

Two consequences, and the second is the one people get wrong:

1. Set `honours_reasoning_off: false` on those rows in `measured` and leave them
   out of `order`.
2. Also add them to `REASONING_VIOLATORS` in [`providers.py`](./providers.py) —
   **in code**. That list is sent as OpenRouter's `ignore` on every request. It
   lives in code and not here precisely because this file is optional: a deleted
   or malformed `endpoints.json` must not be able to silently drop a cost guard.
   This file only ever carries the *preference*; the *guard* is code.

## How to measure

Same build, same Product Profile, one machine, one network. For each endpoint
serving the target model id:

1. List the real endpoints — `GET https://openrouter.ai/api/v1/models/<id>/endpoints`.
   Use the `provider_name` **display** strings (`CoreWeave`), not slugs: a slug is
   not the lowercased name (`AtlasCloud` → `atlas-cloud/fp8`), and the display
   names are what has been observed working in the routing block.
2. Pin one endpoint per run: `provider: {"order": ["<name>"], "allow_fallbacks": false}`.
   Fallbacks **off** — a silent reroute mid-measurement reads as the measured
   thing having moved.
3. Send the real clean-up prompt and a realistic dictation (the shipped numbers
   use ~138 visible words), with `reasoning` disabled, over enough repeats to take
   a median — and record the min/max, not just the median.
4. Record per endpoint: `wall_s`, `wall_s_range`, `ttft_s`, `tok_per_s`,
   `completion_tokens`, `usd_per_1000_dictations` (list price × tokens *actually*
   spent), and `honours_reasoning_off`.
5. Drop endpoints that answer HTTP 400/404 for the model. Pinning a dead endpoint
   only produces a confusing hard failure.

### Deriving `order` from the numbers

- Keep only `honours_reasoning_off: true` rows.
- Rank by latency **but only where the ranges separate.** Overlapping
  `wall_s_range`s mean the medians cannot order those endpoints, and inventing an
  order from indistinguishable medians is false precision.
- **Break ties on cost**, which comes from token counts rather than a median and
  is therefore the sturdier axis. In the shipped table `ModelRun` has a better
  median than `GMICloud` (1.17 s vs 1.36 s) but ranges that overlap almost
  completely (0.83–2.46 vs 1.12–1.42) — while the bill differs 3.4× ($0.71 vs
  $0.21). So `GMICloud` is ranked above it.
- Drop "slow **and** dear" endpoints from `order` rather than ranking them last.
  Leaving `allow_fallbacks: true` means they can still serve a request when
  everything preferred is down, which is the right trade against no text at all.
- Keep `order` short. It is a preference, not a ranking of the world.

## What must not go in this file

- **No credentials.** The API key for the provider lives in LRM's DPAPI store
  (`state/providers/<id>.bin`) and is never read, copied or cached here.
- **No context window, `max_tokens` ceiling, or any runtime-variable number.**
  Those are injected at instance creation and owned by the context-window owner
  (AGENTS.md §5c/§5d). Freezing one into a checked artifact means either the
  artifact lies or the value is frozen for the instance's life.
- **No prompt text.** Prompts are data too, but they live in `prompts/` and change
  on a different cadence and a different evidence bar (AGENTS.md §9b).
- **No endpoint you did not actually measure.** An unmeasured guess in `order` is
  worse than an absent file, because the absent file degrades to the provider's
  own balancing — which is at least unbiased.

## Model recommendation for ASR + LLM clean-up

Recommended: **`minimax/minimax-m3` via OpenRouter**, which is what
`providers.PRESET_MODEL` ships.

Why it, specifically — the criteria matter more than the answer, because the
answer will go stale:

| Criterion | Why it decides this | M3 |
| --- | --- | --- |
| Reasoning can be disabled | The hard constraint. Clean-up needs none, and a model that reasons anyway costs 3–5× the tokens and adds its whole reasoning pass to every dictation. | Yes — accepts the off switch |
| Sub-second median on a good endpoint | The pass sits between the user releasing the hotkey and text appearing. Above ~2 s it stops feeling like dictation. | ~0.97 s measured |
| Cheap per call | Dictation is high-frequency and low-value per call. | ~$0.21–0.25 / 1000 |
| A prompt measured against it | The shipped prompt was optimised on this model (DSPy/MIPROv2, content-token F1). A prompt is only known-good for its target. | `prompts/cleanup-m3-dspy-mipro-v1.txt` |
| Instruction adherence on a transform task | Clean-up must not answer, refuse, or summarise the dictation. | Held on a 105-case injection set |

**Do not recommend Gemini for this.** It ignores the reasoning off switch and
does not error when it does, so there is no signal at request time that reasoning
is still on. It is named in `providers._CANNOT_DISABLE_PREFIXES` for that reason.
`minimax/minimax-m2` is excluded too, for the mirror-image reason: it rejects the
off switch with an HTTP 400.

If you replace the model, you must also replace the prompt measurement and this
table — all three were taken together, and carrying one forward alone is how a
"recommendation" becomes a guess.
