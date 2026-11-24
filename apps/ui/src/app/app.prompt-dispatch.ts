/**
 * The prompt dispatch path: everything between the user hitting send and
 * OpenCode receiving a turn — attachment upload, the intent-classifier gate
 * and its agent handoff, model-override resolution, and the shell/command/
 * prompt branches, plus the rollback that runs when any of it fails.
 *
 * This is one function because it is one transaction: several of its steps
 * arm a rollback that a later step disarms, so splitting it apart would mean
 * threading that state through return values. It moved out of `App()` as-is;
 * the dependency list below is the closure it used to read directly.
 */
import { createSignal, type Accessor, type Setter } from "solid-js";
import type { Agent, TextPartInput } from "@opencode-ai/sdk/v2/client";
import type { SessionStore } from "~/features/session";

import { resolveAgentForDispatch } from "./agent-dispatch";
import { resolveAgentModelOverride } from "./app.agent-model-policy";
import { assertNoClientError } from "./app.provider-errors";
import {
  type AmbiguousPromptEntry,
  buildClassifierText,
  buildCommandFileParts,
  buildHandoffSummaryPart,
  buildPromptParts,
  collectAmbiguousExtraParts,
  mapClassifierAgentToRuntimeAgent,
  prependAmbiguousPromptContext,
  resolveLeadingMentionAgent,
} from "./app.prompt-parts";
// Re-exported so app.tsx's signal can name the type without a second import
// line for app.prompt-parts.ts (app.tsx is on the file-size ratchet).
export type { AmbiguousPromptEntry };
import {
  isAmbiguousClassifierTurn,
  latchClassifierResolvedSession,
  shouldCallIntentClassifier,
} from "~/shared/platform/capability/intent-classifier-call-policy";
import { inboxPathToLink } from "./components/session/composer.attachments";
import {
  composerAttachmentModeError,
  uploadComposerAttachments,
} from "./components/session/composer-attachment-uploads";
import { requiresEmailAgentCloudRiskConfirmation } from "./email-agent-cloud-risk";
import { unwrap } from "./lib/opencode";
import { shellInSession } from "./lib/opencode-session";
import { openHydrationClaim } from "./lib/intent-session-display-hydrate";
import { OpenworkServerError } from "./lib/openwork-server";
import type { OpenworkServerClient } from "./lib/openwork-server";
import { uiLogWarn } from "~/shared/platform/log/log";
import { pendingUserMessageToClassifierTurn } from "~/shared/util/pending-user-message";
import { finishPerf, perfNow, recordPerfLog } from "./lib/perf-log";
import { addOpencodeCacheHint, safeStringify } from "./utils";
import { resolveCodexReasoningEffort } from "./utils/model-variant";
import type {
  Client,
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  MessageWithParts,
  ModelRef,
  PiiLevel,
  SessionClassifierUserTurn,
} from "./types";

