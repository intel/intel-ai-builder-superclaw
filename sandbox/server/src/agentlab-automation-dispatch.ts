/**
 * Which OpenCode agent an Agent Lab run should use (#3279).
 *
 * A chat turn classifies an unpinned prompt and can hand it to email-agent.
 * A scheduler run used to post that same prompt with no agent, so it stayed on
 * superclaw-default. That agent can read the email skill and still cannot call
 * run_email_pipeline, and the model then reports Gmail as unconfigured.
 *
 * A stored agent is the user's choice and is not reclassified. With none stored,
 * classify the way chat does, and keep today's default agent when the classifier
 * is absent, asks for clarification, or names an agent this workspace cannot run.
 * An email prompt on the cloud model is refused rather than rerouted.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { ProductProfileDescriptorSchema } from "@different-ai/openwork-contracts/capability";

import { assertAutomationAgentRunnable, type AgentLabAutomation, type AgentLabAutomationStore } from "./agentlab-automation.js";
import { ApiError } from "./errors.js";
import { intentClassifierBaseUrl, intentClassifierRequestHeaders } from "./intent-classifier-proxy.js";
import { publishedProfilePath } from "./mcp-local-command-gate.js";

/** One LLM classify on the sidecar is capped at 30s; leave room for that call. */
const AUTOMATION_CLASSIFY_TIMEOUT_MS = 45_000;

type Env = Readonly<Record<string, string | undefined>>;

type ClassifierPayload = {
  agent?: unknown;
  response?: unknown;
};

let loggedClassifierUnavailable = false;

function logClassifierUnavailable(detail: string): void {
  if (loggedClassifierUnavailable) return;
  loggedClassifierUnavailable = true;
  console.log(`[AgentLab:classify] classifier unavailable; unpinned automations stay on the default agent (${detail})`);
}

/**
 * Parse a "providerID/modelID" string into the object shape expected by
 * OpenCode's prompt_async body ({ model: { providerID, modelID } }).
 */
export function parseModelString(model: string): { model: { providerID: string; modelID: string } } | Record<string, never> {
  const idx = model.indexOf("/");
  if (idx <= 0) return {};
  return { model: { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) } };
}

/**
 * The specialist a classifier answer routes to, or undefined for the default agent.
 *
 * A reply with text and no agent is a clarification card. A scheduler has no
 * one to answer it, so the saved prompt still runs on the default agent.
 * `general-task-agent` is the classifier's name for that same default.
 */
export function runtimeAgentFromClassifierPayload(payload: ClassifierPayload): string | undefined {
  const agent = typeof payload.agent === "string" && payload.agent.trim() ? payload.agent.trim() : undefined;
  const response = typeof payload.response === "string" && payload.response.trim() ? payload.response.trim() : undefined;
  if (response && !agent) return undefined;
  if (!agent || agent === "general-task-agent" || agent === "superclaw-default") return undefined;
  return agent;
}

/**
 * False only when the published Product Profile says it runs no classifier, as
 * the UI's `shouldCallIntentClassifier` reads it. The native backend mints the
 * caller token on every Profile, so the token alone does not say a sidecar is
 * listening. No Profile, or one that cannot be read, still classifies.
 */
async function profileRunsClassifier(env: Env): Promise<boolean> {
  const path = publishedProfilePath(env);
  if (!path) return true;
  try {
    const parsed = ProductProfileDescriptorSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return !parsed.success || parsed.data.feature_flags.intent_classifier;
  } catch {
    return true;
  }
}

