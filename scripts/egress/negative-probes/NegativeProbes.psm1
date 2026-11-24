# Negative probes for an enforcing build: the case matrix, its verdicts and the attestation-shaped report.
#
# Pure logic only. Nothing here starts a process, opens a socket or reads the machine; run.ps1 does that
# through the egress bench's tier launcher, and this module decides what to ask and how to judge it. The
# verdicts are the bench's own (`Resolve-BenchVerdict`: an owner control has to connect before a block counts).
#
# NOT RUN IN CI. It needs an installed build with enforcement on, and the owner's OK to run it.

Import-Module (Join-Path $PSScriptRoot '..\..\native-isolation\egress-bench\EgressBench.psm1') -Force

$script:SchemaVersion = 1
$script:Tiers = @('file_tool', 'channel', 'network_connector')
# The loopback port of the Sandbox Manager's own API (host_control, denied to every tier by the descriptor).
$script:DefaultHostControlPort = 18821

function Get-NegativeProbeTiers { return $script:Tiers }

function Test-NegativePort {
    param($Value)
    return ($Value -is [int] -or $Value -is [long]) -and $Value -ge 1 -and $Value -le 65535
}

function Test-NegativeAddress {
    param($Value)
    $parsed = $null
    return ($Value -is [string]) -and [System.Net.IPAddress]::TryParse($Value, [ref]$parsed)
}

function Test-NegativeEndpoint {
    param($Value)
    return $null -ne $Value -and (Test-NegativeAddress (Get-BenchField $Value 'address')) -and (Test-NegativePort (Get-BenchField $Value 'port'))
}

# https only, because a CONNECT refusal is what the proxy's refusal looks like to a client; a plain
# http request would carry a 403 back as a status and read as "connected". No credentials in a URL.
function Test-NegativeHttpsUrl {
    param($Value)
    return ($Value -is [string]) -and $Value -match '^https://[^/@\s]+(/\S*)?$'
}

# Every problem with an operator's config, as text; an empty list is a usable config.
function Test-NegativeProbeConfig {
    param([Parameter(Mandatory = $true)] $Config)
    $errors = New-Object System.Collections.ArrayList
    $proxy = Get-BenchField $Config 'proxy'
    foreach ($name in @('shell_port', 'channel_port')) {
        if (-not (Test-NegativePort (Get-BenchField $proxy $name))) { [void]$errors.Add("proxy.$name must be a port") }
    }
    if ((Get-BenchField $proxy 'shell_port') -eq (Get-BenchField $proxy 'channel_port')) {
        [void]$errors.Add('proxy.shell_port and proxy.channel_port must differ')
    }
    foreach ($name in @('listed_url', 'unlisted_url')) {
        if (-not (Test-NegativeHttpsUrl (Get-BenchField $Config $name))) { [void]$errors.Add("$name must be an https URL with no credentials") }
    }
    if (-not (Test-NegativeEndpoint (Get-BenchField $Config 'direct_tcp'))) { [void]$errors.Add('direct_tcp must be an address and a port') }
    $hostControl = Get-BenchField $Config 'host_control_port' $script:DefaultHostControlPort
    if (-not (Test-NegativePort $hostControl)) { [void]$errors.Add('host_control_port must be a port') }
    $connector = Get-BenchField $Config 'connector'
    if ($null -eq $connector) { [void]$errors.Add('connector is required') }
    else {
        if (-not (Test-NegativeEndpoint (Get-BenchField $connector 'internal_other'))) {
            [void]$errors.Add('connector.internal_other must be an internal address and port that is not an upstream')
        }
        $upstream = @(Get-BenchField $connector 'upstream' @())
        foreach ($endpoint in $upstream) {
            if (-not (Test-NegativeEndpoint $endpoint)) { [void]$errors.Add('connector.upstream entries must each be an address and a port') }
        }
        if ($upstream.Count -gt 16) { [void]$errors.Add('connector.upstream lists more than the plan could permit') }
        $direct = Get-BenchField $connector 'direct_expected'
        if ($direct -isnot [bool]) { [void]$errors.Add('connector.direct_expected must be true or false') }
    }
    return @($errors)
}

