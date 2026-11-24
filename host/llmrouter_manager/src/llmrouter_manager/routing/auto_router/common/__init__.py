"""
Common utilities shared across all custom routers.
"""

from .data_utils import (
    normalise_rows,
    pivot_long_rows,
    normalise_wide_rows,
    pivot_df,
    load_all_routing_data,
)
from .baselines import compute_baselines, find_pareto_optimal_models
from .splitting import split_stratified_two_way, split_stratified_three_way
from .embedding_cache import EmbeddingCache
from .intent_cache import IntentCache
from .intent_classifier import IntentClassifier, DEFAULT_INTENT_CLASSES
from .probe_selector import (
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
    "normalise_rows",
    "pivot_long_rows",
    "normalise_wide_rows",
    "pivot_df",
    "load_all_routing_data",
    "compute_baselines",
    "find_pareto_optimal_models",
    "split_stratified_two_way",
    "split_stratified_three_way",
    "EmbeddingCache",
    "IntentCache",
    "IntentClassifier",
    "DEFAULT_INTENT_CLASSES",
    "ProbeSelector",
    "get_selected_queries",
    "select_probe_set_d_optimal",
    "select_probe_set_kmeans",
    "select_optimal_k_for_probes",
    "find_optimal_k_silhouette",
    "find_optimal_k_elbow",
    "find_optimal_k_gap_statistic",
    "find_optimal_k_combined",
]
