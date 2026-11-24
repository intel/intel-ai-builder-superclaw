/**
 * Which chat an approval is for. A verifier names the chat a held request belongs to by its root
 * session's `session_ref`, never the raw id, so the dialog hashes each root session the app knows the
 * same way and shows the title that matches. No match shows nothing: the name is never a guess.
 */
import { EGRESS_APPROVAL_SESSION_REF_LABEL } from "@different-ai/openwork-contracts/sandbox-manager-host-api";

/** A session from the app's list; only one without a parent is a chat. */
export type KnownChat = {
  id: string;
  title?: string | null;
  slug?: string | null;
  parentID?: string | null;
};

const refs = new Map<string, Promise<string>>();

/** `sref_` and the first 16 hex characters of SHA-256 over the contract's label and the session id. */
export function sessionRef(sessionId: string): Promise<string> {
  const known = refs.get(sessionId);
  if (known) return known;
  const ref = crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(EGRESS_APPROVAL_SESSION_REF_LABEL + sessionId))
    .then((digest) => {
      const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `sref_${hex.slice(0, 16)}`;
    });
  refs.set(sessionId, ref);
  // A failed hash is not an answer: drop it so the next ask tries again.
  ref.catch(() => {
    if (refs.get(sessionId) === ref) refs.delete(sessionId);
  });
  return ref;
}

/** Each root chat's title, keyed by its `session_ref`. */
export async function chatNamesByRef(chats: readonly KnownChat[]): Promise<ReadonlyMap<string, string>> {
  const roots = chats.filter((chat) => !chat.parentID);
  const named = await Promise.all(
    roots.map(async (chat) => {
      // Read before the await: a Solid effect calling this tracks only what is read synchronously.
      const name = chat.title?.trim() || chat.slug?.trim() || chat.id;
      return [await sessionRef(chat.id), name] as const;
    }),
  );
  return new Map(named);
}
