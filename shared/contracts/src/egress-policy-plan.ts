/**
 * The egress policy plan: the descriptor resolved against one owner's tier accounts.
 *
 * A descriptor is keyed by rule class, so it says nothing about who. A plan is where
 * an owner and that owner's per-tier accounts appear, one planned object per class and
 * tier. Adding a tier adds members here; it does not change the descriptor, which is
 * the property this split exists for.
 *
 * Nothing in this file applies anything. A plan says which objects should exist and
 * exactly what each should contain. Adding a WFP filter or reading one back is the
 * broker's job.
 *
 * Three shapes here are load-bearing for the fail-closed requirements:
 *
 * - `preconditions` are steps, ordered before every rule step. A BLOCK-only rule set
 *   means nothing on a host whose filtering engine is not running, whose dynamic port
 *   range nobody read, or where another sublayer of our weight may be evaluated first.
 *   The planner refuses when its pre-write evidence contradicts any of those, and the
 *   applier re-checks them.
 * - `covered_tiers` and `uncovered_tiers` partition the tiers. A reader is never asked
 *   to subtract one list from another to find out what a plan leaves open.
 * - Every planned object lists the WFP filters it becomes, by layer and match, and each
 *   filter's key is derived from those, so the applier has nothing to work out and a
 *   readback can find each filter by key without enumerating anybody else's.
 *
 * These shapes carry no cross-field refinement on purpose. A plan is produced by the L1
 * planner and consumed across the language boundary, so its invariants live with the
 * producer, where they are tested once, rather than in a Zod refinement the generated
 * Pydantic model would not carry.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import { AclOwnerSidSchema } from "./acl-policy-descriptor.js";
import {
  EgressAddressFamilySchema,
  EgressBoundaryStateSchema,
  EgressHostPreconditionSchema,
  EgressIsolationTierSchema,
  EgressMechanismSchema,
  EgressPlanIntentSchema,
  EgressPortMatchModeSchema,
  EgressPrimaryRuleClassSchema,
  EgressProtocolSchema,
  EgressRuleClassSchema,
  EgressSupplementaryFilterClassSchema,
} from "./egress-policy-vocabulary.js";
import type {
  EgressAddressFamily,
  EgressIsolationTier,
  EgressMechanism,
  EgressRuleClass,
} from "./egress-policy-vocabulary.js";
import {
  EgressAddressRangeSchema,
  EgressPolicyContractVersionSchema,
  EgressPolicyVersionSchema,
  EgressPortRangeSchema,
  EgressPortSchema,
  canonicalEgressPolicyJson,
  egressAddressSet,
  egressCanonicalAddress,
} from "./egress-policy-descriptor.js";

/**
 * A Windows account SID in string form.
 *
 * The same grammar the ACL policy contract publishes, aliased rather than respelled. A
 * second regex for the same thing agrees with the first one until somebody edits one of
 * them, and the two contracts resolve accounts provisioned by the same broker.
 */
export const EgressAccountSidSchema = AclOwnerSidSchema;

/**
 * One tier and the account whose outbound traffic a rule scopes to.
 *
 * The account SID is the only literal identity in this contract, and it belongs here
 * rather than in the descriptor: a SID exists per install, and a descriptor that
 * carried one would be a policy that had to be reviewed again per machine.
 */
export const EgressTierAccountSchema = z
  .object({
    tier: EgressIsolationTierSchema,
    account_sid: EgressAccountSidSchema,
  })
  .strict();
export type EgressTierAccount = z.infer<typeof EgressTierAccountSchema>;

/**
 * The grammar of a planned object's key.
 *
 * Five dot-separated segments: the fixed prefix, the mechanism, the rule class, the
 * tier, and the owner's SID. The three middle segments are enum values, and the grammar
 * admits no digit in them, so a port number or an address cannot be baked into a key
 * even by a caller building one by hand. The only digits a key may carry are the
 * owner's SID, which is what makes a key unique per install and per owner, so an
 * uninstall for one owner cannot match another owner's objects.
 */
