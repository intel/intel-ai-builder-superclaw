/**
 * How a ServiceHub child tells a request ServiceHub forwarded from one that reached it directly.
 *
 * Two children rely on it: the Sandbox Manager for its approval and key routes (#16), and the
 * LLMRouter Manager for its control plane (#201). Both are routes a tier that can reach the child's
 * port must not be able to call. ServiceHub strips any client copy of the header below, then adds the
 * forwarded credential to every request it forwards; the child checks it in middleware, before any
 * handler, and refuses the request when it is missing or wrong.
 *
 * The credential is derived rather than new: HMAC-SHA256 keyed with the process credential
 * ServiceHub already hands that child instance at spawn, over a fixed label, as lowercase hex. Both
 * sides compute it from what they already hold, so there is no second secret to hand over, it changes
 * whenever the child restarts, and a forwarded request never carries the process credential itself:
 * knowing the forwarded value opens none of the routes that check the process credential.
 *
 * Host-side only. It uses `node:crypto` for the derivation, so the frontend never imports it.
 */
import { createHmac } from "node:crypto";

export const SERVICEHUB_FORWARDED_CREDENTIAL_HEADER = "X-SuperClaw-Forwarded-Credential";
export const SERVICEHUB_FORWARDED_CREDENTIAL_LABEL = "superclaw/servicehub-forwarded-request/v1";

/** The forwarded credential for one process credential: both are the UTF-8 bytes of the strings. */
export function servicehubForwardedCredential(processCredential: string): string {
  return createHmac("sha256", processCredential)
    .update(SERVICEHUB_FORWARDED_CREDENTIAL_LABEL)
    .digest("hex");
}

/**
 * One fixed pair both implementations are checked against. The process credential has the shape of
 * ServiceHub's `secrets.token_urlsafe(32)` and is not one any build uses.
 */
export const SERVICEHUB_FORWARDED_CREDENTIAL_VECTOR = {
  process_credential: "Xz3pQ7mR2vL9nK4tW8yB1cF6hJ0sD5aE2gU7iO3kP9q",
  forwarded_credential: "a356ef869c7c1a7eca258f592f3d74c94b0bd1c3d475aa90b1974abcd186fc9e",
} as const;
