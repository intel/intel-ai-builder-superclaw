#Requires -Version 5.1
# Mirrors native_isolation_broker `identity_name::account_name_for`. The broker owns that definition;
# this copy exists only so unelevated scripts can name the owner's tier accounts. Dot-source it and
# call Assert-BrokerAccountNameMirror before trusting any name it derives.

$script:BrokerTiers = @(
    @{ Tier = 'bootstrap'; Code = 'B'; Golden = 'SCBBZUMXK5U6MIU7VEA4' }
    @{ Tier = 'file_tool'; Code = 'F'; Golden = 'SCBFHEC353DKTS3MJ567' }
    @{ Tier = 'network_connector'; Code = 'C'; Golden = 'SCBCYNW6JFA3JGNEZI6S' }
    @{ Tier = 'channel'; Code = 'H'; Golden = 'SCBHFPHODFW2R7UVHRDE' }
)

function Get-BrokerAccountName {
    param(
        [Parameter(Mandatory = $true)][string]$OwnerSid,
        [Parameter(Mandatory = $true)][string]$Tier,
        [Parameter(Mandatory = $true)][char]$TierCode
    )

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digestInput = $OwnerSid + [char]0 + $Tier
        $digest = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($digestInput))
    } finally {
        $sha256.Dispose()
    }

    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    $encoded = New-Object System.Text.StringBuilder
    [uint64]$accumulator = 0
    $bits = 0
    foreach ($byte in $digest[0..9]) {
        $accumulator = ($accumulator -shl 8) -bor $byte
        $bits += 8
        while ($bits -ge 5) {
            $bits -= 5
            $index = [int](($accumulator -shr $bits) -band 0x1f)
            [void]$encoded.Append($alphabet[$index])
        }
        if ($bits -eq 0) {
            $accumulator = 0
        } else {
            $accumulator = $accumulator -band (([uint64]1 -shl $bits) - 1)
        }
    }
    "SCB$TierCode$encoded"
}

# Self-check the mirror against the golden vector pinned in the broker's `identity_name` tests and in
# `sandbox_manager.broker_client.identity`'s tests. A drifted copy would name accounts that do not
# exist, so every probe that relies on it would pass vacuously.
function Assert-BrokerAccountNameMirror {
    param([Parameter(Mandatory = $true)][string]$LogPrefix)

    $goldenOwnerSid = 'S-1-5-21-100-200-300-1001'
    foreach ($brokerTier in $script:BrokerTiers) {
        $derived = Get-BrokerAccountName -OwnerSid $goldenOwnerSid -Tier $brokerTier.Tier -TierCode $brokerTier.Code
        if ($derived -ne $brokerTier.Golden) {
            throw "[$LogPrefix] Broker account naming mirror has drifted: tier '$($brokerTier.Tier)' derived '$derived', expected '$($brokerTier.Golden)'. Refusing to use names the broker does not use."
        }
    }
}

# Tier name -> account name for one owner, in bootstrap, file_tool, network_connector, channel order.
function Get-BrokerAccountNames {
    param([Parameter(Mandatory = $true)][string]$OwnerSid)

    $names = [ordered]@{}
    foreach ($brokerTier in $script:BrokerTiers) {
        $names[$brokerTier.Tier] = Get-BrokerAccountName -OwnerSid $OwnerSid -Tier $brokerTier.Tier -TierCode $brokerTier.Code
    }
    $names
}
