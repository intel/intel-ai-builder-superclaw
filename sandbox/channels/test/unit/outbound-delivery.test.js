import assert from "node:assert/strict";
import { test } from "bun:test";

import { createOutboundDelivery } from "../../dist/outbound-delivery.js";

// Delivery is where a partial failure has to stay partial: if part 2 of 3 fails,
// the caller needs to know which one and whether retrying is worth it, rather
// than getting a thrown error that loses the parts that did land.

function makeDelivery(overrides = {}) {
  const sentText = [];
  const sentFiles = [];
  const reported = [];
  const activity = [];
  const adapter = {
    maxTextLength: 10,
    sendText: async (peerId, text) => sentText.push({ peerId, text }),
    sendFile: async (peerId, filePath, caption) => sentFiles.push({ peerId, filePath, caption }),
    ...(overrides.adapter ?? {}),
  };
  const deps = {
    resolveAdapter: () => adapter,
    reportOutbound: (event) => reported.push(event),
    recordOutboundActivity: (now) => activity.push(now),
    mediaStore: {
      resolveOutboundFile: async ({ filePath }) => ({ filePath: `/resolved${filePath}`, filename: "f.png" }),
    },
    workspaceRoot: "/work",
    outboundMediaMaxBytes: 1024,
    ...overrides,
  };
  return { api: createOutboundDelivery(deps), sentText, sentFiles, reported, activity, adapter };
}

// ------------------------------------------------------- outbound file roots

test("with an outbox, files are resolved inside the outbox and nowhere else", async () => {
  const seen = [];
  const { api } = makeDelivery({
    outboundRoot: "/outbox",
    mediaStore: {
      resolveOutboundFile: async (input) => {
        seen.push(input);
        return { filePath: input.filePath, filename: "f.png" };
      },
    },
  });
  await api.resolveOutboundParts("/work/sub", { parts: [{ type: "file", filePath: "report.pdf" }] });
  assert.equal(seen[0].allowedRoot, "/outbox");
  assert.equal(seen[0].baseDirectory, "/outbox");
});

test("without an outbox, files keep resolving against the workspace", async () => {
  const seen = [];
  const { api } = makeDelivery({
    mediaStore: {
      resolveOutboundFile: async (input) => {
        seen.push(input);
        return { filePath: input.filePath, filename: "f.png" };
      },
    },
  });
  await api.resolveOutboundParts("/work/sub", { parts: [{ type: "file", filePath: "report.pdf" }] });
  assert.equal(seen[0].allowedRoot, "/work");
  assert.equal(seen[0].baseDirectory, "/work/sub");
});

// -------------------------------------------------------------- deliverParts

test("a missing adapter fails every part as not_found instead of throwing", async () => {
  const { api } = makeDelivery({ resolveAdapter: () => undefined });
  const result = await api.deliverParts("slack", "i1", "p1", [
    { type: "text", text: "a" },
    { type: "text", text: "b" },
  ]);
  assert.equal(result.attemptedParts, 2);
  assert.equal(result.sentParts, 0);
  assert.deepEqual(
    result.partResults.map((r) => [r.index, r.code, r.retryable]),
    [
      [0, "not_found", false],
      [1, "not_found", false],
    ],
  );
});

test("text is chunked to the adapter's limit", async () => {
  const { api, sentText } = makeDelivery();
  const result = await api.deliverParts("slack", "i1", "p1", [{ type: "text", text: "0123456789ABCDE" }]);
  assert.equal(result.sentParts, 1);
  assert.equal(sentText.length > 1, true, "a 15-char message must split across a 10-char limit");
  assert.equal(sentText.map((s) => s.text).join(""), "0123456789ABCDE");
});

test("a batch sendMessage adapter is preferred over per-part sends", async () => {
  const calls = [];
  const { api, sentText } = makeDelivery({
    adapter: {
      sendMessage: async (peerId, message) => {
        calls.push({ peerId, message });
        return { attemptedParts: 1, sentParts: 1, partResults: [{ index: 0, type: "text", sent: true }] };
      },
    },
  });
  const result = await api.deliverParts("slack", "i1", "p1", [{ type: "text", text: "hi" }]);
  assert.equal(result.sentParts, 1);
  assert.equal(calls.length, 1);
  assert.equal(sentText.length, 0, "per-part sendText must not also run");
});

test("a throwing sendMessage is classified, not propagated", async () => {
  const { api } = makeDelivery({
    adapter: {
      sendMessage: async () => {
        throw new Error("slack exploded");
      },
    },
  });
  const result = await api.deliverParts("slack", "i1", "p1", [{ type: "text", text: "hi" }]);
  assert.equal(result.sentParts, 0);
  assert.equal(result.partResults[0].sent, false);
  assert.equal(result.partResults[0].error.includes("slack exploded"), true);
});

