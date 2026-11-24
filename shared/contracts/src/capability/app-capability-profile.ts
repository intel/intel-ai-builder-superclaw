/**
 * v1.2 capability gating — the App-facing capability Profile.
 *
 * Transcribed field-for-field from the design authority (§3.4). Returned by
 * `GET /app/capability-profile`, the only App-facing feature-gating endpoint.
 * The UI first discriminates `lifecycle_state`: `active` payloads use the
 * packaged Product Profile descriptor for visibility/permissions; `error` /
 * `recovery_required` payloads select Host-only recovery from `recovery_code`.
 * ServiceHub owns this packaged Product Profile choice and `profile_revision`;
 * it never parses model IDs or hardware.
 */
import { z } from "zod";
import {
  AppCapabilityProfileContractVersionSchema,
  RevisionSchema,
  IsoTimestampSchema,
  Sha256Schema,
} from "./common.js";
import { PrimaryBundleStateSchema } from "./model-bundle.js";
import { ProductProfileDescriptorSchema, ProductProfileIdSchema } from "./product-profile.js";

export const ProfileResolutionSourceSchema = z.enum(["hardware_ceiling", "primary_bundle"]);
export type ProfileResolutionSource = z.infer<typeof ProfileResolutionSourceSchema>;

/** Immutable enforcement policy persisted by SandboxManager and injected into the Runtime. */
export const ProfileSnapshotSchema = z
  .object({
    capability_contract_version: AppCapabilityProfileContractVersionSchema,
    product_profile_id: ProductProfileIdSchema,
    product_profile_digest: Sha256Schema,
    profile_revision: RevisionSchema,
    descriptor: ProductProfileDescriptorSchema,
  })
  .strict();
export type ProfileSnapshot = z.infer<typeof ProfileSnapshotSchema>;

/**
 * The enforced functional surface for an active packaged Product Profile.
 */
export const ProfileRecoveryCodeSchema = z.enum([
  "hardware_capability_unknown",
  "hardware_unsupported",
  "profile_incompatible",
  "saga_recovery_required",
]);
export type ProfileRecoveryCode = z.infer<typeof ProfileRecoveryCodeSchema>;

export const ActiveAppCapabilityProfileSchema = z
  .object({
    lifecycle_state: z.literal("active"),
    product_profile_id: ProductProfileIdSchema,
    product_profile_digest: Sha256Schema,
    descriptor: ProductProfileDescriptorSchema,
    resolution_source: ProfileResolutionSourceSchema,
    profile_revision: RevisionSchema,
    resolved_at: IsoTimestampSchema,
    primary_bundle: PrimaryBundleStateSchema.optional(),
    reasons: z.array(z.string()),
  })
  .strict();
export type ActiveAppCapabilityProfile = z.infer<typeof ActiveAppCapabilityProfileSchema>;

export const RecoveryAppCapabilityProfileSchema = z
  .object({
    lifecycle_state: z.enum(["error", "recovery_required"]),
    capability_contract_version: AppCapabilityProfileContractVersionSchema,
    reasons: z.array(z.string()),
    recovery_code: ProfileRecoveryCodeSchema,
  })
  .strict();
export type RecoveryAppCapabilityProfile = z.infer<typeof RecoveryAppCapabilityProfileSchema>;

export const AppCapabilityProfileSchema = z.discriminatedUnion("lifecycle_state", [
  ActiveAppCapabilityProfileSchema,
  RecoveryAppCapabilityProfileSchema,
]);
export type AppCapabilityProfile = z.infer<typeof AppCapabilityProfileSchema>;
