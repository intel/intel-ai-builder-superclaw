# Pinned uv acquisition for the native Python payload.
#
# uv resolves and installs every locked component environment, so its version is
# part of the payload's provenance (py/runtime-provenance.json records it) and
# the build stays fail-closed on the pin in native-payload-contract.json.
#
# The build provisions that exact uv itself, into the repo build tree, instead of
# demanding a matching uv on PATH. A machine-wide uv is upgraded by tools that
# know nothing about this contract - `uv self update`, winget, pipx, a newer
# installer - and an unrelated upgrade must not be able to fail a payload build.
# A PATH uv that already matches the pin is used as-is, which is the CI case.

. (Join-Path $PSScriptRoot "pinned-archive-policy.ps1")

function Assert-UvToolchainContract {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$UvSpec
  )

  if ([string]$UvSpec.version -notmatch "^[0-9]+\.[0-9]+\.[0-9]+$") {
    throw "uv toolchain version must be a three-part release: '$($UvSpec.version)'"
  }
  if ([string]$UvSpec.commit -notmatch "^[0-9a-f]{7,40}$") {
    throw "uv toolchain commit must be a lowercase hex Git prefix: '$($UvSpec.commit)'"
  }
  $expectedUrl = (
    "https://github.com/astral-sh/uv/releases/download/" +
    "$($UvSpec.version)/uv-x86_64-pc-windows-msvc.zip"
  )
  if (-not [string]::Equals(
      [string]$UvSpec.url,
      $expectedUrl,
      [System.StringComparison]::Ordinal
    )) {
    throw "uv archive source mismatch: expected '$expectedUrl', got '$($UvSpec.url)'"
  }
  $uri = [System.Uri]$UvSpec.url
  if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne "https") {
    throw "uv archive source must use HTTPS: $($UvSpec.url)"
  }
  if ([string]$UvSpec.sha256 -notmatch "^[0-9a-f]{64}$") {
    throw "uv archive SHA-256 must be 64 lowercase hexadecimal characters"
  }
}

function Get-PinnedUvBannerPrefix {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$UvSpec
  )

  return "uv $($UvSpec.version) ($($UvSpec.commit) "
}

function Get-UvVersionBanner {
  param(
    [Parameter(Mandatory = $true)]
    [string]$UvPath
  )

  # A candidate uv may be any executable, including one that writes to stderr or
  # cannot run at all. Probing it must report "not the pinned uv", not terminate
  # the build under the caller's 'Stop' preference.
  #
  # Discard stderr rather than merging it: `2>&1` turns a native command's stderr
  # into NativeCommandError records that land *in* the captured text, so one
  # unrelated uv startup warning (an unreadable UV_CACHE_DIR, a deprecated UV_*
  # variable) would prepend a PowerShell error dump to the version banner and make
  # the genuine pinned uv fail its own identity check.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = @(& $UvPath --version 2>$null)
    $exitCode = $LASTEXITCODE
  } catch {
    return ""
  } finally {
    $ErrorActionPreference = $previousPreference
    $global:LASTEXITCODE = 0
  }
  if ($exitCode -ne 0) {
    return ""
  }
  $versionLine = $output |
    ForEach-Object { ([string]$_).Trim() } |
    Where-Object { $_.StartsWith("uv ", [System.StringComparison]::Ordinal) } |
    Select-Object -First 1
  if (-not $versionLine) {
    return ""
  }
  return $versionLine
}

function Get-UvBannerDescription {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Banner
  )

  if (-not $Banner) {
    return "(no readable uv --version output)"
  }
  return "'$Banner'"
}

function Test-PinnedUvExecutable {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$UvSpec,
    # Empty means the candidate could not be probed at all, which is a mismatch
    # rather than a caller error.
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Banner
  )

  return $Banner.StartsWith(
    (Get-PinnedUvBannerPrefix -UvSpec $UvSpec),
    [System.StringComparison]::Ordinal
  )
}

function Get-UvArchiveCachePath {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$UvSpec,
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
  )

  return Join-Path $CacheRoot "uv-$($UvSpec.version)-x86_64-pc-windows-msvc.zip"
}

function Get-UvInstallRoot {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$UvSpec,
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
  )

  return Join-Path $CacheRoot "uv-$($UvSpec.version)-$($UvSpec.commit)"
}

function Get-VerifiedUvArchive {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$UvSpec,
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
  )

  Assert-UvToolchainContract -UvSpec $UvSpec
  return Get-VerifiedPinnedArchive `
    -Url $UvSpec.url `
    -ExpectedSha256 $UvSpec.sha256 `
    -ArchivePath (Get-UvArchiveCachePath -UvSpec $UvSpec -CacheRoot $CacheRoot) `
    -Label "uv"
}

