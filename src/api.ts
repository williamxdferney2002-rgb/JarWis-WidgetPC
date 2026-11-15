import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent, type MouseEvent } from "react";

export type Edge = "top" | "bottom" | "left" | "right";
export type Mode = "compact" | "expanded";
export type Theme = "system" | "light" | "dark";
export type IslandColor = "black" | "royal";
/** Estilo de la barra; la interfaz lo aplica en `document.documentElement.dataset.style`. */
export type BarStyle = "classic" | "aurora";
export type AuroraAccent = "violet" | "cyan" | "amber";
/** Mascota de la pastilla minimizada (D-056). */
export type Mascot = "air" | "fire" | "water" | "earth";
export type CodexPetIcon = "dog" | "dragon";

export interface Settings {
  edge: Edge;
  monitor: string | null;
  alwaysOnTop: boolean;
  mode: Mode;
  minimized: boolean;
  /** Segundos hasta compactar por inactividad; 0 = apagado, por defecto 40. */
  autoCompactSeconds: number;
  theme: Theme;
  islandColor: IslandColor;
  pulseAnimation: boolean;
  autostart: boolean;
  /** Solo se reordena con `widgetMove`, sobre el orden vigente del núcleo. */
  widgetOrder: string[];
  /** Ocultos solo en la barra; no desactiva sus servicios. */
  hiddenWidgets: string[];
  /** Se editan por id con los comandos de alarmas. */
  alarms: Alarm[];
  clipboardHistory: boolean;
  /** Solo lectura aquí: se cambian con `setShortcuts`, fuera de `patchSettings`. */
  shortcuts: QuickShortcut[];
  /** Posición a lo largo de cada borde (0–1, 0,5 = centro). Solo lectura: la cambian el arrastre y «Centrar» del menú de la isla. */
  barOffsets: Record<Edge, number>;
  /** Avisos de Windows (solo conteos y hora, nunca asuntos ni remitentes). Desactivado por defecto. */
  notifications: boolean;
  /** Espacios de trabajo: conjuntos de accesos existentes. Se cambian con `setWorkspaces`, fuera de `patchSettings`. */
  workspaces: Workspace[];
  weatherPlace: WeatherPlace | null;
  /** Escribir agenda (títulos y fechas) y correo limitado (D-081) en %LOCALAPPDATA%\JarWis\hoy.json. Apagarlo borra el archivo. Por defecto, activado. */
  shareToday: boolean;
  /** Estilo visual de la barra. Por defecto, "classic". */
  barStyle: BarStyle;
  /** Acento de Aurora, sin lectura automática del fondo de pantalla. */
  auroraAccent: AuroraAccent;
  /** Mascota de la pastilla minimizada. Por defecto, "air". */
  mascot: Mascot;
  /** Icono del widget de Codex. Por defecto, "dog". */
  codexPetIcon: CodexPetIcon;
}

/** Espacio de trabajo (máx. 10; 1–10 accesos existentes; nombre 1–60). `id` 0 = nuevo (el núcleo asigna uno). */
export interface Workspace {
  id: number;
  name: string;
  shortcuts: number[];
  color?: ShortcutColor | null;
  icon?: ShortcutIcon | null;
}

/** Acceso rápido. `id` 0 = nuevo (el núcleo asigna uno). `target`: URL, ruta absoluta o, en `store`, el AUMID (`Paquete!App`). */
export interface QuickShortcut {
  id: number;
  name: string;
  kind: "url" | "app" | "folder" | "file" | "store";
  target: string;
  /** Color con nombre; null/ausente: la UI deriva uno. El núcleo rechaza valores fuera de la lista. */
  color?: ShortcutColor | null;
  /** Icono con nombre; null/ausente: icono por tipo. */
  icon?: ShortcutIcon | null;
}

/** Listas blancas del núcleo (`shortcuts::COLORS` / `ICONS`). */
export const SHORTCUT_COLORS = ["blue", "red", "green", "orange", "purple", "pink", "teal", "yellow", "gray", "indigo"] as const;
export type ShortcutColor = (typeof SHORTCUT_COLORS)[number];
export const SHORTCUT_ICONS = [
  "music", "video", "chat", "folder", "code", "game", "shop", "bank", "mail",
  "web", "app", "doc", "photo", "cloud", "terminal", "key", "star", "home",
] as const;
export type ShortcutIcon = (typeof SHORTCUT_ICONS)[number];

