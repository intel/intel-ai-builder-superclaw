# A verified snapshot of the staged `config-source\node_modules`, kept between builds.
#
# Staging the offline OpenCode dependency tree costs the same on every build: a
# `pnpm fetch` and `pnpm deploy` into a temporary directory, a copy of that tree into
# the payload, and a content comparison of the two (`Assert-ConfigTreesEqual`) that
# reads every file of both. Measured on a Debug build, 61 s of "config source stage",
# of which 46 s was that comparison. The tree only changes when the inputs of the
# deploy change, so after one build has staged and verified it in full, the next build
# with the same inputs can restore it instead.
#
# What makes a reuse sound, and what does not:
#   * The snapshot is keyed by every input the deploy reads (see
#     Get-ConfigSourceStageKey), so a different key can never restore it. A frozen
#     lockfile fixes the content of every package, which is what makes "same inputs"
#     mean "same bytes".
#   * It is only ever published after a FULL stage, i.e. after the content comparison
#     against the fresh deploy and the dependency audit have passed. The copy that
#     becomes the snapshot is checked against the staged tree by metadata, not bytes.
#   * Only development builds use it (build-native-backend.ps1: $reuseBuildCaches);
#     Release and -Sign builds always stage in full.
#   * Before it is used it is re-read as metadata (relative path, size, last-write
#     time of every entry) and compared with the inventory recorded at publication,
#     and the restored copy in the payload is compared with the same inventory. Any
#     mismatch - a file deleted by antivirus, truncated, touched, added - discards the
#     snapshot and the build falls back to the full stage. Nothing here can make a
#     build fail that the full stage would have passed.
#   * NOT detected: a snapshot file rewritten with different bytes of the same size
#     while its last-write time was restored, or bytes flipped in place by the disk.
#     The full stage's content comparison is what caught a bad copy, and a restore does
#     not repeat it; that is the price of skipping the 46 s. Nothing in this build
#     rewrites a file that way.
#
# It lives beside the other build caches, NOT under build\<Cfg>\servicehub: the
# ServiceHub PyInstaller step deletes and recreates that directory on every build.

$script:ConfigSourceSnapshotHeader = "# superclaw config-source snapshot v1"
# Captured here because Get-ConfigSourceStageKey hashes the sibling staging scripts and
# must not depend on what $PSScriptRoot means inside a function of a dot-sourced file.
$script:ConfigSourcePolicyRoot = $PSScriptRoot

function ConvertTo-ExtendedLengthPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  # node_modules nests deep, and the payload sits under a long repository path.
  # The extended-length prefix lets the .NET enumeration below cross MAX_PATH
  # instead of failing on the one package that does.
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd("\", "/")
  if ($full.StartsWith("\\?\", [System.StringComparison]::Ordinal)) {
    return $full
  }
  if ($full.StartsWith("\\", [System.StringComparison]::Ordinal)) {
    return "\\?\UNC\" + $full.Substring(2)
  }
  return "\\?\" + $full
}

function Get-ConfigTreeMetadataInventory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Root
  )

  # One line per directory ("D<TAB>path") and file ("F<TAB>path<TAB>bytes<TAB>ticks"),
  # ordinal-sorted. Metadata only: this is what makes the check cheap, and also what
  # it cannot see beyond (see the header).
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    throw "config dependency tree is missing: $Root"
  }
  $extendedRoot = ConvertTo-ExtendedLengthPath -Path $Root
  $prefixLength = $extendedRoot.Length + 1
  $inventory = [System.Collections.Generic.List[string]]::new()
  $directory = [System.IO.DirectoryInfo]::new($extendedRoot)
  foreach ($member in $directory.EnumerateFileSystemInfos(
      "*", [System.IO.SearchOption]::AllDirectories)) {
    if ($member.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      throw "config dependency tree may not contain reparse points: $($member.FullName)"
    }
    $relative = $member.FullName.Substring($prefixLength).Replace("\", "/")
    if ($member -is [System.IO.DirectoryInfo]) {
      $inventory.Add("D`t$relative")
    } else {
      $inventory.Add(
        "F`t$relative`t$([long]$member.Length)`t$($member.LastWriteTimeUtc.Ticks)"
      )
    }
  }
  $lines = $inventory.ToArray()
  [System.Array]::Sort($lines, [System.StringComparer]::Ordinal)
  return $lines
}

