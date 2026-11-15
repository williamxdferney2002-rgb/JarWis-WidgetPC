import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  CLOUD_EVENT,
  cloudLogin,
  cloudLogout,
  cloudStatus,
  getStatus,
  listMonitors,
  listStoreApps,
  widgetMove,
  setShortcuts,
  setWorkspaces,
  weatherSearch,
  type WeatherPlace,
  type ShortcutColor,
  type ShortcutIcon,
  patchSettings,
  useReorder,
  useSettings,
  useTheme,
  useBarStyle,
  useIslandColor,
  useAuroraAccent,
  WIDGET_NAMES,
  type CloudStatus,
  type MonitorInfo,
  type QuickShortcut,
  type StoreApp,
  type Mascot,
  type CodexPetIcon,
  type Settings,
  type Status,
  type Workspace,
  SHORTCUT_COLORS,
  SHORTCUT_ICONS,
} from "./api";
import { AiMark, CodexPetArt, Icon } from "./icons";
import { MASCOT_LABELS, mascotImages } from "./mascots";
import { COLOR_LABEL, ICON_LABEL, shortcutLook, workspaceLook } from "./Shortcuts";
import { SettingsStatus } from "./SettingsStatus";

const closeWindow = () => getCurrentWindow().close().catch(() => {});
const SETTINGS_TABS = [["appearance", "Apariencia"], ["productivity", "Productividad"], ["accounts", "Cuentas"]] as const;
type SettingsTab = typeof SETTINGS_TABS[number][0];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      <div className="card">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="row">
      <div>
        <div>{label}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** Control segmentado sobre radios nativos (teclado con flechas incluido). */
