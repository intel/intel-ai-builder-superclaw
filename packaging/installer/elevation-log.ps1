#Requires -Version 5.1
# One log line before and one after each UAC elevation. The line and outcome grammar is defined in
# host/sandbox_manager/src/sandbox_manager/broker_client/elevation_log.py:
#
#   [<prefix>] elevation: op=<op> event=begin
#   [<prefix>] elevation: op=<op> event=end outcome=<outcome> started_at=<UTC ISO 8601> wall_ms=<n>
#
# `Start-Process -Wait` returns only after the elevated process has exited, so there is no consent/work split.
# Neither line carries a path, an argument list or a SID.

$script:ErrorCancelled = 1223

function Get-ElevationOutcome {
    param(
        [int]$ExitCode,
        [System.Exception]$Exception
    )
    if ($Exception) {
        if ($Exception -is [ComponentModel.Win32Exception]) {
            if ($Exception.NativeErrorCode -eq $script:ErrorCancelled) {
                return 'cancelled_by_user'
            }
            return "failed:win32_$($Exception.NativeErrorCode)"
        }
        # Start-Process keeps only the Win32 message text, so for it that text is all that identifies 1223.
        $dismissed = ([ComponentModel.Win32Exception]::new($script:ErrorCancelled)).Message
        if ($Exception.Message.Contains($dismissed)) {
            return 'cancelled_by_user'
        }
        return "failed:$($Exception.GetType().Name)"
    }
    if ($ExitCode -eq 0) {
        return 'succeeded'
    }
    return "failed:exit_$ExitCode"
}

function Format-ElevationEndLine {
    param(
        [Parameter(Mandatory = $true)][string]$LogPrefix,
        [Parameter(Mandatory = $true)][string]$Op,
        [Parameter(Mandatory = $true)][string]$Outcome,
        [Parameter(Mandatory = $true)][DateTime]$StartedAt,
        [Parameter(Mandatory = $true)][TimeSpan]$Wall
    )
    $started = $StartedAt.ToUniversalTime().ToString(
        "yyyy-MM-dd'T'HH:mm:ss.fff'+00:00'",
        [Globalization.CultureInfo]::InvariantCulture
    )
    $wallMs = [long][Math]::Round($Wall.TotalMilliseconds)
    "[$LogPrefix] elevation: op=$Op event=end outcome=$Outcome started_at=$started wall_ms=$wallMs"
}

# Runs $Launch, which must return the `Start-Process -PassThru` process, and returns it unchanged.
# Whatever $Launch throws is rethrown unchanged after the end line.
function Invoke-LoggedElevation {
    param(
        [Parameter(Mandatory = $true)][string]$Op,
        [Parameter(Mandatory = $true)][string]$LogPrefix,
        [Parameter(Mandatory = $true)][scriptblock]$Launch
    )
    Write-Host "[$LogPrefix] elevation: op=$Op event=begin"
    $startedAt = [DateTime]::UtcNow
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $process = & $Launch
    } catch {
        $stopwatch.Stop()
        Write-Host (Format-ElevationEndLine -LogPrefix $LogPrefix -Op $Op `
                -Outcome (Get-ElevationOutcome -Exception $_.Exception) -StartedAt $startedAt -Wall $stopwatch.Elapsed)
        throw
    }
    $stopwatch.Stop()
    Write-Host (Format-ElevationEndLine -LogPrefix $LogPrefix -Op $Op `
            -Outcome (Get-ElevationOutcome -ExitCode $process.ExitCode) -StartedAt $startedAt -Wall $stopwatch.Elapsed)
    $process
}
