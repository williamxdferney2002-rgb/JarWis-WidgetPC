// Verificación de la UI de Google (JW-4-03) por CDP, SOLO con datos simulados.
//   node src-tauri/tests-manual/cloud-ui.mjs [carpeta-capturas]
// PRIVACIDAD: si hay una sesión real de Google, el DOM real contendría asuntos. Por eso el
// script sustituye todos los cloud_* por un mock (Page.addScriptToEvaluateOnNewDocument),
// recarga y, ANTES de capturar o inspeccionar, comprueba que el mock está activo: si no,
// aborta. Nunca lee texto del DOM (solo booleanos y conteos) ni llama a cloud_login/logout
// reales ni pulsa Conectar/Desconectar. Los remitentes y títulos ficticios empiezan por «jarwis-prueba».
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

/**
 * Script de página: `__TAURI_INTERNALS__.invoke` no se puede sustituir (propiedad no configurable),
 * así que se intercepta `fetch`, por donde sale cada invoke (`http://ipc.localhost/<cmd>`). Los
 * cloud_* ficticios nunca llegan a Rust; se registran las llamadas en `__jwCalls`.
 */
const mockScript = (mode) => `(() => {
  const mode = ${JSON.stringify(mode)};
  const calls = (window.__jwCalls = []);
  const realFetch = window.fetch.bind(window);
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const mail = { inboxUnread: 100, inboxMore: true, outlookUnread: 3, outlookMore: false, items: [
    { id: "g1", source: "gmail", from: "jarwis-prueba Banco Ficticio", subject: "Asunto ficticio uno 🎉📧 con emojis 🚀", date: Date.now() - 120000 },
    { id: "g2", source: "gmail", from: "jarwis-prueba ejemplo.test", subject: "Asunto ficticio dos, algo más largo para comprobar el recorte con puntos suspensivos en la fila", date: Date.now() - 3600000 },
    { id: "o1", source: "outlook", from: "jarwis-prueba Equipo", subject: "Asunto ficticio tres 🔔 " + "muy largo ".repeat(14), date: Date.now() - 600000 },
    { id: "o2", source: "outlook", from: "jarwis-prueba Soporte", subject: "Asunto ficticio cuatro", date: Date.now() - 7200000 } ] };
  const agenda = { events: [
    { id: "e1", title: "jarwis-prueba Reunión ficticia", start: new Date(Date.now() + 3600000).toISOString(), allDay: false },
    { id: "e2", title: "jarwis-prueba Día libre ficticio", start: day(2), allDay: true } ],
    tasks: [ { id: "t1", title: "jarwis-prueba Tarea ficticia 📝 " + "larga ".repeat(25), due: day(1) }, { id: "t2", title: "jarwis-prueba Otra tarea", due: null } ], pendingTasks: 5 };
  const err = {
    signedOut: { kind: "signedOut", message: "Conecta tu cuenta de Google en Ajustes." },
    network: { kind: "network", message: "Sin conexión con Google (renovar token: tiempo de espera agotado). Se muestran los últimos datos." },
    quota: { kind: "quota", message: "Google limitó o rechazó la consulta; se reintentará en unos minutos." } }[mode];
  const feed = (data) => mode === "loading" ? (calls.filter((c) => c === "cloud_mail").length > 1 ? { data, error: null, updatedAt: Date.now() } : { data: null, error: null, updatedAt: null })
    : mode === "signedOut" ? { data: null, error: err, updatedAt: null }
    : err ? { data, error: err, updatedAt: Date.now() - 12 * 60000 } : { data, error: null, updatedAt: Date.now() };
  const fake = {
    cloud_mail: () => feed(mail), cloud_agenda: () => feed(agenda),
    cloud_open: (b) => { window.__jwOpened = [b.kind, b.id]; return null; },
    cloud_status: () => ({ configured: true, connected: mode !== "signedOut", loginInProgress: false }),
    cloud_mock_ping: () => "jarwis-prueba",
    cloud_login: () => { throw "mock"; }, cloud_logout: () => { throw "mock"; } };
  window.fetch = async (url, init) => {
    const u = String(url);
    const cmd = u.includes("ipc.localhost/cloud_") ? u.split("ipc.localhost/")[1].split(/[?#]/)[0] : null;
    if (!cmd) return realFetch(url, init);
    calls.push(cmd);
    let body = null;
    try { body = JSON.parse(init.body); } catch {}
    (window.__jwBodies = window.__jwBodies || []).push(body);
    // El mock nunca rechaza: un fetch rechazado haría que Tauri reenviara la orden al backend real por postMessage.
    let res, ok = true;
    try { if (!fake[cmd]) throw "mock"; res = fake[cmd](body); } catch { res = "mock"; ok = false; }
    return new Response(JSON.stringify(res), { headers: { "Tauri-Response": ok ? "ok" : "error", "content-type": "application/json" } });
  };
})()`;

