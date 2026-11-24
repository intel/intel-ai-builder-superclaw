// What the dashboard is allowed to do with skills and plugins, which depends on
// whether the active workspace is local or a remote SuperClaw server, and on
// whether that server accepted a host token.
//
// Kept out of app.tsx and free of signals so `dashboardProps` can read it
// through a single memo instead of deriving it eagerly on every rebuild.
import type { OpenworkServerStatus } from "~/shared/platform/transport/openwork-server.types";

export type DashboardAccessInput = {
  workspaceType: "local" | "remote";
  isTauri: boolean;
  openworkStatus: OpenworkServerStatus;
  canWriteSkills: boolean;
  canWritePlugins: boolean;
};

export type DashboardAccess = {
  workspaceType: "local" | "remote";
  isRemoteWorkspace: boolean;
  openworkStatus: OpenworkServerStatus;
  canUseDesktopTools: boolean;
  canInstallSkillCreator: boolean;
  canEditPlugins: boolean;
  canUseGlobalPluginScope: boolean;
  canImportLocalSkill: boolean;
  canUninstallSkill: boolean;
  canEditSkill: boolean;
  skillsAccessHint: string | null;
  pluginsAccessHint: string | null;
};

function skillsHint(
  status: OpenworkServerStatus,
  canWriteSkills: boolean,
): string | null {
  if (status === "disconnected") {
    return "SuperClaw server unavailable. Add the server URL/token in Advanced to manage skills.";
  }
  if (status === "limited") {
    return "SuperClaw server needs a host token to install/update skills. Add it in Advanced and reconnect.";
  }
  if (canWriteSkills) return null;
  return "SuperClaw server is read-only for skills. Add a host token in Advanced to enable installs.";
}

function pluginsHint(
  status: OpenworkServerStatus,
  canWritePlugins: boolean,
): string | null {
  if (status === "disconnected") {
    return "SuperClaw server unavailable. Plugins are read-only.";
  }
  if (status === "limited") {
    return "SuperClaw server needs a token to edit plugins.";
  }
  if (canWritePlugins) return null;
  return "SuperClaw server is read-only for plugins.";
}

export function computeDashboardAccess(
  input: DashboardAccessInput,
): DashboardAccess {
  const { workspaceType, isTauri, openworkStatus } = input;
  const { canWriteSkills, canWritePlugins } = input;
  const isRemoteWorkspace = workspaceType === "remote";
  return {
    workspaceType,
    isRemoteWorkspace,
    openworkStatus,
    canUseDesktopTools: isTauri && !isRemoteWorkspace,
    canInstallSkillCreator: isRemoteWorkspace ? canWriteSkills : isTauri,
    canEditPlugins: isRemoteWorkspace ? canWritePlugins : isTauri,
    canUseGlobalPluginScope: !isRemoteWorkspace && isTauri,
    // Needs Tauri to pick a directory, plus either a local workspace or server write access.
    canImportLocalSkill: isTauri && (!isRemoteWorkspace || canWriteSkills),
    canUninstallSkill: isRemoteWorkspace ? canWriteSkills : isTauri,
    canEditSkill: isRemoteWorkspace ? canWriteSkills : isTauri,
    skillsAccessHint: isRemoteWorkspace
      ? skillsHint(openworkStatus, canWriteSkills)
      : null,
    pluginsAccessHint: isRemoteWorkspace
      ? pluginsHint(openworkStatus, canWritePlugins)
      : null,
  };
}
