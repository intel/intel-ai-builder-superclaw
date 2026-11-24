#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [string]$LogPrefix = 'Clean'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$getLocalUser = Get-Command Get-LocalUser -ErrorAction SilentlyContinue
if (-not $getLocalUser) {
    throw "[$LogPrefix] Get-LocalUser is unavailable; refusing to remove credential state without checking tier accounts."
}

# The broker account-name mirror and its golden self-check are shared with the native-isolation
# scripts. A drifted copy would compute credential paths that do not exist, so every probe below
# would read as "genuinely gone" and this script would report a successful cleanup over leftover
# secrets.
. (Join-Path $PSScriptRoot '..\..\scripts\native-isolation\broker-account-name.ps1')
Assert-BrokerAccountNameMirror -LogPrefix $LogPrefix
. (Join-Path $PSScriptRoot 'elevation-log.ps1')

$ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$brokerAccountNames = @((Get-BrokerAccountNames -OwnerSid $ownerSid).Values)
$brokerExe = $env:SUPERCLAW_NATIVE_ISOLATION_BROKER
if (-not $brokerExe) {
    $brokerExe = Join-Path $RootDir 'host\native_isolation_broker\target\release\native_isolation_broker.exe'
}
if (-not (Test-Path -LiteralPath $brokerExe -PathType Leaf)) {
    throw "[$LogPrefix] Native isolation broker not found: $brokerExe. Build it before cleaning owner-by-tier state."
}
$brokerExe = (Resolve-Path -LiteralPath $brokerExe).Path
# No Authenticode check here. This script runs on a developer machine, where a locally built broker
# is unsigned and a `Valid` status could only come from a self-signed certificate the same user put
# in their own CurrentUser\Root. The check raised no bar against a same-user attacker (who can swap
# the file) and only made a clean rebuild impossible on a machine without a code-signing
# certificate (#2661). The UAC consent dialog still judges the binary and still has to be accepted.

# The identity records and their directory are SYSTEM/Administrators-only, so this non-elevated
# caller cannot enumerate broker state to decide whether there is anything to do.
# Revoke is idempotent: always let the elevated broker inspect and clean its own protected state.
Write-Host "[$LogPrefix] Revoking owner-by-tier identities with the native isolation broker (UAC required)..." -ForegroundColor Yellow
try {
    $process = Invoke-LoggedElevation -Op 'revoke' -LogPrefix $LogPrefix -Launch {
        Start-Process -FilePath $brokerExe -ArgumentList @('--revoke', '--owner-sid', $ownerSid) -Verb RunAs -Wait -PassThru
    }
} catch {
    throw "[$LogPrefix] Native isolation broker revoke was not started; runtime state was not deleted. $($_.Exception.Message)"
}
if ($process.ExitCode -ne 0) {
    # Revoke is best effort; the account/credential/profile probes below judge what actually remains.
    Write-Warning "[$LogPrefix] Native isolation broker revoke reported errors (exit $($process.ExitCode)); verifying remaining state."
}

$remainingBrokerAccounts = @(
    foreach ($accountName in $brokerAccountNames) {
        if (Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue) {
            $accountName
        }
    }
)
if ($remainingBrokerAccounts.Count -gt 0) {
    throw "[$LogPrefix] Native isolation broker revoke left account(s): $($remainingBrokerAccounts -join ', '); runtime state was not deleted."
}

