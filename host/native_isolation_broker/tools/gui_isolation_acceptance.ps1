#Requires -Version 5.1
<#
.SYNOPSIS
  Manual acceptance driver for #3499 and #3400: does each tier's private window station and desktop keep it
  away from the signed-in owner's desktop?

.DESCRIPTION
  Produces the per-tier evidence table for PR #3714. Run it as the signed-in owner, unelevated, from a
  PowerShell on the owner's own desktop, while the app under test is running with its roles started, and
  with an operator at the keyboard:

    powershell -NoProfile -ExecutionPolicy Bypass -File host\native_isolation_broker\tools\gui_isolation_acceptance.ps1 -AgentShell -ProductProfileId pro

  For each tier (bootstrap, file_tool, network_connector) it:
    1. derives the tier account with scripts\native-isolation\broker-account-name.ps1, the product's mirror of
       identity_name::account_name_for, after that file's golden-vector self-check;
    2. compiles the verification program (gui_isolation_{probe,checks,hop,native}.cs) with the .NET
       Framework's csc.exe into %TEMP% and starts it in the tier account through the product's first hop
       (CreateProcessWithLogonW with the owner-readable credential, logon flags 0, null lpDesktop). That hop
       finds a live product role of the tier - a direct child of a --tier-runner supervisor, its image under
       that supervisor's payload root, its DesktopInfo exactly the station and desktop it holds, which is
       SuperClawTier-<the supervisor's pipe id> - and starts the probe on that desktop with the role's token
       shape (enabled by default; deny-only with -RoleDesktopBoundary; no restricting SID, default DACL
       the tier account and SYSTEM) and in no Job, so without Job UI limits. A lane whose role, probe placement or SIDs cannot be
       proven is INCONCLUSIVE throughout;
    3. runs every check first from the owner (the control) and then from the tier.
  -AgentShell adds a file_tool lane in which the operator has the app's own agent shell start the probe, so
  the checks run again inside the product Job; that lane counts only if the probe reads all eight Job UI
  limits (0xff) from inside it. -AgentShellOnly runs that lane alone, with no direct tier lane.
  Check 7 joins the default set only with -RoleDesktopBoundary. -Checks 0,4 (any of
  0,1,2,3,4,5,6,7,R) runs only those checks in every lane; the others are rows marked
  NOT RUN, the report lists them, and such a run never exits 0. Lane preconditions hold either way.

  Check 0 placement counts every live process of the tier account except the hop and what the hop itself
  created (its console host), matched by parent pid and creation time: any other one - supervisor, role,
  a descendant of either, or unrelated - on WinSta0 or holding a WinSta0 handle is FAIL, named in the row,
  and every one is listed in the JSON with its pid, image, parent, kind, DesktopInfo and held objects.

  Checks: 0 placement and token shape; 1 SendInput into the focused owner window; 2 BitBlt screen capture
  and 3 Desktop Duplication, looking for the owner window's colour; 4 a low-level keyboard hook while the
  operator types; 5 PostMessage/SendMessageTimeout to the owner window; 6 opening WinSta0, its Default and
  input desktops, the clipboard, and enumerating the owner's windows. R rows record what stays reachable
  (plan 5.6): owner and other-tier processes, the owner's profile folders, session and global named
  objects, a Local\ creation, visible pipe names, a global atom.
  Check 7 performs the full WinSta0\Default attach sequence, sends only VK_F24 down/up (never text), and
  attempts a one-pixel in-memory BitBlt. It needs no operator input.

  Verdicts: PASS - the check demonstrably ran on the tier side and the effect did not occur; DENIED - the
  tier side was refused with the expected error code; FAIL - the tier side got the effect; INCONCLUSIVE - no
  valid observation, or the owner's control failed (PASS and DENIED both need it); RECORDED - a residual
  observation, not judged. See gui_isolation_lane_checks.ps1 for each check's rule.

  Operator steps (the test window repeats each instruction in its white header):
    - Run it in a session that is on screen: not locked, and not a minimized or disconnected Remote Desktop
      window, where Windows stops rendering and the owner's own capture controls fail.
    - Keep the topmost coloured "SuperClaw isolation test" window on the primary monitor and uncovered. It
      never takes focus by itself.
    - "Click inside the coloured test window": click it once, then keep hands off the keyboard and mouse.
      The prompt repeats until that window is the foreground window; the driver never takes focus itself.
    - "Now type <MARKER>": type the letters shown (case does not matter, no Enter). If nothing reached the
      window, the driver asks once more.
    - Agent shell lane: the console prints a yellow ACTION NEEDED block. Paste its text into a chat in the
      SuperClaw app under test and approve the bash tool call; the block repeats every 3 minutes.
  During check 6 every clipboard format is copied, the clipboard is replaced, and the copies are put back.
  A clipboard holding a format that cannot be copied (bitmaps without a DIB, metafiles, palettes,
  owner-drawn data) is left alone and check 6c is INCONCLUSIVE.

  Output: gui-isolation-results.md and gui-isolation-results.json in -Out, written after cleanup. Exit 3 when
  the run itself failed (the clipboard was not restored, a test process or folder was left behind, or the run
  stopped), which takes precedence; otherwise 1 when any judged row is FAIL, 0 when every one is PASS or
  DENIED, and 2 otherwise.

  -SelfTest debugs this driver without a product role: each hop creates a lookalike station and desktop in
  its own logon session, and the driver opens no product process. Its output is stamped NOT EVIDENCE.
