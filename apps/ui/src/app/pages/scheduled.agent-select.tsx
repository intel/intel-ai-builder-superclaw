import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { Check, ChevronDown } from "lucide-solid";
import { humanizeAgentName } from "./scheduled.agent-name";

// Matches the popover's previous `max-h-72` cap; used as the ceiling once we
// start constraining to whatever space is actually free above/below.
const PANEL_MAX_HEIGHT = 288;
const VIEWPORT_MARGIN = 8;

export type AutomationAgentSelectProps = {
  /** Selected agent name; "" means OpenCode's default agent. */
  value: string;
  /** Agent names to offer, already filtered for the active Product Profile. */
  options: readonly string[];
  defaultLabel: string;
  onChange: (value: string) => void;
  id?: string;
  class?: string;
};

/**
 * Agent picker for a scheduled automation.
 *
 * Renders as an anchored button whose popover list is portaled to the
 * document body and fixed-positioned under the button, so opening it never
 * grows the modal's scroll area — it overlays whatever sits below instead,
 * matching the model picker's dropdown behavior in the same modal.
 *
 * Keyboard/focus follow the ARIA APG collapsible-listbox pattern: focus never
 * leaves the trigger button, Up/Down move a highlighted option (tracked via
 * `aria-activedescendant`), Enter/Space commits it, and Escape closes without
 * moving focus anywhere — so there is nothing to "restore" on close.
 *
 * The roster loads after the editor opens, so the options change under an
 * already-set value. A stored agent stays selectable even when it is no
 * longer in the visible roster (e.g. gated out), so opening and saving never
 * silently changes it (#2865).
 */
export default function AutomationAgentSelect(props: AutomationAgentSelectProps) {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number }>({
    left: 0,
    width: 0,
    maxHeight: PANEL_MAX_HEIGHT,
  });
  // Tracked by value, not index: the roster loads after the menu can already
  // be open, and a raw index would silently point at a different agent once
  // the array underneath it changes.
  const [highlightedValue, setHighlightedValue] = createSignal("");
  let buttonRef: HTMLButtonElement | undefined;
  let popoverRef: HTMLDivElement | undefined;

  const missingStored = () => props.value !== "" && !props.options.includes(props.value);
  const allOptions = () => (missingStored() ? [props.value, ...props.options] : props.options);
  const label = () => (props.value === "" ? props.defaultLabel : humanizeAgentName(props.value));

  // "" (default agent) is always the first entry in the keyboard-navigable list.
  const choices = createMemo(() => ["", ...allOptions()]);
  const choiceLabel = (value: string) => (value === "" ? props.defaultLabel : humanizeAgentName(value));
  const listboxId = `${props.id ?? "agent-select"}-listbox`;
  const optionId = (index: number) => `${listboxId}-option-${index}`;
  // DOM id lookups (aria-activedescendant, scroll-into-view) still need an
  // index; derive it fresh from the current roster instead of storing one.
  const highlightedIndex = createMemo(() => Math.max(0, choices().indexOf(highlightedValue())));

  // Flip above the trigger and cap height to the space actually available,
  // so the panel never renders off-screen near the bottom of a short window.
  const reposition = () => {
    if (!buttonRef) return;
    const rect = buttonRef.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - VIEWPORT_MARGIN;
    if (spaceBelow >= Math.min(160, PANEL_MAX_HEIGHT) || spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width, maxHeight: Math.min(PANEL_MAX_HEIGHT, Math.max(spaceBelow, 0)) });
    } else {
      setPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left, width: rect.width, maxHeight: Math.min(PANEL_MAX_HEIGHT, Math.max(spaceAbove, 0)) });
    }
  };

  createEffect(() => {
    if (!open()) return;
    reposition();
    const handleReflow = () => reposition();
    window.addEventListener("scroll", handleReflow, true);
    window.addEventListener("resize", handleReflow);
    onCleanup(() => {
      window.removeEventListener("scroll", handleReflow, true);
      window.removeEventListener("resize", handleReflow);
    });
  });

  createEffect(() => {
    if (!open()) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef?.contains(target) || popoverRef?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    onCleanup(() => window.removeEventListener("mousedown", handler));
  });

  const select = (value: string) => {
    props.onChange(value);
    setOpen(false);
  };

  const openMenu = () => {
    const list = choices();
    setHighlightedValue(list.includes(props.value) ? props.value : (list[0] ?? ""));
    setOpen(true);
  };

  // The roster can change while open — if the highlighted (not necessarily
  // selected) agent drops out of it, fall back the same way openMenu() does
  // instead of leaving Enter pointed at an agent that's no longer listed.
  createEffect(() => {
    if (!open()) return;
    const list = choices();
    if (!list.includes(highlightedValue())) {
      setHighlightedValue(list.includes(props.value) ? props.value : (list[0] ?? ""));
    }
  });

  const moveHighlight = (delta: number) => {
    const list = choices();
    const count = list.length;
    if (count === 0) return;
    const current = list.indexOf(highlightedValue());
    const base = current >= 0 ? current : 0;
    setHighlightedValue(list[(base + delta + count) % count] ?? "");
  };

  // Keep the highlighted option in view as it moves via the keyboard, and
  // when the menu opens with the selected agent scrolled out of sight.
  createEffect(() => {
    if (!open()) return;
    const id = optionId(highlightedIndex());
    document.getElementById(id)?.scrollIntoView({ block: "nearest" });
  });

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open()) openMenu();
      else moveHighlight(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open()) openMenu();
      else moveHighlight(-1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open()) openMenu();
      else select(highlightedValue());
    } else if (event.key === "Escape" && open()) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Tab" && open()) {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        id={props.id}
        data-testid="scheduler-agent-select"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={listboxId}
        aria-activedescendant={open() ? optionId(highlightedIndex()) : undefined}
        onClick={() => (open() ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
        class={props.class}
      >
        <span class="truncate">{label()}</span>
        <ChevronDown
          size={14}
          class="text-dls-secondary shrink-0 ml-2 transition-transform duration-200"
          classList={{ "rotate-180": open() }}
        />
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={popoverRef}
            id={listboxId}
            role="listbox"
            tabIndex={-1}
            data-testid="scheduler-agent-dropdown"
            style={{
              position: "fixed",
              ...(pos().top !== undefined ? { top: `${pos().top}px` } : { bottom: `${pos().bottom}px` }),
              left: `${pos().left}px`,
              width: `${pos().width}px`,
              "max-height": `${pos().maxHeight}px`,
            }}
            class="z-[999] overflow-y-auto rounded-dialog border border-dls-border bg-dls-surface-solid shadow-[var(--dls-shell-shadow)]"
          >
            <div class="p-2 space-y-1">
              <For each={choices()}>
                {(value, index) => {
                  const selected = () => props.value === value;
                  const isHighlighted = () => highlightedValue() === value;
                  return (
                    <button
                      type="button"
                      id={optionId(index())}
                      role="option"
                      aria-selected={selected()}
                      tabIndex={-1}
                      data-testid="scheduler-agent-option"
                      class={`w-full flex items-center justify-between rounded-control px-3 py-2 text-left text-caption transition-colors ${selected()
                        ? "bg-dls-active text-dls-text"
                        : isHighlighted()
                          ? "bg-dls-hover text-dls-text"
                          : "text-dls-secondary hover:bg-dls-hover"
                        }`}
                      onMouseEnter={() => setHighlightedValue(value)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => select(value)}
                    >
                      <span class="truncate">{choiceLabel(value)}</span>
                      <Show when={selected()}>
                        <Check size={14} class="shrink-0" />
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}