function Expand-VerifiedUvArchive {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Archive,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedSha256,
    [Parameter(Mandatory = $true)]
    [string]$Destination
  )

  # Hash and extract through ONE handle opened with FileShare.Read.
  #
  # The download-time hash in Get-VerifiedPinnedArchive proves what arrived; it
  # cannot prove what is extracted later, because the cache lives in the writable
  # build tree and every by-path reopen is a fresh chance to read different bytes.
  # Holding the file open while denying writers makes the verified bytes and the
  # extracted bytes the same bytes, which is the property the pin actually needs.
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $stream = [System.IO.File]::Open(
    $Archive,
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
    if ($actual -ne $ExpectedSha256) {
      throw "uv archive SHA mismatch at extraction: expected $ExpectedSha256, got $actual"
    }
    [void]$stream.Seek(0, [System.IO.SeekOrigin]::Begin)

    # The upstream asset is a flat zip of uv.exe and uvx.exe. Reject anything else
    # rather than let a nested or traversing entry decide where the build's own
    # package installer lands.
    $zip = [System.IO.Compression.ZipArchive]::new(
      $stream,
      [System.IO.Compression.ZipArchiveMode]::Read,
      $true
    )
    try {
      if ($zip.Entries.Count -eq 0) {
        throw "uv archive is empty: $Archive"
      }
      foreach ($entry in $zip.Entries) {
        $name = [string]$entry.FullName
        if (
          -not $name -or
          $name -ne [System.IO.Path]::GetFileName($name) -or
          $name -in @(".", "..") -or
          $name.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0
        ) {
          throw "unsafe uv archive path '$name'"
        }
      }

      $staging = "$Destination.extracting"
      Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Force $staging | Out-Null
      try {
        foreach ($entry in $zip.Entries) {
          [System.IO.Compression.ZipFileExtensions]::ExtractToFile(
            $entry,
            (Join-Path $staging $entry.FullName),
            $true
          )
        }
        $reparsePoint = Get-ChildItem -LiteralPath $staging -Recurse -Force |
          Where-Object {
            $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint
          } |
          Select-Object -First 1
        if ($reparsePoint) {
          throw "uv archive extraction produced a reparse point: $($reparsePoint.FullName)"
        }
        if (-not (Test-Path -LiteralPath (Join-Path $staging "uv.exe") -PathType Leaf)) {
          throw "uv archive does not contain uv.exe: $Archive"
        }
        Move-Item -LiteralPath $staging -Destination $Destination
      } finally {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
      }
    } finally {
      $zip.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-PinnedUv {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$UvSpec,
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
  )

  Assert-UvToolchainContract -UvSpec $UvSpec
  $expectedPrefix = Get-PinnedUvBannerPrefix -UvSpec $UvSpec

  $pathUv = Get-Command uv -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($pathUv) {
    $banner = Get-UvVersionBanner -UvPath $pathUv.Source
    if (Test-PinnedUvExecutable -UvSpec $UvSpec -Banner $banner) {
      Write-Host "using pinned uv from PATH = $($pathUv.Source) ($banner)"
      return $pathUv.Source
    }
    Write-Host (
      "note: uv on PATH is not the pinned toolchain (expected '$expectedPrefix', " +
      "got $(Get-UvBannerDescription -Banner $banner)); " +
      "provisioning the pinned uv under $CacheRoot"
    ) -ForegroundColor Yellow
  }

  # Re-extract from the verified archive every build instead of reusing whatever
  # uv.exe is sitting in the build tree. A provisioned executable can only be
  # asked to state its own version, and `build\` is an ordinary writable directory:
  # trusting a self-reported banner there would let any file that prints the pinned
  # string install every Python package in the payload from then on. The archive
  # itself is re-hashed against the contract on each call, so this re-proves the
  # bytes rather than the claim. Extraction of two executables costs under a second.
  $installRoot = Get-UvInstallRoot -UvSpec $UvSpec -CacheRoot $CacheRoot
  $uvPath = Join-Path $installRoot "uv.exe"
  $archive = Get-VerifiedUvArchive -UvSpec $UvSpec -CacheRoot $CacheRoot
  Expand-VerifiedUvArchive `
    -Archive $archive `
    -ExpectedSha256 $UvSpec.sha256 `
    -Destination $installRoot
  $banner = Get-UvVersionBanner -UvPath $uvPath
  if (-not (Test-PinnedUvExecutable -UvSpec $UvSpec -Banner $banner)) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
    throw (
      "uv toolchain mismatch after provisioning: expected '$expectedPrefix', " +
      "got $(Get-UvBannerDescription -Banner $banner)"
    )
  }
  Write-Host "provisioned pinned uv = $uvPath ($banner)"
  return $uvPath
}
