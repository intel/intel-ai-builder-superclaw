/**
 * The egress policy descriptor: what the outbound boundary is supposed to be.
 *
 * One versioned source for the per-owner, per-tier outbound rules, split into a
 * primary layer that is the boundary and a supplementary layer that is not. Read by
 * the L1 planner and, later, by the broker that applies it.
 *
 * Declares intent only, enforces nothing. Nothing here opens a firewall COM object,
 * adds a WFP filter, resolves a SID or reads a rule store. A descriptor is keyed by
 * rule class, and a plan resolves it against an owner and that owner's tier accounts,
 * so adding a tier is a new member of a plan rather than a new descriptor to review.
 *
 * Three properties of this file are the point of the whole slice, and each is
 * structural rather than checked:
 *
 * 1. `non_loopback` is derived from `loopback`, so the outward boundary and the
 *    inward one are an exact partition of both address families by construction.
 * 2. The loopback boundary can only be written as the complement of what a tier may
 *    reach, and what a tier may reach is a property of the services, in
 *    `EGRESS_LOOPBACK_ENDPOINT_FACTS`. No field lists blocked loopback ports, none
 *    lists allowed ones and none removes the rule, so no configuration can dissolve it.
 * 3. Both layers are required fields carrying an explicit presence and, when absent, a
 *    reason. An empty rule set therefore cannot read as "not configured", and the
 *    absence of the primary layer and the absence of the supplementary layer are two
 *    different statements, neither of which is coverage.
 *
 * What this repository ships today is the permissive version: both layers declared
 * absent, `posture: "permissive"`, and a version label that carries the word. It reports
 * the `user_open_egress` isolation level truthfully, and that is the v2.0 release: the
 * 2026-10-20 release decision accepts `user_open_egress` for v2.0, so the enforcing
 * descriptor and its WFP applier (N3) do not gate it.
 */
import { z } from "zod";

import { EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_DEFAULT } from "./egress-loopback-dynamic-range.js";
import {
  EGRESS_BOUNDARY_CLOSED_STATE,
  EGRESS_LOOPBACK_DISPOSITION_ALLOWS_REACH,
  EGRESS_LOOPBACK_ENDPOINT_FACTS,
  EGRESS_PLANNER_REFUSAL_REASONS,
  EGRESS_PRIMARY_RULE_CLASSES,
  EGRESS_REQUIRED_PRECONDITIONS,
  EGRESS_SUPPLEMENTARY_FILTER_CLASSES,
  EGRESS_TIER_DISPOSITION_FOR_TIER,
  EGRESS_TIER_DISPOSITION_RULE_CLASSES,
  EgressAddressFamilySchema,
  EgressAddressSetSchema,
  EgressBoundaryStateSchema,
  EgressEndpointPlaneSchema,
  EgressHostPreconditionSchema,
  EgressIsolationTierSchema,
  EgressLayerAbsenceReasonSchema,
  EgressLayerAuthoritySchema,
  EgressLayerPresenceSchema,
  EgressLoopbackDispositionSchema,
  EgressLoopbackEndpointSchema,
  EgressMechanismSchema,
  EgressPermitClassSchema,
  EgressPlanIntentSchema,
  EgressPolicyRefusalReasonSchema,
  EgressPortMatchModeSchema,
  EgressPostureSchema,
  EgressProtocolSchema,
  EgressRuleClassSchema,
  EgressSupplementaryPresenceSchema,
  EgressTierDispositionSchema,
} from "./egress-policy-vocabulary.js";
import type {
  EgressAddressFamily,
  EgressAddressSet,
  EgressBoundaryState,
  EgressEndpointPlane,
  EgressHostPrecondition,
  EgressIsolationTier,
  EgressLayerAbsenceReason,
  EgressLayerAuthority,
  EgressLayerPresence,
  EgressLoopbackDisposition,
  EgressLoopbackEndpoint,
  EgressMechanism,
  EgressPlanIntent,
  EgressPolicyRefusalReason,
  EgressPortMatchMode,
  EgressPosture,
  EgressProtocol,
  EgressRuleClass,
  EgressSupplementaryPresence,
  EgressTierDisposition,
} from "./egress-policy-vocabulary.js";

export {
  EGRESS_BOUNDARY_CLOSED_STATE,
  EGRESS_LOOPBACK_DISPOSITION_ALLOWS_REACH,
  EGRESS_LOOPBACK_ENDPOINT_FACTS,
  EGRESS_PLANNER_REFUSAL_REASONS,
  EGRESS_PRIMARY_RULE_CLASSES,
  EGRESS_REQUIRED_PRECONDITIONS,
  EGRESS_SUPPLEMENTARY_FILTER_CLASSES,
  EGRESS_TIER_DISPOSITION_FOR_TIER,
  EGRESS_TIER_DISPOSITION_RULE_CLASSES,
  EgressAddressFamilySchema,
  EgressAddressSetSchema,
  EgressBoundaryStateSchema,
  EgressEndpointPlaneSchema,
  EgressHostPreconditionSchema,
  EgressIsolationTierSchema,
  EgressLayerAbsenceReasonSchema,
  EgressLayerAuthoritySchema,
  EgressLayerPresenceSchema,
  EgressLoopbackDispositionSchema,
  EgressLoopbackEndpointSchema,
  EgressMechanismSchema,
  EgressPermitClassSchema,
  EgressPlanIntentSchema,
  EgressPolicyRefusalReasonSchema,
  EgressPortMatchModeSchema,
  EgressPostureSchema,
  EgressProtocolSchema,
  EgressRuleClassSchema,
  EgressSupplementaryPresenceSchema,
  EgressTierDispositionSchema,
};
export type {
  EgressAddressFamily,
  EgressAddressSet,
  EgressBoundaryState,
  EgressEndpointPlane,
  EgressHostPrecondition,
  EgressIsolationTier,
  EgressLayerAbsenceReason,
  EgressLayerAuthority,
  EgressLayerPresence,
  EgressLoopbackDisposition,
  EgressLoopbackEndpoint,
  EgressMechanism,
  EgressPlanIntent,
  EgressPolicyRefusalReason,
  EgressPortMatchMode,
  EgressPosture,
  EgressProtocol,
  EgressRuleClass,
  EgressSupplementaryPresence,
  EgressTierDisposition,
};

/** The descriptor shape. Bumped when a field is added, removed or retyped. */
export const EgressPolicyContractVersionSchema = z.literal(4);
export const EGRESS_POLICY_CONTRACT_VERSION = 4 as const;

/**
 * The policy content's own version, bumped when the rules change.
 *
 * Separate from the contract version, which is about the shape. A host secured under
 * an older policy is a different thing from a host secured under an older shape.
 */
export const EgressPolicyVersionSchema = z.number().int().min(1);
export const EGRESS_POLICY_VERSION = 9 as const;

/** The posture this repository ships. Declared, not inferred from an empty rule set. */
export const EGRESS_POLICY_POSTURE: EgressPosture = "permissive";

/**
 * The version as one string that cannot be read without also reading the posture.
 *
 * The reporting contract carries an egress policy version alongside a file policy
 * version, and a bare `1` there would say a policy is in force. This label is what a
 * report carries instead, so "version 1" and "version 1, which closes nothing" cannot
 * come out looking the same.
 */
export function egressPolicyVersionLabel(version: number, posture: EgressPosture): string {
  return `v${version}/${posture}`;
}

/** The label for the policy this build ships. */
export const EGRESS_POLICY_VERSION_LABEL = egressPolicyVersionLabel(
  EGRESS_POLICY_VERSION,
  EGRESS_POLICY_POSTURE
);

export const EGRESS_PORT_MIN = 1 as const;
export const EGRESS_PORT_MAX = 65535 as const;

/** A TCP or UDP port. Port 0 is not a destination, so the range starts at 1. */
export const EgressPortSchema = z.number().int().min(EGRESS_PORT_MIN).max(EGRESS_PORT_MAX);

/** An inclusive port range, as an applier would hand it to a rule. */
export const EgressPortRangeSchema = z
  .object({ first: EgressPortSchema, last: EgressPortSchema })
  .strict();
export type EgressPortRange = z.infer<typeof EgressPortRangeSchema>;

/**
 * The ports a rule blocks, given the ports it allows.
 *
 * This is the only place the loopback boundary's blocked set is ever computed, and it
 * is computed rather than written down. An applier calls it; a reviewer reads one
 * function instead of auditing a list. It returns at least one range for any allowlist
 * short of every port, and no table of services can name every port.
 */
