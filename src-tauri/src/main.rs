// Sin consola en release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod bitwarden;
mod claude;
mod clipboard;
mod clock;
mod cloud;
mod codex_pet;
mod layout;
mod media;
mod monitor;
mod power;
mod settings;
mod shortcuts;
mod weather;

use clock::{Alert, Kind, Scheduler, TimerAction};
use layout::{Edge, Mode, Rect, Shape};
use serde::Serialize;
use settings::{Settings, Theme};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WindowEvent};
#[cfg(not(windows))]
use tauri::{PhysicalPosition, PhysicalSize};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

const BAR: &str = "bar";
const SETTINGS_WINDOW: &str = "settings";
const SETTINGS_EVENT: &str = "settings-changed";
const CLOCK_EVENT: &str = "clock-changed";
/// La WebView2 oculta no cambia `document.hidden`: se avisa para parar repintados.
const VISIBILITY_EVENT: &str = "bar-visibility";
/// Cambió el historial del portapapeles. Sin datos: el panel pide la lista.
const CLIPBOARD_EVENT: &str = "clipboard-changed";
/// Cambió la sesión de Google (login/logout). Sin datos: los widgets vuelven a consultar.
const CLOUD_EVENT: &str = "cloud-changed";
/// Atajo que abre/cierra un panel; lleva solo su nombre ("clipboard").
const PANEL_SHORTCUT_EVENT: &str = "panel-shortcut";

/// Ctrl+Alt+J: mostrar/ocultar la barra.
fn shortcut_toggle() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyJ)
}
/// Ctrl+Alt+K: restaurar desde mínimo o alternar compacto/expandido.
fn shortcut_mode() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyK)
}
/// Ctrl+Alt+C: abrir/cerrar el panel del portapapeles.
fn shortcut_clipboard() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyC)
}

fn global_shortcuts() -> [(Shortcut, &'static str); 3] {
    [
        (shortcut_toggle(), "Ctrl+Alt+J"),
        (shortcut_mode(), "Ctrl+Alt+K"),
        (shortcut_clipboard(), "Ctrl+Alt+C"),
    ]
}

struct AppState {
    settings: settings::Store,
    /// Serializa los cambios de inicio automático hasta terminar su posible reversión.
    autostart_change: Mutex<()>,
    /// Errores al registrar atajos globales (se muestran en Ajustes).
    shortcut_errors: Mutex<Vec<String>>,
    opening_workspaces: Arc<Mutex<HashSet<u64>>>,
    /// Un panel (reloj o portapapeles) abierto (estado de la interfaz, no se persiste).
    panel: AtomicBool,
    /// Alto lógico de contenido que pidió el panel abierto (JW-11-02b); `None` = fijo.
    panel_height: Mutex<Option<f64>>,
    clock: Scheduler,
    /// Historial del portapapeles: solo en memoria (D-028).
    clipboard: Mutex<clipboard::Store>,
    /// Monitoreo: se crea en la primera consulta (la isla visible manda el ritmo).
    monitor: Mutex<Option<monitor::Monitor>>,
    /// Arrastre de la isla en curso (JW-2-09): nadie recoloca la ventana hasta soltar.
    dragging: AtomicBool,
}

/// Se conserva el ítem para sincronizar la etiqueta tras cualquier commit.
struct PresenceMenu(MenuItem<tauri::Wry>);

fn presence_label(minimized: bool) -> &'static str {
    if minimized { "Restaurar" } else { "Minimizar" }
}

#[derive(Serialize)]
struct MonitorInfo {
    name: String,
    label: String,
    primary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    shortcut_errors: Vec<String>,
}

fn bar(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(BAR)
}

/// Panel > aviso sonando > presencia mínima > último modo guardado.
fn shape(state: &AppState) -> Shape {
    resolve_shape(&current(state), state.panel.load(Ordering::Relaxed), state.clock.read(|c| c.has_alerts()))
}

fn resolve_shape(settings: &Settings, panel: bool, has_alerts: bool) -> Shape {
    if panel {
        Shape::Panel
    } else if has_alerts {
        Shape::Expanded
    } else if settings.minimized {
        Shape::Mini
    } else {
        settings.mode.into()
    }
}

/// Coloca la barra según los ajustes y la forma actual. No hace nada durante un
/// arrastre: al soltar, `bar_drag` recoloca con `commit` (D-025).
fn place(app: &AppHandle) {
    if let (Some(win), Some(state)) = (bar(app), app.try_state::<AppState>()) {
        if !state.dragging.load(Ordering::SeqCst) {
            let height = *state.panel_height.lock().unwrap_or_else(|p| p.into_inner());
            place_bar(&win, &current(&state), shape(&state), height);
        }
    }
}

/// Monitor de la barra: el elegido en Ajustes o, si no existe, el principal.
/// Devuelve su área de trabajo en píxeles físicos y su escala.
fn bar_monitor(win: &WebviewWindow, s: &Settings) -> Option<(Rect, f64)> {
    let monitors = win.available_monitors().unwrap_or_default();
    let chosen = s
        .monitor
        .as_ref()
        .and_then(|name| monitors.iter().find(|m| m.name() == Some(name)).cloned());
    let m = chosen.or_else(|| win.primary_monitor().ok().flatten()).or_else(|| monitors.into_iter().next())?;
    let wa = m.work_area();
    Some((Rect { x: wa.position.x, y: wa.position.y, width: wa.size.width, height: wa.size.height }, m.scale_factor()))
}

/// JW-15-04 (amplía D-047): las fracciones antiguas eran del recorrido libre de cada
/// forma; se convierten una vez en fracciones de centro con el monitor de la barra,
/// sin mover Compact. Un fallo al guardar se ignora (se reintenta en el próximo arranque).
fn migrate_offsets(app: &AppHandle, state: &AppState) {
    let _ = commit(app, state, |s| {
        if s.bar_offsets_center {
            return Ok(s.clone());
        }
        let Some((work_area, scale)) = bar(app).and_then(|w| bar_monitor(&w, s)) else { return Ok(s.clone()) };
        Ok(Settings { bar_offsets: s.bar_offsets.legacy_to_center(work_area, scale), bar_offsets_center: true, ..s.clone() })
    });
}

/// Coloca la barra en su monitor según los ajustes.
fn place_bar(win: &WebviewWindow, s: &Settings, shape: Shape, panel_height: Option<f64>) {
    let Some((work_area, scale)) = bar_monitor(win, s) else { return };
    let _ = win.emit("bar-track", layout::bar_track(work_area, scale));
    let r = layout::bar_rect_fit(work_area, scale, s.edge, shape, s.bar_offsets.get(s.edge), panel_height);
    set_bar_rect(win, r);
}

/// JW-34-6E: posición y tamaño forman una sola actualización nativa. Dos mensajes
/// separados dejaban un fotograma en el origen nuevo con el tamaño anterior;
/// la compensación CSS de JW-22 todavía correspondía al viewport anterior.
/// El rectángulo ya usa la escala del monitor de destino. No cambia foco ni Z.
#[cfg(windows)]
fn set_bar_rect(win: &WebviewWindow, r: Rect) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER};
    let Ok(hwnd) = win.hwnd() else { return };
    let hwnd = hwnd.0 as usize;
    let _ = win.run_on_main_thread(move || unsafe {
        let _ = SetWindowPos(
            HWND(hwnd as _),
            None,
            r.x,
            r.y,
            r.width as i32,
            r.height as i32,
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
        );
    });
}

#[cfg(not(windows))]
fn set_bar_rect(win: &WebviewWindow, r: Rect) {
    let _ = win.set_position(PhysicalPosition::new(r.x, r.y));
    let _ = win.set_size(PhysicalSize::new(r.width, r.height));
}

fn native_theme(t: Theme) -> Option<tauri::Theme> {
    match t {
        Theme::System => None,
        Theme::Light => Some(tauri::Theme::Light),
        Theme::Dark => Some(tauri::Theme::Dark),
    }
}

/// Aplica en vivo los ajustes visuales (salvo la geometría) a la barra y el tema a Ajustes.
///
/// La barra no usa Mica: el efecto rellena todo el rectángulo de la ventana y
/// no puede recortarse a la forma de píldora. La ventana es transparente y la
/// píldora se dibuja con CSS.
fn apply_window(app: &AppHandle, s: &Settings) {
    if let Some(win) = app.get_webview_window(SETTINGS_WINDOW) {
        let _ = win.set_theme(native_theme(s.theme));
    }
    if let Some(win) = bar(app) {
        let _ = win.set_always_on_top(s.always_on_top);
        let _ = win.set_theme(native_theme(s.theme));
    }
}

