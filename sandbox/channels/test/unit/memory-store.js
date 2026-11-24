import { BridgeStore } from "../../dist/db.js";

// A real BridgeStore on an in-memory SQLite database, for tests of bridge behaviour rather
// than persistence. A file-backed store commits with an fsync, which blocks the thread for
// seconds on a busy CI disk and used to push these tests past their timeout (#3098).
//
// Two overrides: ensureDir does nothing because there is no directory to create (Bun on
// Windows throws EEXIST for mkdirSync(".")), and close does nothing so one store can outlive
// the bridge whose stop() closes it.
class MemoryBridgeStore extends BridgeStore {
  ensureDir() {}

  close() {}
}

export function createMemoryStore() {
  return new MemoryBridgeStore(":memory:");
}
