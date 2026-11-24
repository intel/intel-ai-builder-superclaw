/** How the console words an activation failure that ServiceHub typed, so every surface agrees. */

import {
  ACTIVATION_FALLBACK_MESSAGE,
  MODEL_BINDING_ACTIVATION_ERROR_COPY,
  RUNTIME_PROVISION_FAILURE_COPY,
  RuntimeProvisionFailureReasonSchema,
  hasStableCode,
  withStableCode,
  type ModelBindingActivationError,
  type ModelBindingActivationErrorCode,
  type RuntimeProvisionFailureReason,
} from "@different-ai/openwork-contracts/capability";
import { ServiceHubHttpError } from "~/shared/platform/transport/servicehub";

/**
 * The generic sentences an older ServiceHub sends where it now sends the code's own: a failed operation's, and
 * the three of its 409 bodies. Its other refusals ("Explicit download confirmation is required.") are specific
 * and are shown as they are.
 */
const GENERIC_MESSAGES: ReadonlySet<string> = new Set([
  ACTIVATION_FALLBACK_MESSAGE,
  "Model Binding Activation cannot start.",
  "Model Binding Activation conflicts with durable state.",
  "Model Binding Activation cannot resume.",
]);

/** The sentence to show for `code`: ServiceHub's own, unless it sent nothing or one of the generic sentences. */
function sentenceFor(message: string, code: ModelBindingActivationErrorCode): string {
  return message && !GENERIC_MESSAGES.has(message) ? message : MODEL_BINDING_ACTIVATION_ERROR_COPY[code];
}

/**
 * `<sentence> (Code: <code>)`. ServiceHub folds an internal cause into `safe_error` and spells the cause as
 * the code at the end of its own sentence, so a sentence that already ends with a code is left as it is.
 */
function withCodeUnlessCoded(sentence: string, code: string): string {
  return hasStableCode(sentence) ? sentence : withStableCode(sentence, code);
}

/**
 * The text for a failed activation. Every error shows its stable `code` after the sentence (a runtime
 * provision failure shows its `reason`), so it can be grepped, screenshotted and parsed.
 */
export function activationErrorText(error: ModelBindingActivationError): string {
  if (error.code === "runtime_provision_failed") return withStableCode(error.message, error.reason);
  return withCodeUnlessCoded(sentenceFor(error.message, error.code), error.code);
}

/**
 * The text for an activation request (start, resume, poll) that threw. A ServiceHub refusal that carries
 * one of the activation codes is worded like a failed operation; anything else keeps its own message.
 */
export function activationRequestErrorText(error: unknown, fallback: string): string {
  if (
    error instanceof ServiceHubHttpError &&
    error.code !== undefined &&
    Object.prototype.hasOwnProperty.call(MODEL_BINDING_ACTIVATION_ERROR_COPY, error.code)
  ) {
    const code = error.code as ModelBindingActivationErrorCode;
    return withCodeUnlessCoded(sentenceFor(error.message, code), code);
  }
  return error instanceof Error ? error.message : fallback;
}

/** The provision failure reason a sandbox-token refusal carries, when it is `runtime_provision_failed`. */
export function owtProvisionFailureReason(refusal: { code: string; reason?: string }): RuntimeProvisionFailureReason | null {
  if (refusal.code !== "runtime_provision_failed") return null;
  const parsed = RuntimeProvisionFailureReasonSchema.safeParse(refusal.reason);
  return parsed.success ? parsed.data : null;
}

/**
 * What the console shows when the sandbox-token endpoint refuses because the sandbox's provision was
 * refused (a declined UAC prompt, say); `null` for any other refusal. The sentence is the contract's
 * curated text for the reason plus its code; an unknown reason falls back to the server's own message.
 */
export function owtProvisionRefusalText(refusal: { code: string; message: string; reason?: string }): string | null {
  if (refusal.code !== "runtime_provision_failed") return null;
  const reason = owtProvisionFailureReason(refusal);
  return reason
    ? provisionFailureText(reason)
    : refusal.message || MODEL_BINDING_ACTIVATION_ERROR_COPY.runtime_provision_failed;
}

/** The provision failure reason a recovery projection names among its free-text `reasons`, if any. */
export function provisionFailureReasonIn(reasons: readonly string[]): RuntimeProvisionFailureReason | null {
  for (const reason of reasons) {
    const parsed = RuntimeProvisionFailureReasonSchema.safeParse(reason);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** The sentence and code for a reason the recovery projection names (it carries no message). */
export function provisionFailureText(reason: RuntimeProvisionFailureReason): string {
  return withStableCode(RUNTIME_PROVISION_FAILURE_COPY[reason], reason);
}
