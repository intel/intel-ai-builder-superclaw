"""PII Detection Agent — masks sensitive cells in an extracted file.

Reads an extracted CSV/Parquet/Excel file, applies the column-to-category
mapping provided by the orchestrator, persists a masked file plus a forward
registry to the configured output directory, and returns a summary.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Sequence

from file_protection.detect import is_free_text_column, strict_column_category
from file_protection.io import load_table, save_dataframe
from file_protection.masker import SpanProvider, mask_dataframe
from file_protection.registry import save_registry

# Rows sampled when deciding whether a column is prose (free text). A
# small sample is enough to estimate mean token count.
_FREETEXT_SAMPLE = 200


def _col_str_values(series, limit: int = _FREETEXT_SAMPLE) -> list[str]:
    """Up to ``limit`` non-null, non-empty stringified values from a column."""
    out: list[str] = []
    for v in series.dropna():
        s = str(v).strip()
        if not s:
            continue
        out.append(s)
        if len(out) >= limit:
            break
    return out


@dataclass
class RedactDataFrameResult:
    """In-memory result of :func:`redact_dataframe` (no disk artifacts).

    Carries the masked DataFrame and forward registry directly so a caller
    that reads the source once (e.g. the HTTP layer) can mask without the
    DataPrep -> disk -> Redact round-trip the file-based agent performs.
    """

    df: object  # pandas.DataFrame
    registry: dict[str, str]
    rows_masked: int
    columns_masked: list[str]
    extra_pii_found: list[str]
    safety_net_columns: dict[str, str] = field(default_factory=dict)
    free_text_columns: list[str] = field(default_factory=list)


@dataclass
class RedactAgentResult:
    extracted_file: Path
    masked_file: Path
    registry_file: Path
    rows_masked: int
    columns_masked: list[str]
    extra_pii_found: list[str]
    # Columns the full-column safety net masked that the caller did NOT
    # declare — i.e. PII a row-sampled detection pass would have missed.
    # ``{column: category}``. Surfaced so operators can tighten their
    # declared sensitive_columns / detection thresholds.
    safety_net_columns: dict[str, str] = field(default_factory=dict)
    # Columns masked with sub-cell free-text span scanning (prose columns).
    free_text_columns: list[str] = field(default_factory=list)
    status: str = "success"

    def as_summary(self) -> str:
        return (
            "PII Masking Complete\n"
            "-----------------------------------------------------\n"
            f"Extracted File     : {self.extracted_file}\n"
            f"Masked File        : {self.masked_file}\n"
            f"Registry File      : {self.registry_file}\n"
            f"Rows Masked        : {self.rows_masked} - matches extracted\n"
            f"Columns Masked     : {self.columns_masked}\n"
            f"Extra PII Found    : "
            f"{self.extra_pii_found if self.extra_pii_found else 'None'}\n"
            f"Safety-net Columns : "
            f"{self.safety_net_columns if self.safety_net_columns else 'None'}\n"
            f"Free-text Columns  : "
            f"{self.free_text_columns if self.free_text_columns else 'None'}\n"
            f"Status             : {self.status}"
        )


@dataclass
class RedactAgent:
    """Mask PII columns in a tabular file.

    Attributes:
        output_dir: Directory to write the masked file and registry into.
        output_format: ``"csv"`` (default) or ``"parquet"``.
    """

    output_dir: Path
    output_format: str = "csv"

    def __post_init__(self) -> None:
        self.output_dir = Path(self.output_dir).expanduser().resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def run(
        self,
        extracted_file: str | Path,
        sensitive_columns: Mapping[str, str],
        *,
        suspected_sensitive_columns: Sequence[str] = (),
        expected_rows: int | None = None,
        full_scan_safety_net: bool = True,
        scan_all_columns: bool = False,
        scan_free_text: bool = True,
        span_provider: SpanProvider | None = None,
        free_text_columns: Sequence[str] | None = None,
        bucketize_financial: bool = False,
    ) -> RedactAgentResult:
        """Mask the configured columns and persist outputs.

        Args:
            extracted_file: Path to the extracted file produced by
                :class:`DataPrepAgent`.
            sensitive_columns: Map of ``column_name -> placeholder_category`` (e.g.
                ``{"email": "EMAIL", "name": "PERSON"}``).
            suspected_sensitive_columns: Columns the orchestrator wants deeply
                scanned even if not declared PII. With the safety net on
                (the default), each is scanned over its FULL column with
                certainty detectors; any hit is masked. Also used to
                classify masked columns as "extra PII" for reporting.
            expected_rows: If provided, raises ``ValueError`` when the row count
                of ``extracted_file`` does not match.
            full_scan_safety_net: When ``True`` (default), scan
                ``suspected_sensitive_columns`` over the whole column with
                checksum-/format-certain detectors and mask any that hit.
                Closes the "detection sampled 200 rows, the PII was in row
                900k" leak. Set ``False`` to mask ONLY the declared columns.
            scan_all_columns: When ``True`` AND the safety net is on,
                broaden the scan to EVERY not-yet-declared column rather
                than just ``suspected_sensitive_columns``. Appropriate for
                auto-detect mode (nothing was declared, so scan widely);
                left ``False`` for explicit-columns mode so the agent
                never masks a column the caller didn't ask about beyond a
                certainty hit in a column they flagged as suspected.
            scan_free_text: When ``True`` (default), auto-classify prose
                columns (notes/comments) and mask PII *inside* their cells
                with sub-cell span scanning. Set ``False`` to disable.
            span_provider: Optional NER-backed span provider for free-text
                cells (PERSON/ORG). Injected by the service layer when the
                text-sanitize pipeline is loaded; ``None`` uses only the
                model-free regex span patterns.
            free_text_columns: Explicit free-text column list. When
                ``None`` and ``scan_free_text`` is on, they are
                auto-detected among the scan targets.
            bucketize_financial: When ``True``, FINANCIAL columns holding
                monetary amounts are masked to magnitude-labeled
                placeholders (``<FINANCIAL_THOUSANDS_1>``). Card / IBAN
                identifier columns stay plain ``FINANCIAL``.

        Returns:
            :class:`RedactAgentResult` describing the artifacts.
        """
        path = Path(extracted_file).expanduser().resolve()
        df = load_table(path)

        dfr = redact_dataframe(
            df,
            sensitive_columns,
            suspected_sensitive_columns=suspected_sensitive_columns,
            expected_rows=expected_rows,
            full_scan_safety_net=full_scan_safety_net,
            scan_all_columns=scan_all_columns,
            scan_free_text=scan_free_text,
            span_provider=span_provider,
            free_text_columns=free_text_columns,
            bucketize_financial=bucketize_financial,
        )

        masked_path = save_dataframe(
            dfr.df,
            output_dir=self.output_dir,
            prefix="masked",
            output_format=self.output_format,
        )
        # Registry filename mirrors the masked file's stem so the orchestrator
        # can pair them: ``masked_<ts>.csv`` -> ``masked_<ts>.registry.json``.
        registry_path = masked_path.with_suffix("")
        registry_path = registry_path.parent / f"{registry_path.name}.registry.json"
        save_registry(dfr.registry, registry_path)

        return RedactAgentResult(
            extracted_file=path,
            masked_file=masked_path,
            registry_file=registry_path,
            rows_masked=dfr.rows_masked,
            columns_masked=dfr.columns_masked,
            extra_pii_found=dfr.extra_pii_found,
            safety_net_columns=dfr.safety_net_columns,
            free_text_columns=dfr.free_text_columns,
        )


def redact_dataframe(
    df,
    sensitive_columns: Mapping[str, str],
    *,
    suspected_sensitive_columns: Sequence[str] = (),
    expected_rows: int | None = None,
    full_scan_safety_net: bool = True,
    scan_all_columns: bool = False,
    scan_free_text: bool = True,
    span_provider: SpanProvider | None = None,
    free_text_columns: Sequence[str] | None = None,
    bucketize_financial: bool = False,
) -> RedactDataFrameResult:
    """Mask an in-memory DataFrame — the disk-free core of :class:`RedactAgent`.

    Applies the same three-pass logic (declared whole-cell columns, sub-cell
    free-text scanning, and the full-column certainty safety net) but takes
    and returns a DataFrame instead of reading/writing files. The HTTP layer
    uses this to mask a source it has already read once, avoiding the
    DataPrep -> extracted-file -> Redact re-read round-trip.

    See :meth:`RedactAgent.run` for the argument semantics; ``df`` replaces
    ``extracted_file`` and the result carries the masked DataFrame + registry
    in memory rather than persisting them.
    """
    if expected_rows is not None and len(df) != expected_rows:
        raise ValueError(
            f"Row count mismatch: expected {expected_rows}, got {len(df)}"
        )

    if not sensitive_columns:
        raise ValueError("sensitive_columns must contain at least one entry")

    # Validate sensitive_columns: every requested column should exist.
    active = {c: cat for c, cat in sensitive_columns.items() if c in df.columns}
    if not active:
        raise ValueError(
            f"None of {list(sensitive_columns)} are present in {list(df.columns)}"
        )

    # The set of columns eligible for the extra scans (safety net +
    # free-text). Auto mode scans everything; explicit mode scans only the
    # caller's suspected columns.
    if scan_all_columns:
        scan_targets = [c for c in df.columns]
    else:
        scan_targets = [c for c in suspected_sensitive_columns if c in df.columns]

    # Sub-cell free-text detection: prose columns carry PII *inside* cells, so
    # they get span scanning rather than whole-cell masking. Auto-detect among
    # scan_targets unless the caller named them.
    if free_text_columns is not None:
        freetext = [c for c in free_text_columns if c in df.columns]
    elif scan_free_text:
        freetext = [
            c for c in scan_targets
            if c not in active
            and is_free_text_column(_col_str_values(df[c]))
        ]
    else:
        freetext = []
    freetext_set = set(freetext)

    # Full-column safety net: catch certainty-detectable whole-cell PII that a
    # row-sampled detection pass may have missed. Skip columns already handled
    # as declared PII or as free text (the latter get sub-cell scanning, which
    # subsumes the whole-cell check).
    safety_net_added: dict[str, str] = {}
    if full_scan_safety_net:
        for col in scan_targets:
            if col in active or col in freetext_set:
                continue
            cat = strict_column_category(df[col])
            if cat is not None:
                active[col] = cat
                safety_net_added[col] = cat

    result = mask_dataframe(
        df,
        active,
        free_text_columns=freetext,
        span_provider=span_provider,
        bucketize_financial=bucketize_financial,
    )

    # "Extra PII" = a masked column the orchestrator did not flag as suspected.
    # Safety-net columns are reported separately in ``safety_net_columns``.
    suspected = set(suspected_sensitive_columns)
    extra = [c for c in result.columns_masked if c not in suspected] if suspected else []

    return RedactDataFrameResult(
        df=result.df,
        registry=result.registry,
        rows_masked=len(result.df),
        columns_masked=result.columns_masked,
        extra_pii_found=extra,
        safety_net_columns=safety_net_added,
        free_text_columns=freetext,
    )
