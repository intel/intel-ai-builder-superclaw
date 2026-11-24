# Config staging was the build's largest silent gap: minutes passed between two
# `ok:` lines with nothing attributing them. Its inner steps are timed through the
# shared wrapper, which is dot-sourced here so this policy still runs standalone.
. (Join-Path $PSScriptRoot "build-step-timing.ps1")
. (Join-Path $PSScriptRoot "config-source-snapshot-policy.ps1")

function Assert-ValidConfigPackageName {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PackageName
  )

  if (
    $PackageName.Length -gt 214 -or
    -not [System.Text.RegularExpressions.Regex]::IsMatch(
      $PackageName,
      "^(?:@[a-z0-9][a-z0-9._~-]*/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$",
      [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
    )
  ) {
    throw "invalid config package name '$PackageName'"
  }
  foreach ($component in $PackageName.Split("/")) {
    if ($component -in @(".", "..")) {
      throw "invalid config package name '$PackageName'"
    }
  }
  return $PackageName
}

function Get-ConfigPackageNames {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Manifest,
    [string]$Field = "dependencies"
  )

  $value = $Manifest.$Field
  if ($null -eq $value) {
    return @()
  }
  $names = @($value.PSObject.Properties.Name | Sort-Object)
  foreach ($name in $names) {
    [void](Assert-ValidConfigPackageName -PackageName $name)
  }
  return $names
}

function Get-ConfigPackagePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$NodeModules,
    [Parameter(Mandatory = $true)]
    [string]$PackageName
  )

  $root = Get-NormalizedManagedPath -Path $NodeModules
  [void](Assert-ValidConfigPackageName -PackageName $PackageName)
  $candidate = $root
  foreach ($component in $PackageName.Split("/")) {
    $candidate = Join-Path $candidate $component
  }
  $candidate = Get-NormalizedManagedPath -Path $candidate
  if (-not (Test-ManagedPathWithin -Path $candidate -Root $root)) {
    throw "config package path escapes node_modules: $PackageName"
  }
  return $candidate
}

function Get-ConfigPackageIdentityFromPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$NodeModules,
    [Parameter(Mandatory = $true)]
    [string]$PackagePath
  )

  $root = Get-NormalizedManagedPath -Path $NodeModules
  $package = Get-NormalizedManagedPath -Path $PackagePath
  if (-not (Test-ManagedPathWithin -Path $package -Root $root)) {
    throw "physical config package escapes node_modules: $package"
  }
  $packageLeaf = [System.IO.Path]::GetFileName($package)
  $parent = [System.IO.Path]::GetDirectoryName($package)
  $parentLeaf = [System.IO.Path]::GetFileName($parent)
  if ($parentLeaf.StartsWith("@", [System.StringComparison]::Ordinal)) {
    $moduleRoot = [System.IO.Path]::GetDirectoryName($parent)
    if (
      -not [System.IO.Path]::GetFileName($moduleRoot).Equals(
        "node_modules",
        [System.StringComparison]::OrdinalIgnoreCase
      )
    ) {
      throw "invalid scoped config package layout: $package"
    }
    $identity = "$parentLeaf/$packageLeaf"
  } else {
    if (
      -not $parentLeaf.Equals(
        "node_modules",
        [System.StringComparison]::OrdinalIgnoreCase
      )
    ) {
      throw "invalid config package layout: $package"
    }
    $identity = $packageLeaf
  }
  [void](Assert-ValidConfigPackageName -PackageName $identity)
  return $identity
}

function Assert-PinnedConfigPackageManager {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [string]$PnpmExecutable = "pnpm"
  )

  $rootPackagePath = Join-Path $RepoRoot "package.json"
  $rootPackage = Get-Content -LiteralPath $rootPackagePath -Raw | ConvertFrom-Json
  if ($rootPackage.packageManager -notmatch "^pnpm@(?<version>[0-9]+\.[0-9]+\.[0-9]+)$") {
    throw "root packageManager must contain an exact pnpm version pin"
  }
  $expectedVersion = $Matches.version
  Push-Location $RepoRoot
  try {
    $actualVersion = (& $PnpmExecutable --version | Out-String).Trim()
    $pnpmExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($pnpmExitCode -ne 0 -or $actualVersion -ne $expectedVersion) {
    throw "pnpm version mismatch: expected $expectedVersion, got '$actualVersion'"
  }
  Write-Host "using pnpm = $PnpmExecutable ($actualVersion)"
  return $expectedVersion
}

