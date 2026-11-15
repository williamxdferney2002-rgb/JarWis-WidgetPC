// Widget Sistema: sondeo adaptativo del núcleo (solo con la isla visible) y panel.
import { useEffect, useState } from "react";
import { powerMode, powerOpen, powerSet, systemSnapshot, usePageVisible, type PowerMode, type SystemSnapshot } from "./api";
import { Icon } from "./icons";

/** Muestra del sistema cada `ms` mientras `active` (isla visible). Un solo intervalo; limpia al desmontar. */
export function useSystem(active: boolean, ms: number): SystemSnapshot | null {
  const [snap, setSnap] = useState<SystemSnapshot | null>(null);
  const visible = usePageVisible(active);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const load = () => {
      if (!alive || document.hidden) return;
      return systemSnapshot().then(
        (s) => alive && setSnap(s),
        () => {},
      );
    };
    load();
    const id = window.setInterval(load, ms);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [visible, ms]);
  return snap;
}

const units = ["B", "KB", "MB", "GB", "TB"];
/** Bytes legibles: 512 B, 1,5 MB. */
export function size(n: number): string {
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toLocaleString("es", { maximumFractionDigits: n < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}

function uptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

function Stat({ label, value, sub, pct }: { label: string; value: string; sub?: string; pct?: number }) {
  return (
    <div className="col stat" data-stat={label}>
      <span className="muted">{label}</span>
      <strong className="stat-value mono">{value}</strong>
      {sub && <span className="muted mono">{sub}</span>}
      {pct !== undefined && (
        <span className="meter">
          <span style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
        </span>
      )}
    </div>
  );
}

const powerModes = [
  ["efficiency", "Mejor eficiencia energética"],
  ["balanced", "Equilibrado"],
  ["performance", "Mejor rendimiento"],
] as const;

export function SystemPanel({ snap, onClose }: { snap: SystemSnapshot | null; onClose: () => void }) {
  const [mode, setMode] = useState<PowerMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingMode, setSettingMode] = useState(false);
  useEffect(() => {
    let alive = true;
    powerMode().then(
      (value) => alive && setMode(value),
      (e) => { if (alive) { setMode("unknown"); setError(String(e)); } },
    );
    return () => { alive = false; };
  }, []);
  const open = (target: "settings" | "omen") => {
    setError(null);
    void powerOpen(target).catch((e) => setError(String(e)));
  };
  const changeMode = async (value: Exclude<PowerMode, "unknown">) => {
    if (settingMode) return;
    setSettingMode(true);
    setError(null);
    try {
      setMode(await powerSet(value));
    } catch (e) {
      setError(String(e));
      if (String(e).startsWith("Se solicitó el cambio")) return;
      try {
        await powerOpen("settings");
      } catch (fallback) {
        setError(`${String(e)}. ${String(fallback)}`);
      }
    } finally {
      setSettingMode(false);
    }
  };
  const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
  const b = snap?.battery;
  return (
    <section className="panel-view" aria-label="Sistema">
      <header className="panel-head">
        <strong className="panel-title">
          <span className="vital" data-level={snap?.level ?? "ok"}>
            <Icon name="system" size={14} />
          </span>
          Sistema
        </strong>
        <button className="icon-btn" data-action="close-panel" title="Cerrar" aria-label="Cerrar" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      {error && <p role="alert" className="cloud-note" data-kind="other">{error}</p>}
      <div className="system-body">
        {snap ? (
          <div className="stats">
            <Stat label="CPU" value={`${Math.round(snap.cpu)} %`} pct={snap.cpu} />
            <Stat label="RAM" value={`${size(snap.memUsed)} / ${size(snap.memTotal)}`} pct={pct(snap.memUsed, snap.memTotal)} />
            <Stat label="Disco del sistema" value={`${size(snap.diskUsed)} / ${size(snap.diskTotal)}`} pct={pct(snap.diskUsed, snap.diskTotal)} />
            <Stat label="Red" value={`↓ ${size(snap.netRxBps)}/s`} sub={`↑ ${size(snap.netTxBps)}/s`} />
            {b && <Stat label="Batería" value={`${b.percent} %`} sub={b.charging ? "Cargando" : b.onAc ? "Enchufado" : "Con batería"} pct={b.percent} />}
            <Stat label="Encendido" value={uptime(snap.uptimeSecs)} />
          </div>
        ) : (
          <p className="empty-note muted">Leyendo el sistema…</p>
        )}
        <div className="power-controls" role="group" aria-label="Modo de energía">
          <strong>Modo efectivo: {mode === null ? "Leyendo…" : powerModes.find(([value]) => value === mode)?.[1] ?? "Desconocido"}</strong>
          <span className="muted">Cambia el modo para la alimentación actual. Windows puede priorizar otras señales.</span>
          <div className="power-actions">
            {powerModes.map(([value, label]) => (
              <button key={value} className="btn" disabled={mode === null || settingMode} aria-current={mode === value ? "true" : undefined} onClick={() => void changeMode(value)}>
                {label}
              </button>
            ))}
          </div>
          <div className="power-actions">
            <button className="btn" onClick={() => open("omen")}>Ventilador al máximo</button>
            <span className="muted">Se ajusta en OMEN Gaming Hub</span>
          </div>
        </div>
      </div>
    </section>
  );
}
