import { render } from "solid-js/web";
import { afterEach, describe, expect, test } from "vitest";

import type { TavilyKeyView } from "~/features/tavily-api-key/tavily-key-view";
import { t } from "../../i18n";
import TavilyKeyRow, { type TavilyKeyRowProps } from "./settings.tavily-key-row";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const SENTENCE = "The Tavily API key cannot be stored on this backend.";

function renderRow(view: TavilyKeyView, overrides: Partial<TavilyKeyRowProps> = {}) {
  const statuses: Array<string | null> = [];
  const calls = { retry: 0, saved: [] as string[], cleared: 0 };
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(
    () => (
      <TavilyKeyRow
        view={view}
        status={view.kind === "unreadable" ? "error" : "idle"}
        save={async (key) => {
          calls.saved.push(key);
        }}
        clear={async () => {
          calls.cleared += 1;
        }}
        retry={async () => {
          calls.retry += 1;
        }}
        onStatus={(message) => statuses.push(message)}
        {...overrides}
      />
    ),
    host,
  );
  const get = (id: string) => host.querySelector<HTMLElement>(`[data-testid=${id}]`);
  const input = () => get("tavily-api-key-input") as HTMLInputElement;
  const type = (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { host, get, input, type, flush, statuses, calls };
}

const disabled = (element: HTMLElement | null) => (element as HTMLButtonElement | null)?.disabled;

describe("TavilyKeyRow: the host's answer could not be read", () => {
  const unreadable: TavilyKeyView = { kind: "unreadable", message: "This endpoint is reached only through ServiceHub." };

  test("says so with the sentence and a Retry, and offers nothing that would save", async () => {
    const row = renderRow(unreadable);

    expect(row.get("tavily-status-badge")?.textContent).toContain(t("settings.tavily_status_unreadable"));
    expect(row.get("tavily-read-error")?.textContent).toContain(unreadable.message);
    expect(disabled(row.get("tavily-retry-btn"))).toBe(false);
    expect(row.input().disabled).toBe(true);
    expect(disabled(row.get("tavily-save-btn"))).toBe(true);
    expect(disabled(row.get("tavily-clear-btn"))).toBe(true);

    row.get("tavily-retry-btn")?.click();
    expect(row.calls.retry).toBe(1);
  });

  test("keeps the Retry when the failure came with no message", () => {
    const row = renderRow({ kind: "unreadable", message: "" });

    expect(row.get("tavily-retry-btn")).not.toBeNull();
  });
});

describe("TavilyKeyRow: saving", () => {
  test("a save the host refused keeps the typed key and never says it saved", async () => {
    const row = renderRow({ kind: "known", configured: false, enabled: true }, {
      save: async () => {
        throw new Error(SENTENCE);
      },
    });
    row.type("tvly-example");

    row.get("tavily-save-btn")?.click();
    await row.flush();

    expect(row.input().value).toBe("tvly-example");
    expect(row.statuses).toEqual([null, SENTENCE]);
    expect(row.statuses).not.toContain(t("settings.tavily_saved"));
  });

  test("a save the host took clears the box and says saved", async () => {
    const row = renderRow({ kind: "known", configured: false, enabled: true });
    row.type("  tvly-example  ");

    row.get("tavily-save-btn")?.click();
    await row.flush();

    expect(row.calls.saved).toEqual(["tvly-example"]);
    expect(row.input().value).toBe("");
    expect(row.statuses).toEqual([null, t("settings.tavily_saved")]);
  });

  test("a clear the host refused leaves the box and says why", async () => {
    const row = renderRow({ kind: "known", configured: true, enabled: true }, {
      clear: async () => {
        throw new Error(SENTENCE);
      },
    });

    row.get("tavily-clear-btn")?.click();
    row.get("tavily-clear-confirm")?.click();
    await row.flush();

    expect(row.statuses).toEqual([null, SENTENCE]);
  });

  test("Clear asks first, and a cancelled confirmation clears nothing", async () => {
    const row = renderRow({ kind: "known", configured: true, enabled: true });

    row.get("tavily-clear-btn")?.click();
    expect(row.get("tavily-clear-confirm")).not.toBeNull();
    expect(row.calls.cleared).toBe(0);

    (document.querySelector("[data-testid=modal-dismiss-btn]") as HTMLElement | null)?.click();
    await row.flush();

    expect(row.get("tavily-clear-confirm")).toBeNull();
    expect(row.calls.cleared).toBe(0);
  });

  test("a paused key says so in the badge", () => {
    const row = renderRow({ kind: "known", configured: true, enabled: false });

    expect(row.get("tavily-status-badge")?.textContent).toContain(t("connections.status_paused"));
    expect(row.get("tavily-api-key-input")?.getAttribute("placeholder")).toBe(
      t("settings.tavily_placeholder_replace"),
    );
  });
});

describe("TavilyKeyRow: the other states", () => {
  test("a mode without a key store is disabled and says so", () => {
    const row = renderRow({ kind: "unavailable" });

    expect(row.get("tavily-status-badge")?.textContent).toContain(t("settings.tavily_unavailable_in_this_mode"));
    expect(row.input().disabled).toBe(true);
    expect(row.get("tavily-read-error")).toBeNull();
  });

  test("while the status loads nothing says 'not configured'", () => {
    const row = renderRow({ kind: "loading" });

    expect(row.get("tavily-status-badge")?.textContent).not.toContain(t("settings.tavily_not_configured"));
    expect(row.input().disabled).toBe(true);
  });
});
