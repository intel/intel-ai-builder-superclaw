"""Whether the host Edge can be served: its profile carries no account, and InPrivate is available.

Clients reach only off-the-record contexts (the relay's invariant), which carry neither the profile's
account nor the device's Entra SSO. The default context still does, and is out of every client's
reach. On an Entra-joined machine Edge would also sign the dedicated profile in with the Windows
account by itself (implicit sign-in); the launch turns that off (`msImplicitSignin`), and an
account in the profile means it no longer works, so it is refused. These checks read only the
machine's Edge policy and the profile's own JSON files.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

INPRIVATE_POLICY = "InPrivateModeAvailability"
# `InPrivateModeAvailability`: 0 available, 1 disabled, 2 forced.
_INPRIVATE_DISABLED = 1
_POLICY_KEY = r"SOFTWARE\Policies\Microsoft\Edge"
# `profile.info_cache.<profile>` fields that name an account. Numeric and flag fields are left out:
# Edge fills some of them on a profile that never signed in.
_PROFILE_IDENTITY_FIELDS = (
    "user_name",
    "gaia_id",
    "gaia_name",
    "edge_account_cid",
    "edge_account_oid",
    "edge_account_puid",
    "edge_account_tenant_id",
    "edge_account_first_name",
    "edge_account_last_name",
    "edge_previously_signin_user_name",
)


@dataclass(frozen=True)
class IdentityFinding:
    """What gave the identity away. `domain` is the account's email domain, the most that is logged."""

    source: str
    domain: str | None = None


class PolicyUnreadable(Exception):
    """The InPrivate policy is there but could not be read as a number: not evidence that it is unset."""


def inprivate_disabled_by_policy() -> bool:
    """Whether Edge policy, machine or user, turns InPrivate off: then no off-the-record context
    exists for a client, and the host browser is unavailable.

    Only a missing key or value is "not set"; any other failure to read it raises PolicyUnreadable.
    """
    if sys.platform != "win32":
        return False
    import winreg

    views = (
        (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_64KEY),
        (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_32KEY),
        (winreg.HKEY_CURRENT_USER, 0),
    )
    for hive, view in views:
        try:
            with winreg.OpenKey(hive, _POLICY_KEY, 0, winreg.KEY_READ | view) as key:
                value, _ = winreg.QueryValueEx(key, INPRIVATE_POLICY)
        except FileNotFoundError:
            continue
        except OSError as error:
            raise PolicyUnreadable(f"{INPRIVATE_POLICY}: {type(error).__name__}") from error
        if _policy_number(value) == _INPRIVATE_DISABLED:
            return True
    return False


def _policy_number(value: object) -> int | None:
    """A DWORD, or a string holding a number (Edge reads a REG_SZ "1" as 1); anything else is unreadable."""
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdecimal():
        return int(value.strip())
    raise PolicyUnreadable(f"{INPRIVATE_POLICY}: not a number")


class ProfileUnreadable(Exception):
    """A profile file exists but could not be read or parsed (mid-write or locked): not evidence of
    a clean profile, so it must not count as a clean check."""


def find_identity(user_data_dir: Path) -> IdentityFinding | None:
    """A signed-in account anywhere in the profile directory, or None while it carries none.

    A missing file is a profile that has not written it yet. A file that exists but cannot be read
    raises ProfileUnreadable, unless another file already shows an identity.
    """
    unreadable: list[str] = []
    state = _read_json(user_data_dir / "Local State", unreadable)
    profiles = state.get("profile", {}).get("info_cache", {}) if isinstance(state.get("profile"), dict) else {}
    profiles = profiles if isinstance(profiles, dict) else {}
    for name in sorted({"Default", *profiles}):
        prefs = _read_json(user_data_dir / name / "Preferences", unreadable)
        accounts = prefs.get("account_info")
        if isinstance(accounts, list) and accounts:
            emails = [account.get("email") for account in accounts if isinstance(account, dict)]
            return IdentityFinding(source="preferences:account_info", domain=_domain(emails))
        entry = profiles.get(name)
        if isinstance(entry, dict) and any(_named(entry.get(field)) for field in _PROFILE_IDENTITY_FIELDS):
            return IdentityFinding(source="local_state:info_cache", domain=_domain([entry.get("user_name")]))
    implicit = state.get("profiles", {}).get("edge_implicitly_signed_in") if isinstance(state.get("profiles"), dict) else None
    if isinstance(implicit, list) and implicit:
        return IdentityFinding(source="local_state:edge_implicitly_signed_in")
    active = state.get("signin", {}).get("active_accounts") if isinstance(state.get("signin"), dict) else None
    if isinstance(active, dict) and active:
        return IdentityFinding(source="local_state:active_accounts")
    if unreadable:
        raise ProfileUnreadable(", ".join(unreadable))
    return None


def _read_json(path: Path, unreadable: list[str]) -> dict[str, object]:
    """The file's object; empty when it is missing. A file that is there but unreadable, or not a
    JSON object, is noted in `unreadable` (by its name relative to the profile, never its content)."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeDecodeError):
        unreadable.append(f"{path.parent.name}/{path.name}")
        return {}
    try:
        data = json.loads(text)
    except (ValueError, RecursionError):
        unreadable.append(f"{path.parent.name}/{path.name}")
        return {}
    if not isinstance(data, dict):
        unreadable.append(f"{path.parent.name}/{path.name}")
        return {}
    return data


def _named(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _domain(candidates: list[object]) -> str | None:
    for candidate in candidates:
        if isinstance(candidate, str) and "@" in candidate:
            return candidate.rsplit("@", 1)[1].strip().lower() or None
    return None
