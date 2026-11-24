import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "bun:test";

import {
  McpToolGateError,
  engineWorkspaceFiles,
  resolveChannelMcpToolGate,
} from "../../dist/mcp-tool-gate.js";

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

// The router cannot read the workspace (it runs as a tier account without a
// grant), so every workspace file is served by a fake engine that mirrors the
// observed opencode 1.18.25 file API: GET /file lists a directory (throws for a
// missing one), GET /file/content answers a missing file with EMPTY text, and
// an unreadable file is a server error. The workspace root itself never exists
// on disk, which proves the gate does not touch the workspace filesystem.
const MISSING_ROOT = path.join(os.tmpdir(), "channels-mcp-gate-no-such-workspace", "ws");

// `ignored` lists workspace-relative paths the engine flags `ignored: true` in
// its listing (opencode 1.18.25 lists gitignored entries, it does not omit them).
function makeEngine(files = {}, { failRead = [], failList = false, ignored = [] } = {}) {
  const calls = [];
  const dirOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
  const entries = (dir) => {
    const out = new Map();
    for (const rel of Object.keys(files)) {
      if (dir && !rel.startsWith(`${dir}/`)) continue;
      const rest = dir ? rel.slice(dir.length + 1) : rel;
      const [name, ...more] = rest.split("/");
      out.set(name, more.length ? "directory" : "file");
    }
    return out;
  };
  const file = {
    list: async ({ path: dir, directory }) => {
      calls.push(["list", dir, directory]);
      if (failList) throw new Error("engine down");
      const found = entries(dir);
      if (dir && found.size === 0) throw new Error(`Unexpected server error (no such dir ${dir})`);
      return [...found].map(([name, type]) => {
        const rel = dir ? `${dir}/${name}` : name;
        return { name, path: rel, type, ignored: ignored.includes(rel) };
      });
    },
    read: async ({ path: rel, directory }) => {
      calls.push(["read", rel, directory]);
      if (failRead.includes(rel)) throw new Error("Unexpected server error");
      return { type: "text", content: files[rel] ?? "" };
    },
  };
  return { file, calls };
}

function workspace(config, extraFiles = {}) {
  const files = { ...extraFiles };
  if (config !== undefined) files["opencode.jsonc"] = JSON.stringify({ $schema: "x", ...config });
  return files;
}

function policyText(policy) {
  return JSON.stringify({ schemaVersion: 1, servers: policy });
}

const POLICY = ".opencode/superclaw-mcp-policy.json";

function gate({ files = {}, engineOptions, client }) {
  const engine = makeEngine(files, engineOptions);
  const run = resolveChannelMcpToolGate({
    workspaceRoot: MISSING_ROOT,
    sessionID: "s1",
    client,
    files: engineWorkspaceFiles(engine, MISSING_ROOT),
  });
  return { run, engine };
}

const TWO_SERVERS = {
  mcp: {
    arxiv: { type: "remote", url: "http://localhost:4000/mcp", enabled: true },
    "google-flights": { type: "remote", url: "http://localhost:4001/mcp", enabled: true },
  },
};

function clientReturning(permission) {
  return { session: { get: async () => ({ permission }) } };
}

// The global opencode config is still read router-locally; isolate it so these
// assertions don't depend on whatever the developer/CI machine has installed.
let previousConfigDir;
function isolateGlobalConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channels-mcp-gate-global-"));
  dirs.push(dir);
  previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = dir;
  return dir;
}
afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
});

