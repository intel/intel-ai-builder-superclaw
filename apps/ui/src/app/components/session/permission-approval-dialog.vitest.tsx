import { render } from "solid-js/web";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, test } from "vitest";

import { setLocale, t } from "../../../i18n";
import type { PendingPermission } from "~/shared/types/session";
import PermissionApprovalDialog from "./permission-approval-dialog";
import type { PermissionReply } from "./permission-approval";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  setLocale("en");
});

const request = (overrides: Partial<PendingPermission> = {}): PendingPermission => ({
  id: "per-1",
  sessionID: "ses-1",
  permission: "email_send",
  patterns: ["a@example.com"],
  metadata: { subject: "Q3" },
  always: ["a@example.com"],
  receivedAt: 0,
  ...overrides,
});

const fileProtection = (): PendingPermission =>
  request({
    permission: "confirm_file_protection",
    patterns: ["protected-file-agent"],
    always: [],
    metadata: { user_request: "summarize", source_file_paths: ["/workspace/projects/Q3-forecast.xlsx"] },
  });

function renderDialog(initial: PendingPermission | null, opts: { busy?: () => boolean } = {}) {
  const sent: Array<[string, PermissionReply, "respond" | "remember"]> = [];
  const [shown, setShown] = createSignal<PendingPermission | null>(initial);
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <Show when={shown()}>
        {(permission) => (
          <PermissionApprovalDialog
            permission={permission()}
            busy={opts.busy?.() ?? false}
            respond={(id, reply) => sent.push([id, reply, "respond"])}
            respondAndRemember={(id, reply) => sent.push([id, reply, "remember"])}
            safeStringify={(value) => JSON.stringify(value)}
          />
        )}
      </Show>
    ),
    root,
  );
  const get = (id: string) => root.querySelector<HTMLElement>(`[data-testid=${id}]`);
  const labels = () => Array.from(root.querySelectorAll("button")).map((button) => button.textContent);
  return { root, get, labels, sent, setShown };
}

const key = (target: Element | null, name: string, init: KeyboardEventInit = {}) =>
  target?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));

describe("PermissionApprovalDialog: choices", () => {
  test("file protection offers Mask and analyze as the primary choice, and nothing labelled Deny", () => {
    const { labels, get } = renderDialog(fileProtection());

    expect(labels()).toEqual(["Analyze without masking", "Mask and analyze"]);
    expect(labels()).not.toContain("Deny");
    expect(get("permission-once-btn")?.className).toContain("bg-dls-info");
    expect(get("permission-deny-btn")?.className).not.toContain("bg-dls-danger-bg");
  });

  test("file protection sends the replies it always did: masking is once, unmasked is reject", () => {
    const { get, sent } = renderDialog(fileProtection());

    get("permission-once-btn")?.click();
    get("permission-deny-btn")?.click();

    expect(sent).toEqual([
      ["per-1", "once", "respond"],
      ["per-1", "reject", "respond"],
    ]);
  });

  test("other permissions are named by outcome and Allow for this session remembers", () => {
    const { labels, get, sent } = renderDialog(request());

    expect(labels()).toEqual(["Don't allow", "Allow once", "Allow for this session"]);
    get("permission-deny-btn")?.click();
    get("permission-once-btn")?.click();
    get("permission-allow-session-btn")?.click();
    expect(sent).toEqual([
      ["per-1", "reject", "respond"],
      ["per-1", "once", "respond"],
      ["per-1", "always", "remember"],
    ]);
  });

  test("buttons are off while a reply is in flight", () => {
    const { root } = renderDialog(request(), { busy: () => true });

    expect(Array.from(root.querySelectorAll("button")).every((button) => button.disabled)).toBe(true);
  });
});

