//! Ajustes persistidos en `settings.json` dentro de `app_config_dir`.
//!
//! La lectura es tolerante: un archivo inexistente o dañado devuelve los
//! valores por defecto sin pánico (el dañado se conserva como `.corrupt`).

use crate::clock::{normalize_alarms, Alarm};
use crate::layout::{Edge, EdgeOffsets, Mode};
use crate::shortcuts::{bad_chars, known, Shortcut, COLORS, ICONS, MAX_NAME};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};

/// Una sola puerta de escritura: el lector nunca conserva el bloqueo durante
/// efectos nativos. La publicación termina antes de admitir otro escritor.
pub struct Store {
    writer: Mutex<()>,
    current: RwLock<Settings>,
    path: PathBuf,
}

impl Store {
    pub fn new(path: PathBuf, initial: Settings) -> Self {
        Self { writer: Mutex::new(()), current: RwLock::new(initial), path }
    }

    pub fn current(&self) -> Settings {
        self.current.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn update(
        &self,
        edit: impl FnOnce(&Settings) -> Result<Settings, String>,
        publish: impl FnOnce(&Settings, &Settings),
    ) -> Result<Settings, String> {
        let _writer = self.writer.lock().unwrap_or_else(|p| p.into_inner());
        let old = self.current();
        let new = edit(&old)?.normalize();
        if new == old {
            return Ok(old);
        }
        save(&self.path, &new).map_err(|e| format!("No se pudieron guardar los ajustes: {e}"))?;
        *self.current.write().unwrap_or_else(|p| p.into_inner()) = new.clone();
        publish(&old, &new);
        Ok(new)
    }
}

/// Widgets conocidos, en su orden por defecto.
/// «passwords» se retiró (D-045): `normalize` lo descarta de los archivos antiguos.
pub const WIDGETS: [&str; 10] = ["clock", "system", "mail", "calendar", "claude", "clipboard", "codex-pet", "media", "shortcuts", "today"];

/// Espacios de trabajo (JW-7-02): máximo de espacios y de accesos por espacio.
pub const MAX_WORKSPACES: usize = 10;
pub const MAX_WORKSPACE_ITEMS: usize = 10;

/// Espacio de trabajo: abre de golpe varios accesos rápidos guardados (solo por id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workspace {
    /// 0 = nuevo (se asigna al guardar).
    #[serde(default)]
    pub id: u64,
    pub name: String,
    /// Ids de accesos rápidos existentes.
    pub shortcuts: Vec<u64>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// Color de la isla.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum IslandColor {
    #[default]
    Black,
    Royal,
}

/// Estilo visual de la barra (JW-11-02a); la interfaz lo aplica como `data-style`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BarStyle {
    #[default]
    Classic,
    Aurora,
}

/// Acentos predefinidos de Aurora; permiten combinarlo con el escritorio sin leer el fondo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AuroraAccent {
    Violet,
    #[default]
    Cyan,
    Amber,
}

/// Mascota de la pastilla minimizada (D-056). Un valor desconocido de un archivo
/// antiguo carga como `Air` sin marcar el archivo como dañado.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mascot {
    #[default]
    Air,
    Fire,
    Water,
    Earth,
}

/// Icono del widget de la mascota de Codex (D-071).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CodexPetIcon {
    #[default]
    Dog,
    Dragon,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub edge: Edge,
    /// Nombre del monitor; `None` = monitor principal.
    pub monitor: Option<String>,
    pub always_on_top: bool,
    pub mode: Mode,
    /// Presencia mínima independiente del último modo; archivos antiguos: false.
    pub minimized: bool,
    /// Segundos sin interacción para compactar; 0 = apagado, resto entre 10 y 600.
    pub auto_compact_seconds: u32,
    pub theme: Theme,
    pub island_color: IslandColor,
    /// Animar el pulso del icono Sistema (desactivado: icono estático).
    pub pulse_animation: bool,
    pub autostart: bool,
    pub widget_order: Vec<String>,
    /// Solo oculta accesos de la barra; los servicios siguen activos.
    pub hidden_widgets: Vec<String>,
    /// Alarmas del reloj (archivos antiguos sin el campo: ninguna).
    pub alarms: Vec<Alarm>,
    /// Historial del portapapeles (solo en memoria). Archivos antiguos: activado.
    pub clipboard_history: bool,
    /// Accesos rápidos (JW-3-03). Archivos antiguos: ninguno. Solo se cambian
    /// con `set_shortcuts` (validados); los parches los rechazan.
    pub shortcuts: Vec<Shortcut>,
    /// Posición a lo largo de cada borde (D-047). Solo la cambian el arrastre y «Centrar»;
    /// los parches la rechazan. `claudeProjects` (retirado, D-047) se ignora al cargar.
    pub bar_offsets: EdgeOffsets,
    /// `barOffsets` ya marca el centro de la isla (JW-15-04). Archivos antiguos: false, y
    /// el arranque los migra una vez con el monitor de la barra. Solo lo cambia esa migración.
    #[serde(default)]
    pub bar_offsets_center: bool,
    /// Avisos de correo nuevo y evento próximo (D-039). Opt-in: archivos antiguos, desactivado.
    pub notifications: bool,
    /// Espacios de trabajo (JW-7-02). Solo se cambian con `set_workspaces` (validados);
    /// los parches los rechazan.
    pub workspaces: Vec<Workspace>,
    /// Ciudad manual; se valida en el parche y se conserva en los demás cambios.
    pub weather_place: Option<crate::weather::WeatherPlace>,
    /// Acceso «Bitwarden» ya sembrado (D-045): no se vuelve a insertar aunque se borre.
    /// Solo lo cambia la siembra; los parches lo rechazan.
    pub bitwarden_seeded: bool,
    /// Escribir tareas, agenda y correo limitado (D-081) en `%LOCALAPPDATA%\JarWis\hoy.json` (D-048). Archivos
    /// antiguos: activado (decisión del usuario). Apagarlo borra el archivo.
    pub share_today: bool,
    /// Estilo de la barra (JW-11-02a). Archivos antiguos: clásico.
    pub bar_style: BarStyle,
    pub aurora_accent: AuroraAccent,
    /// Mascota de Mini (preferencia de apariencia). Archivos antiguos: aire.
    #[serde(deserialize_with = "lenient_mascot")]
    pub mascot: Mascot,
    /// Independiente de Mini. Archivos antiguos: perrito.
    #[serde(deserialize_with = "lenient_codex_pet_icon")]
    pub codex_pet_icon: CodexPetIcon,
}

/// Icono desconocido o de otro tipo → `Dog` (no daña el archivo).
fn lenient_codex_pet_icon<'de, D: serde::Deserializer<'de>>(d: D) -> Result<CodexPetIcon, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(CodexPetIcon::deserialize(v).unwrap_or_default())
}

