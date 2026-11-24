import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { Check, ExternalLink, Loader2 } from "lucide-solid";

import { t } from "../../i18n";
import type { GmailGuideStep, GmailSetupGuide } from "./settings.gmail-setup-guide";

type StepState = "done" | "current" | "todo";

function GuideStep(props: {
  number: number;
  state: StepState;
  title: string;
  children?: JSX.Element;
}) {
  return (
    <li class="flex gap-3" data-step-state={props.state}>
      <span
        class={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-pill text-label font-semibold ${
          props.state === "done"
            ? "bg-dls-success-bg text-dls-success-text"
            : props.state === "current"
              ? "bg-dls-accent text-white"
              : "bg-dls-panel-badge-bg text-dls-secondary"
        }`}
      >
        <Show when={props.state === "done"} fallback={props.number}>
          <Check size={12} />
        </Show>
      </span>
      <div class="min-w-0 flex-1 space-y-1.5">
        <div
          class={`text-caption font-medium ${
            props.state === "todo" ? "text-dls-secondary" : "text-dls-text"
          }`}
        >
          {props.title}
        </div>
        {props.children}
      </div>
    </li>
  );
}

function QuietButton(props: {
  onClick: () => void;
  testId?: string;
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      class="inline-flex items-center gap-1 text-label text-dls-accent underline underline-offset-2 hover:opacity-80"
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  );
}

function Waiting(props: { testId: string; children: JSX.Element }) {
  return (
    <div
      data-testid={props.testId}
      class="flex items-center gap-1.5 text-caption text-dls-info-text"
    >
      <Loader2 size={13} class="animate-spin" />
      {props.children}
    </div>
  );
}

const ORDER: GmailGuideStep[] = ["client", "signin", "apis"];

/** The guided path's steps. Only rendered while the guide is running. */
export default function GmailSetupGuidePanel(props: {
  guide: GmailSetupGuide;
  onManual: () => void;
}) {
  const step = () => props.guide.step();
  const stateOf = (s: GmailGuideStep): StepState => {
    const current = step();
    if (current === s) return "current";
    return current && ORDER.indexOf(current) > ORDER.indexOf(s) ? "done" : "todo";
  };
  const reopen = () => void props.guide.reopen();

  return (
    <div
      data-testid="gmail-setup-guide"
      class="rounded-inset border border-dls-border bg-dls-surface px-4 py-3 space-y-3"
    >
      <ol class="space-y-3">
        <GuideStep
          number={1}
          state={stateOf("client")}
          title={t("settings.gmail_guide_client_title")}
        >
          <Show when={step() === "client"}>
            <div class="text-caption text-dls-secondary">
              {t("settings.gmail_guide_client_body")}
            </div>
            <div class="text-caption text-dls-secondary">
              {t("settings.gmail_guide_client_audience")}
            </div>
            <Show when={props.guide.canWatch}>
              <Waiting testId="gmail-setup-watching">
                {t("settings.gmail_guide_watching")}
              </Waiting>
            </Show>
            <Show when={props.guide.showNoFileHint()}>
              <div data-testid="gmail-setup-no-file" class="text-caption text-dls-warning-text">
                {t("settings.gmail_guide_no_file")}{" "}
                <QuietButton onClick={props.onManual}>
                  {t("settings.gmail_setup_manual")}
                </QuietButton>
              </div>
            </Show>
            <QuietButton onClick={reopen}>
              <ExternalLink size={12} />
              {t("settings.gmail_guide_reopen")}
            </QuietButton>
          </Show>
        </GuideStep>

        <GuideStep
          number={2}
          state={stateOf("signin")}
          title={t("settings.gmail_guide_signin_title")}
        >
          <Show when={step() === "signin"}>
            <div class="text-caption text-dls-secondary">
              {t("settings.gmail_guide_signin_body")}
            </div>
            <QuietButton onClick={reopen}>
              <ExternalLink size={12} />
              {t("settings.gmail_guide_signin_reopen")}
            </QuietButton>
          </Show>
        </GuideStep>

        <GuideStep
          number={3}
          state={stateOf("apis")}
          title={t("settings.gmail_guide_apis_title")}
        >
          <Show when={step() === "apis" && props.guide.accessMissing()}>
            <div data-testid="gmail-setup-not-granted" class="text-caption text-dls-warning-text">
              {props.guide.signedOut()
                ? t("settings.gmail_guide_apis_signed_out")
                : t("settings.gmail_guide_apis_not_granted")}
            </div>
            <QuietButton onClick={reopen}>
              <ExternalLink size={12} />
              {t("settings.gmail_guide_signin_reopen")}
            </QuietButton>
          </Show>
          <Show when={step() === "apis" && !props.guide.accessMissing()}>
            <Show
              when={props.guide.apisDisabled()}
              fallback={
                <Waiting testId="gmail-setup-apis-checking">
                  {t("settings.gmail_guide_apis_checking")}
                </Waiting>
              }
            >
              <Waiting testId="gmail-setup-apis-waiting">
                {t("settings.gmail_guide_apis_waiting")}
              </Waiting>
              <QuietButton onClick={reopen}>
                <ExternalLink size={12} />
                {t("settings.gmail_guide_reopen")}
              </QuietButton>
            </Show>
          </Show>
        </GuideStep>
      </ol>

      <div class="flex flex-wrap items-center gap-4 border-t border-dls-border pt-2.5">
        {/* Manual setup is the upload; once a client is uploaded there is nothing manual left. */}
        <Show when={step() === "client"}>
          <QuietButton testId="gmail-setup-manual" onClick={props.onManual}>
            {t("settings.gmail_setup_manual")}
          </QuietButton>
        </Show>
        <QuietButton testId="gmail-setup-cancel" onClick={() => props.guide.stop()}>
          {t("settings.gmail_guide_cancel")}
        </QuietButton>
      </div>
    </div>
  );
}
