<#
.SYNOPSIS
PyInstaller --workpath cache gate, dot-sourced by the ServiceHub build scripts.

.DESCRIPTION
PyInstaller caches its module graph (Analysis-00.toc) and the compiled PYZ under
--workpath. Reusing that cache is the difference between a ~150 s module-graph
analysis and a ~10 s COLLECT-only copy for privacy_manager, so the Debug build
keeps it instead of wiping it every run.

PyInstaller decides on its own whether the cache is still valid, but it decides by
mtime: `_check_guts_toc_mtime` rebuilds only when a file listed in the cached TOC
is newer than the TOC itself. Any content change that does not advance mtime is
therefore invisible to it, and a fresh exe gets re-linked around stale cached
bytecode while BUILD_COMMIT advertises the new git hash. That is not theoretical —
restoring a file with a preserved timestamp (`Move-Item` of a backup, an unzip,
`robocopy /COPY:DAT`, a restored source copy) reproduces it in one build.

So the mtime check is backed by content: this module hashes the service's own
Python sources and stores the digest inside the workpath. A digest mismatch wipes
the cache before PyInstaller ever looks at it, which turns the guarantee from
"every edit bumps mtime" into "the sources are byte-for-byte what this cache was
built from".

Two kinds of input feed the digest, because the cache binds both:

1. Our own Python sources, whose content the PYZ embeds directly.
2. The identity of the INSTALLED dependencies, because `Analysis-00.toc` records
   the resolved path of every third-party module it pulled in and the PYZ embeds
   their compiled bytecode. Bump a version in `uv.lock` and the cache is stale in
   exactly the same way an unnoticed source edit makes it stale — the difference is
   that nothing in the build even looks at the sources of those packages, so the
   staleness is completely silent.

(2) is deliberately fingerprinted by proxy rather than by content: hashing all
174 installed packages' `.py` files costs several seconds, which is most of the
time the cache exists to save. So the declared inputs (`uv.lock`, the workspace
`pyproject.toml` files, `.python-version`) are hashed, and the materialized
environment is covered by the sorted list of `site-packages\*.dist-info`
directory names — those names carry the name and version of every installed
package, so the whole check is one directory enumeration with no file reads. The
declared and the materialized inputs are both hashed because either can move
without the other: a `-SkipUvSync` build or a manual `uv pip install` changes the
environment with the lockfile untouched.

Everything a spec lists in `datas` (models, config, the loosely-bundled service
packages) is re-copied from its original path by COLLECT on every single build,
cache or not, and so cannot go stale. Those are not hashed.

Nor are files that cannot reach the bundle at all (a service's own `tests\`, see
Get-ServiceHubSourceInputs): hashing them turns a test-only edit into a cold
Analysis for a bundle that is byte-for-byte the same. The exclusion is opt-in per
caller (-ExcludeRootDirectory) and only as wide as the spec's collection rules
justify, because the two errors are not symmetric: hashing too much costs build
time, hashing too little ships stale bytecode.
#>

Set-StrictMode -Off

function Get-HostDependencyInputs {
    <#
    .SYNOPSIS
    Every file under host/ whose content can change what gets installed into the venv.

    .DESCRIPTION
    Returned as a flat, de-duplicated list for -DependencyFile. Member manifests are
    DISCOVERED rather than listed, so adding a workspace member cannot silently fall
    out of the cache key — the failure mode of a hardcoded list is a member whose
    dependency bump reuses a stale module graph forever.

    `.venv` and build output are excluded from the walk: the installed copies of
    these manifests are not resolution inputs, and walking them is what makes the
    enumeration slow.
    #>
    param([Parameter(Mandatory)][string]$HostDir)

    $inputs = New-Object System.Collections.Generic.List[string]
    if (-not (Test-Path -LiteralPath $HostDir)) { return @() }

    # Workspace root: the resolver's entry point (members, sources, overrides,
    # constraint-dependencies), the lockfile it produces, and the interpreter pin.
    foreach ($name in @('uv.lock', 'uv.toml', 'pyproject.toml', '.python-version')) {
        $path = Join-Path $HostDir $name
        if (Test-Path -LiteralPath $path) { $inputs.Add((Resolve-Path -LiteralPath $path).Path) }
    }

    $skip = @('.venv', 'build', 'dist', '__pycache__', 'node_modules')
    Get-ChildItem -LiteralPath $HostDir -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $skip -notcontains $_.Name } |
        ForEach-Object {
            Get-ChildItem -LiteralPath $_.FullName -Filter 'pyproject.toml' -Recurse -Depth 3 -File -Force -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -notmatch '\\(\.venv|build|dist|__pycache__|node_modules)\\' } |
                ForEach-Object { $inputs.Add($_.FullName) }
        }

    return @($inputs | Sort-Object -Unique)
}

