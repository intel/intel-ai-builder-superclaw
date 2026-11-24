# Authenticode signing for the native backend payload.
#
# Ordering contract: sign BEFORE Write-CanonicalPayloadManifest runs.
#
# The .aip's DigitalSignature row carries SignOptions="7", whose "inner files" bit
# makes Advanced Installer sign the unsigned executables it packages. A signature
# appends ~10 KB to a PE, so a payload signed after its manifest was written ships
# a manifest that no longer describes it, and verify_payload() then refuses to
# spawn the backend with payload_size_mismatch. Signing here keeps the manifest
# describing the bytes that actually ship; Advanced Installer leaves these files
# alone afterwards because they are already signed.
#
# Scope is .exe only, which is what Advanced Installer actually touches: the
# payload's .node PE files come through a signed installer build unmodified.

function Format-PayloadSigningCandidate {
    param([Parameter(Mandatory = $true)]$Certificate)
    return "  $($Certificate.Thumbprint)  $($Certificate.Subject)  (expires $($Certificate.NotAfter.ToString('yyyy-MM-dd')))"
}

function Get-PayloadSigningCertificate {
    # Mirrors Test-CodeSigningCertPresent in packaging\installer\advinst\build-installer.ps1
    # and the .aip's Store="User\MY", which is CurrentUser\My.
    #
    # Selection is explicit on purpose. This used to be `Select-Object -First 1` over
    # "has a private key and either declares the code-signing EKU or declares no EKU
    # at all", which had two failure modes: a certificate with no EKU is not a
    # code-signing certificate and had no business being eligible, and on a machine
    # carrying several candidates (a dev box accumulates them) the first one silently
    # won and a Release payload could ship signed by the wrong identity. Ambiguity is
    # now a build error naming the candidates instead of a coin flip.
    param(
        [string]$Thumbprint,
        [string]$Subject
    )
    $codeSigningOid = '1.3.6.1.5.5.7.3.3'
    $candidates = @(
        Get-ChildItem -Path Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
            Where-Object {
                $_.HasPrivateKey -and
                $_.EnhancedKeyUsageList -and
                ($_.EnhancedKeyUsageList.ObjectId -contains $codeSigningOid)
            } |
            Sort-Object -Property Thumbprint
    )
    if ($candidates.Count -eq 0) {
        if ($Thumbprint -or $Subject) {
            throw (
                'payload signing was asked for a specific certificate but ' +
                'Cert:\CurrentUser\My holds no certificate with a private key and ' +
                'the code signing EKU (1.3.6.1.5.5.7.3.3)'
            )
        }
        # No certificate at all, and none was named: not an error. Requiring one made
        # `build-superclaw.ps1 -Sign` unbuildable on a machine that never created a dev
        # certificate (#2661), which is every machine but the one that set it up. The
        # caller decides what an unsigned payload means for its configuration.
        return $null
    }

    if ($Thumbprint) {
        $wanted = ($Thumbprint -replace '[^0-9A-Fa-f]', '')
        $matched = @($candidates | Where-Object { $_.Thumbprint -eq $wanted })
        if ($matched.Count -ne 1) {
            throw (
                "payload signing certificate thumbprint '$Thumbprint' matched " +
                "$($matched.Count) certificates in Cert:\CurrentUser\My. Candidates:`n" +
                (($candidates | ForEach-Object { Format-PayloadSigningCandidate -Certificate $_ }) -join "`n")
            )
        }
        return $matched[0]
    }

    if ($Subject) {
        $matched = @($candidates | Where-Object { $_.Subject -eq $Subject })
        if ($matched.Count -ne 1) {
            throw (
                "payload signing certificate subject '$Subject' matched " +
                "$($matched.Count) certificates in Cert:\CurrentUser\My (the match is " +
                "an exact Subject comparison). Candidates:`n" +
                (($candidates | ForEach-Object { Format-PayloadSigningCandidate -Certificate $_ }) -join "`n")
            )
        }
        return $matched[0]
    }

    if ($candidates.Count -gt 1) {
        throw (
            "payload signing found $($candidates.Count) code signing certificates in " +
            "Cert:\CurrentUser\My and will not guess. Pass " +
            "-SigningCertificateThumbprint (or -SigningCertificateSubject) to " +
            "build-native-backend.ps1 / build-superclaw.ps1. Candidates:`n" +
            (($candidates | ForEach-Object { Format-PayloadSigningCandidate -Certificate $_ }) -join "`n")
        )
    }
    return $candidates[0]
}

function Set-PayloadAuthenticodeSignature {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PayloadRoot,
        # Explicit certificate selector. Unset is only valid when the store holds
        # exactly one code-signing certificate; see Get-PayloadSigningCertificate.
        [string]$CertificateThumbprint,
        [string]$CertificateSubject,
        # Same timestamp authority as the .aip's DigitalSignature row.
        [string]$TimeStampUrl = 'http://timestamp.digicert.com'
    )

    if (-not (Test-Path -LiteralPath $PayloadRoot -PathType Container)) {
        throw "payload signing source is missing: $PayloadRoot"
    }
    $certificate = Get-PayloadSigningCertificate `
        -Thumbprint $CertificateThumbprint `
        -Subject $CertificateSubject
    if ($null -eq $certificate) {
        Write-Host (
            'payload signing skipped: no code signing certificate in Cert:\CurrentUser\My. ' +
            'The payload ships unsigned; the manifest below describes those unsigned bytes.'
        ) -ForegroundColor Yellow
        return
    }
    Write-Host (
        "payload signing certificate: $($certificate.Thumbprint) $($certificate.Subject)"
    )

    $newlySigned = 0
    $preSigned = 0
    $executables = @(
        Get-ChildItem -LiteralPath $PayloadRoot -Recurse -File -Filter '*.exe' |
            Sort-Object FullName
    )
    foreach ($executable in $executables) {
        if ((Get-AuthenticodeSignature -FilePath $executable.FullName).Status -eq 'Valid') {
            $preSigned++
            continue
        }
        $signature = Set-AuthenticodeSignature `
            -FilePath $executable.FullName `
            -Certificate $certificate `
            -HashAlgorithm SHA256 `
            -TimestampServer $TimeStampUrl `
            -ErrorAction Stop
        if ($signature.Status -ne 'Valid') {
            throw "payload signing failed for $($executable.FullName): $($signature.Status)"
        }
        $newlySigned++
    }

    if ($executables.Count -eq 0) {
        throw "payload signing found no executables under $PayloadRoot"
    }
    Write-Host (
        "ok: payload signed ($newlySigned newly signed, $preSigned already signed, " +
        "$($executables.Count) executables)"
    )
}
