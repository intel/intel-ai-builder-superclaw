import { ErrorBoundary, type JSX } from "solid-js";

import { t } from "../../i18n";
import { uiLogError } from "../lib/log";

/**
 * Containment for render-time throws (backlog §B4).
 *
 * Without a boundary anywhere in the tree, a single throw during render unmounts
 * the whole SolidJS root and leaves a white screen. `lib/crash-suppression.ts`
 * only allowlists known crashes out of *telemetry* — it masks, it does not
 * contain. This contains.
 *
 * `variant` controls the fallback's footprint, not its behaviour:
 *  - `root`  — full-viewport; offers a reload because there is nothing left to use.
 *  - `panel` — inline; the rest of the app is still usable, so it only offers retry.
 *
 * Everything here is deliberately dependency-light and defensive: a crash screen
 * that can itself crash is worse than no crash screen. Translation lookups are
 * guarded, and the fallback reads no app state.
 */

/** Translate, but never throw and never render a raw key. */
function safeT(key: string, fallback: string): string {
  try {
    const value = t(key);
    return value && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
}

/** Best-effort human-readable text for anything that can be thrown. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Error";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

function stackOf(err: unknown): string | undefined {
  return err instanceof Error && typeof err.stack === "string" ? err.stack : undefined;
}

export type AppErrorBoundaryProps = {
  /** Stable identifier for the guarded region, e.g. "root" or "page:session". */
  scope: string;
  variant?: "root" | "panel";
  children: JSX.Element;
};

export function AppErrorBoundary(props: AppErrorBoundaryProps): JSX.Element {
  return (
    <ErrorBoundary
      fallback={(err, reset) => {
        // Logging lives inside the fallback because SolidJS calls it on the error
        // path only. Never let a telemetry failure suppress the fallback UI.
        try {
          uiLogError("ui.crash", `render failed in ${props.scope}`, {
            scope: props.scope,
            variant: props.variant ?? "panel",
            error: describeError(err),
            stack: stackOf(err),
          });
        } catch {
          /* logging is best-effort */
        }

        const isRoot = props.variant === "root";
        return (
          <div
            role="alert"
            class={isRoot ? "app-error-boundary app-error-boundary--root" : "app-error-boundary"}
            data-scope={props.scope}
          >
            <div class="app-error-boundary__title">
              {isRoot
                ? safeT("error_boundary.root_title", "SuperClaw hit an unexpected error")
                : safeT("error_boundary.panel_title", "This section failed to load")}
            </div>
            <div class="app-error-boundary__message">{describeError(err)}</div>
            <div class="app-error-boundary__actions">
              <button type="button" class="app-error-boundary__btn" onClick={() => reset()}>
                {safeT("error_boundary.retry", "Try again")}
              </button>
              {isRoot ? (
                <button
                  type="button"
                  class="app-error-boundary__btn"
                  onClick={() => {
                    try {
                      window.location.reload();
                    } catch {
                      /* non-browser host */
                    }
                  }}
                >
                  {safeT("error_boundary.reload", "Reload")}
                </button>
              ) : null}
            </div>
          </div>
        );
      }}
    >
      {props.children}
    </ErrorBoundary>
  );
}

export default AppErrorBoundary;