/** El mock está activo si invoke("cloud_mock_ping") devuelve el centinela (en la app real ese comando no existe). */
const mocked = (p) => p.evaluate(`window.__TAURI_INTERNALS__.invoke("cloud_mock_ping").then((v) => v === "jarwis-prueba", () => false)`);
/** Todas las filas de la lista son ficticias (booleano; nunca el texto). */
const allFake = (p) =>
  p.evaluate(`(() => { const r = [...document.querySelectorAll(".list li button")]; return r.length > 0 && r.every((b) => b.firstElementChild.textContent.startsWith("jarwis-prueba")); })()`);
const rows = (p) => p.evaluate(`document.querySelectorAll(".list li button").length`);
const has = (p, sel) => p.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
const noteKind = (p) => p.evaluate(`document.querySelector(".cloud-note")?.dataset.kind ?? null`);
// Captura solo si el mock sigue activo y lo mostrado es ficticio (`fake`: filas «jarwis-prueba» o, sin datos, ninguna fila); si no, aborta.
const shot = async (p, name, fake) => {
  if (!(await mocked(p)) || !fake) throw new Error(`ABORTADO antes de capturar «${name}»: no se comprobó que los datos fueran ficticios`);
  if (shots) await screenshot(p, `${shots}/JW-4-03-${name}.png`, { r: 128, g: 128, b: 128, a: 1 });
};

const bar = await byLabel("bar");
if (!bar) throw new Error("No se encontró la ventana «bar»: ¿se lanzó la app con --remote-debugging-port?");
await bar.send("Page.enable");

const scripts = new Map();
/** Instala el mock para `mode`, recarga y aborta si no está activo. */
async function load(page, mode) {
  if (scripts.has(page)) await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scripts.get(page) });
  scripts.set(page, (await page.send("Page.addScriptToEvaluateOnNewDocument", { source: mockScript(mode) })).identifier);
  await page.send("Page.reload");
  await sleep(1500);
  for (let i = 0; i < 20 && !(await has(page, ".island")); i++) await sleep(250);
  if (!(await mocked(page))) throw new Error(`ABORTADO: el mock «${mode}» no está activo; no se captura nada por si hubiera datos reales`);
}
const openPanel = async (page, id) => {
  await click(page, `.widget[data-id="${id}"]`);
  for (let i = 0; i < 20 && !(await has(page, ".panel-view")); i++) await sleep(200);
  await sleep(700);
};
const closePanel = async (page) => {
  await click(page, '[data-action="close-panel"]');
  await sleep(500);
};

