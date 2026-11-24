import assert from "node:assert/strict";
import { test } from "bun:test";

import { createEventSubscriber, extractModelRef } from "../../dist/event-stream.js";

// The permission branches here are the only place the bridge answers an approval
// prompt, and a wrong answer either hangs the run forever or silently runs a tool
// the user never approved. The tool-status branches encode the Slack shimmer
// rules that caused the burst-spam bug.

function makeRun(overrides = {}) {
  return {
    key: "/w::s1",
    directory: "/w",
    sessionID: "s1",
    channel: "slack",
    identityId: "i1",
    adapterKey: "slack:i1",
    peerId: "C1|168.1",
    peerKey: "C1",
    toolUpdatesEnabled: true,
    seenToolStates: new Map(),
    ...overrides,
  };
}

// Drives the subscriber over a fixed list of events and resolves once the stream
// has been fully consumed, so assertions never race the async iteration.
function makeSubscriber(events, overrides = {}) {
  const calls = { status: [], sent: [], responded: [], thinking: [], done: [], typingOn: [], typingOff: [] };
  let doneResolve;
  const drained = new Promise((resolve) => {
    doneResolve = resolve;
  });
  const keyForSession = (directory, sessionID) => `${directory}::${sessionID}`;
  const activeRuns = overrides.activeRuns ?? new Map([["/w::s1", makeRun()]]);
  const deps = {
    defaultDirectory: "/w",
    eventSubscriptions: new Map(),
    getClient: () => ({
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            try {
              for (const event of events) yield event;
              // Let the consumer's trailing awaits settle before we assert.
              await new Promise((r) => setTimeout(r, 0));
            } finally {
              // Settle in `finally` so a subscriber that throws mid-iteration
              // fails the assertion instead of hanging the run forever.
              doneResolve();
            }
          })(),
        }),
      },
      permission: {
        respond: async (input) => {
          calls.responded.push(input);
        },
      },
    }),
    status: {
      emitStatus: async (_run, text) => {
        calls.status.push(text);
        return overrides.emitStatusResult ?? true;
      },
      reportThinking: (run) => calls.thinking.push(run.sessionID),
      reportDone: (run) => calls.done.push(run.sessionID),
      startTyping: (run) => calls.typingOn.push(run.sessionID),
      stopTyping: (key) => calls.typingOff.push(key),
    },
    activeRuns,
    sessionModels: overrides.sessionModels ?? new Map(),
    keyForSession,
    sendText: async (_channel, _identityId, _peerId, text, options) => {
      calls.sent.push({ text, kind: options.kind });
    },
    routerManagedSessions: overrides.routerManagedSessions ?? new Set(["s1"]),
    sessionPermissionModes: overrides.sessionPermissionModes ?? new Map(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    toolOutputLimit: 200,
    permissionMode: overrides.permissionMode ?? "allow",
    ...(overrides.disableEventStream !== undefined ? { disableEventStream: overrides.disableEventStream } : {}),
  };
  const subscribe = createEventSubscriber(deps);
  return { subscribe, deps, calls, drained, activeRuns };
}

// ------------------------------------------------------------ extractModelRef

test("extractModelRef only accepts a complete model on a user message", () => {
  assert.deepEqual(extractModelRef({ role: "user", model: { providerID: "anthropic", modelID: "opus" } }), {
    providerID: "anthropic",
    modelID: "opus",
  });
  assert.equal(extractModelRef({ role: "assistant", model: { providerID: "a", modelID: "b" } }), null);
  assert.equal(extractModelRef({ role: "user", model: { providerID: "a" } }), null);
  assert.equal(extractModelRef({ role: "user" }), null);
  assert.equal(extractModelRef(null), null);
  assert.equal(extractModelRef("nope"), null);
});

// -------------------------------------------------------------- subscription

test("subscribing is a no-op when the event stream is disabled", async () => {
  const { subscribe, deps } = makeSubscriber([], { disableEventStream: true });
  subscribe("/w");
  assert.equal(deps.eventSubscriptions.size, 0);
});

test("a directory is only subscribed once", async () => {
  const { subscribe, deps } = makeSubscriber([]);
  subscribe("/w");
  subscribe("/w");
  assert.equal(deps.eventSubscriptions.size, 1);
});

// ------------------------------------------------------- subscription lifetime

