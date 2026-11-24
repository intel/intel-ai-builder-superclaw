# Shared packaging gate for the Windows-native backend payload.
#
# Dot-source this from any build script that is about to package or hand off the
# payload. It delegates to sandbox_manager.payload_integrity — the same code the
# runtime runs before starting the backend — so packaging and runtime can never
# disagree about what a valid payload is.

$NativePayloadToolsRoot = $PSScriptRoot

function Assert-NativeBackendPayload {
    param(
        [Parameter(Mandatory = $true)][string]$PayloadRoot,
        [Parameter(Mandatory = $true)][string]$Label,
        [ValidateSet("minimal", "full", "full-hdr")][string]$Grade = "minimal",
        # uv is used here only to run the verifier against host\sandbox_manager's
        # environment, not to stage the payload. A caller that has already resolved
        # the pinned uv passes it so that a machine with no uv at all can still
        # verify what it just built; anyone else keeps using the uv on PATH.
        [string]$UvPath = ""
    )

    if (-not (Test-Path -LiteralPath $PayloadRoot -PathType Container)) {
        throw "[$Label] Native backend payload not found at $PayloadRoot. Build it with: powershell -ExecutionPolicy Bypass -File scripts\native-backend\build-native-backend.ps1"
    }

    # uv run --directory host\sandbox_manager sets Python's cwd to sandbox_manager, so a
    # relative PayloadRoot would resolve under that tree instead of the caller's cwd.
    $fullPayloadRoot = (Resolve-Path -LiteralPath $PayloadRoot).Path

    $repoRoot = (Resolve-Path (Join-Path $NativePayloadToolsRoot '..\..')).Path
    $verifier = Join-Path $NativePayloadToolsRoot 'verify_native_payload.py'
    $sandboxManagerDir = Join-Path $repoRoot 'host\sandbox_manager'

    if ($UvPath -and -not (Test-Path -LiteralPath $UvPath -PathType Leaf)) {
        throw "[$Label] the supplied uv does not exist: $UvPath"
    }
    # PATH first, deliberately. This uv only runs host\sandbox_manager's own
    # environment, which is the developer's uv's day job; using the payload's
    # pinned uv here instead would let two uv versions take turns re-syncing
    # host\.venv. The pinned copy is the fallback that keeps a machine with no uv
    # at all from failing right after it successfully built a payload.
    $pathUv = Get-Command uv -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($pathUv) {
        $uv = $pathUv.Source
    } elseif ($UvPath) {
        $uv = $UvPath
        Write-Host "[$Label] no uv on PATH; verifying with the build's provisioned uv: $uv" -ForegroundColor Yellow
    } else {
        throw "[$Label] uv was not found on PATH and no uv was supplied; cannot verify the native backend payload."
    }

    Write-Host "[$Label] Verifying native backend payload ($Grade): $fullPayloadRoot" -ForegroundColor Cyan

    # --verify-manifest is what makes this the runtime's own check rather than a
    # shape check: without it nothing compares the payload's bytes to manifest.json,
    # and the post-signing gate cannot see that signing grew an executable.
    # Runtime import probes are the build's job, not this gate's - the packaging
    # callers run it up to four times per build.
    $verifierArguments = @(
        $fullPayloadRoot,
        '--verify-manifest',
        '--grade', $Grade,
        '--skip-runtime-probes'
    )

    # uv writes resolution progress to stderr, which the callers' 'Stop' preference
    # would turn into a terminating NativeCommandError before $LASTEXITCODE is read.
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $uv run --directory $sandboxManagerDir python $verifier @verifierArguments
    } finally {
        $ErrorActionPreference = $prevPref
    }
    if ($LASTEXITCODE -ne 0) {
        throw "[$Label] Native backend payload at $fullPayloadRoot failed integrity verification (exit $LASTEXITCODE). Refusing to package a backend the runtime would reject at startup."
    }

    Write-Host "[$Label] Native backend payload verified." -ForegroundColor Green
}
