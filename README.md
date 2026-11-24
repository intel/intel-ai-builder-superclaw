# SuperClaw

SuperClaw is a Windows-local AI agent desktop app. It combines a Tauri/SolidJS
desktop UI, Python host services (a supervisor called ServiceHub, an LLM router,
privacy, speech and sandbox managers), and a Windows-native sandbox that runs the
OpenWork/OpenCode agent stack. It uses no WSL, Docker or virtual machine.

This repository builds the Windows x64 **Debug** application from source.
OpenCode and llama.cpp are built from pinned upstream sources plus the patches in
this repository; no prebuilt binaries of them are downloaded. If a
`LOCAL_DEBUG_ONLY.md` file is present, this checkout is a local test snapshot that
has not been approved for publication.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/ui/` | SolidJS frontend |
| `apps/desktop/` | Tauri desktop shell and sidecar preparation |
| `host/` | ServiceHub and the host services it supervises (Python, one `uv` workspace) |
| `host/native_isolation_broker/` | Rust broker that creates the sandbox's per-role Windows accounts, sets file ACLs and launches sandbox roles |
| `sandbox/server/` | OpenWork Server, the API the UI talks to for chat |
| `sandbox/orchestrator/` | Supervisor for the sandbox processes |
| `sandbox/channels/` | Slack/Telegram bridge (OpenCode Router) |
| `sandbox/agent_config/profiles/` | The `lite`, `standard` and `pro` Product Profiles |
| `shared/` | Wire contracts and shared utility/policy packages |
| `third_party/` | OpenCode and llama.cpp as pinned Git submodules |
| `patches/` | SuperClaw's OpenCode and llama.cpp patches; `patches/upstream.lock.json` pins commits and hashes |
| `scripts/patches/` | Patch application and the llama.cpp build script |
| `scripts/native-backend/` | Builds the sandbox payload (the executables and tools the sandbox runs) |
| `packaging/installer/` | Build entry point (`build-superclaw.ps1`) and its ServiceHub/UI steps |
| `packaging/docker/` | OpenCode runtime build scripts and document-reader sources (no Docker is used) |

A **Product Profile** is the packaged configuration that decides which agents and
features the app offers. ServiceHub selects one at runtime based on the hardware
and the available models, so not every feature in the source tree is active on
every machine.

## Before you start

- **OS:** Windows 11 x64 with the Microsoft Edge WebView2 Runtime (preinstalled
  on Windows 11).
- **Short checkout path,** such as `C:\code\superclaw`, and Windows long-path
  support enabled. From an elevated PowerShell, then reboot:

  ```powershell
  Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Type DWord -Value 1
  ```

- **Internet access.** The build downloads packages from npm, PyPI and crates.io,
  pinned toolchains (Python, uv, Node.js, GitHub CLI, shell tools) from GitHub and
  nodejs.org, the oneDNN source, and llama.cpp UI assets.
- **Disk and time.** Plan for tens of gigabytes beyond the tool installs: the Rust
  build directory alone is about 5 GB and the sandbox payload about 1.3 GB. A cold
  build has not been timed. The one-time oneDNN and llama.cpp compiles take the
  longest; a rebuild with warm caches took about 3.5 minutes.

## Prerequisites

Install these, then open a new PowerShell window so the PATH changes apply.

| Tool | Version | Install |
| --- | --- | --- |
| Git | any recent | `winget install -e --id Git.Git` |
| Node.js | 20 (see `.nvmrc`) | [nodejs.org](https://nodejs.org/) or a version manager (`nvm install 20`) |
| pnpm | 10.34.3 | `npm install -g pnpm@10.34.3` |
| Rust | stable, MSVC toolchain | `winget install -e --id Rustlang.Rustup`, then `rustup default stable-msvc` |
| Visual Studio C++ build tools | 2022 or later, with the Windows SDK | see below |
| CMake and Ninja | tested with CMake 4.4.5, Ninja 1.13.2 | included in Visual Studio's "C++ CMake tools for Windows" component, or `winget install -e --id Kitware.CMake` and `winget install -e --id Ninja-build.Ninja` |
| uv | any recent | `winget install -e --id astral-sh.uv` |
| Intel oneAPI Deep Learning Essentials | 2026.1.x (ICX compiler 2026.1.x) | [Intel download page](https://www.intel.com/content/www/us/en/developer/tools/oneapi/oneapi-toolkit-download.html?packages=dl-essentials&dl-essentials-os=windows&dl-win=offline) |
| Bun | exactly 1.3.14 | installed locally in step 2 |

Visual Studio Build Tools with the C++ workload (its recommended components
include the Windows SDK and the CMake tools):

```powershell
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Notes:

- You do not need to install the Tauri CLI or Python separately. The pnpm
  workspace provides the Tauri CLI, and `uv` downloads the Python 3.12 that
  `host/.python-version` selects.
