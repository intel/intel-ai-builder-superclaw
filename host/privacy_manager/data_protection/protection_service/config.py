"""Load and validate Privacy Manager configuration.

Config is read from YAML. Environment variables are used only for the optional
auth token. Dataclasses keep validation explicit and dependencies small.

The service has two PII pipelines: file redaction, which needs no models, and
optional text sanitization, which uses NER and regex rules.
Both pipelines restore values through /v1/restore.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from protection_service.constants import WORKSPACE_ROOT
from protection_service.paths import default_redacts_dir

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18400

# Hard limits catch accidental or unsafe operator config values.
ABSOLUTE_MAX_INLINE_BYTES = 50_000_000      # 50 MB
ABSOLUTE_MAX_TTL_SECONDS = 24 * 3600        # 1 day

# Allowed sanitize.session_evict_policy values; sanitize_state enforces them.
_VALID_EVICT_POLICIES = frozenset({"fifo", "lru"})


class ConfigError(ValueError):
    """Raised when configuration is invalid or internally inconsistent."""


@dataclass(frozen=True)
class ServerConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT


@dataclass(frozen=True)
class AuthConfig:
    enabled: bool = False
    token_env: str = "PROTECTION_API_TOKEN"

    @property
    def token(self) -> str | None:
        return os.environ.get(self.token_env) if self.enabled else None


@dataclass(frozen=True)
class RedactConfig:
    """Settings for /v1/file/redact and related file endpoints."""

    redacts_dir: Path
    max_inline_bytes: int = 5_000_000        # 5 MB
    # Registry size above which auto mode stores the registry on disk.
    max_inline_registry_bytes: int = 1_000_000   # 1 MB
    default_ttl_seconds: int = 300           # 5 minutes
    max_ttl_seconds: int = 3600              # 1 hour
    # Allowed roots for /v1/file/* source paths. Empty means unrestricted.
    # Real YAML configs default to WORKSPACE_ROOT when source_roots is omitted.
    source_roots: tuple[Path, ...] = ()
    # Maximum source file size read from disk. 0 = no cap.
    max_source_bytes: int = 500_000_000  # 500 MB

    # Optional fuzzy matching for /v1/session/query/rewrite.
    query_rewrite_fuzzy_enabled: bool = False
    # Minimum rapidfuzz ratio() score for fuzzy matches, from 0 to 100.
    query_rewrite_fuzzy_threshold: float = 92.0


@dataclass(frozen=True)
class SanitizeConfig:
    """Settings for /v1/text/redact and text sanitization.

    Set ``enabled=False`` to keep the route registered but return HTTP 503.
    """

    enabled: bool = True

    # Model directories. Relative paths resolve against the exe, cwd, or bundle.
    ner_model_path: str = "./models/pplx-pii-masking-ov-int8"
    # Persistent OpenVINO kernel cache. Other providers ignore this setting.
    # None = per-user default (paths.default_ov_cache_dir); a relative path
    # resolves against the exe.
    ov_cache_dir: str | None = None

    # Inference device.
    #
    # Generic values resolve to ONNX Runtime execution providers per platform:
    #   "AUTO"        try Intel GPU -> CPU. Recommended default.
    #   "INTEL_GPU"   require Intel iGPU / Arc dGPU; fail if not present.
    #   "INTEL_NPU"   require Intel NPU (Meteor Lake / Lunar Lake or newer).
    #   "CPU"         force CPU-only.
    #   "DIRECTML"    Windows-only: any GPU vendor (Intel/NVIDIA/AMD/iGPU)
    #                 through DirectML. Use when Intel GPU support is
    #                 desired but partner hardware is heterogeneous.
    #   "COREML"      macOS-only: CoreML (NPU + GPU + CPU fallback).
    #   "CUDA"        NVIDIA-only. Reserved for a separate GPU build variant.
    #
    # Legacy aliases accepted (mapped to "AUTO"): "GPU", "AUTO:GPU,CPU",
    # "AUTO:CPU,GPU". Under ONNX Runtime there is no single "GPU" because
    # Intel/NVIDIA/CoreML each need a different provider, so plain "GPU" is
    # treated as "AUTO" with platform-aware resolution.
    device: str = "AUTO"

    # Redact amounts to magnitude placeholders while keeping exact values for restore.
    bucketize_financial: bool = False

    # Handling for free monetary amounts:
    #   "mask"      - redact to <FINANCIAL_n>.
    #   "off"       - leave amounts unmasked for maximum LLM utility.
    #   "bucketize" - redact to a magnitude placeholder while keeping the exact
    #                 value in the registry for restore.
    # Financial identifiers like IBANs, cards, and tax IDs are always masked.
    fin_amount_mode: str = "mask"

    # Use text NER to improve file column detection for soft entities.
    detect_use_ner: bool = True

    # Use NER to find names, organizations, and places in free-form text.
    redact_use_ner: bool = True

    # Minimum NER confidence for soft entities in file free-text. 0.0 = no extra floor.
    redact_ner_min_confidence: float = 0.0

    # Mask the NER model's OTHER_PII catch-all in file free-text. Off by
    # default: it fires on values as small as a single gender character.
    redact_ner_other_pii: bool = False

    # Skip generic headers and boilerplate when masking ORG spans in files.
    redact_org_boilerplate_guard: bool = False
    # Extra case-insensitive boilerplate terms used by the ORG guard.
    redact_org_boilerplate_terms: tuple[str, ...] = ()

    # Run the English-only spaCy fallback only on English file text.
    redact_spacy_english_only: bool = True

    # Model-free CITY/COUNTRY gazetteer for English file text.
    redact_geo_gazetteer: bool = True

    # Accept phone-shaped values near anchors such as "phone", "tel", or "fax".
    redact_phone_anchor_boost: bool = False

    use_spacy: bool = True

    # Run the English-only spaCy text fallback only on English input.
    text_spacy_english_only: bool = True

    # Persistent SQLite L2 cache for NER inference.
    persistent_cache: bool = False
    # Directory for SQLite cache files. Relative paths resolve like ov_cache_dir.
    cache_dir: str = "./.cache"
    # Maximum rows in each L2 cache namespace.
    persistent_cache_max_entries: int = 100_000
    # L2 row TTL in seconds. 0 = no TTL.
    persistent_cache_ttl_seconds: int = 24 * 3600

    # Optional global custom-term map: "literal" -> "CATEGORY".
    custom_terms: dict[str, str] = field(default_factory=dict)

    # Idle-session TTL for sticky /v1/text/redact session_id state.
    session_ttl_seconds: int = 4 * 3600

    # Caps for sticky sessions and per-session entity registries.
    max_sessions: int = 10_000
    max_entities_per_session: int = 5_000

    # Eviction policy when a session hits max_entities_per_session:
    #   * "fifo": evict oldest inserted entities.
    #   * "lru": evict least recently reused entities.
    session_evict_policy: str = "fifo"

    # Maximum new entities one /v1/text/redact call may register.
    max_entities_per_request: int = 5_000


@dataclass(frozen=True)
class AppConfig:
    server: ServerConfig
    auth: AuthConfig
    redact: RedactConfig
    sanitize: SanitizeConfig
    log_level: str = "INFO"


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------


def load_config(path: str | Path | None) -> AppConfig:
    """Load YAML config and return a validated :class:`AppConfig`.

    ``path=None`` returns defaults for tests and smoke runs.
    """
    raw: dict[str, Any]
    if path is None:
        raw = {}
    else:
        p = Path(path).expanduser()
        if not p.exists():
            raise ConfigError(f"Config file not found: {p}")
        try:
            raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as exc:
            raise ConfigError(f"Failed to parse config file {p}: {exc}") from exc

    return _build_config(raw)


def _build_config(raw: dict) -> AppConfig:
    server = _build_server(raw.get("server") or {})
    auth = _build_auth(raw.get("auth") or {})
    redact = _build_redact(raw.get("redact") or {})
    sanitize = _build_sanitize(raw.get("sanitize") or raw.get("sanitizer") or {})
    log_level = str((raw.get("logging") or {}).get("level", "INFO")).upper()

    # Non-loopback services must restrict file paths or require auth.
    if _is_non_loopback_host(server.host) and not redact.source_roots and not auth.enabled:
        raise ConfigError(
            f"server.host={server.host!r} is non-loopback but neither "
            "redact.source_roots nor auth.enabled is set. Configure one of "
            "them before exposing the service to a non-loopback interface: "
            "an empty source_roots allow-list would let any client read "
            "arbitrary files on the host via /v1/file/redact."
        )

    return AppConfig(
        server=server,
        auth=auth,
        redact=redact,
        sanitize=sanitize,
        log_level=log_level,
    )


def _is_non_loopback_host(host: str) -> bool:
    """Return True when ``host`` binds outside loopback.

    Unknown hostnames are treated as network-reachable.
    """
    import ipaddress

    if not host:
        return False
    lower = host.strip().lower()
    if lower in ("localhost", ""):
        return False
    try:
        ip = ipaddress.ip_address(lower)
    except ValueError:
        # Treat non-numeric hostnames as network-reachable to be safe.
        return True
    return not ip.is_loopback


def _build_server(raw: dict) -> ServerConfig:
    return ServerConfig(
        host=str(raw.get("host", DEFAULT_HOST)),
        port=int(raw.get("port", DEFAULT_PORT)),
    )


def _build_auth(raw: dict) -> AuthConfig:
    enabled = bool(raw.get("enabled", False))
    token_env = str(raw.get("token_env", "PROTECTION_API_TOKEN"))
    if enabled and not os.environ.get(token_env):
        raise ConfigError(
            f"auth.enabled is true but env var '{token_env}' is not set"
        )
    return AuthConfig(enabled=enabled, token_env=token_env)


def _build_redact(raw: dict) -> RedactConfig:
    redacts_dir_raw = raw.get("redacts_dir")
    if redacts_dir_raw:
        redacts_dir = Path(str(redacts_dir_raw)).expanduser()
        redacts_dir.mkdir(parents=True, exist_ok=True)
    else:
        redacts_dir = default_redacts_dir()

    max_inline_bytes = _int_in_range(
        raw, "max_inline_bytes",
        default=5_000_000, low=1, high=ABSOLUTE_MAX_INLINE_BYTES,
    )
    max_inline_registry_bytes = _int_in_range(
        raw, "max_inline_registry_bytes",
        default=1_000_000, low=1, high=ABSOLUTE_MAX_INLINE_BYTES,
    )
    default_ttl = _int_in_range(
        raw, "default_ttl_seconds",
        default=300, low=1, high=ABSOLUTE_MAX_TTL_SECONDS,
    )
    max_ttl = _int_in_range(
        raw, "max_ttl_seconds",
        default=3600, low=default_ttl, high=ABSOLUTE_MAX_TTL_SECONDS,
    )
    if default_ttl > max_ttl:
        raise ConfigError(
            "redact.default_ttl_seconds must be <= redact.max_ttl_seconds"
        )

    # Omitted source_roots defaults to WORKSPACE_ROOT; [] means unrestricted.
    source_roots_raw = raw.get("source_roots")
    if source_roots_raw is None:
        source_roots: list[Path] = [WORKSPACE_ROOT]
    else:
        if not isinstance(source_roots_raw, (list, tuple)):
            raise ConfigError(
                "redact.source_roots must be a list of directory paths"
            )
        source_roots = []
        for entry in source_roots_raw:
            p = Path(str(entry)).expanduser().resolve()
            if not p.is_dir():
                raise ConfigError(
                    f"redact.source_roots entry is not an existing directory: {p}"
                )
            source_roots.append(p)

    max_source_bytes = _int_in_range(
        raw, "max_source_bytes",
        default=500_000_000, low=0, high=10 * 1024 * 1024 * 1024,  # up to 10 GiB
    )

    query_rewrite_fuzzy_enabled = bool(raw.get("query_rewrite_fuzzy_enabled", False))
    query_rewrite_fuzzy_threshold = float(raw.get("query_rewrite_fuzzy_threshold", 92.0))

    return RedactConfig(
        redacts_dir=redacts_dir,
        max_inline_bytes=max_inline_bytes,
        max_inline_registry_bytes=max_inline_registry_bytes,
        default_ttl_seconds=default_ttl,
        max_ttl_seconds=max_ttl,
        source_roots=tuple(source_roots),
        max_source_bytes=max_source_bytes,
        query_rewrite_fuzzy_enabled=query_rewrite_fuzzy_enabled,
        query_rewrite_fuzzy_threshold=query_rewrite_fuzzy_threshold,
    )


def _build_sanitize(raw: dict) -> SanitizeConfig:
    """Build :class:`SanitizeConfig` from a sanitize block.

    ``sanitize`` and legacy ``sanitizer`` use the same schema.
    """
    enabled = bool(raw.get("enabled", True))

    fin_amount_mode = str(raw.get("fin_amount_mode", "mask")).lower()
    if fin_amount_mode not in ("mask", "off", "bucketize"):
        raise ConfigError(
            "sanitize.fin_amount_mode must be one of 'mask', 'off', 'bucketize'"
        )

    redact_ner_min_confidence = float(raw.get("redact_ner_min_confidence", 0.0))
    if not 0.0 <= redact_ner_min_confidence <= 1.0:
        raise ConfigError(
            "sanitize.redact_ner_min_confidence must be in [0.0, 1.0]"
        )

    org_boilerplate_terms_raw = raw.get("redact_org_boilerplate_terms") or []
    if not isinstance(org_boilerplate_terms_raw, list):
        raise ConfigError(
            "sanitize.redact_org_boilerplate_terms must be a list of strings"
        )
    redact_org_boilerplate_terms = tuple(str(t) for t in org_boilerplate_terms_raw)

    custom_terms = raw.get("custom_terms") or {}
    if not isinstance(custom_terms, dict):
        raise ConfigError("sanitize.custom_terms must be a mapping")

    session_ttl = int(raw.get("session_ttl_seconds", 4 * 3600))
    if session_ttl < 1:
        raise ConfigError("sanitize.session_ttl_seconds must be >= 1")

    max_sessions = int(raw.get("max_sessions", 10_000))
    if max_sessions < 1:
        raise ConfigError("sanitize.max_sessions must be >= 1")

    max_entities_per_session = int(raw.get("max_entities_per_session", 5_000))
    if max_entities_per_session < 1:
        raise ConfigError("sanitize.max_entities_per_session must be >= 1")

    session_evict_policy = str(
        raw.get("session_evict_policy", "fifo")
    ).strip().lower()
    if session_evict_policy not in _VALID_EVICT_POLICIES:
        raise ConfigError(
            f"sanitize.session_evict_policy={session_evict_policy!r} is not "
            f"recognized. Allowed values: {sorted(_VALID_EVICT_POLICIES)}."
        )

    max_entities_per_request = int(raw.get("max_entities_per_request", 5_000))
    if max_entities_per_request < 1:
        raise ConfigError("sanitize.max_entities_per_request must be >= 1")

    persistent_cache_max_entries = int(raw.get("persistent_cache_max_entries", 100_000))
    if persistent_cache_max_entries < 1:
        raise ConfigError("sanitize.persistent_cache_max_entries must be >= 1")

    persistent_cache_ttl_seconds = int(raw.get("persistent_cache_ttl_seconds", 24 * 3600))
    if persistent_cache_ttl_seconds < 0:
        raise ConfigError("sanitize.persistent_cache_ttl_seconds must be >= 0")

    return SanitizeConfig(
        enabled=enabled,
        ner_model_path=str(raw.get("ner_model_path") or "./models/pplx-pii-masking-ov-int8"),
        ov_cache_dir=str(raw["ov_cache_dir"]) if raw.get("ov_cache_dir") else None,
        device=_normalize_device(raw.get("device", "AUTO")),
        bucketize_financial=bool(raw.get("bucketize_financial", False)),
        fin_amount_mode=fin_amount_mode,
        detect_use_ner=bool(raw.get("detect_use_ner", True)),
        redact_use_ner=bool(raw.get("redact_use_ner", True)),
        redact_ner_min_confidence=redact_ner_min_confidence,
        redact_ner_other_pii=bool(raw.get("redact_ner_other_pii", False)),
        redact_org_boilerplate_guard=bool(
            raw.get("redact_org_boilerplate_guard", False)
        ),
        redact_org_boilerplate_terms=redact_org_boilerplate_terms,
        redact_spacy_english_only=bool(
            raw.get("redact_spacy_english_only", True)
        ),
        redact_geo_gazetteer=bool(raw.get("redact_geo_gazetteer", True)),
        redact_phone_anchor_boost=bool(
            raw.get("redact_phone_anchor_boost", False)
        ),
        use_spacy=bool(raw.get("use_spacy", True)),
        text_spacy_english_only=bool(raw.get("text_spacy_english_only", True)),
        persistent_cache=bool(raw.get("persistent_cache", False)),
        cache_dir=str(raw.get("cache_dir") or "./.cache"),
        persistent_cache_max_entries=persistent_cache_max_entries,
        persistent_cache_ttl_seconds=persistent_cache_ttl_seconds,
        custom_terms=dict(custom_terms),
        session_ttl_seconds=session_ttl,
        max_sessions=max_sessions,
        max_entities_per_session=max_entities_per_session,
        session_evict_policy=session_evict_policy,
        max_entities_per_request=max_entities_per_request,
    )


# Accepted device tokens after normalization.
_VALID_DEVICES = frozenset({
    "AUTO",
    "INTEL_GPU",
    "INTEL_NPU",
    "CPU",
    "DIRECTML",
    "COREML",
    "CUDA",
})

# Legacy OpenVINO-era spellings kept for existing configs.
_LEGACY_DEVICE_ALIASES = {
    "GPU": "AUTO",            # under ORT, "GPU" auto-resolves per platform
    "AUTO:GPU,CPU": "AUTO",
    "AUTO:CPU,GPU": "AUTO",
    "NPU": "INTEL_NPU",
    "DML": "DIRECTML",
}


def _normalize_device(raw_value: Any) -> str:
    """Normalize and validate ``sanitize.device``.

    Runtime provider selection happens later; this only catches unknown values.
    """
    if raw_value is None:
        return "AUTO"
    text = str(raw_value).strip().upper()
    if not text:
        return "AUTO"
    if text in _LEGACY_DEVICE_ALIASES:
        return _LEGACY_DEVICE_ALIASES[text]
    if text in _VALID_DEVICES:
        return text
    raise ConfigError(
        f"sanitize.device={raw_value!r} is not recognized. "
        f"Allowed values: {sorted(_VALID_DEVICES)}; "
        f"legacy aliases: {sorted(_LEGACY_DEVICE_ALIASES)}."
    )


def _int_in_range(raw: dict, key: str, *, default: int, low: int, high: int) -> int:
    value = int(raw.get(key, default))
    if not (low <= value <= high):
        raise ConfigError(
            f"redact.{key}={value} out of allowed range [{low}, {high}]"
        )
    return value
