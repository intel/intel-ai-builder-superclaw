"""Handle-relative containment for managed native roots (stage C1).

Opens a managed root as a directory handle and walks each component via
``NtCreateFile`` with ``ObjectAttributes.RootDirectory``, so every open is a
direct child of a handle already held—not a kernel re-walk of a path string.

``open_managed_root`` refuses when ``GetFinalPathNameByHandleW`` disagrees with
the request (reject-only; see :func:`_names_equal`). Reparse points are opened
with ``FILE_OPEN_REPARSE_POINT`` and refused; the leaf is refused when its
hard-link count exceeds one. Held handles use read/list access without
delete-sharing to pin names for the context lifetime; ancestor handles used
during the walk are attributes-only and are not pinned.

Callers use verified handles from ``contain`` / :class:`ContainedEntry` and must
not reopen by ``final_path`` string—that is the race
:mod:`sandbox_manager.native_isolation.path_policy` cannot close.

Scope, accepted residuals, and change guardrails: ``README.md`` and
``AGENTS.md`` in this directory. Ownership: sandbox_manager (native mode only);
pure ctypes, no pywin32.
"""

from __future__ import annotations

import ctypes
import os
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from pathlib import PureWindowsPath

from .path_policy import (
    NativePathPolicyError,
    normalize_local_windows_path,
)


class NativeContainmentError(RuntimeError):
    """A managed-root open or containment check failed closed."""


_FILE_READ_DATA = 0x00000001
_FILE_WRITE_DATA = 0x00000002
_FILE_APPEND_DATA = 0x00000004
_FILE_READ_EA = 0x00000008
_FILE_WRITE_EA = 0x00000010
# FILE_TRAVERSE (0x20) is deliberately not defined: no mask here requests it.
_FILE_READ_ATTRIBUTES = 0x00000080
_FILE_WRITE_ATTRIBUTES = 0x00000100
_SYNCHRONIZE = 0x00100000

# Forced onto every open. Alone it's an attributes-only handle, outside share
# arbitration, so it pins nothing of its own object (NTFS's subtree rule still
# holds directories above it immobile regardless).
_ACCESS_IDENTITY = _FILE_READ_ATTRIBUTES | _SYNCHRONIZE

#: The ordinary read mask, and the default. Reads a contained file or enumerates a
#: contained directory: on Windows ``FILE_READ_DATA`` and ``FILE_LIST_DIRECTORY``
#: are the same bit, and it is that bit which engages share arbitration and so
#: makes the entry resist rename and delete.
ACCESS_READ = _FILE_READ_DATA | _FILE_READ_EA | _ACCESS_IDENTITY
#: Read and modify a contained object.
ACCESS_READ_WRITE = (
    ACCESS_READ
    | _FILE_WRITE_DATA
    | _FILE_APPEND_DATA
    | _FILE_WRITE_EA
    | _FILE_WRITE_ATTRIBUTES
)

# The read/list bit is the smallest that engages share arbitration, so it's
# what pins the root and every directory below it (plus identity). FILE_TRAVERSE
# is deliberately not requested: parse-time traversal is already waived by
# SeChangeNotifyPrivilege (see the module docstring), so it would buy nothing,
# while costing a refusal on an ACL that grants read but not execute.
_WALK_ACCESS = _FILE_READ_DATA | _ACCESS_IDENTITY

# What a directory we only pass *through* (every ancestor above the managed
# root) is asked for: attributes only, nothing more. FILE_TRAVERSE looks like
# the obvious choice but is wrong twice over: it would make the ancestor
# handle pin (denying renames/deletes up the whole tree for the walk's
# duration), and FILE_TRAVERSE arbitrates sharing the same as read access, so
# it would let any local process deny the walk by holding an ancestor open
# with no sharing. An attributes-only handle avoids both.
_SCREEN_ACCESS = _ACCESS_IDENTITY

# NTFS caps a single name at 255 UTF-16 code units. Enforcing it here keeps the
# name length that reaches NtCreateFile inside the USHORT that carries it.
_MAX_COMPONENT_UNITS = 255

_FILE_SHARE_READ = 0x00000001
_FILE_SHARE_WRITE = 0x00000002
# FILE_SHARE_DELETE is deliberately never requested. Allowing delete-sharing lets
# a verified object be renamed or deleted while its handle is held, which leaves
# the caller holding a proof about something no longer reachable at that name.
_SHARE_NO_DELETE = _FILE_SHARE_READ | _FILE_SHARE_WRITE

_OPEN_EXISTING = 3
_FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000

_FILE_OPEN = 1
_FILE_DIRECTORY_FILE = 0x00000001
_FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020
_FILE_OPEN_REPARSE_POINT = 0x00200000
_OBJ_CASE_INSENSITIVE = 0x00000040

_FILE_ATTRIBUTE_DIRECTORY = 0x00000010
_FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400

# FileFsDeviceInformation. Accept side is an allow-list (device types are
# open-ended) rather than a deny-list of known redirectors. FILE_REMOTE_DEVICE
# is checked too, so a device claiming local-disk while also flagged remote
# (as a WebDAV/cluster redirector can) is still refused.
_FILE_FS_DEVICE_INFORMATION_CLASS = 4
_FILE_DEVICE_DISK = 0x00000007
_FILE_REMOTE_DEVICE = 0x00000010

