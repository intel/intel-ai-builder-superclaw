/**
 * SandboxStatusView - the visibility shape the SuperClaw app shows the user.
 *
 * The one-month ship plan (docs/plan/2026-05-14_one_month_ship_plan.md, Week 3
 * "make the product legible") asks for one coherent surface that can answer:
 * what is connected, what is ready, what failed, and what the user can do next.
 *
 * This file defines the shape `useStatusDashboard` produces and `<StatusBanner>`
 * + `<SandboxStatusPanel>` consume. The v1.1 panel is a Sandbox status surface
 * fed by two data sources:
 *
 *   1. `host/sandbox_manager` (via ServiceHub). Source of lightweight sandbox
 *      control-plane truth: service state, version, and sandbox flow summary.
 *   2. `sandbox/server` via `GET /v1/runtime/status`. Source of sandbox
 *      data-plane component truth: OpenWork, Channels, and the Router-observed
 *      Agent Runtime health signal.
 *
 * Bridge-mode note: this file ships a typed direct view that stitches the two
 * sources above. The longer-term target is the wire-schema spine in
 * `shared/contracts/` (`runtime-status`); when more consumers land, collapse
 * `ServerRuntimeSlices` onto that shape and remove
 * this file.
 */

/** Aggregate severity for the dashboard header/banner. */
export type SeverityLevel = "ok" | "degraded" | "down" | "unknown";

/** Anything the user-visible surface needs in one place. */
export interface SandboxStatusView {
  /** Composite, derived from the authoritative product-readiness projection. */
  severity: SeverityLevel;
  /** One-line summary suitable for a banner. */
  summary: string;
  /** ms epoch of the last successful fetch (either source). 0 if never fetched. */
  lastUpdatedAt: number;
  /** Sandbox control-plane slice (sandbox, ops). */
  sandboxManager: SandboxManagerView;
  /** Sandbox data-plane slice (OpenWork / Channels / Agent Runtime hints). */
  serverSide: ServerSideView;
  /** Authoritative product readiness; drives `severity`. */
  appReadiness?: AppReadinessView;
  /**
   * OpenCode engine slice — health, version, MCP, config.
   * Fetched directly via /opencode/* proxy on the OpenWork server.
   */
  opencode?: OpencodeView;
  /**
   * Full ServiceHub services health — all hub-managed services, not just sandbox_manager.
   * Present when ServiceHub is reachable.
   */
  hubServices?: HubServicesView;
  /**
   * LLMRouter model breakdown — local / edge / cloud model states from the host LRM.
   * Present when LRM is reachable via ServiceHub proxy.
   */
  lrmModels?: LrmModelsView;
}

// =============================================================================
// ServiceHub all-services slice
// =============================================================================

/** One entry in the ServiceHub services table. */
export interface HubServiceEntry {
  name: string;
  proxy_prefix: string;
  port: number;
  state: string;
  healthy: boolean;
  failure_count: number;
  restart_attempts: number;
  instance_id: string | null;
}

/** All hub-managed services from /app/services/health. */
export interface HubServicesView {
  /** True when ServiceHub itself was reachable. */
  reachable: boolean;
  /** Whether the ServiceHub reports overall healthy. */
  healthy: boolean;
  /** Individual service entries. */
  services: HubServiceEntry[];
  error?: string;
}

/**
 * Compute severity for the ServiceHub all-services snapshot.
 *
 * Rules:
 *   - not reachable -> down
 *   - overall unhealthy -> degraded
 *   - reachable + healthy -> ok
 */
export function computeHubServicesSeverity(view: HubServicesView | undefined): SeverityLevel {
  if (!view) return "unknown";
  if (!view.reachable) return "down";
  if (!view.healthy) return "degraded";
  return "ok";
}

/**
 * The authoritative product-readiness slice, from `GET /app/readiness`.
 *
 * `reachable: false` means ServiceHub could not be asked, which is distinct from
 * ServiceHub answering that the product is not ready.
 */
export interface AppReadinessView {
  reachable: boolean;
  /** Top-level state from the readiness document. Undefined when unreachable. */
  state?: "ready" | "starting" | "failed" | "unknown";
  /** Required components that are not `ready`, for the summary line. */
  blockers: string[];
  error?: string;
}

/**
 * Compute the top-level severity from the readiness projection.
 *
 * Replaces deriving the headline from host-service health alone, which reported
 * `ok` whenever the child processes were running -- even with the sandbox
 * container down or OpenCode wedged.
 *
 * `starting` is `degraded`, not `down`: mid-boot the product really is not
 * serving, but a hard failure would be wrong.
 */
export function computeAppReadinessSeverity(view: AppReadinessView | undefined): SeverityLevel {
  if (!view || !view.reachable || !view.state) return "unknown";
  switch (view.state) {
    case "ready":
      return "ok";
    case "starting":
      return "degraded";
    case "failed":
      return "down";
    default:
      return "unknown";
  }
}

// =============================================================================
// LLMRouter model breakdown slice
// =============================================================================

