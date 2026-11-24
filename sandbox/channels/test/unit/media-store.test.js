import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "bun:test";

import { withDeliveryRetry } from "../../dist/delivery.js";
import { MediaStore } from "../../src/media-store.ts";

async function withHttpServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("resolveOutboundFile confines attachments to the real workspace root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-root-"));
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`);
  fs.mkdirSync(outside);
  const store = new MediaStore(path.join(root, ".media"));
  const baseDirectory = path.join(root, "subdir");
  fs.mkdirSync(baseDirectory);
  const insideFile = path.join(root, "inside.txt");
  const dottedFile = path.join(root, "..inside.txt");
  const relativeFile = path.join(baseDirectory, "relative.txt");
  const outsideFile = path.join(outside, "outside.txt");
  fs.writeFileSync(insideFile, "inside");
  fs.writeFileSync(dottedFile, "dotted");
  fs.writeFileSync(relativeFile, "relative");
  fs.writeFileSync(outsideFile, "outside");

  try {
    const relative = await store.resolveOutboundFile({ filePath: "relative.txt", baseDirectory, allowedRoot: root });
    assert.equal(relative.filePath, fs.realpathSync(relativeFile));
    assert.equal(Buffer.from(relative.data).toString(), "relative");

    const absoluteInside = await store.resolveOutboundFile({ filePath: insideFile, baseDirectory, allowedRoot: root });
    assert.equal(absoluteInside.filePath, fs.realpathSync(insideFile));

    const dotted = await store.resolveOutboundFile({ filePath: "..inside.txt", baseDirectory: root, allowedRoot: root });
    assert.equal(dotted.filePath, fs.realpathSync(dottedFile));

    await assert.rejects(
      store.resolveOutboundFile({ filePath: outsideFile, baseDirectory, allowedRoot: root }),
      (error) => error instanceof Error && error.status === 403 && error.code === "path_outside_workspace",
    );
    await assert.rejects(
      store.resolveOutboundFile({ filePath: path.join("..", "..", path.basename(outside), "outside.txt"), baseDirectory, allowedRoot: root }),
      (error) => error instanceof Error && error.status === 403 && error.code === "path_outside_workspace",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveOutboundFile rejects a symlink that resolves outside the workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-root-"));
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`);
  fs.mkdirSync(outside);
  const outsideFile = path.join(outside, "outside.txt");
  fs.writeFileSync(outsideFile, "outside");
  fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  const store = new MediaStore(path.join(root, ".media"));

  try {
    await assert.rejects(
      store.resolveOutboundFile({ filePath: path.join("escape", "outside.txt"), baseDirectory: root, allowedRoot: root }),
      (error) => error instanceof Error && error.status === 403 && error.code === "path_outside_workspace",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveOutboundFile returns no more than the configured maximum", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-root-"));
  const filePath = path.join(root, "large.txt");
  fs.writeFileSync(filePath, "123456789");
  const store = new MediaStore(path.join(root, ".media"));

  try {
    await assert.rejects(
      store.resolveOutboundFile({ filePath, baseDirectory: root, allowedRoot: root, maxBytes: 8 }),
      (error) => error instanceof Error && error.status === 413,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.serial("downloadInbound streams within the byte limit and rejects an oversized body without leaving files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-inbound-"));
  const store = new MediaStore(path.join(root, "media"), { inboundMaxBytes: 5 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
      controller.close();
    },
  }));

  try {
    await assert.rejects(
      store.downloadInbound({ channel: "telegram", identityId: "test", peerId: "peer", kind: "file", url: "https://example.test/file" }),
      (error) => error instanceof Error && error.status === 413,
    );
    const files = fs.existsSync(path.join(root, "media"))
      ? fs.readdirSync(path.join(root, "media"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      : [];
    assert.deepEqual(files, []);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.serial("downloadInbound accepts a response exactly at the byte limit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-inbound-"));
  const store = new MediaStore(path.join(root, "media"), { inboundMaxBytes: 5 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), {
    headers: { "content-length": "5" },
  });

  try {
    const stored = await store.downloadInbound({
      channel: "telegram", identityId: "test", peerId: "peer", kind: "file", url: "https://example.test/file",
    });
    assert.equal(stored.sizeBytes, 5);
    assert.equal(fs.statSync(stored.filePath).size, 5);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.serial("downloadInbound caps the final filename and preserves its extension", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-inbound-"));
  const store = new MediaStore(path.join(root, "media"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("file contents");

  try {
    const stored = await store.downloadInbound({
      channel: "slack",
      identityId: "test",
      peerId: "peer",
      kind: "file",
      url: "https://example.test/file",
      filename: `${"a".repeat(260)}.txt`,
    });
    assert.equal(Buffer.byteLength(stored.filename), 255);
    assert.ok(stored.filename.endsWith(".txt"));
    assert.equal(fs.existsSync(stored.filePath), true);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.serial("downloadInbound aborts a real fetch stalled before response headers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-inbound-"));
  const store = new MediaStore(path.join(root, "media"), { inboundTimeoutMs: 150 });
  let requestReceived;
  const requestReceivedPromise = new Promise((resolve) => {
    requestReceived = resolve;
  });

  try {
    await withHttpServer((_request, _response) => requestReceived(), async (baseUrl) => {
      const download = store.downloadInbound({
        channel: "telegram", identityId: "test", peerId: "peer", kind: "file", url: `${baseUrl}/stalled`,
      });
      await requestReceivedPromise;
      await assert.rejects(download, (error) => error instanceof Error && error.status === 408);
      assert.equal(fs.existsSync(path.join(root, "media")), false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.serial("inbound media retry uses one total deadline across attempts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-inbound-"));
  const store = new MediaStore(path.join(root, "media"), { inboundTimeoutMs: 1_000 });
  let requestCount = 0;
  let stalledRequestReceived;
  const stalledRequestReceivedPromise = new Promise((resolve) => {
    stalledRequestReceived = resolve;
  });

  try {
    await withHttpServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        response.writeHead(503);
        response.end();
      } else {
        stalledRequestReceived();
      }
    }, async (baseUrl) => {
      const startedAt = Date.now();
      const download = withDeliveryRetry(
        "test.inbound.download",
        (signal) => store.downloadInbound({
          channel: "telegram",
          identityId: "test",
          peerId: "peer",
          kind: "file",
          url: `${baseUrl}/retry-then-stall`,
          signal,
        }),
        { totalTimeoutMs: 250, baseDelayMs: 50, maxDelayMs: 50 },
      );

      await stalledRequestReceivedPromise;
      await assert.rejects(download, (error) => error instanceof Error && error.status === 408);
      assert.ok(Date.now() - startedAt < 800, "retry sequence should stay within the single 250 ms budget plus scheduling tolerance");
      assert.equal(requestCount, 2);
      assert.equal(fs.existsSync(path.join(root, "media")), false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.serial("downloadInbound applies the byte limit to a decompressed response body", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-inbound-"));
  const expanded = Buffer.alloc(100_000, "a");
  const compressed = gzipSync(expanded);
  assert.ok(compressed.byteLength < 1_000);
  const store = new MediaStore(path.join(root, "media"), { inboundMaxBytes: 1_000 });

  try {
    await withHttpServer((_request, response) => {
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": compressed.byteLength,
        "content-type": "application/octet-stream",
      });
      response.end(compressed);
    }, async (baseUrl) => {
      await assert.rejects(
        store.downloadInbound({
          channel: "slack", identityId: "test", peerId: "peer", kind: "file", url: `${baseUrl}/compressed`,
        }),
        (error) => error instanceof Error && error.status === 413,
      );
      const files = fs.existsSync(path.join(root, "media"))
        ? fs.readdirSync(path.join(root, "media"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
        : [];
      assert.deepEqual(files, []);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.serial("downloadInbound rejects an oversized Content-Length before reading the response body", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-inbound-"));
  const store = new MediaStore(path.join(root, "media"), { inboundMaxBytes: 5 });
  const originalFetch = globalThis.fetch;
  let bodyCanceled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    cancel() {
      bodyCanceled = true;
    },
  }), { headers: { "content-length": "6" } });

  try {
    await assert.rejects(
      store.downloadInbound({ channel: "slack", identityId: "test", peerId: "peer", kind: "file", url: "https://example.test/file" }),
      (error) => error instanceof Error && error.status === 413,
    );
    assert.equal(bodyCanceled, true);
    assert.equal(fs.existsSync(path.join(root, "media")), false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.serial("downloadInbound aborts and cancels the response when Content-Length is invalid", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-inbound-"));
  const store = new MediaStore(path.join(root, "media"), { inboundMaxBytes: 10 });
  const originalFetch = globalThis.fetch;
  let requestSignal;
  let bodyCanceled = false;
  globalThis.fetch = async (_url, options) => {
    requestSignal = options.signal;
    return new Response(new ReadableStream({
      cancel() {
        bodyCanceled = true;
      },
    }), { headers: { "content-length": "not-a-size" } });
  };

  try {
    await assert.rejects(
      store.downloadInbound({ channel: "slack", identityId: "test", peerId: "peer", kind: "file", url: "https://example.test/file" }),
      (error) => error instanceof Error && error.status === 400,
    );
    assert.equal(requestSignal.aborted, true);
    assert.equal(bodyCanceled, true);
    assert.equal(fs.existsSync(path.join(root, "media")), false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.serial("downloadInbound rejects a Content-Length smaller than the completed stream", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-inbound-"));
  const store = new MediaStore(path.join(root, "media"), { inboundMaxBytes: 10 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), {
    headers: { "content-length": "5" },
  });

  try {
    await assert.rejects(
      store.downloadInbound({ channel: "slack", identityId: "test", peerId: "peer", kind: "file", url: "https://example.test/file" }),
      (error) => error instanceof Error && error.status === 400 && error.message.includes("did not match"),
    );
    const files = fs.existsSync(path.join(root, "media"))
      ? fs.readdirSync(path.join(root, "media"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      : [];
    assert.deepEqual(files, []);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.serial("downloadInbound aborts at its deadline and removes the partial file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-inbound-"));
  const store = new MediaStore(path.join(root, "media"), { inboundTimeoutMs: 20 });
  const originalFetch = globalThis.fetch;
  let streamController;
  let requestAborted = false;
  globalThis.fetch = async (_url, options) => {
    options.signal.addEventListener("abort", () => {
      requestAborted = true;
      streamController.error(options.signal.reason);
    }, { once: true });
    return new Response(new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(new Uint8Array([1, 2]));
      },
    }));
  };

  try {
    await assert.rejects(
      store.downloadInbound({ channel: "telegram", identityId: "test", peerId: "peer", kind: "file", url: "https://example.test/file" }),
      (error) => error instanceof Error && error.status === 408,
    );
    assert.equal(requestAborted, true);
    const files = fs.existsSync(path.join(root, "media"))
      ? fs.readdirSync(path.join(root, "media"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      : [];
    assert.deepEqual(files, []);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.serial("downloadInbound bounds concurrent work and rejects when its queue is full", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-inbound-"));
  const store = new MediaStore(path.join(root, "media"), { inboundMaxConcurrent: 1, inboundMaxQueued: 1 });
  const originalFetch = globalThis.fetch;
  let firstStreamController;
  let firstFetchStarted;
  const firstFetchStartedPromise = new Promise((resolve) => {
    firstFetchStarted = resolve;
  });
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(new ReadableStream({
        start(controller) {
          firstStreamController = controller;
          controller.enqueue(new Uint8Array([1]));
          firstFetchStarted();
        },
      }));
    }
    return new Response(new Uint8Array([2]));
  };
  const input = { channel: "telegram", identityId: "test", peerId: "peer", kind: "file", url: "https://example.test/file" };

  try {
    const first = store.downloadInbound(input);
    await firstFetchStartedPromise;
    const queued = store.downloadInbound(input);
    await assert.rejects(
      store.downloadInbound(input),
      (error) => error instanceof Error && error.message.includes("capacity is exhausted"),
    );
    assert.equal(fetchCount, 1);
    firstStreamController.close();
    await Promise.all([first, queued]);
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.serial("downloadInbound removes a queued request when its deadline expires", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-inbound-"));
  const store = new MediaStore(path.join(root, "media"), {
    inboundTimeoutMs: 2_000,
    inboundMaxConcurrent: 1,
    inboundMaxQueued: 1,
  });
  const queuedStore = new MediaStore(path.join(root, "media"), {
    inboundTimeoutMs: 50,
    inboundMaxConcurrent: 1,
    inboundMaxQueued: 1,
  });
  const originalFetch = globalThis.fetch;
  let firstStreamController;
  let firstFetchStarted;
  const firstFetchStartedPromise = new Promise((resolve) => {
    firstFetchStarted = resolve;
  });
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(new ReadableStream({
        start(controller) {
          firstStreamController = controller;
          controller.enqueue(new Uint8Array([1]));
          firstFetchStarted();
        },
      }));
    }
    return new Response(new Uint8Array([2]));
  };
  const firstInput = { channel: "telegram", identityId: "test", peerId: "peer", kind: "file", url: "https://example.test/first" };

  try {
    const first = store.downloadInbound(firstInput);
    await firstFetchStartedPromise;
    const queued = queuedStore.downloadInbound(firstInput);
    const queuedRejected = assert.rejects(queued, (error) => error instanceof Error && error.status === 408);
    await delay(100);
    await queuedRejected;
    assert.equal(fetchCount, 1);

    firstStreamController.close();
    await first;
    const afterTimeout = await store.downloadInbound(firstInput);
    assert.equal(afterTimeout.sizeBytes, 1);
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.serial("downloadInbound cleans up after a mid-stream disconnect and reuses the slot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-inbound-"));
  const store = new MediaStore(path.join(root, "media"), { inboundMaxConcurrent: 1 });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.error(new Error("stream disconnected"));
        },
      }));
    }
    return new Response(new Uint8Array([3]));
  };
  const input = { channel: "telegram", identityId: "test", peerId: "peer", kind: "file", url: "https://example.test/file" };

  try {
    await assert.rejects(store.downloadInbound(input), /stream disconnected/);
    const filesAfterFailure = fs.existsSync(path.join(root, "media"))
      ? fs.readdirSync(path.join(root, "media"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      : [];
    assert.deepEqual(filesAfterFailure, []);

    const recovered = await store.downloadInbound(input);
    assert.equal(recovered.sizeBytes, 1);
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureReady accepts an inbox the host created and refuses one that is not a directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-media-root-"));
  const hostCreated = path.join(root, "inbox");
  const notADirectory = path.join(root, "inbox-file");
  fs.mkdirSync(hostCreated);
  fs.writeFileSync(notADirectory, "x");

  try {
    await new MediaStore(hostCreated).ensureReady();
    await assert.rejects(new MediaStore(notADirectory).ensureReady());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
