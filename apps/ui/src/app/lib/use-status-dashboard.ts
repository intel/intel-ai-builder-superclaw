/**
 * useStatusDashboard - the polling hook that feeds <StatusBanner> /
 * <StatusDashboard> with a merged `SandboxStatusView`.
 *
 * Four sources are polled in parallel every `pollIntervalMs` (default 15s):
 *
 *   1. ServiceHub `/app/services/health` — health of all hub-managed services
 *      (LLMRouter, SandboxManager, Security). Drives `hubServices` + derived
 *      `sandboxManager` slices.
 *
 *   2. OpenWork server `GET /v1/runtime/status` — sandbox data-plane truth:
 *      OpenWork, Channels, and the Router-observed OpenCode probe. Drives
 *      `serverSide` slice.
 *
 *   3. LLMRouter `GET /llm-router/v1/status` + `/cloud/model/health` + `/edge`
 *      — model routing breakdown. Drives `lrmModels` slice.
 *
 *   4. OpenCode engine `GET /opencode/global/health` + `/mcp` + `/config`
 *      — direct agent runtime health. Drives `opencode` slice.
 *
 * Each source is independent: one failing must not stop the others from
 * reporting. Severity, summary, and the composite view are derived through
 * helpers from `status-view.ts` so the rules live in exactly one place.
 */

