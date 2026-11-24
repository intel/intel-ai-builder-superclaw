/**
 * The egress surface inventory (network egress design 2026-10-01, section 6.1).
 *
 * Every place the product opens a network connection from code it ships or keeps, one
 * entry per surface: the process that makes the call, where the call goes, and what
 * happens to that traffic at M1 and at GA. `scripts/ci/check_egress_surfaces.mjs` holds
 * the repository to it: a call site carries `egress-surface: <id>` within three lines
 * above it, the id has to be here, and an entry whose `source` is `repo` has to have a
 * call site.
 *
 * The inventory is where C3's loopback port matrix comes from. A tier that C3 lets
 * reach a service is a tier some surface here calls it from, and a surface that calls a
 * service C3 does not let its tier reach says so as `loopback_blocked`.
 *
 * The entries live in `egress-surface-inventory-entries.ts`. The CI check reads
 * `generated/data/egress-surface-inventory.json`, written by scripts/gen.mjs, which also
 * generates JSON Schema and Pydantic for one entry.
 */

import { z } from "zod";

import { EgressLoopbackEndpointSchema } from "./egress-policy-vocabulary.js";
import type { EgressIsolationTier } from "./egress-policy-vocabulary.js";
import { BROKER_LAUNCH_ROLE_TIER } from "./native-isolation-broker-vocabulary.js";
import type { BrokerLaunchRole } from "./native-isolation-broker-vocabulary.js";

export const EgressSurfaceInventoryContractVersionSchema = z.literal(1);
export const EGRESS_SURFACE_INVENTORY_CONTRACT_VERSION = 1 as const;

/** What a call site carries, followed by the surface id, within three lines above it. */
export const EGRESS_SURFACE_COMMENT_MARKER = "egress-surface:" as const;

export const EgressSurfaceIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);

/**
 * The process a surface's call runs in.
 *
 * - `supervisor`: `sandbox/orchestrator`.
 * - `intent_classifier`: `sandbox/intent_classifier`, which the supervisor starts.
 * - `openwork_server`: `sandbox/server`.
 * - `opencode_runtime`: OpenCode, its plugins and tools, and the processes those tools
 *   start.
 * - `opencode_router`: `sandbox/channels`.
 * - `hdr_sidecar`: the Hybrid Deep Research sidecar.
 * - `agent_shell`: commands the agent runs in its shell.
 * - `owner_browser`: pages openwork-server serves to the owner's browser.
 * - `developer_script`: scripts a developer runs by hand.
 * - `host_mcp_server`: the stdio MCP servers the host MCP gateway runs, as the signed-in user.
 * - `host_browser`: the host MCP gateway's dedicated Edge, as the signed-in user.
 */
export const EgressSurfaceProcessSchema = z.enum([
  "supervisor",
  "intent_classifier",
  "openwork_server",
  "opencode_runtime",
  "opencode_router",
  "hdr_sidecar",
  "agent_shell",
  "owner_browser",
  "developer_script",
  "host_mcp_server",
  "host_browser",
]);
export type EgressSurfaceProcess = z.infer<typeof EgressSurfaceProcessSchema>;

/**
 * The launch role whose process tree each process runs in, and so its tier.
 *
 * Null for a process no tier account runs, which no tier's rules apply to. A tier is not
 * written on an entry: it is this table read through `BROKER_LAUNCH_ROLE_TIER`, so an
 * entry cannot name a tier its process does not run under.
 */
export const EGRESS_SURFACE_PROCESS_LAUNCH_ROLE: {
  readonly [P in EgressSurfaceProcess]: BrokerLaunchRole | null;
} = {
  supervisor: "supervisor_executable",
  intent_classifier: "supervisor_executable",
  openwork_server: "token_service_executable",
  opencode_runtime: "runtime_executable",
  opencode_router: "connector_executable",
  hdr_sidecar: "hdr_sidecar",
  agent_shell: "shell_executable",
  owner_browser: null,
  developer_script: null,
  host_mcp_server: null,
  host_browser: null,
};

/** The code area that owns a surface's call sites. */
export const EgressSurfaceOwnerSchema = z.enum([
  "orchestrator",
  "openwork_server",
  "channels",
  "agent_config",
  "intent_classifier",
  "hdr_sidecar",
  "agent_runtime_upstream",
  "mcp_host_manager",
]);
export type EgressSurfaceOwner = z.infer<typeof EgressSurfaceOwnerSchema>;

/**
 * Where the call is made.
 *
 * - `repo`: in this repository's code. The CI check requires a call site carrying the id.
 * - `upstream_opencode`: inside OpenCode, which no scanner sees. Registered by hand and
 *   re-checked on every OpenCode upgrade.
 * - `agent_command`: by a command the agent runs. No code makes the call, so it is
 *   registered by hand too.
 * - `user_configured`: by a command the user registered to run on the host. No code makes
 *   the call, so it is registered by hand too.
 */
export const EgressSurfaceSourceSchema = z.enum([
  "repo",
  "upstream_opencode",
  "agent_command",
  "user_configured",
]);
export type EgressSurfaceSource = z.infer<typeof EgressSurfaceSourceSchema>;

