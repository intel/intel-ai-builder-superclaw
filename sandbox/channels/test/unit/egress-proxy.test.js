import assert from "node:assert/strict";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "bun:test";

/**
 * The router reaches Slack and Telegram only through the egress proxy's channel port, which the
 * Sandbox Manager hands it as HTTP(S)_PROXY with NO_PROXY starting `127.0.0.1,localhost,::1`.
 * Each case runs the real client code in a child Bun process whose environment carries only those
 * variables. The stand-in proxy records the first line of every request and refuses it, so a case
 * that goes through the proxy never reaches the network.
 */

const CHILD = fileURLToPath(new URL("./egress-proxy-child.js", import.meta.url));
const NO_PROXY = "127.0.0.1,localhost,::1";
const PASSTHROUGH_ENV = ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"];
const CASE_TIMEOUT_MS = 10_000;

let proxy;
let proxyUrl = "";
let proxyRequests = [];
let loopback;
let loopbackRequests = [];

beforeAll(async () => {
  proxy = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (chunk) => {
      proxyRequests.push(chunk.toString("latin1").split("\r\n", 1)[0]);
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  loopback = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      loopbackRequests.push(`${request.method} ${pathname}`);
      if (pathname === "/session") return Response.json([]);
      if (pathname === "/llm-router/v1/usage/events") return Response.json({ events: [], next_since_ms: null });
      return new Response(null, { status: 404 });
    },
  });
});

afterAll(() => {
  proxy?.close();
  loopback?.stop(true);
});

async function runCase(name) {
  proxyRequests = [];
  loopbackRequests = [];
  const inherited = Object.fromEntries(
    PASSTHROUGH_ENV.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  );
  const child = Bun.spawn([process.execPath, CHILD, name], {
    env: {
      ...inherited,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY,
      no_proxy: NO_PROXY,
      LOOPBACK_URL: `http://127.0.0.1:${loopback.port}`,
      LRM_API_BASE_URL: `http://127.0.0.1:${loopback.port}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { output: `${stdout}${stderr}`, proxied: [...new Set(proxyRequests)], direct: [...loopbackRequests] };
}

test.each([
  ["Telegram's Bot API", "telegram", "api.telegram.org"],
  ["Slack's credential check", "slack-web-api", "slack.com"],
  ["Slack Socket Mode's connection request", "slack-socket-mode", "slack.com"],
  ["Slack Socket Mode's WebSocket", "slack-websocket", "wss-primary.slack.com"],
  ["an inbound media download", "media-download", "files.slack.com"],
])(
  "%s goes through the egress proxy",
  async (_label, name, host) => {
    const run = await runCase(name);
    assert.deepEqual(run.proxied, [`CONNECT ${host}:443 HTTP/1.1`], run.output);
  },
  CASE_TIMEOUT_MS,
);

test.each([
  ["OpenCode through the SDK", "opencode", "GET /session"],
  ["LLMRouter's usage events", "lrm-usage", "GET /llm-router/v1/usage/events"],
])(
  "the router reaches %s directly, not through the egress proxy",
  async (_label, name, request) => {
    const run = await runCase(name);
    assert.deepEqual(run.proxied, [], run.output);
    assert.deepEqual(run.direct, [request], run.output);
  },
  CASE_TIMEOUT_MS,
);
