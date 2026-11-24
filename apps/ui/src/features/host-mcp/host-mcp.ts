/**
 * Watching for and answering host MCP approvals, and reading what runs on the host, kept free of
 * Solid so it can be tested without a renderer: `useHostMcp` wires it to the app.
 *
 * A held call is denied at its `expires_at`, so the loop asks again as soon as a held list comes back,
 * and spaces its asks out only after a failure.
 */
import {
  HOST_MCP_APPROVALS_MAX_WAIT_MS,
  type HostMcpActiveCall,
  type HostMcpApprovalDecision,
  type HostMcpGrantScope,
  type HostMcpPendingApproval,
  type HostMcpStatus,
} from "@different-ai/openwork-contracts/host-mcp-api";

import { HostMcpApiError, type HostMcpApiClient } from "~/shared/platform/transport/host-mcp-api";

/** `listServers` is optional: without it the dialog names no standing grants. */
export type HostMcpApprovalsClient = Pick<HostMcpApiClient, "listApprovals" | "decideApproval">
  & Partial<Pick<HostMcpApiClient, "listServers">>;

export const HOST_STANDING_GRANTS = {
  /** A server list read for an approval serves the next ones this long. */
  cacheMs: 10_000,
  /** Names shown before "and N more". */
  shown: 5,
} as const;

/**
 * The tools of the approval's server the user already allowed `always`, other than the one asked
 * about, cut to the first few: the dialog says the grant worked, and this is another tool.
 */
export function standingGrantsLine(
  grants: readonly string[] | null,
  tool: string,
): { names: string[]; more: number } | null {
  const others = (grants ?? []).filter((name) => name !== tool);
  if (others.length === 0) return null;
  return { names: others.slice(0, HOST_STANDING_GRANTS.shown), more: Math.max(0, others.length - HOST_STANDING_GRANTS.shown) };
}

/** The line's text with the gateway's own words put in as they are, never read as patterns. */
export function standingGrantsText(
  server: string,
  line: { names: string[]; more: number },
  templates: { line: string; more: string; separator: string },
): string {
  const listed = line.names.join(templates.separator);
  // Placeholders the app fills are filled before the gateway's words go in, so a tool named like one
  // stays as it is.
  const tools = line.more > 0
    ? templates.more.replace("{count}", String(line.more)).replace("{tools}", () => listed)
    : listed;
  return templates.line.replace("{server}", () => server).replace("{tools}", () => tools);
}

export const HOST_MCP_POLL = {
  /** The contract does not say whether a non-empty list is held, so never ask faster than this. */
  minIntervalMs: 1_000,
  firstRetryMs: 2_000,
  maxRetryMs: 30_000,
  /** Once ServiceHub says the gateway is not running, each list would only ask it to start again. */
  notRunningRetryMs: 60_000,
  statusIntervalMs: 3_000,
  activeCallIntervalMs: 1_000,
} as const;

/** ServiceHub's answers for a gateway that is not running: not started, failed to start, or gone. */
const NOT_RUNNING_CODES: ReadonlySet<string> = new Set([
  "service_absent",
  "service_start_failed",
  "service_unavailable",
]);

export function gatewayNotRunning(error: unknown): boolean {
  return error instanceof HostMcpApiError && NOT_RUNNING_CODES.has(error.code);
}

/** The gateway is not running, or ServiceHub cannot be reached to ask: nothing it started is known to run. */
export function gatewayIsDown(error: unknown): boolean {
  return gatewayNotRunning(error) || (error instanceof HostMcpApiError && error.code === "unreachable");
}

/** Codes meaning the approval can no longer be decided, so there is nothing left to show. */
const SETTLED_CODES: ReadonlySet<string> = new Set(["approval_not_pending", "approval_not_found"]);

