import { currentLocale, t } from "../../i18n";
import type { ScheduledJob } from "../types";
import type { AgentLabAutomationItem, AgentLabSchedulePayload } from "../lib/openwork-server";
import { formatRelativeTime } from "../utils";

export const toRelative = (value?: string | null) => {
  if (!value) return t("scheduled.never");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return t("scheduled.never");
  return formatRelativeTime(parsed);
};

export const pad2 = (value: number) => String(value).padStart(2, "0");

export const parseCronNumbers = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return [] as number[];
  const parts = trimmed.split(",");
  const values = new Set<number>();
  for (const part of parts) {
    const segment = part.trim();
    if (!segment) continue;
    if (segment.includes("-")) {
      const [startRaw, endRaw] = segment.split("-");
      const start = Number.parseInt(startRaw ?? "", 10);
      const end = Number.parseInt(endRaw ?? "", 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      for (let i = lo; i <= hi; i += 1) values.add(i);
      continue;
    }
    const num = Number.parseInt(segment, 10);
    if (!Number.isFinite(num)) continue;
    values.add(num);
  }
  return Array.from(values).sort((a, b) => a - b);
};

const formatTimeLabel = (hour: number, minute: number) => {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const time = `${h12}:${pad2(minute)}`;
  const period = t(hour >= 12 ? "scheduled.time_pm" : "scheduled.time_am");
  // Chinese puts the period before the time (上午9:00); English after (9:00 AM)
  return currentLocale() === "zh" ? `${period}${time}` : `${time} ${period}`;
};

const formatHourInterval = (hours: number) =>
  hours === 1 ? t("scheduled.every_hour") : `${t("scheduled.every")} ${hours} ${t("scheduled.hours")}`;

export const humanizeCron = (cron: string, source?: string) => {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return t("scheduled.custom_schedule");
  const [minuteRaw, hourRaw, dom, mon, dowRaw] = parts;
  if (!minuteRaw || !hourRaw || !dom || !mon || !dowRaw) return t("scheduled.custom_schedule");

  // Every N hours. AgentLab's interval schedules never produce this shape (they
  // always encode as a minute-field step below, even for multi-hour intervals),
  // so this is always real cron: only true when N evenly divides 24, otherwise
  // the hour field skips irregularly (e.g. */5 hits 0,5,10,15,20, then a 4h gap).
  // The field must be exactly "*/N" — a compound field like "*/4,2" matches
  // startsWith but fires on more hours than N alone describes.
  if (minuteRaw === "0" && /^\*\/\d+$/.test(hourRaw) && dom === "*" && mon === "*" && dowRaw === "*") {
    const interval = Number.parseInt(hourRaw.slice(2), 10);
    if (Number.isFinite(interval) && interval > 0 && 24 % interval === 0) return formatHourInterval(interval);
  }

  // Every N minutes. AgentLab interval schedules map to `*/N * * * *` even when
  // N >= 60 (a real cron minute field never reaches 60, so N >= 60 here always
  // means AgentLab) — folding a multiple of 60 into hours is only valid for
  // that encoding. In real cron, a minute-field step >= 60 (e.g. "*/120") just
  // matches minute 0 every hour, exactly like "*/60" — it can't mean "every 2
  // hours", only "every hour". A legacy N < 60 only cycles evenly when N
  // divides 60 — e.g. `*/45` only matches :00 and :45, an irregular 45/15
  // alternation, not "every 45 minutes". The field must be exactly "*/N", not
  // a compound like "*/20,10" (which also fires on :10 and :30, not just
  // every 20 minutes).
  if (/^\*\/\d+$/.test(minuteRaw) && hourRaw === "*" && dom === "*" && mon === "*" && dowRaw === "*") {
    const interval = Number.parseInt(minuteRaw.slice(2), 10);
    if (Number.isFinite(interval) && interval > 0) {
      if (source === "agentlab") {
        if (interval % 60 === 0) return formatHourInterval(interval / 60);
        return interval === 1 ? t("scheduled.every_minute") : `${t("scheduled.every")} ${interval} ${t("scheduled.minutes")}`;
      }
      if (interval % 60 === 0) return formatHourInterval(1);
      if (interval < 60 && 60 % interval === 0) {
        return interval === 1 ? t("scheduled.every_minute") : `${t("scheduled.every")} ${interval} ${t("scheduled.minutes")}`;
      }
    }
  }

  // Daily / weekly at a fixed time
  const hour = Number.parseInt(hourRaw, 10);
  const minute = Number.parseInt(minuteRaw, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return t("scheduled.custom_schedule");
  if (dom !== "*" || mon !== "*") return t("scheduled.custom_schedule");

  const timeLabel = formatTimeLabel(hour, minute);

  if (dowRaw === "*") {
    return `${t("scheduled.every_day_at")} ${timeLabel}`;
  }

  const days = parseCronNumbers(dowRaw);
  const normalized = new Set(days.map((d) => (d === 7 ? 0 : d)));
  const allDays = [0, 1, 2, 3, 4, 5, 6];
  const weekdayDays = [1, 2, 3, 4, 5];
  const weekendDays = [0, 6];

  const includesAll = allDays.every((d) => normalized.has(d));
  if (includesAll) return `${t("scheduled.every_day_at")} ${timeLabel}`;

  const includesWeekdays = weekdayDays.every((d) => normalized.has(d)) && !weekendDays.some((d) => normalized.has(d));
  if (includesWeekdays) return `${t("scheduled.weekdays_at")} ${timeLabel}`;

  const includesWeekends = weekendDays.every((d) => normalized.has(d)) && !weekdayDays.some((d) => normalized.has(d));
  if (includesWeekends) return `${t("scheduled.weekends_at")} ${timeLabel}`;

  const labels: Record<number, string> = {
    0: t("scheduled.day_sun"),
    1: t("scheduled.day_mon"),
    2: t("scheduled.day_tue"),
    3: t("scheduled.day_wed"),
    4: t("scheduled.day_thu"),
    5: t("scheduled.day_fri"),
    6: t("scheduled.day_sat"),
  };
  const list = Array.from(normalized)
    .filter((d) => d >= 0 && d <= 6)
    .sort((a, b) => a - b)
    .map((d) => labels[d] ?? String(d))
    .join(", ");
  if (!list) return `${t("scheduled.at_time")} ${timeLabel}`;
  return `${list} ${t("scheduled.at_time_suffix")} ${timeLabel}`;
};

export const taskSummary = (job: ScheduledJob) => {
  const run = job.run;
  if (run?.command) {
    const args = run.arguments ? ` ${run.arguments}` : "";
    return { label: t("scheduled.summary_command"), value: `${run.command}${args}`, mono: true };
  }
  const prompt = run?.prompt ?? job.prompt;
  if (prompt) {
    return { label: t("scheduled.summary_prompt"), value: prompt, mono: false };
  }
  return { label: t("scheduled.summary_task"), value: t("scheduled.no_prompt_or_command"), mono: false };
};

export const statusLabel = (status?: string | null) => {
  if (!status) return t("scheduled.status_not_run_yet");
  if (status === "running") return t("scheduled.status_running");
  if (status === "ran") return t("scheduled.status_ran");
  if (status === "success") return t("scheduled.status_success");
  if (status === "failed") return t("scheduled.status_failed");
  return status;
};

export const statusTone = (status?: string | null) => {
  if (status === "success") return "border-dls-success-border bg-dls-success-bg text-dls-success-text";
  if (status === "ran") return "border-dls-info-border bg-dls-info-bg text-dls-info-text";
  if (status === "failed") return "border-dls-danger-border bg-dls-danger-bg text-dls-danger-text";
  if (status === "running") return "border-dls-warning-border bg-dls-warning-bg text-dls-warning-text";
  return "border-dls-border bg-dls-hover text-dls-secondary";
};

/** Solid color for the card's left status-accent bar; mirrors statusTone's color families. */
export const statusAccentClass = (status?: string | null) => {
  if (status === "success") return "bg-dls-success-dot";
  if (status === "ran") return "bg-dls-info-dot";
  if (status === "failed") return "bg-dls-danger-dot";
  if (status === "running") return "bg-dls-warning-dot";
  return "bg-dls-border";
};

export type AgentLabAutomationWithStatus = AgentLabAutomationItem & {
  lastRunStatus?: string;
};

// The old picker saved 5+ days as `daily` and fewer as `weekly` on the first day
// (#3069); origin isn't stored, so flag both kinds without claiming either is legacy.
export const scheduleNeedsDayReview = (schedule: AgentLabSchedulePayload): boolean =>
  schedule.kind === "daily" || schedule.kind === "weekly";

export const scheduleDayReviewMessage = (schedule: AgentLabSchedulePayload): string | null => {
  if (schedule.kind === "daily") return t("scheduled.needs_day_review_daily");
  if (schedule.kind === "weekly") return t("scheduled.needs_day_review_weekly");
  return null;
};

export const dayOptions = [
  { id: "mo", label: "Mo", cron: "1" },
  { id: "tu", label: "Tu", cron: "2" },
  { id: "we", label: "We", cron: "3" },
  { id: "th", label: "Th", cron: "4" },
  { id: "fr", label: "Fr", cron: "5" },
  { id: "sa", label: "Sa", cron: "6" },
  { id: "su", label: "Su", cron: "0" },
];

export const normalizeSentence = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/[.!?]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
};

