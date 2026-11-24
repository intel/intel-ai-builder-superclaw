import { createSignal } from "solid-js";

import { t } from "../../../i18n";
import { pickDirectory, readLocalFileBytes, scanLocalFolder } from "../../lib/tauri";
import type { ComposerProps, PendingFolderUpload } from "./composer.types";

const FOLDER_UPLOAD_BATCH_MAX_FILES = 25;
const FOLDER_UPLOAD_BATCH_MAX_BYTES = 8 * 1024 * 1024;

const folderNameFromPath = (path: string) => {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || "folder";
};

type ComposerFolderUploadDeps = {
  /** Read per call, so a parent that swaps the handler still wins. */
  uploadInboxFiles: () => ComposerProps["onUploadInboxFiles"];
  onToast: (message: string) => void;
};

export type ComposerFolderUpload = ReturnType<typeof createComposerFolderUpload>;

/**
 * Owns picking a local folder, confirming it, and uploading it to the
 * workspace inbox one batch at a time.
 */
export function createComposerFolderUpload(deps: ComposerFolderUploadDeps) {
  const [pending, setPending] = createSignal<PendingFolderUpload | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal<{
    done: number;
    total: number;
  } | null>(null);
  const [cancelling, setCancelling] = createSignal(false);
  let cancelRequested = false;

  /** Scan a folder and open the confirm-then-upload review. Rejects when the
   * path is not a readable folder, which matters for a pasted path. */
  const reviewPath = async (
    selected: string,
    onUploaded?: PendingFolderUpload["onUploaded"],
  ) => {
    // Metadata-only scan: contents are read one file at a time during the
    // confirmed upload, so arbitrarily large folders can't balloon memory
    // (the previous whole-folder read crashed the shell — issue #809).
    const scan = await scanLocalFolder(selected);
    if (!scan.entries.length) {
      deps.onToast(t("composer.folder_no_files"));
      return;
    }
    // The canonical root, so a pasted `D:\Report\.` is still named `Report`.
    setPending({ scan, folderName: folderNameFromPath(scan.root), onUploaded });
  };

  const pick = async () => {
    if (!deps.uploadInboxFiles()) return;
    try {
      const selected = await pickDirectory({
        title: t("composer.upload_folder"),
      });
      if (!selected || Array.isArray(selected)) return;
      await reviewPath(selected);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.onToast(message || t("composer.folder_read_failed"));
    }
  };

  const cancel = () => {
    if (busy()) {
      // Mid-upload: request a graceful stop at the next file boundary.
      cancelRequested = true;
      setCancelling(true);
      return;
    }
    setPending(null);
  };

  const confirm = async () => {
    const target = pending();
    if (!target || !deps.uploadInboxFiles() || busy()) return;
    setBusy(true);
    cancelRequested = false;
    setCancelling(false);
    const total = target.scan.entries.length;
    setProgress({ done: 0, total });
    const sep = target.scan.root.includes("\\") ? "\\" : "/";
    let done = 0;
    let failed = 0;
    let rejected = 0;
    let cancelled = false;
    let folderPath = "";
    try {
      let batch: File[] = [];
      let batchBytes = 0;
      const flushBatch = async () => {
        if (!batch.length) return;
        // Non-null: confirm() returns early unless the handler exists, and the
        // session does not drop it mid-upload.
        const uploaded = await Promise.resolve(
          deps.uploadInboxFiles()!(batch, { notify: false }),
        );
        if (!folderPath && Array.isArray(uploaded) && uploaded[0]) {
          folderPath = uploadedFolderPath(
            uploaded[0].path,
            batch[0].webkitRelativePath,
            target.folderName,
          );
        }
        // A handler that returns a list reports what it stored; a failed batch comes back empty.
        const stored = Array.isArray(uploaded) ? uploaded.length : batch.length;
        done += stored;
        rejected += batch.length - stored;
        setProgress({ done: done + rejected, total });
        batch = [];
        batchBytes = 0;
      };
      for (const entry of target.scan.entries) {
        if (cancelRequested) {
          cancelled = true;
          break;
        }
        try {
          const absPath =
            target.scan.root + sep + entry.relativePath.split("/").join(sep);
          const bytes = await readLocalFileBytes(absPath);
          const file = new File([new Uint8Array(bytes)], entry.name);
          Object.defineProperty(file, "webkitRelativePath", {
            value: `${target.folderName}/${entry.relativePath}`,
            configurable: true,
          });
          batch.push(file);
          batchBytes += entry.size || bytes.length;
        } catch {
          failed += 1;
        }
        if (
          batch.length >= FOLDER_UPLOAD_BATCH_MAX_FILES ||
          batchBytes >= FOLDER_UPLOAD_BATCH_MAX_BYTES
        ) {
          await flushBatch();
        }
      }
      // Flush unconditionally: on cancel the loop breaks BEFORE this point, so
      // the already-read (but not-yet-uploaded) batch must still go out — else
      // up to FOLDER_UPLOAD_BATCH_MAX_FILES files are silently dropped and the
      // progress/toast counts diverge (Copilot review, #824).
      await flushBatch();
      deps.onToast(
        folderUploadSummary({
          cancelled,
          done,
          total,
          failed: failed + rejected,
          folderName: target.folderName,
        }),
      );
      // An unreadable file is reported but does not stop the folder being linked;
      // a batch the server rejected leaves the folder incomplete in the workspace.
      if (!cancelled && !rejected && folderPath) target.onUploaded?.(folderPath);
      setPending(null);
    } finally {
      setBusy(false);
      setProgress(null);
      setCancelling(false);
      cancelRequested = false;
    }
  };

  return { pending, busy, progress, cancelling, pick, reviewPath, cancel, confirm };
}

/** Where the server put the folder: the first file's stored path minus the
 * part below the folder (`codex/README.md` was sent, `inbox/codex/README (2).md`
 * came back, so the folder is `inbox/codex`). Empty when the files are not under
 * it: the server strips a leading `workspace/`, so that folder is never created. */
function uploadedFolderPath(stored: string, sent: string, folderName: string) {
  const segments = stored.split("/");
  const folder = segments.slice(0, segments.length - (sent.split("/").length - 1));
  return folder.at(-1) === folderName ? folder.join("/") : "";
}

/**
 * t() has no interpolation, so summaries are composed from i18n fragments
 * (consistent with the rest of the composer's folder-upload strings).
 */
function folderUploadSummary(result: {
  cancelled: boolean;
  done: number;
  total: number;
  failed: number;
  folderName: string;
}): string {
  const of = t("composer.folder_summary_of");
  const filesFrom = t("composer.folder_summary_files_from");
  if (result.cancelled) {
    return `${t("composer.folder_summary_cancelled")} ${result.done} ${of} ${result.total} ${filesFrom} "${result.folderName}".`;
  }
  if (result.failed) {
    return `${t("composer.folder_summary_uploaded")} ${result.done} ${of} ${result.total} ${filesFrom} "${result.folderName}" (${result.failed} ${t("composer.folder_summary_failed")}).`;
  }
  return `${t("composer.folder_summary_uploaded")} ${result.done} ${filesFrom} "${result.folderName}".`;
}