function Get-PhysicalConfigTreeInventory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [string[]]$ExcludedRootEntries = @()
  )

  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    throw "config dependency tree is missing: $Root"
  }
  Assert-NoReparseTree -Root $Root
  $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path.TrimEnd("\", "/")
  $rootPrefix = $resolvedRoot + "\"
  $entries = @()
  $files = @()
  foreach ($member in Get-ChildItem -LiteralPath $resolvedRoot -Recurse -Force |
      Sort-Object FullName) {
    $relative = $member.FullName.Substring($rootPrefix.Length).Replace("\", "/")
    $rootEntry = $relative.Split("/")[0]
    if ($rootEntry -in $ExcludedRootEntries) {
      continue
    }
    if ($member.PSIsContainer) {
      $entries += "D`t$relative"
      continue
    }
    if (-not (Test-Path -LiteralPath $member.FullName -PathType Leaf)) {
      throw "config dependency entry is not a regular file: $($member.FullName)"
    }
    $entries += "F`t$relative`t$([long]$member.Length)`t"
    $files += $member.FullName
  }
  # One Get-FileHash per file costs more in per-call overhead than in reading the
  # bytes (3,791 files, 55 MB took about a minute), so every file is hashed in
  # one parallel SHA-256 pass instead. Same algorithm, same bytes, same digest.
  $hashes = @(if ($files.Count -gt 0) { Get-CanonicalPayloadHashes -Paths $files })
  if ($hashes.Count -ne $files.Count) {
    throw "config dependency hashing returned $($hashes.Count) digests for $($files.Count) files under $Root"
  }
  $inventory = @()
  $fileIndex = 0
  foreach ($entry in $entries) {
    if ($entry.StartsWith("F`t", [System.StringComparison]::Ordinal)) {
      $entry += $hashes[$fileIndex]
      $fileIndex++
    }
    $inventory += $entry
  }
  return @($inventory)
}

function Assert-ConfigTreesEqual {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ExpectedRoot,
    [Parameter(Mandatory = $true)]
    [string]$ActualRoot,
    [string[]]$ExcludedExpectedRootEntries = @()
  )

  $expected = @(Get-PhysicalConfigTreeInventory `
      -Root $ExpectedRoot `
      -ExcludedRootEntries $ExcludedExpectedRootEntries)
  $actual = @(Get-PhysicalConfigTreeInventory -Root $ActualRoot)
  if (
    [System.StringComparer]::Ordinal.Compare(
      ($expected -join "`n"),
      ($actual -join "`n")
    ) -ne 0
  ) {
    throw "staged config dependency tree differs from the dedicated deploy graph"
  }
}

