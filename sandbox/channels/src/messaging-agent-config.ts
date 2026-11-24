// The workspace messaging-agent file: a `.opencode/agents/superclaw-router.md`
// that lets a workspace pin which agent answers channel messages and prepend its
// own instructions to the prompt.
//
// Extracted from `startBridge` following the precedent in intent-gate.ts, so the
// `@agent` header parse and the mtime cache can be unit-tested without standing
// up the full bridge.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "pino";

const OPENCODE_ROUTER_AGENT_FILE_RELATIVE_PATH = ".opencode/agents/superclaw-router.md";
const OPENCODE_ROUTER_AGENT_MAX_CHARS = 16_000;

export const DEFAULT_MESSAGING_AGENT_INSTRUCTIONS = [
  "Respond for non-technical users first.",
  "Do not tell users to run router commands; use tools on their behalf.",
  "Never expose raw peer IDs or Telegram chat IDs unless the user explicitly asks for debug details.",
  "Do not ask end users for peer IDs or identity IDs.",
  "For Telegram send requests, try delivery immediately using existing bindings or direct tool calls.",
  "If Telegram returns 'chat not found', explain that the recipient must message the bot first (for example with /start), then ask the user to retry.",
  "Keep status updates concise and action-oriented.",
].join("\n");

export type MessagingAgentConfig = {
  filePath: string;
  loaded: boolean;
  selectedAgent?: string;
  instructions: string;
};

/**
 * Splits an optional leading `@agent <name>` header off the instruction body.
 * Leading blank lines are skipped first, so the header is still recognized in a
 * file that starts with whitespace.
 */
export const parseMessagingAgentFile = (content: string): { selectedAgent?: string; instructions: string } => {
  const lines = content.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && !lines[start]?.trim()) {
    start += 1;
  }

  let selectedAgent: string | undefined;
  if (start < lines.length) {
    const first = lines[start]?.trim() ?? "";
    const match = first.match(/^@agent\s+([A-Za-z0-9_.:/-]+)$/);
    if (match?.[1]) {
      selectedAgent = match[1];
      lines.splice(start, 1);
    }
  }

  const instructions = lines.join("\n").trim();
  return { ...(selectedAgent ? { selectedAgent } : {}), instructions };
};

/**
 * The workspace-agent block of the health snapshot. It lives beside the loader
 * so the health report and the loader cannot drift on what `loaded` means.
 */
export const toHealthAgentSnapshot = (
  config: MessagingAgentConfig,
): { scope: "workspace"; path: string; loaded: boolean; selected?: string } => ({
  scope: "workspace",
  path: config.filePath,
  loaded: config.loaded,
  ...(config.selectedAgent ? { selected: config.selectedAgent } : {}),
});

export type MessagingAgentConfigLoader = {
  /** Reads the agent file, honouring the mtime cache. */
  load(): Promise<MessagingAgentConfig>;
  /** The most recent result, for health reporting without a re-read. */
  latest(): MessagingAgentConfig;
};

export const createMessagingAgentConfigLoader = (deps: {
  workspaceRoot: string;
  /** The agent file the host provides (OPENCODE_ROUTER_AGENT_FILE). Replaces the workspace's own file when set. */
  agentFile?: string;
  logger: Logger;
}): MessagingAgentConfigLoader => {
  const filePath = deps.agentFile ?? join(deps.workspaceRoot, OPENCODE_ROUTER_AGENT_FILE_RELATIVE_PATH);
  const cache = new Map<string, { mtimeMs: number; config: MessagingAgentConfig }>();
  let latest: MessagingAgentConfig = { filePath, loaded: false, instructions: "" };

  // Every failure path resolves to an unloaded config rather than throwing: a
  // missing or unreadable agent file must not stop a message from being answered.
  const load = async (): Promise<MessagingAgentConfig> => {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        cache.delete(filePath);
        latest = { filePath, loaded: false, instructions: "" };
        return latest;
      }

      const cached = cache.get(filePath);
      if (cached && cached.mtimeMs === info.mtimeMs) {
        latest = cached.config;
        return latest;
      }

      const raw = (await readFile(filePath, "utf8")).trim();
      if (!raw) {
        const next: MessagingAgentConfig = { filePath, loaded: false, instructions: "" };
        cache.set(filePath, { mtimeMs: info.mtimeMs, config: next });
        latest = next;
        return next;
      }

      const truncated = raw.length > OPENCODE_ROUTER_AGENT_MAX_CHARS ? raw.slice(0, OPENCODE_ROUTER_AGENT_MAX_CHARS) : raw;
      const parsed = parseMessagingAgentFile(truncated);
      const next: MessagingAgentConfig = {
        filePath,
        loaded: Boolean(parsed.instructions || parsed.selectedAgent),
        ...(parsed.selectedAgent ? { selectedAgent: parsed.selectedAgent } : {}),
        instructions: parsed.instructions,
      };
      cache.set(filePath, { mtimeMs: info.mtimeMs, config: next });
      latest = next;
      return next;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        cache.delete(filePath);
        latest = { filePath, loaded: false, instructions: "" };
        return latest;
      }
      deps.logger.warn({ error, filePath }, "failed to load opencode-router agent file");
      latest = { filePath, loaded: false, instructions: "" };
      return latest;
    }
  };

  return { load, latest: () => latest };
};
