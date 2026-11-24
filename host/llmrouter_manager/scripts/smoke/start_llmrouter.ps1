<#
.SYNOPSIS
    Start LLMRouter Manager with isolated state for Local Bundle smoke tests.

.EXAMPLE
    .\scripts\smoke\start_llmrouter.ps1
    .\scripts\smoke\start_llmrouter.ps1 -Reset
#>
[CmdletBinding()]
param(
    [int]$Port = 18321,
    [string]$TestRoot = (Join-Path $env:TEMP 'superclaw-hash-e2e'),
    [switch]$Reset,
    [switch]$SkipSync
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageDir = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$ModelsDir = Join-Path $TestRoot 'models'

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'uv is not installed or is not available on PATH.'
}

if ($Reset -and (Test-Path -LiteralPath $TestRoot)) {
    Write-Host "Removing isolated test state: $TestRoot" -ForegroundColor Yellow
    Remove-Item -LiteralPath $TestRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $TestRoot -Force | Out-Null
New-Item -ItemType Directory -Path $ModelsDir -Force | Out-Null

$env:LOCALAPPDATA = $TestRoot
$env:LRM_MODEL_DIR = $ModelsDir
$env:PYTHONUNBUFFERED = '1'
if (-not $env:SERVICEHUB_PROCESS_CREDENTIAL) { $env:SERVICEHUB_PROCESS_CREDENTIAL = 'smoke-process-credential' }

if (-not $SkipSync) {
    Write-Host 'Syncing LRM dependencies...' -ForegroundColor Cyan
    & uv sync --directory $PackageDir
    if ($LASTEXITCODE -ne 0) {
        throw "uv sync failed with exit code $LASTEXITCODE"
    }
}

Write-Host ''
Write-Host 'Starting isolated LLMRouter Manager' -ForegroundColor Green
Write-Host "  URL:        http://127.0.0.1:$Port"
Write-Host "  Test root:  $TestRoot"
Write-Host "  Model dir:  $ModelsDir"
Write-Host '  Stop:       Ctrl+C'
Write-Host ''

& uv run --directory $PackageDir python -u -m llmrouter_manager `
    --host 127.0.0.1 `
    --port $Port

exit $LASTEXITCODE