describe("PermissionApprovalDialog: content", () => {
  test("leads with one plain sentence and keeps the raw request behind a closed Technical details", () => {
    const { get } = renderDialog(fileProtection());

    expect(get("permission-summary")?.textContent).toBe("SuperClaw wants to analyze Q3-forecast.xlsx.");
    const details = get("permission-technical-details") as HTMLDetailsElement | null;
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Technical details");
    expect(details?.textContent).toContain("confirm_file_protection");
    expect(details?.textContent).toContain("protected-file-agent");
    expect(details?.textContent).toContain("source_file_paths");
    expect(get("permission-summary")?.textContent).not.toContain("confirm_file_protection");
  });

  test("in Chinese no English label or heading is left", () => {
    setLocale("zh");
    const { root, labels } = renderDialog(fileProtection());

    expect(labels()).toEqual([t("session.permission_analyze_unmasked"), t("session.permission_mask_and_analyze")]);
    expect(root.querySelector("h3")?.textContent).toBe(t("session.permission_file_protection_title"));
    for (const english of ["Mask and analyze", "Analyze without masking", "Technical details", "Permission Required"]) {
      expect(root.textContent).not.toContain(english);
    }
  });
});

describe("PermissionApprovalDialog: dialog semantics and focus", () => {
  test("is a modal dialog named by its heading and described by its sentence", () => {
    const { get } = renderDialog(request());
    const dialog = get("permission-dialog");

    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe("Allow this action?");
    const description = document.getElementById(dialog?.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("SuperClaw wants to send an email to a@example.com.");
  });

  test("focus moves to the dialog itself on open, so a stray Enter answers nothing", () => {
    const { get, sent } = renderDialog(fileProtection());

    expect(document.activeElement).toBe(get("permission-dialog"));
    key(document.activeElement, "Enter");
    key(document.activeElement, " ");
    expect(sent).toEqual([]);
  });

  test("Tab and Shift+Tab stay inside the dialog", () => {
    const { get } = renderDialog(request());
    const dialog = get("permission-dialog");
    const summary = dialog?.querySelector("summary");

    key(dialog, "Tab");
    expect(document.activeElement).toBe(summary);
    key(document.activeElement, "Tab");
    expect(document.activeElement).toBe(get("permission-deny-btn"));
    get("permission-allow-session-btn")?.focus();
    key(document.activeElement, "Tab");
    expect(document.activeElement).toBe(summary);
    key(document.activeElement, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(get("permission-allow-session-btn"));
  });

  test("focus returns to where it was when the dialog closes", () => {
    const before = document.createElement("button");
    document.body.append(before);
    before.focus();
    const { get, setShown } = renderDialog(request());
    expect(document.activeElement).toBe(get("permission-dialog"));

    setShown(null);

    expect(document.activeElement).toBe(before);
  });

  test("focus moves to the dialog when a reply starts, so Tab stays inside while the buttons are off", () => {
    const [busy, setBusy] = createSignal(false);
    const { get } = renderDialog(request(), { busy });
    get("permission-once-btn")?.focus();

    setBusy(true);

    expect(document.activeElement).toBe(get("permission-dialog"));
    key(document.activeElement, "Tab");
    expect(document.activeElement).toBe(get("permission-dialog")?.querySelector("summary"));
  });

  test("page shortcuts such as Ctrl+K and Ctrl+F do not see keys pressed inside the dialog", () => {
    const seen: string[] = [];
    const onWindowKey = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", onWindowKey);
    try {
      const { get } = renderDialog(request());

      key(get("permission-dialog"), "k", { ctrlKey: true });
      key(get("permission-once-btn"), "f", { ctrlKey: true });

      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  test("focus comes back inside when a disabled button dropped it during a reply", () => {
    const [busy, setBusy] = createSignal(false);
    const { get } = renderDialog(request(), { busy });
    get("permission-once-btn")?.focus();
    setBusy(true);
    (document.activeElement as HTMLElement | null)?.blur();

    setBusy(false);

    expect(get("permission-dialog")?.contains(document.activeElement)).toBe(true);
  });
});