/** A DNS name, with a leading `*.` for any subdomain. No scheme, port or path. */
export const EgressSurfaceHostSchema = z
  .string()
  .regex(/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

/**
 * The external hosts a surface reaches.
 *
 * A list when the code names them. `caller_chosen` when the host comes from the caller or
 * from configuration. `dependency_defined` when OpenCode or a library picks it, which is
 * re-checked whenever that dependency is upgraded.
 */
export const EgressSurfaceHostsSchema = z.union([
  z.array(EgressSurfaceHostSchema).min(1),
  z.literal("caller_chosen"),
  z.literal("dependency_defined"),
]);

/**
 * The local services a loopback surface reaches: C3's loopback endpoints, and four it does
 * not name.
 *
 * `supervisor_control` is the supervisor's control server, which binds a dynamic port.
 * `channel_secret_adapter` is the Sandbox Manager's channel secret API on 18828. Only the
 * container path hands either address to a caller, so neither is reached natively today;
 * reaching one natively would need it in C3 first.
 * `mcp_host_manager` is the host MCP gateway on 18831. It is reached natively, and it is not
 * in C3's loopback table yet, so N3 must add it before enforcement.
 * `local_mcp_server` is an MCP server the owner runs on a loopback port they choose.
 */
export const EgressSurfaceLocalServiceSchema = z.enum([
  ...EgressLoopbackEndpointSchema.options,
  "supervisor_control",
  "channel_secret_adapter",
  "mcp_host_manager",
  "local_mcp_server",
]);
export type EgressSurfaceLocalService = z.infer<typeof EgressSurfaceLocalServiceSchema>;

/**
 * What happens to a surface's traffic at a milestone.
 *
 * - `via_connector`: it goes through a Connector operation.
 * - `via_egress_proxy`: it goes through the egress proxy's shell or channel port.
 * - `via_mcp_gateway`: it goes through the local MCP gateway and `mcp_call`.
 * - `denied_by_profile`: it is off in every Profile, because the tool is denied or the
 *   feature is not configured.
 * - `disabled_by_environment`: an environment variable the runtime starts with turns it
 *   off.
 * - `removed`: the call is taken out of the code.
 * - `fails_with_reason`: it is blocked, and the feature says why.
 * - `loopback_allowed`: C3 lets the surface's tier reach the service.
 * - `loopback_blocked`: C3 does not, and the entry is here so the consequence is visible.
 * - `not_on_native_path`: the native path does not make the call, because the call is
 *   container or development only, or because the payload supplies what it would fetch.
 * - `outside_the_island`: no tier account runs the process.
 */
export const EgressSurfaceDispositionSchema = z.enum([
  "via_connector",
  "via_egress_proxy",
  "via_mcp_gateway",
  "denied_by_profile",
  "disabled_by_environment",
  "removed",
  "fails_with_reason",
  "loopback_allowed",
  "loopback_blocked",
  "not_on_native_path",
  "outside_the_island",
]);
export type EgressSurfaceDisposition = z.infer<typeof EgressSurfaceDispositionSchema>;

const EGRESS_SURFACE_COMMON_FIELDS = {
  id: EgressSurfaceIdSchema,
  process: EgressSurfaceProcessSchema,
  owner: EgressSurfaceOwnerSchema,
  source: EgressSurfaceSourceSchema,
  purpose: z.string().min(1),
  /** At M1: direct egress closed for bootstrap and file_tool. */
  m1: EgressSurfaceDispositionSchema,
  /** At GA: every tier's egress closed. */
  ga: EgressSurfaceDispositionSchema,
};

/** A surface that leaves the machine. */
export const EgressExternalSurfaceSchema = z
  .object({
    ...EGRESS_SURFACE_COMMON_FIELDS,
    kind: z.literal("external"),
    hosts: EgressSurfaceHostsSchema,
  })
  .strict();

/** A surface that reaches a service on this machine. */
export const EgressLoopbackSurfaceSchema = z
  .object({
    ...EGRESS_SURFACE_COMMON_FIELDS,
    kind: z.literal("loopback"),
    service: EgressSurfaceLocalServiceSchema,
  })
  .strict();

export const EgressSurfaceSchema = z.discriminatedUnion("kind", [
  EgressExternalSurfaceSchema,
  EgressLoopbackSurfaceSchema,
]);
export type EgressSurface = z.infer<typeof EgressSurfaceSchema>;

export const EgressSurfaceInventorySchema = z
  .array(EgressSurfaceSchema)
  .superRefine((entries, context) => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      if (seen.has(entry.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `surface ${entry.id} is registered twice`,
        });
      }
      seen.add(entry.id);
    });
  });

/** The tier a surface's call runs under, or null when no tier account runs its process. */
export function egressSurfaceTier(surface: EgressSurface): EgressIsolationTier | null {
  const role = EGRESS_SURFACE_PROCESS_LAUNCH_ROLE[surface.process];
  return role === null ? null : BROKER_LAUNCH_ROLE_TIER[role];
}

export { EGRESS_SURFACE_INVENTORY } from "./egress-surface-inventory-entries.js";