function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={name}>
      {options.map(([v, label]) => (
        <label key={v}>
          <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

/** Selector de mascota: radios nativos (flechas incluidas) con miniatura y nombre. */
function MascotPicker({ value, onChange }: { value: Mascot; onChange: (v: Mascot) => void }) {
  return (
    <div className="mascot-picker" role="radiogroup" aria-label="Mascota">
      {MASCOT_LABELS.map(([v, label]) => (
        <label key={v}>
          <input type="radio" name="Mascota" value={v} checked={value === v} onChange={() => onChange(v)} />
          <img src={mascotImages[v].h} alt="" aria-hidden="true" />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

/** Radios nativos con flechas, independientes de las mascotas de Mini. */
function CodexPetPicker({ value, onChange }: { value: CodexPetIcon; onChange: (v: CodexPetIcon) => void }) {
  return (
    <div className="mascot-picker codex-pet-picker" role="radiogroup" aria-label="Mascota de Codex">
      {([["dog", "Perrito"], ["dragon", "Dragón"]] as const).map(([v, label]) => (
        <label key={v}>
          <input type="radio" name="Mascota de Codex" value={v} checked={value === v} onChange={() => onChange(v)} />
          <span className="codex-pet-preview"><CodexPetArt icon={v} size={32} /></span>
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="switch"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

const KIND_LABEL: [QuickShortcut["kind"], string][] = [
  ["url", "Enlace web"],
  ["app", "Aplicación"],
  ["folder", "Carpeta"],
  ["file", "Archivo"],
  ["store", "App de la Tienda"],
];

/** Desplegable de apps de la Tienda: se cargan una sola vez (caché de módulo) y se ordenan por nombre. */
let storeApps: Promise<StoreApp[]> | null = null;
function StoreSelect({ value, onPick }: { value: string; onPick: (app: StoreApp | undefined) => void }) {
  const [apps, setApps] = useState<StoreApp[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    storeApps ??= listStoreApps().then((l) => l.sort((a, b) => a.name.localeCompare(b.name)));
    storeApps.then(setApps, (e) => {
      storeApps = null;
      setErr(String(e));
    });
  }, []);
  if (err) return <span className="hint sc-target">{err}</span>;
  return (
    <select className="sc-target" aria-label="Destino" value={value} disabled={!apps} onChange={(e) => onPick(apps?.find((a) => a.appId === e.target.value))}>
      <option value="">{apps ? "Elige una app…" : "Cargando…"}</option>
      {apps?.map((a) => (
        <option key={a.appId} value={a.appId}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

/** Selectores compartidos por accesos y espacios; las mismas listas blancas. */
function LookPicker({ look, onChange }: { look: { color: ShortcutColor; icon: string }; onChange: (patch: { color?: ShortcutColor; icon?: ShortcutIcon }) => void }) {
  return (
    <>
      <div className="sc-pick" role="group" aria-label="Color" data-part="sc-colors">
        {SHORTCUT_COLORS.map((c) => (
          <button key={c} type="button" className="sc-swatch" data-color={c}
            aria-label={`Color ${COLOR_LABEL[c]}`} aria-pressed={look.color === c} title={COLOR_LABEL[c]}
            onClick={() => onChange({ color: c })} />
        ))}
      </div>
      <div className="sc-pick" role="group" aria-label="Icono" data-part="sc-icons">
        {SHORTCUT_ICONS.map((n) => (
          <button key={n} type="button" className="sc-icon-opt" data-icon={n} data-color={look.color}
            aria-label={`Icono ${ICON_LABEL[n]}`} aria-pressed={look.icon === n} title={ICON_LABEL[n]}
            onClick={() => onChange({ icon: n })}>
            <Icon name={n} size={14} />
          </button>
        ))}
      </div>
    </>
  );
}

/** Editor de accesos rápidos: borrador local; el núcleo valida al guardar y devuelve el motivo si rechaza. */
function ShortcutsEditor({ initial }: { initial: QuickShortcut[] }) {
  const [list, setList] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const edit = (i: number, patch: Partial<QuickShortcut>) => {
    setList(list.map((s, n) => (n === i ? { ...s, ...patch } : s)));
    setMsg(null);
  };
  const save = () =>
    setShortcuts(list).then(
      (saved) => {
        setList(saved);
        setMsg({ ok: true, text: "Accesos guardados" });
      },
      (e) => setMsg({ ok: false, text: String(e) }),
    );
  return (
    <Section title="Accesos rápidos">
      {list.length === 0 && <p className="hint pad">Aún no hay accesos. Añade uno abajo.</p>}
      {list.map((s, i) => {
        const look = shortcutLook(s);
        return (
        <div className="sc-row" key={i} data-sc={i}>
          <input className="sc-name" title={s.name} aria-label="Nombre" placeholder="Nombre" maxLength={60} value={s.name} onChange={(e) => edit(i, { name: e.target.value })} />
          <select aria-label="Tipo" value={s.kind} onChange={(e) => edit(i, { kind: e.target.value as QuickShortcut["kind"], target: "" })}>
            {KIND_LABEL.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          {s.kind === "store" ? (
            <StoreSelect value={s.target} onPick={(a) => edit(i, { target: a?.appId ?? "", name: s.name || a?.name || "" })} />
          ) : (
            <input
              className="sc-target"
              aria-label="Destino"
              placeholder={s.kind === "url" ? "https://…" : "C:\\ruta\\completa"}
              value={s.target}
              onChange={(e) => edit(i, { target: e.target.value })}
            />
          )}
          <LookPicker look={look} onChange={(patch) => edit(i, patch)} />
          <button className="icon-btn" data-action="sc-delete" title="Eliminar" aria-label="Eliminar" onClick={() => (setList(list.filter((_, n) => n !== i)), setMsg(null))}>
            <Icon name="trash" />
          </button>
        </div>
        );
      })}
      <div className="sc-actions">
        <button className="btn ghost" data-action="sc-add" onClick={() => (setList([...list, { id: 0, name: "", kind: "url", target: "" }]), setMsg(null))}>
          Añadir
        </button>
        <button className="btn" data-action="sc-save" onClick={save}>
          Guardar
        </button>
      </div>
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "hint pad" : "alert"}>
          {msg.text}
        </p>
      )}
    </Section>
  );
}

/** Solo busca al pulsar Buscar; elegir y quitar se guardan como parches parciales. */
function WeatherEditor({ place }: { place: WeatherPlace | null }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WeatherPlace[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const search = async () => {
    setBusy(true); setMessage(""); setResults([]); setFailed(false);
    try {
      const list = await weatherSearch(query.trim());
      setResults(list.slice(0, 5));
      if (!list.length) setMessage("No se encontraron ciudades. Prueba otro nombre.");
    } catch (e) { setMessage(String(e)); setFailed(true); }
    finally { setBusy(false); }
  };
  const choose = async (weatherPlace: WeatherPlace | null) => {
    setBusy(true); setFailed(false);
    try { await patchSettings({ weatherPlace }); setResults([]); setMessage(weatherPlace ? "Ciudad guardada" : "Ciudad quitada"); }
    catch (e) { setMessage(String(e)); setFailed(true); }
    finally { setBusy(false); }
  };
  return <Section title="Clima">
    <div className="weather-editor" aria-busy={busy}>
      <p className="hint">Se envían a Open-Meteo solo las coordenadas de la ciudad elegida (Open-Meteo ve la dirección IP de la conexión); sin cuenta ni clave</p>
      <p className="hint">Al buscar se envía el nombre escrito para mostrar ciudades. No se usa geolocalización.</p>
      <form className="weather-search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <label className="grow">Ciudad<input aria-label="Buscar ciudad" placeholder="Nombre de la ciudad" minLength={2} maxLength={60} value={query} disabled={busy} onChange={(e) => setQuery(e.target.value)} /></label>
        <button className="btn" type="submit" disabled={busy || query.trim().length < 2}>{busy ? "Buscando…" : "Buscar"}</button>
      </form>
      {results.length > 0 && <ul className="weather-results" aria-label="Ciudades encontradas">{results.map((p, i) => <li key={i}>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void choose(p)} aria-label={`Elegir ${[p.name, p.admin, p.country].filter(Boolean).join(", ")}`}>
          <Icon name="home" size={16} /><span>{[p.name, p.admin, p.country].filter(Boolean).join(" · ")}</span>
        </button>
      </li>)}</ul>}
      <div className="weather-selection"><span>{place ? [place.name, place.admin, place.country].filter(Boolean).join(" · ") : "Sin ciudad elegida"}</span>
        {place && <button type="button" className="btn ghost" disabled={busy} onClick={() => void choose(null)}>Quitar ciudad</button>}
      </div>
      {message && <p role={failed ? "alert" : "status"} className="hint">{message}</p>}
    </div>
  </Section>;
}

/** Espacios de trabajo (máx. 10): borrador local; cada uno agrupa accesos existentes. El núcleo valida al guardar. */
function WorkspacesEditor({ initial, shortcuts }: { initial: Workspace[]; shortcuts: QuickShortcut[] }) {
  const [list, setList] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const edit = (i: number, patch: Partial<Workspace>) => {
    setList(list.map((w, n) => (n === i ? { ...w, ...patch } : w)));
    setMsg(null);
  };
  const toggle = (i: number, id: number, on: boolean) =>
    edit(i, { shortcuts: on ? [...list[i].shortcuts, id] : list[i].shortcuts.filter((x) => x !== id) });
  const save = () =>
    setWorkspaces(list.map((w) => ({ ...w, shortcuts: w.shortcuts.filter((id) => shortcuts.some((s) => s.id === id)) }))).then(
      (saved) => {
        setList(saved);
        setMsg({ ok: true, text: "Espacios guardados" });
      },
      (e) => setMsg({ ok: false, text: String(e) }),
    );
  return (
    <Section title="Espacios de trabajo">
      {list.length === 0 && <p className="hint pad">Un espacio abre varios accesos a la vez desde el widget Hoy. Añade uno abajo.</p>}
      {shortcuts.length === 0 && <p className="hint pad">Primero crea accesos rápidos.</p>}
      {list.map((w, i) => (
        <div className="ws-row" key={i} data-ws={i}>
          <div className="sc-row">
            <input className="sc-name" title={w.name} aria-label="Nombre del espacio" placeholder="Nombre" maxLength={60} value={w.name} onChange={(e) => edit(i, { name: e.target.value })} />
            <LookPicker look={workspaceLook(w)} onChange={(patch) => edit(i, patch)} />
            <button className="icon-btn" data-action="ws-delete" title="Eliminar" aria-label="Eliminar espacio" onClick={() => (setList(list.filter((_, n) => n !== i)), setMsg(null))}>
              <Icon name="trash" />
            </button>
          </div>
          <div className="ws-items">
            {shortcuts.map((s) => (
              <label key={s.id}>
                <input type="checkbox" data-ws-item={s.id} checked={w.shortcuts.includes(s.id)} onChange={(e) => toggle(i, s.id, e.target.checked)} />
                <span className="ellipsis" title={s.name}>{s.name}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="sc-actions">
        <button className="btn ghost" data-action="ws-add" disabled={list.length >= 10} onClick={() => (setList([...list, { id: 0, name: "", shortcuts: [] }]), setMsg(null))}>
          Añadir
        </button>
        <button className="btn" data-action="ws-save" onClick={save}>
          Guardar
        </button>
      </div>
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "hint pad" : "alert"}>
          {msg.text}
        </p>
      )}
    </Section>
  );
}

/** Cuenta de Google (D-038): Conectar abre el navegador del sistema; el inicio de sesión lo hace el usuario en persona. */
function GoogleAccount() {
  const [st, setSt] = useState<CloudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => cloudStatus().then(setSt, () => {});
  useEffect(() => {
    refresh();
    const un = listen(CLOUD_EVENT, refresh);
    return () => {
      un.then((f) => f());
    };
  }, []);
  const run = (job: () => Promise<string | null>) => {
    setBusy(true);
    setConfirm(false);
    job()
      .then(setMsg, (e) => setMsg(String(e)))
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };
  const connect = () => run(() => cloudLogin().then(() => null));
  const disconnect = () =>
    run(() =>
      cloudLogout().then((r) =>
        r.revoked === false ? "Se quitó de JarWis, pero Google no confirmó la revocación: revoca el acceso en myaccount.google.com/permissions." : null,
      ),
    );
  const login = busy || st?.loginInProgress;
  const hint = !st
    ? "Comprobando…"
    : !st.configured
      ? "Falta configurar %APPDATA%\\JarWis\\oauth-clients.json."
      : login
        ? "Completa el inicio de sesión en el navegador (5 min)"
        : st.connected
          ? "Conectada: correo, calendario y tareas (solo lectura)"
          : "Sin conectar";
  return (
    <Section title="Cuentas">
      <Row label="Google" hint={hint}>
        {st?.connected ? (
          confirm ? (
            <span className="btn-row">
              <button className="btn" data-action="logout-confirm" disabled={busy} onClick={disconnect}>
                Sí, desconectar
              </button>
              <button className="btn ghost" onClick={() => setConfirm(false)}>
                Cancelar
              </button>
            </span>
          ) : (
            <button className="btn ghost" data-action="logout" disabled={login} onClick={() => setConfirm(true)}>
              Desconectar
            </button>
          )
        ) : (
          <button className="btn" data-action="login" disabled={!st?.configured || login} onClick={connect}>
            Conectar
          </button>
        )}
      </Row>
      {msg && (
        <p role="alert" className="hint pad">
          {msg}
        </p>
      )}
    </Section>
  );
}

export default function SettingsView() {
  const [tab, setTab] = useState<SettingsTab>(() => {
    try {
      const saved = localStorage.getItem("jarwis-settings-tab");
      return SETTINGS_TABS.find(([id]) => id === saved)?.[0] ?? "appearance";
    } catch { return "appearance"; }
  });
  const selectTab = (id: SettingsTab) => {
    setTab(id);
    try { localStorage.setItem("jarwis-settings-tab", id); } catch { /* Preferencia solo en memoria. */ }
  };
  const { settings, error: loadError, retry } = useSettings();
  useTheme(settings?.theme);
  useBarStyle(settings?.barStyle);
  useIslandColor(settings?.islandColor);
  useAuroraAccent(settings?.auroraAccent);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMonitors().then(setMonitors).catch(() => {});
    getStatus().then(setStatus).catch(() => {});
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && closeWindow();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Cada cambio se aplica en vivo; si el núcleo lo rechaza se muestra el motivo.
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    settings &&
    patchSettings({ [key]: value }).then(
      () => setError(null),
      (e) => setError(String(e)),
    );
  const move = (id: string, target: string) => widgetMove(id, target).then(
    () => setError(null), (e) => setError(String(e)),
  );
  const dragProps = useReorder(move);

  if (!settings) return <SettingsStatus error={loadError} retry={retry} />;

  const appearance = settings.barStyle === "aurora" ? "aurora" : settings.islandColor === "royal" ? "midnight" : "black";
  const setAppearance = (value: "black" | "midnight" | "aurora") => {
    const barStyle = value === "aurora" ? "aurora" : "classic";
    const islandColor = value === "midnight" ? "royal" : "black";
    return patchSettings({
      ...(barStyle !== settings.barStyle ? { barStyle } : {}),
      ...(islandColor !== settings.islandColor ? { islandColor } : {}),
    }).then(
      () => setError(null), (e) => setError(String(e)),
    );
  };

  // Alt+Flecha mueve el widget enfocado (alternativa al arrastre por teclado).
  const onItemKey = (id: string, i: number) => (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const target = settings.widgetOrder[e.key === "ArrowUp" ? i - 1 : i + 1];
    if (target) {
      e.preventDefault();
      void move(id, target);
    }
  };

  return (
    <main className="settings">
      <header>
        <h1>Ajustes</h1>
      </header>

      <div className="settings-tabs" role="tablist" aria-label="Secciones de ajustes">
        {SETTINGS_TABS.map(([id, label], index) => (
          <button key={id} id={`settings-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`settings-panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => selectTab(id)} onKeyDown={(e) => {
            const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (index + 1) % SETTINGS_TABS.length
              : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (index + SETTINGS_TABS.length - 1) % SETTINGS_TABS.length
              : e.key === "Home" ? 0 : e.key === "End" ? SETTINGS_TABS.length - 1 : null;
            if (next === null) return;
            e.preventDefault();
            selectTab(SETTINGS_TABS[next][0]);
            (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
          }}>{label}</button>
        ))}
      </div>

      <div id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance" hidden={tab !== "appearance"} tabIndex={0}>
      <Section title="Barra">
        <Row label="Posición">
          <Segmented
            name="Posición"
            value={settings.edge}
            options={[
              ["top", "Arriba"],
              ["bottom", "Abajo"],
              ["left", "Izq."],
              ["right", "Der."],
            ]}
            onChange={(v) => set("edge", v)}
          />
        </Row>
        <Row label="Modo">
          <Segmented
            name="Modo"
            value={settings.mode}
            options={[
              ["compact", "Compacto"],
              ["expanded", "Expandido"],
            ]}
            onChange={(v) => set("mode", v)}
          />
        </Row>
        <Row label="Monitor">
          <select className="select" value={settings.monitor ?? ""} onChange={(e) => set("monitor", e.target.value || null)}>
            <option value="">Principal</option>
            {monitors.map((m) => (
              <option key={m.name} value={m.name}>
                {m.label}
              </option>
            ))}
          </select>
        </Row>
      </Section>

      <Section title="Apariencia">
        <Row label="Tema">
          <Segmented
            name="Tema"
            value={settings.theme}
            options={[
              ["system", "Sistema"],
              ["light", "Claro"],
              ["dark", "Oscuro"],
            ]}
            onChange={(v) => set("theme", v)}
          />
        </Row>
        <Row label="Estilo de la barra" hint="La misma barra, con tres acabados diferentes">
          <Segmented
            name="Estilo de la barra"
            value={appearance}
            options={[
              ["black", "Negro"],
              ["midnight", "Pizarra"],
              ["aurora", "Aurora neón"],
            ]}
            onChange={setAppearance}
          />
        </Row>
        {appearance === "aurora" && <Row label="Acento de Aurora" hint="Elige el que combine con tu fondo de pantalla">
          <Segmented
            name="Acento de Aurora"
            value={settings.auroraAccent ?? "cyan"}
            options={[
              ["violet", "Violeta"],
              ["cyan", "Cian y verde"],
              ["amber", "Ámbar"],
            ]}
            onChange={(v) => set("auroraAccent", v)}
          />
        </Row>}
        <Row label="Mascota" hint="Espíritu que aparece en la pastilla minimizada">
          <MascotPicker value={settings.mascot ?? "air"} onChange={(v) => set("mascot", v)} />
        </Row>
        <Row label="Mascota de Codex" hint="Icono del widget de la mascota">
          <CodexPetPicker value={settings.codexPetIcon ?? "dog"} onChange={(v) => set("codexPetIcon", v)} />
        </Row>
        <div className="appearance-preview" aria-label="Vista previa del estilo de la barra">
          <span className="appearance-caption">Vista previa</span>
          <div className="appearance-sample" aria-hidden="true">
            <span className="time">14:32</span>
            <span className="preview-system"><Icon name="system" /></span>
            <span className="preview-mail"><Icon name="mail" /></span>
            <AiMark size={18} />
            <span className="preview-music"><Icon name="media" /></span>
            <Icon name="settings" />
          </div>
        </div>
        <Row label="Animar pulso del sistema" hint="Desactivado: icono estático">
          <Switch label="Animar pulso del sistema" checked={settings.pulseAnimation} onChange={(v) => set("pulseAnimation", v)} />
        </Row>
      </Section>

      <Section title="Comportamiento">
        <Row label="Compactar por inactividad" hint="Segundos: 0 desactiva; de 10 a 600. Por defecto, 40.">
          <input className="field num" type="number" min={0} max={600} step={1}
            aria-label="Segundos para compactar por inactividad" aria-describedby="auto-compact-hint"
            key={settings.autoCompactSeconds} defaultValue={settings.autoCompactSeconds}
            onBlur={(e) => {
              const value = e.currentTarget.valueAsNumber;
              if (!Number.isInteger(value) || value < 0) {
                e.currentTarget.value = String(settings.autoCompactSeconds);
                return;
              }
              const seconds = value === 0 ? 0 : Math.min(600, Math.max(10, value));
              e.currentTarget.value = String(seconds);
              if (seconds !== settings.autoCompactSeconds) void set("autoCompactSeconds", seconds);
            }} />
        </Row>
        <p className="hint pad" id="auto-compact-hint">Cierra el panel y vuelve a compacto. Espera mientras usas la barra, escribes, arrastras o suena un aviso.</p>
        <Row label="Siempre visible" hint="La barra queda por encima de otras ventanas">
          <Switch label="Siempre visible" checked={settings.alwaysOnTop} onChange={(v) => set("alwaysOnTop", v)} />
        </Row>
        <Row label="Iniciar con Windows">
          <Switch label="Iniciar con Windows" checked={settings.autostart} onChange={(v) => set("autostart", v)} />
        </Row>
      </Section>

      <Section title="Widgets">
        <ol className="widget-list" aria-label="Orden de widgets. Arrastra o usa Alt+Flecha para mover.">
          {settings.widgetOrder.map((id, i) => (
            <li key={id} data-id={id} tabIndex={0} onKeyDown={onItemKey(id, i)} {...dragProps(id)}>
              <Icon name="grip" />
              {id === "codex-pet" ? <CodexPetArt icon={settings.codexPetIcon ?? "dog"} /> : <Icon name={id} />}
              <span className="grow">{WIDGET_NAMES[id] ?? id}</span>
              <label className="widget-visibility">
                Mostrar en la barra
                <Switch label={`Mostrar en la barra: ${WIDGET_NAMES[id] ?? id}`} checked={!settings.hiddenWidgets.includes(id)} onChange={(visible) => set("hiddenWidgets", visible ? settings.hiddenWidgets.filter((item) => item !== id) : [...settings.hiddenWidgets, id])} />
              </label>
            </li>
          ))}
        </ol>
        <p className="hint pad">Arrastra para reordenar (también desde la barra) o usa Alt+Flecha. Ocultar un widget no desactiva su servicio. Debe quedar al menos uno visible.</p>
      </Section>

      </div>

      <div id="settings-panel-productivity" role="tabpanel" aria-labelledby="settings-tab-productivity" hidden={tab !== "productivity"} tabIndex={0}>
      <Section title="Resumen para Claude y Codex">
        <Row
          label="Compartir agenda y correo limitado"
          hint="Guarda en texto plano títulos y fechas de agenda, conteos de correo y remitente/asunto de los 5 últimos sin leer. Claude y Codex pueden recibirlos al consultar el resumen. Al apagarlo se borra."
        >
          <Switch label="Compartir agenda y correo limitado" checked={settings.shareToday} onChange={(v) => set("shareToday", v)} />
        </Row>
      </Section>

      <Section title="Portapapeles">
        <Row
          label="Historial del portapapeles"
          hint="Se ignoran los contenidos marcados como sensibles y lo copiado desde las apps de escritorio de Bitwarden, 1Password o KeePass. Lo copiado desde extensiones del navegador puede guardarse si la extensión no lo marca. Solo texto y solo en memoria; se borra al cerrar JarWis. Al desactivarlo se borra lo no fijado."
        >
          <Switch label="Historial del portapapeles" checked={settings.clipboardHistory} onChange={(v) => set("clipboardHistory", v)} />
        </Row>
      </Section>

      <Section title="Notificaciones">
        <Row label="Avisos de Windows" hint="Solo conteos y hora (correos nuevos, evento en 15 min); nunca asuntos, remitentes ni títulos. Solo avisa con la barra visible.">
          <Switch label="Notificaciones" checked={settings.notifications} onChange={(v) => set("notifications", v)} />
        </Row>
      </Section>

      <ShortcutsEditor initial={settings.shortcuts} />
      <WorkspacesEditor initial={settings.workspaces} shortcuts={settings.shortcuts} />
      <WeatherEditor place={settings.weatherPlace ?? null} />

      <Section title="Atajos">
        {status && status.shortcutErrors.length > 0 ? (
          <ul className="errors">
            {status.shortcutErrors.map((e) => (
              <li key={e}>No se pudo registrar {e}</li>
            ))}
          </ul>
        ) : (
          <>
            <Row label="Mostrar u ocultar">
              <span className="keys">
                <kbd>Ctrl</kbd>
                <kbd>Alt</kbd>
                <kbd>J</kbd>
              </span>
            </Row>
            <Row label="Compacto / expandido">
              <span className="keys">
                <kbd>Ctrl</kbd>
                <kbd>Alt</kbd>
                <kbd>K</kbd>
              </span>
            </Row>
            <Row label="Portapapeles">
              <span className="keys">
                <kbd>Ctrl</kbd>
                <kbd>Alt</kbd>
                <kbd>C</kbd>
              </span>
            </Row>
          </>
        )}
      </Section>

      </div>

      <div id="settings-panel-accounts" role="tabpanel" aria-labelledby="settings-tab-accounts" hidden={tab !== "accounts"} tabIndex={0}>
        <GoogleAccount />
      </div>

      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}

      <footer>
        <button className="btn" data-action="close" onClick={closeWindow}>
          Listo
        </button>
      </footer>
    </main>
  );
}
