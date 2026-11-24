/**
 * Turning a composer draft into the parts sent to OpenCode: prompt text, file
 * references, and the synthetic context the intent
 * classifier hands off with.
 *
 * File paths must resolve inside the container, so the builders take the
 * SDK-bound workspace directory as a getter and read it at call time, exactly
 * as they did when they lived in `App()`.
 */
import type {
  Agent,
  TextPartInput,
  FilePartInput,
  SubtaskPartInput,
} from "@opencode-ai/sdk/v2/client";
import type { ComposerDraft, ComposerPart } from "~/shared/types/composer";
import type { IntentClassificationResult } from "./lib/openwork-server";

export type PartInput = TextPartInput | FilePartInput | SubtaskPartInput;

// `root` is the SDK-bound directory: selected-file paths are read by opencode in
// the container, so the prefix must be a path opencode can resolve.
const toAbsolutePath = (path: string, root: string) => {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) return trimmed;
  // Windows absolute path, e.g. C:\foo\bar or C:/foo/bar
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed;
  // Without a workspace root, we cannot safely resolve relative paths.
  // Returning "" avoids naming an invalid path.
  if (!root) return "";
  return (root + "/" + trimmed).replace("//", "/");
};

/** A Windows root joined to a relative path has mixed slashes; text gets backslashes. */
const hostPath = (absolute: string) =>
  /^[a-zA-Z]:[\\/]/.test(absolute) ? absolute.replace(/\//g, "\\") : absolute;

/** Comparison key for an annotation's path; only a Windows path is case-insensitive. */
const samePath = (path: string) => {
  const key = path.trim().replace(/\\/g, "/");
  return /^[a-zA-Z]:\//.test(key) ? key.toLowerCase() : key;
};

const SELECTED_WORKSPACE_SPAN = /^\[Selected (?:file|folder): .+\]$/;

// The closing `]` is the first one followed by whitespace or the end, so `a[1].txt` survives.
const SELECTED_FILE_SPAN = /\[Selected file: ([^\r\n]+?)\](?=\s|$|\[Selected (?:file|folder):)/g;
const SELECTED_ITEM_SPAN = /\[Selected (?:file|folder): ([^\r\n]+?)\](?=\s|$|\[Selected (?:file|folder):)/g;

export const buildPromptParts = async (
  draft: ComposerDraft,
  workspaceSdkDir: () => string,
): Promise<PartInput[]> => {
  const parts: PartInput[] = [];
  const text = draft.resolvedText ?? draft.text;
  parts.push({ type: "text", text } as TextPartInput);
  const hasStructuredInlineParts = draft.parts.some(
    (part) =>
      part.type === "agent" || part.type === "file" || part.type === "paste",
  );
  const alreadySelected = new Set(
    draft.parts.flatMap((part) =>
      part.type === "text"
        ? Array.from(part.text.matchAll(SELECTED_FILE_SPAN), (match) => samePath(match[1]))
        : [],
    ),
  );
  // An item added from a pasted path is named by its chip and also selected in Files.
  const namedInText = new Set(
    Array.from(text.matchAll(SELECTED_ITEM_SPAN), (match) => samePath(match[1])),
  );
  const isRepeatedSelection = (value: string) => {
    const match = value.replace(/\u00a0/g, " ").trim().match(/^\[Selected (?:file|folder): (.+)\]$/);
    return Boolean(match && namedInText.has(samePath(match[1])));
  };

  const root = workspaceSdkDir();

  let skippedMainText = false;
  for (let index = 0; index < draft.parts.length; index += 1) {
    const part = draft.parts[index];
    if (part.type === "agent") {
      // Agent mentions are already serialized into `draft.resolvedText`.
      // Forwarding them as separate agent parts duplicates `@Agent` in the
      // rendered user message (text + trailing agent mention).
      continue;
    }
    if (part.type === "text") {
      const normalizedPartText = part.text.replace(/\u00a0/g, " ");
      const trimmedPartText = normalizedPartText.trim();
      const isSelectedWorkspaceSpan =
        SELECTED_WORKSPACE_SPAN.test(trimmedPartText);
      const nextPart = draft.parts[index + 1];
      const isSpacerBeforeSelectedSpan =
        trimmedPartText.length === 0 &&
        nextPart?.type === "text" &&
        SELECTED_WORKSPACE_SPAN.test(
          (nextPart.text ?? "").replace(/\u00a0/g, " ").trim(),
        );
      if (
        isRepeatedSelection(part.text) ||
        (isSpacerBeforeSelectedSpan && isRepeatedSelection(nextPart.text ?? ""))
      ) {
        continue;
      }

      if (
        hasStructuredInlineParts &&
        !isSelectedWorkspaceSpan &&
        !isSpacerBeforeSelectedSpan
      ) {
        // The leading `text` part already contains the rendered inline
        // mention/file/paste content. Appending raw text segments again
        // duplicates user content for @agent mention flows.
        continue;
      }
      // The first text part from the composer duplicates draft.text which
      // is already emitted above — skip it to avoid sending twice.
      // Normalize \u00a0 defensively in case any part slips through without normalization.
      if (!skippedMainText && normalizedPartText === text) {
        skippedMainText = true;
        continue;
      }
      // Extra text parts (e.g. extracted PDF/DOCX content) — forwarded
      // to the API as additional text parts without altering the main
      // draft.text so the chat bubble only shows the user's message.
      parts.push({ type: "text", text: part.text } as TextPartInput);
      continue;
    }
    if (part.type === "file") {
      // Never a file:// part: OpenCode inlines it before file protection can mask it (#3980).
      // The mention in the text is relative, and a chat bound with `/cd` resolves
      // it against its subdirectory rather than the workspace root. Not synthetic:
      // the profiles' selected-file plugins read only the user's own text.
      const absolute = hostPath(toAbsolutePath(part.path, root));
      if (absolute && !alreadySelected.has(samePath(absolute))) {
        parts.push({ type: "text", text: `[Selected file: ${absolute}]` } as TextPartInput);
      }
    }
  }

  return parts;
};

export const buildClassifierText = (draft: ComposerDraft, fallbackText: string) => {
  const textParts = draft.parts
    .filter(
      (part): part is Extract<ComposerPart, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text.replace(/\u00a0/g, " ").trim())
    .filter(Boolean);
  if (textParts.length === 0) return fallbackText;
  const mainText = (draft.resolvedText ?? draft.text).trim();
  const merged = textParts.join("\n").trim();
  return merged || mainText || fallbackText;
};

/** The agent a leading `@name` in `text` selects, among `names`. */
export const matchLeadingMentionAgent = (
  text: string,
  names: readonly string[],
): string | null => {
  const mergedText = text.trimStart();
  if (!mergedText.startsWith("@")) return null;

  const sorted = names
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const name of sorted) {
    const prefix = `@${name}`;
    if (!mergedText.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    const boundary = mergedText[prefix.length];
    if (boundary && !/[\s,.:;!?)}\]]/.test(boundary)) continue;
    return name;
  }

  return null;
};

