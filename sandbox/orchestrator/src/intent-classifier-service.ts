import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type IntentClassifierStatus = "stopped" | "starting" | "running" | "unhealthy" | "error";
export type IntentClassifierClassificationMode = "enabled" | "bypass";

export interface IntentClassifierLogger {
  format: "pretty" | "json";
  output: "stdout" | "silent";
  log: (level: "debug" | "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>, component?: string) => void;
  debug: (message: string, attributes?: Record<string, unknown>, component?: string) => void;
  info: (message: string, attributes?: Record<string, unknown>, component?: string) => void;
  warn: (message: string, attributes?: Record<string, unknown>, component?: string) => void;
  error: (message: string, attributes?: Record<string, unknown>, component?: string) => void;
  child: (component: string, attributes?: Record<string, unknown>) => {
    log: (level: "debug" | "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;
    debug: (message: string, attributes?: Record<string, unknown>) => void;
    info: (message: string, attributes?: Record<string, unknown>) => void;
    warn: (message: string, attributes?: Record<string, unknown>) => void;
    error: (message: string, attributes?: Record<string, unknown>) => void;
  };
}

export interface IntentClassifierServiceOptions {
  pythonBin?: string;
  scriptPath?: string;
  host: string;
  port: number;
  classificationMode: IntentClassifierClassificationMode;
  hybridDrEnabled: boolean;
  logger: IntentClassifierLogger;
  prefixStream?: (
    stream: NodeJS.ReadableStream | null,
    label: string,
    level: "stdout" | "stderr",
    logger: IntentClassifierLogger,
    pid?: number,
  ) => void;
  spawnProcess?: (command: string, args: string[], options?: SpawnOptions) => ChildProcess;
  callerToken?: string;
}

export interface IntentClassifierStatusInfo {
  status: IntentClassifierStatus;
  pid?: number;
  host: string;
  port: number;
  uptime?: number;
}

function defaultSpawnProcess(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (process.platform === "win32") return spawn(command, args, { ...options, windowsHide: true });
  return spawn(command, args, options);
}

export class IntentClassifierService {
  public onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  public onError?: (error: unknown) => void;

  private readonly pythonBin: string;
  private readonly scriptPath: string;
  private readonly host: string;
  private readonly port: number;
  private readonly classificationMode: IntentClassifierClassificationMode;
  private readonly hybridDrEnabled: boolean;
  private readonly logger: IntentClassifierLogger;
  private readonly prefixStream?: IntentClassifierServiceOptions["prefixStream"];
  private readonly spawnProcess: (command: string, args: string[], options?: SpawnOptions) => ChildProcess;
  private readonly callerToken?: string;
  private child: ChildProcess | null = null;
  private status: IntentClassifierStatus = "stopped";
  private startedAt: number | null = null;
  private healthTimer: NodeJS.Timeout | null = null;

  constructor(options: IntentClassifierServiceOptions) {
    this.pythonBin =
      options.pythonBin ??
      process.env.CLASSIFIER_PYTHON_BIN ??
      (process.env.CLASSIFIER_VENV ? `${process.env.CLASSIFIER_VENV.replace(/\/+$/, "")}/bin/python` : "/opt/system-venv/bin/python");
    this.scriptPath = options.scriptPath ?? process.env.CLASSIFIER_SERVER_SCRIPT ?? "/opt/intent-classifier/intent_classifier_server.py";
    this.host = options.host;
    this.port = options.port;
    this.classificationMode = options.classificationMode;
    this.hybridDrEnabled = options.hybridDrEnabled;
    this.logger = options.logger;
    this.prefixStream = options.prefixStream;
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.callerToken = options.callerToken;
  }

  async start(): Promise<void> {
    if (this.status === "running" || this.status === "starting") {
      this.logger.warn("Intent Classifier already running/starting, ignoring start()", {}, "intent-classifier");
      return;
    }
    this.status = "starting";
    try {
      // Capture a reject handle so early process exit aborts waitForHealthy immediately.
      let rejectStartup: ((error: Error) => void) | undefined;
      const startupAborted = new Promise<never>((_, reject) => { rejectStartup = reject; });

      const childEnv = { ...process.env };
      // Neither HDR credential nor the OpenCode runtime credential belongs to the classifier
      // (including Windows casing aliases).
      const forbidden = [
        "HYBRID_DR_API_TOKEN",
        "HYBRID_DR_READY_TOKEN",
        "OPENWORK_OPENCODE_PASSWORD",
        "OPENWORK_OPENCODE_USERNAME",
        "OPENCODE_SERVER_PASSWORD",
        "OPENCODE_SERVER_USERNAME",
      ];
      for (const name of Object.keys(childEnv)) {
        const upper = name.toUpperCase();
        if (forbidden.includes(upper) || upper === "INTENT_CLASSIFIER_TOKEN") delete childEnv[name];
      }
      this.child = this.spawnProcess(this.pythonBin, [this.scriptPath], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...childEnv,
          CLASSIFIER_HOST: this.host,
          CLASSIFIER_PORT: String(this.port),
          CLASSIFIER_CLASSIFICATION_MODE: this.classificationMode,
          CLASSIFIER_HYBRID_DR_ENABLED: String(this.hybridDrEnabled),
          ...(this.callerToken ? { INTENT_CLASSIFIER_TOKEN: this.callerToken } : {}),
        },
      });
      if (this.prefixStream) {
        this.prefixStream(this.child.stdout, "intent-classifier", "stdout", this.logger, this.child.pid ?? undefined);
        this.prefixStream(this.child.stderr, "intent-classifier", "stderr", this.logger, this.child.pid ?? undefined);
      }
      this.child.on("exit", (code, signal) => {
        const prev = this.status;
        this.stopHealthLoop();
        if (prev === "starting") {
          rejectStartup?.(new Error(`Intent Classifier exited during startup (code=${code ?? "null"}, signal=${signal ?? "null"})`));
          return;
        }
        if (prev === "running" || prev === "unhealthy") {
          this.status = "error";
          this.onExit?.(code, signal);
        }
      });
      this.child.on("error", (error) => {
        const prev = this.status;
        this.stopHealthLoop();
        if (prev === "starting") {
          rejectStartup?.(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (prev === "running" || prev === "unhealthy") {
          this.status = "error";
          this.onError?.(error);
        }
      });

      this.logger.info("Process spawned", { pid: this.child.pid ?? 0, classificationMode: this.classificationMode }, "intent-classifier");
      const healthStart = Date.now();
      this.logger.info("Waiting for health", { port: this.port }, "intent-classifier");
      await Promise.race([this.waitForHealthy(30_000), startupAborted]);
      const healthDurationMs = Math.round(Date.now() - healthStart);
      this.status = "running";
      this.startedAt = Date.now();
      this.startHealthLoop();
      this.logger.info(`Healthy duration_ms=${healthDurationMs}`, { port: this.port, classificationMode: this.classificationMode, durationMs: healthDurationMs }, "intent-classifier");
    } catch (error) {
      this.status = "error";
      const child = this.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopHealthLoop();
    const prev = this.status;
    this.status = "stopped";
    this.startedAt = null;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exitPromise = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* ignore */ }
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      await exitPromise;
    }
    this.child = null;
    if (prev !== "stopped") this.logger.info("Stopped", {}, "intent-classifier");
  }

  async restart(): Promise<void> {
    this.logger.info("Restarting", {}, "intent-classifier");
    await this.stop();
    await this.start();
  }

  detach(): void {
    this.stopHealthLoop();
    this.child = null;
    this.status = "stopped";
    this.startedAt = null;
  }

  getStatus(): IntentClassifierStatusInfo {
    return {
      status: this.status,
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      host: this.host,
      port: this.port,
      ...(this.startedAt ? { uptime: Math.floor((Date.now() - this.startedAt) / 1000) } : {}),
    };
  }

  private async waitForHealthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "not checked";
    while (Date.now() < deadline) {
      try {
        // Connect to 127.0.0.1 when the process binds on a wildcard address
        // (0.0.0.0 / ::); use the configured host otherwise (e.g. a specific
        // intranet IP that 127.0.0.1 would not reach).
        const connectHost = (this.host === "0.0.0.0" || this.host === "::") ? "127.0.0.1" : this.host;
        // egress-surface: supervisor_health_intent_classifier
        const res = await fetch(`http://${connectHost}:${this.port}/health`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) return;
        lastError = `HTTP ${res.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for Intent Classifier health: ${lastError}`);
  }

  private startHealthLoop(): void {
    this.stopHealthLoop();
    this.healthTimer = setInterval(async () => {
      try {
        await this.waitForHealthy(2_500);
        if (this.status === "unhealthy") this.status = "running";
      } catch {
        if (this.status === "running") this.status = "unhealthy";
      }
    }, 10_000);
    this.healthTimer.unref?.();
  }

  private stopHealthLoop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }
}