import { createEffect, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";

import { createServiceHubClient, readinessBlockers, resolveServiceHubFetch, requestServiceHubJson } from "./servicehub";
import {
  computeAppReadinessSeverity,
  computeHubServicesSeverity,
  computeServerSideSeverity,
  summarizeSandboxStatus,
} from "./status-view";
import type {
  SandboxStatusView,
  SandboxManagerView,
  ServerRuntimeSlices,
  ServerSideView,
  AppReadinessView,
  HubServicesView,
  HubServiceEntry,
  LrmModelsView,
  LrmLocalModelEntry,
  LrmCloudEntry,
  LrmEdgeEntry,
  OpencodeView,
  OpencodeMcpEntry,
} from "./status-view";
import { readOpenworkServerSettings } from "./openwork-server";

export interface UseRuntimeStatusOptions {
  serverBaseUrl: Accessor<string | null>;
  serverAuth: Accessor<{ token: string } | null>;
  /** Polling interval in ms. */
  pollIntervalMs?: number;
  /** When false, the polling timer is paused (the last view is preserved). */
  enabled?: Accessor<boolean>;
}

export interface UseRuntimeStatusResult {
  view: Accessor<SandboxStatusView>;
  /** Force a refetch outside the timer. */
  refresh: () => void;
  /** True while a fetch is in flight. */
  isFetching: Accessor<boolean>;
  /**
   * ms epoch of the last successful fetch. Lives outside the equality-checked
   * `view` signal so it updates even when the runtime data hasn't changed.
   */
  lastUpdatedAt: Accessor<number>;
}

/**
 * Default poll interval: 15 s.
 *
 * Rationale: services are stable — a 5 s hammer is wasteful when everything
 * is healthy. 15 s gives fresh-enough data (most failures are noticed within
 * one cycle) without the resource cost. A manual "Refresh" button covers the
 * "I just fixed something, show me now" case.
 */
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const SERVER_FETCH_TIMEOUT_MS = 3_000;
const HUB_FETCH_TIMEOUT_MS = 5_000;

/**
 * Shallow+deep equality check for SandboxStatusView. Prevents unnecessary signal
 * updates (and downstream re-renders) when the poll returns the same data.
 * `lastUpdatedAt` is intentionally excluded: it changes every successful
 * fetch but is only consumed by the panel footer — not worth triggering a full
 * reactive cascade for a timestamp.
 */
function sandboxStatusViewEquals(prev: SandboxStatusView, next: SandboxStatusView): boolean {
  if (prev.severity !== next.severity) return false;
  if (prev.summary !== next.summary) return false;
  if (prev.sandboxManager.severity !== next.sandboxManager.severity) return false;
  if (prev.sandboxManager.reachable !== next.sandboxManager.reachable) return false;
  if (prev.sandboxManager.healthy !== next.sandboxManager.healthy) return false;
  if (prev.sandboxManager.error !== next.sandboxManager.error) return false;
  if (prev.serverSide.severity !== next.serverSide.severity) return false;
  if (prev.serverSide.reachable !== next.serverSide.reachable) return false;
  if (prev.serverSide.error !== next.serverSide.error) return false;
  // Deep-compare nested snapshots. Both payloads are small server responses
  // (< 2 KB) and this runs at most once every 15 s — stringify is cheap enough.
  if (JSON.stringify(prev.serverSide.slices) !== JSON.stringify(next.serverSide.slices)) return false;
  if (JSON.stringify(prev.hubServices) !== JSON.stringify(next.hubServices)) return false;
  if (JSON.stringify(prev.lrmModels) !== JSON.stringify(next.lrmModels)) return false;
  if (JSON.stringify(prev.opencode) !== JSON.stringify(next.opencode)) return false;
  if (JSON.stringify(prev.appReadiness) !== JSON.stringify(next.appReadiness)) return false;
  return true;
}

/** Empty, severity=unknown starting view. */
function makeInitialView(): SandboxStatusView {
  const view: SandboxStatusView = {
    severity: "unknown",
    summary: "Sandbox status loading...",
    lastUpdatedAt: 0,
    sandboxManager: { severity: "unknown", reachable: false },
    serverSide: { severity: "unknown", reachable: false },
  };
  return view;
}

/** Best-effort string extraction from any thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Validate the unknown payload returned by the server into a
 * `ServerRuntimeSlices`. Same defensive stance as the backend-manager parser.
 */
function parseServerRuntimeSlices(raw: unknown): ServerRuntimeSlices {
  if (!raw || typeof raw !== "object") {
    throw new Error("server runtime response was not an object");
  }
  const obj = raw as Record<string, unknown>;
  // `llmrouter` is intentionally not required: LLM routing runs on the Windows
  // host and its health comes from ServiceHub (see fetchSandboxManager), so the
  // container's /v1/runtime/status no longer emits an llmrouter slice.
  for (const key of ["server", "opencode_router"]) {
    if (!obj[key] || typeof obj[key] !== "object") {
      throw new Error(`server runtime response missing \`${key}\``);
    }
  }
  // edge_model is newer; default it so an older server response still parses.
  if (!obj.edge_model || typeof obj.edge_model !== "object") {
    obj.edge_model = { configured: false };
  }
  return obj as unknown as ServerRuntimeSlices;
}

/**
 * Fetch OpenCode engine data directly via the /opencode/* proxy on the
 * OpenWork server. Three parallel requests:
 *   GET /opencode/global/health  → healthy + version
 *   GET /opencode/mcp            → MCP server states
 *   GET /opencode/config         → config object
 *
 * All three are best-effort; individual failures degrade gracefully.
 */
async function fetchOpencodeSlice(
  baseUrl: string | null,
  auth: { token: string } | null,
  signal: AbortSignal,
): Promise<OpencodeView> {
  if (!baseUrl || !auth) {
    return { reachable: false, error: "Server not connected yet" };
  }
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
  };
  const fetchImpl = resolveServiceHubFetch();

  async function get<T>(path: string, timeoutMs: number): Promise<T> {
    const ts = AbortSignal.timeout(timeoutMs);
    const composed: AbortSignal =
      typeof (AbortSignal as any).any === "function"
        ? (AbortSignal as any).any([signal, ts])
        : ts;
    const res = await fetchImpl(`${base}${path}`, { headers, signal: composed });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }

  // Run all three in parallel; individual failures are non-fatal.
  const [healthRes, mcpRes, configRes] = await Promise.allSettled([
    get<{ healthy: boolean; version?: string }>("/opencode/global/health", 4_000),
    get<Record<string, { state?: string; error?: string }>>("/opencode/mcp", 5_000),
    get<Record<string, unknown>>("/opencode/config", 5_000),
  ]);

  if (healthRes.status === "rejected") {
    // If health fails the whole slice is unreachable.
    return { reachable: false, error: errorMessage(healthRes.reason) };
  }

  const health = healthRes.value;

  const mcp: OpencodeMcpEntry[] | undefined =
    mcpRes.status === "fulfilled"
      ? Object.entries(mcpRes.value).map(([name, v]) => ({
          name,
          state: v.state ?? "unknown",
          error: v.error,
        }))
      : undefined;

  const config =
    configRes.status === "fulfilled"
      ? { raw: configRes.value }
      : undefined;

  return {
    reachable: true,
    healthy: health.healthy,
    version: health.version,
    mcp,
    config,
  };
}

