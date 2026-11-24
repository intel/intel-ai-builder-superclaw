import { isTauriRuntime, safeStringify } from "../utils";
import { recordPerfLog } from "./perf-log";
import { normalizeUpdateExternalUrl } from "~/shared/util/update-manifest";

/** Opens only an HTTPS github.com page; the offer already narrowed it to the update's repository. */
export async function openUpdateDownloadPage(url: string): Promise<void> {
  const trustedUrl = normalizeUpdateExternalUrl(url);
  if (!trustedUrl) {
    recordPerfLog(true, "app.updater", "view-update-refused", {});
    console.warn("[ui] external open refused source=app.update-button: not a github.com page");
    return;
  }
  const requestedUrl = url.trim();
  const urlAdjusted = requestedUrl !== trustedUrl;
  const host = new URL(trustedUrl).host;
  recordPerfLog(true, "app.updater", "view-update-clicked", {
    url: trustedUrl,
    urlAdjusted,
  });
  console.info(
    `[ui] external open intent source=app.update-button host=${host}`,
  );

  try {
    if (isTauriRuntime()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(trustedUrl);
    } else {
      window.open(trustedUrl, "_blank", "noopener,noreferrer");
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : safeStringify(e);
    recordPerfLog(true, "app.updater", "view-update-open-failed", {
      host,
      error: message,
    });
    console.warn("[ui] external open failed source=app.update-button", e);
  }
}
