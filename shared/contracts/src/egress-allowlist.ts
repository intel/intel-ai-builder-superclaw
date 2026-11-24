/**
 * The egress allowlist (network egress design 2026-10-01, EG2-3): per tier and per carrier, the
 * destinations enforce mode lets through. This is a DRAFT: every entry is `status: "draft"` until a
 * human reviewer signs the list off (`docs/egress-allowlist-review.md`), and nothing reads it unless an
 * explicit setting turns enforcement on (EG2-4). The shipped proxy stays log_only.
 *
 * A carrier is the one hop a tier's traffic leaves through: the egress proxy's shell port (file_tool),
 * its channel port (channel), or the Connector (network_connector). An entry names the hosts and ports a
 * carrier tunnels without asking, and the inventory surfaces (`egress-surface-inventory.ts`) that need
 * it. A *category* is traffic whose destination the caller chooses (the agent's shell, a fetched URL):
 * it cannot be listed, so it says what happens to everything not listed instead.
 *
 * Decisions recorded with the review (2026-10-24): the entries are accepted as drafted and stay `draft`.
 * Unlisted destinations: file_tool shell -> `approval`; channel -> `refuse`; Connector fetch -> `approval`
 * as before (EG1-7). The shell approval will offer deny, allow once and
 * "allow all unlisted destinations for this chat"; a chat grant lasts for the current chat/session only
 * and is gone on a new chat or an app restart. That is approval mechanics (EG2-4), not part of this
 * document, so no grant scope is modelled here.
 *
 * The entries live in `egress-allowlist-entries.ts`. `scripts/gen.mjs` writes
 * `generated/data/egress-allowlist.json`, `generated/python/contracts/egress_allowlist_data.py`, and a
 * JSON Schema and Pydantic model for the whole document.
 */

import { z } from "zod";

import { EgressSurfaceHostSchema, EgressSurfaceIdSchema } from "./egress-surface-inventory.js";

export const EGRESS_ALLOWLIST_CONTRACT_VERSION = 1 as const;

export const EGRESS_ALLOWLIST_TIERS = ["file_tool", "channel", "network_connector"] as const;
export const EgressAllowlistTierSchema = z.enum(EGRESS_ALLOWLIST_TIERS);
export type EgressAllowlistTier = z.infer<typeof EgressAllowlistTierSchema>;

export const EGRESS_ALLOWLIST_CARRIERS = ["egress_proxy_shell", "egress_proxy_channel", "connector"] as const;
export const EgressAllowlistCarrierSchema = z.enum(EGRESS_ALLOWLIST_CARRIERS);
export type EgressAllowlistCarrier = z.infer<typeof EgressAllowlistCarrierSchema>;

/** The one carrier each tier's traffic goes through. */
export const EGRESS_ALLOWLIST_TIER_CARRIER: { readonly [T in EgressAllowlistTier]: EgressAllowlistCarrier } = {
  file_tool: "egress_proxy_shell",
  channel: "egress_proxy_channel",
  network_connector: "connector",
};

/**
 * Where an entry comes from.
 *
 * - `observed_in_audit`: the proxy's audit lines from real runs show the destination.
 * - `required_by_inventory`: an inventory surface names the host in code.
 * - `product_decision`: neither; somebody chose it. Needs a named owner before `status` leaves draft.
 */
export const EgressAllowlistSourceSchema = z.enum([
  "observed_in_audit",
  "required_by_inventory",
  "product_decision",
]);
export type EgressAllowlistSource = z.infer<typeof EgressAllowlistSourceSchema>;

/** What enforce does with a destination no entry covers. */
export const EgressAllowlistUnlistedSchema = z.enum(["refuse", "approval"]);
export type EgressAllowlistUnlisted = z.infer<typeof EgressAllowlistUnlistedSchema>;

