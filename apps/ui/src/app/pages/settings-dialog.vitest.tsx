/**
 * Settings dialog shell (#3815): dialog semantics, focus, the vertical nav's
 * keyboard, and which overlay an Escape or a backdrop click belongs to.
 *
 * The section content is stubbed: what is under test is the frame, and the
 * real sections pull in most of the app. The stub can render an inner overlay
 * so the dialog can be checked to leave Escape to it.
 */
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { PlatformProvider, type Platform } from "../context/platform";
import { t } from "../../i18n";
import AddMcpModal from "../../features/mcp/add-mcp-modal";
import type { SettingsSection } from "./settings-dialog.sections";
import SettingsDialog, { type SettingsDialogProps } from "./settings-dialog";

const [innerMenuOpen, setInnerMenuOpen] = createSignal(false);
const [addMcpOpen, setAddMcpOpen] = createSignal(false);
const [runNowDisabled, setRunNowDisabled] = createSignal(false);

// File cleanup is searchable only in the installed app.
vi.mock("../utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils")>()),
  isTauriRuntime: () => true,
}));

vi.mock("./settings-dialog.content", () => ({
  default: (props: { section: SettingsSection; openNewTask: () => void }) => (
    <div data-testid="stub-content" data-section={props.section}>
      <button type="button" data-testid="stub-first" onClick={() => props.openNewTask()}>first</button>
      <div data-testid="stub-appearance" data-settings-anchor="appearance">
        <div data-testid="stub-theme" data-settings-anchor="theme">theme</div>
      </div>
      <div data-testid="stub-cleanup" data-settings-anchor="file_cleanup">
        <button type="button" data-testid="stub-run-now" data-settings-anchor="cleanup_run_now" disabled={runNowDisabled()}>
          run now
        </button>
      </div>
      <Show when={innerMenuOpen()}>
        <div role="menu" data-testid="stub-menu">menu</div>
      </Show>
      <AddMcpModal
        open={addMcpOpen()}
        onClose={() => setAddMcpOpen(false)}
        onAdd={() => {}}
        busy={false}
        localCommandBlock={null}
        language="en"
      />
      <button type="button" data-testid="stub-last">last</button>
    </div>
  ),
}));

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
  setInnerMenuOpen(false);
  setAddMcpOpen(false);
  setRunNowDisabled(false);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function renderDialog(options?: { section?: SettingsSection; voice?: boolean; returnFocus?: HTMLElement }) {
  const opener = document.createElement("button");
  opener.textContent = "open settings";
  document.body.appendChild(opener);
  opener.focus();

  const host = document.createElement("div");
  document.body.appendChild(host);

  const [section, setSection] = createSignal<SettingsSection>(options?.section ?? "model");
  const [open, setOpen] = createSignal(true);
  const onSectionChange = vi.fn((next: SettingsSection) => setSection(next));
  const onClose = vi.fn(() => setOpen(false));
  const openNewTask = vi.fn();
  const openLink = vi.fn();
  const platform = { platform: "desktop", openLink } as unknown as Platform;
  const props = {
    voice: options?.voice ? {} : undefined,
    openNewTask,
  } as unknown as SettingsDialogProps;

  dispose = render(
    () => (
      <PlatformProvider value={platform}>
        <Show when={open()}>
          <SettingsDialog
            {...props}
            section={section()}
            onSectionChange={onSectionChange}
            returnFocus={options?.returnFocus}
            onClose={onClose}
          />
        </Show>
      </PlatformProvider>
    ),
    host,
  );

  const q = <T extends HTMLElement = HTMLElement>(testId: string) =>
    document.querySelector<T>(`[data-testid="${testId}"]`);
  return { opener, section, onSectionChange, onClose, openNewTask, openLink, q };
}