try {
  // ---- ok: insignia, pestañas, calendario, clic
  await load(bar, "ok");
  check("mock activo (ok)", true);
  check("insignia 99+ (100+3)", await bar.evaluate(`document.querySelector('.widget[data-id="mail"] .badge')?.textContent === "99+"`));
  await openPanel(bar, "mail");
  check("correo: filas ficticias", (await allFake(bar)) && (await rows(bar)) === 4);
  check("pestañas con «100+»", await bar.evaluate(`[...document.querySelectorAll('.tabs [role="tab"]')].map((t) => t.textContent).join("|") === "Todos|Gmail 100+|Outlook 3"`));
  await shot(bar, "mail-ok", await allFake(bar));
  // Botón Actualizar: debe invocar cloud_mail con force:true (el mock registra el cuerpo en __jwBodies).
  await bar.evaluate(`window.__jwCalls.length = 0; window.__jwBodies = []`);
  await click(bar, '[data-action="refresh"]');
  await sleep(500);
  check("botón Actualizar → cloud_mail(force:true)", await bar.evaluate(`window.__jwCalls.includes("cloud_mail") && window.__jwBodies.some((b) => b && b.force === true)`));
  check("«Actualizado hace…» visible", await bar.evaluate(`/^Actualizado hace/.test(document.querySelector('[data-role="updated"]')?.textContent ?? "")`));
  check("botón Actualizar vuelve a estar activo", await bar.evaluate(`document.querySelector('[data-action="refresh"]')?.getAttribute('aria-disabled') === 'false'`));
  await click(bar, '[data-tab="outlook"]');
  await sleep(300);
  check("pestaña Outlook filtra", (await rows(bar)) === 2 && (await allFake(bar)));
  await click(bar, '[data-tab="gmail"]');
  await sleep(300);
  check("pestaña Gmail filtra", (await rows(bar)) === 2);
  await click(bar, '[data-tab="all"]');
  await sleep(300);
  await click(bar, '.list li[data-mail="gmail"] button');
  await sleep(300);
  check("clic en correo → cloud_open(mail, id)", await bar.evaluate(`JSON.stringify(window.__jwOpened)`).then((s) => s === '["mail","g1"]'));
  await closePanel(bar);
  await openPanel(bar, "calendar");
  check("agenda: 2 eventos + 2 tareas ficticios", (await allFake(bar)) && (await rows(bar)) === 4);
  check("agenda: «y 3 tareas más»", await bar.evaluate(`!!document.querySelector(".list li.empty")`));
  await shot(bar, "agenda-ok", await allFake(bar));
  await click(bar, '.list li[data-event] button');
  await sleep(300);
  check("clic en evento → cloud_open(event, id)", await bar.evaluate(`JSON.stringify(window.__jwOpened)`).then((s) => s === '["event","e1"]'));
  await click(bar, '.list li[data-task] button');
  await sleep(300);
  check("clic en tarea → cloud_open(task, id)", await bar.evaluate(`JSON.stringify(window.__jwOpened)`).then((s) => s === '["task","t1"]'));
  await closePanel(bar);

  // ---- loading: «Cargando…» y una sola nueva consulta a los ~5 s
  await load(bar, "loading");
  await openPanel(bar, "mail");
  check("cargando: sin filas y con nota", (await rows(bar)) === 0 && (await has(bar, ".empty-note")));
  await shot(bar, "mail-loading", (await rows(bar)) === 0);
  await sleep(6500);
  const n = await bar.evaluate(`window.__jwCalls.filter((c) => c === "cloud_mail").length`);
  check("cargando: reconsulta una sola vez (~5 s)", n === 2, `llamadas cloud_mail=${n}`);
  check("cargando: aparecen datos ficticios tras la reconsulta", await allFake(bar));
  await closePanel(bar);

  // ---- signedOut / network / quota
  for (const [mode, fix, withData] of [["signedOut", true, false], ["network", false, true], ["quota", false, true]]) {
    await load(bar, mode);
    await openPanel(bar, "mail");
    check(`${mode}: nota data-kind`, (await noteKind(bar)) === mode);
    check(`${mode}: botón «Conectar en Ajustes» ${fix ? "presente" : "ausente"}`, (await has(bar, '[data-action="connect"]')) === fix);
    check(`${mode}: datos ${withData ? "conservados («Actualizado hace X»)" : "ausentes"}`, withData ? (await allFake(bar)) && (await bar.evaluate(`document.querySelector(".cloud-note").textContent.includes("Actualizado hace 12 min")`)) : (await rows(bar)) === 0);
    await shot(bar, `mail-${mode}`, withData ? await allFake(bar) : (await rows(bar)) === 0);
    await closePanel(bar);
  }

  // ---- Ajustes → Cuentas (solo estado; sin pulsar Conectar/Desconectar)
  await bar.evaluate(`window.__TAURI_INTERNALS__.invoke("open_settings")`);
  await sleep(1500);
  const st = await byLabel("settings");
  if (!st) throw new Error("No se encontró la ventana de Ajustes");
  await st.send("Page.enable");
  await load(st, "ok");
  check("Ajustes: sección Cuentas con botón Desconectar (conectada, sin pulsar)", await has(st, '[data-action="logout"]'));
  // Sin captura de Ajustes: la ventana muestra la configuración real del usuario (accesos rápidos).
  await load(st, "signedOut");
  check("Ajustes: desconectada → botón Conectar habilitado (sin pulsar)", await st.evaluate(`document.querySelector('[data-action="login"]')?.disabled === false`));
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
