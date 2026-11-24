import type { TavilyApiKeyAvailability } from "../../shared/platform/transport/instance-api";

export type TavilyKeyRequestStatus = "idle" | "loading" | "saving" | "error";

/** What the app knows about the key. `loading` and `unreadable` are not "not configured". */
export type TavilyKeyView =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "unreadable"; message: string }
  | { kind: "known"; configured: boolean; enabled: boolean };

export function tavilyKeyView(input: {
  availability: TavilyApiKeyAvailability | null;
  status: TavilyKeyRequestStatus;
  error: string | null;
}): TavilyKeyView {
  const { availability, status, error } = input;
  if (availability?.available === false) return { kind: "unavailable" };
  if (availability?.available === true) {
    return { kind: "known", configured: availability.configured, enabled: availability.enabled };
  }
  return status === "error" ? { kind: "unreadable", message: error ?? "" } : { kind: "loading" };
}

export type TavilyKeyControls = {
  badge: "configured" | "paused" | "not_configured" | "unavailable" | "unreadable" | "loading";
  inputDisabled: boolean;
  clearDisabled: boolean;
  showRecommendation: boolean;
  canRetry: boolean;
};

/** The Settings row: the badge, which controls work, and whether it offers a retry. */
export function tavilyKeyControls(view: TavilyKeyView, status: TavilyKeyRequestStatus): TavilyKeyControls {
  const busy = status === "loading" || status === "saving";
  switch (view.kind) {
    case "known":
      return {
        badge: !view.configured ? "not_configured" : view.enabled ? "configured" : "paused",
        inputDisabled: busy,
        clearDisabled: busy || !view.configured,
        showRecommendation: !view.configured,
        canRetry: false,
      };
    case "unavailable":
      return { badge: "unavailable", inputDisabled: true, clearDisabled: true, showRecommendation: false, canRetry: false };
    case "unreadable":
      return { badge: "unreadable", inputDisabled: true, clearDisabled: true, showRecommendation: false, canRetry: true };
    case "loading":
      return { badge: "loading", inputDisabled: true, clearDisabled: true, showRecommendation: false, canRetry: false };
  }
}

/** The default agent's reminder: say so only when the key is missing, or when we could not tell. */
export function tavilySessionWarning(view: TavilyKeyView): "none" | "not_configured" | "unreadable" {
  if (view.kind === "unreadable") return "unreadable";
  return view.kind === "known" && !view.configured ? "not_configured" : "none";
}
