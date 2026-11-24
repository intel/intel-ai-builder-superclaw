function Test-CompletePayloadInvocation {
  param(
    [switch]$SkipOpencode,
    [switch]$SkipServices,
    [switch]$SkipShell
  )

  return -not ($SkipOpencode -or $SkipServices -or $SkipShell)
}

function Get-NormalizedManagedPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  return [System.IO.Path]::GetFullPath($Path).TrimEnd("\", "/")
}

function Get-CanonicalManagedPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $fullPath = Get-NormalizedManagedPath -Path $Path
  $existingAncestor = $fullPath
  $unresolvedComponents = @()
  while (-not (Test-Path -LiteralPath $existingAncestor)) {
    $parent = [System.IO.Path]::GetDirectoryName($existingAncestor)
    if (-not $parent -or $parent.Equals(
        $existingAncestor,
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
      return $fullPath
    }
    $unresolvedComponents += [System.IO.Path]::GetFileName($existingAncestor)
    $existingAncestor = $parent
  }
  $canonicalPath = (Resolve-Path -LiteralPath $existingAncestor).ProviderPath
  for ($index = $unresolvedComponents.Count - 1; $index -ge 0; $index--) {
    $canonicalPath = Join-Path $canonicalPath $unresolvedComponents[$index]
  }
  return Get-NormalizedManagedPath -Path $canonicalPath
}

function Assert-ManagedPayloadCopyRootsDoNotOverlap {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [Parameter(Mandatory = $true)]
    [string]$Destination,
    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  $canonicalSource = Get-CanonicalManagedPath -Path $Source
  $canonicalDestination = Get-CanonicalManagedPath -Path $Destination
  if (
    (Test-ManagedPathWithin `
        -Path $canonicalSource `
        -Root $canonicalDestination `
        -AllowEqual) -or
    (Test-ManagedPathWithin `
        -Path $canonicalDestination `
        -Root $canonicalSource `
        -AllowEqual)
  ) {
    throw (
      "$Description source and destination managed payload roots overlap: " +
      "'$canonicalSource' and '$canonicalDestination'"
    )
  }
}

function Test-ManagedPathWithin {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [switch]$AllowEqual
  )

  $fullPath = Get-NormalizedManagedPath -Path $Path
  $fullRoot = Get-NormalizedManagedPath -Path $Root
  $comparison = [System.StringComparison]::OrdinalIgnoreCase
  if ($AllowEqual -and $fullPath.Equals($fullRoot, $comparison)) {
    return $true
  }
  return $fullPath.StartsWith(
    $fullRoot + [System.IO.Path]::DirectorySeparatorChar,
    $comparison
  )
}

function Assert-NoReparsePathComponents {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $fullPath = Get-NormalizedManagedPath -Path $Path
  $root = [System.IO.Path]::GetPathRoot($fullPath)
  $relative = $fullPath.Substring($root.Length)
  $current = $root
  foreach ($component in $relative.Split(
      [System.IO.Path]::DirectorySeparatorChar,
      [System.StringSplitOptions]::RemoveEmptyEntries
    )) {
    $current = Join-Path $current $component
    if (-not (Test-Path -LiteralPath $current)) {
      continue
    }
    $item = Get-Item -LiteralPath $current -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      throw "managed payload path may not contain a reparse point: $current"
    }
  }
}

function Assert-NoReparseTree {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [string[]]$ExcludedTopLevelDirectories = @()
  )

  Assert-NoReparsePathComponents -Path $Root
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    return
  }
  $excluded = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  foreach ($name in $ExcludedTopLevelDirectories) {
    [void]$excluded.Add($name)
  }
  foreach ($entry in Get-ChildItem -LiteralPath $Root -Force) {
    if ($entry.PSIsContainer -and $excluded.Contains($entry.Name)) {
      continue
    }
    $reparsePoint = if (
      $entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint
    ) {
      $entry
    } elseif ($entry.PSIsContainer) {
      Get-ChildItem -LiteralPath $entry.FullName -Recurse -Force |
        Where-Object {
          $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint
        } |
        Select-Object -First 1
    }
    if ($reparsePoint) {
      throw "managed payload tree may not contain reparse points: $($reparsePoint.FullName)"
    }
  }
}

