// Widget Calendario (Fase 4): eventos de 7 días y tareas pendientes de Google.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { CLOUD_EVENT, cloudAgenda, cloudMonth, cloudOpen, type AgendaView, type Feed, type MonthView } from "./api";
import { Icon } from "./icons";
import { CloudNote, RefreshBtn } from "./Mail";

export const TASKS_PARTIAL_TITLE = "Hay más tareas de las que se pudieron contar";

/** AAAA-MM-DD (o RFC 3339: solo la fecha) como día local, sin desfase por la zona horaria. */
const day = (s: string) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const dayLabel = (s: string) => day(s).toLocaleDateString("es", { weekday: "short", day: "numeric", month: "short" });

function when(start: string, allDay: boolean): string {
  if (allDay) return `${dayLabel(start)} · todo el día`;
  const local = new Date(start);
  return `${local.toLocaleDateString("es", { weekday: "short", day: "numeric", month: "short" })} · ${local.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}`;
}

type PanelProps = { feed: Feed<AgendaView> | null; onClose: () => void; onError: (e: unknown) => void };

export function AgendaPanel(props: PanelProps) {
  const [view, setView] = useState<"month" | "agenda">("month");
  return view === "month" ? <MonthPanel onClose={props.onClose} onError={props.onError} onAgenda={() => setView("agenda")} />
    : <AgendaList {...props} onMonth={() => setView("month")} />;
}

function AgendaList({ feed, onClose, onError, onMonth }: PanelProps & { onMonth: () => void }) {
  const d = feed?.data;
  const more = d ? d.pendingTasks - d.tasks.length : 0;
  return (
    <section className="panel-view" aria-label="Calendario">
      <header className="panel-head">
        <strong className="panel-title">
          <Icon name="calendar" size={14} />
          Calendario
        </strong>
        <button className="btn ghost" onClick={onMonth}>Ver mes</button>
        <RefreshBtn feed={feed} load={cloudAgenda} />
        <button className="icon-btn" data-action="close-panel" title="Cerrar" aria-label="Cerrar" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <CloudNote feed={feed} onError={onError} />
      {d?.tasksPartial && <p className="cloud-note" title={TASKS_PARTIAL_TITLE} aria-label={TASKS_PARTIAL_TITLE}>Tareas: parcial</p>}
      {d && (
        <ul className="list" aria-label="Eventos y tareas">
          {d.events.length + d.tasks.length === 0 && !d.tasksPartial && <li className="empty">Nada pendiente en los próximos 7 días.</li>}
          {d.events.map((e) => (
            <li key={`e${e.id}`} data-event={e.id}>
              <button className="shortcut-btn cloud-item grow" title="Abrir en el navegador" onClick={() => cloudOpen("event", e.id).catch(onError)}>
                <span className="ellipsis" title={e.title}>{e.title}</span>
                <span className="ellipsis muted">{when(e.start, e.allDay)}</span>
              </button>
            </li>
          ))}
          {d.tasks.map((t) => (
            <li key={`t${t.id}`} data-task={t.id}>
              <button className="shortcut-btn cloud-item grow" title="Abrir en el navegador" onClick={() => cloudOpen("task", t.id).catch(onError)}>
                <span className="ellipsis" title={t.title}>{t.title}</span>
                <span className="ellipsis muted">Tarea{t.due ? ` · vence ${dayLabel(t.due)}` : ""}</span>
              </button>
            </li>
          ))}
          {more > 0 && <li className="empty muted">y {more} tareas más</li>}
        </ul>
      )}
    </section>
  );
}

