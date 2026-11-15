# Selecciona Centrar por ID/rectangulo nativos, exclusivamente en el PID propio.
param([Parameter(Mandatory=$true)][int]$ProcessId, [string]$EvidenceFile)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeCenter {
  public struct RECT { public int L,T,R,B; }
  public struct POINT { public int X,Y; }
  public struct MOUSEINPUT { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
  public struct INPUT { public uint type; public MOUSEINPUT mouse; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f,IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder b,int n);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr m);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetMenuString(IntPtr m,uint i,StringBuilder b,int n,uint flags);
  [DllImport("user32.dll")] static extern uint GetMenuItemID(IntPtr m,int i);
  [DllImport("user32.dll")] static extern uint GetMenuState(IntPtr m,uint i,uint flags);
  [DllImport("user32.dll")] static extern bool GetMenuItemRect(IntPtr w,IntPtr m,uint i,out RECT r);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint f);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll",SetLastError=true)] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint n,INPUT[] i,int size);
  static IntPtr window; static POINT point; static uint owner;
  public class Target { public uint processId,commandId; public string selected="Centrar",method="Win32 ID + rect"; public int[] rect; }
  public static Target Locate(uint pid) {
    SetThreadDpiAwarenessContext(new IntPtr(-4)); int windows=0;
    EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(p!=pid)return true;
      var name=new StringBuilder(256);GetClassName(h,name,256);if(name.ToString()=="#32768"){window=h;windows++;}return true;},IntPtr.Zero);
    if(windows!=1)throw new Exception("No hay un unico popup nativo del PID propio; sin entrada");
    var menu=SendMessage(window,0x01E1,IntPtr.Zero,IntPtr.Zero); // MN_GETHMENU
    int count=GetMenuItemCount(menu),index=-1;
    for(int i=0;i<count;i++){var text=new StringBuilder(256);GetMenuString(menu,(uint)i,text,256,0x400);
      if(text.ToString().Replace("&","").Split('\t')[0]=="Centrar"){if(index!=-1)throw new Exception("Centrar duplicado; sin entrada");index=i;}}
    if(index<0 || (GetMenuState(menu,(uint)index,0x400)&3)!=0)throw new Exception("Centrar no encontrado o deshabilitado; sin entrada");
    RECT r;if(!GetMenuItemRect(IntPtr.Zero,menu,(uint)index,out r)||r.R<=r.L||r.B<=r.T)throw new Exception("Rectangulo nativo de Centrar no disponible; sin entrada");
    point=new POINT{X=(r.L+r.R)/2,Y=(r.T+r.B)/2};owner=pid;
    return new Target{processId=pid,commandId=GetMenuItemID(menu,index),rect=new int[]{r.L,r.T,r.R,r.B}};
  }
  public static void Click() {
    uint pid;var hit=WindowFromPoint(point);GetWindowThreadProcessId(hit,out pid);
    if(pid!=owner||GetAncestor(hit,2)!=window)throw new Exception("Windows rechazo el destino: el punto no pertenece al menu propio; sin entrada");
    POINT original,actual;GetCursorPos(out original);
    if(!SetCursorPos(point.X,point.Y)||!GetCursorPos(out actual)||actual.X!=point.X||actual.Y!=point.Y)throw new Exception("Windows rechazo SetCursorPos; no se reintenta");
    var input=new INPUT[]{new INPUT{mouse=new MOUSEINPUT{flags=2}},new INPUT{mouse=new MOUSEINPUT{flags=4}}};
    uint sent=SendInput(2,input,Marshal.SizeOf(typeof(INPUT)));int error=Marshal.GetLastWin32Error();
    if(sent!=2){if(sent==1)SendInput(1,new INPUT[]{input[1]},Marshal.SizeOf(typeof(INPUT)));throw new Exception("Windows rechazo SendInput: enviados="+sent+"/2 win32="+error+"; no se reintenta");}
    SetCursorPos(original.X,original.Y);
  }
}
'@
$metadata = [NativeCenter]::Locate($ProcessId)
if ($EvidenceFile) { $metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $EvidenceFile -Encoding UTF8 }
[NativeCenter]::Click()
$metadata | Add-Member -NotePropertyName invoked -NotePropertyValue $true
if ($EvidenceFile) { $metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $EvidenceFile -Encoding UTF8 }
$metadata | ConvertTo-Json -Compress
