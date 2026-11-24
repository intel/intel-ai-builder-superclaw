export type PromptMode = "prompt" | "shell";

export type ComposerPart =
  | { type: "text"; text: string }
  | { type: "agent"; name: string }
  | { type: "file"; path: string; label?: string }
  | { type: "paste"; id: string; label: string; text: string; lines: number };

export type ComposerAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  file: File;
  previewUrl?: string;
};

export type SlashCommandOption = {
  id: string;
  name: string;
  description?: string;
  source?: "command" | "mcp" | "skill";
  dispatch?: "command" | "prompt";
};

export type ComposerDraft = {
  mode: PromptMode;
  parts: ComposerPart[];
  attachments: ComposerAttachment[];
  /** Editor-visible text (may include collapsed paste placeholders). */
  text: string;
  /**
   * Resolved text to send to the model.
   * When a paste is collapsed into a placeholder (e.g. "[pasted text 1]"),
   * this includes the full pasted text instead.
   */
  resolvedText?: string;
  /** When set, draft is a slash command invocation */
  command?: { name: string; arguments: string; dispatch?: "command" | "prompt" } | undefined;
};
