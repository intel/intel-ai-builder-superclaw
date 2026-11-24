#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$SourceDir,
    [string]$VcVars64,
    [string]$OneApiSetvars,
    [string]$OneApiRoot,
    [string]$DnnlDir,
    [string]$DirectStorageDir,
    [string]$StageDir,
    [ValidateRange(1, 64)]
    [int]$BuildJobs = 2,
    [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$vswhereVersion = '3.1.7'
$oneDnnVersion = '3.13.4'
$oneApiDefaultRootPath = 'C:\Program Files (x86)\Intel\oneAPI'
$oneApiDownloadUrl = 'https://www.intel.com/content/www/us/en/developer/tools/oneapi/oneapi-toolkit-download.html?packages=dl-essentials&dl-essentials-os=windows&dl-win=offline'

function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExecutablePath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $ExecutablePath @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    $output = @($output | ForEach-Object { $_.ToString() })
    return [pscustomobject]@{
        Output = $output
        ExitCode = $exitCode
    }
}

function Get-LlamaServerBuildInfo {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BundlePath
    )

    $executablePath = Join-Path $BundlePath 'llama-server.exe'
    if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
        return [pscustomobject]@{
            ExitCode = $null
            BuildNumber = $null
            BuildCommit = $null
            VersionText = "llama-server.exe was not found: $executablePath"
        }
    }

    $previousPath = $env:Path
    try {
        $env:Path = "$BundlePath;$env:SystemRoot\System32"
        $versionResult = Invoke-NativeCapture -ExecutablePath $executablePath -Arguments @('--version')
    } finally {
        $env:Path = $previousPath
    }

    $versionText = $versionResult.Output -join "`n"
    $versionMatch = [regex]::Match($versionText, '\bbuild\s+(\d+),\s*commit\s+([^\s,)]+)')
    $reportedBuildNumber = $null
    $reportedBuildCommit = $null
    if ($versionMatch.Success) {
        $reportedBuildNumber = $versionMatch.Groups[1].Value
        $reportedBuildCommit = $versionMatch.Groups[2].Value
    }

    return [pscustomobject]@{
        ExitCode = $versionResult.ExitCode
        BuildNumber = $reportedBuildNumber
        BuildCommit = $reportedBuildCommit
        VersionText = $versionText
    }
}

