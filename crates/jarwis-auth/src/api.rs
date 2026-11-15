//! Consultas de solo lectura (GET) a Google y Microsoft Graph.
//!
//! Los campos de contenido (asunto, títulos) solo se piden a la API cuando
//! `include_content` es `true` (modo `--show`); si no, ni siquiera se descargan.
//! Gmail, Calendar y Tasks limitan la respuesta con `fields` y Graph con `$select`
//! (excepto userinfo de Google, que solo devuelve datos de la cuenta).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use oauth2::AccessToken;
use oauth2::url::Url;
use serde::Serialize;
use serde_json::Value;

use crate::error::{AuthError, Result};
use crate::{Provider, sender_domain};

pub struct MailMeta {
    pub id: String,
    pub date: String,
    /// Remitente completo tal como lo da la API (mostrar solo su dominio por defecto).
    pub from: String,
    pub subject: Option<String>,
    pub is_read: Option<bool>,
}

pub struct EventMeta {
    pub id: String,
    pub start: String,
    pub title: Option<String>,
}

pub struct TaskMeta {
    pub id: String,
    pub due: String,
    pub title: Option<String>,
}

pub struct GoogleSummary {
    pub messages: Vec<MailMeta>,
    pub events: Vec<EventMeta>,
    pub task_lists: usize,
    /// Tareas pendientes (todas las listas).
    pub pending_tasks: usize,
    pub partial: bool,
    /// Tareas pendientes con vencimiento, ordenadas por fecha.
    pub due_tasks: Vec<TaskMeta>,
}

pub struct MicrosoftSummary {
    pub messages: Vec<MailMeta>,
    pub unread_inbox: u64,
    pub events: Vec<EventMeta>,
}

async fn get_json(
    http: &oauth2::reqwest::Client,
    token: &AccessToken,
    url: &str,
    query: &[(&str, &str)],
    endpoint: &'static str,
) -> Result<Value> {
    let resp = http.get(url).query(query).bearer_auth(token.secret()).send().await?;
    let status = resp.status();
    if !status.is_success() {
        // El cuerpo no se lee ni se muestra.
        return Err(AuthError::Api { endpoint, status: status.as_u16() });
    }
    let bytes = resp.bytes().await?;
    serde_json::from_slice(&bytes).map_err(|_| AuthError::BadResponse(endpoint))
}

fn s(v: &Value, ptr: &str) -> String {
    v.pointer(ptr).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn opt(v: &Value, ptr: &str, include: bool) -> Option<String> {
    include.then(|| s(v, ptr))
}

fn items<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default()
}

/// Email de la cuenta autenticada.
pub async fn account_email(
    provider: Provider,
    http: &oauth2::reqwest::Client,
    token: &AccessToken,
) -> Result<String> {
    match provider {
        Provider::Google => {
            let v = get_json(http, token, "https://openidconnect.googleapis.com/v1/userinfo", &[], "Google userinfo").await?;
            Ok(s(&v, "/email"))
        }
        Provider::Microsoft => {
            let v = get_json(
                http,
                token,
                "https://graph.microsoft.com/v1.0/me",
                &[("$select", "userPrincipalName,mail")],
                "Graph /me",
            )
            .await?;
            let mail = s(&v, "/mail");
            Ok(if mail.is_empty() { s(&v, "/userPrincipalName") } else { mail })
        }
    }
}

