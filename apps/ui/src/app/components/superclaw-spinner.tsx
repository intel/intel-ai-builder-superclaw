type SuperClawSpinnerProps = {
  size?: number;
  class?: string;
};

/**
 * Animated SuperClaw mark — the three nested diamonds pulse outer → inner on a
 * stagger, preserving the three-beat rhythm of the bouncing dots it replaces.
 */
export function SuperClawSpinner(props: SuperClawSpinnerProps) {
  const s = () => props.size ?? 16;
  return (
    <svg
      width={s()}
      height={s()}
      viewBox="0 0 100 100"
      fill="none"
      class={props.class}
      aria-hidden="true"
    >
      <g transform="rotate(45 50 50)">
        <rect
          class="sc-diamond"
          x="14"
          y="14"
          width="72"
          height="72"
          rx="14"
          fill="var(--dls-accent)"
        />
        <rect
          class="sc-diamond"
          style={{ "animation-delay": "160ms" }}
          x="29"
          y="29"
          width="42"
          height="42"
          rx="10"
          fill="color-mix(in srgb, var(--dls-accent) 65%, var(--dls-white))"
        />
        <rect
          class="sc-diamond"
          style={{ "animation-delay": "320ms" }}
          x="40"
          y="40"
          width="20"
          height="20"
          rx="5"
          fill="var(--dls-accent)"
        />
      </g>
    </svg>
  );
}
