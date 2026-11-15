// Verificación en vivo de JW-3-01 (monitoreo), JW-3-03 y JW-3-08 (accesos rápidos, núcleo) por CDP.
//   node src-tauri/tests-manual/system-shortcuts.mjs
// No abre ningún acceso real. Guarda temporalmente una lista de prueba y restaura la original.
import { pages, connect, invoke, sleep } from "./cdp.mjs";
const BS = String.fromCharCode(92);

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
// Mensaje de error del comando, o null si no falla.
const rejects = (page, cmd, args = {}) =>
  page.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(() => null, (e) => String(e))`);

const bar = await byLabel("bar");
if (!bar) throw new Error("No se encontró la ventana «bar»: ¿se lanzó la app con --remote-debugging-port?");

// Monitoreo: dos muestras (la segunda con tasa de red real).
await invoke(bar, "system_snapshot");
await sleep(1500);
const s = await invoke(bar, "system_snapshot");
check("snapshot: campos", ["cpu", "memUsed", "memTotal", "diskUsed", "diskTotal", "netRxBps", "netTxBps", "uptimeSecs", "battery", "level"].every((k) => k in s));
check("snapshot: valores", s.cpu >= 0 && s.cpu <= 100 && s.memTotal > 0 && s.diskTotal > 0 && s.uptimeSecs > 0, `cpu=${s.cpu.toFixed(1)} level=${s.level} battery=${s.battery ? "sí" : "null"}`);
let t = performance.now();
for (let i = 0; i < 10; i++) await invoke(bar, "system_snapshot");
console.log(`     10 muestras en ${(performance.now() - t).toFixed(0)} ms`);

// Permisos: la barra no edita accesos ni usa el opener directamente.
check("barra: set_shortcuts denegado", !!(await rejects(bar, "set_shortcuts", { list: [] })));
check("barra: plugin opener denegado", !!(await rejects(bar, "plugin:opener|open_url", { url: "https://example.com" })));
check("open_shortcut: id inexistente", /no existe/.test(await rejects(bar, "open_shortcut", { id: 999999 })));

// Ajustes: validar y guardar (sin abrir nada).
await invoke(bar, "open_settings");
await sleep(1500);
const st = await byLabel("settings");
check("ventana de Ajustes", !!st);
if (st) {
  const original = await invoke(st, "get_shortcuts");
  const workspaces = (await invoke(st, "get_settings")).workspaces;
  const bad = await rejects(st, "set_shortcuts", { list: [{ id: 0, name: "x", kind: "url", target: "file:///C:/Windows" }] });
  check("set_shortcuts: rechaza file://", !!bad, bad ?? "");
  const badApp = await rejects(st, "set_shortcuts", { list: [{ id: 0, name: "x", kind: "app", target: "C:\\Windows\\System32\\cmd.exe /c calc" }] });
  check("set_shortcuts: rechaza argumentos", !!badApp, badApp ?? "");
  // JW-3-08: apps de Microsoft Store. Solo conteo y presencia de Netflix; nada se abre.
  const NETFLIX = "4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App";
  const apps = await invoke(st, "list_store_apps");
  check("list_store_apps", apps.length > 0, `apps=${apps.length} netflix=${apps.some((a) => a.appId === NETFLIX)}`);
  check("barra: list_store_apps denegado", !!(await rejects(bar, "list_store_apps")));
  for (const target of ["Pkg!App" + BS + "x", "Pkg!.." + BS + "App", "..!App", "C:Pkg!App", "Pkg!App!x"]) {
    const e = await rejects(st, "set_shortcuts", { list: [{ id: 0, name: "x", kind: "store", target }] });
    check(`store: rechaza ${target}`, !!e);
  }
  const okStore = await invoke(st, "set_shortcuts", { list: [{ id: 0, name: "Netflix", kind: "store", target: NETFLIX }] });
  check("store: guarda AUMID válido", okStore.length === 1 && okStore[0].kind === "store");
  const saved = await invoke(st, "set_shortcuts", {
    list: [
      { id: 0, name: "Ejemplo", kind: "url", target: "https://example.com" },
      { id: 0, name: "Windows", kind: "folder", target: "C:\\Windows" },
    ],
  });
  check("set_shortcuts: guarda y asigna ids", saved.length === 2 && saved[0].id > 0 && saved[1].id > saved[0].id);
  check("patch_settings rechaza accesos", !!(await rejects(st, "patch_settings", { patch: { shortcuts: [] } })));
  check("patch_settings no borra accesos", (await invoke(st, "get_shortcuts")).length === 2);
  await invoke(st, "set_shortcuts", { list: original });
  await invoke(st, "set_workspaces", { list: workspaces });
  check("restaurado", (await invoke(st, "get_shortcuts")).length === original.length);
  await st.evaluate("setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'settings' }), 0), 1");
}
console.log(failures ? `${failures} fallo(s)` : "Todo OK");
process.exit(failures ? 1 : 0);
