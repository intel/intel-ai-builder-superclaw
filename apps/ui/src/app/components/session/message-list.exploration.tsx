import type { Part } from "@opencode-ai/sdk/v2/client";
import { EXPLORATION_TOOL_NAMES } from "../../utils";
import { isWebSearchToolOutput } from "../../utils";
import { HDR_TOOL, hdrWebSearchUrls } from "./message-list.hdr-progress";

export type ExplorationSummary = {
  files: number;
  searches: number;
  lists: number;
  webPages: number;
  commands: number;
  todoUpdates: number;
};

export type ExplorationWebSource = {
  host: string;
  label: string;
  faviconUrl: string;
  initial: string;
};

export function isExplorationTool(part: Part) {
  if (part.type !== "tool") return false;
  const tool =
    typeof (part as any).tool === "string"
      ? String((part as any).tool).toLowerCase()
      : "";
  return EXPLORATION_TOOL_NAMES.has(tool);
}

export function normalizePath(path: string) {
  const normalized = path.replace(/\\/g, "/").trim().replace(/\/+/g, "/");
  if (!normalized || normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "");
}

export function summarizeExploration(parts: Part[]): ExplorationSummary {
  const files = new Set<string>();
  let fileWithoutPath = 0;
  let searches = 0;
  let lists = 0;
  let webPages = 0;
  let commands = 0;
  let todoUpdates = 0;

  parts.forEach((part) => {
    if (part.type !== "tool") return;
    const tool =
      typeof (part as any).tool === "string"
        ? String((part as any).tool).toLowerCase()
        : "";
    const state = (part as any).state ?? {};
    const input =
      state.input && typeof state.input === "object"
        ? (state.input as Record<string, unknown>)
        : {};

    if (tool === "read") {
      const filePath =
        typeof input.filePath === "string" ? normalizePath(input.filePath) : "";
      if (filePath) {
        files.add(filePath);
      } else {
        fileWithoutPath += 1;
      }
      return;
    }

    if (tool === "glob" || tool === "grep" || tool === "search") {
      searches += 1;
      return;
    }

    if (tool === "webfetch") {
      webPages += 1;
      return;
    }

    if (tool === "bash") {
      const output = typeof state.output === "string" ? state.output : "";
      if (isWebSearchToolOutput(output)) {
        webPages += Math.max(1, extractUrlsFromSearchOutput(output).length);
      } else {
        commands += 1;
      }
      return;
    }

    if (tool === "list" || tool === "list_files") {
      lists += 1;
      return;
    }

    if (tool === "todoread" || tool === "todowrite") {
      todoUpdates += 1;
      return;
    }

    const output = typeof state.output === "string" ? state.output : "";
    if (isWebSearchToolOutput(output)) {
      webPages += Math.max(1, extractUrlsFromSearchOutput(output).length);
    }
  });

  return {
    files: files.size + fileWithoutPath,
    searches,
    lists,
    webPages,
    commands,
    todoUpdates,
  };
}

export function formatExplorationSummary(summary: ExplorationSummary) {
  const items: string[] = [];
  if (summary.files > 0)
    items.push(`${summary.files} file${summary.files === 1 ? "" : "s"}`);
  if (summary.searches > 0)
    items.push(
      `${summary.searches} search${summary.searches === 1 ? "" : "es"}`,
    );
  if (summary.lists > 0)
    items.push(`${summary.lists} list${summary.lists === 1 ? "" : "s"}`);
  if (summary.webPages > 0)
    items.push(
      `${summary.webPages} web page${summary.webPages === 1 ? "" : "s"}`,
    );
  if (summary.commands > 0)
    items.push(
      `${summary.commands} command${summary.commands === 1 ? "" : "s"}`,
    );
  if (summary.todoUpdates > 0)
    items.push(
      `${summary.todoUpdates} todo update${summary.todoUpdates === 1 ? "" : "s"}`,
    );
  return items.length > 0 ? items.join(" · ") : "context activity";
}

export function extractUrlsFromSearchOutput(output: string): string[] {
  const urls: string[] = [];
  const re = /^URL:\s*(https?:\/\/\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const url = m[1]?.trim();
    if (url) urls.push(url);
  }
  return urls;
}

export type ToolPartShape = {
  type: "tool";
  tool?: string;
  state?: {
    status?: string;
    output?: string;
    input?: Record<string, unknown>;
  };
};

