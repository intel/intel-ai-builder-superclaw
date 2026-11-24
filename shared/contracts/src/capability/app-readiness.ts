/**
 * SVC-04 — authoritative App-facing readiness projection, `GET /app/readiness`.
 *
 * The single product-level readiness answer, read by the installer success banner,
 * Tauri startup, the UI status overview, and product smoke/E2E. Supersedes
 * `app-runtime-status.ts` for product consumers.
 *
 * Contract facts every consumer depends on:
 * - `state` is `ready` iff every `startup: "required"` component is `ready`.
 *   Precedence over required components: `failed > unknown > starting > ready`.
 * - Incomplete evidence is never promoted to `ready`.
 * - The serving side returns HTTP 200 for every document it can produce, including
 *   `starting`/`failed`/`unknown`. 5xx means the contract could not be served.
 * - `ready` means the required control and execution planes are serving. It does NOT
 *   promise a usable model route, a valid cloud credential, a resident optional
 *   feature, or that an inference request will succeed.
 */
import { z } from "zod";
import { AppReadinessContractVersionSchema, IsoTimestampSchema, RevisionSchema } from "./common.js";

/**
 * Component-level state.
 *
 * `dormant` is normal for an un-activated `on_demand` component, not a failure.
 * `unknown` is reserved for evidence-plane faults (missing/stale/unobtainable) and
 * must never stand in for a known lifecycle state.
 */
export const ReadinessComponentStateSchema = z.enum([
  "ready",
  "starting",
  "failed",
  "unknown",
  "dormant",
]);
export type ReadinessComponentState = z.infer<typeof ReadinessComponentStateSchema>;

/** Top-level App state. `dormant` is absent: on-demand components never gate the App. */
export const AppReadinessStateSchema = z.enum(["ready", "starting", "failed", "unknown"]);
export type AppReadinessState = z.infer<typeof AppReadinessStateSchema>;

/** Lifecycle policy, mirroring `service_cfg.json`. Only `required` gates readiness. */
export const ReadinessStartupSchema = z.enum(["required", "on_demand"]);
export type ReadinessStartup = z.infer<typeof ReadinessStartupSchema>;

/**
 * Which plane the component lives in: a ServiceHub-supervised Windows child
 * process, or a Sandbox execution-plane fact owned by SandboxManager.
 */
export const ReadinessComponentKindSchema = z.enum(["host_service", "runtime"]);
export type ReadinessComponentKind = z.infer<typeof ReadinessComponentKindSchema>;

/**
 * Stable machine-readable reason for a non-ready component. Program logic depends
 * on `state` + `reason_code`, never on a human-readable message.
 *
 * Pairing rules the serving side must honor:
 * - `probe_pending` pairs with `starting` — the normal cold-start value, and must
 *   not be reported as `unknown`.
 * - `evidence_stale`/`evidence_unavailable` pair with `unknown` and mean *our*
 *   inability to obtain evidence, never component failure.
 * - the rest explain `failed`.
 */
export const ReadinessReasonCodeSchema = z.enum([
  "unreachable",
  "identity_mismatch",
  "probe_timeout",
  "probe_pending",
  "start_failed",
  "not_running",
  "native_hdr_restart_budget_exhausted",
  "profile_revision_mismatch",
  "evidence_stale",
  "evidence_unavailable",
]);
export type ReadinessReasonCode = z.infer<typeof ReadinessReasonCodeSchema>;

/**
 * One evidence node.
 *
 * `instance_id` is component-kind specific: a per-spawn UUID for `host_service`,
 * the container id for `sandbox_container`, null where there is no instance.
 * `applied_revision`/`active_revision` are populated only by `profile_application`.
 */
export const ReadinessComponentSchema = z
  .object({
    name: z.string().min(1),
    kind: ReadinessComponentKindSchema,
    startup: ReadinessStartupSchema,
    state: ReadinessComponentStateSchema,
    instance_id: z.string().nullable(),
    reason_code: ReadinessReasonCodeSchema.nullable(),
    observed_at: IsoTimestampSchema.nullable(),
    last_transition_at: IsoTimestampSchema.nullable(),
    applied_revision: RevisionSchema.nullable(),
    active_revision: RevisionSchema.nullable(),
  })
  .strict();
export type ReadinessComponent = z.infer<typeof ReadinessComponentSchema>;

export const AppReadinessSchema = z
  .object({
    contract_version: AppReadinessContractVersionSchema,
    state: AppReadinessStateSchema,
    /** Suggested poll backoff while not ready. Null when `state` is `ready`. */
    retry_after_ms: z.number().int().nonnegative().nullable(),
    components: z.array(ReadinessComponentSchema),
    observed_at: IsoTimestampSchema,
  })
  .strict();
export type AppReadiness = z.infer<typeof AppReadinessSchema>;
