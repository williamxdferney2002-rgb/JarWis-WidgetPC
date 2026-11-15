// JW-34-6I. Test-only in-process observer; no application source modifications.
// Loaded before the suspended test process enters main. Redirects known folders
// in THAT process only, preventing Tauri/dirs from ignoring APPDATA isolation.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
#include <shlobj.h>
#include <cstdio>
#include <cstring>

static wchar_t home[MAX_PATH];
static HANDLE logFile = INVALID_HANDLE_VALUE;
static int mode = 0;
static HWND bar;
static bool createNoRedirect = false;
static LARGE_INTEGER frequency;
static decltype(&CreateWindowExW) realCreateWindow;
constexpr UINT control = WM_APP + 3021;

static void log(HWND h, UINT msg, WPARAM w, LPARAM l, const char* phase) {
  if (logFile == INVALID_HANDLE_VALUE) return;
  LARGE_INTEGER q; QueryPerformanceCounter(&q);
  RECT r{}, c{}; GetWindowRect(h, &r); GetClientRect(h, &c);
  WINDOWPOS pos{};
  if ((msg == WM_WINDOWPOSCHANGING || msg == WM_WINDOWPOSCHANGED) && l) pos = *reinterpret_cast<WINDOWPOS*>(l);
  char text[700];
  int n = sprintf_s(text, "{\"qpc\":%lld,\"frequency\":%lld,\"hwnd\":%llu,\"msg\":%u,\"phase\":\"%s\",\"mode\":%d,\"rect\":[%ld,%ld,%ld,%ld],\"client\":[%ld,%ld],\"pos\":[%d,%d,%d,%d,%u],\"exstyle\":%llu,\"brush\":%llu}\n",
    q.QuadPart, frequency.QuadPart, reinterpret_cast<unsigned long long>(h), msg, phase, mode,
    r.left,r.top,r.right-r.left,r.bottom-r.top,c.right,c.bottom,pos.x,pos.y,pos.cx,pos.cy,pos.flags,
    static_cast<unsigned long long>(GetWindowLongPtrW(h,GWL_EXSTYLE)),
    static_cast<unsigned long long>(GetClassLongPtrW(h,GCLP_HBRBACKGROUND)));
  DWORD done; WriteFile(logFile,text,n,&done,nullptr);
}

static LRESULT CALLBACK observer(HWND h, UINT msg, WPARAM w, LPARAM l, UINT_PTR id, DWORD_PTR) {
  if (msg == control) {
    mode = static_cast<int>(w);
    auto ex = GetWindowLongPtrW(h,GWL_EXSTYLE);
    SetWindowLongPtrW(h,GWL_EXSTYLE, (mode == 3 || createNoRedirect) ? ex | WS_EX_NOREDIRECTIONBITMAP : ex & ~WS_EX_NOREDIRECTIONBITMAP);
    log(h,msg,w,l,"control"); return 1;
  }
  if (msg == WM_WINDOWPOSCHANGING && l) {
    auto* p = reinterpret_cast<WINDOWPOS*>(l);
    if (mode == 1) p->flags |= SWP_NOREDRAW;
    if (mode == 2) p->flags |= SWP_NOCOPYBITS;
  }
  bool relevant = msg == WM_SIZE || msg == WM_WINDOWPOSCHANGED || msg == WM_WINDOWPOSCHANGING || msg == WM_ERASEBKGND || msg == WM_PAINT;
  if (relevant) log(h,msg,w,l,"enter");
  LRESULT result = DefSubclassProc(h,msg,w,l);
  if (relevant) log(h,msg,w,l,"exit");
  if (msg == WM_NCDESTROY) RemoveWindowSubclass(h,observer,id);
  return result;
}

static HWND WINAPI createWindow(DWORD ex,LPCWSTR cls,LPCWSTR title,DWORD style,int x,int y,int w,int h,HWND parent,HMENU menu,HINSTANCE instance,LPVOID param) {
  if (createNoRedirect && !parent && title && !wcscmp(title,L"JarWis")) ex |= WS_EX_NOREDIRECTIONBITMAP;
  HWND win = realCreateWindow(ex,cls,title,style,x,y,w,h,parent,menu,instance,param);
  if (win && !parent && title && !wcscmp(title,L"JarWis")) {
    bar = win;
    SetWindowSubclass(win,observer,3461,0);
    log(win,WM_CREATE,0,0,"attached");
  }
  return win;
}