- Install oneAPI to its default location, `C:\Program Files (x86)\Intel\oneAPI`,
  or pass `-OneApiRoot` to the llama.cpp build script.
- oneDNN does not need to be installed in advance (see step 3).
- The tested build used Visual Studio 2026 (MSVC 19.51) and ICX 2026.1.1.

## Build the Debug application

Run every command from PowerShell at the repository root.

### 1. Clone with submodules

Set the URL to the one shown by the repository's **Code** button:

```powershell
$RepositoryUrl = '<repository-url>'
git clone --recurse-submodules $RepositoryUrl C:\code\superclaw
Set-Location C:\code\superclaw
git submodule update --init --recursive
git submodule status
```

Keep both submodules at the commits this repository pins: do not run
`git submodule update --remote` or edit their working trees. A ZIP download does
not work, because the build scripts verify submodule pins and read the commit ID.

### 2. Install JavaScript dependencies and the pinned Bun

The OpenCode build refuses any Bun version other than the one pinned in
`scripts/ci/install-bun.sh` (1.3.14). This installs that version under the ignored
`.cache/` directory without touching a global Bun:

```powershell
$RepoRoot = (Get-Location).Path
npm install --prefix .cache/build-tools bun@1.3.14 --no-audit --no-fund
$env:Path = "$(Join-Path $RepoRoot '.cache\build-tools\node_modules\bun\bin');$env:Path"
bun --version
pnpm install --frozen-lockfile
```

`bun --version` must print `1.3.14`. The PATH change lasts only for this
PowerShell window: rerun the `$RepoRoot` and `$env:Path` lines in any new window
before building.

### 3. Build llama.cpp (the local inference server)

SuperClaw runs local models with `llama-server` from llama.cpp, built with Intel's
SYCL GPU backend. That backend needs the oneAPI ICX compiler, oneAPI's runtime
libraries (which are copied into the app), and oneDNN, Intel's deep-learning
library. oneAPI Deep Learning Essentials does not include a oneDNN package that
CMake can use, so the build script can download oneDNN 3.13.4 source and compile
it once into `build\cache\onednn\3.13.4`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/patches/apply-patches.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/patches/build-llama-win-sycl.ps1 -BuildJobs 4
```

`apply-patches.ps1` creates the patched llama.cpp source at
`build\llama.cpp-src-patched`. The build script is interactive; run it in a
console where you can answer prompts:

1. It checks for Visual Studio, oneAPI, CMake, Ninja, curl and oneDNN. For anything
   missing, it offers to install it with winget, accept a path, or show
   instructions.
2. If no oneDNN 3.13.4 is found, answer **B** to build it from source. To use an
   existing oneDNN 3.13.4 instead, pass `-DnnlDir <path>\lib\cmake\dnnl`.
3. It prints a build summary and asks **Start compiling llama.cpp? [y/N]**.
   `-Yes` skips only this question; it still asks before replacing an existing
   stage directory or bundle.

`-BuildJobs` sets compile parallelism (default 2). The script downloads the
pinned DirectStorage 1.3.0 SDK and llama.cpp UI assets as needed. It stages the
result in `build\stage\llama-win-sycl`, checks the version, then copies it to
`host\llmrouter_manager\inference\llama-win-sycl`, where the ServiceHub build picks
it up. When that bundle already reports the pinned build (10830, commit
`fork-86b41bd6`), the script skips the build. See the
[llama.cpp build guide](scripts/patches/README.md) for all options.

### 4. Build SuperClaw

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging/installer/build-superclaw.ps1 `
  -Configuration Debug -SkipLocalSync
