/**
 * Egress policy vocabulary: layers, rule classes, loopback endpoints, postures,
 * refusal reasons.
 *
 * Importable from browser code. Holds no node: import.
 * Every value here is symbolic. A rule is named by what it is for, never by the port
 * or the address it happens to match, so allowing a second island service adds a
 * member to a table rather than a new rule name. This layer plans the outbound
 * boundary; the broker is the only thing that turns any of it into a Windows call.
 */
import { z } from "zod";

import { AgentRuntimeIsolationTierSchema } from "./agent-runtime-vocabulary.js";
import type { AgentRuntimeIsolationTier } from "./agent-runtime-vocabulary.js";
import {
  EGRESS_FIXED_PORT_CANDIDATES,
  EGRESS_HOST_SERVICE_PORT_CANDIDATES,
} from "./egress-loopback-ports.js";

/**
 * Isolation tiers, from the isolation baseline table.
 *
 * The same tiers the ACL policy plans against, re-exported rather than
 * restated: a tier with a filesystem policy and no outbound policy, or the other way
 * round, is a hole, and two spellings of the enum is how that happens.
 */
export const EgressIsolationTierSchema = AgentRuntimeIsolationTierSchema;
export type EgressIsolationTier = AgentRuntimeIsolationTier;

/**
 * Which mechanism carries a layer.
 *
 * `wfp` is the Windows Filtering Platform: one persistent sublayer of ours and BLOCK
 * filters in it, matched on the connecting account's SID. It is the only member. Firewall
 * COM was the primary layer before descriptor v2 and is now neither a layer, nor a
 * fallback when WFP fails, nor something a plan removes: one mechanism is one set of
 * objects and one readback (design 2026-10-01 §4.1 item 1; revised sandbox design §5.2).
 *
 * Both layers below are WFP. What separates them is `EgressLayerAuthority`, not the
 * mechanism: only the primary layer's rules decide whether egress is closed.
 */
export const EgressMechanismSchema = z.enum(["wfp"]);
export type EgressMechanism = z.infer<typeof EgressMechanismSchema>;

/**
 * Whether a layer is the outbound boundary or an extra net under it.
 *
 * Only the `primary` layer's rules decide whether egress is closed. A
 * `supplementary` layer adds depth and is allowed to be partial; nothing may read its
 * presence as coverage. The value is a literal on each layer's own field rather than
 * a shared flag, so a descriptor cannot promote the supplementary layer by changing
 * one value.
 */
export const EgressLayerAuthoritySchema = z.enum(["primary", "supplementary"]);
export type EgressLayerAuthority = z.infer<typeof EgressLayerAuthoritySchema>;

/**
 * Whether the primary layer carries rules under this policy, and what they do.
 *
 * `enforcing` blocks. `log_only` installs the same filters under the same keys with a
 * soft PERMIT instead of BLOCK, so traffic is unchanged and every hit shows in the WFP
 * audit: it is how a boundary is rehearsed before it blocks, and it is a value of the
 * shipped policy rather than a runtime switch (invariant 14). `declared_absent` carries
 * no rules.
 *
 * There is no "unknown". A layer nobody has installed yet is described by a plan and by
 * the reporting contract, not by the descriptor: the descriptor is the policy, and a
 * policy always says what it intends.
 */
export const EgressLayerPresenceSchema = z.enum(["enforcing", "log_only", "declared_absent"]);
export type EgressLayerPresence = z.infer<typeof EgressLayerPresenceSchema>;

/**
 * Whether the supplementary layer's filters are installed.
 *
 * A separate enum from the primary layer's, and deliberately without the word
 * `enforcing` in it. The two layers had one shared presence enum until a review pointed
 * out what that let a caller write: `supplementary_layer.presence === "enforcing"` is
 * true of the layer this whole design exists to say is not the boundary, so a caller
 * that iterated both layers asking "is this one enforcing" got yes for the one that
 * enforces nothing. `filters_installed` is a statement about filters, which is all this
 * layer ever has.
 */
