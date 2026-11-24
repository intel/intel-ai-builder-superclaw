/**
 * MCP tool gate — the single writer of opencode's per-message `tools` map, and
 * therefore the single MCP authorization decision point.
 *
 * Measured behaviour (2026-08-09 review) that dictates the shape below:
 *   - The map is an OVERRIDE layer, not a filter: `true` reaches tools the agent
 *     ruleset denies, `false` removes tools it allows. So this map IS the
 *     authorization decision — opencode's permission block is only a default.
 *   - The mere PRESENCE of a map discards the session ruleset, whatever keys it
 *     carries (opencode v1.18.25 `SessionPrompt.prompt` REPLACES
 *     `session.permission` with one `pattern: "*"` rule per key, while
 *     `PATCH /session` appends). A foreign ruleset — e.g. the channels bridge's
 *     `{*, *, allow}` — therefore only gets a map when the policy denies a tool,
 *     and then as its own rules re-expressed (`reexpressRuleset`), so the
 *     bridge's allow/deny modes survive. A coupling pinned by
 *     `sandbox/channels/test/unit/permission-mode.test.js`.
 *   - Permission rules never reach the model, so map SIZE costs no context
 *     tokens. Writing `false` explicitly is free, and keeps MCP off even if some
 *     future change re-grants it at the agent layer.
 *   - An empty object `{}` was never measured against the session ruleset, so an
 *     empty result returns `undefined` and callers must omit the key entirely.
 *
 * Because the map outranks every permission layer, this gate must be a PROJECTION
 * of what the engine already resolved for the agent, never an independent policy.
 * It therefore asks the engine (`GET /agent`) rather than parsing agent files: the
 * resolved view merges product config, workspace config, global config and the
 * capability projection, and reimplementing that merge here would drift — which is
 * the exact class of bug this gate replaced.
 *
 * The conservative session-ruleset projection (`reexpressRuleset`,
 * `hasForeignPermissionRuleset`, `withholdMcp`) and the policy-deny overlay
 * (`buildPolicyDenyOverlay`) live in `@different-ai/openwork-mcp-policy`,
 * shared with the channel router so both enforce one policy identically. Only
 * agent-grant resolution (asking the engine which servers an agent's OWN
 * permission block allows) is server-specific and stays here.
 *
 * A throw here rejects the turn: omitting `tools` would let the session ruleset
 * govern — which, from the second turn on, is this gate's own persisted echo. So a
 * failed policy read or agent lookup returns a map that turns every MCP server off
 * instead (`withholdMcp`); only a failure to list the servers still throws.
 */
import {
  buildPolicyDenyOverlay,
  deniedTools,
  hasForeignPermissionRuleset,
  mcpServerKey,
  mcpToolKey,
  McpPolicyError,
  readPolicy,
  sessionRules,
  withholdMcp,
  type McpToolPolicy,
} from "@different-ai/openwork-mcp-policy";
import { browserMcpUnsupportedReason } from "./browser-sandbox-support.js";
import { listMcp } from "./mcp.js";

export { hasForeignPermissionRuleset };

const MCP_UNRESTRICTED_AGENT = "superclaw-default";

export type ToolGateContext = {
  workspaceRoot: string;
  /** Effective agent for this turn; absent means opencode's default agent. */
  agent?: string;
  /** Raw `permission` as reported by `GET /session/{id}`. */
  sessionPermission: unknown;
  /**
   * The engine's RESOLVED permission for one agent, as returned on
   * `Agent.permission`. Returning `undefined` (unknown agent, unreachable engine)
   * grants nothing.
   */
  resolveAgentPermission: (agent: string) => Promise<unknown>;
};

export function isMcpUnrestrictedAgent(agent: string | undefined | null): boolean {
  return agent == null || agent.trim() === "" || agent === MCP_UNRESTRICTED_AGENT;
}

/**
 * Which `<server>_*` keys an agent's resolved permission grants.
 *
 * Two shapes are accepted on purpose. A live engine dump (#1985) returns a flat
 * `PermissionRuleset` array, contradicting the SDK's own `.d.ts`, which declares a
 * narrow fixed-shape object; the `Session` type is likewise missing fields that
 * demonstrably exist at runtime. Since a wrong read here silently changes an
 * authorization decision, both the array and the plain `{key: action}` map are
 * handled rather than trusting either declaration.
 *
 * Only `allow` counts. `ask` is deliberately NOT a grant: the map is boolean, so
 * `true` would hand over the tool while discarding the approval prompt the user
 * asked for.
 */
function allowedPermissionKeys(permission: unknown): Set<string> {
  const keys = new Set<string>();
  if (Array.isArray(permission)) {
    for (const rule of permission) {
      if (!rule || typeof rule !== "object") continue;
      const { permission: key, action } = rule as { permission?: unknown; action?: unknown };
      if (typeof key === "string" && action === "allow") keys.add(key);
    }
    return keys;
  }
  if (permission && typeof permission === "object") {
    for (const [key, action] of Object.entries(permission as Record<string, unknown>)) {
      if (action === "allow") keys.add(key);
    }
  }
  return keys;
}

