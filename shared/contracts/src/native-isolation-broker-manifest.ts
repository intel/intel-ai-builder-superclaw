/**
 * Signed startup catalog: fixed executable roles, digests, and allowed placeholders.
 *
 * Declares what the broker may launch after verifying an installed payload roster.
 * Callers supply only manifest version, digest, role, and typed placeholder bindings.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import { ACL_POLICY_VERSION } from "./acl-policy-descriptor.js";
import { Sha256Schema } from "./capability/common.js";
import {
  BROKER_LAUNCH_ROLE_TIER,
  BrokerIdentityIdSchema,
  BrokerLaunchRoleSchema,
  BrokerPathPlaceholderSchema,
  BrokerPolicyIdSchema,
  BrokerScalarPlaceholderSchema,
  NativeIsolationBrokerContractVersionSchema,
  NATIVE_ISOLATION_BROKER_CONTRACT_VERSION,
} from "./native-isolation-broker-vocabulary.js";
import type { BrokerLaunchRole } from "./native-isolation-broker-vocabulary.js";

export {
  BROKER_LAUNCH_ROLE_TIER,
  BrokerLaunchRoleSchema,
  BrokerPathPlaceholderSchema,
  BrokerScalarPlaceholderSchema,
  NativeIsolationBrokerContractVersionSchema,
  NATIVE_ISOLATION_BROKER_CONTRACT_VERSION,
};

export const BrokerStartupCatalogEntrySchema = z
  .object({
    launch_role: BrokerLaunchRoleSchema,
    executable_sha256: Sha256Schema,
    identity_id: BrokerIdentityIdSchema,
    policy_id: BrokerPolicyIdSchema,
    path_placeholders: z.array(BrokerPathPlaceholderSchema),
    scalar_placeholders: z.array(BrokerScalarPlaceholderSchema),
  })
  .strict();
export type BrokerStartupCatalogEntry = z.infer<typeof BrokerStartupCatalogEntrySchema>;

export const BrokerStartupCatalogSchema = z
  .object({
    contract_version: NativeIsolationBrokerContractVersionSchema,
    manifest_version: z.number().int().min(1),
    entries: z.array(BrokerStartupCatalogEntrySchema).min(1),
  })
  .strict();
export type BrokerStartupCatalog = z.infer<typeof BrokerStartupCatalogSchema>;

/** Catalog version shipped with this contract build. */
export const BROKER_STARTUP_MANIFEST_VERSION = 1 as const;

/** The scalar placeholders whose bound value is bounded text rather than a loopback port. */
const BROKER_TEXT_SCALARS = [
  "loopback_host",
  "host_token",
  "host_token_sha256",
  "openwork_token",
  "router_control_token",
  "router_scoped_token",
  "lrm_api_key",
  "privacy_api_key",
  "runtime_password",
  "intent_classifier_token",
  "runtime_deployment_b64",
  "runtime_desired_fingerprint",
  "runtime_instance_id",
  "runtime_launch_attempt_id",
  "hdr_api_token",
  "hdr_ready_token",
  "hdr_enabled",
  "local_proxy_url",
  "local_proxy_bypass",
] as const;

/**
 * The text scalars whose value is a secret the owner minted, checked for length and nothing else.
 *
 * A loopback host can be compared against the one address it is allowed to be; a token cannot, because
 * the whole point of it is that only the owner knows the value. So the check is the only thing a
 * validator can honestly assert about it - that it is present and of a plausible length - and the name
 * says so, rather than letting a reader assume the value was validated the way `loopback_host` is.
 *
 * Being on this list is also what obliges every carrier to redact it: it must not reach a refusal
 * message, a `Debug` rendering, a log line, or a command line. It travels bound in the request and it
 * leaves as one declared environment variable.
 */
const BROKER_OPAQUE_SCALARS = [
  "host_token",
  "openwork_token",
  "router_control_token",
  "router_scoped_token",
  "lrm_api_key",
  "privacy_api_key",
  "runtime_password",
  "intent_classifier_token",
  "hdr_api_token",
  "hdr_ready_token",
] as const;

