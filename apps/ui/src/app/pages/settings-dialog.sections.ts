/**
 * The sections of the Settings dialog and the order its nav lists them in.
 *
 * A section is either a pane of `SettingsView` (a `SettingsTab`) or one of the
 * pages that used to be a dashboard tab. `den` and `config` stay reachable by
 * id for the developer-mode callers but are not in the nav: nothing turns
 * developer mode on (#3815).
 */
import {
  Bot,
  CalendarClock,
  Mic,
  Plug,
  Route,
  Settings2,
  Shield,
  Sparkles,
  Unplug,
} from "lucide-solid";

import type { DashboardTab, SettingsTab } from "../types";

export type SettingsSection =
  | SettingsTab
  | Exclude<DashboardTab, "settings" | "data">;

export type SettingsNavItem = {
  id: SettingsSection;
  labelKey: string;
  icon: typeof Bot;
  /** Kept from the old tab strip; the e2e page objects find sections by them. */
  testId: string;
  /** Shown only when the shell supplies the voice controller, as `availableTabs` in settings.tsx. */
  needsVoice?: boolean;
};

export const SETTINGS_NAV: readonly SettingsNavItem[] = [
  { id: "app", labelKey: "dashboard.tab_app_settings", icon: Settings2, testId: "app-settings-button" },
  { id: "model", labelKey: "dashboard.tab_model", icon: Route, testId: "model-settings-button" },
  { id: "privacy", labelKey: "dashboard.tab_privacy", icon: Shield, testId: "privacy-settings-button" },
  { id: "identities", labelKey: "dashboard.tab_channel", icon: Unplug, testId: "channels-settings-button" },
  { id: "voice", labelKey: "dashboard.tab_voice", icon: Mic, testId: "voice-settings-button", needsVoice: true },
  { id: "agent", labelKey: "dashboard.tab_agent", icon: Bot, testId: "agents-settings-button" },
  { id: "skills", labelKey: "dashboard.tab_skill", icon: Sparkles, testId: "skills-settings-button" },
  { id: "mcp", labelKey: "dashboard.tab_mcp", icon: Plug, testId: "mcp-settings-button" },
  { id: "scheduled", labelKey: "dashboard.tab_scheduler", icon: CalendarClock, testId: "scheduler-settings-button" },
];

export const visibleSettingsNav = (options: { voice: boolean }): SettingsNavItem[] =>
  SETTINGS_NAV.filter((item) => !item.needsVoice || options.voice);

const SETTINGS_VIEW_PANES: readonly SettingsSection[] = ["den", "model", "voice", "app", "privacy"];

/** True for the sections `SettingsView` draws itself. */
export const isSettingsViewPane = (section: SettingsSection): section is SettingsTab =>
  SETTINGS_VIEW_PANES.includes(section);

/** The nav item one step from `current`, wrapping at both ends; Home and End jump to the ends. */
export function stepSettingsNav(
  items: readonly SettingsNavItem[],
  current: SettingsSection,
  key: "ArrowUp" | "ArrowDown" | "Home" | "End",
): SettingsSection | null {
  if (items.length === 0) return null;
  if (key === "Home") return items[0].id;
  if (key === "End") return items[items.length - 1].id;
  const index = items.findIndex((item) => item.id === current);
  if (index < 0) return items[0].id;
  const step = key === "ArrowDown" ? 1 : -1;
  return items[(index + step + items.length) % items.length].id;
}
