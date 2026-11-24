import { spawnSync } from "node:child_process";

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const run = (args, env = process.env) => {
    const result = spawnSync(pnpmCmd, args, {
        stdio: "inherit",
        shell: process.platform === "win32",
        env,
    });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
};

const isDebug =
(process.env.TAURI_ENV_DEBUG || "").trim().toLowerCase() === "true" ||
(process.env.TAURI_ENV_DEBUG || "").trim() === "1";

console.log(
  `[openwork] tauri before build mode: ${isDebug ? "debug" : "release"} (TAURI_ENV_DEBUG=${process.env.TAURI_ENV_DEBUG ?? ""})`
);
// Inherited unchanged by both UI builds below (only BUILD_DEBUG is stripped for
// release), so a QA release build's UI matches its Rust shell.
if (process.env.SUPERCLAW_OTA_TEST_CHANNEL === "1") {
    console.log("[openwork] OTA test channel ON (SUPERCLAW_OTA_TEST_CHANNEL=1): QA-only build, never publish");
}

run(["-C", "../..", "--filter", "@different-ai/openwork-contracts", "run", "build"]);

run(["-C", "../..", "--filter", "@different-ai/openwork", "run", "prepare:sidecar"]);

if (isDebug) {
    run(["-C", "../..", "--filter", "@different-ai/openwork-ui", "run", "build:debug"]);
} 

else {
    const releaseEnv = { ...process.env };
    delete releaseEnv.BUILD_DEBUG;
    run(["-C", "../..", "build:ui"], releaseEnv);
}