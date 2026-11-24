import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { Boxes, Check, Copy, Download, Eye, EyeOff, FolderCode, Key, Link as LinkIcon, X } from "lucide-solid";

export type ShareField = {
  label: string;
  value: string;
  secret?: boolean;
  placeholder?: string;
  hint?: string;
};

export default function ShareWorkspaceModal(props: {
  open: boolean;
  onClose: () => void;
  title?: string;
  workspaceName: string;
  workspaceDetail?: string | null;
  fields: ShareField[];
  note?: string | null;
  publisherBaseUrl?: string;
  onShareWorkspaceProfile?: () => void;
  shareWorkspaceProfileBusy?: boolean;
  shareWorkspaceProfileUrl?: string | null;
  shareWorkspaceProfileError?: string | null;
  shareWorkspaceProfileDisabledReason?: string | null;
  onShareSkillsSet?: () => void;
  onOpenSingleSkillShare?: () => void;
  shareSkillsSetBusy?: boolean;
  shareSkillsSetUrl?: string | null;
  shareSkillsSetError?: string | null;
  shareSkillsSetDisabledReason?: string | null;
  onExportConfig?: () => void;
  exportDisabledReason?: string | null;
  onOpenBots?: () => void;
}) {
  const [activeTab, setActiveTab] = createSignal<"access" | "links">("access");
  const [revealedByIndex, setRevealedByIndex] = createSignal<Record<number, boolean>>({});
  const [copiedKey, setCopiedKey] = createSignal<string | null>(null);

  const title = createMemo(() => props.title ?? "Share project");
  const detail = createMemo(() => props.workspaceDetail?.trim() ?? "");
  const note = createMemo(() => props.note?.trim() ?? "");

  // Derived initial character for avatar
  const avatarLetter = createMemo(() => (props.workspaceName ? props.workspaceName.charAt(0).toUpperCase() : "M"));

  createEffect(() => {
    if (!props.open) return;
    setRevealedByIndex({});
    setCopiedKey(null);
    setActiveTab("access");
  });

  createEffect(() => {
    if (!props.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  const handleCopy = async (value: string, key: string) => {
    const text = value?.trim() ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 dls-modal-backdrop flex items-center justify-center p-4 font-sans animate-in fade-in duration-200">
        <div
          class="border w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-300 relative flex flex-col max-h-[90vh] dls-modal-surface"
          role="dialog"
        >
          {/* Header Section */}
          <div class="px-6 pt-6 pb-4 relative border-b border-transparent shrink-0">
            <button
              onClick={props.onClose}
              class="absolute top-6 right-6 p-1.5 text-dls-muted hover:text-dls-text hover:bg-dls-hover rounded-control transition-all"
              aria-label="Close"
              title="Close"
            >
              <X size={20} stroke-width={2.5} />
            </button>

            <div class="flex items-center gap-3">
              <div class="w-10 h-10 bg-dls-inverse-surface rounded-inset flex items-center justify-center text-dls-inverse-text font-bold text-heading">
                {avatarLetter()}
              </div>
              <div>
                <h2 class="text-heading font-bold text-dls-text tracking-tight">{title()}</h2>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="text-body font-semibold text-dls-secondary">{props.workspaceName}</span>
                  <Show when={detail()}>
                    <span class="w-1 h-1 rounded-pill bg-dls-neutral-dot"></span>
                    <span class="text-caption text-dls-muted truncate max-w-[180px] font-mono">{detail()}</span>
                  </Show>
                </div>
              </div>
            </div>

            {/* Tab Switcher */}
            <div class="flex p-1 bg-dls-surface-raised rounded-inset mt-6 border border-dls-border">
              <button
                onClick={() => setActiveTab("access")}
                class={`flex-1 flex items-center justify-center gap-2 text-body font-bold py-2 px-3 rounded-control transition-all ${
                  activeTab() === "access"
                    ? "bg-dls-surface-solid shadow-sm text-dls-text border border-dls-border"
                    : "text-dls-muted hover:text-dls-secondary hover:bg-dls-hover/50"
                }`}
              >
                <Key size={14} stroke-width={activeTab() === "access" ? 2.5 : 2} />
                Live Access
              </button>
              <button
                onClick={() => setActiveTab("links")}
                class={`flex-1 flex items-center justify-center gap-2 text-body font-bold py-2 px-3 rounded-control transition-all ${
                  activeTab() === "links"
                    ? "bg-dls-surface-solid shadow-sm text-dls-text border border-dls-border"
                    : "text-dls-muted hover:text-dls-secondary hover:bg-dls-hover/50"
                }`}
              >
                <LinkIcon size={14} stroke-width={activeTab() === "links" ? 2.5 : 2} />
                Public Links
              </button>
            </div>
          </div>

          {/* Main Content Area */}
          <div class="px-6 pb-8 flex-1 overflow-y-auto scrollbar-hide">
            {/* TAB: LIVE ACCESS */}
            <Show when={activeTab() === "access"}>
              <div class="space-y-6 pt-2 animate-in fade-in slide-in-from-bottom-3 duration-300">
                <div class="bg-dls-warning-bg border border-dls-warning-border p-3 rounded-inset">
                  <p class="text-body text-dls-warning-text leading-relaxed flex items-start gap-2">
                    <span class="mt-0.5">⚠️</span>
                    <span>Share with trusted people only. These credentials grant direct access to your local environment.</span>
                  </p>
                </div>

                <div class="space-y-5">
                  <For each={props.fields}>
                    {(field, index) => {
                      const key = () => `${field.label}:${index()}`;
                      const isSecret = () => Boolean(field.secret);
                      const revealed = () => Boolean(revealedByIndex()[index()]);

                      return (
                        <div class="group">
                          <label class="text-caption font-bold text-dls-muted uppercase tracking-wider mb-2 block ml-1">
                            {field.label}
                          </label>
                          <div class="relative flex items-center">
                            <input
                              type={isSecret() && !revealed() ? "password" : "text"}
                              readonly
                              value={field.value || field.placeholder || ""}
                              class="w-full bg-dls-surface-raised border border-dls-border group-hover:border-dls-border rounded-inset py-3 pl-4 pr-24 text-body font-mono text-dls-text transition-all outline-none focus:ring-2 focus:ring-dls-panel-dot/40 focus:bg-dls-surface-solid"
                            />
                            <div class="absolute right-2 flex items-center gap-1">
                              <Show when={isSecret()}>
                                <button
                                  onClick={() =>
                                    setRevealedByIndex((prev) => ({
                                      ...prev,
                                      [index()]: !prev[index()],
                                    }))
                                  }
                                  disabled={!field.value}
                                  class="p-2 text-dls-muted hover:text-dls-text hover:bg-dls-hover/50 rounded-control transition-all disabled:opacity-50"
                                >
                                  <Show when={revealed()} fallback={<Eye size={16} />}>
                                    <EyeOff size={16} />
                                  </Show>
                                </button>
                              </Show>
                              <button
                                onClick={() => handleCopy(field.value, key())}
                                disabled={!field.value}
                                class="p-2 text-dls-muted hover:text-dls-text hover:bg-dls-hover/50 rounded-control transition-all disabled:opacity-50"
                              >
                                <Show when={copiedKey() === key()} fallback={<Copy size={16} />}>
                                  <Check size={16} class="text-dls-success-text" />
                                </Show>
                              </button>
                            </div>
                          </div>
                          <Show when={field.hint && field.hint.trim()}>
                            <p class="text-caption text-dls-muted mt-2 ml-1 italic">{field.hint}</p>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
                
                <Show when={note()}>
                  <div class="rounded-inset border border-dls-border bg-dls-surface-raised/40 px-4 py-3 text-body text-dls-secondary mt-6">
                    {note()}
                  </div>
                </Show>
              </div>
            </Show>

            {/* TAB: PUBLIC LINKS */}
            <Show when={activeTab() === "links"}>
              <div class="space-y-4 pt-2 animate-in fade-in slide-in-from-bottom-3 duration-300">
                <div class="mb-4">
                  <p class="text-body-lg text-dls-secondary font-medium">Publish snapshot configurations</p>
                  <p class="text-caption text-dls-muted mt-0.5">Static links for sharing your setup with the community.</p>
                  <Show when={props.publisherBaseUrl?.trim()}>
                    <p class="text-label text-dls-muted mt-1 font-mono">Publisher: {props.publisherBaseUrl}</p>
                  </Show>
                </div>

                {/* Card: Workspace Profile */}
                <div class="bg-dls-surface-solid border border-dls-border rounded-card p-4 shadow-sm hover:shadow-md transition-all group">
                  <div class="flex items-center gap-3 mb-3">
                    <div class="p-2 bg-dls-surface-raised rounded-control text-dls-muted group-hover:text-dls-text group-hover:bg-dls-hover transition-colors">
                      <FolderCode size={18} />
                    </div>
                    <div class="flex-1">
                      <h3 class="text-body-lg font-bold text-dls-text">Workspace profile</h3>
                      <p class="text-caption text-dls-muted leading-tight">Config, MCP, and skill bundles.</p>
                    </div>
                  </div>
                  
                  <Show when={props.shareWorkspaceProfileError?.trim()}>
                    <div class="rounded-control border border-dls-danger-border bg-dls-danger-bg p-2 mb-3 text-caption text-dls-danger-text">
                      {props.shareWorkspaceProfileError}
                    </div>
                  </Show>
                  <Show when={props.shareWorkspaceProfileDisabledReason?.trim()}>
                    <div class="text-caption text-dls-muted mb-3">{props.shareWorkspaceProfileDisabledReason}</div>
                  </Show>

                  <Show 
                    when={props.shareWorkspaceProfileUrl?.trim()} 
                    fallback={
                      <button
                        onClick={() => props.onShareWorkspaceProfile?.()}
                        disabled={Boolean(props.shareWorkspaceProfileDisabledReason) || !props.onShareWorkspaceProfile || props.shareWorkspaceProfileBusy}
                        class="w-full py-2.5 bg-dls-inverse-surface hover:bg-dls-inverse-hover text-dls-inverse-text text-body font-bold rounded-inset transition-all active:scale-[0.98] disabled:opacity-50"
                      >
                        {props.shareWorkspaceProfileBusy ? "Publishing..." : "Create Public Link"}
                      </button>
                    }
                  >
                    <div class="flex items-center gap-2 animate-in fade-in zoom-in-95 duration-200">
                      <input
                        type="text"
                        readonly
                        value={props.shareWorkspaceProfileUrl!}
                        class="flex-1 bg-dls-surface-raised border border-dls-border rounded-control py-2 px-3 text-caption font-mono text-dls-secondary outline-none"
                      />
                      <button
                        onClick={() => handleCopy(props.shareWorkspaceProfileUrl ?? "", "share-workspace-profile")}
                        class="p-2 bg-dls-inverse-surface text-dls-inverse-text rounded-control hover:bg-dls-inverse-hover transition-colors"
                      >
                        <Show when={copiedKey() === "share-workspace-profile"} fallback={<Copy size={16} />}>
                          <Check size={16} />
                        </Show>
                      </button>
                    </div>
                    <button
                      onClick={() => props.onShareWorkspaceProfile?.()}
                      disabled={props.shareWorkspaceProfileBusy}
                      class="mt-3 w-full py-2 bg-dls-surface-raised hover:bg-dls-hover text-dls-secondary hover:text-dls-text text-caption font-bold rounded-control transition-all"
                    >
                      {props.shareWorkspaceProfileBusy ? "Publishing..." : "Regenerate Link"}
                    </button>
                  </Show>
                </div>

                {/* Card: Skills Set */}
                <div class="bg-dls-surface-solid border border-dls-border rounded-card p-4 shadow-sm hover:shadow-md transition-all group">
                  <div class="flex items-center gap-3 mb-3">
                    <div class="p-2 bg-dls-surface-raised rounded-control text-dls-muted group-hover:text-dls-text group-hover:bg-dls-hover transition-colors">
                      <Boxes size={18} />
                    </div>
                    <div class="flex-1">
                      <h3 class="text-body-lg font-bold text-dls-text">Skills set</h3>
                      <p class="text-caption text-dls-muted leading-tight">Publish all installed skills as one bundle.</p>
                    </div>
                  </div>
                  
                  <Show when={props.shareSkillsSetError?.trim()}>
                    <div class="rounded-control border border-dls-danger-border bg-dls-danger-bg p-2 mb-3 text-caption text-dls-danger-text">
                      {props.shareSkillsSetError}
                    </div>
                  </Show>
                  <Show when={props.shareSkillsSetDisabledReason?.trim()}>
                    <div class="text-caption text-dls-muted mb-3">{props.shareSkillsSetDisabledReason}</div>
                  </Show>

                  <Show 
                    when={props.shareSkillsSetUrl?.trim()} 
                    fallback={
                      <div class="space-y-2">
                        <button
                          onClick={() => props.onShareSkillsSet?.()}
                          disabled={Boolean(props.shareSkillsSetDisabledReason) || !props.onShareSkillsSet || props.shareSkillsSetBusy}
                          class="w-full py-2.5 bg-dls-surface-raised hover:bg-dls-hover text-dls-text text-body font-bold rounded-inset transition-all disabled:opacity-50"
                        >
                          {props.shareSkillsSetBusy ? "Publishing..." : "Create Skill Link"}
                        </button>
                        <button
                          onClick={() => props.onOpenSingleSkillShare?.()}
                          disabled={!props.onOpenSingleSkillShare}
                          class="w-full py-2.5 bg-dls-surface-solid border border-dls-border hover:bg-dls-hover text-dls-secondary hover:text-dls-text text-body font-bold rounded-inset transition-all disabled:opacity-50"
                        >
                          Share Single Skill
                        </button>
                      </div>
                    }
                  >
                    <div class="flex items-center gap-2 animate-in fade-in zoom-in-95 duration-200">
                      <input
                        type="text"
                        readonly
                        value={props.shareSkillsSetUrl!}
                        class="flex-1 bg-dls-surface-raised border border-dls-border rounded-control py-2 px-3 text-caption font-mono text-dls-secondary outline-none"
                      />
                      <button
                        onClick={() => handleCopy(props.shareSkillsSetUrl ?? "", "share-skills-set")}
                        class="p-2 bg-dls-surface-raised hover:bg-dls-hover text-dls-text rounded-control transition-colors border border-dls-border"
                      >
                        <Show when={copiedKey() === "share-skills-set"} fallback={<Copy size={16} />}>
                          <Check size={16} class="text-dls-success-text" />
                        </Show>
                      </button>
                    </div>
                    <button
                      onClick={() => props.onShareSkillsSet?.()}
                      disabled={props.shareSkillsSetBusy}
                      class="mt-3 w-full py-2 bg-dls-surface-raised hover:bg-dls-hover text-dls-secondary hover:text-dls-text text-caption font-bold rounded-control transition-all"
                    >
                      {props.shareSkillsSetBusy ? "Publishing..." : "Regenerate Link"}
                    </button>
                  </Show>
                </div>

                {/* Section: Local Export */}
                <div class="pt-4 mt-2 border-t border-dls-border-soft">
                  <div class="flex items-center justify-between p-3 bg-dls-surface-raised rounded-card group hover:bg-dls-hover transition-all border border-dls-border">
                    <div class="flex items-center gap-3">
                      <div class="p-2 bg-dls-surface-solid rounded-control text-dls-muted shadow-sm border border-dls-border">
                        <Download size={18} />
                      </div>
                      <div>
                        <h4 class="text-body font-bold text-dls-text">Config bundle</h4>
                        <p class="text-caption text-dls-secondary">{props.exportDisabledReason?.trim() || "Export .opencode local files"}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => props.onExportConfig?.()}
                      disabled={!props.onExportConfig || Boolean(props.exportDisabledReason)}
                      class="px-4 py-2 bg-dls-surface-solid border border-dls-border hover:border-dls-border hover:text-dls-text rounded-inset text-caption font-bold text-dls-secondary transition-all shadow-sm disabled:opacity-50 disabled:hover:border-dls-border disabled:hover:text-dls-secondary"
                    >
                      Export
                    </button>
                  </div>
                </div>

                {/* Section: Bots */}
                <div class="pt-2">
                  <div class="flex items-center justify-between p-3 bg-dls-surface-raised rounded-card group hover:bg-dls-hover transition-all border border-dls-border">
                    <div class="flex items-center gap-3">
                      <div class="p-2 bg-dls-surface-solid rounded-control text-dls-muted shadow-sm border border-dls-border relative overflow-hidden flex items-center justify-center font-bold font-mono">
                        B
                        <div class="absolute inset-0 bg-dls-warm-accent opacity-20"></div>
                      </div>
                      <div>
                        <div class="flex items-center gap-2">
                          <h4 class="text-body font-bold text-dls-text">Bots</h4>
                          <span class="text-tiny px-1.5 py-0.5 uppercase tracking-wider font-bold rounded-pill border border-dls-border text-dls-secondary bg-dls-surface-solid">alpha</span>
                        </div>
                        <p class="text-caption text-dls-secondary">Configure messaging surfaces</p>
                      </div>
                    </div>
                    <button
                      onClick={() => props.onOpenBots?.()}
                      disabled={!props.onOpenBots}
                      class="px-4 py-2 bg-dls-surface-solid border border-dls-border hover:border-dls-border hover:text-dls-text rounded-inset text-caption font-bold text-dls-secondary transition-all shadow-sm disabled:opacity-50 disabled:hover:border-dls-border disabled:hover:text-dls-secondary"
                    >
                      Open setup
                    </button>
                  </div>
                </div>
              </div>
            </Show>
          </div>

          {/* Persistent Footer Shadow Fade */}
          <div class="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-dls-surface-solid to-transparent pointer-events-none rounded-b-card" />
        </div>
      </div>
    </Show>
  );
}
