# Verified acquisition of a pinned build toolchain archive.
#
# Both pinned toolchains in native-payload-contract.json (portable CPython and uv)
# are fetched through here, because this is the one place the payload build decides
# to trust bytes it did not build. Two copies of a download-and-verify path is
# exactly the code that must not drift: the per-toolchain policies keep only their
# own archive-shape rules and share this.
#
# The contract is: nothing is returned that has not just been SHA-256 verified, and
# a file that fails is deleted rather than left for a later run to reuse.

function Assert-PinnedArchiveSha256 {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Archive,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedSha256,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $ExpectedSha256) {
    throw "$Label archive SHA mismatch: expected $ExpectedSha256, got $actual"
  }
}

function Get-VerifiedPinnedArchive {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedSha256,
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  New-Item -ItemType Directory -Force (Split-Path -Parent $ArchivePath) | Out-Null
  if (Test-Path -LiteralPath $ArchivePath -PathType Leaf) {
    try {
      Assert-PinnedArchiveSha256 `
        -Archive $ArchivePath `
        -ExpectedSha256 $ExpectedSha256 `
        -Label $Label
    } catch {
      Remove-Item -LiteralPath $ArchivePath -Force
      throw "rejected mismatched cached $Label archive '$ArchivePath': $($_.Exception.Message)"
    }
    Write-Host "reusing SHA-verified $Label archive: $ArchivePath"
    return $ArchivePath
  }

  # Download to a sibling name and publish by rename: an interrupted transfer must
  # not leave a short file at the cache path for the next build to hash.
  $download = "$ArchivePath.download"
  Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
  try {
    Invoke-WebRequest -Uri $Url -OutFile $download -UseBasicParsing
    Assert-PinnedArchiveSha256 `
      -Archive $download `
      -ExpectedSha256 $ExpectedSha256 `
      -Label $Label
    Move-Item -LiteralPath $download -Destination $ArchivePath
  } catch {
    Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
    throw
  }
  Write-Host "downloaded SHA-verified $Label archive: $ArchivePath"
  return $ArchivePath
}
