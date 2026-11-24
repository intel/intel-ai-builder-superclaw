"""Offline installed-Runtime acceptance probe for issue 2789; run via the app's shell tool."""

from __future__ import annotations

import argparse
import base64
import csv
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile

PACKAGE = "sc-2789-probe"
COMMAND = "sc-2789-probe.exe"


def make_wheel(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    metadata = "sc_2789_probe-1.0.0.dist-info"
    files = {
        "sc_2789_probe.py": (
            "import json, sys\n"
            "def main():\n"
            "    print(json.dumps({'marker': 'issue-2789', 'prefix': sys.prefix}))\n"
        ).encode(),
        f"{metadata}/METADATA": b"Metadata-Version: 2.1\nName: sc-2789-probe\nVersion: 1.0.0\n",
        f"{metadata}/WHEEL": b"Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        f"{metadata}/entry_points.txt": b"[console_scripts]\nsc-2789-probe = sc_2789_probe:main\n",
    }
    record = io.StringIO(newline="")
    writer = csv.writer(record)
    for name, content in files.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode()
        writer.writerow([name, f"sha256={digest}", len(content)])
    writer.writerow([f"{metadata}/RECORD", "", ""])
    files[f"{metadata}/RECORD"] = record.getvalue().encode()
    wheel = directory / "sc_2789_probe-1.0.0-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return wheel


def run(arguments: list[str], env: dict[str, str], home: Path) -> str:
    result = subprocess.run(
        arguments, cwd=home, env=env, capture_output=True, text=True, timeout=90,
    )
    if result.returncode:
        raise RuntimeError(f"probe command failed ({result.returncode}): {result.stderr}")
    return result.stdout.strip()


def verify_command(home: Path, env: dict[str, str]) -> dict[str, str]:
    found = shutil.which(COMMAND, path=env["PATH"])
    expected = home / ".local" / "bin" / COMMAND
    if found is None or Path(found).resolve() != expected.resolve():
        raise RuntimeError("installed command was not discovered in the isolated bin")
    result = json.loads(run([found], env, home))
    if result.get("marker") != "issue-2789":
        raise RuntimeError("wrong command executed")
    if Path(result["prefix"]).resolve() != (home / ".local" / "tools" / PACKAGE).resolve():
        raise RuntimeError("tool did not execute in its own isolated environment")
    return result


def verify_precedence(home: Path, env: dict[str, str]) -> None:
    local_bin = home / ".local" / "bin"
    source = local_bin / COMMAND
    for command in ("python.exe", "whoami.exe"):
        original = shutil.which(command, path=env["PATH"])
        if original is None or Path(original).parent.resolve() == local_bin.resolve():
            raise RuntimeError(f"no higher-priority command for {command}")
        shadow = local_bin / command
        with shadow.open("xb") as target:
            with source.open("rb") as content:
                shutil.copyfileobj(content, target)
        try:
            resolved = shutil.which(command, path=env["PATH"])
            if resolved is None or Path(resolved).resolve() != Path(original).resolve():
                raise RuntimeError(f"writable command shadowed {command}")
            arguments = [resolved, "--version"] if command == "python.exe" else [resolved]
            if "issue-2789" in run(arguments, env, home):
                raise RuntimeError(f"shadow command executed for {command}")
        finally:
            shadow.unlink()


def exercise(phase: str, home: Path, env: dict[str, str]) -> dict[str, object]:
    installer = shutil.which("uv.exe", path=env["PATH"])
    if installer is None:
        raise RuntimeError("packaged uv is missing")
    proof = home / ".local" / "issue-2789-proof"
    receipt = proof / "launch.json"
    instance = env["OPENCODE_CONFIG_DIR"]
    if phase == "install":
        if receipt.exists() or (home / ".local" / "tools" / PACKAGE).exists():
            raise RuntimeError("probe is already installed; use restart or cleanup")
        wheel = make_wheel(proof / "wheels")
        run([installer, "tool", "install", "--offline", "--no-index", "--no-build",
             "--link-mode", "copy", str(wheel)], env, home)
        result = verify_command(home, env)
        verify_precedence(home, env)
        receipt.write_text(json.dumps({"instance": instance}), encoding="utf-8")
        return {"phase": phase, "ok": True, "tool": result, "precedence": "pass"}
    if phase == "restart":
        prior = json.loads(receipt.read_text(encoding="utf-8"))
        if prior["instance"] == instance:
            raise RuntimeError("Runtime has not restarted; cannot claim restart persistence")
        result = verify_command(home, env)
        verify_precedence(home, env)
        return {"phase": phase, "ok": True, "tool": result, "precedence": "pass"}
    run([installer, "tool", "uninstall", PACKAGE], env, home)
    if (home / ".local" / "bin" / COMMAND).exists() or (home / ".local" / "tools" / PACKAGE).exists():
        raise RuntimeError("uninstall left the probe entry or environment")
    if proof.exists():
        shutil.rmtree(proof)
    return {"phase": phase, "ok": True}


def installed_environment() -> tuple[Path, dict[str, str]]:
    if sys.platform != "win32":
        raise RuntimeError("installed acceptance requires Windows")
    username = ctypes.create_unicode_buffer(256)
    size = ctypes.c_ulong(len(username))
    if not ctypes.windll.advapi32.GetUserNameW(username, ctypes.byref(size)):
        raise RuntimeError("cannot identify the executing account")
    if re.fullmatch(r"SCBF[A-Z2-7]{16}", username.value, re.IGNORECASE) is None:
        raise RuntimeError("run this probe through the installed app, in the file_tool account")
    env = dict(os.environ)
    home = Path(env["HOME"])
    if not home.is_absolute() or Path(env["USERPROFILE"]).resolve() != home.resolve():
        raise RuntimeError("Runtime home redirection is missing")
    for name, suffix in (("UV_TOOL_DIR", "tools"), ("UV_TOOL_BIN_DIR", "bin")):
        expected = home / ".local" / suffix
        if not expected.is_dir() or Path(env[name]).resolve() != expected.resolve():
            raise RuntimeError(f"Runtime layout mismatch: {name}")
    for name, expected in (("UV_OFFLINE", "1"), ("UV_NO_CONFIG", "1"), ("UV_NO_BUILD", "1"), ("UV_PYTHON_DOWNLOADS", "never")):
        if env.get(name) != expected:
            raise RuntimeError(f"Runtime installer policy mismatch: {name}")
    installer = shutil.which("uv.exe", path=env["PATH"])
    python = Path(env["UV_PYTHON"])
    if installer is None or Path(installer).resolve() != (python.parent.parent.parent / "tools" / "uv" / "uv.exe").resolve():
        raise RuntimeError("installer is not from the pinned Python's payload")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return home, env


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("install", "restart", "cleanup"))
    args = parser.parse_args()
    home, env = installed_environment()
    print(json.dumps(exercise(args.phase, home, env)))


if __name__ == "__main__":
    main()