/**
 * Fetch the authoritative product-readiness projection.
 *
 * Its `state` drives the headline severity. The other slices stay: they carry
 * per-service detail (ports, restart counts, model routing, MCP servers) that the
 * readiness contract deliberately does not, since it answers "is the product
 * serving?" rather than "what exactly is every component doing?".
 */
async function fetchAppReadiness(): Promise<AppReadinessView> {
  const settings = readOpenworkServerSettings();
  const hubUrl = settings.hubUrl?.trim() ?? "";
  const hubToken = settings.hubToken?.trim() ?? "";
  if (!hubUrl || !hubToken) {
    return { reachable: false, blockers: [], error: "ServiceHub not connected yet" };
  }
  try {
    const hub = createServiceHubClient({ baseUrl: hubUrl, token: hubToken });
    const readiness = await hub.appReadiness();
    return { reachable: true, state: readiness.state, blockers: readinessBlockers(readiness) };
  } catch (err) {
    return { reachable: false, blockers: [], error: errorMessage(err) };
  }
}

/**
 * Fetch all ServiceHub-managed services health. Independent of sandbox_manager
 * — this gives the full picture: LRM, SandboxManager, Security, etc.
 */
async function fetchHubServices(): Promise<HubServicesView> {
  const settings = readOpenworkServerSettings();
  const hubUrl = settings.hubUrl?.trim() ?? "";
  const hubToken = settings.hubToken?.trim() ?? "";
  if (!hubUrl || !hubToken) {
    return { reachable: false, healthy: false, services: [], error: "ServiceHub not connected yet" };
  }
  try {
    const hub = createServiceHubClient({ baseUrl: hubUrl, token: hubToken });
    const health = await hub.servicesHealth();
    const services: HubServiceEntry[] = health.services.map((s) => ({
      name: s.name,
      proxy_prefix: s.proxy_prefix,
      port: s.port,
      state: s.state,
      healthy: s.healthy,
      failure_count: s.failure_count,
      restart_attempts: s.restart_attempts,
      instance_id: s.instance_id,
    }));
    return { reachable: true, healthy: health.healthy, services };
  } catch (err) {
    return { reachable: false, healthy: false, services: [], error: errorMessage(err) };
  }
}

/**
 * Fetch LRM model breakdown from ServiceHub proxy at /llm-router/v1/status.
 * Also fetches cloud model health from /llm-router/v1/cloud/model/health and
 * edge config from /llm-router/v1/edge.
 */
