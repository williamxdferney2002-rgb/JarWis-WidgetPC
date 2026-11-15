import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  barDrag,
  barMenu,
  cloudAgenda,
  cloudMail,
  weatherToday,
  openSettings,
  setPanel,
  setMinimized,
  showCodexPet,
  patchSettings,
  useClockView,
  useIslandColor,
  useBarStyle,
  useAuroraAccent,
  widgetMove,
  useReorder,
  useSettings,
  useBarTrack,
  useTheme,
  useBarVisible,
  usePageVisible,
  useCloud,
  useTick,
  WIDGET_NAMES,
  type Settings,
} from "./api";
import { AgendaPanel } from "./Agenda";
import { AiPanel } from "./Ai";
import { ClipboardPanel } from "./Clipboard";
import { AlertView, ClockPanel, indicator, useStopwatch } from "./Clock";
import { AiMark, CodexPetArt, Icon } from "./icons";
import { mascotImages } from "./mascots";
import { MailPanel } from "./Mail";
import { MediaPanel } from "./Media";
import { TodayPanel } from "./Today";
import { ShortcutsPanel } from "./Shortcuts";
import { SystemPanel, useSystem } from "./System";
import { SettingsStatus } from "./SettingsStatus";

/** Hora local, actualizada una vez por minuto alineada al cambio de minuto. */
function useMinuteClock(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  const visible = usePageVisible(active);
  useEffect(() => {
    if (!visible) return;
    setNow(new Date());
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, 60_000 - (Date.now() % 60_000));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [visible]);
  return now;
}

/**
 * Balanceo ocasional de la mascota (D-032, D-056): un setTimeout cada ~8 s que
 * lanza una animación de 600 ms, nunca una animación CSS infinita. Sin temporizador
 * con la ventana oculta, fuera de Mini o con «reducir movimiento».
 */
function useMascotSway(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer = 0;
    const stop = () => { window.clearTimeout(timer); timer = 0; };
    const tick = () => {
      document.querySelector(".mascot-art")?.animate(
        [{ transform: "translateY(0)" }, { transform: "translateY(2px)" }, { transform: "translateY(0)" }],
        { duration: 600, easing: "ease-in-out" },
      );
      timer = window.setTimeout(tick, 8000);
    };
    const sync = () => {
      if (document.hidden || mq.matches) stop();
      else if (!timer) timer = window.setTimeout(tick, 8000);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    mq.addEventListener("change", sync);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", sync);
      mq.removeEventListener("change", sync);
    };
  }, [on]);
}

// Ventana lógica [ancho, alto] que coloca el núcleo para cada forma de presencia,
// horizontal y vertical (copia de src-tauri/src/layout.rs::logical_size).
const PRESENCE_WINDOW: Record<string, [[number, number], [number, number]]> = {
  mini: [[148, 60], [60, 124]],
  compact: [[340, 44], [52, 328]],
  expanded: [[1000, 112], [200, 780]],
};

/**
 * Resuelve cuando la ventana mide lo que corresponde a `shape` (±1 px) o, como tope,
 * a los 250 ms (área recortada, ventana oculta). Formas sin tamaño fijo: al instante.
 */
function windowFits(shape: string | null, vertical: boolean): Promise<void> {
  const size = shape ? PRESENCE_WINDOW[shape]?.[vertical ? 1 : 0] : undefined;
  const fits = () => !size || (Math.abs(innerWidth - size[0]) <= 1 && Math.abs(innerHeight - size[1]) <= 1);
  if (fits()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener("resize", check);
      window.clearTimeout(timer);
      resolve();
    };
    const check = () => { if (fits()) done(); };
    const timer = window.setTimeout(done, 250);
    window.addEventListener("resize", check);
  });
}

/**
 * Latido del icono Sistema: `data-beat` en la raíz 200 ms cada 1,6 s.
 * Dos cambios de estilo por ciclo en lugar de una animación CSS continua
 * (que repinta la WebView transparente a 60 fps). Parado con la isla oculta,
 * con «reducir movimiento» de Windows o con el ajuste desactivado.
 */
