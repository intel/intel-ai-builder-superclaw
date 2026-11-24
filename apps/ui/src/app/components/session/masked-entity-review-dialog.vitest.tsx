/**
 * Masked entity review: dialog semantics, focus and keyboard containment, matching
 * PermissionApprovalDialog. With no client the review fails to load, which still shows
 * Cancel and Continue.
 */
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, test, vi } from "vitest";

import { t } from "../../../i18n";
import type { OpenworkServerClient } from "../../lib/openwork-server";
import type { MaskedReview } from "~/shared/platform/transport/openwork-server.types";
import MaskedEntityReviewDialog from "./masked-entity-review-dialog";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

function renderDialog() {
  const replies: string[] = [];
  const [shown, setShown] = createSignal(true);
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <Show when={shown()}>
        <MaskedEntityReviewDialog
          client={null}
          workspaceId={null}
          operations={[]}
          busy={false}
          onContinue={() => replies.push("continue")}
          onCancel={() => replies.push("cancel")}
        />
      </Show>
    ),
    root,
  );
  const get = (id: string) => root.querySelector<HTMLElement>(`[data-testid=${id}]`);
  return { get, replies, setShown };
}

const key = (target: Element | null, name: string, init: KeyboardEventInit = {}) =>
  target?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));

describe("MaskedEntityReviewDialog: dialog semantics and focus", () => {
  test("is a modal dialog named by its heading and described by its sentence", () => {
    const { get } = renderDialog();
    const dialog = get("masked-review-dialog");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
      t("session.mask_review_title"),
    );
    expect(document.getElementById(dialog?.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      t("session.mask_review_description"),
    );
  });

  test("focus moves to the dialog itself on open", () => {
    const { get } = renderDialog();
    expect(document.activeElement).toBe(get("masked-review-dialog"));
  });

  test("Tab and Shift+Tab stay inside the dialog", () => {
    const { get } = renderDialog();
    get("masked-review-continue-btn")?.focus();
    key(document.activeElement, "Tab");
    expect(document.activeElement).toBe(get("masked-review-cancel-btn"));
    key(document.activeElement, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(get("masked-review-continue-btn"));
  });

  test("page shortcuts and Escape handlers do not see keys pressed inside, and Escape answers nothing", () => {
    const seen: string[] = [];
    const onWindowKey = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", onWindowKey);
    try {
      const { get, replies } = renderDialog();
      key(get("masked-review-dialog"), "k", { ctrlKey: true });
      key(get("masked-review-cancel-btn"), "Escape");
      expect(seen).toEqual([]);
      expect(replies).toEqual([]);
      expect(get("masked-review-dialog")).not.toBeNull();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  test("focus returns to where it was when the dialog closes", () => {
    const before = document.createElement("button");
    document.body.append(before);
    before.focus();
    const { get, setShown } = renderDialog();
    expect(document.activeElement).toBe(get("masked-review-dialog"));
    setShown(false);
    expect(document.activeElement).toBe(before);
  });
});

describe("MaskedEntityReviewDialog: markdown preview", () => {
  test("an svg fence stays full source, so text the drawing hides is still reviewed", async () => {
    const marker = "CedarQuartz-Z7-internal-contract";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><metadata>${marker}</metadata><text>Public workflow</text></svg>`;
    const review: MaskedReview = {
      entities: [],
      supports_extra_terms: true,
      masked_text: `# Report\n\n\`\`\`svg\n${svg}\n\`\`\`\n`,
      preview_format: "markdown",
    };
    const client = { getMaskedReview: async () => review } as unknown as OpenworkServerClient;
    const root = document.createElement("div");
    document.body.append(root);
    dispose = render(
      () => (
        <MaskedEntityReviewDialog
          client={client}
          workspaceId="w"
          operations={[{ operation_id: "o", operation_session_id: "s" }]}
          busy={false}
          onContinue={() => {}}
          onCancel={() => {}}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(root.querySelector("[data-testid=masked-review-preview] pre code")).not.toBeNull());
    const preview = root.querySelector("[data-testid=masked-review-preview]");
    expect(preview?.querySelector("img, details")).toBeNull();
    expect(preview?.querySelector("pre code")?.textContent).toContain(marker);
  });
});