/// Duración del «morph» CSS de la isla (`--morph` en src/styles.css) más un margen.
const COLLAPSE_DELAY: Duration = Duration::from_millis(460);

/// Recoloca la barra tras un cambio de forma desde `before`.
///
/// Al crecer, la ventana crece antes de avisar a la UI y la isla se anima
/// dentro de ella. Al encoger, la ventana se encoge cuando termina la
/// animación, así la zona transparente solo existe durante ~0,5 s y no tapa
/// clics en reposo (sin `set_ignore_cursor_events` ni sondeo del cursor).
/// Si las formas se cruzan (Mini↔Compact, D-056; el orden de `Shape` es de
/// prioridad, no de tamaño), primero se usa la ventana unión y el tamaño final
/// llega tras la animación.
/// Entrar o salir de Mini no tiene morph CSS (solo opacidad): la ventana va directa
/// al tamaño final y la UI oculta la isla hasta que lo tiene (JW-15-04). Así no hay
/// ventana unión ni encogido retardado que dejen ver la isla mal colocada.
fn relayout(app: &AppHandle, state: &AppState, before: Shape, same_edge: bool) {
    let after = shape(state);
    let morph = same_edge && before != Shape::Mini && after != Shape::Mini;
    if morph && (place_transition(app, state, before, after) || after < before) {
        let app = app.clone();
        // Se relee al despertar: si entretanto volvió a crecer, no se encoge.
        std::thread::spawn(move || {
            std::thread::sleep(COLLAPSE_DELAY);
            place(&app);
        });
    } else {
        place(app);
    }
}

/// Aplica la ventana unión si `before` y `after` se cruzan; `false` si no hace
/// falta o si hay un arrastre en curso (no se interrumpe).
fn place_transition(app: &AppHandle, state: &AppState, before: Shape, after: Shape) -> bool {
    if state.dragging.load(Ordering::SeqCst) {
        return false;
    }
    let Some(win) = bar(app) else { return false };
    let s = current(state);
    let Some((work_area, scale)) = bar_monitor(&win, &s) else { return false };
    let height = *state.panel_height.lock().unwrap_or_else(|p| p.into_inner());
    let Some(r) = layout::transition_rect(work_area, scale, s.edge, before, after, s.bar_offsets.get(s.edge), height) else {
        return false;
    };
    let _ = win.emit("bar-track", layout::bar_track(work_area, scale));
    set_bar_rect(&win, r);
    true
}

/// Lee, modifica, valida, guarda y publica bajo el único mutex escritor.
/// Ejecutar fuera del hilo de UI, salvo la migración durante el arranque.
fn commit(
    app: &AppHandle,
    state: &AppState,
    edit: impl FnOnce(&Settings) -> Result<Settings, String>,
) -> Result<Settings, String> {
    state.settings.update(
        |old| Ok(normalize_commit(old, edit(old)?)),
        |old, new| {
            let before = resolve_shape(old, state.panel.load(Ordering::Relaxed), state.clock.read(|c| c.has_alerts()));
            let same_edge = old.edge == new.edge;
            state.clock.with(|c| c.set_alarms(&new.alarms, clock::Now::real().local));
            // Desactivar el historial borra lo no fijado.
            if !new.clipboard_history {
                clips(state).clear_unpinned();
                clipboard_changed(app);
            }
            if old.weather_place != new.weather_place {
                app.state::<weather::Weather>().set_place(new.weather_place.clone());
            }
            apply_window(app, new);
            if let Some(menu) = app.try_state::<PresenceMenu>() {
                let _ = menu.0.set_text(presence_label(new.minimized));
            }
            relayout(app, state, before, same_edge);
            if !new.share_today {
                app.state::<cloud::Cloud>().today_writer.invalidate(cloud::today_path().as_deref());
            }
            let _ = app.emit(SETTINGS_EVENT, new);
        },
    )
}

/// Regla común a todas las escrituras, antes de guardar y publicar (JW-23).
fn normalize_commit(old: &Settings, new: Settings) -> Settings {
    let mut new = new.normalize();
    if old.minimized && !new.minimized {
        new.mode = Mode::Compact;
    }
    new
}

/// Estado del reloj para la interfaz; también se emite como `clock-changed`.
fn clock_view(app: &AppHandle, state: &AppState) -> clock::View {
    let view = state.clock.read(|c| c.view(Instant::now()));
    let _ = app.emit(CLOCK_EVENT, &view);
    view
}

/// Avisos vencidos (hilo programador): notificación con sonido, isla visible y expandida.
fn on_fired(app: &AppHandle, alerts: &[Alert]) {
    let Some(state) = app.try_state::<AppState>() else { return };
    for a in alerts {
        let (title, fallback) = match a.kind {
            Kind::Alarm => ("Alarma", "Alarma de JarWis"),
            Kind::Timer => ("Temporizador", "El temporizador ha terminado"),
        };
        let body = if a.label.is_empty() { fallback } else { a.label.as_str() };
        // Sonido del sistema de la propia notificación (sin archivos de audio).
        if let Err(e) = app.notification().builder().title(title).body(body).sound("Alarm").show() {
            eprintln!("No se pudo mostrar la notificación: {e}");
        }
    }
    show_bar(app);
    place(app);
    // Las alarmas de una sola vez quedan desactivadas también en los ajustes.
    if let Err(e) = commit(app, &state, |old| {
        let mut s = old.clone();
        for alarm in s.alarms.iter_mut().filter(|x| x.enabled && x.days.is_empty()) {
            if alerts.iter().any(|a| a.kind == Kind::Alarm && a.source == alarm.id) {
                alarm.enabled = false;
            }
        }
        Ok(s)
    }) {
        eprintln!("{e}");
    }
    clock_view(app, &state);
}

/// Aviso sin sonido (D-042) por la misma ruta que las alarmas. Solo textos fijos,
/// conteos u horas: nunca remitente, asunto ni título.
fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("No se pudo mostrar la notificación: {e}");
    }
}

fn clips(state: &AppState) -> std::sync::MutexGuard<'_, clipboard::Store> {
    state.clipboard.lock().unwrap_or_else(|p| p.into_inner())
}

/// Aviso sin contenido, solo a la barra.
fn clipboard_changed(app: &AppHandle) {
    let _ = app.emit_to(BAR, CLIPBOARD_EVENT, ());
}

/// Texto nuevo del oyente (hilo del portapapeles).
fn on_clip(app: &AppHandle, text: String) {
    let Some(state) = app.try_state::<AppState>() else { return };
    // Se vuelve a comprobar el ajuste con el almacén bloqueado: si se desactivó
    // mientras se leía, no se guarda (commit cambia el ajuste y después borra).
    let mut store = clips(&state);
    let pushed = current(&state).clipboard_history && store.push(text, clipboard::now_ms());
    drop(store);
    if pushed {
        clipboard_changed(app);
    }
}

fn current(state: &AppState) -> Settings {
    state.settings.current()
}

/// Oculta la barra si se ve; si está oculta o minimizada (p. ej. tras Win+D),
/// la muestra. No depende del foco: la barra nunca lo toma (`focus: false`).
fn toggle_visibility(app: &AppHandle) {
    let Some(win) = bar(app) else { return };
    if win.is_visible().unwrap_or(false) && !win.is_minimized().unwrap_or(false) {
        hide_bar(app);
    } else {
        show_bar(app);
    }
}

fn show_bar(app: &AppHandle) {
    if let Some(win) = bar(app) {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
        let _ = win.show();
        let _ = win.emit(VISIBILITY_EVENT, true);
    }
}

fn hide_bar(app: &AppHandle) {
    if let Some(win) = bar(app) {
        let _ = win.hide();
        let _ = win.emit(VISIBILITY_EVENT, false);
    }
}

fn toggle_mode(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        show_bar(&app);
        let state = app.state::<AppState>();
        let _ = commit(&app, &state, |s| Ok(mode_shortcut(s.clone())));
    });
}

