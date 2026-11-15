// Verificación de la UI de Claude (JW-5-03) por CDP, SOLO con datos simulados.
//   node src-tauri/tests-manual/claude-ui.mjs [carpeta-capturas]
// PRIVACIDAD: la barra real mostraría tus accesos rápidos reales. Por eso el script
// sustituye claude_* por un mock (interceptando fetch; `__TAURI_INTERNALS__.invoke` no es escribible),
// recarga y, ANTES de capturar o leer el DOM, comprueba que el mock está activo (cloud_mock_ping) y que
// las filas llevan el centinela «jarwis-prueba»; si no, aborta. El mock nunca rechaza un fetch (Tauri
// reenviaría la orden al backend real). No captura Ajustes, no pulsa nada que lance procesos reales
// (claude_open es ficticio) y nunca usa el portapapeles.
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

const mockScript = () => `(() => {
  const calls = (window.__jwCalls = []);
  const realFetch = window.fetch.bind(window);
  const now = Date.now();
  const shortcuts = [
    { id: 1, name: "jarwis-prueba uno", kind: "url", target: "https://example.test/", color: "red", icon: "music" },
    { id: 2, name: "jarwis-prueba dos", kind: "folder", target: "C:\\jarwis-prueba", color: null, icon: null } ];
  const fake = {
    get_shortcuts: () => shortcuts,
    open_shortcut: () => null,
    media_state: () => ({ title: "jarwis-prueba tema", artist: "jarwis-prueba artista", playing: false, canPrev: true, canNext: true, canPlayPause: true, appId: "jarwis-prueba" }),
    audio_state: () => ({ deviceName: "jarwis-prueba altavoces", volume: 40, muted: false }),
    media_open: (b) => { (window.__jwMedia = window.__jwMedia || []).push(b.target); return null; },
    claude_open: (b) => { (window.__jwOpened = window.__jwOpened || []).push(b.action); return null; },
    cloud_mock_ping: () => "jarwis-prueba" };
  window.fetch = async (url, init) => {
    const u = String(url);
    const cmd = /ipc\\.localhost\\/(claude_|media_|audio_state|get_settings|get_shortcuts|open_shortcut|cloud_mock_ping)/.test(u) ? u.split("ipc.localhost/")[1].split(/[?#]/)[0] : null;
    if (!cmd) return realFetch(url, init);
    if (cmd === "get_settings") { // ajustes reales con los accesos sustituidos por dos ficticios
      const r = await (await realFetch(url, init)).json();
      return new Response(JSON.stringify({ ...r, shortcuts }), { headers: { "Tauri-Response": "ok", "content-type": "application/json" } });
    }
    calls.push(cmd);
    let body = null;
    try { body = JSON.parse(init.body); } catch {}
    let res, ok = true;
    try { if (!fake[cmd]) throw "mock"; res = fake[cmd](body); } catch { res = "mock"; ok = false; }
    return new Response(JSON.stringify(res), { headers: { "Tauri-Response": ok ? "ok" : "error", "content-type": "application/json" } });
  };
})()`;

const mocked = (p) => p.evaluate(`window.__TAURI_INTERNALS__.invoke("cloud_mock_ping").then((v) => v === "jarwis-prueba", () => false)`);
const has = (p, sel) => p.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = (p, sel) => p.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
// Filas centinela: los accesos mostrados empiezan por «jarwis-prueba» (booleano; nunca se imprime el texto).
const allFake = (p) =>
  p.evaluate(`(() => { const r = [...document.querySelectorAll('[data-shortcut] .ellipsis')];
    return r.length > 0 && r.every((e) => e.textContent.startsWith("jarwis-prueba")); })()`);
const shot = async (p, name, fake) => {
  if (!(await mocked(p)) || !fake) throw new Error(`ABORTADO antes de capturar «${name}»: no se comprobó que los datos fueran ficticios`);
  if (shots) await screenshot(p, `${shots}/JW-5-03-${name}.png`, { r: 128, g: 128, b: 128, a: 1 });
};

const bar = await byLabel("bar");
if (!bar) throw new Error("No se encontró la ventana «bar»: ¿se lanzó la app con --remote-debugging-port?");
await bar.send("Page.enable");

let scriptId = null;
async function load() {
  if (scriptId) await bar.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
  scriptId = (await bar.send("Page.addScriptToEvaluateOnNewDocument", { source: mockScript() })).identifier;
  await bar.send("Page.reload");
  await sleep(1500);
  for (let i = 0; i < 20 && !(await has(bar, ".island")); i++) await sleep(250);
  if (!(await mocked(bar))) throw new Error(`ABORTADO: el mock no está activo; no se captura nada por si hubiera datos reales`);
}
const openPanel = async () => {
  await click(bar, '.widget[data-id="claude"]');
  for (let i = 0; i < 20 && !(await has(bar, ".panel-view")); i++) await sleep(200);
  await sleep(900);
};
const closePanel = async () => {
  await click(bar, '[data-action="close-panel"]');
  await sleep(500);
};