export const EGRESS_OBJECT_KEY_PATTERN =
  /^openwork-egress\.[a-z_]+\.[a-z_]+\.[a-z_]+\.S-1-(?:\d+-)+\d+$/;

/** The prefix every object this contract owns carries, and nothing else may. */
export const EGRESS_OBJECT_KEY_PREFIX = "openwork-egress" as const;

/** A planned object's key. Stable across runs, which is what makes a re-run a repair. */
export const EgressObjectKeySchema = z.string().regex(EGRESS_OBJECT_KEY_PATTERN);
export type EgressObjectKey = z.infer<typeof EgressObjectKeySchema>;

/**
 * The key for one planned object.
 *
 * The only place a key is built. An applier matches on the whole string and never
 * parses it, so nothing depends on the segment order beyond this function and the
 * pattern above.
 */
export function egressObjectKey(
  mechanism: EgressMechanism,
  ruleClass: EgressRuleClass,
  tier: EgressIsolationTier,
  ownerSid: string
): string {
  return [EGRESS_OBJECT_KEY_PREFIX, mechanism, ruleClass, tier, ownerSid].join(".");
}

/**
 * The WFP layers a planned filter may be written at, by name.
 *
 * A plan names a layer and never a GUID; `EGRESS_WFP_LAYER_KEYS` is the one table both
 * sides map the name through.
 */
export const EgressWfpLayerSchema = z.enum([
  "ale_auth_connect_v4",
  "ale_auth_connect_v6",
  "ale_resource_assignment_v4",
  "ale_resource_assignment_v6",
]);
export type EgressWfpLayer = z.infer<typeof EgressWfpLayerSchema>;

/** Each layer's GUID, as `windows-sys` and `fwpmu.h` define it. */
export const EGRESS_WFP_LAYER_KEYS: { readonly [L in EgressWfpLayer]: string } = {
  ale_auth_connect_v4: "c38d57d1-05a7-4c33-904f-7fbceee60e82",
  ale_auth_connect_v6: "4a72393b-319f-44bc-84c3-ba54dcb3b6b4",
  ale_resource_assignment_v4: "1247d66d-0b60-4a15-8d44-7155d0f53a0c",
  ale_resource_assignment_v6: "55a650e1-5f0a-4eca-a653-88f53b26aa8c",
};

/**
 * What one filter of a planned object matches the destination on.
 *
 * - `loopback_flag`: `FWPM_CONDITION_FLAGS` with `FWP_CONDITION_FLAG_IS_LOOPBACK` set,
 *   which also catches the machine's own non-loopback addresses.
 * - `loopback_address`: the loopback address ranges, for traffic the flag misses.
 * - `non_loopback`: the flag not set, and the non-loopback address ranges.
 * - `any_address`: no address condition.
 * - `internal_address`: the internal address ranges.
 * - `upstream_address`: the upstream proxy's addresses, one family per layer.
 */
export const EgressWfpFilterMatchSchema = z.enum([
  "loopback_flag",
  "loopback_address",
  "non_loopback",
  "any_address",
  "internal_address",
  "upstream_address",
]);
export type EgressWfpFilterMatch = z.infer<typeof EgressWfpFilterMatchSchema>;

/**
 * The layers each rule class may be written at.
 *
 * The broker reads a plan as caller input and checks every filter against this table, so
 * the table, not the planner, decides where a class may be written.
 */
export const EGRESS_WFP_LAYERS_BY_CLASS: {
  readonly [C in EgressRuleClass]: readonly EgressWfpLayer[];
} = {
  external_outbound_block: ["ale_auth_connect_v4", "ale_auth_connect_v6"],
  loopback_non_allowlisted_block: ["ale_auth_connect_v4", "ale_auth_connect_v6"],
  internal_outbound_block: ["ale_auth_connect_v4", "ale_auth_connect_v6"],
  upstream_proxy_permit: ["ale_auth_connect_v4", "ale_auth_connect_v6"],
  icmp_connect_block: ["ale_auth_connect_v4", "ale_auth_connect_v6"],
  icmp_resource_assignment_block: ["ale_resource_assignment_v4", "ale_resource_assignment_v6"],
  name_resolution_port_block: ["ale_auth_connect_v4", "ale_auth_connect_v6"],
  file_sharing_port_block: ["ale_auth_connect_v4", "ale_auth_connect_v6"],
};

