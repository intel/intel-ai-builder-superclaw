/**
 * The optional LLM clean-up pass over a dictation: its two preferences, whether
 * it can run at all, and whether the dedicated route has the credential it needs.
 *
 * Split out of `use-voice-input.ts` rather than added to it, for the same reason
 * `use-voice-corrections.ts` was: that file is at 781 lines against AGENTS.md
 * §7's 800-line cap. This is also a real seam — clean-up touches no download
 * state, no device enumeration and no part of the recording lifecycle.
 *
 * ## No new feature flag
 *
 * Clean-up gates on the existing `voice_input` Profile flag plus a localStorage
 * preference, exactly as the engine radio and the Dictionary do. There is no
 * Product Profile entry for it: the capability it needs (a configured cloud
 * model) is per-install user configuration, not an immutable property of a
 * Profile, and AGENTS.md §5c forbids freezing a runtime-variable fact into a
 * digest-checked artifact.
 *
 * ## Three things called "available", kept apart on purpose
 *
 * `refineAvailable` — a `/refine` can be reached on this install. False once the
 * service has told us it has no inference key, or has no such route.
 * `refineOpenRouterReady` — the *preset* mode specifically can run, because the
 * user has their **own** OpenRouter key in LLMRouter. Nothing in the product
 * bundles a credential for it, so this is a question only the user can answer.
 * `refineLocalReady` — the *local* mode specifically can run, because the user
 * has a committed local provider. LLMRouter hides the `local-model` alias until
 * one is selected, so this mirrors the data plane's own gate rather than
 * guessing from hardware.
 *
 * Collapsing them would make "clean-up is off because nothing is wired" look
 * identical to "clean-up works, but not the mode you picked".
 *
 * ## The two unavailable modes degrade in OPPOSITE directions
 *
 * A stored `preset` with a confirmed-absent key falls back to `agent`: both are
 * cloud, so the user's text was already leaving the machine and the fallback only
 * changes which provider receives it.
 *
 * A stored `local` **never** falls back. The whole reason to pick it is that
 * nothing is dictated to a cloud provider, so quietly rerouting to `agent`
 * because a probe said "no local bundle" would hand private text to a cloud model
 * the user specifically declined — and LLMRouter's own view of the primary bundle
 * can report null during a startup or model-switch window, so that probe is
 * exactly the kind that is briefly wrong. Instead the call is allowed to fail
 * (LRM answers 424, the host maps it to `refine_no_model`) and the raw transcript
 * is inserted with a notice. The user loses their polish, never their words, and
 * never their privacy.
 */
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

import {
  createLlmRouterClient,
  type LlmRouterProviderModel,
} from "~/shared/platform/transport/llmrouter-client";

import {
  createAsrClient,
  type AsrRefineRequest,
  type AsrReasoningSupport,
} from "./asr-client";
import { decideReasoningHint, type ReasoningHintDecision } from "./dictation-reasoning-hint";
import {
  DEFAULT_DICTATION_REFINE_MODE,
  DEFAULT_DICTATION_REFINE_MODEL,
  readDictationReasoningHintDismissed,
  readDictationRefineEnabled,
  readDictationRefineMode,
  writeDictationReasoningHintDismissed,
  writeDictationRefineEnabled,
  writeDictationRefineMode,
  type DictationRefineMode,
} from "./voice-input-prefs";

/**
 * Provider id the preset mode needs a key for, as LLMRouter reports it from
 * `GET /llm-router/v1/cloud/providers`.
 */
const OPENROUTER_PROVIDER_ID = "openrouter";

