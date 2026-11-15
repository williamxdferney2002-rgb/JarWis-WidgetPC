//! Historial del portapapeles propio de JarWis (D-028).
//!
//! - Solo texto (`CF_UNICODETEXT`), solo en memoria: nada se escribe en disco
//!   ni en logs y todo se pierde al salir.
//! - Captura por eventos: ventana de mensajes (`HWND_MESSAGE`) registrada con
//!   `AddClipboardFormatListener`, que recibe `WM_CLIPBOARDUPDATE` en un hilo propio.
//! - Se descarta lo que Windows marca como sensible y lo que copian los
//!   gestores de contraseñas conocidos.
//!
//! Nunca se imprime el contenido: ni en stdout/stderr ni en eventos (el evento
//! `clipboard-changed` no lleva datos; la lista se pide bajo demanda).

use serde::Serialize;

/// Máximo de elementos no fijados (los fijados no cuentan ni se expulsan).
pub const MAX_ITEMS: usize = 50;
/// Máximo de elementos fijados; alcanzar el límite no expulsa ninguno.
pub const MAX_PINNED: usize = 50;
/// Textos más largos (bytes UTF-8) se ignoran por completo.
pub const MAX_BYTES: usize = 64 * 1024;
/// Caracteres que recibe la interfaz por elemento (se muestra truncado a 2 líneas).
const PREVIEW_CHARS: usize = 300;

/// Gestores de contraseñas cuyo contenido copiado nunca se guarda (defensa adicional).
fn is_password_manager(exe: &str) -> bool {
    let exe = exe.to_ascii_lowercase();
    matches!(exe.as_str(), "bitwarden.exe" | "1password.exe" | "keepassxc.exe")
        || (exe.starts_with("keepass") && exe.ends_with(".exe"))
}

/// Datos del portapapeles que deciden si se captura (sin el texto).
#[derive(Debug, Default, Clone)]
pub struct Marks {
    /// Presente `ExcludeClipboardContentFromMonitorProcessing` (basta su presencia).
    pub exclude: bool,
    /// DWORD de `CanIncludeInClipboardHistory`, si está presente.
    pub can_include: Option<u32>,
    /// DWORD de `CanUploadToCloudClipboard`, si está presente.
    pub can_upload: Option<u32>,
    /// Nombre del ejecutable propietario del portapapeles (p. ej. `Bitwarden.exe`).
    pub owner_exe: Option<String>,
}

/// `true` si el contenido no debe guardarse. Ver
/// https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats
/// (`CanUploadToCloudClipboard`=0 solo afecta a la nube en Windows; aquí se
/// trata también como sensible, por prudencia).
pub fn excluded(m: &Marks) -> bool {
    m.exclude
        || m.can_include == Some(0)
        || m.can_upload == Some(0)
        || m.owner_exe.as_deref().is_some_and(is_password_manager)
}

/// `true` si el texto se puede guardar: no vacío (ni solo espacios) y ≤ 64 KB.
pub fn acceptable(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= MAX_BYTES
}

/// Decodifica un bloque `CF_UNICODETEXT` (UTF-16LE terminado en nulo).
/// Solo mira los primeros `(MAX_BYTES + 1) * 2` bytes: sin terminador en ese
/// tramo, el texto se rechaza (sobredimensionado o mal formado). Así ninguna
/// asignación crece con el tamaño total del bloque.
pub fn decode_utf16z(b: &[u8]) -> Option<String> {
    let b = &b[..b.len().min((MAX_BYTES + 1) * 2)];
    let chunks = b.as_chunks::<2>().0;
    let end = chunks.iter().position(|c| *c == [0, 0])?;
    // Cada unidad UTF-16 ocupa >= 1 byte en UTF-8: si ya son más, sobra.
    if end > MAX_BYTES {
        return None;
    }
    let units: Vec<u16> = chunks[..end].iter().map(|c| u16::from_le_bytes(*c)).collect();
    String::from_utf16(&units).ok()
}

