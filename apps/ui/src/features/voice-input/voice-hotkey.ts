/**
 * In-app voice hotkeys: parsing, formatting, capture, matching and validation.
 *
 * A binding is either a **key chord** (one or more keys held together) or a
 * **mouse button**, and the user may bind several — any one of them toggles
 * recording. That shape follows the DictationApp reference implementation
 * (`voice-dictation-team/src/hotkey.py`), which is what this feature is modelled
 * on; the differences below are deliberate and are what makes the default safe.
 *
 * Pure module — no DOM access beyond the small event shapes handed in, so every
 * rule here is unit-testable without a browser.
 *
 * Four decisions worth knowing before editing:
 *
 *  * **Keys are identified by `event.code`** (physical position), never by
 *    `event.key`. `key` depends on the active layout and on the modifiers being
 *    held, so a `key`-based binding silently breaks on non-US layouts. `code`
 *    also tells the left and right twins apart, which is what lets Right Alt be
 *    a binding of its own — the reference achieves the same thing with virtual-key
 *    codes (0xA5 vs 0xA4), which the DOM does not expose.
 *  * **A chord matches only when the set of held keys is exactly the chord.** Not
 *    a subset. This is stricter than the reference, which ignores keys outside the
 *    binding, and it is what makes `Right Alt` safe as the shipped default: on a
 *    German, French or Polish layout Right Alt is AltGr, and typing `@`/`€`/`{`
 *    presses Right Alt **together with** another key — a superset, so it does not
 *    fire. The cost is the honest one: where the layout sends AltGr as
 *    Ctrl+AltRight, a bare `Right Alt` binding never fires at all, so
 *    {@link hotkeyNeedsAltGrNote} tells those users to add a second binding.
 *  * **Chords fire on key *release*.** Auto-repeat from a held key would
 *    otherwise toggle recording dozens of times, and a bare-modifier binding has
 *    no other moment to fire at. Mouse buttons fire on release for the same
 *    reason. A keyup that never arrives would leave the chord armed. The next
 *    non-repeat keydown of a key still held fires it once, and a modifier-only
 *    chord also asks the caller to fire on its own if that release has not
 *    arrived after {@link MODIFIER_RELEASE_GRACE_MS}.
 *  * **A bare-modifier keydown is never `preventDefault`ed.** Swallowing the
 *    Right Alt keydown would break AltGr composition for everyone. Only a chord
 *    completed by a non-modifier key is suppressed, so `Ctrl+Shift+Space` cannot
 *    also reach the composer.
 */

/** Mouse buttons that may be bound, in `MouseEvent.button` terms. */
export type VoiceMouseButton = "middle" | "x1" | "x2";

/**
 * One binding. `codes` holds `KeyboardEvent.code` values — modifiers included,
 * since a chord may be nothing but modifiers ("Right Alt", "Left Ctrl+Shift").
 */
export type VoiceHotkey =
  | { readonly type: "key"; readonly codes: readonly string[] }
  | { readonly type: "mouse"; readonly button: VoiceMouseButton };

/** Shape of the parts of `KeyboardEvent` this module reads. */
export type HotkeyKeyEventLike = {
  code: string;
  /** Auto-repeat while a key is held; ignored everywhere. */
  repeat?: boolean;
};

/** Shape of the parts of `MouseEvent` this module reads. */
export type HotkeyMouseEventLike = {
  button: number;
};

/**
 * Shipped default: Right Alt alone.
 *
 * Chosen to match the reference implementation, and reachable with one thumb
 * without leaving the home position. It is only a safe default because of the
 * exact-set matching described above.
 */
export const DEFAULT_VOICE_HOTKEYS: readonly VoiceHotkey[] = [
  { type: "key", codes: ["AltRight"] },
];

/**
 * Upper bound on bound shortcuts, mirroring `MAX_DICTIONARY_WORDS`: the list is
 * rendered as rows in Settings and rebuilt into listeners on every change, so it
 * is bounded rather than trusted.
 */
export const MAX_VOICE_HOTKEYS = 4;

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

/**
 * Keys that may be bound **alone**.
 *
 * Everything else needs company: a bare `K` or `Space` would start a recording
 * while the user types into the composer. Modifiers, function keys and the lock
 * keys type nothing on their own, which is exactly the set the reference offers
 * as presets (right/left Ctrl, right/left Alt, right Shift, F9, F10, Caps Lock).
 */
const STANDALONE_CODES = new Set([
  ...MODIFIER_CODES,
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Pause",
  "Insert",
]);

/** Owned by the composer and by dialogs; binding one would break them. */
const RESERVED_CODES = new Set(["Enter", "NumpadEnter", "Tab", "Escape"]);