export type PromptDispatchDeps = {
  appendSessionClassifierUserTurn: (
    sessionID: string,
    text: string,
    existingTurn?: SessionClassifierUserTurn,
    classifierText?: string,
  ) => SessionClassifierUserTurn | null;
  applySessionAgentModelPolicy: (
    sessionID: string,
    agent: string | null,
  ) => boolean;
  capabilityGate: {
    isActive: () => boolean;
    intentClassifierEnabled: () => boolean;
  };
  classifierAmbiguousPromptsBySessionId: Accessor<
    Record<string, AmbiguousPromptEntry[]>
  >;
  classifierResolvedSessionById: Accessor<Record<string, true>>;
  client: Accessor<Client | null>;
  compactCurrentSession: (
    sessionIdOverride?: string,
    options?: { marker?: "visible" | "none" },
  ) => Promise<void>;
  confirmEmailAgentCloudRisk: () => Promise<boolean>;
  createSessionAndOpen: (options?: {
    dispatchInFlight?: () => boolean;
  }) => Promise<unknown>;
  customPiiCategories: Accessor<string[]>;
  developerMode: Accessor<boolean>;
  listAgents: () => Promise<Agent[]>;
  localModelExplicitlyUnavailable: Accessor<boolean>;
  messages: Accessor<MessageWithParts[]>;
  modelVariant: Accessor<string | null>;
  openworkServerClient: Accessor<OpenworkServerClient | null>;
  openworkServerWorkspaceId: Accessor<string | null>;
  piiLevel: Accessor<PiiLevel>;
  prompt: Accessor<string>;
  selectedSessionAgent: Accessor<string | null>;
  selectedSessionId: Accessor<string | null>;
  selectedSessionModel: Accessor<ModelRef>;
  selectedSessionModelIsLocal: Accessor<boolean>;
  sessionStore: SessionStore;
  setBusyLabel: Setter<string | null>;
  setBusyStartedAt: Setter<number | null>;
  setClassifierAmbiguousPromptsBySessionId: Setter<
    Record<string, AmbiguousPromptEntry[]>
  >;
  setClassifierResolvedSessionById: Setter<Record<string, true>>;
  setComposerAttachmentUpload: Setter<{
    sessionID: string;
    paths: string[];
  } | null>;
  /** Dispatch's own busy flag; other busy work holds a separate one. */
  setDispatchBusy: Setter<boolean>;
  setError: Setter<string | null>;
  setLastPromptSent: Setter<string>;
  setLocalLlmConfigWarningOpen: Setter<boolean>;
  setPrompt: Setter<string>;
  setSessionAgent: (
    sessionID: string,
    agent: string | null,
    opts?: { source?: "user" | "classifier" },
  ) => void;
  setSessionModelById: Setter<Record<string, ModelRef>>;
  startSkillCreatorRefreshWatch: () => void;
  stopNarration: () => void;
  workspaceSdkDir: Accessor<string>;
};

