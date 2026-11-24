/**
 * The channel router's per-message MCP `tools` map, built from the exact
 * shared policy-reading and conservative permission projection the sandbox
 * server's tool gate uses (`@different-ai/openwork-mcp-policy`), over the
 * router's own HTTP transport.
 *
 * Channels implement no per-agent server grants (there is no agent-grant
 * concept here — every configured, non-config-disabled server is implicitly
 * available to every agent a channel session can reach). This gate therefore
 * only ever DENIES what the workspace policy denies (plus config-level off
 * switches), layered on top of whatever the session's ACTUAL current
 * permission ruleset already restricts — never granting, never resetting an
 * existing deny, and never assuming a map from the channel's own
 * allow/deny/inherit label alone.
 *
 * `undefined` means "omit the `tools` field": the session's stored ruleset
 * (e.g. the channel's own catch-all allow/deny from `buildPermissionRules`,
 * or a bare inherit session) governs unchanged. This is the common case —
 * most turns have nothing to deny — so the session-permission read (one more
 * HTTP round trip) is skipped entirely when there is nothing to project.
 *
 * The workspace `opencode.jsonc|json` and `.opencode/superclaw-mcp-policy.json`
 * are read THROUGH THE ENGINE's file API (`client.file.list` / `client.file.read`
 * via `engineWorkspaceFiles`), never from the router's own filesystem: the
 * router runs as a tier account that by design cannot read the workspace. The
 * engine's `/file/content` answers a missing file with empty text, so a file
 * counts as missing only when its parent directory listing does not contain it;
 * a listed file is read, and an empty one parses as empty (and fails if that
 * is invalid). The global config is still read router-locally.
 *
 * A missing-session-shaped error from the session-permission read is
 * deliberately NOT wrapped: it propagates in the exact shape
 * `isMissingSessionPromptError` recognizes, so the bridge's existing
 * missing-session recovery (recreate + retry) still fires before this gate's
 * own failure mode would ever apply.
 */
import {
  buildPolicyDenyOverlay,
  deniedTools,
  mcpServerKey,
  mcpToolKey,
  McpPolicyError,
  MCP_POLICY_FILE,
  globalOpencodeConfigPath,
  mcpPolicyPath,
  parseOpencodeConfigText,
  parsePolicyText,
  readOpencodeConfigFile,
  resolveMcpServers,
  withholdMcp,
  type McpToolPolicy,
} from "@different-ai/openwork-mcp-policy";
import { join } from "node:path";

import { isMissingSessionPromptError } from "./opencode.js";

/**
 * A policy/config/permission-resolution failure for this turn, distinct from
 * a timeout or a missing-session prompt error so bridge.ts cannot mistake one
 * for the other. The corresponding prompt must not be sent; callers should log
 * `cause` and surface a short system message instead.
 */
export class McpToolGateError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "McpToolGateError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export const MCP_TOOL_GATE_ERROR_MESSAGE =
  "MCP tool permissions could not be resolved. Please check the workspace policy/configuration and try again.";

/** The slice of an OpenCode client this gate needs to read a session's actual current permission. */
export type ChannelToolGateClient = {
  session: {
    get: (input: { sessionID: string }) => Promise<unknown>;
  };
};

/** The slice of an OpenCode client used to read workspace files through the engine. */
export type EngineFileClient = {
  file: {
    list: (input: { path: string; directory?: string }) => Promise<unknown>;
    read: (input: { path: string; directory?: string }) => Promise<unknown>;
  };
};

/**
 * Reads one workspace-relative file. Resolves `null` when the file does not
 * exist, its text otherwise; rejects when it cannot be determined or read.
 */
export type WorkspaceFileReader = {
  read: (relativePath: string) => Promise<string | null>;
};

// The router's client is created with `responseStyle: "data"`; tolerate the
// `{ data }` envelope too so a differently configured client is not misread.
function unwrapData(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "data" in value) {
    return (value as { data: unknown }).data;
  }
  return value;
}

/**
 * A `WorkspaceFileReader` over the engine's file endpoints for `workspaceRoot`.
 * Existence comes from listing each parent directory (`GET /file`); content
 * from `GET /file/content`, which cannot itself tell a missing file from an
 * empty one. Listings are memoized for the reader's lifetime (one prompt).
 */