function usePulse(on: boolean) {
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let interval = 0;
    let off = 0;
    const stop = () => {
      window.clearInterval(interval);
      window.clearTimeout(off);
      interval = 0;
      root.removeAttribute("data-beat");
    };
    const beat = () => {
      root.setAttribute("data-beat", "");
      off = window.setTimeout(() => root.removeAttribute("data-beat"), 200);
    };
    const sync = () => {
      if (!on || mq.matches || document.hidden) stop();
      else if (!interval) interval = window.setInterval(beat, 1600);
    };
    sync();
    mq.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      stop();
      mq.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [on]);
}

/** Paneles: la tercera forma de la isla. */
type PanelKind = "clock" | "clipboard" | "system" | "media" | "shortcuts" | "mail" | "calendar" | "claude" | "today";
const PANELS = ["clock", "clipboard", "system", "media", "shortcuts", "mail", "calendar", "claude", "today"];
const PANEL_TITLES: Record<string, string> = {
  clock: "Reloj: cronómetro, temporizadores y alarmas",
  clipboard: "Portapapeles: historial de textos copiados (Ctrl+Alt+C)",
  system: "Sistema: CPU, memoria, disco, red y batería",
  media: "Audio y multimedia: volumen y reproducción",
  shortcuts: "Accesos rápidos",
  mail: "Correo: no leídos de Gmail y Outlook",
  calendar: "Calendario: eventos y tareas de Google",
  claude: "IA: Claude, Claude en la terminal, tu uso, ChatGPT y Antigravity",
  today: "Hoy: resumen del día, Concentración y espacios de trabajo",
};

/** Margen de la ventana (4+4) + relleno de la isla (10+10) + borde (1+1) alrededor del panel. */
const PANEL_CHROME = 30;

const time = (d: Date) => d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });

/**
 * Icono del widget. Sistema lleva `data-level` (ok | warn | crit, del núcleo); Correo, un contador de nuevos (oculto si es 0).
 */
function WidgetIcon({ id, size, mailCount, level }: { id: string; size?: number; mailCount: number; level: string }) {
  if (id === "system") {
    return (
      <span className="vital" data-level={level}>
        <Icon name="system" size={size} />
      </span>
    );
  }
  if (id === "mail") {
    return (
      <span className="badge-wrap">
        <Icon name="mail" size={size} />
        {mailCount > 0 && <span className="badge">{mailCount > 99 ? "99+" : mailCount}</span>}
      </span>
    );
  }
  if (id === "claude") return <AiMark size={size ? size + 2 : 18} />;
  return <Icon name={id} size={size} />;
}

/** Contenido de un widget: en compacto solo el icono (el reloj, la hora); en expandido, una tarjeta. */
function Widget({ id, expanded, now, badge, mailCount, level, summary }: { id: string; expanded: boolean; now: Date; badge: string | null; mailCount: number; level: string; summary?: string }) {
  const name = WIDGET_NAMES[id] ?? id;
  const clockBadge = id === "clock" && badge && <span className="time-badge">{badge}</span>;
  if (!expanded) {
    return id === "clock" ? (
      <>
        <span className="time">{time(now)}</span>
        {clockBadge}
      </>
    ) : (
      <WidgetIcon id={id} mailCount={mailCount} level={level} />
    );
  }
  return (
    <>
      <span className="tile-head">
        <WidgetIcon id={id} size={14} mailCount={mailCount} level={level} />
        <span className="tile-name">{name}</span>
        {clockBadge}
      </span>
      {id === "clock" ? (
        <>
          <span className="time-lg">{time(now)}</span>
          <span className="tile-sub">{now.toLocaleDateString("es", { weekday: "short", day: "numeric", month: "short" })}</span>
        </>
      ) : (
        <span className="tile-sub">{summary ?? "Abrir"}</span>
      )}
    </>
  );
}

