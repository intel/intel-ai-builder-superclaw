import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount } from "solid-js";
import { marked } from "marked";
import { Shield } from "lucide-solid";

import { t } from "../../../i18n";
import type { OpenworkServerClient } from "../../lib/openwork-server";
import type { MaskedReview } from "~/shared/platform/transport/openwork-server.types";
import Button from "../button";
import { createPreviewRenderer } from "../file-preview-modal";
import { isPlaceholderTerm, splitTerms, type MaskedReviewOperation } from "./masked-entity-review";

const fileName = (path?: string) => (path ?? "").split(/[\\/]/).pop() ?? "";

const FOCUSABLE = "summary, a[href], button:not([disabled]), textarea:not([disabled])";

function MaskedPreview(props: { review: MaskedReview }) {
  const isMarkdown = () => props.review.preview_format === "markdown";
  // Placeholders such as <ORG_1> must show as literal text, which the preview renderer's
  // raw-HTML escaping guarantees.
  const html = createMemo(() => {
    const text = props.review.masked_text;
    if (!text || !isMarkdown()) return "";
    try {
      // The user reviews this text for terms masking missed, so an SVG stays full source: a
      // drawing would hide its comments, metadata and attributes.
      const renderer = createPreviewRenderer("light", { drawSvg: false });
      // File content is untrusted: show images as text so previewing never fetches a URL.
      renderer.image = ({ text, href }: { text: string; href: string }) =>
        (text || href).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      const result = marked.parse(text, {
        breaks: true,
        gfm: true,
        renderer,
        async: false,
      });
      return typeof result === "string" ? result : "";
    } catch {
      return "";
    }
  });

  return (
    <Show
      when={html()}
      fallback={
        <pre class="whitespace-pre-wrap break-words text-caption font-mono text-dls-text">
          {props.review.masked_text}
        </pre>
      }
    >
      <div
        class="max-w-none text-dls-text leading-relaxed
          [&_h1]:text-title [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-3
          [&_h2]:text-title [&_h2]:mt-4 [&_h2]:mb-2
          [&_p]:text-body-lg [&_p]:mb-3
          [&_ul]:my-2 [&_ul]:ml-4 [&_ul]:list-disc
          [&_ol]:my-2 [&_ol]:ml-4 [&_ol]:list-decimal
          [&_table]:w-full [&_table]:my-3 [&_table]:border-collapse
          [&_th]:text-left [&_th]:border [&_th]:border-dls-border [&_th]:px-3 [&_th]:py-2 [&_th]:bg-dls-surface [&_th]:text-caption [&_th]:font-semibold
          [&_td]:border [&_td]:border-dls-border [&_td]:px-3 [&_td]:py-2 [&_td]:text-caption"
        innerHTML={html()}
      />
    </Show>
  );
}

/**
 * Focus and keys follow `PermissionApprovalDialog`: focus goes to the dialog itself, stays inside
 * until it closes and then returns to where it was, and keys pressed inside do not reach the page's
 * shortcuts. Escape is not bound, so it never answers the review.
 */
export default function MaskedEntityReviewDialog(props: {
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  operations: MaskedReviewOperation[];
  busy: boolean;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  let dialog: HTMLDivElement | undefined;
  const [reviews, setReviews] = createSignal<MaskedReview[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [input, setInput] = createSignal("");
  const [working, setWorking] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [notFound, setNotFound] = createSignal<string[]>([]);
  const alreadyMasked = createMemo(() => splitTerms(input()).filter(isPlaceholderTerm));
  const [addedTerms, setAddedTerms] = createSignal<string[]>([]);
  // The not-found words the user has already seen and chosen to continue past.
  const [acknowledged, setAcknowledged] = createSignal("");

  const focusBefore = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null;
  onCleanup(() => {
    if (focusBefore?.isConnected) focusBefore.focus();
  });
  // Work in flight disables the buttons, and a disabled button that had focus drops it to the page.
  createEffect(
    on(() => props.busy || working(), (pending) => {
      if (!dialog || (!pending && dialog.contains(document.activeElement))) return;
      dialog.focus();
    }),
  );

  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key !== "Tab" || !dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    event.preventDefault();
    if (focusable.length === 0) return;
    const at = focusable.findIndex((element) => element === document.activeElement);
    const step = event.shiftKey ? -1 : 1;
    const next = at < 0 ? (step > 0 ? 0 : focusable.length - 1) : (at + step + focusable.length) % focusable.length;
    focusable[next]?.focus();
  };

  const wid = () => props.workspaceId?.trim() ?? "";
  const supportsExtra = () =>
    reviews().length > 0 && reviews().every((r) => r.supports_extra_terms);

  const load = async () => {
    const client = props.client;
    if (!client || !wid()) {
      setLoadFailed(true);
      setLoading(false);
      return;
    }
    try {
      const results = await Promise.all(
        props.operations.map((op) =>
          client.getMaskedReview(wid(), op.operation_session_id, op.operation_id),
        ),
      );
      setReviews(results);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };
  onMount(() => void load());

  const entities = () => reviews().flatMap((r) => r.entities);

  // Masks the typed words and refreshes the preview. Returns false if the user should stay.
  const applyTerms = async (): Promise<boolean> => {
    const typed = splitTerms(input());
    const terms = typed.filter((term) => !isPlaceholderTerm(term));
    const placeholders = typed.filter(isPlaceholderTerm);
    setError(false);
    setNotFound([]);
    if (placeholders.length > 0) return false;
    if (terms.length === 0 || !supportsExtra() || !props.client) return true;
    setWorking(true);
    try {
      const results = await Promise.all(
        props.operations.map((op) =>
          props.client!.maskExtraTerms(wid(), op.operation_session_id, op.operation_id, terms),
        ),
      );
      // Only a term the sidecar confirmed as added counts; anything else stays in the box.
      const addedValues = new Set(
        results.flatMap((r) => r.added.map((entity) => entity.value.toLowerCase())),
      );
      const done = terms.filter((term) => addedValues.has(term.toLowerCase()));
      const missing = terms.filter((term) => !addedValues.has(term.toLowerCase()));
      if (done.length > 0) setAddedTerms((prev) => [...prev, ...done]);
      setNotFound(missing);
      setInput(missing.join(", "));
      setAcknowledged("");
      await load();
      return missing.length === 0;
    } catch {
      setError(true);
      return false;
    } finally {
      setWorking(false);
    }
  };

  const onContinueClick = async () => {
    const pending = input().trim();
    if (pending && notFound().length > 0 && pending === acknowledged()) {
      props.onContinue();
      return;
    }
    if (await applyTerms()) {
      props.onContinue();
    } else if (notFound().length > 0) {
      setAcknowledged(input().trim());
    }
  };

  // Above the Settings dialog (z-50), which may be open when a review arrives.
  return (
    <div class="absolute inset-0 z-[60] dls-modal-backdrop flex items-center justify-center p-4 font-sans">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabindex="-1"
        class="border w-full max-w-3xl max-h-[calc(100vh-2rem)] overflow-y-auto dls-modal-surface"
        data-testid="masked-review-dialog"
        onKeyDown={onKeyDown}
      >
        <div class="p-6">
          <div class="flex items-start gap-4">
            <div class="shrink-0 w-10 h-10 rounded-pill flex items-center justify-center bg-dls-warning-bg text-dls-warning-text">
              <Shield size={20} />
            </div>
            <div class="min-w-0">
              <h3 id={titleId} class="text-title leading-title font-semibold text-dls-text">
                {t("session.mask_review_title")}
              </h3>
              <p id={descriptionId} class="text-body-lg text-dls-secondary mt-1">
                {t("session.mask_review_description")}
              </p>
            </div>
          </div>

          <div class="mt-4 max-h-[45vh] overflow-auto rounded-inset border border-dls-border p-4" data-testid="masked-review-preview">
            <Show when={!loading()} fallback={<p class="text-caption text-dls-secondary">{t("session.mask_review_loading")}</p>}>
              <Show when={!loadFailed()} fallback={<p class="text-caption text-dls-warning-text">{t("session.mask_review_load_failed")}</p>}>
                <For each={reviews()}>
                  {(review, index) => (
                    <div class="mb-4 last:mb-0">
                      <Show when={reviews().length > 1}>
                        <div class="text-caption font-semibold text-dls-secondary mb-2">
                          {fileName(props.operations[index()]?.source_file_path)}
                        </div>
                      </Show>
                      <Show
                        when={review.masked_text}
                        fallback={<p class="text-caption text-dls-secondary">{t("session.mask_review_no_preview")}</p>}
                      >
                        <MaskedPreview review={review} />
                        <Show when={review.masked_text_truncated}>
                          <p class="text-caption text-dls-secondary mt-2">{t("session.mask_review_truncated")}</p>
                        </Show>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </div>

          <Show when={!loading() && !loadFailed()}>
            <details class="mt-3 rounded-inset border border-dls-border p-3" data-testid="masked-review-list">
              <summary class="cursor-pointer text-caption text-dls-secondary">
                {t("session.mask_review_list_summary").replace("{count}", String(entities().length))}
              </summary>
              <Show when={entities().length > 0} fallback={<p class="mt-2 text-caption text-dls-secondary">{t("session.mask_review_empty")}</p>}>
                <ul class="mt-2 max-h-40 overflow-y-auto space-y-1">
                  <For each={entities()}>
                    {(entity) => (
                      <li class="flex items-center justify-between gap-3 text-caption">
                        <span class="font-mono text-dls-secondary">{entity.placeholder}</span>
                        <span class="font-mono text-dls-text break-all text-right">{entity.value}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </details>

            <div class="mt-4">
              <Show
                when={supportsExtra()}
                fallback={<p class="text-caption text-dls-secondary">{t("session.mask_review_unsupported")}</p>}
              >
                <label class="text-caption text-dls-secondary font-semibold" for="masked-review-input">
                  {t("session.mask_review_input_label")}
                </label>
                <div class="mt-1 flex items-start gap-2">
                  <textarea
                    id="masked-review-input"
                    data-testid="masked-review-input"
                    class="w-full rounded-inset bg-dls-surface border border-dls-border focus:border-dls-accent focus:ring-4 focus:ring-[rgb(var(--dls-accent-rgb)/0.2)] focus:outline-none px-3 py-2 text-body-lg text-dls-text placeholder:text-dls-secondary transition-shadow"
                    rows={2}
                    placeholder={t("session.mask_review_input_placeholder")}
                    value={input()}
                    disabled={props.busy || working()}
                    onInput={(event) => setInput(event.currentTarget.value)}
                  />
                  <Button
                    variant="ghost"
                    data-testid="masked-review-apply-btn"
                    onClick={() => void applyTerms()}
                    disabled={props.busy || working() || alreadyMasked().length > 0 || splitTerms(input()).length === 0}
                  >
                    {t("session.mask_review_apply")}
                  </Button>
                </div>
              </Show>
              <Show when={addedTerms().length > 0}>
                <p class="text-caption text-dls-secondary mt-1">
                  {t("session.mask_review_added").replace("{terms}", addedTerms().join(", "))}
                </p>
              </Show>
              <Show when={alreadyMasked().length > 0}>
                <p class="text-caption text-dls-warning-text mt-1">
                  {t("session.mask_review_already_masked").replace("{terms}", alreadyMasked().join(", "))}
                </p>
              </Show>
              <Show when={notFound().length > 0}>
                <p class="text-caption text-dls-warning-text mt-1">
                  {t("session.mask_review_not_found").replace("{terms}", notFound().join(", "))}
                </p>
              </Show>
              <Show when={error()}>
                <p class="text-caption text-dls-warning-text mt-1">{t("session.mask_review_submit_failed")}</p>
              </Show>
            </div>
          </Show>

          <div class="flex items-center justify-between gap-2 mt-6">
            <Button
              variant="danger"
              data-testid="masked-review-cancel-btn"
              onClick={props.onCancel}
              disabled={props.busy || working()}
            >
              {t("session.mask_review_cancel")}
            </Button>
            <Button
              variant="blue"
              data-testid="masked-review-continue-btn"
              onClick={() => void onContinueClick()}
              disabled={props.busy || working() || loading() || alreadyMasked().length > 0}
            >
              {t("session.mask_review_continue")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