function Copy-PhysicalConfigDependencyTree {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourceModules,
    [Parameter(Mandatory = $true)]
    [string]$DestinationModules,
    # A tree restored from a verified snapshot is compared by metadata by the
    # caller; the content comparison below is the full stage's check on a tree that
    # was just copied from a fresh deploy.
    [switch]$SkipContentEquality
  )

  # pnpm's hoisted deploy is the resolution authority. Its manager bookkeeping
  # embeds timestamps and absolute store/temp paths, so materialize every runtime
  # entry while excluding only these exact non-runtime root entries.
  $pnpmBookkeeping = @(
    ".modules.yaml",
    ".pnpm",
    ".pnpm-workspace-state-v1.json"
  )
  Assert-NoReparseTree -Root $SourceModules
  Assert-NoReparsePathComponents -Path $DestinationModules
  if (Test-Path -LiteralPath $DestinationModules) {
    Assert-NoReparseTree -Root $DestinationModules
    Remove-Item -LiteralPath $DestinationModules -Recurse -Force
  }
  New-Item -ItemType Directory -Force $DestinationModules | Out-Null

  # Timed on its own so it does not fold the equality pass below into the same
  # duration: the two are separate steps that must not double-count the same
  # wall-clock span against the stage total.
  Invoke-NativeTimedStep -Label "config source dependency tree copy" -Action {
    foreach ($entry in Get-ChildItem -LiteralPath $SourceModules -Force | Sort-Object Name) {
      if ($entry.Name -in $pnpmBookkeeping) {
        continue
      }
      if ($entry.PSIsContainer) {
        $entryDestination = Join-Path $DestinationModules $entry.Name
        robocopy $entry.FullName $entryDestination /E `
          /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -lt 0 -or $LASTEXITCODE -ge 8) {
          throw "physical config dependency copy failed for $($entry.Name) (exit $LASTEXITCODE)"
        }
        $global:LASTEXITCODE = 0
        continue
      }
      if (-not (Test-Path -LiteralPath $entry.FullName -PathType Leaf)) {
        throw "deployed config dependency entry is not regular: $($entry.FullName)"
      }
      Copy-Item -LiteralPath $entry.FullName -Destination $DestinationModules -Force
    }
  }

  if ($SkipContentEquality) {
    return
  }
  # This hashes both trees end to end - tens of thousands of files - so it is a
  # step in its own right rather than part of the copy it follows.
  Invoke-NativeTimedStep -Label "config source deployed tree equality" -Action {
    Assert-ConfigTreesEqual `
      -ExpectedRoot $SourceModules `
      -ActualRoot $DestinationModules `
      -ExcludedExpectedRootEntries $pnpmBookkeeping
  }
}

function Get-ConfigPackageDirectories {
  param(
    [Parameter(Mandatory = $true)]
    [string]$NodeModules
  )

  $root = Get-NormalizedManagedPath -Path $NodeModules
  $moduleRoots = @($root)
  $moduleRoots += @(
    Get-ChildItem -LiteralPath $root -Recurse -Directory -Filter "node_modules" |
      ForEach-Object { $_.FullName }
  )
  $packages = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  foreach ($moduleRoot in $moduleRoots | Sort-Object -Unique) {
    $normalizedModuleRoot = Get-NormalizedManagedPath -Path $moduleRoot
    if (
      -not (Test-ManagedPathWithin -Path $normalizedModuleRoot -Root $root -AllowEqual)
    ) {
      throw "nested node_modules escapes config dependency root: $normalizedModuleRoot"
    }
    foreach ($entry in Get-ChildItem -LiteralPath $moduleRoot -Force -Directory) {
      if ($entry.Name.StartsWith(".", [System.StringComparison]::Ordinal)) {
        if (Test-Path -LiteralPath (Join-Path $entry.FullName "package.json") -PathType Leaf) {
          throw "invalid config package layout: $($entry.FullName)"
        }
        continue
      }
      if ($entry.Name.StartsWith("@", [System.StringComparison]::Ordinal)) {
        if (Test-Path -LiteralPath (Join-Path $entry.FullName "package.json") -PathType Leaf) {
          throw "invalid scoped config package layout: $($entry.FullName)"
        }
        foreach ($scopedPackage in Get-ChildItem -LiteralPath $entry.FullName -Force -Directory) {
          if (Test-Path -LiteralPath (Join-Path $scopedPackage.FullName "package.json") -PathType Leaf) {
            [void](Get-ConfigPackageIdentityFromPath `
                -NodeModules $root `
                -PackagePath $scopedPackage.FullName)
            [void]$packages.Add($scopedPackage.FullName)
          }
        }
        continue
      }
      if (Test-Path -LiteralPath (Join-Path $entry.FullName "package.json") -PathType Leaf) {
        [void](Get-ConfigPackageIdentityFromPath `
            -NodeModules $root `
            -PackagePath $entry.FullName)
        [void]$packages.Add($entry.FullName)
      }
    }
  }
  return @($packages | Sort-Object)
}

function Resolve-ConfigPackage {
  param(
    [Parameter(Mandatory = $true)]
    [string]$NodeModules,
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,
    [Parameter(Mandatory = $true)]
    [string]$PackageName
  )

  $root = Get-NormalizedManagedPath -Path $NodeModules
  $current = Get-NormalizedManagedPath -Path $PackagePath
  [void](Assert-ValidConfigPackageName -PackageName $PackageName)
  if (-not (Test-ManagedPathWithin -Path $current -Root $root)) {
    throw "config package resolution starts outside node_modules: $current"
  }
  while ($true) {
    $candidateModules = if (
      [System.IO.Path]::GetFileName($current).Equals(
        "node_modules",
        [System.StringComparison]::OrdinalIgnoreCase
      )
    ) {
      $current
    } else {
      Join-Path $current "node_modules"
    }
    $candidateModules = Get-NormalizedManagedPath -Path $candidateModules
    if (
      -not (Test-ManagedPathWithin -Path $candidateModules -Root $root -AllowEqual)
    ) {
      throw "config package resolution escaped node_modules: $candidateModules"
    }
    $candidate = Get-ConfigPackagePath `
      -NodeModules $candidateModules `
      -PackageName $PackageName
    $candidateManifestPath = Join-Path $candidate "package.json"
    if (Test-Path -LiteralPath $candidateManifestPath -PathType Leaf) {
      $candidateManifest = Get-Content -LiteralPath $candidateManifestPath -Raw |
        ConvertFrom-Json
      if (
        -not [string]$candidateManifest.name -or
        -not ([string]$candidateManifest.name).Equals(
          $PackageName,
          [System.StringComparison]::Ordinal
        )
      ) {
        throw "resolved config package identity mismatch for '$PackageName': $candidate"
      }
      return $candidate
    }
    if ($current.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $null
    }
    $current = [System.IO.Path]::GetDirectoryName($current)
    if (
      -not $current -or
      -not (Test-ManagedPathWithin -Path $current -Root $root -AllowEqual)
    ) {
      return $null
    }
  }
}

function Get-AuditedConfigLifecycleAllowlist {
  # msgpackr-extract's exact install command only selects/builds its native
  # binding. The locked 3.0.4 tarballs already include the win32-x64 optional
  # package and both of its prebuilds, so no lifecycle execution or network is
  # needed.
  #
  # RequiredArtifacts lists every prebuild in that locked tarball, because which
  # one gets loaded depends on the running Node's ABI. node-gyp-build's
  # compareTags documents its precedence as "abi over napi", so Node 20
  # (ABI 115) loads node.abi115.node while newer runtimes filter that candidate
  # out and fall back to node.napi.node. Pinning a single filename here made the
  # load probe fail on whichever runtime did not pick it. All of them must be
  # present (the version is pinned, so a missing one means the tarball changed)
  # and the probe below requires the loader to land on one of them.
  return @(
    [PSCustomObject]@{
      PackageName = "msgpackr-extract"
      PackageVersion = "3.0.4"
      Lifecycle = "install"
      Script = "node-gyp-build-optional-packages"
      RequiredPackageName = "@msgpackr-extract/msgpackr-extract-win32-x64"
      RequiredPackageVersion = "3.0.4"
      RequiredArtifacts = @("node.abi115.node", "node.napi.node")
      LoadProbe = "msgpackr-extract"
    }
  )
}

function Assert-ConfigPackageLifecycleScripts {
  param(
    [Parameter(Mandatory = $true)]
    [string]$NodeModules,
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,
    [Parameter(Mandatory = $true)]
    [object]$Manifest,
    [string]$NodeExecutable = "node"
  )

  $scripts = $Manifest.scripts
  if ($null -eq $scripts) {
    return
  }
  $allowlist = @(Get-AuditedConfigLifecycleAllowlist)
  foreach ($lifecycle in @("preinstall", "install", "postinstall")) {
    $property = $scripts.PSObject.Properties[$lifecycle]
    if ($null -eq $property) {
      continue
    }
    if ($property.Value -isnot [string]) {
      throw "config lifecycle script must be text: $($Manifest.name)@$($Manifest.version) $lifecycle"
    }
    $script = [string]$property.Value
    $matches = @(
      $allowlist | Where-Object {
        $_.PackageName -ceq [string]$Manifest.name -and
        $_.PackageVersion -ceq [string]$Manifest.version -and
        $_.Lifecycle -ceq $lifecycle -and
        $_.Script -ceq $script
      }
    )
    if ($matches.Count -ne 1) {
      throw (
        "config lifecycle script is forbidden under --ignore-scripts: " +
        "$($Manifest.name)@$($Manifest.version) $lifecycle='$script'"
      )
    }

    $audit = $matches[0]
    $requiredPackage = Get-ConfigPackagePath `
      -NodeModules $NodeModules `
      -PackageName $audit.RequiredPackageName
    $requiredManifestPath = Join-Path $requiredPackage "package.json"
    if (-not (Test-Path -LiteralPath $requiredManifestPath -PathType Leaf)) {
      throw "allowlisted config lifecycle output package is missing: $($audit.RequiredPackageName)"
    }
    $requiredManifest = Get-Content -LiteralPath $requiredManifestPath -Raw |
      ConvertFrom-Json
    if (
      -not ([string]$requiredManifest.name).Equals(
        $audit.RequiredPackageName,
        [System.StringComparison]::Ordinal
      ) -or
      [string]$requiredManifest.version -cne $audit.RequiredPackageVersion
    ) {
      throw "allowlisted config lifecycle output package identity mismatch"
    }
    $artifacts = @()
    foreach ($artifactName in $audit.RequiredArtifacts) {
      $artifact = Get-NormalizedManagedPath -Path (
        Join-Path $requiredPackage $artifactName
      )
      if (
        -not (Test-ManagedPathWithin -Path $artifact -Root $requiredPackage) -or
        -not (Test-Path -LiteralPath $artifact -PathType Leaf)
      ) {
        throw "allowlisted config lifecycle output is missing: $artifact"
      }
      $artifacts += $artifact
    }

    $probeRoot = [System.IO.Path]::GetDirectoryName(
      (Get-NormalizedManagedPath -Path $NodeModules)
    )
    $probeModuleBase64 = [System.Convert]::ToBase64String(
      [System.Text.Encoding]::UTF8.GetBytes([string]$audit.LoadProbe)
    )
    # Newline-separated: a Windows path cannot contain one, so it is an
    # unambiguous separator for the allowed-artifact list.
    $artifactsBase64 = [System.Convert]::ToBase64String(
      [System.Text.Encoding]::UTF8.GetBytes(($artifacts -join "`n"))
    )
    $probeScript = @"
const path = require('path');
const name = Buffer.from('$probeModuleBase64', 'base64').toString('utf8');
const expected = Buffer.from('$artifactsBase64', 'base64')
  .toString('utf8')
  .split('\n')
  .map((entry) => path.resolve(entry).toLowerCase());
const packageRoot = path.dirname(require.resolve(name + '/package.json'));
const loader = require('node-gyp-build-optional-packages');
const actual = path.resolve(loader.path(packageRoot));
if (!expected.includes(actual.toLowerCase())) {
  throw new Error('native output mismatch: ' + actual);
}
require(name);
"@
    Push-Location $probeRoot
    try {
      $previousErrorActionPreference = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      try {
        $probeOutput = (& $NodeExecutable -e $probeScript 2>&1 |
            Out-String).Trim()
        $probeExitCode = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorActionPreference
      }
      if ($probeExitCode -ne 0) {
        throw (
          "allowlisted config lifecycle load probe failed for " +
          "$($audit.PackageName)@$($audit.PackageVersion): $probeOutput"
        )
      }
    } finally {
      Pop-Location
    }
  }
}

function Assert-PhysicalConfigDependencies {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigRoot,
    [string]$AuthoritativeModules = "",
    [Parameter(Mandatory = $true)]
    [string]$DirectPackageName,
    [Parameter(Mandatory = $true)]
    [string]$DirectPackageVersion
  )

  $packagePath = Join-Path $ConfigRoot "package.json"
  $nodeModules = Join-Path $ConfigRoot "node_modules"
  if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "staged config package metadata is missing: $packagePath"
  }
  if (-not (Test-Path -LiteralPath $nodeModules -PathType Container)) {
    throw "staged config production dependencies are missing: $nodeModules"
  }
  if ($AuthoritativeModules) {
    Assert-ConfigTreesEqual `
      -ExpectedRoot $AuthoritativeModules `
      -ActualRoot $nodeModules `
      -ExcludedExpectedRootEntries @(
        ".modules.yaml",
        ".pnpm",
        ".pnpm-workspace-state-v1.json"
      )
  }

  $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
  if ($package.dependencies.$DirectPackageName -ne $DirectPackageVersion) {
    throw (
      "config direct dependency must be exactly " +
      "$DirectPackageName@$DirectPackageVersion"
    )
  }
  $directPath = Get-ConfigPackagePath `
    -NodeModules $nodeModules `
    -PackageName $DirectPackageName
  $directManifestPath = Join-Path $directPath "package.json"
  if (-not (Test-Path -LiteralPath $directManifestPath -PathType Leaf)) {
    throw "staged direct config dependency is missing: $DirectPackageName"
  }
  $directManifest = Get-Content -LiteralPath $directManifestPath -Raw | ConvertFrom-Json
  if (
    $directManifest.name -ne $DirectPackageName -or
    $directManifest.version -ne $DirectPackageVersion
  ) {
    throw "staged direct config dependency version mismatch: $DirectPackageName"
  }

  $packageDirectories = @(Get-ConfigPackageDirectories -NodeModules $nodeModules)
  foreach ($physicalPackage in $packageDirectories) {
    $manifestPath = Join-Path $physicalPackage "package.json"
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if (-not $manifest.name -or -not $manifest.version) {
      throw "config dependency package metadata is incomplete: $physicalPackage"
    }
    $expectedName = Get-ConfigPackageIdentityFromPath `
      -NodeModules $nodeModules `
      -PackagePath $physicalPackage
    if (
      -not ([string]$manifest.name).Equals(
        $expectedName,
        [System.StringComparison]::Ordinal
      )
    ) {
      throw (
        "config dependency package identity mismatch: path '$expectedName', " +
        "manifest '$($manifest.name)'"
      )
    }
    [void](Assert-ValidConfigPackageName -PackageName ([string]$manifest.name))
    Assert-ConfigPackageLifecycleScripts `
      -NodeModules $nodeModules `
      -PackagePath $physicalPackage `
      -Manifest $manifest
    $optionalNames = @(Get-ConfigPackageNames -Manifest $manifest -Field "optionalDependencies")
    foreach ($dependencyName in Get-ConfigPackageNames -Manifest $manifest) {
      if ($dependencyName -in $optionalNames) {
        continue
      }
      if (-not (Resolve-ConfigPackage `
          -NodeModules $nodeModules `
          -PackagePath $physicalPackage `
          -PackageName $dependencyName)) {
        throw (
          "config dependency '$dependencyName' is unresolved for " +
          "$($manifest.name)@$($manifest.version)"
        )
      }
    }
    foreach ($peerName in Get-ConfigPackageNames -Manifest $manifest -Field "peerDependencies") {
      $peerMetadata = $manifest.peerDependenciesMeta.$peerName
      $optionalPeer = $peerMetadata -and $peerMetadata.optional -eq $true
      if (
        -not $optionalPeer -and
        -not (Resolve-ConfigPackage `
          -NodeModules $nodeModules `
          -PackagePath $physicalPackage `
          -PackageName $peerName)
      ) {
        throw (
          "required config peer '$peerName' is unresolved for " +
          "$($manifest.name)@$($manifest.version)"
        )
      }
    }
  }
  Write-Host "ok: staged config dependency graph contains $($packageDirectories.Count) packages"
}

