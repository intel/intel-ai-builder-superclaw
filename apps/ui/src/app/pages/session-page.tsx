/** Session route shell: global task search + SessionView (keeps app.tsx / session.tsx slim). */

import { createMemo } from "solid-js";

import {
  GlobalSessionSearchScrollProvider,
  SessionGlobalSearchProvider,
  useGlobalSessionSearchScroll,
} from "~/features/session-global-search";
import { ChatWebAccessSwitch } from "~/features/egress-approvals";
import { ComposerPickerAccessory } from "../components/session/session-composer";
import type { WorkspaceInfo } from "../lib/tauri";
import { createSessionGlobalSearchFeature } from "./session-global-search-feature";
import { buildCommandPaletteSessionOptions } from "./session.command-palette";
import SessionView, { type SessionViewProps } from "./session";

const workspaceLabel = (workspace: WorkspaceInfo) =>
  workspace.displayName?.trim() ||
  workspace.openworkWorkspaceName?.trim() ||
  workspace.name?.trim() ||
  workspace.path?.trim() ||
  "Worker";

function SessionPageContent(props: SessionViewProps) {
  const { setScrollTarget } = useGlobalSessionSearchScroll()!;

  const sessionSearchPaletteOptions = createMemo(() =>
    buildCommandPaletteSessionOptions(
      props.workspaceSessionGroups,
      props.activeWorkspaceId,
      workspaceLabel,
    ),
  );

  const sessionGlobalSearch = createSessionGlobalSearchFeature({
    sessionOptions: sessionSearchPaletteOptions,
    activeWorkspaceId: () => props.activeWorkspaceId,
    getMessagesBySessionId: props.getMessagesBySessionId,
    ensureSessionLoaded: props.ensureSessionLoaded,
    loadEarlierMessages: props.loadEarlierMessages,
    sessionMessageHistoryComplete: props.sessionMessageHistoryComplete,
    get searchBackend() { return props.searchSessions; },
    setScrollTarget,
    openSessionFromList: (workspaceId, sessionId) => {
      if (workspaceId === props.activeWorkspaceId) {
        props.setView("session", sessionId);
        return;
      }
      void Promise.resolve(props.activateWorkspace(workspaceId)).then(() =>
        props.setView("session", sessionId),
      );
    },
  });

  return (
    <SessionGlobalSearchProvider open={sessionGlobalSearch.openGlobalSessionSearch}>
      <sessionGlobalSearch.Layer />
      <SessionView {...props} />
    </SessionGlobalSearchProvider>
  );
}

export default function SessionPage(props: SessionViewProps) {
  return (
    <GlobalSessionSearchScrollProvider>
      <ComposerPickerAccessory value={() => <ChatWebAccessSwitch access={props.chatWebAccess} />}>
        <SessionPageContent {...props} />
      </ComposerPickerAccessory>
    </GlobalSessionSearchScrollProvider>
  );
}
