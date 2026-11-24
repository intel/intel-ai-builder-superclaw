"""Machine-bound DPAPI sealed JSON files for cross-tier runtime secrets."""

from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
from typing import Any, Mapping
from uuid import uuid4

from contracts.broker_connector_client_config import BrokerConnectorClientConfig
from pydantic import ValidationError


_MAX_SEALED_BYTES = 64 * 1024
_SCHEMA_VERSION = 1
_PROTECTION = "dpapi_local_machine"
_CRYPTPROTECT_LOCAL_MACHINE = 0x4


class DpapiSecretError(RuntimeError):
    pass


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def write_sealed_json(path: Path, value: Mapping[str, Any]) -> None:
    plaintext = bytearray(
        json.dumps(dict(value), sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    )
    try:
        ciphertext = _protect(plaintext)
    finally:
        _wipe(plaintext)
    envelope = {
        "schema_version": _SCHEMA_VERSION,
        "protection": _PROTECTION,
        "ciphertext_b64": base64.b64encode(ciphertext).decode("ascii"),
    }
    encoded = json.dumps(envelope, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(encoded) > _MAX_SEALED_BYTES:
        raise DpapiSecretError("sealed secret file exceeds its size bound")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_sealed_json(path: Path) -> dict[str, Any]:
    try:
        encoded = path.read_bytes()
    except OSError as exc:
        raise DpapiSecretError("sealed secret file is unavailable") from exc
    if not encoded or len(encoded) > _MAX_SEALED_BYTES:
        raise DpapiSecretError("sealed secret file is outside its size bound")
    try:
        envelope = json.loads(encoded)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise DpapiSecretError("sealed secret envelope is invalid JSON") from exc
    if not isinstance(envelope, dict) or set(envelope) != {
        "schema_version",
        "protection",
        "ciphertext_b64",
    }:
        raise DpapiSecretError("sealed secret envelope fields are invalid")
    if envelope["schema_version"] != _SCHEMA_VERSION or envelope["protection"] != _PROTECTION:
        raise DpapiSecretError("sealed secret envelope version or protection is unsupported")
    try:
        ciphertext = base64.b64decode(envelope["ciphertext_b64"], validate=True)
    except (TypeError, ValueError) as exc:
        raise DpapiSecretError("sealed secret ciphertext is invalid base64") from exc
    plaintext = _unprotect(ciphertext)
    try:
        value = json.loads(plaintext)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise DpapiSecretError("unsealed secret is invalid JSON") from exc
    finally:
        _wipe(plaintext)
    if not isinstance(value, dict):
        raise DpapiSecretError("unsealed secret must be a JSON object")
    return value


def read_connector_client_config(path: Path) -> dict[str, Any]:
    value = read_sealed_json(path)
    try:
        validated = BrokerConnectorClientConfig.model_validate(value, strict=True)
    except ValidationError as exc:
        raise DpapiSecretError("Connector client configuration fields are invalid") from exc
    return validated.model_dump(mode="json")


def _protect(plaintext: bytearray) -> bytes:
    return _crypt(plaintext, protect=True)


def _unprotect(ciphertext: bytes) -> bytearray:
    return bytearray(_crypt(ciphertext, protect=False))


def _crypt(data: bytes | bytearray, *, protect: bool) -> bytes:
    if os.name != "nt":
        raise DpapiSecretError("DPAPI secret files are supported only on Windows")
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)  # type: ignore[attr-defined]
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(_Blob),
        wintypes.LPCWSTR,
        ctypes.POINTER(_Blob),
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(_Blob),
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(_Blob),
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.POINTER(_Blob),
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(_Blob),
    ]
    kernel32.LocalFree.restype = ctypes.c_void_p
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source = _Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = _Blob()
    if protect:
        call = crypt32.CryptProtectData
        arguments = (
            ctypes.byref(source),
            "SuperClaw P7 runtime secret",
            None,
            None,
            None,
            _CRYPTPROTECT_LOCAL_MACHINE,
            ctypes.byref(output),
        )
    else:
        call = crypt32.CryptUnprotectData
        arguments = (
            ctypes.byref(source),
            None,
            None,
            None,
            None,
            _CRYPTPROTECT_LOCAL_MACHINE,
            ctypes.byref(output),
        )
    if not call(*arguments):
        raise DpapiSecretError(f"Windows DPAPI operation failed with code {ctypes.get_last_error()}")
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        if output.pbData:
            ctypes.memset(output.pbData, 0, output.cbData)
            kernel32.LocalFree(ctypes.cast(output.pbData, ctypes.c_void_p))


def _wipe(value: bytearray) -> None:
    if value:
        ctypes.memset((ctypes.c_ubyte * len(value)).from_buffer(value), 0, len(value))
