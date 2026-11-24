export type InstanceApiStatus = "connected" | "disconnected" | "limited";

export type InstanceApiCapabilities = {
  mcp?: {
    read?: boolean;
    write?: boolean;
  };
};
