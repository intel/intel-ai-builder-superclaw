import { createEffect, createMemo, type Accessor } from "solid-js";
import type { ActiveAppCapabilityProfile } from "@different-ai/openwork-contracts/capability";

import {
  isCloudOnlySessionProfile,
  normalizeSessionRouteForProfile,
} from "~/shared/platform/capability/session-route-policy";
import { modelEquals } from "~/shared/util/model-ref";

import { routeAwayFromHiddenCloud, shouldHideCloudRoute } from "./app.model-picker";
import type { ModelRef } from "./types";

/**
 * The two rewrites of stored model picks (default model, pending pick,
 * per-session overrides) that follow a change in which routes the chat may
 * use. `selectedSessionModel` already adjusts the model a turn is sent with;
 * these keep the PERSISTED picks consistent with it, so a stale value does not
 * linger in localStorage / config or come back later.
 */
type StoredRoutePicks = {
  defaultModel: Accessor<ModelRef>;
  setDefaultModel: (model: ModelRef) => void;
  pendingSessionModel: Accessor<ModelRef | null>;
  setPendingSessionModel: (model: ModelRef) => void;
  sessionModelOverrideById: Accessor<Record<string, ModelRef>>;
  setSessionModelOverrideById: (overrides: Record<string, ModelRef>) => void;
};

/** Writes `rewrite(ref)` back to the default and pending picks where it differs. */
function rewriteDefaultAndPending(picks: StoredRoutePicks, rewrite: (ref: ModelRef) => ModelRef) {
  const currentDefault = picks.defaultModel();
  const nextDefault = rewrite(currentDefault);
  if (!modelEquals(currentDefault, nextDefault)) picks.setDefaultModel(nextDefault);

  const pending = picks.pendingSessionModel();
  if (!pending) return;
  const nextPending = rewrite(pending);
  if (!modelEquals(pending, nextPending)) picks.setPendingSessionModel(nextPending);
}

/**
 * Cloud-only profile (minimal + 0.8b): rewrite any stored llmrouter auto/local
 * to cloud-model. Runs once per active profile revision; it only ever
 * collapses auto/local→cloud under the restricted profile, so it never
 * clobbers a legitimate user choice on any other grade.
 */
export function createCloudOnlyRouteRewrite(
  deps: StoredRoutePicks & { activeProfile: Accessor<ActiveAppCapabilityProfile | null | undefined> },
): void {
  let lastNormalizedRevision: number | null = null;
  createEffect(() => {
    const profile = deps.activeProfile();
    if (!isCloudOnlySessionProfile(profile) || !profile) {
      lastNormalizedRevision = null;
      return;
    }
    if (lastNormalizedRevision === profile.profile_revision) return;
    lastNormalizedRevision = profile.profile_revision;

    const normalize = (ref: ModelRef) => normalizeSessionRouteForProfile(ref, profile);
    rewriteDefaultAndPending(deps, normalize);

    const overrides = deps.sessionModelOverrideById();
    if (Object.values(overrides).some((ref) => !modelEquals(ref, normalize(ref)))) {
      deps.setSessionModelOverrideById(
        Object.fromEntries(Object.entries(overrides).map(([sid, ref]) => [sid, normalize(ref)])),
      );
    }
  });
}

/**
 * With no cloud model saved, Cloud leaves the main page picker, and a chat on
 * Cloud runs on Auto instead (see `shouldHideCloudRoute`).
 *
 * While Cloud is hidden, every stored Cloud pick is also rewritten to Auto, so
 * a chat stays on Auto after a cloud model is saved again instead of jumping
 * back to Cloud. A session with no override that resolves to Cloud through
 * the server-reported model or its message history gets an Auto override:
 * rewriting the value it resolves through would be undone by the next server
 * read. Returns whether Cloud is hidden.
 */
export function createHiddenCloudRoute(
  deps: StoredRoutePicks & {
    allowedAliases: Accessor<readonly ModelRef[]>;
    cloudModelMissing: Accessor<boolean>;
    selectedSessionId: Accessor<string | null>;
    /** The model the selected session's last user message was sent with. */
    modelFromMessages: Accessor<ModelRef | null>;
    sessionModelById: Accessor<Record<string, ModelRef>>;
  },
): Accessor<boolean> {
  const hideCloudRoute = createMemo(() =>
    shouldHideCloudRoute({
      allowedAliases: deps.allowedAliases(),
      cloudModelMissing: deps.cloudModelMissing(),
    }),
  );

  createEffect(() => {
    if (!hideCloudRoute()) return;
    rewriteDefaultAndPending(deps, (ref) => routeAwayFromHiddenCloud(ref, true));

    const overrides = deps.sessionModelOverrideById();
    const next = rewriteSessionCloudPicks({
      overrides,
      sessionModelById: deps.sessionModelById(),
      selectedSessionId: deps.selectedSessionId(),
      modelFromMessages: deps.modelFromMessages(),
    });
    if (next !== overrides) deps.setSessionModelOverrideById(next);
  });

  return hideCloudRoute;
}

/**
 * The per-session overrides with every Cloud pick on Auto: an existing Cloud
 * override is rewritten, and a session with no override that resolves to
 * Cloud gets an Auto one. Returns `overrides` itself when nothing changes.
 */
export function rewriteSessionCloudPicks(input: {
  overrides: Record<string, ModelRef>;
  sessionModelById: Record<string, ModelRef>;
  selectedSessionId: string | null;
  modelFromMessages: ModelRef | null;
}): Record<string, ModelRef> {
  const toAuto = (ref: ModelRef) => routeAwayFromHiddenCloud(ref, true);
  const next: Record<string, ModelRef> = { ...input.overrides };
  let changed = false;

  for (const [sid, ref] of Object.entries(input.overrides)) {
    if (modelEquals(ref, toAuto(ref))) continue;
    next[sid] = toAuto(ref);
    changed = true;
  }

  // Message history is only loaded for the selected session, so it can only
  // stand in for that one.
  const resolvedWithoutOverride: Record<string, ModelRef> = { ...input.sessionModelById };
  const selected = input.selectedSessionId;
  if (selected && !resolvedWithoutOverride[selected] && input.modelFromMessages) {
    resolvedWithoutOverride[selected] = input.modelFromMessages;
  }
  for (const [sid, ref] of Object.entries(resolvedWithoutOverride)) {
    if (input.overrides[sid] || modelEquals(ref, toAuto(ref))) continue;
    next[sid] = toAuto(ref);
    changed = true;
  }

  return changed ? next : input.overrides;
}
