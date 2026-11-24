// The OpenCode event-stream subscriber: one subscription per workspace
// directory, translating session/message/permission events into status
// reporting and permission responses.
//
// This is the bridge's only inbound path that is not a user message, and the
// only place that answers permission prompts. It is extracted from startBridge
// so the event-to-status mapping and the permission-mode decisions can be
// exercised against a fake event stream.

import type { Logger } from "pino";

import type { ChannelName, Config, ModelRef } from "./config.js";
import { normalizeEvent } from "./events.js";
import { isChannelDeniedTool } from "./opencode.js";
import type { RunState } from "./run-state.js";
import { formatInputSummary, truncateText } from "./text.js";

// Slack's native status (assistant.threads.setStatus) renders a short single-line
// phrase. Cap tool status lines so an oversized/multi-line value can never be
// rejected by Slack with `invalid_arguments` - a rejection permanently demotes
// native status and makes every later update + the final answer post as separate messages.
const STATUS_LINE_LIMIT = 250;

const TOOL_LABELS: Record<string, string> = {
  bash: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  patch: "patch",
  multiedit: "edit",
  grep: "grep",
  glob: "glob",
  task: "agent",
  webfetch: "webfetch",
};

// sc_fetch_url's result when the Connector refused a page at once because a chat thread cannot approve
// reads (profiles/*/tools/sc_fetch_url.ts). The thread is told, once per host, why the page is missing.
const NO_APPROVER_MARKER = "NO_INTERACTIVE_APPROVER";
// A successful read carries page text, which may contain the marker; only the refusal line counts.
const REFUSAL_PREFIX = "ERROR: sc_fetch_url did not read the page - ";
const isNoApproverRefusal = (output: string): boolean =>
  output.startsWith(REFUSAL_PREFIX) && output.includes(`(${NO_APPROVER_MARKER})`);
const NOTICE_HOST_LIMIT = 60;
const NOTICED_LIMIT = 500;
const PARENT_LIMIT = 2000;
const MAX_PARENT_DEPTH = 8;

/** The full hostname of an http(s) URL; null when `url` is not one. */
const noticeHost = (url: unknown): string | null => {
  if (typeof url !== "string") return null;
  let hostname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    hostname = parsed.hostname;
  } catch {
    return null;
  }
  return hostname || null;
};

/** A hostname cut to a short plain label for the thread. */
const hostLabel = (hostname: string): string =>
  hostname.length > NOTICE_HOST_LIMIT ? `${hostname.slice(0, NOTICE_HOST_LIMIT - 1)}…` : hostname;

export const extractModelRef = (info: unknown): ModelRef | null => {
  if (!info || typeof info !== "object") return null;
  const record = info as { role?: unknown; model?: unknown };
  if (record.role !== "user") return null;
  if (!record.model || typeof record.model !== "object") return null;
  const model = record.model as { providerID?: unknown; modelID?: unknown };
  if (typeof model.providerID !== "string" || typeof model.modelID !== "string") return null;
  return { providerID: model.providerID, modelID: model.modelID };
};

/** The slice of an OpenCode client the event stream uses. */
export type EventStreamClient = {
  event: {
    subscribe: (
      query: undefined,
      options: { signal: AbortSignal },
    ) => Promise<{ stream: AsyncIterable<unknown> }>;
  };
  permission: {
    respond: (input: {
      sessionID: string;
      permissionID: string;
      response: "always" | "reject";
    }) => Promise<unknown>;
  };
};

/** The status reporters the event stream drives, as returned by createRunStatus. */
export type EventStreamStatus = {
  emitStatus: (run: RunState, statusText: string, options?: { throttle?: boolean }) => Promise<boolean>;
  reportThinking: (run: RunState) => void;
  reportDone: (run: RunState) => void;
  startTyping: (run: RunState) => void;
  stopTyping: (key: string) => void;
};

export type EventStreamDeps = {
  disableEventStream?: boolean;
  defaultDirectory: string;
  eventSubscriptions: Map<string, AbortController>;
  getClient: (directory: string) => EventStreamClient;
  status: EventStreamStatus;
  activeRuns: Map<string, RunState>;
  sessionModels: Map<string, ModelRef>;
  keyForSession: (directory: string, sessionID: string) => string;
  sendText: (
    channel: ChannelName,
    identityId: string,
    peerId: string,
    text: string,
    options: { kind: "system" | "tool" },
  ) => Promise<void>;
  routerManagedSessions: Set<string>;
  sessionPermissionModes: Map<string, Config["permissionMode"]>;
  logger: Logger;
  toolOutputLimit: number;
  permissionMode: Config["permissionMode"];
};

/**
 * Returns a function that subscribes to one directory's event stream, and is a
 * no-op for a directory already subscribed.
 */