const press = (key: string, init?: KeyboardEventInit) => {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe("SettingsDialog", () => {
  test("is a labelled modal dialog with a vertical tab list", () => {
    const { q } = renderDialog();
    const dialog = q("settings-dialog");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe(t("dashboard.advanced"));

    const tablist = document.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute("aria-orientation")).toBe("vertical");
    expect(q("model-settings-button")?.getAttribute("role")).toBe("tab");
    expect(q("model-settings-button")?.getAttribute("aria-selected")).toBe("true");
    expect(q("app-settings-button")?.getAttribute("aria-selected")).toBe("false");
    expect(q("close-settings")?.getAttribute("aria-label")).toBe(t("dashboard.close_settings"));
  });

  test("shows Dictation only with a voice controller", () => {
    renderDialog();
    expect(document.querySelector('[data-testid="voice-settings-button"]')).toBeNull();
    dispose?.();
    document.body.innerHTML = "";
    renderDialog({ voice: true });
    expect(document.querySelector('[data-testid="voice-settings-button"]')).not.toBeNull();
  });

  test("focuses the selected section on open and gives focus back on close", () => {
    const { opener, q } = renderDialog({ section: "privacy" });
    expect(document.activeElement).toBe(q("privacy-settings-button"));
    q("close-settings")?.click();
    expect(q("settings-dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("focus goes to the return target when the opener has gone, as a drawer's button does", () => {
    const toggle = document.createElement("button");
    document.body.appendChild(toggle);
    const { opener, q } = renderDialog({ returnFocus: toggle });
    opener.remove();
    q("close-settings")?.click();
    expect(document.activeElement).toBe(toggle);
  });

  test("selects a section when its tab is clicked", () => {
    const { q, onSectionChange } = renderDialog();
    q("mcp-settings-button")?.click();
    expect(onSectionChange).toHaveBeenLastCalledWith("mcp");
    expect(q("mcp-settings-button")?.getAttribute("aria-selected")).toBe("true");
    expect(q("mcp-settings-button")?.tabIndex).toBe(0);
    expect(q("model-settings-button")?.tabIndex).toBe(-1);
  });

  test("arrow keys, Home and End move between sections", () => {
    const { q, section } = renderDialog({ section: "model" });
    press("ArrowDown");
    expect(section()).toBe("privacy");
    expect(document.activeElement).toBe(q("privacy-settings-button"));
    press("ArrowUp");
    press("ArrowUp");
    expect(section()).toBe("app");
    press("End");
    expect(section()).toBe("scheduled");
    press("Home");
    expect(section()).toBe("app");
  });

  test("Escape closes the dialog", () => {
    const { onClose } = renderDialog();
    const event = press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  test("Escape is left to an overlay open inside a section", () => {
    const { onClose, q } = renderDialog();
    setInnerMenuOpen(true);
    // The menu closes itself on Escape, as the scheduler card's does from `window`.
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInnerMenuOpen(false);
    };
    q("stub-first")?.addEventListener("keydown", closeMenu);
    q("stub-first")?.focus();
    press("Escape");
    expect(q("stub-menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape is left to a fixed overlay outside the dialog", () => {
    const { onClose } = renderDialog();
    const portaled = document.createElement("div");
    portaled.setAttribute("role", "dialog");
    portaled.style.position = "fixed";
    document.body.appendChild(portaled);
    press("Escape");
    expect(onClose).not.toHaveBeenCalled();
    portaled.remove();
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape a control already handled does not close the dialog", () => {
    const { onClose, q } = renderDialog();
    q("stub-first")?.addEventListener("keydown", (event) => event.preventDefault());
    q("stub-first")?.focus();
    press("Escape");
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a backdrop click closes, unless it is an inner overlay's outside click", () => {
    const { onClose, q } = renderDialog();
    const backdrop = q("settings-dialog-backdrop");
    setInnerMenuOpen(true);
    backdrop?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    backdrop?.click();
    expect(onClose).not.toHaveBeenCalled();
    setInnerMenuOpen(false);
    backdrop?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    backdrop?.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Tab stays inside the dialog", () => {
    const { q } = renderDialog();
    q("stub-last")?.focus();
    const forward = press("Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q("close-settings"));
    const back = press("Tab", { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q("stub-last"));
  });

  test("Tab cycles inside an overlay portaled outside the panel", () => {
    const { q } = renderDialog();
    const portaled = document.createElement("div");
    portaled.setAttribute("role", "dialog");
    portaled.style.position = "fixed";
    const first = document.createElement("button");
    const last = document.createElement("button");
    portaled.append(first, last);
    document.body.appendChild(portaled);

    last.focus();
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(q("settings-dialog")?.contains(document.activeElement)).toBe(false);
  });

  test("Tab from behind the dialog comes back into it", () => {
    const { opener, q } = renderDialog();
    opener.focus();
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(q("settings-dialog")?.contains(document.activeElement)).toBe(true);
  });

  test("Escape closes the Add MCP server modal first, then Settings", () => {
    const { onClose } = renderDialog({ section: "mcp" });
    setAddMcpOpen(true);
    expect(document.querySelector(`[aria-label="${t("mcp.add_modal_title")}"]`)).not.toBeNull();
    press("Escape");
    expect(addMcpOpen()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Tab wraps inside the Add MCP server modal a section renders in the panel", () => {
    renderDialog({ section: "mcp" });
    setAddMcpOpen(true);
    const modal = document.querySelector<HTMLElement>(`[aria-label="${t("mcp.add_modal_title")}"]`);
    const controls = Array.from(
      modal?.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex]:not([tabindex="-1"])') ?? [],
    ).filter((el) => !el.hasAttribute("disabled"));
    const first = controls[0];
    const last = controls[controls.length - 1];

    last?.focus();
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  test("a section handing off to chat closes Settings first", () => {
    const { onClose, openNewTask, q } = renderDialog();
    q("stub-first")?.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(openNewTask).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(openNewTask.mock.invocationCallOrder[0]);
  });

  test("License Agreement opens in the browser and says so", () => {
    const { openLink } = renderDialog();
    const license = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(t("dashboard.license_agreement")),
    );
    expect(license?.textContent).toContain(t("dashboard.opens_in_browser"));
    expect(license?.getAttribute("role")).toBeNull();
    license?.click();
    expect(openLink).toHaveBeenCalledWith("https://aibuilder.intel.com/eula.txt");
  });
});

describe("SettingsDialog search", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  const type = (input: HTMLInputElement | null, value: string) => {
    if (!input) throw new Error("no search input");
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  test("has a labelled search field that Ctrl+F focuses", () => {
    const { q } = renderDialog();
    const input = q<HTMLInputElement>("settings-search-input");
    expect(input?.placeholder).toBe(t("settings_search.placeholder"));
    expect(input?.getAttribute("role")).toBe("combobox");
    const event = press("f", { ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  test("Ctrl+F leaves focus with an overlay open inside a section, but keeps the browser's Find bar shut", () => {
    const { q } = renderDialog();
    setInnerMenuOpen(true);
    q("stub-first")?.focus();
    expect(press("f", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q("stub-first"));
  });

  test("a query swaps the section for results, and Escape clears it without closing", () => {
    const { q, onClose } = renderDialog({ section: "model" });
    const input = q<HTMLInputElement>("settings-search-input");
    type(input, "theme");
    expect(q("stub-content")?.parentElement?.className).toContain("hidden");
    expect(q("settings-search-result-theme")).not.toBeNull();
    expect(input?.getAttribute("aria-expanded")).toBe("true");

    press("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(input?.value).toBe("");
    expect(q("settings-search-result-theme")).toBeNull();
    expect(q("stub-content")?.parentElement?.className).not.toContain("hidden");
    expect(q("stub-content")?.getAttribute("data-section")).toBe("model");

    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape clears the query wherever focus is before it closes Settings", () => {
    const { q, onClose } = renderDialog();
    const input = q<HTMLInputElement>("settings-search-input");
    type(input, "theme");
    q("model-settings-button")?.focus();
    press("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(input?.value).toBe("");
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Enter opens the best match's section, then focuses and highlights the setting", () => {
    const { q, onSectionChange } = renderDialog({ section: "model" });
    const input = q<HTMLInputElement>("settings-search-input");
    type(input, "theme");
    const best = q("settings-search-result-theme");
    expect(input?.getAttribute("aria-activedescendant")).toBe(best?.id);
    press("Enter");
    expect(onSectionChange).toHaveBeenLastCalledWith("app");
    expect(input?.value).toBe("");
    const theme = q("stub-theme");
    expect(document.activeElement).toBe(theme);
    expect(theme?.classList.contains("settings-search-highlight")).toBe(true);
    expect(theme?.scrollIntoView).toHaveBeenCalled();
  });

  test("a picked control that is still disabled is waited for, then its card is used", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "clearTimeout"] });
    try {
      const { q } = renderDialog({ section: "model" });
      setRunNowDisabled(true);
      type(q<HTMLInputElement>("settings-search-input"), "run now");
      q("settings-search-result-cleanup_run_now")?.click();
      expect(document.activeElement).not.toBe(q("stub-run-now"));

      setRunNowDisabled(false);
      vi.advanceTimersByTime(50);
      expect(document.activeElement).toBe(q("stub-run-now"));

      setRunNowDisabled(true);
      type(q<HTMLInputElement>("settings-search-input"), "run now");
      q("settings-search-result-cleanup_run_now")?.click();
      vi.advanceTimersByTime(2100);
      expect(document.activeElement).toBe(q("stub-cleanup"));
      expect(q<HTMLButtonElement>("stub-run-now")?.disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a reveal still waiting is dropped when the user moves on", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "clearTimeout"] });
    try {
      const { q } = renderDialog({ section: "model" });
      const input = q<HTMLInputElement>("settings-search-input");
      setRunNowDisabled(true);

      // Away to another section and back, before the wait runs out.
      type(input, "run now");
      q("settings-search-result-cleanup_run_now")?.click();
      q("privacy-settings-button")?.click();
      q("app-settings-button")?.click();
      setRunNowDisabled(false);
      vi.advanceTimersByTime(2100);
      expect(document.activeElement).not.toBe(q("stub-run-now"));
      expect(q("stub-cleanup")?.classList.contains("settings-search-highlight")).toBe(false);

      // A new query.
      setRunNowDisabled(true);
      type(input, "run now");
      q("settings-search-result-cleanup_run_now")?.click();
      type(input, "theme");
      setRunNowDisabled(false);
      vi.advanceTimersByTime(2100);
      expect(document.activeElement).toBe(input);
      expect(q("stub-run-now")?.classList.contains("settings-search-highlight")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a click on a result picks it", () => {
    const { q, onSectionChange } = renderDialog({ section: "privacy" });
    type(q<HTMLInputElement>("settings-search-input"), "appearance");
    q("settings-search-result-appearance")?.click();
    expect(onSectionChange).toHaveBeenLastCalledWith("app");
    expect(document.activeElement).toBe(q("stub-appearance"));
  });

  test("a section result opens the section and leaves focus in the search field", () => {
    const { q, onSectionChange } = renderDialog({ section: "model" });
    const input = q<HTMLInputElement>("settings-search-input");
    type(input, "scheduled");
    q("settings-search-result-scheduled")?.click();
    expect(onSectionChange).toHaveBeenLastCalledWith("scheduled");
    expect(q("scheduler-settings-button")?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(input);
  });

  test("arrow keys move the active result and wrap", () => {
    const { q } = renderDialog();
    const input = q<HTMLInputElement>("settings-search-input");
    type(input, "settings");
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    expect(options.length).toBeGreaterThan(1);
    expect(input?.getAttribute("aria-activedescendant")).toBe(options[0].id);
    press("ArrowDown");
    expect(input?.getAttribute("aria-activedescendant")).toBe(options[1].id);
    press("ArrowUp");
    press("ArrowUp");
    expect(input?.getAttribute("aria-activedescendant")).toBe(options[options.length - 1].id);
  });

  test("says when nothing matches", () => {
    const { q } = renderDialog();
    type(q<HTMLInputElement>("settings-search-input"), "zzqx");
    expect(q("settings-search-empty")?.textContent).toContain(
      t("settings_search.no_results").replace("{query}", "zzqx"),
    );
    expect(document.querySelectorAll('[role="option"]').length).toBe(0);
    const input = q<HTMLInputElement>("settings-search-input");
    expect(input?.getAttribute("aria-expanded")).toBe("false");
    expect(input?.hasAttribute("aria-controls")).toBe(false);
  });

  test("choosing a tab clears the query", () => {
    const { q, onSectionChange } = renderDialog({ section: "model" });
    const input = q<HTMLInputElement>("settings-search-input");
    type(input, "theme");
    q("privacy-settings-button")?.click();
    expect(onSectionChange).toHaveBeenLastCalledWith("privacy");
    expect(input?.value).toBe("");
    expect(q("stub-content")?.parentElement?.className).not.toContain("hidden");
  });
});
