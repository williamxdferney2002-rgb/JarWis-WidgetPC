// Menú contextual de la isla (JW-2-08): Posición, Ocultar barra, Ajustes… y Salir.
//   node src-tauri/tests-manual/bar-menu.mjs
// Abre el menú con el comando `bar_menu` (el mismo que el clic derecho) y elige con
// el teclado (win.ps1 keys). Restaura el borde original. Termina con «Salir de JarWis»:
// la app queda cerrada. Aviso: no teclear mientras se ejecuta (~10 s).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pages, connect, invoke, sleep } from "./cdp.mjs";

const ps = (file, ...a) =>
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL(file, import.meta.url)), ...a.map(String)])
    .toString()
    .trim();
const win = (...a) => ps("./win.ps1", ...a);
const visible = () => ps("./mouse.ps1", "visible") === "True";
let failures = 0;
const check = (n, ok, d = "") => (ok || failures++, console.log(`${ok ? "OK  " : "FAIL"} ${n}${d ? ` · ${d}` : ""}`));

let bar = null;
for (const t of (await pages()).filter((t) => t.url.startsWith("http://tauri.localhost"))) {
  const c = await connect(t);
  if ((await c.evaluate("window.__TAURI_INTERNALS__.metadata.currentWindow.label")) === "bar") bar = c;
  else c.close();
}
if (!bar) throw new Error("No se encontró la ventana «bar»: ¿se lanzó la app con --remote-debugging-port?");
const original = await invoke(bar, "get_settings");
const rect = () => bar.evaluate("JSON.stringify([screenX, screenY, outerWidth, outerHeight, screen.width, screen.height])").then(JSON.parse);
// El comando espera a que el menú se cierre: no se espera su promesa aquí.
const menu = async (keys) => {
  bar.evaluate("window.__TAURI_INTERNALS__.invoke('bar_menu').then(() => 0, () => 0), 1");
  await sleep(600);
  win("keys", keys);
  await sleep(900);
};

// Clic derecho real (CDP) sobre la isla: debe abrir el menú nativo; Esc lo cierra.
// (No se puede espiar `invoke`: __TAURI_INTERNALS__ no es modificable.)
check("sin menú abierto al empezar", win("menu-open") === "False");
const c = await bar.evaluate("(() => { const b = document.querySelector('.island').getBoundingClientRect(); return { x: b.x + 4, y: b.y + b.height / 2 }; })()");
for (const type of ["mousePressed", "mouseReleased"]) await bar.send("Input.dispatchMouseEvent", { type, ...c, button: "right", clickCount: 1 });
await sleep(600);
check("clic derecho en la isla abre el menú", win("menu-open") === "True");
win("keys", "esc");
await sleep(400);
check("Esc lo cierra", win("menu-open") === "False");
const inputs = await bar.evaluate("document.querySelectorAll('.island input, .island textarea').length");
console.log(`     campos de texto visibles en la isla: ${inputs} (en ellos se conserva el menú propio)`);

// Posición: un borde distinto del actual (orden del submenú: Arriba, Abajo, Izquierda, Derecha).
const edges = ["top", "bottom", "left", "right"];
const target = original.edge === "left" ? "right" : "left";
const downs = Array(edges.indexOf(target)).fill("down");
await menu(["down", "right", ...downs, "enter"].join(","));
const s = await invoke(bar, "get_settings");
const [x, , w, h, sw] = await rect();
check("Posición → " + target, s.edge === target, `edge=${s.edge}`);
check("ventana recolocada", h > w && (target === "left" ? x < sw / 2 : x > sw / 2), `x=${x} ${w}x${h}`);
await invoke(bar, "patch_settings", { patch: { edge: original.edge } });
await sleep(800);
check("borde restaurado", (await invoke(bar, "get_settings")).edge === original.edge);

// Ocultar barra (2.ª opción) y volver a mostrar con la bandeja.
await menu("down,down,enter");
check("Ocultar barra", !visible());
win("tray-left");
await sleep(600);
check("bandeja la muestra", visible());

// Ajustes… (3.ª opción).
await menu("down,down,down,enter");
await sleep(1500);
check("Ajustes… abre la ventana", win("exists", "Ajustes de JarWis") === "True");
win("close", "Ajustes de JarWis");
await sleep(800);

// Escape no hace nada.
await menu("esc");
check("Esc cierra sin cambios", visible() && (await invoke(bar, "get_settings")).edge === original.edge);

// Salir de JarWis (4.ª opción navegable; el separador no cuenta).
await menu("down,down,down,down,enter");
await sleep(1000);
check("Salir de JarWis", win("exists", "JarWis") !== "True");
console.log(failures ? `${failures} fallo(s)` : "Todo OK");
process.exit(failures ? 1 : 0);