export function egressPortComplement(allowed: readonly number[]): EgressPortRange[] {
  const sorted = [...new Set(allowed)].sort((left, right) => left - right);
  const blocked: EgressPortRange[] = [];
  let cursor: number = EGRESS_PORT_MIN;
  for (const port of sorted) {
    if (port > cursor) {
      blocked.push({ first: cursor, last: port - 1 });
    }
    cursor = Math.max(cursor, port + 1);
  }
  if (cursor <= EGRESS_PORT_MAX) {
    blocked.push({ first: cursor, last: EGRESS_PORT_MAX });
  }
  return blocked;
}

/**
 * One inclusive address range.
 *
 * A range rather than a CIDR prefix, because the complement of a prefix set is not
 * prefix-aligned in general and a shape that could only say "prefix" would force the
 * derived set back into a hand-written list. `first` and `last` are canonical: fully
 * expanded, lower case, no `::` compression and no leading zeros in an IPv4 octet, so
 * two spellings of one address cannot both appear and look like two ranges.
 */
export const EgressAddressRangeSchema = z
  .object({
    address_family: EgressAddressFamilySchema,
    first: z.string().min(1),
    last: z.string().min(1),
  })
  .strict();
export type EgressAddressRange = z.infer<typeof EgressAddressRangeSchema>;

/**
 * The two address sets, which have to tile both address families exactly.
 *
 * Both are stored rather than only `loopback`, because a broker reads this artifact
 * and must not have to reimplement a complement to know what to block. They are
 * checked against each other by a refinement, and the shipped values are produced by
 * deriving one from the other, so storing both costs nothing in trust.
 */
export const EgressAddressSetsSchema = z
  .object({
    loopback: z.array(EgressAddressRangeSchema).min(1),
    non_loopback: z.array(EgressAddressRangeSchema).min(1),
    /** Inside `non_loopback`, not a third part of the partition. */
    internal: z.array(EgressAddressRangeSchema).min(1),
  })
  .strict();
export type EgressAddressSets = z.infer<typeof EgressAddressSetsSchema>;

/**
 * How a boundary rule turns ports into a match.
 *
 * The mode and nothing else. The ports a loopback rule leaves reachable for a tier are
 * those of the services whose `reachable_from` names it (`egressTierLoopbackPorts`), and
 * `egressPortComplement` is the only way a blocked set comes into existence, so a rule
 * can be neither widened nor narrowed by editing a port list on it.
 */
export const EgressPortMatchSchema = z
  .object({
    match_mode: EgressPortMatchModeSchema,
  })
  .strict();
export type EgressPortMatch = z.infer<typeof EgressPortMatchSchema>;

/**
 * One boundary rule in the primary layer.
 *
 * `action` and `protocol` are literals, not enum fields. A boundary made of BLOCK
 * rules over every protocol has no legitimate variant that allows something or that
 * narrows to TCP, and expressing that as a type rather than as a rule means the
 * generated Pydantic model refuses those values too, on the far side of codegen.
 */
export const EgressBoundaryRuleSchema = z
  .object({
    rule_class: EgressRuleClassSchema,
    action: z.literal("block"),
    protocol: z.literal("any"),
    address_set: EgressAddressSetSchema,
    tiers: z.array(EgressIsolationTierSchema).min(1),
    port_match: EgressPortMatchSchema,
  })
  .strict();
export type EgressBoundaryRule = z.infer<typeof EgressBoundaryRuleSchema>;

/**
 * One filter in the supplementary layer.
 *
 * Deliberately not shaped like a boundary rule. It has no address set, because these
 * filters carry no address condition. Giving it fields it does not have would make the
 * two layers look interchangeable, which is the confusion this split exists to prevent.
 */
export const EgressSupplementaryFilterSchema = z
  .object({
    filter_class: EgressRuleClassSchema,
    action: z.literal("block"),
    protocols: z.array(EgressProtocolSchema).min(1),
    blocked_ports: z.array(EgressPortSchema),
    tiers: z.array(EgressIsolationTierSchema).min(1),
  })
  .strict();
export type EgressSupplementaryFilter = z.infer<typeof EgressSupplementaryFilterSchema>;

/**
 * The layer that is the boundary.
 *
 * `authority` is a literal so that the supplementary layer cannot claim primary
 * authority by changing a value. `absence_reason` is nullable rather than optional: a
 * reader always has the field, and an absent layer always says why.
 */
export const EgressPrimaryLayerSchema = z
  .object({
    authority: z.literal("primary"),
    mechanism: z.literal("wfp"),
    presence: EgressLayerPresenceSchema,
    absence_reason: EgressLayerAbsenceReasonSchema.nullable(),
    rules: z.array(EgressBoundaryRuleSchema),
  })
  .strict();
export type EgressPrimaryLayer = z.infer<typeof EgressPrimaryLayerSchema>;

/**
 * The layer that is not the boundary, and says so in its own type.
 *
 * `presence` is its own enum, without the word `enforcing` in it, so that no caller can
 * ask this layer whether it is enforcing and be told yes.
 */
export const EgressSupplementaryLayerSchema = z
  .object({
    authority: z.literal("supplementary"),
    mechanism: z.literal("wfp"),
    presence: EgressSupplementaryPresenceSchema,
    absence_reason: EgressLayerAbsenceReasonSchema.nullable(),
    filters: z.array(EgressSupplementaryFilterSchema),
  })
  .strict();
export type EgressSupplementaryLayer = z.infer<typeof EgressSupplementaryLayerSchema>;

/**
 * One loopback service: its ports, whether a tier may be allowed to reach it, and which.
 *
 * `ports` is empty for a service that binds a dynamic port. Such a service cannot be
 * allowlisted, because there is no number to allow, and the refinement below refuses
 * the combination rather than leaving it to be discovered.
 */
export const EgressLoopbackEndpointPolicySchema = z
  .object({
    endpoint: EgressLoopbackEndpointSchema,
    ports: z.array(EgressPortSchema),
    plane: EgressEndpointPlaneSchema,
    loopback_disposition: EgressLoopbackDispositionSchema,
    reachable_from: z.array(EgressIsolationTierSchema),
  })
  .strict();
export type EgressLoopbackEndpointPolicy = z.infer<
  typeof EgressLoopbackEndpointPolicySchema
>;

/**
 * What this layer does about one tier. Exactly one entry per tier.
 *
 * `allows_host_dynamic_port_range` is D2: whether the tier's loopback allowlist includes
 * the host's TCP dynamic range, which every Python asyncio event loop on Windows needs for
 * its socketpair. The range is the host's own, read at plan time and refused when it holds a
 * port the plan keeps blocked (see `egress-loopback-dynamic-range.ts`); the plan materializes
 * it, and `EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_DEFAULT` is only the Windows default.
 */
export const EgressTierPolicySchema = z
  .object({
    tier: EgressIsolationTierSchema,
    disposition: EgressTierDispositionSchema,
    allows_host_dynamic_port_range: z.boolean(),
  })
  .strict();
export type EgressTierPolicy = z.infer<typeof EgressTierPolicySchema>;

/**
 * Where a refusal is. Codes and one port, never a rule name.
 *
 * `port` is the one literal here, and it is a location rather than an identity: a
 * refusal about an allowlisted port that corresponds to no service has to be able to
 * say which port.
 */
export const EgressPolicyLocatorSchema = z
  .object({
    layer_authority: EgressLayerAuthoritySchema.nullable(),
    rule_class: EgressRuleClassSchema.nullable(),
    tier: EgressIsolationTierSchema.nullable(),
    endpoint: EgressLoopbackEndpointSchema.nullable(),
    precondition: EgressHostPreconditionSchema.nullable(),
    address_family: EgressAddressFamilySchema.nullable(),
    port: EgressPortSchema.nullable(),
  })
  .strict();
export type EgressPolicyLocator = z.infer<typeof EgressPolicyLocatorSchema>;

const EMPTY_LOCATOR: EgressPolicyLocator = {
  layer_authority: null,
  rule_class: null,
  tier: null,
  endpoint: null,
  precondition: null,
  address_family: null,
  port: null,
};

export const EgressPolicyRefusalItemSchema = z
  .object({
    reason: EgressPolicyRefusalReasonSchema,
    locator: EgressPolicyLocatorSchema,
  })
  .strict();
export type EgressPolicyRefusalItem = z.infer<typeof EgressPolicyRefusalItemSchema>;

export const EgressPolicyRefusalSchema = z
  .object({
    contract_version: EgressPolicyContractVersionSchema,
    refusals: z.array(EgressPolicyRefusalItemSchema).min(1),
  })
  .strict();
