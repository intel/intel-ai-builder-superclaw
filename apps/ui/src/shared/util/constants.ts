import type { ModelRef } from "~/shared/types/models";
import type { SuggestedPlugin } from "~/shared/types/extensions";

export const MODEL_PREF_KEY = "openwork.defaultModel";
export const SESSION_MODEL_PREF_KEY = "openwork.sessionModels";
export const THINKING_PREF_KEY = "openwork.showThinking";
export const VARIANT_PREF_KEY = "openwork.modelVariant";
// `LANGUAGE_PREF_KEY` is the one preference key not here: it is private to `~/i18n`,
// which imports no other source layer so that `shared/` may call `t()`. Reaching back
// here for a string would make the two layers mutually dependent.
export const HIDE_TITLEBAR_PREF_KEY = "openwork.hideTitlebar";
export const AUTO_COMPACT_CONTEXT_PREF_KEY = "openwork.autoCompactContext";
export const PII_LEVEL_PREF_KEY = "openwork.piiLevel";
export const UI_TOUR_PREF_KEY = "superclaw.tour.v1";

// Voice-input preferences. Same storage convention as UI_TOUR_PREF_KEY: one
// versioned key per preference, so a future shape change is a new key rather
// than a migration of a blob.
/** "local" | "cloud" — which engine the microphone button uses. Default local. */
export const VOICE_INPUT_MODE_PREF_KEY = "superclaw.voice.mode.v1";
/** "done" once the user pressed "Got it" on the first-recording hint bubble. */
export const VOICE_INPUT_HINT_PREF_KEY = "superclaw.voice.hint.v1";
/**
 * JSON array of in-app hotkeys — key chords and mouse buttons, e.g.
 * `[{"type":"key","codes":["AltRight"]},{"type":"mouse","button":"x1"}]`.
 *
 * `.v2`, and the shape change is exactly why: `.v1` held one `"Ctrl+Shift+Space"`
 * string, which cannot express a list, a bare modifier, or a mouse button. Per the
 * convention above the new shape gets a new key and no migration — a `.v1` value
 * is left in place (harmless, and a downgrade still reads it) while the user gets
 * the new default.
 */
export const VOICE_INPUT_HOTKEY_PREF_KEY = "superclaw.voice.hotkey.v2";
/** `MediaDeviceInfo.deviceId` for local capture; empty means system default. */
export const VOICE_INPUT_DEVICE_PREF_KEY = "superclaw.voice.device.v1";
/** `tts_manager` voice key used for read-aloud, e.g. "english". Default "english". */
export const TTS_VOICE_PREF_KEY = "superclaw.tts.voice.v1";
/**
 * JSON array of Dictionary entries (names, project names, jargon) sent with every
 * on-device `/transcribe` so the contextual beam biases toward them.
 *
 * A JSON blob rather than one key per word, unlike the other four: the value is a
 * list the user edits as a whole, and a per-word key scheme would need its own
 * index key to preserve order — the thing a blob gives for free.
 */
export const VOICE_INPUT_DICTIONARY_PREF_KEY = "superclaw.voice.dictionary.v1";
/**
 * JSON array of Dictionary entries the app added itself, after the user corrected
 * the same word in enough separate recordings.
 *
 * A separate key from the manual list, not a flag inside one list, for two reasons:
 * the origin has to survive a reload so the card can show it, and removing an
 * auto-added word means something different (it writes a tombstone below) from
 * removing one the user typed. The host receives the two lists concatenated.
 */
export const VOICE_INPUT_DICTIONARY_AUTO_PREF_KEY = "superclaw.voice.dictionary.auto.v1";
/**
 * JSON array of normalised words the app must never auto-add again, written when the
 * user removes an auto-added entry.
 *
 * Without it, deleting an auto-added word is futile: the correction evidence that
 * promoted it is still on disk, so the next recording promotes it straight back and
 * the remove button looks broken. Adding the same word manually clears its tombstone.
 */
export const VOICE_INPUT_DICTIONARY_SUPPRESSED_PREF_KEY =
  "superclaw.voice.dictionary.suppressed.v1";
/**
 * JSON array of `{ before, after, count, runIds, lastSeen }` correction records — the
 * evidence behind an auto-added word.
 *
 * Only word pairs, never prose: both sides are at most three words and 40 characters,
 * enforced on write *and* on read. The composer text a correction was found in is
 * diffed in memory and is not stored.
 */
