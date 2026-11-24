// Creating an OpenCode session for a chat, and changing an existing session's
// permission mode in place.
//
// Both operations have to keep three things in step - the OpenCode session, the
// in-memory permission map, and the persisted binding - so they live together.

import type { Logger } from "pino";

import type { ChannelName, Config } from "./config.js";
import type { BridgeStore } from "./db.js";
import { buildPermissionRules, channelDenyRules } from "./opencode.js";

type PermissionRules = NonNullable<ReturnType<typeof buildPermissionRules>>;

/** The slice of an OpenCode client session management uses. */
export type SessionClient = {
  session: {
    create: (input: { title: string; permission?: PermissionRules }) => Promise<unknown>;
    update: (input: { sessionID: string; permission: PermissionRules }) => Promise<unknown>;
  };
};

export type SessionLifecycleDeps = {
  getClient: (directory: string) => SessionClient;
  store: BridgeStore;
  logger: Logger;
  routerManagedSessions: Set<string>;
  sessionsWithoutWildcardAllow: Set<string>;
  sessionPermissionModes: Map<string, Config["permissionMode"]>;
  sendText: (
    channel: ChannelName,
    identityId: string,
    peerId: string,
    text: string,
    options: { kind: "system" },
  ) => Promise<void>;
  formatPeer: (channel: ChannelName, peerId: string) => string;
  channelLabels: Record<ChannelName, string>;
  reportStatus?: (text: string) => void;
  defaultPermissionMode: Config["permissionMode"];
};

export type CreateSessionInput = {
  channel: ChannelName;
  identityId: string;
  peerId: string;
  peerKey: string;
  directory: string;
  announce?: boolean;
  permissionMode?: Config["permissionMode"];
};

export const createSessionLifecycle = (deps: SessionLifecycleDeps) => {
  // Sessions whose ruleset is known to end with the channel denies in this process.
  const channelDeniesApplied = new Set<string>();

  const createSession = async (input: CreateSessionInput): Promise<string> => {
    const channelCapitalized = input.channel.charAt(0).toUpperCase() + input.channel.slice(1);
    // Load-bearing beyond cosmetics: opencode only auto-generates a session
    // title while the title is still its own `New session - <ISO>` default, and
    // that generation is an extra same-session LLM call on `small_model`
    // (`llmrouter/auto`) forked outside the request's lifetime. Giving every
    // session an explicit title suppresses it, which is why the reply's `Model:`
    // footer cannot be mislabelled by a title call — see `./lrm-usage.ts`.
    // Reverting to a default-shaped title would silently break that.
    const title = `${channelCapitalized}/${input.identityId} ${input.peerId}`;
    const permissionMode = input.permissionMode ?? deps.defaultPermissionMode;
    const permission = buildPermissionRules(permissionMode);
    const session = await deps.getClient(input.directory).session.create({ title, permission });
    const sessionID = (session as { id?: string }).id;
    if (!sessionID) throw new Error("Failed to create session");
    deps.routerManagedSessions.add(sessionID);
    if (permissionMode !== "allow") deps.sessionsWithoutWildcardAllow.add(sessionID);
    channelDeniesApplied.add(sessionID);
    deps.sessionPermissionModes.set(sessionID, permissionMode);
    deps.store.upsertSession(
      input.channel,
      input.identityId,
      input.peerKey,
      sessionID,
      input.directory,
      permissionMode,
    );
    deps.logger.info(
      {
        sessionID,
        channel: input.channel,
        identityId: input.identityId,
        peerId: input.peerKey,
        directory: input.directory,
        permissionMode,
      },
      "session created",
    );
    deps.reportStatus?.(
      `${deps.channelLabels[input.channel]}/${input.identityId} session created for ${deps.formatPeer(input.channel, input.peerId)} (ID: ${sessionID}).`,
    );
    if (input.announce !== false) {
      await deps.sendText(input.channel, input.identityId, input.peerId, "🧭 Session started.", { kind: "system" });
    }
    return sessionID;
  };

  // Switch an EXISTING session's permission mode in place (no recreate), so the
  // conversation history is preserved.
  //
  // CAVEAT, measured 2026-08-09: opencode's PATCH only ever APPENDS to
  // `session.permission`. Neither `[]` nor `null` clears it. Downgrading
  // allow -> inherit therefore leaves the earlier blanket `*:*:allow` in place and
  // the downgrade does not take effect; only allow <-> deny works, because the
  // appended rule is last-match-wins. Clearing a ruleset requires a new session.
  const switchSessionPermissionMode = async (
    directory: string,
    sessionID: string,
    permissionMode: Config["permissionMode"],
    persist: { channel: ChannelName; identityId: string; peerKey: string },
  ): Promise<void> => {
    const permission = buildPermissionRules(permissionMode);
    await deps.getClient(directory).session.update({ sessionID, permission });
    // Every mode's ruleset now ends with (or subsumes) the web-tool denies.
    channelDeniesApplied.add(sessionID);
    deps.sessionPermissionModes.set(sessionID, permissionMode);
    deps.store.upsertSession(
      persist.channel,
      persist.identityId,
      persist.peerKey,
      sessionID,
      directory,
      permissionMode,
    );
    deps.logger.info({ sessionID, directory, permissionMode }, "session permission mode switched in place");
  };

  // A persisted session may predate the channel denies (or keep a blanket allow
  // after an inherit switch, see the caveat above). Appending the denies is safe in
  // every mode because the last matching rule wins. Throws if the update fails, so
  // the caller does not run a turn on an unpatched ruleset.
  const ensureChannelDenies = async (directory: string, sessionID: string): Promise<void> => {
    if (channelDeniesApplied.has(sessionID)) return;
    await deps.getClient(directory).session.update({ sessionID, permission: channelDenyRules() });
    channelDeniesApplied.add(sessionID);
    deps.logger.info({ sessionID, directory }, "channel tool denies re-applied to reused session");
  };

  return { createSession, switchSessionPermissionMode, ensureChannelDenies };
};
