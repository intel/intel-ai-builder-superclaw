import { createEffect, createMemo, createSignal, on, type Accessor } from "solid-js";

import type { InstanceApiClient } from "~/shared/platform/transport/instance-api";
import { t } from "../../i18n";
import type { KnownChat } from "./chat-names";
import { chatRootOf } from "./chat-web-access";

export type ChatGrantClient = Pick<InstanceApiClient, "getChatGrant" | "setChatGrant">;

export type UseChatWebAccessDeps = {
  instanceApiClient: Accessor<ChatGrantClient | null>;
  /** The sessions the app lists, to find the chat a session rolls up to. */
  chats: Accessor<readonly KnownChat[]>;
  /** null is the new-chat screen. */
  selectedSessionId: Accessor<string | null>;
  /** Read the chat again when this changes: an approval answered "for this chat" turns it on. */
  changed?: Accessor<unknown>;
};

/** `allowed: null` is not known: never read, or every request that could have said failed. */
type ChatState = { allowed: boolean | null; note: string | null };

/**
 * Web pages "Ask for approval / Allow for this session". On the new-chat screen the choice is kept here
 * until `applyPreselect` has sent it for the chat `session.create` made and that chat is selected; on a
 * chat it is the Sandbox Manager's, read with `GET` and written with `PUT`.
 */
export function useChatWebAccess(deps: UseChatWebAccessDeps) {
  const [preselected, setPreselected] = createSignal(false);
  // Set from `applyPreselect` until a session is selected: the new-chat screen still shows the choice it sent.
  const [handingOver, setHandingOver] = createSignal(false);
  const [states, setStates] = createSignal<ReadonlyMap<string, ChatState>>(new Map());
  const [writing, setWriting] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [unavailable, setUnavailable] = createSignal(false);
  // A read that started before a write, or during one, would show the state the write replaced; one that
  // answers after a newer read would show the older state. Never reset: replacing the client advances every
  // number instead, so no answer to the old client is taken.
  const writes = new Map<string, number>();
  const reads = new Map<string, number>();
  // Chats whose read was skipped for a write: what changed meanwhile (a dialog allow) may postdate the write's
  // answer, so they are read once it settles.
  const readAfterWrite = new Set<string>();
  const advance = (counters: Map<string, number>, id: string): number => {
    const next = (counters.get(id) ?? 0) + 1;
    counters.set(id, next);
    return next;
  };
  const markWriting = (id: string, on: boolean) =>
    setWriting((ids) => {
      const next = new Set(ids);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const newChat = () => deps.selectedSessionId() === null;
  const root = createMemo(() => {
    const id = deps.selectedSessionId();
    return id === null ? null : chatRootOf(deps.chats(), id);
  });
  const current = () => {
    const id = root();
    return id === null ? undefined : states().get(id);
  };
  const remember = (id: string, state: ChatState) => setStates((known) => new Map(known).set(id, state));

  async function read(client: ChatGrantClient, id: string): Promise<void> {
    if (writing().has(id)) {
      readAfterWrite.add(id);
      return;
    }
    const started = writes.get(id) ?? 0;
    const mine = advance(reads, id);
    try {
      const answer = await client.getChatGrant(id);
      if (reads.get(id) !== mine) return;
      if (writing().has(id) || (writes.get(id) ?? 0) !== started) {
        readAfterWrite.add(id);
        return;
      }
      if (!answer.available) {
        setUnavailable(true);
        return;
      }
      // A failure note describes the state it was shown with; a read that found another state retires it.
      const known = states().get(id);
      remember(id, {
        allowed: answer.allowed,
        note: known !== undefined && known !== null && known.allowed === answer.allowed ? known.note : null,
      });
    } catch {
      if (reads.get(id) !== mine) return;
      if (writing().has(id) || (writes.get(id) ?? 0) !== started) {
        readAfterWrite.add(id);
        return;
      }
      // What the switch last knew may be stale (an approval can have allowed the chat meanwhile): not known.
      remember(id, { allowed: null, note: t("chat_web_access.read_failed") });
    }
  }

  async function write(id: string, allow: boolean): Promise<void> {
    const client = deps.instanceApiClient();
    if (!client) return;
    const mine = advance(writes, id);
    markWriting(id, true);
    let state: ChatState;
    try {
      state = { allowed: (await client.setChatGrant(id, allow)).allowed, note: null };
    } catch {
      state = await afterFailedWrite(client, id, allow);
    }
    if (writes.get(id) === mine) {
      markWriting(id, false);
      remember(id, state);
      if (readAfterWrite.delete(id)) void read(client, id);
    }
  }

  /** A PUT whose answer was lost may still have been taken: what the server says now is what is shown. */
  async function afterFailedWrite(client: ChatGrantClient, id: string, allow: boolean): Promise<ChatState> {
    const failed = t(allow ? "chat_web_access.allow_failed" : "chat_web_access.ask_failed");
    try {
      const answer = await client.getChatGrant(id);
      if (answer.available) return { allowed: answer.allowed, note: answer.allowed === allow ? null : failed };
    } catch {
      // Not read either: the PUT may or may not have been taken.
    }
    return { allowed: null, note: t("chat_web_access.read_failed") };
  }

  createEffect(
    on(deps.instanceApiClient, () => {
      for (const id of new Set([...reads.keys(), ...writes.keys()])) {
        advance(reads, id);
        advance(writes, id);
      }
      readAfterWrite.clear();
      setStates(new Map());
      setUnavailable(false);
      setWriting(new Set<string>());
    }),
  );

  createEffect(
    on(deps.selectedSessionId, (id) => {
      if (id === null || !handingOver()) return;
      setHandingOver(false);
      setPreselected(false);
    }),
  );

  createEffect(
    on([deps.instanceApiClient, root, () => deps.changed?.()], ([client, id]) => {
      if (client && id !== null) void read(client, id);
    }),
  );

  return {
    visible: () => deps.instanceApiClient() !== null && !unavailable() && (newChat() || root() !== null),
    /** null: this chat's setting is not known yet (the new-chat screen always knows its own choice). */
    allowed: (): boolean | null => (newChat() ? preselected() : (current()?.allowed ?? null)),
    busy: () => {
      if (newChat()) return handingOver();
      const id = root();
      return id !== null && writing().has(id);
    },
    note: () => (newChat() ? null : (current()?.note ?? null)),
    setAllowed: (allow: boolean) => {
      if (newChat()) {
        setPreselected(allow);
        return;
      }
      const id = root();
      if (id !== null) void write(id, allow);
    },
    /** Called with the chat `session.create` just made; sends the new-chat choice, if any, and never rejects. */
    applyPreselect: async (rootSessionId: string): Promise<void> => {
      if (!preselected() || handingOver()) return;
      setHandingOver(true);
      remember(rootSessionId, { allowed: true, note: null });
      await write(rootSessionId, true);
    },
    /**
     * Ends a hand-over whose chat was not opened: the chip is enabled again and the next new chat asks each
     * time. A grant the PUT made for the unopened chat is harmless. Nothing to do once that chat is selected.
     */
    endPreselect: () => {
      if (!handingOver()) return;
      setHandingOver(false);
      setPreselected(false);
    },
  };
}

export type ChatWebAccess = ReturnType<typeof useChatWebAccess>;
