// Verificación en vivo de JW-3-05 (UI de Sistema, Audio y multimedia, Accesos rápidos) por CDP.
//   node src-tauri/tests-manual/phase3-ui.mjs [carpeta-capturas]
// Restaura ajustes, volumen y accesos. No abre accesos reales, no envía órdenes
// multimedia, no toca el portapapeles. Solo guarda un acceso https de prueba.
import { pages, connect, invoke, click, screenshot, sleep } from "./cdp.mjs";

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
const text = (p, sel = ".island") => p.evaluate(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ""`);
const shot = (p, name) => shots && screenshot(p, `${shots}/JW-3-05-${name}.png`, { r: 128, g: 128, b: 128, a: 1 });
const setVal = (p, sel, v) =>
  p.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(v)});
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); })()`);

const sclick = async (p, sel) => (await p.evaluate(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: "center" })`), await sleep(150), click(p, sel));
// Todo hijo directo de la isla compacta debe quedar dentro de ella.
const fits = (p) =>
  p.evaluate(`(() => { const i = document.querySelector(".island").getBoundingClientRect();
    const out = [...document.querySelectorAll(".island .widget, .island .icon-btn")].filter((e) => { const b = e.getBoundingClientRect();
      return b.left < i.left - 0.5 || b.right > i.right + 0.5 || b.top < i.top - 0.5 || b.bottom > i.bottom + 0.5; });
    return { n: document.querySelectorAll(".island .widget").length, out: out.length, w: Math.round(i.width), h: Math.round(i.height) }; })()`);
const bar = await byLabel("bar");
if (!bar) throw new Error("No se encontró la ventana «bar»: ¿se lanzó la app con --remote-debugging-port?");
await bar.send("Page.enable");
const original = await invoke(bar, "get_settings");
const audio0 = await invoke(bar, "audio_state");
let settingsWin = null;
try {
  await invoke(bar, "patch_settings", { patch: { edge: "top", mode: "compact", theme: "dark", pulseAnimation: true } });
  await sleep(700);
  check("WIDGETS incluye media y shortcuts", ["media", "shortcuts"].every((id) => original.widgetOrder.includes(id)), original.widgetOrder.join(","));

  const hz = await fits(bar);
  check("compacta horizontal: 8 widgets dentro", hz.n === 8 && hz.out === 0, JSON.stringify(hz));
  await shot(bar, "compact-horizontal");

  // 1. Sistema.
  await click(bar, '.widget[data-id="system"]');
  await sleep(2600);
  const t = await text(bar);
  check("Sistema: CPU, RAM, disco, red, encendido", ["CPU", "RAM", "Disco del sistema", "Red", "Encendido"].every((k) => t.includes(k)), t.replace(/\s+/g, " ").slice(0, 160));
  check("Sistema: el nivel colorea el icono", await bar.evaluate(`['ok','warn','crit'].includes(document.querySelector('.panel-title .vital').dataset.level)`));
  await shot(bar, "system");
  await click(bar, 'button[data-action="close-panel"]');
  await sleep(500);
  check("panel cerrado", !(await text(bar)).includes("Disco del sistema"));
  check("icono de la barra con data-level", await bar.evaluate(`['ok','warn','crit'].includes(document.querySelector('.widget[data-id="system"] .vital').dataset.level)`));

  // 2. Audio y multimedia.
  await click(bar, '.widget[data-id="media"]');
  await sleep(1200);
  if (audio0) check("Media: el icono refleja muted", (await bar.evaluate('document.querySelector("button[data-action=mute]").getAttribute("aria-pressed")')) === String(audio0.muted), "muted=" + audio0.muted);
  const m = await text(bar);
  check("Media: dispositivo, volumen, sin reproducción", audio0 === null || (m.includes(audio0.deviceName) && m.includes("Nada reproduciéndose")), m.includes("Nada reproduciéndose") ? "sin reproducción" : "hay reproducción");
  check("Media: botones de transporte deshabilitados sin sesión", await bar.evaluate(`['prev','play-pause','next'].every(a => document.querySelector('button[data-action="'+a+'"]').disabled)`));
  if (audio0) {
    const target = audio0.volume >= 50 ? audio0.volume - 9 : audio0.volume + 9;
    await setVal(bar, 'input[aria-label="Volumen"]', String(target));
    await sleep(400);
    check("Media: deslizador envía set_volume", (await invoke(bar, "audio_state")).volume === target, `${audio0.volume} → ${target}`);
  }
  await shot(bar, "media");
  await click(bar, 'button[data-action="close-panel"]');
  await sleep(500);

  // 3. Ajustes: añadir acceso inválido, luego válido.
  await invoke(bar, "open_settings");
  for (let i = 0; i < 20 && !settingsWin; i++) {
    await sleep(300);
    settingsWin = await byLabel("settings");
  }
  if (!settingsWin) throw new Error("no se abrió Ajustes");
  await settingsWin.send("Page.enable");
  await sclick(settingsWin, 'button[data-action="sc-add"]');
  await sleep(150);
  await setVal(settingsWin, '[data-sc="0"] .sc-name', "Prueba");
  await setVal(settingsWin, '[data-sc="0"] .sc-target', "file:///c:/windows");
  await sclick(settingsWin, 'button[data-action="sc-save"]');
  await sleep(400);
  const err = await text(settingsWin, '[role="alert"]');
  check("Ajustes: error de validación del núcleo", err.length > 3, err.slice(0, 100));
  await setVal(settingsWin, '[data-sc="0"] .sc-target', "https://example.com");
  await sclick(settingsWin, 'button[data-action="sc-save"]');
  await sleep(500);
  check("Ajustes: acceso guardado", (await invoke(bar, "get_shortcuts")).some((s) => s.name === "Prueba" && s.id > 0));
  await settingsWin.evaluate("document.querySelector('[data-sc=\"0\"]').scrollIntoView()");
  await shot(settingsWin, "settings");

  // 4. Accesos en la barra (sin abrir ninguno) y borde vertical.
  await click(bar, '.widget[data-id="shortcuts"]');
  await sleep(500);
  check("Accesos: lista con icono y nombre", (await text(bar)).includes("Prueba"));
  await shot(bar, "shortcuts");
  await click(bar, 'button[data-action="close-panel"]');
  await sleep(400);
  await invoke(bar, "patch_settings", { patch: { edge: "left" } });
  await sleep(800);
  const vt = await fits(bar);
  check("compacta vertical: 8 widgets dentro", vt.n === 8 && vt.out === 0, JSON.stringify(vt));
  await shot(bar, "compact-vertical");
  for (const id of ["system", "media", "shortcuts"]) {
    await click(bar, `.widget[data-id="${id}"]`);
    await sleep(id === "system" ? 2600 : 900);
    const o = await bar.evaluate(`(() => { const r = document.querySelector('.island').getBoundingClientRect(); const v = document.querySelector('.panel-view').scrollWidth > document.querySelector('.panel-view').clientWidth; return { w: Math.round(r.width), h: Math.round(r.height), over: v || [...document.querySelectorAll(".stat")].some((e) => e.scrollHeight > e.clientHeight + 1) }; })()`);
    check(`borde izquierdo: panel ${id}`, o.w > 300 && !o.over, `${o.w}x${o.h}`);
    if (id === "system") await shot(bar, "system-vertical");
    if (id === "media") await shot(bar, "media-vertical");
    await click(bar, 'button[data-action="close-panel"]');
    await sleep(500);
  }
  check("sin errores de consola", bar.logs.length === 0, bar.logs.join(" | ").slice(0, 200));
} finally {
  if (settingsWin) {
    // Quita el acceso de prueba desde la propia UI de Ajustes.
    try {
      await settingsWin.evaluate("document.querySelectorAll('button[data-action=\"sc-delete\"]').forEach(() => 0)");
    } catch {}
  }
  await sleep(100);
  const cur = await invoke(bar, "get_shortcuts");
  if (cur.length !== original.shortcuts.length && settingsWin) {
    await settingsWin.evaluate(`window.__TAURI_INTERNALS__.invoke("set_shortcuts", { list: ${JSON.stringify(original.shortcuts)} })`);
  }
  await invoke(bar, "patch_settings", { patch: { edge: original.edge, mode: original.mode, theme: original.theme, pulseAnimation: original.pulseAnimation } }).catch(() => {});
  if (audio0) await invoke(bar, "set_volume", { volume: audio0.volume });
  const a = await invoke(bar, "audio_state");
  check("restaurado", (!audio0 || a.volume === audio0.volume) && (await invoke(bar, "get_shortcuts")).length === original.shortcuts.length, `volumen=${a?.volume} accesos=${(await invoke(bar, "get_shortcuts")).length}`);
  if (settingsWin) await settingsWin.evaluate("window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'settings' }).catch(() => {})").catch(() => {});
}
console.log(failures ? `${failures} FALLO(S)` : "Todo OK");
process.exit(failures ? 1 : 0);