/**
 * Which protocols one filter of a planned object matches, and where its port condition
 * comes from.
 *
 * One WFP filter can say "protocol in P and remote port in R" but not "(TCP and A) or
 * (UDP and B)", so a boundary rule whose TCP and UDP complements differ is written one
 * transport per filter.
 *
 * - `tcp`: `IPPROTO_TCP`, remote port in the rule's `blocked_tcp_port_ranges`.
 * - `udp`: `IPPROTO_UDP`, remote port in the rule's `blocked_udp_port_ranges`.
 * - `other_protocols`: a protocol in `EGRESS_WFP_OTHER_PROTOCOL_RANGES`, no port condition.
 * - `unsplit`: the object's own protocol and port scope in one filter - none for a
 *   boundary rule, `protocols` and `blocked_ports` for a supplementary filter.
 *
 * A rule's port lists are empty exactly when its `match_mode` is `every_port`, and then a
 * `tcp` or `udp` filter has no port condition either.
 */
export const EgressWfpTransportSchema = z.enum(["tcp", "udp", "other_protocols", "unsplit"]);
export type EgressWfpTransport = z.infer<typeof EgressWfpTransportSchema>;

/** Every IP protocol number but TCP (6) and UDP (17), as inclusive ranges. */
export const EGRESS_WFP_OTHER_PROTOCOL_RANGES: readonly {
  readonly first: number;
  readonly last: number;
}[] = [
  { first: 0, last: 5 },
  { first: 7, last: 16 },
  { first: 18, last: 255 },
];

/** One filter a rule class is written as, at each of its layers. */
export interface EgressWfpFilterShape {
  readonly match: EgressWfpFilterMatch;
  readonly transport: EgressWfpTransport;
}

/**
 * The filters each rule class needs at every one of its layers.
 *
 * The broker derives a removal's filter keys from this table and the layer table, so it
 * lists every filter a class is ever written as, whatever the rule's `match_mode`.
 */
export const EGRESS_WFP_FILTERS_BY_CLASS: {
  readonly [C in EgressRuleClass]: readonly EgressWfpFilterShape[];
} = {
  external_outbound_block: [{ match: "non_loopback", transport: "unsplit" }],
  loopback_non_allowlisted_block: [
    { match: "loopback_flag", transport: "tcp" },
    { match: "loopback_flag", transport: "udp" },
    { match: "loopback_flag", transport: "other_protocols" },
    { match: "loopback_address", transport: "tcp" },
    { match: "loopback_address", transport: "udp" },
    { match: "loopback_address", transport: "other_protocols" },
  ],
  internal_outbound_block: [{ match: "internal_address", transport: "unsplit" }],
  upstream_proxy_permit: [{ match: "upstream_address", transport: "tcp" }],
  icmp_connect_block: [{ match: "any_address", transport: "unsplit" }],
  icmp_resource_assignment_block: [{ match: "any_address", transport: "unsplit" }],
  name_resolution_port_block: [{ match: "any_address", transport: "unsplit" }],
  file_sharing_port_block: [{ match: "any_address", transport: "unsplit" }],
};

/**
 * The WFP weight each class's filters are written with, within our sublayer.
 *
 * WFP evaluates a sublayer's filters from the highest weight down and the first that
 * matches decides, so the upstream proxy's permit has to outrank the internal block it
 * opens. Written by the broker as `FWP_UINT8` and compared on readback, rather than left
 * to the engine's own ordering, which would decide the order of a permit and a block.
 * The permit never meets the loopback block: its addresses are never loopback.
 */
