// Panel de accesos rápidos: la lista viene de los ajustes; el núcleo revalida al abrir.
import { useState } from "react";
import { openShortcut, SHORTCUT_COLORS, SHORTCUT_ICONS, type QuickShortcut, type Workspace, type ShortcutColor } from "./api";
import { Icon } from "./icons";

export const KIND_ICON: Record<QuickShortcut["kind"], string> = { url: "link", app: "app", folder: "folder", file: "file", store: "app" };

export const COLOR_LABEL: Record<ShortcutColor, string> = {
  blue: "azul", red: "rojo", green: "verde", orange: "naranja", purple: "morado",
  pink: "rosa", teal: "turquesa", yellow: "amarillo", gray: "gris", indigo: "índigo",
};
export const ICON_LABEL: Record<(typeof SHORTCUT_ICONS)[number], string> = {
  music: "música", video: "vídeo", chat: "chat", folder: "carpeta", code: "código", game: "juegos",
  shop: "tienda", bank: "banco", mail: "correo", web: "web", app: "aplicación", doc: "documento",
  photo: "foto", cloud: "nube", terminal: "terminal", key: "llave", star: "estrella", home: "casa",
};
const KIND_DEFAULT_ICON: Record<QuickShortcut["kind"], string> = { url: "web", app: "app", folder: "folder", file: "doc", store: "app" };

/** Color e icono de un acceso: la elección guardada (solo como clave de listas blancas) o valores derivados. */
export function shortcutLook(s: Pick<QuickShortcut, "name" | "kind" | "color" | "icon">): { color: ShortcutColor; icon: string } {
  let h = 0;
  for (const ch of s.name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  const color = SHORTCUT_COLORS.find((c) => c === s.color) ?? SHORTCUT_COLORS[h % SHORTCUT_COLORS.length];
  const icon = SHORTCUT_ICONS.find((i) => i === s.icon) ?? KIND_DEFAULT_ICON[s.kind];
  return { color, icon };
}

/** La apariencia automática de espacios usa la misma derivación que los accesos. */
export function workspaceLook(w: Workspace) {
  return shortcutLook({ ...w, kind: "folder" });
}

export function ShortcutsPanel({ list, onClose }: { list: QuickShortcut[]; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="panel-view" aria-label="Accesos rápidos">
      <header className="panel-head">
        <strong className="panel-title">
          <Icon name="shortcuts" size={14} />
          Accesos rápidos
        </strong>
        <button className="icon-btn" data-action="close-panel" title="Cerrar" aria-label="Cerrar" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      {error && (
        <p role="alert" className="panel-error">
          {error}
        </p>
      )}
      <ul className="list shortcut-list" aria-label="Accesos rápidos">
        {list.length === 0 && <li className="empty">Aún no hay accesos. Añádelos en Ajustes.</li>}
        {list.map((s) => {
          const look = shortcutLook(s);
          return (
          <li key={s.id} data-shortcut={s.id}>
            <button
              className="shortcut-btn grow"
              data-color={look.color}
              data-icon={look.icon}
              title={s.target}
              onClick={() =>
                openShortcut(s.id).then(
                  () => setError(null),
                  (e) => setError(String(e)),
                )
              }
            >
              <Icon name={look.icon} size={14} />
              <span className="ellipsis" title={s.name}>{s.name}</span>
            </button>
          </li>
          );
        })}
      </ul>
    </section>
  );
}
