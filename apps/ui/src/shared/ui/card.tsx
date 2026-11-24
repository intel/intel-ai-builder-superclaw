import type { JSX } from "solid-js";

type CardProps = {
  title?: string;
  children: JSX.Element;
  actions?: JSX.Element;
  /**
   * Extra classes on the card root. Needed for equal-height grid layouts: pass
   * `flex flex-col` so the root can hand its height (given by the grid's
   * `items-stretch`) down to the body. Do NOT also pass `h-full` — an explicit
   * height opts the item out of stretch and can't resolve against an auto-sized
   * row (see agent-creator's Custom Setup two-column grid).
   */
  class?: string;
  headerClass?: string;
  /**
   * Extra classes on the body wrapper — pair with `class` to pass height on.
   * `flex flex-1 flex-col` is the intended value: `flex-1` grows the body to the
   * stretched height without letting it shrink below its own content, and the
   * flex context lets children keep growing without percentage heights.
   */
  bodyClass?: string;
};

export default function Card(props: CardProps) {
  return (
    <div class={`rounded-inset bg-dls-surface border border-dls-border shadow-[var(--dls-card-shadow-rest)] transition-shadow hover:shadow-[var(--dls-card-shadow-rest-hover)] ${props.class ?? ""}`}>
      {props.title || props.actions ? (
        <div class={`flex items-center justify-between gap-3 border-b border-dls-border px-5 py-4 ${props.headerClass ?? ""}`}>
          <div class="text-body-lg font-semibold text-dls-text">{props.title}</div>
          <div>{props.actions}</div>
        </div>
      ) : null}
      <div class={`px-5 py-4 ${props.bodyClass ?? ""}`}>{props.children}</div>
    </div>
  );
}