/** App de Microsoft Store instalada; `appId` va en `target` de un acceso `store`. */
export interface StoreApp {
  name: string;
  appId: string;
}

export interface Battery {
  percent: number;
  charging: boolean;
  onAc: boolean;
}

/** Muestra del sistema: bytes, % de CPU, tasas de red en bytes/s desde la llamada anterior. */
export interface SystemSnapshot {
  cpu: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  netRxBps: number;
  netTxBps: number;
  uptimeSecs: number;
  battery: Battery | null;
  level: "ok" | "warn" | "crit";
}

export interface AudioState {
  volume: number;
  muted: boolean;
  deviceName: string;
}

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface MediaState {
  title: string;
  artist: string;
  playing: boolean;
  canPrev: boolean;
  canNext: boolean;
  canPlayPause: boolean;
  appId: string;
}

export type MediaAction = "playPause" | "next" | "prev";

/** Alarma: `days` 0 = lunes … 6 = domingo; vacío = una sola vez. El núcleo asigna `id`. */
export interface Alarm {
  id: number;
  hour: number;
  minute: number;
  days: number[];
  label: string;
  enabled: boolean;
}

export interface TimerView {
  id: number;
  label: string;
  durationMs: number;
  remainingMs: number;
  running: boolean;
}

export interface Alert {
  id: number;
  kind: "timer" | "alarm";
  source: number;
  label: string;
}

export interface ClockView {
  timers: TimerView[];
  alerts: Alert[];
}

/** Elemento del historial del portapapeles: solo un fragmento del texto (`at` en ms Unix). */
export interface ClipItem {
  id: number;
  preview: string;
  at: number;
  pinned: boolean;
}

export interface ClipboardView {
  items: ClipItem[];
  paused: boolean;
}

export interface MonitorInfo {
  name: string;
  label: string;
  primary: boolean;
}

export interface Status {
  shortcutErrors: string[];
}

/** Aplica solo los campos presentes; el núcleo rechaza campos gestionados por comandos propios. */
export const patchSettings = (patch: Partial<Settings>) => invoke<Settings>("patch_settings", { patch });
export const setMinimized = (v: boolean) => invoke<Settings>("set_minimized", { minimized: v });
export const alarmAdd = (alarm: Omit<Alarm, "id">) => invoke<Settings>("alarm_add", { alarm });
export const alarmSetEnabled = (id: number, enabled: boolean) => invoke<Settings>("alarm_set_enabled", { id, enabled });
export const alarmRemove = (id: number) => invoke<Settings>("alarm_remove", { id });
export const widgetMove = (id: string, target: string) => invoke<Settings>("widget_move", { id, target });
export const listMonitors = () => invoke<MonitorInfo[]>("list_monitors");
export const getStatus = () => invoke<Status>("get_status");
export const openSettings = () => invoke<void>("open_settings");
/** Menú contextual nativo de la isla (posición, ocultar, Ajustes, salir). */
export const barMenu = () => invoke<void>("bar_menu");
/** Arrastre nativo de la isla; al soltar se pega al borde más cercano (núcleo). */
export const barDrag = () => invoke<void>("bar_drag");
export const timerAdd = (label: string, seconds: number) => invoke<ClockView>("timer_add", { label, seconds });
export const timerControl = (id: number, action: "pause" | "resume" | "cancel") =>
  invoke<ClockView>("timer_control", { id, action });
