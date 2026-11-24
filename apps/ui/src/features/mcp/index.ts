/**
 * Public surface of the `mcp` slice. Everything outside imports from here, never from
 * a module inside it — that is what lets the modules behind this file be renamed,
 * split or merged without touching an importer.
 */

export { default as McpView, type McpViewProps } from "./mcp-view";
export { default as McpAuthModal } from "./mcp-auth-modal";
export { useMcpServers } from "./useMcpServers";
