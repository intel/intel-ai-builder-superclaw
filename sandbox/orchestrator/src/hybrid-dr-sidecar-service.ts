import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { get as httpGet } from "node:http";

export type HybridDrSidecarStatus = "stopped" | "starting" | "running" | "unhealthy" | "restarting" | "error";

export interface HybridDrSidecarLogger {
  info: (message: string, attributes?: Record<string, unknown>, component?: string) => void;
  warn: (message: string, attributes?: Record<string, unknown>, component?: string) => void;
}

export interface HybridDrSidecarServiceOptions {
  binaryBin?: string;
  pythonBin?: string;
  module?: string;
  host: string;
  port: number;
  logger: HybridDrSidecarLogger;
  prefixStream?: (
    stream: NodeJS.ReadableStream | null,
    label: string,
    level: "stdout" | "stderr",
    logger: HybridDrSidecarLogger,
    pid?: number,
  ) => void;
  spawnProcess?: (command: string, args: string[], options?: SpawnOptions) => ChildProcess;
}

export interface HybridDrSidecarStatusInfo {
  status: HybridDrSidecarStatus;
  pid?: number;
  host: string;
  port: number;
  uptime?: number;
  restartCount: number;
}

const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
// After this many CONSECUTIVE failed (re)starts without ever reaching healthy,
// stop trying: the failure is structural (binary missing/unrunnable — e.g. a
// native-mode host without the sidecar payload), and an endless restart loop
// only floods the boot log. The service is degraded-optional by design; a
// manual restart() or the control server can always re-arm it.
const MAX_CONSECUTIVE_FAILED_STARTS = RESTART_BACKOFF_MS.length;
const HEALTH_FAILURES_BEFORE_RESTART = 3;

// Managed /readyz allows 8s for reader/cleanup, Connector, LRM and file work.
// Match Sandbox Manager's _HDR_READY_TIMEOUT_S: 2s extra for transport.
export const MANAGED_HDR_READY_TIMEOUT_MS = 10_000;

function defaultSpawnProcess(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (process.platform === "win32") return spawn(command, args, { ...options, windowsHide: true });
  return spawn(command, args, options);
}

function connectHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

export function probeHybridDrHealth(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    // egress-surface: supervisor_health_hdr
    const request = httpGet(
      url,
      {
        agent: false,
        headers: { ...headers, Connection: "close" },
      },
      (response) => {
        request.setTimeout(0);
        response.resume();
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) finish();
        else finish(new Error(`HTTP ${status}`));
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`health probe timed out after ${timeoutMs}ms`));
    });
    request.once("error", (error) => finish(error));
  });
}

// Managed readiness is a proof, unlike the legacy status-only /healthz probe.
export function probeManagedHybridDrReadiness(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ReturnType<typeof httpGet> | undefined;
    const finish = (ready = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      if (ready) resolve();
      else reject(new Error("Managed HDR readiness probe failed"));
    };
    // Socket inactivity timeouts do not bound a trickling body.
    const timer = setTimeout(() => finish(), timeoutMs);
    try {
      // egress-surface: supervisor_health_hdr
      request = httpGet(url, {
        agent: false,
        headers: { ...headers, Connection: "close" },
      }, (response) => {
        response.once("error", () => finish());
        response.once("aborted", () => finish());
        if (response.statusCode !== 200) {
          finish();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > 4096) {
            finish();
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          if (settled) return;
          try {
            const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
            finish(typeof value === "object" && value !== null && !Array.isArray(value)
              && Object.keys(value).length === 2
              && "status" in value && value.status === "ready"
              && "mode" in value && value.mode === "native_managed");
          } catch {
            finish();
          }
        });
      });
      request.once("error", () => finish());
    } catch {
      // Never surface URLs, bearer tokens, raw bodies or transport errors.
      finish();
    }
  });
}