function Test-PathAtOrBelow {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$ParentPath
    )

    $normalizedPath = [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
    $normalizedParentPath = [System.IO.Path]::GetFullPath($ParentPath).TrimEnd([char[]]@('\', '/'))
    $parentPrefix = $normalizedParentPath + [System.IO.Path]::DirectorySeparatorChar
    return (
        [string]::Equals($normalizedPath, $normalizedParentPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $normalizedPath.StartsWith($parentPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    )
}

function Write-PreflightBanner {
    Write-Host ''
    Write-Host '======================================================================' -ForegroundColor Cyan
    Write-Host '  LLAMA.CPP WINDOWS SYCL BUILD - PRE-FLIGHT CHECKS' -ForegroundColor Cyan
    Write-Host '  Checking Visual Studio, oneAPI, CMake, Ninja, curl, and oneDNN' -ForegroundColor Cyan
    Write-Host '======================================================================' -ForegroundColor Cyan
    Write-Host ''
    [System.Console]::Out.Flush()
}

function Write-PreflightStatus {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    Write-Host $Message -ForegroundColor DarkCyan
    [System.Console]::Out.Flush()
}

function Update-ProcessPath {
    $pathEntries = @(
        $env:Path
        [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
        [System.Environment]::GetEnvironmentVariable('Path', 'User')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $env:Path = $pathEntries -join [System.IO.Path]::PathSeparator
}

function Add-DirectoryToProcessPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory
    )

    $normalizedDirectory = [System.IO.Path]::GetFullPath($Directory).TrimEnd([char[]]@('\', '/'))
    foreach ($pathEntry in ($env:Path -split [regex]::Escape([string][System.IO.Path]::PathSeparator))) {
        if (
            -not [string]::IsNullOrWhiteSpace($pathEntry) -and
            [string]::Equals(
                $pathEntry.TrimEnd([char[]]@('\', '/')),
                $normalizedDirectory,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        ) {
            return
        }
    }

    $env:Path = "$Directory$([System.IO.Path]::PathSeparator)$env:Path"
}

function Find-ExecutablePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $command = Get-Command -Name "$Name.exe" -CommandType Application -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    return $null
}

function Resolve-ExecutablePathFromUserInput {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    $expandedPath = [System.Environment]::ExpandEnvironmentVariables($Path.Trim().Trim([char]34))
    if (Test-Path -LiteralPath $expandedPath -PathType Leaf) {
        $resolvedPath = (Resolve-Path -LiteralPath $expandedPath).Path
        if ([string]::Equals(
            [System.IO.Path]::GetFileName($resolvedPath),
            "$Name.exe",
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            return $resolvedPath
        }
        return $null
    }

    if (Test-Path -LiteralPath $expandedPath -PathType Container) {
        foreach ($relativePath in @("$Name.exe", "bin\$Name.exe", "cmd\$Name.exe")) {
            $candidatePath = Join-Path $expandedPath $relativePath
            if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
                return (Resolve-Path -LiteralPath $candidatePath).Path
            }
        }
    }

    return $null
}

function Invoke-WingetInstall {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageId,
        [switch]$VisualStudio
    )

    $wingetCommand = Get-Command -Name 'winget.exe' -CommandType Application -ErrorAction SilentlyContinue
    if (-not $wingetCommand) {
        Write-Host 'winget is not available in this PowerShell session.' -ForegroundColor Yellow
        return $false
    }

    Write-Host "Starting winget install for $PackageId..." -ForegroundColor Yellow
    [System.Console]::Out.Flush()
    if ($VisualStudio) {
        $override = '--wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
        & $wingetCommand.Source install --id $PackageId --exact --source winget --override $override 2>&1 | Out-Host
    } else {
        & $wingetCommand.Source install --id $PackageId --exact --source winget 2>&1 | Out-Host
    }
    $installExitCode = $LASTEXITCODE
    if ($installExitCode -ne 0) {
        Write-Host "winget install failed with exit code $installExitCode." -ForegroundColor Yellow
        return $false
    }

    Update-ProcessPath
    return $true
}

function Resolve-RequiredExecutable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Description,
        [string]$WingetId,
        [string]$ManualUrl
    )

    $executablePath = Find-ExecutablePath -Name $Name
    if ($executablePath) {
        return $executablePath
    }

    $wingetAvailable = $null -ne (Get-Command -Name 'winget.exe' -CommandType Application -ErrorAction SilentlyContinue)
    while ($true) {
        $choices = @()
        if ($WingetId -and $wingetAvailable) {
            $choices += "[I] install with winget ($WingetId)"
        }
        $choices += '[P] provide an executable path or containing directory'
        if ($ManualUrl) {
            $choices += '[M] open manual installation instructions'
        }
        $choices += '[C] cancel'

        Write-Host "$Description was not found." -ForegroundColor Yellow
        $choice = (Read-Host ($choices -join '; ')).Trim().ToUpperInvariant()
        switch ($choice) {
            'I' {
                if (-not $WingetId -or -not $wingetAvailable) {
                    Write-Host 'winget installation is not available for this dependency.' -ForegroundColor Yellow
                    continue
                }
                [void](Invoke-WingetInstall -PackageId $WingetId)
                $executablePath = Find-ExecutablePath -Name $Name
                if ($executablePath) {
                    return $executablePath
                }
                Write-Host "The installation completed, but $Name.exe is not on PATH. Provide its location or retry." -ForegroundColor Yellow
            }
            'P' {
                $providedPath = Read-Host "Path to $Name.exe or its containing directory"
                $executablePath = Resolve-ExecutablePathFromUserInput -Name $Name -Path $providedPath
                if ($executablePath) {
                    Add-DirectoryToProcessPath -Directory (Split-Path -Parent $executablePath)
                    return $executablePath
                }
                Write-Host "Could not find $Name.exe at that path." -ForegroundColor Yellow
            }
            'M' {
                if (-not $ManualUrl) {
                    Write-Host 'Manual installation instructions are not available for this dependency.' -ForegroundColor Yellow
                    continue
                }
                Start-Process -FilePath $ManualUrl
                [void](Read-Host "After installing $Description, press Enter to check again")
                Update-ProcessPath
                $executablePath = Find-ExecutablePath -Name $Name
                if ($executablePath) {
                    return $executablePath
                }
            }
            'C' {
                throw "Required dependency '$Description' was not supplied."
            }
            default {
                Write-Host 'Choose one of the listed options.' -ForegroundColor Yellow
            }
        }
    }
}

function Test-MicrosoftSignedFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    return (
        $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid -and
        $null -ne $signature.SignerCertificate -and
        $signature.SignerCertificate.Subject -like '*CN=Microsoft Corporation*'
    )
}

function Get-VsWherePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot
    )

    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        $installedVsWherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
        if (Test-Path -LiteralPath $installedVsWherePath -PathType Leaf) {
            return (Resolve-Path -LiteralPath $installedVsWherePath).Path
        }
    }

    $cacheDirectory = Join-Path $RepositoryRoot "build\cache\vswhere\$vswhereVersion"
    $cachedVsWherePath = Join-Path $cacheDirectory 'vswhere.exe'
    if (Test-Path -LiteralPath $cachedVsWherePath -PathType Leaf) {
        if (Test-MicrosoftSignedFile -Path $cachedVsWherePath) {
            return (Resolve-Path -LiteralPath $cachedVsWherePath).Path
        }
        Write-Host "Cached vswhere.exe is not signed by Microsoft; refusing to run it: $cachedVsWherePath" -ForegroundColor Yellow
        return $null
    }

    $downloadUrl = "https://github.com/microsoft/vswhere/releases/download/$vswhereVersion/vswhere.exe"
    $temporaryPath = Join-Path $cacheDirectory 'vswhere.exe.download'
    try {
        New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
        Write-PreflightStatus "Downloading vswhere $vswhereVersion from GitHub..."
        Invoke-WebRequest -Uri $downloadUrl -OutFile $temporaryPath -UseBasicParsing -TimeoutSec 60
        if (
            -not (Test-Path -LiteralPath $temporaryPath -PathType Leaf) -or
            (Get-Item -LiteralPath $temporaryPath).Length -le 0
        ) {
            throw 'The downloaded file is missing or empty.'
        }
        if (-not (Test-MicrosoftSignedFile -Path $temporaryPath)) {
            throw 'The downloaded binary does not have a valid Microsoft Authenticode signature.'
        }
        Move-Item -LiteralPath $temporaryPath -Destination $cachedVsWherePath
        return (Resolve-Path -LiteralPath $cachedVsWherePath).Path
    } catch {
        Write-Host "Could not download or verify vswhere from $downloadUrl : $($_.Exception.Message)" -ForegroundColor Yellow
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
        return $null
    }
}

function Find-VisualStudioVcVars64 {
    param(
        [string]$VsWherePath
    )

    if ([string]::IsNullOrWhiteSpace($VsWherePath)) {
        return $null
    }

    $result = Invoke-NativeCapture -ExecutablePath $VsWherePath -Arguments @(
        '-latest',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath'
    )
    if ($result.ExitCode -ne 0) {
        Write-Host "vswhere failed with exit code $($result.ExitCode): $($result.Output -join ' ')" -ForegroundColor Yellow
        return $null
    }

    $installationPath = @(
        $result.Output |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Select-Object -First 1
    )
    if ($installationPath.Count -eq 0) {
        return $null
    }

    $vcVarsCandidate = Join-Path $installationPath[0].Trim() 'VC\Auxiliary\Build\vcvars64.bat'
    if (Test-Path -LiteralPath $vcVarsCandidate -PathType Leaf) {
        return (Resolve-Path -LiteralPath $vcVarsCandidate).Path
    }
    return $null
}

function Resolve-VcVars64Path {
    param(
        [string]$ProvidedPath,
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot
    )

    if (-not [string]::IsNullOrWhiteSpace($ProvidedPath)) {
        if (-not (Test-Path -LiteralPath $ProvidedPath -PathType Leaf)) {
            throw "vcvars64.bat not found: $ProvidedPath"
        }
        return (Resolve-Path -LiteralPath $ProvidedPath).Path
    }

    $vsWherePath = Get-VsWherePath -RepositoryRoot $RepositoryRoot
    $vcVarsPath = Find-VisualStudioVcVars64 -VsWherePath $vsWherePath
    if ($vcVarsPath) {
        return $vcVarsPath
    }

    $wingetAvailable = $null -ne (Get-Command -Name 'winget.exe' -CommandType Application -ErrorAction SilentlyContinue)
    while ($true) {
        $choices = @()
        if ($wingetAvailable) {
            $choices += '[I] install Visual Studio 2022 Build Tools with the C++ workload via winget'
        }
        $choices += '[P] provide a path to vcvars64.bat'
        $choices += '[M] open Visual Studio download instructions'
        $choices += '[C] cancel'
        Write-Host 'Visual Studio C++ Build Tools were not detected.' -ForegroundColor Yellow
        $choice = (Read-Host ($choices -join '; ')).Trim().ToUpperInvariant()
        switch ($choice) {
            'I' {
                if (-not $wingetAvailable) {
                    Write-Host 'winget is not available in this PowerShell session.' -ForegroundColor Yellow
                    continue
                }
                [void](Invoke-WingetInstall -PackageId 'Microsoft.VisualStudio.2022.BuildTools' -VisualStudio)
                $vsWherePath = Get-VsWherePath -RepositoryRoot $RepositoryRoot
                $vcVarsPath = Find-VisualStudioVcVars64 -VsWherePath $vsWherePath
                if ($vcVarsPath) {
                    return $vcVarsPath
                }
                Write-Host 'The C++ toolchain was not detected after installation; enter its path or retry.' -ForegroundColor Yellow
            }
            'P' {
                $providedPath = [System.Environment]::ExpandEnvironmentVariables(
                    (Read-Host 'Path to vcvars64.bat').Trim().Trim([char]34)
                )
                if (Test-Path -LiteralPath $providedPath -PathType Leaf) {
                    return (Resolve-Path -LiteralPath $providedPath).Path
                }
                Write-Host "vcvars64.bat was not found: $providedPath" -ForegroundColor Yellow
            }
            'M' {
                Start-Process -FilePath 'https://visualstudio.microsoft.com/downloads/'
                [void](Read-Host 'After installing the Visual Studio C++ workload, press Enter to check again')
                $vsWherePath = Get-VsWherePath -RepositoryRoot $RepositoryRoot
                $vcVarsPath = Find-VisualStudioVcVars64 -VsWherePath $vsWherePath
                if ($vcVarsPath) {
                    return $vcVarsPath
                }
            }
            'C' {
                throw 'Visual Studio C++ Build Tools are required to build llama.cpp.'
            }
            default {
                Write-Host 'Choose one of the listed options.' -ForegroundColor Yellow
            }
        }
    }
}

function Resolve-OneApiPaths {
    param(
        [string]$ProvidedRoot,
        [string]$ProvidedSetvars
    )

    $rootCandidate = $ProvidedRoot
    if ([string]::IsNullOrWhiteSpace($rootCandidate) -and -not [string]::IsNullOrWhiteSpace($ProvidedSetvars)) {
        $rootCandidate = Split-Path -Parent $ProvidedSetvars
    }
    if ([string]::IsNullOrWhiteSpace($rootCandidate)) {
        $rootCandidate = $oneApiDefaultRootPath
    }
    $setvarsCandidate = $ProvidedSetvars

    while ($true) {
        $resolvedRoot = $null
        if (Test-Path -LiteralPath $rootCandidate -PathType Container) {
            $resolvedRoot = (Resolve-Path -LiteralPath $rootCandidate).Path
        }
        if ([string]::IsNullOrWhiteSpace($setvarsCandidate) -and $resolvedRoot) {
            $setvarsCandidate = Join-Path $resolvedRoot 'setvars.bat'
        }

        $compilerPath = if ($resolvedRoot) {
            Join-Path $resolvedRoot 'compiler\latest\bin\icx.exe'
        } else {
            $null
        }
        if (
            $resolvedRoot -and
            (Test-Path -LiteralPath $setvarsCandidate -PathType Leaf) -and
            (Test-Path -LiteralPath $compilerPath -PathType Leaf)
        ) {
            return [pscustomobject]@{
                RootPath = $resolvedRoot
                SetvarsPath = (Resolve-Path -LiteralPath $setvarsCandidate).Path
            }
        }

        Write-Host "oneAPI DPC++ was not found at '$rootCandidate'." -ForegroundColor Yellow
        $choice = (Read-Host '[I] open Intel oneAPI Deep Learning Essentials instructions; [P] provide the installed oneAPI root; [C] cancel').Trim().ToUpperInvariant()
        switch ($choice) {
            'I' {
                Write-Host "Install Intel oneAPI Deep Learning Essentials v2026.1.4: $oneApiDownloadUrl" -ForegroundColor DarkCyan
                Start-Process -FilePath $oneApiDownloadUrl
                [void](Read-Host 'After installation, press Enter to check the default oneAPI location again')
                $rootCandidate = $oneApiDefaultRootPath
                $setvarsCandidate = $null
            }
            'P' {
                $rootCandidate = Read-Host 'Path to the oneAPI root containing setvars.bat'
                $rootCandidate = [System.Environment]::ExpandEnvironmentVariables($rootCandidate.Trim().Trim([char]34))
                $setvarsCandidate = $null
            }
            'C' {
                throw 'Intel oneAPI DPC++ 2026.1.x is required to build llama.cpp with SYCL.'
            }
            default {
                Write-Host 'Choose one of the listed options.' -ForegroundColor Yellow
            }
        }
    }
}

function Get-OneDnnPackageVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackagePath
    )

    $versionFile = Join-Path $PackagePath 'dnnl-config-version.cmake'
    if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) {
        throw "oneDNN package version file not found: $versionFile"
    }
    $versionText = Get-Content -LiteralPath $versionFile -Raw
    $versionMatch = [regex]::Match($versionText, 'set\(PACKAGE_VERSION\s+"([^"]+)"\)')
    if (-not $versionMatch.Success) {
        throw "Could not read the oneDNN package version from $versionFile"
    }
    return $versionMatch.Groups[1].Value
}

