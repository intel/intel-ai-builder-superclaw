"""Owner-by-tier identity naming (mirrors broker ``identity_name``).

This module only derives stable, non-secret tier account names. It deliberately
does **not** read the broker's provisioned state: the identity directory and the
identity records are DACL-protected to SYSTEM + Administrators, so the
unprivileged client can neither enumerate nor read them. Whether an owner is
provisioned is tracked by :mod:`sandbox_manager.broker_client.markers`.
"""

from __future__ import annotations

import hashlib
import re

#: A SID's subauthorities are decimal ASCII. Spelled ``[0-9]`` rather than ``\d``, which in Python also
#: matches digits like ``٣`` - a string that would pass here and mean nothing to the broker or to Windows.
_OWNER_SID_PATTERN = re.compile(r"^S-1-(?:[0-9]+-)+[0-9]+$")
TIERS: tuple[str, ...] = ("bootstrap", "file_tool", "network_connector", "channel")
_TIER_CODES = {"bootstrap": "B", "file_tool": "F", "network_connector": "C", "channel": "H"}
_BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


def canonical_owner_sid(owner_sid: str) -> str:
    trimmed = owner_sid.strip()
    if not _OWNER_SID_PATTERN.fullmatch(trimmed):
        raise ValueError("owner_sid is not a well-formed Windows SID")
    return trimmed


def tier_account_name(owner_sid: str, tier: str) -> str:
    if tier not in _TIER_CODES:
        raise ValueError(f"unknown isolation tier: {tier}")
    digest = hashlib.sha256(
        owner_sid.encode("utf-8") + b"\0" + tier.encode("utf-8")
    ).digest()
    return f"SCB{_TIER_CODES[tier]}{_base32_80(digest[:10])}"


def _base32_80(data: bytes) -> str:
    accumulator = 0
    bits = 0
    result: list[str] = []
    for byte in data:
        accumulator = (accumulator << 8) | byte
        bits += 8
        while bits >= 5:
            bits -= 5
            index = (accumulator >> bits) & 0x1F
            result.append(_BASE32_ALPHABET[index])
            accumulator &= (1 << bits) - 1 if bits else 0
    return "".join(result)
