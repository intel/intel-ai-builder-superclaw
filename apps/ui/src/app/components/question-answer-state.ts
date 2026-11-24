import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { QuestionInfo } from "@opencode-ai/sdk/v2/client";

import {
    allowsCustomAnswer,
    answersFromDrafts,
    emptyDraft,
    hasAnswer,
    optionValue,
    type QuestionDraft,
} from "./question-answers";

export type QuestionStateProps = {
    /** The question can be answered now (a request is pending and its session is loaded). */
    open: boolean;
    /** The request being answered. The state starts over when it changes, not when the list is refreshed. */
    requestId?: string;
    questions: QuestionInfo[];
    busy: boolean;
    /** The question comes from a subagent, not from the session on screen. */
    fromSubagent?: boolean;
    /** Dismiss the whole request without answering. */
    onClose: () => void;
    onReply: (answers: string[][]) => void;
};

/** Pause after a single-select click, so the pick is visible before moving on. */
const AUTO_ADVANCE_MS = 200;

/**
 * Where the user is in an agent `question` request and what they have answered so far.
 * Shared by the option panel (which shows the choices) and the composer (whose editor
 * takes the typed answer and whose button row holds Back / Skip / Next), so it lives
 * outside both.
 */
export function createQuestionAnswerState(props: QuestionStateProps) {
    const [currentIndex, setCurrentIndex] = createSignal(0);
    const [drafts, setDrafts] = createSignal<QuestionDraft[]>([]);
    const [focusedOptionIndex, setFocusedOptionIndex] = createSignal(0);
    let advanceTimer: ReturnType<typeof setTimeout> | undefined;

    const cancelAdvance = () => {
        clearTimeout(advanceTimer);
        advanceTimer = undefined;
    };
    onCleanup(cancelAdvance);

    // A question event for any session refreshes the pending list and hands us a
    // new `questions` array; only a new request or a reopen may wipe the user's input.
    createEffect(
        on(
            () => [props.open, props.requestId] as const,
            ([open]) => {
                cancelAdvance();
                if (!open) return;
                setCurrentIndex(0);
                setDrafts(props.questions.map(emptyDraft));
                setFocusedOptionIndex(0);
            },
        ),
    );

    const question = createMemo(() => props.questions[currentIndex()]);
    const isFirst = createMemo(() => currentIndex() === 0);
    const isLast = createMemo(() => currentIndex() === props.questions.length - 1);
    const draft = createMemo(() => drafts()[currentIndex()] ?? emptyDraft());
    const customAllowed = createMemo(() => {
        const q = question();
        return q ? allowsCustomAnswer(q) : false;
    });
    const canProceed = createMemo(() => {
        const q = question();
        return q ? hasAnswer(q, draft().selection, draft().text) : false;
    });

    const updateDraft = (index: number, next: QuestionDraft) =>
        setDrafts((prev) => {
            const copy = [...prev];
            copy[index] = next;
            return copy;
        });

    const goTo = (index: number) => {
        cancelAdvance();
        setCurrentIndex(index);
        // Put the cursor on the option already picked, so Back does not leave the highlight
        // on option 1 while the real pick sits elsewhere.
        const picked = props.questions[index]?.options.findIndex(
            (opt) => drafts()[index]?.selection.includes(optionValue(opt)),
        );
        setFocusedOptionIndex(picked !== undefined && picked > 0 ? picked : 0);
    };

    const submit = (finalDrafts: QuestionDraft[]) => {
        cancelAdvance();
        props.onReply(answersFromDrafts(props.questions, finalDrafts));
    };

    return {
        open: () => props.open,
        requestId: () => props.requestId,
        busy: () => props.busy,
        fromSubagent: () => Boolean(props.fromSubagent),
        questions: () => props.questions,
        question,
        currentIndex,
        isFirst,
        isLast,
        draft,
        customAllowed,
        canProceed,
        focusedOptionIndex,
        setFocusedOptionIndex,

        /** The typed answer for the current question. */
        text: () => draft().text,
        setText(text: string) {
            const q = question();
            if (!q) return;
            const single = !q.multiple;
            // Typing replaces a single-select pick (and its pending advance).
            if (single && text.trim()) cancelAdvance();
            const { selection } = draft();
            updateDraft(currentIndex(), {
                selection: single && text.trim() ? [] : selection,
                text,
            });
        },

        toggleOption(option: string) {
            const q = question();
            if (!q) return;
            const index = currentIndex();

            if (q.multiple) {
                const { selection, text } = draft();
                updateDraft(index, {
                    selection: selection.includes(option) ? selection.filter((o) => o !== option) : [...selection, option],
                    text,
                });
                return;
            }

            // The last thing the user did wins: picking an option drops typed text.
            updateDraft(index, { selection: [option], text: "" });
            cancelAdvance();
            // The last question waits for an explicit Submit; the earlier ones move on.
            if (!isLast()) {
                advanceTimer = setTimeout(() => {
                    advanceTimer = undefined;
                    if (currentIndex() === index) goTo(index + 1);
                }, AUTO_ADVANCE_MS);
            }
        },

        /** Next question, or on the last one send the answers. */
        next() {
            if (!canProceed() || props.busy) return;
            if (isLast()) submit(drafts());
            else goTo(currentIndex() + 1);
        },

        // Skipping leaves the question empty; opencode tells the model `"<question>"="Unanswered"`.
        skip() {
            if (!question() || props.busy) return;
            const cleared = [...drafts()];
            cleared[currentIndex()] = emptyDraft();
            setDrafts(cleared);
            if (isLast()) submit(cleared);
            else goTo(currentIndex() + 1);
        },

        back() {
            if (isFirst() || props.busy) return;
            goTo(currentIndex() - 1);
        },

        close() {
            if (props.busy) return;
            cancelAdvance();
            props.onClose();
        },
    };
}

export type QuestionAnswerState = ReturnType<typeof createQuestionAnswerState>;