export type EgressPolicyRefusal = z.infer<typeof EgressPolicyRefusalSchema>;

const egressPolicyDescriptorShape = {
  contract_version: EgressPolicyContractVersionSchema,
  policy_version: EgressPolicyVersionSchema,
  /** Declared, and required to agree with the primary layer. */
  posture: EgressPostureSchema,
  address_sets: EgressAddressSetsSchema,
  /** Exactly one entry per loopback endpoint this vocabulary names. */
  loopback_endpoints: z.array(EgressLoopbackEndpointPolicySchema),
  /** Exactly one entry per isolation tier. */
  tier_policies: z.array(EgressTierPolicySchema),
  /** Every host condition an enforcing plan has to see evidence for. */
  required_host_preconditions: z.array(EgressHostPreconditionSchema),
  primary_layer: EgressPrimaryLayerSchema,
  supplementary_layer: EgressSupplementaryLayerSchema,
};

/**
 * The descriptor, shape only.
 *
 * The exported schema below adds the cross-field rules. This base is what the
 * refinement receives, already parsed, so every rule can assume its fields are present
 * and of their declared type.
 */
const egressPolicyDescriptorBaseSchema = z.object(egressPolicyDescriptorShape).strict();
export type EgressPolicyDescriptor = z.infer<typeof egressPolicyDescriptorBaseSchema>;

const IPV4_BIT_WIDTH = 32n;
const IPV6_BIT_WIDTH = 128n;

function familyMax(family: EgressAddressFamily): bigint {
  return (1n << (family === "ipv4" ? IPV4_BIT_WIDTH : IPV6_BIT_WIDTH)) - 1n;
}

function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join(".");
}

/**
 * Parse an IPv6 address, accepting `::` compression, an embedded IPv4 tail, and either case.
 *
 * Compression is accepted on input so that the source of this file can be read, and either
 * case because an upstream proxy's address is spelled however the host's proxy setting
 * spelled it. Both are rejected on output by the canonical-form rule, so the artifact
 * cannot contain two spellings of one address.
 */
function parseIpv6(text: string): bigint | null {
  let body = text;
  const embedded = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(body);
  if (embedded) {
    const tail = parseIpv4(embedded[1]);
    if (tail === null) return null;
    const high = ((tail >> 16n) & 0xffffn).toString(16);
    const low = (tail & 0xffffn).toString(16);
    body = `${body.slice(0, embedded.index)}:${high}:${low}`;
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const head = groupsOf(halves[0]);
  const rear = halves.length === 2 ? groupsOf(halves[1]) : [];
  const named = head.length + rear.length;
  if (halves.length === 1 ? named !== 8 : named > 7) return null;
  const groups =
    halves.length === 1
      ? head
      : [...head, ...(Array<string>(8 - named).fill("0")), ...rear];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(`0x${group}`);
  }
  return value;
}

/** Eight groups of four hex digits, always. No compression, so exactly one spelling. */
function formatIpv6(value: bigint): string {
  const groups: string[] = [];
  for (let index = 7n; index >= 0n; index -= 1n) {
    groups.push(((value >> (index * 16n)) & 0xffffn).toString(16).padStart(4, "0"));
  }
  return groups.join(":");
}

function parseAddress(family: EgressAddressFamily, text: string): bigint | null {
  return family === "ipv4" ? parseIpv4(text) : parseIpv6(text);
}

function formatAddress(family: EgressAddressFamily, value: bigint): string {
  return family === "ipv4" ? formatIpv4(value) : formatIpv6(value);
}

/** Whether a string is the one canonical spelling of the address it denotes. */
function isCanonicalAddress(family: EgressAddressFamily, text: string): boolean {
  const value = parseAddress(family, text);
  return value !== null && formatAddress(family, value) === text;
}

type NumericRange = { readonly first: bigint; readonly last: bigint };

function byFirst(left: NumericRange, right: NumericRange): number {
  return left.first < right.first ? -1 : left.first > right.first ? 1 : 0;
}

/**
 * The ranges of one family that are not in the given set.
 *
 * This is what makes `non_loopback` a derived value. The outward boundary and the
 * inward one come from one list, so there is no second list to keep in step and no
 * gap between them to find later.
 */
function complementRanges(
  family: EgressAddressFamily,
  ranges: readonly NumericRange[]
): NumericRange[] {
  const gaps: NumericRange[] = [];
  let cursor = 0n;
  for (const range of [...ranges].sort(byFirst)) {
    if (range.first > cursor) {
      gaps.push({ first: cursor, last: range.first - 1n });
    }
    if (range.last + 1n > cursor) {
      cursor = range.last + 1n;
    }
  }
  const max = familyMax(family);
  if (cursor <= max) {
    gaps.push({ first: cursor, last: max });
  }
  return gaps;
}

/** Whether the ranges cover the family exactly once each, with no gap and no overlap. */
function tilesFamily(
  family: EgressAddressFamily,
  ranges: readonly NumericRange[]
): boolean {
  let cursor = 0n;
  for (const range of [...ranges].sort(byFirst)) {
    if (range.first !== cursor) return false;
    cursor = range.last + 1n;
  }
  return cursor === familyMax(family) + 1n;
}

function addressRange(
  family: EgressAddressFamily,
  first: string,
  last: string
): EgressAddressRange {
  const low = parseAddress(family, first);
  const high = parseAddress(family, last);
  if (low === null || high === null) {
    throw new Error(`not an ${family} address: ${first} ${last}`);
  }
  return {
    address_family: family,
    first: formatAddress(family, low),
    last: formatAddress(family, high),
  };
}

function numericRange(range: EgressAddressRange): NumericRange | null {
  const first = parseAddress(range.address_family, range.first);
  const last = parseAddress(range.address_family, range.last);
  return first === null || last === null ? null : { first, last };
}

type Refuse = (
  reason: EgressPolicyRefusalReason,
  path: (string | number)[],
  locator: EgressPolicyLocator,
  message: string
) => void;

const ALL_FAMILIES: readonly EgressAddressFamily[] = EgressAddressFamilySchema.options;
const ICMP_FILTER_CLASSES: readonly EgressRuleClass[] = [
  "icmp_connect_block",
  "icmp_resource_assignment_block",
];

/** The address set each boundary class is required to match on. */
const ADDRESS_SET_FOR_CLASS: Readonly<Partial<Record<EgressRuleClass, EgressAddressSet>>> = {
  external_outbound_block: "non_loopback",
  loopback_non_allowlisted_block: "loopback",
  internal_outbound_block: "internal",
};

/** The port match mode each boundary class is required to use. */
const PORT_MATCH_MODE_FOR_CLASS: Readonly<
  Partial<Record<EgressRuleClass, EgressPortMatchMode>>
> = {
  external_outbound_block: "every_port",
  loopback_non_allowlisted_block: "block_complement_of_allowed_ports",
  internal_outbound_block: "every_port",
};

/** Whether every address in `target` falls inside some one of `intervals`. */
function coversRange(intervals: readonly NumericRange[], target: NumericRange): boolean {
  const sorted = [...intervals].sort((a, b) => (a.first < b.first ? -1 : 1));
  let reached = target.first;
  for (const interval of sorted) {
    if (interval.first > reached) break;
    if (interval.last >= reached) reached = interval.last + 1n;
    if (reached > target.last) return true;
  }
  return reached > target.last;
}

/**
 * The address sets are each other's complement, each range is well formed, and the set
 * named `loopback` is the machine itself.
 *
 * The partition rule is only reached when every range parsed and was ordered, so a
 * single malformed range reports one reason rather than three.
 *
 * The last rule is there because the first two are symmetric and a review showed what
 * that allows: swap the two arrays and the descriptor is still a valid partition, but
 * `external_outbound_block` now blocks loopback while the port complement is applied to
 * the whole internet, leaving every allowlisted port reachable from anywhere. Only this
 * rule knows which set is which.
 */
