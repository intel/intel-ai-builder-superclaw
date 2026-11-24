// Public surface of the `workspace-sidebar` slice — import from here, not from a module inside it.

export { createWorkspaceSidebarFeature } from "./useWorkspaceSidebar";
export {
  getPinnedSessionIds,
  getSessionPinStorage,
  splitPinnedSessions,
  togglePinnedSessionId,
} from "./session-pins";