function Get-ServiceHubSourceInputs {
    <#
    .SYNOPSIS
    The source roots (and exclusions) that feed the merged ServiceHub bundle's digest.

    .DESCRIPTION
    Kept next to the digest rather than inline in build-servicehub.ps1 so the
    contract test can run it against a fixture tree. The lists are derived from
    host/superclaw_services/superclaw_services.spec:

    - Every root the spec analyzes or ships loosely is hashed. `sandbox_policy\src`
      is NOT in the spec's `pathex` but sandbox_manager imports it, and it reaches
      the module graph as an editable workspace member, so the spec never names it.
      Leaving it out meant a content-only edit there (an mtime-preserving restore,
      which PyInstaller's own check cannot see) reused stale bytecode.
    - `tests` directly under a root is excluded. The spec collects by package
      (`collect_submodules("servicehub" ...)` with a filter that drops tests, the
      `src` tree of llmrouter/tts/sandbox/servicehub, explicit `_tree(...)` calls
      for privacy_manager's `common`, `file_protection`, `text_protection`,
      `protection_service`, `api`, `utils` and `src`) and none of those is a root's
      top-level `tests\`. A test-only edit therefore cannot change the bundle and
      must not cost a cold Analysis. Deliberately NOT a blanket `test_*.py` /
      `conftest.py` pattern: those could legitimately sit inside a collected
      package, and a wrong exclusion is stale bytecode.
    #>
    param([Parameter(Mandatory)][string]$RepoRoot)

    $hostDir = Join-Path $RepoRoot 'host'
    return @{
        SourceRoot = @(
            (Join-Path $hostDir 'superclaw_services'),
            (Join-Path $hostDir 'servicehub'),
            (Join-Path $hostDir 'llmrouter_manager'),
            (Join-Path $hostDir 'sandbox_manager'),
            (Join-Path $hostDir 'privacy_manager\data_protection'),
            (Join-Path $hostDir 'privacy_manager\llm_pipeline'),
            (Join-Path $hostDir 'tts_manager'),
            (Join-Path $hostDir 'asr_manager'),
            (Join-Path $hostDir 'mcp_host_manager'),
            (Join-Path $RepoRoot 'shared\contracts\generated\python'),
            (Join-Path $hostDir 'observability\src'),
            (Join-Path $hostDir 'sandbox_policy\src')
        )
        ExcludeRootDirectory = @('tests')
    }
}

function Get-PyInstallerSourceStamp {
    <#
    .SYNOPSIS
    SHA-256 over our Python sources plus the identity of the installed dependencies.

    .DESCRIPTION
    Each file contributes its repo-relative path, its length, and its own SHA-256,
    so a rename, a truncation, and an edit are all distinguishable. Entries are
    sorted to make the digest independent of enumeration order.

    .PARAMETER SourceRoot
    Directories to walk recursively. Missing directories are skipped: a spec may
    legitimately reference a tree that does not exist in every checkout.

    .PARAMETER ExcludeRootDirectory
    Names of directories, DIRECTLY under a -SourceRoot, whose files are left out of
    the digest. Only for a directory the caller has verified cannot reach the
    bundle (a service's `tests\`): everything not excluded is hashed, so a wrong
    exclusion is stale bytecode and a missing one is only a slower build. Matched
    on the first path segment below the root, not anywhere in the tree, so a
    `tests` package nested under `src\` (which a spec might legitimately collect)
    stays in.

    .PARAMETER SourceFile
    Additional individual files to include, e.g. the .spec itself.

    .PARAMETER DependencyFile
    Files that determine WHICH packages get installed (`uv.lock`, the workspace
    `pyproject.toml` files, `.python-version`). Counted separately from SourceFile
    only so the build log can stay honest about what it compared.

    .PARAMETER EnvironmentRoot
    A virtualenv directory. Contributes `pyvenv.cfg` (interpreter version, uv
    version) and the sorted names of `Lib\site-packages\*.dist-info`, i.e. the name
    and version of every installed package, without reading a single package file.
    #>
    param(
        [Parameter(Mandatory)][string[]]$SourceRoot,
        [string[]]$ExcludeRootDirectory = @(),
        [string[]]$SourceFile = @(),
        [string[]]$DependencyFile = @(),
        [string]$EnvironmentRoot = ''
    )

    $entries = New-Object System.Collections.Generic.List[string]
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $files = New-Object System.Collections.Generic.List[string]
        foreach ($root in $SourceRoot) {
            if (-not (Test-Path -LiteralPath $root)) { continue }
            $rootFull = (Resolve-Path -LiteralPath $root).Path
            $rootPrefixLength = $rootFull.TrimEnd('\').Length + 1
            Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force -Filter '*.py' -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -notmatch '\\(__pycache__|\.venv|node_modules)\\' } |
                Where-Object {
                    # Only safe because no hashed root has a top-level importable
                    # `tests` package (none exists today); keep it hashed if one appears.
                    # For a file directly in the root the first segment is the file
                    # name ("x.py"), which never equals a directory name.
                    $ExcludeRootDirectory -notcontains $_.FullName.Substring($rootPrefixLength).Split('\')[0]
                } |
                ForEach-Object { $files.Add($_.FullName) }
        }
        foreach ($file in $SourceFile) {
            if (Test-Path -LiteralPath $file) { $files.Add((Resolve-Path -LiteralPath $file).Path) }
        }
        $sourceCount = $files.Count

        foreach ($file in $DependencyFile) {
            if (Test-Path -LiteralPath $file) { $files.Add((Resolve-Path -LiteralPath $file).Path) }
        }
        $dependencyCount = $files.Count - $sourceCount

        foreach ($path in $files) {
            $bytes = [System.IO.File]::ReadAllBytes($path)
            $digest = [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')
            $entries.Add(('{0}|{1}|{2}' -f $path.ToLowerInvariant(), $bytes.Length, $digest))
        }

        # The materialized environment. Absent when the venv has not been created
        # yet, which is not an error: the first build syncs it and the digest
        # recorded here is simply re-derived once it exists.
        if ($EnvironmentRoot -and (Test-Path -LiteralPath $EnvironmentRoot)) {
            $pyvenvCfg = Join-Path $EnvironmentRoot 'pyvenv.cfg'
            if (Test-Path -LiteralPath $pyvenvCfg) {
                $cfgBytes = [System.IO.File]::ReadAllBytes($pyvenvCfg)
                $entries.Add(('env:pyvenv.cfg|{0}|{1}' -f $cfgBytes.Length,
                    [System.BitConverter]::ToString($sha.ComputeHash($cfgBytes)).Replace('-', '')))
                $dependencyCount++
            }
            $sitePackages = Join-Path $EnvironmentRoot 'Lib\site-packages'
            if (Test-Path -LiteralPath $sitePackages) {
                Get-ChildItem -LiteralPath $sitePackages -Directory -Force -Filter '*.dist-info' -ErrorAction SilentlyContinue |
                    ForEach-Object {
                        $entries.Add(('env:dist-info|{0}' -f $_.Name.ToLowerInvariant()))
                        $dependencyCount++
                    }
            }
        }

        $sortedEntries = @($entries | Sort-Object)
        $joined = ($sortedEntries -join "`n")
        $total = [System.BitConverter]::ToString(
            $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($joined))
        ).Replace('-', '')
        # Entries is the exact list the digest was computed from, returned so the
        # caller can record it for diagnosis. It is not fed back into the digest.
        return @{ Digest = $total; FileCount = $sourceCount; DependencyCount = $dependencyCount; Entries = $sortedEntries }
    } finally {
        $sha.Dispose()
    }
}