/** State of a single local model / llama-server role. */
export interface LrmLocalModelEntry {
  /** Role identifier (e.g. "chat", "embed"). */
  role: string;
  /** Model identifier or path. */
  model_id?: string;
  /** Process state: "running" | "stopped" | "starting" | "error" | "not_configured". */
  state: string;
  /** Port the inference server is bound to, if running. */
  port?: number;
}

/** Summary of the cloud provider connection. */
export interface LrmCloudEntry {
  /** Provider name (e.g. "openai", "anthropic"). */
  provider?: string;
  /** Model id selected for cloud routing. */
  model?: string;
  /** "ok" | "error" | "not_configured". */
  status: string;
  latency_ms?: number;
  error?: string;
}

/** Summary of the edge model endpoint. */
export interface LrmEdgeEntry {
  /** Whether an edge endpoint is configured. */
  configured: boolean;
  /** Raw base URL of the edge server (e.g. "http://192.0.2.10:4001"). */
  base_url?: string;
  /** Chat/completion model name served by this edge endpoint. */
  model_name?: string;
  /** Embedding model name served by this edge endpoint. */
  embedding_model_name?: string;
  /** When true, requests go directly to the edge server bypassing the ServiceHub proxy. */
  bypass_proxy?: boolean;
  /** "ok" | "error" | "not_configured". */
  status: string;
  error?: string;
}

/** Aggregated LRM model-layer view. */
export interface LrmModelsView {
  reachable: boolean;
  /** LRM service version. */
  version?: string;
  /** LRM process uptime in seconds. */
  uptime_seconds?: number;
  /** Current routing strategy: "auto" | "local-only" | "cloud-only". */
  routing_strategy?: string;
  /** Local inference server states. */
  local: LrmLocalModelEntry[];
  /** Cloud provider state. */
  cloud: LrmCloudEntry;
  /** Edge endpoint state. */
  edge: LrmEdgeEntry;
  error?: string;
}

// =============================================================================
// OpenCode engine slice (via /opencode/* proxy)
// =============================================================================

/** One MCP server entry from GET /opencode/mcp. */
export interface OpencodeMcpEntry {
  name: string;
  /** "running" | "starting" | "error" | "stopped" or any string the server emits. */
  state: string;
  error?: string;
}

/** Subset of OpenCode config that is useful for dashboard display. */
export interface OpencodeConfigSummary {
  /** Raw config object — shown in an expandable viewer. */
  raw: Record<string, unknown>;
}

/** OpenCode engine health + capabilities fetched directly via proxied API. */
export interface OpencodeView {
  reachable: boolean;
  /** From GET /opencode/global/health */
  healthy?: boolean;
  version?: string;
  /** From GET /opencode/mcp */
  mcp?: OpencodeMcpEntry[];
  /** From GET /opencode/config */
  config?: OpencodeConfigSummary;
  error?: string;
}

// =============================================================================
// Sandbox-manager control-plane slice
// =============================================================================

export interface SandboxManagerView {
  severity: SeverityLevel;
  /** True if the most recent Tauri command call returned a parsed snapshot. */
  reachable: boolean;
  /** Raw ServiceHub /app/services/health signal for sandbox_manager. */
  healthy?: boolean;
  /** Error message if the Tauri command failed. */
  error?: string;
}

// =============================================================================
// Server-side slice (from /v1/runtime/status)
// =============================================================================

export interface ServerSideView {
  severity: SeverityLevel;
  /** True if the openwork-server `/v1/runtime/status` returned 200. */
  reachable: boolean;
  slices?: ServerRuntimeSlices;
  /** Error message if the HTTP fetch failed or returned non-200. */
  error?: string;
}

/**
 * Shape of `sandbox/server` `GET /v1/runtime/status`. The server probes each
 * sidecar with a short timeout and folds the result into per-section blobs.
 */
export interface ServerRuntimeSlices {
  /** openwork-server's own state. */
  server: {
    healthy: boolean;
    uptime_seconds?: number;
    version?: string;
    error?: string;
  };
  /**
   * LLMRouter routing summary.
   *
   * OPTIONAL and no longer probed by the container: LLM routing runs on the
   * Windows host as the ServiceHub-managed `llmrouter_manager`, and its health
   * is sourced host-side in `use-status-dashboard.ts`. This
   * field is retained only so older server responses (which still emit it)
   * parse; the container's `/v1/runtime/status` no longer includes it.
   */
  llmrouter?: {
    healthy: boolean;
    /** Router strategy name (e.g. "auto", "local-only", "cloud-only"). */
    strategy?: string;
    /** Configured model keys from /v1/models. */
    models?: ModelRouteSummary[];
    /** Whether the PII detector sidecar is wired into the router. */
    pii_enabled?: boolean;
    error?: string;
  };
  /**
   * The connected EDGE model endpoint (LOCAL_LLM_API_BASE), when it is not a
   * loopback host. `configured:false` means no edge is connected (the bundled
   * host workers are the model). When configured, the panel points the model
   * health at this endpoint — `healthy:false` + `status` (e.g. 403) lights red.
   */
  edge_model?: {
    configured: boolean;
    endpoint?: string;
    healthy?: boolean;
    status?: number;
    models?: string[];
    error?: string;
  };
  /** sandbox/channels (/health). */
  opencode_router: {
    healthy: boolean;
    opencode_healthy?: boolean;
    channels?: { telegram: boolean; whatsapp: boolean; slack: boolean };
    activity?: {
      inboundToday?: number;
      outboundToday?: number;
      lastMessageAt?: number;
    };
    error?: string;
  };
}