/// Mascota desconocida o de otro tipo → `Air` (no daña el archivo).
fn lenient_mascot<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Mascot, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(Mascot::deserialize(v).unwrap_or_default())
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            edge: Edge::Top,
            monitor: None,
            always_on_top: true,
            mode: Mode::Compact,
            minimized: false,
            auto_compact_seconds: 40,
            theme: Theme::System,
            island_color: IslandColor::Black,
            pulse_animation: true,
            autostart: false,
            widget_order: WIDGETS.iter().map(|s| s.to_string()).collect(),
            hidden_widgets: Vec::new(),
            alarms: Vec::new(),
            clipboard_history: true,
            shortcuts: Vec::new(),
            bar_offsets: EdgeOffsets::default(),
            bar_offsets_center: true,
            notifications: false,
            workspaces: Vec::new(),
            weather_place: None,
            bitwarden_seeded: false,
            share_today: true,
            bar_style: BarStyle::Classic,
            aurora_accent: AuroraAccent::Cyan,
            mascot: Mascot::Air,
            codex_pet_icon: CodexPetIcon::Dog,
        }
    }
}

impl Settings {
    /// Parche superficial: los campos omitidos se toman del estado vigente.
    /// Las listas presentes se sustituyen completas; no es JSON Merge Patch.
    pub fn patched(&self, patch: serde_json::Value) -> Result<Self, String> {
        let fields = patch.as_object().ok_or("El parche de ajustes debe ser un objeto JSON")?;
        let mut value = serde_json::to_value(self).map_err(|e| e.to_string())?;
        let target = value.as_object_mut().ok_or("Ajustes inválidos")?;
        for (key, value) in fields {
            if matches!(key.as_str(), "shortcuts" | "workspaces" | "barOffsets" | "barOffsetsCenter" | "bitwardenSeeded" | "minimized" | "alarms" | "widgetOrder") {
                return Err(format!("El campo {key} tiene una vía de actualización propia"));
            }
            if !target.contains_key(key) {
                return Err(format!("Campo de ajustes desconocido: {key}"));
            }
            target.insert(key.clone(), value.clone());
        }
        let new = serde_json::from_value::<Self>(value)
            .map_err(|e| format!("Parche de ajustes inválido: {e}"))?;
        if WIDGETS.iter().all(|id| new.hidden_widgets.iter().any(|hidden| hidden == id)) {
            return Err("Debe quedar al menos un widget visible en la barra".into());
        }
        if fields.contains_key("weatherPlace") {
            if let Some(place) = &new.weather_place { place.validate()?; }
        }
        Ok(new.normalize())
    }

    /// Opera sobre la lista vigente; el id siempre lo asigna el núcleo.
    pub fn alarm_added(&self, mut alarm: Alarm) -> Result<Self, String> {
        if self.alarms.len() >= crate::clock::MAX_ALARMS {
            return Err(format!("Máximo {} alarmas", crate::clock::MAX_ALARMS));
        }
        alarm.id = self.alarms.iter().map(|a| a.id).max().unwrap_or(0)
            .checked_add(1).ok_or("No se pudo asignar un id de alarma")?;
        let mut new = self.clone();
        new.alarms.push(alarm);
        new.alarms = normalize_alarms(new.alarms);
        Ok(new)
    }

    pub fn alarm_enabled(&self, id: u64, enabled: bool) -> Self {
        let mut new = self.clone();
        if let Some(alarm) = new.alarms.iter_mut().find(|a| a.id == id) {
            alarm.enabled = enabled;
        }
        new
    }

    pub fn alarm_removed(&self, id: u64) -> Self {
        let mut new = self.clone();
        new.alarms.retain(|a| a.id != id);
        new
    }

    /// Inserta en el índice que ocupaba el destino antes de quitar el origen.
    pub fn widget_moved(&self, id: &str, target: &str) -> Self {
        let mut new = self.clone();
        if id != target {
            if let (Some(from), Some(to)) = (
                new.widget_order.iter().position(|x| x == id),
                new.widget_order.iter().position(|x| x == target),
            ) {
                let item = new.widget_order.remove(from);
                new.widget_order.insert(to, item);
            }
        }
        new
    }

    /// Deja `widget_order` con cada widget conocido exactamente una vez:
    /// descarta desconocidos y duplicados y añade los que falten.
    pub fn normalize(mut self) -> Self {
        if self.auto_compact_seconds != 0 {
            self.auto_compact_seconds = self.auto_compact_seconds.clamp(10, 600);
        }
        let mut order: Vec<String> = Vec::with_capacity(WIDGETS.len());
        for id in self.widget_order {
            if WIDGETS.contains(&id.as_str()) && !order.contains(&id) {
                order.push(id);
            }
        }
        // JW-34-6F: solo al faltar la mascota se conserva su posición antigua.
        // Si el archivo no traía Portapapeles, la mascota se añade al final.
        let pet_position = order.iter().position(|id| id == "clipboard").map(|i| i + 1);
        for id in WIDGETS.into_iter().filter(|id| *id != "codex-pet") {
            if !order.iter().any(|o| o == id) {
                order.push(id.to_string());
            }
        }
        if !order.iter().any(|id| id == "codex-pet") {
            order.insert(pet_position.unwrap_or(order.len()), "codex-pet".into());
        }
        self.widget_order = order;
        let mut hidden = Vec::with_capacity(WIDGETS.len());
        for id in self.hidden_widgets {
            if WIDGETS.contains(&id.as_str()) && !hidden.contains(&id) {
                hidden.push(id);
            }
        }
        // Recuperación tolerante de archivos editados a mano: conservar el reloj.
        if hidden.len() == WIDGETS.len() {
            hidden.retain(|id| id != "clock");
        }
        self.hidden_widgets = hidden;
        self.alarms = normalize_alarms(self.alarms);
        self.bar_offsets = self.bar_offsets.sanitize();
        // Color e icono fuera de la lista blanca: sin color ni icono (no rompe la carga).
        for s in &mut self.shortcuts {
            s.color = known(s.color.take(), COLORS);
            s.icon = known(s.icon.take(), ICONS);
        }
        self.weather_place = self.weather_place.and_then(|p| p.validate().ok());
        self.workspaces = prune_workspaces(self.workspaces, &self.shortcuts);
        self
    }
}

/// Recorte tolerante al cargar o tras borrar accesos: como máximo 10 espacios y
/// 10 ids por espacio, sin ids repetidos ni inexistentes. Ids de espacio 0 o
/// repetidos reciben uno nuevo. Un espacio puede quedar vacío (se edita en Ajustes).
fn prune_workspaces(mut list: Vec<Workspace>, shortcuts: &[Shortcut]) -> Vec<Workspace> {
    list.truncate(MAX_WORKSPACES);
    let mut next = list.iter().map(|w| w.id).max().unwrap_or(0);
    let mut seen: Vec<u64> = Vec::with_capacity(list.len());
    for w in &mut list {
        w.color = known(w.color.take(), COLORS);
        w.icon = known(w.icon.take(), ICONS);
        if w.id == 0 || seen.contains(&w.id) {
            next = next.saturating_add(1);
            w.id = next;
        }
        seen.push(w.id);
        let mut ids: Vec<u64> = Vec::with_capacity(w.shortcuts.len());
        // Corta al llegar al máximo: la WebView puede enviar listas enormes (H1 de JW-7-02).
        for id in w.shortcuts.drain(..) {
            if ids.len() == MAX_WORKSPACE_ITEMS {
                break;
            }
            if !ids.contains(&id) && shortcuts.iter().any(|s| s.id == id) {
                ids.push(id);
            }
        }
        w.shortcuts = ids;
    }
    list
}

