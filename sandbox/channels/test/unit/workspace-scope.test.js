import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";

import { isWithinRoot } from "../../dist/workspace-scope.js";

const winRoot = "C:\\Users\\Me\\Workspace";

test("win32: a stored lowercased subdirectory binding stays inside the original-case root", () => {
  // `/cd sub` stores normalizeDirectory(resolved), which is lowercased with forward slashes on win32.
  assert.equal(isWithinRoot(winRoot, "c:/users/me/workspace/sub", path.win32), true);
  assert.equal(isWithinRoot(winRoot, "c:/users/me/workspace/sub/deeper", path.win32), true);
  assert.equal(isWithinRoot(winRoot, "c:/users/me/workspace", path.win32), true);
  assert.equal(isWithinRoot(winRoot, "C:\\Users\\Me\\Workspace\\Sub", path.win32), true);
});

test("win32: case folding does not widen the boundary", () => {
  assert.equal(isWithinRoot(winRoot, "c:/users/me/workspace-evil", path.win32), false);
  assert.equal(isWithinRoot(winRoot, "C:\\Users\\Me", path.win32), false);
  assert.equal(isWithinRoot(winRoot, "C:\\Users\\Me\\Workspace\\..\\Other", path.win32), false);
  assert.equal(isWithinRoot(winRoot, "D:\\Users\\Me\\Workspace\\sub", path.win32), false);
});

test("posix: containment stays case-sensitive", () => {
  assert.equal(isWithinRoot("/home/me/ws", "/home/me/ws/sub", path.posix), true);
  assert.equal(isWithinRoot("/home/me/ws", "/home/me/WS/sub", path.posix), false);
  assert.equal(isWithinRoot("/home/me/ws", "/home/me/ws-evil", path.posix), false);
  assert.equal(isWithinRoot("/home/me/ws", "/home/me/ws/../other", path.posix), false);
});
