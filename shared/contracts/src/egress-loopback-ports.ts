/**
 * Fixed loopback port candidates: the ports the owner allocates for the roles it launches.
 *
 * Importable from browser code. Holds no node: import.
 *
 * A persistent WFP filter names a port, and a port picked at random on every start cannot be
 * named ahead of time (design 2026-10-01 §4.2 D3). So every loopback port the Sandbox Manager
 * allocates for a launch comes from a short, ordered list of candidates published here. The
 * allocator tries them in order and takes the first one it can use; when none is usable the
 * launch is refused with `EgressPortAllocationRefusal`. There is no fallback to a random port,
 * because a port nobody declared is a port no allow rule covers.
 *
 * Keyed by the broker scalar placeholder the port is bound to, which is the name the allocator
 * and the startup catalog already use for it. `supervisor_port` and `llmrouter_port` are not
 * here: openwork-server listens on the owner's configured `sandbox_port`, and ServiceHub starts
 * the LLMRouter Manager on its own fixed port, so the allocator chooses neither number.
 */
import { z } from "zod";

import { BrokerScalarPlaceholderSchema } from "./native-isolation-broker-vocabulary.js";

export const EgressLoopbackPortContractVersionSchema = z.literal(1);
export const EGRESS_LOOPBACK_PORT_CONTRACT_VERSION = 1 as const;

/** How many candidates every allocated port has. */
export const EGRESS_FIXED_PORT_CANDIDATE_COUNT = 4 as const;

/** The broker port placeholders whose number the owner allocates. */
export const EgressFixedPortPlaceholderSchema = BrokerScalarPlaceholderSchema.extract([
  "runtime_port",
  "hdr_port",
  "router_health_port",
  "connector_port",
  "egress_proxy_shell_port",
  "egress_proxy_channel_port",
]);
export type EgressFixedPortPlaceholder = z.infer<typeof EgressFixedPortPlaceholderSchema>;

/**
 * The candidates for each allocated port, in the order the allocator tries them.
 *
 * One block below the Windows default dynamic range (49152-65535), clear of every port a
 * SuperClaw service already listens on. 18856-18863 are the egress proxy's two listeners,
 * 18864-18867 are ServiceHub's, and administration ports start at 18868, so their candidates land
 * in the same block.
 */
export const EGRESS_FIXED_PORT_CANDIDATES: {
  readonly [P in EgressFixedPortPlaceholder]: readonly number[];
} = {
  runtime_port: [18840, 18841, 18842, 18843],
  hdr_port: [18844, 18845, 18846, 18847],
  router_health_port: [18848, 18849, 18850, 18851],
  connector_port: [18852, 18853, 18854, 18855],
  egress_proxy_shell_port: [18856, 18857, 18858, 18859],
  egress_proxy_channel_port: [18860, 18861, 18862, 18863],
};

/**
 * The host services, outside the sandbox, whose loopback port comes from this block too.
 *
 * ServiceHub is here because the alternative was a dynamic port, and the dynamic range is
 * what D2 allows every restricted tier to reach. It is not a broker placeholder: the desktop
 * shell starts ServiceHub, and nothing the Sandbox Manager launches is told its port.
 */
export const EgressHostServicePortSchema = z.enum(["service_hub"]);
export type EgressHostServicePort = z.infer<typeof EgressHostServicePortSchema>;

/** Each host service's candidates, in the order it tries them. */
export const EGRESS_HOST_SERVICE_PORT_CANDIDATES: {
  readonly [S in EgressHostServicePort]: readonly number[];
} = {
  service_hub: [18864, 18865, 18866, 18867],
};

/** Every port this module gives candidates for: a broker placeholder or a host service. */
export const EgressAllocatedPortSchema = z.enum([
  ...EgressFixedPortPlaceholderSchema.options,
  ...EgressHostServicePortSchema.options,
]);
export type EgressAllocatedPort = z.infer<typeof EgressAllocatedPortSchema>;
/**
 * Why one candidate could not be used.
 *
 * Each names a different remedy, which is why a refusal lists every candidate rather than the
 * last failure.
 *
 * - `in_use`: something already listens on the port, on 127.0.0.1 or on any other local
 *   address. A listener on another address does not stop a 127.0.0.1 bind, but a rule that
 *   allows the port lets a tier reach it, so it counts.
 * - `bind_access_denied`: Windows refused the bind with WSAEACCES. A host excluded port range
 *   (`netsh int ipv4 show excludedportrange protocol=tcp`) and another program's exclusive
 *   listener on 0.0.0.0 both produce it, and the bind result cannot tell them apart.
 * - `inside_dynamic_port_range`: the host's dynamic port range covers the port, so any
 *   outbound socket on the machine may take it, and once the tiers are allowed the dynamic
 *   range (D2) every one of them could reach whatever listens there.
 */
export const EgressPortCandidateUnavailableReasonSchema = z.enum([
  "in_use",
  "bind_access_denied",
  "inside_dynamic_port_range",
]);
export type EgressPortCandidateUnavailableReason = z.infer<
  typeof EgressPortCandidateUnavailableReasonSchema
>;

export const EgressPortAllocationRefusalReasonSchema = z.enum([
  "fixed_port_candidates_unavailable",
]);
export type EgressPortAllocationRefusalReason = z.infer<
  typeof EgressPortAllocationRefusalReasonSchema
>;

/** One candidate the allocator tried, and why it could not use it. */
export const EgressPortCandidateOutcomeSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    unavailable_because: EgressPortCandidateUnavailableReasonSchema,
  })
  .strict();
export type EgressPortCandidateOutcome = z.infer<typeof EgressPortCandidateOutcomeSchema>;

/**
 * The allocator's refusal when no candidate for one port is usable.
 *
 * Names every candidate, in the order tried, with why each was unusable. There is no field
 * for a port used instead, because no other port may be. placeholder is the broker
 * placeholder the Sandbox Manager was allocating, or the host service the desktop shell
 * was starting.
 */
export const EgressPortAllocationRefusalSchema = z
  .object({
    contract_version: EgressLoopbackPortContractVersionSchema,
    reason: EgressPortAllocationRefusalReasonSchema,
    placeholder: EgressAllocatedPortSchema,
    candidates: z
      .array(EgressPortCandidateOutcomeSchema)
      .length(EGRESS_FIXED_PORT_CANDIDATE_COUNT),
  })
  .strict();
export type EgressPortAllocationRefusal = z.infer<typeof EgressPortAllocationRefusalSchema>;
