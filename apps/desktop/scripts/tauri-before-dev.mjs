import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const readPort = () => {
  const value = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 5173;
};

const hostOverride = process.env.OPENWORK_DEV_HOST?.trim() || null;
const port = readPort();

// Candidate dev-server hosts. When OPENWORK_DEV_HOST is set we trust only that
// single host; otherwise we probe the loopback defaults.
const candidateHosts = hostOverride ? [hostOverride] : ["127.0.0.1", "localhost"];

// Parse each candidate host into a fully-formed origin and reject anything that
// smuggles extra URL structure (credentials, path, query, fragment) or a
// mismatched port. This validates the untrusted OPENWORK_DEV_HOST value up front.
const buildDevOrigin = (host) => {
  try {
    const url = new URL(`http://${host}:${port}`);
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !url.hostname
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};

const devOrigins = candidateHosts.map(buildDevOrigin).filter((url) => url !== null);
const allowedHostnames = new Set(devOrigins.map((url) => url.hostname));
const allowedOrigins = new Set(devOrigins.map((url) => url.origin));
const baseUrls = devOrigins.map((url) => url.origin);

// Validate a URL before we probe it by comparing the parsed hostname and origin
// with exact equality against the allowlist. This intentionally avoids the weak
// "substring/includes" style of URL check (CWE-187): a hostile value cannot embed
// an allowed host in an unexpected position and slip through.
const isAllowedDevUrl = (candidate) => {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  return url.protocol === "http:" && allowedHostnames.has(url.hostname) && allowedOrigins.has(url.origin);
};

const fetchWithTimeout = async (url, { timeoutMs = 1200 } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
};

const killProcessTree = (child) => {
  if (!child?.pid) return;

  if (process.platform === "win32") {
    // Best-effort: kill process + children.
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // ignore
    }
    return;
  }

  // If spawned detached, pid is also the process group id.
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  // Escalate if it doesn't stop quickly.
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }, 1500);
  timer.unref?.();
};