function New-NegativeCase {
    param($Id, $Tier, $Assertion, $Expect, $Target, $Probe, $Control)
    return [pscustomobject]@{
        id = $Id; tier = $Tier; assertion = $Assertion; expect = $Expect; target = $Target
        probe = $Probe; control = $Control
    }
}

function New-NegativeTcp {
    param([string] $Address, [int] $Port)
    return [ordered]@{ kind = 'tcp'; address = $Address; port = $Port; timeout_ms = 4000 }
}

function New-NegativeViaProxy {
    param([string] $Url, [int] $Port)
    return [ordered]@{ kind = 'https'; url = $Url; proxy = "http://127.0.0.1:$Port"; timeout_ms = 8000 }
}

# The cases for one config. A case names a target by label and never carries an address into a report.
# `expect` is the bench's vocabulary: connect, blocked, not_applicable.
function New-NegativeProbeCases {
    param([Parameter(Mandatory = $true)] $Config)
    $shell = [int]$Config.proxy.shell_port
    $channel = [int]$Config.proxy.channel_port
    $hostControl = [int](Get-BenchField $Config 'host_control_port' $script:DefaultHostControlPort)
    $direct = $Config.direct_tcp
    $directProbe = New-NegativeTcp $direct.address ([int]$direct.port)
    $shellListener = New-NegativeTcp '127.0.0.1' $shell
    $cases = New-Object System.Collections.ArrayList

    # file_tool: no direct egress; the proxy's shell listener is the way out, and it decides per host.
    [void]$cases.Add((New-NegativeCase 'FT1' 'file_tool' 'direct TCP to a public host fails' 'blocked' 'direct_tcp' $directProbe $directProbe))
    [void]$cases.Add((New-NegativeCase 'FT2' 'file_tool' 'via the shell proxy, an unlisted host is refused or held' 'blocked' 'unlisted_url' `
            (New-NegativeViaProxy $Config.unlisted_url $shell) $shellListener))
    [void]$cases.Add((New-NegativeCase 'FT3' 'file_tool' 'via the shell proxy, a listed host works' 'connect' 'listed_url' `
            (New-NegativeViaProxy $Config.listed_url $shell) $shellListener))
    $channelPort = New-NegativeTcp '127.0.0.1' $channel
    [void]$cases.Add((New-NegativeCase 'FT4' 'file_tool' "the channel proxy's port is not reachable" 'blocked' 'channel_port' $channelPort $channelPort))
    $hostPort = New-NegativeTcp '127.0.0.1' $hostControl
    [void]$cases.Add((New-NegativeCase 'FT5' 'file_tool' "the Sandbox Manager's port is not reachable" 'blocked' 'host_control_port' $hostPort $hostPort))

    # channel: only its own proxy port; nothing direct and not the shell proxy.
    [void]$cases.Add((New-NegativeCase 'CH1' 'channel' 'direct TCP to a public host fails' 'blocked' 'direct_tcp' $directProbe $directProbe))
    [void]$cases.Add((New-NegativeCase 'CH2' 'channel' 'its own proxy port is reachable' 'connect' 'channel_port' $channelPort $channelPort))
    [void]$cases.Add((New-NegativeCase 'CH3' 'channel' "the shell proxy's port is not reachable" 'blocked' 'shell_port' $shellListener $shellListener))
    [void]$cases.Add((New-NegativeCase 'CH4' 'channel' "the Sandbox Manager's port is not reachable" 'blocked' 'host_control_port' $hostPort $hostPort))

    # network_connector: its upstream and PAC endpoints, or direct when the plan has none; not the machine's networks.
    $index = 0
    foreach ($endpoint in @(Get-BenchField $Config.connector 'upstream' @())) {
        $index++
        $probe = New-NegativeTcp $endpoint.address ([int]$endpoint.port)
        [void]$cases.Add((New-NegativeCase "NC1.$index" 'network_connector' 'an upstream or PAC endpoint is reachable' 'connect' "upstream_$index" $probe $probe))
    }
    $other = New-NegativeTcp $Config.connector.internal_other.address ([int]$Config.connector.internal_other.port)
    [void]$cases.Add((New-NegativeCase 'NC2' 'network_connector' 'an internal address that is not an upstream is not reachable' 'blocked' 'internal_other' $other $other))
    [void]$cases.Add((New-NegativeCase 'NC3' 'network_connector' 'loopback is not reachable' 'blocked' 'shell_port' $shellListener $shellListener))
    $directExpect = if ($Config.connector.direct_expected) { 'connect' } else { 'not_applicable' }
    [void]$cases.Add((New-NegativeCase 'NC4' 'network_connector' 'direct TCP to a public host works when the plan has no upstream' $directExpect 'direct_tcp' $directProbe $directProbe))
    # The socketpair shape (listen on 127.0.0.1:0, connect to it from the same process) in every tier: the
    # enforcing plan leaves loopback TCP inside the host's dynamic range open, and CPython needs it.
    $selfConnect = [ordered]@{ kind = 'socketpair'; timeout_ms = 4000 }
    [void]$cases.Add((New-NegativeCase 'FT6' 'file_tool' "a loopback self-connect inside the host's dynamic range works" 'connect' 'loopback_self_connect' $selfConnect $selfConnect))
    [void]$cases.Add((New-NegativeCase 'CH5' 'channel' "a loopback self-connect inside the host's dynamic range works" 'connect' 'loopback_self_connect' $selfConnect $selfConnect))
    [void]$cases.Add((New-NegativeCase 'NC5' 'network_connector' "a loopback self-connect inside the host's dynamic range works" 'connect' 'loopback_self_connect' $selfConnect $selfConnect))
    return @($cases)
}