export const EgressSupplementaryPresenceSchema = z.enum([
  "filters_installed",
  "declared_absent",
]);
export type EgressSupplementaryPresence = z.infer<typeof EgressSupplementaryPresenceSchema>;

/**
 * Why a layer deliberately carries no rules.
 *
 * A `declared_absent` layer must name one of these, and an `enforcing` layer must name
 * none. An empty rule set with no reason would be indistinguishable from a descriptor
 * somebody forgot to fill in, which is the exact confusion the permissive descriptor
 * cannot afford: it ships with both layers absent, on purpose.
 *
 * `permissive_release_ships_no_rules` is that permissive posture, where the shape, the
 * version and the reporting land before enforcement does. It is the v2.0 release posture
 * (release decision 2026-10-20: v2.0 ships at `user_open_egress`, enforcement (N3) does
 * not gate it), and the value keeps its name because it is on the wire. It is the only reason
 * left: the other one said WFP had been reviewed and not adopted, and WFP is now the
 * mechanism of both layers.
 */
export const EgressLayerAbsenceReasonSchema = z.enum(["permissive_release_ships_no_rules"]);
export type EgressLayerAbsenceReason = z.infer<typeof EgressLayerAbsenceReasonSchema>;

/**
 * How truthful the whole descriptor is about closing egress.
 *
 * `permissive` is a first-class declared value, not a degenerate case of `enforcing`.
 * It is what this repository ships until the enforcing descriptor lands (N3), the v2.0
 * release posture under the 2026-10-20 release decision, and it is carried in the version
 * label so a reader who only ever sees a version string still sees it.
 */
export const EgressPostureSchema = z.enum(["permissive", "enforcing"]);
export type EgressPosture = z.infer<typeof EgressPostureSchema>;

/**
 * What the boundary actually is, once a plan has resolved a descriptor.
 *
 * Exactly one value means egress is closed by policy, and `egressBoundaryIsClosed` is
 * the only place that decides it. The other five are the ways a boundary can be absent,
 * and they are spelled separately so a report cannot flatten them into one "not
 * enforced" that a reader skims past. None of them contains the word "enforcing", so a
 * gate that searched for it could not accept one:
 *
 * - `declared_permissive_no_rules` is the deliberate open state of the permissive
 *   descriptor: truthful, and not a v2.0 release state.
 * - `primary_rules_do_not_cover_every_tier` is a layer that declares enforcement while
 *   some isolation tier has no boundary rule. Reviews found two ways to reach it, and
 *   both used to read as closed: an `enforcing` layer carrying an empty rule list, and a
 *   tier switched to `not_expressed_by_this_layer` and dropped from the rules. Naming it
 *   is what makes the closed state a statement about rules rather than about a
 *   declaration.
 * - `primary_logging_only` is the primary layer's filters installed in `log_only`: the
 *   boundary as it will be, observed, blocking nothing.
 * - `supplementary_only_not_a_boundary` is a live supplementary layer with no primary
 *   layer. It is the fail-open shape this design refuses to call coverage.
 * - `removed_by_uninstall` is what an uninstall plan leaves behind.
 *
 * There is no `unknown`. A planner that cannot tell refuses instead.
 */
export const EgressBoundaryStateSchema = z.enum([
  "primary_enforcing",
  "declared_permissive_no_rules",
  "primary_rules_do_not_cover_every_tier",
  "primary_logging_only",
  "supplementary_only_not_a_boundary",
  "removed_by_uninstall",
]);
export type EgressBoundaryState = z.infer<typeof EgressBoundaryStateSchema>;

/**
 * The one boundary state that means egress is closed by policy.
 *
 * Reaching it takes, for every tier in `EgressIsolationTierSchema`, a rule of each
 * boundary class that tier's disposition asks for. Only the enforcing reference has that,
 * and it ships as a fixture rather than a policy, so no shipped descriptor reaches this
 * state yet. A descriptor that leaves a tier unexpressed does not reach it either: an
 * address-and-port layer that draws no boundary for a tier has not closed egress for it,
 * and the honest report of that is a state that is not this one.
 */
