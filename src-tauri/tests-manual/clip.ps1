# Escribe textos FICTICIOS en el portapapeles para probar el historial (JW-2-06).
# Nunca lee ni imprime lo que hubiera antes: solo compara con un texto de prueba.
#   clip.ps1 set "texto"             Set-Clipboard normal
#   clip.ps1 excluded "texto"        + ExcludeClipboardContentFromMonitorProcessing
#   clip.ps1 noinclude "texto"       + CanIncludeInClipboardHistory = DWORD 0
#   clip.ps1 nocloud "texto"         + CanUploadToCloudClipboard = DWORD 0
#   clip.ps1 equals "texto"          True/False (¿el portapapeles contiene exactamente ese texto?)
#   clip.ps1 clear                   vacía el portapapeles
#   clip.ps1 probe                   True si este proceso puede abrir el portapapeles
param([string]$Action, [string]$Text)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class C {
  [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll")] static extern bool EmptyClipboard();
  [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint f, IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint f);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string n);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint f, UIntPtr n);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(int ex, string c, string t, int s, int x, int y, int w, int h, IntPtr p, IntPtr m, IntPtr i, IntPtr l);
  static IntPtr Owner() { return CreateWindowEx(0, "STATIC", "jarwis-clip-test", 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero); }
  static bool Open(IntPtr h) { for (int i = 0; i < 20; i++) { if (OpenClipboard(h)) return true; System.Threading.Thread.Sleep(20); } return false; }
  static IntPtr Mem(byte[] b) {
    IntPtr g = GlobalAlloc(2, (UIntPtr)b.Length); IntPtr p = GlobalLock(g);
    Marshal.Copy(b, 0, p, b.Length); GlobalUnlock(g); return g;
  }
  // Un propietario real (ventana de mensajes): con OpenClipboard(NULL) SetClipboardData falla.
  public static bool Set(string text, string mark, uint value) {
    IntPtr owner = Owner();
    if (!Open(owner)) return false;
    EmptyClipboard();
    if (mark != null) SetClipboardData(RegisterClipboardFormat(mark), Mem(BitConverter.GetBytes(value)));
    bool ok = text == null || SetClipboardData(13, Mem(System.Text.Encoding.Unicode.GetBytes(text + "\0"))) != IntPtr.Zero;
    CloseClipboard();
    return ok;
  }
  public static bool Probe() { if (!Open(IntPtr.Zero)) return false; CloseClipboard(); return true; }
  public static bool Has(string text) {
    if (!Open(IntPtr.Zero)) return false;
    IntPtr h = GetClipboardData(13);
    string s = h == IntPtr.Zero ? null : Marshal.PtrToStringUni(GlobalLock(h));
    if (h != IntPtr.Zero) GlobalUnlock(h);
    CloseClipboard();
    return s == text;
  }
}
"@
switch ($Action) {
  "set"       { try { Set-Clipboard -Value $Text -ErrorAction Stop; $true } catch { $false } }
  "probe"     { [C]::Probe() }
  "excluded"  { [C]::Set($Text, "ExcludeClipboardContentFromMonitorProcessing", 0) }
  "noinclude" { [C]::Set($Text, "CanIncludeInClipboardHistory", 0) }
  "nocloud"   { [C]::Set($Text, "CanUploadToCloudClipboard", 0) }
  "equals"    { [C]::Has($Text) }
  "clear"     { [C]::Set($null, $null, 0) }
}
