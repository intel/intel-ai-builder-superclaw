// The scoped token's send (EG2-7, design 6.5). A send the agent makes to the conversation it is
// answering, or to one the router has bound to this workspace, goes without approval and is audited.
// Any other explicit conversation is held until the operator approves it in the desktop app.
//
// Directory fan-out resolves only to bound conversations, so it needs no approval either. `autoBind`
// is refused before this is reached: a scoped sender never writes a binding.

import type { BridgeStore } from "./db.js";
import { parseChannel } from "./health-bindings.js";
import type { SendMessageInput, SendMessageResult } from "./health.js";
import type { SendApprovalHold } from "./send-approvals.js";
import { isTelegramPeerId } from "./telegram.js";

export type ScopedSendInput = SendMessageInput & {
  /** The OpenCode session the agent's tool call runs in (`context.sessionID`). */
  sessionId?: string;
};

export type ScopedSendAudit = {
  event: "router_scoped_send";
  channel: string;
  target: string;
  basis: "current_conversation" | "bound_conversation" | "bound_directory" | "approved";
  sessionId?: string;
  approvalId?: string;
};

export type ScopedSendDeps = {
  store: Pick<BridgeStore, "listBindings" | "findSessionById">;
  hold: SendApprovalHold;
  send: (input: SendMessageInput) => Promise<SendMessageResult>;
  normalizeDirectory: (input: string) => string;
  resolveScopedDirectory: (input: string) => { ok: true; directory: string } | { ok: false; error: string };
  workspaceRootNormalized: string;
  /** Receives one line per scoped send: the channel, a redacted target and why it needed no operator. */
  audit: (entry: ScopedSendAudit) => void;
};

/**
 * The conversation a peer belongs to. A Slack thread is `C123|1700000000.000100`, in channel `C123`: the
 * thread of a conversation the agent may reply to or the workspace has bound is part of that conversation, and
 * the scheduler's later notifications go to the thread its first one opened.
 */
export const conversationRoot = (channel: string, peerId: string): string =>
  channel === "slack" ? (peerId.split("|")[0] ?? peerId) : peerId;

/** `abcdef` becomes `ab…ef`: enough to tell two targets apart in a log, not enough to address one. */
export function redactTarget(value: string): string {
  const text = value.trim();
  if (text.length <= 6) return "hidden";
  return `${text.slice(0, 2)}…${text.slice(-2)}`;
}

export function createScopedSend(deps: ScopedSendDeps) {
  const sessionIdOf = (input: ScopedSendInput) => (input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {});

  const isCurrentConversation = (input: ScopedSendInput, channel: string, peerId: string): boolean => {
    const sessionId = input.sessionId?.trim();
    if (!sessionId) return false;
    const row = deps.store.findSessionById(sessionId);
    if (!row || row.channel !== channel) return false;
    if (conversationRoot(channel, row.peer_id) !== conversationRoot(channel, peerId)) return false;
    const identityId = input.identityId?.trim();
    return !identityId || row.identity_id === identityId;
  };

  const isBoundToWorkspace = (input: ScopedSendInput, channel: ReturnType<typeof parseChannel>, peerId: string): boolean => {
    const requested = input.directory?.trim() ? deps.resolveScopedDirectory(input.directory.trim()) : null;
    const allowed = new Set([deps.workspaceRootNormalized]);
    if (requested?.ok) allowed.add(deps.normalizeDirectory(requested.directory));
    const identityId = input.identityId?.trim();
    return deps
      .store.listBindings({ channel, ...(identityId ? { identityId } : {}) })
      .some(
        (binding) =>
          conversationRoot(channel, binding.peer_id) === conversationRoot(channel, peerId) &&
          allowed.has(deps.normalizeDirectory(binding.directory)),
      );
  };

  return async (input: ScopedSendInput): Promise<SendMessageResult> => {
    const channel = parseChannel(input.channel);
    const peerId = (input.peerId ?? "").trim();
    const { sessionId: _claimed, ...sendInput } = input;
    const base = { event: "router_scoped_send", channel, ...sessionIdOf(input) } as const;

    if (!peerId) {
      deps.audit({ ...base, target: redactTarget(input.directory ?? ""), basis: "bound_directory" });
      return deps.send(sendInput);
    }
    // A peer the send itself would refuse is not worth the operator's attention.
    if (channel === "telegram" && !isTelegramPeerId(peerId)) return deps.send(sendInput);

    if (isCurrentConversation(input, channel, peerId)) {
      deps.audit({ ...base, target: redactTarget(peerId), basis: "current_conversation" });
      return deps.send(sendInput);
    }
    if (isBoundToWorkspace(input, channel, peerId)) {
      deps.audit({ ...base, target: redactTarget(peerId), basis: "bound_conversation" });
      return deps.send(sendInput);
    }
    const { approvalId } = await deps.hold.hold(channel, peerId);
    deps.audit({ ...base, target: redactTarget(peerId), basis: "approved", approvalId });
    return deps.send(sendInput);
  };
}
