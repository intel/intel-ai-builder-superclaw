<#
.SYNOPSIS
Per-step build timing helper, dot-sourced by the build scripts.

.DESCRIPTION
The build fans out across processes: build-superclaw.ps1 spawns each top-level
step as a child `powershell -File ...`, and build-servicehub.ps1 spawns the four
child bundles as background jobs (separate processes again). In-memory
accumulation therefore cannot work -- every process records its own rows and the
root script aggregates them at the end.

`superclaw_services.spec` records rows too, in the `pyinstaller` scope: the merged
bundle is ONE PyInstaller run, so the phases inside it (per-service hiddenimport
collection, Analysis, PYZ, EXE, COLLECT) are the only per-service and per-phase
boundaries that still exist anywhere. It writes the same JSON row shape from
Python; see `_PhaseTimer` there.

Each row is written as its own small JSON file. That is deliberate: several
processes record concurrently, and one-file-per-row needs no cross-process
locking, whereas appending to a shared file does not guarantee atomicity on
Windows.

Recording is opt-in via the SUPERCLAW_BUILD_TIMING_DIR environment variable,
which build-superclaw.ps1 sets and child processes inherit. When the variable is
absent -- e.g. someone runs build-security-manager.ps1 directly -- every
function here is a no-op, so standalone invocation is unaffected.

Timing must never break a build, so recording failures are swallowed with a note
rather than raised.
#>

Set-StrictMode -Off

function Initialize-BuildTiming {
    <#
    .SYNOPSIS
    Create the timing directory and publish it to child processes.

    .DESCRIPTION
    Called once by the root build script. If SUPERCLAW_BUILD_TIMING_DIR is
    already set, the existing value is kept so a nested build (or a caller that
    wants to aggregate several runs into one directory) is not overridden.

    .OUTPUTS
    The timing directory path, or $null when timing could not be initialized.
    #>
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [string]$RunLabel = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($env:SUPERCLAW_BUILD_TIMING_DIR)) {
        return $env:SUPERCLAW_BUILD_TIMING_DIR
    }

    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $leaf  = if ([string]::IsNullOrWhiteSpace($RunLabel)) { $stamp } else { "$stamp-$RunLabel" }
    $dir   = Join-Path $RepoRoot "build\_timing\$leaf"

    try {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    } catch {
        Write-Host "  [timing] disabled: cannot create $dir ($($_.Exception.Message))" -ForegroundColor DarkGray
        return $null
    }

    $env:SUPERCLAW_BUILD_TIMING_DIR = $dir
    return $dir
}

function Write-BuildTiming {
    <#
    .SYNOPSIS
    Record one completed build step.

    .PARAMETER Label
    Step name as it should appear in the summary table.

    .PARAMETER Start
    When the step began. Callers keep this from before the work started.

    .PARAMETER End
    When the step finished. Defaults to now.

    .PARAMETER Scope
    Which script recorded the row, used to group the summary.

    .PARAMETER Status
    'ok' or 'failed'. Failed steps still get a row so a crashed build is
    diagnosable.
    #>
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][datetime]$Start,
        [datetime]$End = (Get-Date),
        [string]$Scope = 'build',
        [ValidateSet('ok', 'failed')][string]$Status = 'ok'
    )

    $dir = $env:SUPERCLAW_BUILD_TIMING_DIR
    if ([string]::IsNullOrWhiteSpace($dir)) { return }

    try {
        if (-not (Test-Path $dir)) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        $startUtc = $Start.ToUniversalTime()
        $record = [ordered]@{
            label       = $Label
            scope       = $Scope
            status      = $Status
            processId   = $PID
            start       = $startUtc.ToString('o')
            end         = $End.ToUniversalTime().ToString('o')
            seconds     = [math]::Round(($End - $Start).TotalSeconds, 2)
        }
        $name = '{0:yyyyMMddTHHmmssfff}-{1}.json' -f $startUtc, [guid]::NewGuid().ToString('N').Substring(0, 8)
        [System.IO.File]::WriteAllText(
            (Join-Path $dir $name),
            ($record | ConvertTo-Json -Compress),
            [System.Text.Encoding]::UTF8
        )
    } catch {
        Write-Host "  [timing] could not record '$Label': $($_.Exception.Message)" -ForegroundColor DarkGray
    }
}