export const EGRESS_WFP_WEIGHTS: { readonly [C in EgressRuleClass]: number } = {
  external_outbound_block: 1,
  loopback_non_allowlisted_block: 1,
  internal_outbound_block: 1,
  upstream_proxy_permit: 2,
  icmp_connect_block: 1,
  icmp_resource_assignment_block: 1,
  name_resolution_port_block: 1,
  file_sharing_port_block: 1,
};

/**
 * The one sublayer every filter of ours goes into, and its weight.
 *
 * There is no provider: the sublayer and the filters carry `providerKey = NULL`, and an
 * object is ours by its fixed key and its `providerData` tag. Enforcing filters are
 * BLOCK-only, which any sublayer's soft permit yields to anyway, so the highest weight only
 * matters against another sublayer's hard permit and never overrides anybody's block.
 */
export const EGRESS_WFP_SUBLAYER_KEY = "25ac0218-5824-499f-8076-a19c1d5f5b44" as const;
/**
 * One below the u16 maximum on purpose. The engine stores a sublayer weight of 0xffff as 0xfffe, so a
 * contract weight of 0xffff would never read back as the weight that was written: the object would
 * read as not ours, and a re-apply, a revoke and the readback would all refuse it.
 */
export const EGRESS_WFP_SUBLAYER_WEIGHT = 0xfffe as const;

/** The domain string a filter key is derived under. Part of every key, so never edited. */
export const EGRESS_WFP_FILTER_KEY_DOMAIN = "superclaw-egress-wfp-filter-v1" as const;

/**
 * The key of one WFP filter, derived from the object it belongs to and the filter's layer,
 * match and transport.
 *
 * SHA-256 over the domain, the object key, the layer, the match and the transport, one per
 * line; the first sixteen bytes, with the version nibble set to 8 and the RFC 4122 variant,
 * written with big-endian fields. A Windows `GUID` keeps Data1-Data3 little-endian in
 * memory, so an implementation that copies the bytes into one without swapping them gets a
 * different key, and `test-fixtures/egress-wfp-filter-key-cases.json` catches it.
 */
