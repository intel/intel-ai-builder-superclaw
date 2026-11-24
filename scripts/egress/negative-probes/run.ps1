<#
.SYNOPSIS
Negative probes of an enforcing build: what each tier account must NOT reach, and what it must.

.DESCRIPTION
NOT RUN IN CI, and not for an ordinary build. It is meant for an INSTALLED build with WFP enforcement
on and the egress proxy in enforce mode (EG2-11 rollout), and it needs the owner's OK: pass
-OwnerApproved to say you have it. It changes nothing on the machine; like the egress bench it
creates -OutDir, grants each tier account Modify on its own work directory under it, and starts the
bench's probe.ps1 inside each tier account with CreateProcessWithLogonW, using the DPAPI blobs that
scripts\native-isolation\export-tier-credentials.ps1 copied out (that export is elevated and is the
owner's to run). It never runs elevated itself.

Each case runs as the owner first (the control) and then as its tier; a block only counts when the
control connected, the bench's own rule. The cases (see NegativeProbes.psm1) are:

  file_tool          direct TCP to a public host fails; via the shell proxy an unlisted host is
                     refused or held and a listed one works; the channel proxy's port and the
                     Sandbox Manager's port are not reachable
  channel            direct TCP fails; its own proxy port is reachable; the shell proxy's and the
                     Sandbox Manager's ports are not
  network_connector  each upstream/PAC endpoint is reachable; an internal address that is not one is
                     not; loopback is not; direct works when the plan has no upstream

The JSON report written to -OutDir carries outcomes, codes and labels only, in a shape that could feed
the isolation report's attestation later. Exit code: 0 pass, 1 fail or invalid, 2 incomplete.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\egress\negative-probes\run.ps1 -ConfigFile my-config.json `
    -OutDir $env:LOCALAPPDATA\superclaw-fleet\negative-probes -OwnerApproved
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $ConfigFile,
    [Parameter(Mandatory = $true)] [string] $OutDir,
    [string] $CredentialDir = (Join-Path $env:ProgramData 'SuperClaw\isolation\probe-logon-flags'),
    # Without this the script prints what it would do and stops: the owner's OK is not implied.
    [switch] $OwnerApproved,
    # Validates the config and prints the cases without running a probe.
    [switch] $DryRun,
    [int] $BatchTimeoutSeconds = 600
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:CI -or $env:GITHUB_ACTIONS -or $env:TF_BUILD) { throw 'negative probes are not run in CI: they need an installed enforcing build and the owner.' }
Import-Module (Join-Path $PSScriptRoot 'NegativeProbes.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '..\..\native-isolation\egress-bench\EgressBench.psm1') -Force

$config = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
$problems = @(Test-NegativeProbeConfig -Config $config)
if ($problems.Count -gt 0) { throw ("the config is not usable:`n  " + ($problems -join "`n  ")) }
$cases = @(New-NegativeProbeCases -Config $config)

if ($DryRun -or -not $OwnerApproved) {
    $cases | ForEach-Object { '{0,-7} {1,-18} {2,-14} {3}' -f $_.id, $_.tier, $_.expect, $_.assertion }
    if (-not $DryRun) { Write-Warning 'nothing was run: pass -OwnerApproved once the owner has agreed to a run on this installed enforcing build.' }
    return
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if ((New-Object System.Security.Principal.WindowsPrincipal($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'run this unelevated as the owner: "an unelevated first hop" is part of what is measured.'
}
$ownerSid = $identity.User.Value
$manifestPath = Join-Path $CredentialDir 'probe-accounts.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "no tier credentials at $manifestPath. Ask the owner to run scripts\native-isolation\export-tier-credentials.ps1."
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.owner_sid -ne $ownerSid) { throw "exported credentials belong to $($manifest.owner_sid), but this runs as $ownerSid" }
$tiers = @{}
foreach ($t in $manifest.tiers) { $tiers[$t.tier] = $t }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$workRoot = Join-Path $OutDir "work-$stamp"

$ownerCases = @($cases | ForEach-Object { @{ key = $_.id; probe = $_.control } })
$ownerReport = Invoke-BenchBatch -Cases $ownerCases -WorkDir (Join-Path $workRoot 'owner') -TimeoutSeconds $BatchTimeoutSeconds

$rows = New-Object System.Collections.ArrayList
$identities = [ordered]@{}
foreach ($tierName in (Get-NegativeProbeTiers)) {
    $tierCases = @($cases | Where-Object { $_.tier -eq $tierName })
    if (-not $tiers.ContainsKey($tierName)) {
        foreach ($case in $tierCases) { [void]$rows.Add((New-NegativeRow -Case $case -OwnerReport $ownerReport -TierReport $null -ExpectedSid $null)) }
        continue
    }
    $tier = $tiers[$tierName]
    $identities[$tierName] = $tier.account_sid
    $batch = @($tierCases | ForEach-Object { @{ key = $_.id; probe = $_.probe } })
    $tierReport = Invoke-BenchBatch -Cases $batch -WorkDir (Join-Path $workRoot $tierName) -Tier $tier `
        -CredentialDir $CredentialDir -TimeoutSeconds $BatchTimeoutSeconds
    foreach ($case in $tierCases) {
        [void]$rows.Add((New-NegativeRow -Case $case -OwnerReport $ownerReport -TierReport $tierReport -ExpectedSid $tier.account_sid))
    }
}

$report = New-NegativeProbeReport -Rows @($rows) -Identities $identities -RunConfig (Get-BenchRunConfig -IdentityMode 'tier') `
    -OpenLoopbackTcpRange (Get-NegativeDynamicPortRange)
$reportPath = Join-Path $OutDir "negative-probes-$stamp.json"
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
$rows | ForEach-Object { '{0,-7} {1,-18} {2,-12} {3}' -f $_.id, $_.tier, $_.verdict, $_.assertion }
"overall: $($report.overall)  report: $reportPath"
exit $report.exit_code
