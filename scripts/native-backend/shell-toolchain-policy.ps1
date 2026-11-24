# Pinned POSIX shell for the native payload (issue #3676).
#
# The agent's bash tool runs `sh -c <command>`, so the payload ships a POSIX shell. It used to be
# BusyBox for Windows (GPL-2.0) and is now built from permissively licensed parts:
#
#   * brush (MIT), built here from the pinned, SHA-256 verified crates.io release, with uutils
#     coreutils compiled in as builtins. brush publishes no Windows binary to pin by SHA-256, so the
#     pin is the crate archive plus the crate's own Cargo.lock. brush-core carries one patch
#     (shell-patches\): a here-document over 4 KiB hangs the shell on Windows without it.
#   * grep, sed, find, xargs, awk and the coreutils that xargs and find -exec spawn, from pinned
#     GitHub release archives verified through pinned-archive-policy.ps1. A builtin is invisible to
#     a child process, so what those two run has to be a real executable.
#
# brush runs under a constrained token where Git-Bash (MSYS2) cannot: MSYS2 aborts with
# NtCreateDirectoryObject(\BaseNamedObjects\msys-...) ACCESS_DENIED.
#
# The pins live in native-payload-contract.json (toolchain.shell). BusyBox dispatches on argv[0]; brush
# does not, so sh.exe and bash.exe are two copies of one binary. awk.exe is a small shim (shell-shims\awk)
# in front of the pinned goawk.exe, because GoAWK writes CRLF on Windows.

. (Join-Path $PSScriptRoot "pinned-archive-policy.ps1")

function Assert-ShellToolchainContract {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$ShellSpec
  )

  $brush = $ShellSpec.brush
  if ([string]$brush.crate -cne "brush-shell") {
    throw "shell toolchain crate must be brush-shell: '$($brush.crate)'"
  }
  if ([string]$brush.version -notmatch "^[0-9]+\.[0-9]+\.[0-9]+$") {
    throw "brush version must be a three-part release: '$($brush.version)'"
  }
  if (@($brush.features).Count -eq 0) {
    throw "brush must be built with its bundled coreutils: features is empty"
  }
  if ([string]::IsNullOrEmpty([string]$brush.license_file)) {
    throw "brush license_file is not pinned"
  }
  if ([string]$brush.crate_sha256 -notmatch "^[0-9a-f]{64}$") {
    throw "brush crate_sha256 must be 64 lowercase hexadecimal characters"
  }
  foreach ($patched in @($brush.patched_crates)) {
    $label = "patched crate '$($patched.crate)'"
    if ([string]$patched.crate -notmatch "^[a-z0-9_-]+$" -or [string]$patched.version -notmatch "^[0-9]+\.[0-9]+\.[0-9]+$") {
      throw "$label needs a crate name and a three-part version"
    }
    if ([string]$patched.sha256 -notmatch "^[0-9a-f]{64}$") {
      throw "$label SHA-256 must be 64 lowercase hexadecimal characters"
    }
    if ([string]$patched.patch -notmatch "^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$" -or ([string]$patched.patch).Split("/") -contains "..") {
      throw "$label patch path is unsafe: '$($patched.patch)'"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $patched.patch) -PathType Leaf)) {
      throw "$label patch file is missing: '$($patched.patch)'"
    }
  }
  foreach ($key in "opt-level", "lto", "codegen-units", "strip", "panic") {
    if ([string]::IsNullOrEmpty([string]$brush.release_profile.$key)) {
      throw "brush release_profile.$key is not pinned"
    }
  }

  $seen = @{}
  foreach ($tool in @($ShellSpec.tools)) {
    $id = [string]$tool.id
    if ($id -notmatch "^[a-z0-9-]+$" -or $seen.ContainsKey($id)) {
      throw "shell tool id is invalid or repeated: '$id'"
    }
    $seen[$id] = $true
    if (-not ([string]$tool.url).StartsWith("https://github.com/", [System.StringComparison]::Ordinal)) {
      throw "shell tool $id must come from a GitHub release: '$($tool.url)'"
    }
    if ([string]$tool.sha256 -notmatch "^[0-9a-f]{64}$") {
      throw "shell tool $id SHA-256 must be 64 lowercase hexadecimal characters"
    }
    $members = @($tool.members.PSObject.Properties)
    if ($members.Count -eq 0) {
      throw "shell tool $id declares no members"
    }
    foreach ($member in $members) {
      $target = [string]$member.Value
      # Relative, forward-slash, no traversal: the target is joined onto the payload's shell\.
      if ($target -notmatch "^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$" -or $target.Split("/") -contains "..") {
        throw "shell tool $id installs to an unsafe path: '$target'"
      }
    }
  }
}

function Get-VerifiedShellToolArchives {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$ShellSpec,
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
  )

  Assert-ShellToolchainContract -ShellSpec $ShellSpec
  $archives = [ordered]@{}
  foreach ($tool in @($ShellSpec.tools)) {
    $archives[[string]$tool.id] = Get-VerifiedPinnedArchive `
      -Url $tool.url `
      -ExpectedSha256 $tool.sha256 `
      -ArchivePath (Join-Path $CacheRoot "$($tool.id)-$($tool.version).zip") `
      -Label $tool.id
  }
  return $archives
}