/**
 * How a bound scalar is range-checked, published so that every language reads one copy.
 *
 * The port classification is the enum minus the text names rather than a second list, so a scalar
 * added to the vocabulary is a port until someone says otherwise, and a validator that recognizes
 * neither list refuses instead of accepting an unclassified value.
 *
 * The bound itself lives here rather than in each validator because there are three of them: the
 * contract wire check, the broker, and the Sandbox Manager's fixture leg. A number restated three
 * times is three numbers that agree until one is edited.
 */
export const BROKER_SCALAR_RULES = {
  text_placeholders: [...BROKER_TEXT_SCALARS] as readonly string[],
  opaque_placeholders: [...BROKER_OPAQUE_SCALARS] as readonly string[],
  opaque_min_chars: 32,
  opaque_max_chars: 256,
  port_placeholders: BrokerScalarPlaceholderSchema.options.filter(
    (option) => !BROKER_TEXT_SCALARS.includes(option as (typeof BROKER_TEXT_SCALARS)[number])
  ) as readonly string[],
  port_min: 1024,
  port_max: 65535,
} as const;

/**
 * The name a tier runner may give the log it opens for a role, published so both sides agree.
 *
 * The runner derives the name from the random pipe identifier its own launch already has, and the
 * owner-side retention helper has to recognize exactly the names the runner can produce - it deletes
 * files, so a grammar that is one character looser on the Python side than on the Rust side would be
 * a helper that removes something a launcher never wrote. Publishing the two values is what keeps the
 * two spellings from drifting; each side still builds its own check from them, because a shared regular
 * expression would need a regex engine in the broker and there is nothing else that needs one there.
 *
 * `launch_id_hex_chars` is the hex length of a pipe identifier, which the broker asserts against its
 * own `PIPE_ID_BYTES` rather than trusting this number.
 */
export const BROKER_ROLE_LOG_RULES = {
  launch_id_hex_chars: 32,
  extension: ".log",
} as const;

/**
 * The digest a production entry carries while no authoritative release digest exists.
 *
 * One shared sentinel rather than a distinct invented hash per role, and deliberately not a value
 * any file can have: sixty-four zeros is greppable, and it makes "this build has no release digest
 * for any production role" a single fact instead of three fake-looking hashes a reader has to
 * recognize. Replacing it is the G5 gate - a signed installed payload is what produces a real
 * digest, and until then no code here may claim the payload was measured.
 */
export const BROKER_UNRELEASED_EXECUTABLE_DIGEST = "0".repeat(64);

/**
 * The digest of the broker's own test-boundary child.
 *
 * Distinct from the unreleased sentinel because this one is asserted rather than pending: the
 * broker pins the same constant (`catalog_start.rs::TEST_BROKER_EXE_DIGEST`) and refuses the role
 * if the catalog disagrees.
 */
export const BROKER_TEST_CHILD_EXECUTABLE_DIGEST =
  "0000000000000000000000000000000000000000000000000000000000000001";

/**
 * The policy bundle a launch role must have converged before start.
 *
 * Derived from `ACL_POLICY_VERSION` rather than written out, so an ACL policy bump cannot leave a
 * catalog entry claiming a bundle this build no longer ships. It costs a catalog digest re-pin on
 * every ACL bump, which is the point: the two versions are one decision.
 */
const SHIPPED_POLICY_ID = `acl:v${ACL_POLICY_VERSION}`;

