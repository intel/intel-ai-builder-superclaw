import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type {
  HostMcpApprovalDecision,
  HostMcpGrantScope,
  HostMcpPendingApproval,
  HostMcpServer,
  HostMcpStatus,
} from "@different-ai/openwork-contracts/host-mcp-api";

import { uiLogWarn } from "~/shared/platform/log/log";
import { HostMcpApiError, type HostMcpApiClient } from "~/shared/platform/transport/host-mcp-api";
import { t } from "../../i18n";
import {
  HOST_APPROVAL_NOTICES,
  HOST_MCP_POLL,
  HOST_STANDING_GRANTS,
  decideHostMcpApproval,
  gatewayIsDown,
  hostBarCalls,
  hostStatusIntervalMs,
  hostWorkRunning,
  howApprovalEnded,
  pollHostMcpApprovals,
  sleepUnlessAborted,
  type HostApprovalNotice,
  type HostBarCall,
  type HostMcpApprovalsClient,
} from "./host-mcp";
import { sendHostNotification, type SendNotification } from "./host-mcp-notify";

/** What the approval dialog and the notices read and call. */
export type HostMcpApprovals = {
  approvals: Accessor<readonly HostMcpPendingApproval[]>;
  decidingId: Accessor<string | null>;
  /** A failed decision, with the approval it was for: it is shown only while that one is on screen. */
  decisionError: Accessor<{ approvalId: string; message: string } | null>;
  decide: (approvalId: string, decision: HostMcpApprovalDecision, grantScope?: HostMcpGrantScope) => Promise<void>;
  /** Approvals that ended without the user's answer, newest first. */
  notices: Accessor<readonly HostApprovalNotice[]>;
  dismissNotice: (approvalId: string) => void;
  /**
   * The user's Stop all denies every approval waiting. `starting`: whatever ends while it runs gets no
   * notice, and the dialog stays; `done`: the approvals listed are dropped now, with no notice;
   * `failed`: notices are back as before.
   */
  endedByStopAll: (phase?: "starting" | "done" | "failed") => void;
  /** The tools of `server` already allowed `always`, or null while unknown (never read, or unreadable). */
  alwaysGranted: (server: string) => readonly string[] | null;
  /** The gateway's server list as last read, or null while unknown. */
  servers: Accessor<readonly HostMcpServer[] | null>;
  /** Reads the server list again now, whatever the cache says. */
  refreshServers: () => void;
};