const MOUSE_BUTTON_BY_EVENT_BUTTON = new Map<number, VoiceMouseButton>([
  // 0 (left) and 2 (right) are deliberately absent, as in the reference: binding
  // either would toggle recording on ordinary clicking.
  [1, "middle"],
  [3, "x1"],
  [4, "x2"],
]);

/**
 * The same buttons as a set, for validating a *stored* `button` string.
 *
 * Derived from the map rather than listed again so there is one place to keep
 * correct, and a `Set` rather than `in MOUSE_LABELS` because `in` walks the
 * prototype chain: `"constructor" in MOUSE_LABELS` is true, so a hand-edited
 * `{"type":"mouse","button":"constructor"}` would parse as a valid binding and
 * then hand {@link formatHotkey} a function to render.
 */
const BINDABLE_MOUSE_BUTTONS: ReadonlySet<string> = new Set(
  MOUSE_BUTTON_BY_EVENT_BUTTON.values(),
);

const MOUSE_LABELS: Record<VoiceMouseButton, string> = {
  middle: "Mouse 3",
  x1: "Mouse 4",
  x2: "Mouse 5",
};

const MODIFIER_LABELS: Record<string, string> = {
  ControlLeft: "Left Ctrl",
  ControlRight: "Right Ctrl",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  AltLeft: "Left Alt",
  AltRight: "Right Alt",
  MetaLeft: "Left Win",
  MetaRight: "Right Win",
};

/** Modifiers read first in a chord, in the order Windows spells them. */
const MODIFIER_RANK: Record<string, number> = {
  ControlLeft: 0,
  ControlRight: 0,
  ShiftLeft: 1,
  ShiftRight: 1,
  AltLeft: 2,
  AltRight: 2,
  MetaLeft: 3,
  MetaRight: 3,
};

/** Human label for a `KeyboardEvent.code`, e.g. "KeyK" → "K". */
function codeLabel(code: string): string {
  const modifier = MODIFIER_LABELS[code];
  if (modifier) return modifier;
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  if (code.startsWith("Numpad")) return `Numpad ${code.slice(6)}`;
  if (code === "CapsLock") return "Caps Lock";
  if (code === "NumLock") return "Num Lock";
  if (code === "ScrollLock") return "Scroll Lock";
  return code;
}

/**
 * Canonical order for the codes inside a chord: modifiers first, then the rest
 * alphabetically.
 *
 * Applied at capture time, not only at render time, so the stored list and
 * {@link hotkeyIdentity} do not depend on which key the user happened to press
 * first — otherwise the same chord could be added twice.
 */
function sortCodes(codes: readonly string[]): string[] {
  return [...codes].sort((left, right) => {
    const leftRank = MODIFIER_RANK[left] ?? 9;
    const rightRank = MODIFIER_RANK[right] ?? 9;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.localeCompare(right);
  });
}

/** Stable identity of a binding, for dedupe and for the armed-chord bookkeeping. */
export function hotkeyIdentity(hotkey: VoiceHotkey): string {
  return hotkey.type === "mouse"
    ? `mouse:${hotkey.button}`
    : `key:${sortCodes(hotkey.codes).join("+")}`;
}

export function formatHotkey(hotkey: VoiceHotkey): string {
  if (hotkey.type === "mouse") return MOUSE_LABELS[hotkey.button];
  return sortCodes(hotkey.codes).map(codeLabel).join("+");
}

/** Every binding in one string, e.g. "Right Alt / Mouse 4". */
export function formatHotkeys(hotkeys: readonly VoiceHotkey[]): string {
  return hotkeys.map(formatHotkey).join(" / ");
}

const ARIA_MODIFIERS: Record<string, string> = {
  ControlLeft: "Control",
  ControlRight: "Control",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  AltLeft: "Alt",
  AltRight: "Alt",
  MetaLeft: "Meta",
  MetaRight: "Meta",
};

/**
 * The bindings spelled the way `aria-keyshortcuts` requires: a space-delimited
 * list, each shortcut `+`-delimited, modifiers named "Control"/"Meta" (not
 * "Ctrl"/"Win"), and no left/right distinction — ARIA has no way to express one.
 *
 * Mouse bindings are omitted because the attribute describes keyboard shortcuts
 * only. Kept separate from {@link formatHotkey} on purpose: that one is prose for
 * a tooltip and a `<kbd>`, this one is a machine-read attribute. The microphone
 * button carries this instead of folding the chord into its `aria-label`, so the
 * accessible name stays "Click to start voice input" whatever the user binds.
 */
