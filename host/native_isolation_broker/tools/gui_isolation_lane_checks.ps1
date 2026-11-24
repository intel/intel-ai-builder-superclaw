# The checks of gui_isolation_acceptance.ps1 (#3499, #3400), dot-sourced by it; see that file for what the
# run is and tools/README.md for its deviations from the product path. Not a product path.
#
# Every check turns the tier side's answer into one outcome:
#   reached  the tier side got the effect (the marker, the window, the object)            -> FAIL
#   absent   the check demonstrably ran on the tier side and the effect did not occur     -> PASS
#   denied   the tier side was refused with the expected error code, recorded in the row  -> DENIED
#   $null    no valid observation: no answer, an exception, an unexpected error           -> INCONCLUSIVE
# PASS and DENIED both need the owner's control to have succeeded in the same run; a FAIL does not.

function New-Marker([int]$Length = 6) {
    $alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ"
    -join (1..$Length | ForEach-Object { $alphabet[(Get-Random -Maximum $alphabet.Length)] })
}

function Write-Prompt([string]$Text) {
    Write-Host ""
    Write-Host ">>> $Text" -ForegroundColor Yellow
    Set-Content -Encoding UTF8 -LiteralPath (Join-Path $script:WindowDir "prompt.txt") -Value $Text
}

function Wait-File([string]$Path, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while (-not (Test-Path -LiteralPath $Path)) {
        if ((Get-Date) -gt $deadline) { return $false }
        Start-Sleep -Milliseconds 200
    }
    $true
}

function Read-Json([string]$Path) { Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json }

# One command to one probe: cmd-<n>.txt in, res-<n>.json out. $null when the probe did not answer.
function Invoke-Probe($Side, [string]$Command, [int]$Seconds = $AnswerSeconds) {
    $Side.Seq++
    $file = Join-Path $Side.Dir "cmd-$($Side.Seq).txt"
    Set-Content -Encoding ASCII -LiteralPath "$file.tmp" -Value $Command
    Move-Item -LiteralPath "$file.tmp" -Destination $file
    $answer = Join-Path $Side.Dir "res-$($Side.Seq).json"
    if (-not (Wait-File $answer $Seconds)) { return $null }
    Read-Json $answer
}

# A command that threw answered with only its exception, which must never read as "the effect was absent".
function Test-Answer($Result) { [bool]($Result -and -not $Result.PSObject.Properties["exception"]) }

