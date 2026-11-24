"""Free-form document PII redaction (txt / md / html / docx).

Tabular files (csv/xlsx/parquet) are column-structured, so the masker there
is column-aware. Documents are prose: PII lives *inside* running text with no
schema. This module therefore reuses the sub-cell free-text engine that the
tabular masker already applies to prose columns
(:func:`file_protection.masker._mask_free_text_value`) — model-free regex
spans (email / URL / card / SSN / phone / IP), optionally augmented by an
injected NER span provider (PERSON / ORG / CITY) when the service layer's
text-sanitize pipeline is loaded.

The output is the **same flat ``{placeholder: original}`` registry** the
tabular pipeline produces, so ``/v1/restore`` reverses documents and tables
identically.

Structure preservation is per-format:

* ``.txt`` / ``.md`` / ``.markdown`` — the file is one UTF-8 text blob;
  placeholders are spliced in place, so Markdown structure (headings, lists,
  links) is byte-preserved except where a span overlaps real PII.
* ``.html`` / ``.htm`` — parsed with BeautifulSoup; only visible **text
  nodes** are masked (``<script>`` / ``<style>`` skipped). Tags, attributes,
  and document structure are left intact so the markup stays valid.
* ``.docx`` — opened with python-docx; masking happens at the **run** level
  (paragraphs, table cells, headers/footers) so character formatting is
  preserved. A single PII value split across multiple runs by Word's styling
  is a known recall limitation — see :func:`_transform_docx`.

``.doc`` (the legacy OLE binary) is intentionally unsupported: it needs a
heavyweight external converter. Callers should convert to ``.docx`` first.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Optional

from file_protection.masker import (
    SpanProvider,
    _make_placeholder_factory,
    _mask_free_text_value,
)
from file_protection.restore import PLACEHOLDER_SCAN_PATTERN

# Text-based formats round-trip as UTF-8 strings; docx is a binary container.
_TEXT_SUFFIXES = (".txt", ".md", ".markdown", ".text")
_HTML_SUFFIXES = (".html", ".htm")
_DOCX_SUFFIXES = (".docx",)

SUPPORTED_DOCUMENT_SUFFIXES: tuple[str, ...] = (
    _TEXT_SUFFIXES + _HTML_SUFFIXES + _DOCX_SUFFIXES
)

# Formats whose masked output is binary (cannot be returned as inline text).
BINARY_DOCUMENT_SUFFIXES: tuple[str, ...] = _DOCX_SUFFIXES

# HTML elements whose text is code/markup, never prose to mask.
_HTML_SKIP_TAGS = frozenset({"script", "style"})

# Zip-bomb / oversized-XML guardrails for docx and xlsx (both are ZIP
# containers). Values chosen well above any legitimate document, but
# small enough that a crafted archive can't OOM the service. The
# uncompressed cap is deliberately tight (50 MiB): legitimate business
# documents are almost always well under 10 MiB uncompressed; a 500 MiB
# cap left plenty of headroom for a crafted archive to still consume
# hundreds of MB of RAM during openpyxl / python-docx parsing (which
# actually decompresses, whereas this guard only inspects metadata).
_ZIP_MAX_ENTRIES = 2_000
_ZIP_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024   # 50 MiB
_ZIP_MAX_COMPRESSION_RATIO = 200                  # per entry


class UnsafeArchiveError(ValueError):
    """Raised when a docx/xlsx archive trips one of the zip-bomb guards."""


def check_zip_safety(
    path: str | Path,
    *,
    max_entries: int = _ZIP_MAX_ENTRIES,
    max_uncompressed: int = _ZIP_MAX_UNCOMPRESSED_BYTES,
    max_ratio: int = _ZIP_MAX_COMPRESSION_RATIO,
) -> None:
    """Reject docx/xlsx archives whose declared metadata looks like a bomb.

    Reads only the central directory — does NOT decompress — so it stays
    O(1) in memory even on adversarial input. Raises
    :class:`UnsafeArchiveError` on:
      * entry count over ``max_entries``,
      * total uncompressed size over ``max_uncompressed``,
      * per-entry compression ratio over ``max_ratio``.

    Complements :func:`assert_xml_parsers_hardened` — this guard covers the
    ZIP layer; parser entity-expansion (billion-laughs) is defused at the
    XML layer by the underlying parser configuration (lxml
    ``resolve_entities=False``). Both defenses are required: the ZIP guard
    is O(1) and stops the size explosion, and disabled entity resolution
    stops in-memory expansion during parsing.
    """
    import zipfile

    p = Path(path)
    try:
        with zipfile.ZipFile(p) as zf:
            infos = zf.infolist()
            if len(infos) > max_entries:
                raise UnsafeArchiveError(
                    f"archive has {len(infos)} entries "
                    f"(limit {max_entries})"
                )
            total = 0
            for info in infos:
                total += info.file_size
                if total > max_uncompressed:
                    raise UnsafeArchiveError(
                        f"archive uncompressed size exceeds "
                        f"{max_uncompressed} bytes"
                    )
                if info.compress_size > 0:
                    ratio = info.file_size / info.compress_size
                    if ratio > max_ratio:
                        raise UnsafeArchiveError(
                            f"archive entry {info.filename!r} has "
                            f"compression ratio {ratio:.0f}x "
                            f"(limit {max_ratio}x)"
                        )
    except zipfile.BadZipFile as exc:
        raise UnsafeArchiveError(f"not a valid zip archive: {p}") from exc

def assert_xml_parsers_hardened() -> None:
    """Verify the XML parsers we rely on refuse to expand entities.

    Called on service startup so a future dependency upgrade that re-enables
    entity resolution is caught immediately, not after the first
    attacker-crafted DOCX/XLSX arrives. Raises ``RuntimeError`` with a
    descriptive message so the operator sees the failure in logs.

    ``resolve_entities`` is a constructor kwarg on ``lxml.etree.XMLParser``
    but is not exposed as a runtime attribute, so we probe empirically: a
    tiny doc that references a declared entity should NOT expand — a parser
    with entity resolution ON returns text ``"expanded"``, while our
    hardened parsers return ``""``. That behavior test is version-proof and
    also catches ``defusedxml`` swap-ins.

    We assert two parsers:

    * ``docx.oxml.parser.parse_xml`` — used by python-docx for every
      ``Document(...)`` call.
    * ``openpyxl.xml.functions.fromstring`` — used by openpyxl for xlsx
      cells (or defusedxml equivalent).

    Complements :func:`check_zip_safety` at the ZIP layer.
    """
    _PROBE = (
        b"<?xml version='1.0'?>\n"
        b"<!DOCTYPE r [ <!ENTITY x 'expanded'> ]>\n"
        b"<r>&x;</r>"
    )

    # python-docx (lxml parser).
    try:
        from docx.oxml.parser import parse_xml as _docx_parse_xml
    except Exception as exc:
        raise RuntimeError(
            f"Could not import docx parser to verify hardening: {exc}"
        ) from exc
    try:
        root = _docx_parse_xml(_PROBE)
        text = (root.text or "")
    except Exception:
        # A parser that rejects the DTD outright is even safer than one
        # that silently returns "" — accept both outcomes.
        text = ""
    if "expanded" in text:
        raise RuntimeError(
            "python-docx XML parser resolves entities — a crafted DOCX "
            "with recursive !ENTITY definitions could expand to GBs in "
            "memory (billion-laughs). Refusing to start."
        )

    # openpyxl. ``fromstring`` is either lxml with resolve_entities=False
    # (default when lxml is present) or defusedxml.ElementTree.fromstring —
    # either way, the probe entity must not appear in the parsed text.
    try:
        from openpyxl.xml.functions import fromstring as _xlsx_fromstring
    except Exception as exc:
        raise RuntimeError(
            f"Could not import openpyxl parser to verify hardening: {exc}"
        ) from exc
    try:
        el = _xlsx_fromstring(_PROBE)
        # lxml returns Element; stdlib returns Element. Both have .text.
        xlsx_text = (getattr(el, "text", None) or "")
    except Exception:
        xlsx_text = ""
    if "expanded" in xlsx_text:
        raise RuntimeError(
            "openpyxl XML parser resolves entities — install defusedxml "
            "or lxml before enabling xlsx handling."
        )


# A transform maps one text segment to its rewritten form (mask or restore).
Transform = Callable[[str], str]


def is_document(path: str | Path) -> bool:
    """Return ``True`` if ``path``'s suffix is a supported document format."""
    return Path(path).suffix.lower() in SUPPORTED_DOCUMENT_SUFFIXES


