"""Portable Python reference and relocated-runtime probes."""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path


ABSOLUTE_WINDOWS_REFERENCE = re.compile(r"(?i)(?:[a-z]:[\\/]|file:///[a-z]:/)")


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
    except ValueError:
        return False
    return True


def audit_python_references(root: Path) -> list[str]:
    """Reject venv metadata and launcher text bound to a builder path."""
    py_root = root / "py"
    if not py_root.is_dir():
        return []
    candidates = set(py_root.rglob("pyvenv.cfg"))
    candidates.update(py_root.rglob("*.pth"))
    for scripts in py_root.rglob("Scripts"):
        if scripts.is_dir():
            candidates.update(path for path in scripts.iterdir() if path.is_file())

    errors: list[str] = []
    for path in sorted(candidates):
        if path.suffix.lower() in {".exe", ".dll", ".pyd"}:
            continue
        try:
            text = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError):
            continue
        relative = path.relative_to(root).as_posix()
        if ABSOLUTE_WINDOWS_REFERENCE.search(text):
            errors.append(
                "portable Python metadata contains an absolute builder reference: "
                f"{relative}"
            )
        elif path.name.casefold() == "pyvenv.cfg":
            errors.append(f"portable Python payload may not contain pyvenv.cfg: {relative}")
    return errors


def _probe_environment() -> dict[str, str]:
    env = dict(os.environ)
    env.pop("PYTHONHOME", None)
    env.pop("PYTHONPATH", None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONNOUSERSITE"] = "1"
    if os.name == "nt":
        system_root = env.get("SystemRoot", r"C:\Windows")
        env["PATH"] = os.pathsep.join(
            [str(Path(system_root) / "System32"), system_root]
        )
    else:
        env["PATH"] = os.pathsep.join(["/usr/bin", "/bin"])
    return env


def run_import_probe(
    interpreter: Path,
    imports: list[str],
    *,
    payload_root: Path,
    timeout_seconds: int,
    origin_modules: list[str] | None = None,
    scripts: list[Path] | None = None,
    evidence_out: dict[str, object] | None = None,
) -> str | None:
    """Import `imports` in `interpreter`, after running each of `scripts` in the same process.

    A script runs under a name other than `__main__`, so its module code (and any `sys.path`
    entry it adds for its siblings) runs as at launch, and `imports` then resolve as they do
    when the role imports them lazily.
    """
    origins = origin_modules or []
    script_paths = [str(path) for path in scripts or []]
    code = (
        "import encodings, importlib, json, runpy, ssl, sys, sysconfig\n"
        f"scripts = {script_paths!r}\n"
        f"modules = {imports!r}\n"
        f"origin_modules = {origins!r}\n"
        "for path in scripts:\n"
        "    runpy.run_path(path, run_name='__payload_probe__')\n"
        "for name in modules:\n"
        "    importlib.import_module(name)\n"
        "origin_paths = {}\n"
        "for name in origin_modules:\n"
        "    module = importlib.import_module(name)\n"
        "    origin_paths[name] = getattr(module, '__file__', None)\n"
        "print('__PAYLOAD_PROBE__' + json.dumps({\n"
        "    'executable': sys.executable,\n"
        "    'base_executable': getattr(sys, '_base_executable', None),\n"
        "    'prefix': sys.prefix,\n"
        "    'base_prefix': sys.base_prefix,\n"
        "    'stdlib': sysconfig.get_path('stdlib'),\n"
        "    'stdlib_origins': {\n"
        "        'encodings': encodings.__file__,\n"
        "        'ssl': ssl.__file__,\n"
        "    },\n"
        "    'sys_path': sys.path,\n"
        "    'origins': origin_paths,\n"
        "}))\n"
    )
    try:
        completed = subprocess.run(
            [str(interpreter), "-B", "-c", code],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=_probe_environment(),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"interpreter probe could not run {interpreter}: {exc}"
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        if len(detail) > 800:
            detail = detail[-800:]
        return (
            f"interpreter probe failed for {interpreter} "
            f"(exit {completed.returncode}): {detail or 'no output'}"
        )

    marker = next(
        (
            line.removeprefix("__PAYLOAD_PROBE__")
            for line in reversed(completed.stdout.splitlines())
            if line.startswith("__PAYLOAD_PROBE__")
        ),
        None,
    )
    if marker is None:
        return f"interpreter probe returned no location evidence for {interpreter}"
    try:
        evidence = json.loads(marker)
    except json.JSONDecodeError as exc:
        return f"interpreter probe returned invalid location evidence: {exc}"
    if not isinstance(evidence, dict):
        return "interpreter probe location evidence must be an object"

    location_errors: list[str] = []
    for field in ("executable", "base_executable", "prefix", "base_prefix", "stdlib"):
        value = evidence.get(field)
        if isinstance(value, str) and value and not _is_within(Path(value), payload_root):
            location_errors.append(f"{field} escapes relocated payload: {value}")
    sys_path = evidence.get("sys_path")
    if not isinstance(sys_path, list):
        location_errors.append("sys_path evidence is missing")
    else:
        for value in sys_path:
            if (
                isinstance(value, str)
                and value
                and Path(value).is_absolute()
                and not _is_within(Path(value), payload_root)
            ):
                location_errors.append(f"sys.path escapes relocated payload: {value}")
    stdlib_origins = evidence.get("stdlib_origins")
    if not isinstance(stdlib_origins, dict):
        location_errors.append("stdlib origin evidence is missing")
    else:
        for name, value in stdlib_origins.items():
            if not isinstance(value, str) or not _is_within(Path(value), payload_root):
                location_errors.append(
                    f"stdlib module {name} escapes relocated payload: {value}"
                )
    origin_values = evidence.get("origins")
    if not isinstance(origin_values, dict):
        location_errors.append("module origin evidence is missing")
    else:
        for name in origins:
            value = origin_values.get(name)
            if not isinstance(value, str) or not value:
                location_errors.append(f"module origin is missing for {name}")
            elif not _is_within(Path(value), payload_root):
                location_errors.append(
                    f"module {name} imported outside relocated payload: {value}"
                )
    if location_errors:
        return "; ".join(location_errors)
    if evidence_out is not None:
        evidence_out.update(evidence)
    return None
