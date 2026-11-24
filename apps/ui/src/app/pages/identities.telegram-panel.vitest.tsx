import { render } from "solid-js/web";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { OpenworkOpenCodeRouterIdentityItem } from "../lib/openwork-server";
import type { ChannelCredentialsClient } from "./identities.types";

const opened = vi.hoisted(() => [] as string[]);
vi.mock("./settings.platform-actions", () => ({
  openUrl: async (url: string) => {
    opened.push(url);
  },
}));

import TelegramPanel from "./identities.telegram-panel";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  opened.length = 0;
  document.body.innerHTML = "";
});

function renderPanel(identities: OpenworkOpenCodeRouterIdentityItem[], client: ChannelCredentialsClient | null = null) {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(
    () => (
      <TelegramPanel
        client={client}
        identityId="ws_1"
        identities={identities}
        identitiesError={null}
        botUsername={null}
        refresh={() => {}}
      />
    ),
    host,
  );
  return (id: string) => host.querySelector<HTMLElement>(`[data-testid=${id}]`);
}

describe("TelegramPanel", () => {
  test("a saved bot shows its card and no token box, and opens the bot in Telegram", () => {
    const get = renderPanel([
      { id: "ws_1", enabled: false, running: false, access: "public", bot: { id: 1, username: "superclaw_bot" } },
    ]);

    expect(get("telegram-bot-card")?.textContent).toContain("@superclaw_bot");
    expect(get("telegram-bot-state")?.textContent).toBe("Paused");
    expect(get("telegram-token-input")).toBeNull();

    get("telegram-open-bot")?.click();
    expect(opened).toEqual(["https://t.me/superclaw_bot"]);
  });

  test("with no bot, setup asks for a token and one access choice, and @BotFather opens", () => {
    const get = renderPanel([]);

    expect(get("telegram-token-input")).not.toBeNull();
    expect(get("telegram-access-public")?.getAttribute("aria-checked")).toBe("true");
    get("telegram-access-private")?.click();
    expect(get("telegram-access-private")?.getAttribute("aria-checked")).toBe("true");
    expect(get("telegram-access-public")?.getAttribute("aria-checked")).toBe("false");
    expect((get("telegram-connect") as HTMLButtonElement | null)?.disabled).toBe(true);

    get("telegram-open-botfather")?.click();
    expect(opened).toEqual(["https://t.me/BotFather"]);
  });

  test("a private bot's pairing code survives the dialog closing, even if Public was picked while saving", async () => {
    let answer: (value: { result: { applied: boolean }; pairingCode: string }) => void = () => {};
    const saveTelegramIdentity = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const client = { saveTelegramIdentity } as unknown as ChannelCredentialsClient;
    const bot: OpenworkOpenCodeRouterIdentityItem = { id: "ws_1", enabled: true, running: true, access: "private" };

    let get = renderPanel([], client);
    const input = get("telegram-token-input") as HTMLInputElement;
    input.value = "1:abc";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    get("telegram-access-private")?.click();
    get("telegram-connect")?.click();
    get("telegram-access-public")?.click();
    answer({ result: { applied: true }, pairingCode: "ABCD2345" });
    await vi.waitFor(() => expect(saveTelegramIdentity).toHaveBeenCalledTimes(1));
    expect(saveTelegramIdentity).toHaveBeenCalledWith("ws_1", expect.objectContaining({ access: "private" }));
    await Promise.resolve();

    dispose?.();
    document.body.innerHTML = "";
    get = renderPanel([bot], client);
    expect(document.body.textContent).toContain("/pair ABCD2345");
  });
});
