/**
 * When the session model is the auto-router, decide whether this particular
 * turn should bypass it and stay on the local model. The rules are about the
 * agent, the draft's content and the PII posture, not about the router itself,
 * which is why they are worth reading (and testing) on their own.
 *
 * Pure: the two reactive reads come in as getters so the short-circuit order
 * of the original conditions is preserved exactly.
 */
import type { ComposerDraft, ModelRef, PiiLevel } from "./types";
import { hasNonSpreadsheetLocalFile } from "~/shared/util/localFileBypass";
import { isSimpleQuestion } from "~/shared/util/simpleQuestion";

export type AgentModelPolicy = {
  localModelExplicitlyUnavailable: () => boolean;
  piiLevel: () => PiiLevel;
};

export function resolveAgentModelOverride(
  model: ModelRef,
  agent: string | null,
  draft: ComposerDraft,
  policy: AgentModelPolicy,
): ModelRef {
  const { localModelExplicitlyUnavailable, piiLevel } = policy;
  if (model.providerID !== "llmrouter" || model.modelID !== "auto")
    return model;
  if (agent === "email-agent") {
    return localModelExplicitlyUnavailable()
      ? model
      : { providerID: "llmrouter", modelID: "local-model" };
  }
  if (!localModelExplicitlyUnavailable() && isSimpleQuestion(draft)) {
    // Greetings and chitchat ("hi", "how are you", "what can you do", etc.)
    // bypass the auto-router and stay on the local model. There's nothing for
    // the cloud model to add for these, and round-tripping them through the
    // router wastes a turn on a trivial response.
    return { providerID: "llmrouter", modelID: "local-model" };
  }
  // The default and build (coding) agents own the protected-file pipeline:
  // for them, non-spreadsheet local files must be allowed to route to cloud
  // so confirm_file_protection can trigger protected-file-agent when the
  // session is cloud-routed. Only the OTHER agents keep the force-local
  // behavior (no protected pipeline, so keep their data on the local model).
  const isDefaultOrBuildAgent =
    !agent || agent === "superclaw-default" || agent === "build";
  if (
    !localModelExplicitlyUnavailable() &&
    piiLevel() !== "none" &&
    hasNonSpreadsheetLocalFile(draft) &&
    !isDefaultOrBuildAgent
  ) {
    // When PII protection is active (medium/high/custom), local files
    // (other than tabular csv/xlsx) bypass the auto-router and go straight
    // to the local model. With piiLevel === "none" the user has opted out
    // of protection, so we let the router decide. Spreadsheets stay on the
    // auto-router because cloud models handle structured tabular data better.
    return { providerID: "llmrouter", modelID: "local-model" };
  }
  return model;
}
