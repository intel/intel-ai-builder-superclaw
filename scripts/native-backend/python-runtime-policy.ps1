. (Join-Path $PSScriptRoot "pinned-archive-policy.ps1")

function Assert-PythonArchiveContract {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$PythonSpec
  )

  if ($PythonSpec.provider -ne "astral-sh/python-build-standalone") {
    throw "unsupported CPython archive provider '$($PythonSpec.provider)'"
  }
  $expectedUrl = (
    "https://github.com/astral-sh/python-build-standalone/releases/download/" +
    "$($PythonSpec.build)/cpython-$($PythonSpec.version)%2B$($PythonSpec.build)-" +
    "x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
  )
  if (-not [string]::Equals(
      [string]$PythonSpec.url,
      $expectedUrl,
      [System.StringComparison]::Ordinal
    )) {
    throw "CPython archive source mismatch: expected '$expectedUrl', got '$($PythonSpec.url)'"
  }
  $uri = [System.Uri]$PythonSpec.url
  if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne "https") {
    throw "CPython archive source must use HTTPS: $($PythonSpec.url)"
  }
  if ([string]$PythonSpec.sha256 -notmatch "^[0-9a-f]{64}$") {
    throw "CPython archive SHA-256 must be 64 lowercase hexadecimal characters"
  }
}

function Get-PythonArchiveCachePath {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$PythonSpec,
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
  )

  return Join-Path $CacheRoot (
    "$($PythonSpec.distribution)-$($PythonSpec.build)-install_only_stripped.tar.gz"
  )
}

function Assert-PythonArchiveSha256 {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Archive,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedSha256
  )

  Assert-PinnedArchiveSha256 `
    -Archive $Archive `
    -ExpectedSha256 $ExpectedSha256 `
    -Label "CPython"
}

function Get-VerifiedPythonArchive {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$PythonSpec,
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
  )

  Assert-PythonArchiveContract -PythonSpec $PythonSpec
  return Get-VerifiedPinnedArchive `
    -Url $PythonSpec.url `
    -ExpectedSha256 $PythonSpec.sha256 `
    -ArchivePath (
      Get-PythonArchiveCachePath -PythonSpec $PythonSpec -CacheRoot $CacheRoot
    ) `
    -Label "CPython"
}

function Resolve-PayloadTar {
  # Windows ships bsdtar as System32\tar.exe (10 1803+), which handles a drive
  # letter. Resolving by PATH instead returns whatever comes first, and on any box
  # with Git for Windows' usr\bin on PATH - including GitHub-hosted windows
  # runners - that is GNU tar, which reads the "C:" in an archive path as a remote
  # host:path and refuses the whole Python stage without --force-local.
  $system32Tar = Join-Path $env:SystemRoot "System32\tar.exe"
  if (Test-Path -LiteralPath $system32Tar -PathType Leaf) {
    return [pscustomobject]@{ Source = $system32Tar; Arguments = @() }
  }

  $found = Get-Command tar.exe -ErrorAction SilentlyContinue
  if (-not $found) {
    throw "tar.exe not found on PATH; required for the pinned CPython archive"
  }
  $banner = [string](& $found.Source --version 2>&1 | Select-Object -First 1)
  $arguments = if ($banner -match "GNU tar") { @("--force-local") } else { @() }
  return [pscustomobject]@{ Source = $found.Source; Arguments = $arguments }
}

function Expand-VerifiedPythonArchive {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Archive,
    [Parameter(Mandatory = $true)]
    [string]$Destination
  )

  $tar = Resolve-PayloadTar
  $tarArgs = $tar.Arguments
  $entries = @(& $tar.Source @tarArgs -tzf $Archive)
  if ($LASTEXITCODE -ne 0 -or $entries.Count -eq 0) {
    throw "cannot list CPython archive '$Archive' (tar exit $LASTEXITCODE)"
  }
  foreach ($entryValue in $entries) {
    $entry = ([string]$entryValue).TrimEnd("/")
    if (-not $entry) { continue }
    if (
      $entry.StartsWith("/") -or
      $entry.StartsWith("\") -or
      $entry.Contains("\") -or
      $entry -match "^[A-Za-z]:" -or
      ($entry.Split("/") | Where-Object { $_ -in @("", ".", "..") }) -or
      -not ($entry -eq "python" -or $entry.StartsWith("python/"))
    ) {
      throw "unsafe CPython archive path '$entry'"
    }
  }

  $details = @(& $tar.Source @tarArgs -tvzf $Archive)
  if ($LASTEXITCODE -ne 0 -or $details.Count -eq 0) {
    throw "cannot inspect CPython archive types '$Archive' (tar exit $LASTEXITCODE)"
  }
  foreach ($detailValue in $details) {
    $detail = [string]$detailValue
    if (-not $detail -or $detail[0] -notin @("-", "d")) {
      throw "CPython archive contains a link or unsupported member: $detail"
    }
  }

  $staging = "$Destination.extracting"
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $staging | Out-Null
  try {
    & $tar.Source @tarArgs -xzf $Archive -C $staging
    if ($LASTEXITCODE -ne 0) {
      throw "CPython archive extraction failed (tar exit $LASTEXITCODE)"
    }
    $reparsePoint = Get-ChildItem -LiteralPath $staging -Recurse -Force |
      Where-Object {
        $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint
      } |
      Select-Object -First 1
    if ($reparsePoint) {
      throw "CPython archive extraction produced a reparse point: $($reparsePoint.FullName)"
    }
    $runtime = Join-Path $staging "python"
    if (-not (Test-Path -LiteralPath (Join-Path $runtime "python.exe") -PathType Leaf)) {
      throw "CPython archive does not contain python/python.exe"
    }
    Move-Item -LiteralPath $runtime -Destination $Destination
  } finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  }
}
