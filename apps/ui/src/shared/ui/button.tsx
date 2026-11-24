import { splitProps } from "solid-js";
import type { JSX } from "solid-js";

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "outline" | "danger" | "blue" | "green";
};

export default function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "class", "disabled", "title", "type"]);
  const variant = () => local.variant ?? "primary";

  const base =
    "inline-flex items-center justify-center gap-2 rounded-control px-4 py-2 text-body-lg font-medium transition-all duration-150 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-[rgb(var(--dls-accent-rgb)/0.3)] disabled:opacity-50 disabled:cursor-not-allowed";

  const variants: Record<NonNullable<ButtonProps["variant"]>, string> = {
    primary: "text-white border border-transparent shadow-[0_1px_3px_rgb(var(--dls-accent-rgb)/0.25)] [background:var(--dls-accent-gradient)] hover:[background:var(--dls-accent-gradient-hover)]",
    secondary: "bg-dls-btn-secondary-bg text-dls-btn-secondary-text hover:bg-dls-btn-secondary-hover-bg border border-transparent font-semibold",
    ghost: "bg-transparent text-dls-btn-ghost-text hover:bg-dls-btn-ghost-hover-bg hover:text-dls-btn-ghost-hover-text",
    outline: "border border-dls-btn-outline-border text-dls-btn-outline-text bg-transparent hover:bg-dls-btn-outline-hover-bg",
    danger: "bg-dls-danger-bg text-dls-danger-text hover:opacity-90 border border-dls-danger-border",
    blue: "border border-dls-info dark:border-dls-info-border bg-dls-info text-white hover:bg-dls-info/80",
    green: "bg-dls-success-bg text-dls-success-text hover:opacity-90 border border-dls-success-border",
  };

  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      disabled={local.disabled}
      aria-disabled={local.disabled}
      title={local.title}
      class={`${base} ${variants[variant()]} ${local.class ?? ""}`.trim()}
    />
  );
}