const holdOpenUntilSignal = ({ uiChild } = {}) => {
  // Node 25+ may exit with a non-zero status when it detects an unsettled
  // top-level await. We avoid top-level await entirely and keep the event loop
  // alive with a timer until Tauri stops the dev process.
  const timer = setInterval(() => {}, 60_000);

  let stopping = false;

  const stop = () => {
    if (stopping) return;
    stopping = true;

    if (uiChild) {
      killProcessTree(uiChild);
    }

    clearInterval(timer);
    process.exit(0);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
};

const portHasHttpServer = async (baseUrl) => {
  if (!isAllowedDevUrl(baseUrl)) return false;
  try {
    await fetchWithTimeout(baseUrl, { timeoutMs: 900 });
    return true;
  } catch {
    return false;
  }
};

// MIME types Vite may use when serving its dev client module. Compared exactly
// (no substring matching) against the parsed Content-Type essence.
const JS_MIME_TYPES = new Set([
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/ecmascript",
  "application/ecmascript",
]);

const looksLikeVite = async (baseUrl) => {
  // Only probe origins that pass exact-equality validation against the allowlist.
  if (!isAllowedDevUrl(baseUrl)) return false;

  try {
    const res = await fetchWithTimeout(`${baseUrl}/@vite/client`, { timeoutMs: 1200 });
    if (!res.ok) return false;

    // Vite serves /@vite/client as a JS module. Decide based on an exact MIME
    // comparison of the parsed Content-Type. We deliberately do NOT sniff the
    // response body: a substring check on data derived from an untrusted URL is
    // a weak URL-sanitization pattern (CWE-187).
    const mimeType = (res.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    return JS_MIME_TYPES.has(mimeType);
  } catch {
    return false;
  }
};

const runPrepareSidecars = () => {
  const prepareScript = resolve(fileURLToPath(new URL("./prepare-sidecar.mjs", import.meta.url)));
  const args = [prepareScript];
  if (process.env.OPENWORK_SIDECAR_FORCE_BUILD !== "0") {
    args.push("--force");
  }
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const readLinuxReleaseInfo = () => {
  try {
    const content = readFileSync("/etc/os-release", "utf8");
    const values = new Map();
    for (const line of content.split(/\r?\n/)) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const separator = line.indexOf("=");
      const key = line.slice(0, separator);
      const rawValue = line.slice(separator + 1).trim();
      const value = rawValue.replace(/^"|"$/g, "");
      values.set(key, value);
    }
    return {
      id: values.get("ID") ?? "",
      like: values.get("ID_LIKE") ?? "",
      prettyName: values.get("PRETTY_NAME") ?? values.get("NAME") ?? "Linux",
    };
  } catch {
    return { id: "", like: "", prettyName: "Linux" };
  }
};

const getLinuxDesktopDependencyHint = () => {
  const release = readLinuxReleaseInfo();
  const family = `${release.id} ${release.like}`.toLowerCase();

  if (family.includes("arch")) {
    return "Install the missing desktop dependency and retry:\n  sudo pacman -S --needed webkit2gtk-4.1";
  }

  if (family.includes("ubuntu") || family.includes("debian")) {
    return (
      "Install the missing desktop dependencies and retry:\n" +
      "  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev"
    );
  }

  if (family.includes("fedora") || family.includes("rhel")) {
    return (
      "Install the missing desktop dependencies and retry:\n" +
      "  sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel"
    );
  }

  return `Install WebKitGTK 4.1 development packages for ${release.prettyName} so pkg-config can resolve both webkit2gtk-4.1 and javascriptcoregtk-4.1, then retry.`;
};

const ensureLinuxDesktopDependencies = () => {
  if (process.platform !== "linux") return;

  const requiredPkgConfigs = ["webkit2gtk-4.1", "javascriptcoregtk-4.1"];
  const missing = requiredPkgConfigs.filter((pkg) => {
    const result = spawnSync("pkg-config", ["--exists", pkg], { stdio: "ignore" });
    return result.status !== 0;
  });

  if (missing.length === 0) return;

  console.error(
    "[openwork] Missing Linux desktop system dependencies required by Tauri:\n" +
      `  ${missing.join(", ")}\n\n` +
      `${getLinuxDesktopDependencyHint()}\n\n` +
      "If you only need the web UI, run `pnpm dev:ui`."
  );
  process.exit(1);
};

const runUiDevServer = () => {
  const child = spawn(pnpmCmd, ["-w", "dev:ui"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      // Make sure vite sees the intended port.
      PORT: String(port),
      // Ensure localhost traffic bypasses corporate proxies so that the
      // trajectory Vite plugin (which spawns a Bun subprocess that fetches
      // http://127.0.0.1:8787) does not route through the proxy.
      NO_PROXY: ["127.0.0.1", "localhost", process.env.NO_PROXY || process.env.no_proxy || ""].filter(Boolean).join(","),
      no_proxy: ["127.0.0.1", "localhost", process.env.NO_PROXY || process.env.no_proxy || ""].filter(Boolean).join(","),
    },
  });

  const forwardSignal = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) process.exit(0);
    process.exit(code ?? 0);
  });

  return child;
};

// Build sidecars automatically to prevent missing binary errors
runPrepareSidecars();
ensureLinuxDesktopDependencies();

const main = async () => {
  let detectedViteUrl = null;
  for (const candidate of baseUrls) {
    if (await looksLikeVite(candidate)) {
      detectedViteUrl = candidate;
      break;
    }
  }

  if (detectedViteUrl) {
    console.log(`[openwork] UI dev server already running at ${detectedViteUrl} (reusing).`);
    holdOpenUntilSignal();
    return;
  }

  let portInUse = false;
  for (const candidate of baseUrls) {
    if (await portHasHttpServer(candidate)) {
      portInUse = true;
      break;
    }
  }

  if (portInUse) {
    console.error(
      `[openwork] Port ${port} is in use, but it does not look like a Vite dev server.\n` +
        `Set PORT to a free port (e.g. PORT=5174) or stop the process using port ${port}.`
    );
    process.exit(1);
  }

  console.log(`[openwork] Starting UI dev server on port ${port}...`);
  const uiChild = runUiDevServer();
  holdOpenUntilSignal({ uiChild });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
