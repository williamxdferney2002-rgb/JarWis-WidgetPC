"""JW-34-6I: DXGI/session preflight, or isolated crop capture with --serve.
No arguments: no pixels acquired. --serve: native DLLs + installed Pillow;
only synthetic-underlay ROI crosses GPU->CPU. Run with python -B.
"""
import ctypes as C
from ctypes import wintypes as W
import json
import uuid
import os
import sys
import time
import threading
import subprocess
import queue
from pathlib import Path

P = C.c_void_p
U = C.c_uint
HR = C.c_long
user = C.WinDLL('user32', use_last_error=True)
kernel = C.WinDLL('kernel32', use_last_error=True)


class GUID(C.Structure):
    _fields_ = [('bytes', C.c_ubyte * 16)]

    def __init__(self, value):
        super().__init__()
        C.memmove(C.byref(self), uuid.UUID(value).bytes_le, 16)


def method(obj, index, result, *args):
    table = C.cast(obj, C.POINTER(C.POINTER(P))).contents
    return C.WINFUNCTYPE(result, P, *args)(table[index])


def qi(obj, iid):
    out = P()
    code = method(obj, 0, HR, C.POINTER(GUID), C.POINTER(P))(obj, C.byref(GUID(iid)), C.byref(out))
    check(code, 'QueryInterface')
    return out


def check(code, label):
    if code < 0:
        raise OSError(label + ': 0x%08X' % (code & 0xffffffff))


def session_probe():
    user.OpenInputDesktop.argtypes = [U, W.BOOL, U]
    user.OpenInputDesktop.restype = P
    user.CloseDesktop.argtypes = [P]
    desk = user.OpenInputDesktop(0, False, 1)  # DESKTOP_READOBJECTS only
    result = {'openInputDesktop': bool(desk), 'error': C.get_last_error() if not desk else 0}
    if desk:
        user.CloseDesktop(desk)
    pid = kernel.GetCurrentProcessId()
    sid = U()
    kernel.ProcessIdToSessionId(pid, C.byref(sid))
    result['processSession'] = sid.value
    return result


def dxgi_probe():
    """Create device on each actual adapter, then DuplicateOutput; no AcquireNextFrame."""
    dxgi = C.WinDLL('dxgi')
    d3d = C.WinDLL('d3d11')
    dxgi.CreateDXGIFactory1.argtypes = [C.POINTER(GUID), C.POINTER(P)]
    dxgi.CreateDXGIFactory1.restype = HR
    d3d.D3D11CreateDevice.argtypes = [P, U, P, U, P, U, U, C.POINTER(P), C.POINTER(U), C.POINTER(P)]
    d3d.D3D11CreateDevice.restype = HR
    factory = P()
    objects = []
    outputs = []
    try:
        check(dxgi.CreateDXGIFactory1(C.byref(GUID('770aae78-f26f-4dba-a829-253c83d1b387')), C.byref(factory)), 'CreateDXGIFactory1')
        objects.append(factory)
        for ai in range(8):
            adapter = P()
            code = method(factory, 12, HR, U, C.POINTER(P))(factory, ai, C.byref(adapter))
            if code & 0xffffffff == 0x887a0002:
                break
            check(code, 'EnumAdapters1')
            objects.append(adapter)
            device, context, level = P(), P(), U()
            code = d3d.D3D11CreateDevice(adapter, 0, None, 0x20, None, 0, 7, C.byref(device), C.byref(level), C.byref(context))
            if code < 0:
                outputs.append({'adapter': ai, 'createDevice': '0x%08X' % (code & 0xffffffff)})
                continue
            objects.extend([device, context])
            for oi in range(8):
                output = P()
                code = method(adapter, 7, HR, U, C.POINTER(P))(adapter, oi, C.byref(output))
                if code & 0xffffffff == 0x887a0002:
                    break
                check(code, 'EnumOutputs')
                objects.append(output)
                desc = OUTPUT_DESC()
                check(method(output, 7, HR, C.POINTER(OUTPUT_DESC))(output, C.byref(desc)), 'GetDesc')
                output1 = qi(output, '00cddea8-939b-4b83-a340-a685226666cc')
                objects.append(output1)
                duplicate = P()
                code = method(output1, 22, HR, P, C.POINTER(P))(output1, device, C.byref(duplicate))
                outputs.append({'adapter': ai, 'output': oi, 'featureLevel': hex(level.value), 'duplicateOutput': '0x%08X' % (code & 0xffffffff),
                                'name': desc.name,'attached': bool(desc.attached),'rect': [desc.rect.left,desc.rect.top,desc.rect.right,desc.rect.bottom]})
                if duplicate:
                    objects.append(duplicate)
    finally:
        for obj in reversed(objects):
            method(obj, 2, U)(obj)
    return outputs