pub async fn google_summary(
    http: &oauth2::reqwest::Client,
    token: &AccessToken,
    include_content: bool,
) -> Result<GoogleSummary> {
    // Gmail: 5 últimos mensajes, solo cabeceras.
    let list = get_json(
        http,
        token,
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        &[("maxResults", "5"), ("fields", "messages(id),resultSizeEstimate")],
        "Gmail messages.list",
    )
    .await?;
    // `fields` evita que Gmail devuelva `snippet` (fragmento del cuerpo) u otros campos.
    let mut headers = vec![
        ("format", "metadata"),
        ("fields", "id,labelIds,payload/headers"),
        ("metadataHeaders", "From"),
        ("metadataHeaders", "Date"),
    ];
    if include_content {
        headers.push(("metadataHeaders", "Subject"));
    }
    let mut messages = Vec::new();
    // IDs no válidos se omiten: van en la ruta de una petición con el bearer token.
    for m in items(&list, "messages").iter().filter(|m| valid_id(&s(m, "/id"))) {
        let id = s(m, "/id");
        let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}");
        let full = get_json(http, token, &url, &headers, "Gmail messages.get").await?;
        let header = |name: &str| {
            full.get("payload").map(|p| items(p, "headers")).unwrap_or_default()
                .iter()
                .find(|h| str_at(h, "name").is_some_and(|n| n.eq_ignore_ascii_case(name)))
                .map(|h| s(h, "/value"))
                .unwrap_or_default()
        };
        messages.push(MailMeta {
            date: header("Date"),
            from: header("From"),
            subject: include_content.then(|| header("Subject")),
            is_read: full.get("labelIds").and_then(Value::as_array).map(|l| !l.iter().any(|x| x == "UNREAD")),
            id,
        });
    }

    // Calendar: eventos de los próximos 7 días del calendario principal.
    let (now, week) = (rfc3339(SystemTime::now()), rfc3339(SystemTime::now() + Duration::from_secs(7 * 86400)));
    let fields = if include_content { "items(id,start,summary)" } else { "items(id,start)" };
    let cal = get_json(
        http,
        token,
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        &[
            ("timeMin", &now),
            ("timeMax", &week),
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
            ("maxResults", "50"),
            ("fields", fields),
        ],
        "Calendar events.list",
    )
    .await?;
    let events = items(&cal, "items")
        .iter()
        .map(|e| EventMeta {
            id: s(e, "/id"),
            start: e.pointer("/start/dateTime").or(e.pointer("/start/date")).and_then(Value::as_str).unwrap_or_default().into(),
            title: opt(e, "/summary", include_content),
        })
        .collect();

    let pages = task_pages(http, token, include_content).await?;
    let pending_tasks = pages.tasks.len();
    let mut due_tasks: Vec<_> = pages.tasks.iter().filter(|t| t.get("due").is_some()).map(|task| TaskMeta {
        id: s(task, "/id"), due: s(task, "/due"), title: opt(task, "/title", include_content),
    }).collect();
    due_tasks.sort_by(|a, b| a.due.cmp(&b.due));

    Ok(GoogleSummary { messages, events, task_lists: pages.task_lists, pending_tasks, partial: pages.partial, due_tasks })
}

pub async fn microsoft_summary(
    http: &oauth2::reqwest::Client,
    token: &AccessToken,
    include_content: bool,
) -> Result<MicrosoftSummary> {
    let select = if include_content { "receivedDateTime,from,isRead,subject" } else { "receivedDateTime,from,isRead" };
    let list = get_json(
        http,
        token,
        "https://graph.microsoft.com/v1.0/me/messages",
        &[("$top", "5"), ("$select", select), ("$orderby", "receivedDateTime desc")],
        "Graph /me/messages",
    )
    .await?;
    let messages = items(&list, "value")
        .iter()
        .map(|m| MailMeta {
            id: s(m, "/id"),
            date: s(m, "/receivedDateTime"),
            from: s(m, "/from/emailAddress/address"),
            subject: opt(m, "/subject", include_content),
            is_read: m.get("isRead").and_then(Value::as_bool),
        })
        .collect();

    let inbox = get_json(
        http,
        token,
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox",
        &[("$select", "unreadItemCount")],
        "Graph inbox",
    )
    .await?;
    let unread_inbox = inbox.get("unreadItemCount").and_then(Value::as_u64).unwrap_or(0);

    let (now, week) = (rfc3339(SystemTime::now()), rfc3339(SystemTime::now() + Duration::from_secs(7 * 86400)));
    let eselect = if include_content { "id,start,subject" } else { "id,start" };
    let cal = get_json(
        http,
        token,
        "https://graph.microsoft.com/v1.0/me/calendarView",
        &[
            ("startDateTime", &now),
            ("endDateTime", &week),
            ("$select", eselect),
            ("$orderby", "start/dateTime"),
            ("$top", "50"),
        ],
        "Graph calendarView",
    )
    .await?;
    let events = items(&cal, "value")
        .iter()
        .map(|e| EventMeta {
            id: s(e, "/id"),
            // Graph devuelve la hora en UTC salvo que se pida otra zona.
            start: s(e, "/start/dateTime"),
            title: opt(e, "/subject", include_content),
        })
        .collect();

    Ok(MicrosoftSummary { messages, unread_inbox, events })
}

// ---------------------------------------------------------------- Widget de la app (JW-4-02)
//
// D-038: de cada correo solo salen remitente (nombre visible o dominio, máx. 60),
// asunto (máx. 120) y fecha. Nunca `snippet`, dirección completa ni etiquetas
// (ni siquiera se piden: `fields`). Los enlaces web no se serializan.

