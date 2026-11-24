import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { ChevronDown } from "lucide-solid";

import { FIELD_BOX_CLASS, FIELD_BOX_COMPACT_CLASS, ListboxOption, ListboxPopover, type ListboxOptionAction } from "~/shared/ui/listbox";

export type DropdownOption = {
  value: string;
  label: string;
  disabled?: boolean;
  action?: ListboxOptionAction;
  /** Optional marker shown at the end of the row (e.g. a status dot). The action replaces it on hover. */
  marker?: JSX.Element;
  testId?: string;
};

export type DropdownProps = {
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  size?: "default" | "compact";
  placeholder?: string;
  /** Hide the check mark on the selected row, when a row marker shows the state instead. */
  hideSelectedCheck?: boolean;
  disabled?: boolean;
  class?: string;
  "aria-label"?: string;
  "data-testid"?: string;
};

/**
 * Custom dropdown that mirrors the cloud-model combobox styling so every
 * selector across the settings surface looks identical. Fully controlled: the
 * button always renders the label for the current `value` prop, so a parent can
 * choose to ignore a selection (e.g. an "Add provider" entry point) simply by
 * not updating `value`.
 */
export default function Dropdown(props: DropdownProps) {
  const [open, setOpen] = createSignal(false);
  const [highlight, setHighlight] = createSignal(0);
  let containerRef: HTMLDivElement | undefined;

  const selectedOption = createMemo(() => props.options.find((option) => option.value === props.value) ?? null);
  const displayLabel = createMemo(() => selectedOption()?.label ?? props.placeholder ?? "");
  const triggerClass = createMemo(() => (props.size === "compact" ? FIELD_BOX_COMPACT_CLASS : FIELD_BOX_CLASS));

  const openMenu = () => {
    if (props.disabled) return;
    const index = props.options.findIndex((option) => option.value === props.value);
    setHighlight(index >= 0 ? index : 0);
    setOpen(true);
  };

  const commit = (option: DropdownOption) => {
    if (option.disabled) return;
    setOpen(false);
    props.onChange(option.value);
  };

  const moveHighlight = (delta: number) => {
    const options = props.options;
    if (options.length === 0) return;
    let index = highlight();
    for (let step = 0; step < options.length; step++) {
      index = (index + delta + options.length) % options.length;
      if (!options[index]?.disabled) break;
    }
    setHighlight(index);
  };

  // Close on any pointer press outside the dropdown. onFocusOut alone misses
  // clicks on non-focusable areas, which never move focus off the button.
  createEffect(() => {
    if (!open()) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (containerRef && target && containerRef.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    onCleanup(() => window.removeEventListener("pointerdown", onPointerDown));
  });

  return (
    <div
      ref={containerRef}
      class={`relative ${props.class ?? ""}`}
      onFocusOut={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOpen(false);
      }}
    >
      <button
        type="button"
        class={`${triggerClass()} flex items-center justify-between gap-2 disabled:opacity-60`}
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-label={props["aria-label"]}
        data-testid={props["data-testid"]}
        onClick={() => (open() ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
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
            if (!open()) {
              openMenu();
            } else {
              const option = props.options[highlight()];
              if (option) commit(option);
            }
          } else if (event.key === "Escape") {
            if (open()) {
              event.preventDefault();
              setOpen(false);
            }
          }
        }}
      >
        <span class="truncate" classList={{ "text-dls-secondary": !selectedOption() }}>
          {displayLabel()}
        </span>
        <ChevronDown size={16} class="pointer-events-none shrink-0 text-dls-secondary" />
      </button>
      <Show when={open()}>
        <ListboxPopover>
          <For each={props.options}>
            {(option, index) => (
              <ListboxOption
                label={option.label}
                selected={props.value === option.value}
                highlighted={index() === highlight()}
                size={props.size}
                disabled={option.disabled}
                action={option.action}
                marker={option.marker}
                hideSelectedCheck={props.hideSelectedCheck}
                data-testid={option.testId}
                onHover={() => setHighlight(index())}
                onSelect={() => commit(option)}
              />
            )}
          </For>
        </ListboxPopover>
      </Show>
    </div>
  );
}
