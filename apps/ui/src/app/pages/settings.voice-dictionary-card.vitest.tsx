/**
 * Settings → Voice input → Dictionary card.
 *
 * Needs a DOM (an input, a list, a rejection box), so it runs in the vitest lane
 * rather than under `bun test`. The stub is signal-backed rather than static
 * because every behaviour worth testing here is a reaction: add → the chip
 * appears and the input clears, refuse → the word STAYS in the input next to the
 * reason, cloud mode → everything goes disabled rather than disappearing.
 */
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MAX_DICTIONARY_WORDS,
  addDictionaryWord,
  removeDictionaryWord,
  type DictionaryOrigin,
  type DictionaryRejection,
  type PromotionProgress,
  type VoiceInputController,
  type VoiceInputMode,
} from "~/features/voice-input";

import { t } from "../../i18n";

import VoiceDictionaryCard from "./settings.voice-dictionary-card";

const invoke = vi.fn<(command: string, args: unknown) => Promise<unknown>>();
const revealItemInDir = vi.fn<(path: string) => Promise<void>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: unknown) => invoke(command, args),
}));
vi.mock("./settings.platform-actions", () => ({
  revealItemInDir: (path: string) => revealItemInDir(path),
}));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  invoke.mockReset();
  revealItemInDir.mockReset();
  vi.restoreAllMocks();
});

/**
 * A stub that runs the real list arithmetic. Re-implementing "add" here would
 * make the test agree with itself instead of with the code that ships.
 */
function renderCard(options?: {
  mode?: VoiceInputMode;
  localAvailable?: boolean;
  words?: string[];
  /** Words the loop added on its own; anything absent reads back as "manual". */
  autoWords?: string[];
  /** Evidence the loop has banked but not yet acted on. */
  progress?: PromotionProgress[];
}) {
  const [words, setWords] = createSignal<string[]>(options?.words ?? []);
  const [rejection, setRejection] = createSignal<DictionaryRejection | null>(null);
  const auto = new Set(options?.autoWords ?? []);
  /** Every word the UI asked the controller to remove, in order. */
  const removed: string[] = [];

  const voice = {
    mode: () => options?.mode ?? "local",
    localAvailable: () => options?.localAvailable ?? true,
    dictionary: words,
    correctionProgress: () => options?.progress ?? [],
    dictionaryRejection: rejection,
    originOf: (word: string): DictionaryOrigin => (auto.has(word) ? "auto" : "manual"),
    addDictionaryEntry: (candidate: string) => {
      const result = addDictionaryWord(words(), candidate);
      setRejection(result.rejection);
      if (result.rejection) return false;
      setWords(result.words);
      return true;
    },
    removeDictionaryEntry: (word: string) => {
      removed.push(word);
      setWords(removeDictionaryWord(words(), word));
      setRejection(null);
    },
    clearDictionaryRejection: () => setRejection(null),
  } as unknown as VoiceInputController;

  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <VoiceDictionaryCard voice={voice} />, host);

  const input = () => host.querySelector<HTMLInputElement>("[data-testid=voice-dictionary-input]")!;
  const addButton = () =>
    host.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-add]")!;

  const type = (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };

  /** The dialog renders through a Portal, so it is looked up on `document`. */
  const dialog = () => document.querySelector<HTMLElement>("[data-testid=voice-dictionary-dialog]");
  const openDialog = () => {
    host.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-manage]")!.click();
    return dialog()!;
  };

  return { host, words, removed, input, addButton, type, dialog, openDialog };
}

/** Words listed in the dialog, in order. */
const rows = (dialog: HTMLElement): string[] =>
  [...dialog.querySelectorAll("[data-testid=voice-dictionary-rows] li span:first-of-type")].map(
    (node) => node.textContent ?? "",
  );

const select = (dialog: HTMLElement, word: string) =>
  dialog.querySelector<HTMLInputElement>(`[data-testid=voice-dictionary-select-${word}]`)!.click();

const selectAll = (dialog: HTMLElement) =>
  dialog.querySelector<HTMLInputElement>("[data-testid=voice-dictionary-select-all]")!;