export const createPromptDispatch = (deps: PromptDispatchDeps) => {
  // `deps` is a plain object of accessors built once by `App()`, not a Solid
  // props proxy, so destructuring copies function references without
  // collapsing reactivity — and keeps the body below identical to the one
  // that lived in `App()`.
  const {
    appendSessionClassifierUserTurn,
    applySessionAgentModelPolicy,
    capabilityGate,
    classifierAmbiguousPromptsBySessionId,
    classifierResolvedSessionById,
    client,
    compactCurrentSession,
    confirmEmailAgentCloudRisk,
    createSessionAndOpen,
    customPiiCategories,
    developerMode,
    listAgents,
    localModelExplicitlyUnavailable,
    messages,
    modelVariant,
    openworkServerClient,
    openworkServerWorkspaceId,
    piiLevel,
    prompt,
    selectedSessionAgent,
    selectedSessionId,
    selectedSessionModel,
    selectedSessionModelIsLocal,
    sessionStore,
    setBusyLabel,
    setBusyStartedAt,
    setClassifierAmbiguousPromptsBySessionId,
    setClassifierResolvedSessionById,
    setComposerAttachmentUpload,
    setDispatchBusy,
    setError,
    setLastPromptSent,
    setLocalLlmConfigWarningOpen,
    setPrompt,
    setSessionAgent,
    setSessionModelById,
    startSkillCreatorRefreshWatch,
    stopNarration,
    workspaceSdkDir,
  } = deps;

  // Several tabs can dispatch at once. Count them so the first to finish does
  // not clear the flag, and remember which sessions they belong to so only
  // those composers stay blocked.
  const inflight = new Map<string, number>();
  const [dispatchingSessions, setDispatchingSessions] =
    createSignal<ReadonlySet<string>>(new Set());
  let dispatchDepth = 0;

  const trackDispatch = (sessionID: string, delta: 1 | -1) => {
    const count = (inflight.get(sessionID) ?? 0) + delta;
    if (count > 0) inflight.set(sessionID, count);
    else inflight.delete(sessionID);
    setDispatchingSessions(new Set(inflight.keys()));
  };

  const beginDispatch = (sessionID: string) => {
    const opening = dispatchDepth === 0;
    dispatchDepth += 1;
    trackDispatch(sessionID, 1);
    setDispatchBusy(true);
    // The label and clock belong to the dispatch that turned busy on.
    if (!opening) return;
    setBusyLabel("status.running");
    setBusyStartedAt(Date.now());
  };

  const endDispatch = (sessionID: string) => {
    trackDispatch(sessionID, -1);
    dispatchDepth = Math.max(0, dispatchDepth - 1);
    if (dispatchDepth !== 0) return;
    setDispatchBusy(false);
    setBusyLabel(null);
    setBusyStartedAt(null);
  };

  async function sendPrompt(
    draft?: ComposerDraft,
    options?: {
      validateAutoRoutedAgent?: (agent: string) => Promise<boolean> | boolean;
      onAccepted?: () => void;
      // The session this turn is actually dispatched to, reported once it is
      // known. For a first prompt that is after `createSessionAndOpen()`, so
      // a caller tracking the turn cannot read it from the selected session:
      // the user can select another session during that await.
      onSessionResolved?: (sessionID: string) => void;
      submittedAt?: number;
      optimisticUserMessage?: boolean;
      // Rethrow send failures so edit flow can roll back on resend failure.
      rethrowOnError?: boolean;
    },
  ) {
    // Barge-in: cancel any in-flight narration when the user sends a new turn.
    stopNarration();
    const hasExplicitDraft = Boolean(draft);
    const fallbackText = prompt().trim();
    const resolvedDraft: ComposerDraft = draft ?? {
      mode: "prompt",
      parts: fallbackText
        ? [{ type: "text", text: fallbackText } as ComposerPart]
        : [],
      attachments: [] as ComposerAttachment[],
      text: fallbackText,
    };
    let promptDraftForOpenCode = resolvedDraft;
    const content = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();
    if (!content && !resolvedDraft.attachments.length) return;

    const c = client();
    if (!c) return;

    const compactShortcut = /^\/compact(?:\s+.*)?$/i.test(content);
    const skillCreatorShortcut = /^\/skill-creator(?:\s+.*)?$/i.test(content);
    const compactCommand =
      resolvedDraft.command?.name === "compact" || compactShortcut;
    const commandName = compactCommand
      ? "compact"
      : skillCreatorShortcut
        ? "skill-creator"
        : (resolvedDraft.command?.name ?? null);
    const attachmentModeError = composerAttachmentModeError(
      resolvedDraft.mode,
      resolvedDraft.attachments.length,
      compactCommand,
    );
    if (attachmentModeError) {
      setError(attachmentModeError);
      return false;
    }
    if (compactCommand && !selectedSessionId()) {
      setError("Select a session with messages before running /compact.");
      return;
    }

    let sessionID = selectedSessionId();
    if (!sessionID) {
      await createSessionAndOpen({ dispatchInFlight: () => dispatchDepth > 0 });
      sessionID = selectedSessionId();
    }
    if (!sessionID) return false;
    options?.onSessionResolved?.(sessionID);

    // These accessors follow whichever tab is selected. Upload and
    // classification await, and the user can switch tabs — or send from the
    // new one — before this turn reads them again.
    const model = selectedSessionModel();
    const sessionAgent = selectedSessionAgent();
    const modelIsLocal = selectedSessionModelIsLocal();

    beginDispatch(sessionID);
    setError(null);

    const perfEnabled = developerMode();
    const startedAt = perfNow();
    const submitElapsedMs = () =>
      options?.submittedAt === undefined
        ? null
        : Math.round((perfNow() - options.submittedAt) * 100) / 100;
    const visible = messages();
    const visibleParts = visible.reduce(
      (total, message) => total + message.parts.length,
      0,
    );
    recordPerfLog(perfEnabled, "session.prompt", "start", {
      sessionID,
      mode: resolvedDraft.mode,
      command: commandName,
      charCount: content.length,
      attachmentCount: resolvedDraft.attachments.length,
      messageCount: visible.length,
      partCount: visibleParts,
    });

    const shouldAppendPendingUserMessage =
      options?.optimisticUserMessage !== false &&
      resolvedDraft.mode === "prompt" &&
      !compactCommand;
    let pendingUserMessageCommitted = false;
    let pendingUserMessageID: string | null = null;
    const rejectPendingUserMessage = (): false => {
      if (pendingUserMessageCommitted) {
        sessionStore.clearPendingUserMessage(
          sessionID,
          pendingUserMessageID ?? undefined,
        );
        pendingUserMessageCommitted = false;
        pendingUserMessageID = null;
      }
      return false;
    };
    let rollbackUploadedAttachments: (() => Promise<void>) | null = null;
    let uploadedPathsForSelection: string[] | null = null;
    const runAttachmentRollback = async () => {
      const rollback = rollbackUploadedAttachments;
      rollbackUploadedAttachments = null;
      await rollback?.();
    };

    try {
      // Images too: they reach the agent only by their uploaded workspace path.
      const requiresWorkspaceUpload = resolvedDraft.attachments.length > 0;
      const uploadClient = openworkServerClient();
      const uploadWorkspaceId = openworkServerWorkspaceId()?.trim() ?? "";
      // Snapshot with the upload target: a workspace switch while the upload is
      // pending must not re-root these paths.
      const uploadSdkDir = workspaceSdkDir();
      if (requiresWorkspaceUpload && (!uploadClient || !uploadWorkspaceId)) {
        throw new Error(
          "File attachments require a connected SuperClaw server.",
        );
      }
      if (shouldAppendPendingUserMessage) {
        const submissionID =
          typeof crypto !== "undefined" &&
            typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const pendingText =
          content ||
          resolvedDraft.attachments
            .map((attachment) => attachment.name)
            .join(", ");
        const pendingAttachments: Array<{
          url: string;
          mime: string;
          filename: string;
        }> = [];
        let pending: MessageWithParts;
        try {
          // Match the durable card: a kind:"file" attachment with an image/*
          // MIME (e.g. SVG) must not render as an image preview in the pending row.
          for (const attachment of resolvedDraft.attachments) {
            pendingAttachments.push({
              url: URL.createObjectURL(attachment.file),
              mime:
                attachment.kind === "image"
                  ? attachment.mimeType
                  : "application/octet-stream",
              filename: attachment.name,
            });
          }
          pending = sessionStore.appendPendingUserMessage({
            sessionID,
            submissionID,
            text: pendingText,
            createdAt: Date.now(),
            attachments: pendingAttachments,
          });
        } catch (error) {
          for (const attachment of pendingAttachments) {
            URL.revokeObjectURL(attachment.url);
          }
          throw error;
        }
        pendingUserMessageCommitted = true;
        pendingUserMessageID = pending.info.id;
        recordPerfLog(perfEnabled, "session.submit", "pending-user", {
          sessionID,
          submissionID,
          ms:
            options?.submittedAt === undefined
              ? null
              : Math.round((perfNow() - options.submittedAt) * 100) / 100,
        });
      }

      options?.onAccepted?.();

      if (!compactCommand) {
        setLastPromptSent(content);
      }
      if (!hasExplicitDraft) {
        setPrompt("");
      }

      if (resolvedDraft.attachments.length > 0) {
        if (uploadClient && uploadWorkspaceId) {
          const upload = await uploadComposerAttachments(
            uploadClient,
            uploadWorkspaceId,
            resolvedDraft.attachments,
          );
          const uploadedPaths = upload.paths;
          rollbackUploadedAttachments = upload.rollback;
          uploadedPathsForSelection = uploadedPaths;
          const attachmentParts: ComposerDraft["parts"] = uploadedPaths
            .map((path) => ({
              type: "text",
              text: `[Selected file: ${inboxPathToLink(path)}]`,
            }));
          if (attachmentParts.length > 0) {
            const hasUserText = promptDraftForOpenCode.parts.some(
              (part) =>
                part.type === "text" &&
                (part as { text?: string }).text?.trim(),
            );
            promptDraftForOpenCode = {
              ...promptDraftForOpenCode,
              parts: [
                ...promptDraftForOpenCode.parts,
                ...(hasUserText
                  ? [{ type: "text" as const, text: "\n" }]
                  : []),
                ...attachmentParts,
              ],
            };
          }
        }
      }

      let pendingHandoffSummaryPart: TextPartInput | null = null;
      const classifierContent = buildClassifierText(
        promptDraftForOpenCode,
        content,
      );
      const mentionedAgent = await resolveLeadingMentionAgent(
        promptDraftForOpenCode,
        listAgents,
      );
      // A clarified question never reached the model, so the next prompt that
      // does carries it, whether or not the classifier routes that prompt.
      // The store keeps it until dispatch is accepted, so a failed or
      // cancelled send can be retried with the question.
      let sentAmbiguousPrompts: AmbiguousPromptEntry[] = [];
      const consumeAmbiguousPrompts = () => {
        sentAmbiguousPrompts =
          classifierAmbiguousPromptsBySessionId()[sessionID] ?? [];
        promptDraftForOpenCode = prependAmbiguousPromptContext(
          promptDraftForOpenCode,
          sentAmbiguousPrompts,
        );
      };
      // Intent classifier gate:
      // Only classify when the user has not explicitly chosen an agent
      // ("Default" = null means "let the system decide"), and only on Profiles
      // that actually run the sidecar. When a specialized agent is selected,
      // bypass the classifier entirely.
      let agent = resolveAgentForDispatch(mentionedAgent, sessionAgent);
      if (
        shouldCallIntentClassifier({
          profileActive: capabilityGate.isActive(),
          profileIntentClassifierEnabled: capabilityGate.intentClassifierEnabled(),
          sessionAgent,
          resolvedAgent: agent,
          sessionAlreadyResolved: Boolean(classifierResolvedSessionById()[sessionID]),
          hasAttachments:
            resolvedDraft.attachments.length > 0 ||
            resolvedDraft.parts.some((part) => part.type === "file"),
        })
      ) {
        const owClient = openworkServerClient();
        try {
          if (owClient) {
            recordPerfLog(perfEnabled, "session.submit", "classifier-start", {
              sessionID,
              ms: submitElapsedMs(),
            });
            // Held open across the await so a display hydrate that lands first
            // can claim this turn. The send path then skips its own append.
            const claim = openHydrationClaim(sessionID);
            let classified: Awaited<
              ReturnType<OpenworkServerClient["classifyIntent"]>
            > | null = null;
            try {
              classified = await owClient.classifyIntent({
                text: classifierContent,
                session_id: sessionID,
              });
              recordPerfLog(perfEnabled, "session.submit", "classifier-complete", {
                sessionID,
                category: classified.category,
                classifierLatencyMs: classified.latency_ms,
                ms: submitElapsedMs(),
              });
              if (classified.response && !classified.agent) {
                const pending = sessionStore.takePendingUserMessage(sessionID);
                pendingUserMessageCommitted = false;
                pendingUserMessageID = null;
                const ambiguous = isAmbiguousClassifierTurn(classified);
                const taken = claim.take(classifierContent, classified.response);
                if (!taken) {
                  const syntheticUserTurn = appendSessionClassifierUserTurn(
                    sessionID,
                    content,
                    pending
                      ? pendingUserMessageToClassifierTurn(pending)
                      : undefined,
                    classifierContent,
                  );
                  sessionStore.appendSessionClassifierTurn(
                    sessionID,
                    classified.response,
                    ambiguous ? "ambiguous" : "greeting",
                    syntheticUserTurn?.id ?? undefined,
                  );
                } else if (claim.takenUserTurnID) {
                  appendSessionClassifierUserTurn(
                    sessionID,
                    content,
                    {
                      id: claim.takenUserTurnID,
                      text: content,
                      afterMessageID: null,
                      time: 0,
                    },
                    classifierContent,
                  );
                }
                if (ambiguous) {
                  const extraParts = collectAmbiguousExtraParts(
                    promptDraftForOpenCode,
                    workspaceSdkDir(),
                  );
                  setClassifierAmbiguousPromptsBySessionId((current) => ({
                    ...current,
                    [sessionID]: [
                      ...(current[sessionID] ?? []),
                      { text: content, extraParts },
                    ],
                  }));
                }
                return;
              }
            } finally {
              claim.close();
            }
            if (!classified) return;
            const runtimeAgent = mapClassifierAgentToRuntimeAgent(
              classified.agent,
            );
            if (runtimeAgent && options?.validateAutoRoutedAgent) {
              const allowed =
                await options.validateAutoRoutedAgent(runtimeAgent);
              if (!allowed) return rejectPendingUserMessage();
            }
            if (classified.response && classified.agent) {
              sessionStore.appendSessionClassifierTurn(
                sessionID,
                classified.response,
                "redirect",
              );
            }
            agent = runtimeAgent;
            if (classified.handoff_summary) {
              pendingHandoffSummaryPart = runtimeAgent
                ? buildHandoffSummaryPart(
                  classified.handoff_summary,
                  runtimeAgent,
                )
                : null;
            }
            if (runtimeAgent) {
              const policyApplied = applySessionAgentModelPolicy(
                sessionID,
                runtimeAgent,
              );
              if (!policyApplied) {
                // Local-only agent chosen but local model unavailable — surface warning & abort
                setLocalLlmConfigWarningOpen(true);
                return rejectPendingUserMessage();
              }
              setSessionAgent(sessionID, runtimeAgent, {
                source: "classifier",
              });
              // Mark resolved for ANY agent so later turns reuse it instead of
              // re-classifying. Scoping this to superclaw-default was the bug
              // that re-classified already-routed sessions every turn.
              setClassifierResolvedSessionById((current) => latchClassifierResolvedSession(current, sessionID));
              consumeAmbiguousPrompts();
            }
          }
        } catch (error) {
          if (
            error instanceof OpenworkServerError &&
            error.code === "intent_classifier_local_llm_config_error"
          ) {
            setLocalLlmConfigWarningOpen(true);
            return rejectPendingUserMessage();
          }
          if (
            error instanceof OpenworkServerError &&
            error.code === "intent_classifier_lrm_auth_error"
          ) {
            throw error;
          }
          if (
            error instanceof OpenworkServerError &&
            (error.code === "intent_classifier_auth_failed" ||
              error.code === "intent_classifier_auth_unconfigured")
          ) {
            uiLogWarn(
              "intent.classify",
              "Intent classifier caller credential failed; fell back to the default agent",
              { code: error.code, sessionID },
            );
          }
          // Any other failure falls through with agent = null
          // (superclaw-default). A missing sidecar is silent; a caller-credential
          // failure was logged above.
          //
          // Latch the session so the rest of it stops re-paying the timeout.
          // Only the success path latched before, so a sidecar that was missing
          // or had crashed (the orchestrator logs the exit and continues without
          // it) taxed EVERY turn of the session, not just the first. The cost of
          // latching is that a classifier which recovers mid-session no longer
          // routes it; that session has already been dispatched to
          // superclaw-default, which is where re-classification would land it.
          setClassifierResolvedSessionById((current) => latchClassifierResolvedSession(current, sessionID));
        }
      } else if (
        resolvedDraft.mode === "prompt" &&
        !resolvedDraft.command &&
        !compactCommand &&
        !skillCreatorShortcut
      ) {
        consumeAmbiguousPrompts();
      }
      const parts = await buildPromptParts(
        promptDraftForOpenCode,
        workspaceSdkDir,
      );
      // A native chat bound with `/cd` resolves `/workspace/...` against its
      // subdirectory, but uploads land at the workspace root. Name each upload by
      // its real path too; synthetic, so the chat bubble keeps showing only the
      // `/workspace` annotation.
      const sdkRoot = uploadSdkDir.trim().replace(/[\\/]+$/, "");
      const nativeUploadPaths = sdkRoot && sdkRoot !== "/workspace"
        ? (uploadedPathsForSelection ?? []).map((path) => {
            const absolute = `${sdkRoot}/${inboxPathToLink(path).slice("/workspace/".length)}`;
            return /^[a-zA-Z]:[\\/]/.test(absolute) ? absolute.replace(/\//g, "\\") : absolute;
          })
        : [];
      for (const absolute of nativeUploadPaths) {
        parts.push({
          type: "text",
          synthetic: true,
          text: `[Selected file: ${absolute}]`,
        } as TextPartInput);
      }
      if (pendingHandoffSummaryPart) {
        parts.push(pendingHandoffSummaryPart);
      }
      const effectiveModel = resolveAgentModelOverride(
        model,
        agent,
        promptDraftForOpenCode,
        { localModelExplicitlyUnavailable, piiLevel },
      );
      if (
        requiresEmailAgentCloudRiskConfirmation(agent, effectiveModel) &&
        !(await confirmEmailAgentCloudRisk())
      ) {
        return rejectPendingUserMessage();
      }
      const selectedVariant = modelVariant() ?? undefined;
      const reasoningEffort = resolveCodexReasoningEffort(
        model.modelID,
        selectedVariant ?? null,
      );
      const requestVariant = reasoningEffort ? undefined : selectedVariant;
      const promptOverrides: Record<string, unknown> = {};
      if (reasoningEffort) {
        // Use the $body_ prefix so the SDK's buildClientParams includes this field in the request body even though it is not in the generated promptAsync key list.
        promptOverrides["$body_reasoning_effort"] = reasoningEffort;
      }
      if (!modelIsLocal) {
        // piiLevel is not in the OpenAPI-generated promptAsync body key list, so using the bare key causes buildClientParams to silently drop it.
        // The $body_ prefix routes it directly into the request body.
        promptOverrides["$body_piiLevel"] = piiLevel();
        if (piiLevel() === "custom") {
          promptOverrides["$body_customPiiCategories"] = customPiiCategories();
        }
      }

      // A dispatched prompt whose response is lost or times out is ambiguous:
      // the server may have accepted and persisted it. Disarm attachment
      // rollback before any dispatch so an ambiguous failure never deletes files
      // the authoritative user turn still references. Pre-dispatch failures
      // above (upload, classifier, agent policy) keep rollback armed.
      rollbackUploadedAttachments = null;
      if (resolvedDraft.mode === "shell") {
        await shellInSession(c, sessionID, content);
      } else if (
        resolvedDraft.command ||
        compactCommand ||
        skillCreatorShortcut
      ) {
        if (compactCommand) {
          await compactCurrentSession(sessionID);
          finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
            sessionID,
            mode: resolvedDraft.mode,
            command: commandName,
          });
          return;
        }

        const command =
          resolvedDraft.command ??
          (skillCreatorShortcut
            ? {
              name: "skill-creator",
              arguments: content.replace(/^\/skill-creator\b/i, "").trim(),
              dispatch: "prompt" as const,
            }
            : null);
        if (!command) {
          throw new Error("Command was not resolved.");
        }

        // Fallback skill commands come from the Skills page when OpenCode's
        // command list is stale. Send those as normal prompt text so OpenCode
        // can resolve the slash skill without hitting its missing-command path.
        if (command.dispatch === "prompt") {
          recordPerfLog(perfEnabled, "session.submit", "dispatch-start", {
            sessionID,
            command: commandName,
            ms: submitElapsedMs(),
          });
          const result = await c.session.promptAsync({
            sessionID,
            model: effectiveModel,
            agent: agent ?? undefined,
            variant: requestVariant,
            ...promptOverrides,
            parts,
          });
          assertNoClientError(result);
          recordPerfLog(perfEnabled, "session.submit", "dispatch-accepted", {
            sessionID,
            command: commandName,
            ms: submitElapsedMs(),
          });

          setSessionModelById((current) => ({
            ...current,
            [sessionID]: model,
          }));

          if (command.name === "skill-creator") {
            startSkillCreatorRefreshWatch();
          }
        } else {
          // Slash command: route real OpenCode command-list entries through session.command() API.
          // Apply the same agent/PII model override used by the prompt path so
          // that command drafts with @file mentions or non-spreadsheet
          // attachments are also routed to local-model under the PII policy.
          const modelString = `${effectiveModel.providerID}/${effectiveModel.modelID}`;
          const { textOnly } = await buildCommandFileParts(
            promptDraftForOpenCode,
            workspaceSdkDir,
          );
          // A native chat names each upload by its real root path instead.
          const replacedUploadLinks = new Set(
            nativeUploadPaths.length ? (uploadedPathsForSelection ?? []).map(inboxPathToLink) : [],
          );
          const selectedPaths = [
            ...textOnly.filter((path) => !replacedUploadLinks.has(path)),
            ...nativeUploadPaths,
          ];

          // session.command() expects `model` as a provider/model string.
          unwrap(
            await c.session.command({
              sessionID,
              command: command.name,
              arguments: [command.arguments, ...selectedPaths.map((path) => `[Selected file: ${path}]`)]
                .filter(Boolean)
                .join(" "),
              agent: agent ?? undefined,
              model: modelString,
              variant: requestVariant,
              ...promptOverrides,
            }),
          );
          if (command.name === "skill-creator") {
            startSkillCreatorRefreshWatch();
          }
        }
      } else {
        recordPerfLog(perfEnabled, "session.submit", "dispatch-start", {
          sessionID,
          command: commandName,
          ms: submitElapsedMs(),
        });
        const result = await c.session.promptAsync({
          sessionID,
          model: effectiveModel,
          agent: agent ?? undefined,
          variant: requestVariant,
          ...promptOverrides,
          parts,
        });
        assertNoClientError(result);
        recordPerfLog(perfEnabled, "session.submit", "dispatch-accepted", {
          sessionID,
          command: commandName,
          ms: submitElapsedMs(),
        });

        setSessionModelById((current) => ({
          ...current,
          [sessionID]: model,
        }));
      }

      if (sentAmbiguousPrompts.length) {
        // Only the questions this prompt carried. One asked while it was in
        // flight stays for the next prompt.
        setClassifierAmbiguousPromptsBySessionId((current) => {
          const pending = current[sessionID];
          // Reference equality, not just matching text: these entries are
          // read from this same signal in `consumeAmbiguousPrompts` and never
          // mutated in place, so this also catches an entry whose text
          // happens to match but whose carried file selection does not.
          if (
            !pending ||
            !sentAmbiguousPrompts.every(
              (entry, index) => pending[index] === entry,
            )
          ) {
            return current;
          }
          const next = { ...current };
          const rest = pending.slice(sentAmbiguousPrompts.length);
          if (rest.length) next[sessionID] = rest;
          else delete next[sessionID];
          return next;
        });
      }

      if (uploadedPathsForSelection) {
        setComposerAttachmentUpload({
          sessionID,
          paths: uploadedPathsForSelection,
        });
      }
      finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
      });
      // Signal to callers (e.g. submitEditedUserMessage) that a real prompt/command
      // was dispatched to the backend — distinct from returning undefined when the
      // intent-classifier intercepts the message without forwarding it.
      return true;
    } catch (e) {
      let failure = e;
      try {
        await runAttachmentRollback();
      } catch (cleanupError) {
        const originalMessage =
          e instanceof Error ? e.message : safeStringify(e);
        const cleanupMessage =
          cleanupError instanceof Error
            ? cleanupError.message
            : safeStringify(cleanupError);
        failure = new Error(`${originalMessage} ${cleanupMessage}`);
      }
      rejectPendingUserMessage();
      finishPerf(perfEnabled, "session.prompt", "error", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
        error:
          failure instanceof Error ? failure.message : safeStringify(failure),
      });
      const message =
        failure instanceof Error ? failure.message : safeStringify(failure);
      sessionStore.appendSessionErrorTurn(
        sessionID,
        addOpencodeCacheHint(message),
      );
      if (options?.rethrowOnError) {
        throw failure;
      }
      return false;
    } finally {
      if (rollbackUploadedAttachments) {
        try {
          await runAttachmentRollback();
        } catch (cleanupError) {
          const message =
            cleanupError instanceof Error
              ? cleanupError.message
              : safeStringify(cleanupError);
          console.error("Attachment rollback failed.", cleanupError);
          sessionStore.appendSessionErrorTurn(sessionID, message);
        }
      }
      endDispatch(sessionID);
    }
  }

  return { sendPrompt, dispatchingSessions };
};
