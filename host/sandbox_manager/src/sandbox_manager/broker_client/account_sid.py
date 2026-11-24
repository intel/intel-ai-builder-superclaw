"""Local account name to SID, for resolving a tier account from its derived name."""

from __future__ import annotations

import ctypes
import sys
from collections.abc import Callable

#: Looks one local account name up and returns its SID string, or None when no such account exists.
AccountSidLookup = Callable[[str], str | None]


def lookup_local_account_sid(name: str) -> str | None:
    """The SID of a local account by name, through ``LookupAccountNameW``, which any caller may use."""
    if sys.platform != "win32":
        return None
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi32.LookupAccountNameW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        ctypes.c_void_p,
        ctypes.POINTER(wintypes.DWORD),
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.DWORD),
    ]
    advapi32.LookupAccountNameW.restype = wintypes.BOOL
    advapi32.ConvertSidToStringSidW.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(wintypes.LPWSTR),
    ]
    advapi32.ConvertSidToStringSidW.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p

    sid_size = wintypes.DWORD(0)
    domain_size = wintypes.DWORD(0)
    use = wintypes.DWORD(0)
    advapi32.LookupAccountNameW(
        None,
        name,
        None,
        ctypes.byref(sid_size),
        None,
        ctypes.byref(domain_size),
        ctypes.byref(use),
    )
    if sid_size.value == 0:
        return None
    sid = ctypes.create_string_buffer(sid_size.value)
    domain = ctypes.create_unicode_buffer(max(domain_size.value, 1))
    if not advapi32.LookupAccountNameW(
        None,
        name,
        sid,
        ctypes.byref(sid_size),
        domain,
        ctypes.byref(domain_size),
        ctypes.byref(use),
    ):
        return None
    text = wintypes.LPWSTR()
    if not advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text)):
        return None
    try:
        return text.value
    finally:
        kernel32.LocalFree(text)
