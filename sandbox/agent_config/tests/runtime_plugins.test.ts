import { afterEach, describe, expect, mock, test } from "bun:test"
import { SuperClawPermissionPrecedence } from "../profiles/standard/plugins/00_superclaw_permission_precedence"
import { SuperclawModelContextLimit } from "../profiles/standard/plugins/04_superclaw_model_context_limit"

const originalFetch = globalThis.fetch
const originalBase = process.env.LRM_API_BASE_URL
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalBase === undefined) delete process.env.LRM_API_BASE_URL
  else process.env.LRM_API_BASE_URL = originalBase
})

async function contextHook(body: unknown) {
  process.env.LRM_API_BASE_URL = "http://127.0.0.1:19000/v1"
  const fetcher = mock(async () => Response.json(body))
  globalThis.fetch = fetcher as typeof fetch
  const hooks = await SuperclawModelContextLimit({ client: { app: { log: async () => {} } } } as any)
  return { hooks, fetcher }
}

describe("permission ordering", () => {
  test("default deny comes first without losing scoped denies or asks", async () => {
    const permissions = { read: "allow", bash: { "*": "ask", "rm *": "deny" }, "*": "deny", secret: "deny" }
    const config: any = { agent: { "superclaw-default": { permission: permissions }, other: { permission: permissions } } }
    const hooks = await SuperClawPermissionPrecedence({} as any)
    await hooks.config!(config)
    const actual = config.agent["superclaw-default"].permission
    expect(Object.keys(actual)[0]).toBe("*")
    expect(actual).toEqual(permissions)
    expect(actual.bash).toBe(permissions.bash)
    expect(config.agent.other.permission).toBe(permissions)
    const evaluate = (key: string) => Object.entries(actual).filter(([p]) => p === "*" || p === key).at(-1)?.[1]
    expect(evaluate("read")).toBe("allow")
    expect(evaluate("secret")).toBe("deny")
    expect(evaluate("unknown")).toBe("deny")
  })
  test("does not rewrite another default action", async () => {
    const config: any = { agent: { "superclaw-default": { permission: { read: "deny", "*": "ask" } } } }
    const before = JSON.stringify(config)
    await (await SuperClawPermissionPrecedence({} as any)).config!(config)
    expect(JSON.stringify(config)).toBe(before)
  })
})

describe("live context limits", () => {
  test("updates local/auto, preserves other limits, and caches successful probes", async () => {
    const { hooks, fetcher } = await contextHook({ applied: 98304, ctx_size: 262144 })
    const config: any = { provider: { llmrouter: { models: {
      "local-model": { limit: { context: 32000, output: 4096, input: 90000 } },
      auto: {}, "cloud-model": { limit: { context: 200000, output: 16000 } },
    } } } }
    await hooks.config!(config)
    expect(config.provider.llmrouter.models["local-model"].limit).toEqual({ context: 98304, output: 8192, input: 90000 })
    expect(config.provider.llmrouter.models.auto.limit.context).toBe(98304)
    expect(config.provider.llmrouter.models["cloud-model"].limit.context).toBe(200000)
    const model: any = { id: "local-model", providerID: "llmrouter", limit: {} }
    await hooks["chat.params"]!({ model } as any, {} as any)
    expect(model.limit.context).toBe(98304)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  for (const body of [{ ctx_size: 98304 }, { applied: null }, { applied: 0 }, { applied: 98304.5 }, { applied: "98304" }]) {
    test(`refuses unapplied or malformed window ${JSON.stringify(body)}`, async () => {
      const { hooks, fetcher } = await contextHook(body)
      await hooks.config!({ provider: { llmrouter: { models: { "local-model": {} } } } } as any)
      await expect(hooks["chat.params"]!({ model: { id: "local-model", providerID: "llmrouter" } } as any, {} as any)).rejects.toThrow("context_window_unavailable")
      expect(fetcher).toHaveBeenCalledTimes(2)
    })
  }
  test("leaves cloud and unrelated providers alone", async () => {
    const { hooks, fetcher } = await contextHook({ applied: 98304 })
    for (const model of [{ id: "cloud-model", providerID: "llmrouter" }, { id: "local-model", providerID: "other" }]) {
      await hooks["chat.params"]!({ model } as any, {} as any)
      expect((model as any).limit).toBeUndefined()
    }
    expect(fetcher).toHaveBeenCalledTimes(0)
  })
  test("recovers after transient probe failure", async () => {
    const { hooks } = await contextHook({ applied: 98304 })
    globalThis.fetch = mock(async () => { throw new Error("unavailable") }) as typeof fetch
    const model: any = { id: "local-model", providerID: "llmrouter" }
    await expect(hooks["chat.params"]!({ model } as any, {} as any)).rejects.toThrow("context_window_unavailable")
    globalThis.fetch = mock(async () => Response.json({ applied: 98304 })) as typeof fetch
    await hooks["chat.params"]!({ model } as any, {} as any)
    expect(model.limit.context).toBe(98304)
  })
})
