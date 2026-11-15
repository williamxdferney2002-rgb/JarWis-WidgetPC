// Verificación de la UI de Hoy, Concentración, espacios y Ajustes de la Fase 7 (JW-7-03) por CDP, SOLO con datos simulados.
//   node src-tauri/tests-manual/today-ui.mjs [carpeta-capturas]
// PRIVACIDAD: la barra real mostraría correo, agenda y proyectos reales y Ajustes, tus accesos. El script intercepta
// fetch (`__TAURI_INTERNALS__.invoke` no es escribible), recarga y, ANTES de leer el DOM o capturar, comprueba
// el mock con cloud_mock_ping y las filas centinela «jarwis-prueba»; si no, aborta. El mock nunca rechaza un
// fetch (Tauri reenviaría la orden al backend real). open_focus_settings/open_workspace/patch_settings/
// set_workspaces son ficticios: no se abre nada, no se guarda nada. Reutiliza get_settings real, pero sustituye
// accesos, proyectos, alarmas y espacios por datos ficticios. Nunca usa el portapapeles.
import { pages, connect, click, screenshot, sleep } from "./cdp.mjs";

const shots = process.argv[2];
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`);
};
const byLabel = async (label) => {
  for (const t of (await pages()).filter((t) => t.url.startsWith("http://tauri.localhost"))) {
    const p = await connect(t);
    if ((await p.evaluate("window.__TAURI_INTERNALS__.metadata.currentWindow.label")) === label) return p;
    p.close();
  }
  return null;
};

const mockScript = (mode) => `(() => {
  const mode = ${JSON.stringify(mode)};
  const calls = (window.__jwCalls = []);
  const realFetch = window.fetch.bind(window);
  const now = Date.now();
  const p2 = (n) => String(n).padStart(2, "0");
  const ymd = (d) => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
  const at = (n, h, m) => { const d = day(n); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const mail = { inboxUnread: 100, inboxMore: true, outlookUnread: 3, outlookMore: false, items: [
    { id: "g1", source: "gmail", from: "jarwis-prueba Banco Ficticio", subject: "Asunto ficticio uno", date: now - 120000 } ] };
  // Hoy: 1 evento con hora (23:59) y 1 de todo el día; mañana: otros 2 (no deben contarse).
  const agenda = { events: [
    { id: "e1", title: "jarwis-prueba Reunión hoy", start: at(0, 23, 59), allDay: false },
    { id: "e2", title: "jarwis-prueba Todo el día hoy", start: ymd(day(0)), allDay: true },
    { id: "e3", title: "jarwis-prueba Mañana con hora", start: at(1, 9, 0), allDay: false },
    { id: "e4", title: "jarwis-prueba Mañana todo el día", start: ymd(day(1)), allDay: true } ],
    // Google guarda «due» a las 00:00Z: hoy (cuenta), ayer (vencida, cuenta), mañana y sin fecha (no cuentan).
    tasks: [ { id: "t1", title: "jarwis-prueba Tarea hoy", due: ymd(day(0)) + "T00:00:00.000Z" },
      { id: "t2", title: "jarwis-prueba Tarea vencida", due: ymd(day(-1)) + "T00:00:00.000Z" },
      { id: "t3", title: "jarwis-prueba Tarea mañana", due: ymd(day(1)) + "T00:00:00.000Z" },
      { id: "t4", title: "jarwis-prueba Sin fecha", due: null } ], pendingTasks: 4 };
  const signedOut = { kind: "signedOut", message: "Conecta tu cuenta de Google en Ajustes." };
  const feed = (data) => mode === "empty" ? { data: null, error: signedOut, updatedAt: null } : { data, error: null, updatedAt: now };
  const fakeShortcuts = [ { id: 1, name: "jarwis-prueba uno", kind: "url", target: "https://example.test/" }, { id: 2, name: "jarwis-prueba dos", kind: "url", target: "https://example.test/2" } ];
  const workspaces = mode === "empty" ? [] : [ { id: 1, name: "jarwis-prueba espacio", shortcuts: [1] } ];
  const fake = {
    cloud_mail: () => feed(mail), cloud_agenda: () => feed(agenda),
    cloud_status: () => ({ configured: true, connected: mode !== "empty", loginInProgress: false }),
    cloud_mock_ping: () => "jarwis-prueba",
    open_focus_settings: () => null,
    open_workspace: () => { if (mode === "err") throw "No se pudieron abrir: «jarwis-prueba uno»"; return null; },
    patch_settings: (b) => { window.__jwSaved = window.__jwSettings = { ...window.__jwSettings, ...b.patch }; return window.__jwSaved; },
    set_workspaces: (b) => { window.__jwWs = b.list; return b.list.map((w) => ({ ...w, id: w.id || 99 })); } };
  const patched = async (url, init) => {
    const r = await (await realFetch(url, init)).json();
    return (window.__jwSettings = { ...r, shortcuts: fakeShortcuts, alarms: [], workspaces, notifications: false });
  };
  window.fetch = async (url, init) => {
    const u = String(url);
    const m = u.match(/ipc\\.localhost\\/((?:cloud_|claude_|open_focus_settings|open_workspace|patch_settings|set_workspaces|get_settings)[a-z_]*)/);
    if (!m) return realFetch(url, init);
    const cmd = m[1];
    calls.push(cmd);
    let body = null;
    try { body = JSON.parse(init.body); } catch {}
    (window.__jwArgs = window.__jwArgs || []).push([cmd, body]);
    let res, ok = true;
    try {
      if (cmd === "get_settings") res = await patched(url, init);
      else if (!fake[cmd]) throw "mock";
      else res = fake[cmd](body);
    } catch (e) { res = typeof e === "string" ? e : "mock"; ok = false; }
    return new Response(JSON.stringify(res), { headers: { "Tauri-Response": ok ? "ok" : "error", "content-type": "application/json" } });
  };
})()`;

const mocked = (p) => p.evaluate(`window.__TAURI_INTERNALS__.invoke("cloud_mock_ping").then((v) => v === "jarwis-prueba", () => false)`);
const has = (p, sel) => p.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = (p, sel) => p.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const args = (p, cmd) => p.evaluate(`JSON.stringify((window.__jwArgs || []).filter((a) => a[0] === ${JSON.stringify(cmd)}).map((a) => a[1]))`);
// Filas centinela: el botón de cada espacio empieza por «jarwis-prueba» (booleano; nunca se imprime el texto).
const wsFake = (p) => p.evaluate(`(() => { const r = [...document.querySelectorAll("[data-workspace]")]; return r.length > 0 && r.every((e) => e.textContent.startsWith("jarwis-prueba")); })()`);
const shot = async (p, name, fake) => {
  if (!(await mocked(p)) || !fake) throw new Error(`ABORTADO antes de capturar «${name}»: no se comprobó que los datos fueran ficticios`);
  if (shots) await screenshot(p, `${shots}/JW-7-03-${name}.png`, { r: 128, g: 128, b: 128, a: 1 });
};

const bar = await byLabel("bar");
if (!bar) throw new Error("No se encontró la ventana «bar»: ¿se lanzó la app con --remote-debugging-port?");
await bar.send("Page.enable");

const scripts = new Map();
async function load(page, mode) {
  if (scripts.has(page)) await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scripts.get(page) });
  scripts.set(page, (await page.send("Page.addScriptToEvaluateOnNewDocument", { source: mockScript(mode) })).identifier);
  await page.send("Page.reload");
  await sleep(1500);
  for (let i = 0; i < 20 && !(await has(page, ".island, .settings")); i++) await sleep(250);
  if (!(await mocked(page))) throw new Error(`ABORTADO: el mock «${mode}» no está activo; no se lee ni captura nada por si hubiera datos reales`);
}
const openPanel = async () => {
  await click(bar, '.widget[data-id="today"]');
  for (let i = 0; i < 20 && !(await has(bar, ".panel-view")); i++) await sleep(200);
  await sleep(1200); // deja llegar los sondeos simulados
};
const closePanel = async () => {
  await click(bar, '[data-action="close-panel"]');
  await sleep(500);
};
const card = (id) => text(bar, `[data-today="${id}"] .stat-value`);

try {
  // ---- con datos
  await load(bar, "data");
  check("mock activo (data)", true);
  check("«today» es el último widget", await bar.evaluate(`(() => { const w = [...document.querySelectorAll(".widget")]; return w.length > 0 && w[w.length - 1].dataset.id === "today"; })()`));
  await openPanel();
  check("filas centinela jarwis-prueba (espacios)", await wsFake(bar));
  check("no leídos = 100+3 con «+»", (await card("mail")) === "103+", await card("mail"));
  check("eventos que quedan hoy = 2 (hoy con hora y todo el día; no los de mañana)", (await card("events")) === "2", await card("events"));
  check("tareas hoy o vencidas = 2 (due de hoy a 00:00Z cuenta como hoy)", (await card("tasks")) === "2", await card("tasks"));
  check("resúmenes son botones", await bar.evaluate(`[...document.querySelectorAll("[data-today]")].every((e) => e.tagName === "BUTTON")`));
  await shot(bar, "hoy-datos", await wsFake(bar));
  await click(bar, '[data-action="focus"]');
  await sleep(300);
  check("Concentración → open_focus_settings sin argumentos", ["[null]", "[{}]"].includes(await args(bar, "open_focus_settings")), await args(bar, "open_focus_settings"));
  await click(bar, '[data-workspace="1"]');
  await sleep(300);
  check("espacio → open_workspace solo con {id}", (await args(bar, "open_workspace")) === '[{"id":1}]', await args(bar, "open_workspace"));
  check("sin error visible cuando todo va bien", !(await has(bar, "[data-today-error]")));
  // Los resúmenes abren el panel de origen (Correo o Calendario).
  await click(bar, '[data-today="mail"]');
  await sleep(500);
  check("clic en Correo → panel de correo", await has(bar, '.panel-view[aria-label="Correo"]'), await bar.evaluate(`document.querySelector(".panel-view")?.getAttribute("aria-label")`));
  await closePanel();
  await openPanel();
  await click(bar, '[data-today="tasks"]');
  await sleep(500);
  check("clic en Tareas → panel de calendario", await has(bar, '.panel-view[aria-label="Calendario"]'), await bar.evaluate(`document.querySelector(".panel-view")?.getAttribute("aria-label")`));
  await closePanel();

  // ---- error al abrir el espacio
  await load(bar, "err");
  await openPanel();
  await click(bar, '[data-workspace="1"]');
  await sleep(400);
  check("error de open_workspace visible en español", ((await text(bar, "[data-today-error]")) ?? "").startsWith("No se pudieron abrir"));
  await shot(bar, "hoy-error", await wsFake(bar));
  await closePanel();

  // ---- sin sesión / sin datos / sin espacios
  await load(bar, "empty");
  await openPanel();
  check("sin sesión: correo, eventos y tareas «Sin sesión»", (await card("mail")) === "Sin sesión" && (await card("events")) === "Sin sesión" && (await card("tasks")) === "Sin sesión");
  check("sin espacios: aviso y sin botones de espacio", (await has(bar, '[data-note="no-workspaces"]')) && !(await has(bar, "[data-workspace]")));
  await shot(bar, "hoy-vacio", true);
  await closePanel();

  // ---- Ajustes simulados
  await load(bar, "data");
  await bar.evaluate(`window.__TAURI_INTERNALS__.invoke("open_settings")`);
  await sleep(1800);
  const st = await byLabel("settings");
  if (!st) throw new Error("No se encontró la ventana de Ajustes");
  await st.send("Page.enable");
  await load(st, "data");
  const wsRow = '[data-ws="0"]';
  // Centinelas obligatorios antes de capturar Ajustes (H1 de la auditoría de JW-7-03).
  const sentinel = await st.evaluate(`document.querySelectorAll('${wsRow} [data-ws-item]').length === 2 && document.querySelector('${wsRow} input[aria-label="Nombre del espacio"]').value.startsWith("jarwis-prueba")`);
  check("Ajustes: espacio ficticio con 2 accesos ficticios", sentinel);
  if (!sentinel) throw new Error("Ajustes sin las filas jarwis-prueba: se aborta antes de capturar");
  await st.evaluate(`document.querySelector('input[aria-label="Notificaciones"]').scrollIntoView({ block: "center" })`);
  await sleep(300);
  await click(st, 'input[aria-label="Notificaciones"]');
  await sleep(400);
  check("interruptor Notificaciones → patch_settings con notifications=true", await st.evaluate(`window.__jwSaved?.notifications === true`));
  await st.evaluate(`document.querySelector('${wsRow}').scrollIntoView({ block: "center" })`);
  await sleep(300);
  await shot(st, "ajustes-espacios", true);
  await click(st, `${wsRow} [data-ws-item="2"]`);
  await click(st, '[data-action="ws-save"]');
  await sleep(400);
  check("editor → set_workspaces con {id,name,shortcuts:[1,2]}", (await st.evaluate(`JSON.stringify(window.__jwWs)`)) === '[{"id":1,"name":"jarwis-prueba espacio","shortcuts":[1,2]}]');
  check("editor: confirma «Espacios guardados»", ((await text(st, ".hint.pad[role=status]")) ?? "") === "Espacios guardados");
  await click(st, '[data-action="ws-add"]');
  check("editor: añadir crea un segundo espacio", await has(st, '[data-ws="1"]'));
  await click(st, '[data-ws="1"] [data-action="ws-delete"]');
  check("editor: borrar quita el espacio", !(await has(st, '[data-ws="1"]')));
  check("Ajustes: sin errores de consola", st.logs.length === 0, st.logs.join(" | "));
  await st.evaluate(`document.querySelector('[data-action=close]').scrollIntoView()`);
  await click(st, '[data-action="close"]');
  st.close();
} catch (e) {
  failures++;
  console.log(`FAIL ${e.message}`);
} finally {
  await bar.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scripts.get(bar) }).catch(() => {});
  await bar.send("Page.reload").catch(() => {}); // vuelve a la UI real (sin mock); no se lee su contenido
  console.log(bar.logs.length ? `Consola de la barra: ${bar.logs.length} avisos/errores` : "Consola de la barra: limpia");
  bar.close();
}
console.log(failures ? `\n${failures} fallo(s)` : "\nTodo correcto");
process.exit(failures ? 1 : 0);
