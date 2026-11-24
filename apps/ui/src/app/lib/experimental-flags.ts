/**
 * Build-time gates for internal experiment knobs in the Settings UI.
 *
 * Each helper resolves a single Vite env var to a boolean. Vite substitutes
 * ``import.meta.env.VITE_*`` at build time, so builds can hide the gated UI
 * section when the flag is falsy. Note: if the component is statically imported
 * (e.g. in settings.tsx), it may still be present in the bundle/output.
 * Set the env var on the shell/CI that runs `pnpm build` to hide the corresponding UI section.
 *
 * Truthy values (case-insensitive): "1", "true", "yes", "on".
 * Falsy values (case-insensitive): "0", "false", "no", "off".
 * Empty string and unset (undefined) both fall back to the second arg of `_flag`.
 */

function _flag(raw: unknown, defaultValue: boolean): boolean {
  if (typeof raw !== "string") return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "") return defaultValue;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  // Unrecognized value: preserve the default rather than silently flipping.
  return defaultValue;
}

/**
 * Local llama-server ``-c`` context-size override slider (sits under
 * ``<PerfWeightSlider />`` in Settings). Internal experiment knob — hide
 * before shipping to end users.
 *
 * Default: ON. Set ``VITE_SHOW_LOCAL_CTX_SLIDER=0`` in the release build
 * environment to hide.
 */
export function showLocalCtxSlider(): boolean {
  return _flag(import.meta.env.VITE_SHOW_LOCAL_CTX_SLIDER, true);
}