# Downloads a crate from crates.io, SHA-256 verifies it and unpacks it under $SourceRoot.
function Expand-PinnedCrate {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Crate,
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [Parameter(Mandatory = $true)]
    [string]$Sha256,
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot,
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot
  )

  $archive = Get-VerifiedPinnedArchive `
    -Url "https://static.crates.io/crates/$Crate/$Crate-$Version.crate" `
    -ExpectedSha256 $Sha256 `
    -ArchivePath (Join-Path $CacheRoot "$Crate-$Version.crate") `
    -Label $Crate
  # Windows' own bsdtar, never whatever "tar" PATH finds first: from Git Bash that is GNU tar,
  # which reads the "C:" in the archive path as host:path and refuses to unpack.
  $tar = Join-Path $env:SystemRoot "System32\tar.exe"
  if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) {
    throw "$tar not found; it is required to unpack $Crate-$Version.crate"
  }
  & $tar -xzf $archive -C $SourceRoot
  if ($LASTEXITCODE -ne 0) {
    throw "could not unpack $Crate-$Version.crate (exit $LASTEXITCODE)"
  }
  $dir = Join-Path $SourceRoot "$Crate-$Version"
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
    throw "$Crate-$Version.crate did not unpack to $dir"
  }
  return $dir
}

# A [patch] on a registry crate turns its lockfile entry into a path entry: Cargo drops that
# entry's source and checksum and nothing else. Anything more means the pinned lock was re-resolved.
function Assert-OnlyPatchedSourcesLeftTheLock {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Before,
    [Parameter(Mandatory = $true)]
    [string]$After,
    [Parameter(Mandatory = $true)]
    [string[]]$PatchedCrates
  )

  $expected = $Before -replace "`r`n", "`n"
  foreach ($name in $PatchedCrates) {
    $pattern = '(?m)(^name = "' + [regex]::Escape($name) + '"\nversion = "[^"]+"\n)source = "[^"]+"\nchecksum = "[0-9a-f]+"\n'
    $expected = [regex]::Replace($expected, $pattern, '$1')
  }
  if ($expected -ne ($After -replace "`r`n", "`n")) {
    throw "the brush build changed Cargo.lock beyond the patched crates' source and checksum"
  }
}

# Builds brush from its pinned crate, with the pinned patches applied, and returns the path of
# brush.exe. brush-core is patched through a [patch.crates-io] path, so every other dependency
# stays at the version the crate's own Cargo.lock pins.
function Build-PinnedBrush {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$BrushSpec,
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
  )

  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "cargo not found on PATH: brush is built from its pinned crate"
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git not found on PATH: the brush patches are applied with git apply"
  }
  $sourceRoot = Join-Path $CacheRoot "src-$($BrushSpec.version)"
  Remove-Item -LiteralPath $sourceRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $sourceRoot | Out-Null

  $brushDir = Expand-PinnedCrate -Crate $BrushSpec.crate -Version $BrushSpec.version `
    -Sha256 $BrushSpec.crate_sha256 -CacheRoot $CacheRoot -SourceRoot $sourceRoot
  $patchEntries = @()
  foreach ($patched in @($BrushSpec.patched_crates)) {
    $crateDir = Expand-PinnedCrate -Crate $patched.crate -Version $patched.version `
      -Sha256 $patched.sha256 -CacheRoot $CacheRoot -SourceRoot $sourceRoot
    & git -C $crateDir apply --whitespace=nowarn (Join-Path $PSScriptRoot $patched.patch)
    if ($LASTEXITCODE -ne 0) {
      throw "patch $($patched.patch) does not apply to $($patched.crate) $($patched.version) (exit $LASTEXITCODE)"
    }
    $patchEntries += "$($patched.crate) = { path = '$($crateDir.Replace('\', '/'))' }"
  }

  $manifest = Join-Path $brushDir "Cargo.toml"
  $lockFile = Join-Path $brushDir "Cargo.lock"
  $lockBefore = [System.IO.File]::ReadAllText($lockFile)
  [System.IO.File]::AppendAllText($manifest, "`n[patch.crates-io]`n" + ($patchEntries -join "`n") + "`n")

  # Pin the target dir for the reason the broker build does: CI exports a CARGO_TARGET_DIR.
  $targetDir = Join-Path $CacheRoot "target"
  $profileEnv = [ordered]@{}
  foreach ($setting in $BrushSpec.release_profile.PSObject.Properties) {
    $profileEnv["CARGO_PROFILE_RELEASE_" + $setting.Name.ToUpperInvariant().Replace("-", "_")] = [string]$setting.Value
  }

  # Set for cargo only, so a standalone run does not leave the profile in the caller's shell.
  $saved = @{}
  foreach ($name in $profileEnv.Keys) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name)
    [Environment]::SetEnvironmentVariable($name, $profileEnv[$name])
  }
  try {
    # No --locked: the [patch] rewrites the patched crates' lock entries. The check below pins
    # the rest of the lock instead.
    & cargo build --release `
      --manifest-path $manifest `
      --features (@($BrushSpec.features) -join ",") `
      --target-dir $targetDir | Out-Host
    if ($LASTEXITCODE -ne 0) {
      throw "brush cargo build failed (exit $LASTEXITCODE)"
    }
  } finally {
    foreach ($name in $saved.Keys) {
      # A variable that was unset goes back to unset: set to an empty string it is still defined,
      # and cargo rejects an empty CARGO_PROFILE_RELEASE_CODEGEN_UNITS in the next build.
      if ($null -eq $saved[$name]) {
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
      } else {
        [Environment]::SetEnvironmentVariable($name, $saved[$name])
      }
    }
  }

  Assert-OnlyPatchedSourcesLeftTheLock -Before $lockBefore -After ([System.IO.File]::ReadAllText($lockFile)) `
    -PatchedCrates @(@($BrushSpec.patched_crates) | ForEach-Object { [string]$_.crate })

  $exe = Join-Path $targetDir "release\brush.exe"
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "brush build output is missing: $exe"
  }
  return $exe
}