#>
param(
    [ValidateSet("bootstrap", "file_tool", "network_connector")]
    [string[]]$Tier = @("bootstrap", "file_tool", "network_connector"),
    [switch]$AgentShell,
    [switch]$AgentShellOnly,
    [string[]]$Checks = @("0", "1", "2", "3", "4", "5", "6", "R"),
    [string]$ProductProfileId = "(not stated)",
    [string]$Out = (Join-Path (Get-Location) ("gui-isolation-" + (Get-Date -Format "yyyyMMdd-HHmmss"))),
    [switch]$RoleDesktopBoundary,
    [switch]$SelfTest
)
$ErrorActionPreference = "Stop"
if ($AgentShellOnly -and $SelfTest) { throw "-AgentShellOnly needs the app's agent shell; a self-test has none." }

# Matched marker-colour pixels that count as "the owner's marker is in the image"; the window shows ~240,000.
$MarkerPixels = 1000
$AnswerSeconds = 45
$explicitCheckIds = @($Checks | ForEach-Object { "$_".Split(",") } | ForEach-Object { $_.Trim().ToUpperInvariant() } | Where-Object { $_ } | Select-Object -Unique)
$script:RegisterAttachBoundary = $RoleDesktopBoundary -or ($PSBoundParameters.ContainsKey("Checks") -and $explicitCheckIds -contains "7")
. (Join-Path $PSScriptRoot "gui_isolation_lane_checks.ps1")
if ($RoleDesktopBoundary -and -not $PSBoundParameters.ContainsKey("Checks")) { $Checks += "7" }
# powershell -File passes "0,4" as one string, so the list is split here rather than by the parameter binder.
$script:SelectedChecks = @($Checks | ForEach-Object { "$_".Split(",") } | ForEach-Object { $_.Trim().ToUpperInvariant() } | Where-Object { $_ } | Select-Object -Unique)
foreach ($id in $script:SelectedChecks) { if (-not $CheckNames.Contains($id)) { throw "-Checks takes $($CheckNames.Keys -join ','); '$id' is none of them." } }
$script:LaneTiers = if ($AgentShellOnly) { @() } else { $Tier }

# Windows PowerShell turns a native command's stderr into a terminating error under "Stop"; this returns
# both streams as text and leaves $LASTEXITCODE to the caller.
function Invoke-Native([scriptblock]$Command) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $Command 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $previous }
}

function New-MarkerColor {
    do { $rgb = @(1..3 | ForEach-Object { Get-Random -Minimum 30 -Maximum 226 }) }
    while ((($rgb | Measure-Object -Maximum).Maximum - ($rgb | Measure-Object -Minimum).Minimum) -lt 120)
    $rgb
}

function New-Side([string]$Name, [string]$TierName, [string]$Kind, [string]$Dir) {
    [pscustomobject]@{
        Name = $Name; Tier = $TierName; Kind = $Kind; Dir = $Dir; Seq = 0; Hello = $null; Discovery = $null
        Problem = $null; Summary = ""; Rows = (New-Object Collections.Generic.List[object])
    }
}