const search = (dialog: HTMLElement, value: string) => {
  const box = dialog.querySelector<HTMLInputElement>("[data-testid=voice-dictionary-search]")!;
  box.value = value;
  box.dispatchEvent(new Event("input", { bubbles: true }));
};

/** Feed a `.txt` to the hidden file input and wait for the async read. */
async function importText(dialog: HTMLElement, text: string) {
  const input = dialog.querySelector<HTMLInputElement>(
    "[data-testid=voice-dictionary-import-input]",
  )!;
  const file = new File([text], "words.txt", { type: "text/plain" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() => {
    expect(dialog.querySelector("[data-testid=voice-dictionary-note]")?.textContent).toBeTruthy();
  });
}

// First span only: a learned word carries a second one for the origin badge.
const chips = (host: HTMLElement): string[] =>
  [...host.querySelectorAll("[data-testid=voice-dictionary-list] li > span:first-child")].map(
    (node) => node.textContent ?? "",
  );

describe("adding a word", () => {
  test("the chip appears, the input clears, the count moves", () => {
    const card = renderCard();
    expect(card.host.querySelector("[data-testid=voice-dictionary-empty]")).not.toBeNull();

    card.type("Parakeet");
    card.addButton().click();

    expect(chips(card.host)).toEqual(["Parakeet"]);
    expect(card.input().value).toBe("");
    expect(card.host.querySelector("[data-testid=voice-dictionary-count]")?.textContent).toContain(
      `1 / ${MAX_DICTIONARY_WORDS}`,
    );
    expect(card.host.querySelector("[data-testid=voice-dictionary-empty]")).toBeNull();
  });

  test("Enter submits, and does not escape to the composer", () => {
    const card = renderCard();
    card.type("SuperClaw");

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    card.input().dispatchEvent(event);

    expect(chips(card.host)).toEqual(["SuperClaw"]);
    // The composer reads Enter as send; the card must consume it.
    expect(event.defaultPrevented).toBe(true);
  });

  test("newest first, so the word just added is the one in view", () => {
    const card = renderCard({ words: ["Intel"] });
    card.type("Parakeet");
    card.addButton().click();

    expect(chips(card.host)).toEqual(["Parakeet", "Intel"]);
  });

  test("casing is kept verbatim", () => {
    const card = renderCard();
    card.type("NVMe");
    card.addButton().click();

    expect(chips(card.host)).toEqual(["NVMe"]);
  });
});

describe("a word that is refused", () => {
  test("stays in the input, next to the reason", () => {
    // Retyping a rejected word to find out what was wrong with it is worse than
    // seeing it sit there.
    const card = renderCard({ words: ["Intel"] });
    card.type("Intel");
    card.addButton().click();

    expect(card.input().value).toBe("Intel");
    expect(
      card.host.querySelector("[data-testid=voice-dictionary-rejection]")?.textContent,
    ).toContain(t("voice.dictionary_error_duplicate"));
    expect(chips(card.host)).toEqual(["Intel"]);
  });

  test("a full list says so rather than dropping the word silently", () => {
    const full = Array.from({ length: MAX_DICTIONARY_WORDS }, (_, i) => `w${i}`);
    const card = renderCard({ words: full });
    card.type("Parakeet");
    card.addButton().click();

    expect(
      card.host.querySelector("[data-testid=voice-dictionary-rejection]")?.textContent,
    ).toContain(t("voice.dictionary_error_full"));
    expect(card.words().length).toBe(MAX_DICTIONARY_WORDS);
  });

  test("removing a word clears the stale reason, because a slot just opened", () => {
    const full = Array.from({ length: MAX_DICTIONARY_WORDS }, (_, i) => `w${i}`);
    const card = renderCard({ words: full });
    card.type("Parakeet");
    card.addButton().click();
    expect(card.host.querySelector("[data-testid=voice-dictionary-rejection]")).not.toBeNull();

    const dialog = card.openDialog();
    select(dialog, "w0");
    dialog.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-remove-selected]")!.click();

    expect(card.host.querySelector("[data-testid=voice-dictionary-rejection]")).toBeNull();
  });

  test("an untouched input does nothing at all — no error under a blank field", () => {
    const card = renderCard();
    card.addButton().click();

    expect(card.host.querySelector("[data-testid=voice-dictionary-rejection]")).toBeNull();
    expect(card.words()).toEqual([]);
  });

  test("whitespace only is treated the same way", () => {
    const card = renderCard();
    card.type("   ");
    card.input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(card.host.querySelector("[data-testid=voice-dictionary-rejection]")).toBeNull();
    expect(card.words()).toEqual([]);
  });
});