export const EGRESS_BOUNDARY_CLOSED_STATE = "primary_enforcing" as const;

/**
 * The named address sets a boundary rule may match on.
 *
 * `loopback` is the machine itself. `non_loopback` is everything else, and it is
 * *derived* from `loopback` rather than written out a second time, because the two
 * have to be an exact partition of both address families and a hand-written pair is
 * how a gap gets in. The implementation reviewed on 2026-09-01 writes both lists by
 * hand: its two lists overlap on `::`, and its loopback list omits IPv4-mapped
 * loopback, so `::ffff:127.0.0.1` is outside the set the port complement is applied
 * to.
 *
 * `internal` is the part of `non_loopback` that is not globally reachable: private and
 * reserved networks, link-local, multicast, and the IPv6 forms that carry one of them. It
 * is the set the Connector's own `egress_guard` refuses, so the network connector tier is
 * refused the same addresses by the connect layer and by the process.
 */
export const EgressAddressSetSchema = z.enum(["loopback", "non_loopback", "internal"]);
export type EgressAddressSet = z.infer<typeof EgressAddressSetSchema>;

/** The two address families every set has to account for. */
export const EgressAddressFamilySchema = z.enum(["ipv4", "ipv6"]);
export type EgressAddressFamily = z.infer<typeof EgressAddressFamilySchema>;

/**
 * The transport a rule matches.
 *
 * `any` is the wildcard the boundary rules use, and it is the only way to cover
 * protocols this enum does not name. A boundary that named `tcp` and `udp` and
 * stopped there would leave every other IP protocol number reachable.
 */
export const EgressProtocolSchema = z.enum(["any", "tcp", "udp", "icmpv4", "icmpv6"]);
export type EgressProtocol = z.infer<typeof EgressProtocolSchema>;

/**
 * The classes that make up the boundary. All of them block.
 *
 * `external_outbound_block` is every protocol and every port to every non-loopback
 * address; `loopback_non_allowlisted_block` is the same boundary turned inwards,
 * expressed as the complement of the ports an island is allowed to reach on the machine.
 * `internal_outbound_block` is every protocol and every port to the internal networks,
 * for the one tier whose job is to reach the internet. Which of them a tier needs is its
 * disposition's, in `EGRESS_TIER_DISPOSITION_RULE_CLASSES`.
 *
 * No boundary class allows anything. The one thing this contract does allow is the
 * upstream proxy, and that is `EgressPermitClassSchema`, a class of its own that no
 * descriptor carries and that a plan holds only when the host has an upstream proxy.
 */
export const EgressPrimaryRuleClassSchema = z.enum([
  "external_outbound_block",
  "loopback_non_allowlisted_block",
  "internal_outbound_block",
]);
export type EgressPrimaryRuleClass = z.infer<typeof EgressPrimaryRuleClassSchema>;

/**
 * The four classes the supplementary layer may carry.
 *
 * These are the BLOCK-only filters the reviewed WFP implementation actually installs,
 * named by purpose rather than by port: name resolution, file sharing, and the two ICMP
 * layers. None of them blocks egress in general, which is the whole reason the layer
 * carrying them is supplementary.
 */
export const EgressSupplementaryFilterClassSchema = z.enum([
  "icmp_connect_block",
  "icmp_resource_assignment_block",
  "name_resolution_port_block",
  "file_sharing_port_block",
]);
export type EgressSupplementaryFilterClass = z.infer<typeof EgressSupplementaryFilterClassSchema>;

/**
 * The one permit this contract has: the network connector tier's way through its own
 * internal block to the host's upstream proxy (design D4).
 *
 * It is not a layer's class. A descriptor carries policy and the upstream proxy is a host
 * fact read at provision, so a plan holds a permit only when the host has an upstream
 * proxy, and only for the addresses and the port the Sandbox Manager resolved.
 */
export const EgressPermitClassSchema = z.enum(["upstream_proxy_permit"]);
export type EgressPermitClass = z.infer<typeof EgressPermitClassSchema>;

