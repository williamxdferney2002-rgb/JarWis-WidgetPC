//! Accesos rápidos (JW-3-03): validación pura y apertura desde Rust.
//!
//! La WebView solo guarda la lista (`set_shortcuts`) y pide abrir un `id`
//! (`open_shortcut`); nunca un destino arbitrario. Nada de comandos de shell.

use serde::{Deserialize, Serialize};
use std::path::Path;

pub const MAX_SHORTCUTS: usize = 50;
pub(crate) const MAX_NAME: usize = 60;
const MAX_URL: usize = 2048;
const MAX_PATH: usize = 1024;

/// `file`: solo documentos, multimedia y comprimidos (lista blanca).
const FILE_EXT: &[&str] = &[
    "pdf", "txt", "md", "rtf", "csv", "log", "json", "xml", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods",
    "odp", "png", "jpg", "jpeg", "gif", "webp", "bmp", "mp3", "wav", "flac", "m4a", "mp4", "mkv", "mov", "avi", "zip",
];

/// Extensiones que ejecutan código o instalan al abrirse con el shell. Solo se
/// usa para carpetas: una «carpeta» con estos nombres puede ser un objeto del
/// shell en lugar de una carpeta normal.
const BLOCKED_EXT: &[&str] = &[
    "bat", "cmd", "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "msi", "scr", "com", "pif", "reg", "lnk",
    // Además de la lista pedida: otros que también ejecutan o instalan.
    "cpl", "msc", "msp", "mst", "msix", "msixbundle", "appx", "appxbundle", "appref-ms", "application", "url", "jar",
    "inf", "scf", "psm1", "psd1",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Url,
    App,
    Folder,
    File,
    /// App empaquetada (Microsoft Store): `target` es su AUMID (JW-3-08).
    Store,
}

/// App empaquetada instalada, para elegirla en Ajustes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreApp {
    pub name: String,
    pub app_id: String,
}

/// Paleta con nombre de los accesos (D-047). La WebView traduce cada nombre a su color.
pub const COLORS: &[&str] = &["blue", "red", "green", "orange", "purple", "pink", "teal", "yellow", "gray", "indigo"];
/// Iconos con nombre de los accesos (D-047).
pub const ICONS: &[&str] = &[
    "music", "video", "chat", "folder", "code", "game", "shop", "bank", "mail", "web", "app", "doc", "photo", "cloud",
    "terminal", "key", "star", "home",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Shortcut {
    /// 0 = nuevo (se asigna al guardar).
    #[serde(default)]
    pub id: u64,
    pub name: String,
    pub kind: Kind,
    pub target: String,
    /// Nombre de `COLORS`; `None`: la UI deriva uno. Archivos antiguos: `None`.
    #[serde(default)]
    pub color: Option<String>,
    /// Nombre de `ICONS`; `None`: icono por tipo.
    #[serde(default)]
    pub icon: Option<String>,
}

/// `Some` solo si el valor está en la lista blanca (carga tolerante: lo desconocido se descarta).
pub(crate) fn known(v: Option<String>, list: &[&str]) -> Option<String> {
    v.filter(|v| list.contains(&v.as_str()))
}

pub(crate) fn bad_chars(s: &str) -> bool {
    s.chars().any(char::is_control)
}

fn check_url(url: &str) -> Result<String, String> {
    let lower = url.to_ascii_lowercase();
    let ok = if let Some(rest) = lower.strip_prefix("ms-settings:") {
        rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    } else if let Some(rest) = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) {
        // Host no vacío y sin espacios (una URL válida no los lleva sin codificar).
        // Sin `@` en la autoridad: ni credenciales en settings.json ni
        // engaños como https://banco.com@malo.com.
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        !authority.is_empty() && !authority.contains('@') && !url.chars().any(char::is_whitespace)
    } else {
        false
    };
    if ok {
        Ok(url.to_string())
    } else {
        Err("Solo se admiten direcciones http://, https:// o ms-settings:".into())
    }
}