try {
  await load();
  check("mock activo", true);
  check("sin insignia de consumo en el widget", !(await has(bar, '.widget[data-id="claude"] .badge')));
  await openPanel();
  check("sin estadísticas de consumo (barras, sesiones, status line)", !(await has(bar, ".meter, [data-limit], [data-session], [data-empty='status']")));
  const LABELS = { app: "Claude", terminal: "Claude en la terminal", usage: "Ver mi uso", chatgpt: "ChatGPT", antigravity: "Antigravity" };
  const texts = await Promise.all(Object.keys(LABELS).map((a) => text(bar, `[data-launch="${a}"]`)));
  check("cinco botones del panel IA con su texto", texts.every((t, i) => t === Object.values(LABELS)[i]), texts.join("|"));
  check("sin proyectos ni acción folder", !(await has(bar, "[data-project], [data-open], .claude-body .list")));
  check("panel IA sin desbordar en vertical", await bar.evaluate(`(() => { const b = document.querySelector(".claude-body"); return b.scrollHeight <= b.clientHeight + 1 && document.querySelector(".panel-view").scrollWidth <= document.querySelector(".panel-view").clientWidth + 1; })()`));
  await shot(bar, "panel", true);
  for (const a of Object.keys(LABELS)) {
    await click(bar, `[data-launch="${a}"]`);
    await sleep(250);
  }
  const opened = await bar.evaluate(`JSON.stringify(window.__jwOpened)`);
  check("botones → claude_open(app|terminal|usage|chatgpt|antigravity)", opened === '["app","terminal","usage","chatgpt","antigravity"]', opened);
  await closePanel();

  // ---- widget de audio y medios: solo se comprueba qué orden se invoca (media_open ficticio)
  await click(bar, '.widget[data-id="media"]');
  for (let i = 0; i < 20 && !(await has(bar, '[data-launch="spotify"]')); i++) await sleep(200);
  await sleep(600);
  check("botones Spotify, YouTube y Netflix sobre los controles", await bar.evaluate(`(() => { const l = document.querySelector(".launchers"), t = document.querySelector(".transport"); return !!l && !!t && l.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING; })()`));
  await click(bar, '[data-launch="spotify"]');
  await click(bar, '[data-launch="youtube"]');
  await click(bar, '[data-launch="netflix"]');
  await sleep(250);
  check("botones → media_open(spotify|youtube|netflix)", (await bar.evaluate(`JSON.stringify(window.__jwMedia)`)) === '["spotify","youtube","netflix"]');
  await closePanel();

  // ---- accesos rápidos: cada uno pinta su color e icono (elegidos o derivados), con datos ficticios
  await click(bar, '.widget[data-id="shortcuts"]');
  for (let i = 0; i < 20 && !(await has(bar, "[data-shortcut]")); i++) await sleep(200);
  await sleep(600);
  check("accesos ficticios jarwis-prueba", await allFake(bar));
  check("acceso con color rojo e icono música elegidos", await bar.evaluate(`(() => { const b = document.querySelector('[data-shortcut="1"] button'); return b.dataset.color === "red" && b.dataset.icon === "music"; })()`));
  check("el icono toma el color --sc-red", await bar.evaluate(`getComputedStyle(document.querySelector('[data-shortcut="1"] svg')).color === getComputedStyle(Object.assign(document.body.appendChild(document.createElement("i")), { style: "color: var(--sc-red)" })).color`));
  check("acceso sin elección: icono de carpeta y color derivado válido", await bar.evaluate(`(() => { const b = document.querySelector('[data-shortcut="2"] button'); return b.dataset.icon === "folder" && ["blue","red","green","orange","purple","pink","teal","yellow","gray","indigo"].includes(b.dataset.color); })()`));
  await shot(bar, "shortcuts", await allFake(bar));
  await closePanel();
  await shot(bar, "island", true);
} catch (e) {
  failures++;
  console.log(`FAIL ${e.message}`);
} finally {
  await bar.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId }).catch(() => {});
  await bar.send("Page.reload").catch(() => {}); // vuelve a la UI real (sin mock); no se lee su contenido
  console.log(bar.logs.length ? `Consola de la barra: ${bar.logs.length} avisos/errores` : "Consola de la barra: limpia");
  bar.close();
}
console.log(failures ? `\n${failures} fallo(s)` : "\nTodo correcto");
process.exit(failures ? 1 : 0);
