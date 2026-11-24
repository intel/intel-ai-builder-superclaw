import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";

import { Check, ChevronDown, ChevronLeft, ChevronUp, HelpCircle, X } from "lucide-solid";

import { t } from "../../i18n";
import type { QuestionAnswerState } from "./question-answer-state";
import { optionValue } from "./question-answers";

const isEditable = (el: Element | null): boolean =>
    !!el &&
    (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        (el as HTMLElement).isContentEditable);

/**
 * The agent's `question` tool, shown above the composer so the conversation stays
 * readable. It lists the options; the typed answer goes in the composer's editor
 * and Back / Skip / Next sit in the composer's button row (see `QuestionActions`).
 */
export default function QuestionPanel(props: { state: QuestionAnswerState }) {
    const state = props.state;
    const [collapsed, setCollapsed] = createSignal(false);
    let root: HTMLDivElement | undefined;

    createEffect(
        on(
            () => [state.open(), state.requestId(), state.currentIndex()] as const,
            () => setCollapsed(false),
        ),
    );

    // The agent is waiting, so keys should work at once. Leave focus alone if the
    // user is in the middle of typing something else.
    createEffect(
        on(
            () => [state.open(), state.requestId()] as const,
            ([open]) => {
                if (!open) return;
                // Look now: the composer swaps its draft for the (empty) answer a moment later.
                const active = document.activeElement;
                const typing =
                    active !== null &&
                    isEditable(active) &&
                    (active.textContent || (active as HTMLInputElement).value || "").trim() !== "";
                queueMicrotask(() => {
                    if (!typing) root?.focus({ preventScroll: true });
                });
            },
        ),
    );

    // Next / Skip / Back in the composer take focus with the click; bring it back so the
    // keys keep working on the next question.
    createEffect(
        on(
            () => state.currentIndex(),
            () => {
                const active = document.activeElement;
                if (state.open() && !isEditable(active) && !root?.contains(active)) root?.focus({ preventScroll: true });
            },
            { defer: true },
        ),
    );

    createEffect(() => {
        if (!state.open()) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            const active = document.activeElement;
            // Only the panel's own keys. Another dialog's Esc, or a key already handled, is not ours;
            // so is scrolling the chat with the arrows while focus is elsewhere.
            if (e.defaultPrevented || !root?.contains(active)) return;

            // Esc during IME composition cancels the composition, not the panel.
            if (e.key === "Escape") {
                if (e.isComposing || e.keyCode === 229) return;
                e.preventDefault();
                state.close();
                return;
            }

            if (collapsed()) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            // Enter on a focused Back / Skip / Next button is that button's click.
            if (
                e.key === "Enter" &&
                active?.tagName === "BUTTON" &&
                active.getAttribute("data-testid") !== "question-option"
            ) {
                return;
            }

            const q = state.question();
            if (!q) return;

            const optionsCount = q.options.length;

            if (e.key === "ArrowDown") {
                e.preventDefault();
                state.setFocusedOptionIndex((prev) => (prev + 1) % optionsCount);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                state.setFocusedOptionIndex((prev) => (prev - 1 + optionsCount) % optionsCount);
            } else if (e.key === "Enter") {
                if (e.isComposing || e.keyCode === 229) return;
                e.preventDefault();

                const opt = q.options[state.focusedOptionIndex()];
                if (opt) {
                    state.toggleOption(optionValue(opt));
                }
            } else if (/^[1-9]$/.test(e.key)) {
                const opt = q.options[Number(e.key) - 1];
                if (opt) {
                    e.preventDefault();
                    state.setFocusedOptionIndex(Number(e.key) - 1);
                    state.toggleOption(optionValue(opt));
                }
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
    });

    return (
        <Show when={state.open() && state.question()}>
            <div class="mx-auto w-full max-w-[800px] px-4 pb-2">
                <div
                    ref={root}
                    tabindex="-1"
                    role="group"
                    aria-label={state.question()!.header || t("question.fallback_header")}
                    data-testid="question-modal"
                    class="flex max-h-[45vh] flex-col overflow-hidden rounded-dialog border border-dls-border bg-dls-surface-solid shadow-[var(--dls-card-shadow)] focus:outline-none"
                >
                    <div class="flex items-center gap-2 px-3 py-2">
                        <div class="w-6 h-6 shrink-0 rounded-pill bg-dls-info-bg flex items-center justify-center text-dls-info-text">
                            <HelpCircle size={14} />
                        </div>
                        <button
                            type="button"
                            data-testid="question-collapse-btn"
                            aria-expanded={!collapsed()}
                            aria-label={collapsed() ? t("question.expand") : t("question.collapse")}
                            onClick={() => setCollapsed((c) => !c)}
                            class="flex min-w-0 flex-1 items-center gap-2 rounded-inset text-left hover:bg-dls-hover/50"
                        >
                            <span class="shrink-0 text-body font-semibold text-dls-text">
                                {state.question()!.header || t("question.fallback_header")}
                            </span>
                            <Show when={state.questions().length > 1}>
                                <span class="shrink-0 text-caption font-medium text-dls-secondary">
                                    {state.currentIndex() + 1}/{state.questions().length}
                                </span>
                            </Show>
                            <Show when={collapsed()}>
                                <span class="min-w-0 truncate text-body text-dls-secondary">{state.question()!.question}</span>
                            </Show>
                            <span class="ml-auto shrink-0 text-dls-secondary">
                                {collapsed() ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                            </span>
                        </button>
                        <button
                            data-testid="question-dismiss-btn"
                            type="button"
                            title={t("question.dismiss")}
                            aria-label={t("question.dismiss")}
                            disabled={state.busy()}
                            onClick={() => state.close()}
                            class="shrink-0 hover:bg-dls-hover p-1 rounded-pill disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <X size={16} class="text-dls-secondary" />
                        </button>
                    </div>

                    <Show when={!collapsed()}>
                        <div class="min-h-0 flex-1 overflow-y-auto border-t border-dls-border/60 px-3 py-2">
                            <Show when={state.fromSubagent()}>
                                <p class="mb-0.5 text-caption text-dls-secondary">{t("question.from_subagent")}</p>
                            </Show>
                            <p class="text-body text-dls-text leading-relaxed">{state.question()!.question}</p>
                            <Show when={state.question()!.multiple}>
                                <p class="mt-0.5 text-caption text-dls-secondary">{t("question.multiple_hint")}</p>
                            </Show>

                            <div class="mt-2 space-y-1.5">
                                <For each={state.question()!.options}>
                                    {(opt, idx) => {
                                        const value = optionValue(opt);
                                        const isSelected = () => state.draft().selection.includes(value);
                                        const isFocused = () => state.focusedOptionIndex() === idx();

                                        return (
                                            <button
                                                type="button"
                                                data-testid="question-option"
                                                aria-pressed={isSelected()}
                                                class={`w-full text-left px-3 py-2 rounded-inset border text-body transition-all duration-200 flex items-center justify-between gap-3 group
                        ${isSelected()
                                                        ? "bg-dls-accent/10 border-dls-accent/30 text-dls-text shadow-sm"
                                                        : "bg-dls-surface-solid border-dls-border hover:border-dls-border text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                                                    }
                        ${isFocused() ? "ring-2 ring-dls-accent/20 border-dls-accent/40 bg-dls-surface-tint" : ""}
                      `}
                                                onFocus={() => state.setFocusedOptionIndex(idx())}
                                                onClick={() => {
                                                    state.setFocusedOptionIndex(idx());
                                                    state.toggleOption(value);
                                                }}
                                            >
                                                <span class="min-w-0">
                                                    <span class="block font-medium">{value}</span>
                                                    <Show when={opt.description && opt.description !== value}>
                                                        <span class="block text-caption text-dls-secondary">
                                                            {opt.description}
                                                        </span>
                                                    </Show>
                                                </span>
                                                <Show
                                                    when={isSelected()}
                                                    fallback={
                                                        <Show when={idx() < 9}>
                                                            <span class="shrink-0 px-1.5 py-0.5 rounded-compact border border-dls-border bg-dls-surface-tint font-mono text-caption text-dls-secondary">
                                                                {idx() + 1}
                                                            </span>
                                                        </Show>
                                                    }
                                                >
                                                    <div class="w-5 h-5 shrink-0 rounded-pill bg-dls-accent flex items-center justify-center shadow-sm">
                                                        <Check size={12} class="text-white" strokeWidth={3} />
                                                    </div>
                                                </Show>
                                            </button>
                                        );
                                    }}
                                </For>
                            </div>
                        </div>
                    </Show>
                </div>
            </div>
        </Show>
    );
}

/** Back / Skip / Next, for the composer's button row where Send normally is. */
export function QuestionActions(props: { state: QuestionAnswerState }) {
    const state = props.state;
    return (
        <>
            <Show when={!state.isFirst()}>
                <button
                    type="button"
                    data-testid="question-back-btn"
                    disabled={state.busy()}
                    onClick={() => state.back()}
                    title={t("question.back")}
                    aria-label={t("question.back")}
                    class="inline-flex items-center justify-center rounded-pill border border-dls-border p-2.5 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <ChevronLeft size={16} />
                </button>
            </Show>
            <button
                type="button"
                data-testid="question-skip-btn"
                disabled={state.busy()}
                onClick={() => state.skip()}
                class="inline-flex items-center rounded-pill px-3 py-2.5 text-body font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-50"
            >
                {t("question.skip")}
            </button>
            <button
                type="button"
                data-testid="question-next-btn"
                disabled={!state.canProceed() || state.busy()}
                onClick={() => state.next()}
                class={`inline-flex items-center gap-2 rounded-pill px-4 py-2.5 text-body font-medium transition-colors ${
                    !state.canProceed() || state.busy()
                        ? "bg-dls-active text-dls-secondary"
                        : "bg-dls-info text-white hover:bg-[var(--dls-accent-hover)]"
                }`}
            >
                {state.isLast() ? t("question.submit") : t("question.next")}
            </button>
        </>
    );
}
