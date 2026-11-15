// Verificación de JW-2-06 (historial del portapapeles) por CDP + portapapeles y teclado reales.
//   node src-tauri/tests-manual/clipboard.mjs [carpeta-capturas]
// Solo usa textos ficticios «jarwis-prueba-*». No lee lo que el usuario tuviera en el
// portapapeles: lo sobrescribe y al terminar lo deja vacío. Restaura los ajustes.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pages, connect, invoke, click, screenshot, sleep } from "./cdp.mjs";

const shots = process.argv.slice(2).find((a) => !a.startsWith("--"));
const ps1 = fileURLToPath(new URL("./clip.ps1", import.meta.url));
const mouse = fileURLToPath(new URL("./mouse.ps1", import.meta.url));
const ctrlAltC = () => execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", mouse, "ctrlalt", "0x43"]);
const clip = (...a) =>
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...a], { encoding: "utf8" }).trim();
const GREY = { r: 128, g: 128, b: 128, a: 1 };
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`);
};

async function page(label) {
  for (const t of (await pages()).filter((t) => t.url.startsWith("http://tauri.localhost"))) {
    const p = await connect(t);
    if ((await p.evaluate("window.__TAURI_INTERNALS__.metadata.currentWindow.label")) === label) return p;
    p.close();
  }
  return null;
}
const bar = await page("bar");
if (!bar) throw new Error("No se encontró la ventana «bar»: ¿se lanzó la app con --remote-debugging-port?");
await bar.send("Page.enable");
const island = () => bar.evaluate("document.querySelector('.island').className");
/** Textos visibles en el panel: solo los de prueba (lo que copie el usuario entretanto ni se lee ni se imprime). */
const shown = () =>
  bar
    .evaluate("JSON.stringify([...document.querySelectorAll('[data-clip] .clip-text')].map(e => e.textContent).filter(t => t.startsWith('jarwis-prueba')))")
    .then(JSON.parse);
const waitFor = async (expr, ms = 3000) => {
  for (let t = 0; t < ms; t += 100) {
    if (await bar.evaluate(expr)) return true;
    await sleep(100);
  }
  return false;
};
const setValue = (sel, value) =>
  bar.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
const first = () => shown().then((s) => s[0]);
/** Espera a que haya `n` textos de prueba. */
const count = (n) =>
  waitFor(`[...document.querySelectorAll('[data-clip] .clip-text')].filter(e => e.textContent.startsWith('jarwis-prueba')).length === ${n}`);
/** Selector de la fila cuyo texto es `text` (marca la fila con data-t). */
const row = async (text, inner = "") => {
  await bar.evaluate(`(() => { const li = [...document.querySelectorAll('[data-clip]')].find(l => l.querySelector('.clip-text').textContent === ${JSON.stringify(text)});
    document.querySelectorAll('[data-t]').forEach(e => e.removeAttribute('data-t')); li?.setAttribute('data-t', ''); })()`);
  return `[data-t] ${inner}`.trim();
};

// En procesos sin acceso al portapapeles (p. ej. dentro de un job con restricciones de UI,
// OpenClipboard → ERROR_ACCESS_DENIED) solo se verifica la interfaz.
const clipOk = clip("probe") === "True";
if (!clipOk) console.log("SKIP portapapeles real: este proceso no puede abrir el portapapeles (solo interfaz)");

const original = await invoke(bar, "get_settings");
try {
  await invoke(bar, "patch_settings", { patch: { edge: "top", mode: "compact", clipboardHistory: true } });
  await sleep(600);
  // Escucha cruda del evento: debe llegar sin contenido.
  await bar.evaluate(`(() => { window.__clipPayloads = [];
    return window.__TAURI_INTERNALS__.invoke("plugin:event|listen", { event: "clipboard-changed", target: { kind: "Any" },
      handler: window.__TAURI_INTERNALS__.transformCallback((e) => window.__clipPayloads.push(e.payload)) }); })()`);

  check("widget Portapapeles en la isla", await bar.evaluate("!!document.querySelector('li[data-id=\"clipboard\"] svg')"));
  const overflow = await bar.evaluate("(() => { const w = document.querySelector('.widgets'); return w.scrollWidth - w.clientWidth; })()");
  check("compacto: los widgets caben", overflow <= 0, `desborde ${overflow}px`);

  await click(bar, 'li[data-id="clipboard"]');
  check("clic abre el panel", await waitFor("!!document.querySelector('.list.clips')"), await island());

  if (clipOk) {
    clip("set", "jarwis-prueba-1");
    await sleep(300);
    clip("set", "jarwis-prueba-2");
    check("Set-Clipboard aparece en el historial", await count(2), JSON.stringify(await shown()));
    check("el más reciente arriba", (await first()) === "jarwis-prueba-2");

    clip("set", "jarwis-prueba-1");
    await waitFor("document.querySelector('[data-clip] .clip-text')?.textContent === 'jarwis-prueba-1'");
    const s1 = await shown();
    check("dedupe: lo repetido sube sin duplicarse", s1.length === 2 && s1[0] === "jarwis-prueba-1", JSON.stringify(s1));

    clip("excluded", "jarwis-prueba-excluida");
    clip("noinclude", "jarwis-prueba-sin-historial");
    clip("nocloud", "jarwis-prueba-sin-nube");
    await sleep(1200);
    const s2 = await shown();
    check("ExcludeClipboardContentFromMonitorProcessing: no aparece", !s2.includes("jarwis-prueba-excluida"), JSON.stringify(s2));
    check("CanIncludeInClipboardHistory=0: no aparece", !s2.includes("jarwis-prueba-sin-historial"));
    check("CanUploadToCloudClipboard=0: no aparece", !s2.includes("jarwis-prueba-sin-nube"));

    // Copiar de nuevo desde el panel: clic en el segundo (jarwis-prueba-2).
    await click(bar, await row("jarwis-prueba-2", ".clip-text"));
    await waitFor("document.querySelector('[data-clip] .clip-text')?.textContent === 'jarwis-prueba-2'");
    check("aviso «Copiado»", (await bar.evaluate("document.querySelector('[data-t] .clip-time').textContent")) === "Copiado");
    await sleep(800);
    const s3 = await shown();
    check("copiar de nuevo: el portapapeles real lo contiene", clip("equals", "jarwis-prueba-2") === "True");
    check("copiar de nuevo: sube y no se duplica", s3.length === 2 && s3[0] === "jarwis-prueba-2", JSON.stringify(s3));

    await setValue('input[type="search"]', "PRUEBA-1");
    await count(1);
    check("búsqueda sin distinguir mayúsculas", JSON.stringify(await shown()) === '["jarwis-prueba-1"]');
    await setValue('input[type="search"]', "");
    await count(2);

    await click(bar, await row("jarwis-prueba-1", '[data-action="pin"]'));
    check("fijar", await waitFor("!!document.querySelector('[data-t][data-pinned]')"));

    clip("set", "jarwis-prueba-3");
    await count(3);
    if (shots) await screenshot(bar, `${shots}/JW-2-06-panel.png`, GREY);

    await click(bar, '[data-action="pause"]');
    await waitFor("document.querySelector('[data-action=\"pause\"]').getAttribute('aria-pressed') === 'true'");
    clip("set", "jarwis-prueba-en-pausa");
    await sleep(1000);
    check("pausa: no captura", !(await shown()).includes("jarwis-prueba-en-pausa"));
    await click(bar, '[data-action="pause"]');
    await waitFor("document.querySelector('[data-action=\"pause\"]').getAttribute('aria-pressed') === 'false'");
    const set4 = clip("set", "jarwis-prueba-4");
    check("reanudar: vuelve a capturar", await waitFor("document.querySelector('[data-clip] .clip-text')?.textContent === 'jarwis-prueba-4'"), `set=${set4} ${JSON.stringify(await shown())}`);

    await click(bar, await row("jarwis-prueba-4", '[data-action="delete"]'));
    check("borrar un elemento", await waitFor("![...document.querySelectorAll('[data-clip] .clip-text')].some(e => e.textContent === 'jarwis-prueba-4')"));

    await click(bar, '[data-action="clear"]');
    await count(1);
    check("«Borrar todo» conserva solo lo fijado", JSON.stringify(await shown()) === '["jarwis-prueba-1"]', JSON.stringify(await shown()));

    const payloads = await bar.evaluate("JSON.stringify(window.__clipPayloads)");
    check("evento clipboard-changed sin contenido", /^\[null(,null)*\]$/.test(payloads), `${JSON.parse(payloads).length} eventos`);

    // Desactivar en Ajustes borra lo no fijado y deja de capturar.
    clip("set", "jarwis-prueba-5");
    await count(2);
    await invoke(bar, "patch_settings", { patch: { clipboardHistory: false } });
    await count(1);
    clip("set", "jarwis-prueba-desactivado");
    await sleep(1000);
    const s4 = await shown();
    check("desactivado: borra lo no fijado y no captura", JSON.stringify(s4) === '["jarwis-prueba-1"]', JSON.stringify(s4));
    check("desactivado: aviso en el panel", (await bar.evaluate("document.querySelector('[data-action=\"pause\"]')")) === null);
    await invoke(bar, "patch_settings", { patch: { clipboardHistory: true } });
  } else {
    // Solo interfaz: estado vacío, pausa (sin captura) y «Borrar todo».
    check("panel vacío con aviso", (await bar.evaluate("document.querySelector('.list.clips li.empty')?.textContent")) === "Copia un texto para verlo aquí");
    if (shots) await screenshot(bar, `${shots}/JW-2-06-panel.png`, GREY);
    await click(bar, '[data-action="pause"]');
    check("botón de pausa", await waitFor("document.querySelector('[data-action=\"pause\"]').getAttribute('aria-pressed') === 'true'"));
    await click(bar, '[data-action="pause"]');
    await waitFor("document.querySelector('[data-action=\"pause\"]').getAttribute('aria-pressed') === 'false'");
    await click(bar, '[data-action="clear"]');
    await sleep(400);
    const payloads = await bar.evaluate("JSON.stringify(window.__clipPayloads)");
    check("evento clipboard-changed sin contenido", /^\[null(,null)+\]$/.test(payloads), `${JSON.parse(payloads).length} eventos`);
    await invoke(bar, "patch_settings", { patch: { clipboardHistory: false } });
    check("desactivado: aviso en el panel", await waitFor("document.querySelector('.list.clips li.empty')?.textContent === 'Historial desactivado en Ajustes'"));
    await invoke(bar, "patch_settings", { patch: { clipboardHistory: true } });
  }

  // Atajo global con el teclado real: cierra y vuelve a abrir el panel.
  ctrlAltC();
  check("Ctrl+Alt+C cierra el panel", await waitFor("!document.querySelector('.list.clips')"), await island());
  await sleep(600);
  ctrlAltC();
  check("Ctrl+Alt+C abre el panel", await waitFor("!!document.querySelector('.list.clips')"), await island());

  // Al cerrar el panel la WebView ya no conserva los textos.
  await click(bar, '[data-action="close-panel"]');
  await sleep(600);
  check("panel cerrado: sin textos en el DOM", (await bar.evaluate("document.body.innerText.includes('jarwis-prueba')")) === false);

  // Ajustes: interruptor y atajo.
  await invoke(bar, "open_settings");
  let settings = null;
  for (let i = 0; i < 20 && !settings; i++) {
    await sleep(300);
    settings = await page("settings");
  }
  if (settings) {
    await settings.send("Page.enable");
    await sleep(500);
    const ok = await settings.evaluate(
      "(() => { const s = [...document.querySelectorAll('h2')].find(h => h.textContent === 'Portapapeles'); s?.scrollIntoView(); return !!s && !!document.querySelector('input[aria-label=\"Historial del portapapeles\"]:checked') && document.body.innerText.includes('Portapapeles\\nCtrl\\nAlt\\nV'); })()",
    );
    check("Ajustes: interruptor activado y atajo Ctrl+Alt+C", ok);
    if (shots) {
      await settings.evaluate("[...document.querySelectorAll('h2')].find(h => h.textContent === 'Portapapeles').scrollIntoView()");
      await sleep(300);
      await screenshot(settings, `${shots}/JW-2-06-settings.png`);
    }
    // Sin esperar: al cerrarse la ventana la promesa no se resuelve.
    await settings.evaluate("void window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'settings' }).catch(() => {}); true");
    settings.close();
  } else check("ventana de Ajustes", false);
} finally {
  // Limpieza: borra el fijado de prueba, restaura ajustes y vacía el portapapeles.
  const v = await invoke(bar, "clipboard_list", { query: "jarwis-prueba" }).catch(() => ({ items: [] }));
  for (const it of v.items) await invoke(bar, "clipboard_delete", { id: it.id }).catch(() => {});
  await invoke(bar, "patch_settings", { patch: { edge: original.edge, mode: original.mode, clipboardHistory: original.clipboardHistory } }).catch((e) => console.log("No se restauró:", e.message));
  if (clipOk) clip("clear");
  bar.close();
}
console.log(failures ? `\n${failures} comprobaciones fallidas` : "\nTodo OK");
process.exit(failures ? 1 : 0);
