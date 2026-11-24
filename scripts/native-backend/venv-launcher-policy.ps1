# The payload's py/venv-launcher component (#3897's fix for #3876): python.exe, python3.exe and
# pip.exe shims, built from shell-shims/venv-launcher, that resolve the file_tool tier's writable
# task venv through VIRTUAL_ENV ahead of the read-only agent-python-venv interpreter on PATH, and
# fall back to agent-python-venv when the tier's venv isn't there. Living in the read-only payload
# rather than in the tier-writable venv tree is the point: see shell-shims/README.md.

function Build-VenvLauncherShim {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
  )

  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "cargo not found on PATH: the venv-launcher shim is built from shell-shims"
  }
  $manifest = Join-Path $PSScriptRoot "shell-shims\venv-launcher\Cargo.toml"
  $targetDir = Join-Path $CacheRoot "venv-launcher-shim-target"
  & cargo build --manifest-path $manifest --target-dir $targetDir --release --locked | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "venv-launcher shim cargo build failed (exit $LASTEXITCODE)"
  }
  $binaries = @{}
  foreach ($name in @("python", "python3", "pip")) {
    $exe = Join-Path $targetDir "release\$name.exe"
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
      throw "venv-launcher shim build output is missing: $exe"
    }
    $binaries[$name] = $exe
  }
  return $binaries
}

# Stages the whole py/venv-launcher directory: it is replaced, never merged into, for the same
# reason Install-PinnedShell replaces shell/ whole - a file the previous build left (or a -Sign
# build signed in place) must not survive into this one.
function Install-VenvLauncherShim {
  param(
    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$Binaries,
    # The payload's py/ directory.
    [Parameter(Mandatory = $true)]
    [string]$PythonRoot
  )

  $destination = Join-Path $PythonRoot "venv-launcher"
  $staging = "$destination.staging"
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $staging | Out-Null
  try {
    foreach ($name in @("python", "python3", "pip")) {
      Copy-Item -LiteralPath $Binaries[$name] -Destination (Join-Path $staging "$name.exe")
    }
  } catch {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    throw
  }
  Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $staging -Destination $destination
  return $destination
}
