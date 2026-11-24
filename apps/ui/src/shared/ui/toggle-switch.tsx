import { splitProps } from "solid-js";
import type { JSX } from "solid-js";

type ToggleSwitchProps = Omit<
  JSX.ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange" | "children"
> & {
  checked: boolean;
  onChange: (checked: boolean) => void;
};

export default function ToggleSwitch(props: ToggleSwitchProps) {
  const [local, rest] = splitProps(props, [
    "checked",
    "onChange",
    "class",
    "disabled",
    "type",
    "title",
    "onClick",
  ]);

  const callClickHandler = (
    handler: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent> | undefined,
    event: MouseEvent & {
      currentTarget: HTMLButtonElement;
      target: Element;
    },
  ) => {
    if (typeof handler === "function") {
      handler(event);
      return;
    }

    if (Array.isArray(handler)) {
      const [boundHandler, data] = handler as [
        (
          data: unknown,
          event: MouseEvent & {
            currentTarget: HTMLButtonElement;
            target: Element;
          },
        ) => void,
        unknown,
      ];
      boundHandler(data, event);
    }
  };

  const handleClick: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (
    event,
  ) => {
    if (local.disabled) return;
    callClickHandler(local.onClick, event);
    if (event.defaultPrevented) return;
    local.onChange(!local.checked);
  };

  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      role="switch"
      aria-checked={local.checked}
      disabled={local.disabled}
      aria-disabled={local.disabled}
      title={local.title}
      onClick={handleClick}
      class={[
        "relative inline-flex h-8 w-16 shrink-0 items-center rounded-pill border transition-colors duration-320 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
        "focus:outline-none focus:ring-2 focus:ring-[rgb(var(--dls-accent-rgb)/0.3)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        local.checked
          ? "border-dls-success-border bg-dls-success-bg"
          : "border-dls-border bg-dls-hover",
        local.class ?? "",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 flex items-center justify-start pl-2 text-tiny font-semibold uppercase tracking-[0.08em] text-dls-success-text transition-opacity duration-320 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
        style={{ opacity: local.checked ? 1 : 0 }}
      >
        On
      </span>
      <span
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 flex items-center justify-end pr-2 text-tiny font-semibold uppercase tracking-[0.08em] text-dls-secondary transition-opacity duration-320 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
        style={{ opacity: local.checked ? 0 : 1 }}
      >
        Off
      </span>
      {/* Knob slides via transform; animating left/right cannot transition off `auto`. */}
      <span
        aria-hidden="true"
        class="pointer-events-none absolute left-1 top-1 h-6 w-6 rounded-pill bg-dls-switch-thumb shadow-sm ring-1 ring-dls-switch-thumb-ring transition-transform duration-420 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform motion-reduce:transition-none"
        style={{
          transform: local.checked
            ? "translateX(calc(2rem - 2px))"
            : "translateX(0)",
        }}
      />
    </button>
  );
}