/// Identificadores de los formatos de exclusión registrados.
#[derive(Debug, Clone, Copy)]
pub struct Formats {
    pub exclude: u32,
    pub include: u32,
    pub upload: u32,
}

impl Formats {
    /// `None` si alguno no se pudo registrar (0): sin ellos no se captura nada (fallo seguro).
    pub fn new(exclude: u32, include: u32, upload: u32) -> Option<Self> {
        (exclude != 0 && include != 0 && upload != 0).then_some(Self { exclude, include, upload })
    }
}

#[derive(Debug, Clone)]
struct Item {
    id: u64,
    text: String,
    /// Milisegundos desde la época Unix.
    at: i64,
    pinned: bool,
}

/// Elemento tal como lo recibe la interfaz: solo un fragmento del texto.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    pub id: u64,
    pub preview: String,
    pub at: i64,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub items: Vec<ItemView>,
    pub paused: bool,
}

/// Almacén en memoria, del más reciente al más antiguo.
#[derive(Debug, Default)]
pub struct Store {
    items: Vec<Item>,
    next_id: u64,
    /// Pausa rápida desde el panel (no se persiste).
    pub paused: bool,
}

impl Store {
    /// Añade un texto ya aceptado. Si existía, sube arriba (conserva id y fijado).
    /// Devuelve `false` si está en pausa o el texto no es aceptable.
    pub fn push(&mut self, text: String, now: i64) -> bool {
        if self.paused || !acceptable(&text) {
            return false;
        }
        let (id, pinned) = match self.items.iter().position(|x| x.text == text) {
            Some(i) => {
                let old = self.items.remove(i);
                (old.id, old.pinned)
            }
            None => {
                self.next_id += 1;
                (self.next_id, false)
            }
        };
        self.items.insert(0, Item { id, text, at: now, pinned });
        self.trim();
        true
    }

    /// Elementos cuyo texto contiene `query` (sin distinguir mayúsculas); vacío = todos.
    pub fn view(&self, query: &str) -> View {
        let q = query.trim().to_lowercase();
        let items = self
            .items
            .iter()
            .filter(|x| q.is_empty() || x.text.to_lowercase().contains(&q))
            .map(|x| ItemView { id: x.id, preview: x.text.chars().take(PREVIEW_CHARS).collect(), at: x.at, pinned: x.pinned })
            .collect();
        View { items, paused: self.paused }
    }

    /// Texto completo de un elemento (para copiarlo de nuevo).
    pub fn text(&self, id: u64) -> Option<String> {
        self.items.iter().find(|x| x.id == id).map(|x| x.text.clone())
    }

    /// Sube un elemento arriba con la hora `now` (al copiarlo de nuevo).
    pub fn touch(&mut self, id: u64, now: i64) -> bool {
        let Some(i) = self.items.iter().position(|x| x.id == id) else { return false };
        let mut item = self.items.remove(i);
        item.at = now;
        self.items.insert(0, item);
        true
    }

    pub fn pin(&mut self, id: u64, pinned: bool) -> Result<bool, String> {
        if pinned
            && self.items.iter().any(|x| x.id == id && !x.pinned)
            && self.items.iter().filter(|x| x.pinned).count() >= MAX_PINNED
        {
            return Err(format!("Máximo {MAX_PINNED} textos fijados. Desfija o borra uno para fijar otro."));
        }
        let found = self.items.iter_mut().find(|x| x.id == id);
        let ok = found.is_some();
        if let Some(x) = found {
            x.pinned = pinned;
        }
        // Al desfijar puede superarse el límite: se reaplica.
        if ok && !pinned {
            self.trim();
        }
        Ok(ok)
    }

    /// Expulsa los no fijados más antiguos por encima de `MAX_ITEMS`.
    fn trim(&mut self) {
        while self.items.iter().filter(|x| !x.pinned).count() > MAX_ITEMS {
            match self.items.iter().rposition(|x| !x.pinned) {
                Some(i) => drop(self.items.remove(i)),
                None => break,
            }
        }
    }