function Format-Result($Result) {
    if ($null -eq $Result) { return "no answer from the probe" }
    ($Result.PSObject.Properties | Where-Object { $_.Name -ne "command" } | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", "
}

function Get-WindowLog {
    $path = Join-Path $script:WindowDir "window.log"
    $lines = @()
    for ($attempt = 0; $attempt -lt 10 -and (Test-Path -LiteralPath $path); $attempt++) {
        try { $lines = [IO.File]::ReadAllLines($path); break } catch [IO.IOException] { Start-Sleep -Milliseconds 50 }
    }
    $chars = New-Object Text.StringBuilder
    $messages = New-Object Collections.Generic.List[string]
    foreach ($line in $lines) {
        $field = $line.Split(" ")
        if ($field[0] -eq "char") { [void]$chars.Append([char][int]$field[1]) }
        elseif ($field[0] -eq "msg") { $messages.Add("$($field[1]):$($field[2])") }
    }
    [pscustomobject]@{ Chars = $chars.ToString().ToUpperInvariant(); Messages = $messages }
}

function Add-Row($Lane, [string]$Check, [string]$Control, [string]$Observed, [string]$Verdict) {
    $Lane.Rows.Add([pscustomobject]@{ lane = $Lane.Name; check = $Check; control = $Control; tier = $Observed; verdict = $Verdict })
    $colour = @{ PASS = "Green"; DENIED = "Green"; FAIL = "Red"; INCONCLUSIVE = "DarkYellow"; RECORDED = "Gray"; "NOT RUN" = "Gray" }[$Verdict]
    Write-Host ("  {0,-12} {1}" -f $Verdict, $Check) -ForegroundColor $colour
}

function Get-Verdict($ControlOk, $Outcome) {
    if ($Outcome -eq "reached") { return "FAIL" }
    if (-not $ControlOk -or $null -eq $Outcome) { return "INCONCLUSIVE" }
    if ($Outcome -eq "denied") { "DENIED" } else { "PASS" }
}

# "sid:0xattrs;..." -> the attribute value of one SID, or $null.
function Get-SidAttributes([string]$Groups, [string]$Sid) {
    foreach ($entry in "$Groups".Split(";")) {
        $name, $attributes = $entry.Split(":")
        if ($name -eq $Sid -and $attributes) { return [Convert]::ToUInt32($attributes.Substring(2), 16) }
    }
    $null
}

function Test-DenyOnly($Attributes) { $null -ne $Attributes -and ($Attributes -band 0x10) -ne 0 -and ($Attributes -band 0x4) -eq 0 }
function Test-LogonEnabled($Attributes) { $null -ne $Attributes -and ($Attributes -band 0x4) -ne 0 }
function Test-ExpectedLogon($Attributes) {
    if ($RoleDesktopBoundary) { Test-DenyOnly $Attributes } else { Test-LogonEnabled $Attributes }
}

function Get-Roles($Discovery) {
    if (-not $Discovery -or -not $Discovery.role_count) { return @() }
    foreach ($index in 0..([int]$Discovery.role_count - 1)) {
        $key = "role$index"
        [pscustomobject]@{
            index = $index; pid = $Discovery."$($key)_pid"; created = $Discovery."$($key)_created"; kind = $Discovery."$($key)_kind"
            image = $Discovery."$($key)_image"; parent = $Discovery."$($key)_parent_pid"; stations = "$($Discovery."$($key)_stations")"
            desktops = "$($Discovery."$($key)_desktops")"; peb = "$($Discovery."$($key)_peb_desktop")"; placed = [bool]$Discovery."$($key)_placed"
            on_winsta0 = [bool]$Discovery."$($key)_on_winsta0"; logon = $Discovery."$($key)_logon_sids"
        }
    }
}

# The hop's own children (its console host), left out of the WinSta0 rule by parent pid and creation time.
function Get-Excluded($Discovery) {
    if (-not $Discovery -or -not $Discovery.excluded_count) { return @() }
    foreach ($index in 0..([int]$Discovery.excluded_count - 1)) {
        $key = "excluded$index"
        [pscustomobject]@{ pid = $Discovery."$($key)_pid"; created = $Discovery."$($key)_created"; image = $Discovery."$($key)_image"; peb = "$($Discovery."$($key)_peb_desktop")" }
    }
}

function Test-Relevant($Role) { $Role.kind -in "supervisor", "role" }

function Get-OwnerLogonSid { "$($script:OwnerHello.logon_sids)".Split(";")[0].Split(":")[0] }

# Where the hop's restricted copy, read back from the token, differs from the product's supervisor token
# (tier_desktop_policy::supervisor_default_dacl_sddl - default DACL the tier account and SYSTEM, no
# restricting SID, no enabled package groups, and the owner's logon SID enabled by default or deny-only
# under the #3838 boundary flag).
function Get-ProbeTokenGaps($Lane) {
    $discovery = $Lane.Discovery
    $expected = "D:(A;;GA;;;$($script:TierSids[$Lane.Tier]))(A;;GA;;;SY)"
    $ownerLogon = Get-OwnerLogonSid
    if ("$($discovery.probe_token_default_dacl)" -cne $expected) { "the probe token's default DACL reads back as '$($discovery.probe_token_default_dacl)', not $expected" }
    if ("$($discovery.probe_token_restricting_sid_count)" -ne "0") { "the probe token has '$($discovery.probe_token_restricting_sid_count)' restricting SIDs, not none" }
    if (-not (Test-ExpectedLogon (Get-SidAttributes $discovery.probe_token_logon_sids $ownerLogon))) {
        "the probe token does not hold the owner's logon SID '$ownerLogon' in the expected $(if ($RoleDesktopBoundary) { 'deny-only' } else { 'enabled' }) shape ('$($discovery.probe_token_logon_sids)')"
    }
    foreach ($item in "$($discovery.probe_token_group_sids)".Split(";")) {
        $parts = $item -split ":0x", 2
        if ($parts.Count -eq 2 -and ($parts[0] -eq "S-1-5-12" -or $parts[0].StartsWith("S-1-5-101-")) -and
            (([Convert]::ToUInt32($parts[1], 16) -band 0x4) -ne 0)) {
            "the probe token keeps package group '$($parts[0])' enabled ('$item')"
        }
    }
}

# Item by item, what makes this lane's probe the thing the lane claims to measure. Any gap makes the whole
# lane INCONCLUSIVE (Invoke-Lane downgrades its PASS and DENIED rows); a FAIL stands.
function Get-LaneGaps($Lane) {
    $gaps = New-Object Collections.Generic.List[string]
    $hello = $Lane.Hello
    $tierSid = $script:TierSids[$Lane.Tier]
    if (-not $hello) { $gaps.Add("no probe answered"); return $gaps }
    if ($hello.user_sid -ne $tierSid) { $gaps.Add("the probe runs as $($hello.user_sid), not $tierSid") }
    if (-not (Test-ExpectedLogon (Get-SidAttributes $hello.logon_sids (Get-OwnerLogonSid)))) { $gaps.Add("the probe does not hold the owner's logon SID in the expected shape ($($hello.logon_sids))") }
    if ($hello.restricting_sids -isnot [bool] -or $hello.restricting_sids) { $gaps.Add("the probe's token does not read back as unrestricted (restricting_sids '$($hello.restricting_sids)')") }
    $place = "$($hello.station)\$($hello.desktop)"
    if ($Lane.Kind -eq "agent") {
        if ($hello.job_ui_limits -ne "0xff") { $gaps.Add("Job UI limits read from inside the Job are $($hello.job_ui_limits), not all eight (0xff)") }
        if ($hello.station -eq "WinSta0" -or -not "$($hello.desktop)".StartsWith("SuperClawTier-")) { $gaps.Add("the agent shell's probe is on $place") }
        return $gaps
    }
    $discovery = $Lane.Discovery
    $target = "$($discovery.target_desktop)"
    if ($discovery.hop_user_sid -ne $tierSid) { $gaps.Add("the hop ran as $($discovery.hop_user_sid), not $tierSid") }
    foreach ($gap in @(Get-ProbeTokenGaps $Lane)) { $gaps.Add($gap) }
    if ($hello.job_ui_limits -notin "none", "0x0") { $gaps.Add("the probe runs under Job UI limits $($hello.job_ui_limits)") }
    if (-not $target) { $gaps.Add("no target desktop") }
    if ("$($hello.startup_desktop)" -cne $target -or $place -cne $target) { $gaps.Add("the probe's DesktopInfo '$($hello.startup_desktop)' or held $place is not exactly $target") }
    $roles = @(Get-Roles $discovery)
    $ownerLogon = Get-OwnerLogonSid
    $wrongLogon = @($roles | Where-Object { ((Test-Relevant $_) -or $Lane.Kind -eq "lookalike") -and -not (Test-ExpectedLogon (Get-SidAttributes $_.logon $ownerLogon)) })
    if ($wrongLogon.Count) { $gaps.Add("$($wrongLogon.Count) supervisor/role process(es) do not hold the owner's logon SID in the expected shape ($(@($wrongLogon | ForEach-Object { "pid $($_.pid) '$($_.logon)'" }) -join '; '))") }
    if ($Lane.Kind -eq "lookalike") {
        if (-not @($roles | Where-Object { $_.placed -and $_.peb -ceq $target }).Count) { $gaps.Add("the probe's own placement did not read back as $target") }
        return $gaps
    }
    $chosen = $roles | Where-Object { $_.index -eq $discovery.target_index } | Select-Object -First 1
    if (-not $chosen -or $chosen.kind -ne "role" -or -not $chosen.placed -or $chosen.peb -cne $target) { $gaps.Add("the target is not a placed product role whose DesktopInfo is exactly $target") }
    if ([int]$discovery.relevant_misplaced -gt 0) { $gaps.Add("$($discovery.relevant_misplaced) supervisor or role process(es) of the tier are not placed on their own private desktop") }
    $gaps
}

function Test-Placement($Lane) {
    $ownerPlace = "$($script:OwnerHello.station)\$($script:OwnerHello.desktop)"
    $controlOk = $ownerPlace -eq "WinSta0\Default"
    $control = "the owner's probe reads its own placement as $ownerPlace"
    $hello = $Lane.Hello
    $probePlace = if ($hello) { "$($hello.station)\$($hello.desktop) (DesktopInfo $($hello.startup_desktop))" } else { "(no probe)" }
    $gaps = @(Get-LaneGaps $Lane)
    $roles = @(Get-Roles $Lane.Discovery)
    $onWinSta0 = [bool]$Lane.Discovery.any_on_winsta0 -or ($hello -and $hello.station -eq "WinSta0")
    $culprits = @($roles | Where-Object { $_.on_winsta0 } | ForEach-Object { "$(Split-Path -Leaf $_.image) pid $($_.pid) ($($_.kind), parent $($_.parent), DesktopInfo '$($_.peb)', stations '$($_.stations)')" })
    $named = if ($culprits.Count) { $culprits -join "; " } elseif ($onWinSta0) { "none named" } else { "none" }
    $own = @(Get-Excluded $Lane.Discovery | ForEach-Object { "$(Split-Path -Leaf $_.image) pid $($_.pid)" })
    $hop = if ($Lane.Discovery.hop_pid) { "hop pid $($Lane.Discovery.hop_pid)$(if ($own.Count) { ' and its ' + ($own -join ', ') })" } else { "none" }
    if ($Lane.Kind -eq "agent") {
        $Lane.Summary = "Probe pid $($hello.pid) (parent $($hello.parent_pid)) started by the agent shell as $($hello.user_sid) on $probePlace; Job UI limits read inside the Job $($hello.job_ui_limits)."
        $observed = "probe from the agent shell on $probePlace"
    } else {
        $target = $roles | Where-Object { $_.index -eq $Lane.Discovery.target_index } | Select-Object -First 1
        $where = if ($target) { "role pid $($target.pid) $(Split-Path -Leaf $target.image) (parent supervisor $($target.parent)) holds $($target.stations)\$($target.desktops), DesktopInfo $($target.peb)" }
                 elseif ($Lane.Kind -eq "lookalike") { "lookalike $($Lane.Discovery.target_desktop)" } else { "no target role" }
        $counts = "$(@($roles | Where-Object { Test-Relevant $_ }).Count) supervisor/role process(es), $($Lane.Discovery.relevant_misplaced) misplaced, of $($roles.Count) tier process(es)"
        $Lane.Summary = "$where; $counts; probe pid $($Lane.Discovery.probe_pid) on $probePlace; Job UI limits seen by the probe: $($hello.job_ui_limits)."
        $observed = "$where; $counts; left out as the driver's own: $hop; tier processes on WinSta0: $named; probe on $probePlace"
    }
    if ($gaps.Count) { $observed += "; gaps: $($gaps -join '; ')" }
    $outcome = if ($onWinSta0) { "reached" } elseif ($gaps.Count) { $null } else { "absent" }
    Add-Row $Lane "0 placement: the tier's processes and the probe are on the role's private desktop" $control $observed (Get-Verdict $controlOk $outcome)
}

# Since #3805 the owner's logon SID is kept enabled (no restricting SID, default DACL the tier account and
# SYSTEM) so the tier can create the session's named kernel objects - a write-restricted token was measured
# not to start the supervisor. An owner process's DACL grants that logon SID, so a tier process can open
# it and read its memory; the private desktop is initial placement, not a boundary, and the role Job's UI
# limits do not cover that, `SendInput` or screen capture (#3838). This records that posture (RECORDED,
# not judged); whether it is acceptable is the
# #3400/#3499 gate owners' call. A token that is NOT this shape (a leftover restricting SID, a wrong default
# DACL, or a deny-only logon SID from a pre-#3805 build), or a lane whose preconditions are not met (no
# probe, a probe or a supervisor/role without the owner's logon SID enabled), is INCONCLUSIVE, since then
# the lane is not measuring the product.
function Test-TokenShape($Lane) {
    $ownerLogon = Get-OwnerLogonSid
    $roles = @(Get-Roles $Lane.Discovery | Where-Object { (Test-Relevant $_) -or $Lane.Kind -eq "lookalike" })
    $matching = @($roles | Where-Object { Test-ExpectedLogon (Get-SidAttributes $_.logon $ownerLogon) })
    $shape = if ($RoleDesktopBoundary) { "deny-only under the #3838 spike" } else { "enabled by default for #3805" }
    $observed = "owner logon SID $ownerLogon is $shape; probe: $($Lane.Hello.logon_sids); matching supervisor/role processes: $($matching.Count) of $($roles.Count)"
    $shapeGaps = @()
    if ($Lane.Kind -ne "agent") {
        $shapeGaps = @(Get-ProbeTokenGaps $Lane)
        $observed += "; hop argv '$($Lane.Discovery.hop_argv)', boundary parsed=$($Lane.Discovery.role_desktop_boundary_arg); the hop's restricted copy read back: default DACL $($Lane.Discovery.probe_token_default_dacl), logon SIDs $($Lane.Discovery.probe_token_logon_sids), restricting SIDs $($Lane.Discovery.probe_token_restricting_sid_count)"
        if ($shapeGaps.Count) { $observed += "; not the product's shape: $($shapeGaps -join '; ')" }
    }
    if ($Lane.Problem) { $observed += "; lane precondition not met: $($Lane.Problem)" }
    $verdict = if ($shapeGaps.Count -or $Lane.Problem) { "INCONCLUSIVE" } elseif ($RoleDesktopBoundary) { "PASS" } else { "RECORDED" }
    Add-Row $Lane "0 token: the owner-selected role token shape is exact" "" $observed $verdict
}

# GetForegroundWindow, read by the owner's probe, is the test window.
function Test-Focus { [bool](Invoke-Probe $script:Owner "fg $script:Hwnd").foreground }

# The window never takes focus itself and the driver never forces it: it repeats $Text until the operator's
# click has made the test window the foreground window, for at most $Seconds.
function Wait-Foreground([string]$Text, [int]$Seconds = 180) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    $next = Get-Date
    while ((Get-Date) -lt $deadline) {
        if (Test-Focus) { return $true }
        if ((Get-Date) -ge $next) { Write-Prompt $Text; $next = (Get-Date).AddSeconds(15) }
        Start-Sleep -Milliseconds 400
    }
    $false
}

