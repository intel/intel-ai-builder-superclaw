/**
 * agent_context_header — forwards SuperClaw request context to LLMRouter.
 *
 * Injects SuperClaw context headers on every LLM call via the `chat.headers`
 * hook so LLMRouter can:
 *   - attribute each request to the originating agent and OpenCode
 *     session/message for token-usage tracking (`Superclaw-Agent`, session and
 *     message ids); and
 *   - pin the `task` tool's `subagent_type` to the Profile's real dispatchable
 *     agents on the local (llama.cpp) grammar path (`Superclaw-Task-Subagents`).
 *
 * The second header makes the CONTAINER the single source of truth for the
 * sub-agent enum: opencode's live agent registry comes from the active complete
 * Product Profile, so forwarding the dispatchable
 * names keeps the router agent-agnostic (it only stamps the list it is given)
 * and can never desync from a hand-maintained roster. The router degrades
 * safely when the header is absent (no enum injected), so it is a pure
 * enhancement on the local path and a no-op for edge/cloud.
 */
import type { Plugin } from "@opencode-ai/plugin";

const AGENT_HEADER_NAME = "Superclaw-Agent";
const SESSION_HEADER_NAME = "X-Opencode-Session-Id";
const MESSAGE_HEADER_NAME = "X-Opencode-Message-Id";
// Read by llmrouter (proxy.py) for BOTH telemetry span grouping and Langfuse
// session grouping: subagents run in their own OpenCode child session, so
// without the parent id one user turn fans out into several duplicate-looking
// Langfuse session rows (same user text, different session ids).
const PARENT_SESSION_HEADER_NAME = "x-parent-session-id";
const TASK_SUBAGENTS_HEADER_NAME = "Superclaw-Task-Subagents";
const MAX_LEN = 64;

// Only forward header-safe agent names: letters or numbers first, then
// letters, numbers, underscores, or hyphens.
const SAFE_AGENT_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

function sanitizeAgentName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LEN);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export const AgentContextHeader: Plugin = async ({ client }) => {
  // The agent list should not change while this container is running. After we
  // read a non-empty list once, cache it and reuse it for later requests. If the
  // first read fails or returns nothing during startup, do not cache that empty
  // value; try again on the next request.
  let cachedSubagents: string | null = null;

  // Session parentage is immutable in OpenCode. Primary source: the
  // `session.created` event (same proven pattern as
  // 92_superclaw_lineage_budget.ts). Fallback: one `client.session.get`
  // lookup for sessions created before this plugin initialised. Resolved
  // values are cached ("" = confirmed root session); lookup failures are
  // NOT cached so a transient startup error can heal.
  const parentBySession = new Map<string, string>();

  async function parentSessionIdFor(sessionId: string): Promise<string> {
    const cached = parentBySession.get(sessionId);
    if (cached !== undefined) return cached;
    try {
      const { data } = await client.session.get({ path: { id: sessionId } });
      const record = (data ?? {}) as Record<string, unknown>;
      const parent = firstString(record.parentID, record.parentId);
      parentBySession.set(sessionId, parent);
      return parent;
    } catch {
      // Never break the request path; the router degrades to per-session
      // grouping when the header is absent.
      return "";
    }
  }

  async function dispatchableSubagentsHeader(): Promise<string> {
    if (cachedSubagents !== null) return cachedSubagents;
    try {
      const { data } = await client.app.agents();
      const agents = Array.isArray(data) ? data : [];
      // Dispatchable = any agent that is not a `primary` entry point (i.e.
      // `subagent` or `all`); a `task` call never targets a primary agent.
      const names = agents
        .filter((a) => a && a.mode !== "primary" && typeof a.name === "string")
        .map((a) => a.name)
        .filter((name) => SAFE_AGENT_NAME.test(name));
      const header = Array.from(new Set(names)).sort().join(",");
      if (header) cachedSubagents = header;
      return header;
    } catch {
      // Never break the request path; the router simply skips enum injection.
      return "";
    }
  }

  await client.app.log({
    body: {
      service: "agent-context-header",
      level: "info",
      message:
        "Plugin initialised — will inject Superclaw-Agent, OpenCode session, and Superclaw-Task-Subagents headers via chat.headers hook",
    },
  });

  return {
    // Primary parentage source: session.created fires for every child
    // session (task-tool subagents), carrying both ids. Same event shape
    // 92_superclaw_lineage_budget.ts relies on.
    event: async (input) => {
      const e = input.event as any;
      if (e?.type !== "session.created") return;
      const info = e?.properties?.info ?? {};
      const sid = info.id;
      const parent = info.parentID;
      if (typeof sid === "string" && sid) {
        parentBySession.set(sid, typeof parent === "string" ? parent : "");
      }
    },

    "chat.headers": async (input, output) => {
      const ag = input.agent as any;
      const source = input as Record<string, unknown>;
      const message = source.message as Record<string, unknown> | undefined;

      const rawName =
        typeof ag === "string"
          ? ag
          : (ag?.name ?? ag?.id ?? ag?.type ?? ag?.agent ?? "");
      const sessionId = firstString(source.sessionID, source.sessionId);
      // `input.message.id` is the originating user message id, per the real
      // `chat.headers` contract (`message: UserMessage`). The legacy
      // top-level fields never populated it in practice, but are kept as a
      // harmless fallback in case a future OpenCode fork stops nesting it.
      const messageId = firstString(
        message?.id,
        source.messageID,
        source.messageId,
        source.assistantMessageID,
        source.assistantMessageId,
      );

      output.headers = {
        ...output.headers,
      };
      const safe = rawName ? sanitizeAgentName(rawName) : "";
      if (safe) output.headers[AGENT_HEADER_NAME] = safe;
      if (sessionId) output.headers[SESSION_HEADER_NAME] = sessionId;
      if (messageId) output.headers[MESSAGE_HEADER_NAME] = messageId;
      if (sessionId) {
        const parentId = await parentSessionIdFor(sessionId);
        if (parentId) output.headers[PARENT_SESSION_HEADER_NAME] = parentId;
      }

      const subagents = await dispatchableSubagentsHeader();
      if (subagents) output.headers[TASK_SUBAGENTS_HEADER_NAME] = subagents;
    },
  };
};

export default AgentContextHeader;