export const resolveLeadingMentionAgent = async (
  draft: ComposerDraft,
  listAgents: () => Promise<Agent[]>,
): Promise<string | null> => {
  const mergedText = draft.resolvedText ?? draft.text;
  if (!mergedText.trimStart().startsWith("@")) return null;
  const allAgents = await listAgents();
  return matchLeadingMentionAgent(mergedText, allAgents.map((agent) => agent.name));
};

/**
 * An ambiguous turn the classifier intercepted before it reached OpenCode:
 * its own text, plus whatever else rode on it (a file selection, an extracted
 * PDF excerpt) that isn't part of that text and would otherwise vanish when
 * the turn never got dispatched. `extraParts` already excludes the draft's
 * main text part, is built once at interception time, and is replayed as-is.
 */
export type AmbiguousPromptEntry = {
  text: string;
  extraParts: ComposerPart[];
};

/**
 * A turn's file selection, detached from the rest of it: a
 * `[Selected file: ...]`/`[Selected folder: ...]` annotation already in
 * `draft.parts`, or a raw workspace-panel `file` part normalized to the same
 * annotation (so it can't flip on `buildPromptParts`'s `hasStructuredInlineParts`
 * branch later). Used to carry a turn's file selection forward when the
 * classifier intercepts it as ambiguous -- see `prependAmbiguousPromptContext`.
 *
 * Deliberately narrow: an extra text part that isn't a selection annotation
 * (e.g. extracted PDF/DOCX content) is left out, same as before this existed.
 * Carrying those forward too would replay unbounded amounts of text on every
 * clarifying turn until the classifier finally routes, for content the HDR
 * gate this exists for never looked at in the first place.
 */