# First and last port of the IPv4 TCP dynamic range from `netsh int ipv4 show dynamicport tcp` output, or $null.
# Reads the two integers after the colons (Start Port, Number of Ports) so a localized label still parses.
function ConvertFrom-NetshDynamicPort {
    param($Text)
    $numbers = @(@($Text) -join "`n" -split "`r?`n" | ForEach-Object { if ($_ -match ':\s*(\d+)\s*$') { [int]$Matches[1] } })
    if ($numbers.Count -lt 2) { return $null }
    $first = $numbers[0]
    $count = $numbers[1]
    if ($first -lt 1 -or $count -lt 1 -or ($first + $count - 1) -gt 65535) { return $null }
    return [ordered]@{ first = $first; last = ($first + $count - 1) }
}

# An unelevated read of the host's range; $null when netsh is missing, fails or prints something unparseable.
function Get-NegativeDynamicPortRange {
    try {
        $text = & netsh.exe int ipv4 show dynamicport tcp 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return ConvertFrom-NetshDynamicPort -Text $text
    }
    catch { return $null }
}

# The raw observation of one key in a batch report, stamped with the account that produced it.
function Get-NegativeObservation {
    param($Report, [string] $Key)
    $hit = @(Get-BenchField $Report 'results' @() | Where-Object { $_.key -eq $Key })
    if ($hit.Count -eq 0) { return $null }
    return [ordered]@{
        outcome = $hit[0].outcome; code = $hit[0].code; detail = $hit[0].detail
        elapsed_ms = $hit[0].elapsed_ms; identity = (Get-BenchField $Report 'identity')
    }
}

# One verdict row per case. A tier whose batch is absent or errored is NOT_RUN, never a pass.
function New-NegativeRow {
    param([Parameter(Mandatory = $true)] $Case, $OwnerReport, $TierReport, [string] $ExpectedSid)
    $control = Get-NegativeObservation -Report $OwnerReport -Key $Case.id
    $observed = $null
    if ($null -eq $TierReport) { $observed = [ordered]@{ outcome = 'not_run'; detail = 'no exported credentials for this tier' } }
    elseif (Get-BenchField $TierReport 'error') { $observed = [ordered]@{ outcome = 'not_run'; detail = [string]$TierReport.error } }
    else { $observed = Get-NegativeObservation -Report $TierReport -Key $Case.id }
    $verdict = Resolve-BenchVerdict -Expect $Case.expect -Control $control -Observed $observed -ExpectedIdentity $ExpectedSid
    return [pscustomobject]@{
        id = $Case.id; tier = $Case.tier; assertion = $Case.assertion; expect = $Case.expect; target = $Case.target
        verdict = $verdict.verdict; reason = $verdict.reason
        control = (Get-BenchField $control 'outcome'); observed = (Get-BenchField $observed 'outcome')
        observed_code = (Get-BenchField $observed 'code')
    }
}

