# Adding A Shipped Host Service

Use this checklist to add a Windows-host service without changing ServiceHub
business code. ServiceHub is a supervisor and HTTP gateway, not a plugin system.
`service_cfg.json` is the single process-lifecycle contract.

## Add Or Extend?

Add a service only when the feature needs its own process lifecycle, failure
domain, native dependencies, or approved data-plane port.
Otherwise, add routes to the existing service that already owns the feature.

Do not use a Host Service to switch an active model or model binding. That
belongs to ModelRouter/Model Binding.

Before implementation, evaluate and record two resource decisions:

- Can the service process start on demand? Prefer `on_demand` when the feature
  is not needed at App boot, to protect startup time and baseline memory use.
- Can large models or other assets download only on first use? Prefer that when
  it materially reduces installer size, while accounting for offline use,
  first-use latency, download consent, progress, failure, and retry behavior.

Process startup and asset loading are separate decisions. An `on_demand`
service may still load assets lazily and unload them after idle, as TTS does.

## Required Changes

1. **Package and HTTP contract**
   - Add an installable package under `host/` and register it in
     `host/pyproject.toml`.
   - Support `python -m <entrypoint> --host <host> --port <port>`.
   - Implement unauthenticated `GET /<prefix>/v1/health` returning the exact
     injected `SERVICEHUB_SERVICE_NAME`, `SERVICEHUB_INSTANCE_ID`, `status:
     "ok"`, and a positive `pid`.
   - Implement graceful `POST /<prefix>/v1/shutdown`.
   - Bind to `127.0.0.1` unless an approved data-plane caller requires
     `0.0.0.0`. Do not print a child READY handshake or add a child token.
   - Call `install_crash_hooks(service=..., release=...)` from
     `superclaw_host_observability` in the entrypoint, and depend on the
     `superclaw-host-observability` workspace member.
   - Use `host/tts_manager/` as the small `on_demand` reference implementation.

2. **Process declaration**
   - Add the service to `host/servicehub/service_cfg.json` with a unique name,
     prefix, and fixed port.
   - Use `startup: "required"` for boot-critical services or
     `startup: "on_demand"` for optional services. `required` is the default.
   - An `on_demand` service may depend only on required services. No service may
     depend on an `on_demand` service.
   - Keep ports, entrypoints, dependencies, and restart policy only in
     `service_cfg.json`.
   - The desktop port preflight (`apps/desktop/src-tauri/src/port_preflight`)
     reads `service_cfg.json` and never gates an `on_demand` port. Add an
     `on_demand` port to `the_shipped_service_cfg_gates_required_ports_only`
     in its `tests.rs`; add a `required` one to `FALLBACK_SERVICEHUB_PORTS` in
     `ports.rs`.

3. **Merged executable**
   - Register the role in `_SERVICES` and its critical imports in
     `_SMOKE_TARGETS` in
     `host/superclaw_services/_pyinstaller_entry.py`.
   - Add the role to `$ChildRoles` in
     `packaging/installer/build-servicehub.ps1` and `$expectedRoles` in
     `packaging/installer/tests/assert-servicehub-children.ps1`.

4. **PyInstaller assets**
   - Update `host/superclaw_services/superclaw_services.spec` with only the
     service's required `pathex`, hidden imports, data files, and native
     libraries.
   - Keep service-specific assets explicit. Do not introduce a Host Feature
     Manifest or generated build DSL.
   - Add the package root to `SourceRoot` in
     `packaging/installer/build-pyinstaller-cache.ps1`, or an edit to it can
     reuse a stale cached Analysis.

5. **App wiring**
   - The App calls `/<prefix>/...` through the ServiceHub URL and bearer token;
     it never calls the child port or starts the process itself.
   - Use `requestServiceHubJson` or `requestServiceHubBinary` from
     `apps/ui/src/app/lib/servicehub.ts`.
   - For an optional UI feature, discover the service with authenticated
     `GET /app/services/catalog`. Discovery and health/version requests do not
     start an `on_demand` service; the first authenticated business request
     does.
   - Handle an absent declaration and `service_start_failed` legibly. Do not
     assume a Profile-specific service exists in every Product Profile.

6. **Security, CI and docs**
   - Add the port, its open routes and at least one guarded route to
     `scripts/security/loopback-auth-matrix` (`AuthMatrix.psm1`, `$Ports` in
     `run.ps1`, the README table, the port assertion in
     `tests/AuthMatrix.Tests.ps1`).
   - Add `.github/workflows/unit-test-<service>.yml`. Its path triggers cover
     the package, `shared/contracts/generated/python/**`, `host/pyproject.toml`,
     `host/uv.lock`, `host/servicehub/service_cfg.json` and the workflow
     itself. Cases that need a real Windows host need a job on the
     self-hosted Windows runners (GitHub-hosted runners are not available
     here); a Linux-only lane skips them.
   - List the service in `docs/architecture.md` (start-up summary, repo tree,
     uv members, component table, deployment diagram, workflow list) and in
     `host/README.md`.

If the feature is Product Profile-specific, declare it in the relevant complete
Profile's `profile.json` and `opencode.jsonc`, then run
`pnpm product-profiles:check`. UI availability must use the validated active
Profile's `descriptor.feature_flags`.

## Verification

```powershell
# Contract suite
cd host/servicehub
uv run pytest -q

# Merged bundle, role/config consistency, and frozen import smokes
cd ../..
./packaging/installer/build-servicehub.ps1 -Configuration Debug -Clean

# Installed payload and advertised roles
./packaging/installer/tests/assert-servicehub-children.ps1 -Configuration Debug
```

Complete an installed-App smoke: verify required-service boot, dormant
`on_demand` discovery, one process under concurrent first requests, business API
behavior, watchdog restart with a new PID and `instance_id`, and graceful App
shutdown. Record the active `product_profile_id` from `GET /app/capability-profile`.