static HRESULT WINAPI knownFolder(REFKNOWNFOLDERID folder,DWORD,HANDLE,PWSTR* out) {
  const wchar_t* suffix = folder.Data1 == 0x3eb685db ? L"\\roaming" :
    (folder.Data1 == 0xf1b32785 || folder.Data1 == 0xa520a1a4) ? L"\\local" : L"\\home";
  size_t len = wcslen(home) + wcslen(suffix) + 1;
  *out = static_cast<PWSTR>(CoTaskMemAlloc(len * sizeof(wchar_t)));
  if (!*out) return E_OUTOFMEMORY;
  wcscpy_s(*out,len,home); wcscat_s(*out,len,suffix);
  return S_OK;
}

static bool patch(const char* name, void* replacement, void** original) {
  auto base = reinterpret_cast<BYTE*>(GetModuleHandleW(nullptr));
  auto dos = reinterpret_cast<IMAGE_DOS_HEADER*>(base);
  auto nt = reinterpret_cast<IMAGE_NT_HEADERS*>(base+dos->e_lfanew);
  auto imports = reinterpret_cast<IMAGE_IMPORT_DESCRIPTOR*>(base+nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress);
  bool found = false;
  for (; imports->Name; ++imports) {
    if (!imports->OriginalFirstThunk) continue;
    auto names = reinterpret_cast<IMAGE_THUNK_DATA*>(base+imports->OriginalFirstThunk);
    auto slots = reinterpret_cast<IMAGE_THUNK_DATA*>(base+imports->FirstThunk);
    for (; names->u1.AddressOfData; ++names,++slots) {
      if (IMAGE_SNAP_BY_ORDINAL(names->u1.Ordinal)) continue;
      auto entry = reinterpret_cast<IMAGE_IMPORT_BY_NAME*>(base+names->u1.AddressOfData);
      if (strcmp(reinterpret_cast<char*>(entry->Name),name)) continue;
      DWORD old;
      if (!VirtualProtect(&slots->u1.Function,sizeof(void*),PAGE_READWRITE,&old)) continue;
      if (original) *original = reinterpret_cast<void*>(slots->u1.Function);
      slots->u1.Function = reinterpret_cast<ULONG_PTR>(replacement);
      VirtualProtect(&slots->u1.Function,sizeof(void*),old,&old);
      found = true;
    }
  }
  return found;
}

BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,LPVOID) {
  if (reason != DLL_PROCESS_ATTACH) return TRUE;
  DisableThreadLibraryCalls(instance);
  constexpr wchar_t allowed[] = L"C:\\dev\\JarWis\\src-tauri\\tests-manual\\.jw-34-6i-runtime";
  if (!GetEnvironmentVariableW(L"JW_FLICKER_HOME",home,MAX_PATH) || wcsncmp(home,allowed,wcslen(allowed))) return FALSE;
  // Fail closed: process must not enter main with real known-folder paths.
  if (!patch("SHGetKnownFolderPath",reinterpret_cast<void*>(knownFolder),nullptr)) ExitProcess(91);
  if (!patch("CreateWindowExW",reinterpret_cast<void*>(createWindow),reinterpret_cast<void**>(&realCreateWindow))) ExitProcess(92);
  QueryPerformanceFrequency(&frequency);
  wchar_t enabled[2];
  createNoRedirect = GetEnvironmentVariableW(L"JW_CREATE_NOREDIRECT",enabled,2) && enabled[0] == L'1';
  wchar_t path[MAX_PATH]; swprintf_s(path,L"%s\\messages.jsonl",home);
  logFile = CreateFileW(path,GENERIC_WRITE,FILE_SHARE_READ,nullptr,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
  if (logFile == INVALID_HANDLE_VALUE) ExitProcess(93);
  return TRUE;
}
