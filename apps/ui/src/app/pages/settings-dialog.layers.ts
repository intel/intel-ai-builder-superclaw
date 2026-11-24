export const LAYER = '[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"], .fixed.inset-0';

/**
 * True while an overlay that owns Escape and outside clicks is open above the
 * dialog: one a section renders inside it, or a fixed one elsewhere in the
 * document (a portaled panel, an app-level modal or approval).
 */
export function hasInnerLayer(root: HTMLElement): boolean {
  for (const el of document.querySelectorAll<HTMLElement>(LAYER)) {
    if (el.hasAttribute("data-settings-dialog-layer") || el.contains(root)) continue;
    if (el.getClientRects().length === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.pointerEvents === "none") continue;
    if (root.contains(el) || style.position === "fixed") return true;
  }
  return false;
}