/**
 * One row in `llmrouter.models[]`. The "provider" field distinguishes local
 * (e.g. `"local"`) from cloud routes; the UI uses that to render a local/cloud
 * badge so a user can trust whether work stayed local.
 */
export interface ModelRouteSummary {
  /** Key under which the model is registered with llmrouter. */
  key: string;
  /** Provider tag (e.g. "local", "openai", "anthropic", "auto"). */
  provider: string;
  /** Display name if available. */
  label?: string;
}

// =============================================================================
// Derivation helpers
// =============================================================================

/**
 * Worst-of-many: returns the most-severe level from the inputs. Order:
 *   unknown < ok < degraded < down
 *
 * `unknown` ranks below `ok` because the absence of information is not the same
 * as a confirmed failure: a section that hasn't reported yet shouldn't pull the
 * banner red. A section that confirmed it's down should.
 */
export function worstSeverity(levels: SeverityLevel[]): SeverityLevel {
  const rank: Record<SeverityLevel, number> = {
    unknown: 0,
    ok: 1,
    degraded: 2,
    down: 3,
  };
  return levels.reduce<SeverityLevel>((acc, l) => (rank[l] > rank[acc] ? l : acc), "unknown");
}

/** True when severity is one the banner should surface to the user. */
export function shouldBannerShow(severity: SeverityLevel): boolean {
  return severity === "degraded" || severity === "down";
}

/** Color/label hint for the navbar pill (consumer maps to its own tokens). */
export function pillTone(severity: SeverityLevel): "green" | "amber" | "red" | "gray" {
  switch (severity) {
    case "ok":
      return "green";
    case "degraded":
      return "amber";
    case "down":
      return "red";
    default:
      return "gray";
  }
}

/**
 * Compute severity for the server-side probe slice.
 * Sidecar probes are independent: any unhealthy probe degrades the surface.
 */
export function computeServerSideSeverity(view: ServerSideView): SeverityLevel {
  if (!view.reachable) return "down";
  const sl = view.slices;
  if (!sl) return "unknown";

  if (!sl.server.healthy) return "down";
  // LLMRouter is not part of the container-side severity: its health is sourced
  // host-side from ServiceHub (see use-status-dashboard.ts).
  const sidecars = [sl.opencode_router.healthy];
  if (sidecars.some((h) => h === false)) return "degraded";
  // A connected edge whose endpoint is failing (e.g. 403) is a degraded model path.
  if (sl.edge_model?.configured && sl.edge_model.healthy === false) return "degraded";
  return "ok";
}

/**
 * Single-line summary for the banner.
 *
 * Top-level severity is ServiceHub-driven, so host-service failures surface
 * first. Once host services are healthy, this banner stays on the aggregate
 * state instead of surfacing per-slice sandbox progress.
 */
export function summarizeSandboxStatus(view: SandboxStatusView): string {
  const hub = view.hubServices;
  if (hub) {
    if (!hub.reachable) {
      return hub.error ? `ServiceHub unreachable: ${hub.error}` : "ServiceHub unreachable.";
    }
    if (!hub.healthy) {
      const unhealthy = hub.services.filter((service) => !service.healthy);
      if (unhealthy.length > 0) {
        const names = unhealthy.map((service) => service.name.replace(/_/g, " ")).join(", ");
        return `Host services degraded: ${names}.`;
      }
      return "Host services degraded.";
    }
    return "All services healthy.";
  }
  if (!view.sandboxManager.reachable) {
    return view.sandboxManager.error
      ? `Control plane unreachable: ${view.sandboxManager.error}`
      : "Control plane unreachable. Restart the app to retry.";
  }
  if (!view.serverSide.reachable) {
    return view.serverSide.error
      ? `OpenWork server unreachable: ${view.serverSide.error}`
      : "OpenWork server unreachable.";
  }
  const sl = view.serverSide.slices;
  if (sl) {
    if (!sl.opencode_router.healthy) {
      return sl.opencode_router.error
        ? `Channels unavailable: ${sl.opencode_router.error}`
        : "Channels unavailable.";
    }
    if (sl.opencode_router.opencode_healthy === false) {
      return "Agent Runtime degraded: OpenCode is unhealthy.";
    }
  }
  if (view.severity === "ok") return "All services healthy.";
  if (
    view.sandboxManager.reachable &&
    view.sandboxManager.severity !== "ok" &&
    view.sandboxManager.error
  ) {
    return `Control plane: ${view.sandboxManager.error}`;
  }
  return "Gathering status…";
}

/** Tells the UI whether a model row should be rendered as the local path or a cloud path. */
export function isLocalProvider(provider: string): boolean {
  return provider.toLowerCase() === "local";
}
