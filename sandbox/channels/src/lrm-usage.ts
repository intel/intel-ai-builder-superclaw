/**
 * Out-of-band model provenance from LLMRouter's token-usage events.
 *
 * When a reply was produced through a router alias (`auto` / `local-model` /
 * `cloud-model`) the alias is not a model name, so the Slack/Telegram
 * `Model: …` footer needs the model the alias actually dispatched to. LRM
 * records that as `underlying_model` on every completed dispatch and exposes it
 * at `GET /llm-router/v1/usage/events`, which is where this module reads it.
 *
 * Previously the footer read a `[<model-id>] ` prefix LRM injected into the
 * reply body. That prefix is now opt-in and off by default
 * (`SUPERCLAW_LRM_MODEL_PREFIX`), because encoding metadata into assistant text
 * broke every JSON-only tool contract that forgot to strip it. `bridge.ts`
 * keeps the prefix as a fallback for the opt-in case only.
 *
 * Correlation is by `session_id` + `occurred_at` ordering. It cannot be by
 * message id: LRM reads `X-Opencode-Message-Id`, but opencode's `chat.headers`
 * hook input carries no message id, so the column is always NULL.
 *
 * The cursor is therefore load-bearing, and it must only ever hold an
 * `occurred_at` value handed back by LRM. Deriving it from the container's
 * `Date.now()` would silently skip or replay events, because the container and
 * the Windows host do not share a clock.
 *
 * What changed versus reading the prefix
 * --------------------------------------
 * Gained: the prefix was only ever read off the FRONT of the joined reply, so
 * it named the first LLM call of the turn — understating cloud usage whenever a
 * turn probed locally and then answered from the cloud. Taking the last event
 * in the window names the call that actually wrote the answer. The label also
 * stops being forgeable by model output: any model could open its reply with
 * `[Local-Qwen-35B] ` and have that rendered as the footer.
 *
 * Lost: identity binding. The prefix travelled inside the message, so nothing
 * could race it. A time window can be polluted by any other dispatch under the
 * same `session_id` that finishes after the reply — see below.
 *
 * Why the alias filter exists, and what it does not cover
 * ------------------------------------------------------
 * The HDR sidecar is such a polluter. `hybrid_dr_post_polish_processor.ts`
 * returns "still running in the background" once its 8-minute poll budget is
 * spent, the agent posts a visible reply, and the detached sidecar run keeps
 * calling `/v1/chat/completions` under the same opencode session id.
 *
 * Most of those are harmless: the `hybrid-deep-research` agent pins
 * `llmrouter/cloud-model` (`sandbox/agent_config/profiles/pro/opencode.jsonc`) and
 * every sidecar node except `fill` requests `cloud-model` too, so they resolve
 * through the same alias to the same `underlying_model` as the turn itself. The
 * one node that differs is `fill`, which requests `local-model` — that is the
 * event that would mislabel the footer. Preferring events whose `alias` matches
 * the turn's alias drops it.
 *
 * This is a heuristic, not a partition. Two known gaps:
 *
 * - A sidecar node sharing the turn's alias but resolving to a different
 *   `underlying_model` would still win. That cannot happen for `cloud-model` /
 *   `local-model` (both resolve to a configured singleton) but is possible for
 *   `auto`, which re-runs the latency router per request.
 * - opencode's `ensureTitle` is a same-session dispatch on `small_model`
 *   (`llmrouter/auto`), i.e. alias `auto`, and it is forked on the service scope
 *   so it can land after the reply. It is inert here only because
 *   `bridge.ts` creates sessions with an explicit title and opencode skips title
 *   generation unless the title is still its own default. Changing the channels
 *   session title format would silently re-enable it.
 *
 * The clean fix is a discriminator LRM already computes and then discards:
 * `routing/proxy.py` parses the `Superclaw-Agent` header (present on every
 * opencode call, absent on every sidecar call) but `TokenEvent` has no column
 * for it. Adding one needs a schema migration first — `common/usage_store.py`
 * creates its tables with `CREATE TABLE IF NOT EXISTS` and has no versioning, so
 * a new column would simply be missing on existing installs and break inserts.
 */

