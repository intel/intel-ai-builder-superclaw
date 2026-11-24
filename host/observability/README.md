# Host Observability (`superclaw-host-observability`)

Shared leaf adapter for crash reporting in ServiceHub-managed Python processes.

## Ownership

This package owns process-level `sys.excepthook` and `threading.excepthook` wiring, crash-record
scrubbing, consent-gated OTLP crash export, app-version resolution, and URL secret redaction for
log output (`mask_url_for_log`, the single copy; do not re-vendor it in a service). It does not own
service lifecycle, HTTP routes, runtime status, metrics, or business logging.

Public API (`superclaw_host_observability`): `install_crash_hooks(service=, release=)`,
`resolve_app_version(package_version=)`, `build_crash_record`, `scrub_crash_text`,
`mask_url_for_log`. Every host service calls `install_crash_hooks` from its entry point.

## Allowed dependencies

- Python standard library
- OpenTelemetry logs API/SDK and the OTLP HTTP exporter (imported lazily, only when export is on)

Host services may depend on this package. It must not depend on ServiceHub or any managed child
package.

## Contract

Implements the observability adapter boundary for structured `crash_reported` records (`release`,
`runtime`, `service`, `channel`, `outcome`, `error_class`, `error`, `stack`, plus `bundle_id`,
`install_id` and `servicehub_instance_id` when set). `install_id` is serialized only in the log body and must
never become a metric attribute.

Hooks are installed, and records exported, only when both `SUPERCLAW_FULL_TELEMETRY` is truthy
(the user's telemetry consent) and `OTEL_EXPORTER_OTLP_ENDPOINT` is set; otherwise
`install_crash_hooks` is a no-op. The original Python hooks still run afterwards.

| Env var | Used for |
|---|---|
| `SUPERCLAW_FULL_TELEMETRY`, `OTEL_EXPORTER_OTLP_ENDPOINT` | Consent gate and export endpoint. |
| `SUPERCLAW_BUILD_CHANNEL` | `channel` (`stable`, `beta`, else `dev`). |
| `SUPERCLAW_APP_VERSION` | Overrides the resolved `release`. |
| `SUPERCLAW_INSTALL_ID`, `SUPERCLAW_BUNDLE_ID`, `SERVICEHUB_INSTANCE_ID` | Optional record fields. |

## Crash-text privacy

Crash records remove URL credentials, queries and fragments. URL paths are replaced with
`/<redacted>` unless the origin and complete path match one of these approved local router URLs:

- `http://127.0.0.1:18321/v1/chat/completions`
- `http://127.0.0.1:18321/llm-router/v1/health`
- `http://127.0.0.1:18321/llm-router/v1/status`
- `http://127.0.0.1:18321/llm-router/v1/version`

Other ports, hosts, schemes and paths are not approved. Bare origins remain visible; malformed URLs
become `<redacted-url>`. Any `scheme://` URL is scrubbed (`redis://`, `postgresql://`, `wss://`,
...), not only `http(s)`; `file://` and other host-less URLs become `<redacted-url>`. Quotes and
punctuation directly after a URL (`'`, `)`, `.`, `,`, `;`, an unmatched `]`) are kept.

Windows user-directory paths and `/home/` or `/Users/` paths, with their file and folder suffixes,
become `~`. This also removes app-owned paths such as `C:\Users\<u>\AppData\Local\SuperClaw\...`,
which makes triage harder but is required.

- **Quoted paths** may contain spaces. Because apostrophes are legal in names (`O'Connor`), a
  closing quote ends a quoted path only when followed by whitespace, `,`, `)`, `]`, `:`, `;` or the
  end of the text. When the closing quote is ambiguous (`'.../Kids' Photos/x'`), redaction runs to
  the last such quote on the line, so two quoted paths on one line collapse into one `~`:
  over-redacting is preferred to leaking.
- **Unquoted paths** end at a double quote, a colon followed by whitespace (so
  `open /home/a/x: permission denied` keeps its error text), or the end of the line, since spaces
  may be part of a private path.

This crash-specific policy does not change `mask_url_for_log`.

## Verification

```powershell
cd host
uv run --package superclaw-host-observability pytest observability/tests
```