export function ariaKeyShortcuts(hotkeys: readonly VoiceHotkey[]): string {
  return hotkeys
    .filter((hotkey): hotkey is Extract<VoiceHotkey, { type: "key" }> => hotkey.type === "key")
    .map((hotkey) =>
      sortCodes(hotkey.codes)
        .map((code) => ARIA_MODIFIERS[code] ?? codeLabel(code))
        .join("+"),
    )
    .join(" ");
}

export function serializeHotkeys(hotkeys: readonly VoiceHotkey[]): string {
  return JSON.stringify(hotkeys);
}

function parseOne(value: unknown): VoiceHotkey | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "mouse") {
    const button = record.button;
    return typeof button === "string" && BINDABLE_MOUSE_BUTTONS.has(button)
      ? { type: "mouse", button: button as VoiceMouseButton }
      : null;
  }
  if (record.type !== "key" || !Array.isArray(record.codes)) return null;
  const codes = sortCodes(
    record.codes.filter((code): code is string => typeof code === "string" && code.length > 0),
  );
  return codes.length > 0 ? { type: "key", codes } : null;
}

/**
 * Parses the stored list.
 *
 * Returns `null` for anything malformed so a corrupted preference falls back to
 * the default, and `[]` for a *valid* empty list — which means "no shortcut", a
 * state the user can legitimately reach by removing every binding. Collapsing
 * those two would either resurrect a deleted binding or silently disable the
 * feature, depending on which way it collapsed.
 *
 * Individual unusable entries are dropped rather than failing the list: one
 * corrupt row out of four must not cost the user the other three. The exception
 * is a non-empty array with *nothing* salvageable in it — that is corruption, not
 * a choice, and returning `[]` for it would be read as "unbound everything" and
 * leave the feature silently without a shortcut.
 */
export function parseHotkeys(raw: string): VoiceHotkey[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<string>();
  const hotkeys: VoiceHotkey[] = [];
  for (const value of parsed) {
    const hotkey = parseOne(value);
    if (!hotkey) continue;
    const identity = hotkeyIdentity(hotkey);
    if (seen.has(identity)) continue;
    seen.add(identity);
    hotkeys.push(hotkey);
    if (hotkeys.length === MAX_VOICE_HOTKEYS) break;
  }
  if (hotkeys.length === 0 && parsed.length > 0) return null;
  return hotkeys;
}

/** Why a candidate binding is unusable, or null when it is fine. */
export type HotkeyRejection = "typing_key" | "reserved" | "duplicate" | "too_many";

/**
 * Bindings we refuse to store.
 *
 *  * `typing_key` — a single key that types something. It would fire while the
 *    user writes a prompt. Modifiers, function keys and lock keys are exempt.
 *  * `reserved` — Enter/Tab/Escape, which the composer and dialogs own.
 *  * `duplicate` — already in the list; adding it again would be a no-op row.
 *  * `too_many` — {@link MAX_VOICE_HOTKEYS} reached.
 *
 * Note what is **not** here: Right Alt and Ctrl+Alt. An earlier version of this
 * module refused both because its matcher armed on any keydown carrying
 * `altKey`, so `AltGr+Q` *was* the `Alt+Q` binding. Exact-set matching removed
 * that failure mode, so those chords are allowed and merely annotated — see
 * {@link hotkeyNeedsAltGrNote}.
 */
export function hotkeyRejectionReason(
  candidate: VoiceHotkey,
  existing: readonly VoiceHotkey[] = [],
): HotkeyRejection | null {
  if (existing.length >= MAX_VOICE_HOTKEYS) return "too_many";
  const identity = hotkeyIdentity(candidate);
  if (existing.some((hotkey) => hotkeyIdentity(hotkey) === identity)) return "duplicate";
  if (candidate.type === "mouse") return null;
  if (candidate.codes.some((code) => RESERVED_CODES.has(code))) return "reserved";
  if (candidate.codes.length === 1 && !STANDALONE_CODES.has(candidate.codes[0])) {
    return "typing_key";
  }
  return null;
}

/**
 * True when at least one binding involves Right Alt, i.e. AltGr on German,
 * French, Polish and other layouts.
 *
 * Informational, never blocking. Two distinct things can go wrong there and the
 * remedy for both is the same (bind something else as well), so the UI shows one
 * note: a bare `Right Alt` may never fire, because those layouts send AltGr as
 * Ctrl+AltRight and the held set is then a superset of the chord; and a chord
 * *containing* Right Alt or Ctrl+Alt is the very combination used to type `@`,
 * `€` or `{`, so it can fire while typing one.
 */