// Each subscribe call takes the next stream factory, so a test can script what
// the first and any later subscription to the same directory do.
function makeLifecycleSubscriber(streamFactories) {
  const signals = [];
  const errors = [];
  const deps = {
    defaultDirectory: "/w",
    eventSubscriptions: new Map(),
    getClient: () => ({
      event: {
        subscribe: async (_query, { signal }) => {
          signals.push(signal);
          const factory = streamFactories[signals.length - 1];
          return { stream: factory(signal) };
        },
      },
      permission: { respond: async () => {} },
    }),
    status: {
      emitStatus: async () => true,
      reportThinking() {},
      reportDone() {},
      startTyping() {},
      stopTyping() {},
    },
    activeRuns: new Map(),
    sessionModels: new Map(),
    keyForSession: (directory, sessionID) => `${directory}::${sessionID}`,
    sendText: async () => {},
    routerManagedSessions: new Set(),
    sessionPermissionModes: new Map(),
    logger: { info() {}, warn() {}, debug() {}, error: (fields, message) => errors.push({ fields, message }) },
    toolOutputLimit: 200,
    permissionMode: "allow",
  };
  return { subscribe: createEventSubscriber(deps), deps, signals, errors };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const failingStream = () =>
  (async function* () {
    throw new Error("connection reset");
  })();

const endingStream = () => (async function* () {})();

// Never yields; ends only when the subscription's signal is aborted.
const openStream = (signal) =>
  (async function* () {
    await new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  })();

test("a stream that fails releases the directory so it can be subscribed again", async () => {
  const h = makeLifecycleSubscriber([failingStream, openStream]);
  h.subscribe("/w");
  await settle();
  assert.equal(h.deps.eventSubscriptions.has("/w"), false, "a dead stream must not keep blocking resubscription");
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].message, "event stream closed");
  assert.equal(h.errors[0].fields.directory, "/w");

  h.subscribe("/w");
  await settle();
  assert.equal(h.signals.length, 2, "the second call must actually subscribe");
  assert.equal(h.deps.eventSubscriptions.has("/w"), true);
  h.deps.eventSubscriptions.get("/w").abort();
});

test("a stream that ends normally releases the directory too", async () => {
  const h = makeLifecycleSubscriber([endingStream, openStream]);
  h.subscribe("/w");
  await settle();
  assert.equal(h.deps.eventSubscriptions.has("/w"), false);

  h.subscribe("/w");
  await settle();
  assert.equal(h.signals.length, 2);
  h.deps.eventSubscriptions.get("/w").abort();
});

test("an aborted subscription is released without logging an error", async () => {
  const h = makeLifecycleSubscriber([openStream]);
  h.subscribe("/w");
  await settle();
  h.deps.eventSubscriptions.get("/w").abort();
  await settle();
  assert.equal(h.deps.eventSubscriptions.has("/w"), false);
  assert.deepEqual(h.errors, [], "an intentional abort is not a stream failure");
});

test("a failed stream aborts its controller so the connection is released", async () => {
  const h = makeLifecycleSubscriber([failingStream]);
  h.subscribe("/w");
  await settle();
  assert.equal(h.signals[0].aborted, true);
});

test("a blank directory falls back to the default", async () => {
  const { subscribe, deps } = makeSubscriber([]);
  subscribe("   ");
  assert.deepEqual([...deps.eventSubscriptions.keys()], ["/w"]);
});

test("nothing is subscribed when there is no directory and no default", async () => {
  const { subscribe, deps } = makeSubscriber([]);
  deps.defaultDirectory = "";
  subscribe("");
  assert.equal(deps.eventSubscriptions.size, 0);
});

// ------------------------------------------------------------- model updates

test("message.updated records the session model and re-reports thinking", async () => {
  const h = makeSubscriber([
    {
      type: "message.updated",
      properties: { info: { sessionID: "s1", role: "user", model: { providerID: "anthropic", modelID: "opus" } } },
    },
  ]);
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.deps.sessionModels.get("/w::s1"), { providerID: "anthropic", modelID: "opus" });
  assert.deepEqual(h.calls.thinking, ["s1"]);
});

test("message.updated for an unknown session records the model but reports nothing", async () => {
  const h = makeSubscriber(
    [
      {
        type: "message.updated",
        properties: { info: { sessionID: "s9", role: "user", model: { providerID: "a", modelID: "b" } } },
      },
    ],
    { activeRuns: new Map() },
  );
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.deps.sessionModels.has("/w::s9"), true);
  assert.deepEqual(h.calls.thinking, []);
});

// ------------------------------------------------------------ session status

test("a busy session starts typing and shows the working status", async () => {
  const h = makeSubscriber([{ type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } }]);
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.calls.typingOn, ["s1"]);
  assert.equal(h.calls.status[0], "🤔 Working on it…");
});

test("a retrying session says so rather than looking stuck", async () => {
  const h = makeSubscriber([{ type: "session.status", properties: { sessionID: "s1", status: { type: "retry" } } }]);
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.status[0], "🤔 Still working… retrying.");
});

