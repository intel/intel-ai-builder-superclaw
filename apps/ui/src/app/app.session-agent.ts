/**
 * Which agent a session runs as, from the UI's side.
 *
 * Two in-memory records drive dispatch: `sessionAgentById` (the composer's agent,
 * sent with every prompt) and `classifierResolvedSessionById` (the session has
 * been routed, so the Intent Classifier is not consulted again). The UI used to
 * fill them only when it dispatched a prompt itself or the user picked an agent.
 * A session it did not drive (a scheduled automation, an API-created session,
 * anything opened after an app restart) therefore had neither, and each typed
 * follow-up was classified from scratch as if it opened a new conversation
 * (#2875). `hydrateSessionAgentFromServer` fills both from the messages the
 * session load already fetched, so no extra OpenCode call is made.
 */

import type { Accessor, Setter } from "solid-js";

import type { CapabilityGate } from "~/shared/platform/capability/capability-gate";
import { latchClassifierResolvedSession } from "~/shared/platform/capability/intent-classifier-call-policy";
import { isAgentPickable } from "~/shared/platform/capability/visible-agent-roster";
import type { MessageWithParts } from "~/shared/types/session";

/** OpenCode's own housekeeping agents: they never answer the user. */
const OPENCODE_INTERNAL_AGENTS = new Set(["compaction", "title", "summary"]);

/** The fallback agent OpenCode runs when a prompt names none. */
const DEFAULT_AGENT = "superclaw-default";

/**
 * The agent a session last ran as, read from OpenCode's stored messages.
 *
 * The newest user message wins because it records the most recent explicit
 * dispatch; assistant messages are only a fallback for a history without one.
 * The session's own `agent` field is deliberately not consulted. Pass the
 * server's message list, not the UI's merged view: the classifier's synthetic
 * turns live only in the latter.
 */
export function sessionAgentFromServerMessages(
  list: readonly MessageWithParts[],
): string | null {
  let assistantAgent: string | null = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const info = list[i]?.info as { role?: unknown; agent?: unknown } | undefined;
    const agent = typeof info?.agent === "string" ? info.agent.trim() : "";
    if (!agent || OPENCODE_INTERNAL_AGENTS.has(agent)) continue;
    if (info?.role === "user") return agent;
    if (info?.role === "assistant" && assistantAgent === null) assistantAgent = agent;
  }
  return assistantAgent;
}

export type SessionAgentSelectionDeps = {
  sessionAgentById: Accessor<Record<string, string>>;
  setSessionAgentById: Setter<Record<string, string>>;
  classifierResolvedSessionById: Accessor<Record<string, true>>;
  setClassifierResolvedSessionById: Setter<Record<string, true>>;
  capabilityGate: Pick<
    CapabilityGate,
    "isActive" | "isLoading" | "isAgentAllowed" | "productProfileId"
  >;
};

export function createSessionAgentSelection(deps: SessionAgentSelectionDeps) {
  // Sessions whose agent is already decided in this app lifetime: the UI set it
  // (user pick or classifier route), or a non-empty server history was
  // considered once. Hydration never revisits them, so a user who cleared the
  // agent to "Default" is not overridden when they reopen the session.
  const settled = new Set<string>();

  function setSessionAgent(
    sessionID: string,
    agent: string | null,
    opts?: { source?: "user" | "classifier" },
  ) {
    settled.add(sessionID);
    const trimmed = agent?.trim() ?? "";
    // User-driven changes reopen the session to classification; a
    // classifier-driven change must not, since the classifier sets that flag
    // itself right after this call.
    if (opts?.source !== "classifier") {
      deps.setClassifierResolvedSessionById((current) => {
        if (!(sessionID in current)) return current;
        const next = { ...current };
        delete next[sessionID];
        return next;
      });
    }
    deps.setSessionAgentById((current) => {
      const next = { ...current };
      if (!trimmed) {
        delete next[sessionID];
        return next;
      }
      next[sessionID] = trimmed;
      return next;
    });
  }

  /**
   * Adopt the agent a session already runs as on the server, leaving it in the
   * state a classifier route would have: session latched and, for any agent but
   * the default, that agent pinned. Anything the UI already holds for the
   * session wins. An agent the user could not pick under the active Product
   * Profile is not adopted, so that session is classified as before.
   */
  function hydrateSessionAgentFromServer(
    sessionID: string,
    messages: readonly MessageWithParts[],
    session: { parentID?: string } | null,
  ) {
    if (settled.has(sessionID)) return;
    // An empty load (a session opened before its first turn, or emptied by a
    // context prune) decides nothing; a later load may still hydrate it.
    if (messages.length === 0) return;
    // While the first Profile is still resolving, the roster gate below cannot
    // be checked yet, so retry on a later load rather than guess. With gating
    // unavailable (web, no provider, transport error) the picker offers every
    // agent, and so does the gate below.
    if (deps.capabilityGate.isLoading()) return;
    settled.add(sessionID);
    // A subagent's child session is read-only and carries the subagent's agent.
    if (session?.parentID?.trim()) return;
    if (
      deps.sessionAgentById()[sessionID] ||
      deps.classifierResolvedSessionById()[sessionID]
    ) {
      return;
    }
    const agent = sessionAgentFromServerMessages(messages);
    if (!agent) return;
    const latch = () =>
      deps.setClassifierResolvedSessionById((current) =>
        latchClassifierResolvedSession(current, sessionID),
      );
    // The default agent is latched but not pinned: the composer keeps showing
    // "Default", and a prompt sent with no agent runs as OpenCode's
    // `default_agent`, which every Profile sets to superclaw-default.
    if (agent === DEFAULT_AGENT) return latch();
    if (
      !isAgentPickable(
        agent,
        deps.capabilityGate.isActive(),
        deps.capabilityGate.isAgentAllowed,
        deps.capabilityGate.productProfileId(),
      )
    ) {
      return;
    }
    deps.setSessionAgentById((current) => ({ ...current, [sessionID]: agent }));
    latch();
  }

  return { setSessionAgent, hydrateSessionAgentFromServer };
}
