/**
 * The session model an agent imposes on the user, and how it is given back.
 *
 * Some agents (today only `email-agent`) cannot run on a cloud model, so
 * selecting one pins the session to the local model. That pin is *managed*: it
 * is recorded in `sessionAgentManagedModelById` so switching away from the
 * agent can undo it, while a model the user picked themselves is never
 * touched. Getting that distinction wrong either strands a session on the
 * local model or leaks a local pin into a cloud-routed session, which is why
 * the two clears are separate — one drops the marker and the override, the
 * other drops only the marker.
 *
 * `prepareSessionAgentModelPolicy` returns a thunk rather than acting, so the
 * caller can decide the session is routable *before* committing to the model
 * change; returning `null` means the pin is impossible and the caller should
 * stop. The email-agent cloud-risk confirmation lives here too, because it is
 * the same question asked of the user instead of of the config.
 *
 * Moved out of `App()` unchanged, apart from the pending-confirmation handle,
 * which was a `let` in `App()` and is now closed over by the factory.
 */
import type { Accessor, Setter } from "solid-js";

import type { ModelRef } from "./types";
import type { SettingsSection } from "./pages/settings-dialog.sections";

export type AgentManagedModelDeps = {
  /** Agents that cannot run on a cloud model; `email-agent` today. */
  agentsForceLocalModel: ReadonlySet<string>;
  defaultModel: Accessor<ModelRef>;
  emailAgentCloudRiskAcknowledged: Accessor<boolean>;
  openSettings: (section: SettingsSection) => void;
  resolveLocalLlmModel: () => ModelRef | null;
  selectedSessionId: Accessor<string | null>;
  selectedSessionModel: Accessor<ModelRef>;
  /** Present-and-`true` is the marker; an absent key means unmanaged. */
  sessionAgentManagedModelById: Accessor<Record<string, true>>;
  setSessionAgentManagedModelById: Setter<Record<string, true>>;
  sessionModelById: Accessor<Record<string, ModelRef>>;
  sessionModelOverrideById: Accessor<Record<string, ModelRef>>;
  setSessionModelOverrideById: Setter<Record<string, ModelRef>>;
  setEmailAgentCloudRiskAcknowledged: Setter<boolean>;
  setEmailAgentCloudRiskOpen: Setter<boolean>;
  setLocalLlmConfigWarningOpen: Setter<boolean>;
};

export const createAgentManagedModel = (deps: AgentManagedModelDeps) => {
  // `deps` is a plain object of accessors built once by `App()`, not a Solid
  // props proxy, so destructuring copies function references without
  // collapsing reactivity.
  const {
    agentsForceLocalModel,
    defaultModel,
    emailAgentCloudRiskAcknowledged,
    openSettings,
    resolveLocalLlmModel,
    selectedSessionId,
    selectedSessionModel,
    sessionAgentManagedModelById,
    setSessionAgentManagedModelById,
    sessionModelById,
    sessionModelOverrideById,
    setSessionModelOverrideById,
    setEmailAgentCloudRiskAcknowledged,
    setEmailAgentCloudRiskOpen,
    setLocalLlmConfigWarningOpen,
  } = deps;

  /** Resolves the open cloud-risk dialog; `null` when none is open. */
  let resolveEmailAgentCloudRiskConfirmation: ((ok: boolean) => void) | null =
    null;
  /** The open dialog's answer, shared by every turn waiting on it. */
  let pendingEmailAgentCloudRisk: Promise<boolean> | null = null;

  /**
   * Drop both the marker and the model it pinned — but only if the override
   * was ours. An unmarked session chose its own model.
   */
  function clearSessionAgentManagedModel(sessionID: string) {
    const managed = sessionAgentManagedModelById()[sessionID];
    if (!managed) return;

    setSessionAgentManagedModelById((current) => {
      if (!(sessionID in current)) return current;
      const next = { ...current };
      delete next[sessionID];
      return next;
    });

    setSessionModelOverrideById((current) => {
      if (!(sessionID in current)) return current;
      const next = { ...current };
      delete next[sessionID];
      return next;
    });
  }

  /**
   * Drop only the marker, leaving the model in place: used when the model is
   * about to be, or has just been, chosen deliberately.
   */
  function clearSessionAgentManagedModelMarker(sessionID: string) {
    setSessionAgentManagedModelById((current) => {
      if (!(sessionID in current)) return current;
      const next = { ...current };
      delete next[sessionID];
      return next;
    });
  }

  function prepareSessionAgentModelPolicy(
    sessionID: string,
    agent: string | null,
    pendingModel: ModelRef | null = null,
  ) {
    const trimmed = agent?.trim() ?? "";
    if (trimmed && agentsForceLocalModel.has(trimmed)) {
      if (pendingModel) {
        return () => clearSessionAgentManagedModelMarker(sessionID);
      }
      const nextModel = resolveLocalLlmModel();
      if (!nextModel) return null;
      const currentModel =
        selectedSessionId() === sessionID
          ? selectedSessionModel()
          : sessionModelOverrideById()[sessionID] ??
            sessionModelById()[sessionID] ??
            defaultModel();
      if (
        currentModel.providerID !== "llmrouter" ||
        currentModel.modelID !== "auto"
      ) {
        return () => clearSessionAgentManagedModelMarker(sessionID);
      }
      return () => {
        setSessionModelOverrideById((current) => ({
          ...current,
          [sessionID]: nextModel,
        }));
        setSessionAgentManagedModelById((current) => ({
          ...current,
          [sessionID]: true,
        }));
      };
    }
    return () => {
      // Remove only a stale policy-managed override. Auto or an explicit user
      // model remains the selected route; dispatch applies Email Agent's local
      // effective route separately.
      clearSessionAgentManagedModel(sessionID);
    };
  }

  function applySessionAgentModelPolicy(
    sessionID: string,
    agent: string | null,
  ) {
    const commitAgentModelPolicy = prepareSessionAgentModelPolicy(
      sessionID,
      agent,
    );
    if (!commitAgentModelPolicy) return false;
    commitAgentModelPolicy();
    return true;
  }

  function openLocalLlmSettingsFromWarning() {
    setLocalLlmConfigWarningOpen(false);
    openSettings("model");
  }

  const confirmEmailAgentCloudRisk = async (): Promise<boolean> => {
    if (emailAgentCloudRiskAcknowledged()) return true;

    // Tabs dispatch in parallel, so a second turn can ask while the dialog is
    // open. It waits on the same answer rather than replacing the resolver,
    // which would leave the first turn pending for good.
    pendingEmailAgentCloudRisk ??= new Promise<boolean>((resolve) => {
      resolveEmailAgentCloudRiskConfirmation = resolve;
      setEmailAgentCloudRiskOpen(true);
    });
    return await pendingEmailAgentCloudRisk;
  };

  const resolveEmailAgentCloudRisk = (confirmed: boolean) => {
    const resolve = resolveEmailAgentCloudRiskConfirmation;
    resolveEmailAgentCloudRiskConfirmation = null;
    pendingEmailAgentCloudRisk = null;
    setEmailAgentCloudRiskOpen(false);
    if (confirmed) setEmailAgentCloudRiskAcknowledged(true);
    resolve?.(confirmed);
  };

  return {
    applySessionAgentModelPolicy,
    clearSessionAgentManagedModel,
    clearSessionAgentManagedModelMarker,
    confirmEmailAgentCloudRisk,
    openLocalLlmSettingsFromWarning,
    prepareSessionAgentModelPolicy,
    resolveEmailAgentCloudRisk,
  };
};