function Sync-PyInstallerWorkPath {
    <#
    .SYNOPSIS
    Wipe the PyInstaller workpath unless it provably matches the current sources.

    .DESCRIPTION
    Call once, before PyInstaller runs. Wipes the cache when -Wipe is passed
    (-Clean, or a Release build that must not depend on any cache) or when the
    source digest differs from the one recorded in the cache, then records the
    current digest.

    The digest is recorded up front rather than after a successful build on
    purpose: if the build fails midway, the worst case is a cache whose TOC is
    missing or partial, which PyInstaller detects and rebuilds by itself. The
    failure mode this function exists to prevent — content that changed without
    the cache noticing — cannot be introduced by a failed build.

    .PARAMETER Wipe
    Force removal regardless of the digest.

    .PARAMETER ExcludeRootDirectory
    Passed through to Get-PyInstallerSourceStamp.

    Every run also writes the hashed entries (`path|length|sha256`, one per line,
    sorted) to `.superclaw-source-stamp.entries` beside the stamp. It is not an
    input to the digest. A wipe deletes it with the workpath, so copy it aside
    before a build if you want to diff two builds.

    .OUTPUTS
    A hashtable describing what happened:
      Digest          - the current source digest
      FileCount       - how many of our own sources it covers
      DependencyCount - how many dependency inputs it covers (lockfile, manifests,
                        installed package identities)
      Reused          - $true when the existing cache was kept
      SmokeOk         - $true when the frozen import smoke already passed for this
                        exact digest, i.e. re-running it cannot discover anything new
    #>
    param(
        [Parameter(Mandatory)][string]$WorkPath,
        [Parameter(Mandatory)][string[]]$SourceRoot,
        [string[]]$ExcludeRootDirectory = @(),
        [string[]]$SourceFile = @(),
        [string[]]$DependencyFile = @(),
        [string]$EnvironmentRoot = '',
        [switch]$Wipe,
        [string]$LogPrefix = '[pyinstaller-cache]',
        [string]$WipeReason = 'requested'
    )

    $stampFile = Join-Path $WorkPath '.superclaw-source-stamp'
    $entriesFile = Join-Path $WorkPath '.superclaw-source-stamp.entries'
    $smokeFile = Join-Path $WorkPath '.superclaw-smoke-ok'
    $stamp = Get-PyInstallerSourceStamp -SourceRoot $SourceRoot -ExcludeRootDirectory $ExcludeRootDirectory `
        -SourceFile $SourceFile -DependencyFile $DependencyFile -EnvironmentRoot $EnvironmentRoot

    $reason = $null
    if ($Wipe) {
        $reason = $WipeReason
    } elseif (Test-Path -LiteralPath $WorkPath) {
        if (-not (Test-Path -LiteralPath $stampFile)) {
            $reason = 'cache predates content stamping'
        } elseif ((Get-Content -Raw -LiteralPath $stampFile).Trim() -ne $stamp.Digest) {
            # Deliberately not narrowed to "sources" - a dependency bump lands here
            # too, and saying "source content changed" for a uv.lock edit is exactly
            # the kind of misleading log line that sends someone down the wrong path.
            $reason = 'source or dependency content changed'
        }
    }

    # A previously recorded smoke result only counts when it was recorded for
    # THIS digest. Written after the smoke passes (never before), so a build whose
    # smoke failed leaves no marker and the next build re-runs it.
    $smokeOk = $false
    if (-not $reason -and (Test-Path -LiteralPath $smokeFile)) {
        $smokeOk = (Get-Content -Raw -LiteralPath $smokeFile).Trim() -eq $stamp.Digest
    }

    if ($reason -and (Test-Path -LiteralPath $WorkPath)) {
        Write-Host "$LogPrefix Removing PyInstaller cache $WorkPath ($reason) ..." -ForegroundColor Yellow
        # Deliberately not Remove-WithRetry: each caller defines its own, and a
        # failure to remove the cache must not be swallowed here — a retained
        # cache is exactly what this function is meant to rule out.
        Remove-Item -LiteralPath $WorkPath -Recurse -Force -ErrorAction Stop
        $smokeOk = $false
    } elseif (-not $reason -and (Test-Path -LiteralPath $WorkPath)) {
        Write-Host "$LogPrefix Reusing PyInstaller cache ($($stamp.FileCount) sources + $($stamp.DependencyCount) dependency inputs unchanged)." -ForegroundColor DarkGray
    }

    New-Item -ItemType Directory -Force -Path $WorkPath | Out-Null
    Set-Content -LiteralPath $stampFile -Value $stamp.Digest -Encoding ASCII
    # Diagnostic only, never read back into the digest: copy it aside before a build
    # to diff against the next one.
    Set-Content -LiteralPath $entriesFile -Value $stamp.Entries -Encoding UTF8

    return @{
        Digest          = $stamp.Digest
        FileCount       = $stamp.FileCount
        DependencyCount = $stamp.DependencyCount
        Reused          = [bool](-not $reason)
        SmokeOk         = [bool]$smokeOk
    }
}

function Set-PyInstallerSmokeVerified {
    <#
    .SYNOPSIS
    Record that the frozen import smoke passed for the current source digest.

    .DESCRIPTION
    Call ONLY after the smoke actually passed. The marker is what lets a later
    build skip the smoke, and skipping is only sound because the marker is
    digest-scoped: the same sources produce the same bundle (COLLECT copies from
    fixed paths), so the smoke's verdict cannot change while the digest holds.

    A failed smoke must leave the marker untouched, which is why this is a
    separate call rather than something Sync-PyInstallerWorkPath does up front.
    #>
    param(
        [Parameter(Mandatory)][string]$WorkPath,
        [Parameter(Mandatory)][string]$Digest
    )

    if ([string]::IsNullOrWhiteSpace($Digest)) { return }
    try {
        if (-not (Test-Path -LiteralPath $WorkPath)) {
            New-Item -ItemType Directory -Force -Path $WorkPath | Out-Null
        }
        Set-Content -LiteralPath (Join-Path $WorkPath '.superclaw-smoke-ok') -Value $Digest -Encoding ASCII
    } catch {
        # Failing to record it only costs a redundant smoke next time.
        Write-Host "  [pyinstaller-cache] could not record smoke result: $($_.Exception.Message)" -ForegroundColor DarkGray
    }
}