async function fetchLrmModels(): Promise<LrmModelsView> {
  const settings = readOpenworkServerSettings();
  const hubUrl = settings.hubUrl?.trim() ?? "";
  const hubToken = settings.hubToken?.trim() ?? "";
  if (!hubUrl || !hubToken) {
    return {
      reachable: false,
      local: [],
      cloud: { status: "not_configured" },
      edge: { configured: false, status: "not_configured" },
      error: "ServiceHub not connected yet",
    };
  }
  try {
    // Fetch LRM /v1/status through ServiceHub proxy (hub_token gated)
    type LrmStatus = {
      state?: string;
      version?: string;
      uptime_seconds?: number;
      summary?: {
        system?: { routing_strategy?: string };
        inference_servers?: Array<{
          role?: string;
          model_id?: string;
          state?: string;
          port?: number;
        }>;
      };
    };
    const lrmStatus = await requestServiceHubJson<LrmStatus>(
      hubUrl,
      "/llm-router/v1/status",
      hubToken,
      { timeoutMs: HUB_FETCH_TIMEOUT_MS },
    );

    // Map inference servers to local entries
    const rawServers = lrmStatus.summary?.inference_servers ?? [];
    const local: LrmLocalModelEntry[] = rawServers.map((s) => ({
      role: s.role ?? "unknown",
      model_id: s.model_id,
      state: s.state ?? "unknown",
      port: s.port,
    }));

    // Fetch cloud model health (best-effort; may fail if not configured)
    type LrmCloudHealth = { provider?: string; model?: string; status?: string; latency_ms?: number; error?: string };
    let cloud: LrmCloudEntry = { status: "not_configured" };
    try {
      const cloudHealth = await requestServiceHubJson<LrmCloudHealth>(
        hubUrl,
        "/llm-router/v1/cloud/model/health",
        hubToken,
        { timeoutMs: HUB_FETCH_TIMEOUT_MS },
      );
      cloud = {
        provider: cloudHealth.provider,
        model: cloudHealth.model,
        status: cloudHealth.status ?? "unknown",
        latency_ms: cloudHealth.latency_ms,
        error: cloudHealth.error,
      };
    } catch {
      cloud = { status: "not_configured" };
    }

    // Fetch edge config (best-effort)
    type LrmEdgeConfig = {
      configured?: boolean;
      base_url?: string;
      model_name?: string;
      embedding_model_name?: string;
      bypass_proxy?: boolean;
    };
    let edge: LrmEdgeEntry = { configured: false, status: "not_configured" };
    try {
      const edgeConfig = await requestServiceHubJson<LrmEdgeConfig>(
        hubUrl,
        "/llm-router/v1/edge",
        hubToken,
        { timeoutMs: HUB_FETCH_TIMEOUT_MS },
      );
      edge = {
        configured: Boolean(edgeConfig.configured),
        base_url: edgeConfig.base_url,
        model_name: edgeConfig.model_name,
        embedding_model_name: edgeConfig.embedding_model_name,
        bypass_proxy: edgeConfig.bypass_proxy,
        status: edgeConfig.configured ? "ok" : "not_configured",
      };
    } catch {
      edge = { configured: false, status: "not_configured" };
    }

    return {
      reachable: true,
      version: lrmStatus.version,
      uptime_seconds: lrmStatus.uptime_seconds,
      routing_strategy: lrmStatus.summary?.system?.routing_strategy,
      local,
      cloud,
      edge,
    };
  } catch (err) {
    return {
      reachable: false,
      local: [],
      cloud: { status: "not_configured" },
      edge: { configured: false, status: "not_configured" },
      error: errorMessage(err),
    };
  }
}

/**
 * Fetch the OpenWork server runtime slice. Returns severity=unknown +
 * reachable=false when there's no server URL or token (not a failure - we just
 * haven't connected yet).
 */
async function fetchServerSide(
  baseUrl: string | null,
  auth: { token: string } | null,
  signal: AbortSignal,
): Promise<ServerSideView> {
  if (!baseUrl || !auth) {
    return {
      severity: "unknown",
      reachable: false,
      error: "Server not connected yet",
    };
  }
  const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const url = `${trimmed}/v1/runtime/status`;
  try {
    // Compose two abort signals: caller's cleanup + a short per-request timeout.
    const timeoutSignal = AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS);
    const composed: AbortSignal =
      typeof (AbortSignal as any).any === "function"
        ? (AbortSignal as any).any([signal, timeoutSignal])
        : timeoutSignal;
    const fetchImpl = resolveServiceHubFetch();
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/json",
      },
      signal: composed,
    });
    if (!res.ok) {
      return {
        severity: "down",
        reachable: false,
        error: `HTTP ${res.status} ${res.statusText}`.trim(),
      };
    }
    const raw = (await res.json()) as unknown;
    const slices = parseServerRuntimeSlices(raw);
    const slice: ServerSideView = {
      severity: "ok",
      reachable: true,
      slices,
    };
    slice.severity = computeServerSideSeverity(slice);
    return slice;
  } catch (err) {
    return {
      severity: "down",
      reachable: false,
      error: errorMessage(err),
    };
  }
}