/** The host approvals waiting on the user, long-polled for as long as `client` is not null. */
export function useHostMcpApprovals(deps: {
  client: Accessor<HostMcpApprovalsClient | null>;
  /** Told whether each list reached the gateway, so status polling knows the gateway is up. */
  onReached?: (reached: boolean) => void;
  now?: () => number;
}): HostMcpApprovals {
  const now = deps.now ?? Date.now;
  const [listed, setListed] = createSignal<HostMcpPendingApproval[]>([]);
  // A list already in flight when a decision lands can still carry the approval it settled.
  const [answered, setAnswered] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [decidingId, setDecidingId] = createSignal<string | null>(null);
  const [decisionError, setDecisionError] = createSignal<{ approvalId: string; message: string } | null>(null);
  const [notices, setNotices] = createSignal<HostApprovalNotice[]>([]);
  // Approvals already told about, so the expiry tick and the list that then drops it say it once.
  const noticed = new Set<string>();
  // While the user's Stop all runs, an approval that leaves ended because of it, not unanswered.
  let stopInFlight = false;
  const noticeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function dismissNotice(approvalId: string): void {
    clearTimeout(noticeTimers.get(approvalId));
    noticeTimers.delete(approvalId);
    setNotices((current) => current.filter((notice) => notice.approval.approval_id !== approvalId));
  }

  /** Tells the user an approval ended unanswered: never one they answered, or one being answered now. */
  function endedUnanswered(approval: HostMcpPendingApproval, ended: HostApprovalNotice["ended"]): void {
    const id = approval.approval_id;
    if (stopInFlight || noticed.has(id) || answered().has(id) || decidingId() === id) return;
    noticed.add(id);
    const kept = [{ approval, ended }, ...notices()].slice(0, HOST_APPROVAL_NOTICES.keep);
    for (const [timedId, timer] of noticeTimers) {
      if (kept.some((notice) => notice.approval.approval_id === timedId)) continue;
      clearTimeout(timer);
      noticeTimers.delete(timedId);
    }
    setNotices(kept);
    noticeTimers.set(id, setTimeout(() => dismissNotice(id), HOST_APPROVAL_NOTICES.dismissAfterMs));
  }
  onCleanup(() => noticeTimers.forEach((timer) => clearTimeout(timer)));

  // The server list (names, states, `always_grants`), read when a tool approval appears or the running
  // count changes, and kept briefly; there is no loop of its own. A read that fails leaves nothing
  // known, so neither the dialog nor the bar names anything.
  const [servers, setServers] = createSignal<readonly HostMcpServer[] | null>(null);
  let serversReadAt = Number.NEGATIVE_INFINITY;
  let serversReading = false;
  let serversReread = false;
  // Advanced by each `always` decision: a read that began before one is not counted fresh.
  let serversGeneration = 0;
  async function readServers(client: HostMcpApprovalsClient, force = false): Promise<void> {
    if (!client.listServers) return;
    if (serversReading) {
      serversReread ||= force;
      return;
    }
    if (!force && now() - serversReadAt < HOST_STANDING_GRANTS.cacheMs) return;
    serversReading = true;
    const generation = serversGeneration;
    try {
      const list = await client.listServers();
      if (generation === serversGeneration) serversReadAt = now();
      setServers(list);
    } catch {
      setServers(null);
    } finally {
      serversReading = false;
      if (serversReread) {
        serversReread = false;
        void readServers(client, true);
      }
    }
  }

  // The dialog stops showing an approval at its `expires_at`; the gateway's list may drop it later.
  createEffect(() => {
    if (listed().length === 0) return;
    const timer = setInterval(() => {
      for (const approval of listed()) {
        if (Date.parse(approval.expires_at) <= now()) endedUnanswered(approval, "expired");
      }
    }, 1_000);
    onCleanup(() => clearInterval(timer));
  });

  createEffect(
    on(deps.client, (client) => {
      setListed([]);
      setAnswered(new Set<string>());
      setDecisionError(null);
      if (!client) return;
      const stop = new AbortController();
      void pollHostMcpApprovals(client, {
        signal: stop.signal,
        onList: (approvals) => {
          deps.onReached?.(true);
          const ids = new Set(approvals.map((approval) => approval.approval_id));
          const before = new Set(listed().map((approval) => approval.approval_id));
          for (const approval of listed()) {
            if (!ids.has(approval.approval_id)) endedUnanswered(approval, howApprovalEnded(approval, now()));
          }
          if (approvals.some((approval) => approval.kind === "tool_call" && !before.has(approval.approval_id))) {
            void readServers(client);
          }
          setListed(approvals);
          // Only ids still listed can come back, so these sets stay as small as the list.
          setAnswered((previous) => new Set([...previous].filter((id) => ids.has(id))));
          for (const id of noticed) if (!ids.has(id)) noticed.delete(id);
        },
        onError: (error) => {
          if (gatewayIsDown(error)) deps.onReached?.(false);
        },
      });
      onCleanup(() => stop.abort());
    }),
  );

  const approvals = createMemo(() => listed().filter((approval) => !answered().has(approval.approval_id)));

  async function decide(
    approvalId: string,
    decision: HostMcpApprovalDecision,
    grantScope?: HostMcpGrantScope,
  ): Promise<void> {
    const client = deps.client();
    if (!client || decidingId() !== null) return;
    setDecidingId(approvalId);
    setDecisionError(null);
    const outcome = await decideHostMcpApproval(client, approvalId, decision, grantScope);
    setDecidingId(null);
    if (!outcome.settled) {
      setDecisionError({ approvalId, message: outcome.message });
      return;
    }
    // A new `always` grant makes the cached list out of date for the next approval.
    // A new `always` grant: read the list again now, so an approval already queued names it.
    if (grantScope === "always") {
      serversGeneration += 1;
      serversReadAt = Number.NEGATIVE_INFINITY;
      void readServers(client, true);
    }
    setAnswered((ids) => new Set([...ids, approvalId]));
  }

  // Counted as answered, so neither the dialog nor a notice shows them, and the list that drops them
  // finds them answered.
  const endedByStopAll = (phase: "starting" | "done" | "failed" = "done") => {
    stopInFlight = phase === "starting";
    if (phase === "done") setAnswered((ids) => new Set([...ids, ...listed().map((approval) => approval.approval_id)]));
  };

  const alwaysGranted = (server: string) => servers()?.find((listed) => listed.name === server)?.always_grants ?? null;
  const refreshServers = () => {
    const client = deps.client();
    if (client) void readServers(client, true);
  };

  return {
    approvals, decidingId, decisionError, decide, notices, dismissNotice, endedByStopAll,
    alwaysGranted, servers, refreshServers,
  };
}

