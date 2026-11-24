import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "bun:test";

import { startBridge } from "../../dist/bridge.js";
import { createClient } from "../../dist/opencode.js";
import { createMemoryStore } from "../unit/memory-store.js";
import { engineFileApi } from "./engine-file-api.js";

// Slack -> router bridge -> (real SDK client, real HTTP) -> mock OpenCode -> mock MCP tool service.
//
// Only the two outer ends are fakes: a Slack adapter that records replies, and an MCP server
// that answers JSON-RPC. The OpenCode stand-in plays the engine's part: it takes the prompt the
// router sent, calls the MCP tool over HTTP, and answers with a `tool` part plus a `text` part.

const MCP_SERVER_NAME = "mock-weather";
const RECOVERY_PREFIX = "Your previous tool call failed:";

function createLoggerStub() {
  const base = {
    child() {
      return base;
    },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return base;
}

function startMcpService({ failFirstToolCall = false } = {}) {
  const requests = [];
  let toolCalls = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const rpc = await request.json();
      requests.push(rpc);
      // Notifications carry no id and get no JSON-RPC reply.
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      const result = (value) => Response.json({ jsonrpc: "2.0", id: rpc.id, result: value });

      switch (rpc.method) {
        case "initialize":
          return result({
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
          });
        case "tools/list":
          return result({
            tools: [
              {
                name: "get_weather",
                description: "Current weather for a city",
                inputSchema: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
              },
            ],
          });
        case "tools/call": {
          toolCalls += 1;
          if (failFirstToolCall && toolCalls === 1) {
            return result({ isError: true, content: [{ type: "text", text: "upstream weather API timed out" }] });
          }
          return result({
            content: [{ type: "text", text: `Sunny, 31C in ${rpc.params.arguments.city}` }],
          });
        }
        default:
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32601, message: `Method not found: ${rpc.method}` },
          });
      }
    },
  });

  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

async function callMcp(mcpUrl, method, params) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const { result, error } = await response.json();
  if (error) throw new Error(`MCP ${method} failed: ${error.message}`);
  return result;
}