_FILE_NAME_NORMALIZED = 0x00000000
_VOLUME_NAME_DOS = 0x00000000
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
_MAX_FINAL_PATH_CHARS = 32768
_UNC_PREFIX = "\\\\?\\UNC\\"

# A byte count over UTF-16 code units is a property of the NT interface, so
# it's a constant rather than sizeof(c_wchar) (which describes the host build).
_UTF16_CODE_UNIT_BYTES = 2

# CompareStringOrdinal returns one of CSTR_LESS_THAN, CSTR_EQUAL, CSTR_GREATER_THAN,
# and zero for failure. Only equality matters here.
_CSTR_EQUAL = 2


if os.name == "nt":  # pragma: no branch - module is windows-oriented
    import ctypes.wintypes as wt

    class _FILETIME(ctypes.Structure):
        _fields_ = [("dwLowDateTime", wt.DWORD), ("dwHighDateTime", wt.DWORD)]

    class _BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("dwFileAttributes", wt.DWORD),
            ("ftCreationTime", _FILETIME),
            ("ftLastAccessTime", _FILETIME),
            ("ftLastWriteTime", _FILETIME),
            ("dwVolumeSerialNumber", wt.DWORD),
            ("nFileSizeHigh", wt.DWORD),
            ("nFileSizeLow", wt.DWORD),
            ("nNumberOfLinks", wt.DWORD),
            ("nFileIndexHigh", wt.DWORD),
            ("nFileIndexLow", wt.DWORD),
        ]

    class _UNICODE_STRING(ctypes.Structure):
        _fields_ = [
            ("Length", wt.USHORT),
            ("MaximumLength", wt.USHORT),
            ("Buffer", wt.LPWSTR),
        ]

    class _OBJECT_ATTRIBUTES(ctypes.Structure):
        _fields_ = [
            ("Length", wt.ULONG),
            ("RootDirectory", wt.HANDLE),
            ("ObjectName", ctypes.POINTER(_UNICODE_STRING)),
            ("Attributes", wt.ULONG),
            ("SecurityDescriptor", ctypes.c_void_p),
            ("SecurityQualityOfService", ctypes.c_void_p),
        ]

    class _IO_STATUS_BLOCK(ctypes.Structure):
        # The first member is a union of NTSTATUS and PVOID; we never read it,
        # because the Nt calls here return the status directly.
        _fields_ = [("Status", ctypes.c_void_p), ("Information", ctypes.c_size_t)]

    class _FILE_FS_DEVICE_INFORMATION(ctypes.Structure):
        _fields_ = [("DeviceType", wt.DWORD), ("Characteristics", wt.DWORD)]

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _ntdll = ctypes.WinDLL("ntdll", use_last_error=True)

    _kernel32.CreateFileW.restype = wt.HANDLE
    _kernel32.CreateFileW.argtypes = [
        wt.LPCWSTR,
        wt.DWORD,
        wt.DWORD,
        ctypes.c_void_p,
        wt.DWORD,
        wt.DWORD,
        wt.HANDLE,
    ]
    _kernel32.CloseHandle.restype = wt.BOOL
    _kernel32.CloseHandle.argtypes = [wt.HANDLE]
    _kernel32.GetFinalPathNameByHandleW.restype = wt.DWORD
    _kernel32.GetFinalPathNameByHandleW.argtypes = [
        wt.HANDLE,
        wt.LPWSTR,
        wt.DWORD,
        wt.DWORD,
    ]
    _kernel32.GetFileInformationByHandle.restype = wt.BOOL
    _kernel32.GetFileInformationByHandle.argtypes = [
        wt.HANDLE,
        ctypes.POINTER(_BY_HANDLE_FILE_INFORMATION),
    ]
    _kernel32.GetVolumeInformationByHandleW.restype = wt.BOOL
    _kernel32.GetVolumeInformationByHandleW.argtypes = [
        wt.HANDLE,
        wt.LPWSTR,
        wt.DWORD,
        ctypes.POINTER(wt.DWORD),
        ctypes.POINTER(wt.DWORD),
        ctypes.POINTER(wt.DWORD),
        wt.LPWSTR,
        wt.DWORD,
    ]
    _kernel32.CompareStringOrdinal.restype = ctypes.c_int
    _kernel32.CompareStringOrdinal.argtypes = [
        wt.LPCWSTR,
        ctypes.c_int,
        wt.LPCWSTR,
        ctypes.c_int,
        wt.BOOL,
    ]

    _ntdll.NtCreateFile.restype = ctypes.c_long
    _ntdll.NtCreateFile.argtypes = [
        ctypes.POINTER(wt.HANDLE),
        wt.ULONG,
        ctypes.POINTER(_OBJECT_ATTRIBUTES),
        ctypes.POINTER(_IO_STATUS_BLOCK),
        ctypes.c_void_p,
        wt.ULONG,
        wt.ULONG,
        wt.ULONG,
        wt.ULONG,
        ctypes.c_void_p,
        wt.ULONG,
    ]
    _ntdll.NtQueryVolumeInformationFile.restype = ctypes.c_long
    _ntdll.NtQueryVolumeInformationFile.argtypes = [
        wt.HANDLE,
        ctypes.POINTER(_IO_STATUS_BLOCK),
        ctypes.c_void_p,
        wt.ULONG,
        ctypes.c_int,
    ]
    _ntdll.RtlNtStatusToDosError.restype = wt.ULONG
    _ntdll.RtlNtStatusToDosError.argtypes = [ctypes.c_long]


