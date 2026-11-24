/**
 * Session lifecycle operations that are not creation: injecting a session the
 * server just told us about, renaming, deleting, listing the agents and slash
 * commands a session can use, and exporting one to a file.
 *
 * Deletion is the reason this is one module. It is not a single call — it has
 * to tell OpenCode, tell the OpenWork server to drop its PII tally, switch off
 * a deleted chat's web pages grant, drop the local deletion records, remove
 * the session from both the store and the sidebar, navigate away if the user
 * is looking at it, clear the selection and
 * its persisted per-workspace entry, and forget its status. Every one of those
 * touches state the neighbouring operations also touch, so they share a deps
 * object rather than seven separate ones.
 */
import type { Accessor, Setter } from "solid-js";
import type { Agent, Session } from "@opencode-ai/sdk/v2/client";

import { listCommands as listCommandsTyped } from "~/shared/platform/transport/opencode-session";
import { clearSessionDeletions } from "~/shared/platform/artifact-deletion-store";
import { uiLogWarn } from "~/shared/platform/log/log";
import type { InstanceApiClient } from "~/shared/platform/transport/instance-api";
import { unwrap } from "~/shared/platform/transport/opencode";
import { retryOpencodeColdStart } from "~/shared/platform/transport/opencode-cold-start";
import type {
  Client,
  SidebarSessionItem,
  SlashCommandOption,
  TodoItem,
} from "./types";

// Skills that are internal implementation details and should not be exposed
// to end users via the "/" command picker.
const HIDDEN_SKILLS = new Set([
  // opencode built-in skill (location "<built-in>"); denied in opencode.jsonc
  // but still returned by command.list, so hide it here too.
  "customize-opencode",
  "data-prep-agent",
  "docx",
  "email",
  "llmrouter-bench",
  "local-safety-guard",
  "local-security-review",
  "pdf",
  "pii-agent",
  "pptx",
  "restoration-agent",
  "spreadsheet",
]);

const BUILTIN_COMPACT_COMMAND = {
  id: "builtin:compact",
  name: "compact",
  description: "Summarize this session to reduce context size.",
  source: "command" as const,
  dispatch: "command" as const,
};

export type SessionCrudDeps = {
  client: Accessor<Client | null>;
  navigate: (path: string, options?: { replace?: boolean }) => void;
  openworkServerClient: Accessor<{
    clearPiiStats: (workspaceId: string, sessionID: string) => Promise<unknown>;
  } | null>;
  chatGrantClient: Accessor<Pick<InstanceApiClient, "setChatGrant"> | null>;
  readSessionByWorkspace: () => Record<string, string>;
  writeSessionByWorkspace: (map: Record<string, string>) => void;
  refreshSidebarWorkspaceSessions: (workspaceId: string) => Promise<unknown>;
  renameSession: (sessionID: string, title: string) => Promise<unknown>;
  resolvedDevtoolsWorkspaceId: Accessor<string | null>;
  /**
   * Solid Router's pathname. Deliberately not read off `window.location`: the
   * installed app mounts `HashRouter`, so the global pathname is the shell
   * document and the route lives in the hash.
   */
  routerPathname: Accessor<string>;
  selectedSessionId: Accessor<string | null>;
  setSelectedSessionId: Setter<string | null>;
  sessions: Accessor<Session[]>;
  setSessions: (next: Session[]) => void;
  sessionStatusById: Accessor<Record<string, string>>;
  setSessionStatusById: (next: Record<string, string>) => void;
  setSidebarSessionsByWorkspaceId: Setter<Record<string, SidebarSessionItem[]>>;
  skills: Accessor<Array<{ name: string; description?: string; trigger?: string }>>;
  workspaceSdkDir: Accessor<string | undefined>;
  workspaceStore: {
    activeWorkspaceId: Accessor<string>;
    activeWorkspaceRoot: Accessor<string>;
  };
};