export function useDictationRefine(
  baseUrl: Accessor<string>,
  token: Accessor<string | undefined>,
  /**
   * Whether the on-device engine is usable at all (service in the catalog AND
   * the Profile flag). Clean-up runs on `asr_manager`'s own route, so when that
   * service is not there neither is this.
   */
  localAvailable: Accessor<boolean>,
) {
  const [enabled, setEnabledSignal] = createSignal(readDictationRefineEnabled());
  const [mode, setModeSignal] = createSignal<DictationRefineMode>(readDictationRefineMode());
  /**
   * The OpenRouter model serving `preset` mode, as the HOST reports it.
   *
   * NOT `localStorage` any more, and that is the security change rather than a
   * refactor: a value the renderer holds is a value the request carries, and
   * `/refine` sits on an unauthenticated port with a money-spending credential.
   * The model is host-side state now (`PUT /refine/preference`), so this signal
   * is a cache of the host's answer rather than the source of truth.
   *
   * Seeded with the shipped default so the picker can render before the first
   * probe answers; the effect below replaces it with the stored value.
   */
  const [model, setModelSignal] = createSignal(DEFAULT_DICTATION_REFINE_MODEL);
  /**
   * The service's own default, as the preference endpoint reports it. Empty until a
   * read or write has answered: the seeded `model` above is only a placeholder for
   * the picker, so a badge keyed on it would say "Default" over a model the host
   * never confirmed.
   */
  const [defaultModel, setDefaultModel] = createSignal("");
  /**
   * Latched after the service has said it cannot refine. A latch rather than a
   * re-probe per dictation because the answer is a property of the install: the
   * alternative is paying a doomed round trip on every utterance, which the user
   * experiences as dictation having become slower for no visible reason.
   *
   * Reset when the hub changes below, since a different (or restarted) hub is a
   * different install's worth of wiring.
   */
  const [unsupported, setUnsupported] = createSignal(false);
  const [openRouterReady, setOpenRouterReady] = createSignal(false);
  /**
   * Whether the probe returned a DEFINITIVE answer — not merely whether it ran.
   * A rejected probe leaves this false, so the three states this pair encodes
   * stay distinguishable:
   *
   * | `checked` | `ready` | meaning |
   * |---|---|---|
   * | false | false | we do not know (in flight, or the probe failed) |
   * | true  | true  | the user has an OpenRouter key |
   * | true  | false | the user has no OpenRouter key |
   *
   * Both consumers need that third row kept apart from the first. The card needs
   * it because "we asked and you have no OpenRouter key" is a reason to show and
   * "we do not know" is not — a reason that appears and then vanishes a second
   * after the page opens reads as a bug. `modeInUse()` needs it because it
   * reroutes the user's dictated text on a confirmed absence, and must not do
   * that on a guess.
   */
  const [openRouterChecked, setOpenRouterChecked] = createSignal(false);
  /**
   * Whether a local provider is committed, and whether we have a definitive
   * answer — the same two-signal shape as the OpenRouter pair above, for the same
   * reason: "we have not asked" must stay distinguishable from "we asked and
   * there is none", or the card shows a blocked reason for a second on every page
   * open and then withdraws it.
   *
   * Unlike the OpenRouter pair, `checked && !ready` does NOT reroute anything —
   * see the module docstring on why the local mode never falls back. It only
   * decides whether the card explains that the option cannot run yet.
   */
  const [localReady, setLocalReady] = createSignal(false);
  const [localChecked, setLocalChecked] = createSignal(false);

  /**
   * Bumped to re-run both probes below.
   *
   * WHY A NONCE AND NOT JUST THE HUB URL. Both probes ask LLMRouter about state
   * the user changes on a DIFFERENT settings page: the OpenRouter key and the
   * agent's cloud model. Keyed on the hub alone, the answers are fetched once at
   * startup and never again, so connecting OpenRouter and coming back here left
   * the option disabled under a message telling the user to do the thing they
   * had just done — with an app restart as the only way out. Observed on the
   * installed build with `GET /cloud/providers` already returning
   * `api_key_set: true`.
   */
  const [probeNonce, setProbeNonce] = createSignal(0);

  /**
   * One probe per hub (and per refresh). Cheap, and it does not touch
   * `asr_manager`: it asks LLMRouter which cloud providers hold a key.
   *
   * Gated on `localAvailable()` as well as on having a hub, so a build or
   * Profile without `asr_manager` asks nothing at all — there is no clean-up to
   * configure there, and the card says so without needing this answer.
   */
  createEffect(() => {
    const generation = probeNonce();
    // Invalidated on EVERY re-run, not just a nonce bump. `probeNonce` advances
    // only on `refreshRefineProbes()`, while this effect also re-runs when the
    // hub URL, the token or `localAvailable` change -- with the SAME generation.
    // A late answer from the PREVIOUS connection therefore passed the
    // generation check and overwrote the new one's result, which for the
    // provider probe below meant a confirmed OpenRouter key being replaced by
    // the old install's "no key" and the dictation silently rerouted to the
    // agent provider. `onCleanup` runs before the next re-run, so this closes
    // the window the nonce cannot see.
    let superseded = false;
    onCleanup(() => {
      superseded = true;
    });
    const base = baseUrl().trim();
    setUnsupported(false);
    setOpenRouterReady(false);
    setOpenRouterChecked(false);
    if (!base || !localAvailable()) return;
    const client = createLlmRouterClient({ baseUrl: base, token: token() ?? "" });
    void client
      .listProviders()
      .then((providers) => {
        // Dropped if a newer probe has started. Without this, the slow answer to
        // "do you have a key?" from BEFORE the user added one lands after the
        // refresh that found it and sets readiness back to false — which
        // disables the picker under a message telling them to do the thing they
        // just did. The models effect below already guards this way.
        if (superseded || probeNonce() !== generation) return;
        setOpenRouterReady(
          providers.some(
            (provider) => provider.id === OPENROUTER_PROVIDER_ID && provider.api_key_set,
          ),
        );
        setOpenRouterChecked(true);
      })
      .catch((error: unknown) => {
        // Still dropped when stale — a failed old probe must not overwrite a
        // fresh success either.
        if (superseded || probeNonce() !== generation) return;
        console.warn("[voice-input] could not read the cloud providers list:", error);
        setOpenRouterReady(false);
        // `checked` deliberately LEFT FALSE, which is the opposite of what this
        // handler used to do. An unreachable LLMRouter is not evidence about the
        // user's key, and `modeInUse()` reads `checked` as "the absence of a key
        // is confirmed" before it reroutes the dictation to the agent's
        // provider. Setting it true here made a transport fault indistinguishable
        // from "you have no key", so a single failed probe still changed the
        // recipient of the user's private text — the same defect as the
        // pre-probe window, one layer down.
        //
        // The card reads the same signal to decide whether to show "add your
        // key", and staying false is right there too: that instruction is a lie
        // when the real problem is that LLMRouter could not be reached. The
        // preset option stays selectable, and a dictation that actually needs
        // the key fails legibly and inserts the raw transcript.
        setOpenRouterChecked(false);
      });
  });

  /**
   * Load the stored clean-up model from the host.
   *
   * WHY THE HOST IS ASKED RATHER THAN `localStorage` READ. The model is the
   * field that decides what a `preset` dictation spends, and `/refine` sits on
   * an unauthenticated port with the credential to spend it — so it is host
   * state now, and the renderer is a cache. Reading it here means the picker
   * shows the value that will really be sent; a renderer-held copy could
   * disagree with the file the service reads, and the one on screen is the one
   * the user would believe.
   *
   * Gated on `localAvailable()` only, NOT on `enabled()`: unlike `/refine/model`
   * this is a file read, so it cannot boot the dormant ASR child into a NumPy /
   * ONNX warmup — and the card needs the current value to render its picker even
   * before clean-up is switched on.
   *
   * A failure leaves the seeded default in place. The picker then shows the
   * default while the host still holds the user's pick, which is the benign
   * direction: the next successful read corrects it, and nothing is written.
   */
  createEffect(() => {
    const generation = probeNonce();
    const base = baseUrl().trim();
    if (!base || !localAvailable()) return;
    const asr = createAsrClient({ baseUrl: base, token: token() ?? "" });
    void asr
      .refinePreference()
      .then((pref) => {
        if (probeNonce() !== generation) return;
        setModelSignal(pref.model);
        setDefaultModel(pref.default);
      })
      .catch((error: unknown) => {
        if (probeNonce() !== generation) return;
        console.warn("[voice-input] could not read the clean-up model:", error);
      });
  });

  /**
   * Is a local provider committed? Asked of LLMRouter, once per hub and refresh.
   *
   * WHY `getLocalProvider()` AND NOT THE CAPABILITY PROFILE. This has to mirror
   * the gate the DATA PLANE applies, and that gate is the user's declared
   * selection: `/v1/models` advertises `local-model` when a local provider has
   * been selected and hides it otherwise, "even if a backend happens to be
   * configured" (`routing/proxy.py::list_models`). A hardware- or
   * capability-derived answer would disagree with the route that actually serves
   * the dictation — offering an option that 424s, or hiding one that works.
   *
   * Same staleness guard as the probe above: an answer from before the user
   * committed a provider must not land after the refresh that found it.
   */
  createEffect(() => {
    const generation = probeNonce();
    // Invalidated on EVERY re-run, not just a nonce bump. `probeNonce` advances
    // only on `refreshRefineProbes()`, while this effect also re-runs when the
    // hub URL, the token or `localAvailable` change -- with the SAME generation.
    // A late answer from the PREVIOUS connection therefore passed the
    // generation check and overwrote the new one's result, which for the
    // provider probe below meant a confirmed OpenRouter key being replaced by
    // the old install's "no key" and the dictation silently rerouted to the
    // agent provider. `onCleanup` runs before the next re-run, so this closes
    // the window the nonce cannot see.
    let superseded = false;
    onCleanup(() => {
      superseded = true;
    });
    const base = baseUrl().trim();
    setLocalReady(false);
    setLocalChecked(false);
    if (!base || !localAvailable()) return;
    const client = createLlmRouterClient({ baseUrl: base, token: token() ?? "" });
    void client
      .getLocalProvider()
      .then((info) => {
        if (superseded || probeNonce() !== generation) return;
        // `null` is LLMRouter's own "local is not yet configured", which is
        // precisely what hides the alias from the data plane.
        setLocalReady(info.local_provider !== null);
        setLocalChecked(true);
      })
      .catch((error: unknown) => {
        if (superseded || probeNonce() !== generation) return;
        // `checked` left FALSE, as on the OpenRouter path: an unreachable
        // LLMRouter is not evidence that the user has no local model, and the
        // card's "pick a local model first" line would be a lie about a
        // transport fault. The option stays selectable and a dictation that
        // really cannot be served fails legibly to the raw transcript.
        console.warn("[voice-input] could not read the local provider selection:", error);
        setLocalReady(false);
        setLocalChecked(false);
      });
  });

  /**
   * The agent cloud model's id and the host's verdict on whether its reasoning
   * can be switched off.
   *
   * Two signals rather than one object so the pre-probe state is expressible:
   * `null` support means "we have not asked", which must render nothing. See
   * `dictation-reasoning-hint.ts` for why that is not the same as `"unknown"`.
   */
  const [agentModelId, setAgentModelId] = createSignal("");
  const [reasoningSupport, setReasoningSupport] = createSignal<AsrReasoningSupport | null>(null);
  const [hintDismissedFor, setHintDismissedFor] = createSignal(
    readDictationReasoningHintDismissed(),
  );

  /**
   * One probe per hub, chained: ask LLMRouter which cloud model agents use, then
   * ask `asr_manager` whether that model can be told to stop reasoning.
   *
   * Chained rather than parallel because the second call's arguments are the
   * first's answer — the UI must not hold its own copy of the provider/model
   * table, which would be a second source of truth that drifts the first time
   * either side is edited alone.
   *
   * GATED ON `enabled()`, and this is load-bearing rather than tidy.
   * `asr_manager` is `startup: "on_demand"` in `service_cfg.json`, and
   * ServiceHub's proxy starts a dormant child for any path that is not
   * `/v1/health` or `/v1/version` (`servicehub/app.py`). `/refine/model` is
   * neither, so an ungated probe booted ASR — and its NumPy/ONNX Runtime import
   * warmup — at app start, for a feature that is off by default and whose
   * settings page the user may never open.
   *
   * Gating costs nothing, because `decideReasoningHint` returns HIDDEN whenever
   * `cleanupEnabled` is false: while clean-up is off this probe's answer can
   * never be rendered. And `enabled` is a signal, so flipping the switch re-runs
   * this effect immediately — the warning still cannot arrive a beat *after* the
   * thing it warns about, which is why it is not gated on the Settings page
   * being open instead.
   */
  createEffect(() => {
    const generation = probeNonce();
    // Invalidated on EVERY re-run, not just a nonce bump. `probeNonce` advances
    // only on `refreshRefineProbes()`, while this effect also re-runs when the
    // hub URL, the token or `localAvailable` change -- with the SAME generation.
    // A late answer from the PREVIOUS connection therefore passed the
    // generation check and overwrote the new one's result, which for the
    // provider probe below meant a confirmed OpenRouter key being replaced by
    // the old install's "no key" and the dictation silently rerouted to the
    // agent provider. `onCleanup` runs before the next re-run, so this closes
    // the window the nonce cannot see.
    let superseded = false;
    onCleanup(() => {
      superseded = true;
    });
    const base = baseUrl().trim();
    setAgentModelId("");
    setReasoningSupport(null);
    if (!base || !localAvailable() || !enabled()) return;
    const bearer = token() ?? "";
    const router = createLlmRouterClient({ baseUrl: base, token: bearer });
    const asr = createAsrClient({ baseUrl: base, token: bearer });
    void router
      .getCloudModel()
      .then((cloud) => asr.refineModel({ provider: cloud.provider, model: cloud.model }))
      .then((info) => {
        if (superseded || probeNonce() !== generation) return;
        // The host's echoed id, not LLMRouter's, so the id the dismissal is
        // keyed on is the same string the verdict was about.
        setAgentModelId(info.model);
        setReasoningSupport(info.reasoning_support);
      })
      .catch((error: unknown) => {
        // Fail silent, not closed-with-a-warning. No configured cloud model is a
        // 404 here and is the ordinary state of a fresh install; an unreachable
        // probe is not evidence that a model reasons. Either way the only safe
        // answer is to say nothing — this is advice, and advice that fires on a
        // transport fault is advice nobody believes.
        if (superseded || probeNonce() !== generation) return;
        console.warn("[voice-input] could not check the clean-up model's reasoning:", error);
        setAgentModelId("");
        setReasoningSupport(null);
      });
  });

  /**
   * The host's verdict on the model CHOSEN for `preset` mode, and the id it was
   * about. A second probe rather than a reuse of the agent one: the two answer
   * different questions about different models, and collapsing them would make
   * the warning name whichever model happened to be probed last.
   *
   * Re-runs on `model()`, which is the point — picking a Gemini in the combobox
   * has to produce the warning on the same page, not after a restart.
   *
   * No `getCloudModel` hop in front of it: the provider is always OpenRouter here
   * (that is what `preset` mode means) and the model is the user's own pick, so
   * there is nothing to look up first.
   *
   * Gated on `enabled()` for the reason the agent probe above is: this also
   * calls `/refine/model`, which starts the dormant `asr_manager`.
   */
  const [presetModelId, setPresetModelId] = createSignal("");
  const [presetSupport, setPresetSupport] = createSignal<AsrReasoningSupport | null>(null);

  createEffect(() => {
    probeNonce();
    const base = baseUrl().trim();
    const target = model();
    // Guarding on `model() !== target` below catches a changed PICK but not a
    // changed CONNECTION: a late answer from the previous hub is about the same
    // model id and passes that check. This closes it.
    let superseded = false;
    onCleanup(() => {
      superseded = true;
    });
    setPresetModelId("");
    setPresetSupport(null);
    if (!base || !localAvailable() || !enabled()) return;
    const asr = createAsrClient({ baseUrl: base, token: token() ?? "" });
    void asr
      .refineModel({ provider: OPENROUTER_PROVIDER_ID, model: target })
      .then((info) => {
        // Dropped if the user has since picked a different model: a late answer
        // about the previous pick would warn about a model nobody is using.
        if (superseded || model() !== target) return;
        setPresetModelId(info.model);
        setPresetSupport(info.reasoning_support);
      })
      .catch((error: unknown) => {
        // Fail silent for the reason the agent probe does: an unreachable probe
        // is not evidence that a model reasons, and advice that fires on a
        // transport fault is advice nobody believes.
        console.warn("[voice-input] could not check the chosen clean-up model:", error);
        if (superseded || model() !== target) return;
        setPresetModelId("");
        setPresetSupport(null);
      });
  });

  /**
   * The OpenRouter catalog, for the model picker — ~389 entries on a live key.
   *
   * FETCHED ON DEMAND, not on page open. `wanted` stays false until the card
   * says the picker is actually usable (clean-up on, OpenRouter mode selectable),
   * so a user who never touches this setting never pays for the list. The flag is
   * a signal rather than a mutable boolean so that flipping it re-runs this
   * effect; a `let` would need its own re-render trigger.
   */
  const [wanted, setWanted] = createSignal(false);
  const [models, setModels] = createSignal<LlmRouterProviderModel[]>([]);
  const [modelsLoading, setModelsLoading] = createSignal(false);
  const [modelsFailed, setModelsFailed] = createSignal(false);

  createEffect(() => {
    const generation = probeNonce();
    // Invalidated on EVERY re-run, not just a nonce bump. `probeNonce` advances
    // only on `refreshRefineProbes()`, while this effect also re-runs when the
    // hub URL, the token or `localAvailable` change -- with the SAME generation.
    // A late answer from the PREVIOUS connection therefore passed the
    // generation check and overwrote the new one's result, which for the
    // provider probe below meant a confirmed OpenRouter key being replaced by
    // the old install's "no key" and the dictation silently rerouted to the
    // agent provider. `onCleanup` runs before the next re-run, so this closes
    // the window the nonce cannot see.
    let superseded = false;
    onCleanup(() => {
      superseded = true;
    });
    const base = baseUrl().trim();
    setModels([]);
    setModelsFailed(false);
    setModelsLoading(false);
    if (!wanted() || !base || !localAvailable()) return;
    setModelsLoading(true);
    const client = createLlmRouterClient({ baseUrl: base, token: token() ?? "" });
    void client
      .listProviderModels(OPENROUTER_PROVIDER_ID)
      .then((response) => {
        // A list that arrives after the hub changed describes the old install.
        if (superseded || probeNonce() !== generation) return;
        setModels(response.data ?? []);
      })
      .catch((error: unknown) => {
        if (superseded || probeNonce() !== generation) return;
        // Reported as a flag, not a message: the card's one line about it is
        // localized, and the raw LLMRouter error is of no use to the user. The
        // chosen model still works — only browsing the catalog is lost.
        console.warn("[voice-input] could not list the OpenRouter models:", error);
        setModelsFailed(true);
      })
      .finally(() => {
        if (superseded || probeNonce() !== generation) return;
        setModelsLoading(false);
      });
  });

  const available = () => localAvailable() && !unsupported();

  /**
   * The mode a dictation is actually sent with — the accessor the local provider
   * reads at send time.
   *
   * A stored `preset` with a CONFIRMED absence of an OpenRouter key falls back to
   * `agent` instead of failing: the saved preference is left alone (the user may
   * add the key later and the card still shows what they chose), and the
   * dictation is still cleaned up by something that works.
   *
   * WHY `openRouterChecked` AND NOT JUST `openRouterReady`. The fallback changes
   * who receives the user's dictated text — from their own OpenRouter key to
   * whatever provider the agent model sits behind. `openRouterReady` is false in
   * three different situations, and only one of them is "you have no key": it is
   * also false while the probe is still in flight, and false when the probe
   * failed. Keyed on readiness alone, dictating in the second after startup, or
   * through a transient LLMRouter blip, silently rerouted private text to a
   * provider the user did not choose for it.
   *
   * So the fallback now requires the probe to have actually answered. Staying on
   * `preset` while the answer is unknown is the safe end of the trade: if there
   * really is no key the call fails, and a failed refine inserts the raw
   * transcript with a notice (`decideDictationInsert`). Nothing is lost, and the
   * recipient is never substituted behind the user's back.
   *
   * WHY `local` IS NOT IN THIS RULE AT ALL. The preset fallback is safe because
   * both ends of it are cloud: the text was already leaving the machine, and only
   * the provider changes. Falling back FROM `local` would change that answer from
   * "nothing leaves this machine" to "a cloud provider now has it" — the one
   * property the user picked the mode for. So `local` is returned unchanged even
   * when {@link localReady} is a confirmed false, and the dictation is allowed to
   * fail to the raw transcript instead. See the module docstring.
   */
  const modeInUse = (): DictationRefineMode =>
    mode() === "preset" && openRouterChecked() && !openRouterReady()
      ? DEFAULT_DICTATION_REFINE_MODE
      : mode();

  /**
   * Whether to warn that the clean-up model cannot stop reasoning, and what to
   * offer. The gating is a pure function so it can be tested without a DOM;
   * every condition and its failure mode is documented there.
   *
   * A named accessor rather than an inline closure because the dismissal below
   * has to key on the same decision the card rendered — recomputing it from
   * `agentModelId` would record "I know" against a model the card never named.
   */
  const reasoningHint = (): ReasoningHintDecision =>
    decideReasoningHint({
      cleanupEnabled: enabled(),
      modeInUse: modeInUse(),
      reasoningSupport: reasoningSupport(),
      currentModelId: agentModelId(),
      presetReasoningSupport: presetSupport(),
      presetModelId: presetModelId(),
      presetAvailable: openRouterReady(),
      dismissedModelId: hintDismissedFor(),
    });

  return {
    // state
    refineEnabled: enabled,
    refineMode: mode,
    /** A `/refine` can be reached on this install. */
    refineAvailable: available,
    /** The preset mode has the user's own OpenRouter key behind it. */
    refineOpenRouterReady: openRouterReady,
    refineOpenRouterChecked: openRouterChecked,
    /** The local mode has a committed local provider behind it. */
    refineLocalReady: localReady,
    refineLocalChecked: localChecked,
    /**
     * Everything one `/refine` call needs except the transcript: the EFFECTIVE
     * mode (a stored `preset` with no key falls back to `agent`) and, for
     * `preset` only, the chosen model.
     *
     * JUST THE MODE NOW. The model used to ride along for `preset`, and
     * `/refine` refuses it today (400 `model_not_accepted`) because that field
     * was an arbitrary-model spend on an unauthenticated port. Which model
     * serves `preset` is host-side state the service reads for itself.
     */
    refineTarget: (): Omit<AsrRefineRequest, "text"> => ({ mode: modeInUse() }),
    /**
     * Re-ask LLMRouter for the OpenRouter key and the agent's cloud model.
     *
     * Call this when the user is in a position to have just changed either —
     * opening this settings page is the obvious moment, since both live on a
     * different page and neither sends an event this hook could listen for.
     */
    refreshRefineProbes: () => setProbeNonce((n) => n + 1),
    /** The OpenRouter model id serving `preset` mode. */
    refineModel: model,
    /** The service's default clean-up model; empty until the host has answered. */
    refineDefaultModel: defaultModel,
    /** The catalog for the picker. Empty until {@link ensureRefineModels} is called. */
    refineModelOptions: models,
    refineModelsLoading: modelsLoading,
    /** The catalog could not be listed. The chosen model still works. */
    refineModelsFailed: modelsFailed,
    /**
     * Ask for the OpenRouter catalog, once.
     *
     * Called by the card when the picker becomes usable, so a Settings visit that
     * never reaches that state never fetches ~389 models. Idempotent: it only
     * sets a flag, and the effect behind it is keyed on the hub.
     */
    ensureRefineModels: () => setWanted(true),
    refineReasoningHint: reasoningHint,
    // actions
    setRefineEnabled: (next: boolean) => {
      setEnabledSignal(next);
      writeDictationRefineEnabled(next);
    },
    setRefineMode: (next: DictationRefineMode) => {
      setModeSignal(next);
      writeDictationRefineMode(next);
    },
    /**
     * Point `preset` mode at a different OpenRouter model.
     *
     * Writes through the CONTROL PLANE and adopts what the host echoes back.
     * The host is the validator — it trims and rejects — so showing its answer
     * rather than the typed string is what keeps the picker from displaying a
     * value the dictation path would not actually send.
     *
     * A failed write leaves the signal alone, so the picker keeps showing what
     * is really stored instead of a choice that did not land.
     */
    setRefineModel: (next: string) => {
      const base = baseUrl().trim();
      if (!base) return;
      const asr = createAsrClient({ baseUrl: base, token: token() ?? "" });
      void asr
        .setRefinePreference(next)
        .then((saved) => {
          setModelSignal(saved.model);
          setDefaultModel(saved.default);
        })
        .catch((error: unknown) => {
          console.warn("[voice-input] could not save the clean-up model:", error);
        });
    },
    /** Put clean-up back on the measured default — the hint's one-click action. */
    useRecommendedRefineModel: () => {
      setModeSignal("preset");
      writeDictationRefineMode("preset");
      const base = baseUrl().trim();
      if (!base) return;
      const asr = createAsrClient({ baseUrl: base, token: token() ?? "" });
      void asr
        .setRefinePreference(DEFAULT_DICTATION_REFINE_MODEL)
        .then((saved) => {
          setModelSignal(saved.model);
          setDefaultModel(saved.default);
        })
        .catch((error: unknown) => {
          console.warn("[voice-input] could not save the clean-up model:", error);
        });
    },
    /**
     * The user acknowledged the reasoning warning for the model it named.
     *
     * Keyed on the id the DECISION carried, not on the agent model: in `preset`
     * mode the warning is about the user's own pick, and recording the agent
     * model there would dismiss a warning that was never shown while leaving the
     * shown one on screen.
     *
     * Keyed on an id rather than latched, so a *different* reasoning model warns
     * again: a boolean here would turn one "I know" into permanent silence about
     * facts the user never heard.
     */
    dismissRefineReasoningHint: () => {
      const decision = reasoningHint();
      if (!decision.show || !decision.modelId) return;
      setHintDismissedFor(decision.modelId);
      writeDictationReasoningHintDismissed(decision.modelId);
    },
    /** The service answered "this install cannot clean up". Stop offering it. */
    noteRefineUnsupported: () => setUnsupported(true),
  };
}

export type DictationRefineController = ReturnType<typeof useDictationRefine>;
