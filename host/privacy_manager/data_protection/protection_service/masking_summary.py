"""Aggregate-only masking metadata for user-facing protection results."""

from __future__ import annotations

import re
from collections import Counter
from typing import Mapping

from pydantic import BaseModel, Field


_CATEGORY_PLACEHOLDER_RE = re.compile(r"^<([A-Za-z][A-Za-z0-9_]*)_\d+>$")


class MaskingCategorySummary(BaseModel):
    """Count of unique masked entities for one category."""

    category: str = Field(pattern=r"^[A-Z][A-Z0-9_]*$")
    count: int = Field(gt=0)


class MaskingSummary(BaseModel):
    """PII-free aggregate metadata for a completed masking operation."""

    entity_count: int = Field(gt=0)
    categories: list[MaskingCategorySummary] = Field(default_factory=list)


def summarize_masking_registry(
    registry: Mapping[str, object],
) -> MaskingSummary | None:
    """Count canonical placeholder entries without reading their values."""
    category_counts: Counter[str] = Counter()
    for placeholder in registry:
        if not isinstance(placeholder, str):
            continue
        match = _CATEGORY_PLACEHOLDER_RE.fullmatch(placeholder)
        if match is not None:
            category_counts[match.group(1).upper()] += 1

    if not category_counts:
        return None

    categories = [
        MaskingCategorySummary(category=category, count=count)
        for category, count in sorted(category_counts.items())
    ]
    return MaskingSummary(
        entity_count=sum(category_counts.values()),
        categories=categories,
    )