function Get-OneDnnPackageMetadata {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackagePath,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedVersion
    )

    $resolvedPackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
    $version = Get-OneDnnPackageVersion -PackagePath $resolvedPackagePath
    if ($version -ne $ExpectedVersion) {
        throw "Expected oneDNN $ExpectedVersion, found $version"
    }

    $installRoot = (Resolve-Path -LiteralPath (Join-Path $resolvedPackagePath '..\..\..')).Path
    $runtimePath = Join-Path $installRoot 'bin\dnnl.dll'
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf) -or (Get-Item -LiteralPath $runtimePath).Length -le 0) {
        throw "Required oneDNN runtime is missing or empty: $runtimePath"
    }

    return [pscustomobject]@{
        PackagePath = $resolvedPackagePath
        InstallRoot = $installRoot
        Version = $version
        RuntimePath = $runtimePath
    }
}

function Resolve-OneDnnPackage {
    param(
        [string]$ProvidedPath,
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedVersion
    )

    if (-not [string]::IsNullOrWhiteSpace($ProvidedPath)) {
        return [pscustomobject]@{
            Metadata = Get-OneDnnPackageMetadata -PackagePath $ProvidedPath -ExpectedVersion $ExpectedVersion
            BuildFromSource = $false
            CacheRoot = $null
        }
    }

    $cacheRoot = Join-Path $RepositoryRoot "build\cache\onednn\$ExpectedVersion"
    $installRoot = Join-Path $cacheRoot 'install'
    $defaultPackagePath = Join-Path $installRoot 'lib\cmake\dnnl'
    $versionFile = Join-Path $defaultPackagePath 'dnnl-config-version.cmake'
    if (Test-Path -LiteralPath $versionFile -PathType Leaf) {
        $cachedVersion = Get-OneDnnPackageVersion -PackagePath $defaultPackagePath
        $cachedRuntime = Join-Path $installRoot 'bin\dnnl.dll'
        if ($cachedVersion -eq $ExpectedVersion -and (Test-Path -LiteralPath $cachedRuntime -PathType Leaf)) {
            return [pscustomobject]@{
                Metadata = Get-OneDnnPackageMetadata -PackagePath $defaultPackagePath -ExpectedVersion $ExpectedVersion
                BuildFromSource = $false
                CacheRoot = $cacheRoot
            }
        }
        Write-Host "The cached oneDNN package is incomplete or has version $cachedVersion; the pinned source build can regenerate it." -ForegroundColor Yellow
    }

    while ($true) {
        Write-Host "oneDNN $ExpectedVersion was not found." -ForegroundColor Yellow
        $choice = (Read-Host '[B] build the pinned oneDNN source; [P] provide an installed package path; [C] cancel').Trim().ToUpperInvariant()
        switch ($choice) {
            'B' {
                return [pscustomobject]@{
                    Metadata = [pscustomobject]@{
                        PackagePath = $defaultPackagePath
                        InstallRoot = $installRoot
                        Version = $ExpectedVersion
                        RuntimePath = Join-Path $installRoot 'bin\dnnl.dll'
                    }
                    BuildFromSource = $true
                    CacheRoot = $cacheRoot
                }
            }
            'P' {
                $providedPackagePath = [System.Environment]::ExpandEnvironmentVariables(
                    (Read-Host 'Path to oneDNN lib\cmake\dnnl').Trim().Trim([char]34)
                )
                if ([string]::IsNullOrWhiteSpace($providedPackagePath)) {
                    Write-Host 'A oneDNN package path is required.' -ForegroundColor Yellow
                    continue
                }
                $providedVersionFile = Join-Path $providedPackagePath 'dnnl-config-version.cmake'
                if (-not (Test-Path -LiteralPath $providedVersionFile -PathType Leaf)) {
                    Write-Host "oneDNN package version file not found: $providedVersionFile" -ForegroundColor Yellow
                    continue
                }
                $providedVersion = Get-OneDnnPackageVersion -PackagePath $providedPackagePath
                if ($providedVersion -ne $ExpectedVersion) {
                    Write-Host "Expected oneDNN $ExpectedVersion, found $providedVersion." -ForegroundColor Yellow
                    continue
                }
                $providedInstallRoot = (Resolve-Path -LiteralPath (Join-Path $providedPackagePath '..\..\..')).Path
                $providedRuntime = Join-Path $providedInstallRoot 'bin\dnnl.dll'
                if (-not (Test-Path -LiteralPath $providedRuntime -PathType Leaf)) {
                    Write-Host "Required oneDNN runtime was not found: $providedRuntime" -ForegroundColor Yellow
                    continue
                }
                return [pscustomobject]@{
                    Metadata = Get-OneDnnPackageMetadata -PackagePath $providedPackagePath -ExpectedVersion $ExpectedVersion
                    BuildFromSource = $false
                    CacheRoot = $null
                }
            }
            'C' {
                throw "oneDNN $ExpectedVersion is required to build llama.cpp."
            }
            default {
                Write-Host 'Choose one of the listed options.' -ForegroundColor Yellow
            }
        }
    }
}

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$gitPath = Resolve-RequiredExecutable `
    -Name 'git' `
    -Description 'Git' `
    -WingetId 'Git.Git' `
    -ManualUrl 'https://git-scm.com/download/win'
Add-DirectoryToProcessPath -Directory (Split-Path -Parent $gitPath)

. (Join-Path $PSScriptRoot 'patch-set.ps1')
. (Join-Path $PSScriptRoot 'ui-assets.ps1')

$lockState = & (Join-Path $PSScriptRoot 'verify-lock.ps1') `
    -RepositoryRoot $repositoryRoot `
    -PassThru
$manifest = $lockState.Manifest
$baseCommit = $manifest.Sha
$expectedTree = $manifest.PatchedTree
$buildNumber = $manifest.UpstreamBuildNumber
$uiVersion = "b$buildNumber"
$patchSet = $lockState.PatchSet
$patchSetSha256 = $patchSet.Sha256
$buildCommit = "fork-$($patchSetSha256.Substring(0, 8))"
$inferenceBundlePath = Join-Path $repositoryRoot 'host\llmrouter_manager\inference\llama-win-sycl'
$bundleNeedsOverwrite = $false
$existingBundleVersion = $null
$existingBundleStatus = $null