function refineAddressSets(
  sets: EgressAddressSets,
  refuse: Refuse
): void {
  const numeric = new Map<EgressAddressFamily, NumericRange[]>(
    ALL_FAMILIES.map((family) => [family, []])
  );
  const declaredLoopback = new Map<EgressAddressFamily, NumericRange[]>(
    ALL_FAMILIES.map((family) => [family, []])
  );
  let wellFormed = true;

  for (const setName of ["loopback", "non_loopback", "internal"] as const) {
    sets[setName].forEach((range, index) => {
      const at: (string | number)[] = ["address_sets", setName, index];
      const locator: EgressPolicyLocator = {
        ...EMPTY_LOCATOR,
        address_family: range.address_family,
      };
      for (const bound of ["first", "last"] as const) {
        if (!isCanonicalAddress(range.address_family, range[bound])) {
          wellFormed = false;
          refuse(
            "address_not_in_canonical_form",
            [...at, bound],
            locator,
            "an address is written once, fully expanded and in lower case"
          );
        }
      }
      const parsed = numericRange(range);
      if (parsed === null) return;
      if (parsed.first > parsed.last) {
        wellFormed = false;
        refuse(
          "address_range_not_ordered",
          at,
          locator,
          "a range runs from first to last, so an inverted range matches nothing"
        );
        return;
      }
      if (setName === "internal") return;
      numeric.get(range.address_family)?.push(parsed);
      if (setName === "loopback") declaredLoopback.get(range.address_family)?.push(parsed);
    });
  }

  if (!wellFormed) return;

  for (const family of ALL_FAMILIES) {
    if (!tilesFamily(family, numeric.get(family) ?? [])) {
      refuse(
        "address_sets_do_not_partition_the_address_space",
        ["address_sets"],
        { ...EMPTY_LOCATOR, address_family: family },
        "loopback and non_loopback together are every address in the family, once each"
      );
    }
  }

  for (const range of LOOPBACK_RANGES) {
    const target = numericRange(range);
    if (target === null) continue;
    if (!coversRange(declaredLoopback.get(range.address_family) ?? [], target)) {
      refuse(
        "loopback_address_set_not_loopback",
        ["address_sets", "loopback"],
        { ...EMPTY_LOCATOR, address_family: range.address_family },
        "the set the port allowlist applies to is the machine itself, or it is not loopback"
      );
    }
  }

  // The internal set is derived, not chosen: a narrower one would let the network
  // connector tier reach a network egress_guard refuses, and a wider one would block a
  // public address the Connector was allowed to fetch.
  if (canonicalEgressPolicyJson(sets.internal) !== canonicalEgressPolicyJson(INTERNAL_RANGES)) {
    refuse(
      "internal_address_set_not_internal",
      ["address_sets", "internal"],
      EMPTY_LOCATOR,
      "the internal set is the networks this contract derives, not a list a descriptor edits"
    );
  }
}

function sameSequence<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function refineLoopbackEndpoints(
  endpoints: readonly EgressLoopbackEndpointPolicy[],
  dispositions: ReadonlyMap<EgressIsolationTier, EgressTierDisposition>,
  refuse: Refuse
): void {
  const seen = new Set<EgressLoopbackEndpoint>();
  const byPort = new Map<number, EgressLoopbackEndpoint>();

  endpoints.forEach((entry, index) => {
    const at: (string | number)[] = ["loopback_endpoints", index];
    const locator: EgressPolicyLocator = { ...EMPTY_LOCATOR, endpoint: entry.endpoint };
    if (seen.has(entry.endpoint)) {
      refuse("loopback_endpoint_duplicated", at, locator, "one entry per endpoint");
    }
    seen.add(entry.endpoint);

    // What a service is, against what this descriptor says it is. Without this, `plane`
    // and `loopback_disposition` are two free fields side by side, and one edited word
    // turns the host control plane into something an island may be allowed to reach. The
    // same holds for the ports and for who may reach them, which are the allowlist.
    const facts = EGRESS_LOOPBACK_ENDPOINT_FACTS[entry.endpoint];
    if (
      !sameSequence(entry.ports, facts.ports) ||
      entry.plane !== facts.plane ||
      entry.loopback_disposition !== facts.loopback_disposition ||
      !sameSequence(entry.reachable_from, facts.reachable_from)
    ) {
      refuse(
        "loopback_endpoint_not_the_declared_service",
        at,
        locator,
        "a service's ports, plane, disposition and reach are properties of the service"
      );
    }

    for (const port of entry.ports) {
      if (byPort.has(port)) {
        refuse(
          "loopback_endpoint_port_duplicated",
          [...at, "ports"],
          { ...locator, port },
          "two names for one port would let an allowlist mean either service"
        );
      }
      byPort.set(port, entry.endpoint);
    }

    if (EGRESS_LOOPBACK_DISPOSITION_ALLOWS_REACH[entry.loopback_disposition]) {
      if (entry.plane === "host_control") {
        refuse(
          "loopback_endpoint_disposition_inconsistent_with_plane",
          [...at, "loopback_disposition"],
          locator,
          "the trusted control plane is not something an island may be allowed to reach"
        );
      }
      if (entry.ports.length === 0) {
        refuse(
          "loopback_endpoint_disposition_inconsistent_with_plane",
          [...at, "loopback_disposition"],
          locator,
          "a dynamic port cannot be allowlisted, because there is no number to allow"
        );
      }
    } else if (entry.reachable_from.length > 0) {
      refuse(
        "loopback_endpoint_reachable_but_not_allowlistable",
        [...at, "reachable_from"],
        locator,
        "this service's disposition says an island may not reach it"
      );
    }

    for (const tier of entry.reachable_from) {
      if (dispositions.get(tier) === "not_expressed_by_this_layer") {
        refuse(
          "tier_not_expressed_but_declares_loopback_access",
          [...at, "reachable_from"],
          { ...locator, tier },
          "a tier this layer does not express reaches nothing through it"
        );
      }
    }
  });

  for (const endpoint of EgressLoopbackEndpointSchema.options) {
    if (!seen.has(endpoint)) {
      refuse(
        "loopback_endpoint_not_covered",
        ["loopback_endpoints"],
        { ...EMPTY_LOCATOR, endpoint },
        "every loopback service this vocabulary names has a disposition"
      );
    }
  }
}

function refineTierPolicies(
  policies: readonly EgressTierPolicy[],
  refuse: Refuse
): void {
  const seen = new Set<EgressIsolationTier>();
  policies.forEach((entry, index) => {
    const locator: EgressPolicyLocator = { ...EMPTY_LOCATOR, tier: entry.tier };
    if (seen.has(entry.tier)) {
      refuse(
        "tier_disposition_duplicated",
        ["tier_policies", index],
        locator,
        "one disposition per tier"
      );
    }
    seen.add(entry.tier);
    if (
      entry.disposition !== "not_expressed_by_this_layer" &&
      entry.disposition !== EGRESS_TIER_DISPOSITION_FOR_TIER[entry.tier]
    ) {
      refuse(
        "tier_disposition_not_the_tiers",
        ["tier_policies", index, "disposition"],
        locator,
        "a tier is covered with its own disposition, or not covered"
      );
    }
  });
  for (const tier of EgressIsolationTierSchema.options) {
    if (!seen.has(tier)) {
      refuse(
        "tier_disposition_not_covered",
        ["tier_policies"],
        { ...EMPTY_LOCATOR, tier },
        "every tier says what this layer does about it, including saying nothing"
      );
    }
  }
}

/**
 * D2 allows a tier the host's dynamic range on loopback, at build time the Windows default
 * `EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_DEFAULT`, and a rule
 * matched on the destination port cannot tell the tier's own socketpair from any other
 * listener in that range. So a denied service that binds a dynamic port, or a port inside
 * the range, is reachable by every tier the range is allowed to, and a descriptor saying
 * both is refused at build time.
 */
function refineDynamicPortRange(
  descriptor: EgressPolicyDescriptor,
  dispositions: ReadonlyMap<EgressIsolationTier, EgressTierDisposition>,
  refuse: Refuse
): void {
  const deniedOnDynamicPorts = descriptor.loopback_endpoints.filter(
    (entry) =>
      !EGRESS_LOOPBACK_DISPOSITION_ALLOWS_REACH[entry.loopback_disposition] &&
      (entry.ports.length === 0 ||
        entry.ports.some(
          (port) =>
            port >= EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_DEFAULT.first &&
            port <= EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_DEFAULT.last
        ))
  );
  descriptor.tier_policies.forEach((policy, index) => {
    if (!policy.allows_host_dynamic_port_range) return;
    const at: (string | number)[] = ["tier_policies", index, "allows_host_dynamic_port_range"];
    if (dispositions.get(policy.tier) === "not_expressed_by_this_layer") {
      refuse(
        "tier_not_expressed_but_declares_loopback_access",
        at,
        { ...EMPTY_LOCATOR, tier: policy.tier },
        "a tier this layer does not express reaches nothing through it"
      );
      return;
    }
    for (const entry of deniedOnDynamicPorts) {
      refuse(
        "host_dynamic_port_range_exposes_denied_endpoint",
        at,
        { ...EMPTY_LOCATOR, tier: policy.tier, endpoint: entry.endpoint },
        "a service that listens on a dynamic port is reachable by every tier allowed the range"
      );
    }
  });
}