function Assert-SafePayloadOutDir {
  param(
    [Parameter(Mandatory = $true)]
    [string]$OutDir,
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [Parameter(Mandatory = $true)]
    [string]$RepoBuildRoot,
    [Parameter(Mandatory = $true)]
    [string[]]$AllowedRoots
  )

  $fullOutDir = Get-NormalizedManagedPath -Path $OutDir
  $fullRepoRoot = Get-NormalizedManagedPath -Path $RepoRoot
  $fullBuildRoot = Get-NormalizedManagedPath -Path $RepoBuildRoot
  $comparison = [System.StringComparison]::OrdinalIgnoreCase
  if (
    $fullOutDir.Equals($fullRepoRoot, $comparison) -or
    $fullOutDir.Equals($fullBuildRoot, $comparison) -or
    (Test-ManagedPathWithin -Path $fullRepoRoot -Root $fullOutDir) -or
    (Test-ManagedPathWithin -Path $fullBuildRoot -Root $fullOutDir)
  ) {
    throw "unsafe native payload OutDir boundary: $fullOutDir"
  }

  $allowed = $false
  foreach ($allowedRoot in $AllowedRoots) {
    if (Test-ManagedPathWithin -Path $fullOutDir -Root $allowedRoot -AllowEqual) {
      $allowed = $true
      break
    }
  }
  if (-not $allowed) {
    throw "native payload OutDir is not an allowlisted managed destination: $fullOutDir"
  }
  Assert-NoReparsePathComponents -Path $fullOutDir
  return $fullOutDir
}

function Remove-CanonicalPayloadManifest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadRoot
  )

  $manifestPath = Join-Path $PayloadRoot "manifest.json"
  $temporaryManifestPath = Join-Path $PayloadRoot ".manifest.json.tmp"
  foreach ($path in @($manifestPath, $temporaryManifestPath)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
    }
  }
}

function Remove-CanonicalPayloadManifests {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$PayloadRoots
  )

  $failures = [System.Collections.Generic.List[System.Exception]]::new()
  foreach ($root in $PayloadRoots | Select-Object -Unique) {
    try {
      Remove-CanonicalPayloadManifest -PayloadRoot $root
    } catch {
      $failures.Add($_.Exception)
    }
  }
  if ($failures.Count -gt 0) {
    throw [System.AggregateException]::new(
      "failed to remove one or more canonical payload manifests",
      $failures.ToArray()
    )
  }
}

function Get-PayloadManifestFileFingerprint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ManifestPath
  )

  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    return $null
  }
  try {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
  if (-not $manifest.files) {
    return $null
  }
  # payload_version is deliberately excluded: the content copy never carries
  # manifest.json, so a destination whose bytes already match is up to date even
  # when this build stamps a new identity onto the manifest published afterwards.
  return (
    @(
      $manifest.files | ForEach-Object {
        "{0}`t{1}`t{2}" -f $_.path, [long]$_.bytes, $_.sha256
      } | Sort-Object
    ) -join "`n"
  )
}

function Save-PayloadPublicationFingerprints {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$PayloadRoots
  )

  $fingerprints = @{}
  foreach ($root in $PayloadRoots | Select-Object -Unique) {
    $fingerprint = Get-PayloadManifestFileFingerprint `
      -ManifestPath (Join-Path $root "manifest.json")
    if ($fingerprint) {
      $key = (Get-CanonicalManagedPath -Path $root).ToLowerInvariant()
      $fingerprints[$key] = $fingerprint
    }
  }
  $script:PayloadPublicationFingerprints = $fingerprints
}

function Test-PayloadPublicationCurrent {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,
    [Parameter(Mandatory = $true)]
    [string]$DestinationRoot
  )

  # Only a manifest that was present at the destination when this build started
  # counts, because publication verifies the destination bytes against it before
  # it is written. A crashed run leaves no manifest, so nothing vouches for those
  # bytes and the copy runs in full.
  $published = $script:PayloadPublicationFingerprints
  if (-not $published) {
    return $false
  }
  $key = (Get-CanonicalManagedPath -Path $DestinationRoot).ToLowerInvariant()
  if (-not $published.ContainsKey($key)) {
    return $false
  }
  $incoming = Get-PayloadManifestFileFingerprint `
    -ManifestPath (Join-Path $SourceRoot "manifest.json")
  if (-not $incoming) {
    return $false
  }
  return [System.StringComparer]::Ordinal.Equals($incoming, $published[$key])
}

