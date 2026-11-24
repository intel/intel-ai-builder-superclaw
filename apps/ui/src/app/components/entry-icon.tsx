import { createSignal } from "solid-js";

type IconProps = {
  size?: number;
  class?: string;
};

/**
 * SuperClaw Logo — hybrid brain icon representing local + cloud LLM synergy.
 *
 * Left hemisphere (dark slate) = Local LLM, right hemisphere (blue) = Cloud LLM.
 * Central node with dashed orbit ring represents the sync/orchestration layer.
 * Animated data-exchange particles flow vertically through the center.
 *
 * Hover dynamics:
 * - Left/right hemispheres split apart with smooth transition
 * - Text labels brighten and follow their hemisphere
 * - Orbit ring spins (CSS animation)
 * - Core node pulses (CSS animation)
 */
export function SuperClawIcon(props: IconProps) {
  const s = () => props.size ?? 28;
  const [hovered, setHovered] = createSignal(false);

  // Transition shared by all animated elements
  const transition = "transform 0.5s ease, opacity 0.5s ease";

  return (
    <svg
      width={s()}
      height={s()}
      viewBox="0 0 200 200"
      fill="none"
      class={props.class}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ cursor: "pointer" }}
    >
      <defs>
        <linearGradient id="sc-local-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="var(--dls-local-model-icon-start)" />
          <stop offset="100%" stop-color="var(--dls-local-model-icon-end)" />
        </linearGradient>
        <linearGradient id="sc-cloud-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="var(--dls-cloud-model-icon-start)" />
          <stop offset="100%" stop-color="var(--dls-cloud-model-icon-end)" />
        </linearGradient>
      </defs>

      {/* Background glow */}
      <circle cx="100" cy="100" r="90" fill="currentColor" fill-opacity="0.15" />

      {/* Left hemisphere: Local LLM — slides left on hover */}
      <path
        d="M100 30 C60 30 30 60 30 100 C30 140 60 170 100 170 V100 Z"
        fill="url(#sc-local-grad)"
        style={{
          transition,
          transform: hovered() ? "translateX(-4px)" : "none",
        }}
      />

      {/* "LOCAL" label — follows left hemisphere, brightens on hover */}
      <text
        x="62"
        y="104"
        fill="white"
        font-size="10"
        font-weight="900"
        text-anchor="middle"
        style={{
          "font-family": "Inter, system-ui, sans-serif",
          "letter-spacing": "0.05em",
          transition,
          opacity: hovered() ? 1 : 0.7,
          transform: hovered() ? "translateX(-4px)" : "none",
        }}
      >
        LOCAL
      </text>

      {/* Right hemisphere: Cloud LLM — slides right on hover */}
      <path
        d="M100 30 C140 30 170 60 170 100 C170 140 140 170 100 170 V100 Z"
        fill="url(#sc-cloud-grad)"
        style={{
          transition,
          transform: hovered() ? "translateX(4px)" : "none",
        }}
      />

      {/* "CLOUD" label — follows right hemisphere, brightens on hover */}
      <text
        x="138"
        y="104"
        fill="white"
        font-size="10"
        font-weight="900"
        text-anchor="middle"
        style={{
          "font-family": "Inter, system-ui, sans-serif",
          "letter-spacing": "0.05em",
          transition,
          opacity: hovered() ? 1 : 0.8,
          transform: hovered() ? "translateX(4px)" : "none",
        }}
      >
        CLOUD
      </text>

      {/* Central sync orbit — spins on hover */}
      <circle
        cx="100"
        cy="100"
        r="16"
        stroke="white"
        stroke-width="1.5"
        stroke-dasharray="3 3"
        fill="white"
        fill-opacity="0.1"
        style={{
          "transform-origin": "100px 100px",
          animation: hovered() ? "sc-spin 6s linear infinite" : "none",
        }}
      />

      {/* Core node — pulses on hover */}
      <circle
        cx="100"
        cy="100"
        r="6"
        fill="white"
        style={{
          "transform-origin": "100px 100px",
          animation: hovered() ? "sc-pulse 2s ease-in-out infinite" : "none",
        }}
      />

      {/* Data exchange particles (always animated via SVG <animate>) */}
      <circle cx="100" cy="50" r="4.5" fill="white">
        <animate attributeName="cy" values="50;150;50" dur="2.5s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0;1;0" dur="2.5s" repeatCount="indefinite" />
      </circle>
      <circle cx="100" cy="150" r="4.5" fill="white">
        <animate attributeName="cy" values="150;50;150" dur="2.5s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0;1;0" dur="2.5s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}
