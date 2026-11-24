import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

import { t } from "../../../i18n";
import { pickLocalFile, readLocalFileBytes } from "~/shared/platform/tauri";
import Button from "~/shared/ui/button";
import { selectedWorkspacePath } from "../../pages/session.artifact-paths";
import { inboxPathToLink } from "./composer.attachments";
import { MENTION_CLASS, createMentionSpan, textToFragment } from "./composer.editor";
import type { ComposerFolderUpload } from "./composer.folder-upload";
import { findOutsidePaths } from "./composer.paste-path";
import type { ComposerProps } from "./composer.types";

// lucide "triangle-alert"; a fixed string, so innerHTML carries no user input.
const WARNING_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

const POPOVER_WIDTH = 320;
/** Long enough for the pointer to cross the gap between the chip and the popover. */
const LEAVE_DELAY_MS = 150;

const baseName = (path: string) =>
  path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

const looksLikeFile = (path: string) => /\.[a-z0-9]{1,8}$/i.test(baseName(path));

/** The chip's text is the pasted text, so until the user acts on it the draft
 * sends exactly what was pasted. The icon has no text node. */
function createOutsidePathChip(text: string, path: string) {
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.className = "inline-flex shrink-0";
  icon.innerHTML = WARNING_ICON;
  const chip = document.createElement("span");
  chip.append(icon, document.createTextNode(text));
  chip.contentEditable = "false";
  chip.tabIndex = 0;
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-haspopup", "dialog");
  chip.dataset.outsidePath = path;
  chip.className =
    "inline-flex items-center gap-1 rounded-subtle border border-dls-warning-border bg-dls-warning-bg px-1.5 font-mono text-caption text-dls-warning-text cursor-pointer focus:outline-none focus:ring-2 focus:ring-dls-warning-border";
  return chip;
}

/** Uploads land at the workspace root, but after `/cd <subdir>` the agent maps
 * `/workspace` to that subdirectory, so a Windows root gets an absolute path. */
function createWorkspaceFolderChip(folderPath: string, root = "") {
  const chip = document.createElement("span");
  chip.textContent = `@${baseName(folderPath)}`;
  chip.contentEditable = "false";
  const link = inboxPathToLink(folderPath);
  chip.dataset.workspaceFolder = /^[a-zA-Z]:[\\/]/.test(root.trim())
    ? selectedWorkspacePath(link.slice("/workspace/".length), root)
    : link;
  chip.className = MENTION_CLASS;
  return chip;
}

type ComposerOutsidePathDeps = {
  editor: () => HTMLElement | undefined;
  /** Only a sandboxed or remote workspace keeps the agent from host paths. Off
   * while read-only: a subagent transcript hides the composer but keeps it mounted. */
  enabled: () => boolean;
  workspaceRoot: () => string | undefined;
  /** Desktop app with an upload handler, in a prompt: a shell command sends a
   * link's text, so a mention or folder chip would break the command. */
  canAdd: () => boolean;
  uploadInboxFiles: () => ComposerProps["onUploadInboxFiles"];
  folderUpload: ComposerFolderUpload;
  onToast: (message: string) => void;
  onChange: () => void;
};

export type ComposerOutsidePaths = ReturnType<typeof createComposerOutsidePaths>;

/**
 * Marks pasted paths the agent cannot open, and turns one into a workspace
 * link once the user adds it. The warning lives on the chip and never times
 * out; the popover only explains it and offers the fix.
 */
