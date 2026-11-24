import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Two suites scan the whole tracked tree or enumerate large tables (~1 s alone each) and
    // exceeded the 5 s default when every file runs in parallel on a dev machine.
    testTimeout: 30_000,
  },
});