pub const MAX_FROM: usize = 60;
pub const MAX_TITLE: usize = 120;
/// Máximo de eventos y de tareas que se devuelven.
pub const MAX_AGENDA: usize = 20;
/// Hosts permitidos para `htmlLink` (Calendar) y `webViewLink` (Tasks).
const LINK_HOSTS: &[&str] = &["www.google.com", "calendar.google.com", "tasks.google.com"];

#[derive(Clone, Debug, Serialize)]
pub struct MailItem {
    pub id: String,
    pub from: String,
    pub subject: String,
    /// `internalDate` de Gmail (ms Unix).
    #[serde(rename = "date")]
    pub internal_date: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventItem {
    pub id: String,
    pub title: String,
    /// `dateTime` RFC 3339 o, en eventos de día completo, `date` (AAAA-MM-DD).
    pub start: String,
    pub all_day: bool,
    #[serde(skip)]
    pub html_link: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskItem {
    pub id: String,
    pub title: String,
    pub due: Option<String>,
    #[serde(skip)]
    pub web_view_link: Option<String>,
}

/// ID apto para ir en una ruta de la API o en un fragmento de URL: `[A-Za-z0-9_=-]{1,256}`.
pub fn valid_id(id: &str) -> bool {
    (1..=256).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'=' | b'-'))
}

/// Enlace web de Google apto para abrirse: https, host permitido, sin credenciales ni puerto.
pub fn safe_link(link: &str) -> Option<String> {
    let url = Url::parse(link).ok()?;
    let ok = url.scheme() == "https"
        && url.host_str().is_some_and(|h| LINK_HOSTS.contains(&h))
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none();
    ok.then(|| url.to_string())
}

/// Texto visible compartido por widgets y hoy.json: sanear antes del primer recorte.
pub fn clean_text(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control() && !matches!(c,
        '\u{00ad}' | '\u{061c}' | '\u{180e}' | '\u{200b}'..='\u{200f}' |
        '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206f}' |
        '\u{fe00}'..='\u{fe0f}' | '\u{feff}' | '\u{e0000}'..='\u{e007f}' |
        '\u{e0100}'..='\u{e01ef}'
    )).collect::<String>().trim().chars().take(max).collect()
}

/// Nombre visible del remitente o, si no lo hay (o es una dirección), su dominio. Máx. 60.
pub fn sender_label(from: &str) -> String {
    let from = clean_text(from, usize::MAX);
    let name = from.split_once('<').map_or("", |(n, _)| n).trim().trim_matches('"').trim();
    let label = if !name.is_empty() && !name.contains('@') {
        name.to_string()
    } else {
        sender_domain(&from).unwrap_or_else(|| "Remitente desconocido".into())
    };
    clean_text(&label, MAX_FROM)
}

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// Respuesta de `messages.get` (formato metadata) → elemento del widget.
pub fn parse_message(v: &Value) -> Option<MailItem> {
    let id = str_at(v, "id").filter(|id| valid_id(id))?;
    let header = |name: &str| {
        v.get("payload")
            .map(|p| items(p, "headers"))
            .unwrap_or_default()
            .iter()
            .find(|h| str_at(h, "name").is_some_and(|n| n.eq_ignore_ascii_case(name)))
            .and_then(|h| str_at(h, "value"))
            .unwrap_or_default()
    };
    Some(MailItem {
        id: id.into(),
        from: sender_label(header("From")),
        subject: clean_text(header("Subject"), MAX_TITLE),
        internal_date: str_at(v, "internalDate").and_then(|d| d.parse().ok()),
    })
}

/// Respuesta de `events.list` → eventos (máx. 20, IDs válidos).
pub fn parse_events(v: &Value) -> Vec<EventItem> {
    items(v, "items")
        .iter()
        .filter_map(|e| {
            let id = str_at(e, "id").filter(|id| valid_id(id))?;
            let start = e.get("start");
            let date_time = start.and_then(|s| str_at(s, "dateTime"));
            let date = start.and_then(|s| str_at(s, "date"));
            Some(EventItem {
                id: id.into(),
                title: clean_text(str_at(e, "summary").unwrap_or_default(), MAX_TITLE),
                start: date_time.or(date).unwrap_or_default().into(),
                all_day: date_time.is_none() && date.is_some(),
                html_link: str_at(e, "htmlLink").map(String::from),
            })
        })
        .take(MAX_AGENDA)
        .collect()
}

/// Respuesta de `tasks.list` → tareas con ID válido (el límite lo aplica [`pending_tasks`]).
pub fn parse_tasks(v: &Value) -> Vec<TaskItem> {
    items(v, "items")
        .iter()
        .filter_map(|t| {
            Some(TaskItem {
                id: str_at(t, "id").filter(|id| valid_id(id))?.into(),
                title: clean_text(str_at(t, "title").unwrap_or_default(), MAX_TITLE),
                due: str_at(t, "due").map(String::from),
                web_view_link: str_at(t, "webViewLink").map(String::from),
            })
        })
        .collect()
}