/**
 * The closed startup catalog: every role the broker may be asked to launch.
 *
 * Placeholders only. No entry names a program, an argument, a shell or an environment map - the
 * broker assembles all four from the bindings a request supplies
 * (`host/native_isolation_broker/src/catalog_start.rs`), so a caller can choose *which* role starts
 * and *where* its roots are, and nothing else.
 *
 * Every role declares `state_logs_root`, because every launched role gets a log the tier runner
 * opens for it inside that root's own tier subtree.
 *
 * Every role also declares `isolation_root`, and it is bound for the check rather than for the launch:
 * the launcher reads back the DACL of every root a request binds before it starts anything
 * (`launcher/drift.rs`), and `isolation_root` holds the authorization and revocation records, so a role
 * that did not bind it would start without that root ever being checked for drift. It is also what makes
 * the `path_placeholder_escape` check meaningful, since that check needs `payload_root` and
 * `isolation_root` together. No argument or variable consumes it, which is exactly why the rule that
 * every declared *scalar* must be consumed does not extend to paths.
 *
 * Every production role also declares `state_temp_root`, and for a reason worth stating: a launch into a
 * tier account carries no `TEMP` of its own. The owner's would describe the owner and point at a
 * directory the tier cannot open, so `launch_environment` drops it, and Windows supplies no replacement
 * because no profile is loaded for a tier account. A role with no writable temporary directory fails in
 * ways that read like anything but a missing declaration, so each role declares the root its scratch
 * location comes from.
 *
 * One descriptor role is deliberately absent. `shell_executable` is started by the runtime as its own
 * child rather than by the broker, so giving it an entry would declare a launch path that does not
 * exist.
 *
 * `token_service_executable` and `connector_executable` used to be absent for the same reason, and are
 * here now because the reason stopped being true: both open the workspace, so a supervisor that spawned
 * them was doing file_tool work inside the bootstrap tier. They are launched by the broker into
 * file_tool instead, and the supervisor connects to them - see the `--external-*` switches in its
 * assembled argv.
 */
