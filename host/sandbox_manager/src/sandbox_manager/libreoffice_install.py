"""Install LibreOffice for the Office preview through winget, only after the user agreed.

The Office preview converts documents with ``soffice.exe``. SuperClaw neither ships LibreOffice nor
downloads it: when it is missing and Windows Package Manager (``winget``) is on the machine, the UI asks
the user, and on a yes this module runs ``winget install`` for The Document Foundation's package. winget
chooses the version and the installer and checks it against its public catalog; the installer asks for
administrator permission itself. Without winget there is nothing to run, and the UI tells the user how to
install LibreOffice by hand.

The caller supplies nothing. The package id and every argument are constants below, so a request can only
say "install the package", never "install this".

Every failure is an :class:`InstallError` carrying one short stable code.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from collections import deque
from collections.abc import Callable, Mapping
from pathlib import Path

from loguru import logger

PACKAGE_ID = "libreoffice-preview"

# Where an install is, as far as winget's output shows it. The UI turns these into words.
PHASE_DOWNLOADING = "downloading"
PHASE_INSTALLING = "installing"

WINGET_PACKAGE = "TheDocumentFoundation.LibreOffice"
# --exact and --source winget: only that id from the community catalog. --no-upgrade: an install SuperClaw
# did not make is never upgraded behind the user's back. --disable-interactivity: winget never waits at a
# prompt nobody can see. --accept-source-agreements: winget's own catalog terms, which a headless run
# cannot answer. The package's license is not accepted for the user: the UI shows it before the install.
WINGET_ARGUMENTS = (
    "install",
    "--id", WINGET_PACKAGE,
    "--exact",
    "--source", "winget",
    "--silent",
    "--no-upgrade",
    "--disable-interactivity",
    "--accept-source-agreements",
)

_OUTPUT_TAIL_LINES = 8  # how much of winget's output goes to the log when it fails
# winget's APPINSTALLER_CLI_ERROR_PACKAGE_ALREADY_INSTALLED: it matches the package by its Add/Remove
# Programs entry, wherever it was installed, and --no-upgrade makes it stop there.
_WINGET_ALREADY_INSTALLED = 0x8A150061


class InstallError(Exception):
    """An install failure. ``code`` is one of the stable codes below; ``detail`` is for the log."""

    WINGET_UNAVAILABLE = "winget_unavailable"
    INSTALL_FAILED = "install_failed"
    # LibreOffice is installed, but not where find_soffice() looks (a custom folder); installing again
    # cannot fix that, so the UI tells the user to reinstall it in the default place.
    ALREADY_INSTALLED_ELSEWHERE = "already_installed_elsewhere"

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


# ---------------------------------------------------------------- discovery


def find_soffice(env: Mapping[str, str] | None = None) -> Path | None:
    """``soffice.exe`` in the per-machine install folders, or ``None``.

    Only where the native preview server finds it too. ``sandbox/server/src/soffice-path.ts`` also
    honours ``SUPERCLAW_SOFFICE_PATH``, but the server's tier launch does not pass that variable, so a
    copy found only through it would read as installed here and missing there, and the install offer
    would never go away.
    """
    env = os.environ if env is None else env
    candidates: list[Path] = []
    for variable in ("ProgramFiles", "ProgramFiles(x86)"):
        root = env.get(variable)
        if root:
            candidates.append(Path(root) / "LibreOffice" / "program" / "soffice.exe")
    return next((path for path in candidates if path.is_file()), None)


def find_winget() -> Path | None:
    """``winget.exe`` on the PATH (an app execution alias on most machines), or ``None``.

    Some company images remove it; then the install is the user's to do.
    """
    found = shutil.which("winget")
    return Path(found) if found else None


# ---------------------------------------------------------------- the install


def _phase_after(line: str, phase: str | None) -> str | None:
    """The phase once winget has printed ``line``.

    Piped, winget draws no progress bar, so the only signs of where it is are its lines: it prints
    ``Downloading <installer url>``, and the next line once the download is verified. The URL and the
    installer's extension are what we look for, not winget's words, which are in the user's language.
    """
    if "://" in line and line.lower().endswith((".msi", ".exe")):
        return PHASE_DOWNLOADING
    return PHASE_INSTALLING if phase == PHASE_DOWNLOADING else phase


def run_winget_install(winget: Path, on_phase: Callable[[str], None]) -> tuple[int, str]:
    """Run ``winget install`` for LibreOffice and return ``(exit code, the tail of its output)``.

    Calls ``on_phase`` each time the phase changes. Waits until winget exits, however long that takes.
    The installer it starts is elevated, so we cannot stop it; giving up would only hide the result of an
    install that is still running.
    """
    tail: deque[str] = deque(maxlen=_OUTPUT_TAIL_LINES)
    phase: str | None = None
    with subprocess.Popen(
        [str(winget), *WINGET_ARGUMENTS],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    ) as process:
        for raw in process.stdout or ():
            line = raw.strip()
            if not line:
                continue
            tail.append(line)
            after = _phase_after(line, phase)
            if after is not None and after != phase:
                phase = after
                on_phase(phase)
        return process.wait(), "\n".join(tail)


def install_libreoffice(
    on_phase: Callable[[str], None] = lambda phase: None,
    *,
    discover: Callable[[], Path | None] = find_soffice,
    locate_winget: Callable[[], Path | None] = find_winget,
    run_winget: Callable[[Path, Callable[[str], None]], tuple[int, str]] = run_winget_install,
) -> None:
    """Install LibreOffice unless ``soffice.exe`` is already there. Raises ``InstallError``.

    Blocking; run it off the event loop. ``on_phase`` hears ``PHASE_DOWNLOADING`` and ``PHASE_INSTALLING``
    as winget moves through them. The keyword arguments are the seams tests replace.
    """
    if discover() is not None:
        return
    winget = locate_winget()
    if winget is None:
        raise InstallError(InstallError.WINGET_UNAVAILABLE, "winget is not on the PATH")
    started = time.monotonic()
    exit_code, output = run_winget(winget, on_phase)
    if exit_code != 0:
        logger.warning("winget install failed exit_code={:#010x} output_tail={}", exit_code, output.splitlines())
        code = (
            InstallError.ALREADY_INSTALLED_ELSEWHERE
            if exit_code == _WINGET_ALREADY_INSTALLED
            else InstallError.INSTALL_FAILED
        )
        raise InstallError(code, f"winget exit code {exit_code:#010x}")
    if discover() is None:
        raise InstallError(InstallError.INSTALL_FAILED, "winget succeeded but soffice.exe was not found")
    logger.info("libreoffice installed elapsed_s={}", round(time.monotonic() - started))
