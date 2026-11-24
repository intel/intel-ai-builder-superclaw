// Not `bun test`: that resolves solid's server build, where createEffect is a
// no-op, so neither the refresh effect nor the idle-transition effect below
// would ever run and every fetch assertion would pass vacuously.
import { describe, expect, test } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createTokenUsage } from "./session.token-usage";
import type {
  LlmRouterClient,
  LlmRouterUsageEvent,
  LlmRouterUsageEventsResponse,
} from "../lib/llmrouter-client";
import type { MessageWithParts } from "../types";

// The controller's fetches are fired from effects, so nothing is observable in
// the same tick. Yielding to the macrotask queue a few times lets the effect,
// its Promise.all, and the paging loop all finish before an assertion runs.
const settle = async (ticks = 6) => {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const usageEvent = (
  over: Partial<LlmRouterUsageEvent> = {},
): LlmRouterUsageEvent => ({
  event_id: "event-1",
  occurred_at: 1,
  session_id: "session-1",
  message_id: "message-1",
  source: "llmrouter",
  provider: "anthropic",
  underlying_model: "claude-sonnet-4",
  alias: null,
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  reasoning_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cost_usd: 0.25,
  trace_id: null,
  ...over,
});

type UsageCall = { sessionId: string; sinceMs: number | undefined };

/**
 * A client whose only real member is `getUsageEvents`; the controller never
 * touches the rest of the surface, so the cast keeps the fixture to the part
 * under test.
 */
const stubClient = (
  respond: (
    call: UsageCall,
    index: number,
  ) => LlmRouterUsageEventsResponse | Promise<LlmRouterUsageEventsResponse>,
) => {
  const calls: UsageCall[] = [];
  const client = {
    getUsageEvents: (params: {
      sessionId: string;
      sinceMs?: number;
      limit?: number;
    }) => {
      const call: UsageCall = {
        sessionId: params.sessionId,
        sinceMs: params.sinceMs,
      };
      calls.push(call);
      return Promise.resolve(respond(call, calls.length - 1));
    },
  } as unknown as LlmRouterClient;
  return { client, calls };
};

const taskMessage = (
  id: string,
  state: Record<string, unknown>,
): MessageWithParts =>
  ({
    info: { id, role: "assistant" },
    parts: [{ type: "tool", tool: "task", state }],
  }) as unknown as MessageWithParts;

const plainMessage = (id: string): MessageWithParts =>
  ({ info: { id, role: "user" }, parts: [] }) as unknown as MessageWithParts;

/** An assistant message whose `count` model calls have finished. */
const stepMessage = (id: string, count: number): MessageWithParts =>
  ({
    info: { id, role: "assistant" },
    parts: Array.from({ length: count }, (_, index) => ({ id: `${id}-finish-${index}`, type: "step-finish" })),
  }) as unknown as MessageWithParts;

describe("createTokenUsage formatting", () => {
  test("drops local backend provider prefixes for user-facing model rows", () => {
    createRoot((dispose) => {
      const usage = createTokenUsage({
        messages: () => [],
        selectedSessionId: () => "session-1",
        llmRouterClient: () => null,
        sessionStatus: () => "idle",
      });

      expect(usage.formatModelLabel("local", "Qwen3-Coder-Next")).toBe("Qwen3-Coder-Next");
      expect(usage.formatModelLabel("llama", "Qwen3-Coder-Next")).toBe("Qwen3-Coder-Next");
      expect(usage.formatModelLabel("edge", "Qwen3-Coder-Next")).toBe("Qwen3-Coder-Next");
      expect(usage.formatModelLabel("local", "auto")).toBe("Auto");
      expect(usage.formatModelLabel("local", "local-model")).toBe("Local");
      expect(usage.formatModelLabel("local-llm", "cloud-model")).toBe("Cloud");
      expect(usage.formatModelLabel("local-llm", "llmrouter/qwen3.5-4b")).toBe("qwen3.5-4b");
      dispose();
    });
  });
});

describe("createTokenUsage fetching", () => {
  test("pages until the cursor is exhausted and keeps every page", async () => {
    const pages: LlmRouterUsageEventsResponse[] = [
      { events: [usageEvent({ event_id: "a" })], next_since_ms: 100 },
      { events: [usageEvent({ event_id: "b" })], next_since_ms: 200 },
      { events: [usageEvent({ event_id: "c" })] },
    ];
    const { client, calls } = stubClient((_call, index) => {
      const page = pages[index];
      if (!page) throw new Error(`unexpected extra page request ${index}`);
      return page;
    });

    await createRoot(async (dispose) => {
      const usage = createTokenUsage({
        messages: () => [],
        selectedSessionId: () => "session-1",
        llmRouterClient: () => client,
        sessionStatus: () => "working",
      });
      await settle();

      expect(calls.map((call) => call.sinceMs)).toEqual([
        undefined,
        100,
        200,
      ]);
      expect(usage.currentSessionTokenTotals()).toEqual({
        inputTokens: 30,
        outputTokens: 15,
        totalCost: 0.75,
      });
      dispose();
    });
  });

  test("stops paging when the cursor stops advancing", async () => {
    // A server that keeps echoing the same cursor would otherwise spin the
    // loop to its 100-page ceiling.
    const { client, calls } = stubClient(() => ({
      events: [usageEvent()],
      next_since_ms: 100,
    }));

    await createRoot(async (dispose) => {
      createTokenUsage({
        messages: () => [],
        selectedSessionId: () => "session-1",
        llmRouterClient: () => client,
        sessionStatus: () => "working",
      });
      await settle();

      expect(calls).toHaveLength(2);
      dispose();
    });
  });

  test("fetches the session's task children alongside the session", async () => {
    const { client, calls } = stubClient((call) => ({
      events: [usageEvent({ session_id: call.sessionId })],
    }));
    const messages = [
      taskMessage("m1", { metadata: { sessionId: "child-a" } }),
      taskMessage("m2", { sessionID: "child-b" }),
      plainMessage("m3"),
    ];

    await createRoot(async (dispose) => {
      createTokenUsage({
        messages: () => messages,
        selectedSessionId: () => "session-1",
        llmRouterClient: () => client,
        sessionStatus: () => "working",
      });

      await settle();

      expect(calls.map((call) => call.sessionId).sort()).toEqual([
        "child-a",
        "child-b",
        "session-1",
      ]);
      dispose();
    });
  });

  test("fetches nested task descendants and includes them in session totals", async () => {
    const { client, calls } = stubClient((call) => ({
      events: [usageEvent({ session_id: call.sessionId })],
    }));
    const rootMessages = [taskMessage("root-task", { metadata: { sessionId: "child-a" } })];
    const childMessages = [taskMessage("child-task", { metadata: { sessionId: "grandchild-a" } })];

    await createRoot(async (dispose) => {
      const usage = createTokenUsage({
        messages: () => rootMessages,
        selectedSessionId: () => "session-1",
        llmRouterClient: () => client,
        sessionStatus: () => "working",
        getMessagesBySessionId: (sessionId) =>
          sessionId === "child-a" ? childMessages : sessionId === "grandchild-a" ? [plainMessage("grandchild-user")] : [],
      });

      await settle();

      expect(calls.map((call) => call.sessionId).sort()).toEqual([
        "child-a",
        "grandchild-a",
        "session-1",
      ]);
      expect(usage.currentSessionTokenTotals()).toEqual({
        inputTokens: 30,
        outputTokens: 15,
        totalCost: 0.75,
      });
      dispose();
    });
  });

  test("fetches already-loaded nested transcripts for activity attribution", async () => {
    const { client, calls } = stubClient((call) => ({
      events: [usageEvent({ session_id: call.sessionId })],
    }));
    const childMessages = new Map<string, MessageWithParts[]>([
      ["child-a", [taskMessage("child-task", { metadata: { sessionId: "child-b" } })]],
      ["child-b", [plainMessage("child-user")]],
    ]);

    await createRoot(async (dispose) => {
      createTokenUsage({
        messages: () => [taskMessage("parent-task", { metadata: { sessionId: "child-a" } })],
        selectedSessionId: () => "session-1",
        llmRouterClient: () => client,
        sessionStatus: () => "working",
        getMessagesBySessionId: (sessionId) =>
          sessionId ? childMessages.get(sessionId) ?? [] : [],
      });
      await settle();

      expect(calls.map((call) => call.sessionId).sort()).toEqual([
        "child-a",
        "child-b",
        "session-1",
      ]);
      dispose();
    });
  });

  test("a failing child fetch does not discard the sessions that succeeded", async () => {
    const { client } = stubClient((call) => {
      if (call.sessionId === "child-a") return Promise.reject(new Error("nope"));
      return { events: [usageEvent()] };
    });
    const messages = [taskMessage("m1", { metadata: { sessionId: "child-a" } })];

    await createRoot(async (dispose) => {
      const usage = createTokenUsage({
        messages: () => messages,
        selectedSessionId: () => "session-1",
        llmRouterClient: () => client,
        sessionStatus: () => "working",
      });
      await settle();

      expect(usage.currentSessionTokenTotals()).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        totalCost: 0.25,
      });
      dispose();
    });
  });

  test("does not fetch without a session or without a client", async () => {
    const { client, calls } = stubClient(() => ({ events: [] }));

    await createRoot(async (dispose) => {
      createTokenUsage({
        messages: () => [],
        selectedSessionId: () => null,
        llmRouterClient: () => client,
        sessionStatus: () => "working",
      });
      createTokenUsage({
        messages: () => [],
        selectedSessionId: () => "session-1",
        llmRouterClient: () => null,
        sessionStatus: () => "working",
      });
      await settle();

      expect(calls).toHaveLength(0);
      dispose();
    });
  });
});