if (Test-Path -LiteralPath $inferenceBundlePath -PathType Leaf) {
    throw "Inference bundle path exists but is not a directory: $inferenceBundlePath"
}
if (Test-Path -LiteralPath $inferenceBundlePath -PathType Container) {
    $existingBundleVersion = Get-LlamaServerBuildInfo -BundlePath $inferenceBundlePath
    if (
        $existingBundleVersion.ExitCode -eq 0 -and
        $existingBundleVersion.BuildNumber -eq "$buildNumber" -and
        $existingBundleVersion.BuildCommit -eq $buildCommit
    ) {
        Write-Host "llama.cpp bundle already matches build $buildNumber, commit $buildCommit at $inferenceBundlePath. Skipping build." -ForegroundColor Green
        return
    }

    $bundleNeedsOverwrite = $true
    if ($null -eq $existingBundleVersion.ExitCode) {
        $existingBundleStatus = $existingBundleVersion.VersionText
    } elseif ($existingBundleVersion.ExitCode -ne 0) {
        $existingBundleStatus = "llama-server.exe --version failed with exit code $($existingBundleVersion.ExitCode)"
    } elseif ($null -eq $existingBundleVersion.BuildNumber -or $null -eq $existingBundleVersion.BuildCommit) {
        $existingBundleStatus = 'llama-server.exe --version output could not be parsed'
    } else {
        $existingBundleStatus = "reports build $($existingBundleVersion.BuildNumber), commit $($existingBundleVersion.BuildCommit)"
    }
}

Write-PreflightBanner
Write-Host "  Git: $gitPath (source lock verified)" -ForegroundColor Green

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    $SourceDir = Join-Path $repositoryRoot 'build\llama.cpp-src-patched'
}
if (-not [System.IO.Path]::IsPathRooted($SourceDir)) {
    $SourceDir = Join-Path $repositoryRoot $SourceDir
}
$sourcePath = (Resolve-Path -LiteralPath $SourceDir).Path

