import { render } from "solid-js/web";
import { afterEach, describe, expect, test } from "vitest";

import ConnectionList from "./identities.connection-list";
import type { ConnectionId, ConnectionRow } from "./identities.connection-rows";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const ROWS: ConnectionRow[] = [
  { id: "slack", status: "connected", enabled: true, saved: true, switchable: true },
  { id: "telegram", status: "not_connected", enabled: false, saved: false, switchable: true },
  { id: "github", status: "paused", enabled: false, saved: true, switchable: true },
  { id: "tavily", status: "unavailable", enabled: false, saved: false, switchable: false },
];

function renderList() {
  const opened: ConnectionId[] = [];
  const toggled: Array<[ConnectionId, boolean]> = [];
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(
    () => (
      <ConnectionList
        rows={ROWS}
        busy={null}
        notices={{ github: { tone: "error", text: "GitHub did not answer." } }}
        onOpen={(id) => opened.push(id)}
        onToggle={(id, next) => toggled.push([id, next])}
      />
    ),
    host,
  );
  const get = (id: string) => host.querySelector<HTMLElement>(`[data-testid=${id}]`);
  return { host, get, opened, toggled };
}

describe("ConnectionList", () => {
  test("one row per connection, each with a status and a toggle reading the saved state", () => {
    const list = renderList();

    expect(list.host.querySelectorAll("[data-testid^=connection-row-]")).toHaveLength(4);
    expect(list.get("connection-row-github")?.dataset.status).toBe("paused");
    expect(list.get("connection-toggle-slack")?.getAttribute("aria-checked")).toBe("true");
    expect(list.get("connection-toggle-github")?.getAttribute("aria-checked")).toBe("false");
    expect((list.get("connection-toggle-tavily") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a Settings search result lands on the row, since the setup is drawn only in its dialog", () => {
    const list = renderList();

    expect(list.get("connection-row-slack")?.dataset.settingsAnchor).toBe("slack");
    expect(list.get("connection-row-github")?.dataset.settingsAnchor).toBe("github");
    expect(list.get("connection-row-tavily")?.dataset.settingsAnchor).toBe("web_search");
    expect(list.get("connection-row-telegram")?.hasAttribute("data-settings-anchor")).toBe(false);
  });

  test("clicking a row opens its dialog; clicking its toggle does not", () => {
    const list = renderList();

    list.get("connection-row-telegram")?.click();
    list.get("connection-toggle-slack")?.click();

    expect(list.opened).toEqual(["telegram"]);
    expect(list.toggled).toEqual([["slack", false]]);
  });

  test("Enter on a focused row opens it", () => {
    const list = renderList();

    list.get("connection-row-github")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(list.opened).toEqual(["github"]);
  });

  test("a row still loading with nothing remembered draws no switch that could slide on", () => {
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(
      () => (
        <ConnectionList
          rows={[{ id: "github", status: "loading", enabled: false, saved: false, switchable: false }]}
          busy={null}
          notices={{}}
          onOpen={() => {}}
          onToggle={() => {}}
        />
      ),
      host,
    );

    expect(host.querySelector("[data-testid=connection-toggle-github]")).toBeNull();
    expect(host.querySelector("[data-testid=connection-toggle-pending-github]")).not.toBeNull();
  });

  test("a failed switch is said under its own row", () => {
    const list = renderList();

    expect(list.get("connection-notice-github")?.textContent).toBe("GitHub did not answer.");
    expect(list.get("connection-notice-slack")).toBeNull();
  });
});
