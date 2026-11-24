// Ordering and list-update helpers for the session store's collections.
// Pure functions: they take a list and return the next list, and never read the
// store or a signal. Extracted from `session.ts` unchanged.

import type { Part, Session } from "@opencode-ai/sdk/v2/client";

import type {
  MessageInfo,
  MessageWithParts,
  PlaceholderAssistantMessage,
} from "~/shared/types/session";

export const sortById = <T extends { id: string }>(list: T[]) =>
  list.slice().sort((a, b) => a.id.localeCompare(b.id));

export const partsWithIds = (parts: Part[]) =>
  parts.filter((part) => typeof part?.id === "string" && part.id.length > 0);

const sessionActivity = (session: Session) =>
  session.time?.updated ?? session.time?.created ?? 0;

export const sortSessionsByActivity = (list: Session[]) =>
  list.slice().sort((a, b) => {
    const delta = sessionActivity(b) - sessionActivity(a);
    if (delta !== 0) return delta;
    return a.id.localeCompare(b.id);
  });

export const shouldPreserveStreamingCache = (status: string | undefined) =>
  status === "running" || status === "retry";

export const createPlaceholderMessage = (
  part: Part,
): PlaceholderAssistantMessage => ({
  id: part.messageID,
  sessionID: part.sessionID,
  role: "assistant",
  time: { created: Date.now() },
  parentID: "",
  modelID: "",
  providerID: "",
  mode: "",
  agent: "",
  path: { cwd: "", root: "" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

// Keeps the list in activity order, unlike the unsorted `upsertSession` that
// `shared/util/session-collections` exports through the `app/utils` barrel.
export const upsertSession = (list: Session[], next: Session) => {
  const index = list.findIndex((session) => session.id === next.id);
  if (index === -1) return sortSessionsByActivity([...list, next]);
  const copy = list.slice();
  copy[index] = next;
  return sortSessionsByActivity(copy);
};

export const removeSession = (list: Session[], sessionID: string) =>
  list.filter((session) => session.id !== sessionID);

export const upsertMessageInfo = (list: MessageInfo[], next: MessageInfo) => {
  const index = list.findIndex((message) => message.id === next.id);
  if (index === -1) return sortById([...list, next]);
  const copy = list.slice();
  copy[index] = next;
  return copy;
};

export const removeMessageInfo = (list: MessageInfo[], messageID: string) =>
  list.filter((message) => message.id !== messageID);

export const upsertPartInfo = (list: Part[], next: Part) => {
  const index = list.findIndex((part) => part.id === next.id);
  if (index === -1) return sortById([...list, next]);
  const copy = list.slice();
  copy[index] = next;
  return copy;
};

export function mergeStreamingMessageSnapshot(
  snapshot: MessageWithParts[],
  cachedMessages: MessageInfo[],
  cachedPartsByMessageId: Record<string, Part[]>,
): MessageWithParts[] {
  const cachedMessagesById = new Map(
    cachedMessages.map((message) => [message.id, message]),
  );
  const merged = snapshot.map((message) => {
    const cachedParts = partsWithIds(
      cachedPartsByMessageId[message.info.id] ?? [],
    );
    const cachedPartsById = new Map(cachedParts.map((part) => [part.id, part]));
    const parts = partsWithIds(message.parts).map((part) => {
      const cached = cachedPartsById.get(part.id);
      if (
        part.type === "text" &&
        cached?.type === "text" &&
        cached.text.startsWith(part.text)
      ) {
        return { ...part, text: cached.text } as Part;
      }
      return part;
    });
    const snapshotPartIds = new Set(parts.map((part) => part.id));
    for (const cached of cachedParts) {
      if (!snapshotPartIds.has(cached.id)) parts.push(cached);
    }
    cachedMessagesById.delete(message.info.id);
    return { info: message.info, parts: sortById(parts) };
  });

  for (const cached of cachedMessagesById.values()) {
    merged.push({
      info: cached,
      parts: sortById(partsWithIds(cachedPartsByMessageId[cached.id] ?? [])),
    });
  }
  return merged.sort((left, right) =>
    left.info.id.localeCompare(right.info.id),
  );
}

export const removePartInfo = (list: Part[], partID: string) =>
  list.filter((part) => part.id !== partID);

export const appendPartDelta = (
  list: Part[],
  partID: string,
  field: string,
  delta: string,
) => {
  if (!delta) return list;
  const index = list.findIndex((part) => part.id === partID);
  if (index === -1) return list;

  const existing = list[index] as Part & Record<string, unknown>;
  const current = existing[field];
  if (current !== undefined && typeof current !== "string") {
    return list;
  }

  const nextValue = `${typeof current === "string" ? current : ""}${delta}`;
  if (nextValue === current) return list;

  const copy = list.slice();
  copy[index] = { ...existing, [field]: nextValue } as Part;
  return copy;
};
