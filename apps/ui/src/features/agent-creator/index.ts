/**
 * Public surface of the `agent-creator` slice. Everything outside imports from here, never
 * from a module inside it — that is what lets the modules behind this file be renamed,
 * split or merged without touching an importer.
 */

export { default as AgentCreatorView } from "./agent-creator";
export type { AgentFormData, AgentInfo } from "./agent-creator.types";
export { ensureAgentMarkdownMode, generateAgentMarkdown } from "./agent-creator-markdown";