/// Valida la lista que envía Ajustes: máximo 10 espacios, nombre de 1–60
/// caracteres sin controles, 1–10 ids existentes sin repetir e ids de espacio
/// únicos; los 0 reciben uno nuevo.
pub fn validate_workspaces(list: &[Workspace], shortcuts: &[Shortcut]) -> Result<Vec<Workspace>, String> {
    if list.len() > MAX_WORKSPACES {
        return Err(format!("Máximo {MAX_WORKSPACES} espacios de trabajo"));
    }
    let mut out: Vec<Workspace> = Vec::with_capacity(list.len());
    for w in list {
        if w.id != 0 && out.iter().any(|o| o.id == w.id) {
            return Err("Espacios de trabajo con id repetido".into());
        }
        if w.color.as_ref().is_some_and(|c| !COLORS.contains(&c.as_str())) || w.icon.as_ref().is_some_and(|i| !ICONS.contains(&i.as_str())) {
            return Err("Color o icono del espacio no permitido".into());
        }
        let name = w.name.trim();
        if name.is_empty() || name.chars().count() > MAX_NAME || bad_chars(name) {
            return Err(format!("El nombre del espacio debe tener entre 1 y {MAX_NAME} caracteres"));
        }
        if w.shortcuts.is_empty() || w.shortcuts.len() > MAX_WORKSPACE_ITEMS {
            return Err(format!("«{name}»: elige entre 1 y {MAX_WORKSPACE_ITEMS} accesos"));
        }
        for (i, id) in w.shortcuts.iter().enumerate() {
            if w.shortcuts.iter().take(i).any(|x| x == id) {
                return Err(format!("«{name}»: acceso repetido"));
            }
            if !shortcuts.iter().any(|s| s.id == *id) {
                return Err(format!("«{name}»: un acceso ya no existe"));
            }
        }
        out.push(Workspace { id: w.id, name: name.to_string(), shortcuts: w.shortcuts.clone(), color: w.color.clone(), icon: w.icon.clone() });
    }
    let mut next = out.iter().map(|w| w.id).max().unwrap_or(0);
    for w in out.iter_mut().filter(|w| w.id == 0) {
        next = next.saturating_add(1);
        w.id = next;
    }
    Ok(out)
}

/// Interpreta el JSON; `None` si está dañado.
pub fn parse(text: &str) -> Option<Settings> {
    serde_json::from_str::<Settings>(text).ok().map(Settings::normalize)
}

/// Carga los ajustes; nunca falla.
pub fn load(path: &Path) -> Settings {
    let Ok(bytes) = std::fs::read(path) else {
        return Settings::default();
    };
    // UTF-8 inválido también cuenta como archivo dañado.
    match std::str::from_utf8(&bytes).ok().and_then(parse) {
        Some(s) => s,
        None => {
            // Se aparta el archivo dañado para no perderlo al guardar de nuevo.
            let _ = std::fs::rename(path, path.with_extension("json.corrupt"));
            Settings::default()
        }
    }
}