# Builds the awk shim from the repo and returns the path of awk.exe.
function Build-AwkShim {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
  )

  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "cargo not found on PATH: the awk shim is built from shell-shims"
  }
  $manifest = Join-Path $PSScriptRoot "shell-shims\awk\Cargo.toml"
  $targetDir = Join-Path $CacheRoot "awk-shim-target"
  & cargo build --manifest-path $manifest --target-dir $targetDir --release --locked | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "awk shim cargo build failed (exit $LASTEXITCODE)"
  }
  $exe = Join-Path $targetDir "release\awk.exe"
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "awk shim build output is missing: $exe"
  }
  return $exe
}

# Stages the whole shell\ directory: it is replaced, never merged into, so a file the previous build
# left (or a -Sign build signed in place) cannot survive into this one.
function Install-PinnedShell {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BrushExe,
    # The MIT text committed beside the pin: a crates.io build has no archive to take it from.
    [Parameter(Mandatory = $true)]
    [string]$BrushLicense,
    [Parameter(Mandatory = $true)]
    [string]$AwkShim,
    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$ToolArchives,
    [Parameter(Mandatory = $true)]
    [psobject]$ShellSpec,
    # The payload's shell directory.
    [Parameter(Mandatory = $true)]
    [string]$Destination
  )

  Assert-ShellToolchainContract -ShellSpec $ShellSpec
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem

  $staging = "$Destination.staging"
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $staging | Out-Null
  try {
    Copy-Item -LiteralPath $BrushExe -Destination (Join-Path $staging "sh.exe")
    Copy-Item -LiteralPath $BrushExe -Destination (Join-Path $staging "bash.exe")
    Copy-Item -LiteralPath $AwkShim -Destination (Join-Path $staging "awk.exe")
    New-Item -ItemType Directory -Force (Join-Path $staging "licenses") | Out-Null
    Copy-Item -LiteralPath $BrushLicense -Destination (Join-Path $staging "licenses\brush-shell.LICENSE")

    foreach ($tool in @($ShellSpec.tools)) {
      $archive = [string]$ToolArchives[[string]$tool.id]
      # Hash and extract through one handle that denies writers: the cache is in the writable
      # build tree, so a file hashed and then reopened could be swapped between the two.
      $stream = [System.IO.File]::Open(
        $archive,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
      )
      try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
          $actual = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).
            Replace("-", "").ToLowerInvariant()
        } finally {
          $sha256.Dispose()
        }
        if ($actual -ne $tool.sha256) {
          throw "$($tool.id) archive SHA mismatch at extraction: expected $($tool.sha256), got $actual"
        }
        [void]$stream.Seek(0, [System.IO.SeekOrigin]::Begin)

        $zip = [System.IO.Compression.ZipArchive]::new(
          $stream,
          [System.IO.Compression.ZipArchiveMode]::Read,
          $true
        )
        try {
          foreach ($member in $tool.members.PSObject.Properties) {
            $entry = $zip.GetEntry([string]$member.Name)
            if ($null -eq $entry) {
              throw "$($tool.id) archive has no entry '$($member.Name)'"
            }
            $target = Join-Path $staging ([string]$member.Value).Replace("/", "\")
            New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
          }
        } finally {
          $zip.Dispose()
        }
      } finally {
        $stream.Dispose()
      }
    }

    # An absent destination is fine; one that cannot be deleted (a shell exe still running) must
    # stop the build: Move-Item into a surviving directory nests the staging tree inside it.
    if (Test-Path -LiteralPath $Destination) {
      Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction Stop
    }
    Move-Item -LiteralPath $staging -Destination $Destination
  } finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  }
}
