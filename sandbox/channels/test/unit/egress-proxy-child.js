// Runs one client in the environment egress-proxy.test.js chose for it, prints the outcome, and
// exits. Not a test file: the test spawns it once per case.
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SocketModeClient } from "@slack/socket-mode";

import { resolveUnderlyingModel } from "../../dist/lrm-usage.js";
import { MediaStore } from "../../dist/media-store.js";
import { createClient } from "../../dist/opencode.js";
import { createSlackAdapter, verifySlackCredentials } from "../../dist/slack.js";
import { createTelegramAdapter } from "../../dist/telegram.js";

const CASE_BOUND_MS = 3_000;
const logger = { child: () => logger, debug() {}, info() {}, warn() {}, error() {} };
const slackIdentity = { id: "default", botToken: "xoxb-proxy-test", appToken: "xapp-proxy-test", enabled: true };

class WebClientStub {
  constructor() {
    this.auth = {
      test: async () => ({ ok: true, user_id: "U0000000001", team_id: "T0000000001", bot_id: "B0000000001" }),
    };
  }
}

/** The agent the Slack adapter hands to Socket Mode, which passes it on to its WebSocket. */
function socketModeAgent() {
  let agent;
  class SocketModeClientSpy {
    constructor(options) {
      agent = options.clientOptions?.agent;
    }
    on() {}
  }
  createSlackAdapter(slackIdentity, { groupsEnabled: false }, logger, async () => {}, {
    WebClient: WebClientStub,
    SocketModeClient: SocketModeClientSpy,
  });
  return agent;
}

const cases = {
  telegram: () =>
    createTelegramAdapter(
      { id: "default", token: "123456:proxy-test", enabled: true },
      { groupsEnabled: false },
      logger,
      async () => {},
    ).sendText("42", "proxy test"),
  "slack-web-api": () =>
    verifySlackCredentials(slackIdentity.botToken, slackIdentity.appToken, undefined, { timeoutMs: CASE_BOUND_MS }),
  "slack-socket-mode": () =>
    createSlackAdapter(slackIdentity, { groupsEnabled: false }, logger, async () => {}, {
      WebClient: WebClientStub,
      SocketModeClient,
    }).start(),
  "slack-websocket": () =>
    new Promise((resolve) => {
      const socketModeRequire = createRequire(createRequire(import.meta.url).resolve("@slack/socket-mode"));
      const { WebSocket } = socketModeRequire("ws");
      const socket = new WebSocket("wss://wss-primary.slack.com/link/?ticket=proxy-test", { agent: socketModeAgent() });
      socket.on("error", resolve);
      socket.on("close", resolve);
    }),
  "media-download": () =>
    new MediaStore(mkdtempSync(join(tmpdir(), "egress-proxy-media-"))).downloadInbound({
      channel: "slack",
      identityId: "default",
      peerId: "C0000000001",
      kind: "document",
      url: "https://files.slack.com/files-pri/T0000000001-F0000000001/report.pdf",
      headers: { Authorization: `Bearer ${slackIdentity.botToken}` },
    }),
  opencode: () => createClient({ opencodeUrl: process.env.LOOPBACK_URL, opencodeDirectory: "/workspace" }).session.list(),
  "lrm-usage": () => resolveUnderlyingModel("ses_proxy_test", 0),
};

const run = cases[process.argv[2]];
if (!run) {
  console.error(`unknown case: ${process.argv[2]}`);
  process.exit(2);
}
const outcome = await Promise.race([
  Promise.resolve()
    .then(run)
    .then(
      (value) => ({ ok: true, value: value ?? null }),
      (error) => ({ ok: false, error: String(error?.message ?? error) }),
    ),
  Bun.sleep(CASE_BOUND_MS).then(() => ({ ok: false, error: "bounded" })),
]);
console.log(JSON.stringify(outcome));
process.exit(0);
