# Non-elevated test: only the unique temporary fixture's ACL is changed.
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('sc-readonly-copy-' + [guid]::NewGuid().ToString('N'))
$source = Join-Path $root 'source'
$oldEnv = $env:SC_TEST_READONLY_COPY_ROOT
$originalAcl = $null
try {
    [IO.Directory]::CreateDirectory((Join-Path $source 'nested')) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $source 'empty')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $source 'nested\index.js'), '// readonly dependency')
    [IO.File]::SetAttributes((Join-Path $source 'nested\index.js'), [IO.FileAttributes]::ReadOnly)
    # Capture only access rules. Restoring a whole Get-Acl object can request
    # owner/audit changes and SeSecurityPrivilege even though this test owns the directory.
    $accessSection = [Security.AccessControl.AccessControlSections]::Access
    $savedAccess = [IO.Directory]::GetAccessControl($source, $accessSection).GetSecurityDescriptorSddlForm($accessSection)
    $originalAcl = New-Object Security.AccessControl.DirectorySecurity
    $originalAcl.SetSecurityDescriptorSddlForm($savedAccess, $accessSection)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $sid, [Security.AccessControl.FileSystemRights]'ReadAndExecute,Synchronize',
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $source -AclObject $acl
    $env:SC_TEST_READONLY_COPY_ROOT = $root
    & bun test (Join-Path $PSScriptRoot 'profile-copy-readonly.test.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Read-only Profile copy test failed' }
    & bun test (Join-Path $PSScriptRoot '..\..\server\test\tokens-readonly-config.test.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Read-only config token storage test failed' }
} finally {
    $env:SC_TEST_READONLY_COPY_ROOT = $oldEnv
    if ($null -ne $originalAcl) { [IO.Directory]::SetAccessControl($source, $originalAcl) }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
    if (Test-Path -LiteralPath $root) { throw "Test cleanup failed: $root" }
    Write-Host 'READONLY_COPY_CLEANUP=passed'
}