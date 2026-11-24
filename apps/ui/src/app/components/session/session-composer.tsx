import { createContext, Show, splitProps, useContext, type JSX } from "solid-js";
import Composer from "./composer";
import { ComposerToast } from "./composer-toast";
import { NarrationToggle } from "./narration-toggle";
import type { ComposerProps } from "./composer.types";

export type SessionReadOnlyReason = "subagent" | "loading" | null;

type SessionComposerProps = Omit<ComposerProps, "readOnly"> & {
  // "subagent" keeps Composer mounted but hidden so attachments and collapsed
  // paste survive parent → child → parent. "loading" keeps it visible with
  // Send disabled until metadata resolves.
  readOnly: SessionReadOnlyReason;
};

const PickerAccessoryContext = createContext<() => JSX.Element>();

/** What the session page puts in the composer's picker row, after the model picker. */
export const ComposerPickerAccessory = PickerAccessoryContext.Provider;

export default function SessionComposer(props: SessionComposerProps) {
  const [local, composerProps] = splitProps(props, ["readOnly"]);
  const pickerAccessory = useContext(PickerAccessoryContext);
  // A question the child session is waiting on has to be answerable here, so the composer shows for it.
  const isSubagent = () => local.readOnly === "subagent" && !props.questionMode;
  return (
    <>
      {/* Keep the instance alive across Open session / Parent task so draft
          state that only lives inside Composer (attachments, paste chips) is
          not disposed. Hide it on a confirmed child. readOnly also suspends
          voice capture (hotkeys / startRequest) inside Composer. */}
      <div
        data-testid="session-composer-draft"
        class={isSubagent() ? "hidden" : undefined}
        aria-hidden={isSubagent() ? true : undefined}
      >
        <Composer
          {...composerProps}
          // Toast is hosted beside the narration control while the composer is
          // hidden, so the same notice is not rendered twice.
          toast={isSubagent() ? null : props.toast}
          readOnly={local.readOnly !== null}
          pickerAccessory={composerProps.pickerAccessory ?? pickerAccessory?.()}
        />
      </div>

      <Show when={isSubagent()}>
        {/* Match the transcript: the message column and its scroller each
            paint bg-dls-surface, and in dark mode that token is translucent.
            One missing layer reads as a different band. Toast stays here so
            workspace-file errors still surface when the composer is hidden. */}
        <div class="bg-dls-surface">
          {/* Fixed-height track. The toast is absolute so it cannot grow this
              footer (that was shrinking the chat column and moving
              the "Scroll to end" button) or vertically re-center the speaker. */}
          <div
            data-testid="subagent-narration-bar"
            class="mx-auto max-w-[800px] px-4 pb-10 md:px-8"
          >
            <div class="relative h-10">
              <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                <Show
                  when={props.ttsAvailable}
                  fallback={
                    <Show when={props.toast}>
                      {(message) => (
                        <ComposerToast
                          message={message()}
                          voiceInput={props.voiceInput}
                          onDismiss={props.onDismissToast}
                        />
                      )}
                    </Show>
                  }
                >
                  <NarrationToggle
                    variant="pill"
                    narration={props.ttsNarration}
                    speaking={props.ttsSpeaking}
                    onToggle={() => props.toggleTtsNarration()}
                  />
                </Show>
              </div>
              <Show when={props.ttsAvailable && props.toast}>
                {(message) => (
                  <div class="absolute left-1/2 top-1/2 ml-5 -translate-y-1/2 pl-2">
                    <ComposerToast
                      message={message()}
                      voiceInput={props.voiceInput}
                      onDismiss={props.onDismissToast}
                    />
                  </div>
                )}
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
