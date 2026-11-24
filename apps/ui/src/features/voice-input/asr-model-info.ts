/**
 * Facts about the local speech model that the UI states before the user commits
 * to the download.
 */

/** Shown in the consent dialog. */
export const ASR_MODEL_NAME = "Parakeet TDT 0.6B (int8)";

/**
 * Advertised size, used as the progress bar's denominator until the service
 * reports a real `total_bytes`.
 *
 * 630 MB is the number the plan puts in front of the user, so it is also the
 * number the UI shows — if the packaged artefact ever changes size, the copy and
 * this constant must move together rather than one of them drifting.
 */
export const ASR_MODEL_BYTES = 630_000_000;