/**
 * Every rule class either layer can carry.
 *
 * The union of the two layer enums above. It is the type of a field only where the shape
 * genuinely spans both layers: an object key, which is keyed by class either way, and a
 * removal, which names an object of either layer without carrying its content.
 *
 * A *planned* rule and a *planned* filter use their own layer's enum instead, so a
 * boundary rule cannot be given a supplementary class and a supplementary filter cannot
 * be given a boundary one. Nothing downstream of the planner checked that, and the plan
 * is the artifact an applier reads.
 *
 * The *descriptor's* two class fields stay wide on purpose, and a refinement refuses a
 * class that does not belong to its layer (`rule_class_not_valid_for_layer`). A
 * hand-written or externally supplied descriptor is exactly what that refusal exists to
 * catch, and a reason no input can reach is a reason no test can prove.
 *
 * Derived rather than restated, so a class added to a layer cannot go missing from the
 * union, and a class in the union cannot belong to no layer.
 */
export const EgressRuleClassSchema = z.enum([
  ...EgressPrimaryRuleClassSchema.options,
  ...EgressSupplementaryFilterClassSchema.options,
  ...EgressPermitClassSchema.options,
]);
export type EgressRuleClass = z.infer<typeof EgressRuleClassSchema>;

/** The classes that make up the boundary. Both, whenever the primary layer enforces. */
export const EGRESS_PRIMARY_RULE_CLASSES: readonly EgressRuleClass[] =
  EgressPrimaryRuleClassSchema.options;

/** The classes the supplementary layer may carry. All four, whenever it enforces. */
export const EGRESS_SUPPLEMENTARY_FILTER_CLASSES: readonly EgressRuleClass[] =
  EgressSupplementaryFilterClassSchema.options;

/**
 * How a rule turns ports into a match.
 *
 * `every_port` matches no port at all. `block_complement_of_allowed_ports` blocks every
 * loopback port except the ones a tier may reach, which are the ports of the services
 * whose `reachable_from` names that tier. That is the only way the loopback boundary may
 * be written: no field anywhere in this contract lists blocked loopback ports, none lists
 * allowed ones, and none switches the loopback rule off, so the only way to widen it is
 * to edit a service's facts, where the reason is written down.
 *
 * There is no mode for "these ports and no others", because a boundary rule that
 * enumerated what it blocks would be defeated by anything it forgot. The supplementary
 * layer, which does block named ports, carries its own list on its own shape and is
 * not a boundary.
 */
export const EgressPortMatchModeSchema = z.enum([
  "every_port",
  "block_complement_of_allowed_ports",
]);
export type EgressPortMatchMode = z.infer<typeof EgressPortMatchModeSchema>;

/**
 * The loopback services this policy knows about.
 *
 * Each is a name for a port, taken from the isolation baseline table and grounded in
 * this repository. Naming them is what lets a loopback allowlist refer to a service
 * and have the port looked up, so a descriptor cannot allow a bare number that
 * corresponds to nothing.
 *
 * `service_hub` is here because it is on the host control plane and is never allowlisted.
 * It used to bind a dynamic loopback port; the desktop shell now picks one of four fixed
 * candidates (`egress-loopback-ports.ts`), so a rule can name the number. Note that the baseline's island-internal
 * port list is written "if present" and includes one port this repository does not
 * name anywhere; an undeclared port falls inside the block complement, which is the
 * fail-closed direction.
 */
export const EgressLoopbackEndpointSchema = z.enum([
  "llmrouter_manager",
  "sandbox_manager",
  "security_manager_data_plane",
  "service_hub",
  "openwork_server",
  "opencode",
  "intent_classifier",
  "deep_research_sidecar",
  "opencode_router",
  "connector",
  "egress_proxy_shell",
  "egress_proxy_channel",
]);
export type EgressLoopbackEndpoint = z.infer<typeof EgressLoopbackEndpointSchema>;

