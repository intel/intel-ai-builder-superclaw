/**
 * Server-side observability helpers — sidecar probes for `/v1/runtime/status`
 * and the debug-observability gate for `/v1/debug/*`.
 *
 * Extracted from `server.ts` to start carving the god file (per the one-month
 * ship plan's architecture note: "Do this gradually, protect via tests").
 *
 * Two public concerns live here:
 *
 *   1. **Runtime-status probes** — `probeOpencodeRouterSlice`. Each helper hits
 *      one sidecar with a short timeout (`RUNTIME_STATUS_PROBE_MS`) and
 *      returns the slice shape consumed by `/v1/runtime/status`. They never
 *      throw; on any failure the slice is rendered as
 *      `{healthy:false, error:<message>}`. LLM routing AND the connected edge
 *      model are deliberately absent: both are Windows-host concerns
 *      (`llmrouter_manager`, which owns the edge config + endpoint) and their
 *      health is sourced from ServiceHub, not probed from the sandbox.
 *      A sandbox-side probe of the edge endpoint was also wrong on the wire: an
 *      intranet edge reached by hostname is 403'd by the corporate proxy,
 *      whereas the host router bypasses the proxy for it.
 *
 *   2. **Debug observability helpers** — `isDebugObservabilityEnabled` (env
 *      gate) and `fetchIntentTracesFromClassifier` (thin proxy to the intent
 *      classifier's `/debug/intent` ring buffer). Both are gated on
 *      `SUPERCLAW_DEBUG_OBSERVABILITY=1`; production builds with the flag
 *      unset see 404s.
 *
 * Source of truth for the runtime-status slice shapes (see file-level
 * comments in `apps/ui/src/app/lib/runtime-view.ts`):
 *   - opencode_router: sandbox/channels/src/health.ts HealthSnapshot
 */

import { intentClassifierRequestHeaders } from "./intent-classifier-proxy.js";

const RUNTIME_STATUS_PROBE_MS = 1500;
const DEBUG_TRACES_PROXY_TIMEOUT_MS = 1500;

function probeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `timeout after ${RUNTIME_STATUS_PROBE_MS}ms`;
    }
    return err.message || err.name || "probe failed";
  }
  return typeof err === "string" ? err : "probe failed";
}

/**
 * Small local copy of `parseInteger` to keep this module independent of
 * `server.ts`. The original lives in `server.ts` and is used in many places
 * there; importing it back would create a cycle. The helper is trivial.
 */