class ContainedEntry:
    """A kernel-verified entry proven to lie inside its managed root.

    Use :attr:`handle` for the caller's work rather than reopening
    :attr:`final_path` by name, which would reintroduce the race this type
    exists to close. The handle is closed when the owning
    :meth:`ManagedRoot.contain` context exits; :attr:`handle` then refuses to
    return it, since Windows recycles handle numbers and a stale one could
    silently name an unrelated object.
    """

    def __init__(
        self,
        *,
        handle: int,
        final_path: PureWindowsPath,
        volume_serial: int,
        is_directory: bool,
    ) -> None:
        self._handle = handle
        self._final_path = final_path
        self._volume_serial = volume_serial
        self._is_directory = is_directory
        self._valid = True

    def _require_valid(self) -> None:
        """Refuse every observation once the containment context has exited.

        Not just the handle: once the context is gone nothing is pinned, so the
        recorded path, volume serial, and directory flag are all answers about
        an object that may no longer be there.
        """
        if not self._valid:
            raise NativeContainmentError(
                "the contained handle was closed when its containment context "
                "exited and must not be reused, and neither may what was observed "
                "through it"
            )

    @property
    def handle(self) -> int:
        """The verified handle, while its containment context is still open."""
        self._require_valid()
        return self._handle

    @property
    def final_path(self) -> PureWindowsPath:
        """Where the kernel reported this object at verification time."""
        self._require_valid()
        return self._final_path

    @property
    def volume_serial(self) -> int:
        """The serial of the volume this object was verified on."""
        self._require_valid()
        return self._volume_serial

    @property
    def is_directory(self) -> bool:
        """Whether the verified object is a directory."""
        self._require_valid()
        return self._is_directory

    def _invalidate(self) -> None:
        self._valid = False