export function engineWorkspaceFiles(client: EngineFileClient, workspaceRoot: string): WorkspaceFileReader {
  const listings = new Map<string, Promise<Map<string, string>>>();
  const list = (dir: string): Promise<Map<string, string>> => {
    let pending = listings.get(dir);
    if (!pending) {
      pending = client.file.list({ path: dir, directory: workspaceRoot }).then((raw) => {
        const entries = unwrapData(raw);
        if (!Array.isArray(entries)) throw new Error(`engine file list for "${dir}" returned no entries array`);
        const byName = new Map<string, string>();
        for (const entry of entries) {
          const { name, type } = (entry ?? {}) as { name?: unknown; type?: unknown };
          if (typeof name === "string" && typeof type === "string") byName.set(name, type);
        }
        return byName;
      });
      listings.set(dir, pending);
    }
    return pending;
  };

  return {
    async read(relativePath) {
      const segments = relativePath.split("/").filter(Boolean);
      let dir = "";
      for (let index = 0; index < segments.length; index += 1) {
        const last = index === segments.length - 1;
        const type = (await list(dir)).get(segments[index]);
        if (type !== (last ? "file" : "directory")) return null;
        dir = dir ? `${dir}/${segments[index]}` : segments[index];
      }
      const result = unwrapData(await client.file.read({ path: relativePath, directory: workspaceRoot })) as
        | { type?: unknown; content?: unknown }
        | null
        | undefined;
      if (result?.type !== "text" || typeof result.content !== "string") {
        throw new Error(`engine file read for "${relativePath}" returned no text content`);
      }
      return result.content;
    },
  };
}

export type ChannelToolGateParams = {
  /** The router's workspace root — NOT a peer's bound subdirectory. There is one
   * policy file and one opencode config per router workspace; a peer scoped to a
   * subdirectory via /dir is still governed by the workspace-root policy. Only
   * used to label errors; the files themselves come from `files`. */
  workspaceRoot: string;
  sessionID: string;
  client: ChannelToolGateClient;
  /** Workspace file access through the engine (see `engineWorkspaceFiles`). */
  files: WorkspaceFileReader;
};

async function readProjectConfig(files: WorkspaceFileReader, workspaceRoot: string): Promise<Record<string, unknown>> {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const raw = await files.read(name);
    if (raw !== null) return parseOpencodeConfigText(join(workspaceRoot, name), raw);
  }
  return {};
}

async function readEnginePolicy(files: WorkspaceFileReader, workspaceRoot: string): Promise<McpToolPolicy> {
  const path = mcpPolicyPath(workspaceRoot);
  let raw: string | null;
  try {
    raw = await files.read(`.opencode/${MCP_POLICY_FILE}`);
  } catch (error) {
    console.warn(`[mcp-policy] ${path} is unreadable through the engine; MCP is withheld until it is fixed`);
    throw new McpPolicyError(path, `unreadable: ${String(error)}`);
  }
  if (raw === null) return Object.create(null);
  return parsePolicyText(path, raw);
}

/**
 * Resolves the `tools` map for one prompt. Throws `McpToolGateError` for any
 * failure to resolve MCP config, the workspace policy (for a reason other than
 * the policy file itself being malformed — that fails closed, not the turn),
 * or the session's actual current permission — except a missing-session
 * shaped error, which is re-thrown unwrapped.
 */
export async function resolveChannelMcpToolGate(
  params: ChannelToolGateParams,
): Promise<Record<string, boolean> | undefined> {
  const { workspaceRoot, sessionID, client, files } = params;

  let servers;
  try {
    const projectConfig = await readProjectConfig(files, workspaceRoot);
    const globalConfig = await readOpencodeConfigFile(globalOpencodeConfigPath());
    servers = resolveMcpServers({ projectConfig, globalConfig });
  } catch (error) {
    throw new McpToolGateError("MCP configuration could not be resolved", { cause: error });
  }
  if (servers.length === 0) return undefined;

  const serverNames = servers.map((server) => server.name);
  const configOffKeys = servers
    .filter((server) => server.disabledByTools === true || server.config.enabled === false)
    .map((server) => mcpServerKey(server.name));

  // A missing policy file is normal (empty policy). A malformed/unreadable one
  // fails closed — every server off — exactly like the sandbox server's gate;
  // it does not reject the turn.
  let policy: Record<string, Record<string, "allow" | "deny">> = {};
  let policyMalformed = false;
  try {
    policy = await readEnginePolicy(files, workspaceRoot);
  } catch (error) {
    if (!(error instanceof McpPolicyError)) {
      throw new McpToolGateError("MCP tool policy could not be resolved", { cause: error });
    }
    policyMalformed = true;
  }

  const denies = policyMalformed
    ? []
    : serverNames.flatMap((name) => deniedTools(policy, name).map((tool) => mcpToolKey(name, tool)));

  if (!policyMalformed && denies.length === 0 && configOffKeys.length === 0) return undefined;

  let sessionPermission: unknown;
  try {
    const session = await client.session.get({ sessionID });
    sessionPermission = (session as { permission?: unknown } | null | undefined)?.permission;
  } catch (error) {
    if (isMissingSessionPromptError(error)) throw error;
    throw new McpToolGateError("Session permission could not be resolved", { cause: error });
  }

  if (policyMalformed) return withholdMcp(sessionPermission, serverNames);
  return buildPolicyDenyOverlay({ sessionPermission, denies, configOffKeys });
}