if ([string]::IsNullOrWhiteSpace($StageDir)) {
    $StageDir = Join-Path $repositoryRoot 'build\stage\llama-win-sycl'
}
if (-not [System.IO.Path]::IsPathRooted($StageDir)) {
    $StageDir = Join-Path $repositoryRoot $StageDir
}
$stagePath = [System.IO.Path]::GetFullPath($StageDir)
if ([string]::Equals($stagePath, $inferenceBundlePath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "StageDir must be different from the inference bundle destination: $inferenceBundlePath"
}
$normalizedStagePath = $stagePath.TrimEnd([char[]]@('\', '/'))
$stageVolumeRoot = [System.IO.Path]::GetPathRoot($stagePath).TrimEnd([char[]]@('\', '/'))
$repositoryStageRoot = Join-Path $repositoryRoot 'build\stage'
if ([string]::Equals($normalizedStagePath, $stageVolumeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "StageDir must not be a volume root: $stagePath"
}
if (
    (Test-PathAtOrBelow -Path $repositoryRoot -ParentPath $stagePath) -or
    (
        (Test-PathAtOrBelow -Path $stagePath -ParentPath $repositoryRoot) -and
        (
            -not (Test-PathAtOrBelow -Path $stagePath -ParentPath $repositoryStageRoot) -or
            [string]::Equals($normalizedStagePath, $repositoryStageRoot, [System.StringComparison]::OrdinalIgnoreCase)
        )
    ) -or
    (Test-PathAtOrBelow -Path $stagePath -ParentPath $sourcePath) -or
    (Test-PathAtOrBelow -Path $sourcePath -ParentPath $stagePath)
) {
    throw "StageDir must be outside the repository or a child of '$repositoryStageRoot'; it must not overlap the source tree or contain the repository root: $stagePath"
}
$buildPath = Join-Path $sourcePath 'build-x64-windows-sycl-release'
$buildBin = Join-Path $buildPath 'bin'

Write-PreflightStatus '[1/5] Detecting Visual Studio C++ tools...'
$vcVarsPath = Resolve-VcVars64Path -ProvidedPath $VcVars64 -RepositoryRoot $repositoryRoot
Write-Host "  Visual Studio: $vcVarsPath" -ForegroundColor Green

Write-PreflightStatus '[2/5] Detecting Intel oneAPI...'
$oneApiPaths = Resolve-OneApiPaths -ProvidedRoot $OneApiRoot -ProvidedSetvars $OneApiSetvars
$oneApiSetvarsPath = $oneApiPaths.SetvarsPath
$oneApiRootPath = $oneApiPaths.RootPath
Write-Host "  oneAPI root: $oneApiRootPath" -ForegroundColor Green

Write-PreflightStatus '[3/5] Checking command-line build tools...'
foreach ($toolName in @('cmake', 'ninja')) {
    $probeCommand = 'call "{0}" && set "NoDefaultCurrentDirectoryInExePath=" && call "{1}" intel64 --force && where.exe {2}' -f $vcVarsPath, $oneApiSetvarsPath, $toolName
    $probeResult = Invoke-NativeCapture -ExecutablePath $env:ComSpec -Arguments @('/d', '/s', '/c', $probeCommand)
    if ($probeResult.ExitCode -eq 0) {
        $toolPath = @(
            $probeResult.Output |
                Where-Object {
                    $candidatePath = $_.Trim()
                    Test-Path -LiteralPath $candidatePath -PathType Leaf
                } |
                Select-Object -First 1
        )
        if ($toolPath.Count -gt 0) {
            Add-DirectoryToProcessPath -Directory (Split-Path -Parent $toolPath[0].Trim())
        }
    }
}
$cmakePath = Resolve-RequiredExecutable -Name 'cmake' -Description 'CMake' -WingetId 'Kitware.CMake' -ManualUrl 'https://cmake.org/download/'
$ninjaPath = Resolve-RequiredExecutable -Name 'ninja' -Description 'Ninja' -WingetId 'Ninja-build.Ninja' -ManualUrl 'https://github.com/ninja-build/ninja/releases'
$curlPath = Resolve-RequiredExecutable -Name 'curl' -Description 'curl' -WingetId 'cURL.cURL' -ManualUrl 'https://curl.se/windows/'
foreach ($executablePath in @($cmakePath, $ninjaPath, $curlPath)) {
    Add-DirectoryToProcessPath -Directory (Split-Path -Parent $executablePath)
}
Write-Host "  CMake: $cmakePath" -ForegroundColor Green
Write-Host "  Ninja: $ninjaPath" -ForegroundColor Green
Write-Host "  curl:  $curlPath" -ForegroundColor Green

Write-PreflightStatus '[4/5] Resolving oneDNN...'
$oneDnnSelection = Resolve-OneDnnPackage `
    -ProvidedPath $DnnlDir `
    -RepositoryRoot $repositoryRoot `
    -ExpectedVersion $oneDnnVersion
$buildOneDnn = $oneDnnSelection.BuildFromSource
$oneDnnCacheRoot = $oneDnnSelection.CacheRoot
$dnnlPath = $oneDnnSelection.Metadata.PackagePath
$dnnlInstallRoot = $oneDnnSelection.Metadata.InstallRoot
$dnnlVersion = $oneDnnSelection.Metadata.Version
$dnnlRuntimePath = $oneDnnSelection.Metadata.RuntimePath
if ($buildOneDnn) {
    Write-Host "  oneDNN $dnnlVersion will be downloaded and built from source after build confirmation." -ForegroundColor Green
} else {
    Write-Host "  oneDNN ${dnnlVersion}: $dnnlPath" -ForegroundColor Green
}

$directStoragePath = $null
$directStorageArgument = ''
if (-not [string]::IsNullOrWhiteSpace($DirectStorageDir)) {
    $directStoragePath = (Resolve-Path -LiteralPath $DirectStorageDir).Path
    foreach ($requiredFile in @(
        'include\dstorage.h',
        'lib\x64\dstorage.lib',
        'bin\x64\dstorage.dll',
        'bin\x64\dstoragecore.dll'
    )) {
        $requiredPath = Join-Path $directStoragePath $requiredFile
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "DirectStorage SDK file not found: $requiredPath"
        }
    }
    $directStorageDllPath = Join-Path $directStoragePath 'bin\x64\dstorage.dll'
    $directStorageVersionInfo = (Get-Item -LiteralPath $directStorageDllPath).VersionInfo
    $directStorageVersionStrings = @(
        @(
            $directStorageVersionInfo.ProductVersion
            $directStorageVersionInfo.FileVersion
        ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    $unsupportedDirectStorageVersions = @(
        $directStorageVersionStrings | Where-Object { $_ -notmatch '(?<!\d)1\.3\.0(?:\.\d+)?(?!\d)' }
    )
    if ($directStorageVersionStrings.Count -eq 0 -or $unsupportedDirectStorageVersions.Count -gt 0) {
        throw "Expected DirectStorage SDK 1.3.0, found ProductVersion '$($directStorageVersionInfo.ProductVersion)' and FileVersion '$($directStorageVersionInfo.FileVersion)' in $directStorageDllPath"
    }
    $directStorageArgument = ' "-DLLAMA_DIRECTSTORAGE_DIR={0}"' -f $directStoragePath
}

$oneApiRuntimePaths = @{
    'libhwloc-15.dll' = 'tcm\1.5\bin\libhwloc-15.dll'
    'libiomp5md.dll' = 'compiler\latest\bin\libiomp5md.dll'
    'libmmd.dll' = 'compiler\latest\bin\libmmd.dll'
    'mkl_core.3.dll' = 'mkl\latest\bin\mkl_core.3.dll'
    'mkl_sycl_blas.6.dll' = 'mkl\latest\bin\mkl_sycl_blas.6.dll'
    'mkl_tbb_thread.3.dll' = 'mkl\latest\bin\mkl_tbb_thread.3.dll'
    'svml_dispmd.dll' = 'compiler\latest\bin\svml_dispmd.dll'
    'sycl9.dll' = 'compiler\latest\bin\sycl9.dll'
    'tbb12.dll' = 'tbb\latest\bin\tbb12.dll'
    'tcm.dll' = 'tcm\1.5\bin\tcm.dll'
    'umf.dll' = 'umf\latest\bin\umf.dll'
    'ur_adapter_level_zero_v2.dll' = 'compiler\latest\bin\ur_adapter_level_zero_v2.dll'
    'ur_adapter_level_zero.dll' = 'compiler\latest\bin\ur_adapter_level_zero.dll'
    'ur_adapter_opencl.dll' = 'compiler\latest\bin\ur_adapter_opencl.dll'
    'ur_loader.dll' = 'compiler\latest\bin\ur_loader.dll'
    'ur_win_proxy_loader.dll' = 'compiler\latest\bin\ur_win_proxy_loader.dll'
}
$runtimeFiles = @(
    'dnnl.dll',
    'ggml-base.dll',
    'ggml-cpu.dll',
    'ggml-sycl.dll',
    'ggml.dll',
    'libhwloc-15.dll',
    'libiomp5md.dll',
    'libmmd.dll',
    'llama-bench-impl.dll',
    'llama-bench.exe',
    'llama-common.dll',
    'llama-server-impl.dll',
    'llama-server.exe',
    'llama.dll',
    'mkl_core.3.dll',
    'mkl_sycl_blas.6.dll',
    'mkl_tbb_thread.3.dll',
    'mtmd.dll',
    'svml_dispmd.dll',
    'sycl9.dll',
    'tbb12.dll',
    'tcm.dll',
    'umf.dll',
    'ur_adapter_level_zero_v2.dll',
    'ur_adapter_level_zero.dll',
    'ur_adapter_opencl.dll',
    'ur_loader.dll',
    'ur_win_proxy_loader.dll',
    'dstorage.dll',
    'dstoragecore.dll'
)
if (
    -not $buildOneDnn -and
    (
        -not (Test-Path -LiteralPath $dnnlRuntimePath -PathType Leaf) -or
        (Get-Item -LiteralPath $dnnlRuntimePath).Length -le 0
    )
) {
    throw "Required oneDNN runtime is missing or empty: $dnnlRuntimePath"
}
foreach ($relativePath in $oneApiRuntimePaths.Values) {
    $runtimePath = Join-Path $oneApiRootPath $relativePath
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf) -or (Get-Item -LiteralPath $runtimePath).Length -le 0) {
        throw "Required oneAPI runtime is missing or empty: $runtimePath"
    }
}

$buildDirectoryExists = Test-Path -LiteralPath $buildPath
if ($buildDirectoryExists -and -not (Test-Path -LiteralPath $buildPath -PathType Container)) {
    throw "Build path exists but is not a directory: $buildPath"
}
if ($buildDirectoryExists) {
    $buildDirectoryItem = Get-Item -LiteralPath $buildPath
    if (($buildDirectoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Build directory is a reparse point; refusing to reuse it: $buildPath"
    }
}
$stageDirectoryExists = Test-Path -LiteralPath $stagePath
if ($stageDirectoryExists -and -not (Test-Path -LiteralPath $stagePath -PathType Container)) {
    throw "Stage path exists but is not a directory: $stagePath"
}
if ($stageDirectoryExists) {
    $stageDirectoryItem = Get-Item -LiteralPath $stagePath
    if (($stageDirectoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Stage directory is a reparse point; refusing to replace it: $stagePath"
    }
}

$cachePath = Join-Path $buildPath 'CMakeCache.txt'
$buildCachePathExists = Test-Path -LiteralPath $cachePath
$buildCacheExists = Test-Path -LiteralPath $cachePath -PathType Leaf
if ($buildCachePathExists -and -not $buildCacheExists) {
    throw "CMake cache path exists but is not a file: $cachePath"
}
if ($buildCacheExists) {
    $cachedSourceLine = @(
        Select-String -LiteralPath $cachePath -Pattern '^CMAKE_HOME_DIRECTORY:[^=]+=' |
            Select-Object -First 1
    )
    if ($cachedSourceLine.Count -eq 0) {
        throw "Existing CMake cache has no source directory; use a fresh source tree or remove the generated build directory: $buildPath"
    }

    $cachedSourcePath = $cachedSourceLine[0].Line -replace '^CMAKE_HOME_DIRECTORY:[^=]+=', ''
    if ([string]::IsNullOrWhiteSpace($cachedSourcePath)) {
        throw "Existing CMake cache has an empty source directory; use a fresh source tree or remove the generated build directory: $buildPath"
    }
    $normalizedCachedSourcePath = [System.IO.Path]::GetFullPath($cachedSourcePath).TrimEnd([char[]]@('\', '/'))
    $normalizedSourcePath = [System.IO.Path]::GetFullPath($sourcePath).TrimEnd([char[]]@('\', '/'))
    if (-not [string]::Equals($normalizedCachedSourcePath, $normalizedSourcePath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Existing CMake build directory belongs to another source tree: $cachedSourcePath. Use a fresh -SourceDir or remove only this generated build directory: $buildPath"
    }
    if (-not (Select-String -LiteralPath $cachePath -Pattern '^CMAKE_GENERATOR:[^=]+=Ninja$' -Quiet)) {
        throw "Existing CMake build directory does not use the Ninja generator; use a fresh -SourceDir or remove only this generated build directory: $buildPath"
    }
}
function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $result = Invoke-LlamaGit -WorkingDirectory $WorkingDirectory -Arguments $Arguments
    if ($result.ExitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed in '$WorkingDirectory':`n$($result.Output -join "`n")"
    }
    return $result.Output
}

function Assert-CMakeCacheValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CachePath,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedValue
    )

    $pattern = '^' + [regex]::Escape($Name) + ':[^=]+=' + [regex]::Escape($ExpectedValue) + '$'
    if (-not (Select-String -LiteralPath $CachePath -Pattern $pattern -Quiet)) {
        throw "CMake cache did not contain $Name=$ExpectedValue"
    }
}

function Invoke-Cmd {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandLine,
        [Parameter(Mandatory = $true)]
        [string]$LogPath,
        [Parameter(Mandatory = $true)]
        [string]$Description,
        [switch]$StreamOutput
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        if ($StreamOutput) {
            & $env:ComSpec /d /s /c $CommandLine 2>&1 | Tee-Object -FilePath $LogPath -ErrorAction Stop
        } else {
            & $env:ComSpec /d /s /c $CommandLine *> $LogPath
        }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($exitCode -ne 0) {
        if (-not $StreamOutput) {
            Get-Content -LiteralPath $LogPath -Tail 60 | Write-Output
        }
        throw "$Description failed with exit code $exitCode; see $LogPath"
    }
}

function Invoke-CmdCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandLine,
        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    $result = Invoke-NativeCapture -ExecutablePath $env:ComSpec -Arguments @(
        '/d',
        '/s',
        '/c',
        $CommandLine
    )
    if ($result.ExitCode -ne 0) {
        throw "$Description failed with exit code $($result.ExitCode):`n$($result.Output -join "`n")"
    }
    return $result.Output
}

function Build-OneDnnFromSource {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CacheRoot,
        [Parameter(Mandatory = $true)]
        [string]$Version,
        [Parameter(Mandatory = $true)]
        [string]$CurlPath,
        [Parameter(Mandatory = $true)]
        [string]$VcVarsPath,
        [Parameter(Mandatory = $true)]
        [string]$OneApiSetvarsPath,
        [ValidateRange(1, 64)]
        [int]$Jobs
    )

    $archivePath = Join-Path $CacheRoot "oneDNN-$Version.zip"
    $sourceDirectory = Join-Path $CacheRoot "oneDNN-$Version"
    $buildDirectory = Join-Path $CacheRoot 'build'
    $installDirectory = Join-Path $CacheRoot 'install'
    $sourceUrl = "https://github.com/uxlfoundation/oneDNN/archive/refs/tags/v$Version.zip"

    New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory 'CMakeLists.txt') -PathType Leaf)) {
        if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
            Write-Host "Downloading oneDNN $Version source from GitHub..." -ForegroundColor DarkCyan
            $downloadResult = Invoke-NativeCapture -ExecutablePath $CurlPath -Arguments @(
                '-fL',
                '--retry',
                '3',
                '--retry-delay',
                '2',
                '--output',
                $archivePath,
                $sourceUrl
            )
            if ($downloadResult.ExitCode -ne 0) {
                throw "Could not download oneDNN source from $sourceUrl :`n$($downloadResult.Output -join "`n")"
            }
        }
        if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf) -or (Get-Item -LiteralPath $archivePath).Length -le 0) {
            throw "oneDNN source archive is missing or empty: $archivePath"
        }
        Expand-Archive -LiteralPath $archivePath -DestinationPath $CacheRoot -Force
    }

    if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory 'CMakeLists.txt') -PathType Leaf)) {
        throw "oneDNN source CMakeLists.txt was not found under the expected directory: $sourceDirectory"
    }

    New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null
    $configureLog = Join-Path $buildDirectory 'configure.log'
    $configureCommand = 'call "{0}" && set "NoDefaultCurrentDirectoryInExePath=" && call "{1}" intel64 --force && set "CC=icx" && set "CXX=icx" && cd /d "{2}" && cmake -S . -B "{3}" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="{4}" -DONEDNN_CPU_RUNTIME=SYCL -DONEDNN_GPU_RUNTIME=SYCL -DONEDNN_BUILD_GRAPH=ON -DONEDNN_BUILD_TESTS=OFF -DONEDNN_BUILD_EXAMPLES=OFF -DONEDNN_LIBRARY_TYPE=SHARED' -f $VcVarsPath, $OneApiSetvarsPath, $sourceDirectory, $buildDirectory, $installDirectory
    Invoke-Cmd -CommandLine $configureCommand -LogPath $configureLog -Description 'oneDNN CMake configure'

    $oneDnnCachePath = Join-Path $buildDirectory 'CMakeCache.txt'
    foreach ($setting in @{
        'ONEDNN_CPU_RUNTIME' = 'SYCL'
        'ONEDNN_GPU_RUNTIME' = 'SYCL'
        'ONEDNN_BUILD_GRAPH' = 'ON'
        'ONEDNN_BUILD_TESTS' = 'OFF'
        'ONEDNN_BUILD_EXAMPLES' = 'OFF'
        'ONEDNN_LIBRARY_TYPE' = 'SHARED'
    }.GetEnumerator()) {
        Assert-CMakeCacheValue -CachePath $oneDnnCachePath -Name $setting.Key -ExpectedValue $setting.Value
    }

    $buildLog = Join-Path $buildDirectory 'build-install.log'
    $buildCommand = 'call "{0}" && set "NoDefaultCurrentDirectoryInExePath=" && call "{1}" intel64 --force && set "CC=icx" && set "CXX=icx" && cmake --build "{2}" --parallel {3} && cmake --install "{2}"' -f $VcVarsPath, $OneApiSetvarsPath, $buildDirectory, $Jobs
    Invoke-Cmd -CommandLine $buildCommand -LogPath $buildLog -Description 'oneDNN build and install' -StreamOutput
}