function Invoke-ManagedPayloadMutation {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$PayloadRoots,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Mutation
  )

  # Record what each managed root was last known to hold before its manifest is
  # invalidated. A rerun whose rebuilt payload hashes identically can then skip
  # republishing gigabytes that are already staged there; see
  # Test-PayloadPublicationCurrent.
  Save-PayloadPublicationFingerprints -PayloadRoots $PayloadRoots
  Remove-CanonicalPayloadManifests -PayloadRoots $PayloadRoots
  try {
    & $Mutation
  } catch {
    $mutationFailure = $_.Exception
    # Rethrowing the bare exception reports this rollback site as the failure
    # location, which hid the real origin (e.g. git complaining about a directory
    # it could not read). Keep the origin in the message and the original
    # exception as InnerException.
    $origin = if ($_.InvocationInfo -and $_.InvocationInfo.ScriptName) {
      " at $($_.InvocationInfo.ScriptName):$($_.InvocationInfo.ScriptLineNumber)"
    } else {
      ""
    }
    try {
      Remove-CanonicalPayloadManifests -PayloadRoots $PayloadRoots
    } catch {
      throw [System.AggregateException]::new(
        "managed payload mutation failed$origin and manifest cleanup was incomplete",
        [System.Exception[]]@($mutationFailure, $_.Exception)
      )
    }
    throw [System.Exception]::new(
      "managed payload mutation failed$origin`: $($mutationFailure.Message)",
      $mutationFailure
    )
  }
}

function Initialize-PayloadBuildTree {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadRoot,
    [Parameter(Mandatory = $true)]
    [bool]$CompletePayload
  )

  if ($CompletePayload -and (Test-Path -LiteralPath $PayloadRoot)) {
    Assert-NoReparseTree -Root $PayloadRoot
    Remove-Item -LiteralPath $PayloadRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force $PayloadRoot | Out-Null
}

