import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import {
  DEFAULT_MESSAGING_AGENT_INSTRUCTIONS,
  createMessagingAgentConfigLoader,
  parseMessagingAgentFile,
  toHealthAgentSnapshot,
} from "../../dist/messaging-agent-config.js";

// The workspace agent file is the only way a workspace can pin which agent
// answers channel messages. Until this moved out of `startBridge` none of it
// could be tested without standing up Slack and Telegram adapters.

const AGENT_FILE_RELATIVE = ".opencode/agents/superclaw-router.md";
const silentLogger = { warn() {}, info() {}, error() {}, debug() {} };

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), "sc-agent-cfg-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeAgentFile(root, content) {
  await mkdir(join(root, ".opencode", "agents"), { recursive: true });
  await writeFile(join(root, AGENT_FILE_RELATIVE), content, "utf8");
}

// ------------------------------------------------- the file the host provides

test("OPENCODE_ROUTER_AGENT_FILE is read instead of the workspace's own agent file", async () => {
  await withWorkspace(async (root) => {
    await writeAgentFile(root, "@agent workspace-agent\nFrom the workspace.");
    const provided = join(root, "channel-config", "superclaw-router.md");
    await mkdir(join(root, "channel-config"), { recursive: true });
    await writeFile(provided, "@agent provided-agent\nFrom the host.", "utf8");

    const loader = createMessagingAgentConfigLoader({ workspaceRoot: root, agentFile: provided, logger: silentLogger });
    const result = await loader.load();

    assert.equal(result.filePath, provided);
    assert.equal(result.selectedAgent, "provided-agent");
    assert.equal(result.instructions, "From the host.");
  });
});

test("a provided agent file that is missing does not fall back to the workspace's file", async () => {
  await withWorkspace(async (root) => {
    await writeAgentFile(root, "@agent workspace-agent\nFrom the workspace.");
    const loader = createMessagingAgentConfigLoader({
      workspaceRoot: root,
      agentFile: join(root, "absent.md"),
      logger: silentLogger,
    });
    assert.equal((await loader.load()).loaded, false);
  });
});

// ---------------------------------------------------------------- the parser

test("parses a leading @agent header and strips it from the instructions", () => {
  const parsed = parseMessagingAgentFile("@agent hybrid-coding\nBe concise.\nUse tools.");
  assert.equal(parsed.selectedAgent, "hybrid-coding");
  assert.equal(parsed.instructions, "Be concise.\nUse tools.");
});

test("skips leading blank lines before looking for the @agent header", () => {
  const parsed = parseMessagingAgentFile("\n\n  \n@agent build\nShip it.");
  assert.equal(parsed.selectedAgent, "build");
  assert.equal(parsed.instructions, "Ship it.");
});

test("omits selectedAgent entirely when there is no header", () => {
  const parsed = parseMessagingAgentFile("Just instructions, no header.");
  assert.equal("selectedAgent" in parsed, false);
  assert.equal(parsed.instructions, "Just instructions, no header.");
});

test("a header-only file yields an agent and empty instructions", () => {
  const parsed = parseMessagingAgentFile("@agent superclaw-default\n");
  assert.equal(parsed.selectedAgent, "superclaw-default");
  assert.equal(parsed.instructions, "");
});

test("a malformed header stays part of the instructions", () => {
  // Two words after @agent does not match the single-token pattern, so the line
  // must be treated as prose rather than silently dropped.
  const parsed = parseMessagingAgentFile("@agent not a token\nrest");
  assert.equal("selectedAgent" in parsed, false);
  assert.equal(parsed.instructions, "@agent not a token\nrest");
});

test("accepts the punctuation the agent-name pattern allows", () => {
  const parsed = parseMessagingAgentFile("@agent my.agent_v2:beta/x-1\nbody");
  assert.equal(parsed.selectedAgent, "my.agent_v2:beta/x-1");
});

test("handles CRLF line endings", () => {
  const parsed = parseMessagingAgentFile("@agent build\r\nline one\r\nline two");
  assert.equal(parsed.selectedAgent, "build");
  assert.equal(parsed.instructions, "line one\nline two");
});

// ---------------------------------------------------------------- the loader

