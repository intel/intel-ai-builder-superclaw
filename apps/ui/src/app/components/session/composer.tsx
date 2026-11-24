import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import {
  ArrowUp,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  Square,
} from "lucide-solid";
import { t } from "../../../i18n";
import type {
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  PromptMode,
} from "../../types";
import { perfNow, recordPerfLog } from "../../lib/perf-log";
import {
  authorizeComposerDroppedFiles,
  readDroppedFile,
  readDroppedImage,
} from "../../lib/tauri";
import { createComposerFolderUpload } from "./composer.folder-upload";
import FolderUploadConfirmModal from "./composer.folder-upload-modal";
import { createComposerMentions } from "./composer.mentions";
import MentionPicker from "./composer.mention-picker";
import { createComposerSlash, readChipFirstParts } from "./composer.slash";
import SlashPicker from "./composer.slash-picker";
import { createVoiceController } from "~/features/voice-input";
import { VoiceFailureBubble, VoiceHintBubble, VoiceMicMissingBubble } from "./voice-hint-bubble";
import { isTauriRuntime } from "../../utils";
import { Tooltip } from "~/shared/ui/tooltip";
import { attachmentSizeLimit, compressImageFile, droppedImageMime, formatLinks, isImageMime, isSupportedAttachmentType, limitImageAttachments, parseClipboardLinks, remainingImageAttachmentSlots } from "./composer.attachments";
import { DRAFT_FLUSH_DEBOUNCE_MS, MIN_DRAFT_FLUSH_DELAY_MS, buildPartsFromEditor, countLines, createMentionSpan, createRecentEmits, draftFromParts, getSelectionOffsets, htmlToPlainText, insertTextWithBreaks, normalizeText, partsToResolvedText, partsToText, readEditorText, restoreSelectionOffsets, sanitizePastedPlainText, textToFragment } from "./composer.editor";
import { type ImageMention, removeImageMention, watchImageMentions } from "./composer.image-mentions";
import { NarrationToggle } from "./narration-toggle";
import { CompactAttachmentChip, ComposerImageCard } from "./attachment-chip";
import { ComposerToast } from "./composer-toast";
import { OutsidePathPopover, createComposerOutsidePaths } from "./composer.outside-path";
import { ComposerAgentPicker } from "./composer-agent-picker";
import { ComposerModelPicker } from "./composer-model-picker";
import type { ComposerProps } from "./composer.types";
import { passEmailSendGates } from "./composer.email-gate";

