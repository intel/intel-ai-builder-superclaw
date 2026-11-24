/** Startup-specific poll presentation for the public operation contract. */

import type { ModelBindingActivationOperation } from "@different-ai/openwork-contracts/capability";
import { ServiceHubHttpError } from "~/shared/platform/transport/servicehub";
import type { ActiveProfileBundleCheck } from "./model-binding-activation-client";

export type ActivationPollDecision =
  /** Terminal success — apply the bundle Routing Balance default and stop. */
  | "apply-routing-default"
  /** Terminal failure before handoff — show the error and stop. */
  | "surface-error"
  /** Terminal failure after handoff — log only (app is already usable) and stop. */
  | "log-error-only"
  /** Still running, pre-handoff — drive the stepper, then poll again. */
  | "advance-stepper"
  /** Still running, post-handoff — leave the UI alone, but KEEP polling. */
  | "keep-polling-silently";

export type ActiveProfileStartupDecision = ActiveProfileBundleCheck | "adopt-activation";

export function decideActiveProfileStartup(
  bundleCheck: ActiveProfileBundleCheck,
  activeOperation: ModelBindingActivationOperation | null,
): ActiveProfileStartupDecision {
  return activeOperation?.status === "applying" ? "adopt-activation" : bundleCheck;
}

/**
 * The failed operation a Retry resumes, or `null` when Retry has to start over. A refused provision
 * leaves a terminal receipt (its Runtime Deployment was revoked), which `resume` cannot reopen, so
 * its Retry starts a new activation, as a restart of SuperClaw does.
 */
export function resumableFailedOperationId(op: ModelBindingActivationOperation): string | null {
  return op.status === "failed" && op.retryable && op.error.code !== "runtime_provision_failed"
    ? op.operation_id
    : null;
}

/**
 * Whether a refused Retry-converge means there is no deployment left to re-arm. A refused provision
 * revokes the Runtime Deployment of the activation that owned it, so when the sandbox token poll saw
 * the refusal before that activation's own failure arrived, `converge` answers 409
 * `runtime_deployment_required` and only a new activation can help.
 */
export function convergeNeedsNewActivation(error: unknown): boolean {
  return error instanceof ServiceHubHttpError && error.status === 409 && error.code === "runtime_deployment_required";
}

/**
 * What this poll tick should do.
 *
 * Terminal status is checked before `owtStarted`. Phase C only decides whether
 * progress/errors remain visible; it never stops observation.
 */
export function decideActivationPoll(
  op: ModelBindingActivationOperation,
  owtStarted: boolean,
): ActivationPollDecision {
  if (op.status === "succeeded") return "apply-routing-default";
  if (op.status === "failed") return owtStarted ? "log-error-only" : "surface-error";
  return owtStarted ? "keep-polling-silently" : "advance-stepper";
}