function Test-ConfigInventoryEqual {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$Expected,
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$Actual
  )

  return [System.StringComparer]::Ordinal.Equals(
    ($Expected -join "`n"),
    ($Actual -join "`n")
  )
}

function Get-ConfigSourceStageKey {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [Parameter(Mandatory = $true)]
    [string]$PnpmVersion
  )

  # Every input of `pnpm fetch` + `pnpm deploy` as Stage-DeterministicConfigSource runs
  # them: the workspace and its lock, the importer being deployed, the pnpm settings
  # that can change what is materialised (.npmrc, .pnpmfile.cjs, root package.json for
  # overrides/patches), the pinned pnpm, and the host architecture that selects
  # optional native packages. The staging scripts themselves are inputs too: a change
  # to the deploy flags or the exclusion list must not restore a tree built by the old
  # ones. A file that is absent hashes as "absent", so adding one changes the key.
  # Deliberately over-inclusive - the root lock changes with any workspace dependency
  # bump, which costs a full stage but never a stale tree.
  $importer = (Get-ConfigDependencyImporterRelativePath) + "/package.json"
  $inputs = @(
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    ".pnpmfile.cjs",
    $importer
  )
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("pnpm`t$PnpmVersion")
  $lines.Add("arch`t$($env:PROCESSOR_ARCHITECTURE)")
  foreach ($policyFile in @(
      "config-staging-policy.ps1",
      "config-source-snapshot-policy.ps1"
    )) {
    $lines.Add(
      "script:$policyFile`t" +
      (Get-FileHash -LiteralPath (Join-Path $script:ConfigSourcePolicyRoot $policyFile) -Algorithm SHA256).Hash
    )
  }
  foreach ($relative in $inputs) {
    $path = Join-Path $RepoRoot $relative.Replace("/", "\")
    $digest = if (Test-Path -LiteralPath $path -PathType Leaf) {
      (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    } else {
      "absent"
    }
    $lines.Add("input:$relative`t$digest")
  }
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha256.ComputeHash(
      [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
    )
  } finally {
    $sha256.Dispose()
  }
  return ([System.BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant())
}

function Get-ConfigSourceSnapshotDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot,
    [Parameter(Mandatory = $true)]
    [string]$Key
  )

  # Short on purpose: the tree under it is as deep as the payload's, and the
  # repository path in front is already long.
  return Join-Path $CacheRoot ("cfg-" + $Key.Substring(0, 16))
}

