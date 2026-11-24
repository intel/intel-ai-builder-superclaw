<#
.SYNOPSIS
  Manual gate for #3010: can a process running as a tier account obtain a role Job handle?

.DESCRIPTION
  Run as the owner, unelevated, while the installed app has its native roles running:

    powershell -NoProfile -ExecutionPolicy Bypass -File job_handle_probe.ps1 -Account <tier account>

  The driver reads that tier account's credential the way the owner-side launcher does (the
  owner-readable, machine-scoped DPAPI blob under %ProgramData%\SuperClaw\isolation\identities) and
  starts this same script in the tier account with CreateProcessWithLogonW, which is the product's own
  first hop. The probe half then plays a hostile role: for every process the driver names - each
  process running as the tier account, and each of their owner-side parents - it asks for
  PROCESS_DUP_HANDLE, walks the handle values, duplicates each one, and keeps those that answer a Job
  query. Nothing is modified: the only Job call made on a duplicated handle is a read.

  Deviation from the product path: the account name is an argument rather than derived, so this script
  does not become a second definition of the naming algorithm (identity_name::account_name_for). It
  imports nothing from the repository.

  Pass: zero duplicable Job handles, every owner-side launcher refuses PROCESS_DUP_HANDLE with access
  denied, and every runner and role was scanned in full. Exit 1 is a FAIL; exit 2 is INCONCLUSIVE,
  meaning some part of the scan could not be completed and nothing was proven either way.
#>
param(
    [Parameter(Mandatory = $true)][string]$Account,
    [ValidateSet("Driver", "Probe")][string]$Mode = "Driver",
    # Probe mode only: a file of `label:pid` lines written by the driver.
    [string]$Targets = "",
    [string]$Out = ""
)
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class JobProbe {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO { public int cb; public string r; public string d; public string t; public int x,y,xs,ys,xc,yc,fa,fl; public short sw, cb2; public IntPtr r2, i, o, e; }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)]
  public struct ACCT { public long a,b,c,d; public uint TotalPageFaults, TotalProcesses, ActiveProcesses, TotalTerminated; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CreateProcessWithLogonW(string user, string domain, string pwd, uint logonFlags, string app, System.Text.StringBuilder cmd, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool DuplicateHandle(IntPtr sp, IntPtr sh, IntPtr tp, out IntPtr th, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr job, int cls, ref ACCT info, int len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);

  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool result);

  const uint PROCESS_DUP_HANDLE = 0x40;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint DUPLICATE_SAME_ACCESS = 0x2;

  public const int OPEN_FAILED = -1;
  public const int MEMBER_UNAVAILABLE = -2;
  public const int MEMBERSHIP_QUERY_FAILED = -3;

  // 1 member, 0 not a member, -1 the query itself failed: an unanswered question is not a "no".
  static int Contains(IntPtr job, IntPtr process) {
    bool member;
    if (!IsProcessInJob(process, job, out member)) return -1;
    return member ? 1 : 0;
  }

  // The number of duplicated handles to the Job that manages the role: a Job containing the runner
  // (only the owner-held Job does), or, duplicated out of the runner itself, a Job containing the role
  // (the Job a runner creates). A Job the role made for itself or its children (Bun and Node both make
  // them) contains neither and is the role's own business, not a leak.
  //
  // Negative when the scan could not be completed, with the Win32 error in 'error': OPEN_FAILED when
  // `pid` cannot be opened for duplication, MEMBER_UNAVAILABLE when the runner or role cannot be opened
  // to ask membership against, MEMBERSHIP_QUERY_FAILED when a found Job could not be asked.
  public static int ManagingJobHandles(int pid, int runnerPid, int rolePid, out int error, out uint activeInFirst) {
    error = 0; activeInFirst = 0;
    IntPtr process = OpenProcess(PROCESS_DUP_HANDLE, false, pid);
    if (process == IntPtr.Zero) { error = Marshal.GetLastWin32Error(); return OPEN_FAILED; }
    IntPtr runner = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, runnerPid);
    if (runner == IntPtr.Zero) error = Marshal.GetLastWin32Error();
    IntPtr role = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, rolePid);
    if (role == IntPtr.Zero && error == 0) error = Marshal.GetLastWin32Error();
    int jobs = 0;
    try {
      if (runner == IntPtr.Zero || role == IntPtr.Zero) return MEMBER_UNAVAILABLE;
      for (long value = 4; value < 0x10000; value += 4) {
        IntPtr copy;
        if (!DuplicateHandle(process, new IntPtr(value), GetCurrentProcess(), out copy, 0, false, DUPLICATE_SAME_ACCESS)) continue;
        try {
          ACCT acct = new ACCT();
          if (!QueryInformationJobObject(copy, 1, ref acct, Marshal.SizeOf(typeof(ACCT)), IntPtr.Zero)) continue;
          int holdsRunner = Contains(copy, runner);
          int holdsRole = pid == runnerPid ? Contains(copy, role) : 0;
          if (holdsRunner < 0 || holdsRole < 0) { error = Marshal.GetLastWin32Error(); return MEMBERSHIP_QUERY_FAILED; }
          if (holdsRunner == 1 || holdsRole == 1) {
            if (jobs == 0) activeInFirst = acct.ActiveProcesses;
            jobs++;
          }
        } finally { CloseHandle(copy); }
      }
    } finally {
      CloseHandle(process);
      if (runner != IntPtr.Zero) CloseHandle(runner);
      if (role != IntPtr.Zero) CloseHandle(role);
    }
    return jobs;
  }
}
"@