function startOpencode(mcpUrl) {
  const requests = [];
  let sessionCounter = 0;
  let lastCity = "";

  async function answerPrompt(sessionID, body) {
    const text = body.parts?.find((part) => part.type === "text")?.text ?? "";
    // The router's recovery prompt carries no city, so reuse the one from the original ask.
    lastCity = /weather in ([A-Za-z ]+?)[?.!]*$/i.exec(text)?.[1] ?? lastCity;
    const input = { city: lastCity };

    await callMcp(mcpUrl, "initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    const { tools } = await callMcp(mcpUrl, "tools/list", {});
    assert.ok(tools.some((tool) => tool.name === "get_weather"));
    const outcome = await callMcp(mcpUrl, "tools/call", { name: "get_weather", arguments: input });
    const output = outcome.content.map((item) => item.text).join("\n");

    const toolPart = {
      id: `part-tool-${requests.length}`,
      type: "tool",
      tool: `${MCP_SERVER_NAME}_get_weather`,
      callID: `call-${requests.length}`,
      state: outcome.isError
        ? { status: "error", input, error: output }
        : { status: "completed", input, output },
    };
    const parts = outcome.isError
      ? [toolPart]
      : [toolPart, { id: `part-text-${requests.length}`, type: "text", text: `Weather in ${lastCity}: ${output}` }];

    return Response.json({ info: { id: `message-${requests.length}`, sessionID, role: "assistant" }, parts });
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const rawBody = request.method === "POST" ? await request.text() : "";
      const body = rawBody ? JSON.parse(rawBody) : undefined;
      requests.push({ method: request.method, pathname: url.pathname, search: url.search, headers: request.headers, body });

      if (request.method === "GET" && url.pathname === "/global/health") {
        return Response.json({ healthy: true, version: "mock-opencode" });
      }
      const fileResponse = engineFileApi(request, url);
      if (fileResponse) return fileResponse;
      if (request.method === "GET" && url.pathname === "/agent") {
        return Response.json([]);
      }
      if (request.method === "POST" && url.pathname === "/session") {
        sessionCounter += 1;
        return Response.json({ id: `session-${sessionCounter}`, title: "Slack", version: "1", time: { created: 1, updated: 1 } });
      }
      const message = request.method === "POST" ? /^\/session\/([^/]+)\/message$/.exec(url.pathname) : null;
      if (message) return answerPrompt(message[1], body);

      return Response.json(
        { name: "NotFoundError", data: { message: `no mock for ${request.method} ${url.pathname}` } },
        { status: 404 },
      );
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    prompts: () => requests.filter((entry) => entry.method === "POST" && /\/message$/.test(entry.pathname)),
    stop: () => server.stop(true),
  };
}

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function startHarness({ failFirstToolCall = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-slack-mcp-"));
  const mcp = startMcpService({ failFirstToolCall });
  const opencode = startOpencode(mcp.url);

  const sent = [];
  const slackAdapter = {
    key: "slack:default",
    name: "slack",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText(peerId, text) {
      sent.push({ peerId, text });
    },
  };

  const config = {
    configPath: path.join(dir, "opencode-router.json"),
    configFile: { version: 1 },
    opencodeUrl: opencode.url,
    opencodeDirectory: dir,
    telegramBots: [],
    slackApps: [],
    dataDir: dir,
    dbPath: path.join(dir, "opencode-router.db"),
    logFile: path.join(dir, "opencode-router.log"),
    toolUpdatesEnabled: false,
    groupsEnabled: false,
    permissionMode: "allow",
    toolOutputLimit: 1200,
    healthPort: undefined,
    logLevel: "silent",
  };

  const bridge = await startBridge(config, createLoggerStub(), undefined, {
    client: createClient(config),
    clientFactory: (directory) => createClient(config, directory),
    store: createMemoryStore(),
    adapters: new Map([["slack:default", slackAdapter]]),
    disableEventStream: true,
    disableHealthServer: true,
  });

  cleanups.push(async () => {
    await bridge.stop();
    opencode.stop();
    mcp.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    sent,
    opencode,
    mcp,
    slackSays: (text) => bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text, raw: {} }),
    toolCalls: () => mcp.requests.filter((rpc) => rpc.method === "tools/call"),
  };
}

test("a Slack message reaches OpenCode over HTTP and the reply comes from an MCP tool", async () => {
  const harness = await startHarness();

  await harness.slackSays("What's the weather in Singapore?");

  const [prompt, ...extraPrompts] = harness.opencode.prompts();
  assert.equal(extraPrompts.length, 0, "exactly one prompt should reach OpenCode");
  assert.match(prompt.pathname, /^\/session\/session-1\/message$/);
  assert.deepEqual(prompt.body.parts, [{ type: "text", text: "What's the weather in Singapore?" }]);
  assert.ok(
    prompt.search.includes("directory=") || prompt.headers.get("x-opencode-directory"),
    "the prompt must be scoped to the router's workspace directory",
  );

  const [toolCall, ...extraToolCalls] = harness.toolCalls();
  assert.equal(extraToolCalls.length, 0, "the MCP tool should be called once");
  assert.deepEqual(toolCall.params, { name: "get_weather", arguments: { city: "Singapore" } });

  assert.deepEqual(
    harness.sent.map((message) => message.peerId),
    ["D123", "D123"],
  );
  assert.ok(harness.sent[0].text.includes("Session started."));
  assert.equal(harness.sent[1].text, "Weather in Singapore: Sunny, 31C in Singapore");
});

test("a failed MCP tool call makes the router retry with a recovery prompt, then relay the tool's answer", async () => {
  const harness = await startHarness({ failFirstToolCall: true });

  await harness.slackSays("What's the weather in Singapore?");

  const prompts = harness.opencode.prompts();
  assert.equal(prompts.length, 2, "the failed tool call should trigger exactly one retry");
  assert.ok(
    prompts[1].body.parts[0].text.startsWith(`${RECOVERY_PREFIX} upstream weather API timed out`),
    `unexpected retry prompt: ${prompts[1].body.parts[0].text}`,
  );
  assert.equal(harness.toolCalls().length, 2);

  const replies = harness.sent.map((message) => message.text);
  assert.ok(replies.includes("Weather in Singapore: Sunny, 31C in Singapore"), `replies: ${JSON.stringify(replies)}`);
  assert.ok(
    !replies.some((text) => text.includes("No visible response was generated.")),
    `unexpected reset message in: ${JSON.stringify(replies)}`,
  );
});