export type PollHostMcpApprovalsOptions = {
  signal: AbortSignal;
  onList: (approvals: HostMcpPendingApproval[]) => void;
  onError?: (error: unknown) => void;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

/**
 * Hands every list on to `onList` until `signal` aborts; never rejects. After a list, the next ask
 * waits out what is left of the minimum interval; after a failure, the whole backoff, and the slow
 * cadence once ServiceHub says the gateway is not running.
 */
export async function pollHostMcpApprovals(
  client: Pick<HostMcpApprovalsClient, "listApprovals">,
  { signal, onList, onError, sleep = sleepUnlessAborted, now = Date.now }: PollHostMcpApprovalsOptions,
): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    const askedAt = now();
    try {
      const approvals = await client.listApprovals({ waitMs: HOST_MCP_APPROVALS_MAX_WAIT_MS, signal });
      if (signal.aborted) return;
      failures = 0;
      onList(approvals);
    } catch (error) {
      if (signal.aborted) return;
      failures += 1;
      onError?.(error);
      await sleep(
        gatewayNotRunning(error)
          ? HOST_MCP_POLL.notRunningRetryMs
          : Math.min(HOST_MCP_POLL.firstRetryMs * 2 ** (failures - 1), HOST_MCP_POLL.maxRetryMs),
        signal,
      );
      continue;
    }
    await sleep(Math.max(0, HOST_MCP_POLL.minIntervalMs - (now() - askedAt)), signal);
  }
}

/** `settled` means the approval is no longer waiting, whoever decided it. */
export type HostMcpDecisionOutcome = { settled: true } | { settled: false; message: string };