export const alertDismiss = (id: number, snooze: boolean) => invoke<ClockView>("alert_dismiss", { id, snooze });
/** `height`: alto lógico del contenido en px; el núcleo lo acota entre 160 y el alto fijo. Sin él, el alto fijo. */
export const setPanel = (open: boolean, height?: number) => invoke<void>("set_panel", { open, height: height ?? null });
export const clipboardList = (query: string) => invoke<ClipboardView>("clipboard_list", { query });
export const clipboardCopy = (id: number) => invoke<void>("clipboard_copy", { id });
export const clipboardPin = (id: number, pinned: boolean) => invoke<void>("clipboard_pin", { id, pinned });
export const clipboardDelete = (id: number) => invoke<void>("clipboard_delete", { id });
export const clipboardClear = () => invoke<void>("clipboard_clear");
export const clipboardPause = (paused: boolean) => invoke<void>("clipboard_pause", { paused });
/** Llamar solo con la isla visible (el núcleo no sondea por su cuenta). */
export const systemSnapshot = () => invoke<SystemSnapshot>("system_snapshot");
/** Lectura puntual al abrir Sistema y después de cambiar, sin sondeo ni consulta al arrancar. */
export type PowerMode = "efficiency" | "balanced" | "performance" | "unknown";
export const powerMode = () => invoke<PowerMode>("power_mode");
/** Solo por botón; Rust valida el enum y devuelve el modo efectivo actualizado. */
export const powerSet = (mode: Exclude<PowerMode, "unknown">) => invoke<PowerMode>("power_set", { mode });
/** Destinos fijos en Rust; no modifica el modo ni los ventiladores. */
export const powerOpen = (target: "settings" | "omen") => invoke<void>("power_open", { target });
export const getShortcuts = () => invoke<QuickShortcut[]>("get_shortcuts");
/** Valida y guarda la lista completa (máx. 50); rechaza con un mensaje en español. */
export const setShortcuts = (list: QuickShortcut[]) => invoke<QuickShortcut[]>("set_shortcuts", { list });
/** Solo Ajustes. Valida y guarda la lista completa; rechaza con un mensaje en español. */
export const setWorkspaces = (list: Workspace[]) => invoke<Workspace[]>("set_workspaces", { list });
/** Barra. Informa cuántos accesos abrió y, en el error, cuáles fallaron. */
export const openWorkspace = (id: number) => invoke<string>("open_workspace", { id });
/** Barra. Abre la configuración de Concentración de Windows (no la modifica). */
export const openFocusSettings = () => invoke<void>("open_focus_settings");
export const openShortcut = (id: number) => invoke<void>("open_shortcut", { id });
/** Solo Ajustes. Ordenadas por nombre. */
export const listStoreApps = () => invoke<StoreApp[]>("list_store_apps");
/** Salida predeterminada; `null` si no hay dispositivo. `volume` 0–100. */
export const audioState = () => invoke<AudioState | null>("audio_state");
/** Se acota a 0–100 en el núcleo. */
export const setVolume = (volume: number) => invoke<void>("set_volume", { volume });
export const setMuted = (muted: boolean) => invoke<void>("set_muted", { muted });
/** Solo salidas activas. Cambiar el predeterminado: `openSoundSettings`. */
export const listAudioDevices = () => invoke<AudioDevice[]>("list_audio_devices");
export const openSoundSettings = () => invoke<void>("open_sound_settings");
/** Sesión multimedia actual del sistema; `null` si no hay. */
export const mediaState = () => invoke<MediaState | null>("media_state");
/** `true` si la app de la sesión aceptó la orden. */
export const mediaControl = (action: MediaAction) => invoke<boolean>("media_control", { action });
/** Tienda → web; Spotify conserva Spotify.exe intermedio y YouTube solo web. Destinos fijos en el núcleo. */
export type MediaTarget = "spotify" | "youtube" | "netflix" | "telegram" | "whatsapp";
export const mediaOpen = (target: MediaTarget) => invoke<void>("media_open", { target });

// ---- Google (Fase 4, D-038). Sin enlaces: para abrir, `cloudOpen(kind, id)`.

export type CloudErrorKind = "signedOut" | "expired" | "network" | "quota" | "config" | "other";

/** Últimos datos buenos (o `null`) y último error; `updatedAt` en ms Unix de la última consulta correcta. */
export interface Feed<T> {
  data: T | null;
  error: { kind: CloudErrorKind; message: string } | null;
  updatedAt: number | null;
}

/** Correo no leído: remitente (nombre o dominio, ≤ 60), asunto (≤ 120), `date` en ms Unix. */
export interface MailItem {
  id: string;
  source: "gmail" | "outlook";
  from: string;
  subject: string;
  date: number | null;
}

/** Conteos ≤ 100; `*More` = hay más de 100 («100+»). */
export interface MailView {
  inboxUnread: number;
  inboxMore: boolean;
  outlookUnread: number;
  outlookMore: boolean;
  items: MailItem[];
}

/** `start`: RFC 3339 o, con `allDay`, AAAA-MM-DD. */
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  allDay: boolean;
}

export interface CloudTask {
  id: string;
  title: string;
  due: string | null;
}

export interface AgendaView {
  events: CalendarEvent[];
  tasks: CloudTask[];
  pendingTasks: number;
  tasksPartial: boolean;
}

export interface MonthView {
  days: Record<string, {
    events: Omit<CalendarEvent, "id">[];
    tasks: { title: string; due: string }[];
  }>;
  partial: boolean;
}

