// Panel del reloj (cronómetro, temporizadores, alarmas) y aviso de vencimiento.
// Los temporizadores y las alarmas viven en el núcleo Rust (D-029); aquí solo se muestran.
import { useRef, useState, type CSSProperties, type FormEvent } from "react";
import { alarmAdd, alarmSetEnabled, alarmRemove, alertDismiss, timerAdd, timerControl, type Alarm, type Alert, type ClockView, type TimerView } from "./api";
import { Icon } from "./icons";

const pad = (n: number) => String(n).padStart(2, "0");

/** Cronómetro: «m:ss.d» (o «h:mm:ss.d»). */
export function fmtStopwatch(ms: number): string {
  const t = Math.floor(ms / 100);
  const s = Math.floor(t / 10);
  const h = Math.floor(s / 3600);
  const body = `${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}.${t % 10}`;
  return h ? `${h}:${body}` : body;
}

/** Tiempo restante redondeado hacia arriba: «m:ss» (o «h:mm:ss»). */
export function fmtLeft(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** Restante actual de un temporizador a partir de la vista recibida en `at`. */
export const remaining = (t: TimerView, at: number) =>
  t.running ? Math.max(0, t.remainingMs - (performance.now() - at)) : t.remainingMs;

/** Cronómetro medido con instantes (`performance.now()`), sin acumular ticks. */
export function useStopwatch() {
  const [state, setState] = useState({ since: null as number | null, base: 0, laps: [] as number[] });
  const elapsed = () => state.base + (state.since === null ? 0 : performance.now() - state.since);
  return {
    running: state.since !== null,
    laps: state.laps,
    elapsed,
    start: () => setState((s) => (s.since === null ? { ...s, since: performance.now() } : s)),
    pause: () => setState((s) => (s.since === null ? s : { ...s, base: s.base + performance.now() - s.since, since: null })),
    lap: () => setState((s) => ({ ...s, laps: [...s.laps, elapsed()] })),
    reset: () => setState({ since: null, base: 0, laps: [] }),
  };
}
export type Stopwatch = ReturnType<typeof useStopwatch>;

/** Texto del indicador compacto: el temporizador activo más próximo o el cronómetro en marcha. */
export function indicator(clock: { view: ClockView; at: number }, sw: Stopwatch): string | null {
  const left = clock.view.timers.filter((t) => t.running).map((t) => remaining(t, clock.at));
  if (left.length) return fmtLeft(Math.min(...left));
  return sw.running ? fmtStopwatch(sw.elapsed()).slice(0, -2) : null;
}

const DAYS = ["L", "M", "X", "J", "V", "S", "D"];
const DAY_NAMES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

export function daysSummary(days: number[]): string {
  const key = days.join(",");
  if (!days.length) return "Una vez";
  if (days.length === 7) return "Todos los días";
  if (key === "0,1,2,3,4") return "Lun–Vie";
  if (key === "5,6") return "Fin de semana";
  return days.map((d) => DAYS[d]).join(" ");
}

type Tab = "stopwatch" | "timers" | "alarms";
const TABS: [Tab, string][] = [
  ["stopwatch", "Cronómetro"],
  ["timers", "Temporizadores"],
  ["alarms", "Alarmas"],
];

type OnError = (e: unknown) => void;

export function ClockPanel(props: {
  clock: { view: ClockView; at: number };
  sw: Stopwatch;
  alarms: Alarm[];
  onClose: () => void;
  onError: OnError;
}) {
  const [tab, setTab] = useState<Tab>("stopwatch");
  return (
    <section className="panel-view" aria-label="Reloj">
      <header className="panel-head">
        <div className="tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" data-tab={id} aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <button className="icon-btn" data-action="close-panel" title="Cerrar" aria-label="Cerrar" onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="panel-body" role="tabpanel" data-tab={tab} key={tab}>
        {tab === "stopwatch" && <StopwatchTab sw={props.sw} />}
        {tab === "timers" && <TimersTab clock={props.clock} onError={props.onError} />}
        {tab === "alarms" && <AlarmsTab alarms={props.alarms} onError={props.onError} />}
      </div>
    </section>
  );
}

function StopwatchTab({ sw }: { sw: Stopwatch }) {
  const ms = sw.elapsed();
  const laps = sw.laps.map((total, i) => ({ n: i + 1, total, split: total - (sw.laps[i - 1] ?? 0) })).reverse();
  return (
    <>
      <div className="col center">
        <span className="big-time" data-testid="stopwatch">
          {fmtStopwatch(ms)}
        </span>
        <div className="btn-row">
          {sw.running ? (
            <>
              <button className="pill" data-action="lap" onClick={sw.lap}>
                <Icon name="flag" size={14} />
                Vuelta
              </button>
              <button className="pill primary" data-action="pause" onClick={sw.pause}>
                <Icon name="pause" size={14} />
                Pausar
              </button>
            </>
          ) : (
            <>
              {ms > 0 && (
                <button className="pill" data-action="reset" onClick={sw.reset}>
                  <Icon name="reset" size={14} />
                  Reiniciar
                </button>
              )}
              <button className="pill primary" data-action="start" onClick={sw.start}>
                <Icon name="play" size={14} />
                {ms > 0 ? "Reanudar" : "Iniciar"}
              </button>
            </>
          )}
        </div>
      </div>
      <ol className="list" aria-label="Vueltas">
        {laps.length === 0 && <li className="empty">Sin vueltas</li>}
        {laps.map((l) => (
          <li key={l.n}>
            <span className="muted grow">Vuelta {l.n}</span>
            <span className="mono">{fmtStopwatch(l.split)}</span>
            <span className="mono muted">{fmtStopwatch(l.total)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function TimersTab({ clock, onError }: { clock: { view: ClockView; at: number }; onError: OnError }) {
  const name = useRef<HTMLInputElement>(null);
  const [min, setMin] = useState("3");
  const [sec, setSec] = useState("0");
  const add = (seconds: number) => {
    timerAdd(name.current?.value ?? "", seconds).then(() => {
      if (name.current) name.current.value = "";
    }, onError);
  };
  const custom = (e: FormEvent) => {
    e.preventDefault();
    const s = Math.round((Number(min) || 0) * 60 + (Number(sec) || 0));
    if (s > 0) add(s);
  };
  return (
    <>
      <form className="col form" onSubmit={custom}>
        <input ref={name} className="field" placeholder="Nombre (opcional)" maxLength={40} aria-label="Nombre del temporizador" />
        <div className="chips">
          {[1, 5, 10, 15].map((m) => (
            <button key={m} type="button" className="chip" data-preset={m} onClick={() => add(m * 60)}>
              {m} min
            </button>
          ))}
        </div>
        <div className="btn-row">
          <input className="field num" type="number" min={0} max={1440} value={min} onChange={(e) => setMin(e.target.value)} aria-label="Minutos" />
          <span className="muted">min</span>
          <input className="field num" type="number" min={0} max={59} value={sec} onChange={(e) => setSec(e.target.value)} aria-label="Segundos" />
          <span className="muted">s</span>
          <button className="pill primary" type="submit" data-action="add-timer">
            <Icon name="plus" size={14} />
            Añadir
          </button>
        </div>
      </form>
      <ul className="list" aria-label="Temporizadores">
        {clock.view.timers.length === 0 && <li className="empty">Sin temporizadores</li>}
        {clock.view.timers.map((t) => {
          const left = remaining(t, clock.at);
          return (
            <li key={t.id} data-timer={t.id} style={{ "--progress": `${(1 - left / t.durationMs) * 100}%` } as CSSProperties}>
              <span className="grow ellipsis">{t.label || `Temporizador ${fmtLeft(t.durationMs)}`}</span>
              <span className={`mono ${t.running ? "accent" : "muted"}`}>{fmtLeft(left)}</span>
              <button
                className="icon-btn"
                title={t.running ? "Pausar" : "Reanudar"}
                aria-label={t.running ? "Pausar" : "Reanudar"}
                onClick={() => timerControl(t.id, t.running ? "pause" : "resume").catch(onError)}
              >
                <Icon name={t.running ? "pause" : "play"} size={14} />
              </button>
              <button className="icon-btn" title="Cancelar" aria-label="Cancelar" onClick={() => timerControl(t.id, "cancel").catch(onError)}>
                <Icon name="close" size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function AlarmsTab({ alarms, onError }: { alarms: Alarm[]; onError: OnError }) {
  const [time, setTime] = useState("07:00");
  const [days, setDays] = useState<number[]>([]);
  const [label, setLabel] = useState("");
  const add = (e: FormEvent) => {
    e.preventDefault();
    const [hour, minute] = time.split(":").map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return;
    alarmAdd({ hour, minute, days: [...days].sort(), label, enabled: true }).then(() => setLabel(""), onError);
  };
  const toggleDay = (d: number) => setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d]));
  return (
    <>
      <form className="col form" onSubmit={add}>
        <div className="btn-row">
          <input className="field time" type="time" required value={time} onChange={(e) => setTime(e.target.value)} aria-label="Hora" />
          <input className="field grow" placeholder="Nombre (opcional)" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Nombre de la alarma" />
        </div>
        <div className="chips" role="group" aria-label="Repetir">
          {DAYS.map((d, i) => (
            <button key={i} type="button" className="chip day" aria-pressed={days.includes(i)} title={DAY_NAMES[i]} onClick={() => toggleDay(i)}>
              {d}
            </button>
          ))}
        </div>
        <div className="btn-row">
          <span className="muted grow">{daysSummary([...days].sort())}</span>
          <button className="pill primary" type="submit" data-action="add-alarm">
            <Icon name="plus" size={14} />
            Añadir
          </button>
        </div>
      </form>
      <ul className="list" aria-label="Alarmas">
        {alarms.length === 0 && <li className="empty">Sin alarmas</li>}
        {alarms.map((a) => (
          <li key={a.id} data-alarm={a.id} data-off={!a.enabled || undefined}>
            <span className="mono alarm-time">
              {pad(a.hour)}:{pad(a.minute)}
            </span>
            <span className="grow ellipsis">
              {a.label && <>{a.label} · </>}
              <span className="muted">{daysSummary(a.days)}</span>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={a.enabled}
              aria-label={`Activar alarma ${pad(a.hour)}:${pad(a.minute)}`}
              onChange={(e) => alarmSetEnabled(a.id, e.target.checked).catch(onError)}
            />
            <button className="icon-btn" title="Borrar" aria-label="Borrar alarma" onClick={() => alarmRemove(a.id).catch(onError)}>
              <Icon name="trash" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Aviso en la isla expandida: «Detener» y, en alarmas, «Posponer 5 min». */
export function AlertView({ alert, more, onError }: { alert: Alert; more: number; onError: OnError }) {
  const alarm = alert.kind === "alarm";
  return (
    <section className="alert-view" role="alertdialog" aria-label={alarm ? "Alarma" : "Temporizador"}>
      <span className="alert-icon">
        <Icon name={alarm ? "bell" : "clock"} size={20} />
      </span>
      <div className="alert-text">
        <strong>{alarm ? "Alarma" : "Temporizador terminado"}</strong>
        <span className="ellipsis">{alert.label || (alarm ? "Alarma" : "Tiempo cumplido")}</span>
      </div>
      {more > 0 && <span className="muted">+{more}</span>}
      <div className="btn-row">
        {alarm && (
          <button className="pill" data-action="snooze" onClick={() => alertDismiss(alert.id, true).catch(onError)}>
            Posponer 5 min
          </button>
        )}
        <button className="pill primary" data-action="stop" onClick={() => alertDismiss(alert.id, false).catch(onError)}>
          Detener
        </button>
      </div>
    </section>
  );
}
