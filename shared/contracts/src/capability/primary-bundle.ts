/**
 * v1.2 capability gating — read-only primary-bundle capability projection.
 *
 * Transcribed field-for-field from the design authority (§3.3
 * `PrimaryBundleCapability`). Returned by `GET /llm-router/v1/capability/primary-bundle`.
 * Compute ceiling is separate from download/disk feasibility: `download_feasibility`
 * never lowers the ceiling. The cloud-only Lite hardware verdict is explicit;
 * no Grade-derived Profile label/roster is projected. No
 * secrets or absolute host paths.
 */
import { z } from "zod";
import {
  CapabilityGradeSchema,
  PrimaryBundleContractVersionSchema,
  HubOperationIdSchema,
  LrmOperationIdSchema,
  RevisionSchema,
  IsoTimestampSchema,
} from "./common.js";
import {
  BundleBackendSchema,
  ModelBundleSchema,
  PendingBundleStateSchema,
  PrimaryBundleStateSchema,
} from "./model-bundle.js";

export const BundleAssetRoleSchema = z.enum(["chat", "embedding"]);
export type BundleAssetRole = z.infer<typeof BundleAssetRoleSchema>;

export const DownloadFeasibilitySchema = z.enum(["ready", "insufficient_disk", "probe_unknown"]);
export type DownloadFeasibility = z.infer<typeof DownloadFeasibilitySchema>;

/**
 * User-facing caveat a model ships with; the UI owns the translated text for each value.
 * Name each value after the exact statement its text makes, and never change a shipped
 * value's meaning: a different caveat is a new value.
 */
export const ModelWarningSchema = z.enum(["below_default_benchmark_limited_testing"]);
export type ModelWarning = z.infer<typeof ModelWarningSchema>;

/** UI-safe download row for one asset in a supported bundle. */
export const SupportedBundleAssetSchema = z
  .object({
    asset_id: z.string().min(1),
    label: z.string().min(1),
    role: BundleAssetRoleSchema,
    download_bytes: z.number().int().nonnegative(),
    cached_and_verified: z.boolean(),
  })
  .strict();
export type SupportedBundleAsset = z.infer<typeof SupportedBundleAssetSchema>;

/** UI-safe display/download facts for one compute-supported bundle. No Grade-to-Profile derivation. */
export const SupportedBundleSchema = z
  .object({
    bundle_id: z.string().min(1),
    backend: BundleBackendSchema,
    display_name: z.string().min(1),
    capability_grade: CapabilityGradeSchema,
    chat_model_label: z.string().min(1),
    embedding_model_label: z.string().min(1),
    assets: z.array(SupportedBundleAssetSchema),
    total_download_bytes: z.number().int().nonnegative(),
    required_free_bytes: z.number().int().nonnegative(),
    fully_cached_and_verified: z.boolean(),
    download_feasibility: DownloadFeasibilitySchema,
    download_block_reason: z.string().optional(),
    model_warnings: z.array(ModelWarningSchema).min(1).optional(),
  })
  .strict();
export type SupportedBundle = z.infer<typeof SupportedBundleSchema>;

/** Highest ranked compute-supported Local Grade + its preferred bundle. Absent when compute requirements fail. */
export const HardwareCapabilityCeilingSchema = z
  .object({
    bundle_id: z.string().min(1),
    capability_grade: CapabilityGradeSchema,
  })
  .strict();
export type HardwareCapabilityCeiling = z.infer<typeof HardwareCapabilityCeilingSchema>;

/** Trusted hardware evidence surfaced with the capability read. */
export const HardwareEvidenceSchema = z
  .object({
    cpu_brand: z.string(),
    gpu_names: z.array(z.string()),
    total_ram_gb: z.number().nonnegative(),
    mem_speed_mts: z.number().nonnegative(),
    detection_errors: z.array(z.string()),
  })
  .strict();
export type HardwareEvidence = z.infer<typeof HardwareEvidenceSchema>;

export const PrimaryBundleCapabilitySchema = z
  .object({
    model_candidate_revision: RevisionSchema,
    edge_model_selection_fingerprint: z.string().min(1).optional(),
    /** True only when the ready primary Edge Bundle matches the saved connection. */
    primary_edge_config_matches: z.boolean().optional(),
    hardware_capability_ceiling: HardwareCapabilityCeilingSchema.optional(),
    supported_bundle_ids: z.array(z.string().min(1)),
    recommended_bundle_id: z.string().min(1).optional(),
    /** Hardware-qualified Lite has no local model to download or bind. */
    cloud_only_product_profile_id: z.literal("lite").optional(),
    supported_bundles: z.array(SupportedBundleSchema),
    /**
     * LRM's authoritative lifecycle revision. Unlike `primary_bundle.bundle_revision`
     * it is present when no Bundle is committed (e.g. after a release), so a
     * connect can send the right `expected_bundle_revision`.
     */
    bundle_revision: RevisionSchema.optional(),
    primary_bundle: PrimaryBundleStateSchema.optional(),
    pending_bundle: PendingBundleStateSchema.optional(),
    hardware: HardwareEvidenceSchema,
    observed_at: IsoTimestampSchema,
    reasons: z.array(z.string()),
  })
  .strict();
