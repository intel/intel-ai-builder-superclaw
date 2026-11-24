import { spawn, type ChildProcess } from "node:child_process";

export function buildTrajectoryCommand(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "bun", "run", "src/main.ts"] };
  }
  return { command: "bun", args: ["run", "src/main.ts"] };
}

export function buildTrajectoryEnv(
  token: string | null,
  noProxy: string,
  port: number,
  shutdownToken: string,
): NodeJS.ProcessEnv {
  const {
    TRAJECTORY_TOKEN: _trajectoryToken,
    TRAJECTORY_INITIAL_TOKEN: _trajectoryInitialToken,
    TRAJECTORY_SHUTDOWN_TOKEN: _trajectoryShutdownToken,
    ...baseEnv
  } = process.env;

  return {
    ...baseEnv,
    PORT: String(port),
    TRAJECTORY_NO_OPEN: "1",
    TRAJECTORY_SHUTDOWN_TOKEN: shutdownToken,
    ...(token ? { TRAJECTORY_INITIAL_TOKEN: token } : {}),
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

export function stopTrajectoryProcess(child: ChildProcess): void {
  if (child.killed) return;

  if (process.platform === "win32" && typeof child.pid === "number") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  child.kill();
}
