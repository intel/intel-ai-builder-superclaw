<#
.SYNOPSIS
    Exercise trusted Edge configuration, Bundle activation, Chat, and Embedding.

.DESCRIPTION
    Run start_llmrouter.ps1 in another terminal first. The API key is read from
    SUPERCLAW_EDGE_API_KEY or requested through a secure prompt; it is never
    stored in this script or printed. Pass -EdgeBaseUrl with your own Edge endpoint.

.EXAMPLE
    $env:SUPERCLAW_EDGE_API_KEY = Read-Host 'Edge API key'
    .\scripts\smoke\test_edge.ps1 -EdgeBaseUrl 'http://localhost:8080'
#>
[CmdletBinding()]
param(
    [int]$Port = 18321,
    [string]$EdgeBaseUrl = '',
    [string]$ApiKey = $env:SUPERCLAW_EDGE_API_KEY,
    [string]$ChatModel = 'Qwen3-Coder-Next',
    [string]$EmbeddingModel = 'KaLM-embedding-v2.5',
    [string]$BundleId = 'edge-qwen3-coder-next-80b',
    [int]$TimeoutMinutes = 10
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($EdgeBaseUrl)) {
    throw 'Pass -EdgeBaseUrl with your Edge endpoint (for example, http://localhost:8080 for a locally hosted test server).'
}
$BaseUrl = "http://127.0.0.1:$Port"
$credential = if ($env:SERVICEHUB_PROCESS_CREDENTIAL) { $env:SERVICEHUB_PROCESS_CREDENTIAL } else { 'smoke-process-credential' }
# Explicit -Headers (data-plane bearer) override this; those calls don't hit management routes.
$PSDefaultParameterValues['Invoke-RestMethod:Headers'] = @{ 'X-SuperClaw-Process-Credential' = $credential }

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Show-Json($Value) {
    $Value | ConvertTo-Json -Depth 12
}

function Wait-Operation([string]$OperationId) {
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    do {
        if ((Get-Date) -gt $deadline) {
            throw "Edge Bundle operation '$OperationId' did not finish within $TimeoutMinutes minutes."
        }
        Start-Sleep -Seconds 1
        $operation = Invoke-RestMethod -Uri "$BaseUrl/llm-router/v1/operations/$OperationId"
        Write-Host ("state={0} pct={1}% message={2}" -f $operation.state, $operation.pct, $operation.message)
        foreach ($file in @($operation.metadata.files)) {
            Write-Host ("  {0,-10} {1,-28} {2}/{3} {4}" -f $file.role, $file.id, $file.done, $file.total, $file.state)
        }
    } while ($operation.state -in @('pending', 'running'))

    Show-Json $operation
    if ($operation.state -ne 'done') {
        throw "Edge Bundle operation failed: $($operation.last_error_message)"
    }
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    $secureKey = Read-Host 'Edge API key' -AsSecureString
    $keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try {
        $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr)
    }
}
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    throw 'Edge API key is required.'
}

Write-Step 'Checking LRM health'
try {
    Show-Json (Invoke-RestMethod -Uri "$BaseUrl/llm-router/v1/health")
} catch {
    throw "LRM is not reachable at $BaseUrl. Run start_llmrouter.ps1 first. $($_.Exception.Message)"
}

$edgeBody = @{
    base_url = $EdgeBaseUrl
    api_key = $ApiKey
    model_name = $ChatModel
    embedding_model_name = $EmbeddingModel
    bypass_proxy = $true
}

Write-Step 'Testing Edge credentials without saving'
$connectionTest = Invoke-RestMethod `
    -Method Post `
    -Uri "$BaseUrl/llm-router/v1/edge/test" `
    -ContentType 'application/json' `
    -Body ($edgeBody | ConvertTo-Json)
Show-Json $connectionTest
if ($connectionTest.status -ne 'ok') {
    throw "Edge connection test failed: $($connectionTest.error) $($connectionTest.detail)"
}

Write-Step 'Saving DPAPI-encrypted Edge configuration'
$saved = Invoke-RestMethod `
    -Method Put `
    -Uri "$BaseUrl/llm-router/v1/edge" `
    -ContentType 'application/json' `
    -Body ($edgeBody | ConvertTo-Json)