export interface CloudStatus {
  configured: boolean;
  connected: boolean;
  loginInProgress: boolean;
}

/** Evento sin datos tras login/logout: volver a consultar con `force`. */
export const CLOUD_EVENT = "cloud-changed";
/** Barra. Devuelve la caché si sigue fresca o hay una consulta en curso. */
export const cloudMail = (force = false) => invoke<Feed<MailView>>("cloud_mail", { force });
export const cloudAgenda = (force = false) => invoke<Feed<AgendaView>>("cloud_agenda", { force });
/** Calendario mensual bajo demanda: sin sondeo ni exportación a hoy.json. */
export const cloudMonth = (year: number, month: number, force = false) => invoke<Feed<MonthView>>("cloud_month", { year, month, force });
export const cloudOpen = (kind: "mail" | "event" | "task", id: string) => invoke<void>("cloud_open", { kind, id });
/** Ajustes. */
export const cloudStatus = () => invoke<CloudStatus>("cloud_status");
export const cloudLogin = () => invoke<{ account: string | null }>("cloud_login");
export const cloudLogout = () => invoke<{ deleted: boolean; revoked: boolean | null }>("cloud_logout");

// ---- Lanzador de IA (D-044, D-047). La WebView solo envía la acción; los destinos están en el núcleo.

/**
 * "app": app de Claude de la Tienda (si no, claude.ai); "terminal": Claude Code en la carpeta de usuario;
 * "usage": claude.ai/settings/usage; "chatgpt": app de la Tienda (si no, chatgpt.com);
 * "antigravity": Antigravity IDE (error si no está instalado).
 */
export type ClaudeOpenAction = "web" | "terminal" | "app" | "usage" | "chatgpt" | "antigravity";
export const claudeOpen = (action: ClaudeOpenAction) => invoke<void>("claude_open", { action });
export const showCodexPet = () => invoke<void>("show_codex_pet");

/**
 * Sondeo de un feed de Google dirigido por la UI (D-035): consulta al activarse, cada `ms`
 * y con `force` al recibir `cloud-changed` si está activo (isla visible).
 * La invalidación de sesión se escucha también mientras la isla está oculta.
 * Un feed sin datos ni error reintenta cada 5 s; solo el clima tiene tope de cuatro.
 * Los feeds públicos pueden desactivar los eventos de sesión de Google.
 */
const reloaders = new Map<unknown, () => Promise<void>>();
/** Consulta forzada (el núcleo la limita a una cada 15 s) del feed que usa `useCloud(load, …)`; actualiza su estado. */
export const reloadCloud = (load: unknown): Promise<void> => reloaders.get(load)?.() ?? Promise.resolve();

export function useCloud<T>(load: (force: boolean) => Promise<Feed<T>>, active: boolean, ms: number, googleSession = true): Feed<T> | null {
  const visible = usePageVisible(active);
  const [feed, setFeed] = useState<Feed<T> | null>(null);
  const session = useRef(0);
  const feedSource = useRef(load);
  const refreshSession = useRef<(() => void) | null>(null);
  useEffect(() => {
    session.current += 1;
    feedSource.current = load;
    setFeed(null);
    if (!googleSession) return;
    let alive = true;
    const un = listen(CLOUD_EVENT, () => {
      if (!alive) return;
      // Revocar datos y solicitudes incluso cuando el sondeo está suspendido.
      session.current += 1;
      setFeed(null);
      refreshSession.current?.();
    });
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, [load, googleSession]);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let retry = 0;
    let retries = 0;
    let inFlight: Promise<void> | null = null;
    let inFlightForced = false;
    const run = (force: boolean): Promise<void> => {
      if (!alive || document.hidden) return Promise.resolve();
      const current = session.current;
      if (inFlight) {
        if (!force || inFlightForced) return inFlight;
        // Aplicar el sondeo primero y conservar la intención forzada en esta sesión.
        return inFlight.then(() => {
          if (alive && current === session.current) return run(true);
        });
      }
      const pending = load(force).then(
        (f) => {
          if (!alive || current !== session.current) return;
          if (!f.data && !f.error) {
            if (!googleSession && retries >= 4) {
              setFeed({ ...f, error: { kind: "other", message: "La consulta sigue en curso. Se volverá a consultar en la próxima actualización." } });
              return;
            }
            if (!retry) retry = window.setTimeout(() => {
              retry = 0;
              retries += 1;
              void run(false);
            }, 5000);
          } else {
            window.clearTimeout(retry);
            retry = 0;
            retries = 0;
          }
          setFeed(f);
        },
        () => {
          if (!alive || current !== session.current) return;
          setFeed((previous) => current !== session.current ? previous : ({
            data: previous?.data ?? null,
            updatedAt: previous?.updatedAt ?? null,
            error: { kind: "other", message: "No se pudo actualizar. Vuelve a intentarlo con Actualizar." },
          }));
        },
      ).finally(() => {
        if (inFlight === pending) {
          inFlight = null;
          inFlightForced = false;
        }
      });
      inFlight = pending;
      inFlightForced = force;
      return pending;
    };
    reloaders.set(load, () => run(true));
    run(false);
    const id = window.setInterval(() => run(false), ms);
    refreshSession.current = () => {
      window.clearTimeout(retry);
      retry = 0;
      retries = 0;
      // La sesión nueva no comparte la promesa de la sesión revocada.
      inFlight = null;
      void run(true);
    };
    return () => {
      alive = false;
      refreshSession.current = null;
      reloaders.delete(load);
      window.clearInterval(id);
      window.clearTimeout(retry);
    };
  }, [load, visible, ms, googleSession]);
  return feedSource.current === load ? feed : null;
}

