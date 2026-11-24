import { z } from "zod";

import { RevisionSchema } from "./common.js";
import { BundleBackendSchema } from "./model-bundle.js";
import { ProductProfileIdSchema } from "./product-profile.js";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const ModelBindingAssetRoleSchema = z.enum([
  "chat_weights",
  "embedding_weights",
  "vision_projector",
  "draft_weights",
]);
export type ModelBindingAssetRole = z.infer<typeof ModelBindingAssetRoleSchema>;

export const ModelBindingAssetSchema = z.discriminatedUnion("source", [
  z
    .object({
      asset_id: z.string().min(1),
      role: ModelBindingAssetRoleSchema,
      source: z.literal("packaged"),
      sha256: Sha256Schema,
    })
    .strict(),
  z
    .object({
      asset_id: z.string().min(1),
      role: ModelBindingAssetRoleSchema,
      source: z.literal("remote"),
    })
    .strict(),
]);
export type ModelBindingAsset = z.infer<typeof ModelBindingAssetSchema>;

const modelBindingChatShape = {
  model_id: z.string().min(1),
  weights: ModelBindingAssetSchema.and(z.object({ role: z.literal("chat_weights") })),
  draft: ModelBindingAssetSchema.and(z.object({ role: z.literal("draft_weights") })).optional(),
} as const;

export const ModelBindingChatSchema = z
  .object({
    ...modelBindingChatShape,
    projector: ModelBindingAssetSchema.and(z.object({ role: z.literal("vision_projector") })).optional(),
  })
  .strict();
export type ModelBindingChat = z.infer<typeof ModelBindingChatSchema>;

export const ModelBindingEmbeddingSchema = z
  .object({
    model_id: z.string().min(1),
    weights: ModelBindingAssetSchema.and(z.object({ role: z.literal("embedding_weights") })),
  })
  .strict();
export type ModelBindingEmbedding = z.infer<typeof ModelBindingEmbeddingSchema>;

export const ModelBindingCapabilitiesSchema = z
  .object({
    text: z.literal(true),
    vision: z.boolean(),
  })
  .strict();
export type ModelBindingCapabilities = z.infer<typeof ModelBindingCapabilitiesSchema>;

/**
 * The atomic model selection resolved by ModelRouter for new requests.
 * Asset identities and the launch digest distinguish serving variants such as
 * the same Chat weights with and without a multimodal projector.
 */
const modelBindingShape = {
    contract_version: z.literal(1),
    binding_revision: RevisionSchema,
    bundle_id: z.string().min(1),
    backend: BundleBackendSchema,
    compatible_product_profiles: z.array(ProductProfileIdSchema).min(1),
    embedding: ModelBindingEmbeddingSchema,
    endpoint_ref: z.string().min(1),
    credential_ref: z.string().min(1).optional(),
    launch_spec_sha256: Sha256Schema,
    state: z.literal("ready"),
} as const;

export const ModelBindingSchema = z.union([
  z
    .object({
      ...modelBindingShape,
      chat: z.object(modelBindingChatShape).strict(),
      capabilities: z.object({ text: z.literal(true), vision: z.literal(false) }).strict(),
    })
    .strict(),
  z
    .object({
      ...modelBindingShape,
      chat: z
        .object({
          ...modelBindingChatShape,
          projector: ModelBindingAssetSchema.and(z.object({ role: z.literal("vision_projector") })),
        })
        .strict(),
      capabilities: z.object({ text: z.literal(true), vision: z.literal(true) }).strict(),
    })
    .strict(),
]);
export type ModelBinding = z.infer<typeof ModelBindingSchema>;

export const ModelBindingStateSchema = z
  .object({
    contract_version: z.literal(1),
    binding_revision: RevisionSchema,
    active: ModelBindingSchema.optional(),
  })
  .strict();
export type ModelBindingState = z.infer<typeof ModelBindingStateSchema>;

/** Immutable compatibility evidence for one durably prepared Binding candidate. */
export const PreparedModelBindingSchema = z
  .object({
    contract_version: z.literal(1),
    prepare_operation_id: z.string().regex(/^lrm:[A-Za-z0-9][A-Za-z0-9._-]*$/),
    target_bundle_id: z.string().min(1),
    candidate_revision: RevisionSchema,
    expected_binding_revision: RevisionSchema,
    compatible_product_profiles: z.array(ProductProfileIdSchema).min(1),
  })
  .strict();
export type PreparedModelBinding = z.infer<typeof PreparedModelBindingSchema>;