function refinePreconditions(
  declared: readonly EgressHostPrecondition[],
  refuse: Refuse
): void {
  for (const precondition of EGRESS_REQUIRED_PRECONDITIONS) {
    if (!declared.includes(precondition)) {
      refuse(
        "host_precondition_not_declared",
        ["required_host_preconditions"],
        { ...EMPTY_LOCATOR, precondition },
        "a BLOCK-only rule set is fail-open until every one of these is verified"
      );
    }
  }
}

/**
 * Presence, rules and absence reason say the same thing about a layer.
 *
 * Takes a boolean rather than either presence enum, because the two layers no longer
 * share one: the primary layer is `enforcing` or not, the supplementary layer has its
 * filters installed or not, and this rule is the same rule either way.
 */
function refineLayerPresence(
  authority: EgressLayerAuthority,
  isPresent: boolean,
  absenceReason: EgressLayerAbsenceReason | null,
  memberCount: number,
  at: (string | number)[],
  refuse: Refuse
): void {
  const locator: EgressPolicyLocator = { ...EMPTY_LOCATOR, layer_authority: authority };
  if (isPresent !== (memberCount > 0)) {
    refuse(
      "layer_presence_inconsistent_with_rules",
      at,
      locator,
      "an enforcing layer carries rules and an absent one carries none"
    );
  }
  if (!isPresent !== (absenceReason !== null)) {
    refuse(
      "layer_absence_reason_inconsistent_with_presence",
      [...at, "absence_reason"],
      locator,
      "an absent layer says why, and a layer that is there does not"
    );
  }
}

function refineTiersAreExpressed(
  tiers: readonly EgressIsolationTier[],
  ruleClass: EgressRuleClass,
  authority: EgressLayerAuthority,
  dispositions: ReadonlyMap<EgressIsolationTier, EgressTierDisposition>,
  at: (string | number)[],
  refuse: Refuse
): void {
  for (const tier of tiers) {
    if (dispositions.get(tier) === "not_expressed_by_this_layer") {
      refuse(
        "tier_not_expressed_but_carries_rules",
        at,
        { ...EMPTY_LOCATOR, layer_authority: authority, rule_class: ruleClass, tier },
        "a tier this layer declares it does not express cannot also have rules here"
      );
    }
  }
}

function refinePrimaryLayer(
  descriptor: EgressPolicyDescriptor,
  dispositions: ReadonlyMap<EgressIsolationTier, EgressTierDisposition>,
  refuse: Refuse
): void {
  const layer = descriptor.primary_layer;
  refineLayerPresence(
    "primary",
    layer.presence !== "declared_absent",
    layer.absence_reason,
    layer.rules.length,
    ["primary_layer"],
    refuse
  );

  const seen = new Set<EgressRuleClass>();
  layer.rules.forEach((rule, index) => {
    const at: (string | number)[] = ["primary_layer", "rules", index];
    const locator: EgressPolicyLocator = {
      ...EMPTY_LOCATOR,
      layer_authority: "primary",
      rule_class: rule.rule_class,
    };

    if (!EGRESS_PRIMARY_RULE_CLASSES.includes(rule.rule_class)) {
      refuse(
        "rule_class_not_valid_for_layer",
        [...at, "rule_class"],
        locator,
        "a supplementary filter class is not a boundary rule"
      );
      return;
    }
    if (seen.has(rule.rule_class)) {
      refuse(
        "boundary_rule_class_duplicated",
        [...at, "rule_class"],
        locator,
        "one rule per boundary class, so there is one place to read it"
      );
    }
    seen.add(rule.rule_class);

    if (rule.address_set !== ADDRESS_SET_FOR_CLASS[rule.rule_class]) {
      refuse(
        "rule_address_set_wrong_for_rule_class",
        [...at, "address_set"],
        locator,
        "each boundary class covers exactly one of the two address sets"
      );
    }

    const requiredMode = PORT_MATCH_MODE_FOR_CLASS[rule.rule_class];
    if (rule.port_match.match_mode !== requiredMode) {
      refuse(
        "port_match_mode_wrong_for_rule_class",
        [...at, "port_match", "match_mode"],
        locator,
        "the loopback boundary is a complement and the external one is every port"
      );
    }

    refineTiersAreExpressed(
      rule.tiers,
      rule.rule_class,
      "primary",
      dispositions,
      [...at, "tiers"],
      refuse
    );

    for (const tier of rule.tiers) {
      const disposition = dispositions.get(tier);
      if (disposition === undefined || disposition === "not_expressed_by_this_layer") continue;
      const classes: readonly EgressRuleClass[] = EGRESS_TIER_DISPOSITION_RULE_CLASSES[disposition];
      if (!classes.includes(rule.rule_class)) {
        refuse(
          "rule_class_not_for_tier_disposition",
          [...at, "tiers"],
          { ...locator, tier },
          "a tier carries the boundary classes its disposition asks for, and no other"
        );
      }
    }
  });

  if (layer.presence === "declared_absent") return;
  const required = new Set<EgressRuleClass>(
    [...dispositions.values()].flatMap((disposition) => EGRESS_TIER_DISPOSITION_RULE_CLASSES[disposition])
  );
  for (const ruleClass of EGRESS_PRIMARY_RULE_CLASSES) {
    if (required.has(ruleClass) && !seen.has(ruleClass)) {
      refuse(
        "boundary_rule_class_not_covered",
        ["primary_layer", "rules"],
        { ...EMPTY_LOCATOR, layer_authority: "primary", rule_class: ruleClass },
        "a boundary is both halves, outward and inward, whether it blocks or only logs"
      );
    }
  }
}

function refineSupplementaryLayer(
  descriptor: EgressPolicyDescriptor,
  dispositions: ReadonlyMap<EgressIsolationTier, EgressTierDisposition>,
  refuse: Refuse
): void {
  const layer = descriptor.supplementary_layer;
  refineLayerPresence(
    "supplementary",
    layer.presence === "filters_installed",
    layer.absence_reason,
    layer.filters.length,
    ["supplementary_layer"],
    refuse
  );

  if (
    layer.presence === "filters_installed" &&
    descriptor.primary_layer.presence === "declared_absent"
  ) {
    refuse(
      "supplementary_layer_without_primary_boundary",
      ["supplementary_layer", "presence"],
      { ...EMPTY_LOCATOR, layer_authority: "supplementary" },
      "a net under a boundary that is not there is not a boundary"
    );
  }

  const seen = new Set<EgressRuleClass>();
  layer.filters.forEach((filter, index) => {
    const at: (string | number)[] = ["supplementary_layer", "filters", index];
    const locator: EgressPolicyLocator = {
      ...EMPTY_LOCATOR,
      layer_authority: "supplementary",
      rule_class: filter.filter_class,
    };

    if (!EGRESS_SUPPLEMENTARY_FILTER_CLASSES.includes(filter.filter_class)) {
      refuse(
        "rule_class_not_valid_for_layer",
        [...at, "filter_class"],
        locator,
        "a boundary class does not belong to a layer that is not the boundary"
      );
      return;
    }
    if (seen.has(filter.filter_class)) {
      refuse(
        "supplementary_filter_class_duplicated",
        [...at, "filter_class"],
        locator,
        "one filter per class"
      );
    }
    seen.add(filter.filter_class);

    const isIcmp = ICMP_FILTER_CLASSES.includes(filter.filter_class);
    const requiredProtocols: readonly EgressProtocol[] = isIcmp
      ? ["icmpv4", "icmpv6"]
      : ["tcp", "udp"];
    for (const protocol of requiredProtocols) {
      if (!filter.protocols.includes(protocol)) {
        refuse(
          "supplementary_filter_protocol_not_covered",
          [...at, "protocols"],
          locator,
          "a filter that covers one address family leaves the other one open"
        );
      }
    }
    if (isIcmp === filter.blocked_ports.length > 0) {
      refuse(
        "supplementary_filter_match_inconsistent_with_class",
        [...at, "blocked_ports"],
        locator,
        "an ICMP filter has no ports, and a port filter has to name some"
      );
    }

    refineTiersAreExpressed(
      filter.tiers,
      filter.filter_class,
      "supplementary",
      dispositions,
      [...at, "tiers"],
      refuse
    );
  });

  if (layer.presence !== "filters_installed") return;
  for (const filterClass of EGRESS_SUPPLEMENTARY_FILTER_CLASSES) {
    if (!seen.has(filterClass)) {
      refuse(
        "supplementary_filter_class_not_covered",
        ["supplementary_layer", "filters"],
        { ...EMPTY_LOCATOR, layer_authority: "supplementary", rule_class: filterClass },
        "this layer is installed whole or not at all"
      );
    }
  }
}

