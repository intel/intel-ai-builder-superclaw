import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createLoggerStub() {
  const base = {
    child() {
      return base;
    },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return base;
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function createAsyncEventStream() {
  const events = [];
  const waiters = [];
  let closed = false;

  return {
    push(event) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: event, done: false });
      } else {
        events.push(event);
      }
    },
    close() {
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()({ value: undefined, done: true });
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (events.length > 0) {
              return Promise.resolve({ value: events.shift(), done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    },
  };
}

export function createBaseConfig(dir, options = {}) {
  return {
    configPath: path.join(dir, "opencode-router.json"),
    configFile: { version: 1 },
    opencodeUrl: "http://127.0.0.1:4096",
    opencodeDirectory: dir,
    telegramBots: [],
    slackApps: [],
    dataDir: dir,
    dbPath: path.join(dir, "opencode-router.db"),
    logFile: path.join(dir, "opencode-router.log"),
    toolUpdatesEnabled: true,
    groupsEnabled: false,
    permissionMode: "allow",
    toolOutputLimit: 1200,
    healthPort: undefined,
    logLevel: "silent",
    ...options,
  };
}

export function createTextResult(index, counter) {
  return {
    index,
    type: "text",
    sent: true,
    providerMessageId: `${counter}.000000`,
    providerChannelId: "D123",
  };
}

export function createSlackAdapter(options = {}) {
  const posts = [];
  const updates = [];
  const statuses = [];
  let counter = 1000;
  let seq = 0;

  return {
    posts,
    updates,
    statuses,
    adapter: {
      key: "slack:default",
      name: "slack",
      identityId: "default",
      maxTextLength: 39_000,
      async start() {},
      async stop() {},
      async sendText(peerId, text) {
        counter += 1;
        posts.push({ peerId, text, via: "sendText", ts: `${counter}.000000` });
      },
      async sendMessage(peerId, message) {
        const partResults = [];
        for (let index = 0; index < message.parts.length; index += 1) {
          const part = message.parts[index];
          counter += 1;
          posts.push({ peerId, text: part.text, part, message, via: "sendMessage", ts: `${counter}.000000` });
          partResults.push(createTextResult(index, counter));
        }
        return { attemptedParts: message.parts.length, sentParts: message.parts.length, partResults };
      },
      async updateMessage(peerId, ts, message) {
        updates.push({ peerId, ts, message });
        if (options.throwOnUpdate?.(updates.length, message)) {
          throw new Error("chat.update failed");
        }
        return { ts };
      },
      async setStatus(peerId, threadTs, status) {
        seq += 1;
        const callSeq = seq;
        statuses.push({ peerId, threadTs, status, seq: callSeq });
        return options.setStatusResult
          ? options.setStatusResult(statuses.length, status)
          : { ok: true };
      },
      async clearStatus(peerId, threadTs) {
        seq += 1;
        const callSeq = seq;
        const result = options.clearStatusResult
          ? options.clearStatusResult(statuses.filter((s) => s.cleared).length + 1)
          : { ok: true };
        statuses.push({ peerId, threadTs, status: "", cleared: true, ok: result.ok !== false, seq: callSeq });
        return result;
      },
    },
  };
}

export function createTextOnlyAdapter(name = "telegram") {
  const posts = [];
  return {
    posts,
    adapter: {
      key: `${name}:default`,
      name,
      identityId: "default",
      maxTextLength: 39_000,
      async start() {},
      async stop() {},
      async sendText(peerId, text) {
        posts.push({ peerId, text });
      },
    },
  };
}

export function toolEvent(sessionID, callID, title = "running") {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        sessionID,
        callID,
        tool: "bash",
        state: { status: "running", title },
      },
    },
  };
}

export function customToolEvent(sessionID, callID, { tool = "bash", status = "running", title = "running" } = {}) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        sessionID,
        callID,
        tool,
        state: { status, title },
      },
    },
  };
}

// Resolves once `predicate` holds. It has no deadline of its own: a slow or busy machine must
// not fail a condition that would have held a moment later. A condition that never holds is
// bounded by the test's own timeout.
export async function waitFor(predicate) {
  while (!predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

export const CHANNEL_PEER = "C123|1700000000.000100";
export const DM_PEER = "D123|1700000000.000100";
export const DM_PEER_2 = "D456|1700000000.000200";
