// Sends the scoped token may not make without an operator (EG2-7, design 6.3). The router holds the
// send, lists it on its admin endpoint, and sends only when the Sandbox Manager's grant for exactly
// this conversation arrives. Nothing here is the message: a held request is a channel and a
// conversation id, and the text is kept by the caller until the hold settles.

import { randomBytes } from "node:crypto";
import {
  EGRESS_APPROVAL_GRANT_RULES,
  decodeEgressApprovalGrantToken,
} from "@different-ai/openwork-contracts/egress-approval-grant";
import {
  ROUTER_SCOPED_ERRORS,
  RouterApprovalGrantSchema,
  routerSendRequestDigest,
  type RouterApprovalConfig,
  type RouterScopedErrorCode,
} from "@different-ai/openwork-contracts/router-approval";

export type PendingSendApproval = {
  approval_id: string;
  audience: "router";
  action: "router.send_new_target";
  caller: "agent";
  target: string;
  request_digest: string;
  requested_at_ms: number;
  expires_at_ms: number;
};

/** A scoped call refused with one of the contract's fixed sentences. */
export class ScopedSendError extends Error {
  readonly status: number;
  constructor(readonly code: RouterScopedErrorCode) {
    super(ROUTER_SCOPED_ERRORS[code].message);
    this.status = ROUTER_SCOPED_ERRORS[code].status;
  }
}

export class GrantRejected extends Error {
  constructor(readonly reason: string) {
    super("grant_rejected");
  }
}

type Outcome = "granted" | RouterScopedErrorCode;

type Held = {
  entry: PendingSendApproval;
  settle: (outcome: Outcome) => void;
};

export type SendApprovalEvent = {
  event: "approval_requested" | "approval_granted" | "approval_denied" | "approval_expired" | "grant_refused";
  approvalId?: string;
  reason?: string;
};

export type SendApprovalHoldOptions = {
  /** The approval section of the router's config, or null when the host sealed none. */
  config: RouterApprovalConfig | null;
  now?: () => number;
  onEvent?: (event: SendApprovalEvent) => void;
};

export class SendApprovalHold {
  private readonly held = new Map<string, Held>();
  private readonly usedGrants = new Map<string, number>();
  private waiters: Array<() => void> = [];
  private readonly now: () => number;

  constructor(private readonly options: SendApprovalHoldOptions) {
    this.now = options.now ?? Date.now;
  }

  get available(): boolean {
    return this.options.config !== null;
  }

  /** Resolves when the operator grants this conversation; rejects with a `ScopedSendError` otherwise. */
  async hold(channel: string, conversationId: string): Promise<{ approvalId: string }> {
    if (!this.options.config) throw new ScopedSendError("approval_unavailable");
    if (this.held.size >= EGRESS_APPROVAL_GRANT_RULES.admin_max_pending) throw new ScopedSendError("approval_queue_full");
    const requestedAt = this.now();
    const entry: PendingSendApproval = {
      approval_id: `approval-${randomBytes(12).toString("base64url")}`,
      audience: "router",
      action: "router.send_new_target",
      caller: "agent",
      target: `${channel}:${conversationId}`,
      request_digest: routerSendRequestDigest(channel, conversationId),
      requested_at_ms: requestedAt,
      expires_at_ms: requestedAt + EGRESS_APPROVAL_GRANT_RULES.max_lifetime_ms,
    };
    const outcome = await new Promise<Outcome>((resolve) => {
      const timer = setTimeout(
        () => this.settle(entry.approval_id, "approval_expired"),
        entry.expires_at_ms - requestedAt,
      );
      timer.unref?.();
      this.held.set(entry.approval_id, {
        entry,
        settle: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      });
      this.options.onEvent?.({ event: "approval_requested", approvalId: entry.approval_id });
      this.wake();
    });
    if (outcome !== "granted") throw new ScopedSendError(outcome);
    return { approvalId: entry.approval_id };
  }

  /** The held requests, oldest first; waits up to `waitMs` for one when there is none. */
  async pending(waitMs: number): Promise<PendingSendApproval[]> {
    if (this.held.size === 0 && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        timer.unref?.();
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return [...this.held.values()].map((held) => held.entry).sort((a, b) => a.requested_at_ms - b.requested_at_ms);
  }

  /** Checks a grant in the contract's order; the grant is spent last, so nothing refused earlier uses it up. */
  grant(token: string): void {
    const config = this.options.config;
    if (!config) return this.refuse("no_config");
    const decoded = decodeEgressApprovalGrantToken(token, config.approval_public_key, RouterApprovalGrantSchema);
    if (!decoded.ok) return this.refuse(decoded.reason);
    const grant = decoded.grant;
    if (grant.boot_id !== config.boot_id) return this.refuse("boot_id");
    const now = this.now();
    if (!(grant.issued_at_ms <= now && now < grant.expires_at_ms)) return this.refuse("time_window");
    const held = this.held.get(grant.approval_id);
    if (!held) return this.refuse("approval_id");
    if (grant.request_digest !== held.entry.request_digest) return this.refuse("request_digest");
    this.forgetExpiredGrants(now);
    if (this.usedGrants.has(grant.grant_id)) return this.refuse("once_used");
    this.usedGrants.set(grant.grant_id, grant.expires_at_ms);
    this.options.onEvent?.({ event: "approval_granted", approvalId: grant.approval_id });
    this.settle(grant.approval_id, "granted");
  }

  /** An unsigned denial: it only removes authority. Returns false when nothing was pending under that id. */
  deny(approvalId: string): boolean {
    if (!this.held.has(approvalId)) return false;
    this.options.onEvent?.({ event: "approval_denied", approvalId });
    this.settle(approvalId, "approval_denied");
    return true;
  }

  private refuse(reason: string): never {
    this.options.onEvent?.({ event: "grant_refused", reason });
    throw new GrantRejected(reason);
  }

  private settle(approvalId: string, outcome: Outcome): void {
    const held = this.held.get(approvalId);
    if (!held) return;
    this.held.delete(approvalId);
    if (outcome === "approval_expired") this.options.onEvent?.({ event: "approval_expired", approvalId });
    held.settle(outcome);
    this.wake();
  }

  private forgetExpiredGrants(now: number): void {
    for (const [grantId, expires] of this.usedGrants) if (expires <= now) this.usedGrants.delete(grantId);
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }
}
