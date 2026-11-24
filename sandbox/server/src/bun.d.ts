declare const Bun: {
  serve: (options: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }) => {
    port: number;
  };
  spawn: (
    cmd: string[],
    options?: {
      cwd?: string;
      // A Uint8Array stdin feeds bytes straight to the child, which is how a
      // secret reaches `gh auth login --with-token` without passing through
      // argv (visible in /proc) or a temp file.
      stdin?: "pipe" | "inherit" | "ignore" | Uint8Array;
      stdout?: "pipe" | "inherit" | "ignore";
      stderr?: "pipe" | "inherit" | "ignore";
      env?: Record<string, string>;
      windowsHide?: boolean;
    }
  ) => {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  };
};
