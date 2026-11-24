/**
 * Opening, closing and committing a model pick.
 *
 * The decisions themselves are already pure and live in `app.model-picker`:
 * `planModelSelection` says where a pick should be written, and
 * `resolveUnconfiguredSelectionWarning` says whether to warn about it. What
 * is left here is the part that touches state — reading the picker's target,
 * writing the chosen model to the right place, and putting focus back where
 * the user left it.
 *
 * Two things are easy to get wrong and so are worth naming. A pick is
 * normalized for the capability profile *before* it is persisted, so a
 * restricted route cannot be written back through the picker. And a session
 * pick clears the agent-managed marker: the model is now the user's choice,
 * so switching agents later must not take it away.
 */
import type { ActiveAppCapabilityProfile } from "@different-ai/openwork-contracts/capability";
import type { Accessor, Setter } from "solid-js";

import { normalizeSessionRouteForProfile } from "~/shared/platform/capability/session-route-policy";
import { isTauriRuntime } from "~/shared/platform/runtime-env";

import {
  planModelSelection,
  resolveUnconfiguredSelectionWarning,
} from "./app.model-picker";
import {
  isLocalModelConfigured,
  type LocalModelHealthInfo,
} from "./lib/local-model-availability";
import type { ModelRef, PromptFocusReturnTarget } from "./types";
import type { Language } from "../i18n";

export type ModelPickerActionsDeps = {
  activeProfile: Accessor<ActiveAppCapabilityProfile | null | undefined>;
  activeWorkspacePath: Accessor<string>;
  activeWorkspaceType: Accessor<string>;
  /** The pick is the user's own; drop any marker claiming the agent set it. */
  clearSessionAgentManagedModelMarker: (sessionID: string) => void;
  cloudModel: Accessor<unknown>;
  currentLocale: Accessor<Language>;
  focusSessionPromptSoon: () => void;
  localModelHealth: Accessor<LocalModelHealthInfo | null>;
  modelPickerReturnFocusTarget: Accessor<PromptFocusReturnTarget>;
  modelPickerTarget: Accessor<"session" | "default">;
  selectedSessionId: Accessor<string | null>;
  setDefaultModel: Setter<ModelRef>;
  setDefaultModelExplicit: Setter<boolean>;
  setModelPickerOpen: Setter<boolean>;
  setModelPickerQuery: Setter<string>;
  setModelPickerReturnFocusTarget: Setter<PromptFocusReturnTarget>;
  setModelPickerTarget: Setter<"session" | "default">;
  setModelSelectToast: Setter<string | null>;
  setPendingDefaultModelWrite: Setter<boolean>;
  setPendingSessionModel: Setter<ModelRef | null>;
  setSessionModelOverrideById: Setter<Record<string, ModelRef>>;
};

export const createModelPickerActions = (deps: ModelPickerActionsDeps) => {
  // `deps` is a plain object of accessors built once by `App()`, not a Solid
  // props proxy, so destructuring copies function references without
  // collapsing reactivity.
  const {
    activeProfile,
    activeWorkspacePath,
    activeWorkspaceType,
    clearSessionAgentManagedModelMarker,
    cloudModel,
    currentLocale,
    focusSessionPromptSoon,
    localModelHealth,
    modelPickerReturnFocusTarget,
    modelPickerTarget,
    selectedSessionId,
    setDefaultModel,
    setDefaultModelExplicit,
    setModelPickerOpen,
    setModelPickerQuery,
    setModelPickerReturnFocusTarget,
    setModelPickerTarget,
    setModelSelectToast,
    setPendingDefaultModelWrite,
    setPendingSessionModel,
    setSessionModelOverrideById,
  } = deps;

  function closeModelPicker(options?: { restorePromptFocus?: boolean }) {
    const shouldFocusPrompt =
      options?.restorePromptFocus ??
      modelPickerReturnFocusTarget() === "composer";
    setModelPickerOpen(false);
    setModelPickerReturnFocusTarget("none");
    if (shouldFocusPrompt) {
      focusSessionPromptSoon();
    }
  }

  function openSessionModelPicker(options?: {
    returnFocusTarget?: PromptFocusReturnTarget;
  }) {
    setModelPickerTarget("session");
    setModelPickerQuery("");
    setModelPickerReturnFocusTarget(options?.returnFocusTarget ?? "composer");
    setModelPickerOpen(true);
  }

  function openDefaultModelPicker() {
    setModelPickerTarget("default");
    setModelPickerQuery("");
    setModelPickerReturnFocusTarget("none");
    setModelPickerOpen(true);
  }

  /**
   * The picker lets you choose a route nothing is configured for. That is
   * allowed, so this warns rather than blocks.
   */
  function maybeWarnUnconfiguredSelection(model: ModelRef) {
    const warning = resolveUnconfiguredSelectionWarning({
      model,
      cloudConfigured: Boolean(cloudModel()),
      localConfigured: isLocalModelConfigured(localModelHealth()),
      locale: currentLocale(),
    });
    if (warning) setModelSelectToast(warning);
  }

  function doApplyModelSelection(rawNext: ModelRef) {
    // Under the cloud-only profile, collapse any llmrouter auto/local pick to
    // cloud-model before persisting, so the restricted route can't be written
    // back via the picker.
    const next = normalizeSessionRouteForProfile(rawNext, activeProfile());
    maybeWarnUnconfiguredSelection(next);
    const plan = planModelSelection({
      target: modelPickerTarget(),
      sessionId: selectedSessionId(),
      isLocalWorkspace: isTauriRuntime() && activeWorkspaceType() === "local",
      hasWorkspacePath: Boolean(activeWorkspacePath().trim()),
    });

    if (plan.kind === "session-override") {
      clearSessionAgentManagedModelMarker(plan.sessionId);
      setSessionModelOverrideById((current) => ({
        ...current,
        [plan.sessionId]: next,
      }));
      closeModelPicker({ restorePromptFocus: plan.restorePromptFocus });
      return;
    }

    if (plan.kind === "pending-session") setPendingSessionModel(next);
    if (plan.persistDefaultWrite) setPendingDefaultModelWrite(true);
    setDefaultModelExplicit(true);
    setDefaultModel(next);
    closeModelPicker({ restorePromptFocus: plan.restorePromptFocus });
  }

  function applyModelSelection(next: ModelRef) {
    doApplyModelSelection(next);
  }

  /**
   * The composer's picker can be reached without `openSessionModelPicker`
   * having run, so it sets the target itself rather than trusting whatever
   * the last picker left behind.
   */
  function applySessionModelSelection(next: ModelRef) {
    setModelPickerTarget("session");
    doApplyModelSelection(next);
  }

  return {
    applyModelSelection,
    applySessionModelSelection,
    closeModelPicker,
    maybeWarnUnconfiguredSelection,
    openDefaultModelPicker,
    openSessionModelPicker,
  };
};
