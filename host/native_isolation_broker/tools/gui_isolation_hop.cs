// gui_isolation_hop.cs: the tier hop of tools/gui_isolation_acceptance.ps1 (#3499, #3400), compiled into the
// same manual verification image as gui_isolation_probe.cs. Not part of either product binary.
//
//   logon <account> <lane dir> wait|nowait <hop mode> [args...]
//       Owner side. Reads the tier account's credential the way the owner-side launcher does (the
//       owner-readable, machine-scoped DPAPI blob under %ProgramData%\SuperClaw\isolation\identities) and
//       starts this image as `hop <mode> <lane dir> [args...]` in that account with the product's first
//       hop: CreateProcessWithLogonW, logon flags 0, null lpDesktop, an explicit environment block.
//   hop discover <lane dir> <owner sid>
//       Tier side, on WinSta0 with the owner's logon SID, as the product bootstrap runs. Finds a live
//       product role of its own account on its private desktop (see Discover) and starts `serve` there the
//       way the bootstrap starts the supervisor: CreateProcessAsUserW with a CreateRestrictedToken copy of
//       its own primary token, the owner's logon SID kept enabled, no restricting SID, no privilege removed,
//       default DACL the tier account and SYSTEM, no inherited handle (#3805); the default DACL, logon SIDs
//       and restricting SID count are read back from that token into discovery.json. It creates no Job, so
//       the probe runs without the product's UI limits.
//   hop lookalike <lane dir> <owner sid>
//       Driver self-test only, never evidence: creates a station and desktop with the bootstrap's
//       descriptors (tier_desktop_policy.rs) in its own logon session, starts `serve` there the same way,
//       and reads its own probe back the way a real run reads a role.
//   hop reap <lane dir> <image path> <not-before FILETIME>
//       Cleanup: terminates this run's verification processes in that account, which the owner cannot open.
//
// The hop writes <lane dir>\discovery.json. It reads other processes of its own account and duplicates
// their handles only to name the window stations and desktops they hold; it changes nothing in them, and
// it reads a supervisor's command line only to test it, never to record it.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace GuiIsolation
{
    static class Hop
    {
        const string DesktopPrefix = "SuperClawTier-";
        static readonly string[] EnvironmentNames = { "SystemRoot", "windir", "SystemDrive", "ComSpec", "PATH", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE" };

        public static int Logon(string[] a)
        {
            if (a.Length < 5) { Console.Error.WriteLine("usage: logon <account> <lane dir> wait|nowait <hop mode> [args...]"); return 2; }
            string account = a[1], lane = a[2], exe = Self();
            var command = new StringBuilder(Quote(exe) + " hop " + a[4] + " " + Quote(lane));
            for (int i = 5; i < a.Length; i++) command.Append(' ').Append(Quote(a[i]));
            string credential = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                @"SuperClaw\isolation\identities", "credential-" + account + ".bin");
            byte[] plain = ProtectedData.Unprotect(File.ReadAllBytes(credential), null, DataProtectionScope.LocalMachine);
            char[] chars = Encoding.UTF8.GetChars(plain);
            Array.Clear(plain, 0, plain.Length);
            int bytes = (chars.Length + 1) * 2;
            IntPtr password = Marshal.AllocHGlobal(bytes);
            IntPtr environment = Marshal.StringToHGlobalUni(Block(lane));
            var info = new PROCESS_INFORMATION();
            bool created;
            int error;
            try
            {
                Marshal.Copy(chars, 0, password, chars.Length);
                Marshal.WriteInt16(password, chars.Length * 2, 0);
                Array.Clear(chars, 0, chars.Length);
                var startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                // CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, logon flags 0: the launcher's own first hop.
                created = HopNative.CreateProcessWithLogonW(account, ".", password, 0, exe, command, 0x08000400, environment, lane, ref startup, out info);
                error = created ? 0 : Marshal.GetLastWin32Error();
            }
            finally
            {
                Marshal.Copy(new byte[bytes], 0, password, bytes);
                Marshal.FreeHGlobal(password);
                Marshal.FreeHGlobal(environment);
            }
            if (!created) { Console.Error.WriteLine("CreateProcessWithLogonW failed: " + error); return 1; }
            Console.WriteLine("hop pid " + info.pid + " created " + Procs.Created(info.hProcess));
            int code = 0;
            if (a[3] == "wait")
            {
                uint exit;
                if (HopNative.WaitForSingleObject(info.hProcess, 180000) != 0) { Console.Error.WriteLine("the hop did not finish within 180 s"); code = 1; }
                else if (HopNative.GetExitCodeProcess(info.hProcess, out exit)) code = (int)exit;
            }
            Native.CloseHandle(info.hThread);
            Native.CloseHandle(info.hProcess);
            return code;
        }

        public static int Run(string[] a)
        {
            // SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX. It crosses
            // CreateProcessAsUserW, so a probe that cannot initialize on its desktop exits without a dialog.
            HopNative.SetErrorMode(0x8003);
            if (a[1] == "reap") return Reap(a[2], a[3], long.Parse(a[4]));
            string mode = a[1], lane = a[2], ownerSid = a[3];
            bool roleDesktopBoundary = a.Length == 5 && a[4] == "boundary";
            string result = Path.Combine(lane, "discovery.json");
            var j = new Json().Set("mode", mode).Set("hop_argv", string.Join("|", a))
             .Set("role_desktop_boundary_arg", roleDesktopBoundary).Merge(Identity.Describe(), "hop_");
            IntPtr station = IntPtr.Zero, desktop = IntPtr.Zero, process = IntPtr.Zero;
            try
            {
                string tierSid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
                bool lookalike = mode == "lookalike";
                string target = lookalike ? Lookalike(j, ownerSid, tierSid, out station, out desktop) : Discover(j, tierSid, false);
                if (target == null) { j.Write(result); return 3; }
                IntPtr token = Restricted(j, tierSid, roleDesktopBoundary);
                try { process = StartProbe(j, token, target, lane); }
                finally { Native.CloseHandle(token); }
                // A probe that cannot connect to its desktop dies in user32 initialization; say so here.
                uint exit;
                if (HopNative.WaitForSingleObject(process, 3000) == 0 && HopNative.GetExitCodeProcess(process, out exit))
                    j.Set("probe_exit", Json.Hex(exit));
                // The self-test has no role to read, so it reads its own probe the way a real run reads a role.
                if (lookalike)
                {
                    for (int waited = 0; waited < 15000 && !File.Exists(Path.Combine(lane, "hello.json")); waited += 250) System.Threading.Thread.Sleep(250);
                    Discover(j, tierSid, true);
                }
                j.Write(result);
                if (lookalike) HopNative.WaitForSingleObject(process, 3600000);
                return 0;
            }
            catch (Exception error)
            {
                j.Set("error", error.GetType().Name + ": " + error.Message).Write(result);
                return 1;
            }
            finally
            {
                if (process != IntPtr.Zero) Native.CloseHandle(process);
                if (desktop != IntPtr.Zero) Native.CloseDesktop(desktop);
                if (station != IntPtr.Zero) Native.CloseWindowStation(station);
            }
        }

        sealed class Seen
        {
            public uint Pid;
            public long Parent, Created;
            public string Image, Peb, Logon, PipeId = "", Kind = "other";
            public List<string> Stations, Desktops;
            public bool Placed;
        }

        // Every live process of this account except the hop and what the hop itself created (its console
        // host; the probe comes later), each matched by parent pid and a creation time after the hop's; or,
        // for the self-test, the probes only, a name filter that runs before anything is opened. Each is
        // classified: a supervisor is the launcher image in <payload root>\native-isolation running
        // --tier-runner; a role is a direct child of a supervisor (created after it, pid reuse excluded)
        // whose image lies under that supervisor's payload root; a descendant has a supervisor or role among
        // its ancestors; anything else is other. A process is "placed" when its DesktopInfo is exactly the
        // one station and desktop it holds handles to; a supervisor or role must also be on
        // SuperClawTier-<its pipe id>, and a role on its supervisor's desktop. The target is the first such
        // role; without one there is no target. Every remaining process counts for the WinSta0 rule.
        static string Discover(Json j, string tierSid, bool probes)
        {
            uint me = Native.GetCurrentProcessId();
            long meCreated = Procs.Created(Native.GetCurrentProcess());
            var seen = new List<Seen>();
            int excluded = 0;
            foreach (Process candidate in Process.GetProcesses())
            {
                uint pid = (uint)candidate.Id;
                if (pid == me || pid <= 4 || (probes && candidate.ProcessName != "gui_isolation_probe")) continue;
                // PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_DUP_HANDLE
                IntPtr process = Native.OpenProcess(0x1000 | 0x400 | 0x10 | 0x40, false, pid);
                if (process == IntPtr.Zero) continue;
                try
                {
                    IntPtr token;
                    if (!Native.OpenProcessToken(process, 0x8, out token)) continue;
                    string user, logon;
                    try { user = Tokens.User(token); logon = Tokens.LogonSids(token); }
                    finally { Native.CloseHandle(token); }
                    if (user != tierSid) continue;
                    var item = new Seen { Pid = pid, Parent = Procs.ParentPid(process), Created = Procs.Created(process), Image = Procs.Image(process), Peb = Procs.PebDesktop(process), Logon = logon };
                    if (!probes && item.Parent == me && item.Created >= meCreated)
                    {
                        string key = "excluded" + excluded++ + "_";
                        j.Set(key + "pid", (long)pid).Set(key + "created", item.Created).Set(key + "image", item.Image).Set(key + "peb_desktop", item.Peb);
                        continue;
                    }
                    HeldUserObjects(process, out item.Stations, out item.Desktops);
                    string suffix = item.Peb.Substring(item.Peb.IndexOf('\\') + 1);
                    item.Placed = item.Stations.Count == 1 && item.Desktops.Contains(suffix) && item.Peb == item.Stations[0] + "\\" + suffix;
                    if (string.Equals(Path.GetFileName(item.Image), "native_isolation_launcher.exe", StringComparison.OrdinalIgnoreCase)
                        && string.Equals(Path.GetFileName(Path.GetDirectoryName(item.Image)), "native-isolation", StringComparison.OrdinalIgnoreCase))
                    {
                        var runner = System.Text.RegularExpressions.Regex.Match(Procs.PebCommandLine(process), @" --tier-runner .*--pipe-id ([0-9a-f]+)\b");
                        if (runner.Success) { item.Kind = "supervisor"; item.PipeId = runner.Groups[1].Value; }
                    }
                    seen.Add(item);
                }
                finally { Native.CloseHandle(process); }
            }
            foreach (Seen item in seen)
            {
                Seen parent = seen.Find(s => s.Kind == "supervisor" && s.Pid == item.Parent && s.Created <= item.Created);
                string root = parent == null ? null : Path.GetDirectoryName(Path.GetDirectoryName(parent.Image)) + "\\";
                if (item.Kind == "other" && root != null && item.Image.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                {
                    item.Kind = "role";
                    item.PipeId = parent.PipeId;
                    item.Placed = item.Placed && item.Peb == parent.Peb;
                }
                if (item.Kind != "other") item.Placed = item.Placed && item.Peb.EndsWith("\\" + DesktopPrefix + item.PipeId, StringComparison.Ordinal);
            }
            foreach (Seen item in seen)
            {
                if (item.Kind != "other") continue;
                Seen at = item;
                for (int depth = 0; depth < 64 && at != null; depth++)
                {
                    Seen child = at;
                    at = seen.Find(s => s.Pid == child.Parent && s.Created <= child.Created);
                    if (at != null && (at.Kind == "supervisor" || at.Kind == "role")) { item.Kind = "descendant"; break; }
                }
            }
            string target = null;
            int misplaced = 0;
            bool onWinSta0 = false;
            for (int i = 0; i < seen.Count; i++)
            {
                Seen item = seen[i];
                string key = "role" + i + "_";
                bool winsta0 = item.Stations.Exists(s => string.Equals(s, "WinSta0", StringComparison.OrdinalIgnoreCase))
                    || item.Peb.StartsWith("WinSta0\\", StringComparison.OrdinalIgnoreCase);
                j.Set(key + "pid", (long)item.Pid).Set(key + "created", item.Created).Set(key + "kind", item.Kind).Set(key + "image", item.Image).Set(key + "parent_pid", item.Parent)
                 .Set(key + "stations", string.Join(";", item.Stations.ToArray())).Set(key + "desktops", string.Join(";", item.Desktops.ToArray()))
                 .Set(key + "peb_desktop", item.Peb).Set(key + "placed", item.Placed).Set(key + "on_winsta0", winsta0).Set(key + "pipe_id", item.PipeId).Set(key + "logon_sids", item.Logon);
                if (winsta0) onWinSta0 = true;
                bool relevant = item.Kind == "supervisor" || item.Kind == "role";
                if (relevant && !item.Placed) misplaced++;
                if (!probes && target == null && item.Kind == "role" && item.Placed)
                {
                    target = item.Peb;
                    j.Set("target_index", (long)i);
                }
            }
            j.Set("excluded_count", (long)excluded).Set("role_count", (long)seen.Count).Set("relevant_count", (long)seen.FindAll(s => s.Kind == "supervisor" || s.Kind == "role").Count)
             .Set("relevant_misplaced", (long)misplaced).Set("any_on_winsta0", onWinSta0);
            if (probes) return null;
            j.Set("target_desktop", target);
            if (target == null) j.Set("refused", seen.Count == 0 ? "no live process runs as this tier account" : "no product role of this tier is placed on its private desktop");
            return target;
        }

        // Cleanup: terminates every process of this account running exactly `image` (this run's verification
        // program) created at or after `notBefore`, except itself, and writes what it found to reaped.json.
        // The name filter runs before anything is opened, so no other process is touched. 0 = none left.
        static int Reap(string lane, string image, long notBefore)
        {
            string tierSid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
            string wanted = LongPath(image);
            uint me = Native.GetCurrentProcessId();
            var j = new Json();
            int found = 0, left = 0;
            foreach (Process candidate in Process.GetProcesses())
            {
                if (candidate.ProcessName != "gui_isolation_probe" || candidate.Id == me) continue;
                // PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
                IntPtr process = Native.OpenProcess(0x1 | 0x100000 | 0x1000, false, (uint)candidate.Id);
                if (process == IntPtr.Zero) continue;
                try
                {
                    IntPtr token;
                    if (!Native.OpenProcessToken(process, 0x8, out token)) continue;
                    string user;
                    try { user = Tokens.User(token); }
                    finally { Native.CloseHandle(token); }
                    long created = Procs.Created(process);
                    if (user != tierSid || created < notBefore || !string.Equals(LongPath(Procs.Image(process)), wanted, StringComparison.OrdinalIgnoreCase)) continue;
                    if (HopNative.WaitForSingleObject(process, 0) != 0) Native.TerminateProcess(process, 1);
                    bool gone = HopNative.WaitForSingleObject(process, 5000) == 0;
                    j.Set("p" + found + "_pid", (long)candidate.Id).Set("p" + found + "_created", created).Set("p" + found + "_gone", gone);
                    found++;
                    if (!gone) left++;
                }
                finally { Native.CloseHandle(process); }
            }
            j.Set("found", (long)found).Set("left", (long)left).Write(Path.Combine(lane, "reaped.json"));
            return left == 0 ? 0 : 1;
        }

        static string LongPath(string path)
        {
            var buffer = new StringBuilder(1024);
            return Native.GetLongPathNameW(path, buffer, (uint)buffer.Capacity) > 0 ? buffer.ToString() : path;
        }

        static void HeldUserObjects(IntPtr process, out List<string> stations, out List<string> desktops)
        {
            stations = new List<string>();
            desktops = new List<string>();
            IntPtr self = Native.GetCurrentProcess();
            for (long value = 4; value < 0x10000; value += 4)
            {
                IntPtr copy;
                if (!Native.DuplicateHandle(process, new IntPtr(value), self, out copy, 0, false, 0x2)) continue;
                try
                {
                    string type = UserObjects.TypeName(copy);
                    List<string> into = type == "WindowStation" ? stations : type == "Desktop" ? desktops : null;
                    if (into == null) continue;
                    string name = UserObjects.Name(copy);
                    if (name.Length > 0 && !into.Contains(name)) into.Add(name);
                }
                finally { Native.CloseHandle(copy); }
            }
        }

        static string Lookalike(Json j, string ownerSid, string tierSid, out IntPtr station, out IntPtr desktop)
        {
            station = desktop = IntPtr.Zero;
            string stationSddl = "D:P(A;;0x000f037f;;;SY)(A;;0x00020002;;;" + ownerSid + ")(A;;0x0002037f;;;" + tierSid + ")(A;;0x00020000;;;S-1-3-4)";
            string desktopSddl = "D:P(A;;0x000f01ff;;;SY)(A;;0x00020000;;;" + ownerSid + ")(A;;0x000201ff;;;" + tierSid + ")(A;;0x00020000;;;S-1-3-4)";
            using (var attributes = new Attributes(stationSddl))
            {
                // CWF_CREATE_ONLY: an existing station would ignore the descriptor.
                station = HopNative.CreateWindowStationW(null, 0x1, 0x0002037f, ref attributes.Value);
                if (station == IntPtr.Zero) throw Failure("CreateWindowStationW");
            }
            string name = DesktopPrefix + "lookalike" + Native.GetCurrentProcessId();
            IntPtr previous = Native.GetProcessWindowStation();
            if (!Native.SetProcessWindowStation(station)) throw Failure("SetProcessWindowStation");
            try
            {
                using (var attributes = new Attributes(desktopSddl))
                    desktop = HopNative.CreateDesktopW(name, null, IntPtr.Zero, 0, 0x000201ff, ref attributes.Value);
                if (desktop == IntPtr.Zero) throw Failure("CreateDesktopW");
            }
            finally { Native.SetProcessWindowStation(previous); }
            string target = UserObjects.Name(station) + "\\" + name;
            j.Set("lookalike_station", UserObjects.Name(station)).Set("target_desktop", target);
            return target;
        }

        static IntPtr Restricted(Json j, string tierSid, bool roleDesktopBoundary)
        {
            IntPtr own;
            // TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT
            if (!Native.OpenProcessToken(Native.GetCurrentProcess(), 0x1 | 0x2 | 0x8 | 0x80, out own)) throw Failure("OpenProcessToken");
            IntPtr groups = IntPtr.Zero;
            try
            {
                IntPtr restricted;
                SID_AND_ATTRIBUTES[] disable = null;
                if (roleDesktopBoundary)
                {
                    groups = Tokens.Info(own, 2);
                    if (groups == IntPtr.Zero) throw Failure("GetTokenInformation(TokenGroups)");
                    var denied = new List<SID_AND_ATTRIBUTES>();
                    int count = Marshal.ReadInt32(groups);
                    for (int i = 0; i < count; i++)
                    {
                        IntPtr entry = new IntPtr(groups.ToInt64() + IntPtr.Size + i * 2L * IntPtr.Size);
                        if (((uint)Marshal.ReadInt32(entry, IntPtr.Size) & Tokens.LogonIdMask) == Tokens.LogonIdMask)
                            denied.Add(new SID_AND_ATTRIBUTES { Sid = Marshal.ReadIntPtr(entry) });
                    }
                    if (denied.Count == 0) throw new InvalidOperationException("the hop's token carries no logon SID to deny");
                    disable = denied.ToArray();
                }
                if (!HopNative.CreateRestrictedToken(own, 0, disable == null ? 0U : (uint)disable.Length, disable, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted))
                    throw Failure("CreateRestrictedToken");
                SetDefaultDacl(restricted, "D:(A;;GA;;;" + tierSid + ")(A;;GA;;;SY)");
                string logon = Tokens.LogonSids(restricted);
                // Read back from the token itself; the lane checks compare them with the product's shape.
                j.Set("probe_token_logon_sids", logon).Set("probe_token_restricting_sid_count", (long)RestrictingSidCount(restricted))
                 .Set("probe_token_default_dacl", DefaultDacl(restricted)).Set("probe_token_group_sids", Tokens.GroupSids(restricted));
                bool expectedShape = roleDesktopBoundary;
                bool sawLogon = false;
                foreach (string item in logon.Split(';'))
                {
                    if (item.Length == 0) continue;
                    sawLogon = true;
                    uint attributes = Convert.ToUInt32(item.Substring(item.IndexOf(":0x", StringComparison.Ordinal) + 3), 16);
                    bool denyOnly = (attributes & 0x10) != 0 && (attributes & 0x4) == 0;
                    bool enabled = (attributes & 0x4) != 0;
                    expectedShape = roleDesktopBoundary ? expectedShape && denyOnly : expectedShape || enabled;
                }
                if (!sawLogon || !expectedShape)
                {
                    Native.CloseHandle(restricted);
                    throw new InvalidOperationException("the restricted copy has the wrong logon SID shape: " + logon);
                }
                return restricted;
            }
            finally
            {
                if (groups != IntPtr.Zero) Marshal.FreeHGlobal(groups);
                Native.CloseHandle(own);
            }
        }

        static void SetDefaultDacl(IntPtr token, string sddl)
        {
            IntPtr descriptor;
            if (!HopNative.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, IntPtr.Zero)) throw Failure("ConvertStringSecurityDescriptorToSecurityDescriptorW");
            try
            {
                bool present, defaulted;
                IntPtr dacl;
                if (!HopNative.GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted) || !present) throw Failure("GetSecurityDescriptorDacl");
                if (!HopNative.SetTokenInformation(token, 6, new[] { dacl }, IntPtr.Size)) throw Failure("SetTokenInformation(TokenDefaultDacl)");
            }
            finally { Native.LocalFree(descriptor); }
        }

        // The token's default DACL as SDDL, or "(none)" when it has none.
        static string DefaultDacl(IntPtr token)
        {
            IntPtr info = Tokens.Info(token, 6);
            if (info == IntPtr.Zero) throw Failure("GetTokenInformation(TokenDefaultDacl)");
            IntPtr descriptor = Marshal.AllocHGlobal(64);
            try
            {
                IntPtr dacl = Marshal.ReadIntPtr(info);
                if (dacl == IntPtr.Zero) return "(none)";
                if (!HopNative.InitializeSecurityDescriptor(descriptor, 1)) throw Failure("InitializeSecurityDescriptor");
                if (!HopNative.SetSecurityDescriptorDacl(descriptor, true, dacl, false)) throw Failure("SetSecurityDescriptorDacl");
                IntPtr text;
                // DACL_SECURITY_INFORMATION
                if (!HopNative.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 0x4, out text, IntPtr.Zero))
                    throw Failure("ConvertSecurityDescriptorToStringSecurityDescriptorW");
                try { return Marshal.PtrToStringUni(text); } finally { Native.LocalFree(text); }
            }
            finally
            {
                Marshal.FreeHGlobal(descriptor);
                Marshal.FreeHGlobal(info);
            }
        }

        // TokenRestrictedSids' group count; the product's restricted copy has none.
        static int RestrictingSidCount(IntPtr token)
        {
            IntPtr groups = Tokens.Info(token, 11);
            if (groups == IntPtr.Zero) throw Failure("GetTokenInformation(TokenRestrictedSids)");
            try { return Marshal.ReadInt32(groups); } finally { Marshal.FreeHGlobal(groups); }
        }

        static IntPtr StartProbe(Json j, IntPtr token, string desktop, string lane)
        {
            string exe = Self();
            var startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.lpDesktop = desktop;
            IntPtr environment = Marshal.StringToHGlobalUni(Block(lane));
            PROCESS_INFORMATION info;
            try
            {
                // CREATE_SUSPENDED | DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT, bInheritHandles false: the
                // supervisor's creation. Suspended so its identity is on disk before it runs a single instruction.
                if (!HopNative.CreateProcessAsUserW(token, exe, new StringBuilder(Quote(exe) + " serve " + Quote(lane)), IntPtr.Zero, IntPtr.Zero,
                        false, 0x4 | 0x8 | 0x400, environment, lane, ref startup, out info))
                    throw Failure("CreateProcessAsUserW");
            }
            finally { Marshal.FreeHGlobal(environment); }
            try
            {
                long created = Procs.Created(info.hProcess);
                new Json().Set("probe_pid", (long)info.pid).Set("probe_created", created).Write(Path.Combine(lane, "launched.json"));
                j.Set("probe_pid", (long)info.pid).Set("probe_created", created).Set("probe_desktop", desktop);
                if (Native.ResumeThread(info.hThread) == uint.MaxValue) throw Failure("ResumeThread");
            }
            catch
            {
                Native.TerminateProcess(info.hProcess, 1);
                Native.CloseHandle(info.hProcess);
                throw;
            }
            finally { Native.CloseHandle(info.hThread); }
            return info.hProcess;
        }

        static string Block(string lane)
        {
            var block = new StringBuilder();
            foreach (string name in EnvironmentNames)
            {
                string value = Environment.GetEnvironmentVariable(name);
                if (value != null) block.Append(name).Append('=').Append(value).Append('\0');
            }
            return block.Append("TEMP=").Append(lane).Append('\0').Append("TMP=").Append(lane).Append('\0').ToString();
        }

        static string Self() { return Assembly.GetEntryAssembly().Location; }

        static string Quote(string text) { return "\"" + text + "\""; }

        static Exception Failure(string what) { return new InvalidOperationException(what + " failed: " + Marshal.GetLastWin32Error()); }

        sealed class Attributes : IDisposable
        {
            public SECURITY_ATTRIBUTES Value;

            public Attributes(string sddl)
            {
                IntPtr descriptor;
                if (!HopNative.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, IntPtr.Zero)) throw Failure("ConvertStringSecurityDescriptorToSecurityDescriptorW");
                Value = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), lpSecurityDescriptor = descriptor };
            }

            public void Dispose() { Native.LocalFree(Value.lpSecurityDescriptor); }
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int x, y, xSize, ySize, xChars, yChars, fill, flags;
        public short show, reserved2Size;
        public IntPtr reserved2, stdInput, stdOutput, stdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int pid, tid; }

    [StructLayout(LayoutKind.Sequential)]
    struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

    static class HopNative
    {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CreateProcessWithLogonW(string user, string domain, IntPtr password, uint logonFlags, string application, StringBuilder command,
            uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
            bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableCount, SID_AND_ATTRIBUTES[] disable, uint deleteCount, IntPtr delete,
            uint restrictCount, IntPtr restrict, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool SetTokenInformation(IntPtr token, int infoClass, IntPtr[] info, int length);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool InitializeSecurityDescriptor(IntPtr descriptor, uint revision);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool SetSecurityDescriptorDacl(IntPtr descriptor, bool present, IntPtr dacl, bool defaulted);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision, uint information, out IntPtr text, IntPtr length);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateWindowStationW(string name, uint flags, uint access, ref SECURITY_ATTRIBUTES attributes);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateDesktopW(string name, string device, IntPtr mode, uint flags, uint access, ref SECURITY_ATTRIBUTES attributes);
        [DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    }
}
