"""Typed outcomes of one v1 import attempt, as the native start logs them."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from sandbox_manager.state_migration import ConflictOutcome, MigrationDecision


class V1ImportOutcome(StrEnum):
    SKIPPED = "skipped"
    IMPORTED = "imported"
    NOTHING_TO_IMPORT = "nothing_to_import"
    BLOCKED = "blocked"
    FAILED = "failed"


class V1ImportReason(StrEnum):
    NO_V1_INSTALL = "no_v1_install"
    LEDGER_COMPLETED = "ledger_completed"
    LEDGER_BLOCKED = "ledger_blocked"
    LEDGER_UNREADABLE = "ledger_unreadable"
    ATTEMPTS_EXHAUSTED = "attempts_exhausted"
    MIGRATION_ROOT_UNTRUSTED = "migration_root_untrusted"
    NATIVE_SESSIONS_EXIST = "native_sessions_exist"
    NATIVE_DATABASE_UNREADABLE = "native_database_unreadable"
    WSL_UNAVAILABLE = "wsl_unavailable"
    STAGING_UNCLEAN = "staging_unclean"
    DISTRO_NOT_STOPPED = "distro_not_stopped"
    COPY_OUT_FAILED = "copy_out_failed"
    COPY_OUT_TIMEOUT = "copy_out_timeout"
    SOURCE_TOO_LARGE = "source_too_large"
    UNSAFE_ARCHIVE = "unsafe_archive"
    SOURCE_ABSENT = "source_absent"
    SOURCE_DATABASE_INVALID = "source_database_invalid"
    STAGING_IO_FAILED = "staging_io_failed"
    SET_ASIDE_FAILED = "set_aside_failed"
    PROMOTE_FAILED = "promote_failed"
    LEDGER_WRITE_FAILED = "ledger_write_failed"
    UNEXPECTED_ERROR = "unexpected_error"


#: The first of these ends the import: each is a fact about the v1 volume, the native database or the
#: machine that the next start would find again. Every other failure is retried, up to
#: `adapter.MAX_FAILED_ATTEMPTS` starts.
FINAL_REASONS = frozenset(
    {
        V1ImportReason.NATIVE_SESSIONS_EXIST,
        V1ImportReason.WSL_UNAVAILABLE,
        V1ImportReason.SOURCE_TOO_LARGE,
        V1ImportReason.UNSAFE_ARCHIVE,
        V1ImportReason.SOURCE_ABSENT,
        V1ImportReason.SOURCE_DATABASE_INVALID,
    }
)


@dataclass(frozen=True)
class RewriteSummary:
    sessions: int
    rewritten: int
    unmapped: int
    credential_rows: int  # rows cleared from the imported copy


@dataclass(frozen=True)
class V1ImportResult:
    outcome: V1ImportOutcome
    reason: V1ImportReason | ConflictOutcome | MigrationDecision
    detail: str = ""
    summary: RewriteSummary | None = None