function Copy-ManagedPayloadTree {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [Parameter(Mandatory = $true)]
    [string]$Destination,
    [Parameter(Mandatory = $true)]
    [bool]$CompletePayload,
    [string[]]$Options = @(),
    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  Assert-ManagedPayloadCopyRootsDoNotOverlap `
    -Source $Source `
    -Destination $Destination `
    -Description $Description

  $excludedTopLevelDirectories = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  for ($index = 0; $index -lt $Options.Count; $index++) {
    if (-not $Options[$index].Equals("/XD", [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "$Description contains unsupported copy option '$($Options[$index])'"
    }
    if ($index + 1 -ge $Options.Count) {
      throw "$Description /XD option requires a top-level directory name"
    }
    $excluded = $Options[++$index]
    if (
      -not $excluded -or
      $excluded -in @(".", "..") -or
      $excluded.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
      $excluded.Contains("\") -or
      $excluded.Contains("/") -or
      [System.IO.Path]::IsPathRooted($excluded)
    ) {
      throw "$Description has invalid top-level exclusion '$excluded'"
    }
    [void]$excludedTopLevelDirectories.Add($excluded)
  }

  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "$Description source is missing: $Source"
  }
  Assert-NoReparseTree `
    -Root $Source `
    -ExcludedTopLevelDirectories @($excludedTopLevelDirectories)
  Assert-NoReparsePathComponents -Path $Destination
  if ($CompletePayload -and (Test-Path -LiteralPath $Destination)) {
    Assert-NoReparseTree -Root $Destination
    if (Test-PayloadPublicationCurrent -SourceRoot $Source -DestinationRoot $Destination) {
      # Wiping and recopying an identical tree is what made a no-op rerun cost as
      # much as a cold build. The manifest published here afterwards is still
      # verified against the destination bytes, so a destination that drifted
      # behind our back fails the build rather than shipping stale files.
      Write-Host (
        "ok: $Description destination already matches this payload; skipping copy"
      )
      return
    }
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }
  New-Item -ItemType Directory -Force $Destination | Out-Null

  foreach ($entry in Get-ChildItem -LiteralPath $Source -Force | Sort-Object Name) {
    if ($entry.Name.Equals("manifest.json", [System.StringComparison]::OrdinalIgnoreCase)) {
      continue
    }
    if ($entry.PSIsContainer) {
      if ($excludedTopLevelDirectories.Contains($entry.Name)) {
        continue
      }
      $entryDestination = Join-Path $Destination $entry.Name
      # /MIR, not /E: an incomplete payload skips the wipe above, so a merge would
      # leave files the rebuilt tree no longer ships. A stale venv `pyvenv.cfg` that
      # way silently redirected the interpreter's sys.path away from site-packages.
      robocopy $entry.FullName $entryDestination /MIR `
        /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
      if ($LASTEXITCODE -lt 0 -or $LASTEXITCODE -ge 8) {
        throw "$Description failed for $($entry.Name) (robocopy exit $LASTEXITCODE)"
      }
      $global:LASTEXITCODE = 0
      continue
    }
    if (-not (Test-Path -LiteralPath $entry.FullName -PathType Leaf)) {
      throw "$Description source entry is not a regular file: $($entry.FullName)"
    }
    Copy-Item -LiteralPath $entry.FullName -Destination $Destination -Force
  }
}

  function Get-CanonicalPayloadHashes {
    param(
    [Parameter(Mandatory = $true)]
    [string[]]$Paths
    )

    if (-not ("SuperClaw.NativePayload.ParallelSha256" -as [type])) {
    Add-Type -TypeDefinition @'
  using System;
  using System.IO;
  using System.Security.Cryptography;
  using System.Threading.Tasks;

  namespace SuperClaw.NativePayload
  {
    public static class ParallelSha256
    {
      public static string[] HashFiles(string[] paths)
      {
        if (paths == null)
        {
          throw new ArgumentNullException("paths");
        }

        var hashes = new string[paths.Length];
        var options = new ParallelOptions
        {
          MaxDegreeOfParallelism = Math.Min(32, Math.Max(1, Environment.ProcessorCount + 4))
        };
        Parallel.For(0, paths.Length, options, index =>
        {
          using (var stream = new FileStream(
            paths[index],
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read))
          using (var sha256 = SHA256.Create())
          {
            hashes[index] = BitConverter.ToString(sha256.ComputeHash(stream))
              .Replace("-", "")
              .ToLowerInvariant();
          }
        });
        return hashes;
      }
    }
  }
'@
    }

    return [SuperClaw.NativePayload.ParallelSha256]::HashFiles($Paths)
  }

# Rehashing every payload file on every run is what made a no-op rebuild cost as
# much as a cold one: the payload is tens of thousands of files, most of them
# byte-identical to the previous build. The cache below records what each file
# hashed to together with the size and last-write time it had at the time, so an
# untouched file is not read again. It cannot live inside the payload - an
# unlisted member there fails the runtime's own payload verification - so by
# default it sits beside the payload root as a hidden sibling. The build passes
# an explicit path instead (see Write-CanonicalPayloadManifest -HashCachePath),
# because a Debug/Release payload lives under build\<Cfg>\servicehub, which the
# ServiceHub PyInstaller step deletes and recreates on every build, sibling and all.
#
# What a hit means, stated once: the file has the same path, size and
# LastWriteTimeUtc it had when it was last hashed. Content that changed while both
# size and timestamp were kept identical - a tool that restores the mtime, or a
# replacement that carries the same mtime and size - is NOT detected, and the old
# digest is reused. Nothing downstream would notice either: the runtime's
# verify_payload checks names and sizes, not bytes, so the manifest's digest is the
# payload's whole content identity (content_fingerprint). Three things bound it:
#   * a file stamped within $script:PayloadHashCacheRacyWindow of the scan that hashed
#     it is never cached, since its timestamp could not yet tell an edit made during
#     the scan apart (it does nothing for a rewrite that preserves the mtime);
#   * the cache carries an epoch (Get-PayloadHashCacheEpoch: the toolchain pins, locks
#     and build scripts the payload comes from) and is discarded when it changes,
#     which covers the known source of identical timestamps across different content
#     - pinned archives whose members carry a fixed mtime;
#   * the build uses the cache for development builds only; Release and -Sign builds,
#     and -FullManifestHash, run -FullHash, which neither reads nor writes it.
$script:PayloadHashCacheRacyWindow = [TimeSpan]::FromSeconds(2)