/**
 * Which side of the trust line a loopback service is on.
 *
 * `host_control` is the trusted control plane an island has no business reaching.
 * `host_data` is a host service holding data an island may need, through an
 * authenticated path. `island_internal` is a service inside the island itself.
 *
 * One limit, because the word "plane" invites a bigger reading than this contract can
 * back: these are TCP and UDP endpoints. A `host_control` service reached over a named
 * pipe or an AF_UNIX socket is reached without a packet, so no firewall rule and no WFP
 * filter sees it, and this repository's broker already talks to its runner that way.
 * Confining that channel is the ACL layer's job and blocker 20's probe surface. Read
 * `host_control` plus `denied` as "no island may open a socket to it", not as "no island
 * can reach it".
 */
export const EgressEndpointPlaneSchema = z.enum([
  "host_control",
  "host_data",
  "island_internal",
]);
export type EgressEndpointPlane = z.infer<typeof EgressEndpointPlaneSchema>;

/**
 * Whether a loopback allowlist may name a service at all.
 *
 * `denied` is the control plane. `denied_pending_authenticated_exception` is a host data
 * service the isolation baseline says needs a separately recorded and authenticated
 * exception before an island touches it, for which that decision has not been made; no
 * service is in that state now. `allowlistable_with_credential` is that exception
 * recorded: a tier may reach the port, and the service serves only a caller presenting
 * the credential the Sandbox Manager hands it, so the boundary decides who may connect
 * and the credential decides who is served.
 */
export const EgressLoopbackDispositionSchema = z.enum([
  "allowlistable",
  "denied",
  "denied_pending_authenticated_exception",
  "allowlistable_with_credential",
]);
export type EgressLoopbackDisposition = z.infer<typeof EgressLoopbackDispositionSchema>;

/** Whether a disposition lets a tier reach the service at all. */
export const EGRESS_LOOPBACK_DISPOSITION_ALLOWS_REACH: {
  readonly [D in EgressLoopbackDisposition]: boolean;
} = {
  allowlistable: true,
  denied: false,
  denied_pending_authenticated_exception: false,
  allowlistable_with_credential: true,
};

/**
 * What each named loopback service *is*, as opposed to what a descriptor says about it.
 *
 * The ports it may listen on, the side of the trust line, whether an island may be
 * allowed to reach it, and which tiers may. Taken from the isolation baseline table and
 * grounded in this repository.
 *
 * `ports` is every port the service may be found on: one for a service another component
 * numbers, and the four fixed candidates for one the Sandbox Manager or the desktop shell
 * allocates (`egress-loopback-ports.ts`). No service binds a dynamic port. A rule that
 * allows a service allows all of its ports, because the allocator may bind any of them.
 *
 * `reachable_from` is the union of what each tier's processes call, read from the code
 * that makes the call: the bootstrap supervisor probes the services it starts and its
 * intent classifier calls the model router; file_tool's openwork-server proxies to the
 * router and the classifier, and its runtime tools and HDR call the Connector. It is the
 * one place a tier's loopback reach is decided.
 *
 * This table exists because of what the descriptor looked like without it. `plane` and
 * `loopback_disposition` were two free enum fields sitting next to each other on one
 * object, and the only structural protection was that a `host_control` endpoint may not
 * be `allowlistable`. So relabelling the Sandbox Manager's plane, or flipping the
 * Security Manager data plane's disposition - one word, in a data literal, with no
 * refusal - produced a valid descriptor that allowed an island to reach the host control
 * plane. A review found both. The facts are now a property of the endpoint's identity:
 * the descriptor is built from this table and refused if it disagrees, so changing what
 * an island may reach means editing the decision here, where the reason is written
 * down, and moving the content digest and the version label with it.
 *
 * The Security Manager data plane is `allowlistable_with_credential` and reachable from
 * file_tool only: the protected-file tools and openwork-server call it, and it checks the
 * bearer it issues on every call. It is the one service a tier needs a credential to
 * reach.
 *
 * The egress proxy's two ports are file_tool's only way out, since that tier is denied
 * everything external. The shell port carries the runtime, openwork-server and the agent's
 * shell. The channel port carries the router, which EG2-6 moved into the channel tier, so only the
 * channel tier reaches it; no file_tool process does.
 *
 * The channel tier reaches the proxy's channel port, the OpenCode runtime and
 * openwork-server, and nothing else: not the proxy shell port, the Sandbox Manager, the
 * router, the privacy manager or the classifier. The ports are the ones services listen on
 * today (loopback only for the LRM, the privacy manager and the classifier); the
 * Guotong loopback-only work does not move them.
 */
