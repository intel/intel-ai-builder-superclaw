import { z } from "zod";

export const ProductProfileIdSchema = z.enum(["lite", "standard", "pro"]);
export type ProductProfileId = z.infer<typeof ProductProfileIdSchema>;

export const ProductProfileSidecarIdSchema = z.enum(["intent-classifier", "hdr-sidecar"]);
export type ProductProfileSidecarId = z.infer<typeof ProductProfileSidecarIdSchema>;

export const ProductProfileFeatureFlagsSchema = z
  .object({
    intent_classifier: z.boolean(),
    local_tts: z.boolean(),
    local_vision: z.boolean(),
    hybrid_coding_agent: z.boolean(),
    hybrid_deep_research_agent: z.boolean(),
    email_agent: z.boolean(),
    skills_ui: z.boolean(),
    agent_authoring: z.boolean(),
    mcp_tool_permissions: z.boolean().optional(),
    /**
     * Local (on-device) speech-to-text in the composer. Optional, like
     * `mcp_tool_permissions` and unlike the other flags above it: a packaged
     * Profile written before this flag existed — and the Profile fixtures in
     * `host/servicehub/tests` — must still validate,
     * since the descriptor is parsed with `strict=True` on the Python side. The
     * UI therefore treats an absent flag as "off" and keeps the cloud
     * (browser speech) path, which is available on every Profile.
     */
    voice_input: z.boolean().optional(),
    /**
     * Adding an MCP server that runs a local command (stdio). Optional for the
     * same reason as `voice_input`; an absent flag means "off", in the UI and
     * in openwork-server's add route.
     */
    mcp_local_command: z.boolean().optional(),
    /**
     * Running a user's MCP server outside the sandbox, through the host MCP gateway. Optional for
     * the same reason as `voice_input`; an absent flag means "off", in the UI and in
     * openwork-server's add route.
     */
    mcp_host_execution: z.boolean().optional(),
    /**
     * Driving the host MCP gateway's visible Edge from a sandboxed browser MCP. Optional for the
     * same reason as `voice_input`; an absent flag means "off".
     */
    host_browser: z.boolean().optional(),
  })
  .strict();
export type ProductProfileFeatureFlags = z.infer<typeof ProductProfileFeatureFlagsSchema>;

export const ProductProfileDescriptorSchema = z
  .object({
    schema_version: z.literal(1),
    profile: ProductProfileIdSchema,
    display_name: z.string().min(1),
    description: z.string().min(1),
    required_sidecars: z.array(ProductProfileSidecarIdSchema).max(2),
    feature_flags: ProductProfileFeatureFlagsSchema,
  })
  .strict();
export type ProductProfileDescriptor = z.infer<typeof ProductProfileDescriptorSchema>;