export function asToolPart(part: Part): ToolPartShape | null {
  if (part.type !== "tool") return null;
  const record = part as { tool?: unknown; state?: unknown };
  const tool = typeof record.tool === "string" ? record.tool : undefined;
  const rawState =
    record.state && typeof record.state === "object"
      ? (record.state as Record<string, unknown>)
      : undefined;
  const state = rawState
    ? {
        status:
          typeof rawState.status === "string" ? rawState.status : undefined,
        output:
          typeof rawState.output === "string" ? rawState.output : undefined,
        input:
          rawState.input && typeof rawState.input === "object"
            ? (rawState.input as Record<string, unknown>)
            : undefined,
      }
    : undefined;
  return { type: "tool", tool, state };
}

// Skip third-party favicon lookups for private/local hosts (preserve local-first posture).
export const PRIVATE_HOST_SUFFIXES = [
  ".local",
  ".localhost",
  ".corp",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".private",
];

export function isPrivateOrLocalHost(host: string): boolean {
  if (!host) return true;

  // Bare hostnames with no dot are internal-only
  if (!host.includes(".")) return true;

  if (host === "localhost") return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)))
    return true;

  // IPv6 loopback / link-local / unique-local (hostname arrives bracket-less).
  const ipv6Host = host.replace(/^\[|\]$/g, "");
  if (ipv6Host === "::1") return true;
  if (
    ipv6Host.includes(":") &&
    (ipv6Host.startsWith("fe80:") ||
      ipv6Host.startsWith("fc") ||
      ipv6Host.startsWith("fd"))
  ) {
    return true;
  }

  // IPv4 loopback / private / link-local ranges.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local
  }

  return false;
}

export function getWebSourceFromUrl(rawUrl: string): ExplorationWebSource | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (!host) return null;
    const label = host.replace(/^www\./, "");
    return {
      host,
      label,
      // Private/local hosts skip the third-party Google S2 lookup and render the initial-letter fallback instead
      faviconUrl: isPrivateOrLocalHost(host)
        ? ""
        : `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`,
      initial: label.charAt(0).toUpperCase() || "?",
    };
  } catch {
    return null;
  }
}

export function mergeWebSourcesByHost(
  ...lists: ExplorationWebSource[][]
): ExplorationWebSource[] {
  const seen = new Set<string>();
  const merged: ExplorationWebSource[] = [];
  for (const list of lists) {
    for (const source of list) {
      if (seen.has(source.host)) continue;
      seen.add(source.host);
      merged.push(source);
    }
  }
  return merged;
}

export function getExplorationWebSources(parts: Part[]): ExplorationWebSource[] {
  const seen = new Set<string>();
  const sources: ExplorationWebSource[] = [];

  parts.forEach((part) => {
    const record = asToolPart(part);
    if (!record) return;
    const tool = record.tool?.toLowerCase() ?? "";

    let urlsToProcess: string[] = [];
    if (tool === "webfetch") {
      const rawUrl =
        typeof record.state?.input?.url === "string"
          ? record.state.input.url.trim()
          : "";
      if (rawUrl) urlsToProcess = [rawUrl];
    } else if (tool === HDR_TOOL) {
      urlsToProcess = hdrWebSearchUrls(part);
    } else {
      const output = record.state?.output ?? "";
      if (isWebSearchToolOutput(output))
        urlsToProcess = extractUrlsFromSearchOutput(output);
    }

    for (const rawUrl of urlsToProcess) {
      const source = getWebSourceFromUrl(rawUrl);
      if (!source || seen.has(source.host)) continue;
      seen.add(source.host);
      sources.push(source);
    }
  });

  return sources;
}

/** Returns all unique result-domain icons for a single tool part. */
export function getWebSourcesFromPart(part: Part): ExplorationWebSource[] {
  const record = asToolPart(part);
  if (!record) return [];
  const tool = record.tool?.toLowerCase() ?? "";

  if (tool === "webfetch") {
    const rawUrl =
      typeof record.state?.input?.url === "string"
        ? record.state.input.url.trim()
        : "";
    if (!rawUrl) return [];
    const source = getWebSourceFromUrl(rawUrl);
    return source ? [source] : [];
  }

  const output = record.state?.output ?? "";
  let urls: string[] = [];
  if (tool === HDR_TOOL) urls = hdrWebSearchUrls(part);
  else if (isWebSearchToolOutput(output)) urls = extractUrlsFromSearchOutput(output);
  const seen = new Set<string>();
  const sources: ExplorationWebSource[] = [];
  for (const url of urls) {
    const source = getWebSourceFromUrl(url);
    if (source && !seen.has(source.host)) {
      seen.add(source.host);
      sources.push(source);
    }
  }
  return sources;
}

export function explorationStatus(parts: Part[]) {
  const pending = parts.some((part) => {
    if (part.type !== "tool") return false;
    if (!isExplorationTool(part)) return false;
    const state = (part as any).state ?? {};
    return state.status === "running" || state.status === "pending";
  });
  return pending ? "exploring" : "explored";
}