export const createEventSubscriber = (deps: EventStreamDeps) => (directory: string): void => {
  if (deps.disableEventStream) return;
  const resolved = directory.trim() || deps.defaultDirectory;
  if (!resolved) return;
  if (deps.eventSubscriptions.has(resolved)) return;

  const abort = new AbortController();
  deps.eventSubscriptions.set(resolved, abort);
  const client = deps.getClient(resolved);
  const { status, activeRuns, logger } = deps;
  const runFor = (sessionID: string) => activeRuns.get(deps.keyForSession(resolved, sessionID));
  // Sub-agent sessions are children of the session a thread runs in; their tool calls belong to its run.
  const parents = new Map<string, string>();
  // A run stays keyed by the session it started in; after missing-session recovery its
  // sessionID points at the replacement, which is only found by scanning.
  const runByCurrentSession = (sessionID: string) => {
    for (const run of activeRuns.values()) {
      if (run.sessionID === sessionID && run.directory === resolved) return run;
    }
    return undefined;
  };
  const runForTree = (sessionID: string) => {
    let id: string | undefined = sessionID;
    for (let depth = 0; id !== undefined && depth < MAX_PARENT_DEPTH; depth += 1) {
      const run = runFor(id) ?? runByCurrentSession(id);
      if (run) return run;
      id = parents.get(id);
    }
    return undefined;
  };
  // "thread|host" pairs already told. Bounded: the oldest is forgotten first.
  const noticed = new Set<string>();

  const noticeSkippedFetch = async (part: Record<string, unknown>) => {
    if (part.tool !== "sc_fetch_url" || typeof part.sessionID !== "string") return;
    const state = part.state as { status?: string; input?: Record<string, unknown>; output?: unknown } | undefined;
    if (state?.status !== "completed" || typeof state.output !== "string") return;
    if (!isNoApproverRefusal(state.output)) return;
    const host = noticeHost(state.input?.url);
    const run = runForTree(part.sessionID);
    if (!host || !run) return;
    const key = `${run.key}|${run.peerId}|${host.toLowerCase()}`;
    if (noticed.has(key)) return;
    noticed.add(key);
    if (noticed.size > NOTICED_LIMIT) noticed.delete(noticed.values().next().value as string);
    try {
      await deps.sendText(
        run.channel,
        run.identityId,
        run.peerId,
        `Skipped ${hostLabel(host)}: reading pages outside the search results needs approval in the SuperClaw desktop app.`,
        { kind: "system" },
      );
    } catch (error) {
      // Forget the host so a later skip in this thread can retry the explanation.
      noticed.delete(key);
      logger.warn({ error, sessionID: run.sessionID }, "failed to post the skipped-fetch notice");
    }
  };

  const consumeEvents = async () => {
    const subscription = await client.event.subscribe(undefined, { signal: abort.signal });
    for await (const raw of subscription.stream) {
      const event = normalizeEvent(raw as Parameters<typeof normalizeEvent>[0]);
      if (!event) continue;
      const properties =
        event.properties && typeof event.properties === "object" ? (event.properties as Record<string, unknown>) : null;

      if (event.type === "message.updated" && properties) {
        const info = properties.info as Record<string, unknown> | undefined;
        const sessionID = typeof info?.sessionID === "string" ? info.sessionID : null;
        const model = extractModelRef(info);
        if (sessionID && model) {
          deps.sessionModels.set(deps.keyForSession(resolved, sessionID), model);
          const run = runFor(sessionID);
          if (run) status.reportThinking(run);
        }
      }

      if (event.type === "session.status" && properties) {
        const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null;
        const sessionStatus = properties.status as { type?: unknown } | undefined;
        if (sessionID && (sessionStatus?.type === "busy" || sessionStatus?.type === "retry")) {
          const run = runFor(sessionID);
          if (run) {
            status.reportThinking(run);
            status.startTyping(run);
            const statusText =
              sessionStatus.type === "retry" ? "🤔 Still working… retrying." : "🤔 Working on it…";
            await status.emitStatus(run, statusText, { throttle: true });
          }
        }
      }

      if (event.type === "session.idle" && properties) {
        const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null;
        if (sessionID) {
          status.stopTyping(deps.keyForSession(resolved, sessionID));
          const run = runFor(sessionID);
          if (run) status.reportDone(run);
        }
      }

      if (event.type === "session.created" || event.type === "session.updated") {
        const info = properties?.info as { id?: unknown; parentID?: unknown } | undefined;
        if (typeof info?.id === "string" && typeof info.parentID === "string") {
          parents.set(info.id, info.parentID);
          if (parents.size > PARENT_LIMIT) parents.delete(parents.keys().next().value as string);
        }
      }

      if (event.type === "message.part.updated") {
        const part = (event.properties as { part?: Record<string, unknown> } | undefined)?.part;
        if (!part || typeof part.sessionID !== "string") continue;
        await noticeSkippedFetch(part);
        const run = runFor(part.sessionID);
        if (!run) continue;
        // Slack always routes tool/sub-agent progress into the status line;
        // other channels stay gated by the global toolUpdatesEnabled setting.
        const toolStatusAllowed = run.channel === "slack" || run.toolUpdatesEnabled;
        if (!toolStatusAllowed) continue;
        if (part.type !== "tool") continue;
        // OpenCode's `invalid` sentinel = a malformed/hallucinated tool call: an
        // unactionable backend parse error (the UI ignores it too). Don't surface it.
        if (part.tool === "invalid") continue;

        const callId = typeof part.callID === "string" ? part.callID : undefined;
        if (!callId) continue;
        const tool = typeof part.tool === "string" ? part.tool : "";
        const state = part.state as
          | { status?: string; input?: Record<string, unknown>; output?: string; title?: string }
          | undefined;
        const toolStatus = state?.status ?? "unknown";
        if (run.seenToolStates.get(callId) === toolStatus) continue;
        run.seenToolStates.set(callId, toolStatus);

        const label = TOOL_LABELS[tool] ?? tool;
        const title = state?.title || truncateText(formatInputSummary(state?.input ?? {}), 120) || "running";
        let message = `[tool] ${label} ${toolStatus}: ${title}`;

        // The agent/task tool's output is the sub-agent's full result (often a
        // verbose <task_result> envelope) that the final answer already conveys;
        // don't append it to the status line.
        if (toolStatus === "completed" && state?.output && tool !== "task") {
          const output = truncateText(state.output.trim(), deps.toolOutputLimit);
          if (output) message += `\n${output}`;
        }

        // Collapse to a single line and cap length: the status drives Slack's native
        // shimmer, which expects a short single-line phrase. An oversized/multi-line
        // value is rejected → native status demoted → updates + final answer spam.
        const statusLine = truncateText(message.replace(/\s*\n+\s*/g, " ").trim(), STATUS_LINE_LIMIT);

        const updatedStatus = await status.emitStatus(run, statusLine, { throttle: true });
        // Slack tool progress may ONLY ride an active native shimmer or an editable
        // placeholder. If neither is available (native demoted mid-run and beginStatus
        // never created a placeholder), DROP the update rather than posting a standalone
        // [tool] message per event (the burst-spam bug). Telegram has no shimmer/placeholder
        // and intentionally shows tool progress as messages, so it keeps the fallback. (A)
        if (!updatedStatus && run.channel !== "slack") {
          await deps.sendText(run.channel, run.identityId, run.peerId, statusLine, { kind: "tool" });
        }
      }

      if (event.type === "permission.asked") {
        const permission = event.properties as { id?: string; sessionID?: string; permission?: string } | undefined;
        if (!permission?.id || !permission.sessionID) continue;
        // Only auto-approve permissions for sessions created by opencode-router.
        // Frontend sessions should show the permission dialog and wait for user interaction.
        if (!deps.routerManagedSessions.has(permission.sessionID)) {
          logger.debug(
            { sessionID: permission.sessionID, permissionID: permission.id },
            "skipping permission auto-approval for non-router session",
          );
          continue;
        }
        const permissionMode = deps.sessionPermissionModes.get(permission.sessionID) ?? deps.permissionMode;
        if (isChannelDeniedTool(permission.permission)) {
          // Network tools outside the Connector are never approved from a channel,
          // whatever the mode: an `ask` here must not become an `always`.
          logger.warn(
            { sessionID: permission.sessionID, permissionID: permission.id, permission: permission.permission },
            "rejecting web-tool permission request in channel session",
          );
          await client.permission.respond({
            sessionID: permission.sessionID,
            permissionID: permission.id,
            response: "reject",
          });
          continue;
        }
        if (permissionMode === "inherit") {
          // inherit lets the agent's own permission block govern: allow/deny
          // tools are resolved by OpenCode silently and never reach here. An
          // event here means the agent authored this tool as `ask` — but the
          // messaging channels have no approval UI, so fail closed rather than
          // bypassing the agent's approval requirement.
          logger.debug(
            { sessionID: permission.sessionID, permissionID: permission.id, permission: permission.permission },
            "rejecting ask-permission in inherit mode (no approval UI on messaging channel)",
          );
          await client.permission.respond({
            sessionID: permission.sessionID,
            permissionID: permission.id,
            response: "reject",
          });
          const run = runFor(permission.sessionID);
          if (run) {
            const toolName = permission.permission ? `\`${permission.permission}\`` : "A tool";
            await deps.sendText(
              run.channel,
              run.identityId,
              run.peerId,
              `${toolName} requires approval, which isn't available here, so the request was denied.`,
              { kind: "system" },
            );
          }
          continue;
        }
        const response = permissionMode === "deny" ? "reject" : "always";
        await client.permission.respond({
          sessionID: permission.sessionID,
          permissionID: permission.id,
          response,
        });
        if (response === "reject") {
          const run = runFor(permission.sessionID);
          if (run) {
            await deps.sendText(
              run.channel,
              run.identityId,
              run.peerId,
              "Permission denied. Update configuration to allow tools.",
              { kind: "system" },
            );
          }
        }
      }
    }
  };

  void (async () => {
    try {
      await consumeEvents();
    } catch (error) {
      if (!abort.signal.aborted) logger.error({ error, directory: resolved }, "event stream closed");
    } finally {
      // The map doubles as the "already subscribed" guard, so a stream that has
      // ended must leave it or the directory can never be subscribed again.
      abort.abort();
      if (deps.eventSubscriptions.get(resolved) === abort) deps.eventSubscriptions.delete(resolved);
    }
  })();
};
