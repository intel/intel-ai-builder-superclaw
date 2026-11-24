import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import ConfirmModal from "./confirm-modal";

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

function renderConfirm(message: string | JSX.Element = "It goes.") {
  const [open, setOpen] = createSignal(false);
  const onCancel = vi.fn(() => setOpen(false));
  const onOuterEscape = vi.fn();
  window.addEventListener("keydown", onOuterEscape);
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => (
      <ConfirmModal
        open={open()}
        title="Remove?"
        message={message}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        data-testid="confirm"
        onConfirm={() => {}}
        onCancel={onCancel}
      />
    ),
    host,
  );
  opener.focus();
  setOpen(true);
  const get = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const press = (key: string, shiftKey = false) => {
    const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
    document.activeElement?.dispatchEvent(event);
    return event;
  };
  const cleanup = () => window.removeEventListener("keydown", onOuterEscape);
  return { onCancel, onOuterEscape, opener, get, press, cleanup };
}

describe("ConfirmModal", () => {
  test("Cancel takes focus, Tab wraps between the buttons, and Escape cancels and gives focus back", () => {
    const { onCancel, onOuterEscape, opener, get, press, cleanup } = renderConfirm();
    expect(document.querySelector('[role="alertdialog"]')?.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(get("modal-dismiss-btn"));

    press("Tab", true);
    expect(document.activeElement).toBe(get("confirm"));
    press("Tab");
    expect(document.activeElement).toBe(get("modal-dismiss-btn"));

    press("Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOuterEscape).not.toHaveBeenCalled();
    expect(get("confirm")).toBeNull();
    expect(document.activeElement).toBe(opener);
    cleanup();
  });

  test("Tab also reaches focusable content in the message, such as a Diagnostics summary", () => {
    const { get, press, cleanup } = renderConfirm(
      <details>
        <summary data-testid="diagnostics">Diagnostics</summary>
        <p>details</p>
      </details>,
    );
    expect(document.activeElement).toBe(get("modal-dismiss-btn"));

    // happy-dom does not move focus on a Tab the trap lets through, so the walk to the last stop is done by hand.
    get("confirm")?.focus();
    press("Tab");
    expect(document.activeElement).toBe(get("diagnostics"));
    press("Tab", true);
    expect(document.activeElement).toBe(get("confirm"));
    cleanup();
  });
});