export const EGRESS_LOOPBACK_ENDPOINT_FACTS: {
  readonly [K in EgressLoopbackEndpoint]: {
    readonly ports: readonly number[];
    readonly plane: EgressEndpointPlane;
    readonly loopback_disposition: EgressLoopbackDisposition;
    readonly reachable_from: readonly EgressIsolationTier[];
  };
} = {
  llmrouter_manager: {
    ports: [18321],
    plane: "host_data",
    loopback_disposition: "allowlistable",
    reachable_from: ["bootstrap", "file_tool"],
  },
  sandbox_manager: {
    ports: [18821],
    plane: "host_control",
    loopback_disposition: "denied",
    reachable_from: [],
  },
  security_manager_data_plane: {
    ports: [18826],
    plane: "host_data",
    loopback_disposition: "allowlistable_with_credential",
    reachable_from: ["file_tool"],
  },
  service_hub: {
    ports: [...EGRESS_HOST_SERVICE_PORT_CANDIDATES.service_hub],
    plane: "host_control",
    loopback_disposition: "denied",
    reachable_from: [],
  },
  openwork_server: {
    ports: [8787],
    plane: "island_internal",
    loopback_disposition: "allowlistable",
    reachable_from: ["bootstrap", "file_tool", "channel"],
  },
  opencode: {
    ports: [...EGRESS_FIXED_PORT_CANDIDATES.runtime_port],
    plane: "island_internal",
    loopback_disposition: "allowlistable",
    reachable_from: ["bootstrap", "file_tool", "channel"],
  },
  intent_classifier: {
    ports: [18791],
    plane: "island_internal",
    loopback_disposition: "allowlistable",
    reachable_from: ["bootstrap", "file_tool"],
  },
  deep_research_sidecar: {
    ports: [...EGRESS_FIXED_PORT_CANDIDATES.hdr_port],
    plane: "island_internal",
    loopback_disposition: "allowlistable",
    reachable_from: ["bootstrap", "file_tool"],
  },
  opencode_router: {
    ports: [...EGRESS_FIXED_PORT_CANDIDATES.router_health_port],
    plane: "island_internal",
    loopback_disposition: "allowlistable",
    reachable_from: ["bootstrap", "file_tool"],
  },
  connector: {
    ports: [...EGRESS_FIXED_PORT_CANDIDATES.connector_port],
    plane: "island_internal",
    loopback_disposition: "allowlistable",
    reachable_from: ["file_tool"],
  },
  egress_proxy_shell: {
    ports: [...EGRESS_FIXED_PORT_CANDIDATES.egress_proxy_shell_port],
    plane: "island_internal",
    loopback_disposition: "allowlistable",
    reachable_from: ["file_tool"],
  },
  egress_proxy_channel: {
    ports: [...EGRESS_FIXED_PORT_CANDIDATES.egress_proxy_channel_port],
    plane: "island_internal",
    loopback_disposition: "allowlistable",
    reachable_from: ["channel"],
  },
};

/**
 * What this layer does about one tier's outbound traffic.
 *
 * `deny_external_allow_declared_loopback` is the file and tool tier's posture from the
 * isolation baseline. `allow_external_block_internal_allow_declared_loopback` is the
 * network connector tier's: it reaches the internet, which is its job, and is refused the
 * machine's networks. That is not an approximation of its per-hostname policy, which the
 * baseline forbids writing as a static address list - the hostnames stay with the
 * Connector and the egress proxy; this layer only takes away what no hostname should
 * resolve to. `not_expressed_by_this_layer` is a tier this layer does not cover yet. A
 * tier with that disposition carries no rules here, and a plan reports which tiers it
 * covers, so an uncovered tier cannot be read as a closed one.
 */