    pub fn remove(&mut self, id: u64) -> bool {
        let before = self.items.len();
        self.items.retain(|x| x.id != id);
        self.items.len() != before
    }

    /// «Borrar todo» y desactivar el historial: borra lo no fijado (como el Win+V de Windows).
    pub fn clear_unpinned(&mut self) {
        self.items.retain(|x| x.pinned);
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(windows)]
pub use win::{listen, write_text};

#[cfg(windows)]
mod win {
    use super::{decode_utf16z, excluded, Formats, Marks};
    use std::sync::atomic::{AtomicPtr, Ordering};
    use windows::core::{w, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::DataExchange::{
        AddClipboardFormatListener, CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardOwner,
        IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowThreadProcessId, RegisterClassW,
        HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLIPBOARDUPDATE, WNDCLASSW,
    };

    /// Ventana de mensajes del oyente. Es también la propietaria de lo que
    /// escribe JarWis: así sus propias copias se reconocen y no se recapturan.
    static WINDOW: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(core::ptr::null_mut());

    fn own_window() -> Option<HWND> {
        let p = WINDOW.load(Ordering::Acquire);
        (!p.is_null()).then_some(HWND(p))
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        DefWindowProcW(hwnd, msg, wp, lp)
    }

    /// El portapapeles puede estar abierto por otra app un instante: reintenta.
    fn open(owner: Option<HWND>) -> bool {
        for _ in 0..10 {
            if unsafe { OpenClipboard(owner) }.is_ok() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        false
    }

    /// Bloque de memoria global de un formato, como bytes (portapapeles abierto).
    fn with_data<T>(format: u32, f: impl FnOnce(&[u8]) -> Option<T>) -> Option<T> {
        unsafe {
            IsClipboardFormatAvailable(format).ok()?;
            let h = GetClipboardData(format).ok()?;
            let g = HGLOBAL(h.0);
            let size = GlobalSize(g);
            let p = GlobalLock(g) as *const u8;
            if p.is_null() {
                return None;
            }
            let out = f(std::slice::from_raw_parts(p, size));
            let _ = GlobalUnlock(g);
            out
        }
    }

    fn dword(format: u32) -> Option<u32> {
        with_data(format, |b| Some(u32::from_le_bytes(b.get(..4)?.try_into().ok()?)))
    }

    /// Ejecutable del propietario del portapapeles (solo el nombre del archivo).
    fn owner_exe(owner: HWND) -> Option<String> {
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(owner, Some(&mut pid));
            if pid == 0 {
                return None;
            }
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let res = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(h);
            res.ok()?;
            let path = String::from_utf16_lossy(buf.get(..len as usize)?);
            path.rsplit('\\').next().map(str::to_owned)
        }
    }

    /// Lee el texto si debe capturarse. Propietario, marcas y texto se leen con
    /// el portapapeles abierto (sin TOCTOU); el texto no se toca si está excluido.
    fn read(hwnd: HWND, f: &Formats) -> Option<String> {
        if !open(Some(hwnd)) {
            return None;
        }
        let text = read_open(hwnd, f);
        let _ = unsafe { CloseClipboard() };
        text
    }

    /// Con el portapapeles ya abierto (OpenClipboard no cambia el propietario).
    fn read_open(hwnd: HWND, f: &Formats) -> Option<String> {
        let owner = unsafe { GetClipboardOwner() }.ok().filter(|h| !h.is_invalid());
        // Escrito por JarWis desde el panel: no se recaptura.
        if owner == Some(hwnd) {
            return None;
        }
        let marks = Marks {
            exclude: unsafe { IsClipboardFormatAvailable(f.exclude) }.is_ok(),
            can_include: dword(f.include),
            can_upload: dword(f.upload),
            owner_exe: owner.and_then(owner_exe),
        };
        if excluded(&marks) {
            return None;
        }
        with_data(CF_UNICODETEXT.0 as u32, decode_utf16z)
    }

    /// Hilo oyente: llama a `on_text` con cada texto nuevo aceptable.
    /// `enabled` se consulta antes de abrir el portapapeles (desactivado = ni se lee).
    pub fn listen(enabled: impl Fn() -> bool + Send + 'static, on_text: impl Fn(String) + Send + 'static) -> std::io::Result<()> {
        std::thread::Builder::new().name("clipboard".into()).spawn(move || {
            let hwnd = unsafe {
                let Ok(module) = GetModuleHandleW(None) else { return };
                let class = w!("JarWisClipboardListener");
                let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: module.into(), lpszClassName: class, ..Default::default() };
                if RegisterClassW(&wc) == 0 {
                    eprintln!("Portapapeles: no se pudo registrar la clase de ventana");
                    return;
                }
                let Ok(hwnd) = CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    class,
                    PCWSTR::null(),
                    WINDOW_STYLE::default(),
                    0,
                    0,
                    0,
                    0,
                    Some(HWND_MESSAGE),
                    None,
                    Some(module.into()),
                    None,
                ) else {
                    eprintln!("Portapapeles: no se pudo crear la ventana de mensajes");
                    return;
                };
                if AddClipboardFormatListener(hwnd).is_err() {
                    eprintln!("Portapapeles: no se pudo registrar el oyente");
                    return;
                }
                hwnd
            };
            WINDOW.store(hwnd.0, Ordering::Release);
            let formats = unsafe {
                Formats::new(
                    RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing")),
                    RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory")),
                    RegisterClipboardFormatW(w!("CanUploadToCloudClipboard")),
                )
            };
            if formats.is_none() {
                // Sin poder detectar lo sensible no se captura nada (fallo seguro).
                eprintln!("Portapapeles: no se pudieron registrar los formatos de exclusión; no se capturará");
            }
            let mut msg = MSG::default();
            // Bloquea sin consumir CPU hasta el siguiente mensaje (0 = WM_QUIT, -1 = error).
            while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
                if msg.message == WM_CLIPBOARDUPDATE && msg.hwnd == hwnd {
                    if enabled() {
                        if let Some(text) = formats.as_ref().and_then(|f| read(hwnd, f)) {
                            on_text(text);
                        }
                    }
                } else {
                    unsafe { DispatchMessageW(&msg) };
                }
            }
        })?;
        Ok(())
    }

    /// Copia `text` al portapapeles como `CF_UNICODETEXT`, con la ventana del
    /// oyente como propietaria (no se recaptura). No añade formatos de exclusión:
    /// el historial de Windows lo registra con normalidad.
    pub fn write_text(text: &str) -> Result<(), String> {
        let hwnd = own_window().ok_or("El portapapeles no está disponible")?;
        let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        unsafe {
            let g = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).map_err(|_| "Sin memoria para copiar")?;
            let p = GlobalLock(g) as *mut u16;
            if p.is_null() {
                let _ = GlobalFree(Some(g));
                return Err("Sin memoria para copiar".into());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), p, wide.len());
            let _ = GlobalUnlock(g);
            if !open(Some(hwnd)) {
                let _ = GlobalFree(Some(g));
                return Err("El portapapeles está ocupado por otra aplicación".into());
            }
            let res = EmptyClipboard().and_then(|_| SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(g.0))));
            let _ = CloseClipboard();
            // Si SetClipboardData tuvo éxito, la memoria es del sistema.
            res.map(|_| ()).map_err(|_| {
                let _ = GlobalFree(Some(g));
                "No se pudo escribir en el portapapeles".to_string()
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(s: &Store) -> Vec<String> {
        s.view("").items.into_iter().map(|i| i.preview).collect()
    }

    #[test]
    fn limit_evicts_oldest_unpinned_only() {
        let mut s = Store::default();
        s.push("fijado".into(), 0);
        let pinned = s.view("").items[0].id;
        assert!(s.pin(pinned, true).unwrap());
        for i in 0..60 {
            s.push(format!("t{i}"), i);
        }
        let v = texts(&s);
        assert_eq!(v.len(), MAX_ITEMS + 1);
        assert_eq!(v[0], "t59");
        assert!(v.contains(&"fijado".to_string()));
        assert!(!v.contains(&"t9".to_string()) && v.contains(&"t10".to_string()));
        // Al desfijar se vuelve a respetar el límite.
        assert!(s.pin(pinned, false).unwrap());
        assert_eq!(texts(&s).len(), MAX_ITEMS);
    }

    #[test]
    fn pinned_limit_bounds_history_without_evicting_pins() {
        let mut s = Store::default();
        for i in 0..MAX_PINNED {
            assert!(s.push(format!("{i:04}{}", "x".repeat(MAX_BYTES - 4)), i as i64));
            assert!(s.pin(s.items[0].id, true).unwrap());
        }
        let oldest = s.items.last().unwrap().id;
        // Copiar y fijar repetidamente no permite eludir el tope.
        for i in 0..MAX_ITEMS * 3 {
            assert!(s.push(format!("extra-{i}"), i as i64));
            let before = s.view("");
            assert_eq!(s.pin(s.items[0].id, true), Err(format!(
                "Máximo {MAX_PINNED} textos fijados. Desfija o borra uno para fijar otro."
            )));
            assert_eq!(s.view(""), before, "rechazar no modifica el historial");
        }
        assert_eq!(s.items.len(), MAX_PINNED + MAX_ITEMS);
        assert_eq!(s.items.iter().filter(|x| x.pinned).count(), MAX_PINNED);
        assert!(s.items.iter().map(|x| x.text.len()).sum::<usize>() <= (MAX_PINNED + MAX_ITEMS) * MAX_BYTES);
        assert!(s.pin(oldest, true).unwrap(), "fijar de nuevo es idempotente");
        assert!(!s.pin(u64::MAX, true).unwrap());
        let text = s.text(oldest).unwrap();
        assert!(s.push(text, 999));
        assert_eq!(s.items[0].id, oldest);
        assert!(s.items[0].pinned);
        assert!(s.pin(oldest, false).unwrap());
        let candidate = s.items.iter().find(|x| !x.pinned).unwrap().id;
        assert!(s.pin(candidate, true).unwrap(), "desfijar libera un cupo");
        assert!(s.remove(candidate));
        let candidate = s.items.iter().find(|x| !x.pinned).unwrap().id;
        assert!(s.pin(candidate, true).unwrap(), "borrar libera un cupo");
        s.clear_unpinned();
        assert_eq!(s.items.len(), MAX_PINNED);
    }

    #[test]
    fn dedupe_moves_to_top_keeping_id_and_pin() {
        let mut s = Store::default();
        s.push("a".into(), 1);
        s.push("b".into(), 2);
        let a = s.view("a").items[0].id;
        s.pin(a, true).unwrap();
        s.push("a".into(), 3);
        let v = s.view("");
        assert_eq!(v.items.len(), 2);
        assert_eq!((v.items[0].id, v.items[0].pinned, v.items[0].at), (a, true, 3));
    }

    #[test]
    fn search_is_case_insensitive_and_preview_truncated() {
        let mut s = Store::default();
        s.push("Hola Mundo".into(), 1);
        s.push("otra cosa".into(), 2);
        assert_eq!(s.view("  mUNDO ").items.len(), 1);
        assert_eq!(s.view("").items.len(), 2);
        assert!(s.view("nada").items.is_empty());
        s.push("x".repeat(1000), 3);
        assert_eq!(s.view("xxx").items[0].preview.chars().count(), 300);
        let id = s.view("xxx").items[0].id;
        assert_eq!(s.text(id).map(|t| t.len()), Some(1000));
    }

    #[test]
    fn delete_clear_and_touch() {
        let mut s = Store::default();
        s.push("a".into(), 1);
        s.push("b".into(), 2);
        s.push("c".into(), 3);
        let a = s.view("a").items[0].id;
        let b = s.view("b").items[0].id;
        assert!(s.touch(a, 9));
        assert_eq!(texts(&s), ["a", "c", "b"]);
        assert!(s.remove(b));
        assert!(!s.remove(b));
        s.pin(a, true).unwrap();
        s.clear_unpinned();
        assert_eq!(texts(&s), ["a"]);
        assert!(!s.touch(999, 0) && !s.pin(999, true).unwrap());
    }

    #[test]
    fn pause_and_rejected_texts() {
        let mut s = Store { paused: true, ..Default::default() };
        assert!(!s.push("a".into(), 1));
        s.paused = false;
        assert!(!s.push("".into(), 1));
        assert!(!s.push(" \n\t".into(), 1));
        assert!(!s.push("x".repeat(MAX_BYTES + 1), 1));
        assert!(s.push("x".repeat(MAX_BYTES), 1));
        assert!(!s.view("").paused && s.view("").items.len() == 1);
    }

    #[test]
    fn exclusion_marks() {
        assert!(!excluded(&Marks::default()));
        assert!(excluded(&Marks { exclude: true, ..Default::default() }));
        assert!(excluded(&Marks { can_include: Some(0), ..Default::default() }));
        assert!(!excluded(&Marks { can_include: Some(1), ..Default::default() }));
        assert!(excluded(&Marks { can_upload: Some(0), ..Default::default() }));
        assert!(!excluded(&Marks { can_upload: Some(1), can_include: Some(1), ..Default::default() }));
        for exe in ["Bitwarden.exe", "1Password.exe", "KeePassXC.exe", "KeePass.exe", "keepass2.exe"] {
            assert!(excluded(&Marks { owner_exe: Some(exe.into()), ..Default::default() }), "{exe}");
        }
        for exe in ["notepad.exe", "chrome.exe", "Code.exe", "keepass.txt"] {
            assert!(!excluded(&Marks { owner_exe: Some(exe.into()), ..Default::default() }), "{exe}");
        }
    }

    fn utf16z(s: &str) -> Vec<u8> {
        s.encode_utf16().chain(Some(0)).flat_map(u16::to_le_bytes).collect()
    }

    #[test]
    fn decode_requires_terminator_within_limit() {
        assert_eq!(decode_utf16z(&utf16z("hola ñ")).as_deref(), Some("hola ñ"));
        // Basura tras el nulo (GlobalSize redondea) se ignora.
        let mut b = utf16z("abc");
        b.extend([0x41, 0, 0x42]);
        assert_eq!(decode_utf16z(&b).as_deref(), Some("abc"));
        // Sin terminador: se rechaza.
        assert_eq!(decode_utf16z(&utf16z("abc")[..6]), None);
        assert_eq!(decode_utf16z(&[]), None);
        // Justo en el límite se acepta; una unidad más, se rechaza.
        assert_eq!(decode_utf16z(&utf16z(&"x".repeat(MAX_BYTES))).map(|t| t.len()), Some(MAX_BYTES));
        assert_eq!(decode_utf16z(&utf16z(&"x".repeat(MAX_BYTES + 1))), None);
        // Bloque enorme: el nulo final queda fuera del tramo leído.
        assert_eq!(decode_utf16z(&utf16z(&"x".repeat(MAX_BYTES * 8))), None);
        // UTF-16 inválido (sustituto suelto).
        assert_eq!(decode_utf16z(&[0x00, 0xD8, 0, 0]), None);
    }

    #[test]
    fn unregistered_formats_disable_capture() {
        assert!(Formats::new(1, 2, 3).is_some());
        for (a, b, c) in [(0, 2, 3), (1, 0, 3), (1, 2, 0)] {
            assert!(Formats::new(a, b, c).is_none());
        }
    }

    /// Escribe y lee el portapapeles real con un texto ficticio (no lee el contenido previo
    /// del usuario: lo sobrescribe). Se ejecuta solo a petición: `cargo test -- --ignored`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn real_clipboard_listener_ignores_own_writes() {
        use std::sync::mpsc;
        let (tx, rx) = mpsc::channel();
        listen(|| true, move |t| drop(tx.send(t))).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        write_text("jarwis-prueba-propia").unwrap();
        assert!(rx.recv_timeout(std::time::Duration::from_millis(800)).is_err(), "no debe recapturar lo propio");
    }
}
