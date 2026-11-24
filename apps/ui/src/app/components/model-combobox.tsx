/**
 * A filtering model picker: a text input that is also a listbox.
 *
 * WHY THIS IS NOT `Dropdown`. `dropdown.tsx` renders every option it is given.
 * A live OpenRouter catalog is 389 entries (measured on this machine), and a
 * 389-row popover is not a selection mechanism — the user has a model id in mind
 * and needs to type it. So this control keeps `Dropdown`'s trigger box, popover
 * and option rows (all three come from `listbox.tsx`, which is why the two look
 * identical) and replaces only the "pick from a list" part with "type to narrow".
 *
 * WHY IT IS ITS OWN FILE. It was the bespoke middle of
 * `cloud-model-settings.tsx`, entangled with that card's save/test/provider
 * state. The dictation clean-up card needs the same control over the same
 * catalog, and the alternative was a second implementation of the dirty-query
 * and blur-revert rules below — two copies of four subtle behaviours, diverging
 * the first time either card was edited alone.
 *
 * It owns the combobox and nothing else: the query, the filtering, the keyboard
 * navigation and the revert. Fetching the options, reporting a fetch failure and
 * deciding what a pick means (this card saves immediately; another might not)
 * all stay with the caller, which is why {@link ModelComboboxProps.status} is a
 * slot rather than a set of flags.
 *
 * THE TWO NON-OBVIOUS RULES, both inherited verbatim and both load-bearing:
 *
 *  * **The dirty-query flag.** The input shows the selected model's label when
 *    the user has not typed; filtering only applies once they have. Without the
 *    flag, the displayed label *is* a query, so opening the menu would show one
 *    option — the one already selected — and the picker would look broken.
 *  * **Revert on blur.** Half-typed text left in the box claims a selection that
 *    was never made: the field would read "gpt" while the saved model is
 *    something else entirely. Leaving a field in that state is how a user ends up
 *    certain they changed a setting they did not.
 */
import { createEffect, createMemo, createSignal, For, on, Show, untrack, type JSX } from "solid-js";
import { ChevronDown } from "lucide-solid";

import { t } from "../../i18n";
import { cloudModelDisplayLabel } from "../lib/cloud-model-display-label";
import type { LlmRouterProviderModel } from "../lib/llmrouter-client";
import { FIELD_BOX_CLASS, ListboxOption, ListboxPopover } from "~/shared/ui/listbox";

// Show at most four models, then scroll. A row is 36px (py-2 plus a 20px
// line) and the popover adds 8px of padding: 4 * 36 + 8 = 152px = max-h-38.
const FOUR_ROWS_MAX_HEIGHT_CLASS = "max-h-38";

export type ModelComboboxProps = {
  /**
   * LLMRouter's own model shape, not a narrower local one. Both callers get
   * their list from `listProviderModels`, and `cloudModelDisplayLabel` — the one
   * place that decides what a model is *called* — is already typed against it.
   * A second, structurally-compatible option type would buy nothing and give the
   * label rule a second shape to satisfy.
   */
  options: readonly LlmRouterProviderModel[];
  /** The selected model id. Fully controlled — this component stores no selection. */
  value: string;
  onChange: (modelId: string) => void;
  placeholder?: string;
  disabled?: boolean;
  class?: string;
  /** Accessible name. There is no `<label for>` on this settings surface. */
  "aria-label"?: string;
  /**
   * `data-testid` stem: the input is `${testIdPrefix}-input`, each row is
   * `${testIdPrefix}-option`. A stem rather than one id because two instances of
   * this control can be on screen at once, and `[data-testid=cloud-model-option]`
   * would then match rows belonging to either.
   */
  testIdPrefix: string;
  /**
   * Caller-owned lines under the field — "loading models", a fetch failure, "this
   * provider returned none". They sit here rather than next to the caller's other
   * markup so they keep the field's tight `mt-1` spacing instead of inheriting
   * whatever gap the surrounding stack uses.
   */
  status?: JSX.Element;
};

