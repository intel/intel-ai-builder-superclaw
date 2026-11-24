"""Windows' own PAC/WPAD evaluation for the egress proxy, through ctypes (design D4, EG2-2).

`WinHttpGetProxyForUrlEx` keeps what the script returned in order, DIRECT fallbacks included, so the proxy
can honour `PROXY a:1; PROXY b:2; DIRECT` as written; the older `WinHttpGetProxyForUrl` flattens it to the
proxies. The Ex call is used first, the older one only where the Ex API is missing. Windows fetches the
script itself, as whatever account this process runs as: that fetch is egress.

Errors are codes only: the URL names the PAC host and a script URL may carry a credential.

Windows only; imported lazily by `pac_resolver.winhttp_evaluator`.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import itertools
import logging
import threading

from .pac_resolver import PAC_EVALUATION_TIMEOUT_S, PacConfig, PacError

logger = logging.getLogger(__name__)

_FLAG_ASYNC = 0x10000000
_ACCESS_TYPE_NO_PROXY, _ACCESS_TYPE_NAMED_PROXY = 1, 3
_AUTOPROXY_AUTO_DETECT, _AUTOPROXY_CONFIG_URL = 0x1, 0x2
_DETECT_DHCP, _DETECT_DNS_A = 0x1, 0x2
_CALLBACK_GETPROXYFORURL_COMPLETE = 0x01000000
_CALLBACK_REQUEST_ERROR = 0x00200000
_ERROR_IO_PENDING = 997
_ERROR_TIMEOUT = 12002
_ERROR_AUTODETECTION_FAILED = 12180
_SCHEME_KEYWORDS = {1: "PROXY", 2: "HTTPS", 4: "SOCKS"}


class _Options(ctypes.Structure):
    _fields_ = [
        ("dwFlags", wintypes.DWORD),
        ("dwAutoDetectFlags", wintypes.DWORD),
        ("lpszAutoConfigUrl", wintypes.LPCWSTR),
        ("lpvReserved", ctypes.c_void_p),
        ("dwReserved", wintypes.DWORD),
        ("fAutoLogonIfChallenged", wintypes.BOOL),
    ]


class _Info(ctypes.Structure):
    _fields_ = [
        ("dwAccessType", wintypes.DWORD),
        ("lpszProxy", ctypes.c_void_p),
        ("lpszProxyBypass", ctypes.c_void_p),
    ]


class _ResultEntry(ctypes.Structure):
    _fields_ = [
        ("fProxy", wintypes.BOOL),
        ("fBypass", wintypes.BOOL),
        ("ProxyScheme", ctypes.c_int),
        ("pwszProxy", ctypes.c_void_p),
        ("ProxyPort", wintypes.WORD),
    ]


class _Result(ctypes.Structure):
    _fields_ = [("cEntries", wintypes.DWORD), ("pEntries", ctypes.POINTER(_ResultEntry))]


class _AsyncResult(ctypes.Structure):
    _fields_ = [("dwResult", ctypes.c_size_t), ("dwError", wintypes.DWORD)]


_CALLBACK = ctypes.WINFUNCTYPE(
    None, ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD
)


class WinHttpEvaluator:
    """Evaluates the owner's PAC/WPAD setting for a URL; safe to call from several threads."""

    def __init__(self) -> None:
        self._winhttp = ctypes.WinDLL("winhttp", use_last_error=True)  # type: ignore[attr-defined]
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        w = self._winhttp
        w.WinHttpOpen.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                  wintypes.DWORD]
        w.WinHttpOpen.restype = ctypes.c_void_p
        w.WinHttpSetTimeouts.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                         ctypes.c_int]
        w.WinHttpSetTimeouts.restype = wintypes.BOOL
        w.WinHttpCloseHandle.argtypes = [ctypes.c_void_p]
        w.WinHttpCloseHandle.restype = wintypes.BOOL
        w.WinHttpGetProxyForUrl.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(_Options),
                                            ctypes.POINTER(_Info)]
        w.WinHttpGetProxyForUrl.restype = wintypes.BOOL
        self._kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
        self._kernel32.GlobalFree.restype = ctypes.c_void_p
        self._has_ex = all(
            hasattr(w, name)
            for name in ("WinHttpCreateProxyResolver", "WinHttpGetProxyForUrlEx", "WinHttpGetProxyResult",
                         "WinHttpFreeProxyResult", "WinHttpSetStatusCallback")
        )
        if self._has_ex:
            w.WinHttpCreateProxyResolver.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
            w.WinHttpCreateProxyResolver.restype = wintypes.DWORD
            w.WinHttpSetStatusCallback.argtypes = [ctypes.c_void_p, _CALLBACK, wintypes.DWORD,
                                                   ctypes.c_size_t]
            w.WinHttpSetStatusCallback.restype = ctypes.c_void_p
            w.WinHttpGetProxyForUrlEx.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR,
                                                  ctypes.POINTER(_Options), ctypes.c_size_t]
            w.WinHttpGetProxyForUrlEx.restype = wintypes.DWORD
            w.WinHttpGetProxyResult.argtypes = [ctypes.c_void_p, ctypes.POINTER(_Result)]
            w.WinHttpGetProxyResult.restype = wintypes.DWORD
            w.WinHttpFreeProxyResult.argtypes = [ctypes.POINTER(_Result)]
            w.WinHttpFreeProxyResult.restype = None
        self._lock = threading.Lock()
        self._sessions: dict[int, int] = {}
        self._pending: dict[int, tuple[threading.Event, list[int]]] = {}
        self._ids = itertools.count(1)
        # One module-lifetime callback: Windows may call it after a resolver was closed.
        self._callback = _CALLBACK(self._on_status)

    def proxy_for_url(self, url: str, config: PacConfig) -> str:
        """The script's list as PAC text (`PROXY a:1; DIRECT`), or `DIRECT`; raises `PacError`."""
        options = self._options(config)
        if self._has_ex:
            return self._with_resolver(url, options)
        return self._flattened(url, options)

    def _options(self, config: PacConfig) -> _Options:
        flags = (_AUTOPROXY_AUTO_DETECT if config.auto_detect else 0) | (
            _AUTOPROXY_CONFIG_URL if config.auto_config_url else 0
        )
        return _Options(
            flags,
            _DETECT_DHCP | _DETECT_DNS_A if config.auto_detect else 0,
            config.auto_config_url,
            None,
            0,
            True,
        )

    def _session(self, flags: int) -> int:
        with self._lock:
            if flags not in self._sessions:
                session = self._winhttp.WinHttpOpen(None, _ACCESS_TYPE_NO_PROXY, None, None, flags)
                if not session:
                    # Code only: the URL names the PAC host and a script URL may carry a credential.
                    logger.warning(
                        "pac-winhttp: call=WinHttpOpen failed error=%s", ctypes.get_last_error()
                    )
                    raise PacError("pac_failed")
                # Resolve, connect, send, receive: these bound the script download.
                half = int(PAC_EVALUATION_TIMEOUT_S * 1000 / 2)
                self._winhttp.WinHttpSetTimeouts(session, half, half, half, half)
                self._sessions[flags] = session
            return self._sessions[flags]

    def _on_status(self, _handle: int, context: int, status: int, info: int, _length: int) -> None:
        with self._lock:
            pending = self._pending.get(context)
        if pending is None:
            return
        event, outcome = pending
        if status == _CALLBACK_GETPROXYFORURL_COMPLETE:
            outcome.append(0)
            event.set()
        elif status == _CALLBACK_REQUEST_ERROR:
            outcome.append(ctypes.cast(info, ctypes.POINTER(_AsyncResult)).contents.dwError or 1)
            event.set()

    def _with_resolver(self, url: str, options: _Options) -> str:
        w = self._winhttp
        resolver = ctypes.c_void_p()
        error = w.WinHttpCreateProxyResolver(self._session(_FLAG_ASYNC), ctypes.byref(resolver))
        if error:
            logger.warning("pac-winhttp: call=WinHttpCreateProxyResolver failed error=%s", error)
            raise PacError("pac_failed")
        context = next(self._ids)
        event, outcome = threading.Event(), []
        with self._lock:
            self._pending[context] = (event, outcome)
        try:
            w.WinHttpSetStatusCallback(
                resolver, self._callback, _CALLBACK_GETPROXYFORURL_COMPLETE | _CALLBACK_REQUEST_ERROR, 0
            )
            error = w.WinHttpGetProxyForUrlEx(resolver, url, ctypes.byref(options), context)
            if error == _ERROR_IO_PENDING:
                if not event.wait(PAC_EVALUATION_TIMEOUT_S):
                    raise PacError("pac_timeout")
                error = outcome[0]
            if error:
                raise self._error(error, options, "WinHttpGetProxyForUrlEx")
            result = _Result()
            result_error = w.WinHttpGetProxyResult(resolver, ctypes.byref(result))
            if result_error:
                logger.warning("pac-winhttp: call=WinHttpGetProxyResult failed error=%s", result_error)
                raise PacError("pac_failed")
            try:
                return self._entries(result)
            finally:
                w.WinHttpFreeProxyResult(ctypes.byref(result))
        finally:
            with self._lock:
                self._pending.pop(context, None)
            w.WinHttpCloseHandle(resolver)

    def _entries(self, result: _Result) -> str:
        entries = []
        for index in range(result.cEntries):
            entry = result.pEntries[index]
            if not entry.fProxy or entry.fBypass:
                entries.append("DIRECT")
            elif entry.pwszProxy and entry.ProxyScheme in _SCHEME_KEYWORDS:
                host = ctypes.wstring_at(entry.pwszProxy)
                entries.append(f"{_SCHEME_KEYWORDS[entry.ProxyScheme]} {host}:{entry.ProxyPort}")
        return "; ".join(entries)

    def _flattened(self, url: str, options: _Options) -> str:
        info = _Info()
        if not self._winhttp.WinHttpGetProxyForUrl(
            self._session(0), url, ctypes.byref(options), ctypes.byref(info)
        ):
            raise self._error(ctypes.get_last_error(), options, "WinHttpGetProxyForUrl")
        try:
            if info.dwAccessType != _ACCESS_TYPE_NAMED_PROXY or not info.lpszProxy:
                return "DIRECT"
            return ctypes.wstring_at(info.lpszProxy)
        finally:
            for pointer in (info.lpszProxy, info.lpszProxyBypass):
                if pointer:
                    self._kernel32.GlobalFree(pointer)

    @staticmethod
    def _error(code: int, options: _Options, call: str) -> PacError:
        if code == _ERROR_TIMEOUT:
            return PacError("pac_timeout")
        if code == _ERROR_AUTODETECTION_FAILED and not options.lpszAutoConfigUrl:
            return PacError("pac_none_found")
        logger.warning("pac-winhttp: call=%s failed error=%s", call, code)
        return PacError("pac_failed")