function Get-ConfigDependencyImporterRelativePath {
  return "scripts/native-backend/config-deps"
}

function Assert-ProductProfileDependencyParity {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot
  )

  # Every packaged Product Profile declares the same OpenCode dependency set, so
  # one importer can produce the single dependency tree all three reuse. Fail
  # closed rather than silently staging one Profile's dependencies for the others.
  $profilesRoot = Join-Path $RepoRoot "sandbox\agent_config\profiles"
  $profileIds = @("lite", "standard", "pro")
  $referenceId = $profileIds[0]
  $manifestHashes = @{}
  foreach ($profileId in $profileIds) {
    $manifestPath = Join-Path (Join-Path $profilesRoot $profileId) "package.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
      throw "Product Profile dependency manifest is missing: $manifestPath"
    }
    $manifestHashes[$profileId] = (
      Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256
    ).Hash.ToLower()
  }
  foreach ($profileId in $profileIds) {
    if ($manifestHashes[$profileId] -cne $manifestHashes[$referenceId]) {
      throw (
        "Product Profile package.json files must be byte-identical: " +
        "'$profileId' differs from '$referenceId'"
      )
    }
  }

  $referenceManifest = Join-Path (Join-Path $profilesRoot $referenceId) "package.json"
  $profilePackage = Get-Content -LiteralPath $referenceManifest -Raw | ConvertFrom-Json
  $profilePin = [string]$profilePackage.dependencies."@opencode-ai/plugin"
  if (-not $profilePin) {
    throw "Product Profile package.json does not pin @opencode-ai/plugin"
  }

  $importerRelative = Get-ConfigDependencyImporterRelativePath
  $importerManifest = Join-Path (
    Join-Path $RepoRoot $importerRelative.Replace("/", "\")
  ) "package.json"
  if (-not (Test-Path -LiteralPath $importerManifest -PathType Leaf)) {
    throw "config dependency importer manifest is missing: $importerManifest"
  }
  $importerPackage = Get-Content -LiteralPath $importerManifest -Raw | ConvertFrom-Json
  $importerPin = [string]$importerPackage.dependencies."@opencode-ai/plugin"
  if ($importerPin -cne $profilePin) {
    throw (
      "config dependency importer must pin @opencode-ai/plugin@$profilePin " +
      "to match the Product Profiles, found '$importerPin'"
    )
  }

  # The payload ships this Profile's npm lock too and the runtime seeds it, so a pin
  # bump that forgets it ships a lock describing the previous version beside a tree
  # holding the new one. pnpm-lock.yaml needs no check here: the deploy runs
  # --frozen-lockfile against the importer manifest gated above. Read as text, because
  # Windows PowerShell's ConvertFrom-Json rejects any lock whose root key is "".
  $referenceLock = Join-Path (Join-Path $profilesRoot $referenceId) "package-lock.json"
  if (-not (Test-Path -LiteralPath $referenceLock -PathType Leaf)) {
    throw "Product Profile dependency lock is missing: $referenceLock"
  }
  $lockText = Get-Content -LiteralPath $referenceLock -Raw
  $lockPatterns = [ordered]@{
    declares = '(?s)"packages"\s*:\s*\{\s*""\s*:\s*\{.*?"@opencode-ai/plugin"\s*:\s*"([^"]+)"'
    resolves = '(?s)"node_modules/@opencode-ai/plugin"\s*:\s*\{\s*"version"\s*:\s*"([^"]+)"'
  }
  foreach ($label in $lockPatterns.Keys) {
    $found = [regex]::Match($lockText, $lockPatterns[$label])
    if (-not $found.Success) {
      throw "cannot read the @opencode-ai/plugin version the lock $label from $referenceLock"
    }
    if ($found.Groups[1].Value -cne $profilePin) {
      throw ("Product Profile package-lock.json $label @opencode-ai/plugin@" +
        "$($found.Groups[1].Value) but the Profile pins $profilePin. Regenerate it with " +
        "npm install --package-lock-only --omit=dev beside the Profile's package.json.")
    }
  }
  return $profilePin
}