export function useStatusDashboard(options: UseRuntimeStatusOptions): UseRuntimeStatusResult {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const enabled: Accessor<boolean> = options.enabled ?? (() => true);

  const [view, setView] = createSignal<SandboxStatusView>(makeInitialView(), {
    equals: sandboxStatusViewEquals,
  });
  const [isFetching, setIsFetching] = createSignal(false);
  // Separate signal for the last-successful-fetch timestamp. This updates on
  // every successful poll even when the equality check suppresses the view
  // signal, so the "Last updated" footer in SandboxStatusPanel stays fresh.
  const [lastUpdatedAt, setLastUpdatedAt] = createSignal(0);

  // Module-scoped controller for the most recent in-flight server fetch so
  // `refresh()` and cleanup can abort the previous one.
  let activeController: AbortController | null = null;
  // Guards against overlapping runs when refresh() is hammered.
  let inFlight = false;

  const runOnce = async () => {
    if (inFlight) return;
    inFlight = true;
    setIsFetching(true);

    if (activeController) {
      try {
        activeController.abort();
      } catch {
        // ignore - we only care that we're starting a fresh one
      }
    }
    const controller = new AbortController();
    activeController = controller;

    const baseUrl = options.serverBaseUrl();
    const auth = options.serverAuth();

    try {
      const [srvRes, hubRes, lrmRes, ocRes, readyRes] = await Promise.allSettled([
        fetchServerSide(baseUrl, auth, controller.signal),
        fetchHubServices(),
        fetchLrmModels(),
        fetchOpencodeSlice(baseUrl, auth, controller.signal),
        fetchAppReadiness(),
      ]);

      const serverSide: ServerSideView =
        srvRes.status === "fulfilled"
          ? srvRes.value
          : { severity: "down", reachable: false, error: errorMessage(srvRes.reason) };

      const hubServices = hubRes.status === "fulfilled" ? hubRes.value : undefined;
      const lrmModels = lrmRes.status === "fulfilled" ? lrmRes.value : undefined;
      const opencode = ocRes.status === "fulfilled" ? ocRes.value : undefined;
      const appReadiness = readyRes.status === "fulfilled" ? readyRes.value : undefined;

      // Derive sandboxManager view directly from hubServices — no extra request.
      const smEntry = hubServices?.services.find((s) => s.name === "sandbox_manager");
      const sandboxManager: SandboxManagerView = hubServices?.reachable
        ? (() => {
            const healthy = smEntry?.healthy ?? false;
            const slice: SandboxManagerView = {
              severity: healthy ? "ok" : smEntry ? "down" : "unknown",
              reachable: true,
              healthy,
              error: healthy ? undefined : "SandboxManager is not healthy",
            };
            return slice;
          })()
        : { severity: "down", reachable: false, error: hubServices?.error ?? "ServiceHub not reachable" };

       const anySuccess = serverSide.reachable || hubServices?.reachable || appReadiness?.reachable;
       const now = anySuccess ? Date.now() : lastUpdatedAt();
       if (anySuccess) setLastUpdatedAt(now);
        const next: SandboxStatusView = {
          severity: computeAppReadinessSeverity(appReadiness),
          summary: "",
          lastUpdatedAt: now,
          sandboxManager,
         serverSide,
         hubServices,
         lrmModels,
         opencode,
         appReadiness,
       };
       next.summary = summarizeSandboxStatus(next);
      setView(next);
    } finally {
      if (activeController === controller) {
        activeController = null;
      }
      inFlight = false;
      setIsFetching(false);
    }
  };

  const refresh = () => {
    void runOnce();
  };

  // Wire the timer. createEffect re-runs when `enabled()` flips; when it's
  // false we don't start a timer (and we don't clear the view, by design).
  createEffect(() => {
    if (!enabled()) return;

    // Immediate fetch on mount / re-enable - don't make the user wait one
    // full poll interval to see anything.
    void runOnce();

    const handle = window.setInterval(() => {
      void runOnce();
    }, pollIntervalMs);

    onCleanup(() => {
      window.clearInterval(handle);
    });
  });

  // Top-level cleanup: abort any in-flight server fetch when the owning
  // component tears down. The timer is cleaned up by the createEffect above.
  onCleanup(() => {
    if (activeController) {
      try {
        activeController.abort();
      } catch {
        // ignore
      }
      activeController = null;
    }
  });

  return {
    view,
    refresh,
    isFetching,
    lastUpdatedAt,
  };
}
