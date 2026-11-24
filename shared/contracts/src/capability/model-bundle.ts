/**
 * v1.2 capability gating — atomic model bundle + primary/pending lifecycle state.
 *
 * Transcribed field-for-field from the design authority
 * (`docs/design/2026-07-13_hardware_capability_feature_gating_implementation.md`
 * §3.2–3.3). Wire data only: a bundle is one chat model, one embedding model,
 * one backend, and an opaque legacy capability-grade tag. LRM owns
 * ranking, eligibility, and `bundle_revision`; Product Profile compatibility is
 * declared separately by prepared Model Bindings.
 */
import { z } from "zod";
import { CapabilityGradeSchema, RevisionSchema, ContractVersionSchema } from "./common.js";

export const BundleBackendSchema = z.enum(["llama", "edge"]);
export type BundleBackend = z.infer<typeof BundleBackendSchema>;

/**
 * The atomic bundle identity. Shared by the committed `PrimaryBundleState` and
 * candidate `PendingBundleState`. Primary state freezes `bundle_id`,
 * `registry_version`, `capability_grade`, and `capability_contract_version`
 * until Model Binding Activation commits the candidate.
 */
const modelBundleShape = {
  backend: BundleBackendSchema,
  bundle_id: z.string().min(1),
  chat_model_id: z.string().min(1),
  embedding_model_id: z.string().min(1),
  capability_grade: CapabilityGradeSchema,
  capability_contract_version: ContractVersionSchema,
  registry_version: RevisionSchema,
} as const;

export const ModelBundleSchema = z.object(modelBundleShape).strict();
export type ModelBundle = z.infer<typeof ModelBundleSchema>;

export const PrimaryBundleLifecycleStateSchema = z.enum([
  "unavailable",
  "provisioning",
  "ready",
  "error",
]);
export type PrimaryBundleLifecycleState = z.infer<typeof PrimaryBundleLifecycleStateSchema>;

/** The committed, authoritative Bundle plus its runtime state and durable revision. */
export const PrimaryBundleStateSchema = z
  .object({
    ...modelBundleShape,
    bundle_revision: RevisionSchema,
    state: PrimaryBundleLifecycleStateSchema,
    reason: z.string().optional(),
  })
  .strict();
export type PrimaryBundleState = z.infer<typeof PrimaryBundleStateSchema>;

export const PendingBundleLifecycleStateSchema = z.enum(["preparing", "prepared", "error"]);
export type PendingBundleLifecycleState = z.infer<typeof PendingBundleLifecycleStateSchema>;

/** A candidate Bundle's LRM-owned preparation state. */
export const PendingBundleStateSchema = z
  .object({
    ...modelBundleShape,
    state: PendingBundleLifecycleStateSchema,
    reason: z.string().optional(),
  })
  .strict();
export type PendingBundleState = z.infer<typeof PendingBundleStateSchema>;