export default function Composer(props: ComposerProps) {
  let editorRef: HTMLDivElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let uploadPickerRef: HTMLDivElement | undefined;
  let modelPickerRef: HTMLDivElement | undefined;
  let dropZoneRef: HTMLDivElement | undefined;
  let suppressPromptSync = false;
  let pasteCounter = 0;
  let pendingImageAttachmentCount = 0;
  let draftScheduledAt = 0;
  let lastInputAt = 0;
  let lastFlushedText = "";
  let lastFlushedMode: "prompt" | "shell" = "prompt";
  let inputQueryFrame: number | null = null;
  let emptyCheckFrame: number | null = null;
  const pasteTextById = new Map<string, string>();
  const objectUrls = new Set<string>();
  const createObjectUrl = (file: File) => {
    const url = URL.createObjectURL(file);
    objectUrls.add(url);
    return url;
  };
  const releaseObjectUrl = (url?: string) => {
    if (!url) return;
    if (!objectUrls.delete(url)) return;
    URL.revokeObjectURL(url);
  };
  // Track IME composition state so we can combine it with keyCode === 229 to
  // reliably suppress Enter during CJK input across Chrome, Safari, and WebKit.
  let imeComposing = false;
  const [attachments, setAttachments] = createSignal<ComposerAttachment[]>([]);
  const [imageMentions, setImageMentions] = createSignal<ImageMention[]>([]);
  const [draftHasText, setDraftHasText] = createSignal(
    normalizeText(props.prompt).trim().length > 0,
  );
  const [mode, setMode] = createSignal<PromptMode>("prompt");
  const [historySnapshot, setHistorySnapshot] =
    createSignal<ComposerDraft | null>(null);
  // Parts flatten a command chip to text, so the unsent draft's DOM is kept too.
  let historySnapshotNodes: Node[] = [];
  const [historyIndex, setHistoryIndex] = createSignal({
    prompt: -1,
    shell: -1,
  });
  const [history, setHistory] = createSignal({
    prompt: [] as ComposerDraft[],
    shell: [] as ComposerDraft[],
  });
  const [uploadMenuOpen, setUploadMenuOpen] = createSignal(false);
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const folderUpload = createComposerFolderUpload({
    uploadInboxFiles: () => props.onUploadInboxFiles,
    onToast: (message) => props.onToast(message),
  });
  const outsidePaths = createComposerOutsidePaths({
    editor: () => editorRef,
    enabled: () => (props.isSandboxWorkspace || props.isRemoteWorkspace) && !props.readOnly,
    workspaceRoot: () => props.workspaceRoot,
    canAdd: () => mode() !== "shell" && isTauriRuntime() && Boolean(props.onUploadInboxFiles),
    uploadInboxFiles: () => props.onUploadInboxFiles,
    folderUpload,
    onToast: (message) => props.onToast(message),
    onChange: () => emitDraftChange(),
  });
  // Attachments are part of the chat message, not of an answer to a question.
  const attachmentsDisabled = createMemo(() => !props.attachmentsEnabled || !!props.questionMode);
  const hasDraftContent = createMemo(
    () => draftHasText() || attachments().length > 0,
  );

  onCleanup(() => {
    if (inputQueryFrame !== null) {
      cancelAnimationFrame(inputQueryFrame);
      inputQueryFrame = null;
    }
    if (emptyCheckFrame !== null) {
      cancelAnimationFrame(emptyCheckFrame);
      emptyCheckFrame = null;
    }
    for (const url of objectUrls) {
      URL.revokeObjectURL(url);
    }
    objectUrls.clear();
  });

  const removeAttachment = (attachmentId: string) => {
    setAttachments((current: ComposerAttachment[]) => {
      const target = current.find((item) => item.id === attachmentId);
      releaseObjectUrl(target?.previewUrl);
      return current.filter((item) => item.id !== attachmentId);
    });
    emitDraftChange();
  };

  const createPasteSpan = (part: Extract<ComposerPart, { type: "paste" }>) => {
    pasteTextById.set(part.id, part.text);
    const span = document.createElement("span");
    span.textContent = part.label;
    span.contentEditable = "false";
    span.dataset.pasteId = part.id;
    span.dataset.pasteLabel = part.label;
    span.dataset.pasteLines = String(part.lines);
    span.title = t("composer.paste_expand_hint");
    span.className =
      "inline-flex items-center rounded-pill px-2 py-0.5 text-label font-semibold bg-dls-hover text-dls-secondary border border-dls-border cursor-pointer hover:bg-dls-active hover:text-dls-text";
    return span;
  };

  const mentions = createComposerMentions({
    editor: () => editorRef,
    isShellMode: () => mode() === "shell",
    agentOptions: () => props.agentOptions,
    recentFiles: () => props.recentFiles,
    searchFiles: (query: string) => props.searchFiles(query),
    loadAgentOptions: () => props.loadAgentOptions(),
    onInserted: () => emitDraftChange(),
  });

  const slash = createComposerSlash({
    editor: () => editorRef,
    isShellMode: () => mode() === "shell",
    listCommands: () => props.listCommands(),
    commandsVersion: () => props.commandsVersion,
    emitCommandDraft: (text: string) => {
      // An answer to a question is not the chat draft.
      if (props.questionMode) return;
      suppressPromptSync = true;
      props.onDraftChange({
        mode: mode(),
        parts: [{ type: "text", text }],
        attachments: attachments(),
        text,
      });
      queueMicrotask(() => {
        suppressPromptSync = false;
      });
    },
    onInserted: () => emitDraftChange(),
  });

  // An answer to a question is plain text, so the @ and / pickers stay shut while one waits.
  const refreshPickers = () => {
    if (props.questionMode) return;
    mentions.updateQuery();
    slash.updateQuery();
  };

  /**
   * The draft as `sendDraft` will serialize it. Used only by the Dictionary's
   * correction capture, which compares a snapshot taken at insertion time against
   * the text actually sent; both sides must come from here for that to work.
   */
  const draftTextForCorrections = () =>
    editorRef ? normalizeText(partsToText(buildPartsFromEditor(editorRef, pasteTextById))) : "";

  // Shell mode runs the text as typed.
  const readParts = (editor: HTMLElement) => readChipFirstParts(editor, pasteTextById, mode() === "prompt");
  // Resolved text: the chip label is what the editor shows; dispatch sends the
  // body of a collapsed paste.
  const liveDraftText = () =>
    editorRef ? normalizeText(partsToResolvedText(readParts(editorRef).parts)) : "";

  // The composer stays engine-agnostic: the controller decides between the
  // browser speech service and on-device recognition, and both report through
  // the same callbacks. With no `voiceInput` prop it is cloud-only, i.e. the
  // behaviour that shipped before this feature.
  const voice = createVoiceController({
    onToast: (message) => props.onToast(message),
    onTranscript: (transcript) => {
      // A hidden child transcript still mounts this composer; do not append
      // late results into a draft the user cannot see.
      if (props.readOnly) return;
      // Read the draft either side of the insertion so the Dictionary can learn from
      // whatever the user fixes before sending. Both reads go through the same
      // serialization `sendDraft` uses, because the anchors are compared against its
      // output — a different representation here would simply never match, and the
      // learning would be silently dead.
      const before = draftTextForCorrections();
      insertPlainTextAtSelection(transcript);
      refreshPickers();
      emitDraftChange();
      props.voiceInput?.noteTranscriptInserted(before, draftTextForCorrections(), transcript);
    },
    mode: () => props.voiceInput?.mode() ?? "cloud",
    localAvailable: () => props.voiceInput?.localAvailable() ?? false,
    createLocal: props.voiceInput?.createLocalProvider,
    hotkeys: () => props.voiceInput?.hotkeys() ?? [],
    hotkeyLabel: () => props.voiceInput?.hotkeyLabel() ?? "",
    onRecordingStarted: () => props.voiceInput?.noteRecordingStarted(),
    startRequest: () => props.voiceInput?.startRequest() ?? 0,
    // readOnly covers confirmed child (composer hidden) and the brief loading
    // gate — both must not record without a usable stop control.
    enabled: () => !props.readOnly,
  });

  onMount(() => {
    queueMicrotask(() => focusEditorEnd());

    void installNativeDropListener();

    // Bind composition events directly via addEventListener because SolidJS
    // does not delegate compositionstart/compositionend — the camelCase JSX
    // form (onCompositionStart) may silently fail to attach.
    if (editorRef) {
      onCleanup(watchImageMentions(editorRef, setImageMentions));
      editorRef.addEventListener("compositionstart", () => {
        imeComposing = true;
        props.voiceInput?.noteCompositionStart();
      });
      editorRef.addEventListener("compositionend", () => {
        requestAnimationFrame(() => {
          imeComposing = false;
          props.voiceInput?.noteCompositionEnd(draftTextForCorrections());
        });
      });
    }
  });

  const recentEmits = createRecentEmits();
  const rememberRecentEmit = recentEmits.remember;
  const resetRecentEmits = recentEmits.reset;

  // While a question waits, the editor shows its typed answer; afterwards the draft comes back.
  let wasAnsweringQuestion = false;
  let draftBeforeQuestion: { html: string; text: string; prompt: string } | null = null;
  createEffect(() => {
    const question = props.questionMode;
    const editor = editorRef;
    if (!editor) return;
    if (question) {
      untrack(() => {
        if (wasAnsweringQuestion) return;
        // Publish what was typed in the last moments (the debounce may not have), and
        // keep the editor as it is, chips and all, to put back afterwards.
        lastInputAt = 0;
        flushDraftChange();
        draftBeforeQuestion = { html: editor.innerHTML, text: liveDraftText(), prompt: props.prompt };
        mentions.close();
        slash.close();
        wasAnsweringQuestion = true;
      });
      const text = question.text();
      if (text !== liveDraftText()) setEditorText(text);
      return;
    }
    if (!wasAnsweringQuestion) return;
    wasAnsweringQuestion = false;
    lastFlushedText = "";
    const saved = draftBeforeQuestion;
    draftBeforeQuestion = null;
    // The prompt state can still hold text that was already sent, so only a change made during
    // the question (history, a command) overrides what the editor showed before it.
    if (saved && props.prompt === saved.prompt) {
      editor.innerHTML = saved.html;
      setDraftHasText(saved.text.trim().length > 0);
    } else {
      setEditorText(props.prompt);
    }
  });

  // Sync from props: ignore echoes of what we just sent
  createEffect(() => {
    if (!editorRef || props.questionMode) return;
    const value = props.prompt;
    const current = readEditorText(editorRef);

    // Robust Echo Cancellation:
    // If the incoming value matches ANY recently emitted text, it's a stale echo or confirmation.
    // We ignore it to prevent overwriting the user's newer local state.
    if (recentEmits.has(value)) {
      // If we've converged (parent matches local), we can clean up the set to save memory,
      // but keeping a few items is cheap and safer for race conditions.
      if (value === current) {
        resetRecentEmits(value);
        setDraftHasText(value.trim().length > 0);
      }
      return;
    }

    // If we get here, 'value' is something we didn't send recently.
    // It must be an external event (History Navigation, Clear, Agent Action, etc).

    if (suppressPromptSync) {
      if (!value && current) {
        setEditorText("");
        setAttachments([]);
        setHistoryIndex((currentIndex: { prompt: number; shell: number }) => ({
          ...currentIndex,
          [mode()]: -1,
        }));
        setHistorySnapshot(null);
        queueMicrotask(() => focusEditorEnd());
      }
      return;
    }
    if (value === current) {
      // Even if it matches current, make sure it's tracked as a valid base state
      rememberRecentEmit(value);
      setDraftHasText(value.trim().length > 0);
      return;
    }

    // External update confirmed
    if (value.startsWith("!") && mode() === "prompt") {
      setMode("shell");
      setEditorText(value.slice(1).trimStart());
      rememberRecentEmit(value);
      emitDraftChange();
      queueMicrotask(() => focusEditorEnd());
      return;
    }

    lastFlushedText = "";
    rememberRecentEmit(value); // It's now the new baseline
    setEditorText(value);
    if (!value) {
      setAttachments([]);
      setHistoryIndex((currentIndex: { prompt: number; shell: number }) => ({
        ...currentIndex,
        [mode()]: -1,
      }));
      setHistorySnapshot(null);
    }

    // We don't emitDraftChange here usually, to avoid loops, but if we changed text we might need to?
    // Actually original code did emitDraftChange(). Let's keep it but be careful.
    // If we emit, we add to Set again.
    emitDraftChange();
    queueMicrotask(() => focusEditorEnd());
  });

  let emitTimer: number | null = null;
  const emitDraftChange = () => {
    if (!editorRef) return;
    // The typed answer reaches the question at once, however the editor changed (typing, paste, dictation).
    props.questionMode?.onTextChange(liveDraftText());
    draftScheduledAt = perfNow();

    if (emitTimer !== null) return;
    emitTimer = window.setTimeout(() => {
      flushDraftChange();
    }, DRAFT_FLUSH_DEBOUNCE_MS);
  };

  const flushDraftChange = () => {
    const flushStartedAt = perfNow();
    const queuedMs =
      draftScheduledAt > 0
        ? Math.round((flushStartedAt - draftScheduledAt) * 100) / 100
        : null;
    if (emitTimer) {
      window.clearTimeout(emitTimer);
      emitTimer = null;
    }
    if (!editorRef) return;
    // The editor holds a question answer, not the draft message.
    if (props.questionMode && wasAnsweringQuestion) {
      draftScheduledAt = 0;
      return;
    }
    const idleMs = Date.now() - lastInputAt;
    if (lastInputAt > 0 && idleMs < DRAFT_FLUSH_DEBOUNCE_MS) {
      const delay = Math.max(
        DRAFT_FLUSH_DEBOUNCE_MS - idleMs,
        MIN_DRAFT_FLUSH_DELAY_MS,
      );
      emitTimer = window.setTimeout(() => {
        flushDraftChange();
      }, delay);
      return;
    }
    const hasStructuredSpans = !!editorRef.querySelector(
      "span[data-mention-kind],span[data-paste-id],span[data-slash-command],span[data-workspace-folder]",
    );
    const rawText = normalizeText(editorRef.textContent ?? "");
    if (!hasStructuredSpans && rawText === lastFlushedText && mode() === lastFlushedMode) {
      draftScheduledAt = 0;
      return;
    }

    const buildStartedAt = perfNow();
    const { parts, typedText } = readParts(editorRef);
    const buildMs = Math.round((perfNow() - buildStartedAt) * 100) / 100;
    const serializeStartedAt = perfNow();
    const text = normalizeText(partsToText(parts));
    const resolvedText = normalizeText(partsToResolvedText(parts));
    const serializeMs =
      Math.round((perfNow() - serializeStartedAt) * 100) / 100;

    if (!hasStructuredSpans && text === lastFlushedText && mode() === lastFlushedMode) {
      draftScheduledAt = 0;
      return;
    }
    lastFlushedText = text;
    lastFlushedMode = mode();

    // The correction loop's idle window restarts here rather than in
    // `handleEditorInput`: this is the one place the built draft text already
    // exists, so watching it costs no extra DOM walk per keystroke.
    props.voiceInput?.noteDraftChanged(typedText(text));

    setDraftHasText(text.trim().length > 0);
    rememberRecentEmit(text); // Track that we sent this, expect an echo later
    rememberRecentEmit(resolvedText);

    suppressPromptSync = true;
    const draftChangeStartedAt = perfNow();
    props.onDraftChange({
      mode: mode(),
      parts,
      attachments: attachments(),
      text,
      resolvedText,
    });
    const draftChangeMs =
      Math.round((perfNow() - draftChangeStartedAt) * 100) / 100;
    const totalMs = Math.round((perfNow() - flushStartedAt) * 100) / 100;
    if (
      props.developerMode &&
      ((queuedMs !== null && queuedMs >= 90) ||
        buildMs >= 8 ||
        serializeMs >= 8 ||
        draftChangeMs >= 8 ||
        totalMs >= 12 ||
        text.length >= 2_500)
    ) {
      recordPerfLog(true, "session.input", "draft-flush", {
        queuedMs,
        buildMs,
        serializeMs,
        draftChangeMs,
        totalMs,
        chars: text.length,
        parts: parts.length,
        mode: mode(),
      });
    }
    draftScheduledAt = 0;
    queueMicrotask(() => {
      suppressPromptSync = false;
    });
  };

  const handleEditorInput = (event: InputEvent) => {
    const startedAt = perfNow();
    const now = Date.now();
    const sincePrevInputMs = lastInputAt > 0 ? now - lastInputAt : null;
    lastInputAt = now;

    const inputData = event.data ?? "";
    const inputType = event.inputType ?? "";

    // Keep the button/placeholder responsive without reading the editor text on
    // ordinary input. Deletes intentionally do not scan the DOM while the key is
    // held; the delayed draft flush and send path both recompute exact state.
    if (/\S/.test(inputData) || inputType === "insertFromPaste") {
      setDraftHasText(true);
    }
    emitDraftChange();

    // Promptly update empty-state on deletes/backspace with a single rAF
    // to avoid per-keystroke forced layout while keeping the placeholder
    // responsive when the user clears the input.
    const isDelete =
      typeof inputType === "string" &&
      (inputType.startsWith("delete") ||
        inputType === "deleteContentBackward" ||
        inputType === "deleteContentForward");
    if (isDelete) {
      if (emptyCheckFrame !== null) {
        cancelAnimationFrame(emptyCheckFrame);
        emptyCheckFrame = null;
      }
      emptyCheckFrame = requestAnimationFrame(() => {
        emptyCheckFrame = null;
        const raw = normalizeText(editorRef?.textContent ?? "");
        if (!raw.trim()) setDraftHasText(false);
      });
    }

    const hadPendingQuery = inputQueryFrame !== null;
    // An answer is plain text: no @ mentions or / commands while a question waits.
    const shouldUpdateMention =
      !props.questionMode && (mentions.open() || inputData === "@" || hadPendingQuery);
    const shouldUpdateSlash =
      !props.questionMode && (slash.open() || inputData === "/" || hadPendingQuery);
    if (!shouldUpdateMention) {
      mentions.close();
    }
    if (!shouldUpdateSlash) {
      slash.close();
    }

    if (inputQueryFrame !== null) {
      cancelAnimationFrame(inputQueryFrame);
      inputQueryFrame = null;
    }

    if (shouldUpdateMention || shouldUpdateSlash) {
      // Defer forced-layout work (getSelectionOffsets uses cloneRange+toString)
      // and coalesce rapid key repeat into the newest rAF.
      const rafMentionOpen = mentions.open();
      inputQueryFrame = requestAnimationFrame(() => {
        inputQueryFrame = null;
        const rafText = readEditorText(editorRef);
        const mentionStartedAt = perfNow();
        if (shouldUpdateMention) mentions.updateQuery(rafText);
        const mentionMs =
          Math.round((perfNow() - mentionStartedAt) * 100) / 100;
        const slashStartedAt = perfNow();
        if (shouldUpdateSlash) slash.updateQuery(rafText);
        const slashMs = Math.round((perfNow() - slashStartedAt) * 100) / 100;
        if (props.developerMode && (mentionMs >= 4 || slashMs >= 4)) {
          recordPerfLog(true, "session.input", "keystroke-raf", {
            mentionMs,
            slashMs,
            chars: rafText.length,
            mentionOpen: rafMentionOpen,
            slashOpen: slash.open(),
          });
        }
      });
    }

    const totalMs = Math.round((perfNow() - startedAt) * 100) / 100;
    if (props.developerMode && totalMs >= 8) {
      recordPerfLog(true, "session.input", "keystroke", {
        totalMs,
        sincePrevInputMs,
      });
    }
  };

  const focusEditorEnd = () => {
    if (!editorRef) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(editorRef);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    editorRef.focus();
  };

  const renderParts = (parts: ComposerPart[], keepSelection = true) => {
    if (!editorRef) return;
    const selection = keepSelection ? getSelectionOffsets(editorRef) : null;
    editorRef.innerHTML = "";
    parts.forEach((part) => {
      if (part.type === "text") {
        insertTextWithBreaks(editorRef!, part.text);
        return;
      }
      if (part.type === "paste") {
        const span = createPasteSpan(part);
        editorRef?.appendChild(span);
        editorRef?.appendChild(document.createTextNode(" "));
        return;
      }
      const span = createMentionSpan(part);
      editorRef?.appendChild(span);
      editorRef?.appendChild(document.createTextNode(" "));
    });
    if (selection) {
      restoreSelectionOffsets(editorRef, selection);
    }
  };

  const setEditorText = (value: string) => {
    if (!editorRef) return;
    const normalized = normalizeText(value);
    setDraftHasText(normalized.trim().length > 0);
    renderParts(value ? [{ type: "text", text: value }] : [], false);
  };

  const canNavigateHistory = () => {
    if (!editorRef) return false;
    const offsets = getSelectionOffsets(editorRef);
    if (!offsets || offsets.start !== offsets.end) return false;
    const total = readEditorText(editorRef).length;
    return offsets.start === 0 || offsets.start === total;
  };

  const applyHistoryDraft = (draft: ComposerDraft | null) => {
    if (!draft) return;
    setMode(draft.mode);
    renderParts(draft.parts, false);
    setDraftHasText(draft.text.trim().length > 0);
    setAttachments(draft.attachments ?? []);
    // History publishes the resolved body. Register it before that write or
    // the prompt sync treats the body as an external edit and expands the chip.
    rememberRecentEmit(draft.text);
    rememberRecentEmit(draft.resolvedText ?? draft.text);
    props.onDraftChange(draft);
  };

  const navigateHistory = (direction: "up" | "down") => {
    const key = mode();
    const list = history()[key];
    if (!list.length) return;
    const index = historyIndex()[key];
    const nextIndex = direction === "up" ? index + 1 : index - 1;
    if (nextIndex < -1 || nextIndex >= list.length) return;

    if (index === -1 && direction === "up") {
      // Published chip-first like any draft; the live editor gets the DOM back.
      setHistorySnapshot(draftFromParts(key, editorRef ? readParts(editorRef).parts : [], attachments()));
      historySnapshotNodes = Array.from(editorRef?.childNodes ?? [], (node) => node.cloneNode(true));
    }

    setHistoryIndex((current: { prompt: number; shell: number }) => ({
      ...current,
      [key]: nextIndex,
    }));
    if (nextIndex === -1) {
      applyHistoryDraft(historySnapshot());
      if (historySnapshot()) editorRef?.replaceChildren(...historySnapshotNodes);
      historySnapshotNodes = [];
      setHistorySnapshot(null);
      return;
    }
    const target = list[list.length - 1 - nextIndex];
    applyHistoryDraft(target);
  };

  const sendDraft = async () => {
    if (props.busy || props.isStreaming || props.readOnly) return;

    voice.abort();

    // Read the submission before any pre-send wait. The editor stays live
    // during that wait, and dispatch uses whichever chat is selected when
    // onSend runs. A later edit or a chat switch drops this send: shipping
    // the original snapshot would erase what the user typed next.
    const submittedSessionId = props.selectedSessionId;
    const submittedMode = mode();
    const submittedText = liveDraftText();
    const submissionChanged = () =>
      props.selectedSessionId !== submittedSessionId ||
      mode() !== submittedMode ||
      liveDraftText() !== submittedText;

    if (submittedMode === "prompt") {
      if (submittedText.trim() && props.onPrepareSend?.(submittedText) === false) return;
    }

    if (!(await passEmailSendGates(props, submissionChanged))) return;

    // Ensure any pending debounce updates are committed before sending.
    flushDraftChange();

    if (!editorRef) return;
    const { parts, typedText } = readParts(editorRef);
    const draft = draftFromParts(mode(), parts, attachments());
    const { text } = draft;
    if (!text.trim() && attachments().length === 0) return;

    // Sending is the moment the user declares the text correct, so it is the only
    // point a correction is learned from. Deliberately before the send gates below:
    // whether the message reaches an agent says nothing about whether the word was
    // misheard, and a rejected send would otherwise discard the evidence.
    props.voiceInput?.commitCorrections(typedText(text));

    // Detect slash command: text like "/commandname arg1 arg2"
    if (text.startsWith("/")) {
      const [cmdToken] = text.split(" ");
      const commandName = cmdToken.slice(1); // strip leading /
      if (commandName) {
        const matchedCommand = slash.commands().find(
          (c) => c.name === commandName,
        );
        if (matchedCommand) {
          draft.command = {
            name: commandName,
            // `text` holds a collapsed paste as its label; `resolvedText` holds its body.
            arguments: (draft.resolvedText ?? text).split(" ").slice(1).join(" "),
            dispatch: matchedCommand.dispatch,
          };
        }
      }
    }

    // Clear only when the send pipeline explicitly accepts the draft. Gates
    // may still reject asynchronously; restore the untouched draft in that
    // case without clobbering anything the user typed after acceptance.
    const sentAttachments = draft.attachments;
    const submittedAt = perfNow();
    let clearedAcceptedDraft = false;
    const clearAcceptedDraft = () => {
      if (clearedAcceptedDraft) return;
      setEditorText("");
      setDraftHasText(false);
      setAttachments([]);
      slash.close();
      lastFlushedText = "";
      emitDraftChange();
      queueMicrotask(() => focusEditorEnd());
      clearedAcceptedDraft = true;
      recordPerfLog(props.developerMode, "session.submit", "composer-cleared", {
        ms: Math.round((perfNow() - submittedAt) * 100) / 100,
      });
    };
    const restoreAcceptedDraft = () => {
      if (!clearedAcceptedDraft || !editorRef) return;
      const current = normalizeText(readEditorText(editorRef));
      if (current.trim().length > 0 || attachments().length > 0) {
        for (const attachment of sentAttachments) {
          releaseObjectUrl(attachment.previewUrl);
        }
        clearedAcceptedDraft = false;
        return;
      }

      renderParts(parts, false);
      setDraftHasText(text.trim().length > 0);
      setAttachments(sentAttachments);
      emitDraftChange();
      queueMicrotask(() => focusEditorEnd());
      clearedAcceptedDraft = false;
    };
    try {
      const result = props.onSend(draft, {
        onAccepted: clearAcceptedDraft,
        submittedAt,
      });
      const resultThen = (result as PromiseLike<void | false> | undefined)
        ?.then;
      const asyncSend = typeof resultThen === "function";
      const accepted = asyncSend
        ? await (result as PromiseLike<void | false>)
        : result;
      if (accepted === false) {
        restoreAcceptedDraft();
        return;
      }
      clearAcceptedDraft();
    } catch (err) {
      console.error("sendDraft: onSend failed", err);
      restoreAcceptedDraft();
      return;
    }

    recordHistory(draft);
    for (const attachment of sentAttachments) {
      releaseObjectUrl(attachment.previewUrl);
    }
  };

  const recordHistory = (draft: ComposerDraft) => {
    const trimmed = draft.text.trim();
    if (!trimmed && !draft.attachments.length) return;
    setHistory(
      (current: { prompt: ComposerDraft[]; shell: ComposerDraft[] }) => ({
        ...current,
        [draft.mode]: [...current[draft.mode], { ...draft, attachments: [] }],
      }),
    );
    setHistoryIndex((current: { prompt: number; shell: number }) => ({
      ...current,
      [draft.mode]: -1,
    }));
    setHistorySnapshot(null);
  };

  const addAttachments = async (
    files: File[],
    preReservedImageCount = 0,
  ) => {
    if (attachmentsDisabled()) {
      props.onToast(
        props.attachmentsDisabledReason ??
          t("composer.attachments_unavailable"),
      );
      return;
    }
    const attachedImageCount = attachments().filter(
      (attachment) => attachment.kind === "image",
    ).length;
    const { acceptedFiles, omittedImageCount } = limitImageAttachments(
      files,
      attachedImageCount +
        Math.max(0, pendingImageAttachmentCount - preReservedImageCount),
    );
    const reservedImageCount = acceptedFiles.filter((file) =>
      isImageMime(file.type),
    ).length;
    pendingImageAttachmentCount += reservedImageCount;

    try {
      if (omittedImageCount > 0) {
        props.onToast(t("composer.image_count_limit"));
      }

      if (!acceptedFiles.length) {
        return;
      }

      const next: ComposerAttachment[] = [];
      for (const file of acceptedFiles) {
        const sizeLimit = attachmentSizeLimit(file);
        if (sizeLimit === "raw") {
          props.onToast(`${file.name} ${t("composer.attachment_too_large")}`);
          continue;
        }
        try {
          // Compress images before keeping them in local draft state.
          const processed = isImageMime(file.type)
            ? await compressImageFile(file)
            : file;
          if (attachmentSizeLimit(processed) === "encoded") {
            props.onToast(
              `${file.name} ${t("composer.attachment_too_large_encoded")}`,
            );
            continue;
          }
          next.push({
            id: `${processed.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
            name: processed.name,
            mimeType: processed.type || "application/octet-stream",
            size: processed.size,
            kind: isImageMime(processed.type) ? "image" : "file",
            file: processed,
            previewUrl: isImageMime(processed.type)
              ? createObjectUrl(processed)
              : undefined,
          });
        } catch (error) {
          props.onToast(
            error instanceof Error
              ? error.message
              : t("composer.attachment_read_failed"),
          );
        }
      }
      if (next.length) {
        setAttachments((current: ComposerAttachment[]) => [...current, ...next]);
        emitDraftChange();
      }
    } finally {
      pendingImageAttachmentCount -= reservedImageCount;
    }
  };

  const insertPlainTextAtSelection = (content: string | DocumentFragment) => {
    if (!editorRef) return;
    let selection = window.getSelection();
    // If the current selection is outside the editor (e.g. after an async
    // upload opened the sidebar), move the cursor to the end of the editor
    // first so we never accidentally mutate unrelated DOM nodes.
    if (
      !selection ||
      selection.rangeCount === 0 ||
      !editorRef.contains(selection.getRangeAt(0).commonAncestorContainer)
    ) {
      focusEditorEnd();
      selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const fragment = typeof content === "string" ? textToFragment(content) : content;
    const last = fragment.lastChild;
    range.insertNode(fragment);

    if (!last) return;
    const cursor = document.createRange();
    cursor.setStartAfter(last);
    cursor.collapse(true);
    selection.removeAllRanges();
    selection.addRange(cursor);
  };

  const insertCollapsedPasteAtSelection = (text: string, lines: number) => {
    if (!editorRef) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();

    pasteCounter += 1;
    const id = `paste-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const label = `[pasted text ${pasteCounter}]`;
    const part = { type: "paste", id, label, text, lines } as const;
    const span = createPasteSpan(part);

    range.insertNode(span);
    span.after(document.createTextNode(" "));

    const cursor = document.createRange();
    cursor.setStartAfter(span.nextSibling ?? span);
    cursor.collapse(true);
    selection.removeAllRanges();
    selection.addRange(cursor);
  };

  const handleEditorClick = (event: MouseEvent) => {
    if (!editorRef) return;
    const target = event.target as HTMLElement | null;
    const span =
      (target?.closest?.("span[data-paste-id]") as HTMLElement | null) ?? null;
    if (!span || !editorRef.contains(span)) return;
    const id = span.dataset.pasteId ?? "";
    if (!id) return;
    const text = pasteTextById.get(id);
    if (typeof text !== "string") return;

    event.preventDefault();
    event.stopPropagation();

    const fragment = textToFragment(text);
    const last = fragment.lastChild;
    span.replaceWith(fragment);
    pasteTextById.delete(id);

    const selection = window.getSelection();
    if (selection) {
      const cursor = document.createRange();
      if (last && last.parentNode) {
        cursor.setStartAfter(last);
        cursor.collapse(true);
      } else {
        cursor.selectNodeContents(editorRef);
        cursor.collapse(false);
      }
      selection.removeAllRanges();
      selection.addRange(cursor);
    }

    refreshPickers();
    emitDraftChange();
  };

  const insertUnsupportedFileLinks = async (
    files: File[],
    clipboardLinks: string[],
  ) => {
    const fallbackLinks = () =>
      files.map((file, index) => ({
        name: file.name || `file-${index + 1}`,
        target: clipboardLinks[index] || createObjectUrl(file),
      }));

    if (props.onUploadInboxFiles) {
      const uploaded = await Promise.resolve(
        props.onUploadInboxFiles(files, { notify: true }),
      );
      if (Array.isArray(uploaded) && uploaded.length) {
        const fileMentions = uploaded
          .map((item, index) => {
            const path = item.path?.trim() ?? "";
            const fallbackName = files[index]?.name || `file-${index + 1}`;
            const name = item.name?.trim() || fallbackName;
            return { name, path };
          })
          .filter((entry) => entry.path);
        if (fileMentions.length) {
          insertFileMentionsAtSelection(fileMentions);
          refreshPickers();
          emitDraftChange();
          // Toast is handled by uploadInboxFiles (including RAG ingest status)
          return;
        }
      }
      props.onToast(t("composer.inbox_upload_failed_fallback"));
    }

    const text = formatLinks(fallbackLinks());
    if (!text) {
      props.onToast(t("composer.unsupported_attachment_type"));
      return;
    }
    insertPlainTextAtSelection(text);
    refreshPickers();
    emitDraftChange();
    props.onToast(t("composer.inserted_unsupported_links"));
  };

  const insertFileMentionsAtSelection = (
    files: Array<{ name: string; path: string }>,
  ) => {
    if (!editorRef) return;
    let selection = window.getSelection();
    if (
      !selection ||
      selection.rangeCount === 0 ||
      !editorRef.contains(selection.getRangeAt(0).commonAncestorContainer)
    ) {
      focusEditorEnd();
      selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();

    let lastNode: Node | null = null;
    for (const file of files) {
      const mention = createMentionSpan({
        type: "file",
        path: file.path,
        label: file.name,
      });
      range.insertNode(mention);
      const separator = document.createTextNode("\u00a0"); // a plain trailing space collapses and typing lands before it
      mention.after(separator);
      range.setStartAfter(separator);
      range.collapse(true);
      lastNode = separator;
    }
    if (!lastNode) return;
    const cursor = document.createRange();
    cursor.setStartAfter(lastNode);
    cursor.collapse(true);
    selection.removeAllRanges();
    selection.addRange(cursor);
  };

  const handlePaste = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    const clipboard = event.clipboardData;
    const fileItems = Array.from(clipboard.items || []).filter(
      (item) => item.kind === "file",
    );
    const files = Array.from(clipboard.files || []);
    const itemFiles = fileItems
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    const allFiles = files.length ? files : itemFiles;
    if (allFiles.length) {
      event.preventDefault();
      const supported = allFiles.filter((file) =>
        isSupportedAttachmentType(file.type),
      );
      const unsupported = allFiles.filter(
        (file) => !isSupportedAttachmentType(file.type),
      );
      if (supported.length) {
        void addAttachments(supported);
      }
      if (unsupported.length) {
        const links = parseClipboardLinks(clipboard);
        void insertUnsupportedFileLinks(unsupported, links);
      }
      return;
    }

    const plain =
      clipboard.getData("text/plain") || clipboard.getData("text") || "";
    const html = clipboard.getData("text/html") || "";
    const raw = plain || (html ? htmlToPlainText(html) : "");
    if (!raw) return;

    event.preventDefault();
    const text = sanitizePastedPlainText(raw);
    const lines = countLines(text);
    if (lines > 10) {
      insertCollapsedPasteAtSelection(text, lines);
    } else {
      const { fragment, firstChip } = outsidePaths.build(text);
      insertPlainTextAtSelection(fragment);
      if (firstChip) outsidePaths.open(firstChip);
    }

    // Hide the placeholder after text has been inserted into the composer
    if (text.trim().length > 0) setDraftHasText(true);

    refreshPickers();
    emitDraftChange();
  };

  const handleDrop = (event: DragEvent) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length) void addAttachments(files);
  };

  // Installed Tauri builds intercept drops before HTML5 handlers receive them.
  let unlistenNativeDrop: (() => void) | undefined;
  let nativeDropListenerDisposed = false;

  const isInsideDropZone = (position?: { x: number; y: number }): boolean => {
    if (!dropZoneRef || !position) return false;
    // Convert Tauri's physical coordinates to CSS pixels for hit-testing.
    const ratio = window.devicePixelRatio || 1;
    const hit = document.elementFromPoint(position.x / ratio, position.y / ratio);
    return hit != null && dropZoneRef.contains(hit);
  };

  const handleNativeDrop = async (paths: string[]) => {
    const imagePaths = paths
      .map((path) => ({ path, mime: droppedImageMime(path) }))
      .filter(
        (item): item is { path: string; mime: string } => item.mime !== null,
      );
    const attachedImageCount = attachments().filter(
      (attachment) => attachment.kind === "image",
    ).length;
    const availableSlots = remainingImageAttachmentSlots(
      attachedImageCount + pendingImageAttachmentCount,
    );
    const acceptedPaths = imagePaths.slice(0, availableSlots);
    if (acceptedPaths.length < imagePaths.length) {
      props.onToast(t("composer.image_count_limit"));
    }

    pendingImageAttachmentCount += acceptedPaths.length;
    for (const { path, mime } of acceptedPaths) {
      try {
        const bytes = await readDroppedImage(path);
        const name = path.split(/[\\/]/).pop() || "image";
        await addAttachments([
          new File([new Uint8Array(bytes)], name, { type: mime }),
        ], 1);
      } catch (error) {
        props.onToast(
          error instanceof Error
            ? error.message
            : t("composer.attachment_read_failed"),
        );
      } finally {
        pendingImageAttachmentCount -= 1;
      }
    }

    for (const path of paths) {
      if (droppedImageMime(path)) continue;
      try {
        const bytes = await readDroppedFile(path);
        const name = path.split(/[\\/]/).pop() || "file";
        await addAttachments([new File([new Uint8Array(bytes)], name)]);
      } catch (error) {
        props.onToast(
          error instanceof Error
            ? error.message
            : t("composer.attachment_read_failed"),
        );
      }
    }
  };

  const installNativeDropListener = async () => {
    if (!isTauriRuntime()) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const unlisten = await getCurrentWindow().onDragDropEvent(
        (event: unknown) => {
          const payload = (
            event as {
              payload?: {
                type?: string;
                paths?: string[];
                position?: { x: number; y: number };
              };
            }
          ).payload;
          if (payload?.type !== "drop") return;
          if (attachmentsDisabled()) return;
          if (!isInsideDropZone(payload.position)) return;
          const paths = payload.paths ?? [];
          void authorizeComposerDroppedFiles(paths)
            .then(() => handleNativeDrop(paths))
            .catch((error: unknown) => {
              props.onToast(
                error instanceof Error
                  ? error.message
                  : t("composer.attachment_read_failed"),
              );
            });
        },
      );
      // Setup may finish after unmount; dispose the late listener immediately.
      if (nativeDropListenerDisposed) {
        unlisten();
        return;
      }
      unlistenNativeDrop = unlisten;
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn("Failed to install native drop listener:", error);
      }
    }
  };

  onCleanup(() => {
    nativeDropListenerDisposed = true;
    unlistenNativeDrop?.();
  });

  const handleKeyDown = (event: KeyboardEvent) => {
    // Make slash chips behave like single tokens.
    if ((event.key === "Backspace" || event.key === "Delete") && editorRef) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount) {
        const range = selection.getRangeAt(0);
        if (range.collapsed) {
          const container = range.startContainer;
          const offset = range.startOffset;

          const resolvePreviousSibling = () => {
            if (container === editorRef) {
              return offset > 0 ? editorRef.childNodes[offset - 1] : null;
            }
            if (container.nodeType === Node.TEXT_NODE) {
              const parent = container.parentNode;
              if (parent === editorRef) {
                if (offset > 0) return null;
                return container.previousSibling;
              }
            }
            return null;
          };

          const prev = resolvePreviousSibling();
          if (prev instanceof HTMLElement && prev.dataset.slashCommand) {
            event.preventDefault();
            // Also remove a single trailing space node if present.
            const next = prev.nextSibling;
            if (
              next &&
              next.nodeType === Node.TEXT_NODE &&
              normalizeText(next.textContent ?? "") === " "
            ) {
              next.parentNode?.removeChild(next);
            }
            prev.parentNode?.removeChild(prev);
            emitDraftChange();
            return;
          }
        }
      }
    }

    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      document.execCommand("insertLineBreak");
      emitDraftChange();
      return;
    }
    // Block Enter while IME is composing. We check three signals:
    // 1. event.isComposing — standard API (unreliable in some WebKit builds)
    // 2. imeComposing — manual flag from compositionstart/end
    // 3. event.keyCode === 229 — legacy but reliable IME indicator across all browsers
    const imeActive =
      event.isComposing || imeComposing || event.keyCode === 229;
    if (event.key === "Enter" && imeActive) return;
    if (event.key === "Enter" && props.questionMode) {
      event.preventDefault();
      props.questionMode.onSubmit();
      return;
    }

    if (mentions.open()) {
      const options = mentions.options();
      const ctrl =
        event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (event.key === "Enter" && !imeActive) {
        event.preventDefault();
        const active = options[mentions.index()] ?? options[0];
        if (active) mentions.insert(active);
        return;
      }
      if (event.key === "ArrowDown" || (ctrl && event.key === "n")) {
        event.preventDefault();
        if (!options.length) return;
        mentions.setIndex((i: number) => (i + 1) % options.length);
        return;
      }
      if (event.key === "ArrowUp" || (ctrl && event.key === "p")) {
        event.preventDefault();
        if (!options.length) return;
        mentions.setIndex(
          (i: number) => (i - 1 + options.length) % options.length,
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        mentions.close();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const active = options[mentions.index()] ?? options[0];
        if (active) mentions.insert(active);
        return;
      }
    }

    // Slash command popup keyboard navigation
    if (slash.open()) {
      const options = slash.filtered();
      const ctrl =
        event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (event.key === "Enter" && !imeActive) {
        if (slash.acceptsEnter()) {
          event.preventDefault();
          const active = options[slash.index()] ?? options[0];
          if (active) slash.select(active);
          // `/compact` takes no arguments, so accepting it sends it too.
          if (active?.name !== "compact") return;
        }
        slash.close();
      }
      if (event.key === "ArrowDown" || (ctrl && event.key === "n")) {
        event.preventDefault();
        if (!options.length) return;
        slash.setIndex((i: number) => (i + 1) % options.length);
        return;
      }
      if (event.key === "ArrowUp" || (ctrl && event.key === "p")) {
        event.preventDefault();
        if (!options.length) return;
        slash.setIndex((i: number) => (i - 1 + options.length) % options.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        slash.close();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const active = options[slash.index()] ?? options[0];
        if (active) slash.select(active);
        return;
      }
    }

    if (event.key === "!" && mode() === "prompt" && !props.questionMode) {
      const offsets = editorRef ? getSelectionOffsets(editorRef) : null;
      if (offsets && offsets.start === 0 && offsets.end === 0) {
        event.preventDefault();
        setMode("shell");
        emitDraftChange();
        return;
      }
    }

    if (event.key === "Escape" && mode() === "shell") {
      event.preventDefault();
      setMode("prompt");
      emitDraftChange();
      return;
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (!props.questionMode && canNavigateHistory()) {
        event.preventDefault();
        navigateHistory(event.key === "ArrowUp" ? "up" : "down");
        return;
      }
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (props.busy || props.isStreaming) return;
      sendDraft();
    }
  };

  createEffect(() => {
    if (mode() !== "shell") return;
    mentions.close();
    slash.close();
  });

  createEffect(() => {
    if (!uploadMenuOpen()) return;
    const handler = (event: MouseEvent) => {
      if (!uploadPickerRef) return;
      if (uploadPickerRef.contains(event.target as Node)) return;
      setUploadMenuOpen(false);
    };
    window.addEventListener("mousedown", handler);
    onCleanup(() => window.removeEventListener("mousedown", handler));
  });

  createEffect(() => {
    if (!modelPickerOpen()) return;
    const handler = (event: MouseEvent) => {
      if (modelPickerRef?.contains(event.target as Node)) return;
      setModelPickerOpen(false);
    };
    window.addEventListener("mousedown", handler);
    onCleanup(() => window.removeEventListener("mousedown", handler));
  });

  createEffect(() => {
    const handler = () => {
      focusEditorEnd();
    };
    window.addEventListener("openwork:focusPrompt", handler);
    onCleanup(() =>
      window.removeEventListener("openwork:focusPrompt", handler),
    );
  });

  onCleanup(() => {
    if (inputQueryFrame !== null) {
      cancelAnimationFrame(inputQueryFrame);
      inputQueryFrame = null;
    }
    if (emptyCheckFrame !== null) {
      cancelAnimationFrame(emptyCheckFrame);
      emptyCheckFrame = null;
    }
    if (emitTimer !== null) {
      window.clearTimeout(emitTimer);
      emitTimer = null;
    }
  });

  return (
    <>
      <FolderUploadConfirmModal upload={folderUpload} />

      <div
        class={`sticky bottom-0 z-20 bg-gradient-to-t from-dls-surface via-dls-surface/95 to-transparent px-4 md:px-8 ${props.compactTopSpacing ? "pt-0" : "pt-10"} pb-5`}
        data-composer-shell
        style="contain: layout style;"
      >
        <div class="max-w-[800px] mx-auto">
          <div
            ref={dropZoneRef}
            class={`bg-dls-surface border border-dls-border rounded-shell overflow-visible transition-all relative group/input ${
              mentions.open() || slash.open()
                ? "rounded-t-dialog border-t-transparent"
                : "shadow-[var(--dls-shell-shadow)]"
            }`}
            onDrop={handleDrop}
            onDragOver={(event: DragEvent) => {
              if (attachmentsDisabled()) return;
              event.preventDefault();
            }}
          >
            <MentionPicker mentions={mentions} />

            <SlashPicker slash={slash} />

            <div class="p-3 md:p-4">
              <Show when={attachments().length || imageMentions().length}>
                <div class="mb-3 flex flex-wrap gap-2">
                  <For each={imageMentions()}>
                    {(mention) => (
                      <ComposerImageCard
                        name={mention.name}
                        loadThumbnail={() => props.imageThumbnail?.(mention.path) ?? Promise.resolve(null)}
                        onRemove={() => { removeImageMention(mention); emitDraftChange(); }}
                      />
                    )}
                  </For>
                  <For each={attachments()}>
                    {(attachment: ComposerAttachment) => (
                      <Show
                        when={attachment.kind === "image"}
                        fallback={<CompactAttachmentChip filename={attachment.name} mime={attachment.mimeType} onRemove={() => removeAttachment(attachment.id)} />}
                      >
                        <ComposerImageCard name={attachment.name} thumbnailUrl={attachment.previewUrl} onRemove={() => removeAttachment(attachment.id)} />
                      </Show>
                    )}
                  </For>
                </div>
              </Show>

              <div class="relative">
                <div class="flex flex-col gap-2">
                  <div class="flex-1 min-w-0">
                    {/* <div class="mb-2 text-tiny font-bold uppercase tracking-widest text-dls-muted">
                    {props.isRemoteWorkspace ? "Workspace" : "Local workspace"}
                  </div> */}

                    <div class="relative">
                      <Show when={!hasDraftContent()}>
                        <div class="absolute left-0 top-0 text-dls-secondary text-title leading-relaxed pointer-events-none">
                          {props.questionMode?.placeholder ?? t("composer.editor_placeholder")}
                        </div>
                      </Show>
                      <div
                        ref={editorRef}
                        contentEditable={!props.questionMode?.inputDisabled}
                        role="textbox"
                        aria-multiline="true"
                        data-testid="task-input"
                        spellcheck={false}
                        autocorrect="off"
                        autocapitalize="off"
                        data-gramm="false"
                        data-gramm_editor="false"
                        data-enable-grammarly="false"
                        onInput={handleEditorInput}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        onClick={handleEditorClick}
                        // Leaving the composer banks a pending correction: the user
                        // moved on, so the dictated text is as corrected as it will
                        // get. Harmless when the blur is the send button — the text
                        // read here is the text send would have read.
                        onBlur={() =>
                          props.voiceInput?.noteComposerBlur(draftTextForCorrections())
                        }
                        class="bg-transparent border-none p-0 pr-4 text-dls-text focus:ring-0 text-title leading-relaxed resize-none min-h-[24px] max-h-40 overflow-y-auto outline-none relative z-10"
                      />

                      <div class="relative mt-2 flex flex-col gap-4 px-1 pb-1 sm:flex-row sm:items-center sm:justify-between">
                        {/* Anchored to this toolbar, not the composer's top edge:
                            these messages describe the buttons right below them,
                            and the old placement covered the agent-button row. */}
                        <Show when={props.toast}>
                          {(message) => (
                            <ComposerToast
                              message={message()}
                              class="absolute bottom-full left-0 mb-2 z-30"
                              voiceInput={props.voiceInput}
                              onDismiss={props.onDismissToast}
                            />
                          )}
                        </Show>
                        <OutsidePathPopover paths={outsidePaths} />
                        <div class="flex flex-wrap items-center gap-2.5 text-dls-secondary">
                          <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            class="hidden"
                            disabled={attachmentsDisabled()}
                            onChange={(event: Event) => {
                              const target =
                                event.currentTarget as HTMLInputElement;
                              const files = Array.from(target.files ?? []);
                              if (files.length) void addAttachments(files);
                              target.value = "";
                            }}
                          />
                          <div
                            class="relative"
                            ref={(el) => (uploadPickerRef = el)}
                          >
                            <Tooltip
                              content={t("composer.upload_files_or_folder")}
                              placement="bottom"
                              disabled={uploadMenuOpen()}
                            >
                              <button
                                type="button"
                                class="rounded-control p-1.5 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                                onClick={() => setUploadMenuOpen((open) => !open)}
                                aria-expanded={uploadMenuOpen()}
                                aria-label={t("composer.upload_files_or_folder")}
                              >
                                <Paperclip size={16} />
                              </button>
                            </Tooltip>
                            <Show when={uploadMenuOpen()}>
                              <div class="absolute left-0 bottom-full z-40 mb-2 w-44 overflow-hidden rounded-dialog border border-dls-border bg-dls-surface-solid shadow-[var(--dls-shell-shadow)]">
                                <div class="p-2 space-y-1">
                                  <button
                                    type="button"
                                    class="w-full flex items-center rounded-control px-3 py-2 text-left text-caption text-dls-secondary transition-colors hover:bg-dls-hover/70"
                                    onClick={() => {
                                      fileInputRef?.click();
                                      setUploadMenuOpen(false);
                                    }}
                                  >
                                    {t("composer.upload_files")}
                                  </button>
                                  <button
                                    type="button"
                                    class="w-full flex items-center rounded-control px-3 py-2 text-left text-caption text-dls-secondary transition-colors hover:bg-dls-hover/70"
                                    onClick={() => {
                                      setUploadMenuOpen(false);
                                      void folderUpload.pick();
                                    }}
                                  >
                                    {t("composer.upload_folder")}
                                  </button>
                                </div>
                              </div>
                            </Show>
                          </div>

                          <ComposerAgentPicker
                            busy={props.busy}
                            agentLabel={props.agentLabel}
                            selectedAgent={props.selectedAgent}
                            open={props.agentPickerOpen}
                            loading={props.agentPickerBusy}
                            ready={props.agentPickerReady}
                            error={props.agentPickerError}
                            options={props.agentOptions}
                            displayNames={props.agentDisplayNames}
                            onToggle={() => {
                              setModelPickerOpen(false);
                              props.onToggleAgentPicker();
                            }}
                            onRetry={props.onRetryAgentLoad}
                            onSelect={props.onSelectAgent}
                            setRef={props.setAgentPickerRef}
                          />

                          <Show when={props.selectedAgent !== "hybrid-deep-research"}>
                            <ComposerModelPicker
                              busy={props.busy}
                              open={modelPickerOpen()}
                              selectedLabel={props.selectedModelLabel}
                              selectedModel={props.selectedModel}
                              selectedModelIsLocal={props.selectedModelIsLocal}
                              options={props.modelOptions}
                              onToggle={() => {
                                if (!modelPickerOpen() && props.agentPickerOpen) {
                                  props.onToggleAgentPicker();
                                }
                                setModelPickerOpen((open) => !open);
                              }}
                              onClose={() => setModelPickerOpen(false)}
                              onSelect={(model) => {
                                props.onSelectModel(model);
                                setModelPickerOpen(false);
                              }}
                              onManage={() => {
                                setModelPickerOpen(false);
                                props.onManageModels();
                              }}
                              setRef={(element) => (modelPickerRef = element)}
                            />
                          </Show>
                          {props.pickerAccessory}
                        </div>
                        <div class="flex items-center gap-3 text-dls-secondary sm:justify-end">
                          <Show when={voice.supported()}>
                            {/* Anchor for the tour spotlight and for the hint /
                                failure bubbles, which sit above the button. */}
                            <div class="relative" data-tour-id="composer-voice">
                              {/* The shortcut hint lives in the tooltip and in
                                  aria-keyshortcuts, never in aria-label: the
                                  accessible name must stay the action itself.
                                  While the microphone is missing the tooltip is
                                  off; that sentence is the note from the click. */}
                              <Tooltip
                                content={voice.buttonTooltip()}
                                placement="bottom"
                                maxWidthClass="max-w-[240px]"
                                disabled={voice.micMissing()}
                              >
                                {/* Not aria-disabled while the microphone is missing. The name
                                    already says to try again, and the next press
                                    is what finds a microphone connected without
                                    a devicechange. `disabled` stays the busy
                                    gate, which really does ignore the click. */}
                                <button
                                  type="button"
                                  class={`rounded-control p-1.5 transition-colors ${voice.listening()
                                    ? "text-dls-recording-text bg-dls-recording-bg hover:bg-dls-recording-hover animate-pulse"
                                    : voice.transcribing()
                                      ? "text-dls-secondary bg-dls-hover hover:text-dls-text"
                                      : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
                                  }`}
                                  onClick={voice.toggle}
                                  disabled={props.busy && !voice.listening()}
                                  data-testid="voice-btn"
                                  aria-label={voice.buttonLabel()}
                                  aria-keyshortcuts={voice.keyShortcuts() || undefined}
                                >
                                  <Show
                                    when={voice.transcribing()}
                                    fallback={
                                      <Show
                                        when={voice.listening()}
                                        fallback={<MicOff size={16} />}
                                      >
                                        <Mic size={16} />
                                      </Show>
                                    }
                                  >
                                    <Loader2 size={16} class="animate-spin" />
                                  </Show>
                                </button>
                              </Tooltip>

                              <VoiceMicMissingBubble
                                message={t("composer.voice_no_microphone")}
                                tick={voice.micAbsenceTick()}
                                active={voice.micMissing()}
                              />

                              {/* Download progress next to the microphone, as
                                  well as in settings: a user who dismissed the
                                  dialog still needs to see it move. */}
                              <Show when={props.voiceInput} keyed>
                                {(voiceInput) => (
                                  <>
                                    <Show
                                      when={
                                        voiceInput.modelState() === "downloading" &&
                                        voiceInput.downloadPercent() !== null
                                      }
                                    >
                                      <span
                                        class="pointer-events-none absolute -top-1 -right-1 rounded-pill bg-dls-surface-solid px-1 text-tiny font-medium tabular-nums text-dls-secondary shadow"
                                        title={t("composer.voice_downloading_model")}
                                        data-testid="voice-download-badge"
                                      >
                                        {Math.round(voiceInput.downloadPercent() ?? 0)}%
                                      </span>
                                    </Show>

                                    {/* First-recording hint. Non-blocking by design:
                                        recording is already running behind it. */}
                                    <Show when={voiceInput.hintVisible()}>
                                      <VoiceHintBubble
                                        mode={voice.activeMode()}
                                        hotkeyLabel={voiceInput.hotkeyLabel()}
                                        onOpenSettings={() => {
                                          voiceInput.dismissHint();
                                          props.onOpenVoiceSettings?.();
                                        }}
                                        onDismiss={() => voiceInput.dismissHint()}
                                        onHide={() => voiceInput.hideHint()}
                                      />
                                    </Show>

                                    {/* Local failure: the user chooses whether to go
                                        to the cloud. Nothing switches on its own. */}
                                    <Show when={voiceInput.failure()}>
                                      {(failure) => (
                                        <VoiceFailureBubble
                                          message={t(failure().messageKey)}
                                          offerCloud={failure().offerCloud}
                                          offerRedownload={failure().offerRedownload}
                                          onUseCloud={() => voiceInput.useCloudInstead()}
                                          onRedownload={() => voiceInput.retryDownload()}
                                          onDismiss={() => voiceInput.clearFailure()}
                                        />
                                      )}
                                    </Show>
                                  </>
                                )}
                              </Show>
                            </div>
                          </Show>

                          <Show when={props.ttsAvailable}>
                            <NarrationToggle
                              narration={props.ttsNarration}
                              speaking={props.ttsSpeaking}
                              onToggle={() => props.toggleTtsNarration()}
                            />
                          </Show>

                          {props.questionMode?.actions}

                          <Show
                            when={props.isStreaming}
                            fallback={
                              <Show when={!props.questionMode}>
                              <button
                                type="button"
                                disabled={!hasDraftContent() || props.readOnly}
                                onClick={sendDraft}
                                data-testid="send-btn"
                                class={`inline-flex items-center gap-2 rounded-pill px-4 py-2.5 text-body font-medium transition-colors ${
                                  !hasDraftContent() || props.readOnly
                                    ? "bg-dls-active text-dls-secondary"
                                    : "bg-dls-info text-white hover:bg-[var(--dls-accent-hover)]"
                                }`}
                                title={t("composer.start")}
                              >
                                <ArrowUp size={16} />
                                <span>{t("composer.start")}</span>
                              </button>
                              </Show>
                            }
                          >
                            <button
                              data-testid="stop-btn"
                              type="button"
                              onClick={() => props.onStop()}
                              class="z-10 inline-flex items-center gap-2 rounded-pill border border-dls-danger-border bg-dls-danger-bg px-4 py-2.5 text-body font-medium text-dls-danger-text shadow-none transition-colors hover:bg-dls-danger-bg/80 active:bg-dls-danger-border focus-visible:outline-none"
                              title={t("composer.stop")}
                            >
                              <Square size={13} fill="currentColor" />
                              <span>{t("composer.stop")}</span>
                            </button>
                          </Show>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="px-1 pt-2 text-center text-caption text-dls-secondary">
            {t("composer.ai_disclaimer")}
          </div>
        </div>
      </div >
    </>
  );
}
