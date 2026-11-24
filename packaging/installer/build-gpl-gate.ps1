# Dot-sourced by build-servicehub.ps1 and build-tts-manager.ps1.
#
# phonemizer (phonemizer-fork) and espeak-ng (espeakng-loader, misaki.espeak) are
# GPL-3.0 and are excluded from the bundle (#3724). Pure-Python modules compile into
# the PYZ inside the exe and leave no file on disk, so the PYZ table of contents is
# checked as well as the bundle tree. A missing TOC fails the build rather than
# skipping the check.

function Assert-NoGplInBundle {
    param(
        [Parameter(Mandatory)][string]$PyzToc,
        [Parameter(Mandatory)][string]$BundleDir,
        [Parameter(Mandatory)][string]$LogPrefix
    )
    if (-not (Test-Path -LiteralPath $PyzToc)) {
        throw "$LogPrefix GPL gate: $PyzToc not found, so the bundled Python modules cannot be checked."
    }
    # TOC entries read ('module.name', 'C:\\path\\to\\source.py', 'PYMODULE').
    $modulePattern = "\('([A-Za-z0-9_.]*(?:phonemizer|espeak)[A-Za-z0-9_.]*)',"
    $modules = @(Select-String -LiteralPath $PyzToc -Pattern $modulePattern -AllMatches |
        ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    $files = @(Get-ChildItem -LiteralPath $BundleDir -Recurse -Force |
        Where-Object { $_.Name -match 'espeak|phonemizer' } | ForEach-Object { $_.FullName })
    if ($modules.Count -gt 0 -or $files.Count -gt 0) {
        throw "$LogPrefix GPL gate: GPL-3.0 code in the bundle. Modules in PYZ: [$($modules -join ', ')]. Files: [$($files -join ', ')]. Remove the dependency that pulls it in (see host/tts_manager/README.md, 'No GPL')."
    }
    Write-Host "$LogPrefix GPL gate passed (no phonemizer / espeak in PYZ or on disk)." -ForegroundColor Green
}
