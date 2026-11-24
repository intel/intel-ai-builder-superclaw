"""
LatentFactorRouter — router.py
==============================
Ridge-regression-based LLM router.

Uses query embeddings to predict performance and cost for each LLM via:
    E @ Lp = P  (performance)
    E @ Lc = C  (cost)

where E is the query representation matrix.

Features:
- 5-fold cross-validation during training
- Ridge/Tikhonov regularization
- Handles missing values via weighted least squares
- Probe set selection for cold-start new LLMs
- PCA for dimensionality reduction (optional)
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple, Union

import numpy as np
from loguru import logger

from llmrouter.models.meta_router import MetaRouter
from llmrouter.utils import save_model, load_model

from ..common import (
    find_pareto_optimal_models,
    load_all_routing_data,
    split_stratified_two_way,
    compute_baselines as _compute_baselines_common,
)
from ..common.data_utils import (
    normalise_rows as _normalise_rows_impl,
    pivot_long_rows as _pivot_long_rows_impl,
    normalise_wide_rows as _normalise_wide_rows_impl,
    pivot_df as _pivot_df_impl,
)
from ..common.embedding_cache import EmbeddingCache
from ..common.intent_classifier import IntentClassifier

if TYPE_CHECKING:
    from .latent_factor_model import (
        LatentFactorModel,
        LatentFactorModelWithCV,
        ResidualBoostedLatentFactorModel,
    )

# `logger` is imported from loguru above (SuperClaw convention).


@dataclass
class LatentFactorConfig:
    latent_dim: int = 32
    alpha: float = 1.0
    n_folds: int = 5
    probe_size: Optional[int] = None
    probe_method: str = "kmeans"
    enable_pca: bool = False
    pca_n_components: float = 0.99
    optimal_k_method: str = "combined"
    optimal_k_min: int = 5
    optimal_k_max: int = 50
    enable_residual_boost: bool = False
    boost_rounds: int = 100
    boost_max_depth: int = 3
    boost_lr: float = 0.1
    boost_min_samples_leaf: int = 20
    embedding_cache: Optional[bool] = None


class LatentFactorRouter(MetaRouter):
    """
    LatentFactorRouter — Ridge-regression-based LLM router.

    Uses query embeddings to predict performance and cost for each LLM via:
        E @ Lp = P  (performance)
        E @ Lc = C  (cost)

    where E is the query representation matrix.

    Parameters
    ----------
    yaml_path : str
        Path to configuration YAML.
    min_available_memory_gb : float
        Minimum free system RAM (GB) required to run the (embedding + algorithm)
        routing path. Below this, routing short-circuits to cloud so a
        memory-starved host doesn't attempt local embedding/inference.
    max_token_len : int
        Maximum token length of the WHOLE request (system prompt included) —
        i.e. what the LLM will actually see. Above this, routing short-circuits
        straight to cloud (the local model can't serve very long contexts well,
        and embedding a huge request is wasteful). Note this differs from the
        routing-text used for the embedding/algorithm, which strips the system
        prompt; the cap is measured on the full request because that is the
        context the serving model receives. When left as ``None``, the value is
        picked from total system RAM (see ``_hardware_defaults``): 30720 for
        32 GB hosts, 61440 for 64 GB+ hosts.
    max_turns : int
        Maximum number of assistant turns in a conversation before routing
        short-circuits to cloud. A long agentic / tool-calling loop degrades
        local-model quality and efficiency after many steps (it loses the
        thread, repeats tool calls, or stalls), so once the conversation has
        accumulated more than ``max_turns`` assistant turns we hand the rest of
        the run to the cloud model. When left as ``None``, defaults follow
        total system RAM (20 for 32 GB hosts, 30 for 64 GB+ hosts); overridable
        via the ``LATENTFACTOR_MAX_TURNS`` environment variable. Set to 0 (or
        negative) to disable the turn-count short-circuit entirely.
    """

    # --- Configured-model gating -----------------------------------------------
    # The artefact is trained over the full pool of local + cloud labels, but a
    # given deployment only runs ONE local model at a time. Scoring over the
    # full pool would let unreachable locals win and route traffic to a model
    # that isn't actually serving.
    #
    # The trained-pool metadata (which labels are local, their sizes/families,
    # which clouds to always skip, the capability-scaling alpha) lives in
    # ``pool_metadata.json`` next to this module — an INTERNAL file, shipped
    # with the artefact. Operators do not edit it.
    #
    # The OPERATOR-FACING declaration of what THIS host actually runs lives in
    # the sidecar's ``upstreams.json`` (the optional ``local`` block). The
    # sidecar resolves that against the pool metadata and then either:
    #   * exports ``LOCAL_LLM_MODEL`` so the env-based ``_configured_local_model``
    #     path works as-is, AND
    #   * calls ``set_capability_scale(label, scale)`` to install a discount
    #     on the mapped local's predicted P when the user's deployed model
    #     is smaller than the smallest trained label (e.g. 1B running against
    #     a trained 4B).
    #
    # Exclusion is applied INSIDE ``_score_models`` via ``excluded_mask`` so it
    # happens before p_max/c_max normalization — keeps the denominators
    # reflecting only candidates that can actually be selected. Training / eval
    # scoring passes no mask and stays configuration-agnostic.

    _POOL_METADATA_FILENAME = "pool_metadata.json"

    # Coarse route sentinels returned by the short-circuit paths (memory
    # starvation, over-token-cap, over-turn-cap, sticky-cloud repeat, and the
    # perf_weight endpoints). The sidecar treats "cloud" as an alias for the
    # cloud upstream; "local" resolves to the mapped-local upstream registered
    # at startup (see sidecar.create_app). Kept as class constants so
    # test-fixtures constructed via object.__new__ still see them.
    _CLOUD_ROUTE = "cloud"
    _LOCAL_ROUTE = "local"

    @classmethod
    def _load_pool_metadata(cls) -> Dict[str, Any]:
        """Load the internal pool registry from ``pool_metadata.json``.

        Failure modes are explicit: missing file or malformed JSON raises at
        startup rather than silently falling back to an empty pool. The
        metadata is small (one entry per trained local), so caching it on the
        instance is unnecessary — we read once per construction.
        """
        path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            cls._POOL_METADATA_FILENAME,
        )
        with open(path, "r") as f:
            data = json.load(f)
        if "locals" not in data:
            raise ValueError(f"{path}: missing required key 'locals'")
        return data

    def __init__(self, yaml_path: str) -> None:
        super().__init__(model=None, yaml_path=yaml_path)

        # --- Multi-turn routing efficiency ------------------------------------
        # A multi-turn conversation (e.g. a tool-calling loop) re-sends the same
        # user message on every turn; re-running embedding + the latent-factor
        # algorithm each time is pure waste when the decision is identical.
        # Cache the last routed user message + its decision so a repeat of the
        # same message that previously went to cloud can short-circuit.
        # (This is ML-coupled multi-turn state, NOT a serving/host policy.)
        self.last_request: str = ""
        self.last_route: str = ""

        # NOTE (SuperClaw): host/serving policies that the standalone sidecar
        # owned — free-memory floor, max-token-len cap, max-turns cap, and the
        # per-turn token-length cache — are DROPPED here. In SuperClaw they live
        # in the llmrouter_manager policy layer (routing/policy/*.py) + proxy.py
        # middleware, so re-implementing them in the router would double-gate.
        # The router is a PURE SCORING function; the manager enforces serving.

        # Pool metadata first — every helper below reads from these instance
        # attributes instead of class constants, so test code can monkey-patch
        # them per-instance without touching the file.
        _meta = self._load_pool_metadata()
        self._local_meta: Dict[str, Dict[str, Any]] = {
            entry["label"]: {"size_b": float(entry["size_b"]),
                             "family": str(entry["family"]).casefold()}
            for entry in _meta.get("locals", [])
        }
        self._LOCAL_MODELS: Tuple[str, ...] = tuple(self._local_meta.keys())
        self._EXCLUDED_CLOUD_MODELS: Tuple[str, ...] = tuple(
            _meta.get("excluded_clouds", [])
        )
        cap_cfg = _meta.get("capability_scaling", {}) or {}
        self._capability_alpha: float = float(cap_cfg.get("alpha", 0.3))
        # Multiplicative discount applied when the operator's local model is a
        # DIFFERENT family than the (qwen) trained pool. Size-only capability
        # transfer across families is lossier than within-family, but not so
        # lossy we should refuse to route local (that loses the token benefit).
        # 1.0 = treat all families identically. Tunable via pool_metadata.
        self._cross_family_scale: float = float(cap_cfg.get("cross_family_scale", 0.9))

        # Per-label capability scales applied to ``P_pred`` inside
        # ``_score_models``. Empty = no scaling (training / eval / full-pool
        # inference). Populated by the sidecar via ``set_capability_scale``
        # once it resolves the operator's ``local`` block.
        self._capability_scales: Dict[str, float] = {}

        cfg = self.cfg

        # Logging is centrally configured by
        # ``llmrouter_manager.common.logging.setup_logging`` (loguru sinks +
        # ``_InterceptHandler`` on the stdlib root); the per-router stdlib
        # bootstrap the standalone used is intentionally dropped. The
        # ``logging`` config section is retained but ignored (override via
        # ``LRM_LOG_LEVEL`` / ``LRM_LOG_DIR``).

        emb_cfg = cfg.get("embedding", {})
        # dataset.name namespaces the on-disk embedding cache. The bundled
        # artefact was trained under "merged2", so the same value is the
        # default — a minimal YAML that omits `dataset` reuses that cache
        # instead of starting a fresh empty one.
        dataset_name = cfg.get("dataset", {}).get("name", "merged2")
        # SuperClaw embedding backend = SERVED URL (edge /embeddings), NOT the
        # standalone's in-process OpenVINO. The router embeds via an HTTP
        # endpoint; api_key/base_url/model resolve from config with ${ENV}
        # substitution + LRM_EMBEDDING_* fallbacks. OpenVINO is disabled here.
        api_key = (emb_cfg.get("api_key") or "").strip()
        if api_key.startswith("${") and api_key.endswith("}"):
            env_var = api_key[2:-1]
            api_key = (os.getenv(env_var) or "").strip()
            if not api_key:
                raise ValueError(
                    f"api_key is empty after env-var substitution "
                    f"(${{{env_var}}} resolved to empty/unset)"
                )
        elif not api_key:
            api_key = (os.environ.get("LRM_EMBEDDING_API_KEY") or "").strip()

        base_url = (emb_cfg.get("base_url") or "").strip()
        if base_url.startswith("${") and base_url.endswith("}"):
            env_var = base_url[2:-1]
            base_url = (os.getenv(env_var) or "").strip()
            if not base_url:
                raise ValueError(
                    f"base_url is empty after env-var substitution "
                    f"(${{{env_var}}} resolved to empty/unset)"
                )
        elif not base_url:
            base_url = (os.environ.get("LRM_EMBEDDING_API_BASE") or "").strip()
            if not base_url:
                base_url = "http://127.0.0.1:18104/v1"

        model_name = (emb_cfg.get("model_name") or "").strip()
        if model_name.startswith("${") and model_name.endswith("}"):
            env_var = model_name[2:-1]
            model_name = (os.getenv(env_var) or "").strip()
            if not model_name:
                model_name = "text-embedding-3-large"
        elif not model_name:
            model_name = (os.environ.get("LRM_EMBEDDING_MODEL") or "").strip()
            if not model_name:
                model_name = "text-embedding-3-large"
        cache_dir = emb_cfg.get("cache_dir", ".cache/latentfactorrouter_embeddings")
        tokenizer_name = emb_cfg.get("tokenizer_name")
        tokenizer_file = emb_cfg.get("tokenizer_file")  # optional; None → tiktoken

        # PCA defaults to enabled with the shipped data/pca_model.pkl — the
        # space the latent-factor artefact was trained against.
        self.enable_pca = bool(emb_cfg.get("enable_pca", True))
        self.pca_n_components = float(emb_cfg.get("pca_n_components", 0.99))
        pca_model_path = emb_cfg.get("pca_model_path", "")

        self._max_tokens = int(emb_cfg.get("max_tokens", 8192))
        self._truncate_buffer = float(emb_cfg.get("truncate_buffer", 0.98))
        self._truncate_threshold = int(self._max_tokens * self._truncate_buffer)

        resolved_pca_model_path = None
        if self.enable_pca and pca_model_path:
            if os.path.isabs(pca_model_path):
                resolved_pca_model_path = pca_model_path
            else:
                project_root = os.path.abspath(
                    os.path.join(os.path.dirname(__file__), "..", "..")
                )
                resolved_pca_model_path = os.path.join(project_root, pca_model_path)

        resolved_tokenizer_file = None
        if tokenizer_file:
            if os.path.isabs(tokenizer_file):
                resolved_tokenizer_file = tokenizer_file
            else:
                project_root = os.path.abspath(
                    os.path.join(os.path.dirname(__file__), "..", "..")
                )
                resolved_tokenizer_file = os.path.join(project_root, tokenizer_file)

        self._emb_cfg = emb_cfg
        self._dataset_name = dataset_name
        self._api_key = api_key
        self._base_url = base_url
        self._model_name = model_name
        self._cache_dir = cache_dir
        self._tokenizer_name = tokenizer_name
        self._tokenizer_file = resolved_tokenizer_file
        self._resolved_pca_model_path = resolved_pca_model_path
        # OpenVINO in-process embedding is NOT used in SuperClaw (served-URL).
        self._openvino_model_path = None
        self._openvino_device = "AUTO"

        self.embedder = None
        self.intent_clf = None
        self._intent_enabled = True
        self._intent_classes = None
        ic_cfg = cfg.get("intent_classifier", {})
        if self._intent_enabled:
            classes_path = ic_cfg.get("classes_path")
            if classes_path and os.path.exists(classes_path):
                self._intent_classes = json.loads(Path(classes_path).read_text())

        lf_cfg = cfg.get("latent_factor", {})
        rt_cfg = cfg.get("routing", {})
        mt_cfg = cfg.get("metric", {}).get("weights", {})

        self.latent_dim = int(lf_cfg.get("latent_dim", 32))
        self.alpha = float(lf_cfg.get("alpha", 1.0))
        self.n_folds = int(lf_cfg.get("n_folds", 5))
        probe_size_raw = lf_cfg.get("probe_size", None)
        self.probe_size = int(probe_size_raw) if probe_size_raw is not None else None
        self.probe_method = str(lf_cfg.get("probe_method", "kmeans")).lower()
        self.seed = int(lf_cfg.get("seed", 42))
        self._train_val_ratio = float(lf_cfg.get("train_val_ratio", 0.9))

        optimal_k_cfg = lf_cfg.get("optimal_k", {})
        self.optimal_k_method = str(optimal_k_cfg.get("method", "combined")).lower()
        self.optimal_k_min = int(optimal_k_cfg.get("min_k", 5))
        self.optimal_k_max = int(optimal_k_cfg.get("max_k", 50))

        self.alpha_P_range = lf_cfg.get("alpha_P_range")
        self.alpha_C_range = lf_cfg.get("alpha_C_range")
        self.normalize_acc = bool(lf_cfg.get("normalize_acc", True))
        self.embed_augment = bool(lf_cfg.get("embed_augment", False))
        self.embed_noise_std = float(lf_cfg.get("embed_noise_std", 0.01))
        self.enable_residual_boost = bool(lf_cfg.get("enable_residual_boost", False))

        # Sample-weighting scheme (evaluation_spec.md §7.3). Defaults to
        # "uniform" so absence in config = byte-identical baseline behaviour.
        self.weight_scheme = str(lf_cfg.get("weight_scheme", "uniform")).lower()
        self.weight_scheme_params = dict(lf_cfg.get("weight_scheme_params", {}) or {})
        # Optional production-frequency proxy {stratum: probability} for
        # production_freq. None ⇒ self-proxy (derive from train rows at fit
        # time — spec §11.1 default).
        self.weight_p_prod_by_stratum = lf_cfg.get("weight_p_prod_by_stratum")
        self.boost_rounds = int(lf_cfg.get("boost_rounds", 100))
        self.boost_max_depth = int(lf_cfg.get("boost_max_depth", 3))
        self.boost_lr = float(lf_cfg.get("boost_lr", 0.1))
        self.boost_min_samples_leaf = int(lf_cfg.get("boost_min_samples_leaf", 20))

        self.top_k = int(rt_cfg.get("top_k", 1))
        self.excluded_models = list(rt_cfg.get("excluded_models", []))
        self.min_acc_thresh = float(rt_cfg.get("min_accuracy_threshold", 0.0))
        self.budget_limit = rt_cfg.get("budget_limit")

        # --- Topic-change detector -------------------------------------------
        # Reset the multi-turn cache (sticky-cloud + token/turn caches) when the
        # new user message is semantically far from the accumulated history.
        # Threshold precedence: env (LATENTFACTOR_TOPIC_CHANGE_THRESHOLD) >
        # yaml > offline-sweep default. Cosine below the threshold fires.
        # Default 0.35 comes from an offline sweep on 80 labeled pairs against
        # kalm-embedding v2.5 (F1=0.974 at 0.34; 0.35 trades ~0 recall for a
        # safer false-positive margin).
        tc_cfg = rt_cfg.get("topic_change", {}) or {}
        self._topic_change_enabled = bool(tc_cfg.get("enabled", True))
        _env_topic_threshold = (
            os.environ.get("LATENTFACTOR_TOPIC_CHANGE_THRESHOLD") or ""
        ).strip()
        if _env_topic_threshold:
            try:
                self._topic_change_threshold = float(_env_topic_threshold)
            except ValueError:
                logger.warning(
                    "[LatentFactorRouter] ignoring non-float "
                    "LATENTFACTOR_TOPIC_CHANGE_THRESHOLD={!r}; using yaml/default",
                    _env_topic_threshold,
                )
                self._topic_change_threshold = float(tc_cfg.get("threshold", 0.35))
        else:
            self._topic_change_threshold = float(tc_cfg.get("threshold", 0.35))
        # L2-normalized embedding of the last routing-text we successfully
        # routed. Populated only when the algorithm route runs (short-circuit
        # paths do not embed the request); cleared by ``_reset_multiturn_state``.
        self.last_history_embedding: Optional[np.ndarray] = None

        vb_cfg = cfg.get("verbose", {})
        self._verbose_enabled = bool(vb_cfg.get("enabled", False))

        # Track whether the operator explicitly set perf_weight in the YAML.
        # WHY: perf_weight is a pure SCORING-time knob (it's a coefficient in
        # the balance equation; the ridge fit doesn't depend on it). So an
        # artefact trained with perf_weight=0.9 can be served at 0.7 without
        # any retraining — the inference YAML should win on every restart.
        # Without this flag, ``load_artefacts`` would clobber the YAML value
        # with whatever was stamped into the pickle at training time, making
        # config edits silently no-op.
        self._perf_weight_from_yaml = "performance" in mt_cfg
        self._perf_weight = float(mt_cfg.get("performance", 0.7))
        self._cost_weight = 1.0 - self._perf_weight
        logger.info(
            f"[LatentFactorRouter] perf_weight={self._perf_weight}, "
            f"cost_weight={self._cost_weight}"
        )

        self.all_routing_data: List[Dict] = self._load_all_data()
        logger.info(
            f"[LatentFactorRouter] Total unified data: {len(self.all_routing_data)} queries."
        )

        self._latent_model: Optional[Union["LatentFactorModel", "LatentFactorModelWithCV"]] = None
        self._available_models: List[str] = []
        self._is_trained = False

        self._train_data: List[Dict] = []
        self._val_data: List[Dict] = []
        self._test_data: List[Dict] = []

        self._P_matrix: Optional[np.ndarray] = None
        self._C_matrix: Optional[np.ndarray] = None
        self._E_matrix: Optional[np.ndarray] = None

        self._probe_indices: Optional[np.ndarray] = None
        self._probe_embeddings: Optional[np.ndarray] = None

        # Artefact path is bundled with the binary under artefacts/. Operators
        # can override via config, but the default matches what the .spec ships,
        # so a minimal YAML that omits model_path Just Works.
        load_path = self._resolve_path(
            cfg.get("model_path", {}).get(
                "load_model_path", "artefacts/latent_factor_artefacts.pkl"
            )
        )
        if load_path and os.path.exists(load_path):
            self.load_artefacts(load_path)
        else:
            logger.info(
                "[LatentFactorRouter] No pre-trained artefacts found. "
                "Run LatentFactorTrainer.train() first."
            )

        logger.info("[LatentFactorRouter] Initialized.")

    def _load_all_data(self) -> List[Dict]:
        return load_all_routing_data(
            cfg=self.cfg,
            resolve_path_fn=self._resolve_path,
            router_instance=self,
            router_name="LatentFactorRouter",
        )

    def _normalise_rows(self, rows: List[Dict]) -> List[Dict]:
        return _normalise_rows_impl(rows, "LatentFactorRouter")

    def _pivot_long_rows(self, rows: List[Dict]) -> List[Dict]:
        return _pivot_long_rows_impl(rows)

    def _normalise_wide_rows(self, rows: List[Dict]) -> List[Dict]:
        return _normalise_wide_rows_impl(rows)

    def _pivot_df(self, df: Any) -> List[Dict]:
        return _pivot_df_impl(df, "LatentFactorRouter")

    def _ensure_embedder_for_training(self) -> None:
        """Lazily initialize embedder and intent classifier only when needed for training."""
        if self.embedder is not None:
            return
        logger.info("[LatentFactorRouter] Initializing embedder for training (cache enabled)...")
        self.embedder = EmbeddingCache(
            base_url=self._base_url,
            api_key=self._api_key,
            model_name=self._model_name,
            dataset_name=self._dataset_name,
            cache_dir=self._cache_dir,
            enable_pca=self.enable_pca,
            pca_n_components=self.pca_n_components,
            max_tokens=self._truncate_threshold,
            batch_size=int(self._emb_cfg.get("batch_size", 64)),
            pca_model_path=self._resolved_pca_model_path,
            skip_cache=False,
            tokenizer_name=self._tokenizer_name,
            tokenizer_file=self._tokenizer_file,
            openvino_model_path=self._openvino_model_path,
            openvino_device=self._openvino_device,
        )
        logger.info(f"[LatentFactorRouter] Embedding cache -> {self.embedder.base_db_path}")
        if self._intent_enabled:
            self.intent_clf = IntentClassifier(
                embedding_cache=self.embedder,
                intent_classes=self._intent_classes,
            )
            logger.info(f"[LatentFactorRouter] Intent classes: {self.intent_clf.labels}")

    def prepare_data(
        self, raw_data: List[Dict]
    ) -> Tuple[List[Dict], List[Dict]]:
        """
        Full pre-processing:
        1. Collect available models.
        2. Precompute ALL embeddings (one-shot, cache-first).
        3. Classify ALL intents (vectorised, before any split).
        4. Stratified 80/20 split by (dataset x intent).
           80% for train+val (5-fold CV), 20% for test only.
        5. Extract P (performance) and C (cost) matrices.
        """
        self._ensure_embedder_for_training()

        all_models: List[str] = []
        for item in raw_data:
            for m in item.get("records", {}).keys():
                if m not in all_models:
                    all_models.append(m)
        self._available_models = [m for m in all_models if m not in self.excluded_models]
        logger.info(
            f"[LatentFactorRouter] Models ({len(self._available_models)}): "
            f"{self._available_models}"
        )

        all_queries = [d["query"] for d in raw_data]
        logger.info(
            f"\n[LatentFactorRouter] Precomputing {len(all_queries)} embeddings "
            f"(cache-first, PCA={self.enable_pca})..."
        )
        self.embedder.precompute(all_queries, desc="Embedding all queries")

        logger.info("[LatentFactorRouter] Classifying intents...")
        intents = self._classify_intents(all_queries)
        for item, intent in zip(raw_data, intents):
            item["intent"] = intent
        logger.info(f"  Intent distribution: {dict(Counter(intents))}")

        train_data, test_data = self._split_stratified(raw_data)
        logger.info(
            f"[LatentFactorRouter] Split -> "
            f"train+val={len(train_data)}  test={len(test_data)}"
        )

        self._train_data = train_data
        self._test_data = test_data
        self._val_data = []

        return train_data, test_data

    def _split_stratified(self, data: List[Dict]) -> Tuple[List[Dict], List[Dict]]:
        return split_stratified_two_way(data, train_ratio=self._train_val_ratio, seed=self.seed)

    def extract_matrices(
        self, train_data: List[Dict]
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray, List[str]]:
        """
        Extract P (performance), C (cost), and E (embedding) matrices.

        Returns
        -------
        tuple of (E, P, C, model_names)
            E : np.ndarray, shape (n_instances, embed_dim or pca_dim)
            P : np.ndarray, shape (n_instances, n_llms)
            C : np.ndarray, shape (n_instances, n_llms)
            model_names : list of str
        """
        n_instances = len(train_data)
        n_llms = len(self._available_models)
        model_names = list(self._available_models)

        queries = [d["query"] for d in train_data]
        E = self._embed(queries)
        logger.info(
            f"[LatentFactorRouter] E matrix shape: {E.shape} "
            f"(PCA={self.enable_pca})"
        )

        model_to_idx = {m: j for j, m in enumerate(model_names)}
        P = np.full((n_instances, n_llms), np.nan, dtype=np.float64)
        C = np.full((n_instances, n_llms), np.nan, dtype=np.float64)

        for i, item in enumerate(train_data):
            records = item.get("records", {})
            usages = item.get("usages", {})
            if records:
                perf_entries = [
                    (model_to_idx[m], float(v)) for m, v in records.items() if m in model_to_idx
                ]
                if perf_entries:
                    model_indices, perf_values = zip(*perf_entries)
                    P[i, list(model_indices)] = perf_values
            if usages:
                cost_entries = [
                    (model_to_idx[m], float(u.get("cost", 0.0)))
                    for m, u in usages.items() if isinstance(u, dict) and m in model_to_idx
                ]
                if cost_entries:
                    model_indices, cost_values = zip(*cost_entries)
                    C[i, list(model_indices)] = cost_values

        logger.info(
            f"[LatentFactorRouter] P matrix: shape={P.shape}, "
            f"non-NaN={np.sum(~np.isnan(P))}/{P.size}"
        )
        logger.info(
            f"[LatentFactorRouter] C matrix: shape={C.shape}, "
            f"non-NaN={np.sum(~np.isnan(C))}/{C.size}"
        )

        self._E_matrix = E
        self._P_matrix = P
        self._C_matrix = C

        return E, P, C, model_names

    def fit_latent_model(
        self,
        E: np.ndarray,
        P: np.ndarray,
        C: np.ndarray,
    ) -> Union["LatentFactorModel", "LatentFactorModelWithCV", "ResidualBoostedLatentFactorModel"]:
        """
        Fit the latent factor model.

        Uses LatentFactorModelWithCV when n_folds > 1 for hyperparameter
        selection via cross-validation; otherwise uses LatentFactorModel
        with no CV.

        When enable_residual_boost is True, wraps the base model with
        ResidualBoostedLatentFactorModel for two-stage prediction:
        Stage 1: Linear latent factor model
        Stage 2: Gradient boosting on residuals

        The parameter search uses a two-phase coarse-to-fine approach:
        Phase 1 — log-spaced coarse grid over d × alpha
        Phase 2 — ternary search on log scale within best region

        Parameters
        ----------
        E : np.ndarray, shape (n_instances, embed_dim or pca_dim)
        P : np.ndarray, shape (n_instances, n_llms)
        C : np.ndarray, shape (n_instances, n_llms)

        Returns
        -------
        Union[LatentFactorModel, LatentFactorModelWithCV, ResidualBoostedLatentFactorModel]
        """
        from .latent_factor_model import LatentFactorModel, LatentFactorModelWithCV, ResidualBoostedLatentFactorModel

        if self.n_folds > 1:
            d_min_val = min(8, self.latent_dim)
            d_max_val = min(E.shape[1], np.linalg.matrix_rank(E))
            if d_max_val > d_min_val:
                n_d = min(20, d_max_val - d_min_val + 1)
                latent_dim_range = self._log_spaced_ints(d_min_val, d_max_val, n_d)
            else:
                latent_dim_range = [d_min_val]
            alpha_range = list(np.logspace(-4, 2, 9))

            alpha_P_range = getattr(self, 'alpha_P_range', None) or alpha_range
            alpha_C_range = getattr(self, 'alpha_C_range', None) or alpha_range

            base_model = LatentFactorModelWithCV(
                latent_dim_range=latent_dim_range,
                alpha_range=alpha_range,
                alpha_P_range=alpha_P_range,
                alpha_C_range=alpha_C_range,
                n_folds=self.n_folds,
                d_min=d_min_val,
                d_max=d_max_val,
                n_coarse=len(latent_dim_range),
                ternary_tol=3,
                normalize_acc=getattr(self, 'normalize_acc', True),
                embed_augment=getattr(self, 'embed_augment', False),
                embed_noise_std=getattr(self, 'embed_noise_std', 0.01),
            )

            logger.info(
                f"[LatentFactorRouter] Fitting latent model with CV: "
                f"latent_dim_range={latent_dim_range}, alpha_P_range={alpha_P_range}, alpha_C_range={alpha_C_range}, "
                f"n_folds={self.n_folds}, normalize_acc={self.normalize_acc}"
            )
        else:
            base_model = LatentFactorModel(
                latent_dim=self.latent_dim,
                alpha=self.alpha,
                n_folds=self.n_folds,
                normalize_acc=getattr(self, 'normalize_acc', True),
                embed_augment=getattr(self, 'embed_augment', False),
                embed_noise_std=getattr(self, 'embed_noise_std', 0.01),
            )

            logger.info(
                f"[LatentFactorRouter] Fitting latent model without CV: "
                f"latent_dim={self.latent_dim}, alpha={self.alpha}, n_folds={self.n_folds}"
            )

        if getattr(self, 'enable_residual_boost', False):
            model = ResidualBoostedLatentFactorModel(
                base_model=base_model,
                boost_rounds_per_llm=getattr(self, 'boost_rounds', 100),
                boost_max_depth=getattr(self, 'boost_max_depth', 3),
                boost_lr=getattr(self, 'boost_lr', 0.1),
                boost_min_samples_leaf=getattr(self, 'boost_min_samples_leaf', 20),
                random_state=getattr(self, 'seed', 42),
            )
            logger.info(
                f"[LatentFactorRouter] Residual boosting enabled: "
                f"rounds={getattr(self, 'boost_rounds', 100)}, "
                f"max_depth={getattr(self, 'boost_max_depth', 3)}, "
                f"lr={getattr(self, 'boost_lr', 0.1)}"
            )
        else:
            model = base_model

        # Build per-row sample weights from the configured scheme (default
        # uniform → None → byte-identical baseline path in _solve_ridge_col_wise).
        sample_weights = self._build_sample_weights(E)
        model.fit(
            E, P, C,
            perf_weight=self._perf_weight,
            cost_weight=self._cost_weight,
            weights=sample_weights,
        )

        self._latent_model = model
        self._is_trained = True

        return model

    def _build_sample_weights(self, E: np.ndarray):
        """Compute per-row weights from ``cfg.latent_factor.weight_scheme``.

        Returns ``None`` for the ``uniform`` scheme so the model's unweighted
        code path (the byte-identical baseline) is taken — see
        ``evaluation_spec.md`` §7.1. For any other scheme, returns a
        ``(n_instances,)`` ndarray with ``mean ≈ 1``.

        Stratum assignment for ``production_freq`` mirrors
        ``data_prep/poststratify.stratum_key`` (intent, with dataset-prefix
        fallback) so the training-side weighting is consistent with eval-side
        post-stratification.
        """
        scheme = getattr(self, "weight_scheme", "uniform")
        if scheme == "uniform":
            return None

        # `data_prep/weight_schemes.py` uses bare sibling imports
        # (`from complexity import ...`), so importing it requires
        # `data_prep/` itself on sys.path — not just its parent. Put it on
        # FIRST, then import, so we never cache a failed import attempt that
        # would poison the fallback path.
        import sys as _sys, os as _os
        _data_prep = _os.path.abspath(_os.path.join(
            _os.path.dirname(__file__), "..", "..", "data_prep"))
        if _data_prep not in _sys.path:
            _sys.path.insert(0, _data_prep)
        # Drop any stale failed-import cache entries from earlier attempts in
        # this process (they would raise ModuleNotFoundError again on retry).
        for _stale in ("data_prep.weight_schemes", "weight_schemes",
                       "data_prep.poststratify", "poststratify",
                       "complexity"):
            if _stale in _sys.modules and _sys.modules[_stale] is None:
                del _sys.modules[_stale]
        from weight_schemes import build_weights

        rows = self._train_data
        params = dict(self.weight_scheme_params or {})
        p_prod = self.weight_p_prod_by_stratum
        if scheme == "production_freq" and p_prod is None:
            # Self-proxy default (spec §11.1): derive p_prod from training rows.
            from collections import Counter
            from poststratify import stratum_key as _sk  # data_prep on sys.path already
            tags = [_sk(r, self._available_models, "intent") for r in rows]
            n = len(tags) or 1
            cnt = Counter(tags)
            p_prod = {g: c / n for g, c in cnt.items()}
        weights = build_weights(
            scheme,
            n_rows=E.shape[0],
            rows=rows,
            pool=self._available_models,
            E=E,
            p_prod_by_stratum=p_prod,
            params=params,
        )
        logger.info(
            "[LatentFactorRouter] weight_scheme={} params={} "
            "→ {} (mean={:.3f} min={:.3f} max={:.3f})",
            scheme, params,
            "n/a (uniform)" if weights is None else f"weights len={len(weights)}",
            float(weights.mean()) if weights is not None else 1.0,
            float(weights.min())  if weights is not None else 1.0,
            float(weights.max())  if weights is not None else 1.0,
        )
        return weights

    def _log_spaced_ints(self, lo: int, hi: int, n: int) -> List[int]:
        """Return n unique integers log-spaced between lo and hi (inclusive)."""
        if lo >= hi:
            return [lo]
        raw = np.unique(
            np.round(np.exp(np.linspace(np.log(lo), np.log(hi), n))).astype(int)
        )
        raw = np.clip(raw, lo, hi)
        return sorted(set(raw.tolist()))

    def select_probe_set(self, E: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """
        Select probe set for cold-start new LLM evaluation.

        Parameters
        ----------
        E : np.ndarray, shape (n_instances, embed_dim or pca_dim)
            All candidate embeddings.

        Returns
        -------
        tuple of (probe_indices, probe_embeddings)
        """
        from custom_routers.common.probe_selector import ProbeSelector

        selector = ProbeSelector(
            method=self.probe_method,
            probe_size=self.probe_size,
            seed=self.seed,
            min_k=self.optimal_k_min,
            max_k=self.optimal_k_max,
            optimal_k_method=self.optimal_k_method,
        )

        probe_indices, probe_embeddings = selector.fit_transform(E)

        self._probe_indices = probe_indices
        self._probe_embeddings = probe_embeddings

        if self.probe_size is None:
            logger.info(
                f"[LatentFactorRouter] Probe set auto-selected: "
                f"method={self.probe_method}, optimal_k={selector.optimal_k_}, "
                f"metrics_keys={list(selector.optimal_k_metrics_.keys()) if selector.optimal_k_metrics_ else 'N/A'}"
            )
        else:
            logger.info(
                f"[LatentFactorRouter] Probe set selected: "
                f"method={self.probe_method}, size={len(probe_indices)}"
            )

        return probe_indices, probe_embeddings

    def _ensure_embedder_for_inference(self) -> None:
        """Lazily initialize embedder for inference with caching disabled."""
        if self.embedder is not None:
            return
        logger.info("[LatentFactorRouter] Initializing embedder for inference (cache disabled)...")
        if self._openvino_model_path:
            logger.info(
                "embedding backend: in-process OpenVINO ({}, device={})",
                self._openvino_model_path, self._openvino_device,
            )
        else:
            logger.info(
                "embedding backend: HTTP {} (model={})",
                self._base_url, self._model_name,
            )
        self.embedder = EmbeddingCache(
            base_url=self._base_url,
            api_key=self._api_key,
            model_name=self._model_name,
            dataset_name=self._dataset_name,
            cache_dir=self._cache_dir,
            enable_pca=self.enable_pca,
            pca_n_components=self.pca_n_components,
            max_tokens=self._truncate_threshold,
            batch_size=int(self._emb_cfg.get("batch_size", 64)),
            pca_model_path=self._resolved_pca_model_path,
            skip_cache=True,
            tokenizer_name=self._tokenizer_name,
            tokenizer_file=self._tokenizer_file,
            openvino_model_path=self._openvino_model_path,
            openvino_device=self._openvino_device,
        )

    # ── Multi-turn routing helpers ───────────────────────────────────────
    @staticmethod
    def _extract_messages(query_input: Any) -> Optional[List[Dict[str, Any]]]:
        """Return the OpenAI-style ``messages`` list from *query_input* if present.

        ``route_single`` historically accepts ``{"query": str}``; callers that
        have the full chat request pass ``{"messages": [...]}`` (optionally
        alongside ``query``) so the router can do multi-turn short-circuiting.
        """
        if isinstance(query_input, dict):
            msgs = query_input.get("messages")
            if isinstance(msgs, list) and msgs:
                return msgs
        return None

    @staticmethod
    def _last_user_message(messages: List[Dict[str, Any]]) -> str:
        """Text of the most recent ``user`` message (the turn being routed)."""
        for m in reversed(messages):
            if m.get("role") == "user" and m.get("content"):
                content = m["content"]
                if isinstance(content, str):
                    return content
                # OpenAI content-parts: concatenate text parts.
                if isinstance(content, list):
                    parts = [
                        p.get("text", "")
                        for p in content
                        if isinstance(p, dict) and p.get("type") == "text"
                    ]
                    return " ".join(t for t in parts if t)
                return str(content)
        return ""

    @classmethod
    def _strip_system_prompt(cls, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Drop ``system`` messages — boilerplate that dilutes the embedding."""
        return [m for m in messages if m.get("role") != "system"]

    @classmethod
    def _message_text_parts(cls, m: Dict[str, Any]) -> List[str]:
        """Text fragments contributed by a single message: plain content +
        tool-call (function name + arguments) + legacy function_call.

        Shared by the full-request and routing-text builders so both count the
        same content per message (the only difference is whether system
        messages are included by the caller).
        """
        out: List[str] = []
        content = m.get("content")
        if isinstance(content, str) and content:
            out.append(content)
        elif isinstance(content, list):
            for p in content:
                if isinstance(p, dict) and p.get("type") == "text" and p.get("text"):
                    out.append(p["text"])

        tool_calls = m.get("tool_calls")
        if isinstance(tool_calls, list):
            for tc in tool_calls:
                if not isinstance(tc, dict):
                    continue
                fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
                name = fn.get("name")
                args = fn.get("arguments")
                parts = [str(name)] if name else []
                if isinstance(args, str) and args:
                    parts.append(args)
                elif args is not None:
                    parts.append(str(args))
                if parts:
                    out.append("tool_call: " + " ".join(parts))

        fc = m.get("function_call")
        if isinstance(fc, dict) and fc.get("name"):
            fc_args = fc.get("arguments")
            out.append(
                "tool_call: " + fc["name"]
                + (f" {fc_args}" if isinstance(fc_args, str) and fc_args else "")
            )
        return out

    @classmethod
    def _messages_to_routing_text(cls, messages: List[Dict[str, Any]]) -> str:
        """Build the text embedded for routing: user messages + tool-call turns
        so far, with the system prompt stripped.

        Unlike a last-user-message-only view, this includes the tool-call info
        (function name + arguments) and tool results, so the routing decision
        reflects what the conversation is actually DOING (a coding/tool-heavy
        turn looks different from a plain Q&A), not just the opening user text.
        Mirrors what the latent factor algorithm is trained on (the
        conversation minus system boilerplate).
        """
        out: List[str] = []
        for m in cls._strip_system_prompt(messages):
            out.extend(cls._message_text_parts(m))
        return "\n".join(out).strip()

    def _update_multiturn_cache(self, last_user: str, route: str) -> None:
        """Persist this turn's user message + decision for the next call."""
        if self.last_request != last_user:
            self.last_request = last_user
        if self.last_route != route:
            self.last_route = route

    def _reset_multiturn_state(self) -> None:
        """Clear the multi-turn ML state on a topic change so the next route
        runs as a fresh conversation: last routed message/decision + the cached
        history embedding used for topic-change detection. (The token-length
        cache the standalone also reset here is sidecar-owned in SuperClaw.)
        """
        self.last_request = ""
        self.last_route = ""
        self.last_history_embedding = None

    def _detect_topic_change(self, last_user: str) -> Optional[float]:
        """Return the cosine similarity between the new user message and the
        cached history embedding when it indicates a topic change, else None.

        Skips (returns ``None``) when:
          * detector disabled via yaml/env,
          * no cached history embedding (first turn or already reset),
          * ``last_user`` empty (tool-only turn — nothing to embed),
          * ``last_user == self.last_request`` (exact repeat: cosine ~1 and
            embedding call is pure waste),
          * the embedder isn't initialized yet (still on the pre-embed
            short-circuit path; run the check on the *next* turn once the
            algorithm has actually embedded a history).

        On a positive detection the caller resets the multi-turn cache
        (:meth:`_reset_multiturn_state`) and emits ``topic_reset=True`` so
        the serve layer can drop old history from the outbound LLM request.
        """
        if not getattr(self, "_topic_change_enabled", False):
            return None
        if getattr(self, "last_history_embedding", None) is None:
            return None
        if not last_user:
            return None
        if last_user == self.last_request:
            return None
        if self.embedder is None:
            return None
        try:
            new_vec = np.asarray(self._embed([last_user])[0], dtype=np.float32)
        except Exception as e:  # noqa: BLE001
            logger.warning("[LatentFactorRouter] topic-change embed failed: {}", e)
            return None
        norm = float(np.linalg.norm(new_vec)) + 1e-12
        new_vec = new_vec / norm
        cos = float(np.dot(new_vec, self.last_history_embedding))
        if cos < self._topic_change_threshold:
            return cos
        return None

    def set_perf_weight(self, perf_weight: float) -> None:
        """Live-update the performance/cost balance weight without a restart.

        ``balance = perf_weight * norm_perf - cost_weight * norm_cost`` with
        ``cost_weight = 1 - perf_weight``. Higher biases routing toward the
        higher-performing model (typically cloud); lower biases toward the
        cheaper model (typically local). Clamped to [0, 1].
        """
        pw = float(perf_weight)
        if not (0.0 <= pw <= 1.0):
            pw = max(0.0, min(1.0, pw))
        self._perf_weight = pw
        self._cost_weight = 1.0 - pw
        logger.info(
            "[LatentFactorRouter] perf_weight updated -> {:.3f} (cost_weight={:.3f})",
            self._perf_weight, self._cost_weight,
        )

    def get_perf_weight(self) -> float:
        """Current performance weight in [0, 1]."""
        return float(self._perf_weight)

    # ── Route entry point ────────────────────────────────────────────────
    def route_single(self, query_input: Dict[str, Any]) -> Dict[str, Any]:
        """Route a single query, with multi-turn short-circuiting.

        Accepts either ``{"query": str}`` (legacy) or ``{"messages": [...]}``
        (a chat request). When messages are available, redundant routing is
        skipped: a repeat of the last user message that already went to cloud,
        a memory-starved host, an over-long request, and an over-long
        tool-calling loop all short-circuit straight to ``cloud`` without
        embedding or running the algorithm.
        """
        self._require_trained()

        messages = self._extract_messages(query_input)
        if messages is not None:
            last_user = self._last_user_message(messages)
        else:
            last_user = (
                query_input["query"]
                if isinstance(query_input, dict)
                else str(query_input)
            )

        # --- Topic-change reset (runs BEFORE every short-circuit) -----------
        # If the new user message is semantically far from the cached history
        # embedding, wipe the multi-turn cache so this turn is treated as a
        # fresh conversation: the sticky-cloud check below sees no prior
        # request, the token-cap delta path resets, and the caller can trim
        # history from the outbound LLM request via topic_reset=True.
        topic_reset = False
        if messages is not None:
            topic_reset_cos = self._detect_topic_change(last_user)
            if topic_reset_cos is not None:
                logger.info(
                    "[LatentFactorRouter] topic change detected "
                    "(cos=%.3f < %.3f); resetting multi-turn state",
                    topic_reset_cos, self._topic_change_threshold,
                )
                self._reset_multiturn_state()
                topic_reset = True

        def _finalize(route: str, reason: Optional[str] = None) -> Dict[str, Any]:
            self._update_multiturn_cache(last_user, route)
            result: Dict[str, Any] = {
                "query": last_user,
                "predicted_llm": route,
                "predicted_llm_name": route,
                "selected_models": [route],
                "balance_scores": [],
            }
            if reason:
                result["short_circuit"] = reason
            if topic_reset:
                result["topic_reset"] = True
            return result

        # --- perf_weight extremes: hard route, skip embedding + algorithm ---
        # At the extremes the algorithm's outcome is predetermined, so bypass
        # scoring entirely. Exact float compare is intentional.
        if self._perf_weight >= 1.0:
            logger.info("[LatentFactorRouter] short-circuit -> cloud (perf_weight=1.0)")
            return _finalize(self._CLOUD_ROUTE, "perf_weight=1.0")
        if self._perf_weight <= 0.0:
            logger.info("[LatentFactorRouter] short-circuit -> local (perf_weight=0.0)")
            return _finalize(self._LOCAL_ROUTE, "perf_weight=0.0")

        # --- Serving/host short-circuits MOVED TO THE SIDECAR ---------------
        # The former checks here — (a) repeat-of-cloud sticky, (b) low system
        # memory, (c) over-token-cap, (d) over-turn-cap — were deployment/host/
        # serving policies, not ML routing decisions. They now live in
        # sidecar.py (enforced before/around this call), so:
        #   * the router is a PURE SCORING FUNCTION: embed -> predict P/C ->
        #     pick the best label (plus the ML-coupled topic-change reset and
        #     perf_weight extremes above);
        #   * offline eval / route-only (which call route_single directly, with
        #     no sidecar) score model quality on the raw query with NO host or
        #     serving gating — the correct behavior for a reproducible bench.
        # The sidecar owns: cloud-sticky (session-level, supersedes the old
        # exact-message (a)), low-memory (b), unified token cap (c, using the
        # real tokenizer + upstream cap), and over-turn-cap (d, per-session).

        # --- Normal routing path --------------------------------------------
        if self.embedder is None:
            self._ensure_embedder_for_inference()

        # Embed the user messages + tool-call turns so far, system prompt
        # stripped. Legacy {"query": str} callers embed the query as-is.
        routing_text = (
            self._messages_to_routing_text(messages)
            if messages is not None
            else last_user
        )

        # Embed once so we can both (a) score the request and (b) cache the
        # L2-normalized routing-text vector for the next turn's topic-change
        # check. Reused via ``precomputed_embedding`` on ``_route_query`` —
        # no double embedding.
        E = self._embed([routing_text])
        models = self._route_query(routing_text, precomputed_embedding=E)
        chosen = models[0][0] if models else None

        # Cache the routing-text embedding for topic-change detection on the
        # NEXT turn. Only after a successful algorithm route: short-circuit
        # paths never reach here and preserve whatever was previously cached.
        if messages is not None and E is not None and len(E) > 0:
            hist_vec = np.asarray(E[0], dtype=np.float32)
            norm = float(np.linalg.norm(hist_vec)) + 1e-12
            self.last_history_embedding = hist_vec / norm

        if chosen is not None:
            self._update_multiturn_cache(last_user, chosen)

        selected_models = [m[0] for m in models] if models else []
        balance_scores = [m[1] for m in models] if models else []

        result: Dict[str, Any] = {
            "query": last_user,
            "predicted_llm": chosen,
            "predicted_llm_name": chosen,
            "selected_models": selected_models,
            "balance_scores": balance_scores,
        }
        if topic_reset:
            result["topic_reset"] = True
        return result

    def route_batch(self, batch: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Route a batch of queries."""
        self._require_trained()
        if self.embedder is None:
            self._ensure_embedder_for_inference()
        queries = [
            item["query"] if isinstance(item, dict) else str(item)
            for item in batch
        ]
        results = []
        for q in queries:
            models = self._route_query(q)
            results.append({
                "query": q,
                "predicted_llm": models[0][0] if models else None,
                "predicted_llm_name": models[0][0] if models else None,
                "selected_models": [m[0] for m in models] if models else [],
                "balance_scores": [m[1] for m in models] if models else [],
            })
        return results

    @staticmethod
    def _observed_score(records: Dict[str, Any], model: Optional[str]) -> Optional[float]:
        """Return the chosen model's score if observed, else None.

        Records may carry NaN values for (model, query) pairs that were never
        evaluated (partial coverage). NaN must NOT be summed into the accuracy
        numerator — a single NaN poisons the whole metric — and the row must be
        excluded from the scored denominator. A truly missing key returns None
        too, with the same handling.
        """
        if not model or model not in records:
            return None
        v = records[model]
        try:
            fv = float(v)
        except (TypeError, ValueError):
            return None
        return None if np.isnan(fv) else fv

    def compute_metrics(self, outputs: List[Dict], batch: List[Dict]) -> dict:
        """Compute routing accuracy and average cost.

        Accuracy is computed over rows where the chosen model's score is
        *observed*; rows whose chosen-model score is NaN/missing are excluded
        from both numerator and denominator (and reported as ``n_unscored``).
        """
        correct = 0.0
        total_cost = 0.0
        n = len(batch)
        n_scored = 0
        n_unscored = 0
        llm_request_counts: Dict[str, int] = {}
        for out, item in zip(outputs, batch):
            records = item.get("records", {})
            usages = item.get("usages", {})
            chosen = out.get("predicted_llm")
            score = self._observed_score(records, chosen)
            if score is None:
                n_unscored += 1
            else:
                correct += score
                n_scored += 1
            if chosen and isinstance(usages.get(chosen), dict):
                total_cost += float(usages[chosen].get("cost", 0.0))
            if chosen:
                llm_request_counts[chosen] = llm_request_counts.get(chosen, 0) + 1
        return {
            "accuracy": correct / n_scored if n_scored > 0 else 0.0,
            "avg_cost": total_cost / n if n > 0 else 0.0,
            "total": n,
            "n_scored": n_scored,
            "n_unscored": n_unscored,
            "llm_request_counts": llm_request_counts,
        }

    def compute_metrics_from_chosen(
        self,
        chosen_models: np.ndarray,
        batch: List[Dict],
    ) -> dict:
        """
        Compute routing accuracy and average cost from chosen model indices.

        Parameters
        ----------
        chosen_models : np.ndarray, shape (n_queries,)
            Selected model index per query.
        batch : list[dict]
            Test data items with 'records' (ground truth) and 'usages' (costs).

        Returns
        -------
        dict
            accuracy, avg_cost, total, llm_request_counts
        """
        correct = 0.0
        total_cost = 0.0
        n = len(batch)
        n_scored = 0
        n_unscored = 0
        llm_request_counts: Dict[str, int] = {}
        for i, item in enumerate(batch):
            records = item.get("records", {})
            usages = item.get("usages", {})
            chosen_idx = int(chosen_models[i])
            if 0 <= chosen_idx < len(self._available_models):
                chosen = self._available_models[chosen_idx]
            else:
                chosen = None
            if chosen:
                score = self._observed_score(records, chosen)
                if score is None:
                    n_unscored += 1
                else:
                    correct += score
                    n_scored += 1
                if isinstance(usages.get(chosen), dict):
                    total_cost += float(usages[chosen].get("cost", 0.0))
                llm_request_counts[chosen] = llm_request_counts.get(chosen, 0) + 1
        return {
            "accuracy": correct / n_scored if n_scored > 0 else 0.0,
            "avg_cost": total_cost / n if n > 0 else 0.0,
            "total": n,
            "n_scored": n_scored,
            "n_unscored": n_unscored,
            "llm_request_counts": llm_request_counts,
        }

    def predict_for_queries(
        self, queries: List[str]
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Predict performance and cost for queries.

        Parameters
        ----------
        queries : list of str

        Returns
        -------
        tuple of (P_pred, C_pred)
            P_pred : np.ndarray, shape (n_queries, n_llms)
            C_pred : np.ndarray, shape (n_queries, n_llms)
        """
        self._require_trained()
        if self.embedder is None:
            self._ensure_embedder_for_inference()
        E = self._embed(queries)
        return self._latent_model.predict(E)

    def recommend_for_queries(
        self, queries: List[str]
    ) -> List[Tuple[int, float]]:
        """
        Get recommendations for queries.

        Uses the router's own per-row min-max scoring (``_score_models``) with
        configured-model gating applied, so it matches the behavior of
        ``_route_query``: clients (e.g. the opencode sidecar) and direct
        inference paths agree on the chosen model.

        Returns
        -------
        list of (llm_id, balance_score) tuples
        """
        self._require_trained()
        if self.embedder is None:
            self._ensure_embedder_for_inference()
        E = self._embed(queries)
        P_pred, C_pred = self._latent_model.predict(E)
        excluded_mask = self._build_excluded_mask(P_pred, C_pred)
        balance = self._score_models(
            P_pred,
            C_pred,
            self._perf_weight,
            self._cost_weight,
            excluded_mask=excluded_mask,
        )
        out: List[Tuple[int, float]] = []
        for row in balance:
            idx = int(np.argmax(row))
            out.append((idx, float(row[idx])))
        return out

    def _classify_intent(self, query: str) -> str:
        return (
            self.intent_clf.classify(query)
            if self.intent_clf
            else "general"
        )

    def _classify_intents(self, queries: List[str]) -> List[str]:
        return (
            self.intent_clf.classify_batch(queries)
            if self.intent_clf
            else ["general"] * len(queries)
        )

    def _embed(self, queries: List[str]) -> np.ndarray:
        return np.array(self.embedder.batch(queries), dtype=np.float32)

    def _score_models(
        self,
        P_pred: np.ndarray,
        C_pred: np.ndarray,
        perf_weight: float,
        cost_weight: float,
        excluded_mask: Optional[np.ndarray] = None,
    ) -> np.ndarray:
        """
        Score all models for all queries using pre-computed P/C predictions.

        Balance score = perf_weight * norm_perf - cost_weight * norm_cost

        Parameters
        ----------
        P_pred : np.ndarray, shape (n_queries, n_models)
        C_pred : np.ndarray, shape (n_queries, n_models)
        perf_weight : float
        cost_weight : float
        excluded_mask : Optional[np.ndarray], shape (n_models,)
            Boolean per-model mask. Models marked ``True`` are dropped from
            the candidate set *before* normalization: their predictions do
            not contribute to the per-row maxima used to normalize perf/cost,
            and their final balance score is forced to ``-inf``. This keeps
            the normalization denominators (``p_max``/``c_max``) reflecting
            only the models that can actually be selected. ``None`` (default)
            scores the full set so training/eval scoring stays
            configuration-agnostic.

        Returns
        -------
        np.ndarray, shape (n_queries, n_models)
            balance scores per query per model
        """
        # Apply per-label capability scaling BEFORE normalization. WHY before:
        # if the user runs a 1B mapped onto the trained 4B label, the 4B
        # column's predicted P is too optimistic — discount it now so it
        # competes fairly against cloud during the per-row max+score. Done on
        # a copy so we never mutate the caller's P_pred (training/eval paths
        # share P_pred across many score calls). ``getattr`` with default so
        # test fixtures that construct routers via ``object.__new__`` (skipping
        # __init__) continue to work — they just see no scaling, which is the
        # correct training/eval behavior.
        capability_scales = getattr(self, "_capability_scales", None) or {}
        if capability_scales:
            P_pred = P_pred.copy()
            for label, scale in capability_scales.items():
                try:
                    idx = self._available_models.index(label)
                except ValueError:
                    continue  # label not in current pool — silently ignore
                P_pred[:, idx] *= scale

        has_exclusion = (
            excluded_mask is not None
            and bool(np.any(excluded_mask))
            and not bool(np.all(excluded_mask))
        )
        if has_exclusion:
            included = ~excluded_mask
            p_max = P_pred[:, included].max(axis=1, keepdims=True) + 1e-12
            c_max = C_pred[:, included].max(axis=1, keepdims=True) + 1e-12
        else:
            p_max = P_pred.max(axis=1, keepdims=True) + 1e-12
            c_max = C_pred.max(axis=1, keepdims=True) + 1e-12

        p_norm = P_pred / p_max
        c_norm = C_pred / c_max

        balance = perf_weight * p_norm - cost_weight * c_norm

        if self.budget_limit is not None:
            balance = np.where(C_pred > self.budget_limit, -np.inf, balance)

        for j in range(balance.shape[1]):
            if self.min_acc_thresh > 0:
                p_col_norm = P_pred[:, j] / p_max[:, 0]
                balance[:, j] = np.where(p_col_norm < self.min_acc_thresh, -np.inf, balance[:, j])

        if has_exclusion:
            balance[:, excluded_mask] = -np.inf

        return balance

    def _route_query(
        self,
        query: str,
        precomputed_embedding: Optional[np.ndarray] = None,
    ) -> List[Tuple[str, float]]:
        """
        Route query using the latent factor model.

        Balance score = perf_weight * norm_perf - cost_weight * norm_cost

        Applies configured-model gating via ``_build_excluded_mask`` so the
        non-running local labels and ``_EXCLUDED_CLOUD_MODELS`` cannot win.

        ``precomputed_embedding`` lets ``route_single`` reuse the vector it
        already needs to cache as ``last_history_embedding``, avoiding a
        second embed call on the same routing text.
        """
        if precomputed_embedding is not None:
            E = precomputed_embedding
        else:
            E = self._embed([query])
        P_pred, C_pred = self._latent_model.predict(E)

        excluded_mask = self._build_excluded_mask(P_pred, C_pred)
        balance = self._score_models(
            P_pred,
            C_pred,
            self._perf_weight,
            self._cost_weight,
            excluded_mask=excluded_mask,
        )[0]

        n_return = min(self.top_k, len(balance))
        top_indices = np.argsort(balance)[::-1][:n_return]

        results = []
        for idx in top_indices:
            score = float(balance[idx])
            if score != -np.inf:
                results.append((self._available_models[idx], score))
        return results

    # ── Configured-model gating ──────────────────────────────────────────────
    @staticmethod
    def _configured_local_model() -> str:
        """Return the local-model alias the host is configured to serve.

        Reads ``LOCAL_LLM_MODEL`` and falls back to the first comma-separated
        entry of ``LOCAL_LLM_MODELS``. Returns ``""`` when neither is set, in
        which case configured gating is skipped (the router scores over the
        full local set rather than guessing).
        """
        configured = (os.environ.get("LOCAL_LLM_MODEL") or "").strip()
        if not configured:
            models_env = (os.environ.get("LOCAL_LLM_MODELS") or "").strip()
            if models_env:
                configured = models_env.split(",")[0].strip()
        return configured

    def _match_local_alias(self, configured: str) -> Optional[str]:
        """Return the trained local label that corresponds to *configured*.

        Matching tolerates aliases that differ in suffix/case from the trained
        label — e.g. the artefact has ``qwen3.6-35b`` but the backend was
        started with ``Qwen3.6-35B-A3B`` (a quantisation variant).

        Resolution order:
          1. Exact case-insensitive match against an available local label.
          2. Prefix match in either direction (case-insensitive), picking the
             LONGEST candidate so the most specific label wins. Both
             directions matter because the configured alias may be either
             more specific (``qwen3.6-35b-a3b``) or less specific (``qwen3``)
             than the trained label.

        Returns ``None`` when nothing matches — the caller then skips local
        exclusions so the router scores over the full local set rather than
        masking everything out.
        """
        if not configured:
            return None
        cfg = configured.casefold()

        local_cf = {m.casefold() for m in getattr(self, "_LOCAL_MODELS", ())}
        local_candidates = [
            m for m in self._available_models if m.casefold() in local_cf
        ]

        for m in local_candidates:
            if m.casefold() == cfg:
                return m

        prefix_matches = [
            m for m in local_candidates
            if cfg.startswith(m.casefold()) or m.casefold().startswith(cfg)
        ]
        if prefix_matches:
            return max(prefix_matches, key=lambda m: len(m))

        return None

    def _configured_excluded_models(self) -> List[str]:
        """Labels to drop from routing for this host's configuration.

        Drops every local label EXCEPT the one matching the configured alias
        plus every cloud label in :attr:`_EXCLUDED_CLOUD_MODELS`. Only labels
        actually in :attr:`_available_models` are returned, so the rule is a
        no-op for labels the trained artefact doesn't include.

        If the configured alias doesn't resolve to any trained local label,
        local exclusions are skipped — we'd rather score the full local set
        than mask everything out. Cloud exclusions still apply.
        """
        excluded: List[str] = []

        # ``getattr`` defaults keep test fixtures (object.__new__ bypasses
        # __init__) happy — they just see no gating, which is the correct
        # training/eval behavior.
        local_models = getattr(self, "_LOCAL_MODELS", ())
        excluded_clouds = getattr(self, "_EXCLUDED_CLOUD_MODELS", ())

        configured = self._configured_local_model()
        matched_local = self._match_local_alias(configured)
        local_cf = {m.casefold() for m in local_models}

        if matched_local is not None:
            for m in self._available_models:
                if m.casefold() in local_cf and m != matched_local:
                    excluded.append(m)
        elif configured:
            logger.info(
                "[LatentFactorRouter] configured local model {!r} did not match "
                "any trained label in {} — local exclusions skipped",
                configured, self._available_models,
            )

        excluded_cloud_cf = {m.casefold() for m in excluded_clouds}
        for m in self._available_models:
            if m.casefold() in excluded_cloud_cf:
                excluded.append(m)

        return excluded

    # ── Operator-deployment mapping (called by the sidecar) ─────────────
    def resolve_user_local(
        self,
        name: str,
        size_b: float,
        family: str = "qwen",
    ) -> Dict[str, Any]:
        """Map a user-declared local model to a trained pool label.

        SIZE-BASED, FAMILY-AGNOSTIC mapping. Model *size* is the dominant
        capability proxy the router was trained on, so we ALWAYS map to the
        size-nearest trained label and keep the request local — never force
        cloud purely on family or on being above/below the pool. Forcing cloud
        throws away the local-token cost benefit, which is the whole point of a
        local deployment; a size-matched local run (even cross-family) is a far
        better default than routing everything to cloud.

        Resolution policy:
          * Pick the size-nearest trained label (ties broken UP — favor the
            larger label; an under-route is cheaper to be wrong about than an
            over-route to a model the host can't serve).
          * ``size_b < min(trained)``  → map to the smallest label + a
            capability DISCOUNT ``(size_b/mapped)^alpha`` in (0,1], so the
            router doesn't over-credit a tiny model (pushes its easy-but-risky
            queries to cloud).
          * ``size_b > max(trained)``  → map to the LARGEST label. No discount
            (a bigger model is at least as capable as the label); we clamp the
            scale to 1.0 rather than boosting, since the artefact can't predict
            beyond its panel. Still local — we do NOT force cloud.
          * ``family != "qwen"``       → still mapped by size, but a mild
            cross-family discount (``cross_family_scale``, default 0.9) is
            applied on top, acknowledging size-only capability transfer across
            families is lossier than within Qwen. Tunable; set to 1.0 to treat
            all families identically.

        ``force_cloud`` is retained in the return shape for API compatibility
        but is now ALWAYS False (kept so callers/tests that read the key don't
        break). Genuine "route everything to cloud" is an operator choice via
        perf_weight>=1.0 or an explicit config, not an automatic family/size veto.

        Returns a dict:
          {
            "mapped_label":      "<trained label>",
            "capability_scale":  float | None,   # combined size+family discount
            "force_cloud":       False,          # always; see above
            "reason":            "<short tag>",
          }
        """
        if not self._local_meta:
            raise RuntimeError(
                "pool metadata not loaded — cannot resolve user-local model"
            )

        sizes = {label: meta["size_b"] for label, meta in self._local_meta.items()}
        max_size = max(sizes.values())
        min_size = min(sizes.values())
        fam = (family or "").casefold()

        # Size-nearest, ties broken UP (favor the larger trained label).
        ranked = sorted(
            sizes.items(),
            key=lambda kv: (abs(kv[1] - size_b), -kv[1]),
        )
        mapped_label, mapped_size = ranked[0]

        # ── size-based capability scale ──────────────────────────────────
        scale = 1.0
        size_tag = f"size-nearest({size_b}B→{mapped_label}@{mapped_size}B)"
        if size_b < min_size:
            ratio = max(size_b / mapped_size, 1e-6)
            scale = min(1.0, ratio ** self._capability_alpha)
            size_tag = f"below-pool({size_b}B<{min_size}B)→{mapped_label} scale={scale:.3f}"
        elif size_b > max_size:
            # Above the panel: map to the largest label, no boost (clamp 1.0).
            scale = 1.0
            size_tag = f"above-pool({size_b}B>{max_size}B)→{mapped_label}(clamped)"

        # ── cross-family discount (multiplicative, on top of size) ───────
        cross = ""
        if fam and fam != "qwen":
            scale *= float(self._cross_family_scale)
            cross = f" x-family({family})*{self._cross_family_scale:.2f}"

        capability_scale: Optional[float] = None if scale >= 1.0 else round(scale, 4)
        reason = size_tag + cross

        logger.info(
            "[LatentFactorRouter] resolve_user_local: {!r} ({:.1f}B, family={}) "
            "→ {!r}  scale={}  ({})",
            name, size_b, family, mapped_label, capability_scale, reason,
        )
        return {
            "mapped_label": mapped_label,
            "capability_scale": capability_scale,
            "force_cloud": False,
            "reason": reason,
        }

    def set_capability_scale(self, label: str, scale: Optional[float]) -> None:
        """Install (or clear) a per-label capability discount.

        ``scale`` is multiplied into ``P_pred[:, label_idx]`` inside
        ``_score_models`` BEFORE normalization, so the discount feeds into the
        same balance-score math that already exists. Setting ``scale=None``
        or ``scale=1.0`` clears the entry (no discount).
        """
        if scale is None or scale >= 1.0:
            self._capability_scales.pop(label, None)
            return
        if scale <= 0.0:
            raise ValueError(f"capability scale must be in (0, 1], got {scale}")
        self._capability_scales[label] = float(scale)

    def _build_excluded_mask(
        self,
        P_pred: np.ndarray,
        C_pred: np.ndarray,
    ) -> Optional[np.ndarray]:
        """Build the per-model exclusion mask for the inference path.

        Returns ``None`` when there's nothing to exclude. Returns ``None``
        (instead of the mask) when honoring the exclusion would leave no
        viable candidate — we prefer routing over the full set to returning
        nothing. The guard runs an unmasked scoring pass and checks that at
        least one surviving column has a finite score.
        """
        excluded = self._configured_excluded_models()
        if not excluded:
            return None

        mask = np.array(
            [m in excluded for m in self._available_models], dtype=bool
        )

        unmasked = self._score_models(
            P_pred, C_pred, self._perf_weight, self._cost_weight
        )[0]
        if not np.all(np.isneginf(unmasked[~mask])):
            return mask

        logger.info(
            "[LatentFactorRouter] configured exclusion {} skipped: "
            "would mask all viable models", excluded,
        )
        return None

    def _require_trained(self) -> None:
        if not self._is_trained:
            raise RuntimeError(
                "[LatentFactorRouter] Not trained. "
                "Run LatentFactorTrainer.train() first."
            )

    def _resolve_path(self, rel_or_abs: str) -> str:
        if not rel_or_abs:
            return ""
        if os.path.isabs(rel_or_abs):
            return rel_or_abs
        # Project root is the directory containing the ``routing_service``
        # package. From this file's location:
        #   __file__  = routing_service/routing_service/router/router.py
        #   parents[2] = routing_service/                       (project)
        # Relative paths in YAML are resolved against the project root, so
        # ``artefacts/latent_factor_artefacts.pkl`` and
        # ``config/<x>`` both work.
        project_root = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "..")
        )
        return os.path.join(project_root, rel_or_abs)

    def evaluate(self, test_data: List[Dict]) -> Dict[str, Any]:
        """
        Comprehensive evaluation on test_data.
        """
        self._require_trained()
        self._ensure_embedder_for_training()
        queries = [d["query"] for d in test_data]
        outputs = [self.route_single({"query": q}) for q in queries]

        metrics = self.compute_metrics(outputs, test_data)

        baselines = self.compute_baselines(test_data)
        metrics["baselines"] = baselines

        router_acc = metrics["accuracy"]
        router_cost = metrics["avg_cost"]

        oracle_acc = baselines.get("oracle", {}).get("accuracy", 1.0)
        best_acc = baselines.get("best_single", {}).get("accuracy", 0.0)
        best_cost = baselines.get("best_single", {}).get("avg_cost", 0.0)
        random_acc = baselines.get("random", {}).get("accuracy", 0.0)

        metrics["oracle_gap"] = float(oracle_acc - router_acc)
        metrics["oracle_efficiency"] = (
            float(router_acc / oracle_acc) if oracle_acc > 0 else 0.0
        )
        metrics["vs_best_single"] = float(router_acc - best_acc)
        metrics["vs_random"] = float(router_acc - random_acc)
        metrics["cost_savings_vs_best"] = (
            float((best_cost - router_cost) / best_cost) if best_cost > 0 else 0.0
        )
        metrics["quality_cost_score"] = float(
            self._perf_weight * router_acc - self._cost_weight * router_cost
        )

        # Pareto analysis: include router as a candidate alongside base models
        pareto_candidates = dict(baselines.get("per_model", {}))
        pareto_candidates["LatentFactorRouter"] = {
            "accuracy": router_acc,
            "avg_cost": router_cost,
        }
        metrics["pareto_optimal_all"] = find_pareto_optimal_models(pareto_candidates)
        metrics["pareto_optimal_base"] = baselines.get("pareto_optimal", [])

        return metrics

    def verbose_eval(self, test_data: Optional[List[Dict]] = None) -> Dict[str, Any]:
        """
        Per-query evaluation comparing predicted vs ground truth performance and cost.

        Prints detailed per-query results and final statistics.

        Parameters
        ----------
        test_data : list of dict, optional
            Test data to evaluate on. If None, uses self._test_data.

        Returns
        -------
        dict
            Statistics including MAE, RMSE, MSE for performance and cost predictions.
        """
        self._require_trained()
        self._ensure_embedder_for_training()

        if test_data is None:
            test_data = self._test_data

        if not test_data:
            logger.warning("[LatentFactorRouter] No test data available for verbose_eval.")
            return {}

        queries = [d["query"] for d in test_data]
        model_names = self._available_models

        P_pred, C_pred = self.predict_for_queries(queries)

        perf_errors = []
        cost_errors = []
        perf_sq_errors = []
        cost_sq_errors = []

        logger.info("\n" + "=" * 80)
        logger.info("  VERBOSE EVALUATION — Per-Query Predicted vs Ground Truth")
        logger.info("=" * 80)

        for i, (item, p_pred, c_pred) in enumerate(zip(test_data, P_pred, C_pred)):
            query = item["query"]
            records = item.get("records", {})
            usages = item.get("usages", {})

            query_disp = query[:80] + "..." if len(query) > 80 else query

            #logger.info(f"\n[Query {i+1}/{len(test_data)}] {query_disp}")
            logger.info(f"{'Model':<35} {'Pred Perf':>12} {'GT Perf':>12} {'Pred Cost':>12} {'GT Cost':>12}")
            logger.info(f"{'-'*35} {'-'*12} {'-'*12} {'-'*12} {'-'*12}")

            for j, model in enumerate(model_names):
                gt_perf = records.get(model, np.nan)
                gt_cost = None
                if model in usages and isinstance(usages[model], dict):
                    gt_cost = usages[model].get("cost")

                pred_perf = float(p_pred[j])
                pred_cost = float(c_pred[j])
                pred_perf = 1.0 if pred_perf > 0.5 else (0.5 if pred_perf == 0.5 else 0.0)

                perf_err = None
                cost_err = None
                if not np.isnan(gt_perf):
                    perf_err = pred_perf - gt_perf
                    perf_errors.append(perf_err)
                    perf_sq_errors.append(perf_err ** 2)

                if gt_cost is not None:
                    cost_err = pred_cost - gt_cost
                    cost_errors.append(cost_err)
                    cost_sq_errors.append(cost_err ** 2)

                gt_perf_str = f"{gt_perf:.4f}" if not np.isnan(gt_perf) else "N/A"
                gt_cost_str = f"{gt_cost:.6f}" if gt_cost is not None else "N/A"

                logger.info(
                    f"{model:<35} {pred_perf:>12.4f} {gt_perf_str:>12} "
                    f"{pred_cost:>12.6f} {gt_cost_str:>12}"
                )

        n_perf = len(perf_errors)
        n_cost = len(cost_errors)

        logger.info("\n" + "=" * 80)
        logger.info("  VERBOSE EVALUATION — Final Statistics")
        logger.info("=" * 80)

        stats = {}

        if n_perf > 0:
            perf_mae = float(np.mean(np.abs(perf_errors)))
            perf_rmse = float(np.sqrt(np.mean(perf_sq_errors)))
            perf_mse = float(np.mean(perf_sq_errors))
            logger.info(f"\n  Performance Prediction (n={n_perf}):")
            logger.info(f"    MAE  : {perf_mae:.4f}")
            logger.info(f"    RMSE : {perf_rmse:.4f}")
            logger.info(f"    MSE  : {perf_mse:.4f}")

            stats["performance_mae"] = perf_mae
            stats["performance_rmse"] = perf_rmse
            stats["performance_mse"] = perf_mse
        else:
            logger.info("\n  Performance Prediction: No valid ground truth found.")

        if n_cost > 0:
            cost_mae = float(np.mean(np.abs(cost_errors)))
            cost_rmse = float(np.sqrt(np.mean(cost_sq_errors)))
            cost_mse = float(np.mean(cost_sq_errors))
            logger.info(f"\n  Cost Prediction (n={n_cost}):")
            logger.info(f"    MAE  : {cost_mae:.6f}")
            logger.info(f"    RMSE : {cost_rmse:.6f}")
            logger.info(f"    MSE  : {cost_mse:.8f}")
            stats["cost_mae"] = cost_mae
            stats["cost_rmse"] = cost_rmse
            stats["cost_mse"] = cost_mse
        else:
            logger.info("\n  Cost Prediction: No valid ground truth found.")

        if n_perf > 0 and n_cost > 0:
            combined_mae = (perf_mae + cost_mae) / 2
            logger.info(f"\n  Combined MAE (perf + cost): {combined_mae:.4f}")
            stats["combined_mae"] = combined_mae

        logger.info("\n" + "=" * 80)

        return stats

    def compute_baselines(self, data: List[Dict]) -> Dict[str, Any]:
        return _compute_baselines_common(data, self._available_models, "LatentFactorRouter")

    def save_artefacts(self, path: str) -> None:
        """Persist latent model and data splits."""
        bundle = {
            "latent_model": self._latent_model,
            "available_models": self._available_models,
            "E_matrix": self._E_matrix,
            "P_matrix": self._P_matrix,
            "C_matrix": self._C_matrix,
            "probe_indices": self._probe_indices,
            "probe_embeddings": self._probe_embeddings,
            "perf_weight": self._perf_weight,
            "cost_weight": self._cost_weight,
            "latent_dim": self.latent_dim,
            "alpha": self.alpha,
            "n_folds": self.n_folds,
            # Forensic stamps (NOT a load-time gate; see evaluation_spec.md §7.1a).
            # Inference behaves identically regardless of these values; they exist
            # so deployment logs make "which trained model is running" auditable.
            "weight_scheme": getattr(self, "weight_scheme", "uniform"),
            "weight_scheme_params": dict(getattr(self, "weight_scheme_params", {}) or {}),
        }
        save_model(bundle, path)
        logger.info(f"[LatentFactorRouter] Artefacts saved -> {path}")

        data_path = path.replace(".pkl", "_data.pkl").replace(".pt", "_data.pkl")
        data_bundle = {
            "train_data": self._train_data,
            "val_data": self._val_data,
            "test_data": self._test_data,
        }
        save_model(data_bundle, data_path)
        logger.info(f"[LatentFactorRouter] Data splits saved -> {data_path}")

    def load_artefacts(self, path: str) -> None:
        """Restore artefacts."""
        # Pickle references the old module path 'latentfactorrouter'; make it resolvable.
        _custom_routers_dir = str(Path(__file__).resolve().parent.parent)
        _added = _custom_routers_dir not in sys.path
        if _added:
            sys.path.insert(0, _custom_routers_dir)
        try:
            bundle = load_model(path)
        finally:
            if _added:
                sys.path.remove(_custom_routers_dir)
        self._latent_model = bundle["latent_model"]
        self._available_models = bundle["available_models"]
        self._E_matrix = bundle.get("E_matrix")
        self._P_matrix = bundle.get("P_matrix")
        self._C_matrix = bundle.get("C_matrix")
        self._probe_indices = bundle.get("probe_indices")
        self._probe_embeddings = bundle.get("probe_embeddings")
        # perf_weight / cost_weight precedence: YAML > artefact > default.
        # The pickle stamps whatever was used at training time, but operators
        # can re-tune these at inference (e.g. drop perf_weight from 0.9 →
        # 0.7 to shift more traffic to cheaper locals). If the YAML
        # explicitly set ``metric.weights.performance``, keep that — the
        # artefact's stamped value would otherwise silently overwrite a
        # deliberate inference-time edit. Older artefacts predate this flag
        # (no ``_perf_weight_from_yaml`` attribute) — they fall back to the
        # artefact's stamped value, matching pre-existing behavior.
        if not getattr(self, "_perf_weight_from_yaml", False):
            self._perf_weight = bundle.get("perf_weight", 0.7)
            self._cost_weight = bundle.get("cost_weight", 0.3)
        else:
            stamped = bundle.get("perf_weight")
            if stamped is not None and abs(stamped - self._perf_weight) > 1e-9:
                logger.info(
                    "[LatentFactorRouter] artefact perf_weight={} overridden "
                    "by YAML perf_weight={} (inference-time scoring only — "
                    "no retraining needed)",
                    stamped, self._perf_weight,
                )
        self.latent_dim = bundle.get("latent_dim", 32)
        self.alpha = bundle.get("alpha", 1.0)
        self.n_folds = bundle.get("n_folds", 5)
        # Defensive defaults: older artefacts saved before the weight-scheme
        # stamp was added still load cleanly and report "uniform" (spec §7.1a).
        self.weight_scheme = bundle.get("weight_scheme", "uniform")
        self.weight_scheme_params = dict(bundle.get("weight_scheme_params", {}) or {})
        logger.info(
            "[LatentFactorRouter] Loaded artefact: weight_scheme={} params={}",
            self.weight_scheme, self.weight_scheme_params,
        )
        self._is_trained = True
        logger.info(
            f"[LatentFactorRouter] Artefacts loaded from {path} "
            f"(models: {len(self._available_models)})"
        )

        data_path = path.replace(".pkl", "_data.pkl").replace(".pt", "_data.pkl")
        if os.path.exists(data_path):
            data_bundle = load_model(data_path)
            self._train_data = data_bundle.get("train_data", [])
            self._val_data = data_bundle.get("val_data", [])
            self._test_data = data_bundle.get("test_data", [])
            logger.info(
                f"[LatentFactorRouter] Data splits loaded from {data_path} "
                f"(train: {len(self._train_data)}, val: {len(self._val_data)}, test: {len(self._test_data)})"
            )
        else:
            self._train_data = []
            self._val_data = []
            self._test_data = []
            logger.warning(
                f"[LatentFactorRouter] Data splits file not found: {data_path}"
            )
