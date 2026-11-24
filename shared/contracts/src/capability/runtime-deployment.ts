/** Desired Runtime deployment and observed instance evidence. */
import { z } from "zod";

import { RevisionSchema, SafeErrorSchema, Sha256Schema } from "./common.js";
import { ProductProfileIdSchema } from "./product-profile.js";

export const RuntimeDeploymentIdSchema = z.string().regex(/^runtime-deployment-[0-9a-f]{32}$/);
export const RuntimeInstanceIdSchema = z.string().regex(/^runtime-instance-[0-9a-f]{32}$/);
export const RuntimeLaunchAttemptIdSchema = z.string().regex(/^runtime-attempt-[0-9a-f]{32}$/);

export const RuntimeDeploymentSpecSchema = z
  .object({
    schema_version: z.literal(2),
    deployment_id: RuntimeDeploymentIdSchema,
    source_operation_id: z.string().min(1).nullable(),
    product_profile_id: ProductProfileIdSchema,
    product_profile_digest: Sha256Schema,
    profile_revision: RevisionSchema.min(1),
  })
  .strict();
export type RuntimeDeploymentSpec = z.infer<typeof RuntimeDeploymentSpecSchema>;

const RuntimeInstanceIdentitySchema = z.object({
  schema_version: z.literal(1),
  deployment_id: RuntimeDeploymentIdSchema,
  desired_fingerprint: Sha256Schema,
  runtime_instance_id: RuntimeInstanceIdSchema,
  launch_attempt_id: RuntimeLaunchAttemptIdSchema,
  product_profile_id: ProductProfileIdSchema,
  product_profile_digest: Sha256Schema,
  profile_revision: RevisionSchema.min(1),
});

/** Configuration is published; external services may start, but are not yet ready. */
export const RuntimeGenerationPublishedSchema = RuntimeInstanceIdentitySchema.extend({
  status: z.literal("published"),
}).strict();
export type RuntimeGenerationPublished = z.infer<typeof RuntimeGenerationPublishedSchema>;

export const RuntimeSupervisorReadySchema = RuntimeInstanceIdentitySchema.extend({
    status: z.literal("ready"),
    runtime_ready: z.literal(true),
    components: z.object({ opencode: z.boolean(), openwork: z.boolean() }).strict(),
    intent_classifier: z.object({ mode: z.enum(["enabled", "bypass"]) }).strict(),
    hybrid_dr: z.object({ status: z.enum(["healthy", "absent"]) }).strict(),
}).strict();
export type RuntimeSupervisorReady = z.infer<typeof RuntimeSupervisorReadySchema>;

export const RuntimeInstanceEvidenceSchema = z.union([
  RuntimeInstanceIdentitySchema.extend({ status: z.literal("applying") }).strict(),
  RuntimeInstanceIdentitySchema.extend({
    status: z.literal("failed"),
    error: SafeErrorSchema,
  }).strict(),
  RuntimeSupervisorReadySchema.extend({ backend: z.literal("native") }).strict(),
]);
export type RuntimeInstanceEvidence = z.infer<typeof RuntimeInstanceEvidenceSchema>;
