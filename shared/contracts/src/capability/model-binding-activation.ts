/**
 * App-facing Model Binding Activation wire contract.
 *
 * Freezes: canonical operation identity, public status/stage/progress, download
 * intent + explicit consent, and typed errors. Internal journal state is not
 * exposed. Business handling lives in LRM/ServiceHub.
 */
import { z } from "zod";
import {
  HubOperationIdSchema,
  LrmOperationIdSchema,
  RevisionSchema,
  ModelBindingActivationContractVersionSchema,
} from "./common.js";
import { PrimaryBundlePrepareReasonCodeSchema } from "./primary-bundle.js";

export const ModelBindingActivationIntentSchema = z.enum(["download_and_connect", "connect", "disconnect"]);
export type ModelBindingActivationIntent = z.infer<typeof ModelBindingActivationIntentSchema>;

export const ModelBindingActivationStageSchema = z.enum([
  "preparing",
  "activating",
  "aligning_runtime",
]);
export type ModelBindingActivationStage = z.infer<typeof ModelBindingActivationStageSchema>;

/**
 * Why the sandbox could not be provisioned or started, as the closed refusal word SandboxManager's
 * broker client reports (`BrokerRefusalReason`). A word, never detail text: paths, SIDs and exception
 * messages do not cross this boundary. A new word is a contract change here, in ServiceHub's copy
 * table and in SandboxManager's reporting set; a sandbox_manager test pins the three together.
 */
export const RuntimeProvisionFailureReasonSchema = z.enum([
  "broker_not_found",
  "launcher_not_found",
  "launch_refused",
  "owner_sid_unavailable",
  "tier_identity_missing",
  "provision_refused",
  "provision_elevation_failed",
  "provision_connect_timeout",
  "provision_frame_timeout",
  "provision_broker_exited",
  "provision_required",
  "provision_elevation_declined",
  "provision_pipe_refused",
]);
export type RuntimeProvisionFailureReason = z.infer<typeof RuntimeProvisionFailureReasonSchema>;

const ELEVATION_RETRY = "Click Retry and approve the prompt.";
const HELPER_RETRY = "Click Retry; if it keeps failing, restart SuperClaw.";
const DETAIL_IN_LOG = "The details are kept out of this window; see the sandbox manager log on this machine.";
const REINSTALL_IF_PERSISTS = "Click Retry; if it keeps failing, reinstall SuperClaw.";

/**
 * The one spelling of the user-facing sentence for each reason, read by ServiceHub (generated Python
 * data) and the console. Plain curated text: it never carries a path, SID, key or exception text, and
 * for a security-flavoured refusal it names the class of failure and where the detail lives instead
 * of the detail itself.
 */
export const RUNTIME_PROVISION_FAILURE_COPY: Record<RuntimeProvisionFailureReason, string> = {
  broker_not_found:
    "A sandbox component (the administrator helper) is missing from this SuperClaw installation. Reinstall SuperClaw.",
  launcher_not_found:
    "A sandbox component (the launcher) is missing from this SuperClaw installation. Reinstall SuperClaw.",
  launch_refused:
    `Windows or the sandbox launcher refused to start a sandboxed SuperClaw component. ${DETAIL_IN_LOG} ${REINSTALL_IF_PERSISTS}`,
  owner_sid_unavailable:
    "SuperClaw could not identify the Windows account it is running as, which the sandbox needs. " +
    "Sign out of Windows and back in, then start SuperClaw again; if it keeps failing, see the sandbox manager log on this machine.",
  tier_identity_missing:
    "The sandbox's Windows accounts for this user are not set up, and setting them up needs administrator " +
    `approval (UAC) that was not requested or given. ${ELEVATION_RETRY}`,
  provision_refused:
    "The administrator helper declined to set up the sandbox because one of its safety checks failed " +
    `(for example folder ownership or permissions). ${DETAIL_IN_LOG} ${REINSTALL_IF_PERSISTS}`,
  provision_elevation_failed:
    "Windows could not complete the administrator approval (UAC) needed to set up the sandbox. " +
    `${ELEVATION_RETRY} If it keeps failing, sign in with an account that can approve administrator prompts.`,
  provision_connect_timeout: `The administrator helper that sets up the sandbox did not respond in time. ${HELPER_RETRY}`,
  provision_frame_timeout:
    `The administrator helper that sets up the sandbox stopped responding before it finished. ${HELPER_RETRY}`,
  provision_broker_exited: `The administrator helper that sets up the sandbox exited before it finished. ${HELPER_RETRY}`,
  provision_required:
    "The sandbox's folder permissions no longer match and must be re-applied, which needs administrator " +
    `approval (UAC) that was not completed. ${ELEVATION_RETRY}`,
  provision_elevation_declined:
    "Windows needs administrator approval to set up the sandbox (UAC), and the prompt was dismissed or " +
    `timed out with nobody at the desk. ${ELEVATION_RETRY}`,
  provision_pipe_refused:
    "SuperClaw rejected a message from the administrator helper because it failed an identity or integrity " +
    `check, and stopped as a precaution. ${DETAIL_IN_LOG} ${REINSTALL_IF_PERSISTS}`,
};

