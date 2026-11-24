"""Is SuperClaw 1.x's WSL distro registered? Answered from the registry, without starting WSL.

`wsl.exe` keeps each registration under `HKCU\\...\\Lxss\\{GUID}`; the uninstaller's
`IsWslDistroRegistered` reads the same values.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass

V1_DISTRO_NAME = "superclaw-docker"
_LXSS_KEY = r"Software\Microsoft\Windows\CurrentVersion\Lxss"


@dataclass(frozen=True)
class WslDistro:
    guid: str
    name: str
    base_path: str


def read_lxss_registry(key_path: str = _LXSS_KEY) -> list[WslDistro]:
    if os.name != "nt":
        return []
    import winreg

    distros: list[WslDistro] = []
    try:
        lxss = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path)
    except OSError:
        return distros
    with lxss:
        index = 0
        while True:
            try:
                guid = winreg.EnumKey(lxss, index)
            except OSError:
                break
            index += 1
            try:
                with winreg.OpenKey(lxss, guid) as key:
                    name, _ = winreg.QueryValueEx(key, "DistributionName")
                    base_path, _ = winreg.QueryValueEx(key, "BasePath")
            except OSError:
                continue
            if isinstance(name, str) and isinstance(base_path, str):
                distros.append(WslDistro(guid=guid, name=name, base_path=base_path))
    return distros


def find_v1_distro(read: Callable[[], list[WslDistro]] = read_lxss_registry) -> WslDistro | None:
    for distro in read():
        if distro.name.casefold() == V1_DISTRO_NAME:
            return distro
    return None