function parseIntegerLocal(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// =============================================================================
// Debug observability proxy.
// =============================================================================

/**
 * Re-read SUPERCLAW_DEBUG_OBSERVABILITY on every check so the surface can be
 * toggled in tests / dev without restarting the server.
 */
export function isDebugObservabilityEnabled(): boolean {
  return (process.env.SUPERCLAW_DEBUG_OBSERVABILITY || "").trim() === "1";
}

function resolveIntentClassifierBase(): string {
  const raw = process.env.OPENWORK_INTENT_CLASSIFIER_URL?.trim();
  if (raw && raw.length > 0) return raw.replace(/\/+$/, "");
  const port = (process.env.CLASSIFIER_PORT || "18791").trim();
  return `http://127.0.0.1:${port}`;
}

/**
 * Fetch `/debug/intent` from the intent classifier and return its body + status.
 * Proxy contract: 200 passes the sanitized JSON through, 404 means the
 * classifier's flag is off, anything else degrades to a stable error shape.
 * This is the "intent" stage source for the trajectory inspector. Never throws.
 */
export async function fetchIntentTracesFromClassifier(): Promise<{
  status: number;
  body: unknown;
}> {
  const base = resolveIntentClassifierBase();
  try {
    // egress-surface: openwork_proxy_intent_classifier
    const resp = await fetch(`${base}/debug/intent`, {
      headers: intentClassifierRequestHeaders(),
      signal: AbortSignal.timeout(DEBUG_TRACES_PROXY_TIMEOUT_MS),
    });
    if (resp.status === 404) {
      return {
        status: 404,
        body: { error: "not_found", message: "debug observability disabled upstream" },
      };
    }
    if (resp.status === 401) {
      return {
        status: 502,
        body: {
          error: "intent_classifier_auth_failed",
          message: "The intent classifier rejected openwork-server's credential",
        },
      };
    }
    if (!resp.ok) {
      return {
        status: 503,
        body: {
          error: "upstream_error",
          message: `intent classifier /debug/intent returned ${resp.status}`,
        },
      };
    }
    const json = await resp.json().catch(() => null);
    if (json === null || typeof json !== "object") {
      return {
        status: 502,
        body: { error: "bad_upstream_body", message: "intent classifier returned non-JSON" },
      };
    }
    return { status: 200, body: json };
  } catch (err) {
    return {
      status: 503,
      body: { error: "upstream_unreachable", message: probeErrorMessage(err) },
    };
  }
}

// =============================================================================
// /v1/runtime/status probes — one per sidecar.
// =============================================================================
//
// NOTE: there is intentionally no llmrouter probe here. LLM routing runs on the
// Windows host as the ServiceHub-managed `llmrouter_manager`; the app sources
// its health from ServiceHub directly (apps/ui/src/app/lib/use-runtime-status.ts).
// The sandbox must not observe a host-side service - `127.0.0.1:18321` is the host
// manager (whose health lives at `/llm-router/v1/health`, not `/health`), so a
// probe from here would be both wrong and redundant.

export async function probeOpencodeRouterSlice(): Promise<{
  healthy: boolean;
  opencode_healthy?: boolean;
  channels?: { telegram: boolean; whatsapp: boolean; slack: boolean };
  activity?: { inboundToday?: number; outboundToday?: number; lastMessageAt?: number };
  error?: string;
}> {
  const port = parseIntegerLocal(process.env.OPENCODE_ROUTER_HEALTH_PORT) ?? 3005;
  const base = `http://127.0.0.1:${port}`;
  try {
    // egress-surface: openwork_proxy_opencode_router
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(RUNTIME_STATUS_PROBE_MS),
    });
    if (!res.ok) {
      return { healthy: false, error: `opencode-router /health returned ${res.status}` };
    }
    const snap = (await res.json().catch(() => null)) as
      | {
          ok?: boolean;
          opencode?: { healthy?: boolean };
          channels?: { telegram?: boolean; whatsapp?: boolean; slack?: boolean };
          activity?: {
            inboundToday?: number;
            outboundToday?: number;
            lastMessageAt?: number;
          };
        }
      | null;
    if (!snap) return { healthy: false, error: "opencode-router /health returned non-JSON body" };

    const channels = snap.channels
      ? {
          telegram: snap.channels.telegram === true,
          whatsapp: snap.channels.whatsapp === true,
          slack: snap.channels.slack === true,
        }
      : undefined;

    const activity = snap.activity
      ? {
          ...(typeof snap.activity.inboundToday === "number"
            ? { inboundToday: snap.activity.inboundToday }
            : {}),
          ...(typeof snap.activity.outboundToday === "number"
            ? { outboundToday: snap.activity.outboundToday }
            : {}),
          ...(typeof snap.activity.lastMessageAt === "number"
            ? { lastMessageAt: snap.activity.lastMessageAt }
            : {}),
        }
      : undefined;

    const slice: {
      healthy: boolean;
      opencode_healthy?: boolean;
      channels?: { telegram: boolean; whatsapp: boolean; slack: boolean };
      activity?: { inboundToday?: number; outboundToday?: number; lastMessageAt?: number };
    } = { healthy: snap.ok === true };
    if (typeof snap.opencode?.healthy === "boolean") slice.opencode_healthy = snap.opencode.healthy;
    if (channels) slice.channels = channels;
    if (activity && Object.keys(activity).length > 0) slice.activity = activity;
    return slice;
  } catch (err) {
    return { healthy: false, error: probeErrorMessage(err) };
  }
}