test("a missing agent file loads as not-loaded rather than throwing", async () => {
  await withWorkspace(async (root) => {
    const loader = createMessagingAgentConfigLoader({ workspaceRoot: root, logger: silentLogger });
    const config = await loader.load();
    assert.equal(config.loaded, false);
    assert.equal(config.instructions, "");
    assert.equal(config.filePath, join(root, AGENT_FILE_RELATIVE));
  });
});

test("latest() reports the file path before any load has happened", async () => {
  await withWorkspace(async (root) => {
    const loader = createMessagingAgentConfigLoader({ workspaceRoot: root, logger: silentLogger });
    assert.equal(loader.latest().filePath, join(root, AGENT_FILE_RELATIVE));
    assert.equal(loader.latest().loaded, false);
  });
});

test("a populated file loads, and latest() returns it without re-reading", async () => {
  await withWorkspace(async (root) => {
    await writeAgentFile(root, "@agent build\nShip carefully.");
    const loader = createMessagingAgentConfigLoader({ workspaceRoot: root, logger: silentLogger });
    const config = await loader.load();
    assert.equal(config.loaded, true);
    assert.equal(config.selectedAgent, "build");
    assert.equal(config.instructions, "Ship carefully.");
    assert.deepEqual(loader.latest(), config);
  });
});

test("an empty file is not 'loaded'", async () => {
  await withWorkspace(async (root) => {
    await writeAgentFile(root, "   \n  \n");
    const loader = createMessagingAgentConfigLoader({ workspaceRoot: root, logger: silentLogger });
    const config = await loader.load();
    assert.equal(config.loaded, false);
    assert.equal(config.instructions, "");
  });
});

test("the mtime cache returns the same object until the file changes", async () => {
  await withWorkspace(async (root) => {
    await writeAgentFile(root, "first");
    const loader = createMessagingAgentConfigLoader({ workspaceRoot: root, logger: silentLogger });
    const first = await loader.load();
    const cached = await loader.load();
    assert.equal(cached, first, "a second load with an unchanged mtime must hit the cache");

    // Rewrite with an explicitly newer mtime; same-millisecond writes would
    // otherwise look unchanged and the assertion would be testing nothing.
    await writeAgentFile(root, "second");
    const later = new Date(Date.now() + 5000);
    await utimes(join(root, AGENT_FILE_RELATIVE), later, later);
    const reloaded = await loader.load();
    assert.equal(reloaded.instructions, "second");
    assert.notEqual(reloaded, first);
  });
});

test("content past the 16k cap is truncated", async () => {
  await withWorkspace(async (root) => {
    await writeAgentFile(root, "x".repeat(20_000));
    const loader = createMessagingAgentConfigLoader({ workspaceRoot: root, logger: silentLogger });
    const config = await loader.load();
    assert.equal(config.instructions.length, 16_000);
    assert.equal(config.loaded, true);
  });
});

test("a directory where the agent file should be loads as not-loaded", async () => {
  await withWorkspace(async (root) => {
    await mkdir(join(root, AGENT_FILE_RELATIVE), { recursive: true });
    const loader = createMessagingAgentConfigLoader({ workspaceRoot: root, logger: silentLogger });
    const config = await loader.load();
    assert.equal(config.loaded, false);
  });
});

// ------------------------------------------------------- the health snapshot

test("the health snapshot omits `selected` when no agent is pinned", () => {
  const snapshot = toHealthAgentSnapshot({ filePath: "/w/a.md", loaded: false, instructions: "" });
  assert.deepEqual(snapshot, { scope: "workspace", path: "/w/a.md", loaded: false });
});

test("the health snapshot carries the pinned agent through", () => {
  const snapshot = toHealthAgentSnapshot({
    filePath: "/w/a.md",
    loaded: true,
    selectedAgent: "build",
    instructions: "go",
  });
  assert.deepEqual(snapshot, { scope: "workspace", path: "/w/a.md", loaded: true, selected: "build" });
});

test("the default instructions are non-empty and mention the Telegram /start recovery", () => {
  assert.equal(typeof DEFAULT_MESSAGING_AGENT_INSTRUCTIONS, "string");
  assert.equal(DEFAULT_MESSAGING_AGENT_INSTRUCTIONS.includes("/start"), true);
});
