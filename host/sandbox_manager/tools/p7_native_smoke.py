from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace

from sandbox_manager.native_backend import NativeBackendLifecycle
from sandbox_manager.owt_cache import OwtCache
from sandbox_manager.product_profile_source import compute_product_profile_digest
from sandbox_manager.store import RUNTIME_DEPLOYMENT_CONFIG_KEY, Store


class Handle:
    def message(self, value: str) -> None:
        print(f"SMOKE_STAGE={value}", flush=True)

    def progress(self, value: float, **_kwargs: object) -> None:
        print(f"SMOKE_PROGRESS={value}", flush=True)

    def raise_if_cancelled(self) -> None:
        return

    def done(self, **_kwargs: object) -> None:
        print("SMOKE_DONE=1", flush=True)


def alive(process) -> bool:
    return process is not None and process.poll() is None


async def main() -> None:
    repo = Path(__file__).resolve().parents[3]
    local = Path(os.environ["LOCALAPPDATA"])
    state = local / "SuperClaw" / "backend"
    resources = local / "SuperClaw" / "sandbox_manager" / "resources" / "native-backend"
    workspace = Path(os.environ["USERPROFILE"]) / "SuperClawProjects" / "P7Smoke"
    profile = repo / "sandbox" / "agent_config" / "profiles" / "standard"
    os.environ.update(
        SUPERCLAW_NATIVE_BACKEND_BIN_DIR=str(resources),
        SUPERCLAW_NATIVE_BACKEND_STATE_DIR=str(state),
        SUPERCLAW_NATIVE_BACKEND_PROFILES_ROOT=str(profile.parent),
        WINDOWS_SUPERCLAW_PATH=str(workspace),
    )
    workspace.mkdir(parents=True, exist_ok=True)
    store = Store(state / "p7-smoke.db")
    store.set_config("persistent", False)
    store.set_config(
        RUNTIME_DEPLOYMENT_CONFIG_KEY,
        {
            "schema_version": 2,
            "deployment_id": "runtime-deployment-" + "7" * 32,
            "product_profile_id": "standard",
            "product_profile_digest": compute_product_profile_digest(profile),
            "profile_revision": 1,
            "source_operation_id": None,
        },
    )
    lifecycle = NativeBackendLifecycle(
        cfg=SimpleNamespace(resources_dir=resources.parent, sandbox_port=8787),
        store=store,
        run_manager=SimpleNamespace(),
        owt_cache=OwtCache(),
    )
    report: dict[str, object] = {}
    try:
        await lifecycle._ensure_worker(Handle())
        report["status"] = lifecycle.status()
        report["supervisor_pid"] = lifecycle._proc.pid if lifecycle._proc else None
        report["runtime_pid"] = lifecycle._runtime_proc.pid if lifecycle._runtime_proc else None
        report["router_pid"] = lifecycle._router_proc.pid if lifecycle._router_proc else None
        report["openwork_server_pid"] = (
            lifecycle._openwork_server_proc.pid if lifecycle._openwork_server_proc else None
        )
        report["connector_service_pid"] = (
            lifecycle._connector_proc.pid if lifecycle._connector_proc else None
        )
        launches = (
            lifecycle._proc,
            lifecycle._connector_proc,
            lifecycle._openwork_server_proc,
            lifecycle._router_proc,
            lifecycle._runtime_proc,
        )
        report["all_alive"] = all(
            alive(process)
            for process in launches
        )
        report["owt_present"] = lifecycle._owt.is_present()
        report["connector_healthy"] = await lifecycle._connector_healthy()
        report["supervisor_ready"] = lifecycle._supervisor_ready()
        client = lifecycle._connector_client_config_path
        provider = lifecycle._connector_provider_config_path
        report["client_file_exists"] = bool(client and client.is_file())
        report["provider_file_exists"] = bool(provider and provider.is_file())
        print("SMOKE_RUNNING=" + json.dumps(report, sort_keys=True), flush=True)
        required_running = ("all_alive", "owt_present", "connector_healthy", "supervisor_ready", "client_file_exists", "provider_file_exists")
        if report["status"].get("phase") != "running" or not all(report[key] is True for key in required_running):
            raise RuntimeError("P7 smoke startup acceptance failed")
        pids = [process.pid for process in launches if process]
        await lifecycle.shutdown()
        report["status_after_stop"] = lifecycle.status()
        report["owt_removed"] = not lifecycle._owt.is_present()
        report["all_stopped"] = all(
            process.poll() is not None
            for process in launches
            if process is not None
        )
        report["client_file_removed"] = not client or not client.exists()
        report["provider_file_removed"] = not provider or not provider.exists()
        report["pids"] = pids
        print("SMOKE_STOPPED=" + json.dumps(report, sort_keys=True), flush=True)
        if (report["status_after_stop"].get("phase") != "stopped"
            or not all(report[key] is True for key in ("all_stopped", "client_file_removed", "provider_file_removed", "owt_removed"))):
            raise RuntimeError("P7 smoke cleanup acceptance failed")
    finally:
        try:
            await lifecycle.shutdown()
        except Exception as exc:
            print(f"SMOKE_FINAL_CLEANUP_ERROR={type(exc).__name__}", flush=True)
        store.close()


if __name__ == "__main__":
    asyncio.run(main())