function Grant-Tier([string]$Path, [string]$Account, [string]$Rights) {
    $output = Invoke-Native { & icacls $Path /grant "$($Account):(OI)(CI)$Rights" }
    if ($LASTEXITCODE -ne 0) { throw "icacls $Path failed: $output" }
    if ($script:Granted -notcontains $Account) { $script:Granted.Add($Account) }
}

# Every process this run starts is tracked from its creation. An owner process is kept as the Process
# object Start-Process returned, whose open handle pins it, so cleanup can only ever end that process.
function Register-Owner([string]$Label, $Process) {
    [void]$Process.Handle
    $script:OwnerProcesses.Add([pscustomobject]@{ label = $Label; process = $Process; pid = $Process.Id; created = $Process.StartTime.ToFileTimeUtc() })
}

# A tier process is recorded by pid and creation time as its creator reported them: the logon hop from its
# CreateProcessWithLogonW handle, a probe from the hop's CreateProcessAsUserW handle while it was still
# suspended. The owner cannot open either; cleanup's reap hop ends them in their own account.
function Register-Tier([string]$Label, $ProcessId, $Created, [string]$Account, [string]$Dir) {
    if (-not $ProcessId) { return }
    $script:TierProcesses.Add([pscustomobject]@{ label = $Label; pid = [int]$ProcessId; created = [long]$Created; account = $Account })
    if (-not $script:ReapDirs.ContainsKey($Account)) { $script:ReapDirs[$Account] = $Dir }
}

function Start-TierLane([string]$TierName) {
    $dir = Join-Path $script:Work "lane-$TierName"
    New-Item -ItemType Directory -Force $dir | Out-Null
    $account = $script:Accounts[$TierName]
    Grant-Tier $dir $account "M"
    $script:ReapDirs[$account] = $dir
    $kind = if ($SelfTest) { "lookalike" } else { "direct" }
    $lane = New-Side "$TierName ($(if ($SelfTest) { 'LOOKALIKE self-test, NOT EVIDENCE' } else { 'probe on the role desktop, no Job UI limits' }))" $TierName $kind $dir
    $wait = if ($SelfTest) { "nowait" } else { "wait" }
    Write-Host "Starting the $TierName hop as $account ..."
    [string[]]$boundary = if ($RoleDesktopBoundary) { @("boundary") } else { @() }
    $hop = (Invoke-Native { & $script:Exe logon $account $dir $wait $(if ($SelfTest) { "lookalike" } else { "discover" }) $script:OwnerSid @boundary }) -join " "
    if ($hop -match "hop pid (\d+) created (\d+)") { Register-Tier "$TierName hop" $Matches[1] $Matches[2] $account $dir }
    $found = Wait-File (Join-Path $dir "discovery.json") 120
    $launched = Join-Path $dir "launched.json"
    if (Test-Path -LiteralPath $launched) { $probe = Read-Json $launched; Register-Tier "$TierName probe" $probe.probe_pid $probe.probe_created $account $dir }
    if (-not $found) { $lane.Problem = "the hop wrote no discovery ($hop)"; return $lane }
    $lane.Discovery = Read-Json (Join-Path $dir "discovery.json")
    if (-not $lane.Discovery.probe_pid) { $lane.Problem = "no probe started: $($lane.Discovery.refused)$($lane.Discovery.error)"; return $lane }
    if (-not (Wait-File (Join-Path $dir "hello.json") 60)) { $lane.Problem = "the probe never answered (exit $($lane.Discovery.probe_exit))"; return $lane }
    $lane.Hello = Read-Json (Join-Path $dir "hello.json")
    $lane
}

