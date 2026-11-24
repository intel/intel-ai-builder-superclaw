import type { JSX } from "solid-js";

/**
 * The single source of truth for the model-connection card container styling.
 */
export const PROVIDER_CARD_CLASS =
  "bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-4";

/**
 * The single source of truth for field-label typography across the Edge, llama.cpp, and Cloud panels.
 */
export const FIELD_LABEL_CLASS = "block text-caption text-dls-secondary";

export type ProviderConnectionCardProps = {
  /** Extra classes appended to the shared container class. */
  class?: string;
  children?: JSX.Element;
};

/**
 * Shared container for the Settings → Model provider-connection panels (Edge,
 * llama.cpp, Cloud). It owns the card background/border so every panel renders
 * a single, consistent surface. Panels supply their own header, fields, and
 * action row as children.
 */
export default function ProviderConnectionCard(props: ProviderConnectionCardProps): JSX.Element {
  return <div class={`${PROVIDER_CARD_CLASS} ${props.class ?? ""}`.trim()}>{props.children}</div>;
}