/// IDs (≤ 100) de los mensajes que cumplen `q` y si hay más (`nextPageToken`).
pub async fn gmail_unread_ids(http: &oauth2::reqwest::Client, token: &AccessToken, q: &str) -> Result<(Vec<String>, bool)> {
    let v = get_json(
        http,
        token,
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        &[("q", q), ("maxResults", "100"), ("fields", "messages(id),nextPageToken,resultSizeEstimate")],
        "Gmail messages.list",
    )
    .await?;
    let ids = items(&v, "messages").iter().filter_map(|m| str_at(m, "id")).filter(|id| valid_id(id)).map(String::from).collect();
    Ok((ids, v.get("nextPageToken").is_some()))
}

/// Remitente, asunto y fecha de un mensaje. `None` si el ID no es válido o la respuesta no sirve.
pub async fn gmail_message(http: &oauth2::reqwest::Client, token: &AccessToken, id: &str) -> Result<Option<MailItem>> {
    if !valid_id(id) {
        return Ok(None);
    }
    let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}");
    let v = get_json(
        http,
        token,
        &url,
        &[
            ("format", "metadata"),
            ("metadataHeaders", "From"),
            ("metadataHeaders", "Subject"),
            ("fields", "id,internalDate,payload/headers"),
        ],
        "Gmail messages.get",
    )
    .await?;
    Ok(parse_message(&v))
}

/// Eventos de los próximos 7 días del calendario principal (máx. 20).
pub async fn calendar_events(http: &oauth2::reqwest::Client, token: &AccessToken) -> Result<Vec<EventItem>> {
    let (now, week) = (rfc3339(SystemTime::now()), rfc3339(SystemTime::now() + Duration::from_secs(7 * 86400)));
    let max = MAX_AGENDA.to_string();
    let v = get_json(
        http,
        token,
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        &[
            ("timeMin", &now),
            ("timeMax", &week),
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
            ("maxResults", &max),
            ("fields", "items(id,start,summary,htmlLink)"),
        ],
        "Calendar events.list",
    )
    .await?;
    Ok(parse_events(&v))
}

// ponytail: techo de 10 páginas de listas y por lista, 100 páginas totales por consulta,
// con maxResults=100 (como máximo 10 000 tareas); al quedar páginas sin leer se marca parcial.
const MAX_TASK_PAGES: usize = 10;
const TASK_PAGE_BUDGET: usize = 100;

#[derive(Default)]
struct TaskPages {
    tasks: Vec<Value>,
    task_lists: usize,
    partial: bool,
}

/// Los tokens usan la misma longitud y lista blanca que los ids; nunca se siguen URLs.
fn next_task_page(v: &Value) -> Result<Option<String>> {
    match v.get("nextPageToken") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(t)) if valid_id(t) => Ok(Some(t.clone())),
        _ => Err(AuthError::BadResponse("Tasks nextPageToken")),
    }
}

/// Paginador compartido por la CLI y el widget; el lector se sustituye en pruebas sin red.
async fn collect_task_pages<F, Fut>(mut fetch: F) -> Result<TaskPages>
where
    F: FnMut(Option<String>, Option<String>) -> Fut,
    Fut: std::future::Future<Output = Result<Value>>,
{
    let mut result = TaskPages::default();
    let mut lists = Vec::new();
    let mut budget = TASK_PAGE_BUDGET;
    let mut next = None;
    for _ in 0..MAX_TASK_PAGES {
        let page = fetch(None, next.take()).await?;
        budget -= 1;
        for list in items(&page, "items") {
            if let Some(id) = str_at(list, "id").filter(|id| valid_id(id)) {
                lists.push(id.to_string());
            } else {
                result.partial = true;
            }
        }
        next = next_task_page(&page).unwrap_or_else(|_| { result.partial = true; None });
        if next.is_none() { break; }
    }
    result.partial |= next.is_some();
    result.task_lists = lists.len();
    for id in lists {
        if budget == 0 {
            result.partial = true;
            break;
        }
        next = None;
        for _ in 0..MAX_TASK_PAGES {
            let page = fetch(Some(id.clone()), next.take()).await?;
            budget -= 1;
            result.tasks.extend_from_slice(items(&page, "items"));
            next = next_task_page(&page).unwrap_or_else(|_| { result.partial = true; None });
            if next.is_none() || budget == 0 { break; }
        }
        result.partial |= next.is_some();
    }
    Ok(result)
}

