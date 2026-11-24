import { Show, type JSX, onCleanup, createEffect } from "solid-js";
import { X } from "lucide-solid";

type SidebarDrawerProps = {
  open: boolean;
  onClose: () => void;
  children: JSX.Element;
  ariaLabel?: string;
  hiddenClass?: string;
};

export default function SidebarDrawer(props: SidebarDrawerProps) {
  const hiddenClass = props.hiddenClass || 'lg:hidden';
  // close on Escape key
  createEffect(() => {
    if (!props.open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <Show when={props.open}>
      {/* Backdrop */}
      <div
        class={`fixed inset-0 z-40 bg-black/50 backdrop-blur-sm ${hiddenClass}`}
        aria-hidden="true"
        onClick={props.onClose}
      />

      {/* Panel Backdrop*/}
      <div
        class={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col rounded-r-shell border-r border-dls-border bg-dls-sidebar p-2.5 shadow-xl ${hiddenClass}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.ariaLabel || "Sidebar"}
      >
        {/* Close button */}
        <div class="mb-1 flex justify-end">
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-control text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            onClick={props.onClose}
            aria-label="Close sidebar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Sidebar content */}
        <div class="flex flex-1 flex-col overflow-hidden">
          {props.children}
        </div>
      </div>
    </Show>
  );
}