# Credential blobs carry an owner read-only ACE, so this non-elevated caller can now check the
# derived credential paths directly instead of trusting the broker's exit code alone. A leftover
# blob would be an encrypted tier password for an account that no longer exists, so treat it as a
# failed cleanup. The identity records stay unreadable; only these paths can be probed.
#
# The probe distinguishes "absent" from "cannot tell". Reaching a credential by full path relies on
# bypass-traverse-checking, because the identity directory gives the owner no ACE; on an image that
# removes that privilege, a plain Test-Path would report a leftover blob as clean. An access denial
# is therefore an unverified result and fails the cleanup rather than passing it.
#
# Anything that answers at a credential path counts as leftover, whatever kind of object it is.
# Revoke is supposed to leave nothing there, so a directory or a reparse point standing where a
# credential used to be is a failed cleanup and not a pass; it is named in the failure because the
# operator's next step differs from the plain leftover-file case.
$identityStateDir = Join-Path $env:ProgramData 'SuperClaw\isolation\identities'
$remainingBrokerCredentials = @()
$unverifiableCredentials = @()
foreach ($accountName in $brokerAccountNames) {
    $credentialPath = Join-Path $identityStateDir "credential-$accountName.bin"
    try {
        $item = Get-Item -LiteralPath $credentialPath -Force -ErrorAction Stop
        if ($item.PSIsContainer) {
            $remainingBrokerCredentials += "$credentialPath (directory)"
        } elseif ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            $remainingBrokerCredentials += "$credentialPath (reparse point)"
        } else {
            $remainingBrokerCredentials += $credentialPath
        }
    } catch [System.Management.Automation.ItemNotFoundException] {
        # Genuinely gone, which is what revoke is supposed to produce.
    } catch {
        $unverifiableCredentials += "$credentialPath ($($_.Exception.GetType().Name))"
    }
}
if ($remainingBrokerCredentials.Count -gt 0) {
    throw "[$LogPrefix] Native isolation broker revoke left credential file(s): $($remainingBrokerCredentials -join ', '); runtime state was not deleted."
}
if ($unverifiableCredentials.Count -gt 0) {
    throw "[$LogPrefix] Could not determine whether the broker revoke removed credential file(s): $($unverifiableCredentials -join ', '); treat runtime state as not deleted."
}

# Revoke also deletes the Windows profiles tier accounts left behind, including the suffixed
# `<account>.<COMPUTERNAME>[.NNN]` folders earlier revoke cycles leaked. The accounts are confirmed
# gone above, so any profile still in a derived account's folder is one revoke failed to remove.
# Directories are scanned as well as registered profiles: Windows suffixes the next profile whenever
# the folder name is taken, whether or not a ProfileList entry still points at it.
$profileListKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
$profilesDir = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath $profileListKey).ProfilesDirectory)
$remainingBrokerProfiles = @(
    @(
        [System.IO.Directory]::GetDirectories($profilesDir)
        Get-CimInstance -ClassName Win32_UserProfile | Where-Object { $_.LocalPath } | ForEach-Object { $_.LocalPath }
    ) |
        Where-Object {
            $folder = Split-Path -Leaf $_
            @($brokerAccountNames | Where-Object { $folder -eq $_ -or $folder -like "$_.*" }).Count -gt 0
        } |
        Select-Object -Unique
)
if ($remainingBrokerProfiles.Count -gt 0) {
    throw "[$LogPrefix] Native isolation broker revoke left tier profile(s): $($remainingBrokerProfiles -join ', '); runtime state was not deleted."
}

# The marker is only a UAC-suppression hint, but leaving it after the protected identity state has
# been revoked makes the next launch skip the idempotent broker provision. Remove it only after the
# broker, account, credential, and profile probes above have all confirmed cleanup.
$ownerDigest = [System.Security.Cryptography.SHA256]::Create()
try {
    $ownerHash = $ownerDigest.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($ownerSid))
} finally {
    $ownerDigest.Dispose()
}
$ownerMarkerName = 'owner-' + (($ownerHash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 32) + '.json'
$ownerMarker = Join-Path $env:LOCALAPPDATA "SuperClaw\isolation\provisioned\$ownerMarkerName"
Remove-Item -LiteralPath $ownerMarker -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $ownerMarker) {
    throw "[$LogPrefix] Native isolation owner provision marker remains after revoke: $ownerMarker"
}
Write-Host "[$LogPrefix] Owner-by-tier identities revoked." -ForegroundColor Green

# Fixed tier accounts from the deleted pre-TL-P8 launch path can still exist on machines that ran an
# older build. Their removal never deleted the account profiles, so a profile can outlive its account.
$legacyAccountNames = @('SCBootstrapTier', 'SCFileToolTier', 'SCConnectorTier')
$legacyProfilePattern = '^(' + ($legacyAccountNames -join '|') + ')(\..+)?$'
$legacyStateDir = Join-Path $env:LOCALAPPDATA 'SuperClaw\opencode_sandbox'

