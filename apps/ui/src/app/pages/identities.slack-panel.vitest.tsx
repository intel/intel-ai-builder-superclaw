import { render } from "solid-js/web";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { OpenworkOpenCodeRouterIdentityItem } from "../lib/openwork-server";
import type { ChannelCredentialsClient } from "./identities.types";

vi.mock("./identities.slack-install", () => ({ default: () => null }));
vi.mock("./identities.slack-senders", () => ({ default: () => null }));

import SlackPanel from "./identities.slack-panel";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("SlackPanel", () => {
  test("each saved bot has its own switch, so a second bot can be paused without removing it", async () => {
    const setSlackIdentityEnabled = vi.fn(async () => ({ applied: true }));
    const refresh = vi.fn();
    const client = { setSlackIdentityEnabled } as unknown as ChannelCredentialsClient;
    const bots: OpenworkOpenCodeRouterIdentityItem[] = [
      { id: "ws_1", enabled: true, running: true },
      { id: "ws_2", enabled: true, running: true },
    ];
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(
      () => (
        <SlackPanel client={client} identityId="ws_1" identities={bots} identitiesError={null} refresh={refresh} />
      ),
      host,
    );

    const switches = host.querySelectorAll<HTMLElement>('[data-testid="slack-enabled-switch"]');
    expect(switches).toHaveLength(2);
    switches[1]?.click();

    await vi.waitFor(() => expect(setSlackIdentityEnabled).toHaveBeenCalledWith("ws_2", false));
    expect(setSlackIdentityEnabled).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