describe("createTokenUsage refresh ordering", () => {
  test("a trigger during an in-flight fetch queues one rerun and keeps both results", async () => {
    let releaseFirst: (() => void) | null = null;
    const { client, calls } = stubClient((_call, index) => {
      if (index === 0) {
        return new Promise<LlmRouterUsageEventsResponse>((resolve) => {
          releaseFirst = () =>
            resolve({ events: [usageEvent({ event_id: "first", occurred_at: 10, prompt_tokens: 3 })] });
        });
      }
      return {
        events: [
          usageEvent({ event_id: "first", occurred_at: 10, prompt_tokens: 3 }),
          usageEvent({ event_id: "second", occurred_at: 20, prompt_tokens: 7 }),
        ],
      };
    });

    await createRoot(async (dispose) => {
      const [messages, setMessages] = createSignal<MessageWithParts[]>([]);
      const usage = createTokenUsage({
        messages,
        selectedSessionId: () => "session-1",
        llmRouterClient: () => client,
        sessionStatus: () => "working",
      });
      await settle();
      expect(calls).toHaveLength(1);

      // Two model calls finish while the first fetch is still open.
      setMessages([stepMessage("m1", 1)]);
      setMessages([stepMessage("m1", 2)]);
      await settle();
      expect(calls).toHaveLength(1);

      releaseFirst?.();
      await settle();
      // Exactly one rerun, reading on from what the first fetch returned.
      expect(calls).toHaveLength(2);
      expect(calls[1]?.sinceMs).toBe(0);
      expect(usage.currentSessionTokenTotals()?.inputTokens).toBe(10);
      dispose();
    });
  });

  test("a trigger landing as a fetch finishes is never lost", async () => {
    // Fire the trigger after each possible number of microtasks once the first
    // fetch resolves, so it also lands between the loop's last check and the
    // in-flight cleanup.
    for (let delay = 0; delay < 12; delay += 1) {
      let releaseFirst: (() => void) | null = null;
      const { client, calls } = stubClient((_call, index) => {
        if (index === 0) {
          return new Promise<LlmRouterUsageEventsResponse>((resolve) => {
            releaseFirst = () => resolve({ events: [] });
          });
        }
        return { events: [] };
      });

      await createRoot(async (dispose) => {
        const [messages, setMessages] = createSignal<MessageWithParts[]>([]);
        createTokenUsage({
          messages,
          selectedSessionId: () => "session-1",
          llmRouterClient: () => client,
          sessionStatus: () => "working",
        });
        await settle();
        releaseFirst?.();
        for (let tick = 0; tick < delay; tick += 1) await Promise.resolve();
        setMessages([stepMessage("m1", 1)]);
        await settle();
        expect(calls, `trigger after ${delay} microtasks`).toHaveLength(2);
        dispose();
      });
    }
  });

  test("a rerun queued after the router client changes uses the new client", async () => {
    let releaseFirst: (() => void) | null = null;
    const first = stubClient(() =>
      new Promise<LlmRouterUsageEventsResponse>((resolve) => {
        releaseFirst = () => resolve({ events: [] });
      }),
    );
    const second = stubClient(() => ({ events: [] }));

    await createRoot(async (dispose) => {
      const [client, setClient] = createSignal<LlmRouterClient>(first.client);
      createTokenUsage({
        messages: () => [],
        selectedSessionId: () => "session-1",
        llmRouterClient: client,
        sessionStatus: () => "working",
      });
      await settle();
      setClient(second.client);
      await settle();
      expect(second.calls).toHaveLength(0);

      releaseFirst?.();
      await settle();
      expect(first.calls).toHaveLength(1);
      expect(second.calls).toHaveLength(1);
      dispose();
    });
  });
  test("after the first read, only newer records are requested and merged by id", async () => {
    const { client, calls } = stubClient((call) => {
      if (call.sinceMs === undefined) {
        return { events: [usageEvent({ event_id: "a", occurred_at: 10_000, prompt_tokens: 1 })] };
      }
      return {
        events: [
          usageEvent({ event_id: "a", occurred_at: 10_000, prompt_tokens: 1 }),
          usageEvent({ event_id: "b", occurred_at: 12_000, prompt_tokens: 2 }),
        ],
      };
    });

    await createRoot(async (dispose) => {
      const [messages, setMessages] = createSignal<MessageWithParts[]>([]);
      const usage = createTokenUsage({
        messages,
        selectedSessionId: () => "session-1",
        llmRouterClient: () => client,
        sessionStatus: () => "working",
      });
      await settle();
      setMessages([stepMessage("m1", 1)]);
      await settle();

      expect(calls.map((call) => call.sinceMs)).toEqual([undefined, 5_000]);
      expect(usage.currentSessionTokenTotals()?.inputTokens).toBe(3);
      dispose();
    });
  });

  test("a new tool part without a finished model call does not refetch", async () => {
    const { client, calls } = stubClient(() => ({ events: [] }));

    await createRoot(async (dispose) => {
      const [messages, setMessages] = createSignal<MessageWithParts[]>([stepMessage("m1", 1)]);
      createTokenUsage({
        messages,
        selectedSessionId: () => "session-1",
        llmRouterClient: () => client,
        sessionStatus: () => "working",
      });
      await settle();
      expect(calls).toHaveLength(1);

      setMessages([
        {
          ...stepMessage("m1", 1),
          parts: [...stepMessage("m1", 1).parts, { id: "t1", type: "tool", tool: "bash", state: { time: { start: 5 } } }],
        } as unknown as MessageWithParts,
      ]);
      await settle();
      expect(calls).toHaveLength(1);
      dispose();
    });
  });

  test("records cleared on the router are dropped by a full re-read", async () => {
    let cleared = false;
    const { client, calls } = stubClient(() => ({
      events: cleared ? [] : [usageEvent({ event_id: "a", occurred_at: 10_000 })],
    }));

    await createRoot(async (dispose) => {
      const [messages, setMessages] = createSignal<MessageWithParts[]>([]);
      const usage = createTokenUsage({
        messages,
        selectedSessionId: () => "session-1",
        llmRouterClient: () => client,
        sessionStatus: () => "working",
      });
      await settle();
      expect(usage.currentSessionTokenTotals()?.inputTokens).toBe(10);

      cleared = true;
      setMessages([stepMessage("m1", 1)]);
      await settle();
      expect(calls.map((call) => call.sinceMs)).toEqual([undefined, 5_000, undefined]);
      expect(usage.currentSessionTokenTotals()).toBeNull();
      dispose();
    });
  });

  test("an unloaded sub-agent is re-read when a loaded session finishes a step", async () => {
    const { client, calls } = stubClient(() => ({ events: [] }));

    await createRoot(async (dispose) => {
      const task = taskMessage("m1", { metadata: { sessionId: "child-a" } });
      const [messages, setMessages] = createSignal<MessageWithParts[]>([task]);
      createTokenUsage({
        messages,
        selectedSessionId: () => "session-1",
        llmRouterClient: () => client,
        sessionStatus: () => "working",
      });
      await settle();
      expect(calls.map((call) => call.sessionId).sort()).toEqual(["child-a", "session-1"]);

      setMessages([task, stepMessage("m2", 1)]);
      await settle();
      expect(calls.slice(2).map((call) => call.sessionId).sort()).toEqual(["child-a", "session-1"]);
      dispose();
    });
  });
  test("refetches on the transition into idle, not at mount and not idle to idle", async () => {
    const { client, calls } = stubClient(() => ({ events: [usageEvent()] }));

    await createRoot(async (dispose) => {
      const [status, setStatus] = createSignal("idle");
      createTokenUsage({
        messages: () => [],
        selectedSessionId: () => "session-1",
        llmRouterClient: () => client,
        sessionStatus: status,
      });
      await settle();
      // Mounting already-idle must not double up with the key-driven refresh.
      expect(calls).toHaveLength(1);

      setStatus("working");
      await settle();
      expect(calls).toHaveLength(1);

      setStatus("idle");
      await settle();
      expect(calls).toHaveLength(2);

      // A status change that is not a transition into idle stays quiet.
      setStatus("idle");
      await settle();
      expect(calls).toHaveLength(2);
      dispose();
    });
  });
});

