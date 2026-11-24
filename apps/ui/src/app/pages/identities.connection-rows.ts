/** What each row of the Connections list shows, worked out from the saved state each service reports. */
import type { TavilyKeyView } from "~/features/tavily-api-key";
import type { OpenworkGithubStatus, OpenworkOpenCodeRouterIdentityItem } from "../lib/openwork-server";
import type { GmailCredentialStatus } from "./settings.gmail-credentials";

export type ConnectionId = "slack" | "telegram" | "github" | "tavily" | "gmail";

export const CONNECTION_ORDER: readonly ConnectionId[] = ["slack", "telegram", "github", "tavily", "gmail"];

/** The Settings search entry each row stands for; the setup inside a row's dialog is not mounted until it opens. */
export const CONNECTION_SEARCH_ANCHORS: Partial<Record<ConnectionId, string>> = {
  slack: "slack",
  github: "github",
  tavily: "web_search",
  gmail: "gmail",
};

export type ConnectionStatus = "connected" | "paused" | "not_connected" | "attention" | "unavailable" | "loading";

export type ConnectionRow = {
  id: ConnectionId;
  status: ConnectionStatus;
  /** The toggle: on only while something is saved and not paused. */
  enabled: boolean;
  /** Something is saved that the toggle can pause and resume without setup. */
  saved: boolean;
  /** The toggle can be used at all: not while loading, unreadable, unavailable, or set by the environment. */
  switchable: boolean;
  /** Shown from the last read while a fresh one is still loading; a switch waits for the fresh read. */
  stale?: boolean;
};

const row = (id: ConnectionId, status: ConnectionStatus, switchable: boolean): ConnectionRow => ({
  id,
  status,
  enabled: status === "connected" || status === "attention",
  saved: status === "connected" || status === "attention" || status === "paused",
  switchable,
});

type IdentityItem = Pick<OpenworkOpenCodeRouterIdentityItem, "id" | "enabled" | "running">;

/** The identity a channel's toggle switches: this workspace's own, else any the user saved, never the environment's. */
export function switchedIdentity<T extends IdentityItem>(items: readonly T[], workspaceIdentityId: string | null): T | null {
  return (
    items.find((item) => item.id === workspaceIdentityId) ??
    items.find((item) => item.id !== "env") ??
    items[0] ??
    null
  );
}

export function channelRow(
  id: "slack" | "telegram",
  input: { ready: boolean; loaded: boolean; items: readonly IdentityItem[]; error: string | null; workspaceIdentityId: string | null },
): ConnectionRow {
  if (!input.ready) return row(id, "unavailable", false);
  if (!input.loaded) return row(id, "loading", false);
  const identity = switchedIdentity(input.items, input.workspaceIdentityId);
  if (!identity) return row(id, input.error ? "unavailable" : "not_connected", !input.error);
  const switchable = identity.id !== "env";
  if (!identity.enabled) return row(id, "paused", switchable);
  return row(id, identity.running ? "connected" : "attention", switchable);
}

export function githubRow(input: { ready: boolean; status: OpenworkGithubStatus | null }): ConnectionRow {
  if (!input.ready) return row("github", "unavailable", false);
  const status = input.status;
  if (!status) return row("github", "loading", false);
  if (status.installed === false) return row("github", "unavailable", false);
  if (status.paused) return row("github", "paused", true);
  return row("github", status.authenticated ? "connected" : "not_connected", true);
}

export function tavilyRow(view: TavilyKeyView): ConnectionRow {
  switch (view.kind) {
    case "loading":
      return row("tavily", "loading", false);
    case "unavailable":
      return row("tavily", "unavailable", false);
    case "unreadable":
      return { ...row("tavily", "attention", false), enabled: false, saved: false };
    case "known":
      if (!view.configured) return row("tavily", "not_connected", true);
      return row("tavily", view.enabled ? "connected" : "paused", true);
  }
}

/** Uploaded credentials still waiting for the Google sign-in need attention, and only setup can finish them. */
export function gmailRow(input: { ready: boolean; status: GmailCredentialStatus | null }): ConnectionRow {
  if (!input.ready) return row("gmail", "unavailable", false);
  const status = input.status;
  if (!status) return row("gmail", "loading", false);
  if (status.paused) return row("gmail", "paused", true);
  if (status.hasCredentials && status.hasToken) return row("gmail", "connected", true);
  if (status.hasCredentials) return { ...row("gmail", "attention", true), enabled: false, saved: false };
  return row("gmail", "not_connected", true);
}

/**
 * Reopening the page reads every connection again. Until a row's read lands it shows the state last read for it,
 * so its toggle stays where the user left it instead of starting off and sliding back on.
 */
export function withRemembered(fresh: ConnectionRow, remembered: ConnectionRow | undefined): ConnectionRow {
  if (fresh.status !== "loading" || !remembered) return fresh;
  return { ...remembered, stale: true };
}

/** Turning a row on with nothing saved opens its setup; otherwise the toggle pauses or resumes what is saved. */
export function toggleIntent(target: ConnectionRow, next: boolean): "switch" | "open_setup" | "none" {
  if (!target.switchable || target.stale) return "none";
  if (target.saved) return "switch";
  return next ? "open_setup" : "none";
}
