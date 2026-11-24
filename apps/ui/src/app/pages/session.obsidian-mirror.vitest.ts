// Not `bun test`: the sync loop needs `window.setInterval` plus the
// `window.__TAURI_INTERNALS__` that `isTauriRuntime()` reads, and the mirror
// readers have to be module-mocked. None of that exists in the bun lane.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createRoot } from "solid-js";
import type { OpenworkServerClient } from "../lib/openwork-server";
import { createObsidianMirror } from "./session.obsidian-mirror";

const mirrorFs = vi.hoisted(() => ({
  readObsidianMirrorFile: vi.fn(),
  writeObsidianMirrorFile: vi.fn(),
}));

// Spread the original so the server/hub clients imported transitively keep
// working; only the two mirror readers are replaced.
vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  readObsidianMirrorFile: mirrorFs.readObsidianMirrorFile,
  writeObsidianMirrorFile: mirrorFs.writeObsidianMirrorFile,
}));

type Deps = Parameters<typeof createObsidianMirror>[0];
type Mirror = ReturnType<typeof createObsidianMirror>;

const SYNC_TICK_MS = 2500;
const TRACKED = "notes/plan.md";

const b64 = (value: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)));

const fileSession = (id = "fs-1") => ({
  id,
  workspaceId: "ws-1",
  createdAt: 0,
  // Far enough out that no tick trips the renew-lead threshold.
  expiresAt: Number.MAX_SAFE_INTEGER,
  ttlMs: 900_000,
  canWrite: true,
});

const readOk = (content: string, revision = "r1", path = TRACKED) => ({
  ok: true as const,
  path,
  kind: "file" as const,
  bytes: content.length,
  updatedAt: 0,
  revision,
  contentBase64: b64(content),
});

const readErr = (code: string, path = TRACKED) => ({
  ok: false as const,
  path,
  code,
  message: code,
});

const writeOk = (revision = "r2", path = TRACKED) => ({
  items: [
    {
      ok: true as const,
      path,
      bytes: 1,
      updatedAt: 0,
      revision,
    },
  ],
  cursor: 1,
});

const writeConflict = (path = TRACKED) => ({
  items: [
    {
      ok: false as const,
      path,
      code: "conflict",
      message: "revision mismatch",
    },
  ],
  cursor: 1,
});

/** A client whose file-session surface is entirely spies. */
const makeClient = () => {
  const client = {
    createFileSession: vi.fn().mockResolvedValue({ session: fileSession() }),
    renewFileSession: vi.fn().mockResolvedValue({ session: fileSession() }),
    closeFileSession: vi.fn().mockResolvedValue(undefined),
    readFileBatch: vi.fn().mockResolvedValue({ items: [readOk("v1")] }),
    writeFileBatch: vi.fn().mockResolvedValue(writeOk()),
    listFileSessionEvents: vi.fn().mockResolvedValue({ items: [], cursor: 0 }),
  };
  return client as typeof client & OpenworkServerClient;
};

const makeDeps = (
  client: ReturnType<typeof makeClient>,
  over: Partial<Deps> = {},
): Deps => ({
  serverClient: () => client,
  serverWorkspaceId: () => "ws-1",
  workspaceDisplayId: () => "display-1",
  workspaceType: () => "remote",
  activeWorkspaceRoot: () => "",
  setToastMessage: vi.fn(),
  ...over,
});

/** Let queued microtasks settle without moving the fake clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Advance one sync tick and let its async body finish. */
const tick = () => vi.advanceTimersByTimeAsync(SYNC_TICK_MS);

const run = (deps: Deps, body: (mirror: Mirror) => Promise<void>) =>
  createRoot(async (dispose) => {
    await body(createObsidianMirror(deps));
    dispose();
  });