class ManagedRoot:
    """An open managed-root directory handle plus its kernel-verified identity.

    Not safe to use from more than one thread, and deliberately not made so:
    handles are closed when their owning context exits, so a second thread
    holding one across that exit could reuse a handle number the kernel has
    already recycled - a use-after-close that no refusal can describe. This is
    a caller contract (confine a root and everything from it to one thread)
    rather than something locking could fix, since the lifetime is the
    caller's ``with`` block, not a call this class makes.
    """

    def __init__(
        self,
        *,
        handle: int,
        final_path: PureWindowsPath,
        volume_serial: int,
        filesystem: str,
    ) -> None:
        self._handle = handle
        self._final_path = final_path
        self._volume_serial = volume_serial
        self._filesystem = filesystem
        self._valid = True

    def _require_valid(self) -> None:
        if not self._valid:
            raise NativeContainmentError(
                "the managed root handle was closed when its context exited and "
                "must not be reused, and neither may what was observed through it"
            )

    @property
    def handle(self) -> int:
        """The open root directory handle, held to pin the root in place."""
        self._require_valid()
        return self._handle

    @property
    def final_path(self) -> PureWindowsPath:
        """The root's canonical location as the kernel reported it at open time."""
        self._require_valid()
        return self._final_path

    @property
    def volume_serial(self) -> int:
        """The root volume's serial number, used as an identity check."""
        self._require_valid()
        return self._volume_serial

    @property
    def filesystem(self) -> str:
        """The root volume's filesystem name, verified to be NTFS at open time."""
        self._require_valid()
        return self._filesystem

    @contextmanager
    def contain(
        self, relative: str, *, access: int = ACCESS_READ
    ) -> Iterator[ContainedEntry]:
        """Open ``relative`` below this root, component by component, by handle.

        Each component is opened relative to the handle for its parent, so no
        open can escape a directory this method has already inspected. Any
        reparse point, or a final component with more than one hard link,
        fails closed.

        ``access`` must lie within :data:`ACCESS_READ_WRITE` and include the
        read/list bit - see the module docstring for why. Use the returned
        handle directly rather than reopening the result by name.
        """
        _require_supported_access(access)
        components = _contained_components(relative)
        self._require_lexical_parity(components)
        with ExitStack() as stack:
            parent = self.handle
            for component in components[:-1]:
                handle = _open_relative(
                    parent, component, access=_WALK_ACCESS, directory=True
                )
                stack.callback(_close, handle)
                self._require_ordinary_directory(handle)
                parent = handle
            final = _open_relative(
                parent, components[-1], access=access, directory=False
            )
            stack.callback(_close, final)
            entry = self._verified_entry(final)
            stack.callback(entry._invalidate)
            yield entry

    def _require_lexical_parity(self, components: tuple[str, ...]) -> None:
        """Hold the tail to the same lexical policy the shared contract enforces.

        This is policy parity with Slice B, not the containment decision. The
        joined string is validated and then discarded; the opens below are
        handle-relative and never consume it. That is why building it from a
        possibly-stale root spelling is harmless here.
        """
        root = str(self._final_path).rstrip("\\")
        joined = root + "\\" + "\\".join(components)
        try:
            normalize_local_windows_path(joined)
        except NativePathPolicyError as exc:
            raise NativeContainmentError(
                "relative path is outside the managed lexical policy"
            ) from exc

    def _require_ordinary_directory(self, handle: int) -> None:
        """Refuse an intermediate component that is not a plain same-volume directory."""
        information = _file_information(handle)
        attributes = information.dwFileAttributes
        if attributes & _FILE_ATTRIBUTE_REPARSE_POINT:
            raise NativeContainmentError(
                "a component of the managed path is a reparse point, which is "
                "refused before it can be traversed"
            )
        if not attributes & _FILE_ATTRIBUTE_DIRECTORY:
            raise NativeContainmentError(
                "a component of the managed path is not a directory"
            )
        self._require_same_volume(information.dwVolumeSerialNumber)

    def _verified_entry(self, handle: int) -> ContainedEntry:
        information = _file_information(handle)
        attributes = information.dwFileAttributes
        if attributes & _FILE_ATTRIBUTE_REPARSE_POINT:
            raise NativeContainmentError(
                "opened object is a reparse point, which is refused in final position"
            )
        if information.nNumberOfLinks > 1:
            # A hard link is not a reparse point and reports the name it was
            # opened by, so no path-based check can see that the same file object
            # is also reachable from outside the root.
            raise NativeContainmentError(
                "opened object has more than one hard link, so its content is "
                "reachable under another name and cannot be contained"
            )
        self._require_same_volume(information.dwVolumeSerialNumber)

        # Defence in depth, reject-side only: the walk plus the pinning above
        # should already make a mismatch unreachable, so this exists to catch
        # a future relaxation of either. Comparing against the root's open-time
        # spelling is sound because the root is pinned for the whole context
        # and NTFS refuses to rename any directory with a handle open beneath
        # it, so nothing above holding this handle can move out from under the
        # recorded prefix. See :func:`_open_volume_root_by_path` for the
        # residuals in the one piece that's by-name: the drive letter itself.
        final_path = _final_path(handle)
        if not _path_within(self._final_path, final_path):
            raise NativeContainmentError(
                "opened object resolved outside its managed root"
            )
        return ContainedEntry(
            handle=handle,
            final_path=final_path,
            volume_serial=information.dwVolumeSerialNumber,
            is_directory=bool(attributes & _FILE_ATTRIBUTE_DIRECTORY),
        )

    def _require_same_volume(self, volume_serial: int) -> None:
        if volume_serial != self._volume_serial:
            raise NativeContainmentError(
                "opened object resolved onto a different volume than its root"
            )

    def _invalidate(self) -> None:
        self._valid = False


@contextmanager
def open_managed_root(path: str) -> Iterator[ManagedRoot]:
    """Open a managed root by handle and verify it is a containable directory.

    The root must be an existing directory on a local NTFS volume, must not
    itself be a reparse point, must be where the caller said it is, and must
    satisfy the shared lexical policy. It is held with directory-list access
    and without delete-sharing for the duration of the context, which is what
    stops it being renamed, deleted, or replaced underneath the caller.

    The path is never handed to the kernel to resolve as a string; see
    :func:`_open_verified_root` for the handle-relative walk. Callers must
    hand over a canonical long-name path: a root reached through a redirected
    ancestor, a ``subst`` drive, or an 8.3 alias is refused rather than
    silently accepted at wherever it led.
    """
    normalized = _require_containable_root(path)
    handle = _open_verified_root(normalized)
    root: ManagedRoot | None = None
    try:
        information = _file_information(handle)
        attributes = information.dwFileAttributes
        if not attributes & _FILE_ATTRIBUTE_DIRECTORY:
            raise NativeContainmentError("managed root is not a directory")
        if attributes & _FILE_ATTRIBUTE_REPARSE_POINT:
            raise NativeContainmentError("managed root is itself a reparse point")
        _require_local_disk_volume(handle)
        filesystem = _filesystem_name(handle)
        if not _names_equal(filesystem, "NTFS"):
            # Compared with the kernel's case table, not str.upper(): this is on
            # the *accept* side, and "NTFſ".upper() == "NTFS" would let a wrong
            # filesystem name fold through the gate - the unsafe direction.
            raise NativeContainmentError(
                f"managed root volume must be NTFS, not {filesystem}"
            )
        resolved = _final_path(handle)
        if not _names_equal(str(normalized), str(resolved)):
            # Not a sign the walk was tricked - it refused every reparse point
            # on the way. Known causes: a subst drive or 8.3 alias resolving to
            # a real path the walk was happy to reach, or an ancestor moved
            # while the walk was below it. All three leave the handle at a path
            # other than the one requested; see the module docstring's residual
            # list. This comparison only rejects, never accepts - see there for
            # why it no longer decides identity on its own.
            raise NativeContainmentError(
                "managed root resolved somewhere other than the path requested, so it "
                "cannot be verified at the path it was named by"
            )
        root = ManagedRoot(
            handle=handle,
            final_path=resolved,
            volume_serial=information.dwVolumeSerialNumber,
            filesystem=filesystem,
        )
        yield root
    finally:
        if root is not None:
            root._invalidate()
        _close(handle)


