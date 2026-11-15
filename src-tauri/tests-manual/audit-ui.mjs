// Regresión aislada: sirve dist/ y simula TODO el IPC. No inicia JarWis ni accede a cuentas.
// npm run build
// $env:PLAYWRIGHT_MODULE = '<ruta absoluta a playwright/index.mjs>'; node src-tauri/tests-manual/audit-ui.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const root = resolve(process.env.DIST_DIR ?? "dist");
const evidence = resolve(process.env.EVIDENCE_DIR ?? "docs/evidence/JW-12");
await mkdir(evidence, { recursive: true });
const server = createServer(async (req, res) => {
  const file = resolve(root, `.${new URL(req.url, "http://localhost").pathname === "/" ? "/index.html" : new URL(req.url, "http://localhost").pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(file);
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".png": "image/png" })[extname(file)] ?? "application/octet-stream");
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const browser = await chromium.launch({ channel: "msedge", executablePath: process.env.EDGE_EXECUTABLE, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/Bogota", locale: "es-CO" });
const checks = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); };
const errors = [];
const presenceChecks = [];
const presenceTimings = [];
const contrastNumbers = [];
const presenceCheck = (name, value) => { assert.ok(value, name); presenceChecks.push(name); console.log(`PASS Mini ${name}`); };
// Capturar al terminar la entrada; una captura a mitad del fade no valida legibilidad.
async function shot(page, name) {
  if (process.env.AUDIT_WEATHER_FIX1 === "1") {
    if (!/^6C-(Negro|Pizarra|Aurora)-(top|left)-clima\.png$/.test(name)) return;
  } else if (process.env.AUDIT_SCREENSHOTS === "0") return;
  await page.waitForTimeout(450);
  await page.locator(".island").screenshot({ path: resolve(evidence, name) });
}

async function open({ failMail = false, style = "classic", mode = "compact", edge = "top", color = "black", accent = "cyan", label = "bar", minimized = false, mascot = "air", codexPetIcon = "dog", geometry = false, reducedMotion = "no-preference", settingsMode = "ok", offset = 0.5, hiddenWidgets = [], autoCompactSeconds = 40, fakeTime = false } = {}) {
  // Playwright comparte Clock entre páginas del contexto: aislar los relojes ficticios.
  const owner = fakeTime ? await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/Bogota", locale: "es-CO" }) : context;
  const page = await owner.newPage();
  // Toda la auditoría usa recursos locales e IPC ficticio; bloquear cualquier salida web.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" && Number(url.port) === server.address().port) return route.continue();
    errors.push("Solicitud externa bloqueada durante la auditoría");
    return route.abort();
  });
  if (fakeTime) page.once("close", () => { void owner.close(); });
  if (fakeTime) {
    const time = new Date("2026-10-27T12:00:00Z");
    await page.clock.install({ time });
    await page.clock.pauseAt(time);
  }
  page.on("pageerror", (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion });
  if (geometry) {
    const vertical = edge === "left" || edge === "right";
    await page.setViewportSize(minimized ? (vertical ? { width: 60, height: 124 } : { width: 148, height: 60 }) :
      mode === "expanded" ? (vertical ? { width: 200, height: 780 } : { width: 1000, height: 112 }) :
      (vertical ? { width: 52, height: 328 } : { width: 340, height: 44 }));
    await page.exposeFunction("__jwResize", (size) => page.setViewportSize(size));
  }
  await page.addInitScript(({ failMail, style, mode, edge, color, accent, label, minimized, mascot, codexPetIcon, geometry, settingsMode, offset, hiddenWidgets, autoCompactSeconds }) => {
    const animations = [];
    const nativeAnimate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      animations.push({ at: performance.now(), duration: options?.duration ?? options, width: innerWidth, height: innerHeight, shape: this.className });
      return nativeAnimate.call(this, frames, options);
    };
    // Registrar los intervalos reales antes del montaje, sin adelantar otros relojes.
    const polls = new Map();
    const retries = new Map();
    const nativeTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    window.setTimeout = (fn, ms, ...args) => {
      const run = () => { retries.delete(id); return fn(...args); };
      const id = nativeTimeout(run, ms);
      if (ms === 5000) retries.set(id, run);
      return id;
    };
    window.clearTimeout = (id) => { retries.delete(id); nativeClearTimeout(id); };
    const intervals = new Map();
    const nativeSet = window.setInterval.bind(window);
    const nativeClear = window.clearInterval.bind(window);
    window.setInterval = (fn, ms, ...args) => {
      const id = nativeSet(fn, ms, ...args);
      intervals.set(id, { fn, ms });
      if ([2000, 5000, 60000, 300000, 1830000].includes(ms)) polls.set(id, { fn, ms });
      return id;
    };
    window.clearInterval = (id) => { polls.delete(id); intervals.delete(id); nativeClear(id); };
    const callbacks = new Map();
    const listeners = new Map();
    let sequence = 0;
    const settings = {
      edge, mode, minimized, mascot, codexPetIcon, autoCompactSeconds, barStyle: style, theme: "dark", islandColor: color, auroraAccent: accent, pulseAnimation: false,
      autostart: false, alwaysOnTop: true, monitor: null, widgetOrder: ["clock", "system", "mail", "calendar", "claude", "clipboard", "codex-pet", "media", "shortcuts", "today"],
      hiddenWidgets, alarms: [], clipboardHistory: false, shortcuts: [], workspaces: [], weatherPlace: null, notifications: false, shareToday: false,
      barOffsets: { top: offset, bottom: offset, left: offset, right: offset },
    };
    const mail = { inboxUnread: 2, inboxMore: false, outlookUnread: 0, outlookMore: false, items: [{ id: "fake-mail", source: "gmail", from: "jarwis-prueba", subject: "Datos ficticios", date: 1 }] };
    const agenda = { events: [{ id: "fake-event", title: "jarwis-prueba", start: "2026-10-27T02:30:00Z", allDay: false }], tasks: [], pendingTasks: 0, tasksPartial: false };
    const feed = (data) => ({ data, error: null, updatedAt: Date.now() });
    const state = window.__jw = {
      settings, mail, agenda, mailMode: failMail ? "error" : "ok", pending: [], agendaMode: "ok", agendaPending: [], monthMode: "ok", monthPending: [], polls, intervals, settingsMode,
      calls: [], clock: { timers: [], alerts: [] }, panel: false, resizeTrace: [], animations, retries,
      emit: (name, payload) => { for (const [id, item] of listeners) if (item.event === name) callbacks.get(item.handler)?.({ event: name, id, payload }); },
      feed,
    };
    document.addEventListener("pointerdown", (e) => { state.pointerId = e.pointerId; });
    // Copia ficticia del contrato de tamaños/orden del núcleo; no carga Tauri.
    const shape = () => state.panel ? "panel" : state.clock.alerts.length ? "expanded" : settings.minimized ? "mini" : settings.mode;
    const track = { width: 1904, height: 1016, pixel: 1 };
    const resize = async () => {
      if (!geometry) return;
      const vertical = settings.edge === "left" || settings.edge === "right";
      const current = shape();
      const size = current === "mini" ? (vertical ? { width: 60, height: 124 } : { width: 148, height: 60 }) :
        current === "panel" ? { width: vertical ? 340 : 720, height: state.panelHeight ?? (vertical ? 520 : 300) } :
        current === "expanded" ? (vertical ? { width: 200, height: 780 } : { width: 1000, height: 112 }) :
        (vertical ? { width: 52, height: 328 } : { width: 340, height: 44 });
      await window.__jwResize(size);
      state.resizeTrace.push({ shape: current, ...size, at: performance.now() });
    };
    const relayout = async (before) => {
      if (!geometry) return;
      const rank = { mini: 0, compact: 1, expanded: 2, panel: 3 };
      // JW-15-04: entrar o salir de Mini no espera al morph (como relayout del núcleo).
      if (before !== "mini" && shape() !== "mini" && rank[shape()] < rank[before]) window.setTimeout(() => { void resize(); }, 460);
      else await resize();
    };
    state.setClock = async (view) => {
      const before = shape();
      state.clock = view;
      await relayout(before);
      state.emit("clock-changed", structuredClone(view));
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => listeners.delete(id) };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label }, currentWebview: { label } },
      transformCallback: (fn) => { const id = ++sequence; callbacks.set(id, fn); return id; },
      unregisterCallback: (id) => callbacks.delete(id),
      invoke: async (cmd, args = {}) => {
        state.calls.push({ cmd, args, at: performance.now(), width: innerWidth, height: innerHeight });
        if (cmd === "plugin:event|listen") { const id = ++sequence; listeners.set(id, args); return id; }
        if (cmd === "plugin:event|unlisten") { listeners.delete(args.eventId); return null; }
        if (cmd === "get_settings") {
          if (state.settingsMode === "error") throw new Error("fallo ficticio al cargar ajustes");
          if (state.settingsMode === "defer") return new Promise((resolve) => { state.settingsResolve = () => resolve(structuredClone(settings)); });
          return structuredClone(settings);
        }
        if (cmd === "bar_track") return track;
        if (cmd === "list_monitors" || cmd === "list_store_apps") return [];
        if (cmd === "get_status") return { shortcutErrors: [] };
        if (cmd === "cloud_status") return { configured: false, connected: false, loginInProgress: false };
        if (cmd === "patch_settings") {
          const protectedFields = ["shortcuts", "workspaces", "barOffsets", "barOffsetsCenter", "bitwardenSeeded", "minimized", "alarms", "widgetOrder"];
          for (const key of Object.keys(args.patch)) if (!(key in settings) || protectedFields.includes(key)) throw new Error(`Campo no editable: ${key}`);
          if ("hiddenWidgets" in args.patch) {
            if (!Array.isArray(args.patch.hiddenWidgets) || args.patch.hiddenWidgets.some((id) => typeof id !== "string")) throw new Error("Widgets inválidos");
            const hidden = [...new Set(args.patch.hiddenWidgets.filter((id) => settings.widgetOrder.includes(id)))];
            if (hidden.length === settings.widgetOrder.length) throw new Error("Debe quedar al menos un widget visible en la barra");
            args.patch.hiddenWidgets = hidden;
          }
          const before = shape();
          Object.assign(settings, args.patch);
          await relayout(before);
          state.emit("settings-changed", structuredClone(settings));
          return structuredClone(settings);
        }
        if (["alarm_add", "alarm_set_enabled", "alarm_remove", "widget_move"].includes(cmd)) {
          if (state.failEdit) throw "No se pudo guardar el cambio ficticio";
          if (cmd === "alarm_add" && settings.alarms.length < 50) {
            const alarm = args.alarm;
            settings.alarms.push({ ...alarm, id: Math.max(0, ...settings.alarms.map((a) => a.id)) + 1,
              hour: Math.min(23, alarm.hour), minute: Math.min(59, alarm.minute),
              days: [...new Set(alarm.days.filter((d) => d < 7))].sort(), label: alarm.label.trim().replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 40) });
          }
          if (cmd === "alarm_set_enabled") {
            const alarm = settings.alarms.find((a) => a.id === args.id);
            if (alarm) alarm.enabled = args.enabled;
          }
          if (cmd === "alarm_remove") settings.alarms = settings.alarms.filter((a) => a.id !== args.id);
          if (cmd === "widget_move") {
            const from = settings.widgetOrder.indexOf(args.id);
            const to = settings.widgetOrder.indexOf(args.target);
            if (from >= 0 && to >= 0 && from !== to) {
              settings.widgetOrder.splice(from, 1);
              settings.widgetOrder.splice(to, 0, args.id);
            }
          }
          state.emit("settings-changed", structuredClone(settings));
          return structuredClone(settings);
        }
        if (cmd === "set_minimized") {
          if (state.failMinimize) throw "jarwis-prueba: no se pudo cambiar la presencia";
          if (state.deferRestore && !args.minimized) await new Promise((resolve) => { state.restoreResolve = resolve; });
          const before = shape();
          if (settings.minimized && !args.minimized) settings.mode = "compact";
          settings.minimized = args.minimized;
          // JW-15-04: WebView2 puede recibir la forma nueva antes que el tamaño nativo.
          if (state.lateResize) {
            state.emit("settings-changed", structuredClone(settings));
            // La prueba libera el resize después de comprobar la ventana vieja, sin carreras de reloj.
            await new Promise((resolve) => { state.lateResizeResolve = resolve; });
            await relayout(before);
            return structuredClone(settings);
          }
          await relayout(before);
          state.emit("settings-changed", structuredClone(settings));
          return structuredClone(settings);
        }
        if (state.inverseCommand === cmd) {
          (state.inverseCalls ??= []).push({ cmd, force: args.force });
          const original = cmd === "cloud_mail" ? mail : agenda;
          const fresh = structuredClone(original);
          if (cmd === "cloud_mail") fresh.items[0].subject = "jarwis-prueba inversa fresco";
          else fresh.events[0].title = "jarwis-prueba inversa fresco";
          if (args.force) {
            if (state.inverseDeferForce) return new Promise((resolve) => { state.inverseForceResolve = () => resolve(feed(fresh)); });
            return feed(fresh);
          }
          // Caché de 20 s: dentro del TTL, pero ya permite force (mínimo 15 s).
          // La variante fresca representa un sondeo que sí obtuvo datos nuevos.
          const result = state.inverseFreshPoll ? feed(fresh) : { ...feed(original), updatedAt: Date.now() - 20000 };
          return new Promise((resolve) => { state.inverseResolve = () => resolve(result); });
        }
        if (cmd === "cloud_mail") {
          if (state.mailMode === "error") throw new Error("fallo ficticio de IPC");
          if (state.mailMode === "busy") return { data: null, error: null, updatedAt: null };
          if (state.mailMode === "defer") return new Promise((resolve) => state.pending.push(resolve));
          return feed(mail);
        }
        if (cmd === "cloud_agenda") {
          if (state.agendaMode === "error") throw new Error("fallo ficticio de IPC");
          if (state.agendaMode === "busy") return { data: null, error: null, updatedAt: null };
          if (state.agendaMode === "defer") return new Promise((resolve) => state.agendaPending.push(resolve));
          return feed(agenda);
        }
        if (cmd === "cloud_month") {
          if (Object.keys(args).sort().join() !== "force,month,year" || typeof args.force !== "boolean") throw "cloud_month solo admite year, month y force";
          if (state.monthMode === "defer") await new Promise((resolve) => state.monthPending.push(resolve));
          if (state.monthMode === "ipc") throw new Error("fallo ficticio de IPC");
          if (state.monthMode === "signedOut") return { data: null, updatedAt: null, error: { kind: "signedOut", message: "Sesión de Google cerrada." } };
          if (state.monthMode === "network") return { data: null, updatedAt: null, error: { kind: "network", message: "Sin red (prueba)." } };
          const key = (day) => `${args.year}-${String(args.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          return feed({
            days: {
              [key(5)]: { events: [{ title: "Reunión ficticia", start: `${key(5)}T15:00:00Z`, allDay: false }], tasks: [] },
              [key(27)]: { events: [{ title: "Jornada ficticia", start: key(27), allDay: true }], tasks: [{ title: "Tarea ficticia", due: `${key(27)}T00:00:00Z` }] },
              [key(28)]: { events: [], tasks: [{ title: "Solo tarea", due: `${key(28)}T00:00:00Z` }] },
            },
            partial: !!state.monthPartial,
          });
        }
        if (cmd === "weather_today") {
          if (label !== "bar") throw "Solo barra";
          if (state.weatherMode === "busy") return { data: null, updatedAt: null, error: null };
          if (state.weatherMode === "defer") return new Promise((resolve) => { state.weatherResolve = resolve; });
          if (state.weatherMode === "network") return { data: state.weatherStale ? state.weatherData : null, updatedAt: state.weatherStale ? Date.now()-3600000 : null, error: { kind: "network", message: "Sin conexión con Open-Meteo. Se conservan los últimos datos disponibles." } };
          return feed(state.weatherData ?? { temperature: 21, maximum: 25, minimum: 14, rainProbability: 30, weatherCode: 2, dailyCode: 3, isDay: true });
        }
        if (cmd === "weather_search") {
          if (label !== "settings") throw "Solo Ajustes";
          if (state.searchFailure) throw "No se pudo buscar la ciudad (prueba ficticia)";
          return state.searchEmpty ? [] : state.searchResults ?? [{ name: "Ciudad de prueba", admin: "Región de prueba", country: "País de prueba", latitude: 40.42, longitude: -3.7 }];
        }
        if (cmd === "weather_open") {
          if (label !== "bar" || !["provider", "licence"].includes(args.target) || Object.keys(args).join() !== "target") throw "Destino no permitido";
          return null;
        }
        if (cmd === "set_workspaces") {
          settings.workspaces = args.list.map((w, i) => ({ ...w, id: w.id || i+1 }));
          state.emit("settings-changed", structuredClone(settings));
          return structuredClone(settings.workspaces);
        }
        if (cmd === "open_workspace") {
          if (state.workspaceMode === "defer") await new Promise((resolve) => { state.workspaceResolve = resolve; });
          if (state.workspaceFailure) throw state.workspaceFailure;
          return "Accesos abiertos: 2.";
        }
        if (cmd === "open_focus_settings") return null;
        if (cmd === "clock_state") return structuredClone(state.clock);
        if (cmd === "system_snapshot") return { cpu: 5, memUsed: 1, memTotal: 10, diskUsed: 1, diskTotal: 10, netRxBps: 0, netTxBps: 0, uptimeSecs: 100, battery: null, level: "ok" };
        if (cmd === "power_mode") {
          if (Object.keys(args).length) throw "power_mode no admite argumentos";
          if (state.powerModeError) throw state.powerModeError;
          return state.powerMode ?? "balanced";
        }
        if (cmd === "power_set") {
          if (Object.keys(args).join() !== "mode" || !["efficiency", "balanced", "performance"].includes(args.mode)) throw "Modo de energía no permitido";
          if (state.powerSetDeferred) await new Promise((resolve) => { state.powerSetResolve = resolve; });
          if (state.powerSetError) throw state.powerSetError;
          state.powerMode = state.powerSetResult ?? args.mode;
          return state.powerMode;
        }
        if (cmd === "power_open") {
          if (Object.keys(args).join() !== "target" || !["settings", "omen"].includes(args.target)) throw "Destino de energía no permitido";
          if (state.powerOpenError) throw state.powerOpenError;
          return null;
        }
        if (cmd === "audio_state" || cmd === "media_state") return null;
        if (cmd === "media_open") {
          if (Object.keys(args).join() !== "target" || !["telegram", "whatsapp", "spotify", "netflix", "youtube"].includes(args.target)) throw "Destino multimedia no permitido";
          if (state.mediaOpenError) throw state.mediaOpenError;
          return null;
        }
        if (cmd === "claude_open") throw "jarwis-prueba: no se pudo abrir la aplicación";
        if (cmd === "show_codex_pet") {
          if (Object.keys(args).length !== 0) throw "La mascota de Codex no admite argumentos.";
          if (state.codexPetDeferred) await new Promise((ok) => { state.codexPetResolve = ok; });
          if (state.failCodexPet) throw "Codex no está abierto. Ábrelo y vuelve a intentarlo.";
          return null;
        }
        if (cmd === "set_panel") {
          const before = shape();
          state.lastPanel = args;
          state.panel = args.open;
          state.panelHeight = args.height;
          await relayout(before);
          return null;
        }
        if (cmd === "clipboard_list") return { items: [], paused: false };
        if (cmd === "alert_dismiss") { await state.setClock({ ...state.clock, alerts: [] }); return structuredClone(state.clock); }
        if (cmd === "bar_drag") {
          state.dragCaptured = document.querySelector(".mini-trigger")?.hasPointerCapture(state.pointerId) ?? false;
          if (state.deferDrag) await new Promise((resolve) => { state.dragResolve = resolve; });
          return null;
        }
        if (cmd === "bar_menu") return null;
        // Ninguna orden puede llegar a un backend real; las desconocidas fallan aquí.
        throw new Error(`IPC ficticio no implementado: ${cmd}`);
      },
    };
  }, { failMail, style, mode, edge, color, accent, label, minimized, mascot, codexPetIcon, geometry, settingsMode, offset, hiddenWidgets, autoCompactSeconds });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator(settingsMode !== "ok" ? ".recovery-card" : label === "bar" ? minimized ? ".mini-trigger" : ".widget-trigger" : ".settings").last().waitFor();
  if (label === "settings" && settingsMode === "ok") await page.getByRole("tab", { name: "Apariencia", exact: true }).click();
  return page;
}

