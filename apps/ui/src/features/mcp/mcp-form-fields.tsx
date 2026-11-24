import { Index, Show, createSignal } from "solid-js";
import { Eye, EyeOff, Lock, Plus, Trash2 } from "lucide-solid";
import TextInput from "~/shared/ui/text-input";
import { t, type Language } from "../../i18n";
import type { KeyValueRow } from "./mcp-input-parse";

/**
 * Field components shared by the custom Add form and the catalog short form, so a
 * catalog card and a hand-entered server are edited with the same controls.
 */

const FIELD_LABEL_CLASS = "mb-1 text-caption font-medium text-dls-secondary";
const ICON_BUTTON_CLASS =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text";

export type SecretInputProps = {
  label?: string;
  placeholder?: string;
  value: string;
  onInput: (value: string) => void;
  autofocus?: boolean;
  language: Language;
};

export function SecretInput(props: SecretInputProps) {
  const [visible, setVisible] = createSignal(false);
  const toggleLabel = () => t(visible() ? "mcp.hide_value" : "mcp.show_value", props.language);

  return (
    <div class="block">
      <Show when={props.label}>
        <div class={FIELD_LABEL_CLASS}>{props.label}</div>
      </Show>
      <div class="flex items-center gap-1">
        <div class="min-w-0 flex-1">
          <TextInput
            type={visible() ? "text" : "password"}
            aria-label={props.label ?? props.placeholder}
            placeholder={props.placeholder}
            class="placeholder:text-dls-secondary/50"
            value={props.value}
            onInput={(event) => props.onInput(event.currentTarget.value)}
            autofocus={props.autofocus}
            autocomplete="new-password"
          />
        </div>
        <button
          type="button"
          class={ICON_BUTTON_CLASS}
          aria-label={toggleLabel()}
          title={toggleLabel()}
          onClick={() => setVisible((current) => !current)}
        >
          <Show when={visible()} fallback={<Eye size={16} />}>
            <EyeOff size={16} />
          </Show>
        </button>
      </div>
    </div>
  );
}

export type KeyValueRowsProps = {
  label: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  language: Language;
};

/** Editable name/value rows (environment variables); values are masked. */
export function KeyValueRows(props: KeyValueRowsProps) {
  const tr = (key: string) => t(key, props.language);
  const update = (index: number, patch: Partial<KeyValueRow>) =>
    props.onChange(props.rows.map((row, current) => current === index ? { ...row, ...patch } : row));

  return (
    <div class="space-y-2">
      <div class={FIELD_LABEL_CLASS}>{props.label}</div>
      <Index each={props.rows}>
        {(row, index) => (
          <div class="flex items-center gap-2" data-testid="mcp-key-value-row">
            <div class="w-2/5 shrink-0">
              <TextInput
                aria-label={`${props.keyPlaceholder} ${index + 1}`}
                placeholder={props.keyPlaceholder}
                class="font-mono placeholder:text-dls-secondary/50"
                value={row().key}
                onInput={(event) => update(index, { key: event.currentTarget.value })}
                autocomplete="off"
              />
            </div>
            <div class="min-w-0 flex-1">
              <SecretInput
                placeholder={props.valuePlaceholder}
                value={row().value}
                onInput={(value) => update(index, { value })}
                language={props.language}
              />
            </div>
            <button
              type="button"
              class={`${ICON_BUTTON_CLASS} hover:bg-dls-danger-bg hover:text-dls-danger-text`}
              aria-label={`${tr("mcp.remove_row")} ${row().key || index + 1}`}
              title={tr("mcp.remove_row")}
              onClick={() => props.onChange(props.rows.filter((_, current) => current !== index))}
            >
              <Trash2 size={15} />
            </button>
          </div>
        )}
      </Index>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 text-caption font-medium text-dls-info-text hover:text-dls-info-text"
        onClick={() => props.onChange([...props.rows, { key: "", value: "" }])}
      >
        <Plus size={13} />
        {props.addLabel}
      </button>
    </div>
  );
}

export type CommandLineInputProps = {
  label: string;
  value: string;
  onInput?: (value: string) => void;
  placeholder?: string;
  hint?: string;
  locked?: boolean;
  autofocus?: boolean;
  language: Language;
};

/** Monospace single-line input for a server command; `locked` pins a catalog command. */
export function CommandLineInput(props: CommandLineInputProps) {
  return (
    <div class="block">
      <div class={`${FIELD_LABEL_CLASS} flex items-center gap-1.5`}>
        {props.label}
        <Show when={props.locked}>
          <Lock size={11} aria-label={t("mcp.command_locked", props.language)} />
        </Show>
      </div>
      <TextInput
        aria-label={props.label}
        placeholder={props.placeholder}
        hint={props.hint}
        class={`font-mono text-caption placeholder:text-dls-secondary/50 ${props.locked ? "cursor-not-allowed opacity-70" : ""}`}
        value={props.value}
        readOnly={props.locked}
        onInput={(event) => props.onInput?.(event.currentTarget.value)}
        autofocus={props.autofocus}
        autocomplete="off"
        spellcheck={false}
      />
    </div>
  );
}

export type LocalOptionsFieldsProps = {
  env: KeyValueRow[];
  onEnvChange: (rows: KeyValueRow[]) => void;
  language: Language;
};

/** Environment rows for a local (stdio) server. */
export function LocalOptionsFields(props: LocalOptionsFieldsProps) {
  const tr = (key: string) => t(key, props.language);
  return (
    <KeyValueRows
      label={tr("mcp.env_vars")}
      rows={props.env}
      onChange={props.onEnvChange}
      keyPlaceholder={tr("mcp.env_name_placeholder")}
      valuePlaceholder={tr("mcp.env_value_placeholder")}
      addLabel={tr("mcp.add_env_var")}
      language={props.language}
    />
  );
}