/**
 * Estado del reloj del núcleo (evento `clock-changed`). `at` es el
 * `performance.now()` de la recepción: los restantes se descuentan desde ahí.
 */
export function useClockView(): { view: ClockView; at: number } {
  const [state, setState] = useState({ view: { timers: [], alerts: [] } as ClockView, at: 0 });
  useEffect(() => {
    const set = (view: ClockView) => setState({ view, at: performance.now() });
    invoke<ClockView>("clock_state").then(set).catch(() => {});
    const un = listen<ClockView>("clock-changed", (e) => set(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);
  return state;
}

/** Visibilidad de la isla según el núcleo (`document.hidden` no cambia al ocultar la ventana). */
export function useBarVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const un = listen<boolean>("bar-visibility", (e) => setVisible(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);
  return visible;
}

/** Combina la visibilidad de la vista con la de la WebView; refresca al volver. */
export function usePageVisible(active: boolean): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const sync = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return active && visible;
}

/**
 * Fuerza un repintado cada `ms` mientras `active` y la página esté visible.
 * Sin temporizadores con la isla oculta o sin nada en marcha.
 */
export function useTick(active: boolean, ms: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const start = () => {
      if (!id && !document.hidden) {
        setN((n) => n + 1);
        id = window.setInterval(() => setN((n) => n + 1), ms);
      }
    };
    const stop = () => {
      window.clearInterval(id);
      id = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, ms]);
}

/** Geometría transitoria del monitor, sin persistirla en los ajustes. */
export function useBarTrack() {
  const [track, setTrack] = useState<{ width: number; height: number; pixel: number } | null>(null);
  useEffect(() => {
    let alive = true;
    let changed = false;
    const un = listen<NonNullable<typeof track>>("bar-track", (e) => {
      changed = true;
      if (alive) setTrack(e.payload);
    });
    void un.then(() => invoke<typeof track>("bar_track")).then((value) => {
      if (alive && !changed) setTrack(value);
    }).catch(() => {});
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, []);
  return track;
}

/** Ajustes actuales, sincronizados con el evento `settings-changed` del núcleo. */
export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    let changed = false;
    setError(null);
    const accept = (value: Settings) => {
      if (!alive) return;
      setSettings(value);
      setError(null);
    };
    const un = listen<Settings>("settings-changed", (e) => {
      changed = true;
      accept(e.payload);
    });
    invoke<Settings>("get_settings").then(
      (value) => { if (!changed) accept(value); },
      () => { if (alive && !changed) setError("No se pudieron cargar los ajustes."); },
    );
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, [attempt]);
  return { settings, error, retry };
}