export default function ModelCombobox(props: ModelComboboxProps) {
  const [query, setQuery] = createSignal("");
  const [queryDirty, setQueryDirty] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [highlight, setHighlight] = createSignal(0);

  const filtered = createMemo(() => {
    const list = props.options;
    const needle = query().trim().toLowerCase();
    if (!queryDirty() || !needle) return [...list];
    // Matched against the id as well as the name: users paste ids
    // ("minimax/minimax-m3") far more often than they retype a vendor's display
    // casing, and an id-blind filter makes a pasted id look like a dead end.
    return list.filter(
      (model) =>
        model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
    );
  });

  const menuVisible = createMemo(() => menuOpen() && filtered().length > 0);

  // The list shows four rows, so a selected model further down would be out of
  // sight. Each time it opens, start on the selected row and scroll it into view.
  let listEl: HTMLDivElement | undefined;
  createEffect(
    on(menuVisible, (visible) => {
      if (!visible || untrack(queryDirty)) return;
      const index = untrack(filtered).findIndex((model) => model.id === props.value);
      if (index < 0) return;
      setHighlight(index);
      listEl?.querySelectorAll<HTMLElement>('[role="option"]')[index]?.scrollIntoView({ block: "nearest" });
    }),
  );

  // Mirror the selection into the box whenever it (or the label table) changes,
  // but never while the user is mid-type — overwriting what someone is typing is
  // the one thing a filtering input must not do.
  createEffect(() => {
    const modelId = props.value;
    const options = props.options;
    if (!untrack(queryDirty)) setQuery(cloudModelDisplayLabel(modelId, options));
  });

  const commit = (modelId: string) => {
    setQuery(cloudModelDisplayLabel(modelId, props.options));
    setQueryDirty(false);
    setMenuOpen(false);
    props.onChange(modelId);
  };

  const revert = () => {
    setMenuOpen(false);
    setQueryDirty(false);
    setQuery(cloudModelDisplayLabel(props.value, props.options));
  };

  return (
    <div
      class={`relative ${props.class ?? ""}`}
      onFocusOut={(event) => {
        // Focus moving *within* the control (input → option row) is not a blur.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        revert();
      }}
    >
      <div class="relative">
        <input
          type="text"
          data-testid={`${props.testIdPrefix}-input`}
          class={`${FIELD_BOX_CLASS} pr-9 disabled:opacity-60`}
          value={query()}
          placeholder={props.placeholder}
          disabled={props.disabled}
          autocomplete="off"
          spellcheck={false}
          role="combobox"
          aria-label={props["aria-label"]}
          aria-expanded={menuVisible()}
          onFocus={() => setMenuOpen(true)}
          onClick={() => setMenuOpen(true)}
          onInput={(event) => {
            setQuery(event.currentTarget.value);
            setQueryDirty(true);
            setMenuOpen(true);
            setHighlight(0);
          }}
          onKeyDown={(event) => {
            const options = filtered();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setMenuOpen(true);
              if (options.length === 0) return;
              setHighlight((index) => Math.min(index + 1, options.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setMenuOpen(true);
              if (options.length === 0) return;
              setHighlight((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              const choice = options[highlight()];
              if (menuOpen() && choice) {
                event.preventDefault();
                commit(choice.id);
              }
            } else if (event.key === "Escape") {
              // Swallowed only when the menu is open, so Escape still reaches
              // whatever is behind this control the rest of the time.
              if (menuOpen()) {
                event.preventDefault();
                revert();
              }
            }
          }}
        />
        <ChevronDown
          size={16}
          class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-dls-secondary"
        />
      </div>
      <Show when={menuVisible()}>
        <ListboxPopover maxHeightClass={FOUR_ROWS_MAX_HEIGHT_CLASS} ref={(el) => (listEl = el)}>
          <For each={filtered()}>
            {(model, index) => (
              <ListboxOption
                label={model.name}
                value={model.id}
                data-testid={`${props.testIdPrefix}-option`}
                selected={props.value === model.id}
                highlighted={index() === highlight()}
                onHover={() => setHighlight(index())}
                onSelect={() => commit(model.id)}
              />
            )}
          </For>
        </ListboxPopover>
      </Show>
      {props.status}
      {/*
        "Nothing matches what you typed" is the one status line this control can
        answer, because the query is the only state it owns. Showing an empty
        popover instead would be indistinguishable from the menu having failed to
        open.
      */}
      <Show when={props.options.length > 0 && queryDirty() && filtered().length === 0}>
        <div class="mt-1 text-label text-dls-secondary" data-testid={`${props.testIdPrefix}-no-match`}>
          {t("settings.no_models_match")}
        </div>
      </Show>
    </div>
  );
}
