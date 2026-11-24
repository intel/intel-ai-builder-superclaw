/**
 * Hardware preflight policy — pure evaluation of the LRM resource preflight
 * response into a startup block/allow decision.
 *
 * Source of truth: `GET /llm-router/v1/system/preflight?bundle_id=<id>` (LRM,
 * proxied through ServiceHub). The backend owns all facts; this module only
 * interprets the check results — it NEVER derives capability from hardware
 * models itself.
 *
 * Contract: each check is `{ name, state, severity, message?, free_gb?,
 * required_gb? }`. A resource check BLOCKS startup only when `state === "fail"`
 * AND `severity === "error"` — exactly the condition LRM uses to compute
 * `ready`. This matters: `model_files` reports `state: "fail", severity:
 * "warn"` for a not-yet-downloaded model, which must NOT block (the download
 * flow fetches it). Any skipped / info / warn / unknown state is fail-open, so
 * a missing or degraded probe can never wrongly block startup. Edge /
 * unconfigured providers are handled by the backend, which marks the
 * model-memory / disk checks `skipped`.
 *
 * The dialog copy is composed entirely on the frontend from the structured
 * `free_gb` / `required_gb` figures (i18n) — the backend `message` is not
 * shown to the user.
 */

/** One check row from the preflight response. */
export type PreflightCheck = {
  name: string;
  state: string;
  severity?: string;
  message?: string;
  /** Free amount observed by the probe, in GB (present on failing resource checks). */
  free_gb?: number;
  /** Amount required to satisfy this check, in GB (present on failing resource checks). */
  required_gb?: number;
};

/** The subset of the preflight response the policy consumes. */
export type PreflightResponse = {
  ready?: boolean;
  checks?: PreflightCheck[];
};

/** A single failing resource, ready to render in the requirements dialog. */
export type HardwareFailure = {
  /** Stable check identifier from the backend (e.g. "model_memory"). */
  kind: string;
  /** Free amount the machine has, in GB (null when the probe omitted it). */
  freeGb: number | null;
  /** Amount required to satisfy this check, in GB (null when omitted). */
  requiredGb: number | null;
};

export type PreflightEvaluation = {
  /** True only when at least one resource check is a hard (error) failure. */
  blocked: boolean;
  failures: HardwareFailure[];
};

/** Resource check names the policy is allowed to block on. */
const RESOURCE_CHECK_NAMES = new Set(["model_memory", "disk_free"]);

const toNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Evaluate a preflight response into a block/allow decision. Only a resource
 * check with `state === "fail"` and `severity === "error"` blocks startup;
 * everything else is fail-open.
 */
export function evaluateHardwarePreflight(preflight: PreflightResponse | null | undefined): PreflightEvaluation {
  const checks = Array.isArray(preflight?.checks) ? preflight!.checks! : [];
  const failures: HardwareFailure[] = [];

  for (const check of checks) {
    if (!check || typeof check.name !== "string" || typeof check.state !== "string") continue;
    if (!RESOURCE_CHECK_NAMES.has(check.name)) continue;
    if (check.state !== "fail" || check.severity !== "error") continue;
    failures.push({
      kind: check.name,
      freeGb: toNumber(check.free_gb),
      requiredGb: toNumber(check.required_gb),
    });
  }

  return { blocked: failures.length > 0, failures };
}