/** Aplica la clase `dark` según el tema; «sistema» sigue a prefers-color-scheme. */
export function useTheme(theme: Theme | undefined) {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || ((theme ?? "system") === "system" && mq.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
}

/** Marca el color de la isla en la raíz (`data-island`); las variables CSS hacen el resto. */
export function useIslandColor(color: IslandColor | undefined) {
  useEffect(() => {
    document.documentElement.dataset.island = color ?? "black";
  }, [color]);
}

/** Marca el estilo de la barra en la raíz (`data-style`: classic | aurora). */
export function useBarStyle(style: BarStyle | undefined) {
  useEffect(() => {
    document.documentElement.dataset.style = style ?? "classic";
  }, [style]);
}

/** Paleta acotada de Aurora; el valor por defecto también cubre ajustes antiguos. */
export function useAuroraAccent(accent: AuroraAccent | undefined) {
  useEffect(() => {
    document.documentElement.dataset.aurora = accent ?? "cyan";
  }, [accent]);
}

/**
 * Props para reordenar widgets; con `onExit`, salir de la isla entrega el gesto a la barra.
 * Marca el origen con `data-dragging` y el destino con `data-over` (estilos en CSS).
 */
export function useReorder(onMove: (id: string, target: string) => void, onExit?: () => void) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const gesture = useRef<{ x: number; y: number; moved: boolean; capture: HTMLElement } | null>(null);
  const suppressClick = useRef(false);
  const reset = () => {
    setDragged(null);
    setOver(null);
  };
  return (id: string) => ({
    // En compacto, capturar el puntero permite distinguir ordenar dentro de la
    // fila de mover la barra fuera de ella; HTML5 consumiría todo el gesto.
    draggable: !onExit,
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (!onExit || e.button !== 0) return;
      suppressClick.current = false;
      // Capturar en el botón conserva el destino del clic normal y su panel.
      const capture = e.currentTarget.querySelector<HTMLElement>("button") ?? e.currentTarget;
      gesture.current = { x: e.clientX, y: e.clientY, moved: false, capture };
      capture.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!onExit || !g || Math.hypot(e.clientX - g.x, e.clientY - g.y) < 5) return;
      g.moved = true;
      suppressClick.current = true;
      const island = e.currentTarget.closest(".island")?.getBoundingClientRect();
      if (island && (e.clientX < island.left || e.clientX > island.right || e.clientY < island.top || e.clientY > island.bottom)) {
        gesture.current = null;
        reset();
        g.capture.releasePointerCapture(e.pointerId);
        onExit();
        return;
      }
      setDragged(id);
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".widget[data-id]");
      setOver(target?.parentElement === e.currentTarget.parentElement ? target.dataset.id ?? null : null);
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      if (!onExit) return;
      const g = gesture.current;
      gesture.current = null;
      if (g?.moved) {
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".widget[data-id]");
        if (target?.parentElement === e.currentTarget.parentElement && target.dataset.id && target.dataset.id !== id) onMove(id, target.dataset.id);
      }
      if (g?.capture.hasPointerCapture(e.pointerId)) g.capture.releasePointerCapture(e.pointerId);
      reset();
    },
    onLostPointerCapture: () => { if (onExit) { gesture.current = null; reset(); } },
    onPointerCancel: () => { if (onExit) { gesture.current = null; reset(); } },
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      if (onExit && suppressClick.current && e.detail !== 0) { e.preventDefault(); e.stopPropagation(); }
    },
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
      setDragged(id);
    },
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (over !== id) setOver(id);
    },
    onDragLeave: () => setOver((o) => (o === id ? null : o)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const from = dragged ?? e.dataTransfer.getData("text/plain");
      if (from) onMove(from, id);
      reset();
    },
    onDragEnd: reset,
    "data-dragging": dragged === id || undefined,
    "data-over": (over === id && dragged !== id) || undefined,
  });
}

export const WIDGET_NAMES: Record<string, string> = {
  clock: "Reloj",
  system: "Sistema",
  mail: "Correo",
  calendar: "Calendario",
  claude: "IA",
  clipboard: "Portapapeles",
  "codex-pet": "Mascota de Codex",
  media: "Música",
  shortcuts: "Accesos",
  today: "Hoy",
};

/** Ciudad elegida manualmente, sin geolocalización. */
export interface WeatherPlace {
  name: string;
  admin?: string | null;
  country?: string | null;
  latitude: number;
  longitude: number;
}
export interface WeatherView {
  temperature: number;
  maximum: number | null;
  minimum: number | null;
  rainProbability: number | null;
  weatherCode: number;
  dailyCode: number | null;
  isDay: boolean;
}
export const weatherToday = (force: boolean) => invoke<Feed<WeatherView>>("weather_today", { force });
export const weatherSearch = (query: string) => invoke<WeatherPlace[]>("weather_search", { query });
export const weatherOpen = (target: "provider" | "licence") => invoke<void>("weather_open", { target });