/** Fail-closed, secret-free error envelope. Discriminated on `code`. */
export const ModelBindingActivationErrorSchema = z.discriminatedUnion("code", [
  z
    .object({
      code: z.literal("download_confirmation_required"),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("bundle_candidate_changed"),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("idempotency_conflict"),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("model_binding_activation_in_progress"),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("lrm_bundle_revision_conflict"),
      message: z.string(),
      expected_bundle_revision: RevisionSchema,
      actual_bundle_revision: RevisionSchema,
    })
    .strict(),
  z
    .object({
      code: z.literal("runtime_alignment_conflict"),
      message: z.string(),
      expected_profile_revision: RevisionSchema,
      actual_profile_revision: RevisionSchema,
      expected_bundle_revision: RevisionSchema.optional(),
      actual_bundle_revision: RevisionSchema.optional(),
    })
    .strict(),
  z
    .object({
      code: z.literal("safe_error"),
      message: z.string(),
      // The LRM readback's prepare-failure classification, when it had one.
      reason_code: PrimaryBundlePrepareReasonCodeSchema.optional(),
    })
    .strict(),
  z
    .object({
      code: z.literal("feature_not_ready"),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("recovery_required"),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("connect_intent_required"),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("primary_bundle_prepare_in_progress"),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("preparation_recovery_required"),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("pending_bundle_recovery_required"),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("preparation_identity_mismatch"),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("disconnect_not_available"),
      message: z.string(),
    })
    .strict(),
  // The Runtime could not start because the sandbox could not be provisioned. `message` is curated
  // user-facing text for `reason`, and the console shows both.
  z
    .object({
      code: z.literal("runtime_provision_failed"),
      reason: RuntimeProvisionFailureReasonSchema,
      message: z.string(),
    })
    .strict(),
]);
export type ModelBindingActivationError = z.infer<typeof ModelBindingActivationErrorSchema>;
export type ModelBindingActivationErrorCode = ModelBindingActivationError["code"];

/**
 * The generic sentence an activation failure carried before each code had its own text. It stays valid
 * on the wire (an older ServiceHub still sends it, and ServiceHub still uses it for a word this contract
 * does not list); a console that knows the code shows the code's sentence instead.
 */
export const ACTIVATION_FALLBACK_MESSAGE = "Model Binding Activation could not be completed safely.";

/** `<sentence> (Code: <code>)`: the one spelling of a stable code after its sentence, on every surface. */
export function withStableCode(sentence: string, code: string): string {
  return `${sentence} (Code: ${code})`;
}

/** Whether `message` already ends with its stable code (ServiceHub spells an internal cause itself). */
export function hasStableCode(message: string): boolean {
  return /\(Code: [a-z0-9_]+\)$/.test(message);
}

const TRY_AGAIN_OR_RESTART = "Try again; if it keeps failing, restart SuperClaw.";
const CURRENT_MODEL_KEPT = "Your current model was not changed.";

/**
 * The one spelling of the user-facing sentence for each activation error code, read by ServiceHub
 * (generated Python data, which writes it into the receipt and into the HTTP error body) and by the
 * console. Each says what is known and what to do. It is plain curated text and never carries a path,
 * SID, key or exception text. Where a code can arise in more than one place the sentence states only
 * what is true in all of them. `runtime_provision_failed` is worded per reason in
 * `RUNTIME_PROVISION_FAILURE_COPY`; its entry here is the sentence for a reason this contract does not list.
 */