export type HostMcp = {
  /** The client while a host flag is on and this build registers the gateway; null otherwise. */
  available: Accessor<HostMcpApiClient | null>;
  /** True from the first time the gateway answered in this app start. */
  awake: Accessor<boolean>;
  approvals: HostMcpApprovals;
  /** The last status read, or null while the gateway is not known to be running. */
  status: Accessor<HostMcpStatus | null>;
  stopping: Accessor<boolean>;
  stopError: Accessor<string | null>;
  stopAll: () => Promise<void>;
  resuming: Accessor<boolean>;
  resumeError: Accessor<string | null>;
  resume: () => Promise<void>;
  /** The calls operating this computer now, without the ones the user just cancelled. */
  activeCalls: Accessor<readonly HostBarCall[]>;
  cancelling: Accessor<ReadonlySet<string>>;
  cancelError: Accessor<{ callId: string; message: string } | null>;
  cancelCall: (callId: string) => Promise<void>;
};

export type UseHostMcpDeps = {
  client: Accessor<HostMcpApiClient | null>;
  /** Either of the Profile's `mcp_host_execution` or `host_browser` flags. */
  enabled: Accessor<boolean>;
  notify?: SendNotification;
  /** Whether a SuperClaw window has focus, so no notification is needed. */
  hasFocus?: () => boolean;
  now?: () => number;
};

/**
 * The host MCP gateway as the app shell sees it. Nothing here runs unless a Profile flag is on and
 * ServiceHub's catalog lists the gateway; then one call starts it, approvals are long-polled, and its
 * status is read every few seconds only while it is known to be running, so a status read never
 * starts it.
 */