function Write-BuildTimingFromJob {
    <#
    .SYNOPSIS
    Record a background-job step using the job's own start/end timestamps.

    .DESCRIPTION
    Both wait loops observe job completion later than it happens: the
    build-servicehub loop blocks on each job in a fixed order, so a job that
    finished early is only noticed after a slower predecessor returns, and the
    build-superclaw loop polls on a 2 s interval. Reading the clock at
    observation time would therefore inflate durations. PowerShell records
    PSBeginTime/PSEndTime on the job itself, which is immune to both effects.

    .PARAMETER FallbackStart
    Used when the job never reported PSBeginTime (it failed to start).
    #>
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][object]$Job,
        [Parameter(Mandatory)][datetime]$FallbackStart,
        [string]$Scope = 'build',
        [ValidateSet('ok', 'failed')][string]$Status = 'ok'
    )

    $start = if ($Job.PSBeginTime) { [datetime]$Job.PSBeginTime } else { $FallbackStart }
    $end   = if ($Job.PSEndTime)   { [datetime]$Job.PSEndTime   } else { Get-Date }
    Write-BuildTiming -Label $Label -Start $start -End $end -Scope $Scope -Status $Status
}

function ConvertTo-BuildTimingUtc {
    <#
    .SYNOPSIS
    Parse a recorded ISO-8601 timestamp back to an unambiguous UTC DateTime.

    .DESCRIPTION
    Rows are written with DateTime.ToString('o') on a UTC value, so the string
    carries a 'Z' suffix. A plain [datetime] cast silently converts that to
    local time, which then compares wrong against other UTC values -- the
    offsets cancel out to a whole-timezone error. Parsing with AssumeUniversal +
    AdjustToUniversal keeps the value in UTC.
    #>
    param([Parameter(Mandatory)][string]$Text)

    return [datetime]::Parse(
        $Text,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::AssumeUniversal -bor
        [System.Globalization.DateTimeStyles]::AdjustToUniversal
    )
}

function Get-BuildTimingCoverage {
    <#
    .SYNOPSIS
    Total wall-clock seconds covered by at least one step (interval union).

    .DESCRIPTION
    Durations cannot simply be summed: steps run in parallel, and they also
    nest (a top-level step contains child bundles, which contain their
    PyInstaller run). Summing therefore double-counts. The union of intervals
    answers the question that actually matters -- how much of the build is
    explained by some instrumented step, and how much is still dark.
    #>
    param([Parameter(Mandatory)][object[]]$Rows)

    $intervals = @(
        $Rows | ForEach-Object {
            [pscustomobject]@{
                Start = ConvertTo-BuildTimingUtc -Text $_.start
                End   = ConvertTo-BuildTimingUtc -Text $_.end
            }
        } | Sort-Object Start
    )
    if ($intervals.Count -eq 0) { return 0.0 }

    $covered = 0.0
    $curStart = $intervals[0].Start
    $curEnd   = $intervals[0].End
    foreach ($iv in $intervals[1..($intervals.Count - 1)]) {
        if ($iv.Start -le $curEnd) {
            if ($iv.End -gt $curEnd) { $curEnd = $iv.End }
        } else {
            $covered += ($curEnd - $curStart).TotalSeconds
            $curStart = $iv.Start
            $curEnd   = $iv.End
        }
    }
    $covered += ($curEnd - $curStart).TotalSeconds
    return $covered
}