describe("createTokenUsage presentation", () => {
  test("marks local providers and leaves cloud providers alone", async () => {
    const { client } = stubClient((call) => ({
      events:
        call.sessionId === "session-1"
          ? [
              usageEvent({ provider: "anthropic", underlying_model: "claude-sonnet-4" }),
              usageEvent({
                event_id: "local",
                provider: "ollama",
                underlying_model: "qwen3-coder",
                prompt_tokens: 100,
                completion_tokens: 50,
              }),
            ]
          : [],
    }));

    await createRoot(async (dispose) => {
      const usage = createTokenUsage({
        messages: () => [],
        selectedSessionId: () => "session-1",
        llmRouterClient: () => client,
        sessionStatus: () => "working",
      });
      await settle();

      const byModel = usage.sessionTokensByModel() ?? [];
      const local = byModel.find((m) => m.modelID === "qwen3-coder");
      const cloud = byModel.find((m) => m.modelID === "claude-sonnet-4");
      expect(local?.isLocal).toBe(true);
      expect(cloud?.isLocal).toBe(false);
      // Sorted by volume, so the larger local entry leads.
      expect(byModel[0]?.modelID).toBe("qwen3-coder");
      dispose();
    });
  });

  test("reports no totals for a session with no usage", async () => {
    const { client } = stubClient(() => ({ events: [] }));

    await createRoot(async (dispose) => {
      const usage = createTokenUsage({
        messages: () => [],
        selectedSessionId: () => "session-1",
        llmRouterClient: () => client,
        sessionStatus: () => "working",
      });
      await settle();

      expect(usage.currentSessionTokenTotals()).toBeNull();
      expect(usage.sessionTokensByModel()).toBeNull();
      expect(usage.tokensByMessageId()).toEqual({});
      dispose();
    });
  });

  test("formats token counts compactly", () => {
    createRoot((dispose) => {
      const { formatTokens } = createTokenUsage({
        messages: () => [],
        selectedSessionId: () => null,
        llmRouterClient: () => null,
        sessionStatus: () => "idle",
      });

      expect(formatTokens(0)).toBe("0");
      expect(formatTokens(999)).toBe("999");
      expect(formatTokens(1234)).toBe("1.2k");
      expect(formatTokens(123_456)).toBe("123.5k");
      expect(formatTokens(1_500_000)).toBe("1.50M");
      dispose();
    });
  });

  test("formats model labels without repeating the provider", () => {
    createRoot((dispose) => {
      const { formatModelLabel } = createTokenUsage({
        messages: () => [],
        selectedSessionId: () => null,
        llmRouterClient: () => null,
        sessionStatus: () => "idle",
      });

      expect(formatModelLabel("openai", "gpt-4")).toBe("openai/gpt-4");
      expect(formatModelLabel("local", "qwen3-coder")).toBe("qwen3-coder");
      expect(formatModelLabel("llmrouter", "auto")).toBe("Auto");
      expect(formatModelLabel("llmrouter", "local-model")).toBe("Local");
      expect(formatModelLabel("llmrouter", "cloud-model")).toBe("Cloud");
      expect(formatModelLabel("local-llm", "Qwen3-Coder-Next")).toBe("Qwen3-Coder-Next");
      expect(formatModelLabel("openai", "openai/gpt-4")).toBe("openai/gpt-4");
      expect(formatModelLabel("openai", "")).toBe("openai");
      expect(formatModelLabel("", "gpt-4")).toBe("gpt-4");
      dispose();
    });
  });
});
