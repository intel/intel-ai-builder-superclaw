import { tool } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Create, list and delete the automations shown on the Scheduled page.
 *
 * They live in <workspace>/.opencode/openwork/agentlab/automations.json, which openwork-server's
 * scheduler loop reads every 30 seconds. The schedule shapes below restate
 * sandbox/server/src/agentlab-automation.ts, because a deployed Profile carries no package but
 * @opencode-ai/plugin. The server drops any stored item it cannot parse. The 50-automation and
 * 100-character name limits are this tool's own; the server has neither.
 *
 * opencode registers each export as `automation_<export>`.
 */

const DEFAULT_MODEL = "llmrouter/auto"
const MAX_AUTOMATIONS = 50
// The server accepts up to 7 days, but the Scheduled editor refuses to save an interval over 1440 minutes.
const MAX_INTERVAL_MINUTES = 24 * 60
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

type Schedule =
  | { kind: "interval"; seconds: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "days"; weekdays: number[]; hour: number; minute: number }

type StoredAutomation = {
  id: string
  name: string
  enabled?: boolean
  schedule?: unknown
  lastRunAt?: unknown
  [field: string]: unknown
}

type Store = { schemaVersion?: number; updatedAt?: number; items: StoredAutomation[] }

type Ask = (input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void>

const scheduleArgs = {
  frequency: tool.schema
    .enum(["interval", "daily", "days"])
    .describe(
      "interval: repeat every `every_minutes`. daily: every day at `time`. days: the listed `weekdays` (one or more) at `time`.",
    ),
  every_minutes: tool.schema
    .number()
    .optional()
    .describe("For frequency=interval: minutes between runs, 1 to 1440."),
  time: tool.schema
    .string()
    .optional()
    .describe("For daily and days: the local time of day as 24-hour HH:MM, for example 09:00."),
  weekdays: tool.schema
    .array(tool.schema.number())
    .optional()
    .describe("For days: weekday numbers, 1=Monday to 7=Sunday."),
}

function storePath(directory: string): string {
  return join(directory, ".opencode", "openwork", "agentlab", "automations.json")
}

function readStore(path: string): Store {
  if (!existsSync(path)) return { schemaVersion: 1, items: [] }
  const parsed = JSON.parse(readFileSync(path, "utf8"))
  if (!parsed || !Array.isArray(parsed.items)) throw new Error("automations.json has no items array")
  if (parsed.items.some((item: unknown) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error("automations.json has an entry that is not an object")
  }
  return parsed
}

function writeStore(path: string, store: Store): void {
  mkdirSync(dirname(path), { recursive: true })
  const staged = `${path}.${randomUUID()}.tmp`
  writeFileSync(staged, JSON.stringify({ ...store, updatedAt: Date.now() }, null, 2) + "\n", "utf8")
  renameSync(staged, path)
}

function parseTime(time: string | undefined): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((time ?? "").trim())
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null
}

function parseWeekdays(weekdays: number[] | undefined): number[] | null {
  if (!weekdays?.length) return null
  const valid = weekdays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
  return valid && new Set(weekdays).size === weekdays.length ? weekdays : null
}

function buildSchedule(args: {
  frequency: "interval" | "daily" | "days"
  every_minutes?: number
  time?: string
  weekdays?: number[]
}): Schedule | string {
  // The Scheduled page only saves interval and days schedules; it flags a stored daily or weekly one as needing review.
  if (args.frequency === "interval") {
    const minutes = args.every_minutes
    if (minutes === undefined || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_INTERVAL_MINUTES) {
      return "every_minutes must be a whole number from 1 to 1440."
    }
    return { kind: "interval", seconds: minutes * 60 }
  }

  const at = parseTime(args.time)
  if (!at) return "time must be 24-hour HH:MM, for example 09:00."
  if (args.frequency === "daily") return { kind: "days", weekdays: [1, 2, 3, 4, 5, 6, 7], ...at }

  const weekdays = parseWeekdays(args.weekdays)
  if (!weekdays) return "weekdays must be unique numbers from 1 (Monday) to 7 (Sunday)."
  return { kind: "days", weekdays, ...at }
}

function describeSchedule(schedule: Schedule): string {
  const at = (s: { hour: number; minute: number }) =>
    `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`
  switch (schedule.kind) {
    case "interval":
      return `every ${schedule.seconds / 60} minutes`
    case "daily":
      return `every day at ${at(schedule)}`
    case "weekly":
      return `every ${DAY_NAMES[schedule.weekday - 1]} at ${at(schedule)}`
    case "days":
      if (schedule.weekdays.length === 7) return `every day at ${at(schedule)}`
      return `${schedule.weekdays.map((day) => DAY_NAMES[day - 1]).join(", ")} at ${at(schedule)}`
  }
}

/** The scheduler runs an automation as soon as it is due and has never run: at once for an interval, once today's time has passed for days. */
function firstRunNote(schedule: Schedule, now: Date): string {
  if (schedule.kind === "interval") return " It first runs within about a minute."
  if (schedule.kind !== "days") return ""
  const weekday = now.getDay() === 0 ? 7 : now.getDay()
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), schedule.hour, schedule.minute)
  return schedule.weekdays.includes(weekday) && now >= slot
    ? " Today's time has already passed, so it first runs within about a minute, then at the scheduled time."
    : ""
}