def is_binary_document(path: str | Path) -> bool:
    """Return ``True`` if the masked output for ``path`` is binary (e.g. docx).

    Binary outputs cannot be returned inline as text — the caller must use
    path return-mode.
    """
    return Path(path).suffix.lower() in BINARY_DOCUMENT_SUFFIXES


@dataclass
class DocumentMaskResult:
    """Output of :func:`mask_document`."""

    masked_file: Path
    registry: dict[str, str]
    # Number of text segments (nodes / runs / the single text blob) that
    # produced at least one placeholder. Not a PII count — a segment may hold
    # several — but a useful "did anything get masked" signal.
    segments_masked: int
    is_binary: bool
    status: str = "success"


@dataclass
class DocumentRestoreResult:
    """Output of :func:`restore_document`."""

    restored_file: Path
    replacements: int
    unmatched: list[str] = field(default_factory=list)
    is_binary: bool = False
    status: str = "success"


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------


def mask_document(
    source: str | Path,
    dest: str | Path,
    *,
    span_provider: Optional[SpanProvider] = None,
    phone_anchor_boost: bool = False,
) -> DocumentMaskResult:
    """Mask PII in a document, writing the redacted copy to ``dest``.

    Args:
        source: Path to a supported document (txt/md/html/docx).
        dest: Path to write the masked document to. Its parent is created if
            absent. The masked content preserves ``source``'s format.
        span_provider: Optional NER-backed span provider (PERSON/ORG/CITY),
            injected by the service layer when the text-sanitize pipeline is
            loaded. ``None`` uses only the model-free regex span patterns.

    Returns:
        :class:`DocumentMaskResult` with the output path and the flat
        ``{placeholder: original}`` registry.

    Raises:
        FileNotFoundError: If ``source`` does not exist.
        ValueError: If the suffix is not a supported document format.
    """
    src = _validate_source(source)
    dest_path = Path(dest).expanduser().resolve()
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    placeholder, registry, _seen, _counters = _make_placeholder_factory()
    segments = _Counter()

    def transform(text: str) -> str:
        masked = _mask_free_text_value(
            text, placeholder, span_provider,
            phone_anchor_boost=phone_anchor_boost,
        )
        if masked != text:
            segments.n += 1
        return masked

    binary = _apply_transform(src, dest_path, transform)

    return DocumentMaskResult(
        masked_file=dest_path,
        registry=registry,
        segments_masked=segments.n,
        is_binary=binary,
    )


