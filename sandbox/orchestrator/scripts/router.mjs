import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "..", "dist", "cli.js");
const repoRoot = resolve(__dirname, "..", "..", "..");

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (err) => reject(err));
    server.listen(0, "127.0.0.1", () => {
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

async function waitFor(url, timeoutMs = 30_000, pollMs = 250) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      // egress-surface: developer_script_supervisor_daemon
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw lastError ?? new Error("Timed out waiting for daemon");
}

async function runCli(args, dataDir, extraEnv = {}, daemonArgs = []) {
  const child = spawn("node", [cliPath, ...args, ...daemonArgs], {
    env: {
      ...process.env,
      OPENWORK_DATA_DIR: dataDir,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const [code] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(JSON.stringify({ args: [...args, ...daemonArgs], stderr: stderr.trim(), stdout: stdout.trim(), code }));
  }
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

async function createProductProfileEnv(root) {
  const profilesRoot = join(root, "profiles");
  const profileRoot = join(profilesRoot, "lite");
  const sourceProfile = join(repoRoot, "sandbox", "agent_config", "profiles", "lite");
  const runtimeScaffoldRoot = join(root, "opencode-deps");
  await cp(sourceProfile, profileRoot, { recursive: true });
  await mkdir(join(runtimeScaffoldRoot, "node_modules"), { recursive: true });
  await writeFile(join(runtimeScaffoldRoot, "package-lock.json"), "{}\n", "utf8");
  await cp(join(sourceProfile, "package.json"), join(runtimeScaffoldRoot, "package.json"));
  return {
    SC_PRODUCT_PROFILE_SOURCE_ROOT: profilesRoot,
    SC_OPENCODE_DEPS_ROOT: runtimeScaffoldRoot,
    SUPERCLAW_PRODUCT_PROFILE: "lite",
  };
}

async function createFakeOpencodeBin(root) {
  const scriptPath = join(root, "fake-opencode.js");
  await writeFile(scriptPath, `#!/usr/bin/env node
import { createServer } from "node:http";
if (process.argv.includes("--version")) {
  console.log("opencode 1.18.25");
  process.exit(0);
}
const portIndex = process.argv.indexOf("--port");
const hostIndex = process.argv.indexOf("--hostname");
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 4096;
const host = hostIndex >= 0 ? process.argv[hostIndex + 1] : "127.0.0.1";
const server = createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  if (req.url && req.url.includes("/path")) {
    const url = new URL(req.url, "http://127.0.0.1");
    const directory = url.searchParams.get("directory") || url.searchParams.get("dir") || process.env.OPENCODE_DIRECTORY || process.cwd();
    res.end(JSON.stringify({ directory }));
  } else if (req.url && req.url.includes("/instance/dispose")) {
    res.end(JSON.stringify(true));
  } else {
    res.end(JSON.stringify({ ok: true, version: "1.18.25" }));
  }
});
server.listen(port, host);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`, "utf8");
  return scriptPath;
}

const root = await mkdtemp(join(tmpdir(), "openwork-orchestrator-router-"));
const dataDir = join(root, "data");
const workspaceA = join(root, "ws-a");
const workspaceB = join(root, "ws-b");
await mkdir(workspaceA, { recursive: true });
await mkdir(workspaceB, { recursive: true });
const profileEnv = await createProductProfileEnv(root);
const fakeOpencodeBin = await createFakeOpencodeBin(root);

const daemonPort = await findFreePort();
const opencodePort = await findFreePort();
const daemonUrl = `http://127.0.0.1:${daemonPort}`;
const daemonArgs = ["--daemon-host", "127.0.0.1", "--daemon-port", String(daemonPort)];

const daemon = spawn(
  "node",
  [
    cliPath,
    "daemon",
    "run",
    "--data-dir",
    dataDir,
    "--daemon-host",
    "127.0.0.1",
    "--daemon-port",
    String(daemonPort),
    "--opencode-port",
    String(opencodePort),
    "--allow-external",
    "--opencode-source",
    "external",
    "--opencode-bin",
    fakeOpencodeBin,
  ],
  {
    env: {
      ...process.env,
      OPENWORK_DATA_DIR: dataDir,
      ...profileEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

// Surface daemon output so CI failures can be diagnosed instead of timing out silently.
daemon.stdout?.setEncoding("utf8");
daemon.stderr?.setEncoding("utf8");
daemon.stdout?.on("data", (chunk) => {
  for (const line of chunk.split("\n").filter(Boolean)) process.stderr.write(`[daemon stdout] ${line}\n`);
});
daemon.stderr?.on("data", (chunk) => {
  for (const line of chunk.split("\n").filter(Boolean)) process.stderr.write(`[daemon stderr] ${line}\n`);
});

try {
  await waitFor(`${daemonUrl}/health`);

  const addedA = await runCli(["workspace", "add", workspaceA, "--json"], dataDir, profileEnv, daemonArgs);
  const addedB = await runCli(["workspace", "add", workspaceB, "--json"], dataDir, profileEnv, daemonArgs);
  const idA = addedA.workspace.id;
  const idB = addedB.workspace.id;

  const status1 = await runCli(["daemon", "status", "--json"], dataDir, profileEnv, daemonArgs);
  const pid1 = status1.opencode.pid;

  const pathA = await runCli(["workspace", "path", idA, "--json"], dataDir, profileEnv, daemonArgs);
  const pathB = await runCli(["workspace", "path", idB, "--json"], dataDir, profileEnv, daemonArgs);

  assert.equal(pathA.path.directory, workspaceA);
  assert.equal(pathB.path.directory, workspaceB);

  const status2 = await runCli(["daemon", "status", "--json"], dataDir, profileEnv, daemonArgs);
  const pid2 = status2.opencode.pid;
  assert.equal(pid1, pid2);

  const disposed = await runCli(["instance", "dispose", idA, "--json"], dataDir, profileEnv, daemonArgs);
  assert.equal(disposed.disposed, true);

  const pathA2 = await runCli(["workspace", "path", idA, "--json"], dataDir, profileEnv, daemonArgs);
  assert.equal(pathA2.path.directory, workspaceA);

  await runCli(["daemon", "stop", "--json"], dataDir, profileEnv, daemonArgs);
  await Promise.race([once(daemon, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);

  console.log(JSON.stringify({ ok: true, dataDir, daemonUrl, workspaces: [idA, idB] }, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      { ok: false, error: error instanceof Error ? error.message : String(error), daemonUrl },
      null,
      2,
    ),
  );
  process.exitCode = 1;
  try {
    await runCli(["daemon", "stop", "--json"], dataDir, profileEnv, daemonArgs);
  } catch {
    // ignore
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
