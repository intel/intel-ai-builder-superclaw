import os from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";
import { buildTrajectoryCommand, buildTrajectoryEnv, stopTrajectoryProcess } from "./trajectory-dev-process";

const portValue = Number.parseInt(process.env.PORT ?? "", 10);
const devPort = Number.isFinite(portValue) && portValue > 0 ? portValue : 5173;
const allowedHosts = new Set<string>();
const envAllowedHosts = process.env.VITE_ALLOWED_HOSTS ?? "";

const addHost = (value?: string | null) => {
  const trimmed = value?.trim();
  if (!trimmed) return;
  allowedHosts.add(trimmed);
};

envAllowedHosts.split(",").forEach(addHost);
addHost(process.env.OPENWORK_PUBLIC_HOST ?? null);
const hostname = os.hostname();
addHost(hostname);
const shortHostname = hostname.split(".")[0];
if (shortHostname && shortHostname !== hostname) {
  addHost(shortHostname);
}

// ── Trajectory inspector auto-start (dev only) ───────────────────────────
// Enabled in dev (mode === "development") or when BUILD_DEBUG=1. Spawns the
// Bun-based trajectory inspector as a child process alongside the Vite dev server.

function trajectoryAutoStart(mode: string): Plugin {
  let child: ChildProcess | null = null;
  const trajectoryRoot = join(__dirname, "..", "..", "tools", "trajectory");
  const entryFile = join(trajectoryRoot, "src", "main.ts");

  function shutdownTokenPath(): string {
    return join(os.tmpdir(), "superclaw-trajectory", `shutdown-${trajectoryPort}.token`);
  }

  function resolveShutdownToken(): string {
    const tokenPath = shutdownTokenPath();
    try {
      const existing = readFileSync(tokenPath, "utf-8").trim();
      if (existing) return existing;
    } catch {
      // fall through and create a token
    }

    const token = randomBytes(32).toString("hex");
    mkdirSync(join(os.tmpdir(), "superclaw-trajectory"), { recursive: true });
    writeFileSync(tokenPath, token, { encoding: "utf-8", mode: 0o600 });
    return token;
  }

  function isBunAvailable(): boolean {
    try {
      execSync("bun --version", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  async function checkRunningServer(): Promise<"ready" | "stale" | "none"> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    try {
      const r = await fetch(`http://127.0.0.1:${trajectoryPort}/health`, {
        signal: controller.signal,
      });
      if (!r.ok) return "none";
      const body = await r.json() as { authReady?: unknown };
      return body.authReady === true ? "ready" : "stale";
    } catch {
      return "none";
    } finally {
      clearTimeout(timeout);
    }
  }

  async function stopRunningServer(shutdownToken: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    try {
      const r = await fetch(`http://127.0.0.1:${trajectoryPort}/shutdown`, {
        method: "POST",
        headers: { "X-Trajectory-Shutdown": shutdownToken },
        signal: controller.signal,
      });
      return r.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Detect the OWT token from Node.js (avoids Bun proxy issues).
   * Uses the explicit environment override or the ServiceHub broker.
   */
  async function detectToken(): Promise<string | null> {
    // 0. Explicit env var override (same as tools/trajectory/src/server.ts)
    const envToken = process.env.TRAJECTORY_TOKEN?.trim();
    if (envToken) {
      console.log("[trajectory] token from TRAJECTORY_TOKEN env var");
      return envToken;
    }

    // 1. ServiceHub lock file → Hub-proxied OWT API
    // ServiceHub writes %LOCALAPPDATA%/SuperClaw/servicehub/servicehub.lock (overridable
    // via SERVICEHUB_DATA_DIR) as {pid, port, token}. `token` is the Hub bearer token
    // and `port` is the Hub port, so the OWT comes from the Hub-proxied path.
    try {
      const dataDir = process.env.SERVICEHUB_DATA_DIR;
      const localAppData = process.env.LOCALAPPDATA;
      const lockPath = dataDir
        ? join(dataDir, "servicehub.lock")
        : localAppData
          ? join(localAppData, "SuperClaw", "servicehub", "servicehub.lock")
          : null;
      if (lockPath && existsSync(lockPath)) {
        const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as {
          port?: number;
          token?: string;
        };
        const port = lock.port;
        if (
          typeof port === "number" &&
          Number.isInteger(port) &&
          port > 0 &&
          port <= 65535 &&
          typeof lock.token === "string" &&
          lock.token
        ) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2000);
          const r = await fetch(
            `http://127.0.0.1:${port}/app/runtime/sandbox-token`,
            {
              headers: { Authorization: `Bearer ${lock.token}` },
              signal: controller.signal,
            },
          );
          clearTimeout(timeout);
          if (r.ok) {
            const data = (await r.json()) as { token?: string };
            if (typeof data.token === "string" && data.token.length > 0) {
              console.log("[trajectory] token from ServiceHub OWT API");
              return data.token;
            }
          }
        }
      }
    } catch {
      // fall through
    }

    return null;
  }

  /** Prepend 127.0.0.1,localhost to NO_PROXY so Node & Bun skip corporate proxies for local requests. */
  function ensureLocalNoProxy(): string {
    const bypass = "127.0.0.1,localhost";
    const existing = process.env.NO_PROXY || process.env.no_proxy || "";
    if (existing.includes("127.0.0.1")) return existing;
    const merged = existing ? `${bypass},${existing}` : bypass;
    process.env.NO_PROXY = merged;
    process.env.no_proxy = merged;
    return merged;
  }

  return {
    name: "trajectory-auto-start",
    apply: "serve",

    async configureServer(server) {
      if (process.env.BUILD_DEBUG !== "1" && mode !== "development") return;

      // Must run before any fetch (isAlreadyRunning, detectToken) and is
      // also forwarded to the Bun subprocess so its fetch bypasses proxies.
      const noProxy = ensureLocalNoProxy();
      const shutdownToken = resolveShutdownToken();

      if (!existsSync(entryFile)) {
        console.warn("[trajectory] entry not found:", entryFile);
        return;
      }
      if (!isBunAvailable()) {
        console.warn("[trajectory] bun not found in PATH — skipping auto-start");
        return;
      }
      const runningState = await checkRunningServer();
      if (runningState !== "none") {
        console.warn(`[trajectory] existing server on port ${trajectoryPort} detected (${runningState}) — restarting to avoid stale auth`);
        if (await stopRunningServer(shutdownToken)) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        } else {
          console.warn(`[trajectory] could not stop existing server on port ${trajectoryPort}; reusing it may keep stale auth`);
          return;
        }
      }

      // Ensure trajectory dependencies are installed (node_modules is gitignored)
      if (!existsSync(join(trajectoryRoot, "node_modules"))) {
        try {
          execSync("bun install --frozen-lockfile", {
            cwd: trajectoryRoot,
            stdio: "ignore",
            shell: process.platform === "win32" ? "cmd.exe" : undefined,
          });
        } catch {
          try {
            execSync("bun install", {
              cwd: trajectoryRoot,
              stdio: "ignore",
              shell: process.platform === "win32" ? "cmd.exe" : undefined,
            });
          } catch (err) {
            console.warn("[trajectory] bun install failed:", (err as Error).message);
          }
        }
      }

      // Detect token from Node.js to avoid Bun proxy issues in the subprocess.
      const token = await detectToken();
      if (!token) {
        console.warn("[trajectory] could not detect auth token — starting and waiting for auth");
      }

      const trajectoryCommand = buildTrajectoryCommand();
      const proc = spawn(trajectoryCommand.command, trajectoryCommand.args, {
        cwd: trajectoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildTrajectoryEnv(token, noProxy, trajectoryPort, shutdownToken),
        shell: false,
        windowsHide: true,
      });
      child = proc as ChildProcess;

      const prefix = (stream: NodeJS.ReadableStream) => {
        stream.on("data", (chunk: Buffer) => {
          const lines = chunk.toString().split("\n").filter(Boolean);
          for (const line of lines) {
            console.log(`[trajectory] ${line}`);
          }
        });
      };
      if (proc.stdout) prefix(proc.stdout);
      if (proc.stderr) prefix(proc.stderr);

      // ChildProcessByStdio lacks EventEmitter methods under types:["vite/client"].
      // Use the untyped addListener that exists on the prototype at runtime.
      (proc as unknown as NodeJS.EventEmitter).on("error", (err: Error) => {
        console.warn("[trajectory] spawn error:", err.message);
        child = null;
      });
      (proc as unknown as NodeJS.EventEmitter).on("exit", (code: number | null) => {
        if (code !== null && code !== 0) {
          console.warn(`[trajectory] exited with code ${code}`);
        }
        child = null;
      });

      server.httpServer?.on("close", () => {
        if (child && !child.killed) {
          stopTrajectoryProcess(child);
          child = null;
        }
      });
    },
  };
}

const trajectoryPort = Number(process.env.TRAJECTORY_PORT) || 7778;

// `~/x` -> `src/x`, matching the `paths` mapping in tsconfig.json. A regex `find`
// rather than the string form so it can only match the `~/` prefix: a bare `"~"`
// key is a prefix match, which would also rewrite a package named `~something`.
// Forward slashes because Vite compares and rewrites ids in posix form.
const srcAlias = {
  find: /^~\//,
  replacement: `${join(__dirname, "src").replace(/\\/g, "/")}/`,
};

export default defineConfig(({ mode }) => ({
  // hot: disabled under Vitest - Vitest runs Vite in "serve" mode, which
  // would otherwise make vite-plugin-solid inject its HMR runtime
  // (@solid-refresh). Vitest 4's module resolution rejects that virtual
  // specifier ("filename must be a file URL..."), and HMR has no meaning in
  // a test run anyway. The actual dev server (`pnpm dev`) is unaffected.
  plugins: [tailwindcss(), solid({ hot: !process.env.VITEST }), trajectoryAutoStart(mode)],
  resolve: {
    alias: [srcAlias],
  },
  define: {
    "import.meta.env.VITE_TRAJECTORY_PORT": JSON.stringify(trajectoryPort),
    __BUILD_DEBUG__: JSON.stringify(process.env.BUILD_DEBUG === "1" || mode === "development"),
    __OTA_TEST_CHANNEL__: JSON.stringify(process.env.SUPERCLAW_OTA_TEST_CHANNEL === "1"),
  },
  server: {
    host: true,
    port: devPort,
    strictPort: true,
    ...(allowedHosts.size > 0 ? { allowedHosts: Array.from(allowedHosts) } : {}),
  },
 build: {
    target: "esnext",
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
    },
  },
}));