function Show-AgentRequest([string]$Request, [string]$Saved, [int]$Waited) {
    $bar = "=" * 100
    Write-Host ""
    Write-Host $bar -ForegroundColor Black -BackgroundColor Yellow
    Write-Host " ACTION NEEDED - agent shell lane (file_tool). Waiting $([int]($Waited / 60)) of 15 minutes. " -ForegroundColor Black -BackgroundColor Yellow
    Write-Host $bar -ForegroundColor Black -BackgroundColor Yellow
    Write-Host " 1. Switch to the SuperClaw app under test: the same running app whose tier roles this run measures" -ForegroundColor Yellow
    Write-Host "    (its own desktop window, not this console and not a browser)." -ForegroundColor Yellow
    Write-Host " 2. In a chat there (a new chat is fine), paste the text between the lines below as one message and send it." -ForegroundColor Yellow
    Write-Host "    It is also saved in $Saved" -ForegroundColor Yellow
    Write-Host ("-" * 100) -ForegroundColor Cyan
    Write-Host $Request -ForegroundColor Black -BackgroundColor White
    Write-Host ("-" * 100) -ForegroundColor Cyan
    Write-Host " 3. When SuperClaw asks whether to allow the bash tool call, approve it. The command keeps running until" -ForegroundColor Yellow
    Write-Host "    this driver finishes the lane; leave the chat alone meanwhile." -ForegroundColor Yellow
    Write-Host " 4. Come back to the coloured test window: this driver continues by itself as soon as the probe answers." -ForegroundColor Yellow
    Write-Host $bar -ForegroundColor Black -BackgroundColor Yellow
    Write-Host ""
}

function Start-AgentLane {
    $dir = Join-Path $script:Work "lane-file_tool-agent"
    New-Item -ItemType Directory -Force $dir | Out-Null
    Grant-Tier $dir $script:Accounts["file_tool"] "M"
    # The app starts these probes, so nothing reports their creation; cleanup's reap hop finds every one by
    # exact image path, the file_tool SID and a creation time after this run began.
    if (-not $script:ReapDirs.ContainsKey($script:Accounts["file_tool"])) { $script:ReapDirs[$script:Accounts["file_tool"]] = $dir }
    $lane = New-Side "file_tool (probe started by the app's agent shell, product Job UI limits on)" "file_tool" "agent" $dir
    $command = "'$($script:Exe -replace '\\', '/')' serve '$($dir -replace '\\', '/')'"
    $request = "Use the bash tool with a timeout of 900000 ms to run exactly this command, unchanged, and then tell me its exit code: $command"
    New-Item -ItemType Directory -Force $Out | Out-Null
    $saved = Join-Path $Out "agent-shell-request.txt"
    [IO.File]::WriteAllText($saved, $request)
    $hello = Join-Path $dir "hello.json"
    for ($waited = 0; $waited -lt 900 -and -not (Test-Path -LiteralPath $hello); $waited += 180) {
        Write-Prompt "ACTION NEEDED: see the console. Paste its request into a chat in the SuperClaw app and approve the bash tool call."
        Show-AgentRequest $request $saved $waited
        [void](Wait-File $hello 180)
    }
    if (-not (Test-Path -LiteralPath $hello)) { $lane.Problem = "no probe started from the agent shell within 15 minutes"; return $lane }
    Write-Host "The agent shell's probe answered; the lane runs now. Leave the chat alone until the driver says Done." -ForegroundColor Green
    $lane.Hello = Read-Json (Join-Path $dir "hello.json")
    Register-Tier "file_tool agent-shell probe" $lane.Hello.pid $lane.Hello.created $script:Accounts["file_tool"] $dir
    $lane
}

