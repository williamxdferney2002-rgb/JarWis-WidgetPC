// Clics y arrastre con el ratón REAL del SO sobre la barra (mueve el cursor ~3 s y lo devuelve).
// Comprueba lo que CDP no cubre: foco (`focus:false`) y el arrastre nativo de WebView2.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pages, connect, invoke, restoreWidgetOrder, sleep } from "./cdp.mjs";

const ps1 = fileURLToPath(new URL("./mouse.ps1", import.meta.url));
const mouse = (...a) => execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...a.map(String)]);
let failures = 0;
const check = (n, ok, d = "") => (ok || failures++, console.log(`${ok ? "OK  " : "FAIL"} ${n}${d ? ` · ${d}` : ""}`));

let bar = null;
for (const t of (await pages()).filter((t) => t.url.startsWith("http://tauri.localhost"))) {
  const c = await connect(t);
  if ((await c.evaluate("window.__TAURI_INTERNALS__.metadata.currentWindow.label")) === "bar") bar = c;
  else c.close();
}
if (!bar) throw new Error("No se encontró la ventana «bar»");
const original = await invoke(bar, "get_settings");
/** Centro de `sel` en píxeles físicos de pantalla. */
const screen = (sel) =>
  bar.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(), d = devicePixelRatio;
    return [Math.round((screenX + b.x + b.width / 2) * d), Math.round((screenY + b.y + b.height / 2) * d)]; })()`);
try {
  await invoke(bar, "patch_settings", { patch: { edge: "top", mode: "compact" } });
  await sleep(800);
  mouse("click", ...(await screen('button[data-action="mode"]')));
  await sleep(800);
  check("clic real en «Expandir»", (await invoke(bar, "get_settings")).mode === "expanded");

  await bar.evaluate(`(() => { window.__ev = {}; for (const t of ["dragstart","drop"])
    document.addEventListener(t, () => (window.__ev[t] = (window.__ev[t] ?? 0) + 1), true); })()`);
  const before = (await invoke(bar, "get_settings")).widgetOrder;
  mouse("drag", ...(await screen('li[data-id="calendar"]')), ...(await screen('li[data-id="system"]')));
  await sleep(600);
  const after = (await invoke(bar, "get_settings")).widgetOrder;
  check("arrastre real en la barra", after.indexOf("calendar") < after.indexOf("system"),
    `${await bar.evaluate("JSON.stringify(window.__ev)")} ${before} -> ${after}`);

  mouse("click", ...(await screen('button[data-action="mode"]')));
  await sleep(900);
  check("clic real en «Compactar»", (await invoke(bar, "get_settings")).mode === "compact");

  mouse("click", ...(await screen('button[data-action="settings"]')));
  await sleep(2500);
  const labels = [];
  for (const p of await pages()) {
    if (!p.url.startsWith("http://tauri.localhost")) continue;
    const c = await connect(p);
    labels.push(await c.evaluate("window.__TAURI_INTERNALS__.metadata.currentWindow.label"));
    c.close();
  }
  check("clic real en «Ajustes» abre la ventana", labels.includes("settings"), labels.join(","));
  check("núcleo libre tras abrir Ajustes", !!(await invoke(bar, "get_settings").catch(() => null)));

  // Atajos globales (mismas funciones que usa el menú de la bandeja: toggle_mode y toggle_visibility).
  const mode0 = (await invoke(bar, "get_settings")).mode;
  mouse("ctrlalt", 0x4b);
  await sleep(900);
  check("Ctrl+Alt+K alterna el modo", (await invoke(bar, "get_settings")).mode !== mode0);
  mouse("ctrlalt", 0x4b);
  await sleep(900);
  mouse("ctrlalt", 0x4a);
  await sleep(800);
  check("Ctrl+Alt+J oculta la barra", mouse("visible").toString().trim() === "False");
  mouse("ctrlalt", 0x4a);
  await sleep(800);
  check("Ctrl+Alt+J la vuelve a mostrar", mouse("visible").toString().trim() === "True");
} finally {
  await restoreWidgetOrder(bar, original.widgetOrder);
  await invoke(bar, "patch_settings", { patch: { edge: original.edge, mode: original.mode } });
  bar.close();
}
await sleep(200);
process.exitCode = failures ? 1 : 0;
