import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type {
  EgressApprovalDecision,
  EgressApprovalGrantScope,
  EgressPendingApproval,
} from "@different-ai/openwork-contracts/sandbox-manager-host-api";

import { t } from "../../i18n";
import { chatNamesByRef, type KnownChat } from "./chat-names";
import {
  afterDecision,
  decideEgressApproval,
  pollEgressApprovals,
  releasedWithSession,
  type EgressApprovalsClient,
} from "./egress-approvals";

export type UseEgressApprovalsDeps = {
  instanceApiClient: Accessor<EgressApprovalsClient | null>;
  /** The sessions the app lists, to name the chat an approval is for. */
  chats: Accessor<readonly KnownChat[]>;
};

/** What the approval dialog reads and calls: the adapter between it and the Sandbox Manager's approval routes. */
export type EgressApprovals = {
  approvals: Accessor<readonly EgressPendingApproval[]>;
  decidingId: Accessor<string | null>;
  /** A failed decision, with the approval it was for: it is shown only while that one is on screen. */
  decisionError: Accessor<{ approvalId: string; message: string } | null>;
  /** Said when an approval ended after an answer that may not have reached it. */
  notice: Accessor<string | null>;
  dismissNotice: () => void;
  decide: (approvalId: string, decision: EgressApprovalDecision, grantScope?: EgressApprovalGrantScope) => Promise<void>;
  /** The title of the known chat whose `session_ref` this is, or null when none matches. */
  chatName: (sessionRef: string) => string | null;
};

/** The egress approvals waiting on the user, watched for as long as ServiceHub is connected. */
export function useEgressApprovals(deps: UseEgressApprovalsDeps): EgressApprovals {
  const [listed, setListed] = createSignal<EgressPendingApproval[]>([]);
  // A list already in flight when a decision lands can still carry the approval it settled.
  const [answered, setAnswered] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [decidingId, setDecidingId] = createSignal<string | null>(null);
  // The error belongs to the approval it was for: a later approval does not inherit it.
  const [decisionError, setDecisionError] = createSignal<{ approvalId: string; message: string } | null>(null);
  const [uncertain, setUncertain] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [notice, setNotice] = createSignal<string | null>(null);
  const [chatNames, setChatNames] = createSignal<ReadonlyMap<string, string>>(new Map());
  // Advanced by each accepted allow-all. A list asked for before one can carry a prompt that grant released
  // and that was not listed yet, so it is dropped; the next list says what is still waiting.
  let allowAlls = 0;

  createEffect(
    on(deps.instanceApiClient, (client) => {
      setListed([]);
      setAnswered(new Set<string>());
      setDecisionError(null);
      setUncertain(new Set<string>());
      setNotice(null);
      if (!client) return;
      const stop = new AbortController();
      // The poller asks for one list at a time and hands each on as soon as it answers.
      let askedAfter = allowAlls;
      void pollEgressApprovals(
        {
          listPendingApprovals: (options) => {
            askedAfter = allowAlls;
            return client.listPendingApprovals(options);
          },
        },
        {
          signal: stop.signal,
          onList: (approvals) => {
            if (askedAfter === allowAlls) setListed(approvals);
          },
        },
      );
      onCleanup(() => stop.abort());
    }),
  );

  const approvals = createMemo(() =>
    listed().filter((approval) => !answered().has(approval.approval_id)),
  );

  // Hashing waits until an approval names a chat, and a slower answer for an older list is dropped.
  const namesAChat = createMemo(() => approvals().some((approval) => approval.session_ref !== undefined));
  createEffect(() => {
    if (!namesAChat()) return;
    let current = true;
    void chatNamesByRef(deps.chats())
      .then((names) => {
        if (current) setChatNames(names);
      })
      .catch(() => {
        // Names that could not be worked out leave the ones already shown.
      });
    onCleanup(() => {
      current = false;
    });
  });

  async function decide(
    approvalId: string,
    decision: EgressApprovalDecision,
    grantScope?: EgressApprovalGrantScope,
  ): Promise<void> {
    const client = deps.instanceApiClient();
    if (!client || decidingId() !== null) return;
    setDecidingId(approvalId);
    setDecisionError(null);
    // Read from the list the user answered: one listed while the decision is in flight can hold a request of
    // the same session that the grant did not release (a replaced Connector keeps it pending).
    const shown = listed().find((approval) => approval.approval_id === approvalId);
    const siblings = shown ? releasedWithSession(listed(), shown) : new Set<string>();
    const outcome = await decideEgressApproval(client, approvalId, decision, grantScope);
    setDecidingId(null);
    const after = afterDecision(uncertain(), approvalId, outcome);
    setUncertain(after.uncertain);
    if (after.endedAfterFailedAnswer) setNotice(t("egress_approval.maybe_lost"));
    if (!outcome.settled) {
      setDecisionError({ approvalId, message: outcome.message });
      return;
    }
    // The Connector released the session's other prompts with this grant, so no list shows them again,
    // not even one already in flight.
    const allowedAll = outcome.taken && decision === "approve" && grantScope === "all_for_chat";
    if (allowedAll) allowAlls += 1;
    setAnswered((ids) => new Set([...ids, approvalId, ...(allowedAll ? siblings : [])]));
  }

  return {
    approvals,
    decidingId,
    decisionError,
    notice,
    dismissNotice: () => setNotice(null),
    decide,
    chatName: (sessionRef: string) => chatNames().get(sessionRef) ?? null,
  };
}
