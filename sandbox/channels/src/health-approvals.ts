// The router's approval admin endpoint (EG2-7): the Connector's wire, answered by the router. Only the
// Sandbox Manager holds the admin secret, which it seals into the router's config at each start; the
// secret is checked before the body is read, and a wrong or missing one reads nothing.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CONNECTOR_ADMIN_ERRORS,
  ConnectorAdminDecisionRequestSchema,
  ConnectorAdminGrantRequestSchema,
  EGRESS_APPROVAL_GRANT_RULES,
  type ConnectorAdminErrorCode,
} from "@different-ai/openwork-contracts/egress-approval-grant";
import { GrantRejected, type SendApprovalHold } from "./send-approvals.js";

const RULES = EGRESS_APPROVAL_GRANT_RULES;
const ADMIN_PATHS = new Set(["/v1/admin/approvals", "/v1/admin/grants", "/v1/admin/decisions"]);

export const isApprovalAdminPath = (pathname: string): boolean => ADMIN_PATHS.has(pathname);

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, code: ConnectorAdminErrorCode): void {
  const { status, message } = CONNECTOR_ADMIN_ERRORS[code];
  reply(res, status, { error: { code, message } });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > RULES.admin_max_request_bytes) return undefined;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Handles one request on an admin path; the caller has checked `isApprovalAdminPath`. */
export function createApprovalAdminHandler(hold: SendApprovalHold, adminSecret: string) {
  const expected = Buffer.from(adminSecret);
  const authenticated = (req: IncomingMessage): boolean => {
    const header = req.headers[RULES.admin_secret_header.toLowerCase()];
    const provided = Buffer.from(typeof header === "string" ? header : "");
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };

  return async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {
    if (!authenticated(req)) return fail(res, "admin_authentication_failed");

    if (pathname === "/v1/admin/approvals" && req.method === "GET") {
      const requested = Number(new URL(req.url ?? "", "http://localhost").searchParams.get("wait_ms") ?? "0");
      const waitMs = Number.isFinite(requested)
        ? Math.min(Math.max(Math.trunc(requested), 0), RULES.admin_max_wait_ms)
        : 0;
      return reply(res, 200, { approvals: await hold.pending(waitMs) });
    }

    if (req.method !== "POST" || pathname === "/v1/admin/approvals") return fail(res, "invalid_request");
    const body = await readBody(req);
    if (pathname === "/v1/admin/grants") {
      const parsed = ConnectorAdminGrantRequestSchema.safeParse(body);
      if (!parsed.success) return fail(res, "invalid_request");
      try {
        hold.grant(parsed.data.grant);
      } catch (error) {
        if (error instanceof GrantRejected) return fail(res, "grant_rejected");
        throw error;
      }
      return reply(res, 200, { accepted: true });
    }
    const parsed = ConnectorAdminDecisionRequestSchema.safeParse(body);
    if (!parsed.success) return fail(res, "invalid_request");
    return hold.deny(parsed.data.approval_id) ? reply(res, 200, { accepted: true }) : fail(res, "approval_not_pending");
  };
}
