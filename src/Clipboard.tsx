// Panel del historial del portapapeles (D-028). Los textos viven solo en la
// memoria del núcleo: este panel los pide al abrirse y al recibir
// `clipboard-changed` (evento sin datos) y los descarta al cerrarse.
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import {
  clipboardClear,
  clipboardCopy,
  clipboardDelete,
  clipboardList,
  clipboardPause,
  clipboardPin,
  type ClipboardView,
} from "./api";
import { Icon } from "./icons";

/** «ahora», «hace 5 min», «hace 2 h», «hace 3 d». */
export function relative(at: number, now = Date.now()): string {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d`;
}

export function ClipboardPanel({ enabled, onClose, onError }: { enabled: boolean; onClose: () => void; onError: (e: unknown) => void }) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ClipboardView>({ items: [], paused: false });
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      clipboardList(query).then((v) => alive && setView(v), onError);
    load();
    const un = listen("clipboard-changed", load);
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, [query]);

  const copy = (id: number) =>
    clipboardCopy(id).then(() => {
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
    }, onError);

  const now = Date.now();
  let empty = "Copia un texto para verlo aquí";
  if (!enabled) empty = "Historial desactivado en Ajustes";
  else if (query.trim()) empty = "Sin resultados";

  return (
    <section className="panel-view" aria-label="Portapapeles">
      <header className="panel-head">
        <label className="search">
          <Icon name="search" size={14} />
          <input
            className="field grow"
            type="search"
            placeholder="Buscar en el portapapeles"
            aria-label="Buscar en el portapapeles"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </label>
        <div className="btn-row">
          {enabled && (
            <button
              className="pill"
              data-action="pause"
              aria-pressed={view.paused}
              title={view.paused ? "Reanudar la captura" : "Pausar la captura (no borra nada)"}
              onClick={() => clipboardPause(!view.paused).catch(onError)}
            >
              <Icon name={view.paused ? "play" : "pause"} size={14} />
              {view.paused ? "Reanudar" : "Pausar"}
            </button>
          )}
          <button className="pill" data-action="clear" title="Borra todo salvo lo fijado" onClick={() => clipboardClear().catch(onError)}>
            <Icon name="trash" size={14} />
            Borrar todo
          </button>
          <button className="icon-btn" data-action="close-panel" title="Cerrar" aria-label="Cerrar" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      </header>
      <ul className="list clips" aria-label="Historial del portapapeles">
        {view.items.length === 0 && <li className="empty">{empty}</li>}
        {view.items.map((it) => (
          <li key={it.id} data-clip={it.id} data-pinned={it.pinned || undefined}>
            <button className="clip-text grow" title="Copiar de nuevo" onClick={() => copy(it.id)}>
              {it.preview}
            </button>
            <span className={`clip-time ${copied === it.id ? "accent" : "muted"}`}>{copied === it.id ? "Copiado" : relative(it.at, now)}</span>
            <button
              className="icon-btn pin"
              data-action="pin"
              aria-pressed={it.pinned}
              title={it.pinned ? "Desfijar" : "Fijar"}
              aria-label={it.pinned ? "Desfijar" : "Fijar"}
              onClick={() => clipboardPin(it.id, !it.pinned).catch(onError)}
            >
              <Icon name="pin" size={14} />
            </button>
            <button className="icon-btn" data-action="delete" title="Borrar" aria-label="Borrar" onClick={() => clipboardDelete(it.id).catch(onError)}>
              <Icon name="close" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
