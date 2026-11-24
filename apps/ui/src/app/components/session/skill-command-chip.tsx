import { Show, createSignal, splitProps } from "solid-js";
import type { JSX } from "solid-js";
import { ChevronRight } from "lucide-solid";
import { t } from "../../../i18n";
import type { SkillCard } from "~/shared/types/extensions";
import {
  parseSkillCommandExpansion,
  resolveSkillName,
} from "~/shared/util/skill-command-expansion";
import PartView from "../part-view";
import type { Props as PartViewProps } from "../part-view.types";
import { partToText } from "./message-text";

/** PartView, but a user message that is an expanded skill command renders as its chip. */
export function SkillCommandPartView(props: PartViewProps & { skills?: SkillCard[] }) {
  const [local, partProps] = splitProps(props, ["skills"]);
  const skillCommand = () =>
    partProps.isUserMessage ? parseSkillCommandExpansion(partToText(partProps.part)) : null;

  return (
    <Show when={skillCommand()} fallback={<PartView {...partProps} />}>
      {(command) => (
        <SkillCommandChip
          skillName={resolveSkillName(command(), local.skills)}
          instructions={command().instructions}
        >
          <Show when={command().arguments}>
            <PartView
              {...partProps}
              part={{ ...partProps.part, text: command().arguments } as PartViewProps["part"]}
            />
          </Show>
        </SkillCommandChip>
      )}
    </Show>
  );
}

export default function SkillCommandChip(props: {
  skillName: string;
  instructions: string;
  /** The user's arguments, rendered by the caller so search highlighting still applies. */
  children?: JSX.Element;
}) {
  const [expanded, setExpanded] = createSignal(false);

  return (
    <div class="flex flex-col gap-1.5" data-skill-command={props.skillName}>
      <div class="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
        <span class="inline-flex shrink-0 items-center rounded-subtle border border-dls-border bg-dls-surface px-1.5 py-0.5 font-mono text-label text-dls-text">
          /{props.skillName}
        </span>
        <div class="min-w-0">{props.children}</div>
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-1 self-start rounded-micro text-caption text-dls-secondary transition-colors hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--dls-accent-rgb)/0.35)]"
        aria-expanded={expanded()}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight
          size={12}
          class={`shrink-0 transition-transform ${expanded() ? "rotate-90" : ""}`}
        />
        {expanded()
          ? t("session.skill_command_hide_instructions")
          : t("session.skill_command_show_instructions")}
      </button>
      <Show when={expanded()}>
        <div class="max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words rounded-inset border border-dls-border bg-dls-surface px-3 py-2 text-caption leading-5 text-dls-text">
          {props.instructions}
        </div>
      </Show>
    </div>
  );
}
