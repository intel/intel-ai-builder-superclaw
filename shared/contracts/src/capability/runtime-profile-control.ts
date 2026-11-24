/** Runtime Profile status wire contract. */
import { z } from "zod";

import { SafeErrorSchema } from "./common.js";
import { ProductProfileIdSchema } from "./product-profile.js";

export const ProductProfileRuntimeStatusSchema = z.discriminatedUnion("state", [
  z
    .object({
      contract_version: z.literal(1),
      state: z.literal("ready"),
      profile: ProductProfileIdSchema,
    })
    .strict(),
  z
    .object({
      contract_version: z.literal(1),
      state: z.literal("applying"),
      profile: ProductProfileIdSchema.nullable(),
      target_profile: ProductProfileIdSchema,
    })
    .strict(),
  z
    .object({
      contract_version: z.literal(1),
      state: z.literal("failed"),
      profile: ProductProfileIdSchema.nullable(),
      target_profile: ProductProfileIdSchema,
      error: SafeErrorSchema,
    })
    .strict(),
]);
export type ProductProfileRuntimeStatus = z.infer<typeof ProductProfileRuntimeStatusSchema>;
