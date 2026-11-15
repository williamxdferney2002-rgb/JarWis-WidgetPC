// JW-34-6I: monitor compositor capture, GPU crop to the synthetic test area.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <atomic>
#include <mutex>

using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
using Callback = void(__stdcall*)(const void*,unsigned,unsigned,unsigned,long long);
static Direct3D11CaptureFramePool pool{nullptr};
static GraphicsCaptureSession session{nullptr};
static com_ptr<ID3D11Device> device;
static com_ptr<ID3D11DeviceContext> context;
static com_ptr<ID3D11Texture2D> staging;
static event_token token{};
static std::atomic<bool> active{false};
static std::mutex guard;
static long lastError = 0;

extern "C" __declspec(dllexport) long __stdcall StartWgc(HWND hwnd,int x,int y,int width,int height,Callback callback) {
  try {
    init_apartment(apartment_type::multi_threaded);
    if (!GraphicsCaptureSession::IsSupported()) return E_NOTIMPL;
    auto monitor = MonitorFromWindow(hwnd,MONITOR_DEFAULTTONEAREST);
    MONITORINFO mi{sizeof(mi)}; GetMonitorInfoW(monitor,&mi);
    auto interop = get_activation_factory<GraphicsCaptureItem,IGraphicsCaptureItemInterop>();
    GraphicsCaptureItem item{nullptr};
    check_hresult(interop->CreateForMonitor(monitor,guid_of<GraphicsCaptureItem>(),put_abi(item)));
    check_hresult(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,device.put(),nullptr,context.put()));
    auto dxgi = device.as<IDXGIDevice>();
    com_ptr<IInspectable> inspectable;
    check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(),inspectable.put()));
    auto direct = inspectable.as<IDirect3DDevice>();
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width=width; desc.Height=height; desc.MipLevels=1; desc.ArraySize=1;
    desc.Format=DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count=1;
    desc.Usage=D3D11_USAGE_STAGING; desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
    check_hresult(device->CreateTexture2D(&desc,nullptr,staging.put()));
    D3D11_BOX box{static_cast<UINT>(x-mi.rcMonitor.left),static_cast<UINT>(y-mi.rcMonitor.top),0,
      static_cast<UINT>(x-mi.rcMonitor.left+width),static_cast<UINT>(y-mi.rcMonitor.top+height),1};
    pool=Direct3D11CaptureFramePool::CreateFreeThreaded(direct,DirectXPixelFormat::B8G8R8A8UIntNormalized,3,item.Size());
    active=true; lastError=0;
    token=pool.FrameArrived([=](auto const& sender,auto const&) {
      std::lock_guard<std::mutex> lock(guard);
      if(!active)return;
      try {
        auto frame=sender.TryGetNextFrame(); if(!frame)return;
        auto surface=frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
        com_ptr<ID3D11Texture2D> texture;
        check_hresult(surface->GetInterface(__uuidof(ID3D11Texture2D),texture.put_void()));
        context->CopySubresourceRegion(staging.get(),0,0,0,0,texture.get(),0,&box);
        D3D11_MAPPED_SUBRESOURCE mapped{};
        check_hresult(context->Map(staging.get(),0,D3D11_MAP_READ,0,&mapped));
        LARGE_INTEGER frequency;QueryPerformanceFrequency(&frequency);
        auto stamp=frame.SystemRelativeTime().count();
        auto present=(stamp/10000000)*frequency.QuadPart+(stamp%10000000)*frequency.QuadPart/10000000;
        callback(mapped.pData,width,height,mapped.RowPitch,present);
        context->Unmap(staging.get(),0);
      }catch(hresult_error const& error){lastError=error.code();}
    });
    session=pool.CreateCaptureSession(item); session.StartCapture();
    return S_OK;
  }catch(hresult_error const& error){return error.code();}
}

extern "C" __declspec(dllexport) long __stdcall StopWgc() {
  active=false;
  if(pool)pool.FrameArrived(token);
  if(session)session.Close();
  if(pool)pool.Close();
  std::lock_guard<std::mutex> lock(guard);
  session=nullptr;pool=nullptr;staging=nullptr;context=nullptr;device=nullptr;
  return lastError;
}
