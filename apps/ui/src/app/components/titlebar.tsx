import { onMount, createSignal, Show } from "solid-js";
import { isTauriRuntime } from "../utils";
import { Minus, Square, X } from "lucide-solid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { HostMcpInfobar } from "~/features/host-mcp";

export default function Titlebar() {
  const [isMaximized, setIsMaximized] = createSignal(false);
  const isTauri = isTauriRuntime();

  onMount(() => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized).catch(() => {});
    win.onResized(() => {
      win.isMaximized().then(setIsMaximized).catch(() => {});
    });
  });

  // The host MCP bar sits in the page flow right under the title bar, in every page that has one.
  if (!isTauri) {
    return <HostMcpInfobar />;
  }

  const handleMinimize = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    getCurrentWindow().minimize();
  };

  const handleMaximize = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const win = getCurrentWindow();
    await win.toggleMaximize();
    setIsMaximized(await win.isMaximized());
  };

  const handleClose = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    getCurrentWindow().close();
  };

  return (
    <>
    <div
      class="flex h-15 w-full shrink-0 select-none items-center justify-between bg-[var(--dls-titlebar)] border-b border-[var(--dls-border)]"
      style={{ "padding-left": "16px", "padding-right": "4px" }}
    >
      {/* Left side: draggable area with app title */}
      <div
        data-tauri-drag-region
        class="flex flex-1 items-center gap-2.5 h-full min-w-0"
      >
        <img
          src="/icon.png"
          alt="Intel SuperClaw"
          width={30}
          height={30}
          class="inline-block select-none pointer-events-none"
          data-tauri-drag-region
        />
        {/* No leading-none: line-height 1 lets bg-clip-text clip the p descender (#3630). */}
        <span
          data-tauri-drag-region
          class="text-display font-bold tracking-tight select-none text-transparent bg-clip-text"
          style={{ "background-image": "var(--dls-titlebar-wordmark-gradient)" }}
        >
          Intel SuperClaw
        </span>
      </div>

      {/* Right side: Window controls — NOT inside drag region */}
      <div class="flex items-center h-full shrink-0">
        <button
          class="inline-flex h-8 w-11 items-center justify-center rounded-compact transition-colors hover:bg-dls-hover/60 text-dls-secondary hover:text-dls-text"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleMinimize}
          title="Minimize"
        >
          <Minus size={15} />
        </button>
        <button
          class="inline-flex h-8 w-11 items-center justify-center rounded-compact transition-colors hover:bg-dls-hover/60 text-dls-secondary hover:text-dls-text"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleMaximize}
          title={isMaximized() ? "Restore" : "Maximize"}
        >
          <Show when={isMaximized()} fallback={<Square size={13} />}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.2">
              <rect x="2.5" y="4.5" width="7" height="7" rx="1" />
              <path d="M4.5 4.5V2.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2" />
            </svg>
          </Show>
        </button>
        <button
          class="group inline-flex h-8 w-11 items-center justify-center rounded-compact transition-colors text-dls-secondary hover:bg-dls-danger-border-solid hover:text-white"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleClose}
          title="Close"
        >
          <X size={15} />
        </button>
      </div>
    </div>
    <HostMcpInfobar />
    </>
  );
}