beforeEach(() => {
  vi.useFakeTimers();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
    {};
  mirrorFs.writeObsidianMirrorFile.mockImplementation(
    async (_ws: string, path: string) => `C:/vault/${path}`,
  );
  mirrorFs.readObsidianMirrorFile.mockResolvedValue({
    exists: true,
    content: "v1",
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  mirrorFs.readObsidianMirrorFile.mockReset();
  mirrorFs.writeObsidianMirrorFile.mockReset();
});

describe("mirrorRemoteArtifactForObsidian", () => {
  test("writes the remote content into the vault and returns the local path", async () => {
    const client = makeClient();
    await run(makeDeps(client), async (mirror) => {
      const local = await mirror.mirrorRemoteArtifactForObsidian(TRACKED);

      expect(local).toBe(`C:/vault/${TRACKED}`);
      expect(mirrorFs.writeObsidianMirrorFile).toHaveBeenCalledWith(
        "ws-1",
        TRACKED,
        "v1",
      );
      expect(client.createFileSession).toHaveBeenCalledWith("ws-1", {
        ttlSeconds: 900,
        write: true,
      });
    });
  });

  test("falls through to the outbox candidate when the direct path is missing", async () => {
    const client = makeClient();
    client.readFileBatch
      .mockResolvedValueOnce({ items: [readErr("file_not_found")] })
      .mockResolvedValueOnce({ items: [readOk("from-outbox")] });

    await run(makeDeps(client), async (mirror) => {
      await mirror.mirrorRemoteArtifactForObsidian(TRACKED);

      expect(client.readFileBatch).toHaveBeenCalledTimes(2);
      expect(mirrorFs.writeObsidianMirrorFile).toHaveBeenCalledWith(
        "ws-1",
        ".opencode/openwork/outbox/notes/plan.md",
        "from-outbox",
      );
    });
  });

  test("rejects when no candidate exists on the worker", async () => {
    const client = makeClient();
    client.readFileBatch.mockResolvedValue({
      items: [readErr("file_not_found")],
    });

    await run(makeDeps(client), async (mirror) => {
      await expect(
        mirror.mirrorRemoteArtifactForObsidian(TRACKED),
      ).rejects.toThrow();
      expect(mirrorFs.writeObsidianMirrorFile).not.toHaveBeenCalled();
    });
  });
});

describe("sync loop", () => {
  test("pulls a remote write event down into the vault", async () => {
    const client = makeClient();
    await run(makeDeps(client), async (mirror) => {
      await mirror.mirrorRemoteArtifactForObsidian(TRACKED);
      await flush();
      mirrorFs.writeObsidianMirrorFile.mockClear();

      client.listFileSessionEvents.mockResolvedValueOnce({
        items: [{ type: "write", path: TRACKED }],
        cursor: 1,
      });
      client.readFileBatch.mockResolvedValueOnce({
        items: [readOk("from-remote", "r9")],
      });

      await tick();

      expect(mirrorFs.writeObsidianMirrorFile).toHaveBeenCalledWith(
        "ws-1",
        TRACKED,
        "from-remote",
      );
    });
  });

  test("pushes a local edit back with the tracked revision", async () => {
    const client = makeClient();
    await run(makeDeps(client), async (mirror) => {
      await mirror.mirrorRemoteArtifactForObsidian(TRACKED);
      await flush();

      mirrorFs.readObsidianMirrorFile.mockResolvedValue({
        exists: true,
        content: "edited-locally",
      });

      await tick();

      expect(client.writeFileBatch).toHaveBeenCalledWith("fs-1", [
        {
          path: TRACKED,
          contentBase64: b64("edited-locally"),
          ifMatchRevision: "r1",
        },
      ]);
    });
  });

  test("a rejected push is preserved as a conflict copy, not dropped", async () => {
    const client = makeClient();
    const setToastMessage = vi.fn();
    client.writeFileBatch.mockResolvedValueOnce(writeConflict());

    await run(makeDeps(client, { setToastMessage }), async (mirror) => {
      await mirror.mirrorRemoteArtifactForObsidian(TRACKED);
      await flush();

      mirrorFs.readObsidianMirrorFile.mockResolvedValue({
        exists: true,
        content: "my-local-edit",
      });

      await tick();

      const conflictWrite = mirrorFs.writeObsidianMirrorFile.mock.calls.find(
        ([, path]) => String(path).includes(".openwork-conflict-"),
      );
      expect(conflictWrite).toBeDefined();
      // The local edit must survive somewhere on disk.
      expect(conflictWrite?.[2]).toBe("my-local-edit");
      expect(setToastMessage).toHaveBeenCalledWith(
        expect.stringContaining("Conflict syncing"),
      );
    });
  });

  test("a conflict does not wedge the file against later local edits", async () => {
    const client = makeClient();
    client.writeFileBatch.mockResolvedValueOnce(writeConflict());

    await run(makeDeps(client), async (mirror) => {
      await mirror.mirrorRemoteArtifactForObsidian(TRACKED);
      await flush();

      mirrorFs.readObsidianMirrorFile.mockResolvedValue({
        exists: true,
        content: "my-local-edit",
      });
      await tick();
      expect(client.writeFileBatch).toHaveBeenCalledTimes(1);

      // The conflict refresh replaces the tracked entry while the push that
      // triggered it is still in flight. If the replacement inherits that
      // push's `syncingLocal`, nothing clears it and the file is skipped in
      // both directions from here on.
      mirrorFs.readObsidianMirrorFile.mockResolvedValue({
        exists: true,
        content: "edit-after-conflict",
      });
      await tick();

      expect(client.writeFileBatch).toHaveBeenCalledTimes(2);
      // ...against the revision the conflict refresh picked up, not the stale
      // one the rejected push used.
      expect(client.writeFileBatch.mock.calls[1][1][0]).toMatchObject({
        ifMatchRevision: "r1",
      });
    });
  });

  test("collapses repeated sync failures into one toast per window", async () => {
    const client = makeClient();
    const setToastMessage = vi.fn();
    await run(makeDeps(client, { setToastMessage }), async (mirror) => {
      await mirror.mirrorRemoteArtifactForObsidian(TRACKED);
      await flush();
      setToastMessage.mockClear();

      client.listFileSessionEvents.mockRejectedValue(new Error("network down"));

      await tick();
      await tick();

      // Two failing ticks are 2.5s apart, inside the 6s throttle window.
      expect(setToastMessage).toHaveBeenCalledTimes(1);
    });
  });

  test("a mirror during an in-flight push leaves the file still syncing", async () => {
    const client = makeClient();
    await run(makeDeps(client), async (mirror) => {
      await mirror.mirrorRemoteArtifactForObsidian(TRACKED);
      await flush();

      // A local edit is pending upload, and the push has not settled yet.
      mirrorFs.readObsidianMirrorFile.mockResolvedValue({
        exists: true,
        content: "edit-one",
      });
      let settlePush: (value: ReturnType<typeof writeOk>) => void = () => {};
      client.writeFileBatch.mockReturnValueOnce(
        new Promise((resolve) => {
          settlePush = resolve;
        }),
      );
      await tick();
      expect(client.writeFileBatch).toHaveBeenCalledTimes(1);

      // The user clicks "Open in Obsidian" again mid-push, which re-tracks the
      // file. That must not leave the entry permanently marked as syncing.
      await mirror.mirrorRemoteArtifactForObsidian(TRACKED);
      settlePush(writeOk());
      await flush();

      // A further local edit still has to reach the worker.
      mirrorFs.readObsidianMirrorFile.mockResolvedValue({
        exists: true,
        content: "edit-two",
      });
      await tick();

      expect(client.writeFileBatch).toHaveBeenCalledTimes(2);
    });
  });
});

describe("readCandidatesViaSession", () => {
  test("returns the first candidate that reads successfully", async () => {
    const client = makeClient();
    client.readFileBatch
      .mockResolvedValueOnce({ items: [readErr("file_not_found")] })
      .mockResolvedValueOnce({ items: [readOk("second")] });

    await run(makeDeps(client), async (mirror) => {
      const hit = await mirror.readCandidatesViaSession(["a.md", "b.md"]);
      expect(hit?.contentBase64).toBe(b64("second"));
    });
  });

  test("returns null when every candidate is missing", async () => {
    const client = makeClient();
    client.readFileBatch.mockResolvedValue({
      items: [readErr("file_not_found")],
    });

    await run(makeDeps(client), async (mirror) => {
      expect(await mirror.readCandidatesViaSession(["a.md"])).toBeNull();
    });
  });

  test("returns null when no server client is connected", async () => {
    const client = makeClient();
    await run(makeDeps(client, { serverClient: () => null }), async (mirror) => {
      expect(await mirror.readCandidatesViaSession(["a.md"])).toBeNull();
      expect(client.readFileBatch).not.toHaveBeenCalled();
    });
  });
});