/// Guarda de forma atómica (archivo temporal + renombrado).
fn save(path: &Path, settings: &Settings) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(std::io::Error::other)?;
    let (tmp, mut file) = create_temp(path)?;
    let result = (|| {
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn create_temp(path: &Path) -> std::io::Result<(PathBuf, std::fs::File)> {
    loop {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let tmp = path.with_extension(format!("json.{}.{sequence}.tmp", std::process::id()));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(file) => return Ok((tmp, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_compact_migrates_clamps_and_validates_patches() {
        assert_eq!(Settings::default().auto_compact_seconds, 40);
        assert_eq!(parse("{}").unwrap().auto_compact_seconds, 40);
        for (input, expected) in [(0, 0), (1, 10), (9, 10), (10, 10), (40, 40), (600, 600), (601, 600), (u32::MAX, 600)] {
            let json = serde_json::json!({"autoCompactSeconds": input});
            let loaded = parse(&json.to_string()).unwrap();
            let patched = Settings::default().patched(json).unwrap();
            assert_eq!(loaded.auto_compact_seconds, expected);
            assert_eq!(patched.auto_compact_seconds, expected);
            assert_eq!(parse(&serde_json::to_string(&patched).unwrap()), Some(patched.clone()));
            assert_eq!(patched.patched(serde_json::json!({"theme": "dark"})).unwrap().auto_compact_seconds, expected);
        }
        for input in [serde_json::json!(-1), serde_json::json!(1.5), serde_json::json!("40"), serde_json::Value::Null, serde_json::json!(4294967296_u64)] {
            assert!(Settings::default().patched(serde_json::json!({"autoCompactSeconds": input})).is_err());
        }
    }

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("target/jw-16-01-tests");
            let dir = root.join(format!("{}-{}", std::process::id(), TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> PathBuf {
            self.0.join("settings.json")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn dropped_center_is_saved_reloaded_and_reused_for_every_shape() {
        use crate::layout::{bar_rect, offset_at, Rect, Shape};
        let fixture = Fixture::new();
        let wa = Rect { x: -1920, y: 40, width: 1920, height: 1040 };
        for scale in [1.0, 1.25, 1.5, 2.0] {
            for edge in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right] {
                for shape in [Shape::Mini, Shape::Compact, Shape::Expanded, Shape::Panel] {
                    for fraction in [0.2, 0.7, 0.95] {
                        let dropped = bar_rect(wa, scale, edge, shape, fraction);
                        let offset = offset_at(wa, scale, edge,
                            f64::from(dropped.x) + f64::from(dropped.width) / 2.0,
                            f64::from(dropped.y) + f64::from(dropped.height) / 2.0);
                        let store = Store::new(fixture.path(), Settings {
                            bar_offsets: EdgeOffsets::default().with(edge, 0.0), ..Settings::default()
                        });
                        store.update(|old| Ok(Settings {
                            edge, bar_offsets: old.bar_offsets.with(edge, offset), ..old.clone()
                        }), |_, saved| {
                            // Publicar/recolocar ve la misma fracción que el archivo persistido.
                            let disk = load(&fixture.path());
                            assert!((disk.bar_offsets.get(edge) - saved.bar_offsets.get(edge)).abs() <= f64::EPSILON);
                            assert_eq!(bar_rect(wa, scale, disk.edge, shape, disk.bar_offsets.get(disk.edge)), dropped);
                            assert_eq!(bar_rect(wa, scale, saved.edge, shape, saved.bar_offsets.get(saved.edge)), dropped);
                        }).unwrap();
                        // Un parche de UI y un reinicio conservan la posición soltada.
                        store.update(|old| old.patched(serde_json::json!({"theme": "dark"})), |_, _| {}).unwrap();
                        let restarted = Store::new(fixture.path(), load(&fixture.path()));
                        let saved = restarted.current();
                        assert!((saved.bar_offsets.get(edge) - offset).abs() <= f64::EPSILON);
                        assert_eq!(bar_rect(wa, scale, edge, shape, saved.bar_offsets.get(edge)), dropped);
                    }
                }
            }
        }
    }

    #[test]
    fn concurrent_patches_keep_both_changes_and_publish_saved_state() {
        use std::sync::{Arc, Barrier};
        let fixture = Fixture::new();
        let store = Arc::new(Store::new(fixture.path(), Settings::default()));
        let start = Arc::new(Barrier::new(3));
        let published = Arc::new(Mutex::new(Vec::new()));
        let threads: Vec<_> = [serde_json::json!({"theme": "dark"}), serde_json::json!({"mode": "expanded"})]
            .into_iter().map(|patch| {
                let (store, start, published) = (store.clone(), start.clone(), published.clone());
                std::thread::spawn(move || {
                    start.wait();
                    store.update(|old| {
                        assert!(store.writer.try_lock().is_err(), "lectura y modificación bajo el mutex escritor");
                        old.patched(patch)
                    }, |old, new| {
                        assert!(store.writer.try_lock().is_err(), "publicación bajo el mismo mutex");
                        assert_eq!(store.current(), *new);
                        assert_eq!(load(&store.path), *new);
                        let mut seen = published.lock().unwrap();
                        if let Some(previous) = seen.last() {
                            assert_eq!(old, previous, "el escritor anterior terminó de publicar");
                        }
                        seen.push(new.clone());
                    }).unwrap();
                })
            }).collect();
        start.wait();
        for thread in threads {
            thread.join().unwrap();
        }
        let current = store.current();
        assert_eq!((current.theme, current.mode), (Theme::Dark, Mode::Expanded));
        assert_eq!(load(&fixture.path()), current);
        assert_eq!(published.lock().unwrap().len(), 2);
    }

    #[test]
    fn stale_view_patch_keeps_fired_alarm_and_drag_offsets() {
        let fixture = Fixture::new();
        let stale = Settings {
            alarms: vec![Alarm { id: 1, hour: 9, minute: 0, days: vec![], label: "Prueba".into(), enabled: true }],
            ..Settings::default()
        };
        let store = Store::new(fixture.path(), stale.clone());
        // Simula el disparo y el arrastre después de abrir Ajustes.
        store.update(|old| {
            let mut new = old.clone();
            new.alarms[0].enabled = false;
            new.bar_offsets = old.bar_offsets.with(Edge::Top, 0.2);
            Ok(new)
        }, |_, _| {}).unwrap();
        // La vista vieja envía únicamente la preferencia que acaba de editar.
        let patch = serde_json::json!({"theme": "dark"});
        assert!(stale.alarms[0].enabled);
        assert_ne!(stale.bar_offsets, store.current().bar_offsets);
        let new = store.update(|old| old.patched(patch), |_, _| {}).unwrap();
        assert!(!new.alarms[0].enabled);
        assert_eq!(new.bar_offsets.top, 0.2);
        assert_eq!(new.theme, Theme::Dark);
        assert_eq!(load(&fixture.path()), new);
    }

    #[test]
    fn alarm_operations_use_current_list_after_one_shot_fires() {
        let fixture = Fixture::new();
        let stale = Settings { alarms: vec![Alarm { id: 7, ..Alarm::default() }], ..Settings::default() };
        let store = Store::new(fixture.path(), stale.clone());
        // on_fired desactiva la alarma después de que la vista recibe su copia.
        store.update(|old| Ok(old.alarm_enabled(7, false)), |_, _| {}).unwrap();
        assert!(store.update(|old| old.patched(serde_json::json!({"alarms": stale.alarms})), |_, _| panic!("parche rechazado")).is_err());
        let new = store.update(|old| old.alarm_added(Alarm {
            id: u64::MAX, hour: 99, minute: 99, days: vec![6, 1, 1, 9], label: "  Prueba\n  ".into(), ..Alarm::default()
        }), |_, _| {}).unwrap();
        assert!(!new.alarms[0].enabled);
        assert_eq!(new.alarms[1], Alarm { id: 8, hour: 23, minute: 59, days: vec![1, 6], label: "Prueba".into(), enabled: true });
        let new = store.update(|old| Ok(old.alarm_enabled(8, false)), |_, _| {}).unwrap();
        assert!(new.alarms.iter().all(|a| !a.enabled));
        let new = store.update(|old| Ok(old.alarm_removed(8)), |_, _| {}).unwrap();
        assert_eq!(new.alarms, vec![Alarm { id: 7, enabled: false, ..Alarm::default() }]);
        assert_eq!(new.alarm_removed(999), new);
        assert_eq!(new.alarm_enabled(999, true), new);
        assert_eq!(load(&fixture.path()), new);
        assert!(Settings { alarms: vec![Alarm { id: u64::MAX, ..Alarm::default() }], ..Settings::default() }
            .alarm_added(Alarm::default()).is_err());
        let full = Settings { alarms: (1..=50).map(|id| Alarm { id, ..Alarm::default() }).collect(), ..Settings::default() };
        assert!(full.alarm_added(Alarm::default()).is_err());
    }

    #[test]
    fn hidden_widgets_load_old_settings_and_normalize() {
        assert!(Settings::default().hidden_widgets.is_empty());
        assert!(parse("{}").unwrap().hidden_widgets.is_empty());
        let new = parse(r#"{"hiddenWidgets":["mail","unknown","mail","clipboard"]}"#).unwrap();
        assert_eq!(new.hidden_widgets, ["mail", "clipboard"]);
        assert_eq!(new.widget_order.len(), WIDGETS.len());
        let full = parse(&serde_json::json!({"hiddenWidgets": WIDGETS}).to_string()).unwrap();
        assert_eq!(full.hidden_widgets.len(), WIDGETS.len() - 1);
        assert!(!full.hidden_widgets.iter().any(|id| id == "clock"));
    }

    #[test]
    fn hidden_widgets_patch_preserves_services_order_and_other_changes() {
        let fixture = Fixture::new();
        let old = Settings { alarms: vec![Alarm { id: 1, ..Alarm::default() }], ..Settings::default() };
        let store = Store::new(fixture.path(), old.clone());
        store.update(|s| Ok(s.widget_moved("mail", "clock")), |_, _| {}).unwrap();
        let new = store.update(|s| s.patched(serde_json::json!({"hiddenWidgets": ["clock", "clipboard", "clock", "unknown"]})), |_, _| {}).unwrap();
        assert_eq!(new.hidden_widgets, ["clock", "clipboard"]);
        assert_eq!(new.alarms, old.alarms);
        assert_eq!(new.clipboard_history, old.clipboard_history);
        assert_eq!(new.widget_order, old.widget_moved("mail", "clock").widget_order);
        assert_eq!(load(&fixture.path()), new);
        assert_eq!(new.patched(serde_json::json!({"theme": "dark"})).unwrap().hidden_widgets, new.hidden_widgets);
        assert!(new.patched(serde_json::json!({"hiddenWidgets": []})).unwrap().hidden_widgets.is_empty());
    }

    #[test]
    fn hiding_last_widget_is_rejected_atomically() {
        let fixture = Fixture::new();
        let old = Settings::default().patched(serde_json::json!({"hiddenWidgets": &WIDGETS[1..]})).unwrap();
        let store = Store::new(fixture.path(), old.clone());
        for patch in [serde_json::json!({"hiddenWidgets": WIDGETS, "theme": "dark"}),
            serde_json::json!({"hiddenWidgets": null}), serde_json::json!({"hiddenWidgets": [1]})] {
            assert!(store.update(|s| s.patched(patch), |_, _| panic!("no debe publicar")).is_err());
            assert_eq!(store.current(), old);
            assert!(!fixture.path().exists());
        }
    }

    #[test]
    fn widget_move_uses_current_target_index_in_both_directions() {
        let old = Settings::default();
        assert_eq!(&old.widget_moved("clock", "calendar").widget_order[..4], ["system", "mail", "calendar", "clock"]);
        assert_eq!(&old.widget_moved("calendar", "clock").widget_order[..4], ["calendar", "clock", "system", "mail"]);
        assert_eq!(old.widget_moved("clock", "today").widget_order.last().unwrap(), "clock");
        for (id, target) in [("clock", "clock"), ("unknown", "clock"), ("clock", "unknown")] {
            assert_eq!(old.widget_moved(id, target), old);
        }
        let current = old.widget_moved("system", "calendar");
        let moved = current.widget_moved("clock", "mail");
        assert_eq!(&moved.widget_order[..4], ["mail", "clock", "calendar", "system"]);
        assert_eq!(moved.widget_order.len(), WIDGETS.len());
        assert_eq!(Settings { widget_order: old.widget_order.clone(), ..moved }, old);
    }

    #[test]
    fn codex_pet_order_migrates_once_without_changing_existing_order() {
        let cases = [
            (vec!["today", "clipboard", "clock", "media"], vec!["today", "clipboard", "codex-pet", "clock", "media", "system", "mail", "calendar", "claude", "shortcuts"]),
            (vec!["today", "clock"], vec!["today", "clock", "system", "mail", "calendar", "claude", "clipboard", "media", "shortcuts", "codex-pet"]),
            (vec!["unknown", "clipboard", "clipboard", "clock", "clock"], vec!["clipboard", "codex-pet", "clock", "system", "mail", "calendar", "claude", "media", "shortcuts", "today"]),
            (vec!["codex-pet", "today", "clipboard", "codex-pet", "unknown"], vec!["codex-pet", "today", "clipboard", "clock", "system", "mail", "calendar", "claude", "media", "shortcuts"]),
            (vec!["today", "codex-pet"], vec!["today", "codex-pet", "clock", "system", "mail", "calendar", "claude", "clipboard", "media", "shortcuts"]),
        ];
        for (order, expected) in cases {
            let migrated = parse(&serde_json::json!({"widgetOrder": order}).to_string()).unwrap();
            assert_eq!(migrated.widget_order, expected);
            assert_eq!(migrated.clone().normalize(), migrated, "la migración es idempotente");
        }
        assert_eq!(parse("{}").unwrap().widget_order, WIDGETS);
    }

    #[test]
    fn codex_pet_moves_independently_hides_and_survives_restarts() {
        let fixture = Fixture::new();
        let initial = parse(r#"{"widgetOrder":["today","clipboard","clock"]}"#).unwrap();
        save(&fixture.path(), &initial).unwrap();
        let store = Store::new(fixture.path(), load(&fixture.path()));
        for target in ["today", "clock", "shortcuts"] {
            let before = store.current();
            let expected_index = before.widget_order.iter().position(|id| id == target).unwrap();
            let moved = store.update(|s| Ok(s.widget_moved("codex-pet", target)), |_, _| {}).unwrap();
            assert_eq!(moved.widget_order[expected_index], "codex-pet");
            let without_pet = |s: &Settings| s.widget_order.iter().filter(|id| *id != "codex-pet").cloned().collect::<Vec<_>>();
            assert_eq!(without_pet(&moved), without_pet(&before));
            assert_eq!(load(&fixture.path()), moved);
        }
        let before = store.current();
        let pet_index = before.widget_order.iter().position(|id| id == "codex-pet").unwrap();
        let moved = store.update(|s| Ok(s.widget_moved("clipboard", "clock")), |_, _| {}).unwrap();
        assert_eq!(moved.widget_order[pet_index], "codex-pet", "mover Portapapeles no arrastra la mascota");
        let hidden = store.update(|s| s.patched(serde_json::json!({"hiddenWidgets": ["codex-pet", "codex-pet", "unknown"]})), |_, _| {}).unwrap();
        assert_eq!(hidden.hidden_widgets, ["codex-pet"]);
        assert_eq!(hidden.widget_order, moved.widget_order);
        let restarted = Store::new(fixture.path(), load(&fixture.path()));
        assert_eq!(restarted.current(), hidden);
        let visible = restarted.update(|s| s.patched(serde_json::json!({"hiddenWidgets": []})), |_, _| {}).unwrap();
        assert_eq!(visible.widget_order, hidden.widget_order);
        assert!(load(&fixture.path()).hidden_widgets.is_empty());
        let hidden_others: Vec<_> = WIDGETS.into_iter().filter(|id| *id != "codex-pet").collect();
        let pet_only = visible.patched(serde_json::json!({"hiddenWidgets": hidden_others})).unwrap();
        assert_eq!(pet_only.hidden_widgets.len(), WIDGETS.len() - 1);
        assert!(pet_only.patched(serde_json::json!({"hiddenWidgets": WIDGETS})).is_err());
    }

    #[test]
    fn patch_rejects_protected_unknown_and_invalid_payloads_atomically() {
        let fixture = Fixture::new();
        let store = Store::new(fixture.path(), Settings::default());
        for key in ["shortcuts", "workspaces", "barOffsets", "barOffsetsCenter", "bitwardenSeeded", "minimized", "alarms", "widgetOrder", "unknown", "always_on_top"] {
            let patch = serde_json::json!({"theme": "dark", (key): null});
            let error = store.update(|old| old.patched(patch), |_, _| panic!("no debe publicar")).unwrap_err();
            assert!(error.contains(key));
            assert!(error.contains(if ["unknown", "always_on_top"].contains(&key) { "desconocido" } else { "vía de actualización propia" }));
            assert_eq!(store.current(), Settings::default());
            assert!(!fixture.path().exists());
        }
        for patch in [serde_json::json!(null), serde_json::json!([]), serde_json::json!(7), serde_json::json!({"autostart": "yes"})] {
            assert!(store.update(|old| old.patched(patch), |_, _| panic!("no debe publicar")).is_err());
        }
    }

    #[test]
    fn patch_preserves_omitted_fields() {
        let old = Settings { theme: Theme::Dark, ..Settings::default() };
        assert_eq!(old.patched(serde_json::json!({})).unwrap(), old);
        let new = old.patched(serde_json::json!({"mode": "expanded"})).unwrap();
        assert_eq!(new.theme, old.theme);
        assert_eq!(new.mode, Mode::Expanded);
        assert_eq!(new.widget_order, old.widget_order);
        assert_eq!(new.alarms, old.alarms);
        assert!(old.patched(serde_json::json!({"monitor": null})).unwrap().monitor.is_none());
    }

    #[test]
    fn failed_save_keeps_memory_and_does_not_publish_or_leave_temp() {
        let fixture = Fixture::new();
        // Renombrar un archivo sobre un directorio no vacío falla de forma portable.
        std::fs::create_dir(fixture.path()).unwrap();
        let sentinel = fixture.path().join("sentinel");
        std::fs::write(&sentinel, b"unchanged").unwrap();
        let store = Store::new(fixture.path(), Settings::default());
        assert!(store.update(|old| old.patched(serde_json::json!({"theme": "dark"})), |_, _| panic!("no debe publicar")).is_err());
        assert_eq!(store.current(), Settings::default());
        assert_eq!(std::fs::read(sentinel).unwrap(), b"unchanged");
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 1, "limpieza del temporal tras fallo de rename");
        std::fs::remove_file(fixture.path().join("sentinel")).unwrap();
        std::fs::remove_dir(fixture.path()).unwrap();
        let mut published = false;
        let saved = store.update(|old| old.patched(serde_json::json!({"theme": "dark"})), |_, _| published = true).unwrap();
        assert!(published, "se puede reintentar tras el error");
        assert_eq!(store.current(), saved);
        assert_eq!(load(&fixture.path()), saved);
    }

    #[test]
    fn temporary_files_are_distinct_and_never_truncate_an_existing_file() {
        let fixture = Fixture::new();
        let (first, mut a) = create_temp(&fixture.path()).unwrap();
        a.write_all(b"first").unwrap();
        let (second, mut b) = create_temp(&fixture.path()).unwrap();
        b.write_all(b"second").unwrap();
        drop((a, b));
        assert_ne!(first, second);
        assert_eq!(std::fs::read(first).unwrap(), b"first");
        assert_eq!(std::fs::read(second).unwrap(), b"second");
    }

    #[test]
    fn roundtrip() {
        let s = Settings {
            edge: Edge::Right,
            monitor: Some("\\\\.\\DISPLAY2".into()),
            always_on_top: false,
            mode: Mode::Expanded,
            minimized: true,
            auto_compact_seconds: 120,
            theme: Theme::Dark,
            island_color: IslandColor::Royal,
            pulse_animation: false,
            autostart: true,
            hidden_widgets: vec!["mail".into(), "clipboard".into()],
            widget_order: vec!["claude".into(), "clock".into(), "mail".into(), "system".into(), "calendar".into(), "clipboard".into(), "codex-pet".into(), "media".into(), "shortcuts".into(), "today".into()],
            alarms: vec![Alarm { id: 3, hour: 6, minute: 45, days: vec![0, 4], label: "Gym".into(), enabled: false }],
            clipboard_history: false,
            shortcuts: vec![Shortcut {
                id: 2,
                name: "Web".into(),
                kind: crate::shortcuts::Kind::Url,
                target: "https://example.com".into(),
                color: Some("teal".into()),
                icon: Some("web".into()),
            }],
            bar_offsets: EdgeOffsets { top: 0.0, bottom: 1.0, left: 0.25, right: 0.5 },
            bar_offsets_center: false,
            notifications: true,
            weather_place: None,
            workspaces: vec![Workspace { id: 4, name: "Trabajo".into(), shortcuts: vec![2], color: None, icon: None }],
            bitwarden_seeded: true,
            share_today: false,
            bar_style: BarStyle::Aurora,
            aurora_accent: AuroraAccent::Cyan,
            mascot: Mascot::Water,
            codex_pet_icon: CodexPetIcon::Dragon,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"edge\":\"right\"") && json.contains("\"alwaysOnTop\":false"));
        assert!(json.contains("\"shareToday\":false") && json.contains("\"barStyle\":\"aurora\""));
        assert!(json.contains("\"mascot\":\"water\""));
        assert_eq!(parse(&json), Some(s));
    }

    #[test]
    fn mascot_migrates_roundtrips_and_tolerates_unknown() {
        assert_eq!(parse("{}").unwrap().mascot, Mascot::Air, "archivos antiguos: aire");
        for (m, name) in [(Mascot::Air, "air"), (Mascot::Fire, "fire"), (Mascot::Water, "water"), (Mascot::Earth, "earth")] {
            let s = Settings { mascot: m, ..Settings::default() };
            let json = serde_json::to_string(&s).unwrap();
            assert!(json.contains(&format!("\"mascot\":\"{name}\"")));
            assert_eq!(parse(&json), Some(s));
        }
        // Desconocida: aire, sin tratar el archivo como dañado.
        let s = parse("{\"mascot\":\"lightning\",\"edge\":\"left\"}").unwrap();
        assert_eq!((s.mascot, s.edge), (Mascot::Air, Edge::Left));
        assert_eq!(parse("{\"mascot\":7}").unwrap().mascot, Mascot::Air);
        // El parche sí la cambia (preferencia de apariencia).
        let old = Settings::default();
        assert_eq!(old.patched(serde_json::json!({"mascot": "earth"})).unwrap().mascot, Mascot::Earth);
    }

    #[test]
    fn codex_pet_icon_migrates_roundtrips_and_tolerates_invalid() {
        assert_eq!(Settings::default().codex_pet_icon, CodexPetIcon::Dog);
        assert_eq!(parse("{}").unwrap().codex_pet_icon, CodexPetIcon::Dog);
        for (icon, name) in [(CodexPetIcon::Dog, "dog"), (CodexPetIcon::Dragon, "dragon")] {
            let s = Settings { codex_pet_icon: icon, ..Settings::default() };
            let json = serde_json::to_string(&s).unwrap();
            assert!(json.contains(&format!("\"codexPetIcon\":\"{name}\"")));
            assert_eq!(parse(&json), Some(s));
        }
        for invalid in [serde_json::json!("unknown"), serde_json::json!(7), serde_json::json!(null),
            serde_json::json!(true), serde_json::json!([]), serde_json::json!({})] {
            let s = parse(&serde_json::json!({"codexPetIcon": invalid, "mascot": "water", "edge": "left"}).to_string()).unwrap();
            assert_eq!((s.codex_pet_icon, s.mascot, s.edge), (CodexPetIcon::Dog, Mascot::Water, Edge::Left));
        }
    }

    #[test]
    fn codex_pet_icon_patch_persists_without_changing_mini_or_other_settings() {
        let fixture = Fixture::new();
        let old = Settings { mascot: Mascot::Fire, theme: Theme::Dark, ..Settings::default() };
        let store = Store::new(fixture.path(), old.clone());
        for name in ["dragon", "dog"] {
            let new = store.update(|s| s.patched(serde_json::json!({"codexPetIcon": name})), |_, _| {}).unwrap();
            let icon = if name == "dragon" { CodexPetIcon::Dragon } else { CodexPetIcon::Dog };
            assert_eq!(new, Settings { codex_pet_icon: icon, ..old.clone() });
            assert_eq!(load(&fixture.path()), new);
            assert_eq!(new.patched(serde_json::json!({"theme": "light"})).unwrap().codex_pet_icon, icon);
        }
    }

    #[test]
    fn damaged_or_wrong_types_are_rejected() {
        assert_eq!(parse("{not json"), None);
        assert_eq!(parse(""), None);
        assert_eq!(parse("{\"edge\":\"diagonal\"}"), None);
    }

    #[test]
    fn minimized_migrates_and_roundtrips_independently_of_mode() {
        for mode in [Mode::Compact, Mode::Expanded] {
            let old = serde_json::json!({ "mode": mode }).to_string();
            let s = parse(&old).unwrap();
            assert!(!s.minimized);
            assert_eq!(s.mode, mode);
            for minimized in [false, true] {
                let s = Settings { minimized, ..s.clone() };
                assert_eq!(parse(&serde_json::to_string(&s).unwrap()), Some(s));
            }
        }
    }

    #[test]
    fn patch_preserves_managed_presence_and_offsets() {
        for minimized in [false, true] {
            let old = Settings {
                minimized,
                bar_offsets: EdgeOffsets::default().with(Edge::Left, 0.2),
                ..Settings::default()
            };
            let updated = old.patched(serde_json::json!({"theme": "dark"})).unwrap();
            assert_eq!(updated.minimized, minimized);
            assert_eq!(updated.bar_offsets, old.bar_offsets);
            assert!(old.patched(serde_json::json!({"minimized": !minimized})).is_err());
        }
    }

    #[test]
    fn missing_fields_use_defaults_and_order_is_normalized() {
        let s = parse("{\"theme\":\"light\",\"widgetOrder\":[\"mail\",\"mail\",\"bogus\"]}").unwrap();
        assert_eq!(s.theme, Theme::Light);
        assert_eq!(s.edge, Edge::Top);
        assert!(!s.autostart);
        // Archivos anteriores a `islandColor` siguen funcionando.
        assert_eq!(s.island_color, IslandColor::Black);
        assert_eq!(parse("{\"islandColor\":\"royal\"}").unwrap().island_color, IslandColor::Royal);
        assert_eq!(
            s.widget_order,
            ["mail", "clock", "system", "calendar", "claude", "clipboard", "media", "shortcuts", "today", "codex-pet"]
        );
        assert!(!s.notifications, "archivos antiguos: avisos desactivados (opt-in)");
        assert!(s.workspaces.is_empty(), "archivos antiguos: sin espacios");
        assert!(!s.bitwarden_seeded, "archivos antiguos: Bitwarden aún sin sembrar");
        assert!(s.clipboard_history, "archivos antiguos: historial del portapapeles activado");
        // Archivos anteriores a `alarms`: sin alarmas; alarmas parciales se completan.
        assert!(s.alarms.is_empty());
        assert!(s.shortcuts.is_empty(), "archivos antiguos: sin accesos rápidos");
        assert!(s.pulse_animation, "archivos antiguos: pulso animado");
        assert!(s.share_today, "archivos antiguos: compartir hoy.json activado");
        assert_eq!(s.bar_style, BarStyle::Classic, "archivos antiguos: estilo clásico");
        assert_eq!(s.aurora_accent, AuroraAccent::Cyan, "archivos antiguos: Aurora cian y verde");
        assert_eq!(parse("{\"barStyle\":\"neon\"}"), None, "estilo desconocido: archivo dañado");
        assert_eq!(s.bar_offsets, EdgeOffsets::default(), "archivos antiguos: centrada");
        assert!(!s.bar_offsets_center, "archivos antiguos: fracciones D-047, se migran al arrancar");
        assert!(Settings::default().bar_offsets_center, "instalación nueva: ya de centro");
        let kept = Settings { bar_offsets_center: false, ..Settings::default() };
        assert!(!kept.patched(serde_json::json!({"theme": "dark"})).unwrap().bar_offsets_center, "el parche conserva la marca");
        let a = parse("{\"alarms\":[{\"hour\":9}]}").unwrap().alarms;
        assert_eq!((a.len(), a[0].id, a[0].hour, a[0].minute, a[0].enabled), (1, 1, 9, 0, true));
    }

    fn sc(id: u64) -> Shortcut {
        Shortcut { id, name: format!("A{id}"), kind: crate::shortcuts::Kind::Url, target: "https://example.com".into(), color: None, icon: None }
    }

    #[test]
    fn retired_projects_and_unknown_styles_still_load() {
        // Archivo guardado con `claudeProjects` (retirado, D-047): carga sin error.
        let old = r#"{"edge":"left","claudeProjects":["C:\\dev\\JarWis"],"barOffsets":{"left":7.5,"top":0.2},
            "shortcuts":[{"id":1,"name":"N","kind":"url","target":"https://e.com","color":"rainbow","icon":"key"},
                         {"id":2,"name":"M","kind":"url","target":"https://e.com","color":"red","icon":"bomb"}]}"#;
        let s = parse(old).unwrap();
        assert_eq!(s.edge, Edge::Left);
        assert_eq!((s.bar_offsets.left, s.bar_offsets.top, s.bar_offsets.right), (1.0, 0.2, 0.5), "saneado; faltantes centrados");
        assert_eq!((s.shortcuts[0].color.as_deref(), s.shortcuts[0].icon.as_deref()), (None, Some("key")));
        assert_eq!((s.shortcuts[1].color.as_deref(), s.shortcuts[1].icon.as_deref()), (Some("red"), None));
        assert!(!serde_json::to_string(&s).unwrap().contains("claudeProjects"), "no se vuelve a guardar");
    }

    fn ws(id: u64, name: &str, shortcuts: Vec<u64>) -> Workspace {
        Workspace { id, name: name.into(), shortcuts, color: None, icon: None }
    }

    #[test]
    fn old_file_gets_today_last() {
        // Orden guardado antes de la Fase 7 (9 widgets): `today` se añade al final.
        let old = r#"{"widgetOrder":["passwords","clock","system","mail","calendar","claude","clipboard","media","shortcuts"]}"#;
        let s = parse(old).unwrap();
        assert_eq!(s.widget_order.last().map(String::as_str), Some("today"));
        assert_eq!(s.widget_order.first().map(String::as_str), Some("clock"), "«passwords» descartado");
        assert_eq!((s.notifications, s.workspaces.len()), (false, 0));
    }

    #[test]
    fn passwords_widget_is_dropped_keeping_order() {
        // Migración D-045: «passwords» en medio desaparece; el resto conserva su orden.
        let old = r#"{"widgetOrder":["today","claude","passwords","clock","system","mail","calendar","clipboard","media","shortcuts"]}"#;
        assert_eq!(
            parse(old).unwrap().widget_order,
            ["today", "claude", "clock", "system", "mail", "calendar", "clipboard", "codex-pet", "media", "shortcuts"]
        );
    }

    #[test]
    fn workspace_appearance_validates_normalizes_and_roundtrips() {
        let shortcuts = vec![sc(1)];
        for color in COLORS { for icon in ICONS {
            let w = Workspace { color: Some((*color).into()), icon: Some((*icon).into()), ..ws(1, "Trabajo", vec![1]) };
            assert_eq!(validate_workspaces(std::slice::from_ref(&w), &shortcuts).unwrap()[0], w);
            let json = serde_json::to_string(&w).unwrap();
            assert_eq!(serde_json::from_str::<Workspace>(&json).unwrap(), w);
        }}
        let legacy: Workspace = serde_json::from_str(r#"{"id":1,"name":"Trabajo","shortcuts":[1]}"#).unwrap();
        assert!(legacy.color.is_none() && legacy.icon.is_none());
        for (color, icon) in [(Some("#fff".into()), None), (None, Some("<svg>".into()))] {
            let w = Workspace { color, icon, ..legacy.clone() };
            assert!(validate_workspaces(std::slice::from_ref(&w), &shortcuts).is_err());
            let s = Settings { shortcuts: shortcuts.clone(), workspaces: vec![w], ..Settings::default() }.normalize();
            assert!(s.workspaces[0].color.is_none() && s.workspaces[0].icon.is_none());
        }
    }

    #[test]
    fn weather_place_patch_preserves_lists_and_rejects_invalid_atomically() {
        let old = Settings::default();
        assert!(old.weather_place.is_none());
        let city = serde_json::json!({"name":" Ciudad pública ","admin":null,"country":" País ","latitude":40.42,"longitude":-3.7});
        let saved = old.patched(serde_json::json!({"weatherPlace":city})).unwrap();
        assert_eq!(saved.weather_place.as_ref().unwrap().name,"Ciudad pública");
        assert_eq!(saved.widget_order,old.widget_order);
        assert_eq!(saved.patched(serde_json::json!({"theme":"dark"})).unwrap().weather_place,saved.weather_place);
        assert!(saved.patched(serde_json::json!({"weatherPlace":null})).unwrap().weather_place.is_none());
        for invalid in [serde_json::json!({"latitude":91,"longitude":0,"name":"x"}),serde_json::json!({"latitude":0,"longitude":0,"name":"x\n"})] {
            assert!(saved.patched(serde_json::json!({"weatherPlace":invalid,"theme":"light"})).is_err());
            let json = serde_json::json!({"weatherPlace":invalid,"theme":"dark"}).to_string();
            let loaded = parse(&json).unwrap();
            assert!(loaded.weather_place.is_none()); assert_eq!(loaded.theme,Theme::Dark);
        }
        let json = serde_json::to_string(&saved).unwrap();
        assert_eq!(parse(&json),Some(saved));
    }

    #[test]
    fn validate_workspaces_rules() {
        let scs: Vec<Shortcut> = (1..=12).map(sc).collect();
        let ok = validate_workspaces(&[ws(0, "  Trabajo ", vec![1, 2]), ws(7, "Ocio", vec![3]), ws(0, "Otro", vec![4])], &scs)
            .unwrap();
        assert_eq!(ok.iter().map(|w| w.id).collect::<Vec<_>>(), [8, 7, 9], "ids nuevos tras el máximo");
        assert_eq!(ok[0].name, "Trabajo");
        let many: Vec<Workspace> = (0..11).map(|_| ws(0, "x", vec![1])).collect();
        assert!(validate_workspaces(&many, &scs).is_err(), "> 10 espacios");
        assert!(validate_workspaces(&[ws(0, "x", (1..=11).collect())], &scs).is_err(), "> 10 ids");
        assert!(validate_workspaces(&[ws(0, "x", vec![])], &scs).is_err(), "sin ids");
        assert!(validate_workspaces(&[ws(0, "x", vec![99])], &scs).is_err(), "id inexistente");
        assert!(validate_workspaces(&[ws(0, "x", vec![1, 1])], &scs).is_err(), "id repetido");
        assert!(validate_workspaces(&[ws(3, "x", vec![1]), ws(3, "y", vec![2])], &scs).is_err(), "espacio repetido");
        let long = "n".repeat(61);
        for bad in ["", "   ", long.as_str(), "a\u{7}b", "a\nb"] {
            assert!(validate_workspaces(&[ws(0, bad, vec![1])], &scs).is_err(), "nombre {bad:?}");
        }
        assert!(validate_workspaces(&[ws(0, &"ñ".repeat(60), vec![1])], &scs).is_ok(), "60 caracteres");
    }

    #[test]
    fn normalize_prunes_workspaces() {
        let s = Settings {
            shortcuts: vec![sc(1), sc(2)],
            workspaces: (0..12).map(|i| ws(if i == 1 { 0 } else { 5 }, "x", vec![2, 9, 2, 1])).collect(),
            ..Settings::default()
        }
        .normalize();
        assert_eq!(s.workspaces.len(), MAX_WORKSPACES);
        assert_eq!(s.workspaces[0].shortcuts, [2, 1], "sin repetidos ni inexistentes");
        let mut ids: Vec<u64> = s.workspaces.iter().map(|w| w.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), MAX_WORKSPACES, "ids únicos");
        assert!(!ids.contains(&0));
        let long = Settings {
            shortcuts: (1..=15).map(sc).collect(),
            workspaces: vec![ws(1, "x", (1..=15).collect())],
            ..Settings::default()
        };
        assert_eq!(long.normalize().workspaces[0].shortcuts.len(), MAX_WORKSPACE_ITEMS);
        // Borrar un acceso (como `set_shortcuts`) lo poda de los espacios.
        let s = Settings { shortcuts: vec![sc(2)], ..s }.normalize();
        assert!(s.workspaces.iter().all(|w| w.shortcuts == [2]));
    }

    #[test]
    fn load_damaged_file_returns_defaults_and_keeps_copy() {
        let dir = std::env::temp_dir().join(format!("jarwis-settings-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, b"\xff\xfe garbage").unwrap();
        assert_eq!(load(&path), Settings::default());
        assert!(dir.join("settings.json.corrupt").exists());
        // Guardar y volver a leer.
        let s = Settings { edge: Edge::Bottom, ..Settings::default() };
        save(&path, &s).unwrap();
        assert_eq!(load(&path), s);
        assert_eq!(load(&dir.join("missing.json")), Settings::default());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
