//! Mostrar Mini mediante el atajo fijo de Codex, sin seleccionar ventanas.

use std::sync::{Mutex, MutexGuard, TryLockError};
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS};
use windows::Win32::Storage::Packaging::Appx::GetPackageFamilyName;
use windows::Win32::System::ProcessStatus::EnumProcesses;
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN,
    VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN,
};

const MODIFIERS_ERROR: &str = "Suelta Shift, Ctrl, Alt y Win antes de usar la mascota de Codex.";
// Consultada con Get-AppxPackage OpenAI.Codex; no aceptar otros publicadores.
const CODEX_PACKAGE_FAMILY: &str = "OpenAI.Codex_2p2nqsd0c76g0";
static ACTION_LOCK: Mutex<()> = Mutex::new(());

fn key(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}

fn inputs() -> Vec<INPUT> {
    let down = |vk| key(vk, 0, KEYBD_EVENT_FLAGS(0));
    let up = |vk| key(vk, 0, KEYEVENTF_KEYUP);
    vec![
        key(VK_LWIN, 0, KEYEVENTF_EXTENDEDKEY),
        down(VK_LMENU),
        down(VIRTUAL_KEY(u16::from(b'P'))),
        up(VIRTUAL_KEY(u16::from(b'P'))),
        up(VK_LMENU),
        key(VK_LWIN, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP),
    ]
}

fn is_codex_family(family: &str) -> bool {
    family == CODEX_PACKAGE_FAMILY
}

fn is_codex_process(pid: u32) -> bool {
    // Identidad del paquete del PID, nunca una subcadena de una ruta controlable.
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let result = (|| {
            let mut length = 0;
            if GetPackageFamilyName(process, &mut length, None) != ERROR_INSUFFICIENT_BUFFER
                || length > 256
            {
                return false;
            }
            let mut family = vec![0u16; length as usize];
            if GetPackageFamilyName(process, &mut length, Some(PWSTR(family.as_mut_ptr())))
                != ERROR_SUCCESS
            {
                return false;
            }
            String::from_utf16(&family[..length.saturating_sub(1) as usize])
                .is_ok_and(|s| is_codex_family(&s))
        })();
        let closed = CloseHandle(process).is_ok();
        result && closed
    }
}

fn require_codex_process() -> Result<(), String> {
    // Enumera PID, sin nombres, rutas, títulos ni contenido de los procesos.
    let mut pids = vec![0; 1024];
    loop {
        let bytes = (pids.len() * std::mem::size_of::<u32>()) as u32;
        let mut used = 0;
        unsafe { EnumProcesses(pids.as_mut_ptr(), bytes, &mut used) }
            .map_err(|_| "No se pudo comprobar si Codex está abierto.".to_string())?;
        if used < bytes {
            pids.truncate(used as usize / std::mem::size_of::<u32>());
            return if pids.into_iter().any(is_codex_process) {
                Ok(())
            } else {
                Err("Codex no está abierto. Abre Codex y vuelve a intentarlo.".into())
            };
        }
        if pids.len() >= 65536 {
            return Err("No se pudo comprobar si Codex está abierto.".into());
        }
        pids.resize(pids.len() * 2, 0);
    }
}

// Adaptador de entrada también inyectable: los tests ejercitan envío y liberación.
trait InputAdapter {
    fn modifiers_down(&mut self) -> bool;
    fn inject(&mut self, keys: &[INPUT]) -> u32;
}

fn held_key_releases(sent: &[INPUT]) -> Vec<INPUT> {
    let mut held: Vec<KEYBDINPUT> = vec![];
    for input in sent {
        let key = unsafe { input.Anonymous.ki };
        let identity = |k: &KEYBDINPUT| (k.wVk.0, k.wScan, k.dwFlags.0 & !KEYEVENTF_KEYUP.0);
        if key.dwFlags.contains(KEYEVENTF_KEYUP) {
            held.retain(|k| identity(k) != identity(&key));
        } else if !held.iter().any(|k| identity(k) == identity(&key)) {
            held.push(key);
        }
    }
    let only_lwin = held.len() == 1 && held[0].wVk == VK_LWIN;
    let mut releases: Vec<_> = held
        .into_iter()
        .rev()
        .map(|k| key(k.wVk, k.wScan, k.dwFlags | KEYEVENTF_KEYUP))
        .collect();
    if only_lwin {
        // VK no asignada: suprimir Inicio cuando el prefijo solo llegó a LWIN abajo.
        releases.splice(
            0..0,
            [
                key(VIRTUAL_KEY(0xE8), 0, KEYBD_EVENT_FLAGS(0)),
                key(VIRTUAL_KEY(0xE8), 0, KEYEVENTF_KEYUP),
            ],
        );
    }
    releases
}

