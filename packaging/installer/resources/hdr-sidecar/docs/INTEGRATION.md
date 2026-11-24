# Integration with SuperClaw

> Historical container wiring was removed with the WSL/Docker backend.
> The current product path is the Windows native backend.

## Product path (native)

1. **Payload** — `scripts/native-backend/build-native-backend.ps1` stages
   `py/hybrid-dr-venv` from `packaging/installer/resources/hdr-sidecar`.
2. **Lifecycle** — `sandbox_manager` starts the `hdr_sidecar` role in the
   `file_tool` tier when the committed Product Profile requires Hybrid Deep
   Research (`pro`).
3. **Tool glue** — OpenCode calls `hybrid_dr_post_polish_processor`, which
   talks HTTP to the sidecar on its per-boot loopback port.

Details and troubleshooting:
[`scripts/native-backend/README.md`](../../../../../scripts/native-backend/README.md).

## Deferred Linux artifact (#3047)

`packaging/installer/build-hdr-sidecar.ps1` still builds a Linux onedir under
`vendor/hdr-sidecar/linux-x64/`. That path is owned separately and is not how
the Windows app launches Hybrid Deep Research today.
