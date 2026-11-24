import { createEffect, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { Check, ChevronDown, Globe, Hand, TriangleAlert } from "lucide-solid";

import { t } from "../../i18n";
import type { ChatWebAccess } from "./useChatWebAccess";

const CHOICES = [
  {
    allowed: false,
    testId: "chat-web-access-ask",
    icon: Hand,
    title: "chat_web_access.ask",
    detail: null,
  },
  {
    allowed: true,
    testId: "chat-web-access-allowed",
    icon: Globe,
    title: "chat_web_access.allowed",
    detail: "chat_web_access.allowed_detail",
  },
] as const;

/** "Ask for approval / Allow for this session", a chip in the composer's picker row with a menu of the two choices. */
export default function ChatWebAccessSwitch(props: { access: ChatWebAccess }) {
  const [open, setOpen] = createSignal(false);
  const [settling, setSettling] = createSignal(false);
  const [menuOffset, setMenuOffset] = createSignal(0);
  const titleId = createUniqueId();
  const noteId = createUniqueId();
  let rootRef: HTMLDivElement | undefined;
  let chipRef: HTMLButtonElement | undefined;
  let menuRef: HTMLDivElement | undefined;

  const warning = () => (open() ? null : props.access.note());
  const choiceLabel = () => {
    const allowed = props.access.allowed();
    if (allowed === null) return t("chat_web_access.chip_unknown");
    return t(allowed ? "chat_web_access.allowed" : "chat_web_access.ask");
  };
  const chipName = () =>
    props.access.allowed() === null
      ? choiceLabel()
      : t("chat_web_access.chip_label").replace("{choice}", choiceLabel());
  const items = () => Array.from(menuRef?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? []);
  const focusChecked = () =>
    (menuRef?.querySelector<HTMLButtonElement>("[aria-checked=true]") ?? items()[0])?.focus();
  const close = (refocus: boolean) => {
    setOpen(false);
    setSettling(false);
    if (refocus) chipRef?.focus();
  };
  const toggle = () => {
    if (open()) {
      close(false);
      return;
    }
    setOpen(true);
    focusChecked();
  };
  // Sent even when it matches what the chip shows: that can be stale while a read is pending.
  const pick = (allowed: boolean) => {
    props.access.setAllowed(allowed);
    setSettling(true);
  };

  createEffect(() => {
    if (!settling() || props.access.busy()) return;
    // A write clears busy() before it records the note it ended with.
    queueMicrotask(() => {
      if (!settling()) return;
      setSettling(false);
      if (props.access.note()) focusChecked();
      else close(true);
    });
  });

  const placeMenu = () => {
    if (!rootRef || !menuRef) return;
    const anchor = rootRef.getBoundingClientRect();
    const margin = 16;
    const left = Math.min(Math.max(anchor.left, margin), window.innerWidth - margin - menuRef.offsetWidth);
    setMenuOffset(left - anchor.left);
  };

  createEffect(() => {
    if (!open()) {
      setMenuOffset(0);
      return;
    }
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef?.contains(event.target as Node)) close(false);
    };
    requestAnimationFrame(placeMenu);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("resize", placeMenu);
    onCleanup(() => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("resize", placeMenu);
    });
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const list = items();
    const at = list.findIndex((item) => item === document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = at === -1 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length;
    list[next]?.focus();
  };

  return (
    <Show when={props.access.visible()}>
      <div data-testid="chat-web-access" class="relative" ref={rootRef} onKeyDown={onKeyDown}>
        <button
          ref={chipRef}
          type="button"
          data-testid="chat-web-access-chip"
          aria-label={chipName()}
          aria-haspopup="menu"
          aria-expanded={open()}
          aria-describedby={warning() ? noteId : undefined}
          disabled={props.access.busy()}
          class={`flex items-center gap-1.5 rounded-control px-2 py-1.5 text-body font-medium transition-colors hover:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-60 ${
            props.access.allowed() === true ? "text-dls-accent" : "text-dls-secondary hover:text-dls-text"
          }`}
          classList={{ "bg-dls-hover": open() }}
          onClick={toggle}
        >
          <Show when={warning()} fallback={<Globe size={14} />}>
            <TriangleAlert size={14} class="text-dls-warning-text" />
          </Show>
          <span class="truncate leading-5">{choiceLabel()}</span>
          <ChevronDown size={14} class="transition-transform duration-200" classList={{ "rotate-180": open() }} />
        </button>
        <Show when={warning()}>
          {(note) => (
            <span id={noteId} class="sr-only">
              {note()}
            </span>
          )}
        </Show>

        <Show when={open()}>
          <div
            ref={menuRef}
            role="menu"
            aria-labelledby={titleId}
            class="absolute left-0 bottom-full z-40 mb-2 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-dialog border border-dls-border bg-dls-surface-solid shadow-[var(--dls-shell-shadow)]"
            style={{ transform: `translateX(${menuOffset()}px)` }}
          >
            <div class="p-2 space-y-1">
              <div id={titleId} class="px-3 pt-1 pb-1 text-caption text-dls-secondary">
                {t("chat_web_access.menu_title")}
              </div>
              <For each={CHOICES}>
                {(choice) => {
                  const checked = () => props.access.allowed() === choice.allowed;
                  return (
                    <button
                      type="button"
                      role="menuitemradio"
                      data-testid={choice.testId}
                      aria-checked={checked()}
                      disabled={props.access.busy()}
                      class={`w-full flex items-start gap-3 rounded-control px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                        checked() ? "bg-dls-hover" : "hover:bg-dls-hover/70"
                      }`}
                      onClick={() => pick(choice.allowed)}
                    >
                      <choice.icon size={16} class="mt-0.5 shrink-0 text-dls-secondary" />
                      <span class="min-w-0 flex-1">
                        <span class="block text-caption font-medium text-dls-text">{t(choice.title)}</span>
                        <Show when={choice.detail}>
                          {(detail) => <span class="mt-0.5 block text-caption text-dls-secondary">{t(detail())}</span>}
                        </Show>
                      </span>
                      <span class="mt-0.5 w-3.5 shrink-0">
                        <Show when={checked()}>
                          <Check size={14} class="text-dls-secondary" />
                        </Show>
                      </span>
                    </button>
                  );
                }}
              </For>
              <Show when={props.access.note()}>
                {(note) => (
                  <div data-testid="chat-web-access-note" role="status" class="px-3 py-1 text-caption text-dls-warning-text">
                    {note()}
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
}
