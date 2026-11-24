/**
 * Shared-bundle import, as far as it can be decided from data alone: which
 * workers can accept a bundle, where in a given worker it would land, how the
 * invite is described, and how the two worker pickers are labelled and
 * ordered.
 *
 * Everything here is pure. The signals, effects and async handlers that drive
 * the flow stay in app.tsx; only the decisions move, so the reactive graph is
 * untouched.
 */
import { parseOpenworkWorkspaceIdFromUrl } from "./lib/openwork-server";
import { normalizeDirectoryPath } from "~/shared/platform/directory-path";
import { normalizeOpenworkServerUrl } from "~/shared/platform/transport/openwork-server.url";
import type {
  SharedBundleDeepLink,
  SharedBundleImportTarget,
  SharedBundleV1,
  SharedSkillBundleV1,
} from "~/features/workspace-import";
import type { StartupPreference } from "~/shared/types/preferences";
import type { WorkspaceDisplay, WorkspacePreset } from "./types";
import type { WorkspaceInfo } from "./lib/tauri";

export type SharedBundleCreateWorkerRequest = {
  request: SharedBundleDeepLink;
  bundle: SharedBundleV1;
  defaultPreset: WorkspacePreset;
};

export type SharedSkillDestinationRequest = {
  request: SharedBundleDeepLink;
  bundle: SharedSkillBundleV1;
};

export type SharedSkillSuccessToast = {
  title: string;
  description: string;
};

export type SharedBundleImportChoice = {
  request: SharedBundleDeepLink;
  bundle: SharedBundleV1;
};

type AnyWorkspace = WorkspaceDisplay | WorkspaceInfo;

/**
 * A worker's human name, in the order of preference the UI has always used.
 * Three call sites had their own copy of this chain; they now share one.
 */
const workspaceLabel = (workspace: AnyWorkspace | null): string =>
  workspace?.displayName?.trim() ||
  workspace?.openworkWorkspaceName?.trim() ||
  workspace?.name?.trim() ||
  workspace?.directory?.trim() ||
  workspace?.path?.trim() ||
  workspace?.baseUrl?.trim() ||
  "";

export const describeWorkspaceForToasts = (
  workspace: AnyWorkspace | null,
): string => workspaceLabel(workspace) || "the selected worker";

/** A local worker needs a path; a remote one needs to be OpenWork-reachable. */
export const isSharedBundleImportWorkspace = (
  workspace: AnyWorkspace | null,
): boolean => {
  if (!workspace || !workspace.id?.trim()) return false;
  if (workspace.workspaceType === "local") {
    return Boolean(workspace.path?.trim());
  }
  return Boolean(
    workspace.remoteType === "openwork" ||
      workspace.openworkHostUrl?.trim() ||
      workspace.openworkWorkspaceId?.trim(),
  );
};

export const resolveSharedBundleImportTargetForWorkspace = (
  workspace: AnyWorkspace | null,
): SharedBundleImportTarget | undefined => {
  if (!workspace) return undefined;
  if (workspace.workspaceType === "local") {
    const localRoot = workspace.path?.trim() ?? "";
    return localRoot ? { localRoot } : undefined;
  }

  const workspaceId =
    workspace.openworkWorkspaceId?.trim() ||
    parseOpenworkWorkspaceIdFromUrl(workspace.openworkHostUrl ?? "") ||
    parseOpenworkWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
    null;
  const directoryHint =
    workspace.directory?.trim() || workspace.path?.trim() || null;
  if (workspaceId || directoryHint) {
    return { workspaceId, directoryHint };
  }
  return undefined;
};

/**
 * Find the worker a bundle is already destined for, in the list the UI holds.
 *
 * A target can name its destination three ways and they are tried in order of
 * how specific they are: an explicit workspace id, then a local root, then a
 * directory hint — which has to look at `opencode.directory` first because a
 * remote worker's own `path` describes the host, not the mounted tree.
 */
export const findSharedBundleImportWorkspaceId = (
  items: readonly {
    id: string;
    path?: string;
    directory?: string;
    opencode?: { directory?: string };
  }[],
  target?: SharedBundleImportTarget,
): string | null => {
  const explicitId = target?.workspaceId?.trim() ?? "";
  if (explicitId) {
    const match = items.find((entry) => entry.id === explicitId);
    if (match?.id) return match.id;
  }

  const localRoot = normalizeDirectoryPath(target?.localRoot?.trim() ?? "");
  if (localRoot) {
    const match = items.find(
      (entry) => normalizeDirectoryPath(entry.path ?? "") === localRoot,
    );
    if (match?.id) return match.id;
  }

  const directoryHint = normalizeDirectoryPath(
    target?.directoryHint?.trim() ?? "",
  );
  if (directoryHint) {
    const match = items.find((entry) => {
      const entryPath = normalizeDirectoryPath(
        (
          entry.opencode?.directory ??
          entry.directory ??
          entry.path ??
          ""
        ).trim(),
      );
      return entryPath === directoryHint;
    });
    if (match?.id) return match.id;
  }

  return null;
};

