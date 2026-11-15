//! Energía (JW-21/25, D-060/067): lectura puntual y cambio solo por botón.

use serde::{Deserialize, Serialize};
use windows::core::GUID;
use windows::Win32::System::Power::{self as winpower, EFFECTIVE_POWER_MODE};

const SETTINGS_URI: &str = "ms-settings:powersleep";
const OMEN_AUMID: &str = "AD2F1837.OMENCommandCenter_v10z8vjag6ke6!AD2F1837.OMENCommandCenter";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Efficiency,
    Balanced,
    Performance,
    Unknown,
}

impl From<EFFECTIVE_POWER_MODE> for Mode {
    fn from(mode: EFFECTIVE_POWER_MODE) -> Self {
        match mode {
            winpower::EffectivePowerModeBatterySaver | winpower::EffectivePowerModeBetterBattery => Self::Efficiency,
            winpower::EffectivePowerModeBalanced => Self::Balanced,
            // Juego y realidad mixta priorizan rendimiento; no son la preferencia del usuario.
            winpower::EffectivePowerModeHighPerformance
            | winpower::EffectivePowerModeMaxPerformance
            | winpower::EffectivePowerModeGameMode
            | winpower::EffectivePowerModeMixedReality => Self::Performance,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SetMode {
    Efficiency,
    Balanced,
    Performance,
}

impl SetMode {
    fn guid(self) -> GUID {
        match self {
            Self::Efficiency => GUID::from_u128(0x961cc777_2547_4f9d_8174_7d86181b8a7a),
            Self::Balanced => GUID::zeroed(),
            Self::Performance => GUID::from_u128(0xded574b5_45a0_4f42_8737_46345c09c238),
        }
    }
}

fn use_ac_power(ac_line_status: u8, battery_flag: u8) -> Result<bool, String> {
    // 255 significa desconocido, no «sin batería» (bit 128).
    if battery_flag != 255 && battery_flag & 128 != 0 {
        return Ok(true);
    }
    match ac_line_status {
        1 => Ok(true),
        0 => Ok(false),
        _ => Err("No se pudo determinar si el equipo usa corriente o batería".into()),
    }
}

fn set_with(mode: SetMode, setter: Option<impl FnOnce(&GUID) -> u32>) -> Result<(), String> {
    let setter = setter.ok_or("Esta versión de Windows no dispone de la API para cambiar el modo de energía")?;
    let code = setter(&mode.guid());
    if code == 0 {
        Ok(())
    } else {
        Err(format!("No se pudo cambiar el modo de energía (código de Windows {code})"))
    }
}

/// Solo desde power_set en el pool: cambia la preferencia de la alimentación actual.
pub fn set_mode(mode: SetMode) -> Result<Mode, String> {
    use windows::core::{s, w};
    use windows::Win32::Foundation::FreeLibrary;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};
    use winpower::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    let mut status = SYSTEM_POWER_STATUS::default();
    // SAFETY: búfer de salida válido. No modifica la alimentación.
    unsafe { GetSystemPowerStatus(&mut status) }
        .map_err(|e| format!("No se pudo consultar la alimentación del equipo: {e}"))?;
    let name = if use_ac_power(status.ACLineStatus, status.BatteryFlag)? {
        s!("PowerSetUserConfiguredACPowerMode")
    } else {
        s!("PowerSetUserConfiguredDCPowerMode")
    };
    // windows 0.62.2 no incluye estos bindings. Carga tardía, solo desde System32.
    // SAFETY: nombre fijo de DLL y búsqueda restringida al directorio del sistema.
    let module = unsafe { LoadLibraryExW(w!("powrprof.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32) }
        .map_err(|e| format!("No se pudo cargar la API de energía de Windows: {e}"))?;
    // SAFETY: módulo vivo y nombre fijo terminado en NUL.
    let setter = unsafe { GetProcAddress(module, name) }.map(|address| {
        // SAFETY: firma documentada DWORD(const GUID*), ABI system; DLL viva hasta después de set_with.
        let function: unsafe extern "system" fn(*const GUID) -> u32 = unsafe { std::mem::transmute(address) };
        move |guid: &GUID| unsafe { function(guid) }
    });
    let result = set_with(mode, setter);
    // SAFETY: referencia obtenida arriba; no se conserva ningún puntero tras liberarla.
    let _ = unsafe { FreeLibrary(module) };
    result?;
    read_mode().map_err(|e| format!("Se solicitó el cambio, pero no se pudo actualizar el modo efectivo: {e}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenTarget {
    Settings,
    Omen,
}

impl OpenTarget {
    fn destination(self) -> &'static str {
        match self {
            Self::Settings => SETTINGS_URI,
            Self::Omen => OMEN_AUMID,
        }
    }
}

/// Bloqueante: al abrir Sistema y después de un cambio. Sin suscripción permanente.
pub fn read_mode() -> Result<Mode, String> {
    use std::sync::mpsc::{sync_channel, SyncSender};
    use std::time::Duration;
    use windows::Win32::System::Power::{
        PowerRegisterForEffectivePowerModeNotifications, PowerUnregisterFromEffectivePowerModeNotifications,
        EFFECTIVE_POWER_MODE_V2,
    };

    unsafe extern "system" fn callback(mode: EFFECTIVE_POWER_MODE, context: *const std::ffi::c_void) {
        // SAFETY: el Box sigue vivo hasta que Unregister termina todos los callbacks.
        let sender = unsafe { &*context.cast::<SyncSender<EFFECTIVE_POWER_MODE>>() };
        // Nunca bloquear el callback: conservar la primera muestra disponible.
        let _ = sender.try_send(mode);
    }

    let (sender, receiver) = sync_channel(1);
    let context = Box::new(sender);
    let mut handle = std::ptr::null_mut();
    // SAFETY: contexto estable en el heap, callback con ABI correcta y handle de salida válido.
    unsafe {
        PowerRegisterForEffectivePowerModeNotifications(
            EFFECTIVE_POWER_MODE_V2,
            Some(callback),
            Some((&*context as *const SyncSender<EFFECTIVE_POWER_MODE>).cast()),
            &mut handle,
        )
    }
    .map_err(|e| format!("No se pudo leer el modo de energía: {e}"))?;
    let result = receiver.recv_timeout(Duration::from_secs(2));
    // SAFETY: handle del registro anterior; fuera del callback para evitar interbloqueo.
    if let Err(e) = unsafe { PowerUnregisterFromEffectivePowerModeNotifications(handle) } {
        // Un fallo no garantiza el fin de los callbacks: conservar el contexto evita un UAF.
        std::mem::forget(context);
        return Err(format!("No se pudo finalizar la lectura de energía: {e}"));
    }
    result.map(Mode::from).map_err(|_| "No se recibió el modo de energía a tiempo".into())
}

/// Bloqueante: la WebView solo elige un destino fijo; OMEN se revalida según D-037.
pub fn open(target: OpenTarget) -> Result<(), String> {
    match target {
        OpenTarget::Settings => tauri_plugin_opener::open_url(target.destination(), None::<&str>)
            .map_err(|e| format!("No se pudo abrir Configuración de Windows: {e}")),
        OpenTarget::Omen => match crate::shortcuts::open_store_app(target.destination()) {
            Ok(true) => Ok(()),
            Ok(false) => Err("OMEN Gaming Hub no está instalado".into()),
            Err(e) => Err(format!("No se pudo abrir OMEN Gaming Hub: {e}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_mode_values() {
        for (json, mode, guid) in [
            ("efficiency", SetMode::Efficiency, 0x961cc777_2547_4f9d_8174_7d86181b8a7a),
            ("balanced", SetMode::Balanced, 0),
            ("performance", SetMode::Performance, 0xded574b5_45a0_4f42_8737_46345c09c238),
        ] {
            assert_eq!(serde_json::from_value::<SetMode>(serde_json::json!(json)).unwrap(), mode);
            assert_eq!(mode.guid(), GUID::from_u128(guid));
            assert!(set_with(mode, Some(|value: &GUID| {
                assert_eq!(*value, GUID::from_u128(guid));
                0
            })).is_ok());
        }
        for invalid in ["unknown", "", "Balanced", "00000000-0000-0000-0000-000000000000"] {
            assert!(serde_json::from_value::<SetMode>(serde_json::json!(invalid)).is_err());
        }
        assert!(serde_json::from_value::<SetMode>(serde_json::json!({ "mode": "balanced" })).is_err());
    }

    #[test]
    fn missing_api_and_setter_failure() {
        assert_eq!(
            set_with(SetMode::Balanced, None::<fn(&GUID) -> u32>).unwrap_err(),
            "Esta versión de Windows no dispone de la API para cambiar el modo de energía"
        );
        assert_eq!(
            set_with(SetMode::Performance, Some(|_: &GUID| 5)).unwrap_err(),
            "No se pudo cambiar el modo de energía (código de Windows 5)"
        );
    }

    #[test]
    fn current_supply_only() {
        assert_eq!(use_ac_power(1, 8), Ok(true));
        assert_eq!(use_ac_power(0, 1), Ok(false));
        assert_eq!(use_ac_power(1, 128), Ok(true));
        assert_eq!(use_ac_power(255, 128), Ok(true));
        assert_eq!(use_ac_power(1, 255), Ok(true));
        assert_eq!(use_ac_power(0, 255), Ok(false));
        assert!(use_ac_power(255, 255).is_err());
        assert!(use_ac_power(255, 1).is_err());
    }

    #[test]
    fn effective_modes() {
        for (raw, expected, json) in [
            (winpower::EffectivePowerModeBatterySaver, Mode::Efficiency, "efficiency"),
            (winpower::EffectivePowerModeBetterBattery, Mode::Efficiency, "efficiency"),
            (winpower::EffectivePowerModeBalanced, Mode::Balanced, "balanced"),
            (winpower::EffectivePowerModeHighPerformance, Mode::Performance, "performance"),
            (winpower::EffectivePowerModeMaxPerformance, Mode::Performance, "performance"),
            (winpower::EffectivePowerModeGameMode, Mode::Performance, "performance"),
            (winpower::EffectivePowerModeMixedReality, Mode::Performance, "performance"),
            (EFFECTIVE_POWER_MODE(-1), Mode::Unknown, "unknown"),
            (EFFECTIVE_POWER_MODE(99), Mode::Unknown, "unknown"),
        ] {
            assert_eq!(Mode::from(raw), expected);
            assert_eq!(serde_json::to_value(expected).unwrap(), json);
        }
    }

    #[test]
    fn fixed_targets() {
        for (json, expected, destination) in [
            ("settings", OpenTarget::Settings, "ms-settings:powersleep"),
            ("omen", OpenTarget::Omen, "AD2F1837.OMENCommandCenter_v10z8vjag6ke6!AD2F1837.OMENCommandCenter"),
        ] {
            let target: OpenTarget = serde_json::from_value(serde_json::json!(json)).unwrap();
            assert_eq!(target, expected);
            assert_eq!(target.destination(), destination);
        }
        for invalid in ["performance", "ms-settings:powersleep", "shell:AppsFolder", "", "OMEN"] {
            assert!(serde_json::from_value::<OpenTarget>(serde_json::json!(invalid)).is_err());
        }
        assert!(serde_json::from_value::<OpenTarget>(serde_json::json!({ "omen": OMEN_AUMID })).is_err());
    }
}