function Get-SchedulerPin {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot
  )

  # The importer manifest is the one place the scheduler version is pinned.
  $importerRelative = Get-ConfigDependencyImporterRelativePath
  $importerManifest = Join-Path (
    Join-Path $RepoRoot $importerRelative.Replace("/", "\")
  ) "package.json"
  if (-not (Test-Path -LiteralPath $importerManifest -PathType Leaf)) {
    throw "config dependency importer manifest is missing: $importerManifest"
  }
  $importerPackage = Get-Content -LiteralPath $importerManifest -Raw | ConvertFrom-Json
  $pin = [string]$importerPackage.dependencies."opencode-scheduler"
  if (-not $pin) {
    throw "config dependency importer does not pin opencode-scheduler"
  }
  [void](Assert-ValidConfigPackageName -PackageName "opencode-scheduler")
  return $pin
}

function Stage-OpencodePluginCacheEntry {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadRoot,
    [Parameter(Mandatory = $true)]
    [string]$SchedulerVersion
  )

  # opencode does not load a declared plugin out of the config directory's
  # node_modules. It resolves each one through its own cache and installs from
  # the registry when the entry is absent, which is the one thing that sends an
  # installed host to the network during startup.
  #
  # Only the manifest ships here. The dependency tree it names is already in
  # `config-source`, and the deploy composes the two rather than the payload
  # carrying a second copy of 27 packages.
  #
  # `package-lock.json` is deliberately not written. Measured: opencode starts
  # offline without it, and producing one needs registry metadata that an
  # offline build does not have.
  #
  # `@latest` is the only entry seeded. Measured: it is the one opencode reads
  # for a profile that declares the plugin without a version.
  $entry = Join-Path (
    Join-Path (Join-Path $PayloadRoot "opencode-cache") "packages"
  ) "opencode-scheduler@latest"
  Assert-NoReparsePathComponents -Path $entry
  if (Test-Path -LiteralPath $entry) {
    Assert-NoReparseTree -Root $entry
    Remove-Item -LiteralPath $entry -Recurse -Force
  }
  New-Item -ItemType Directory -Force $entry | Out-Null

  # LF and no BOM, written byte-exactly: this file is covered by the payload
  # manifest digest, so a line ending decided by the host's PowerShell would
  # make the payload differ between machines that built the same commit.
  $manifest = (
    "{`n" +
    "  `"dependencies`": {`n" +
    "    `"opencode-scheduler`": `"$SchedulerVersion`"`n" +
    "  }`n" +
    "}`n"
  )
  [System.IO.File]::WriteAllText(
    (Join-Path $entry "package.json"),
    $manifest,
    (New-Object System.Text.UTF8Encoding($false))
  )
  Write-Host "ok: seeded opencode plugin cache entry for opencode-scheduler@$SchedulerVersion"
}

