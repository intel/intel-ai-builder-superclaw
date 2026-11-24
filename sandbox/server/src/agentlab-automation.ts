/**
 * Agent Lab automation model: types, payload validation and scheduling rules.
 * Pure — no I/O. server.ts owns storage, routes and the OpenCode calls.
 */
import { ApiError } from "./errors.js";

export type AgentLabSchedule =
  | { kind: "interval"; seconds: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "days"; weekdays: number[]; hour: number; minute: number };

export type AgentLabAutomation = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: AgentLabSchedule;
  prompt: string;
  model?: string;
  /**
   * OpenCode agent the automation runs as. Unset means classify the prompt the
   * way a chat turn does, then fall back to OpenCode's default agent
   * (superclaw-default) when that has nothing to route (#3279). Jobs that
   * need a specific agent (e.g. git in a scratch clone) must name one (#2865).
   */
  agent?: string;
  createdAt: number;
  updatedAt?: number;
  lastRunAt?: number;
  lastRunSessionId?: string;
  /** Why the scheduler refused the last run; cleared when a run dispatches. */
  lastRunError?: string;
  slackThreadPeerId?: string;
};

export type AgentLabAutomationStore = {
  schemaVersion: number;
  updatedAt: number;
  items: AgentLabAutomation[];
};

function clampInt(value: unknown, options: { min: number; max: number; name: string }): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new ApiError(400, "invalid_payload", `${options.name} must be a number`);
  }
  const int = Math.trunc(num);
  if (int < options.min || int > options.max) {
    throw new ApiError(400, "invalid_payload", `${options.name} must be between ${options.min} and ${options.max}`);
  }
  return int;
}

export function parseAgentLabSchedule(value: unknown): AgentLabSchedule {
  if (!value || typeof value !== "object") {
    throw new ApiError(400, "invalid_payload", "schedule is required");
  }
  const schedule = value as Record<string, unknown>;
  const kind = typeof schedule.kind === "string" ? schedule.kind.trim() : "";
  if (kind === "interval") {
    const seconds = clampInt(schedule.seconds, { min: 60, max: 7 * 24 * 60 * 60, name: "schedule.seconds" });
    return { kind: "interval", seconds };
  }
  if (kind === "daily") {
    const hour = clampInt(schedule.hour, { min: 0, max: 23, name: "schedule.hour" });
    const minute = clampInt(schedule.minute, { min: 0, max: 59, name: "schedule.minute" });
    return { kind: "daily", hour, minute };
  }
  if (kind === "weekly") {
    const weekday = clampInt(schedule.weekday, { min: 1, max: 7, name: "schedule.weekday" });
    const hour = clampInt(schedule.hour, { min: 0, max: 23, name: "schedule.hour" });
    const minute = clampInt(schedule.minute, { min: 0, max: 59, name: "schedule.minute" });
    return { kind: "weekly", weekday, hour, minute };
  }
  if (kind === "days") {
    if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) {
      throw new ApiError(400, "invalid_payload", "schedule.weekdays must contain at least one weekday");
    }
    const weekdays = schedule.weekdays.map((weekday) => {
      if (typeof weekday !== "number" || !Number.isInteger(weekday)) {
        throw new ApiError(400, "invalid_payload", "schedule.weekdays[] must be an integer");
      }
      return clampInt(weekday, { min: 1, max: 7, name: "schedule.weekdays[]" });
    });
    if (new Set(weekdays).size !== weekdays.length) {
      throw new ApiError(400, "invalid_payload", "schedule.weekdays must not contain duplicates");
    }
    const hour = clampInt(schedule.hour, { min: 0, max: 23, name: "schedule.hour" });
    const minute = clampInt(schedule.minute, { min: 0, max: 59, name: "schedule.minute" });
    return { kind: "days", weekdays, hour, minute };
  }
  throw new ApiError(400, "invalid_payload", "schedule.kind must be interval, daily, weekly, or days");
}

