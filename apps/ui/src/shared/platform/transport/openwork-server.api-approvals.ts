/**
 * Pending-approval listing/response, plus the auto-approval wrapper
 * used when the user has explicitly triggered a write from the UI.
 */
import { requestJson } from "./openwork-server.transport";
import type { ApprovalItem } from "./openwork-server.types";
import type { OpenworkClientContext } from "./openwork-server.client-context";

/** First look is still quick; an idle poll backs off so a long write does not hammer /approvals. */
export const APPROVAL_POLL_BASE_MS = 300;
export const APPROVAL_POLL_MAX_MS = 4_000;

export function nextApprovalPollDelay(currentMs: number, sawItems: boolean): number {
  if (sawItems) return APPROVAL_POLL_BASE_MS;
  return Math.min(APPROVAL_POLL_MAX_MS, currentMs * 2);
}

export function createApprovalsApi(ctx: OpenworkClientContext) {
  const { baseUrl, token, hostToken } = ctx;
  return {
    // Approvals
    listApprovals: () =>
      requestJson<{ items: ApprovalItem[] }>(baseUrl, "/approvals", { token, hostToken }),
    respondApproval: (id: string, reply: "allow" | "deny") =>
      requestJson<{ ok: boolean; allowed: boolean }>(
        baseUrl,
        `/approvals/${encodeURIComponent(id)}`,
        { token, hostToken, method: "POST", body: { reply } },
      ),
    /**
     * Execute `fn` while polling for pending approval requests in the background
     * and auto-approving them. This bridges the gap when the server is in
     * "manual" approval mode but the user has explicitly triggered the action
     * from the UI, so an interactive approval prompt is unnecessary.
     */
    withAutoApproval: async <T>(
      fn: () => Promise<T>,
      options?: { shouldApprove?: (item: ApprovalItem) => boolean },
    ): Promise<T> => {
      let polling = true;
      // Property, not a let: a self-assigned canceller narrows the local to null.
      const waitGate: { cancel: (() => void) | null } = { cancel: null };
      const wait = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waitGate.cancel = null;
            resolve();
          }, ms);
          waitGate.cancel = () => {
            clearTimeout(timer);
            waitGate.cancel = null;
            resolve();
          };
        });
      console.log("[AutoApproval] Starting approval polling loop");
      const poll = async () => {
        let cycle = 0;
        let delayMs = APPROVAL_POLL_BASE_MS;
        while (polling) {
          cycle++;
          let sawItems = false;
          try {
            const res = await requestJson<{ items: ApprovalItem[] }>(baseUrl, "/approvals", {
              token,
              hostToken,
            });
            sawItems = res.items.length > 0;
            if (sawItems) {
              console.log(`[AutoApproval] Found ${res.items.length} pending approval(s) on cycle ${cycle}:`, res.items.map((i) => i.id));
            }
            for (const item of res.items) {
              // Only auto-approve operations this caller scopes to; approving
              // every pending item could allow another session's queued command.
              if (options?.shouldApprove && !options.shouldApprove(item)) {
                continue;
              }
              try {
                await requestJson(baseUrl, `/approvals/${encodeURIComponent(item.id)}`, {
                  token,
                  hostToken,
                  method: "POST",
                  body: { reply: "allow" },
                });
                // id only: action and summary can carry workspace content.
                console.log(`[AutoApproval] Approved: ${item.id}`);
              } catch (e) {
                console.warn(`[AutoApproval] Failed to approve ${item.id}:`, e);
              }
            }
          } catch (e) {
            console.warn(`[AutoApproval] Poll error on cycle ${cycle}:`, e);
          }
          delayMs = nextApprovalPollDelay(delayMs, sawItems);
          if (!polling) break;
          await wait(delayMs);
        }
        console.log(`[AutoApproval] Polling stopped after ${cycle} cycles`);
      };
      const pollPromise = poll();
      try {
        const result = await fn();
        console.log("[AutoApproval] Write operation completed successfully");
        return result;
      } catch (err) {
        console.error("[AutoApproval] Write operation failed:", err);
        throw err;
      } finally {
        polling = false;
        waitGate.cancel?.();
        await pollPromise;
      }
    },
  };
}