describe("the card summary", () => {
  const many = Array.from({ length: 10 }, (_, i) => `w${i}`);

  test("shows the first six words and '+N more', not the whole list", () => {
    const card = renderCard({ words: many, autoWords: ["w1", "w8"] });

    expect(chips(card.host)).toEqual(["w0", "w1", "w2", "w3", "w4", "w5"]);
    expect(card.host.querySelector("[data-testid=voice-dictionary-more]")?.textContent).toBe(
      t("voice.dictionary_more").replace("{n}", "4"),
    );
    expect(
      card.host.querySelector("[data-testid=voice-dictionary-summary-text]")?.textContent,
    ).toBe(t("voice.dictionary_summary").replace("{n}", "10").replace("{m}", "2"));
  });

  test("no '+N more' when everything fits", () => {
    const card = renderCard({ words: ["Intel", "Xeon"] });

    expect(card.host.querySelector("[data-testid=voice-dictionary-more]")).toBeNull();
  });

  test("an empty Dictionary hides the summary but still offers Manage words", async () => {
    // Import lives in the dialog, so an empty list must still be able to reach it.
    const card = renderCard();

    expect(card.host.querySelector("[data-testid=voice-dictionary-empty]")).not.toBeNull();
    expect(card.host.querySelector("[data-testid=voice-dictionary-summary]")).toBeNull();
    const dialog = card.openDialog();
    expect(dialog.querySelector("[data-testid=voice-dictionary-no-matches]")?.textContent).toBe(
      t("voice.dictionary_empty"),
    );

    await importText(dialog, "Parakeet\nXeon\n");
    expect(card.words()).toEqual(["Xeon", "Parakeet"]);
  });
});

