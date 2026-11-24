"""
LatentFactorRouter — eval.py
============================
Evaluation script that:
1. Loads a trained LatentFactorRouter model
2. Loads test set data
3. Sweeps perf_weight to generate a Pareto plot on the test set
"""

from __future__ import annotations

import argparse
from loguru import logger
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent.parent))

from . import (
    LatentFactorRouter,
    LatentFactorTrainer,
    plot_weight_ablation_pareto,
)




def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate LatentFactorRouter with perf_weight sweep on test set"
    )
    parser.add_argument(
        "--config",
        type=str,
        default="config_test.yaml",
        help="Path to YAML config file (default: config_test.yaml)",
    )
    parser.add_argument(
        "--model-path",
        type=str,
        default=None,
        help="Path to saved model artefacts (.pkl). "
             "If not given, derived from config's model_path.load_model_path",
    )
    parser.add_argument(
        "--perf-weights",
        type=float,
        nargs="+",
        default=None,
        help="List of perf_weight values to sweep (e.g., 0.7 0.8 0.9 1.0). "
             "If not given, uses default sweep from trainer.",
    )
    parser.add_argument(
        "--step",
        type=float,
        default=0.1,
        help="Step size for perf_weight sweep when --perf-weights not given (default: 0.1)",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=None,
        help="Directory to save output plots and JSON. "
             "Defaults to same directory as model path.",
    )
    parser.add_argument(
        "--log-level",
        type=str,
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        help="Logging level (default: INFO)",
    )
    return parser.parse_args()


def resolve_path(rel_or_abs: str, base_dir: str) -> str:
    if not rel_or_abs:
        return ""
    if os.path.isabs(rel_or_abs):
        return rel_or_abs
    return os.path.join(base_dir, rel_or_abs)


def main() -> None:
    args = parse_args()

    logger.remove()
    logger.add(sys.stderr, level=args.log_level.upper())

    config_path = args.config
    if not os.path.isabs(config_path):
        project_root = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "../..")
        )
        config_path = os.path.join(project_root, config_path)

    if not os.path.exists(config_path):
        logger.error(f"Config file not found: {config_path}")
        sys.exit(1)

    logger.info(f"[eval] Loading router from config: {config_path}")
    router = LatentFactorRouter(config_path)

    model_path = args.model_path
    if model_path is None:
        model_path = router.cfg.get("model_path", {}).get("load_model_path", "")
        if model_path:
            project_root = os.path.abspath(
                os.path.join(os.path.dirname(__file__), "../..")
            )
            model_path = resolve_path(model_path, project_root)

    if not model_path or not os.path.exists(model_path):
        logger.error(
            f"[eval] Model not found at: {model_path}. "
            "Please train the model first or provide --model-path."
        )
        sys.exit(1)

    logger.info(f"[eval] Loading trained model from: {model_path}")
    router.load_artefacts(model_path)

    data_path = model_path.replace(".pkl", "_data.pkl")
    if os.path.exists(data_path):
        from llmrouter.utils import load_model
        data_bundle = load_model(data_path)
        test_data = data_bundle.get("test_data", [])
        logger.info(f"[eval] Loaded test data: {len(test_data)} queries")
    else:
        logger.warning(
            f"[eval] Data splits file not found: {data_path}. "
            "Using router's internal test_data."
        )
        test_data = router._test_data

    if not test_data:
        logger.error("[eval] No test data available. Cannot run evaluation.")
        sys.exit(1)

    logger.info(f"[eval] Test set size: {len(test_data)} queries")
    logger.info(f"[eval] Available models: {router._available_models}")

    trainer = LatentFactorTrainer(router)

    output_dir = args.output_dir
    if output_dir is None:
        output_dir = os.path.dirname(model_path) if model_path else "."
    output_dir = os.path.abspath(output_dir)
    os.makedirs(output_dir, exist_ok=True)

    perf_weights = args.perf_weights
    if perf_weights is not None:
        logger.info(f"[eval] Using custom perf_weights: {perf_weights}")
    else:
        logger.info(f"[eval] Using default perf_weights sweep with step={args.step}")

    logger.info("\n[eval] Starting perf_weight sweep...")
    sweep_results = trainer.sweep_perf_weight(
        test_data,
        perf_weights=perf_weights,
        step=args.step,
    )

    logger.info("\n[eval] Sweep results summary:")
    for entry in sweep_results:
        logger.info(
            f"  perf_weight={entry['perf_weight']:.2f}  "
            f"accuracy={entry['accuracy']*100:6.2f}%  "
            f"avg_cost=${entry['avg_cost']:.4f}  "
            f"qc_score={entry['quality_cost_score']:.4f}"
        )

    plot_path = os.path.join(output_dir, "weight_ablation_pareto.png")
    json_path = os.path.join(output_dir, "weight_ablation_results.json")

    logger.info(f"\n[eval] Generating Pareto plot...")
    saved_plot = plot_weight_ablation_pareto(
        sweep_results=sweep_results,
        save_path=plot_path,
    )

    if saved_plot:
        logger.info(f"[eval] Pareto plot saved -> {saved_plot}")
    else:
        logger.warning("[eval] Failed to generate Pareto plot")

    import json
    try:
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(sweep_results, f, indent=2)
        logger.info(f"[eval] Sweep JSON saved -> {json_path}")
    except Exception as exc:
        logger.warning(f"[eval] Could not save sweep JSON: {exc}")

    logger.info("\n[eval] Done.")


if __name__ == "__main__":
    main()
