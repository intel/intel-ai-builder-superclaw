/**
 * Conservative projection of an opencode session permission ruleset into the
 * per-message `tools` map, plus the MCP policy-deny overlay applied on top of
 * it.
 *
 * Measured behaviour (2026-08-09 sandbox-server review) that dictates the
 * shape below:
 *   - The map is an OVERRIDE layer, not a filter: `true` reaches tools the
 *     agent ruleset denies, `false` removes tools it allows. So this map IS an
 *     authorization decision — opencode's permission block is only a default.
 *   - The mere PRESENCE of a map discards the session ruleset, whatever keys
 *     it carries (opencode v1.18.25 `SessionPrompt.prompt` REPLACES
 *     `session.permission` with one `pattern: "*"` rule per key, while
 *     `PATCH /session` appends).
 *   - Permission rules never reach the model, so map SIZE costs no context
 *     tokens. Writing `false` explicitly is free, and keeps a tool off even if
 *     some future change re-grants it at another layer.
 *   - An empty object `{}` was never measured against the session ruleset, so
 *     an empty result returns `undefined` and callers must omit the key
 *     entirely.
 *
 * This module never decides server-level grants (that is caller-specific —
 * the sandbox server resolves them from an agent's permission block; the
 * channel router does not restrict by agent at all). It only knows how to
 * re-express a session's CURRENT ruleset conservatively and append deny keys
 * on top of it.
 */
import { sanitizeMcpName } from "./policy.js";

export type SessionRule = { key: unknown; denied: boolean };

export function sessionRules(sessionPermission: unknown): SessionRule[] {
  if (Array.isArray(sessionPermission)) {
    return sessionPermission.map((rule) => {
      const { permission, action } =
        rule && typeof rule === "object" ? (rule as { permission?: unknown; action?: unknown }) : {};
      return { key: permission, denied: action === "deny" };
    });
  }
  if (sessionPermission && typeof sessionPermission === "object") {
    return Object.entries(sessionPermission as Record<string, unknown>).map(([key, value]) => ({
      key,
      denied: value === false || value === "deny",
    }));
  }
  return [];
}

/**
 * The engine-facing wildcard for a server, from its RAW (unsanitized) name:
 * imported config names skip add-route validation, so a name like `my.server`
 * must be sanitized here the same way opencode sanitizes it for the engine key.
 */
export function mcpServerKey(rawServerName: string): string {
  return `${sanitizeMcpName(rawServerName)}_*`;
}

/**
 * Whether a session's ruleset was authored by someone OTHER than the owner of
 * `ownServerKeys`/`ownToolKeys` (i.e. keys for currently-configured MCP
 * servers, plus any per-tool policy-deny keys already echoed onto the
 * session).
 *
 * Measured 2026-08-20 against a live engine: opencode PERSISTS a per-message
 * `tools` map onto the session as a permission ruleset (`false` becomes
 * `deny`, `true` becomes `allow`). So from the second turn onward every gated
 * session carries a ruleset — the gate's own echo. Treating that as "someone
 * else owns permissions here" and withholding a map pins the session to
 * whichever agent/overlay spoke first.
 *
 * The two authors are distinguishable by key shape: this gate only ever
 * writes `<server>_*` for a server-level grant, and `<server>_<tool>` only as
 * a `deny` for a policy-derived key. A ruleset made up exclusively of keys for
 * currently configured MCP servers (plus such denies) is ours to replace; any
 * other key means someone else decides permissions for this session, because
 * the mere PRESENCE of a map would discard it. Its per-tool denies are still
 * appended (`reexpressRuleset`).
 *
 * `ownToolKeys` must come from the policy FILE, not a live tool list, so a
 * disconnected server cannot flip its own echo to foreign. A per-tool key is
 * only ours when it is a deny: the gate never writes `true` for one, and
 * `<server>_<tool>` can collide with an unrelated permission name such as
 * `external_directory` (server `external`, tool `directory`). Nor does a deny
 * prove the echo is ours, so callers re-emit every such deny they find.
 */
export function hasForeignPermissionRuleset(
  sessionPermission: unknown,
  mcpServerNames: string[],
  ownToolKeys: ReadonlySet<string> = new Set(),
): boolean {
  const serverKeys = new Set(mcpServerNames.map(mcpServerKey));
  const rules = sessionRules(sessionPermission);
  if (rules.length === 0) return false;
  return rules.some(
    ({ key, denied }) =>
      typeof key !== "string" || !(serverKeys.has(key) || (denied && ownToolKeys.has(key))),
  );
}