export const MODEL_BINDING_ACTIVATION_ERROR_COPY: Record<ModelBindingActivationErrorCode, string> = {
  download_confirmation_required:
    "This model has files that must be downloaded first, and the download was not confirmed, so nothing was " +
    "started. Try again and confirm the download.",
  bundle_candidate_changed:
    "The model, its files or the Edge connection changed since SuperClaw last checked, so this change was not " +
    "applied. Try again so SuperClaw checks the current state.",
  idempotency_conflict:
    "SuperClaw refused this request because it reused the identifier of an earlier, different request. " +
    TRY_AGAIN_OR_RESTART,
  model_binding_activation_in_progress: "Another model change is already in progress. Wait for it to finish, then try again.",
  lrm_bundle_revision_conflict:
    "The active model changed while SuperClaw was preparing this change, so it was not applied. Try again to " +
    "continue from the current model.",
  runtime_alignment_conflict: `The active model profile and the running workspace no longer match. ${TRY_AGAIN_OR_RESTART}`,
  safe_error: `SuperClaw could not finish this change and stopped as a precaution. ${TRY_AGAIN_OR_RESTART}`,
  feature_not_ready:
    "A sandbox component this change needs is not ready yet. Wait a moment and try again; if it keeps failing, " +
    "restart SuperClaw.",
  recovery_required:
    "SuperClaw is still recovering from an earlier, interrupted model change and cannot start another yet. " +
    "Restart SuperClaw and try again.",
  connect_intent_required:
    "SuperClaw asked to download files for a model that needs no download, so this change was not applied. Try again.",
  primary_bundle_prepare_in_progress: "A different model is already being prepared. Wait for it to finish, then try again.",
  preparation_recovery_required:
    "SuperClaw could not continue an earlier, interrupted model preparation, so it stopped this change. " +
    `${CURRENT_MODEL_KEPT} Try again to start the preparation over.`,
  pending_bundle_recovery_required:
    "A model preparation that was in progress is no longer running, so SuperClaw stopped this change. " +
    `${CURRENT_MODEL_KEPT} Try again to start it over.`,
  preparation_identity_mismatch:
    "The model SuperClaw prepared does not match this request, so it stopped this change. " +
    `${CURRENT_MODEL_KEPT} Try again to prepare it again.`,
  disconnect_not_available:
    "Disconnecting the Edge server is not available right now: it needs a connected Edge model on a cloud-only " +
    "(Lite) device. Nothing was changed.",
  runtime_provision_failed: "SuperClaw could not set up its sandbox. Click Retry, or restart SuperClaw.",
};

/**
 * Why an activation failed, for the failures the public error folds into `safe_error`: ServiceHub's own
 * words for where a committed model change or its Runtime start stopped, plus the one Lite B4 word the
 * activation union does not list. They are never on the wire as a `code`; the receipt keeps the word and
 * ServiceHub writes its sentence into the `safe_error` message.
 */
export const ActivationFailureCauseSchema = z.enum([
  "runtime_transition_identity_missing",
  "native_runtime_unavailable",
  "profile_store_corrupt",
  "runtime_profile_unreadable",
  "runtime_profile_incompatible",
  "runtime_instance_failed",
  "runtime_instance_unavailable",
  "runtime_transition_conflict",
  "runtime_deployment_conflict",
  "runtime_deployment_response_invalid",
  "binding_only_active_profile_missing",
  "binding_only_profile_conflict",
  "pending_bundle_conflict",
]);
export type ActivationFailureCause = z.infer<typeof ActivationFailureCauseSchema>;

/** The sentence for each cause. Same rules as `MODEL_BINDING_ACTIVATION_ERROR_COPY`. */
export const ACTIVATION_FAILURE_CAUSE_COPY: Record<ActivationFailureCause, string> = {
  runtime_transition_identity_missing:
    `SuperClaw's record of this model change is incomplete, so it could not start the workspace for it. ${TRY_AGAIN_OR_RESTART}`,
  native_runtime_unavailable: `The sandbox did not become ready, so SuperClaw stopped waiting for it. ${TRY_AGAIN_OR_RESTART}`,
  profile_store_corrupt: "SuperClaw's saved model profile is damaged or unreadable. Restart SuperClaw and try again.",
  runtime_profile_unreadable:
    "SuperClaw could not load the product profile this model needs, and trying again will not help. Reinstall SuperClaw.",
  runtime_profile_incompatible:
    "This model uses a capability contract version this SuperClaw does not support, and trying again will not help. " +
    "Update or reinstall SuperClaw.",
  runtime_instance_failed: `The sandbox runtime did not start as requested. ${TRY_AGAIN_OR_RESTART}`,
  runtime_instance_unavailable:
    "SuperClaw could not read the sandbox's status, so it could not tell whether the workspace started. " +
    TRY_AGAIN_OR_RESTART,
  runtime_transition_conflict:
    "SuperClaw's saved profile or the sandbox's state stopped matching this change while the workspace was " +
    "starting, so SuperClaw stopped. Try again.",
  runtime_deployment_conflict:
    "The sandbox refused this change because it conflicts with the configuration it already holds. " +
    "Restart SuperClaw and try again.",
  runtime_deployment_response_invalid:
    `The sandbox's answer did not match what SuperClaw asked it to store, so SuperClaw stopped. ${TRY_AGAIN_OR_RESTART}`,
  binding_only_active_profile_missing:
    "SuperClaw could not find the active profile to attach this model to. Restart SuperClaw and try again.",
  binding_only_profile_conflict:
    "The active profile changed while SuperClaw was attaching this model, so it stopped. Try again.",
  pending_bundle_conflict:
    "Another model is pending, or this one was not prepared, so this change was not applied. Try again.",
};