export async function classifyUnpinnedAutomationPrompt(text: string, classifierSessionId: string): Promise<string | undefined> {
  if (!process.env.INTENT_CLASSIFIER_TOKEN?.trim() || !(await profileRunsClassifier(process.env))) return undefined;
  try {
    // egress-surface: openwork_proxy_intent_classifier
    const response = await fetch(`${intentClassifierBaseUrl()}/classify`, {
      method: "POST",
      headers: intentClassifierRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ text, session_id: classifierSessionId, stateless: true }),
      signal: AbortSignal.timeout(AUTOMATION_CLASSIFY_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      logClassifierUnavailable(`HTTP ${response.status}`);
      return undefined;
    }
    return runtimeAgentFromClassifierPayload((await response.json()) as ClassifierPayload);
  } catch (error) {
    logClassifierUnavailable(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/**
 * email-agent on the auto-router stays on the local model, as chat's
 * `resolveAgentModelOverride` keeps it. Chat also keeps auto when the UI knows
 * the local model is down; the server cannot see that, so a run always pins.
 */
function modelForAgent(agent: string | undefined, model: string): string {
  return agent === "email-agent" && model === "llmrouter/auto" ? "llmrouter/local-model" : model;
}

/**
 * Named rather than omitted: with no agent the engine runs its default, but the
 * tool gate falls back to the session's last agent, and an automation thread's
 * last agent can be a specialist from an earlier run.
 */
const DEFAULT_AGENT = "superclaw-default";
const CLOUD_MODEL = "llmrouter/cloud-model";

/** The run was refused for a reason a retry on the next tick cannot fix. */
export const EMAIL_AGENT_CLOUD_CONSENT_REQUIRED = "email_agent_cloud_consent_required";

type OpencodeGet = (path: string) => Promise<unknown>;
type Classify = (text: string, classifierSessionId: string) => Promise<string | undefined>;
type AutomationRunTarget = { agent: string; model: string; freshSession?: boolean };

/**
 * Agent and model to send on this run, and whether it needs a new thread.
 *
 * Call this before resolving the automation's session: a refusal must not
 * create or prune one, or every slot would leave another orphan behind.
 *
 * Automations reuse one thread, and earlier email-agent runs leave mail in it.
 * A run on `llmrouter/cloud-model` would replay that history to the cloud, so
 * it starts a new thread instead, unless the user pinned email-agent together
 * with that model and made the choice when saving it. The check holds only if
 * the caller posts the prompt inside `exclusiveAutomationDispatch` and reports
 * the thread to `noteDispatchedAgent` first.
 */
export async function resolveAutomationRunTarget(
  automation: { id: string; agent?: string; prompt: string; lastRunSessionId?: string },
  model: string,
  opencodeGet: OpencodeGet,
  classify: Classify = classifyUnpinnedAutomationPrompt,
): Promise<AutomationRunTarget> {
  const target = await pickAgent(automation, model, () => opencodeGet("/agent"), classify);
  if (target.model !== CLOUD_MODEL || target.agent === "email-agent") return target;
  if (!(await threadHasEmailAgentTurns(automation.lastRunSessionId, opencodeGet))) return target;
  console.log(`[AgentLab:classify] automation=${automation.id} starts a new thread: the last one holds Email Agent turns`);
  return { ...target, freshSession: true };
}

/**
 * A stored agent is kept, and one OpenCode can no longer run fails the run
 * loudly: the user pinned it. An unpinned prompt is classified, and a routed
 * agent this workspace cannot run falls back to the default instead of failing
 * the job — the user did not pin it.
 *
 * Chat asks before email-agent sends mail to `llmrouter/cloud-model`, and a
 * scheduled run has no one to ask, so an unpinned prompt routed there is
 * refused. Running it on the default agent would report the inbox unreachable.
 *
 * Each run classifies statelessly under a key of its own: the classifier's
 * intake history and display cache are per session id, and a one-shot run has
 * no one to answer a clarification, so nothing may carry into the next run or
 * show in a thread.
 */
async function pickAgent(
  automation: { id: string; agent?: string; prompt: string },
  model: string,
  loadAgents: () => Promise<unknown>,
  classify: Classify,
): Promise<AutomationRunTarget> {
  if (automation.agent) {
    await assertAutomationAgentRunnable(automation.agent, loadAgents);
    return { agent: automation.agent, model: modelForAgent(automation.agent, model) };
  }
  const routed = await classify(automation.prompt, `agentlab:${automation.id}:${randomUUID()}`);
  if (!routed) return { agent: DEFAULT_AGENT, model };
  try {
    await assertAutomationAgentRunnable(routed, loadAgents);
  } catch (error) {
    if (error instanceof ApiError && (error.code === "invalid_agent" || error.code === "opencode_unavailable")) {
      console.log(`[AgentLab:classify] automation=${automation.id} agent=${routed} is not runnable; using the default agent`);
      return { agent: DEFAULT_AGENT, model };
    }
    throw error;
  }
  if (routed === "email-agent" && model === CLOUD_MODEL) {
    console.log(`[AgentLab:classify] automation=${automation.id} agent=${routed} refused on ${model}`);
    throw new ApiError(
      409,
      EMAIL_AGENT_CLOUD_CONSENT_REQUIRED,
      "This automation reads your email, and Email Agent needs your confirmation before using the cloud model. Switch the automation's model to Auto or a local model.",
    );
  }
  console.log(`[AgentLab:classify] automation=${automation.id} agent=${routed}`);
  return { agent: routed, model: modelForAgent(routed, model) };
}

/**
 * Threads this process has sent an Email Agent prompt. prompt_async answers
 * before OpenCode stores the message, so reading the thread can miss a run
 * dispatched a moment earlier.
 */
const emailAgentThreads = new Set<string>();

export function noteDispatchedAgent(sessionId: string, agent: string): void {
  if (agent === "email-agent") emailAgentThreads.add(sessionId);
}

async function threadHasEmailAgentTurns(sessionId: string | undefined, opencodeGet: OpencodeGet): Promise<boolean> {
  if (!sessionId?.trim()) return false;
  if (emailAgentThreads.has(sessionId)) return true;
  let messages: unknown;
  try {
    messages = await opencodeGet(`/session/${encodeURIComponent(sessionId)}/message`);
  } catch (error) {
    if (error instanceof ApiError && (error.details as { status?: number } | undefined)?.status === 404) return false;
    throw error;
  }
  return Array.isArray(messages) && messages.some((message: { info?: { agent?: unknown } } | null) => message?.info?.agent === "email-agent");
}

/**
 * Counts a refusal the next tick cannot fix as this slot's run, with its
 * reason, so the scheduler neither retries it every tick nor reports it as ran.
 */
export function recordRefusedRun(automation: { lastRunAt?: number; lastRunError?: string }, error: unknown, now: number): boolean {
  if (!(error instanceof ApiError) || error.code !== EMAIL_AGENT_CLOUD_CONSENT_REQUIRED) return false;
  automation.lastRunAt = now;
  automation.lastRunError = error.message;
  return true;
}

type RunRecord = Pick<AgentLabAutomation, "id" | "lastRunAt" | "lastRunSessionId" | "lastRunError" | "updatedAt">;

/**
 * Put the scheduler's run results onto the store as it is now. The scheduler
 * reads the store before it dispatches, which can take tens of seconds, and
 * writing that snapshot back would drop an automation created meanwhile and
 * bring back one that was deleted. Only the run fields of automations that are
 * still stored are applied; everything else is left as the file has it.
 */
export function applyRunResults(current: AgentLabAutomationStore, ran: RunRecord[]): AgentLabAutomationStore {
  const results = new Map(ran.map((item) => [item.id, item]));
  return {
    ...current,
    items: current.items.map((item) => {
      const result = results.get(item.id);
      if (!result) return item;
      return {
        ...item,
        lastRunAt: result.lastRunAt,
        lastRunSessionId: result.lastRunSessionId,
        lastRunError: result.lastRunError,
        updatedAt: result.updatedAt,
      };
    }),
  };
}

export const AUTOMATION_RUN_IN_PROGRESS = "automation_run_in_progress";

const dispatching = new Set<string>();

/**
 * One dispatch per automation at a time, across Run now and the scheduler. A
 * cloud run reads its thread for Email Agent turns and then posts to it; a local
 * Email Agent run posting in between would hand the cloud mail. The second
 * dispatch is turned away rather than queued: a queued Run now could post after
 * its caller timed out, and a retry would then run it twice.
 */
export async function exclusiveAutomationDispatch<T>(key: string, dispatch: () => Promise<T>): Promise<T> {
  if (dispatching.has(key)) {
    throw new ApiError(409, AUTOMATION_RUN_IN_PROGRESS, "This automation is already starting a run. Try again in a moment.");
  }
  dispatching.add(key);
  try {
    return await dispatch();
  } finally {
    dispatching.delete(key);
  }
}

/**
 * Wraps a timer callback so a tick that is still running makes the next one a
 * no-op. Classifying a prompt can outlast the scheduler's interval, and a due
 * automation is only marked run after it dispatches.
 */
export function skipWhileRunning(tick: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } finally {
      running = false;
    }
  };
}
