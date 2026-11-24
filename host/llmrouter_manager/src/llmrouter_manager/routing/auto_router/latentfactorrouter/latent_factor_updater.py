"""
LatentFactorRouter — latent_factor_updater.py
=============================================
Incremental model-pool management and fine-tuning for :class:`LatentFactorRouter`.

Problem
-------
After a LatentFactorRouter is trained and released, two things change over time:

1. **New LLMs** become available and must be added to the routing pool.
2. **New labelled data** is collected (queries with observed per-model
   performance and cost) and the router should learn from it without a costly
   full retrain.

Solution
--------
The base model is closed-form ridge regression, so both updates are exact
re-solves rather than gradient steps:

* ``add_model`` / ``update_model`` learn a single new LLM's latent
  representation from probe-set evaluations:

      E_probe @ Lp_new = P_probe_new   (performance on probe set)
      E_probe @ Lc_new = C_probe_new   (cost on probe set)

* ``fine_tune`` re-solves the per-LLM ridge problem on the union of the
  original training matrices (persisted in the artefact) and the newly
  collected examples, at the frozen embedder / PCA projection and frozen
  ``(latent_dim, alpha)``. An optional Gaussian prior anchored on the released
  parameters keeps the update stable when new data is scarce — equivalent to a
  Bayesian update with the released model as the prior mean.

Because the embedding projection (and PCA) is frozen, the learned latent
factors stay in the same coordinate system as the released model. Re-selecting
``latent_dim`` / ``alpha`` / the probe set / PCA requires a full retrain; those
are deliberately *not* changed here.

Typical usage
-------------
::

    from latentfactorrouter import LatentFactorRouter, LatentFactorUpdater

    router  = LatentFactorRouter("config_latent_factor.yaml")
    trainer = LatentFactorTrainer(router)
    trainer.train()

    updater = LatentFactorUpdater(router)

    # --- add a brand-new model from probe evaluations ---
    summary = updater.add_model("gpt-5", probe_results=[...])

    # --- fine-tune existing models on freshly collected data ---
    new_examples = [
        {
            "query": "...",
            "records": {"gpt-5": 1.0, "qwen3.6-35b": 0.0},
            "usages":  {"gpt-5": {"cost": 0.16}, "qwen3.6-35b": {"cost": 0.0}},
        },
        ...
    ]
    summary = updater.fine_tune(new_examples, save_path="latent_factor_artefacts.pkl")
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

import numpy as np
from scipy import linalg

from .latent_factor_model import _log_cost

if TYPE_CHECKING:
    from .router import LatentFactorRouter
    from .latent_factor_model import LatentFactorModel

from loguru import logger


def _anchored_masked_ridge(
    E: np.ndarray,
    Y: np.ndarray,
    mask: np.ndarray,
    alpha: float,
    prior: Optional[np.ndarray] = None,
    prior_strength: float = 0.0,
) -> np.ndarray:
    """Column-wise ridge solve with NaN masking and an optional Gaussian prior.

    For each column ``j`` solves::

        (EᵀE + (α + λ) I) L_j = EᵀY_j + λ · prior_j

    using only the rows where ``mask[:, j]`` is True. ``λ = prior_strength``
    pulls the solution toward ``prior[:, j]`` (the released parameters), which
    is exactly a Gaussian prior centred on the released model. With
    ``prior_strength == 0`` this is an ordinary masked ridge re-fit, i.e. the
    exact least-squares solution on the supplied (old ∪ new) rows.

    Parameters
    ----------
    E : np.ndarray, shape (n_samples, D)
        Design matrix (bias column already appended by the caller).
    Y : np.ndarray, shape (n_samples, n_llms)
        Targets; NaN entries are treated as missing.
    mask : np.ndarray, shape (n_samples, n_llms)
        True where ``Y`` is observed.
    alpha : float
        Ridge regularization strength.
    prior : np.ndarray, optional, shape (D, n_llms)
        Released latent factors to anchor toward.
    prior_strength : float
        Weight λ of the prior. Ignored when ``prior`` is None.

    Returns
    -------
    L : np.ndarray, shape (D, n_llms)
    """
    D = E.shape[1]
    n_llms = Y.shape[1]
    L = np.zeros((D, n_llms))
    use_prior = prior is not None and prior_strength > 0.0
    base_reg = alpha * np.eye(D)

    for j in range(n_llms):
        col_mask = mask[:, j]
        has_obs = bool(col_mask.any())
        if not has_obs and not use_prior:
            L[:, j] = 0.0
            continue

        A = base_reg.copy()
        b = np.zeros(D)
        if has_obs:
            E_obs = E[col_mask]
            y_obs = Y[col_mask, j]
            A = A + E_obs.T @ E_obs
            b = b + E_obs.T @ y_obs
        if use_prior:
            A = A + prior_strength * np.eye(D)
            b = b + prior_strength * prior[:, j]

        try:
            L[:, j] = linalg.solve(A, b, assume_a="sym")
        except linalg.LinAlgError:
            L[:, j] = linalg.lstsq(A, b)[0]
    return L


class LatentFactorUpdater:
    """
    Incrementally extend a trained :class:`LatentFactorRouter` with new LLMs.

    Uses the probe set to learn new LLM latent representations via ridge regression.

    Parameters
    ----------
    router : LatentFactorRouter
        A trained router instance.
    """

    def __init__(self, router: "LatentFactorRouter") -> None:
        self.router = router

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _linear_model(self) -> "LatentFactorModel":
        """Return the underlying linear :class:`LatentFactorModel`.

        The router's ``_latent_model`` may be:
          * a bare ``LatentFactorModel`` (n_folds <= 1),
          * a ``LatentFactorModelWithCV`` whose fitted model is ``.best_model``,
          * a ``ResidualBoostedLatentFactorModel`` wrapping one of the above in
            ``.base_model``.

        All of them store the ridge factors (``Lp``/``Lc``) on the innermost
        linear model. Resolving it here lets pool/fine-tune updates work
        uniformly regardless of how the router was trained.
        """
        model = self.router._latent_model
        if model is None:
            raise RuntimeError("[LatentFactorUpdater] Router has no latent model.")
        # Unwrap residual-boost wrapper first.
        base = getattr(model, "base_model", None)
        if base is not None:
            model = base
        # Unwrap CV wrapper.
        best = getattr(model, "best_model", None)
        if best is not None:
            model = best
        if getattr(model, "Lp", None) is None:
            raise RuntimeError(
                "[LatentFactorUpdater] Underlying linear model is not fitted "
                "(Lp is None)."
            )
        return model

    def _trained_alphas(self, model: "LatentFactorModel") -> Tuple[float, float]:
        """(alpha_P, alpha_C) the released factors were fit with.

        The CV-selected values live on the linear model, not on router.alpha.
        """
        alpha_per_target = getattr(model, "alpha_per_target", None) or {}
        fallback = getattr(model, "alpha", self.router.alpha)
        return (
            float(alpha_per_target.get("P", fallback)),
            float(alpha_per_target.get("C", fallback)),
        )

    def _training_subspace(self, model: "LatentFactorModel") -> Optional[np.ndarray]:
        """Rank-d basis (d, D+1) the released factors were fit in, or None.

        The CV path solves in the top-``latent_dim`` right singular vectors of
        the training ``[E | 1]`` and back-projects, but does not persist the
        basis. Only a CV wrapper's ``best_model`` qualifies: a plain
        LatentFactorModel fits in full space regardless of ``latent_dim``, and
        its factors can still lie in the subspace by coincidence (e.g. constant
        targets give a pure intercept). The same holds after ``fine_tune``,
        which refits a CV model in full space and marks it
        ``_full_space_refit``. Otherwise the basis is rebuilt from the stored
        training embeddings and accepted only if the current Lp/Lc lie in its
        span, which rejects changed history and models fine-tuned before the
        marker existed.
        """
        source = self.router._latent_model
        base = getattr(source, "base_model", None)
        if base is not None:
            source = base
        if getattr(source, "best_model", None) is not model:
            return None
        if getattr(model, "_full_space_refit", False):
            return None

        E = self.router._E_matrix
        d = int(getattr(model, "latent_dim", 0) or 0)
        D = model.Lp.shape[0]
        if E is None or not 0 < d < D:
            return None
        E = np.asarray(E, dtype=np.float64)
        E_aug = np.hstack([E, np.ones((E.shape[0], 1))])
        if E_aug.shape[1] != D or E_aug.shape[0] < d:
            return None
        basis = np.linalg.svd(E_aug, full_matrices=False)[2][:d]
        L = np.hstack([model.Lp, model.Lc]).astype(np.float64)
        resid = np.linalg.norm(L - basis.T @ (basis @ L)) / max(np.linalg.norm(L), 1e-12)
        if resid > 1e-6:
            logger.info(
                "[LatentFactorUpdater] Released factors are not in the rank-{} "
                "training subspace (rel. residual {:.2e}); solving in full space.",
                d, resid,
            )
            return None
        return basis

    def _fit_column(
        self,
        E: np.ndarray,
        perf: np.ndarray,
        cost: np.ndarray,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Ridge-fit one model's (Lp, Lc) columns the way training does.

        Uses the trained alpha_P / alpha_C, the training rank-d subspace when
        the released factors were fit in it, and log-cost targets (predict()
        applies _inv_log_cost).
        """
        model = self._linear_model()
        E_aug = np.hstack([E, np.ones((E.shape[0], 1), dtype=E.dtype)])
        if E_aug.shape[1] != model.Lp.shape[0]:
            raise ValueError(
                f"Augmented embedding dim ({E_aug.shape[1]}) does not match the "
                f"released factor dim ({model.Lp.shape[0]})."
            )
        alpha_P, alpha_C = self._trained_alphas(model)
        basis = self._training_subspace(model)
        X = E_aug if basis is None else E_aug @ basis.T
        gram = X.T @ X
        eye = np.eye(X.shape[1])
        lp = linalg.solve(gram + alpha_P * eye, X.T @ perf, assume_a="sym")
        lc = linalg.solve(gram + alpha_C * eye, X.T @ _log_cost(cost), assume_a="sym")
        if basis is not None:
            lp, lc = basis.T @ lp, basis.T @ lc
        return lp, lc

    def add_model(
        self,
        model_name: str,
        probe_results: List[Dict[str, Any]],
        save_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Add a single new LLM using probe set evaluation results.

        Parameters
        ----------
        model_name : str
            Identifier for the new model.
        probe_results : list[dict]
            Evaluation results for the new model on the probe set.
            Each dict should have:
                - "query": str
                - "performance": float (0-1 scale)
                - "cost": float
            These queries should match the probe set queries selected during training.
        save_path : str, optional
            If given, the updated artefact is persisted immediately.

        Returns
        -------
        dict
            Update summary with model_name, n_probes, and success status.
        """
        router = self.router
        router._require_trained()

        if not model_name:
            raise ValueError("model_name must be a non-empty string.")

        if model_name in router._available_models:
            raise ValueError(
                f"Model '{model_name}' is already in the pool. "
                f"Use remove_model() first if you want to replace it."
            )

        if not probe_results:
            raise ValueError(
                f"probe_results for '{model_name}' is empty. "
                "Provide evaluation results on at least one probe query."
            )

        probe_indices = router._probe_indices
        probe_embeddings = router._probe_embeddings

        if probe_embeddings is None or probe_indices is None:
            raise RuntimeError(
                "Probe set not available. The router may not have been trained "
                "with probe selection enabled, or the artefact was loaded from "
                "an older version without probe information."
            )

        probe_query_map: Dict[str, Tuple[float, float]] = {}
        for item in probe_results:
            q = item.get("query", "")
            perf = float(item.get("performance", 0.0))
            cost = float(item.get("cost", 0.0))
            probe_query_map[q] = (perf, cost)

        E_probe_list: List[np.ndarray] = []
        P_probe_list: List[float] = []
        C_probe_list: List[float] = []

        for i, idx in enumerate(probe_indices):
            train_item = router._train_data[idx]
            q = train_item["query"]
            if q in probe_query_map:
                perf, cost = probe_query_map[q]
            else:
                logger.warning(
                    f"Probe query at index {idx} not found in probe_results. "
                    f"Query: {q[:50]}... Skipping."
                )
                continue
            E_probe_list.append(probe_embeddings[i])
            P_probe_list.append(perf)
            C_probe_list.append(cost)

        if len(E_probe_list) < 3:
            raise ValueError(
                f"Only {len(E_probe_list)} probe queries matched. "
                "Need at least 3 for ridge regression."
            )

        E_probe = np.array(E_probe_list, dtype=np.float64)
        P_probe = np.array(P_probe_list, dtype=np.float64)
        C_probe = np.array(C_probe_list, dtype=np.float64)

        logger.info(
            f"[LatentFactorUpdater] Learning latent representation for '{model_name}' "
            f"using {len(E_probe)} probe points."
        )

        Lp_new, Lc_new = self._fit_column(E_probe, P_probe, C_probe)

        Lp_new = Lp_new.reshape(-1, 1)
        Lc_new = Lc_new.reshape(-1, 1)

        model = self._linear_model()

        Lp_old = model.Lp
        Lc_old = model.Lc

        model.Lp = np.concatenate([Lp_old, Lp_new], axis=1)
        model.Lc = np.concatenate([Lc_old, Lc_new], axis=1)

        router._available_models.append(model_name)

        logger.info(
            f"[LatentFactorUpdater] '{model_name}' added to pool. "
            f"Lp new shape: {model.Lp.shape}, Lc new shape: {model.Lc.shape}"
        )

        if save_path:
            router.save_artefacts(save_path)
            logger.info(f"[LatentFactorUpdater] Artefacts saved to {save_path}")

        return {
            "model_name": model_name,
            "n_probes_matched": len(E_probe_list),
            "n_probes_total": len(probe_indices),
            "Lp_shape": model.Lp.shape,
            "Lc_shape": model.Lc.shape,
            "saved": save_path is not None,
        }

    def add_model_by_embedding(
        self,
        model_name: str,
        eval_data: List[Dict[str, Any]],
        save_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Add a new LLM when full probe evaluation is not available.

        For each eval_data item, we embed the query and build the latent
        representation using only the queries that are available.

        Parameters
        ----------
        model_name : str
            Identifier for the new model.
        eval_data : list[dict]
            Evaluation results with "query", "performance", "cost" keys.
        save_path : str, optional

        Returns
        -------
        dict
        """
        router = self.router
        router._require_trained()

        if not model_name:
            raise ValueError("model_name must be a non-empty string.")

        if model_name in router._available_models:
            raise ValueError(
                f"Model '{model_name}' is already in the pool."
            )

        if not eval_data:
            raise ValueError("eval_data is empty.")

        eval_lookup: Dict[str, Tuple[float, float]] = {}
        for item in eval_data:
            q = item.get("query", "")
            perf = float(item.get("performance", 0.0))
            cost = float(item.get("cost", 0.0))
            eval_lookup[q] = (perf, cost)

        router.embedder.precompute(list(eval_lookup.keys()), desc="Embedding eval queries")

        E_list: List[np.ndarray] = []
        P_list: List[float] = []
        C_list: List[float] = []

        for q, (perf, cost) in eval_lookup.items():
            emb = router.embedder.batch([q])
            if emb and len(emb) > 0:
                E_list.append(np.array(emb[0], dtype=np.float64))
                P_list.append(perf)
                C_list.append(cost)

        if len(E_list) < 3:
            raise ValueError(
                f"Only {len(E_list)} eval queries embedded successfully. "
                "Need at least 3 for ridge regression."
            )

        E_eval = np.array(E_list, dtype=np.float64)
        P_eval = np.array(P_list, dtype=np.float64)
        C_eval = np.array(C_list, dtype=np.float64)

        Lp_new, Lc_new = self._fit_column(E_eval, P_eval, C_eval)

        Lp_new = Lp_new.reshape(-1, 1)
        Lc_new = Lc_new.reshape(-1, 1)

        model = self._linear_model()
        model.Lp = np.concatenate([model.Lp, Lp_new], axis=1)
        model.Lc = np.concatenate([model.Lc, Lc_new], axis=1)

        router._available_models.append(model_name)

        logger.info(
            f"[LatentFactorUpdater] '{model_name}' added via embedding path. "
            f"n_eval={len(E_list)}"
        )

        if save_path:
            router.save_artefacts(save_path)

        return {
            "model_name": model_name,
            "n_eval_queries": len(E_list),
            "Lp_shape": model.Lp.shape,
            "Lc_shape": model.Lc.shape,
            "saved": save_path is not None,
        }

    def remove_model(
        self,
        model_name: str,
        save_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Remove an LLM from the routing pool.

        Parameters
        ----------
        model_name : str
        save_path : str, optional

        Returns
        -------
        dict
        """
        router = self.router
        router._require_trained()

        if model_name not in router._available_models:
            raise ValueError(
                f"Model '{model_name}' is not in the pool. "
                f"Available: {router._available_models}"
            )

        model_idx = router._available_models.index(model_name)

        model = self._linear_model()
        model.Lp = np.delete(model.Lp, model_idx, axis=1)
        model.Lc = np.delete(model.Lc, model_idx, axis=1)

        router._available_models.remove(model_name)

        logger.info(f"[LatentFactorUpdater] '{model_name}' removed from pool.")

        if save_path:
            router.save_artefacts(save_path)

        return {
            "model_name": model_name,
            "Lp_shape": model.Lp.shape,
            "Lc_shape": model.Lc.shape,
            "saved": save_path is not None,
        }

    def update_model(
        self,
        model_name: str,
        probe_results: List[Dict[str, Any]],
        save_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Update an existing model's latent representation with new evaluation data.

        Parameters
        ----------
        model_name : str
        probe_results : list[dict]
        save_path : str, optional

        Returns
        -------
        dict
        """
        router = self.router
        router._require_trained()

        if model_name not in router._available_models:
            raise ValueError(f"Model '{model_name}' is not in the pool.")

        probe_indices = router._probe_indices
        probe_embeddings = router._probe_embeddings

        if probe_embeddings is None:
            raise RuntimeError("Probe set not available.")

        probe_query_map: Dict[str, Tuple[float, float]] = {}
        for item in probe_results:
            q = item.get("query", "")
            perf = float(item.get("performance", 0.0))
            cost = float(item.get("cost", 0.0))
            probe_query_map[q] = (perf, cost)

        E_probe_list: List[np.ndarray] = []
        P_probe_list: List[float] = []
        C_probe_list: List[float] = []

        for i, idx in enumerate(probe_indices):
            train_item = router._train_data[idx]
            q = train_item["query"]
            if q in probe_query_map:
                perf, cost = probe_query_map[q]
                E_probe_list.append(probe_embeddings[i])
                P_probe_list.append(perf)
                C_probe_list.append(cost)

        if len(E_probe_list) < 3:
            raise ValueError(
                f"Only {len(E_probe_list)} probe queries matched. "
                "Need at least 3 for ridge regression."
            )

        E_probe = np.array(E_probe_list, dtype=np.float64)
        P_probe = np.array(P_probe_list, dtype=np.float64)
        C_probe = np.array(C_probe_list, dtype=np.float64)

        model_idx = router._available_models.index(model_name)
        Lp_new, Lc_new = self._fit_column(E_probe, P_probe, C_probe)

        model = self._linear_model()
        model.Lp[:, model_idx] = Lp_new.reshape(-1)
        model.Lc[:, model_idx] = Lc_new.reshape(-1)

        logger.info(
            f"[LatentFactorUpdater] '{model_name}' updated with new probe data."
        )

        if save_path:
            router.save_artefacts(save_path)

        return {
            "model_name": model_name,
            "n_probes_matched": len(E_probe_list),
            "Lp_shape": model.Lp.shape,
            "Lc_shape": model.Lc.shape,
            "saved": save_path is not None,
        }

    # ------------------------------------------------------------------
    # Fine-tuning on newly collected data
    # ------------------------------------------------------------------
    def _examples_to_matrices(
        self,
        examples: List[Dict[str, Any]],
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Embed examples and build aligned (E, P, C) matrices.

        ``P`` and ``C`` are aligned to ``router._available_models`` with NaN for
        any model not reported in a given example (consistent with how the
        trainer's ``extract_matrices`` represents missing observations). Models
        present in the data but unknown to the router are skipped with a warning
        — brand-new models must be introduced via :meth:`add_model`.
        """
        router = self.router
        model_to_idx = {m: j for j, m in enumerate(router._available_models)}
        n_llms = len(router._available_models)

        queries = [str(item.get("query", "")) for item in examples]
        if any(q == "" for q in queries):
            raise ValueError("Every fine-tune example must contain a non-empty 'query'.")

        if router.embedder is None:
            router._ensure_embedder_for_inference()
        # Frozen embedder + PCA → embeddings live in the same space as the
        # released model's latent factors.
        E = np.asarray(router._embed(queries), dtype=np.float64)

        P = np.full((len(examples), n_llms), np.nan, dtype=np.float64)
        C = np.full((len(examples), n_llms), np.nan, dtype=np.float64)

        unknown: set = set()
        for i, item in enumerate(examples):
            records = item.get("records", {}) or {}
            usages = item.get("usages", {}) or {}
            for m, v in records.items():
                if m in model_to_idx:
                    P[i, model_to_idx[m]] = float(v)
                else:
                    unknown.add(m)
            for m, u in usages.items():
                if m in model_to_idx and isinstance(u, dict):
                    C[i, model_to_idx[m]] = float(u.get("cost", 0.0))
                elif m not in model_to_idx:
                    unknown.add(m)

        if unknown:
            logger.warning(
                "[LatentFactorUpdater] fine_tune ignoring {} unknown model(s) not "
                "in the routing pool: {}. Use add_model() to introduce them.",
                len(unknown), sorted(unknown),
            )
        return E, P, C

    def fine_tune(
        self,
        new_examples: List[Dict[str, Any]],
        prior_strength: float = 0.0,
        use_history: bool = True,
        retrain_boost: bool = True,
        save_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Fine-tune the existing models' latent factors on newly collected data.

        The base model is closed-form ridge regression, so this is an exact
        re-solve rather than a gradient update. Two complementary modes are
        supported via the parameters below; they can also be combined.

        Parameters
        ----------
        new_examples : list[dict]
            Newly collected labelled queries. Each item must have:
              * ``"query"``  : str
              * ``"records"``: {model_name: performance_score}
              * ``"usages"`` : {model_name: {"cost": float, ...}}
            Models absent from an example are treated as unobserved (NaN), exactly
            as during training. Only models already in the routing pool are
            updated; unknown models are ignored (add them with ``add_model``).
        prior_strength : float, default 0.0
            Weight of a Gaussian prior anchored on the *released* latent factors.
            ``0`` means no anchoring. Increase it when ``new_examples`` is small
            or noisy to keep the update close to the released model. This is the
            stability knob for the fine-tune.
        use_history : bool, default True
            If True (and the training matrices were persisted in the artefact),
            re-solve on the union of the original training data and the new
            examples. For a router trained without CV (a plain
            ``LatentFactorModel``), this reproduces *exactly* the full-rank ridge
            fit that training-from-scratch on old ∪ new data would produce. For a
            CV-trained router, the released factors were fit in a rank-truncated
            PCA subspace; this re-solve is a full-rank ridge at the same alpha and
            stays in the same coordinate space, but does not reproduce that rank
            truncation (run a full retrain if the low-rank structure matters). If
            False, fit on the new examples only (pair with ``prior_strength > 0``
            for a Bayesian update treating the released model as the prior).
        retrain_boost : bool, default True
            When the router uses residual boosting, refit the stage-2 boosters on
            the same data window (sklearn boosters have no warm-start, so a fresh
            refit is the correct approach).
        save_path : str, optional
            If given, persist the updated artefact immediately.

        Returns
        -------
        dict
            Summary including the number of new/total samples used and the
            updated factor shapes.

        Notes
        -----
        The embedder, PCA projection, ``latent_dim`` and ``alpha`` are held
        fixed — they define the coordinate system the released factors live in.
        Re-selecting any of those (e.g. under heavy distribution shift) requires
        a full retrain via :class:`LatentFactorTrainer`, not this method.
        """
        router = self.router
        router._require_trained()

        if not new_examples:
            raise ValueError("new_examples is empty; nothing to fine-tune on.")
        if prior_strength < 0:
            raise ValueError("prior_strength must be non-negative.")

        model = self._linear_model()

        E_new, P_new, C_new = self._examples_to_matrices(new_examples)

        # Stack with persisted training history when available and requested.
        history_available = (
            router._E_matrix is not None
            and router._P_matrix is not None
            and router._C_matrix is not None
        )
        if use_history and not history_available:
            logger.warning(
                "[LatentFactorUpdater] use_history=True but training matrices were "
                "not persisted in the artefact; fine-tuning on new data only. "
                "Consider prior_strength > 0 to stay anchored to the released model."
            )
        if use_history and history_available:
            if router._E_matrix.shape[1] != E_new.shape[1]:
                raise ValueError(
                    f"Embedding dim mismatch: history has {router._E_matrix.shape[1]} "
                    f"dims, new embeddings have {E_new.shape[1]}. The embedder/PCA "
                    "must match the one used at training time."
                )
            E_all = np.vstack([np.asarray(router._E_matrix, dtype=np.float64), E_new])
            P_all = np.vstack([np.asarray(router._P_matrix, dtype=np.float64), P_new])
            C_all = np.vstack([np.asarray(router._C_matrix, dtype=np.float64), C_new])
        else:
            E_all, P_all, C_all = E_new, P_new, C_new

        # Cost is modelled on the log scale (Lc predicts log-cost), matching the
        # training path in LatentFactorModel.fit.
        C_all_log = _log_cost(C_all)

        n_all = E_all.shape[0]
        E_aug = np.hstack([E_all, np.ones((n_all, 1), dtype=E_all.dtype)])

        if E_aug.shape[1] != model.Lp.shape[0]:
            raise ValueError(
                f"Augmented embedding dim ({E_aug.shape[1]}) does not match the "
                f"released factor dim ({model.Lp.shape[0]}). The embedder/PCA "
                "projection has changed; a full retrain is required."
            )

        alpha_P, alpha_C = self._trained_alphas(model)

        prior_P = model.Lp if prior_strength > 0 else None
        prior_C = model.Lc if prior_strength > 0 else None

        P_mask = ~np.isnan(P_all)
        C_mask = ~np.isnan(C_all_log)

        Lp_new = _anchored_masked_ridge(
            E_aug, P_all, P_mask, alpha_P, prior=prior_P, prior_strength=prior_strength,
        )
        Lc_new = _anchored_masked_ridge(
            E_aug, C_all_log, C_mask, alpha_C, prior=prior_C, prior_strength=prior_strength,
        )

        model.Lp = Lp_new
        model.Lc = Lc_new
        # Full-space refit: later adds must not be restricted to the CV subspace,
        # even if these factors happen to lie in it (see _training_subspace).
        model._full_space_refit = True

        # Keep the target scaler (used by recommend's normalization) calibrated.
        scaler = getattr(model, "_scaler", None)
        if scaler is not None:
            scaler.partial_update(P_new, C_new)

        # Refit residual-boost heads if present and requested.
        boosted = self.router._latent_model
        boost_refit = False
        if retrain_boost and hasattr(boosted, "_fit_boost_stage") and getattr(
            boosted, "_is_fitted", False
        ):
            boosted._fit_boost_stage(E_all, P_all, C_all)
            boost_refit = True

        # Persist the expanded history so subsequent fine-tunes accumulate and a
        # later save captures the full dataset behind the current factors.
        if use_history and history_available:
            router._E_matrix = E_all
            router._P_matrix = P_all
            router._C_matrix = C_all

        logger.info(
            "[LatentFactorUpdater] fine_tune complete: n_new={}, n_total={}, "
            "prior_strength={:.4g}, use_history={}, boost_refit={}",
            E_new.shape[0], n_all, prior_strength, use_history, boost_refit,
        )

        if save_path:
            router.save_artefacts(save_path)
            logger.info(f"[LatentFactorUpdater] Artefacts saved to {save_path}")

        return {
            "n_new_samples": int(E_new.shape[0]),
            "n_total_samples": int(n_all),
            "prior_strength": prior_strength,
            "used_history": bool(use_history and history_available),
            "boost_refit": boost_refit,
            "Lp_shape": model.Lp.shape,
            "Lc_shape": model.Lc.shape,
            "saved": save_path is not None,
        }