const isIndexKey = (key: string): boolean => /^(0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1;

/**
 * A session ruleset rewritten as map keys with `denies` appended. The map
 * replaces the ruleset with one `pattern: "*"` rule per key, so allow/deny
 * rules on pattern `*` survive exactly and the rest are projected to never
 * grant more: a narrower allow is dropped, and an `ask` or narrower deny
 * becomes a deny on every pattern. Under last-match-wins neither can loosen
 * any decision. A repeated key keeps its LAST position; each deny is moved to
 * the end so it wins.
 */
export function reexpressRuleset(sessionPermission: unknown, denies: string[]): Record<string, boolean> {
  const entries = new Map<string, boolean>();
  const append = (key: string, allowed: boolean) => {
    entries.delete(key);
    entries.set(key, allowed);
  };
  if (Array.isArray(sessionPermission)) {
    for (const rule of sessionPermission) {
      const { permission, pattern, action } =
        rule && typeof rule === "object"
          ? (rule as { permission?: unknown; pattern?: unknown; action?: unknown })
          : {};
      if (typeof permission !== "string") continue;
      if (action === "allow") {
        if (pattern === "*") append(permission, true);
      } else {
        append(permission, false);
      }
    }
  } else if (sessionPermission && typeof sessionPermission === "object") {
    for (const [key, value] of Object.entries(sessionPermission as Record<string, unknown>)) {
      append(key, value === true || value === "allow");
    }
  }
  for (const key of denies) append(key, false);
  // An object enumerates integer-like keys first, ahead of any wildcard allow that
  // followed them, so such a deny would be re-opened; drop those allows instead.
  if ([...entries].some(([key, allowed]) => !allowed && isIndexKey(key))) {
    for (const [key, allowed] of entries) if (allowed && /[*?]/.test(key)) entries.delete(key);
  }
  return Object.fromEntries(entries);
}

/**
 * The map for a turn whose MCP decision cannot be made (e.g. a policy read or
 * agent-permission lookup failed). Omitting it would let the session's
 * persisted echo (e.g. `arxiv_*: allow`) govern, so every server goes off
 * instead. The map discards the session ruleset, so each deny it carries is
 * re-emitted; a foreign ruleset is re-expressed with every server denied
 * after it.
 */
export function withholdMcp(
  sessionPermission: unknown,
  serverNames: string[],
): Record<string, boolean> | undefined {
  const serverKeys = new Set(serverNames.map(mcpServerKey));
  const rules = sessionRules(sessionPermission);
  if (rules.some(({ key, denied }) => typeof key !== "string" || !(serverKeys.has(key) || denied))) {
    return reexpressRuleset(sessionPermission, [...serverKeys]);
  }
  const sessionDenies = rules.flatMap(({ key, denied }): Array<[string, boolean]> =>
    denied && typeof key === "string" ? [[key, false]] : [],
  );
  return Object.fromEntries([
    ...[...serverKeys].map((key): [string, boolean] => [key, false]),
    ...sessionDenies,
  ]);
}

/**
 * The deny-only overlay: re-expresses whatever ruleset the session currently
 * carries and appends `denies` (and `configOffKeys`) after it, or omits the
 * map entirely when there is nothing to deny. This is exactly the "foreign
 * ruleset" branch of the sandbox server's tool gate, generalised for any
 * caller that does not itself decide server-level grants — the sole shape the
 * channel router ever needs, since it never writes `<server>_*` grant keys of
 * its own.
 *
 * `configOffKeys` are config-level "off" switches (`tools.deny` patterns,
 * `enabled: false`) for currently configured servers: they must be re-applied
 * so a blanket `"*": true` in the session ruleset cannot reopen a server that
 * is off at the config layer.
 */
export function buildPolicyDenyOverlay(params: {
  sessionPermission: unknown;
  denies: string[];
  configOffKeys?: string[];
}): Record<string, boolean> | undefined {
  const { sessionPermission, denies, configOffKeys = [] } = params;
  if (denies.length === 0 && configOffKeys.length === 0) return undefined;
  return reexpressRuleset(sessionPermission, [...configOffKeys, ...denies]);
}
