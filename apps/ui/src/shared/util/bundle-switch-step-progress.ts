/**
 * How one row of a bundle-switch checklist should be drawn, from the raw operation
 * state LRM reports.
 *
 * The dialog's row states are a NARROWER set than what `metadata.files[].state`
 * carries, and the narrowing used to be a whitelist with a silent fallback:
 * anything unrecognised became `pending`. `downloading` -- the state every local
 * transfer reports (`downloader.py` `_do_download`, `inference_logic.py`'s
 * repair path) -- was not on that list, so a multi-GB download rendered as a
 * hollow "not started" circle for its entire duration, and nothing in the type
 * system objected because the source field is deliberately open
 * (`LlmRouterOperationFile.state` ends in `(string & {})` for forward
 * compatibility).
 *
 * So the mapping is total and named here instead: every state the backend is known
 * to emit has a case, and an unknown one still degrades to `pending` -- but now as
 * a stated default rather than an accident.
 *
 * `downloading` and `running` are kept distinct rather than collapsed, because only
 * one of them has meaningful bytes. The Edge probe steps report `running` with
 * `done=0, total=1` (a step counter, not a size), so rendering a size on them would
 * print `0.0 MB / 0.0 MB`.
 */

/** Row states the checklist can draw. Superset of what it used to accept. */
export type BundleSwitchStepState =
  | "pending"
  | "downloading"
  | "running"
  | "complete"
  | "error";

/**
 * The states LRM is known to pass to `file_progress`, listed once.
 *
 * `pending` is seeded by `prepare_local_bundle`; `downloading` comes from
 * `downloader.py` and `inference_logic.py`; `running`, `complete` and `error` from
 * the Edge probe steps in `bundle_adapter.py`; `complete` also from an asset
 * settling.
 *
 * Deriving the map's key type from this makes an unmapped entry a compile error, so
 * the list and the mapping cannot drift apart. It cannot catch the reverse -- a
 * backend that starts emitting a state nobody listed here -- because the source
 * field is deliberately open (`LlmRouterOperationFile.state` ends in `(string & {})`
 * so a newer service cannot fail an older client). That direction is what the
 * runtime default below covers, and closing it would need a cross-language check
 * against LRM's emitters rather than a type.
 */
const KNOWN_OPERATION_FILE_STATES = [
  "pending",
  "downloading",
  "running",
  "complete",
  "error",
] as const;

type KnownOperationFileState = (typeof KNOWN_OPERATION_FILE_STATES)[number];

const KNOWN: Record<KnownOperationFileState, BundleSwitchStepState> = {
  pending: "pending",
  downloading: "downloading",
  running: "running",
  complete: "complete",
  error: "error",
};

/**
 * Narrow a raw `metadata.files[].state` to a row state.
 *
 * Unknown and missing both mean "we have nothing to claim about this row yet",
 * which is what `pending` draws.
 */
export function toBundleSwitchStepState(raw: string | undefined): BundleSwitchStepState {
  if (raw === undefined) return "pending";
  return KNOWN[raw as KnownOperationFileState] ?? "pending";
}

/** Whether the row is doing something now, i.e. gets a spinner rather than a circle. */
export function stepIsActive(state: BundleSwitchStepState): boolean {
  return state === "downloading" || state === "running";
}

/**
 * Whether the row should print `done / total`.
 *
 * Only a transfer has bytes worth printing. A verify pass reports no state of its
 * own (it stays `pending` until the row settles), and an Edge probe's counters are
 * step counts, so neither gets a size.
 */
export function showsStepByteProgress(state: BundleSwitchStepState): boolean {
  return state === "downloading";
}
