import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Check, ChevronDown } from "lucide-solid";
import { t } from "../../../i18n";
import type { ModelOption, ModelRef } from "../../types";
import { formatComposerModelLabel } from "~/shared/util/llmrouter-session-model-label";
import { Tooltip } from "~/shared/ui/tooltip";

type ComposerModelPickerProps = {
  busy: boolean;
  open: boolean;
  selectedLabel: string;
  selectedModel: ModelRef;
  selectedModelIsLocal: boolean;
  options: ModelOption[];
  onToggle: () => void;
  onClose: () => void;
  onSelect: (model: ModelRef) => void;
  onManage: () => void;
  setRef: (element: HTMLDivElement) => void;
};

export function ComposerModelPicker(props: ComposerModelPickerProps) {
  const [pickerOffset, setPickerOffset] = createSignal(0);
  let rootRef: HTMLDivElement | undefined;
  let quickPickerRef: HTMLDivElement | undefined;

  const repositionQuickPicker = () => {
    if (!rootRef || !quickPickerRef) return;

    const anchorRect = rootRef.getBoundingClientRect();
    const margin = 16;
    const minLeft = margin;
    const maxLeft = window.innerWidth - margin - quickPickerRef.offsetWidth;
    const left = Math.min(Math.max(anchorRect.left, minLeft), maxLeft);
    setPickerOffset(left - anchorRect.left);
  };

  createEffect(() => {
    if (!props.open) {
      setPickerOffset(0);
      return;
    }

    requestAnimationFrame(repositionQuickPicker);
    window.addEventListener("resize", repositionQuickPicker);
    onCleanup(() => window.removeEventListener("resize", repositionQuickPicker));
  });

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    props.onClose();
  };

  return (
    <div
      class="relative"
      ref={(element) => {
        rootRef = element;
        props.setRef(element);
      }}
      data-tour-id="composer-model"
      onKeyDown={handleKeyDown}
    >
      <Tooltip
        content={t("composer.model_picker_tooltip")}
        placement="bottom"
        maxWidthClass="max-w-[180px]"
        disabled={props.open}
      >
        <button
          type="button"
          data-testid="model-picker-btn"
          class="flex items-center gap-1.5 rounded-control px-2 py-1.5 text-body font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
          onClick={props.onToggle}
          disabled={props.busy}
          aria-label={t("composer.model_picker_tooltip")}
          aria-expanded={props.open}
        >
          <span
            classList={{
              "text-dls-model-local-text": props.selectedModelIsLocal,
            }}
          >
            {formatComposerModelLabel(props.selectedLabel)}
          </span>
          <ChevronDown
            size={14}
            class="transition-transform duration-200"
            classList={{ "rotate-180": props.open }}
          />
        </button>
      </Tooltip>

      <Show when={props.open}>
        <div
          ref={quickPickerRef}
          data-testid="model-quick-picker"
          class="absolute left-0 bottom-full z-40 mb-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-dialog border border-dls-border bg-dls-surface-solid shadow-[var(--dls-shell-shadow)]"
          style={{ transform: `translateX(${pickerOffset()}px)` }}
        >
          <div class="p-2 space-y-1">
            <For each={props.options}>
              {(model) => {
                const active = () =>
                  props.selectedModel.providerID === model.providerID &&
                  props.selectedModel.modelID === model.modelID;
                return (
                  <button
                    type="button"
                    data-testid="model-picker-option"
                    class={`w-full flex items-center justify-between rounded-control px-3 py-2 text-left text-caption transition-colors ${
                      active()
                        ? "bg-dls-hover text-dls-text"
                        : "text-dls-secondary hover:bg-dls-hover/70"
                    }`}
                    onClick={() => props.onSelect(model)}
                  >
                    <span class="shrink-0 truncate">
                      {formatComposerModelLabel(model.title)}
                    </span>
                    <span class="ml-3 flex min-w-0 items-center gap-2 text-dls-secondary">
                      <Show
                        when={model.modelID === "auto"}
                        fallback={
                          <Show when={model.footer}>
                            <span class="truncate">{model.footer}</span>
                          </Show>
                        }
                      >
                        <span class="truncate">
                          {t("composer.auto_model_description")}
                        </span>
                      </Show>
                      <Show when={active()}>
                        <Check size={14} class="shrink-0 text-dls-secondary" />
                      </Show>
                    </span>
                  </button>
                );
              }}
            </For>
            <button
              type="button"
              data-testid="model-picker-manage"
              class="w-full rounded-control border-t border-dls-border px-3 py-2 text-left text-caption text-dls-secondary transition-colors hover:bg-dls-hover/70"
              onClick={props.onManage}
            >
              {t("composer.manage_models")}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
