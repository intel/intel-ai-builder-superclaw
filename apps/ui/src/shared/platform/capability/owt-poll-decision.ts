/** Startup decisions for the data-plane token poll, one answer at a time. */

import { isOwtSandboxProvisioningCode } from "~/shared/platform/transport/servicehub";

/** The one poll state every "sandbox not up yet" answer shares. */
export const OWT_SANDBOX_PROVISIONING = "sandbox_provisioning";

/**
 * The state the token poll's timer is told about, or `null` to sample at the steady cadence.
 *
 * Every provisioning code, and the payload extraction before them, is one state: the 503 phase
 * answers with several, and a switch between them is not news (each request then makes Sandbox
 * Manager open the evidence file the Supervisor is about to replace). A stale token is sampled at
 * the steady cadence, because its recovery is counted in polls and each stale answer empties
 * Sandbox Manager's token cache.
 */
export function owtPollState(code: string): string | null {
  if (code === "owt_stale") return null;
  return code === "payload_preparing" || isOwtSandboxProvisioningCode(code) ? OWT_SANDBOX_PROVISIONING : code;
}

/** Consecutive stale answers after which startup asks ServiceHub to converge the Runtime. */
export const OWT_STALE_CONVERGE_POLLS = 3;

export type OwtConvergeState = { stalePolls: number; requested: boolean };

export const OWT_CONVERGE_INITIAL: OwtConvergeState = { stalePolls: 0, requested: false };

/** Whether this answer is the one that asks for a converge; at most once per wait. */
export function decideOwtConverge(
  state: OwtConvergeState,
  code: string,
): { next: OwtConvergeState; converge: boolean } {
  const stalePolls = code === "owt_stale" ? state.stalePolls + 1 : 0;
  const converge = !state.requested && stalePolls >= OWT_STALE_CONVERGE_POLLS;
  return { next: { stalePolls, requested: state.requested || converge }, converge };
}
