// Compile-time constant injected by Vite `define` (see vite.config.ts).
// true  → debug observability UI (trajectory, runtime panel, bug report) is included.
// false → debug UI is tree-shaken out of the bundle.
declare const __BUILD_DEBUG__: boolean;

// true when built with SUPERCLAW_OTA_TEST_CHANNEL=1: a QA-only build whose OTA
// check accepts http loopback installer URLs, matching the Rust shell's flag.
declare const __OTA_TEST_CHANNEL__: boolean;
