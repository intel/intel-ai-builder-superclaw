// gui_isolation_checks.cs: the checks of the verification program of tools/gui_isolation_acceptance.ps1
// (#3499, #3400), compiled with gui_isolation_probe.cs. Not part of either product binary.
//
// Each check reports what it observed and nothing else. None writes the security of any object; the
// residual checks open and close handles and create one uniquely named mutex of their own, and never use
// what they opened.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace GuiIsolation
{
    static class Checks
    {
        public const int MarkerMessage = 0x8000 + 0x349;

        // Every error code a verdict may use is read right after its own call, with the thread's last error
        // cleared just before it, so a stale value from an earlier call can never stand in as evidence.

        // The return value and error are information only: neither says why input was blocked (UIPI, desktop),
        // so the driver judges SendInput by what the owner window received.
        public static Json SendText(string text)
        {
            var inputs = new INPUT[text.Length * 2];
            for (int i = 0; i < text.Length; i++)
            {
                inputs[2 * i].type = 1;
                inputs[2 * i].wScan = text[i];
                inputs[2 * i].dwFlags = 0x4;
                inputs[2 * i + 1] = inputs[2 * i];
                inputs[2 * i + 1].dwFlags = 0x4 | 0x2;
            }
            Native.SetLastError(0);
            uint sent = Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            int error = sent == inputs.Length ? 0 : Marshal.GetLastWin32Error();
            return new Json().Set("sent", (long)sent).Set("expected", (long)inputs.Length).Set("error", (long)error);
        }

        // "captured" is true only when BitBlt filled a non-empty surface; "matched" exists only then, so a
        // failed capture can never read as "the marker is absent". "stage" and "error" name the failing call.
        public static Json Capture(byte r, byte g, byte b)
        {
            int x = Native.GetSystemMetrics(76), y = Native.GetSystemMetrics(77);
            int width = Native.GetSystemMetrics(78), height = Native.GetSystemMetrics(79);
            var j = new Json().Set("width", (long)width).Set("height", (long)height);
            if (width <= 0 || height <= 0) return j.Set("captured", false).Set("stage", "metrics").Set("error", 0L);
            Native.SetLastError(0);
            IntPtr screen = Native.GetDC(IntPtr.Zero);
            if (screen == IntPtr.Zero) return Failed(j, "GetDC");
            IntPtr memory = IntPtr.Zero, bitmap = IntPtr.Zero, bits = IntPtr.Zero;
            try
            {
                Native.SetLastError(0);
                memory = Native.CreateCompatibleDC(screen);
                if (memory == IntPtr.Zero) return Failed(j, "CreateCompatibleDC");
                var header = new BITMAPINFOHEADER { biSize = 40, biWidth = width, biHeight = -height, biPlanes = 1, biBitCount = 32 };
                Native.SetLastError(0);
                bitmap = Native.CreateDIBSection(screen, ref header, 0, out bits, IntPtr.Zero, 0);
                if (bitmap == IntPtr.Zero || bits == IntPtr.Zero) return Failed(j, "CreateDIBSection");
                IntPtr previous = Native.SelectObject(memory, bitmap);
                Native.SetLastError(0);
                if (!Native.BitBlt(memory, 0, 0, width, height, screen, x, y, 0x40CC0020)) return Failed(j, "BitBlt");
                j.Set("captured", true).Set("stage", "done").Set("error", 0L).Set("matched", Pixels.Count(bits, width * 4, width, height, r, g, b));
                Native.SelectObject(memory, previous);
                return j;
            }
            finally
            {
                if (bitmap != IntPtr.Zero) Native.DeleteObject(bitmap);
                if (memory != IntPtr.Zero) Native.DeleteDC(memory);
                Native.ReleaseDC(IntPtr.Zero, screen);
            }
        }

        // Called straight after the failed call, before any other P/Invoke can replace the saved error.
        static Json Failed(Json j, string stage)
        {
            return j.Set("captured", false).Set("stage", stage).Set("error", (long)Marshal.GetLastWin32Error());
        }

        // Whether the window station `name` exists in this session, asked by opening it with READ_CONTROL,
        // which the owner's entry on a lookalike allows; cleanup uses it to show a lookalike is gone.
        // EnumWindowStationsW lists only stations the caller may enumerate, which the owner may not there.
        public static Json StationExists(string name)
        {
            IntPtr station = Native.OpenWindowStationW(name, false, 0x00020000);
            if (station == IntPtr.Zero) return new Json().Set("exists", false).Set("error", (long)Marshal.GetLastWin32Error());
            Native.CloseWindowStation(station);
            return new Json().Set("exists", true).Set("error", 0L);
        }

        // lParam 1 marks the posted copy, 2 the sent one, so the window log tells them apart.
        public static Json Post(IntPtr window, long tag)
        {
            Native.SetLastError(0);
            bool posted = Native.PostMessageW(window, MarkerMessage, new IntPtr(tag), new IntPtr(1));
            int postError = posted ? 0 : Marshal.GetLastWin32Error();
            UIntPtr answer;
            Native.SetLastError(0);
            bool sent = Native.SendMessageTimeoutW(window, MarkerMessage, new IntPtr(tag), new IntPtr(2), 0x2, 2000, out answer) != IntPtr.Zero;
            int sendError = sent ? 0 : Marshal.GetLastWin32Error();
            return new Json().Set("posted", posted).Set("post_error", (long)postError).Set("sent", sent).Set("send_error", (long)sendError);
        }

        public static Json Objects(IntPtr window, string clipMarker, string titleMarker)
        {
            var j = new Json();
            Native.SetLastError(0);
            IntPtr station = Native.OpenWindowStationW("WinSta0", false, Native.MAXIMUM_ALLOWED);
            Opened(j, "winsta0", station);
            Native.SetLastError(0);
            IntPtr input = Native.OpenInputDesktop(0, false, Native.MAXIMUM_ALLOWED);
            Opened(j, "input", input);
            if (input != IntPtr.Zero) Native.CloseDesktop(input);
            ReadClipboard(j, "clip_own", clipMarker);
            // A hidden window of the probe's own is the positive control: an enumeration that lists it ran.
            IntPtr mine = Native.CreateWindowExW(0, "STATIC", "", 0x80000000, 0, 0, 1, 1, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            var own = new WindowScan(window, titleMarker, mine);
            Native.SetLastError(0);
            bool enumerated = Native.EnumWindows(own.Visit, IntPtr.Zero);
            int enumError = enumerated ? 0 : Marshal.GetLastWin32Error();
            if (mine != IntPtr.Zero) Native.DestroyWindow(mine);
            j.Set("enum_own_ok", enumerated).Set("enum_own_error", (long)enumError).Set("enum_own_count", (long)own.Count)
             .Set("enum_own_self", own.SawSelf)
             .Set("enum_own_target", own.SawTarget).Set("enum_own_title", own.SawTitle)
             .Set("handle_is_window", Native.IsWindow(window))
             .Set("handle_title_readable", WindowScan.TitleOf(window).Contains(titleMarker));
            if (station == IntPtr.Zero) return j.Set("default_open", false).Set("default_error", "WinSta0 not opened");
            IntPtr previous = Native.GetProcessWindowStation();
            try
            {
                if (!Native.SetProcessWindowStation(station))
                    return j.Set("default_open", false).Set("default_error", "SetProcessWindowStation " + Marshal.GetLastWin32Error());
                Native.SetLastError(0);
                IntPtr desktop = Native.OpenDesktopW("Default", 0, false, Native.MAXIMUM_ALLOWED);
                Opened(j, "default", desktop);
                if (desktop != IntPtr.Zero)
                {
                    var other = new WindowScan(window, titleMarker, IntPtr.Zero);
                    Native.EnumDesktopWindows(desktop, other.Visit, IntPtr.Zero);
                    j.Set("enum_default_count", (long)other.Count).Set("enum_default_target", other.SawTarget);
                    Native.CloseDesktop(desktop);
                }
                ReadClipboard(j, "clip_winsta0", clipMarker);
            }
            finally
            {
                Native.SetProcessWindowStation(previous);
                Native.CloseWindowStation(station);
            }
            return j;
        }

        // Attaches in the exact order a hostile role would. The input is VK_F24 only (down/up), never
        // text, and the one-pixel BitBlt remains in memory.
        public static Json AttachBoundary()
        {
            Json result = null;
            Exception failure = null;
            var worker = new Thread(new ThreadStart(delegate
            {
                try { result = AttachBoundaryOnFreshThread(); }
                catch (Exception error) { failure = error; }
            }));
            worker.Start();
            worker.Join();
            if (failure != null) throw failure;
            return result;
        }

        static Json AttachBoundaryOnFreshThread()
        {
            var j = new Json();
            Native.SetLastError(0);
            IntPtr station = Native.OpenWindowStationW("WinSta0", false, Native.MAXIMUM_ALLOWED);
            if (station == IntPtr.Zero) return FailedAttach(j, "OpenWindowStation");
            IntPtr previousStation = Native.GetProcessWindowStation();
            IntPtr previousDesktop = Native.GetThreadDesktop(Native.GetCurrentThreadId());
            IntPtr desktop = IntPtr.Zero, screen = IntPtr.Zero, memory = IntPtr.Zero, bitmap = IntPtr.Zero, bits = IntPtr.Zero;
            try
            {
                Native.SetLastError(0);
                if (!Native.SetProcessWindowStation(station)) return FailedAttach(j, "SetProcessWindowStation");
                Native.SetLastError(0);
                desktop = Native.OpenDesktopW("Default", 0, false, Native.MAXIMUM_ALLOWED);
                if (desktop == IntPtr.Zero) return FailedAttach(j, "OpenDesktop");
                Native.SetLastError(0);
                if (!Native.SetThreadDesktop(desktop)) return FailedAttach(j, "SetThreadDesktop");
                j.Set("attached", true);

                var inputs = new INPUT[2];
                inputs[0].type = 1; inputs[0].wVk = 0x87; // VK_F24
                inputs[1] = inputs[0]; inputs[1].dwFlags = 0x2; // KEYEVENTF_KEYUP
                Native.SetLastError(0);
                uint sent = Native.SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
                j.Set("sent", (long)sent).Set("send_error", (long)(sent == 2 ? 0 : Marshal.GetLastWin32Error()));

                Native.SetLastError(0);
                screen = Native.GetDC(IntPtr.Zero);
                if (screen == IntPtr.Zero) return FailedCapture(j, "GetDC");
                memory = Native.CreateCompatibleDC(screen);
                if (memory == IntPtr.Zero) return FailedCapture(j, "CreateCompatibleDC");
                var header = new BITMAPINFOHEADER { biSize = 40, biWidth = 1, biHeight = -1, biPlanes = 1, biBitCount = 32 };
                bitmap = Native.CreateDIBSection(screen, ref header, 0, out bits, IntPtr.Zero, 0);
                if (bitmap == IntPtr.Zero || bits == IntPtr.Zero) return FailedCapture(j, "CreateDIBSection");
                IntPtr previous = Native.SelectObject(memory, bitmap);
                Native.SetLastError(0);
                bool copied = Native.BitBlt(memory, 0, 0, 1, 1, screen, 0, 0, 0x00CC0020);
                int copyError = copied ? 0 : Marshal.GetLastWin32Error();
                Native.SelectObject(memory, previous);
                return j.Set("bitblt", copied).Set("bitblt_error", (long)copyError).Set("stage", "done");
            }
            finally
            {
                if (bitmap != IntPtr.Zero) Native.DeleteObject(bitmap);
                if (memory != IntPtr.Zero) Native.DeleteDC(memory);
                if (screen != IntPtr.Zero) Native.ReleaseDC(IntPtr.Zero, screen);
                Native.SetThreadDesktop(previousDesktop);
                Native.SetProcessWindowStation(previousStation);
                if (desktop != IntPtr.Zero) Native.CloseDesktop(desktop);
                Native.CloseWindowStation(station);
            }
        }

        static Json FailedAttach(Json j, string stage)
        {
            return j.Set("attached", false).Set("stage", stage).Set("error", (long)Marshal.GetLastWin32Error());
        }

        // After attach: keeps "attached" and "sent", so a capture failure cannot hide delivered input.
        static Json FailedCapture(Json j, string stage)
        {
            return j.Set("bitblt", false).Set("bitblt_error", (long)Marshal.GetLastWin32Error()).Set("stage", stage);
        }

        // Reads the error before anything else can overwrite it.
        static void Opened(Json j, string key, IntPtr handle)
        {
            int error = handle == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            j.Set(key + "_open", handle != IntPtr.Zero).Set(key + "_error", (long)error)
             .Set(key + "_granted", handle == IntPtr.Zero ? "" : UserObjects.Granted(handle));
        }

        static void ReadClipboard(Json j, string key, string marker)
        {
            Native.SetLastError(0);
            bool opened = Native.OpenClipboard(IntPtr.Zero);
            int error = opened ? 0 : Marshal.GetLastWin32Error();
            string text = null;
            if (opened)
            {
                try { text = ClipboardOwner.Text(); }
                finally { Native.CloseClipboard(); }
            }
            j.Set(key + "_opened", opened).Set(key + "_error", (long)error).Set(key + "_marker", text != null && text.Contains(marker));
        }
    }

    sealed class WindowScan
    {
        readonly IntPtr target, self;
        readonly string title;
        public readonly Native.EnumProc Visit;
        public int Count;
        public bool SawTarget, SawTitle, SawSelf;

        public WindowScan(IntPtr target, string title, IntPtr self)
        {
            this.target = target;
            this.title = title;
            this.self = self;
            Visit = OnWindow;
        }

        public static string TitleOf(IntPtr window)
        {
            var text = new StringBuilder(256);
            Native.InternalGetWindowText(window, text, text.Capacity);
            return text.ToString();
        }

        bool OnWindow(IntPtr window, IntPtr unused)
        {
            Count++;
            if (window == target) SawTarget = true;
            if (self != IntPtr.Zero && window == self) SawSelf = true;
            if (TitleOf(window).Contains(title)) SawTitle = true;
            return true;
        }
    }

    // A low-level keyboard hook on the serve thread, whose message pump (Messages.Pump) delivers its calls;
    // the driver sends that probe no other command while the hook is armed. It keeps only counts and the
    // letters and digits it saw (at most 64), which is all the verdict needs.
    sealed class KeyboardHook
    {
        readonly StringBuilder physical = new StringBuilder(), all = new StringBuilder();
        readonly Native.HookProc callback;
        IntPtr hook;
        int events, injected;

        public KeyboardHook() { callback = OnKey; }

        public Json Start()
        {
            if (hook != IntPtr.Zero) return new Json().Set("installed", true).Set("note", "already started");
            events = injected = 0;
            physical.Length = 0;
            all.Length = 0;
            IntPtr module = Native.GetModuleHandleW(null);
            Native.SetLastError(0);
            hook = Native.SetWindowsHookExW(13, callback, module, 0);
            int error = hook == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            return new Json().Set("installed", hook != IntPtr.Zero).Set("error", (long)error);
        }

        public Json Stop()
        {
            if (hook == IntPtr.Zero) return new Json().Set("events", (long)events).Set("note", "not installed");
            Messages.Pump(200);
            Native.UnhookWindowsHookEx(hook);
            hook = IntPtr.Zero;
            return new Json().Set("events", (long)events).Set("injected", (long)injected)
                .Set("typed_physical", physical.ToString()).Set("typed_all", all.ToString());
        }

        IntPtr OnKey(int code, IntPtr message, IntPtr data)
        {
            long kind = message.ToInt64();
            if (code >= 0 && (kind == 0x100 || kind == 0x104))
            {
                int vk = Marshal.ReadInt32(data);
                bool synthetic = (Marshal.ReadInt32(data, 8) & 0x10) != 0;
                char key = vk == 0xE7 ? char.ToUpperInvariant((char)Marshal.ReadInt32(data, 4)) : (char)vk;
                events++;
                if (synthetic) injected++;
                if ((key >= 'A' && key <= 'Z') || (key >= '0' && key <= '9'))
                {
                    if (all.Length < 64) all.Append(key);
                    if (!synthetic && physical.Length < 64) physical.Append(key);
                }
            }
            return Native.CallNextHookEx(IntPtr.Zero, code, message, data);
        }
    }

    // Copies every clipboard format before the marker replaces them and puts all of them back afterwards.
    // A format whose data is a GDI or owner-drawn handle cannot be copied byte for byte, so a clipboard
    // holding one that Windows would not synthesize again from a copied format is refused and left alone.
    // The copies are kept until a restore puts every one of them back; Pending, which serve reports as
    // "restore_required" in every clipboard answer, is true from just before EmptyClipboard until then.
    sealed class ClipboardOwner
    {
        // CF_METAFILEPICT, CF_PALETTE, CF_ENHMETAFILE, CF_OWNERDISPLAY, CF_DSPBITMAP, CF_DSPMETAFILEPICT,
        // CF_DSPENHMETAFILE. CF_BITMAP (2) is handled apart: Windows synthesizes it from CF_DIB or CF_DIBV5.
        static readonly uint[] HandleFormats = { 3, 9, 14, 0x80, 0x82, 0x83, 0x8E };
        IntPtr window;
        List<KeyValuePair<uint, byte[]>> saved;

        public bool Pending { get { return saved != null; } }

        public Json Set(string marker)
        {
            if (saved != null) return new Json().Set("ok", false).Set("error", "an earlier replacement is not restored yet");
            if (window == IntPtr.Zero)
                window = Native.CreateWindowExW(0, "STATIC", "", 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (!Open(window)) return new Json().Set("ok", false).Set("error", "clipboard busy");
            try
            {
                // The enumeration ends with 0 and a last error of 0; 0 with any other error means it failed.
                var formats = new List<uint>();
                for (uint format = 0; ; )
                {
                    Native.SetLastError(0);
                    format = Native.EnumClipboardFormats(format);
                    if (format == 0) break;
                    formats.Add(format);
                }
                int enumError = Marshal.GetLastWin32Error();
                if (enumError != 0) return new Json().Set("ok", false).Set("refused", "EnumClipboardFormats failed with " + enumError);
                bool dib = formats.Contains(8) || formats.Contains(17);
                var copies = new List<KeyValuePair<uint, byte[]>>();
                foreach (uint format in formats)
                {
                    if ((format == 2 && !dib) || Array.IndexOf(HandleFormats, format) >= 0 || (format >= 0x300 && format <= 0x3FF))
                        return new Json().Set("ok", false).Set("refused", "clipboard format " + format + " cannot be preserved");
                    if (format == 2) continue;
                    byte[] data = Copy(Native.GetClipboardData(format));
                    if (data == null) return new Json().Set("ok", false).Set("refused", "clipboard format " + format + " could not be copied");
                    copies.Add(new KeyValuePair<uint, byte[]>(format, data));
                }
                saved = copies;
                if (!Native.EmptyClipboard()) return new Json().Set("ok", false).Set("error", "EmptyClipboard " + Marshal.GetLastWin32Error());
                return new Json().Set("ok", Put(13, Encoding.Unicode.GetBytes(marker + "\0"))).Set("saved_formats", (long)copies.Count);
            }
            finally { Native.CloseClipboard(); }
        }

        public Json Restore()
        {
            if (saved == null) return new Json().Set("ok", true).Set("note", "nothing to restore");
            if (!Open(window)) return new Json().Set("ok", false).Set("error", "clipboard busy");
            try
            {
                if (!Native.EmptyClipboard()) return new Json().Set("ok", false).Set("error", "EmptyClipboard " + Marshal.GetLastWin32Error());
                int restored = 0;
                foreach (var item in saved) if (Put(item.Key, item.Value)) restored++;
                var result = new Json().Set("ok", restored == saved.Count).Set("restored_formats", (long)restored).Set("saved_formats", (long)saved.Count);
                if (restored == saved.Count) saved = null;
                return result;
            }
            finally { Native.CloseClipboard(); }
        }

        static byte[] Copy(IntPtr data)
        {
            if (data == IntPtr.Zero) return null;
            long size = (long)Native.GlobalSize(data).ToUInt64();
            IntPtr source = Native.GlobalLock(data);
            if (source == IntPtr.Zero || size <= 0 || size > int.MaxValue) return null;
            try
            {
                var bytes = new byte[size];
                Marshal.Copy(source, bytes, 0, bytes.Length);
                return bytes;
            }
            finally { Native.GlobalUnlock(data); }
        }

        public static string Text()
        {
            IntPtr data = Native.GetClipboardData(13);
            if (data == IntPtr.Zero) return null;
            IntPtr text = Native.GlobalLock(data);
            if (text == IntPtr.Zero) return null;
            try { return Marshal.PtrToStringUni(text); }
            finally { Native.GlobalUnlock(data); }
        }

        static bool Open(IntPtr owner)
        {
            for (int attempt = 0; attempt < 40; attempt++)
            {
                if (Native.OpenClipboard(owner)) return true;
                Thread.Sleep(50);
            }
            return false;
        }

        static bool Put(uint format, byte[] raw)
        {
            IntPtr memory = Native.GlobalAlloc(0x2, new UIntPtr((uint)Math.Max(raw.Length, 1)));
            if (memory == IntPtr.Zero) return false;
            IntPtr target = Native.GlobalLock(memory);
            if (target == IntPtr.Zero) { Native.GlobalFree(memory); return false; }
            Marshal.Copy(raw, 0, target, raw.Length);
            Native.GlobalUnlock(memory);
            if (Native.SetClipboardData(format, memory) != IntPtr.Zero) return true;
            Native.GlobalFree(memory);
            return false;
        }
    }

    static class Pixels
    {
        // Per-channel slack for colour management and dithering between the painted and the read value.
        const int Tolerance = 12;

        public static long Count(IntPtr bits, int stride, int width, int height, byte r, byte g, byte b)
        {
            var row = new byte[width * 4];
            long matched = 0;
            for (int y = 0; y < height; y++)
            {
                Marshal.Copy(new IntPtr(bits.ToInt64() + (long)y * stride), row, 0, row.Length);
                for (int x = 0; x < row.Length; x += 4)
                {
                    if (Math.Abs(row[x] - b) <= Tolerance && Math.Abs(row[x + 1] - g) <= Tolerance && Math.Abs(row[x + 2] - r) <= Tolerance)
                        matched++;
                }
            }
            return matched;
        }
    }

    // Desktop Duplication through raw COM vtable slots (d3d11.h / dxgi1_2.h order), so the program needs no
    // interop assembly.
    static class Duplication
    {
        const int WaitTimeout = unchecked((int)0x887A0027);
        // Stops reading frames once this many pixels match; the driver's own threshold is the same.
        const long Enough = 1000;
        static readonly Guid DxgiFactory1 = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
        static readonly Guid DxgiOutput1 = new Guid("00cddea8-939b-4b83-a340-a685226666cc");
        static readonly Guid Texture2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");

        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int QueryInterfaceFn(IntPtr self, ref Guid iid, out IntPtr result);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate uint ReleaseFn(IntPtr self);
        // IDXGIFactory::EnumAdapters and IDXGIAdapter::EnumOutputs, both slot 7.
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumFn(IntPtr self, uint index, out IntPtr item);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DuplicateOutputFn(IntPtr self, IntPtr device, out IntPtr duplication);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int AcquireNextFrameFn(IntPtr self, uint timeout, IntPtr info, out IntPtr resource);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ReleaseFrameFn(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void GetDescFn(IntPtr self, out TextureDesc desc);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTexture2DFn(IntPtr self, ref TextureDesc desc, IntPtr initial, out IntPtr texture);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyResourceFn(IntPtr self, IntPtr destination, IntPtr source);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int MapFn(IntPtr self, IntPtr resource, uint subresource, int type, uint flags, out Mapped mapped);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void UnmapFn(IntPtr self, IntPtr resource, uint subresource);

        [StructLayout(LayoutKind.Sequential)]
        struct TextureDesc { public uint Width, Height, MipLevels, ArraySize; public int Format; public uint SampleCount, SampleQuality; public int Usage; public uint BindFlags, CpuAccess, Misc; }

        [StructLayout(LayoutKind.Sequential)]
        struct Mapped { public IntPtr Data; public uint RowPitch, DepthPitch; }

        // Every output of every adapter, keyed a<adapter>o<output> in "outputs", each with its own
        // DuplicateOutput HRESULT, frames acquired, frames actually checked, best marker match and any error.
        // "error" at the top means the adapters themselves could not be listed.
        public static Json Count(byte r, byte g, byte b)
        {
            var j = new Json();
            var owned = new List<IntPtr>();
            var keys = new List<string>();
            try
            {
                IntPtr factory;
                Guid iid = DxgiFactory1;
                Check(Native.CreateDXGIFactory1(ref iid, out factory), "CreateDXGIFactory1");
                owned.Add(factory);
                for (uint a = 0; a < 8; a++)
                {
                    IntPtr adapter;
                    if (Method<EnumFn>(factory, 7)(factory, a, out adapter) < 0) break;
                    owned.Add(adapter);
                    for (uint o = 0; o < 16; o++)
                    {
                        IntPtr output;
                        if (Method<EnumFn>(adapter, 7)(adapter, o, out output) < 0) break;
                        owned.Add(output);
                        string key = "a" + a + "o" + o;
                        keys.Add(key);
                        Output(j, key, adapter, output, r, g, b);
                    }
                }
            }
            catch (InvalidOperationException error) { j.Set("error", error.Message); }
            finally
            {
                for (int i = owned.Count - 1; i >= 0; i--) Method<ReleaseFn>(owned[i], 2)(owned[i]);
            }
            return j.Set("outputs", string.Join(";", keys.ToArray()));
        }

        static void Output(Json j, string key, IntPtr adapter, IntPtr output, byte r, byte g, byte b)
        {
            var owned = new List<IntPtr>();
            long acquired = 0, examined = 0, matched = 0;
            string duplicateHr = "not called";
            try
            {
                IntPtr device, context;
                int level;
                // D3D_DRIVER_TYPE_UNKNOWN: required when an adapter is named, and duplication needs that adapter's device.
                Check(Native.D3D11CreateDevice(adapter, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, 7, out device, out level, out context), "D3D11CreateDevice");
                owned.Add(device);
                owned.Add(context);
                IntPtr output1 = Query(output, DxgiOutput1, owned);
                IntPtr duplication;
                int hr = Method<DuplicateOutputFn>(output1, 22)(output1, device, out duplication);
                duplicateHr = Json.Hex((uint)hr);
                if (hr < 0) return;
                owned.Add(duplication);
                Frames(device, context, duplication, r, g, b, ref acquired, ref examined, ref matched);
            }
            catch (InvalidOperationException error) { j.Set(key + "_error", error.Message); }
            finally
            {
                for (int i = owned.Count - 1; i >= 0; i--) Method<ReleaseFn>(owned[i], 2)(owned[i]);
                j.Set(key + "_duplicate_hr", duplicateHr).Set(key + "_acquired", acquired).Set(key + "_checked", examined).Set(key + "_matched", matched);
            }
        }

        static void Frames(IntPtr device, IntPtr context, IntPtr duplication, byte r, byte g, byte b, ref long acquired, ref long examined, ref long best)
        {
            IntPtr info = Marshal.AllocHGlobal(64);
            try
            {
                for (int attempt = 0; attempt < 8 && best < Enough; attempt++)
                {
                    IntPtr resource;
                    int hr = Method<AcquireNextFrameFn>(duplication, 8)(duplication, 500, info, out resource);
                    if (hr == WaitTimeout) continue;
                    Check(hr, "AcquireNextFrame");
                    acquired++;
                    var texture = new List<IntPtr>();
                    try
                    {
                        best = Math.Max(best, CountTexture(device, context, Query(resource, Texture2D, texture), r, g, b));
                        examined++;
                    }
                    finally
                    {
                        foreach (IntPtr item in texture) Method<ReleaseFn>(item, 2)(item);
                        Method<ReleaseFn>(resource, 2)(resource);
                        Method<ReleaseFrameFn>(duplication, 14)(duplication);
                    }
                }
            }
            finally { Marshal.FreeHGlobal(info); }
        }

        static long CountTexture(IntPtr device, IntPtr context, IntPtr texture, byte r, byte g, byte b)
        {
            TextureDesc desc;
            Method<GetDescFn>(texture, 10)(texture, out desc);
            if (desc.Format != 87 && desc.Format != 91) throw new InvalidOperationException("desktop surface format " + desc.Format + " is not B8G8R8A8");
            desc.MipLevels = 1;
            desc.ArraySize = 1;
            desc.SampleCount = 1;
            desc.SampleQuality = 0;
            desc.Usage = 3;
            desc.BindFlags = 0;
            desc.CpuAccess = 0x20000;
            desc.Misc = 0;
            IntPtr staging;
            Check(Method<CreateTexture2DFn>(device, 5)(device, ref desc, IntPtr.Zero, out staging), "CreateTexture2D");
            try
            {
                Method<CopyResourceFn>(context, 47)(context, staging, texture);
                Mapped mapped;
                Check(Method<MapFn>(context, 14)(context, staging, 0, 1, 0, out mapped), "Map");
                try { return Pixels.Count(mapped.Data, (int)mapped.RowPitch, (int)desc.Width, (int)desc.Height, r, g, b); }
                finally { Method<UnmapFn>(context, 15)(context, staging, 0); }
            }
            finally { Method<ReleaseFn>(staging, 2)(staging); }
        }

        static IntPtr Query(IntPtr instance, Guid iid, List<IntPtr> owned)
        {
            IntPtr result;
            Check(Method<QueryInterfaceFn>(instance, 0)(instance, ref iid, out result), "QueryInterface " + iid);
            owned.Add(result);
            return result;
        }

        static void Check(int hr, string what)
        {
            if (hr < 0) throw new InvalidOperationException(what + " " + Json.Hex((uint)hr));
        }

        static T Method<T>(IntPtr instance, int slot) where T : class
        {
            IntPtr table = Marshal.ReadIntPtr(instance);
            return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, slot * IntPtr.Size), typeof(T));
        }
    }

    static class Residual
    {
        // targets.txt lines: "pid<TAB>label<TAB>pid" or "path<TAB>label<TAB>path", written by the driver.
        public static Json Run(string targets)
        {
            var j = new Json();
            foreach (string line in File.ReadAllLines(targets))
            {
                string[] field = line.Split('\t');
                if (field.Length != 3) continue;
                if (field[0] == "pid") j.Set("proc_" + field[1] + "_" + field[2], OpenProcess(uint.Parse(field[2], CultureInfo.InvariantCulture)));
                else if (field[0] == "path") j.Set("path_" + field[1], List(field[2]));
            }
            uint session;
            Native.ProcessIdToSessionId(Native.GetCurrentProcessId(), out session);
            NamedObjects(j, "bno_local", @"\Sessions\" + session + @"\BaseNamedObjects", @"Local\");
            NamedObjects(j, "bno_global", @"\BaseNamedObjects", @"Global\");
            IntPtr created = Native.CreateMutexW(IntPtr.Zero, false, @"Local\SuperClawGuiProbe-" + Native.GetCurrentProcessId());
            j.Set("local_create", created != IntPtr.Zero ? "created" : "error " + Marshal.GetLastWin32Error());
            if (created != IntPtr.Zero) Native.CloseHandle(created);
            return j.Set("pipes_visible", Pipes());
        }

        static string OpenProcess(uint pid)
        {
            IntPtr process = Native.OpenProcess(Native.MAXIMUM_ALLOWED, false, pid);
            if (process == IntPtr.Zero) return "denied " + Marshal.GetLastWin32Error();
            try { return "opened " + UserObjects.Granted(process); }
            finally { Native.CloseHandle(process); }
        }

        static string List(string path)
        {
            try
            {
                using (var entries = Directory.EnumerateFileSystemEntries(path).GetEnumerator())
                    return entries.MoveNext() ? "listable" : "listable, empty";
            }
            catch (UnauthorizedAccessException) { return "denied"; }
            catch (IOException error) { return "error " + error.GetType().Name; }
        }

        // Opens every event, mutant, semaphore and section in one object directory by name with the least
        // right that proves it is reachable (SYNCHRONIZE, or FILE_MAP_READ), closing each at once.
        static void NamedObjects(Json j, string key, string directory, string prefix)
        {
            IntPtr handle;
            int status = Nt.OpenDirectory(directory, out handle);
            j.Set(key + "_directory", status == 0 ? "opened" : "status " + Json.Hex((uint)status));
            if (status != 0) return;
            var tried = new SortedDictionary<string, int>();
            var opened = new SortedDictionary<string, int>();
            var names = new List<string>();
            int entries = 0;
            IntPtr buffer = Marshal.AllocHGlobal(4096);
            try
            {
                uint context = 0;
                int length;
                for (bool restart = true; entries < 5000; restart = false)
                {
                    if (Native.NtQueryDirectoryObject(handle, buffer, 4096, true, restart, ref context, out length) != 0) break;
                    entries++;
                    string name = Nt.String(buffer), type = Nt.String(new IntPtr(buffer.ToInt64() + 16));
                    bool? reachable = OpenNamed(type, prefix + name);
                    if (reachable == null) continue;
                    tried[type] = (tried.ContainsKey(type) ? tried[type] : 0) + 1;
                    if (reachable != true) continue;
                    opened[type] = (opened.ContainsKey(type) ? opened[type] : 0) + 1;
                    if (names.Count < 8) names.Add(type + ":" + name);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
                Native.CloseHandle(handle);
            }
            var tally = new List<string>();
            foreach (var type in tried) tally.Add(type.Key + " " + (opened.ContainsKey(type.Key) ? opened[type.Key] : 0) + "/" + type.Value);
            j.Set(key + "_entries", (long)entries).Set(key + "_opened", string.Join(", ", tally.ToArray()))
             .Set(key + "_opened_examples", string.Join("; ", names.ToArray()));
        }

        static bool? OpenNamed(string type, string name)
        {
            IntPtr handle;
            switch (type)
            {
                case "Event": handle = Native.OpenEventW(0x100000, false, name); break;
                case "Mutant": handle = Native.OpenMutexW(0x100000, false, name); break;
                case "Semaphore": handle = Native.OpenSemaphoreW(0x100000, false, name); break;
                case "Section": handle = Native.OpenFileMappingW(0x4, false, name); break;
                default: return null;
            }
            if (handle == IntPtr.Zero) return false;
            Native.CloseHandle(handle);
            return true;
        }

        static long Pipes()
        {
            IntPtr data = Marshal.AllocHGlobal(1024);
            try
            {
                IntPtr find = Native.FindFirstFileW(@"\\.\pipe\*", data);
                if (find == new IntPtr(-1)) return -1;
                long count = 1;
                while (Native.FindNextFileW(find, data)) count++;
                Native.FindClose(find);
                return count;
            }
            finally { Marshal.FreeHGlobal(data); }
        }
    }

    static class Nt
    {
        public static int OpenDirectory(string path, out IntPtr handle)
        {
            IntPtr text = Marshal.StringToHGlobalUni(path);
            IntPtr name = Marshal.AllocHGlobal(16);
            try
            {
                Marshal.WriteInt16(name, 0, (short)(path.Length * 2));
                Marshal.WriteInt16(name, 2, (short)(path.Length * 2 + 2));
                Marshal.WriteInt32(name, 4, 0);
                Marshal.WriteIntPtr(name, 8, text);
                var attributes = new ObjectAttributes { Length = Marshal.SizeOf(typeof(ObjectAttributes)), ObjectName = name, Attributes = 0x40 };
                return Native.NtOpenDirectoryObject(out handle, 0x3, ref attributes);
            }
            finally
            {
                Marshal.FreeHGlobal(name);
                Marshal.FreeHGlobal(text);
            }
        }

        public static string String(IntPtr unicodeString)
        {
            int length = (ushort)Marshal.ReadInt16(unicodeString);
            IntPtr buffer = Marshal.ReadIntPtr(unicodeString, 8);
            return buffer == IntPtr.Zero ? "" : Marshal.PtrToStringUni(buffer, length / 2);
        }
    }
}