export const BROKER_STARTUP_CATALOG: BrokerStartupCatalog = {
  contract_version: NATIVE_ISOLATION_BROKER_CONTRACT_VERSION,
  manifest_version: BROKER_STARTUP_MANIFEST_VERSION,
  entries: [
    {
      launch_role: "test_fixed_sleep_child",
      executable_sha256: BROKER_TEST_CHILD_EXECUTABLE_DIGEST,
      identity_id: "ibid:tier_bootstrap",
      policy_id: SHIPPED_POLICY_ID,
      path_placeholders: ["payload_root", "state_logs_root", "isolation_root"],
      scalar_placeholders: [],
    },
    {
      // openwork.exe. Binds the workspace it serves, the config and data trees it owns, and both
      // loopback ports, because it is the process that starts the runtime and has to be told where
      // the runtime will listen.
      launch_role: "supervisor_executable",
      executable_sha256: BROKER_UNRELEASED_EXECUTABLE_DIGEST,
      identity_id: "ibid:tier_bootstrap",
      policy_id: SHIPPED_POLICY_ID,
      path_placeholders: [
        "payload_root",
        "workspace_root",
        "state_config_root",
        "state_data_root",
        "state_logs_root",
        "state_temp_root",
        "isolation_root",
      ],
      // `payload_version` is deliberately not here, and is no longer in the scalar vocabulary either.
      // The version is already a component of `payload_root` (`<backend_root>\payload\<version>`, see
      // `host/sandbox_manager/src/sandbox_manager/native_isolation/paths.py`), so binding it a second
      // time would be one fact in two places that can disagree, and nothing in the assembled launch
      // consumes it.
      // Both tokens are bound here as well as on `token_service_executable`, and that is the point of
      // binding them at all: the supervisor is the caller and openwork-server is the callee, so a value
      // either of them minted for itself would be a value the other does not know. `runtime_password`
      // because this process probes and pre-warms the runtime, which requires HTTP Basic auth, and
      // `intent_classifier_token` because it passes it to the classifier child it spawns.
      scalar_placeholders: [
        "loopback_host",
        "supervisor_port",
        "runtime_port",
        "router_health_port",
        "host_token",
        "openwork_token",
        "runtime_password",
        "intent_classifier_token",
        "hdr_enabled",
        "hdr_port",
        "hdr_ready_token",
        "runtime_deployment_b64",
        "runtime_desired_fingerprint",
        "runtime_instance_id",
        "runtime_launch_attempt_id",
        "llmrouter_port",
        "lrm_api_key",
      ],
    },
    {
      // openwork-server.exe, under its historical role name. Binds the workspace because it reads and
      // writes real project content, and both ports it has to agree with someone else about: its own,
      // which the supervisor connects to, and the router's health port, which it is told so it can
      // report on it.
      launch_role: "token_service_executable",
      executable_sha256: BROKER_UNRELEASED_EXECUTABLE_DIGEST,
      identity_id: "ibid:tier_file_tool",
      policy_id: SHIPPED_POLICY_ID,
      path_placeholders: [
        "payload_root",
        "workspace_root",
        "state_config_root",
        "state_data_root",
        "state_logs_root",
        "state_temp_root",
        "isolation_root",
      ],
      // Both tokens, because this is the process that checks them: the supervisor is given the same two
      // values so that the two ends of a loopback call agree. The host token only as its hash, which is
      // all a check needs (#3498). The router's control token too, because
      // this process proxies the channel settings routes to the router, and the runtime password,
      // because it proxies to the runtime, and `intent_classifier_token` because it proxies `/intent/*`
      // to the classifier. `privacy_api_key` is used by the display-only protected-file restore adapter.
      scalar_placeholders: [
        "loopback_host",
        "supervisor_port",
        "runtime_port",
        "router_health_port",
        "host_token_sha256",
        "openwork_token",
        // The scoped one: openwork-server proxies status reads and the scheduler's notification, and
        // can neither write a binding nor send to a new conversation unapproved (EG2-7).
        "router_scoped_token",
        "runtime_password",
        "intent_classifier_token",
        "privacy_api_key",
        // Same file_tool identity as Runtime; progress/Stop use the research API, never readiness auth.
        "hdr_enabled",
        "hdr_port",
        "hdr_api_token",
        // Names the published generation's opencode directory, which this process reads (never writes)
        // to list the Profile's tools and skills for the custom-agent creator (#2985). Runtime is
        // given the same value, so both read one generation.
        "runtime_instance_id",
        // The egress proxy's shell listener, as Runtime gets it: GitHub login, the skill hub and the
        // Telegram token check leave this tier through it.
        "local_proxy_url",
        "local_proxy_bypass",
      ],
    },
    {
      // opencode-router.exe, under its historical role name, in the channel tier. The workspace is bound
      // as text only: it is the OpenCode directory the router names to the runtime, never a path it opens.
      // The router's own working directory, inbox and configuration all live under its tier directories,
      // so it binds the config root too, for the agent definition the host copies there.
      launch_role: "connector_executable",
      executable_sha256: BROKER_UNRELEASED_EXECUTABLE_DIGEST,
      identity_id: "ibid:tier_channel",
      policy_id: SHIPPED_POLICY_ID,
      path_placeholders: [
        "payload_root",
        "workspace_root",
        "state_config_root",
        "state_data_root",
        "state_logs_root",
        "state_temp_root",
        "isolation_root",
      ],
      // The router refuses to start its health server without a control token. `/health` itself stays
      // unauthenticated; the token guards the control routes. Its channel secrets still come from its
      // own configuration file, not from whoever launched it. `runtime_password` because its SDK client
      // calls the runtime, which requires HTTP Basic auth, and `intent_classifier_token` because the
      // channels bridge posts to `/classify`. The egress proxy's channel listener: Slack credential
      // verification and Socket Mode reach slack.com through it, and through it the corporate
      // upstream proxy when the host has one.
      scalar_placeholders: [
        "loopback_host",
        "runtime_port",
        "router_health_port",
        "router_control_token",
        "router_scoped_token",
        "runtime_password",
        "intent_classifier_token",
        "local_proxy_url",
        "local_proxy_bypass",
      ],
    },
    {
      // opencode.exe. Reads config the bootstrap tier wrote and writes its own state under the data
      // root, which is why it binds both rather than config alone.
      launch_role: "runtime_executable",
      executable_sha256: BROKER_UNRELEASED_EXECUTABLE_DIGEST,
      identity_id: "ibid:tier_file_tool",
      policy_id: SHIPPED_POLICY_ID,
      path_placeholders: [
        "payload_root",
        "workspace_root",
        "state_config_root",
        "state_data_root",
        "state_logs_root",
        "state_temp_root",
        "isolation_root",
      ],
      // `llmrouter_port` because this role's Product Profile names the model endpoint as
      // `{env:LRM_API_BASE_URL}/v1`, and a cross-account launch carries only the variables declared
      // for it: undeclared, the template expands to an empty host and every model call fails on a
      // relative URL. `lrm_api_key` because the Manager authenticates every `/v1/*` call, and
      // `privacy_api_key` because the Privacy Manager authenticates protected-file preflight and
      // processing requests. `runtime_password` because this process requires it as HTTP Basic auth.
      scalar_placeholders: [
        "loopback_host",
        "runtime_port",
        "runtime_instance_id",
        "llmrouter_port",
        "lrm_api_key",
        "privacy_api_key",
        "runtime_password",
        // The router's port and scoped token, so the agent's send and status tools work from this tier
        // (EG2-7). Never the control token.
        "router_health_port",
        "router_scoped_token",
        "hdr_enabled",
        "hdr_port",
        "hdr_api_token",
        "local_proxy_url",
        "local_proxy_bypass",
        // openwork-server's port, as OPENWORK_HOST_PORT: the Gmail tools build their OAuth
        // callback on it (EG1-8), and the LLM logger plugin reports to it. Undeclared, both
        // assume 8787 whatever `sandbox_port` the host configured.
        "supervisor_port",
      ],
    },
    {
      // The network Connector's service process. Its provider configuration is owner-written under
      // the Connector's read-only config subtree; runtime state remains under its writable data root.
      launch_role: "connector_service",
      executable_sha256: BROKER_UNRELEASED_EXECUTABLE_DIGEST,
      identity_id: "ibid:tier_network_connector",
      policy_id: SHIPPED_POLICY_ID,
      path_placeholders: [
        "payload_root",
        "state_config_root",
        "state_data_root",
        "state_logs_root",
        "state_temp_root",
        "isolation_root",
      ],
      scalar_placeholders: ["loopback_host", "connector_port"],
    },
    {
      // The egress proxy, the network connector tier's second process, beside the Connector rather than
      // inside it. The same roots as the Connector service and no workspace; one port per caller class.
      launch_role: "egress_proxy",
      executable_sha256: BROKER_UNRELEASED_EXECUTABLE_DIGEST,
      identity_id: "ibid:tier_network_connector",
      policy_id: SHIPPED_POLICY_ID,
      path_placeholders: [
        "payload_root",
        "state_config_root",
        "state_data_root",
        "state_logs_root",
        "state_temp_root",
        "isolation_root",
      ],
      scalar_placeholders: ["loopback_host", "egress_proxy_shell_port", "egress_proxy_channel_port"],
    },
    {
      // Hybrid Deep Research sidecar. Sandbox Manager launches this role for `pro` since #2662.
      // It belongs to file_tool because it reads authorized workspace files and writes research state,
      // while Web Search remains a separate network_connector operation. The bound `workspace_root`
      // reaches it only as `HYBRID_DR_WORKSPACE_ROOT`, the one root it authorizes `data_paths` under.
      launch_role: "hdr_sidecar",
      executable_sha256: BROKER_UNRELEASED_EXECUTABLE_DIGEST,
      identity_id: "ibid:tier_file_tool",
      policy_id: SHIPPED_POLICY_ID,
      path_placeholders: [
        "payload_root",
        "workspace_root",
        "state_config_root",
        "state_data_root",
        "state_logs_root",
        "state_temp_root",
        "isolation_root",
      ],
      scalar_placeholders: [
        "loopback_host",
        "hdr_port",
        "llmrouter_port",
        "hdr_api_token",
        "lrm_api_key",
        "hdr_ready_token",
      ],
    },
  ],
};

BrokerStartupCatalogSchema.parse(BROKER_STARTUP_CATALOG);

export function catalogEntryForRole(role: BrokerLaunchRole): BrokerStartupCatalogEntry | undefined {
  return BROKER_STARTUP_CATALOG.entries.find((entry) => entry.launch_role === role);
}

/** Canonical JSON for digesting the catalog the same way in TypeScript, Python, and Rust tests. */
export function canonicalBrokerStartupCatalogJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalBrokerStartupCatalogJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalBrokerStartupCatalogJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function brokerStartupCatalogDigest(catalog: BrokerStartupCatalog): string {
  return createHash("sha256")
    .update(canonicalBrokerStartupCatalogJson(catalog))
    .digest("hex");
}

export const BROKER_STARTUP_CATALOG_DIGEST = brokerStartupCatalogDigest(BROKER_STARTUP_CATALOG);
