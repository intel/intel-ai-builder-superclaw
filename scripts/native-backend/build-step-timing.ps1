# Labeled step timing for the Windows-native payload build.
#
# Write-BuildTiming (packaging\installer\build-timing.ps1) only drops a JSON row
# into SUPERCLAW_BUILD_TIMING_DIR, which the top-level installer build aggregates
# at the end. A direct `build-native-backend.ps1` run therefore printed nothing
# per step, and a stage that took minutes looked like a silent gap in the log
# with no way to tell from the log alone what had consumed the time. Print the
# duration as well, so every wrapped step is attributable either way.

function Invoke-NativeTimedStep {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )

  $started = Get-Date
  $status = "ok"
  try {
    & $Action
  } catch {
    $status = "failed"
    throw
  } finally {
    $ended = Get-Date
    # The log-format contract is dot-decimal regardless of the host's locale, so
    # this must not go through the current-culture N1 formatter: a comma-decimal
    # locale would print "12,3s" and break anything parsing the log.
    $durationSeconds = ($ended - $started).TotalSeconds.ToString(
      "F1",
      [System.Globalization.CultureInfo]::InvariantCulture)
    Write-Host (
      "  [step] {0}: {1}s ({2})" -f $Label, $durationSeconds, $status
    ) -ForegroundColor DarkGray
    if (Get-Command Write-BuildTiming -ErrorAction SilentlyContinue) {
      Write-BuildTiming `
        -Label $Label `
        -Start $started `
        -End $ended `
        -Scope "native-payload" `
        -Status $status
    }
  }
}
