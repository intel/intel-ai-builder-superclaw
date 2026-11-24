import type { McpStatusMap } from "~/shared/types/mcp";
import { isPackageLauncher } from "./mcp-config";

/** `on_demand`: a host server the runtime sees connected that is not running now. */
export type McpStatusKind = McpStatusMap[string]["status"] | "connecting" | "on_demand";

export type McpPendingAction = "connect" | "enable" | "disable";

/** In-flight requests keyed by server slug. */
export type McpPendingMap = Record<string, McpPendingAction>;

/** A lookup by server name: `constructor` and `__proto__` are valid names and must not hit Object.prototype. */
export const ownValue = <T>(map: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

export const toSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export const statusDot = (status: McpStatusKind) => {
  switch (status) {
    case "connected": return "bg-dls-success-dot";
    case "needs_auth":
    case "needs_client_registration": return "bg-dls-warning-dot";
    case "disabled":
    case "connecting":
    case "on_demand": return "bg-dls-status-neutral-dot";
    default: return "bg-dls-danger-dot";
  }
};

export const statusBadgeStyle = (status: McpStatusKind) => {
  switch (status) {
    case "connected": return "bg-dls-status-success-bg text-dls-success-text";
    case "needs_auth":
    case "needs_client_registration": return "bg-dls-status-warning-bg text-dls-warning-text";
    case "disabled":
    case "connecting":
    case "on_demand": return "bg-dls-status-neutral-bg text-dls-status-neutral-badge-text";
    default: return "bg-dls-status-danger-bg text-dls-danger-text";
  }
};

export const statusLabelKey = (status: McpStatusKind) => {
  switch (status) {
    case "connected": return "mcp.connected";
    case "needs_auth": return "mcp.needs_auth";
    case "needs_client_registration": return "mcp.register_client";
    case "disabled": return "mcp.disabled";
    case "connecting": return "mcp.connecting";
    case "on_demand": return "mcp.host.on_demand";
    default: return "mcp.failed";
  }
};

/** An npx/uvx launch may or may not have its package cached, so its label stays neutral and the hint says why it can be slow. */
export const pendingStatus = (
  action: McpPendingAction,
  command?: readonly string[],
): { labelKey: string; hintKey?: string } => {
  switch (action) {
    case "connect":
      return isPackageLauncher(command)
        ? { labelKey: "mcp.starting", hintKey: "mcp.starting_hint" }
        : { labelKey: "mcp.connecting" };
    case "disable": return { labelKey: "mcp.disabling_action" };
    default: return { labelKey: "mcp.reconnecting_action" };
  }
};