# In a self-test nobody clicks the window, so the keyboard checks run only if it already has focus.
function Request-Focus {
    if ($SelfTest) { return (Test-Focus) }
    Wait-Foreground "Click inside the coloured test window once. Then keep your hands off the keyboard and mouse."
}

function Wait-Typed([int]$Before, [string]$Marker, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
        if ((Get-WindowLog).Chars.Substring($Before).Contains($Marker)) { return $true }
    }
    $false
}

# Synthesized input goes to whatever has focus, so nothing is sent unless the test window has it.
function Test-SendInput($Lane) {
    $check = "1 SendInput reaches the focused owner window"
    if (-not (Request-Focus)) { Add-Row $Lane $check "the test window never had focus" "not run" "INCONCLUSIVE"; return }
    Write-Prompt "Hands off: the driver is typing into this window."
    $ownerText = "C" + (New-Marker); $tierText = "T" + (New-Marker)
    if (-not (Test-Focus)) { Add-Row $Lane $check "the test window lost focus" "not run" "INCONCLUSIVE"; return }
    $owner = Invoke-Probe $script:Owner "sendinput $ownerText"
    Start-Sleep -Milliseconds 800
    $log = Get-WindowLog
    $delivered = $log.Chars.Contains($ownerText)
    $before = $log.Chars.Length
    if (-not (Test-Focus)) { Add-Row $Lane $check "owner delivered it: $delivered, then the test window lost focus" "not run" "INCONCLUSIVE"; return }
    $tier = Invoke-Probe $Lane "sendinput $tierText"
    Start-Sleep -Milliseconds 1500
    $arrived = (Get-WindowLog).Chars.Substring($before)
    $kept = Test-Focus
    # Judged by effect alone: SendInput's return value and error do not say why input was blocked.
    $outcome = if ($arrived.Length -gt 0) { "reached" } elseif (Test-Answer $tier) { "absent" } else { $null }
    Add-Row $Lane $check `
        "owner sent $ownerText ($(Format-Result $owner)); window received it: $delivered; window kept focus: $kept" `
        "tier sent $tierText ($(Format-Result $tier)); characters the window received meanwhile: '$arrived'" `
        (Get-Verdict ($delivered -and $kept) $outcome)
}

# Only BitBlt refusing the screen read is a denial; error 5 from GetDC or bitmap setup says nothing about the desktop.
function Get-CaptureOutcome($Result) {
    if (-not (Test-Answer $Result)) { return $null }
    if ($Result.captured -eq $true -and $null -ne $Result.matched) { if ([long]$Result.matched -ge $MarkerPixels) { return "reached" } else { return "absent" } }
    if ($Result.captured -eq $false -and "$($Result.stage)" -ceq "BitBlt" -and [long]$Result.error -eq 5) { return "denied" }
    $null
}

function Get-DuplicationOutputs($Result) {
    foreach ($key in "$($Result.outputs)".Split(";") | Where-Object { $_ }) {
        [pscustomobject]@{
            key = $key; hr = "$($Result."$($key)_duplicate_hr")"; checked = [long]$Result."$($key)_checked"
            matched = [long]$Result."$($key)_matched"; failed = [bool]$Result.PSObject.Properties["$($key)_error"]
        }
    }
}

# Per output (adapter and output index): the marker in a checked frame is reached. Otherwise every output
# must either have refused DuplicateOutput with E_ACCESSDENIED or have at least one frame actually checked;
# an output that duplicated but checked no frame, or failed in any other way, leaves no valid observation.
function Get-DuplicationOutcome($Result) {
    if (-not (Test-Answer $Result) -or $Result.PSObject.Properties["error"]) { return $null }
    $outputs = @(Get-DuplicationOutputs $Result)
    if (-not $outputs.Count) { return $null }
    if (@($outputs | Where-Object { $_.checked -gt 0 -and $_.matched -ge $MarkerPixels }).Count) { return "reached" }
    $denied = @($outputs | Where-Object { -not $_.failed -and $_.hr -eq "0x80070005" }).Count
    $checked = @($outputs | Where-Object { -not $_.failed -and $_.checked -gt 0 }).Count
    if ($denied + $checked -ne $outputs.Count) { return $null }
    if ($checked) { "absent" } else { "denied" }
}

function Test-ScreenRead($Lane, [string]$Verb, [string]$Check) {
    $command = "$Verb $($script:Color -join ' ')"
    $owner = Invoke-Probe $script:Owner $command 60
    $tier = Invoke-Probe $Lane $command 60
    $judge = if ($Verb -eq "capture") { ${function:Get-CaptureOutcome} } else { ${function:Get-DuplicationOutcome} }
    $controlOk = (& $judge $owner) -eq "reached"
    Add-Row $Lane $Check "owner: $(Format-Result $owner)" "tier: $(Format-Result $tier)" (Get-Verdict $controlOk (& $judge $tier))
}

function Test-KeyboardHook($Lane) {
    $marker = New-Marker 5
    $ownerStart = Invoke-Probe $script:Owner "hook-start"
    $tierStart = Invoke-Probe $Lane "hook-start"
    $before = (Get-WindowLog).Chars.Length
    $typed = $false; $focused = $false; $attempts = 0
    if ($SelfTest) {
        $focused = Request-Focus
        if ($focused) { $attempts = 1; [void](Invoke-Probe $script:Owner "sendinput $marker"); $typed = Wait-Typed $before $marker 5 }
    } else {
        # The operator types only once the window is in the foreground, and gets one retry if nothing arrived.
        $clicks = "Click inside the coloured test window once, then wait for the letters to type.",
                  "Nothing reached the test window. Click inside the coloured test window once more, then wait for the letters."
        foreach ($attempt in 0, 1) {
            $focused = Wait-Foreground $clicks[$attempt]
            if (-not $focused) { break }
            $attempts++
            Write-Prompt "Now type: $marker  (just the letters, no Enter)"
            $typed = Wait-Typed $before $marker 90
            if ($typed) { break }
        }
    }
    Start-Sleep -Milliseconds 500
    $ownerStop = Invoke-Probe $script:Owner "hook-stop"
    $tierStop = Invoke-Probe $Lane "hook-stop"
    Write-Prompt "Thanks. Hands off the keyboard and mouse."
    # Only the operator's own keystrokes count for the control; the self-test has nothing but injected ones.
    $seen = if ($SelfTest) { "$($ownerStop.typed_all)" } else { "$($ownerStop.typed_physical)" }
    $controlOk = $typed -and $ownerStart.installed -eq $true -and $seen.Contains($marker)
    $outcome = if (-not (Test-Answer $tierStart) -or -not (Test-Answer $tierStop)) { $null }
               elseif ($tierStart.installed -eq $true) { if ([long]$tierStop.events -gt 0) { "reached" } else { "absent" } }
               elseif ([long]$tierStart.error -eq 5) { "denied" } else { $null }
    Add-Row $Lane "4 low-level keyboard hook sees the operator typing $marker into the owner window" `
        "test window in the foreground: $focused; typing attempts: $attempts; window received it: $typed; owner hook: $(Format-Result $ownerStart); $(Format-Result $ownerStop)" `
        "tier hook: $(Format-Result $tierStart); $(Format-Result $tierStop)" (Get-Verdict $controlOk $outcome)
}

# 1400 (ERROR_INVALID_WINDOW_HANDLE) is how the handle of a window on another desktop answers.
function Test-PostMessage($Lane) {
    $ownerTag = Get-Random -Minimum 100000 -Maximum 499999
    $tierTag = $ownerTag + 500000
    $owner = Invoke-Probe $script:Owner "post $script:Hwnd $ownerTag"
    Start-Sleep -Milliseconds 500
    $messages = (Get-WindowLog).Messages
    $controlOk = $messages.Contains("$($ownerTag):1") -and $messages.Contains("$($ownerTag):2")
    $tier = Invoke-Probe $Lane "post $script:Hwnd $tierTag"
    Start-Sleep -Milliseconds 1000
    $got = @((Get-WindowLog).Messages | Where-Object { $_.StartsWith("$($tierTag):") })
    $refused = @(5, 1400)
    $outcome = if (-not (Test-Answer $tier)) { $null } elseif ($got.Count -gt 0) { "reached" } elseif ($tier.posted -or $tier.sent) { "absent" }
               elseif ($refused -contains [long]$tier.post_error -and $refused -contains [long]$tier.send_error) { "denied" } else { $null }
    Add-Row $Lane "5 PostMessage and SendMessageTimeout reach the owner window" `
        "owner: $(Format-Result $owner); window logged both: $controlOk" `
        "tier: $(Format-Result $tier); window logged: $($got -join ' ')" (Get-Verdict $controlOk $outcome)
}

function Restore-Clipboard {
    for ($attempt = 1; $script:ClipboardPending -and $attempt -le 5; $attempt++) {
        $restore = Invoke-Probe $script:Owner "clip-restore" 15
        if ($restore -and $restore.ok -eq $true -and $restore.restore_required -eq $false) { $script:ClipboardPending = $false; return }
        $script:ClipboardError = Format-Result $restore
        Start-Sleep -Seconds 1
    }
}

# OpenInputDesktop answers 1 (ERROR_INVALID_FUNCTION) on a station that has no input desktop at all.
function Test-UserObjects($Lane) {
    $clip = "SCCLIP" + (New-Marker 8)
    $set = Invoke-Probe $script:Owner "clip-set $clip"
    # Only an answer that says so rules restoration out; a lost answer may have emptied the clipboard.
    if (-not $set -or $set.restore_required -ne $false) { $script:ClipboardPending = $true }
    $command = "objects $script:Hwnd $clip $script:Title"
    $owner = Invoke-Probe $script:Owner $command
    $tier = Invoke-Probe $Lane $command
    Restore-Clipboard
    $answered = Test-Answer $tier
    $winsta0 = if (-not $answered) { $null } elseif ($tier.winsta0_open) { "reached" } elseif ([long]$tier.winsta0_error -eq 5) { "denied" } else { $null }
    Add-Row $Lane "6a OpenWindowStation(WinSta0)" "owner: open=$($owner.winsta0_open) granted=$($owner.winsta0_granted)" `
        "tier: open=$($tier.winsta0_open) error=$($tier.winsta0_error) granted=$($tier.winsta0_granted)" (Get-Verdict ($owner.winsta0_open -eq $true) $winsta0)
    $defaultRefused = ($winsta0 -eq "denied") -or ("$($tier.default_error)" -eq "5")
    $desktops = if (-not $answered) { $null } elseif ($tier.default_open -or $tier.input_open) { "reached" }
                elseif ($defaultRefused -and @(5, 1) -contains [long]$tier.input_error) { "denied" } else { $null }
    Add-Row $Lane "6b OpenDesktop(WinSta0\Default) and OpenInputDesktop" `
        "owner: default open=$($owner.default_open) granted=$($owner.default_granted); input open=$($owner.input_open)" `
        "tier: default open=$($tier.default_open) ($($tier.default_error)); input open=$($tier.input_open) error=$($tier.input_error)" `
        (Get-Verdict ($owner.default_open -eq $true -and $owner.input_open -eq $true) $desktops)
    $clipboard = if (-not $answered) { $null } elseif ($tier.clip_own_marker -or $tier.clip_winsta0_marker) { "reached" }
                 elseif ($tier.clip_own_opened) { "absent" } elseif ([long]$tier.clip_own_error -eq 5) { "denied" } else { $null }
    Add-Row $Lane "6c clipboard shows the owner's clipboard marker" `
        "owner set it: $(Format-Result $set); read it back: $($owner.clip_own_marker); restored: $(-not $script:ClipboardPending)" `
        "tier: own station opened=$($tier.clip_own_opened) error=$($tier.clip_own_error) marker=$($tier.clip_own_marker); via WinSta0 marker=$($tier.clip_winsta0_marker)" `
        (Get-Verdict ($set.ok -eq $true -and $owner.clip_own_marker -eq $true) $clipboard)
    $enumeration = if (-not $answered) { $null } elseif ($tier.enum_own_target -or $tier.enum_own_title -or $tier.enum_default_target) { "reached" }
                   elseif ($tier.enum_own_self -eq $true) { "absent" } elseif ([long]$tier.enum_own_error -eq 5) { "denied" } else { $null }
    Add-Row $Lane "6d window enumeration finds the owner window" `
        "owner: EnumWindows saw it: $($owner.enum_own_target) ($($owner.enum_own_count) windows)" `
        "tier: EnumWindows ok=$($tier.enum_own_ok) error=$($tier.enum_own_error) count=$($tier.enum_own_count) listed its own window=$($tier.enum_own_self) handle=$($tier.enum_own_target) title=$($tier.enum_own_title); on Default: $($tier.enum_default_target)" `
        (Get-Verdict ($owner.enum_own_target -eq $true) $enumeration)
    Add-Row $Lane "R the owner window by its handle value" "owner: IsWindow=$($owner.handle_is_window) title=$($owner.handle_title_readable)" `
        "tier: IsWindow=$($tier.handle_is_window) title readable=$($tier.handle_title_readable)" $(if ($answered) { "RECORDED" } else { "INCONCLUSIVE" })
}

