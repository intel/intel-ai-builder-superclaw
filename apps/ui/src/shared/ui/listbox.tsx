import { Check, Loader2 } from "lucide-solid";
import { Show, type JSX } from "solid-js";

/**
 * Single source of truth for the selector look shared by every dropdown across
 * the settings surface: the searchable cloud-model combobox and the plain
 * (non-searchable) Dropdown both build on these primitives, so their trigger
 * box, popover, and option rows always render identically.
 */

/** Trigger-box styling for a selector (applies to a `button` or `input`). */
export const FIELD_BOX_CLASS =
  "w-full bg-dls-panel-input-bg p-3 rounded-inset border border-dls-panel-input-border text-body-lg text-dls-text";

/** Compact trigger styling for tighter UI areas like Agent Creator package pickers. */
export const FIELD_BOX_COMPACT_CLASS =
  "w-full bg-dls-panel-input-bg px-2.5 py-2 rounded-inset border border-dls-panel-input-border text-caption text-dls-text";

/** Styled popover container that holds the listbox options. `maxHeightClass`
 *  replaces the default height cap, after which the list scrolls. */
export function ListboxPopover(props: {
  children: JSX.Element;
  maxHeightClass?: string;
  ref?: (element: HTMLDivElement) => void;
}) {
  return (
    <div
      ref={props.ref}
      role="listbox"
      class={`absolute z-20 mt-1 ${props.maxHeightClass ?? "max-h-56"} w-full overflow-auto rounded-inset border border-dls-panel-border bg-dls-surface-solid py-1 shadow-lg`}
    >
      {props.children}
    </div>
  );
}

/** Optional trailing action rendered at the end of an option row (e.g. a
 * per-provider "remove" button). It shows only while the row is hovered or the
 * button has focus. Its pointer handlers stop propagation so pressing it never
 * selects the row. */
export type ListboxOptionAction = {
  label: string;
  icon: JSX.Element;
  onAction: () => void;
  busy?: boolean;
  disabled?: boolean;
};

/** A single option row, with hover/highlight/selected/disabled states. */
export function ListboxOption(props: {
  label: string;
  value?: string;
  selected: boolean;
  highlighted: boolean;
  size?: "default" | "compact";
  disabled?: boolean;
  action?: ListboxOptionAction;
  /** Optional marker shown at the end of the row (e.g. a status dot). It sits in
   *  the same spot as the action: the action replaces it while the row is hovered. */
  marker?: JSX.Element;
  /** Hide the check mark on the selected row, when the trigger already shows the selection. */
  hideSelectedCheck?: boolean;
  onSelect: () => void;
  onHover: () => void;
  "data-testid"?: string;
}) {
  return (
    <div
      role="option"
      data-value={props.value}
      data-testid={props["data-testid"]}
      aria-selected={props.selected}
      class={`group flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-dls-text ${props.size === "compact" ? "text-caption" : "text-body-lg"}`}
      classList={{
        "bg-dls-panel-hover-bg": props.highlighted,
        "hover:bg-dls-panel-hover-bg": !props.highlighted && !props.disabled,
        "opacity-50 cursor-not-allowed": props.disabled,
      }}
      onMouseEnter={() => props.onHover()}
      onMouseDown={(event) => {
        event.preventDefault();
        if (props.disabled) return;
        props.onSelect();
      }}
    >
      <span class="truncate">{props.label}</span>
      <div class="flex shrink-0 items-center gap-1.5">
        <Show when={props.selected && !props.hideSelectedCheck}>
          <Check size={14} class="shrink-0 text-dls-success-dot" />
        </Show>
        {/* The marker and the action stack in one grid cell, so they overlap. */}
        <div class="grid place-items-center">
          <Show when={props.marker}>
            {/* pointer-events-none: opacity-0 lifts this above the action button, which would swallow its click. */}
            <span
              class="pointer-events-none col-start-1 row-start-1 flex h-6 w-6 items-center justify-center"
              classList={{
                "group-hover:opacity-0 group-focus-within:opacity-0":
                  Boolean(props.action) && !props.action?.busy,
                "opacity-0": Boolean(props.action?.busy),
              }}
            >
              {props.marker}
            </span>
          </Show>
          <Show when={props.action}>
            {(action) => (
              <button
                type="button"
                class="col-start-1 row-start-1 flex h-6 w-6 items-center justify-center rounded-control text-dls-secondary hover:bg-dls-danger-bg hover:text-dls-danger-text disabled:opacity-50"
                classList={{
                  "opacity-0 group-hover:opacity-100 focus-visible:opacity-100":
                    !action().busy,
                }}
                aria-label={action().label}
                disabled={action().busy || action().disabled}
                onMouseDown={(event) => {
                  // Only stop the row's mousedown handler from selecting this
                  // option. We deliberately don't preventDefault so the button
                  // still receives focus; the action runs on click so keyboard
                  // (Enter/Space) activation works too.
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  // type="button" has no default action, so stopPropagation
                  // alone keeps the click from bubbling to the option row.
                  event.stopPropagation();
                  if (action().busy) return;
                  action().onAction();
                }}
              >
                <Show when={action().busy} fallback={action().icon}>
                  <Loader2 size={13} class="animate-spin" />
                </Show>
              </button>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
