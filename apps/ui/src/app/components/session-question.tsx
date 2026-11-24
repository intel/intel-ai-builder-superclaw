import { createMemo } from "solid-js";

import { t } from "../../i18n";
import type { SessionViewProps } from "../pages/session.types";
import { createQuestionAnswerState } from "./question-answer-state";
import { QuestionActions } from "./question-panel";
import type { ComposerQuestionMode } from "./session/composer.types";

/**
 * Connects the session's pending agent `question` to the option panel and the
 * composer: the panel shows the choices, the composer's editor takes the typed
 * answer and its button row holds Back / Skip / Next.
 */
export function createSessionQuestion(
    props: Pick<SessionViewProps, "activeQuestion" | "questionReplyBusy" | "respondQuestion" | "rejectQuestion" | "selectedSessionId">,
    /** The session is loaded, so a pending question can be answered. */
    ready: () => boolean,
) {
    const state = createQuestionAnswerState({
        get open() {
            return Boolean(props.activeQuestion && ready());
        },
        get requestId() {
            return props.activeQuestion?.id;
        },
        get questions() {
            return props.activeQuestion?.questions ?? [];
        },
        get busy() {
            return props.questionReplyBusy;
        },
        get fromSubagent() {
            return Boolean(props.activeQuestion && props.activeQuestion.sessionID !== props.selectedSessionId);
        },
        onClose: () => {
            if (props.activeQuestion) props.rejectQuestion(props.activeQuestion.id);
        },
        onReply: (answers) => {
            if (props.activeQuestion) props.respondQuestion(props.activeQuestion.id, answers);
        },
    });
    const composerMode = createMemo<ComposerQuestionMode | undefined>(() =>
        state.open()
            ? {
                  placeholder: state.customAllowed() ? t("question.composer_placeholder") : t("question.composer_choose"),
                  inputDisabled: !state.customAllowed(),
                  text: state.text,
                  onTextChange: state.setText,
                  onSubmit: state.next,
                  actions: <QuestionActions state={state} />,
              }
            : undefined,
    );
    return { state, composerMode };
}
