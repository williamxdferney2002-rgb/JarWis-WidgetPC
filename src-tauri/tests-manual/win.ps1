# Simula la bandeja y la X de Ajustes enviando mensajes a las ventanas del proceso jarwis.
#   win.ps1 tray-left            clic izquierdo en el icono (WM_LBUTTONUP al callback 6002 de tray-icon)
#   win.ps1 tray-menu N          clic derecho y elige la opción N del menú con el teclado (N flechas abajo)
#   win.ps1 close "Título"       WM_CLOSE, como pulsar la X de la ventana
#   win.ps1 exists "Título"      True/False
#   win.ps1 visible "Título"     True/False: la ventana existe y está visible (IsWindowVisible)
#   win.ps1 menu-open            True/False: hay un menú emergente (#32768) del proceso
#   win.ps1 keys down,right,enter teclas para un menú ya abierto (down/up/right/enter/esc);
#                                 sale con error si no hay menú #32768 del proceso o una tecla no es válida
param([string]$Action, [string]$Arg)
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte s, uint f, IntPtr e);
  public static IntPtr Find(uint pid, string cls, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      if (p == pid && (string.IsNullOrEmpty(cls) || c.ToString() == cls) && (string.IsNullOrEmpty(title) || t.ToString() == title)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$proc = Get-Process jarwis -ErrorAction SilentlyContinue
if (-not $proc) {
  if ($Action -eq "exists" -or $Action -eq "visible") { "False" }
  # Sin proceso no hay menú: las teclas irían a la ventana con el foco.
  if ($Action -eq "keys") { Write-Error "keys: JarWis no esta en ejecucion"; exit 1 }
  exit 0
}
$jpid = [uint32]$proc.Id
function Key([byte]$vk) { [W]::keybd_event($vk, 0, 0, [IntPtr]::Zero); [W]::keybd_event($vk, 0, 2, [IntPtr]::Zero); Start-Sleep -Milliseconds 80 }
switch ($Action) {
  "tray-left" {
    $h = [W]::Find($jpid, "tray_icon_app", $null)
    [W]::PostMessage($h, 6002, [IntPtr]::Zero, [IntPtr]0x0201) | Out-Null  # WM_LBUTTONDOWN
    [W]::PostMessage($h, 6002, [IntPtr]::Zero, [IntPtr]0x0202) | Out-Null  # WM_LBUTTONUP
  }
  "tray-menu" {
    $h = [W]::Find($jpid, "tray_icon_app", $null)
    [W]::PostMessage($h, 6002, [IntPtr]::Zero, [IntPtr]0x0205) | Out-Null  # WM_RBUTTONUP -> menú
    Start-Sleep -Milliseconds 500
    $n = [int]$Arg
    for ($i = 0; $i -lt $n; $i++) { Key 0x28 }  # Flecha abajo
    Key 0x0D  # Intro
  }
  "close" { [W]::PostMessage([W]::Find($jpid, $null, $Arg), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
  "keys" {
    $vk = @{ down = 0x28; up = 0x26; right = 0x27; enter = 0x0D; esc = 0x1B }
    $keys = $Arg.Split(",")
    # Se valida todo antes de pulsar nada: nunca VK 0 ni teclas a otra ventana.
    $bad = $keys | Where-Object { -not $vk.ContainsKey($_) }
    if ($bad) { Write-Error "keys: tecla no admitida: $($bad -join ',')"; exit 1 }
    if ([W]::Find($jpid, "#32768", $null) -eq [IntPtr]::Zero) { Write-Error "keys: no hay un menu de JarWis abierto"; exit 1 }
    foreach ($k in $keys) { Key $vk[$k] }
  }
  "menu-open" { [W]::Find($jpid, "#32768", $null) -ne [IntPtr]::Zero }
  "exists" { [W]::Find($jpid, $null, $Arg) -ne [IntPtr]::Zero }
  "visible" { $h = [W]::Find($jpid, $null, $Arg); ($h -ne [IntPtr]::Zero) -and [W]::IsWindowVisible($h) }
}
