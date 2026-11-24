import type { Agent } from "@opencode-ai/sdk/v2/client";
import type { JSX } from "solid-js";
import type {
  ComposerDraft,
  ModelOption,
  ModelRef,
  SlashCommandOption,
} from "../../types";
import type { LocalFolderScan } from "../../lib/tauri";
import type { VoiceInputController } from "~/features/voice-input";
import type { NarrationState } from "~/features/tts";

export type MentionOption = {
  id: string;
  kind: "agent" | "file";
  label: string;
  value: string;
  display: string;
  recent?: boolean;
};

export type MentionGroup = {
  category: "agent" | "recent" | "file";
  items: MentionOption[];
};

/**
 * While the agent waits on a `question`, the composer is where the user types a
 * free-text answer: its editor shows that answer instead of the draft message
 * (the draft comes back afterwards), Enter moves on, and `actions` replace Send.
 */
export type ComposerQuestionMode = {
  placeholder: string;
  /** The question takes no typed answer: the editor is read-only. */
  inputDisabled: boolean;
  /** The typed answer for the current question. */
  text: () => string;
  onTextChange: (text: string) => void;
  /** Enter in the editor. */
  onSubmit: () => void;
  /** Back / Skip / Next, shown where Send is. */
  actions: JSX.Element;
};

export type ComposerProps = {
  prompt: string;
  developerMode: boolean;
  busy: boolean;
  isStreaming: boolean;
  // Disables send while session metadata is still loading. A confirmed
  // subagent transcript never mounts this composer.
  readOnly?: boolean;
  compactTopSpacing?: boolean;
  onSend: (
    draft: ComposerDraft,
    controls: { onAccepted: () => void; submittedAt: number },
  ) => void | false | Promise<void | false>;
  onStop: () => void;
  onDraftChange: (draft: ComposerDraft) => void;
  /** Called with the editor's text before the send gates run. `false` cancels send. */
  onPrepareSend?: (text: string) => boolean | void;
  /** Set while the agent waits on a `question`; see `ComposerQuestionMode`. */
  questionMode?: ComposerQuestionMode;
  selectedModelLabel: string;
  selectedModel: ModelRef;
  selectedModelIsLocal: boolean;
  modelOptions: ModelOption[];
  onSelectModel: (model: ModelRef) => void;
  onManageModels: () => void;
  agentLabel: string;
  selectedAgent: string | null;
  agentPickerOpen: boolean;
  agentPickerBusy: boolean;
  agentPickerReady: boolean;
  agentPickerError: string | null;
  agentOptions: Agent[];
  agentDisplayNames?: Record<string, string>;
  onToggleAgentPicker: () => void;
  onRetryAgentLoad: () => void;
  onSelectAgent: (agent: string | null) => void;
  setAgentPickerRef: (el: HTMLDivElement) => void;
  toast: string | null;
  onToast: (message: string) => void;
  /** Clears `toast`. The toast times itself out and pauses while hovered. */
  onDismissToast?: () => void;
  loadAgentOptions: () => Promise<Agent[]>;
  recentFiles: string[];
  searchFiles: (query: string) => Promise<string[]>;
  isRemoteWorkspace: boolean;
  isSandboxWorkspace: boolean;
  /** Host path of the active workspace; pasted paths under it need no notice. */
  workspaceRoot?: string;
  /** A data: URL for an image in the workspace, or null; drawn in `@` image pills. */
  imageThumbnail?: (path: string) => Promise<string | null>;
  onUploadInboxFiles?: (
    files: File[],
    options?: { notify?: boolean },
  ) => void | Promise<Array<{ name: string; path: string }> | void>;
  attachmentsEnabled: boolean;
  attachmentsDisabledReason: string | null;
  listCommands: () => Promise<SlashCommandOption[]>;
  commandsVersion?: number;
  agentsVersion?: number;
  gmailConnectionStatus?: "none" | "no_credentials" | "no_token" | "ready";
  /** Resolve a still-unknown Gmail status before the credentials guard. */
  ensureGmailCredentials?: () => Promise<unknown>;
  /**
   * Chat this send started in. The credential check awaits without freezing
   * the UI, and dispatch reads whichever chat is selected when it is called.
   */
  selectedSessionId?: string | null;
  confirmEmailAgentCloudRisk?: () => Promise<boolean>;
  onGmailStatusClick?: () => void;
  // Real-time TTS narration toggle, rendered next to the voice-input mic.
  ttsNarration: NarrationState;
  // Whether the backend exposes TTS; the toggle is hidden entirely when false.
  ttsAvailable: boolean;
  ttsSpeaking: boolean;
  toggleTtsNarration: () => void;
  /**
   * Voice-input state from the app shell: mode, local availability, model
   * lifecycle, hotkey and the first-run hint. Optional on purpose — without it
   * the microphone button keeps driving the browser speech service exactly as
   * it did before on-device recognition existed.
   */
  voiceInput?: VoiceInputController;
  /** Opens Settings → Voice input (used by the hint bubble's link). */
  onOpenVoiceSettings?: () => void;
  /** Rendered in the picker row after the model picker. */
  pickerAccessory?: JSX.Element;
};

export type PendingFolderUpload = {
  scan: LocalFolderScan;
  folderName: string;
  /** Called with the folder's inbox path when the upload finishes uncancelled. */
  onUploaded?: (folderPath: string) => void;
};
