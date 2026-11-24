import { createSignal, type Accessor } from "solid-js";

import type { GlobalSessionSearchScrollTarget } from "~/features/session-global-search";
import SessionGlobalSearchModal from "../components/session/session-global-search-modal";
import type { MessageWithParts } from "../types";
import type { CommandPaletteSessionOption } from "./session.command-palette";
import {
  loadMessagesUntilPresent,
  type GlobalSessionSearchBackend,
  type GlobalSessionSearchResult,
} from "./session-global-search";

export type CreateSessionGlobalSearchFeatureDeps = {
  sessionOptions: Accessor<CommandPaletteSessionOption[]>;
  activeWorkspaceId: Accessor<string>;
  getMessagesBySessionId: (sessionId: string) => MessageWithParts[];
  ensureSessionLoaded: (sessionId: string) => Promise<void> | void;
  loadEarlierMessages: (sessionId: string) => Promise<void> | void;
  sessionMessageHistoryComplete: (sessionId: string) => boolean;
  searchBackend?: GlobalSessionSearchBackend;
  openSessionFromList: (
    workspaceId: string,
    sessionId: string,
    options?: { focusComposer?: boolean },
  ) => void;
  setScrollTarget: (value: GlobalSessionSearchScrollTarget | null) => void;
};

export function createSessionGlobalSearchFeature(
  deps: CreateSessionGlobalSearchFeatureDeps,
) {
  const [open, setOpen] = createSignal(false);

  const openGlobalSessionSearch = () => setOpen(true);

  const handleSelect = async (result: GlobalSessionSearchResult, query: string) => {
    let messageId = result.matchKind === "content" ? result.messageId : undefined;
    // Backend hits can be older than the loaded session list, and the session
    // route redirects away from IDs it does not know about.
    if (result.workspaceId === deps.activeWorkspaceId()) {
      await deps.ensureSessionLoaded(result.sessionId);
      // The target is set only once the message is loaded: the highlight clears on
      // the next click, so setting it earlier loses it before older pages arrive.
      // A hit beyond the paging budget opens the chat without scrolling.
      if (messageId) {
        const loaded = await loadMessagesUntilPresent({
          sessionId: result.sessionId,
          messageId,
          getMessagesBySessionId: deps.getMessagesBySessionId,
          loadEarlierMessages: deps.loadEarlierMessages,
          isMessageHistoryComplete: deps.sessionMessageHistoryComplete,
        });
        if (!loaded) messageId = undefined;
      }
    }
    deps.setScrollTarget({ sessionId: result.sessionId, messageId, query });
    deps.openSessionFromList(result.workspaceId, result.sessionId, {
      focusComposer: false,
    });
  };

  const Layer = () => (
    <SessionGlobalSearchModal
      open={open()}
      onClose={() => setOpen(false)}
      sessionOptions={deps.sessionOptions()}
      getMessagesBySessionId={deps.getMessagesBySessionId}
      ensureSessionLoaded={deps.ensureSessionLoaded}
      loadEarlierMessages={deps.loadEarlierMessages}
      sessionMessageHistoryComplete={deps.sessionMessageHistoryComplete}
      contentScanWorkspaceId={deps.activeWorkspaceId()}
      searchBackend={deps.searchBackend}
      onSelectResult={handleSelect}
    />
  );

  return { openGlobalSessionSearch, Layer };
}
