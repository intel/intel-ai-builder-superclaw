import { For } from "solid-js";

import TextInput, { formControlChromeClass } from "~/shared/ui/text-input";
import { t } from "../../i18n";

export type AgentEditMode = "form" | "markdown";

export function AgentEditModeToggle(props: {
  mode: AgentEditMode;
  disabled: boolean;
  onChange: (mode: AgentEditMode) => void;
}) {
  const modes: Array<{ id: AgentEditMode; label: () => string }> = [
    { id: "form", label: () => t("agents.edit_mode_form") },
    { id: "markdown", label: () => t("agents.edit_mode_markdown") },
  ];
  return (
    <div class="flex rounded-control border border-dls-border p-0.5" role="group">
      <For each={modes}>
        {(mode) => (
          <button
            type="button"
            data-testid={`agent-edit-mode-${mode.id}`}
            aria-pressed={props.mode === mode.id}
            disabled={props.disabled}
            class={`px-2.5 py-1 text-caption font-medium rounded-control transition-colors ${props.mode === mode.id
              ? "bg-dls-active text-dls-text"
              : "text-dls-secondary hover:bg-dls-hover"
              }`}
            onClick={() => props.onChange(mode.id)}
          >
            {mode.label()}
          </button>
        )}
      </For>
    </div>
  );
}

/**
 * Name and description of an existing agent. The name is the file name, so it
 * is shown read-only: renaming is a file move, not a frontmatter edit.
 */
export default function AgentEditForm(props: {
  name: string;
  description: string;
  readOnly: boolean;
  onDescriptionInput: (value: string) => void;
}) {
  return (
    <div class="space-y-5" data-testid="agent-edit-form">
      <TextInput
        data-testid="agent-edit-name-input"
        label={t("common.name")}
        value={props.name}
        readOnly
        hint={t("agents.edit_name_readonly")}
        class="cursor-default opacity-70"
      />
      <label class="block">
        <div class="mb-1 text-caption font-medium text-dls-secondary">{t("agents.description_title")}</div>
        <textarea
          data-testid="agent-edit-description-input"
          class={`w-full rounded-control ${formControlChromeClass} px-3 py-2 text-body-lg shadow-sm resize-y`}
          rows={4}
          value={props.description}
          readOnly={props.readOnly}
          onInput={(e) => props.onDescriptionInput(e.currentTarget.value)}
          placeholder={t("agents.description_placeholder")}
        />
      </label>
      <p class="text-caption text-dls-secondary">{t("agents.edit_form_scope")}</p>
    </div>
  );
}
