# Patch and build upstream sources

SuperClaw builds two upstream projects from pinned public sources plus the
patches in `patches/`:

| Upstream | Submodule | Patch directory | Built by |
|---|---|---|---|
| llama.cpp | `third_party/llama.cpp` | `patches/llama.cpp/` | `build-llama-win-sycl.ps1` (this folder) |
| OpenCode | `third_party/opencode` | `patches/opencode/` | `packaging/docker/build-local-runtime.ps1`, run automatically by `packaging/installer/build-superclaw.ps1` |

`patches/upstream.lock.json` records each upstream URL and commit, the SHA-256
of every patch, and the expected Git tree after patching (`patched_tree`). The
scripts refuse to build when the submodule pin, the patch bytes or the patched
result do not match the lock. Patches are always applied to a separate Git
worktree; the submodules themselves stay unmodified.

Run every command below from the repository root in PowerShell.

## llama.cpp (Windows SYCL build)

The output is a runtime-only `llama-server` and `llama-bench` bundle for Intel
GPUs. ServiceHub packaging copies it from
`host\llmrouter_manager\inference\llama-win-sycl`, so build it before
`build-superclaw.ps1`.

### Prerequisites

- Git
- Visual Studio C++ Build Tools (with the Windows SDK), CMake and Ninja
- [Intel oneAPI Deep Learning Essentials v2026.1.4](https://www.intel.com/content/www/us/en/developer/tools/oneapi/oneapi-toolkit-download.html?packages=dl-essentials&dl-essentials-os=windows&dl-win=offline),
  which provides the ICX 2026.1.x SYCL/DPC++ compiler
- oneDNN 3.13.4: optional. If you do not have it, the build script offers to
  build the pinned source.
- DirectStorage SDK 1.3.0: optional. The build downloads it if you do not
  provide a local copy.

### 1. Apply the patches

```powershell
git submodule update --init third_party/llama.cpp
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\patches\verify-lock.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\patches\apply-patches.ps1
```

`verify-lock.ps1` checks the submodule URL and commit against the lock.
`apply-patches.ps1` runs the same check, creates a Git worktree of the submodule
at `build\llama.cpp-src-patched` (or `-Destination <path>`), applies the patch
series and confirms the resulting tree matches `patched_tree`. It needs no
configured Git identity.

On a rerun, a clean worktree that already matches is left alone. A clean
worktree that does not match is replaced only after you confirm (default No).
Dirty or unregistered directories are never removed. The prompts need an
interactive PowerShell session.

### 2. Build and stage

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\patches\build-llama-win-sycl.ps1 -BuildJobs 4
```

The default is 2 parallel jobs; raise `-BuildJobs` to compile faster if you have
the cores and memory.

The script:

1. Verifies the source lock. If the bundle in
   `host\llmrouter_manager\inference\llama-win-sycl` already reports the expected
   build number and commit, it stops here.
2. Finds Visual Studio (through `vswhere`; if `vswhere` is missing it downloads
   v3.1.7 from GitHub and checks its Microsoft signature), oneAPI (default
   `C:\Program Files (x86)\Intel\oneAPI`), CMake, Ninja, curl and oneDNN. For a
   missing dependency it offers the available choices: install, provide a path,
   open instructions, or cancel. It requires ICX 2026.1.x.
3. Shows a build summary and asks `Start compiling llama.cpp? [y/N]`. If an
   existing stage directory or a non-matching bundle would be replaced, it asks
   about that instead. Any answer other than `y` or `yes` cancels.
4. If you chose to build oneDNN, builds pinned v3.13.4 into
   `build\cache\onednn\3.13.4` (SYCL CPU and GPU runtimes, Graph enabled, shared
   library). This starts only after you confirm step 3.
5. Downloads and verifies the pinned llama.cpp web UI assets (see below), then
   configures the `x64-windows-sycl-release` preset and builds `llama-server` and
   `llama-bench`.
6. Stages the runtime files in `build\stage\llama-win-sycl`, validates them, and
   copies them to `host\llmrouter_manager\inference\llama-win-sycl`.

The existing stage directory and bundle are replaced only after a successful
build.

### Build script options

| Parameter | Default | Description |
|---|---|---|
| `-BuildJobs` | `2` | Parallel build jobs, 1-64. |
| `-Yes` | Off | Skips the `Start compiling` prompt only; dependency and replacement prompts still appear. |
| `-SourceDir` | `build\llama.cpp-src-patched` | Patched source tree. It must already exist: create it with `apply-patches.ps1 -Destination <path>`. |
| `-StageDir` | `build\stage\llama-win-sycl` | Staging directory. Inside the repository it must be under `build\stage`. |
| `-DnnlDir` | Cached package, or interactive choice | An installed oneDNN 3.13.4 CMake package directory, such as `<onednn>\lib\cmake\dnnl`. |
| `-DirectStorageDir` | Downloads the pinned SDK | Root of a local DirectStorage 1.3.0 SDK. |
| `-VcVars64` | Auto-detected | Path to Visual Studio's `vcvars64.bat`. |
| `-OneApiRoot` | `C:\Program Files (x86)\Intel\oneAPI` | oneAPI root; also used to find runtime DLLs. |
| `-OneApiSetvars` | `<OneApiRoot>\setvars.bat` | Path to oneAPI's `setvars.bat`. |

### Outputs and logs

| Output | Path |
|---|---|
| Inference bundle used by ServiceHub packaging | `host\llmrouter_manager\inference\llama-win-sycl\` |
| Staged copy | `build\stage\llama-win-sycl\` |
| CMake build tree | `<SourceDir>\build-x64-windows-sycl-release\` |
| `configure.log`, `build.log`, `toolchain-versions.log`, `llama-bundle-provenance.json` | the CMake build tree |

The bundle reports build `10830` (`upstream_build_number` in the lock) and commit
`fork-<first 8 hex characters of the patch-set SHA-256>`. A matching CMake/Ninja
cache is reused; for a clean build, apply into a new `-Destination` and pass the
same path as `-SourceDir`.

### Web UI assets

`llama-server` embeds a prebuilt web UI. The script downloads the pinned archive
(`b<upstream_build_number>`) from Hugging Face, falling back to
`https://hf-mirror.com` if that download fails. Either copy must match
`ui_archive_sha256` in the lock; a mismatch stops the build. The verified archive
is cached under `<build tree>\tools\ui\` and rehashed on reuse. When you move the
lock to a new upstream build number, update `ui_archive_sha256` from the official
`dist.tar.gz.sha256`.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `llama.cpp submodule checkout is at <sha>; lock requires <sha>` | Run `git submodule update --init third_party/llama.cpp`. An uninitialized submodule also reports this, with the superproject's own commit. |
| `Submodule worktree must be clean` | Undo local edits in `third_party\llama.cpp`; patches belong in `patches/llama.cpp/`. |
| `Destination exists but is not a registered llama.cpp worktree` | Move that directory away, or pass another `-Destination`. |
| `Existing CMake build directory belongs to another source tree` | Use a fresh `-SourceDir`, or delete only the named build directory. |
| `Unverified source-directory UI assets found at ...\tools\ui\dist` | Move that directory out of the source tree; the build provides verified UI assets itself. |
| `Expected an ICX 2026.1.x compiler` | Install oneAPI Deep Learning Essentials 2026.1.x, or point `-OneApiRoot` at it. |
| `Pinned UI ... could not be downloaded` | Allow access to `huggingface.co` or `hf-mirror.com` and rerun. |
| Compilation is slow | Raise `-BuildJobs`. |

## OpenCode

You normally do not run these scripts yourself: `build-superclaw.ps1` resolves the
OpenCode runtime through `packaging\docker\fetch-runtime-bin.ps1`, which rebuilds
it with `packaging\docker\build-local-runtime.ps1` when
`packaging\docker\superclaw-runtime-bin\superclaw-windows-x64.exe` is missing or
was built from a different lock fingerprint. That build requires Bun 1.3.14, the
version pinned in `scripts/ci/install-bun.sh`.

To check or apply the OpenCode patch by hand:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\patches\opencode-verify-lock.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\patches\opencode-apply-patches.ps1
```

`opencode-verify-lock.ps1` checks the `.gitmodules` URL, the pinned commit in the
Git index, each patch's SHA-256 (and that it has LF line endings), and that
`opencodeVersion` in `sandbox/orchestrator/package.json` matches the lock's
`upstream_version` (1.18.25). It does not need the submodule initialized, and it
prints the fingerprint the runtime binary's `.head` stamp must match.

`opencode-apply-patches.ps1` initializes `third_party/opencode` if needed and
creates the patched worktree under `.cache\opencode-src\<first 12 characters of
patched_tree>` (or `-Destination <path>`). The short path keeps Bun's
`node_modules` under the Windows path-length limit. A matching worktree is reused.

## Scripts

| Script | Purpose |
|---|---|
| `verify-lock.ps1` | Check the llama.cpp submodule against the lock. |
| `apply-patches.ps1` | Create the patched llama.cpp worktree. |
| `build-llama-win-sycl.ps1` | Build, stage and install the llama.cpp SYCL bundle. |
| `patch-set.ps1`, `ui-assets.ps1` | Helpers dot-sourced by the llama.cpp scripts. |
| `opencode-verify-lock.ps1` | Check the OpenCode pin and patch files against the lock. |
| `opencode-apply-patches.ps1` | Create the patched OpenCode worktree. |

Owners: build and release maintainers. Dependencies: PowerShell 5.1, Git, curl and
the build tools listed above. Regression tests:
`python -B -m unittest discover -s scripts/tests -p "test_llama_*.py" -v`.