def restore_document(
    masked_source: str | Path,
    registry: Mapping[str, str],
    dest: str | Path,
) -> DocumentRestoreResult:
    """Reverse :func:`mask_document` using a forward registry.

    Args:
        masked_source: Path to a masked document (same format as the output
            of :func:`mask_document`).
        registry: Forward registry ``{placeholder: original}``.
        dest: Path to write the restored document to.

    Returns:
        :class:`DocumentRestoreResult` describing the output and the
        replacement / unmatched-placeholder counts.
    """
    src = _validate_source(masked_source)
    dest_path = Path(dest).expanduser().resolve()
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    registry_map = dict(registry)
    counter = _Counter()
    unmatched: list[str] = []
    seen_unmatched: set[str] = set()

    def _sub(match) -> str:
        ph = f"<{match.group(1)}>"
        if ph in registry_map:
            counter.n += 1
            return str(registry_map[ph])
        if ph not in seen_unmatched:
            seen_unmatched.add(ph)
            unmatched.append(ph)
        return ph  # leave unknown placeholders untouched

    def transform(text: str) -> str:
        # Single-pass substitution against the ORIGINAL text: each placeholder
        # occurrence is replaced exactly once and substituted values are never
        # re-scanned (mirrors file_protection.restore.restore_text).
        return PLACEHOLDER_SCAN_PATTERN.sub(_sub, text)

    binary = _apply_transform(src, dest_path, transform)

    return DocumentRestoreResult(
        restored_file=dest_path,
        replacements=counter.n,
        unmatched=unmatched,
        is_binary=binary,
    )


