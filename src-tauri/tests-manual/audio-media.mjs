// Verificación en vivo de JW-3-02 (audio y multimedia, núcleo) por CDP.
//   node src-tauri/tests-manual/audio-media.mjs
// Cambia el volumen y el silencio y RESTAURA los valores originales. No abre
// Configuración ni envía órdenes multimedia (solo comprueba la forma del comando).
// Privacidad: de la sesión multimedia solo imprime appId y longitud del título.
import { pages, connect, invoke } from "./cdp.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`);
};
const rejects = (page, cmd, args = {}) =>
  page.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(() => null, (e) => String(e))`);

let bar = null;
for (const t of (await pages()).filter((t) => t.url.startsWith("http://tauri.localhost"))) {
  const p = await connect(t);
  if ((await p.evaluate("window.__TAURI_INTERNALS__.metadata.currentWindow.label")) === "bar") bar = p;
  else p.close();
}
if (!bar) throw new Error("No se encontró la ventana «bar»: ¿se lanzó la app con --remote-debugging-port?");

// Audio.
const a = await invoke(bar, "audio_state");
const devs = await invoke(bar, "list_audio_devices");
check("list_audio_devices", Array.isArray(devs) && devs.every((d) => "id" in d && "name" in d && "isDefault" in d), `n=${devs.length} predeterminados=${devs.filter((d) => d.isDefault).length}`);
if (a === null) {
  console.log("SKIP sin dispositivo de salida");
} else {
  check("audio_state: forma", Number.isInteger(a.volume) && a.volume >= 0 && a.volume <= 100 && typeof a.muted === "boolean" && typeof a.deviceName === "string", `volume=${a.volume} muted=${a.muted}`);
  check("un único predeterminado", devs.filter((d) => d.isDefault).length === 1);
  const target = a.volume >= 50 ? a.volume - 7 : a.volume + 7;
  let t = performance.now();
  try {
    await invoke(bar, "set_volume", { volume: target });
    check("set_volume", (await invoke(bar, "audio_state")).volume === target, `${a.volume} → ${target} en ${(performance.now() - t).toFixed(0)} ms`);
    await invoke(bar, "set_volume", { volume: 150 });
    check("set_volume acota a 100", (await invoke(bar, "audio_state")).volume === 100);
    await invoke(bar, "set_volume", { volume: a.volume });
    await invoke(bar, "set_muted", { muted: !a.muted });
    check("set_muted", (await invoke(bar, "audio_state")).muted === !a.muted);
  } finally {
    await invoke(bar, "set_volume", { volume: a.volume });
    await invoke(bar, "set_muted", { muted: a.muted });
    const r = await invoke(bar, "audio_state");
    check("restaurado", r.volume === a.volume && r.muted === a.muted, `volume=${r.volume} muted=${r.muted}`);
  }
  check("set_volume: tipo no válido", !!(await rejects(bar, "set_volume", { volume: "x" })));
}

// Multimedia: solo lectura.
const m = await invoke(bar, "media_state");
if (m === null) console.log("     media_state: sin sesión");
else check("media_state: forma", ["title", "artist", "playing", "canPrev", "canNext", "canPlayPause", "appId"].every((k) => k in m), `appId=${m.appId} titleLen=${m.title.length} playing=${m.playing}`);
check("media_control: acción no válida", !!(await rejects(bar, "media_control", { action: "stop" })));
if (m === null) {
  // Sin sesión no se interrumpe nada: la orden debe fallar con mensaje.
  const e = await rejects(bar, "media_control", { action: "next" });
  check("media_control sin sesión", /No hay ninguna/.test(e ?? ""), e ?? "");
}
console.log(failures ? `${failures} fallo(s)` : "Todo OK");
process.exit(failures ? 1 : 0);