function Stage-DeterministicConfigSource {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [Parameter(Mandatory = $true)]
    [string]$PayloadRoot,
    [Parameter(Mandatory = $true)]
    [bool]$CompletePayload,
    [string]$PnpmExecutable = "pnpm",
    # Where verified snapshots of the staged dependency tree are kept between
    # builds (config-source-snapshot-policy.ps1). Empty disables reuse, which is
    # what every caller that does not own a build tree wants.
    [string]$StageCacheRoot = ""
  )

  # Since v1.2 the OpenCode configuration tree ships as a Product Profile, which
  # the runtime seeds from `agent-config/profiles/<id>`. What the payload still
  # owes the runtime is the offline dependency tree the Profiles only declare, so
  # `config-source` carries `node_modules` plus the manifests that pin it.
  $configDestination = Join-Path $PayloadRoot "config-source"
  if (-not $CompletePayload) {
    New-Item -ItemType Directory -Force $configDestination | Out-Null
    Write-Host "ok: additive config source preserved in $configDestination"
    return
  }
  if (Test-Path -LiteralPath $configDestination) {
    Assert-NoReparseTree -Root $configDestination
    Remove-Item -LiteralPath $configDestination -Recurse -Force
  }
  New-Item -ItemType Directory -Force $configDestination | Out-Null

  $pluginVersion = Assert-ProductProfileDependencyParity -RepoRoot $RepoRoot
  $schedulerVersion = Get-SchedulerPin -RepoRoot $RepoRoot
  $pnpmVersion = Assert-PinnedConfigPackageManager `
    -RepoRoot $RepoRoot `
    -PnpmExecutable $PnpmExecutable

  # The shipped manifests are the Profile's own, not the importer's: the importer
  # exists only to give pnpm a workspace member to resolve, and lives outside the
  # Profile trees because a `node_modules` inside one would change its digest.
  $profileDependencyRoot = Join-Path $RepoRoot "sandbox\agent_config\profiles\lite"
  foreach ($manifestName in @("package.json", "package-lock.json")) {
    $manifestSource = Join-Path $profileDependencyRoot $manifestName
    if (-not (Test-Path -LiteralPath $manifestSource -PathType Leaf)) {
      throw "Product Profile dependency manifest is missing: $manifestSource"
    }
    Copy-Item `
      -LiteralPath $manifestSource `
      -Destination (Join-Path $configDestination $manifestName) `
      -Force
  }

  $deploymentRoot = Join-Path (
    [System.IO.Path]::GetDirectoryName((Get-NormalizedManagedPath -Path $PayloadRoot))
  ) (".config-deploy-" + [System.Guid]::NewGuid().ToString("N"))
  $destinationModules = Join-Path $configDestination "node_modules"
  $stageKey = ""
  $restored = $false
  if ($StageCacheRoot) {
    try {
      $stageKey = Get-ConfigSourceStageKey -RepoRoot $RepoRoot -PnpmVersion $pnpmVersion
      # The verdict is the last thing the function returns; anything a copy tool
      # wrote to the pipeline before it must not turn a "no" into a truthy array.
      $restored = [bool](@(
          Restore-ConfigSourceSnapshot `
            -CacheRoot $StageCacheRoot `
            -Key $stageKey `
            -DestinationModules $destinationModules
        ) | Select-Object -Last 1)
    } catch {
      # Reuse is an optimisation; failing to decide it must not fail the build.
      Write-Host "note: config-source snapshot skipped: $($_.Exception.Message)" -ForegroundColor Yellow
      $stageKey = ""
    }
  }
  try {
    if (-not $restored) {
      # A fresh build host may have the workspace lock without the corresponding
      # tarballs in pnpm's content-addressed store. Fetch exactly this dedicated
      # importer's locked production closure first; deployment remains offline so
      # it cannot resolve or substitute anything not already pinned by the lock.
      # `pnpm fetch` only reads the lockfile into the store, and pnpm 10 rejects
      # `--frozen-lockfile` for this command.
      $fetchArguments = @(
        "--filter", ("./" + (Get-ConfigDependencyImporterRelativePath)),
        "fetch",
        "--prod",
        "--ignore-scripts"
      )
      $deployArguments = @(
        "--filter", ("./" + (Get-ConfigDependencyImporterRelativePath)),
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--strict-peer-dependencies",
        "--config.node-linker=hoisted",
        "--config.package-import-method=copy",
        "--config.inject-workspace-packages=true",
        "deploy",
        "--prod",
        $deploymentRoot
      )
      Push-Location $RepoRoot
      try {
        Invoke-NativeTimedStep -Label "config source pnpm fetch" -Action {
          & $PnpmExecutable @fetchArguments
          if ($LASTEXITCODE -ne 0) {
            throw "dedicated config importer fetch failed (exit $LASTEXITCODE)"
          }
        }
        Invoke-NativeTimedStep -Label "config source pnpm deploy" -Action {
          & $PnpmExecutable @deployArguments
          if ($LASTEXITCODE -ne 0) {
            throw "dedicated config importer deployment failed (exit $LASTEXITCODE)"
          }
        }
      } finally {
        Pop-Location
      }

      $deploymentModules = Join-Path $deploymentRoot "node_modules"
      # Copy-PhysicalConfigDependencyTree times its own copy and equality-check
      # steps separately; wrapping the whole call here as well would double-count
      # the equality pass against the stage total.
      Copy-PhysicalConfigDependencyTree `
        -SourceModules $deploymentModules `
        -DestinationModules $destinationModules
    }
    # No -AuthoritativeModules: the copy above has just compared these exact two
    # trees byte for byte and nothing has touched either since, so repeating the
    # comparison here only paid for a second read of every file. A restored
    # snapshot has no deploy tree to compare with; its check is the inventory.
    Invoke-NativeTimedStep -Label "config source dependency audit" -Action {
      Assert-PhysicalConfigDependencies `
        -ConfigRoot $configDestination `
        -DirectPackageName "@opencode-ai/plugin" `
        -DirectPackageVersion $pluginVersion
    }

    # A tree staged without opencode-scheduler fails nowhere here and then
    # fails at runtime as a startup that silently reaches the npm registry.
    $stagedScheduler = Get-ConfigPackagePath `
      -NodeModules $destinationModules `
      -PackageName "opencode-scheduler"
    $stagedSchedulerManifest = Join-Path $stagedScheduler "package.json"
    if (-not (Test-Path -LiteralPath $stagedSchedulerManifest -PathType Leaf)) {
      throw "staged config dependency tree does not contain opencode-scheduler"
    }
    $stagedSchedulerPackage = Get-Content `
      -LiteralPath $stagedSchedulerManifest -Raw | ConvertFrom-Json
    if ([string]$stagedSchedulerPackage.version -cne $schedulerVersion) {
      throw (
        "staged opencode-scheduler is " +
        "$($stagedSchedulerPackage.version), expected $schedulerVersion"
      )
    }
    if ($stageKey -and -not $restored) {
      # Only a tree that has passed every check above is worth restoring.
      Invoke-NativeTimedStep -Label "config source snapshot publish" -Action {
        Publish-ConfigSourceSnapshot `
          -CacheRoot $StageCacheRoot `
          -Key $stageKey `
          -StagedModules $destinationModules
      }
    }
  } finally {
    if (Test-Path -LiteralPath $deploymentRoot) {
      Remove-Item -LiteralPath $deploymentRoot -Recurse -Force
    }
  }
  Stage-OpencodePluginCacheEntry `
    -PayloadRoot $PayloadRoot `
    -SchedulerVersion $schedulerVersion
  Write-Host "ok: deterministic config dependencies staged in $configDestination"
}
