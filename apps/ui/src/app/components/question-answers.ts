import type { QuestionInfo, QuestionOption } from "@opencode-ai/sdk/v2/client";

/**
 * Answer rules for the agent `question` dialog. opencode reads an unset
 * `custom` as "allowed" (QuestionInfo.custom: "default: true"), so only an
 * explicit `false` hides the text box.
 */
export const allowsCustomAnswer = (q: Pick<QuestionInfo, "custom">): boolean => q.custom !== false;

/**
 * opencode answers with the option's label (`QuestionReply`: "each answer is an
 * array of selected labels"), and the model wrote its options in terms of them.
 */
export const optionValue = (o: QuestionOption): string => o.label || o.description;

/**
 * An answer is the labels of the picked options, as opencode's `question.reply`
 * expects, plus the typed text. A single-select question takes one or the
 * other (the typed text wins); a multi-select one takes both.
 */
export function buildAnswer(
    q: Pick<QuestionInfo, "custom" | "multiple">,
    selection: string[],
    customText: string,
): string[] {
    const typed = allowsCustomAnswer(q) ? customText.trim() : "";
    if (!typed) return [...selection];
    return q.multiple ? [...selection, typed] : [typed];
}

export const hasAnswer = (
    q: Pick<QuestionInfo, "custom" | "multiple">,
    selection: string[],
    customText: string,
): boolean => buildAnswer(q, selection, customText).length > 0;

/** What the user has picked and typed so far for one question. */
export type QuestionDraft = { selection: string[]; text: string };

export const emptyDraft = (): QuestionDraft => ({ selection: [], text: "" });

/**
 * The reply for the whole request, one answer per question in order. A question
 * with no answer (skipped, or never filled in) is `[]`, which opencode turns
 * into `"<question>"="Unanswered"` in the tool result the model reads.
 */
export function answersFromDrafts(
    questions: Array<Pick<QuestionInfo, "custom" | "multiple">>,
    drafts: QuestionDraft[],
): string[][] {
    return questions.map((q, i) => buildAnswer(q, drafts[i]?.selection ?? [], drafts[i]?.text ?? ""));
}
