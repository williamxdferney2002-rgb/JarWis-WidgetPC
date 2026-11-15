// Hoy: resumen con feeds de la barra, clima manual y acciones de concentración y espacios.
import { useRef, useState } from "react";
import { mediaOpen, weatherOpen, useTick, useBarVisible, openSettings, openFocusSettings, openWorkspace, type AgendaView, type Feed, type MailView, type MediaTarget, type Workspace, type WeatherPlace, type WeatherView } from "./api";
import { Icon } from "./icons";
import { TASKS_PARTIAL_TITLE } from "./Agenda";
import { workspaceLook } from "./Shortcuts";
import { ago } from "./Mail";

const launchers: { target: MediaTarget; label: string; icon: string }[] = [
  { target: "telegram", label: "Telegram", icon: "telegram" },
  { target: "whatsapp", label: "WhatsApp", icon: "whatsapp" },
  { target: "spotify", label: "Spotify", icon: "waves" },
  { target: "netflix", label: "Netflix", icon: "netflix" },
  { target: "youtube", label: "YouTube", icon: "video" },
];

const pad = (n: number) => String(n).padStart(2, "0");
/** AAAA-MM-DD local de una fecha. */
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Sin datos: «Sin sesión» si Google no está conectado; si no, «—» (cargando o error pasajero). */
function missing(feed: Feed<unknown> | null): string {
  const k = feed?.error?.kind;
  return k === "signedOut" || k === "expired" || k === "config" ? "Sin sesión" : "—";
}

function syncLabel(feed: Feed<unknown> | null): string {
  if (feed?.error) return `${feed.error.message}${feed.data && feed.updatedAt ? ` · datos de ${ago(feed.updatedAt)}` : ""}`;
  return feed?.updatedAt ? `actualizado ${ago(feed.updatedAt)}` : "cargando…";
}

/** Resumen clicable: abre el panel de origen (correo o agenda). */
function Card({ id, label, value, detail, partial, onOpen }: { id: string; label: string; value: string; detail: string; partial?: boolean; onOpen: () => void }) {
  return (
    <section className="col stat stat-btn today-clickable" data-today={id} aria-labelledby={`today-${id}-heading`}>
      <span id={`today-${id}-heading`} className="muted" role="heading" aria-level={2}>{label}</span>
      <strong id={`today-${id}-value`} className="stat-value mono">{value}{partial && <span title={TASKS_PARTIAL_TITLE} aria-label={TASKS_PARTIAL_TITLE}>+</span>}</strong>
      <span id={`today-${id}-detail`} className="muted mono">{detail}</span>
      <button type="button" className="today-card-action" aria-labelledby={`today-${id}-heading today-${id}-value`} aria-describedby={`today-${id}-detail`} title={`Abrir ${id === "mail" ? "correo" : "calendario"}`} onClick={onOpen} />
    </section>
  );
}

/** Códigos WMO de Open-Meteo, con alternativa comprensible si llegan datos nuevos. */
export function weatherDescription(code: number, isDay: boolean): [string, string] {
  if (code === 0) return [isDay ? "Despejado" : "Noche despejada", isDay ? "today" : "moon"];
  if (code === 1) return ["Mayormente despejado", isDay ? "today" : "moon"];
  if (code === 2) return ["Parcialmente nublado", "cloud"];
  if (code === 3) return ["Cubierto", "cloud"];
  if ([45, 48].includes(code)) return ["Niebla", "fog"];
  if ([51, 53, 55].includes(code)) return ["Llovizna", "rain"];
  if ([56, 57].includes(code)) return ["Llovizna helada", "rain"];
  if ([61, 63, 65].includes(code)) return ["Lluvia", "rain"];
  if ([66, 67].includes(code)) return ["Lluvia helada", "rain"];
  if ([71, 73, 75, 77].includes(code)) return ["Nieve", "snow"];
  if ([80, 81, 82].includes(code)) return ["Chubascos", "rain"];
  if ([85, 86].includes(code)) return ["Chubascos de nieve", "snow"];
  if ([95, 96, 99].includes(code)) return ["Tormenta", "storm"];
  return ["Clima no disponible", "cloud"];
}
function WeatherCard({ feed, place, onError }: { feed: Feed<WeatherView> | null; place: WeatherPlace | null; onError: (e: unknown) => void }) {
  const data = place ? feed?.data : null;
  const [description, icon] = weatherDescription(data?.weatherCode ?? -1, data?.isDay ?? true);
  const degrees = (n: number | null) => n === null ? "—" : `${Math.round(n)}°`;
  return <article className="today-tile weather-card" aria-label="Clima" data-weather>
    <span className="today-tile-heading"><Icon name={data ? icon : "cloud"} size={18} /><strong role="heading" aria-level={2}>Clima</strong><span className="muted ellipsis" title={place?.name}>{place?.name}</span></span>
    {!place ? <><p className="muted">Elige tu ciudad en Ajustes</p><button className="btn ghost" onClick={() => openSettings().catch(onError)}>Abrir Ajustes</button></> : <>
      {data && <><div className="weather-current"><strong>{degrees(data.temperature)}</strong><span>{description}</span></div><p className="weather-detail muted">Máx. {degrees(data.maximum)} · Mín. {degrees(data.minimum)} · Lluvia {data.rainProbability === null ? "—" : `${Math.round(data.rainProbability)} %`}</p></>}
      {feed?.error && <p role="status" className="weather-note" data-kind={feed.error.kind}>{feed.error.message}</p>}
      <span className="muted weather-updated">{feed?.updatedAt ? `actualizado ${ago(feed.updatedAt)}` : feed?.error ? "Sin datos actualizados" : "Cargando clima…"}</span>
    </>}
    <span className="weather-attribution muted">Datos meteorológicos de <button type="button" className="weather-link" onClick={() => weatherOpen("provider").catch(onError)}>Open-Meteo.com</button> · <button type="button" className="weather-link" onClick={() => weatherOpen("licence").catch(onError)}>CC BY 4.0</button></span>
  </article>;
}

