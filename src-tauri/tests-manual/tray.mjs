// Bandeja (icono y cada opción del menú) y cierre de Ajustes con la X, simulados con mensajes Win32
// (win.ps1). Termina pulsando «Salir»: la app queda cerrada.
// Aviso: mueve el foco al menú de la bandeja; no teclear mientras se ejecuta (~15 s).
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

async function byLabel(label) {
  for (const t of (await pages()).filter((t) => t.url.startsWith("http://tauri.localhost"))) {
    const c = await connect(t);
    if ((await c.evaluate("window.__TAURI_INTERNALS__.metadata.currentWindow.label")) === label) return c;
    c.close();
  }
  return null;
}
const bar = await byLabel("bar");
const original = await invoke(bar, "get_settings");
if (!visible()) win("tray-left"), await sleep(600);

win("tray-left");
await sleep(600);
check("clic izquierdo oculta", !visible());
win("tray-left");
await sleep(600);
check("clic izquierdo muestra", visible());

win("tray-menu", 1);
await sleep(700);
check("menú «Mostrar/Ocultar» oculta", !visible());
const mode0 = (await invoke(bar, "get_settings")).mode;
win("tray-menu", 2);
await sleep(900);
check("menú «Compacto/Expandido» con la barra oculta: la muestra", visible());
check("menú «Compacto/Expandido» cambia el modo", (await invoke(bar, "get_settings")).mode !== mode0);
win("tray-menu", 2);
await sleep(900);

win("tray-menu", 3);
await sleep(2500);
const st = await byLabel("settings");
check("menú «Ajustes» abre la ventana con contenido", !!st && (await st.evaluate("document.querySelectorAll('.section').length")) >= 5);
check("núcleo libre tras abrir Ajustes desde la bandeja", !!(await invoke(bar, "get_settings").catch(() => null)));
st?.close();
win("close", "Ajustes de JarWis");
await sleep(1200);
check("la X (WM_CLOSE) cierra y destruye Ajustes", win("exists", "Ajustes de JarWis") === "False" && !(await byLabel("settings")));

await invoke(bar, "patch_settings", { patch: { mode: original.mode } });
bar.close();
win("tray-menu", 4); // 4.ª opción navegable: «Salir» (el separador no cuenta)
await sleep(2000);
check("menú «Salir» cierra la app", win("exists", "JarWis") === "False");
await sleep(200);
process.exitCode = failures ? 1 : 0;