test("one failing part does not stop the others, and is reported by index", async () => {
  let call = 0;
  const { api } = makeDelivery({
    adapter: {
      maxTextLength: 100,
      sendText: async () => {
        call += 1;
        if (call === 2) throw new Error("second part failed");
      },
    },
  });
  const result = await api.deliverParts("slack", "i1", "p1", [
    { type: "text", text: "one" },
    { type: "text", text: "two" },
    { type: "text", text: "three" },
  ]);
  assert.equal(result.attemptedParts, 3);
  assert.equal(result.sentParts, 2);
  const failed = result.partResults.filter((r) => !r.sent);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].index, 1);
});

test("media without adapter support fails that part with a clear reason", async () => {
  const { api } = makeDelivery({ adapter: { maxTextLength: 100, sendText: async () => {}, sendFile: undefined } });
  const result = await api.deliverParts("slack", "i1", "p1", [{ type: "image", filePath: "/a.png" }]);
  assert.equal(result.sentParts, 0);
  assert.equal(result.partResults[0].error.includes("does not support image"), true);
});

test("outbound previews are reported once per part, and suppressed by display:false", async () => {
  const { api, reported } = makeDelivery({ adapter: { maxTextLength: 100, sendText: async () => {} } });
  await api.deliverParts("slack", "i1", "p1", [{ type: "text", text: "a" }, { type: "text", text: "b" }]);
  assert.equal(reported.length, 2);
  assert.equal(reported[0].kind, "system", "kind defaults to system");

  reported.length = 0;
  await api.deliverParts("slack", "i1", "p1", [{ type: "text", text: "a" }], { display: false });
  assert.equal(reported.length, 0);
});

test("delivery records outbound activity even when every part fails", async () => {
  const { api, activity } = makeDelivery({
    adapter: {
      maxTextLength: 100,
      sendText: async () => {
        throw new Error("nope");
      },
    },
  });
  const result = await api.deliverParts("slack", "i1", "p1", [{ type: "text", text: "a" }]);
  assert.equal(result.sentParts, 0);
  assert.equal(activity.length, 1, "activity is recorded before the send is attempted");
});

test("a reporter is optional", async () => {
  const { api } = makeDelivery({ reportOutbound: undefined, adapter: { maxTextLength: 100, sendText: async () => {} } });
  const result = await api.deliverParts("slack", "i1", "p1", [{ type: "text", text: "a" }]);
  assert.equal(result.sentParts, 1);
});

// ------------------------------------------------------- resolveOutboundParts

test("an empty input is rejected with a 400", async () => {
  const { api } = makeDelivery();
  await assert.rejects(() => api.resolveOutboundParts("/work", {}), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.message, "text or parts is required");
    return true;
  });
});

test("text parts pass through untouched", async () => {
  const { api } = makeDelivery();
  const parts = await api.resolveOutboundParts("/work", { text: "hello" });
  assert.deepEqual(parts, [{ type: "text", text: "hello" }]);
});

test("media parts are resolved through the media store and gain a filename", async () => {
  const { api } = makeDelivery();
  const parts = await api.resolveOutboundParts("/work/sub", { parts: [{ type: "image", filePath: "/a.png" }] });
  assert.equal(parts[0].filePath, "/resolved/a.png");
  assert.equal(parts[0].filename, "f.png");
});

test("an explicit filename is not overwritten by the resolver", async () => {
  const { api } = makeDelivery();
  const parts = await api.resolveOutboundParts("/work", {
    parts: [{ type: "image", filePath: "/a.png", filename: "mine.png" }],
  });
  assert.equal(parts[0].filename, "mine.png");
});

// ------------------------------------------------------- outbox confinement

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function outboxFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-confine-"));
  const outbox = path.join(dir, "outbox");
  fs.mkdirSync(outbox);
  const staged = path.join(outbox, "ok.txt");
  fs.writeFileSync(staged, "ok");
  const secret = path.join(dir, "opencode-router.json");
  fs.writeFileSync(secret, "{\"token\":\"s\"}");
  return { dir, outbox, staged, secret };
}

test("deliverParts refuses a file outside the outbox: no adapter call, refusal reported", async () => {
  const { outbox, secret } = outboxFixture();
  const { api, sentFiles, sentText } = makeDelivery({ outboundRoot: outbox });
  const result = await api.deliverParts("slack", "i1", "p1", [{ type: "file", filePath: secret }]);
  assert.equal(sentFiles.length, 0);
  assert.equal(result.sentParts, 0);
  assert.equal(result.partResults[0].code, "path_outside_outbox");
  assert.equal(sentText.length, 1, "the thread is told");
  assert.equal(sentText[0].text.includes(secret), false);
});

test("deliverParts refuses traversal out of the outbox", async () => {
  const { outbox } = outboxFixture();
  const { api, sentFiles } = makeDelivery({ outboundRoot: outbox });
  const result = await api.deliverParts("slack", "i1", "p1", [
    { type: "file", filePath: path.join("..", "opencode-router.json") },
  ]);
  assert.equal(sentFiles.length, 0);
  assert.equal(result.partResults[0].sent, false);
});