# The run's host facts without anything that names the network: the bench's run config records the upstream
# proxy, interface addresses, gateway and DNS servers, which an attestation must not carry.
function ConvertTo-NegativeHostSummary {
    param($RunConfig)
    if ($null -eq $RunConfig) { return $null }
    $summary = [ordered]@{}
    foreach ($name in @('identity_mode', 'recorded_utc', 'machine', 'windows', 'uac', 'antivirus')) {
        $value = Get-BenchField $RunConfig $name
        if ($null -ne $value) { $summary[$name] = $value }
    }
    $network = Get-BenchField $RunConfig 'network'
    if ($null -ne $network) {
        $proxy = Get-BenchField $network 'upstream_proxy'
        $summary['network'] = [ordered]@{
            upstream_proxy_present = -not [string]::IsNullOrWhiteSpace([string]$proxy)
            interface_count = @(Get-BenchField $network 'interfaces').Count
            profile = @(@(Get-BenchField $network 'profile') | ForEach-Object { ([string]$_ -split ':', 2)[-1].Trim() })
        }
    }
    return $summary
}

# The report that could later feed the isolation report's attestation. It carries outcomes, codes and labels
# only: no address, URL, host name or credential. `attestable` is true only for a complete pass on every tier.
function New-NegativeProbeReport {
    param(
        [Parameter(Mandatory = $true)] [array] $Rows,
        [Parameter(Mandatory = $true)] $Identities,
        $RunConfig,
        # {first, last} from Get-NegativeDynamicPortRange, or $null when it could not be read.
        $OpenLoopbackTcpRange = $null,
        [string] $GeneratedAt = ([DateTime]::UtcNow.ToString('o'))
    )
    $counts = New-BenchCounts
    foreach ($row in $Rows) { $counts[$row.verdict]++ }
    $overall = Get-BenchOverall -Counts $counts
    $covered = @($script:Tiers | Where-Object {
            $tier = $_
            $mine = @($Rows | Where-Object { $_.tier -eq $tier -and $_.verdict -ne 'SKIP' })
            $mine.Count -gt 0 -and @($mine | Where-Object { $_.verdict -ne 'PASS' }).Count -eq 0
        })
    $range = $null
    if ($null -ne $OpenLoopbackTcpRange) { $range = [ordered]@{ first = [int]$OpenLoopbackTcpRange.first; last = [int]$OpenLoopbackTcpRange.last } }
    $claim = 'each attested tier was refused every path its disposition denies and reached every path it declares, as measured from a process running in that tier account'
    if ($null -ne $range) { $claim += " and loopback TCP $($range.first)-$($range.last) (the host's dynamic range) is open to every tier" }
    $attestation = [ordered]@{
        # Without the range the open-loopback statement cannot be made, so the report is not attestable.
        attestable = ($overall -eq 'pass' -and $covered.Count -eq $script:Tiers.Count -and $null -ne $range)
        tiers_attested = $covered
        tiers_not_attested = @($script:Tiers | Where-Object { $covered -notcontains $_ })
        open_loopback_tcp_range = $range
        claim = $claim
    }
    if ($null -eq $range) { $attestation['open_loopback_tcp_range_reason'] = "the host's IPv4 TCP dynamic port range could not be read" }
    return [ordered]@{
        schema = $script:SchemaVersion
        kind = 'egress_negative_probe_report'
        generated_at = $GeneratedAt
        run_in_ci = $false
        requires = 'an installed build with WFP enforcement and the egress proxy in enforce mode, and the owner approval to run it'
        identities = $Identities
        host = (ConvertTo-NegativeHostSummary $RunConfig)
        results = @($Rows)
        counts = $counts
        overall = $overall
        exit_code = (Get-BenchExitCode -Overall $overall)
        attestation = $attestation
    }
}

Export-ModuleMember -Function ConvertFrom-NetshDynamicPort, Get-NegativeDynamicPortRange, Get-NegativeProbeTiers, Test-NegativeProbeConfig, New-NegativeProbeCases, Get-NegativeObservation, New-NegativeRow, New-NegativeProbeReport