export function egressWfpFilterKey(
  objectKey: string,
  layer: EgressWfpLayer,
  match: EgressWfpFilterMatch,
  transport: EgressWfpTransport
): string {
  const bytes = createHash("sha256")
    .update(
      `${EGRESS_WFP_FILTER_KEY_DOMAIN}\n${objectKey}\n${layer}\n${match}\n${transport}`,
      "utf8"
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The prefix of the `providerData` tag every object of ours carries. */
export const EGRESS_WFP_PROVIDER_DATA_PREFIX = "superclaw-egress-plan-v1\n" as const;

/**
 * The `providerData` tag for every object a plan installs: the prefix and the plan's digest.
 *
 * A readback compares it with the plan it holds, so an object installed under an older plan,
 * or for an account that has since been re-provisioned, is told apart from a current one.
 */
export function egressWfpProviderData(plan: EgressPolicyPlan): string {
  const digest = createHash("sha256").update(canonicalEgressPolicyJson(plan)).digest("hex");
  return `${EGRESS_WFP_PROVIDER_DATA_PREFIX}${digest}`;
}

/** One WFP filter a planned object becomes. */
export const EgressPlannedWfpFilterSchema = z
  .object({
    layer: EgressWfpLayerSchema,
    match: EgressWfpFilterMatchSchema,
    transport: EgressWfpTransportSchema,
  })
  .strict();
export type EgressPlannedWfpFilter = z.infer<typeof EgressPlannedWfpFilterSchema>;

/**
 * What the installed filters do.
 *
 * `enforce` writes them as BLOCK. `log_only` writes the same filters under the same keys as a
 * soft PERMIT, which no block anywhere yields to, so traffic is unchanged and every hit shows
 * in the WFP audit. Switching is deleting and adding in one transaction. The mode follows the
 * shipped descriptor's primary layer, so it is not a runtime switch.
 */
export const EgressEnforcementModeSchema = z.enum(["log_only", "enforce"]);
export type EgressEnforcementMode = z.infer<typeof EgressEnforcementModeSchema>;

/** A WFP object key: a GUID in its canonical lower-case spelling. */
export const EgressWfpKeySchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** One TCP port range the host hands to outbound sockets, as read for one family. */
export const EgressHostPortRangeSchema = z
  .object({
    address_family: EgressAddressFamilySchema,
    first: EgressPortSchema,
    last: EgressPortSchema,
  })
  .strict();
export type EgressHostPortRange = z.infer<typeof EgressHostPortRangeSchema>;

/**
 * What a reader found out about the host, before anything is written.
 *
 * Facts, not verdicts: a caller reports what the host says and the planner decides what
 * that means against the preconditions, so a caller cannot satisfy a precondition by
 * naming it. Every field is required, so a fact nobody read is a missing field and a
 * refusal, never an empty list that reads as "nothing there".
 *
 * Excluded port ranges are not here: no public API lists them, and the allocator meets
 * one as `bind_access_denied` when it tries a candidate inside it.
 */
export const EgressHostPolicyStateSchema = z
  .object({
    base_filtering_engine_running: z.boolean(),
    tcp_dynamic_port_ranges: z.array(EgressHostPortRangeSchema),
    other_sublayers_at_our_weight: z.array(EgressWfpKeySchema),
  })
  .strict();
export type EgressHostPolicyState = z.infer<typeof EgressHostPolicyStateSchema>;

/**
 * One precondition, as a step the applier performs.
 *
 * There is no `satisfied` field. The planner refuses rather than returning a plan whose
 * preconditions it knows are unmet, so the flag would be true in every plan that
 * exists, and a field that is always true is a field a reader learns to skip.
 */
export const EgressPlannedPreconditionSchema = z
  .object({
    action_kind: z.literal("verify_precondition"),
    precondition: EgressHostPreconditionSchema,
  })
  .strict();
export type EgressPlannedPrecondition = z.infer<typeof EgressPlannedPreconditionSchema>;

/**
 * One boundary rule, resolved for one tier of one owner.
 *
 * `blocked_tcp_port_ranges` and `blocked_udp_port_ranges` are the materialized
 * complement of the descriptor's allowlist, computed by `egressPortComplement` and
 * empty exactly when `match_mode` is `every_port`. An applier writes what it is given.
 * It has no allowlist to consult and no complement to work out, so there is no second
 * implementation of the loopback boundary to get wrong.
 *
 * `action` and `protocol` are literals for the same reason they are literals on the
 * descriptor's rule: a boundary rule that allowed something, or that narrowed to one
 * transport, is not a variant this contract has.
 *
 * `action_kind` is a literal too. A planned rule always carries the whole desired
 * object, so there is no partial update and a re-run cannot leave a rule narrower than
 * the policy says because one field went unset. That is a mistake the reviewed
 * implementation makes: it sets a rule's port list only when it has one, so a re-run
 * cannot widen a previously narrowed rule back.
 *
 * `rule_class` is the primary layer's own enum, not every class either layer can carry,
 * so a planner bug cannot put a supplementary class here and have the plan still
 * validate. It matters because `covered_tiers` is counted from these rules: a rule that
 * validated but named no boundary class would be a rule an applier installs and coverage
 * does not count.
 */
export const EgressPlannedBoundaryRuleSchema = z
  .object({
    action_kind: z.literal("create_or_replace"),
    object_key: EgressObjectKeySchema,
    authority: z.literal("primary"),
    mechanism: z.literal("wfp"),
    rule_class: EgressPrimaryRuleClassSchema,
    tier: EgressIsolationTierSchema,
    account_sid: EgressAccountSidSchema,
    action: z.literal("block"),
    protocol: z.literal("any"),
    address_ranges: z.array(EgressAddressRangeSchema).min(1),
    match_mode: EgressPortMatchModeSchema,
    blocked_tcp_port_ranges: z.array(EgressPortRangeSchema),
    blocked_udp_port_ranges: z.array(EgressPortRangeSchema),
    filters: z.array(EgressPlannedWfpFilterSchema).min(1),
  })
  .strict();
export type EgressPlannedBoundaryRule = z.infer<typeof EgressPlannedBoundaryRuleSchema>;

/**
 * One supplementary filter, resolved for one tier of one owner.
 *
 * Deliberately not shaped like a boundary rule: no address ranges, and a
 * list of ports it blocks rather than a complement. That is what the mechanism can
 * express, and a shape that pretended otherwise would make the two layers look like
 * alternatives. Which of the two closes egress is `boundary_state` on the plan, and
 * this layer never sets it.
 *
 * `filter_class` is this layer's own enum for the same reason `rule_class` is the other
 * layer's: a supplementary filter naming `external_outbound_block` would read, to anyone
 * scanning a plan, like the boundary is in here. It is not, and now it cannot say so.
 */
export const EgressPlannedSupplementaryFilterSchema = z
  .object({
    action_kind: z.literal("create_or_replace"),
    object_key: EgressObjectKeySchema,
    authority: z.literal("supplementary"),
    mechanism: z.literal("wfp"),
    filter_class: EgressSupplementaryFilterClassSchema,
    tier: EgressIsolationTierSchema,
    account_sid: EgressAccountSidSchema,
    action: z.literal("block"),
    protocols: z.array(EgressProtocolSchema).min(1),
    blocked_ports: z.array(EgressPortSchema),
    filters: z.array(EgressPlannedWfpFilterSchema).min(1),
  })
  .strict();
export type EgressPlannedSupplementaryFilter = z.infer<
  typeof EgressPlannedSupplementaryFilterSchema
>;

/** The most addresses an upstream proxy's host name may resolve to in one plan. */
export const EGRESS_UPSTREAM_PROXY_MAX_ADDRESSES = 8;

/**
 * The most ports beyond `port` the connector's permit may carry (EG2-11): the PAC script's own
 * host and every proxy it names listen on a handful of ports, and the permit is the union of the
 * resolved addresses and these ports. A permit for one port carries an empty list.
 */
export const EGRESS_UPSTREAM_PROXY_MAX_ADDITIONAL_PORTS = 7;

const V4_MAPPED_PREFIX = "0000:0000:0000:0000:0000:ffff:";

type UpstreamPermitAddress = { readonly family: EgressAddressFamily; readonly address: string };

/** One upstream address as a permit carries it, or null if the contract refuses it. */
function upstreamPermitAddress(text: string): UpstreamPermitAddress | null {
  const family: EgressAddressFamily = text.includes(":") ? "ipv6" : "ipv4";
  const canonical = egressCanonicalAddress(family, text);
  if (canonical === null || egressAddressSet(family, text) === "loopback") return null;
  return canonical.startsWith(V4_MAPPED_PREFIX) ? null : { family, address: canonical };
}

/** IPv4 before IPv6, then by value: zero-padded octets and fixed-width hex sort as numbers. */
function upstreamOrderKey(item: UpstreamPermitAddress): string {
  return item.family === "ipv4"
    ? `4:${item.address
        .split(".")
        .map((octet) => octet.padStart(3, "0"))
        .join(".")}`
    : `6:${item.address}`;
}

/**
 * The host's upstream proxy, as the planner is given it (design D4): the addresses the
 * Sandbox Manager resolved its host name to at provision, and its port.
 *
 * Addresses rather than a name, because a WFP filter matches addresses, and the egress
 * proxy and the Connector connect to these same addresses instead of resolving the name
 * again, so the permit and the connection cannot disagree. A loopback address is refused:
 * its permit would outrank the loopback block for that port. An IPv4 address spelled
 * v4-mapped is refused too and has to be given as IPv4, and so is an address given twice:
 * the Sandbox Manager converts and deduplicates before it plans, so either reaching the
 * planner is a producer bug, and it fails loudly. No upstream proxy is null, and then a
 * plan has no permit.
 *
 * Order is not part of the input: `egressUpstreamPermitAddresses` puts the addresses in
 * the one order a plan uses.
 *
 * A planner input, not a plan shape, so it does carry refinements; the Python planner
 * refuses the same inputs as `upstream_proxy_shape_invalid`.
 */
export const EgressUpstreamProxySchema = z
  .object({
    addresses: z
      .array(
        z
          .string()
          .min(2)
          .max(45)
          .refine(
            (text) => upstreamPermitAddress(text) !== null,
            "an IP literal that is neither loopback nor v4-mapped"
          )
      )
      .min(1)
      .max(EGRESS_UPSTREAM_PROXY_MAX_ADDRESSES)
      .refine(
        (addresses) =>
          new Set(addresses.map((text) => upstreamPermitAddress(text)?.address)).size ===
          addresses.length,
        "each address once"
      ),
    port: EgressPortSchema,
    /**
     * Further ports on the same addresses (EG2-11): the PAC script's host and each proxy it
     * names. Not part of the input when there are none. Each port once and none equal to `port`.
     */
    additional_ports: z
      .array(EgressPortSchema)
      .max(EGRESS_UPSTREAM_PROXY_MAX_ADDITIONAL_PORTS)
      .optional(),
  })
  .strict()
  .refine(
    (proxy) =>
      new Set([proxy.port, ...(proxy.additional_ports ?? [])]).size ===
      1 + (proxy.additional_ports?.length ?? 0),
    "each port once"
  );
export type EgressUpstreamProxy = z.infer<typeof EgressUpstreamProxySchema>;

/**
 * Every port an upstream proxy's permit opens, ascending: `port` and `additional_ports`.
 * The same ports in any order are the same permit.
 */
export function egressUpstreamPermitPorts(proxy: EgressUpstreamProxy): number[] {
  return [proxy.port, ...(proxy.additional_ports ?? [])].sort((left, right) => left - right);
}

/**
 * The addresses an upstream proxy's permit carries, for a proxy the schema accepted.
 *
 * Fully expanded, IPv4 before IPv6 and each family by value. So a plan changes only when
 * the set of addresses does, and a resolver rotating its answers does not make the
 * Sandbox Manager provision again.
 */
export function egressUpstreamPermitAddresses(proxy: EgressUpstreamProxy): string[] {
  const keyed: [string, string][] = [];
  for (const text of proxy.addresses) {
    const item = upstreamPermitAddress(text);
    if (item !== null) keyed.push([upstreamOrderKey(item), item.address]);
  }
  return keyed
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, address]) => address);
}

