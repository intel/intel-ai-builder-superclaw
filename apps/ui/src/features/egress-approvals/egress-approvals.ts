/**
 * Watching for and answering egress approvals (EG1-7, #16), kept free of Solid so it can be tested
 * without a renderer: `useEgressApprovals` wires it to the app.
 *
 * A request waits at most 90 s for its answer (design section 6.2), so the loop asks again as soon
 * as a held list comes back, and spaces its asks out only where waiting would not lose an answer.
 */
import {
  EGRESS_APPROVALS_MAX_WAIT_MS,
  type EgressApprovalDecision,
  type EgressApprovalGrantScope,
  type EgressPendingApproval,
} from "@different-ai/openwork-contracts/sandbox-manager-host-api";

import type { InstanceApiClient } from "~/shared/platform/transport/instance-api";
import { ServiceHubHttpError } from "~/shared/platform/transport/servicehub";

export type EgressApprovalsClient = Pick<InstanceApiClient, "listPendingApprovals" | "decideApproval">;

export const EGRESS_APPROVALS_POLL = {
  /** The contract does not say whether a non-empty list is held, so never ask faster than this. */
  minIntervalMs: 1_000,
  /** A backend may attach its approval broker after it starts, so a 501 is asked again. */
  unavailableRecheckMs: 30_000,
  firstRetryMs: 2_000,
  maxRetryMs: 30_000,
} as const;

/** Codes meaning the approval can no longer be decided, so there is nothing left to show.
 * Not `egress_approvals_unavailable`: a decision whose audit line could not be written gets
 * it while the approval is still pending, and hiding it would let the fetch expire. */
const SETTLED_CODES: ReadonlySet<string> = new Set(["approval_not_pending", "approval_not_found"]);

export type PollEgressApprovalsOptions = {
  signal: AbortSignal;
  onList: (approvals: EgressPendingApproval[]) => void;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

/** Hands every list on to `onList` until `signal` aborts; never rejects. */
export async function pollEgressApprovals(
  client: Pick<EgressApprovalsClient, "listPendingApprovals">,
  { signal, onList, sleep = sleepUnlessAborted, now = Date.now }: PollEgressApprovalsOptions,
): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    const askedAt = now();
    let pauseMs: number;
    try {
      const listed = await client.listPendingApprovals({
        waitMs: EGRESS_APPROVALS_MAX_WAIT_MS,
        signal,
      });
      if (signal.aborted) return;
      failures = 0;
      onList(listed.available ? listed.approvals : []);
      pauseMs = listed.available
        ? EGRESS_APPROVALS_POLL.minIntervalMs
        : EGRESS_APPROVALS_POLL.unavailableRecheckMs;
    } catch {
      if (signal.aborted) return;
      failures += 1;
      pauseMs = Math.min(
        EGRESS_APPROVALS_POLL.firstRetryMs * 2 ** (failures - 1),
        EGRESS_APPROVALS_POLL.maxRetryMs,
      );
    }
    await sleep(Math.max(0, pauseMs - (now() - askedAt)), signal);
  }
}

/** `settled` means the approval is no longer waiting, whoever decided it; `taken`, that this decision ended it. */
export type EgressApprovalDecisionOutcome =
  | { settled: true; taken: boolean }
  | { settled: false; message: string };

