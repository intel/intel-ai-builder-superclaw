#!/usr/bin/env node
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { homedir, hostname, networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { once } from "node:events";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { EXTERNAL_HDR_RUNTIME_TIMEOUT_MS, waitForOpencodeHealthy as waitForOpencodeHealthyImpl } from "./opencode-health.js";
import type { TuiHandle } from "./tui/app.js";
import { IntentClassifierService, type IntentClassifierClassificationMode } from "./intent-classifier-service.js";
import { resolveIntentClassifierEndpoint, type IntentClassifierEndpoint } from "./intent-classifier-bridge-url.js";
import { advertisedConnectHost, connectableHost, resolveBindHost } from "./bind-host.js";
import { buildOpenCodeRouterEnv } from "./opencode-router-env.js";
import { buildOpencodeProcessEnv, buildOpenworkServerEnv } from "./opencode-child-env.js";
import { hostTokenHeaders, verifyHostProxyAccess } from "./openwork-host-auth.js";
import {
  removeInheritedHdrCredentials,
  resolveHybridDrHost,
  resolveManagedServicePort,
  resolveOpencodePassword,
  validateExternalHdrOwnership,
} from "./external-services.js";
import { downloadBounded, fetchJsonBounded } from "./sidecar-network.js";
import { mergeResourceAttributes } from "./resource-attributes.js";
import { ExternalHybridDrHealthObserver, HybridDrSidecarService, MANAGED_HDR_READY_TIMEOUT_MS, probeManagedHybridDrReadiness } from "./hybrid-dr-sidecar-service.js";
import { prefixPrettyLineWithBootId } from "./log-format.js";
import { assertNoRemovedSandboxOptions } from "./removed-sandbox-options.js";
import {
  completeProfileTransition,
  beginAndReconcileProfileDeployment,
} from "./profile-deployment.js";
import { bootstrapRuntimeDeployment } from "./runtime-deployment.js";
import { createRuntimeProfileController, RuntimeOperationLock } from "./runtime-profile-controller.js";
import { awaitFailingFast, settle, startupMarker, throwIfFailed, type Settled } from "./startup-tasks.js";
import { prewarmOpencode } from "./opencode-prewarm.js";
import { opencodeRouterSendToolSource, opencodeRouterStatusToolSource } from "./opencode-router-tools.js";

type ApprovalMode = "manual" | "auto";

type LogFormat = "pretty" | "json";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogAttributes = Record<string, unknown>;

type LoggerChild = {
  log: (level: LogLevel, message: string, attributes?: LogAttributes) => void;
  debug: (message: string, attributes?: LogAttributes) => void;
  info: (message: string, attributes?: LogAttributes) => void;
  warn: (message: string, attributes?: LogAttributes) => void;
  error: (message: string, attributes?: LogAttributes) => void;
};

type Logger = {
  format: LogFormat;
  output: "stdout" | "silent";
  log: (level: LogLevel, message: string, attributes?: LogAttributes, component?: string) => void;
  debug: (message: string, attributes?: LogAttributes, component?: string) => void;
  info: (message: string, attributes?: LogAttributes, component?: string) => void;
  warn: (message: string, attributes?: LogAttributes, component?: string) => void;
  error: (message: string, attributes?: LogAttributes, component?: string) => void;
  child: (component: string, attributes?: LogAttributes) => LoggerChild;
};

type LogEvent = {
  time: number;
  level: LogLevel;
  message: string;
  component?: string;
  attributes?: LogAttributes;
};

type OpencodeHotReload = {
  enabled: boolean;
  debounceMs: number;
  cooldownMs: number;
};

type OpenCodeRouterHealthSnapshot = {
  ok: boolean;
  opencode: {
    url: string;
    healthy: boolean;
    version?: string;
  };
  channels: {
    telegram: boolean;
    whatsapp: boolean;
    slack: boolean;
  };
  config: {
    groupsEnabled: boolean;
  };
};

const FALLBACK_VERSION = "0.1.0";

declare const __OPENWORK_ORCHESTRATOR_VERSION__: string | undefined;
const DEFAULT_APPROVAL_TIMEOUT = 30000;
const DEFAULT_OPENCODE_USERNAME = "opencode";
const DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS = 700;
const DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS = 1500;

type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

type ChildHandle = {
  name: string;
  child: ReturnType<typeof spawn>;
};

type VersionInfo = {
  version: string;
  sha256: string;
};

type SidecarName = "openwork-server" | "opencode-router" | "opencode";

type SidecarTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64"
  | "linux-arm64"
  | "windows-x64"
  | "windows-arm64";

type VersionManifest = {
  dir: string;
  entries: Record<string, VersionInfo>;
};

type RemoteSidecarAsset = {
  asset?: string;
  url?: string;
  sha256?: string;
  size?: number;
};

type RemoteSidecarEntry = {
  version: string;
  targets: Record<string, RemoteSidecarAsset>;
};

type RemoteSidecarManifest = {
  version: string;
  generatedAt?: string;
  entries: Record<string, RemoteSidecarEntry>;
};

type SidecarConfig = {
  dir: string;
  baseUrl: string;
  manifestUrl: string;
  target: SidecarTarget | null;
};

type BinarySource = "bundled" | "external" | "downloaded";

type BinarySourcePreference = "auto" | "bundled" | "downloaded" | "external";

type ResolvedBinary = {
  bin: string;
  source: BinarySource;
  expectedVersion?: string;
};

type BinaryDiagnostics = {
  path: string;
  source: BinarySource;
  expectedVersion?: string;
  actualVersion?: string;
};

type RuntimeServiceName = "openwork-server" | "opencode" | "opencode-router" | "intent-classifier" | "hybrid-dr";

type RuntimeServiceSnapshot = {
  name: RuntimeServiceName;
  enabled: boolean;
  running: boolean;
  source?: BinarySource;
  path?: string;
  targetVersion?: string;
  actualVersion?: string;
  upgradeAvailable: boolean;
};

type RuntimeUpgradeState = {
  status: "idle" | "running" | "failed";
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  operationId: string | null;
  services: RuntimeServiceName[];
};

type SidecarDiagnostics = {
  dir: string;
  baseUrl: string;
  manifestUrl: string;
  target: SidecarTarget | null;
  source: BinarySourcePreference;
  opencodeSource: BinarySourcePreference;
  allowExternal: boolean;
};

type RouterWorkspaceType = "local" | "remote";

type RouterWorkspace = {
  id: string;
  name: string;
  path: string;
  workspaceType: RouterWorkspaceType;
  baseUrl?: string;
  directory?: string;
  createdAt: number;
  lastUsedAt?: number;
};

type RouterDaemonState = {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: number;
};

type RouterOpencodeState = {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: number;
};

type RouterBinaryInfo = {
  path: string;
  source: BinarySource;
  expectedVersion?: string;
  actualVersion?: string;
};

type RouterBinaryState = {
  opencode?: RouterBinaryInfo;
};

type RouterSidecarState = {
  dir: string;
  baseUrl: string;
  manifestUrl: string;
  target: SidecarTarget | null;
  source: BinarySourcePreference;
  opencodeSource: BinarySourcePreference;
  allowExternal: boolean;
};

type RouterState = {
  version: number;
  daemon?: RouterDaemonState;
  opencode?: RouterOpencodeState;
  cliVersion?: string;
  sidecar?: RouterSidecarState;
  binaries?: RouterBinaryState;
  activeId: string;
  workspaces: RouterWorkspace[];
};

type OpencodeStateLayout = {
  devMode: boolean;
  rootDir: string;
  configDir: string;
  env: NodeJS.ProcessEnv;
  importConfigDir?: string;
  importDataDir?: string;
};

type FieldsResult<T> = {
  data?: T;
  error?: unknown;
  request?: Request;
  response?: Response;
};

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (arg === "-v") {
      flags.set("version", true);
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const trimmed = arg.slice(2);
    if (!trimmed) continue;

    if (trimmed.startsWith("no-")) {
      flags.set(trimmed.slice(3), false);
      continue;
    }

    const [key, inlineValue] = trimmed.split("=");
    if (inlineValue !== undefined) {
      flags.set(key, inlineValue);
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }

  return { positionals, flags };
}

function parseList(value?: string): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
    } catch {
      return [];
    }
  }
  return trimmed
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readFlag(flags: Map<string, string | boolean>, key: string): string | undefined {
  const value = flags.get(key);
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

function readBool(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: boolean,
  envKey?: string,
): boolean {
  const raw = flags.get(key);
  if (raw !== undefined) {
    if (typeof raw === "boolean") return raw;
    const normalized = String(raw).toLowerCase();
    if (["false", "0", "no"].includes(normalized)) return false;
    if (["true", "1", "yes"].includes(normalized)) return true;
  }

  const envValue = envKey ? process.env[envKey] : undefined;
  if (envValue) {
    const normalized = envValue.toLowerCase();
    if (["false", "0", "no"].includes(normalized)) return false;
    if (["true", "1", "yes"].includes(normalized)) return true;
  }

  return fallback;
}

function readNumber(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: number | undefined,
  envKey?: string,
): number | undefined {
  const raw = flags.get(key);
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (envKey) {
    const envValue = process.env[envKey];
    if (envValue) {
      const parsed = Number(envValue);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return fallback;
}

function readOpencodeHotReload(
  flags: Map<string, string | boolean>,
  defaults?: Partial<OpencodeHotReload>,
  env?: {
    enabled?: string;
    debounceMs?: string;
    cooldownMs?: string;
  },
): OpencodeHotReload {
  const enabled = readBool(flags, "opencode-hot-reload", defaults?.enabled ?? true, env?.enabled);
  const debounceRaw = readNumber(
    flags,
    "opencode-hot-reload-debounce-ms",
    defaults?.debounceMs ?? DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS,
    env?.debounceMs,
  );
  const cooldownRaw = readNumber(
    flags,
    "opencode-hot-reload-cooldown-ms",
    defaults?.cooldownMs ?? DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS,
    env?.cooldownMs,
  );
  const debounceMs =
    typeof debounceRaw === "number" && Number.isFinite(debounceRaw) && debounceRaw >= 50
      ? Math.floor(debounceRaw)
      : DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS;
  const cooldownMs =
    typeof cooldownRaw === "number" && Number.isFinite(cooldownRaw) && cooldownRaw >= 100
      ? Math.floor(cooldownRaw)
      : DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS;
  return {
    enabled,
    debounceMs,
    cooldownMs,
  };
}

function readBinarySource(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: BinarySourcePreference,
  envKey?: string,
): BinarySourcePreference {
  const raw = readFlag(flags, key) ?? (envKey ? process.env[envKey] : undefined);
  if (!raw) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "auto" || normalized === "bundled" || normalized === "downloaded" || normalized === "external") {
    return normalized as BinarySourcePreference;
  }
  throw new Error(`Invalid ${key} value: ${raw}. Use auto|bundled|downloaded|external.`);
}

function readLogFormat(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: LogFormat,
  envKey?: string,
): LogFormat {
  const raw = readFlag(flags, key) ?? (envKey ? process.env[envKey] : undefined);
  if (!raw) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "json") return "json";
  if (normalized === "pretty" || normalized === "text" || normalized === "human") return "pretty";
  throw new Error(`Invalid ${key} value: ${raw}. Use pretty|json.`);
}

async function isDir(input: string): Promise<boolean> {
  try {
    return (await stat(input)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a path exists, refusing to answer when it cannot be determined.
 *
 * Only absence answers "no". A `stat` that fails for any other reason - a denying ACL, an I/O error -
 * means the question is unanswerable, and returning `false` there would report "absent" for something
 * that may well be present. That distinction is not academic: every caller here either writes when this
 * returns `false` or reports a binary as missing, so a false negative turns into a clobbered file or a
 * misleading refusal. Rethrowing makes the real error the one the caller sees.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

async function resolveCliVersion(): Promise<string> {
  if (
    typeof __OPENWORK_ORCHESTRATOR_VERSION__ === "string" &&
    __OPENWORK_ORCHESTRATOR_VERSION__.trim()
  ) {
    return __OPENWORK_ORCHESTRATOR_VERSION__.trim();
  }
  const candidates = [
    join(dirname(process.execPath), "..", "package.json"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      try {
        const raw = await readFile(candidate, "utf8");
        const parsed = JSON.parse(raw) as { version?: string };
        if (parsed.version) return parsed.version;
      } catch {
        // ignore
      }
    }
  }

  return FALLBACK_VERSION;
}

async function readPackageField(field: string): Promise<string | undefined> {
  const candidates = [
    join(dirname(process.execPath), "..", "package.json"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      try {
        const raw = await readFile(candidate, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const value = parsed[field];
        if (typeof value === "string" && value.trim()) return value.trim();
      } catch {
        // ignore
      }
    }
  }

  return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureWorkspace(workspace: string): Promise<string> {
  const resolved = resolve(workspace);
  await mkdir(resolved, { recursive: true });

  const configPathJsonc = join(resolved, "opencode.jsonc");
  const configPathJson = join(resolved, "opencode.json");
  const hasJsonc = await fileExists(configPathJsonc);
  const hasJson = await fileExists(configPathJson);

  if (!hasJsonc && !hasJson) {
    const payload = JSON.stringify({ "$schema": "https://opencode.ai/config.json" }, null, 2);
    await writeFile(configPathJsonc, `${payload}\n`, "utf8");
  }

  return resolved;
}

async function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once("error", (err) => reject(err));
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function resolvePort(preferred: number | undefined, host: string, fallback?: number): Promise<number> {
  if (preferred && (await canBind(host, preferred))) {
    return preferred;
  }
  if (fallback && fallback !== preferred && (await canBind(host, fallback))) {
    return fallback;
  }
  return findFreePort(host);
}

function isCompiledBunBinary(): boolean {
  try {
    const entryPath = fileURLToPath(import.meta.url);
    return entryPath.startsWith("/$bunfs/");
  } catch {
    return false;
  }
}

function resolveLanIp(): string | null {
  const interfaces = networkInterfaces();
  for (const key of Object.keys(interfaces)) {
    const entries = interfaces[key];
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      return entry.address;
    }
  }
  return null;
}

function resolveConnectUrl(port: number, overrideHost?: string): { connectUrl?: string; lanUrl?: string; mdnsUrl?: string } {
  if (overrideHost) {
    const trimmed = overrideHost.trim();
    if (trimmed) {
      const url = `http://${trimmed}:${port}`;
      return { connectUrl: url, lanUrl: url };
    }
  }

  const host = hostname().trim();
  const mdnsUrl = host ? `http://${host.replace(/\.local$/, "")}.local:${port}` : undefined;
  const lanIp = resolveLanIp();
  const lanUrl = lanIp ? `http://${lanIp}:${port}` : undefined;
  const connectUrl = lanUrl ?? mdnsUrl;
  return { connectUrl, lanUrl, mdnsUrl };
}

function encodeBasicAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

function unwrap<T>(result: FieldsResult<T>): T {
  if (result.data !== undefined) {
    return result.data;
  }
  const message =
    result.error instanceof Error
      ? result.error.message
      : typeof result.error === "string"
        ? result.error
        : JSON.stringify(result.error);
  throw new Error(message || "Unknown error");
}

function prefixStream(
  stream: NodeJS.ReadableStream | null,
  label: string,
  level: "stdout" | "stderr",
  logger: Logger,
  pid?: number,
): void {
  if (!stream) return;
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (logger.output === "stdout" && logger.format === "json" && looksLikeOtelLogLine(line)) {
        process.stdout.write(`${line}\n`);
        continue;
      }
      const severity = inferLineSeverity(line, level);
      logger.log(severity, line, { stream: level, pid }, label);
    }
  });
  stream.on("end", () => {
    if (!buffer.trim()) return;
    if (logger.output === "stdout" && logger.format === "json" && looksLikeOtelLogLine(buffer)) {
      process.stdout.write(`${buffer}\n`);
      return;
    }
    const severity = inferLineSeverity(buffer, level);
    logger.log(severity, buffer, { stream: level, pid }, label);
  });
}

// Many sidecars (uvicorn, litellm, Python's `logging` module) write every
// level to stderr, so mapping stderr -> "error" creates false alarms.
// Sniff the inner level token instead; fall back to "warn" for stderr (so
// stderr-only output is still flagged) and "info" for stdout.
const SEVERITY_TOKEN_RE =
  /\b(CRITICAL|FATAL|ERROR|WARNING|WARN|INFO|DEBUG|TRACE)\b\s*[:\- ]/;

function inferLineSeverity(line: string, stream: "stdout" | "stderr"): LogLevel {
  const match = SEVERITY_TOKEN_RE.exec(line);
  if (match) {
    switch (match[1]) {
      case "CRITICAL":
      case "FATAL":
      case "ERROR":
        return "error";
      case "WARNING":
      case "WARN":
        return "warn";
      case "INFO":
        return "info";
      case "DEBUG":
      case "TRACE":
        return "debug";
    }
  }
  return stream === "stderr" ? "warn" : "info";
}

function shouldUseBun(bin: string): boolean {
  if (!bin.endsWith(`${join("dist", "cli.js")}`)) return false;
  if (bin.includes("openwork-server")) return true;
  return bin.includes(`${join("packages", "server")}`);
}

function resolveBinCommand(bin: string): { command: string; prefixArgs: string[] } {
  if (bin.endsWith(".ts")) {
    return { command: "bun", prefixArgs: [bin, "--"] };
  }
  if (bin.endsWith(".js")) {
    if (shouldUseBun(bin)) {
      return { command: "bun", prefixArgs: [bin, "--"] };
    }
    return { command: "node", prefixArgs: [bin, "--"] };
  }
  return { command: bin, prefixArgs: [] };
}

async function readVersionManifest(): Promise<VersionManifest | null> {
  const candidates = [dirname(process.execPath), dirname(fileURLToPath(import.meta.url))];
  for (const dir of candidates) {
    const manifestPath = join(dir, "versions.json");
    if (await fileExists(manifestPath)) {
      try {
        const payload = await readFile(manifestPath, "utf8");
        const entries = JSON.parse(payload) as Record<string, VersionInfo>;
        return { dir, entries };
      } catch {
        return { dir, entries: {} };
      }
    }
  }
  return null;
}

const remoteManifestCache = new Map<string, Promise<RemoteSidecarManifest | null>>();

function resolveSidecarTarget(): SidecarTarget | null {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return "darwin-arm64";
    if (process.arch === "x64") return "darwin-x64";
    return null;
  }
  if (process.platform === "linux") {
    if (process.arch === "arm64") return "linux-arm64";
    if (process.arch === "x64") return "linux-x64";
    return null;
  }
  if (process.platform === "win32") {
    if (process.arch === "arm64") return "windows-arm64";
    if (process.arch === "x64") return "windows-x64";
    return null;
  }
  return null;
}

function resolveSidecarConfigForTarget(
  flags: Map<string, string | boolean>,
  cliVersion: string,
  targetOverride: SidecarTarget | null,
): SidecarConfig {
  const baseUrl = resolveSidecarBaseUrl(flags, cliVersion);
  return {
    dir: resolveSidecarDir(flags),
    baseUrl,
    manifestUrl: resolveSidecarManifestUrl(flags, baseUrl),
    target: targetOverride,
  };
}

function spawnProcess(command: string, args: string[], options: SpawnOptions = {}) {
  if (process.platform === "win32") {
    return spawn(command, args, { ...options, windowsHide: true });
  }
  return spawn(command, args, options);
}

function resolveSidecarDir(flags: Map<string, string | boolean>): string {
  const override = readFlag(flags, "sidecar-dir") ?? process.env.OPENWORK_SIDECAR_DIR;
  if (override && override.trim()) return resolve(override.trim());
  return join(resolveRouterDataDir(flags), "sidecars");
}

function resolveSidecarBaseUrl(flags: Map<string, string | boolean>, cliVersion: string): string {
  const override = readFlag(flags, "sidecar-base-url") ?? process.env.OPENWORK_SIDECAR_BASE_URL;
  if (override && override.trim()) return override.trim();
  return `https://github.com/different-ai/openwork/releases/download/openwork-orchestrator-v${cliVersion}`;
}

function resolveSidecarManifestUrl(flags: Map<string, string | boolean>, baseUrl: string): string {
  const override = readFlag(flags, "sidecar-manifest") ?? process.env.OPENWORK_SIDECAR_MANIFEST_URL;
  if (override && override.trim()) return override.trim();
  return `${baseUrl.replace(/\/$/, "")}/openwork-orchestrator-sidecars.json`;
}

function resolveSidecarConfig(flags: Map<string, string | boolean>, cliVersion: string): SidecarConfig {
  const baseUrl = resolveSidecarBaseUrl(flags, cliVersion);
  return {
    dir: resolveSidecarDir(flags),
    baseUrl,
    manifestUrl: resolveSidecarManifestUrl(flags, baseUrl),
    target: resolveSidecarTarget(),
  };
}

async function fetchRemoteManifest(url: string): Promise<RemoteSidecarManifest | null> {
  const cached = remoteManifestCache.get(url);
  if (cached) return cached;
  const task = fetchJsonBounded<RemoteSidecarManifest>(url);
  remoteManifestCache.set(url, task);
  return task;
}

function resolveAssetUrl(baseUrl: string, asset?: string, url?: string): string | null {
  if (url && url.trim()) return url.trim();
  if (asset && asset.trim()) return `${baseUrl.replace(/\/$/, "")}/${asset.trim()}`;
  return null;
}

function resolveAssetName(asset?: string, url?: string): string | null {
  if (asset && asset.trim()) return asset.trim();
  if (url && url.trim()) {
    try {
      return basename(new URL(url).pathname);
    } catch {
      const parts = url.split("/").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : null;
    }
  }
  return null;
}

async function downloadToPath(url: string, dest: string): Promise<void> {
  const buffer = await downloadBounded(url);
  await mkdir(dirname(dest), { recursive: true });
  const tmpPath = `${dest}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, buffer);
  await rename(tmpPath, dest);
}

async function ensureExecutable(path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(path, 0o755);
  } catch {
    // ignore
  }
}

async function downloadSidecarBinary(options: {
  name: SidecarName;
  sidecar: SidecarConfig;
}): Promise<ResolvedBinary | null> {
  if (!options.sidecar.target) return null;
  const manifest = await fetchRemoteManifest(options.sidecar.manifestUrl);
  if (!manifest) return null;
  const entry = manifest.entries[options.name];
  if (!entry) return null;
  const targetInfo = entry.targets[options.sidecar.target];
  if (!targetInfo) return null;

  const assetName = resolveAssetName(targetInfo.asset, targetInfo.url);
  const assetUrl = resolveAssetUrl(options.sidecar.baseUrl, targetInfo.asset, targetInfo.url);
  if (!assetName || !assetUrl) return null;

  const targetDir = join(options.sidecar.dir, entry.version, options.sidecar.target);
  const targetPath = join(targetDir, assetName);
  if (await fileExists(targetPath)) {
    if (targetInfo.sha256) {
      try {
        await verifyBinary(targetPath, { version: entry.version, sha256: targetInfo.sha256 });
        await ensureExecutable(targetPath);
        return { bin: targetPath, source: "downloaded", expectedVersion: entry.version };
      } catch {
        await rm(targetPath, { force: true });
      }
    } else {
      await ensureExecutable(targetPath);
      return { bin: targetPath, source: "downloaded", expectedVersion: entry.version };
    }
  }

  await downloadToPath(assetUrl, targetPath);
  if (targetInfo.sha256) {
    await verifyBinary(targetPath, { version: entry.version, sha256: targetInfo.sha256 });
  }
  await ensureExecutable(targetPath);
  return { bin: targetPath, source: "downloaded", expectedVersion: entry.version };
}

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

async function verifyBinary(path: string, expected?: VersionInfo): Promise<void> {
  if (!expected) return;
  const hash = await sha256File(path);
  if (hash !== expected.sha256) {
    throw new Error(`Integrity check failed for ${path}`);
  }
}

async function resolveBundledBinary(manifest: VersionManifest | null, name: string): Promise<string | null> {
  if (!manifest) return null;
  const candidates = [join(manifest.dir, name)];
  if (process.platform === "win32") {
    candidates.push(join(manifest.dir, `${name}.exe`));
  }
  for (const bundled of candidates) {
    if (!(await isExecutable(bundled))) continue;
    // Desktop bundles may be code-signed after we generate versions.json, which
    // mutates the on-disk bytes and makes a precomputed sha256 unstable.
    // Linux bundles remain byte-stable, so keep integrity verification there.
    if (process.platform === "linux") {
      await verifyBinary(bundled, manifest.entries[name]);
    }
    return bundled;
  }
  return null;
}

async function readPackageVersion(path: string): Promise<string | undefined> {
  try {
    const payload = await readFile(path, "utf8");
    const parsed = JSON.parse(payload) as { version?: string };
    if (typeof parsed.version === "string") return parsed.version;
    return undefined;
  } catch {
    return undefined;
  }
}

async function resolveOpenCodeRouterRepoDir(): Promise<string | null> {
  const envPath = process.env.OPENCODE_ROUTER_DIR?.trim();
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const repoRoot = resolve(root, "..", "..");
  const candidates = [envPath, resolve(repoRoot, "sandbox", "channels")].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const pkgPath = join(candidate, "package.json");
    if (await fileExists(pkgPath)) return candidate;
  }

  return null;
}

async function resolveExpectedVersion(
  manifest: VersionManifest | null,
  name: SidecarName,
): Promise<string | undefined> {
  const manifestVersion = manifest?.entries[name]?.version;
  if (manifestVersion) return manifestVersion;

  try {
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    if (name === "openwork-server") {
      const localPath = join(root, "..", "server", "package.json");
      const localVersion = await readPackageVersion(localPath);
      if (localVersion) return localVersion;
    }
    if (name === "opencode-router") {
      const repoDir = await resolveOpenCodeRouterRepoDir();
      const localPath = repoDir ? join(repoDir, "package.json") : join(root, "..", "channels", "package.json");
      const localVersion = await readPackageVersion(localPath);
      if (localVersion) return localVersion;
    }
    if (name === "opencode") {
      const envVersion = process.env.OPENCODE_VERSION?.trim();
      if (envVersion && envVersion.toLowerCase() !== "latest") {
        return envVersion.startsWith("v") ? envVersion.slice(1) : envVersion;
      }
      const pkgVersion = await readPackageField("opencodeVersion");
      if (pkgVersion && pkgVersion.toLowerCase() !== "latest") {
        return pkgVersion.startsWith("v") ? pkgVersion.slice(1) : pkgVersion;
      }
    }
  } catch {
    // ignore
  }

  const require = createRequire(import.meta.url);
  if (name === "openwork-server") {
    try {
      const pkgPath = require.resolve("openwork-server/package.json");
      const version = await readPackageVersion(pkgPath);
      if (version) return version;
    } catch {
      // ignore
    }
  }
  if (name === "opencode-router") {
    try {
      const pkgPath = require.resolve("opencode-router/package.json");
      const version = await readPackageVersion(pkgPath);
      if (version) return version;
    } catch {
      // ignore
    }
  }

  return undefined;
}

function parseVersion(output: string): string | undefined {
  const match = output.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/);
  return match?.[0];
}

async function readCliVersion(bin: string, timeoutMs = 4000): Promise<string | undefined> {
  const resolved = resolveBinCommand(bin);
  const child = spawnProcess(resolved.command, [...resolved.prefixArgs, "--version"], {
    // Avoid picking up a local bunfig.toml preload from the caller's cwd.
    // (Notably, sandbox/orchestrator/bunfig.toml preloads @opentui/solid/preload which
    // breaks running bun-compiled binaries like opencodeRouter during version checks.)
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });

  const result = await Promise.race([
    once(child, "close").then(() => "close"),
    once(child, "error").then(() => "error"),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, "timeout")),
  ]);

  if (result === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    return undefined;
  }

  if (result === "error") {
    return undefined;
  }

  return parseVersion(output.trim());
}

async function captureCommandOutput(
  bin: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string> {
  const resolved = resolveBinCommand(bin);
  const child = spawnProcess(resolved.command, [...resolved.prefixArgs, ...args], {
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
    env: options?.env ?? process.env,
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });

  type CaptureResult =
    | "timeout"
    | "error"
    | {
        type: "close";
        code: number | null;
        signal: NodeJS.Signals | null;
      };

  const timeoutMs = options?.timeoutMs ?? 30_000;
  const result = await Promise.race<CaptureResult>([
    once(child, "close").then(([code, signal]) => ({
      type: "close" as const,
      code: (code ?? null) as number | null,
      signal: (signal ?? null) as NodeJS.Signals | null,
    })),
    once(child, "error").then(() => "error" as const),
    new Promise<CaptureResult>((resolve) => setTimeout(resolve, timeoutMs, "timeout")),
  ]);

  if (result === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error("Command timed out");
  }

  if (result === "error") {
    throw new Error("Command failed to run");
  }

  const code = result.code;
  if (code !== 0) {
    const suffix = output.trim() ? `\n${output.trim()}` : "";
    throw new Error(`Command failed: ${bin} ${args.join(" ")}${suffix}`);
  }

  return output.trim();
}

function assertVersionMatch(
  name: string,
  expected: string | undefined,
  actual: string | undefined,
  context: string,
): void {
  if (!expected) return;
  if (!actual) {
    throw new Error(`Unable to determine ${name} version from ${context}. Expected ${expected}.`);
  }
  if (expected !== actual) {
    throw new Error(`${name} version mismatch: expected ${expected}, got ${actual}.`);
  }
}

function resolveBinPath(bin: string): string {
  if (bin.includes("/") || bin.startsWith(".")) {
    return resolve(process.cwd(), bin);
  }
  return bin;
}

async function resolveOpenworkServerBin(options: {
  explicit?: string;
  manifest: VersionManifest | null;
  allowExternal: boolean;
  sidecar: SidecarConfig;
  source: BinarySourcePreference;
}): Promise<ResolvedBinary> {
  if (options.explicit && !options.allowExternal) {
    throw new Error("openwork-server-bin requires --allow-external");
  }
  if (options.explicit && options.source !== "auto" && options.source !== "external") {
    throw new Error("openwork-server-bin requires --sidecar-source external or auto");
  }

  const expectedVersion = await resolveExpectedVersion(options.manifest, "openwork-server");
  const resolveExternal = async (): Promise<ResolvedBinary> => {
    if (!options.allowExternal) {
      throw new Error("External openwork-server requires --allow-external");
    }
    if (options.explicit) {
      const resolved = resolveBinPath(options.explicit);
      if ((resolved.includes("/") || resolved.startsWith(".")) && !(await fileExists(resolved))) {
        throw new Error(`openwork-server-bin not found: ${resolved}`);
      }
      return { bin: resolved, source: "external", expectedVersion };
    }

    const require = createRequire(import.meta.url);
    try {
      const pkgPath = require.resolve("openwork-server/package.json");
      const pkgDir = dirname(pkgPath);
      const binaryPath = join(pkgDir, "dist", "bin", "openwork-server");
      if (await isExecutable(binaryPath)) {
        return { bin: binaryPath, source: "external", expectedVersion };
      }
      const cliPath = join(pkgDir, "dist", "cli.js");
      if (await isExecutable(cliPath)) {
        return { bin: cliPath, source: "external", expectedVersion };
      }
    } catch {
      // ignore
    }

    return { bin: "openwork-server", source: "external", expectedVersion };
  };

  if (options.source === "bundled") {
    const bundled = await resolveBundledBinary(options.manifest, "openwork-server");
    if (!bundled) {
      throw new Error(
        "Bundled openwork-server binary missing. Build with pnpm --filter openwork-orchestrator build:bin:bundled.",
      );
    }
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.source === "downloaded") {
    const downloaded = await downloadSidecarBinary({ name: "openwork-server", sidecar: options.sidecar });
    if (!downloaded) {
      throw new Error("openwork-server download failed. Check sidecar manifest or base URL.");
    }
    return downloaded;
  }

  if (options.source === "external") {
    return resolveExternal();
  }

  const bundled = await resolveBundledBinary(options.manifest, "openwork-server");
  if (bundled && !(options.allowExternal && options.explicit)) {
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.explicit) {
    return resolveExternal();
  }

  const downloaded = await downloadSidecarBinary({ name: "openwork-server", sidecar: options.sidecar });
  if (downloaded) return downloaded;

  if (!options.allowExternal) {
    throw new Error(
      "Bundled openwork-server binary missing and download failed. Use --allow-external or --sidecar-source external.",
    );
  }

  return resolveExternal();
}

async function resolveOpencodeBin(options: {
  explicit?: string;
  manifest: VersionManifest | null;
  allowExternal: boolean;
  sidecar: SidecarConfig;
  source: BinarySourcePreference;
  externalLifecycle?: boolean; // --external-opencode: never executed here, so resolve from disk only (#2888)
}): Promise<ResolvedBinary> {
  if (options.explicit && !options.allowExternal) {
    throw new Error("opencode-bin requires --allow-external");
  }
  if (options.explicit && options.source !== "auto" && options.source !== "external") {
    throw new Error("opencode-bin requires --opencode-source external or auto");
  }

  const expectedVersion = options.explicit
    ? options.manifest?.entries.opencode?.version
    : await resolveExpectedVersion(options.manifest, "opencode");
  const resolveExternal = async (): Promise<ResolvedBinary> => {
    if (!options.allowExternal) {
      throw new Error("External opencode requires --allow-external");
    }
    if (options.explicit) {
      const resolved = resolveBinPath(options.explicit);
      if ((resolved.includes("/") || resolved.startsWith(".")) && !(await fileExists(resolved))) {
        throw new Error(`opencode-bin not found: ${resolved}`);
      }
      return { bin: resolved, source: "external", expectedVersion };
    }
    return { bin: "opencode", source: "external", expectedVersion };
  };

  if (options.externalLifecycle) {
    if (options.explicit) return resolveExternal();
    const bundled = await resolveBundledBinary(options.manifest, "opencode");
    return { bin: bundled ?? "opencode", source: bundled ? "bundled" : "external", expectedVersion };
  }

  if (options.source === "bundled") {
    const bundled = await resolveBundledBinary(options.manifest, "opencode");
    if (!bundled) {
      throw new Error(
        "Bundled opencode binary missing. Build with pnpm --filter openwork-orchestrator build:bin:bundled.",
      );
    }
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.source === "downloaded") {
    const downloaded = await downloadSidecarBinary({ name: "opencode", sidecar: options.sidecar });
    if (downloaded) return downloaded;
    throw new Error(
      "opencode download failed. Check sidecar manifest/network access, or build a local copy with " +
        "pnpm --filter openwork-orchestrator build:bin:bundled (then rerun with --opencode-source bundled).",
    );
  }

  if (options.source === "external") {
    return resolveExternal();
  }

  const bundled = await resolveBundledBinary(options.manifest, "opencode");
  if (bundled && !(options.allowExternal && options.explicit)) {
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.explicit) {
    return resolveExternal();
  }

  const downloaded = await downloadSidecarBinary({ name: "opencode", sidecar: options.sidecar });
  if (downloaded) return downloaded;

  if (!options.allowExternal) {
    throw new Error(
      "Bundled opencode binary missing and download failed. Use --allow-external or --opencode-source external, " +
        "or build a local copy with pnpm --filter openwork-orchestrator build:bin:bundled.",
    );
  }

  return resolveExternal();
}

async function resolveOpenCodeRouterBin(options: {
  explicit?: string;
  manifest: VersionManifest | null;
  allowExternal: boolean;
  sidecar: SidecarConfig;
  source: BinarySourcePreference;
}): Promise<ResolvedBinary> {
  if (options.explicit && !options.allowExternal) {
    throw new Error("opencode-router-bin requires --allow-external");
  }
  if (options.explicit && options.source !== "auto" && options.source !== "external") {
    throw new Error("opencode-router-bin requires --sidecar-source external or auto");
  }

  const expectedVersion = await resolveExpectedVersion(options.manifest, "opencode-router");
  const resolveExternal = async (): Promise<ResolvedBinary> => {
    if (!options.allowExternal) {
      throw new Error("External opencodeRouter requires --allow-external");
    }
    if (options.explicit) {
      const resolved = resolveBinPath(options.explicit);
      if ((resolved.includes("/") || resolved.startsWith(".")) && !(await fileExists(resolved))) {
        throw new Error(`opencode-router-bin not found: ${resolved}`);
      }
      return { bin: resolved, source: "external", expectedVersion };
    }

    const repoDir = await resolveOpenCodeRouterRepoDir();
    if (repoDir) {
      const binPath = join(repoDir, "dist", "bin", "opencode-router");
      if (await isExecutable(binPath)) {
        return { bin: binPath, source: "external", expectedVersion };
      }
      const cliPath = join(repoDir, "dist", "cli.js");
      if (await fileExists(cliPath)) {
        return { bin: cliPath, source: "external", expectedVersion };
      }
    }

    const require = createRequire(import.meta.url);
    try {
      const pkgPath = require.resolve("opencode-router/package.json");
      const pkgDir = dirname(pkgPath);
      const binaryPath = join(pkgDir, "dist", "bin", "opencode-router");
      if (await isExecutable(binaryPath)) {
        return { bin: binaryPath, source: "external", expectedVersion };
      }
      const cliPath = join(pkgDir, "dist", "cli.js");
      if (await isExecutable(cliPath)) {
        return { bin: cliPath, source: "external", expectedVersion };
      }
    } catch {
      // ignore
    }

    throw new Error(
      "opencode-router binary not found. Install the opencode-router dependency or pass --opencode-router-bin with --allow-external.",
    );
  };

  if (options.source === "bundled") {
    const bundled = await resolveBundledBinary(options.manifest, "opencode-router");
    if (!bundled) {
      throw new Error(
        "Bundled opencodeRouter binary missing. Build with pnpm --filter openwork-orchestrator build:bin:bundled.",
      );
    }
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.source === "downloaded") {
    const downloaded = await downloadSidecarBinary({ name: "opencode-router", sidecar: options.sidecar });
    if (!downloaded) {
      throw new Error("opencodeRouter download failed. Check sidecar manifest or base URL.");
    }
    return downloaded;
  }

  if (options.source === "external") {
    return resolveExternal();
  }

  const bundled = await resolveBundledBinary(options.manifest, "opencode-router");
  if (bundled && !(options.allowExternal && options.explicit)) {
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.explicit) {
    return resolveExternal();
  }

  const downloaded = await downloadSidecarBinary({ name: "opencode-router", sidecar: options.sidecar });
  if (downloaded) return downloaded;

  if (!options.allowExternal) {
    throw new Error(
      "Bundled opencodeRouter binary missing and download failed. Use --allow-external or --sidecar-source external.",
    );
  }

  return resolveExternal();
}

function resolveRouterDataDir(flags: Map<string, string | boolean>): string {
  const override = readFlag(flags, "data-dir") ?? process.env.OPENWORK_DATA_DIR;
  if (override && override.trim()) {
    return resolve(override.trim());
  }
  return join(homedir(), ".openwork", "openwork-orchestrator");
}

function resolveInternalDevMode(flags: Map<string, string | boolean>): boolean {
  return readBool(flags, "internal-dev-mode", false, "OPENWORK_DEV_MODE");
}

function resolveOpencodeStateLayout(options: {
  dataDir: string;
  workspace: string;
  devMode: boolean;
}): OpencodeStateLayout {
  const workspaceId = workspaceIdForLocal(options.workspace);
  if (!options.devMode) {
    const envConfigDir = process.env.OPENCODE_CONFIG_DIR?.trim();
    const configDir = envConfigDir || join(options.dataDir, "opencode-config", workspaceId);
    return {
      devMode: false,
      rootDir: configDir,
      configDir,
      env: {},
    };
  }

  const rootDir = join(options.dataDir, "opencode-dev", workspaceId);
  const homeDir = join(rootDir, "home");
  const xdgConfigHome = join(rootDir, "xdg", "config");
  const xdgDataHome = join(rootDir, "xdg", "data");
  const xdgCacheHome = join(rootDir, "xdg", "cache");
  const xdgStateHome = join(rootDir, "xdg", "state");
  const configDir = join(rootDir, "config", "opencode");

  return {
    devMode: true,
    rootDir,
    configDir,
    importConfigDir: process.env.OPENWORK_DEV_OPENCODE_IMPORT_CONFIG_DIR?.trim() || undefined,
    importDataDir: process.env.OPENWORK_DEV_OPENCODE_IMPORT_DATA_DIR?.trim() || undefined,
    env: {
      OPENWORK_DEV_MODE: "1",
      HOME: homeDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_STATE_HOME: xdgStateHome,
      OPENCODE_CONFIG_DIR: configDir,
      SC_RUNTIME_CONFIG_DIR: "/data/superclaw/runtime",
    },
  };
}

async function ensureOpencodeStateLayout(layout: OpencodeStateLayout): Promise<void> {
  await mkdir(layout.configDir, { recursive: true });
  if (!layout.devMode) return;

  const homeDir = layout.env.HOME;
  const xdgConfigHome = layout.env.XDG_CONFIG_HOME;
  const xdgDataHome = layout.env.XDG_DATA_HOME;
  const xdgCacheHome = layout.env.XDG_CACHE_HOME;
  const xdgStateHome = layout.env.XDG_STATE_HOME;
  const opencodeDataDir = xdgDataHome ? join(xdgDataHome, "opencode") : undefined;

  for (const dir of [layout.rootDir, homeDir, xdgConfigHome, xdgDataHome, xdgCacheHome, xdgStateHome, opencodeDataDir]) {
    if (!dir) continue;
    await mkdir(dir, { recursive: true });
  }

  if (layout.importConfigDir && (await isDir(layout.importConfigDir))) {
    const entries = await readdir(layout.configDir).catch(() => [] as string[]);
    if (entries.length === 0) {
      await cp(layout.importConfigDir, layout.configDir, { recursive: true, force: false }).catch(() => undefined);
    }
  }

  if (layout.importDataDir && opencodeDataDir && (await isDir(layout.importDataDir))) {
    for (const file of ["auth.json", "mcp-auth.json"]) {
      const dest = join(opencodeDataDir, file);
      if (await fileExists(dest)) continue;
      const source = join(layout.importDataDir, file);
      if (await fileExists(source)) {
        await copyFile(source, dest).catch(() => undefined);
      }
    }
  }
}

function routerStatePath(dataDir: string): string {
  return join(dataDir, "openwork-orchestrator-state.json");
}

function nowMs(): number {
  return Date.now();
}

async function loadRouterState(path: string): Promise<RouterState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as RouterState;
    if (!parsed.workspaces) parsed.workspaces = [];
    if (!parsed.activeId) parsed.activeId = "";
    if (!parsed.version) parsed.version = 1;
    return parsed;
  } catch {
    return {
      version: 1,
      daemon: undefined,
      opencode: undefined,
      cliVersion: undefined,
      sidecar: undefined,
      binaries: undefined,
      activeId: "",
      workspaces: [],
    };
  }
}

async function saveRouterState(path: string, state: RouterState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const payload = JSON.stringify(state, null, 2);
  await writeFile(path, `${payload}\n`, "utf8");
}

function normalizeWorkspacePath(input: string): string {
  return resolve(input).replace(/[\\/]+$/, "");
}

function workspaceIdForLocal(path: string): string {
  return `ws-${createHash("sha1").update(path).digest("hex").slice(0, 12)}`;
}

function workspaceIdForRemote(baseUrl: string, directory?: string | null): string {
  const key = directory ? `${baseUrl}::${directory}` : baseUrl;
  return `ws-${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
}

async function ensureOpencodeManagedTools(configDir: string): Promise<void> {
  const toolsDir = join(configDir, "tools");
  await mkdir(toolsDir, { recursive: true });
  const writeManagedTool = async (name: string, source: string) => {
    const toolPath = join(toolsDir, name);
    const content = `${source}\n`;
    try {
      const existing = await readFile(toolPath, "utf8");
      if (existing === content) return;
    } catch {
      // ignore
    }
    await writeFile(toolPath, content, "utf8");
  };

  await writeManagedTool("opencode_router_send.ts", opencodeRouterSendToolSource());
  await writeManagedTool("opencode_router_status.ts", opencodeRouterStatusToolSource());
}

function findWorkspace(state: RouterState, input: string): RouterWorkspace | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const direct = state.workspaces.find((entry) => entry.id === trimmed || entry.name === trimmed);
  if (direct) return direct;
  const normalized = normalizeWorkspacePath(trimmed);
  return state.workspaces.find((entry) => entry.path && normalizeWorkspacePath(entry.path) === normalized);
}

function isProcessAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveSelfCommand(): { command: string; prefixArgs: string[] } {
  const arg1 = process.argv[1];
  if (!arg1) return { command: process.argv[0], prefixArgs: [] };
  if (arg1.endsWith(".js") || arg1.endsWith(".ts")) {
    return { command: process.argv[0], prefixArgs: [arg1] };
  }
  return { command: process.argv[0], prefixArgs: [] };
}

async function waitForHealthy(url: string, timeoutMs = 10_000, pollMs = 250): Promise<void> {
  const start = Date.now();
  let lastError: string | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      // egress-surface: supervisor_health_openwork
      const response = await fetch(`${url.replace(/\/$/, "")}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for health check");
}

async function fetchOpenCodeRouterHealth(baseUrl: string): Promise<OpenCodeRouterHealthSnapshot> {
  return (await fetchJson(`${baseUrl.replace(/\/$/, "")}/health`)) as OpenCodeRouterHealthSnapshot;
}

async function fetchOpenCodeRouterHealthViaOpenwork(openworkUrl: string, token: string): Promise<OpenCodeRouterHealthSnapshot> {
  const url = `${openworkUrl.replace(/\/$/, "")}/opencode-router/health`;
  return (await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })) as OpenCodeRouterHealthSnapshot;
}

async function waitForOpenCodeRouterHealthy(baseUrl: string, timeoutMs = 10_000, pollMs = 500) {
  const start = Date.now();
  let lastError: string | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      // egress-surface: supervisor_health_opencode_router
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
      if (response.ok) {
        return (await response.json()) as OpenCodeRouterHealthSnapshot;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for opencodeRouter health");
}

async function waitForOpencodeHealthy(
  client: ReturnType<typeof createOpencodeClient>,
  timeoutMs = 10_000,
  pollMs = 250,
  fallback?: { baseUrl: string; headers?: Record<string, string> },
) {
  return waitForOpencodeHealthyImpl(client, { timeoutMs, pollMs, fallback });
}

/**
 * Build the auth header set used by every opencode HTTP request the
 * orchestrator makes (SDK client + manual fetch). Single source of truth so
 * adding a new scheme (cookie, mTLS, etc.) only requires editing one place.
 */
function buildOpencodeAuthHeaders(
  username: string | undefined,
  password: string | undefined,
): Record<string, string> {
  if (username && password) {
    return { Authorization: `Basic ${encodeBasicAuth(username, password)}` };
  }
  return {};
}

function printHelp(): void {
  const message = [
    "openwork",
    "",
    "Usage:",
    "  openwork start [--workspace <path>] [options]",
    "  openwork serve [--workspace <path>] [options]",
    "  openwork daemon [run|start|stop|status] [options]",
    "  openwork workspace <action> [options]",
    "  openwork instance dispose <id> [options]",
    "  openwork approvals list --openwork-url <url> --host-token <token>",
    "  openwork approvals reply <id> --allow|--deny --openwork-url <url> --host-token <token>",
    "  openwork files <action> [options]",
    "  openwork status [--openwork-url <url>] [--opencode-url <url>]",
    "",
    "Commands:",
    "  start                   Start OpenCode + OpenWork server + OpenCodeRouter",
    "  serve                   Start services and stream logs (no TUI)",
    "  daemon                  Run orchestrator router daemon (multi-workspace)",
    "  workspace               Manage workspaces (add/list/switch/path)",
    "  instance                Manage workspace instances (dispose)",
    "  approvals list           List pending approval requests",
    "  approvals reply <id>     Approve or deny a request",
    "  files                   Manage file sessions and batch file sync",
    "  status                  Check OpenCode/OpenWork health",
    "",
    "Options:",
    "  --workspace <path>        Workspace directory (default: cwd)",
    "  --data-dir <path>         Data dir for orchestrator router state",
    "  --daemon-host <host>      Host for orchestrator router daemon (default: 127.0.0.1)",
    "  --daemon-port <port>      Port for orchestrator router daemon (default: random)",
    "  --opencode-bin <path>     Path to opencode binary (requires --allow-external)",
    "  --opencode-host <host>    Bind host for opencode serve (default: 127.0.0.1)",
    "  --opencode-port <port>    Port for opencode serve (default: random)",
    "  --external-opencode       Connect to an already managed OpenCode runtime",
    "  --opencode-workdir <p>    Workdir for router-managed opencode serve",
    "  --opencode-auth           Enable OpenCode basic auth (default: true)",
    "  --no-opencode-auth        Disable OpenCode basic auth",
    "  --opencode-hot-reload     Enable OpenCode hot reload (default: true)",
    "  --opencode-hot-reload-debounce-ms <ms>  Debounce window for hot reload triggers (default: 700)",
    "  --opencode-hot-reload-cooldown-ms <ms>  Minimum interval between hot reloads (default: 1500)",
    "  --opencode-username <u>   OpenCode basic auth username",
    "  --opencode-password <p>   OpenCode basic auth password",
    "  --openwork-host <host>    Bind host for openwork-server (default: 127.0.0.1)",
    "  --openwork-port <port>    Port for openwork-server (default: 8787)",
    "  --openwork-token <token>  Client token for openwork-server",
    "  --openwork-host-token <t> Host token for approvals",
    "  --workspace-id <id>       Workspace id for file session commands",
    "  --session-id <id>         File session id for file session commands",
    "  --path <path>             Workspace-relative file path",
    "  --paths <list>            Comma-separated list of workspace-relative file paths",
    "  --ttl-seconds <n>         File session TTL in seconds",
    "  --content <text>          Inline content for file writes",
    "  --content-base64 <b64>    Base64 content for file writes",
    "  --file <path>             Local file path for file writes",
    "  --if-match <revision>     Revision precondition for file writes",
    "  --from <path>             Source path for rename",
    "  --to <path>               Destination path for rename",
    "  --write                   Request writable file session",
    "  --force                   Force write despite revision mismatch",
    "  --recursive               Recursive delete for files delete",
    "  --approval <mode>         manual | auto (default: manual)",
    "  --approval-timeout <ms>   Approval timeout in ms",
    "  --read-only               Start OpenWork server in read-only mode",
    "  --cors <origins>          Comma-separated CORS origins or *",
    "  --connect-host <host>     Override LAN host used for pairing URLs",
    "  --openwork-server-bin <p> Path to openwork-server binary (requires --allow-external)",
    "  --external-openwork-server       Connect to an already managed openwork-server",
    "  --opencode-router-bin <path>     Path to opencodeRouter binary (requires --allow-external)",
    "  --external-opencode-router       Connect to an already managed opencodeRouter",
    "  --opencode-router-health-port <p> Health server port for opencodeRouter (default: random)",
    "  --no-opencode-router             Disable opencodeRouter sidecar",
    "  --opencode-router-required       Exit if opencodeRouter stops",
    "  --llmrouter-port <port>          Windows-host LLMRouter (llmrouter_manager) port (default: 18321)",
    "  --hybrid-dr-port <port>          Hybrid Deep Research sidecar port (default: 18324)",
    "  --hybrid-dr-bin <path>           Hybrid Deep Research sidecar binary",
    "  --hybrid-dr-python-bin <path>    Python binary for Hybrid Deep Research sidecar",
    "  --allow-external          Allow external sidecar binaries (dev only, required for custom bins)",
    "  --sidecar-dir <path>      Cache directory for downloaded sidecars",
    "  --sidecar-base-url <url>  Base URL for sidecar downloads",
    "  --sidecar-manifest <url>  Override sidecar manifest URL",
    "  --sidecar-source <mode>   auto | bundled | downloaded | external",
    "  --opencode-source <mode>  auto | bundled | downloaded | external",
    "  --check                   Run health checks then exit",
    "  --check-events            Verify SSE events during check",
    "  --tui                     Force interactive dashboard (TTY only)",
    "  --no-tui                  Disable interactive dashboard",
    "  --detach                  Detach after start and keep services running",
    "  --json                    Output JSON when applicable",
    "  --verbose                 Print additional diagnostics",
    "  --log-format <format>     Log output format: pretty | json",
    "  --color                   Force ANSI color output",
    "  --no-color                Disable ANSI color output",
    "  --run-id <id>             Correlation id for logs (default: random UUID)",
    "  --help                    Show help",
    "  --version                 Show version",
  ].join("\n");
  console.log(message);
}

async function stopChild(child: ReturnType<typeof spawn>, timeoutMs = 2500): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
  if (exited) return;
  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
}

async function startOpencode(options: {
  bin: string;
  workspace: string;
  stateLayout?: OpencodeStateLayout;
  hotReload: OpencodeHotReload;
  bindHost: string;
  port: number;
  username?: string;
  password?: string;
  corsOrigins: string[];
  logger: Logger;
  runId: string;
  logFormat: LogFormat;
  opencodeRouterHealthPort?: number;
  controlToken?: string;
  telemetryToken?: string;
}) {
  const args = ["serve", "--hostname", options.bindHost, "--port", String(options.port)];
  for (const origin of options.corsOrigins) {
    args.push("--cors", origin);
  }

  const resolved = resolveBinCommand(options.bin);
  const env = buildOpencodeProcessEnv(process.env, options.stateLayout, options);

  const child = spawnProcess(resolved.command, [...resolved.prefixArgs, ...args], {
    cwd: options.workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  prefixStream(child.stdout, "opencode", "stdout", options.logger, child.pid ?? undefined);
  prefixStream(child.stderr, "opencode", "stderr", options.logger, child.pid ?? undefined);

  return child;
}

async function startOpenworkServer(options: {
  bin: string;
  host: string;
  port: number;
  workspace: string;
  token: string;
  hostToken?: string;
  telemetryToken: string;
  approvalMode: ApprovalMode;
  approvalTimeoutMs: number;
  readOnly: boolean;
  corsOrigins: string[];
  opencodeBaseUrl?: string;
  opencodeDirectory?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  opencodeRouterHealthPort?: number;
  opencodeRouterDataDir?: string;
  routerControlToken?: string;
  llmrouterUrl?: string;
  controlBaseUrl?: string;
  controlToken?: string;
  intentClassifierToken?: string;
  logger: Logger;
  runId: string;
  logFormat: LogFormat;
}) {
  const args = [
    "--host",
    options.host,
    "--port",
    String(options.port),
    "--token",
    options.token,
    "--workspace",
    options.workspace,
    "--approval",
    options.approvalMode,
    "--approval-timeout",
    String(options.approvalTimeoutMs),
  ];
  if (options.hostToken) args.push("--host-token", options.hostToken);

  if (options.readOnly) {
    args.push("--read-only");
  }

  if (options.corsOrigins.length) {
    args.push("--cors", options.corsOrigins.join(","));
  }

  if (options.opencodeBaseUrl) {
    args.push("--opencode-base-url", options.opencodeBaseUrl);
  }
  if (options.opencodeDirectory) {
    args.push("--opencode-directory", options.opencodeDirectory);
  }
  if (options.opencodeUsername) {
    args.push("--opencode-username", options.opencodeUsername);
  }
  if (options.opencodePassword) {
    args.push("--opencode-password", options.opencodePassword);
  }
  if (options.logFormat) {
    args.push("--log-format", options.logFormat);
  }

  const env = buildOpenworkServerEnv(process.env, options);
  removeInheritedHdrCredentials(env);

  const resolved = resolveBinCommand(options.bin);
  const child = spawnProcess(resolved.command, [...resolved.prefixArgs, ...args], {
    cwd: options.workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  prefixStream(child.stdout, "openwork-server", "stdout", options.logger, child.pid ?? undefined);
  prefixStream(child.stderr, "openwork-server", "stderr", options.logger, child.pid ?? undefined);

  return child;
}

async function startOpenCodeRouter(options: {
  bin: string;
  workspace: string;
  opencodeUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  opencodeRouterHealthPort?: number;
  opencodeRouterDataDir?: string;
  controlToken: string;
  llmrouterUrl?: string;
  /**
   * Classifier endpoint and credential to advertise to the Slack/Telegram bridge, or null when
   * this Product Profile does not run the sidecar. See buildOpenCodeRouterEnv —
   * null must clear any inherited URL and token, not just skip setting one.
   */
  intentClassifier?: IntentClassifierEndpoint | null;
  logger: Logger;
  runId: string;
  logFormat: LogFormat;
}) {
  const args = ["serve", options.workspace];
  if (options.opencodeUrl) {
    const supports = await opencodeRouterSupportsOpencodeUrl(options.bin);
    if (supports) {
      args.push("--opencode-url", options.opencodeUrl);
    }
  }

  const resolved = resolveBinCommand(options.bin);
  const child = spawnProcess(resolved.command, [...resolved.prefixArgs, ...args], {
    cwd: options.workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: buildOpenCodeRouterEnv(options, process.env),
  });

  prefixStream(child.stdout, "opencode-router", "stdout", options.logger, child.pid ?? undefined);
  prefixStream(child.stderr, "opencode-router", "stderr", options.logger, child.pid ?? undefined);

  return child;
}

async function opencodeRouterSupportsOpencodeUrl(bin: string): Promise<boolean> {
  const resolved = resolveBinCommand(bin);
  return new Promise((resolve) => {
    const child = spawnProcess(resolved.command, [...resolved.prefixArgs, "--help"], {
      cwd: tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(output.includes("--opencode-url"));
    }, 1500);

    const onChunk = (chunk: unknown) => {
      output += String(chunk ?? "");
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("exit", () => {
      clearTimeout(timeout);
      resolve(output.includes("--opencode-url"));
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function verifyOpenCodeRouterVersion(binary: ResolvedBinary): Promise<string | undefined> {
  if (binary.source !== "external") {
    return binary.expectedVersion;
  }
  const actual = await readCliVersion(binary.bin);
  assertVersionMatch("opencode-router", binary.expectedVersion, actual, binary.bin);
  return actual;
}

async function verifyOpencodeVersion(binary: ResolvedBinary): Promise<string | undefined> {
  const actual = await readCliVersion(binary.bin);
  // When the binary was explicitly provided via --opencode-bin (source "external"),
  // a strict version check would break desktop app users whenever a new opencode
  // release ships on GitHub before OpenWork updates its bundled binary. Log a
  // warning instead of throwing so the caller can still proceed.
  if (binary.source === "external" && binary.expectedVersion && actual && binary.expectedVersion !== actual) {
    process.stderr.write(
      `[openwork-orchestrator] Warning: opencode version mismatch (expected ${binary.expectedVersion}, got ${actual}). Proceeding with ${binary.bin}.\n`,
    );
    return actual;
  }
  assertVersionMatch("opencode", binary.expectedVersion, actual, binary.bin);
  return actual;
}

async function verifyOpenworkServer(input: {
  baseUrl: string;
  token: string;
  hostToken?: string;
  expectedVersion?: string;
  expectedWorkspace: string;
  expectedOpencodeBaseUrl?: string;
  expectedOpencodeDirectory?: string;
  expectedOpencodeUsername?: string;
}): Promise<string | undefined> {
  const health = await fetchJson(`${input.baseUrl}/health`);
  const actualVersion = typeof health?.version === "string" ? health.version : undefined;
  assertVersionMatch("openwork-server", input.expectedVersion, actualVersion, `${input.baseUrl}/health`);

  const headers = { Authorization: `Bearer ${input.token}` };
  const workspaces = await fetchJson(`${input.baseUrl}/workspaces`, { headers });
  const items = Array.isArray(workspaces?.items) ? (workspaces.items as Array<Record<string, unknown>>) : [];
  if (!items.length) {
    throw new Error("OpenWork server returned no workspaces");
  }

  const expectedPath = normalizeWorkspacePath(input.expectedWorkspace);
  const matched = items.find((item) => {
    const candidate = item as { path?: string };
    const path = typeof candidate.path === "string" ? candidate.path : "";
    return path && normalizeWorkspacePath(path) === expectedPath;
  }) as
    | {
        id?: string;
        path?: string;
        opencode?: { baseUrl?: string; directory?: string; username?: string };
      }
    | undefined;

  if (!matched) {
    throw new Error(`OpenWork server workspace mismatch. Expected ${expectedPath}.`);
  }

  const opencode = matched.opencode;
  if (input.expectedOpencodeBaseUrl && opencode?.baseUrl !== input.expectedOpencodeBaseUrl) {
    throw new Error(
      `OpenWork server OpenCode base URL mismatch: expected ${input.expectedOpencodeBaseUrl}, got ${opencode?.baseUrl ?? "<missing>"}.`,
    );
  }
  if (input.expectedOpencodeDirectory && opencode?.directory !== input.expectedOpencodeDirectory) {
    throw new Error(
      `OpenWork server OpenCode directory mismatch: expected ${input.expectedOpencodeDirectory}, got ${opencode?.directory ?? "<missing>"}.`,
    );
  }
  if (input.expectedOpencodeUsername && opencode?.username !== input.expectedOpencodeUsername) {
    throw new Error("OpenWork server OpenCode username mismatch.");
  }

  if (input.hostToken) {
    await fetchJson(`${input.baseUrl}/approvals`, { headers: hostTokenHeaders(input.hostToken) });
  }

  return actualVersion;
}

async function installGlobalPackages(packages: string[]): Promise<void> {
  if (!packages.length) return;
  await captureCommandOutput("npm", ["install", "-g", ...packages], { timeoutMs: 5 * 60_000 });
}

function buildRuntimeServiceSnapshot(input: {
  name: RuntimeServiceName;
  enabled: boolean;
  running: boolean;
  binary?: ResolvedBinary | null;
  actualVersion?: string;
}): RuntimeServiceSnapshot {
  const targetVersion = input.binary?.expectedVersion;
  const actualVersion = input.actualVersion;
  return {
    name: input.name,
    enabled: input.enabled,
    running: input.enabled ? input.running : false,
    source: input.binary?.source,
    path: input.binary?.bin,
    targetVersion,
    actualVersion,
    upgradeAvailable: Boolean(input.enabled && targetVersion && actualVersion && targetVersion !== actualVersion),
  };
}

async function runChecks(input: {
  opencodeClient: ReturnType<typeof createOpencodeClient>;
  openworkUrl: string;
  openworkToken: string;
  hostToken?: string;
  checkEvents: boolean;
}) {
  const baseUrl = input.openworkUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${input.openworkToken}` };
  const workspaces = await fetchJson(`${baseUrl}/workspaces`, { headers });
  if (!workspaces?.items?.length) {
    throw new Error("OpenWork server returned no workspaces");
  }

  const workspaceId = workspaces.items[0].id as string;
  await fetchJson(`${baseUrl}/workspace/${workspaceId}/config`, { headers });

  // Smoke test: mounted opencodeRouter proxy and auth behavior.
  // - /w/:id/opencode-router/health is client-readable
  // - other /w/:id/opencode-router/* requires host/owner auth
  const owMountBase = `${baseUrl}/w/${encodeURIComponent(workspaceId)}/opencode-router`;
  // egress-surface: supervisor_health_opencode_router
  const owHealthRes = await fetch(`${owMountBase}/health`, {
    headers,
    signal: AbortSignal.timeout(3000),
  });
  if (owHealthRes.status >= 500) {
    throw new Error(`opencodeRouter mount proxy returned ${owHealthRes.status}`);
  }
  const owConfigured = owHealthRes.status !== 404;
  if (owConfigured) {
    // egress-surface: supervisor_openwork_api
    const clientRes = await fetch(`${owMountBase}/config/groups`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (clientRes.status === 200) {
      throw new Error("opencodeRouter mount proxy /config/groups should require host auth");
    }
    if (clientRes.status !== 401 && clientRes.status !== 403) {
      throw new Error(`opencodeRouter mount proxy /config/groups unexpected status: ${clientRes.status}`);
    }

    if (input.hostToken) {
      await verifyHostProxyAccess(`${owMountBase}/config/groups`, input.hostToken);
    }
  }

  const created = await input.opencodeClient.session.create({ title: "OpenWork headless check" });
  const createdSession = unwrap(created);
  unwrap(await input.opencodeClient.session.messages({ sessionID: createdSession.id, limit: 10 }));

  if (input.checkEvents) {
    const events: { type: string }[] = [];
    const controller = new AbortController();
    const subscription = await input.opencodeClient.event.subscribe(undefined, { signal: controller.signal });
    const reader = (async () => {
      try {
        for await (const raw of subscription.stream) {
          const normalized = normalizeEvent(raw);
          if (!normalized) continue;
          events.push(normalized);
          if (events.length >= 10) break;
        }
      } catch {
        // ignore
      }
    })();

    unwrap(await input.opencodeClient.session.create({ title: "OpenWork headless check events" }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    controller.abort();
    await Promise.race([reader, new Promise((resolve) => setTimeout(resolve, 500))]);

    if (!events.length) {
      throw new Error("No SSE events observed during check");
    }
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  // egress-surface: supervisor_openwork_api
  const response = await fetch(url, init);
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.message ? ` ${payload.message}` : "";
    throw new Error(`HTTP ${response.status}${message}`);
  }
  return payload;
}

async function issueOpenworkOwnerToken(baseUrl: string, hostToken: string, label = "OpenWork owner token"): Promise<string> {
  const payload = await fetchJson(`${baseUrl.replace(/\/$/, "")}/tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-OpenWork-Host-Token": hostToken,
    },
    body: JSON.stringify({ scope: "owner", label }),
  });
  const token = typeof payload?.token === "string" ? payload.token.trim() : "";
  if (!token) {
    throw new Error("OpenWork server did not return an owner token");
  }
  return token;
}

function normalizeEvent(raw: unknown): { type: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.type === "string") return { type: record.type };
  const payload = record.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload.type === "string") return { type: payload.type };
  return null;
}

async function waitForRouterHealthy(baseUrl: string, timeoutMs = 10_000, pollMs = 250): Promise<void> {
  const start = Date.now();
  let lastError: string | null = null;
  const url = baseUrl.replace(/\/$/, "");
  while (Date.now() - start < timeoutMs) {
    try {
      // egress-surface: supervisor_daemon_control
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for daemon health");
}

function outputResult(payload: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (typeof payload === "string") {
    console.log(payload);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

function outputError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    return;
  }
  console.error(message);
}

function createVerboseLogger(enabled: boolean, logger?: Logger, component = "openwork-orchestrator") {
  return (message: string) => {
    if (!enabled) return;
    if (logger) {
      logger.debug(message, undefined, component);
      return;
    }
    console.log(`[${component}] ${message}`);
  };
}

const LOG_LEVEL_NUMBERS: Record<LogLevel, number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

const ANSI = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function colorize(input: string, color: string, enabled: boolean): string {
  if (!enabled) return input;
  return `${color}${input}${ANSI.reset}`;
}

function toUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function createLogger(options: {
  format: LogFormat;
  runId: string;
  serviceName: string;
  serviceVersion?: string;
  output?: "stdout" | "silent";
  color?: boolean;
  onLog?: (event: LogEvent) => void;
}): Logger {
  const host = hostname().trim();
  // Startup-logging unification (2026-07-21 §4.5): the launch correlation key is
  // injected into the environment as SUPERCLAW_BOOT_ID. The pretty
  // branch below does NOT emit attributes/resource (only the json branch does),
  // so it must be prepended to the pretty line explicitly or it would never
  // appear in runtime-*.log. Read once at logger construction.
  const bootId = (process.env.SUPERCLAW_BOOT_ID ?? "").trim();
  const resource: Record<string, string> = {
    "service.name": options.serviceName,
    "service.instance.id": options.runId,
  };
  if (options.serviceVersion) {
    resource["service.version"] = options.serviceVersion;
  }
  if (host) {
    resource["host.name"] = host;
  }
  const baseAttributes: LogAttributes = {
    "run.id": options.runId,
    "process.pid": process.pid,
    ...(bootId ? { "boot.id": bootId } : {}),
  };
  const output = options.output ?? "stdout";
  const colorEnabled = options.color ?? false;
  const componentColors: Record<string, string> = {
    "openwork-orchestrator": ANSI.gray,
    opencode: ANSI.cyan,
    "openwork-server": ANSI.green,
    opencodeRouter: ANSI.magenta,
    "openwork-orchestrator-router": ANSI.cyan,
  };
  const levelColors: Record<LogLevel, string> = {
    debug: ANSI.gray,
    info: ANSI.gray,
    warn: ANSI.yellow,
    error: ANSI.red,
  };

  const emit = (level: LogLevel, message: string, attributes?: LogAttributes, component?: string) => {
    const mergedAttributes: LogAttributes = {
      ...baseAttributes,
      ...(component ? { "service.component": component } : {}),
      ...(attributes ?? {}),
    };
    options.onLog?.({
      time: Date.now(),
      level,
      message,
      component,
      attributes: mergedAttributes,
    });
    if (output === "silent") return;
    if (options.format === "json") {
      const record = {
        timeUnixNano: toUnixNano(),
        severityText: level.toUpperCase(),
        severityNumber: LOG_LEVEL_NUMBERS[level],
        body: message,
        attributes: mergedAttributes,
        resource,
      };
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return;
    }
    const label = component ?? options.serviceName;
    const tagLabel = label ? `[${label}]` : "";
    const levelTag = level === "info" ? "" : level.toUpperCase();
    const coloredLabel = tagLabel
      ? colorize(tagLabel, componentColors[label] ?? ANSI.gray, colorEnabled)
      : "";
    const coloredLevel = levelTag
      ? colorize(levelTag, levelColors[level] ?? ANSI.gray, colorEnabled)
      : "";
    const tag = [coloredLabel, coloredLevel].filter(Boolean).join(" ");
    const line = tag ? `${tag} ${message}` : message;
    // Prepend boot_id so a single correlation key greps the full cross-process
    // startup timeline through runtime-*.log. Skipped when unset (standalone runs).
    const prefixed = prefixPrettyLineWithBootId(line, bootId);
    process.stdout.write(`${prefixed}\n`);
  };

  const child = (component: string, attributes?: LogAttributes): LoggerChild => ({
    log: (level, message, attrs) => emit(level, message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
    debug: (message, attrs) => emit("debug", message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
    info: (message, attrs) => emit("info", message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
    warn: (message, attrs) => emit("warn", message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
    error: (message, attrs) => emit("error", message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
  });

  return {
    format: options.format,
    output,
    log: emit,
    debug: (message, attrs, component) => emit("debug", message, attrs, component),
    info: (message, attrs, component) => emit("info", message, attrs, component),
    warn: (message, attrs, component) => emit("warn", message, attrs, component),
    error: (message, attrs, component) => emit("error", message, attrs, component),
    child,
  };
}

function looksLikeOtelLogLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return false;
    return typeof parsed.timeUnixNano === "string" && typeof parsed.severityText === "string";
  } catch {
    return false;
  }
}

function buildAttachCommand(input: {
  url: string;
  workspace: string;
  username?: string;
  password?: string;
}): string {
  const parts: string[] = [];
  if (input.username && input.password && input.username !== DEFAULT_OPENCODE_USERNAME) {
    parts.push(`OPENCODE_SERVER_USERNAME=${input.username}`);
  }
  if (input.password) {
    parts.push(`OPENCODE_SERVER_PASSWORD=${input.password}`);
  }
  parts.push("opencode", "attach", input.url, "--dir", input.workspace);
  return parts.join(" ");
}

async function runClipboardCommand(command: string, args: string[], text: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawnProcess(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.stdin?.write(text);
    child.stdin?.end();
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function copyToClipboard(text: string): Promise<{ copied: boolean; error?: string }> {
  const platform = process.platform;
  const commands: Array<{ command: string; args: string[] }> = [];
  if (platform === "darwin") {
    commands.push({ command: "pbcopy", args: [] });
  } else if (platform === "win32") {
    commands.push({ command: "clip", args: [] });
  } else {
    commands.push({ command: "wl-copy", args: [] });
    commands.push({ command: "xclip", args: ["-selection", "clipboard"] });
    commands.push({ command: "xsel", args: ["--clipboard", "--input"] });
  }
  for (const entry of commands) {
    try {
      const ok = await runClipboardCommand(entry.command, entry.args, text);
      if (ok) return { copied: true };
    } catch {
      // ignore
    }
  }
  return { copied: false, error: "Clipboard unavailable" };
}

async function spawnRouterDaemon(args: ParsedArgs, dataDir: string, host: string, port: number) {
  const self = resolveSelfCommand();
  const commandArgs = [
    ...self.prefixArgs,
    "daemon",
    "run",
    "--data-dir",
    dataDir,
    "--daemon-host",
    host,
    "--daemon-port",
    String(port),
  ];

  const opencodeBin = readFlag(args.flags, "opencode-bin") ?? process.env.OPENWORK_OPENCODE_BIN;
  const opencodeHost = readFlag(args.flags, "opencode-host") ?? process.env.OPENWORK_OPENCODE_HOST;
  const opencodePort = readFlag(args.flags, "opencode-port") ?? process.env.OPENWORK_OPENCODE_PORT;
  const opencodeWorkdir = readFlag(args.flags, "opencode-workdir") ?? process.env.OPENWORK_OPENCODE_WORKDIR;
  const opencodeHotReload =
    readFlag(args.flags, "opencode-hot-reload") ??
    process.env.OPENWORK_OPENCODE_HOT_RELOAD;
  const opencodeHotReloadDebounceMs =
    readFlag(args.flags, "opencode-hot-reload-debounce-ms") ??
    process.env.OPENWORK_OPENCODE_HOT_RELOAD_DEBOUNCE_MS;
  const opencodeHotReloadCooldownMs =
    readFlag(args.flags, "opencode-hot-reload-cooldown-ms") ??
    process.env.OPENWORK_OPENCODE_HOT_RELOAD_COOLDOWN_MS;
  const opencodeUsername = readFlag(args.flags, "opencode-username") ?? process.env.OPENWORK_OPENCODE_USERNAME;
  const opencodePassword = readFlag(args.flags, "opencode-password") ?? process.env.OPENWORK_OPENCODE_PASSWORD;
  const corsValue = readFlag(args.flags, "cors") ?? process.env.OPENWORK_OPENCODE_CORS;
  const allowExternal = readBool(args.flags, "allow-external", false, "OPENWORK_ALLOW_EXTERNAL");
  const sidecarSource = readFlag(args.flags, "sidecar-source") ?? process.env.OPENWORK_SIDECAR_SOURCE;
  const opencodeSource = readFlag(args.flags, "opencode-source") ?? process.env.OPENWORK_OPENCODE_SOURCE;
  const verbose = readBool(args.flags, "verbose", false, "OPENWORK_VERBOSE");
  const logFormat = readFlag(args.flags, "log-format") ?? process.env.OPENWORK_LOG_FORMAT;
  const runId = readFlag(args.flags, "run-id") ?? process.env.OPENWORK_RUN_ID;

  if (opencodeBin) commandArgs.push("--opencode-bin", opencodeBin);
  if (opencodeHost) commandArgs.push("--opencode-host", opencodeHost);
  if (opencodePort) commandArgs.push("--opencode-port", String(opencodePort));
  if (opencodeWorkdir) commandArgs.push("--opencode-workdir", opencodeWorkdir);
  if (opencodeHotReload) commandArgs.push("--opencode-hot-reload", opencodeHotReload);
  if (opencodeHotReloadDebounceMs) commandArgs.push("--opencode-hot-reload-debounce-ms", String(opencodeHotReloadDebounceMs));
  if (opencodeHotReloadCooldownMs) commandArgs.push("--opencode-hot-reload-cooldown-ms", String(opencodeHotReloadCooldownMs));
  if (opencodeUsername) commandArgs.push("--opencode-username", opencodeUsername);
  if (opencodePassword) commandArgs.push("--opencode-password", opencodePassword);
  if (corsValue) commandArgs.push("--cors", corsValue);
  if (allowExternal) commandArgs.push("--allow-external");
  if (sidecarSource) commandArgs.push("--sidecar-source", sidecarSource);
  if (opencodeSource) commandArgs.push("--opencode-source", opencodeSource);
  if (verbose) commandArgs.push("--verbose");
  if (logFormat) commandArgs.push("--log-format", String(logFormat));
  if (runId) commandArgs.push("--run-id", String(runId));

  const child = spawnProcess(self.command, commandArgs, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
    },
  });
  child.unref();
}

async function ensureRouterDaemon(args: ParsedArgs, autoStart = true): Promise<{ baseUrl: string; dataDir: string }> {
  const dataDir = resolveRouterDataDir(args.flags);
  const statePath = routerStatePath(dataDir);
  const state = await loadRouterState(statePath);
  const existing = state.daemon;
  if (existing && existing.baseUrl && isProcessAlive(existing.pid)) {
    try {
      await waitForRouterHealthy(existing.baseUrl, 1500, 150);
      return { baseUrl: existing.baseUrl, dataDir };
    } catch {
      // fallthrough
    }
  }

  if (!autoStart) {
    throw new Error("orchestrator daemon is not running");
  }

  const host = readFlag(args.flags, "daemon-host") ?? "127.0.0.1";
  const port = await resolvePort(
    readNumber(args.flags, "daemon-port", undefined, "OPENWORK_DAEMON_PORT"),
    "127.0.0.1",
  );
  const baseUrl = `http://${host}:${port}`;
  await spawnRouterDaemon(args, dataDir, host, port);
  await waitForRouterHealthy(baseUrl, 10_000, 250);
  return { baseUrl, dataDir };
}

async function requestRouter(args: ParsedArgs, method: string, path: string, body?: unknown, autoStart = true) {
  const { baseUrl } = await ensureRouterDaemon(args, autoStart);
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  return fetchJson(url, {
    method,
    headers,
    body: payload,
  });
}

async function runDaemonCommand(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const subcommand = args.positionals[1] ?? "run";

  try {
    if (subcommand === "run" || subcommand === "foreground") {
      await runRouterDaemon(args);
      return;
    }
    if (subcommand === "start") {
      const { baseUrl } = await ensureRouterDaemon(args, true);
      const status = await fetchJson(`${baseUrl.replace(/\/$/, "")}/health`);
      outputResult({ ok: true, baseUrl, ...status }, outputJson);
      return;
    }
    if (subcommand === "status") {
      const { baseUrl } = await ensureRouterDaemon(args, false);
      const status = await fetchJson(`${baseUrl.replace(/\/$/, "")}/health`);
      outputResult({ ok: true, baseUrl, ...status }, outputJson);
      return;
    }
    if (subcommand === "stop") {
      const { baseUrl } = await ensureRouterDaemon(args, false);
      await fetchJson(`${baseUrl.replace(/\/$/, "")}/shutdown`, { method: "POST" });
      outputResult({ ok: true }, outputJson);
      return;
    }
    throw new Error("daemon requires start|stop|status|run");
  } catch (error) {
    outputError(error, outputJson);
    process.exitCode = 1;
  }
}

async function runWorkspaceCommand(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const subcommand = args.positionals[1];
  const id = args.positionals[2];

  try {
    if (subcommand === "add") {
      if (!id) throw new Error("workspace path is required");
      const name = readFlag(args.flags, "name");
      const result = await requestRouter(args, "POST", "/workspaces", {
        path: id,
        name: name ?? null,
      });
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "add-remote") {
      if (!id) throw new Error("baseUrl is required");
      const directory = readFlag(args.flags, "directory");
      const name = readFlag(args.flags, "name");
      const result = await requestRouter(args, "POST", "/workspaces/remote", {
        baseUrl: id,
        directory: directory ?? null,
        name: name ?? null,
      });
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "list") {
      const result = await requestRouter(args, "GET", "/workspaces");
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "switch") {
      if (!id) throw new Error("workspace id is required");
      const result = await requestRouter(args, "POST", `/workspaces/${encodeURIComponent(id)}/activate`);
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "info") {
      if (!id) throw new Error("workspace id is required");
      const result = await requestRouter(args, "GET", `/workspaces/${encodeURIComponent(id)}`);
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "path") {
      if (!id) throw new Error("workspace id is required");
      const result = await requestRouter(args, "GET", `/workspaces/${encodeURIComponent(id)}/path`);
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    throw new Error("workspace requires add|add-remote|list|switch|info|path");
  } catch (error) {
    outputError(error, outputJson);
    process.exitCode = 1;
  }
}

async function runInstanceCommand(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const subcommand = args.positionals[1];
  const id = args.positionals[2];

  try {
    if (subcommand === "dispose") {
      if (!id) throw new Error("workspace id is required");
      const result = await requestRouter(args, "POST", `/instances/${encodeURIComponent(id)}/dispose`);
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    throw new Error("instance requires dispose");
  } catch (error) {
    outputError(error, outputJson);
    process.exitCode = 1;
  }
}

async function runRouterDaemon(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const verbose = readBool(args.flags, "verbose", false, "OPENWORK_VERBOSE");
  const logFormat = readLogFormat(args.flags, "log-format", "pretty", "OPENWORK_LOG_FORMAT");
  const colorEnabled =
    readBool(args.flags, "color", process.stdout.isTTY, "OPENWORK_COLOR") && !process.env.NO_COLOR;
  const runId = readFlag(args.flags, "run-id") ?? process.env.OPENWORK_RUN_ID ?? randomUUID();
  const telemetryToken = process.env.OPENWORK_TELEMETRY_TOKEN?.trim() || undefined;
  const cliVersion = await resolveCliVersion();
  const logger = createLogger({
    format: logFormat,
    runId,
    serviceName: "openwork-orchestrator",
    serviceVersion: cliVersion,
    output: "stdout",
    color: colorEnabled,
  });
  const logVerbose = createVerboseLogger(verbose && !outputJson, logger, "openwork-orchestrator");
  const sidecarSourceInput = readBinarySource(args.flags, "sidecar-source", "auto", "OPENWORK_SIDECAR_SOURCE");
  const opencodeSourceInput = readBinarySource(args.flags, "opencode-source", "auto", "OPENWORK_OPENCODE_SOURCE");
  const sidecarSource = sidecarSourceInput;
  const opencodeSource = opencodeSourceInput;
  const dataDir = resolveRouterDataDir(args.flags);
  const statePath = routerStatePath(dataDir);
  let state = await loadRouterState(statePath);

  const host = readFlag(args.flags, "daemon-host") ?? "127.0.0.1";
  const port = await resolvePort(
    readNumber(args.flags, "daemon-port", undefined, "OPENWORK_DAEMON_PORT"),
    "127.0.0.1",
  );

  const opencodeBin = readFlag(args.flags, "opencode-bin") ?? process.env.OPENWORK_OPENCODE_BIN;
  const opencodeHost =
    readFlag(args.flags, "opencode-host") ?? process.env.OPENWORK_OPENCODE_HOST ?? "127.0.0.1";
  const opencodePassword =
    readFlag(args.flags, "opencode-password") ??
    process.env.OPENWORK_OPENCODE_PASSWORD ??
    process.env.OPENCODE_SERVER_PASSWORD ??
    randomUUID();
  const opencodeUsername =
    readFlag(args.flags, "opencode-username") ??
    process.env.OPENWORK_OPENCODE_USERNAME ??
    process.env.OPENCODE_SERVER_USERNAME ??
    DEFAULT_OPENCODE_USERNAME;
  const authHeaders = opencodePassword
    ? { Authorization: `Basic ${encodeBasicAuth(opencodeUsername, opencodePassword)}` }
    : undefined;
  const opencodePort = await resolvePort(
    readNumber(args.flags, "opencode-port", state.opencode?.port, "OPENWORK_OPENCODE_PORT"),
    "127.0.0.1",
    state.opencode?.port,
  );
  const opencodeHotReload = readOpencodeHotReload(
    args.flags,
    {
      enabled: true,
      debounceMs: DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS,
      cooldownMs: DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS,
    },
    {
      enabled: "OPENWORK_OPENCODE_HOT_RELOAD",
      debounceMs: "OPENWORK_OPENCODE_HOT_RELOAD_DEBOUNCE_MS",
      cooldownMs: "OPENWORK_OPENCODE_HOT_RELOAD_COOLDOWN_MS",
    },
  );
  const corsValue =
    readFlag(args.flags, "cors") ??
    process.env.OPENWORK_OPENCODE_CORS ??
    "http://localhost:5173,tauri://localhost,http://tauri.localhost";
  const corsOrigins = parseList(corsValue);
  const opencodeWorkdirFlag =
    readFlag(args.flags, "opencode-workdir") ?? process.env.OPENWORK_OPENCODE_WORKDIR;
  const activeWorkspace = state.workspaces.find((entry) => entry.id === state.activeId && entry.workspaceType === "local");
  const opencodeWorkdir = opencodeWorkdirFlag ?? activeWorkspace?.path ?? process.cwd();
  const resolvedWorkdir = await ensureWorkspace(opencodeWorkdir);
  const devMode = resolveInternalDevMode(args.flags);
  const opencodeStateLayout = resolveOpencodeStateLayout({
    dataDir,
    workspace: resolvedWorkdir,
    devMode,
  });
  const opencodeConfigDir = opencodeStateLayout.configDir;
  const productProfileSourceRoot = process.env.SC_PRODUCT_PROFILE_SOURCE_ROOT?.trim() || "/opt/agent-config/profiles";
  const runtimeScaffoldRoot = process.env.SC_OPENCODE_DEPS_ROOT?.trim() || "/opt/opencode-deps";
  const runtimeConfigDir = process.env.SC_RUNTIME_CONFIG_DIR?.trim() || "/data/superclaw/runtime";
  const { layout: daemonProfileLayout, targetProfile: daemonProfile } = await beginAndReconcileProfileDeployment({
    sourceRoot: productProfileSourceRoot,
    configRoot: dirname(opencodeConfigDir),
    marker: join(dirname(opencodeConfigDir), "runtime-profile-publication.json"),
    targetProfile: process.env.SUPERCLAW_PRODUCT_PROFILE,
    runtimeScaffoldRoot,
  });
  await ensureOpencodeStateLayout(opencodeStateLayout);
  await ensureOpencodeManagedTools(opencodeConfigDir);
  logger.info(
    "Daemon starting",
    { runId, logFormat, workdir: resolvedWorkdir, host, port },
    "openwork-orchestrator",
  );

  const sidecar = resolveSidecarConfig(args.flags, cliVersion);
  const allowExternal = readBool(args.flags, "allow-external", false, "OPENWORK_ALLOW_EXTERNAL");
  const manifest = await readVersionManifest();
  logVerbose(`cli version: ${cliVersion}`);
  logVerbose(`sidecar target: ${sidecar.target ?? "unknown"}`);
  logVerbose(`sidecar dir: ${sidecar.dir}`);
  logVerbose(`sidecar base URL: ${sidecar.baseUrl}`);
  logVerbose(`sidecar manifest: ${sidecar.manifestUrl}`);
  logVerbose(`sidecar source: ${sidecarSource}`);
  logVerbose(`opencode source: ${opencodeSource}`);
  logVerbose(
    `opencode hot reload: ${opencodeHotReload.enabled ? "on" : "off"} (debounce=${opencodeHotReload.debounceMs}ms cooldown=${opencodeHotReload.cooldownMs}ms)`,
  );
  logVerbose(`allow external: ${allowExternal ? "true" : "false"}`);
  let opencodeBinary = await resolveOpencodeBin({
    explicit: opencodeBin,
    manifest,
    allowExternal,
    sidecar,
    source: opencodeSource,
  });
  logVerbose(`opencode bin: ${opencodeBinary.bin} (${opencodeBinary.source})`);

  let opencodeChild: ReturnType<typeof spawn> | null = null;

  const updateDiagnostics = (actualVersion?: string) => {
    state.cliVersion = cliVersion;
    state.sidecar = {
      dir: sidecar.dir,
      baseUrl: sidecar.baseUrl,
      manifestUrl: sidecar.manifestUrl,
      target: sidecar.target,
      source: sidecarSource,
      opencodeSource,
      allowExternal,
    };
    state.binaries = {
      opencode: {
        path: opencodeBinary.bin,
        source: opencodeBinary.source,
        expectedVersion: opencodeBinary.expectedVersion,
        actualVersion,
      },
    };
  };

  const ensureOpencode = async () => {
    const existing = state.opencode;
    if (existing && isProcessAlive(existing.pid)) {
      // egress-surface: supervisor_health_opencode
      const client = createOpencodeClient({
        baseUrl: existing.baseUrl,
        directory: resolvedWorkdir,
        headers: authHeaders,
      });
      try {
        await waitForOpencodeHealthy(client, 2000, 200, { baseUrl: existing.baseUrl, headers: authHeaders });
        if (!state.sidecar || !state.cliVersion || !state.binaries?.opencode) {
          updateDiagnostics(state.binaries?.opencode?.actualVersion);
          await saveRouterState(statePath, state);
        }
        return { baseUrl: existing.baseUrl, client };
      } catch {
        // restart
      }
    }

    if (opencodeChild) {
      await stopChild(opencodeChild);
    }

    const opencodeActualVersion = await verifyOpencodeVersion(opencodeBinary);
    logVerbose(`opencode version: ${opencodeActualVersion ?? "unknown"}`);
    const child = await startOpencode({
      bin: opencodeBinary.bin,
      workspace: resolvedWorkdir,
      stateLayout: opencodeStateLayout,
      hotReload: opencodeHotReload,
      bindHost: opencodeHost,
      port: opencodePort,
      username: opencodePassword ? opencodeUsername : undefined,
      password: opencodePassword,
      corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
      logger,
      runId,
      logFormat,
      telemetryToken,
    });
    opencodeChild = child;
    logger.info("Process spawned", { pid: child.pid ?? 0 }, "opencode");
    const baseUrl = `http://${opencodeHost}:${opencodePort}`;
    // egress-surface: supervisor_health_opencode
    const client = createOpencodeClient({
      baseUrl,
      directory: resolvedWorkdir,
      headers: authHeaders,
    });
    const healthStart = Date.now();
    logger.info("Waiting for health", { url: baseUrl }, "opencode");
    await waitForOpencodeHealthy(client, 10_000, 250, { baseUrl, headers: authHeaders });
    const healthDurationMs = Math.round(Date.now() - healthStart);
    logger.info(`Healthy duration_ms=${healthDurationMs}`, { url: baseUrl, durationMs: healthDurationMs }, "opencode");
    state.opencode = {
      pid: child.pid ?? 0,
      port: opencodePort,
      baseUrl,
      startedAt: nowMs(),
    };
    updateDiagnostics(opencodeActualVersion);
    await saveRouterState(statePath, state);
    return { baseUrl, client };
  };

  await ensureOpencode();
  completeProfileTransition(daemonProfileLayout, daemonProfile);

  const server = createHttpServer(async (req, res) => {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    res.on("finish", () => {
      logger.info(
        "Router request",
        {
          method,
          path: url.pathname,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          activeId: state.activeId,
        },
        "openwork-orchestrator-router",
      );
    });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);

    const send = (status: number, payload: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
    };

    const readBody = async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (!chunks.length) return null;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return null;
      return JSON.parse(raw);
    };

    try {
        if (req.method === "GET" && url.pathname === "/health") {
          send(200, {
            ok: true,
            daemon: state.daemon ?? null,
            opencode: state.opencode ?? null,
            activeId: state.activeId,
            workspaceCount: state.workspaces.length,
            cliVersion: state.cliVersion ?? null,
            sidecar: state.sidecar ?? null,
            binaries: state.binaries ?? null,
          });
          return;
        }

      if (req.method === "GET" && url.pathname === "/workspaces") {
        send(200, { activeId: state.activeId, workspaces: state.workspaces });
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces") {
        const body = await readBody();
        const pathInput = typeof body?.path === "string" ? body.path.trim() : "";
        if (!pathInput) {
          send(400, { error: "path is required" });
          return;
        }
        const resolved = await ensureWorkspace(pathInput);
        const id = workspaceIdForLocal(resolved);
        const name = typeof body?.name === "string" && body.name.trim()
          ? body.name.trim()
          : resolved.split(/[\\/]/).filter(Boolean).pop() ?? "Workspace";
        const existing = state.workspaces.find((entry) => entry.id === id);
        const entry: RouterWorkspace = {
          id,
          name,
          path: resolved,
          workspaceType: "local",
          createdAt: existing?.createdAt ?? nowMs(),
          lastUsedAt: nowMs(),
        };
        state.workspaces = state.workspaces.filter((item) => item.id !== id);
        state.workspaces.push(entry);
        if (!state.activeId) state.activeId = id;
        await saveRouterState(statePath, state);
        send(200, { activeId: state.activeId, workspace: entry });
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces/remote") {
        const body = await readBody();
        const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : "";
        if (!baseUrl || (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://"))) {
          send(400, { error: "baseUrl must start with http:// or https://" });
          return;
        }
        const directory = typeof body?.directory === "string" ? body.directory.trim() : "";
        const id = workspaceIdForRemote(baseUrl, directory || undefined);
        const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : baseUrl;
        const existing = state.workspaces.find((entry) => entry.id === id);
        const entry: RouterWorkspace = {
          id,
          name,
          path: directory,
          workspaceType: "remote",
          baseUrl,
          directory: directory || undefined,
          createdAt: existing?.createdAt ?? nowMs(),
          lastUsedAt: nowMs(),
        };
        state.workspaces = state.workspaces.filter((item) => item.id !== id);
        state.workspaces.push(entry);
        if (!state.activeId) state.activeId = id;
        await saveRouterState(statePath, state);
        send(200, { activeId: state.activeId, workspace: entry });
        return;
      }

      if (parts[0] === "workspaces" && parts.length === 2 && req.method === "GET") {
        const workspace = findWorkspace(state, decodeURIComponent(parts[1] ?? ""));
        if (!workspace) {
          send(404, { error: "workspace not found" });
          return;
        }
        send(200, { workspace });
        return;
      }

      if (parts[0] === "workspaces" && parts.length === 3 && parts[2] === "activate" && req.method === "POST") {
        const workspace = findWorkspace(state, decodeURIComponent(parts[1] ?? ""));
        if (!workspace) {
          send(404, { error: "workspace not found" });
          return;
        }
        state.activeId = workspace.id;
        workspace.lastUsedAt = nowMs();
        await saveRouterState(statePath, state);
        send(200, { activeId: state.activeId, workspace });
        return;
      }

      if (parts[0] === "workspaces" && parts.length === 3 && parts[2] === "path" && req.method === "GET") {
        const workspace = findWorkspace(state, decodeURIComponent(parts[1] ?? ""));
        if (!workspace) {
          send(404, { error: "workspace not found" });
          return;
        }
        const isRemote = workspace.workspaceType === "remote";
        const baseUrl = isRemote ? workspace.baseUrl ?? "" : (await ensureOpencode()).baseUrl;
        if (!baseUrl) {
          send(400, { error: "workspace baseUrl missing" });
          return;
        }
        const directory = isRemote ? workspace.directory ?? "" : workspace.path;
        // egress-surface: supervisor_health_opencode
        const client = createOpencodeClient({
          baseUrl,
          directory: directory ? directory : undefined,
          headers: authHeaders,
        });
        const pathInfo = unwrap(await client.path.get());
        workspace.lastUsedAt = nowMs();
        await saveRouterState(statePath, state);
        send(200, { workspace, path: pathInfo });
        return;
      }

      if (parts[0] === "instances" && parts.length === 3 && parts[2] === "dispose" && req.method === "POST") {
        const workspace = findWorkspace(state, decodeURIComponent(parts[1] ?? ""));
        if (!workspace) {
          send(404, { error: "workspace not found" });
          return;
        }
        const isRemote = workspace.workspaceType === "remote";
        const baseUrl = isRemote ? workspace.baseUrl ?? "" : (await ensureOpencode()).baseUrl;
        if (!baseUrl) {
          send(400, { error: "workspace baseUrl missing" });
          return;
        }
        const directory = isRemote ? workspace.directory ?? "" : workspace.path;
        // egress-surface: supervisor_health_opencode
        const response = await fetch(
          `${baseUrl.replace(/\/$/, "")}/instance/dispose?directory=${encodeURIComponent(directory)}`,
          { method: "POST", headers: authHeaders },
        );
        const ok = response.ok ? await response.json() : false;
        workspace.lastUsedAt = nowMs();
        await saveRouterState(statePath, state);
        send(200, { disposed: ok });
        return;
      }

      if (req.method === "POST" && url.pathname === "/shutdown") {
        send(200, { ok: true });
        await shutdown();
        return;
      }

      send(404, { error: "not found" });
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const shutdown = async () => {
    logger.info("Daemon shutting down", { host, port }, "openwork-orchestrator-router");
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch {
      // ignore
    }

    if (opencodeChild) {
      await stopChild(opencodeChild);
      opencodeChild = null;
    }

    state.daemon = undefined;
    if (state.opencode && !isProcessAlive(state.opencode.pid)) {
      state.opencode = undefined;
    }
    await saveRouterState(statePath, state);
    process.exit(0);
  };

  server.listen(port, host, async () => {
    state.daemon = {
      pid: process.pid,
      port,
      baseUrl: `http://${host}:${port}`,
      startedAt: nowMs(),
    };
    await saveRouterState(statePath, state);
    if (outputJson) {
      outputResult({ ok: true, daemon: state.daemon }, true);
    } else {
      if (logFormat === "json") {
        logger.info("Daemon running", { host, port }, "openwork-orchestrator-router");
      } else {
        console.log(`orchestrator daemon running on ${host}:${port}`);
      }
    }
  });

  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
  await new Promise(() => undefined);
}

function readOpenworkClientAuth(args: ParsedArgs): { openworkUrl: string; token: string } {
  const openworkUrl =
    readFlag(args.flags, "openwork-url") ??
    process.env.OPENWORK_URL ??
    process.env.OPENWORK_SERVER_URL ??
    "";
  const token =
    readFlag(args.flags, "token") ??
    readFlag(args.flags, "openwork-token") ??
    process.env.OPENWORK_TOKEN ??
    "";

  if (!openworkUrl || !token) {
    throw new Error("openwork-url and token are required");
  }

  return { openworkUrl, token };
}

function readSessionId(args: ParsedArgs, fallbackIndex: number): string {
  const sessionId = readFlag(args.flags, "session-id") ?? args.positionals[fallbackIndex] ?? "";
  const trimmed = sessionId.trim();
  if (!trimmed) {
    throw new Error("session-id is required");
  }
  return trimmed;
}

async function runFiles(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const subcommand = args.positionals[1] ?? "";
  const { openworkUrl, token } = readOpenworkClientAuth(args);
  const baseUrl = openworkUrl.replace(/\/$/, "");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  try {
    if (subcommand === "session") {
      const action = args.positionals[2] ?? "create";
      if (action === "create") {
        const workspaceId = readFlag(args.flags, "workspace-id") ?? args.positionals[3] ?? "";
        if (!workspaceId.trim()) {
          throw new Error("workspace-id is required for files session create");
        }
        const ttlSeconds = readNumber(args.flags, "ttl-seconds", undefined);
        const writeRequested = readBool(args.flags, "write", true);
        const result = await fetchJson(
          `${baseUrl}/workspace/${encodeURIComponent(workspaceId.trim())}/files/sessions`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...(typeof ttlSeconds === "number" ? { ttlSeconds } : {}),
              write: writeRequested,
            }),
          },
        );
        outputResult(result, outputJson);
        return;
      }
      if (action === "renew") {
        const sessionId = readSessionId(args, 3);
        const ttlSeconds = readNumber(args.flags, "ttl-seconds", undefined);
        const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/renew`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...(typeof ttlSeconds === "number" ? { ttlSeconds } : {}),
          }),
        });
        outputResult(result, outputJson);
        return;
      }
      if (action === "close" || action === "delete") {
        const sessionId = readSessionId(args, 3);
        const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
          headers,
        });
        outputResult(result, outputJson);
        return;
      }
      throw new Error("files session requires create|renew|close");
    }

    if (subcommand === "catalog") {
      const sessionId = readSessionId(args, 2);
      const params = new URLSearchParams();
      const prefix = readFlag(args.flags, "prefix");
      const after = readFlag(args.flags, "after");
      const limit = readNumber(args.flags, "limit", undefined);
      const includeDirs = readBool(args.flags, "include-dirs", true);
      if (prefix?.trim()) params.set("prefix", prefix.trim());
      if (after?.trim()) params.set("after", after.trim());
      if (typeof limit === "number") params.set("limit", String(limit));
      if (!includeDirs) params.set("includeDirs", "false");
      const query = params.toString();
      const result = await fetchJson(
        `${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/catalog/snapshot${query ? `?${query}` : ""}`,
        {
          headers,
        },
      );
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "events") {
      const sessionId = readSessionId(args, 2);
      const since = readNumber(args.flags, "since", undefined);
      const query = typeof since === "number" ? `?since=${encodeURIComponent(String(since))}` : "";
      const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/catalog/events${query}`, {
        headers,
      });
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "read") {
      const sessionId = readSessionId(args, 2);
      const pathsRaw = readFlag(args.flags, "paths");
      const singlePath = readFlag(args.flags, "path") ?? args.positionals[3];
      const paths = pathsRaw ? parseList(pathsRaw) : singlePath ? [singlePath] : [];
      if (!paths.length) {
        throw new Error("path or paths is required for files read");
      }
      const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/read-batch`, {
        method: "POST",
        headers,
        body: JSON.stringify({ paths }),
      });
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "write") {
      const sessionId = readSessionId(args, 2);
      const path = readFlag(args.flags, "path") ?? args.positionals[3] ?? "";
      if (!path.trim()) {
        throw new Error("path is required for files write");
      }

      let contentBase64 = readFlag(args.flags, "content-base64") ?? "";
      if (!contentBase64) {
        const inlineContent = readFlag(args.flags, "content");
        if (inlineContent !== undefined) {
          contentBase64 = Buffer.from(inlineContent, "utf8").toString("base64");
        }
      }
      if (!contentBase64) {
        const filePath = readFlag(args.flags, "file");
        if (filePath?.trim()) {
          const fileBytes = await readFile(resolve(filePath.trim()));
          contentBase64 = Buffer.from(fileBytes).toString("base64");
        }
      }
      if (!contentBase64) {
        throw new Error("provide one of --content, --content-base64, or --file");
      }

      const ifMatchRevision = readFlag(args.flags, "if-match");
      const force = readBool(args.flags, "force", false);
      const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/write-batch`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          writes: [
            {
              path: path.trim(),
              contentBase64,
              ...(ifMatchRevision?.trim() ? { ifMatchRevision: ifMatchRevision.trim() } : {}),
              ...(force ? { force: true } : {}),
            },
          ],
        }),
      });
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "mkdir") {
      const sessionId = readSessionId(args, 2);
      const path = readFlag(args.flags, "path") ?? args.positionals[3] ?? "";
      if (!path.trim()) throw new Error("path is required for files mkdir");
      const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/ops`, {
        method: "POST",
        headers,
        body: JSON.stringify({ operations: [{ type: "mkdir", path: path.trim() }] }),
      });
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "delete") {
      const sessionId = readSessionId(args, 2);
      const path = readFlag(args.flags, "path") ?? args.positionals[3] ?? "";
      if (!path.trim()) throw new Error("path is required for files delete");
      const recursive = readBool(args.flags, "recursive", false);
      const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/ops`, {
        method: "POST",
        headers,
        body: JSON.stringify({ operations: [{ type: "delete", path: path.trim(), ...(recursive ? { recursive: true } : {}) }] }),
      });
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "rename") {
      const sessionId = readSessionId(args, 2);
      const from = readFlag(args.flags, "from") ?? args.positionals[3] ?? "";
      const to = readFlag(args.flags, "to") ?? args.positionals[4] ?? "";
      if (!from.trim() || !to.trim()) {
        throw new Error("from and to are required for files rename");
      }
      const result = await fetchJson(`${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/ops`, {
        method: "POST",
        headers,
        body: JSON.stringify({ operations: [{ type: "rename", from: from.trim(), to: to.trim() }] }),
      });
      outputResult(result, outputJson);
      return;
    }

    throw new Error("files requires session|catalog|events|read|write|mkdir|delete|rename");
  } catch (error) {
    outputError(error, outputJson);
    process.exitCode = 1;
  }
}

async function runApprovals(args: ParsedArgs) {
  const subcommand = args.positionals[1];
  if (!subcommand || (subcommand !== "list" && subcommand !== "reply")) {
    throw new Error("approvals requires 'list' or 'reply'");
  }

  const openworkUrl =
    readFlag(args.flags, "openwork-url") ??
    process.env.OPENWORK_URL ??
    process.env.OPENWORK_SERVER_URL ??
    "";
  const hostToken = readFlag(args.flags, "host-token") ?? process.env.OPENWORK_HOST_TOKEN ?? "";

  if (!openworkUrl || !hostToken) {
    throw new Error("openwork-url and host-token are required for approvals");
  }

  const headers = {
    "Content-Type": "application/json",
    "X-OpenWork-Host-Token": hostToken,
  };

  if (subcommand === "list") {
    // egress-surface: supervisor_openwork_api
    const response = await fetch(`${openworkUrl.replace(/\/$/, "")}/approvals`, { headers });
    if (!response.ok) {
      throw new Error(`Failed to list approvals: ${response.status}`);
    }
    const body = await response.json();
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const approvalId = args.positionals[2];
  if (!approvalId) {
    throw new Error("approval id is required for approvals reply");
  }

  const allow = readBool(args.flags, "allow", false);
  const deny = readBool(args.flags, "deny", false);
  if (allow === deny) {
    throw new Error("use --allow or --deny");
  }

  const payload = { reply: allow ? "allow" : "deny" };
  // egress-surface: supervisor_openwork_api
  const response = await fetch(`${openworkUrl.replace(/\/$/, "")}/approvals/${approvalId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Failed to reply to approval: ${response.status}`);
  }
  const body = await response.json();
  console.log(JSON.stringify(body, null, 2));
}

async function runStatus(args: ParsedArgs) {
  const openworkUrl = readFlag(args.flags, "openwork-url") ?? process.env.OPENWORK_URL ?? "";
  const opencodeUrl = readFlag(args.flags, "opencode-url") ?? process.env.OPENCODE_URL ?? "";
  const username = readFlag(args.flags, "opencode-username") ?? process.env.OPENCODE_SERVER_USERNAME;
  const password = readFlag(args.flags, "opencode-password") ?? process.env.OPENCODE_SERVER_PASSWORD;
  const outputJson = readBool(args.flags, "json", false);

  const status: Record<string, unknown> = {};

  if (openworkUrl) {
    try {
      await waitForHealthy(openworkUrl, 5000, 400);
      status.openwork = { ok: true, url: openworkUrl };
    } catch (error) {
      status.openwork = { ok: false, url: openworkUrl, error: String(error) };
    }
  }

  if (opencodeUrl) {
    try {
      const headers: Record<string, string> = {};
      if (username && password) {
        headers.Authorization = `Basic ${encodeBasicAuth(username, password)}`;
      }
      // egress-surface: supervisor_health_opencode
      const client = createOpencodeClient({
        baseUrl: opencodeUrl,
        headers,
      });
      const health = await waitForOpencodeHealthy(client, 5000, 400, { baseUrl: opencodeUrl, headers });
      status.opencode = { ok: true, url: opencodeUrl, health };
    } catch (error) {
      status.opencode = { ok: false, url: opencodeUrl, error: String(error) };
    }
  }

  if (outputJson) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    if (status.openwork) {
      const openwork = status.openwork as { ok: boolean; url: string; error?: string };
      console.log(`OpenWork server: ${openwork.ok ? "ok" : "error"} (${openwork.url})`);
      if (openwork.error) console.log(`  ${openwork.error}`);
    }
    if (status.opencode) {
      const opencode = status.opencode as { ok: boolean; url: string; error?: string };
      console.log(`OpenCode server: ${opencode.ok ? "ok" : "error"} (${opencode.url})`);
      if (opencode.error) console.log(`  ${opencode.error}`);
    }
  }
}

// ── Edge-server connection validation (REMOVED) ────────────────────────
// The edge-model path has been removed; edge configuration is now owned
// entirely by the Windows-host `llmrouter_manager` service, which the UI
// talks to directly via ServiceHub (/llm-router/v1/edge). What used to live
// here - validateEdgeConnection(), the /v1/edge-model routes, and the
// local-llm provider injection - no longer has a role in this process.


async function runStart(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const checkOnly = readBool(args.flags, "check", false);
  const checkEvents = readBool(args.flags, "check-events", false);
  const verbose = readBool(args.flags, "verbose", false, "OPENWORK_VERBOSE");
  const logFormat = readLogFormat(args.flags, "log-format", "pretty", "OPENWORK_LOG_FORMAT");
  const detachRequested = readBool(args.flags, "detach", false, "OPENWORK_DETACH");
  const defaultTui = process.stdout.isTTY && !outputJson && !checkOnly && !checkEvents;
  const tuiRequested = readBool(args.flags, "tui", defaultTui);
  let useTui = tuiRequested && !detachRequested && !outputJson && !checkOnly && !checkEvents && logFormat === "pretty";
  const colorPreferred =
    readBool(args.flags, "color", process.stdout.isTTY, "OPENWORK_COLOR") && !process.env.NO_COLOR;
  const runId = readFlag(args.flags, "run-id") ?? process.env.OPENWORK_RUN_ID ?? randomUUID();
  const cliVersion = await resolveCliVersion();
  const compiledBinary = isCompiledBunBinary();
  let tui: TuiHandle | undefined;
  let restoreConsoleError: (() => void) | undefined;
  const baseLoggerOptions = {
    format: logFormat,
    runId,
    serviceName: "openwork-orchestrator",
    serviceVersion: cliVersion,
    onLog: (event: LogEvent) => {
      if (!tui) return;
      const component = event.component ?? "openwork-orchestrator";
      const tuiComponent = component === "opencode-router" ? "router" : component;
      tui.pushLog({
        time: event.time,
        level: event.level,
        component: tuiComponent,
        message: event.message,
      });
    },
  };
  let logger = createLogger({
    ...baseLoggerOptions,
    output: useTui ? "silent" : "stdout",
    color: useTui ? false : colorPreferred,
  });
  let logVerbose = createVerboseLogger(verbose && !outputJson, logger, "openwork-orchestrator");
  const switchToPlainOutput = (error: string) => {
    if (!useTui) return;
    useTui = false;
    restoreConsoleError?.();
    restoreConsoleError = undefined;
    tui?.stop();
    tui = undefined;
    logger = createLogger({
      ...baseLoggerOptions,
      output: "stdout",
      color: colorPreferred,
    });
    logVerbose = createVerboseLogger(verbose && !outputJson, logger, "openwork-orchestrator");
    logger.warn(
      "TUI failed to start; falling back to plain output. Use `openwork serve` for explicit non-TUI mode.",
      { error },
      "openwork-orchestrator",
    );
  };
  const sidecarSourceInput = readBinarySource(args.flags, "sidecar-source", "auto", "OPENWORK_SIDECAR_SOURCE");
  const opencodeSourceInput = readBinarySource(args.flags, "opencode-source", "auto", "OPENWORK_OPENCODE_SOURCE");

  const workspace = readFlag(args.flags, "workspace") ?? process.env.OPENWORK_WORKSPACE ?? process.cwd();
  // Resolved, not created. This process may run in an isolation tier with no right to open the
  // workspace at all: it names the path for the services that do open it and derives a per-workspace
  // identifier from it, and neither needs the directory to exist here. Creating the workspace and its
  // default `opencode.jsonc` is the owner's job, done before any of these services start - it produces
  // user-visible artifacts that should belong to the user rather than to a sandbox account, and it has
  // to happen before *every* service, which is an ordering only a step outside all of them can give.
  const resolvedWorkspace = resolve(workspace);
  logger.info("Run starting", { workspace: resolvedWorkspace, logFormat, runId }, "openwork-orchestrator");

  assertNoRemovedSandboxOptions(args.flags, process.env);
  const dataDir = resolveRouterDataDir(args.flags);
  const devMode = resolveInternalDevMode(args.flags);
  const opencodeStateLayout = resolveOpencodeStateLayout({
    dataDir,
    workspace: resolvedWorkspace,
    devMode,
  });
  const opencodeConfigDir = opencodeStateLayout.configDir;
  const productProfileSourceRoot = process.env.SC_PRODUCT_PROFILE_SOURCE_ROOT?.trim() || "/opt/agent-config/profiles";
  const runtimeScaffoldRoot = process.env.SC_OPENCODE_DEPS_ROOT?.trim() || "/opt/opencode-deps";
  const runtimeConfigDir = process.env.SC_RUNTIME_CONFIG_DIR?.trim() || "/data/superclaw/runtime";
  const runtimeGenerationRoot = process.env.SC_RUNTIME_GENERATION_ROOT?.trim();
  const measureStartupPreparation = async <T>(step: string, operation: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await operation();
    } finally {
      const durationMs = Date.now() - startedAt;
      logger.info(
        `Startup preparation step complete step=${step} duration_ms=${durationMs}`,
        { step, durationMs },
        "openwork-orchestrator",
      );
    }
  };
  const runtimeDeployment = await bootstrapRuntimeDeployment({
    opencodeConfigDir,
    productProfileSourceRoot,
    runtimeScaffoldRoot,
    runtimeConfigDir,
    runtimeGenerationRoot,
    deploymentB64: process.env.SUPERCLAW_RUNTIME_DEPLOYMENT_B64?.trim(),
    desiredFingerprint: process.env.SC_RUNTIME_DESIRED_FINGERPRINT?.trim(),
    instanceId: process.env.SC_RUNTIME_INSTANCE_ID?.trim(),
    launchAttemptId: process.env.SC_RUNTIME_LAUNCH_ATTEMPT_ID?.trim(),
    prepareRuntime: async () => {
      await measureStartupPreparation("opencode_state_layout", () => ensureOpencodeStateLayout(opencodeStateLayout));
    },
    finalizeConfig: () => measureStartupPreparation("opencode_managed_tools", () => ensureOpencodeManagedTools(opencodeConfigDir)),
  });
  const {
    state: runtimeDeploymentState,
    profileLayout,
    profileTarget: startupProfileTarget,
    profileDescriptor: startupProfileDescriptor,
    capabilityBarrierCompletedAt,
  } = runtimeDeployment;
  const opencodeRouterDataDir = join(dataDir, "opencode-router", workspaceIdForLocal(resolvedWorkspace));
  await measureStartupPreparation("opencode_router_data_dir", () => mkdir(opencodeRouterDataDir, { recursive: true }));

  const explicitOpencodeBin = readFlag(args.flags, "opencode-bin") ?? process.env.OPENWORK_OPENCODE_BIN;
  const explicitOpenworkServerBin = readFlag(args.flags, "openwork-server-bin") ?? process.env.OPENWORK_SERVER_BIN;
  const explicitOpenCodeRouterBin = readFlag(args.flags, "opencode-router-bin") ?? process.env.OPENCODE_ROUTER_BIN;
  const opencodeBindHost = resolveBindHost(readFlag(args.flags, "opencode-host"), process.env.OPENWORK_OPENCODE_BIND_HOST);
  // The three services whose lifecycle can belong to whoever launched this supervisor rather than to
  // the supervisor itself. All three default to false and are switched on explicitly by the caller,
  // because a default that varied between them is how one of them would quietly go back to spawning its
  // own copy - and on the host-native backend that copy would run in the wrong isolation tier.
  const externalOpencode = readBool(args.flags, "external-opencode", false, "OPENWORK_EXTERNAL_OPENCODE");
  const externalOpenworkServer = readBool(
    args.flags,
    "external-openwork-server",
    false,
    "OPENWORK_EXTERNAL_OPENWORK_SERVER",
  );
  const externalOpencodeRouter = readBool(
    args.flags,
    "external-opencode-router",
    false,
    "OPENWORK_EXTERNAL_OPENCODE_ROUTER",
  );
  const externalHybridDr = readBool(
    args.flags,
    "external-hybrid-dr",
    false,
    "OPENWORK_EXTERNAL_HYBRID_DR",
  );
  const configuredOpencodePort = readNumber(args.flags, "opencode-port", undefined, "OPENWORK_OPENCODE_PORT");
  const opencodePort = await resolveManagedServicePort({
    service: "External OpenCode",
    portFlag: "--opencode-port",
    external: externalOpencode,
    configured: configuredOpencodePort,
    resolveAvailable: () => measureStartupPreparation("opencode_port", () =>
      resolvePort(configuredOpencodePort, "127.0.0.1")),
  });
  const opencodeHotReload = readOpencodeHotReload(
    args.flags,
    {
      enabled: true,
      debounceMs: DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS,
      cooldownMs: DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS,
    },
    {
      enabled: "OPENWORK_OPENCODE_HOT_RELOAD",
      debounceMs: "OPENWORK_OPENCODE_HOT_RELOAD_DEBOUNCE_MS",
      cooldownMs: "OPENWORK_OPENCODE_HOT_RELOAD_COOLDOWN_MS",
    },
  );
  const opencodeAuth = readBool(args.flags, "opencode-auth", !externalOpencode, "OPENWORK_OPENCODE_AUTH");
  const opencodeUsername = opencodeAuth
    ? readFlag(args.flags, "opencode-username") ?? process.env.OPENWORK_OPENCODE_USERNAME ?? DEFAULT_OPENCODE_USERNAME
    : undefined;
  const opencodePassword = opencodeAuth
    ? resolveOpencodePassword({
      external: externalOpencode,
      configured: readFlag(args.flags, "opencode-password") ?? process.env.OPENWORK_OPENCODE_PASSWORD,
      generate: randomUUID,
    })
    : undefined;

  const openworkHost = resolveBindHost(readFlag(args.flags, "openwork-host"), process.env.OPENWORK_HOST);
  const configuredOpenworkPort = readNumber(args.flags, "openwork-port", undefined, "OPENWORK_PORT");
  const openworkPort = await resolveManagedServicePort({
    service: "External openwork-server",
    portFlag: "--openwork-port",
    external: externalOpenworkServer,
    configured: configuredOpenworkPort,
    resolveAvailable: () => measureStartupPreparation("openwork_port", () =>
      resolvePort(configuredOpenworkPort, "127.0.0.1")),
  });
  // Always choose a free opencodeRouter health port by default (avoid conflicts with
  // other local processes using 3005). An external router is the exception: it is already listening,
  // so its port is stated rather than chosen, and probing would find it taken and pick another.
  const configuredOpencodeRouterHealthPort = readNumber(
    args.flags,
    "opencode-router-health-port",
    undefined,
    "OPENCODE_ROUTER_HEALTH_PORT",
  );
  const opencodeRouterHealthPort = await resolveManagedServicePort({
    service: "External opencode-router",
    portFlag: "--opencode-router-health-port",
    external: externalOpencodeRouter,
    configured: configuredOpencodeRouterHealthPort,
    resolveAvailable: () => measureStartupPreparation("opencode_router_health_port", () =>
      resolvePort(configuredOpencodeRouterHealthPort, "127.0.0.1")),
  });
  const openworkToken = readFlag(args.flags, "openwork-token") ?? process.env.OPENWORK_TOKEN ?? randomUUID();
  const managedHostHash = Boolean(process.env.OPENWORK_HOST_TOKEN_HASH?.trim());
  const openworkHostToken = managedHostHash
    ? ""
    : readFlag(args.flags, "openwork-host-token") ?? process.env.OPENWORK_HOST_TOKEN ?? randomUUID();
  const openworkTelemetryToken = randomUUID();
  const approvalMode =
    (readFlag(args.flags, "approval") as ApprovalMode | undefined) ??
    (process.env.OPENWORK_APPROVAL_MODE as ApprovalMode | undefined) ??
    "manual";
  const approvalTimeoutMs = readNumber(
    args.flags,
    "approval-timeout",
    DEFAULT_APPROVAL_TIMEOUT,
    "OPENWORK_APPROVAL_TIMEOUT_MS",
  ) as number;
  const readOnly = readBool(args.flags, "read-only", false, "OPENWORK_READONLY");
  const corsValue = readFlag(args.flags, "cors") ?? process.env.OPENWORK_CORS_ORIGINS ?? "*";
  const corsOrigins = parseList(corsValue);
  const connectHost = readFlag(args.flags, "connect-host");

  const manifest = await measureStartupPreparation("version_manifest", readVersionManifest);
  const allowExternal = readBool(args.flags, "allow-external", false, "OPENWORK_ALLOW_EXTERNAL");
  const sidecarTarget = resolveSidecarTarget();
  const sidecar = resolveSidecarConfigForTarget(args.flags, cliVersion, sidecarTarget);

  const sidecarSource = sidecarSourceInput;
  const opencodeSource = opencodeSourceInput;
  logVerbose(`cli version: ${cliVersion}`);
  logVerbose(`sidecar target: ${sidecar.target ?? "unknown"}`);
  logVerbose(`sidecar dir: ${sidecar.dir}`);
  logVerbose(`sidecar base URL: ${sidecar.baseUrl}`);
  logVerbose(`sidecar manifest: ${sidecar.manifestUrl}`);
  logVerbose(`sidecar source: ${sidecarSource}`);
  logVerbose(`opencode source: ${opencodeSource}`);
  logVerbose(
    `opencode hot reload: ${opencodeHotReload.enabled ? "on" : "off"} (debounce=${opencodeHotReload.debounceMs}ms cooldown=${opencodeHotReload.cooldownMs}ms)`,
  );
  logVerbose(`allow external: ${allowExternal ? "true" : "false"}`);
  let opencodeBinary = await measureStartupPreparation("opencode_binary", () =>
    resolveOpencodeBin({
      explicit: explicitOpencodeBin,
      manifest,
      allowExternal,
      sidecar,
      source: opencodeSource,
      externalLifecycle: externalOpencode,
    }),
  );


  // LLMRouter is now a Windows-host service (`llmrouter_manager`) that owns
  // port 18321. The orchestrator does not spawn a router; it
  // only needs the port to build the LRM_API_BASE_URL host-connection
  // URL passed to child processes (openwork-server, opencode-router).
  const llmrouterPort = readNumber(args.flags, "llmrouter-port", undefined, "OPENWORK_LLMROUTER_PORT") ?? 18321;
  // Host-connection base URL for LRM (suffix-free). Prefer the value the
  // sandbox-manager injects as LRM_API_BASE_URL and fall back to loopback so a
  // bare `opencode-orchestrator` run without injection still works. Strip any
  // trailing /v1 or / so downstream consumers (openwork-server PII side-channel,
  // opencode-router) that append their own path don't produce /v1/v1.
  const llmrouterUrl = (process.env.LRM_API_BASE_URL?.trim() || `http://127.0.0.1:${llmrouterPort}`)
    .replace(/\/v1\/?$/, "")
    .replace(/\/$/, "");

  // Intent Classifier options — managed by the orchestrator so runtime env
  // changes (notably NO_PROXY after Connect Edge) apply on restart.
  const intentClassifierPort = readNumber(args.flags, "intent-classifier-port", undefined, "CLASSIFIER_PORT") ?? 18791;
  const intentClassifierHost = resolveBindHost(readFlag(args.flags, "intent-classifier-host"), process.env.CLASSIFIER_HOST);
  const intentClassifierPythonBin = readFlag(args.flags, "intent-classifier-python-bin") ?? process.env.CLASSIFIER_PYTHON_BIN;
  const intentClassifierScript = readFlag(args.flags, "intent-classifier-script") ?? process.env.CLASSIFIER_SERVER_SCRIPT;
  // "bypass" is unreachable as long as the only Profile that declares the
  // intent-classifier sidecar is also the only one that sets the feature flag:
  // the process is not spawned at all when the flag is clear, so the mode is
  // always "enabled" wherever it is read. Kept because the two are separate
  // Profile knobs — a future Profile may want the sidecar running with routing
  // off, which is what this mode is for.
  const intentClassifierMode: IntentClassifierClassificationMode = startupProfileDescriptor.feature_flags.intent_classifier
    ? "enabled"
    : "bypass";
  let intentClassifierRequired = startupProfileDescriptor.required_sidecars.includes("intent-classifier");
  // Advertised to the Slack/Telegram bridge only when we actually spawn the
  // sidecar; null keeps the bridge from calling a port nothing listens on.
  const intentClassifierEndpoint = resolveIntentClassifierEndpoint({
    sidecarSpawned: intentClassifierRequired,
    port: intentClassifierPort,
    external: externalOpenworkServer || externalOpencodeRouter,
    env: process.env,
  });
  let hybridDrRequired = startupProfileDescriptor.required_sidecars.includes("hdr-sidecar");
  if (startupProfileDescriptor.feature_flags.hybrid_deep_research_agent !== hybridDrRequired) {
    throw new Error("Product Profile HDR feature and required sidecar disagree");
  }
  let hybridDrEnabled = hybridDrRequired;
  validateExternalHdrOwnership({
    external: externalHybridDr,
    externalOpencode,
    externalOpenworkServer,
    required: hybridDrRequired,
    managed: process.env.HYBRID_DR_NATIVE_MANAGED?.trim() === "1",
  });

  // Hybrid Deep Research sidecar options — managed by the orchestrator so it
  // can be restarted on crashes and health failures.
  const configuredHybridDrPort = readNumber(args.flags, "hybrid-dr-port", undefined, "HYBRID_DR_PORT");
  const hybridDrPort = externalHybridDr ? await resolveManagedServicePort({
    service: "External Hybrid DR",
    portFlag: "--hybrid-dr-port",
    external: externalHybridDr,
    configured: configuredHybridDrPort,
    resolveAvailable: () => { throw new Error("External HDR must not select a port"); },
  }) : configuredHybridDrPort ?? 18324;
  const hybridDrHost = resolveHybridDrHost({
    external: externalHybridDr,
    cliHost: readFlag(args.flags, "hybrid-dr-host"),
    envHost: process.env.HYBRID_DR_HOST,
  });
  const hybridDrBin = readFlag(args.flags, "hybrid-dr-bin") ?? process.env.HYBRID_DR_BIN;
  const hybridDrPythonBin = readFlag(args.flags, "hybrid-dr-python-bin") ?? process.env.HYBRID_DR_PYTHON_BIN;
  const hybridDrModule = readFlag(args.flags, "hybrid-dr-module") ?? process.env.HYBRID_DR_MODULE;
  const hybridDrReadyToken = process.env.HYBRID_DR_READY_TOKEN?.trim() ?? "";
  if (
    externalHybridDr
    && (process.env.HYBRID_DR_NATIVE_MANAGED?.trim() !== "1"
      || !/^[A-Za-z0-9_-]{32,256}$/.test(hybridDrReadyToken))
  ) {
    throw new Error("External Hybrid DR requires managed mode and a valid readiness token");
  }

  const opencodeRouterEnabled = readBool(args.flags, "opencode-router", true);
  const opencodeRouterRequired = readBool(
    args.flags,
    "opencode-router-required",
    false,
    "OPENWORK_OPENCODE_ROUTER_REQUIRED",
  );
  // Not resolved at all when the lifecycle is external, and deliberately not merely left unspawned.
  // Resolution is not a lookup: with no explicit path it falls back to a bundled binary and then to
  // downloading one, and throws when neither is there. A supervisor that will never spawn the service
  // has no business downloading it, and no business failing to start because a binary it does not use
  // could not be found.
  let openworkServerBinary = externalOpenworkServer
    ? null
    : await measureStartupPreparation("openwork_server_binary", () =>
        resolveOpenworkServerBin({
          explicit: explicitOpenworkServerBin,
          manifest,
          allowExternal,
          sidecar,
          source: sidecarSource,
        }),
      );
  let opencodeRouterBinary =
    opencodeRouterEnabled && !externalOpencodeRouter
      ? await measureStartupPreparation("opencode_router_binary", () =>
          resolveOpenCodeRouterBin({
            explicit: explicitOpenCodeRouterBin,
            manifest,
            allowExternal,
            sidecar,
            source: sidecarSource,
          }),
        )
      : null;

  let opencodeRouterActualVersion: string | undefined;
  logVerbose(`opencode bin: ${opencodeBinary.bin} (${opencodeBinary.source})`);
  if (openworkServerBinary) {
    logVerbose(`openwork-server bin: ${openworkServerBinary.bin} (${openworkServerBinary.source})`);
  } else {
    logVerbose(`openwork-server: external on port ${openworkPort}`);
  }
  if (opencodeRouterBinary) {
    logVerbose(`opencodeRouter bin: ${opencodeRouterBinary.bin} (${opencodeRouterBinary.source})`);
  }

  const openworkBaseUrl = `http://127.0.0.1:${openworkPort}`;
  const openworkConnect = resolveConnectUrl(openworkPort, advertisedConnectHost(connectHost, openworkHost));
  const openworkConnectUrl = openworkConnect.connectUrl ?? openworkBaseUrl;

  const opencodeBaseUrl = `http://127.0.0.1:${opencodePort}`;
  const opencodeConnectUrl = resolveConnectUrl(opencodePort, advertisedConnectHost(connectHost, opencodeBindHost)).connectUrl ?? opencodeBaseUrl;

  const attachCommand = buildAttachCommand({
    url: opencodeConnectUrl,
    workspace: resolvedWorkspace,
    username: opencodeUsername,
    password: opencodePassword,
  });

  const opencodeRouterHealthUrl = `http://127.0.0.1:${opencodeRouterHealthPort}`;
  const opencodeRouterEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_DIRECTORY: resolvedWorkspace,
    OPENCODE_URL: opencodeConnectUrl,
    ...(opencodeUsername ? { OPENCODE_SERVER_USERNAME: opencodeUsername } : {}),
    ...(opencodePassword ? { OPENCODE_SERVER_PASSWORD: opencodePassword } : {}),
    ...(opencodeRouterEnabled ? { OPENCODE_ROUTER_HEALTH_PORT: String(opencodeRouterHealthPort) } : {}),
    // LLMRouter: pass URL so opencode-router can query which model autorouter selected
    LRM_API_BASE_URL: llmrouterUrl,
  };

  const children: ChildHandle[] = [];
  let shuttingDown = false;
  let detached = false;
  let opencodeChild: ChildProcess | null = null;
  let externalOpencodeHealthy = false;
  let externalOpenworkServerHealthy = false;
  let externalOpencodeRouterHealthy = false;
  const externalHybridDrObserver = new ExternalHybridDrHealthObserver(async () => {
    await probeManagedHybridDrReadiness(
      `http://${hybridDrHost === "0.0.0.0" || hybridDrHost === "::" ? "127.0.0.1" : hybridDrHost}:${hybridDrPort}/readyz`,
      MANAGED_HDR_READY_TIMEOUT_MS,
      { Authorization: `Bearer ${hybridDrReadyToken}` },
    );
    return true;
  });
  let openworkChild: ChildProcess | null = null;
  let opencodeRouterChild: ChildProcess | null = null;
  let controlServer: ReturnType<typeof createHttpServer> | null = null;
  const controlPort = await measureStartupPreparation("control_port", () => resolvePort(undefined, "127.0.0.1"));
  const controlToken = randomUUID();
  const routerControlToken = randomUUID();
  const controlBaseUrl = `http://127.0.0.1:${controlPort}`;
  let opencodeActualVersion: string | undefined;
  let openworkActualVersion: string | undefined;
  let openworkOwnerToken: string | undefined;
  const startedAt = Date.now();
  let opencodeRouterHealthInterval: NodeJS.Timeout | null = null;
  let intentClassifierService: IntentClassifierService | undefined;
  let hybridDrSidecarService: HybridDrSidecarService | undefined;
  const restartingServices = new Set<string>();
  const runtimeUpgradeState: RuntimeUpgradeState = {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    error: null,
    operationId: null,
    services: [],
  };
  const removeChildHandle = (name: string) => {
    const index = children.findIndex((handle) => handle.name === name);
    if (index >= 0) children.splice(index, 1);
  };
  const getRuntimeSnapshot = () => {
    const services = [
      // For the three services whose lifecycle can be external, "running" cannot be read off a child
      // handle we do not hold. The health check this supervisor already performs is the substitute, and
      // it is the honest one: it reports that the service answered, not that a process exists.
      buildRuntimeServiceSnapshot({
        name: "openwork-server",
        enabled: true,
        running: externalOpenworkServerHealthy || Boolean(openworkChild && isProcessAlive(openworkChild.pid)),
        binary: openworkServerBinary,
        actualVersion: openworkActualVersion,
      }),
      buildRuntimeServiceSnapshot({
        name: "opencode",
        enabled: true,
        running: externalOpencodeHealthy || Boolean(opencodeChild && isProcessAlive(opencodeChild.pid)),
        binary: opencodeBinary,
        actualVersion: opencodeActualVersion,
      }),
      buildRuntimeServiceSnapshot({
        name: "opencode-router",
        enabled: Boolean(opencodeRouterEnabled && (opencodeRouterBinary || externalOpencodeRouter)),
        running: externalOpencodeRouterHealthy || Boolean(opencodeRouterChild && isProcessAlive(opencodeRouterChild.pid)),
        binary: opencodeRouterBinary,
        actualVersion: opencodeRouterActualVersion,
      }),
      buildRuntimeServiceSnapshot({
        name: "intent-classifier",
        enabled: Boolean(intentClassifierService),
        running: intentClassifierService?.getStatus().status === "running",
      }),
      buildRuntimeServiceSnapshot({
        name: "hybrid-dr",
        enabled: hybridDrEnabled,
        running: externalHybridDr ? externalHybridDrObserver.snapshot() : hybridDrSidecarService?.getStatus().status === "running",
      }),
    ];
    return {
      ok: true,
      orchestrator: {
        version: cliVersion,
        startedAt,
      },
      worker: {
        workspace: resolvedWorkspace,
      },
      upgrade: {
        ...runtimeUpgradeState,
      },
      services,
    };
  };

  const restartOpencode = async () => {
    if (externalOpencode) {
      throw new Error("OpenCode lifecycle is owned by Sandbox Manager in external mode");
    }
    if (opencodeChild) {
      restartingServices.add("opencode");
      removeChildHandle("opencode");
      await stopChild(opencodeChild);
      opencodeChild = null;
    }
    opencodeActualVersion = await verifyOpencodeVersion(opencodeBinary);
    const child = await startOpencode({
      bin: opencodeBinary.bin,
      workspace: resolvedWorkspace,
      stateLayout: opencodeStateLayout,
      hotReload: opencodeHotReload,
      bindHost: opencodeBindHost,
      port: opencodePort,
      username: opencodeUsername,
      password: opencodePassword,
      corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
      logger,
      runId,
      logFormat,
      opencodeRouterHealthPort: opencodeRouterEnabled ? opencodeRouterHealthPort : undefined,
      controlToken: routerControlToken,
      telemetryToken: openworkTelemetryToken,
    });
    opencodeChild = child;
    children.push({ name: "opencode", child });
    logger.info("Process spawned", { pid: child.pid ?? 0, cause: "runtime-upgrade" }, "opencode");
    child.on("exit", (code, signal) => handleExit("opencode", code, signal));
    child.on("error", (error) => handleSpawnError("opencode", error));
    await waitForOpencodeHealthy(
      // egress-surface: supervisor_health_opencode
      createOpencodeClient({
        baseUrl: opencodeBaseUrl,
        directory: resolvedWorkspace,
        headers: (() => {
          const h = buildOpencodeAuthHeaders(opencodeUsername, opencodePassword);
          return Object.keys(h).length ? h : undefined;
        })(),
      }),
      10_000,
      250,
      { baseUrl: opencodeBaseUrl, headers: buildOpencodeAuthHeaders(opencodeUsername, opencodePassword) },
    );
    await prewarmOpencode(
      opencodeBaseUrl,
      buildOpencodeAuthHeaders(opencodeUsername, opencodePassword),
      logger,
    );
  };
  const restartOpenworkServer = async () => {
    if (externalOpenworkServer || !openworkServerBinary) {
      throw new Error("openwork-server lifecycle is owned by Sandbox Manager in external mode");
    }
    if (openworkChild) {
      restartingServices.add("openwork-server");
      removeChildHandle("openwork-server");
      await stopChild(openworkChild);
      openworkChild = null;
    }
    const child = await startOpenworkServer({
      bin: openworkServerBinary.bin,
      host: openworkHost,
      port: openworkPort,
      workspace: resolvedWorkspace,
      token: openworkToken,
      hostToken: openworkHostToken,
      telemetryToken: openworkTelemetryToken,
      approvalMode: approvalMode === "auto" ? "auto" : "manual",
      approvalTimeoutMs,
      readOnly,
      corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
      opencodeBaseUrl,
      opencodeDirectory: resolvedWorkspace,
      opencodeUsername,
      opencodePassword,
      opencodeRouterHealthPort: opencodeRouterChild ? opencodeRouterHealthPort : undefined,
      opencodeRouterDataDir: opencodeRouterChild ? (opencodeRouterDataDir ?? undefined) : undefined,
      routerControlToken,
      llmrouterUrl,
      logger,
      runId,
      logFormat,
      controlBaseUrl,
      controlToken,
      intentClassifierToken: intentClassifierEndpoint?.token,
    });
    openworkChild = child;
    children.push({ name: "openwork-server", child });
    logger.info("Process spawned", { pid: child.pid ?? 0, cause: "runtime-upgrade" }, "openwork-server");
    child.on("exit", (code, signal) => handleExit("openwork-server", code, signal));
    child.on("error", (error) => handleSpawnError("openwork-server", error));
    await waitForHealthy(openworkBaseUrl);
    openworkActualVersion = await verifyOpenworkServer({
      baseUrl: openworkBaseUrl,
      token: openworkToken,
      hostToken: openworkHostToken,
      expectedVersion: openworkServerBinary.expectedVersion,
      expectedWorkspace: resolvedWorkspace,
      expectedOpencodeBaseUrl: opencodeBaseUrl,
      expectedOpencodeDirectory: resolvedWorkspace,
      expectedOpencodeUsername: opencodeUsername,
    });
  };
  const restartOpenCodeRouter = async () => {
    if (!opencodeRouterEnabled || !opencodeRouterBinary) {
      return;
    }
    if (opencodeRouterChild) {
      restartingServices.add("opencode-router");
      removeChildHandle("opencode-router");
      await stopChild(opencodeRouterChild);
      opencodeRouterChild = null;
    }
    opencodeRouterActualVersion = await verifyOpenCodeRouterVersion(opencodeRouterBinary);
    opencodeRouterChild = await startOpenCodeRouter({
      bin: opencodeRouterBinary.bin,
      workspace: resolvedWorkspace,
      opencodeUrl: opencodeConnectUrl,
      opencodeUsername,
      opencodePassword,
      opencodeRouterHealthPort,
      opencodeRouterDataDir: opencodeRouterDataDir ?? undefined,
      controlToken: routerControlToken,
      llmrouterUrl,
      intentClassifier: intentClassifierEndpoint,
      logger,
      runId,
      logFormat,
    });
    children.push({ name: "opencode-router", child: opencodeRouterChild });
    opencodeRouterChild.on("exit", (code, signal) => handleExit("opencode-router", code, signal));
    opencodeRouterChild.on("error", (error) => handleSpawnError("opencode-router", error));
    await waitForOpenCodeRouterHealthy(`http://127.0.0.1:${opencodeRouterHealthPort}`, 10_000, 400);
  };
  const restartIntentClassifier = async () => {
    if (!intentClassifierService) {
      return;
    }
    restartingServices.add("intent-classifier");
    try {
      await intentClassifierService.restart();
    } finally {
      restartingServices.delete("intent-classifier");
    }
  };
  const restartHybridDrSidecar = async () => {
    if (externalHybridDr) {
      throw new Error("Hybrid DR lifecycle is owned by Sandbox Manager in external mode");
    }
    if (!hybridDrSidecarService) {
      return;
    }
    restartingServices.add("hybrid-dr");
    try {
      await hybridDrSidecarService.restart();
    } finally {
      restartingServices.delete("hybrid-dr");
    }
  };
  const runtimeOperationLock = new RuntimeOperationLock();
  const intentClassifierHealthHost = connectableHost(intentClassifierHost);
  const hybridDrHealthHost = hybridDrHost === "0.0.0.0" || hybridDrHost === "::" ? "127.0.0.1" : hybridDrHost;
  const runtimeProfileController = createRuntimeProfileController({
      bootstrapTarget: startupProfileTarget,
      productProfileSourceRoot,
      profileLayout,
      opencodeHealthUrl: `${opencodeBaseUrl}/health`,
      opencodeHeaders: () => buildOpencodeAuthHeaders(opencodeUsername, opencodePassword),
      isOpenWorkConnected: async () => {
        try {
          await verifyOpenworkServer({
            baseUrl: openworkBaseUrl,
            token: openworkToken,
            hostToken: openworkHostToken,
            // Undefined for an external server, which `assertVersionMatch` already treats as "nothing
            // to compare" rather than as a failure: with no binary of our own there is no version we
            // are entitled to expect, and every other check in here speaks only HTTP.
            expectedVersion: openworkServerBinary?.expectedVersion,
            expectedWorkspace: resolvedWorkspace,
            expectedOpencodeBaseUrl: opencodeBaseUrl,
            expectedOpencodeDirectory: resolvedWorkspace,
            expectedOpencodeUsername: opencodeUsername,
          });
          // egress-surface: supervisor_health_openwork
          const response = await fetch(`${openworkBaseUrl}/opencode/health`, {
            headers: { Authorization: `Bearer ${openworkToken}` },
            signal: AbortSignal.timeout(2_000),
          });
          return response.ok;
        } catch {
          return false;
        }
      },
      intentClassifierStatus: () => !intentClassifierService ? "absent" : intentClassifierService.getStatus().status === "running" ? "running" : "stopped",
      intentClassifierHealthUrl: `http://${intentClassifierHealthHost}:${intentClassifierPort}/health`,
      isHybridDrRunning: () => hybridDrSidecarService?.getStatus().status === "running",
      observeExternalHybridDr: externalHybridDr ? (options) => externalHybridDrObserver.observe(options?.untilReady, () => shuttingDown) : undefined,
      isHybridDrAbsent: () => !externalHybridDr && (!hybridDrSidecarService || hybridDrSidecarService.getStatus().status === "stopped"),
      hybridDrHealthUrl: `http://${hybridDrHealthHost}:${hybridDrPort}/${externalHybridDr ? "readyz" : "healthz"}`,
      hybridDrHealthHeaders: () => externalHybridDr
        ? { Authorization: `Bearer ${hybridDrReadyToken}` }
        : {} as Record<string, string>,
  });
  const performRuntimeUpgrade = async (services: RuntimeServiceName[], releaseOperation: () => void) => {
    const opId = randomUUID();
    runtimeUpgradeState.status = "running";
    runtimeUpgradeState.startedAt = Date.now();
    runtimeUpgradeState.finishedAt = null;
    runtimeUpgradeState.error = null;
    runtimeUpgradeState.operationId = opId;
    runtimeUpgradeState.services = services;
    try {
      // Upgrading a service means replacing its binary and restarting it, and neither is this
      // supervisor's to do for a service whose lifecycle belongs to whoever launched it. Refusing the
      // whole operation is deliberate rather than upgrading the subset it does own: a partial upgrade
      // would leave the services on versions that were never released together.
      const externallyOwned = services.filter(
        (service) =>
          (service === "opencode" && externalOpencode) ||
          (service === "openwork-server" && externalOpenworkServer) ||
          (service === "opencode-router" && externalOpencodeRouter) ||
          (service === "hybrid-dr" && externalHybridDr),
      );
      if (externallyOwned.length) {
        throw new Error(
          `Runtime upgrade is owned by Sandbox Manager for: ${externallyOwned.join(", ")}`,
        );
      }
      if (services.includes("openwork-server") && openworkServerBinary?.source === "external" && openworkServerBinary.expectedVersion) {
        await installGlobalPackages([`openwork-server@${openworkServerBinary.expectedVersion}`]);
      }
      if (services.includes("opencode-router") && opencodeRouterBinary?.source === "external" && opencodeRouterBinary.expectedVersion) {
        await installGlobalPackages([`opencode-router@${opencodeRouterBinary.expectedVersion}`]);
      }
      if (services.includes("openwork-server")) {
        openworkServerBinary = await resolveOpenworkServerBin({
          explicit: explicitOpenworkServerBin,
          manifest,
          allowExternal,
          sidecar,
          source: sidecarSource,
        });
      }
      if (services.includes("opencode")) {
        opencodeBinary = await resolveOpencodeBin({
          explicit: explicitOpencodeBin,
          manifest,
          allowExternal,
          sidecar,
          source: opencodeSource,
        });
      }
      if (services.includes("opencode-router") && opencodeRouterEnabled && !externalOpencodeRouter) {
        opencodeRouterBinary = await resolveOpenCodeRouterBin({
          explicit: explicitOpenCodeRouterBin,
          manifest,
          allowExternal,
          sidecar,
          source: sidecarSource,
        });
      }
      if (services.includes("opencode")) {
        await restartOpencode();
      }
      if (services.includes("opencode-router")) {
        await restartOpenCodeRouter();
      }
      if (services.includes("intent-classifier")) {
        await restartIntentClassifier();
      }
      if (services.includes("hybrid-dr")) {
        await restartHybridDrSidecar();
      }
      if (services.includes("openwork-server") || services.includes("opencode")) {
        await restartOpenworkServer();
      }
      runtimeUpgradeState.status = "idle";
      runtimeUpgradeState.finishedAt = Date.now();
    } catch (error) {
      runtimeUpgradeState.status = "failed";
      runtimeUpgradeState.finishedAt = Date.now();
      runtimeUpgradeState.error = error instanceof Error ? error.message : String(error);
      logger.error("Runtime upgrade failed", { error: runtimeUpgradeState.error, services }, "openwork-orchestrator");
    } finally {
      releaseOperation();
    }
  };
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    restoreConsoleError?.();
    restoreConsoleError = undefined;
    if (opencodeRouterHealthInterval) {
      clearInterval(opencodeRouterHealthInterval);
      opencodeRouterHealthInterval = null;
    }
    if (controlServer) {
      await new Promise<void>((resolve) => controlServer?.close(() => resolve()));
      controlServer = null;
    }
    if (intentClassifierService) {
      await intentClassifierService.stop();
    }
    if (hybridDrSidecarService) {
      await hybridDrSidecarService.stop();
    }
    logger.info(
      "Shutting down",
      { children: children.map((handle) => handle.name) },
      "openwork-orchestrator",
    );
    await Promise.all(children.map((handle) => stopChild(handle.child)));
  };

  const detachChildren = () => {
    detached = true;
    for (const handle of children) {
      try {
        handle.child.unref();
      } catch {
        // ignore
      }
      handle.child.stdout?.removeAllListeners();
      handle.child.stderr?.removeAllListeners();
      handle.child.stdout?.destroy();
      handle.child.stderr?.destroy();
    }
    intentClassifierService?.detach();
  };

  const handleQuit = async () => {
    tui?.stop();
    await shutdown();
    process.exit(0);
  };

  const handleDetach = async () => {
    if (detached) return;
    restoreConsoleError?.();
    restoreConsoleError = undefined;
    if (opencodeRouterHealthInterval) {
      clearInterval(opencodeRouterHealthInterval);
      opencodeRouterHealthInterval = null;
    }
    tui?.stop();
    detachChildren();
    const summary = [
      "Detached. Services still running:",
      ...children.map((handle) => `- ${handle.name} (pid ${handle.child.pid ?? "unknown"})`),
      ...(intentClassifierService
        ? [`- intent-classifier (pid ${intentClassifierService.getStatus().pid ?? "unknown"})`]
        : []),
      ...(hybridDrSidecarService
        ? [`- hybrid-dr (pid ${hybridDrSidecarService.getStatus().pid ?? "unknown"})`]
        : []),
      `OpenWork URL: ${openworkConnectUrl}`,
      `OpenWork Token: ${openworkToken}`,
      `OpenCode URL: ${opencodeConnectUrl}`,
      `Attach: ${attachCommand}`,
    ].join("\n");
    process.stdout.write(`${summary}\n`);
    process.exit(0);
  };

  if (useTui) {
    if (compiledBinary) {
      const originalConsoleError = console.error.bind(console);
      restoreConsoleError = () => {
        console.error = originalConsoleError;
      };
      console.error = (...items: unknown[]) => {
        const text = items
          .map((item) => {
            if (typeof item === "string") return item;
            if (item instanceof Error) return `${item.name}: ${item.message}`;
            return String(item);
          })
          .join(" ");
        if (
          text.includes("React is not defined") ||
          text.includes("/$bunfs/root/openwork-orchestrator") ||
          text.includes("/$bunfs/root/openwork")
        ) {
          switchToPlainOutput(text);
        }
        originalConsoleError(...items);
      };
    }
    try {
      const { startOrchestratorTui } = await import("./tui/app.js");
      tui = startOrchestratorTui({
        version: cliVersion,
        connect: {
          runId,
          workspace: resolvedWorkspace,
          openworkUrl: openworkConnectUrl,
          openworkToken,
          hostToken: openworkHostToken,
          opencodeUrl: opencodeConnectUrl,
          opencodePassword: opencodePassword ?? undefined,
          opencodeUsername: opencodeUsername ?? undefined,
          attachCommand,
        },
        services: [
          { name: "opencode", label: "opencode", status: "starting", port: opencodePort },
          { name: "openwork-server", label: "openwork-server", status: "starting", port: openworkPort },
          {
            name: "router",
            label: "opencode-router",
            status: opencodeRouterEnabled ? "starting" : "disabled",
            port: opencodeRouterHealthPort,
          },
        ],
        onQuit: handleQuit,
        onDetach: handleDetach,
        onCopyAttach: async () => {
          const result = await copyToClipboard(attachCommand);
          return { command: attachCommand, ...result };
        },
        onCopySelection: async (text) => copyToClipboard(text),
        onRouterHealth: async () => fetchOpenCodeRouterHealthViaOpenwork(openworkBaseUrl, openworkToken),
        onRouterTelegramIdentities: async () => {
          const url = `${openworkBaseUrl.replace(/\/$/, "")}/opencode-router/identities/telegram`;
          const result = await fetchJson(url, {
            headers: {
              "X-OpenWork-Host-Token": openworkHostToken,
            },
          });
          const items = Array.isArray(result?.items) ? result.items : [];
          return { items };
        },
        onRouterSlackIdentities: async () => {
          const url = `${openworkBaseUrl.replace(/\/$/, "")}/opencode-router/identities/slack`;
          const result = await fetchJson(url, {
            headers: {
              "X-OpenWork-Host-Token": openworkHostToken,
            },
          });
          const items = Array.isArray(result?.items) ? result.items : [];
          return { items };
        },
        onRouterSetGroupsEnabled: async (enabled) => {
          try {
            const url = `${openworkBaseUrl.replace(/\/$/, "")}/opencode-router/config/groups`;
            await fetchJson(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-OpenWork-Host-Token": openworkHostToken,
              },
              body: JSON.stringify({ enabled }),
            });
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
        onRouterSetTelegramToken: async (token) => {
          try {
            const url = `${openworkBaseUrl.replace(/\/$/, "")}/opencode-router/identities/telegram`;
            await fetchJson(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-OpenWork-Host-Token": openworkHostToken,
              },
              body: JSON.stringify({ id: "default", token, enabled: true }),
            });
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
        onRouterSetSlackTokens: async (botToken, appToken) => {
          try {
            const url = `${openworkBaseUrl.replace(/\/$/, "")}/opencode-router/identities/slack`;
            await fetchJson(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-OpenWork-Host-Token": openworkHostToken,
              },
              body: JSON.stringify({ id: "default", botToken, appToken, enabled: true }),
            });
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      });
      tui.setUptimeStart(startedAt);
    } catch (error) {
      switchToPlainOutput(error instanceof Error ? error.message : String(error));
    }
  }

  const tuiServiceName = (name: string) => (name === "opencode-router" ? "router" : name);

  const handleExit = (name: string, code: number | null, signal: NodeJS.Signals | null) => {
    if (shuttingDown || detached) return;
    if (restartingServices.has(name)) {
      restartingServices.delete(name);
      return;
    }
    const reason = code !== null ? `code ${code}` : signal ? `signal ${signal}` : "unknown";
    const services = [tuiServiceName(name)];
    for (const service of services) {
      tui?.updateService(service, { status: "stopped", message: reason });
    }
    logger.error("Process exited", { reason, code, signal }, name);
    void shutdown().then(() => process.exit(code ?? 1));
  };

  const handleSpawnError = (name: string, error: unknown) => {
    if (shuttingDown || detached) return;
    tui?.updateService(tuiServiceName(name), { status: "error", message: String(error) });
    logger.error("Process failed to start", { error: String(error) }, name);
    void shutdown().then(() => process.exit(1));
  };

  const ensureOpenworkServerStarted = async (configureRouter: boolean): Promise<void> => {
    if (openworkChild) return;
    // An external server is already running and is not this process's to start, so only the spawn is
    // skipped. The health check below still runs, because that is the whole of what this supervisor is
    // entitled to assert about a process it does not own - and skipping it would let the rest of startup
    // proceed against a server that never answered.
    if (!openworkServerBinary) {
      if (externalOpenworkServerHealthy) return;
      logger.info(
        "Using Sandbox Manager managed openwork-server",
        { port: openworkPort },
        "openwork-server",
      );
      tui?.updateService("openwork-server", { status: "running", port: openworkPort });
      const externalHealthStartedAt = Date.now();
      logger.info("Waiting for health", { url: openworkBaseUrl }, "openwork-server");
      // Sandbox Manager launches Supervisor first and openwork-server last. The
      // external role therefore needs the same finite owner-startup window as
      // external Runtime; the generic 10s child-start window expires before the
      // owner can finish the intervening role launches.
      await waitForHealthy(openworkBaseUrl, EXTERNAL_HDR_RUNTIME_TIMEOUT_MS);
      logger.info(
        "Healthy",
        { url: openworkBaseUrl, durationMs: Math.round(Date.now() - externalHealthStartedAt) },
        "openwork-server",
      );
      externalOpenworkServerHealthy = true;
      tui?.updateService("openwork-server", { status: "healthy" });
      return;
    }
    const child = await startOpenworkServer({
      bin: openworkServerBinary.bin,
      host: openworkHost,
      port: openworkPort,
      workspace: resolvedWorkspace,
      token: openworkToken,
      hostToken: openworkHostToken,
      telemetryToken: openworkTelemetryToken,
      approvalMode: approvalMode === "auto" ? "auto" : "manual",
      approvalTimeoutMs,
      readOnly,
      corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
      opencodeBaseUrl,
      opencodeDirectory: resolvedWorkspace,
      opencodeUsername,
      opencodePassword,
      opencodeRouterHealthPort: configureRouter ? opencodeRouterHealthPort : undefined,
      opencodeRouterDataDir: configureRouter ? (opencodeRouterDataDir ?? undefined) : undefined,
      routerControlToken: configureRouter ? routerControlToken : undefined,
      llmrouterUrl,
      logger,
      runId,
      logFormat,
      controlBaseUrl,
      controlToken,
      intentClassifierToken: intentClassifierEndpoint?.token,
    });
    openworkChild = child;
    children.push({ name: "openwork-server", child });
    tui?.updateService("openwork-server", {
      status: "running",
      pid: child.pid ?? undefined,
      port: openworkPort,
    });
    logger.info("Process spawned", { pid: child.pid ?? 0 }, "openwork-server");
    child.on("exit", (code, signal) => handleExit("openwork-server", code, signal));
    child.on("error", (error) => handleSpawnError("openwork-server", error));
    const healthStartedAt = Date.now();
    logger.info("Waiting for health", { url: openworkBaseUrl }, "openwork-server");
    await waitForHealthy(openworkBaseUrl);
    const durationMs = Math.round(Date.now() - healthStartedAt);
    logger.info("Healthy", { url: openworkBaseUrl, durationMs }, "openwork-server");
    tui?.updateService("openwork-server", { status: "healthy" });
  };

  try {
    opencodeActualVersion =
      externalOpencode
        ? opencodeBinary.expectedVersion
        : await measureStartupPreparation("opencode_version_check", () => verifyOpencodeVersion(opencodeBinary));
    let opencodeClient: ReturnType<typeof createOpencodeClient>;

    controlServer = createHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", controlBaseUrl);
      res.setHeader("Content-Type", "application/json");
      const authHeader = req.headers.authorization ?? "";
      if (authHeader !== `Bearer ${controlToken}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      if (method === "GET" && url.pathname === "/runtime/instance") {
        res.statusCode = 200;
        res.end(JSON.stringify(runtimeDeploymentState.currentEvidence()));
        return;
      }
      if (method === "GET" && url.pathname === "/runtime/profile") {
        try {
          res.statusCode = 200;
          res.end(JSON.stringify(await runtimeProfileController.getStatus()));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({
            error: "runtime_profile_status_failed",
            message: error instanceof Error ? error.message : String(error),
          }));
        }
        return;
      }
      if (method === "GET" && url.pathname === "/runtime/versions") {
        res.statusCode = 200;
        res.end(JSON.stringify(getRuntimeSnapshot()));
        return;
      }
      if (method === "POST" && url.pathname === "/runtime/upgrade") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        let body: { services?: RuntimeServiceName[] } | null = null;
        try {
          body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { services?: RuntimeServiceName[] }) : null;
        } catch {
          body = null;
        }
        const requested = Array.isArray(body?.services) ? body.services : ["openwork-server", "opencode"];
        const services = Array.from(new Set(requested.filter((item): item is RuntimeServiceName => item === "openwork-server" || item === "opencode" || item === "opencode-router" || item === "intent-classifier" || item === "hybrid-dr")));
        if (!services.length) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: "invalid_services" }));
          return;
        }
        if (runtimeUpgradeState.status === "running") {
          res.statusCode = 409;
          res.end(JSON.stringify({ ok: false, error: "upgrade_in_progress", upgrade: runtimeUpgradeState }));
          return;
        }
        const releaseOperation = runtimeOperationLock.tryAcquireUpgrade();
        if (!releaseOperation) {
          res.statusCode = 409;
          res.end(JSON.stringify({ ok: false, error: "runtime_operation_in_progress" }));
          return;
        }
        res.statusCode = 202;
        res.end(JSON.stringify({ ok: true, started: true, services, upgrade: { ...runtimeUpgradeState, status: "running" } }));
        void performRuntimeUpgrade(services, releaseOperation);
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
    });
    await measureStartupPreparation(
      "control_server_listen",
      () =>
        new Promise<void>((resolve, reject) => {
          controlServer?.once("error", reject);
          controlServer?.listen(controlPort, "127.0.0.1", () => resolve());
        }),
    );

    const orchStart = Date.now();
    const childTimings: Array<{ name: string; durationMs: number }> = [];
    const markStartup = startupMarker(logger, orchStart);
    markStartup("orch_start");

    // The LLM router is now a Windows-host service (`llmrouter_manager`) on
    // port 18321; the orchestrator does not spawn a router and does no
    // edge-model / local-llm provider injection. opencode talks directly to the host router via the static
    // `llmrouter` provider in opencode.jsonc, which ships inside the packaged
    // Product Profile. Nothing to reconcile here at startup.

    // --- Hybrid Deep Research sidecar (managed by orchestrator so crashes
    // are restarted with backoff) ---
    if (hybridDrEnabled) {
      process.env.HYBRID_DR_PORT = String(hybridDrPort);
      if (externalHybridDr) {
        logger.info("Using Sandbox Manager managed Hybrid DR", { port: hybridDrPort }, "hybrid-dr");
        // SM starts HDR with Runtime and waits for it. Observe it only in final Profile proof, which
        // waits too; an early independent timeout can kill publication while SM is still starting roles.
      } else {
        hybridDrSidecarService = new HybridDrSidecarService({
        binaryBin: hybridDrBin,
        pythonBin: hybridDrPythonBin,
        module: hybridDrModule,
        host: hybridDrHost,
        port: hybridDrPort,
        logger,
        prefixStream: (stream, label, level, _logger, pid) => prefixStream(stream, label, level, logger, pid),
        spawnProcess,
      });
        const hybridDrSvcStart = Date.now();
        try {
        logger.info(
          `Startup preparation complete after_capability_barrier_ms=${Date.now() - capabilityBarrierCompletedAt}`,
          { afterCapabilityBarrierMs: Date.now() - capabilityBarrierCompletedAt },
          "openwork-orchestrator",
        );
        logger.info(
          "Starting Hybrid DR sidecar",
          { binaryBin: hybridDrBin ?? "(none)", pythonBin: hybridDrPythonBin ?? "(default)", module: hybridDrModule ?? "(default)", port: hybridDrPort },
          "hybrid-dr",
        );
        await hybridDrSidecarService.start();
        childTimings.push({ name: "hybrid-dr", durationMs: Math.round(Date.now() - hybridDrSvcStart) });
        } catch (error) {
        tui?.updateService("hybrid-dr", { status: "error", message: "degraded: unavailable" });
        if (hybridDrRequired) throw error;
        logger.warn(
          "Hybrid DR sidecar unavailable during startup; continuing without hybrid deep research",
          { error: error instanceof Error ? error.message : String(error) },
          "hybrid-dr",
        );
        }
      }
    } else {
      logger.info("Hybrid DR sidecar disabled by Product Profile", {}, "hybrid-dr");
    }

    // --- Intent Classifier (managed by orchestrator so runtime env updates,
    // including NO_PROXY changes from Connect Edge, apply on restart) ---
    let intentClassifierStartup: Promise<Settled> = Promise.resolve({ ok: true });
    if (intentClassifierRequired) {
      intentClassifierService = new IntentClassifierService({
        pythonBin: intentClassifierPythonBin,
        scriptPath: intentClassifierScript,
        host: intentClassifierHost,
        port: intentClassifierPort,
        classificationMode: intentClassifierMode,
        hybridDrEnabled,
        callerToken: intentClassifierEndpoint?.token,
        logger,
        prefixStream,
        spawnProcess,
      });
      intentClassifierService.onExit = (code, signal) => {
        const svcStatus = intentClassifierService!.getStatus().status;
        if (svcStatus === "stopped" || svcStatus === "starting") return;
        const reason = code !== null ? `code ${code}` : signal ? `signal ${signal}` : "unknown";
        tui?.updateService("intent-classifier", { status: "stopped", message: `degraded: ${reason}` });
        logger.warn(
          "Intent Classifier exited; continuing without intent classification",
          { reason, code, signal },
          "intent-classifier",
        );
      };
      intentClassifierService.onError = (error) => {
        const svcStatus = intentClassifierService!.getStatus().status;
        if (svcStatus === "stopped" || svcStatus === "starting") return;
        tui?.updateService("intent-classifier", { status: "error", message: "degraded" });
        logger.warn(
          "Intent Classifier failed; continuing without intent classification",
          { error: String(error) },
          "intent-classifier",
        );
      };
      const intentClassifierSvcStart = Date.now();
      logger.info(
        "Starting Intent Classifier",
        {
          pythonBin: intentClassifierPythonBin ?? "(default)",
          script: intentClassifierScript ?? "(default)",
          port: intentClassifierPort,
          classificationMode: intentClassifierMode,
        },
        "intent-classifier",
      );
      // Not awaited here: OpenCode does not call the classifier while it starts, and the classifier's
      // ~1.5 s health wait used to hold OpenCode's (#3928). A failure is thrown as soon as it happens,
      // racing the OpenCode wait, and the classifier is awaited before the router and openwork-server.
      const service = intentClassifierService;
      intentClassifierStartup = (async (): Promise<Settled> => {
        try {
          await service.start();
          childTimings.push({ name: "intent-classifier", durationMs: Math.round(Date.now() - intentClassifierSvcStart) });
          markStartup("intent_classifier_healthy");
          return { ok: true };
        } catch (error) {
          tui?.updateService("intent-classifier", { status: "error", message: "unavailable" });
          return { ok: false, error };
        }
      })();
    } else {
      logger.info("Intent Classifier disabled by Product Profile", {}, "intent-classifier");
    }

    // Kokoro TTS narration now runs as a native Windows-host ServiceHub child
    // (tts_manager), not in this process. See host/tts_manager/.

    if (externalOpencode) {
      logger.info("Using Sandbox Manager managed OpenCode", { port: opencodePort }, "opencode");
      tui?.updateService("opencode", { status: "running", port: opencodePort });
    } else {
      const startedOpencodeChild = await startOpencode({
        bin: opencodeBinary.bin,
        workspace: resolvedWorkspace,
        stateLayout: opencodeStateLayout,
        hotReload: opencodeHotReload,
        bindHost: opencodeBindHost,
        port: opencodePort,
        username: opencodeUsername,
        password: opencodePassword,
        corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
        logger,
        runId,
        logFormat,
        opencodeRouterHealthPort: opencodeRouterEnabled ? opencodeRouterHealthPort : undefined,
        controlToken: routerControlToken,
        telemetryToken: openworkTelemetryToken,
      });
      opencodeChild = startedOpencodeChild;
      children.push({ name: "opencode", child: startedOpencodeChild });
      tui?.updateService("opencode", {
        status: "running",
        pid: startedOpencodeChild.pid ?? undefined,
        port: opencodePort,
      });
      logger.info("Process spawned", { pid: startedOpencodeChild.pid ?? 0 }, "opencode");
      startedOpencodeChild.on("exit", (code, signal) => handleExit("opencode", code, signal));
      startedOpencodeChild.on("error", (error) => handleSpawnError("opencode", error));
    }

    const authHeaders: Record<string, string> = {};
    if (opencodeUsername && opencodePassword) {
      authHeaders.Authorization = `Basic ${encodeBasicAuth(opencodeUsername, opencodePassword)}`;
    }
    // egress-surface: supervisor_health_opencode
    opencodeClient = createOpencodeClient({
      baseUrl: opencodeBaseUrl,
      directory: resolvedWorkspace,
      headers: Object.keys(authHeaders).length ? authHeaders : undefined,
    });

    const opencodeHealthStart = Date.now();
    logger.info("Waiting for health", { url: opencodeBaseUrl }, "opencode");
    // SM owns startup; allow its full Connector/HDR/Runtime sequence, but still
    // terminate if the owner stalls. See the coordinated finite cap's derivation.
    // A classifier failure leaves this wait running; the "Run failed" path below exits the process.
    await awaitFailingFast(
      settle(waitForOpencodeHealthy(opencodeClient, externalHybridDr ? EXTERNAL_HDR_RUNTIME_TIMEOUT_MS : 10_000, 250, { baseUrl: opencodeBaseUrl, headers: authHeaders })),
      intentClassifierStartup,
    );
    externalOpencodeHealthy = externalOpencode;
    const opencodeHealthMs = Math.round(Date.now() - opencodeHealthStart);
    logger.info(`Healthy duration_ms=${opencodeHealthMs}`, { url: opencodeBaseUrl, durationMs: opencodeHealthMs }, "opencode");
    childTimings.push({ name: "opencode", durationMs: opencodeHealthMs });
    markStartup("opencode_healthy");
    // Started here and awaited before the ready evidence, so the UI's first calls after reveal do not
    // pay OpenCode's lazy init (5-19 s cold) against their 10 s timeout. The router, openwork-server
    // and the parts of the final Profile proof that do not reach OpenCode run while it warms up;
    // the proof's OpenCode checks wait for it. The catch is required, not defensive: this promise
    // stays unhandled for seconds, and an unhandled rejection in that window terminates the process
    // under Node's default `--unhandled-rejections=throw`.
    const prewarmTask = (async (): Promise<void> => {
      try {
        await prewarmOpencode(opencodeBaseUrl, authHeaders, logger);
      } catch (error) {
        logger.warn("Pre-warm failed (non-fatal)", { error: error instanceof Error ? error.message : String(error) }, "opencode");
      }
      markStartup("prewarm_complete");
    })();
    tui?.updateService("opencode", { status: "healthy" });
    throwIfFailed(await intentClassifierStartup);

    let opencodeRouterReady = false;
    if (opencodeRouterEnabled) {
      // Resolved before the try, not inside it, so that a version mismatch still propagates whatever
      // `opencodeRouterRequired` says - moving it in would silently downgrade a wrong binary to a
      // warning. An external router has no binary of ours to check, so this whole block is skipped
      // and the version stays unknown.
      let routerBin: string | null = null;
      if (!externalOpencodeRouter) {
        if (!opencodeRouterBinary) {
          throw new Error("OpenCodeRouter binary missing.");
        }
        opencodeRouterActualVersion = await verifyOpenCodeRouterVersion(opencodeRouterBinary);
        logVerbose(`opencodeRouter version: ${opencodeRouterActualVersion ?? "unknown"}`);
        routerBin = opencodeRouterBinary.bin;
      }

      try {
        if (routerBin === null) {
          logger.info(
            "Using Sandbox Manager managed opencode-router",
            { port: opencodeRouterHealthPort },
            "opencode-router",
          );
          tui?.updateService("router", { status: "running", port: opencodeRouterHealthPort });
        } else {
        const startedOpenCodeRouterChild = await startOpenCodeRouter({
          bin: routerBin,
          workspace: resolvedWorkspace,
          opencodeUrl: opencodeConnectUrl,
          opencodeUsername,
          opencodePassword,
          opencodeRouterHealthPort,
          opencodeRouterDataDir: opencodeRouterDataDir ?? undefined,
          controlToken: routerControlToken,
          llmrouterUrl,
          intentClassifier: intentClassifierEndpoint,
          logger,
          runId,
          logFormat,
        });
        opencodeRouterChild = startedOpenCodeRouterChild;
        children.push({ name: "opencode-router", child: startedOpenCodeRouterChild });
        tui?.updateService("router", {
          status: "running",
          pid: startedOpenCodeRouterChild.pid ?? undefined,
          port: opencodeRouterHealthPort,
        });
        logger.info("Process spawned", { pid: startedOpenCodeRouterChild.pid ?? 0 }, "opencode-router");
        startedOpenCodeRouterChild.on("exit", (code, signal) => {
          if (restartingServices.has("opencode-router")) {
            restartingServices.delete("opencode-router");
            return;
          }
          if (opencodeRouterRequired) {
            handleExit("opencode-router", code, signal);
            return;
          }
          const reason = code !== null ? `code ${code}` : signal ? `signal ${signal}` : "unknown";
          tui?.updateService("router", { status: "stopped", message: reason });
          logger.warn("Process exited, continuing without opencodeRouter", { reason, code, signal }, "opencode-router");
        });
        startedOpenCodeRouterChild.on("error", (error) => handleSpawnError("opencode-router", error));
        }

        // Shared by both branches on purpose: whether this supervisor started the router or connected
        // to one the owner started, the only claim it can make about it is that its health endpoint
        // answered.
        const healthBaseUrl = `http://127.0.0.1:${opencodeRouterHealthPort}`;
        const routerHealthStart = Date.now();
        logger.info("Waiting for health", { url: healthBaseUrl }, "opencode-router");
        const health = await waitForOpenCodeRouterHealthy(healthBaseUrl, 10_000, 400);
        const routerHealthMs = Math.round(Date.now() - routerHealthStart);
        tui?.setRouterHealth(health);
        tui?.updateService("router", { status: health.ok ? "healthy" : "running" });
        logger.info(`Healthy duration_ms=${routerHealthMs}`, { url: healthBaseUrl, ok: health.ok, durationMs: routerHealthMs }, "opencode-router");
        childTimings.push({ name: "opencode-router", durationMs: routerHealthMs });
        markStartup("opencode_router_healthy");
        opencodeRouterReady = true;
        externalOpencodeRouterHealthy = externalOpencodeRouter;
      } catch (error) {
        if (opencodeRouterRequired) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("OpenCodeRouter failed to start, continuing without it", { error: message }, "opencode-router");
        tui?.updateService("router", { status: "stopped", message });
        if (opencodeRouterChild) {
          try {
            opencodeRouterChild.kill();
          } catch {
            // ignore
          }
        }
        opencodeRouterChild = null;
        opencodeRouterReady = false;
      }
    }

    const openworkWasRunning = openworkChild !== null;
    const openworkSvcHealthStart = Date.now();
    await ensureOpenworkServerStarted(opencodeRouterReady);
    const openworkSvcHealthMs = Math.round(Date.now() - openworkSvcHealthStart);
    if (!openworkWasRunning) childTimings.push({ name: "openwork-server", durationMs: openworkSvcHealthMs });
    markStartup("openwork_server_healthy");

    try {
      openworkActualVersion = await verifyOpenworkServer({
        baseUrl: openworkBaseUrl,
        token: openworkToken,
        hostToken: openworkHostToken,
        expectedVersion: openworkServerBinary?.expectedVersion,
        expectedWorkspace: resolvedWorkspace,
        expectedOpencodeBaseUrl: opencodeBaseUrl,
        expectedOpencodeDirectory: resolvedWorkspace,
        expectedOpencodeUsername: opencodeUsername,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`External OpenWork verification failed: ${message}`, {}, "openwork-server");
      throw error;
    }
    if (openworkHostToken) {
      openworkOwnerToken = await issueOpenworkOwnerToken(openworkBaseUrl, openworkHostToken, "OpenWork owner token");
    }
    logVerbose(`openwork-server version: ${openworkActualVersion ?? "unknown"}`);

    if (opencodeRouterReady && !opencodeRouterHealthInterval) {
      opencodeRouterHealthInterval = setInterval(() => {
        fetchOpenCodeRouterHealthViaOpenwork(openworkBaseUrl, openworkToken)
          .then((health) => {
            tui?.setRouterHealth(health);
            if (health.ok) {
              tui?.updateService("router", { status: "healthy" });
            }
          })
          .catch(() => undefined);
      }, 15_000);
    }


    markStartup("openwork_server_verified");
    if (startupProfileTarget) {
      await runtimeProfileController.completeStartup(startupProfileTarget, {
        openCodeSettled: prewarmTask,
        onStep: (step) => markStartup(`proof_${step}`),
      });
    }
    await prewarmTask;
    runtimeDeploymentState.markReady({
      components: { opencode: true, openwork: true },
      intentClassifierMode: startupProfileDescriptor.feature_flags.intent_classifier ? "enabled" : "bypass",
      hybridDrStatus: startupProfileDescriptor.feature_flags.hybrid_deep_research_agent ? "healthy" : "absent",
    });
    markStartup("ready_evidence_written");
    const orchTotalMs = Math.round(Date.now() - orchStart);
    const childrenStr = childTimings.map((t) => `${t.name}:${t.durationMs}`).join("|");
    logger.info(`Runtime ready total_ms=${orchTotalMs} children=${childrenStr}`, { totalMs: orchTotalMs, children: childTimings }, "openwork-orchestrator");

    const payload = {
      runId,
      workspace: resolvedWorkspace,
      approval: {
        mode: approvalMode,
        timeoutMs: approvalTimeoutMs,
        readOnly,
      },
      opencode: {
        baseUrl: opencodeBaseUrl,
        connectUrl: opencodeConnectUrl,
        username: opencodeUsername,
        password: opencodePassword,
        bindHost: opencodeBindHost,
        port: opencodePort,
        hotReload: opencodeHotReload,
        version: opencodeActualVersion,
      },
      openwork: {
        baseUrl: openworkBaseUrl,
        connectUrl: openworkConnectUrl,
        host: openworkHost,
        port: openworkPort,
        collaboratorToken: openworkToken,
        ownerToken: openworkOwnerToken,
        token: openworkToken,
        hostToken: openworkHostToken,
        version: openworkActualVersion,
      },
      opencodeRouter: {
        enabled: opencodeRouterEnabled,
        version: opencodeRouterEnabled ? opencodeRouterActualVersion : undefined,
        healthPort: opencodeRouterHealthPort,
      },
      diagnostics: {
        cliVersion,
        sidecar: {
          dir: sidecar.dir,
          baseUrl: sidecar.baseUrl,
          manifestUrl: sidecar.manifestUrl,
          target: sidecar.target,
          source: sidecarSource,
          opencodeSource,
          allowExternal,
        } as SidecarDiagnostics,
        binaries: {
          opencode: {
            path: opencodeBinary.bin,
            source: opencodeBinary.source,
            expectedVersion: opencodeBinary.expectedVersion,
            actualVersion: opencodeActualVersion,
          } as BinaryDiagnostics,
          // Null when the lifecycle is external, mirroring the router's shape below: this block reports
          // the binaries this supervisor resolved, and it resolved none for a service it does not spawn.
          openworkServer: openworkServerBinary
            ? ({
                path: openworkServerBinary.bin,
                source: openworkServerBinary.source,
                expectedVersion: openworkServerBinary.expectedVersion,
                actualVersion: openworkActualVersion,
              } as BinaryDiagnostics)
            : null,
          opencodeRouter: opencodeRouterBinary
            ? ({
                path: opencodeRouterBinary.bin,
                source: opencodeRouterBinary.source,
                expectedVersion: opencodeRouterBinary.expectedVersion,
                actualVersion: opencodeRouterActualVersion,
              } as BinaryDiagnostics)
            : null,
        },
      },
    };

    const redactSecret = (s: string | undefined | null): string | undefined => {
      if (!s) return s ?? undefined;
      return `<redacted, fp=${s.slice(0, 4)}… len=${s.length}>`;
    };
    const redactOpencodeForLog = (o: typeof payload.opencode) => ({
      ...o,
      password: o.password ? "<redacted>" : undefined,
    });
    const redactOpenworkForLog = (o: typeof payload.openwork) => ({
      ...o,
      collaboratorToken: redactSecret(o.collaboratorToken),
      ownerToken: redactSecret(o.ownerToken),
      token: redactSecret(o.token),
      hostToken: redactSecret(o.hostToken),
    });

    if (outputJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (useTui) {
      logger.info(
        "Ready",
        {
          workspace: payload.workspace,
          opencode: redactOpencodeForLog(payload.opencode),
          openwork: redactOpenworkForLog(payload.openwork),
          opencodeRouter: payload.opencodeRouter,
        },
        "openwork-orchestrator",
      );
    } else if (logFormat === "json") {
      logger.info(
        "Ready",
        {
          workspace: payload.workspace,
          opencode: redactOpencodeForLog(payload.opencode),
          openwork: redactOpenworkForLog(payload.openwork),
          opencodeRouter: payload.opencodeRouter,
        },
        "openwork-orchestrator",
      );
    } else {
      const fp = (s: string) => `${s.slice(0, 4)}… len=${s.length}`;
      console.log("OpenWork orchestrator running");
      console.log(`Run ID: ${runId}`);
      console.log(`Workspace: ${payload.workspace}`);
      console.log(`OpenCode: ${payload.opencode.baseUrl}`);
      console.log(`OpenCode connect URL: ${payload.opencode.connectUrl}`);
      if (payload.opencode.username && payload.opencode.password) {
        console.log(`OpenCode auth: ${payload.opencode.username} / <redacted>`);
      }
      console.log(`OpenWork server: ${payload.openwork.baseUrl}`);
      console.log(`OpenWork connect URL: ${payload.openwork.connectUrl}`);
      console.log(`Collaborator token: <redacted, ${fp(payload.openwork.collaboratorToken)}>`);
      console.log("  Routine remote access for shared workers. Use --output-json to obtain the raw value.");
      if (payload.openwork.ownerToken) {
        console.log(`Owner token: <redacted, ${fp(payload.openwork.ownerToken)}>`);
        console.log("  Use this when the remote client must answer permission prompts. Use --output-json for the raw value.");
      }
      if (payload.openwork.hostToken) {
        console.log(`Host admin token: <redacted, ${fp(payload.openwork.hostToken)}>`);
        console.log("  Internal host/admin token for approvals CLI and host-only APIs. Use --output-json for the raw value.");
      }
    }

    if (detachRequested) {
      await handleDetach();
    }

    if (checkOnly) {
      try {
        await runChecks({
          opencodeClient,
          openworkUrl: openworkBaseUrl,
          openworkToken,
          hostToken: openworkHostToken,
          checkEvents,
        });
        logger.info("Checks ok", { checkEvents }, "openwork-orchestrator");
        if (!outputJson && logFormat === "pretty") {
          console.log("Checks: ok");
        }
      } catch (error) {
        logger.error("Checks failed", { error: String(error) }, "openwork-orchestrator");
        await shutdown();
        tui?.stop();
        process.exit(1);
      }
      await shutdown();
      tui?.stop();
      process.exit(0);
    }

    process.on("SIGINT", () => shutdown().then(() => process.exit(0)));
    process.on("SIGTERM", () => shutdown().then(() => process.exit(0)));
    await new Promise(() => undefined);
  } catch (error) {
    await shutdown();
    tui?.stop();
    logger.error(
      `Run failed error=${error instanceof Error ? error.message : String(error)}`,
      { error: error instanceof Error ? error.message : String(error) },
      "openwork-orchestrator",
    );
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (readBool(args.flags, "help", false) || args.flags.get("help") === true) {
    printHelp();
    return;
  }
  if (readBool(args.flags, "version", false) || args.flags.get("version") === true) {
    console.log(await resolveCliVersion());
    return;
  }

  const command = args.positionals[0] ?? "start";
  if (command === "start") {
    await runStart(args);
    return;
  }
  if (command === "serve") {
    args.flags.set("tui", false);
    await runStart(args);
    return;
  }
  if (command === "daemon") {
    await runDaemonCommand(args);
    return;
  }
  if (command === "workspace" || command === "workspaces") {
    await runWorkspaceCommand(args);
    return;
  }
  if (command === "instance") {
    await runInstanceCommand(args);
    return;
  }
  if (command === "approvals") {
    await runApprovals(args);
    return;
  }
  if (command === "files") {
    await runFiles(args);
    return;
  }
  if (command === "status") {
    await runStatus(args);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