/**
 * The upstream proxy's permit, resolved for one owner's network connector tier.
 *
 * Its own shape rather than a boundary rule with another action: a boundary rule blocks,
 * and that is a literal. This permits TCP only, to the upstream proxy's addresses and
 * ports only (the connector's PAC host and every proxy a script names, EG2-11: the union
 * of those addresses with those ports, bounded), for the network connector tier only, and
 * `EGRESS_WFP_WEIGHTS` puts it above
 * the internal block it opens. A plan has at most one.
 *
 * `addresses` are `egressUpstreamPermitAddresses` of the proxy: each once, IPv4 before
 * IPv6 and each family by value, and spelled the way the descriptor's ranges are, so every
 * address in a plan has one spelling - a dotted quad, or eight groups of four lower-case
 * hex digits with no compression and no zone. `filters` has one entry for each address
 * family those addresses have and none for a family they lack, because a permit filter
 * with no address condition would open the port to every destination.
 */
export const EgressPlannedUpstreamPermitSchema = z
  .object({
    action_kind: z.literal("create_or_replace"),
    object_key: EgressObjectKeySchema,
    tier: z.literal("network_connector"),
    account_sid: EgressAccountSidSchema,
    action: z.literal("permit"),
    protocol: z.literal("tcp"),
    addresses: z.array(z.string().min(1)).min(1).max(EGRESS_UPSTREAM_PROXY_MAX_ADDRESSES),
    port: EgressPortSchema,
    /**
     * The permit's further ports, ascending and each above `port`, which is the lowest; empty
     * for a permit with one port. The broker refuses any other order or a duplicate.
     */
    additional_ports: z.array(EgressPortSchema).max(EGRESS_UPSTREAM_PROXY_MAX_ADDITIONAL_PORTS),
    filters: z.array(EgressPlannedWfpFilterSchema).min(1),
  })
  .strict();
