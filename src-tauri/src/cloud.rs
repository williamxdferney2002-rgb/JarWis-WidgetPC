//! Correo, agenda y tareas de Google para la isla (Fase 4, diseño en docs/reports/JW-4-01.md).
//!
//! Caché en memoria por widget; la red solo se toca cuando la isla lo pide y la
//! caché está vieja. La caducidad de la exportación tiene un trabajador sin red.
//! A la WebView solo llega D-038 (los enlaces se quedan en Rust); nada va a logs.

// D-024 (`panic = "abort"`): sin pánicos por construcción fuera de los tests.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing, clippy::string_slice)
)]

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Datelike, Local, NaiveDate, TimeDelta, TimeZone};
use jarwis_auth::api::{self, EventItem, MailItem, TaskItem};
use jarwis_auth::{AccessToken, AuthError, HttpClient, Provider};
use serde::{Deserialize, Serialize};

const MAIL_TTL: Duration = Duration::from_secs(60);
/// D-081: el correo compartido caduca aunque no haya nuevas consultas correctas.
const TODAY_MAIL_TTL: Duration = Duration::from_secs(2 * 60 * 60);
const AGENDA_TTL: Duration = Duration::from_secs(300);
/// Tras un error de cuota no se vuelve a consultar antes de este plazo.
const QUOTA_TTL: Duration = Duration::from_secs(300);
/// `force` solo se respeta si el último intento tiene al menos esta edad.
const FORCE_MIN: Duration = Duration::from_secs(15);
/// Margen antes de que caduque el access token.
const TOKEN_MARGIN: Duration = Duration::from_secs(60);
/// D-016: el correo de Outlook llega a Gmail con esta etiqueta.
const OUTLOOK_LABEL: &str = "Outlook";
/// Correos de cada buzón que se muestran (D-038).
const MAIL_ITEMS: usize = 5;
/// Antelación del aviso de evento (D-039).
const EVENT_WINDOW: TimeDelta = TimeDelta::minutes(15);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

// ---------------------------------------------------------------- Tipos para la WebView

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    SignedOut,
    Expired,
    Network,
    Quota,
    Config,
    Other,
}

#[derive(Clone, Debug, Serialize)]
pub struct CloudError {
    pub(crate) kind: ErrorKind,
    pub(crate) message: String,
}

/// Paso que falló (JW-4-05): distingue la renovación del token de la consulta a la API.
const STEP_TOKEN: &str = "renovar token";
const STEP_MAIL: &str = "API de Gmail";
const STEP_AGENDA: &str = "API de Calendar/Tasks";

/// Error de una consulta con el paso en que ocurrió (cadena estática).
type Failure = (&'static str, AuthError);

impl CloudError {
    fn session_lost(&self) -> bool {
        matches!(self.kind, ErrorKind::SignedOut | ErrorKind::Expired)
    }

    /// Tabla de §3. Un 401 aquí ya es el del reintento.
    fn new(step: &'static str, e: &AuthError) -> Self {
        use AuthError as A;
        let kind = match e {
            A::NotLoggedIn(_) => ErrorKind::SignedOut,
            A::TokenRevoked(_) | A::NoRefreshToken(_) | A::Api { status: 401, .. } => ErrorKind::Expired,
            A::Network(_) | A::Api { status: 500..=599, .. } => ErrorKind::Network,
            A::Api { status: 429 | 403, .. } => ErrorKind::Quota,
            A::ConfigMissing | A::ConfigUnreadable(_) | A::ConfigInvalid(_) | A::ProviderNotConfigured(_) => {
                ErrorKind::Config
            }
            _ => ErrorKind::Other,
        };
        let message = match kind {
            ErrorKind::SignedOut => "Conecta tu cuenta de Google en Ajustes.".into(),
            ErrorKind::Expired => "La sesión de Google caducó o se revocó. Vuelve a conectarla en Ajustes.".into(),
            // Solo etiquetas estáticas y el código HTTP: nunca URL, cuerpo ni Display de reqwest.
            ErrorKind::Network => {
                let detail = match e {
                    A::Network(k) => (*k).to_string(),
                    A::Api { status, .. } => format!("HTTP {status}"),
                    _ => String::new(),
                };
                format!("Sin conexión con Google ({step}: {detail}). Se muestran los últimos datos.")
            }
            ErrorKind::Quota => "Google limitó o rechazó la consulta; se reintentará en unos minutos.".into(),
            ErrorKind::Config => r"Falta configurar %APPDATA%\JarWis\oauth-clients.json.".into(),
            // El Display de AuthError ya está saneado (sin tokens, URLs ni cuerpos).
            ErrorKind::Other => e.to_string().chars().take(200).collect(),
        };
        CloudError { kind, message }
    }
}

/// Respuesta de un widget: últimos datos buenos (si los hay) y el último error.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed<T> {
    pub(crate) data: Option<T>,
    pub(crate) error: Option<CloudError>,
    /// ms Unix de la última consulta correcta.
    pub(crate) updated_at: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Gmail,
    Outlook,
}

