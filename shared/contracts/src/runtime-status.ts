/**
 * RuntimeStatus aggregates runtime component status for the UI.
 *
 * Generated from Zod to JSON Schema and Pydantic by scripts/gen.mjs.
 */

import { z } from "zod";

import { AgentRuntimeIdSchema } from "./agent-runtime-vocabulary.js";
import {
  ISOLATION_REPORT_SHAPE,
  refineIsolationReport,
} from "./isolation-reporting.js";

export const LaunchPlanSchema = z
  .object({
    ctx_size: z.number().min(1),
    parallel: z.number().min(1),
    cache_ram_mib: z.number().min(0),
    n_gpu_layers: z.number().min(0),
    slot_similarity: z.number().min(0).lt(1),
    threads: z.number().min(1),
  })
  .strict();

export const HardwareSchema = z
  .object({
    igpu_names: z.array(z.string()),
    total_ram_gb: z.number().min(0),
    mem_speed_mts: z.number().min(0).nullable(),
    gpu_free_mib: z.number().min(0).nullable(),
    detection_errors: z.array(z.string()),
  })
  .strict();

export const CapabilitySchema = z
  .object({
    tier: z.enum(["local-ready", "underspec", "no-local"]),
    hardware: HardwareSchema,
    plan: LaunchPlanSchema.nullable(),
    reason: z.string().nullable(),
  })
  .strict();

export const RouteDecisionSchema = z
  .object({
    worker_id: z.string(),
    sanitize: z.boolean(),
    reason: z.string(),
  })
  .strict();

export const ModelWorkerStateInStatusSchema = z.enum([
  "ready",
  "starting",
  "failed",
  "stopped",
  "rerouted",
]);

export const ModelWorkerStatusSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["local-llama", "cloud", "mock"]),
    state: ModelWorkerStateInStatusSchema,
    last_first_token_ms: z.number().min(0).nullable(),
  })
  .strict();

/**
 * The detailed sandbox status, carrying the isolation report of authority section 6.3.
 *
 * The isolation fields are spread from `ISOLATION_REPORT_SHAPE` and refined by the same
 * cross-field rules as the standalone `IsolationReportSchema`, so this surface and the
 * report a producer validates cannot become two shapes with two sets of rules.
 *
 * `fs_root` is gone. It carried the sandbox's workspace path, which is a path on the one
 * surface authority section 6.3 forbids paths on, and the root set it stood for is now
 * reported as `isolation_workspace_root_count` plus
 * `isolation_workspace_root_classes[]`: a count and a policy class per member, no
 * spellings. It had no producer and no consumer in this repository, so removing it costs
 * nothing that existed; the master plan's section 5.5 lists it as a blocker 21 site
 * assigned to this slice.
 */
export const SandboxStatusSchema = z
  .object({
    kind: z.enum(["process", "mock"]),
    project_id: z.string().nullable(),
    state: z.enum(["ready", "starting", "failed", "stopped"]),
    ...ISOLATION_REPORT_SHAPE,
  })
  .strict()
  .superRefine(refineIsolationReport);

export const AgentRuntimeStatusSchema = z
  .object({
    kind: AgentRuntimeIdSchema,
    state: z.enum(["ready", "starting", "failed", "stopped"]),
    active_session_id: z.string().nullable(),
  })
  .strict();

export const ChannelStateSchema = z.enum(["ready", "not-configured", "failed"]);

export const OperationRunSchema: z.ZodType<OperationRun> = z.lazy(() =>
  z
    .object({
      run_id: z.string().min(1),
      kind: z.string().min(1),
      state: z.enum(["pending", "running", "done", "error", "cancelled"]),
      pct: z.number().min(0).max(100),
      message: z.string(),
      parent_run_id: z.string().nullable(),
      children: z.array(OperationRunSchema),
      started_at: z.string().optional(),
      finished_at: z.string().optional(),
      error: z.string().optional(),
    })
    .strict()
);

export interface OperationRun {
  run_id: string;
  kind: string;
  state: "pending" | "running" | "done" | "error" | "cancelled";
  pct: number;
  message: string;
  parent_run_id: string | null;
  children: OperationRun[];
  started_at?: string;
  finished_at?: string;
  error?: string;
}

export const ModelRouterStatusSchema = z
  .object({
    policy: z.string(),
    last_decision: RouteDecisionSchema.nullable(),
  })
  .strict();

export const RuntimeStatusSchema = z
  .object({
    capability: CapabilitySchema,
    model_router: ModelRouterStatusSchema,
    model_workers: z.array(ModelWorkerStatusSchema),
    agent_runtime: AgentRuntimeStatusSchema,
    sandbox: SandboxStatusSchema,
    channels: z.record(z.string(), ChannelStateSchema),
    operations: z.array(OperationRunSchema),
  })
  .strict();

export type Capability = z.infer<typeof CapabilitySchema>;
export type Hardware = z.infer<typeof HardwareSchema>;
export type LaunchPlan = z.infer<typeof LaunchPlanSchema>;
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;
export type ModelWorkerStatus = z.infer<typeof ModelWorkerStatusSchema>;
export type ModelWorkerStateInStatus = z.infer<
  typeof ModelWorkerStateInStatusSchema
>;
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;
export type AgentRuntimeStatus = z.infer<typeof AgentRuntimeStatusSchema>;
export type ChannelState = z.infer<typeof ChannelStateSchema>;
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;