function Get-PayloadHashCacheHeader {
  # v2: the key no longer contains CreationTimeUtc, so a v1 file must not be read.
  return "# superclaw native payload hash cache v2"
}

function Get-PayloadHashCacheEpoch {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$Path
  )

  # Digest of the files that decide which bytes the payload is built from. A change in
  # any of them means timestamps carried over from the previous build prove nothing.
  $parts = foreach ($file in $Path) {
    $digest = if (Test-Path -LiteralPath $file -PathType Leaf) {
      (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    } else {
      "absent"
    }
    "$([System.IO.Path]::GetFileName($file))=$digest"
  }
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(@($parts) -join ";"))
  } finally {
    $sha256.Dispose()
  }
  return [System.BitConverter]::ToString($bytes).Replace("-", "")
}

function Get-PayloadHashCachePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadRoot
  )

  $fullPath = Get-NormalizedManagedPath -Path $PayloadRoot
  return Join-Path `
    ([System.IO.Path]::GetDirectoryName($fullPath)) `
    ("." + [System.IO.Path]::GetFileName($fullPath) + ".manifest-hash-cache.tsv")
}

function Get-PayloadHashCacheKey {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.FileInfo]$File
  )

  # CreationTimeUtc used to be part of the key, as a cheap second signal against
  # an overwrite that preserves the mtime. It defeated the cache where it matters:
  # every build recreates the payload from scratch, and the copy tools involved
  # (uv's wheel cache, pnpm's store, robocopy) preserve LastWriteTime but stamp a
  # fresh CreationTime, so no file ever hit. Measured on a Debug payload: 25,645
  # of 26,476 files under py\ and 3,772 of 3,793 under config-source\ had a
  # LastWriteTime older than their CreationTime. The trade is the limitation
  # documented above.
  return "{0}|{1}|{2}" -f `
    $File.FullName.ToLowerInvariant(),
    [long]$File.Length,
    $File.LastWriteTimeUtc.Ticks
}

function Import-PayloadHashCache {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [string]$Epoch = ""
  )

  $cache = @{}
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $cache
  }
  # A cache is an optimization, never an input to correctness: anything about it
  # that does not read back exactly as written is discarded and rehashed.
  try {
    $lines = [System.IO.File]::ReadAllLines($Path)
  } catch {
    return $cache
  }
  if (
    $lines.Count -lt 2 -or
    $lines[0] -cne (Get-PayloadHashCacheHeader) -or
    $lines[1] -cne "# epoch $Epoch"
  ) {
    return $cache
  }
  for ($index = 2; $index -lt $lines.Count; $index++) {
    $fields = $lines[$index].Split("`t")
    if ($fields.Count -ne 2 -or $fields[1] -notmatch "^[0-9a-f]{64}$") {
      continue
    }
    $cache[$fields[0]] = $fields[1]
  }
  return $cache
}

function Export-PayloadHashCache {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [object[]]$Files,
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$Hashes,
    [Parameter(Mandatory = $true)]
    [datetime]$ScanStartUtc,
    [string]$Epoch = ""
  )

  if ($Files.Count -ne $Hashes.Count) {
    throw "payload hash cache needs exactly one hash per file"
  }
  # A file stamped at or after this instant could still be rewritten within the
  # same timestamp granularity as the scan that hashed it, so a later run could
  # not tell the rewrite from the file it hashed. Leave it out: it is rehashed
  # next time, which is also what "files newer than the previous manifest are
  # rehashed" comes to.
  $racyTicks = $ScanStartUtc.ToUniversalTime().Ticks - $script:PayloadHashCacheRacyWindow.Ticks
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add((Get-PayloadHashCacheHeader))
  $lines.Add("# epoch $Epoch")
  for ($index = 0; $index -lt $Files.Count; $index++) {
    if ($Files[$index].LastWriteTimeUtc.Ticks -ge $racyTicks) {
      continue
    }
    $lines.Add((Get-PayloadHashCacheKey -File $Files[$index]) + "`t" + $Hashes[$index])
  }
  try {
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Path)) |
      Out-Null
    # Temp then move, so an interrupted write never leaves a half-cache at $Path.
    [System.IO.File]::WriteAllLines("$Path.tmp", $lines)
    Move-Item -LiteralPath "$Path.tmp" -Destination $Path -Force
  } catch {
    # A cache that cannot be written costs the next run its shortcut, nothing else.
    Write-Host "note: could not write payload hash cache $Path" -ForegroundColor Yellow
  }
}