async function allowedServersForAgent(
  ctx: ToolGateContext,
  serverNames: string[],
): Promise<Set<string>> {
  if (isMcpUnrestrictedAgent(ctx.agent)) return new Set(serverNames);
  const permission = await ctx.resolveAgentPermission(ctx.agent as string);
  const allowedKeys = allowedPermissionKeys(permission);
  return new Set(serverNames.filter((name) => allowedKeys.has(`${name}_*`)));
}

/**
 * The only function permitted to produce an opencode `tools` map. `undefined`
 * means "do not set the `tools` field on this request".
 */
export async function buildToolGate(
  ctx: ToolGateContext,
): Promise<Record<string, boolean> | undefined> {
  const servers = await listMcp(ctx.workspaceRoot);
  if (servers.length === 0) return undefined;

  const serverNames = servers.map((server) => server.name);
  // A server that cannot run in this sandbox is off for every agent, whatever the engine reports.
  // Keyed by name rather than by index so a later reorder/filter of `servers` cannot misalign it.
  const sandboxUnsupported = new Set(
    servers.filter((server) => browserMcpUnsupportedReason(server.config) !== null).map((server) => server.name),
  );
  const sandboxOff = [...sandboxUnsupported].map(mcpServerKey);
  let policy: McpToolPolicy;
  try {
    policy = await readPolicy(ctx.workspaceRoot);
  } catch (error) {
    if (!(error instanceof McpPolicyError)) throw error;
    return withholdMcp(ctx.sessionPermission, serverNames);
  }
  const ownToolKeys = new Set(
    serverNames.flatMap((name) =>
      Object.keys(policy[name] ?? {}).map((tool) => mcpToolKey(name, tool)),
    ),
  );
  if (hasForeignPermissionRuleset(ctx.sessionPermission, serverNames, ownToolKeys)) {
    // Server grants stay with the foreign ruleset; only the policy's denies are added.
    const denies = serverNames.flatMap((name) =>
      deniedTools(policy, name).map((tool) => mcpToolKey(name, tool)),
    );
    // A written map outranks a config-level off (`tools.deny` or `enabled: false`),
    // so it must not re-enable that server through a foreign catch-all allow.
    const configOffKeys = servers
      .filter((server) => server.disabledByTools === true || server.config.enabled === false)
      .map((server) => mcpServerKey(server.name));
    return buildPolicyDenyOverlay({
      sessionPermission: ctx.sessionPermission,
      denies,
      configOffKeys: [...configOffKeys, ...sandboxOff],
    });
  }

  let allowed: Set<string>;
  try {
    allowed = await allowedServersForAgent(ctx, serverNames);
  } catch (error) {
    console.warn(`[McpToolGate] agent permission unresolved; withholding MCP: ${String(error)}`);
    return withholdMcp(ctx.sessionPermission, serverNames);
  }
  const serverOn = servers.map(
    (server) =>
      // `disabledByTools` (a `tools.deny` pattern) and `enabled: false` are deliberate
      // config-level "off" switches. The map outranks that config and any live engine
      // client left by a failed disconnect, so it must not re-enable either.
      allowed.has(server.name)
      && server.disabledByTools !== true
      && server.config.enabled !== false
      && !sandboxUnsupported.has(server.name),
  );
  // Two names can sanitize to one engine key; it stays off if any of them is off.
  const serverEntries = new Map<string, boolean>();
  servers.forEach((server, index) => {
    const key = mcpServerKey(server.name);
    serverEntries.set(key, serverOn[index] && serverEntries.get(key) !== false);
  });
  // The engine evaluates the map in insertion order and the LAST matching rule
  // wins, so per-tool denials must follow every `<server>_*` key.
  const toolEntries = servers
    .filter((_, index) => serverOn[index])
    .flatMap((server) =>
      deniedTools(policy, server.name).map((tool): [string, boolean] => [
        mcpToolKey(server.name, tool),
        false,
      ]),
    );
  // The map discards the session ruleset, so a deny it already carries on a
  // policy key must be re-emitted even if the tool is now allowed here.
  const sessionDenies = sessionRules(ctx.sessionPermission).flatMap(
    ({ key, denied }): Array<[string, boolean]> =>
      denied && typeof key === "string" && ownToolKeys.has(key) ? [[key, false]] : [],
  );
  // Server keys can overlap by prefix: `foo.bar`'s `foo_bar_*` also matches `foo`'s
  // tool `bar_x`, so every server-off key follows every server-on key.
  const serverOrdered = [...serverEntries].sort(([, a], [, b]) => Number(b) - Number(a));
  return Object.fromEntries([...serverOrdered, ...toolEntries, ...sessionDenies]);
}
