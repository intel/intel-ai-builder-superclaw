// gui_isolation_probe.cs: the verification program of tools/gui_isolation_acceptance.ps1 (#3499, #3400).
//
// A manual tool, not part of either product binary: the driver compiles this file with
// gui_isolation_checks.cs, gui_isolation_hop.cs and gui_isolation_native.cs, using the .NET Framework's
// csc.exe, into %TEMP%, and no product path starts it. The same image runs both sides of every check, so an
// owner control exercises exactly the code the tier side runs.
//
//   window <dir> <r> <g> <b> <title>  the owner's test window: paints the colour marker and logs every
//                                     WM_CHAR and marker message it receives to <dir>\window.log
//   serve <dir>                       writes hello.json, then answers each cmd-<n>.txt with res-<n>.json,
//                                     one fixed check per command (gui_isolation_checks.cs)
//   logon ... | hop ...               the tier hop (gui_isolation_hop.cs)
//
// The driver pairs every observation with the owner's control and decides the verdict.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace GuiIsolation
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine("usage: gui_isolation_probe window|serve|logon|hop ...");
                return 2;
            }
            try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); }
            catch (EntryPointNotFoundException) { Native.SetProcessDPIAware(); }
            switch (args[0])
            {
                case "window": return MarkerForm.Run(args);
                case "serve": return Serve.Run(args[1]);
                case "logon": return Hop.Logon(args);
                case "hop": return Hop.Run(args);
            }
            Console.Error.WriteLine("unknown mode " + args[0]);
            return 2;
        }
    }

    sealed class Json
    {
        readonly List<KeyValuePair<string, object>> items = new List<KeyValuePair<string, object>>();

        public Json Set(string key, object value)
        {
            items.Add(new KeyValuePair<string, object>(key, value));
            return this;
        }

        public Json Merge(Json other, string prefix)
        {
            foreach (var item in other.items) Set(prefix + item.Key, item.Value);
            return this;
        }

        public void Write(string path)
        {
            string temporary = path + ".tmp";
            File.WriteAllText(temporary, ToString(), new UTF8Encoding(false));
            if (File.Exists(path)) File.Delete(path);
            File.Move(temporary, path);
        }

        public override string ToString()
        {
            var text = new StringBuilder("{");
            for (int i = 0; i < items.Count; i++)
            {
                text.Append(i == 0 ? "\n  " : ",\n  ").Append(Quote(items[i].Key)).Append(": ").Append(Value(items[i].Value));
            }
            return text.Append("\n}\n").ToString();
        }

        public static string Hex(long value) { return "0x" + value.ToString("x", CultureInfo.InvariantCulture); }

        static string Value(object value)
        {
            if (value == null) return "null";
            if (value is bool) return (bool)value ? "true" : "false";
            if (value is int || value is long) return Convert.ToString(value, CultureInfo.InvariantCulture);
            return Quote(value.ToString());
        }

        static string Quote(string text)
        {
            var quoted = new StringBuilder("\"");
            foreach (char c in text)
            {
                if (c == '"' || c == '\\') quoted.Append('\\').Append(c);
                else if (c < ' ') quoted.Append("\\u").Append(((int)c).ToString("x4"));
                else quoted.Append(c);
            }
            return quoted.Append('"').ToString();
        }
    }

    static class Serve
    {
        // A probe the driver lost (an interrupted run) exits on its own after this long without a command.
        const int IdleMinutes = 20;

        public static int Run(string dir)
        {
            Identity.Describe().Write(Path.Combine(dir, "hello.json"));
            var hook = new KeyboardHook();
            var clipboard = new ClipboardOwner();
            DateTime last = DateTime.UtcNow;
            int sequence = 1;
            while ((DateTime.UtcNow - last).TotalMinutes < IdleMinutes)
            {
                string command = Path.Combine(dir, "cmd-" + sequence + ".txt");
                if (!File.Exists(command)) { Messages.Pump(100); continue; }
                string[] words = File.ReadAllText(command).Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                string verb = words.Length > 0 ? words[0] : "";
                Json result;
                try { result = Dispatch(verb, words, dir, hook, clipboard); }
                catch (Exception error) { result = new Json().Set("exception", error.GetType().Name + ": " + error.Message); }
                // Read from the owner's state, not from what the command returned, so a clipboard emptied by a
                // command that then failed is still restored.
                if (verb.StartsWith("clip-", StringComparison.Ordinal)) result.Set("restore_required", clipboard.Pending);
                result.Set("command", verb).Write(Path.Combine(dir, "res-" + sequence + ".json"));
                if (verb == "exit") break;
                sequence++;
                last = DateTime.UtcNow;
            }
            hook.Stop();
            return 0;
        }

        static Json Dispatch(string verb, string[] w, string dir, KeyboardHook hook, ClipboardOwner clipboard)
        {
            switch (verb)
            {
                case "info": return Identity.Describe();
                case "fg": return new Json().Set("foreground", Native.GetForegroundWindow() == Window(w[1]));
                case "sendinput": return Checks.SendText(w[1]);
                case "capture": return Checks.Capture(Byte(w[1]), Byte(w[2]), Byte(w[3]));
                case "duplicate": return Duplication.Count(Byte(w[1]), Byte(w[2]), Byte(w[3]));
                case "hook-start": return hook.Start();
                case "hook-stop": return hook.Stop();
                case "post": return Checks.Post(Window(w[1]), long.Parse(w[2], CultureInfo.InvariantCulture));
                case "objects": return Checks.Objects(Window(w[1]), w[2], w[3]);
                case "attach-boundary": return Checks.AttachBoundary();
                case "clip-set": return clipboard.Set(w[1]);
                case "clip-restore": return clipboard.Restore();
                case "atom-add":
                    ushort added = Native.GlobalAddAtomW(w[1]);
                    return new Json().Set("atom", (long)added).Set("error", (long)(added == 0 ? Marshal.GetLastWin32Error() : 0));
                case "atom-find": return new Json().Set("found", Native.GlobalFindAtomW(w[1]) != 0);
                case "atom-delete":
                    ushort atom = Native.GlobalFindAtomW(w[1]);
                    if (atom != 0) Native.GlobalDeleteAtom(atom);
                    return new Json().Set("deleted", atom != 0);
                case "residual": return Residual.Run(Path.Combine(dir, "targets.txt"));
                case "station-exists": return Checks.StationExists(w[1]);
                case "exit": return new Json();
            }
            return new Json().Set("error", "unknown command");
        }

        static IntPtr Window(string text) { return new IntPtr(long.Parse(text, CultureInfo.InvariantCulture)); }

        static byte Byte(string text) { return byte.Parse(text, CultureInfo.InvariantCulture); }
    }

    static class Messages
    {
        // The owner's probe owns the clipboard while a check runs, and the system sends a clipboard owner
        // messages synchronously; a thread that never pumped would stall the sender.
        public static void Pump(int milliseconds)
        {
            int end = Environment.TickCount + milliseconds;
            MSG message;
            do
            {
                while (Native.PeekMessageW(out message, IntPtr.Zero, 0, 0, 1))
                {
                    Native.TranslateMessage(ref message);
                    Native.DispatchMessageW(ref message);
                }
                Thread.Sleep(15);
            } while (Environment.TickCount - end < 0);
        }
    }

    static class Identity
    {
        public static Json Describe()
        {
            var j = new Json();
            IntPtr self = Native.GetCurrentProcess();
            j.Set("pid", (long)Native.GetCurrentProcessId()).Set("created", Procs.Created(self))
             .Set("parent_pid", Procs.ParentPid(self)).Set("image", Procs.Image(self));
            IntPtr token;
            if (Native.OpenProcessToken(self, 0x8, out token))
            {
                try
                {
                    j.Set("user_sid", Tokens.User(token)).Set("logon_sids", Tokens.LogonSids(token))
                     .Set("group_sids", Tokens.GroupSids(token)).Set("restricting_sids", Native.IsTokenRestricted(token))
                     .Set("integrity", Tokens.Integrity(token));
                }
                finally { Native.CloseHandle(token); }
            }
            uint session;
            Native.ProcessIdToSessionId(Native.GetCurrentProcessId(), out session);
            j.Set("session_id", (long)session)
             .Set("station", UserObjects.Name(Native.GetProcessWindowStation()))
             .Set("desktop", UserObjects.Name(Native.GetThreadDesktop(Native.GetCurrentThreadId())))
             .Set("startup_desktop", Procs.PebDesktop(self));
            IntPtr input = Native.OpenInputDesktop(0, false, Native.MAXIMUM_ALLOWED);
            j.Set("input_desktop", input == IntPtr.Zero ? "unavailable " + Marshal.GetLastWin32Error() : UserObjects.Name(input));
            if (input != IntPtr.Zero) Native.CloseDesktop(input);
            bool inJob;
            Native.IsProcessInJob(self, IntPtr.Zero, out inJob);
            uint limits;
            bool read = Native.QueryInformationJobObject(IntPtr.Zero, 4, out limits, 4, IntPtr.Zero);
            int error = read ? 0 : Marshal.GetLastWin32Error();
            return j.Set("in_job", inJob).Set("job_ui_limits", read ? Json.Hex(limits) : inJob ? "unreadable " + error : "none");
        }
    }

    static class Tokens
    {
        public const uint LogonIdMask = 0xC0000000;

        // Caller frees with Marshal.FreeHGlobal; IntPtr.Zero when the class cannot be read.
        public static IntPtr Info(IntPtr token, int infoClass)
        {
            int needed;
            Native.GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out needed);
            if (needed <= 0) return IntPtr.Zero;
            IntPtr buffer = Marshal.AllocHGlobal(needed);
            if (Native.GetTokenInformation(token, infoClass, buffer, needed, out needed)) return buffer;
            Marshal.FreeHGlobal(buffer);
            return IntPtr.Zero;
        }

        public static string User(IntPtr token) { return FirstSid(token, 1); }

        public static string Integrity(IntPtr token) { return FirstSid(token, 25); }

        // Every logon SID with its attributes, "sid:0xattrs;...": 0x10 is deny-only, 0x4 enabled.
        public static string LogonSids(IntPtr token)
        {
            IntPtr groups = Info(token, 2);
            if (groups == IntPtr.Zero) return "";
            try
            {
                var found = new List<string>();
                int count = Marshal.ReadInt32(groups);
                for (int i = 0; i < count; i++)
                {
                    IntPtr entry = new IntPtr(groups.ToInt64() + IntPtr.Size + i * 2L * IntPtr.Size);
                    uint attributes = (uint)Marshal.ReadInt32(entry, IntPtr.Size);
                    if ((attributes & LogonIdMask) == LogonIdMask) found.Add(Sid(Marshal.ReadIntPtr(entry)) + ":" + Json.Hex(attributes));
                }
                return string.Join(";", found.ToArray());
            }
            finally { Marshal.FreeHGlobal(groups); }
        }

        // Every token group with its attributes, in the same shape as LogonSids.
        public static string GroupSids(IntPtr token)
        {
            IntPtr groups = Info(token, 2);
            if (groups == IntPtr.Zero) return "";
            try
            {
                var found = new List<string>();
                int count = Marshal.ReadInt32(groups);
                for (int i = 0; i < count; i++)
                {
                    IntPtr entry = new IntPtr(groups.ToInt64() + IntPtr.Size + i * 2L * IntPtr.Size);
                    found.Add(Sid(Marshal.ReadIntPtr(entry)) + ":" + Json.Hex((uint)Marshal.ReadInt32(entry, IntPtr.Size)));
                }
                return string.Join(";", found.ToArray());
            }
            finally { Marshal.FreeHGlobal(groups); }
        }

        public static string Sid(IntPtr sid)
        {
            IntPtr text;
            if (!Native.ConvertSidToStringSidW(sid, out text)) return "";
            try { return Marshal.PtrToStringUni(text); }
            finally { Native.LocalFree(text); }
        }

        static string FirstSid(IntPtr token, int infoClass)
        {
            IntPtr buffer = Info(token, infoClass);
            if (buffer == IntPtr.Zero) return "";
            try { return Sid(Marshal.ReadIntPtr(buffer)); }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }

    static class Procs
    {
        public static long ParentPid(IntPtr process)
        {
            var basic = new IntPtr[6];
            int length;
            return Native.NtQueryInformationProcess(process, 0, basic, 48, out length) == 0 ? basic[5].ToInt64() : -1;
        }

        public static string Image(IntPtr process)
        {
            var name = new StringBuilder(1024);
            int size = name.Capacity;
            return Native.QueryFullProcessImageNameW(process, 0, name, ref size) ? name.ToString() : "";
        }

        // Creation time as a FILETIME, which with the pid identifies a process across pid reuse; 0 if unreadable.
        public static long Created(IntPtr process)
        {
            long created, exited, kernel, user;
            return Native.GetProcessTimes(process, out created, out exited, out kernel, out user) ? created : 0;
        }

        // RTL_USER_PROCESS_PARAMETERS.DesktopInfo, x64 layout only (PEB+0x20, then +0xC0), which the build
        // pins with /platform:x64.
        public static string PebDesktop(IntPtr process) { return PebString(process, 0xC0, 1024); }

        // RTL_USER_PROCESS_PARAMETERS.CommandLine. A supervisor's carries its launch key: callers test it and
        // must never record it.
        public static string PebCommandLine(IntPtr process) { return PebString(process, 0x70, 8192); }

        static string PebString(IntPtr process, int offset, int limit)
        {
            var basic = new IntPtr[6];
            int length;
            if (Native.NtQueryInformationProcess(process, 0, basic, 48, out length) != 0) return "unreadable";
            byte[] pointer = Read(process, new IntPtr(basic[1].ToInt64() + 0x20), 8);
            if (pointer == null) return "unreadable";
            byte[] text = Read(process, new IntPtr(BitConverter.ToInt64(pointer, 0) + offset), 16);
            if (text == null) return "unreadable";
            int used = BitConverter.ToUInt16(text, 0), maximum = BitConverter.ToUInt16(text, 2);
            long buffer = BitConverter.ToInt64(text, 8);
            if (used == 0) return "";
            if (used % 2 != 0 || used > maximum || used > limit || buffer == 0) return "malformed";
            byte[] value = Read(process, new IntPtr(buffer), used);
            return value == null ? "unreadable" : Encoding.Unicode.GetString(value);
        }

        static byte[] Read(IntPtr process, IntPtr address, int size)
        {
            var buffer = new byte[size];
            IntPtr read;
            return Native.ReadProcessMemory(process, address, buffer, new IntPtr(size), out read) && read.ToInt64() == size ? buffer : null;
        }
    }

    static class UserObjects
    {
        // UOI_NAME needs WINSTA_READATTRIBUTES, which a caller's handle may lack, so this falls back to the
        // last component of the kernel object name.
        public static string Name(IntPtr handle)
        {
            if (handle == IntPtr.Zero) return "";
            var buffer = new byte[1024];
            int needed;
            if (Native.GetUserObjectInformationW(handle, 2, buffer, buffer.Length, out needed))
                return Encoding.Unicode.GetString(buffer, 0, Math.Max(0, needed - 2));
            string kernel = Query(handle, 1);
            return kernel.Substring(kernel.LastIndexOf('\\') + 1);
        }

        public static string Granted(IntPtr handle)
        {
            var basic = new uint[14];
            int length;
            return Native.NtQueryObjectBasic(handle, 0, basic, 56, out length) == 0 ? Json.Hex(basic[1]) : "unknown";
        }

        public static string TypeName(IntPtr handle) { return Query(handle, 2); }

        // ObjectNameInformation (1) or ObjectTypeInformation (2); both start with a UNICODE_STRING. Only ever
        // asked of window station and desktop handles for names, never of a file, where it can block.
        static string Query(IntPtr handle, int infoClass)
        {
            IntPtr buffer = Marshal.AllocHGlobal(1024);
            try
            {
                int length;
                return Native.NtQueryObject(handle, infoClass, buffer, 1024, out length) == 0 ? Nt.String(buffer) : "";
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }

    // The owner's test window. Its colour is the marker the capture checks look for; the small square in the
    // header changes every tick so Desktop Duplication always has a fresh frame to deliver.
    sealed class MarkerForm : Form
    {
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly string directory, log;
        string prompt = "";
        bool blink;

        MarkerForm(string directory, Color marker, string title)
        {
            this.directory = directory;
            log = Path.Combine(directory, "window.log");
            Text = "SuperClaw isolation test " + title;
            BackColor = marker;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(60, 60);
            ClientSize = new Size(760, 440);
            Font = new Font("Segoe UI", 14f);
            DoubleBuffered = true;
            timer.Interval = 400;
            timer.Tick += OnTick;
        }

        public static int Run(string[] a)
        {
            var marker = Color.FromArgb(int.Parse(a[2], CultureInfo.InvariantCulture), int.Parse(a[3], CultureInfo.InvariantCulture), int.Parse(a[4], CultureInfo.InvariantCulture));
            Application.Run(new MarkerForm(a[1], marker, a[5]));
            return 0;
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            new Json().Set("hwnd", Handle.ToInt64()).Set("pid", (long)Native.GetCurrentProcessId())
                .Set("created", Procs.Created(Native.GetCurrentProcess())).Write(Path.Combine(directory, "window.json"));
            timer.Start();
        }

        // The operator gives the window focus by clicking it; it never takes focus from whatever the user is typing in.
        protected override bool ShowWithoutActivation { get { return true; } }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Checks.MarkerMessage) Append("msg " + m.WParam.ToInt64() + " " + m.LParam.ToInt64());
            base.WndProc(ref m);
        }

        protected override void OnKeyPress(KeyPressEventArgs e)
        {
            Append("char " + (int)e.KeyChar);
            base.OnKeyPress(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.FillRectangle(Brushes.White, 0, 0, ClientSize.Width, 120);
            e.Graphics.FillRectangle(blink ? Brushes.Black : Brushes.Gray, ClientSize.Width - 24, 4, 16, 16);
            TextRenderer.DrawText(e.Graphics, prompt, Font, new Rectangle(8, 8, ClientSize.Width - 40, 110), Color.Black, TextFormatFlags.WordBreak);
        }

        void OnTick(object sender, EventArgs e)
        {
            if (File.Exists(Path.Combine(directory, "window.stop"))) { Close(); return; }
            string path = Path.Combine(directory, "prompt.txt");
            try { prompt = File.Exists(path) ? File.ReadAllText(path).Trim() : ""; }
            catch (IOException) { }
            blink = !blink;
            Invalidate(new Rectangle(0, 0, ClientSize.Width, 120));
        }

        void Append(string line)
        {
            for (int attempt = 0; attempt < 10; attempt++)
            {
                try { File.AppendAllText(log, line + "\n"); return; }
                catch (IOException) { Thread.Sleep(20); }
            }
        }
    }

}