/**
 * The cross-field rules, over an already-parsed descriptor.
 *
 * `superRefine` runs only when the object parse did not abort, so every field here is
 * present and of its declared type. Rules that belong to a field's own shape live in
 * the schema instead, where the generated Pydantic model carries them too.
 */
function refineEgressPolicyDescriptor(
  descriptor: EgressPolicyDescriptor,
  context: z.RefinementCtx
): void {
  const refuse: Refuse = (reason, path, locator, message) => {
    context.addIssue({ code: "custom", path, params: { reason, locator }, message });
  };

  const dispositions = new Map<EgressIsolationTier, EgressTierDisposition>(
    descriptor.tier_policies.map((entry) => [entry.tier, entry.disposition])
  );

  refineAddressSets(descriptor.address_sets, refuse);
  refineLoopbackEndpoints(descriptor.loopback_endpoints, dispositions, refuse);
  refineTierPolicies(descriptor.tier_policies, refuse);
  refineDynamicPortRange(descriptor, dispositions, refuse);
  refinePreconditions(descriptor.required_host_preconditions, refuse);
  refinePrimaryLayer(descriptor, dispositions, refuse);
  refineSupplementaryLayer(descriptor, dispositions, refuse);

  if ((descriptor.posture === "enforcing") !== (descriptor.primary_layer.presence === "enforcing")) {
    refuse(
      "posture_inconsistent_with_primary_layer",
      ["posture"],
      { ...EMPTY_LOCATOR, layer_authority: "primary" },
      "the posture is the primary layer's state, not an independent claim"
    );
    return;
  }

  // A layer with rules owes each tier it denies both halves, whether it blocks or only
  // logs: logging only rehearses the boundary that will block. A layer with no rules
  // declares what it intends for a tier and ships nothing: the permissive posture v2.0
  // ships under `user_open_egress`, until enforcement (N3) lands.
  if (descriptor.primary_layer.presence === "declared_absent") return;
  for (const [tier, disposition] of dispositions) {
    for (const ruleClass of EGRESS_TIER_DISPOSITION_RULE_CLASSES[disposition]) {
      const covered = descriptor.primary_layer.rules.some(
        (rule) => rule.rule_class === ruleClass && rule.tiers.includes(tier)
      );
      if (!covered) {
        refuse(
          "tier_disposition_without_rules",
          ["primary_layer", "rules"],
          { ...EMPTY_LOCATOR, layer_authority: "primary", rule_class: ruleClass, tier },
          "a tier this layer says it denies has to appear in both boundary rules"
        );
      }
    }
  }
}

export const EgressPolicyDescriptorSchema =
  egressPolicyDescriptorBaseSchema.superRefine(refineEgressPolicyDescriptor);

/**
 * The descriptor as one canonical string.
 *
 * Object keys sorted at every depth and no insignificant whitespace, so the string
 * depends on the content and not on the order a serializer happened to walk it. This
 * is the JS half of a two-language agreement: the Python half is
 * `json.dumps(payload, sort_keys=True, separators=(",", ":"))`, which produces the
 * same bytes for the JSON types a descriptor is made of.
 *
 * It exists because the cross-field rules above do not survive codegen. Zod
 * `superRefine` has no JSON Schema representation, so the generated Pydantic model
 * enforces field shapes and nothing else. Rather than restate ~30 rules in a second
 * language and let the two spellings drift, the planner pins the digest of this
 * string: the rules are checked once, here, at build time, and the runtime refuses any
 * descriptor that is not the artifact those rules were checked against.
 */
export function canonicalEgressPolicyJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalEgressPolicyJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalEgressPolicyJson(member)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The reason a schema-level failure reports, by the field it landed on.
 *
 * The refinement never runs when the base parse fails, so without this a rule moved
 * into the schema would silently lose its reason. `action` and `protocol` are literals
 * for exactly that reason: the generated Pydantic model refuses a rule that allows
 * something or narrows to one protocol, and these two entries are how that refusal
 * keeps its name on this side.
 */
const SHAPE_ISSUE_REASONS: Readonly<Record<string, EgressPolicyRefusalReason>> = {
  action: "rule_action_not_block",
  protocol: "rule_protocol_does_not_cover_every_protocol",
};

/**
 * Validate a descriptor and return the refusal, or undefined.
 *
 * A failure that lands nowhere more specific reports `descriptor_shape_invalid`.
 */
export function refuseEgressPolicyDescriptor(
  value: unknown
): EgressPolicyRefusal | undefined {
  const result = EgressPolicyDescriptorSchema.safeParse(value);
  if (result.success) {
    return undefined;
  }

  const items = new Map<string, EgressPolicyRefusalItem>();
  for (const issue of result.error.issues) {
    const params = (issue as { params?: { reason?: unknown; locator?: unknown } }).params;
    if (typeof params?.reason !== "string") {
      // Some rules are expressed in the schema rather than in the refinement, so that
      // the generated Pydantic model refuses the same values. Name their reason
      // anyway: "malformed somewhere" is not a usable verdict.
      const item: EgressPolicyRefusalItem = {
        reason: SHAPE_ISSUE_REASONS[String(issue.path.at(-1))] ?? "descriptor_shape_invalid",
        locator: EMPTY_LOCATOR,
      };
      items.set(JSON.stringify(item), item);
      continue;
    }
    const parsedLocator = EgressPolicyLocatorSchema.safeParse(params.locator);
    const item: EgressPolicyRefusalItem = {
      reason: params.reason as EgressPolicyRefusalReason,
      locator: parsedLocator.success ? parsedLocator.data : EMPTY_LOCATOR,
    };
    items.set(JSON.stringify(item), item);
  }
  if (items.size === 0) {
    const item: EgressPolicyRefusalItem = {
      reason: "descriptor_shape_invalid",
      locator: EMPTY_LOCATOR,
    };
    items.set(JSON.stringify(item), item);
  }

  return EgressPolicyRefusalSchema.parse({
    contract_version: EGRESS_POLICY_CONTRACT_VERSION,
    refusals: [...items.values()],
  });
}

/**
 * Which tiers have a rule of every boundary class.
 *
 * Compared against `EgressIsolationTierSchema.options` rather than against the
 * descriptor's own `tier_policies`, because the descriptor's list is a field and the
 * enum is code. A tier dropped from the list, or given a disposition that excuses it
 * from carrying rules, is still a tier whose traffic nothing blocks.
 */
function egressCoveredTiers(descriptor: EgressPolicyDescriptor): Set<EgressIsolationTier> {
  const covered = new Set<EgressIsolationTier>();
  for (const tier of EgressIsolationTierSchema.options) {
    // The tier's own disposition from code, not the descriptor's: a descriptor that gave
    // the file and tool tier the connector's disposition would otherwise be counted
    // covered by an internal block while the internet stayed open to it.
    // A tier whose disposition asks for no class is never covered: no rule could show
    // that it was.
    const required = EGRESS_TIER_DISPOSITION_RULE_CLASSES[EGRESS_TIER_DISPOSITION_FOR_TIER[tier]];
    const everyClass =
      required.length > 0 &&
      required.every((ruleClass) =>
        descriptor.primary_layer.rules.some(
          (rule) => rule.rule_class === ruleClass && rule.tiers.includes(tier)
        )
      );
    if (everyClass) covered.add(tier);
  }
  return covered;
}

/**
 * What boundary a descriptor describes.
 *
 * The closed value requires three things: the posture, the primary layer's presence, and
 * an actual rule of each boundary class for every tier. Taking the posture and the
 * presence together is what makes the failure direction safe - a descriptor that never
 * passed the refinement, and disagrees with itself, reads as open rather than as closed.
 * Counting rules is what makes the closed value a statement about the machine rather
 * than about a declaration, and two reviews found independently why that matters: a
 * layer declaring `enforcing` with an empty rule list read as closed, and so did a
 * descriptor that moved one tier to `not_expressed_by_this_layer` and dropped it from
 * the rules. Both are one-word edits; neither is refused by the shape; both left a tier
 * with no boundary at all.
 *
 * A primary layer in `log_only` has its rules installed and blocks nothing, so it has a
 * state of its own rather than borrowing either the closed one or the empty one. A live
 * supplementary layer over an absent primary one is named for what it is. Neither is
 * ever `primary_enforcing`, whatever it happens to filter.
 */