function Get-AttachBoundaryOutcome($Result) {
    if (-not (Test-Answer $Result)) { return $null }
    if ($Result.attached -eq $false -and [long]$Result.error -eq 5 -and
        "$($Result.stage)" -in "OpenWindowStation", "SetProcessWindowStation", "OpenDesktop", "SetThreadDesktop") { return "denied" }
    if ([long]$Result.sent -gt 0 -or ($Result.attached -eq $true -and $Result.bitblt -eq $true)) { return "reached" }
    if ($Result.attached -eq $true -and [long]$Result.sent -eq 0 -and $Result.bitblt -eq $false -and [long]$Result.bitblt_error -eq 5) { return "denied" }
    $null
}

function Test-AttachBoundary($Lane) {
    $owner = Invoke-Probe $script:Owner "attach-boundary"
    $tier = Invoke-Probe $Lane "attach-boundary"
    $controlOk = $owner.attached -eq $true -and [long]$owner.sent -eq 2 -and $owner.bitblt -eq $true
    Add-Row $Lane "7 attach WinSta0\Default, VK_F24 SendInput, and in-memory BitBlt" `
        "owner: $(Format-Result $owner)" "tier: $(Format-Result $tier)" `
        (Get-Verdict $controlOk (Get-AttachBoundaryOutcome $tier))
}

