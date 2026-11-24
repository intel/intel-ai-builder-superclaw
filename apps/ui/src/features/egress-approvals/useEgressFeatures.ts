import type { Accessor } from "solid-js";

import type { KnownChat } from "./chat-names";
import type { EgressApprovalsClient } from "./egress-approvals";
import { useChatWebAccess, type ChatGrantClient, type ChatWebAccess } from "./useChatWebAccess";
import { useEgressApprovals, type EgressApprovals } from "./useEgressApprovals";

export type UseEgressFeaturesDeps = {
  instanceApiClient: Accessor<(EgressApprovalsClient & ChatGrantClient) | null>;
  /** The sessions the app lists: approvals name their chat from it, the switch finds its chat's root in it. */
  chats: Accessor<readonly KnownChat[]>;
  /** null is the new-chat screen. */
  selectedSessionId: Accessor<string | null>;
};

/**
 * The approval dialog's adapter and the composer's web pages switch, built together because an approval
 * answered "for this chat" turns that chat's switch on: the switch reads its chat again when the approvals change.
 */
export function useEgressFeatures(deps: UseEgressFeaturesDeps): {
  approvals: EgressApprovals;
  chatWebAccess: ChatWebAccess;
} {
  const approvals = useEgressApprovals({ instanceApiClient: deps.instanceApiClient, chats: deps.chats });
  const chatWebAccess = useChatWebAccess({
    instanceApiClient: deps.instanceApiClient,
    chats: deps.chats,
    selectedSessionId: deps.selectedSessionId,
    changed: approvals.approvals,
  });
  return { approvals, chatWebAccess };
}