/// AUMID empaquetado `PackageFamilyName!AppId`: cada parte `[A-Za-z0-9._-]`, empieza por alfanumérico y sin `..`.
/// Sin barras, espacios ni `:`, así `shell:AppsFolder\<AUMID>` no puede salir de la carpeta.
fn check_store(target: &str) -> Result<String, String> {
    let ok_part = |p: &str, max: usize| {
        (1..=max).contains(&p.len())
            && p.as_bytes()[0].is_ascii_alphanumeric()
            && !p.contains("..")
            && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    match target.split_once('!') {
        Some((pfn, app)) if ok_part(pfn, 200) && ok_part(app, 100) => Ok(target.to_string()),
        _ => Err("Identificador de app de Microsoft Store no válido".into()),
    }
}

/// Apps empaquetadas instaladas (`FOLDERID_AppsFolder`, lo mismo que `Get-StartApps`),
/// ordenadas por nombre. Bloqueante: llamar fuera del hilo principal.
pub fn list_store_apps() -> Result<Vec<StoreApp>, String> {
    use crate::audio::{take_pwstr, Com};
    use windows::Win32::UI::Shell::{
        BHID_EnumItems, FOLDERID_AppsFolder, IEnumShellItems, IShellItem, SHGetKnownFolderItem, KF_FLAG_DEFAULT,
        SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
    };
    let _com = Com::init()?;
    let fail = |e: windows::core::Error| format!("No se pudieron listar las apps: {e}");
    let mut out: Vec<StoreApp> = Vec::new();
    // SAFETY: COM inicializado (`_com`); las cadenas se liberan en `take_pwstr`.
    unsafe {
        let folder: IShellItem = SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None).map_err(fail)?;
        let items: IEnumShellItems = folder.BindToHandler(None, &BHID_EnumItems).map_err(fail)?;
        let mut buf = [None];
        while items.Next(&mut buf, None).is_ok() {
            let Some(item) = buf[0].take() else { break };
            // El nombre de análisis relativo de cada elemento es su AppUserModelID.
            let app_id = item.GetDisplayName(SIGDN_PARENTRELATIVEPARSING).map(take_pwstr).unwrap_or_default();
            if check_store(&app_id).is_err() || out.iter().any(|a| a.app_id == app_id) {
                continue; // .exe sueltos, accesos web, etc.
            }
            let name = item.GetDisplayName(SIGDN_NORMALDISPLAY).map(take_pwstr).unwrap_or_default();
            out.push(StoreApp { name: if name.trim().is_empty() { app_id.clone() } else { name }, app_id });
        }
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

/// Ruta absoluta existente del tipo correcto. Devuelve la ruta canónica (sin
/// `\\?\`): resuelve nombres cortos 8.3, puntos finales y enlaces antes de
/// comprobar la extensión, que es la que verá el shell.
pub(crate) fn check_path(kind: Kind, target: &str) -> Result<String, String> {
    let path = Path::new(target);
    // Solo C:\…: ni rutas de red (\\servidor) ni relativas ni con argumentos.
    let drive = target.as_bytes();
    if !(path.is_absolute() && drive.len() >= 3 && drive[0].is_ascii_alphabetic() && &drive[1..3] == b":\\") {
        return Err("La ruta debe ser absoluta en una unidad local (p. ej. C:\\…)".into());
    }
    let real = std::fs::canonicalize(path).map_err(|_| "La ruta no existe o no es accesible".to_string())?;
    let real = real.to_string_lossy();
    let real = real.strip_prefix(r"\\?\").unwrap_or(&real).to_string();
    let rb = real.as_bytes();
    if !(rb.len() >= 3 && rb[0].is_ascii_alphabetic() && &rb[1..3] == b":\\") {
        return Err("La ruta debe estar en una unidad local".into());
    }
    let meta = std::fs::metadata(&real).map_err(|_| "La ruta no existe o no es accesible".to_string())?;
    let ext = Path::new(&real).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match kind {
        // `x.{CLSID}`: carpeta de unión del shell, se abriría como otro objeto.
        Kind::Folder if meta.is_dir() && (BLOCKED_EXT.contains(&ext.as_str()) || ext.starts_with('{')) => {
            Err(format!("Nombre de carpeta no permitido (.{ext})"))
        }
        Kind::Folder if meta.is_dir() => Ok(real),
        Kind::Folder => Err("La ruta no es una carpeta".into()),
        Kind::App if meta.is_file() && ext == "exe" => Ok(real),
        Kind::App => Err("Una aplicación debe ser un archivo .exe".into()),
        Kind::File if !meta.is_file() => Err("La ruta no es un archivo".into()),
        Kind::File if ext == "exe" => Err("Los .exe se añaden como aplicación".into()),
        Kind::File if FILE_EXT.contains(&ext.as_str()) => Ok(real),
        Kind::File => Err(format!("Tipo de archivo no permitido (.{ext})")),
        Kind::Url | Kind::Store => Err("Tipo no válido".into()),
    }
}

/// Valida un acceso y normaliza su nombre y destino.
pub fn validate_one(s: &Shortcut) -> Result<Shortcut, String> {
    let name = s.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME || bad_chars(name) {
        return Err(format!("El nombre debe tener entre 1 y {MAX_NAME} caracteres"));
    }
    let target = s.target.trim();
    let max = if s.kind == Kind::Url { MAX_URL } else { MAX_PATH };
    if target.is_empty() || target.len() > max || bad_chars(target) {
        return Err(format!("«{name}»: destino vacío o demasiado largo"));
    }
    let target = match s.kind {
        Kind::Url => check_url(target),
        Kind::Store => check_store(target),
        k => check_path(k, target),
    }
    .map_err(|e| format!("«{name}»: {e}"))?;
    if known(s.color.clone(), COLORS) != s.color || known(s.icon.clone(), ICONS) != s.icon {
        return Err(format!("«{name}»: color o icono no válido"));
    }
    Ok(Shortcut { id: s.id, name: name.to_string(), kind: s.kind, target, color: s.color.clone(), icon: s.icon.clone() })
}

/// Valida la lista completa: máximo 50, ids únicos; los 0 reciben uno nuevo.
pub fn validate(list: &[Shortcut]) -> Result<Vec<Shortcut>, String> {
    if list.len() > MAX_SHORTCUTS {
        return Err(format!("Máximo {MAX_SHORTCUTS} accesos rápidos"));
    }
    let mut out: Vec<Shortcut> = Vec::with_capacity(list.len());
    for s in list {
        if s.id != 0 && out.iter().any(|o| o.id == s.id) {
            return Err("Accesos rápidos con id repetido".into());
        }
        out.push(validate_one(s)?);
    }
    let mut next = out.iter().map(|s| s.id).max().unwrap_or(0);
    for s in out.iter_mut().filter(|s| s.id == 0) {
        next += 1;
        s.id = next;
    }
    Ok(out)
}

/// Abre un acceso ya guardado; se revalida (el archivo pudo cambiar desde entonces).
pub fn open(s: &Shortcut) -> Result<(), String> {
    let s = validate_one(s)?;
    let res = match s.kind {
        Kind::Store => {
            return match open_store_app(&s.target) {
                Ok(true) => Ok(()),
                Ok(false) => Err(format!("«{}»: La app ya no está instalada", s.name)),
                Err(e) => Err(format!("No se pudo abrir «{}»: {e}", s.name)),
            }
        }
        Kind::Url => tauri_plugin_opener::open_url(&s.target, None::<&str>),
        _ => tauri_plugin_opener::open_path(&s.target, None::<&str>),
    };
    res.map_err(|e| format!("No se pudo abrir «{}»: {e}", s.name))
}

/// Abre la app empaquetada `app_id` revalidada contra las instaladas (D-037).
/// `Ok(false)`: no está instalada. Bloqueante: llamar desde el pool.
pub fn open_store_app(app_id: &str) -> Result<bool, String> {
    let app_id = check_store(app_id)?;
    // COM (STA) vivo durante la enumeración y durante ShellExecuteExW sobre
    // `shell:AppsFolder`; `list_store_apps` reutiliza este apartamento.
    let _com = crate::audio::Com::init_sta()?;
    if !list_store_apps()?.iter().any(|a| a.app_id.eq_ignore_ascii_case(&app_id)) {
        return Ok(false);
    }
    // ShellExecuteExW sobre el shell (sin cmd.exe ni PowerShell).
    tauri_plugin_opener::open_url(format!("shell:AppsFolder\\{app_id}"), None::<&str>)
        .map(|()| true)
        .map_err(|e| e.to_string())
}

/// `.exe` en una ruta fija, solo si existe y su ruta canónica es la candidata (sin enlaces ni uniones).
pub(crate) fn fixed_exe(cand: &Path) -> Option<String> {
    let cand = cand.to_str().filter(|_| cand.is_absolute())?;
    check_path(Kind::App, cand).ok().filter(|real| real.eq_ignore_ascii_case(cand))
}

/// App de la Tienda `app_id`; si no está (o falla), el `.exe` fijo si existe; si no, `url`.
/// Destinos fijos en el código: la WebView nunca los envía. Bloqueante.
pub fn open_app_or_web(app_id: &str, exe: Option<std::path::PathBuf>, url: &str) -> Result<(), String> {
    if open_store_app(app_id).unwrap_or(false) {
        return Ok(());
    }
    if let Some(exe) = exe.as_deref().and_then(fixed_exe) {
        if tauri_plugin_opener::open_path(&exe, None::<&str>).is_ok() {
            return Ok(());
        }
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| "No se pudo abrir el navegador".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sc(kind: Kind, target: &str) -> Shortcut {
        Shortcut { id: 0, name: "Prueba".into(), kind, target: target.into(), color: None, icon: None }
    }

    fn tmp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("jarwis-shortcuts-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn urls() {
        for ok in ["https://example.com", "HTTP://example.com/a?b=c", "https://x.com/path/@user", "https://x.com?u=a@b.com", "ms-settings:display", "ms-settings:"] {
            assert!(validate_one(&sc(Kind::Url, ok)).is_ok(), "{ok}");
        }
        for bad in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-settings:display&calc",
            "https://",
            "https:///x",
            "https://a b.com",
            "https://user:pass@example.com",
            "https://banco.com@malo.com/login",
            "http://@x.com",
            "https://?x",
            "C:\\Windows",
            "search-ms:query=x",
            "\\\\server\\share",
        ] {
            assert!(validate_one(&sc(Kind::Url, bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn names_and_lengths() {
        let mut s = sc(Kind::Url, "https://example.com");
        s.name = "  ".into();
        assert!(validate_one(&s).is_err());
        s.name = "x".repeat(61);
        assert!(validate_one(&s).is_err());
        s.name = "a\u{0}b".into();
        assert!(validate_one(&s).is_err());
        s.name = "  Correo ".into();
        assert_eq!(validate_one(&s).unwrap().name, "Correo");
        assert!(validate_one(&sc(Kind::Url, &format!("https://e.com/{}", "a".repeat(MAX_URL)))).is_err());
    }

    #[test]
    fn paths() {
        let dir = tmp();
        let file = dir.join("nota.txt");
        let exe = dir.join("app.exe");
        let bat = dir.join("x.bat");
        for p in [&file, &exe, &bat] {
            std::fs::write(p, b"x").unwrap();
        }
        let d = dir.to_string_lossy().to_string();
        let f = file.to_string_lossy().to_string();
        let e = exe.to_string_lossy().to_string();
        let b = bat.to_string_lossy().to_string();

        assert!(validate_one(&sc(Kind::Folder, &d)).is_ok());
        assert!(validate_one(&sc(Kind::File, &f)).is_ok());
        // Lista blanca: extensión desconocida o sin extensión, rechazada.
        for name in ["script.py", "sin_extension", "doc.PDF"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let p = |n: &str| dir.join(n).to_string_lossy().to_string();
        assert!(validate_one(&sc(Kind::File, &p("script.py"))).is_err());
        assert!(validate_one(&sc(Kind::File, &p("sin_extension"))).is_err());
        assert!(validate_one(&sc(Kind::File, &p("doc.PDF"))).is_ok(), "sin distinguir mayúsculas");
        // Carpeta con «extensión» bloqueada.
        std::fs::create_dir_all(dir.join("raro.lnk")).unwrap();
        std::fs::create_dir_all(dir.join("fotos.2024")).unwrap();
        assert!(validate_one(&sc(Kind::Folder, &p("raro.lnk"))).is_err());
        assert!(validate_one(&sc(Kind::Folder, &p("fotos.2024"))).is_ok());
        let clsid = "x.{ED7BA470-8E54-465E-825C-99712043E01C}";
        std::fs::create_dir_all(dir.join(clsid)).unwrap();
        assert!(validate_one(&sc(Kind::Folder, &p(clsid))).is_err(), "unión CLSID");
        assert!(validate_one(&sc(Kind::App, &e)).is_ok());
        // Tipo incorrecto.
        assert!(validate_one(&sc(Kind::Folder, &f)).is_err());
        assert!(validate_one(&sc(Kind::File, &d)).is_err());
        assert!(validate_one(&sc(Kind::App, &f)).is_err());
        assert!(validate_one(&sc(Kind::File, &e)).is_err(), ".exe solo como app");
        // Scripts, también con trucos de nombre que Windows normaliza.
        assert!(validate_one(&sc(Kind::File, &b)).is_err());
        assert!(validate_one(&sc(Kind::File, &format!("{b}."))).is_err(), "punto final");
        assert!(validate_one(&sc(Kind::File, &format!("{b} "))).is_err(), "espacio final");
        // Argumentos, relativas, red e inexistentes.
        assert!(validate_one(&sc(Kind::App, &format!("{e} --flag"))).is_err());
        assert!(validate_one(&sc(Kind::App, &format!("\"{e}\""))).is_err());
        assert!(validate_one(&sc(Kind::File, "nota.txt")).is_err());
        assert!(validate_one(&sc(Kind::Folder, "\\\\localhost\\c$")).is_err());
        assert!(validate_one(&sc(Kind::Folder, "\\\\?\\C:\\Windows")).is_err());
        assert!(validate_one(&sc(Kind::File, &dir.join("no.txt").to_string_lossy())).is_err());
        // Flujo alternativo NTFS.
        assert!(validate_one(&sc(Kind::File, &format!("{f}:x.bat"))).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn list_ids_and_limit() {
        let mut a = sc(Kind::Url, "https://a.com");
        a.id = 7;
        let list = validate(&[sc(Kind::Url, "https://b.com"), a.clone(), sc(Kind::Url, "https://c.com")]).unwrap();
        assert_eq!(list.iter().map(|s| s.id).collect::<Vec<_>>(), [8, 7, 9]);
        assert!(validate(&[a.clone(), a]).is_err(), "id repetido");
        assert!(validate(&vec![sc(Kind::Url, "https://a.com"); 51]).is_err());
        assert!(validate(&vec![sc(Kind::Url, "https://a.com"); 50]).is_ok());
        assert!(validate(&[sc(Kind::Url, "ftp://x")]).is_err());
    }

    #[test]
    fn store_ids() {
        for ok in ["4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", "a!b"] {
            assert!(validate_one(&sc(Kind::Store, ok)).is_ok(), "{ok}");
        }
        let long_pfn = format!("{}!App", "a".repeat(201));
        let long_app = format!("x!{}", "a".repeat(101));
        for bad in [
            "Netflix",
            "!App",
            "Pkg!",
            "Pkg!App!Extra",
            "..!App",
            "Pkg!.App",
            "P..kg!App",
            "Pkg!..\\..\\Windows",
            "..\\Pkg!App",
            "Pkg/x!App",
            "C:Pkg!App",
            "shell:AppsFolder\\Pkg!App",
            "Pkg !App",
            "Pkg!App x",
            "Pkg!Äpp",
            long_pfn.as_str(),
            long_app.as_str(),
        ] {
            assert!(validate_one(&sc(Kind::Store, bad)).is_err(), "{bad}");
        }
        assert!(validate_one(&sc(Kind::Store, &format!("{}!{}", "a".repeat(200), "b".repeat(100)))).is_ok());
    }

    #[test]
    fn fixed_exe_and_aumids() {
        let dir = tmp().join("fixed");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("Spotify.exe");
        std::fs::write(&exe, b"x").unwrap();
        assert_eq!(fixed_exe(&exe).as_deref(), exe.to_str());
        assert_eq!(fixed_exe(&dir.join("no.exe")), None);
        assert_eq!(fixed_exe(&dir), None, "carpeta");
        assert_eq!(fixed_exe(Path::new(r"Spotify\Spotify.exe")), None, "relativa");
        // Los AUMID fijos del código pasan la validación de `store`.
        for id in [
            "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify",
            "4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App",
            crate::claude::APP_AUMID,
            crate::claude::CHATGPT_AUMID,
        ] {
            assert!(check_store(id).is_ok(), "{id}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Lee las apps instaladas del equipo: solo imprime el conteo y si están Netflix, Spotify, Claude y ChatGPT.
    #[test]
    #[ignore]
    fn store_apps_live() {
        // Mismo apartamento que `open` con `store` (STA), sin abrir nada.
        let _com = crate::audio::Com::init_sta().unwrap();
        let apps = list_store_apps().unwrap();
        let has = |id: &str| apps.iter().any(|a| a.app_id.eq_ignore_ascii_case(id));
        let netflix = has("4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App");
        let spotify = has("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify");
        let claude = has(crate::claude::APP_AUMID);
        let chatgpt = has(crate::claude::CHATGPT_AUMID);
        println!("apps={} netflix={netflix} spotify={spotify} claude={claude} chatgpt={chatgpt}", apps.len());
        assert!(apps.windows(2).all(|w| w[0].name.to_lowercase() <= w[1].name.to_lowercase()));
        assert!(apps.iter().all(|a| check_store(&a.app_id).is_ok()));
    }

    #[test]
    fn serde_shape() {
        let s: Shortcut =
            serde_json::from_str(r#"{"id":1,"name":"N","kind":"folder","target":"C:\\x"}"#).unwrap();
        assert_eq!(s.kind, Kind::Folder);
        let s: Shortcut = serde_json::from_str(r#"{"id":2,"name":"N","kind":"store","target":"P!A"}"#).unwrap();
        assert_eq!(s.kind, Kind::Store);
        let a = serde_json::to_value(StoreApp { name: "N".into(), app_id: "P!A".into() }).unwrap();
        assert_eq!(a, serde_json::json!({ "name": "N", "appId": "P!A" }));
        assert!(serde_json::from_str::<Shortcut>(r#"{"name":"N","kind":"shell","target":"x"}"#).is_err());
        assert_eq!((s.color.as_deref(), s.icon.as_deref()), (None, None), "archivos antiguos sin color ni icono");
    }

    #[test]
    fn color_and_icon_whitelist() {
        let mut s = sc(Kind::Url, "https://example.com");
        assert_eq!((COLORS.len(), ICONS.len()), (10, 18));
        s.color = Some("blue".into());
        s.icon = Some("key".into());
        let ok = validate_one(&s).unwrap();
        assert_eq!((ok.color.as_deref(), ok.icon.as_deref()), (Some("blue"), Some("key")));
        for (c, i) in [(Some("#ff0000"), None), (Some("Blue"), None), (None, Some("<svg>")), (Some(""), None)] {
            s.color = c.map(Into::into);
            s.icon = i.map(Into::into);
            assert!(validate_one(&s).is_err(), "{c:?} {i:?}");
        }
        assert_eq!(known(Some("rainbow".into()), COLORS), None);
        assert_eq!(known(Some("teal".into()), COLORS).as_deref(), Some("teal"));
    }
}
