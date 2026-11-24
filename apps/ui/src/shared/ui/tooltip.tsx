import { createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

let tooltipIdCounter = 0;

const GAP = 8;
const VIEWPORT_MARGIN = 8;

export type TooltipProps = {
    content: string;
    children: JSX.Element;
    delayMs?: number;
    placement?: "top" | "bottom" | "left" | "right";
    placementOffset?: number;
    class?: string;
    maxWidthClass?: string;
    /** Bubble stacking class; raise it for triggers inside a modal that sits above `z-[999]`. */
    zIndexClass?: string;
    /** When true, tooltip follows the pointer (above cursor) instead of centering on the trigger. */
    anchorToCursor?: boolean;
    /** When true, trigger is tab-focusable and shows the tooltip on focus (keyboard/screen reader). */
    focusable?: boolean;
    disabled?: boolean;
};

export function Tooltip(props: TooltipProps) {
    const [open, setOpen] = createSignal(false);
    const [coords, setCoords] = createSignal({ top: -9999, left: -9999 });
    const [resolvedPlacement, setResolvedPlacement] = createSignal<"top" | "bottom" | "left" | "right">("top");
    const id = `tooltip-${++tooltipIdCounter}`;

    let triggerEl: HTMLSpanElement | undefined;
    let bubbleEl: HTMLDivElement | undefined;
    let showTimeout: number | undefined;
    let cursorX = 0;
    let cursorY = 0;

    const reposition = () => {
        if (!bubbleEl) return;
        const bubbleRect = bubbleEl.getBoundingClientRect();
        const placement = props.placement ?? "top";
        const preferredGap = GAP + (props.placementOffset ?? 0);

        let top: number;
        let left: number;
        let side: "top" | "bottom" | "left" | "right" = placement;

        if (props.anchorToCursor) {
            top = cursorY - GAP - bubbleRect.height;
            left = cursorX - bubbleRect.width / 2;
            side = "top";
            if (top < VIEWPORT_MARGIN) {
                side = "bottom";
                top = cursorY + GAP;
            }
            left = Math.min(Math.max(left, VIEWPORT_MARGIN), window.innerWidth - bubbleRect.width - VIEWPORT_MARGIN);
            top = Math.min(Math.max(top, VIEWPORT_MARGIN), window.innerHeight - bubbleRect.height - VIEWPORT_MARGIN);
            setResolvedPlacement(side);
            setCoords({ top, left });
            return;
        }

        if (!triggerEl) return;
        const rect = triggerEl.getBoundingClientRect();

        if (placement === "left") {
            left = rect.left - GAP - bubbleRect.width;
            top = rect.top + rect.height / 2 - bubbleRect.height / 2;
            if (left < VIEWPORT_MARGIN) {
                side = "right";
                left = rect.right + GAP;
            }
        } else if (placement === "right") {
            left = rect.right + preferredGap;
            top = rect.top + rect.height / 2 - bubbleRect.height / 2;
            if (left + bubbleRect.width > window.innerWidth - VIEWPORT_MARGIN) {
                side = "left";
                left = rect.left - GAP - bubbleRect.width;
            }
        } else if (placement === "bottom") {
            top = rect.bottom + GAP;
            left = rect.left + rect.width / 2 - bubbleRect.width / 2;
            if (top + bubbleRect.height > window.innerHeight - VIEWPORT_MARGIN) {
                side = "top";
                top = rect.top - GAP - bubbleRect.height;
            }
        } else {
            top = rect.top - GAP - bubbleRect.height;
            left = rect.left + rect.width / 2 - bubbleRect.width / 2;
            if (top < VIEWPORT_MARGIN) {
                side = "bottom";
                top = rect.bottom + GAP;
            }
        }

        left = Math.min(Math.max(left, VIEWPORT_MARGIN), window.innerWidth - bubbleRect.width - VIEWPORT_MARGIN);
        top = Math.min(Math.max(top, VIEWPORT_MARGIN), window.innerHeight - bubbleRect.height - VIEWPORT_MARGIN);

        setResolvedPlacement(side);
        setCoords({ top, left });
    };

    const trackCursor = (event: MouseEvent) => {
        cursorX = event.clientX;
        cursorY = event.clientY;
        if (open() && props.anchorToCursor) {
            requestAnimationFrame(reposition);
        }
    };

    const show = (event?: MouseEvent) => {
        if (event) {
            cursorX = event.clientX;
            cursorY = event.clientY;
        }
        if (props.disabled) return;
        if (showTimeout) window.clearTimeout(showTimeout);
        const delay = props.delayMs ?? 0;
        if (delay <= 0) {
            setOpen(true);
            return;
        }
        showTimeout = window.setTimeout(() => setOpen(true), delay);
    };

    const hide = () => {
        if (showTimeout) window.clearTimeout(showTimeout);
        showTimeout = undefined;
        setOpen(false);
    };

    onCleanup(() => {
        if (showTimeout) window.clearTimeout(showTimeout);
    });

    createEffect(() => {
        if (!props.disabled) return;
        hide();
    });

    createEffect(() => {
        if (!open()) return;
        requestAnimationFrame(reposition);

        const handleReflow = () => reposition();
        window.addEventListener("scroll", handleReflow, true);
        window.addEventListener("resize", handleReflow);
        onCleanup(() => {
            window.removeEventListener("scroll", handleReflow, true);
            window.removeEventListener("resize", handleReflow);
        });
    });

    const isBottom = () => resolvedPlacement() === "bottom";
    const isLeft = () => resolvedPlacement() === "left";
    const isRight = () => resolvedPlacement() === "right";
    const fullWidthTrigger = () => /\bw-full\b/.test(props.class ?? "");
    const focusableTrigger = () => props.focusable === true;

    const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            hide();
        }
    };

    return (
        <span
            ref={triggerEl}
            class={`items-center ${props.class ?? "inline-flex align-middle leading-normal"} ${focusableTrigger() ? "rounded-micro focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--dls-accent-rgb)/0.35)]" : ""}`}
            tabIndex={focusableTrigger() ? 0 : undefined}
            aria-describedby={focusableTrigger() && open() ? id : undefined}
            onMouseEnter={(event) => show(event)}
            onMouseMove={props.anchorToCursor ? trackCursor : undefined}
            onMouseLeave={hide}
            onFocusIn={() => show()}
            onFocusOut={hide}
            onKeyDown={focusableTrigger() ? handleKeyDown : undefined}
        >
            <span
                aria-describedby={!focusableTrigger() && open() ? id : undefined}
                class={fullWidthTrigger() ? "flex w-full min-w-0 leading-normal" : "block min-w-0 max-w-full leading-none"}
            >
                {props.children}
            </span>
            {open() && (
                <Portal>
                    <div
                        ref={bubbleEl}
                        id={id}
                        role="tooltip"
                        style={{ position: "fixed", top: `${coords().top}px`, left: `${coords().left}px` }}
                        class={`pointer-events-none ${props.zIndexClass ?? "z-[999]"} w-max ${props.maxWidthClass ?? "max-w-[320px]"} whitespace-pre-line break-words rounded-control border border-dls-border bg-dls-surface-solid px-2.5 py-1.5 font-sans text-label leading-relaxed text-dls-text opacity-100 shadow-[var(--dls-card-shadow)] transition-opacity duration-150`}
                    >
                        {props.content}
                        <span
                            class={`absolute size-1.5 rotate-45 border-dls-border bg-dls-surface-solid ${isLeft()
                                ? "left-full top-1/2 -translate-x-1/2 -translate-y-1/2 border-r border-t"
                                : isRight()
                                    ? "right-full top-1/2 translate-x-1/2 -translate-y-1/2 border-l border-b"
                                    : isBottom()
                                        ? "left-1/2 -top-[3px] -translate-x-1/2 border-l border-t"
                                        : "left-1/2 -bottom-[3px] -translate-x-1/2 border-b border-r"
                                }`}
                        />
                    </div>
                </Portal>
            )}
        </span>
    );
}