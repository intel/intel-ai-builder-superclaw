"""Seed OpenCode's XDG config dependencies before starting the file_tool role."""

from pathlib import Path
import shutil
import stat

from loguru import logger


def _require_plain_destination(root: Path, destination: Path) -> None:
    current = root
    for component in ("", *destination.relative_to(root).parts):
        if component:
            current /= component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            return
        except OSError:
            logger.error(
                "native-backend: global config dependencies phase=seed event=refused "
                "reason=path_inspection_failed path={}",
                current,
            )
            raise
        if stat.S_ISLNK(metadata.st_mode) or (
            getattr(metadata, "st_file_attributes", 0)
            & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        ):
            logger.error(
                "native-backend: global config dependencies phase=seed event=refused "
                "reason=reparse_point path={}",
                current,
            )
            raise RuntimeError(f"Global config dependency destination is a reparse point: {current}")


def seed_runtime_global_config(*, config_source: Path, data_dir: Path) -> None:
    source_modules = config_source / "node_modules"
    source_package = config_source / "package.json"
    source_lock = config_source / "package-lock.json"
    plugin_manifest = Path("@opencode-ai") / "plugin" / "package.json"
    # Read the verified build inputs before modifying an existing installation.
    package_bytes = source_package.read_bytes()
    lock_bytes = source_lock.read_bytes()
    plugin_bytes = (source_modules / plugin_manifest).read_bytes()

    target = data_dir / "file_tool" / "config" / "opencode"
    modules = target / "node_modules"
    package = target / "package.json"
    lock = target / "package-lock.json"
    installed_plugin = modules / plugin_manifest
    # Inspect root-to-leaf before even the reuse reads can follow a redirected path.
    for destination in (installed_plugin, package, lock):
        _require_plain_destination(data_dir, destination)
    if (
        package.is_file()
        and lock.is_file()
        and installed_plugin.is_file()
        and package.read_bytes() == package_bytes
        and lock.read_bytes() == lock_bytes
        and installed_plugin.read_bytes() == plugin_bytes
    ):
        logger.info("native-backend: global config dependencies phase=seed event=reused")
        return

    target.mkdir(parents=True, exist_ok=True)
    # The lock is the completion marker: an interrupted copy must be retried.
    lock.unlink(missing_ok=True)
    if modules.exists():
        shutil.rmtree(modules)
    # copytree/copy2 preserve file contents and metadata, not build-account ACLs.
    # New files inherit the provisioned file_tool subtree's access rights.
    shutil.copytree(source_modules, modules)
    shutil.copy2(source_package, package)
    shutil.copy2(source_lock, lock)
    logger.info("native-backend: global config dependencies phase=seed event=copied")
