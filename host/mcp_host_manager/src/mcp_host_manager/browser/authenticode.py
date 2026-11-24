"""Whether a file carries a valid Authenticode signature from Microsoft (WinVerifyTrust, no network)."""

from __future__ import annotations

import ctypes
import sys
from pathlib import Path

_WTD_UI_NONE = 2
_WTD_REVOKE_NONE = 0
_WTD_CHOICE_FILE = 1
_WTD_STATEACTION_VERIFY = 1
_WTD_STATEACTION_CLOSE = 2
_WTD_REVOCATION_CHECK_NONE = 0x00000010
_WTD_CACHE_ONLY_URL_RETRIEVAL = 0x00001000
_CERT_NAME_SIMPLE_DISPLAY_TYPE = 4
_MICROSOFT_SIGNER = "Microsoft Corporation"
_MICROSOFT_ROOT_PREFIX = "Microsoft Root Certificate Authority"


class _Guid(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_uint32),
        ("Data2", ctypes.c_uint16),
        ("Data3", ctypes.c_uint16),
        ("Data4", ctypes.c_ubyte * 8),
    ]


class _FileInfo(ctypes.Structure):
    _fields_ = [
        ("cbStruct", ctypes.c_uint32),
        ("pcwszFilePath", ctypes.c_wchar_p),
        ("hFile", ctypes.c_void_p),
        ("pgKnownSubject", ctypes.c_void_p),
    ]


class _TrustData(ctypes.Structure):
    _fields_ = [
        ("cbStruct", ctypes.c_uint32),
        ("pPolicyCallbackData", ctypes.c_void_p),
        ("pSIPClientData", ctypes.c_void_p),
        ("dwUIChoice", ctypes.c_uint32),
        ("fdwRevocationChecks", ctypes.c_uint32),
        ("dwUnionChoice", ctypes.c_uint32),
        ("pFile", ctypes.POINTER(_FileInfo)),
        ("dwStateAction", ctypes.c_uint32),
        ("hWVTStateData", ctypes.c_void_p),
        ("pwszURLReference", ctypes.c_wchar_p),
        ("dwProvFlags", ctypes.c_uint32),
        ("dwUIContext", ctypes.c_uint32),
        ("pSignatureSettings", ctypes.c_void_p),
    ]


class _ProviderSigner(ctypes.Structure):
    _fields_ = [
        ("cbStruct", ctypes.c_uint32),
        ("sftVerifyAsOf", ctypes.c_uint32 * 2),
        ("csCertChain", ctypes.c_uint32),
        ("pasCertChain", ctypes.c_void_p),
    ]


class _ProviderCert(ctypes.Structure):
    _fields_ = [("cbStruct", ctypes.c_uint32), ("pCert", ctypes.c_void_p)]


_GENERIC_VERIFY_V2 = _Guid(0x00AAC56B, 0xCD44, 0x11D0, (ctypes.c_ubyte * 8)(0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE))


def signed_by_microsoft(path: Path) -> bool:
    """A valid embedded signature whose signer is Microsoft Corporation under a Microsoft root."""
    if sys.platform != "win32":
        return False
    wintrust = ctypes.WinDLL("wintrust")
    crypt32 = ctypes.WinDLL("crypt32")
    wintrust.WinVerifyTrust.argtypes = [ctypes.c_void_p, ctypes.POINTER(_Guid), ctypes.POINTER(_TrustData)]
    wintrust.WinVerifyTrust.restype = ctypes.c_long
    wintrust.WTHelperProvDataFromStateData.argtypes = [ctypes.c_void_p]
    wintrust.WTHelperProvDataFromStateData.restype = ctypes.c_void_p
    wintrust.WTHelperGetProvSignerFromChain.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    wintrust.WTHelperGetProvSignerFromChain.restype = ctypes.c_void_p
    wintrust.WTHelperGetProvCertFromChain.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    wintrust.WTHelperGetProvCertFromChain.restype = ctypes.c_void_p
    crypt32.CertGetNameStringW.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.c_wchar_p,
        ctypes.c_uint32,
    ]
    crypt32.CertGetNameStringW.restype = ctypes.c_uint32

    file_info = _FileInfo(ctypes.sizeof(_FileInfo), str(path), None, None)
    data = _TrustData()
    data.cbStruct = ctypes.sizeof(_TrustData)
    data.dwUIChoice = _WTD_UI_NONE
    data.fdwRevocationChecks = _WTD_REVOKE_NONE
    data.dwUnionChoice = _WTD_CHOICE_FILE
    data.pFile = ctypes.pointer(file_info)
    data.dwStateAction = _WTD_STATEACTION_VERIFY
    data.dwProvFlags = _WTD_REVOCATION_CHECK_NONE | _WTD_CACHE_ONLY_URL_RETRIEVAL
    status = wintrust.WinVerifyTrust(None, ctypes.byref(_GENERIC_VERIFY_V2), ctypes.byref(data))
    try:
        if status != 0:
            return False
        provider = wintrust.WTHelperProvDataFromStateData(data.hWVTStateData)
        signer = wintrust.WTHelperGetProvSignerFromChain(provider, 0, False, 0) if provider else None
        if not signer:
            return False
        chain_length = ctypes.cast(signer, ctypes.POINTER(_ProviderSigner)).contents.csCertChain
        if chain_length < 2:
            return False

        def name(index: int) -> str:
            cert = wintrust.WTHelperGetProvCertFromChain(signer, index)
            if not cert:
                return ""
            context = ctypes.cast(cert, ctypes.POINTER(_ProviderCert)).contents.pCert
            buffer = ctypes.create_unicode_buffer(256)
            crypt32.CertGetNameStringW(context, _CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, None, buffer, 256)
            return buffer.value

        return name(0) == _MICROSOFT_SIGNER and name(chain_length - 1).startswith(_MICROSOFT_ROOT_PREFIX)
    finally:
        data.dwStateAction = _WTD_STATEACTION_CLOSE
        wintrust.WinVerifyTrust(None, ctypes.byref(_GENERIC_VERIFY_V2), ctypes.byref(data))