fn mode_shortcut(mut settings: Settings) -> Settings {
    if settings.minimized {
        settings.minimized = false;
    } else {
        settings.mode = match settings.mode {
            Mode::Compact => Mode::Expanded,
            Mode::Expanded => Mode::Compact,
        };
    }
    settings
}

/// Crea o enfoca la ventana de Ajustes.
///
/// En Windows, crear una ventana desde un comando síncrono o un manejador de
/// eventos (menú de la bandeja) bloquea el hilo principal (wry#583): llamar solo
/// desde un comando `async` o un hilo aparte.
fn show_settings_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(SETTINGS_WINDOW) {
        win.show()?;
        return win.set_focus();
    }
    // Se crea bajo demanda y se destruye al cerrarla: no consume memoria en reposo.
    tauri::WebviewWindowBuilder::new(app, SETTINGS_WINDOW, WebviewUrl::App("index.html".into()))
        .title("Ajustes de JarWis")
        .inner_size(440.0, 760.0)
        .theme(native_theme(current(&app.state::<AppState>()).theme))
        // Sin el manejador nativo de arrastre: WebView2 entrega el drag & drop HTML5.
        .disable_drag_drop_handler()
        .resizable(false)
        .maximizable(false)
        .center()
        .build()?;
    Ok(())
}

// ---- Comandos invocables desde el frontend (permisos en capabilities/) ----

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    current(&state)
}

#[tauri::command]
async fn bar_track(app: AppHandle) -> Option<layout::BarTrack> {
    let win = bar(&app)?;
    let (work_area, scale) = bar_monitor(&win, &current(&app.state::<AppState>()))?;
    Some(layout::bar_track(work_area, scale))
}

/// El lanzador solo se toca después de guardar; la reversión usa otro commit.
fn save_then_autostart(
    save: impl FnOnce() -> Result<(Settings, bool), String>,
    apply: impl FnOnce(bool) -> Result<(), String>,
    revert: impl FnOnce(bool) -> Result<Settings, String>,
) -> Result<Settings, String> {
    let (saved, previous) = save()?;
    if saved.autostart != previous {
        if let Err(error) = apply(saved.autostart) {
            let message = format!("No se pudo cambiar el inicio automático: {error}");
            return match revert(previous) {
                Ok(_) => Err(message),
                Err(error) => Err(format!("{message}. No se pudo restaurar el ajuste anterior: {error}")),
            };
        }
    }
    Ok(saved)
}

#[tauri::command]
async fn patch_settings(app: AppHandle, state: State<'_, AppState>, patch: serde_json::Value) -> Result<Settings, String> {
    // Es la única entrada que cambia autostart. Otros commits pueden avanzar
    // mientras se aplica el lanzador; la reversión conserva sus demás campos.
    let _autostart = state.autostart_change.lock().unwrap_or_else(|p| p.into_inner());
    save_then_autostart(
        || {
            let mut previous = false;
            let saved = commit(&app, &state, |old| {
                previous = old.autostart;
                old.patched(patch)
            })?;
            Ok((saved, previous))
        },
        |enabled| {
            let launcher = app.autolaunch();
            (if enabled { launcher.enable() } else { launcher.disable() }).map_err(|e| e.to_string())
        },
        |autostart| commit(&app, &state, |old| Ok(Settings { autostart, ..old.clone() })),
    )
}

#[tauri::command]
async fn alarm_add(app: AppHandle, state: State<'_, AppState>, alarm: clock::Alarm) -> Result<Settings, String> {
    commit(&app, &state, |old| old.alarm_added(alarm))
}

#[tauri::command]
async fn alarm_set_enabled(app: AppHandle, state: State<'_, AppState>, id: u64, enabled: bool) -> Result<Settings, String> {
    commit(&app, &state, |old| Ok(old.alarm_enabled(id, enabled)))
}

#[tauri::command]
async fn alarm_remove(app: AppHandle, state: State<'_, AppState>, id: u64) -> Result<Settings, String> {
    commit(&app, &state, |old| Ok(old.alarm_removed(id)))
}

#[tauri::command]
async fn widget_move(app: AppHandle, state: State<'_, AppState>, id: String, target: String) -> Result<Settings, String> {
    commit(&app, &state, |old| Ok(old.widget_moved(&id, &target)))
}

#[tauri::command]
async fn set_minimized(app: AppHandle, state: State<'_, AppState>, minimized: bool) -> Result<Settings, String> {
    commit(&app, &state, |old| Ok(Settings { minimized, ..old.clone() }))
}

#[tauri::command]
fn clock_state(state: State<'_, AppState>) -> clock::View {
    state.clock.read(|c| c.view(Instant::now()))
}

#[tauri::command]
fn timer_add(app: AppHandle, state: State<'_, AppState>, label: String, seconds: u64) -> Result<clock::View, String> {
    state.clock.with(|c| c.add_timer(&label, seconds, Instant::now()))?;
    Ok(clock_view(&app, &state))
}

#[tauri::command]
fn timer_control(app: AppHandle, state: State<'_, AppState>, id: u64, action: TimerAction) -> Result<clock::View, String> {
    if !state.clock.with(|c| c.control_timer(id, action, Instant::now())) {
        return Err("El temporizador ya no existe".into());
    }
    Ok(clock_view(&app, &state))
}

/// Detiene un aviso («Detener») o lo pospone 5 min (`snooze`, solo alarmas).
#[tauri::command]
fn alert_dismiss(app: AppHandle, state: State<'_, AppState>, id: u64, snooze: bool) -> clock::View {
    let before = shape(&state);
    state.clock.with(|c| c.dismiss(id, snooze, Instant::now()));
    relayout(&app, &state, before, true);
    clock_view(&app, &state)
}

/// Abre o cierra un panel: ajusta el tamaño de la ventana. `height`: alto lógico
/// del contenido (el núcleo lo acota entre 160 y el fijo); sin él, el alto fijo.
#[tauri::command]
fn set_panel(app: AppHandle, state: State<'_, AppState>, open: bool, height: Option<f64>) {
    let before = shape(&state);
    *state.panel_height.lock().unwrap_or_else(|p| p.into_inner()) = height.filter(|_| open);
    state.panel.store(open, Ordering::Relaxed);
    relayout(&app, &state, before, true);
}

#[tauri::command]
fn clipboard_list(state: State<'_, AppState>, query: String) -> clipboard::View {
    clips(&state).view(&query)
}

/// Copia de nuevo un elemento y lo sube arriba. `async`: fuera del hilo principal
/// (el portapapeles puede estar ocupado y se reintenta unos milisegundos).
#[tauri::command]
async fn clipboard_copy(app: AppHandle, id: u64) -> Result<(), String> {
    let state = app.try_state::<AppState>().ok_or("JarWis aún no está listo")?;
    let text = clips(&state).text(id).ok_or("El elemento ya no existe")?;
    #[cfg(windows)]
    clipboard::write_text(&text)?;
    clips(&state).touch(id, clipboard::now_ms());
    clipboard_changed(&app);
    Ok(())
}

#[tauri::command]
fn clipboard_pin(app: AppHandle, state: State<'_, AppState>, id: u64, pinned: bool) -> Result<(), String> {
    if clips(&state).pin(id, pinned)? {
        clipboard_changed(&app);
    }
    Ok(())
}

#[tauri::command]
fn clipboard_delete(app: AppHandle, state: State<'_, AppState>, id: u64) {
    if clips(&state).remove(id) {
        clipboard_changed(&app);
    }
}

/// «Borrar todo»: borra lo no fijado.
#[tauri::command]
fn clipboard_clear(app: AppHandle, state: State<'_, AppState>) {
    clips(&state).clear_unpinned();
    clipboard_changed(&app);
}

/// Pausa rápida (no se persiste ni borra nada).
#[tauri::command]
fn clipboard_pause(app: AppHandle, state: State<'_, AppState>, paused: bool) {
    clips(&state).paused = paused;
    clipboard_changed(&app);
}

/// Muestra del sistema; la llama la isla solo mientras está visible.
#[tauri::command]
async fn system_snapshot(state: State<'_, AppState>) -> Result<monitor::Snapshot, String> {
    let mut m = state.monitor.lock().unwrap_or_else(|p| p.into_inner());
    Ok(m.get_or_insert_with(monitor::Monitor::new).snapshot())
}

/// Lectura puntual del modo efectivo; nunca durante el arranque ni por sondeo.
#[tauri::command]
async fn power_mode() -> Result<power::Mode, String> {
    blocking(power::read_mode).await
}