/**
 * The base URL comes only from `LRM_API_BASE_URL`, read per call rather than at
 * module load so a test (or a restart) can change it. There is no guessed
 * fallback: the native router runs as the channel tier, which can reach no LRM
 * port, so an unset base means there is nothing to ask. Deliberately not routed
 * through `Config`: the sibling `INTENT_CLASSIFIER_URL` reads `process.env`
 * directly too.
 */

/**
 * Total budget for one lookup, shared by every base URL and every page.
 *
 * Deliberately a whole-call deadline rather than the per-request timeout in
 * `confirm_file_protection.ts`: this runs immediately before a reply is posted,
 * and a blackholed host (Windows Firewall DROP rather than a refused
 * connection) would otherwise multiply out to bases x pages of dead waiting.
 */
const TOTAL_BUDGET_MS = 1500;

/** Server caps `limit` at 1000 (`usage_store._LIMIT_MAX`). */
const PAGE_LIMIT = 1000;

/**
 * `GET /usage/events` is `occurred_at ASC` + `LIMIT`, so a cursor of 0 over a
 * long-lived session returns the OLDEST page, not the newest. Pages must be
 * followed to reach the current turn. Capped so a fast-but-huge session cannot
 * turn one reply into unbounded HTTP work. Hitting the cap yields a stale model,
 * and the advanced cursor closes the gap over the following turns — one turn if
 * the backlog fits in `MAX_PAGES * PAGE_LIMIT`, more if it does not. A cursor of
 * 0 only happens on a session's first lookup or after a bridge restart, since
 * the cursor is in-memory.
 */
const MAX_PAGES = 5;

/** Longest accepted model id; mirrors `resolveModelPrefix` in `./text.ts`. */
const MAX_MODEL_ID_LEN = 80;

export type UnderlyingModelLookup = {
  /** Model behind the alias, or `null` when it could not be resolved. */
  model: string | null;
  /** Cursor to pass to the next call for this session. Never goes backwards. */
  cursorMs: number;
};

type UsageEvent = { occurred_at?: unknown; underlying_model?: unknown; alias?: unknown };

type UsagePage = { events: UsageEvent[]; nextSinceMs: number | null };

