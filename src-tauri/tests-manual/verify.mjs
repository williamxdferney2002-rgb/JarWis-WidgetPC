// Verificación de JW-2-02 por CDP. Requisitos y uso en README.md de esta carpeta.
//   node src-tauri/tests-manual/verify.mjs
// Sin capturas ni lectura de texto del DOM: con una sesión real de Google la barra y Ajustes muestran datos reales.
// Restaura los ajustes originales al terminar. Nunca toca «Iniciar con Windows».
import { pages, connect, invoke, restoreWidgetOrder, click, drag, sleep } from "./cdp.mjs";

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
const countEvents = (p) =>
  p.evaluate(`(() => { window.__ev = {}; for (const t of ["dragstart","dragover","drop","dragend"])
    document.addEventListener(t, () => (window.__ev[t] = (window.__ev[t] ?? 0) + 1), true); })()`);
const size = (p) => p.evaluate("[innerWidth, innerHeight].join('x')");
const island = (p) => p.evaluate("document.querySelector('.island').className");

const bar = await byLabel("bar");
if (!bar) throw new Error("No se encontró la ventana «bar»: ¿se lanzó la app con --remote-debugging-port?");
await bar.send("Page.enable");
const original = await invoke(bar, "get_settings");
try {
  // Estado inicial conocido.
  await invoke(bar, "patch_settings", { patch: { edge: "top", mode: "compact", theme: "system" } });
  await sleep(700);
  const compactSize = await size(bar);
  check("barra compacta", compactSize === "340x44", compactSize);
  let expandedSize = "";

  // 1. Botón expandir (clic real) y «morph».
  await click(bar, 'button[data-action="mode"]');
  await sleep(120);
  expandedSize = await size(bar);
  check("expandir: ventana crece antes de animar", expandedSize === "1000x112", expandedSize);
  await sleep(600);
  check("expandir: isla expandida", (await island(bar)).includes("expanded"));
  check("expandir: ajuste guardado", (await invoke(bar, "get_settings")).mode === "expanded");

  // 2. Arrastre en la barra (tarjetas en expandido).
  await countEvents(bar);
  const before = (await invoke(bar, "get_settings")).widgetOrder;
  const started = await drag(bar, 'li[data-id="mail"]', 'li[data-id="system"]');
  await sleep(400);
  const ev = await bar.evaluate("JSON.stringify(window.__ev)");
  const after = (await invoke(bar, "get_settings")).widgetOrder;
  check("arrastre barra: dragstart/drop llegan", started && ev.includes("drop"), ev);
  check("arrastre barra: orden cambiado", after.indexOf("mail") !== before.indexOf("mail"), `${before} -> ${after}`);

  // 3. Compactar: la ventana se encoge al final de la animación.
  await click(bar, 'button[data-action="mode"]');
  await sleep(150);
  check("compactar: ventana aún grande durante la animación", (await size(bar)) === expandedSize, await size(bar));
  await sleep(700);
  check("compactar: ventana encogida al terminar", (await size(bar)) === compactSize, await size(bar));

  // 4. Botón Ajustes: la ventana se crea, tiene contenido y el hilo principal sigue libre.
  await click(bar, 'button[data-action="settings"]');
  await sleep(2500);
  check("ajustes: el núcleo sigue respondiendo", !!(await invoke(bar, "get_settings").catch(() => null)));
  const st = await byLabel("settings");
  check("ajustes: ventana creada", !!st);
  if (st) {
    await st.send("Page.enable");
    const dom = JSON.parse(
      await st.evaluate(`JSON.stringify({ len: document.getElementById('root').innerHTML.length,
        sections: document.querySelectorAll('.section').length })`),
    );
    check("ajustes: DOM con contenido", dom.len > 1000 && dom.sections >= 5, JSON.stringify(dom));

    // Interruptor «Siempre visible» (clic real) y vuelta atrás.
    const aot = (await invoke(st, "get_settings")).alwaysOnTop;
    await st.evaluate("document.querySelector('input[aria-label=\"Siempre visible\"]').scrollIntoView()");
    await click(st, 'input[aria-label="Siempre visible"]');
    await sleep(300);
    check("ajustes: interruptor cambia el ajuste", (await invoke(st, "get_settings")).alwaysOnTop === !aot);
    await click(st, 'input[aria-label="Siempre visible"]');
    await sleep(300);

    // Control segmentado de modo.
    await st.evaluate("document.querySelector('.segmented').scrollIntoView()");
    await click(st, 'input[value="expanded"] + span');
    await sleep(300);
    check("ajustes: segmentado cambia el modo", (await invoke(st, "get_settings")).mode === "expanded");
    await click(st, 'input[value="compact"] + span');
    await sleep(700);

    // Arrastre en la lista de Ajustes.
    await countEvents(st);
    await st.evaluate("document.querySelector('.widget-list').scrollIntoView()");
    const o1 = (await invoke(st, "get_settings")).widgetOrder;
    // Último sobre el primero del orden actual: sube en cualquier orden guardado.
    const [first, last] = [o1[0], o1[o1.length - 1]];
    const s2 = await drag(st, `.widget-list li[data-id="${last}"]`, `.widget-list li[data-id="${first}"]`);
    await sleep(400);
    const o2 = (await invoke(st, "get_settings")).widgetOrder;
    check("arrastre ajustes: dragstart/drop llegan", s2 && (await st.evaluate("JSON.stringify(window.__ev)")).includes("drop"));
    check("arrastre ajustes: orden cambiado", o2.join() !== o1.join() && o2.indexOf(last) < o1.indexOf(last), `${o1} -> ${o2}`);

    check("ajustes: sin errores de consola", st.logs.length === 0, st.logs.join(" | "));

    // Botón «Listo»: cierra y destruye la ventana.
    await st.evaluate("document.querySelector('[data-action=close]').scrollIntoView()");
    await click(st, '[data-action="close"]');
    await sleep(1200);
    check("ajustes: «Listo» cierra la ventana", !(await byLabel("settings")));
  }
  // 5. Vertical expandido (JW-9-04): la última tarjeta no pisa el pie. Solo números, sin texto del DOM.
  await invoke(bar, "patch_settings", { patch: { edge: "left", mode: "expanded", theme: "system" } });
  await sleep(1200);
  const m = JSON.parse(
    await bar.evaluate(`(() => { const l = document.querySelector('.island.v.expanded .widgets');
      const cards = l ? l.querySelectorAll('.widget') : [];
      const a = document.querySelector('.island.v.expanded .actions');
      if (!l || !a || !cards.length) return JSON.stringify({ ok: false });
      const last = cards[cards.length - 1].getBoundingClientRect(); const lr = l.getBoundingClientRect();
      return JSON.stringify({ ok: true, n: cards.length, sh: l.scrollHeight, ch: l.clientHeight, lastBottom: last.bottom,
        listBottom: lr.bottom, actionsTop: a.getBoundingClientRect().top, actionsBottom: a.getBoundingClientRect().bottom, ih: innerHeight }); })()`),
  );
  check("vertical expandido: tamaño 200x780 (recortado al área útil)", m.ok && m.ih <= 780, JSON.stringify(m));
  // Cabe sin scroll, o bien hay scroll y el pie sigue dentro de la ventana sin ser tapado.
  check("vertical expandido: lista sin solape con el pie", m.ok && m.listBottom <= m.actionsTop + 0.5 && m.actionsBottom <= m.ih);
  check("vertical expandido: última tarjeta alcanzable", m.ok && (m.sh <= m.ch + 1 ? m.lastBottom <= m.actionsTop + 0.5 : m.sh > m.ch));
  check("barra: sin errores de consola", bar.logs.length === 0, bar.logs.join(" | "));
} finally {
  await restoreWidgetOrder(bar, original.widgetOrder);
  await invoke(bar, "patch_settings", { patch: { edge: original.edge, mode: original.mode, theme: original.theme, alwaysOnTop: original.alwaysOnTop } }).catch((e) => console.log("No se restauró:", e.message));
}
console.log(failures ? `\n${failures} comprobaciones fallidas` : "\nTodas las comprobaciones OK");
bar.close();
await sleep(200);
process.exitCode = failures ? 1 : 0;
