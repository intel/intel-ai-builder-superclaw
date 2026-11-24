#!/usr/bin/env python3
"""Verify a staged Windows-native payload without invoking the shared build."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

from python_payload_probe import audit_python_references
from python_payload_probe import run_import_probe as _run_import_probe


DEFAULT_CONTRACT = Path(__file__).with_name("native-payload-contract.json")
DIFF_EXAMPLE_LIMIT = 100
_PY_EXCLUSION = re.compile(r"""/XD["'\s,]+py(?=["'\s,)\]]|$)""")


class ContractError(ValueError):
    """The payload contract is malformed."""


def load_contract(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ContractError(f"cannot read payload contract {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ContractError(f"payload contract {path} must contain a JSON object")
    return value


def _object_map(value: object, field: str) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ContractError(f"{field} must be an object with string keys")
    return value


def _string_list(value: object, field: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ContractError(f"{field} must be an array of strings")
    return value


def _safe_payload_path(root: Path, relative: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ContractError(f"payload path must be relative and contained: {relative!r}")
    return root.joinpath(*candidate.parts)


def detect_release_stage_policy(script_text: str) -> bool:
    """Return whether release staging mirrors the complete payload."""
    compact = " ".join(script_text.split())
    release_stage = compact.split(
        "=== staging payload into the Release tree (installer input) ===", 1
    )[-1]
    # Every predicate reads the release stage only. Against the whole script,
    # '@("/MIR")' also matches the unrelated site-packages mirror in
    # Stage-LockedPythonComponent, which would let a release stage satisfy this
    # audit on the strength of a copy that has nothing to do with it.
    direct_mirror = (
        "Invoke-Robocopy $OutDir $dest" in release_stage
        and '@("/MIR")' in release_stage
    )
    managed_complete_copy = all(
        marker in release_stage
        for marker in (
            "Copy-ManagedPayloadTree",
            "-Source $OutDir",
            "-Destination $dest",
            "-CompletePayload $completePayload",
            '-Description "release-stage copy"',
        )
    )
    # Matching the one literal the base branch happened to use would miss
    # @("/XD","py"), @('/XD','py') and bare /XD py, each of which reopens the
    # exclusion this audit exists to keep closed.
    excludes_python = _PY_EXCLUSION.search(release_stage) is not None
    return (direct_mirror or managed_complete_copy) and not excludes_python


def audit_release_stage_policy(
    build_script: Path, contract: dict[str, object]
) -> dict[str, object]:
    policy = _object_map(contract.get("release_stage_policy"), "release_stage_policy")
    try:
        script_text = build_script.read_text(encoding="utf-8-sig")
    except OSError as exc:
        return {
            "expected_status": policy.get("status"),
            "detected": False,
            "error": f"cannot read release-stage script {build_script}: {exc}",
        }
    return {
        "expected_status": policy.get("status"),
        "detected": detect_release_stage_policy(script_text),
        "build_script": str(build_script),
        "required_copy_mode": policy.get("required_copy_mode"),
        "forbidden_exclusion": policy.get("forbidden_exclusion"),
        "evidence": policy.get("evidence"),
    }


def pinned_uv_install_path(repo_root: Path, uv_spec: dict[str, object]) -> Path:
    """Where the payload build provisions the SHA-verified pinned uv.

    Mirrors Get-UvInstallRoot in uv-toolchain-policy.ps1, and is asserted equal to
    it by the tests. This only computes a path; deciding to trust and run whatever
    sits there belongs to the caller, which is why nothing in this module resolves
    it on its own. Pass the result as --uv when that trust decision is yours.
    """
    version = uv_spec.get("version")
    commit = uv_spec.get("commit")
    if not isinstance(version, str) or not isinstance(commit, str):
        raise ContractError("toolchain.uv.version and .commit must be strings")
    return (
        repo_root / "build" / "_toolchain" / "uv" / f"uv-{version}-{commit}" / "uv.exe"
    )


def validate_toolchain(
    contract: dict[str, object], uv: str | None = None
) -> dict[str, object]:
    toolchain = _object_map(contract.get("toolchain"), "toolchain")
    uv_spec = _object_map(toolchain.get("uv"), "toolchain.uv")
    version = uv_spec.get("version")
    commit = uv_spec.get("commit")
    if not isinstance(version, str) or not isinstance(commit, str):
        raise ContractError("toolchain.uv.version and .commit must be strings")
    expected_prefix = f"uv {version} ({commit} "

    # Either the caller names the uv to check or it is the one on PATH. This does
    # not go looking for a uv the build may have provisioned: the provisioned copy
    # lives in the writable build tree, where existing and printing the right
    # version is not evidence of anything, and running a binary found that way
    # would be a weaker guarantee than the one Get-PinnedUv just established.
    if uv is None:
        uv = shutil.which("uv")
    if uv is None:
        return {"ok": False, "uv": None, "errors": ["uv not found on PATH"]}
    try:
        completed = subprocess.run(
            [uv, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {
            "ok": False,
            "uv": uv,
            "errors": [f"uv toolchain validation could not run: {exc}"],
        }
    actual = (completed.stdout or completed.stderr).strip()
    errors: list[str] = []
    if completed.returncode != 0 or not actual.startswith(expected_prefix):
        errors.append(
            f"uv toolchain mismatch: expected {expected_prefix!r}, got {actual!r}"
        )
    return {"ok": not errors, "uv": uv, "version": actual, "errors": errors}


def validate_dependency_locks(
    repo_root: Path, contract: dict[str, object], uv: str | None = None
) -> dict[str, object]:
    locks = _object_map(contract.get("dependency_locks"), "dependency_locks")
    toolchain = validate_toolchain(contract, uv)
    uv = toolchain.get("uv")
    errors = list(_string_list(toolchain.get("errors"), "toolchain.errors"))
    checked: list[str] = []
    if not isinstance(uv, str) or errors:
        return {
            "ok": False,
            "checked": checked,
            "toolchain": toolchain,
            "errors": errors,
        }

    for name, raw_spec in locks.items():
        spec = _object_map(raw_spec, f"dependency_locks.{name}")
        project_value = spec.get("project")
        lock_value = spec.get("lock")
        if not isinstance(project_value, str) or not isinstance(lock_value, str):
            raise ContractError(
                f"dependency_locks.{name}.project and .lock must be strings"
            )
        project = _safe_payload_path(repo_root, project_value)
        lock = _safe_payload_path(repo_root, lock_value)
        if not project.is_file():
            errors.append(f"{name}: missing project metadata '{project_value}'")
            continue
        if not lock.is_file():
            errors.append(f"{name}: missing lockfile '{lock_value}'")
            continue
        try:
            completed = subprocess.run(
                [
                    uv,
                    "lock",
                    "--check",
                    "--offline",
                    "--project",
                    str(project.parent),
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            errors.append(f"{name}: lock validation could not run: {exc}")
            continue
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout).strip()
            errors.append(
                f"{name}: lockfile is not current"
                + (f": {detail[-800:]}" if detail else "")
            )
            continue
        checked.append(name)
    return {
        "ok": not errors,
        "checked": checked,
        "toolchain": toolchain,
        "errors": errors,
    }


def _iter_files(path: Path) -> Iterator[Path]:
    if path.is_file():
        yield path
    elif path.is_dir():
        yield from (candidate for candidate in path.rglob("*") if candidate.is_file())


def _component_sizes(
    root: Path, component_names: list[str], components: dict[str, object]
) -> dict[str, object]:
    component_bytes: dict[str, int] = {}
    component_file_counts: dict[str, int] = {}
    all_files: set[Path] = set()
    for name in component_names:
        spec = _object_map(components.get(name), f"components.{name}")
        roots = _string_list(spec.get("size_roots", []), f"components.{name}.size_roots")
        files: set[Path] = set()
        for relative in roots:
            files.update(_iter_files(_safe_payload_path(root, relative)))
        component_bytes[name] = sum(path.stat().st_size for path in files)
        component_file_counts[name] = len(files)
        all_files.update(files)
    return {
        "total_bytes": sum(path.stat().st_size for path in all_files),
        "file_count": len(all_files),
        "component_bytes": component_bytes,
        "component_file_counts": component_file_counts,
    }


def _tree_size(root: Path) -> dict[str, int]:
    files = list(_iter_files(root))
    return {
        "total_bytes": sum(path.stat().st_size for path in files),
        "file_count": len(files),
    }


def _validate_component(
    root: Path,
    name: str,
    spec: dict[str, object],
    *,
    run_runtime_probes: bool,
    probe_timeout_seconds: int,
) -> tuple[list[str], dict[str, object] | None]:
    errors: list[str] = []
    required_files = _string_list(
        spec.get("required_files", []), f"components.{name}.required_files"
    )
    for relative in required_files:
        if not _safe_payload_path(root, relative).is_file():
            errors.append(f"{name}: missing file '{relative}'")

    required_globs = _string_list(
        spec.get("required_globs", []), f"components.{name}.required_globs"
    )
    matched_resources: list[str] = []
    for pattern in required_globs:
        if Path(pattern).is_absolute() or ".." in Path(pattern).parts:
            raise ContractError(f"payload glob must be relative and contained: {pattern!r}")
        matches = sorted(candidate for candidate in root.glob(pattern) if candidate.is_file())
        if not matches:
            errors.append(f"{name}: no files match required pattern '{pattern}'")
        matched_resources.extend(
            candidate.relative_to(root).as_posix() for candidate in matches
        )

    interpreter_value = spec.get("interpreter")
    if interpreter_value is None:
        return errors, None
    if not isinstance(interpreter_value, str):
        raise ContractError(f"components.{name}.interpreter must be a string")
    interpreter = _safe_payload_path(root, interpreter_value)
    if not interpreter.is_file():
        errors.append(f"{name}: missing interpreter '{interpreter_value}'")
        return errors, None
    evidence: dict[str, object] | None = None
    if run_runtime_probes:
        imports = _string_list(spec.get("imports", []), f"components.{name}.imports")
        origin_modules = _string_list(
            spec.get("origin_modules", []), f"components.{name}.origin_modules"
        )
        scripts = [
            _safe_payload_path(root, relative)
            for relative in _string_list(spec.get("scripts", []), f"components.{name}.scripts")
        ]
        missing_scripts = [path for path in scripts if not path.is_file()]
        if missing_scripts:
            errors.extend(
                f"{name}: missing probe script '{path.relative_to(root).as_posix()}'"
                for path in missing_scripts
            )
            return errors, None
        evidence = {}
        probe_error = _run_import_probe(
            interpreter,
            imports,
            payload_root=root,
            timeout_seconds=probe_timeout_seconds,
            origin_modules=origin_modules,
            scripts=scripts,
            evidence_out=evidence,
        )
        if probe_error is not None:
            errors.append(f"{name}: {probe_error}")
        elif matched_resources:
            evidence["required_resources"] = matched_resources
    return errors, evidence


def _file_inventory(root: Path) -> dict[str, tuple[int, Path]]:
    if not root.is_dir():
        return {}
    return {
        path.relative_to(root).as_posix().casefold(): (path.stat().st_size, path)
        for path in root.rglob("*")
        if path.is_file()
    }


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compare_payloads(release_root: Path, dev_root: Path) -> dict[str, object]:
    release_files = _file_inventory(release_root)
    dev_files = _file_inventory(dev_root)
    missing = sorted(dev_files.keys() - release_files.keys())
    release_only = sorted(release_files.keys() - dev_files.keys())
    shared = release_files.keys() & dev_files.keys()
    size_changed = sorted(
        path
        for path in shared
        if release_files[path][0] != dev_files[path][0]
    )
    content_changed = sorted(
        path
        for path in shared
        if release_files[path][0] == dev_files[path][0]
        and _sha256(release_files[path][1]) != _sha256(dev_files[path][1])
    )
    return {
        "different": bool(missing or release_only or size_changed or content_changed),
        "release": _tree_size(release_root),
        "development": _tree_size(dev_root),
        "missing_from_release_count": len(missing),
        "release_only_count": len(release_only),
        "size_changed_count": len(size_changed),
        "content_changed_count": len(content_changed),
        "missing_from_release_examples": missing[:DIFF_EXAMPLE_LIMIT],
        "release_only_examples": release_only[:DIFF_EXAMPLE_LIMIT],
        "size_changed_examples": size_changed[:DIFF_EXAMPLE_LIMIT],
        "content_changed_examples": content_changed[:DIFF_EXAMPLE_LIMIT],
    }


def _validate_runtime_provenance(
    root: Path, contract: dict[str, object]
) -> list[str]:
    path = root / "py" / "runtime-provenance.json"
    if not path.is_file():
        return []
    try:
        actual = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"python-runtime: invalid runtime provenance: {exc}"]
    toolchain = _object_map(contract.get("toolchain"), "toolchain")
    uv = _object_map(toolchain.get("uv"), "toolchain.uv")
    python = _object_map(toolchain.get("python"), "toolchain.python")
    expected = {
        **python,
        "uv_version": uv.get("version"),
        "uv_commit": uv.get("commit"),
    }
    errors: list[str] = []
    if actual != expected:
        errors.append("python-runtime: runtime provenance differs from the payload contract")
    build_path = root / "py" / "runtime" / "BUILD"
    if build_path.is_file():
        try:
            actual_build = build_path.read_text(encoding="ascii").strip()
        except OSError as exc:
            errors.append(f"python-runtime: cannot read standalone BUILD marker: {exc}")
        else:
            if actual_build != python.get("build"):
                errors.append(
                    "python-runtime: standalone BUILD marker differs from the payload contract"
                )
    return errors


def validate_payload(
    root: Path,
    grade_name: str,
    contract: dict[str, object],
    *,
    run_runtime_probes: bool = True,
    dev_root: Path | None = None,
    require_complete_release: bool = False,
    require_dev_parity: bool = False,
    probe_timeout_seconds: int = 300,
) -> dict[str, object]:
    components = _object_map(contract.get("components"), "components")
    grades = _object_map(contract.get("grades"), "grades")
    if grade_name not in grades:
        raise ContractError(
            f"unknown grade {grade_name!r}; expected one of {', '.join(sorted(grades))}"
        )
    grade = _object_map(grades[grade_name], f"grades.{grade_name}")
    grade_component_names = _string_list(
        grade.get("components"), f"grades.{grade_name}.components"
    )
    component_names = (
        _string_list(
            contract.get("complete_release_components"),
            "complete_release_components",
        )
        if require_complete_release
        else grade_component_names
    )
    errors: list[str] = []
    runtime_evidence: dict[str, object] = {}
    for name in component_names:
        component_errors, evidence = _validate_component(
            root,
            name,
            _object_map(components.get(name), f"components.{name}"),
            run_runtime_probes=run_runtime_probes,
            probe_timeout_seconds=probe_timeout_seconds,
        )
        errors.extend(component_errors)
        if evidence is not None:
            runtime_evidence[name] = evidence
    if "python-runtime" in component_names:
        errors.extend(_validate_runtime_provenance(root, contract))
    errors.extend(audit_python_references(root))
    difference: dict[str, object] | None = None
    if dev_root is not None:
        difference = compare_payloads(root, dev_root)
        if require_dev_parity and difference["different"]:
            errors.append(
                "release payload differs from development payload while exact parity is required"
            )
    result: dict[str, object] = {
        "ok": not errors,
        "grade": grade_name,
        "payload_root": str(root),
        "required_components": grade_component_names,
        "verified_components": component_names,
        "complete_release_required": require_complete_release,
        "runtime_probe_timeout_seconds": probe_timeout_seconds,
        "runtime_evidence": runtime_evidence,
        "errors": errors,
        "size": _component_sizes(root, component_names, components),
        "payload_size": _tree_size(root),
    }
    if difference is not None:
        result["release_vs_dev"] = difference
    return result


def _print_report(result: dict[str, object]) -> None:
    status = "PASS" if result.get("ok") else "FAIL"
    print(
        f"{status} native payload grade={result.get('grade')} "
        f"root={result.get('payload_root')}"
    )
    for error in result.get("errors", []):
        print(f"- {error}")
    size = _object_map(result.get("size"), "result.size")
    total = int(size.get("total_bytes", 0))
    print(
        f"size: {total} bytes ({total / (1024 * 1024):.1f} MiB), "
        f"{size.get('file_count')} files"
    )
    component_bytes = _object_map(size.get("component_bytes"), "result.size.component_bytes")
    component_file_counts = _object_map(
        size.get("component_file_counts"), "result.size.component_file_counts"
    )
    for name, value in component_bytes.items():
        count = int(value)
        print(
            f"  {name}: {count} bytes ({count / (1024 * 1024):.1f} MiB), "
            f"{component_file_counts.get(name)} files"
        )
    payload_size = _object_map(result.get("payload_size"), "result.payload_size")
    print(
        f"payload tree: {payload_size.get('total_bytes')} bytes, "
        f"{payload_size.get('file_count')} files"
    )
    difference = result.get("release_vs_dev")
    if isinstance(difference, dict):
        print(
            "release-vs-dev: "
            f"different={difference.get('different')} "
            f"missing={difference.get('missing_from_release_count')} "
            f"release-only={difference.get('release_only_count')} "
            f"size-changed={difference.get('size_changed_count')} "
            f"content-changed={difference.get('content_changed_count')}"
        )


def verify_payload_manifest(payload_root: Path) -> dict[str, object]:
    """Run the runtime's own manifest check over ``payload_root``.

    The checks above read the payload's shape; this one reads its bytes against
    the recorded manifest, and is the only thing here that notices an executable
    that grew because something signed it after the manifest was written.

    Imported lazily: the shape checks must stay runnable with plain ``python``,
    and only callers that go through ``uv run --directory host/sandbox_manager``
    can import ``sandbox_manager``.
    """
    try:
        from sandbox_manager.payload_integrity import PayloadIntegrityError, verify_payload
    except ImportError as exc:
        return {
            "ok": False,
            "error": (
                "sandbox_manager.payload_integrity is not importable, so the manifest "
                f"cannot be verified: {exc}"
            ),
        }
    try:
        verified = verify_payload(payload_root)
    except PayloadIntegrityError as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "payload_version": verified.payload_version,
        "file_count": verified.file_count,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("payload_root", nargs="?", type=Path)
    parser.add_argument("--grade", default="minimal")
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument("--dev-root", type=Path)
    parser.add_argument("--require-complete-release", action="store_true")
    parser.add_argument("--require-dev-parity", action="store_true")
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument("--check-dependency-locks", action="store_true")
    parser.add_argument(
        "--uv",
        help=(
            "uv executable to enforce the pinned toolchain against; defaults to the "
            "one on PATH. Pass the build's provisioned uv "
            "(build\\_toolchain\\uv\\uv-<version>-<commit>\\uv.exe) to check the "
            "same binary the payload was staged with."
        ),
    )
    parser.add_argument(
        "--verify-manifest",
        action="store_true",
        help=(
            "also verify payload bytes against manifest.json with "
            "sandbox_manager.payload_integrity (requires that package on sys.path)"
        ),
    )
    parser.add_argument("--skip-runtime-probes", action="store_true")
    parser.add_argument(
        "--runtime-probe-timeout-seconds",
        type=int,
        help=(
            "per-interpreter cold import timeout; defaults to the contract value "
            "or NATIVE_PAYLOAD_PROBE_TIMEOUT_SECONDS"
        ),
    )
    parser.add_argument("--json-output", type=Path)
    parser.add_argument(
        "--audit-release-stage",
        type=Path,
        metavar="BUILD_SCRIPT",
        help="confirm complete /MIR release staging without a py exclusion",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        contract = load_contract(args.contract)
        reports: dict[str, object] = {}
        if args.audit_release_stage is not None:
            audit = audit_release_stage_policy(args.audit_release_stage, contract)
            reports["release_stage"] = audit
            print(json.dumps(audit, indent=2))
            if not audit.get("detected") or audit.get("expected_status") != "closed":
                return 1
        if args.check_dependency_locks:
            if args.repo_root is None:
                raise ContractError("--repo-root is required with --check-dependency-locks")
            lock_report = validate_dependency_locks(
                args.repo_root.resolve(), contract, args.uv
            )
            reports["dependency_locks"] = lock_report
            print(json.dumps(lock_report, indent=2))
            if not lock_report["ok"]:
                return 1
        if args.payload_root is None:
            if reports:
                return 0
            raise ContractError(
                "payload_root is required unless only auditing staging or dependency locks"
            )
        if args.verify_manifest:
            # Before the shape checks: this one is cheap relative to the runtime
            # probes and a payload whose bytes do not match its manifest is
            # already unshippable, whatever its shape.
            manifest_report = verify_payload_manifest(args.payload_root.resolve())
            reports["manifest"] = manifest_report
            print(json.dumps(manifest_report, indent=2))
            if not manifest_report["ok"]:
                return 1
        if args.require_dev_parity and args.dev_root is None:
            raise ContractError("--dev-root is required with --require-dev-parity")
        timeout_value = args.runtime_probe_timeout_seconds
        if timeout_value is None:
            env_timeout = os.environ.get("NATIVE_PAYLOAD_PROBE_TIMEOUT_SECONDS")
            timeout_value = (
                int(env_timeout)
                if env_timeout
                else int(contract.get("runtime_probe_timeout_seconds", 300))
            )
        if timeout_value <= 0:
            raise ContractError("runtime probe timeout must be greater than zero")
        result = validate_payload(
            args.payload_root.resolve(),
            args.grade,
            contract,
            run_runtime_probes=not args.skip_runtime_probes,
            dev_root=args.dev_root.resolve() if args.dev_root is not None else None,
            require_complete_release=args.require_complete_release,
            require_dev_parity=args.require_dev_parity,
            probe_timeout_seconds=timeout_value,
        )
        result.update(reports)
    except (ContractError, ValueError) as exc:
        print(f"payload contract error: {exc}", file=sys.stderr)
        return 2
    _print_report(result)
    if args.json_output is not None:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
