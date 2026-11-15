//! Audio (JW-3-02): volumen y silencio del dispositivo de salida predeterminado.
//!
//! Sin sondeo ni callbacks: la interfaz consulta solo con la isla visible.
//! Cada llamada corre en un hilo del pool bloqueante (ver `main.rs`) e
//! inicializa COM como MTA solo durante la llamada (`Com`), sin tocar el STA
//! del hilo principal. Los objetos COM no salen de la función que los crea.

use serde::Serialize;
use windows::core::PWSTR;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToStringAlloc};
use windows::Win32::System::Com::{
    CoCreateInstance, CoIncrementMTAUsage, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    COINIT_MULTITHREADED, STGM_READ,
};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioState {
    pub volume: u8,
    pub muted: bool,
    pub device_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// 0–100 → escalar 0.0–1.0. Pura para poder probarla.
pub fn to_scalar(volume: f64) -> Result<f32, String> {
    if !volume.is_finite() {
        return Err("Volumen no válido".into());
    }
    Ok((volume.clamp(0.0, 100.0) / 100.0) as f32)
}

/// Escalar del sistema → 0–100.
pub fn to_percent(scalar: f32) -> u8 {
    if scalar.is_finite() {
        (scalar.clamp(0.0, 1.0) * 100.0).round() as u8
    } else {
        0
    }
}

/// COM mientras viva; solo desinicializa si esta llamada lo inicializó.
pub(crate) struct Com(bool);

impl Com {
    /// MTA (audio, multimedia).
    pub(crate) fn init() -> Result<Self, String> {
        Self::init_with(COINIT_MULTITHREADED)
    }

    /// STA, el que pide `ShellExecuteExW` para objetos del shell (JW-3-08).
    pub(crate) fn init_sta() -> Result<Self, String> {
        Self::init_with(COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
    }

    fn init_with(mode: windows::Win32::System::Com::COINIT) -> Result<Self, String> {
        keep_mta_alive();
        // SAFETY: llamada estándar; se equilibra en Drop.
        let hr = unsafe { CoInitializeEx(None, mode) };
        if hr == RPC_E_CHANGED_MODE {
            // El hilo ya tiene otro modelo: se puede usar COM en él, pero no es nuestro.
            return Ok(Self(false));
        }
        hr.ok().map_err(|e| format!("No se pudo iniciar COM: {e}"))?;
        Ok(Self(true))
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: equilibra el CoInitializeEx correcto de `init`.
            unsafe { CoUninitialize() };
        }
    }
}

/// Mantiene el MTA del proceso vivo hasta que el proceso termine (JW-8-04, H1).
///
/// Por qué: `Com::init` hace `CoUninitialize` al soltarse y windows-rs activa
/// WinRT (GSMTC, `media.rs`) en el MTA implícito. Si el último hilo MTA se
/// desinicializa con objetos WinRT aún vivos en otro hilo, COM destruye el MTA
/// bajo sus pies y el proceso cae con STATUS_ACCESS_VIOLATION (reproducido con
/// `cargo test` en paralelo). Un uso extra del MTA, pedido una sola vez y nunca
/// liberado (no se llama a `CoDecrementMTAUsage`), impide esa destrucción.
/// Llamar antes del primer uso de COM/WinRT en cualquier hilo.
pub(crate) fn keep_mta_alive() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // SAFETY: llamada sin requisitos previos; la cookie se descarta a propósito
        // para no decrementar nunca. Si falla, se sigue como antes (sin garantía extra).
        let _ = unsafe { CoIncrementMTAUsage() };
    });
}

fn err(what: &str) -> impl FnOnce(windows::core::Error) -> String + '_ {
    move |e| format!("{what}: {e}")
}

fn enumerator() -> Result<IMMDeviceEnumerator, String> {
    // SAFETY: COM inicializado por el llamador (`Com`).
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(err("Audio no disponible"))
}

/// `None` si no hay dispositivo de salida predeterminado.
fn default_device(en: &IMMDeviceEnumerator) -> Option<IMMDevice> {
    // SAFETY: interfaz válida; un error (p. ej. E_NOTFOUND) = sin dispositivo.
    unsafe { en.GetDefaultAudioEndpoint(eRender, eConsole) }.ok()
}

fn endpoint(dev: &IMMDevice) -> Result<IAudioEndpointVolume, String> {
    // SAFETY: interfaz válida; Activate devuelve la interfaz pedida o error.
    unsafe { dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) }.map_err(err("No se pudo controlar el volumen"))
}

/// Copia y libera una cadena reservada por COM.
pub(crate) fn take_pwstr(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    // SAFETY: cadena terminada en nulo reservada con CoTaskMemAlloc; se libera aquí.
    unsafe {
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.as_ptr() as *const _));
        s
    }
}

fn id(dev: &IMMDevice) -> String {
    // SAFETY: interfaz válida; la cadena devuelta se libera en `take_pwstr`.
    unsafe { dev.GetId() }.map(take_pwstr).unwrap_or_default()
}

