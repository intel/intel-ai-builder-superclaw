/**
 * Public surface of the `egress-approvals` slice. Everything outside imports from here, never
 * from a module inside it — that is what lets the modules behind this file be renamed,
 * split or merged without touching an importer.
 */

export {
  PROXY_UNLISTED_ACTION,
  approvalChoices,
  liveApprovals,
  secondsLeft,
  type ApprovalChoice,
} from "./egress-approvals";
export { useEgressApprovals, type EgressApprovals } from "./useEgressApprovals";
export { default as ChatWebAccessSwitch } from "./chat-web-access-switch";
export type { ChatWebAccess } from "./useChatWebAccess";
export { useEgressFeatures } from "./useEgressFeatures";
