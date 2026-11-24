import { createEffect, createMemo, onCleanup, type Accessor } from "solid-js";

import { useGlobalSessionSearchScroll } from "~/features/session-global-search";
import type { MessageWithParts } from "../../types";
import { SEARCH_HIGHLIGHT_MARK_ATTR } from "../part-view.highlight";

/** Scrolls the open chat to the message picked in global search, and returns the
 *  search query to highlight in its text parts until the user presses anywhere
 *  other than a highlight. */
export function useGlobalSearchMessageTarget(input: {
  messages: Accessor<MessageWithParts[]>;
  blockIndexByMessageId: Accessor<Map<string, number>>;
  shouldVirtualize: Accessor<boolean>;
  scrollToIndex: (index: number) => void;
  scrollElement: Accessor<HTMLElement | undefined>;
}) {
  const ctx = useGlobalSessionSearchScroll();

  const currentSessionId = createMemo(() => {
    for (const message of input.messages()) {
      const info = message.info as { sessionID?: string; sessionId?: string };
      const sessionId = String(info.sessionID ?? info.sessionId ?? "").trim();
      if (sessionId) return sessionId;
    }
    return "";
  });

  const highlightQuery = createMemo(() => {
    const target = ctx?.scrollTarget() ?? null;
    if (!target?.query || target.sessionId !== currentSessionId()) return undefined;
    return target.query;
  });

  createEffect(() => {
    void ctx?.scrollRequestToken();
    const target = ctx?.scrollTarget() ?? null;
    const messageId = target?.messageId;
    if (!target || !messageId) return;
    const sessionId = currentSessionId();
    if (sessionId && target.sessionId !== sessionId) return;
    if (!input.messages().some((message) => String(message.info.id ?? "") === messageId)) return;

    const index = input.blockIndexByMessageId().get(messageId);
    const useVirtualization = input.shouldVirtualize();

    const timer = window.setTimeout(() => {
      if (useVirtualization && index !== undefined) {
        input.scrollToIndex(index);
        return;
      }
      const escapedId = messageId.replace(/["\\]/g, "\\$&");
      const element = input.scrollElement()?.querySelector(`[data-message-id="${escapedId}"]`);
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);

    onCleanup(() => window.clearTimeout(timer));
  });

  createEffect(() => {
    if (!highlightQuery()) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(`mark[${SEARCH_HIGHLIGHT_MARK_ATTR}]`)) return;
      ctx?.setScrollTarget(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    onCleanup(() => document.removeEventListener("pointerdown", dismiss, true));
  });

  return highlightQuery;
}