# --------------------------------------------------------------------------
# Format dispatch
# --------------------------------------------------------------------------


class _Counter:
    """Tiny mutable int box so nested closures can increment a shared count."""

    __slots__ = ("n",)

    def __init__(self) -> None:
        self.n = 0


def _validate_source(source: str | Path) -> Path:
    p = Path(source).expanduser().resolve()
    if not p.exists():
        raise FileNotFoundError(f"Document not found: {p}")
    suffix = p.suffix.lower()
    if suffix not in SUPPORTED_DOCUMENT_SUFFIXES:
        raise ValueError(
            f"Unsupported document format: {suffix}. "
            f"Expected one of {SUPPORTED_DOCUMENT_SUFFIXES}"
        )
    return p


def _apply_transform(src: Path, dest: Path, transform: Transform) -> bool:
    """Run ``transform`` over every text segment of ``src`` into ``dest``.

    Returns ``True`` if the output is binary (docx), else ``False`` (text).
    """
    suffix = src.suffix.lower()
    if suffix in _DOCX_SUFFIXES:
        _transform_docx(src, dest, transform)
        return True
    if suffix in _HTML_SUFFIXES:
        _transform_html(src, dest, transform)
        return False
    _transform_text(src, dest, transform)
    return False


def _transform_text(src: Path, dest: Path, transform: Transform) -> None:
    """txt / md: the whole file is one text blob."""
    content = src.read_text(encoding="utf-8")
    dest.write_text(transform(content), encoding="utf-8")


def _transform_html(src: Path, dest: Path, transform: Transform) -> None:
    """html: mask visible text nodes only; leave tags/attributes intact."""
    from bs4 import BeautifulSoup
    from bs4.element import Comment, NavigableString

    soup = BeautifulSoup(src.read_text(encoding="utf-8"), "html.parser")

    for node in list(soup.find_all(string=True)):
        # Skip code/markup text and comments — they aren't prose.
        parent = node.parent
        if parent is not None and parent.name in _HTML_SKIP_TAGS:
            continue
        if isinstance(node, Comment):
            continue
        original = str(node)
        if not original.strip():
            continue
        rewritten = transform(original)
        if rewritten != original:
            node.replace_with(NavigableString(rewritten))

    dest.write_text(str(soup), encoding="utf-8")


def _transform_docx(src: Path, dest: Path, transform: Transform) -> None:
    """docx: mask run text across body, tables, headers, and footers.

    Masking at the run level preserves each run's character formatting. The
    trade-off: Word may split one logical value across several runs (e.g. a
    name where the first letter carries a different style), and a span that
    straddles a run boundary is not detected. This is an accepted limitation
    for structure preservation; the tabular / plain-text paths do not have it.
    """
    from docx import Document

    # docx is a ZIP archive; python-docx will happily open a decompression
    # bomb. Vet the archive shape before decompressing.
    check_zip_safety(src)
    doc = Document(str(src))

    def _mask_paragraphs(paragraphs) -> None:
        for para in paragraphs:
            for run in para.runs:
                if run.text:
                    run.text = transform(run.text)

    def _mask_tables(tables) -> None:
        for table in tables:
            for row in table.rows:
                for cell in row.cells:
                    _mask_paragraphs(cell.paragraphs)
                    _mask_tables(cell.tables)  # nested tables

    _mask_paragraphs(doc.paragraphs)
    _mask_tables(doc.tables)
    for section in doc.sections:
        _mask_paragraphs(section.header.paragraphs)
        _mask_paragraphs(section.footer.paragraphs)

    doc.save(str(dest))