if ($Mode -eq "Probe") {
    trap { "probe failed: $_ $($_.InvocationInfo.PositionMessage)" | Set-Content -Encoding utf8 "$Out.error"; exit 2 }
    $results = foreach ($entry in Get-Content $Targets) {
        $label, $pidText, $runnerText, $roleText = $entry.Split(":")
        $errorCode = 0; $active = [uint32]0
        $jobs = [JobProbe]::ManagingJobHandles([int]$pidText, [int]$runnerText, [int]$roleText, [ref]$errorCode, [ref]$active)
        $outcome = switch ($jobs) {
            ([JobProbe]::OPEN_FAILED) { "open_failed" }
            ([JobProbe]::MEMBER_UNAVAILABLE) { "membership_target_unavailable" }
            ([JobProbe]::MEMBERSHIP_QUERY_FAILED) { "membership_query_failed" }
            default { "scanned" }
        }
        # A descendant that exited after the driver's snapshot holds no handles; say so rather than
        # leaving an open failure to be read either way.
        if ($outcome -eq "open_failed" -and -not (Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue)) {
            $outcome = "exited"
        }
        [pscustomobject]@{
            target = $label; pid = [int]$pidText; runner_pid = [int]$runnerText; role_pid = [int]$roleText
            outcome = $outcome; error = $errorCode
            managing_job_handles = [math]::Max($jobs, 0); job_active_processes = $active
        }
    }
    $results | ConvertTo-Json -Compress | Set-Content -Encoding utf8 $Out
    return
}

# Driver: name each runner in the tier account, every process below it, and its owner-side parent.
# Ownership is asked only of launcher processes, because WMI's GetOwner costs a round trip each.
$processes = Get-CimInstance Win32_Process
$runners = @($processes | Where-Object { $_.Name -eq "native_isolation_launcher.exe" } | Where-Object {
    (Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue).User -eq $Account
})
if (-not $runners) { throw "no tier runner is running as $Account; start the app first" }
# Not `$targets`: PowerShell names are case-insensitive, and that one is the [string] parameter.
$named = [Collections.Generic.List[string]]::new()
foreach ($runner in $runners) {
    $role = $processes | Where-Object { $_.ParentProcessId -eq $runner.ProcessId -and $_.Name -ne "conhost.exe" } | Select-Object -First 1
    if (-not $role) { throw "runner $($runner.ProcessId) has no role process yet" }
    $tree = "$($runner.ProcessId):$($role.ProcessId)"
    $named.Add("owner_launcher:$($runner.ParentProcessId):$tree")
    $frontier = @($runner)
    while ($frontier) {
        $frontier | ForEach-Object { $named.Add("tier_$($_.Name):$($_.ProcessId):$tree") }
        $ids = @($frontier | ForEach-Object { $_.ProcessId })
        $frontier = @($processes | Where-Object { $ids -contains $_.ParentProcessId })
    }
}