function Get-IncrementalPayloadHashes {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [object[]]$Files,
    [Parameter(Mandatory = $true)]
    [hashtable]$Cache
  )

  $hashes = [string[]]::new($Files.Count)
  $changed = [System.Collections.Generic.List[int]]::new()
  for ($index = 0; $index -lt $Files.Count; $index++) {
    $cached = $Cache[(Get-PayloadHashCacheKey -File $Files[$index])]
    if ($cached) {
      $hashes[$index] = $cached
    } else {
      $changed.Add($index)
    }
  }
  if ($changed.Count -gt 0) {
    $fresh = @(
      Get-CanonicalPayloadHashes -Paths @($changed | ForEach-Object { $Files[$_].FullName })
    )
    for ($index = 0; $index -lt $changed.Count; $index++) {
      $hashes[$changed[$index]] = $fresh[$index]
    }
  }
  return [pscustomobject]@{
    Hashes = $hashes
    RehashedCount = $changed.Count
  }
}

function Write-CanonicalPayloadManifest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadRoot,
    [Parameter(Mandatory = $true)]
    [string]$PayloadVersion,
    # Where the per-file hash cache lives. Empty means the hidden sibling of the
    # payload root, which is what a payload outside a wiped build tree wants.
    [string]$HashCachePath = "",
    # What the cache's entries are only valid for; see Get-PayloadHashCacheEpoch.
    [string]$HashCacheEpoch = "",
    # Neither read nor write the cache: hash every file. Release and signed builds
    # always run this way.
    [switch]$FullHash
  )

  $scanStartUtc = [datetime]::UtcNow
  # v2 dropped the `agent_manifest` binding: the Product Profile cutover deleted
  # `superclaw-agent-manifest.json`, and the payload's `config-source` now carries
  # the offline dependency tree only.
  $schemaVersion = 2
  $manifestName = "manifest.json"
  $temporaryManifestName = ".manifest.json.tmp"
  $requiredPaths = @(
    "openwork.exe",
    "openwork-server.exe",
    "opencode-router.exe",
    "opencode.exe",
    "native-isolation/native_isolation_broker.exe",
    "native-isolation/native_isolation_launcher.exe",
    "native-isolation/native_isolation_tier_bootstrap.exe",
    "shell/sh.exe",
    "shell/bash.exe",
    "shell/rg.exe",
    "shell/licenses/ripgrep.LICENSE",
    "intent-classifier/intent_classifier_server.py",
    "config-source/package.json",
    "config-source/node_modules/@opencode-ai/plugin/package.json"
  )

  Remove-CanonicalPayloadManifest -PayloadRoot $PayloadRoot
  if ($PayloadVersion -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") {
    throw "invalid payload version '$PayloadVersion'"
  }
  $resolvedRoot = (Resolve-Path -LiteralPath $PayloadRoot).Path
  foreach ($relative in $requiredPaths) {
    $nativeRelative = $relative.Replace("/", "\")
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedRoot $nativeRelative) -PathType Leaf)) {
      throw "required payload member missing: $relative"
    }
  }

  $manifestPath = Join-Path $resolvedRoot $manifestName
  $temporaryManifestPath = Join-Path $resolvedRoot $temporaryManifestName
  $members = @(Get-ChildItem -LiteralPath $resolvedRoot -Recurse -Force)
  $reparsePoint = $members | Where-Object {
    $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint
  } | Select-Object -First 1
  if ($reparsePoint) {
    throw "payload may not contain reparse points: $($reparsePoint.FullName)"
  }

  $rootPrefix = $resolvedRoot.TrimEnd("\", "/") + "\"
  $files = [System.Collections.Generic.List[object]]::new()
  $seenRelativePaths = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  $orderedFiles = @(
    $members | Where-Object { -not $_.PSIsContainer } | Sort-Object FullName
  )
  $hashCachePath = if ($HashCachePath) {
    Get-NormalizedManagedPath -Path $HashCachePath
  } else {
    Get-PayloadHashCachePath -PayloadRoot $resolvedRoot
  }
  $previousHashes = if ($FullHash) {
    @{}
  } else {
    Import-PayloadHashCache -Path $hashCachePath -Epoch $HashCacheEpoch
  }
  $hashed = Get-IncrementalPayloadHashes `
    -Files $orderedFiles `
    -Cache $previousHashes
  $hashes = @($hashed.Hashes)
  for ($index = 0; $index -lt $orderedFiles.Count; $index++) {
    $file = $orderedFiles[$index]
    $relative = $file.FullName.Substring($rootPrefix.Length).Replace("\", "/")
    if (
      $relative.Contains(":") -or
      $relative.Contains("\") -or
      ($relative.Split("/") | Where-Object { $_ -in @("", ".", "..") })
    ) {
      throw "unsafe payload path: $relative"
    }
    if (-not $seenRelativePaths.Add($relative)) {
      throw "payload contains case-colliding paths: $relative"
    }
    $files.Add([ordered]@{
        path = $relative
        bytes = [long]$file.Length
        sha256 = $hashes[$index]
      })
  }

  $manifest = [ordered]@{
    schema_version = $schemaVersion
    payload_version = $PayloadVersion
    hash_algorithm = "sha256"
    files = $files.ToArray()
  }
  try {
    $manifest | ConvertTo-Json -Depth 5 |
      Set-Content -LiteralPath $temporaryManifestPath -Encoding utf8
    Move-Item -LiteralPath $temporaryManifestPath -Destination $manifestPath
  } catch {
    Remove-CanonicalPayloadManifest -PayloadRoot $resolvedRoot
    throw
  }
  if (-not $FullHash) {
    Export-PayloadHashCache `
      -Path $hashCachePath `
      -Files $orderedFiles `
      -Hashes $hashes `
      -ScanStartUtc $scanStartUtc `
      -Epoch $HashCacheEpoch
  }
  Write-Host (
    "ok: payload manifest v$schemaVersion ($($files.Count) files, payload " +
    "$PayloadVersion, rehashed $($hashed.RehashedCount) of $($files.Count))"
  )
}

function Set-CanonicalPayloadManifest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadRoot,
    [Parameter(Mandatory = $true)]
    [bool]$CompletePayload,
    [string]$PayloadVersion,
    [Parameter(Mandatory = $true)]
    [scriptblock]$ManifestWriter
  )

  # A partial build publishes over the members an earlier complete build left in
  # place; the writer drops any old manifest first, so failure leaves none behind.
  try {
    & $ManifestWriter $PayloadRoot $PayloadVersion
  } catch {
    if ($CompletePayload) { throw }
    throw "partial payload cannot publish a canonical manifest: $($_.Exception.Message); run build-native-backend.ps1 once without -Skip* flags"
  }
}

function Copy-CanonicalPayloadManifest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,
    [Parameter(Mandatory = $true)]
    [string]$DestinationRoot,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Verifier,
    [bool]$Publish = $true
  )

  Remove-CanonicalPayloadManifest -PayloadRoot $DestinationRoot
  if (-not $Publish) { return }

  Assert-ManagedPayloadCopyRootsDoNotOverlap `
    -Source $SourceRoot `
    -Destination $DestinationRoot `
    -Description "manifest publication"
  Assert-NoReparsePathComponents -Path $DestinationRoot
  $sourceManifest = Join-Path $SourceRoot "manifest.json"
  if (-not (Test-Path -LiteralPath $sourceManifest -PathType Leaf)) {
    throw "source canonical manifest is missing: $sourceManifest"
  }
  $destinationManifest = Join-Path $DestinationRoot "manifest.json"
  $temporaryManifest = Join-Path $DestinationRoot ".manifest.json.tmp"
  try {
    Copy-Item -LiteralPath $sourceManifest -Destination $temporaryManifest -Force
    Move-Item -LiteralPath $temporaryManifest -Destination $destinationManifest
    & $Verifier $DestinationRoot
  } catch {
    $publicationFailure = $_.Exception
    try {
      Remove-CanonicalPayloadManifest -PayloadRoot $DestinationRoot
    } catch {
      throw [System.AggregateException]::new(
        "canonical manifest publication failed and cleanup was incomplete",
        [System.Exception[]]@($publicationFailure, $_.Exception)
      )
    }
    throw $publicationFailure
  }
}