async fn task_pages(http: &oauth2::reqwest::Client, token: &AccessToken, include_content: bool) -> Result<TaskPages> {
    task_pages_in_range(http, token, include_content, None).await
}

async fn task_pages_in_range(
    http: &oauth2::reqwest::Client, token: &AccessToken, include_content: bool, due: Option<(&str, &str)>,
) -> Result<TaskPages> {
    collect_task_pages(|list, page| async move {
        let (url, fields, endpoint) = if let Some(id) = list {
            (
                format!("https://tasks.googleapis.com/tasks/v1/lists/{id}/tasks"),
                if due.is_some() { "nextPageToken,items(title,due)" }
                else if include_content { "nextPageToken,items(id,title,due,webViewLink)" } else { "nextPageToken,items(id,due)" },
                "Tasks tasks.list",
            )
        } else {
            ("https://tasks.googleapis.com/tasks/v1/users/@me/lists".into(), "nextPageToken,items(id)", "Tasks tasklists.list")
        };
        let mut query = vec![("maxResults", "100"), ("fields", fields), ("showCompleted", "false"), ("showHidden", "false")];
        // tasklists.list no admite los filtros de tareas.
        if endpoint == "Tasks tasklists.list" { query.truncate(2); }
        else if let Some((min, max)) = due {
            query.extend([("dueMin", min), ("dueMax", max)]);
        }
        if let Some(ref p) = page { query.push(("pageToken", p)); }
        get_json(http, token, &url, &query, endpoint).await
    }).await
}

/// JW-31: límite independiente de la agenda de siete días; sin IDs ni enlaces.
pub const MAX_MONTH_ITEMS: usize = 500;
const MAX_MONTH_PAGES: usize = 5;

pub struct MonthItems {
    pub events: Vec<Value>,
    pub tasks: Vec<Value>,
    pub partial: bool,
}

async fn collect_month_events<F, Fut>(mut fetch: F) -> Result<(Vec<Value>, bool)>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: std::future::Future<Output = Result<Value>>,
{
    let mut events = Vec::new();
    let mut next = None;
    let mut partial = false;
    for _ in 0..MAX_MONTH_PAGES {
        let page = fetch(next.take()).await?;
        let remaining = MAX_MONTH_ITEMS.saturating_sub(events.len());
        partial |= items(&page, "items").len() > remaining;
        events.extend(items(&page, "items").iter().take(remaining).cloned());
        // Calendar usa tokens opacos: solo viajan como parámetro, nunca como URL.
        next = match page.get("nextPageToken") {
            None | Some(Value::Null) => None,
            Some(Value::String(t)) if !t.is_empty() && t.len() <= 4096 => Some(t.clone()),
            _ => { partial = true; None }
        };
        if next.is_none() || events.len() == MAX_MONTH_ITEMS { break; }
    }
    Ok((events, partial || next.is_some()))
}

/// Calendar recibe límites locales RFC 3339; Tasks fechas civiles a medianoche UTC.
/// Solo GET, mismos scopes que la agenda. El paginador JW-20 conserva su presupuesto.
pub async fn month_items(
    http: &oauth2::reqwest::Client, token: &AccessToken,
    time_min: &str, time_max: &str, due_min: &str, due_max: &str,
) -> Result<MonthItems> {
    let (events, partial) = collect_month_events(|page| async move {
        let mut query = vec![
            ("timeMin", time_min), ("timeMax", time_max), ("singleEvents", "true"),
            ("orderBy", "startTime"), ("maxResults", "100"),
            ("fields", "nextPageToken,items(summary,start,end)"),
        ];
        if let Some(ref p) = page { query.push(("pageToken", p)); }
        get_json(http, token, "https://www.googleapis.com/calendar/v3/calendars/primary/events", &query, "Calendar events.list").await
    }).await?;
    let tasks = task_pages_in_range(http, token, true, Some((due_min, due_max))).await?;
    Ok(MonthItems { events, tasks: tasks.tasks, partial: partial || tasks.partial })
}

pub struct PendingTasks {
    pub tasks: Vec<TaskItem>,
    pub total: usize,
    pub partial: bool,
}

fn pending_from_pages(pages: TaskPages) -> PendingTasks {
    let mut all = parse_tasks(&serde_json::json!({"items": pages.tasks}));
    let total = all.len();
    // Primero las que vencen antes; las que no tienen fecha, al final.
    all.sort_by(|a, b| (a.due.is_none(), &a.due).cmp(&(b.due.is_none(), &b.due)));
    all.truncate(MAX_AGENDA);
    PendingTasks { tasks: all, total, partial: pages.partial }
}

