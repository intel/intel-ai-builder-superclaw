/**
 * What the first-launch model dialog is actually doing, read from the per-asset row
 * state LRM reports.
 *
 * The post-consent phase covers two different activities:
 *
 *   * verifying — the files are already on disk (a `-KeepModels` rebuild keeps the
 *     weights but drops the verification records), so the background operation is
 *     hashing them. No transfer is in flight.
 *   * downloading — bytes are actually being fetched.
 *
 * `metadata.files[].state` distinguishes them directly: `downloading` is emitted for
 * the whole of every local transfer (`downloader.py` `_do_download` / `_ensure_file`,
 * and `inference_logic.py`'s repair path), and nothing else emits it. A verify pass
 * reports no state of its own, so the row stays on whatever `set_files` seeded until
 * it settles.
 *
 * This used to be inferred from the byte counters instead (`doneBytes > 0` meaning "a
 * transfer is underway"). That reading was correct in the common case but wrong at
 * both ends, and the reported state is wrong at neither:
 *
 *   * a transfer whose first poll sample has not landed yet reports
 *     `downloading` with `done = 0` — `inference_logic.py` emits exactly that before
 *     handing off to the downloader — which the counters read as "verifying".
 *   * a partly cached asset is SEEDED with `done > 0` by `prepare_local_bundle`
 *     (`total - missing_bytes`, so a verified 35B model with a missing DFlash draft
 *     starts at the model's size) while its state is still `pending`. The counters
 *     read that as a transfer that has not started moving.
 *
 * It also removes a coupling: the old rule depended on how `set_files` seeds `done`,
 * so changing that seeding would have silently changed what the dialog claimed.
 *
 * State names are mapped through `bundle-switch-step-progress`, shared with the
 * restart checklist, so the two surfaces cannot derive different answers from the
 * same field — which is what let `downloading` be silently read as `pending` there.
 */

import {
  showsStepByteProgress,
  type BundleSwitchStepState,
} from "~/shared/util/bundle-switch-step-progress";

/** One asset row's live state, as the dialog receives it. */
export type DialogAssetProgress = {
  complete: boolean;
  /** Mapped `metadata.files[].state`; absent until the first poll tick lands. */
  state?: BundleSwitchStepState;
};

/**
 * What to tell the user during the post-consent phase.
 *
 * `failed` takes precedence over everything: once the switch has errored, the dialog
 * must stop implying work is still in progress.
 */
export type DownloadActivity = "verifying" | "downloading" | "ready" | "failed";

export function resolveDownloadActivity(
  assets: readonly DialogAssetProgress[],
  opts: { hasError: boolean; isReady: boolean },
): DownloadActivity {
  if (opts.hasError) return "failed";
  if (opts.isReady) return "ready";
  // Only a row that says it is transferring makes this a download. Before the first
  // poll tick no row has a state at all, which reads as verifying — honest, since
  // nothing has been reported yet.
  return assets.some((a) => !a.complete && a.state === "downloading")
    ? "downloading"
    : "verifying";
}

/**
 * Whether an asset row should show `done / total` or just its total size.
 *
 * A row that is neither transferring nor settled has no meaningful `done`, and
 * rendering `0.0 MB / 2740.9 MB` for it reads as a download stalled at zero — the
 * original issue-1613 complaint, and later the same lie told about an embedding that
 * was on disk the whole time and never downloaded.
 *
 * Settled rows keep their fraction: `ModelDownloader.download` closes every row at
 * `done = total` whether it downloaded or merely verified, and by then the row really
 * is ready, so `total / total` beside a tick is the honest reading.
 */
export function showsAssetByteProgress(asset: DialogAssetProgress): boolean {
  return asset.complete || showsStepByteProgress(asset.state ?? "pending");
}
