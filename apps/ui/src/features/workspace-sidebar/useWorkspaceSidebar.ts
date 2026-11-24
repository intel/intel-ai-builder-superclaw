import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import type { Session } from "@opencode-ai/sdk/v2/client";
import type { WorkspaceInfo } from "~/shared/platform/tauri";
import { normalizeOpenworkServerUrl, parseOpenworkWorkspaceIdFromUrl } from "~/shared/platform/transport/openwork-server";
import { createClient, unwrap, type OpencodeAuth } from "~/shared/platform/transport/opencode";
import type { SidebarSessionItem } from "~/shared/types/session";
import type { WorkspaceConnectionState, WorkspaceSessionGroup } from "~/shared/types/workspace";
import { normalizeDirectoryPath } from "~/shared/platform/directory-path";
import { resolveWorkspaceDirectory } from "~/shared/platform/workspace-directory";
import { normalizeDirectoryQueryPath, safeStringify } from "~/shared/util/format";
import { stripModelPrefix } from "~/shared/util/model-ref";

export type UseWorkspaceSidebarDeps = {
  sessions: Accessor<Session[]>;
  workspaces: Accessor<WorkspaceInfo[]>;
  activeWorkspaceId: Accessor<string>;
  connectingWorkspaceId: Accessor<string | null>;
  workspaceConnectionStateById: Accessor<Record<string, WorkspaceConnectionState>>;
  engine: Accessor<{
    baseUrl?: string | null;
    runtime?: "direct" | "openwork-orchestrator" | null;
    opencodeUsername?: string | null;
    opencodePassword?: string | null;
  } | null>;
  debug?: (label: string, payload?: unknown) => void;
};

