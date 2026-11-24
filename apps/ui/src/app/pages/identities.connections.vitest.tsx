import { render } from "solid-js/web";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { OpenworkGithubStatus, OpenworkServerClient } from "../lib/openwork-server";

vi.mock("~/shared/platform/capability/capability-gate", () => ({
  useCapabilityGate: () => ({ isActive: () => false, isAgentAllowed: () => true }),
}));
vi.mock("./settings.gmail-credentials", () => ({
  createGmailCredentials: () => ({ status: () => null, error: () => null, setEnabled: async () => {} }),
  gmailSettingsVisible: () => true,
}));

import ConnectionsSection from "./identities.connections";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("ConnectionsSection", () => {
  test("a GitHub status read that fails is tried again, so the row does not stay loading", async () => {
    vi.useFakeTimers();
    const getGithubStatus = vi
      .fn<() => Promise<OpenworkGithubStatus>>()
      .mockRejectedValueOnce(new Error("backend starting"))
      .mockResolvedValue({ installed: true, authenticated: true, paused: false } as OpenworkGithubStatus);
    const client = { getGithubStatus } as unknown as OpenworkServerClient;
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(
      () => (
        <ConnectionsSection
          channelCredentials={null}
          openworkServerUrl="http://127.0.0.1:8787"
          openworkServerClient={client}
          workspaceId="ws_retry"
          channelsReady={false}
          channelsLoaded={false}
          slackIdentities={[]}
          slackIdentitiesError={null}
          telegramIdentities={[]}
          telegramIdentitiesError={null}
          telegramBotUsername={null}
          refreshChannels={() => {}}
          tavilyKeyView={{ kind: "unavailable" }}
          tavilyApiKeyStatus="idle"
          refreshTavilyApiKey={async () => {}}
          saveTavilyApiKey={async () => {}}
          clearTavilyApiKey={async () => {}}
          setTavilyApiKeyEnabled={async () => {}}
        />
      ),
      host,
    );
    const githubStatus = () => host.querySelector('[data-testid="connection-row-github"]')?.getAttribute("data-status");

    await vi.advanceTimersByTimeAsync(0);
    expect(githubStatus()).toBe("loading");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(getGithubStatus).toHaveBeenCalledTimes(2);
    expect(githubStatus()).toBe("connected");
  });
});