fn send_input_checked<A: InputAdapter>(adapter: &mut A, keys: &[INPUT]) -> Result<(), String> {
    if adapter.modifiers_down() {
        return Err(MODIFIERS_ERROR.into());
    }
    let sent = adapter.inject(keys) as usize;
    if sent == keys.len() {
        return Ok(());
    }
    // La liberación no depende del primer plano ni de modificadoras: evita teclas atascadas.
    let releases = held_key_releases(&keys[..sent.min(keys.len())]);
    if !releases.is_empty() && adapter.inject(&releases) != releases.len() as u32 {
        return Err("Windows rechazó la liberación de teclas de la mascota de Codex. Suelta las teclas modificadoras antes de continuar.".into());
    }
    Err("Windows rechazó el atajo de la mascota de Codex. Abre Codex y vuelve a intentarlo.".into())
}

struct WindowsInput;

fn physical_modifiers_down(mut state: impl FnMut(VIRTUAL_KEY) -> i16) -> bool {
    [
        VK_LSHIFT,
        VK_RSHIFT,
        VK_LCONTROL,
        VK_RCONTROL,
        VK_LMENU,
        VK_RMENU,
        VK_LWIN,
        VK_RWIN,
    ]
    .iter()
    .any(|vk| state(*vk) < 0)
}

impl InputAdapter for WindowsInput {
    fn modifiers_down(&mut self) -> bool {
        physical_modifiers_down(|vk| unsafe { GetAsyncKeyState(i32::from(vk.0)) })
    }
    fn inject(&mut self, keys: &[INPUT]) -> u32 {
        unsafe { SendInput(keys, std::mem::size_of::<INPUT>() as i32) }
    }
}

fn action_lock(lock: &Mutex<()>) -> Result<MutexGuard<'_, ()>, String> {
    match lock.try_lock() {
        Ok(guard) => Ok(guard),
        Err(TryLockError::Poisoned(error)) => Ok(error.into_inner()),
        Err(TryLockError::WouldBlock) => {
            Err("Espera a que termine la acción de la mascota de Codex.".into())
        }
    }
}