export type EgressPlannedUpstreamPermit = z.infer<typeof EgressPlannedUpstreamPermitSchema>;

/**
 * One object this contract owns that must not exist.
 *
 * A plan states the objects that should exist and, separately, every other object the
 * key grammar admits for this owner. That completeness is the point: the set of objects
 * this contract can own is enumerable from the rule classes and the tier accounts alone,
 * without reading the host, so a plan can say "and nothing else of ours is here" rather
 * than leaving whatever an earlier version installed in place.
 *
 * Downgrading to a permissive version is the case that needs it. Without removals, the
 * plan for the version this release ships would be a plan for nothing, and a machine
 * that had run an enforcing version would keep rules no descriptor still describes.
 *
 * A removal carries no rule content. There is nothing to write, and a shape that
 * repeated the desired content of an object being deleted would invite an applier to
 * write it.
 */
export const EgressPlannedRemovalSchema = z
  .object({
    action_kind: z.literal("remove_owned_object"),
    object_key: EgressObjectKeySchema,
    mechanism: EgressMechanismSchema,
    rule_class: EgressRuleClassSchema,
    tier: EgressIsolationTierSchema,
    account_sid: EgressAccountSidSchema,
  })
  .strict();
export type EgressPlannedRemoval = z.infer<typeof EgressPlannedRemovalSchema>;