export function isAutomationDue(automation: AgentLabAutomation, now: number): boolean {
  const { schedule, lastRunAt } = automation;

  if (schedule.kind === "interval") {
    const intervalMs = schedule.seconds * 1000;
    if (!lastRunAt) return true;
    return now - lastRunAt >= intervalMs;
  }

  if (schedule.kind === "daily") {
    const current = new Date(now);
    const todaySlotMs = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate(),
      schedule.hour,
      schedule.minute,
      0,
      0,
    ).getTime();
    // Only trigger if we are past the scheduled time and haven't run since
    if (now < todaySlotMs) return false;
    if (!lastRunAt) return true;
    return lastRunAt < todaySlotMs;
  }

  if (schedule.kind === "days") {
    const current = new Date(now);
    // JavaScript: 0=Sun,1=Mon..6=Sat; AgentLab: 1=Mon..7=Sun
    const jsDay = current.getDay(); // 0-6
    const agentLabDay = jsDay === 0 ? 7 : jsDay; // 1-7
    if (!schedule.weekdays.includes(agentLabDay)) return false;
    const todaySlotMs = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate(),
      schedule.hour,
      schedule.minute,
      0,
      0,
    ).getTime();
    if (now < todaySlotMs) return false;
    if (!lastRunAt) return true;
    return lastRunAt < todaySlotMs;
  }

  if (schedule.kind === "weekly") {
    const current = new Date(now);
    // JavaScript: 0=Sun,1=Mon..6=Sat; AgentLab: 1=Mon..7=Sun
    const jsDay = current.getDay(); // 0-6
    const agentLabDay = jsDay === 0 ? 7 : jsDay; // 1-7
    if (agentLabDay !== schedule.weekday) return false;
    const todaySlotMs = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate(),
      schedule.hour,
      schedule.minute,
      0,
      0,
    ).getTime();
    if (now < todaySlotMs) return false;
    if (!lastRunAt) return true;
    return lastRunAt < todaySlotMs;
  }

  return false;
}

export function validateAgentLabAutomationId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new ApiError(400, "invalid_payload", "automation id is required");
  }
  if (raw.length > 80) {
    throw new ApiError(400, "invalid_payload", "automation id is too long");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
    throw new ApiError(400, "invalid_payload", "automation id must match /^[a-zA-Z0-9_-]+$/");
  }
  return raw;
}

/** A stored or posted agent name, trimmed; blank or non-string means "default agent". */
export function normalizeAutomationAgent(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The `agent` field of an upsert body. Omitting it keeps the stored value, so
 * clients that re-post a subset (the enable toggle) or predate the field don't
 * reset it. "" or null resets to the default agent.
 */
export function readAutomationAgentUpdate(body: Record<string, unknown>): { provided: boolean; agent?: string } {
  const provided = Object.prototype.hasOwnProperty.call(body, "agent");
  if (provided && body.agent !== null && typeof body.agent !== "string") {
    throw new ApiError(400, "invalid_payload", "agent must be a string");
  }
  return { provided, agent: normalizeAutomationAgent(body.agent) };
}

/**
 * Reject an automation agent that OpenCode cannot run as a primary agent. No-op
 * when `agent` is unset. Scheduled runs have nobody watching, so an unknown,
 * subagent-only or hidden name (e.g. one gated out by a Product Profile change)
 * must fail loudly instead of silently falling back to the default agent (#2865).
 * `loadAgents` returns OpenCode's `GET /agent` payload.
 */
export async function assertAutomationAgentRunnable(
  agent: string | undefined,
  loadAgents: () => Promise<unknown>,
): Promise<void> {
  if (!agent) return;
  let agents: unknown;
  try {
    agents = await loadAgents();
  } catch {
    throw new ApiError(502, "opencode_unavailable", `Could not load the OpenCode agent list to validate agent "${agent}"`);
  }
  const match = Array.isArray(agents)
    ? (agents.find(
        (candidate) =>
          !!candidate && typeof candidate === "object" && (candidate as { name?: unknown }).name === agent,
      ) as { mode?: unknown; hidden?: unknown } | undefined)
    : undefined;
  if (!match) {
    throw new ApiError(400, "invalid_agent", `Agent "${agent}" is not available in this workspace`);
  }
  if (match.mode === "subagent") {
    throw new ApiError(400, "invalid_agent", `Agent "${agent}" is a subagent and cannot run an automation`);
  }
  if (match.hidden === true) {
    throw new ApiError(400, "invalid_agent", `Agent "${agent}" is hidden and cannot run an automation`);
  }
}
