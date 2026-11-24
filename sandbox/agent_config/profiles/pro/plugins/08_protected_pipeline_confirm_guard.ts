/**
 * protected_pipeline_confirm_guard
 *
 * PURPOSE:
 *   Acts as a security gate that blocks the AI agent from sending work to the
 *   protected-file-agent until a human has explicitly approved the action.
 *
 *   1. Before every tool call, this plugin checks if the agent is trying to
 *      dispatch a `task` to `protected-file-agent`.
 *   2. If yes, it checks whether the current session already has an approval
 *      token (granted earlier by `confirm_file_protection`).
 *   3. If approved  → the token is consumed (one-shot) and the task proceeds.
 *   4. If NOT approved → the task is blocked and the AI receives an error
 *      telling it to call `confirm_file_protection` first.
 *   5. Custom-agent fallback to local-file-agent requires a fresh decline or
 *      protection-disabled result and consumes it for this request only.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { createProtectedSourceAccess } from "../lib/protected-source-access";

// The name of the agent that requires a confirmation gate before dispatch.
const PROTECTED_PIPELINE_AGENT = "protected-file-agent";

// Key used to store the set of approved session IDs on the global object.
const APPROVAL_KEY = "__sc_confirm_file_protection_approved";
const APPROVED_PATHS_KEY = "__sc_confirm_file_protection_paths";
const DENIAL_KEY = "__sc_confirm_file_protection_denied";
const DECLINE_FALLBACK_KEY = "__sc_decline_fallback_parents";
// "<providerID>/<model id>" of each session's latest request; confirm_file_protection reads it.
const SESSION_MODELS_KEY = "__sc_session_models";
const FILE_COORDINATORS = new Set(["superclaw-default", "build"]);

// A PROTECTED_FILE_PATHS block as appended below: header line, then `- path` lines.
const PATHS_BLOCK_RE = /^[ \t]*PROTECTED_FILE_PATHS(?:[ \t]*\(\d+\))?[ \t]*:[ \t]*\r?\n(?:[ \t]*-[^\r\n]*(?:\r?\n|$))*/gim;

/**
 * Returns the shared Set of session IDs that currently hold an approval token.
 * Lazily initialises the Set on first access.
 */
function approvedSessions(): Set<string> {
  return sharedSessions(APPROVAL_KEY);
}

function sharedSessions(key: string): Set<string> {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>;
  return (g[key] ??= new Set<string>());
}

function agentName(agent: unknown): string {
  if (typeof agent === "string") return agent;
  if (!agent || typeof agent !== "object") return "";
  const record = agent as Record<string, unknown>;
  const name = record.name ?? record.id ?? record.type ?? record.agent;
  return typeof name === "string" ? name : "";
}