// Registrar todas las regresiones aunque fallen, para demostrar ambos feeds antes del arreglo.
const regressions = [];
const inverseRegressions = [];
const reliabilityChecks = [];
const expect = (name, actual, expected, results = regressions) => {
  let passed = true;
  try { assert.deepEqual(actual, expected); } catch { passed = false; }
  results.push({ name, actual, expected, passed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(actual)} (esperado ${JSON.stringify(expected)})`);
};
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

// WCAG: luminancia sRGB y composición de superficies translúcidas antes de medir.
async function contrast(page, selector, name) {
  await page.waitForTimeout(250);
  const samples = await page.locator(selector).evaluateAll((elements) => {
    const rgb = (value) => {
      if (value.startsWith("#")) return [...value.slice(1).matchAll(/../g)].map((m) => parseInt(m[0], 16)).concat(1);
      const channels = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
      return [channels[0], channels[1], channels[2], channels[3] ?? 1];
    };
    const blend = (front, back) => front.slice(0, 3).map((c, i) => c * front[3] + back[i] * (1 - front[3]));
    const luminance = (color) => color.map((c) => c / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    return elements.filter((el) => el.getClientRects().length && el.textContent.trim()).map((el) => {
      const ancestors = [];
      for (let parent = el; parent; parent = parent.parentElement) ancestors.unshift(parent);
      let background = [255, 255, 255];
      for (const parent of ancestors) {
        const css = getComputedStyle(parent);
        const surface = parent.matches(".island, .appearance-sample") ? css.getPropertyValue("--island").trim() : css.backgroundColor;
        background = blend(rgb(surface), background);
      }
      const foreground = blend(rgb(getComputedStyle(el).color), background);
      const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
      return { text: el.textContent.trim().slice(0, 70), foreground, background, ratio: (values[1] + 0.05) / (values[0] + 0.05) };
    });
  });
  contrastNumbers.push({ name, samples });
  if (samples.some((s) => s.ratio < 4.5)) console.log("Contraste insuficiente:", JSON.stringify(samples.filter((s) => s.ratio < 4.5)));
  check(`${name}: contraste secundario ≥4,5:1 (mín. ${Math.min(...samples.map((s) => s.ratio)).toFixed(2)})`, samples.length > 0 && samples.every((s) => s.ratio >= 4.5));
}

// Capturas comparables sobre dist/ o una compilación aislada de HEAD.
if (process.env.PALETTE_EVIDENCE_ONLY) {
  for (const mode of ["compact", "expanded", "ai", "mini"]) {
    const page = await open({ color: "royal", mode: mode === "expanded" ? "expanded" : "compact", minimized: mode === "mini", geometry: true });
    if (mode === "ai") await page.locator('.widget[data-id="claude"] button').click();
    await shot(page, `${process.env.PALETTE_EVIDENCE_ONLY}-${mode}.png`);
    await page.close();
  }
  await browser.close();
  server.close();
  process.exit(0);
}

// JW-30: misma escena ficticia antes/después, sin ejecutar el núcleo ni lanzadores reales.
async function todayScene(options) {
  const page = await open({ ...options, geometry: true, autoCompactSeconds: 0 });
  if (!options?.liveTime) await page.clock.setFixedTime(new Date("2026-10-27T15:00:00Z"));
  await page.evaluate(() => {
    const s = window.__jw;
    s.agenda.events = [
      { id: "past", title: "Revisión terminada", start: "2026-10-27T13:00:00Z", allDay: false },
      { id: "next", title: "Revisión del proyecto", start: "2026-10-27T16:00:00Z", allDay: false },
      { id: "day", title: "Jornada de diseño", start: "2026-10-27", allDay: true },
    ];
    s.agenda.tasks = [
      { id: "late", title: "Enviar propuesta", due: "2026-10-26T00:00:00Z" },
      { id: "today", title: "Preparar revisión", due: "2026-10-27T00:00:00Z" },
      { id: "future", title: "Planificar entrega", due: "2026-10-28T00:00:00Z" },
      { id: "undated", title: "Revisar ideas", due: null },
    ];
    s.agenda.pendingTasks = 4;
    s.settings.workspaces = [{ id: 1, name: "Diseño", shortcuts: [] }, { id: 2, name: "Desarrollo", shortcuts: [] }];
    s.emit("settings-changed", structuredClone(s.settings));
  });
  await page.locator('.widget[data-id="calendar"] button').click();
  await page.getByRole("button", { name: "Ver agenda", exact: true }).click();
  await page.getByRole("button", { name: "Actualizar", exact: true }).click();
  await page.locator('[data-event="next"]').waitFor();
  await page.keyboard.press("Escape");
  await page.locator('.widget[data-id="today"] button').click();
  await page.mouse.move(1, 1);
  return page;
}

if (process.env.TODAY_EVIDENCE_ONLY) {
  try {
    for (const [name, style, color] of [["Negro", "classic", "black"], ["Pizarra", "classic", "royal"], ["Aurora", "aurora", "black"]]) {
      for (const edge of ["top", "left"]) {
        const page = await todayScene({ style, color, edge });
        await shot(page, `today-${process.env.TODAY_EVIDENCE_ONLY}-${name}-${edge}.png`);
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
    await new Promise((ok) => server.close(ok));
  }
  process.exit(0);
}

async function checkPetReorder() {
  // JW-34-6F: ratón real contra IPC ficticio; primera, intermedia y última posición.
  for (const mode of ["compact", "expanded"]) {
    for (const edge of ["top", "left", "bottom", "right"]) {
      const view = await open({ mode, edge, geometry: true });
      const petItem = view.locator('.widget[data-id="codex-pet"]');
      const pet = petItem.locator("button");
      await pet.waitFor();
      await settle(view);
      for (const target of ["clock", "today", "claude"]) {
        const before = await view.evaluate(() => [...window.__jw.settings.widgetOrder]);
        const from = await pet.boundingBox();
        const to = await view.locator(`.widget[data-id="${target}"]`).boundingBox();
        const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
        const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
        if (mode === "expanded") await pet.dragTo(view.locator(`.widget[data-id="${target}"] button`));
        else {
          await view.mouse.move(start.x, start.y);
          await view.mouse.down();
          await view.mouse.move(end.x, end.y, { steps: 12 });
          await view.mouse.up();
        }
        await settle(view);
        const expected = [...before];
        expected.splice(before.indexOf("codex-pet"), 1);
        expected.splice(before.indexOf(target), 0, "codex-pet");
        check(`6F ${mode}/${edge}: ratón mueve mascota a ${target} sin activarla`, await view.evaluate((expected) =>
          JSON.stringify(window.__jw.settings.widgetOrder) === JSON.stringify(expected) &&
          [...document.querySelectorAll(".widget[data-id]")].map((li) => li.dataset.id).join() === expected.join() &&
          !window.__jw.calls.some((c) => c.cmd === "show_codex_pet" || c.cmd === "bar_drag"), expected));
        if (edge === "top") await shot(view, `6F-${mode}-${target}.png`);
      }
      await pet.focus();
      for (let i = 0; i < 10; i++) { await view.keyboard.press("Alt+ArrowLeft"); await settle(view); }
      check(`6F ${mode}/${edge}: teclado llega al principio y conserva foco`, await pet.evaluate((button) =>
        document.activeElement === button && window.__jw.settings.widgetOrder[0] === "codex-pet"));
      for (let i = 1; i < 10; i++) {
        await view.keyboard.press(edge === "left" || edge === "right" ? "Alt+ArrowDown" : "Alt+ArrowRight");
        await settle(view);
        check(`6F ${mode}/${edge}: teclado alcanza posición ${i + 1}`, await view.evaluate((i) => window.__jw.settings.widgetOrder[i] === "codex-pet", i));
      }
      const withoutClipboard = await view.evaluate(() => window.__jw.settings.widgetOrder.filter((id) => id !== "clipboard"));
      await view.locator('.widget[data-id="clipboard"] button').focus();
      await view.keyboard.press("Alt+ArrowLeft");
      await settle(view);
      check(`6F ${mode}/${edge}: Portapapeles conserva el orden del resto`, await view.evaluate((before) =>
        window.__jw.settings.widgetOrder.filter((id) => id !== "clipboard").join() === before.join(), withoutClipboard));
      if (mode === "compact") {
        const before = await view.evaluate(() => [...window.__jw.settings.widgetOrder]);
        const from = await pet.boundingBox();
        const island = await view.locator(".island").boundingBox();
        await view.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await view.mouse.down();
        await view.mouse.move(island.x + island.width + 10, island.y + island.height + 10, { steps: 12 });
        await view.mouse.up();
        await settle(view);
        check(`6F ${mode}/${edge}: salir desde mascota entrega a bar_drag sin clic ni orden`, await view.evaluate((before) =>
          window.__jw.calls.filter((c) => c.cmd === "bar_drag").length === 1 &&
          !window.__jw.calls.some((c) => c.cmd === "show_codex_pet") && window.__jw.settings.widgetOrder.join() === before.join(), before));
        await pet.click();
        await settle(view);
        check(`6F ${mode}/${edge}: siguiente clic muestra sin estado visible`, await pet.getAttribute("aria-pressed") === null && await view.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "show_codex_pet").length === 1));
      }
      await view.evaluate(async () => { await window.__TAURI_INTERNALS__.invoke("patch_settings", { patch: { hiddenWidgets: ["codex-pet"] } }); });
      check(`6F ${mode}/${edge}: oculta solo mascota`, await pet.count() === 0 && await view.locator('.widget[data-id="clipboard"]').isVisible());
      if (edge === "top") await shot(view, `6F-${mode}-hidden.png`);
      await view.close();
    }
  }
  const petSettings = await open({ label: "settings" });
  const petSwitch = petSettings.getByRole("switch", { name: "Mostrar en la barra: Mascota de Codex", exact: true });
  await petSwitch.uncheck();
  check("6F Ajustes: mascota en lista y ocultación por parche mínimo", await petSettings.evaluate(() =>
    window.__jw.settings.hiddenWidgets.join() === "codex-pet" &&
    JSON.stringify(window.__jw.calls.filter((c) => c.cmd === "patch_settings").at(-1).args.patch) === JSON.stringify({ hiddenWidgets: ["codex-pet"] })));
  await petSwitch.check();
  const petRow = petSettings.locator('.widget-list li[data-id="codex-pet"]');
  await petRow.focus();
  await petSettings.keyboard.press("Alt+ArrowUp");
  await settle(petSettings);
  check("6F Ajustes: mascota se muestra y reordena por teclado", await petSettings.evaluate(() =>
    !window.__jw.settings.hiddenWidgets.length && window.__jw.settings.widgetOrder[5] === "codex-pet"));
  await petSettings.close();

}

// JW-34-6H: contrato de orden, datos vacíos y presencia independiente, siempre IPC ficticio.
async function checkTodayHierarchy() {
  for (const [name, style, color] of [["Negro", "classic", "black"], ["Pizarra", "classic", "royal"], ["Aurora", "aurora", "black"]]) {
    for (const edge of ["top", "left"]) {
      const p = await todayScene({ style, color, edge, reducedMotion: "reduce" });
      const tag = `6H ${name}/${edge}`;
      await p.evaluate(() => {
        const s = window.__jw;
        s.settings.weatherPlace = { name: "Ciudad ficticia", latitude: 4, longitude: -74, country: "Prueba" };
        s.emit("settings-changed", structuredClone(s.settings));
      });
      await p.locator(".weather-current").waitFor();
      check(`${tag}: orden clima, evento, tareas, correos, concentración y espacios`, await p.locator(".today-body").evaluate(el => {
        const nodes = [el.querySelector("[data-weather]"), el.querySelector('[data-today-block="event"]'), el.querySelector('[data-today-block="tasks"]'), el.querySelector('[data-today-block="mail"]'), el.querySelector(".focus-card"), el.querySelector(".today-workspaces")];
        return nodes.every((n, i) => n && (!i || nodes[i-1].compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING));
      }));
      check(`${tag}: clima visible al abrir`, await p.locator("[data-weather]").evaluate(el => {
        const r=el.getBoundingClientRect(), b=el.closest(".today-body").getBoundingClientRect();
        return r.top >= b.top && r.bottom <= b.bottom+1;
      }));
      check(`${tag}: encabezados en orden`, JSON.stringify(await p.getByRole("heading").evaluateAll(els => els.map(el => Number(el.getAttribute("aria-level"))))) === "[1,2,2,2,2]");
      const accessible = await p.locator(".today-panel").ariaSnapshot();
      await writeFile(resolve(evidence, `6H-${name}-${edge}-accessibility.txt`), accessible);
      check(`${tag}: árbol accesible expone los cinco encabezados`, ["Hoy", "Clima", "Próximo evento", "Tareas", "Correos"].every(name => accessible.includes(`heading "${name}" [level=${name === "Hoy" ? 1 : 2}]`)));
      check(`${tag}: encabezados fuera de botones`, await p.getByRole("heading").evaluateAll(els => els.every(el => !el.closest("button"))));
      await p.keyboard.press("Tab");
      for (const name of [/^Próximo evento Revisión del proyecto$/, /^Tareas 4 tareas$/, /^Correos 2$/]) {
        const action = p.getByRole("button", { name });
        await action.focus();
        check(`${tag}: acción ${name.source} accesible y con foco visible`, await action.evaluate(el => el === document.activeElement && el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none"));
      }
      await p.locator(".today-body").evaluate(el => { el.scrollTop = 0; });
      // Capturar la ventana real simulada con el clima al principio del resumen.
      async function evidenceShot(state) {
        if (process.env.AUDIT_HIERARCHY_FIX1 === "1") {
          if (state !== "vacio") return;
          await p.locator(".today-body").evaluate(el => { el.scrollTop = el.scrollHeight; });
          await p.locator(".island").screenshot({ path: resolve(evidence, `6H-fix1-${name}-${edge}-vacio.png`) });
          return;
        }
        if (process.env.AUDIT_HIERARCHY_SHOTS !== "1") return;
        await p.locator(".today-body").evaluate(el => { el.scrollTop = 0; });
        if (edge === "left" && state === "completo") await p.locator('[data-today="next"]').evaluate(el => el.scrollIntoView({block:"start"}));
        await p.waitForTimeout(100);
        await p.locator(".island").screenshot({ path: resolve(evidence, `6H-${name}-${edge}-${state}.png`) });
      }
      await evidenceShot("completo");
      const setData = async (kind) => {
        await p.evaluate(kind => {
          const s=window.__jw;
          s.agenda.events = kind === "event" ? [{id:"only",title:"Evento ficticio",start:"2026-10-27T16:00:00Z",allDay:false}] : [];
          s.agenda.tasks = kind === "tasks" ? [{id:"only",title:"Tarea ficticia",due:null}] : [];
          s.agenda.pendingTasks = kind === "tasks" ? 1 : 0;
          s.agenda.tasksPartial = false;
          s.mail.inboxUnread = kind === "mail" ? 1 : 0;
          s.mail.outlookUnread = 0;
          s.emit("cloud-changed");
        }, kind);
        await p.waitForTimeout(120);
      };
      await setData("empty");
      check(`${tag}: vacíos ocultan todos los bloques y contadores`, await p.locator("[data-today-block]").count() === 0);
      check(`${tag}: ningún contador cero visible`, !/\b0\b/.test(await p.locator(".today-body").innerText().then(t => t.replace(/CC BY 4\.0/g,""))));
      check(`${tag}: espacios vacíos conservan tarjetas y acciones sin contador`, await p.evaluate(() => window.__jw.settings.workspaces.every(w => w.shortcuts.length === 0)) && await p.locator(".workspace-card").count() === 2 && await p.getByRole("button", {name: "Abrir Diseño", exact:true}).count() === 1 && await p.getByRole("button", {name: "Abrir Desarrollo", exact:true}).count() === 1 && await p.locator(".workspace-copy > .muted").count() === 0);
      check(`${tag}: ningún cero en ningún contador, incluidos espacios`, await p.locator(".stat-value, [data-today=events], .workspace-copy > .muted").evaluateAll(els => els.every(el => !/\b0\b/.test(el.textContent))));
      await p.evaluate(() => { const s=window.__jw; s.settings.weatherPlace=null; s.emit("settings-changed",structuredClone(s.settings)); });
      await p.getByText("Elige tu ciudad en Ajustes").waitFor();
      await evidenceShot("vacio");
      for (const kind of ["event", "tasks", "mail"]) {
        await setData(kind);
        if (edge === "left" && kind === "tasks") await evidenceShot("parcial");
        check(`${tag}: bloque ${kind} aparece solo con datos`, await p.locator(`[data-today-block="${kind}"]`).count() === 1 && await p.locator("[data-today-block]").count() === 1);
        check(`${tag}: ${kind} sin detalles cero`, !/\b0\b/.test(await p.locator("[data-today-block]").innerText()));
        if (kind === "event") {
          await p.evaluate(() => { const s=window.__jw; s.agenda.events[0].title="   "; s.emit("cloud-changed"); });
          await p.getByText("Evento sin título", {exact:true}).waitFor();
          check(`${tag}: evento sin título conserva alternativa y acción accesible`, await p.getByRole("button", {name:"Próximo evento Evento sin título",exact:true}).count() === 1);
        }
      }
      await setData("empty");
      await p.evaluate(() => { const s=window.__jw; s.agendaMode="busy"; s.mailMode="busy"; s.emit("cloud-changed"); });
      await p.getByText("Tareas: cargando…", {exact:true}).waitFor();
      check(`${tag}: carga sigue visible en cada bloque`, await p.locator('[data-today-block] [role="status"]').count() === 3);
      await p.evaluate(() => { const s=window.__jw; s.agendaMode="error"; s.mailMode="error"; s.emit("cloud-changed"); });
      await p.waitForTimeout(120);
      check(`${tag}: errores siguen visibles`, await p.locator('[data-today-block] [role="status"]').count() === 3 && (await p.locator('[data-today-block="mail"]').innerText()).includes("No se pudo actualizar"));
      check(`${tag}: sin desbordes exteriores y desplazamiento interior`, await p.locator(".today-panel").evaluate(el => {
        const b=el.querySelector(".today-body"), r=el.getBoundingClientRect();
        return el.scrollWidth<=el.clientWidth+1 && el.scrollHeight<=el.clientHeight+1 && b.scrollWidth<=b.clientWidth+1 && r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1;
      }));
      await p.close();
    }
  }
}

async function checkTodayWeather() {
  const city = { name: "Ciudad de prueba", admin: "Región", country: "País", latitude: 40.42, longitude: -3.7 };
  const count = (p) => p.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "weather_today").length);
  const poll = (p) => p.evaluate(async () => { for (const v of window.__jw.polls.values()) if (v.ms === 1830000) await v.fn(); });
  for (const [name, style, color] of [["Negro", "classic", "black"], ["Pizarra", "classic", "royal"], ["Aurora", "aurora", "black"]]) {
    for (const edge of ["top", "left"]) {
      const p = await todayScene({ style, color, edge, reducedMotion: "reduce", liveTime: true });
      const tag = `6C ${name}/${edge}`;
      check(`${tag}: sin ciudad no hay peticiones`, await count(p) === 0 && await p.locator("[data-weather]").innerText().then((t) => t.includes("Elige tu ciudad en Ajustes")));
      if (name === "Negro") {
        await p.locator("[data-weather]").evaluate((el)=>el.scrollIntoView({block:"start"}));
        await shot(p,`6C-${name}-${edge}-sin-ciudad.png`);
      }
      await p.evaluate((city) => {
        const s = window.__jw;
        s.settings.weatherPlace = city;
        s.settings.workspaces = [{id:1,name:"Diseño",shortcuts:[1,2],color:"purple",icon:"photo"},{id:2,name:"Desarrollo",shortcuts:[3],color:"teal",icon:"code"}];
        s.emit("settings-changed", structuredClone(s.settings));
      }, city);
      await p.locator(".weather-current").waitFor();
      check(`${tag}: clima completo en español`, await p.locator("[data-weather]").innerText().then((t) => ["21°","25°","14°","30 %","Parcialmente nublado","Ciudad de prueba","actualizado hace"].every((v) => t.includes(v))));
      check(`${tag}: atribución visible`, await p.locator(".weather-attribution").isVisible() && await p.locator(".weather-attribution").innerText().then(t => t.includes("Datos meteorológicos de Open-Meteo.com") && t.includes("CC BY 4.0")));
      for (const [label, target] of [["Open-Meteo.com", "provider"], ["CC BY 4.0", "licence"]]) {
        await p.getByRole("button", { name: label, exact: true }).click();
        check(`${tag}: enlace fijo ${target}`, await p.evaluate(target => JSON.stringify(window.__jw.calls.filter(c => c.cmd === "weather_open").at(-1).args) === JSON.stringify({target}), target));
      }
      const beforeCloud = await count(p);
      await p.evaluate(() => window.__jw.emit("cloud-changed", null));
      await p.waitForTimeout(50);
      check(`${tag}: Google no invalida ni consulta clima`, await count(p) === beforeCloud && await p.locator(".weather-current").count() === 1);
      await p.evaluate(() => { window.__jw.weatherData = {temperature:21,maximum:null,minimum:null,rainProbability:null,weatherCode:2,dailyCode:null,isDay:true}; });
      await poll(p);
      check(`${tag}: diarios null conservan clima actual`, await p.locator("[data-weather]").innerText().then(t => t.includes("21°") && t.includes("Máx. — · Mín. — · Lluvia —") && !t.includes("NaN")));
      await p.evaluate(() => { window.__jw.weatherData = undefined; });
      await poll(p);
      check(`${tag}: icono y color guardados`, await p.locator('.workspace-card[data-color="purple"][data-icon="photo"]').count() === 1 && await p.locator('.workspace-card[data-color="teal"][data-icon="code"]').count() === 1);
      check(`${tag}: intervalo de treinta minutos y margen`, await p.evaluate(() => [...window.__jw.polls.values()].filter((v) => v.ms === 1830000).length) === 1);
      await p.locator(".today-body").evaluate((el) => { el.scrollTop = 0; });
      await shot(p, `6C-${name}-${edge}-resumen.png`);
      await p.locator("[data-weather]").evaluate((el) => el.scrollIntoView({block:"start"}));
      await p.locator(".weather-attribution").scrollIntoViewIfNeeded();
      check(`${tag}: atribución dentro del área visible al desplazar`, await p.locator(".weather-attribution").evaluate(el => {
        const r=el.getBoundingClientRect(), body=el.closest(".today-body").getBoundingClientRect();
        const ok = r.top >= body.top-1 && r.bottom <= body.bottom+1 && r.left >= body.left-1 && r.right <= body.right+1;
        if (!ok) console.log("Geometría de atribución:", JSON.stringify({attribution:r.toJSON(),body:body.toJSON()}));
        return ok;
      }));
      await shot(p, `6C-${name}-${edge}-clima.png`);
      await p.locator(".today-body").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await shot(p, `6C-${name}-${edge}-tarjetas.png`);
      await p.evaluate(() => { window.__jw.workspaceMode = "defer"; });
      const action = p.locator('[data-workspace="1"]');
      await action.click();
      check(`${tag}: Abriendo accesible`, await action.innerText() === "Abriendo…" && await action.isDisabled() && await action.getAttribute("aria-busy") === "true");
      await action.evaluate((el) => { el.click(); el.click(); });
      check(`${tag}: apertura deduplicada`, await p.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "open_workspace").length) === 1);
      if (name === "Negro") await shot(p, `6C-${name}-${edge}-abriendo.png`);
      await p.evaluate(() => window.__jw.workspaceResolve());
      await action.getByText("Abrir", { exact: true }).waitFor();
      await p.locator('[data-action="focus"]').click();
      check(`${tag}: concentración solo abre ajustes`, await p.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "open_focus_settings").length) === 1);
      check(`${tag}: sin desbordamiento`, await p.locator(".today-panel").evaluate((el) => {
        const body = el.querySelector(".today-body"); const r=el.getBoundingClientRect();
        return el.scrollWidth <= el.clientWidth+1 && body.scrollWidth <= body.clientWidth+1 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth+1 && r.bottom <= innerHeight+1;
      }));
      await p.keyboard.press("Tab");
      await p.locator('[data-action="focus"]').focus();
      check(`${tag}: foco visible`, await p.locator('[data-action="focus"]').evaluate((el) => getComputedStyle(el).outlineStyle !== "none"));
      await p.evaluate(() => window.__jw.emit("bar-visibility", false));
      await p.waitForTimeout(50); const hidden = await count(p); await poll(p);
      check(`${tag}: isla oculta suspende clima`, await count(p) === hidden && await p.evaluate(() => ![...window.__jw.polls.values()].some((v) => v.ms === 1830000)));
      await p.evaluate(() => window.__jw.emit("bar-visibility", true));
      await p.waitForTimeout(50); const before=await count(p); await poll(p);
      check(`${tag}: isla visible reanuda clima`, await count(p) > before);
      await p.evaluate(() => { window.__jw.weatherMode="network"; }); await poll(p);
      await p.locator('[data-weather] [data-kind="network"]').waitFor();
      check(`${tag}: error de red comprensible`, await p.locator("[data-weather]").innerText().then((t) => t.includes("Sin conexión con Open-Meteo") && t.includes("Sin datos actualizados")));
      if (name === "Negro") {
        await p.locator("[data-weather]").evaluate((el) => el.scrollIntoView({block:"start"}));
        await shot(p, `6C-${name}-${edge}-sin-red.png`);
      }
      await p.evaluate(() => { const s=window.__jw; s.weatherStale=true; s.weatherData={temperature:21,maximum:25,minimum:14,rainProbability:30,weatherCode:2,dailyCode:3,isDay:true}; });
      await poll(p); await p.locator(".weather-current").waitFor();
      check(`${tag}: error conserva datos y antigüedad`, await p.locator("[data-weather]").innerText().then((t)=>t.includes("21°") && t.includes("actualizado hace 1 h") && t.includes("Sin conexión")));
      await contrast(p, ".today-tile .muted, .workspace-card .btn, .today-tile-heading strong, .weather-current", `${tag}/tarjetas`);
      // Una respuesta de la ciudad anterior no debe aparecer bajo la ciudad nueva.
      await p.evaluate((city) => { const s=window.__jw; s.weatherMode="defer"; s.settings.weatherPlace={...city,name:"Otra ciudad",latitude:12}; s.emit("settings-changed",structuredClone(s.settings)); },city);
      await p.getByText("Cargando clima…",{exact:true}).waitFor();
      check(`${tag}: cambio de ciudad revoca datos`, await p.locator(".weather-current").count()===0);
      await p.waitForFunction(()=>!!window.__jw.weatherResolve);
      await p.evaluate(() => { const s=window.__jw; s.settings.weatherPlace=null; s.emit("settings-changed",structuredClone(s.settings)); });
      await p.getByText("Elige tu ciudad en Ajustes",{exact:true}).waitFor();
      await p.evaluate(() => window.__jw.weatherResolve(window.__jw.feed({temperature:30,maximum:32,minimum:22,rainProbability:0,weatherCode:0,dailyCode:0,isDay:true})));
      await p.waitForTimeout(30);
      check(`${tag}: quitar descarta respuesta pendiente`, await p.locator(".weather-current").count()===0);
      await p.evaluate(() => { const s=window.__jw; s.settings.weatherPlace=null; s.emit("settings-changed",structuredClone(s.settings)); });
      await p.getByText("Elige tu ciudad en Ajustes", { exact: true }).waitFor(); const removed=await count(p); await poll(p);
      check(`${tag}: quitar ciudad detiene sondeo`, await count(p) === removed && await p.locator(".weather-current").count() === 0);
      if (name==="Negro" && edge==="top") {
        const retry = async () => {
          await p.waitForFunction(() => window.__jw.retries.size === 1);
          await p.evaluate(() => {
            const [id, run] = [...window.__jw.retries][0];
            window.clearTimeout(id);
            run();
          });
          await p.waitForTimeout(30);
        };
        await p.evaluate(city => { const s=window.__jw; s.weatherMode="busy"; s.settings.weatherPlace=city; s.emit("settings-changed",structuredClone(s.settings)); }, city);
        await p.getByText("Cargando clima…", {exact:true}).waitFor();
        const pendingCount = await count(p);
        for (let i=0;i<4;i++) await retry();
        check("6C consulta en curso: cuatro reintentos y estado final visible", await count(p) === pendingCount+4 && await p.locator("[data-weather]").innerText().then(t => t.includes("La consulta sigue en curso") && !t.includes("Cargando clima…")) && await p.evaluate(() => window.__jw.retries.size === 0));
        await p.evaluate(() => { window.__jw.weatherMode="ok"; }); await poll(p);
        await p.locator(".weather-current").waitFor();
        check("6C consulta en curso: próxima actualización recupera datos", await p.locator(".weather-current").innerText().then(t => t.includes("21°")));
        await p.evaluate(city => { const s=window.__jw; s.weatherMode="busy"; s.settings.weatherPlace={...city,name:"Ciudad pendiente"}; s.emit("settings-changed",structuredClone(s.settings)); },city);
        await p.getByText("Cargando clima…", {exact:true}).waitFor();
        await retry();
        await p.evaluate(() => { window.__jw.weatherMode="ok"; });
        await retry(); await p.locator(".weather-current").waitFor();
        check("6C consulta en curso: reintento recoge el resultado y cancela temporizador", await p.evaluate(() => window.__jw.retries.size === 0));
        await p.evaluate(city => { const s=window.__jw; s.weatherMode="busy"; s.settings.weatherPlace=city; s.emit("settings-changed",structuredClone(s.settings)); },city);
        await p.getByText("Cargando clima…", {exact:true}).waitFor();
        await p.evaluate(() => window.__jw.emit("bar-visibility", false)); await p.waitForTimeout(30);
        check("6C consulta en curso: ocultar cancela reintentos", await p.evaluate(() => window.__jw.retries.size === 0));
        await p.evaluate(() => { window.__jw.weatherMode="ok"; window.__jw.emit("bar-visibility", true); });
        await p.locator(".weather-current").waitFor();
        await p.evaluate((city)=>{ const s=window.__jw; s.weatherMode="ok"; s.settings.weatherPlace=city; s.emit("settings-changed",structuredClone(s.settings)); },city);
        for (const [code,isDay,text] of [[0,true,"Despejado"],[0,false,"Noche despejada"],[45,true,"Niebla"],[61,true,"Lluvia"],[71,true,"Nieve"],[95,true,"Tormenta"]]) {
          await p.evaluate(({code,isDay})=>{ window.__jw.weatherData={temperature:21,maximum:25,minimum:14,rainProbability:30,weatherCode:code,dailyCode:code,isDay}; },{code,isDay});
          await poll(p);
          await p.locator(".weather-current").getByText(text,{exact:true}).waitFor();
          check(`6C WMO ${code}/${isDay}: descripción española`, await p.locator(".weather-current").innerText().then(t=>t.includes(text)));
        }
      }
      await p.close();
    }
    const settings = await open({ label:"settings",style,color,reducedMotion:"reduce" });
    await settings.getByRole("tab", {name:"Productividad",exact:true}).click();
    await settings.evaluate(() => { const s=window.__jw; s.settings.shortcuts=[{id:1,name:"Acceso de prueba",kind:"url",target:"https://example.com"}]; s.emit("settings-changed",structuredClone(s.settings)); });
    await settings.locator('[data-action="ws-add"]').click();
    const row=settings.locator('[data-ws="0"]');
    await row.getByLabel("Nombre del espacio",{exact:true}).fill("Espacio de prueba");
    await row.getByRole("button",{name:"Color turquesa",exact:true}).click();
    await row.getByRole("button",{name:"Icono código",exact:true}).click();
    await row.locator('[data-ws-item="1"]').check();
    await settings.locator('[data-action="ws-save"]').click();
    check(`6C ${name}: apariencia de espacio se guarda`, await settings.evaluate(() => window.__jw.settings.workspaces[0].color === "teal" && window.__jw.settings.workspaces[0].icon === "code"));
    const editor=settings.locator(".weather-editor");
    check(`6C ${name}: aviso de coordenadas e IP`, await editor.innerText().then(t => t.includes("Se envían a Open-Meteo solo las coordenadas de la ciudad elegida (Open-Meteo ve la dirección IP de la conexión); sin cuenta ni clave")));
    const query=settings.getByRole("textbox",{name:"Buscar ciudad",exact:true});
    await query.fill("Ciudad");
    check(`6C ${name}: escribir no busca automáticamente`, await settings.evaluate(() => window.__jw.calls.filter((c)=>c.cmd==="weather_search").length) === 0);
    await editor.getByRole("button",{name:"Buscar",exact:true}).click();
    await editor.getByRole("button",{name:/Elegir Ciudad/}).click();
    await editor.getByRole("button",{name:"Quitar ciudad",exact:true}).waitFor();
    check(`6C ${name}: ciudad seleccionada por parche`, await settings.evaluate(() => window.__jw.calls.filter((c)=>c.cmd==="patch_settings").at(-1).args.patch.weatherPlace.name === "Ciudad de prueba"));
    await editor.scrollIntoViewIfNeeded();
    if (process.env.AUDIT_SCREENSHOTS !== "0") await settings.screenshot({path:resolve(evidence,`6C-${name}-ajustes.png`)});
    await editor.getByRole("button",{name:"Quitar ciudad",exact:true}).click();
    await editor.getByText("Sin ciudad elegida",{exact:true}).waitFor();
    check(`6C ${name}: quitar guarda null`, await settings.evaluate(() => window.__jw.settings.weatherPlace === null));
    await settings.evaluate(() => { window.__jw.searchFailure=true; });
    await editor.getByRole("button",{name:"Buscar",exact:true}).click();
    await editor.getByRole("alert").waitFor();
    check(`6C ${name}: error de búsqueda visible`, await editor.getByRole("alert").innerText().then((t)=>t.includes("No se pudo buscar")));
    await settings.evaluate(() => { window.__jw.searchFailure=false;window.__jw.searchEmpty=true; });
    await editor.getByRole("button",{name:"Buscar",exact:true}).click();
    await editor.getByText("No se encontraron ciudades. Prueba otro nombre.",{exact:true}).waitFor();
    check(`6C ${name}: búsqueda vacía permite repetir`, await editor.getByRole("button",{name:"Buscar",exact:true}).isEnabled());
    await settings.evaluate(() => { const s=window.__jw; s.searchEmpty=false; s.searchResults=Array.from({length:6},(_,i)=>({name:`Ciudad ${i}`,admin:null,country:null,latitude:1,longitude:2})); });
    await editor.getByRole("button",{name:"Buscar",exact:true}).click();
    await editor.getByRole("list",{name:"Ciudades encontradas"}).waitFor();
    check(`6C ${name}: resultados acotados a cinco`, await editor.locator(".weather-results li").count()===5);
    await settings.setViewportSize({width:520,height:900});
    check(`6C ${name}: ajustes estrechos sin desbordamiento`, await settings.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    check(`6C ${name}: ajustes sin desbordamiento horizontal`, await settings.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await settings.close();
  }
}

try {
  if (process.argv.includes("--today-hierarchy-only")) {
    await checkTodayHierarchy();
    assert.deepEqual(errors, []);
    await writeFile(resolve(evidence, "hierarchy-results.json"), JSON.stringify({ isolatedIPC:true,checks,errors }, null, 2));
    console.log(`${checks.length}/${checks.length} comprobaciones de jerarquía Hoy correctas`);
  } else if (process.argv.includes("--today-weather-only")) {
    await checkTodayWeather();
    assert.deepEqual(errors, []);
    await writeFile(resolve(evidence, "weather-results.json"), JSON.stringify({ isolatedIPC:true,checks,errors }, null, 2));
    console.log(`${checks.length}/${checks.length} comprobaciones Hoy y Ajustes correctas`);
  } else if (process.argv.includes("--bar-drag-only")) {
    await checkPetReorder();
    assert.deepEqual(errors, []);
    await writeFile(resolve(evidence, "bar-drag-results.json"), JSON.stringify({ isolatedIPC: true, checks, errors }, null, 2));
    console.log(`${checks.length}/${checks.length} comprobaciones de arrastre correctas`);
  } else {
  await checkTodayHierarchy();
  await checkTodayWeather();
  // JW-30: nombres, IPC cerrado y geometría nativa simulada desde ambas formas de barra.
  for (const [name, style, color] of [["Negro", "classic", "black"], ["Pizarra", "classic", "royal"], ["Aurora", "aurora", "black"]]) {
    for (const mode of ["compact", "expanded"]) {
      for (const edge of ["top", "left"]) {
        const reducedMotion = mode === "compact" ? "reduce" : "no-preference";
        const page = await todayScene({ style, color, mode, edge, reducedMotion });
        const tag = `JW-30 ${name}/${mode}/${edge}`;
        check(`${tag}: fecha local y próximo evento futuro`, await page.locator(".today-date").getAttribute("datetime") === "2026-10-27" && await page.locator('[data-today="next"]').innerText().then((text) => text.includes("11:00") && text.includes("Revisión del proyecto") && !text.includes("terminada")));
        check(`${tag}: tareas vencidas, de hoy, próximas y sin fecha`, await page.locator('[data-today="tasks"]').innerText().then((text) => text.includes("4 tareas") && text.includes("1 vencida · 1 hoy · 1 próxima · 1 sin fecha")));
        check(`${tag}: correo, eventos y sincronización conservados`, await page.locator('[data-today="mail"] .stat-value').innerText() === "2" && await page.locator('[data-today="events"]').innerText() === "3 eventos del día" && await page.locator("[data-today-sync]").innerText().then((text) => text.includes("Correo: actualizado") && text.includes("Agenda: actualizado")));
        check(`${tag}: cinco lanzadores`, await page.locator(".today-launchers .launch-btn").count() === 5);
        if (mode === "compact") await shot(page, `today-after-${name}-${edge}.png`);
        for (const [target, label] of [["telegram", "Telegram"], ["whatsapp", "WhatsApp"], ["spotify", "Spotify"], ["netflix", "Netflix"], ["youtube", "YouTube"]]) {
          const button = page.getByRole("button", { name: label, exact: true });
          await button.click();
          check(`${tag}: ${label} accesible invoca enum fijo`, await button.getAttribute("data-brand") === target && await page.evaluate((target) => {
            const calls = window.__jw.calls.filter((c) => c.cmd === "media_open");
            return calls.at(-1)?.args.target === target && Object.keys(calls.at(-1).args).join() === "target";
          }, target));
        }
        check(`${tag}: un IPC por botón`, await page.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "media_open").length) === 5);
        check(`${tag}: sin desbordamiento horizontal ni recorte exterior`, await page.locator(".today-panel").evaluate((panel) => {
          const body = panel.querySelector(".today-body");
          const p = panel.getBoundingClientRect();
          const b = body.getBoundingClientRect();
          return panel.scrollWidth <= panel.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1 &&
            p.left >= 0 && p.top >= 0 && p.right <= innerWidth + 1 && p.bottom <= innerHeight + 1 && b.bottom <= p.bottom + 1 &&
            [...panel.querySelectorAll(".today-launchers button")].every((el) => {
              const r = el.getBoundingClientRect();
              return r.top >= p.top && r.bottom <= p.bottom && el.scrollWidth <= el.clientWidth + 1;
            }) &&
            [...panel.querySelectorAll("button")].every((el) => {
              const r = el.getBoundingClientRect();
              return r.width >= 44 && r.height >= 44 && r.left >= p.left && r.right <= p.right;
            });
        }));
        await page.locator('[data-workspace="2"]').focus();
        await page.keyboard.press("Tab");
        check(`${tag}: foco visible`, await page.getByRole("button", { name: "Telegram", exact: true }).evaluate((el) => el === document.activeElement && el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none"));
        if (mode === "compact") {
          check(`${tag}: movimiento reducido sin animaciones`, await page.locator(".today-panel").evaluate((el) => [el, ...el.querySelectorAll("*")].every((node) => getComputedStyle(node).animationName === "none" && getComputedStyle(node).transitionDuration === "0s")));
          await page.locator(".today-body").evaluate((el) => { el.scrollTop = el.scrollHeight; });
          await shot(page, `today-after-${name}-${edge}-actions.png`);
        }
        await contrast(page, ".today-date, .today-caption, .today-grid .muted, .today-sync", `${tag}/texto secundario`);
        await page.locator('[data-action="focus"]').click();
        check(`${tag}: Concentración conserva su comando`, await page.evaluate(() => window.__jw.calls.some((c) => c.cmd === "open_focus_settings")));
        await page.evaluate(() => { window.__jw.mediaOpenError = "No se pudo abrir el navegador (prueba)"; });
        await page.getByRole("button", { name: "WhatsApp", exact: true }).click();
        await page.getByRole("alert").waitFor();
        check(`${tag}: error por onError existente`, await page.getByRole("alert").innerText().then((text) => text.includes("No se pudo abrir el navegador (prueba)")));
        await page.close();
      }
    }
  }
  // JW-31: próximo evento de Hoy (hoy antes que días posteriores, fecha en español).
  for (const [label, events, title, caption] of [
    ["todo el día de hoy antes que mañana con hora", [{ id: "a", title: "Mañana con hora", start: "2026-10-28T14:00:00Z", allDay: false }, { id: "b", title: "Hoy todo el día", start: "2026-10-27", allDay: true }], "Hoy todo el día", /^Próximo evento$/],
    ["con hora de hoy antes que todo el día de hoy", [{ id: "a", title: "Hoy todo el día", start: "2026-10-27", allDay: true }, { id: "b", title: "Hoy 16:00Z", start: "2026-10-27T16:00:00Z", allDay: false }], "Hoy 16:00Z", /^Próximo evento$/],
    ["solo días posteriores con fecha en español", [{ id: "a", title: "Pasado mañana", start: "2026-10-29", allDay: true }, { id: "b", title: "Mañana", start: "2026-10-28T14:00:00Z", allDay: false }], "Mañana", /^Próximo evento · mié.*28.*oct/],
    ["evento de hoy ya terminado se ignora", [{ id: "a", title: "Ya pasó", start: "2026-10-27T13:00:00Z", allDay: false }, { id: "b", title: "Mañana", start: "2026-10-28", allDay: true }], "Mañana", /^Próximo evento · mié.*28.*oct/],
  ]) {
    const page = await todayScene({ style: "classic", color: "black", mode: "compact", edge: "top", reducedMotion: "reduce" });
    await page.evaluate((events) => { window.__jw.agenda.events = events; window.__jw.emit("cloud-changed"); }, events);
    await page.locator(`[data-today="next"] strong:has-text("${title}")`).waitFor();
    const text = await page.locator('[data-today="next"] .today-caption').innerText();
    check(`JW-31 Hoy próximo evento: ${label}`, caption.test(text) && !/\d{4}-\d{2}-\d{2}/.test(text));
    await page.close();
  }

  // JW-31: calendario mensual en los tres estilos, horizontal y vertical.
  for (const [name, style, color] of [["Negro", "classic", "black"], ["Pizarra", "classic", "royal"], ["Aurora", "aurora", "black"]]) {
    for (const edge of ["top", "left"]) {
      const tag = `JW-31 ${name}/${edge}`;
      const page = await open({ style, color, mode: "compact", edge, geometry: true, reducedMotion: "reduce", autoCompactSeconds: 0 });
      await page.clock.setFixedTime(new Date("2026-10-27T15:00:00Z"));
      const monthCalls = () => page.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "cloud_month").map((c) => `${c.args.year}-${c.args.month}`));
      const day = (date) => page.locator(`[data-date="${date}"]`);
      const active = () => page.evaluate(() => document.activeElement.dataset.date);
      await page.locator('.widget[data-id="calendar"] button').click();
      await day("2026-10-27").waitFor();
      await page.locator("[data-month-event]").first().waitFor();
      check(`${tag}: rejilla accesible, lunes primero y nombres en español`, await page.locator('[role="grid"]').evaluate((grid) => {
        const heads = [...grid.querySelectorAll('[role="columnheader"]')].map((el) => el.getAttribute("aria-label"));
        const first = grid.querySelector("button.month-day").getAttribute("aria-label");
        return heads.join() === "lunes,martes,miércoles,jueves,viernes,sábado,domingo" && grid.querySelectorAll('[role="gridcell"]').length === 42 && /28 de septiembre/.test(first);
      }) && await page.locator("#month-label").innerText().then((t) => /octubre.*2026/i.test(t)));
      check(`${tag}: hoy resaltado y seleccionado`, await day("2026-10-27").getAttribute("aria-current") === "date" && await page.locator('[aria-selected="true"] > [data-date]').getAttribute("data-date") === "2026-10-27");
      check(`${tag}: marcas de eventos y tareas`, await page.evaluate(() => {
        const marks = (d) => [...document.querySelectorAll(`[data-date="${d}"] [data-mark]`)].map((el) => el.dataset.mark).join();
        return marks("2026-10-05") === "event" && marks("2026-10-27") === "event,task" && marks("2026-10-28") === "task" && marks("2026-10-06") === "";
      }));
      check(`${tag}: lista del día seleccionado`, await page.locator(".month-list").innerText().then((t) => t.includes("Jornada ficticia") && t.includes("Tarea ficticia")));
      check(`${tag}: una sola consulta al abrir`, JSON.stringify(await monthCalls()) === '["2026-10"]');
      await page.waitForTimeout(400);
      check(`${tag}: sin sondeo`, JSON.stringify(await monthCalls()) === '["2026-10"]');
      // Teclado: Inicio, Intro, flechas, Espacio, RePág/AvPág.
      await day("2026-10-27").focus();
      await page.keyboard.press("Home");
      check(`${tag}: Inicio va al lunes`, await active() === "2026-10-26");
      await page.keyboard.press("Enter");
      check(`${tag}: Intro selecciona y la lista queda vacía`, await page.locator(".month-list").innerText().then((t) => t.includes("Sin eventos ni tareas")) && await day("2026-10-26").evaluate((el) => el.parentElement.getAttribute("aria-selected")) === "true");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      check(`${tag}: flecha derecha avanza un día`, await active() === "2026-10-28");
      await page.keyboard.press("Space");
      check(`${tag}: Espacio selecciona`, await page.locator(".month-list").innerText().then((t) => t.includes("Solo tarea") && !t.includes("Jornada")));
      await page.keyboard.press("ArrowDown");
      check(`${tag}: flecha abajo cambia de mes al pasar el borde`, await active() === "2026-11-04" && await page.locator("#month-label").innerText().then((t) => /noviembre/i.test(t)));
      await page.keyboard.press("PageUp");
      check(`${tag}: RePág retrocede un mes`, await active() === "2026-10-04" && JSON.stringify(await monthCalls()) === '["2026-10","2026-11","2026-10"]');
      await page.keyboard.press("PageDown");
      await page.keyboard.press("End");
      check(`${tag}: AvPág y Fin`, await active() === "2026-11-08" && await page.locator("#month-label").innerText().then((t) => /noviembre/i.test(t)));
      await page.getByRole("button", { name: "Mes anterior", exact: true }).click();
      await page.getByRole("button", { name: "Mes siguiente", exact: true }).click();
      await page.getByRole("button", { name: "Mes siguiente", exact: true }).click();
      check(`${tag}: botones de mes`, await page.locator("#month-label").innerText().then((t) => /diciembre/i.test(t)) && (await monthCalls()).at(-1) === "2026-12");
      check(`${tag}: sin desbordamiento y botones dentro del panel`, await page.locator(".month-panel").evaluate((panel) => {
        const p = panel.getBoundingClientRect();
        const body = panel.querySelector(".month-body");
        return panel.scrollWidth <= panel.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1 &&
          [...panel.querySelectorAll(".month-nav button, .month-day, .panel-head button")].every((el) => { const r = el.getBoundingClientRect(); return r.left >= p.left - 1 && r.right <= p.right + 1; });
      }));
      await shot(page, `month-${name}-${edge}.png`);
      await contrast(page, ".month-help, .month-week span", `${tag}/texto secundario`);
      // Parcial: aviso visible sin ocultar los datos.
      await page.evaluate(() => { window.__jw.monthPartial = true; });
      await page.getByRole("button", { name: "Mes anterior", exact: true }).click();
      await page.locator("[data-month-partial]").waitFor();
      check(`${tag}: estado parcial`, await page.locator("[data-month-partial]").innerText().then((t) => /parcial/i.test(t)) && await page.locator("[data-mark]").count() > 0);
      // Cargando, sesión cerrada, fallo de red y fallo de IPC.
      await page.evaluate(() => { window.__jw.monthPartial = false; window.__jw.monthMode = "defer"; });
      await page.getByRole("button", { name: "Mes anterior", exact: true }).click();
      check(`${tag}: estado de carga`, await page.locator(".empty-note").innerText().then((t) => t.includes("Cargando")) && await page.locator('[role="grid"]').getAttribute("aria-busy") === "true");
      await page.evaluate(() => { window.__jw.monthMode = "signedOut"; window.__jw.monthPending.splice(0).forEach((resolve) => resolve()); });
      await page.getByRole("button", { name: "Conectar cuenta", exact: true }).waitFor();
      await page.evaluate(() => { window.__jw.monthMode = "network"; });
      await page.getByRole("button", { name: "Mes siguiente", exact: true }).click();
      await page.getByRole("button", { name: "Reintentar", exact: true }).waitFor();
      await page.evaluate(() => { window.__jw.monthMode = "ok"; });
      await page.getByRole("button", { name: "Reintentar", exact: true }).click();
      await page.locator("[data-mark]").first().waitFor();
      check(`${tag}: reintento recupera el mes`, await page.getByRole("button", { name: "Reintentar", exact: true }).count() === 0);
      await page.evaluate(() => { window.__jw.monthMode = "ipc"; });
      await page.getByRole("button", { name: "Mes anterior", exact: true }).click();
      await page.getByRole("button", { name: "Reintentar", exact: true }).waitFor();
      check(`${tag}: fallo de IPC visible`, await page.locator('.cloud-note[data-kind="other"]').count() > 0);
      // La agenda de siete días sigue accesible.
      await page.getByRole("button", { name: "Ver agenda", exact: true }).click();
      await page.locator("[data-event]").first().waitFor();
      await page.getByRole("button", { name: "Ver mes", exact: true }).click();
      await page.locator('[role="grid"]').waitFor();
      check(`${tag}: agenda accesible desde el mes`, true);
      await page.close();
    }
  }
  for (const [style, color] of [["classic", "black"], ["classic", "royal"], ["aurora", "black"]]) {
    const page = await open({ style, color, minimized: true, geometry: true, reducedMotion: "reduce" });
    await page.mouse.move(20, 18);
    await page.mouse.down();
    for (const forcedColors of ["none", "active"]) {
      await page.emulateMedia({ forcedColors });
      presenceCheck(`JW-26 ${style}/${color}/${forcedColors}: cápsula sin borde, fondo ni sombra`, await page.locator(".island").evaluate((el) => [el, el.querySelector(".mini-trigger")].every((e) => {
        const css = getComputedStyle(e);
        return css.borderTopWidth === "0px" && css.boxShadow === "none" && css.backgroundColor.endsWith(", 0)") && (e.matches(":focus-visible") || css.outlineStyle === "none");
      })));
    }
    await page.mouse.up();
    await page.close();
  }
  for (const edge of ["top", "left"]) {
    const page = await open({ minimized: true, geometry: true, edge, offset: 0.3, reducedMotion: "reduce" });
    await page.evaluate(() => { window.__jw.deferDrag = true; });
    await page.mouse.move(20, 18);
    await page.mouse.down();
    presenceCheck(`JW-26 captura el puntero en Mini (${edge})`, await page.locator(".mini-trigger").evaluate((el) => el.hasPointerCapture(window.__jw.pointerId)));
    await page.mouse.move(23, 18);
    presenceCheck(`JW-26 bajo umbral no invoca arrastre (${edge})`, await page.evaluate(() => !window.__jw.calls.some((c) => c.cmd === "bar_drag")));
    await page.mouse.move(32, 18);
    await page.waitForFunction(() => Boolean(window.__jw.dragResolve));
    presenceCheck(`JW-26 suelta captura antes del IPC compartido (${edge})`, await page.evaluate(() => !window.__jw.dragCaptured && window.__jw.calls.filter((c) => c.cmd === "bar_drag").length === 1));
    await page.locator(".mini-trigger").dispatchEvent("pointercancel");
    await page.mouse.up();
    presenceCheck(`JW-26 arrastre pendiente no restaura ni oculta Mini (${edge})`, await page.evaluate(() => !window.__jw.calls.some((c) => c.cmd === "set_minimized") && getComputedStyle(document.querySelector(".island")).opacity === "1"));
    await page.evaluate(() => {
      const state = window.__jw;
      state.settings.barOffsets[state.settings.edge] = 0.8;
      state.emit("settings-changed", structuredClone(state.settings));
      state.dragResolve();
    });
    await page.locator(".mini-trigger").press("Enter");
    await page.locator(".island.compact").waitFor();
    presenceCheck(`JW-26 restaurar conserva centro publicado al soltar (${edge})`, await page.locator(".stage").evaluate((el) => el.style.getPropertyValue("--presence-offset") === "0.8") && await page.evaluate(() => !window.__jw.settings.minimized && window.__jw.settings.mode === "compact"));
    await page.close();
  }
  // JW-33: reloj virtual e IPC aislado; cada avance cruza el plazo sin esperar 40 s reales.
  const idlePage = (options = {}) => open({ mode: "expanded", fakeTime: true, reducedMotion: "reduce", ...options });
  const advance = async (page, ms) => { await page.clock.runFor(ms); await page.evaluate(() => {}); };
  const interact = (page, event) => page.locator(".island").dispatchEvent(event);
  const remainsExpanded = (page) => page.locator(".island.expanded").count();
  const compactCalls = (page) => page.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "patch_settings" && c.args.patch.mode === "compact").length);
  {
    const page = await idlePage();
    for (const event of ["keydown", "wheel", "focusin", "pointermove", "input"]) {
      await advance(page, 39999);
      check(`JW-33 interacción ${event} reinicia el plazo`, await remainsExpanded(page) === 1 && await compactCalls(page) === 0);
      await interact(page, event);
    }
    await advance(page, 39999);
    check("JW-33 aún expandida antes de 40 s", await remainsExpanded(page) === 1);
    await advance(page, 1);
    await page.locator(".island.compact").waitFor();
    check("JW-33 40 s compactan una sola vez sin minimizar", await compactCalls(page) === 1 && await page.evaluate(() => !window.__jw.settings.minimized && !window.__jw.calls.some((c) => c.cmd === "set_minimized")));
    await advance(page, 120000);
    check("JW-33 compacto no mantiene un temporizador de compactación", await compactCalls(page) === 1);
    await page.close();
  }
  {
    const page = await idlePage();
    await interact(page, "pointerenter");
    await advance(page, 120000);
    check("JW-33 puntero sobre la barra inhibe compactar", await remainsExpanded(page) === 1);
    await interact(page, "pointerleave");
    await advance(page, 40000);
    await page.locator(".island.compact").waitFor();
    check("JW-33 salir del puntero inicia un plazo completo", await compactCalls(page) === 1);
    await page.close();
  }
  for (const minimized of [false, true]) {
    const page = await idlePage({ mode: "compact", minimized });
    await page.evaluate(() => window.__jw.emit("panel-shortcut", "clipboard"));
    const field = page.getByRole("searchbox");
    await field.waitFor();
    await field.focus();
    await advance(page, 120000);
    check(`JW-33 foco en texto protege el panel (Mini=${minimized})`, await page.locator(".island.panel").count() === 1);
    await field.evaluate((el) => el.blur());
    await advance(page, 39999);
    check(`JW-33 quitar foco inicia plazo completo (Mini=${minimized})`, await page.locator(".island.panel").count() === 1);
    await advance(page, 1);
    await page.locator(".island.compact").waitFor();
    check(`JW-33 cierra panel en compacto, nunca pastilla (Mini=${minimized})`, await page.evaluate(() => !window.__jw.panel && !window.__jw.settings.minimized && window.__jw.settings.mode === "compact"));
    await page.close();
  }
  for (const reason of ["document", "native", "alert", "drag", "reorder"]) {
    const page = await idlePage();
    await advance(page, 30000);
    await page.evaluate(async (reason) => {
      const state = window.__jw;
      if (reason === "document") {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
      } else if (reason === "native") state.emit("bar-visibility", false);
      else if (reason === "alert") await state.setClock({ timers: [], alerts: [{ id: 1, kind: "timer", label: "Aviso ficticio" }] });
      else if (reason === "reorder") document.querySelector(".widget").dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() }));
      else {
        state.deferDrag = true;
        const el = document.querySelector(".island");
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, screenX: 10, screenY: 10 }));
        window.dispatchEvent(new PointerEvent("pointermove", { screenX: 20, screenY: 10 }));
      }
    }, reason);
    await advance(page, 120000);
    check(`JW-33 inhibe compactar durante ${reason}`, await compactCalls(page) === 0);
    await page.evaluate(async (reason) => {
      const state = window.__jw;
      if (reason === "document") {
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
      } else if (reason === "native") state.emit("bar-visibility", true);
      else if (reason === "alert") await state.setClock({ timers: [], alerts: [] });
      else if (reason === "reorder") window.dispatchEvent(new Event("dragend"));
      else { state.deferDrag = false; state.dragResolve(); }
    }, reason);
    await advance(page, 39999);
    check(`JW-33 reanuda plazo completo tras ${reason}`, await remainsExpanded(page) === 1);
    await advance(page, 1);
    await page.locator(".island.compact").waitFor();
    await page.close();
  }
  for (const options of [{ autoCompactSeconds: 0 }, { mode: "compact" }, { minimized: true }]) {
    const page = await idlePage(options);
    await advance(page, 600000);
    check(`JW-33 sin compactación para ${JSON.stringify(options)}`, await compactCalls(page) === 0 && await page.evaluate(() => !window.__jw.calls.some((c) => c.cmd === "set_minimized")));
    await page.close();
  }
  {
    const page = await idlePage();
    await advance(page, 30000);
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("patch_settings", { patch: { autoCompactSeconds: 10 } }));
    await advance(page, 9999);
    check("JW-33 cambio de ajuste rearma el plazo", await remainsExpanded(page) === 1);
    await advance(page, 1);
    await page.locator(".island.compact").waitFor();
    await page.close();
    const settings = await open({ label: "settings" });
    const field = settings.getByRole("spinbutton", { name: "Segundos para compactar por inactividad" });
    check("JW-33 campo accesible con valor inicial 40", await field.inputValue() === "40" && await field.getAttribute("aria-describedby") === "auto-compact-hint");
    for (const [value, expected] of [["0", 0], ["5", 10], ["601", 600], ["55", 55]]) {
      await field.fill(value);
      await field.blur();
      await settings.waitForFunction((value) => window.__jw.settings.autoCompactSeconds === value, expected);
      check(`JW-33 guarda ${value} como ${expected} mediante parche mínimo`, await settings.evaluate((value) => JSON.stringify(window.__jw.calls.filter((c) => c.cmd === "patch_settings").at(-1).args.patch) === JSON.stringify({ autoCompactSeconds: value }), expected));
    }
    await settings.close();
  }
  // JW-20: cobertura parcial, doble clic bloqueado e informe sin backend real.
  const productivity = await open();
  const partialTitle = "Hay más tareas de las que se pudieron contar";
  await productivity.evaluate(() => {
    const state = window.__jw;
    state.agenda.tasksPartial = true;
    state.agenda.pendingTasks = 31;
    state.settings.workspaces = [{ id: 1, name: "Prueba", shortcuts: [1, 2] }, { id: 2, name: "Otro", shortcuts: [1] }];
    state.emit("settings-changed", structuredClone(state.settings));
  });
  await productivity.locator('.widget[data-id="calendar"] .widget-trigger').click();
  await productivity.getByRole("button", { name: "Ver agenda", exact: true }).click();
  await productivity.getByRole("button", { name: "Actualizar", exact: true }).click();
  await productivity.getByTitle(partialTitle).waitFor();
  check("JW-20 agenda indica parcial con título accesible", await productivity.getByTitle(partialTitle).innerText() === "Tareas: parcial" && await productivity.getByTitle(partialTitle).getAttribute("aria-label") === partialTitle);
  await shot(productivity, "agenda-parcial.png");
  await productivity.keyboard.press("Escape");
  await productivity.locator('.widget[data-id="today"] .widget-trigger').click();
  check("JW-20 Hoy indica cobertura parcial", await productivity.locator('[data-today="tasks"]').innerText().then((text) => text.includes("31 tareas+")) && await productivity.getByTitle(partialTitle).count() === 1);
  await productivity.evaluate(() => { window.__jw.workspaceMode = "defer"; });
  const workspace = productivity.locator('[data-workspace="1"]');
  await workspace.click();
  check("JW-20 espacio deshabilitado y ocupado durante apertura", await workspace.isDisabled() && await workspace.getAttribute("aria-busy") === "true");
  check("JW-20 otro espacio sigue disponible", await productivity.locator('[data-workspace="2"]').isEnabled());
  await workspace.evaluate((button) => { button.click(); button.click(); });
  check("JW-20 doble clic emite una sola apertura", await productivity.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "open_workspace").length) === 1);
  await productivity.evaluate(() => {
    window.__jw.workspaceFailure = "Accesos abiertos: 1. No se pudieron abrir: «Editor».";
    window.__jw.workspaceResolve();
  });
  await productivity.locator("[data-today-error]").waitFor();
  check("JW-20 informe nombra fallo y cantidad abierta", await productivity.locator("[data-today-error]").innerText() === "Accesos abiertos: 1. No se pudieron abrir: «Editor».");
  check("JW-20 fallo libera el botón del espacio", await workspace.isEnabled() && await workspace.getAttribute("aria-busy") === "false");
  await shot(productivity, "workspace-informe.png");
  await productivity.evaluate(() => { window.__jw.workspaceMode = "ok"; window.__jw.workspaceFailure = null; });
  await workspace.click();
  await productivity.getByRole("status").waitFor();
  check("JW-20 éxito informa cantidad abierta", await productivity.getByRole("status").innerText() === "Accesos abiertos: 2." && await productivity.locator("[data-today-error]").count() === 0);
  check("JW-20 éxito libera el botón del espacio", await workspace.isEnabled());
  await productivity.keyboard.press("Escape");
  await productivity.evaluate(() => {
    window.__jw.agenda.tasksPartial = false;
    window.__jw.agenda.pendingTasks = 0;
    window.__jw.emit("cloud-changed");
  });
  await productivity.locator('.widget[data-id="calendar"] .widget-trigger').click();
  await productivity.getByRole("button", { name: "Ver agenda", exact: true }).click();
  await settle(productivity);
  check("JW-20 agenda completa sin marcador parcial", await productivity.getByTitle(partialTitle).count() === 0);
  await productivity.keyboard.press("Escape");
  await productivity.locator('.widget[data-id="today"] .widget-trigger').click();
  check("JW-20 Hoy completo sin marcador parcial", await productivity.getByTitle(partialTitle).count() === 0);
  await productivity.close();

  // JW-19: ocultación voluntaria, servicios independientes y reordenación visible.
  for (const mode of ["compact", "expanded"]) {
    for (const edge of ["top", "left", "bottom", "right"]) {
      const view = await open({ mode, edge, geometry: true, hiddenWidgets: ["system", "clipboard"] });
      check(`Widgets ${mode}/${edge}: ocho visibles, incluida mascota de Codex`, await view.locator(".widget-trigger").count() === 8 && await view.locator('.widget[data-id="clipboard"], .widget[data-id="system"]').count() === 0 && await view.locator(".codex-pet button").isVisible());
      await view.locator('.widget[data-id="clock"] button').focus();
      await view.keyboard.press("Alt+ArrowRight");
      check(`Widgets ${mode}/${edge}: teclado salta al siguiente visible`, await view.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "widget_move").at(-1).args.target === "mail" && window.__jw.settings.widgetOrder.length === 10));
      const dataTransfer = await view.evaluateHandle(() => new DataTransfer());
      await view.locator('.widget[data-id="today"]').dispatchEvent("dragstart", { dataTransfer });
      await view.locator('.widget[data-id="clock"]').dispatchEvent("drop", { dataTransfer });
      check(`Widgets ${mode}/${edge}: arrastre conserva ocultos y orden completo`, await view.evaluate(() => window.__jw.settings.hiddenWidgets.join() === "system,clipboard" && window.__jw.settings.widgetOrder.length === 10 && window.__jw.calls.filter((c) => c.cmd === "widget_move").at(-1).args.id === "today"));
      await view.evaluate(() => window.__jw.emit("panel-shortcut", "clipboard"));
      await view.locator('.panel-view[aria-label="Portapapeles"]').waitFor();
      check(`Widgets ${mode}/${edge}: Ctrl+Alt+C abre el panel oculto`, await view.evaluate(() => window.__jw.panel));
      await view.keyboard.press("Escape");
      check(`Widgets ${mode}/${edge}: cerrar devuelve foco a un widget visible`, await view.locator(".widget-trigger").first().evaluate((el) => el === document.activeElement));
      await view.evaluate(() => window.__jw.setClock({ timers: [], alerts: [{ id: 1, kind: "alarm", label: "Prueba oculta" }] }));
      await view.locator(".alert-view").waitFor({ state: "visible" });
      check(`Widgets ${mode}/${edge}: alarma sigue visible`, await view.locator(".alert-view").isVisible());
      await view.close();
    }
  }
  const lastWidget = await open({ hiddenWidgets: ["clock", "system", "mail", "calendar", "claude", "clipboard", "codex-pet", "media", "shortcuts"] });
  check("Widgets: con uno visible la mascota permanece oculta", await lastWidget.locator(".widget-trigger").count() === 1 && await lastWidget.locator(".codex-pet button").count() === 0);
  await lastWidget.evaluate(() => window.__jw.setClock({ timers: [], alerts: [{ id: 1, kind: "alarm", label: "Reloj oculto" }] }));
  await lastWidget.getByRole("alertdialog", { name: "Alarma" }).waitFor({ state: "visible" });
  check("Widgets: reloj oculto conserva avisos de alarma", await lastWidget.getByRole("alertdialog", { name: "Alarma" }).isVisible());
  await lastWidget.close();
  const tabs = await open({ label: "settings" });
  const tablist = tabs.getByRole("tablist", { name: "Secciones de ajustes" });
  await tablist.getByRole("tab", { name: "Apariencia" }).focus();
  for (const [key, name] of [["ArrowRight", "Productividad"], ["ArrowDown", "Cuentas"], ["ArrowRight", "Apariencia"], ["End", "Cuentas"], ["Home", "Apariencia"], ["ArrowLeft", "Cuentas"], ["ArrowUp", "Productividad"]]) {
    await tabs.keyboard.press(key);
    check(`Pestañas ${key}/${name}: foco y selección`, await tablist.getByRole("tab", { name }).evaluate((el) => el === document.activeElement && el.getAttribute("aria-selected") === "true"));
  }
  check("Pestañas: controles de productividad alcanzables", await tabs.getByRole("switch", { name: "Historial del portapapeles", exact: true }).isVisible() && await tabs.locator('[data-action="sc-add"]').isVisible() && await tabs.locator('[data-action="ws-add"]').isVisible());
  await tabs.reload();
  check("Pestañas: recuerda selección local sin IPC", await tabs.getByRole("tab", { name: "Productividad", exact: true }).getAttribute("aria-selected") === "true" && !await tabs.evaluate(() => window.__jw.calls.some((c) => c.cmd === "patch_settings")));
  await tabs.getByRole("tab", { name: "Cuentas", exact: true }).click();
  check("Pestañas: cuenta alcanzable", await tabs.locator('[data-action="login"]').isVisible());
  await tabs.getByRole("tab", { name: "Apariencia", exact: true }).click();
  const switches = tabs.locator(".widget-list").getByRole("switch");
  check("Widgets: diez interruptores activos por defecto", await switches.count() === 10 && await switches.evaluateAll((els) => els.every((el) => el.checked)));
  for (let i = 1; i < 10; i++) await switches.nth(i).uncheck();
  await switches.first().click();
  await tabs.getByRole("alert").waitFor();
  check("Widgets: último visible rechazado y error legible", await switches.first().isChecked() && (await tabs.getByRole("alert").innerText()).includes("al menos un widget"));
  await switches.nth(5).check();
  check("Widgets: mostrar de nuevo no cambia servicio", await tabs.evaluate(() => !window.__jw.settings.hiddenWidgets.includes("clipboard") && !window.__jw.settings.clipboardHistory && window.__jw.calls.filter((c) => c.cmd === "patch_settings").every((c) => Object.keys(c.args.patch).join() === "hiddenWidgets")));
  await tabs.setViewportSize({ width: 440, height: 760 });
  check("Ajustes: controles dentro de la ventana de 440 px", await tabs.locator(".settings-tabs button, .row > *, .widget-visibility").evaluateAll((els) => els.filter((el) => el.getClientRects().length).every((el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth;
  })));
  if (process.env.AUDIT_SCREENSHOTS !== "0") await tabs.screenshot({ path: resolve(evidence, "settings-appearance.png"), fullPage: true });
  await tabs.getByRole("tab", { name: "Productividad", exact: true }).click();
  await tabs.locator('[data-action="sc-add"]').click();
  await tabs.getByRole("textbox", { name: "Nombre", exact: true }).fill("Borrador ficticio");
  await tabs.getByRole("tab", { name: "Cuentas", exact: true }).click();
  await tabs.getByRole("tab", { name: "Productividad", exact: true }).click();
  check("Pestañas: conserva borradores al cambiar de sección", await tabs.getByRole("textbox", { name: "Nombre", exact: true }).inputValue() === "Borrador ficticio");
  await tabs.evaluate(() => {
    Storage.prototype.getItem = () => { throw new Error("Almacenamiento bloqueado"); };
    Storage.prototype.setItem = () => { throw new Error("Almacenamiento bloqueado"); };
  });
  await tabs.getByRole("tab", { name: "Apariencia", exact: true }).click();
  check("Pestañas: almacenamiento bloqueado conserva uso en memoria", await tabs.getByRole("tab", { name: "Apariencia", exact: true }).getAttribute("aria-selected") === "true");
  await tabs.close();

  for (const [name, style, color] of [["Negro", "classic", "black"], ["Pizarra", "classic", "royal"], ["Aurora", "aurora", "black"]]) {
    for (const edge of ["top", "left"]) {
      const view = await open({ style, color, edge, mode: "expanded", geometry: true });
      await contrast(view, ".tile-sub, .tile-head", `${name}/${edge}/tarjetas`);
      const long = "Nombre ficticio muy largo sin recortar el título completo ".repeat(6);
      await view.evaluate((long) => {
        const state = window.__jw;
        state.settings.shortcuts = [{ id: 1, name: long, kind: "url", target: "https://example.com" }];
        state.settings.workspaces = [{ id: 1, name: long, shortcuts: [1] }];
        state.mail.items[0].from = long;
        state.mail.items[0].subject = long;
        state.agenda.events[0].title = long;
        state.emit("settings-changed", structuredClone(state.settings));
      }, long);
      for (const [id, selector] of [["shortcuts", ".shortcut-btn .ellipsis"], ["today", ".workspace-copy .ellipsis"], ["mail", "[data-mail] .ellipsis"], ["calendar", "[data-event] .ellipsis:first-child"]]) {
        await view.locator(`.widget[data-id="${id}"] button`).click();
        if (id === "calendar") await view.getByRole("button", { name: "Ver agenda", exact: true }).click();
        await view.locator(selector).first().waitFor();
        check(`${name}/${edge}/${id}: elipsis con título completo sin desbordar`, await view.locator(selector).evaluateAll((els) => els.every((el) => {
          const css = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const panel = el.closest(".panel-view").getBoundingClientRect();
          return el.title === el.textContent && css.textOverflow === "ellipsis" && css.overflowX === "hidden" && el.scrollWidth > el.clientWidth && r.left >= panel.left && r.right <= panel.right;
        })));
        if (id === "mail") {
          await view.locator(".cloud-item").first().hover();
          await contrast(view, ".cloud-item .muted", `${name}/${edge}/correo elevado`);
        }
        await shot(view, `${name}-${edge}-${id}-long.png`);
        await view.keyboard.press("Escape");
        await view.locator(".widget-trigger").first().waitFor();
      }
      await view.close();
    }
    for (const theme of ["light", "dark"]) {
      const view = await open({ label: "settings", style, color });
      await view.evaluate((theme) => {
        window.__jw.settings.theme = theme;
        window.__jw.emit("settings-changed", structuredClone(window.__jw.settings));
      }, theme);
      await contrast(view, ".hint, .section h2, .segmented span, .mascot-picker span, .settings-tabs button:not([aria-selected=true])", `${name}/ajustes/${theme}`);
      await view.close();
    }
  }

  await checkPetReorder();

  // JW-34-6J: widget independiente; solo mostrar, sin panel ni redimensionado.
  const petLabel = "Mostrar mascota de Codex";
  for (const [name, style, color] of [["black", "classic", "black"], ["midnight", "classic", "royal"], ["neon", "aurora", "black"]]) {
    for (const mode of ["compact", "expanded"]) {
      for (const edge of ["top", "left"]) {
        const view = await open({ style, color, mode, edge, geometry: true });
        const pet = view.locator(".codex-pet button");
        await pet.waitFor();
        await view.locator(".widgets").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
        // JW-32: ambos iconos y cambio en vivo, sin alterar las mascotas de Mini.
        check(`Codex ${name}/${mode}/${edge}: Perrito por defecto conserva el icono pixelado`,
          await pet.locator('svg g[shape-rendering="crispEdges"]').count() === 1 && await pet.locator("img").count() === 0 &&
          await pet.locator("svg").evaluate((svg) => svg.getBoundingClientRect().width === 16));
        await view.evaluate(() => {
          window.__jw.settings.codexPetIcon = "dragon";
          window.__jw.emit("settings-changed", structuredClone(window.__jw.settings));
        });
        await pet.locator("img").evaluate((img) => img.decode());
        check(`Codex ${name}/${mode}/${edge}: Dragón cargado, pixelado, decorativo y sin deformación`, await pet.locator("img").evaluate((img) => {
          const css = getComputedStyle(img);
          const r = img.getBoundingClientRect();
          const button = img.closest("button").getBoundingClientRect();
          return img.naturalWidth === 163 && img.naturalHeight === 121 &&
            img.getAttribute("alt") === "" && img.getAttribute("aria-hidden") === "true" &&
            css.imageRendering === "pixelated" && css.objectFit === "contain" &&
            // JW-32 amplió solo el dragón a 22 px por su margen transparente (16 × 1,375).
            r.width === 22 && r.height > 0 && r.height <= 22 && Math.abs(r.width / r.height - 163 / 121) < 0.02 &&
            r.left >= button.left && r.right <= button.right && r.top >= button.top && r.bottom <= button.bottom;
        }) && await pet.locator("svg").count() === 0);
        await shot(view, `codex-dragon-${name}-${mode}-${edge}.png`);
        check(`Codex ${name}/${mode}/${edge}: botón accesible tras portapapeles y dentro de la isla`,
          await pet.getAttribute("aria-label") === "Mascota de Codex" && await pet.getAttribute("title") === petLabel && await pet.getAttribute("aria-pressed") === null &&
          await pet.evaluate((button) => {
            const li = button.parentElement;
            const r = button.getBoundingClientRect();
            const island = button.closest(".island").getBoundingClientRect();
            const previous = li.previousElementSibling.getBoundingClientRect();
            const next = li.nextElementSibling.getBoundingClientRect();
            const vertical = button.closest(".island").classList.contains("v");
            return li.tagName === "LI" && li.previousElementSibling.dataset.id === "clipboard" &&
              li.draggable === button.closest(".island").classList.contains("expanded") && li.dataset.id === "codex-pet" && r.width >= 22 && r.height >= 22 &&
              r.left >= island.left && r.top >= island.top && r.right <= island.right && r.bottom <= island.bottom &&
              (vertical ? r.top >= previous.bottom && r.bottom <= next.top : r.left >= previous.right && r.right <= next.left);
          }));
        const dimensions = await view.locator(".island").evaluate((el) => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }));
        const callsBefore = await view.evaluate(() => window.__jw.calls.length);
        await view.evaluate(() => { window.__jw.codexPetDeferred = true; });
        await pet.click();
        await view.waitForFunction(() => typeof window.__jw.codexPetResolve === "function");
        await pet.evaluate((button) => button.click());
        check(`Codex ${name}/${mode}/${edge}: pendiente no duplica IPC`, await view.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "show_codex_pet").length === 1) && await pet.getAttribute("aria-busy") === "true");
        await view.evaluate(() => { window.__jw.codexPetDeferred = false; window.__jw.codexPetResolve(); });
        await view.waitForFunction(() => document.querySelector(".codex-pet button").getAttribute("aria-busy") === "false");
        await pet.click();
        await view.waitForFunction(() => document.querySelector(".codex-pet button").getAttribute("aria-busy") === "false");
        check(`Codex ${name}/${mode}/${edge}: cada clic solo muestra sin argumentos`, await view.evaluate(() => {
          const calls = window.__jw.calls.filter((c) => c.cmd === "show_codex_pet");
          return calls.length === 2 && calls.every((c) => !c.args || Object.keys(c.args).length === 0);
        }));
        await view.evaluate(() => { window.__jw.failCodexPet = true; });
        await pet.click();
        await view.waitForFunction(() => document.querySelector(".codex-pet button").getAttribute("aria-busy") === "false");
        check(`Codex ${name}/${mode}/${edge}: error discreto sin estado visible`, (await pet.getAttribute("title")).includes("Codex no está abierto") && await pet.getAttribute("aria-pressed") === null && await view.getByRole("alert").count() === 0);
        await view.waitForTimeout(250);
        check(`Codex ${name}/${mode}/${edge}: éxito y error conservan panel y tamaño`, await view.evaluate(({ dimensions, callsBefore }) => {
          const r = document.querySelector(".island").getBoundingClientRect();
          return !window.__jw.panel && r.width === dimensions.width && r.height === dimensions.height &&
            !window.__jw.calls.slice(callsBefore).some((c) => c.cmd === "set_panel" || c.cmd.startsWith("plugin:window|set_size"));
        }, { dimensions, callsBefore }));
        if (name === "black" && mode === "compact" && edge === "top") await shot(view, "pet-error.png");
        await view.close();
      }
    }
  }

  for (const codexPetIcon of ["dog", "dragon"]) {
    const pick = await open({ label: "settings", codexPetIcon });
    const group = pick.getByRole("radiogroup", { name: "Mascota de Codex", exact: true });
    const label = codexPetIcon === "dog" ? "Perrito" : "Dragón";
    await pick.getByRole("tab", { name: "Productividad", exact: true }).click();
    check(`Codex ${codexPetIcon}: Ajustes sin atajo de ocultar`, await pick.getByText("Ocultar mascota de Codex", { exact: true }).count() === 0 && !(await pick.locator("body").innerText()).match(/Ctrl\s*Alt\s*O/));
    await pick.getByRole("tab", { name: "Apariencia", exact: true }).click();
    check(`Codex selector ${codexPetIcon}: dos opciones y selección guardada`,
      await group.getByRole("radio").count() === 2 && await group.getByRole("radio", { name: label, exact: true }).isChecked());
    await group.locator("img").evaluate((img) => img.decode());
    check(`Codex selector ${codexPetIcon}: vistas previas decorativas sin deformación`,
      await group.locator("svg").count() === 1 && await group.locator("img").evaluate((img) => {
        const r = img.getBoundingClientRect();
        const css = getComputedStyle(img);
        return img.getAttribute("alt") === "" && img.naturalWidth === 163 && img.naturalHeight === 121 &&
          r.width === 32 && Math.abs(r.width / r.height - 163 / 121) < 0.02 && css.imageRendering === "pixelated" && css.objectFit === "contain";
      }));
    await group.getByText("Perrito", { exact: true }).click();
    await group.getByRole("radio", { name: "Perrito", exact: true }).focus();
    for (const [key, value, label] of [["ArrowRight", "dragon", "Dragón"], ["ArrowRight", "dog", "Perrito"], ["ArrowUp", "dragon", "Dragón"], ["ArrowDown", "dog", "Perrito"]]) {
      await pick.keyboard.press(key);
      check(`Codex selector ${codexPetIcon}: ${key} elige ${label} con parche mínimo y conserva Mini`,
        await group.getByRole("radio", { name: label, exact: true }).isChecked() &&
        await group.getByRole("radio", { name: label, exact: true }).evaluate((radio) => document.activeElement === radio) &&
        await pick.evaluate((value) => window.__jw.settings.codexPetIcon === value && window.__jw.settings.mascot === "air" &&
          JSON.stringify(window.__jw.calls.filter((c) => c.cmd === "patch_settings").at(-1).args.patch) === JSON.stringify({ codexPetIcon: value }), value));
    }
    await group.getByText("Dragón", { exact: true }).click();
    check(`Codex selector ${codexPetIcon}: clic selecciona Dragón`, await group.getByRole("radio", { name: "Dragón", exact: true }).isChecked());
    if (process.env.AUDIT_SCREENSHOTS !== "0") await pick.screenshot({ path: resolve(evidence, `settings-codex-${codexPetIcon}.png`), fullPage: true });
    await pick.close();
  }

  // JW-16-02: fallos recuperables, parches mínimos y suspensión de sondeos.
  for (const label of ["bar", "settings"]) {
    const loading = await open({ label, settingsMode: "defer" });
    expect(`${label}: carga visible mientras IPC está pendiente`, await loading.getByRole("status").innerText(), "Cargando ajustes…", reliabilityChecks);
    await loading.evaluate(() => window.__jw.settingsResolve());
    await loading.locator(label === "bar" ? ".widget-trigger" : ".appearance-sample").last().waitFor();
    await loading.close();

    const failed = await open({ label, settingsMode: "error", geometry: label === "bar" });
    await failed.getByRole("button", { name: "Reintentar", exact: true }).waitFor();
    expect(`${label}: get_settings rechazado muestra error`, await failed.getByRole("alert").innerText(), "No se pudieron cargar los ajustes.", reliabilityChecks);
    if (process.env.AUDIT_SCREENSHOTS !== "0") await failed.screenshot({ path: resolve(evidence, `${label}-settings-error.png`) });
    await failed.evaluate(() => { window.__jw.settingsMode = "ok"; });
    await failed.getByRole("button", { name: "Reintentar", exact: true }).click();
    await failed.locator(label === "bar" ? ".widget-trigger" : ".appearance-sample").last().waitFor();
    expect(`${label}: Reintentar consulta de nuevo y recupera`, await failed.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "get_settings").length), 2, reliabilityChecks);
    expect(`${label}: recuperación retira el error`, await failed.getByRole("alert").count(), 0, reliabilityChecks);
    await failed.close();

    const broken = await open({ label, geometry: label === "bar" });
    // Datos malformados exclusivamente en el IPC ficticio provocan un error real de render.
    await broken.evaluate(() => window.__jw.emit("settings-changed", { ...window.__jw.settings, widgetOrder: null }));
    await broken.getByRole("button", { name: "Recargar", exact: true }).waitFor();
    expect(`${label}: boundary muestra mensaje en español`, await broken.getByRole("alert").innerText(), "Ocurrió un error al mostrar JarWis. Recarga la ventana para volver a intentarlo.", reliabilityChecks);
    if (process.env.AUDIT_SCREENSHOTS !== "0") await broken.screenshot({ path: resolve(evidence, `${label}-render-error.png`) });
    await Promise.all([broken.waitForEvent("load"), broken.getByRole("button", { name: "Recargar", exact: true }).click()]);
    await broken.locator(label === "bar" ? ".widget-trigger" : ".appearance-sample").last().waitFor();
    expect(`${label}: Recargar recupera la ventana`, await broken.locator(".recovery-card").count(), 0, reliabilityChecks);
    await broken.close();
  }

  const patched = await open({ label: "settings" });
  await patched.getByRole("radiogroup", { name: "Tema", exact: true }).getByText("Claro", { exact: true }).click();
  await settle(patched);
  expect("Ajustes: cambiar tema envía únicamente theme", await patched.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "patch_settings").map((c) => c.args)), [{ patch: { theme: "light" } }], reliabilityChecks);
  expect("Ajustes: no se usa update_settings", await patched.evaluate(() => window.__jw.calls.some((c) => c.cmd === "update_settings")), false, reliabilityChecks);
  await patched.getByRole("radiogroup", { name: "Estilo de la barra", exact: true }).getByText("Pizarra", { exact: true }).click();
  await settle(patched);
  expect("Apariencia: omite barStyle si no cambia", await patched.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "patch_settings").at(-1).args), { patch: { islandColor: "royal" } }, reliabilityChecks);
  await patched.close();

  const barPatch = await open();
  await barPatch.locator('[data-action="mode"]').click();
  await settle(barPatch);
  expect("Barra: cambiar modo envía únicamente mode", await barPatch.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "patch_settings").at(-1).args), { patch: { mode: "expanded" } }, reliabilityChecks);
  await barPatch.locator('.widget[data-id="clock"] button').focus();
  await barPatch.keyboard.press("Alt+ArrowRight");
  await settle(barPatch);
  expect("Barra: reordenar envía solo id y destino", await barPatch.evaluate(() => ({
    args: window.__jw.calls.filter((c) => c.cmd === "widget_move").at(-1).args,
    first: window.__jw.settings.widgetOrder.slice(0, 2),
  })), { args: { id: "clock", target: "system" }, first: ["system", "clock"] }, reliabilityChecks);
  await barPatch.locator('.widget[data-id="clock"] button').click();
  await barPatch.getByRole("tab", { name: "Alarmas", exact: true }).click();
  await barPatch.locator('[data-action="add-alarm"]').click();
  await settle(barPatch);
  expect("Reloj: añadir envía solo la alarma nueva sin id", await barPatch.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "alarm_add").at(-1).args), { alarm: { hour: 7, minute: 0, days: [], label: "", enabled: true } }, reliabilityChecks);
  // El núcleo desactiva una alarma mientras la vista conserva la copia activada.
  await barPatch.evaluate(() => { window.__jw.settings.alarms[0].enabled = false; });
  await barPatch.locator('[data-action="add-alarm"]').click();
  await settle(barPatch);
  expect("Reloj: añadir desde vista vieja conserva la alarma disparada desactivada", await barPatch.evaluate(() => window.__jw.settings.alarms.map((a) => [a.id, a.enabled])), [[1, false], [2, true]], reliabilityChecks);
  await barPatch.locator('[data-alarm="2"] input[type="checkbox"]').uncheck();
  await settle(barPatch);
  expect("Reloj: activar usa id y enabled", await barPatch.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "alarm_set_enabled").at(-1).args), { id: 2, enabled: false }, reliabilityChecks);
  await barPatch.locator('[data-alarm="2"] button[aria-label="Borrar alarma"]').click();
  await settle(barPatch);
  expect("Reloj: borrar usa solo id y conserva la alarma disparada", await barPatch.evaluate(() => ({
    args: window.__jw.calls.filter((c) => c.cmd === "alarm_remove").at(-1).args,
    alarms: window.__jw.settings.alarms.map((a) => [a.id, a.enabled]),
  })), { args: { id: 2 }, alarms: [[1, false]] }, reliabilityChecks);
  expect("Parche: rechaza alarms y widgetOrder", await barPatch.evaluate(async () => {
    const ipc = window.__TAURI_INTERNALS__;
    return Promise.all(["alarms", "widgetOrder"].map((key) => ipc.invoke("patch_settings", { patch: { [key]: [] } }).then(() => false, () => true)));
  }), [true, true], reliabilityChecks);
  await barPatch.evaluate(() => { window.__jw.failEdit = true; });
  await barPatch.locator('[data-action="add-alarm"]').click();
  await barPatch.getByRole("alert").waitFor();
  expect("Reloj: fallo de guardado muestra el error", await barPatch.getByRole("alert").innerText(), "No se pudo guardar el cambio ficticio", reliabilityChecks);
  await barPatch.close();

  for (const label of ["bar", "settings"]) {
    const view = await open({ label });
    const item = (id) => view.locator(`${label === "bar" ? ".widget" : ".widget-list li"}[data-id="${id}"]`);
    const dataTransfer = await view.evaluateHandle(() => new DataTransfer());
    await item("today").dispatchEvent("dragstart", { dataTransfer });
    await item("clock").dispatchEvent("drop", { dataTransfer });
    await settle(view);
    expect(`${label}: arrastre envía solo id y destino`, await view.evaluate(() => ({
      args: window.__jw.calls.filter((c) => c.cmd === "widget_move").at(-1).args,
      first: window.__jw.settings.widgetOrder[0],
    })), { args: { id: "today", target: "clock" }, first: "today" }, reliabilityChecks);
    const trigger = label === "bar" ? item("clock").locator("button") : item("clock");
    await trigger.focus();
    await view.keyboard.press(label === "bar" ? "Alt+ArrowRight" : "Alt+ArrowDown");
    await settle(view);
    expect(`${label}: teclado usa widget_move`, await view.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "widget_move").at(-1).args), { id: "clock", target: "system" }, reliabilityChecks);
    // Otro escritor cambia el orden sin avisar aún a esta vista.
    await view.evaluate(() => {
      const order = window.__jw.settings.widgetOrder;
      order.splice(order.indexOf("mail"), 1);
      order.unshift("mail");
    });
    await item("calendar").dispatchEvent("dragstart", { dataTransfer });
    await item("clock").dispatchEvent("drop", { dataTransfer });
    await settle(view);
    expect(`${label}: movimiento desde copia vieja conserva el cambio ajeno`, await view.evaluate(() => window.__jw.settings.widgetOrder.slice(0, 5)), ["mail", "today", "system", "calendar", "clock"], reliabilityChecks);
    await view.evaluate(() => { window.__jw.failEdit = true; });
    await item("clock").dispatchEvent("dragstart", { dataTransfer });
    await item("today").dispatchEvent("drop", { dataTransfer });
    await view.getByRole("alert").waitFor();
    expect(`${label}: reordenar muestra el fallo de guardado`, await view.getByRole("alert").innerText(), "No se pudo guardar el cambio ficticio", reliabilityChecks);
    await view.close();
  }

  for (const source of ["document", "bar"]) {
    const polling = await open();
    await polling.locator('.widget[data-id="media"] button').click();
    await polling.locator('[aria-label="Audio y multimedia"]').waitFor();
    const commands = ["system_snapshot", "audio_state", "media_state", "cloud_mail", "cloud_agenda"];
    await polling.evaluate(() => {
      window.__jw.calls = [];
      window.__jw.stalePolls = [...window.__jw.polls.values()];
    });
    await polling.evaluate((source) => {
      if (source === "document") {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
      } else window.__jw.emit("bar-visibility", false);
    }, source);
    await settle(polling);
    expect(`${source}: se retiran todos los intervalos de vistas`, await polling.evaluate(() => window.__jw.intervals.size), 0, reliabilityChecks);
    await polling.evaluate(async () => {
      // Un callback ya encolado tampoco debe iniciar IPC después de la pausa.
      await Promise.all(window.__jw.stalePolls.map((p) => p.fn()));
    });
    // Más de dos periodos de Media y uno de Sistema; no se simula el paso del reloj.
    await polling.waitForTimeout(5200);
    expect(`${source}: Media/System/feeds no consultan ocultos`, await polling.evaluate((commands) => window.__jw.calls.filter((c) => commands.includes(c.cmd)).length, commands), 0, reliabilityChecks);
    await polling.evaluate((source) => {
      if (source === "document") {
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
      } else window.__jw.emit("bar-visibility", true);
    }, source);
    await settle(polling);
    expect(`${source}: cada sondeo refresca al volver`, await polling.evaluate((commands) => commands.map((cmd) => window.__jw.calls.filter((c) => c.cmd === cmd).length), commands), [1, 1, 1, 1, 1], reliabilityChecks);
    await polling.locator('[data-action="close-panel"]').click();
    await settle(polling);
    await polling.evaluate(() => { window.__jw.calls = []; });
    await polling.waitForTimeout(2200);
    expect(`${source}: Media deja de consultar al cerrar el panel`, await polling.evaluate(() => window.__jw.calls.filter((c) => ["audio_state", "media_state"].includes(c.cmd)).length), 0, reliabilityChecks);
    await polling.close();
  }

  for (const kind of ["mail", "agenda"]) {
    const widget = kind === "mail" ? "mail" : "calendar";
    const selector = kind === "mail" ? "[data-mail]" : "[data-event], [data-task]";
    const mode = kind + "Mode";
    const pending = kind === "mail" ? "pending" : "agendaPending";
    for (const restore of ["slow", "reject"]) {
      const view = await open();
      await view.locator(`.widget[data-id="${widget}"] button`).click();
      if (kind === "agenda") await view.getByRole("button", { name: "Ver agenda", exact: true }).click();
      await view.locator(selector).waitFor();
      await view.evaluate((mode) => { window.__jw[mode] = "defer"; }, mode);
      await view.locator('[data-action="refresh"]').click();
      await view.waitForFunction((pending) => window.__jw[pending].length === 1, pending);
      await view.evaluate(() => window.__jw.emit("bar-visibility", false));
      await settle(view);
      await view.evaluate(() => window.__jw.emit("cloud-changed", null));
      await settle(view);
      expect(`P1 ${kind} ${restore}: cambio de sesión oculto retira filas`, await view.locator(selector).count(), 0);
      expect(`P1 ${kind} ${restore}: sin consultas mientras está oculta`, await view.evaluate((pending) => window.__jw[pending].length, pending), 1);
      await view.evaluate(({ mode, restore }) => {
        window.__jw[mode] = restore === "reject" ? "error" : "defer";
        window.__jw.emit("bar-visibility", true);
      }, { mode, restore });
      if (restore === "reject") await view.locator('.cloud-note[data-kind="other"]').waitFor();
      else await view.waitForFunction((pending) => window.__jw[pending].length === 2, pending);
      await settle(view);
      expect(`P1 ${kind} ${restore}: restaurar retira filas previas`, await view.locator(selector).count(), 0);
      await view.evaluate(({ pending, kind }) => window.__jw[pending][0](window.__jw.feed(window.__jw[kind])), { pending, kind });
      await settle(view);
      expect(`P1 ${kind} ${restore}: respuesta de sesión anterior no repone filas`, await view.locator(selector).count(), 0);
      if (restore === "slow") {
        await view.evaluate((pending) => window.__jw[pending][1]({ data: null, error: { kind: "signedOut", message: "jarwis-prueba sesión cerrada" }, updatedAt: null }), pending);
        await view.locator('.cloud-note[data-kind="signedOut"]').waitFor();
        expect(`P1 ${kind}: sesión cerrada mantiene cero filas`, await view.locator(selector).count(), 0);
      }
      await view.close();
    }
    const view = await open();
    await view.locator(`.widget[data-id="${widget}"] button`).click();
    if (kind === "agenda") await view.getByRole("button", { name: "Ver agenda", exact: true }).click();
    await view.locator(selector).waitFor();
    await view.evaluate((mode) => { window.__jw[mode] = "defer"; }, mode);
    await view.locator('[data-action="refresh"]').click();
    await view.waitForFunction((pending) => window.__jw[pending].length === 1, pending);
    await view.evaluate(({ mode, ms }) => {
      // Si el hook consulta durante A, Rust devuelve esta caché anterior.
      window.__jw[mode] = "ok";
      const polls = [...window.__jw.polls.values()].filter((item) => item.ms === ms);
      if (polls.length !== 1) throw new Error("callback real de sondeo no encontrado");
      // setInterval ignora la promesa: coalescer puede devolver la de A pendiente.
      void polls[0].fn();
    }, { mode, ms: kind === "mail" ? 60000 : 300000 });
    await settle(view);
    expect(`P2 ${kind}: forzada sigue pendiente tras sondeo de caché`, await view.locator('[data-action="refresh"]').isDisabled(), true);
    await view.evaluate(({ pending, kind }) => {
      const fresh = structuredClone(window.__jw[kind]);
      if (kind === "mail") fresh.items[0].subject = "jarwis-prueba fresco";
      else fresh.events[0].title = "jarwis-prueba fresco";
      window.__jw[pending][0](window.__jw.feed(fresh));
    }, { pending, kind });
    await view.waitForFunction(() => !document.querySelector('[data-action="refresh"]').disabled);
    await settle(view);
    expect(`P2 ${kind}: resultado fresco visible después de caché`, (await view.locator(selector).textContent()).includes("jarwis-prueba fresco"), true);
    await view.close();
  }

  // Sonda inversa del ciclo 2: sondeo normal pendiente → Actualizar.
  for (const kind of ["mail", "agenda"]) {
    const widget = kind === "mail" ? "mail" : "calendar";
    const selector = kind === "mail" ? "[data-mail]" : "[data-event]";
    for (const scenario of ["cache", "fresh", "session"]) {
      const view = await open();
      const verify = (name, actual, expected) => expect(
        `P2 inverso ${kind} ${scenario}: ${name}`, actual, expected, inverseRegressions);
      await view.locator(`.widget[data-id="${widget}"] button`).click();
      if (kind === "agenda") await view.getByRole("button", { name: "Ver agenda", exact: true }).click();
      await view.locator(selector).waitFor();
      await view.evaluate(({ kind, scenario }) => {
        window.__jw.inverseCommand = "cloud_" + kind;
        window.__jw.inverseFreshPoll = scenario === "fresh";
        window.__jw.inverseDeferForce = true;
        const ms = kind === "mail" ? 60000 : 300000;
        const polls = [...window.__jw.polls.values()].filter((item) => item.ms === ms);
        if (polls.length !== 1) throw new Error("callback real de sondeo no encontrado");
        void polls[0].fn();
      }, { kind, scenario });
      await view.waitForFunction(() => typeof window.__jw.inverseResolve === "function");
      await view.locator('[data-action="refresh"]').click();
      await settle(view);
      verify("espera al sondeo sin lanzar force en paralelo", await view.evaluate(() => window.__jw.inverseCalls.map((c) => c.force)), [false]);
      verify("Actualizar permanece ocupado", await view.locator('[data-action="refresh"]').isDisabled(), true);
      if (scenario === "session") {
        await view.evaluate(() => window.__jw.emit("cloud-changed", null));
        // La nueva sesión debe iniciar su propia forzada antes de liberar la revocada.
        await view.waitForFunction(() => typeof window.__jw.inverseForceResolve === "function");
        verify("sesión nueva inicia force sin unirse a la revocada", await view.evaluate(() => window.__jw.inverseCalls.map((c) => c.force)), [false, true]);
        await view.evaluate(() => window.__jw.inverseResolve());
        await settle(view);
        verify("resolver sondeo revocado no repone filas", await view.locator(selector).count(), 0);
        verify("cola revocada no inicia otra consulta", await view.evaluate(() => window.__jw.inverseCalls.map((c) => c.force)), [false, true]);
        await view.evaluate(() => window.__jw.inverseForceResolve());
        await view.waitForFunction(() => !document.querySelector('[data-action="refresh"]').disabled);
        await view.locator(selector).waitFor();
        verify("resultado de sesión nueva visible", (await view.locator(selector).textContent()).includes("inversa fresco"), true);
      } else {
        await view.evaluate(() => window.__jw.inverseResolve());
        // Permite registrar el fallo previo sin esperar una forzada que nunca se envió.
        await view.waitForFunction(() => typeof window.__jw.inverseForceResolve === "function" || !document.querySelector('[data-action="refresh"]').disabled);
        await settle(view);
        const forced = await view.evaluate(() => window.__jw.inverseCalls.some((c) => c.force));
        verify("primer Actualizar solicita force", forced, true);
        verify("promesa de Actualizar cubre la forzada", await view.locator('[data-action="refresh"]').isDisabled(), true);
        verify("sondeo se aplica antes de resolver la forzada", (await view.locator(selector).textContent()).includes("inversa fresco"), scenario === "fresh");
        if (forced) await view.evaluate(() => window.__jw.inverseForceResolve());
        await view.waitForFunction(() => !document.querySelector('[data-action="refresh"]').disabled);
        await settle(view);
        verify("primer Actualizar obtiene datos frescos", (await view.locator(selector).textContent()).includes("inversa fresco"), true);
        // Control positivo de la sonda original: otro clic sin sondeo pendiente.
        await view.evaluate(() => { window.__jw.inverseDeferForce = false; window.__jw.inverseCalls = []; });
        await view.locator('[data-action="refresh"]').click();
        await view.waitForFunction(() => !document.querySelector('[data-action="refresh"]').disabled);
        await settle(view);
        verify("segundo clic solicita force", await view.evaluate(() => window.__jw.inverseCalls.map((c) => c.force)), [true]);
        verify("segundo clic obtiene datos frescos", (await view.locator(selector).textContent()).includes("inversa fresco"), true);
      }
      await view.close();
    }
  }

  const page = await open();
  check("10 widgets con botones nativos y nombre accesible", await page.locator(".widget button[aria-label]").count() === 10);
  const mailButton = page.locator('.widget[data-id="mail"] button');
  await mailButton.focus();
  await page.keyboard.press("Enter");
  await page.locator('[role="tablist"]').waitFor();
  check("Enter abre Correo y mueve el foco al panel", await page.locator('[role="tab"][data-tab="all"]').evaluate((e) => e === document.activeElement));
  await page.keyboard.press("ArrowLeft");
  check("flecha izquierda recorre pestañas y actualiza selección", await page.locator('[data-tab="outlook"]').getAttribute("aria-selected") === "true");
  await page.keyboard.press("Home");
  check("Home vuelve a Todos", await page.locator('[data-tab="all"]').getAttribute("aria-selected") === "true");
  check("pestaña enlazada con su panel", await page.locator('[role="tabpanel"]').getAttribute("aria-labelledby") === "mail-tab-all");
  await page.keyboard.press("Escape");
  await mailButton.waitFor();
  check("Escape devuelve el foco al widget de origen", await mailButton.evaluate((e) => e === document.activeElement));
  await page.keyboard.press("Alt+ArrowRight");
  check("Alt+flecha reordena sin ratón", await page.evaluate(() => window.__jw.settings.widgetOrder[3] === "mail"));
  await shot(page, "classic-compact.png");

  await page.locator('.widget[data-id="calendar"] button').click();
  await page.getByRole("button", { name: "Ver agenda", exact: true }).click();
  check("evento UTC muestra fecha y hora locales del mismo día", /lun.*26.*oct.*21:30/.test(await page.locator(".cloud-item .muted").textContent()));
  await page.keyboard.press("Escape");
  await mailButton.click();
  await page.evaluate(() => { window.__jw.mailMode = "error"; });
  await page.locator('[data-action="refresh"]').click();
  await page.locator('.cloud-note[data-kind="other"]').waitFor();
  check("fallo de IPC visible y conserva último dato bueno", await page.locator("[data-mail]").count() === 1);

  await page.evaluate(() => { window.__jw.mailMode = "defer"; });
  await page.locator('[data-action="refresh"]').click();
  await page.waitForFunction(() => window.__jw.pending.length === 1);
  check("Actualizar desactivado mientras espera", await page.locator('[data-action="refresh"]').isDisabled());
  await page.evaluate(() => window.__jw.emit("cloud-changed", null));
  await page.waitForFunction(() => window.__jw.pending.length === 2);
  // La llamada IPC se registra antes del commit de React; esperar ese repintado.
  await page.locator("[data-mail]").waitFor({ state: "hidden", timeout: 1000 });
  check("cambio de sesión retira inmediatamente los datos anteriores", await page.locator("[data-mail]").count() === 0);
  await page.evaluate(() => window.__jw.pending[1]({ data: null, error: { kind: "signedOut", message: "Sesión cerrada (ficticia)." }, updatedAt: null }));
  await page.locator('.cloud-note[data-kind="signedOut"]').waitFor();
  await page.evaluate(() => window.__jw.pending[0](window.__jw.feed(window.__jw.mail)));
  check("respuesta antigua no restaura datos tras cerrar sesión", await page.locator("[data-mail]").count() === 0 && await page.locator('.cloud-note[data-kind="signedOut"]').count() === 1);
  await page.keyboard.press("Escape");
  await page.locator('.widget[data-id="claude"] button').click();
  await page.locator('[data-launch="app"]').click();
  await page.locator('[role="alert"]').waitFor();
  check("error de acción legible y descartable", (await page.locator('[role="alert"]').textContent()).includes("jarwis-prueba"));
  await shot(page, "action-error.png");
  await page.locator('[data-action="dismiss-error"]').click();
  check("Volver recupera el panel anterior", await page.locator('[data-launch="app"]').count() === 1);
  await page.close();

  // JW-34-6D: Google puede seguir en curso más de cuatro reintentos sin error falso.
  for (const [mode, command, widget] of [["mailMode", "cloud_mail", "mail"], ["agendaMode", "cloud_agenda", "calendar"]]) {
    const pendingGoogle = await open();
    await pendingGoogle.locator(`.widget[data-id="${widget}"] button`).click();
    if (widget === "calendar") await pendingGoogle.getByRole("button", { name: "Ver agenda", exact: true }).click();
    await pendingGoogle.evaluate((mode) => { window.__jw[mode] = "busy"; window.__jw.emit("cloud-changed", null); }, mode);
    for (let i = 0; i < 6; i++) {
      await pendingGoogle.waitForFunction(() => window.__jw.retries.size === 1);
      await pendingGoogle.evaluate(() => {
        const [id, run] = [...window.__jw.retries][0];
        window.clearTimeout(id); run();
      });
    }
    await pendingGoogle.waitForFunction(() => window.__jw.retries.size === 1);
    check(`6D ${command}: sigue reintentando tras treinta segundos sin error falso`,
      await pendingGoogle.evaluate((command) => window.__jw.calls.filter(c => c.cmd === command).length >= 6, command)
      && !await pendingGoogle.locator("body").innerText().then(t => t.includes("La consulta sigue en curso")));
    await pendingGoogle.evaluate((mode) => {
      window.__jw[mode] = "ok";
      const [id, run] = [...window.__jw.retries][0]; window.clearTimeout(id); run();
    }, mode);
    await pendingGoogle.waitForFunction(() => window.__jw.retries.size === 0);
    check(`6D ${command}: recupera el resultado y cancela reintentos`,
      await pendingGoogle.evaluate((command) => window.__jw.calls.filter(c => c.cmd === command).length >= 7, command));
    await pendingGoogle.close();
  }

  const failure = await open({ failMail: true });
  await failure.locator('.widget[data-id="mail"] button').click();
  check("fallo inicial muestra estado recuperable", await failure.locator('.cloud-note[data-kind="other"]').count() === 1);
  await failure.close();

  // JW-21/25: IPC ficticio; nunca cambia energía ni abre Configuración u OMEN.
  for (const edge of ["top", "bottom", "left", "right"]) {
    const view = await open({ edge, geometry: true });
    const reads = () => view.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "power_mode").length);
    const writes = () => view.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "power_set").length);
    check(`JW-21 sin lectura de energía al arrancar (${edge})`, await reads() === 0);
    check(`JW-25 sin cambios al arrancar (${edge})`, await writes() === 0);
    await view.locator('.widget[data-id="system"] button').click();
    const panel = view.getByRole("region", { name: "Sistema", exact: true });
    const balanced = panel.getByRole("button", { name: "Equilibrado", exact: true });
    await balanced.waitFor();
    check(`JW-21 modo actual resaltado y lectura única (${edge})`, await reads() === 1 && await balanced.getAttribute("aria-current") === "true");
    check(`JW-25 estadísticas e indicaciones conservadas (${edge})`, await panel.locator("[data-stat]").count() === 5 && await panel.getByText("Cambia el modo para la alimentación actual. Windows puede priorizar otras señales.", { exact: true }).count() === 1 && await panel.getByText("Se ajusta en OMEN Gaming Hub", { exact: true }).count() === 1);
    for (const name of ["Mejor eficiencia energética", "Equilibrado", "Mejor rendimiento"]) {
      await panel.getByRole("button", { name, exact: true }).click();
      await panel.getByRole("button", { name, exact: true }).and(panel.locator('[aria-current="true"]')).waitFor();
    }
    check(`JW-25 tres botones envían enum fijo y actualizan resaltado (${edge})`, await view.evaluate(() => {
      const calls = window.__jw.calls.filter((c) => c.cmd === "power_set");
      return JSON.stringify(calls.map((c) => c.args)) === '[{"mode":"efficiency"},{"mode":"balanced"},{"mode":"performance"}]' && !window.__jw.calls.some((c) => c.cmd === "power_open");
    }));
    await view.evaluate(() => { window.__jw.powerSetResult = "balanced"; window.__jw.powerSetDeferred = true; });
    await panel.getByRole("button", { name: "Mejor rendimiento", exact: true }).click();
    check(`JW-25 bloquea los tres botones durante cambio (${edge})`, await panel.locator(".power-actions").first().locator("button:disabled").count() === 3);
    await view.evaluate(() => { window.__jw.powerSetDeferred = false; window.__jw.powerSetResolve(); });
    await balanced.and(panel.locator('[aria-current="true"]')).waitFor();
    check(`JW-25 resalta la lectura devuelta y no el modo solicitado (${edge})`, await balanced.getAttribute("aria-current") === "true");
    await view.evaluate(() => { window.__jw.powerSetResult = null; });
    for (const message of ["No se pudo cambiar el modo de energía (código de Windows 5)", "Esta versión de Windows no dispone de la API para cambiar el modo de energía"]) {
      const before = await view.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "power_open").length);
      await view.evaluate((message) => { window.__jw.powerSetError = message; }, message);
      await panel.getByRole("button", { name: "Mejor rendimiento", exact: true }).click();
      await panel.getByRole("alert").filter({ hasText: message }).waitFor();
      check(`JW-25 fallo visible y Configuración de respaldo: ${message} (${edge})`, await panel.getByRole("alert").innerText() === message && await balanced.getAttribute("aria-current") === "true" && await view.evaluate((before) => {
        const calls = window.__jw.calls.filter((c) => c.cmd === "power_open");
        return calls.length === before + 1 && JSON.stringify(calls.at(-1).args) === '{"target":"settings"}';
      }, before));
    }
    await shot(view, `power-${edge}-setter-error.png`);
    await view.evaluate(() => { window.__jw.powerOpenError = "No se pudo abrir Configuración de Windows"; });
    await balanced.click();
    await panel.getByRole("alert").filter({ hasText: "No se pudo abrir Configuración de Windows" }).waitFor();
    check(`JW-25 conserva ambos errores si falla el respaldo (${edge})`, (await panel.getByRole("alert").innerText()).includes("Esta versión de Windows no dispone de la API"));
    await view.evaluate(() => { window.__jw.powerSetError = null; });
    const powerOpens = await view.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "power_open").length);
    await view.evaluate(() => { window.__jw.powerSetError = "Se solicitó el cambio, pero no se pudo actualizar el modo efectivo: prueba"; });
    await balanced.click();
    await panel.getByRole("alert").filter({ hasText: "Se solicitó el cambio" }).waitFor();
    check(`JW-25 relectura fallida muestra error sin abrir Configuración (${edge})`, await view.evaluate((before) => window.__jw.calls.filter((c) => c.cmd === "power_open").length === before, powerOpens));
    await view.evaluate(() => { window.__jw.powerSetError = null; });
    await view.evaluate(() => { window.__jw.powerOpenError = "OMEN Gaming Hub no está instalado"; });
    await panel.getByRole("button", { name: "Ventilador al máximo", exact: true }).click();
    await panel.getByRole("alert").waitFor();
    check(`JW-21 OMEN fijo y error visible (${edge})`, await panel.getByRole("alert").innerText() === "OMEN Gaming Hub no está instalado" && await view.evaluate(() => JSON.stringify(window.__jw.calls.filter((c) => c.cmd === "power_open").at(-1).args) === '{"target":"omen"}'));
    check(`JW-21 error dentro del panel visible (${edge})`, await panel.getByRole("alert").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const p = el.closest(".panel-view").getBoundingClientRect();
      return r.top >= p.top && r.bottom <= p.bottom && r.left >= p.left && r.right <= p.right;
    }));
    await shot(view, `power-${edge}-error.png`);
    await view.evaluate(() => { window.__jw.powerOpenError = null; });
    await balanced.click();
    await balanced.and(panel.locator(":enabled")).waitFor();
    check(`JW-21 error se limpia al reintentar (${edge})`, await panel.getByRole("alert").count() === 0);
    const changes = await writes();
    await view.evaluate(() => { for (const { fn, ms } of window.__jw.polls.values()) if (ms === 2000) fn(); });
    await settle(view);
    check(`JW-21 sondeo de estadísticas no relee energía (${edge})`, await reads() === 1);
    check(`JW-25 sondeo de estadísticas no cambia energía (${edge})`, await writes() === changes);
    check(`JW-21 controles sin desborde horizontal (${edge})`, await panel.locator(".system-body").evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    await panel.getByRole("button", { name: "Cerrar", exact: true }).click();
    await view.evaluate(() => { window.__jw.powerMode = "performance"; });
    await view.locator('.widget[data-id="system"] button').click();
    await panel.getByRole("button", { name: "Mejor rendimiento", exact: true }).waitFor();
    check(`JW-21 reapertura refresca modo (${edge})`, await reads() === 2 && await panel.getByRole("button", { name: "Mejor rendimiento", exact: true }).getAttribute("aria-current") === "true");
    for (const [mode, label] of [["efficiency", "Mejor eficiencia energética"], ["unknown", "Desconocido"]]) {
      await panel.getByRole("button", { name: "Cerrar", exact: true }).click();
      await view.evaluate((mode) => { window.__jw.powerMode = mode; }, mode);
      await view.locator('.widget[data-id="system"] button').click();
      await panel.getByText(`Modo efectivo: ${label}`, { exact: true }).waitFor();
      check(`JW-21 estado ${mode} (${edge})`, await panel.locator('[aria-current="true"]').count() === (mode === "unknown" ? 0 : 1));
    }
    await panel.getByRole("button", { name: "Cerrar", exact: true }).click();
    await view.evaluate(() => { window.__jw.powerModeError = "No se recibió el modo de energía a tiempo"; });
    await view.locator('.widget[data-id="system"] button').click();
    await panel.getByRole("alert").waitFor();
    check(`JW-21 error de lectura visible y modo desconocido (${edge})`, await panel.getByRole("alert").innerText() === "No se recibió el modo de energía a tiempo" && await panel.getByText("Modo efectivo: Desconocido", { exact: true }).count() === 1 && await panel.locator('[aria-current="true"]').count() === 0);
    check(`JW-25 los tres modos siguen habilitados tras fallo de lectura (${edge})`, await panel.locator(".power-actions").first().locator("button:enabled").count() === 3);
    await view.close();
  }

  for (const edge of ["top", "bottom", "left", "right"]) {
    const view = await open({ style: "aurora", mode: "expanded", edge });
    const fit = await view.locator(".widget-trigger").evaluateAll((buttons) => buttons.every((b) => { const r = b.getBoundingClientRect(); const p = b.closest(".island").getBoundingClientRect(); return r.width > 20 && r.height > 20 && r.left >= p.left && r.right <= p.right + 1 && r.top >= p.top && r.bottom <= p.bottom + 1; }));
    check(`Aurora expandida: botones dentro de la isla (${edge})`, fit);
    check(`resumen del sistema sin consultas adicionales (${edge})`, await view.locator('.widget[data-id="system"] .tile-sub').textContent() === "CPU 5 %");
    if (edge === "top") await shot(view, "aurora-expanded.png");
    await view.locator('.widget[data-id="mail"] button').click();
    await view.locator('[data-mail]').waitFor();
    if (edge === "top") await shot(view, "aurora-mail.png");
    await view.emulateMedia({ reducedMotion: "reduce", contrast: "more" });
    check(`contraste alto sin desenfoque (${edge})`, await view.locator(".island").evaluate((e) => getComputedStyle(e).backdropFilter === "none"));
    check(`movimiento reducido sin animación (${edge})`, await view.locator(".panel-view").evaluate((e) => getComputedStyle(e).animationName === "none"));
    await view.close();
  }
  for (const [name, style, color] of [["black", "classic", "black"], ["midnight", "classic", "royal"], ["neon", "aurora", "black"]]) {
    const view = await open({ style, color, mode: "expanded" });
    check(`${name}: conserva reloj, colores e IA`, await view.locator('.widget[data-id="clock"] .time-lg').count() === 1 && await view.locator('.widget[data-id="claude"] .ai-mark').count() === 1 && await view.locator('.widget-trigger').count() === 10);
    await shot(view, `${name}-expanded.png`);
    await view.locator('.widget[data-id="claude"] button').click();
    check(`${name}: cinco lanzadores de IA accesibles`, await view.locator('[data-launch]').count() === 5);
    await shot(view, `${name}-ai.png`);
    await view.close();
  }
  const settings = await open({ label: "settings", style: "aurora" });
  check("Ajustes: tres estilos independientes", await settings.getByRole("radiogroup", { name: "Estilo de la barra", exact: true }).getByRole("radio").count() === 3);
  await settings.getByText("Pizarra", { exact: true }).click();
  check("Pizarra guarda ambos campos en una llamada", await settings.evaluate(() => window.__jw.settings.barStyle === "classic" && window.__jw.settings.islandColor === "royal"));
  check("Pizarra aparece en vista previa", await settings.locator(".appearance-sample").evaluate((e) => getComputedStyle(e).backgroundColor === "rgb(22, 26, 32)"));
  await settings.getByText("Aurora neón", { exact: true }).click();
  for (const [name, key] of [["Violeta", "violet"], ["Cian y verde", "cyan"], ["Ámbar", "amber"]]) {
    await settings.getByText(name, { exact: true }).click();
    check(`Aurora guarda acento ${name}`, await settings.evaluate((key) => window.__jw.settings.auroraAccent === key && document.documentElement.dataset.aurora === key, key));
  }
  await settings.getByText("Negro", { exact: true }).click();
  check("Negro restaura el acabado original", await settings.evaluate(() => window.__jw.settings.barStyle === "classic" && window.__jw.settings.islandColor === "black"));
  await settings.close();

  // JW-22: medir cada fotograma, incluido el cambio de ventana a los 460 ms.
  for (const edge of ["left", "right", "top", "bottom"]) {
    for (const offset of [0.05, 0.95]) {
      const view = await open({ edge, offset, mode: "expanded", geometry: true });
      await view.waitForFunction(() => document.querySelector(".stage").style.getPropertyValue("--track-height") === "1016px");
      await view.waitForTimeout(300);
      for (const action of ["Compactar", "Expandir"]) {
        await view.evaluate(() => {
          window.__jw.morphFrames = [];
          const start = performance.now();
          const sample = () => {
            const el = document.querySelector(".island");
            const r = el.getBoundingClientRect();
            const vertical = el.classList.contains("v");
            const length = vertical ? 1016 : 1904;
            const windowLength = vertical ? innerHeight : innerWidth;
            const size = (vertical ? r.height : r.width) + 8;
            const center = length * window.__jw.settings.barOffsets[window.__jw.settings.edge];
            const origin = (span) => 8 + Math.round(Math.max(0, Math.min(length - span, center - span / 2)));
            const actual = origin(windowLength) + (vertical ? r.y + r.height / 2 : r.x + r.width / 2);
            const expected = origin(size) + size / 2;
            window.__jw.morphFrames.push({ at: performance.now() - start, actual, expected, windowLength, size, opacity: getComputedStyle(el).opacity });
            if (performance.now() - start < 650) requestAnimationFrame(sample);
          };
          sample();
        });
        await view.getByRole("button", { name: action, exact: true }).click();
        await view.waitForTimeout(700);
        const frames = await view.evaluate(() => window.__jw.morphFrames);
        const endpoints = [frames[0].actual, frames.at(-1).actual];
        const stable = frames.length > 10 && frames.every((f) => Math.abs(f.actual - f.expected) <= 1 && f.opacity === "1" && f.actual >= Math.min(...endpoints) - 1 && f.actual <= Math.max(...endpoints) + 1);
        check(`JW-22 ${edge}/${offset}/${action}: centro continuo antes y después del resize, sin parpadeo`, stable);
        await writeFile(resolve(evidence, `morph-${edge}-${offset}-${action === "Compactar" ? "collapse" : "expand"}.json`), JSON.stringify(frames, null, 2));
      }
      await view.close();
    }
  }

  // JW-15-02: ventanas y datos ficticios. Conservar las 45+22+44 comprobaciones previas.
  for (const [name, style, color] of [["black", "classic", "black"], ["midnight", "classic", "royal"], ["neon", "aurora", "black"]]) {
    for (const edge of ["top", "left", "bottom", "right"]) {
      for (const mode of ["compact", "expanded"]) {
        const tag = `${name}/${edge}/${mode}`;
        const view = await open({ style, color, edge, mode, geometry: true });
        const minimize = view.getByRole("button", { name: "Minimizar JarWis", exact: true });
        presenceCheck(`${tag}: botón accesible y título`, await minimize.count() === 1 && await minimize.getAttribute("title") === "Minimizar JarWis");
        await view.waitForTimeout(300);
        presenceCheck(`${tag}: controles dentro de la isla`, await view.locator(".island").evaluate((el) => {
          const p = el.getBoundingClientRect();
          return [...el.querySelectorAll(".widget-trigger, .icon-btn")].every((b) => {
            const r = b.getBoundingClientRect();
            return r.left >= p.left && r.right <= p.right + 1 && r.top >= p.top && r.bottom <= p.bottom + 1;
          });
        }));
        await view.evaluate(() => { window.__jw.beforePolls = [...window.__jw.polls.keys()]; });
        await minimize.click();
        const pill = view.getByRole("button", { name: "Restaurar JarWis", exact: true });
        await pill.waitFor();
        await view.waitForFunction(() => innerWidth === (window.__jw.settings.edge === "left" || window.__jw.settings.edge === "right" ? 60 : 148));
        await view.locator(".island").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {}))));
        presenceCheck(`${tag}: minimizar llama set_minimized(true) una vez`, await view.evaluate(() => {
          const calls = window.__jw.calls.filter((c) => c.cmd === "set_minimized");
          return calls.length === 1 && calls[0].args.minimized === true;
        }));
        presenceCheck(`${tag}: pastilla única, tamaño exacto y sin recortes`, await pill.count() === 1 && await view.locator(".island").evaluate((el) => {
          const r = el.getBoundingClientRect();
          const vertical = el.classList.contains("v");
          const fits = r.width === (vertical ? 52 : 140) && r.height === (vertical ? 116 : 52) && r.left === 4 && r.top === 4 && r.right === innerWidth - 4 && r.bottom === innerHeight - 4 && el.querySelectorAll("button").length === 1;
          if (!fits) throw new Error(`Geometría Mini: ${JSON.stringify({ rect: r.toJSON(), width: innerWidth, height: innerHeight, buttons: el.querySelectorAll("button").length })}`);
          return fits;
        }));
        presenceCheck(`${tag}: sondeos siguen montados`, await view.evaluate(() => {
          const state = window.__jw;
          return JSON.stringify([...state.polls.keys()]) === JSON.stringify(state.beforePolls) && state.polls.size === 3;
        }));
        await pill.hover();
        presenceCheck(`${tag}: hover mantiene Mini`, await view.locator(".island.mini").count() === 1);
        if (mode === "compact" && ["top", "left"].includes(edge)) {
          // Captura de toda la ventana ficticia, incluidos los 4 px transparentes.
          await view.mouse.move(0, 0);
          if (process.env.AUDIT_SCREENSHOTS !== "0") await view.screenshot({ path: resolve(evidence, `${name}-mini-${edge === "top" ? "horizontal" : "vertical"}.png`), omitBackground: true });
        }
        const method = edge === "top" ? "Enter" : edge === "left" ? "Space" : "clic";
        if (method === "clic") await pill.click();
        else { await pill.focus(); await view.keyboard.press(method); }
        await minimize.waitFor();
        presenceCheck(`${tag}: ${method} restaura los diez widgets en compacto`, await view.locator(".widget-trigger").count() === 10 && await view.locator(".island.compact").count() === 1 && await view.evaluate(() => !window.__jw.settings.minimized && window.__jw.settings.mode === "compact" && window.__jw.calls.filter((c) => c.cmd === "set_minimized" && c.args.minimized === false).length === 1));
        if (method !== "clic") presenceCheck(`${tag}: teclado devuelve foco a Minimizar`, await minimize.evaluate((e) => e === document.activeElement && e.matches(":focus-visible") && getComputedStyle(e).outlineStyle !== "none"));
        presenceTimings.push(await view.evaluate((tag) => ({ tag, animations: window.__jw.animations, resizes: window.__jw.resizeTrace, commands: window.__jw.calls.filter((c) => c.cmd === "set_minimized") }), tag));
        await view.close();
      }
    }
  }

  const miniView = await open({ minimized: true, geometry: true, mode: "expanded" });
  const pill = miniView.getByRole("button", { name: "Restaurar JarWis", exact: true });
  await miniView.waitForTimeout(180);
  for (const distance of [5, 12]) {
    await miniView.mouse.move(20, 18);
    await miniView.mouse.down();
    await miniView.mouse.move(20 + distance, 18);
    await miniView.mouse.up();
    await settle(miniView);
  }
  presenceCheck("arrastres de 5/12 px llaman bar_drag y nunca restauran", await miniView.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "bar_drag").length === 2 && !window.__jw.calls.some((c) => c.cmd === "set_minimized")) && await pill.isVisible());
  await pill.click({ button: "right" });
  presenceCheck("clic derecho abre bar_menu sin restaurar", await miniView.evaluate(() => window.__jw.calls.filter((c) => c.cmd === "bar_menu").length === 1 && !window.__jw.calls.some((c) => c.cmd === "set_minimized")));
  await pill.focus();
  await miniView.keyboard.press("Tab");
  await miniView.keyboard.press("Shift+Tab");
  presenceCheck("pastilla tiene foco visible interior", await pill.evaluate((e) => e.matches(":focus-visible") && getComputedStyle(e).outlineStyle === "solid" && getComputedStyle(e).outlineOffset === "-3px"));
  await miniView.evaluate(async () => {
    const state = window.__jw;
    state.beforeCalls = state.calls.length;
    await Promise.all([...state.polls.values()].map((p) => p.fn()));
  });
  await settle(miniView);
  presenceCheck("correo, agenda y sistema consultan desde Mini", await miniView.evaluate(() => ["cloud_mail", "cloud_agenda", "system_snapshot"].every((cmd) => window.__jw.calls.slice(window.__jw.beforeCalls).some((c) => c.cmd === cmd))));
  await miniView.evaluate(() => window.__jw.emit("panel-shortcut", "clipboard"));
  await miniView.getByRole("searchbox", { name: "Buscar en el portapapeles" }).waitFor();
  presenceCheck("evento Ctrl+Alt+C abre Portapapeles desde Mini", await miniView.locator(".island.panel").count() === 1 && await miniView.evaluate(() => window.__jw.settings.minimized && innerWidth === 720));
  await miniView.keyboard.press("Escape");
  await pill.waitFor();
  await miniView.waitForFunction(() => innerWidth === 148);
  presenceCheck("cerrar Portapapeles vuelve a Mini y a su foco", await pill.evaluate((e) => e === document.activeElement) && await miniView.evaluate(() => window.__jw.settings.minimized));
  await miniView.evaluate(() => window.__jw.emit("panel-shortcut", "clipboard"));
  await miniView.getByRole("searchbox").waitFor();
  await miniView.evaluate(() => window.__jw.emit("panel-shortcut", "clipboard"));
  await pill.waitFor();
  presenceCheck("segunda pulsación del atajo también cierra hacia Mini", await miniView.locator(".island.mini").count() === 1);
  await miniView.evaluate(() => window.__jw.setClock({ timers: [], alerts: [{ id: 1, kind: "alarm", label: "Alarma ficticia" }] }));
  await miniView.getByRole("button", { name: "Detener", exact: true }).waitFor();
  presenceCheck("alarma en Mini muestra Detener y Posponer", await miniView.getByRole("button", { name: "Posponer 5 min" }).isVisible() && await miniView.locator(".island.expanded").count() === 1);
  await miniView.evaluate(() => window.__jw.emit("panel-shortcut", "clipboard"));
  await miniView.getByRole("searchbox").waitFor();
  presenceCheck("panel abierto tiene prioridad sobre aviso y Mini", await miniView.locator(".island.panel").count() === 1 && await miniView.getByRole("button", { name: "Detener", exact: true }).count() === 0);
  await miniView.keyboard.press("Escape");
  await miniView.getByRole("button", { name: "Detener", exact: true }).waitFor();
  await miniView.getByRole("button", { name: "Detener", exact: true }).click();
  await pill.waitFor();
  presenceCheck("Detener vuelve a la pastilla sin perder mínimo", await miniView.evaluate(() => window.__jw.settings.minimized && window.__jw.calls.some((c) => c.cmd === "alert_dismiss" && c.args.snooze === false)));
  await miniView.evaluate(() => window.__jw.setClock({ timers: [], alerts: [{ id: 3, kind: "alarm", label: "Alarma ficticia" }] }));
  await miniView.getByRole("button", { name: "Posponer 5 min" }).click();
  await pill.waitFor();
  presenceCheck("Posponer vuelve a Mini y envía snooze", await miniView.evaluate(() => window.__jw.calls.some((c) => c.cmd === "alert_dismiss" && c.args.snooze === true)));
  await miniView.evaluate(() => window.__jw.setClock({ timers: [{ id: 2, label: "Ficticio", remainingMs: 60000, running: true }], alerts: [] }));
  await miniView.locator(".mini-running").waitFor();
  presenceCheck("temporizador muestra punto estático con descripción accesible", await pill.getAttribute("aria-describedby") === "mini-running" && await miniView.locator(".mini-running").evaluate((e) => getComputedStyle(e).animationName === "none"));
  await miniView.emulateMedia({ reducedMotion: "reduce", contrast: "more", forcedColors: "active" });
  await pill.press("Tab");
  await miniView.keyboard.press("Shift+Tab");
  presenceCheck("Mini respeta colores forzados sin borde y conserva foco", await miniView.locator(".island").evaluate((e) => getComputedStyle(e).backgroundImage === "none" && getComputedStyle(e).borderTopWidth === "0px") && await pill.evaluate((e) => e.matches(":focus-visible") && getComputedStyle(e).outlineStyle === "solid" && getComputedStyle(e).color === getComputedStyle(e.parentElement).color));
  await miniView.evaluate(() => { window.__jw.deferRestore = true; });
  await pill.press("Enter");
  await miniView.waitForFunction(() => typeof window.__jw.restoreResolve === "function");
  presenceCheck("restaurar espera al núcleo antes de dibujar módulos", await pill.isVisible() && await miniView.locator(".widget-trigger").count() === 0);
  await miniView.evaluate(() => window.__jw.restoreResolve());
  await miniView.locator('[data-action="minimize"]').waitFor();
  presenceCheck("reduced-motion restaura sin animación", await miniView.locator(".island").evaluate((e) => e.getAnimations({ subtree: true }).every((a) => a.playState !== "running")));
  await miniView.locator('[data-action="minimize"]').click();
  await pill.waitFor();
  presenceCheck("reduced-motion minimiza sin animación", await miniView.locator(".island").evaluate((e) => e.getAnimations({ subtree: true }).every((a) => a.playState !== "running")));
  await miniView.close();

  const gestures = await open({ minimized: true });
  await gestures.waitForTimeout(160);
  const bounds = await gestures.locator(".mini-trigger").boundingBox();
  await gestures.mouse.move(bounds.x + 12, bounds.y + 12);
  await gestures.mouse.down();
  await gestures.mouse.move(bounds.x + 16, bounds.y + 12);
  await gestures.mouse.up();
  await gestures.locator('[data-action="minimize"]').waitFor();
  presenceCheck("movimiento de 4 px restaura sin arrastrar", await gestures.evaluate(() => !window.__jw.calls.some((c) => c.cmd === "bar_drag") && window.__jw.calls.filter((c) => c.cmd === "set_minimized" && !c.args.minimized).length === 1));
  await gestures.locator('[data-action="minimize"]').click();
  await gestures.locator(".mini-trigger").waitFor();
  const secondBounds = await gestures.locator(".mini-trigger").boundingBox();
  await gestures.mouse.move(secondBounds.x + 10, secondBounds.y + 10);
  await gestures.mouse.down();
  await gestures.locator(".mini-trigger").dispatchEvent("pointercancel", { pointerId: 1 });
  await gestures.mouse.up();
  await gestures.mouse.move(secondBounds.x + 25, secondBounds.y + 10);
  presenceCheck("cancelar y mover sin pulsar no arrastra ni restaura", await gestures.locator(".mini-trigger").count() === 1 && await gestures.evaluate(() => !window.__jw.calls.some((c) => c.cmd === "bar_drag") && window.__jw.calls.filter((c) => c.cmd === "set_minimized" && !c.args.minimized).length === 1));
  await gestures.close();

  const interrupted = await open();
  await interrupted.evaluate(() => {
    document.querySelector('[data-action="minimize"]').click();
    document.querySelector('.widget[data-id="mail"] button').click();
  });
  await interrupted.locator("[data-mail]").waitFor();
  await interrupted.waitForTimeout(180);
  presenceCheck("abrir un módulo interrumpe la salida hacia Mini", await interrupted.evaluate(() => !window.__jw.calls.some((c) => c.cmd === "set_minimized")) && await interrupted.locator(".island.panel").evaluate((e) => getComputedStyle(e).opacity === "1"));
  await interrupted.close();

  const rejected = await open({ minimized: true });
  await rejected.evaluate(() => { window.__jw.failMinimize = true; });
  await rejected.getByRole("button", { name: "Restaurar JarWis" }).press("Enter");
  await rejected.locator('[aria-label="Error de la acción"]').waitFor();
  presenceCheck("error de restauración visible desde Mini", await rejected.getByRole("alert").isVisible());
  await rejected.getByRole("button", { name: "Volver", exact: true }).click();
  await rejected.locator(".mini-trigger").waitFor();
  presenceCheck("descartar error recupera Mini", await rejected.locator(".island.mini").count() === 1);
  await rejected.close();

  // JW-15-04: con la forma nueva antes que la ventana, la isla no se ve (sin recuadro).
  for (const edge of ["top", "left"]) {
    const late = await open({ edge, geometry: true });
    await late.waitForTimeout(200);
    await late.evaluate(() => { window.__jw.lateResize = true; });
    await late.locator('[data-action="minimize"]').click();
    await late.locator(".island.mini").waitFor();
    presenceCheck(`${edge}: Mini invisible en la ventana vieja`, await late.evaluate(() => innerWidth !== (window.__jw.settings.edge === "left" ? 60 : 148) && getComputedStyle(document.querySelector(".island")).opacity === "0"));
    await late.evaluate(() => window.__jw.lateResizeResolve());
    await late.waitForFunction(() => innerWidth === (window.__jw.settings.edge === "left" ? 60 : 148));
    await late.waitForFunction(() => getComputedStyle(document.querySelector(".island")).opacity === "1");
    presenceCheck(`${edge}: Mini visible con la ventana final`, true);
    await late.locator(".mini-trigger").click();
    presenceCheck(`${edge}: la pastilla se oculta al pulsar`, await late.evaluate(() => getComputedStyle(document.querySelector(".island")).opacity === "0"));
    await late.locator(".island.compact").waitFor();
    presenceCheck(`${edge}: Compact invisible en la ventana Mini`, await late.evaluate(() => innerWidth !== (window.__jw.settings.edge === "left" ? 52 : 340) && getComputedStyle(document.querySelector(".island")).opacity === "0"));
    await late.evaluate(() => window.__jw.lateResizeResolve());
    await late.waitForFunction(() => innerWidth === (window.__jw.settings.edge === "left" ? 52 : 340) && getComputedStyle(document.querySelector(".island")).opacity === "1");
    presenceCheck(`${edge}: Compact visible con la ventana final`, true);
    await late.close();
  }

  // La ventana todavía grande conserva el punto que ocupará Mini tras el relayout.
  // JW-15-03b: la isla Mini queda pegada al borde y centrada a lo largo en cualquier ventana (incluida la unión).
  for (const edge of ["top", "bottom", "left", "right"]) {
    const vertical = edge === "left" || edge === "right";
    const centerView = await open({ minimized: true, edge, geometry: true });
    for (const size of vertical ? [{ width: 60, height: 124 }, { width: 60, height: 328 }, { width: 340, height: 520 }] : [{ width: 148, height: 60 }, { width: 340, height: 60 }, { width: 1000, height: 300 }]) {
      await centerView.setViewportSize(size);
      await settle(centerView);
      presenceCheck(`${edge}: Mini pegada al borde y centrada en ${size.width}x${size.height}`, await centerView.locator(".island").evaluate((el, edge) => {
        const r = el.getBoundingClientRect();
        const flush = { top: r.top === 4, bottom: innerHeight - r.bottom === 4, left: r.left === 4, right: innerWidth - r.right === 4 }[edge];
        const centered = ["top", "bottom"].includes(edge) ? Math.abs(r.left - (innerWidth - r.right)) < 1 : Math.abs(r.top - (innerHeight - r.bottom)) < 1;
        return flush && centered && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      }, edge));
    }
    await centerView.close();
  }

  // JW-15-03b: mascota en la pastilla, texto JW fuera, selector en Ajustes y balanceo ocasional.
  for (const mascot of ["air", "fire", "water", "earth"]) {
    for (const edge of ["top", "left"]) {
      const o = edge === "top" ? "h" : "v";
      const mv = await open({ minimized: true, edge, mascot, codexPetIcon: "dragon", geometry: true, style: mascot === "fire" ? "aurora" : "classic" });
      const art = mv.locator(".mini-trigger img");
      presenceCheck(`mascota ${mascot}/${o}: imagen correcta, cargada y sin texto JW`, await art.count() === 1 && (await art.getAttribute("src")).includes(`${mascot}-${o}`) && await art.evaluate((i) => i.complete && i.naturalWidth === (i.src.includes("-h") ? 280 : 104) && i.getAttribute("alt") === "" && i.getAttribute("aria-hidden") === "true") && !(await mv.locator(".island").innerText()).includes("JW"));
      presenceCheck(`mascota ${mascot}/${o}: nombre accesible y boton unico`, await mv.getByRole("button", { name: "Restaurar JarWis", exact: true }).count() === 1 && await mv.locator("button").count() === 1);
      presenceCheck(`mascota ${mascot}/${o}: sin fondo negro detras`, await mv.locator(".island").evaluate((e) => { const c = getComputedStyle(e); return c.backgroundColor === "rgba(0, 0, 0, 0)" && c.backgroundImage === "none"; }));
      await mv.mouse.move(0, 0);
      await settle(mv);
      if (process.env.AUDIT_SCREENSHOTS !== "0") await mv.screenshot({ path: resolve(evidence, `mascot-${mascot}-${o === "h" ? "horizontal" : "vertical"}.png`), omitBackground: true });
      if (mascot === "air") {
        await mv.evaluate(() => { window.__jw.settings.mascot = "water"; window.__jw.emit("settings-changed", structuredClone(window.__jw.settings)); });
        await mv.waitForFunction((o) => document.querySelector(".mini-trigger img").src.includes(`water-${o}`), o);
        presenceCheck(`mascota ${o}: cambia en vivo`, true);
      }
      await mv.close();
    }
  }
  const rotated = await open({ minimized: true, edge: "top", geometry: true });
  await rotated.evaluate(() => { window.__jw.settings.edge = "left"; window.__jw.emit("settings-changed", structuredClone(window.__jw.settings)); });
  await rotated.waitForFunction(() => document.querySelector(".mini-trigger img").src.includes("air-v"));
  presenceCheck("al cambiar de borde la pastilla usa la imagen vertical", true);
  await rotated.close();

  for (const reduced of ["no-preference", "reduce"]) {
    const sway = await open({ minimized: true, geometry: true, reducedMotion: reduced });
    await sway.waitForTimeout(8900);
    const swayed = await sway.evaluate(() => window.__jw.animations.filter((a) => a.shape === "mascot-art" && a.duration === 600).length);
    presenceCheck(reduced === "reduce" ? "prefers-reduced-motion: sin balanceo" : "balanceo ocasional de 600 ms con setTimeout", reduced === "reduce" ? swayed === 0 : swayed === 1);
    presenceCheck(`${reduced}: sin animacion CSS infinita en la mascota`, await sway.locator(".mascot-art").evaluate((e) => getComputedStyle(e).animationName === "none"));
    await sway.close();
  }

  const pick = await open({ label: "settings" });
  const group = pick.getByRole("radiogroup", { name: "Mascota", exact: true });
  presenceCheck("Ajustes: selector Mascota con 4 opciones y Aire marcada", await group.getByRole("radio").count() === 4 && await group.getByRole("radio", { name: "Aire" }).isChecked());
  await group.getByRole("radio", { name: "Aire" }).focus();
  await pick.keyboard.press("ArrowRight");
  presenceCheck("flecha derecha elige Fuego y guarda mascot", await group.getByRole("radio", { name: "Fuego" }).isChecked() && await pick.evaluate(() => window.__jw.settings.mascot === "fire" && window.__jw.calls.some((c) => c.cmd === "patch_settings" && c.args.patch.mascot === "fire" && Object.keys(c.args.patch).length === 1)));
  await group.getByText("Tierra", { exact: true }).click();
  presenceCheck("clic en Tierra guarda mascot", await pick.evaluate(() => window.__jw.settings.mascot === "earth"));
  await group.getByText("Agua", { exact: true }).click();
  presenceCheck("clic en Agua guarda mascot", await pick.evaluate(() => window.__jw.settings.mascot === "water"));
  await group.getByRole("radio", { name: "Agua" }).focus();
  if (process.env.AUDIT_SCREENSHOTS !== "0") await pick.screenshot({ path: resolve(evidence, "settings-mascot-selector.png") });
  await pick.close();

  const stopwatch = await open();
  await stopwatch.locator('.widget[data-id="clock"] button').click();
  await stopwatch.locator('[data-action="start"]').click();
  await stopwatch.keyboard.press("Escape");
  check("Codex: reloj activo y mascota dejan libres las acciones en compacto", await stopwatch.locator(".island").evaluate((el) => {
    const actions = el.querySelector(".actions").getBoundingClientRect();
    return [...el.querySelectorAll(".widget-trigger, .codex-pet button")].every((button) => button.getBoundingClientRect().right <= actions.left);
  }));
  await stopwatch.locator('[data-action="minimize"]').click();
  await stopwatch.locator(".mini-running").waitFor();
  presenceCheck("cronómetro sigue montado y señala actividad en Mini", await stopwatch.locator(".mini-running").count() === 1);
  await stopwatch.getByRole("button", { name: "Restaurar JarWis" }).click();
  await stopwatch.locator('.widget[data-id="clock"] button').click();
  presenceCheck("cronómetro continúa tras restaurar", await stopwatch.locator('[data-action="pause"]').isVisible());
  await stopwatch.close();

  check("sin excepciones de JavaScript", errors.length === 0);
  presenceCheck("duraciones de presencia de hasta 160 ms", presenceTimings.every((t) => t.animations.filter((a) => a.shape.split(" ").includes("island")).every((a) => a.duration <= 160)));
  presenceCheck("balanceos registrados duran 600 ms", presenceTimings.every((t) => t.animations.filter((a) => a.shape === "mascot-art").every((a) => a.duration === 600)));
  // JW-15-04: la entrada Mini solo empieza con la ventana ya en su tamaño final (sin recuadro).
  presenceCheck("salida anterior al IPC y entrada Mini con la ventana final", presenceTimings.every((t) => {
    const exit = t.animations.find((a) => a.duration === 80 && !a.shape.includes("mini"));
    const entry = t.animations.find((a) => a.shape.includes("mini"));
    const resize = t.resizes.find((r) => r.shape === "mini");
    const vertical = entry?.shape.split(" ").includes("v");
    const ok = exit && entry && resize && t.commands[0].at >= exit.at + 70 &&
      entry.width === (vertical ? 60 : 148) && entry.height === (vertical ? 124 : 60);
    if (!ok) console.log("Tiempos Mini:", JSON.stringify({ tag: t.tag, exit, entry, resize, command: t.commands[0] }));
    return ok;
  }));
  presenceCheck("núcleo ficticio crece antes de la entrada al restaurar", presenceTimings.every((t) => {
    const entry = t.animations.find((a) => !a.shape.includes("mini") && a.duration === 160);
    const resize = t.resizes.find((r) => r.shape !== "mini");
    return entry && resize && entry.at >= resize.at && entry.width === resize.width && entry.height === resize.height;
  }));
  await writeFile(resolve(evidence, "results.json"), JSON.stringify({ date: "2026-10-27", browser: await browser.version(), isolatedIPC: true, checks, contrastNumbers, regressions, inverseRegressions, presenceChecks, presenceTimings, reliabilityChecks, errors }, null, 2));
  console.log(`${presenceChecks.length}/${presenceChecks.length} comprobaciones Mini correctas`);
  console.log(`${checks.length}/${checks.length} comprobaciones correctas`);
  const passed = regressions.filter((r) => r.passed).length;
  console.log(`${passed}/${regressions.length} regresiones JW-14 correctas`);
  const inversePassed = inverseRegressions.filter((r) => r.passed).length;
  console.log(`${inversePassed}/${inverseRegressions.length} regresiones inversas ciclo 3 correctas`);
  assert.equal(passed, regressions.length, "regresiones JW-14");
  assert.equal(inversePassed, inverseRegressions.length, "regresiones inversas ciclo 3");
  const reliabilityPassed = reliabilityChecks.filter((r) => r.passed).length;
  console.log(`${reliabilityPassed}/${reliabilityChecks.length} comprobaciones JW-16 correctas`);
  assert.equal(reliabilityPassed, reliabilityChecks.length, "fiabilidad JW-16");
  }
} finally {
  await context.close();
  await browser.close();
  await new Promise((ok) => server.close(ok));
}
