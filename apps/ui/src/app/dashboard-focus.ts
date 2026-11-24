import type { DashboardTab, View } from "./types";

const SETTINGS_TABS: readonly DashboardTab[] = [
  "settings",
  "scheduled",
  "skills",
  "mcp",
  "identities",
  "agent",
  "config",
];

export const isSettingsTab = (tab: DashboardTab): tab is Exclude<DashboardTab, "data"> =>
  SETTINGS_TABS.includes(tab);

/** Advanced and Data & Usage are focused pages: the session sidebar is hidden on them. */
export const hidesSessionSidebar = (tab: DashboardTab): boolean =>
  isSettingsTab(tab) || tab === "data";

export type BackToSessionsNav = {
  selectedSessionId: string | null;
  setView: (view: View, sessionId?: string) => void;
  openNewTask: () => void;
};

/** Back from a focused dashboard page: to the session the user came from, else the new-task draft. */
export function backToSessions(nav: BackToSessionsNav): void {
  if (nav.selectedSessionId) {
    nav.setView("session", nav.selectedSessionId);
    return;
  }
  nav.openNewTask();
}