/** A hand-edited store can hold a schedule the server would drop; list and remove must not throw on it. */
function isSchedule(raw: unknown): raw is Schedule {
  if (!raw || typeof raw !== "object") return false
  const s = raw as Record<string, unknown>
  const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value)
  const isDay = (value: unknown) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 7
  const hasTime = isNumber(s.hour) && isNumber(s.minute)
  switch (s.kind) {
    case "interval":
      return isNumber(s.seconds)
    case "daily":
      return hasTime
    case "weekly":
      return hasTime && isDay(s.weekday)
    case "days":
      return hasTime && Array.isArray(s.weekdays) && s.weekdays.length > 0 && s.weekdays.every(isDay) && new Set(s.weekdays).size === s.weekdays.length
    default:
      return false
  }
}

function describeStoredSchedule(raw: unknown): string {
  return isSchedule(raw) ? describeSchedule(raw) : "unknown schedule"
}

/** A stored timestamp outside the Date range would make toISOString throw and abort the whole listing. */
function describeLastRun(raw: unknown): string {
  if (typeof raw !== "number") return "never"
  const at = new Date(raw)
  return Number.isNaN(at.getTime()) ? "unknown" : at.toISOString()
}

function isUserRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.message.includes("denied") || err.message.includes("rejected") || (err as { code?: unknown }).code === "USER_DENIED"
}

async function confirm(
  context: { ask: Ask },
  permission: string,
  summary: string,
  metadata: Record<string, unknown>,
): Promise<string | null> {
  try {
    await context.ask({ permission, patterns: [summary], always: [], metadata })
    return null
  } catch (err) {
    if (!isUserRejection(err)) throw err
    return "ACTION_DENIED: The user declined. Nothing was changed. Do not retry unless the user asks again."
  }
}

function tooMany(): string {
  return `ACTION_FAILED: There are already ${MAX_AUTOMATIONS} automations. Delete one first. Nothing was changed.`
}

function failed(action: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err)
  return `ACTION_FAILED: Could not ${action}: ${reason}\nNothing was changed. Do NOT report this as done; tell the user it failed.`
}

export const create = tool({
  description:
    "Create a scheduled automation: SuperClaw will run `prompt` in a new session on a schedule, with nobody watching, " +
    "and it appears on the Scheduled page. The user is asked to confirm first. " +
    "If today's time of day has already passed, the first run happens within about a minute; an interval automation also runs at once. " +
    "Write `prompt` as a complete standalone instruction, because the run has none of this conversation.",
  args: {
    name: tool.schema.string().describe("Short name shown on the Scheduled page."),
    prompt: tool.schema.string().describe("The full instruction to run on each trigger."),
    ...scheduleArgs,
  },
  async execute(args, context) {
    const name = args.name.trim()
    const prompt = args.prompt.trim()
    if (!name || name.length > 100) return "ACTION_FAILED: name must be 1 to 100 characters. Nothing was changed."
    if (!prompt) return "ACTION_FAILED: prompt is required. Nothing was changed."

    const schedule = buildSchedule(args)
    if (typeof schedule === "string") return `ACTION_FAILED: ${schedule} Nothing was changed.`
    const when = describeSchedule(schedule)

    const path = storePath(context.directory)
    let store: Store
    try {
      store = readStore(path)
    } catch (err) {
      return failed("read the automation list", err)
    }
    if (store.items.length >= MAX_AUTOMATIONS) return tooMany()

    const denied = await confirm(context, "automation_create", `${name} (${when}): ${prompt.slice(0, 200)}`, {
      name,
      schedule: when,
      prompt,
    })
    if (denied) return denied

    const now = Date.now()
    const id = `agentlab_${randomUUID().replace(/-/g, "")}`
    try {
      store = readStore(path)
      if (store.items.length >= MAX_AUTOMATIONS) return tooMany()
      store.items.unshift({ id, name, enabled: true, schedule, prompt, model: DEFAULT_MODEL, createdAt: now, updatedAt: now })
      writeStore(path, store)
    } catch (err) {
      return failed("save the automation", err)
    }
    return `Automation created: "${name}", ${when}. Id: ${id}. It is enabled and listed on the Scheduled page.${firstRunNote(schedule, new Date(now))}`
  },
})

export const list = tool({
  description: "List the scheduled automations: id, name, schedule, whether enabled, and the last run time.",
  args: {},
  async execute(_args, context) {
    let store: Store
    try {
      store = readStore(storePath(context.directory))
    } catch (err) {
      return failed("read the automation list", err)
    }
    if (!store.items.length) return "There are no scheduled automations."
    return store.items
      .map(
        (item) =>
          `- ${item.id} | ${item.name} | ${describeStoredSchedule(item.schedule)} | ${item.enabled === false ? "disabled" : "enabled"} | last run: ${describeLastRun(item.lastRunAt)}`,
      )
      .join("\n")
  },
})

export const remove = tool({
  description: "Delete a scheduled automation by id (see automation_list). The user is asked to confirm first.",
  args: {
    id: tool.schema.string().describe("The automation id from automation_list."),
  },
  async execute(args, context) {
    const path = storePath(context.directory)
    let store: Store
    try {
      store = readStore(path)
    } catch (err) {
      return failed("read the automation list", err)
    }
    const found = store.items.find((item) => item.id === args.id)
    if (!found) return `ACTION_FAILED: No automation has id ${args.id}. Nothing was changed.`

    const denied = await confirm(context, "automation_remove", `Delete "${found.name}" (${describeStoredSchedule(found.schedule)})`, {
      id: found.id,
      name: found.name,
    })
    if (denied) return denied

    try {
      store = readStore(path)
      store.items = store.items.filter((item) => item.id !== args.id)
      writeStore(path, store)
    } catch (err) {
      return failed("delete the automation", err)
    }
    return `Automation deleted: "${found.name}".`
  },
})