#[derive(Clone, Debug, Serialize)]
pub struct MailEntry {
    source: Source,
    #[serde(flatten)]
    item: MailItem,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailView {
    inbox_unread: usize,
    inbox_more: bool,
    outlook_unread: usize,
    outlook_more: bool,
    items: Vec<MailEntry>,
    /// Ids no leídos (inbox + Outlook, ≤ 200) para detectar correo nuevo (D-039).
    /// Solo en memoria: nunca llegan a la WebView.
    #[serde(skip)]
    unread_ids: HashSet<String>,
}

/// Los enlaces web de eventos y tareas no se serializan (`#[serde(skip)]` en el crate).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgendaView {
    events: Vec<EventItem>,
    tasks: Vec<TaskItem>,
    pending_tasks: usize,
    tasks_partial: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthEvent {
    title: String,
    start: String,
    all_day: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct MonthTask {
    title: String,
    due: String,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct MonthDay {
    events: Vec<MonthEvent>,
    tasks: Vec<MonthTask>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct MonthView {
    days: BTreeMap<String, MonthDay>,
    partial: bool,
}

struct MonthRange {
    first: NaiveDate,
    after: NaiveDate,
    time_min: String,
    time_max: String,
}

/// Resolver cada límite por separado: un mes puede cambiar de offset por DST.
fn month_range<Tz: TimeZone>(year: i32, month: u32, current_year: i32, tz: &Tz) -> Result<MonthRange, String>
where Tz::Offset: std::fmt::Display {
    if !(current_year - 2..=current_year + 2).contains(&year) || !(1..=12).contains(&month) {
        return Err("Mes no válido: usa 1–12 y un año dentro del actual ±2.".into());
    }
    let first = NaiveDate::from_ymd_opt(year, month, 1).ok_or("Fecha no válida")?;
    let after = if month == 12 { NaiveDate::from_ymd_opt(year + 1, 1, 1) }
        else { NaiveDate::from_ymd_opt(year, month + 1, 1) }.ok_or("Fecha no válida")?;
    let boundary = |date: NaiveDate| -> Result<String, String> {
        // Algunas zonas saltan la medianoche. Usar el primer minuto local válido;
        // ante una hora ambigua elegir la primera ocurrencia.
        for minute in 0..1440 {
            if let Some(local) = date.and_hms_opt(minute / 60, minute % 60, 0)
                .and_then(|d| tz.from_local_datetime(&d).earliest()) {
                return Ok(local.to_rfc3339());
            }
        }
        Err("No se pudo resolver la zona horaria del mes.".into())
    };
    Ok(MonthRange { first, after, time_min: boundary(first)?, time_max: boundary(after)? })
}

fn month_view<Tz: TimeZone>(items: api::MonthItems, range: &MonthRange, tz: &Tz) -> MonthView {
    let mut view = MonthView { partial: items.partial, ..Default::default() };
    let text = |v: &serde_json::Value, key: &str| v.get(key).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let title = |v: &serde_json::Value, key| text(v, key).trim().chars().take(api::MAX_TITLE).collect();
    for event in items.events {
        let start = event.pointer("/start/dateTime").and_then(serde_json::Value::as_str);
        let all_day = start.is_none();
        let start = start.or_else(|| event.pointer("/start/date").and_then(serde_json::Value::as_str)).unwrap_or_default();
        let end = event.pointer(if all_day { "/end/date" } else { "/end/dateTime" }).and_then(serde_json::Value::as_str);
        let dates = if all_day {
            NaiveDate::parse_from_str(start, "%Y-%m-%d").ok().map(|first| {
                let after = end.and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                    .unwrap_or_else(|| first.succ_opt().unwrap_or(first));
                (first, after)
            })
        } else {
            DateTime::parse_from_rfc3339(start).ok().map(|first| {
                // Fin exclusivo: una terminación a las 00:00 no marca ese día.
                let last = end.and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .and_then(|d| d.checked_sub_signed(TimeDelta::nanoseconds(1))).unwrap_or(first);
                (first.with_timezone(tz).date_naive(), last.with_timezone(tz).date_naive().succ_opt().unwrap_or(range.after))
            })
        };
        let Some((first, after)) = dates else { view.partial = true; continue };
        let mut date = first.max(range.first);
        while date < after.min(range.after) {
            view.days.entry(date.to_string()).or_default().events.push(MonthEvent { title: title(&event, "summary"), start: start.into(), all_day });
            let Some(next) = date.succ_opt() else { break };
            date = next;
        }
    }
    let mut count = 0;
    for task in items.tasks {
        let due = text(&task, "due");
        // Tasks guarda fechas civiles, aunque las represente como medianoche Z.
        let date = due.get(..10).and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok());
        let Some(date) = date.filter(|d| *d >= range.first && *d < range.after) else { continue };
        if count == api::MAX_MONTH_ITEMS { view.partial = true; break; }
        count += 1;
        view.days.entry(date.to_string()).or_default().tasks.push(MonthTask { title: title(&task, "title"), due });
    }
    view
}

// ---------------------------------------------------------------- hoy.json (D-048, D-081)

/// Tipos cerrados de exportación: nunca serializar directamente el Feed.
#[derive(Default, Serialize)]
pub struct TodayAgenda {
    updated: String,
    tasks: Vec<TodayTask>,
    events: Vec<TodayEvent>,
}

#[derive(Serialize)]
struct TodayTask {
    title: String,
    due: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TodayEvent {
    title: String,
    start: String,
    all_day: bool,
}

#[derive(Serialize)]
#[serde(untagged)]
enum TodayUnread {
    Count(usize),
    Capped(&'static str),
}

#[derive(Serialize)]
struct TodayMailbox { unread: TodayUnread }

#[derive(Serialize)]
struct TodayMailEntry {
    source: Source,
    from: String,
    subject: String,
}

#[derive(Serialize)]
pub struct TodayMail {
    updated: String,
    gmail: TodayMailbox,
    outlook: TodayMailbox,
    latest: Vec<TodayMailEntry>,
    #[serde(skip)]
    queried_at: SystemTime,
}

#[derive(Default, Serialize)]
struct TodayExport {
    #[serde(flatten)]
    agenda: Option<TodayAgenda>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mail: Option<TodayMail>,
}

pub enum TodayUpdate {
    Agenda(TodayAgenda),
    Mail(TodayMail),
}

fn today_text(value: &str, max: usize) -> String {
    api::clean_text(value, max)
}

impl Feed<AgendaView> {
    pub fn today_update(&self, updated: &str) -> Option<TodayUpdate> {
        let a = self.data.as_ref()?;
        Some(TodayUpdate::Agenda(TodayAgenda {
            updated: updated.into(),
            tasks: a.tasks.iter().map(|t| TodayTask { title: today_text(&t.title, api::MAX_TITLE), due: t.due.clone() }).collect(),
            events: a.events.iter().map(|e| TodayEvent { title: today_text(&e.title, api::MAX_TITLE), start: e.start.clone(), all_day: e.all_day }).collect(),
        }))
    }
}

impl Feed<MailView> {
    pub fn today_update(&self, updated: &str) -> Option<TodayUpdate> {
        let m = self.data.as_ref()?;
        let count = |n: usize, more| TodayMailbox { unread: if more { TodayUnread::Capped("100+") } else { TodayUnread::Count(n.min(100)) } };
        let mut items: Vec<_> = m.items.iter().collect();
        items.sort_by_key(|m| std::cmp::Reverse(m.item.internal_date));
        Some(TodayUpdate::Mail(TodayMail {
            updated: updated.into(),
            queried_at: SystemTime::now(),
            gmail: count(m.inbox_unread, m.inbox_more),
            outlook: count(m.outlook_unread, m.outlook_more),
            latest: items.into_iter().take(MAIL_ITEMS).map(|m| {
                let from = today_text(&m.item.from, usize::MAX);
                // D-038 ya entrega nombres o dominios; defensa ante una dirección accidental.
                let from = if from.contains('@') { api::sender_label(&from) } else { from };
                TodayMailEntry { source: m.source, from: today_text(&from, api::MAX_FROM), subject: today_text(&m.item.subject, api::MAX_TITLE) }
            }).collect(),
        }))
    }
}

/// `%LOCALAPPDATA%\JarWis\hoy.json`; `None` si no existe la variable.
pub fn today_path() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| std::path::PathBuf::from(d).join("JarWis").join("hoy.json"))
}

/// Escritura atómica (temporal + renombrado), como `settings::save`.
pub fn write_today(path: &std::path::Path, json: &str) -> std::io::Result<()> {
    write_today_before_rename(path, json, || {})
}

fn write_today_before_rename(path: &std::path::Path, json: &str, before_rename: impl FnOnce()) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    before_rename();
    std::fs::rename(&tmp, path)
}

/// Serializa escritura y revocación. Una tarea encolada nunca puede recrear un
/// archivo revocado por logout o por apagar el ajuste, aunque se reactive después,
/// ni sobrescribir una exportación posterior de la misma sección y generación.
#[derive(Default)]
pub struct TodayWriter {
    state: Mutex<TodayWriteState>,
    changed: Condvar,
    path: Option<std::path::PathBuf>,
}

#[derive(Default)]
struct TodayWriteState {
    generation: u64,
    sequence: u64,
    agenda_sequence: u64,
    mail_sequence: u64,
    mail_expires: Option<SystemTime>,
    pending_purge: Option<TodayPurge>,
    closed: bool,
    export: TodayExport,
}

struct TodayPurge {
    generation: u64,
    path: std::path::PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TodayTicket {
    generation: u64,
    sequence: u64,
}

impl TodayWriter {
    /// El arranque nunca hereda datos de la sesión anterior; ruta inyectable en tests.
    pub fn new(path: Option<std::path::PathBuf>) -> Self {
        let writer = Self { path, ..Default::default() };
        writer.invalidate(writer.path.as_deref());
        writer
    }

    pub fn ticket(&self) -> TodayTicket {
        let mut state = lock(&self.state);
        state.sequence = state.sequence.saturating_add(1);
        TodayTicket { generation: state.generation, sequence: state.sequence }
    }

    pub fn write(&self, ticket: TodayTicket, path: &std::path::Path, update: TodayUpdate, enabled: bool) -> std::io::Result<()> {
        self.write_using(ticket, path, update, enabled, write_today)
    }

    fn write_using(&self, ticket: TodayTicket, path: &std::path::Path, update: TodayUpdate, enabled: bool,
        write: impl FnOnce(&std::path::Path, &str) -> std::io::Result<()>) -> std::io::Result<()> {
        let mut state = lock(&self.state);
        if state.closed || state.generation != ticket.generation { return Ok(()); }
        if !enabled {
            Self::clear(&mut state, Some(path));
            self.changed.notify_one();
            return Ok(());
        }
        let last = match &update {
            TodayUpdate::Agenda(_) => state.agenda_sequence,
            TodayUpdate::Mail(_) => state.mail_sequence,
        };
        if ticket.sequence <= last || ticket.sequence == u64::MAX {
            return Ok(());
        }
        // Fusionar y escribir bajo un solo bloqueo, incluso si el pool invierte el orden.
        // Un fallo de disco conserva el estado para la siguiente escritura, sin releerlo.
        match update {
            TodayUpdate::Agenda(agenda) => {
                state.export.agenda = Some(agenda);
                state.agenda_sequence = ticket.sequence;
            }
            TodayUpdate::Mail(mail) => {
                state.mail_expires = Some(mail.queried_at.checked_add(TODAY_MAIL_TTL).unwrap_or(mail.queried_at));
                state.export.mail = Some(mail);
                state.mail_sequence = ticket.sequence;
            }
        }
        Self::prune_mail(&mut state, SystemTime::now());
        self.changed.notify_one();
        // Nunca sustituir una exportación mientras quede una purga de su sesión anterior.
        Self::retry_purge(&mut state)?;
        Self::persist(&state, path, write)
    }

    fn persist(state: &TodayWriteState, path: &std::path::Path,
        write: impl FnOnce(&std::path::Path, &str) -> std::io::Result<()>) -> std::io::Result<()> {
        if state.export.agenda.is_none() && state.export.mail.is_none() {
            return Self::remove_files(path);
        }
        write(path, &serde_json::to_string_pretty(&state.export)?)
    }

    fn prune_mail(state: &mut TodayWriteState, now: SystemTime) {
        if state.mail_expires.is_some_and(|deadline| now >= deadline) {
            state.export.mail = None;
        }
    }

    fn expire_mail(state: &mut TodayWriteState, path: &std::path::Path, now: SystemTime) -> std::io::Result<()> {
        Self::retry_purge(state)?;
        if state.mail_expires.is_some_and(|deadline| now >= deadline) {
            Self::prune_mail(state, now);
            Self::persist(state, path, write_today)?;
            state.mail_expires = None;
        }
        Ok(())
    }

    /// Espera hasta la caducidad sin sondeos de UI; toda purga fallida se reintenta en ≤60 s.
    pub fn run_expiry(&self) {
        let Some(path) = self.path.as_deref() else { return };
        let mut state = lock(&self.state);
        loop {
            let now = SystemTime::now();
            let _ = Self::expire_mail(&mut state, path, now);
            if state.closed && state.pending_purge.is_none() { return; }
            state = match (state.pending_purge.is_some(), state.mail_expires) {
                (true, _) => self.changed.wait_timeout(state, Duration::from_secs(1)).unwrap_or_else(|p| p.into_inner()).0,
                // Revisar también tras suspensión o cambios del reloj civil.
                (false, Some(deadline)) => {
                    let delay = deadline.duration_since(now).unwrap_or(Duration::from_secs(1)).min(Duration::from_secs(60));
                    self.changed.wait_timeout(state, delay).unwrap_or_else(|p| p.into_inner()).0
                }
                (false, None) => self.changed.wait(state).unwrap_or_else(|p| p.into_inner()),
            };
        }
    }

    fn session_lost(&self, ticket: TodayTicket) {
        let mut state = lock(&self.state);
        if state.generation == ticket.generation {
            Self::clear(&mut state, self.path.as_deref());
            self.changed.notify_one();
        }
    }

    fn clear(state: &mut TodayWriteState, path: Option<&std::path::Path>) {
        state.generation = state.generation.wrapping_add(1);
        state.export = TodayExport::default();
        state.agenda_sequence = 0;
        state.mail_sequence = 0;
        state.mail_expires = None;
        if let Some(path) = path {
            state.pending_purge = Some(TodayPurge { generation: state.generation, path: path.into() });
        } else if let Some(purge) = &mut state.pending_purge {
            purge.generation = state.generation;
        }
        let _ = Self::retry_purge(state);
    }

    fn remove_files(path: &std::path::Path) -> std::io::Result<()> {
        let mut error = None;
        // Intentar ambos aunque uno esté bloqueado; NotFound ya cumple la purga.
        for file in [path.with_extension("json.tmp"), path.to_path_buf()] {
            if let Err(e) = std::fs::remove_file(file) {
                if e.kind() != std::io::ErrorKind::NotFound { error.get_or_insert(e); }
            }
        }
        error.map_or(Ok(()), Err)
    }

    fn retry_purge(state: &mut TodayWriteState) -> std::io::Result<()> {
        if let Some(purge) = &state.pending_purge {
            // El mutex cubre borrado y escritura: ninguna purga antigua toca una sesión nueva.
            if purge.generation == state.generation { Self::remove_files(&purge.path)?; }
            state.pending_purge = None;
        }
        Ok(())
    }

    pub fn invalidate(&self, path: Option<&std::path::Path>) {
        let mut state = lock(&self.state);
        Self::clear(&mut state, path);
        self.changed.notify_one();
    }

    /// Salida limpia: revocar trabajos y drenar bloqueos transitorios durante hasta 2 s.
    /// Si el bloqueo persiste al terminar el proceso, el arranque purga antes de exportar.
    pub fn shutdown(&self) {
        let mut state = lock(&self.state);
        state.closed = true;
        Self::clear(&mut state, self.path.as_deref());
        self.changed.notify_one();
        for _ in 0..40 {
            if state.pending_purge.is_none() { break; }
            state = self.changed.wait_timeout(state, Duration::from_millis(50)).unwrap_or_else(|p| p.into_inner()).0;
            let _ = Self::retry_purge(&mut state);
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenKind {
    Mail,
    Event,
    Task,
}

// ---------------------------------------------------------------- Caché

/// Libera la marca al salir (también si la tarea se cancela).
pub struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn try_busy(flag: &AtomicBool) -> Option<BusyGuard<'_>> {
    (!flag.swap(true, Ordering::SeqCst)).then_some(BusyGuard(flag))
}

struct Cached<T> {
    data: Option<T>,
    error: Option<CloudError>,
    attempt: Instant,
    updated_ms: Option<u64>,
}

struct Slot<T> {
    cache: Mutex<Option<Cached<T>>>,
    busy: AtomicBool,
    /// Sube con cada `clear`: una consulta que empezó antes no rellena la caché.
    generation: AtomicU64,
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Slot { cache: Mutex::new(None), busy: AtomicBool::new(false), generation: AtomicU64::new(0) }
    }
}

impl<T: Clone> Slot<T> {
    fn feed(&self) -> Feed<T> {
        match &*lock(&self.cache) {
            Some(c) => Feed { data: c.data.clone(), error: c.error.clone(), updated_at: c.updated_ms },
            None => Feed { data: None, error: None, updated_at: None },
        }
    }

    /// Si toca consultar, marca la consulta en curso y devuelve su generación.
    /// `None`: la caché sigue fresca o ya hay otra consulta (se responde con la caché).
    fn begin(&self, force: bool, ttl: Duration, now: Instant) -> Option<(BusyGuard<'_>, u64)> {
        let stale = match &*lock(&self.cache) {
            None => true,
            Some(c) => {
                let age = now.saturating_duration_since(c.attempt);
                let quota = c.error.as_ref().is_some_and(|e| e.kind == ErrorKind::Quota);
                age >= if quota { QUOTA_TTL.max(ttl) } else { ttl } || (force && age >= FORCE_MIN)
            }
        };
        if !stale {
            return None;
        }
        let guard = try_busy(&self.busy)?;
        Some((guard, self.generation.load(Ordering::SeqCst)))
    }

    /// Guarda el resultado. Con error se conservan los datos anteriores, salvo si
    /// ya no hay sesión válida (`signedOut`, `expired`).
    fn finish(&self, generation: u64, res: Result<T, CloudError>, now: Instant, now_ms: u64) {
        let mut cache = lock(&self.cache);
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        *cache = Some(match res {
            Ok(data) => Cached { data: Some(data), error: None, attempt: now, updated_ms: Some(now_ms) },
            Err(e) => {
                let keep = !matches!(e.kind, ErrorKind::SignedOut | ErrorKind::Expired);
                let (data, updated_ms) = match cache.take() {
                    Some(old) if keep => (old.data, old.updated_ms),
                    _ => (None, None),
                };
                Cached { data, error: Some(e), attempt: now, updated_ms }
            }
        });
    }

    fn clear(&self) {
        let mut cache = lock(&self.cache);
        self.generation.fetch_add(1, Ordering::SeqCst);
        *cache = None;
    }
}

// ---------------------------------------------------------------- Avisos (D-039)

/// Qué se ha avisado ya. `mail: None` = aún sin referencia (arranque, login o `reset`).
#[derive(Default)]
struct Notified {
    mail: Option<HashSet<String>>,
    events: HashSet<String>,
}

/// Correos no leídos que no estaban en la referencia. Sin referencia: 0 (solo se fija).
pub fn new_mail_count(prev: Option<&HashSet<String>>, cur: &HashSet<String>) -> usize {
    prev.map_or(0, |p| cur.difference(p).count())
}

/// Eventos con hora (no `allDay`) que empiezan en (ahora, ahora + `window`] y aún no
/// avisados: `(id, "HH:MM")` con la hora en la zona de `now`.
pub fn due_events<Tz: TimeZone>(
    events: &[EventItem],
    now: &DateTime<Tz>,
    window: TimeDelta,
    notified: &HashSet<String>,
) -> Vec<(String, String)>
where
    Tz::Offset: std::fmt::Display,
{
    let Some(limit) = now.clone().checked_add_signed(window) else { return Vec::new() };
    events
        .iter()
        .filter(|e| !e.all_day && !notified.contains(&e.id))
        .filter_map(|e| {
            let start = DateTime::parse_from_rfc3339(&e.start).ok()?.with_timezone(&now.timezone());
            (start > *now && start <= limit).then(|| (e.id.clone(), start.format("%H:%M").to_string()))
        })
        .collect()
}

/// Cuerpo del aviso de correo: solo el conteo (nunca remitente, asunto ni cuenta).
pub fn mail_body(n: usize) -> String {
    if n == 1 {
        "1 correo nuevo".into()
    } else {
        format!("{n} correos nuevos")
    }
}

/// Cuerpo del aviso de evento: solo la hora (nunca el título).
pub fn event_body(hhmm: &str) -> String {
    format!("Evento a las {hhmm}")
}

// ---------------------------------------------------------------- Estado

const MONTH_CACHE_LIMIT: usize = 4;

#[derive(Default)]
struct MonthCache(VecDeque<MonthEntry>);

struct MonthEntry {
    key: (i32, u32),
    slot: Arc<Slot<MonthView>>,
}

impl MonthCache {
    fn slot(&mut self, key: (i32, u32)) -> Arc<Slot<MonthView>> {
        if let Some(index) = self.0.iter().position(|entry| entry.key == key) {
            if let Some(entry) = self.0.remove(index) {
                let slot = entry.slot.clone();
                self.0.push_back(entry);
                return slot;
            }
        }
        if self.0.len() >= MONTH_CACHE_LIMIT {
            if let Some(entry) = self.0.pop_front() { entry.slot.clear(); }
        }
        let slot = Arc::new(Slot::default());
        self.0.push_back(MonthEntry { key, slot: slot.clone() });
        slot
    }

    fn clear(&mut self) {
        for entry in self.0.drain(..) { entry.slot.clear(); }
    }
}

#[derive(Default)]
pub struct Cloud {
    pub today_writer: TodayWriter,
    /// Un solo cliente HTTP (TLS) reutilizado; se crea en la primera consulta.
    http: Mutex<Option<HttpClient>>,
    /// Access token en memoria hasta poco antes de caducar.
    token: Mutex<Option<(AccessToken, Instant)>>,
    /// Sube en cada `reset`: una renovación iniciada antes no guarda su token.
    token_gen: AtomicU64,
    mail: Slot<MailView>,
    agenda: Slot<AgendaView>,
    months: Mutex<MonthCache>,
    login_busy: AtomicBool,
    notified: Mutex<Notified>,
}

impl Cloud {
    pub fn new(today_path: Option<std::path::PathBuf>) -> Self {
        Self { today_writer: TodayWriter::new(today_path), ..Default::default() }
    }

    /// Bajo demanda; no exporta datos mensuales. Un error de sesión revoca hoy.json.
    pub async fn month(&self, year: i32, month: u32, force: bool) -> Result<Feed<MonthView>, String> {
        let ticket = self.today_writer.ticket();
        let range = month_range(year, month, Local::now().year(), &Local)?;
        let slot = lock(&self.months).slot((year, month));
        if self.login_in_progress() { return Ok(slot.feed()); }
        if let Some((_busy, generation)) = slot.begin(force, AGENDA_TTL, Instant::now()) {
            let res = self.call(STEP_AGENDA, |http, token| {
                let range = &range;
                async move {
                    let due_min = format!("{}T00:00:00Z", range.first);
                    let due_max = format!("{}T00:00:00Z", range.after);
                    let items = api::month_items(&http, &token, &range.time_min, &range.time_max, &due_min, &due_max).await?;
                    Ok(month_view(items, range, &Local))
                }
            }).await;
            self.finish(&slot, generation, res, ticket);
        }
        Ok(slot.feed())
    }

    /// Correo y si esta llamada lo consultó con éxito (para exportar, D-081).
    pub async fn mail(&self, force: bool) -> (Feed<MailView>, bool) {
        let ticket = self.today_writer.ticket();
        if self.login_in_progress() { return (self.mail.feed(), false); }
        let mut fresh = false;
        if let Some((_busy, generation)) = self.mail.begin(force, MAIL_TTL, Instant::now()) {
            let res = self.call(STEP_MAIL, fetch_mail).await;
            fresh = res.is_ok();
            self.finish(&self.mail, generation, res, ticket);
        }
        (self.mail.feed(), fresh)
    }

    /// Agenda y si esta llamada la consultó con éxito (para exportar `hoy.json`, D-048).
    pub async fn agenda(&self, force: bool) -> (Feed<AgendaView>, bool) {
        let ticket = self.today_writer.ticket();
        if self.login_in_progress() { return (self.agenda.feed(), false); }
        let mut fresh = false;
        if let Some((_busy, generation)) = self.agenda.begin(force, AGENDA_TTL, Instant::now()) {
            let res = self.call(STEP_AGENDA, fetch_agenda).await;
            fresh = res.is_ok();
            self.finish(&self.agenda, generation, res, ticket);
        }
        (self.agenda.feed(), fresh)
    }

    fn finish<T: Clone>(&self, slot: &Slot<T>, generation: u64, res: Result<T, Failure>, ticket: TodayTicket) {
        let res = res.map_err(|(step, e)| CloudError::new(step, &e));
        if res.as_ref().is_err_and(|e| e.session_lost()) {
            self.today_writer.session_lost(ticket);
        }
        match &res {
            Err(e) if e.kind == ErrorKind::Expired => *lock(&self.token) = None,
            // JW-4-05 (mitigación): ante un fallo de red el siguiente intento usa un
            // cliente nuevo (pool, DNS y TLS limpios) en vez de arrastrar su estado.
            Err(e) if e.kind == ErrorKind::Network => *lock(&self.http) = None,
            _ => {}
        }
        slot.finish(generation, res, Instant::now(), now_ms());
    }

    /// Ejecuta una consulta con el token en caché; ante un 401 lo renueva y reintenta una vez.
    async fn call<T, Fut>(&self, step: &'static str, f: impl Fn(HttpClient, AccessToken) -> Fut) -> Result<T, Failure>
    where
        Fut: Future<Output = jarwis_auth::Result<T>>,
    {
        let http = self.http().map_err(|e| (step, e))?;
        let token = self.token().await.map_err(|e| (STEP_TOKEN, e))?;
        match f(http.clone(), token).await {
            Err(AuthError::Api { status: 401, .. }) => {
                *lock(&self.token) = None;
                let token = self.token().await.map_err(|e| (STEP_TOKEN, e))?;
                f(http, token).await.map_err(|e| (step, e))
            }
            other => other.map_err(|e| (step, e)),
        }
    }

    fn http(&self) -> Result<HttpClient, AuthError> {
        let mut slot = lock(&self.http);
        if let Some(c) = &*slot {
            return Ok(c.clone());
        }
        let c = jarwis_auth::http_client()?;
        *slot = Some(c.clone());
        Ok(c)
    }

    async fn token(&self) -> Result<AccessToken, AuthError> {
        let cached = lock(&self.token).clone();
        if let Some((t, until)) = cached {
            if Instant::now() < until {
                return Ok(t);
            }
        }
        let generation = self.token_gen.load(Ordering::SeqCst);
        let cfg = jarwis_auth::load_config()?;
        let (t, expires_in) = jarwis_auth::refresh_access(Provider::Google, &cfg).await?;
        let valid = expires_in.unwrap_or(Duration::from_secs(300)).saturating_sub(TOKEN_MARGIN);
        // `checked_add` y tope de 1 h: un `expires_in` aberrante no puede abortar la app (D-024).
        let until = Instant::now().checked_add(valid.min(Duration::from_secs(3600)));
        let mut slot = lock(&self.token);
        if let (Some(until), true) = (until, self.token_gen.load(Ordering::SeqCst) == generation) {
            *slot = Some((t.clone(), until));
        }
        Ok(t)
    }

    /// Correos nuevos desde la consulta anterior según la caché, y fija la nueva
    /// referencia (también con los avisos apagados). Sin datos: no cambia nada.
    pub fn take_new_mail(&self) -> usize {
        let cur = {
            let cache = lock(&self.mail.cache);
            match cache.as_ref().and_then(|c| c.data.as_ref()) {
                Some(d) => d.unread_ids.clone(),
                None => return 0,
            }
        };
        let mut n = lock(&self.notified);
        let count = new_mail_count(n.mail.as_ref(), &cur);
        n.mail = Some(cur);
        count
    }

    /// Cuerpos de los avisos de eventos próximos aún no avisados; los marca como
    /// avisados y olvida los que ya no están en la caché.
    pub fn take_due_events<Tz: TimeZone>(&self, now: &DateTime<Tz>) -> Vec<String>
    where
        Tz::Offset: std::fmt::Display,
    {
        let events = {
            let cache = lock(&self.agenda.cache);
            cache.as_ref().and_then(|c| c.data.as_ref()).map(|d| d.events.clone()).unwrap_or_default()
        };
        let mut n = lock(&self.notified);
        n.events.retain(|id| events.iter().any(|e| &e.id == id));
        let due = due_events(&events, now, EVENT_WINDOW, &n.events);
        due.into_iter()
            .map(|(id, hhmm)| {
                n.events.insert(id);
                event_body(&hhmm)
            })
            .collect()
    }

    /// Borra token y cachés (login, logout).
    pub fn reset(&self) {
        let mut slot = lock(&self.token);
        self.token_gen.fetch_add(1, Ordering::SeqCst);
        *slot = None;
        drop(slot);
        self.mail.clear();
        self.agenda.clear();
        lock(&self.months).clear();
        *lock(&self.notified) = Notified::default();
        self.today_writer.invalidate(self.today_writer.path.as_deref());
    }

    /// Marca de login en curso; `None` si ya hay uno.
    pub fn begin_login(&self) -> Option<BusyGuard<'_>> {
        let guard = try_busy(&self.login_busy)?;
        self.reset();
        Some(guard)
    }

    pub fn login_in_progress(&self) -> bool {
        self.login_busy.load(Ordering::SeqCst)
    }

    /// URL que abre un elemento que esté en la caché. La WebView solo manda `kind` e `id`.
    pub fn link(&self, kind: OpenKind, id: &str) -> Result<String, String> {
        if !api::valid_id(id) {
            return Err("Identificador no válido".into());
        }
        let missing = || "El elemento ya no está en la lista".to_string();
        let link = match kind {
            OpenKind::Mail => {
                let cache = lock(&self.mail.cache);
                let data = cache.as_ref().and_then(|c| c.data.as_ref());
                if !data.is_some_and(|d| d.items.iter().any(|m| m.item.id == id)) {
                    return Err(missing());
                }
                // D-038: mejor esfuerzo; `/u/0` es la primera cuenta abierta en el navegador.
                return Ok(format!("https://mail.google.com/mail/u/0/#all/{id}"));
            }
            OpenKind::Event => {
                let cache = lock(&self.agenda.cache);
                let data = cache.as_ref().and_then(|c| c.data.as_ref()).ok_or_else(missing)?;
                data.events.iter().find(|e| e.id == id).ok_or_else(missing)?.html_link.clone()
            }
            OpenKind::Task => {
                let cache = lock(&self.agenda.cache);
                let data = cache.as_ref().and_then(|c| c.data.as_ref()).ok_or_else(missing)?;
                data.tasks.iter().find(|t| t.id == id).ok_or_else(missing)?.web_view_link.clone()
            }
        };
        link.as_deref().and_then(api::safe_link).ok_or_else(|| "Google no dio un enlace que se pueda abrir".into())
    }
}

// ---------------------------------------------------------------- Consultas

async fn fetch_mail(http: HttpClient, token: AccessToken) -> jarwis_auth::Result<MailView> {
    let inbox_q = format!("is:unread in:inbox category:primary -label:{OUTLOOK_LABEL}");
    let outlook_q = format!("is:unread label:{OUTLOOK_LABEL}");
    let inbox = fetch_mailbox(&http, &token, &inbox_q).await;
    let outlook = fetch_mailbox(&http, &token, &outlook_q).await;
    merge_mailboxes(inbox, outlook)
}

type MailboxResult = jarwis_auth::Result<(Vec<String>, bool, Vec<MailItem>)>;

async fn fetch_mailbox(http: &HttpClient, token: &AccessToken, query: &str) -> MailboxResult {
    let (ids, more) = api::gmail_unread_ids(http, token, query).await?;
    let mut items = Vec::new();
    for id in ids.iter().take(MAIL_ITEMS) {
        if let Some(item) = api::gmail_message(http, token, id).await? { items.push(item); }
    }
    Ok((ids, more, items))
}

/// La consulta completa falla si falla cualquiera de los buzones: no inventar ceros.
fn merge_mailboxes(inbox: MailboxResult, outlook: MailboxResult) -> jarwis_auth::Result<MailView> {
    // Un fallo de red de Principal no debe ocultar una revocación en Outlook.
    let outlook = match outlook {
        Err(e) if CloudError::new(STEP_MAIL, &e).session_lost() => return Err(e),
        other => other,
    };
    let (inbox, inbox_more, gmail_items) = inbox?;
    let (outlook, outlook_more, outlook_items) = outlook?;
    let mut items: Vec<_> = [(Source::Gmail, gmail_items), (Source::Outlook, outlook_items)].into_iter()
        .flat_map(|(source, items)| items.into_iter().map(move |item| MailEntry { source, item })).collect();
    items.sort_by_key(|m| std::cmp::Reverse(m.item.internal_date));
    let (inbox_unread, outlook_unread) = (inbox.len(), outlook.len());
    let unread_ids = inbox.into_iter().chain(outlook).collect();
    Ok(MailView { inbox_unread, inbox_more, outlook_unread, outlook_more, items, unread_ids })
}

async fn fetch_agenda(http: HttpClient, token: AccessToken) -> jarwis_auth::Result<AgendaView> {
    let events = api::calendar_events(&http, &token).await?;
    let tasks = api::pending_tasks(&http, &token).await?;
    Ok(AgendaView { events, pending_tasks: tasks.total, tasks_partial: tasks.partial, tasks: tasks.tasks })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Zona ficticia con las transiciones de Nueva York de 2026, independiente de
    // la zona del PC y sin dependencias/red. Verifica ambos límites con DST.
    #[derive(Clone)]
    struct TestDst;
    impl TimeZone for TestDst {
        type Offset = chrono::FixedOffset;
        fn from_offset(_: &Self::Offset) -> Self { Self }
        fn offset_from_local_date(&self, date: &NaiveDate) -> chrono::LocalResult<Self::Offset> {
            self.offset_from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
        }
        fn offset_from_local_datetime(&self, dt: &chrono::NaiveDateTime) -> chrono::LocalResult<Self::Offset> {
            let dst = *dt >= NaiveDate::from_ymd_opt(2026, 3, 8).unwrap().and_hms_opt(2, 0, 0).unwrap()
                && *dt < NaiveDate::from_ymd_opt(2026, 11, 1).unwrap().and_hms_opt(2, 0, 0).unwrap();
            chrono::LocalResult::Single(chrono::FixedOffset::west_opt(if dst { 4 * 3600 } else { 5 * 3600 }).unwrap())
        }
        fn offset_from_utc_date(&self, date: &NaiveDate) -> Self::Offset {
            self.offset_from_utc_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
        }
        fn offset_from_utc_datetime(&self, dt: &chrono::NaiveDateTime) -> Self::Offset {
            let dst = *dt >= NaiveDate::from_ymd_opt(2026, 3, 8).unwrap().and_hms_opt(7, 0, 0).unwrap()
                && *dt < NaiveDate::from_ymd_opt(2026, 11, 1).unwrap().and_hms_opt(6, 0, 0).unwrap();
            chrono::FixedOffset::west_opt(if dst { 4 * 3600 } else { 5 * 3600 }).unwrap()
        }
    }

    #[test]
    fn month_ranges_validate_and_resolve_dst_and_year_boundaries() {
        for (month, min, max) in [(3, "2026-03-01T00:00:00-05:00", "2026-04-01T00:00:00-04:00"),
            (11, "2026-11-01T00:00:00-04:00", "2026-12-01T00:00:00-05:00"),
            (12, "2026-12-01T00:00:00-05:00", "2027-01-01T00:00:00-05:00")] {
            let range = month_range(2026, month, 2026, &TestDst).unwrap();
            assert_eq!((range.time_min.as_str(), range.time_max.as_str()), (min, max));
        }
        let leap = month_range(2024, 2, 2026, &chrono::Utc).unwrap();
        assert_eq!((leap.after - leap.first).num_days(), 29);
        for (year, month) in [(2023, 1), (2029, 1), (2026, 0), (2026, 13), (i32::MIN, 1), (i32::MAX, 1)] {
            assert!(month_range(year, month, 2026, &chrono::Utc).is_err());
        }
        for year in [2024, 2028] { assert!(month_range(year, 1, 2026, &chrono::Utc).is_ok()); }
    }

    #[test]
    fn month_days_include_overlaps_exclusive_ends_local_hours_and_task_dates() {
        use serde_json::json;
        let range = month_range(2026, 3, 2026, &TestDst).unwrap();
        let view = month_view(api::MonthItems {
            events: vec![
                json!({"summary": "Mes anterior", "start": {"date": "2026-02-28"}, "end": {"date": "2026-03-02"}}),
                json!({"summary": "DST", "start": {"dateTime": "2026-03-08T04:30:00Z"}, "end": {"dateTime": "2026-03-09T04:00:00Z"}}),
                json!({"summary": "Siguiente", "start": {"date": "2026-03-31"}, "end": {"date": "2026-04-03"}}),
                json!({"summary": "Fuera", "start": {"date": "2026-04-01"}, "end": {"date": "2026-04-02"}}),
            ],
            tasks: vec![json!({"title": "Fecha civil", "due": "2026-03-01T00:00:00Z", "id": "secret", "notes": "private"}),
                json!({"due": "2026-02-28T00:00:00Z"}), json!({"due": "2026-04-01T00:00:00Z"}), json!({"title": "Sin fecha"})],
            partial: false,
        }, &range, &TestDst);
        assert_eq!(view.days.keys().cloned().collect::<Vec<_>>(), ["2026-03-01", "2026-03-07", "2026-03-08", "2026-03-31"]);
        assert_eq!(view.days["2026-03-01"].tasks.len(), 1);
        assert!(view.days["2026-03-01"].events[0].all_day);
        assert!(!view.days["2026-03-08"].events[0].all_day);
        let out = serde_json::to_string(&view).unwrap();
        assert!(!out.contains("secret") && !out.contains("private") && !out.contains("\"end\""));
        assert!(!view.partial);
    }

    #[test]
    fn month_task_cap_and_source_partial_survive_grouping() {
        let range = month_range(2026, 10, 2026, &chrono::Utc).unwrap();
        let view = month_view(api::MonthItems { events: vec![], tasks: vec![serde_json::json!({"title": "x", "due": "2026-10-01T00:00:00Z"}); api::MAX_MONTH_ITEMS + 1], partial: false }, &range, &chrono::Utc);
        assert!(view.partial);
        assert_eq!(view.days["2026-10-01"].tasks.len(), api::MAX_MONTH_ITEMS);
        assert!(month_view(api::MonthItems { events: vec![], tasks: vec![], partial: true }, &range, &chrono::Utc).partial);
    }

    #[test]
    fn month_cache_hits_expires_bounds_and_reset_discards_inflight() {
        let cloud = Cloud::default();
        let slot = lock(&cloud.months).slot((2026, 1));
        let now = Instant::now();
        let (guard, generation) = slot.begin(false, AGENDA_TTL, now).unwrap();
        slot.finish(generation, Ok(MonthView::default()), now, 1);
        drop(guard);
        assert!(Arc::ptr_eq(&slot, &lock(&cloud.months).slot((2026, 1))));
        assert!(slot.begin(false, AGENDA_TTL, now + AGENDA_TTL - Duration::from_secs(1)).is_none());
        assert!(slot.begin(false, AGENDA_TTL, now + AGENDA_TTL).is_some());
        for month in 2..=4 { lock(&cloud.months).slot((2026, month)); }
        lock(&cloud.months).slot((2026, 1)); // LRU conserva enero, expulsa febrero.
        lock(&cloud.months).slot((2026, 5));
        assert_eq!(lock(&cloud.months).0.len(), MONTH_CACHE_LIMIT);
        assert!(!lock(&cloud.months).0.iter().any(|e| e.key == (2026, 2)));
        assert!(slot.feed().data.is_some());
        cloud.reset();
        slot.finish(generation, Ok(MonthView::default()), now, 2);
        assert!(slot.feed().data.is_none());
        assert!(lock(&cloud.months).0.is_empty());
        assert!(!Arc::ptr_eq(&slot, &lock(&cloud.months).slot((2026, 1))));
    }

    #[test]
    fn month_cached_error_retries_only_when_forced() {
        let slot = lock(&Cloud::default().months).slot((2026, 1));
        let now = Instant::now();
        let (guard, generation) = slot.begin(false, AGENDA_TTL, now).unwrap();
        slot.finish(generation, Err(err(AuthError::Api { endpoint: "x", status: 500 })), now, 1);
        drop(guard);
        assert!(slot.begin(false, AGENDA_TTL, now + FORCE_MIN).is_none());
        assert!(slot.begin(true, AGENDA_TTL, now + FORCE_MIN).is_some());
    }

    fn err(e: AuthError) -> CloudError {
        CloudError::new("x", &e)
    }

    #[test]
    fn maps_errors_to_kinds() {
        let api = |status| AuthError::Api { endpoint: "x", status };
        let cases = [
            (AuthError::NotLoggedIn(Provider::Google), ErrorKind::SignedOut),
            (AuthError::TokenRevoked(Provider::Google), ErrorKind::Expired),
            (AuthError::NoRefreshToken(Provider::Google), ErrorKind::Expired),
            (api(401), ErrorKind::Expired),
            (AuthError::Network("x"), ErrorKind::Network),
            (api(503), ErrorKind::Network),
            (api(429), ErrorKind::Quota),
            (api(403), ErrorKind::Quota),
            (AuthError::ConfigMissing, ErrorKind::Config),
            (AuthError::ConfigInvalid("x".into()), ErrorKind::Config),
            (AuthError::ProviderNotConfigured(Provider::Google), ErrorKind::Config),
            (api(404), ErrorKind::Other),
            (AuthError::BadResponse("x"), ErrorKind::Other),
        ];
        for (e, kind) in cases {
            assert_eq!(err(e).kind, kind);
        }
        assert!(err(AuthError::ConfigMissing).message.contains(r"%APPDATA%\JarWis\oauth-clients.json"));
    }

    #[test]
    fn ttl_and_force() {
        let slot = Slot::<u32>::default();
        let t0 = Instant::now();
        let (g, generation) = slot.begin(false, MAIL_TTL, t0).unwrap();
        slot.finish(generation, Ok(1), t0, 10);
        drop(g);
        assert!(slot.begin(false, MAIL_TTL, t0 + Duration::from_secs(59)).is_none(), "fresca");
        assert!(slot.begin(true, MAIL_TTL, t0 + Duration::from_secs(14)).is_none(), "force < 15 s");
        assert!(slot.begin(true, MAIL_TTL, t0 + Duration::from_secs(15)).is_some(), "force ≥ 15 s");
        assert!(slot.begin(false, MAIL_TTL, t0 + Duration::from_secs(60)).is_some(), "TTL vencido");
    }

    #[test]
    fn quota_waits_longer() {
        let slot = Slot::<u32>::default();
        let t0 = Instant::now();
        let (_g, generation) = slot.begin(false, MAIL_TTL, t0).unwrap();
        slot.finish(generation, Err(err(AuthError::Api { endpoint: "x", status: 429 })), t0, 0);
        drop(_g);
        assert!(slot.begin(false, MAIL_TTL, t0 + Duration::from_secs(120)).is_none());
        assert!(slot.begin(false, MAIL_TTL, t0 + QUOTA_TTL).is_some());
    }

    #[test]
    fn busy_returns_cache_and_guard_releases() {
        let slot = Slot::<u32>::default();
        let t0 = Instant::now();
        let first = slot.begin(false, MAIL_TTL, t0);
        assert!(first.is_some());
        assert!(slot.begin(true, MAIL_TTL, t0 + Duration::from_secs(600)).is_none(), "otra en curso");
        drop(first);
        assert!(slot.begin(false, MAIL_TTL, t0).is_some(), "guard liberado");
    }

    // Criterio 7: sin red, el error real de reqwest (puerto cerrado) se convierte en
    // `network` y se conservan los datos anteriores con su fecha.
    #[test]
    fn offline_keeps_previous_data() {
        let slot = Slot::<u32>::default();
        let t0 = Instant::now();
        let (g, generation) = slot.begin(false, MAIL_TTL, t0).unwrap();
        slot.finish(generation, Ok(7), t0, 1234);
        drop(g);

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let url = format!("http://127.0.0.1:{port}/");
        let raw = tauri::async_runtime::block_on(async { jarwis_auth::http_client().unwrap().get(url).send().await })
            .unwrap_err();
        let e = err(AuthError::from(raw));
        assert_eq!(e.kind, ErrorKind::Network);

        let t1 = t0 + MAIL_TTL;
        let (g, generation) = slot.begin(false, MAIL_TTL, t1).unwrap();
        slot.finish(generation, Err(e), t1, 9999);
        drop(g);
        let feed = slot.feed();
        assert_eq!((feed.data, feed.updated_at), (Some(7), Some(1234)));
        assert_eq!(feed.error.map(|e| e.kind), Some(ErrorKind::Network));
    }

    // JW-4-05: el mensaje dice el paso y la causa (estáticos) y un fallo de red
    // descarta el cliente HTTP compartido; otros errores no.
    #[test]
    fn network_message_has_step_and_resets_client() {
        let e = CloudError::new(STEP_TOKEN, &AuthError::Network("tiempo de espera agotado"));
        assert_eq!(
            e.message,
            "Sin conexión con Google (renovar token: tiempo de espera agotado). Se muestran los últimos datos."
        );
        let e = CloudError::new(STEP_AGENDA, &AuthError::Api { endpoint: "Calendar events.list", status: 503 });
        assert!(e.message.contains("(API de Calendar/Tasks: HTTP 503)"), "{}", e.message);
        assert!(!e.message.contains("events.list"));

        let cloud = Cloud::default();
        cloud.http().unwrap();
        cloud.finish(&cloud.mail, 0, Err((STEP_MAIL, AuthError::Api { endpoint: "x", status: 404 })), cloud.today_writer.ticket());
        assert!(lock(&cloud.http).is_some(), "un 404 no es de red");
        cloud.finish(&cloud.mail, 0, Err((STEP_MAIL, AuthError::Network("conexión rechazada"))), cloud.today_writer.ticket());
        assert!(lock(&cloud.http).is_none(), "fallo de red → cliente nuevo");
        let feed = cloud.mail.feed();
        assert!(feed.error.unwrap().message.contains("(API de Gmail: conexión rechazada)"));
    }

    #[test]
    fn expired_drops_data_and_clear_discards_inflight() {
        let slot = Slot::<u32>::default();
        let t0 = Instant::now();
        slot.finish(0, Ok(1), t0, 1);
        slot.finish(0, Err(err(AuthError::TokenRevoked(Provider::Google))), t0, 2);
        let feed = slot.feed();
        assert_eq!((feed.data, feed.updated_at), (None, None));
        // Una consulta empezada antes de `clear` (logout) no rellena la caché.
        let (_g, generation) = slot.begin(true, MAIL_TTL, t0 + MAIL_TTL).unwrap();
        slot.clear();
        slot.finish(generation, Ok(5), t0, 3);
        assert!(slot.feed().data.is_none());
    }

    #[test]
    fn link_validates_and_requires_cache() {
        let cloud = Cloud::default();
        for bad in ["", "a/b", "a?b", "a#b", "..", "javascript:x"] {
            assert!(cloud.link(OpenKind::Mail, bad).is_err());
        }
        assert!(cloud.link(OpenKind::Mail, "abc").is_err(), "sin caché");
        let item = MailItem { id: "abc".into(), from: "x".into(), subject: "y".into(), internal_date: None };
        let view = MailView { items: vec![MailEntry { source: Source::Gmail, item }], ..Default::default() };
        cloud.mail.finish(0, Ok(view), Instant::now(), 1);
        assert_eq!(cloud.link(OpenKind::Mail, "abc").unwrap(), "https://mail.google.com/mail/u/0/#all/abc");
        assert!(cloud.link(OpenKind::Mail, "abd").is_err(), "desconocido");

        let ev = |id: &str, link: &str| EventItem {
            id: id.into(),
            title: String::new(),
            start: String::new(),
            all_day: false,
            html_link: Some(link.into()),
        };
        let agenda = AgendaView {
            events: vec![ev("e1", "https://www.google.com/calendar/event?eid=1"), ev("e2", "https://evil.example.com/")],
            tasks: vec![TaskItem { id: "t1".into(), title: String::new(), due: None, web_view_link: None }],
            pending_tasks: 1,
            tasks_partial: false,
        };
        cloud.agenda.finish(0, Ok(agenda), Instant::now(), 1);
        assert!(cloud.link(OpenKind::Event, "e1").unwrap().starts_with("https://www.google.com/"));
        assert!(cloud.link(OpenKind::Event, "e2").is_err(), "host no permitido");
        assert!(cloud.link(OpenKind::Task, "t1").is_err(), "sin enlace");
        assert!(cloud.link(OpenKind::Task, "e1").is_err(), "otro tipo");
        cloud.reset();
        assert!(cloud.link(OpenKind::Event, "e1").is_err(), "tras logout");
    }

    fn ids(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn event(id: &str, title: &str, start: &str, all_day: bool) -> EventItem {
        EventItem { id: id.into(), title: title.into(), start: start.into(), all_day, html_link: None }
    }

    #[test]
    fn new_mail_counts() {
        assert_eq!(new_mail_count(None, &ids(&["a", "b"])), 0, "primera consulta: solo referencia");
        let prev = ids(&["a", "b"]);
        assert_eq!(new_mail_count(Some(&prev), &ids(&["a", "b"])), 0, "sin cambios");
        assert_eq!(new_mail_count(Some(&prev), &ids(&["a", "b", "c", "d"])), 2, "+2");
        assert_eq!(new_mail_count(Some(&prev), &ids(&["a"])), 0, "solo leídos");
        assert_eq!(new_mail_count(Some(&prev), &ids(&["a", "x"])), 1, "uno leído y uno nuevo");
    }

    #[test]
    fn take_new_mail_sets_reference_and_reset_clears_it() {
        let cloud = Cloud::default();
        let set = |list: &[&str]| {
            let view = MailView { unread_ids: ids(list), ..Default::default() };
            cloud.mail.finish(0, Ok(view), Instant::now(), 1);
        };
        assert_eq!(cloud.take_new_mail(), 0, "sin caché");
        set(&["a"]);
        assert_eq!(cloud.take_new_mail(), 0, "primera: referencia");
        set(&["a", "b", "c"]);
        assert_eq!(cloud.take_new_mail(), 2);
        assert_eq!(cloud.take_new_mail(), 0, "misma caché: no se repite");
        cloud.reset();
        set(&["a", "b", "c", "d"]);
        assert_eq!(cloud.take_new_mail(), 0, "tras reset: solo referencia");
    }

    #[test]
    fn due_events_window_and_dedupe() {
        let now = DateTime::parse_from_rfc3339("2026-10-23T10:00:00-05:00").unwrap();
        let events = [
            event("in", "x", "2026-10-23T10:10:00-05:00", false),
            event("edge", "x", "2026-10-23T15:15:00Z", false), // 10:15 local: dentro (límite incluido)
            event("now", "x", "2026-10-23T10:00:00-05:00", false), // ya empezó
            event("late", "x", "2026-10-23T10:16:00-05:00", false),
            event("day", "x", "2026-10-23", true),
            event("bad", "x", "mañana", false),
        ];
        let due = due_events(&events, &now, EVENT_WINDOW, &HashSet::new());
        assert_eq!(due, [("in".to_string(), "10:10".to_string()), ("edge".to_string(), "10:15".to_string())]);
        let due = due_events(&events, &now, EVENT_WINDOW, &ids(&["in"]));
        assert_eq!(due.len(), 1, "no se repite el ya avisado");

        let cloud = Cloud::default();
        let agenda = |list: Vec<EventItem>| AgendaView { events: list, tasks: vec![], pending_tasks: 0, tasks_partial: false };
        cloud.agenda.finish(0, Ok(agenda(events.to_vec())), Instant::now(), 1);
        assert_eq!(cloud.take_due_events(&now), ["Evento a las 10:10", "Evento a las 10:15"]);
        assert!(cloud.take_due_events(&now).is_empty(), "sin repetir");
        // Poda: un id que sale de la caché se olvida; si vuelve, se avisa de nuevo.
        cloud.agenda.finish(0, Ok(agenda(vec![events[1].clone()])), Instant::now(), 2);
        assert!(cloud.take_due_events(&now).is_empty());
        assert_eq!(lock(&cloud.notified).events, ids(&["edge"]), "poda");
        cloud.agenda.finish(0, Ok(agenda(events.to_vec())), Instant::now(), 3);
        assert_eq!(cloud.take_due_events(&now), ["Evento a las 10:10"]);
        cloud.reset();
        assert!(lock(&cloud.notified).events.is_empty(), "reset vacía");
    }

    // Privacidad (D-039): los cuerpos solo llevan conteo u hora.
    #[test]
    fn notification_bodies_have_no_personal_data() {
        assert_eq!(mail_body(1), "1 correo nuevo");
        assert_eq!(mail_body(2), "2 correos nuevos");
        assert_eq!(event_body("09:05"), "Evento a las 09:05");

        let cloud = Cloud::default();
        let secret = |id: &str| MailEntry {
            source: Source::Gmail,
            item: MailItem { id: id.into(), from: "Ana Secreta <ana@privado.example>".into(), subject: "Asunto secreto".into(), internal_date: None },
        };
        let mut view = MailView { items: vec![secret("m1")], unread_ids: ids(&["m0"]), ..Default::default() };
        cloud.mail.finish(0, Ok(view.clone()), Instant::now(), 1);
        cloud.take_new_mail();
        view.unread_ids = ids(&["m0", "m1"]);
        cloud.mail.finish(0, Ok(view), Instant::now(), 2);
        let now = DateTime::parse_from_rfc3339("2026-10-23T10:00:00-05:00").unwrap();
        let ev = event("e1", "Reunión secreta", "2026-10-23T10:05:00-05:00", false);
        cloud.agenda.finish(0, Ok(AgendaView { events: vec![ev], tasks: vec![], pending_tasks: 0, tasks_partial: false }), Instant::now(), 1);
        let mut bodies = vec![mail_body(cloud.take_new_mail())];
        bodies.extend(cloud.take_due_events(&now));
        assert_eq!(bodies, ["1 correo nuevo", "Evento a las 10:05"]);
        for b in &bodies {
            for word in ["Ana", "privado", "Asunto", "secret", "Reunión", "m1", "e1", "Gmail", "Outlook"] {
                assert!(!b.contains(word), "{b:?} contiene {word:?}");
            }
        }
    }

    fn agenda_json(feed: &Feed<AgendaView>, updated: &str) -> Option<String> {
        let TodayUpdate::Agenda(agenda) = feed.today_update(updated)? else { return None };
        serde_json::to_string_pretty(&TodayExport { agenda: Some(agenda), mail: None }).ok()
    }

    fn agenda_update(updated: &str) -> TodayUpdate {
        TodayUpdate::Agenda(TodayAgenda { updated: updated.into(), ..Default::default() })
    }

    fn mail_update(updated: &str) -> TodayUpdate {
        Feed { data: Some(MailView::default()), error: None, updated_at: None }.today_update(updated).unwrap()
    }

    fn read_today(path: &std::path::Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn today_json_has_only_titles_and_dates() {
        let cloud = Cloud::default();
        assert_eq!(agenda_json(&cloud.agenda.feed(), "x"), None, "sin datos: no se escribe");
        let mut ev = event("ev-secret-id", "Dentista", "2026-10-24T09:00:00-05:00", false);
        ev.html_link = Some("https://calendar.google.com/event?eid=LINK".into());
        let task = TaskItem {
            id: "task-secret-id".into(),
            title: "Pagar luz".into(),
            due: Some("2026-10-24T00:00:00.000Z".into()),
            web_view_link: Some("https://tasks.google.com/LINK".into()),
        };
        let undated = TaskItem { due: None, ..task.clone() };
        let agenda = AgendaView { events: vec![ev], tasks: vec![task, undated], pending_tasks: 2, tasks_partial: true };
        assert_eq!(serde_json::to_value(&agenda).unwrap()["tasksPartial"], true);
        cloud.agenda.finish(0, Ok(agenda), Instant::now(), 1);
        let json = agenda_json(&cloud.agenda.feed(), "2026-10-24T07:00:00-05:00").unwrap();
        for bad in ["secret-id", "LINK", "\"id\"", "pendingTasks", "tasksPartial", "html", "webView"] {
            assert!(!json.contains(bad), "no debe contener {bad}");
        }
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["updated"], "2026-10-24T07:00:00-05:00");
        assert_eq!(v["tasks"][0], serde_json::json!({"title": "Pagar luz", "due": "2026-10-24T00:00:00.000Z"}));
        assert_eq!(v["tasks"][1]["due"], serde_json::Value::Null);
        assert_eq!(v["events"][0], serde_json::json!({"title": "Dentista", "start": "2026-10-24T09:00:00-05:00", "allDay": false}));
        // Escritura atómica: sin temporal sobrante.
        let dir = std::env::temp_dir().join(format!("jarwis-today-test-{}", std::process::id()));
        let path = dir.join("hoy.json");
        write_today(&path, &json).unwrap();
        write_today(&path, &json).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), json);
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn newer_today_export_wins_within_generation() {
        let dir = std::env::temp_dir().join(format!("jarwis-today-order-{}", std::process::id()));
        let path = dir.join("hoy.json");
        let writer = TodayWriter::default();
        let a = writer.ticket();
        let b = writer.ticket();
        // Una consulta posterior que devuelve caché no exporta ni invalida B.
        let _cached = writer.ticket();
        writer.write(b, &path, agenda_update("jarwis-prueba B nueva"), true).unwrap();
        writer.write(a, &path, agenda_update("jarwis-prueba A antigua"), true).unwrap();
        assert_eq!(read_today(&path)["updated"], "jarwis-prueba B nueva");
        // Tampoco se admite reutilizar una secuencia ya escrita.
        writer.write(b, &path, agenda_update("jarwis-prueba B repetida"), true).unwrap();
        assert_eq!(read_today(&path)["updated"], "jarwis-prueba B nueva");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn revoked_today_export_cannot_recreate_file() {
        let dir = std::env::temp_dir().join(format!("jarwis-today-revoke-{}", std::process::id()));
        let path = dir.join("hoy.json");
        let writer = TodayWriter::default();
        let queued = writer.ticket();
        writer.write(queued, &path, agenda_update("jarwis-prueba anterior"), true).unwrap();
        std::fs::write(path.with_extension("json.tmp"), "jarwis-prueba temporal").unwrap();
        writer.invalidate(Some(&path));
        assert!(!path.exists());
        assert!(!path.with_extension("json.tmp").exists());
        // Se ejecuta tarde un trabajo de la sesión revocada.
        writer.write(queued, &path, agenda_update("jarwis-prueba obsoleta"), true).unwrap();
        assert!(!path.exists());
        // Una nueva sesión puede exportar; el trabajo antiguo tampoco la pisa.
        writer.write(writer.ticket(), &path, agenda_update("jarwis-prueba nueva"), true).unwrap();
        writer.write(queued, &path, agenda_update("jarwis-prueba obsoleta"), true).unwrap();
        assert_eq!(read_today(&path)["updated"], "jarwis-prueba nueva");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cloud_reset_revokes_queued_today_exports() {
        let cloud = Cloud::default();
        let queued = cloud.today_writer.ticket();
        cloud.reset();
        assert_ne!(queued.generation, cloud.today_writer.ticket().generation);
    }

    #[test]
    fn today_parser_to_export_sanitizes_before_clipping_mail_and_agenda() {
        let dir = std::env::temp_dir().join(format!("jarwis-today-parser-{}", std::process::id()));
        let path = dir.join("hoy.json");
        let writer = TodayWriter::new(Some(path.clone()));
        let hidden = format!("{}\u{e0000}\u{e0001}\u{e0061}\u{e007f}\u{202e}\u{2066}\u{2069}\u{00ad}\u{180e}\u{2061}\u{2064}\u{206a}\u{206f}\u{fe00}\u{fe0f}\u{e0100}\u{e01ef}", "\u{200b}".repeat(120));
        for (name, subject) in [("Ana ficticia".into(), "Revisión ficticia".into()), ("é".repeat(70), "界".repeat(130))] {
            let title = format!("{hidden}{subject}{hidden}");
            let item = api::parse_message(&serde_json::json!({"id":"ficticio", "payload":{"headers":[
                {"name":"From", "value":format!("{hidden}{name}{hidden} <ana@example.invalid>")},
                {"name":"Subject", "value":title}
            ]}})).unwrap();
            assert_eq!(item.from, name.chars().take(api::MAX_FROM).collect::<String>());
            assert_eq!(item.subject, subject.chars().take(api::MAX_TITLE).collect::<String>());
            let feed = Feed { data: Some(MailView { items: vec![MailEntry { source: Source::Gmail, item }], ..Default::default() }), error: None, updated_at: None };
            writer.write(writer.ticket(), &path, feed.today_update("correo ficticio").unwrap(), true).unwrap();
            let events = api::parse_events(&serde_json::json!({"items":[{"id":"evento", "summary":title, "start":{"date":"2026-10-30"}}]}));
            let tasks = api::parse_tasks(&serde_json::json!({"items":[{"id":"tarea", "title":title}]}));
            let feed = Feed { data: Some(AgendaView { events, tasks, pending_tasks: 1, tasks_partial: false }), error: None, updated_at: None };
            writer.write(writer.ticket(), &path, feed.today_update("agenda ficticia").unwrap(), true).unwrap();
            let expected_title = subject.chars().take(api::MAX_TITLE).collect::<String>();
            assert_eq!(read_today(&path), serde_json::json!({"updated":"agenda ficticia",
                "tasks":[{"title":expected_title,"due":null}],
                "events":[{"title":expected_title,"start":"2026-10-30","allDay":true}],
                "mail":{"updated":"correo ficticio","gmail":{"unread":0},"outlook":{"unread":0},
                    "latest":[{"source":"gmail","from":name.chars().take(api::MAX_FROM).collect::<String>(),"subject":expected_title}]}
            }));
            // Defensa de exportación también ante datos construidos sin pasar por el parser.
            let feed = Feed { data: Some(AgendaView {
                events: vec![event("evento", &title, "2026-10-30", true)],
                tasks: vec![TaskItem { id:"tarea".into(), title, due:None, web_view_link:None }],
                pending_tasks:1, tasks_partial:false,
            }), error:None, updated_at:None };
            writer.write(writer.ticket(), &path, feed.today_update("agenda ficticia").unwrap(), true).unwrap();
            assert_eq!(read_today(&path)["tasks"][0]["title"], expected_title);
            assert_eq!(read_today(&path)["events"][0]["title"], expected_title);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    fn lock_against_delete(path: &std::path::Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        // Lectura/escritura permitidas; denegar FILE_SHARE_DELETE como un lector transitorio.
        std::fs::OpenOptions::new().read(true).share_mode(0x1 | 0x2).open(path).unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn today_revocation_retries_both_locked_files_for_every_boundary() {
        let dir = std::env::temp_dir().join(format!("jarwis-today-purge-{}", std::process::id()));
        let path = dir.join("hoy.json");
        let temporary = path.with_extension("json.tmp");
        for boundary in ["signed-out-mail", "expired-mail", "signed-out-agenda", "expired-agenda", "login", "account", "logout", "setting", "disabled-write"] {
            for locked_file in [&path, &temporary] {
                for recover_before_write in [true, false] {
                    let cloud = Cloud::new(Some(path.clone()));
                    let writer = &cloud.today_writer;
                    writer.write(writer.ticket(), &path, agenda_update("agenda anterior"), true).unwrap();
                    writer.write(writer.ticket(), &path, mail_update("correo anterior"), true).unwrap();
                    std::fs::write(&temporary, "temporal ficticio").unwrap();
                    let blocked = lock_against_delete(locked_file);
                    let old = writer.ticket();
                    match boundary {
                        "signed-out-mail" => cloud.finish(&cloud.mail, 0, Err((STEP_MAIL, AuthError::NotLoggedIn(Provider::Google))), old),
                        "expired-mail" => cloud.finish(&cloud.mail, 0, Err((STEP_MAIL, AuthError::TokenRevoked(Provider::Google))), old),
                        "signed-out-agenda" => cloud.finish(&cloud.agenda, 0, Err((STEP_AGENDA, AuthError::NotLoggedIn(Provider::Google))), old),
                        "expired-agenda" => cloud.finish(&cloud.agenda, 0, Err((STEP_AGENDA, AuthError::TokenRevoked(Provider::Google))), old),
                        "login" => drop(cloud.begin_login().unwrap()),
                        "account" => cloud.reset(),
                        "logout" => { let _login = cloud.begin_login().unwrap(); cloud.reset(); }
                        "setting" => writer.invalidate(Some(&path)),
                        "disabled-write" => writer.write(old, &path, mail_update("apagado"), false).unwrap(),
                        _ => unreachable!(),
                    }
                    let mut state = lock(&writer.state);
                    assert!(state.export.mail.is_none() && state.export.agenda.is_none(), "{boundary}");
                    assert!(state.mail_expires.is_none());
                    let pending = state.pending_purge.as_ref().unwrap();
                    assert_eq!(pending.generation, state.generation);
                    let delayed_purge = TodayPurge { generation: pending.generation, path: pending.path.clone() };
                    assert!(TodayWriter::expire_mail(&mut state, &path, SystemTime::now()).is_err());
                    drop(state);
                    assert!(locked_file.exists());
                    let other = if locked_file == &path { &temporary } else { &path };
                    assert!(!other.exists(), "también se intenta el archivo sin bloqueo: {boundary}");
                    writer.write(old, &path, mail_update("obsoleto"), true).unwrap();
                    assert!(writer.write_using(writer.ticket(), &path, mail_update("sesión nueva"), true,
                        |_, _| panic!("no escribir mientras siga pendiente la purga")).is_err());
                    assert!(lock(&writer.state).pending_purge.is_some());
                    drop(blocked);
                    if !recover_before_write {
                        // Mismo paso del trabajador, sin red ni ninguna consulta correcta posterior.
                        TodayWriter::expire_mail(&mut lock(&writer.state), &path, SystemTime::now()).unwrap();
                        assert!(!path.exists() && !temporary.exists());
                    }
                    writer.write(writer.ticket(), &path, agenda_update("agenda nueva"), true).unwrap();
                    assert!(lock(&writer.state).pending_purge.is_none());
                    assert_eq!(read_today(&path)["mail"]["updated"], "sesión nueva");
                    // Otra generación válida ya escrita: ni purga ni revocación tardías la borran.
                    writer.invalidate(Some(&path));
                    writer.write(writer.ticket(), &path, mail_update("otra generación"), true).unwrap();
                    lock(&writer.state).pending_purge = Some(delayed_purge);
                    TodayWriter::expire_mail(&mut lock(&writer.state), &path, SystemTime::now()).unwrap();
                    writer.session_lost(old);
                    writer.write(old, &path, agenda_update("obsoleta"), false).unwrap();
                    assert_eq!(read_today(&path)["mail"]["updated"], "otra generación");
                }
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn today_worker_retries_startup_purge_without_queries() {
        let dir = std::env::temp_dir().join(format!("jarwis-today-worker-{}", std::process::id()));
        let path = dir.join("hoy.json");
        std::fs::create_dir_all(&dir).unwrap();
        for locked_file in [&path, &path.with_extension("json.tmp")] {
            std::fs::write(&path, "sesión ficticia anterior").unwrap();
            std::fs::write(path.with_extension("json.tmp"), "temporal ficticio anterior").unwrap();
            let blocked = lock_against_delete(locked_file);
            // Bloqueo durante el constructor de arranque, antes de poder leer ajustes.
            let writer = TodayWriter::new(Some(path.clone()));
            assert!(lock(&writer.state).pending_purge.is_some());
            std::thread::scope(|scope| {
                let worker = scope.spawn(|| writer.run_expiry());
                drop(blocked);
                let until = Instant::now() + Duration::from_secs(4);
                while lock(&writer.state).pending_purge.is_some() && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(10));
                }
                let recovered = lock(&writer.state).pending_purge.is_none();
                writer.shutdown();
                worker.join().unwrap();
                assert!(recovered, "el trabajador autónomo reintenta sin nuevas consultas");
            });
            assert!(!path.exists() && !path.with_extension("json.tmp").exists());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn today_shutdown_retries_locks_and_rejects_all_later_writes() {
        let dir = std::env::temp_dir().join(format!("jarwis-today-exit-{}", std::process::id()));
        let path = dir.join("hoy.json");
        for locked_file in [&path, &path.with_extension("json.tmp")] {
            let writer = TodayWriter::new(Some(path.clone()));
            writer.write(writer.ticket(), &path, mail_update("ficticio"), true).unwrap();
            std::fs::write(path.with_extension("json.tmp"), "temporal ficticio").unwrap();
            let blocked = lock_against_delete(locked_file);
            let old = writer.ticket();
            std::thread::scope(|scope| {
                let exit = scope.spawn(|| writer.shutdown());
                let until = Instant::now() + Duration::from_secs(1);
                while !lock(&writer.state).closed && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(1));
                }
                assert!(lock(&writer.state).pending_purge.is_some());
                drop(blocked);
                exit.join().unwrap();
            });
            assert!(!path.exists() && !path.with_extension("json.tmp").exists());
            assert!(lock(&writer.state).pending_purge.is_none());
            writer.write(old, &path, agenda_update("obsoleta"), true).unwrap();
            writer.write(writer.ticket(), &path, mail_update("tardía"), true).unwrap();
            assert!(!path.exists());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn today_shutdown_persistent_lock_is_purged_on_next_startup() {
        let dir = std::env::temp_dir().join(format!("jarwis-today-exit-restart-{}", std::process::id()));
        let path = dir.join("hoy.json");
        let writer = TodayWriter::new(Some(path.clone()));
        writer.write(writer.ticket(), &path, mail_update("ficticio"), true).unwrap();
        let blocked = lock_against_delete(&path);
        writer.shutdown();
        assert!(lock(&writer.state).pending_purge.is_some());
        drop(writer);
        // El bloqueo sobrevive al proceso: el constructor retoma la purga sin heredar datos.
        let next = TodayWriter::new(Some(path.clone()));
        assert!(lock(&next.state).pending_purge.is_some());
        drop(blocked);
        next.write(next.ticket(), &path, agenda_update("sesión nueva"), true).unwrap();
        assert!(lock(&next.state).pending_purge.is_none());
        assert_eq!(read_today(&path), serde_json::json!({"updated":"sesión nueva","tasks":[],"events":[]}));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn today_mail_exact_shape_limits_controls_and_latest_five() {
        let adversarial = "\u{061c}\u{200e}\u{200f}\u{202a}\u{202b}\u{202c}\u{202d}\u{202e}\u{2066}\u{2067}\u{2068}\u{2069}\u{200b}\u{200c}\u{200d}\u{2060}\u{feff}\u{2028}\u{2029}";
        for c in adversarial.chars().chain(['\n', '\r', '\t', '\0', '\u{0085}']) {
            assert_eq!(today_text(&format!("{c} A{c}B{c}C {c}"), 2), "AB", "U+{:04X}", c as u32);
        }
        let feed = Feed { data: Some(MailView {
            inbox_unread: 100, inbox_more: true, outlook_unread: 3,
            items: (0..10).map(|i| MailEntry {
                source: if i % 2 == 0 { Source::Gmail } else { Source::Outlook },
                item: MailItem { id: format!("secret-{i}"), from: format!(" \n{adversarial}{}\0 {adversarial}", "é".repeat(70)),
                    subject: format!(" \r\n{adversarial}{}\t {adversarial}", "界".repeat(130)), internal_date: Some(i) },
            }).collect(), ..Default::default()
        }), error: None, updated_at: None };
        let TodayUpdate::Mail(mail) = feed.today_update("correo").unwrap() else { panic!() };
        let v = serde_json::to_value(mail).unwrap();
        let entries: Vec<_> = (0..5).map(|i| serde_json::json!({
            "source": if i % 2 == 0 { "outlook" } else { "gmail" },
            "from": "é".repeat(60), "subject": "界".repeat(120)
        })).collect();
        assert_eq!(v, serde_json::json!({"updated":"correo", "gmail":{"unread":"100+"}, "outlook":{"unread":3}, "latest":entries}));
        let mut view = MailView { inbox_unread: 100, ..Default::default() };
        view.items.push(MailEntry { source: Source::Gmail, item: MailItem {
            id: "secret".into(), from: "ana@example.invalid".into(), subject: "  Hola\n\0  ".into(), internal_date: None,
        }});
        let TodayUpdate::Mail(mail) = (Feed { data: Some(view), error: None, updated_at: None }).today_update("x").unwrap() else { panic!() };
        let v = serde_json::to_value(mail).unwrap();
        assert_eq!(v["gmail"]["unread"], 100);
        assert_eq!(v["outlook"]["unread"], 0);
        assert_eq!(v["latest"][0]["from"], "example.invalid");
        assert_eq!(v["latest"][0]["subject"], "Hola");
    }

    #[test]
    fn today_merge_reversed_pool_order_and_concurrent_writes() {
        let dir = std::env::temp_dir().join(format!("jarwis-today-merge-{}", std::process::id()));
        let path = dir.join("hoy.json");
        let writer = TodayWriter::default();
        let agenda = writer.ticket();
        let mail = writer.ticket();
        // Correo posterior termina primero; agenda anterior debe fusionarse también.
        writer.write(mail, &path, mail_update("correo"), true).unwrap();
        writer.write(agenda, &path, agenda_update("agenda"), true).unwrap();
        assert_eq!(read_today(&path), serde_json::json!({"updated":"agenda", "tasks":[], "events":[], "mail":{
            "updated":"correo", "gmail":{"unread":0}, "outlook":{"unread":0}, "latest":[] }}));
        let agenda = writer.ticket();
        let mail = writer.ticket();
        std::thread::scope(|scope| {
            scope.spawn(|| writer.write(agenda, &path, agenda_update("agenda nueva"), true).unwrap());
            scope.spawn(|| writer.write(mail, &path, mail_update("correo nuevo"), true).unwrap());
        });
        assert_eq!(read_today(&path)["updated"], "agenda nueva");
        assert_eq!(read_today(&path)["mail"]["updated"], "correo nuevo");
        // Un archivo manipulado en disco nunca entra en la fusión.
        std::fs::write(&path, "contenido ajeno").unwrap();
        writer.write(writer.ticket(), &path, mail_update("otro"), true).unwrap();
        assert_eq!(read_today(&path)["updated"], "agenda nueva");
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn today_disk_failure_keeps_merged_memory_for_next_write() {
        let dir = std::env::temp_dir().join(format!("jarwis-today-disk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let blocker = dir.join("bloqueo");
        std::fs::write(&blocker, "ficticio").unwrap();
        let writer = TodayWriter::default();
        let update = TodayUpdate::Agenda(TodayAgenda { updated: "agenda".into(),
            tasks: vec![TodayTask { title: "Tarea ficticia".into(), due: None }],
            events: vec![TodayEvent { title: "Evento ficticio".into(), start: "2026-10-29".into(), all_day: true }],
        });
        assert!(writer.write(writer.ticket(), &blocker.join("hoy.json"), update, true).is_err());
        let path = dir.join("hoy.json");
        writer.write(writer.ticket(), &path, mail_update("correo"), true).unwrap();
        assert_eq!(read_today(&path)["tasks"][0]["title"], "Tarea ficticia");
        assert_eq!(read_today(&path)["events"][0]["allDay"], true);
        assert!(read_today(&path).get("mail").is_some());
        let old = writer.ticket();
        writer.write(writer.ticket(), &path, mail_update("nuevo"), true).unwrap();
        writer.write(old, &path, mail_update("viejo"), true).unwrap();
        assert_eq!(read_today(&path)["mail"]["updated"], "nuevo");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn today_disabled_and_logout_remove_all_and_revoke_both_sections() {
        let dir = std::env::temp_dir().join(format!("jarwis-today-disabled-{}", std::process::id()));
        let path = dir.join("hoy.json");
        let cloud = Cloud::default();
        let writer = &cloud.today_writer;
        writer.write(writer.ticket(), &path, mail_update("correo"), false).unwrap();
        assert!(!path.exists());
        writer.write(writer.ticket(), &path, agenda_update("agenda"), true).unwrap();
        writer.write(writer.ticket(), &path, mail_update("correo"), true).unwrap();
        let queued_agenda = writer.ticket();
        let queued_mail = writer.ticket();
        std::fs::write(path.with_extension("json.tmp"), "ficticio").unwrap();
        writer.write(writer.ticket(), &path, mail_update("apagado"), false).unwrap();
        assert!(!path.exists() && !path.with_extension("json.tmp").exists());
        writer.write(queued_agenda, &path, agenda_update("viejo"), true).unwrap();
        writer.write(queued_mail, &path, mail_update("viejo"), true).unwrap();
        assert!(!path.exists());
        writer.write(writer.ticket(), &path, mail_update("nuevo"), true).unwrap();
        // Un trabajador antiguo que leyó el ajuste apagado no borra la generación nueva.
        writer.write(queued_mail, &path, mail_update("viejo apagado"), false).unwrap();
        assert_eq!(read_today(&path)["mail"]["updated"], "nuevo");
        assert!(read_today(&path).get("tasks").is_none());
        // Misma secuencia de revocación y borrado que cloud_logout, sin credenciales.
        let queued = writer.ticket();
        cloud.reset();
        writer.invalidate(Some(&path));
        writer.write(queued, &path, mail_update("revocado"), true).unwrap();
        assert!(!path.exists());
        writer.write(writer.ticket(), &path, agenda_update("sesión nueva"), true).unwrap();
        assert!(read_today(&path).get("mail").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn today_partial_mail_failure_preserves_feed_and_export() {
        let dir = std::env::temp_dir().join(format!("jarwis-today-partial-{}", std::process::id()));
        let path = dir.join("hoy.json");
        let cloud = Cloud::default();
        cloud.mail.finish(0, Ok(MailView { inbox_unread: 7, outlook_unread: 9, ..Default::default() }), Instant::now(), 1);
        cloud.today_writer.write(cloud.today_writer.ticket(), &path, cloud.mail.feed().today_update("anterior").unwrap(), true).unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        for gmail_fails in [true, false] {
            let good = || Ok((vec!["ficticio".into()], false, vec![]));
            let bad = || Err(AuthError::Network("fallo ficticio"));
            let result = if gmail_fails { merge_mailboxes(bad(), good()) } else { merge_mailboxes(good(), bad()) };
            assert!(result.is_err());
            cloud.finish(&cloud.mail, 0, result.map_err(|e| (STEP_MAIL, e)), cloud.today_writer.ticket());
            let feed = cloud.mail.feed();
            assert!(feed.error.is_some());
            assert_eq!(feed.data.unwrap().inbox_unread, 7);
            // Agenda correcta después del fallo conserva el correo y su fecha anterior.
            cloud.today_writer.write(cloud.today_writer.ticket(), &path, agenda_update("agenda"), true).unwrap();
            assert_eq!(read_today(&path)["mail"]["updated"], "anterior");
            assert_eq!(read_today(&path)["mail"]["outlook"]["unread"], 9);
        }
        assert!(before.contains("anterior"));
        let empty = Cloud::default();
        empty.finish(&empty.mail, 0, Err((STEP_MAIL, AuthError::Network("ficticio"))), empty.today_writer.ticket());
        assert!(empty.mail.feed().today_update("sin datos").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn today_session_errors_delete_without_later_success_and_reject_old_requests() {
        let dir = std::env::temp_dir().join(format!("jarwis-today-session-{}", std::process::id()));
        let path = dir.join("hoy.json");
        // Misma finalización que correo/agenda, sin red ni credenciales.
        for agenda_fails in [false, true] {
            for error in [AuthError::NotLoggedIn(Provider::Google), AuthError::TokenRevoked(Provider::Google),
                AuthError::NoRefreshToken(Provider::Google), AuthError::Api { endpoint: "ficticio", status: 401 }] {
                let cloud = Cloud::new(Some(path.clone()));
                let writer = &cloud.today_writer;
                writer.write(writer.ticket(), &path, agenda_update("agenda anterior"), true).unwrap();
                writer.write(writer.ticket(), &path, mail_update("correo anterior"), true).unwrap();
                std::fs::write(path.with_extension("json.tmp"), "temporal ficticio").unwrap();
                let pending = writer.ticket();
                let failure = writer.ticket();
                if agenda_fails {
                    cloud.finish(&cloud.agenda, 0, Err((STEP_AGENDA, error)), failure);
                } else {
                    cloud.finish(&cloud.mail, 0, Err((STEP_MAIL, error)), failure);
                }
                // No hace falta ninguna consulta correcta posterior para borrar.
                assert!(!path.exists() && !path.with_extension("json.tmp").exists());
                let state = lock(&writer.state);
                assert!(state.export.agenda.is_none() && state.export.mail.is_none());
                drop(state);
                writer.write(pending, &path, mail_update("consulta vieja"), true).unwrap();
                writer.write(pending, &path, agenda_update("consulta vieja"), true).unwrap();
                assert!(!path.exists());
                writer.write(writer.ticket(), &path, mail_update("cuenta nueva"), true).unwrap();
                // Ni una revocación tardía de la sesión antigua borra la nueva.
                cloud.finish(&cloud.mail, 0, Err((STEP_TOKEN, AuthError::TokenRevoked(Provider::Google))), failure);
                assert_eq!(read_today(&path)["mail"]["updated"], "cuenta nueva");
            }
        }
        // Una revocación en Outlook prima sobre un fallo de red simultáneo en Gmail.
        let error = merge_mailboxes(Err(AuthError::Network("ficticio")), Err(AuthError::TokenRevoked(Provider::Google))).unwrap_err();
        assert_eq!(CloudError::new(STEP_MAIL, &error).kind, ErrorKind::Expired);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn today_startup_and_account_change_clear_disk_memory_and_pending_exports() {
        let dir = std::env::temp_dir().join(format!("jarwis-today-startup-{}", std::process::id()));
        let path = dir.join("hoy.json");
        std::fs::create_dir_all(&dir).unwrap();
        for share_today in [false, true] {
            std::fs::write(&path, "sesión ficticia anterior").unwrap();
            std::fs::write(path.with_extension("json.tmp"), "temporal ficticio anterior").unwrap();
            // La construcción usada en setup no depende del ajuste shareToday.
            let cloud = Cloud::new(Some(path.clone()));
            assert!(!path.exists() && !path.with_extension("json.tmp").exists());
            let writer = &cloud.today_writer;
            writer.write(writer.ticket(), &path, mail_update("correo"), share_today).unwrap();
            if !share_today { continue; }
            // Sin consulta de agenda, el documento contiene exclusivamente mail.
            assert_eq!(read_today(&path), serde_json::json!({"mail": {
                "updated":"correo", "gmail":{"unread":0}, "outlook":{"unread":0}, "latest":[]
            }}));
            writer.write(writer.ticket(), &path, agenda_update("agenda"), true).unwrap();
            let pending = writer.ticket();
            let login = cloud.begin_login().unwrap();
            assert!(!path.exists() && !path.with_extension("json.tmp").exists());
            assert!(cloud.begin_login().is_none());
            let state = lock(&writer.state);
            assert!(state.export.mail.is_none() && state.export.agenda.is_none());
            drop(state);
            writer.write(pending, &path, mail_update("cuenta anterior"), true).unwrap();
            assert!(!path.exists());
            // Igual que al completar login: revocar también las consultas del intervalo.
            let during_login = writer.ticket();
            cloud.reset();
            drop(login);
            writer.write(during_login, &path, agenda_update("cuenta anterior"), true).unwrap();
            writer.write(writer.ticket(), &path, agenda_update("cuenta nueva"), true).unwrap();
            assert_eq!(read_today(&path), serde_json::json!({"updated":"cuenta nueva", "tasks":[], "events":[]}));
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn today_mail_expires_after_two_hours_without_success_preserving_real_agenda() {
        let dir = std::env::temp_dir().join(format!("jarwis-today-ttl-{}", std::process::id()));
        let path = dir.join("hoy.json");
        for with_agenda in [true, false] {
            let cloud = Cloud::new(Some(path.clone()));
            let writer = &cloud.today_writer;
            if with_agenda { writer.write(writer.ticket(), &path, agenda_update("agenda válida"), true).unwrap(); }
            writer.write(writer.ticket(), &path, mail_update("correo previo"), true).unwrap();
            let expired_ticket = writer.ticket();
            // Fallo parcial en ambos sentidos: no renueva mail ni su vencimiento.
            let deadline = lock(&writer.state).mail_expires.unwrap();
            for gmail_fails in [true, false] {
                let good = || Ok((vec![], false, vec![]));
                let bad = || Err(AuthError::Network("ficticio"));
                let res = if gmail_fails { merge_mailboxes(bad(), good()) } else { merge_mailboxes(good(), bad()) };
                cloud.finish(&cloud.mail, 0, res.map_err(|e| (STEP_MAIL, e)), writer.ticket());
                assert_eq!(lock(&writer.state).mail_expires, Some(deadline));
            }
            // Un permiso de Gmail retirado puede responder 403: cuota, sin renovar TTL.
            cloud.finish(&cloud.mail, 0, Err((STEP_MAIL, AuthError::Api { endpoint: "ficticio", status: 403 })), writer.ticket());
            assert_eq!(cloud.mail.feed().error.unwrap().kind, ErrorKind::Quota);
            assert_eq!(lock(&writer.state).mail_expires, Some(deadline));
            let mut state = lock(&writer.state);
            TodayWriter::expire_mail(&mut state, &path, deadline - Duration::from_millis(1)).unwrap();
            assert!(read_today(&path).get("mail").is_some());
            // Es el mismo paso del trabajador autónomo; reloj inyectado, sin dormir 2 h.
            if with_agenda {
                // Un fallo al retirar mail conserva el vencimiento para reintentarlo.
                let temporary = path.with_extension("json.tmp");
                std::fs::create_dir(&temporary).unwrap();
                assert!(TodayWriter::expire_mail(&mut state, &path, deadline + Duration::from_millis(1)).is_err());
                assert!(state.export.mail.is_none());
                assert_eq!(state.mail_expires, Some(deadline));
                assert!(read_today(&path).get("mail").is_some());
                std::fs::remove_dir(temporary).unwrap();
            }
            TodayWriter::expire_mail(&mut state, &path, deadline + Duration::from_millis(1)).unwrap();
            assert!(state.export.mail.is_none());
            drop(state);
            if with_agenda {
                assert_eq!(read_today(&path), serde_json::json!({"updated":"agenda válida", "tasks":[], "events":[]}));
            } else {
                assert!(!path.exists());
            }
            assert!(!path.with_extension("json.tmp").exists());
            // Una escritura de correo retrasada también se poda al fusionar.
            let TodayUpdate::Mail(mut old_mail) = mail_update("correo caducado") else { panic!() };
            old_mail.queried_at = SystemTime::now() - TODAY_MAIL_TTL - Duration::from_secs(1);
            writer.write(expired_ticket, &path, TodayUpdate::Mail(old_mail), true).unwrap();
            assert!(lock(&writer.state).export.mail.is_none());
            writer.write(writer.ticket(), &path, mail_update("correo nuevo"), true).unwrap();
            assert_eq!(read_today(&path)["mail"]["updated"], "correo nuevo");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn today_disable_during_atomic_write_barriers_leave_no_file_or_temporary() {
        use std::sync::Barrier;
        let dir = std::env::temp_dir().join(format!("jarwis-today-barriers-{}", std::process::id()));
        let path = dir.join("hoy.json");
        let writer = TodayWriter::default();
        let ticket = writer.ticket();
        let temporary_written = Barrier::new(2);
        let disabled = Barrier::new(2);
        let enabled = AtomicBool::new(true);
        std::thread::scope(|scope| {
            let writing = scope.spawn(|| writer.write_using(ticket, &path, mail_update("correo ficticio"), true,
                |path, json| write_today_before_rename(path, json, || {
                    temporary_written.wait();
                    disabled.wait();
                    assert!(!enabled.load(Ordering::SeqCst));
                })).unwrap());
            let shutdown = scope.spawn(|| {
                temporary_written.wait();
                assert!(path.with_extension("json.tmp").exists());
                enabled.store(false, Ordering::SeqCst);
                disabled.wait();
                // Espera la escritura con el mismo bloqueo que el commit de ajustes.
                writer.invalidate(Some(&path));
            });
            writing.join().unwrap();
            shutdown.join().unwrap();
        });
        assert!(!path.exists() && !path.with_extension("json.tmp").exists());
        writer.write(ticket, &path, agenda_update("pendiente vieja"), true).unwrap();
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn mail_view_shape() {
        let item = MailItem { id: "abc".into(), from: "Ana".into(), subject: "Hola".into(), internal_date: Some(5) };
        let v = serde_json::to_value(MailView {
            items: vec![MailEntry { source: Source::Outlook, item }],
            unread_ids: ids(&["abc", "zzz"]),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"inboxUnread": 0, "inboxMore": false, "outlookUnread": 0, "outlookMore": false,
                "items": [{"source": "outlook", "id": "abc", "from": "Ana", "subject": "Hola", "date": 5}]})
        );
        let f = serde_json::to_value(Slot::<u32>::default().feed()).unwrap();
        assert_eq!(f, serde_json::json!({"data": null, "error": null, "updatedAt": null}));
    }
}
