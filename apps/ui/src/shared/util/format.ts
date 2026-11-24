import { t } from "~/i18n";
import type { OpencodeEvent } from "~/shared/types/opencode-connection";

export function safeStringify(value: unknown) {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (val && typeof val === "object") {
          if (seen.has(val as object)) {
            return "<circular>";
          }
          seen.add(val as object);
        }

        const lowerKey = key.toLowerCase();
        if (
          lowerKey === "reasoningencryptedcontent" ||
          lowerKey.includes("api_key") ||
          lowerKey.includes("apikey") ||
          lowerKey.includes("access_token") ||
          lowerKey.includes("refresh_token") ||
          lowerKey.includes("token") ||
          lowerKey.includes("authorization") ||
          lowerKey.includes("cookie") ||
          lowerKey.includes("secret")
        ) {
          return "[redacted]";
        }

        return val;
      },
      2,
    );
  } catch {
    return "<unserializable>";
  }
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  const idx = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / Math.pow(1024, idx);
  const rounded = idx === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[idx]}`;
}

export function normalizeDirectoryQueryPath(input?: string | null) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  const unified = trimmed.replace(/\\/g, "/");
  const withoutTrailing = unified.replace(/\/+$/, "");
  return withoutTrailing || "/";
}

export function normalizeEvent(raw: unknown): OpencodeEvent | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.type === "string") {
    return {
      type: record.type,
      properties: record.properties,
    };
  }

  if (record.payload && typeof record.payload === "object") {
    const payload = record.payload as Record<string, unknown>;
    if (typeof payload.type === "string") {
      return {
        type: payload.type,
        properties: payload.properties,
      };
    }
  }

  return null;
}

export function commandPathFromWorkspaceRoot(
  workspaceRoot: string,
  commandName: string,
) {
  const root = workspaceRoot.trim().replace(/\/+$/, "");
  const name = commandName.trim().replace(/^\/+/, "");
  if (!root || !name) return null;
  return `${root}/.opencode/commands/${name}.md`;
}

export function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function addOpencodeCacheHint(message: string) {
  const lower = message.toLowerCase();
  const cacheSignals = [
    ".cache/opencode",
    "library/caches/opencode",
    "appdata/local/opencode",
    "fetch_jwks.js",
    "opencode cache",
  ];

  if (
    cacheSignals.some((signal) => lower.includes(signal)) &&
    lower.includes("enoent")
  ) {
    return `${message}\n\nOpenCode cache looks corrupted. Use Repair cache in Settings to rebuild it.`;
  }

  return message;
}

export function formatRelativeTime(timestampMs: number, nowMs = Date.now()) {
  const delta = nowMs - timestampMs;

  if (delta < 0) {
    return t("identities.just_now");
  }

  if (delta < 60_000) {
    return `${Math.max(1, Math.round(delta / 1000))}${t("identities.seconds_ago_suffix")}`;
  }

  if (delta < 60 * 60_000) {
    return `${Math.max(1, Math.round(delta / 60_000))}${t("identities.minutes_ago_suffix")}`;
  }

  if (delta < 24 * 60 * 60_000) {
    return `${Math.max(1, Math.round(delta / (60 * 60_000)))}${t("identities.hours_ago_suffix")}`;
  }

  if (delta < 30 * 24 * 60 * 60_000) {
    return `${Math.max(1, Math.round(delta / (24 * 60 * 60_000)))}${t("identities.days_ago_suffix")}`;
  }

  return new Date(timestampMs).toLocaleDateString();
}

/**
 * Localize and humanize a session title for display.
 * Default new-session titles arrive from the backend as `New session - <ISO-8601 UTC timestamp>` (e.g. `New session - 2026-06-22T02:22:13.365Z`).
 * Replace the raw `New session` prefix with the localized `session.new_session` label.
 */
export function localizeSessionTitle(raw: string): string {
  const m = raw.match(/^New [Ss]ession(\s*[-–—]\s*.*)?$/);
  if (!m) return raw;
  const suffix = (m[1] ?? "").replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/,
    (iso) => {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      const formatted = date.toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "numeric",
        minute: "2-digit",
      });
      return formatted.replace(/\b(am|pm)\b/gi, (marker) => marker.toUpperCase());
    },
  );
  return t("session.new_session") + suffix;
}
