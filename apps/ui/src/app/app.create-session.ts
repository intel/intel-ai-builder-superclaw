/**
 * Session creation: everything between the user asking for a new task and the
 * app showing it — the pre-flight health probe, `session.create`, applying the
 * draft's pending agent/model routing, injecting the session into both the
 * reactive store and the sidebar, and navigating to it.
 *
 * This is one function because it is one transaction. The pending model and
 * agent are consumed partway through and must be cleared on *either* outcome:
 * the success path hands them to `applyPendingSessionRouting`, and the failure
 * path drops them so a failed create cannot leak a previous draft's override
 * (issue #420) into the next attempt. Splitting it would mean threading that
 * state through return values.
 *
 * It moved out of `App()` as-is; the dependency list below is the closure it
 * used to read directly. It is wired last in `App()` because `createPromptDispatch`
 * takes `createSessionAndOpen` as a dependency.
 */
import type { Accessor, Setter } from "solid-js";
import type { SessionStore } from "~/features/session";

import { applyPendingSessionRouting } from "./session-draft-routing";
import { unwrap } from "~/shared/platform/transport/opencode";
import { finishPerf, perfNow, recordPerfLog } from "~/shared/platform/log/perf-log";
import { addOpencodeCacheHint, safeStringify, stripModelPrefix } from "./utils";
import { currentLocale, t } from "../i18n";
import type {
  Client,
  ModelRef,
  SidebarSessionItem,
  WorkspaceSessionGroup,
} from "./types";

/**
 * Races `promise` against a timer, always clearing the timer afterwards.
 *
 * Hoisted out of the creation function because it closes over nothing — the
 * version inside `App()` was re-created on every call for no reason, and out
 * here it can be tested directly.
 */