fn name(dev: &IMMDevice) -> String {
    // SAFETY: interfaz válida; el PROPVARIANT se libera con PropVariantClear.
    unsafe {
        let Ok(store) = dev.OpenPropertyStore(STGM_READ) else { return String::new() };
        let Ok(mut pv) = store.GetValue(&PKEY_Device_FriendlyName) else { return String::new() };
        let s = PropVariantToStringAlloc(&pv).map(take_pwstr).unwrap_or_default();
        let _ = PropVariantClear(&mut pv);
        s
    }
}

pub fn state() -> Result<Option<AudioState>, String> {
    let _com = Com::init()?;
    let Some(dev) = default_device(&enumerator()?) else { return Ok(None) };
    let ep = endpoint(&dev)?;
    // SAFETY: interfaz válida.
    let (scalar, muted) = unsafe {
        (
            ep.GetMasterVolumeLevelScalar().map_err(err("No se pudo leer el volumen"))?,
            ep.GetMute().map_err(err("No se pudo leer el silencio"))?.as_bool(),
        )
    };
    Ok(Some(AudioState { volume: to_percent(scalar), muted, device_name: name(&dev) }))
}

fn with_endpoint(f: impl FnOnce(&IAudioEndpointVolume) -> windows::core::Result<()>, what: &str) -> Result<(), String> {
    let _com = Com::init()?;
    let dev = default_device(&enumerator()?).ok_or("No hay dispositivo de salida de audio")?;
    f(&endpoint(&dev)?).map_err(err(what))
}

pub fn set_volume(volume: f64) -> Result<(), String> {
    let scalar = to_scalar(volume)?;
    // SAFETY: interfaz válida; contexto de evento nulo permitido.
    with_endpoint(|ep| unsafe { ep.SetMasterVolumeLevelScalar(scalar, std::ptr::null()) }, "No se pudo cambiar el volumen")
}

pub fn set_muted(muted: bool) -> Result<(), String> {
    // SAFETY: interfaz válida; contexto de evento nulo permitido.
    with_endpoint(|ep| unsafe { ep.SetMute(muted, std::ptr::null()) }, "No se pudo cambiar el silencio")
}

/// Solo dispositivos de salida activos.
pub fn list_devices() -> Result<Vec<AudioDevice>, String> {
    let _com = Com::init()?;
    let en = enumerator()?;
    let default_id = default_device(&en).map(|d| id(&d));
    // SAFETY: interfaz válida; índices dentro de GetCount.
    unsafe {
        let col = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).map_err(err("No se pudieron listar los dispositivos"))?;
        let n = col.GetCount().map_err(err("No se pudieron listar los dispositivos"))?;
        Ok((0..n)
            .filter_map(|i| col.Item(i).ok())
            .map(|d| {
                let id = id(&d);
                AudioDevice { is_default: default_id.as_deref() == Some(id.as_str()), name: name(&d), id }
            })
            .collect())
    }
}

/// Elegir el dispositivo predeterminado no tiene API pública: se abre Configuración.
pub fn open_sound_settings() -> Result<(), String> {
    tauri_plugin_opener::open_url("ms-settings:sound", None::<&str>)
        .map_err(|e| format!("No se pudo abrir Configuración de sonido: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_bounds() {
        assert_eq!(to_scalar(50.0), Ok(0.5));
        assert_eq!(to_scalar(-5.0), Ok(0.0));
        assert_eq!(to_scalar(250.0), Ok(1.0));
        assert!(to_scalar(f64::NAN).is_err());
        assert!(to_scalar(f64::INFINITY).is_err());
        assert_eq!(to_percent(0.333), 33);
        assert_eq!(to_percent(1.5), 100);
        assert_eq!(to_percent(-1.0), 0);
        assert_eq!(to_percent(f32::NAN), 0);
        for v in 0..=100u8 {
            assert_eq!(to_percent(to_scalar(v as f64).unwrap()), v, "ida y vuelta {v}");
        }
    }

    #[test]
    fn serde_shape() {
        let s = AudioState { volume: 40, muted: false, device_name: "X".into() };
        assert_eq!(serde_json::to_string(&s).unwrap(), r#"{"volume":40,"muted":false,"deviceName":"X"}"#);
        let d = AudioDevice { id: "i".into(), name: "n".into(), is_default: true };
        assert_eq!(serde_json::to_string(&d).unwrap(), r#"{"id":"i","name":"n","isDefault":true}"#);
    }

    /// Solo lectura en vivo: no cambia nada. Imprime metadatos neutros.
    #[test]
    fn live_read_does_not_panic() {
        let st = state();
        let devs = list_devices();
        println!(
            "audio: estado={} dispositivos={:?}",
            st.as_ref().map(|s| if s.is_some() { "sí" } else { "null" }).unwrap_or("error"),
            devs.as_ref().map(|d| d.len())
        );
        if let (Ok(Some(_)), Ok(d)) = (&st, &devs) {
            assert_eq!(d.iter().filter(|d| d.is_default).count(), 1);
        }
    }
}
