import { useEffect, useRef } from "react";
import { setPanel } from "./api";

/** La barra necesita espacio para que el fallo y su recuperación sean legibles. */
export function SettingsStatus({ error, retry, bar = false }: { error: string | null; retry: () => void; bar?: boolean }) {
  const expanded = useRef(false);
  useEffect(() => {
    if (bar && error) {
      expanded.current = true;
      void setPanel(true, 160).catch(() => {});
    }
  }, [bar, error]);
  useEffect(() => () => {
    if (expanded.current) void setPanel(false).catch(() => {});
  }, []);
  return (
    <main className={`recovery-card${error ? " has-error" : ""}`} aria-label="Estado de los ajustes">
      <p role={error ? "alert" : "status"}>{error ?? "Cargando ajustes…"}</p>
      {error && <button className="btn" onClick={retry}>Reintentar</button>}
    </main>
  );
}