test("other session statuses are ignored", async () => {
  const h = makeSubscriber([{ type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } }]);
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.calls.status, []);
  assert.deepEqual(h.calls.typingOn, []);
});

test("session.idle stops typing and reports done", async () => {
  const h = makeSubscriber([{ type: "session.idle", properties: { sessionID: "s1" } }]);
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.calls.typingOff, ["/w::s1"]);
  assert.deepEqual(h.calls.done, ["s1"]);
});

test("session.idle stops typing even with no active run", async () => {
  const h = makeSubscriber([{ type: "session.idle", properties: { sessionID: "s1" } }], { activeRuns: new Map() });
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.calls.typingOff, ["/w::s1"], "the loop must be cleared regardless");
  assert.deepEqual(h.calls.done, []);
});

// -------------------------------------------------------------- tool updates

const toolPart = (overrides = {}) => ({
  type: "message.part.updated",
  properties: {
    part: {
      sessionID: "s1",
      type: "tool",
      tool: "bash",
      callID: "c1",
      state: { status: "running", title: "ls -la" },
      ...overrides,
    },
  },
});

test("a tool part becomes a labelled status line", async () => {
  const h = makeSubscriber([toolPart()]);
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.status[0], "[tool] bash running: ls -la");
});

test("a tool part with no state does not kill the directory's stream", async () => {
  // `state.title` used to throw here, and a throw inside the `for await` takes
  // down event delivery for the whole directory, so the second part is the
  // half that matters: it proves the stream survived the first one.
  const h = makeSubscriber([toolPart({ state: undefined }), toolPart()]);
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.status[0], "[tool] bash unknown: running");
  assert.equal(h.calls.status[1], "[tool] bash running: ls -la");
});

test("an unchanged tool state is not re-emitted", async () => {
  const h = makeSubscriber([toolPart(), toolPart()]);
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.status.length, 1);
});

test("a changed tool state is emitted again", async () => {
  const h = makeSubscriber([toolPart(), toolPart({ state: { status: "completed", title: "ls -la" } })]);
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.status.length, 2);
});

test("the invalid tool sentinel is never surfaced", async () => {
  const h = makeSubscriber([toolPart({ tool: "invalid" })]);
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.calls.status, []);
});

test("a completed tool appends its output, collapsed to one line", async () => {
  const h = makeSubscriber([
    toolPart({ state: { status: "completed", title: "ls", output: "a\nb\nc" } }),
  ]);
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.status[0], "[tool] bash completed: ls a b c");
});

test("the task tool's output is not appended, since the answer already carries it", async () => {
  const h = makeSubscriber([
    toolPart({ tool: "task", state: { status: "completed", title: "research", output: "<task_result>big</task_result>" } }),
  ]);
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.status[0], "[tool] agent completed: research");
});

test("an unmapped tool name is used as its own label", async () => {
  const h = makeSubscriber([toolPart({ tool: "custom_thing" })]);
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.status[0].includes("[tool] custom_thing running"), true);
});

test("a status line is capped so Slack cannot reject it", async () => {
  const h = makeSubscriber([toolPart({ state: { status: "running", title: "x".repeat(600) } })]);
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.status[0].length <= 250, true);
});

test("Slack drops tool progress when no status surface accepted it", async () => {
  // The burst-spam bug: posting a standalone [tool] message per event.
  const h = makeSubscriber([toolPart()], { emitStatusResult: false });
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.calls.sent, [], "Slack must not fall back to messages");
});

test("Telegram keeps the message fallback for tool progress", async () => {
  const h = makeSubscriber([toolPart()], {
    emitStatusResult: false,
    activeRuns: new Map([["/w::s1", makeRun({ channel: "telegram", adapterKey: "telegram:i1", peerId: "123" })]]),
  });
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.sent[0].kind, "tool");
});

test("Slack shows tool progress even when tool updates are globally off", async () => {
  const h = makeSubscriber([toolPart()], {
    activeRuns: new Map([["/w::s1", makeRun({ toolUpdatesEnabled: false })]]),
  });
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.status.length, 1);
});

test("Telegram respects the global tool-updates setting", async () => {
  const h = makeSubscriber([toolPart()], {
    activeRuns: new Map([
      ["/w::s1", makeRun({ channel: "telegram", adapterKey: "telegram:i1", toolUpdatesEnabled: false })],
    ]),
  });
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.calls.status, []);
});

test("a non-tool part is ignored", async () => {
  const h = makeSubscriber([toolPart({ type: "text" })]);
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.calls.status, []);
});