export function hotkeyNeedsAltGrNote(hotkeys: readonly VoiceHotkey[]): boolean {
  return hotkeys.some((hotkey) => {
    if (hotkey.type !== "key") return false;
    if (hotkey.codes.includes("AltRight")) return true;
    const hasControl = hotkey.codes.some((code) => code.startsWith("Control"));
    const hasAlt = hotkey.codes.some((code) => code.startsWith("Alt"));
    return hasControl && hasAlt;
  });
}

/** `MouseEvent.button` → a bindable button, or null for left/right/unknown. */
export function mouseButtonFromEvent(event: HotkeyMouseEventLike): VoiceMouseButton | null {
  return MOUSE_BUTTON_BY_EVENT_BUTTON.get(event.button) ?? null;
}

/**
 * Collects a chord from live events for the Settings capture field.
 *
 * A chord is only known once the user starts letting go, so presses accumulate
 * and the **largest** set held during the attempt is what gets committed on the
 * first release. Without that, `Ctrl+Shift+Space` would commit as `Ctrl` the
 * moment Ctrl went down, and a bare `Right Alt` could not be captured at all.
 */
export function createHotkeyCapture() {
  let held = new Set<string>();
  let best: string[] = [];

  return {
    keyDown(event: HotkeyKeyEventLike): void {
      if (event.repeat) return;
      held.add(event.code);
      if (held.size > best.length) best = sortCodes([...held]);
    },
    /** The captured chord, or null while the user is still assembling one. */
    keyUp(event: HotkeyKeyEventLike): VoiceHotkey | null {
      held.delete(event.code);
      if (best.length === 0) return null;
      const codes = best;
      best = [];
      held = new Set();
      return { type: "key", codes };
    },
    /** Mouse bindings are single buttons, so a press is the whole gesture. */
    mouseDown(event: HotkeyMouseEventLike): VoiceHotkey | null {
      const button = mouseButtonFromEvent(event);
      return button ? { type: "mouse", button } : null;
    },
    reset(): void {
      held = new Set();
      best = [];
    },
  };
}

/**
 * A bare modifier's keyup is the event a second IME or the Alt menu drops.
 * The caller fires the chord this long after it was armed when that release
 * has not arrived. Short enough to feel like the same press; long enough that
 * Alt+Shift, or the character key of AltGr, still arrives first and wins.
 */
export const MODIFIER_RELEASE_GRACE_MS = 160;

/** What the caller should do with an event it just handed to the matcher. */
export type HotkeyMatch = {
  /** Toggle recording now. */
  fire: boolean;
  /** Keep the event away from the rest of the app. */
  preventDefault: boolean;
  /**
   * `true` when a modifier-only chord is held exactly and the caller should
   * fire it if the keyup does not arrive. `false` when this event ended that
   * wait. Absent on events that say nothing about it (auto-repeat, the mouse).
   */
  releaseGrace?: boolean;
};

const NO_MATCH: HotkeyMatch = { fire: false, preventDefault: false };

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function isSubset(subset: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  for (const value of subset) if (!superset.has(value)) return false;
  return true;
}

/**
 * Stateful matcher for the bound list. The caller feeds it raw events and acts on
 * {@link HotkeyMatch}; all the arming rules live here so they can be tested
 * without a window.
 *
 * `reset()` exists because the window can lose focus mid-chord (Alt+Tab is the
 * obvious case, and it involves a bound key on the default binding). Without it
 * the released key would never be seen, leaving the chord armed forever and the
 * next unrelated keystroke firing a recording.
 */