/// Tareas pendientes: las 20 primeras por vencimiento, total previo al recorte y cobertura.
pub async fn pending_tasks(http: &oauth2::reqwest::Client, token: &AccessToken) -> Result<PendingTasks> {
    Ok(pending_from_pages(task_pages(http, token, true).await?))
}

/// Fecha/hora UTC en RFC 3339 (`2026-10-18T09:30:00Z`) sin crates de fechas.
pub(crate) fn rfc3339(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Algoritmo civil_from_days de Howard Hinnant.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn month_event_pages_bound_items_and_follow_empty_pages() {
        for more in [false, true] {
            let mut calls = 0;
            let (events, partial) = collect_month_events(|token| {
                calls += 1;
                assert_eq!(token, (calls > 1).then(|| "opaque/+=".into()));
                let mut page = serde_json::json!({"items": (0..100).map(|i|
                    serde_json::json!({"summary": format!("{calls}-{i}")})).collect::<Vec<_>>()});
                if calls < MAX_MONTH_PAGES || more { page["nextPageToken"] = serde_json::json!("opaque/+="); }
                std::future::ready(Ok(page))
            }).await.unwrap();
            assert_eq!((calls, events.len(), partial), (MAX_MONTH_PAGES, MAX_MONTH_ITEMS, more));
        }
        let mut calls = 0;
        let (events, partial) = collect_month_events(|_| {
            calls += 1;
            std::future::ready(Ok(if calls == 1 { serde_json::json!({"nextPageToken": "next"}) }
                else { serde_json::json!({"items": [{"summary": "final"}]}) }))
        }).await.unwrap();
        assert_eq!((calls, events.len(), partial), (2, 1, false));
    }

    #[tokio::test]
    async fn month_event_malformed_or_endless_pages_are_partial() {
        for token in [serde_json::json!(7), serde_json::json!(""), serde_json::json!("x".repeat(4097))] {
            let (_, partial) = collect_month_events(|_| std::future::ready(Ok(serde_json::json!({"nextPageToken": token})))).await.unwrap();
            assert!(partial);
        }
        let mut calls = 0;
        let (_, partial) = collect_month_events(|_| {
            calls += 1;
            std::future::ready(Ok(serde_json::json!({"nextPageToken": "same"})))
        }).await.unwrap();
        assert_eq!(calls, MAX_MONTH_PAGES);
        assert!(partial);
        let (events, partial) = collect_month_events(|_| std::future::ready(Ok(serde_json::json!({
            "items": vec![serde_json::json!({}); MAX_MONTH_ITEMS + 1]
        })))).await.unwrap();
        assert_eq!(events.len(), MAX_MONTH_ITEMS);
        assert!(partial);
    }

    #[test]
    fn formats_rfc3339() {
        assert_eq!(rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(UNIX_EPOCH + Duration::from_secs(951_782_400)), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(UNIX_EPOCH + Duration::from_secs(1_792_312_245)), "2026-10-18T08:30:45Z");
    }

    use serde_json::json;

    #[tokio::test]
    async fn task_pages_accumulate_lists_and_tasks_before_truncating() {
        let tasks = |start: usize, due: &str| json!({"items": (start..start + 15).map(|i|
            json!({"id": format!("t{i}"), "due": due})).collect::<Vec<_>>()});
        let mut first = tasks(0, "2026-11-01");
        first["nextPageToken"] = json!("tasks_2=");
        let mut pages = std::collections::VecDeque::from([
            (None, None, json!({"items": [{"id": "a"}], "nextPageToken": "lists_2="})),
            (None, Some("lists_2=".into()), json!({"items": [{"id": "b"}]})),
            (Some("a".into()), None, first),
            (Some("a".into()), Some("tasks_2=".into()), tasks(15, "2026-10-01")),
            (Some("b".into()), None, json!({"items": [{"id": "undated"}]})),
        ]);
        let result = collect_task_pages(|list, token| {
            let (expected_list, expected_token, page) = pages.pop_front().unwrap();
            assert_eq!((list, token), (expected_list, expected_token));
            std::future::ready(Ok(page))
        }).await.unwrap();
        assert!(pages.is_empty());
        assert_eq!(result.task_lists, 2);
        let result = pending_from_pages(result);
        assert_eq!(result.total, 31);
        assert_eq!(result.tasks.len(), MAX_AGENDA);
        assert_eq!(result.tasks[0].id, "t15");
        assert_eq!(result.tasks[15].id, "t0");
        assert!(!result.partial);
    }

    #[tokio::test]
    async fn task_page_cap_marks_partial_only_with_more_pages() {
        for more in [false, true] {
            let mut calls = 0;
            let result = collect_task_pages(|list, _| {
                calls += 1;
                let page = if list.is_none() {
                    json!({"items": [{"id": "a"}]})
                } else {
                    let mut page = json!({"items": [{"id": format!("t{calls}")}]});
                    if more || calls <= MAX_TASK_PAGES { page["nextPageToken"] = json!("next"); }
                    page
                };
                std::future::ready(Ok(page))
            }).await.unwrap();
            assert_eq!(calls, MAX_TASK_PAGES + 1);
            assert_eq!(result.tasks.len(), MAX_TASK_PAGES);
            assert_eq!(result.partial, more);
        }
    }

    #[tokio::test]
    async fn tasklist_page_cap_marks_partial() {
        let mut list_calls = 0;
        let mut task_calls = 0;
        let result = collect_task_pages(|list, _| {
            let page = if list.is_none() {
                list_calls += 1;
                json!({"items": [{"id": format!("l{list_calls}")}], "nextPageToken": "next"})
            } else {
                task_calls += 1;
                json!({"items": [{"id": format!("t{task_calls}")}]})
            };
            std::future::ready(Ok(page))
        }).await.unwrap();
        assert_eq!((list_calls, task_calls), (MAX_TASK_PAGES, MAX_TASK_PAGES));
        assert!(result.partial);
    }

    #[tokio::test]
    async fn task_refresh_budget_includes_tasklists_and_unvisited_lists() {
        for lists in [TASK_PAGE_BUDGET - 1, TASK_PAGE_BUDGET] {
            let mut calls = 0;
            let result = collect_task_pages(|list, _| {
                calls += 1;
                std::future::ready(Ok(if list.is_none() {
                    json!({"items": (0..lists).map(|i| json!({"id": format!("l{i}")})).collect::<Vec<_>>()})
                } else { json!({"items": [{"id": format!("t{calls}")}]}) }))
            }).await.unwrap();
            assert_eq!(calls, TASK_PAGE_BUDGET);
            assert_eq!(result.tasks.len(), TASK_PAGE_BUDGET - 1);
            assert_eq!(result.partial, lists == TASK_PAGE_BUDGET);
        }
    }

    #[tokio::test]
    async fn task_tokens_reject_invalid_values_before_another_request() {
        // Un token inesperado no rompe la agenda: se deja de paginar y se marca parcial.
        for token in [json!("a/b"), json!("a&b"), json!(""), json!("ñ"), json!("a".repeat(257)), json!(7)] {
            let mut calls = 0;
            let result = collect_task_pages(|_, _| {
                calls += 1;
                std::future::ready(Ok(json!({"nextPageToken": token})))
            }).await.unwrap();
            assert!(result.partial);
            assert_eq!(calls, 1);
        }
    }

    #[test]
    fn valid_id_rejects_path_tricks() {
        for bad in ["", "a/b", "a?b", "a#b", "..", "a b", "a.b", "a%2Fb", "ñ"] {
            assert!(!valid_id(bad), "{bad:?}");
        }
        assert!(!valid_id(&"a".repeat(257)));
        assert!(valid_id(&"a".repeat(256)));
        for ok in ["18c2f0a1b2c3d4e5", "abc_20261022T100000Z", "MDk2NjA3-x_y=", "Z"] {
            assert!(valid_id(ok), "{ok:?}");
        }
    }

    #[test]
    fn safe_link_only_google_https() {
        assert!(safe_link("https://www.google.com/calendar/event?eid=abc").is_some());
        assert!(safe_link("https://tasks.google.com/task/xyz").is_some());
        for bad in [
            "http://www.google.com/calendar/event",
            "https://evil.example.com/",
            "https://www.google.com.evil.com/",
            "javascript:alert(1)",
            "https://user:pw@www.google.com/",
            "https://www.google.com:8443/",
            "file:///C:/Windows",
            "",
        ] {
            assert!(safe_link(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn sender_label_never_shows_address() {
        assert_eq!(sender_label("\"Ana Pérez\" <ana@example.com>"), "Ana Pérez");
        assert_eq!(sender_label("Banco <avisos@mail.example.net>"), "Banco");
        assert_eq!(sender_label("ana@Example.com"), "example.com");
        assert_eq!(sender_label("<ana@example.com>"), "example.com");
        assert_eq!(sender_label("\"ana@example.com\" <ana@example.com>"), "example.com");
        assert_eq!(sender_label(""), "Remitente desconocido");
        assert_eq!(sender_label(&format!("{} <a@b.c>", "é".repeat(100))).chars().count(), MAX_FROM);
    }

    #[test]
    fn clean_text_removes_invisible_ranges_before_limits() {
        let ranges = [0x00ad..=0x00ad, 0x061c..=0x061c, 0x180e..=0x180e,
            0x200b..=0x200f, 0x2028..=0x202e, 0x2060..=0x2064, 0x2066..=0x206f,
            0xfe00..=0xfe0f, 0xfeff..=0xfeff, 0xe0000..=0xe007f, 0xe0100..=0xe01ef];
        for c in ranges.into_iter().flatten().filter_map(char::from_u32)
            .chain(['\0', '\n', '\r', '\t', '\u{0085}']) {
            assert_eq!(clean_text(&format!("{c} é{c}界{c}🧪 {c}"), 3), "é界🧪", "U+{:04X}", c as u32);
        }
        assert_eq!(clean_text(&format!("{}Visible", "\u{200b}".repeat(120)), 120), "Visible");
    }

    #[test]
    fn parse_message_handles_bad_input() {
        let subject = "x".repeat(10_000);
        let m = parse_message(&json!({
            "id": "18c2f0a1", "internalDate": "1792312245000",
            "payload": {"headers": [{"name": "from", "value": "Ana <ana@example.com>"}, {"name": "Subject", "value": subject}]}
        }))
        .unwrap();
        assert_eq!((m.from.as_str(), m.subject.len(), m.internal_date), ("Ana", MAX_TITLE, Some(1_792_312_245_000)));
        // Multibyte justo en el límite: 119 ASCII + «ñ» (2 bytes) y más.
        let s = format!("{}ñññ", "a".repeat(MAX_TITLE - 1));
        let m = parse_message(&json!({"id": "a", "payload": {"headers": [{"name": "Subject", "value": s}]}})).unwrap();
        assert!(m.subject.ends_with('ñ') && m.subject.chars().count() == MAX_TITLE);
        // Campos ausentes, nulls y tipos erróneos: sin pánico.
        let m = parse_message(&json!({"id": "a", "internalDate": 5, "payload": {"headers": [{"name": 1, "value": null}, 7]}})).unwrap();
        assert_eq!((m.subject.as_str(), m.internal_date), ("", None));
        assert_eq!(parse_message(&json!({"id": "a", "internalDate": "x"})).unwrap().internal_date, None);
        assert!(parse_message(&json!({"id": "a/b"})).is_none());
        assert!(parse_message(&json!({"id": null})).is_none());
        assert!(parse_message(&json!([])).is_none());
        assert!(parse_message(&json!({"id": "a", "payload": null})).is_some());
        // Solo se serializan id, from, subject y date.
        let out = serde_json::to_value(parse_message(&json!({"id": "a"})).unwrap()).unwrap();
        assert_eq!(out.as_object().unwrap().len(), 4);
        assert!(out.get("date").is_some());
    }

    #[test]
    fn parse_events_and_tasks() {
        let v = json!({"items": [
            {"id": "e1", "summary": "Reunión", "start": {"dateTime": "2026-10-22T10:00:00-05:00"}, "htmlLink": "https://www.google.com/calendar/event?eid=1"},
            {"id": "e2", "start": {"date": "2026-10-23"}},
            {"id": "bad/id", "start": {"date": "2026-10-23"}},
            {"id": 3}, null, {"start": 5}
        ]});
        let e = parse_events(&v);
        assert_eq!(e.len(), 2);
        assert!(!e[0].all_day && e[1].all_day && e[1].title.is_empty() && e[1].start == "2026-10-23");
        let out = serde_json::to_value(&e[0]).unwrap();
        assert!(out.get("htmlLink").is_none() && out.get("allDay").is_some());
        let many = json!({"items": (0..50).map(|i| json!({"id": format!("e{i}")})).collect::<Vec<_>>()});
        assert_eq!(parse_events(&many).len(), MAX_AGENDA);
        assert!(parse_events(&json!({"items": "x"})).is_empty());
        assert!(parse_events(&json!(null)).is_empty());

        let t = parse_tasks(&json!({"items": [
            {"id": "t1", "title": "x".repeat(500), "due": "2026-10-25T00:00:00.000Z", "webViewLink": "https://tasks.google.com/task/t1"},
            {"id": "t2", "title": null, "due": 7}, {"id": ""}
        ]}));
        assert_eq!(t.len(), 2);
        assert_eq!((t[0].title.chars().count(), t[1].due.clone()), (MAX_TITLE, None));
        assert!(serde_json::to_value(&t[0]).unwrap().get("webViewLink").is_none());
    }
}