test("a tool part with no callID is ignored, since it cannot be deduped", async () => {
  const h = makeSubscriber([toolPart({ callID: undefined })]);
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.calls.status, []);
});

// ---------------------------------------------------------------- permissions

const askPermission = (overrides = {}) => ({
  type: "permission.asked",
  properties: { id: "p1", sessionID: "s1", permission: "bash", ...overrides },
});

test("a permission for a session the router did not create is left to the UI", async () => {
  const h = makeSubscriber([askPermission()], { routerManagedSessions: new Set() });
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.calls.responded, [], "the desktop dialog owns this one");
});

test("allow mode approves", async () => {
  const h = makeSubscriber([askPermission()], { permissionMode: "allow" });
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.calls.responded, [{ sessionID: "s1", permissionID: "p1", response: "always" }]);
});

test("deny mode rejects and explains", async () => {
  const h = makeSubscriber([askPermission()], { permissionMode: "deny" });
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.responded[0].response, "reject");
  assert.equal(h.calls.sent[0].text.includes("Permission denied"), true);
});

test("inherit mode rejects ask permissions and explains approval is unavailable", async () => {
  const h = makeSubscriber([askPermission()], { permissionMode: "inherit" });
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.responded[0].response, "reject");
  assert.equal(h.calls.sent[0].text.includes("`bash` requires approval"), true);
  assert.equal(h.calls.sent[0].text.includes("request was denied"), true);
  assert.equal(h.calls.sent[0].kind, "system");
});

test("inherit mode names an unreported tool generically", async () => {
  const h = makeSubscriber([askPermission({ permission: undefined })], { permissionMode: "inherit" });
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.sent[0].text.startsWith("A tool requires approval"), true);
});

test("a per-session permission mode overrides the bridge default", async () => {
  const h = makeSubscriber([askPermission()], {
    permissionMode: "allow",
    sessionPermissionModes: new Map([["s1", "deny"]]),
  });
  h.subscribe("/w");
  await h.drained;
  assert.equal(h.calls.responded[0].response, "reject");
});

test("a permission event missing its id is ignored", async () => {
  const h = makeSubscriber([askPermission({ id: undefined })]);
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.calls.responded, []);
});

test("web tools are rejected, not approved, in every mode and on a webfetch/websearch ask", async () => {
  for (const permissionMode of ["allow", "deny", "inherit"]) {
    for (const tool of ["webfetch", "websearch"]) {
      const h = makeSubscriber([askPermission({ permission: tool })], { permissionMode });
      h.subscribe("/w");
      await h.drained;
      assert.deepEqual(h.calls.responded, [{ sessionID: "s1", permissionID: "p1", response: "reject" }], `${permissionMode}/${tool}`);
    }
  }
});

test("web-tool asks on a session the router did not create are still left to the UI", async () => {
  const h = makeSubscriber([askPermission({ permission: "webfetch" })], { routerManagedSessions: new Set() });
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.calls.responded, []);
});

// -------------------------------------------- fetches skipped for want of an approver

const SKIPPED = "ERROR: sc_fetch_url did not read the page - approval_required: this chat cannot ask (NO_INTERACTIVE_APPROVER). Do NOT retry this URL.";

const skippedFetch = (url, overrides = {}) =>
  toolPart({
    tool: "sc_fetch_url",
    callID: `c-${url}`,
    state: { status: "completed", input: { url }, output: SKIPPED, title: "" },
    ...overrides,
  });

const NOTICE = (host) =>
  `Skipped ${host}: reading pages outside the search results needs approval in the SuperClaw desktop app.`;

const systemNotices = (h) => h.calls.sent.filter((entry) => entry.kind === "system");

test("a fetch skipped for want of an approver posts one plain notice naming the host", async () => {
  const h = makeSubscriber([skippedFetch("https://news.example.com/a/b?token=secret#x")]);
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(systemNotices(h), [{ text: NOTICE("news.example.com"), kind: "system" }]);
});

test("the notice is posted once per host per thread, however many pages or calls", async () => {
  const h = makeSubscriber([
    skippedFetch("https://news.example.com/a"),
    skippedFetch("https://news.example.com/b"),
    skippedFetch("https://NEWS.example.com/a", { callID: "again" }),
    skippedFetch("https://other.example.org/"),
  ]);
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(
    systemNotices(h).map((entry) => entry.text),
    [NOTICE("news.example.com"), NOTICE("other.example.org")],
  );
});