export function createComposerOutsidePaths(deps: ComposerOutsidePathDeps) {
  const [active, setActive] = createSignal<HTMLElement | null>(null);
  let popoverRef: HTMLDivElement | undefined;

  /** Pasted text as editor nodes, with each outside path as a chip. */
  const build = (text: string) => {
    const paths = deps.enabled() ? findOutsidePaths(text, deps.workspaceRoot()) : [];
    const fragment = document.createDocumentFragment();
    let firstChip: HTMLElement | null = null;
    let at = 0;
    for (const { start, end, path } of paths) {
      fragment.append(textToFragment(text.slice(at, start)));
      const chip = createOutsidePathChip(text.slice(start, end), path);
      firstChip ??= chip;
      fragment.append(chip);
      at = end;
    }
    fragment.append(textToFragment(text.slice(at)));
    // Leave the caret somewhere to type after a trailing chip. A plain space
    // collapses in Chromium and the next keystroke lands before it.
    if (paths.length && at === text.length) {
      fragment.append(document.createTextNode("\u00a0"));
    }
    return { fragment, firstChip };
  };

  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  const hold = () => clearTimeout(leaveTimer);
  /** The pointer left the chip or the popover. Keyboard focus inside the popover keeps it open. */
  const leave = () => {
    hold();
    leaveTimer = setTimeout(() => {
      if (!popoverRef?.contains(document.activeElement)) close();
    }, LEAVE_DELAY_MS);
  };

  const open = (chip: HTMLElement) => {
    hold();
    if (deps.enabled() && !chip.dataset.adding && deps.editor()?.contains(chip)) setActive(chip);
  };
  const close = () => {
    hold();
    setActive(null);
  };
  createEffect(() => {
    if (!deps.enabled()) close();
  });

  const replace = (chip: HTMLElement, node: Node) => {
    if (active() === chip) close();
    // Sent or reset while the upload ran; the upload already selected it in Files.
    if (!chip.isConnected) {
      deps.onToast(t("composer.outside_path_added_after_send"));
      return;
    }
    chip.replaceWith(node);
    deps.onChange();
    // The popover's focused button is gone; a keyboard user resumes after the node.
    if (document.activeElement === document.body) caretAfter(node);
  };

  /** Past a trailing chip's separator from `build()`, so typing stays a word apart. */
  const caretAfter = (node: Node) => {
    const next = node.nextSibling;
    const anchor = next !== null && next.nodeType === Node.TEXT_NODE && !next.textContent?.trim() ? next : node;
    deps.editor()?.focus();
    const range = document.createRange();
    range.setStartAfter(anchor);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const keepAsText = (chip: HTMLElement) =>
    replace(chip, document.createTextNode(chip.textContent ?? ""));

  const addFile = async (chip: HTMLElement, path: string) => {
    const picked = await pickLocalFile(path);
    if (!picked) return;
    const bytes = await readLocalFileBytes(picked);
    const file = new File([new Uint8Array(bytes)], baseName(picked));
    // The handler's own notices speak of an inbox the UI does not show.
    const uploaded = await Promise.resolve(
      deps.uploadInboxFiles()?.([file], { notify: false }),
    );
    const item = Array.isArray(uploaded) ? uploaded[0] : undefined;
    if (!item) {
      deps.onToast(t("composer.outside_path_add_failed"));
      return;
    }
    // Workspace-relative, like an @-mention: the prompt builder joins it to the SDK
    // directory. A `/workspace/…` link becomes a drive-less `file://` URL on Windows.
    replace(chip, createMentionSpan({ type: "file", path: item.path, label: item.name || file.name }));
  };

  const addFolder = async (chip: HTMLElement, path: string) => {
    try {
      await deps.folderUpload.reviewPath(path, (folderPath) =>
        replace(chip, createWorkspaceFolderChip(folderPath, deps.workspaceRoot())),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A file fails the scan as "not a directory" and goes to the picker quietly.
      // Anything else says why; a missing path may have moved, so the picker still opens.
      if (!/not a directory/i.test(reason)) deps.onToast(`${t("composer.folder_read_failed")} ${reason}`);
      if (/not a directory|Failed to resolve/i.test(reason)) await addFile(chip, path);
    }
  };

  /** The scan decides folder or file; a name like `project.v2` can be either. */
  const add = (chip: HTMLElement) => {
    const path = chip.dataset.outsidePath ?? "";
    close();
    // No popover while it runs, so a second Add cannot upload it twice.
    chip.dataset.adding = "true";
    addFolder(chip, path)
      .catch((error: unknown) => deps.onToast(error instanceof Error ? error.message : String(error)))
      .finally(() => delete chip.dataset.adding);
  };

  onMount(() => {
    const editor = deps.editor();
    if (!editor) return;
    const chipOf = (target: EventTarget | null) =>
      target instanceof Element
        ? (target.closest("[data-outside-path]") as HTMLElement | null)
        : null;
    const openChip = (event: Event) => {
      const chip = chipOf(event.target);
      if (chip) open(chip);
    };
    const onChipLeave = (event: MouseEvent) => {
      const chip = chipOf(event.target);
      if (chip && !chip.contains(event.relatedTarget as Node | null)) leave();
    };
    const onChipKey = (event: KeyboardEvent) => {
      const chip = chipOf(event.target);
      if (!chip || (event.key !== "Enter" && event.key !== " ")) return;
      // Enter on the editor sends the message; on a chip it opens the popover.
      event.preventDefault();
      event.stopPropagation();
      open(chip);
      queueMicrotask(() => popoverRef?.querySelector("button")?.focus());
    };
    const onDocumentPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef?.contains(target) || active()?.contains(target)) return;
      close();
    };
    const onDocumentKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !active()) return;
      close();
      editor.focus();
    };
    editor.addEventListener("click", openChip);
    editor.addEventListener("mouseover", openChip);
    editor.addEventListener("mouseout", onChipLeave);
    editor.addEventListener("focusin", openChip);
    editor.addEventListener("keydown", onChipKey);
    editor.addEventListener("input", close);
    document.addEventListener("pointerdown", onDocumentPointer);
    document.addEventListener("keydown", onDocumentKey);
    // Sending or resetting the draft removes the chip without an `input` event.
    const detached = new MutationObserver(() => {
      const chip = active();
      if (chip && !editor.contains(chip)) close();
    });
    detached.observe(editor, { childList: true, subtree: true });
    onCleanup(() => {
      detached.disconnect();
      editor.removeEventListener("click", openChip);
      editor.removeEventListener("mouseover", openChip);
      editor.removeEventListener("mouseout", onChipLeave);
      editor.removeEventListener("focusin", openChip);
      editor.removeEventListener("keydown", onChipKey);
      editor.removeEventListener("input", close);
      document.removeEventListener("pointerdown", onDocumentPointer);
      document.removeEventListener("keydown", onDocumentKey);
      hold();
    });
  });

  return {
    active,
    canAdd: deps.canAdd,
    build,
    open,
    hold,
    leave,
    add,
    keepAsText,
    setPopoverRef: (el: HTMLDivElement) => {
      popoverRef = el;
    },
  };
}