/// Sin argumentos: la WebView nunca proporciona texto ni teclas.
pub fn show() -> Result<(), String> {
    let _lock = action_lock(&ACTION_LOCK)?;
    require_codex_process()?;
    send_input_checked(&mut WindowsInput, &inputs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    fn sequence(keys: &[INPUT]) -> Vec<(u16, u16, u32)> {
        keys.iter()
            .map(|input| {
                assert_eq!(input.r#type, INPUT_KEYBOARD);
                let k = unsafe { input.Anonymous.ki };
                assert_eq!((k.time, k.dwExtraInfo), (0, 0));
                (k.wVk.0, k.wScan, k.dwFlags.0)
            })
            .collect()
    }
    #[test]
    fn os_package_identity_rejects_profile_path_spoof() {
        assert!(is_codex_family(CODEX_PACKAGE_FAMILY));
        for value in [
            "",
            "Other_0123456789abc",
            "OpenAI.CodexOther_0123456789abc",
            "OpenAI.Codex_",
            "OpenAI.Codex_0123456789abc",
            "OpenAI.Codex_2p2nqsd0c76g1",
            "openai.codex_2p2nqsd0c76g0",
            "OpenAI.Codex_2p2nqsd0c76g0 ",
            r"C:\Users\x\Program Files\WindowsApps\OpenAI.Codex_0123456789abc\app\Codex.exe",
            r"C:\Program Files\WindowsApps\OpenAI.Codex_0123456789abc\app\Codex.exe",
        ] {
            assert!(!is_codex_family(value));
        }
        // El proceso del propio test carece de identidad del paquete, cualquiera que sea su ruta.
        assert!(!is_codex_process(std::process::id()));
    }
    #[derive(Default)]
    struct FakeInput {
        modifier: Option<VIRTUAL_KEY>,
        results: VecDeque<u32>,
        blocks: Vec<Vec<(u16, u16, u32)>>,
    }
    impl InputAdapter for FakeInput {
        fn modifiers_down(&mut self) -> bool {
            physical_modifiers_down(|vk| {
                if self.modifier == Some(vk) {
                    i16::MIN
                } else {
                    0
                }
            })
        }
        fn inject(&mut self, keys: &[INPUT]) -> u32 {
            self.blocks.push(sequence(keys));
            self.modifier = Some(VK_RSHIFT);
            self.results.pop_front().unwrap_or(keys.len() as u32)
        }
    }
    #[test]
    fn every_partial_prefix_releases_only_held_keys() {
        let prefixes = vec![
            vec![],
            vec![(0xe8, 0, 0), (0xe8, 0, 2), (0x5b, 0, 3)],
            vec![(0xa4, 0, 2), (0x5b, 0, 3)],
            vec![(0x50, 0, 2), (0xa4, 0, 2), (0x5b, 0, 3)],
            vec![(0xa4, 0, 2), (0x5b, 0, 3)],
            vec![(0xe8, 0, 0), (0xe8, 0, 2), (0x5b, 0, 3)],
        ];
        {
            let keys = inputs();
            assert_eq!(keys.len(), prefixes.len());
            for (sent, releases) in prefixes.into_iter().enumerate() {
                let mut adapter = FakeInput {
                    results: [sent as u32].into(),
                    ..Default::default()
                };
                assert!(send_input_checked(&mut adapter, &keys).is_err());
                assert_eq!(
                    adapter.blocks.len(),
                    if releases.is_empty() { 1 } else { 2 }
                );
                if !releases.is_empty() {
                    assert_eq!(adapter.blocks[1], releases);
                }
            }
        }
        assert_eq!(
            sequence(&held_key_releases(&inputs()[..3])),
            [(0x50, 0, 2), (0xa4, 0, 2), (0x5b, 0, 3)]
        );
    }
    #[test]
    fn failed_or_partial_release_reports_error_without_retry() {
        for released in [0, 1, 2] {
            let mut a = FakeInput {
                results: [3, released].into(),
                ..Default::default()
            };
            assert!(send_input_checked(&mut a, &inputs())
                .unwrap_err()
                .contains("liberación"));
            assert_eq!(a.blocks.len(), 2);
        }
    }
    #[test]
    fn lwin_only_cleanup_masks_start_and_reports_every_partial_release() {
        for prefix in [1, 5] {
            let keys = inputs();
            assert_eq!(
                sequence(&held_key_releases(&keys[..prefix])),
                [(0xe8, 0, 0), (0xe8, 0, 2), (0x5b, 0, 3)]
            );
            for released in 0..3 {
                let mut adapter = FakeInput {
                    results: [prefix as u32, released].into(),
                    ..Default::default()
                };
                assert!(send_input_checked(&mut adapter, &keys)
                    .unwrap_err()
                    .contains("liberación"));
                assert_eq!(adapter.blocks.len(), 2);
            }
        }
    }
    #[test]
    fn show_requires_modifiers_and_handles_all_prefixes() {
        let keys = inputs();
        assert_eq!(
            sequence(&keys),
            [
                (0x5b, 0, 1),
                (0xa4, 0, 0),
                (0x50, 0, 0),
                (0x50, 0, 2),
                (0xa4, 0, 2),
                (0x5b, 0, 3)
            ]
        );
        for sent in 0..=keys.len() {
            let mut a = FakeInput {
                results: [sent as u32].into(),
                ..Default::default()
            };
            assert_eq!(
                send_input_checked(&mut a, &keys).is_ok(),
                sent == keys.len()
            );
            if sent > 0 && sent < keys.len() {
                assert_eq!(a.blocks.len(), 2);
            }
        }
        for modifier in [
            VK_LSHIFT,
            VK_RSHIFT,
            VK_LCONTROL,
            VK_RCONTROL,
            VK_LMENU,
            VK_RMENU,
            VK_LWIN,
            VK_RWIN,
        ] {
            let mut a = FakeInput {
                modifier: Some(modifier),
                ..Default::default()
            };
            assert_eq!(
                send_input_checked(&mut a, &keys),
                Err(MODIFIERS_ERROR.into())
            );
            assert!(a.blocks.is_empty());
        }
    }
    #[test]
    fn poisoned_mutex_is_recovered_and_busy_mutex_is_rejected() {
        let lock = Mutex::new(());
        let _ = std::panic::catch_unwind(|| {
            let _guard = lock.lock().unwrap();
            panic!("test");
        });
        let guard = action_lock(&lock).unwrap();
        assert!(action_lock(&lock).is_err());
        drop(guard);
        assert!(action_lock(&lock).is_ok());
    }
}