$work = Join-Path $env:TEMP "superclaw-job-probe-$PID"
New-Item -ItemType Directory -Force $work | Out-Null
Copy-Item $PSCommandPath (Join-Path $work "probe.ps1")
$result = Join-Path $work "result.json"
$named | Select-Object -Unique | Set-Content -Encoding utf8 (Join-Path $work "targets.txt")
& icacls $work /grant "${Account}:(OI)(CI)M" | Out-Null

Add-Type -AssemblyName System.Security
$blob = [IO.File]::ReadAllBytes("$env:ProgramData\SuperClaw\isolation\identities\credential-$Account.bin")
$password = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($blob, $null, "LocalMachine"))
$startup = New-Object JobProbe+STARTUPINFO; $startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
$info = New-Object JobProbe+PROCESS_INFORMATION
$powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$command = New-Object Text.StringBuilder "`"$powershell`" -NoProfile -ExecutionPolicy Bypass -File `"$work\probe.ps1`" -Mode Probe -Account $Account -Targets `"$work\targets.txt`" -Out `"$result`""
# Logon flags 0 load no profile, so the tier account has no TEMP of its own; Add-Type needs one to
# compile the probe, so the block names the work directory.
$names = "SystemRoot", "windir", "SystemDrive", "ComSpec", "PATH", "PATHEXT", "PSModulePath", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"
$block = (($names | ForEach-Object { "$_=$([Environment]::GetEnvironmentVariable($_))" }) + "TEMP=$work", "TMP=$work") -join "`0"
$environment = [Runtime.InteropServices.Marshal]::StringToHGlobalUni("$block`0`0")
# CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, logon flags 0: the launcher's own first-hop creation.
$created = [JobProbe]::CreateProcessWithLogonW($Account, ".", $password, 0, $powershell, $command, 0x08000400, $environment, $work, [ref]$startup, [ref]$info)
$password = $null
if (-not $created) { throw "CreateProcessWithLogonW failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$deadline = (Get-Date).AddMinutes(2)
while (-not ((Test-Path $result) -or (Test-Path "$result.error")) -and (Get-Date) -lt $deadline) {
    if ([JobProbe]::WaitForSingleObject($info.hProcess, 250) -eq 0) { break }
}
Start-Sleep -Milliseconds 500
if (Test-Path "$result.error") { throw (Get-Content "$result.error" -Raw) }

# ConvertFrom-Json in Windows PowerShell emits a JSON array as one object; unroll it.
$rows = @(Get-Content $result -Raw | ConvertFrom-Json | ForEach-Object { $_ })
$rows | Format-Table -AutoSize | Out-String -Width 200
Remove-Item -Recurse -Force $work
$leaked = ($rows | Measure-Object managing_job_handles -Sum).Sum
$owners = @($rows | Where-Object target -eq "owner_launcher")
$tier = @($rows | Where-Object target -ne "owner_launcher")
# What a PASS requires, beyond finding nothing: every owner launcher refused this account outright
# (ERROR_ACCESS_DENIED, not a vanished process), and every tree's runner and role were scanned in full.
# Other descendants may have exited since the snapshot; an exited process holds no handles.
$ownerOpened = @($owners | Where-Object outcome -ne "open_failed").Count
$ownerUnclear = @($owners | Where-Object { $_.outcome -eq "open_failed" -and $_.error -ne 5 }).Count
$coreUnscanned = @($tier | Where-Object { ($_.pid -eq $_.runner_pid -or $_.pid -eq $_.role_pid) -and $_.outcome -ne "scanned" }).Count
$otherUnscanned = @($tier | Where-Object { $_.pid -ne $_.runner_pid -and $_.pid -ne $_.role_pid -and $_.outcome -notin "scanned", "exited" }).Count
if ($leaked -gt 0 -or $ownerOpened -gt 0) {
    "FAIL: $leaked handle(s) to a role's Job duplicable from $Account; $ownerOpened owner-side launcher(s) opened for duplication"
    exit 1
}
if ($ownerUnclear -gt 0 -or $coreUnscanned -gt 0 -or $otherUnscanned -gt 0 -or $owners.Count -eq 0) {
    "INCONCLUSIVE: $ownerUnclear owner launcher(s) refused with something other than access denied; $coreUnscanned runner/role and $otherUnscanned other target(s) could not be scanned. Rerun with the app idle."
    exit 2
}
"PASS: no handle to a role's Job is reachable from $Account, and every owner-side launcher refused it PROCESS_DUP_HANDLE with access denied"