def _require_local_disk_volume(handle: int) -> None:
    """Refuse a managed root that is not on a local disk device.

    The filesystem-name gate doesn't answer this: an SMB share backed by NTFS
    still reports ``NTFS``. What makes a redirected volume unsuitable is that
    reparse and identity semantics over a redirector aren't the ones this
    module reasons about - the volume serial is the redirector's own, and an
    oplock rather than share arbitration governs what another client may do to
    a "pinned" object. The requested-vs-resolved comparison already refuses a
    mapped letter incidentally, since the kernel spells it as a UNC path, but
    that's a coincidental side effect rather than a real boundary, hence this
    dedicated, explicitly-named gate.

    Reaching a remote volume this way needs no special privilege: this
    account can reach the default ``C$`` administrative share (mapped
    unelevated, no share created) purely via the ``INTERACTIVE`` group every
    interactively logged-on account carries, independent of Administrators
    group membership.
    """
    device_type, characteristics = _volume_device(handle)
    if device_type != _FILE_DEVICE_DISK:
        raise NativeContainmentError(
            "managed root volume must be a local disk device, not device type "
            f"{device_type:#x}"
        )
    if characteristics & _FILE_REMOTE_DEVICE:
        raise NativeContainmentError(
            "managed root volume is reached through a redirector, which is refused"
        )


def _require_containable_root(path: str) -> PureWindowsPath:
    """Refuse a root this module cannot contain, before any handle is opened."""
    if os.name != "nt":
        raise NativeContainmentError(
            "handle-based containment is available only on Windows"
        )
    if _has_surrogate(path):
        # Not the security guard (that's _final_path, on the kernel's own
        # spelling) - this keeps the caller's unencodable text out of the
        # refusal *message* itself. Without it, a nonexistent root would fail
        # in the walk with a NativeContainmentError whose own message
        # interpolates the unencodable component and can't be logged.
        raise NativeContainmentError(
            "managed root path is not encodable text, so it cannot be contained"
        )
    try:
        return normalize_local_windows_path(path)
    except NativePathPolicyError as exc:
        raise NativeContainmentError(
            "managed root must be a canonical absolute local Windows path"
        ) from exc


def _require_supported_access(access: int) -> None:
    """Refuse a mask this module is not prepared to hand out.

    Bits outside :data:`ACCESS_READ_WRITE` would let a caller quietly obtain
    rights like ``DELETE`` or ``WRITE_DAC`` through a primitive whose purpose
    is containment. The floor requires the read/list bit specifically for
    readability, not pinning: a proof about a path is no use to a caller that
    can't read what it contained. That this same bit happens to be what
    engages share arbitration (and so pins) is a side effect, not the reason
    it's required - a write-only mask would pin too and is refused anyway.
    """
    if access & ~ACCESS_READ_WRITE:
        raise NativeContainmentError(
            "requested access is outside the masks this module hands out"
        )
    if not access & _FILE_READ_DATA:
        raise NativeContainmentError(
            "requested access must include the read/list bit, because a proof about "
            "a path is no use to a caller that cannot read what the path contained; "
            "it is also the bit this module pins with"
        )


def _contained_components(relative: str) -> tuple[str, ...]:
    """Split a strictly relative tail into single components, or fail closed.

    Splits on the caller's own text rather than ``PureWindowsPath`` parts,
    because ``PureWindowsPath`` silently drops ``.`` segments and collapses
    repeated separators - which would accept a tail whose text doesn't match
    the components the walk actually opens, one per relative open.
    """
    if not relative:
        raise NativeContainmentError("relative path must not be empty")
    if "/" in relative:
        raise NativeContainmentError("relative path must use backslash separators")
    if "\x00" in relative:
        raise NativeContainmentError("relative path must not contain NUL")
    candidate = PureWindowsPath(relative)
    if candidate.is_absolute() or candidate.drive or candidate.root:
        raise NativeContainmentError("relative path must not be absolute or rooted")
    components = tuple(relative.split("\\"))
    for component in components:
        if not component:
            raise NativeContainmentError(
                "relative path must not contain an empty component"
            )
        if component in (".", ".."):
            raise NativeContainmentError("relative path must not contain traversal")
        if ":" in component:
            # A relative NT open accepts "file.txt::$DATA" and reports a clean
            # final path for the stream, passing every identity check above.
            raise NativeContainmentError(
                "relative path must not name a data stream or a drive"
            )
        if _has_surrogate(component):
            raise NativeContainmentError(
                "relative path component is not encodable text, so it cannot be "
                "contained"
            )
        _require_nameable_length(component, "a relative path component")
    return components