/**
 * The whole desired outbound state for one owner.
 *
 * `policy_version_label` is the one deliberate redundancy in this shape: it is
 * `policy_version` and the posture in one string, and it exists because the reporting
 * contract has room for a version and not for a posture. A reader who only ever sees
 * the label still sees the word `permissive`.
 *
 * `boundary_state` is the plan's single answer to "is egress closed". It is computed
 * from the primary layer alone, so a plan carrying a full supplementary filter set and
 * no boundary rules reports `supplementary_only_not_a_boundary`, which is a state a
 * gate can refuse rather than an empty rule list a gate might not notice.
 */
export const EgressPolicyPlanSchema = z
  .object({
    contract_version: EgressPolicyContractVersionSchema,
    policy_version: EgressPolicyVersionSchema,
    policy_version_label: z.string().min(1),
    intent: EgressPlanIntentSchema,
    owner_sid: AclOwnerSidSchema,
    boundary_state: EgressBoundaryStateSchema,
    /** What the installed filters do. Null exactly when the plan installs nothing. */
    mode: EgressEnforcementModeSchema.nullable(),
    /** The tiers this plan installs boundary rules for. */
    covered_tiers: z.array(EgressIsolationTierSchema),
    /** Every other tier. Together with `covered_tiers`, all of them, once each. */
    uncovered_tiers: z.array(EgressIsolationTierSchema),
    preconditions: z.array(EgressPlannedPreconditionSchema),
    primary_rules: z.array(EgressPlannedBoundaryRuleSchema),
    supplementary_filters: z.array(EgressPlannedSupplementaryFilterSchema),
    /** The upstream proxy's permit when the host has one, and none otherwise. */
    upstream_permits: z.array(EgressPlannedUpstreamPermitSchema),
    /** Every object the key grammar admits for this owner that should not exist. */
    removals: z.array(EgressPlannedRemovalSchema),
    /**
     * The presence anchor: whether our persistent sublayer must exist.
     *
     * True for every install, whatever the posture, and false only for an uninstall. Under
     * the permissive posture a plan holds no filter at all, and without this the plan for
     * that release would install nothing and leave nothing for a readback to find. The
     * anchor is the sublayer and its `providerData` tag, which the owner's account can read
     * back, and it is an object that blocks nothing: a sublayer with no filter in it
     * changes no connection. An enforcing plan implies the anchor, since its filters live in
     * the sublayer, and carries it too, so a reader never infers it from the rule lists.
     */
    install_sublayer: z.boolean(),
  })
  .strict();
export type EgressPolicyPlan = z.infer<typeof EgressPolicyPlanSchema>;
