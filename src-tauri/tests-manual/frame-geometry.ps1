# Sonda de geometría por PID; no captura el escritorio ni simula entrada.
param([uint32]$ProcessId)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class FrameGeometry {
  public struct RECT { public int L,T,R,B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int size; public RECT bounds,work; public uint flags; }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  static IntPtr window;
  static volatile bool running;
  static Thread worker;
  static readonly List<string> samples = new List<string>();
  public static void Init(uint pid) {
    EnumWindows((h,l) => { uint p; GetWindowThreadProcessId(h,out p); if(p!=pid) return true;
      var s=new System.Text.StringBuilder(256); GetWindowText(h,s,256);
      if(p==pid && s.ToString()=="JarWis") { window=h; return false; } return true;
    },IntPtr.Zero);
    if(window==IntPtr.Zero) throw new Exception("No se encontró la ventana del PID");
    SetThreadDpiAwarenessContext(new IntPtr(-4));
  }
  public static string Rect() { RECT r; if(!GetWindowRect(window,out r)) throw new Exception("GetWindowRect rechazado");
    return "["+r.L+","+r.T+","+(r.R-r.L)+","+(r.B-r.T)+"]"; }
  public static string Monitor() { var m=new MONITORINFO();m.size=Marshal.SizeOf(m);
    if(!GetMonitorInfo(MonitorFromWindow(window,2),ref m)) throw new Exception("Monitor no disponible");
    return "["+m.work.L+","+m.work.T+","+(m.work.R-m.work.L)+","+(m.work.B-m.work.T)+","+GetDpiForWindow(window)+"]"; }
  public static void Start() {
    samples.Clear(); running=true;
    worker=new Thread(() => { SetThreadDpiAwarenessContext(new IntPtr(-4)); var sw=Stopwatch.StartNew();
      while(running) { samples.Add("["+sw.Elapsed.TotalMilliseconds.ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+","+Rect()+"]"); Thread.Sleep(1); }
    }); worker.IsBackground=true; worker.Start();
  }
  public static string Stop() { running=false; worker.Join(); return "["+string.Join(",",samples)+"]"; }
}
'@
[FrameGeometry]::Init($ProcessId)
'ready'
while ($null -ne ($line = [Console]::ReadLine())) {
  switch ($line) {
    'rect' { [FrameGeometry]::Rect() }
    'monitor' { [FrameGeometry]::Monitor() }
    'start' { [FrameGeometry]::Start(); 'true' }
    'stop' { [FrameGeometry]::Stop() }
    'exit' { exit }
    default { throw 'Orden de sonda desconocida' }
  }
}