/// Cambio de modo autorizado por botón; devuelve una nueva lectura efectiva.
#[tauri::command]
async fn power_set(mode: power::SetMode) -> Result<power::Mode, String> {
    blocking(move || power::set_mode(mode)).await
}

/// Solo Configuración de energía u OMEN Gaming Hub; sin destinos de la WebView.
#[tauri::command]
async fn power_open(target: power::OpenTarget) -> Result<(), String> {
    blocking(move || power::open(target)).await
}

#[tauri::command]
fn get_shortcuts(state: State<'_, AppState>) -> Vec<shortcuts::Shortcut> {
    current(&state).shortcuts
}

#[tauri::command]
async fn set_shortcuts(
    app: AppHandle,
    state: State<'_, AppState>,
    list: Vec<shortcuts::Shortcut>,
) -> Result<Vec<shortcuts::Shortcut>, String> {
    Ok(commit(&app, &state, |old| {
        let shortcuts = shortcuts::validate(&list)?;
        // `normalize` poda los espacios en el mismo guardado.
        Ok(Settings { shortcuts, ..old.clone() })
    })?.shortcuts)
}

/// Guarda los espacios de trabajo (validados contra los accesos guardados). Solo Ajustes.
#[tauri::command]
async fn set_workspaces(
    app: AppHandle,
    state: State<'_, AppState>,
    list: Vec<settings::Workspace>,
) -> Result<Vec<settings::Workspace>, String> {
    Ok(commit(&app, &state, |old| {
        let workspaces = settings::validate_workspaces(&list, &old.shortcuts)?;
        Ok(Settings { workspaces, ..old.clone() })
    })?.workspaces)
}

/// Reserva por id sin mantener el mutex durante las aperturas; libera incluso ante error.
struct WorkspaceOpening {
    ids: Arc<Mutex<HashSet<u64>>>,
    id: u64,
}

impl WorkspaceOpening {
    fn acquire(ids: &Arc<Mutex<HashSet<u64>>>, id: u64) -> Result<Self, String> {
        if !ids.lock().unwrap_or_else(|p| p.into_inner()).insert(id) {
            return Err("Este espacio ya se está abriendo. Espera a que termine.".into());
        }
        Ok(Self { ids: Arc::clone(ids), id })
    }
}

impl Drop for WorkspaceOpening {
    fn drop(&mut self) {
        self.ids.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.id);
    }
}

fn workspace_items(ids: &[u64], shortcuts: &[shortcuts::Shortcut]) -> Vec<shortcuts::Shortcut> {
    let mut seen = HashSet::new();
    ids.iter().filter(|id| seen.insert(**id)).filter_map(|id| shortcuts.iter().find(|s| s.id == *id).cloned()).collect()
}

fn workspace_report(opened: usize, failed: &[String]) -> Result<String, String> {
    let report = format!("Accesos abiertos: {opened}.");
    if failed.is_empty() {
        Ok(report)
    } else {
        Err(format!("{report} No se pudieron abrir: {}.", failed.join(", ")))
    }
}

/// Abre todos los accesos de un espacio, por id. Sigue aunque uno falle.
#[tauri::command]
async fn open_workspace(app: AppHandle, id: u64) -> Result<String, String> {
    let state = app.try_state::<AppState>().ok_or("JarWis aún no está listo")?;
    let opening = WorkspaceOpening::acquire(&state.opening_workspaces, id)?;
    let s = current(&state);
    let ws = s.workspaces.iter().find(|w| w.id == id).ok_or("El espacio ya no existe")?;
    let items = workspace_items(&ws.shortcuts, &s.shortcuts);
    if items.is_empty() {
        return Err("El espacio no tiene accesos".into());
    }
    // ponytail: cada acceso `store` vuelve a enumerar AppsFolder (coste ×N); enumerar una vez por espacio si pesa.
    blocking(move || {
        // La reserva viaja con el trabajo: cancelar la espera no permite otra apertura.
        let _opening = opening;
        let failed: Vec<String> = items.iter().filter(|x| shortcuts::open(x).is_err()).map(|x| format!("«{}»", x.name)).collect();
        workspace_report(items.len() - failed.len(), &failed)
    })
    .await
}

/// Abre solo un acceso guardado, por id. `async`: fuera del hilo principal.
#[tauri::command]
async fn open_shortcut(app: AppHandle, id: u64) -> Result<(), String> {
    let state = app.try_state::<AppState>().ok_or("JarWis aún no está listo")?;
    let s = current(&state).shortcuts.into_iter().find(|s| s.id == id).ok_or("El acceso ya no existe")?;
    // En el pool bloqueante: `store` enumera apps por COM antes de abrir (D-027).
    blocking(move || shortcuts::open(&s)).await
}

/// Apps de Microsoft Store instaladas, para elegir un acceso `store` (solo Ajustes).
#[tauri::command]
async fn list_store_apps() -> Result<Vec<shortcuts::StoreApp>, String> {
    blocking(shortcuts::list_store_apps).await
}

/// Ejecuta una llamada COM/WinRT bloqueante fuera del hilo principal (D-027).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|_| "Error interno".to_string())?
}

#[tauri::command]
async fn show_codex_pet() -> Result<(), String> {
    blocking(codex_pet::show).await
}

#[tauri::command]
async fn audio_state() -> Result<Option<audio::AudioState>, String> {
    blocking(audio::state).await
}

#[tauri::command]
async fn set_volume(volume: f64) -> Result<(), String> {
    blocking(move || audio::set_volume(volume)).await
}

#[tauri::command]
async fn set_muted(muted: bool) -> Result<(), String> {
    blocking(move || audio::set_muted(muted)).await
}

#[tauri::command]
async fn list_audio_devices() -> Result<Vec<audio::AudioDevice>, String> {
    blocking(audio::list_devices).await
}

#[tauri::command]
async fn open_sound_settings() -> Result<(), String> {
    audio::open_sound_settings()
}

/// Abre Configuración > Concentración. Windows no se modifica por código (sin API pública).
#[tauri::command]
async fn open_focus_settings() -> Result<(), String> {
    tauri_plugin_opener::open_url("ms-settings:quiethours", None::<&str>)
        .map_err(|e| format!("No se pudo abrir Concentración: {e}"))
}

#[tauri::command]
async fn media_state() -> Result<Option<media::MediaState>, String> {
    blocking(media::state).await
}

#[tauri::command]
async fn media_control(action: media::Action) -> Result<bool, String> {
    blocking(move || media::control(action)).await
}

/// Destinos de `media_open`: la WebView solo envía el nombre; las URI están aquí.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum MediaTarget {
    Spotify,
    Youtube,
    Netflix,
    Telegram,
    Whatsapp,
}

const SPOTIFY_AUMID: &str = "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify";
const SPOTIFY_URL: &str = "https://open.spotify.com";
const YOUTUBE_URL: &str = "https://www.youtube.com";
/// Netflix (Microsoft Store), verificado con Get-StartApps (D-047).
const NETFLIX_AUMID: &str = "4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App";
const NETFLIX_URL: &str = "https://www.netflix.com";
// JW-30: AUMID proporcionados; apps ausentes en este PC, sin verificar con Get-StartApps.
const TELEGRAM_AUMID: &str = "TelegramMessengerLLP.TelegramDesktop_t4vj0pshhgkwm!Telegram.TelegramDesktop.Store";
const TELEGRAM_URL: &str = "https://web.telegram.org";
const WHATSAPP_AUMID: &str = "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App";
const WHATSAPP_URL: &str = "https://web.whatsapp.com";

impl MediaTarget {
    fn destination(self) -> (Option<&'static str>, &'static str) {
        match self {
            Self::Spotify => (Some(SPOTIFY_AUMID), SPOTIFY_URL),
            Self::Netflix => (Some(NETFLIX_AUMID), NETFLIX_URL),
            Self::Telegram => (Some(TELEGRAM_AUMID), TELEGRAM_URL),
            Self::Whatsapp => (Some(WHATSAPP_AUMID), WHATSAPP_URL),
            Self::Youtube => (None, YOUTUBE_URL),
        }
    }
}