describe("resolveChannelMcpToolGate", () => {
  test("no MCP servers configured -> undefined, no session read", async () => {
    isolateGlobalConfig();
    let reads = 0;
    const client = { session: { get: async () => { reads += 1; return {}; } } };
    const { run } = gate({ files: workspace({}), client });
    assert.equal(await run, undefined);
    assert.equal(reads, 0);
  });

  test("no policy and no config-off servers -> undefined, no session read", async () => {
    isolateGlobalConfig();
    let reads = 0;
    const client = { session: { get: async () => { reads += 1; return {}; } } };
    const { run } = gate({ files: workspace(TWO_SERVERS), client });
    assert.equal(await run, undefined);
    assert.equal(reads, 0);
  });

  test("catch-all allow session + a deny => preserved catch-all plus the deny", async () => {
    isolateGlobalConfig();
    const files = workspace(TWO_SERVERS, { [POLICY]: policyText({ arxiv: { search: "deny" } }) });
    const client = clientReturning([{ permission: "*", pattern: "*", action: "allow" }]);
    assert.deepEqual(await gate({ files, client }).run, { "*": true, arxiv_search: false });
  });

  test("catch-all deny session + a deny => preserved catch-all deny plus the deny", async () => {
    isolateGlobalConfig();
    const files = workspace(TWO_SERVERS, { [POLICY]: policyText({ arxiv: { search: "deny" } }) });
    const client = clientReturning([{ permission: "*", pattern: "*", action: "deny" }]);
    assert.deepEqual(await gate({ files, client }).run, { "*": false, arxiv_search: false });
  });

  test("fresh inherit session (no rules) + a deny => just that deny", async () => {
    isolateGlobalConfig();
    const files = workspace(TWO_SERVERS, { [POLICY]: policyText({ arxiv: { search: "deny" } }) });
    assert.deepEqual(await gate({ files, client: clientReturning(undefined) }).run, { arxiv_search: false });
  });

  test("existing restrictions are preserved, then the policy deny is appended", async () => {
    isolateGlobalConfig();
    const files = workspace(TWO_SERVERS, { [POLICY]: policyText({ arxiv: { search: "deny" } }) });
    const client = clientReturning([
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "*", pattern: "*", action: "allow" },
    ]);
    assert.deepEqual(await gate({ files, client }).run, { bash: false, "*": true, arxiv_search: false });
  });

  test("a config-disabled server's wildcard allow does not survive a blanket session allow", async () => {
    isolateGlobalConfig();
    const files = workspace({
      mcp: { ...TWO_SERVERS.mcp, "google-flights": { ...TWO_SERVERS.mcp["google-flights"], enabled: false } },
    });
    const client = clientReturning([{ permission: "*", pattern: "*", action: "allow" }]);
    assert.deepEqual(await gate({ files, client }).run, { "*": true, "google-flights_*": false });
  });

  test("a tools.deny'd server's wildcard allow does not survive a blanket session allow", async () => {
    isolateGlobalConfig();
    const files = workspace({ ...TWO_SERVERS, tools: { deny: ["mcp:google-flights:*"] } });
    const client = clientReturning([{ permission: "*", pattern: "*", action: "allow" }]);
    assert.deepEqual(await gate({ files, client }).run, { "*": true, "google-flights_*": false });
  });

  test("ignores policy entries for a server that is not configured", async () => {
    isolateGlobalConfig();
    const files = workspace(TWO_SERVERS, { [POLICY]: policyText({ perplexity: { ask: "deny" } }) });
    let reads = 0;
    const client = { session: { get: async () => { reads += 1; return {}; } } };
    assert.equal(await gate({ files, client }).run, undefined);
    assert.equal(reads, 0);
  });

  test("a __proto__ tool name round-trips through the gate", async () => {
    isolateGlobalConfig();
    // Raw string: an object-literal "__proto__" sets the prototype, not an own key
    // (see shared/mcp-policy/test/policy.test.ts for the same gotcha).
    const files = workspace(
      { mcp: { __proto__dummy: { type: "remote", url: "http://x/mcp", enabled: true } } },
      { [POLICY]: '{"schemaVersion": 1, "servers": {"__proto__dummy": {"__proto__": "deny"}}}' },
    );
    const client = clientReturning([{ permission: "*", pattern: "*", action: "allow" }]);
    assert.deepEqual(await gate({ files, client }).run, { "*": true, __proto__dummy___proto__: false });
  });

  test("a malformed policy file turns every server off, preserving the channel's session mode", async () => {
    isolateGlobalConfig();
    const files = workspace(TWO_SERVERS, { [POLICY]: "{not json" });
    const client = clientReturning([{ permission: "*", pattern: "*", action: "allow" }]);
    assert.deepEqual(await gate({ files, client }).run, {
      "*": true,
      "arxiv_*": false,
      "google-flights_*": false,
    });
  });

  test("an EMPTY policy file that exists is malformed (withheld), not a missing policy", async () => {
    isolateGlobalConfig();
    const files = workspace(TWO_SERVERS, { [POLICY]: "" });
    const client = clientReturning([{ permission: "*", pattern: "*", action: "allow" }]);
    assert.deepEqual(await gate({ files, client }).run, {
      "*": true,
      "arxiv_*": false,
      "google-flights_*": false,
    });
  });

  test("an engine error reading the policy fails closed (withheld), like an unreadable file", async () => {
    isolateGlobalConfig();
    const files = workspace(TWO_SERVERS, { [POLICY]: policyText({}) });
    const client = clientReturning([{ permission: "*", pattern: "*", action: "allow" }]);
    const { run } = gate({ files, client, engineOptions: { failRead: [POLICY] } });
    assert.deepEqual(await run, { "*": true, "arxiv_*": false, "google-flights_*": false });
  });

  test("a missing .opencode directory or policy file is an empty policy (no deny), never read", async () => {
    isolateGlobalConfig();
    for (const extra of [{}, { ".opencode/other.json": "{}" }]) {
      let reads = 0;
      const client = { session: { get: async () => { reads += 1; return {}; } } };
      const { run, engine } = gate({ files: workspace(TWO_SERVERS, extra), client });
      assert.equal(await run, undefined);
      assert.equal(reads, 0);
      assert.ok(!engine.calls.some(([kind, rel]) => kind === "read" && rel === POLICY));
    }
  });

  test("a missing project config is {} (only global servers count), never read", async () => {
    const globalDir = isolateGlobalConfig();
    fs.writeFileSync(path.join(globalDir, "opencode.jsonc"), JSON.stringify(TWO_SERVERS));
    const files = { [POLICY]: policyText({ arxiv: { search: "deny" } }) };
    const { run, engine } = gate({ files, client: clientReturning(undefined) });
    assert.deepEqual(await run, { arxiv_search: false });
    assert.ok(!engine.calls.some(([kind, rel]) => kind === "read" && rel.startsWith("opencode.")));
  });

  test("opencode.json is used when opencode.jsonc is absent", async () => {
    isolateGlobalConfig();
    const files = { "opencode.json": JSON.stringify(TWO_SERVERS), [POLICY]: policyText({ arxiv: { search: "deny" } }) };
    assert.deepEqual(await gate({ files, client: clientReturning(undefined) }).run, { arxiv_search: false });
  });

  test("reads only through the engine, scoped to the workspace root, never the local filesystem", async () => {
    isolateGlobalConfig();
    assert.equal(fs.existsSync(MISSING_ROOT), false);
    const files = workspace(TWO_SERVERS, { [POLICY]: policyText({ arxiv: { search: "deny" } }) });
    const { run, engine } = gate({ files, client: clientReturning(undefined) });
    assert.deepEqual(await run, { arxiv_search: false });
    assert.ok(engine.calls.length > 0);
    assert.ok(engine.calls.every(([, , directory]) => directory === MISSING_ROOT));
    assert.deepEqual(
      engine.calls.filter(([kind]) => kind === "read").map(([, rel]) => rel),
      ["opencode.jsonc", POLICY],
    );
  });

  test("a malformed MCP config throws McpToolGateError, not an empty/all-off result", async () => {
    isolateGlobalConfig();
    const { run } = gate({ files: { "opencode.jsonc": "{ not json" }, client: clientReturning([]) });
    await assert.rejects(run, McpToolGateError);
  });

  test("an engine error reading the config throws McpToolGateError", async () => {
    isolateGlobalConfig();
    for (const engineOptions of [{ failRead: ["opencode.jsonc"] }, { failList: true }]) {
      const { run } = gate({ files: workspace(TWO_SERVERS), client: clientReturning([]), engineOptions });
      const error = await run.catch((caught) => caught);
      assert.ok(error instanceof McpToolGateError);
      assert.equal(error.message, "MCP configuration could not be resolved");
    }
  });

  test("a session-permission read failure throws McpToolGateError", async () => {
    isolateGlobalConfig();
    const files = workspace(TWO_SERVERS, { [POLICY]: policyText({ arxiv: { search: "deny" } }) });
    const client = { session: { get: async () => { throw new Error("network down"); } } };
    await assert.rejects(gate({ files, client }).run, McpToolGateError);
  });

  test("a missing-session error from the permission read is NOT wrapped", async () => {
    isolateGlobalConfig();
    const files = workspace(TWO_SERVERS, { [POLICY]: policyText({ arxiv: { search: "deny" } }) });
    const notFound = Object.assign(new Error("Session not found"), { name: "NotFoundError" });
    const client = { session: { get: async () => { throw notFound; } } };
    const error = await gate({ files, client }).run.catch((caught) => caught);
    assert.equal(error, notFound);
  });
});