export const buildCronFromDaily = (timeValue: string, days: string[]) => {
  const [hour, minute] = timeValue.split(":");
  if (!hour || !minute) return "";
  const hourValue = Number.parseInt(hour, 10);
  const minuteValue = Number.parseInt(minute, 10);
  if (!Number.isFinite(hourValue) || !Number.isFinite(minuteValue)) return "";
  if (!days.length) return "";
  if (days.length === dayOptions.length) {
    return `${minuteValue} ${hourValue} * * *`;
  }
  const daySpec = dayOptions
    .filter((day) => days.includes(day.id))
    .map((day) => day.cron)
    .join(",");
  if (!daySpec) return "";
  return `${minuteValue} ${hourValue} * * ${daySpec}`;
};

export const buildCronFromInterval = (minutes: number) => {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `*/${m} * * * *`;
  const h = Math.round(m / 60);
  return `0 */${h} * * *`;
};

export const buildAutomationPrompt = (options: {
  name: string;
  prompt: string;
  schedule: string;
  workdir: string;
}) => {
  const name = options.name.trim();
  const schedule = options.schedule.trim();
  const prompt = normalizeSentence(options.prompt);
  if (!schedule || !prompt) return "";
  const workdir = options.workdir.trim();
  const nameSegment = name ? ` named "${name}"` : "";
  const workdirSegment = workdir ? ` Run from ${workdir}.` : "";
  return `Schedule a job${nameSegment} with cron "${schedule}" to ${prompt}${workdirSegment}`.trim();
};

export const isAutomationFormComplete = (options: {
  name: string;
  prompt: string;
  schedule: string;
  intervalValid: boolean;
}) => !!options.name.trim() && !!normalizeSentence(options.prompt) && !!options.schedule.trim() && options.intervalValid;