test("another thread is told again about the same host", async () => {
  const h = makeSubscriber(
    [
      skippedFetch("https://news.example.com/a"),
      skippedFetch("https://news.example.com/a", { sessionID: "s2" }),
    ],
    {
      activeRuns: new Map([
        ["/w::s1", makeRun()],
        ["/w::s2", makeRun({ sessionID: "s2", key: "/w::s2", peerId: "C1|999.9" })],
      ]),
    },
  );
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(h.calls.sent.map((entry) => entry.text), [NOTICE("news.example.com"), NOTICE("news.example.com")]);
});

test("a Telegram run is told, even with tool updates off", async () => {
  const h = makeSubscriber([skippedFetch("https://news.example.com/a")], {
    activeRuns: new Map([["/w::s1", makeRun({ channel: "telegram", toolUpdatesEnabled: false, peerId: "42" })]]),
  });
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(systemNotices(h), [{ text: NOTICE("news.example.com"), kind: "system" }]);
  assert.deepEqual(h.calls.status, []);
});

test("a sub-agent's skipped fetch is told in its parent session's thread", async () => {
  const h = makeSubscriber([
    { type: "session.created", properties: { info: { id: "child", parentID: "s1" } } },
    skippedFetch("https://news.example.com/a", { sessionID: "child" }),
  ]);
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(systemNotices(h), [{ text: NOTICE("news.example.com"), kind: "system" }]);
});

test("nothing is posted for other fetch results, unfinished calls, or sessions with no run", async () => {
  const h = makeSubscriber([
    skippedFetch("https://a.example.com/", { state: { status: "running", input: { url: "https://a.example.com/" } } }),
    skippedFetch("https://b.example.com/", {
      state: { status: "completed", input: { url: "https://b.example.com/" }, output: "URL: https://b.example.com/\nCONTENT:\nok" },
    }),
    skippedFetch("https://c.example.com/", {
      tool: "bash",
    }),
    skippedFetch("https://d.example.com/", { sessionID: "unrelated" }),
    skippedFetch("not a url"),
  ]);
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(systemNotices(h), []);
});

test("a very long host is cut, and only the host is ever posted", async () => {
  const host = `${"a".repeat(100)}.example.com`;
  const h = makeSubscriber([skippedFetch(`https://${host}/private/path?q=1`)]);
  h.subscribe("/w");
  await h.drained;
  const [notice] = systemNotices(h);
  assert.ok(notice.text.startsWith(`Skipped ${"a".repeat(59)}…:`), notice.text);
  assert.ok(!notice.text.includes("/private") && !notice.text.includes("http"));
});

test("a notice that cannot be sent does not stop the stream", async () => {
  const h = makeSubscriber([skippedFetch("https://news.example.com/a"), skippedFetch("https://x.example.com/")]);
  const original = h.deps.sendText;
  let first = true;
  h.deps.sendText = async (...args) => {
    if (first) {
      first = false;
      throw new Error("slack down");
    }
    return original(...args);
  };
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(systemNotices(h).map((entry) => entry.text), [NOTICE("x.example.com")]);
});

test("a page that merely contains the marker in its text posts no notice", async () => {
  const h = makeSubscriber([
    skippedFetch("https://docs.example.com/", {
      state: {
        status: "completed",
        input: { url: "https://docs.example.com/" },
        output: "URL: https://docs.example.com/\nCONTENT:\nThe Connector answers ERROR ... (NO_INTERACTIVE_APPROVER) when no one can approve.",
      },
    }),
  ]);
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(systemNotices(h), []);
});

test("a notice whose send failed is retried on the next skip of that host", async () => {
  const h = makeSubscriber([skippedFetch("https://news.example.com/a"), skippedFetch("https://news.example.com/b")]);
  const original = h.deps.sendText;
  let first = true;
  h.deps.sendText = async (...args) => {
    if (first) {
      first = false;
      throw new Error("slack down");
    }
    return original(...args);
  };
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(systemNotices(h).map((entry) => entry.text), [NOTICE("news.example.com")]);
});

test("two long hosts sharing the shown prefix are each told", async () => {
  const prefix = "a".repeat(70);
  const h = makeSubscriber([skippedFetch(`https://${prefix}.one.example/`), skippedFetch(`https://${prefix}.two.example/`)]);
  h.subscribe("/w");
  await h.drained;
  assert.equal(systemNotices(h).length, 2);
});

test("a run recovered onto a replacement session still gets its notice", async () => {
  const h = makeSubscriber([skippedFetch("https://news.example.com/a", { sessionID: "s1-new" })], {
    activeRuns: new Map([["/w::s1", makeRun({ sessionID: "s1-new" })]]),
  });
  h.subscribe("/w");
  await h.drained;
  assert.deepEqual(systemNotices(h), [{ text: NOTICE("news.example.com"), kind: "system" }]);
});