/// Tienda revalidada → web; Spotify conserva su exe fijo intermedio. YouTube solo web.
#[tauri::command]
async fn media_open(target: MediaTarget) -> Result<(), String> {
    blocking(move || {
        let (app_id, url) = target.destination();
        if let Some(app_id) = app_id {
            let exe = if target == MediaTarget::Spotify {
                std::env::var_os("APPDATA").map(|d| std::path::PathBuf::from(d).join(r"Spotify\Spotify.exe"))
            } else {
                None
            };
            shortcuts::open_app_or_web(app_id, exe, url)
        } else {
            tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| "No se pudo abrir el navegador".to_string())
        }
    })
    .await
}

// ---- Clima manual (D-080): red asíncrona y comandos separados por ventana.

#[tauri::command]
async fn weather_open(window: WebviewWindow, target: weather::LinkTarget) -> Result<(), String> {
    if window.label() != BAR { return Err("La atribución solo está disponible en la barra".into()); }
    tauri_plugin_opener::open_url(target.url(), None::<&str>)
        .map_err(|_| "No se pudo abrir el navegador".into())
}

#[tauri::command]
async fn weather_today(window: WebviewWindow, weather: State<'_, weather::Weather>, force: bool) -> Result<cloud::Feed<weather::WeatherView>, String> {
    if window.label() != BAR { return Err("El clima solo está disponible en la barra".into()); }
    Ok(weather.today(force).await)
}

#[tauri::command]
async fn weather_search(window: WebviewWindow, query: String) -> Result<Vec<weather::WeatherPlace>, String> {
    if window.label() != SETTINGS_WINDOW { return Err("La búsqueda de ciudades solo está disponible en Ajustes".into()); }
    weather::search(&query).await
}

// ---- Google (Fase 4, D-038): red asíncrona, sin bloquear el hilo principal.

#[tauri::command]
async fn cloud_mail(
    app: AppHandle,
    state: State<'_, AppState>,
    cloud: State<'_, cloud::Cloud>,
    force: bool,
) -> Result<cloud::Feed<cloud::MailView>, String> {
    let export_ticket = cloud.today_writer.ticket();
    let (feed, fresh) = cloud.mail(force).await;
    if fresh && current(&state).share_today {
        let updated = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false);
        if let Some(update) = feed.today_update(&updated) { export_today(&app, export_ticket, update); }
    }
    // La referencia se actualiza siempre; el aviso solo con el interruptor activo (D-042).
    let n = cloud.take_new_mail();
    if n > 0 && current(&state).notifications {
        notify(&app, "Correo", &cloud::mail_body(n));
    }
    Ok(feed)
}

#[tauri::command]
async fn cloud_agenda(
    app: AppHandle,
    state: State<'_, AppState>,
    cloud: State<'_, cloud::Cloud>,
    force: bool,
) -> Result<cloud::Feed<cloud::AgendaView>, String> {
    // Capturar antes de esperar a Google: logout o apagado invalidan esta consulta.
    let export_ticket = cloud.today_writer.ticket();
    let (feed, fresh) = cloud.agenda(force).await;
    if fresh && current(&state).share_today {
        let updated = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false);
        if let Some(update) = feed.today_update(&updated) {
            export_today(&app, export_ticket, update);
        }
    }
    if current(&state).notifications {
        for body in cloud.take_due_events(&chrono::Local::now()) {
            notify(&app, "Calendario", &body);
        }
    }
    Ok(feed)
}

/// Escribe `hoy.json` (D-048) fuera del hilo del comando. Los fallos se ignoran:
/// nunca cambian el `Feed` ni bloquean la UI.
fn export_today(app: &AppHandle, ticket: cloud::TodayTicket, update: cloud::TodayUpdate) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (Some(state), Some(cloud), Some(path)) =
            (app.try_state::<AppState>(), app.try_state::<cloud::Cloud>(), cloud::today_path()) else { return };
        let _ = cloud.today_writer.write(ticket, &path, update, current(&state).share_today);
    });
}

#[tauri::command]
async fn cloud_month(cloud: State<'_, cloud::Cloud>, year: i32, month: u32, force: bool) -> Result<cloud::Feed<cloud::MonthView>, String> {
    cloud.month(year, month, force).await
}

/// Abre en el navegador un elemento que esté en la caché (la URL la construye Rust).
#[tauri::command]
async fn cloud_open(cloud: State<'_, cloud::Cloud>, kind: cloud::OpenKind, id: String) -> Result<(), String> {
    let url = cloud.link(kind, &id)?;
    blocking(move || tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| "No se pudo abrir el navegador".to_string()))
        .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudStatus {
    configured: bool,
    connected: bool,
    login_in_progress: bool,
}

/// Estado local (archivo de configuración y Administrador de credenciales), sin red.
#[tauri::command]
async fn cloud_status(cloud: State<'_, cloud::Cloud>) -> Result<CloudStatus, String> {
    Ok(CloudStatus {
        configured: jarwis_auth::load_config().is_ok_and(|c| c.google.is_some()),
        connected: jarwis_auth::has_session(jarwis_auth::Provider::Google).unwrap_or(false),
        login_in_progress: cloud.login_in_progress(),
    })
}

#[derive(Serialize)]
struct LoginResult {
    /// Email enmascarado (`u***@dominio`).
    account: Option<String>,
}

/// Inicio de sesión en el navegador del sistema (PKCE + loopback, 5 min). Solo desde Ajustes.
// ponytail: sin «Cancelar»; el plazo de 5 min del loopback lo cierra.
#[tauri::command]
async fn cloud_login(app: AppHandle, cloud: State<'_, cloud::Cloud>) -> Result<LoginResult, String> {
    let _busy = cloud.begin_login().ok_or("Ya hay un inicio de sesión en curso")?;
    let cfg = jarwis_auth::load_config().map_err(|e| e.to_string())?;
    let out = jarwis_auth::login(jarwis_auth::Provider::Google, &cfg, |url| {
        if tauri_plugin_opener::open_url(url, None::<&str>).is_err() {
            let _ = jarwis_auth::open_browser(url);
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    cloud.reset();
    let _ = app.emit(CLOUD_EVENT, ());
    Ok(LoginResult { account: out.account.as_deref().map(jarwis_auth::mask_email) })
}

#[derive(Serialize)]
struct LogoutResult {
    deleted: bool,
    /// Revocación en Google: `false` → la UI enlaza a myaccount.google.com/permissions.
    revoked: Option<bool>,
}

/// Desconecta Google: la credencial local se borra siempre; la revocación es de mejor esfuerzo.
#[tauri::command]
async fn cloud_logout(app: AppHandle, cloud: State<'_, cloud::Cloud>) -> Result<LogoutResult, String> {
    let _busy = cloud.begin_login().ok_or("Hay un inicio de sesión en curso")?;
    let cfg = jarwis_auth::load_config().ok();
    let res = jarwis_auth::logout(jarwis_auth::Provider::Google, cfg.as_ref()).await;
    cloud.reset();
    let _ = app.emit(CLOUD_EVENT, ());
    let out = res.map_err(|e| e.to_string())?;
    Ok(LogoutResult { deleted: out.deleted, revoked: out.revoked.map(|r| r.is_ok()) })
}

// ---- Lanzador de IA (D-044, D-047): la WebView solo envía la acción; los destinos están en `claude.rs`.

/// App de Claude, terminal con `claude`, página de uso, ChatGPT o Antigravity.
#[tauri::command]
async fn claude_open(action: claude::OpenAction) -> Result<(), String> {
    blocking(move || claude::open(action)).await
}

/// Siembra única del acceso «Bitwarden» (D-045), en el pool bloqueante: la detección
/// enumera apps por COM. La siembra se calcula dentro de la transacción de ajustes.
fn seed_bitwarden(app: &AppHandle) {
    if current(&app.state::<AppState>()).bitwarden_seeded {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let found = bitwarden::detect();
        let state = app.state::<AppState>();
        let _ = commit(&app, &state, |old| Ok(bitwarden::seed(old, found).unwrap_or_else(|| old.clone())));
    });
}

#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<MonitorInfo> {
    let Some(win) = bar(&app) else { return Vec::new() };
    let primary = win.primary_monitor().ok().flatten().and_then(|m| m.name().cloned());
    win.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .filter_map(|(i, m)| {
            let name = m.name()?.clone();
            let is_primary = primary.as_ref() == Some(&name);
            let label = format!(
                "Pantalla {} ({}×{}, {} %){}",
                i + 1,
                m.size().width,
                m.size().height,
                (m.scale_factor() * 100.0).round(),
                if is_primary { " · principal" } else { "" }
            );
            Some(MonitorInfo { name, label, primary: is_primary })
        })
        .collect()
}

#[tauri::command]
fn get_status(state: State<'_, AppState>) -> Status {
    Status { shortcut_errors: state.shortcut_errors.lock().unwrap_or_else(|p| p.into_inner()).clone() }
}

// `async`: se ejecuta fuera del hilo principal (ver show_settings_window).
#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    show_settings_window(&app).map_err(|e| e.to_string())
}

