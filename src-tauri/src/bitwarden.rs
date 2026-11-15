//! Bitwarden (D-045): solo detecta la app de escritorio para sembrar, una única vez, el
//! acceso rápido «Bitwarden». Nunca lee su carpeta de datos, su bóveda ni el portapapeles.
//! La apertura es la de cualquier acceso guardado (`shortcuts::open`).

// D-024 (`panic = "abort"`): sin pánicos por construcción fuera de los tests.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing, clippy::string_slice)
)]

use std::ffi::OsStr;
use std::path::Path;

use crate::settings::Settings;
use crate::shortcuts::{self, Kind, Shortcut, MAX_SHORTCUTS};

const NAME: &str = "Bitwarden";

/// Primer `Bitwarden.exe` válido: `%LOCALAPPDATA%\Programs\…` y después `%ProgramFiles%\…`.
/// Variables relativas ignoradas; la ruta canónica debe ser la candidata (sin enlaces ni uniones).
fn find_exe(local: Option<&OsStr>, program_files: Option<&OsStr>) -> Option<String> {
    let candidates = [
        local.map(|b| Path::new(b).join(r"Programs\Bitwarden\Bitwarden.exe")),
        program_files.map(|b| Path::new(b).join(r"Bitwarden\Bitwarden.exe")),
    ];
    candidates.into_iter().flatten().find_map(|p| shortcuts::fixed_exe(&p))
}

/// AUMID de la app empaquetada cuyo nombre visible es «Bitwarden» (sin mayúsculas).
/// Bloqueante; COM STA durante la enumeración.
fn find_store() -> Result<Option<String>, String> {
    let _com = crate::audio::Com::init_sta()?;
    Ok(shortcuts::list_store_apps()?.into_iter().find(|a| a.name.trim().eq_ignore_ascii_case("bitwarden")).map(|a| a.app_id))
}

/// Acceso sembrable: `app` con el `.exe` detectado o, si no, `store` con su AUMID.
/// Bloqueante (enumera apps por COM); los fallos cuentan como «no instalado».
pub fn detect() -> Option<Shortcut> {
    let (kind, target) = match find_exe(std::env::var_os("LOCALAPPDATA").as_deref(), std::env::var_os("ProgramFiles").as_deref()) {
        Some(exe) => (Kind::App, exe),
        None => (Kind::Store, find_store().ok().flatten()?),
    };
    // Color azul e icono de llave (D-047).
    shortcuts::validate_one(&Shortcut {
        id: 0,
        name: NAME.into(),
        kind,
        target,
        color: Some("blue".into()),
        icon: Some("key".into()),
    })
    .ok()
}

/// Ajustes con el acceso sembrado al principio y la bandera marcada; `None`: nada que cambiar.
/// Sin Bitwarden no se marca (se reintenta al arrancar). Si ya hay un acceso con el mismo
/// destino, o la lista está llena, solo se marca la bandera.
pub fn seed(s: &Settings, found: Option<Shortcut>) -> Option<Settings> {
    if s.bitwarden_seeded {
        return None;
    }
    let bw = found?;
    let mut list = s.shortcuts.clone();
    let dup = list.iter().any(|x| x.target.eq_ignore_ascii_case(&bw.target));
    if !dup && list.len() < MAX_SHORTCUTS {
        let id = list.iter().map(|x| x.id).max().unwrap_or(0).saturating_add(1);
        list.insert(0, Shortcut { id, ..bw });
    }
    Some(Settings { shortcuts: list, bitwarden_seeded: true, ..s.clone() }.normalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("jarwis-bw-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fake_exe(base: &Path, rel: &str) -> String {
        let p = base.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"MZ").unwrap();
        p.to_str().unwrap().to_string()
    }

    #[test]
    fn find_exe_prefers_localappdata() {
        let local = tmp("local");
        let pf = tmp("pf");
        let l = fake_exe(&local, r"Programs\Bitwarden\Bitwarden.exe");
        let p = fake_exe(&pf, r"Bitwarden\Bitwarden.exe");
        let found = find_exe(Some(local.as_os_str()), Some(pf.as_os_str())).unwrap();
        assert!(found.eq_ignore_ascii_case(&l));
        let found = find_exe(None, Some(pf.as_os_str())).unwrap();
        assert!(found.eq_ignore_ascii_case(&p));
        let _ = std::fs::remove_dir_all(local);
        let _ = std::fs::remove_dir_all(pf);
    }

    #[test]
    fn find_exe_rejects_folder_relative_and_missing() {
        let local = tmp("folder");
        std::fs::create_dir_all(local.join(r"Programs\Bitwarden\Bitwarden.exe")).unwrap();
        assert_eq!(find_exe(Some(local.as_os_str()), None), None, "carpeta llamada Bitwarden.exe");
        assert_eq!(find_exe(Some(OsStr::new(r"relativo\x")), Some(OsStr::new("."))), None, "variables relativas");
        assert_eq!(find_exe(None, None), None);
        let _ = std::fs::remove_dir_all(local);
    }

    fn bw(target: &str) -> Shortcut {
        Shortcut { id: 0, name: NAME.into(), kind: Kind::Store, target: target.into(), color: Some("blue".into()), icon: Some("key".into()) }
    }

    fn url(id: u64) -> Shortcut {
        Shortcut { id, name: format!("A{id}"), kind: Kind::Url, target: format!("https://example.com/{id}"), color: None, icon: None }
    }

    #[test]
    fn seed_once_first_and_without_duplicates() {
        let base = Settings { shortcuts: vec![url(3), url(7)], ..Settings::default() };
        assert_eq!(seed(&base, None), None, "sin Bitwarden: ni acceso ni bandera");
        let s = seed(&base, Some(bw("Bitwarden.App_x!App"))).unwrap();
        assert!(s.bitwarden_seeded);
        assert_eq!(s.shortcuts.iter().map(|x| x.id).collect::<Vec<_>>(), [8, 3, 7], "el primero, id nuevo");
        assert_eq!(s.shortcuts[0].name, "Bitwarden");
        assert_eq!((s.shortcuts[0].color.as_deref(), s.shortcuts[0].icon.as_deref()), (Some("blue"), Some("key")));
        assert_eq!(seed(&s, Some(bw("Bitwarden.App_x!App"))), None, "ya sembrado");
        // El usuario lo borra: no vuelve.
        let deleted = Settings { shortcuts: vec![url(3)], ..s };
        assert_eq!(seed(&deleted, Some(bw("Bitwarden.App_x!App"))), None);
        // Mismo destino ya guardado: solo la bandera.
        let mine = Settings { shortcuts: vec![Shortcut { name: "BW".into(), ..bw("BITWARDEN.App_x!App") }], ..Settings::default() };
        let s = seed(&mine, Some(bw("Bitwarden.App_x!App"))).unwrap();
        assert!(s.bitwarden_seeded && s.shortcuts == mine.shortcuts);
        // Lista llena: solo la bandera.
        let full = Settings { shortcuts: (1..=50).map(url).collect(), ..Settings::default() };
        assert_eq!(seed(&full, Some(bw("Bitwarden.App_x!App"))).unwrap().shortcuts.len(), 50);
    }

    /// Sistema real, sin lanzar nada: `cargo test -- --ignored live_detect`. Solo el tipo.
    #[test]
    #[ignore]
    fn live_detect() {
        println!("desktop={:?}", detect().map(|s| s.kind));
    }
}