class RECT(C.Structure):
    _fields_ = [(x, W.LONG) for x in ('left', 'top', 'right', 'bottom')]


class OUTPUT_DESC(C.Structure):
    _fields_ = [('name', W.WCHAR * 32), ('rect', RECT), ('attached', W.BOOL), ('rotation', U), ('monitor', P)]


class FRAME_INFO(C.Structure):
    _fields_ = [('present', C.c_longlong), ('mouse', C.c_longlong), ('accumulated', U), ('coalesced', W.BOOL),
                ('protected', W.BOOL), ('pointerX', W.LONG), ('pointerY', W.LONG), ('visible', W.BOOL), ('metadata', U), ('shape', U)]


class TEXTURE_DESC(C.Structure):
    _fields_ = [(x, U) for x in ('width', 'height', 'mips', 'array', 'format', 'samples', 'quality', 'usage', 'bind', 'cpu', 'misc')]


class MAPPED(C.Structure):
    _fields_ = [('data', P), ('row', U), ('depth', U)]


class BOX(C.Structure):
    _fields_ = [(x, U) for x in ('left', 'top', 'front', 'right', 'bottom', 'back')]


def release(obj):
    if obj:
        method(obj, 2, U)(obj)


class Capture:
    def __init__(self, roi):
        self.objects = []
        self.roi = roi
        self.duplicate = None
        dxgi, d3d = C.WinDLL('dxgi'), C.WinDLL('d3d11')
        factory = P()
        dxgi.CreateDXGIFactory1.argtypes = [C.POINTER(GUID), C.POINTER(P)]
        dxgi.CreateDXGIFactory1.restype = HR
        check(dxgi.CreateDXGIFactory1(C.byref(GUID('770aae78-f26f-4dba-a829-253c83d1b387')), C.byref(factory)), 'factory')
        self.objects.append(factory)
        d3d.D3D11CreateDevice.argtypes = [P, U, P, U, P, U, U, C.POINTER(P), C.POINTER(U), C.POINTER(P)]
        d3d.D3D11CreateDevice.restype = HR
        for ai in range(8):
            adapter = P()
            code = method(factory, 12, HR, U, C.POINTER(P))(factory, ai, C.byref(adapter))
            if code < 0:
                break
            self.objects.append(adapter)
            device, context, level = P(), P(), U()
            code = d3d.D3D11CreateDevice(adapter, 0, None, 0x20, None, 0, 7, C.byref(device), C.byref(level), C.byref(context))
            if code < 0:
                continue
            self.objects.extend([device, context])
            for oi in range(8):
                output = P()
                code = method(adapter, 7, HR, U, C.POINTER(P))(adapter, oi, C.byref(output))
                if code < 0:
                    break
                self.objects.append(output)
                desc = OUTPUT_DESC()
                check(method(output, 7, HR, C.POINTER(OUTPUT_DESC))(output, C.byref(desc)), 'output desc')
                r = desc.rect
                if not desc.attached or not (r.left <= roi[0] and r.top <= roi[1] and r.right >= roi[0]+roi[2] and r.bottom >= roi[1]+roi[3]):
                    continue
                out1 = qi(output, '00cddea8-939b-4b83-a340-a685226666cc')
                self.objects.append(out1)
                duplicate = P()
                check(method(out1, 22, HR, P, C.POINTER(P))(out1, device, C.byref(duplicate)), 'DuplicateOutput selected monitor')
                self.objects.append(duplicate)
                self.duplicate, self.device, self.context = duplicate, device, context
                self.output_rect = [r.left, r.top, r.right, r.bottom]
                self.box = BOX(roi[0]-r.left, roi[1]-r.top, 0, roi[0]-r.left+roi[2], roi[1]-r.top+roi[3], 1)
                texdesc = TEXTURE_DESC(roi[2], roi[3], 1, 1, 87, 1, 0, 3, 0, 0x20000, 0)
                self.staging = P()
                check(method(device, 5, HR, C.POINTER(TEXTURE_DESC), P, C.POINTER(P))(device, C.byref(texdesc), None, C.byref(self.staging)), 'staging')
                self.objects.append(self.staging)
                return
        raise RuntimeError('No duplicable output contains the test ROI')

    def next(self):
        info, resource = FRAME_INFO(), P()
        code = method(self.duplicate, 8, HR, U, C.POINTER(FRAME_INFO), C.POINTER(P))(self.duplicate, 25, C.byref(info), C.byref(resource))
        if code & 0xffffffff == 0x887a0027:
            return None
        check(code, 'AcquireNextFrame')
        try:
            if not info.present:  # pointer-only update is not a new presented image
                return None
            texture = qi(resource, '6f15aaf2-d208-4e89-9ab4-489535d34f9c')
            try:
                method(self.context, 46, None, P, U, U, U, U, P, U, C.POINTER(BOX))(
                    self.context, self.staging, 0, 0, 0, 0, texture, 0, C.byref(self.box))
                mapped = MAPPED()
                check(method(self.context, 14, HR, P, U, U, U, C.POINTER(MAPPED))(self.context, self.staging, 0, 1, 0, C.byref(mapped)), 'Map')
                try:
                    # Only the neutral test rectangle crosses to CPU memory.
                    raw = C.string_at(mapped.data,mapped.row*self.roi[3])
                finally:
                    method(self.context, 15, None, P, U)(self.context, self.staging, 0)
            finally:
                release(texture)
            return {'qpc': info.present, 'receivedQpc': qpc(), 'accumulated': info.accumulated, 'coalesced': bool(info.coalesced), 'stride':mapped.row,'raw': raw}
        finally:
            release(resource)
            check(method(self.duplicate, 14, HR)(self.duplicate), 'ReleaseFrame')

    def close(self):
        for obj in reversed(self.objects):
            release(obj)
        self.objects = []


