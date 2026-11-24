/**
 * shell_proxy_credential - tells the egress proxy which chat a shell command belongs to (EG2-4b).
 *
 * With the egress proxy in enforce mode, a destination its allowlist does not list is held for the user's
 * approval, and the approval dialog can allow it for "this chat". The proxy has to know the chat, and it
 * cannot take the agent's word: so for each command this plugin puts a proxy credential in the command's
 * HTTPS_PROXY (and HTTP_PROXY when the runtime has one): `http://<user>:<pass>@127.0.0.1:<shell port>`.
 *
 *   user = sc1.<d|c>.<ROOT session id>   d: a desktop chat, c: owned by Slack or Telegram
 *   pass = base64url(HMAC-SHA256(session_key, "superclaw-egress-proxy-session-v1\n" + user))
 *   session_key = HMAC-SHA256(Connector caller key, "superclaw-egress-proxy-session-key-v1")
 *
 * The root session is the top of the parent chain: a sub-agent's commands are its root's chat, the way
 * 06_superclaw_channel_session_marker.ts decides channel ownership. The rules and a test vector are
 * shared/contracts/src/egress-proxy-approval.ts, restated here because a deployed Profile carries no package.
 * Only the plugin function is exported: OpenCode calls every export of a plugin file as a plugin.
 *
 * Why a command cannot forge another chat's credential: the key is never in a command's environment.
 * OpenCode builds that environment as process.env overlaid with what this hook returns, and the key is not in
 * process.env at all: it is read through the DPAPI reader the Connector tools use and kept in this plugin's
 * memory, and the hook returns only the proxy variables. A command holds its own chat's credential and nothing
 * that mints another's. The proxy verifies the MAC: a credential that does not verify is an unknown chat,
 * which can be approved once and gets no chat-scoped grant. A command that can run the DPAPI reader can read
 * the Connector client key as well; that is the boundary the Connector's own session claims already have.
 *
 * It does nothing unless the proxy says it asks for approvals (`GET /v1/approvals/state`), which it does in
 * enforce mode only, so the shipped (log_only) proxy sees no change in any command's environment. Any failure
 * leaves the command's environment as it was: no credential means an unknown chat, never a wider one.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";

import { readConnectorConfig } from "../tools/_connector_client";

const KEY_LABEL = "superclaw-egress-proxy-session-key-v1";
const MAC_LABEL = "superclaw-egress-proxy-session-v1\n";
const STATE_PATH = "/v1/approvals/state";
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CHANNEL_TITLE = /^(Slack|Telegram)\//;
const MAX_PARENT_DEPTH = 8;
const STATE_TIMEOUT_MS = 2_000;
// A proxy that could not be asked is asked again after this long, not on every command.
const STATE_RETRY_MS = 30_000;
const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy"] as const;
const OPTIONAL_PROXY_VARIABLES = ["HTTP_PROXY", "http_proxy"] as const;

type Root = { id: string; channel: boolean };

function sessionKeyFor(callerKeyBase64: string): Buffer {
  return createHmac("sha256", Buffer.from(callerKeyBase64, "base64")).update(KEY_LABEL, "utf8").digest();
}

function credentialFor(sessionKey: Buffer, channel: boolean, rootSessionId: string): { user: string; pass: string } {
  if (!SESSION_ID.test(rootSessionId)) throw new Error("not a session id the proxy credential can carry");
  const user = `sc1.${channel ? "c" : "d"}.${rootSessionId}`;
  const pass = createHmac("sha256", sessionKey).update(MAC_LABEL + user, "utf8").digest("base64url");
  return { user, pass };
}

/** The shell listener's port, read from the proxy the runtime was given; anything but loopback http is none. */
function shellProxyPort(env: Record<string, string | undefined>): number | undefined {
  const value = env.HTTPS_PROXY ?? env.https_proxy;
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || !url.port) return undefined;
    return Number(url.port);
  } catch {
    return undefined;
  }
}

function proxyAsksForApprovals(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // egress-surface: profile_plugin_shell_proxy_state
    const request = httpRequest({ host: "127.0.0.1", port, path: STATE_PATH, method: "GET", agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        if (chunks.length < 8) chunks.push(Buffer.from(chunk));
      });
      response.on("error", () => done(false));
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { approvals?: unknown };
          done(response.statusCode === 200 && body.approvals === true);
        } catch {
          done(false);
        }
      });
    });
    request.setTimeout(STATE_TIMEOUT_MS, () => request.destroy());
    request.on("error", () => done(false));
    request.end();
  });
}

export const ShellProxyCredential: Plugin = async ({ client }) => {
  let asks: { value: boolean; until: number } | undefined;
  let key: Buffer | undefined;
  // Only answers that came back from the server: a failed lookup is asked again, never remembered.
  const roots = new Map<string, Root>();

  async function approvalsAreAsked(port: number): Promise<boolean> {
    if (asks && asks.until > Date.now()) return asks.value;
    const value = await proxyAsksForApprovals(port);
    // An answer is the proxy's for as long as it runs; a failure is retried soon.
    asks = { value, until: value ? Number.POSITIVE_INFINITY : Date.now() + STATE_RETRY_MS };
    return value;
  }

  async function sessionKey(): Promise<Buffer | undefined> {
    if (key) return key;
    const configPath = process.env.SUPERCLAW_CONNECTOR_CONFIG?.trim();
    if (!configPath) return undefined;
    key = sessionKeyFor((await readConnectorConfig(configPath)).caller_key_b64);
    return key;
  }

  async function rootOf(sessionID: string): Promise<Root | undefined> {
    const known = roots.get(sessionID);
    if (known) return known;
    const visited: string[] = [];
    let id: string | undefined = sessionID;
    let found: Root | undefined;
    for (let depth = 0; id !== undefined && depth < MAX_PARENT_DEPTH; depth += 1) {
      const cached = roots.get(id);
      if (cached) {
        found = cached;
        break;
      }
      const session = (await client.session.get({ path: { id } })).data;
      if (!session) return undefined;
      visited.push(id);
      if (!session.parentID) {
        // Only the root's title counts: a desktop sub-agent may be titled anything.
        found = { id, channel: CHANNEL_TITLE.test(session.title) };
        break;
      }
      id = session.parentID;
    }
    if (!found) return undefined;
    for (const seen of visited) roots.set(seen, found);
    return found;
  }

  return {
    "shell.env": async (input, output) => {
      try {
        const port = shellProxyPort(process.env);
        if (port === undefined || !input.sessionID || !(await approvalsAreAsked(port))) return;
        const sessionKeyBytes = await sessionKey();
        const root = await rootOf(input.sessionID);
        if (!sessionKeyBytes || !root) return;
        const { user, pass } = credentialFor(sessionKeyBytes, root.channel, root.id);
        const proxy = `http://${user}:${pass}@127.0.0.1:${port}`;
        for (const name of PROXY_VARIABLES) output.env[name] = proxy;
        // The runtime exports these only when the broker gave it them; one it did not set stays unset.
        for (const name of OPTIONAL_PROXY_VARIABLES) if (process.env[name]) output.env[name] = proxy;
      } catch {
        // No credential: the command is an unknown chat, which is asked once and never granted more.
      }
    },
  };
};

export default ShellProxyCredential;