/// Bordes del menú contextual de la isla. Ids con prefijo `bar-`: el manejador
/// de menú es global (bandeja y popup) y no deben chocar con los de la bandeja.
const BAR_EDGES: [(&str, &str, Edge); 4] = [
    ("bar-edge-top", "Arriba", Edge::Top),
    ("bar-edge-bottom", "Abajo", Edge::Bottom),
    ("bar-edge-left", "Izquierda", Edge::Left),
    ("bar-edge-right", "Derecha", Edge::Right),
];

/// Menú contextual de la isla (clic derecho). `async` (D-027): el popup es
/// modal y este hilo espera a que se cierre; el hilo principal sigue libre.
#[tauri::command]
async fn bar_menu(app: AppHandle) -> Result<(), String> {
    let win = bar(&app).ok_or("La barra no existe")?;
    let s = current(&app.state::<AppState>());
    let edge = s.edge;
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let edges = BAR_EDGES
            .iter()
            .map(|(id, label, e)| CheckMenuItem::with_id(&app, *id, label, true, *e == edge, None::<&str>))
            .collect::<tauri::Result<Vec<_>>>()?;
        let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = edges.iter().map(|i| i as _).collect();
        Menu::with_items(
            &app,
            &[
                &MenuItem::with_id(&app, "presence", presence_label(s.minimized), true, None::<&str>)?,
                &Submenu::with_items(&app, "Posición", true, &refs)?,
                &MenuItem::with_id(&app, "bar-center", "Centrar", true, None::<&str>)?,
                &MenuItem::with_id(&app, "bar-hide", "Ocultar barra", true, None::<&str>)?,
                &MenuItem::with_id(&app, "bar-settings", "Ajustes…", true, None::<&str>)?,
                &PredefinedMenuItem::separator(&app)?,
                &MenuItem::with_id(&app, "bar-quit", "Salir de JarWis", true, None::<&str>)?,
            ],
        )
    };
    let menu = build().map_err(|e| format!("No se pudo crear el menú: {e}"))?;
    win.popup_menu(&menu).map_err(|e| format!("No se pudo mostrar el menú: {e}"))
}

/// Arrastra la isla con el movimiento nativo de Windows y, al soltar, la pega al
/// borde más cercano al centro de la ventana (JW-2-09), en la posición soltada a lo
/// largo del borde (fracción guardada por borde, D-047). Se usa el monitor de los
/// ajustes (el elegido o el principal), como en `place_bar`.
/// `async` (D-027): este hilo espera el fin del arrastre; el principal, libre.
#[tauri::command]
async fn bar_drag(app: AppHandle) -> Result<(), String> {
    let win = bar(&app).ok_or("La barra no existe")?;
    let state = app.state::<AppState>();
    if state.dragging.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let start = win.outer_position().ok();
    let drag_window = win.clone();
    let res = blocking(move || native_drag(&drag_window)).await;
    // Sin movimiento real (clic o arrastre cancelado): no se recalcula la fracción.
    let moved = start.is_none() || win.outer_position().ok() != start;
    let result = res.and_then(|()| commit(&app, &state, |s| {
        if !moved {
            state.dragging.store(false, Ordering::SeqCst);
            return Ok(s.clone());
        }
        // Mantener la protección hasta leer el destino bajo el mutex: otro
        // publicador no debe recolocar la ventana antes de medir dónde se soltó.
        let (edge, monitor, offset) = drop_target(&app, &win, s)?;
        let bar_offsets = s.bar_offsets.with(edge, offset);
        state.dragging.store(false, Ordering::SeqCst);
        Ok(Settings { edge, monitor, bar_offsets, ..s.clone() })
    }).map(|_| ()));
    state.dragging.store(false, Ordering::SeqCst);
    place(&app);
    result
}

/// Borde y monitor al soltar (JW-2-10). El monitor es el que contiene el cursor
/// (coordenadas físicas) o, si no, el centro de la ventana; si ninguno cae en un
/// monitor, el de los ajustes. El borde se elige por el centro de la ventana
/// dentro del área de trabajo de ese monitor, y la fracción a lo largo del borde por
/// el mismo punto (limitada a [0, 1]: nunca sale del área útil). La fracción marca el
/// centro (JW-15-04): no depende de la forma ni del tamaño de la ventana.
fn drop_target(app: &AppHandle, win: &WebviewWindow, s: &Settings) -> Result<(Edge, Option<String>, f64), String> {
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    // Centro exacto (medios píxeles incluidos) para que la fracción se invierta sin error.
    let (fx, fy) = (f64::from(pos.x) + f64::from(size.width) / 2.0, f64::from(pos.y) + f64::from(size.height) / 2.0);
    let (cx, cy) = (fx.floor() as i32, fy.floor() as i32);
    let monitors = win.available_monitors().unwrap_or_default();
    let bounds: Vec<Rect> = monitors
        .iter()
        .map(|m| Rect { x: m.position().x, y: m.position().y, width: m.size().width, height: m.size().height })
        .collect();
    let cursor = app.cursor_position().ok().map(|p| (p.x, p.y));
    // Manda donde se ve la isla (su centro); el cursor solo si el centro cae en un hueco.
    // El borde se mide desde el mismo punto que eligió el monitor.
    let (hit, (px, py)) = match layout::monitor_at(&bounds, cx, cy) {
        Some(i) => (Some(i), (fx, fy)),
        None => match cursor.and_then(|(x, y)| layout::monitor_at(&bounds, x.floor() as i32, y.floor() as i32).map(|i| (i, (x, y)))) {
            Some((i, p)) => (Some(i), p),
            None => (None, (fx, fy)),
        },
    };
    let hit = hit.map(|i| &monitors[i]);
    let (work_area, scale, monitor) = match hit {
        Some(m) => {
            let wa = m.work_area();
            let rect = Rect { x: wa.position.x, y: wa.position.y, width: wa.size.width, height: wa.size.height };
            // Sin nombre (no debería pasar en Windows): se conserva el elegido.
            (rect, m.scale_factor(), m.name().cloned().or_else(|| s.monitor.clone()))
        }
        None => {
            let (wa, scale) = bar_monitor(win, s).ok_or("No hay monitores")?;
            (wa, scale, s.monitor.clone())
        }
    };
    let edge = layout::nearest_edge(work_area, px.floor() as i32, py.floor() as i32);
    Ok((edge, monitor, layout::offset_at(work_area, scale, edge, px, py)))
}

/// Coordenadas de pantalla con signo, empaquetadas por valor para WM_NCLBUTTONDOWN.
#[cfg(windows)]
fn drag_point(x: i32, y: i32) -> isize {
    ((x as u16 as u32) | ((y as u16 as u32) << 16)) as isize
}

#[cfg(windows)]
fn handoff_drag(x: i32, y: i32, pressed: bool, send: impl FnOnce(isize)) {
    // Un IPC tardío, después de soltar, no debe iniciar un movimiento modal nuevo.
    if !pressed {
        return;
    }
    // No tener captura es válido: Mini la suelta antes del IPC.
    let _ = unsafe { windows::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture() };
    send(drag_point(x, y));
}

