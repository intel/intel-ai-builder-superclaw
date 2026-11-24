"""Sanitizer lifecycle + session state for /v1/text/redact.

This module owns the heavy ML state (the ONNX Runtime + spaCy sanitizer
instance, the per-session entity registries) so server.py stays a thin
routing layer. Holding that state in a single class lets it be
constructed from test fixtures and torn down cleanly.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional, Tuple

if TYPE_CHECKING:
    from text_protection._sanitizer_caches import TieredCache
    from text_protection.sanitizer import (
        ConsistentSanitizer,
        ReplacementRecord,
    )

from common.errors import PiiModelNotReady, SanitizerWarmingUp
from protection_service import dormant_cache, model_activation
from protection_service.config import SanitizeConfig
from protection_service.model_activation import candidate_anchors, exe_dir, resolve_model_path
from protection_service.model_delivery import ModelDelivery
from protection_service.paths import resolve_ov_cache_dir

logger = logging.getLogger(__name__)

# How long a request that needs the sanitizer waits for the background warm-up
# before failing with SanitizerWarmingUp: the same bound ServiceHub gives this
# service's start-up (ready_timeout_s), which the warm-up used to run inside.
SANITIZER_WARMUP_WAIT_SECONDS = 90.0


# Canonical category set, defined here so /v1/text/categories can return it
# without importing the sanitizer engine.
SENSITIVE_CATEGORIES: set[str] = {
    "PERSON", "EMAIL", "PHONE", "URL", "DATETIME", "ID",
    "ORG", "FINANCIAL", "SECRET", "STREET", "BUILDINGNUM",
    "ZIPCODE", "CITY", "AGE", "SEX", "GENDER", "COUNTRY", "COUNTY",
}

PII_LEVEL_SKIP_MAP: dict[str, Optional[set[str]]] = {
    "none": None,
    "medium": {"PERSON", "ORG", "CITY", "COUNTRY", "COUNTY"},
    "high": None,
    "custom": None,
}


# Inlined raw-label -> canonical-category map. We keep this here so request
# time normalization (resolve_skip, set_custom_level) doesn't have to import
# the heavy sanitizer module (which pulls spacy + onnxruntime). The
# authoritative copy lives in ConsistentSanitizer.LABEL_CATEGORY_MAP.
_LABEL_CATEGORY_MAP_INLINE: dict[str, str] = {
    "GIVENNAME": "PERSON", "SURNAME": "PERSON", "TITLE": "PERSON", "PERSON": "PERSON",
    "EMAIL": "EMAIL",
    "PHONE": "PHONE", "TELEPHONENUM": "PHONE",
    "URL": "URL", "IPV4": "URL", "MAC": "URL",
    "DATE": "DATETIME", "TIME": "DATETIME", "DATETIME": "DATETIME",
    "IDCARDNUM": "ID", "SOCIALNUM": "ID", "ID_NUM": "ID", "SSN": "ID",
    "DRIVERLICENSENUM": "ID", "PASSPORTNUM": "ID", "ID": "ID",
    "ORG": "ORG", "COMPANYNAME": "ORG",
    "CREDITCARDNUM": "FINANCIAL", "TAXNUM": "FINANCIAL", "PERCENT": "FINANCIAL",
    "FIN_AMOUNT": "FINANCIAL", "FIN_TERM": "FINANCIAL", "FIN_SENSITIVE_SENT": "FINANCIAL",
    "FINANCIAL": "FINANCIAL",
    "JWT": "SECRET", "API_KEY": "SECRET", "BEARER_TOKEN": "SECRET",
    "AWS_ACCESS_KEY": "SECRET", "PRIVATE_KEY": "SECRET", "GENERIC_TOKEN": "SECRET",
    "GITHUB_TOKEN": "SECRET", "SLACK_TOKEN": "SECRET", "STRIPE_KEY": "SECRET",
    "ACCOUNT": "SECRET", "SECRET": "SECRET",
    "STREET": "STREET", "BUILDINGNUM": "BUILDINGNUM", "ZIPCODE": "ZIPCODE",
    "CITY": "CITY", "AGE": "AGE", "SEX": "SEX", "GENDER": "GENDER",
    "COUNTRY": "COUNTRY", "COUNTY": "COUNTY",
    # PPLX raw labels (see text_protection._pplx_decoder.PII_TYPES)
    "private_person": "PERSON", "private_email": "EMAIL", "private_phone": "PHONE",
    "private_url": "URL", "private_date": "DATETIME",
    "private_address": "ADDRESS", "account_number": "FINANCIAL",
    "other_pii": "OTHER_PII",
}


def _normalize_category(name: str) -> str:
    return _LABEL_CATEGORY_MAP_INLINE.get(name, name)


@dataclass
class _Session:
    entity_registry: dict = field(default_factory=dict)
    counters: dict = field(default_factory=dict)
    last_seen: float = field(default_factory=time.monotonic)
    # Eviction-priority ledger over entities, keyed by (category, value).
    # Front = evict first. For "fifo" the front is the oldest-inserted
    # entity; for "lru" it's the least-recently-emitted one. Kept in sync
    # with ``entity_registry`` by ``_apply_entity_cap``. ``counters`` is
    # NEVER trimmed — placeholder numbers stay monotonic so an evicted
    # entity that reappears gets a fresh, higher-numbered placeholder
    # instead of colliding with a still-live one held by the client.
    order: "OrderedDict[Tuple[str, str], None]" = field(
        default_factory=OrderedDict
    )


class SanitizeManager:
    """Lifecycle manager for the heavy text-sanitize pipeline.

    Construct with a SanitizeConfig. The manager stays dormant (no models
    loaded) until ``start_initialize()`` or ``wait_ready()`` first runs
    ``initialize()`` in the background -- it loads the OpenVINO models and
    warms the JIT cache. If initialization fails the manager stays in a
    degraded state and every sanitize call returns the recorded reason.
    """

    def __init__(
        self, config: SanitizeConfig, models: Optional[ModelDelivery] = None
    ) -> None:
        self._config = config
        self.models = models if models is not None else ModelDelivery()
        self._sanitizer: Optional["ConsistentSanitizer"] = None
        # Serializes building and installing a sanitizer, so the start-up
        # warm-up and a post-download reload cannot overwrite each other.
        self._build_lock = threading.Lock()
        self._degraded_reason: Optional[str] = None
        # OrderedDict so session eviction is O(1): most-recently-used at the
        # back, LRU candidate at the front. A plain dict would force a linear
        # scan for min(last_seen) at the cap, which becomes a lock-holding
        # thundering herd at ~10 k sessions.
        self._sessions: "OrderedDict[str, _Session]" = OrderedDict()
        self._lock = threading.Lock()
        # Global custom-level mask. Set via /v1/text/custom-level.
        # Stored as an immutable frozenset and replaced atomically on write
        # (see set_custom_level) so reads in resolve_skip / categories can
        # snapshot the reference without holding self._lock. A concurrent
        # writer only rebinds the attribute; readers keep working against the
        # old frozenset until they re-read the field.
        self._custom_skip_categories: frozenset[str] = frozenset()
        # TieredCache instances (when persistent_cache is on) so the lifespan
        # can flush their write-behind queues on shutdown.
        self._tiered_caches: list = []
        # Set by close(); makes sweep_caches a no-op so a sweep already
        # in-flight from the RedactsStore hook cannot race with cache
        # teardown. Also makes close() safely idempotent.
        self._closing: bool = False
        # Serializes close() vs sweep_caches so the cache list can't be
        # torn down while another thread is walking it. Cheap (both paths
        # only acquire briefly to snapshot the list).
        self._cache_lock = threading.Lock()
        # Clear only while start_initialize's warm-up runs; wait_ready blocks
        # on it so a decision made mid-warm-up does not read "not loaded yet"
        # as "degraded".
        self._init_done = threading.Event()
        self._init_done.set()
        self._init_lock = threading.Lock()
        self._init_started = False
        self._warmup_overrun = False
        self._warmup_fatal = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start_initialize(self) -> None:
        """Run ``initialize()`` on a background thread and return at once.

        Only the first call starts a warm-up; later calls -- while it runs,
        after it loaded, or after it failed -- do nothing, so a failed load is
        never retried. Callers that need the sanitizer go through
        ``wait_ready()``. The thread is a daemon so an intentional shutdown
        never waits on a model load.

        ServiceHub does not see a stuck load as a readiness timeout, so a
        warm-up still running after ``SANITIZER_WARMUP_WAIT_SECONDS`` is logged
        once at ERROR and reported through ``degraded_reason`` and
        ``restart_reason``.

        Also checks for existing models in the background. Missing models are
        downloaded only through the consented ``prepare_models`` path.
        """
        with self._init_lock:
            if self._init_started:
                return
            self._init_started = True
            self._init_done.clear()
        threading.Thread(
            target=self.start_model_delivery,
            name="privacy-model-delivery-start",
            daemon=True,
        ).start()
        started = time.monotonic()

        def _overrun() -> None:
            if self.warming_up:
                self._warmup_overrun = True
                logger.error(
                    "Text-sanitizer warm-up still running after %.0fs",
                    time.monotonic() - started,
                )

        timer = threading.Timer(SANITIZER_WARMUP_WAIT_SECONDS, _overrun)
        timer.daemon = True

        def _warm_up() -> None:
            try:
                self.initialize()
            except BaseException as exc:
                # initialize() re-raises process-level signals; on this thread
                # nobody would see them, so fail legibly instead.
                self._sanitizer = None
                self._degraded_reason = (
                    f"{exc.__class__.__name__} during sanitizer warm-up"
                )
                self._warmup_fatal = True
                logger.error(
                    "Text-sanitize disabled: %s during warm-up",
                    exc.__class__.__name__,
                )
            finally:
                timer.cancel()
                self._init_done.set()

        timer.start()
        threading.Thread(target=_warm_up, name="sanitizer-warmup", daemon=True).start()

    def initialize(self) -> None:
        """Load the sanitizer. Records degraded_reason on failure."""
        if not self._config.enabled:
            self._degraded_reason = "sanitize.enabled is false in config"
            self.models.disable()
            return

        try:
            with self._build_lock:
                self._sanitizer = self._build_sanitizer()
            self._degraded_reason = None
        except (KeyboardInterrupt, SystemExit):
            # Never degrade to "sanitize off" on a process-level signal. A
            # synchronous caller handles the shutdown; start_initialize's
            # thread records it as the degraded reason.
            raise
        except Exception as exc:
            self._sanitizer = None
            # ``_degraded_reason`` is reported via GET /health — keep the
            # exception message (it identifies which model/path failed) so
            # operators can diagnose. We deliberately do NOT attach
            # ``exc_info=True``: a traceback frame's locals may hold the
            # offending input (e.g. a model path constructed from user
            # config, or a NER input snippet) and the default logging
            # handler will render them. Operators who need the trace can
            # enable DEBUG on this logger.
            self._degraded_reason = f"{exc.__class__.__name__}: {exc}"
            logger.warning(
                "Text-sanitize disabled: %s (config redact will still work)",
                exc.__class__.__name__,
            )
            logger.debug(
                "Text-sanitize initialization traceback:", exc_info=True
            )

    def _build_sanitizer(self) -> "ConsistentSanitizer":
        """Construct a sanitizer from the current config and model files."""
        from text_protection.sanitizer import ConsistentSanitizer

        cfg = self._config

        anchors = candidate_anchors()
        ner_path = resolve_model_path(self.models, cfg.ner_model_path, anchors)
        ov_cache = resolve_ov_cache_dir(cfg.ov_cache_dir, Path(exe_dir()))
        cache_dir = str(ov_cache) if ov_cache is not None else None

        # No presence pre-check here: ConsistentSanitizer degrades PPLX to None
        # when its directory is missing or incomplete. See ner_backend_label.

        # Optional two-tier persistent cache (L1 memory + L2 SQLite).
        ner_backend = self._build_cache_backends(ner_path)

        logger.info("Initializing text-sanitizer models...")
        start = time.time()
        sanitizer = ConsistentSanitizer(
            use_spacy=cfg.use_spacy,
            spacy_english_only=cfg.text_spacy_english_only,
            fin_amount_mode=cfg.fin_amount_mode,
            custom_terms=dict(cfg.custom_terms),
            ner_model_path=ner_path,
            device=cfg.device,
            ov_cache_dir=cache_dir,
            max_entities_per_request=cfg.max_entities_per_request,
            bucketize_financial=cfg.bucketize_financial,
            ner_cache_backend=ner_backend,
        )
        logger.info("Text-sanitizer ready in %.1fs", time.time() - start)
        return sanitizer

    # -- model delivery (see model_activation) --

    @property
    def config(self) -> SanitizeConfig:
        return self._config

    @property
    def sanitize_enabled(self) -> bool:
        return self._config.enabled

    @property
    def load_error(self) -> Optional[str]:
        """Why the last sanitizer build failed, or ``None``."""
        return self._degraded_reason

    def start_model_delivery(self) -> None:
        model_activation.start_delivery(self)

    def reload_models(self) -> None:
        model_activation.reload_sanitizer(self)

    def rebuild_sanitizer(self, *, require_ner: bool = False) -> list[TieredCache]:
        """Rebuild after the warm-up and swap in; returns the outgoing caches, detached, to close.

        A failed build closes its own caches and re-raises. With ``require_ner`` a build
        without NER counts as failed and is not swapped in.
        """
        self._init_done.wait()
        with self._build_lock:
            with self._cache_lock:
                outgoing = list(self._tiered_caches)
            try:
                sanitizer = self._build_sanitizer()
                if require_ner and model_activation.sanitizer_lacks_ner(sanitizer):
                    raise RuntimeError("the rebuilt sanitizer did not load NER")
            except BaseException:
                with self._cache_lock:
                    built = [c for c in self._tiered_caches if c not in outgoing]
                    self._tiered_caches = [c for c in self._tiered_caches if c not in built]
                model_activation.close_caches(built)
                raise
            self._sanitizer = sanitizer
            self._degraded_reason = None
            with self._cache_lock:
                self._tiered_caches = [c for c in self._tiered_caches if c not in outgoing]
        return outgoing

    def require_pii_model(self) -> None:
        model_activation.require_pii_model(self)

    def require_ner_loaded(self) -> None:
        model_activation.require_ner_loaded(self)

    def _build_cache_backends(self, ner_path: str):
        """Build a two-tier (L1 memory + L2 SQLite) NER cache backend, or ``None``.

        ``None`` means "use the sanitizer's default in-memory LRU" — which is
        what we return when persistent_cache is off, or if building the L2
        fails (persistence is a nice-to-have; it must never block startup).

        The L2 namespace is derived from the model directory + its
        ``model.onnx`` mtime/size, so upgrading a model yields a fresh
        namespace and stale rows are simply never read (no wrong outputs).
        """
        cfg = self._config
        if not cfg.persistent_cache:
            return None

        try:
            from text_protection._sanitizer_caches import (
                LRUCache,
                SqliteCache,
                TieredCache,
            )

            cache_dir = cfg.cache_dir
            if cache_dir and not Path(cache_dir).is_absolute():
                cache_dir = str((Path(exe_dir()) / cache_dir).resolve())
            # Create as 0o700 on POSIX so a fresh install is private to the
            # service user by default (mode is ANDed with umask; we set it
            # explicitly for a pre-existing dir below via _assert_cache_dir
            # _permissions). An operator can still relax if they want, but
            # then _assert_cache_dir_permissions will refuse to load the key.
            os.makedirs(cache_dir, mode=0o700, exist_ok=True)
            db_path = os.path.join(cache_dir, "inference_cache.sqlite")

            # HMAC-signed pickle: pickle stays for compactness (numpy arrays,
            # dataclasses) but each blob carries a keyed signature. On read,
            # a bad signature is treated as a miss — an attacker who managed
            # to write a row into the SQLite file cannot smuggle a malicious
            # pickle payload into ``pickle.loads`` because it never runs.
            # The key lives in ``cache_hmac.key`` next to the DB with 0600
            # permissions; if the file is missing we create a fresh 32-byte
            # secret. Losing the key is not fatal: rows signed under the old
            # key simply fail verification and re-populate.
            import hashlib
            import hmac
            import pickle

            hmac_key = _load_or_create_cache_hmac_key(cache_dir)

            def _encode(value: object) -> bytes:
                blob = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
                sig = hmac.new(hmac_key, blob, hashlib.sha256).digest()
                # 1-byte version tag lets a future encoding be added without
                # a full cache invalidation.
                return b"\x01" + sig + blob

            def _decode(payload: bytes) -> object:
                # Reject anything that doesn't look like a signed frame; the
                # sanitize path treats an exception here as a miss.
                if len(payload) < 33 or payload[0] != 1:
                    raise ValueError("unrecognized cache frame")
                sig, blob = payload[1:33], payload[33:]
                expected = hmac.new(hmac_key, blob, hashlib.sha256).digest()
                if not hmac.compare_digest(sig, expected):
                    raise ValueError("cache signature mismatch")
                return pickle.loads(blob)

            def _make(l1_size: int, namespace: str) -> "TieredCache | None":
                l2 = SqliteCache(
                    db_path,
                    namespace=namespace,
                    max_entries=cfg.persistent_cache_max_entries,
                    ttl_seconds=cfg.persistent_cache_ttl_seconds,
                    value_encoder=_encode,
                    value_decoder=_decode,
                )
                tiered = TieredCache(LRUCache(l1_size), l2)
                with self._cache_lock:
                    if not self._closing:
                        self._tiered_caches.append(tiered)
                        return tiered
                # close() already drained the list during the warm-up.
                tiered.close()
                return None

            # L1 sizes match the sanitizer's in-memory defaults so behavior is
            # identical on a warm process; the L2 adds cross-restart reuse.
            ner_backend = _make(256, _cache_namespace("ner", ner_path))
            logger.info(
                "Persistent cache ON (L2 at %s); ner=%s",
                db_path,
                "tiered" if ner_backend else "memory-only",
            )
            return ner_backend
        except Exception as exc:
            # Persistence is best-effort — fall back to in-memory caches.
            logger.warning(
                "Persistent cache disabled (%s: %s); using in-memory caches.",
                exc.__class__.__name__, exc,
            )
            return None

    def sweep_caches(self) -> int:
        """Reap expired L2 cache rows. Returns total rows removed.

        Registered as a sweep hook on the RedactsStore so it runs on the same
        60 s cadence that reaps stale path-mode redact files — one background
        task handles all on-disk PII hygiene. No-op when persistent cache is
        off or the manager is closing. Snapshots the cache list under
        ``_cache_lock`` so a concurrent ``close()`` cannot rip the list out
        while this walk is in progress. While the sanitizer is dormant there
        are no TieredCache instances yet, so sweep the existing SQLite file
        directly without constructing models or in-memory cache tiers.
        """
        with self._cache_lock:
            if self._closing:
                return 0
            caches = list(self._tiered_caches)
        if not caches:
            return self._sweep_dormant_cache()
        total = 0
        for cache in caches:
            try:
                total += cache.sweep()
            except Exception:
                logger.debug("Error sweeping tiered cache", exc_info=True)
        return total

    def _sweep_dormant_cache(self) -> int:
        """Reap expired persistent rows without starting the sanitizer."""
        return dormant_cache.sweep_expired(self._config)

    def close(self) -> None:
        """Flush and stop any tiered caches. Called from the FastAPI lifespan.

        Idempotent. Sets the closing flag under ``_cache_lock`` so an
        in-flight ``sweep_caches`` observes the transition and bails; any
        sweep already past the flag check has snapshotted the list and
        walks its own local copy while we drain here.
        """
        with self._cache_lock:
            if self._closing:
                return
            self._closing = True
            caches = self._tiered_caches
            self._tiered_caches = []
        for cache in caches:
            try:
                cache.close()
            except Exception:
                logger.debug("Error closing tiered cache", exc_info=True)

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    @property
    def ready(self) -> bool:
        return self._sanitizer is not None

    @property
    def degraded_reason(self) -> Optional[str]:
        if self._warmup_overrun and self.warming_up:
            return (
                f"warm-up still running after "
                f"{SANITIZER_WARMUP_WAIT_SECONDS:g}s"
            )
        if model_activation.pii_unavailable(self):
            return PiiModelNotReady.code
        return self._degraded_reason

    @property
    def restart_reason(self) -> Optional[str]:
        """Why this process needs replacing, or ``None``.

        A warm-up past its deadline, or one ended by a process-level signal,
        cannot recover in place; the ServiceHub health endpoint reports it so
        ServiceHub's watchdog replaces the process within its restart budget.
        So does a failed in-process reload after a model download: the files
        are installed, and a fresh process loads them at start-up. An ordinary
        load failure is not one: the service then runs degraded.
        """
        if self._warmup_overrun and self.warming_up:
            return self.degraded_reason
        if self._warmup_fatal:
            return self._degraded_reason
        return self.models.restart_reason

    @property
    def warming_up(self) -> bool:
        return not self._init_done.is_set()

    @property
    def dormant(self) -> bool:
        """True until a warm-up has ever started."""
        return not self._init_started

    def wait_ready(self) -> bool:
        """Start the warm-up if needed, wait it out, then return ``ready``.

        Blocks the calling thread: call it from a worker thread, never the
        event loop. Raises ``SanitizerWarmingUp`` (503) if the warm-up is still
        running after ``SANITIZER_WARMUP_WAIT_SECONDS``.
        """
        self.start_initialize()
        if not self._init_done.wait(SANITIZER_WARMUP_WAIT_SECONDS):
            raise SanitizerWarmingUp(
                f"Text sanitizer is still loading its models after "
                f"{SANITIZER_WARMUP_WAIT_SECONDS:g}s; retry shortly"
            )
        return self.ready

    # ------------------------------------------------------------------
    # Categories / custom level
    # ------------------------------------------------------------------

    def categories(self) -> dict[str, list[str]]:
        # Snapshot the frozenset once so writers cannot rebind mid-derivation.
        skip = self._custom_skip_categories
        return {
            "all_categories": sorted(SENSITIVE_CATEGORIES),
            "custom_skip_categories": sorted(skip),
            "custom_mask_categories": sorted(SENSITIVE_CATEGORIES - skip),
        }

    def set_custom_level(self, mask_categories: list[str]) -> dict[str, Any]:
        """Set the global mask set used when sensitivity_level=='custom'.

        Returns a dict with the resolved mask + skip lists, or raises
        ValueError if any category name is unknown.
        """
        normalized: list[str] = []
        for cat in mask_categories:
            n = cat.strip().upper()
            if not n:
                continue
            n = _normalize_category(n)
            normalized.append(n)
        invalid = set(normalized) - SENSITIVE_CATEGORIES
        if invalid:
            raise ValueError(
                f"Unknown categories: {sorted(invalid)}. "
                f"Valid: {sorted(SENSITIVE_CATEGORIES)}"
            )
        mask_set = set(normalized)
        # Atomic replace-on-write: build the new frozenset outside the lock,
        # then rebind under the lock. Concurrent readers of
        # self._custom_skip_categories snapshot the old reference and keep
        # iterating safely.
        new_skip = frozenset(SENSITIVE_CATEGORIES - mask_set)
        with self._lock:
            self._custom_skip_categories = new_skip
        return {
            "ok": True,
            "mask_categories": sorted(mask_set),
            "skip_categories": sorted(new_skip),
        }

    # ------------------------------------------------------------------
    # Sanitize / restore
    # ------------------------------------------------------------------

    def resolve_skip(
        self,
        *,
        sensitivity_level: Optional[str],
        skip_categories: Optional[list[str]],
        custom_mask_categories: Optional[list[str]],
    ) -> Optional[set[str]]:
        """Translate sensitivity_level + overrides into the skip set the sanitizer wants.

        Returns:
            None  -> mask everything the sanitizer is willing to mask.
            set() -> mask everything (no skips).
            set([...]) -> skip the listed categories.

        Raises:
            ValueError: on unknown category names in custom_mask_categories.
        """
        if sensitivity_level:
            level = sensitivity_level.strip().lower()
            if level == "no":
                level = "none"
            if level == "none":
                # Caller signals "bypass detection". The endpoint handler
                # short-circuits this case before resolve_skip is called.
                return SENSITIVE_CATEGORIES
            if level == "custom":
                if custom_mask_categories is not None:
                    normalized_mask = {
                        _normalize_category(c.strip().upper())
                        for c in custom_mask_categories
                    }
                    invalid = normalized_mask - SENSITIVE_CATEGORIES
                    if invalid:
                        raise ValueError(
                            f"Unknown categories: {sorted(invalid)}. "
                            f"Valid: {sorted(SENSITIVE_CATEGORIES)}"
                        )
                    mask_set = normalized_mask
                else:
                    # Snapshot the (immutable) frozenset — a concurrent
                    # set_custom_level only rebinds the attribute, so this
                    # local ref stays coherent.
                    skip_snapshot = self._custom_skip_categories
                    mask_set = SENSITIVE_CATEGORIES - skip_snapshot
                resolved = SENSITIVE_CATEGORIES - mask_set
            else:
                resolved = PII_LEVEL_SKIP_MAP.get(level)
        else:
            resolved = None

        # Explicit skip list always wins.
        if skip_categories:
            resolved = set(skip_categories)
        return resolved

    def sanitize(
        self,
        *,
        text: str,
        session_id: Optional[str],
        custom_terms: Optional[dict[str, str]],
        skip_categories: Optional[set[str]],
        bucketize_financial: Optional[bool] = None,
    ) -> tuple[str, dict[str, "ReplacementRecord"]]:
        """Run the heavy sanitizer. Returns (redacted_text, replacements).

        ``bucketize_financial`` is a per-request override of the configured
        default; ``None`` uses the sanitizer's construction-time default.
        """
        if self._sanitizer is None:
            raise RuntimeError(
                f"Sanitizer not ready: {self._degraded_reason or 'unknown reason'}"
            )

        self._evict_stale_sessions()

        session_entity_registry = None
        session_counters = None
        if session_id:
            with self._lock:
                if session_id not in self._sessions:
                    self._enforce_session_cap_locked()
                    self._sessions[session_id] = _Session()
                # Move this session to the back so it's the most-recently-used.
                # ``move_to_end`` is O(1). Combined with the ``popitem(last=False)``
                # in ``_enforce_session_cap_locked``, this keeps LRU eviction
                # O(1) end-to-end regardless of how many sessions are live.
                self._sessions.move_to_end(session_id)
                session = self._sessions[session_id]
                # Refresh last_seen at ENTRY so a long inference call cannot
                # let a concurrent _evict_stale_sessions reap the session
                # while we're still using it. The post-sanitize update below
                # bumps it again so future requests measure freshness from
                # the completion of the previous call. Together this makes
                # eviction a function of idle time, not in-flight time.
                session.last_seen = time.monotonic()
                session_entity_registry = session.entity_registry
                session_counters = session.counters

        # ``custom_terms`` is passed as a per-call snapshot; the sanitizer
        # layers it over its instance terms without mutating shared state,
        # so concurrent requests (with or without terms) stay isolated.
        redacted, replacements, updated_registry, updated_counters = (
            self._sanitizer.sanitize(
                text,
                session_entity_registry=session_entity_registry,
                session_counters=session_counters,
                skip_categories=skip_categories,
                bucketize_financial=bucketize_financial,
                custom_terms=dict(custom_terms) if custom_terms else None,
            )
        )

        if session_id:
            with self._lock:
                session = self._sessions[session_id]
                # Enforce the per-session entity cap by EVICTING the
                # lowest-priority entities down to the cap — never a
                # whole-registry flush. ``updated_counters`` is written
                # back untrimmed so placeholder numbers stay monotonic:
                # an evicted entity that reappears later gets a fresh,
                # higher-numbered placeholder and can't collide with a
                # still-live placeholder the client is holding. See
                # _reorder_and_cap_locked for the fifo/lru ordering.
                self._reorder_and_cap_locked(
                    session=session,
                    session_id=session_id,
                    updated_registry=updated_registry,
                    updated_counters=updated_counters,
                    replacements=replacements,
                )
                session.last_seen = time.monotonic()
                # Bump session recency at the tail again — the sanitize
                # call is complete; make sure this session is at the LRU
                # back so eviction picks a truly-idle session next.
                self._sessions.move_to_end(session_id)

        return redacted, replacements

    def _reorder_and_cap_locked(
        self,
        *,
        session: _Session,
        session_id: str,
        updated_registry: dict,
        updated_counters: dict,
        replacements: dict[str, "ReplacementRecord"],
    ) -> None:
        """Rebuild the session's eviction ledger and trim to the cap.

        Caller MUST hold ``self._lock``.

        ``updated_registry`` is ``{category: {value: placeholder}}``.
        The ledger ``session.order`` is an ``OrderedDict`` keyed by
        ``(category, value)`` with the FRONT being the next entity to
        evict. Policy:

          * ``fifo``: front = oldest-inserted entity. Entities keep their
            original position regardless of reuse.
          * ``lru``: front = least-recently-emitted entity. Any entity
            whose placeholder was emitted THIS call is moved to the tail.

        Mutates ``updated_registry`` in place (dropping evicted entries)
        and assigns ``session.order`` / ``.entity_registry`` /
        ``.counters``. ``counters`` is never trimmed.
        """
        cap = self._config.max_entities_per_session
        policy = self._config.session_evict_policy

        # (category, value) pairs currently in the registry, in registry
        # iteration order (a stable tiebreak for freshly-added keys).
        current_keys: list[Tuple[str, str]] = [
            (cat, val)
            for cat, mapping in updated_registry.items()
            for val in mapping
        ]
        current_set = set(current_keys)

        # Entities emitted THIS call: their placeholder appears in the
        # per-call ``replacements`` map. Used as the "recently used" set
        # for lru; ignored for fifo.
        used_now: set[Tuple[str, str]] = set()
        if policy == "lru":
            for cat, mapping in updated_registry.items():
                for val, ph in mapping.items():
                    if ph in replacements:
                        used_now.add((cat, val))

        old_order = session.order
        if policy == "lru":
            kept = [
                k for k in old_order
                if k in current_set and k not in used_now
            ]
            # New entities are always emitted this call, so they land in
            # ``used_tail``; ``new_unused`` is a defensive catch-all.
            new_unused = [
                k for k in current_keys
                if k not in old_order and k not in used_now
            ]
            used_tail = [k for k in current_keys if k in used_now]
            ordered_keys = kept + new_unused + used_tail
        else:  # fifo
            kept = [k for k in old_order if k in current_set]
            appended = [k for k in current_keys if k not in old_order]
            ordered_keys = kept + appended

        new_order: "OrderedDict[Tuple[str, str], None]" = OrderedDict(
            (k, None) for k in ordered_keys
        )

        evicted = 0
        while len(new_order) > cap:
            (cat, val), _ = new_order.popitem(last=False)
            catmap = updated_registry.get(cat)
            if catmap is not None:
                catmap.pop(val, None)
                if not catmap:
                    updated_registry.pop(cat, None)
            evicted += 1

        if evicted:
            logger.info(
                "[Sanitize] session %s at entity cap (%d); evicted %d "
                "%s entit%s. Counters stay monotonic — reappearing "
                "entities get fresh placeholder IDs.",
                session_id,
                cap,
                evicted,
                policy.upper(),
                "y" if evicted == 1 else "ies",
            )

        session.order = new_order
        session.entity_registry = updated_registry
        session.counters = updated_counters

    # ------------------------------------------------------------------
    # Free-text span provider (file pipeline sub-cell scanning, #1)
    # ------------------------------------------------------------------

    # File free-text/document categories contributed by NER. Regex spans are
    # collected first and keep priority on overlap, so PPLX can safely add
    # coverage for categories regex missed, especially in CJK text.
    _NER_SPAN_CATEGORIES = frozenset({
        "PERSON", "ORG", "CITY", "COUNTRY", "COUNTY",
        "ADDRESS", "FINANCIAL", "PHONE", "DATETIME", "SECRET", "EMAIL", "URL",
        # Trusted regex overrides can turn a PPLX span into ID.
        "ID",
    })

    # PPLX catch-all label; opt-in because it can match very small spans.
    _NER_SPAN_OTHER_PII = "OTHER_PII"

    # Column classification stays soft-entity-only; format categories would
    # outvote soft labels and then be discarded by the detector layer.
    _NER_COLUMN_CATEGORIES = frozenset({
        "PERSON", "ORG", "CITY", "COUNTRY", "COUNTY",
    })

    def ner_backend_label(self) -> str:
        """Execution backend that loaded the NER model, e.g. 'OpenVINO:GPU',
        'ONNXRuntime:CPU', or 'none'. Diagnostic — lets the eval/report state
        which EP actually ran rather than inferring it from the device config."""
        if self._sanitizer is None:
            return "none"
        try:
            return self._sanitizer.ner_backend_label()
        except Exception:
            return "unknown"

    def ner_score_oracle(self):
        """Return ``text -> [(start, end, category, score)]`` or ``None``.

        Diagnostic seam (used by the evaluation harness) exposing the NER
        model's per-span confidence WITHOUT masking — so a tool can inspect
        the score behind each span, e.g. to see whether a false positive was
        low- or high-confidence. Not used by the redaction path itself.
        Returns ``None`` when the sanitizer isn't ready.
        """
        if self._sanitizer is None:
            return None
        sanitizer = self._sanitizer

        def _oracle(text: str):
            try:
                return sanitizer.ner_scored_spans(text)
            except Exception as exc:
                logger.debug("NER score oracle failed on a cell: %s", exc)
                return []

        return _oracle

    def person_org_span_provider(self):
        """Return a SpanProvider that finds NER-grade PII spans in a cell.

        Used by the file pipeline to enrich free-text (notes/comments)
        column and document masking with model-grade detection across
        :data:`_NER_SPAN_CATEGORIES`. Returns ``None`` if the sanitizer
        isn't ready, so the caller falls back to regex-only span scanning.

        The returned callable is stateless (no session registry) and
        swallows nothing — it runs the sanitizer on the cell, then locates
        every non-overlapping occurrence of each NER-category original
        value. Values that can't be located (e.g. normalized away) are
        skipped rather than guessed.
        """
        if self._sanitizer is None:
            return None

        sanitizer = self._sanitizer
        ner_categories = self._NER_SPAN_CATEGORIES
        if bool(getattr(self._config, "redact_ner_other_pii", False)):
            ner_categories = ner_categories | {self._NER_SPAN_OTHER_PII}
        # Optional confidence floor: drop low-confidence NER spans in file
        # free-text to curb over-redaction of capitalized boilerplate in
        # formal documents. 0.0 = no floor (behavior unchanged).
        min_conf = float(getattr(self._config, "redact_ner_min_confidence", 0.0))
        # Optional ORG boilerplate guard: drop ORG spans that are formal-doc
        # boilerplate (all-caps headers / gazetteer). OFF by default.
        org_guard = bool(getattr(self._config, "redact_org_boilerplate_guard", False))
        org_terms = tuple(getattr(self._config, "redact_org_boilerplate_terms", ()))
        _is_org_boilerplate = None
        if org_guard:
            from common.validators import is_org_boilerplate as _is_org_boilerplate
        # Optional spaCy language gate: in non-English text, drop spaCy-origin
        # PERSON/ORG spans (those the multilingual ONNX NER did NOT also emit),
        # since the English-only spaCy model is the dominant over-redactor
        # there. OFF by default.
        spacy_en_only = bool(getattr(self._config, "redact_spacy_english_only", False))
        _looks_english = None
        if spacy_en_only:
            from common.textlang import looks_english as _looks_english
        # Both the floor and the language gate need the ONNX scored spans.
        need_scored = min_conf > 0.0 or spacy_en_only

        def _is_spacy_origin(idx: int, end: int, scored) -> bool:
            """A masked span is spaCy-origin if NO ONNX-scored span overlaps
            it (the ONNX oracle emits only model spans, not spaCy/custom)."""
            return not any(idx < e and s < end for s, e, _c, _sc in scored)

        def _below_floor(idx: int, end: int, scored) -> bool:
            """True iff a scored NER span overlaps [idx,end) AND its best
            overlapping score is below the floor.

            A span with NO scored overlap (spaCy fallback / custom term the
            model didn't emit) is never dropped — we only veto spans the
            model itself was unsure about."""
            best = None
            for s, e, _cat, score in scored:
                if idx < e and s < end:  # overlap
                    best = score if best is None else max(best, score)
            return best is not None and best < min_conf

        def _provider(text: str):
            try:
                _redacted, replacements, _reg, _cnt = sanitizer.sanitize(text)
            except Exception as exc:  # never break masking on a bad cell
                logger.debug("NER span provider failed on a cell: %s", exc)
                return []
            # Confidence oracle (computed once per cell, only when a floor or
            # the language gate needs it). Kept separate from the sanitize()
            # mechanism so spaCy / custom-term spans still flow through.
            scored: list = []
            if need_scored:
                try:
                    scored = sanitizer.ner_scored_spans(text)
                except Exception as exc:
                    logger.debug("NER scored-span oracle failed: %s", exc)
                    scored = []
            # Language gate is evaluated once per cell (whole-cell language).
            cell_non_english = (
                spacy_en_only and _looks_english is not None
                and not _looks_english(text)
            )
            spans: list[tuple[int, int, str, str]] = []
            used: list[tuple[int, int]] = []
            candidates: list[tuple[str, str]] = []
            for _ph, rec in replacements.items():
                category = (rec.meta or {}).get("category") or rec.type
                if category not in ner_categories:
                    continue
                original = rec.original
                if not original:
                    continue
                # Opt-in ORG boilerplate guard: skip formal-doc headers /
                # gazetteer terms mis-tagged as ORG (never real companies —
                # is_org_boilerplate spares corporate-suffix values).
                if (org_guard and category == "ORG"
                        and _is_org_boilerplate(original, org_terms)):
                    continue
                candidates.append((original, category))

            # Longest value first: str.find is position-greedy, so a short
            # value (a city) would otherwise bind to its occurrence INSIDE a
            # longer one (the full address containing it), and the longer
            # span would then lose the overlap check and leak its remainder.
            candidates.sort(key=lambda c: len(c[0]), reverse=True)

            for original, category in candidates:
                # Mask EVERY non-overlapping occurrence: a value repeated
                # within one cell must not leak on its second mention.
                start = 0
                while True:
                    idx = text.find(original, start)
                    if idx < 0:
                        break
                    end = idx + len(original)
                    if any(idx < ce and cs < end for cs, ce in used):
                        start = idx + 1
                        continue
                    # Both gates are per-occurrence: a rejected mention
                    # must not suppress a later, well-supported one.
                    if min_conf > 0.0 and _below_floor(idx, end, scored):
                        start = end
                        continue
                    # Language gate: in non-English text, drop a
                    # spaCy-origin span (model spans are multilingual and
                    # always kept).
                    if cell_non_english and _is_spacy_origin(idx, end, scored):
                        start = end
                        continue
                    used.append((idx, end))
                    spans.append((idx, end, category, original))
                    start = end
            return spans

        return _provider

    # ------------------------------------------------------------------
    # Entity column classifier (file pipeline column detection)
    # ------------------------------------------------------------------

    # Minimum fraction of a cell's characters a soft-entity span must
    # cover for the value to "count" as that entity. A value like
    # "Meeting with John re: Q3" has a PERSON span but is mostly other
    # text — it shouldn't vote the column PERSON. Whole-value name/org
    # cells clear this easily.
    _ENTITY_COVERAGE_MIN = 0.6

    def entity_column_classifier(self):
        """Return an ``EntityColumnClassifier`` backed by the NER model.

        Used by the file pipeline to classify heuristically-ambiguous
        columns as a soft named-entity type (PERSON / ORG / CITY /
        COUNTRY / COUNTY) — the categories the model-free detector is
        weakest at. Returns ``None`` if the sanitizer isn't ready, so the
        caller stays purely heuristic.

        The callable runs each sampled value through the sanitizer, checks
        whether a single soft-entity span covers most of the value, tallies
        the dominant category across values, and returns
        ``(category, coverage_fraction)`` for the majority category — or
        ``None`` to abstain when no category dominates. It never raises.
        """
        if self._sanitizer is None:
            return None

        sanitizer = self._sanitizer
        ner_categories = self._NER_COLUMN_CATEGORIES
        coverage_min = self._ENTITY_COVERAGE_MIN

        def _classify(values):
            if not values:
                return None
            counts: dict[str, int] = {}
            considered = 0
            for raw in values:
                v = str(raw).strip()
                if not v:
                    continue
                considered += 1
                try:
                    _red, replacements, _reg, _cnt = sanitizer.sanitize(v)
                except Exception as exc:  # abstain on a bad value, never raise
                    logger.debug("entity classifier failed on a value: %s", exc)
                    continue
                # Find the soft-entity span (if any) that covers most of v.
                best_cat = None
                best_cov = 0.0
                for _ph, rec in replacements.items():
                    category = (rec.meta or {}).get("category") or rec.type
                    if category not in ner_categories:
                        continue
                    orig = rec.original or ""
                    cov = len(orig) / len(v) if v else 0.0
                    if cov > best_cov:
                        best_cov, best_cat = cov, category
                if best_cat is not None and best_cov >= coverage_min:
                    counts[best_cat] = counts.get(best_cat, 0) + 1
            if not considered or not counts:
                return None
            top_cat = max(counts, key=counts.get)
            confidence = counts[top_cat] / considered
            return (top_cat, confidence)

        return _classify

    # ------------------------------------------------------------------
    # Sessions
    # ------------------------------------------------------------------

    def _evict_stale_sessions(self) -> None:
        ttl = self._config.session_ttl_seconds
        now = time.monotonic()
        with self._lock:
            stale = [sid for sid, s in self._sessions.items() if now - s.last_seen > ttl]
            for sid in stale:
                del self._sessions[sid]
        if stale:
            logger.info("[Sanitize] evicted %d stale session(s)", len(stale))

    def _enforce_session_cap_locked(self) -> None:
        """Drop the LRU session if we're at the configured cap.

        Caller MUST hold ``self._lock``. Called only on the path that
        is about to create a NEW session (an existing session_id never
        triggers eviction because it's already counted). Eviction
        targets the least-recently-used session so active clients aren't
        affected.

        O(1): ``self._sessions`` is an ``OrderedDict`` where the FRONT is
        the LRU candidate; new/refreshed sessions are moved to the back.
        ``popitem(last=False)`` pops the LRU in constant time.
        """
        cap = self._config.max_sessions
        while len(self._sessions) >= cap:
            oldest_sid, _ = self._sessions.popitem(last=False)
            logger.warning(
                "[Sanitize] session cap reached (%d); evicted LRU session %s",
                cap,
                oldest_sid,
            )


# --------------------------------------------------------------------------
# Path resolution helpers
# --------------------------------------------------------------------------


def _assert_cache_dir_permissions(cache_dir: str) -> None:
    """Refuse a cache_dir that non-owners can write to.

    A world- or group-writable cache directory is a code-execution vector:
    an attacker with write access can replace ``cache_hmac.key``, then plant
    a signed pickle in the SQLite DB that ``pickle.loads`` will happily
    unpickle. Restrict the directory to owner-only access at startup so
    the HMAC-signed cache is actually trustworthy.

    On POSIX we inspect the mode bits directly. On Windows we use a
    ctypes-based Win32 ACL walk (no pywin32 dependency) to reject a
    directory whose DACL grants write to well-known unrestricted
    principals (``Everyone``, ``Authenticated Users``, ``Users``). If
    the ACL walk cannot run (e.g. GetFileSecurity is unavailable), we
    fail closed with a clear message — the operator can either disable
    ``sanitize.persistent_cache`` or lock the ACL down.
    """
    if os.name == "posix":
        try:
            st = os.stat(cache_dir)
        except OSError:
            # Directory doesn't exist yet: caller creates it below with 0o700.
            return
        # Bits 0o022 = group-write + other-write. Either is a red flag: the
        # directory MUST be private to the service user.
        if st.st_mode & 0o022:
            raise RuntimeError(
                f"Cache directory {cache_dir!r} is group- or world-writable "
                f"(mode={oct(st.st_mode & 0o777)}). This is a code-execution "
                "vector: an attacker could replace cache_hmac.key and forge "
                "signed pickle payloads. Chmod to 0700 (owner-only) before "
                "enabling sanitize.persistent_cache."
            )
        return

    if os.name == "nt":
        if not os.path.exists(cache_dir):
            return
        try:
            _assert_windows_cache_dir_permissions(cache_dir)
        except RuntimeError:
            raise
        except Exception as exc:  # pragma: no cover — defensive
            # If we cannot inspect the ACL, fail closed rather than
            # silently accepting an unknown-permission cache_dir.
            raise RuntimeError(
                f"Cache directory {cache_dir!r} could not be ACL-verified "
                f"on Windows ({exc.__class__.__name__}: {exc}). Refusing "
                "to enable sanitize.persistent_cache without a permission "
                "check — either disable persistent_cache or verify the "
                "ACL manually and file a bug so this check can be relaxed."
            ) from exc


# Well-known SIDs that must NOT have write access to the cache_dir.
# These map to broadly-scoped principals that would let a non-service
# process replace ``cache_hmac.key`` and forge a signed pickle payload.
#   S-1-1-0        Everyone
#   S-1-5-7        Anonymous Logon
#   S-1-5-11       Authenticated Users
#   S-1-5-32-545   BUILTIN\Users
_WINDOWS_UNRESTRICTED_SIDS: frozenset[str] = frozenset({
    "S-1-1-0", "S-1-5-7", "S-1-5-11", "S-1-5-32-545",
})

# Access mask bits that grant write / delete / take-ownership on a
# directory. If any of these is granted to an unrestricted principal
# the attacker can replace cache_hmac.key. Values from winnt.h.
# FILE_EXECUTE (0x20) is deliberately excluded — traverse-only access
# is safe.
_WINDOWS_WRITE_MASK: int = (
    0x00000002  # FILE_WRITE_DATA / FILE_ADD_FILE
    | 0x00000004  # FILE_APPEND_DATA / FILE_ADD_SUBDIRECTORY
    | 0x00000010  # FILE_WRITE_EA
    | 0x00000100  # FILE_WRITE_ATTRIBUTES
    | 0x00040000  # WRITE_DAC
    | 0x00080000  # WRITE_OWNER
    | 0x00010000  # DELETE
    | 0x10000000  # GENERIC_ALL
    | 0x40000000  # GENERIC_WRITE
)


def _assert_windows_cache_dir_permissions(cache_dir: str) -> None:
    """Refuse a Windows cache_dir whose DACL grants write to broad principals.

    Uses ctypes bindings to Win32 ``advapi32`` — no pywin32 dependency.
    Walks the DACL and inspects each allow-ACE; a deny-ACE grants
    nothing so it is safe to skip.
    """
    import ctypes
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    DACL_SECURITY_INFORMATION = 0x00000004
    ERROR_INSUFFICIENT_BUFFER = 122

    # GetFileSecurityW: query the security descriptor length.
    GetFileSecurityW = advapi32.GetFileSecurityW
    GetFileSecurityW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.LPVOID,
        wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
    ]
    GetFileSecurityW.restype = wintypes.BOOL

    needed = wintypes.DWORD(0)
    ok = GetFileSecurityW(
        cache_dir, DACL_SECURITY_INFORMATION, None, 0, ctypes.byref(needed)
    )
    if not ok and ctypes.get_last_error() != ERROR_INSUFFICIENT_BUFFER:
        raise OSError(ctypes.get_last_error(), "GetFileSecurityW size query")

    buf = (ctypes.c_ubyte * needed.value)()
    ok = GetFileSecurityW(
        cache_dir, DACL_SECURITY_INFORMATION, buf, needed, ctypes.byref(needed)
    )
    if not ok:
        raise OSError(ctypes.get_last_error(), "GetFileSecurityW fetch")

    # Extract the DACL. GetSecurityDescriptorDacl gives back a PACL and
    # a "present" flag.
    GetSecurityDescriptorDacl = advapi32.GetSecurityDescriptorDacl
    GetSecurityDescriptorDacl.argtypes = [
        wintypes.LPVOID, ctypes.POINTER(wintypes.BOOL),
        ctypes.POINTER(wintypes.LPVOID), ctypes.POINTER(wintypes.BOOL),
    ]
    GetSecurityDescriptorDacl.restype = wintypes.BOOL

    dacl_present = wintypes.BOOL(False)
    dacl_ptr = wintypes.LPVOID(None)
    dacl_defaulted = wintypes.BOOL(False)
    if not GetSecurityDescriptorDacl(
        buf, ctypes.byref(dacl_present),
        ctypes.byref(dacl_ptr), ctypes.byref(dacl_defaulted),
    ):
        raise OSError(ctypes.get_last_error(), "GetSecurityDescriptorDacl")

    if not dacl_present.value:
        # No DACL present == everyone has full access.
        raise RuntimeError(
            f"Cache directory {cache_dir!r} has no DACL (grants everyone "
            "full access). This is a code-execution vector: an attacker "
            "could replace cache_hmac.key and forge signed pickle "
            "payloads. Tighten the ACL to the service account before "
            "enabling sanitize.persistent_cache."
        )
    if not dacl_ptr:
        # NULL DACL — also grants everyone full access.
        raise RuntimeError(
            f"Cache directory {cache_dir!r} has a NULL DACL (grants "
            "everyone full access). Same code-execution vector as above."
        )

    # Walk the ACL's ACEs. ACL header lives at dacl_ptr; ACE count is at
    # offset 4 (WORD).
    class _ACL(ctypes.Structure):
        _fields_ = [
            ("AclRevision", wintypes.BYTE),
            ("Sbz1", wintypes.BYTE),
            ("AclSize", wintypes.WORD),
            ("AceCount", wintypes.WORD),
            ("Sbz2", wintypes.WORD),
        ]

    acl = ctypes.cast(dacl_ptr, ctypes.POINTER(_ACL))[0]

    class _ACE_HEADER(ctypes.Structure):
        _fields_ = [
            ("AceType", wintypes.BYTE),
            ("AceFlags", wintypes.BYTE),
            ("AceSize", wintypes.WORD),
        ]

    class _ACCESS_ALLOWED_ACE(ctypes.Structure):
        _fields_ = [
            ("Header", _ACE_HEADER),
            ("Mask", wintypes.DWORD),
            # SidStart marks the offset of the SID inside the ACE; we
            # read it via ctypes arithmetic below.
        ]

    GetAce = advapi32.GetAce
    GetAce.argtypes = [
        wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.LPVOID),
    ]
    GetAce.restype = wintypes.BOOL

    ConvertSidToStringSidW = advapi32.ConvertSidToStringSidW
    ConvertSidToStringSidW.argtypes = [
        wintypes.LPVOID, ctypes.POINTER(wintypes.LPWSTR),
    ]
    ConvertSidToStringSidW.restype = wintypes.BOOL

    LocalFree = kernel32.LocalFree
    LocalFree.argtypes = [wintypes.HLOCAL]
    LocalFree.restype = wintypes.HLOCAL

    ACCESS_ALLOWED_ACE_TYPE = 0

    for i in range(acl.AceCount):
        ace_ptr = wintypes.LPVOID(None)
        if not GetAce(dacl_ptr, i, ctypes.byref(ace_ptr)):
            continue
        ace = ctypes.cast(ace_ptr, ctypes.POINTER(_ACCESS_ALLOWED_ACE))[0]
        if ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE:
            continue
        # SID starts right after (Header + Mask). Offset = 8 bytes.
        sid_ptr = ctypes.cast(
            ctypes.c_void_p(ace_ptr.value + 8), wintypes.LPVOID,
        )
        sid_str = wintypes.LPWSTR(None)
        if not ConvertSidToStringSidW(sid_ptr, ctypes.byref(sid_str)):
            continue
        try:
            s = sid_str.value or ""
        finally:
            LocalFree(sid_str)
        if s in _WINDOWS_UNRESTRICTED_SIDS and (ace.Mask & _WINDOWS_WRITE_MASK):
            raise RuntimeError(
                f"Cache directory {cache_dir!r} grants write access to "
                f"principal {s} (well-known unrestricted). This is a "
                "code-execution vector: an attacker in that group could "
                "replace cache_hmac.key and forge signed pickle payloads. "
                "Restrict the ACL to the service account before enabling "
                "sanitize.persistent_cache."
            )


def _load_or_create_cache_hmac_key(cache_dir: str) -> bytes:
    """Return a 32-byte HMAC key stored beside the L2 cache DB.

    Written once with 0600 permissions on first run and reused thereafter.
    A missing / short / unreadable key file is regenerated; rows signed
    under the old key simply fail verification and re-populate.
    """
    import secrets

    # Fail closed on a weak cache directory before we touch the key file —
    # otherwise an attacker who can write into cache_dir could pre-plant a
    # key of their own choosing.
    _assert_cache_dir_permissions(cache_dir)

    key_path = os.path.join(cache_dir, "cache_hmac.key")
    try:
        # Also refuse a key file that's readable by anyone but the owner
        # on POSIX: it was either created by a different process with
        # weaker settings, or the operator relaxed permissions after
        # install. Either way, a leaked key breaks the whole cache
        # signature story.
        if os.name == "posix":
            try:
                kst = os.stat(key_path)
                if kst.st_mode & 0o077:
                    logger.warning(
                        "cache_hmac.key at %s is group- or world-accessible "
                        "(mode=%s); tightening to 0600.",
                        key_path, oct(kst.st_mode & 0o777),
                    )
                    try:
                        os.chmod(key_path, 0o600)
                    except OSError:
                        pass
            except OSError:
                pass
        with open(key_path, "rb") as fh:
            data = fh.read()
        if len(data) == 32:
            return data
    except OSError:
        pass
    key = secrets.token_bytes(32)
    # O_EXCL avoids overwriting a concurrent writer's key on the rare race
    # where two workers both start with no key file.
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        fd = os.open(key_path, flags, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(key)
    except FileExistsError:
        # Another worker just created it — read that one instead so both
        # processes agree.
        try:
            with open(key_path, "rb") as fh:
                data = fh.read()
            if len(data) == 32:
                return data
        except OSError:
            pass
    except OSError as exc:
        # Non-fatal: fall back to an in-memory key. This means rows written
        # in this process won't verify across restarts, but sanitize still
        # works. Log so operators notice a broken cache_dir.
        logger.warning(
            "Could not persist cache HMAC key at %s (%s); "
            "using an ephemeral key. Persistent-cache reuse across "
            "restarts will be limited.",
            key_path, exc,
        )
    return key


def _cache_namespace(kind: str, model_path: str) -> str:
    """Stable L2 namespace for a model: kind + path + model.onnx identity.

    Includes the ``model.onnx`` size + mtime so replacing/upgrading a model
    (which changes its outputs) yields a new namespace — stale rows from the
    old model are then simply never read, instead of returning wrong spans.
    Falls back to the path alone if the file can't be stat'd.
    """
    import hashlib

    sig = os.path.abspath(model_path)
    try:
        st = os.stat(os.path.join(model_path, "model.onnx"))
        sig = f"{sig}:{st.st_size}:{int(st.st_mtime)}"
    except OSError:
        pass
    # Non-security: cache key for a local NER model artifact, not a signature.
    digest = hashlib.sha1(sig.encode("utf-8"), usedforsecurity=False).hexdigest()[:16]
    return f"{kind}:{digest}"
