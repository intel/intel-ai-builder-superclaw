/**
 * The draft entries of the egress allowlist. The shape and the rules are in `egress-allowlist.ts`;
 * the reasons and the open questions for the reviewer are in `docs/egress-allowlist-review.md`.
 *
 * Ports are 443 throughout: enforce tunnels no other port (`egress_proxy` `_ALLOWED_PORT`).
 */

import type { EgressAllowlist } from "./egress-allowlist.js";

export const EGRESS_ALLOWLIST: EgressAllowlist = {
  contract_version: 1,
  entries: [
    // file_tool through the proxy's shell port.
    {
      id: "shell_github",
      tier: "file_tool",
      carrier: "egress_proxy_shell",
      hosts: ["github.com", "api.github.com"],
      ports: [443],
      surfaces: ["openwork_github_device_flow", "openwork_github_cli", "agent_shell"],
      source: "observed_in_audit",
      status: "draft",
      reason: "GitHub sign-in (device flow, gh CLI) and git over HTTPS; both hosts appear in the shell audit.",
    },
    {
      id: "shell_skill_hub",
      tier: "file_tool",
      carrier: "egress_proxy_shell",
      hosts: ["api.github.com", "raw.githubusercontent.com"],
      ports: [443],
      surfaces: ["openwork_skill_hub"],
      source: "required_by_inventory",
      status: "draft",
      reason: "The skill marketplace catalog and skill files.",
    },
    {
      id: "shell_google_apis",
      tier: "file_tool",
      carrier: "egress_proxy_shell",
      hosts: ["gmail.googleapis.com", "www.googleapis.com", "oauth2.googleapis.com", "people.googleapis.com"],
      ports: [443],
      surfaces: ["gmail_google_apis", "gmail_oauth_token_exchange", "gmail_api_setup_check"],
      source: "required_by_inventory",
      status: "draft",
      reason:
        "The pro Gmail tools, the OAuth callback and the setup guide's API check. The inventory moves these to the Connector at GA.",
    },
    {
      id: "shell_package_registries",
      tier: "file_tool",
      carrier: "egress_proxy_shell",
      hosts: ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org"],
      ports: [443],
      surfaces: ["agent_shell"],
      source: "observed_in_audit",
      status: "draft",
      reason: "pip, uv and npm installs, including the first-run npx and uvx downloads at start-up.",
    },
    // One-click local MCP servers (apps/ui MCP catalog). OpenCode starts them with no per-chat proxy
    // credential, so an unlisted host could only be allowed once per connection (#3788).
    {
      id: "shell_mcp_perplexity",
      tier: "file_tool",
      carrier: "egress_proxy_shell",
      hosts: ["api.perplexity.ai"],
      ports: [443],
      surfaces: ["opencode_local_mcp"],
      source: "product_decision",
      status: "draft",
      reason: "The one-click Perplexity MCP server (@perplexity-ai/mcp-server) calls its own API.",
    },
    {
      id: "shell_mcp_minimax",
      tier: "file_tool",
      carrier: "egress_proxy_shell",
      hosts: ["api.minimax.io"],
      ports: [443],
      surfaces: ["opencode_local_mcp"],
      source: "product_decision",
      status: "draft",
      reason: "The one-click MiniMax MCP server (minimax-mcp); the catalog pins MINIMAX_API_HOST to this host.",
    },
    {
      id: "shell_mcp_arxiv",
      tier: "file_tool",
      carrier: "egress_proxy_shell",
      hosts: ["export.arxiv.org", "arxiv.org", "api.semanticscholar.org"],
      ports: [443],
      surfaces: ["opencode_local_mcp"],
      source: "product_decision",
      status: "draft",
      reason: "The one-click arXiv MCP server (arxiv-mcp-server): search API, paper downloads, citation graph.",
    },
    // One-click remote MCP servers (apps/ui MCP catalog). OpenCode connects to them, and runs their OAuth
    // token exchange, with no per-chat proxy credential, so an unlisted host could only be allowed once per
    // connection. The OAuth authorize page opens in the user's browser on the host, not through this proxy.
    {
      id: "shell_mcp_remote_catalog",
      tier: "file_tool",
      carrier: "egress_proxy_shell",
      hosts: ["api.githubcopilot.com", "huggingface.co", "mcp.stripe.com", "access.stripe.com"],
      ports: [443],
      surfaces: ["opencode_catalog_remote_mcp"],
      source: "product_decision",
      status: "draft",
      reason:
        "The one-click GitHub, Hugging Face and Stripe remote MCP servers and their OAuth authorization servers; GitHub's token exchange uses github.com, already listed in shell_github.",
    },
    // channel through the proxy's channel port.
    {
      id: "channel_slack",
      tier: "channel",
      carrier: "egress_proxy_channel",
      hosts: ["slack.com", "*.slack.com"],
      ports: [443],
      surfaces: [
        "opencode_router_slack_web_api",
        "opencode_router_slack_socket_mode",
        "opencode_router_slack_proxy_connect",
        "opencode_router_media_download",
      ],
      source: "observed_in_audit",
      status: "draft",
      reason: "Slack Web API, Socket Mode and file downloads; only slack.com appears in the audit so far.",
    },
    {
      id: "channel_telegram",
      tier: "channel",
      carrier: "egress_proxy_channel",
      hosts: ["api.telegram.org"],
      ports: [443],
      surfaces: ["opencode_router_telegram_bot_api", "opencode_router_media_download"],
      source: "required_by_inventory",
      status: "draft",
      reason: "The Telegram Bot API, which also serves files; Telegram has not run in an audited session.",
    },
    // network_connector through the Connector itself.
    {
      id: "connector_tavily",
      tier: "network_connector",
      carrier: "connector",
      hosts: ["api.tavily.com"],
      ports: [443],
      surfaces: ["sc_search_web_tavily_direct", "hdr_tavily_search_direct", "profile_tools_connector"],
      source: "required_by_inventory",
      status: "draft",
      reason: "Web search. The two direct surfaces are off the native path because the Connector makes this call.",
    },
  ],
  categories: [
    {
      id: "shell_caller_chosen",
      tier: "file_tool",
      carrier: "egress_proxy_shell",
      hosts: "caller_chosen",
      unlisted: "approval",
      surfaces: ["agent_shell"],
      status: "draft",
      reason: "curl, pip, npm and git go where the agent points them. Listed hosts pass; the rest asks the user.",
    },
    {
      id: "channel_caller_chosen",
      tier: "channel",
      carrier: "egress_proxy_channel",
      hosts: "caller_chosen",
      unlisted: "refuse",
      surfaces: ["opencode_router_media_download", "opencode_router_slack_proxy_connect"],
      status: "draft",
      reason: "A channel adapter supplies the media URL; a headless caller has nobody to ask, so the rest is refused.",
    },
    {
      id: "connector_fetch_result",
      tier: "network_connector",
      carrier: "connector",
      hosts: "caller_chosen",
      unlisted: "approval",
      surfaces: ["profile_tools_connector"],
      status: "draft",
      reason: "fetch_result for a URL outside the session's list is already held for approval (EG1-7).",
    },
  ],
};
