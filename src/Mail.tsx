// Widget Correo (Fase 4, D-038): remitente y asunto de los últimos no leídos de Gmail y de la etiqueta «Outlook».
import { useState } from "react";
import { cloudMail, cloudOpen, openSettings, reloadCloud, useBarVisible, useTick, type Feed, type MailView } from "./api";
import { Icon } from "./icons";

/** «hace 3 min» a partir de ms Unix. */
export function ago(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return m < 1 ? "hace un momento" : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`;
}

/** Estado del feed: cargando, error por `kind` y «Actualizado hace X» si hay datos antiguos. Nada si todo va bien. */
export function CloudNote({ feed, onError, connectLabel = "Conectar en Ajustes" }: { feed: Feed<unknown> | null; onError: (e: unknown) => void; connectLabel?: string }) {
  if (!feed || (!feed.data && !feed.error)) return <p role="status" className="empty-note muted">Cargando…</p>;
  const e = feed.error;
  if (!e) return null;
  const fix = e.kind === "signedOut" || e.kind === "expired" || e.kind === "config";
  return (
    <p role="status" className="cloud-note" data-kind={e.kind}>
      <span className="grow">
        {e.message}
        {feed.data && feed.updatedAt ? ` Actualizado ${ago(feed.updatedAt)}.` : ""}
      </span>
      {fix && (
        <button className="btn ghost" data-action="connect" onClick={() => openSettings().catch(onError)}>
          {connectLabel}
        </button>
      )}
    </p>
  );
}

/** Botón «Actualizar» + «Actualizado hace X» a partir de la última respuesta del feed. `load` es el mismo cargador que usa `useCloud`. */
export function RefreshBtn({ feed, load }: { feed: Feed<unknown> | null; load: unknown }) {
  const [busy, setBusy] = useState(false);
  const visible = useBarVisible();
  useTick(visible, 15_000);
  const go = () => {
    if (busy) return;
    setBusy(true);
    reloadCloud(load).finally(() => setBusy(false));
  };
  return (
    <>
      {feed?.updatedAt && (
        <span className="muted refresh-age" data-role="updated">
          Actualizado {ago(feed.updatedAt)}
        </span>
      )}
      <button className="icon-btn refresh" data-action="refresh" title={feed?.updatedAt ? `Actualizar (actualizado ${ago(feed.updatedAt)})` : "Actualizar"} aria-label="Actualizar" aria-busy={busy} aria-disabled={busy} disabled={busy} onClick={go}>
        <Icon name="refresh" />
      </button>
    </>
  );
}

const count = (n: number, more: boolean) => (more ? `${n}+` : String(n));
type Tab = "all" | "gmail" | "outlook";

export function MailPanel({ feed, onClose, onError }: { feed: Feed<MailView> | null; onClose: () => void; onError: (e: unknown) => void }) {
  const [tab, setTab] = useState<Tab>("all");
  const d = feed?.data;
  const tabs: [Tab, string][] = [
    ["all", "Todos"],
    ["gmail", d ? `Gmail ${count(d.inboxUnread, d.inboxMore)}` : "Gmail"],
    ["outlook", d ? `Outlook ${count(d.outlookUnread, d.outlookMore)}` : "Outlook"],
  ];
  const items = (d?.items ?? []).filter((i) => tab === "all" || i.source === tab).sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  return (
    <section className="panel-view" aria-label="Correo">
      <header className="panel-head">
        <div className="tabs" role="tablist" aria-label="Bandejas de correo">
          {tabs.map(([id, label]) => (
            <button key={id} id={`mail-tab-${id}`} role="tab" data-tab={id} aria-selected={tab === id} aria-controls="mail-results" tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={(e) => {
              const index = tabs.findIndex(([value]) => value === id);
              const next = e.key === "ArrowRight" ? (index + 1) % tabs.length
                : e.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
              if (next === null) return;
              e.preventDefault();
              setTab(tabs[next][0]);
              (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
            }}>
              {label}
            </button>
          ))}
        </div>
        <RefreshBtn feed={feed} load={cloudMail} />
        <button className="icon-btn" data-action="close-panel" title="Cerrar" aria-label="Cerrar" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div id="mail-results" className="mail-results" role="tabpanel" aria-labelledby={`mail-tab-${tab}`} tabIndex={0}>
        <CloudNote feed={feed} onError={onError} />
        {d && (
          <ul className="list" aria-label="Correos no leídos">
            {items.length === 0 && <li className="empty">No hay correos sin leer.</li>}
            {items.map((i) => (
              <li key={i.id} data-mail={i.source}>
                <button className="shortcut-btn cloud-item grow" title="Abrir en el navegador" onClick={() => cloudOpen("mail", i.id).catch(onError)}>
                  <span className="ellipsis" title={i.from}>{i.from}</span>
                  <span className="ellipsis muted" title={i.subject}>{i.subject}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
