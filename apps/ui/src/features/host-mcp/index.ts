/**
 * Public surface of the `host-mcp` slice. Everything outside imports from here, never from a module
 * inside it.
 */

export { useHostMcp, useHostMcpApprovals, type HostMcp, type HostMcpApprovals } from "./useHostMcp";
export { default as HostMcpApprovalDialog } from "./host-mcp-approval-dialog";
export { HostMcpInfobar, HostMcpProvider } from "./host-mcp-stop-banner";
export { default as HostMcpEarlyWake } from "./host-mcp-early-wake";
