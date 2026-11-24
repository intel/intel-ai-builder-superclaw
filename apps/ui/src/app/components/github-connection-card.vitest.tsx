import { render } from "solid-js/web";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { OpenworkGithubStatus } from "../lib/openwork-server";

let nextStatus: OpenworkGithubStatus;

vi.mock("../../i18n", () => ({ t: (key: string) => key }));
vi.mock("../pages/settings.platform-actions", () => ({ openUrl: async () => {} }));
vi.mock("../lib/openwork-server", () => ({
  readOpenworkServerSettings: () => ({ token: "client-token" }),
  createOpenworkServerClient: () => ({ getGithubStatus: async () => nextStatus }),
}));

const { default: GithubConnectionCard } = await import("./github-connection-card");

const NOT_STARTED = { status: "not_started", userCode: null, verificationUri: null, expiresAt: null, error: null } as const;

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

async function renderCard(status: OpenworkGithubStatus) {
  nextStatus = status;
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <GithubConnectionCard baseUrl="http://127.0.0.1:8787" workspaceId="ws_1" />, host);
  // Let the status read on mount land.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return host;
}

describe("GithubConnectionCard", () => {
  test("says why GitHub is unavailable instead of offering a sign-in that cannot work (#2873)", async () => {
    const reason = "GitHub sign-in is not available in this version of SuperClaw, because it has no protected place to keep the GitHub token.";
    const host = await renderCard({
      installed: false,
      authenticated: false,
      login: null,
      scopes: [],
      unavailableReason: reason,
      deviceFlow: NOT_STARTED,
    });

    expect(host.querySelector("[data-testid=github-unavailable]")?.textContent).toBe(reason);
    expect(host.textContent).not.toContain("settings.github_sign_in_browser");
  });

  test("still reports a missing CLI from a server that sends no reason", async () => {
    const host = await renderCard({ installed: false, authenticated: false, login: null, scopes: [], deviceFlow: NOT_STARTED });

    expect(host.querySelector("[data-testid=github-unavailable]")?.textContent).toBe("settings.github_cli_missing");
  });

  test("offers sign-in when GitHub is usable", async () => {
    const host = await renderCard({
      installed: true,
      authenticated: false,
      login: null,
      scopes: [],
      unavailableReason: null,
      deviceFlow: NOT_STARTED,
    });

    expect(host.querySelector("[data-testid=github-unavailable]")).toBeNull();
    expect(host.textContent).toContain("settings.github_sign_in_browser");
  });

  test("offers to remove a sign-in an older build left behind, even while GitHub is unavailable", async () => {
    // Removing a credential stores nothing, so it must stay possible (#3274 review).
    const host = await renderCard({
      installed: false,
      authenticated: false,
      login: null,
      scopes: [],
      unavailableReason: "GitHub sign-in is not available in this version of SuperClaw.",
      legacyCredential: true,
      deviceFlow: NOT_STARTED,
    });

    expect(host.querySelector("[data-testid=github-remove-legacy]")?.textContent).toBe("settings.github_remove_legacy");
    expect(host.textContent).not.toContain("settings.github_sign_in_browser");
  });

  test("offers to remove an upgrade's legacy sign-in while signed out on a working build", async () => {
    // Native now always has a store, so an upgrade's C:\config\gh token must still be removable.
    const host = await renderCard({
      installed: true,
      authenticated: false,
      login: null,
      scopes: [],
      unavailableReason: null,
      legacyCredential: true,
      deviceFlow: NOT_STARTED,
    });

    expect(host.querySelector("[data-testid=github-remove-legacy]")?.textContent).toBe("settings.github_remove_legacy");
    expect(host.textContent).toContain("settings.github_sign_in_browser");
  });

  test("does not offer it while signed in, where removing would sign out the current account", async () => {
    const host = await renderCard({
      installed: true,
      authenticated: true,
      login: "monalisa",
      scopes: ["repo"],
      unavailableReason: null,
      legacyCredential: true,
      deviceFlow: NOT_STARTED,
    });

    expect(host.querySelector("[data-testid=github-remove-legacy]")).toBeNull();
    expect(host.textContent).toContain("settings.clear");
  });

  test("offers no removal when nothing was left behind", async () => {
    const host = await renderCard({
      installed: false,
      authenticated: false,
      login: null,
      scopes: [],
      unavailableReason: "GitHub sign-in is not available in this version of SuperClaw.",
      legacyCredential: false,
      deviceFlow: NOT_STARTED,
    });

    expect(host.querySelector("[data-testid=github-remove-legacy]")).toBeNull();
  });
});