/** What ServiceHub writes for a cause: the sentence with the cause word, which is not on the wire, as its code. */
export function activationFailureCauseMessage(cause: ActivationFailureCause): string {
  return withStableCode(ACTIVATION_FAILURE_CAUSE_COPY[cause], cause);
}

export const ModelBindingActivationProgressSchema = z
  .object({
    pct: z.number().min(0).max(100),
    lrm_prepare_operation_id: LrmOperationIdSchema.optional(),
  })
  .strict();
export type ModelBindingActivationProgress = z.infer<typeof ModelBindingActivationProgressSchema>;

export const ApplyingModelBindingActivationOperationSchema = z
  .object({
    contract_version: ModelBindingActivationContractVersionSchema,
    status: z.literal("applying"),
    operation_id: HubOperationIdSchema,
    stage: ModelBindingActivationStageSchema,
    progress: ModelBindingActivationProgressSchema.optional(),
  })
  .strict();
export type ApplyingModelBindingActivationOperation = z.infer<typeof ApplyingModelBindingActivationOperationSchema>;

/** Public operation projection. Internal journal phase/state never cross this boundary. */
export const ModelBindingActivationOperationSchema = z.discriminatedUnion("status", [
  ApplyingModelBindingActivationOperationSchema,
  z
    .object({
      contract_version: ModelBindingActivationContractVersionSchema,
      status: z.literal("failed"),
      operation_id: HubOperationIdSchema,
      error: ModelBindingActivationErrorSchema,
      retryable: z.boolean(),
    })
    .strict(),
  z
    .object({
      contract_version: ModelBindingActivationContractVersionSchema,
      status: z.literal("succeeded"),
      operation_id: HubOperationIdSchema,
      runtime_transition_required: z.boolean(),
    })
    .strict(),
]);
export type ModelBindingActivationOperation = z.infer<typeof ModelBindingActivationOperationSchema>;

/**
 * App-facing activation request (`POST /app/model-binding/activations`). Names the
 * target bundle explicitly. Candidate facts are protected by
 * `candidate_revision`; the committed bundle revision does not exist until
 * LRM commit succeeds. `download_and_connect` REQUIRES
 * explicit consent (`user_confirmed_download: true`) plus the `candidate_revision`
 * displayed to the user; the verified-cache path uses `connect`. Consent is
 * enforced by the union so a parse rejects unconfirmed downloads.
 *
 * `disconnect` releases the committed bundle and returns to a bundle-free
 * Profile (today, only the cloud-only Lite Profile reaches this state). It
 * carries no `target_bundle_id` / `candidate_revision` — there is no target.
 */
export const ModelBindingActivationRequestSchema = z.discriminatedUnion("intent", [
  z
    .object({
      contract_version: ModelBindingActivationContractVersionSchema,
      intent: z.literal("download_and_connect"),
      target_bundle_id: z.string().min(1),
      candidate_revision: RevisionSchema,
      user_confirmed_download: z.literal(true),
      expected_bundle_revision: RevisionSchema,
      idempotency_key: z.string().min(1),
    })
    .strict(),
  z
    .object({
      contract_version: ModelBindingActivationContractVersionSchema,
      intent: z.literal("connect"),
      target_bundle_id: z.string().min(1),
      candidate_revision: RevisionSchema,
      expected_bundle_revision: RevisionSchema,
      idempotency_key: z.string().min(1),
    })
    .strict(),
  z
    .object({
      contract_version: ModelBindingActivationContractVersionSchema,
      intent: z.literal("disconnect"),
      expected_bundle_revision: RevisionSchema,
      idempotency_key: z.string().min(1),
    })
    .strict(),
]);
export type ModelBindingActivationRequest = z.infer<typeof ModelBindingActivationRequestSchema>;

/** Read-only discovery of the single active activation, if one exists. */
export const ModelBindingActivationActiveResponseSchema = z
  .object({
    contract_version: ModelBindingActivationContractVersionSchema,
    operation: ApplyingModelBindingActivationOperationSchema.nullable(),
  })
  .strict();
export type ModelBindingActivationActiveResponse = z.infer<typeof ModelBindingActivationActiveResponseSchema>;

/**
 * Transport-neutral cancellation command. The existing bodyless HTTP route
 * derives `operation_id` from `/app/operations/{operation_id}/cancellations`
 * before validating this shape. Ordinary cancellation is rejected after LRM
 * commit by ServiceHub, not by the wire schema.
 */
export const ModelBindingActivationCancellationSchema = z
  .object({
    contract_version: ModelBindingActivationContractVersionSchema,
    operation_id: HubOperationIdSchema,
  })
  .strict();
export type ModelBindingActivationCancellation = z.infer<typeof ModelBindingActivationCancellationSchema>;
