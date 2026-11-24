# Pinned Node.js acquisition, and staging of the stdio MCP toolchain into the payload.
#
# Catalog stdio MCP servers start through `npx` and `uvx` as children of the runtime, so on a
# clean machine those two commands have to come from the payload: nothing else puts them on the
# runtime's PATH. The payload therefore ships the Node.js distribution pinned in
# native-payload-contract.json at tools\node and the pinned uv's uv.exe and uvx.exe at tools\uv.
#
# Both are taken from SHA-verified archives on every build, never from PATH: a PATH uv that
# prints the pinned banner is trusted to *run* the build (uv-toolchain-policy.ps1), but a
# self-reported banner is not enough to make its bytes part of what the installer ships.
#
# Dot-source after uv-toolchain-policy.ps1, which provides the uv archive helpers and
# pinned-archive-policy.ps1.

function Assert-NodeToolchainContract {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$NodeSpec
  )

  if ([string]$NodeSpec.version -notmatch "^[0-9]+\.[0-9]+\.[0-9]+$") {
    throw "node toolchain version must be a three-part release: '$($NodeSpec.version)'"
  }
  $expectedUrl = (
    "https://nodejs.org/dist/v$($NodeSpec.version)/" +
    "node-v$($NodeSpec.version)-win-x64.zip"
  )
  if (-not [string]::Equals(
      [string]$NodeSpec.url,
      $expectedUrl,
      [System.StringComparison]::Ordinal
    )) {
    throw "node archive source mismatch: expected '$expectedUrl', got '$($NodeSpec.url)'"
  }
  if ([string]$NodeSpec.sha256 -notmatch "^[0-9a-f]{64}$") {
    throw "node archive SHA-256 must be 64 lowercase hexadecimal characters"
  }
}

function Get-NodeArchiveTopDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$NodeSpec
  )

  return "node-v$($NodeSpec.version)-win-x64"
}

function Get-NodeInstallRoot {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$NodeSpec,
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
  )

  return Join-Path $CacheRoot (Get-NodeArchiveTopDirectory -NodeSpec $NodeSpec)
}

