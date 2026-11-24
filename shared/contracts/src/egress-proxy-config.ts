/**
 * The egress proxy's sealed configuration (EG2-4a): what the Sandbox Manager writes to
 * `egress-proxy.json` and the proxy reads at start. Contract: `Sandbox` / `OperationRun` egress wiring.
 *
 * `mode` is `log_only` (the shipped default: everything reachable is tunnelled or forwarded and audited,
 * and `enforce_would_refuse` records what enforce would refuse) or `enforce` (only the listener's
 * allowlist is admitted; the rest is refused with a 403). Nothing user-facing turns enforce on yet.
 *
 * `allowlist` is the EG2-3 allowlist (`egress-allowlist.ts`) resolved per proxy listener: the entries
 * of the carrier that listener serves (`egress_proxy_shell` -> `shell`, `egress_proxy_channel` ->
 * `channel`). The proxy never imports the allowlist contract; it reads exactly this. Categories
 * (caller-chosen traffic) carry no hosts and are not part of it: what the proxy does with an unlisted
 * destination is the mode's; on the shell listener, in enforce, a public one is held for the user's approval
 * (EG2-4b, `egress-proxy-approval.ts`, configured by `approval` and `session_key` below). `null` means no allowlist was
 * sealed, which `enforce` refuses to start with.
 *
 * `audit`, `upstream`, `upstream_unsupported` and `pac` are the EG2-2 fields, unchanged. `upstream` and
 * `pac.auto_config_url` can carry a credential or name an internal host: they live in this sealed file
 * only.
 */

import { z } from "zod";

import {
  EGRESS_ALLOWLIST_TIER_CARRIER,
  EgressAllowlistHostSchema,
  EgressAllowlistPortSchema,
  type EgressAllowlist,
} from "./egress-allowlist.js";
import { EgressUpstreamUnsupportedKindSchema } from "./isolation-reporting.js";
import { Base64Url32Schema, ConnectorApprovalProviderConfigSchema as EgressProxyApprovalConfigSchema } from "./egress-approval-grant.js";

export const EGRESS_PROXY_MODES = ["log_only", "enforce"] as const;
export const EgressProxyModeSchema = z.enum(EGRESS_PROXY_MODES);
export type EgressProxyMode = z.infer<typeof EgressProxyModeSchema>;
/** What the Sandbox Manager seals unless a test turns enforce on. */
export const EGRESS_PROXY_DEFAULT_MODE: EgressProxyMode = "log_only";

export const EGRESS_PROXY_LISTENERS = ["shell", "channel"] as const;
export type EgressProxyListener = (typeof EGRESS_PROXY_LISTENERS)[number];

/** The allowlist carrier each proxy listener serves. */
export const EGRESS_PROXY_LISTENER_CARRIER = {
  shell: EGRESS_ALLOWLIST_TIER_CARRIER.file_tool,
  channel: EGRESS_ALLOWLIST_TIER_CARRIER.channel,
} as const;

/** Host patterns that share the ports they may be reached on; one allowlist entry. */
export const EgressProxyAllowedDestinationSchema = z
  .object({
    hosts: z.array(EgressAllowlistHostSchema).min(1),
    ports: z.array(EgressAllowlistPortSchema).min(1),
  })
  .strict();
export type EgressProxyAllowedDestination = z.infer<typeof EgressProxyAllowedDestinationSchema>;

export const EgressProxyAllowlistSchema = z
  .object({
    shell: z.array(EgressProxyAllowedDestinationSchema),
    channel: z.array(EgressProxyAllowedDestinationSchema),
  })
  .strict();
export type EgressProxyAllowlist = z.infer<typeof EgressProxyAllowlistSchema>;

const MAX_URL_CHARS = 4096;

export const EgressProxyConfigSchema = z
  .object({
    audit: z.object({ path: z.string().min(1) }).strict(),
    upstream: z.string().max(MAX_URL_CHARS).nullable(),
    upstream_unsupported: EgressUpstreamUnsupportedKindSchema.nullable(),
    pac: z
      .object({
        auto_config_url: z.string().min(1).max(MAX_URL_CHARS).nullable(),
        auto_detect: z.boolean(),
      })
      .strict()
      .refine((pac) => pac.auto_config_url !== null || pac.auto_detect, {
        message: "a PAC setting names a script, automatic detection, or both",
      })
      .nullable(),
    mode: EgressProxyModeSchema,
    allowlist: EgressProxyAllowlistSchema.nullable(),
    /** EG2-4b: the verifier section the shell listener's approvals are checked against; absent without a broker. */
    approval: EgressProxyApprovalConfigSchema.optional(),
    /** EG2-4b: the key a command's proxy credential is verified with (`egress-proxy-approval.ts`); absent without one. */
    session_key: Base64Url32Schema.optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.mode === "enforce" && config.allowlist === null) {
      context.addIssue({ code: "custom", path: ["allowlist"], message: "enforce needs an allowlist" });
    }
  });
export type EgressProxyConfig = z.infer<typeof EgressProxyConfigSchema>;

/**
 * The allowlist resolved for the proxy's listeners: per listener, the entries of its carrier in the order
 * the allowlist lists them. This is the reference for the Sandbox Manager's resolution.
 */
export function resolveEgressProxyAllowlist(allowlist: EgressAllowlist): EgressProxyAllowlist {
  const forCarrier = (carrier: string): EgressProxyAllowedDestination[] =>
    allowlist.entries
      .filter((entry) => entry.carrier === carrier)
      .map((entry) => ({ hosts: [...entry.hosts], ports: [...entry.ports] }));
  return {
    shell: forCarrier(EGRESS_PROXY_LISTENER_CARRIER.shell),
    channel: forCarrier(EGRESS_PROXY_LISTENER_CARRIER.channel),
  };
}