Show-Json $saved

$sanitized = Invoke-RestMethod -Uri "$BaseUrl/llm-router/v1/edge"
Show-Json $sanitized
if (-not $sanitized.configured -or $null -ne $sanitized.api_key) {
    throw 'Saved Edge configuration is missing or exposed its API key.'
}

Write-Step 'Discovering exact trusted Chat and Embedding model IDs'
$models = Invoke-RestMethod -Uri "$BaseUrl/llm-router/v1/edge/models"
Show-Json $models
$modelIds = @($models.data | ForEach-Object { $_.id })
foreach ($requiredModel in @($ChatModel, $EmbeddingModel)) {
    if ($requiredModel -notin $modelIds) {
        throw "Edge /models does not expose required model '$requiredModel'. Found: $($modelIds -join ', ')"
    }
}

Write-Step 'Reading capability revision after Edge configuration'
$capability = Invoke-RestMethod -Uri "$BaseUrl/llm-router/v1/capability/primary-bundle"
Show-Json $capability

Write-Step "Preparing trusted Edge Bundle '$BundleId'"
$prepare = Invoke-RestMethod `
    -Method Post `
    -Uri "$BaseUrl/llm-router/v1/capability/primary-bundle/preparations" `
    -ContentType 'application/json' `
    -Body (@{
        target_bundle_id = $BundleId
        intent = 'connect'
        candidate_revision = [long]$capability.model_candidate_revision
        user_confirmed_download = $false
        idempotency_key = "edge-smoke-prepare-$([guid]::NewGuid().ToString('N'))"
    } | ConvertTo-Json)
Show-Json $prepare
Wait-Operation -OperationId $prepare.operation_id

$prepared = Invoke-RestMethod -Uri "$BaseUrl/llm-router/v1/capability/primary-bundle"
if ($prepared.pending_bundle.bundle_id -ne $BundleId -or $prepared.pending_bundle.state -ne 'prepared') {
    Show-Json $prepared.pending_bundle
    throw "Edge Bundle '$BundleId' did not reach prepared state."
}

$expectedRevision = if ($null -ne $prepared.primary_bundle) {
    [long]$prepared.primary_bundle.bundle_revision
} else {
    0
}

Write-Step "Committing trusted Edge Bundle at revision $expectedRevision"
$commit = Invoke-RestMethod `
    -Method Post `
    -Uri "$BaseUrl/llm-router/v1/capability/primary-bundle/commits" `
    -ContentType 'application/json' `
    -Body (@{
        target_bundle_id = $BundleId
        expected_revision = $expectedRevision
        idempotency_key = "edge-smoke-commit-$([guid]::NewGuid().ToString('N'))"
    } | ConvertTo-Json)
Show-Json $commit
if ($commit.primary_bundle.bundle_id -ne $BundleId -or $commit.primary_bundle.capability_grade -ne 'full-hdr') {
    throw 'Committed Edge Bundle identity or Grade is incorrect.'
}

Write-Step 'Testing committed Edge Chat through local-model alias'
$chat = Invoke-RestMethod `
    -Method Post `
    -Uri "$BaseUrl/v1/chat/completions" `
    -ContentType 'application/json' `
    -Body (@{
        model = 'local-model'
        messages = @(@{ role = 'user'; content = 'Reply with exactly: EDGE_OK' })
        max_tokens = 16
        stream = $false
    } | ConvertTo-Json -Depth 6)
Show-Json $chat

Write-Step 'Testing committed Edge Embedding'
$embedding = Invoke-RestMethod `
    -Method Post `
    -Uri "$BaseUrl/v1/embeddings" `
    -ContentType 'application/json' `
    -Body (@{ model = 'local-model'; input = @('edge bundle smoke test') } | ConvertTo-Json -Depth 4)
Show-Json ([PSCustomObject]@{
    object = $embedding.object
    model = $embedding.model
    vector_dimensions = @($embedding.data[0].embedding).Count
})
if (@($embedding.data[0].embedding).Count -ne 896) {
    throw 'Edge Embedding response is not 896-dimensional.'
}

Write-Host "`nTrusted Edge Bundle smoke flow completed successfully." -ForegroundColor Green