/// Entrega compartida para Mini y el fondo: tao 0.37.1 publica una dirección de
/// pila como LPARAM en vez de coordenadas. El envío síncrono espera hasta soltar/cancelar;
/// `dragging` sigue protegiendo place y el centro se mide después del movimiento.
#[cfg(windows)]
fn native_drag(win: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetSystemMetrics, SendMessageW, HTCAPTION, SM_SWAPBUTTON, WM_NCLBUTTONDOWN};
    let hwnd = win.hwnd().map_err(|e| e.to_string())?.0 as usize;
    let (tx, rx) = std::sync::mpsc::channel();
    win.run_on_main_thread(move || {
        let result = (|| {
            let mut point = POINT::default();
            unsafe { GetCursorPos(&mut point) }.map_err(|e| format!("No se pudo leer el cursor: {e}"))?;
            let button = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 { VK_RBUTTON } else { VK_LBUTTON };
            let pressed = unsafe { GetAsyncKeyState(i32::from(button.0)) } < 0;
            handoff_drag(point.x, point.y, pressed, |point| unsafe {
                SendMessageW(HWND(hwnd as _), WM_NCLBUTTONDOWN, Some(WPARAM(HTCAPTION as usize)), Some(LPARAM(point)));
            });
            Ok(())
        })();
        let _ = tx.send(result);
    }).map_err(|e| format!("No se pudo mover la barra: {e}"))?;
    rx.recv().map_err(|_| "No se pudo completar el arrastre".to_string())?
}

/// Manejador global de menús (bandeja y menú contextual de la isla).
fn on_menu(app: &AppHandle, id: &str) {
    // El publicador puede esperar al hilo de UI para una operación nativa.
    // Nunca esperar al mutex escritor desde ese mismo hilo (menús/atajos).
    let app = app.clone();
    let id = id.to_string();
    std::thread::spawn(move || handle_menu(&app, &id));
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "toggle" => toggle_visibility(app),
        "mode" => toggle_mode(app),
        "presence" => {
            let state = app.state::<AppState>();
            let _ = commit(app, &state, |s| Ok(Settings { minimized: !s.minimized, ..s.clone() }));
            if !current(&state).minimized {
                show_bar(app);
            }
        }
        "bar-hide" => hide_bar(app),
        "settings" | "bar-settings" => {
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = show_settings_window(&app);
            });
        }
        "quit" | "bar-quit" => app.exit(0),
        // Vuelve al centro del borde actual (D-047).
        "bar-center" => {
            let state = app.state::<AppState>();
            let _ = commit(app, &state, |s| Ok(Settings { bar_offsets: s.bar_offsets.with(s.edge, 0.5), ..s.clone() }));
        }
        _ => {
            if let Some((_, _, edge)) = BAR_EDGES.iter().find(|(i, _, _)| *i == id) {
                // Mismo commit: persistir, aplicar y recolocar.
                let state = app.state::<AppState>();
                let _ = commit(app, &state, |s| Ok(Settings { edge: *edge, ..s.clone() }));
            }
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let presence = MenuItem::with_id(app, "presence", presence_label(current(&app.state::<AppState>()).minimized), true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Mostrar/Ocultar", true, None::<&str>)?;
    let mode = MenuItem::with_id(app, "mode", "Compacto/Expandido", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Ajustes", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &mode, &presence, &settings, &sep, &quit])?;
    app.manage(PresenceMenu(presence));

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("JarWis")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_visibility(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // single-instance debe registrarse el primero.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_bar(app)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if *shortcut == shortcut_toggle() {
                        toggle_visibility(app);
                    } else if *shortcut == shortcut_mode() {
                        toggle_mode(app);
                    } else if *shortcut == shortcut_clipboard() {
                        // La isla decide abrir o cerrar (sabe qué panel está abierto).
                        show_bar(app);
                        let _ = app.emit_to(BAR, PANEL_SHORTCUT_EVENT, "clipboard");
                    }
                })
                .build(),
        )
        // El plugin solo registra/desregistra cuando el usuario lo pide en Ajustes.
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        // Solo se usa desde Rust: la WebView no recibe permisos de notificación.
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Todo arranque borra la exportación de la sesión anterior, sin red.
            app.manage(cloud::Cloud::new(cloud::today_path()));
            let handle = app.handle().clone();
            let path = app.path().app_config_dir()?.join("settings.json");
            let initial = settings::load(&path);

            // Un fallo al registrar un atajo no impide arrancar: se informa en Ajustes.
            let mut errors = Vec::new();
            for (sc, name) in global_shortcuts() {
                if let Err(e) = handle.global_shortcut().register(sc) {
                    errors.push(format!("{name}: {e}"));
                }
            }

            let clock = Scheduler::default();
            clock.with(|c| c.set_alarms(&initial.alarms, clock::Now::real().local));
            app.manage(AppState {
                settings: settings::Store::new(path, initial.clone()),
                autostart_change: Mutex::new(()),
                shortcut_errors: Mutex::new(errors),
                opening_workspaces: Arc::default(),
                panel: AtomicBool::new(false),
                panel_height: Mutex::new(None),
                clock,
                clipboard: Mutex::new(clipboard::Store::default()),
                monitor: Mutex::new(None),
                dragging: AtomicBool::new(false),
            });
            let weather = weather::Weather::default();
            weather.set_place(initial.weather_place.clone());
            app.manage(weather);
            migrate_offsets(&handle, &app.state::<AppState>());
            seed_bitwarden(&handle);

            // Prueba manual D-039 (solo debug): `jarwis.exe --notify-test` muestra un aviso ficticio.
            #[cfg(debug_assertions)]
            if std::env::args().any(|a| a == "--notify-test") {
                notify(&handle, "Correo", "jarwis-prueba: 2 correos nuevos");
            }

            build_tray(&handle)?;
            apply_window(&handle, &initial);
            place(&handle);

            // Único hilo del reloj: duerme hasta el próximo vencimiento.
            let app = handle.clone();
            std::thread::Builder::new().name("clock".into()).spawn(move || {
                if let Some(state) = app.try_state::<AppState>() {
                    state.clock.run(|fired| on_fired(&app, &fired));
                }
            })?;
            let app = handle.clone();
            std::thread::Builder::new().name("today-expiry".into()).spawn(move || {
                if let Some(cloud) = app.try_state::<cloud::Cloud>() {
                    cloud.today_writer.run_expiry();
                }
            })?;
            // Oyente del portapapeles por eventos; un fallo no impide arrancar.
            #[cfg(windows)]
            {
                let enabled_app = handle.clone();
                let app = handle.clone();
                let enabled = move || {
                    enabled_app
                        .try_state::<AppState>()
                        .is_some_and(|s| current(&s).clipboard_history && !clips(&s).paused)
                };
                if let Err(e) = clipboard::listen(enabled, move |text| on_clip(&app, text)) {
                    eprintln!("No se pudo iniciar el historial del portapapeles: {e}");
                }
            }
            if let Some(win) = bar(&handle) {
                win.show()?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != BAR {
                return;
            }
            match event {
                // La barra no se cierra: se oculta. Para salir, «Salir» en la bandeja.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    hide_bar(window.app_handle());
                }
                // Cambio de DPI (p. ej. al cambiar la escala): se recalcula sin sondeos.
                WindowEvent::ScaleFactorChanged { .. } => place(window.app_handle()),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            bar_track,
            patch_settings,
            alarm_add,
            alarm_set_enabled,
            alarm_remove,
            widget_move,
            set_minimized,
            list_monitors,
            get_status,
            open_settings,
            clock_state,
            timer_add,
            timer_control,
            alert_dismiss,
            set_panel,
            clipboard_list,
            clipboard_copy,
            clipboard_pin,
            clipboard_delete,
            clipboard_clear,
            clipboard_pause,
            system_snapshot,
            power_mode,
            power_set,
            power_open,
            get_shortcuts,
            set_shortcuts,
            open_shortcut,
            list_store_apps,
            audio_state,
            set_volume,
            set_muted,
            list_audio_devices,
            open_sound_settings,
            open_focus_settings,
            open_workspace,
            set_workspaces,
            media_state,
            media_control,
            media_open,
            bar_menu,
            bar_drag,
            weather_today,
            weather_open,
            weather_search,
            cloud_mail,
            cloud_agenda,
            cloud_month,
            cloud_open,
            cloud_status,
            cloud_login,
            cloud_logout,
            claude_open,
            show_codex_pet
        ])
        .build(tauri::generate_context!())
        .expect("error while building JarWis")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(cloud) = app.try_state::<cloud::Cloud>() {
                    cloud.today_writer.shutdown();
                }
            }
        });
}

#[cfg(test)]
mod presence_tests {
    use super::*;

    #[test]
    fn global_shortcuts_are_distinct() {
        let shortcuts = global_shortcuts();
        for (index, (shortcut, _)) in shortcuts.iter().enumerate() {
            assert!(shortcuts[..index].iter().all(|(other, _)| other != shortcut));
        }
        assert_eq!(shortcuts.len(), 3);
    }