export type SharedBundleWorkerTarget = { hostUrl: string; token: string };

/**
 * Pick the OpenWork host and token to import a bundle through.
 *
 * A stated startup preference decides which side is asked first; with no
 * preference the local host wins when it exists. Either way the token falls
 * back to the other side's, because the host we end up with is often only
 * reachable with the one token we hold.
 */
export const resolveSharedBundleWorkerTarget = (input: {
  preference: StartupPreference | null;
  hostInfo: { baseUrl?: string | null; clientToken?: string | null } | null;
  settings: { urlOverride?: string | null; token?: string | null };
}): SharedBundleWorkerTarget => {
  const localHostUrl =
    normalizeOpenworkServerUrl(input.hostInfo?.baseUrl ?? "") ?? "";
  const localToken = input.hostInfo?.clientToken?.trim() ?? "";
  const serverHostUrl =
    normalizeOpenworkServerUrl(input.settings.urlOverride ?? "") ?? "";
  const serverToken = input.settings.token?.trim() ?? "";

  if (input.preference === "server") {
    return {
      hostUrl: serverHostUrl || localHostUrl,
      token: serverToken || localToken,
    };
  }

  if (input.preference === "local") {
    return {
      hostUrl: localHostUrl || serverHostUrl,
      token: localToken || serverToken,
    };
  }

  if (localHostUrl) {
    return {
      hostUrl: localHostUrl,
      token: localToken || serverToken,
    };
  }

  return {
    hostUrl: serverHostUrl,
    token: serverToken || localToken,
  };
};

/** The invite copy: what the user is about to import, and into what. */
export function describeSharedBundleImport(bundle: SharedBundleV1): {
  title: string;
  description: string;
  items: string[];
} {
  if (bundle.type === "skill") {
    return {
      title: "Import 1 skill",
      description:
        bundle.description?.trim() ||
        `Add \`${bundle.name}\` to an existing worker or create a new one for it.`,
      items: [bundle.name],
    };
  }

  if (bundle.type === "skills-set") {
    const count = bundle.skills.length;
    return {
      title: `Import ${count} skill${count === 1 ? "" : "s"}`,
      description:
        bundle.description?.trim() ||
        `${bundle.name || "Shared skills"} is ready to import into an existing worker or a new worker.`,
      items: bundle.skills.map((skill) => skill.name),
    };
  }

  return {
    title: "Import workspace bundle",
    description:
      bundle.description?.trim() ||
      `Create a new worker to import ${bundle.name || "this shared workspace bundle"}.`,
    items: Array.isArray(bundle.workspace.skills)
      ? bundle.workspace.skills.map((skill) => skill.name)
      : [],
  };
}

/** Eligible workers only, active one first, then by label. */
export const sortSharedSkillDestinations = <T extends AnyWorkspace>(
  workspaces: readonly T[],
  activeWorkspaceId: string,
): T[] =>
  workspaces
    .filter((workspace) => isSharedBundleImportWorkspace(workspace))
    .slice()
    .sort((a, b) => {
      if (a.id === activeWorkspaceId && b.id !== activeWorkspaceId) return -1;
      if (b.id === activeWorkspaceId && a.id !== activeWorkspaceId) return 1;
      return workspaceLabel(a).localeCompare(workspaceLabel(b), undefined, {
        sensitivity: "base",
      });
    });

type SharedBundleWorkerOption = {
  id: string;
  label: string;
  detail: string;
  badge: "Local" | "Remote";
  current: boolean;
  disabledReason: string | null;
};

/**
 * Unlike the destination list this keeps ineligible workers, showing them
 * disabled with a reason, so a user whose worker cannot accept the bundle is
 * told why instead of wondering where it went.
 */
export const buildSharedBundleWorkerOptions = (
  workspaces: readonly AnyWorkspace[],
  activeWorkspaceId: string,
): SharedBundleWorkerOption[] => {
  const activeId = activeWorkspaceId.trim();
  const items = workspaces.map((workspace) => {
    let disabledReason: string | null = null;
    if (!resolveSharedBundleImportTargetForWorkspace(workspace)) {
      disabledReason =
        workspace.workspaceType === "remote" &&
        workspace.remoteType !== "openwork"
          ? "Only OpenWork-connected workers support direct shared skill imports."
          : "This worker is missing the info OpenWork needs to import the bundle.";
    }

    const label =
      workspace.displayName?.trim() ||
      workspace.openworkWorkspaceName?.trim() ||
      workspace.name?.trim() ||
      workspace.path?.trim() ||
      "Worker";
    const badge: SharedBundleWorkerOption["badge"] =
      workspace.workspaceType === "remote" ? "Remote" : "Local";
    const detail =
      workspace.workspaceType === "local"
        ? workspace.path?.trim() || "Local worker"
        : workspace.directory?.trim() ||
          workspace.baseUrl?.trim() ||
          workspace.openworkHostUrl?.trim() ||
          "Worker";

    return {
      id: workspace.id,
      label,
      detail,
      badge,
      current: workspace.id === activeId,
      disabledReason,
    };
  });

  return items.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
};