function Show-BuildTimingSummary {    <#
    .SYNOPSIS
    Aggregate every recorded row and print the per-step table.

    .DESCRIPTION
    Steps overlap because the build runs several of them in parallel, so summing
    durations would exceed wall clock. The table therefore reports each step's
    offset from the build start alongside its duration, and the footer compares
    the sum of durations against wall clock to make the achieved parallelism
    explicit.

    Also writes summary.json next to the rows so runs can be compared later.
    #>
    param(
        [Parameter(Mandatory)][string]$Dir,
        [Parameter(Mandatory)][datetime]$BuildStart,
        [datetime]$BuildEnd = (Get-Date)
    )

    if ([string]::IsNullOrWhiteSpace($Dir) -or -not (Test-Path $Dir)) { return }

    $rows = @()
    foreach ($file in Get-ChildItem -Path $Dir -Filter '*.json' -File -ErrorAction SilentlyContinue) {
        if ($file.Name -eq 'summary.json') { continue }
        try {
            $rows += (Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json)
        } catch {
            Write-Host "  [timing] skipping unreadable row $($file.Name)" -ForegroundColor DarkGray
        }
    }
    if ($rows.Count -eq 0) { return }

    $wall = [math]::Round(($BuildEnd - $BuildStart).TotalSeconds, 2)
    $buildStartUtc = $BuildStart.ToUniversalTime()
    $sorted = $rows | Sort-Object -Property { [double]$_.seconds } -Descending

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  Build step timing" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ("  wall clock: {0:N1}s  ({1:N1} min)" -f $wall, ($wall / 60.0)) -ForegroundColor White
    Write-Host "  scopes nest: superclaw > servicehub > pyinstaller, so durations overlap by design." -ForegroundColor DarkGray
    Write-Host ""
    Write-Host ("  {0,8}  {1,8}  {2,7}  {3,-11} {4}" -f 'start+s', 'seconds', '%wall', 'scope', 'step') -ForegroundColor DarkGray
    Write-Host ("  {0,8}  {1,8}  {2,7}  {3,-11} {4}" -f '-------', '-------', '-----', '-----', '----') -ForegroundColor DarkGray

    foreach ($row in $sorted) {
        $offset = [math]::Round(((ConvertTo-BuildTimingUtc -Text $row.start) - $buildStartUtc).TotalSeconds, 1)
        $share  = if ($wall -gt 0) { 100.0 * [double]$row.seconds / $wall } else { 0 }
        $color  = if ($row.status -ne 'ok') { 'Red' } elseif ($share -ge 25) { 'Yellow' } else { 'Gray' }
        $mark   = if ($row.status -ne 'ok') { ' [FAILED]' } else { '' }
        Write-Host ("  {0,8:N1}  {1,8:N1}  {2,6:N1}%  {3,-11} {4}{5}" -f `
            $offset, [double]$row.seconds, $share, $row.scope, $row.label, $mark) -ForegroundColor $color
    }

    $sum         = [math]::Round((($rows | Measure-Object -Property seconds -Sum).Sum), 2)
    $covered     = [math]::Round((Get-BuildTimingCoverage -Rows $rows), 2)
    $unaccounted = [math]::Round(($wall - $covered), 2)

    Write-Host ""
    Write-Host ("  covered by steps : {0,8:N1}s  ({1,5:N1}% of wall)" -f $covered, $(if ($wall -gt 0) { 100.0 * $covered / $wall } else { 0 })) -ForegroundColor DarkGray
    Write-Host ("  unaccounted      : {0,8:N1}s  <- not inside any instrumented step" -f $unaccounted) -ForegroundColor $(if ($unaccounted -gt 0.15 * $wall) { 'Yellow' } else { 'DarkGray' })
    Write-Host ("  sum of durations : {0,8:N1}s  (exceeds covered by {1:N1}s from parallelism + nesting)" -f $sum, ($sum - $covered)) -ForegroundColor DarkGray
    Write-Host ("  rows: {0}  dir: {1}" -f $rows.Count, $Dir) -ForegroundColor DarkGray

    try {
        $summary = [ordered]@{
            buildStart         = $buildStartUtc.ToString('o')
            buildEnd           = $BuildEnd.ToUniversalTime().ToString('o')
            wallSeconds        = $wall
            coveredSeconds     = $covered
            unaccountedSeconds = $unaccounted
            sumStepSeconds     = $sum
            steps              = @($sorted | ForEach-Object {
                [ordered]@{
                    label   = $_.label
                    scope   = $_.scope
                    status  = $_.status
                    seconds = [double]$_.seconds
                    offset  = [math]::Round(((ConvertTo-BuildTimingUtc -Text $_.start) - $buildStartUtc).TotalSeconds, 1)
                }
            })
        }
        [System.IO.File]::WriteAllText(
            (Join-Path $Dir 'summary.json'),
            ($summary | ConvertTo-Json -Depth 5),
            [System.Text.Encoding]::UTF8
        )
    } catch {
        Write-Host "  [timing] could not write summary.json: $($_.Exception.Message)" -ForegroundColor DarkGray
    }
}