export function useHostMcp(deps: UseHostMcpDeps): HostMcp {
  const now = deps.now ?? Date.now;
  const [listedClient, setListedClient] = createSignal<HostMcpApiClient | null>(null);
  const [running, setRunning] = createSignal(false);
  const [status, setStatus] = createSignal<HostMcpStatus | null>(null);
  const [statusReadAt, setStatusReadAt] = createSignal(0);
  const [stopping, setStopping] = createSignal(false);
  const [stopError, setStopError] = createSignal<string | null>(null);
  const [resuming, setResuming] = createSignal(false);
  const [resumeError, setResumeError] = createSignal<string | null>(null);
  // Bumped to read status at once rather than at the next tick.
  const [statusReread, setStatusReread] = createSignal(0);
  let woken = false;

  createEffect(
    on([deps.client, deps.enabled], ([client, enabled]) => {
      setListedClient(null);
      if (!client || !enabled) return;
      const stop = new AbortController();
      void (async () => {
        for (let failures = 0; !stop.signal.aborted; failures += 1) {
          try {
            const listed = await client.hasService();
            if (!stop.signal.aborted && listed) setListedClient(client);
            return;
          } catch {
            const pauseMs = Math.min(HOST_MCP_POLL.firstRetryMs * 2 ** failures, HOST_MCP_POLL.maxRetryMs);
            await sleepUnlessAborted(pauseMs, stop.signal);
          }
        }
      })();
      onCleanup(() => stop.abort());
    }),
  );

  const available = createMemo(() => (deps.enabled() ? listedClient() : null));

  createEffect(
    on(available, (client) => {
      if (!client || woken) return;
      woken = true;
      void client
        .listServers({ cold: true })
        .then(() => setRunning(true))
        .catch((error: unknown) => {
          uiLogWarn("mcp.host", "The host MCP gateway did not answer its start-up call", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }),
  );

  const [awake, setAwake] = createSignal(false);
  createEffect(() => {
    if (running()) setAwake(true);
  });

  const approvals = useHostMcpApprovals({ client: available, onReached: setRunning });

  // The bar names a lone running server; the list is read again whenever the running count changes.
  createEffect(
    on(
      () => status()?.running_count ?? 0,
      (count, previous) => {
        if (count > 0 && count !== previous) approvals.refreshServers();
      },
    ),
  );

  // Advanced by every status read and by Stop all: a read answers only if nothing came after it, so a
  // read that started before Stop all cannot put back what Stop all ended.
  let statusSeq = 0;
  createEffect(() => {
    statusReread();
    const client = available();
    if (!client || !running()) {
      statusSeq += 1;
      setStatus(null);
      return;
    }
    // One read at a time; the next is scheduled after it, at the cadence its answer calls for.
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const seq = ++statusSeq;
      try {
        const next = await client.status();
        if (seq === statusSeq) {
          setStatusReadAt(now());
          setStatus(next);
        }
      } catch (error) {
        if (seq === statusSeq && gatewayIsDown(error)) setRunning(false);
      }
      if (!stopped) timer = setTimeout(() => void read(), hostStatusIntervalMs(status()));
    };
    void read();
    onCleanup(() => {
      stopped = true;
      statusSeq += 1;
      clearTimeout(timer);
    });
  });

  // Cancelled calls leave the bar at once; a list that no longer names one forgets it.
  const [cancelled, setCancelled] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [cancelling, setCancelling] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [cancelError, setCancelError] = createSignal<{ callId: string; message: string } | null>(null);
  createEffect(() => {
    const ids = new Set((status()?.active_calls ?? []).map((call) => call.call_id));
    setCancelled((previous) => {
      const kept = [...previous].filter((id) => ids.has(id));
      return kept.length === previous.size ? previous : new Set(kept);
    });
  });
  const activeCalls = createMemo(() =>
    hostBarCalls(status(), statusReadAt()).filter((call) => !cancelled().has(call.call_id)));

  async function cancelCall(callId: string): Promise<void> {
    const client = available();
    if (!client || cancelling().has(callId)) return;
    setCancelling((ids) => new Set([...ids, callId]));
    setCancelError(null);
    try {
      await client.cancelCall(callId);
      setCancelled((ids) => new Set([...ids, callId]));
    } catch (error) {
      // Already finished: there is nothing left to cancel, so it goes as if it had been.
      if (error instanceof HostMcpApiError && error.code === "host_mcp_call_not_found") {
        setCancelled((ids) => new Set([...ids, callId]));
      } else {
        setCancelError({ callId, message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      setCancelling((ids) => new Set([...ids].filter((id) => id !== callId)));
    }
  }

  // The first time a call waits for the user, a notification for a user who is not looking at
  // SuperClaw; once per call, whatever happens after.
  const notified = new Set<string>();
  const notify = deps.notify ?? sendHostNotification;
  const hasFocus = deps.hasFocus ?? (() => typeof document !== "undefined" && document.hasFocus());
  createEffect(() => {
    const calls = status()?.active_calls ?? [];
    const ids = new Set(calls.map((call) => call.call_id));
    for (const id of notified) if (!ids.has(id)) notified.delete(id);
    for (const call of calls) {
      if (call.state !== "waiting_for_user" || notified.has(call.call_id)) continue;
      notified.add(call.call_id);
      if (hasFocus()) continue;
      const seconds = String(Math.ceil((call.resume_in_ms ?? 0) / 1000));
      try {
        void notify(t("mcp.host.notify.title"), t("mcp.host.notify.body").replace("{n}", seconds)).catch(
          () => undefined,
        );
      } catch {
        // A notification that cannot be sent changes nothing: the bar says the same.
      }
    }
  });

  createEffect(() => {
    if (!hostWorkRunning(status())) setStopError(null);
    if (!status()?.paused) setResumeError(null);
  });

  async function stopAll(): Promise<void> {
    const client = available();
    if (!client || stopping()) return;
    setStopping(true);
    setStopError(null);
    approvals.endedByStopAll("starting");
    try {
      await client.stopAll();
      statusSeq += 1;
      approvals.endedByStopAll("done");
      if (status() === null) {
        // Nothing to update in place: the gateway answered, so read what it now says.
        setRunning(true);
        setStatusReread((count) => count + 1);
      } else {
        setStatus((previous) =>
          previous && { ...previous, running_count: 0, browser_active: false, paused: true, active_calls: [] });
      }
    } catch (error) {
      approvals.endedByStopAll("failed");
      setStopError(error instanceof Error ? error.message : String(error));
    } finally {
      setStopping(false);
    }
  }

  async function resume(): Promise<void> {
    const client = available();
    if (!client || resuming()) return;
    setResuming(true);
    setResumeError(null);
    try {
      await client.resume();
      statusSeq += 1;
      setStatus((previous) => previous && { ...previous, paused: false });
      setStatusReread((count) => count + 1);
    } catch (error) {
      setResumeError(error instanceof Error ? error.message : String(error));
    } finally {
      setResuming(false);
    }
  }

  return {
    available, awake, approvals, status, stopping, stopError, stopAll, resuming, resumeError, resume,
    activeCalls, cancelling, cancelError, cancelCall,
  };
}