Write-PreflightStatus '[5/5] Verifying the patched source, toolchain versions, and absence of unverified source UI assets...'
$head = Assert-LlamaPatchSeriesCommitChain `
    -WorkingDirectory $sourcePath `
    -BaseCommit $baseCommit `
    -PatchCount $patchSet.Patches.Count
$tree = (Invoke-Git -WorkingDirectory $sourcePath -Arguments @('write-tree')).Trim()
if ($tree -ne $expectedTree) {
    throw "Source tree mismatch: expected $expectedTree, found $tree"
}
$sourceStatus = @(Invoke-Git -WorkingDirectory $sourcePath -Arguments @('status', '--porcelain', '--untracked-files=all'))
if ($sourceStatus.Count -gt 0) {
    throw "Source worktree is not clean; use a fresh applied source tree: $($sourceStatus -join "`n")"
}

$toolchainVersionLog = Join-Path $buildPath 'toolchain-versions.log'
$toolchainVersionCommand = 'call "{0}" && set "NoDefaultCurrentDirectoryInExePath=" && call "{1}" && cd /d "{2}" && where.exe cl && where.exe icx && where.exe link && where.exe rc && where.exe mt && where.exe cmake && where.exe ninja && cmake --version && ninja --version && icx --version' -f $vcVarsPath, $oneApiSetvarsPath, $sourcePath
$toolchainLines = @(Invoke-CmdCapture -CommandLine $toolchainVersionCommand -Description 'Toolchain prerequisite check')

$cmakeVersionLine = @($toolchainLines | Where-Object { $_ -match '^\s*cmake version ' } | Select-Object -First 1)
if ($cmakeVersionLine.Count -eq 0) {
    throw "Could not identify the CMake version during prerequisite checking:`n$($toolchainLines -join "`n")"
}
$cmakeVersion = $cmakeVersionLine[0] -replace '^\s*cmake version\s+', ''

$cmakeVersionLineIndex = [System.Array]::IndexOf($toolchainLines, $cmakeVersionLine[0])
$ninjaVersionLine = @($toolchainLines | Select-Object -Skip ($cmakeVersionLineIndex + 1) | Where-Object { $_ -match '^\d+(?:\.\d+){1,2}$' } | Select-Object -First 1)
if ($ninjaVersionLine.Count -eq 0) {
    throw "Could not identify the Ninja version during prerequisite checking:`n$($toolchainLines -join "`n")"
}
$ninjaVersion = $ninjaVersionLine[0].Trim()

