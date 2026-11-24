// The per-run state the bridge threads through status reporting, tool updates
// and completion.
//
// It lives in its own module so run-status.ts and bridge.ts can share it without
// importing each other.

import type { ChannelName } from "./config.js";

export type RunState = {
  key: string;
  directory: string;
  sessionID: string;
  channel: ChannelName;
  identityId: string;
  adapterKey: string;
  peerId: string;
  peerKey: string;
  toolUpdatesEnabled: boolean;
  seenToolStates: Map<string, string>;
  thinkingLabel?: string;
  thinkingActive?: boolean;
  nativeStatusEligible?: boolean;
  nativeStatusActive?: boolean;
  // True once a native shimmer has been shown this run. Stays true even after a
  // mid-run demotion (emitStatus setStatus failure) so completion clearing can
  // authoritatively remove a lingering shimmer. (D)
  nativeStatusShown?: boolean;
  completed?: boolean;
};
