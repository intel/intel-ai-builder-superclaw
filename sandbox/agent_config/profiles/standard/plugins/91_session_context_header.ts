/**
 * session_context_header — forwards the opencode session id to LLMRouter.
 *
 * Injects a `Superclaw-Session` header on every LLM call via the `chat.headers`
 * hook, so the LLMRouter Manager's serving-policy layer can key its per-session
 * state (CompactionTracker: cloud-sticky, local-compaction budget, fresh-read /
 * blob-resident detection, turn cap) on a STABLE per-session id.
 *
 * Why: the ported routing-service policy layer needs to recognise successive
 * requests from the same agent session (`max_local_compaction`, cloud-sticky,
 * fresh-read jump detection all track state across turns). `Superclaw-Agent`
 * (91_agent_context_header) is per-AGENT, not per-session — two concurrent
 * sessions of the same agent would collide. `chat.headers.input.sessionID` is
 * the opencode session id, unique per conversation, so it is the correct key.
 *
 * Mirrors 91_agent_context_header.ts (same hook, same sanitisation shape). The
 * router degrades safely if the header is absent (treats each request as a fresh
 * session — loses stickiness/budget but never breaks), so this plugin is a pure
 * enhancement.
 */
import type { Plugin } from "@opencode-ai/plugin";

const HEADER_NAME = "Superclaw-Session";
const MAX_LEN = 64;

// opencode session ids are already url-safe (ses_...), but sanitise defensively
// so a malformed id can never break the HTTP header or the router's log format.
function sanitizeSessionId(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LEN);
}

export const SessionContextHeader: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "session-context-header",
      level: "info",
      message:
        "Plugin initialised — will inject Superclaw-Session header via chat.headers hook",
    },
  });

  return {
    "chat.headers": async (input, output) => {
      const raw = (input as { sessionID?: string }).sessionID;
      if (!raw || typeof raw !== "string") return;

      const safe = sanitizeSessionId(raw);
      if (!safe) return;

      output.headers = {
        ...output.headers,
        [HEADER_NAME]: safe,
      };
    },
  };
};

export default SessionContextHeader;
