//! Lanzador de IA (antes panel Claude; D-044, D-047): app de Claude, Claude Code en la
//! terminal, página de uso, ChatGPT y Antigravity. Destinos fijos en el código: la
//! WebView solo envía la acción. El progreso de proyectos se retiró (D-047).

// D-024 (`panic = "abort"`): sin pánicos por construcción fuera de los tests.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing, clippy::string_slice)
)]

use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::Deserialize;

use crate::shortcuts::{check_path, fixed_exe, open_app_or_web, Kind};

pub const CLAUDE_URL: &str = "https://claude.ai";
/// Página oficial de uso de la cuenta (web + terminal + app).
pub const USAGE_URL: &str = "https://claude.ai/settings/usage";
/// App de escritorio de Claude (Microsoft Store).
pub const APP_AUMID: &str = "Claude_pzs8sxrjxfjjc!Claude";
/// ChatGPT (Microsoft Store), verificado con Get-StartApps (D-047).
pub const CHATGPT_AUMID: &str = "OpenAI.Codex_2p2nqsd0c76g0!App";
pub const CHATGPT_URL: &str = "https://chatgpt.com";
/// Antigravity IDE: no es de la Tienda; exe fijo bajo `%LOCALAPPDATA%` (D-047).
const ANTIGRAVITY_EXE: &str = r"Programs\Antigravity IDE\Antigravity IDE.exe";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenAction {
    Web,
    /// Windows Terminal con `claude` en `%USERPROFILE%`.
    Terminal,
    /// App de escritorio de la Tienda; si no está, claude.ai.
    App,
    /// claude.ai/settings/usage.
    Usage,
    /// App de la Tienda; si no está, chatgpt.com.
    Chatgpt,
    /// Exe fijo; sin web de respaldo.
    Antigravity,
}

fn browser(url: &str) -> Result<(), String> {
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| "No se pudo abrir el navegador".to_string())
}

/// Ejecuta la acción. Bloqueante (COM, procesos): llamar desde el pool.
pub fn open(action: OpenAction) -> Result<(), String> {
    match action {
        OpenAction::Web => browser(CLAUDE_URL),
        OpenAction::Usage => browser(USAGE_URL),
        OpenAction::App => open_app_or_web(APP_AUMID, None, CLAUDE_URL),
        OpenAction::Chatgpt => open_app_or_web(CHATGPT_AUMID, None, CHATGPT_URL),
        OpenAction::Terminal => open_terminal(),
        OpenAction::Antigravity => {
            let exe = antigravity_exe(std::env::var_os("LOCALAPPDATA").as_deref())
                .ok_or_else(|| "Antigravity no está instalado".to_string())?;
            tauri_plugin_opener::open_path(&exe, None::<&str>).map_err(|_| "No se pudo abrir Antigravity".to_string())
        }
    }
}

/// Ruta canónica del exe de Antigravity, solo si existe y no es enlace (`fixed_exe`).
fn antigravity_exe(local: Option<&std::ffi::OsStr>) -> Option<String> {
    fixed_exe(&PathBuf::from(local?).join(ANTIGRAVITY_EXE))
}

/// Carpeta válida para la terminal: existente, local y sin `;` ni `"` (`;` separa comandos en wt).
pub fn check_dir(dir: &str) -> Result<String, String> {
    let real = check_path(Kind::Folder, dir.trim())?;
    if real.contains([';', '"']) {
        return Err("La ruta de la carpeta no puede contener «;» ni comillas".into());
    }
    Ok(real)
}

/// `claude.exe` (nunca `.cmd`/`.bat`, CVE-2024-24576): primero `~\.local\bin`, luego `PATH`.
/// Solo rutas absolutas: un `claude.exe` en la carpeta actual no se ejecuta.
fn find_claude(home: Option<&std::ffi::OsStr>, path: Option<&std::ffi::OsStr>) -> Result<PathBuf, String> {
    let mut dirs: Vec<PathBuf> = home.map(|h| PathBuf::from(h).join(".local").join("bin")).into_iter().collect();
    dirs.extend(path.map(|p| std::env::split_paths(p).collect::<Vec<_>>()).unwrap_or_default());
    // `;` y `"` en la ruta romperían los argumentos de wt (mismo criterio que `check_dir`).
    let dirs: Vec<PathBuf> =
        dirs.into_iter().filter(|d| d.is_absolute() && !d.to_string_lossy().contains([';', '"'])).collect();
    if let Some(exe) = dirs.iter().map(|d| d.join("claude.exe")).find(|p| p.is_file()) {
        return Ok(exe);
    }
    if dirs.iter().any(|d| d.join("claude.cmd").is_file()) {
        return Err("Claude Code está instalado con npm (claude.cmd); JarWis solo lanza el instalador nativo (claude.exe)".into());
    }
    Err("No se encontró claude.exe (instala Claude Code con el instalador nativo)".into())
}

/// Windows Terminal en `%USERPROFILE%` con `claude`, sin shell intermedio.
fn open_terminal() -> Result<(), String> {
    let home = std::env::var_os("USERPROFILE").ok_or("No se encontró la carpeta de usuario")?;
    let dir = check_dir(&home.to_string_lossy())?;
    let exe = find_claude(Some(&home), std::env::var_os("PATH").as_deref())?;
    Command::new("wt.exe")
        .arg("-d")
        .arg(&dir)
        .arg(&exe)
        .stdin(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| "No se pudo abrir Windows Terminal".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("jarwis-claude-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn actions_serde() {
        for (s, a) in [
            ("web", OpenAction::Web),
            ("terminal", OpenAction::Terminal),
            ("app", OpenAction::App),
            ("usage", OpenAction::Usage),
            ("chatgpt", OpenAction::Chatgpt),
            ("antigravity", OpenAction::Antigravity),
        ] {
            assert_eq!(serde_json::from_str::<OpenAction>(&format!("\"{s}\"")).unwrap(), a);
        }
        // Retirada con los proyectos (D-047).
        assert!(serde_json::from_str::<OpenAction>("\"folder\"").is_err());
    }

    #[test]
    fn dir_validation() {
        let dir = tmp("dirs");
        let semi = dir.join("a;b");
        std::fs::create_dir_all(&semi).unwrap();
        assert!(check_dir(&dir.to_string_lossy()).is_ok());
        assert!(check_dir(&semi.to_string_lossy()).is_err(), "«;» rechazado");
        assert!(check_dir("relativa").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn antigravity_lookup() {
        let dir = tmp("ag");
        assert_eq!(antigravity_exe(Some(dir.as_os_str())), None, "no instalado");
        assert_eq!(antigravity_exe(None), None);
        let exe = dir.join(ANTIGRAVITY_EXE);
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"x").unwrap();
        assert_eq!(antigravity_exe(Some(dir.as_os_str())).as_deref(), exe.to_str());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn claude_exe_lookup() {
        let dir = tmp("exe");
        let bin = dir.join(".local").join("bin");
        let npm = dir.join("npm");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&npm).unwrap();
        std::fs::write(npm.join("claude.cmd"), b"x").unwrap();
        let path = std::env::join_paths([npm.clone(), PathBuf::from("rel")]).unwrap();
        let err = find_claude(Some(dir.as_os_str()), Some(&path)).unwrap_err();
        assert!(err.contains("npm"), "solo .cmd: error claro");
        std::fs::write(bin.join("claude.exe"), b"x").unwrap();
        assert_eq!(find_claude(Some(dir.as_os_str()), Some(&path)).unwrap(), bin.join("claude.exe"));
        // Directorio relativo en PATH: ignorado.
        assert!(find_claude(None, Some(std::ffi::OsStr::new("."))).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
