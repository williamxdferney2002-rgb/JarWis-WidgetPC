// Verificación de JW-2-05 (reloj) por CDP. Requisitos en README.md de esta carpeta.
//   node src-tauri/tests-manual/clock.mjs [carpeta-capturas] [--alarm]
// --alarm: espera además a que suene una alarma real (≤ 2 min).
// Restaura los ajustes originales al terminar (sin alarmas de prueba). Nunca toca «Iniciar con Windows».
import { execFileSync } from "node:child_process";
import { pages, connect, invoke, click, screenshot, sleep } from "./cdp.mjs";

const shots = process.argv.slice(2).find((a) => !a.startsWith("--"));
const withAlarm = process.argv.includes("--alarm");
const GREY = { r: 128, g: 128, b: 128, a: 1 };
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`);
};

/** Número de notificaciones de la app en el Centro de actividades (solo el recuento). */
const toastCount = () => {
  const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($id) | Measure-Object | ForEach-Object Count`;
  try {
    return Number(execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim());
  } catch (e) {
    console.log("recuento de notificaciones no disponible:", String(e.message).split(/\r?\n/)[0]);
    return NaN;
  }
};

const bar = await (async () => {
  for (const t of (await pages()).filter((t) => t.url.startsWith("http://tauri.localhost"))) {
    const p = await connect(t);
    if ((await p.evaluate("window.__TAURI_INTERNALS__.metadata.currentWindow.label")) === "bar") return p;
    p.close();
  }
  throw new Error("No se encontró la ventana «bar»: ¿se lanzó la app con --remote-debugging-port?");
})();
await bar.send("Page.enable");
const size = () => bar.evaluate("[innerWidth, innerHeight].join('x')");
const island = () => bar.evaluate("document.querySelector('.island').className");
const text = (sel) => bar.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
/** Valor en un input controlado por React (setter nativo + evento input). */
const setValue = (sel, value) =>
  bar.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
const waitFor = async (expr, ms) => {
  for (let t = 0; t < ms; t += 200) {
    if (await bar.evaluate(expr)) return true;
    await sleep(200);
  }
  return false;
};
const secs = (s) => {
  const [m, rest] = s.split(":");
  return Number(m) * 60 + Number(rest);
};

