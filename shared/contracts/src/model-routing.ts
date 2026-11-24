/**
 * Model-routing classification tables — the single source of truth (Seam A).
 *
 * Local vs cloud provider/model classification decides whether PII detection
 * must run before a prompt leaves the machine: local inference never leaves the
 * network, cloud APIs do. These tables were historically duplicated across at
 * least six files (`sandbox/server/src/pii.ts`,
 * `sandbox/channels/src/model-classification.ts`,
 * `apps/ui/src/app/pages/session.tsx`, `apps/ui/src/shared/util/providers.ts`,
 * plus Python copies under `model/llmrouter/`). They had already drifted
 * (e.g. `local-llm` was present in only one copy).
 *
 * This module is now the only place the *data* lives. The classification
 * *functions* (`isLocalProvider`, `needsPiiDetection`, …) stay with their
 * consumers and read these tables. Step 3 of the refactor points every copy at
 * the generated bindings and deletes the duplicates.
 *
 * Generated artifacts (committed): `generated/json-schema/model-routing.json`,
 * `generated/data/model-routing.json`, `generated/ts/model-routing.gen.ts`,
 * and the Python module under `generated/python/`. Run `pnpm contracts:gen`.
 */

import { z } from "zod";

/**
 * Schema describing the *shape* of the model-routing tables. The values
 * themselves live in `MODEL_ROUTING` below; codegen emits both this schema
 * (JSON Schema + Pydantic) and the data (a JSON document + typed bindings).
 */
export const ModelRoutingTablesSchema = z
  .object({
    /**
     * Provider IDs that always run locally (data never leaves the network).
     * SuperRouter is intentionally excluded — it is classified per-model
     * because it can proxy to either local or cloud backends.
     */
    local_provider_ids: z.array(z.string()),
    /**
     * Provider IDs that host models in the cloud (data leaves the network).
     */
    cloud_provider_ids: z.array(z.string()),
    /**
     * Provider IDs that route dynamically (LLMRouter / AutoRouter). The actual
     * target model must be resolved before deciding whether PII applies.
     */
    auto_router_ids: z.array(z.string()),
    /**
     * Model-name substrings indicating a SuperRouter-proxied model is running
     * locally on Intel infrastructure (data stays on-premise). Matched with
     * `includes` (case-insensitive).
     */
    superrouter_local_models: z.array(z.string()),
    /**
     * Model-name prefixes indicating a cloud-hosted model even when served via
     * SuperRouter as a proxy. Matched with `startsWith` (case-insensitive).
     */
    cloud_model_prefixes: z.array(z.string()),
    /**
     * Regex source strings (no flags; matched case-insensitively) for base URLs
     * considered local/on-premise. Used to validate `/v1/classify` responses.
     */
    local_base_url_patterns: z.array(z.string()),
  })
  .strict();

export type ModelRoutingTables = z.infer<typeof ModelRoutingTablesSchema>;

/**
 * The canonical classification data. This is the superset reconciled from the
 * previously-duplicated copies; `local-llm` (present only in the UI copy) is
 * kept because it is a genuine local provider id.
 */
export const MODEL_ROUTING: ModelRoutingTables = {
  local_provider_ids: [
    "gguf",
    "ollama",
    "lmstudio",
    "llamacpp",
    "local",
    "local-llm",
    "localai",
    "vllm",
    "text-generation-webui",
  ],
  cloud_provider_ids: [
    "openai",
    "anthropic",
    "google",
    "openrouter",
    "groq",
    "together",
    "fireworks",
    "mistral",
    "cohere",
    "deepseek",
    "xai",
    "opencode",
    "opencode-go",
  ],
  auto_router_ids: ["llmrouter", "autorouter"],
  superrouter_local_models: [
    "qwen",
    "intel",
    "phi",
    "mistral-nemo",
    "llama3",
    "llama-3",
  ],
  cloud_model_prefixes: [
    "gpt-",
    "gpt4",
    "chatgpt",
    "o1-",
    "o3-",
    "claude-",
    "claude",
    "gemini-",
    "palm-",
    "bard",
    "command-",
    "coral-",
    "deepseek-",
    "mixtral-",
    "mistral-large",
    "mistral-medium",
  ],
  local_base_url_patterns: [
    "^https?://localhost",
    "^https?://127\\.",
    "^https?://0\\.0\\.0\\.0",
    "^https?://10\\.",
    "^https?://172\\.(1[6-9]|2[0-9]|3[01])\\.",
    "^https?://192\\.168\\.",
    "\\.intel\\.com",
  ],
};

// Validate the canonical data against its own schema at module load. A typo in
// the data above becomes a build-time failure rather than silent bad routing.
ModelRoutingTablesSchema.parse(MODEL_ROUTING);