export const VOICE_INPUT_CORRECTIONS_PREF_KEY = "superclaw.voice.corrections.v1";
/**
 * `"on"` once the user opted into the LLM clean-up pass over a dictation.
 *
 * Absent means off, and that is the whole reason this is a key of its own rather
 * than a field on one of the blobs above: on its default mode clean-up sends the
 * dictated text to a cloud model, so it has to be something the user turned on —
 * never something an upgrade, a default, or a migration of someone else's blob
 * turns on for them.
 */
export const VOICE_INPUT_REFINE_PREF_KEY = "superclaw.voice.refine.v1";
/**
 * `"agent" | "local" | "preset"` — which model serves the clean-up pass: the
 * cloud model the user already configured for agents, the on-device model this
 * machine was set up with, or an OpenRouter model reached through the user's own
 * key. Default `"agent"`, which needs nothing extra configured.
 *
 * An unrecognised stored value reads back as the default — the accessor is an
 * allow-list, so a value written by a newer build (or hand-edited) cannot reach
 * the host as a mode it would reject with a 400 `unsupported_mode`.
 */
export const VOICE_INPUT_REFINE_MODE_PREF_KEY = "superclaw.voice.refine.mode.v1";
/**
 * The model id the "this model cannot stop reasoning" hint was last dismissed
 * for — not a boolean.
 *
 * Storing a flag would let one dismissal suppress the warning for every future
 * model: a user who waves it away for Gemini and later points their agents at a
 * different reasoning model would silently never be told. The id makes the
 * dismissal mean "I know about this one", which is the only thing the user
 * actually said.
 */
export const VOICE_INPUT_REFINE_REASONING_HINT_PREF_KEY =
  "superclaw.voice.refine.reasoning_hint.v1";

export const DEFAULT_MODEL: ModelRef = {
  providerID: "llmrouter",
  modelID: "auto",
};

export const SUGGESTED_PLUGINS: SuggestedPlugin[] = [
  {
    name: "opencode-scheduler",
    packageName: "opencode-scheduler",
    description: "Run scheduled jobs with the OpenCode scheduler plugin.",
    tags: ["automation", "jobs"],
    installMode: "simple",
  },
];

export type McpDirectoryInfo = {
  id?: string;
  name: string;
  description: string;
  logo?: string;
  url?: string;
  type?: "remote" | "local";
  command?: string[];
  oauth: boolean;
  clientId?: string;
  clientSecret?: string;
  environment?: Record<string, string>;
  setup?: {
    descriptionKey: string;
    url?: string;
    linkLabelKey?: string;
    callbackUrl?: string;
    inputs: Array<{
      key: string;
      labelKey: string;
      placeholderKey: string;
      type: "text" | "password";
      required?: boolean;
      target:
        | { kind: "oauth"; property: "clientId" | "clientSecret" }
        | { kind: "environment"; name: string }
        | { kind: "commandArgument" }
        | { kind: "workspaceFolderArgument" };
    }>;
  };
  // Extra HTTP headers for remote MCP servers.
  headers?: Record<string, string>;
  // Per-server MCP timeout override, in milliseconds. 
  // For long tool call with no notification (e.g. Minimax video generation)
  // it resorts to MCP SDK default timeout and return timeout error without override
  timeout?: number;
};

type McpCatalogInfo = McpDirectoryInfo & { logo: string };

