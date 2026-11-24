import assert from "node:assert/strict";
import { test } from "bun:test";

import { createMemoryStore } from "./memory-store.js";

test("BridgeStore allowlist and sessions", () => {
  const store = createMemoryStore();

  assert.equal(store.isAllowed("telegram", "123"), false);
  store.allowPeer("telegram", "123");
  assert.equal(store.isAllowed("telegram", "123"), true);

  store.upsertSession("telegram", "default", "123", "session-1", undefined, "inherit");
  const row = store.getSession("telegram", "default", "123");
  assert.equal(row?.session_id, "session-1");
  assert.equal(row?.permission_mode, "inherit");

  store.upsertBinding("slack", "app-1", "D123", "/tmp/ws");
  const binding = store.getBinding("slack", "app-1", "D123");
  assert.equal(binding?.directory, "/tmp/ws");

  store.close();
});