def _has_surrogate(text: str) -> bool:
    """Whether a name carries a surrogate code point at all.

    NTFS stores names as unchecked UTF-16, so an adversary can create a file
    with an unpaired surrogate in its name - not valid text, since it has no
    UTF-8 encoding. Refusing it here keeps the failure inside
    :class:`NativeContainmentError` instead of a ``UnicodeError`` escaping from
    the encoding arithmetic further down.

    This is only the predicate; the security-relevant call is on
    :func:`_final_path`'s (the kernel's) spelling, not the caller's - calling
    this on caller-supplied text just keeps a refusal message readable.
    """
    return any(0xD800 <= ord(character) <= 0xDFFF for character in text)


def _require_nameable_length(component: str, subject: str) -> int:
    """Refuse a component longer than a filesystem name may be, and return its length.

    Shared by :func:`_contained_components` and :func:`_open_relative` so the
    number compared and the number later used can't drift apart - the latter
    needs it because the length passed to ``NtCreateFile`` must fit the
    ``USHORT`` carrying it. NTFS itself caps names at this length, so nothing
    legitimate is refused.
    """
    units = _utf16_units(component)
    if units > _MAX_COMPONENT_UNITS:
        raise NativeContainmentError(
            f"{subject} is longer than a filesystem name may be: "
            f"{units} UTF-16 code units"
        )
    return units


def _utf16_units(text: str) -> int:
    """Count UTF-16 code units, which is what the NT name length is measured in.

    ``len`` counts code points, so it undercounts any character outside the basic
    multilingual plane by one unit per surrogate pair. ``surrogatepass`` keeps this
    total for every ``str`` Windows can hand back, so the count never raises where
    a refusal is what the caller is owed.
    """
    return len(text.encode("utf-16-le", "surrogatepass")) // _UTF16_CODE_UNIT_BYTES


def _open_verified_root(normalized: PureWindowsPath) -> int:
    """Walk to the managed root from its volume root, one handle at a time.

    The path is never resolved by the kernel as a string: the volume root is
    opened by name (see :func:`_open_volume_root_by_path`), and every
    component after that opens relative to the handle before it, refusing
    reparse points and non-directories on the way. The handle is by
    construction the object reachable from the volume root by exactly the
    names the caller wrote.

    This sidesteps a question that has no general answer on NTFS: whether two
    *spellings* name the same object. Case sensitivity is per-directory
    (``fsutil file setCaseSensitiveInfo``, no privilege needed), so a junction
    named as a case twin of a real directory can make requested and resolved
    spellings compare equal while pointing elsewhere - a walk avoids this
    because each step opens a handle already held, needing no case comparison
    at all.

    Ancestor handles use :data:`_SCREEN_ACCESS` (attributes-only, outside
    share arbitration) and are closed together via ``ExitStack`` when the walk
    ends or fails. The root's own handle is opened with the pinning access and
    is the caller's to close.
    """
    components = normalized.parts[1:]
    if not components:
        # A check, not an assumption: this function takes a path rather than a
        # policy decision, so a readable refusal is worth the one branch even
        # though open_managed_root's lexical policy already refuses a bare
        # drive root before this is reached.
        raise NativeContainmentError(
            "a managed root path must name a directory below a volume root"
        )
    with ExitStack() as ancestors:
        handle = _open_volume_root_by_path(normalized.anchor)
        ancestors.callback(_close, handle)
        _require_ancestor_directory(handle, normalized.anchor)
        for component in components[:-1]:
            handle = _open_relative(
                handle, component, access=_SCREEN_ACCESS, directory=True
            )
            ancestors.callback(_close, handle)
            _require_ancestor_directory(handle, component)
        # directory=False here is deliberate: FILE_DIRECTORY_FILE would refuse
        # a root that turns out to be a file with a component-level message;
        # open_managed_root checks the attribute itself and says what's wrong.
        return _open_relative(
            handle, components[-1], access=_WALK_ACCESS, directory=False
        )


def _require_ancestor_directory(handle: int, spelling: str) -> None:
    """Refuse a directory above the managed root that must not be walked through.

    The ancestor counterpart of :meth:`ManagedRoot._require_ordinary_directory`,
    kept separate because there's no root yet to check same-volume against.
    ``spelling`` is the caller's own already-screened text, interpolated only
    to say which ancestor a refusal was about.
    """
    information = _file_information(handle)
    attributes = information.dwFileAttributes
    if attributes & _FILE_ATTRIBUTE_REPARSE_POINT:
        raise NativeContainmentError(
            "a directory above the managed root is a reparse point, which is refused "
            f"before it can be traversed: {spelling}"
        )
    if not attributes & _FILE_ATTRIBUTE_DIRECTORY:
        raise NativeContainmentError(
            f"a component above the managed root is not a directory: {spelling}"
        )


