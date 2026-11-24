// Closure-free helpers lifted out of createWorkspaceStore. Every function here
// reads only its arguments and module scope — no signals, no store state — which
// is why they can live outside the factory. Moved verbatim (de-indented and
// exported) from context/workspace.ts; no behaviour change.

import { homeDir } from "@tauri-apps/api/path";

import { isTauriRuntime } from "../utils";
import type { OpencodeAuth } from "../lib/opencode";
import type { WorkspaceInfo } from "../lib/tauri";

export const DEFAULT_CONNECT_HEALTH_TIMEOUT_MS = 12_000;
export const LOCAL_BOOT_CONNECT_HEALTH_TIMEOUT_MS = 180_000;
export const LONG_BOOT_CONNECT_REASONS = new Set([
  "host-start",
  "bootstrap-local",
  // openwork-remote: backend-manager emits `superclaw://backend-ready` as soon
  // as the openwork-server proxy answers /health, but the upstream opencode
  // subprocess may still be initializing. The waitForHealthy probe phase
  // needs a generous budget so the first session.list() doesn't race the
  // 10s default opencode request timeout.
  "workspace-switch-openwork",
]);
export const DB_MIGRATE_UNSUPPORTED_PATTERNS = [
  /unknown(?:\s+sub)?command\s+['"`]?db['"`]?/i,
  /unrecognized(?:\s+sub)?command\s+['"`]?db['"`]?/i,
  /no such command[:\s]+db/i,
  /found argument ['"`]db['"`] which wasn't expected/i,
] as const;

export const connectRequestKey = (
  nextBaseUrl: string,
  directory?: string,
  context?: {
    workspaceId?: string;
    workspaceType?: WorkspaceInfo["workspaceType"];
    targetRoot?: string;
    reason?: string;
  },
  auth?: OpencodeAuth,
  connectOptions?: { quiet?: boolean; navigate?: boolean },
) =>
  [
    nextBaseUrl.trim(),
    (directory ?? "").trim(),
    context?.workspaceId?.trim() ?? "",
    context?.workspaceType ?? "",
    context?.targetRoot?.trim() ?? "",
    context?.reason ?? "",
    auth?.mode ?? (auth ? "basic" : "none"),
    String(connectOptions?.quiet ?? false),
    String(connectOptions?.navigate ?? true),
  ].join("::");

export const resolveConnectHealthTimeoutMs = (reason?: string) => {
  const normalizedReason = reason?.trim() ?? "";
  if (LONG_BOOT_CONNECT_REASONS.has(normalizedReason)) {
    return LOCAL_BOOT_CONNECT_HEALTH_TIMEOUT_MS;
  }
  return DEFAULT_CONNECT_HEALTH_TIMEOUT_MS;
};

export const formatExecOutput = (result: { stdout: string; stderr: string }) => {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  return [stderr, stdout].filter(Boolean).join("\n\n");
};

export const isDbMigrateUnsupported = (output: string) => {
  const normalized = output.trim();
  if (!normalized) return false;
  return DB_MIGRATE_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(normalized));
};

export const makeRunId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export function normalizeRoots(list: string[]) {
  const out: string[] = [];
  for (const entry of list) {
    const trimmed = entry.trim().replace(/\/+$/, "");
    if (!trimmed) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export async function resolveWorkspacePath(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (!isTauriRuntime()) return trimmed;

  if (trimmed === "~") {
    try {
      return (await homeDir()).replace(/[\\/]+$/, "");
    } catch {
      return trimmed;
    }
  }

  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    try {
      const home = (await homeDir()).replace(/[\\/]+$/, "");
      return `${home}${trimmed.slice(1)}`;
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

export function markOnboardingComplete() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem("openwork.onboardingComplete", "1");
  } catch {
    // ignore
  }
}
