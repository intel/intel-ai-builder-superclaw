/**
 * Deep links arriving from the desktop shell, and the deduplication that
 * keeps one user action from being handled several times.
 *
 * The OS can deliver the same URL twice — `getCurrent()` replays whatever
 * launched the app, and `onOpenUrl` fires again for the same activation — and
 * the app re-reads `getCurrent()` on every window focus and visibility
 * change. Two guards keep that to one handling: a per-URL window, and a
 * signature so a replay of an unchanged `getCurrent()` list is ignored
 * outright.
 *
 * The parsing lives in `features/workspace-import/deep-links`; this is only
 * the listener plumbing that used to sit inside app.tsx's mount.
 */

/** Handles a URL, reporting whether it claimed it. */
type DeepLinkConsumer = (url: string) => boolean;

/** How long the same URL is treated as a repeat of one activation. */
const REPEAT_WINDOW_MS = 1500;

/**
 * `source: "current"` marks a `getCurrent()` replay, which is checked against
 * the previous list as a whole; `"event"` marks a live delivery, which is not,
 * because a user may legitimately open the same link twice.
 */
export function createDeepLinkInbox(
  consume: DeepLinkConsumer,
  now: () => number = Date.now,
) {
  const recentDeepLinkEvents = new Map<string, number>();
  let lastObservedDeepLinkSignature: string | null = null;

  return (
    urls: string[] | null | undefined,
    source: "event" | "current" = "event",
  ): void => {
    if (!Array.isArray(urls)) return;

    const normalized = urls.map((url) => url.trim()).filter(Boolean);
    if (normalized.length === 0) return;

    const signature = normalized.join("\n");
    if (source === "current" && signature === lastObservedDeepLinkSignature) {
      return;
    }
    lastObservedDeepLinkSignature = signature;

    const at = now();
    for (const [url, seenAt] of recentDeepLinkEvents) {
      if (at - seenAt > REPEAT_WINDOW_MS) recentDeepLinkEvents.delete(url);
    }

    for (const url of normalized) {
      const seenAt = recentDeepLinkEvents.get(url) ?? 0;
      if (at - seenAt < REPEAT_WINDOW_MS) continue;
      recentDeepLinkEvents.set(url, at);
      if (consume(url)) break;
    }
  };
}

/**
 * Starts listening, and returns the teardown. Resolves to `null` when the
 * deep-link plugin is unavailable — the caller has nothing to undo then, and
 * a desktop build without the plugin should still boot.
 */
export async function watchTauriDeepLinks(
  consume: DeepLinkConsumer,
): Promise<(() => void) | null> {
  try {
    const { getCurrent, onOpenUrl } = await import(
      "@tauri-apps/plugin-deep-link"
    );
    const inbox = createDeepLinkInbox(consume);

    const syncCurrentDeepLinks = async () => {
      inbox(await getCurrent(), "current");
    };

    await syncCurrentDeepLinks();
    const unlisten = await onOpenUrl((urls) => {
      inbox(urls, "event");
    });

    const handleWindowFocus = () => {
      void syncCurrentDeepLinks().catch(() => undefined);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      void syncCurrentDeepLinks().catch(() => undefined);
    };
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      unlisten();
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  } catch {
    return null;
  }
}
