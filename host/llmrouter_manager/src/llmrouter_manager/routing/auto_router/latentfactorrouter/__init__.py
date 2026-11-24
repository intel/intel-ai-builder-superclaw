"""
LatentFactorRouter Plugin
=========================

Ridge-regression-based LLM router using latent factor models.

Usage
-----
>>> from latentfactorrouter import LatentFactorRouter, LatentFactorTrainer
>>> router  = LatentFactorRouter("latentfactorrouter/config_latent_factor.yaml")
>>> trainer = LatentFactorTrainer(router)
>>> results = trainer.train()

Adding New LLM with Probe Set
-----------------------------
>>> from latentfactorrouter import LatentFactorRouter, LatentFactorUpdater
>>> router  = LatentFactorRouter("config_latent_factor.yaml")
>>> # ... after training ...
>>> updater = LatentFactorUpdater(router)
>>> probe_results = [
...     {"query": "How to sort a list?", "performance": 0.95, "cost": 0.002},
...     {"query": "Write a Fibonacci function", "performance": 0.88, "cost": 0.001},
... ]
>>> summary = updater.add_model("gpt-5", probe_results)
"""

from .router import LatentFactorRouter, LatentFactorConfig, find_pareto_optimal_models
from .trainer import LatentFactorTrainer, plot_pareto_frontier, plot_weight_ablation_pareto
from .latent_factor_updater import LatentFactorUpdater
from ..common.embedding_cache import EmbeddingCache
from .latent_factor_model import LatentFactorModel, LatentFactorModelWithCV, ResidualBoostedLatentFactorModel
from ..common.probe_selector import (
    ProbeSelector,
    get_selected_queries,
    select_probe_set_d_optimal,
    select_probe_set_kmeans,
    select_optimal_k_for_probes,
    find_optimal_k_silhouette,
    find_optimal_k_elbow,
    find_optimal_k_gap_statistic,
    find_optimal_k_combined,
)

__all__ = [
    # Main router
    "LatentFactorRouter",
    "LatentFactorConfig",
    "LatentFactorTrainer",
    "LatentFactorUpdater",
    # Analysis
    "find_pareto_optimal_models",
    "plot_pareto_frontier",
    "plot_weight_ablation_pareto",
    # Core components
    "EmbeddingCache",
    # Latent factor model
    "LatentFactorModel",
    "LatentFactorModelWithCV",
    "ResidualBoostedLatentFactorModel",
    # Probe selector
    "ProbeSelector",
    "get_selected_queries",
    "select_probe_set_d_optimal",
    "select_probe_set_kmeans",
    "select_optimal_k_for_probes",
    "find_optimal_k_silhouette",
    "find_optimal_k_elbow",
    "find_optimal_k_gap_statistic",
    "find_optimal_k_combined",
    # Logging (deprecated stub — kept for backwards compat)
    "setup_logging",
]


def setup_logging(level: int = 20) -> None:
    """Deprecated no-op — logging is now centrally configured via loguru.

    Retained so external callers that historically imported this symbol
    from ``latentfactorrouter`` keep working. All logging in this package
    now flows through the loguru sinks installed by
    ``llmrouter_manager.common.logging.setup_logging`` (called once from
    ``__main__.py`` at process startup). The ``level`` argument is
    ignored; override the sink level via ``LRM_LOG_LEVEL`` instead.
    """
    return None

