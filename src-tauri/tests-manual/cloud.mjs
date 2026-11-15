// Verificación en vivo de JW-4-02 (núcleo de Google) por CDP. Sin red real ni sesión.
//   node src-tauri/tests-manual/cloud.mjs
// Nunca llama a cloud_login ni a cloud_logout (abrirían el navegador o borrarían la sesión).
// Si hay una sesión de Google guardada se detiene: con `--authorized` (solo el usuario)
// consulta y muestra únicamente el `kind` del error y conteos, nunca asuntos ni remitentes.
import { pages, connect, invoke, sleep } from "./cdp.mjs";

const authorized = process.argv.includes("--authorized");
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
await invoke(bar, "open_settings");
await sleep(1500);
const st = await byLabel("settings");
if (!st) throw new Error("No se abrió la ventana de Ajustes");
const closeSettings = () =>
  st.evaluate("setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'settings' }), 0), 1");

// Permisos cruzados: la barra no conecta ni desconecta; Ajustes no lee correo ni abre.
for (const cmd of ["cloud_status", "cloud_login", "cloud_logout"]) {
  check(`barra: ${cmd} denegado`, /not allowed|denied/i.test((await rejects(bar, cmd)) ?? ""));
}
for (const [cmd, args] of [["cloud_mail", { force: false }], ["cloud_agenda", { force: false }], ["cloud_open", { kind: "mail", id: "abc" }]]) {
  check(`ajustes: ${cmd} denegado`, /not allowed|denied/i.test((await rejects(st, cmd, args)) ?? ""));
}
check("barra: plugin opener denegado", !!(await rejects(bar, "plugin:opener|open_url", { url: "https://example.com" })));

const status = await invoke(st, "cloud_status");
check("cloud_status: forma", ["configured", "connected", "loginInProgress"].every((k) => typeof status[k] === "boolean"),
  `configured=${status.configured} connected=${status.connected} login=${status.loginInProgress}`);

// cloud_open: ID no válido o desconocido → error antes de abrir nada.
for (const id of ["", "a/b", "a?b", "a#b", "..", "x".repeat(257), "https://evil.example.com"]) {
  const e = await rejects(bar, "cloud_open", { kind: "mail", id });
  check(`cloud_open rechaza ${JSON.stringify(id.length > 20 ? `${id.slice(0, 10)}…(${id.length})` : id)}`, /no válido/.test(e ?? ""), e ?? "");
}
for (const kind of ["mail", "event", "task"]) {
  const e = await rejects(bar, "cloud_open", { kind, id: "desconocido123" });
  check(`cloud_open ${kind}: id desconocido`, !!e && !/no válido/.test(e), e ?? "");
}
check("cloud_open: kind no válido", !!(await rejects(bar, "cloud_open", { kind: "url", id: "abc" })));

if (status.connected && !authorized) {
  console.log("STOP hay una sesión de Google guardada: no se consulta nada (relanzar con --authorized solo el usuario).");
  await closeSettings();
  process.exit(failures ? 1 : 0);
}

// Sin sesión: signedOut (o config si falta oauth-clients.json), sin red y al instante.
// Con --authorized: solo kind y conteos.
for (const cmd of ["cloud_mail", "cloud_agenda"]) {
  const t = performance.now();
  const f = await invoke(bar, cmd, { force: true });
  const ms = performance.now() - t;
  const shape = f && "data" in f && "error" in f && "updatedAt" in f;
  if (status.connected) {
    const counts = cmd === "cloud_mail"
      ? `inbox=${f.data?.inboxUnread}${f.data?.inboxMore ? "+" : ""} outlook=${f.data?.outlookUnread}${f.data?.outlookMore ? "+" : ""} items=${f.data?.items.length}`
      : `events=${f.data?.events.length} tasks=${f.data?.tasks.length} pending=${f.data?.pendingTasks}`;
    check(`${cmd}: conectado`, shape, `kind=${f.error?.kind ?? "-"} ${counts} ${ms.toFixed(0)} ms`);
  } else {
    const kind = f.error?.kind;
    check(`${cmd}: desconectado`, shape && f.data === null && (kind === "signedOut" || (kind === "config" && !status.configured)) && ms < 1000,
      `kind=${kind} ${ms.toFixed(0)} ms`);
    // Repetir sin force: caché (mismo kind) e igual de rápido.
    const again = await invoke(bar, cmd, { force: false });
    check(`${cmd}: caché`, again.error?.kind === kind);
  }
}
await closeSettings();
console.log(failures ? `${failures} fallo(s)` : "Todo OK");
process.exit(failures ? 1 : 0);