class WgcCapture:
    def __init__(self, roi, hwnd):
        self.roi = roi
        self.output_rect = None
        self.frames = queue.Queue(maxsize=150)
        self.dll = C.WinDLL(str(Path(os.environ.get('JW_PROBE_DIR',os.environ['JW_FLICKER_HOME']))/'wgc.dll'))
        callback_type = C.WINFUNCTYPE(None,P,U,U,U,C.c_longlong)
        @callback_type
        def receive(data,width,height,row,present):
            if self.frames.full():
                return
            raw = C.string_at(data,row*height)
            self.frames.put_nowait({'qpc': present,'receivedQpc': qpc(),'raw': raw,'stride':row,'accumulated': None,'coalesced': None})
        self.callback = receive
        self.dll.StartWgc.argtypes = [P,C.c_int,C.c_int,C.c_int,C.c_int,callback_type]
        self.dll.StartWgc.restype = HR
        self.dll.StopWgc.restype = HR
        code = self.dll.StartWgc(hwnd,*roi,self.callback)
        check(code,'Windows.Graphics.Capture StartWgc')

    def next(self):
        try:
            return self.frames.get(timeout=.03)
        except queue.Empty:
            return None

    def close(self):
        check(self.dll.StopWgc(),'Windows.Graphics.Capture StopWgc')


def qpc():
    out = C.c_longlong()
    kernel.QueryPerformanceCounter(C.byref(out))
    return out.value


