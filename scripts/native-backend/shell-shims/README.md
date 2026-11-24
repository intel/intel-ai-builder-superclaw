# shell-shims

Small executables the native payload needs that no upstream release provides.

- **Owner:** the native payload build (`scripts/native-backend`).
- **Contract implemented:** the pinned shell (`toolchain.shell` in
  `../native-payload-contract.json`) and the payload's `py\venv-launcher` component.
- **Allowed dependencies:** the Rust standard library only.
- **Built by:** `Build-AwkShim` in `../shell-toolchain-policy.ps1` and
  `Build-VenvLauncherShim` in `../venv-launcher-policy.ps1`, during
  `build-native-backend.ps1`.

| Shim | Installed as | Why |
|---|---|---|
| `awk/` | `shell\awk.exe` | Runs the pinned `goawk.exe` beside it with `-N raw`, because GoAWK writes `\r\n` on Windows by default while the rest of the shell writes `\n`. It also makes `*`, `?` and `[` in file operands literal, because GoAWK globs them on Windows and a POSIX awk does not. |
| `venv-launcher/` | `py\venv-launcher\python.exe`, `python3.exe`, `pip.exe` | On the `file_tool` runtime's `PATH` ahead of the read-only agent interpreter. Each forwards into the tier's writable task venv named by `VIRTUAL_ENV`, and falls back to the payload's own interpreter when that venv is missing. Because the shims live in the read-only payload, the tier can run them but never change what they resolve to. |

Tests, from the repository root:

```powershell
cargo test --manifest-path scripts\native-backend\shell-shims\awk\Cargo.toml --locked
cargo test --manifest-path scripts\native-backend\shell-shims\venv-launcher\Cargo.toml --locked
```
