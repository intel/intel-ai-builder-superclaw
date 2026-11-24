/** Thin wrappers over the platform open/reveal actions used by Settings. */
import { isTauriRuntime } from "../utils";

export async function openUrl(url: string) {
  let host = "unknown";
  try {
    host = new URL(url).host || "unknown";
  } catch {
    host = "invalid-url";
  }
  console.info(
    `[ui] external open intent source=settings.openUrl host=${host}`,
  );
  if (isTauriRuntime()) {
    const [{ invoke }, { openUrl }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/plugin-opener"),
    ]);
    // The Gmail guide opens pages without a click in SuperClaw; without this the
    // browser opens them behind SuperClaw.
    try {
      await invoke("allow_browser_foreground");
    } catch {
      // Best effort: the page still opens, just possibly behind SuperClaw.
    }
    await openUrl(url);
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export async function revealItemInDir(path: string) {
  if (!isTauriRuntime()) return;
  const { openPath, revealItemInDir } =
    await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path).catch(() => openPath(path));
}