def launch_isolated(exe, dll):
    # Caller supplies a completely synthetic settings file BEFORE launch.
    app = subprocess.Popen([exe], creationflags=0x4 | 0x08000000, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    handle = int(app._handle)
    kernel.VirtualAllocEx.argtypes = [P, P, C.c_size_t, U, U]
    kernel.VirtualAllocEx.restype = P
    kernel.WriteProcessMemory.argtypes = [P, P, P, C.c_size_t, P]
    kernel.GetModuleHandleW.argtypes = [W.LPCWSTR]
    kernel.GetModuleHandleW.restype = P
    kernel.GetProcAddress.argtypes = [P, C.c_char_p]
    kernel.GetProcAddress.restype = P
    kernel.CreateRemoteThread.argtypes = [P, P, C.c_size_t, P, P, U, P]
    kernel.CreateRemoteThread.restype = P
    kernel.WaitForSingleObject.argtypes = [P, U]
    kernel.CloseHandle.argtypes = [P]
    kernel.VirtualFreeEx.argtypes = [P, P, C.c_size_t, U]
    address = None
    try:
        data = C.create_unicode_buffer(str(Path(dll).resolve()))
        address = kernel.VirtualAllocEx(handle, None, C.sizeof(data), 0x3000, 4)
        if not address or not kernel.WriteProcessMemory(handle,address,data,C.sizeof(data),None):
            raise C.WinError(C.get_last_error())
        loader = kernel.GetProcAddress(kernel.GetModuleHandleW('kernel32.dll'), b'LoadLibraryW')
        thread = kernel.CreateRemoteThread(handle,None,0,loader,address,0,None)
        if not thread:
            raise C.WinError(C.get_last_error())
        try:
            if kernel.WaitForSingleObject(thread,10000) != 0:
                raise RuntimeError('Instrumentation load timeout; main remains suspended')
            thread_result = U()
            kernel.GetExitCodeThread.argtypes = [P,C.POINTER(U)]
            kernel.GetExitCodeThread(thread,C.byref(thread_result))
        finally:
            kernel.CloseHandle(thread)
        if not (Path(os.environ['JW_FLICKER_HOME'])/'messages.jsonl').exists():
            raise RuntimeError('No isolation handshake; main will not be resumed; loader='+str(thread_result.value)+' process='+str(app.poll()))
        ntdll = C.WinDLL('ntdll')
        ntdll.NtResumeProcess.argtypes = [P]
        check(ntdll.NtResumeProcess(handle),'NtResumeProcess')
        return app
    except BaseException:
        app.kill()
        app.wait()
        raise
    finally:
        if address:
            kernel.VirtualFreeEx(handle,address,0,0x8000)


def find_bar(pid):
    result = []
    callback_type = C.WINFUNCTYPE(W.BOOL, P, P)
    user.EnumWindows.argtypes = [callback_type, P]
    user.GetWindowThreadProcessId.argtypes = [P, C.POINTER(U)]
    user.GetWindowTextW.argtypes = [P, W.LPWSTR, C.c_int]
    @callback_type
    def callback(hwnd, _):
        owner = U()
        user.GetWindowThreadProcessId(hwnd,C.byref(owner))
        name = C.create_unicode_buffer(128)
        user.GetWindowTextW(hwnd,name,128)
        if owner.value == pid and name.value == 'JarWis':
            result.append(hwnd)
        return True
    user.EnumWindows(callback,None)
    return result[0] if len(result) == 1 else None


def rect(hwnd):
    r = RECT()
    user.GetWindowRect.argtypes = [P, C.POINTER(RECT)]
    if not user.GetWindowRect(hwnd,C.byref(r)):
        raise C.WinError(C.get_last_error())
    return [r.left,r.top,r.right-r.left,r.bottom-r.top]


class Underlay:
    """Temporary solid test window, no desktop configuration changes."""
    def __init__(self, bar):
        class MONITOR(C.Structure):
            _fields_ = [('size', U), ('bounds', RECT), ('work', RECT), ('flags', U)]
        user.MonitorFromWindow.argtypes = [P,U]
        user.MonitorFromWindow.restype = P
        user.GetMonitorInfoW.argtypes = [P,C.POINTER(MONITOR)]
        mon = MONITOR(); mon.size = C.sizeof(mon)
        if not user.GetMonitorInfoW(user.MonitorFromWindow(bar,2),C.byref(mon)):
            raise C.WinError(C.get_last_error())
        r = mon.work
        # Shield the full work area; save only the upper, central test region.
        self.bounds = [r.left,r.top,r.right-r.left,r.bottom-r.top]
        width = min(r.right-r.left,1100)
        self.roi = [r.left+(r.right-r.left-width)//2,r.top,width,min(r.bottom-r.top,420)]
        self.ready = threading.Event()
        self.stop = threading.Event()
        self.error = None
        self.worker = threading.Thread(target=self.run)
        self.worker.start()
        self.ready.wait(5)
        if self.error or not self.ready.is_set():
            raise RuntimeError('Underlay failed: '+str(self.error))
        user.SetWindowPos.argtypes = [P,P,C.c_int,C.c_int,C.c_int,C.c_int,U]
        if not user.SetWindowPos(bar,P(-1),0,0,0,0,0x13):  # topmost, no move/size/activate
            raise C.WinError(C.get_last_error())

    def run(self):
        try:
            user.SetThreadDpiAwarenessContext(P(-4))
            callback_type = C.WINFUNCTYPE(C.c_ssize_t,P,U,C.c_size_t,C.c_ssize_t)
            class WNDCLASS(C.Structure):
                _fields_ = [('style', U),('proc',callback_type),('extra',C.c_int),('windowExtra',C.c_int),('instance',P),
                            ('icon',P),('cursor',P),('brush',P),('menu',W.LPCWSTR),('name',W.LPCWSTR)]
            user.DefWindowProcW.argtypes = [P,U,C.c_size_t,C.c_ssize_t]
            user.DefWindowProcW.restype = C.c_ssize_t
            @callback_type
            def proc(h,m,w,l):
                return user.DefWindowProcW(h,m,w,l)
            gdi = C.WinDLL('gdi32')
            gdi.CreateSolidBrush.argtypes = [U]
            gdi.CreateSolidBrush.restype = P
            gdi.DeleteObject.argtypes = [P]
            brush = gdi.CreateSolidBrush(0x574d27)
            instance = kernel.GetModuleHandleW(None)
            name = 'JarWisFlickerNeutralUnderlay346I'
            wc = WNDCLASS(0,proc,0,0,instance,None,None,brush,None,name)
            user.RegisterClassW.argtypes = [C.POINTER(WNDCLASS)]
            if not user.RegisterClassW(C.byref(wc)):
                raise C.WinError(C.get_last_error())
            user.CreateWindowExW.argtypes = [U,W.LPCWSTR,W.LPCWSTR,U,C.c_int,C.c_int,C.c_int,C.c_int,P,P,P,P]
            user.CreateWindowExW.restype = P
            self.hwnd = user.CreateWindowExW(0x08000088,name,'JW-34-6I synthetic background',0x90000000,*self.bounds,None,None,instance,None)
            if not self.hwnd:
                raise C.WinError(C.get_last_error())
            self.ready.set()
            msg = W.MSG()
            user.PeekMessageW.argtypes = [C.POINTER(W.MSG),P,U,U,U]
            # A 4x4 synthetic heartbeat forces changed compositor frames even
            # when the island is static; never touches application rendering.
            user.GetDC.argtypes = [P]; user.GetDC.restype = P
            user.ReleaseDC.argtypes = [P,P]
            gdi.SetPixelV.argtypes = [P,C.c_int,C.c_int,U]
            beat = 0
            while not self.stop.wait(.001):
                while user.PeekMessageW(C.byref(msg),None,0,0,1):
                    user.TranslateMessage(C.byref(msg)); user.DispatchMessageW(C.byref(msg))
                dc = user.GetDC(self.hwnd)
                beat ^= 1
                for yy in range(4):
                    for xx in range(4):
                        gdi.SetPixelV(dc,self.roi[0]-self.bounds[0]+self.roi[2]-8+xx,self.roi[3]-8+yy,0x574d27 if beat else 0x584e28)
                user.ReleaseDC(self.hwnd,dc)
            user.DestroyWindow.argtypes = [P]
            user.DestroyWindow(self.hwnd)
            user.UnregisterClassW.argtypes = [W.LPCWSTR,P]
            user.UnregisterClassW(name,instance)
            gdi.DeleteObject(brush)
        except BaseException as error:
            self.error = str(error)
            self.ready.set()

    def close(self):
        self.stop.set(); self.worker.join()


def serve(exe,dll):
    """JSON-line control; capture is armed before CDP input. Only own PID is killed."""
    from PIL import Image
    root = Path(os.environ['JW_FLICKER_HOME']).resolve()
    app = launch_isolated(exe,dll)
    underlay = None
    capture = None
    worker = None
    recording = threading.Event()
    frames, errors = [], []
    user.SetThreadDpiAwarenessContext.argtypes = [P]
    user.SetThreadDpiAwarenessContext(P(-4))
    user.SendMessageW.argtypes = [P,U,C.c_size_t,C.c_ssize_t]
    user.SendMessageW.restype = C.c_ssize_t
    try:
        hwnd = None
        for _ in range(150):
            hwnd = find_bar(app.pid)
            if hwnd:
                break
            if app.poll() is not None:
                raise RuntimeError('Test app exited: '+str(app.returncode))
            time.sleep(.1)
        if not hwnd:
            raise RuntimeError('No test bar window')
        print(json.dumps({'ready': True, 'pid': app.pid, 'hwnd': hwnd, 'rect': rect(hwnd)}),flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            if command['cmd'] == 'rect':
                reply = {'qpc': qpc(),'rect': rect(hwnd)}
            elif command['cmd'] == 'mode':
                reply = {'result': user.SendMessageW(hwnd,0x8000+3021,command['value'],0)}
            elif command['cmd'] == 'shield':
                if underlay:
                    raise RuntimeError('Already shielded')
                underlay = Underlay(hwnd)
                reply = {'roi': underlay.roi,'underlay': underlay.hwnd,'backgroundRGB': [39,77,87]}
            elif command['cmd'] == 'start':
                if worker:
                    raise RuntimeError('Already recording')
                frames.clear(); errors.clear()
                # ROI must be shielded by a neutral underlay created by the harness.
                roi = command['roi']
                if not command.get('neutralUnderlayVerified'):
                    raise RuntimeError('No neutral underlay verification')
                capture = Capture(roi) if os.environ.get('JW_CAPTURE') == 'DXGI' else WgcCapture(roi,hwnd)
                recording.set()
                def record():
                    try:
                        while recording.is_set() and len(frames)<150:
                            frame = capture.next()
                            if frame:
                                frame['rect'] = rect(hwnd)
                                frames.append(frame)
                    except BaseException as error:
                        errors.append(str(error))
                worker = threading.Thread(target=record)
                worker.start()
                reply = {'armedQpc': qpc(),'output': capture.output_rect}
            elif command['cmd'] == 'stop':
                recording.clear(); worker.join(); worker = None
                capture.close(); capture = None
                folder = root/'frames'/command['label']
                folder.mkdir(parents=True,exist_ok=True)
                rows = []
                for index,frame in enumerate(frames):
                    data = frame.pop('raw')
                    file = folder/('%03d.png'%index)
                    Image.frombytes('RGB',(roi[2],roi[3]),data,'raw','BGRX',frame['stride']).save(file)
                    rows.append({**frame,'file': str(file.relative_to(root))})
                reply = {'frames': rows,'errors': errors}
                frames.clear()
            elif command['cmd'] == 'exit':
                break
            else:
                raise RuntimeError('Unknown command')
            print(json.dumps(reply),flush=True)
    finally:
        recording.clear()
        if worker:
            worker.join()
        if capture:
            capture.close()
        if underlay:
            underlay.close()
        if app.poll() is None:
            app.kill()
        app.wait(timeout=10)


if __name__ == '__main__':
    if len(sys.argv)>1 and sys.argv[1] == '--serve':
        serve(sys.argv[2],sys.argv[3])
        sys.exit(0)
    result = {'session': session_probe(), 'pixelsRead': False}
    try:
        result['dxgi'] = dxgi_probe()
    except Exception as error:
        result['error'] = str(error)
    print(json.dumps(result))
