import { For, Show, createSignal } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import {
  Box,
  Brain,
  Cloud,
  Cpu,
  Loader2,
  RefreshCw,
  Server,
  Shield,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-solid";

import { t } from "../../i18n";
import Button from "./button";
import { createLlmRouterClient } from "../lib/llmrouter-client";
import { readOpenworkServerSettings } from "../lib/openwork-server";
import type {
  HubServiceEntry,
  LrmCloudEntry,
  LrmEdgeEntry,
  LrmLocalModelEntry,
  SandboxStatusView,
  SeverityLevel,
} from "../lib/status-view";

// =============================================================================
// Primitive helpers
// =============================================================================

type StatusTone = "green" | "amber" | "red" | "gray" | "blue";

function toneFromSeverity(severity: SeverityLevel): StatusTone {
  switch (severity) {
    case "ok": return "green";
    case "degraded": return "amber";
    case "down": return "red";
    default: return "gray";
  }
}

function toneFromBool(healthy: boolean | undefined): StatusTone {
  if (healthy === true) return "green";
  if (healthy === false) return "red";
  return "gray";
}

function toneFromState(state: string): StatusTone {
  switch (state) {
    case "running":
    case "ok":
    case "done":
      return "green";
    case "starting":
    case "pending":
      return "amber";
    case "error":
    case "stopped":
    case "failed":
      return "red";
    default:
      return "gray";
  }
}

function dotBg(tone: StatusTone): string {
  switch (tone) {
    case "green": return "bg-dls-success-dot";
    case "amber": return "bg-dls-warning-dot";
    case "red": return "bg-dls-danger-dot";
    case "blue": return "bg-dls-info-dot";
    default: return "bg-dls-status-neutral-dot";
  }
}

function chipCls(tone: StatusTone): string {
  switch (tone) {
    case "green": return "bg-dls-status-success-bg text-dls-status-success-text ring-1 ring-dls-success-border";
    case "amber": return "bg-dls-status-warning-bg text-dls-status-warning-text ring-1 ring-dls-warning-border";
    case "red": return "bg-dls-status-danger-bg text-dls-status-danger-text ring-1 ring-dls-danger-border";
    case "blue": return "bg-dls-status-info-bg text-dls-status-info-text ring-1 ring-dls-info-border";
    default: return "bg-dls-status-neutral-bg text-dls-status-neutral-badge-text ring-1 ring-dls-status-neutral-ring";
  }
}

function StatusDot(props: { tone: StatusTone; pulse?: boolean }): JSX.Element {
  return (
    <span class="relative inline-flex h-2 w-2 shrink-0">
      <Show when={props.pulse && (props.tone === "amber" || props.tone === "green")}>
        <span class={`absolute inline-flex h-full w-full animate-ping rounded-pill opacity-50 ${dotBg(props.tone)}`} />
      </Show>
      <span class={`relative inline-flex h-2 w-2 rounded-pill ${dotBg(props.tone)}`} />
    </span>
  );
}

function Chip(props: { tone: StatusTone; label: string }): JSX.Element {
  return (
    <span class={`inline-flex items-center rounded-pill px-2 py-0.5 text-tiny font-semibold uppercase tracking-wide ${chipCls(props.tone)}`}>
      {props.label}
    </span>
  );
}

function relativeTime(ts: number): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 0) return t("identities.just_now");
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return t("identities.just_now");
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** Format a ms epoch as HH:mm:ss for the "last checked" label. */
function formatCheckTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatUptime(seconds: number | undefined): string {
  if (seconds === undefined) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// =============================================================================
// Source tag — shows the API endpoint that backs a section
// =============================================================================

function SourceTag(props: { path: string; title?: string }): JSX.Element {
  return (
    <span
      class="ml-auto font-mono text-tiny text-dls-secondary/50 select-none cursor-default hover:text-dls-secondary transition-colors"
      title={props.title ?? props.path}
    >
      {props.path}
    </span>
  );
}

// =============================================================================
// Service name display helpers
// =============================================================================

// Only services whose name the fallback title-caser gets WRONG need an entry.
// `privacy_manager` -> "Privacy Manager" is already right, so it is absent on
// purpose; an acronym is not (`asr_manager` -> "Asr Manager").
const SERVICE_LABELS: Record<string, string> = {
  sandbox_manager: "Sandbox Manager",
  llmrouter_manager: "LLMRouter Manager",
  asr_manager: "ASR Manager",
  security: "Security",
  servicehub: "ServiceHub",
};

const SERVICE_ICONS: Record<string, () => JSX.Element> = {
  sandbox_manager: () => <Box size={14} />,
  llmrouter_manager: () => <Brain size={14} />,
  security: () => <Shield size={14} />,
};

function serviceLabel(name: string): string {
  return SERVICE_LABELS[name] ?? name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// =============================================================================
// Section: Service overview strip (horizontal cards, one per hub-managed service)
// =============================================================================

function ServiceOverviewStrip(props: { view: Accessor<SandboxStatusView> }): JSX.Element {
  const hub = () => props.view().hubServices;
  const services = () => hub()?.services ?? [];

  // Derive tone for each service entry
  const entryTone = (e: HubServiceEntry): StatusTone => {
    if (!hub()?.reachable) return "gray";
    return e.healthy ? "green" : e.state === "starting" ? "amber" : "red";
  };

  return (
    <div class="flex flex-col gap-2">
      {/* Section label */}
      <div class="flex items-center gap-1.5 px-0.5">
        <Server size={12} class="text-dls-secondary" />
        <span class="text-label font-semibold uppercase tracking-wider text-dls-secondary">Host Services</span>
        <Show when={hub()?.reachable !== undefined}>
          <Chip
            tone={hub()?.reachable ? (hub()?.healthy ? "green" : "amber") : "red"}
            label={hub()?.reachable ? (hub()?.healthy ? "All healthy" : "Degraded") : "Unreachable"}
          />
        </Show>
        <SourceTag path="GET /app/services/health" title="ServiceHub — aggregated health of all managed services" />
      </div>

      <Show
        when={hub()?.reachable && services().length > 0}
        fallback={
          <div class="rounded-inset border border-dls-border bg-dls-surface/50 px-4 py-3 text-caption text-dls-secondary">
            {hub()?.error ?? "ServiceHub not connected"}
          </div>
        }
      >
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <For each={services()}>
            {(entry) => {
              const tone = entryTone(entry);
              const IconComp = SERVICE_ICONS[entry.name];
              return (
                <div class={`relative overflow-hidden rounded-inset border px-4 py-3 transition-all ${
                  tone === "green" ? "border-dls-success-border bg-dls-status-success-bg" :
                  tone === "amber" ? "border-dls-warning-border bg-dls-status-warning-bg" :
                  tone === "red" ? "border-dls-danger-border bg-dls-status-danger-bg" :
                  "border-dls-border bg-dls-surface/50"
                }`}>
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-2 min-w-0">
                      <Show when={IconComp} fallback={<Server size={14} class="text-dls-secondary shrink-0" />}>
                        <span class="text-dls-secondary shrink-0"><IconComp /></span>
                      </Show>
                      <span class="truncate text-caption font-semibold text-dls-text">{serviceLabel(entry.name)}</span>
                    </div>
                    <StatusDot tone={tone} pulse={tone === "amber"} />
                  </div>
                  <div class="mt-2 flex items-center justify-between gap-2 text-label text-dls-secondary">
                    <span class="capitalize">{entry.state}</span>
                    <Show when={entry.port > 0}>
                      <span class="font-mono">:{entry.port}</span>
                    </Show>
                  </div>
                  <Show when={entry.failure_count > 0 || entry.restart_attempts > 0}>
                    <div class="mt-1.5 text-tiny text-dls-warning-text">
                      {entry.restart_attempts > 0 && `${entry.restart_attempts} restart${entry.restart_attempts > 1 ? "s" : ""}`}
                      {entry.failure_count > 0 && `, ${entry.failure_count} failure${entry.failure_count > 1 ? "s" : ""}`}
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

// =============================================================================
// TestResultRow — inline probe result shown after a manual Test trigger
// =============================================================================

type TestState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; status: string; latency_ms?: number; error?: string; note?: string; checkedAt: number };

function testTone(status: string): StatusTone {
  if (status === "ok") return "green";
  if (status === "error" || status === "connection_failed" || status === "authentication_failed" || status === "timeout") return "red";
  return "amber";
}

function TestResultRow(props: { state: TestState }): JSX.Element {
  return (
    <Show when={props.state.phase !== "idle"}>
      <div class={`mt-2 rounded-control border px-3 py-2 text-label ${
        props.state.phase === "running"
          ? "border-dls-border/60 bg-dls-surface/30"
          : props.state.phase === "done" && testTone(props.state.status) === "green"
            ? "border-dls-success-border bg-dls-status-success-bg"
            : props.state.phase === "done" && testTone(props.state.status) === "red"
              ? "border-dls-danger-border bg-dls-status-danger-bg"
              : "border-dls-warning-border bg-dls-status-warning-bg"
      }`}>
        <Show when={props.state.phase === "running"}>
          <div class="flex items-center gap-1.5 text-dls-secondary">
            <Loader2 size={11} class="animate-spin" />
            <span>Testing…</span>
          </div>
        </Show>
        <Show when={props.state.phase === "done"}>
          {(_) => {
            const s = props.state as Extract<TestState, { phase: "done" }>;
            const tone = testTone(s.status);
            return (
              <div class="flex flex-col gap-1">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-1.5">
                    <StatusDot tone={tone} />
                    <Chip tone={tone} label={s.status} />
                    <Show when={s.latency_ms !== undefined}>
                      <span class="font-mono text-dls-secondary">{s.latency_ms}ms</span>
                    </Show>
                  </div>
                  <span class="font-mono text-tiny text-dls-secondary/60">{formatCheckTime(s.checkedAt)}</span>
                </div>
                <Show when={s.note}>
                  <span class="text-dls-secondary">{s.note}</span>
                </Show>
                <Show when={s.error}>
                  <span class="text-dls-danger-text">{s.error}</span>
                </Show>
              </div>
            );
          }}
        </Show>
      </div>
    </Show>
  );
}

function TestButton(props: { running: boolean; onClick: () => void; title: string }): JSX.Element {
  return (
    <button
      type="button"
      class="ml-auto flex items-center gap-1 rounded-control border border-dls-border px-2 py-0.5 text-tiny font-medium text-dls-secondary transition-colors hover:border-dls-accent/40 hover:text-dls-accent disabled:cursor-not-allowed disabled:opacity-50"
      onClick={props.onClick}
      disabled={props.running}
      title={props.title}
    >
      <Show when={props.running} fallback={<Zap size={10} />}>
        <Loader2 size={10} class="animate-spin" />
      </Show>
      Test
    </button>
  );
}

// =============================================================================
// Section: LLMRouter detail (local / edge / cloud model breakdown)
// =============================================================================

function LrmModelSection(props: { view: Accessor<SandboxStatusView> }): JSX.Element {
  const lrm = () => props.view().lrmModels;

  const localTone = (s: LrmLocalModelEntry): StatusTone => toneFromState(s.state);
  const cloudTone = (c: LrmCloudEntry): StatusTone => {
    if (c.status === "not_configured") return "gray";
    if (c.status === "ok") return "green";
    return "red";
  };
  const edgeTone = (e: LrmEdgeEntry): StatusTone => {
    if (!e.configured) return "gray";
    if (e.status === "ok") return "green";
    if (e.status === "error") return "red";
    return "gray";
  };

  // Edge test state — the only manual probe that adds value beyond polling
  // (POST /edge/test actually sends a chat completion; GET /edge only reads config)
  const [edgeTest, setEdgeTest] = createSignal<TestState>({ phase: "idle" });

  function getHubCreds(): { hubUrl: string; hubToken: string } | null {
    const settings = readOpenworkServerSettings();
    const hubUrl = settings.hubUrl?.trim() ?? "";
    const hubToken = settings.hubToken?.trim() ?? "";
    if (!hubUrl || !hubToken) return null;
    return { hubUrl, hubToken };
  }

  async function runEdgeTest() {
    const creds = getHubCreds();
    if (!creds) return;
    setEdgeTest({ phase: "running" });
    try {
      const lrm = createLlmRouterClient({ baseUrl: creds.hubUrl, token: creds.hubToken });
      const result = await lrm.testEdge();
      setEdgeTest({ phase: "done", status: result.status ?? "unknown", latency_ms: result.latency_ms, error: result.error, note: result.note, checkedAt: Date.now() });
    } catch (e) {
      setEdgeTest({ phase: "done", status: "error", error: e instanceof Error ? e.message : String(e), checkedAt: Date.now() });
    }
  }

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-1.5 px-0.5">
        <Brain size={12} class="text-dls-secondary" />
        <span class="text-label font-semibold uppercase tracking-wider text-dls-secondary">LLMRouter</span>
        <SourceTag path="GET /llm-router/v1/status" title="LLMRouter Manager — service state, inference servers, routing strategy" />
      </div>

      <Show
        when={lrm()?.reachable}
        fallback={
          <div class="rounded-inset border border-dls-border bg-dls-surface/50 px-4 py-3 text-caption text-dls-secondary">
            {lrm()?.error ?? "LLM Router not reachable"}
          </div>
        }
      >
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {/* Local inference servers */}
          <div class="rounded-inset border border-dls-border bg-dls-surface/50 px-4 py-3">
            <div class="mb-2.5 flex items-center gap-1.5">
              <Cpu size={12} class="text-dls-secondary" />
              <span class="text-label font-semibold text-dls-text">Local</span>
              <SourceTag path="GET /llm-router/v1/status" />
            </div>
            <Show
              when={lrm()!.local.length > 0}
              fallback={<div class="text-label text-dls-secondary">No inference servers configured</div>}
            >
              <div class="flex flex-col gap-1.5">
                <For each={lrm()!.local}>
                  {(server) => (
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex items-center gap-1.5 min-w-0">
                        <StatusDot tone={localTone(server)} />
                        <span class="text-label font-mono truncate text-dls-text capitalize">{server.role}</span>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <Show when={server.port}>
                          <span class="text-tiny font-mono text-dls-secondary">:{server.port}</span>
                        </Show>
                        <Chip tone={localTone(server)} label={server.state} />
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={lrm()!.uptime_seconds !== undefined}>
              <div class="mt-2.5 border-t border-dls-border pt-2 text-tiny text-dls-secondary">
                Uptime: {formatUptime(lrm()!.uptime_seconds)}
              </div>
            </Show>
          </div>

          {/* Edge endpoint */}
          <div class="rounded-inset border border-dls-border bg-dls-surface/50 px-4 py-3">
            <div class="mb-2.5 flex items-center gap-1.5">
              <Wifi size={12} class="text-dls-secondary" />
              <span class="text-label font-semibold text-dls-text">Edge</span>
              <SourceTag path="GET /llm-router/v1/edge" />
            </div>
            <Show
              when={lrm()!.edge.configured}
              fallback={
                <div class="flex items-center gap-1.5">
                  <WifiOff size={11} class="text-dls-subtle" />
                  <span class="text-label text-dls-secondary">Not configured</span>
                </div>
              }
            >
              <div class="flex flex-col gap-2">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <StatusDot tone={edgeTone(lrm()!.edge)} />
                  <Chip tone={edgeTone(lrm()!.edge)} label={lrm()!.edge.status === "ok" ? "configured" : lrm()!.edge.status} />
                  <TestButton running={edgeTest().phase === "running"} onClick={() => void runEdgeTest()} title="POST /llm-router/v1/edge/test" />
                </div>
                <Show when={lrm()!.edge.base_url}>
                  <div class="flex items-start justify-between gap-2 text-label">
                    <span class="shrink-0 text-dls-secondary">URL</span>
                    <span class="font-mono text-tiny text-dls-text break-all text-right">{lrm()!.edge.base_url}</span>
                  </div>
                </Show>
                <Show when={lrm()!.edge.model_name}>
                  <div class="flex items-center justify-between gap-2 text-label">
                    <span class="shrink-0 text-dls-secondary">Chat</span>
                    <span class="font-mono text-tiny text-dls-text truncate max-w-[120px]" title={lrm()!.edge.model_name}>{lrm()!.edge.model_name}</span>
                  </div>
                </Show>
                <Show when={lrm()!.edge.embedding_model_name}>
                  <div class="flex items-center justify-between gap-2 text-label">
                    <span class="shrink-0 text-dls-secondary">Embedding</span>
                    <span class="font-mono text-tiny text-dls-text truncate max-w-[120px]" title={lrm()!.edge.embedding_model_name}>{lrm()!.edge.embedding_model_name}</span>
                  </div>
                </Show>
                <Show when={lrm()!.edge.error}>
                  <div class="text-tiny text-dls-danger-text">{lrm()!.edge.error}</div>
                </Show>
                <TestResultRow state={edgeTest()} />
              </div>
            </Show>
          </div>

          {/* Cloud provider */}
          <div class="rounded-inset border border-dls-border bg-dls-surface/50 px-4 py-3">
            <div class="mb-2.5 flex items-center gap-1.5">
              <Cloud size={12} class="text-dls-secondary" />
              <span class="text-label font-semibold text-dls-text">Cloud</span>
              <SourceTag path="GET /llm-router/v1/cloud/model/health" />
            </div>
            <Show
              when={lrm()!.cloud.status !== "not_configured"}
              fallback={
                <div class="flex items-center gap-1.5">
                  <span class="text-label text-dls-secondary">Not configured</span>
                </div>
              }
            >
              <div class="flex flex-col gap-1.5">
                <div class="flex items-center gap-1.5">
                  <StatusDot tone={cloudTone(lrm()!.cloud)} />
                  <Chip tone={cloudTone(lrm()!.cloud)} label={lrm()!.cloud.status === "ok" ? "connected" : lrm()!.cloud.status} />
                </div>
                <Show when={lrm()!.cloud.provider}>
                  <div class="flex items-center justify-between gap-1 text-label">
                    <span class="text-dls-secondary">Provider</span>
                    <span class="font-mono text-dls-text capitalize">{lrm()!.cloud.provider}</span>
                  </div>
                </Show>
                <Show when={lrm()!.cloud.model}>
                  <div class="flex items-center justify-between gap-1 text-label">
                    <span class="text-dls-secondary">Model</span>
                    <span class="font-mono text-tiny text-dls-text truncate max-w-[100px]">{lrm()!.cloud.model}</span>
                  </div>
                </Show>
                <Show when={lrm()!.cloud.latency_ms !== undefined}>
                  <div class="flex items-center justify-between gap-1 text-label">
                    <span class="text-dls-secondary">Latency</span>
                    <span class="font-mono text-dls-text">{lrm()!.cloud.latency_ms}ms</span>
                  </div>
                </Show>
                <Show when={lrm()!.cloud.error}>
                  <div class="mt-0.5 text-tiny text-dls-danger-text">{lrm()!.cloud.error}</div>
                </Show>
              </div>
            </Show>
          </div>
        </div>

        <Show when={lrm()?.routing_strategy}>
          <div class="flex items-center gap-2 px-1">
            <Zap size={11} class="text-dls-secondary" />
            <span class="text-label text-dls-secondary">Routing strategy:</span>
            <span class="text-label font-semibold text-dls-text capitalize">{lrm()!.routing_strategy}</span>
          </div>
        </Show>
      </Show>
    </div>
  );
}

// =============================================================================
// CopyTokenButton — copies the OWT Bearer token to clipboard
// =============================================================================

function CopyTokenButton(): JSX.Element {
  const [copied, setCopied] = createSignal(false);

  function copy() {
    const token = readOpenworkServerSettings().token;
    if (!token) return;
    navigator.clipboard.writeText(token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  const token = () => readOpenworkServerSettings().token;

  return (
    <Show when={token()}>
      <div class="flex items-center justify-between gap-2 text-label">
        <span class="text-dls-secondary">Token</span>
        <button
          type="button"
          class="flex items-center gap-1 rounded-control border border-dls-border px-2 py-0.5 text-tiny font-medium text-dls-secondary transition-colors hover:border-dls-accent/40 hover:text-dls-accent"
          onClick={copy}
        >
          <Show when={copied()} fallback={<>Copy</>}>
            <span class="text-dls-success-text">Copied</span>
          </Show>
        </button>
      </div>
    </Show>
  );
}

// =============================================================================
// AgentRuntimeCard — OpenCode direct API (health, version, MCP, config)
// =============================================================================

function AgentRuntimeCard(props: { view: Accessor<SandboxStatusView> }): JSX.Element {
  const oc = () => props.view().opencode;
  const ocTone = (): StatusTone => {
    if (!oc()?.reachable) return "gray";
    return oc()!.healthy ? "green" : "red";
  };

  const [copied, setCopied] = createSignal(false);

  function copyConfig() {
    const raw = oc()?.config?.raw;
    if (!raw) return;
    navigator.clipboard.writeText(JSON.stringify(raw, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  return (
    <Show
      when={oc()}
      fallback={<div class="text-label text-dls-secondary">Not reachable</div>}
    >
      {(_) => (
        <div class="flex flex-col gap-2">
          <Show when={oc()!.error}>
            <div class="text-tiny text-dls-danger-text">{oc()!.error}</div>
          </Show>

          {/* Row 0: Health dot */}
          <div class="flex items-center gap-1.5">
            <StatusDot tone={ocTone()} />
            <Chip tone={ocTone()} label={oc()!.healthy ? "Healthy" : (oc()!.reachable ? "Unhealthy" : "Unreachable")} />
          </div>

          {/* Row 1: OpenCode Version */}
          <div class="flex items-center justify-between gap-2 text-label">
            <span class="text-dls-secondary">Version</span>
            <Show
              when={oc()!.version}
              fallback={<span class="text-dls-secondary">—</span>}
            >
              <span class="font-mono text-dls-text">{oc()!.version}</span>
            </Show>
          </div>

          {/* Row 2: OpenCode Config */}
          <Show when={oc()!.config !== undefined}>
            <div class="flex items-center justify-between gap-2 text-label">
              <div class="flex items-center gap-1">
                <span class="text-dls-secondary">Runtime Config</span>
              </div>
              <button
                type="button"
                class="flex items-center gap-1 rounded-control border border-dls-border px-2 py-0.5 text-tiny font-medium text-dls-secondary transition-colors hover:border-dls-accent/40 hover:text-dls-accent"
                title="Source: GET /opencode/config"
                onClick={copyConfig}
              >
                <Show when={copied()} fallback={<>Copy</>}>
                  <span class="text-dls-success-text">Copied</span>
                </Show>
              </button>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}

// =============================================================================
// Section: Sandbox (container state + runtime components)
// =============================================================================

function SandboxSection(props: { view: Accessor<SandboxStatusView> }): JSX.Element {
  const sm = () => props.view().sandboxManager;
  const side = () => props.view().serverSide;
  const sl = () => side().slices;

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-1.5 px-0.5">
        <Box size={12} class="text-dls-secondary" />
        <span class="text-label font-semibold uppercase tracking-wider text-dls-secondary">Sandbox</span>
      </div>

      {/* Container control-plane */}
      <Show
        when={sm().reachable}
        fallback={
          <div class="rounded-inset border border-dls-danger-border bg-dls-danger-bg px-4 py-3 text-caption text-dls-danger-text">
            {sm().error ?? "Sandbox control plane is not reachable"}
          </div>
        }
      >
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {/* OpenWork Server card */}
          <div class="rounded-inset border border-dls-border bg-dls-surface/50 px-4 py-3">
            <div class="mb-2 flex items-center gap-1.5">
              <Server size={11} class="text-dls-secondary" />
              <span class="text-label font-semibold text-dls-text">OpenWork Server</span>
              <SourceTag path="GET /v1/runtime/status" title="OpenWork Server — server health" />
            </div>
            <Show
              when={side().reachable}
              fallback={
                <div class="text-label text-dls-danger-text">
                  {side().error ?? "Unreachable"}
                </div>
              }
            >
              <Show when={sl()}>
                {(slices) => (
                  <div class="flex flex-col gap-1.5">
                    <div class="flex items-center gap-1.5">
                      <StatusDot tone={toneFromBool(slices().server.healthy)} />
                      <Chip tone={toneFromBool(slices().server.healthy)} label={slices().server.healthy ? "Healthy" : "Down"} />
                    </div>
                    <Show when={slices().server.uptime_seconds !== undefined}>
                      <div class="flex items-center justify-between gap-2 text-label">
                        <span class="text-dls-secondary">Server Uptime</span>
                        <span class="font-mono text-dls-text">{formatUptime(slices().server.uptime_seconds)}</span>
                      </div>
                    </Show>
                    {(() => {
                      const url = readOpenworkServerSettings().urlOverride;
                      return url ? (
                        <div class="flex items-center justify-between gap-2 text-label">
                          <span class="text-dls-secondary">Server URL</span>
                          <span class="font-mono text-tiny text-dls-text">{url}</span>
                        </div>
                      ) : null;
                    })()}
                    <CopyTokenButton />
                    <Show when={slices().server.error}>
                      <div class="text-tiny text-dls-danger-text">{slices().server.error}</div>
                    </Show>
                  </div>
                )}
              </Show>
            </Show>
          </div>

          {/* Agent Runtime card — OpenCode direct API */}
          <div class="rounded-inset border border-dls-border bg-dls-surface/50 px-4 py-3">
            <div class="mb-2 flex items-center gap-1.5">
              <Brain size={11} class="text-dls-secondary" />
              <span class="text-label font-semibold text-dls-text">Agent Runtime · OpenCode</span>
              <SourceTag path="GET /opencode/global/health" title="Proxied OpenCode server endpoint" />
            </div>
            <AgentRuntimeCard view={props.view} />
          </div>

          {/* Channels card — OpenCode Router + channel badges */}
          <div class="rounded-inset border border-dls-border bg-dls-surface/50 px-4 py-3">
            <div class="mb-2 flex items-center gap-1.5">
              <Zap size={11} class="text-dls-secondary" />
              <span class="text-label font-semibold text-dls-text">Channels · OpenCode Router</span>
              <SourceTag path="GET /v1/runtime/status" title="OpenWork Server — opencode_router health, channel states" />
            </div>
            <Show
              when={side().reachable && sl()}
              fallback={<div class="text-label text-dls-secondary">Not reachable</div>}
            >
              {(_) => {
                const router = () => sl()!.opencode_router;
                const routerTone = (): StatusTone => router().healthy ? "green" : "red";
                const channels = () => router().channels;
                return (
                  <div class="flex flex-col gap-1.5">
                    <div class="flex items-center gap-1.5">
                      <StatusDot tone={routerTone()} />
                      <Chip tone={routerTone()} label={router().healthy ? "Healthy" : "Down"} />
                    </div>
                    <Show when={channels()}>
                      {(ch) => (
                        <div class="flex flex-col gap-1.5">
                          <div class="flex flex-wrap gap-1">
                            <div class={`flex items-center gap-1 rounded-control px-2 py-0.5 text-tiny font-medium ${ch().telegram ? "bg-dls-status-info-bg text-dls-status-info-text" : "bg-dls-status-neutral-bg text-dls-status-neutral-badge-text"}`}>
                              <span class={`h-1.5 w-1.5 rounded-pill ${ch().telegram ? "bg-dls-info-dot" : "bg-dls-neutral-dot"}`} />
                              Telegram
                            </div>
                            <div class={`flex items-center gap-1 rounded-control px-2 py-0.5 text-tiny font-medium ${ch().whatsapp ? "bg-dls-status-success-bg text-dls-status-success-text" : "bg-dls-status-neutral-bg text-dls-status-neutral-badge-text"}`}>
                              <span class={`h-1.5 w-1.5 rounded-pill ${ch().whatsapp ? "bg-dls-success-dot" : "bg-dls-neutral-dot"}`} />
                              WhatsApp
                            </div>
                            <div class={`flex items-center gap-1 rounded-control px-2 py-0.5 text-tiny font-medium ${ch().slack ? "bg-dls-status-warning-bg text-dls-status-warning-text" : "bg-dls-status-neutral-bg text-dls-status-neutral-badge-text"}`}>
                              <span class={`h-1.5 w-1.5 rounded-pill ${ch().slack ? "bg-dls-warning-dot" : "bg-dls-neutral-dot"}`} />
                              Slack
                            </div>
                          </div>
                        </div>
                      )}
                    </Show>
                    <Show when={router().activity?.lastMessageAt}>
                      <div class="text-tiny text-dls-secondary">
                        Last msg: {relativeTime(router().activity!.lastMessageAt!)}
                      </div>
                    </Show>
                  </div>
                );
              }}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

// =============================================================================
// Panel content (the full dashboard — replaces the old SandboxStatusContent)
// =============================================================================

export interface SandboxStatusContentProps {
  view: Accessor<SandboxStatusView>;
  onRefresh?: () => void;
  isFetching?: Accessor<boolean>;
  lastUpdatedAt?: Accessor<number>;
}

export function SandboxStatusContent(props: SandboxStatusContentProps): JSX.Element {
  const severity = () => props.view().severity;

  return (
    <div class="flex flex-1 flex-col overflow-hidden">
      {/* Dashboard header */}
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-dls-border bg-dls-surface/80 px-5 py-3">
        <div class="flex items-center gap-2.5">
          <div>
            <div class="text-body-lg font-semibold text-dls-text">Status Dashboard</div>
            <div class="text-label text-dls-secondary">{props.view().summary}</div>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <div class="flex items-center gap-1.5 text-label text-dls-secondary">
            <Show
              when={props.isFetching?.()}
              fallback={
                <span>
                  Last checked:{" "}
                  <span class="font-mono">
                    {formatCheckTime(props.lastUpdatedAt?.() ?? props.view().lastUpdatedAt)}
                  </span>
                </span>
              }
            >
              <Loader2 size={12} class="animate-spin" />
              <span>Checking…</span>
            </Show>
          </div>
          <Show when={props.onRefresh}>
            <button
              type="button"
              class={`flex items-center gap-1.5 rounded-control border border-dls-border px-2.5 py-1.5 text-label font-medium text-dls-text transition-all hover:bg-dls-hover active:bg-dls-active disabled:cursor-not-allowed disabled:opacity-50 ${props.isFetching?.() ? "opacity-60" : ""}`}
              onClick={() => props.onRefresh?.()}
              disabled={props.isFetching?.() ?? false}
              title="Refresh now"
            >
              <RefreshCw size={12} class={props.isFetching?.() ? "animate-spin" : ""} />
              Refresh
            </button>
          </Show>
        </div>
      </div>

      {/* Scrollable dashboard body */}
      <div class="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
        {/* Row 1: Host Services overview strip */}
        <ServiceOverviewStrip view={props.view} />

        {/* Row 2: LLM Router model breakdown */}
        <div class="border-t border-dls-border/50 pt-5">
          <LrmModelSection view={props.view} />
        </div>

        {/* Row 3: Sandbox (container + runtime) */}
        <div class="border-t border-dls-border/50 pt-5">
          <SandboxSection view={props.view} />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Panel (standalone modal wrapper — kept for backward compat)
// =============================================================================

export interface SandboxStatusPanelProps {
  view: Accessor<SandboxStatusView>;
  open: Accessor<boolean>;
  onClose: () => void;
  onRefresh?: () => void;
  isFetching?: Accessor<boolean>;
  lastUpdatedAt?: Accessor<number>;
}

export function SandboxStatusPanel(props: SandboxStatusPanelProps): JSX.Element {
  return (
    <Show when={props.open()}>
      <div
        class="fixed inset-0 z-50 dls-modal-backdrop flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Status dashboard"
        onClick={(event) => {
          if (event.currentTarget === event.target) props.onClose();
        }}
      >
        <div class="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden border dls-modal-surface">
          <SandboxStatusContent
            view={props.view}
            onRefresh={props.onRefresh}
            isFetching={props.isFetching}
            lastUpdatedAt={props.lastUpdatedAt}
          />
          <div class="flex justify-end border-t border-dls-border px-5 py-3">
            <Button
              variant="primary"
              class="px-3 py-1.5 text-caption"
              onClick={() => props.onClose()}
            >
              Close
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}

export default SandboxStatusPanel;
