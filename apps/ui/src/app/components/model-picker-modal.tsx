import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { Portal } from "solid-js/web";

import { CheckCircle2, Circle, Pencil, Search, X } from "lucide-solid";
import { t, currentLocale } from "../../i18n";

import Button from "./button";
import { modelEquals } from "../utils";
import type { ModelOption, ModelRef } from "../types";
import type { SettingsModelSection } from "../pages/settings.model-section";

// Local and Cloud rows carry a pencil that opens their card in Settings → Model.
const MODEL_SETTINGS_SECTION: Record<string, SettingsModelSection | undefined> = {
  "local-model": "local",
  "cloud-model": "cloud",
};

export type ModelPickerModalProps = {
  open: boolean;
  options: ModelOption[];
  filteredOptions: ModelOption[];
  query: string;
  setQuery: (value: string) => void;
  target: "default" | "session";
  current: ModelRef;
  onSelect: (model: ModelRef) => void;
  onClose: (options?: { restorePromptFocus?: boolean }) => void;
  /** When true, another modal is layered on top – suppress keyboard shortcuts */
  suspended?: boolean;
  /** The pencil on the Local or Cloud row. With no handler, no pencil shows. */
  onEditSettings?: (section: SettingsModelSection) => void;
};

export default function ModelPickerModal(props: ModelPickerModalProps) {
  let searchInputRef: HTMLInputElement | undefined;
  const translate = (key: string) => t(key, currentLocale());

  const [activeIndex, setActiveIndex] = createSignal(0);
  const optionRefs: HTMLButtonElement[] = [];

  const connectedOptions = createMemo(() =>
    props.filteredOptions.filter((opt) => opt.isConnected),
  );

  const activeModelIndex = createMemo(() => {
    const list = connectedOptions();
    return list.findIndex(
      (opt) =>
        modelEquals(props.current, {
          providerID: opt.providerID,
          modelID: opt.modelID,
        }),
    );
  });

  const clampIndex = (next: number) => {
    const last = connectedOptions().length - 1;
    if (last < 0) return 0;
    return Math.max(0, Math.min(next, last));
  };

  const scrollActiveIntoView = (idx: number) => {
    const el = optionRefs[idx];
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
  };

  createEffect(() => {
    if (!props.open) return;
    requestAnimationFrame(() => {
      searchInputRef?.focus();
      if (searchInputRef?.value) {
        searchInputRef.select();
      }
    });
  });

  createEffect(() => {
    if (!props.open) return;
    const idx = activeModelIndex();
    const next = idx >= 0 ? idx : 0;
    setActiveIndex(clampIndex(next));
    requestAnimationFrame(() => scrollActiveIntoView(clampIndex(next)));
  });

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!props.open || props.suspended) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((current) => {
          const next = clampIndex(current + 1);
          requestAnimationFrame(() => scrollActiveIntoView(next));
          return next;
        });
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((current) => {
          const next = clampIndex(current - 1);
          requestAnimationFrame(() => scrollActiveIntoView(next));
          return next;
        });
        return;
      }

      if (event.key === "Enter") {
        if (event.isComposing || event.keyCode === 229) return;
        // A focused pencil handles its own Enter: it opens settings and must
        // not pick the highlighted row. This listener runs first (window,
        // capture), so it has to step aside rather than rely on the button.
        if (event.target instanceof Element && event.target.closest("[data-model-picker-edit]")) return;
        const idx = activeIndex();
        const opt = connectedOptions()[idx];
        if (!opt) return;
        event.preventDefault();
        event.stopPropagation();
        props.onSelect({ providerID: opt.providerID, modelID: opt.modelID });
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const renderOption = (opt: ModelOption, index: number) => {
    const active = () =>
      modelEquals(props.current, {
        providerID: opt.providerID,
        modelID: opt.modelID,
      });

    const editSection = props.onEditSettings ? MODEL_SETTINGS_SECTION[opt.modelID] : undefined;

    return (
      <div class="relative">
        <button
          ref={(el) => {
            optionRefs[index] = el;
          }}
          data-testid="model-picker-option"
          class={`w-full text-left rounded-card border px-4 py-3 transition-colors ${
            index === activeIndex()
              ? "border-dls-border-strong bg-dls-inverse-surface/10"
              : active()
                ? "border-dls-border-strong bg-dls-inverse-surface/5"
                : "border-dls-border-strong bg-dls-panel-inset-bg hover:bg-dls-panel-inset-bg"
          }`}
          onMouseEnter={() => {
            setActiveIndex(index);
          }}
          onClick={() => {
            props.onSelect({
              providerID: opt.providerID,
              modelID: opt.modelID,
            });
          }}
        >
          <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="text-body-lg font-medium text-dls-text flex items-center gap-2">
                  <span class="truncate">{opt.title}</span>
                </div>
                <Show when={opt.footer}>
                  <div class="text-label text-dls-secondary font-mono mt-2">{opt.footer}</div>
                </Show>
              </div>

            {/* Room for the pencil, which sits over this slot. */}
            <Show when={editSection}>
              <div class="w-7 shrink-0" aria-hidden="true" />
            </Show>
            <div class="pt-0.5 text-dls-secondary">
              <Show when={active()} fallback={<Circle size={14} />}>
                <CheckCircle2 size={14} class="text-dls-success-text" />
              </Show>
            </div>
          </div>
        </button>
        {/* A sibling of the row, not inside it: a button cannot hold a button. */}
        <Show when={editSection}>
          {(section) => (
            <button
              type="button"
              data-testid={`model-picker-edit-${section()}`}
              data-model-picker-edit
              class="absolute right-[42px] top-2 flex h-7 w-7 items-center justify-center rounded-control text-dls-secondary transition-colors hover:bg-dls-surface-tint hover:text-dls-text"
              // Names the row, so a screen reader can tell the Local pencil from the Cloud one.
              aria-label={translate("settings.edit_model_settings_named").replace("{model}", opt.title)}
              title={translate("settings.edit_model_settings")}
              onClick={() => props.onEditSettings?.(section())}
            >
              <Pencil size={13} />
            </button>
          )}
        </Show>
      </div>
    );
  };

  return (
    <Show when={props.open}>
      <Portal>
        <div class="fixed inset-0 z-50 bg-dls-panel-inset-bg backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto" data-testid="model-picker-modal">
        <div class="bg-dls-surface-raised border border-dls-border-strong w-full max-w-lg rounded-card shadow-2xl overflow-hidden max-h-[calc(100vh-2rem)] flex flex-col">
          <div class="p-6 flex flex-col min-h-0">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-heading font-semibold text-dls-text">
                  {props.target === "default" ? translate("settings.default_model") : translate("settings.session_model")}
                </h3>
              </div>
              <Button
                variant="ghost"
                class="!p-2 rounded-pill"
                onClick={() => props.onClose()}
              >
                <X size={16} />
              </Button>
            </div>

            <div class="mt-5">
              <div class="relative">
                <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-dls-secondary" />
                <input
                  ref={(el) => (searchInputRef = el)}
                  type="text"
                  value={props.query}
                  onInput={(e) => props.setQuery(e.currentTarget.value)}
                  placeholder={translate("settings.search_models")}
                  data-testid="model-picker-search-input"
                  class="w-full bg-dls-surface border border-dls-border rounded-inset py-2.5 pl-9 pr-3 text-body-lg text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-1 focus:ring-[rgb(var(--dls-accent-rgb)/0.2)] focus:border-dls-accent"
                />
              </div>
              <Show when={props.query.trim()}>
                <div class="mt-2 text-caption text-dls-secondary">
                  {translate("settings.showing_models").replace("{count}", String(props.filteredOptions.length)).replace("{total}", String(props.options.length))}
                </div>
              </Show>
            </div>

            <div class="mt-4 space-y-4 overflow-y-auto pr-1 -mr-1 min-h-0">
              <Show when={connectedOptions().length > 0}>
                <section class="space-y-2">
                  <div class="px-1 text-label font-semibold uppercase tracking-[0.12em] text-dls-secondary">
                    {translate("settings.routing_mode")}
                  </div>
                  <For each={connectedOptions()}>{(opt, index) => renderOption(opt, index())}</For>
                </section>
              </Show>

              <Show when={connectedOptions().length === 0}>
                <div class="rounded-card border border-dls-border-strong bg-dls-panel-inset-bg px-4 py-6 text-body-lg text-dls-secondary">
                  {props.query.trim() ? translate("settings.no_models_match") : translate("settings.no_providers_connected")}
                </div>
              </Show>
            </div>

            <div class="mt-5 flex items-center justify-end shrink-0">
              <Button variant="outline" onClick={() => props.onClose()}>
                {translate("settings.done")}
              </Button>
            </div>
          </div>
        </div>
        </div>
      </Portal>
    </Show>
  );
}