$icxCommandPathLine = @($toolchainLines | Where-Object { $_ -match '(?i)\\icx\.(?:exe|bat|cmd)$' } | Select-Object -First 1)
if ($icxCommandPathLine.Count -eq 0) {
    throw 'Could not identify the ICX executable path during prerequisite checking'
}
$oneApiRootPrefix = [System.IO.Path]::GetFullPath($oneApiRootPath).TrimEnd([char[]]@('\', '/')) + '\'
$icxCommandPath = $icxCommandPathLine[0].Trim()
if (-not $icxCommandPath.StartsWith($oneApiRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ICX resolved outside the specified oneAPI root: $icxCommandPath"
}

$icxVersion = $null
foreach ($line in $toolchainLines) {
    if ($line -match 'Intel\(R\) oneAPI DPC\+\+/C\+\+ Compiler.*?(?:\bVersion\s+|\s)(\d+\.\d+\.\d+)\b') {
        $icxVersion = $Matches[1]
        break
    }
}
if (-not $icxVersion) {
    throw "Could not identify the ICX version during prerequisite checking:`n$($toolchainLines -join "`n")"
}
if ($icxVersion -notmatch '^2026\.1\.\d+$') {
    throw "Expected an ICX 2026.1.x compiler, found $icxVersion"
}

$localUiAssetPath = Join-Path $sourcePath 'tools\ui\dist'
if (Test-Path -LiteralPath $localUiAssetPath) {
    throw "Unverified source-directory UI assets found at $localUiAssetPath. Move this directory out of the source tree; the build downloads and verifies pinned UI assets automatically."
}

if ($buildOneDnn) {
    $oneDnnPreflightSummary = "oneDNN $dnnlVersion (source build pending)"
} else {
    $oneDnnPreflightSummary = "oneDNN $dnnlVersion"
}
Write-Output "Build prerequisites verified: ICX $icxVersion, CMake $cmakeVersion, Ninja $ninjaVersion, $oneDnnPreflightSummary"

if ($directStoragePath) {
    $directStorageSummary = "1.3.0 from $directStoragePath"
} else {
    $directStorageSummary = 'pinned 1.3.0 (CMake download)'
}

Write-Output ''
Write-Output 'Build summary:'
Write-Output "  Source: $sourcePath ($head)"
Write-Output "  Build: $buildNumber, commit $buildCommit; UI: $uiVersion"
Write-Output '  Configuration: x64-windows-sycl-release; SYCL enabled; tests disabled'
Write-Output "  Toolchain: MSVC via $vcVarsPath; ICX $icxVersion; CMake $cmakeVersion; Ninja $ninjaVersion"
Write-Output "  oneAPI: setvars $oneApiSetvarsPath; root $oneApiRootPath"
if ($buildOneDnn) {
    $oneDnnSummary = "oneDNN $dnnlVersion (source build from GitHub)"
} else {
    $oneDnnSummary = "oneDNN $dnnlVersion from $dnnlPath"
}
Write-Output "  Dependencies: $oneDnnSummary; DirectStorage $directStorageSummary"
Write-Output '  Targets: llama-server, llama-bench'
Write-Output "  Parallel jobs: $BuildJobs"
Write-Output "  Build directory: $buildPath"
if ($buildDirectoryExists) {
    if ($buildCacheExists) {
        Write-Host '    Existing Ninja build cache will be reused incrementally.' -ForegroundColor Yellow
    } else {
        Write-Output '    Existing directory has no CMake cache; configuration will start fresh.'
    }
}
Write-Output "  Stage directory: $stagePath"
if ($stageDirectoryExists) {
    Write-Host '    Existing stage directory will be replaced after a successful build.' -ForegroundColor Yellow
}
Write-Output "  Inference bundle: $inferenceBundlePath"
Write-Output ''

if ($stageDirectoryExists) {
    $confirmation = Read-Host 'Replace the existing stage directory after a successful build? [y/N]'
    if ($confirmation -notmatch '^(?i:y|yes)$') {
        Write-Output 'Build cancelled; the existing stage directory was not modified.'
        return
    }
}

if ($bundleNeedsOverwrite) {
    Write-Host 'The existing inference bundle does not match the expected build.' -ForegroundColor Yellow
    if (
        $existingBundleVersion.ExitCode -eq 0 -and
        -not [string]::IsNullOrWhiteSpace($existingBundleVersion.BuildNumber) -and
        -not [string]::IsNullOrWhiteSpace($existingBundleVersion.BuildCommit)
    ) {
        Write-Host "  Found:    build $($existingBundleVersion.BuildNumber), commit $($existingBundleVersion.BuildCommit)" -ForegroundColor Red
    } else {
        Write-Host "  Found:    $existingBundleStatus" -ForegroundColor Red
        if (
            -not [string]::IsNullOrWhiteSpace($existingBundleVersion.VersionText) -and
            $existingBundleVersion.VersionText -ne $existingBundleStatus
        ) {
            Write-Host '  Details:' -ForegroundColor DarkGray
            Write-Host $existingBundleVersion.VersionText -ForegroundColor DarkGray
        }
    }
    Write-Host "  Expected: build $buildNumber, commit $buildCommit" -ForegroundColor Green
    $confirmation = Read-Host 'Replace the existing bundle after a successful build? [y/N]'
    if ($confirmation -notmatch '^(?i:y|yes)$') {
        Write-Output 'Build cancelled; the existing inference bundle was not modified.'
        return
    }
} elseif (-not $Yes) {
    $confirmation = Read-Host 'Start compiling llama.cpp? [y/N]'
    if ($confirmation -notmatch '^(?i:y|yes)$') {
        Write-Output 'Build cancelled; existing build and stage directories were left unchanged.'
        return
    }
}

if ($buildOneDnn) {
    Write-Host "Building oneDNN $dnnlVersion from the pinned source archive..." -ForegroundColor DarkCyan
    Build-OneDnnFromSource `
        -CacheRoot $oneDnnCacheRoot `
        -Version $dnnlVersion `
        -CurlPath $curlPath `
        -VcVarsPath $vcVarsPath `
        -OneApiSetvarsPath $oneApiSetvarsPath `
        -Jobs $BuildJobs
    $oneDnnMetadata = Get-OneDnnPackageMetadata -PackagePath $dnnlPath -ExpectedVersion $dnnlVersion
    $dnnlPath = $oneDnnMetadata.PackagePath
    $dnnlInstallRoot = $oneDnnMetadata.InstallRoot
    $dnnlRuntimePath = $oneDnnMetadata.RuntimePath
    Write-Host "oneDNN $dnnlVersion built and installed at $dnnlInstallRoot" -ForegroundColor Green
}

Write-Host 'Starting llama.cpp build...' -ForegroundColor Cyan
New-Item -ItemType Directory -Path $buildPath -Force | Out-Null
$toolchainLines | Set-Content -LiteralPath $toolchainVersionLog -Encoding utf8
Initialize-LlamaUiAssets -BuildPath $buildPath -Version $uiVersion `
    -ExpectedSha256 $manifest.UiArchiveSha256 -CurlPath $curlPath -CMakePath $cmakePath

$configureLog = Join-Path $buildPath 'configure.log'
$cacheResetArguments = ''
if ($buildCacheExists) {
    $cacheResetArguments = ' -U LLAMA_BUILD_BORINGSSL -U LLAMA_OPENSSL'
}
$configureCommand = 'call "{0}" && set "NoDefaultCurrentDirectoryInExePath=" && call "{1}" && cd /d "{2}" && set "HF_WEBUI_VERSION=" && set "HF_UI_VERSION={3}" && cmake{8} --preset x64-windows-sycl-release -DGGML_NATIVE=OFF "-DDNNL_DIR={4}" -DLLAMA_DIRECTSTORAGE_VERSION=1.3.0 -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_NUMBER={5} -DLLAMA_BUILD_COMMIT={6} -DLLAMA_UI_HF_BUCKET=ggml-org/llama-ui{7}' -f $vcVarsPath, $oneApiSetvarsPath, $sourcePath, $uiVersion, $dnnlPath, $buildNumber, $buildCommit, $directStorageArgument, $cacheResetArguments
Invoke-Cmd -CommandLine $configureCommand -LogPath $configureLog -Description 'CMake configure'

$expectedCacheValues = @{
    'BUILD_SHARED_LIBS' = 'ON'
    'CMAKE_BUILD_TYPE' = 'Release'
    'GGML_BUILD_TESTS' = 'OFF'
    'GGML_NATIVE' = 'OFF'
    'GGML_SYCL' = 'ON'
    'GGML_SYCL_F16' = 'OFF'
    'LLAMA_BUILD_COMMIT' = $buildCommit
    'LLAMA_BUILD_NUMBER' = "$buildNumber"
    'LLAMA_BUILD_SERVER' = 'ON'
    'LLAMA_BUILD_TESTS' = 'OFF'
    'LLAMA_BUILD_TOOLS' = 'ON'
    'LLAMA_BUILD_UI' = 'OFF'
    'LLAMA_MOE_DIRECTSTORAGE' = 'ON'
    'LLAMA_OPENSSL' = 'ON'
    'LLAMA_USE_PREBUILT_UI' = 'ON'
}
foreach ($setting in $expectedCacheValues.GetEnumerator()) {
    Assert-CMakeCacheValue -CachePath $cachePath -Name $setting.Key -ExpectedValue $setting.Value
}

$compilerMetadataDir = Join-Path (Join-Path $buildPath 'CMakeFiles') $cmakeVersion
$cCompilerMetadataPath = Join-Path $compilerMetadataDir 'CMakeCCompiler.cmake'
$cxxCompilerMetadataPath = Join-Path $compilerMetadataDir 'CMakeCXXCompiler.cmake'
if (
    -not (Test-Path -LiteralPath $cCompilerMetadataPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $cxxCompilerMetadataPath -PathType Leaf)
) {
    throw "CMake compiler metadata was not generated under $compilerMetadataDir"
}
$cCompilerMetadata = Get-Content -LiteralPath $cCompilerMetadataPath -Raw
$cxxCompilerMetadata = Get-Content -LiteralPath $cxxCompilerMetadataPath -Raw
$msvcVersionMatch = [regex]::Match($cCompilerMetadata, '(?s)set\(CMAKE_C_COMPILER_ID "MSVC"\).*?set\(CMAKE_C_COMPILER_VERSION "([^"]+)"\)')
$oneApiVersionMatch = [regex]::Match($cxxCompilerMetadata, '(?s)set\(CMAKE_CXX_COMPILER_ID "IntelLLVM"\).*?set\(CMAKE_CXX_COMPILER_VERSION "([^"]+)"\)')
if (-not $msvcVersionMatch.Success -or -not $oneApiVersionMatch.Success) {
    throw "Could not identify the configured MSVC and oneAPI compiler versions in $compilerMetadataDir"
}
$msvcVersion = $msvcVersionMatch.Groups[1].Value
$oneApiCompilerVersion = $oneApiVersionMatch.Groups[1].Value

$buildLog = Join-Path $buildPath 'build.log'
$buildCommand = 'call "{0}" && set "NoDefaultCurrentDirectoryInExePath=" && call "{1}" && cd /d "{2}" && set "HF_WEBUI_VERSION=" && set "HF_UI_VERSION={3}" && cmake --build "{4}" --target llama-server llama-bench --parallel {5}' -f $vcVarsPath, $oneApiSetvarsPath, $sourcePath, $uiVersion, $buildPath, $BuildJobs
Invoke-Cmd -CommandLine $buildCommand -LogPath $buildLog -Description 'Runtime target build' -StreamOutput

if (Test-Path -LiteralPath (Join-Path $buildBin 'test-backend-ops.exe')) {
    throw 'test-backend-ops.exe was built despite both test options being OFF'
}

$runtimeSources = @{}
foreach ($fileName in $runtimeFiles) {
    if ($fileName -eq 'dnnl.dll') {
        $sourceFile = $dnnlRuntimePath
    } elseif ($oneApiRuntimePaths.ContainsKey($fileName)) {
        $sourceFile = Join-Path $oneApiRootPath $oneApiRuntimePaths[$fileName]
    } else {
        $sourceFile = Join-Path $buildBin $fileName
    }

    if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
        throw "Required runtime file is missing: $sourceFile"
    }
    if ((Get-Item -LiteralPath $sourceFile).Length -le 0) {
        throw "Required runtime file is empty: $sourceFile"
    }
    $runtimeSources[$fileName] = $sourceFile
}

if ($stageDirectoryExists) {
    if (Test-Path -LiteralPath $stagePath) {
        if (-not (Test-Path -LiteralPath $stagePath -PathType Container)) {
            throw "Stage path changed while the build was running; refusing to replace it: $stagePath"
        }
        $stageDirectoryItem = Get-Item -LiteralPath $stagePath
        if (($stageDirectoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Stage directory became a reparse point; refusing to replace it: $stagePath"
        }
        Remove-Item -LiteralPath $stagePath -Recurse -Force
    }
} elseif (Test-Path -LiteralPath $stagePath) {
    throw "Stage directory appeared while the build was running; refusing to replace it: $stagePath"
}
New-Item -ItemType Directory -Path $stagePath -Force | Out-Null
$stagedFiles = @()
foreach ($fileName in $runtimeFiles) {
    $sourceFile = $runtimeSources[$fileName]
    $destinationFile = Join-Path $stagePath $fileName
    Copy-Item -LiteralPath $sourceFile -Destination $destinationFile
    $stagedItem = Get-Item -LiteralPath $destinationFile
    $stagedHash = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $stagedFiles += [pscustomobject]@{
        name = $fileName
        size = $stagedItem.Length
        sha256 = $stagedHash
        source = $sourceFile
    }
}

$actualStageFiles = @(Get-ChildItem -LiteralPath $stagePath -File | Select-Object -ExpandProperty Name | Sort-Object)
$expectedStageFiles = @($runtimeFiles | Sort-Object)
if (Compare-Object -ReferenceObject $expectedStageFiles -DifferenceObject $actualStageFiles) {
    throw 'Staged runtime file list does not match the manifest'
}
if (Test-Path -LiteralPath (Join-Path $stagePath 'test-backend-ops.exe')) {
    throw 'Test executables must not be present in the production stage'
}

$versionResult = Get-LlamaServerBuildInfo -BundlePath $stagePath
$versionText = $versionResult.VersionText
if (
    $versionResult.ExitCode -ne 0 -or
    $versionResult.BuildNumber -ne "$buildNumber" -or
    $versionResult.BuildCommit -ne $buildCommit
) {
    throw "Staged llama-server version did not match build $buildNumber, commit ${buildCommit}:`n$versionText"
}

$inferenceBundleParent = Split-Path -Parent $inferenceBundlePath
New-Item -ItemType Directory -Path $inferenceBundleParent -Force | Out-Null
$robocopyPath = Join-Path $env:SystemRoot 'System32\robocopy.exe'
$copyResult = Invoke-NativeCapture -ExecutablePath $robocopyPath -Arguments @(
    $stagePath,
    $inferenceBundlePath,
    '/MIR',
    '/NJH',
    '/NJS',
    '/NFL',
    '/NDL',
    '/NP',
    '/R:2',
    '/W:1'
)
if ($copyResult.ExitCode -ge 8) {
    throw "Could not update the inference bundle at $inferenceBundlePath (robocopy exit code $($copyResult.ExitCode)):`n$($copyResult.Output -join "`n")"
}
$global:LASTEXITCODE = 0

$deployedVersion = Get-LlamaServerBuildInfo -BundlePath $inferenceBundlePath
if (
    $deployedVersion.ExitCode -ne 0 -or
    $deployedVersion.BuildNumber -ne "$buildNumber" -or
    $deployedVersion.BuildCommit -ne $buildCommit
) {
    throw "Updated inference bundle did not match build $buildNumber, commit ${buildCommit}:`n$($deployedVersion.VersionText)"
}
$versionText = $deployedVersion.VersionText
Write-Host "Updated llama.cpp inference bundle at $inferenceBundlePath" -ForegroundColor Green

$provenancePath = Join-Path $buildPath 'llama-bundle-provenance.json'
$provenance = [ordered]@{
    base_commit = $baseCommit
    patched_commit = $head
    patched_tree = $tree
    patchset_sha256 = $patchSetSha256
    patches = @($patchSet.Patches | ForEach-Object {
        [ordered]@{
            file = $_.Name
            sha256 = $_.Sha256
        }
    })
    build_number = $buildNumber
    build_commit = $buildCommit
    ui_version = $uiVersion
    cmake_preset = 'x64-windows-sycl-release'
    tests = [ordered]@{
        LLAMA_BUILD_TESTS = $false
        GGML_BUILD_TESTS = $false
    }
    toolchain_paths = [ordered]@{
        vcvars64 = $vcVarsPath
        oneapi_setvars = $oneApiSetvarsPath
        oneapi_root = $oneApiRootPath
        dnnl_dir = $dnnlPath
        directstorage_dir = $directStoragePath
    }
    toolchain_versions = [ordered]@{
        msvc = $msvcVersion
        oneapi = $oneApiCompilerVersion
        cmake = $cmakeVersion
        ninja = $ninjaVersion
        onednn = $dnnlVersion
        directstorage = '1.3.0'
    }
    toolchain_version_log = $toolchainVersionLog
    staged_files = $stagedFiles
}
$provenance | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $provenancePath -Encoding utf8

Write-Output "Build tree: $buildPath"
Write-Output "Stage: $stagePath"
Write-Output "Inference bundle: $inferenceBundlePath"
Write-Output "Provenance: $provenancePath"
Write-Output $versionText