function Get-ResidualTargets($Lane) {
    $targets = New-Object Collections.Generic.List[string]
    $targets.Add("pid`towner_driver`t$PID")
    $targets.Add("pid`towner_test_window`t$script:WindowPid")
    $session = (Get-Process -Id $PID).SessionId
    $explorer = Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session } | Select-Object -First 1
    if ($explorer) { $targets.Add("pid`towner_explorer`t$($explorer.Id)") }
    # A self-test leaves whatever product build is running alone.
    if (-not $SelfTest) {
        $tierPids = @($script:Lanes | ForEach-Object { Get-Roles $_.Discovery } | ForEach-Object { [int]$_.pid })
        Get-Process native_isolation_launcher -ErrorAction SilentlyContinue | Where-Object { $tierPids -notcontains $_.Id } |
            Select-Object -First 4 | ForEach-Object { $targets.Add("pid`towner_launcher`t$($_.Id)") }
    }
    foreach ($other in $script:Lanes) {
        $relation = if ($other.Tier -eq $Lane.Tier) { "same_tier" } else { "other_tier_$($other.Tier)" }
        Get-Roles $other.Discovery | Select-Object -First 6 | ForEach-Object {
            $targets.Add("pid`t$($relation)_$([IO.Path]::GetFileNameWithoutExtension($_.image))`t$($_.pid)")
        }
    }
    $targets.Add("path`towner_profile`t$env:USERPROFILE")
    $targets.Add("path`towner_documents`t$([Environment]::GetFolderPath('MyDocuments'))")
    $targets.Add("path`towner_local_app_data`t$env:LOCALAPPDATA")
    $targets
}

