// The slash-command surface: /opus, /codex, /model, /reset, /pair, /dir, /cd,
// /agent, /help.
//
// An unknown command deliberately returns false rather than erroring, so text
// that merely starts with "/" still reaches the agent as an ordinary message.

import type { ChannelName, Config, ModelRef } from "./config.js";
import type { MessagingAgentConfig } from "./messaging-agent-config.js";
import type { BridgeStore } from "./db.js";
import type { Logger } from "pino";
import { MODEL_PRESETS, getUserModel, setUserModel } from "./model-preferences.js";

export type CommandDeps = {
  /** Always sends with kind "system": command replies are bridge output, not agent output. */
  sendText: (
    channel: ChannelName,
    identityId: string,
    peerId: string,
    text: string,
    options: { kind: "system" },
  ) => Promise<void>;
  store: BridgeStore;
  logger: Logger;
  clearThreadGateState: (channel: ChannelName, identityId: string, peerKey: string) => void;
  handleTelegramPairingGate: (input: {
    identityId: string;
    peerKey: string;
    peerId: string;
    text: string;
    bindingDirectory?: string;
    sessionDirectory?: string;
  }) => Promise<"continue" | "handled">;
  resolveScopedDirectory: (input: string) => { ok: true; directory: string } | { ok: false; error: string };
  ensureEventSubscription: (directory: string) => void;
  loadMessagingAgentConfig: () => Promise<MessagingAgentConfig>;
  defaultDirectory: string;
  defaultModel?: Config["model"];
};

const HELP_TEXT = `/opus - Claude Opus 4.5\n/codex - GPT 5.2 Codex\n/pair <code> - pair this chat with a private Telegram bot\n/dir <path> - bind this chat to a workspace directory\n/dir - show current directory\n/cd <path> - alias for /dir\n/agent - show workspace agent scope/path\n/model - show current\n/reset - start fresh\n/help - this`;

/**
 * Returns true when the text was consumed as a command, false when the caller
 * should keep treating it as a normal message.
 */
export const createCommandHandler =
  (deps: CommandDeps) =>
  async (
    channel: ChannelName,
    identityId: string,
    peerKey: string,
    peerId: string,
    text: string,
  ): Promise<boolean> => {
    const reply = (body: string) => deps.sendText(channel, identityId, peerId, body, { kind: "system" });
    const parts = text.slice(1).split(/\s+/);
    const command = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    // Model switching commands
    if (command && MODEL_PRESETS[command]) {
      const model = MODEL_PRESETS[command] as ModelRef;
      setUserModel(channel, identityId, peerKey, model);
      await reply(`Model switched to ${model.providerID}/${model.modelID}`);
      deps.logger.info({ channel, peerId: peerKey, model }, "model switched via command");
      return true;
    }

    // /model command - show current model
    if (command === "model") {
      const current = getUserModel(channel, identityId, peerKey, deps.defaultModel);
      const modelStr = current ? `${current.providerID}/${current.modelID}` : "default";
      await reply(`Current model: ${modelStr}`);
      return true;
    }

    // /reset command - clear model override and session
    if (command === "reset") {
      setUserModel(channel, identityId, peerKey, undefined);
      deps.store.deleteSession(channel, identityId, peerKey);
      deps.clearThreadGateState(channel, identityId, peerKey);
      await reply("Session and model reset. Send a message to start fresh.");
      deps.logger.info({ channel, peerId: peerKey }, "session and model reset");
      return true;
    }

    if (command === "pair") {
      if (channel !== "telegram") {
        await reply("Pairing is only available for Telegram private bots.");
        return true;
      }
      const binding = deps.store.getBinding(channel, identityId, peerKey);
      const session = deps.store.getSession(channel, identityId, peerKey);
      const pairingGate = await deps.handleTelegramPairingGate({
        identityId,
        peerKey,
        peerId,
        text,
        ...(binding?.directory?.trim() ? { bindingDirectory: binding.directory } : {}),
        ...(session?.directory?.trim() ? { sessionDirectory: session.directory ?? undefined } : {}),
      });
      if (pairingGate === "handled") return true;
      await reply("This chat is already paired.");
      return true;
    }

    if (command === "dir" || command === "cd") {
      const next = args.join(" ").trim();
      if (!next) {
        const binding = deps.store.getBinding(channel, identityId, peerKey);
        const current =
          binding?.directory?.trim() ||
          deps.store.getSession(channel, identityId, peerKey)?.directory?.trim() ||
          deps.defaultDirectory;
        await reply(`Current directory: ${current || "(none)"}`);
        return true;
      }
      const scoped = deps.resolveScopedDirectory(next);
      if (!scoped.ok) {
        await reply(scoped.error);
        return true;
      }
      const normalized = scoped.directory;
      deps.store.upsertBinding(channel, identityId, peerKey, normalized);
      deps.store.deleteSession(channel, identityId, peerKey);
      deps.clearThreadGateState(channel, identityId, peerKey);
      deps.ensureEventSubscription(normalized);
      await reply(`Directory set to: ${normalized}`);
      return true;
    }

    if (command === "agent") {
      const agentConfig = await deps.loadMessagingAgentConfig();
      await reply(
        [
          `Scope: workspace`,
          `Agent file: ${agentConfig.filePath}`,
          `OpenCode agent: ${agentConfig.selectedAgent ?? "(none)"}`,
          `Status: ${agentConfig.loaded ? "loaded" : "missing or empty"}`,
        ].join("\n"),
      );
      return true;
    }

    // /help command
    if (command === "help") {
      await reply(HELP_TEXT);
      return true;
    }

    // Unknown command - don't handle, let it pass through as a message
    return false;
  };
