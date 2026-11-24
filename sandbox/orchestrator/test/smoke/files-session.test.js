import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../../scripts/files-session.mjs", import.meta.url));

describe("orchestrator files-session smoke", () => {
  test("files-session.mjs completes without error", async () => {
    const child = spawn("node", [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));

    const [code] = await once(child, "exit");
    expect({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }).toMatchObject({ code: 0 });
  }, 120_000);
});