    #[test]
    fn media_targets_map_to_fixed_destinations() {
        for (name, app_id, url) in [
            ("spotify", Some("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "https://open.spotify.com"),
            ("netflix", Some("4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App"), "https://www.netflix.com"),
            ("telegram", Some("TelegramMessengerLLP.TelegramDesktop_t4vj0pshhgkwm!Telegram.TelegramDesktop.Store"), "https://web.telegram.org"),
            ("whatsapp", Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App"), "https://web.whatsapp.com"),
            ("youtube", None, "https://www.youtube.com"),
        ] {
            let target: MediaTarget = serde_json::from_value(serde_json::json!(name)).unwrap();
            assert_eq!(target.destination(), (app_id, url));
        }
    }

    #[test]
    fn media_targets_reject_unknown_names_and_external_destinations() {
        for value in [
            serde_json::json!("Telegram"), serde_json::json!("https://web.telegram.org"),
            serde_json::json!("other"), serde_json::json!({ "target": "telegram", "url": "https://example.com" }),
            serde_json::Value::Null,
        ] {
            assert!(serde_json::from_value::<MediaTarget>(value).is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn drag_message_keeps_signed_screen_coordinates_by_value() {
        for (x, y) in [(0, 0), (1920, 1080), (-1920, -1080), (-1, 32767), (32767, -32768)] {
            let packed = drag_point(x, y);
            assert_eq!(i32::from(packed as i16), x);
            assert_eq!(i32::from((packed >> 16) as i16), y);
        }
    }

    #[cfg(windows)]
    #[test]
    fn drag_handoff_sends_even_when_capture_was_already_released() {
        std::thread::spawn(|| {
            use windows::Win32::UI::Input::KeyboardAndMouse::GetCapture;
            assert!(unsafe { GetCapture() }.is_invalid());
            let mut sent = None;
            handoff_drag(-1920, 240, false, |_| panic!("un IPC posterior a soltar no debe mover"));
            handoff_drag(-1920, 240, true, |point| sent = Some(point));
            assert_eq!(sent, Some(drag_point(-1920, 240)));
        }).join().unwrap();
    }

    #[test]
    fn workspace_guard_rejects_same_id_and_releases_on_completion_or_error() {
        let ids = Arc::default();
        let first = WorkspaceOpening::acquire(&ids, 1).unwrap();
        assert!(WorkspaceOpening::acquire(&ids, 1).err().unwrap().contains("ya se está abriendo"));
        let other = WorkspaceOpening::acquire(&ids, 2).unwrap();
        drop(first);
        let fail = || -> Result<(), String> {
            let _opening = WorkspaceOpening::acquire(&ids, 1)?;
            Err("fallo ficticio".into())
        };
        assert!(fail().is_err());
        assert!(WorkspaceOpening::acquire(&ids, 1).is_ok());
        assert!(WorkspaceOpening::acquire(&ids, 2).is_err());
        drop(other);
        assert!(ids.lock().unwrap().is_empty());
    }

    #[test]
    fn workspace_deduplicates_ids_in_order_and_reports_opened_and_failures() {
        let shortcut = |id, name: &str| shortcuts::Shortcut {
            id, name: name.into(), kind: shortcuts::Kind::Url,
            target: "https://example.com".into(), color: None, icon: None,
        };
        let saved = [shortcut(1, "Correo"), shortcut(2, "Editor")];
        let items = workspace_items(&[2, 1, 2, 1], &saved);
        assert_eq!(items.iter().map(|s| s.id).collect::<Vec<_>>(), [2, 1]);
        assert!(workspace_items(&[], &saved).is_empty());
        assert_eq!(workspace_report(2, &[]).unwrap(), "Accesos abiertos: 2.");
        assert_eq!(workspace_report(1, &["«Editor»".into()]).unwrap_err(), "Accesos abiertos: 1. No se pudieron abrir: «Editor».");
        assert_eq!(workspace_report(0, &["«Editor»".into(), "«Correo»".into()]).unwrap_err(), "Accesos abiertos: 0. No se pudieron abrir: «Editor», «Correo».");
    }

    #[test]
    fn autostart_only_applies_after_save_and_reverts_both_failed_transitions() {
        use std::cell::RefCell;
        for previous in [false, true] {
            for enabled in [false, true] {
                for fails in [false, true] {
                    let current = RefCell::new(Settings { autostart: previous, ..Settings::default() });
                    let steps = RefCell::new(Vec::new());
                    let result = save_then_autostart(
                        || {
                            current.borrow_mut().autostart = enabled;
                            steps.borrow_mut().push("guardar");
                            Ok((current.borrow().clone(), previous))
                        },
                        |value| {
                            assert_eq!(current.borrow().autostart, value);
                            steps.borrow_mut().push("aplicar");
                            // Otro commit puede editar campos independientes.
                            current.borrow_mut().theme = Theme::Dark;
                            if fails { Err("fallo ficticio".into()) } else { Ok(()) }
                        },
                        |value| {
                            current.borrow_mut().autostart = value;
                            steps.borrow_mut().push("revertir");
                            Ok(current.borrow().clone())
                        },
                    );
                    if previous == enabled {
                        assert!(result.is_ok());
                        assert_eq!(*steps.borrow(), ["guardar"]);
                    } else if fails {
                        assert_eq!(result.unwrap_err(), "No se pudo cambiar el inicio automático: fallo ficticio");
                        assert_eq!(current.borrow().autostart, previous);
                        assert_eq!(current.borrow().theme, Theme::Dark);
                        assert_eq!(*steps.borrow(), ["guardar", "aplicar", "revertir"]);
                    } else {
                        assert!(result.is_ok());
                        assert_eq!(current.borrow().autostart, enabled);
                        assert_eq!(*steps.borrow(), ["guardar", "aplicar"]);
                    }
                }
            }
        }
        assert_eq!(save_then_autostart(
            || Err("fallo de guardado".into()), |_| panic!("no debe aplicar"), |_| panic!("no debe revertir"),
        ).unwrap_err(), "fallo de guardado");
        let error = save_then_autostart(
            || Ok((Settings { autostart: true, ..Settings::default() }, false)),
            |_| Err("fallo del lanzador".into()), |_| Err("fallo de disco".into()),
        ).unwrap_err();
        assert!(error.contains("No se pudo cambiar el inicio automático: fallo del lanzador"));
        assert!(error.contains("No se pudo restaurar el ajuste anterior: fallo de disco"));
    }

    #[test]
    fn panel_and_alerts_override_mini_without_changing_preferences() {
        for mode in [Mode::Compact, Mode::Expanded] {
            let s = Settings { mode, minimized: true, ..Settings::default() };
            let snapshot = s.clone();
            assert_eq!(resolve_shape(&s, false, false), Shape::Mini);
            assert_eq!(resolve_shape(&s, false, true), Shape::Expanded);
            assert_eq!(resolve_shape(&s, true, true), Shape::Panel);
            assert_eq!(resolve_shape(&s, true, false), Shape::Panel);
            // Cerrar panel o detener el último aviso recupera Mini sin guardar nada.
            assert_eq!(resolve_shape(&s, false, false), Shape::Mini);
            assert_eq!(s, snapshot);
            let restored = normalize_commit(&s, mode_shortcut(s.clone()));
            assert!(!restored.minimized);
            assert_eq!(restored.mode, Mode::Compact);
            assert_eq!(resolve_shape(&restored, false, false), Shape::Compact);
            assert_eq!(mode_shortcut(restored).mode, Mode::Expanded);
        }
    }

    #[test]
    fn every_restore_commits_compact_without_changing_other_preferences() {
        for mode in [Mode::Compact, Mode::Expanded] {
            for was_minimized in [false, true] {
                for minimized in [false, true] {
                    let old = Settings { mode, minimized: was_minimized, ..Settings::default() };
                    let edited = Settings { mode: Mode::Expanded, minimized, ..old.clone() };
                    let actual = normalize_commit(&old, edited.clone());
                    let expected = Settings {
                        mode: if was_minimized && !minimized { Mode::Compact } else { edited.mode },
                        ..edited
                    };
                    assert_eq!(actual, expected);
                }
            }
        }
    }

    #[test]
    fn native_presence_labels_follow_saved_state() {
        assert_eq!(presence_label(false), "Minimizar");
        assert_eq!(presence_label(true), "Restaurar");
    }
}