export const EgressTierDispositionSchema = z.enum([
  "deny_external_allow_declared_loopback",
  "not_expressed_by_this_layer",
  "allow_external_block_internal_allow_declared_loopback",
]);
export type EgressTierDisposition = z.infer<typeof EgressTierDispositionSchema>;

/**
 * The disposition each tier has when this layer covers it, or `not_expressed_by_this_layer`
 * for a tier it cannot cover at all yet.
 *
 * Code rather than a descriptor field, because the two covering dispositions ask for
 * different rules: a descriptor that gave the file and tool tier the connector's
 * disposition would let it reach the internet and still count as covered. A descriptor
 * may say `not_expressed_by_this_layer` for any tier, and otherwise only this.
 *
 * The channel tier is denied everything external; its per-SaaS-host egress goes through the
 * egress proxy's channel port, a declared loopback endpoint. A tier whose entry asks for no
 * rule class is never counted covered: nothing could show it was.
 */
export const EGRESS_TIER_DISPOSITION_FOR_TIER: {
  readonly [T in EgressIsolationTier]: EgressTierDisposition;
} = {
  bootstrap: "deny_external_allow_declared_loopback",
  file_tool: "deny_external_allow_declared_loopback",
  network_connector: "allow_external_block_internal_allow_declared_loopback",
  channel: "deny_external_allow_declared_loopback",
};

/** The boundary classes a tier with each disposition has to carry. */
export const EGRESS_TIER_DISPOSITION_RULE_CLASSES: {
  readonly [D in EgressTierDisposition]: readonly EgressPrimaryRuleClass[];
} = {
  deny_external_allow_declared_loopback: [
    "external_outbound_block",
    "loopback_non_allowlisted_block",
  ],
  not_expressed_by_this_layer: [],
  allow_external_block_internal_allow_declared_loopback: [
    "internal_outbound_block",
    "loopback_non_allowlisted_block",
  ],
};

/**
 * The host conditions that have to hold before a BLOCK-only WFP rule set means anything.
 *
 * - `base_filtering_engine_running`: BFE holds the filters. With it stopped nothing can
 *   be installed or read back.
 * - `dynamic_port_range_known`: the tiers' own dynamic port range (D2) is a host fact
 *   read at provision, never a default, so a plan cannot materialize it without one.
 * - `declared_ports_outside_dynamic_port_range`: a declared service port inside the
 *   host's dynamic range is reachable by every tier the range is allowed to, which
 *   dissolves the per-service matrix for that port.
 * - `sublayer_weight_uncontested`: another sublayer at our weight is evaluated in an
 *   undefined order relative to ours, so a hard permit in it may win.
 *
 * The planner demands evidence for all four before it will produce a plan that installs
 * rules, and the applier re-checks them. Missing evidence is a refusal, never a default.
 */
export const EgressHostPreconditionSchema = z.enum([
  "base_filtering_engine_running",
  "dynamic_port_range_known",
  "declared_ports_outside_dynamic_port_range",
  "sublayer_weight_uncontested",
]);
export type EgressHostPrecondition = z.infer<typeof EgressHostPreconditionSchema>;

/** Every precondition an enforcing plan needs satisfied. All of them, always. */
export const EGRESS_REQUIRED_PRECONDITIONS: readonly EgressHostPrecondition[] =
  EgressHostPreconditionSchema.options;

/**
 * What a plan is for.
 *
 * `repair` is separate from `install` because it is the idempotent re-run: same
 * objects, same whole desired state. It exists as its own intent so that "make it
 * right again" cannot be spelled as an uninstall followed by an install, which would
 * take the boundary down in between.
 */
export const EgressPlanIntentSchema = z.enum(["install", "repair", "uninstall"]);
export type EgressPlanIntent = z.infer<typeof EgressPlanIntentSchema>;