export const ProtectedPipelineConfirmGuard: Plugin = async ({ client, directory }) => {
  const sessionAgents = new Map<string, string>();
  const protectedAgents = new Set<string>();
  const sessionModels = ((globalThis as unknown as Record<string, Map<string, string> | undefined>)[SESSION_MODELS_KEY] ??=
    new Map<string, string>());
  const sourceAccess = createProtectedSourceAccess(directory ?? "");
  const pendingConfirmations = new Map<string, string>();
  const fallbackTokens = new Map<string, { request: string; paths: string[] }>();

  const clearRequest = (sessionID: string) => {
    pendingConfirmations.delete(sessionID);
    fallbackTokens.delete(sessionID);
    approvedSessions().delete(sessionID);
    sharedSessions(DENIAL_KEY).delete(sessionID);
    sharedSessions(DECLINE_FALLBACK_KEY).delete(sessionID);
    (globalThis as unknown as Record<string, Map<string, string[]> | undefined>)[APPROVED_PATHS_KEY]?.delete(sessionID);
  };

  // Log once at startup so operators know the guard is active.
  await client.app.log({
    body: {
      service: "protected-pipeline-confirm-guard",
      level: "info",
      message: "plugin initialized — task→protected-file-agent requires confirm",
    },
  });

  return {
    config: async (config) => {
      protectedAgents.clear();
      for (const [name, agent] of Object.entries(config.agent ?? {})) {
        if (FILE_COORDINATORS.has(name) || name === PROTECTED_PIPELINE_AGENT || name === "local-file-agent") continue;
        const permission = agent?.permission;
        const confirmation = permission && "confirm_file_protection" in permission
          ? permission.confirm_file_protection
          : undefined;
        if (confirmation === "ask" || confirmation === "allow") {
          protectedAgents.add(name);
        }
      }
    },
    "chat.params": async (input) => {
      sessionAgents.set(input.sessionID, agentName(input.agent));
      sessionModels.set(input.sessionID, `${input.model?.providerID ?? ""}/${input.model?.id ?? ""}`);
    },
    "chat.message": async (input) => {
      clearRequest(input.sessionID);
      sessionAgents.set(input.sessionID, agentName(input.agent));
    },
    event: async ({ event }) => {
      if (event.type !== "session.deleted") return;
      clearRequest(event.properties.info.id);
      sessionAgents.delete(event.properties.info.id);
      sessionModels.delete(event.properties.info.id);
      sourceAccess.clear(event.properties.info.id);
    },
    "tool.execute.after": async (input, output) => {
      sourceAccess.after(input);
      if (input.tool !== "confirm_file_protection") return;
      if (pendingConfirmations.get(input.sessionID) !== input.callID) return;
      pendingConfirmations.delete(input.sessionID);
      if (!/^(ACTION_DENIED|PROTECTION_DECLINED|PROTECTION_DISABLED):/.test(output.output.trimStart())) return;

      const args = input.args as Record<string, unknown>;
      const rawPaths = args.source_file_paths ?? [args.source_file_path];
      const paths = Array.isArray(rawPaths)
        ? rawPaths.filter((path): path is string => typeof path === "string" && path.trim().length > 0).map((path) => path.trim())
        : [];
      if (!Array.isArray(rawPaths) || !paths.length || paths.length !== rawPaths.length ||
          typeof args.user_request !== "string" || !args.user_request.trim()) {
        throw new Error("File fallback confirmation has no source request or paths.");
      }
      fallbackTokens.set(input.sessionID, { request: args.user_request, paths });
    },
    /**
     * tool.execute.before
     *
     * Runs before EVERY tool call in the session.
     * Gate protected dispatch and custom-agent fallback at the tool boundary.
     */
    "tool.execute.before": async (input, output) => {
      if (protectedAgents.has(sessionAgents.get(input.sessionID) ?? "")) {
        const violation = await sourceAccess.before(
          input, output.args as Record<string, unknown>, sessionModels.get(input.sessionID) === "llmrouter/local-model",
        );
        if (violation) {
          await client.app.log({
            body: { service: "protected-pipeline-confirm-guard", level: "warn", message: violation },
          });
          throw new Error(violation);
        }
      }
      if (input.tool === "confirm_file_protection") {
        clearRequest(input.sessionID);
        pendingConfirmations.set(input.sessionID, input.callID);
        return;
      }
      // Step 1: Ignore any tool that is not `task` — nothing to guard.
      if (input.tool !== "task") return;

      // Step 2: Read which sub-agent the `task` tool is targeting.
      const args = output.args as Record<string, unknown>;
      const subagentType = args.subagent_type ?? args.agent ?? "";

      if (subagentType === "local-file-agent") {
        const token = fallbackTokens.get(input.sessionID);
        fallbackTokens.delete(input.sessionID);
        if (FILE_COORDINATORS.has(sessionAgents.get(input.sessionID) ?? "")) return;
        if (!token) {
          await client.app.log({
            body: {
              service: "protected-pipeline-confirm-guard",
              level: "warn",
              message: `Blocking custom-agent fallback without confirmation for session ${input.sessionID}`,
            },
          });
          throw new Error(
            "DENIED by protected-pipeline-confirm-guard: call confirm_file_protection and receive " +
            "ACTION_DENIED, PROTECTION_DECLINED, or PROTECTION_DISABLED for this request before dispatching to local-file-agent.",
          );
        }
        sharedSessions(DENIAL_KEY).delete(input.sessionID);
        // Plugin 93 needs this receipt when the fallback child session is created.
        sharedSessions(DECLINE_FALLBACK_KEY).add(input.sessionID);
        args.prompt = `${token.request}\n\nProcess only these source files:\n${token.paths.map((path) => `- ${path}`).join("\n")}`;
        return;
      }

      // Step 3: If the target is not the protected agent, allow it through.
      if (subagentType !== PROTECTED_PIPELINE_AGENT) return;

      // Step 4: Check if this session has a pending approval token.
      const approved = approvedSessions();
      if (approved.has(input.sessionID)) {
        // Approval found - allow the task to proceed.
        approved.delete(input.sessionID);
        const paths = (globalThis as unknown as Record<string, Map<string, string[]> | undefined>)[APPROVED_PATHS_KEY]?.get(input.sessionID);
        (globalThis as unknown as Record<string, Map<string, string[]> | undefined>)[APPROVED_PATHS_KEY]?.delete(input.sessionID);
        if (!paths?.length) throw new Error("Protected-file approval has no validated source paths.");
        const args = output.args as Record<string, unknown>;
        // A re-used prompt may already carry a block from an earlier dispatch; drop it so
        // exactly one block, holding this approval's validated paths, reaches the agent.
        const prompt = String(args.prompt ?? "").replace(PATHS_BLOCK_RE, "").trimEnd();
        args.prompt = `${prompt}\n\nPROTECTED_FILE_PATHS (${paths.length}):\n${paths.map((path) => `- ${path}`).join("\n")}`;
        return;
      }

      // Step 5: No approval token — log a warning and block the dispatch by
      //         throwing an error the AI model can read and act on.
      await client.app.log({
        body: {
          service: "protected-pipeline-confirm-guard",
          level: "warn",
          message: `Blocking task→${PROTECTED_PIPELINE_AGENT} — no confirmation for session ${input.sessionID}`,
        },
      });

      // This error is intentionally model-visible: the AI will read the
      // message and know exactly what to do next (call confirm_file_protection).
      throw new Error(
        "DENIED by protected-pipeline-confirm-guard: you must call " +
          "confirm_file_protection and receive APPROVED before dispatching " +
          "to protected-file-agent. Call confirm_file_protection now with " +
          "the original user request. If it returns ACTION_DENIED, do NOT dispatch — " +
          "continue with remaining tasks that do not depend on the pipeline.",
      );
    },
  };
};

// opencode loads every export of this module as a plugin, so a bare helper export is invoked
// as a plugin factory and fails the whole file. The helpers ride on the plugin function
// instead; unit tests read them off the default export.
export default Object.assign(ProtectedPipelineConfirmGuard, { approvedSessions });
