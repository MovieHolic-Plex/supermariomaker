param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public class NeutralWindow : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
}
public static class ForegroundProbe {
    delegate void WinEventDelegate(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
    delegate bool EnumDelegate(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventDelegate callback, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int size);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumDelegate callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetShortPathName(string path, StringBuilder shortPath, uint size);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public MouseInput Mouse; }
    static readonly Dictionary<IntPtr, bool> OriginalTopmost = new Dictionary<IntPtr, bool>();
    static readonly Dictionary<IntPtr, uint> Owned = new Dictionary<IntPtr, uint>();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly object OutputLock = new object();
    static WinEventDelegate Callback;
    static IntPtr Hook;
    static Control Dispatch;
    static ApplicationContext Context;
    static NeutralWindow Neutral;
    static Thread Reader;
    static bool Stopping;
    static object Owner(IntPtr hwnd) {
        uint pid; uint thread = GetWindowThreadProcessId(hwnd, out pid);
        StringBuilder cls = new StringBuilder(256); GetClassName(hwnd, cls, cls.Capacity);
        string exe = null, error = null;
        if (pid != 0) {
            try { using (Process p = Process.GetProcessById((int)pid)) { exe = p.ProcessName + ".exe"; } }
            catch (Exception e) { error = e.GetType().Name + ": " + e.Message; }
        }
        Rect rect; bool rectOk = GetWindowRect(hwnd, out rect);
        return new { hwnd = hwnd.ToInt64().ToString(), pid = pid, thread = thread, windowClass = cls.ToString(), executable = exe, lookupError = error,
            visible = IsWindowVisible(hwnd), style = GetWindowLongPtr(hwnd, -16).ToInt64(), extendedStyle = GetWindowLongPtr(hwnd, -20).ToInt64(),
            topmost = (GetWindowLongPtr(hwnd, -20).ToInt64() & 8) != 0, previousZ = GetWindow(hwnd, 3).ToInt64().ToString(),
            rect = rectOk ? new int[] {rect.Left, rect.Top, rect.Right, rect.Bottom} : null };
    }
    static void Emit(string kind, object data) {
        lock (OutputLock) {
            Console.WriteLine(Json.Serialize(new { source = "win32", kind = kind, wallMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                qpc = Stopwatch.GetTimestamp(), qpcFrequency = Stopwatch.Frequency, uptimeMs = GetTickCount64(), data = data }));
            Console.Out.Flush();
        }
    }
    static void RestoreTopmost() {
        foreach (var saved in new List<KeyValuePair<IntPtr, bool>>(OriginalTopmost)) {
            uint pid; GetWindowThreadProcessId(saved.Key, out pid);
            if (pid != Owned[saved.Key]) throw new InvalidOperationException("Restoration target identity changed");
            Emit("topmost-restore-before", new { target = Owner(saved.Key), originalTopmost = saved.Value });
            bool ok = SetWindowPos(saved.Key, new IntPtr(saved.Value ? -1 : -2), 0, 0, 0, 0, 0x13);
            int error = Marshal.GetLastWin32Error();
            Emit("topmost-restore-after", new { ok = ok, lastError = error, target = Owner(saved.Key), originalTopmost = saved.Value });
            if (!ok) throw new System.ComponentModel.Win32Exception(error);
            if (((GetWindowLongPtr(saved.Key, -20).ToInt64() & 8) != 0) != saved.Value) throw new InvalidOperationException("Owned topmost restoration mismatch");
            OriginalTopmost.Remove(saved.Key);
        }
    }
    static void Stop() {
        if (Stopping) return; Stopping = true;
        try { RestoreTopmost(); }
        finally {
            if (Neutral != null) { Neutral.Close(); Neutral.Dispose(); Emit("neutral-disposed", null); }
            if (Hook != IntPtr.Zero) { bool ok = UnhookWinEvent(Hook); Hook = IntPtr.Zero; Emit("hook-unregistered", new { ok = ok }); }
            Context.ExitThread();
        }
    }
    static void Command(string line) {
        string id = null;
        try {
            var c = Json.Deserialize<Dictionary<string, object>>(line);
            id = (string)c["id"]; string op = (string)c["op"];
            Emit("command-before", new { id = id, op = op, foreground = Owner(GetForegroundWindow()) });
            object result;
            switch (op) {
                case "sample": result = Owner(GetForegroundWindow()); break;
                case "restore": RestoreTopmost(); result = new { remaining = OriginalTopmost.Count }; break;
                case "windows": {
                    uint pid = Convert.ToUInt32(c["pid"]); var windows = new List<object>();
                    EnumDelegate enumerate = delegate(IntPtr hwnd, IntPtr data) { uint p; GetWindowThreadProcessId(hwnd, out p); if (p == pid) { windows.Add(Owner(hwnd)); Owned[hwnd] = pid; } return true; };
                    bool ok = EnumWindows(enumerate, IntPtr.Zero); GC.KeepAlive(enumerate);
                    result = new { ok = ok, windows = windows }; break;
                }
                case "click": {
                    IntPtr hwnd = new IntPtr(Int64.Parse((string)c["hwnd"])); uint pid;
                    GetWindowThreadProcessId(hwnd, out pid);
                    if (!Owned.ContainsKey(hwnd) || Owned[hwnd] != pid || pid != Convert.ToUInt32(c["pid"]) || !IsWindowVisible(hwnd)) throw new InvalidOperationException("Click target ownership precondition failed");
                    bool neutralTarget = Neutral != null && hwnd == Neutral.Handle;
                    if (!neutralTarget && !OriginalTopmost.ContainsKey(hwnd)) {
                        OriginalTopmost.Add(hwnd, (GetWindowLongPtr(hwnd, -20).ToInt64() & 8) != 0);
                        Emit("owned-original-window", new { id = id, target = Owner(hwnd), originalTopmost = OriginalTopmost[hwnd] });
                    }
                    Emit("topmost-raise-before", new { id = id, target = Owner(hwnd), insertAfter = neutralTarget ? "HWND_TOP" : "HWND_TOPMOST", flags = 0x13 });
                    bool raised = SetWindowPos(hwnd, new IntPtr(neutralTarget ? 0 : -1), 0, 0, 0, 0, 0x13);
                    int raiseError = Marshal.GetLastWin32Error();
                    Emit("topmost-raise-after", new { id = id, ok = raised, lastError = raiseError, target = Owner(hwnd) });
                    if (!raised) throw new System.ComponentModel.Win32Exception(raiseError);
                    Rect client; if (!GetClientRect(hwnd, out client)) throw new InvalidOperationException("Missing owned native client bounds");
                    uint dpi = GetDpiForWindow(hwnd);
                    // Native PMv2 client center: away from Chrome caption, tabs, omnibox, and window borders.
                    Point local = new Point { X = (client.Left + client.Right) / 2, Y = (client.Top + client.Bottom) / 2 };
                    if (local.X <= client.Left || local.X >= client.Right || local.Y <= client.Top || local.Y >= client.Bottom) throw new InvalidOperationException("Missing client interior");
                    Point point = local;
                    if (!ClientToScreen(hwnd, ref point)) throw new InvalidOperationException("ClientToScreen failed");
                    IntPtr atPoint = WindowFromPoint(point), root = GetAncestor(atPoint, 2);
                    Emit("owned-client-probe", new { id = id, target = Owner(hwnd), dpi = dpi, client = client, clientPoint = local, point = point,
                        exactPointOwner = Owner(atPoint), rootPointOwner = Owner(root), foreground = Owner(GetForegroundWindow()) });
                    if (root != hwnd) throw new InvalidOperationException("Owned client click point is occluded by root HWND " + root);
                    int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
                    if (point.X < left || point.Y < top || point.X >= left + width || point.Y >= top + height) throw new InvalidOperationException("Click outside virtual desktop");
                    int x = (int)(((long)(point.X - left) * 65536 + 32768) / width);
                    int y = (int)(((long)(point.Y - top) * 65536 + 32768) / height);
                    Emit("owned-click-before", new { id = id, target = Owner(hwnd), pointOwner = Owner(atPoint), dpi = dpi,
                        coordinates = "PMv2 physical client -> screen -> SendInput absolute virtual desktop; no CDP coordinates", point = point,
                        virtualDesktop = new int[] {left, top, width, height}, absolute = new int[] {x, y}, foreground = Owner(GetForegroundWindow()) });
                    GetWindowThreadProcessId(hwnd, out pid);
                    if (Owned[hwnd] != pid || GetAncestor(WindowFromPoint(point), 2) != hwnd) throw new InvalidOperationException("Client point ownership changed before SendInput");
                    Input[] inputs = new Input[] {
                        new Input { Mouse = new MouseInput { X = x, Y = y, Flags = 0xC001 } },
                        new Input { Mouse = new MouseInput { Flags = 2 } },
                        new Input { Mouse = new MouseInput { Flags = 4 } }
                    };
                    uint sent = SendInput(3, inputs, Marshal.SizeOf(typeof(Input)));
                    int inputError = Marshal.GetLastWin32Error();
                    Emit("send-input-result", new { id = id, sent = sent, expected = 3, lastError = inputError });
                    if (sent != 3) throw new System.ComponentModel.Win32Exception(inputError, "SendInput incomplete: " + sent);
                    result = new { sent = sent, target = Owner(hwnd), foreground = Owner(GetForegroundWindow()) };
                    Emit("owned-click-after", new { id = id, result = result }); break;
                }
                case "neutral": {
                    Emit("neutral-register-before", new { ownerPid = Process.GetCurrentProcess().Id, showWithoutActivation = true });
                    Neutral = new NeutralWindow(); Neutral.Text = "Owned foreground diagnosis";
                    Neutral.StartPosition = FormStartPosition.Manual; Neutral.Width = 320; Neutral.Height = 160;
                    Neutral.Left = Screen.PrimaryScreen.WorkingArea.Right - Neutral.Width - 30; Neutral.Top = 30;
                    Emit("neutral-create-before", new { showWithoutActivation = true });
                    Neutral.Show(); Owned[Neutral.Handle] = (uint)Process.GetCurrentProcess().Id; result = Owner(Neutral.Handle);
                    Emit("neutral-created", result); break;
                }
                case "short-path": {
                    StringBuilder text = new StringBuilder(4096); uint count = GetShortPathName((string)c["path"], text, (uint)text.Capacity);
                    if (count == 0 || count >= text.Capacity) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                    result = new { path = text.ToString(), length = count }; break;
                }
                case "alive": {
                    var live = new List<int>(); foreach (object value in (System.Collections.IEnumerable)c["pids"]) {
                        int pid = Convert.ToInt32(value);
                        try { using (Process p = Process.GetProcessById(pid)) { if (!p.HasExited) live.Add(pid); } }
                        catch (ArgumentException) { }
                    }
                    result = new { live = live }; break;
                }
                case "stop": result = new { stopping = true }; break;
                default: throw new ArgumentException("Unknown command: " + op);
            }
            Emit("reply", new { id = id, op = op, result = result, foreground = Owner(GetForegroundWindow()) });
            if (op == "stop") Stop();
        } catch (Exception e) { Emit("command-error", new { id = id, error = e.ToString() }); }
    }
    public static void Run() {
        IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previousDpi == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        Emit("dpi-context", new { context = "PER_MONITOR_AWARE_V2", previous = previousDpi.ToInt64().ToString(), inputSize = Marshal.SizeOf(typeof(Input)) });
        Application.EnableVisualStyles();
        Dispatch = new Control(); IntPtr handle = Dispatch.Handle; Context = new ApplicationContext();
        Callback = delegate(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time) {
            Emit("foreground-event", new { eventCode = ev, eventTimeMs = time, eventThread = thread, objectId = obj, childId = child,
                owner = Owner(hwnd), foreground = Owner(GetForegroundWindow()) });
        };
        Emit("hook-register-before", new { eventMin = 3, eventMax = 3, flags = 0, delegateRooted = true, messageThread = Thread.CurrentThread.ManagedThreadId });
        Hook = SetWinEventHook(3, 3, IntPtr.Zero, Callback, 0, 0, 0);
        if (Hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        Emit("hook-registered", new { hook = Hook.ToInt64().ToString(), foreground = Owner(GetForegroundWindow()) });
        Reader = new Thread(delegate() {
            string line; while ((line = Console.ReadLine()) != null) { string captured = line; Dispatch.BeginInvoke(new Action(delegate() { Command(captured); })); }
            if (!Stopping) Dispatch.BeginInvoke(new Action(Stop));
        });
        Reader.IsBackground = true; Reader.Start();
        Emit("message-loop-ready", new { helperPid = Process.GetCurrentProcess().Id });
        try { Application.Run(Context); }
        finally { Stop(); Dispatch.Dispose(); Context.Dispose(); GC.KeepAlive(Callback); Emit("message-loop-exited", null); }
    }
}
'@
if ($ValidateOnly) { 'Native helper compilation OK'; exit 0 }
[ForegroundProbe]::Run()