export function createWorkspaceSidebarFeature(deps: UseWorkspaceSidebarDeps) {
  const debug = deps.debug ?? (() => undefined);

  const [sidebarSessionsByWorkspaceId, setSidebarSessionsByWorkspaceId] = createSignal<
    Record<string, SidebarSessionItem[]>
  >({});
  const [sidebarSessionStatusByWorkspaceId, setSidebarSessionStatusByWorkspaceId] = createSignal<
    Record<string, WorkspaceSessionGroup["status"]>
  >({});
  const [sidebarSessionErrorByWorkspaceId, setSidebarSessionErrorByWorkspaceId] = createSignal<
    Record<string, string | null>
  >({});

  const sessionActivity = (session: Session) =>
    session.time?.updated ?? session.time?.created ?? 0;

  const sortSessionsByActivity = (list: Session[]) =>
    list.slice().sort((a, b) => {
      const delta = sessionActivity(b) - sessionActivity(a);
      if (delta !== 0) return delta;
      return a.id.localeCompare(b.id);
    });

  const reconcileSidebarSessions = (
    current: SidebarSessionItem[],
    incoming: SidebarSessionItem[],
  ) => {
    if (
      current.length === incoming.length &&
      current.every((item, index) => {
        const next = incoming[index];
        if (!next) return false;
        return (
          item.id === next?.id &&
          item.title === next.title &&
          item.slug === next.slug &&
          item.parentID === next.parentID &&
          item.time?.created === next.time?.created &&
          item.time?.updated === next.time?.updated &&
          item.directory === next.directory
        );
      })
    ) {
      return current;
    }

    const currentById = new Map(current.map((item) => [item.id, item]));
    return incoming.map((item) => {
      const existing = currentById.get(item.id);
      if (
        existing &&
        existing.title === item.title &&
        existing.slug === item.slug &&
        existing.parentID === item.parentID &&
        existing.time?.created === item.time?.created &&
        existing.time?.updated === item.time?.updated &&
        existing.directory === item.directory
      ) {
        return existing;
      }
      return item;
    });
  };

  const pruneSidebarSessionState = (workspaceIds: Set<string>) => {
    setSidebarSessionsByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, SidebarSessionItem[]> = {};
      for (const [id, list] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = list;
      }
      return changed ? next : prev;
    });
    setSidebarSessionStatusByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, WorkspaceSessionGroup["status"]> = {};
      for (const [id, status] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = status as WorkspaceSessionGroup["status"];
      }
      return changed ? next : prev;
    });
    setSidebarSessionErrorByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, string | null> = {};
      for (const [id, error] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = error;
      }
      return changed ? next : prev;
    });
  };

  const resolveSidebarClientConfig = (workspaceId: string) => {
    const workspace = deps.workspaces().find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace) return null;

    if (workspace.workspaceType === "local") {
      const info = deps.engine();
      const baseUrl = info?.baseUrl?.trim() ?? "";
      const directory = resolveWorkspaceDirectory(
        workspace,
        info?.runtime ?? null,
      );
      const username = info?.opencodeUsername?.trim() ?? "";
      const password = info?.opencodePassword?.trim() ?? "";
      const auth: OpencodeAuth | undefined =
        username && password ? { username, password } : undefined;
      return {
        baseUrl,
        directory,
        auth,
      };
    }

    const baseUrl = workspace.baseUrl?.trim() ?? "";
    const directory = workspace.directory?.trim() ?? "";
    if (workspace.remoteType === "openwork") {
      const token = workspace.openworkToken?.trim() ?? "";
      const auth: OpencodeAuth | undefined = token
        ? { token, mode: "openwork" }
        : undefined;
      return {
        baseUrl,
        directory,
        auth,
      };
    }
    return {
      baseUrl,
      directory,
      auth: undefined as OpencodeAuth | undefined,
    };
  };

  const sidebarRefreshSeqByWorkspaceId: Record<string, number> = {};
  const SIDEBAR_SESSION_LIMIT = 200;

  const refreshSidebarWorkspaceSessions = async (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;

    const config = resolveSidebarClientConfig(id);
    if (!config) return;

    if (!config.baseUrl) {
      let changed = false;
      setSidebarSessionStatusByWorkspaceId((prev) => {
        if (prev[id] === "idle") return prev;
        changed = true;
        return { ...prev, [id]: "idle" };
      });
      setSidebarSessionErrorByWorkspaceId((prev) => {
        if ((prev[id] ?? null) === null) return prev;
        changed = true;
        return { ...prev, [id]: null };
      });
      if (changed) {
        debug("sidebar:skip", { id, reason: "no-baseUrl" });
      }
      return;
    }

    sidebarRefreshSeqByWorkspaceId[id] =
      (sidebarRefreshSeqByWorkspaceId[id] ?? 0) + 1;
    const seq = sidebarRefreshSeqByWorkspaceId[id];

    setSidebarSessionStatusByWorkspaceId((prev) => ({
      ...prev,
      [id]: "loading",
    }));
    setSidebarSessionErrorByWorkspaceId((prev) => ({ ...prev, [id]: null }));

    try {
      const start = Date.now();
      let directory = config.directory;
      let c = createClient(config.baseUrl, directory || undefined, config.auth);

      if (!directory) {
        try {
          const pathInfo = unwrap(await c.path.get());
          const discovered = normalizeDirectoryQueryPath(pathInfo.directory ?? "");
          if (discovered) {
            directory = discovered;
            c = createClient(config.baseUrl, directory, config.auth);
          }
        } catch {
          // ignore
        }
      }

      const queryDirectory = normalizeDirectoryQueryPath(directory) || undefined;
      const list = unwrap(
        await c.session.list({
          directory: queryDirectory,
          roots: false,
          limit: SIDEBAR_SESSION_LIMIT,
        }),
      );
      debug("sidebar:list", {
        id,
        baseUrl: config.baseUrl,
        directory: directory || null,
        queryDirectory: queryDirectory ?? null,
        count: list.length,
        ms: Date.now() - start,
      });
      if (sidebarRefreshSeqByWorkspaceId[id] !== seq) return;

      const root = normalizeDirectoryPath(directory);
      const filtered = root
        ? list.filter(
            (session) => normalizeDirectoryPath(session.directory) === root,
          )
        : list;

      const sorted = sortSessionsByActivity(filtered);
      const items: SidebarSessionItem[] = sorted.map((session) => ({
        id: session.id,
        title: session.title ? stripModelPrefix(session.title) : session.title,
        slug: session.slug,
        parentID: session.parentID,
        time: session.time,
        directory: session.directory,
      }));

      setSidebarSessionsByWorkspaceId((prev) => {
        const sessions = reconcileSidebarSessions(prev[id] ?? [], items);
        if (sessions === prev[id]) return prev;
        return { ...prev, [id]: sessions };
      });
      setSidebarSessionStatusByWorkspaceId((prev) => ({
        ...prev,
        [id]: "ready",
      }));
    } catch (error) {
      if (sidebarRefreshSeqByWorkspaceId[id] !== seq) return;
      const message =
        error instanceof Error ? error.message : safeStringify(error);
      debug("sidebar:error", { id, message });
      setSidebarSessionStatusByWorkspaceId((prev) => ({
        ...prev,
        [id]: "error",
      }));
      setSidebarSessionErrorByWorkspaceId((prev) => ({
        ...prev,
        [id]: message,
      }));
    }
  };

  const refreshAllSidebarWorkspaceSessions = async (
    prioritizeWorkspaceId?: string | null,
  ) => {
    const list = deps.workspaces();
    if (!list.length) return;
    const prioritize = (prioritizeWorkspaceId ?? "").trim();
    const ordered = prioritize
      ? [
          ...list.filter((ws) => ws.id === prioritize),
          ...list.filter((ws) => ws.id !== prioritize),
        ]
      : list;
    for (const ws of ordered) {
      await refreshSidebarWorkspaceSessions(ws.id);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };

  const refreshLocalSidebarWorkspaceSessions = async (
    prioritizeWorkspaceId?: string | null,
  ) => {
    const list = deps.workspaces().filter((ws) => ws.workspaceType === "local");
    if (!list.length) return;
    const prioritize = (prioritizeWorkspaceId ?? "").trim();
    const ordered = prioritize
      ? [
          ...list.filter((ws) => ws.id === prioritize),
          ...list.filter((ws) => ws.id !== prioritize),
        ]
      : list;
    for (const ws of ordered) {
      await refreshSidebarWorkspaceSessions(ws.id);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };

  let lastSidebarEngineKey = "";
  let lastSidebarWorkspaceKey = "";
  createEffect(() => {
    const engineInfo = deps.engine();
    const engineBaseUrl = engineInfo?.baseUrl?.trim() ?? "";
    const engineUser = engineInfo?.opencodeUsername?.trim() ?? "";
    const enginePass = engineInfo?.opencodePassword?.trim() ?? "";

    const engineKey = [engineBaseUrl, engineUser, enginePass].join("::");
    const workspaceKey = deps
      .workspaces()
      .map((ws) => {
        const root =
          ws.workspaceType === "local" ? (ws.path?.trim() ?? "") : (ws.directory?.trim() ?? "");
        const base = ws.workspaceType === "local" ? "" : (ws.baseUrl?.trim() ?? "");
        const remoteType = ws.workspaceType === "remote" ? (ws.remoteType ?? "") : "";
        const token =
          ws.remoteType === "openwork" ? (ws.openworkToken?.trim() ?? "") : "";
        return [ws.id, ws.workspaceType, remoteType, root, base, token].join("|");
      })
      .join(";");

    // Sidebar session refreshes should only be driven by the engine auth/baseUrl or the workspace
    // definitions themselves. Global SuperClaw server settings are intentionally excluded so that
    // connecting/activating a remote does not cause other workspace task lists to refresh (and
    // potentially disappear) due to auth fallback changes.
    if (engineKey === lastSidebarEngineKey && workspaceKey === lastSidebarWorkspaceKey) return;

    const engineChanged = engineKey !== lastSidebarEngineKey;
    const workspacesChanged = workspaceKey !== lastSidebarWorkspaceKey;

    lastSidebarEngineKey = engineKey;
    lastSidebarWorkspaceKey = workspaceKey;

    pruneSidebarSessionState(new Set(deps.workspaces().map((ws) => ws.id)));

    debug("sidebar:refresh", {
      engineChanged,
      workspacesChanged,
      activeWorkspaceId: deps.activeWorkspaceId(),
      engineBaseUrl,
    });

    // Avoid refreshing remote workspace sessions when only the local engine auth/baseUrl changes.
    // Remote->local switches commonly change engineBaseUrl, and refreshing every remote workspace
    // at the same time can trigger large /session responses and UI hangs.
    if (engineChanged && !workspacesChanged) {
      void refreshLocalSidebarWorkspaceSessions(deps.activeWorkspaceId()).catch(() => undefined);
      return;
    }

    void refreshAllSidebarWorkspaceSessions(deps.activeWorkspaceId()).catch(() => undefined);
  });

  createEffect(() => {
    const id = deps.activeWorkspaceId().trim();
    if (!id) return;
    const status = sidebarSessionStatusByWorkspaceId()[id] ?? "idle";
    // Only auto-load once per workspace activation.
    // If a remote is offline, repeated retries here can create an endless refresh loop.
    if (status !== "idle") return;
    refreshSidebarWorkspaceSessions(id).catch(() => undefined);
  });

  // When a workspace connection recovers (e.g. the backend comes back online and the user
  // clicks "Test connection"), reset any stale sidebar error so the auto-load effect
  // above picks it up and refreshes the task list.
  createEffect(() => {
    const stateById = deps.workspaceConnectionStateById();
    const errorById = sidebarSessionErrorByWorkspaceId();
    for (const [id, connState] of Object.entries(stateById)) {
      if (connState.status === "connected" && (errorById[id] ?? null) !== null) {
        setSidebarSessionStatusByWorkspaceId((prev) => ({
          ...prev,
          [id]: "idle",
        }));
        setSidebarSessionErrorByWorkspaceId((prev) => ({
          ...prev,
          [id]: null,
        }));
      }
    }
  });

  createEffect(() => {
    const allSessions = deps.sessions();
    const wsId = (deps.connectingWorkspaceId() ?? deps.activeWorkspaceId()).trim();
    if (!wsId) return;
    const status = sidebarSessionStatusByWorkspaceId()[wsId];

    if (status === "ready") {
      const activeWorkspace =
        deps.workspaces().find((workspace) => workspace.id === wsId) ?? null;
      const activeWorkspaceRoot = normalizeDirectoryPath(
        resolveWorkspaceDirectory(
          activeWorkspace,
          deps.engine()?.runtime ?? null,
        ),
      );
      const scopedSessions = activeWorkspaceRoot
        ? allSessions.filter(
            (session) =>
              normalizeDirectoryPath(session.directory) === activeWorkspaceRoot,
          )
        : allSessions;
      const sorted = sortSessionsByActivity(scopedSessions);
      const rootItems: SidebarSessionItem[] = sorted.map((s) => ({
        id: s.id,
        title: s.title ? stripModelPrefix(s.title) : s.title,
        slug: s.slug,
        parentID: s.parentID,
        time: s.time,
        directory: s.directory,
      }));
      setSidebarSessionsByWorkspaceId((prev) => {
        const current = prev[wsId] ?? [];
        const hasCurrentChildren = current.some((item) => Boolean(item.parentID?.trim()));
        const incomingAreRootsOnly = rootItems.every((item) => !item.parentID?.trim());
        if (!hasCurrentChildren || !incomingAreRootsOnly) {
          const sessions = reconcileSidebarSessions(current, rootItems);
          if (sessions === current) return prev;
          return {
            ...prev,
            [wsId]: sessions,
          };
        }

        const byId = new Map(current.map((item) => [item.id, item] as const));
        for (const item of rootItems) {
          byId.set(item.id, {
            ...(byId.get(item.id) ?? {}),
            ...item,
          });
        }

        const rootIDs = new Set(rootItems.map((item) => item.id));
        const keepChild = (item: SidebarSessionItem, seen = new Set<string>()) => {
          const parentID = item.parentID?.trim() ?? "";
          if (!parentID) return false;
          if (rootIDs.has(parentID)) return true;
          if (seen.has(parentID)) return false;
          const parent = byId.get(parentID);
          if (!parent) return false;
          seen.add(parentID);
          return keepChild(parent, seen);
        };

        const sessions = reconcileSidebarSessions(current, [
          ...rootItems,
          ...current.filter((item) => !rootIDs.has(item.id) && keepChild(item)),
        ]);
        if (sessions === current) return prev;
        return {
          ...prev,
          [wsId]: sessions,
        };
      });
    }
  });

  const sidebarWorkspaceGroups = createMemo<WorkspaceSessionGroup[]>(() => {
    const workspaces = deps.workspaces();
    const activeWorkspaceId = deps.activeWorkspaceId().trim();
    const connectingWorkspaceId = deps.connectingWorkspaceId()?.trim() ?? "";
    const sessionsById = sidebarSessionsByWorkspaceId();
    const statusById = sidebarSessionStatusByWorkspaceId();
    const errorById = sidebarSessionErrorByWorkspaceId();
    const dedupedWorkspaces: typeof workspaces = [];
    const dedupeKeyToIndex = new Map<string, number>();
    for (const workspace of workspaces) {
      if (workspace.workspaceType !== "remote") {
        dedupedWorkspaces.push(workspace);
        continue;
      }
      const hostKey =
        normalizeOpenworkServerUrl(workspace.openworkHostUrl?.trim() ?? "") ??
        normalizeOpenworkServerUrl(workspace.baseUrl?.trim() ?? "") ??
        "";
      const workspaceIdKey =
        workspace.openworkWorkspaceId?.trim() ||
        parseOpenworkWorkspaceIdFromUrl(workspace.openworkHostUrl ?? "") ||
        parseOpenworkWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
        "";
      const directoryKey = normalizeDirectoryPath(
        workspace.directory?.trim() ?? workspace.path?.trim() ?? "",
      );
      const identityKey = workspaceIdKey
        ? `id:${workspaceIdKey}`
        : directoryKey
          ? `dir:${directoryKey}`
          : "";
      if (!hostKey || !identityKey) {
        dedupedWorkspaces.push(workspace);
        continue;
      }
      const dedupeKey = `${workspace.remoteType ?? ""}|${hostKey}|${identityKey}`;
      const existingIndex = dedupeKeyToIndex.get(dedupeKey);
      if (existingIndex === undefined) {
        dedupeKeyToIndex.set(dedupeKey, dedupedWorkspaces.length);
        dedupedWorkspaces.push(workspace);
        continue;
      }
      const existingWorkspace = dedupedWorkspaces[existingIndex];
      const existingIsPriority =
        existingWorkspace.id === activeWorkspaceId ||
        existingWorkspace.id === connectingWorkspaceId;
      const currentIsPriority =
        workspace.id === activeWorkspaceId ||
        workspace.id === connectingWorkspaceId;
      if (currentIsPriority && !existingIsPriority) {
        dedupedWorkspaces[existingIndex] = workspace;
      }
    }
    return dedupedWorkspaces.map((workspace) => {
      const groupSessions = sessionsById[workspace.id] ?? [];
      return {
        workspace,
        sessions: groupSessions,
        status: statusById[workspace.id] ?? "idle",
        error: errorById[workspace.id] ?? null,
      };
    });
  });

  return {
    sidebarSessionsByWorkspaceId,
    setSidebarSessionsByWorkspaceId,
    sidebarSessionStatusByWorkspaceId,
    setSidebarSessionStatusByWorkspaceId,
    sidebarSessionErrorByWorkspaceId,
    setSidebarSessionErrorByWorkspaceId,
    pruneSidebarSessionState,
    resolveSidebarClientConfig,
    refreshSidebarWorkspaceSessions,
    refreshAllSidebarWorkspaceSessions,
    refreshLocalSidebarWorkspaceSessions,
    sidebarWorkspaceGroups,
  };
}