export async function decideHostMcpApproval(
  client: Pick<HostMcpApprovalsClient, "decideApproval">,
  approvalId: string,
  decision: HostMcpApprovalDecision,
  grantScope?: HostMcpGrantScope,
): Promise<HostMcpDecisionOutcome> {
  try {
    await client.decideApproval(approvalId, decision, grantScope);
    return { settled: true };
  } catch (error) {
    if (error instanceof HostMcpApiError && SETTLED_CODES.has(error.code)) return { settled: true };
    return { settled: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** The approvals that can still be answered at `nowMs`, in the order they were listed. */
export function liveHostApprovals(
  approvals: readonly HostMcpPendingApproval[],
  nowMs: number,
): HostMcpPendingApproval[] {
  return approvals.filter((approval) => Date.parse(approval.expires_at) > nowMs);
}

export function secondsLeft(approval: HostMcpPendingApproval, nowMs: number): number {
  return Math.max(0, Math.ceil((Date.parse(approval.expires_at) - nowMs) / 1000));
}

/** Under a minute, `secondsTemplate` with `{seconds}` filled in; from a minute up, `m:ss`. */
export function formatTimeLeft(seconds: number, secondsTemplate: string): string {
  if (seconds < 60) return secondsTemplate.replace("{seconds}", String(seconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export const HOST_APPROVAL_NOTICES = {
  /** Only the latest few stay on screen. */
  keep: 3,
  dismissAfterMs: 60_000,
  /** The gateway's clock and this one can differ a little; this close to expiry it expired. */
  expirySkewMs: 2_000,
} as const;

/** An approval that left the gateway's list without the user answering it, and how it ended. */
export type HostApprovalNotice = {
  approval: HostMcpPendingApproval;
  ended: "expired" | "cancelled";
};

/** Past its expiry, give or take the clocks' skew, it expired; before that, the runtime cancelled it. */
export function howApprovalEnded(approval: HostMcpPendingApproval, nowMs: number): HostApprovalNotice["ended"] {
  return Date.parse(approval.expires_at) - nowMs <= HOST_APPROVAL_NOTICES.expirySkewMs ? "expired" : "cancelled";
}

export function hostApprovalNoticeKey(notice: HostApprovalNotice): string {
  const subject = notice.approval.kind === "tool_call" ? "tool" : "origin";
  return `mcp.host.notice.${notice.ended}_${subject}`;
}

/** The notice's template with the gateway's own words put in as they are, never read as patterns. */
export function hostApprovalNoticeText(notice: HostApprovalNotice, template: string): string {
  const { approval } = notice;
  if (approval.kind === "browser_origin") return template.replace("{origin}", () => approval.origin);
  return template.replace("{server}", () => approval.server).replace("{tool}", () => approval.tool);
}

export type HostApprovalChoice = {
  testId: string;
  labelKey: string;
  decision: HostMcpApprovalDecision;
  grantScope?: HostMcpGrantScope;
};

// Each choice is one object for good: the dialog keys its buttons by them, so a re-listed approval keeps
// its buttons, and the focus on one.
const DENY: HostApprovalChoice = {
  testId: "host-mcp-approval-deny-btn",
  labelKey: "mcp.host.approval.deny",
  decision: "deny",
};
const ALLOWS: readonly (HostApprovalChoice & { grantScope: HostMcpGrantScope })[] = [
  {
    testId: "host-mcp-approval-allow-once-btn",
    labelKey: "mcp.host.approval.allow_once",
    decision: "approve",
    grantScope: "once",
  },
  {
    testId: "host-mcp-approval-allow-until-restart-btn",
    labelKey: "mcp.host.approval.allow_until_restart",
    decision: "approve",
    grantScope: "until_restart",
  },
  {
    testId: "host-mcp-approval-always-allow-btn",
    labelKey: "mcp.host.approval.always_allow",
    decision: "approve",
    grantScope: "always",
  },
];

/** Deny, and one Allow per scope the gateway offered. A browser origin is never offered Always allow. */
export function hostApprovalChoices(approval: HostMcpPendingApproval): HostApprovalChoice[] {
  const offered = new Set<HostMcpGrantScope>(approval.grant_scopes);
  if (approval.kind === "browser_origin") offered.delete("always");
  return [DENY, ...ALLOWS.filter((choice) => offered.has(choice.grantScope))];
}

/** Whether anything runs on the host. */
export function hostWorkRunning(status?: HostMcpStatus | null): boolean {
  return status != null && (status.running_count > 0 || status.browser_active);
}

/**
 * What the banner shows: `paused` after Stop all until the user resumes, with Resume; `running` while
 * anything runs, with Stop all; nothing otherwise.
 */
export function hostBannerState(status?: HostMcpStatus | null): "paused" | "running" | null {
  if (status == null) return null;
  if (status.paused) return "paused";
  return hostWorkRunning(status) ? "running" : null;
}

/** A call the bar shows, with when it continues on this clock (`resume_in_ms` read at `readAt`). */
export type HostBarCall = HostMcpActiveCall & { resumeAt: number | null };

/** The calls operating this computer now: running, or waiting for the user. Approvals stay in the dialog. */
export function hostBarCalls(status: HostMcpStatus | null, readAt: number): HostBarCall[] {
  return (status?.active_calls ?? [])
    .filter((call) => call.state === "running" || call.state === "waiting_for_user")
    .map((call) => ({ ...call, resumeAt: call.resume_in_ms === null ? null : readAt + call.resume_in_ms }));
}

/** Status is read every second while a call runs or waits for the user, so the bar keeps up. */
export function hostStatusIntervalMs(status: HostMcpStatus | null): number {
  return hostBarCalls(status, 0).length > 0 ? HOST_MCP_POLL.activeCallIntervalMs : HOST_MCP_POLL.statusIntervalMs;
}

/** Whole seconds until a waiting call continues, counted down on this clock between status reads. */
export function resumeSecondsLeft(call: HostBarCall, nowMs: number): number {
  return call.resumeAt === null ? 0 : Math.max(0, Math.ceil((call.resumeAt - nowMs) / 1000));
}

/** The bar's line for a call. App-filled placeholders go in first, the gateway's words last, as they are. */
export function hostCallText(call: HostBarCall, seconds: number, text: (key: string) => string): string {
  const fill = (template: string) =>
    template
      .replace("{n}", String(seconds))
      .replace("{server}", () => call.server)
      .replace("{tool}", () => call.tool);
  if (call.state === "waiting_for_user") return fill(text("mcp.host.call.waiting"));
  const running = fill(text("mcp.host.call.running"));
  return call.computer_use ? `${running} ${text("mcp.host.call.computer_use")}` : running;
}

/**
 * The running bar's sentence. `running_count` counts MCP servers: one is named when exactly one known
 * server is `running`, otherwise they are counted. The gateway's name goes in as it is.
 */
export function hostRunningText(
  status: HostMcpStatus,
  runningNames: readonly string[] | null,
  text: (key: string) => string,
): string {
  const count = status.running_count;
  if (count === 0) return status.browser_active ? text("mcp.host.banner.browser_only") : "";
  const name = count === 1 && runningNames?.length === 1 ? runningNames[0] : undefined;
  const servers = name !== undefined
    ? text("mcp.host.banner.server_named").replace("{name}", () => name)
    : count === 1
      ? text("mcp.host.banner.servers_one")
      : text("mcp.host.banner.servers_many").replace("{count}", String(count));
  return status.browser_active ? servers + text("mcp.host.banner.browser_suffix") : servers;
}

export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
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
