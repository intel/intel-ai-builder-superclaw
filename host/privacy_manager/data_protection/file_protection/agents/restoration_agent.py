"""Restoration Agent — replaces placeholders with their original values.

Supports two modes:

  - TEXT mode: restore placeholders inline in a free-form string (e.g. a
    downstream model's response).
  - FILE mode: restore an entire masked file and write the result to disk.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from file_protection.registry import load_registry
from file_protection.restore import (
    FileRestoreResult,
    TextRestoreResult,
    restore_file,
    restore_text,
)


@dataclass
class RestoreFileResult:
    masked_file: Path
    registry_file: Path
    restored_file: Path
    rows_restored: int
    replacements: int
    unmatched: list[str]
    status: str = "success"

    def as_summary(self) -> str:
        return (
            "Restoration Complete\n"
            "-----------------------------------------------------\n"
            f"Masked File        : {self.masked_file}\n"
            f"Registry File      : {self.registry_file}\n"
            f"Restored File      : {self.restored_file}\n"
            f"Rows Restored      : {self.rows_restored} - matches masked\n"
            f"Replacements Made  : {self.replacements}\n"
            f"Unmatched          : "
            f"{self.unmatched if self.unmatched else 'None'}\n"
            f"Status             : {self.status}"
        )


@dataclass
class RestorationAgent:
    """Reverse PII masking using a forward registry."""

    output_dir: Path | None = None

    def __post_init__(self) -> None:
        if self.output_dir is not None:
            self.output_dir = Path(self.output_dir).expanduser().resolve()
            self.output_dir.mkdir(parents=True, exist_ok=True)

    def run_text(
        self,
        text: str,
        registry: Mapping[str, str] | str | Path,
    ) -> TextRestoreResult:
        """Restore placeholders in ``text`` using ``registry``.

        Args:
            text: Free-form text from a downstream model.
            registry: Forward registry mapping or path to a registry JSON file.

        Returns:
            :class:`file_protection.restore.TextRestoreResult`.
        """
        if isinstance(registry, (str, Path)):
            registry_map = load_registry(registry)
        elif isinstance(registry, Mapping):
            registry_map = dict(registry)
        else:
            raise TypeError(
                "registry must be a mapping or a path to a registry JSON file"
            )

        return restore_text(text, registry_map)

    def run_file(
        self,
        masked_file: str | Path,
        registry_file: str | Path,
        *,
        output_dir: str | Path | None = None,
        output_format: str = "csv",
        expected_rows: int | None = None,
    ) -> RestoreFileResult:
        """Restore a masked file and persist the output.

        Args:
            masked_file: Path to the masked CSV / Parquet file.
            registry_file: Path to the forward registry JSON file.
            output_dir: Override the agent's configured output directory.
            output_format: ``"csv"`` (default) or ``"parquet"``.
            expected_rows: If provided, raises if the restored row count
                differs from this value.

        Returns:
            :class:`RestoreFileResult` describing the persisted artifacts.
        """
        target_dir = output_dir or self.output_dir
        if target_dir is None:
            raise ValueError(
                "output_dir must be set on the agent or passed to run_file()"
            )

        result: FileRestoreResult = restore_file(
            masked_file=masked_file,
            registry=registry_file,
            output_dir=target_dir,
            output_format=output_format,
        )

        if expected_rows is not None and result.rows != expected_rows:
            raise ValueError(
                f"Row count mismatch: expected {expected_rows}, got {result.rows}"
            )

        return RestoreFileResult(
            masked_file=Path(masked_file).expanduser().resolve(),
            registry_file=Path(registry_file).expanduser().resolve(),
            restored_file=result.output_path,
            rows_restored=result.rows,
            replacements=result.replacements,
            unmatched=result.unmatched,
        )