# Returns what could not be cleaned up; the report and the exit code carry it.
function Invoke-Cleanup {
    $issues = New-Object Collections.Generic.List[string]
    foreach ($side in $script:AllLanes) { if ($side.Hello) { [void](Invoke-Probe $side "exit" 10) } }
    if ($script:Owner -and $script:OwnerHello) {
        Restore-Clipboard
        [void](Invoke-Probe $script:Owner "atom-delete $script:Atom" 10)
    }
    if ($script:ClipboardPending) { $issues.Add("the owner's clipboard was not restored: $script:ClipboardError") }
    # Tier processes: a bounded wait for the tracked ones to exit on their own, then, per account, a reap hop
    # that ends every process of this run's image path created since the run began - tracked or not, such as
    # an agent-shell probe - and a second one that must find none left.
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline -and @($script:TierProcesses | Where-Object { Get-Process -Id $_.pid -ErrorAction SilentlyContinue }).Count) {
        Start-Sleep -Milliseconds 500
    }
    foreach ($account in @($script:ReapDirs.Keys)) {
        $dir = $script:ReapDirs[$account]
        $report = Join-Path $dir "reaped.json"
        foreach ($pass in 1, 2) {
            Remove-Item -LiteralPath $report -ErrorAction SilentlyContinue
            $output = Invoke-Native { & $script:Exe logon $account $dir wait reap $script:Exe $script:RunStart }
            if (-not (Test-Path -LiteralPath $report)) { $issues.Add("could not check $account for leftover test processes ($($output -join ' '))"); break }
            $found = [long](Read-Json $report).found
            if ($pass -eq 1) { $script:Terminated += $found }
            elseif ($found -gt 0) { $issues.Add("$found test process(es) of $account were still running after termination") }
        }
    }
    if ($script:Owner -and $script:OwnerHello) {
        foreach ($lane in $script:AllLanes) {
            $station = "$($lane.Discovery.lookalike_station)"
            if (-not $station) { continue }
            # 2 (ERROR_FILE_NOT_FOUND) is the one answer that says the station is gone.
            $open = Invoke-Probe $script:Owner "station-exists $station" 10
            if (-not (Test-Answer $open) -or (-not $open.exists -and [long]$open.error -ne 2)) { $issues.Add("could not open the lookalike window station $station to confirm it is gone ($(Format-Result $open))") }
            elseif ($open.exists) { $issues.Add("the lookalike window station $station still exists") }
        }
        [void](Invoke-Probe $script:Owner "exit" 10)
    }
    if (Test-Path -LiteralPath $script:WindowDir) { New-Item -ItemType File -Force (Join-Path $script:WindowDir "window.stop") | Out-Null }
    foreach ($item in $script:OwnerProcesses) {
        if ($item.process.WaitForExit(10000)) { continue }
        try { $item.process.Kill() } catch [InvalidOperationException] { continue }
        if ($item.process.WaitForExit(5000)) { $script:Terminated++ } else { $issues.Add("$($item.label) pid $($item.pid) is still running") }
    }
    for ($attempt = 0; $attempt -lt 3 -and (Test-Path -LiteralPath $script:Work); $attempt++) {
        Remove-Item -Recurse -Force -LiteralPath $script:Work -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $script:Work) { Start-Sleep -Seconds 1 }
    }
    if (Test-Path -LiteralPath $script:Work) {
        $revoked = foreach ($account in $script:Granted) {
            [void](Invoke-Native { & icacls $script:Work /remove:g $account /T /C /Q })
            "$account $(if ($LASTEXITCODE -eq 0) { 'revoked' } else { 'NOT revoked' })"
        }
        $issues.Add("$script:Work could not be deleted; tier grants: $($revoked -join ', ')")
    }
    foreach ($issue in $issues) { Write-Warning $issue }
    $issues
}

