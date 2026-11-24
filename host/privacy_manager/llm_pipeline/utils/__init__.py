import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path


def setup_logger(
    name: str = "protected_file_pipeline",
    log_dir: str | Path = "integrations/protected_file_pipeline/logs",
    level: int = logging.DEBUG,
) -> logging.Logger:
    """
    Set up a logger for the protected file pipeline.

    Args:
        name (str): Name of the logger.
        log_dir (str | Path): Directory where log files will be stored.
        level (int): Logging level (e.g., logging.INFO, logging.DEBUG).

    Returns:
        logging.Logger: Configured logger instance.
    """
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    log_file_path = Path(log_dir) / f"protected_file_pipeline_{today}.log"

    logger = logging.getLogger(name)
    logger.setLevel(level)

    log_file_path.parent.mkdir(parents=True, exist_ok=True)

    boot_id = (os.environ.get("SUPERCLAW_BOOT_ID") or "").strip() or "-"
    formatter = logging.Formatter(
        f"%(asctime)s.%(msecs)03dZ [%(levelname)s] "
        f"boot_id={boot_id} %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    formatter.converter = time.gmtime

    file_handler = logging.FileHandler(log_file_path, encoding="utf-8")
    file_handler.setLevel(level)
    file_handler.setFormatter(formatter)

    console_handler = logging.StreamHandler()
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)

    if not logger.hasHandlers():
        logger.addHandler(file_handler)
        logger.addHandler(console_handler)

    return logger