function Restore-ConfigSourceSnapshot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot,
    [Parameter(Mandatory = $true)]
    [string]$Key,
    [Parameter(Mandatory = $true)]
    [string]$DestinationModules
  )

  # Returns $true only when DestinationModules now holds a tree whose metadata equals
  # the inventory recorded when the snapshot was published. Any other outcome returns
  # $false with DestinationModules removed, and the caller stages in full.
  $snapshot = Get-ConfigSourceSnapshotDirectory -CacheRoot $CacheRoot -Key $Key
  $inventoryPath = Join-Path $snapshot "inventory.tsv"
  $snapshotModules = Join-Path $snapshot "node_modules"
  if (
    -not (Test-Path -LiteralPath $inventoryPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $snapshotModules -PathType Container)
  ) {
    return $false
  }
  $snapshotVerified = $false
  try {
    Assert-NoReparsePathComponents -Path $CacheRoot
    $recorded = @([System.IO.File]::ReadAllLines($inventoryPath))
    if (
      $recorded.Count -lt 2 -or
      $recorded[0] -cne $script:ConfigSourceSnapshotHeader -or
      $recorded[1] -cne "# key $Key"
    ) {
      throw "snapshot inventory header does not match this build's inputs"
    }
    $expected = @($recorded | Select-Object -Skip 2)
    $live = @(Invoke-NativeTimedStep -Label "config source snapshot verify" -Action {
        Get-ConfigTreeMetadataInventory -Root $snapshotModules
      })
    if (-not (Test-ConfigInventoryEqual -Expected $expected -Actual $live)) {
      throw "snapshot no longer matches the inventory recorded when it was published"
    }
    $snapshotVerified = $true

    Copy-PhysicalConfigDependencyTree `
      -SourceModules $snapshotModules `
      -DestinationModules $DestinationModules `
      -SkipContentEquality
    $restored = @(Get-ConfigTreeMetadataInventory -Root $DestinationModules)
    if (-not (Test-ConfigInventoryEqual -Expected $expected -Actual $restored)) {
      throw "restored config dependency tree differs from the snapshot"
    }
    Write-Host "ok: reused verified config-source snapshot ($snapshot)"
    return $true
  } catch {
    Write-Host (
      "note: config-source snapshot not reused, staging in full: " +
      $_.Exception.Message
    ) -ForegroundColor Yellow
    if (-not $snapshotVerified -and (Test-Path -LiteralPath $snapshot)) {
      # The snapshot itself is wrong; a later build must not trip over it again.
      Remove-Item -LiteralPath $snapshot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $DestinationModules) {
      Remove-Item -LiteralPath $DestinationModules -Recurse -Force
    }
    return $false
  }
}

function Publish-ConfigSourceSnapshot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot,
    [Parameter(Mandatory = $true)]
    [string]$Key,
    [Parameter(Mandatory = $true)]
    [string]$StagedModules
  )

  # Call this only for a tree that has passed the full stage's content comparison and
  # audit. Failing to publish costs the next build its shortcut and nothing else, so
  # it never fails this one.
  $snapshot = Get-ConfigSourceSnapshotDirectory -CacheRoot $CacheRoot -Key $Key
  $temporary = Join-Path $CacheRoot ("tmp-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 12))
  try {
    Assert-NoReparsePathComponents -Path $CacheRoot
    $temporaryModules = Join-Path $temporary "node_modules"
    New-Item -ItemType Directory -Force $temporaryModules | Out-Null
    robocopy $StagedModules $temporaryModules /E `
      /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -lt 0 -or $LASTEXITCODE -ge 8) {
      throw "snapshot copy failed (robocopy exit $LASTEXITCODE)"
    }
    $global:LASTEXITCODE = 0
    $inventory = @(Get-ConfigTreeMetadataInventory -Root $temporaryModules)
    $staged = @(Get-ConfigTreeMetadataInventory -Root $StagedModules)
    if (-not (Test-ConfigInventoryEqual -Expected $staged -Actual $inventory)) {
      throw "snapshot copy differs from the staged tree"
    }
    # Written last: a snapshot without its inventory is not a snapshot.
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add($script:ConfigSourceSnapshotHeader)
    $lines.Add("# key $Key")
    $lines.AddRange([string[]]$inventory)
    [System.IO.File]::WriteAllLines((Join-Path $temporary "inventory.tsv"), $lines)

    if (Test-Path -LiteralPath $snapshot) {
      Remove-Item -LiteralPath $snapshot -Recurse -Force
    }
    Move-Item -LiteralPath $temporary -Destination $snapshot
    # One snapshot is enough: an older key can only be restored by reverting inputs,
    # and keeping every one would grow the cache by a tree per lockfile change.
    foreach ($other in Get-ChildItem -LiteralPath $CacheRoot -Directory -Force |
        Where-Object {
          $_.Name -like "cfg-*" -or $_.Name -like "tmp-*"
        }) {
      if ($other.FullName -ne $snapshot) {
        Remove-Item -LiteralPath $other.FullName -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
    Write-Host "ok: published config-source snapshot ($snapshot)"
  } catch {
    Write-Host (
      "note: could not publish config-source snapshot: " + $_.Exception.Message
    ) -ForegroundColor Yellow
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