export function egressBoundaryState(descriptor: EgressPolicyDescriptor): EgressBoundaryState {
  if (descriptor.posture === "enforcing" && descriptor.primary_layer.presence === "enforcing") {
    const covered = egressCoveredTiers(descriptor);
    return covered.size === EgressIsolationTierSchema.options.length
      ? "primary_enforcing"
      : "primary_rules_do_not_cover_every_tier";
  }
  if (descriptor.primary_layer.presence === "log_only") {
    return "primary_logging_only";
  }
  if (descriptor.supplementary_layer.presence === "filters_installed") {
    return "supplementary_only_not_a_boundary";
  }
  return "declared_permissive_no_rules";
}

/**
 * The loopback ports one tier may reach under a descriptor, sorted and once each.
 *
 * Every port of every reachable service whose `reachable_from` names the tier, a service
 * that requires a credential included. This is the allowlist the loopback rule blocks the
 * complement of; the plan adds the host's dynamic range to it for a tier that allows that
 * range, because the range is not a service of any descriptor.
 */
export function egressTierLoopbackPorts(
  descriptor: EgressPolicyDescriptor,
  tier: EgressIsolationTier
): number[] {
  const ports = new Set<number>();
  for (const entry of descriptor.loopback_endpoints) {
    if (!EGRESS_LOOPBACK_DISPOSITION_ALLOWS_REACH[entry.loopback_disposition]) continue;
    if (!entry.reachable_from.includes(tier)) continue;
    for (const port of entry.ports) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

/**
 * Whether egress is closed for one tier.
 *
 * The per-tier question, which is the one a caller usually has. It exists so that a
 * caller who cares about the file and tool tier is not tempted to read the descriptor's
 * whole-machine state as an answer about that tier, in either direction: a descriptor
 * that covers two tiers of three, which is M1's shape, has the machine-wide state
 * `primary_rules_do_not_cover_every_tier` while those two tiers are genuinely closed.
 */
export function egressTierBoundaryIsClosed(
  descriptor: EgressPolicyDescriptor,
  tier: EgressIsolationTier
): boolean {
  if (descriptor.posture !== "enforcing") return false;
  if (descriptor.primary_layer.presence !== "enforcing") return false;
  return egressCoveredTiers(descriptor).has(tier);
}

/** Whether a boundary state means egress is closed by policy. One value does. */
export function egressBoundaryIsClosed(state: EgressBoundaryState): boolean {
  return state === EGRESS_BOUNDARY_CLOSED_STATE;
}

/**
 * The machine itself, in both address families.
 *
 * `::ffff:127.0.0.0/104` is here because a socket that connects to
 * `::ffff:127.0.0.1` reaches loopback, and a loopback set that omitted it would put
 * that address in the outward boundary instead, where the port allowlist does not
 * apply. Whether the primary mechanism can express a v4-mapped range is a question for
 * the applier; the policy says what has to be covered.
 */
const LOOPBACK_RANGES: readonly EgressAddressRange[] = [
  addressRange("ipv4", "127.0.0.0", "127.255.255.255"),
  addressRange("ipv6", "::1", "::1"),
  addressRange("ipv6", "::ffff:127.0.0.0", "::ffff:127.255.255.255"),
];

/** Everything that is not the machine, derived so it cannot drift from the above. */
const NON_LOOPBACK_RANGES: readonly EgressAddressRange[] = ALL_FAMILIES.flatMap((family) => {
  const owned = LOOPBACK_RANGES.filter((range) => range.address_family === family)
    .map(numericRange)
    .filter((range): range is NumericRange => range !== null);
  return complementRanges(family, owned).map((range) => ({
    address_family: family,
    first: formatAddress(family, range.first),
    last: formatAddress(family, range.last),
  }));
});

/**
 * The internal networks: the non-loopback addresses the Connector's `egress_guard`
 * refuses under the Sandbox Manager's Python (3.12.14), written as ranges.
 *
 * IPv4 is the IANA special-purpose blocks that are not globally reachable, then
 * multicast and the reserved block with broadcast. IPv6 is the same, plus `fec0::/10`,
 * which Python calls global although it is only ever site-local (Windows' default IPv6 DNS
 * addresses are in it), plus the IPv6 forms that carry an internal IPv4 address:
 * v4-mapped, and the well-known NAT64 prefix with an internal or loopback address in its
 * low 32 bits, so a NAT64-only network still reaches the internet. 6to4 and Teredo are
 * refused whole, as Python refuses them. Where this and `egress_guard` differ is recorded
 * case by case in test-fixtures/egress-internal-address-cases.json.
 */
const INTERNAL_IPV4: readonly (readonly [string, string])[] = [
  ["0.0.0.0", "0.255.255.255"],
  ["10.0.0.0", "10.255.255.255"],
  ["100.64.0.0", "100.127.255.255"],
  ["169.254.0.0", "169.254.255.255"],
  ["172.16.0.0", "172.31.255.255"],
  ["192.0.0.0", "192.0.0.255"],
  ["192.0.2.0", "192.0.2.255"],
  ["192.168.0.0", "192.168.255.255"],
  ["198.18.0.0", "198.19.255.255"],
  ["198.51.100.0", "198.51.100.255"],
  ["203.0.113.0", "203.0.113.255"],
  ["224.0.0.0", "255.255.255.255"],
];
const INTERNAL_IPV6: readonly (readonly [string, string])[] = [
  ["::", "::"],
  ["64:ff9b:1::", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff"],
  ["100::", "100::ffff:ffff:ffff:ffff"],
  ["2001::", "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["2002::", "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["3fff::", "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  // Link-local, site-local and multicast, which are contiguous.
  ["fe80::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
];
const IPV4_MAPPED_PREFIX = 0xffff00000000n;
const NAT64_PREFIX = 0x0064ff9b000000000000000000000000n;

function numericPairs(
  family: EgressAddressFamily,
  pairs: readonly (readonly [string, string])[],
  offset = 0n
): NumericRange[] {
  return pairs.map(([first, last]) => {
    const range = numericRange(addressRange(family, first, last));
    if (range === null) throw new Error(`not an ${family} range: ${first} ${last}`);
    return { first: offset + range.first, last: offset + range.last };
  });
}

function mergedRanges(family: EgressAddressFamily, ranges: readonly NumericRange[]): EgressAddressRange[] {
  return complementRanges(family, complementRanges(family, ranges)).map((range) => ({
    address_family: family,
    first: formatAddress(family, range.first),
    last: formatAddress(family, range.last),
  }));
}

const INTERNAL_RANGES: readonly EgressAddressRange[] = [
  ...mergedRanges("ipv4", numericPairs("ipv4", INTERNAL_IPV4)),
  ...mergedRanges("ipv6", [
    ...numericPairs("ipv6", INTERNAL_IPV6),
    ...numericPairs("ipv4", INTERNAL_IPV4, IPV4_MAPPED_PREFIX),
    ...numericPairs("ipv4", [...INTERNAL_IPV4, ["127.0.0.0", "127.255.255.255"]], NAT64_PREFIX),
  ]),
];

export const EGRESS_ADDRESS_SETS: EgressAddressSets = {
  loopback: [...LOOPBACK_RANGES],
  non_loopback: [...NON_LOOPBACK_RANGES],
  internal: [...INTERNAL_RANGES],
};

/** The canonical spelling of an address, or null if it is not one of that family. */
export function egressCanonicalAddress(family: EgressAddressFamily, address: string): string | null {
  const value = parseAddress(family, address);
  return value === null ? null : formatAddress(family, value);
}

/**
 * Whether an address is in the internal set: the networks the network connector tier is
 * refused. The family is read off the spelling, and something that is not an address is
 * not internal.
 */
export function egressAddressIsInternal(
  address: string,
  sets: EgressAddressSets = EGRESS_ADDRESS_SETS
): boolean {
  const family: EgressAddressFamily = address.includes(":") ? "ipv6" : "ipv4";
  const value = parseAddress(family, address);
  if (value === null) return false;
  return sets.internal.some((range) => {
    if (range.address_family !== family) return false;
    const bounds = numericRange(range);
    return bounds !== null && bounds.first <= value && value <= bounds.last;
  });
}

/**
 * Which set an address falls in, or null if it is not an address of that family.
 *
 * The sets partition the family, so a well-formed address is always in exactly one, and
 * "neither" is not an answer this can give. That is the point of asking through a
 * function rather than by reading a list: whether `::ffff:127.0.0.1` is the machine is a
 * question with one answer, and it is answered the same way everywhere.
 */
export function egressAddressSet(
  family: EgressAddressFamily,
  address: string,
  sets: EgressAddressSets = EGRESS_ADDRESS_SETS
): EgressAddressSet | null {
  const value = parseAddress(family, address);
  if (value === null) return null;
  for (const setName of ["loopback", "non_loopback"] as const) {
    for (const range of sets[setName]) {
      if (range.address_family !== family) continue;
      const bounds = numericRange(range);
      if (bounds === null) continue;
      if (bounds.first <= value && value <= bounds.last) return setName;
    }
  }
  return null;
}

/**
 * Every loopback service, its ports, whether an island may reach it, and which tiers do.
 *
 * Built from `EGRESS_LOOPBACK_ENDPOINT_FACTS` rather than written out here, because a
 * disposition written in the descriptor is a disposition somebody can change in the
 * descriptor. The order is the vocabulary's enum order, so adding an endpoint puts it in
 * one place and both the table and this list follow.
 */
const LOOPBACK_ENDPOINTS: readonly EgressLoopbackEndpointPolicy[] =
  EgressLoopbackEndpointSchema.options.map((endpoint) => {
    const facts = EGRESS_LOOPBACK_ENDPOINT_FACTS[endpoint];
    return {
      endpoint,
      ports: [...facts.ports],
      plane: facts.plane,
      loopback_disposition: facts.loopback_disposition,
      reachable_from: [...facts.reachable_from],
    };
  });

/**
 * What this layer does about each tier.
 *
 * The connector tier allows the internet and blocks the internal networks; the channel
 * tier is denied everything external and reaches the internet only through the egress
 * proxy's channel port, a declared loopback endpoint. The per-hostname policy stays with
 * the Connector and the proxy.
 * No tier is allowed the dynamic port range here: the shipped descriptor is permissive and
 * installs no filter. The enforcing reference allows it to all four (`ENFORCING_TIER_POLICIES`).
 */
const TIER_POLICIES: readonly EgressTierPolicy[] = [
  {
    tier: "bootstrap",
    disposition: "deny_external_allow_declared_loopback",
    allows_host_dynamic_port_range: false,
  },
  {
    tier: "file_tool",
    disposition: "deny_external_allow_declared_loopback",
    allows_host_dynamic_port_range: false,
  },
  {
    tier: "network_connector",
    disposition: "allow_external_block_internal_allow_declared_loopback",
    allows_host_dynamic_port_range: false,
  },
  {
    tier: "channel",
    disposition: "deny_external_allow_declared_loopback",
    allows_host_dynamic_port_range: false,
  },
];

/**
 * The same four tiers with D2 on: each may connect to the host's dynamic range (CPython's
 * socketpair; see `egress-loopback-dynamic-range.ts` for the reason and the security cost).
 */
const ENFORCING_TIER_POLICIES: readonly EgressTierPolicy[] = TIER_POLICIES.map((policy) => ({
  ...policy,
  allows_host_dynamic_port_range: true,
}));

/**
 * The egress policy this build ships.
 *
 * Permissive, and it says so. Both layers are declared absent with a reason, the
 * posture is `permissive`, and `EGRESS_POLICY_VERSION_LABEL` carries the word into any
 * report that only has room for a version. It is the v2.0 release under the
 * `user_open_egress` isolation level (release decision 2026-10-20), ahead of enforcement
 * (N3): the descriptor, its version and its reporting land before enforcement does, and
 * the gap is disclosed rather than implied.
 *
 * Everything above the two layers is real policy that ships today: the address
 * partition, the endpoint dispositions, the per-tier statements and the preconditions
 * an enforcing plan will have to satisfy. Only the rules are empty.
 */
export const EGRESS_POLICY_DESCRIPTOR: EgressPolicyDescriptor = {
  contract_version: EGRESS_POLICY_CONTRACT_VERSION,
  policy_version: EGRESS_POLICY_VERSION,
  posture: EGRESS_POLICY_POSTURE,
  address_sets: EGRESS_ADDRESS_SETS,
  loopback_endpoints: [...LOOPBACK_ENDPOINTS],
  tier_policies: [...TIER_POLICIES],
  required_host_preconditions: [...EGRESS_REQUIRED_PRECONDITIONS],
  primary_layer: {
    authority: "primary",
    mechanism: "wfp",
    presence: "declared_absent",
    absence_reason: "permissive_release_ships_no_rules",
    rules: [],
  },
  supplementary_layer: {
    authority: "supplementary",
    mechanism: "wfp",
    presence: "declared_absent",
    absence_reason: "permissive_release_ships_no_rules",
    filters: [],
  },
};

/**
 * An enforcing descriptor, for checking the enforcing half of these rules.
 *
 * Not shipped, not applied, and not the artifact the planner's digest gate accepts:
 * `descriptor_not_the_shipped_policy` is what the runtime says about it, and a test
 * asserts exactly that. It exists because the descriptor this release ships is
 * permissive, so without it the rules about boundary rules would be checked against
 * nothing.
 *
 * Its loopback allowlist is the shipped endpoint table's, per tier, because a descriptor
 * has no allowlist of its own to differ in.
 *
 * Its boundary state is `primary_enforcing`: every tier carries each class its own
 * disposition asks for, the external and loopback blocks for the bootstrap, file and
 * tool and channel tiers and the internal and loopback blocks for the connector tier.
 * Without the channel tier's or the connector tier's rules it would be
 * `primary_rules_do_not_cover_every_tier`, and `egressTierBoundaryIsClosed` answers per
 * tier either way.
 */
export const EGRESS_POLICY_ENFORCING_REFERENCE: EgressPolicyDescriptor = {
  ...EGRESS_POLICY_DESCRIPTOR,
  posture: "enforcing",
  tier_policies: [...ENFORCING_TIER_POLICIES],
  primary_layer: {
    authority: "primary",
    mechanism: "wfp",
    presence: "enforcing",
    absence_reason: null,
    rules: [
      {
        rule_class: "external_outbound_block",
        action: "block",
        protocol: "any",
        address_set: "non_loopback",
        tiers: ["bootstrap", "file_tool", "channel"],
        port_match: { match_mode: "every_port" },
      },
      {
        rule_class: "loopback_non_allowlisted_block",
        action: "block",
        protocol: "any",
        address_set: "loopback",
        tiers: ["bootstrap", "file_tool", "network_connector", "channel"],
        port_match: { match_mode: "block_complement_of_allowed_ports" },
      },
      {
        rule_class: "internal_outbound_block",
        action: "block",
        protocol: "any",
        address_set: "internal",
        tiers: ["network_connector"],
        port_match: { match_mode: "every_port" },
      },
    ],
  },
  supplementary_layer: {
    authority: "supplementary",
    mechanism: "wfp",
    presence: "filters_installed",
    absence_reason: null,
    filters: [
      {
        filter_class: "icmp_connect_block",
        action: "block",
        protocols: ["icmpv4", "icmpv6"],
        blocked_ports: [],
        tiers: ["bootstrap", "file_tool", "channel"],
      },
      {
        filter_class: "icmp_resource_assignment_block",
        action: "block",
        protocols: ["icmpv4", "icmpv6"],
        blocked_ports: [],
        tiers: ["bootstrap", "file_tool", "channel"],
      },
      {
        filter_class: "name_resolution_port_block",
        action: "block",
        protocols: ["tcp", "udp"],
        blocked_ports: [53, 853],
        tiers: ["bootstrap", "file_tool", "channel"],
      },
      {
        filter_class: "file_sharing_port_block",
        action: "block",
        protocols: ["tcp", "udp"],
        blocked_ports: [139, 445],
        tiers: ["bootstrap", "file_tool", "channel"],
      },
    ],
  },
};

/** One loopback endpoint's policy, by name. */
export function egressLoopbackEndpointPolicy(
  endpoint: EgressLoopbackEndpoint,
  descriptor: EgressPolicyDescriptor = EGRESS_POLICY_DESCRIPTOR
): EgressLoopbackEndpointPolicy | undefined {
  return descriptor.loopback_endpoints.find((entry) => entry.endpoint === endpoint);
}

/** One tier's disposition under this layer. */
export function egressTierPolicy(
  tier: EgressIsolationTier,
  descriptor: EgressPolicyDescriptor = EGRESS_POLICY_DESCRIPTOR
): EgressTierPolicy | undefined {
  return descriptor.tier_policies.find((entry) => entry.tier === tier);
}