def _open_volume_root_by_path(anchor: str) -> int:
    """Open the volume root a requested path names, the one path-based open here.

    Every other open in this module is relative to a handle; this one can't
    be, since the walk has to start somewhere. It's the by-name open with the
    least left to redirect - no ancestor to stand in for, and its own final
    component is a drive letter the lexical policy already required - but the
    drive letter itself is still redirectable.

    A drive letter is not a volume: ``subst`` can map one onto an ordinary
    directory, and a per-session DOS device map (``DefineDosDevice``, no
    privilege needed) can repoint a letter for any code running in this
    session. Nothing here detects that; it's :func:`open_managed_root`'s
    requested-vs-resolved comparison that refuses it, because
    ``GetFinalPathNameByHandleW`` names the volume from the mount manager's
    *global* view rather than the session-local device map, so a
    session-local redirection cannot come back looking like the request.

    A *global* letter is a different matter and is reachable unelevated too -
    e.g. mounting an ISO adds one with no privilege - but what refuses that
    root is the volume-type gate (:func:`_require_local_disk_volume`), not the
    device map. Getting a letter onto an arbitrary local NTFS volume without
    elevation is an open, undefended residual worth tracking; see the module
    docstring's residual list for the class of problem this belongs to
    (placement is C2's).

    Asked for :data:`_SCREEN_ACCESS`, like every other ancestor.
    """
    handle = _kernel32.CreateFileW(
        anchor,
        _SCREEN_ACCESS,
        _SHARE_NO_DELETE,
        None,
        _OPEN_EXISTING,
        _FILE_FLAG_BACKUP_SEMANTICS | _FILE_FLAG_OPEN_REPARSE_POINT,
        None,
    )
    if handle is None or handle == _INVALID_HANDLE_VALUE:
        error = ctypes.get_last_error()
        raise NativeContainmentError(
            f"failed to open the volume root of a managed root path: {anchor}"
        ) from ctypes.WinError(error)
    return handle


def _open_relative(parent: int, component: str, *, access: int, directory: bool) -> int:
    """Open one component as a direct child of ``parent``, never following a link.

    The component is handed to the object manager as a name relative to
    ``parent``, so this call cannot reach anything else: no path string for
    the kernel to re-walk, no ancestor to revisit.
    """
    # Bounded before use so it always fits the USHORT NtCreateFile takes; an
    # unbounded length would fail silently by having the kernel resolve a
    # truncated (different) name instead.
    units = _require_nameable_length(component, "a path component")
    name = ctypes.create_unicode_buffer(component)
    byte_length = units * _UTF16_CODE_UNIT_BYTES
    object_name = _UNICODE_STRING(
        Length=byte_length,
        MaximumLength=byte_length + _UTF16_CODE_UNIT_BYTES,
        Buffer=ctypes.cast(name, wt.LPWSTR),
    )
    attributes = _OBJECT_ATTRIBUTES(
        Length=ctypes.sizeof(_OBJECT_ATTRIBUTES),
        RootDirectory=parent,
        ObjectName=ctypes.pointer(object_name),
        Attributes=_OBJ_CASE_INSENSITIVE,
        SecurityDescriptor=None,
        SecurityQualityOfService=None,
    )
    options = _FILE_SYNCHRONOUS_IO_NONALERT | _FILE_OPEN_REPARSE_POINT
    if directory:
        options |= _FILE_DIRECTORY_FILE

    handle = wt.HANDLE()
    status_block = _IO_STATUS_BLOCK()
    status = _ntdll.NtCreateFile(
        ctypes.byref(handle),
        access | _ACCESS_IDENTITY,
        ctypes.byref(attributes),
        ctypes.byref(status_block),
        None,
        0,
        _SHARE_NO_DELETE,
        _FILE_OPEN,
        options,
        None,
        0,
    )
    if status < 0:
        raise NativeContainmentError(
            f"failed to open managed component relative to its parent: {component}"
        ) from ctypes.WinError(_ntdll.RtlNtStatusToDosError(status))
    return handle.value


def _final_path(handle: int) -> PureWindowsPath:
    """Ask the kernel where a handle actually points.

    Every spelling this module reports or compares that came from a *directory
    entry* comes from here - the ones an adversary inside a root owns - which
    is why this is where the reported text is required to be a local,
    encodable path.
    """
    flags = _FILE_NAME_NORMALIZED | _VOLUME_NAME_DOS
    # Sized first: with no buffer this returns the required length *including*
    # the terminating NUL, while a successful write returns the length
    # *excluding* it. Zero is the only failure signal.
    required = _kernel32.GetFinalPathNameByHandleW(handle, None, 0, flags)
    if required == 0:
        raise NativeContainmentError(
            "failed to size the final path of a managed handle"
        ) from ctypes.WinError(ctypes.get_last_error())
    if required > _MAX_FINAL_PATH_CHARS:
        raise NativeContainmentError("resolved final path is implausibly long")

    buffer = ctypes.create_unicode_buffer(required)
    written = _kernel32.GetFinalPathNameByHandleW(handle, buffer, required, flags)
    if written == 0:
        raise NativeContainmentError(
            "failed to resolve the final path of a managed handle"
        ) from ctypes.WinError(ctypes.get_last_error())
    if written >= required:
        # A successful write is always below `required` (which includes the
        # NUL the write's return value excludes), so reaching this means the
        # path grew between the sizing call and the read.
        raise NativeContainmentError(
            "the final path of a managed handle grew while it was being read"
        ) from ctypes.WinError(ctypes.get_last_error())

    resolved = buffer.value
    if _has_surrogate(resolved):
        # The kernel reports the *true* name, which an adversary inside the
        # root owns, so screening only the caller's request isn't enough: an
        # 8.3 alias can reach a directory named with a surrogate through an
        # entirely ASCII request. Guarding here covers root, intermediates,
        # and entry alike, since every one of their spellings comes through
        # this call.
        raise NativeContainmentError(
            "kernel-reported path is not encodable text, so it cannot be contained"
        )
    if resolved.upper().startswith(_UNC_PREFIX.upper()):
        raise NativeContainmentError(
            "managed paths must be local; UNC and redirected paths are refused"
        )
    try:
        return normalize_local_windows_path(resolved)
    except NativePathPolicyError as exc:
        raise NativeContainmentError(
            "kernel-reported final path is outside the managed lexical policy"
        ) from exc


