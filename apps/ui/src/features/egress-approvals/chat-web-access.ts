/**
 * Which chat web pages "Allow for this session" is about. A chat is its root session, and a sub-agent's
 * session rolls up to it, as the Connector keys a chat grant. A Slack or Telegram chat has nobody to
 * ask in the app and is never offered the chat scope, so it has no switch: the root's title decides,
 * with the rule `06_superclaw_channel_session_marker.ts` applies in the Profiles.
 */
import type { KnownChat } from "./chat-names";

const CHANNEL_TITLE = /^(Slack|Telegram)\//;
const MAX_PARENT_DEPTH = 8;

/** The root session of the chat `sessionId` belongs to; null for a channel's chat or one the app cannot walk. */
export function chatRootOf(chats: readonly KnownChat[], sessionId: string): string | null {
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  let id: string | null | undefined = sessionId;
  for (let depth = 0; id && depth < MAX_PARENT_DEPTH; depth += 1) {
    const chat = byId.get(id);
    if (!chat) return null;
    if (!chat.parentID) return CHANNEL_TITLE.test(chat.title ?? "") ? null : chat.id;
    id = chat.parentID;
  }
  return null;
}
