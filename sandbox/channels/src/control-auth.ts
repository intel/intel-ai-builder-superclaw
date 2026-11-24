// The router's two bearers (EG2-7). The admin token is the host's: full access. The scoped token goes
// to the file_tool tier, where the agent runs: it may read status and send, and a send is further
// limited by `scoped-send.ts`. Which routes the scoped token may call is the contract's table
// (`ROUTER_APPROVAL_RULES.scoped_routes`), not a list kept here.

import { timingSafeEqual } from "node:crypto";
import { ROUTER_APPROVAL_RULES } from "@different-ai/openwork-contracts/router-approval";

export type ControlRole = "admin" | "scoped";

const sameToken = (provided: string, expected: Buffer): boolean => {
  const bytes = Buffer.from(provided);
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
};

export function bearerToken(authorization: string | undefined): string {
  const header = authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

/** Both tokens are compared in constant time, and a scoped token equal to the admin one is refused at start. */
export function createControlAuthenticator(adminToken: string, scopedToken?: string) {
  const admin = Buffer.from(adminToken.trim());
  const trimmedScopedToken = scopedToken?.trim();
  const scoped = trimmedScopedToken ? Buffer.from(trimmedScopedToken) : null;
  if (scoped && scoped.equals(admin)) {
    throw new Error("OPENCODE_ROUTER_SCOPED_TOKEN must differ from OPENCODE_ROUTER_CONTROL_TOKEN");
  }
  return (authorization: string | undefined): ControlRole | null => {
    const provided = bearerToken(authorization);
    if (sameToken(provided, admin)) return "admin";
    if (scoped && sameToken(provided, scoped)) return "scoped";
    return null;
  };
}

export function scopedRouteAllowed(method: string | undefined, pathname: string): boolean {
  return ROUTER_APPROVAL_RULES.scoped_routes.some((route) => route.method === method && route.path === pathname);
}

/** A `POST /send` body field the scoped token may not set, whatever its value. */
export function scopedSendRejects(payload: Record<string, unknown>): string | null {
  for (const field of ROUTER_APPROVAL_RULES.scoped_send_rejects) {
    if (field in payload && payload[field] !== undefined && payload[field] !== false) return field;
  }
  return null;
}