export const MCP_QUICK_CONNECT: McpCatalogInfo[] = [
  {
    name: "arXiv",
    description: "Search, download, and analyze research papers.",
    logo: "/mcp-logos/arxiv.png",
    type: "local",
    // Pin mcp<2.0.0: arxiv-mcp-server==0.5.0 declares an unbounded `mcp>=1.27.0`
    // dependency, so uvx otherwise resolves the breaking mcp 2.0.0 release
    // (Server.list_prompts was removed), which crashes the server on launch.
    command: ["uvx", "--with", "mcp<2.0.0", "arxiv-mcp-server==0.5.0"],
    oauth: false,
  },
  {
    name: "GitHub",
    description: "Search and manage issues, pull requests, and repos.",
    logo: "/mcp-logos/github.svg",
    url: "https://api.githubcopilot.com/mcp",
    type: "remote",
    oauth: true,
    setup: {
      descriptionKey: "mcp.github_credentials_subtitle",
      url: "https://github.com/settings/developers",
      linkLabelKey: "mcp.github_credentials_link",
      callbackUrl: "http://127.0.0.1:19876/mcp/oauth/callback",
      inputs: [
        {
          key: "clientId",
          labelKey: "mcp.client_id",
          placeholderKey: "mcp.client_id_placeholder_required",
          type: "text",
          required: true,
          target: { kind: "oauth", property: "clientId" },
        },
        {
          key: "clientSecret",
          labelKey: "mcp.client_secret",
          placeholderKey: "mcp.client_secret_placeholder_required",
          type: "password",
          required: true,
          target: { kind: "oauth", property: "clientSecret" },
        },
      ],
    },
  },
  {
    name: "Hugging Face",
    description: "Search models, datasets, papers, and AI applications.",
    logo: "/mcp-logos/hugging-face.svg",
    url: "https://huggingface.co/mcp?login",
    type: "remote",
    oauth: true,
  },
  {
    name: "MarkItDown",
    description: "Convert pdf, powerpoint, word and excel files into Markdown (local tool).",
    logo: "/mcp-logos/microsoft.svg",
    type: "local",
    // Pin mcp<2.0.0 — see the arXiv entry above for why.
    command: [
      "uvx",
      "--with",
      "mcp<2.0.0",
      "--with",
      // mcp 1.8.x imports pydantic._internal._typing_extra.eval_type_backport, removed in pydantic 2.14.
      "pydantic<2.14",
      "markitdown-mcp==0.0.1a4",
    ],
    oauth: false,
  },
  {
    name: "MiniMax",
    description: "Generate speech, images, music, and video with MiniMax.",
    logo: "/mcp-logos/minimax.svg",
    type: "local",
    // Pin mcp<2.0.0 — see the arXiv entry above for why.
    command: ["uvx", "--with", "mcp<2.0.0", "minimax-mcp==0.0.18", "-y"],
    oauth: false,
    // MiniMax video generation (MiniMax-Hailuo) routinely takes 100-150s+
    timeout: 200_000,
    environment: {
      MINIMAX_API_HOST: "https://api.minimax.io",
      MINIMAX_MCP_BASE_PATH: "/minimax",
      MINIMAX_API_RESOURCE_MODE: "url",
    },
    setup: {
      descriptionKey: "mcp.minimax_api_key_description",
      url: "https://www.minimax.io/platform/user-center/basic-information/interface-key",
      linkLabelKey: "mcp.get_api_key",
      inputs: [
        {
          key: "apiKey",
          labelKey: "mcp.api_key",
          placeholderKey: "mcp.api_key_placeholder",
          type: "password",
          required: true,
          target: { kind: "environment", name: "MINIMAX_API_KEY" },
        },
      ],
    },
  },
  {
    name: "Obsidian",
    description: "Read and manage notes in an Obsidian vault.",
    logo: "/mcp-logos/obsidian.svg",
    type: "local",
    command: ["npx", "@bitbonsai/mcpvault@0.12.1"],
    oauth: false,
    setup: {
      descriptionKey: "mcp.obsidian_vault_description",
      inputs: [
        {
          key: "vaultPath",
          labelKey: "mcp.obsidian_vault_path",
          placeholderKey: "mcp.obsidian_vault_path_placeholder",
          type: "text",
          required: true,
          target: { kind: "workspaceFolderArgument" },
        },
      ],
    },
  },
  {
    name: "Perplexity",
    description: "Search the web and run research with Perplexity.",
    logo: "/mcp-logos/perplexity.svg",
    type: "local",
    command: ["npx", "-y", "@perplexity-ai/mcp-server@0.9.0"],
    oauth: false,
    setup: {
      descriptionKey: "mcp.perplexity_api_key_description",
      url: "https://www.perplexity.ai/account/api/group",
      linkLabelKey: "mcp.get_api_key",
      inputs: [
        {
          key: "apiKey",
          labelKey: "mcp.api_key",
          placeholderKey: "mcp.api_key_placeholder",
          type: "password",
          required: true,
          target: { kind: "environment", name: "PERPLEXITY_API_KEY" },
        },
      ],
    },
  },
  {
    name: "Stripe",
    description: "Inspect payments, invoices, and subscriptions.",
    logo: "/mcp-logos/stripe.svg",
    url: "https://mcp.stripe.com",
    type: "remote",
    oauth: true,
  },
];