const original = await invoke(bar, "get_settings");
const removeTestAlarms = async () => {
  for (const alarm of (await invoke(bar, "get_settings")).alarms.filter((a) => a.label.startsWith("Prueba JW"))) {
    await invoke(bar, "alarm_remove", { id: alarm.id });
  }
};
try {
  await removeTestAlarms();
  await invoke(bar, "patch_settings", { patch: { edge: "top", mode: "expanded" } });
  await sleep(700);

  // Iconos de color y badge de correo de ejemplo (solo para la captura; se quita después).
  if (shots) {
    const badge = `document.querySelector('li[data-id="mail"] .badge-wrap').insertAdjacentHTML('beforeend', '<span class="badge" id="demo-badge">3</span>')`;
    await bar.evaluate(badge);
    await sleep(300);
    await screenshot(bar, `${shots}/JW-2-05-expanded-icons.png`, GREY);
    await invoke(bar, "patch_settings", { patch: { islandColor: "royal" } });
    await sleep(400);
    await screenshot(bar, `${shots}/JW-2-05-royal-muted.png`, GREY);
    await invoke(bar, "patch_settings", { patch: { islandColor: "black" } });
    await bar.evaluate("document.getElementById('demo-badge')?.remove()");
  }
  check("pulso activado por defecto", (await invoke(bar, "get_settings")).pulseAnimation === true);

  // 1. Abrir el panel con un clic en el reloj.
  await click(bar, 'li[data-id="clock"]');
  await sleep(600);
  check("panel: ventana ampliada", (await size()) === "720x300", await size());
  check("panel: isla en forma de panel", (await island()).includes("panel"));

  // 2. Cronómetro.
  await click(bar, '[data-action="start"]');
  await sleep(1300);
  const run1 = await text('[data-testid="stopwatch"]');
  check("cronómetro corre", secs(run1) >= 1.1, run1);
  await click(bar, '[data-action="lap"]');
  await sleep(300);
  await click(bar, '[data-action="pause"]');
  const p1 = await text('[data-testid="stopwatch"]');
  await sleep(600);
  const p2 = await text('[data-testid="stopwatch"]');
  check("cronómetro pausado no avanza", p1 === p2, `${p1} = ${p2}`);
  check("vuelta registrada", (await bar.evaluate("document.querySelectorAll('[aria-label=Vueltas] li:not(.empty)').length")) === 1);
  if (shots) await screenshot(bar, `${shots}/JW-2-05-stopwatch.png`, GREY);
  await click(bar, '[data-action="reset"]');

  // 3. Temporizadores: uno de 10 min (preajuste) y otro de 5 s.
  await click(bar, '[data-tab="timers"]');
  await sleep(300);
  await bar.evaluate(`document.querySelector('[aria-label="Nombre del temporizador"]').value = "Prueba JW té"`);
  await click(bar, '[data-preset="10"]');
  await sleep(300);
  await setValue('[aria-label="Minutos"]', "0");
  await setValue('[aria-label="Segundos"]', "5");
  await click(bar, '[data-action="add-timer"]');
  await sleep(400);
  const timers = (await invoke(bar, "clock_state")).timers;
  check("temporizadores creados", timers.length === 2, timers.map((t) => t.durationMs).join(","));
  if (shots) await screenshot(bar, `${shots}/JW-2-05-timers.png`, GREY);

  // Panel cerrado y modo compacto: el aviso debe expandir la isla.
  await click(bar, '[data-action="close-panel"]');
  await invoke(bar, "patch_settings", { patch: { mode: "compact" } });
  await sleep(800);
  check("compacto: ventana encogida", (await size()) === "340x44", await size());
  check("compacto: indicador del temporizador", !!(await text(".time-badge")), await text(".time-badge"));
  const toastsBefore = toastCount();
  const fired = await waitFor("!!document.querySelector('.alert-view')", 8000);
  await sleep(500);
  check("temporizador vence: aviso en la isla", fired);
  check("aviso: isla expandida", (await size()) === "720x112" && (await island()).includes("expanded"), await size());
  check("aviso: solo «Detener»", !!(await text('[data-action="stop"]')) && !(await text('[data-action="snooze"]')));
  const toastsAfter = toastCount();
  check("notificación de Windows registrada", toastsAfter === toastsBefore + 1, `${toastsBefore} -> ${toastsAfter}`);
  if (shots) await screenshot(bar, `${shots}/JW-2-05-alert.png`, GREY);
  await click(bar, '[data-action="stop"]');
  await sleep(900);
  check("detener: aviso retirado y ventana compacta", !(await bar.evaluate("!!document.querySelector('.alert-view')")) && (await size()) === "340x44", await size());
  for (const t of (await invoke(bar, "clock_state")).timers) await invoke(bar, "timer_control", { id: t.id, action: "cancel" });

  // 4. Alarmas: crear desde el panel.
  await click(bar, 'li[data-id="clock"]');
  await sleep(600);
  await click(bar, '[data-tab="alarms"]');
  await sleep(300);
  await setValue('[aria-label="Hora"]', "06:45");
  await setValue('[aria-label="Nombre de la alarma"]', "Prueba JW gimnasio");
  await click(bar, '[title="lunes"]');
  await click(bar, '[title="viernes"]');
  await click(bar, '[data-action="add-alarm"]');
  await sleep(500);
  const saved = (await invoke(bar, "get_settings")).alarms.find((a) => a.label === "Prueba JW gimnasio");
  check("alarma guardada en los ajustes", saved?.hour === 6 && saved?.minute === 45 && saved?.days.join() === "0,4", JSON.stringify(saved && { ...saved, label: "…" }));
  if (shots) await screenshot(bar, `${shots}/JW-2-05-alarms.png`, GREY);

  if (withAlarm) {
    const d = new Date(Date.now() + 60_000);
    await setValue('[aria-label="Hora"]', `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
    await setValue('[aria-label="Nombre de la alarma"]', "Prueba JW real");
    // Una sola vez: se quitan los días marcados antes.
    await click(bar, '[title="lunes"]');
    await click(bar, '[title="viernes"]');
    await click(bar, '[data-action="add-alarm"]');
    await click(bar, '[data-action="close-panel"]');
    const rang = await waitFor("document.querySelector('.alert-view')?.getAttribute('aria-label') === 'Alarma'", 125_000);
    check("alarma real suena", rang);
    check("alarma: botón posponer", !!(await text('[data-action="snooze"]')));
    await click(bar, '[data-action="snooze"]');
    await sleep(900);
    const once = (await invoke(bar, "get_settings")).alarms.find((a) => a.label === "Prueba JW real");
    check("alarma de una vez queda desactivada", once && !once.enabled);
    check("posponer: aviso retirado", !(await bar.evaluate("!!document.querySelector('.alert-view')")));
  }
  check("barra: sin errores de consola", bar.logs.length === 0, bar.logs.join(" | "));
} finally {
  if (await bar.evaluate("!!document.querySelector('[data-action=close-panel]')")) await click(bar, '[data-action="close-panel"]');
  // --keep: conserva las alarmas de prueba para comprobarlas tras reiniciar el exe.
  if (!process.argv.includes("--keep")) {
    await removeTestAlarms();
    await invoke(bar, "patch_settings", { patch: { edge: original.edge, mode: original.mode, islandColor: original.islandColor } }).catch((e) => console.log("No se restauró:", e.message));
  }
}
console.log(failures ? `\n${failures} comprobaciones fallidas` : "\nTodas las comprobaciones OK");
bar.close();
await sleep(200);
process.exitCode = failures ? 1 : 0;
