import assert from "node:assert/strict";
import { test } from "bun:test";

import { getPromptErrorDetails, isMissingSessionPromptError } from "../../dist/opencode.js";

test("getPromptErrorDetails normalizes Error and SDK response bodies", () => {
  const error = Object.assign(new Error("timed out"), { statusCode: 504 });
  assert.deepEqual(getPromptErrorDetails(error), {
    name: "Error",
    message: "timed out",
    status: 504,
  });
  assert.deepEqual(
    getPromptErrorDetails({ name: "NotFoundError", data: { message: "missing", statusCode: 404 } }),
    { name: "NotFoundError", message: "missing", status: 404 },
  );
});

test("isMissingSessionPromptError recognizes SDK and fallback error shapes", () => {
  assert.equal(isMissingSessionPromptError({ name: "NotFoundError", data: { message: "missing" } }), true);
  assert.equal(isMissingSessionPromptError("Session was not found"), true);
  assert.equal(isMissingSessionPromptError(new Error("connection failed")), false);
});