export async function decideEgressApproval(
  client: Pick<EgressApprovalsClient, "decideApproval">,
  approvalId: string,
  decision: EgressApprovalDecision,
  grantScope?: EgressApprovalGrantScope,
): Promise<EgressApprovalDecisionOutcome> {
  try {
    // A decision without a scope is sent as it always was.
    if (grantScope === undefined) await client.decideApproval(approvalId, decision);
    else await client.decideApproval(approvalId, decision, grantScope);
    return { settled: true, taken: true };
  } catch (error) {
    if (error instanceof ServiceHubHttpError && error.code && SETTLED_CODES.has(error.code)) {
      return { settled: true, taken: false };
    }
    return { settled: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Tracks answers that may not have reached the Sandbox Manager. If an approval then turns out to
 * have ended, the user is told their earlier answer may not have landed, instead of the dialog
 * just vanishing.
 */
export function afterDecision(
  uncertain: ReadonlySet<string>,
  approvalId: string,
  outcome: EgressApprovalDecisionOutcome,
): { uncertain: ReadonlySet<string>; endedAfterFailedAnswer: boolean } {
  const next = new Set(uncertain);
  if (!outcome.settled) {
    next.add(approvalId);
    return { uncertain: next, endedAfterFailedAnswer: false };
  }
  // Only an approval that ended on its own leaves the earlier answer in doubt; one this answer ended does not.
  const hadFailedAnswer = next.delete(approvalId);
  return { uncertain: next, endedAfterFailedAnswer: hadFailedAnswer && !outcome.taken };
}

/**
 * The other approvals of `decided`'s session that offered "all for this session": once that was granted,
 * their verifier released them with it. Another verifier's are not released. Nothing for an approval that
 * names no session.
 */
export function releasedWithSession(
  listed: readonly EgressPendingApproval[],
  decided: EgressPendingApproval,
): ReadonlySet<string> {
  if (decided.session_ref === undefined) return new Set();
  return new Set(
    listed
      .filter(
        (approval) =>
          approval.approval_id !== decided.approval_id &&
          approval.audience === decided.audience &&
          approval.session_ref === decided.session_ref &&
          approval.grant_scopes?.includes("all_for_chat"),
      )
      .map((approval) => approval.approval_id),
  );
}

/** The approvals that can still be answered at `nowMs`, in the order they were listed. */
export function liveApprovals(
  approvals: readonly EgressPendingApproval[],
  nowMs: number,
): EgressPendingApproval[] {
  return approvals.filter((approval) => Date.parse(approval.expires_at) > nowMs);
}

export function secondsLeft(approval: EgressPendingApproval, nowMs: number): number {
  return Math.max(0, Math.ceil((Date.parse(approval.expires_at) - nowMs) / 1000));
}

export type ApprovalChoice = {
  testId: string;
  labelKey: string;
  decision: EgressApprovalDecision;
  /** Sent with an approval only; absent for an approval that lists no `grant_scopes`. */
  grantScope?: EgressApprovalGrantScope;
};

// Each choice is one object for good: the dialog keys its buttons by them, so a re-listed approval keeps
// its buttons, and the focus on one.
const DENY: ApprovalChoice = { testId: "egress-approval-deny-btn", labelKey: "egress_approval.deny", decision: "deny" };
const ALLOW: ApprovalChoice = { testId: "egress-approval-allow-btn", labelKey: "egress_approval.allow", decision: "approve" };

const SCOPED_ALLOWS: readonly (ApprovalChoice & { grantScope: EgressApprovalGrantScope })[] = [
  { testId: "egress-approval-allow-once-btn", labelKey: "egress_approval.allow_once", decision: "approve", grantScope: "once" },
  {
    testId: "egress-approval-allow-all-btn",
    labelKey: "egress_approval.allow_all_for_chat",
    decision: "approve",
    grantScope: "all_for_chat",
  },
];

/** The approval of a destination the egress proxy's allowlist does not list (EG2-4b). */
export const PROXY_UNLISTED_ACTION = "proxy.connect_unlisted";

// The proxy's allow-all is not the Connector's: it covers commands from every session until SuperClaw restarts.
const PROXY_ALLOWS: readonly (ApprovalChoice & { grantScope: EgressApprovalGrantScope })[] = SCOPED_ALLOWS.map(
  (choice) =>
    choice.grantScope === "all_for_chat" ? { ...choice, labelKey: "egress_approval.proxy.allow_all_for_chat" } : choice,
);

/**
 * The answers the user is offered. An approval that lists no `grant_scopes` has Deny and Allow, as it
 * always had. One that lists them has Deny and one Allow per listed scope: a request whose chat its
 * verifier could not tell is offered Allow once alone. A scope the approval did not list is never a button.
 */
export function approvalChoices(approval: EgressPendingApproval): ApprovalChoice[] {
  if (approval.grant_scopes === undefined) return [DENY, ALLOW];
  const offered = new Set<EgressApprovalGrantScope>(approval.grant_scopes);
  const allows = approval.action === PROXY_UNLISTED_ACTION ? PROXY_ALLOWS : SCOPED_ALLOWS;
  return [DENY, ...allows.filter((choice) => offered.has(choice.grantScope))];
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
