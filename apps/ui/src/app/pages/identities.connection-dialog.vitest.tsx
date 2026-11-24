import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import ConnectionDialog from "./identities.connection-dialog";

let dispose: (() => void) | undefined;

beforeEach(() => {
  // happy-dom lays nothing out, so every connected element would read as hidden.
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return (this.isConnected ? [{}] : []) as unknown as DOMRectList;
  });
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function renderDialog() {
  const [open, setOpen] = createSignal(false);
  const onClose = vi.fn(() => setOpen(false));
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => (
      <ConnectionDialog open={open()} title="Telegram" onClose={onClose} data-testid="dialog">
        <button type="button" data-testid="inside">inside</button>
      </ConnectionDialog>
    ),
    host,
  );
  opener.focus();
  setOpen(true);
  const dialog = () => document.querySelector<HTMLElement>('[data-testid="dialog"]');
  const press = (key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event;
  };
  return { onClose, opener, dialog, press };
}

describe("ConnectionDialog", () => {
  test("takes focus on open, closes on Escape, and gives focus back to the row", () => {
    const { onClose, opener, dialog, press } = renderDialog();
    expect(dialog()?.contains(document.activeElement)).toBe(true);

    expect(press("Escape").defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("leaves Escape to an overlay its content opened above it", () => {
    const { onClose, press } = renderDialog();
    const confirm = document.createElement("div");
    confirm.setAttribute("role", "alertdialog");
    confirm.style.position = "fixed";
    document.body.appendChild(confirm);

    press("Escape");
    expect(onClose).not.toHaveBeenCalled();

    confirm.remove();
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