export const withTimeout = async <T,>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label}`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

/**
 * The longest a new session waits, before it opens, for its "Allow for this session" PUT. Opened earlier, its
 * first prompt's first web read can reach the Connector before the grant and ask the user anyway; after this
 * it opens regardless, and a failed PUT shows on the switch.
 */
export const PRESELECT_WAIT_MS = 3_000;

const settleWithin = async (promise: Promise<void>, ms: number): Promise<void> => {
  try {
    await withTimeout(promise, ms, "the web pages pre-select");
  } catch {
    // Past the bound: the session opens anyway.
  }
};

export type CreateSessionDeps = {
  /** Agents that must run on a local model; `email-agent` today. */
  agentsForceLocalModel: ReadonlySet<string>;
  abortRefreshes: () => void;
  /** The new-chat screen's "Allow for this session". */
  chatWebAccess: {
    /** Sends it for the new root session; never rejects. */
    applyPreselect: (rootSessionId: string) => Promise<void>;
    /** Ends the hand-over if that session was not opened. */
    endPreselect: () => void;
  };
  /** How long the new session waits for that pre-select; `PRESELECT_WAIT_MS` unless a test shortens it. */
  preselectWaitMs?: number;
  baseUrl: Accessor<string>;
  client: Accessor<Client | null>;
  developerMode: Accessor<boolean>;
  goToSession: (sessionId: string, options?: { replace?: boolean }) => void;
  pendingSessionAgent: Accessor<string | null>;
  pendingSessionModel: Accessor<ModelRef | null>;
  prepareSessionAgentModelPolicy: (
    sessionID: string,
    agent: string,
    pendingModel?: ModelRef | null,
  ) => (() => void) | null;
  resolveLocalLlmModel: () => ModelRef | null;
  selectSession: SessionStore["selectSession"];
  sessions: SessionStore["sessions"];
  setBusy: Setter<boolean>;
  setBusyLabel: Setter<string | null>;
  setBusyStartedAt: Setter<number | null>;
  setCreatingSession: Setter<boolean>;
  setError: Setter<string | null>;
  setLocalLlmConfigWarningOpen: Setter<boolean>;
  setPendingSessionAgent: Setter<string | null>;
  setPendingSessionModel: Setter<ModelRef | null>;
  setSessionAgent: (
    sessionID: string,
    agent: string | null,
    opts?: { source?: "user" | "classifier" },
  ) => void;
  setSessionModelOverrideById: Setter<Record<string, ModelRef>>;
  setSessions: SessionStore["setSessions"];
  setSidebarSessionStatusByWorkspaceId: Setter<
    Record<string, WorkspaceSessionGroup["status"]>
  >;
  setSidebarSessionsByWorkspaceId: Setter<Record<string, SidebarSessionItem[]>>;
  sidebarSessionsByWorkspaceId: Accessor<Record<string, SidebarSessionItem[]>>;
  workspaceStore: {
    activeWorkspaceId: Accessor<string>;
    activeWorkspaceRoot: Accessor<string>;
  };
};

export const createSessionCreator = (deps: CreateSessionDeps) => {
  // `deps` is a plain object of accessors built once by `App()`, not a Solid
  // props proxy, so destructuring copies function references without
  // collapsing reactivity — and keeps the body below identical to the one
  // that lived in `App()`.
  const {
    agentsForceLocalModel,
    abortRefreshes,
    chatWebAccess,
    preselectWaitMs = PRESELECT_WAIT_MS,
    baseUrl,
    client,
    developerMode,
    goToSession,
    pendingSessionAgent,
    pendingSessionModel,
    prepareSessionAgentModelPolicy,
    resolveLocalLlmModel,
    selectSession,
    sessions,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setCreatingSession,
    setError,
    setLocalLlmConfigWarningOpen,
    setPendingSessionAgent,
    setPendingSessionModel,
    setSessionAgent,
    setSessionModelOverrideById,
    setSessions,
    setSidebarSessionStatusByWorkspaceId,
    setSidebarSessionsByWorkspaceId,
    sidebarSessionsByWorkspaceId,
    workspaceStore,
  } = deps;

  async function createSessionAndOpen(options?: { dispatchInFlight?: () => boolean }) {
    const c = client();
    if (!c) {
      return;
    }

    const perfEnabled = developerMode();
    const startedAt = perfNow();
    const runId = (() => {
      const key = "__openwork_create_session_run__";
      const w = window as typeof window & { [key]?: number };
      w[key] = (w[key] ?? 0) + 1;
      return w[key];
    })();

    const mark = (event: string, payload?: Record<string, unknown>) => {
      const elapsed = Math.round((perfNow() - startedAt) * 100) / 100;
      recordPerfLog(perfEnabled, "session.create", event, {
        runId,
        elapsedMs: elapsed,
        ...(payload ?? {}),
      });
    };

    mark("start", {
      baseUrl: baseUrl(),
      workspace: workspaceStore.activeWorkspaceRoot().trim() || null,
    });

    // Abort any in-flight refresh operations to free up connection resources
    abortRefreshes();

    // Small delay to allow pending requests to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    // While another tab's prompt dispatch is in flight, the header keeps its
    // label and clock. Checked at each step: that dispatch can finish first.
    const dispatchInFlight = options?.dispatchInFlight ?? (() => false);
    setBusy(true);
    if (!dispatchInFlight()) {
      setBusyLabel("status.creating_task");
      setBusyStartedAt(Date.now());
    }
    setError(null);
    setCreatingSession(true);

    try {
      const pendingModel = pendingSessionModel();
      const pendingAgent = pendingSessionAgent();
      const pendingAgentRequiresLocalModel =
        pendingAgent !== null && agentsForceLocalModel.has(pendingAgent);
      const pendingAgentLocalModel = pendingAgentRequiresLocalModel
        ? resolveLocalLlmModel()
        : null;

      if (pendingAgentRequiresLocalModel && !pendingAgentLocalModel) {
        setLocalLlmConfigWarningOpen(true);
        setPendingSessionModel(null);
        setPendingSessionAgent(null);
        return;
      }

      // Quick health check to detect stale connection
      mark("health:start");
      try {
        await withTimeout(c.global.health(), 3_000, "health");
        mark("health:ok");
      } catch (healthErr) {
        mark("health:error", {
          error:
            healthErr instanceof Error
              ? healthErr.message
              : safeStringify(healthErr),
        });
        throw new Error(t("app.connection_lost", currentLocale()));
      }

      let rawResult: Awaited<ReturnType<typeof c.session.create>>;
      try {
        mark("session:create:start");
        rawResult = await c.session.create({
          directory: workspaceStore.activeWorkspaceRoot().trim(),
        });
        mark("session:create:ok");
      } catch (createErr) {
        mark("session:create:error", {
          error:
            createErr instanceof Error
              ? createErr.message
              : safeStringify(createErr),
        });
        throw createErr;
      }

      const session = unwrap(rawResult);

      // Only for a chat that will open: a routing refused below leaves the choice for the next. Whether it
      // is refused does not depend on the selection, so it is known before the session is selected. Awaited
      // before the session opens, so its first prompt cannot overtake the PUT; the user stays on the
      // new-chat screen, as during `session.create`.
      const routingRefused = pendingAgent
        ? prepareSessionAgentModelPolicy(session.id, pendingAgent, pendingModel) === null
        : false;
      if (!routingRefused) await settleWithin(chatWebAccess.applyPreselect(session.id), preselectWaitMs);

      // Immediately select and show the new session before background list refresh.
      if (!dispatchInFlight()) setBusyLabel("status.loading_session");
      mark("session:select:start", { sessionID: session.id });
      await selectSession(session.id);
      mark("session:select:ok", { sessionID: session.id });

      const pendingRoutingApplied = applyPendingSessionRouting({
        sessionID: session.id,
        pendingAgent,
        pendingModel,
        setSessionAgent,
        setSessionModel: (sessionID, model) => {
          setSessionModelOverrideById((current) => ({
            ...current,
            [sessionID]: model,
          }));
        },
        clearPendingAgent: () => setPendingSessionAgent(null),
        clearPendingModel: () => setPendingSessionModel(null),
        prepareAgentModelPolicy: prepareSessionAgentModelPolicy,
      });

      if (!pendingRoutingApplied) {
        setLocalLlmConfigWarningOpen(true);
        return;
      }

      // Inject the new session into the reactive sessions() store so
      // the createEffect bridge (sessions → sidebar) will always include it,
      // even if the background loadSessionsWithReady hasn't returned yet.
      const currentStoreSessions = sessions();
      if (!currentStoreSessions.some((s) => s.id === session.id)) {
        setSessions([session, ...currentStoreSessions]);
      }

      const newItem: SidebarSessionItem = {
        id: session.id,
        title: session.title ? stripModelPrefix(session.title) : session.title,
        slug: session.slug,
        parentID: session.parentID,
        time: session.time,
        directory: session.directory,
      };
      const wsId = workspaceStore.activeWorkspaceId().trim();
      if (wsId) {
        const currentSessions = sidebarSessionsByWorkspaceId()[wsId] || [];
        setSidebarSessionsByWorkspaceId((prev) => ({
          ...prev,
          [wsId]: [newItem, ...currentSessions],
        }));
        setSidebarSessionStatusByWorkspaceId((prev) => ({
          ...prev,
          [wsId]: "ready",
        }));
      }

      goToSession(session.id);

      // The new session is already in the sessions() store (injected above)
      // and in the sidebar signal. SSE session.created events will handle
      // any further syncing. Calling loadSessionsWithReady() here would
      // race with the store injection — the server may not have indexed the
      // session yet, so reconcile() would wipe it from the store, causing
      // the sidebar to flash and the route guard to bounce back.
      finishPerf(perfEnabled, "session.create", "done", startedAt, {
        runId,
        sessionID: session.id,
      });
      return session.id;
    } catch (e) {
      finishPerf(perfEnabled, "session.create", "error", startedAt, {
        runId,
        error: e instanceof Error ? e.message : safeStringify(e),
      });
      const message =
        e instanceof Error
          ? e.message
          : t("app.unknown_error", currentLocale());
      setError(addOpencodeCacheHint(message));
      // Issue #420: drop any pending per-session model override so a failed
      // create doesn't leak (e.g. email-agent's local-llm) into the next
      // create attempt.
      setPendingSessionModel(null);
      setPendingSessionAgent(null);
      return undefined;
    } finally {
      // A failure after the pre-select leaves its session unopened; once opened, this changes nothing.
      chatWebAccess.endPreselect();
      setCreatingSession(false);
      setBusy(false);
    }
  }

  return { createSessionAndOpen };
};