export default function Bar() {
  const { settings, error: loadError, retry } = useSettings();
  const track = useBarTrack();
  useTheme(settings?.theme);
  useIslandColor(settings?.islandColor);
  useBarStyle(settings?.barStyle);
  useAuroraAccent(settings?.auroraAccent);
  const visible = useBarVisible();
  const now = useMinuteClock(visible);
  const clock = useClockView();
  const sw = useStopwatch();
  const [panel, setPanelOpen] = useState<PanelKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [codexPetError, setCodexPetError] = useState<string | null>(null);
  const [codexPetBusy, setCodexPetBusy] = useState(false);
  const codexPetPending = useRef(false);
  const returnFocus = useRef<string | null>(null);
  const opening = useRef(0);
  const island = useRef<HTMLDivElement>(null);
  const presenceAnimation = useRef<Animation | null>(null);
  const presenceRequest = useRef(0);
  // Cada cambio de presencia oculta la isla; solo el último la vuelve a mostrar.
  const revealToken = useRef(0);
  const keyboardRestore = useRef(false);
  const miniGesture = useRef<{ x: number; y: number; dragged: boolean; active: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pointerHeld = useRef(false);
  const idleAction = useRef(() => {});
  // Alto natural del panel abierto (px); la isla y la ventana se ajustan a él.
  const [fit, setFit] = useState<number | null>(null);
  const onError = (e: unknown) => {
    setError(String(e));
    // El mensaje debe poder leerse también si la acción falló desde el modo compacto.
    void setPanel(true).catch(() => {});
  };
  const showPet = async () => {
    if (codexPetPending.current) return;
    codexPetPending.current = true;
    setCodexPetBusy(true);
    try {
      setCodexPetError(null);
      await showCodexPet();
    } catch (e) {
      setCodexPetError(String(e));
    } finally {
      codexPetPending.current = false;
      setCodexPetBusy(false);
    }
  };

  useEffect(() => {
    if (panel || error) {
      document.querySelector<HTMLElement>(".island > .panel-view button, .island > .panel-view input")?.focus({ preventScroll: true });
    } else if (returnFocus.current) {
      (document.querySelector<HTMLElement>(settings?.minimized ? ".mini-trigger" : `.widget[data-id="${returnFocus.current}"] button`)
        ?? document.querySelector<HTMLElement>(".widget-trigger"))?.focus({ preventScroll: true });
      returnFocus.current = null;
    }
  }, [panel, error]);

  useEffect(() => {
    if (!panel && !error) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      e.preventDefault();
      opening.current++;
      setError(null);
      setPanelOpen(null);
      setFit(null);
      void setPanel(false).catch(onError);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [panel, error]);

  const alerts = clock.view.alerts;
  const running = sw.running || clock.view.timers.some((t) => t.running);
  const mini = Boolean(settings?.minimized && !panel && !error && !alerts.length);
  const idleEligible = !mini && (settings?.mode === "expanded" || Boolean(panel || error));
  // Un solo vencimiento, reiniciado por interacción; nunca sondea el cursor ni el foco.
  useEffect(() => {
    const el = island.current;
    const seconds = settings?.autoCompactSeconds ?? 40;
    if (!el || !idleEligible || !seconds || !visible || dragging || alerts.length) return;
    let timer = 0;
    let disposed = false;
    let pointerOver = el.matches(":hover");
    let reordering = false;
    const stop = () => { window.clearTimeout(timer); timer = 0; };
    const textFocused = () => {
      const focus = document.activeElement;
      return focus instanceof HTMLElement && el.contains(focus) &&
        (focus.matches("input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, [role=textbox]") || focus.isContentEditable);
    };
    const reset = () => {
      stop();
      if (!disposed && !document.hidden && !pointerOver && !pointerHeld.current && !reordering && !textFocused()) {
        timer = window.setTimeout(() => { timer = 0; idleAction.current(); }, seconds * 1000);
      }
    };
    const enter = () => { pointerOver = true; reset(); };
    const leave = () => { pointerOver = false; reset(); };
    const down = () => { pointerHeld.current = true; reset(); };
    const up = () => { pointerHeld.current = false; reset(); };
    const focusOut = () => { queueMicrotask(reset); };
    const dragStart = () => { reordering = true; reset(); };
    const dragEnd = () => { reordering = false; up(); };
    const interactions = ["pointermove", "keydown", "wheel", "focusin", "input"];
    interactions.forEach((event) => el.addEventListener(event, reset, { passive: true }));
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", down);
    el.addEventListener("focusout", focusOut);
    el.addEventListener("dragstart", dragStart);
    window.addEventListener("dragend", dragEnd);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    document.addEventListener("visibilitychange", reset);
    reset();
    return () => {
      disposed = true;
      stop();
      interactions.forEach((event) => el.removeEventListener(event, reset));
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("focusout", focusOut);
      el.removeEventListener("dragstart", dragStart);
      window.removeEventListener("dragend", dragEnd);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.removeEventListener("visibilitychange", reset);
    };
  }, [settings?.autoCompactSeconds, idleEligible, visible, dragging, alerts.length, panel, error]);
  const previousMini = useRef(mini);
  const presenceChange = mini !== previousMini.current;

  // Entrar o salir de Mini (JW-15-04): el núcleo pone la ventana final de una vez y la
  // isla queda invisible hasta que la ventana mide eso. Así WebView2 nunca pinta la forma
  // nueva en la ventana vieja (el «recuadro») ni durante el movimiento; solo se anima la
  // opacidad y la escala.
  useLayoutEffect(() => {
    const changed = mini !== previousMini.current;
    previousMini.current = mini;
    presenceRequest.current++;
    const el = island.current;
    presenceAnimation.current?.cancel();
    if (!el) return;
    if (changed) {
      const token = ++revealToken.current;
      el.style.opacity = "0";
      const target = panel || error ? null : alerts.length ? "expanded" : mini ? "mini" : settings?.mode ?? null;
      void windowFits(target, settings?.edge === "left" || settings?.edge === "right").then(() => {
        if (token !== revealToken.current) return;
        el.style.opacity = "";
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        presenceAnimation.current = el.animate(
          [{ opacity: 0, transform: "scale(0.98)" }, { opacity: 1, transform: "scale(1)" }],
          { duration: mini ? 80 : 160, easing: "ease-out" },
        );
      });
    }
    if (changed && mini) el.querySelector<HTMLElement>(".mini-trigger")?.focus({ preventScroll: true });
    if (!mini && !settings?.minimized && keyboardRestore.current) {
      el.querySelector<HTMLElement>('[data-action="minimize"]')?.focus({ preventScroll: true });
      keyboardRestore.current = false;
    }
  }, [mini, panel, error, alerts.length, settings?.minimized]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stop = () => { if (mq.matches) presenceAnimation.current?.finish(); };
    mq.addEventListener("change", stop);
    return () => {
      mq.removeEventListener("change", stop);
      presenceRequest.current++;
      presenceAnimation.current?.cancel();
    };
  }, []);
  // Repinta solo con algo en marcha y la isla visible: 100 ms en el panel, 1 s en el indicador.
  useTick(visible && running && alerts.length === 0, panel ? 100 : 1000);

  // Sondeo del sistema solo con la isla visible: 2 s con el panel abierto, 5 s si no.
  const snap = useSystem(visible, panel === "system" ? 2000 : 5000);
  // Google (D-035): correo cada 60 s y agenda cada 300 s, solo con la isla visible.
  const mail = useCloud(cloudMail, visible, 60_000);
  const agenda = useCloud(cloudAgenda, visible, 300_000);
  // Una función por ciudad revoca respuestas de la elección anterior.
  const weatherLoad = useCallback((force: boolean) => weatherToday(force), [settings?.weatherPlace?.latitude, settings?.weatherPlace?.longitude, settings?.weatherPlace?.name, settings?.weatherPlace?.admin, settings?.weatherPlace?.country]);
  const weather = useCloud(weatherLoad, visible && !!settings?.weatherPlace, 1_830_000, false);
  const mailCount = mail?.data ? mail.data.inboxUnread + mail.data.outlookUnread : 0;
  usePulse(visible && !mini && (settings?.pulseAnimation ?? false));
  useMascotSway(mini && visible);

  const save = (patch: Partial<Settings>) => patchSettings(patch).then(() => setError(null), onError);
  const startDrag = async () => {
    setDragging(true);
    try { await barDrag(); } catch (e) { onError(e); }
    finally { pointerHeld.current = false; setDragging(false); }
  };
  // Ctrl+Alt+C (núcleo): abre o cierra el panel del portapapeles.
  const shortcut = useRef(() => {});
  useEffect(() => {
    const un = listen<string>("panel-shortcut", (e) => e.payload === "clipboard" && shortcut.current());
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Mide el panel abierto y pide al núcleo una ventana a medida (sin espacio sobrante).
  // El alto natural no depende de la ventana (ver .panel-view en CSS), así que no hay bucle.
  useEffect(() => {
    const el = panel || error ? document.querySelector<HTMLElement>(".island > .panel-view") : null;
    if (!el) return;
    let last = -1;
    const measure = () => {
      const h = Math.ceil(el.offsetHeight);
      if (h === last || h <= 0) return;
      last = h;
      setFit(h);
      setPanel(true, h + PANEL_CHROME).catch(onError);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [panel, error, alerts.length]);

  const dragProps = useReorder((id, target) => { void widgetMove(id, target).catch(onError); },
    settings?.mode === "compact" ? () => { void startDrag(); } : undefined);

  if (!settings) return <SettingsStatus error={loadError} retry={retry} bar />;
  const vertical = settings.edge === "left" || settings.edge === "right";
  const expanded = settings.mode === "expanded";
  const visibleWidgets = settings.widgetOrder.filter((id) => !settings.hiddenWidgets.includes(id));
  const minimize = async () => {
    const request = ++presenceRequest.current;
    const el = island.current;
    let exit: Animation | null = null;
    if (el && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Retomar el valor presentado permite repetir o interrumpir la pulsación.
      const current = getComputedStyle(el);
      const from = { opacity: current.opacity, transform: current.transform };
      presenceAnimation.current?.cancel();
      const animation = el.animate([from, { opacity: 0, transform: "scale(0.98)" }],
        { duration: 80, easing: "ease-out", fill: "forwards" });
      presenceAnimation.current = animation;
      exit = animation;
      // No depender del siguiente fotograma si la WebView ralentiza las animaciones.
      let deadline = 0;
      await Promise.race([
        animation.finished.catch(() => {}),
        new Promise<void>((resolve) => { deadline = window.setTimeout(resolve, 80); }),
      ]);
      window.clearTimeout(deadline);
    }
    if (request !== presenceRequest.current) return;
    try { await setMinimized(true); } catch (e) { exit?.cancel(); onError(e); }
  };
  const restore = (keyboard: boolean) => {
    keyboardRestore.current = keyboard;
    // La pastilla desaparece ya: el núcleo cambia la ventana antes de que llegue la forma
    // nueva. Si no llega ningún cambio (no debería), vuelve a verse al segundo.
    const el = island.current;
    const token = revealToken.current;
    presenceAnimation.current?.cancel();
    if (el) {
      el.style.opacity = "0";
      window.setTimeout(() => { if (token === revealToken.current) el.style.opacity = ""; }, 1000);
    }
    void setMinimized(false).catch((e) => { keyboardRestore.current = false; onError(e); });
  };
  const cloudSummary = (feed: { data: unknown; error: { kind: string } | null } | null, value: string) =>
    feed?.data ? value : ["signedOut", "expired", "config"].includes(feed?.error?.kind ?? "") ? "Conectar cuenta" : feed?.error ? "Sin datos" : "Cargando…";
  const summaries: Record<string, string> = {
    system: snap ? `CPU ${Math.round(snap.cpu)} %` : "Cargando…",
    mail: cloudSummary(mail, `${mailCount}${mail?.data?.inboxMore || mail?.data?.outlookMore ? "+" : ""} sin leer`),
    calendar: cloudSummary(agenda, `${agenda?.data?.events.length ?? 0} ${agenda?.data?.events.length === 1 ? "evento" : "eventos"}`),
    shortcuts: `${settings.shortcuts.length} accesos`,
    clipboard: settings.clipboardHistory ? "Historial" : "Desactivado",
    claude: "Asistentes",
    media: "Audio y vídeo",
    today: "Tu día",
  };
  // La ventana crece antes de cambiar la clase (el núcleo responde tras redimensionar).
  const openPanel = (kind: PanelKind) => {
    presenceRequest.current++;
    presenceAnimation.current?.cancel();
    const request = ++opening.current;
    returnFocus.current = kind;
    return setPanel(true).then(() => {
      if (request === opening.current) setPanelOpen(kind);
    }, (e) => { if (request === opening.current) onError(e); });
  };
  const closePanel = () => {
    opening.current++;
    setError(null);
    setPanelOpen(null);
    setFit(null);
    setPanel(false).catch(onError);
  };
  idleAction.current = () => {
    // Un panel abierto desde Mini también termina en compacto, nunca en la pastilla.
    void (settings.minimized ? setMinimized(false) : patchSettings({ mode: "compact" }))
      .then(closePanel, onError);
  };
  shortcut.current = () => (panel === "clipboard" ? closePanel() : openPanel("clipboard"));
  const shape = panel || error ? "panel" : alerts.length ? "expanded" : mini ? "mini" : expanded ? "expanded" : "compact";
  const badge = panel ? null : indicator(clock, sw);

  let content;
  if (error) {
    content = (
      <section className="panel-view" aria-label="Error de la acción">
        <header className="panel-head">
          <strong className="panel-title">No se pudo completar la acción</strong>
          <button className="icon-btn" data-action="close-panel" aria-label="Cerrar" title="Cerrar" onClick={closePanel}><Icon name="close" /></button>
        </header>
        <p role="alert" className="action-error">{error}</p>
        <button className="btn ghost" data-action="dismiss-error" onClick={() => {
          setError(null);
          if (!panel) closePanel();
        }}>Volver</button>
      </section>
    );
  } else if (panel === "clipboard") {
    content = <ClipboardPanel enabled={settings.clipboardHistory} onClose={closePanel} onError={onError} />;
  } else if (panel === "system") {
    content = <SystemPanel snap={snap} onClose={closePanel} />;
  } else if (panel === "media") {
    content = <MediaPanel active={visible} onClose={closePanel} onError={onError} />;
  } else if (panel === "mail") {
    content = <MailPanel feed={mail} onClose={closePanel} onError={onError} />;
  } else if (panel === "calendar") {
    content = <AgendaPanel feed={agenda} onClose={closePanel} onError={onError} />;
  } else if (panel === "claude") {
    content = <AiPanel onClose={closePanel} onError={onError} />;
  } else if (panel === "today") {
    content = <TodayPanel weather={weather} weatherPlace={settings.weatherPlace} mail={mail} agenda={agenda} workspaces={settings.workspaces} onOpen={setPanelOpen} onClose={closePanel} onError={onError} />;
  } else if (panel === "shortcuts") {
    content = <ShortcutsPanel list={settings.shortcuts} onClose={closePanel} />;
  } else if (panel) {
    content = (
      <ClockPanel
        clock={clock}
        sw={sw}
        alarms={settings.alarms}
        onClose={closePanel}
        onError={onError}
      />
    );
  } else if (alerts.length) {
    content = <AlertView alert={alerts[0]} more={alerts.length - 1} onError={onError} />;
  } else if (mini) {
    content = (
      <button
        type="button"
        className="mini-trigger"
        aria-label="Restaurar JarWis"
        title="Restaurar JarWis"
        aria-describedby={running ? "mini-running" : undefined}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          miniGesture.current = { x: e.screenX, y: e.screenY, dragged: false, active: true };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const gesture = miniGesture.current;
          if (!gesture?.active || gesture.dragged || Math.hypot(e.screenX - gesture.x, e.screenY - gesture.y) < 5) return;
          gesture.dragged = true;
          gesture.active = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
          void startDrag();
        }}
        onPointerUp={(e) => {
          if (miniGesture.current) miniGesture.current.active = false;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          if (miniGesture.current) { miniGesture.current.dragged = true; miniGesture.current.active = false; }
        }}
        onLostPointerCapture={() => { if (miniGesture.current) miniGesture.current.active = false; }}
        onClick={(e) => {
          if (e.detail !== 0 && miniGesture.current?.dragged) return;
          restore(e.detail === 0);
        }}
      >
        <img className="mascot-art" src={mascotImages[settings.mascot ?? "air"][vertical ? "v" : "h"]} alt="" aria-hidden="true" draggable={false} />
        {running && <span className="mini-running" id="mini-running" role="status" aria-label="Temporizador o cronómetro en marcha" />}
      </button>
    );
  } else {
    content = (
      <>
        {/* Asa de arrastre (compacto); en expandido, el relleno de la isla. */}
        {!expanded && <span className="grip" aria-hidden="true" />}
        <ul className="widgets" key={settings.mode} aria-label="Widgets de JarWis">
          {visibleWidgets.map((id) => (
              <li
                key={id}
                className={`widget${id === "codex-pet" ? " codex-pet" : ""}`}
                data-id={id}
                title={`${PANEL_TITLES[id] ?? WIDGET_NAMES[id] ?? id}${expanded ? "" : " · Arrastra dentro de la fila para ordenar; fuera para mover la barra"}`}
                {...dragProps(id)}
              >
                <button
                  type="button"
                  className={id === "codex-pet" ? "widget-trigger icon-btn" : "widget-trigger"}
                  title={id === "codex-pet" ? codexPetError ?? "Mostrar mascota de Codex" : undefined}
                  aria-busy={id === "codex-pet" ? codexPetBusy : undefined}
                  aria-disabled={id === "codex-pet" ? codexPetBusy : undefined}
                  aria-label={PANEL_TITLES[id] ?? WIDGET_NAMES[id] ?? id}
                  aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
                  onClick={id === "codex-pet" ? () => { void showPet(); } : PANELS.includes(id) ? () => openPanel(id as PanelKind) : undefined}
                  onKeyDown={(e) => {
                    if (!e.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
                    e.preventDefault();
                    const index = visibleWidgets.indexOf(id);
                    const direction = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
                    const target = visibleWidgets[index + direction];
                    if (target) void widgetMove(id, target).catch(onError);
                  }}
                >
                  {id === "codex-pet" ? <CodexPetArt icon={settings.codexPetIcon ?? "dog"} /> :
                    <Widget id={id} expanded={expanded} now={now} badge={badge} mailCount={mailCount} level={snap?.level ?? "ok"} summary={summaries[id]} />}
                </button>
              </li>
          ))}
        </ul>
        <div className="actions">
          <button
            type="button"
            className="icon-btn"
            data-action="minimize"
            title="Minimizar JarWis"
            aria-label="Minimizar JarWis"
            onClick={() => { void minimize(); }}
          >
            <Icon name="minimize" />
          </button>
          <button
            className="icon-btn"
            data-action="mode"
            title={expanded ? "Compactar (Ctrl+Alt+K)" : "Expandir (Ctrl+Alt+K)"}
            aria-label={expanded ? "Compactar" : "Expandir"}
            onClick={() => save({ mode: expanded ? "compact" : "expanded" })}
          >
            <Icon name={expanded ? "collapse" : "expand"} />
          </button>
          <button
            className="icon-btn"
            data-action="settings"
            title="Ajustes"
            aria-label="Ajustes"
            onClick={() => openSettings().then(() => setError(null), onError)}
          >
            <Icon name="settings" />
          </button>
        </div>
      </>
    );
  }

  return (
    <div className={`stage edge-${settings.edge}`} data-track={track ? "" : undefined} style={{
      "--presence-offset": settings.barOffsets[settings.edge],
      "--track-width": track ? `${track.width}px` : undefined,
      "--track-height": track ? `${track.height}px` : undefined,
      "--pixel": track ? `${track.pixel}px` : "1px",
    } as CSSProperties}>
      <div
        ref={island}
        className={`island ${vertical ? "v" : "h"} ${shape}${presenceChange ? " presence-change" : ""}`}
        data-error={error ? true : undefined}
        style={(panel || error) && fit ? ({ "--panel-h": `${fit + 22}px` } as CSSProperties) : undefined}
        onPointerDown={(e) => {
          // Arrastre desde zonas libres (fondo, huecos entre tarjetas): los
          // widgets gestionan su gesto en useReorder. Arranca tras 5 px, así
          // un clic normal no mueve la barra.
          const t = e.target as HTMLElement;
          if (e.button !== 0 || !(t === e.currentTarget || t.matches(".widgets, .actions, .grip"))) return;
          const { screenX: x, screenY: y } = e;
          const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
          };
          const move = (m: PointerEvent) => {
            if (Math.hypot(m.screenX - x, m.screenY - y) < 5) return;
            stop();
            void startDrag();
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", stop);
        }}
        onContextMenu={(e) => {
          // En campos de texto se deja el menú propio (copiar/pegar).
          if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
          e.preventDefault();
          barMenu().catch(onError);
        }}
      >
        {content}
      </div>
    </div>
  );
}
