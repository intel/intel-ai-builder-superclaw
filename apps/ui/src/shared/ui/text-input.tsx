import { splitProps, JSX } from "solid-js";

type TextInputProps = JSX.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
};

export const formControlChromeClass =
  "bg-dls-panel-input-bg text-dls-panel-text border border-dls-panel-input-border focus:outline-none focus:ring-2 focus:ring-[rgb(var(--dls-accent-rgb)/0.3)] focus:border-[var(--dls-accent)] transition-all";

export const formControlClass =
  `w-full rounded-control ${formControlChromeClass} px-3 py-2 text-body-lg`;

export default function TextInput(props: TextInputProps) {
  const [local, rest] = splitProps(props, ["label", "hint", "class", "ref"]);

  return (
    <label class="block">
      {local.label ? (
        <div class="mb-1 text-caption font-medium text-dls-secondary">{local.label}</div>
      ) : null}
      <input
        {...rest}
        ref={local.ref}
        class={`${formControlClass} placeholder:text-dls-secondary ${
          local.class ?? ""
        }`.trim()}
      />
      {local.hint ? <div class="mt-1 text-caption text-dls-secondary">{local.hint}</div> : null}
    </label>
  );
}