export async function waitForHybridDrHealth(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not checked";
  while (Date.now() < deadline) {
    try {
      await probeHybridDrHealth(url, Math.min(2_000, Math.max(1, deadline - Date.now())), headers);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Hybrid DR sidecar health: ${lastError}`);
}

// Observation only: no process handle, spawn, restart or independent startup deadline.
// Activated by final Profile proof after the owner's Runtime becomes available.
export class ExternalHybridDrHealthObserver {
  private healthyUntil = 0;
  private activated = false;
  private pending: Promise<boolean> | undefined;

  constructor(
    private readonly probe: () => Promise<boolean>,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): boolean {
    if (this.now() < this.healthyUntil) return true;
    if (this.activated) void this.refresh();
    return false;
  }

  refresh(): Promise<boolean> {
    this.activated = true;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const healthy = await this.probe();
        this.healthyUntil = healthy ? this.now() + 5_000 : 0;
        return healthy;
      } catch {
        this.healthyUntil = 0;
        return false;
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }

  // Startup waits for HDR; everything else, status polling included, takes a single look.
  observe(untilReady: boolean | undefined, isStopping: () => boolean): Promise<boolean> {
    return untilReady ? this.waitUntilHealthy(isStopping) : this.refresh();
  }

  // Sandbox Manager starts HDR together with Runtime, so HDR can still be coming up when the rest of
  // the startup proof is in. It owns HDR's deadline and stops every role if that lapses, so this wait
  // sets none of its own: it gives way only once this supervisor has begun shutting down.
  async waitUntilHealthy(isStopping: () => boolean, pollMs = 500): Promise<boolean> {
    while (!isStopping()) {
      if (await this.refresh()) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    }
    return false;
  }
}

export class HybridDrSidecarService {
  private readonly binaryBin?: string;
  private readonly pythonBin: string;
  private readonly module: string;
  private readonly host: string;
  private readonly port: number;
  private readonly logger: HybridDrSidecarLogger;
  private readonly prefixStream?: HybridDrSidecarServiceOptions["prefixStream"];
  private readonly spawnProcess: (command: string, args: string[], options?: SpawnOptions) => ChildProcess;
  private child: ChildProcess | null = null;
  private status: HybridDrSidecarStatus = "stopped";
  private startedAt: number | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartCount = 0;
  private consecutiveHealthFailures = 0;
  private intentionalStop = false;

  constructor(options: HybridDrSidecarServiceOptions) {
    this.binaryBin = options.binaryBin ?? process.env.HYBRID_DR_BIN;
    this.pythonBin = options.pythonBin ?? process.env.HYBRID_DR_PYTHON_BIN ?? "/opt/hybrid-dr-venv/bin/python";
    this.module = options.module ?? process.env.HYBRID_DR_MODULE ?? "hybrid_dr_orchestrator.api.serve:make_app";
    this.host = options.host;
    this.port = options.port;
    this.logger = options.logger;
    this.prefixStream = options.prefixStream;
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  }

  async start(): Promise<void> {
    if (this.status === "running" || this.status === "starting" || this.status === "restarting") {
      this.logger.warn("Hybrid DR sidecar already running/starting, ignoring start()", {}, "hybrid-dr");
      return;
    }
    await this.startOnce();
  }

  async stop(): Promise<void> {
    this.intentionalStop = true;
    this.clearRestartTimer();
    this.stopHealthLoop();
    const child = this.child;
    this.status = "stopped";
    this.startedAt = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* ignore */ }
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      });
    }
    this.child = null;
    this.logger.info("Stopped", {}, "hybrid-dr");
  }

  async restart(): Promise<void> {
    this.logger.info("Restarting", {}, "hybrid-dr");
    await this.stop();
    this.intentionalStop = false;
    this.restartCount = 0;
    await this.startOnce();
  }

  detach(): void {
    this.stopHealthLoop();
    this.clearRestartTimer();
    this.child = null;
    this.status = "stopped";
    this.startedAt = null;
    this.intentionalStop = true;
  }

  getStatus(): HybridDrSidecarStatusInfo {
    return {
      status: this.status,
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      host: this.host,
      port: this.port,
      ...(this.startedAt ? { uptime: Math.floor((Date.now() - this.startedAt) / 1000) } : {}),
      restartCount: this.restartCount,
    };
  }

  private async startOnce(): Promise<void> {
    this.clearRestartTimer();
    this.stopHealthLoop();
    this.intentionalStop = false;
    this.status = "starting";
    this.consecutiveHealthFailures = 0;
    let rejectStartup: ((error: Error) => void) | undefined;
    const startupAborted = new Promise<never>((_, reject) => { rejectStartup = reject; });

    // Structural failure pre-check: a configured binary that does not exist can
    // never succeed, so spawning (and any restart loop, from any caller) is
    // pointless — disable for this session instead of flapping (native-mode
    // hosts without the sidecar payload hit this on every boot).
    const configuredBinary = this.binaryBin?.trim();
    if (configuredBinary && !existsSync(configuredBinary)) {
      this.status = "error";
      this.intentionalStop = true; // suppress every restart path
      this.logger.warn(
        "Hybrid DR sidecar binary not found; hybrid deep research disabled for this session",
        { binaryBin: configuredBinary },
        "hybrid-dr",
      );
      throw new Error(`Hybrid DR sidecar binary not found: ${configuredBinary}`);
    }

    const command = this.binaryBin?.trim() || this.pythonBin;
    const args = this.binaryBin?.trim()
      ? ["--host", this.host, "--port", String(this.port)]
      : ["-m", "uvicorn", this.module, "--factory", "--host", this.host, "--port", String(this.port)];
    this.child = this.spawnProcess(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HYBRID_DR_PORT: String(this.port) },
    });
    if (this.prefixStream) {
      this.prefixStream(this.child.stdout, "hybrid-dr", "stdout", this.logger, this.child.pid ?? undefined);
      this.prefixStream(this.child.stderr, "hybrid-dr", "stderr", this.logger, this.child.pid ?? undefined);
    }
    this.child.on("exit", (code, signal) => {
      const prev = this.status;
      this.stopHealthLoop();
      this.child = null;
      if (this.intentionalStop || prev === "stopped") return;
      const reason = code !== null ? `code ${code}` : signal ? `signal ${signal}` : "unknown";
      if (prev === "starting") {
        rejectStartup?.(new Error(`Hybrid DR sidecar exited during startup (${reason})`));
        return;
      }
      this.logger.warn("Hybrid DR sidecar exited; scheduling restart", { reason }, "hybrid-dr");
      this.scheduleRestart();
    });
    this.child.on("error", (error) => {
      const prev = this.status;
      this.stopHealthLoop();
      this.child = null;
      if (this.intentionalStop || prev === "stopped") return;
      if (prev === "starting") {
        rejectStartup?.(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.logger.warn("Hybrid DR sidecar process error; scheduling restart", { error: String(error) }, "hybrid-dr");
      this.scheduleRestart();
    });

    this.logger.info("Process spawned", { pid: this.child.pid ?? 0, port: this.port }, "hybrid-dr");
    const healthStart = Date.now();
    this.logger.info("Waiting for health", { port: this.port }, "hybrid-dr");
    try {
      await Promise.race([this.waitForHealthy(30_000), startupAborted]);
      const healthDurationMs = Math.round(Date.now() - healthStart);
      this.status = "running";
      this.startedAt = Date.now();
      this.restartCount = 0; // healthy start ends the consecutive-failure streak
      this.startHealthLoop();
      this.logger.info(`Healthy duration_ms=${healthDurationMs}`, { port: this.port, durationMs: healthDurationMs }, "hybrid-dr");
    } catch (error) {
      this.status = "error";
      const child = this.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
      this.scheduleRestart();
      throw error;
    }
  }

  private async waitForHealthy(timeoutMs: number): Promise<void> {
    await waitForHybridDrHealth(
      `http://${connectHost(this.host)}:${this.port}/healthz`,
      timeoutMs,
    );
  }

  private startHealthLoop(): void {
    this.stopHealthLoop();
    this.healthTimer = setInterval(async () => {
      try {
        await this.waitForHealthy(2_500);
        this.consecutiveHealthFailures = 0;
        if (this.status === "unhealthy") this.status = "running";
      } catch (error) {
        this.consecutiveHealthFailures += 1;
        if (this.status === "running") this.status = "unhealthy";
        if (this.consecutiveHealthFailures >= HEALTH_FAILURES_BEFORE_RESTART) {
          this.logger.warn("Hybrid DR sidecar health failed repeatedly; restarting", { error: String(error) }, "hybrid-dr");
          const child = this.child;
          if (child && child.exitCode === null && child.signalCode === null) {
            try { child.kill("SIGTERM"); } catch { /* ignore */ }
          } else {
            this.scheduleRestart();
          }
        }
      }
    }, 10_000);
    this.healthTimer.unref?.();
  }

  private stopHealthLoop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private scheduleRestart(): void {
    if (this.intentionalStop) return;
    this.stopHealthLoop();
    this.clearRestartTimer();
    if (this.restartCount >= MAX_CONSECUTIVE_FAILED_STARTS) {
      this.status = "error";
      this.logger.warn(
        "Hybrid DR sidecar failed to start repeatedly; giving up (hybrid deep research disabled for this session)",
        { attempts: this.restartCount },
        "hybrid-dr",
      );
      return;
    }
    this.status = "restarting";
    const delay = RESTART_BACKOFF_MS[Math.min(this.restartCount, RESTART_BACKOFF_MS.length - 1)];
    this.restartCount += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startOnce().catch((error) => {
        this.logger.warn("Hybrid DR sidecar restart failed", { error: error instanceof Error ? error.message : String(error) }, "hybrid-dr");
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }
}