test("deliverParts refuses a symlink in the outbox that points outside", async () => {
  const { outbox, secret } = outboxFixture();
  const link = path.join(outbox, "link.json");
  try {
    fs.symlinkSync(secret, link);
  } catch {
    return;
  }
  const { api, sentFiles } = makeDelivery({ outboundRoot: outbox });
  const result = await api.deliverParts("slack", "i1", "p1", [{ type: "file", filePath: link }]);
  assert.equal(sentFiles.length, 0);
  assert.equal(result.partResults[0].code, "path_outside_outbox");
});

test("deliverParts still delivers outbox files and keeps mixed-part indexes", async () => {
  const { outbox, staged, secret } = outboxFixture();
  const { api, sentFiles } = makeDelivery({ outboundRoot: outbox });
  const result = await api.deliverParts("slack", "i1", "p1", [
    { type: "file", filePath: secret },
    { type: "file", filePath: "ok.txt" },
  ]);
  assert.equal(sentFiles.length, 1);
  assert.equal(fs.realpathSync(sentFiles[0].filePath), fs.realpathSync(staged));
  assert.equal(result.sentParts, 1);
  assert.deepEqual(result.partResults.map((r) => [r.index, r.sent]), [[0, false], [1, true]]);
});

// ------------------------------------------------ open-once (check/open race)

test("outbox files reach the adapter as bytes, via sendMessage and per-part sendFile", async () => {
  const { outbox } = outboxFixture();
  const batches = [];
  const batch = makeDelivery({
    outboundRoot: outbox,
    adapter: { sendMessage: async (_p, message) => { batches.push(message); return { attemptedParts: 1, sentParts: 1, partResults: [] }; } },
  });
  await batch.api.deliverParts("slack", "i1", "p1", [{ type: "file", filePath: "ok.txt" }]);
  assert.equal(Buffer.from(batches[0].parts[0].data).toString("utf8"), "ok");

  const datas = [];
  const single = makeDelivery({
    outboundRoot: outbox,
    adapter: { sendFile: async (_p, _f, _c, data) => datas.push(data) },
  });
  await single.api.deliverParts("slack", "i1", "p1", [{ type: "file", filePath: "ok.txt" }]);
  assert.equal(Buffer.from(datas[0]).toString("utf8"), "ok");
});

test("a directory swapped for a link between check and open sends nothing from outside", async () => {
  const { dir, outbox, secret } = outboxFixture();
  const sub = path.join(outbox, "sub");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "opencode-router.json"), "decoy");
  const outside = path.join(dir, "private");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "opencode-router.json"), "SECRET-CREDENTIALS");
  let swapped = false;
  const beforeOpen = async () => {
    fs.renameSync(sub, path.join(outbox, "sub-moved"));
    try {
      fs.symlinkSync(outside, sub, "junction");
      swapped = true;
    } catch {
      // links unavailable here
    }
  };
  const seen = [];
  const { api, sentFiles } = makeDelivery({
    outboundRoot: outbox,
    beforeOpen,
    adapter: { sendFile: async (_p, f, _c, data) => { seen.push(data); sentFiles.push(f); } },
  });
  const result = await api.deliverParts("slack", "i1", "p1", [
    { type: "file", filePath: path.join("sub", "opencode-router.json") },
  ]);
  if (!swapped) return; // cannot create links on this platform; the mock-based test below covers it
  assert.equal(seen.length, 0);
  assert.equal(result.partResults[0].code, "path_outside_outbox");
  void secret;
});

test("the adapter is never handed a path to reopen: swapping the path after delivery starts changes nothing", async () => {
  const { outbox, staged } = outboxFixture();
  const seen = [];
  const { api } = makeDelivery({
    outboundRoot: outbox,
    adapter: {
      sendFile: async (_p, _f, _c, data) => {
        fs.writeFileSync(staged, "REPLACED-AFTER-VALIDATION");
        seen.push(Buffer.from(data).toString("utf8"));
      },
    },
  });
  await api.deliverParts("slack", "i1", "p1", [{ type: "file", filePath: "ok.txt" }]);
  assert.equal(seen[0], "ok");
});

test("a file over the size cap is refused at the boundary", async () => {
  const { outbox } = outboxFixture();
  fs.writeFileSync(path.join(outbox, "big.bin"), Buffer.alloc(2048));
  const { api, sentFiles } = makeDelivery({ outboundRoot: outbox });
  const result = await api.deliverParts("slack", "i1", "p1", [{ type: "file", filePath: "big.bin" }]);
  assert.equal(sentFiles.length, 0);
  assert.equal(result.partResults[0].code, "path_outside_outbox");
});

test("a junction directly in the outbox pointing outside is refused", async () => {
  const { dir, outbox } = outboxFixture();
  const outside = path.join(dir, "private");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "x.json"), "SECRET");
  try {
    fs.symlinkSync(outside, path.join(outbox, "j"), "junction");
  } catch {
    return;
  }
  const { api, sentFiles } = makeDelivery({ outboundRoot: outbox });
  const result = await api.deliverParts("slack", "i1", "p1", [{ type: "file", filePath: path.join("j", "x.json") }]);
  assert.equal(sentFiles.length, 0);
  assert.equal(result.partResults[0].code, "path_outside_outbox");
});