function Expand-VerifiedNodeArchive {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$NodeSpec,
    [Parameter(Mandatory = $true)]
    [string]$Archive,
    [Parameter(Mandatory = $true)]
    [string]$Destination
  )

  # Hash and extract through ONE handle that denies writers, for the reason
  # Expand-VerifiedUvArchive gives: the cache is in the writable build tree, so the
  # extracted bytes must be the bytes that were just hashed.
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
    if ($actual -ne $NodeSpec.sha256) {
      throw "node archive SHA mismatch at extraction: expected $($NodeSpec.sha256), got $actual"
    }
    [void]$stream.Seek(0, [System.IO.SeekOrigin]::Begin)

    # The upstream asset is one node-v<version>-win-x64/ directory. Every entry must sit
    # under it and every path segment must be an ordinary file name, so no entry can
    # decide where in the build tree its bytes land.
    $zip = [System.IO.Compression.ZipArchive]::new(
      $stream,
      [System.IO.Compression.ZipArchiveMode]::Read,
      $true
    )
    try {
      if ($zip.Entries.Count -eq 0) {
        throw "node archive is empty: $Archive"
      }
      $prefix = "$(Get-NodeArchiveTopDirectory -NodeSpec $NodeSpec)/"
      $invalid = [System.IO.Path]::GetInvalidFileNameChars()
      $files = [System.Collections.Generic.List[object]]::new()
      foreach ($entry in $zip.Entries) {
        $name = [string]$entry.FullName
        if ($name -eq $prefix) {
          continue
        }
        if (-not $name.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
          throw "node archive entry outside '$prefix': '$name'"
        }
        $relative = $name.Substring($prefix.Length)
        $isDirectory = $relative.EndsWith("/")
        $segments = $relative.TrimEnd("/").Split("/")
        foreach ($segment in $segments) {
          if (
            -not $segment -or
            $segment -in @(".", "..") -or
            $segment.IndexOfAny($invalid) -ge 0
          ) {
            throw "unsafe node archive path '$name'"
          }
        }
        if (-not $isDirectory) {
          $files.Add(@($entry, ($segments -join "\")))
        }
      }

      $staging = "$Destination.extracting"
      Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Force $staging | Out-Null
      try {
        foreach ($file in $files) {
          $target = Join-Path $staging $file[1]
          New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
          [System.IO.Compression.ZipFileExtensions]::ExtractToFile($file[0], $target, $true)
        }
        $reparsePoint = Get-ChildItem -LiteralPath $staging -Recurse -Force |
          Where-Object {
            $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint
          } |
          Select-Object -First 1
        if ($reparsePoint) {
          throw "node archive extraction produced a reparse point: $($reparsePoint.FullName)"
        }
        foreach ($required in @(
          "node.exe",
          "npm.cmd",
          "npx.cmd",
          "node_modules\npm\bin\npm-cli.js",
          "node_modules\npm\bin\npx-cli.js"
        )) {
          if (-not (Test-Path -LiteralPath (Join-Path $staging $required) -PathType Leaf)) {
            throw "node archive does not contain $required`: $Archive"
          }
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

function Get-NativeVersionLine {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Executable
  )

  # Same tolerance as Get-UvVersionBanner: a candidate that cannot run reports an
  # empty version, not a terminating error under the caller's 'Stop' preference.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = @(& $Executable --version 2>$null)
    $exitCode = $LASTEXITCODE
  } catch {
    return ""
  } finally {
    $ErrorActionPreference = $previousPreference
    $global:LASTEXITCODE = 0
  }
  if ($exitCode -ne 0 -or $output.Count -eq 0) {
    return ""
  }
  return ([string]$output[0]).Trim()
}

function Get-PinnedNode {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$NodeSpec,
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
  )

  Assert-NodeToolchainContract -NodeSpec $NodeSpec
  $archivePath = Join-Path $CacheRoot "$(Get-NodeArchiveTopDirectory -NodeSpec $NodeSpec).zip"
  $archive = Get-VerifiedPinnedArchive `
    -Url $NodeSpec.url `
    -ExpectedSha256 $NodeSpec.sha256 `
    -ArchivePath $archivePath `
    -Label "node"
  # Re-extracted every build, like uv: a tree left in build\ proves nothing about its bytes.
  $installRoot = Get-NodeInstallRoot -NodeSpec $NodeSpec -CacheRoot $CacheRoot
  Expand-VerifiedNodeArchive -NodeSpec $NodeSpec -Archive $archive -Destination $installRoot
  $version = Get-NativeVersionLine -Executable (Join-Path $installRoot "node.exe")
  if ($version -ne "v$($NodeSpec.version)") {
    Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
    throw "node toolchain mismatch after provisioning: expected 'v$($NodeSpec.version)', got '$version'"
  }
  Write-Host "provisioned pinned node = $installRoot ($version)"
  return $installRoot
}

function Assert-PinnedUvx {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$UvSpec,
    [Parameter(Mandatory = $true)]
    [string]$UvxPath,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $banner = Get-NativeVersionLine -Executable $UvxPath
  $prefix = "uvx $($UvSpec.version) ($($UvSpec.commit) "
  if (-not $banner.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
    throw "$Label uvx reports '$banner', expected '$prefix'"
  }
  return $banner
}

function Get-PinnedMcpToolchain {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$NodeSpec,
    [Parameter(Mandatory = $true)]
    [string]$NodeCacheRoot,
    [Parameter(Mandatory = $true)]
    [psobject]$UvSpec,
    [Parameter(Mandatory = $true)]
    [string]$UvCacheRoot
  )

  $nodeRoot = Get-PinnedNode -NodeSpec $NodeSpec -CacheRoot $NodeCacheRoot
  $uvRoot = Get-UvInstallRoot -UvSpec $UvSpec -CacheRoot $UvCacheRoot
  Expand-VerifiedUvArchive `
    -Archive (Get-VerifiedUvArchive -UvSpec $UvSpec -CacheRoot $UvCacheRoot) `
    -ExpectedSha256 $UvSpec.sha256 `
    -Destination $uvRoot
  # Validated here, before the payload is touched, so a bad uv pin fails the build while the
  # previous payload and its manifests are still intact.
  foreach ($name in @("uv.exe", "uvx.exe")) {
    if (-not (Test-Path -LiteralPath (Join-Path $uvRoot $name) -PathType Leaf)) {
      throw "pinned uv archive does not contain $name"
    }
  }
  [void](Assert-PinnedUvx -UvSpec $UvSpec -UvxPath (Join-Path $uvRoot "uvx.exe") -Label "pinned")
  return [pscustomobject]@{
    NodeSpec = $NodeSpec
    NodeRoot = $nodeRoot
    UvSpec = $UvSpec
    UvRoot = $uvRoot
  }
}

function Install-PayloadMcpToolchain {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadRoot,
    # The result of Get-PinnedMcpToolchain, which runs before the payload tree is touched.
    [Parameter(Mandatory = $true)]
    [psobject]$Toolchain
  )

  $NodeSpec = $Toolchain.NodeSpec
  $UvSpec = $Toolchain.UvSpec
  $uvRoot = $Toolchain.UvRoot

  # Replaced, not merged, so a file dropped from a newer pin does not survive in an
  # incremental payload.
  $tools = Join-Path $PayloadRoot "tools"
  $nodeDestination = Join-Path $tools "node"
  $uvDestination = Join-Path $tools "uv"
  foreach ($destination in @($nodeDestination, $uvDestination)) {
    if (Test-Path -LiteralPath $destination) {
      Remove-Item -LiteralPath $destination -Recurse -Force
    }
  }
  New-Item -ItemType Directory -Force $tools, $uvDestination | Out-Null
  Copy-Item -LiteralPath $Toolchain.NodeRoot -Destination $nodeDestination -Recurse -Force
  foreach ($name in @("uv.exe", "uvx.exe")) {
    $source = Join-Path $uvRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "pinned uv archive does not contain $name"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $uvDestination $name) -Force
  }

  $nodeVersion = Get-NativeVersionLine -Executable (Join-Path $nodeDestination "node.exe")
  if ($nodeVersion -ne "v$($NodeSpec.version)") {
    throw "staged node reports '$nodeVersion', expected 'v$($NodeSpec.version)'"
  }
  $uvxBanner = Assert-PinnedUvx `
    -UvSpec $UvSpec -UvxPath (Join-Path $uvDestination "uvx.exe") -Label "staged"
  Write-Host "ok: stdio MCP toolchain in $tools (node $nodeVersion, $uvxBanner)"
}
