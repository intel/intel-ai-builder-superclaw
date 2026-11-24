/** Response guards and error formatting for the channel (Telegram/Slack) APIs. Pure - unit-testable without a DOM. */
import { OpenworkServerError } from "../lib/openwork-server";
import { t } from "../../i18n";
import { ServiceHubHttpError } from "~/shared/platform/transport/servicehub";
import type { OpenworkOpenCodeRouterHealthSnapshot } from "../lib/openwork-server";
import type { OpenworkOpenCodeRouterIdentityItem } from "../lib/openwork-server";

export const OPENCODE_ROUTER_AGENT_FILE_PATH = ".opencode/agents/opencode-router.md";

export const OPENCODE_ROUTER_AGENT_FILE_TEMPLATE = `# OpenCodeRouter Messaging Agent

Use this file to define how the assistant responds in Slack/Telegram for this workspace.

Examples:
- Keep responses concise and action-oriented.
- Use tools directly; never ask end users to run router commands.
- Never expose raw peer IDs or Telegram chat IDs unless the user explicitly asks for debug output.
- Never ask end users for peer IDs or identity IDs.
- For outbound delivery, call opencode_router_status and opencode_router_send yourself.
- If Telegram says chat not found, tell the user the recipient must message the bot first (for example /start), then retry.
`;

export function formatRequestError(error: unknown): string {
  if (error instanceof OpenworkServerError) {
    return `${error.message} (${error.status})`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * What a failed Slack save puts on the form. Driven by the host's code and the `scope` and `reason` it carries,
 * never by matching message text: a rejected token goes under the field Slack named, because that is where the
 * user has to act, and Slack being unreachable is a network notice, because neither field is necessarily wrong.
 * Anything else has no field to attach to and shows the sentence the host API publishes for its code.
 */
export type SlackSaveFailure =
  | { kind: "invalid_token"; field: "bot" | "app" }
  | { kind: "slack_unreachable" }
  | { kind: "message"; message: string };

export function classifySlackSaveError(error: unknown): SlackSaveFailure {
  if (error instanceof ServiceHubHttpError) {
    const scope = error.details?.scope;
    if (
      error.code === "slack_verification_unavailable" ||
      error.code === "slack_unreachable" ||
      error.details?.reason === "unreachable"
    ) {
      return { kind: "slack_unreachable" };
    }
    if (error.code === "slack_credentials_rejected" && (scope === "bot" || scope === "app")) {
      return { kind: "invalid_token", field: scope };
    }
  }
  return { kind: "message", message: formatRequestError(error) };
}

/** Why a saved identity is not live in the running router yet. The change is kept either way. */
export function applyErrorMessage(code: "router_unreachable" | "router_rejected"): string {
  return code === "router_unreachable" ? t("identities.apply_router_unreachable") : t("identities.apply_router_rejected");
}

export function isOpenCodeRouterSnapshot(value: unknown): value is OpenworkOpenCodeRouterHealthSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ok === "boolean" &&
    typeof record.opencode === "object" &&
    typeof record.channels === "object" &&
    typeof record.config === "object"
  );
}

export function isOpenCodeRouterIdentities(value: unknown): value is { ok: boolean; items: OpenworkOpenCodeRouterIdentityItem[] } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.ok === "boolean" && Array.isArray(record.items);
}

export function getTelegramUsernameFromResult(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const bot = record.bot;
  if (!bot || typeof bot !== "object") return null;
  const username = (bot as Record<string, unknown>).username;
  if (typeof username !== "string") return null;
  const normalized = username.trim().replace(/^@+/, "");
  return normalized || null;
}