/** A wildcard that would cover unrelated parties: shared-hosting and multi-label public suffixes. */
export const EGRESS_ALLOWLIST_FORBIDDEN_WILDCARD_SUFFIXES = [
  "amazonaws.com",
  "appspot.com",
  "azureedge.net",
  "azurewebsites.net",
  "blogspot.com",
  "cloudfront.net",
  "co.jp",
  "co.uk",
  "com.au",
  "com.cn",
  "github.io",
  "herokuapp.com",
  "netlify.app",
  "pages.dev",
  "vercel.app",
  "workers.dev",
] as const;

/** An exact host, or `*.suffix` where the suffix is a registrable domain and no shared-hosting suffix. */
export const EgressAllowlistHostSchema = EgressSurfaceHostSchema.superRefine((host, context) => {
  if (!host.startsWith("*.")) return;
  const suffix = host.slice(2);
  if (suffix.split(".").length < 2) {
    context.addIssue({ code: "custom", message: `${host} is broader than one registrable domain` });
  }
  if ((EGRESS_ALLOWLIST_FORBIDDEN_WILDCARD_SUFFIXES as readonly string[]).includes(suffix)) {
    context.addIssue({ code: "custom", message: `${host} covers a shared-hosting suffix` });
  }
});

export const EgressAllowlistPortSchema = z.number().int().min(1).max(65535);

const COMMON = {
  id: EgressSurfaceIdSchema,
  tier: EgressAllowlistTierSchema,
  carrier: EgressAllowlistCarrierSchema,
  /** The inventory surfaces this serves. Every id has to be in the inventory. */
  surfaces: z.array(EgressSurfaceIdSchema).min(1),
  status: z.literal("draft"),
  reason: z.string().min(1),
};

export const EgressAllowlistEntrySchema = z
  .object({
    ...COMMON,
    hosts: z.array(EgressAllowlistHostSchema).min(1),
    ports: z.array(EgressAllowlistPortSchema).min(1),
    source: EgressAllowlistSourceSchema,
  })
  .strict();
export type EgressAllowlistEntry = z.infer<typeof EgressAllowlistEntrySchema>;

/** Traffic whose destination the caller chooses; `unlisted` is what happens to what no entry covers. */
export const EgressAllowlistCategorySchema = z
  .object({
    ...COMMON,
    hosts: z.literal("caller_chosen"),
    unlisted: EgressAllowlistUnlistedSchema,
  })
  .strict();
export type EgressAllowlistCategory = z.infer<typeof EgressAllowlistCategorySchema>;

export const EgressAllowlistSchema = z
  .object({
    contract_version: z.literal(EGRESS_ALLOWLIST_CONTRACT_VERSION),
    entries: z.array(EgressAllowlistEntrySchema),
    categories: z.array(EgressAllowlistCategorySchema),
  })
  .strict()
  .superRefine((list, context) => {
    const seen = new Set<string>();
    for (const [group, items] of [["entries", list.entries], ["categories", list.categories]] as const) {
      items.forEach((item, index) => {
        if (seen.has(item.id)) {
          context.addIssue({ code: "custom", path: [group, index, "id"], message: `${item.id} is listed twice` });
        }
        seen.add(item.id);
        if (EGRESS_ALLOWLIST_TIER_CARRIER[item.tier] !== item.carrier) {
          context.addIssue({
            code: "custom",
            path: [group, index, "carrier"],
            message: `tier ${item.tier} leaves through ${EGRESS_ALLOWLIST_TIER_CARRIER[item.tier]}, not ${item.carrier}`,
          });
        }
      });
    }
    list.categories.forEach((category, index) => {
      if (list.categories.some((other, at) => at < index && other.carrier === category.carrier)) {
        context.addIssue({
          code: "custom",
          path: ["categories", index, "carrier"],
          message: `carrier ${category.carrier} has more than one category`,
        });
      }
    });
  });
export type EgressAllowlist = z.infer<typeof EgressAllowlistSchema>;

/** Whether `host` (lowercase, no trailing dot) is covered by one allowlist host pattern. */
export function egressAllowlistHostMatches(pattern: string, host: string): boolean {
  if (!pattern.startsWith("*.")) return pattern === host;
  return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
}

export { EGRESS_ALLOWLIST } from "./egress-allowlist-entries.js";