```

The entry point stops a running `SuperClaw.exe`, then:

1. Builds the OpenCode runtime from `third_party/opencode` plus its patch, unless
   a matching build already exists. Its patched source lives under
   `.cache\opencode-src\`.
2. Builds ServiceHub (`uv` and PyInstaller) and the Tauri UI in parallel, logging
   to `build\_logs\`. ServiceHub packaging fails if step 3's bundle is missing.
3. Builds the sandbox payload beside ServiceHub.

`-SkipLocalSync` is required for this repository: without it, the Debug build
also compiles a trajectory-inspector debugging tool whose sources are not
included here. No installer tool or signing certificate is needed.

### 5. Launch

```powershell
Start-Process .\build\Debug\SuperClaw.exe
```

On first launch, SuperClaw asks for administrator approval (UAC) once to create
the sandbox's local Windows accounts. Models are not part of the build: on
eligible Intel hardware the app downloads a local model on first launch.
Otherwise, connect a model under **Settings → Model**, using **Edge Server** for an
OpenAI-compatible endpoint or **Cloud Model** for a cloud provider.

## Build outputs and logs

| Output | Path |
| --- | --- |
| Desktop application | `build\Debug\SuperClaw.exe` |
| ServiceHub (all host services in one executable) | `build\Debug\servicehub\superclaw-services.exe` |
| Sandbox payload and its manifest | `build\Debug\servicehub\native-backend\` |
| Packaged llama.cpp bundle | `build\Debug\servicehub\inference\llama-win-sycl\` |
| OpenCode runtime | `packaging\docker\superclaw-runtime-bin\` |
| ServiceHub and UI build logs | `build\_logs\` |
| Per-step build timing | `build\_timing\` |
| llama.cpp build logs and provenance | `build\llama.cpp-src-patched\build-x64-windows-sycl-release\` |

At runtime, logs are under `%LOCALAPPDATA%\SuperClaw`: the desktop shell in `app\`,
each host service in its own folder (for example `servicehub\logs\`), and the
sandbox roles in `backend\logs\`.

## Rebuild after a change

Rerun step 4. To save time, skip the parts you did not change (keep the step 2
PATH line and `-SkipLocalSync`):

| You changed | Add to the step 4 command |
| --- | --- |
| Only `apps/` (UI or desktop shell) | `-SkipServiceHub -SkipNativeBackend` |
| Only `sandbox/server`, `sandbox/orchestrator` or `sandbox/channels` | `-SkipServiceHub -SkipUI` |
| Anything else (`host/`, Product Profiles, `shared/`, lockfiles) | nothing; rebuild everything |

A ServiceHub rebuild recreates `build\Debug\servicehub`, so it always rebuilds the
sandbox payload too. Add `-CleanUIDependencies` to reinstall `node_modules` and
rebuild the desktop crate from scratch.

To reset the app to a first-launch state, run
`packaging\installer\clean-superclaw.ps1`. It stops SuperClaw, removes the
sandbox accounts (UAC prompt) and deletes `%LOCALAPPDATA%\SuperClaw`, including
downloaded models; add `-KeepModels` to keep them. Build outputs under `build\`
are left alone.

## Troubleshooting

- **`bun X is on PATH, but runtime binaries must be built with bun 1.3.14`:**
  rerun the step 2 PATH lines in this window and check `bun --version`.
- **`Missing inference bundle source` during the ServiceHub build:** finish step 3.
- **`oneAPI DPC++ was not found` or `Expected an ICX 2026.1.x compiler`:** install
  Deep Learning Essentials 2026.1.x, or point `-OneApiRoot` at its root.
- **`Existing CMake build directory belongs to another source tree`:** delete
  `build\llama.cpp-src-patched\build-x64-windows-sycl-release` and rerun step 3.
- **`Source tree mismatch`, `Source worktree is not clean` or a submodule pin
  error:** restore the pinned submodule commits and unmodified `patches/`, then
  rerun `apply-patches.ps1`.
- **`uv sync --locked` fails:** `host/uv.lock` no longer matches a `pyproject.toml`.
  Undo the manifest change, or run `uv lock` in `host/` and keep the result.
- **Windows long path warning or path-too-long errors:** enable long paths (see
  [Before you start](#before-you-start)) and use a short checkout path.
- **Files in use during a rebuild:** close SuperClaw and wait for its background
  processes to exit. Do not use `clean-superclaw.ps1` for this: it also deletes
  downloaded models, settings and session data.

## Verification status

On 2026-11-10 an earlier snapshot of this source was built end to end on
Windows: OpenCode 1.18.25, oneDNN 3.13.4, llama.cpp build 10830
(`fork-86b41bd6`), ServiceHub, the Tauri UI and the sandbox payload, with version
checks, Product Profile packaging checks and payload verification passing. That check did not cover starting the app, model
inference or an installer. Some routing data and model assets are not part of
this repository, so a successful build does not mean every runtime feature is
available.

## Component documentation

- [Host services and Python workspace](host/README.md)
- [ServiceHub](host/servicehub/README.md)
- [LLMRouter Manager](host/llmrouter_manager/README.md)
- [SandboxManager](host/sandbox_manager/README.md)
- [Sandbox payload build](scripts/native-backend/README.md)
- [llama.cpp patch and build workflow](scripts/patches/README.md)
- [Third-party sources](third_party/README.md)
- [OpenWork supervisor](sandbox/orchestrator/README.md)
- [OpenWork Server](sandbox/server/README.md)
- [Channel bridge](sandbox/channels/README.md)
- [Shared contracts](shared/contracts/README.md)

## License

Apache License 2.0, except the `.patch` files under `patches/`, which are MIT. SuperClaw is
derived from [OpenWork](https://github.com/different-ai/openwork) 0.11.169 (MIT, Copyright (c)
2026 Different AI); OpenWork-derived portions remain under the MIT License. Third-party code keeps
its own license. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

SuperClaw is not affiliated with or endorsed by Different AI or the OpenWork project. The
`@different-ai/openwork-*`, `openwork-server`, `openwork-orchestrator` and `opencode-router`
package names and the `openwork` command are inherited from the fork. Third-party names and logos
are trademarks of their owners and identify integrations only.
