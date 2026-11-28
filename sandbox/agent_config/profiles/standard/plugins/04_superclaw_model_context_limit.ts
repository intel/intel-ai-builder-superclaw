import type { Plugin } from "@opencode-ai/plugin"

/**
 * Keep standard-profile compaction limits aligned with the live local runtime.
 * Unknown aliases otherwise inherit OpenCode's 32K default, even when the
 * server provides a larger window. Cache successful probes for five seconds;
 * retry failures and refuse local turns until an applied window is available.
 */

const CTX_PROBE_TIMEOUT_MS = 2500
const OUTPUT_RESERVE = 8192
// Below this the probe is almost certainly not reporting a real window, and
// overwriting a sane static value with it would make things worse.
const MIN_PLAUSIBLE_CTX = 8192
const ALIASES = ["local-model", "auto"] as const
// chat.params fires on every LLM call; the slider changes rarely.
const PROBE_CACHE_TTL_MS = 5000

type CtxSizeResponse = { applied?: unknown }
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
  if (entry.limit?.context === nctx && entry.limit?.output === OUTPUT_RESERVE) return false
  entry.limit = { ...entry.limit, context: nctx, output: OUTPUT_RESERVE }
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
    // A persisted request is not proof that the server applied that window.
    const value = body.applied
    return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_PLAUSIBLE_CTX
      ? value
      : null
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
      if (input.model.providerID !== "llmrouter" || !isAlias(modelId)) return

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