export function createHotkeyMatcher(initial: readonly VoiceHotkey[] = []) {
  let chords: Set<string>[] = [];
  let buttons = new Set<VoiceMouseButton>();
  const down = new Set<string>();
  let armed: Set<string>[] = [];
  const pressedButtons = new Set<VoiceMouseButton>();
  // This hold already toggled. A grace-fired Right Alt must not toggle again
  // when Shift arrives afterwards and completes Right Alt+Shift.
  let spent = false;

  const reset = (): void => {
    down.clear();
    armed = [];
    pressedButtons.clear();
    spent = false;
  };

  const noteSpent = (): void => {
    spent = down.size > 0;
  };

  /** True when `down` is exactly one armed chord and that chord is modifiers only. */
  const modifierChordHeld = (): boolean =>
    armed.some((chord) => {
      if (!setsEqual(down, chord)) return false;
      for (const code of chord) if (!MODIFIER_CODES.has(code)) return false;
      return true;
    });

  const waitingForModifierRelease = (): HotkeyMatch => ({
    fire: false,
    preventDefault: false,
    releaseGrace: modifierChordHeld(),
  });

  const setHotkeys = (hotkeys: readonly VoiceHotkey[]): void => {
    chords = hotkeys
      .filter((hotkey): hotkey is Extract<VoiceHotkey, { type: "key" }> => hotkey.type === "key")
      .map((hotkey) => new Set(hotkey.codes));
    buttons = new Set(
      hotkeys
        .filter(
          (hotkey): hotkey is Extract<VoiceHotkey, { type: "mouse" }> => hotkey.type === "mouse",
        )
        .map((hotkey) => hotkey.button),
    );
    reset();
  };

  setHotkeys(initial);

  return {
    setHotkeys,
    reset,
    /** True when nothing is bound, so the caller can skip installing listeners. */
    get idle(): boolean {
      return chords.length === 0 && buttons.size === 0;
    },
    keyDown(event: HotkeyKeyEventLike): HotkeyMatch {
      if (event.repeat) return NO_MATCH;
      // A non-repeat keydown for a key still in `down` means its keyup never
      // arrived (a second IME drops modifier releases). A held key does not
      // reach here: `event.repeat` returned above.
      if (down.has(event.code)) {
        if (spent) {
          // The hold already toggled (the grace fired). This keydown is the
          // next press of that key, not another key joining the hold. Drop
          // the stale entry and match it as a new press. Keys still held
          // from the consumed hold stay consumed.
          down.delete(event.code);
          noteSpent();
        } else if (armed.some((chord) => chord.has(event.code))) {
          // The first press has not counted yet. Fire it now and leave it
          // disarmed, so the real keyup cannot toggle a second time.
          armed = [];
          noteSpent();
          // Same suppression rule as a chord a non-modifier just completed.
          // A recovered Space must not also reach the composer; a bare modifier
          // stays unswallowed so AltGr composition still works.
          return { fire: true, preventDefault: !MODIFIER_CODES.has(event.code) };
        }
      }
      if (spent) {
        down.add(event.code);
        return { fire: false, preventDefault: false, releaseGrace: false };
      }
      down.add(event.code);
      // Any key outside an armed chord disarms it: the held set must *equal* the
      // chord, which is what keeps AltGr+E from firing a bare Right Alt binding.
      armed = armed.filter((chord) => isSubset(down, chord));
      let completed = false;
      for (const chord of chords) {
        if (setsEqual(down, chord) && !armed.includes(chord)) {
          armed.push(chord);
          completed = true;
        }
      }
      // Only suppress a chord that a non-modifier key completed. Swallowing a
      // bare modifier keydown would break AltGr composition and Alt menus.
      const preventDefault = completed && !MODIFIER_CODES.has(event.code);
      return { ...waitingForModifierRelease(), preventDefault };
    },
    keyUp(event: HotkeyKeyEventLike): HotkeyMatch {
      down.delete(event.code);
      if (spent) {
        noteSpent();
        return { fire: false, preventDefault: false, releaseGrace: false };
      }
      const fired = armed.some((chord) => chord.has(event.code));
      if (fired) {
        // Overlapping bindings (Right Alt and Right Alt+Shift) must toggle once;
        // the most specific chord wins for this press sequence.
        armed = [];
        noteSpent();
        return { fire: true, preventDefault: false, releaseGrace: false };
      }
      armed = armed.filter((chord) => isSubset(down, chord));
      return waitingForModifierRelease();
    },
    /**
     * Fires a modifier chord whose keyup never arrived. The caller invokes this
     * once {@link MODIFIER_RELEASE_GRACE_MS} after `releaseGrace` came back
     * true. A no-op when a keyup, an extra key, or a reset got there first.
     */
    commitPendingRelease(): HotkeyMatch {
      if (spent || !modifierChordHeld()) {
        return { fire: false, preventDefault: false, releaseGrace: false };
      }
      armed = [];
      noteSpent();
      return { fire: true, preventDefault: false, releaseGrace: false };
    },
    mouseDown(event: HotkeyMouseEventLike): HotkeyMatch {
      const button = mouseButtonFromEvent(event);
      if (!button || !buttons.has(button)) return NO_MATCH;
      pressedButtons.add(button);
      return NO_MATCH;
    },
    /**
     * Fires on release, mirroring the keyboard path. Never `preventDefault`s: as
     * in the reference, a bound side button keeps its normal action — and the
     * Settings row says so, because that double action is surprising otherwise.
     */
    mouseUp(event: HotkeyMouseEventLike): HotkeyMatch {
      const button = mouseButtonFromEvent(event);
      if (!button || !pressedButtons.delete(button)) return NO_MATCH;
      return { fire: true, preventDefault: false };
    },
  };
}

export type HotkeyMatcher = ReturnType<typeof createHotkeyMatcher>;
