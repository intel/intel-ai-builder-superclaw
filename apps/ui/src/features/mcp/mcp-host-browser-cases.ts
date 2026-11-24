/**
 * Commands and whether "Use SuperClaw browser" may convert them, written out rather than computed.
 * `offered` is both the UI's answer (`isPlaywrightMcpCommand`) and openwork-server's answer
 * (`isHostBrowserRelayMcp`) for the converted command, so the two predicates are checked against
 * one table. `converted` is the argv the conversion saves, with `HOST_BROWSER_CASE_CDP` appended.
 */
export const HOST_BROWSER_CASE_CDP = `ws://127.0.0.1:18831/mcp-host/cdp/${"A".repeat(43)}`;

export type HostBrowserCase = {
  name: string;
  command: string[];
  environment?: Record<string, string>;
  offered: boolean;
  converted?: string[];
};

const relay = ["--cdp-endpoint", HOST_BROWSER_CASE_CDP, "--isolated"];

export const HOST_BROWSER_CASES: readonly HostBrowserCase[] = [
  { name: "npx -y with a version", command: ["npx", "-y", "@playwright/mcp@latest"], offered: true,
    converted: ["npx", "-y", "@playwright/mcp@latest", ...relay] },
  { name: "npx --yes", command: ["npx", "--yes", "@playwright/mcp"], offered: true,
    converted: ["npx", "--yes", "@playwright/mcp", ...relay] },
  { name: "npx.cmd, case-insensitive package", command: ["npx.cmd", "@Playwright/MCP@0.0.41"], offered: true,
    converted: ["npx.cmd", "@Playwright/MCP@0.0.41", ...relay] },
  { name: "bunx --bun", command: ["bunx", "--bun", "@playwright/mcp"], offered: true,
    converted: ["bunx", "--bun", "@playwright/mcp", ...relay] },
  { name: "pnpm dlx", command: ["pnpm", "dlx", "@playwright/mcp"], offered: true,
    converted: ["pnpm", "dlx", "@playwright/mcp", ...relay] },
  { name: "node and its cli.js", command: ["node", String.raw`C:\p\node_modules\@playwright\mcp\cli.js`], offered: true,
    converted: ["node", String.raw`C:\p\node_modules\@playwright\mcp\cli.js`, ...relay] },
  { name: "its published bin", command: [String.raw`C:\p\node_modules\.bin\playwright-mcp.cmd`, "--caps=vision"], offered: true,
    converted: [String.raw`C:\p\node_modules\.bin\playwright-mcp.cmd`, "--caps=vision", ...relay] },
  { name: "--isolated, in any spelling, is replaced by the bare switch once",
    command: ["npx", "@playwright/mcp", "--isolated", "--isolated=false"], offered: true,
    converted: ["npx", "@playwright/mcp", ...relay] },
  { name: "--headless and --extension are removed", command: ["npx", "@playwright/mcp", "--headless", "--extension"], offered: true,
    converted: ["npx", "@playwright/mcp", ...relay] },
  { name: "--browser and --cdp-endpoint, both spellings, are replaced",
    command: ["npx", "@playwright/mcp", "--browser", "chrome", "--cdp-endpoint=http://localhost:9222", "--caps=vision",
      "--browser=msedge", "--cdp-endpoint", "ws://127.0.0.1:9222/x", "--viewport-size", "1280,720"],
    offered: true,
    converted: ["npx", "@playwright/mcp", "--caps=vision", "--viewport-size", "1280,720", ...relay] },
  { name: "a value flag with no value keeps the next option", command: ["npx", "@playwright/mcp", "--browser", "--caps=vision"],
    offered: true, converted: ["npx", "@playwright/mcp", "--caps=vision", ...relay] },
  { name: "a value flag last, with no value", command: ["npx", "@playwright/mcp", "--cdp-endpoint"], offered: true,
    converted: ["npx", "@playwright/mcp", ...relay] },

  { name: "--config", command: ["npx", "@playwright/mcp", "--config", "pw.json"], offered: false },
  { name: "--config=", command: ["npx", "@playwright/mcp", "--config=pw.json"], offered: false },
  { name: "--endpoint", command: ["npx", "@playwright/mcp", "--endpoint", "http://localhost:1"], offered: false },
  { name: "--user-data-dir", command: ["npx", "@playwright/mcp", "--user-data-dir", String.raw`C:\Profile`], offered: false },
  { name: "--executable-path=", command: ["npx", "@playwright/mcp", "--executable-path=C:/chrome.exe"], offered: false },
  { name: "--no-sandbox", command: ["npx", "@playwright/mcp", "--no-sandbox"], offered: false },
  { name: "an option the server does not know", command: ["npx", "@playwright/mcp", "--future-flag"], offered: false },
  { name: "a launcher option before the package", command: ["npx", "-p", "x", "@playwright/mcp"], offered: false },
  { name: "a shell in front", command: ["cmd", "/c", "npx", "@playwright/mcp"], offered: false },
  { name: "another browser tool alongside", command: ["npx", "@playwright/mcp", "chrome-devtools-mcp"], offered: false },
  { name: "another browser tool", command: ["npx", "chrome-devtools-mcp"], offered: false },
  { name: "another Playwright server", command: ["npx", "@executeautomation/playwright-mcp-server"], offered: false },
  { name: "a lookalike package", command: ["npx", "@playwright/mcp-extra"], offered: false },
  { name: "not a browser tool", command: ["uvx", "windows-mcp"], offered: false },
  { name: "a browser source in the environment", command: ["npx", "@playwright/mcp"],
    environment: { PLAYWRIGHT_MCP_EXTENSION: "1" }, offered: false },
  { name: "isolated mode set in the environment", command: ["npx", "@playwright/mcp"],
    environment: { PLAYWRIGHT_MCP_ISOLATED: "false" }, offered: false },
  // The relay refuses what these make Playwright send, or @playwright/mcp exits with a CDP endpoint.
  { name: "--proxy-server", command: ["npx", "@playwright/mcp", "--proxy-server", "http://127.0.0.1:9"], offered: false },
  { name: "--grant-permissions", command: ["npx", "@playwright/mcp", "--grant-permissions=geolocation"], offered: false },
  { name: "--storage-state", command: ["npx", "@playwright/mcp", "--storage-state", "state.json"], offered: false },
  { name: "--device", command: ["npx", "@playwright/mcp", "--device", "Pixel 7"], offered: false },
  { name: "--mobile", command: ["npx", "@playwright/mcp", "--mobile"], offered: false },
  { name: "a proxy in the environment", command: ["npx", "@playwright/mcp"],
    environment: { PLAYWRIGHT_MCP_PROXY_SERVER: "http://127.0.0.1:9" }, offered: false },
  { name: "options that act only on its own context are kept",
    command: ["npx", "@playwright/mcp", "--user-agent", "x", "--ignore-https-errors", "--init-script", "a.js", "--save-session"],
    offered: true,
    converted: ["npx", "@playwright/mcp", "--user-agent", "x", "--ignore-https-errors", "--init-script", "a.js", "--save-session", ...relay] },
];
