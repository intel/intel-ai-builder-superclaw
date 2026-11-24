# Payload identity (payload_version) assignment for native-backend builds.
#
# A complete build with no explicit -PayloadVersion derives its identity from
# git: the HEAD commit, plus a `.dirty.<nonce>` suffix when the worktree carries
# uncommitted changes so the immutable governed staging root cannot reuse bytes
# from an earlier build at the same commit. A partial (-Skip*) build always gets
# a `.partial.<nonce>` suffix for the same reason, clean worktree or not.
#
# Why this lives in its own file with its own git plumbing: the dirty check
# scans the whole worktree (the payload is built from trees all over the repo),
# so it walks directories that have nothing to do with the payload. Git itself
# only *warns* about a directory it cannot read and still exits 0 -
# "warning: could not open directory 'x/': Permission denied" - but Windows
# PowerShell with $ErrorActionPreference = "Stop" promotes any stderr byte from
# a native command to a terminating error. That turned a stray cache directory
# with a broken ACL somewhere under the repo root into a hard build failure,
# rethrown from the managed-payload-mutation rollback site so the message named
# neither git nor the unreadable directory. Running git through
# System.Diagnostics.Process keeps stdout, stderr and the exit code separate, so
# this file decides what is fatal instead of the host's stderr policy:
#   * unreadable paths are reported and skipped - they cannot make a payload
#     dirty, because bytes the build cannot read are bytes it cannot ship;
#   * a non-zero git exit is fatal, with git's own diagnostics in the message.

function Format-GitCommandArgument {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Value
  )

  if ($Value.Contains('"')) {
    throw "git argument may not contain a double quote: $Value"
  }
  if ($Value -eq "" -or $Value -match '\s') {
    # Trailing backslashes have to be doubled or the last one escapes the closing
    # quote under CreateProcess argument parsing (e.g. a repo root of 'C:\').
    return '"' + ($Value -replace '(\\+)$', '$1$1') + '"'
  }
  return $Value
}

function Split-CommandOutputLines {
  param(
    [AllowEmptyString()]
    [AllowNull()]
    [string]$Text
  )

  if (-not $Text) { return @() }
  return @($Text -split "`r?`n" | Where-Object { $_ -ne "" })
}

function Invoke-GitForWorktree {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $git = @(
    Get-Command git -CommandType Application -ErrorAction SilentlyContinue
  ) | Select-Object -First 1
  if (-not $git) {
    throw "git not found on PATH; pass -PayloadVersion explicitly"
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $git.Source
  $startInfo.Arguments = (
    @(@("-C", $RepoRoot) + $Arguments | ForEach-Object {
      Format-GitCommandArgument -Value $_
    })
  ) -join " "
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = [System.Diagnostics.Process]::Start($startInfo)
  try {
    # Read stderr asynchronously: a synchronous read of one stream can deadlock
    # against a full pipe buffer on the other.
    $standardError = $process.StandardError.ReadToEndAsync()
    $standardOutput = $process.StandardOutput.ReadToEnd()
    $errorText = $standardError.GetAwaiter().GetResult()
    $process.WaitForExit()
    return [pscustomobject]@{
      ExitCode = $process.ExitCode
      StdOutLines = @(Split-CommandOutputLines -Text $standardOutput)
      StdErrLines = @(Split-CommandOutputLines -Text $errorText)
    }
  } finally {
    $process.Dispose()
  }
}

function Test-GitUnreadablePathDiagnostic {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Line
  )

  return [bool]($Line -match '^warning: (could not open directory|unable to access|could not open file) ')
}

function Get-PayloadWorktreeStatus {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot
  )

  $result = Invoke-GitForWorktree `
    -RepoRoot $RepoRoot `
    -Arguments @("status", "--porcelain=v1", "--untracked-files=all")
  if ($result.ExitCode -ne 0) {
    $detail = if ($result.StdErrLines.Count -gt 0) {
      $result.StdErrLines -join "; "
    } else {
      "no diagnostics"
    }
    throw (
      "could not inspect git worktree state under '$RepoRoot' " +
      "(git status exit $($result.ExitCode)): $detail"
    )
  }
  return [pscustomobject]@{
    ChangedEntries = @($result.StdOutLines)
    UnreadablePathDiagnostics = @(
      $result.StdErrLines | Where-Object {
        Test-GitUnreadablePathDiagnostic -Line $_
      }
    )
    OtherDiagnostics = @(
      $result.StdErrLines | Where-Object {
        -not (Test-GitUnreadablePathDiagnostic -Line $_)
      }
    )
  }
}

# A partial build keeps members an earlier build produced, so no base version -
# HEAD or one the caller passed - describes its bytes. The nonce also keeps it
# out of the governed staging root of any earlier build.
function Add-PartialPayloadSuffix {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Version
  )

  $nonce = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmssfff")
  $partial = "$Version.partial.$nonce"
  Write-Host "note: partial development payload uses unique identity $partial" -ForegroundColor Yellow
  return $partial
}

function Get-NativePayloadVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [Parameter(Mandatory = $true)]
    [bool]$DevelopmentPayloadIdentity,
    [bool]$PartialPayload = $false
  )

  $head = Invoke-GitForWorktree `
    -RepoRoot $RepoRoot `
    -Arguments @("rev-parse", "--verify", "HEAD")
  $version = if ($head.StdOutLines.Count -gt 0) {
    $head.StdOutLines[0].Trim()
  } else {
    ""
  }
  if ($head.ExitCode -ne 0 -or -not $version) {
    throw "could not resolve payload version from git; pass -PayloadVersion explicitly"
  }
  if ($PartialPayload) {
    return Add-PartialPayloadSuffix -Version $version
  }

  $status = Get-PayloadWorktreeStatus -RepoRoot $RepoRoot
  foreach ($diagnostic in $status.UnreadablePathDiagnostics) {
    Write-Host (
      "note: skipping a path the build cannot read while checking worktree " +
      "state ($diagnostic); an unreadable path cannot change the payload identity"
    ) -ForegroundColor Yellow
  }
  foreach ($diagnostic in $status.OtherDiagnostics) {
    Write-Host "note: git status: $diagnostic" -ForegroundColor Yellow
  }
  if ($status.ChangedEntries.Count -eq 0) {
    return $version
  }

  if (-not $DevelopmentPayloadIdentity) {
    throw (
      "refusing to assign a release payload identity to a dirty worktree; " +
      "pass -DevelopmentPayloadIdentity for a local build, or commit the changes"
    )
  }
  $nonce = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmssfff")
  $version = "$version.dirty.$nonce"
  Write-Host "note: dirty development payload uses unique identity $version" -ForegroundColor Yellow
  return $version
}
