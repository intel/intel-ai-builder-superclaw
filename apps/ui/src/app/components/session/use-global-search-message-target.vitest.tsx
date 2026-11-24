import { describe, expect, test } from "vitest";
import { createRoot, createSignal } from "solid-js";

import {
  GlobalSessionSearchScrollProvider,
  useGlobalSessionSearchScroll,
} from "~/features/session-global-search";
import type { MessageWithParts } from "../../types";
import { SEARCH_HIGHLIGHT_MARK_ATTR } from "../part-view.highlight";
import { useGlobalSearchMessageTarget } from "./use-global-search-message-target";

const message = (sessionID: string, id: string) =>
  ({ info: { id, sessionID }, parts: [] }) as unknown as MessageWithParts;

const press = (target: Element) =>
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

// Effects are deferred until the root callback returns, so the test acts outside it.
const mount = () =>
  createRoot((dispose) => {
    const [messages, setMessages] = createSignal([message("ses_other", "msg_1")]);
    let ctx: ReturnType<typeof useGlobalSessionSearchScroll>;
    let highlight: () => string | undefined = () => undefined;
    GlobalSessionSearchScrollProvider({
      get children() {
        ctx = useGlobalSessionSearchScroll();
        highlight = useGlobalSearchMessageTarget({
          messages,
          blockIndexByMessageId: () => new Map(),
          shouldVirtualize: () => false,
          scrollToIndex: () => undefined,
          scrollElement: () => undefined,
        });
        return null;
      },
    });
    return { ctx: () => ctx, highlight: () => highlight(), setMessages, dispose };
  });

describe("useGlobalSearchMessageTarget", () => {
  test("highlights the query only in the matching chat and clears on a press outside a highlight", () => {
    const view = mount();
    const mark = document.createElement("mark");
    mark.setAttribute(SEARCH_HIGHLIGHT_MARK_ATTR, "true");
    document.body.append(mark);

    view.ctx()?.setScrollTarget({ sessionId: "ses_cat", messageId: "msg_9", query: "cuban" });
    expect(view.highlight()).toBeUndefined();

    view.setMessages([message("ses_cat", "msg_9")]);
    expect(view.highlight()).toBe("cuban");

    press(mark);
    expect(view.highlight()).toBe("cuban");

    press(document.body);
    expect(view.highlight()).toBeUndefined();

    mark.remove();
    view.dispose();
  });
});
