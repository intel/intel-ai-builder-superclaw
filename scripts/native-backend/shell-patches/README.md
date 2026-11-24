# shell-patches

Patches applied to the pinned brush crates when `Build-PinnedBrush`
(`../shell-toolchain-policy.ps1`) builds the payload's `shell\sh.exe` and
`shell\bash.exe`.

- **Contract implemented:** `toolchain.shell.brush.patched_crates` in
  `../native-payload-contract.json`, which pins each patched crate's version and
  SHA-256 and names its patch.
- **Allowed dependencies:** none. Each patch is a unified diff against one pinned crate.
- **Verification:** `python -m pytest scripts/native-backend/tests/test_shell_toolchain.py`.

## brush-core-windows-heredoc.patch

brush 0.4.0 (brush-core 0.5.0) writes a here-document's whole body into an
anonymous pipe before starting the command. Linux enlarges the pipe first; a
Windows pipe holds 4 KiB and cannot be resized, so any here-document over 4 KiB
hangs the shell. Agents often write files with `cat > file << EOF`, so this
stalled real tasks. On Windows the patch writes the body from a separate thread.

Upstream `reubeno/brush` still has the same code. Drop this patch once a release
fixes it and the pin moves to that release.
