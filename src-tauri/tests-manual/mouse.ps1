# Ratón real del SO (SendInput vía mouse_event) para probar clics y arrastres sobre la barra.
# Uso: mouse.ps1 click X Y  |  mouse.ps1 drag X1 Y1 X2 Y2   (píxeles físicos de pantalla)
#      mouse.ps1 move X Y   |  mouse.ps1 right X Y          (hover o menú contextual)
#      mouse.ps1 visible     (imprime si la ventana «JarWis» es visible)
#      mouse.ps1 ctrlalt VK   (pulsa Ctrl+Alt+tecla, p. ej. 0x4B = K)
#      mouse.ps1 rect        (ventana «JarWis» y área de trabajo de su monitor: "L,T,R,B;L,T,R,B")
#      mouse.ps1 monitors    (una línea por monitor: "nombre;L,T,R,B" del área de trabajo)
#      mouse.ps1 rect -ProcessId N (probe aislado; evita elegir la instancia real)
# Coordenadas físicas reales con DPI por monitor (válido con monitores de distinta escala).
param([string]$Action, [int]$X1, [int]$Y1, [int]$X2, [int]$Y2, [uint32]$ProcessId = 0)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO i);
  public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rc, work; public uint flags; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MONITORINFOEX {
    public int cbSize; public RECT rc, work; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string device; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFOEX i);
  public delegate bool MonProc(IntPtr m, IntPtr dc, IntPtr r, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonProc p, IntPtr l);
  public static string Monitors() {
    var sb = new System.Text.StringBuilder();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (m, dc, r, l) => {
      var mi = new MONITORINFOEX(); mi.cbSize = Marshal.SizeOf(mi); GetMonitorInfo(m, ref mi);
      sb.AppendLine(mi.device+";"+mi.work.L+","+mi.work.T+","+mi.work.R+","+mi.work.B); return true;
    }, IntPtr.Zero);
    return sb.ToString().Trim();
  }
  public static IntPtr Hwnd(uint pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      var sb = new System.Text.StringBuilder(256); GetWindowText(h, sb, 256);
      if (p == pid && sb.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string Rect(uint pid) {
    IntPtr h = Hwnd(pid, "JarWis"); RECT r; GetWindowRect(h, out r);
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(mi); GetMonitorInfo(MonitorFromWindow(h, 2), ref mi);
    return r.L+","+r.T+","+r.R+","+r.B+";"+mi.work.L+","+mi.work.T+","+mi.work.R+","+mi.work.B;
  }
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  // Visibilidad de la ventana titulada `title` del proceso `pid` (FindWindow podría dar con otra app).
  public static bool Visible(uint pid, string title) {
    bool found = false;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      var sb = new System.Text.StringBuilder(256); GetWindowText(h, sb, 256);
      if (p == pid && sb.ToString() == title) { found = IsWindowVisible(h); return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte s, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  public struct POINT { public int X; public int Y; }
}
"@
# Por monitor v2 (-4) en este hilo: SetProcessDPIAware (sistema) desplaza las coordenadas en monitores de otra escala.
[M]::SetThreadDpiAwarenessContext([IntPtr]-4) | Out-Null
if ($Action -eq "monitors") { [M]::Monitors(); exit 0 }
if ($Action -in "rect", "visible") {
  if (-not $ProcessId) { $ProcessId = [uint32](Get-Process jarwis).Id }
  if ($Action -eq "rect") { [M]::Rect($ProcessId) } else { [M]::Visible($ProcessId, "JarWis") }
  exit 0
}
if ($Action -eq "ctrlalt") {
  foreach ($vk in 0x11, 0x12, $X1) { [M]::keybd_event([byte]$vk, 0, 0, [IntPtr]::Zero) }
  Start-Sleep -Milliseconds 60
  foreach ($vk in $X1, 0x12, 0x11) { [M]::keybd_event([byte]$vk, 0, 2, [IntPtr]::Zero) }
  exit 0
}
$p = New-Object M+POINT; [M]::GetCursorPos([ref]$p) | Out-Null
if ($Action -in "click", "right", "drag") {
  if (-not $ProcessId) { $ProcessId = [uint32](Get-Process jarwis).Id }
  $targetWindow = [M]::Hwnd($ProcessId, "JarWis")
  [M]::SetForegroundWindow($targetWindow) | Out-Null
  Start-Sleep -Milliseconds 100
  $targetPoint = New-Object M+POINT; $targetPoint.X = $X1; $targetPoint.Y = $Y1
  if ([M]::GetAncestor([M]::WindowFromPoint($targetPoint), 2) -ne $targetWindow) {
    Write-Error "El punto de entrada no pertenece a la ventana de prueba JarWis"; exit 1
  }
}
$positioned = [M]::SetCursorPos($X1, $Y1)
$positionError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
Start-Sleep -Milliseconds 150
$actualPoint = New-Object M+POINT
$readPosition = [M]::GetCursorPos([ref]$actualPoint)
if (-not $positioned -or -not $readPosition -or $actualPoint.X -ne $X1 -or $actualPoint.Y -ne $Y1) {
  Write-Error "Cursor SO: solicitado=$X1,$Y1 recibido=$($actualPoint.X),$($actualPoint.Y) set=$positioned read=$readPosition win32=$positionError"; exit 1
}
if ($Action -eq "move") {
  Start-Sleep -Milliseconds 350
  [M]::SetCursorPos($p.X, $p.Y) | Out-Null
  exit 0
}
if ($Action -eq "right") {
  [M]::mouse_event(0x8, 0, 0, 0, [IntPtr]::Zero)  # RIGHTDOWN
  [M]::mouse_event(0x10, 0, 0, 0, [IntPtr]::Zero)  # RIGHTUP
  Start-Sleep -Milliseconds 150
  [M]::SetCursorPos($p.X, $p.Y) | Out-Null
  exit 0
}
[M]::mouse_event(0x2, 0, 0, 0, [IntPtr]::Zero)  # LEFTDOWN
# Separa la pulsación del primer movimiento para que WebView2 reciba el origen.
Start-Sleep -Milliseconds 100
if (([M]::GetAsyncKeyState(1) -band 0x8000) -eq 0) {
  [M]::mouse_event(0x4, 0, 0, 0, [IntPtr]::Zero)
  [M]::SetCursorPos($p.X, $p.Y) | Out-Null
  Write-Error "El SO no recibió LEFTDOWN de la prueba"; exit 1
}
if ($Action -eq "drag") {
  for ($i = 1; $i -le 20; $i++) {
    [M]::SetCursorPos([int]($X1 + ($X2 - $X1) * $i / 20), [int]($Y1 + ($Y2 - $Y1) * $i / 20)) | Out-Null
    Start-Sleep -Milliseconds 25
  }
  Start-Sleep -Milliseconds 200
  # Mide antes de soltar: permite detectar una recolocación posterior al arrastre.
  if (-not $ProcessId) { $ProcessId = [uint32](Get-Process jarwis).Id }
  [M]::Rect($ProcessId)
}
[M]::mouse_event(0x4, 0, 0, 0, [IntPtr]::Zero)  # LEFTUP
Start-Sleep -Milliseconds 150
[M]::SetCursorPos($p.X, $p.Y) | Out-Null  # devuelve el cursor a su sitio
