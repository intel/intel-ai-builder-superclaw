<#
.SYNOPSIS
  Pack a staged native backend payload into native-backend.zip and its native-backend.json sidecar.

.DESCRIPTION
  Writes native-backend.zip and native-backend.json ({version, sha256, size, codec}) into
  OutputDirectory; build-installer.ps1 points that at build\Release\servicehub, which the installer
  ships. The archive root is the payload root, with manifest.json at the top level. Every member is
  a STORED entry holding one zstd frame (level 19, content size in the frame header) and the
  sidecar says "codec": "zstd", so a plain unzip yields frames, not files. Sandbox Manager's
  payload_archive.py is the only reader of either file.

  The elevated broker, native-isolation\native_isolation_broker.exe, is left out of the archive and
  of the manifest inside it, and written to OutputDirectory\native-isolation instead: Sandbox Manager
  elevates it from the install directory, which the user cannot write, never from the extracted
  payload under %LOCALAPPDATA%, which the user can.

  Run it on the exact tree the installer ships (post-signing, post-manifest). It refuses a tree
  that fails the packaging gate in payload-verification.ps1, and a tree holding any reparse point.

  This script walks, orders and filters the tree and rewrites the manifest;
  pack_native_backend_archive.py compresses and writes, through host\sandbox_manager's uv
  environment so it uses the zstandard the reader is locked to. Entries are written in ordinal path
  order with one fixed timestamp, so the same tree packed with the same zstandard gives the same
  bytes.

.EXAMPLE
  scripts\native-backend\New-NativeBackendArchive.ps1 -PayloadRoot build\Release\servicehub\native-backend -Version 2.0.1.1030 -OutputDirectory build\Release\servicehub
#>
param(
    [Parameter(Mandatory = $true)][string]$PayloadRoot,
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+(\.\d+)?$')][string]$Version,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw "[native backend archive] 'uv' not found." }

. (Join-Path $PSScriptRoot 'payload-verification.ps1')
Assert-NativeBackendPayload -PayloadRoot $PayloadRoot -Label 'native backend archive'

$root = (Resolve-Path -LiteralPath $PayloadRoot).Path.TrimEnd('\')
$reparse = [System.IO.FileAttributes]::ReparsePoint
if ((Get-Item -LiteralPath $root -Force).Attributes -band $reparse) {
    throw "payload root is a reparse point: $root"
}

# Walk by hand so a junction is refused rather than followed.
$files = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
$pending = [System.Collections.Generic.Stack[System.IO.DirectoryInfo]]::new()
$pending.Push([System.IO.DirectoryInfo]::new($root))
while ($pending.Count -gt 0) {
    foreach ($item in $pending.Pop().EnumerateFileSystemInfos()) {
        if ($item.Attributes -band $reparse) { throw "payload contains a reparse point: $($item.FullName)" }
        if ($item -is [System.IO.DirectoryInfo]) { $pending.Push($item) } else { $files.Add($item) }
    }
}
$broker = 'native-isolation/native_isolation_broker.exe'
$entries = [string[]]@($files | ForEach-Object {
    $_.FullName.Substring($root.Length + 1).Replace('\', '/')
} | Where-Object { $_ -ne $broker })
[System.Array]::Sort($entries, [System.StringComparer]::Ordinal)
$manifest = Get-Content -LiteralPath (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$manifest.files = @($manifest.files | Where-Object { $_.path -ne $broker })
$manifestBytes = $utf8.GetBytes(($manifest | ConvertTo-Json -Depth 4 -Compress))

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outDir = (Resolve-Path -LiteralPath $OutputDirectory).Path
$brokerOut = Join-Path $outDir 'native-isolation'
New-Item -ItemType Directory -Force -Path $brokerOut | Out-Null
Copy-Item -LiteralPath (Join-Path $root $broker) -Destination $brokerOut -Force
$zipPath = Join-Path $outDir 'native-backend.zip'
$partPath = "$zipPath.partial"
$entriesPath = "$partPath.entries"
$manifestPath = "$partPath.manifest"
Remove-Item -LiteralPath $partPath -Force -ErrorAction SilentlyContinue
[System.IO.File]::WriteAllLines($entriesPath, $entries, $utf8)
[System.IO.File]::WriteAllBytes($manifestPath, $manifestBytes)

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$timer = [System.Diagnostics.Stopwatch]::StartNew()
# uv reports progress on stderr, which Windows PowerShell 5.1 turns into a terminating
# NativeCommandError under 'Stop'; $LASTEXITCODE below is the pass/fail signal.
$prevPref = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & uv run --frozen --directory (Join-Path $repoRoot 'host\sandbox_manager') python `
        (Join-Path $PSScriptRoot 'pack_native_backend_archive.py') `
        --root $root --entries $entriesPath --manifest $manifestPath --output $partPath
} finally {
    $ErrorActionPreference = $prevPref
    Remove-Item -LiteralPath $entriesPath, $manifestPath -Force -ErrorAction SilentlyContinue
}
if ($LASTEXITCODE -ne 0) { throw "[native backend archive] pack_native_backend_archive.py failed with exit code $LASTEXITCODE" }
Move-Item -LiteralPath $partPath -Destination $zipPath -Force
$timer.Stop()

$sha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $zipPath).Length
$info = [ordered]@{ version = $Version; sha256 = $sha256; size = $size; codec = 'zstd' } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Join-Path $outDir 'native-backend.json'), "$info`n", $utf8)

Write-Host ("[native backend archive] {0}: {1} files, {2:N1} MB, {3:N1} s (zstd), sha256 {4}" -f `
    $zipPath, $entries.Count, ($size / 1MB), $timer.Elapsed.TotalSeconds, $sha256)
