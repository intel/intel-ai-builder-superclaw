# Pinned GitHub CLI for the native payload (egress EG1-11).
#
# openwork-server signs in to GitHub through gh, and the agent's shell runs the same
# gh against the same store, so the payload ships one pinned gh at gh\bin\gh.exe
# rather than relying on whatever gh a user may have installed. The broker names it
# by absolute path (SUPERCLAW_GH_BIN) and puts gh\bin on the runtime's PATH.
#
# The pin lives in native-payload-contract.json (toolchain.gh); the archive is
# fetched and SHA-verified through pinned-archive-policy.ps1 like uv and CPython.

. (Join-Path $PSScriptRoot "pinned-archive-policy.ps1")

# The upstream windows_amd64 zip holds exactly these; anything else is refused.
$script:GhArchiveEntries = @("bin/gh.exe", "LICENSE")

function Assert-GhToolchainContract {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$GhSpec
  )

  if ([string]$GhSpec.version -notmatch "^[0-9]+\.[0-9]+\.[0-9]+$") {
    throw "gh toolchain version must be a three-part release: '$($GhSpec.version)'"
  }
  $expectedUrl = (
    "https://github.com/cli/cli/releases/download/" +
    "v$($GhSpec.version)/gh_$($GhSpec.version)_windows_amd64.zip"
  )
  if (-not [string]::Equals(
      [string]$GhSpec.url,
      $expectedUrl,
      [System.StringComparison]::Ordinal
    )) {
    throw "gh archive source mismatch: expected '$expectedUrl', got '$($GhSpec.url)'"
  }
  if ([string]$GhSpec.sha256 -notmatch "^[0-9a-f]{64}$") {
    throw "gh archive SHA-256 must be 64 lowercase hexadecimal characters"
  }
}

function Get-VerifiedGhArchive {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$GhSpec,
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
  )

  Assert-GhToolchainContract -GhSpec $GhSpec
  return Get-VerifiedPinnedArchive `
    -Url $GhSpec.url `
    -ExpectedSha256 $GhSpec.sha256 `
    -ArchivePath (Join-Path $CacheRoot "gh_$($GhSpec.version)_windows_amd64.zip") `
    -Label "gh"
}

function Install-VerifiedGh {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Archive,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedSha256,
    # The payload's gh directory; gh.exe lands in its bin\.
    [Parameter(Mandatory = $true)]
    [string]$Destination
  )

  # Hash and extract through one handle that denies writers, for the reason
  # Expand-VerifiedUvArchive gives: the cache is in the writable build tree.
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
      throw "gh archive SHA mismatch at extraction: expected $ExpectedSha256, got $actual"
    }
    [void]$stream.Seek(0, [System.IO.SeekOrigin]::Begin)

    $zip = [System.IO.Compression.ZipArchive]::new(
      $stream,
      [System.IO.Compression.ZipArchiveMode]::Read,
      $true
    )
    try {
      $names = @($zip.Entries | ForEach-Object { [string]$_.FullName } | Sort-Object)
      $expected = @($script:GhArchiveEntries | Sort-Object)
      if (($names -join "|") -cne ($expected -join "|")) {
        throw "gh archive entries are not '$($expected -join "', '")': '$($names -join "', '")'"
      }

      $staging = "$Destination.extracting"
      Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Force (Join-Path $staging "bin") | Out-Null
      try {
        foreach ($entry in $zip.Entries) {
          [System.IO.Compression.ZipFileExtensions]::ExtractToFile(
            $entry,
            (Join-Path $staging $entry.FullName),
            $true
          )
        }
        Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
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
