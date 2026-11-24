import type { Plugin } from "@opencode-ai/plugin"

/**
 * Set the llmrouter aliases' context window from the model that is actually
 * serving, instead of hard-coding it.
 *
 * The aliases (`local-model`, `auto`) are not in the models.dev catalog, so with
 * no `limit` OpenCode falls back to its own 32000 -- and every layer below is
 * wasted. Measured on a B70/qwen3.8-27b box where llama-server runs with
 * `--ctx-size 262144`: a `read` of a 1000-line log was refused at "7099 headroom
 * of 32000 usable" on the SECOND dispatch, and each task then paid 1-3 lossy
 * summarisation passes and burned its whole 30-step budget. Declaring the real
 * window took the same task from 29 steps to 4-7.
 *
 * A static number in opencode.jsonc cannot be right for every machine: the `pro`
 * profile serves qwen3.8-27b (B70, 256k) AND qwen3.6-35b-a3b (B370/B390, 100k)
 * on disjoint adapters, and the window is user-adjustable at runtime through the
 * GUI slider (`PUT /llm-router/v1/local/ctx-size` -> llama-server restart). So
 * read it from the router instead. `{env:...}` substitution is not an option
 * here -- `limit.context` is typed `number` in the config schema and
 * substitution yields a string.
 *
 * `applied` is what llama-server is genuinely running with, which is also what
 * routing/policy/context_cap.py derives the upstream cap from; using the same
 * source keeps OpenCode's compaction decisions and LRM's clamp in agreement.
 * `output` mirrors `_DEFAULT_OUTPUT_RESERVE` (8192) in that module, which LRM
 * subtracts from the window when computing its cap.
 *
 * The control plane owns the window, so there is no fallback to a config
 * literal. The `config` hook applies the window at startup and never throws.
 * `chat.params` re-probes before every LLM call (short cache), pushes the live
 * value onto the model the engine is about to use, and refuses the turn with a
 * typed ContextWindowUnavailableError when the router reports no window.
 */

const CTX_PROBE_TIMEOUT_MS = 2500
const OUTPUT_RESERVE = 8192
// Below this the probe is almost certainly not reporting a real window, and
// overwriting a sane static value with it would make things worse.
const MIN_PLAUSIBLE_CTX = 8192
const ALIASES = ["local-model", "auto"] as const
// chat.params fires on every LLM call; the slider changes rarely.
const PROBE_CACHE_TTL_MS = 5000

type CtxSizeResponse = { applied?: unknown; ctx_size?: unknown }
type LimitedModel = { limit?: { context?: number; output?: number } }
type ConfigWithModels = {
  provider?: { llmrouter?: { models?: Record<string, LimitedModel | undefined> } }
}

class ContextWindowUnavailableError extends Error {
  readonly code = "context_window_unavailable"
  constructor(model: string) {
    super(
      `context_window_unavailable: the model router did not report a context window for "${model}"; refusing the turn rather than assuming one`,
    )
    this.name = "ContextWindowUnavailableError"
  }
}

function isAlias(id: string): boolean {
  return (ALIASES as readonly string[]).includes(id)
}

function setLimit(entry: LimitedModel, nctx: number): boolean {
  if (entry.limit?.context === nctx) return false
  entry.limit = { context: nctx, output: OUTPUT_RESERVE }
  return true
}

async function fetchAppliedNctx(): Promise<number | null> {
  const base = (process.env.LRM_API_BASE_URL || "")
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "")
  if (!base) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CTX_PROBE_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {}
    const key = process.env.LRM_API_KEY
    if (key) headers["Authorization"] = `Bearer ${key}`
    // egress-surface: lrm_local_ctx_size
    const r = await fetch(`${base}/llm-router/v1/local/ctx-size`, {
      headers,
      signal: controller.signal,
    })
    if (!r.ok) return null
    const j: unknown = await r.json()
    const body: CtxSizeResponse = typeof j === "object" && j !== null ? j : {}
    // `applied` = what llama-server is running with. `ctx_size` is only the
    // persisted override and is null whenever the registry default is in use.
    const v =
      typeof body.applied === "number"
        ? body.applied
        : typeof body.ctx_size === "number"
          ? body.ctx_size
          : null
    return v !== null && v >= MIN_PLAUSIBLE_CTX ? v : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export const SuperclawModelContextLimit: Plugin = async ({ client }) => {
  const log = async (level: "info" | "warn", message: string): Promise<void> => {
    try {
      await client.app.log({ body: { service: "model-context-limit", level, message } })
    } catch {
      // logging must never fail a turn
    }
  }

  let cache: { value: number | null; at: number } | null = null
  const currentNctx = async (): Promise<number | null> => {
    if (cache && Date.now() - cache.at < PROBE_CACHE_TTL_MS) return cache.value
    const value = await fetchAppliedNctx()
    // A failed probe is not cached, so the next call retries.
    cache = value === null ? null : { value, at: Date.now() }
    return value
  }

  return {
    config: async (config) => {
      const models = (config as ConfigWithModels).provider?.llmrouter?.models
      if (!models) return

      // Startup never throws; chat.params refuses the turn if there is still no window.
      const nctx = await currentNctx()
      if (nctx === null) {
        await log("warn", "ctx-size probe failed at startup; turns will be refused until the router reports a window")
        return
      }

      const applied: string[] = []
      for (const alias of ALIASES) {
        const entry = models[alias]
        if (!entry) continue
        const before = entry.limit?.context
        if (setLimit(entry, nctx)) applied.push(`${alias}: ${before ?? "unset"} -> ${nctx}`)
      }
      if (applied.length > 0) await log("info", `context limit from live n_ctx — ${applied.join(", ")}`)
    },

    "chat.params": async (input) => {
      const modelId = input.model.id
      if (!isAlias(modelId)) return

      const nctx = await currentNctx()
      if (nctx === null) {
        const err = new ContextWindowUnavailableError(modelId)
        await log("warn", `${err.message} (window=unknown count=n/a decision=refuse)`)
        throw err
      }
      if (setLimit(input.model as LimitedModel, nctx)) {
        await log("info", `context window ${modelId} -> ${nctx} (window=${nctx} decision=apply)`)
      }
    },
  }
}

export default SuperclawModelContextLimit