describe("engineWorkspaceFiles", () => {
  test("distinguishes missing (null) from empty ('') and unwraps a { data } envelope", async () => {
    const engine = makeEngine({ "a.txt": "", ".opencode/b.json": "x" });
    const wrapped = {
      file: {
        list: async (input) => ({ data: await engine.file.list(input) }),
        read: async (input) => ({ data: await engine.file.read(input) }),
      },
    };
    for (const client of [engine, wrapped]) {
      const reader = engineWorkspaceFiles(client, MISSING_ROOT);
      assert.equal(await reader.read("a.txt"), "");
      assert.equal(await reader.read("missing.txt"), null);
      assert.equal(await reader.read(".opencode/b.json"), "x");
      assert.equal(await reader.read(".opencode/missing.json"), null);
      assert.equal(await reader.read("nodir/x.json"), null);
    }
  });

  test("gitignored entries the engine lists with ignored: true still exist and are read", async () => {
    const engine = makeEngine(
      { ".opencode/superclaw-mcp-policy.json": "policy", "opencode.jsonc": "{}" },
      { ignored: [".opencode", ".opencode/superclaw-mcp-policy.json", "opencode.jsonc"] },
    );
    const reader = engineWorkspaceFiles(engine, MISSING_ROOT);
    assert.equal(await reader.read(".opencode/superclaw-mcp-policy.json"), "policy");
    assert.equal(await reader.read("opencode.jsonc"), "{}");
    assert.equal(await reader.read(".opencode/other.json"), null);
  });

  test("a deny in a gitignored policy file is applied by the gate", async () => {
    isolateGlobalConfig();
    const files = workspace(TWO_SERVERS, { [POLICY]: policyText({ arxiv: { search: "deny" } }) });
    const { run } = gate({
      files,
      engineOptions: { ignored: [".opencode", POLICY, "opencode.jsonc"] },
      client: clientReturning(undefined),
    });
    assert.deepEqual(await run, { arxiv_search: false });
  });

  test("a non-text read result is an error, not missing", async () => {
    const engine = makeEngine({ "a.bin": "x" });
    engine.file.read = async () => ({ type: "binary", content: "eA==" });
    await assert.rejects(engineWorkspaceFiles(engine, MISSING_ROOT).read("a.bin"));
  });
});
