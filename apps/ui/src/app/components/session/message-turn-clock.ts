import { currentLocale, t } from "~/i18n";
import { formatRelativeTime } from "~/shared/util/format";

type TurnStamp = {
  at: number;
  durationMs: number | null;
};

function finiteMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAutoCompaction(parts: readonly unknown[] | undefined): boolean {
  return (
    parts?.some((part) => {
      const record = part as { type?: unknown; auto?: unknown } | null;
      return record?.type === "compaction" && record.auto === true;
    }) === true
  );
}

/**
 * When the turn each user message belongs to began, keyed by message id.
 *
 * An automatic compaction adds its own user message, and once its summary
 * succeeds one more: a copy of the prompt being retried or a synthetic
 * "continue". Both belong to the turn already running, so they inherit its start.
 */
export function turnStartByUserId(messages: readonly TranscriptMessage[]): Map<string, number> {
  const starts = new Map<string, number>();
  let turnStart: number | null = null;
  let pendingCompactionId: string | null = null;
  for (const message of messages) {
    const info = message.info as {
      role?: unknown;
      id?: unknown;
      parentID?: unknown;
      finish?: unknown;
      error?: unknown;
      time?: { created?: unknown };
    } | null;
    if (info?.role === "assistant") {
      if (info.parentID === pendingCompactionId && (info.error || info.finish === "error")) {
        pendingCompactionId = null;
      }
      continue;
    }
    const at = finiteMs(info?.time?.created);
    if (info?.role !== "user" || typeof info.id !== "string" || at === null) continue;
    const autoCompaction = isAutoCompaction(message.parts);
    turnStart =
      turnStart !== null && (autoCompaction || pendingCompactionId !== null) ? turnStart : at;
    starts.set(info.id, turnStart);
    pendingCompactionId = autoCompaction ? info.id : null;
  }
  return starts;
}

type TranscriptMessage = { info: unknown; parts?: readonly unknown[] };

/**
 * Turn starts over the session's whole loaded transcript. `windowed` may be only
 * the rendered tail of it, which can begin after a reply's prompt.
 */
export function transcriptTurnStarts(
  windowed: readonly TranscriptMessage[],
  loadedMessages?: (sessionId: string) => readonly TranscriptMessage[],
): Map<string, number> {
  let sessionId: string | undefined;
  for (const message of windowed) {
    const id = (message.info as { sessionID?: unknown } | null)?.sessionID;
    if (typeof id === "string") {
      sessionId = id;
      break;
    }
  }
  const loaded = sessionId && loadedMessages ? loadedMessages(sessionId) : [];
  return turnStartByUserId(loaded.length > 0 ? loaded : windowed);
}

/**
 * Wall-clock instant for a turn. Assistant turns prefer `time.completed`
 * (when the reply finished); every other role uses `time.created`.
 *
 * The runtime opens a new assistant message for every step of a turn, each
 * with `parentID` set to the prompting user message, so a finished assistant
 * turn runs from when that message's turn began. Without it, the message's own
 * span is the best available.
 */
export function messageTurnStamp(
  info: unknown,
  turnStartById?: ReadonlyMap<string, number>,
): TurnStamp | null {
  if (!info || typeof info !== "object") return null;
  const record = info as {
    role?: unknown;
    parentID?: unknown;
    time?: { created?: unknown; completed?: unknown };
  };
  const created = finiteMs(record.time?.created);
  const completed = finiteMs(record.time?.completed);
  const assistant = record.role === "assistant";
  const at = assistant ? (completed ?? created) : created;
  if (at === null) return null;
  if (!assistant || completed === null) return { at, durationMs: null };
  const turnStart =
    typeof record.parentID === "string" ? turnStartById?.get(record.parentID) : undefined;
  const startedAt = turnStart !== undefined && turnStart <= completed ? turnStart : created;
  const durationMs = startedAt !== null && completed >= startedAt ? completed - startedAt : null;
  return { at, durationMs };
}

/** Relative footer label. Under a minute stays "Just now", then the shared ago formatter. */
export function formatTurnRelativeLabel(at: number, now: number): string {
  if (now - at < 60_000) return t("identities.just_now");
  return formatRelativeTime(at, now);
}

const absoluteFormatters = new Map<string, Intl.DateTimeFormat>();

/** Absolute local datetime in the app's language, e.g. "Nov 5, 2026, 10:21 AM". */
export function formatAbsoluteTurnTime(
  ms: number,
  options?: { locale?: string; timeZone?: string },
): string {
  const locale = options?.locale ?? currentLocale();
  const key = `${locale}|${options?.timeZone ?? ""}`;
  let formatter = absoluteFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: options?.timeZone,
    });
    absoluteFormatters.set(key, formatter);
  }
  return formatter.format(new Date(ms));
}

/** Tooltip body: absolute time, plus "Worked for …" when the turn has a duration. */
export function formatTurnTimeTooltip(
  absolute: string,
  durationLabel: string | null,
): string {
  if (!durationLabel) return absolute;
  return `${absolute}\n${t("session.worked_for")} ${durationLabel}`;
}