describe("the Manage words dialog", () => {
  test("lists every word and closes with Done", () => {
    const words = Array.from({ length: 10 }, (_, i) => `w${i}`);
    const card = renderCard({ words });
    const dialog = card.openDialog();

    expect(rows(dialog)).toEqual(words);
    dialog.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-done]")!.click();
    expect(card.dialog()).toBeNull();
  });

  test.each([
    ["Done", (dialog: HTMLElement) =>
      dialog.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-done]")!.click()],
    ["the close button", (dialog: HTMLElement) =>
      dialog.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-dialog-close]")!.click()],
    ["Escape", (dialog: HTMLElement) =>
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))],
  ])("closing with %s returns focus to Manage words", (_label, close) => {
    // Otherwise focus falls to <body> and a keyboard user loses their place in Settings.
    const card = renderCard({ words: ["Intel"] });
    const manage = card.host.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-manage]")!;
    manage.focus();
    const dialog = card.openDialog();

    close(dialog);

    expect(card.dialog()).toBeNull();
    expect(document.activeElement).toBe(manage);
  });

  test("search narrows the list, case-insensitively", () => {
    const card = renderCard({ words: ["Parakeet", "Intel", "IntelliJ"] });
    const dialog = card.openDialog();

    search(dialog, "intel");
    expect(rows(dialog)).toEqual(["Intel", "IntelliJ"]);

    search(dialog, "zzz");
    expect(dialog.querySelector("[data-testid=voice-dictionary-no-matches]")).not.toBeNull();
  });

  test("the Learned filter shows only words the loop added", () => {
    const card = renderCard({ words: ["MiniMax", "Intel"], autoWords: ["MiniMax"] });
    const dialog = card.openDialog();

    const learned = dialog.querySelector<HTMLButtonElement>(
      "[data-testid=voice-dictionary-filter-learned]",
    )!;
    expect(learned.textContent).toBe(t("voice.dictionary_filter_learned").replace("{m}", "1"));
    learned.click();
    expect(rows(dialog)).toEqual(["MiniMax"]);
  });

  test("Remove selected goes through the controller once per word", () => {
    // Filtering the array directly would skip the tombstone a learned word needs,
    // and the next recording would learn it straight back.
    const card = renderCard({
      words: ["Parakeet", "MiniMax", "Xeon"],
      autoWords: ["MiniMax"],
    });
    const dialog = card.openDialog();

    select(dialog, "Parakeet");
    select(dialog, "MiniMax");
    expect(dialog.querySelector("[data-testid=voice-dictionary-selected]")?.textContent).toBe(
      t("voice.dictionary_selected").replace("{k}", "2"),
    );
    dialog.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-remove-selected]")!.click();

    expect(card.removed).toEqual(["Parakeet", "MiniMax"]);
    expect(rows(dialog)).toEqual(["Xeon"]);
    expect(dialog.querySelector("[data-testid=voice-dictionary-selected]")?.textContent).toBe(
      t("voice.dictionary_selected").replace("{k}", "0"),
    );
  });

  test("Select all then Remove selected empties the list one word at a time", () => {
    // Without it, clearing a full list means ticking 250 boxes.
    const card = renderCard({ words: ["MiniMax", "Intel", "Xeon"], autoWords: ["MiniMax"] });
    const dialog = card.openDialog();

    selectAll(dialog).click();
    dialog.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-remove-selected]")!.click();

    expect(card.words()).toEqual([]);
    // Per word, so the learned one is tombstoned rather than relearned next recording.
    expect(card.removed).toEqual(["MiniMax", "Intel", "Xeon"]);
  });

  test("Select all covers only what the filter and search show", () => {
    const card = renderCard({ words: ["MiniMax", "Intel", "Xeon"], autoWords: ["MiniMax"] });
    const dialog = card.openDialog();

    dialog.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-filter-learned]")!.click();
    selectAll(dialog).click();
    dialog.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-remove-selected]")!.click();
    expect(card.words()).toEqual(["Intel", "Xeon"]);

    dialog.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-filter-all]")!.click();
    search(dialog, "xe");
    selectAll(dialog).click();
    expect(dialog.querySelector("[data-testid=voice-dictionary-selected]")?.textContent).toBe(
      t("voice.dictionary_selected").replace("{k}", "1"),
    );
  });

  test("Select all shows a partial state and clears on a second click", () => {
    const card = renderCard({ words: ["Intel", "Xeon"] });
    const dialog = card.openDialog();

    select(dialog, "Intel");
    expect(selectAll(dialog).checked).toBe(false);
    expect(selectAll(dialog).indeterminate).toBe(true);

    selectAll(dialog).click();
    expect(selectAll(dialog).checked).toBe(true);
    expect(selectAll(dialog).indeterminate).toBe(false);

    selectAll(dialog).click();
    expect(dialog.querySelector("[data-testid=voice-dictionary-selected]")?.textContent).toBe(
      t("voice.dictionary_selected").replace("{k}", "0"),
    );
  });

  test("the checkbox label names its word", () => {
    // On a long list a screen reader would otherwise read identical controls.
    const card = renderCard({ words: ["Parakeet"] });
    const dialog = card.openDialog();

    expect(
      dialog
        .querySelector("[data-testid=voice-dictionary-select-Parakeet]")
        ?.getAttribute("aria-label"),
    ).toBe(t("voice.dictionary_select").replace("{word}", "Parakeet"));
  });

  test("Import adds through the normal rules and reports what it skipped", async () => {
    const card = renderCard({ words: ["Intel"] });
    const dialog = card.openDialog();

    await importText(dialog, "Parakeet\r\nIntel\n\n  Xeon  \n" + "x".repeat(101) + "\n");

    // Blank lines are not words, so they are neither added nor skipped.
    expect(
      dialog.querySelector("[data-testid=voice-dictionary-note]")?.textContent,
    ).toBe(t("voice.dictionary_import_result").replace("{added}", "2").replace("{skipped}", "2"));
    expect(card.words()).toEqual(["Xeon", "Parakeet", "Intel"]);
    // The last refusal is summarised above, not left in the card's rejection box.
    expect(card.host.querySelector("[data-testid=voice-dictionary-rejection]")).toBeNull();
  });

  test("the result note is a polite live region that exists before any result", async () => {
    const card = renderCard({ words: ["Intel"] });
    const dialog = card.openDialog();
    const region = dialog.querySelector("[data-testid=voice-dictionary-note]");

    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toBe("");

    await importText(dialog, "Parakeet\n");

    expect(dialog.querySelector("[data-testid=voice-dictionary-note]")).toBe(region);
    expect(region?.textContent).toBe(
      t("voice.dictionary_import_result").replace("{added}", "1").replace("{skipped}", "0"),
    );
  });

  test("Import stops at the limit and counts the rest as skipped", async () => {
    const nearly = Array.from({ length: MAX_DICTIONARY_WORDS - 1 }, (_, i) => `w${i}`);
    const card = renderCard({ words: nearly });
    const dialog = card.openDialog();

    await importText(dialog, "Parakeet\nXeon\nIntel\n");

    expect(card.words().length).toBe(MAX_DICTIONARY_WORDS);
    expect(
      dialog.querySelector("[data-testid=voice-dictionary-note]")?.textContent,
    ).toBe(t("voice.dictionary_import_result").replace("{added}", "1").replace("{skipped}", "2"));
  });

  const noteText = async (dialog: HTMLElement) => {
    await vi.waitFor(() => {
      expect(dialog.querySelector("[data-testid=voice-dictionary-note]")?.textContent).toBeTruthy();
    });
    return dialog.querySelector("[data-testid=voice-dictionary-note]")?.textContent;
  };
  const exportButton = (dialog: HTMLElement) =>
    dialog.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-export]")!;

  test("Export in the app writes natively and says where the file went", async () => {
    // The webview ignores `<a download>`: before this the button did nothing visible.
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const path = "C:\\Users\\me\\Downloads\\dictionary.txt";
    invoke.mockResolvedValue(path);
    revealItemInDir.mockResolvedValue();
    const card = renderCard({ words: ["Parakeet", "Intel"] });
    const dialog = card.openDialog();

    exportButton(dialog).click();

    expect(await noteText(dialog)).toBe(
      t("voice.dictionary_export_saved").replace("{n}", "2").replace("{path}", path),
    );
    expect(invoke).toHaveBeenCalledWith("write_voice_dictionary_export", {
      content: "Parakeet\nIntel\n",
    });
    expect(revealItemInDir).toHaveBeenCalledWith(path);
  });

  test("a failed export says so instead of staying silent", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invoke.mockRejectedValue("disk full");
    const card = renderCard({ words: ["Intel"] });
    const dialog = card.openDialog();

    exportButton(dialog).click();

    expect(await noteText(dialog)).toBe(
      t("voice.dictionary_export_failed").replace("{error}", "disk full"),
    );
    expect(revealItemInDir).not.toHaveBeenCalled();
    expect(exportButton(dialog).disabled).toBe(false);
  });

  test("Import and Export explain themselves above the dialog", () => {
    const card = renderCard({ words: ["Intel"] });
    const dialog = card.openDialog();
    const hint = (testId: string) => {
      const trigger = dialog.querySelector(`[data-testid=${testId}]`)!.closest("span")!.parentElement!;
      trigger.dispatchEvent(new MouseEvent("mouseenter"));
      const bubble = document.querySelector<HTMLElement>("[role=tooltip]");
      trigger.dispatchEvent(new MouseEvent("mouseleave"));
      return bubble;
    };

    const importHint = hint("voice-dictionary-import");
    expect(importHint?.textContent).toBe(
      t("voice.dictionary_import_hint").replace("{max}", String(MAX_DICTIONARY_WORDS)),
    );
    // The default bubble layer sits under the dialog's overlay and would never show.
    expect(importHint?.className).toContain("z-[100001]");
    expect(hint("voice-dictionary-export")?.textContent).toBe(t("voice.dictionary_export_hint"));
  });

  test("Export in a browser falls back to a download and confirms it", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const card = renderCard({ words: ["Intel"] });
    const dialog = card.openDialog();

    exportButton(dialog).click();

    expect(await noteText(dialog)).toBe(
      t("voice.dictionary_export_saved").replace("{n}", "1").replace("{path}", "dictionary.txt"),
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("a word the loop added on its own", () => {
  test("carries the badge; a word the user typed does not", () => {
    // Without it the list gives the user no way to tell an entry they never typed
    // from a typo of their own — and removing it means something different.
    const card = renderCard({ words: ["MiniMax", "Intel"], autoWords: ["MiniMax"] });

    expect(
      card.host.querySelector("[data-testid=voice-dictionary-origin-MiniMax]")?.textContent,
    ).toContain(t("voice.dictionary_origin_auto"));
    expect(card.host.querySelector("[data-testid=voice-dictionary-origin-Intel]")).toBeNull();
    // The badge must not be mistaken for a second entry.
    expect(chips(card.host)).toEqual(["MiniMax", "Intel"]);
  });
});

describe("cloud mode", () => {
  test("the card is disabled, not hidden, and says why", () => {
    // Hiding it would make an already-entered Dictionary look lost.
    const card = renderCard({ mode: "cloud", words: ["Intel"] });

    expect(card.host.querySelector("[data-testid=voice-dictionary-card]")).not.toBeNull();
    expect(card.host.querySelector("[data-testid=voice-dictionary-inactive]")?.textContent).toContain(
      t("voice.dictionary_local_only"),
    );
    expect(card.input().disabled).toBe(true);
    expect(card.addButton().disabled).toBe(true);
    // The words are still visible, and still cannot be removed by accident.
    expect(chips(card.host)).toEqual(["Intel"]);
    const dialog = card.openDialog();
    expect(rows(dialog)).toEqual(["Intel"]);
    expect(
      dialog.querySelector<HTMLInputElement>("[data-testid=voice-dictionary-select-Intel]")!
        .disabled,
    ).toBe(true);
    expect(
      dialog.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-import]")!.disabled,
    ).toBe(true);
    expect(selectAll(dialog).disabled).toBe(true);
    expect(
      dialog.querySelector<HTMLButtonElement>("[data-testid=voice-dictionary-remove-selected]")!
        .disabled,
    ).toBe(true);
  });

  test("the same is true while the catalog probe has not answered yet", () => {
    // `localAvailable()` is false during startup: the card must not claim an
    // effect it cannot have yet.
    const card = renderCard({ mode: "local", localAvailable: false });

    expect(card.host.querySelector("[data-testid=voice-dictionary-inactive]")).not.toBeNull();
    expect(card.input().disabled).toBe(true);
  });
});

describe("what the loop has learned so far", () => {
  /** `[word, status]` per row — the two spans sit adjacent, with no text between. */
  const rows = (host: HTMLElement): string[][] =>
    [...host.querySelectorAll("[data-testid=voice-dictionary-progress] li")].map((node) =>
      [...node.querySelectorAll("span")].map((span) => span.textContent ?? ""),
    );

  test("with nothing recorded, the section is hidden and the card still says what counts", () => {
    // "Why is it not here?" is answered by the paragraph above the section, which
    // also says only the word is stored — so an empty heading would add nothing.
    const card = renderCard();

    expect(card.host.querySelector("[data-testid=voice-dictionary-progress]")).toBeNull();
    expect(card.host.textContent).not.toContain(t("voice.dictionary_progress_heading"));
    expect(
      card.host.querySelector("[data-testid=voice-dictionary-learned]")?.textContent,
    ).toContain(t("voice.dictionary_learned_desc"));
  });

  test("a word short of its threshold shows the count, not silence", () => {
    const card = renderCard({
      progress: [{ word: "LLM", runs: 1, threshold: 2, blockedBy: "waiting" }],
    });

    expect(rows(card.host)).toEqual([["LLM", "1 of 2 recordings"]]);
  });

  test("a word that will never be added says so instead of counting forever", () => {
    // A count that never reaches its threshold reads as a stuck feature.
    const card = renderCard({
      progress: [{ word: "real", runs: 5, threshold: 3, blockedBy: "unsuitable" }],
    });

    expect(rows(card.host)).toEqual([["real", t("voice.dictionary_progress_unsuitable")]]);
  });
});