function Write-Report([object[]]$AllLanes) {
    New-Item -ItemType Directory -Force $Out | Out-Null
    $commit = if (Get-Command git -ErrorAction SilentlyContinue) { Invoke-Native { git -C $PSScriptRoot rev-parse --short HEAD } } else { "unknown" }
    $md = New-Object Collections.Generic.List[string]
    $md.Add("# GUI isolation acceptance (#3499, #3400)")
    $md.Add("")
    if ($SelfTest) { $md.Add("**SELF-TEST ON A LOOKALIKE STATION. NOT EVIDENCE.**"); $md.Add("") }
    $md.Add("- Run $(Get-Date -Format o) on $env:COMPUTERNAME, Windows $([Environment]::OSVersion.Version), owner $script:OwnerSid")
    $md.Add("- product_profile_id: $ProductProfileId; driver at $commit")
    $md.Add("- Role desktop boundary token shape: $(if ($RoleDesktopBoundary) { 'deny-only (-RoleDesktopBoundary)' } else { 'default enabled' })")
    $md.Add("- Verdicts: PASS = the check ran on the tier side and the effect did not occur; DENIED = the tier side was refused with the expected error; FAIL = it got the effect; INCONCLUSIVE = no valid observation or a failed owner control; RECORDED = residual, not judged.")
    $md.Add("")
    $md.Add("## Run")
    $md.Add("")
    $md.Add("- Lanes: $(if ($AgentShellOnly) { 'the agent shell lane only' } else { "$($script:LaneTiers -join ', ')$(if ($AgentShell -and -not $SelfTest) { ', and the agent shell lane' })" })")
    $skipped = @($CheckNames.Keys | Where-Object { $script:SelectedChecks -notcontains $_ })
    $md.Add("- Checks run: $($script:SelectedChecks -join ', '); not run: $(if ($skipped.Count) { $skipped -join ', ' } else { 'none' }). A check left out appears as NOT RUN in every lane.")
    $md.Add("- Tracked from creation: $($script:OwnerProcesses.Count) owner and $($script:TierProcesses.Count) tier process(es); terminated by cleanup: $script:Terminated.")
    if ($script:RunFailures.Count) { foreach ($failure in $script:RunFailures) { $md.Add("- RUN FAILURE: $failure") } }
    else { $md.Add("- Clipboard restored, no test process left in any account, the work folder is gone.") }
    foreach ($lane in $AllLanes) {
        $md.Add(""); $md.Add("## $($lane.Name)"); $md.Add("")
        if ($lane.Summary) { $md.Add($lane.Summary) }
        if ($lane.Problem) { $md.Add("Lane precondition not met: $($lane.Problem)") }
        $md.Add(""); $md.Add("| Check | Owner control | Tier side | Verdict |"); $md.Add("|---|---|---|---|")
        foreach ($row in $lane.Rows) {
            $cells = @($row.check, $row.control, $row.tier, $row.verdict) | ForEach-Object { "$_".Replace("|", "\|") }
            $md.Add("| " + ($cells -join " | ") + " |")
        }
    }
    [IO.File]::WriteAllLines((Join-Path $Out "gui-isolation-results.md"), [string[]]$md)
    $json = [ordered]@{
        issue = @(3499, 3400, 3838); self_test = [bool]$SelfTest; product_profile_id = $ProductProfileId; driver_commit = "$commit"
        role_desktop_boundary = [bool]$RoleDesktopBoundary
        computer = $env:COMPUTERNAME; windows = "$([Environment]::OSVersion.Version)"; owner_sid = $script:OwnerSid; run_at = (Get-Date -Format o)
        run_failures = $script:RunFailures.ToArray(); checks_run = $script:SelectedChecks; checks_not_run = $skipped
        lanes = @($AllLanes | ForEach-Object {
            [ordered]@{
                name = $_.Name; tier = $_.Tier; kind = $_.Kind; summary = $_.Summary; problem = $_.Problem; rows = $_.Rows.ToArray()
                hop_pid = $_.Discovery.hop_pid; hop_created = $_.Discovery.hop_created
                excluded_hop_children = @(Get-Excluded $_.Discovery); tier_processes = @(Get-Roles $_.Discovery | Select-Object -Property * -ExcludeProperty index)
            }
        })
    }
    [IO.File]::WriteAllText((Join-Path $Out "gui-isolation-results.json"), ($json | ConvertTo-Json -Depth 6))
    Write-Host "`nResults: $(Join-Path $Out 'gui-isolation-results.md')" -ForegroundColor Cyan
    $judged = @($AllLanes | ForEach-Object { $_.Rows } | Where-Object { $_.verdict -ne "RECORDED" })
    if ($script:RunFailures.Count) { return 3 }
    if (@($judged | Where-Object { $_.verdict -eq "FAIL" }).Count -gt 0) { return 1 }
    if ($SelfTest) { return 2 }
    if ($judged.Count -gt 0 -and @($judged | Where-Object { $_.verdict -notin "PASS", "DENIED" }).Count -eq 0) { return 0 }
    2
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ((New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this as the signed-in owner from an unelevated PowerShell."
}
$script:OwnerSid = $identity.User.Value
. (Join-Path $PSScriptRoot "..\..\..\scripts\native-isolation\broker-account-name.ps1")
Assert-BrokerAccountNameMirror -LogPrefix "gui_isolation_acceptance"
$script:Accounts = Get-BrokerAccountNames -OwnerSid $script:OwnerSid
$script:TierSids = @{}
foreach ($name in $script:Accounts.Keys) {
    $script:TierSids[$name] = (New-Object Security.Principal.NTAccount $script:Accounts[$name]).Translate([Security.Principal.SecurityIdentifier]).Value
}

$script:Work = Join-Path $env:TEMP "sc-gui-isolation-$PID"
$script:WindowDir = Join-Path $script:Work "owner-window"
$bin = Join-Path $script:Work "bin"
$script:Exe = Join-Path $bin "gui_isolation_probe.exe"
$script:Lanes = New-Object Collections.Generic.List[object]
$script:AllLanes = New-Object Collections.Generic.List[object]
$script:OwnerProcesses = New-Object Collections.Generic.List[object]
$script:TierProcesses = New-Object Collections.Generic.List[object]
$script:ReapDirs = @{}
$script:Terminated = 0
$script:RunStart = [DateTime]::UtcNow.AddSeconds(-5).ToFileTimeUtc()
$script:Granted = New-Object Collections.Generic.List[string]
$script:RunFailures = New-Object Collections.Generic.List[string]
$script:Owner = $null
$script:OwnerHello = $null
$script:ClipboardPending = $false
$script:ClipboardError = ""
$exitCode = 3
try {
    foreach ($dir in $bin, $script:WindowDir, (Join-Path $script:Work "owner-serve")) { New-Item -ItemType Directory -Force $dir | Out-Null }
    $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    $sources = "probe", "checks", "hop", "native" | ForEach-Object { Join-Path $PSScriptRoot "gui_isolation_$_.cs" }
    $build = Invoke-Native { & $csc /nologo /target:exe /platform:x64 /optimize+ "/out:$script:Exe" /r:System.Security.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll @sources }
    if ($LASTEXITCODE -ne 0) { throw "csc failed:`n$($build -join "`n")" }
    $grantees = @($script:LaneTiers) + $(if ($AgentShell -or $AgentShellOnly) { @("file_tool") } else { @() }) | Select-Object -Unique
    foreach ($name in $grantees) { Grant-Tier $bin $script:Accounts[$name] "RX" }

    $script:Color = New-MarkerColor
    $script:Title = "SCT" + (New-Marker 8)
    $script:Atom = "SuperClawGuiAtom" + (New-Marker 8)
    $windowArguments = @("window", "`"$script:WindowDir`"") + $script:Color + @($script:Title)
    Register-Owner "owner test window" (Start-Process -FilePath $script:Exe -ArgumentList $windowArguments -PassThru)
    if (-not (Wait-File (Join-Path $script:WindowDir "window.json") 30)) { throw "the owner test window did not start" }
    $window = Read-Json (Join-Path $script:WindowDir "window.json")
    $script:Hwnd = $window.hwnd
    $script:WindowPid = $window.pid
    $script:Owner = New-Side "owner" "" "owner" (Join-Path $script:Work "owner-serve")
    Register-Owner "owner probe" (Start-Process -FilePath $script:Exe -ArgumentList @("serve", "`"$($script:Owner.Dir)`"") -WindowStyle Hidden -PassThru)
    if (-not (Wait-File (Join-Path $script:Owner.Dir "hello.json") 30)) { throw "the owner's probe did not start" }
    $script:OwnerHello = Read-Json (Join-Path $script:Owner.Dir "hello.json")
    if ("$($script:OwnerHello.station)\$($script:OwnerHello.desktop)" -ne "WinSta0\Default") {
        throw "the owner's probe runs on $($script:OwnerHello.station)\$($script:OwnerHello.desktop); start this from the signed-in desktop"
    }
    [void](Invoke-Probe $script:Owner "atom-add $script:Atom")
    $preflight = Invoke-Probe $script:Owner "capture $($script:Color -join ' ')"
    if ($script:OwnerHello.input_desktop -ne "Default" -or (Get-CaptureOutcome $preflight) -ne "reached") {
        Write-Warning ("The owner cannot see its own test window (input desktop '$($script:OwnerHello.input_desktop)', capture: $(Format-Result $preflight)). " +
            "The screen may be locked, covered, or a minimized or disconnected Remote Desktop window. Controls that need the screen or keyboard will be INCONCLUSIVE.")
    }

    foreach ($name in $script:LaneTiers) {
        $lane = Start-TierLane $name
        $script:Lanes.Add($lane)
        $script:AllLanes.Add($lane)
    }
    foreach ($lane in $script:Lanes) { Invoke-Lane $lane }
    if (($AgentShell -or $AgentShellOnly) -and -not $SelfTest) {
        $agent = Start-AgentLane
        $script:AllLanes.Add($agent)
        Invoke-Lane $agent
    }
    Write-Prompt "Done. This window closes by itself."
} catch {
    $script:RunFailures.Add("the run stopped: $($_.Exception.Message)")
} finally {
    foreach ($issue in @(Invoke-Cleanup)) { $script:RunFailures.Add($issue) }
    $exitCode = Write-Report $script:AllLanes
}
exit $exitCode