function baseUrls(): string[] {
  const seen = new Set<string>();
  const bases: string[] = [];
  for (const candidate of [process.env.LRM_API_BASE_URL]) {
    const normalized = candidate?.trim().replace(/\/+$/, "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    bases.push(normalized);
  }
  return bases;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return truncated > 0 ? truncated : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Accept `value` only if it is shaped like a model id: no whitespace, at most
 * 80 characters. Same contract `resolveModelPrefix` in `./text.ts` enforced on
 * the prefix it replaced, and it matters for the same reason — the result is
 * rendered into the reply's `Model: *…*` Slack mrkdwn footer, which is the
 * "did this stay local" trust signal.
 *
 * `underlying_model` is not LRM's own invention: it is whatever the upstream
 * echoed back in the response's `model` field, and cloud providers are reachable
 * at an operator-supplied `base_url`. Without this check a hostile or merely
 * broken endpoint could answer with a `model` containing newlines and markdown
 * and have it rendered verbatim as provenance.
 */
function asModelId(value: unknown): string | null {
  const text = asNonEmptyString(value);
  if (text === null) return null;
  if (/\s/.test(text)) return null;
  if (text.length > MAX_MODEL_ID_LEN) return null;
  return text;
}

/** Fetch one page. Returns `null` for any transport, status or shape failure. */
async function fetchPage(
  base: string,
  sessionId: string,
  sinceMs: number,
  signal: AbortSignal,
): Promise<UsagePage | null> {
  const query = new URLSearchParams({
    session_id: sessionId,
    since_ms: String(sinceMs),
    limit: String(PAGE_LIMIT),
  });
  try {
    const apiKey = process.env.LRM_API_KEY?.trim();
    // egress-surface: opencode_router_lrm_usage
    const response = await fetch(`${base}/llm-router/v1/usage/events?${query.toString()}`, {
      signal,
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { events?: unknown; next_since_ms?: unknown };
    if (!Array.isArray(body.events)) return null;
    return {
      events: body.events as UsageEvent[],
      nextSinceMs: asPositiveInt(body.next_since_ms),
    };
  } catch {
    return null;
  }
}

/**
 * Walk this session's pages from `startCursor` and keep the last usable model.
 *
 * Two candidates are tracked: the last event whose `alias` matches the turn's,
 * and the last event of any alias. The alias match wins when there is one — see
 * the module docstring for why — and the unfiltered candidate is the fallback,
 * so a stale or missing `expectedAlias` degrades to the pre-filter behaviour
 * instead of losing the label. `sessionModels` is populated asynchronously from
 * opencode's event stream, so it can lag a turn behind an agent switch.
 *
 * Returns `null` only when the very first request failed, so the caller can
 * try the next base URL; once a base has answered it is authoritative, and an
 * empty result means "no dispatch recorded yet" rather than "wrong address".
 */
async function readSession(
  base: string,
  sessionId: string,
  startCursor: number,
  expectedAlias: string | null,
  signal: AbortSignal,
): Promise<UnderlyingModelLookup | null> {
  let cursor = startCursor;
  let latest = startCursor;
  let aliasMatch: string | null = null;
  let anyMatch: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(base, sessionId, cursor, signal);
    if (!result) return page === 0 ? null : { model: aliasMatch ?? anyMatch, cursorMs: latest };
    for (const event of result.events) {
      // ASC order, so the last event with a model wins: an agentic turn makes
      // several LLM calls and only the final one produced the visible reply.
      // The cursor advances over EVERY event, matching or not — it marks what
      // has been seen, so skipping filtered events would re-scan them forever.
      const occurredAt = asPositiveInt(event.occurred_at);
      if (occurredAt !== null && occurredAt > latest) latest = occurredAt;
      const underlying = asModelId(event.underlying_model);
      if (!underlying) continue;
      anyMatch = underlying;
      if (expectedAlias !== null && asNonEmptyString(event.alias) === expectedAlias) {
        aliasMatch = underlying;
      }
    }
    // `next_since_ms` is only set when the page was full; a non-advancing value
    // would loop forever, so treat it as the end too.
    if (result.nextSinceMs === null || result.nextSinceMs <= cursor) break;
    cursor = result.nextSinceMs;
  }

  return { model: aliasMatch ?? anyMatch, cursorMs: latest };
}

/**
 * Resolve the model behind a router alias for `sessionId`, considering only
 * events newer than `cursorMs`.
 *
 * `expectedAlias` is the alias the turn actually dispatched under — for channels
 * that is `sessionModels.get(key)?.modelID`, which opencode reports on the user
 * message after resolving `explicit model > agent.model > session default`, so it
 * is the same string LRM stored in `alias`. Pass `null` to skip the filter.
 *
 * Fails open: an unreachable, slow or malformed LRM yields
 * `{ model: null, cursorMs }` with the cursor untouched, so the caller falls
 * back to showing the alias and no reply is ever blocked or dropped.
 */
export async function resolveUnderlyingModel(
  sessionId: string,
  cursorMs: number,
  expectedAlias: string | null = null,
): Promise<UnderlyingModelLookup> {
  const session = asNonEmptyString(sessionId);
  const cursor = Number.isFinite(cursorMs) && cursorMs > 0 ? Math.trunc(cursorMs) : 0;
  if (!session) return { model: null, cursorMs: cursor };
  const alias = asNonEmptyString(expectedAlias);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_BUDGET_MS);
  try {
    for (const base of baseUrls()) {
      const lookup = await readSession(base, session, cursor, alias, controller.signal);
      if (lookup) return lookup;
      // Once the budget is spent, remaining bases would only fail instantly on
      // the aborted signal; skip the noise.
      if (controller.signal.aborted) break;
    }
    return { model: null, cursorMs: cursor };
  } finally {
    clearTimeout(timer);
  }
}
