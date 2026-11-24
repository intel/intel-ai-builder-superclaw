import { z } from "zod";
import { McpServerNameSchema } from "./mcp.js";

const ModelRefSchema = z.string().refine((value) => {
  const [providerId, ...modelId] = value.trim().split("/");
  return Boolean(providerId?.trim()) && modelId.join("/").trim().length > 0;
}, "model must use providerID/modelID format");

const StringRecordSchema = z.record(z.string(), z.string());

const McpConfigPatchSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("local"),
    command: z.array(z.string()).min(1),
    environment: StringRecordSchema.optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    type: z.literal("remote"),
    url: z.string().min(1),
    headers: StringRecordSchema.optional(),
    oauth: z.union([
      z.object({
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
      }).strict(),
      z.literal(false),
    ]).optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().int().positive().optional(),
  }).strict(),
]);

const OpenCodeConfigPatchSchema = z
  .object({
    model: ModelRefSchema.optional(),
    mcp: z.record(McpServerNameSchema, McpConfigPatchSchema).optional(),
  })
  .strict()
  .refine((value) => value.model !== undefined || value.mcp !== undefined, {
    message: "opencode must include a supported patch field",
  });

const OpenworkWorkspacePatchSchema = z
  .object({
    name: z.string().nullable().optional(),
  })
  .strict();

const OpenworkReloadPatchSchema = z
  .object({
    auto: z.boolean().optional(),
    resume: z.boolean().optional(),
  })
  .strict();

const OpenworkConfigPatchSchema = z
  .object({
    workspace: OpenworkWorkspacePatchSchema.optional(),
    reload: OpenworkReloadPatchSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => value.workspace !== undefined || value.reload !== undefined, {
    message: "openwork must include a supported patch field",
  });

export const ConfigPatchRequestSchema = z
  .object({
    opencode: OpenCodeConfigPatchSchema.optional(),
    openwork: OpenworkConfigPatchSchema.optional(),
  })
  .strict()
  .refine((value) => value.opencode !== undefined || value.openwork !== undefined, {
    message: "opencode or openwork updates required",
  });

export type ConfigPatchRequest = z.infer<typeof ConfigPatchRequestSchema>;