export const createSessionCrud = (deps: SessionCrudDeps) => {
  // `deps` is a plain object of accessors built once by `App()`, not a Solid
  // props proxy, so destructuring copies function references without
  // collapsing reactivity.
  const {
    client,
    navigate,
    openworkServerClient,
    chatGrantClient,
    readSessionByWorkspace,
    writeSessionByWorkspace,
    refreshSidebarWorkspaceSessions,
    renameSession,
    resolvedDevtoolsWorkspaceId,
    routerPathname,
    selectedSessionId,
    setSelectedSessionId,
    sessions,
    setSessions,
    sessionStatusById,
    setSessionStatusById,
    setSidebarSessionsByWorkspaceId,
    skills,
    workspaceSdkDir,
    workspaceStore,
  } = deps;

  /** Replace a session in the store by id, or append it if it is new. */
  const upsertLocalSession = (next: Session | null | undefined) => {
    const id = (next as { id?: string } | null)?.id ?? "";
    if (!id) return;

    const current = sessions();
    const index = current.findIndex((session) => session.id === id);
    if (index === -1) {
      setSessions([...current, next as Session]);
      return;
    }
    const copy = current.slice();
    copy[index] = next as Session;
    setSessions(copy);
  };

  async function renameSessionTitle(sessionID: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session name is required");
    }

    await renameSession(sessionID, trimmed);
    await refreshSidebarWorkspaceSessions(
      workspaceStore.activeWorkspaceId(),
    ).catch(() => undefined);
  }

  async function deleteSessionById(sessionID: string) {
    const trimmed = sessionID.trim();
    if (!trimmed) return;
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    // Read before the delete: the server's session.deleted event can drop it
    // from the store while the call is in flight.
    const isChat = !sessions().find((s) => s.id === trimmed)?.parentID;
    const root = workspaceSdkDir();
    const params = root
      ? { sessionID: trimmed, directory: root }
      : { sessionID: trimmed };
    unwrap(await c.session.delete(params));

    // The grant outlives restarts; a deleted chat has no switch left to end it.
    const grants = chatGrantClient();
    if (isChat && grants) {
      void grants.setChatGrant(trimmed, false).catch((err: unknown) =>
        uiLogWarn("session.delete", "setChatGrant failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // Notify the openwork server to drop the cached PII tally for this session
    // so workspace-wide PII aggregates (PII Shield view) update immediately.
    // Local workspaces delete sessions directly via the opencode SDK above,
    // so the openwork server otherwise has no signal that the session is gone.
    try {
      const owClient = openworkServerClient();
      const owWorkspaceId = resolvedDevtoolsWorkspaceId()?.trim();
      if (owClient && owWorkspaceId) {
        owClient
          .clearPiiStats(owWorkspaceId, trimmed)
          .catch((err) =>
            uiLogWarn("session.delete", "clearPiiStats failed", {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
      } else {
        uiLogWarn(
          "session.delete",
          "clearPiiStats skipped: no client or workspaceId",
        );
      }
    } catch (err) {
      uiLogWarn("session.delete", "clearPiiStats threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Clear per-session UI-deletion records from localStorage.
    clearSessionDeletions(trimmed);

    // Remove the deleted session from the store and sidebar locally.
    // SSE will handle any further sync — calling loadSessions/refreshSidebarWorkspaceSessions
    // here races with SSE and can wipe unrelated sessions from the store.
    setSessions(sessions().filter((s) => s.id !== trimmed));
    const activeWsId = workspaceStore.activeWorkspaceId();
    setSidebarSessionsByWorkspaceId((prev) => ({
      ...prev,
      [activeWsId]: (prev[activeWsId] ?? []).filter((s) => s.id !== trimmed),
    }));

    // If we're currently routed to the deleted session, navigate away immediately.
    // (Otherwise the route effect can try to re-select a session that no longer exists.)
    try {
      const path = routerPathname().toLowerCase();
      if (path === `/session/${trimmed.toLowerCase()}`) {
        navigate("/session", { replace: true });
      }
    } catch {
      // ignore
    }

    // If the deleted session was selected, clear selection so routing can fall back cleanly.
    if (selectedSessionId() === trimmed) {
      setSelectedSessionId(null);
      const activeWorkspace = workspaceStore.activeWorkspaceId().trim();
      if (activeWorkspace) {
        const map = readSessionByWorkspace();
        if (map[activeWorkspace] === trimmed) {
          const next = { ...map };
          delete next[activeWorkspace];
          writeSessionByWorkspace(next);
        }
      }
    }

    const nextStatus = { ...sessionStatusById() };
    if (nextStatus[trimmed]) {
      delete nextStatus[trimmed];
      setSessionStatusById(nextStatus);
    }
  }

  /**
   * Only user-selectable agents: no hidden ones and no subagents.
   * Retried once when the call is the cold start after an engine dispose.
   */
  async function listAgents(): Promise<Agent[]> {
    return retryOpencodeColdStart(async () => {
      const c = client();
      if (!c) return [];
      const raw = await c.app.agents();
      const list = unwrap(raw);
      return list.filter((agent) => !agent.hidden && agent.mode !== "subagent");
    });
  }

  /**
   * The slash menu: OpenCode's commands, then any skill that does not already
   * have a command of the same name, then `/compact` if nothing supplied it.
   */
  async function listCommands(): Promise<SlashCommandOption[]> {
    const c = client();
    if (!c) return [];
    const list = await listCommandsTyped(
      c,
      workspaceStore.activeWorkspaceRoot().trim() || undefined,
    );
    const byName = new Map<string, SlashCommandOption>();
    for (const entry of list) {
      if (!HIDDEN_SKILLS.has(entry.name))
        byName.set(entry.name, { ...entry, dispatch: "command" });
    }
    for (const skill of skills()) {
      if (HIDDEN_SKILLS.has(skill.name) || byName.has(skill.name)) continue;
      byName.set(skill.name, {
        id: `skill:${skill.name}`,
        name: skill.name,
        description: skill.description || skill.trigger,
        source: "skill",
        dispatch: "prompt",
      });
    }
    const filtered = [...byName.values()];
    if (filtered.some((entry) => entry.name === "compact")) {
      return filtered;
    }
    return [BUILTIN_COMPACT_COMMAND, ...filtered];
  }

  function downloadSessionExport(payload: unknown, fileName: string) {
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    return fileName;
  }

  async function saveSessionExport(sessionID: string) {
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const session = unwrap(await c.session.get({ sessionID }));
    const messages = unwrap(await c.session.messages({ sessionID }));
    let todos: TodoItem[] = [];
    try {
      todos = unwrap(await c.session.todo({ sessionID }));
    } catch {
      // ignore
    }

    const payload = {
      session,
      messages,
      todos,
      exportedAt: new Date().toISOString(),
      source: "openwork",
    };

    const baseName = session.title || session.slug || session.id;
    const safeName = baseName
      .toLowerCase()
      .replace(/[^a-z0-9\-_.]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    const fileName = `session-${safeName || session.id}.json`;
    return downloadSessionExport(payload, fileName);
  }

  return {
    deleteSessionById,
    downloadSessionExport,
    listAgents,
    listCommands,
    renameSessionTitle,
    saveSessionExport,
    upsertLocalSession,
  };
};
