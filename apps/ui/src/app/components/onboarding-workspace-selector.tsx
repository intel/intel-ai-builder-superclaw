import { For, Show, createEffect, createSignal } from "solid-js";

import { CheckCircle2, FolderPlus, Loader2 } from "lucide-solid";

import Button from "./button";

export default function OnboardingWorkspaceSelector(props: {
  defaultPath: string;
  onConfirm: (preset: "starter" | "automation" | "minimal", folder: string | null) => void;
  onPickFolder: () => Promise<string | null>;
}) {
  const [preset, setPreset] = createSignal<"starter" | "automation" | "minimal">("starter");
  const [selectedFolder, setSelectedFolder] = createSignal(props.defaultPath);
  const [pickingFolder, setPickingFolder] = createSignal(false);

  const options = () => [
    {
      id: "starter" as const,
      name: "Starter project",
      desc: "Preconfigured to show you how to use plugins, commands, and skills.",
    },
    {
      id: "minimal" as const,
      name: "Empty project",
      desc: "Start with a blank folder and add what you need.",
    },
  ];

  const canContinue = () => Boolean(selectedFolder().trim());

  createEffect(() => {
    if (!selectedFolder().trim()) {
      setSelectedFolder(props.defaultPath);
    }
  });

  const handlePickFolder = async () => {
    if (pickingFolder()) return;
    setPickingFolder(true);
    try {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const next = await props.onPickFolder();
      if (next) {
        setSelectedFolder(next);
      }
    } finally {
      setPickingFolder(false);
    }
  };

  return (
    <div class="bg-dls-surface-solid border border-dls-border rounded-card overflow-hidden flex flex-col max-h-[90vh]">
      <div class="p-6 flex-1 overflow-y-auto space-y-8">
        <div class="space-y-4">
          <div class="flex items-center gap-3 text-body-lg font-medium text-dls-text">
            <div class="w-6 h-6 rounded-pill bg-dls-surface-muted flex items-center justify-center text-caption">1</div>
            Select Folder
          </div>
          <div class="ml-9">
            <div
              class={`w-full border border-dashed border-dls-border bg-dls-panel-inset-bg rounded-inset p-4 text-left transition ${
                pickingFolder() ? "opacity-70" : "hover:border-dls-active"
              }`.trim()}
            >
              <div class="flex items-center gap-3 text-dls-text">
                <FolderPlus size={20} class="text-dls-secondary" />
                <input
                  class="flex-1 min-w-0 bg-transparent text-body-lg font-medium text-dls-text placeholder:text-dls-secondary focus:outline-none"
                  value={selectedFolder()}
                  onInput={(e) => setSelectedFolder(e.currentTarget.value)}
                  placeholder={props.defaultPath}
                />
                <button
                  type="button"
                  onClick={handlePickFolder}
                  disabled={pickingFolder()}
                  class="text-caption text-dls-secondary hover:text-dls-text transition-colors"
                >
                  <Show
                    when={pickingFolder()}
                    fallback={<span>Choose</span>}
                  >
                    <span class="inline-flex items-center gap-2">
                      <Loader2 size={12} class="animate-spin" />
                      Opening...
                    </span>
                  </Show>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="space-y-4">
          <div class="flex items-center gap-3 text-body-lg font-medium text-dls-text">
            <div class="w-6 h-6 rounded-pill bg-dls-surface-muted flex items-center justify-center text-caption">2</div>
            Choose Preset
          </div>
          <div class={`ml-9 grid gap-3 ${!canContinue() ? "opacity-50" : ""}`.trim()}>
            <For each={options()}>
              {(opt) => (
                <div
                  onClick={() => {
                    if (!canContinue()) return;
                    setPreset(opt.id);
                  }}
                  class={`p-4 rounded-inset border cursor-pointer transition-all ${
                    preset() === opt.id
                      ? "bg-dls-surface-muted border-dls-border hover:border-dls-border"
                      : "bg-dls-panel-inset-bg border-dls-border hover:border-dls-border"
                  } ${!canContinue() ? "pointer-events-none" : ""}`.trim()}
                >
                  <div class="flex justify-between items-start">
                    <div>
                      <div
                        class={`font-medium text-body-lg ${
                          preset() === opt.id ? "text-dls-accent" : "text-dls-text"
                        }`}
                      >
                        {opt.name}
                      </div>
                      <div class="text-caption text-dls-secondary mt-1">{opt.desc}</div>
                    </div>
                    <Show when={preset() === opt.id}>
                      <CheckCircle2 size={16} class="text-dls-accent" />
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>

    </div>
  );
}
