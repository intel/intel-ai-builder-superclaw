#Requires -Version 5.1

# Uses Invoke-NativeCapture from the build entry point.
function Initialize-LlamaUiAssets {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$BuildPath,
        [Parameter(Mandatory = $true)]
        [string]$Version,
        [Parameter(Mandatory = $true)]
        [ValidatePattern('^[0-9a-fA-F]{64}$')]
        [string]$ExpectedSha256,
        [Parameter(Mandatory = $true)]
        [string]$CurlPath,
        [Parameter(Mandatory = $true)]
        [string]$CMakePath
    )

    $uiDirectory = Join-Path $BuildPath 'tools\ui'
    New-Item -ItemType Directory -Path $uiDirectory -Force | Out-Null
    $archivePath = Join-Path $uiDirectory 'dist.tar.gz'
    $stampPath = Join-Path $uiDirectory '.ui-stamp'
    $distPath = Join-Path $uiDirectory 'dist'
    # Never let a failed preparation leave CMake a reusable stamp.
    if (Test-Path -LiteralPath $stampPath) {
        Remove-Item -LiteralPath $stampPath -Force
    }

    $verified = (Test-Path -LiteralPath $archivePath -PathType Leaf) -and
        (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -eq $ExpectedSha256
    if (-not $verified) {
        $downloadPath = "$archivePath.download"
        try {
            foreach ($endpoint in @('https://huggingface.co', 'https://hf-mirror.com')) {
                $url = "$endpoint/buckets/ggml-org/llama-ui/resolve/$Version/dist.tar.gz`?download=true"
                Write-Host "Downloading pinned UI $Version from $endpoint..."
                $result = Invoke-NativeCapture -ExecutablePath $CurlPath -Arguments @(
                    '-f', '-sS', '-L', '--connect-timeout', '15', '--max-time', '300',
                    '-o', $downloadPath, $url
                )
                if ($result.ExitCode -ne 0) {
                    if ($result.ExitCode -notin @(5, 6, 7, 18, 22, 28, 35, 52, 55, 56, 60, 92)) {
                        throw "UI download tool failed (curl exit $($result.ExitCode)): $($result.Output -join "`n")"
                    }
                    Write-Warning "UI download failed from ${endpoint}: $($result.Output -join "`n")"
                    continue
                }
                if ((Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash -ne $ExpectedSha256) {
                    throw "UI archive SHA-256 mismatch from $endpoint; refusing to embed it."
                }
                Move-Item -LiteralPath $downloadPath -Destination $archivePath -Force
                $verified = $true
                break
            }
        } finally {
            if (Test-Path -LiteralPath $downloadPath) {
                Remove-Item -LiteralPath $downloadPath -Force
            }
        }
    }
    if (-not $verified) {
        throw "Pinned UI $Version could not be downloaded from Hugging Face or hf-mirror.com."
    }

    # Re-extract the verified archive, rather than trusting an existing dist tree.
    if (Test-Path -LiteralPath $distPath) {
        Remove-Item -LiteralPath $distPath -Recurse -Force
    }
    New-Item -ItemType Directory -Path $distPath | Out-Null
    Push-Location -LiteralPath $distPath
    try {
        $result = Invoke-NativeCapture -ExecutablePath $CMakePath -Arguments @('-E', 'tar', 'xzf', $archivePath)
        if ($result.ExitCode -ne 0) {
            throw "UI archive extraction failed: $($result.Output -join "`n")"
        }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path -LiteralPath (Join-Path $distPath 'index.html') -PathType Leaf)) {
        throw 'Verified UI archive is missing index.html.'
    }
    # Upstream CMake consumes this build-directory dist and skips its HF fetch.
    Set-Content -LiteralPath $stampPath -Value $Version -Encoding ascii
    Write-Host "UI $Version verified against pinned SHA-256 $ExpectedSha256."
}