export const collectAmbiguousExtraParts = (
  draft: ComposerDraft,
  root: string,
): ComposerPart[] => {
  const extra: ComposerPart[] = [];
  for (const part of draft.parts) {
    if (part.type === "text") {
      const normalized = part.text.replace(/\u00a0/g, " ").trim();
      if (SELECTED_WORKSPACE_SPAN.test(normalized)) {
        extra.push(part);
      }
      continue;
    }
    if (part.type === "file") {
      const absolute = hostPath(toAbsolutePath(part.path, root));
      if (absolute) {
        extra.push({ type: "text", text: `[Selected file: ${absolute}]` });
      }
      continue;
    }
    // "agent" is already serialized into resolvedText; "paste" is already
    // expanded into it too -- neither carries a file selection of its own.
  }
  return extra;
};

export const prependAmbiguousPromptContext = (
  draft: ComposerDraft,
  priorPrompts: AmbiguousPromptEntry[],
): ComposerDraft => {
  const previous = priorPrompts.map((entry) => entry.text.trim()).filter(Boolean);
  const carriedParts = priorPrompts.flatMap((entry) => entry.extraParts);
  if (!previous.length && !carriedParts.length) return draft;
  const originalText = draft.resolvedText ?? draft.text;
  const contextualText = previous.length
    ? `${previous.join("\n")}\n${originalText}`
    : originalText;
  let replacedMainTextPart = false;
  const parts = draft.parts.map((part) => {
    if (!replacedMainTextPart && part.type === "text") {
      const normalized = part.text.replace(/\u00a0/g, " ");
      if (normalized === originalText || normalized === draft.text) {
        replacedMainTextPart = true;
        return { ...part, text: contextualText };
      }
    }
    return part;
  });
  return {
    ...draft,
    text: contextualText,
    resolvedText: contextualText,
    // Main text part keeps its conventional lead position; carried parts
    // (e.g. a selected file) trail it, same as `buildPromptParts` already
    // orders its own output.
    parts: [...parts, ...carriedParts],
  };
};

export const mapClassifierAgentToRuntimeAgent = (
  agent: string | null,
): string | null => {
  if (agent === "general-task-agent") return "superclaw-default";
  return agent;
};

export const buildHandoffSummaryPart = (
  handoffSummary: IntentClassificationResult["handoff_summary"],
  runtimeAgent: string,
): TextPartInput | null => {
  if (!handoffSummary) return null;
  const summaryLines = [
    `Handoff target: ${runtimeAgent}`,
    `Routing reason: ${handoffSummary.routing_reason}`,
    `Task type: ${handoffSummary.task_type}`,
    `Clarity state: ${handoffSummary.clarity_state}`,
    `User goal: ${handoffSummary.user_goal}`,
  ];
  if (handoffSummary.confirmed_facts.length) {
    summaryLines.push(
      `Confirmed facts: ${handoffSummary.confirmed_facts.join("; ")}`,
    );
  }
  if (handoffSummary.open_questions.length) {
    summaryLines.push(
      `Open questions: ${handoffSummary.open_questions.join("; ")}`,
    );
  }
  if (handoffSummary.transcript_window.length) {
    const transcript = handoffSummary.transcript_window
      .map((turn) => `${turn.role}: ${turn.content}`)
      .join("\n");
    summaryLines.push(`Recent transcript:\n${transcript}`);
  }
  // Sent to the agent as backend-only context — marked `synthetic` so the
  // chat UI hides it from normal users (still visible in developer mode),
  // same convention already used for extracted PDF/DOCX text parts.
  return {
    type: "text",
    text: summaryLines.join("\n"),
    synthetic: true,
  } as TextPartInput;
};

/** Absolute paths of a command's selected files. A command has no text parts,
 * so the caller names them itself; never file:// parts (#3980). */
export const buildCommandFileParts = async (
  draft: ComposerDraft,
  workspaceSdkDir: () => string,
): Promise<{ textOnly: string[] }> => {
  const textOnly: string[] = [];
  const root = workspaceSdkDir();
  const add = (path: string) => {
    // An @-mention of a file also selected in Files would name it twice.
    const absolute = hostPath(toAbsolutePath(path, root));
    if (absolute && !textOnly.some((seen) => samePath(seen) === samePath(absolute))) {
      textOnly.push(absolute);
    }
  };

  for (const part of draft.parts) {
    if (part.type === "file") {
      add(part.path);
      continue;
    }
    // Also extract workspace-panel file selections injected as text mentions.
    if (part.type === "text") {
      const text = (part as { text?: string }).text ?? "";
      const match = text.match(/^\[Selected file: (.+)\]$/);
      if (match) add(match[1]);
    }
  }

  return { textOnly };
};