const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const fullDate = (date: Date) => capitalize(date.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
const addDays = (date: Date, count: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
const addMonth = (date: Date, count: number) => {
  const first = new Date(date.getFullYear(), date.getMonth() + count, 1);
  return new Date(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()));
};

function MonthPanel({ onClose, onError, onAgenda }: Pick<PanelProps, "onClose" | "onError"> & { onAgenda: () => void }) {
  const today = new Date();
  const [cursor, setCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  const [selected, setSelected] = useState(cursor);
  const [feed, setFeed] = useState<Feed<MonthView> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);
  const retry = useRef(false);
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const allowed = (date: Date) => Math.abs(date.getFullYear() - today.getFullYear()) <= 2;
  useEffect(() => {
    let alive = true;
    let sequence = 0;
    const load = () => {
      const current = ++sequence;
      const force = retry.current;
      retry.current = false;
      setFeed(null);
      void cloudMonth(year, month + 1, force).then((value) => {
        if (!alive || current !== sequence) return;
        // Feed vacío: otra consulta del mismo mes sigue en curso; se vuelve a pedir.
        if (!value.data && !value.error) setTimeout(() => { if (alive && current === sequence) load(); }, 1000);
        else setFeed(value);
      }, () => {
        if (alive && current === sequence) setFeed({ data: null, updatedAt: null, error: { kind: "other", message: "No se pudo cargar el mes. Vuelve a intentarlo." } });
      });
    };
    // Invalidar también la respuesta pendiente de la cuenta anterior.
    const un = listen(CLOUD_EVENT, () => { if (alive) load(); });
    void un.then(() => { if (alive) load(); }, () => { if (alive) load(); });
    return () => { alive = false; sequence += 1; void un.then((stop) => stop(), () => undefined); };
  }, [year, month, attempt]);
  useEffect(() => {
    if (focusPending.current) {
      grid.current?.querySelector<HTMLButtonElement>(`[data-date="${dateKey(cursor)}"]`)?.focus();
      focusPending.current = false;
    }
  }, [cursor]);
  const move = (next: Date, select = false, focus = true) => {
    if (!allowed(next)) return;
    focusPending.current = focus;
    if (select || next.getMonth() !== month || next.getFullYear() !== year) setSelected(next);
    setCursor(next);
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, date: Date) => {
    const weekday = (date.getDay() + 6) % 7;
    const next = event.key === "ArrowLeft" ? addDays(date, -1) : event.key === "ArrowRight" ? addDays(date, 1)
      : event.key === "ArrowUp" ? addDays(date, -7) : event.key === "ArrowDown" ? addDays(date, 7)
      : event.key === "Home" ? addDays(date, -weekday) : event.key === "End" ? addDays(date, 6 - weekday)
      : event.key === "PageUp" ? addMonth(date, -1) : event.key === "PageDown" ? addMonth(date, 1) : null;
    if (next) { event.preventDefault(); move(next); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); move(date, true); }
  };
  const first = new Date(year, month, 1);
  const start = addDays(first, -(first.getDay() + 6) % 7);
  const monthLabel = capitalize(first.toLocaleDateString("es", { month: "long", year: "numeric" }));
  const content = feed?.data?.days[dateKey(selected)];
  return (
    <section className="panel-view month-panel" aria-label="Calendario">
      <header className="panel-head">
        <strong className="panel-title"><Icon name="calendar" size={14} />Calendario</strong>
        <button className="btn ghost" onClick={onAgenda}>Ver agenda</button>
        <button className="icon-btn" data-action="close-panel" title="Cerrar" aria-label="Cerrar" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="month-body">
        <div className="month-cal">
        <div className="month-nav">
          <button className="icon-btn" aria-label="Mes anterior" title="Mes anterior" disabled={!allowed(addMonth(cursor, -1))} onClick={() => move(addMonth(cursor, -1), true, false)}>‹</button>
          <strong id="month-label" aria-live="polite">{monthLabel}</strong>
          <button className="icon-btn" aria-label="Mes siguiente" title="Mes siguiente" disabled={!allowed(addMonth(cursor, 1))} onClick={() => move(addMonth(cursor, 1), true, false)}>›</button>
        </div>
        <div ref={grid} className="month-grid" role="grid" aria-labelledby="month-label" aria-describedby="month-help" aria-busy={!feed}>
          <div role="row" className="month-week">
            {["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"].map((label) => <span role="columnheader" aria-label={label} key={label}>{label.slice(0, 1).toUpperCase()}</span>)}
          </div>
          {Array.from({ length: 6 }, (_, week) => <div role="row" className="month-week" key={week}>
            {Array.from({ length: 7 }, (_, weekday) => {
              const date = addDays(start, week * 7 + weekday);
              const key = dateKey(date);
              const data = date.getMonth() === month ? feed?.data?.days[key] : undefined;
              const events = data?.events.length ?? 0;
              const tasks = data?.tasks.length ?? 0;
              return <div role="gridcell" aria-selected={key === dateKey(selected)} key={key}>
                <button className="month-day" data-date={key} data-outside={date.getMonth() !== month || undefined} aria-current={key === dateKey(today) ? "date" : undefined}
                  aria-label={`${fullDate(date)}${events ? `, ${events} ${events === 1 ? "evento" : "eventos"}` : ""}${tasks ? `, ${tasks} ${tasks === 1 ? "tarea" : "tareas"}` : ""}`}
                  tabIndex={key === dateKey(cursor) ? 0 : -1} disabled={!allowed(date)} onKeyDown={(event) => keyDown(event, date)} onClick={() => move(date, true)}>
                  {date.getDate()}<span className="month-marks" aria-hidden="true">{events > 0 && <i data-mark="event" />}{tasks > 0 && <i data-mark="task" />}</span>
                </button>
              </div>;
            })}
          </div>)}
        </div>
        <p className="month-help muted" id="month-help">Flechas: día · RePág/AvPág: mes · Inicio/Fin: semana · Intro/Espacio: seleccionar</p>
        </div>
        <div className="month-pane">
        <CloudNote feed={feed} onError={onError} connectLabel="Conectar cuenta" />
        {feed?.error && !["signedOut", "expired", "config"].includes(feed.error.kind) && <button className="btn ghost" onClick={() => { retry.current = true; setAttempt((value) => value + 1); }}>Reintentar</button>}
        {feed?.data?.partial && <p role="status" className="cloud-note" data-month-partial>Mes parcial: puede haber más eventos o tareas.</p>}
        <h3 className="month-selected" id="selected-day-label">{fullDate(selected)}</h3>
        {feed?.data && <ul className="list month-list" aria-labelledby="selected-day-label">
          {!content?.events.length && !content?.tasks.length && <li className="empty">{feed.data.partial ? "Sin elementos en los datos disponibles." : "Sin eventos ni tareas para este día."}</li>}
          {content?.events.map((event, index) => <li className="cloud-item" data-month-event key={`e${index}`}><span className="ellipsis" title={event.title}>{event.title || "Sin título"}</span><span className="muted">{when(event.start, event.allDay)}</span></li>)}
          {content?.tasks.map((task, index) => <li className="cloud-item" data-month-task key={`t${index}`}><span className="ellipsis" title={task.title}>{task.title || "Sin título"}</span><span className="muted">Tarea · vence {dayLabel(task.due)}</span></li>)}
        </ul>}
        </div>
      </div>
    </section>
  );
}