export type PrimaryBundleCapability = z.infer<typeof PrimaryBundleCapabilitySchema>;

const BundleOperationStateSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
const bundleCommandShape = {
  contract_version: PrimaryBundleContractVersionSchema,
  correlation_operation_id: HubOperationIdSchema,
  target_bundle_id: z.string().min(1),
  expected_bundle_revision: RevisionSchema,
  idempotency_key: z.string().min(1),
} as const;

/** LRM staged prepare command. Download consent is validated against the candidate revision. */
export const PrimaryBundlePrepareRequestSchema = z.discriminatedUnion("intent", [
  z.object({
    ...bundleCommandShape,
    intent: z.literal("download_and_connect"),
    candidate_revision: RevisionSchema,
    user_confirmed_download: z.literal(true),
  }).strict(),
  z.object({
    ...bundleCommandShape,
    intent: z.literal("connect"),
    candidate_revision: RevisionSchema,
  }).strict(),
]);
export type PrimaryBundlePrepareRequest = z.infer<typeof PrimaryBundlePrepareRequestSchema>;

/** Durable receipt returned when LRM starts, joins, or reads back a preparation. */
export const PrimaryBundlePrepareResponseSchema = z
  .object({
    contract_version: PrimaryBundleContractVersionSchema,
    correlation_operation_id: HubOperationIdSchema,
    prepare_operation_id: LrmOperationIdSchema,
    idempotency_key: z.string().min(1),
    state: BundleOperationStateSchema,
    pct: z.number().min(0).max(100),
    message: z.string().nullable(),
  })
  .strict();
export type PrimaryBundlePrepareResponse = z.infer<typeof PrimaryBundlePrepareResponseSchema>;

export const PrimaryBundleCommitRequestSchema = z
  .object({
    ...bundleCommandShape,
    prepare_operation_id: LrmOperationIdSchema,
  })
  .strict();
export type PrimaryBundleCommitRequest = z.infer<typeof PrimaryBundleCommitRequestSchema>;

export const PrimaryBundleAbortRequestSchema = z
  .object({
    ...bundleCommandShape,
    prepare_operation_id: LrmOperationIdSchema,
  })
  .strict();
export type PrimaryBundleAbortRequest = z.infer<typeof PrimaryBundleAbortRequestSchema>;

/** Structured, secret-free classification of a primary-bundle prepare failure. */
export const PrimaryBundlePrepareReasonCodeSchema = z.enum([
  "url_unreachable",
  "invalid_api_key",
  "model_not_found",
  "bundle_incomplete",
]);
export type PrimaryBundlePrepareReasonCode = z.infer<typeof PrimaryBundlePrepareReasonCodeSchema>;

export const PrimaryBundleLifecycleReadbackSchema = z
  .object({
    contract_version: PrimaryBundleContractVersionSchema,
    correlation_operation_id: HubOperationIdSchema,
    prepare_operation_id: LrmOperationIdSchema,
    target_bundle: ModelBundleSchema,
    candidate_revision: RevisionSchema,
    expected_bundle_revision: RevisionSchema,
    bundle_revision: RevisionSchema,
    idempotency_key: z.string().min(1),
    state: BundleOperationStateSchema,
    pct: z.number().min(0).max(100),
    message: z.string().nullable(),
    // Structured, secret-free classification of a prepare failure. Null on
    // success or when the failure could not be classified.
    reason_code: PrimaryBundlePrepareReasonCodeSchema.nullish(),
  })
  .strict();
export type PrimaryBundleLifecycleReadback = z.infer<typeof PrimaryBundleLifecycleReadbackSchema>;

export const PrimaryBundleCommitResponseSchema = PrimaryBundleLifecycleReadbackSchema.extend({
  state: z.literal("succeeded"),
});
export type PrimaryBundleCommitResponse = z.infer<typeof PrimaryBundleCommitResponseSchema>;

export const PrimaryBundleAbortResponseSchema = PrimaryBundleLifecycleReadbackSchema.extend({
  state: z.literal("cancelled"),
});
export type PrimaryBundleAbortResponse = z.infer<typeof PrimaryBundleAbortResponseSchema>;

/**
 * LRM release command: un-commit the primary bundle with no replacement
 * target, returning the hardware to a bundle-free verdict (today, only the
 * cloud-only Lite verdict). Unlike `bundleCommandShape`, this carries no
 * `target_bundle_id` — there is nothing to connect to.
 */
export const PrimaryBundleReleaseRequestSchema = z
  .object({
    contract_version: PrimaryBundleContractVersionSchema,
    correlation_operation_id: HubOperationIdSchema,
    expected_bundle_revision: RevisionSchema,
    idempotency_key: z.string().min(1),
  })
  .strict();
export type PrimaryBundleReleaseRequest = z.infer<typeof PrimaryBundleReleaseRequestSchema>;

export const PrimaryBundleReleaseResponseSchema = z
  .object({
    contract_version: PrimaryBundleContractVersionSchema,
    correlation_operation_id: HubOperationIdSchema,
    idempotency_key: z.string().min(1),
    state: z.literal("succeeded"),
  })
  .strict();
export type PrimaryBundleReleaseResponse = z.infer<typeof PrimaryBundleReleaseResponseSchema>;
