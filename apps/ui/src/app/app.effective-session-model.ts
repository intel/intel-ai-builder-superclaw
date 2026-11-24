/**
 * Which model a session is actually on, which is rarely the one the picker
 * last wrote.
 *
 * Five sources can answer, and they are tried in order of how deliberate they
 * are: a session override (the user picked it for this session), the model
 * the server reports for the session, the model the last user message was
 * sent with, and finally the app default. With no session open the pending
 * pick stands in for the first three.
 *
 * Two things then adjust the answer. A cloud-only profile rewrites any
 * residual llmrouter auto/local route to cloud-model — this is the single
 * choke point every consumer (label, isLocal, sendPrompt) reads, so a setter
 * that bypassed the policy still cannot send Local or Auto. And for a draft
 * with no session and no pick, the chosen agent may force the local model.
 *
 * Every conditionally-read input arrives as a thunk, and that is load-bearing
 * rather than stylistic. The caller is a `createMemo`, so a memo depends on
 * exactly the signals it read during its last run. Taking these as values
 * would make the memo read all of them on every run and therefore invalidate
 * on changes it is supposed to ignore — a session with an override would
 * re-resolve whenever the draft agent changed. `profile` and
 * `selectedSessionId` are values because the original read both every time.
 */
import type { ActiveAppCapabilityProfile } from "@different-ai/openwork-contracts/capability";

import { normalizeSessionRouteForProfile } from "~/shared/platform/capability/session-route-policy";

import { resolveDraftAgentModel } from "./session-draft-routing";
import type { ModelRef } from "./types";

export type EffectiveSessionModelInput = {
  /** Agents that cannot run on a cloud model; `email-agent` today. */
  agentsForceLocalModel: ReadonlySet<string>;
  defaultModel: () => ModelRef;
  /** The configured local model, or `null` when there is none. */
  localLlmModel: () => ModelRef | null;
  /** The model the last user message was sent with. */
  modelFromMessages: () => ModelRef | null;
  pendingSessionAgent: () => string | null;
  pendingSessionModel: () => ModelRef | null;
  profile: ActiveAppCapabilityProfile | null | undefined;
  selectedSessionId: string | null;
  sessionModelById: () => Record<string, ModelRef>;
  sessionModelOverrideById: () => Record<string, ModelRef>;
};

export function resolveEffectiveSessionModel(
  input: EffectiveSessionModelInput,
): ModelRef {
  const {
    agentsForceLocalModel,
    defaultModel,
    localLlmModel,
    modelFromMessages,
    pendingSessionAgent,
    pendingSessionModel,
    profile,
    selectedSessionId,
    sessionModelById,
    sessionModelOverrideById,
  } = input;

  const resolve = (): ModelRef => {
    if (!selectedSessionId) return pendingSessionModel() ?? defaultModel();

    const override = sessionModelOverrideById()[selectedSessionId];
    if (override) return override;

    const known = sessionModelById()[selectedSessionId];
    if (known) return known;

    return modelFromMessages() ?? defaultModel();
  };

  const resolved = resolve();

  // The draft agent only gets a say when nothing more deliberate has: an open
  // session, or a model already picked for the one about to be created.
  if (selectedSessionId || pendingSessionModel()) {
    return normalizeSessionRouteForProfile(resolved, profile);
  }

  return normalizeSessionRouteForProfile(
    resolveDraftAgentModel(
      resolved,
      pendingSessionAgent(),
      localLlmModel(),
      agentsForceLocalModel,
    ),
    profile,
  );
}
