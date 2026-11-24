"""Owner-side pruning of the role logs a tier runner writes.

A tier runner opens one log per launch and never deletes one: the shipped ACL policy gives a tier no
``DELETE`` and no ``FILE_DELETE_CHILD`` in its log subtree, deliberately, because retention is the
owner's work. That is what this module is - the owner's side of that arrangement, and nothing else.

What it will do is narrow on purpose:

* it looks only inside the per-tier subdirectories of a log root it was given, one level deep;
* it considers only regular files whose name is exactly the grammar a launcher can produce, which is
  published once as ``BROKER_ROLE_LOG_RULES`` and read here rather than restated;
* it refuses to follow a link and never removes a directory or an unrecognized file, so a planted
  entry is left alone rather than deleted - and that refusal covers the directories it was handed as
  well as the entries inside them, because scanning a directory that is itself a junction would delete
  inside the target;
* it deletes oldest-first until both bounds hold, and reports what it did.

``rotate_audit_log`` is the one exception to the name grammar, and it is just as narrow: the Connector
appends its audit to one fixed file in its tier directory and cannot rename or delete it either, so the
owner moves that one named file aside by size, over a single previous generation.

What it is not: a lifecycle step. Nothing in this build calls it. Wiring it into
``NativeBackendLifecycle`` belongs to product wiring, and it is separated for a reason worth keeping - a helper that
deletes files is much easier to reason about when its only inputs are a path and two bounds.

An uncalled pruner is not an unbounded log directory here, because nothing in this build launches a role
either: no product path calls a broker start, so the only role logs that exist are the ones tests write
into their own temporary trees. The first product-wiring change that launches a role is therefore the change that
must also call this - one stable filename becoming one file per launch is half a trade, and the call is
the other half. Role assembly and product wiring must preserve that retention requirement.

Nor is it a security control. A role log is tier self-report: the tier account creates the file, so it
owns it, and an object owner holds ``WRITE_DAC`` implicitly whatever the shipped DACL says. Deleting old
self-reports bounds disk use; it does not make the surviving ones evidence.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import time
from typing import Sequence

from contracts.broker_startup_catalog_data import BROKER_ROLE_LOG_RULES

#: The most log files kept in one tier's log directory, after which the oldest are removed.
#:
#: A file count, deliberately not a launch count. Each launch of each role writes one file into its
#: tier's directory, and the roles per tier are not equal: file_tool runs three of them - the runtime,
#: openwork-server and opencode-router - so one launch of the product leaves three files there, and this
#: bound therefore holds roughly a third as many launches for file_tool as for the other two tiers.
#:
#: That asymmetry is accepted rather than corrected. Correcting it would mean pruning per role, which
#: would mean the role appearing in the log's name - a change to the published name grammar that the Rust
#: writer and this reader would have to make together, for a bound whose only job is to stop a directory
#: growing without limit. A hundred files is far more than any support question needs either way, and a
#: role that fails immediately writes only a few hundred bytes, so the retained set stays small.
#:
#: The name says "files" for that reason: one that said "logs per tier" would read as a launch count and
#: disagree with the behaviour for the one tier where the difference shows.
MAX_RETAINED_LOG_FILES_PER_TIER = 100

#: The oldest a log may be, regardless of how few there are.
#:
#: Fourteen days is chosen to outlive a weekend plus a normal support round trip. The two bounds are
#: independent and both are enforced: a machine that launches constantly is bounded by the count, and one
#: that launched twice a year ago is bounded by the age.
MAX_LOG_AGE_SECONDS = 14 * 24 * 60 * 60

#: The size at which an audit log is moved aside before the next launch appends to it.
#:
#: One previous generation is kept, so a launch starts with at most twice this on disk. An audit line is a
#: few hundred bytes, so this holds tens of thousands of requests.
MAX_AUDIT_LOG_BYTES = 8 * 1024 * 1024

#: The exact file name a tier runner can produce, built from the published rules.
#:
#: Lowercase hexadecimal only, and anchored at both ends. The runner derives the stem from the random
#: pipe identifier of its own launch (``role_log.rs``), so this pattern is the whole set of names a
#: launcher could have written; anything else in the directory was put there by something else and is
#: not this module's to remove.
_LOG_NAME = re.compile(
    r"^[0-9a-f]{%d}%s$"
    % (
        int(BROKER_ROLE_LOG_RULES["launch_id_hex_chars"]),
        re.escape(str(BROKER_ROLE_LOG_RULES["extension"])),
    )
)

#: ``FILE_ATTRIBUTE_REPARSE_POINT``. Read from ``stat`` when available so the constant is the platform's.
_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


@dataclass(frozen=True)
class RetentionOutcome:
    """What one pruning pass did, per tier directory."""

    deleted: tuple[Path, ...] = ()
    #: What could not be pruned, with the reason: a file that matched the grammar and was selected but
    #: whose unlink failed - a role still holding it open on a filesystem that refuses the unlink, or a
    #: permission failure - or the tier directory itself, when it exists and could not be read at all.
    #: Reported rather than raised: a log that survives a pruning pass, or a tier that could not be
    #: scanned, is not a reason to fail whatever asked for the pass or to skip the remaining tiers.
    failed: tuple[tuple[Path, str], ...] = ()
    #: Entries left alone because they are not logs this launcher could have written.
    skipped: tuple[Path, ...] = ()

    @property
    def deleted_count(self) -> int:
        return len(self.deleted)


def prune_tier_logs(
    tier_log_directory: Path,
    *,
    max_files: int = MAX_RETAINED_LOG_FILES_PER_TIER,
    max_age_seconds: float = MAX_LOG_AGE_SECONDS,
    now: float | None = None,
) -> RetentionOutcome:
    """Enforce both bounds inside one tier's log directory.

    The directory is used as given and is never created: it is one the elevated provision step made,
    and a missing one means provisioning has not run, which is not something a pruning pass should
    paper over. A directory that does not exist yields an empty outcome rather than an error, because
    "no logs to prune" and "no directory yet" call for the same thing from a caller: nothing.

    A directory that exists and cannot be read is reported in ``failed`` rather than raised, so a caller
    pruning several tiers is not stopped by the one it has no rights on. So is a directory that is itself
    a junction or a symbolic link: ``scandir`` would follow it, and every unlink below would land in the
    target, which is the one thing this module must not do.
    """
    if max_files < 0:
        raise ValueError("max_files cannot be negative")
    if max_age_seconds <= 0:
        raise ValueError("max_age_seconds must be positive")
    moment = time.time() if now is None else now

    planted = _reparse_refusal(tier_log_directory)
    if planted is not None:
        return RetentionOutcome(failed=((tier_log_directory, planted),))

    candidates, skipped, unreadable = _classify(tier_log_directory)
    if unreadable is not None:
        return RetentionOutcome(failed=((tier_log_directory, unreadable),))
    # Oldest first, and by name for files that share a modification time, so a pass is deterministic
    # rather than dependent on directory order.
    candidates.sort(key=lambda candidate: (candidate[1], candidate[0].name))

    doomed = [
        path for path, modified in candidates if moment - modified > max_age_seconds
    ]
    aged_out = set(doomed)
    survivors = [path for path, _ in candidates if path not in aged_out]
    if len(survivors) > max_files:
        doomed.extend(survivors[: len(survivors) - max_files])

    deleted: list[Path] = []
    failed: list[tuple[Path, str]] = []
    for path in doomed:
        try:
            # `os.unlink` acts on the directory entry: if the entry were replaced by a link between the
            # scan and here, the link is what is removed, never whatever it points at. That is the whole
            # reason this is an unlink of a name rather than anything that opens the file first.
            os.unlink(path)
        except OSError as failure:
            failed.append((path, failure.strerror or failure.__class__.__name__))
        else:
            deleted.append(path)
    return RetentionOutcome(
        deleted=tuple(deleted), failed=tuple(failed), skipped=tuple(skipped)
    )


def prune_native_isolation_logs(
    logs_root: Path,
    tiers: Sequence[str],
    *,
    max_files: int = MAX_RETAINED_LOG_FILES_PER_TIER,
    max_age_seconds: float = MAX_LOG_AGE_SECONDS,
    now: float | None = None,
) -> dict[str, RetentionOutcome]:
    """Prune ``<logs_root>/<tier>`` for each named tier, and nothing else under the root.

    The tier list is a parameter rather than a constant here so this module needs no opinion about how
    many tiers there are; the caller has the isolation tiers it provisioned. A name that is not a single
    path component is refused rather than joined, so no caller can walk out of the log root through this
    function.

    The component check is spelled in Windows path semantics with ``PureWindowsPath``, deliberately. These
    are Windows paths whatever host the check runs on, and a backslash is a separator in exactly one of
    the two spellings: ``Path`` on a POSIX host would read ``..{sep}other`` as one ordinary file name and
    accept it. Using the Windows parser makes the refusal identical wherever it is evaluated, which is
    also what lets this be tested off Windows.

    The root is checked for a reparse point once, before any tier is joined onto it: a junction there
    would redirect every tier directory below it, and a per-tier check cannot see that, because the tier
    directory in the target is an ordinary directory. Every tier is then reported as failed for that one
    reason rather than silently pruned, and rather than raised, so the caller sees the same shape it sees
    for a tier it has no rights on.
    """
    outcomes: dict[str, RetentionOutcome] = {}
    redirected = _reparse_refusal(logs_root)
    for tier in tiers:
        if not tier or tier != PureWindowsPath(tier).name or tier in {".", ".."}:
            raise ValueError("a tier name must be a single path component")
        if redirected is not None:
            outcomes[tier] = RetentionOutcome(failed=((logs_root, redirected),))
            continue
        outcomes[tier] = prune_tier_logs(
            logs_root / tier,
            max_files=max_files,
            max_age_seconds=max_age_seconds,
            now=now,
        )
    return outcomes


def rotate_audit_log(path: Path, *, max_bytes: int = MAX_AUDIT_LOG_BYTES) -> bool:
    """Move ``path`` to ``<stem>.1<suffix>`` once it reaches ``max_bytes``; return whether it moved.

    Replacing the previous generation deletes it, so a directory that is a reparse point is refused the
    way a pruning pass refuses one, and so is an entry that is not a regular file. A missing file is
    nothing to rotate and nothing is created. A move that fails raises; the caller decides.
    """
    if _reparse_refusal(path.parent) is not None:
        return False
    try:
        info = os.lstat(path)
    except (FileNotFoundError, NotADirectoryError):
        return False
    if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & _REPARSE_POINT:
        return False
    if info.st_size < max_bytes:
        return False
    os.replace(path, path.with_name(f"{path.stem}.1{path.suffix}"))
    return True


def _reparse_refusal(directory: Path) -> str | None:
    """The reason a directory must not be scanned, or ``None``.

    ``os.lstat`` is the whole point: it describes the name rather than what the name points at, so a
    junction reports ``FILE_ATTRIBUTE_REPARSE_POINT`` here where ``stat`` would report the target's
    attributes and look ordinary. A missing path is not a refusal - ``prune_tier_logs`` treats a missing
    tier directory as nothing to prune, and deciding that twice in two places is how the two answers
    start to disagree.
    """
    try:
        info = os.lstat(directory)
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError as failure:
        return failure.strerror or failure.__class__.__name__
    if getattr(info, "st_file_attributes", 0) & _REPARSE_POINT or stat.S_ISLNK(info.st_mode):
        return "the directory is a reparse point, so it was not scanned"
    return None


def _classify(
    directory: Path,
) -> tuple[list[tuple[Path, float]], list[Path], str | None]:
    """Split one directory's entries into prunable logs and everything left alone.

    The third element is the reason the directory itself could not be read, or ``None``.
    """
    entries, unreadable = _entries(directory)
    if unreadable is not None:
        return [], [], unreadable
    candidates: list[tuple[Path, float]] = []
    skipped: list[Path] = []
    for entry in entries:
        path = Path(entry.path)
        if not _LOG_NAME.match(entry.name):
            skipped.append(path)
            continue
        try:
            # Never following the link is the point of `follow_symlinks=False`: a junction or symbolic
            # link planted under a log-shaped name must be classified as itself, not as its target.
            info = entry.stat(follow_symlinks=False)
        except OSError:
            skipped.append(path)
            continue
        reparse = getattr(info, "st_file_attributes", 0) & _REPARSE_POINT
        if not stat.S_ISREG(info.st_mode) or reparse or entry.is_symlink():
            skipped.append(path)
            continue
        candidates.append((path, info.st_mtime))
    return candidates, skipped, None


def _entries(directory: Path) -> tuple[list[os.DirEntry[str]], str | None]:
    """One directory's entries, or the reason it could not be read.

    A missing directory and a path that is not a directory are both "nothing to prune": provisioning has
    not run, or something replaced the tier directory with a file, and neither is a pruning pass's
    business to fix or to fail over.

    Everything else ``scandir`` can raise is a real failure and is returned as one - most plausibly a
    ``PermissionError`` from a partially provisioned tree or a log subtree whose DACL was written without
    list-directory for the owner. Returned rather than raised because ``prune_native_isolation_logs``
    walks several tiers: an exception here would abort the pass before the readable tiers were pruned,
    which is the opposite of what a caller wants from the one tier it cannot read.
    """
    try:
        with os.scandir(directory) as entries:
            return list(entries), None
    except (FileNotFoundError, NotADirectoryError):
        return [], None
    except OSError as failure:
        return [], failure.strerror or failure.__class__.__name__