export function TodayPanel({
  mail,
  agenda,
  weather,
  weatherPlace,
  workspaces,
  onOpen,
  onClose,
  onError,
}: {
  mail: Feed<MailView> | null;
  agenda: Feed<AgendaView> | null;
  workspaces: Workspace[];
  weather: Feed<WeatherView> | null;
  weatherPlace: WeatherPlace | null;
  onOpen: (panel: "mail" | "calendar") => void;
  onClose: () => void;
  onError: (e: unknown) => void;
}) {
  const visible = useBarVisible();
  useTick(visible && !!weatherPlace, 60_000);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const opening = useRef(new Set<number>());
  const [busy, setBusy] = useState<number[]>([]);
  const run = (job: Promise<void>) => job.then(() => setErr(null), (e) => setErr(String(e)));
  const open = async (id: number) => {
    if (opening.current.has(id)) return;
    opening.current.add(id);
    setBusy([...opening.current]);
    setErr(null);
    setNotice(null);
    try {
      setNotice(await openWorkspace(id));
    } catch (e) {
      setErr(String(e));
    } finally {
      opening.current.delete(id);
      setBusy([...opening.current]);
    }
  };
  const now = new Date();
  const today = ymd(now);

  const m = mail?.data;
  const unreadCount = m ? m.inboxUnread + m.outlookUnread : 0;
  const unread = m ? `${m.inboxUnread + m.outlookUnread}${m.inboxMore || m.outlookMore ? "+" : ""}` : missing(mail);

  const a = agenda?.data;
  // Eventos: hora local de inicio; todo el día: el texto AAAA-MM-DD tal cual.
  const events = a?.events.filter((e) => (e.allDay ? e.start.slice(0, 10) : ymd(new Date(e.start))) === today).length;
  // Tareas: prefijo AAAA-MM-DD de `due` sin convertir zona horaria (Google lo guarda a las 00:00Z).
  const tasks = a?.tasks.filter((t) => t.due && t.due.slice(0, 10) <= today).length;
  const overdue = a?.tasks.filter((t) => t.due && t.due.slice(0, 10) < today).length ?? 0;
  const upcoming = a?.tasks.filter((t) => t.due && t.due.slice(0, 10) > today).length ?? 0;
  const undated = a?.tasks.filter((t) => !t.due).length ?? 0;
  // Próximo evento: los de hoy (con hora aún no empezada, luego los de todo el día) van antes que los de días posteriores.
  const dayOf = (e: { start: string; allDay: boolean }) => e.allDay ? e.start.slice(0, 10) : ymd(new Date(e.start));
  const rank = (e: { start: string; allDay: boolean }) => dayOf(e) === today ? (e.allDay ? 1 : 0) : 2;
  const at = (e: { start: string; allDay: boolean }) => e.allDay ? 0 : Date.parse(e.start);
  const next = a?.events.filter((e) => e.allDay ? e.start.slice(0, 10) >= today : new Date(e.start) >= now)
    .sort((l, r) => rank(l) - rank(r) || dayOf(l).localeCompare(dayOf(r)) || at(l) - at(r))[0];
  const nextDay = next && dayOf(next);
  const nextTime = next ? next.allDay ? "Todo el día" : new Date(next.start).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }) : "—";
  // El resumen por fecha solo ve las 20 tareas visibles; indicar también ese recorte.
  const tasksPartial = !!a && (a.tasksPartial || a.pendingTasks > a.tasks.length);

  const taskDetails = [
    overdue > 0 && `${overdue} ${overdue === 1 ? "vencida" : "vencidas"}`,
    (tasks ?? 0) - overdue > 0 && `${(tasks ?? 0) - overdue} hoy`,
    upcoming > 0 && `${upcoming} ${upcoming === 1 ? "próxima" : "próximas"}`,
    undated > 0 && `${undated} sin fecha`,
  ].filter(Boolean).join(" · ");
  const taskCount = a ? Math.max(a.pendingTasks, a.tasks.length) : 0;

  return (
    <section className="panel-view today-panel" aria-label="Hoy">
      <header className="panel-head">
        <div className="today-heading">
          <strong className="panel-title" role="heading" aria-level={1}><Icon name="today" size={14} />Hoy</strong>
          <time className="today-date" dateTime={today}>{now.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" })}</time>
        </div>
        <button className="icon-btn" data-action="close-panel" title="Cerrar" aria-label="Cerrar" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="today-body">
        <WeatherCard feed={weather} place={weatherPlace} onError={onError} />
        {(next || (events ?? 0) > 0 || !a || agenda?.error) && <div className="today-event-block" data-today-block="event">
        {next && <section className="today-next today-clickable" data-today="next" aria-labelledby="today-next-heading">
          <span id="today-next-time" className="today-next-time mono">{nextTime}</span>
          <span className="today-next-copy">
            <span id="today-next-heading" className="muted today-caption" role="heading" aria-level={2}>{nextDay && nextDay !== today ? `Próximo evento · ${new Date(Number(nextDay.slice(0, 4)), Number(nextDay.slice(5, 7)) - 1, Number(nextDay.slice(8, 10))).toLocaleDateString("es", { weekday: "short", day: "numeric", month: "short" })}` : "Próximo evento"}</span>
            <strong id="today-next-title" className="ellipsis" title={next.title}>{next.title.trim() || "Evento sin título"}</strong>
          </span>
          <Icon name="calendar" size={18} />
          <button type="button" className="today-card-action" aria-labelledby="today-next-heading today-next-title" aria-describedby="today-next-time" onClick={() => onOpen("calendar")} title="Abrir calendario" />
        </section>}
        {(events ?? 0) > 0 && <p className="muted today-event-count" data-today="events">{events} {events === 1 ? "evento del día" : "eventos del día"}</p>}
        {(!a || agenda?.error) && <p role="status" className="cloud-note">Agenda: {syncLabel(agenda)}</p>}
        </div>}
        {(taskCount > 0 || !a || agenda?.error) && <div className="today-grid" data-today-block="tasks">
          <Card id="tasks" label="Tareas" value={a && taskCount > 0 ? `${taskCount} ${taskCount === 1 ? "tarea" : "tareas"}` : missing(agenda)} detail={taskDetails} partial={tasksPartial && taskCount > 0} onOpen={() => onOpen("calendar")} />
          {(!a || agenda?.error) && <p role="status" className="cloud-note">Tareas: {syncLabel(agenda)}</p>}
        </div>}
        {(unreadCount > 0 || !m || mail?.error) && <div className="today-grid" data-today-block="mail">
          <Card id="mail" label="Correos" value={m && unreadCount > 0 ? unread : missing(mail)} detail={unreadCount > 0 ? "sin leer" : ""} onOpen={() => onOpen("mail")} />
          {(!m || mail?.error) && <p role="status" className="cloud-note">Correos: {syncLabel(mail)}</p>}
        </div>}
        {err && (
          <p role="alert" className="cloud-note" data-kind="other" data-today-error>
            {err}
          </p>
        )}
        {notice && <p role="status" className="cloud-note">{notice}</p>}
        <div className="today-feature-grid">
          <article className="today-tile focus-card" aria-label="Concentración">
            <span className="today-tile-heading"><Icon name="focus" size={18} /><strong>Concentración</strong></span>
            <p className="muted">Configura tus momentos sin interrupciones en Windows.</p>
            <button className="btn ghost" data-action="focus" onClick={() => run(openFocusSettings())}>Abrir ajustes</button>
          </article>
        </div>
        <div className="today-workspaces" role="group" aria-label="Espacios de trabajo">
          {workspaces.map((w) => {
            const look = workspaceLook(w);
            const isBusy = busy.includes(w.id);
            return <article key={w.id} className="today-tile workspace-card" data-color={look.color} data-icon={look.icon} aria-label={w.name}>
              <span className="workspace-mark"><Icon name={look.icon} size={20} /></span>
              <div className="workspace-copy"><strong className="ellipsis" title={w.name}>{w.name}</strong>{w.shortcuts.length > 0 && <span className="muted">{w.shortcuts.length} {w.shortcuts.length === 1 ? "acceso" : "accesos"}</span>}</div>
              <button className="btn ghost" data-workspace={w.id} title={w.name} aria-label={`${isBusy ? "Abriendo" : "Abrir"} ${w.name}`} disabled={isBusy} aria-busy={isBusy} onClick={() => void open(w.id)}>{isBusy ? "Abriendo…" : "Abrir"}</button>
            </article>;
          })}
        </div>
        {workspaces.length === 0 && (
          <p className="cloud-note" data-note="no-workspaces">
            Sin espacios de trabajo: créalos en Ajustes.
          </p>
        )}
        <p className="today-sync muted" data-today-sync>Correo: {syncLabel(mail)} · Agenda: {syncLabel(agenda)}</p>
      </div>
      <div className="today-launchers launchers" role="group" aria-label="Accesos rápidos de aplicaciones">
        {launchers.map(({ target, label, icon }) => (
          <button key={target} className="launch-btn" data-launch={target} data-brand={target} onClick={() => mediaOpen(target).catch(onError)}>
            <Icon name={icon} size={16} />{label}
          </button>
        ))}
      </div>
    </section>
  );
}