/** Explains the active chip and offers to add it to the workspace. */
export function OutsidePathPopover(props: { paths: ComposerOutsidePaths }) {
  return (
    <Show when={props.paths.active()} keyed>
      {(chip) => {
        const path = chip.dataset.outsidePath ?? "";
        const rect = chip.getBoundingClientRect();
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8));
        // Portalled: the composer shell sets `contain: layout`, which makes it the
        // containing block for `position: fixed` and puts viewport coordinates off-screen.
        return (
          <Portal>
            <div
              ref={props.paths.setPopoverRef}
              data-testid="outside-path-popover"
              role="dialog"
              onMouseEnter={props.paths.hold}
              onMouseLeave={props.paths.leave}
              class="fixed z-50 rounded-inset border border-dls-border border-l-2 border-l-dls-warning-border bg-dls-surface-solid px-3 py-2 text-caption text-dls-text shadow-lg"
              style={{
                left: `${left}px`,
                top: `${rect.top - 8}px`,
                width: `${POPOVER_WIDTH}px`,
                transform: "translateY(-100%)",
              }}
            >
              <p role="status">
                <span class="font-semibold">{baseName(path)}</span>{" "}
                {t("composer.outside_path_notice")}
              </p>
              <div class="mt-2 flex gap-2">
                <Show when={props.paths.canAdd()}>
                  <Button
                    variant="primary"
                    class="px-3 py-1.5 text-caption"
                    onClick={() => props.paths.add(chip)}
                  >
                    {looksLikeFile(path)
                      ? t("composer.outside_path_add_file")
                      : t("composer.outside_path_add_folder")}
                  </Button>
                </Show>
                <Button
                  variant="ghost"
                  class="px-3 py-1.5 text-caption"
                  onClick={() => props.paths.keepAsText(chip)}
                >
                  {t("composer.outside_path_keep_text")}
                </Button>
              </div>
            </div>
          </Portal>
        );
      }}
    </Show>
  );
}
