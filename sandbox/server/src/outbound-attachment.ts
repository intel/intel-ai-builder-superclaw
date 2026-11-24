// The outbox opening: the one way a workspace file reaches the channel tier (EG2-6).
//
// The router runs in a tier that cannot see the workspace, so a file the agent wants delivered is copied
// into the outbox by this process (file_tool, which can read the workspace and write the outbox), and the
// router is told only the copy's name.

import { randomBytes } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import { ApiError } from "./errors.js";

// O_NOFOLLOW is undefined on Windows, where the post-open identity and realpath checks below carry the load.
const openReadOnly = (path: string): Promise<FileHandle> =>
  open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));

export async function stageOutboundFile(input: {
  workspacePath: string;
  file: string;
  outboxDir: string | undefined;
  /** Test seam: how the validated source is opened. */
  openSource?: (path: string) => Promise<FileHandle>;
}): Promise<string> {
  if (!input.outboxDir) {
    throw new ApiError(503, "outbox_unavailable", "No channel outbox is configured, so a file cannot be sent");
  }
  const workspace = await realpath(resolve(input.workspacePath));
  const candidate = resolve(workspace, input.file);
  let source: string;
  try {
    source = await realpath(candidate);
  } catch {
    // A missing target and a traversal toward a missing target are told apart by the containment test.
    if (candidate !== workspace && !candidate.startsWith(workspace + sep)) {
      throw new ApiError(400, "invalid_path", "File must be inside the workspace");
    }
    throw new ApiError(404, "file_not_found", "File not found");
  }
  if (!source.startsWith(workspace + sep)) {
    throw new ApiError(400, "invalid_path", "File must be inside the workspace");
  }
  const validated = await stat(source, { bigint: true });
  if (!validated.isFile()) {
    throw new ApiError(400, "invalid_path", "Path must point to a file");
  }
  // Open once and copy from the handle: reopening by path would let a concurrent workspace writer swap in
  // a link between the check and the copy.
  let handle: FileHandle;
  try {
    handle = await (input.openSource ?? openReadOnly)(source);
  } catch {
    throw new ApiError(400, "invalid_path", "File could not be opened");
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const sameFile = opened.isFile() && opened.dev === validated.dev && opened.ino === validated.ino;
    const stillInside = (await realpath(source).catch(() => "")) === source;
    if (!sameFile || !stillInside) {
      throw new ApiError(400, "invalid_path", "File changed while being staged");
    }
    const name = `${randomBytes(4).toString("hex")}-${basename(source)}`;
    await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(join(input.outboxDir, name), { flags: "wx" }));
    return name;
  } finally {
    await handle.close();
  }
}
