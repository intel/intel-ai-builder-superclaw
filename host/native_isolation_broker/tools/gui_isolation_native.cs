// gui_isolation_native.cs: the Win32 declarations of the verification program of
// tools/gui_isolation_acceptance.ps1 (#3499, #3400). Not part of either product binary.

using System;
using System.Runtime.InteropServices;
using System.Text;

namespace GuiIsolation
{
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    struct INPUT
    {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public ushort wVk;
        [FieldOffset(10)] public ushort wScan;
        [FieldOffset(12)] public uint dwFlags;
        [FieldOffset(16)] public uint time;
        [FieldOffset(24)] public IntPtr extra;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER
    {
        public int biSize, biWidth, biHeight;
        public short biPlanes, biBitCount;
        public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ObjectAttributes { public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }

    static class Native
    {
        public const uint MAXIMUM_ALLOWED = 0x02000000;
        public delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
        public delegate bool EnumProc(IntPtr window, IntPtr parameter);

        const string K = "kernel32.dll", U = "user32.dll", G = "gdi32.dll", A = "advapi32.dll", N = "ntdll.dll";

        [DllImport(U)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport(U)] public static extern bool SetProcessDPIAware();
        [DllImport(K)] public static extern IntPtr GetCurrentProcess();
        [DllImport(K)] public static extern uint GetCurrentProcessId();
        [DllImport(K)] public static extern uint GetCurrentThreadId();
        [DllImport(K, SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
        [DllImport(K, SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport(K, SetLastError = true)] public static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
        [DllImport(K, SetLastError = true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
        [DllImport(K, SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out uint info, int length, IntPtr returned);
        [DllImport(K)] public static extern bool ProcessIdToSessionId(uint pid, out uint session);
        [DllImport(K, SetLastError = true)] public static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
        [DllImport(K, CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);
        [DllImport(K)] public static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
        [DllImport(K)] public static extern IntPtr GlobalLock(IntPtr memory);
        [DllImport(K)] public static extern bool GlobalUnlock(IntPtr memory);
        [DllImport(K)] public static extern IntPtr GlobalFree(IntPtr memory);
        [DllImport(K, CharSet = CharSet.Unicode, SetLastError = true)] public static extern ushort GlobalAddAtomW(string name);
        [DllImport(K, CharSet = CharSet.Unicode)] public static extern ushort GlobalFindAtomW(string name);
        [DllImport(K)] public static extern ushort GlobalDeleteAtom(ushort atom);
        [DllImport(K, CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateMutexW(IntPtr attributes, bool owner, string name);
        [DllImport(K, CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr OpenEventW(uint access, bool inherit, string name);
        [DllImport(K, CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr OpenMutexW(uint access, bool inherit, string name);
        [DllImport(K, CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr OpenSemaphoreW(uint access, bool inherit, string name);
        [DllImport(K, CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr OpenFileMappingW(uint access, bool inherit, string name);
        [DllImport(K, CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr FindFirstFileW(string pattern, IntPtr data);
        [DllImport(K, SetLastError = true)] public static extern bool FindNextFileW(IntPtr find, IntPtr data);
        [DllImport(K)] public static extern bool FindClose(IntPtr find);
        [DllImport(K, CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandleW(string name);
        [DllImport(K)] public static extern IntPtr LocalFree(IntPtr memory);
        [DllImport(K)] public static extern void SetLastError(uint code);
        [DllImport(K, SetLastError = true)] public static extern uint ResumeThread(IntPtr thread);
        [DllImport(K, CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetLongPathNameW(string path, StringBuilder longPath, uint length);
        [DllImport(K)] public static extern UIntPtr GlobalSize(IntPtr memory);
        [DllImport(K, SetLastError = true)] public static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
        [DllImport(K, SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint code);

        [DllImport(U)] public static extern IntPtr GetProcessWindowStation();
        [DllImport(U)] public static extern IntPtr GetThreadDesktop(uint thread);
        [DllImport(U, SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr desktop);
        [DllImport(U, SetLastError = true)] public static extern bool GetUserObjectInformationW(IntPtr handle, int index, byte[] info, int length, out int needed);
        [DllImport(U, CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr OpenWindowStationW(string name, bool inherit, uint access);
        [DllImport(U, SetLastError = true)] public static extern bool CloseWindowStation(IntPtr station);
        [DllImport(U, SetLastError = true)] public static extern bool SetProcessWindowStation(IntPtr station);
        [DllImport(U, CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);
        [DllImport(U, SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport(U, SetLastError = true)] public static extern bool CloseDesktop(IntPtr desktop);
        [DllImport(U, SetLastError = true)] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
        [DllImport(U, SetLastError = true)] public static extern bool EnumDesktopWindows(IntPtr desktop, EnumProc callback, IntPtr parameter);
        [DllImport(U)] public static extern bool IsWindow(IntPtr window);
        [DllImport(U, CharSet = CharSet.Unicode)] public static extern int InternalGetWindowText(IntPtr window, StringBuilder text, int length);
        [DllImport(U)] public static extern IntPtr GetForegroundWindow();
        [DllImport(U, SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport(U, SetLastError = true)] public static extern bool PostMessageW(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
        [DllImport(U, SetLastError = true)] public static extern IntPtr SendMessageTimeoutW(IntPtr window, int message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
        [DllImport(U, SetLastError = true)] public static extern IntPtr SetWindowsHookExW(int id, HookProc callback, IntPtr module, uint thread);
        [DllImport(U)] public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport(U)] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
        [DllImport(U)] public static extern bool PeekMessageW(out MSG message, IntPtr window, uint min, uint max, uint remove);
        [DllImport(U)] public static extern bool TranslateMessage(ref MSG message);
        [DllImport(U)] public static extern IntPtr DispatchMessageW(ref MSG message);
        [DllImport(U, SetLastError = true)] public static extern bool OpenClipboard(IntPtr owner);
        [DllImport(U)] public static extern bool CloseClipboard();
        [DllImport(U)] public static extern bool EmptyClipboard();
        [DllImport(U)] public static extern IntPtr GetClipboardData(uint format);
        [DllImport(U, SetLastError = true)] public static extern uint EnumClipboardFormats(uint format);
        [DllImport(U)] public static extern IntPtr SetClipboardData(uint format, IntPtr memory);
        [DllImport(U, CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateWindowExW(uint exStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
        [DllImport(U, SetLastError = true)] public static extern IntPtr GetDC(IntPtr window);
        [DllImport(U)] public static extern bool DestroyWindow(IntPtr window);
        [DllImport(U)] public static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport(U)] public static extern int GetSystemMetrics(int index);

        [DllImport(G, SetLastError = true)] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport(G, SetLastError = true)] public static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER info, uint usage, out IntPtr bits, IntPtr section, uint offset);
        [DllImport(G)] public static extern IntPtr SelectObject(IntPtr dc, IntPtr gdiObject);
        [DllImport(G, SetLastError = true)] public static extern bool BitBlt(IntPtr destination, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint rop);
        [DllImport(G)] public static extern bool DeleteObject(IntPtr gdiObject);
        [DllImport(G)] public static extern bool DeleteDC(IntPtr dc);

        [DllImport(A, SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport(A, SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int needed);
        [DllImport(A)] public static extern bool IsTokenRestricted(IntPtr token);
        [DllImport(A, SetLastError = true)] public static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);

        [DllImport(N)] public static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr[] info, int length, out int returned);
        [DllImport(N, EntryPoint = "NtQueryObject")] public static extern int NtQueryObjectBasic(IntPtr handle, int infoClass, uint[] info, int length, out int returned);
        [DllImport(N)] public static extern int NtQueryObject(IntPtr handle, int infoClass, IntPtr info, int length, out int returned);
        [DllImport(N)] public static extern int NtOpenDirectoryObject(out IntPtr handle, uint access, ref ObjectAttributes attributes);
        [DllImport(N)] public static extern int NtQueryDirectoryObject(IntPtr directory, IntPtr buffer, int length, [MarshalAs(UnmanagedType.U1)] bool single, [MarshalAs(UnmanagedType.U1)] bool restart, ref uint context, out int returned);

        [DllImport("dxgi.dll")] public static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
        [DllImport("d3d11.dll")] public static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint levelCount, uint sdkVersion, out IntPtr device, out int level, out IntPtr context);
    }
}
