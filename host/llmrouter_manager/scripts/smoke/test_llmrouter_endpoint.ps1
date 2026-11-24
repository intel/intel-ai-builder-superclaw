<#
.SYNOPSIS
    Exercise Local Bundle capability, download progress, commit, and llama-server inference.

.DESCRIPTION
    Run start_llmrouter.ps1 in another terminal first. This script reads the
    hardware-derived Bundle Grade, prepares the selected Bundle, polls aggregate
    and per-file download progress, commits it, provisions llama-server, and
    verifies Chat plus Embedding through LRM's OpenAI-compatible data plane.

.EXAMPLE
    .\scripts\smoke\test_llmrouter_endpoint.ps1
    .\scripts\smoke\test_llmrouter_endpoint.ps1 -BundleId local-9b -TestInvalidation
#>
[CmdletBinding()]
param(
    [int]$Port = 18321,
    [string]$BundleId = 'local-4b',
    [string]$TestRoot = (Join-Path $env:TEMP 'superclaw-hash-e2e'),
    [int]$TimeoutMinutes = 120,
    [switch]$TestInvalidation
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageDir = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$ModelsDir = Join-Path $TestRoot 'models'
$BaseUrl = "http://127.0.0.1:$Port"
$credential = if ($env:SERVICEHUB_PROCESS_CREDENTIAL) { $env:SERVICEHUB_PROCESS_CREDENTIAL } else { 'smoke-process-credential' }
# Explicit -Headers (data-plane bearer) override this; those calls don't hit management routes.
$PSDefaultParameterValues['Invoke-RestMethod:Headers'] = @{ 'X-SuperClaw-Process-Credential' = $credential }

$env:LOCALAPPDATA = $TestRoot
$env:LRM_MODEL_DIR = $ModelsDir

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Show-Json($Value) {
    $Value | ConvertTo-Json -Depth 12
}

function Get-Capability {
    Invoke-RestMethod -Uri "$BaseUrl/llm-router/v1/capability/primary-bundle"
}

function Wait-Operation([string]$OperationId, [string]$Label) {
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    do {
        if ((Get-Date) -gt $deadline) {
            throw "$Label operation '$OperationId' did not finish within $TimeoutMinutes minutes."
        }
        Start-Sleep -Seconds 2
        $operation = Invoke-RestMethod -Uri "$BaseUrl/llm-router/v1/operations/$OperationId"
        Write-Host ("{0}: state={1} pct={2}% message={3}" -f $Label, $operation.state, $operation.pct, $operation.message)
        foreach ($file in @($operation.metadata.files)) {
            $total = [double]$file.total
            $filePct = if ($total -gt 0) { [math]::Round(([double]$file.done / $total) * 100, 1) } else { 0 }
            Write-Host ("  {0,-10} {1,-28} {2,6}%  {3}/{4} bytes  {5}" -f $file.role, $file.id, $filePct, $file.done, $file.total, $file.state)
        }
    } while ($operation.state -in @('pending', 'running'))

    Show-Json $operation
    if ($operation.state -ne 'done') {
        throw "$Label operation failed: $($operation.last_error_message)"
    }
    return $operation
}

Write-Step 'Checking LRM health'
try {
    $health = Invoke-RestMethod -Uri "$BaseUrl/llm-router/v1/health"
} catch {
    throw "LRM is not reachable at $BaseUrl. Run start_llmrouter.ps1 first. $($_.Exception.Message)"
}
Show-Json $health

Write-Step 'Configuring cloud slot for auto routing'
# Read cloud credentials from env vars (Process -> User -> Machine), matching
# the resolution order used by dev_run.ps1.
#   SC_CLOUD_LLM_BASE_URL    - your provider base URL (e.g. http://localhost:8080/v1 for a local test server)
#   SC_CLOUD_LLM_APIKEY      - API key
#   SC_CLOUD_LLM_MODEL_NAME  - model id  (e.g. Qwen3-Coder-Next)
function Resolve-EnvVar([string]$name) {
    $val = [Environment]::GetEnvironmentVariable($name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($val)) { return $val }
    foreach ($scope in @('User', 'Machine')) {
        $val = [Environment]::GetEnvironmentVariable($name, $scope)
        if (-not [string]::IsNullOrWhiteSpace($val)) {
            [Environment]::SetEnvironmentVariable($name, $val, 'Process')
            return $val
        }
    }
    return $null
}

$cloudBaseUrl = Resolve-EnvVar 'SC_CLOUD_LLM_BASE_URL'
$cloudApiKey  = Resolve-EnvVar 'SC_CLOUD_LLM_APIKEY'
$cloudModel2  = Resolve-EnvVar 'SC_CLOUD_LLM_MODEL_NAME'

if (-not $cloudApiKey -or -not $cloudModel2) {
    throw @'
Cloud env vars are not set. Set the following before running this script:
  SC_CLOUD_LLM_BASE_URL    - your provider base URL (e.g. http://localhost:8080/v1 for a local test server)
  SC_CLOUD_LLM_APIKEY      - API key
  SC_CLOUD_LLM_MODEL_NAME  - model id  (e.g. Qwen3-Coder-Next)
'@
}

# Fixed internal provider id; not user-facing.
$cloudProv    = 'smoke-cloud'
$providerBody = @{ api_key = $cloudApiKey; base_url = if ($cloudBaseUrl) { $cloudBaseUrl } else { '' } } | ConvertTo-Json
# ?probe=false: skip the /models connectivity probe so the script works offline/air-gapped
Invoke-RestMethod `
    -Method Put `
    -Uri "$BaseUrl/llm-router/v1/cloud/providers/$cloudProv`?probe=false" `
    -ContentType 'application/json' `
    -Body $providerBody | Out-Null

$cloudModelBody = @{ provider = $cloudProv; model = $cloudModel2 } | ConvertTo-Json
Invoke-RestMethod `
    -Method Put `
    -Uri "$BaseUrl/llm-router/v1/cloud/model" `
    -ContentType 'application/json' `
    -Body $cloudModelBody | Out-Null

Write-Host "Cloud slot configured: $cloudModel2 @ $cloudBaseUrl" -ForegroundColor Green

Write-Step 'Reading hardware capability and Bundle Grades'
$capability = Get-Capability
Show-Json $capability
if ($capability.supported_bundle_ids.Count -eq 0) {
    throw 'No compute-supported Local Bundle was found. Check hardware.detection_errors.'
}
Write-Host ("Hardware ceiling: {0} / Grade {1}" -f $capability.hardware_capability_ceiling.bundle_id, $capability.hardware_capability_ceiling.capability_grade) -ForegroundColor Green
Write-Host "Recommended Bundle: $($capability.recommended_bundle_id)"

$bundle = @($capability.supported_bundles) | Where-Object { $_.bundle_id -eq $BundleId } | Select-Object -First 1
if ($null -eq $bundle) {
    throw "Bundle '$BundleId' is not compute-supported. Supported: $(@($capability.supported_bundle_ids) -join ', ')"
}
Write-Host ("Selected Bundle: {0}; Grade: {1}; download: {2} bytes; feasibility: {3}" -f $bundle.bundle_id, $bundle.capability_grade, $bundle.total_download_bytes, $bundle.download_feasibility)
if ($bundle.download_feasibility -eq 'insufficient_disk') {
    throw $bundle.download_block_reason
}

$intent = if ($bundle.fully_cached_and_verified) { 'connect' } else { 'download_and_connect' }
$prepareKey = "smoke-prepare-$([guid]::NewGuid().ToString('N'))"
$prepareBody = @{
    target_bundle_id = $BundleId
    intent = $intent
    candidate_revision = [long]$capability.model_candidate_revision
    user_confirmed_download = ($intent -eq 'download_and_connect')
    idempotency_key = $prepareKey
} | ConvertTo-Json

Write-Step "Preparing Bundle '$BundleId' with intent '$intent'"
$prepare = Invoke-RestMethod `
    -Method Post `
    -Uri "$BaseUrl/llm-router/v1/capability/primary-bundle/preparations" `
    -ContentType 'application/json' `
    -Body $prepareBody
Show-Json $prepare
$null = Wait-Operation -OperationId $prepare.operation_id -Label 'Bundle prepare'

Write-Step 'Confirming prepared state'
$preparedCapability = Get-Capability
Show-Json $preparedCapability.pending_bundle
if ($preparedCapability.pending_bundle.bundle_id -ne $BundleId -or $preparedCapability.pending_bundle.state -ne 'prepared') {
    throw "Bundle '$BundleId' did not reach prepared state."
}

$expectedRevision = if ($null -ne $preparedCapability.primary_bundle) {
    [long]$preparedCapability.primary_bundle.bundle_revision
} else {
    0
}
$commitBody = @{
    target_bundle_id = $BundleId
    expected_revision = $expectedRevision
    idempotency_key = "smoke-commit-$([guid]::NewGuid().ToString('N'))"
} | ConvertTo-Json

Write-Step "Committing Bundle '$BundleId' at revision $expectedRevision"
$commit = Invoke-RestMethod `
    -Method Post `
    -Uri "$BaseUrl/llm-router/v1/capability/primary-bundle/commits" `
    -ContentType 'application/json' `
    -Body $commitBody
Show-Json $commit
if ($commit.primary_bundle.bundle_id -ne $BundleId) {
    throw 'Committed Primary Bundle does not match the requested Bundle.'
}

Write-Step 'Provisioning and starting llama-server for committed Chat + Embedding'
$provision = Invoke-RestMethod `
    -Method Post `
    -Uri "$BaseUrl/llm-router/v1/inference-servers/provisions"
Show-Json $provision
if ($provision.state -eq 'running' -and $provision.operation_id) {
    $null = Wait-Operation -OperationId $provision.operation_id -Label 'llama-server provision'
} elseif ($provision.state -ne 'ready') {
    throw "llama-server was not started: state=$($provision.state), reason=$($provision.reason)"
}

Write-Step 'Checking inference-server status and probes'
$servers = Invoke-RestMethod -Uri "$BaseUrl/llm-router/v1/inference-servers"
$chatProbe = Invoke-RestMethod -Uri "$BaseUrl/llm-router/v1/inference-servers/chat/probes"
$embeddingProbe = Invoke-RestMethod -Uri "$BaseUrl/llm-router/v1/inference-servers/embedding/probes"
Show-Json $servers
Show-Json $chatProbe
Show-Json $embeddingProbe

Write-Step 'Testing committed local-model Chat'
$chat = Invoke-RestMethod `
    -Method Post `
    -Uri "$BaseUrl/v1/chat/completions" `
    -ContentType 'application/json' `
    -Body (@{
        model = 'local-model'
        messages = @(@{ role = 'user'; content = 'Reply with exactly: LOCAL_OK' })
        max_tokens = 16
        stream = $false
    } | ConvertTo-Json -Depth 6)
Show-Json $chat

Write-Step 'Testing auto routing (both slots configured - latency router decides)'
$autoChat = Invoke-RestMethod `
    -Method Post `
    -Uri "$BaseUrl/v1/chat/completions" `
    -ContentType 'application/json' `
    -Body (@{
        model    = 'auto'
        messages = @(@{ role = 'user'; content = 'What is the weather like in Beijing?' })
        max_tokens = 64
        stream   = $false
    } | ConvertTo-Json -Depth 6)
Show-Json $autoChat

Write-Step 'Testing committed Primary Bundle Embedding'
$embedding = Invoke-RestMethod `
    -Method Post `
    -Uri "$BaseUrl/v1/embeddings" `
    -ContentType 'application/json' `
    -Body (@{ model = 'local-model'; input = @('local bundle smoke test') } | ConvertTo-Json -Depth 4)
Show-Json ([PSCustomObject]@{
    object = $embedding.object
    model = $embedding.model
    vector_dimensions = @($embedding.data[0].embedding).Count
})

Write-Step 'Reading persisted SHA-256 verification records'
$recordScript = @'
import json
import sys
from llmrouter_manager.common.store import Store, default_db_path

store = Store(default_db_path())
try:
    print(json.dumps(store.get_model_verification(sys.argv[1]), sort_keys=True))
finally:
    store.close()
'@
foreach ($asset in @($bundle.assets)) {
    $recordJson = & uv run --directory $PackageDir python -c $recordScript $asset.asset_id
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to read verification record for '$($asset.asset_id)'."
    }
    $record = $recordJson | ConvertFrom-Json
    if ($null -eq $record) {
        throw "No persisted verification record exists for '$($asset.asset_id)'."
    }
    Show-Json ([PSCustomObject]@{ asset_id = $asset.asset_id; verification = $record })

    if ($TestInvalidation) {
        $modelPath = Join-Path (Join-Path $ModelsDir $asset.asset_id) $record.filename
        if (-not (Test-Path -LiteralPath $modelPath)) {
            throw "Verified model file not found: $modelPath"
        }
        (Get-Item -LiteralPath $modelPath).LastWriteTime = Get-Date
    }
}

if ($TestInvalidation) {
    Write-Step 'Re-reading capability after mtime invalidation to force rehash'
    Show-Json (Get-Capability)
}

Write-Host "`nLocal Bundle smoke flow completed successfully." -ForegroundColor Green


