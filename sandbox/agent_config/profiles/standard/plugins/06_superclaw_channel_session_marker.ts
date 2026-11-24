/**
 * channel_session_marker - records which sessions a chat channel owns, and each desktop session's root
 * session, for sc_fetch_url.
 *
 * A session the Slack or Telegram bridge created has no interactive approver: the desktop app is the
 * only place SuperClaw can ask the user to approve reading a page, and a chat thread cannot answer.
 * sc_fetch_url reads the Set this plugin fills and tells the Connector so, which makes the Connector
 * refuse a page outside the search results at once instead of holding it for 90 seconds.
 *
 * The bridge titles every session it creates `Slack/<identity> <peer>` or `Telegram/<identity> <peer>`
 * (sandbox/channels/src/session-lifecycle.ts), and a sub-agent session is a child of its parent, so
 * the root session's title decides. The marker can only make a request fail faster: a wrong mark
 * costs a desktop session its approval prompt, and no mark never allows anything.
 *
 * The same walk also yields the root of a desktop session, which this plugin records in a Map for
 * sc_fetch_url to send as `root_session_id`: it tells the Connector which chat a held request belongs
 * to, so "Allow all sites for this chat" covers that chat's sub-agents too. The root only names a chat;
 * it never widens what one request may read, which the Connector still decides and only the user's
 * answer can extend. A channel session gets no root, and a failed lookup records nothing.
 *
 * Plugins and tools share globalThis (see 08_protected_pipeline_confirm_guard.ts), so the Set and the
 * Map are the hand-off; tools/sc_fetch_url.ts holds the same keys.
 */
import type { Plugin } from "@opencode-ai/plugin";

const CHANNEL_SESSIONS_KEY = "__sc_channel_sessions";
const ROOT_SESSIONS_KEY = "__sc_root_sessions";
const CHANNEL_TITLE = /^(Slack|Telegram)\//;
const MAX_PARENT_DEPTH = 8;

type Resolved = { root: string; owned: boolean };

function channelSessions(): Set<string> {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>;
  return (g[CHANNEL_SESSIONS_KEY] ??= new Set<string>());
}

function rootSessions(): Map<string, string> {
  const g = globalThis as unknown as Record<string, Map<string, string> | undefined>;
  return (g[ROOT_SESSIONS_KEY] ??= new Map<string, string>());
}

export const ChannelSessionMarker: Plugin = async ({ client }) => {
  // Only answers that came back from the server: a failed lookup is asked again, never remembered.
  const decided = new Map<string, Resolved>();

  async function resolveRoot(sessionID: string): Promise<Resolved | undefined> {
    const visited: string[] = [];
    let id: string | undefined = sessionID;
    let resolved: Resolved | undefined;
    for (let depth = 0; id !== undefined && depth < MAX_PARENT_DEPTH; depth += 1) {
      const known = decided.get(id);
      if (known !== undefined) {
        resolved = known;
        break;
      }
      const response = await client.session.get({ path: { id } });
      const session = response.data;
      if (!session) return undefined;
      visited.push(id);
      // Only the root's title counts: a desktop sub-agent may be titled anything.
      if (!session.parentID) {
        resolved = { root: id, owned: CHANNEL_TITLE.test(session.title) };
        break;
      }
      id = session.parentID;
    }
    // Root not reached within the depth limit: undecided, and nothing is remembered.
    if (resolved === undefined) return undefined;
    for (const seen of visited) decided.set(seen, resolved);
    return resolved;
  }

  return {
    "tool.execute.before": async (input) => {
      if (input.tool !== "sc_fetch_url" || channelSessions().has(input.sessionID)) return;
      let resolved: Resolved | undefined;
      try {
        resolved = await resolveRoot(input.sessionID);
      } catch {
        return;
      }
      if (resolved === undefined) return;
      if (resolved.owned) {
        channelSessions().add(input.sessionID);
        return;
      }
      rootSessions().set(input.sessionID, resolved.root);
      rootSessions().set(resolved.root, resolved.root);
    },
  };
};

export default ChannelSessionMarker;