# Residual observations are recorded, not judged; a collection that did not happen is INCONCLUSIVE.
function Test-Residual($Lane) {
    $owner = Invoke-Probe $script:Owner "atom-find $script:Atom"
    $tier = Invoke-Probe $Lane "atom-find $script:Atom"
    Add-Row $Lane "R global atom the owner added" "owner found it: $($owner.found)" "tier: $(Format-Result $tier)" `
        $(if ((Test-Answer $tier) -and $owner.found -eq $true) { "RECORDED" } else { "INCONCLUSIVE" })
    [IO.File]::WriteAllLines((Join-Path $Lane.Dir "targets.txt"), [string[]](Get-ResidualTargets $Lane))
    $result = Invoke-Probe $Lane "residual" 180
    if (-not (Test-Answer $result)) { Add-Row $Lane "R residual reachability" "" "not collected: $(Format-Result $result)" "INCONCLUSIVE"; return }
    foreach ($property in $result.PSObject.Properties) {
        if ($property.Name -eq "command") { continue }
        Add-Row $Lane "R $($property.Name)" "" "$($property.Value)" "RECORDED"
    }
}

$CheckNames = [ordered]@{
    "0" = "0 placement and token shape"; "1" = "1 SendInput"; "2" = "2 BitBlt screen capture"; "3" = "3 Desktop Duplication"
    "4" = "4 low-level keyboard hook"; "5" = "5 PostMessage and SendMessageTimeout"; "6" = "6 WinSta0, desktops, clipboard, window enumeration"
}
if ($script:RegisterAttachBoundary) { $CheckNames["7"] = "7 attach WinSta0\Default, VK_F24 SendInput, and in-memory BitBlt" }
$CheckNames["R"] = "R residual reachability"

function Invoke-Lane($Lane) {
    Write-Host "`n=== $($Lane.Name) ===" -ForegroundColor Cyan
    # The lane's preconditions hold whichever checks run; check 0 only reports them.
    $gaps = @(Get-LaneGaps $Lane)
    if ($gaps.Count) { $Lane.Problem = (@(@($Lane.Problem) + $gaps | Where-Object { $_ } | Select-Object -Unique) -join "; ") }
    $run = { param($Id) $script:SelectedChecks -contains $Id }
    if (& $run "0") { Test-Placement $Lane; Test-TokenShape $Lane }
    if ($Lane.Hello) {
        if (& $run "1") { Test-SendInput $Lane }
        if (& $run "2") { Test-ScreenRead $Lane "capture" "2 BitBlt screen capture contains the owner window's colour" }
        if (& $run "3") { Test-ScreenRead $Lane "duplicate" "3 Desktop Duplication contains the owner window's colour" }
        if (& $run "4") { Test-KeyboardHook $Lane }
        if (& $run "5") { Test-PostMessage $Lane }
        if (& $run "6") { Test-UserObjects $Lane }
        if (& $run "7") { Test-AttachBoundary $Lane }
        if (& $run "R") { Test-Residual $Lane }
    } elseif (@($script:SelectedChecks | Where-Object { $_ -ne "0" }).Count) {
        Add-Row $Lane "1-6 checks" "" "not run: $($Lane.Problem)" "INCONCLUSIVE"
    }
    foreach ($id in $CheckNames.Keys) {
        if (-not (& $run $id)) { Add-Row $Lane $CheckNames[$id] "" "not run: left out by -Checks" "NOT RUN" }
    }
    if ($Lane.Problem) {
        foreach ($row in $Lane.Rows) {
            if ($row.verdict -in "PASS", "DENIED") { $row.verdict = "INCONCLUSIVE"; $row.tier += " [lane precondition not met: $($Lane.Problem)]" }
        }
    }
}
