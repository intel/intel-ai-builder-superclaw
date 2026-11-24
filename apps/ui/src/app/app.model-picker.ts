import {
  formatLlmRouterModelFooter,
  LLMROUTER_ALIAS_LABELS,
  LLMROUTER_SESSION_MODELS,
} from "./app.llmrouter-models";
import { t, type Language } from "../i18n";
import { LLMROUTER_ROUTE_ALIASES } from "~/shared/platform/capability/session-route-policy";
import type { ModelOption, ModelRef } from "./types";

/**
 * What the model picker shows, what a search narrows it to, and what a pick
 * means. All of it is a function of its inputs, so it stays out of the
 * component.
 *
 * Which routes a capability profile allows is not decided here. The caller
 * passes the answer in, so `session-route-policy` stays the only place that
 * reads a profile and the only place that needs a profile fixture to test.
 */

/** Where a pick should be written, once the target and session are known. */
type ModelSelectionPlan =
  | { kind: "default"; persistDefaultWrite: boolean; restorePromptFocus: false }
  | {
      kind: "pending-session";
      persistDefaultWrite: boolean;
      restorePromptFocus: boolean;
    }
  | { kind: "session-override"; sessionId: string; restorePromptFocus: boolean };

const AUTO_ROUTE: ModelRef = LLMROUTER_ROUTE_ALIASES.auto;

function isCloudRoute(model: ModelRef): boolean {
  return (
    model.providerID === LLMROUTER_ROUTE_ALIASES.cloudModel.providerID &&
    model.modelID === LLMROUTER_ROUTE_ALIASES.cloudModel.modelID
  );
}

/**
 * True when Cloud must leave the picker: LLMRouter said no cloud model is
 * saved, and the profile allows another route. On a cloud-only profile Cloud
 * is the only route, so it stays.
 */
export function shouldHideCloudRoute(input: {
  allowedAliases: readonly ModelRef[];
  cloudModelMissing: boolean;
}): boolean {
  return input.cloudModelMissing && input.allowedAliases.some((alias) => !isCloudRoute(alias));
}

/** Moves a Cloud route to Auto when Cloud is hidden. Any other model passes through. */
export function routeAwayFromHiddenCloud(model: ModelRef, hideCloudRoute: boolean): ModelRef {
  return hideCloudRoute && isCloudRoute(model) ? AUTO_ROUTE : model;
}

export function buildModelOptions(input: {
  /** The route aliases the active profile permits, from `session-route-policy`. */
  allowedAliases: readonly ModelRef[];
  /** Drop Cloud from the list, from {@link shouldHideCloudRoute}. */
  hideCloudRoute?: boolean;
  getResolvedModelName: (modelID: string) => string | null;
}): ModelOption[] {
  const allowedIds = new Set(
    input.allowedAliases
      .filter((alias) => !(input.hideCloudRoute && isCloudRoute(alias)))
      .map((alias) => alias.modelID),
  );

  return LLMROUTER_SESSION_MODELS.filter((model) =>
    allowedIds.has(model.modelID),
  ).map((model) => ({
    providerID: model.providerID,
    modelID: model.modelID,
    title: LLMROUTER_ALIAS_LABELS[model.modelID] ?? model.modelID,
    description: "llmrouter",
    footer: formatLlmRouterModelFooter(model.modelID, input.getResolvedModelName),
    isFree: true,
    isConnected: true,
    isLocal: model.modelID === "local-model",
  }));
}

/**
 * Matches against everything the row displays plus its connection and price
 * state, so "connected" and "free" work as search terms even though neither
 * appears as text.
 */
export function filterModelOptions(
  options: ModelOption[],
  query: string,
): ModelOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;

  return options.filter((opt) =>
    [
      opt.title,
      opt.description ?? "",
      opt.footer ?? "",
      `${opt.providerID}/${opt.modelID}`,
      opt.isConnected ? "connected" : "disconnected",
      opt.isFree ? "free" : "paid",
    ]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}

/**
 * The picker lets you choose a route that nothing is configured for - `auto`
 * with no cloud key, say. That is allowed, so this returns a warning to show
 * rather than blocking the pick. Returns null when the pick is serviceable.
 */
export function resolveUnconfiguredSelectionWarning(input: {
  model: ModelRef;
  cloudConfigured: boolean;
  localConfigured: boolean;
  locale: Language;
}): string | null {
  const { model, cloudConfigured, localConfigured, locale } = input;
  if (model.providerID !== "llmrouter") return null;

  if (model.modelID === "auto") {
    if (!cloudConfigured && !localConfigured) {
      return t("model.toast_auto_needs_both", locale);
    }
    if (!cloudConfigured) return t("model.toast_auto_needs_cloud", locale);
    if (!localConfigured) return t("model.toast_auto_needs_local", locale);
    return null;
  }

  if (model.modelID === "cloud-model") {
    return cloudConfigured ? null : t("model.toast_cloud_needs_config", locale);
  }

  if (model.modelID === "local-model") {
    return localConfigured ? null : t("model.toast_local_needs_config", locale);
  }

  return null;
}

/**
 * With no session open, a session-targeted pick becomes the default as well
 * as the pending session model, so the choice survives until a session
 * exists to own it.
 */
export function planModelSelection(input: {
  target: "session" | "default";
  sessionId: string | null;
  isLocalWorkspace: boolean;
  hasWorkspacePath: boolean;
}): ModelSelectionPlan {
  const persistDefaultWrite = input.isLocalWorkspace && input.hasWorkspacePath;
  const restorePromptFocus = input.target === "session";

  if (input.target === "default") {
    return { kind: "default", persistDefaultWrite, restorePromptFocus: false };
  }
  if (!input.sessionId) {
    return { kind: "pending-session", persistDefaultWrite, restorePromptFocus };
  }
  return {
    kind: "session-override",
    sessionId: input.sessionId,
    restorePromptFocus,
  };
}