function Get-LegacyTierResidue {
    @(
        foreach ($accountName in $legacyAccountNames) {
            if (Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue) {
                "account $accountName"
            }
        }
        foreach ($profileDir in [System.IO.Directory]::GetDirectories($profilesDir)) {
            if ((Split-Path -Leaf $profileDir) -match $legacyProfilePattern) {
                "profile directory $profileDir"
            }
        }
        foreach ($userProfile in @(Get-CimInstance -ClassName Win32_UserProfile)) {
            if ($userProfile.LocalPath -and (Split-Path -Leaf $userProfile.LocalPath) -match $legacyProfilePattern) {
                "profile $($userProfile.LocalPath) ($($userProfile.SID))"
            }
        }
    ) | Select-Object -Unique
}

$legacyResidue = @(Get-LegacyTierResidue)
if ($legacyResidue.Count -gt 0) {
    # Account and profile removal need elevation. The elevated command is built only from the
    # constant names above and re-derives the profiles itself, so nothing path-like crosses UAC.
    $elevatedCleanup = @"
`$ErrorActionPreference = 'Stop'
try {
    foreach (`$accountName in @('$($legacyAccountNames -join "','")')) {
        if (Get-LocalUser -Name `$accountName -ErrorAction SilentlyContinue) {
            Remove-LocalUser -Name `$accountName
        }
    }
    Get-CimInstance -ClassName Win32_UserProfile |
        Where-Object { `$_.LocalPath -and (Split-Path -Leaf `$_.LocalPath) -match '$legacyProfilePattern' } |
        Remove-CimInstance
    `$profilesDir = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath '$profileListKey').ProfilesDirectory)
    foreach (`$profileDir in [System.IO.Directory]::GetDirectories(`$profilesDir)) {
        if ((Split-Path -Leaf `$profileDir) -match '$legacyProfilePattern') {
            Remove-Item -LiteralPath `$profileDir -Recurse -Force
        }
    }
} catch {
    exit 1
}
exit 0
"@
    $encodedCleanup = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($elevatedCleanup))
    Write-Host "[$LogPrefix] Removing legacy fixed tier accounts and profiles (UAC required)..." -ForegroundColor Yellow
    try {
        $process = Invoke-LoggedElevation -Op 'legacy-tier-cleanup' -LogPrefix $LogPrefix -Launch {
            Start-Process -FilePath 'powershell.exe' `
                -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedCleanup) `
                -Verb RunAs -Wait -PassThru -WindowStyle Hidden
        }
    } catch {
        throw "[$LogPrefix] Legacy fixed tier account removal was not started; runtime state was not deleted. $($_.Exception.Message)"
    }
    if ($process.ExitCode -ne 0) {
        Write-Host "[$LogPrefix] Legacy fixed tier account removal exited $($process.ExitCode); checking what remains." -ForegroundColor Yellow
    }
}

# The legacy credential blobs live in the owner's own profile, so the owner deletes them unelevated.
$legacyStateDirError = ''
if (Test-Path -LiteralPath $legacyStateDir) {
    try {
        Remove-Item -LiteralPath $legacyStateDir -Recurse -Force
    } catch {
        $legacyStateDirError = " ($($_.Exception.Message))"
    }
}

$remainingLegacyResidue = @(Get-LegacyTierResidue)
if (Test-Path -LiteralPath $legacyStateDir) {
    $remainingLegacyResidue += "state directory $legacyStateDir$legacyStateDirError"
}
if ($remainingLegacyResidue.Count -gt 0) {
    throw ((@(
        "[$LogPrefix] Legacy fixed tier cleanup left residue; runtime state was not deleted:",
        ($remainingLegacyResidue | ForEach-Object { "  $_" }),
        'A profile that is still loaded cannot be deleted: sign out any session of that account, or reboot, and re-run.'
    ) -join [Environment]::NewLine))
}
if ($legacyResidue.Count -gt 0) {
    Write-Host "[$LogPrefix] Legacy fixed tier accounts and profiles removed." -ForegroundColor Green
}