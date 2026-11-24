/**
 * Openwork host resolution, lifted out of `createWorkspaceStore`.
 *
 * These two functions take everything they need through their `input`
 * argument and touch no store state, so they are plain functions rather than
 * part of the store factory.
 */
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  normalizeOpenworkServerUrl,
  OpenworkServerError,
  type OpenworkWorkspaceInfo,
} from "../lib/openwork-server";
import { type OpencodeAuth } from "../lib/opencode";
import { uiLogWarn } from "../lib/log";
import { normalizeDirectoryPath, safeStringify } from "../utils";
import {
  openworkResolveRetryDecision,
  type OpenworkResolveOutcome,
} from "./workspace-policy";

export const resolveOpenworkHost = async (input: {
  hostUrl: string;
  token?: string | null;
  workspaceId?: string | null;
  directoryHint?: string | null;
}) => {
  let normalizedHostUrl = normalizeOpenworkServerUrl(input.hostUrl) ?? "";
  if (!normalizedHostUrl) {
    return { kind: "fallback" as const };
  }

  let inferredWorkspaceId: string | null = null;
  try {
    const url = new URL(normalizedHostUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    const workspaceMountIndex = segments.findIndex((segment, index) => segment === "w" && Boolean(segments[index + 1]));
    if (workspaceMountIndex >= 0) {
      inferredWorkspaceId = decodeURIComponent(segments[workspaceMountIndex + 1] ?? "");
      const baseSegments = segments.slice(0, workspaceMountIndex);
      url.pathname = baseSegments.length ? `/${baseSegments.join("/")}` : "/";
      url.search = "";
      url.hash = "";
      normalizedHostUrl = url.toString().replace(/\/+$/, "");
    }
  } catch {
    // ignore
  }

  const requestedWorkspaceId = (input.workspaceId?.trim() || inferredWorkspaceId || "").trim();
  const workspaceBaseUrl = buildOpenworkWorkspaceBaseUrl(normalizedHostUrl, requestedWorkspaceId) ?? normalizedHostUrl;

  const client = createOpenworkServerClient({ baseUrl: workspaceBaseUrl, token: input.token ?? undefined });

  const trimmedToken = input.token?.trim() ?? "";

  // Optimization: start listWorkspaces in parallel with the health probe.
  // listWorkspaces (~8s timeout) is heavier than health (~3s timeout);
  // overlapping them saves one full sequential round-trip on the happy path.
  //
  // Always list from the root URL, not the workspace-scoped URL.
  // A stored openworkWorkspaceId may be stale (e.g. the workspace path changed,
  // giving the workspace a new ID). The scoped
  // URL /w/{staleId}/workspaces returns 404, making listWorkspaces fail before
  // the directory-hint fallback can run. Root-scoped listing always succeeds
  // and lets the hint/activeId matching logic below migrate stale IDs.
  const rootClient = createOpenworkServerClient({ baseUrl: normalizedHostUrl, token: input.token ?? undefined });
  const listPromise = trimmedToken
    ? rootClient.listWorkspaces().then(
        (data) => ({ ok: true as const, data }),
        (error: unknown) => ({ ok: false as const, error }),
      )
    : null;

  try {
    const health = await client.health();
    if (!health?.ok) {
      // Persisted so triage can tell "sandbox not serving yet" apart from a
      // genuinely wrong URL/token without needing developerMode + DevTools.
      uiLogWarn("runtime.connect", "Openwork host resolution fell back", {
        hostUrl: normalizedHostUrl,
        reason: "health_not_ok",
      });
      return { kind: "fallback" as const };
    }
  } catch (error) {
    if (error instanceof OpenworkServerError && (error.status === 401 || error.status === 403)) {
      // Preserve status/code (not just a plain Error) so classifyWorkspaceError
      // can still tell a stale/rejected token apart from a real connectivity
      // failure downstream, instead of falling back to "Cannot reach the
      // workspace runtime."
      // Observability for the reload-disconnect investigation: a 401/403 here
      // is the stale-token fatal path — the retry wrapper does NOT retry it.
      uiLogWarn("runtime.owt.health", "openwork health rejected the token (fatal, not retried)", {
        hostUrl: normalizedHostUrl,
        status: error.status,
        code: error.code || null,
        hasToken: Boolean(trimmedToken),
      });
      if (!trimmedToken) {
        throw new OpenworkServerError(error.status, error.code, "Access token required for SuperClaw server.");
      }
      throw new OpenworkServerError(error.status, error.code, "SuperClaw server rejected the access token.");
    }
    uiLogWarn("runtime.connect", "Openwork host resolution fell back", {
      hostUrl: normalizedHostUrl,
      reason: "health_threw",
      message: error instanceof Error ? error.message : safeStringify(error),
    });
    return { kind: "fallback" as const };
  }

  if (!trimmedToken) {
    throw new Error("Access token required for SuperClaw server.");
  }

  // trimmedToken is truthy here, so listPromise was always initialised.
  const listResult = await listPromise!;
  if (!listResult.ok) {
    throw listResult.error;
  }
  const response = listResult.data;
  const items = Array.isArray(response.items) ? response.items : [];
  const hint = normalizeDirectoryPath(input.directoryHint ?? "");
  const selectByHint = (entry: OpenworkWorkspaceInfo) => {
    if (!hint) return false;
    const entryPath = normalizeDirectoryPath(
      (entry.opencode?.directory as string | undefined) ?? (entry.path as string | undefined) ?? "",
    );
    return Boolean(entryPath && entryPath === hint);
  };
  const selectById = (entry: OpenworkWorkspaceInfo) => Boolean(requestedWorkspaceId && entry?.id === requestedWorkspaceId);

  const workspaceByHint = hint
    ? items.find((item) => item?.id && selectByHint(item))
    : undefined;
  const workspaceById = requestedWorkspaceId
    ? items.find((item) => item?.id && selectById(item))
    : undefined;
  // Directory is the user-visible worker identity. Prefer it over a stored ID so
  // editing the workspace path can migrate stale persisted workspace IDs.

  const workspace = (workspaceByHint ?? workspaceById ?? items[0]) as OpenworkWorkspaceInfo | undefined;
  if (!workspace?.id) {
    throw new Error("SuperClaw server did not return a worker.");
  }
  const opencodeUpstreamBaseUrl = workspace.opencode?.baseUrl?.trim() ?? workspace.baseUrl?.trim() ?? "";
  if (!opencodeUpstreamBaseUrl) {
    throw new Error("SuperClaw server did not provide an OpenCode URL.");
  }

  const workspaceScopedBaseUrl =
    buildOpenworkWorkspaceBaseUrl(normalizedHostUrl, workspace.id) ?? workspaceBaseUrl;
  const opencodeBaseUrl = `${workspaceScopedBaseUrl.replace(/\/+$/, "")}/opencode`;
  const opencodeAuth: OpencodeAuth | undefined = trimmedToken
    ? { token: trimmedToken, mode: "openwork" }
    : undefined;

  return {
    kind: "openwork" as const,
    hostUrl: normalizedHostUrl,
    workspace,
    opencodeBaseUrl,
    directory: workspace.opencode?.directory?.trim() ?? workspace.directory?.trim() ?? "",
    auth: opencodeAuth,
  };
};

// Wraps resolveOpenworkHost with short, capped-exponential backoff retries so
// a freshly-ready sandbox container's boot-time race (health OK but the
// openwork workspace is not listable yet, for a few hundred ms) no longer
// presents to the user as a hard disconnect. Only transient outcomes are
// retried; token rejections (401/403) short-circuit immediately.
//
// Returns either the resolved openwork host or the last non-openwork result;
// rethrows the last error if every attempt threw. `onRetry` lets callers emit
// their own trace/log line per retry (health-check vs create-flow phrasing).
export const resolveOpenworkHostWithRetry = async (
  input: Parameters<typeof resolveOpenworkHost>[0],
  opts?: {
    budgetMs?: number;
    onRetry?: (info: { attempt: number; delayMs: number; reason: "fallback" | "error" }) => void;
  },
): Promise<Awaited<ReturnType<typeof resolveOpenworkHost>>> => {
  const startedAt = Date.now();
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    let outcome: OpenworkResolveOutcome;
    let lastResult: Awaited<ReturnType<typeof resolveOpenworkHost>> | null = null;
    let lastError: unknown = undefined;
    let reason: "fallback" | "error" = "fallback";
    try {
      lastResult = await resolveOpenworkHost(input);
      if (lastResult.kind === "openwork") return lastResult;
      // Non-openwork result == health probe failed/returned not-ok: transient.
      outcome = "transient";
      reason = "fallback";
    } catch (error) {
      lastError = error;
      reason = "error";
      // A rejected/absent token is permanent; retrying wastes the budget.
      outcome =
        error instanceof OpenworkServerError && (error.status === 401 || error.status === 403)
          ? "fatal"
          : "transient";
    }

    const decision = openworkResolveRetryDecision(outcome, attempt, Date.now() - startedAt, opts?.budgetMs);
    if (!decision.retry) {
      if (lastError !== undefined) throw lastError;
      // Budget exhausted on a fallback result: return it so the caller runs
      // its existing not-usable handling (warn + surface a legible error).
      return lastResult as Awaited<ReturnType<typeof resolveOpenworkHost>>;
    }
    opts?.onRetry?.({ attempt, delayMs: decision.delayMs, reason });
    await new Promise<void>((resolve) => setTimeout(resolve, decision.delayMs));
  }
};