def _names_equal(left: str, right: str) -> bool:
    """Decide whether two spellings name one object, using the kernel's case table.

    Deliberately neither string equality nor the lexical layer's
    :func:`~.path_policy.paths_equal`: this is a filesystem question, so it
    needs the filesystem's own case table (``CompareStringOrdinal``, the
    kernel's ordinal table, which NTFS volumes are formatted to agree with).
    Python's ``str.lower`` folds pairs NTFS keeps distinct - e.g. the Kelvin
    sign U+212A onto ``k`` - 199 BMP characters differ from the kernel's table
    this way, which previously let a junction spelled as such a twin redirect
    a root while comparing equal to the request. Folding only ASCII isn't the
    fix either, since it would then wrongly refuse ``É`` against the ``é``
    NTFS treats as one name.

    Lengths come from :func:`_utf16_units`, not ``len``: a code-point count
    silently turns this into a prefix comparison for any astral character.
    """
    result = _kernel32.CompareStringOrdinal(
        left, _utf16_units(left), right, _utf16_units(right), True
    )
    if result == 0:
        # Only a bad argument fails this call - a caller-contract error, not a
        # false comparison result. Fail closed.
        error = ctypes.get_last_error()
        raise NativeContainmentError(
            "failed to compare a managed path spelling against the kernel's"
        ) from ctypes.WinError(error)
    return result == _CSTR_EQUAL


def _path_within(root: PureWindowsPath, candidate: PureWindowsPath) -> bool:
    """Whether *candidate* is *root* or lies beneath it, by the same case table.

    Compares whole components, so a name merely sharing a prefix with the root
    (``root-escape`` vs ``root``) cannot pass as being inside it. Defence in
    depth: every path this guards is already refused by the walk itself.
    """
    root_parts = root.parts
    candidate_parts = candidate.parts
    if not root_parts:
        # Refused, not vacuously accepted (all() over nothing is True) -
        # unreachable through this module's normalized paths regardless.
        return False
    if len(candidate_parts) < len(root_parts):
        return False
    return all(
        _names_equal(expected, actual)
        for expected, actual in zip(root_parts, candidate_parts, strict=False)
    )


def _file_information(handle: int) -> _BY_HANDLE_FILE_INFORMATION:
    information = _BY_HANDLE_FILE_INFORMATION()
    if not _kernel32.GetFileInformationByHandle(handle, ctypes.byref(information)):
        error = ctypes.get_last_error()
        raise NativeContainmentError(
            "failed to read file information for a managed handle"
        ) from ctypes.WinError(error)
    return information


def _volume_device(handle: int) -> tuple[int, int]:
    """The device type and characteristics of the volume a handle lives on.

    Asked of the handle, not a path, so it describes the object the walk
    actually reached. No Win32 equivalent takes a handle - ``GetDriveTypeW``
    takes a path, which would reintroduce by-name resolution mid-walk.
    """
    status_block = _IO_STATUS_BLOCK()
    information = _FILE_FS_DEVICE_INFORMATION()
    status = _ntdll.NtQueryVolumeInformationFile(
        handle,
        ctypes.byref(status_block),
        ctypes.byref(information),
        ctypes.sizeof(information),
        _FILE_FS_DEVICE_INFORMATION_CLASS,
    )
    if status < 0:
        raise NativeContainmentError(
            "failed to read volume device information for a managed handle"
        ) from ctypes.WinError(_ntdll.RtlNtStatusToDosError(status))
    return information.DeviceType, information.Characteristics


def _filesystem_name(handle: int) -> str:
    buffer = ctypes.create_unicode_buffer(64)
    if not _kernel32.GetVolumeInformationByHandleW(
        handle, None, 0, None, None, None, buffer, len(buffer)
    ):
        error = ctypes.get_last_error()
        raise NativeContainmentError(
            "failed to read volume information for a managed handle"
        ) from ctypes.WinError(error)
    return buffer.value


def _close(handle: int) -> None:
    # A CloseHandle failure here is unactionable: the handle is either already
    # gone or invalid, and there is no recovery either way. Callers have had
    # their access revoked by the surrounding invalidation regardless.
    _kernel32.CloseHandle(handle)