/**
 * Refusal reasons for an egress policy descriptor and for a planner input.
 *
 * Two halves, split by `EGRESS_PLANNER_REFUSAL_REASONS` below, following the ACL
 * policy contract: the descriptor half is checked against the descriptor this repo
 * ships, so it fires when this package is built rather than on a customer machine, and
 * the planner half is what the runtime planner itself depends on.
 */
export const EgressPolicyRefusalReasonSchema = z.enum([
  "descriptor_shape_invalid",
  "rule_action_not_block",
  "rule_protocol_does_not_cover_every_protocol",
  "layer_presence_inconsistent_with_rules",
  "layer_absence_reason_inconsistent_with_presence",
  "posture_inconsistent_with_primary_layer",
  "rule_class_not_valid_for_layer",
  "boundary_rule_class_not_covered",
  "boundary_rule_class_duplicated",
  "rule_address_set_wrong_for_rule_class",
  "port_match_mode_wrong_for_rule_class",
  "loopback_endpoint_not_covered",
  "loopback_endpoint_duplicated",
  "loopback_endpoint_port_duplicated",
  "loopback_endpoint_disposition_inconsistent_with_plane",
  "loopback_endpoint_not_the_declared_service",
  "loopback_endpoint_reachable_but_not_allowlistable",
  "tier_not_expressed_but_declares_loopback_access",
  "host_dynamic_port_range_exposes_denied_endpoint",
  "address_not_in_canonical_form",
  "address_range_not_ordered",
  "address_sets_do_not_partition_the_address_space",
  "loopback_address_set_not_loopback",
  "supplementary_layer_without_primary_boundary",
  "supplementary_filter_class_not_covered",
  "supplementary_filter_class_duplicated",
  "supplementary_filter_match_inconsistent_with_class",
  "supplementary_filter_protocol_not_covered",
  "host_precondition_not_declared",
  "tier_disposition_not_covered",
  "tier_disposition_duplicated",
  "tier_not_expressed_but_carries_rules",
  "tier_disposition_without_rules",
  "descriptor_not_the_shipped_policy",
  "owner_sid_shape_invalid",
  "tier_account_sid_shape_invalid",
  "tier_account_absent_for_tier",
  "tier_account_sid_duplicated",
  "tier_account_tier_unknown",
  "host_policy_evidence_absent",
  "host_policy_precondition_unsatisfied",
  "tier_disposition_not_the_tiers",
  "rule_class_not_for_tier_disposition",
  "internal_address_set_not_internal",
  "upstream_proxy_shape_invalid",
  "loopback_dynamic_range_unavailable",
  "loopback_dynamic_range_invalid",
  "loopback_dynamic_range_covers_control_port",
]);
export type EgressPolicyRefusalReason = z.infer<typeof EgressPolicyRefusalReasonSchema>;

/**
 * The reasons the runtime planner raises, as opposed to the ones the shipped
 * descriptor is checked against when this package is built.
 *
 * Named rather than left to a prefix convention, for the same reason the ACL contract
 * names its half: the two halves are proved by two different suites, and a reader has
 * to be able to tell which suite owes a reason its coverage. This package's golden
 * table proves the descriptor half; the Python planner's table proves this half and
 * reads this list through `EGRESS_POLICY_RULES`, so neither side restates it.
 */
export const EGRESS_PLANNER_REFUSAL_REASONS: readonly EgressPolicyRefusalReason[] = [
  "descriptor_shape_invalid",
  "descriptor_not_the_shipped_policy",
  "owner_sid_shape_invalid",
  "tier_account_sid_shape_invalid",
  "tier_account_absent_for_tier",
  "tier_account_sid_duplicated",
  "tier_account_tier_unknown",
  "host_policy_evidence_absent",
  "host_policy_precondition_unsatisfied",
  "upstream_proxy_shape_invalid",
  "loopback_dynamic_range_unavailable",
  "loopback_dynamic_range_invalid",
  "loopback_dynamic_range_covers_control_port",
];
