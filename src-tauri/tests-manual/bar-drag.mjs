// Arrastre real por Win32/CDP: mide antes de soltar, persistencia y formas (D-047).
// Cierra la instancia al terminar y restaura settings.json byte a byte. Sin capturas ni datos personales.
// Requiere el build de desarrollo actual, Vite y CDP; no usar mientras se maneja el ratón.
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pages, connect, invoke, click, sleep } from "./cdp.mjs";

// Variante aislada: ratón de Playwright sobre dist/, sin Tauri ni IPC real.
// node src-tauri/tests-manual/bar-drag.mjs <evidencia> --mock-ipc
if (process.argv.includes("--mock-ipc")) {
  process.env.EVIDENCE_DIR = resolve(process.argv[2] === "--mock-ipc" ? "docs/evidence/JW-34-6F/drag" : process.argv[2] ?? "docs/evidence/JW-34-6F/drag");
  process.argv.push("--bar-drag-only");
  await import("./audit-ui.mjs");
  process.exit(0);
}

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const ps = (file, ...args) => execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL(file, import.meta.url)), ...args.map(String)], { timeout: 15000 }).toString().trim();
const mouse = (...args) => ps("./mouse.ps1", ...args);
const processCount = () => Number(execFileSync("powershell", ["-NoProfile", "-Command", "@(Get-Process jarwis -ErrorAction SilentlyContinue).Count"], { timeout: 5000 }).toString().trim());
const evidence = resolve(process.argv[2] ?? "docs/evidence/JW-34-6B");
const exe = resolve(process.env.JARWIS_TEST_EXE ?? join(root, "target/debug/jarwis.exe"));
if (!exe.startsWith(root + sep) || !existsSync(exe)) throw new Error("El ejecutable de prueba debe existir dentro del repositorio");
mkdirSync(evidence, { recursive: true });
// No tocar ajustes ni aceptar una instancia ajena, incluso si CDP estuviera disponible.
if (processCount() !== 0) throw new Error("Hay otra instancia de jarwis.exe; no se inicia la prueba");
const settingsFile = join(process.env.APPDATA, "com.jarwis.app", "settings.json");
const backupDir = join(root, "target/JW-34-6B");
mkdirSync(backupDir, { recursive: true });
if (existsSync(join(backupDir,"settings.original.json"))) throw new Error("Hay un respaldo pendiente; no se sobrescribe");
const originalBytes = readFileSync(settingsFile);
writeFileSync(join(backupDir, "settings.original.json"), originalBytes);
const isolated = mkdtempSync(join(backupDir, "run-"));
for (const dir of ["roaming", "local", "webview"]) mkdirSync(join(isolated, dir));
const hash=file=>createHash("sha256").update(readFileSync(file)).digest("hex");
const files=["src-tauri/tests-manual/bar-drag.mjs","src-tauri/tests-manual/menu-center.ps1","src-tauri/tests-manual/mouse.ps1","src-tauri/tests-manual/cdp.mjs","src-tauri/src/main.rs","src/styles.css"];
const hashes=Object.fromEntries(files.map(file=>[file,hash(join(root,file))]));
const executableHash=hash(exe);
const checks = [], samples = [], gestures = [], lifecycle = [], interactions = [];
let bar = null, instance = null, failures = 0, executionError = null;
const check = (name, ok) => { checks.push({ name, ok: !!ok }); if (!ok) failures++; console.log(`${ok ? "OK" : "FAIL"} ${name}`); };
const near = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;
const parseRect = (text) => text.split(";").map((r) => { const [x,y,x2,y2] = r.split(",").map(Number); return { x, y, w: x2-x, h: y2-y }; });
async function connectBar() {
  for (let attempt = 0; attempt < 30; attempt++) {
    for (const target of await pages().catch(() => [])) {
      const c = await connect(target);
      if (await c.evaluate("window.__TAURI_INTERNALS__?.metadata.currentWindow.label === 'bar' && !!document.querySelector('.island')")) return c;
      c.close();
    }
    await sleep(300);
  }
  throw new Error("No se encontró la barra con la UI lista en CDP");
}
async function geo(selector = ".island", background = false) {
  const [win, wa] = parseRect(mouse("rect"));
  const ui = await bar.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}), b = el?.getBoundingClientRect();
    const i = document.querySelector('.island').getBoundingClientRect();
    return { d: devicePixelRatio, viewport: [innerWidth, innerHeight], shape: document.querySelector('.island').className,
      island: { x: i.x, y: i.y, w: i.width, h: i.height },
      point: b && [b.x+b.width/2, ${background ? "b.y+1" : "b.y+b.height/2"}] };
  })()`);
  return { win, wa, ...ui, at: ui.point?.map((v,i) => Math.round((i ? win.y : win.x) + v*ui.d)) };
}
async function sample(label) {
  const g = await geo();
  const s = await invoke(bar, "get_settings");
  const disk = JSON.parse(readFileSync(settingsFile, "utf8"));
  const r = { label, ...g, edge: s.edge, offset: s.barOffsets[s.edge], savedOffset: disk.barOffsets[s.edge], order: s.widgetOrder };
  samples.push(r);
  // El marco nativo y el dibujo deben compartir el mismo anclaje, incluso tras un morph.
  const horizontal = s.edge === "top" || s.edge === "bottom";
  const m = Math.round(8*g.d), length = horizontal ? g.wa.w : g.wa.h;
  const size = horizontal ? g.win.w : g.win.h, origin = horizontal ? g.wa.x : g.wa.y;
  const along = origin + Math.max(m, Math.min(length-m-size, Math.round(m+(length-2*m)*r.offset-size/2)));
  const perpendicular = ({ top: g.wa.y+m, bottom: g.wa.y+g.wa.h-m-g.win.h, left: g.wa.x+m, right: g.wa.x+g.wa.w-m-g.win.w })[s.edge];
  check(`${label}: ventana usa la fracción guardada`, near(horizontal ? g.win.x : g.win.y, along) && near(horizontal ? g.win.y : g.win.x, perpendicular) && near(r.offset,r.savedOffset,1e-12));
  check(`${label}: isla dentro de la WebView`, near(g.island.x,4,1) && near(g.island.y,4,1) && near(g.island.w,g.viewport[0]-8,1) && near(g.island.h,g.viewport[1]-8,1));
  return r;
}
async function center() {
  const before = await invoke(bar, "get_settings");
  // El popup es modal: se abre por IPC y se selecciona su único Centrar por
  // ID y rectángulo Win32 del PID propio, sin navegar con teclas.
  const opening = invoke(bar, "bar_menu");
  opening.catch(()=>{});
  await sleep(350);
  const selection = JSON.parse(ps("./menu-center.ps1", "-ProcessId", instance.pid, "-EvidenceFile", join(evidence,"menu-center.json")));
  interactions.push({action:"bar-center",...selection});
  await opening;
  await sleep(700);
  const s = await invoke(bar, "get_settings");
  const unchanged = s.edge === before.edge && s.mode === before.mode && s.minimized === before.minimized;
  check("Centrar conserva borde, modo y presencia", unchanged);
  if (!unchanged) throw new Error("El menú no seleccionó Centrar; se detiene la prueba");
  check("Centrar (bar-center) guarda 0,5", s.barOffsets[s.edge] === 0.5);
  if (s.barOffsets[s.edge] !== 0.5) throw new Error("No se pudo verificar Centrar; se detiene la prueba");
  await sample("centrar");
}
async function dragTo(x, y, source = "grip") {
  const g = await geo(source === "mini" ? ".mini-trigger" : source === "widget" ? 'li.widget[data-id="system"]' : source === "background" ? ".island" : ".grip", source === "background");
  if (!g.at) throw new Error(`No existe el origen de arrastre: ${source}`);
  await bar.evaluate(`window.__barDragStart = null;
    window.addEventListener('pointerdown', (e) => { const t = e.target;
      window.__barDragStart = { grip: !!t.closest('.grip'), mini: !!t.closest('.mini-trigger'),
        widget: t.closest('li.widget')?.dataset.id ?? null, buttons: e.buttons,
        background: t === document.querySelector('.island') || t.matches('.widgets, .actions') };
    }, { capture: true, once: true });`);
  const delta = [x-(g.win.x+g.win.w/2), y-(g.win.y+g.win.h/2)];
  const [drop] = parseRect(mouse("drag", ...g.at, ...g.at.map((v,i) => Math.round(v+delta[i]))));
  const start = await bar.evaluate("window.__barDragStart");
  gestures.push({ source, start, drop });
  check(`ratón real: pointerdown en ${source}`, start?.buttons === 1 && (source === "widget" ? start.widget === "system" : start?.[source]));
  await sleep(700);
  return drop;
}
async function sameEdge(edge, source, direction) {
  await invoke(bar, "set_minimized", { minimized: false });
  await invoke(bar, "patch_settings", { patch: { edge, mode: "compact", autoCompactSeconds: 0 } });
  if (source === "mini") await invoke(bar, "set_minimized", { minimized: true });
  await sleep(700);
  await center();
  const before = await sample(`${edge}/${source}/${direction}: antes`);
  const drop = await dragTo(before.wa.x+before.wa.w/2+direction*(source === "widget" ? 600 : 260), before.win.y+before.win.h/2, source);
  const released = await sample(`${edge}/${source}/${direction}: soltar`);
  check("mismo borde: conserva exactamente el lugar soltado", released.edge === edge && near(released.win.x,drop.x,1) && near(released.win.y,drop.y,1));
  check("mismo borde: modifica y persiste la fracción", Math.abs(released.offset-before.offset)>0.05 && near(released.offset,released.savedOffset,1e-12));
  if (source === "widget") check("salir de la isla desde un icono mueve sin reordenar ni abrir panel", released.order.join() === before.order.join() && !released.shape.includes("panel"));
  await sleep(2200);
  const settled = await sample(`${edge}/${source}/${direction}: tras 2 s`);
  check("tras 2 s no vuelve a otra posición", near(settled.win.x,released.win.x,1) && settled.offset === released.offset);
  // Sin cambiar modo ni reiniciar useReorder: debe limpiar la supresión del clic residual.
  if (source === "widget") await compactClick(`${edge}/${direction}: siguiente clic tras entrega`, "system");
  mouse("move", ...(await geo()).at);
  await sample(`${edge}/${source}/${direction}: pasar el ratón`);
  await invoke(bar, "set_minimized", { minimized: !released.shape.includes("mini") });
  await sleep(700);
  await sample("cambiar presencia");
  await invoke(bar, "set_minimized", { minimized: false });
  await invoke(bar, "patch_settings", { patch: { mode: "expanded" } });
  await sleep(750);
  await sample("expandir");
  await click(bar, 'li[data-id="clock"] button');
  await sleep(900);
  check("clic real abre el panel", await bar.evaluate("!!document.querySelector('.island.panel')"));
  await sample("panel");
  await click(bar, '[data-action="close-panel"]');
  await sleep(750);
  await invoke(bar, "patch_settings", { patch: { mode: "compact" } });
  await sleep(700);
  const end = await sample("regresar a compacto");
  check("las formas y parches conservan la fracción soltada", end.offset === released.offset);
}
async function compactClick(label, id = "clock") {
  check(`${label}: parte de compacto sin panel`, await bar.evaluate("document.querySelector('.island').classList.contains('compact') && !document.querySelector('.island.panel')"));
  const before = await invoke(bar, "get_settings");
  await traceInput();
  // Input CDP entrega pointerdown/up/click de confianza sin devolver el cursor global.
  await click(bar, `li[data-id="${id}"] button`);
  await sleep(850);
  const title = { clock:"Reloj", system:"Sistema" }[id];
  check(`${label}: clic normal abre su panel`, await bar.evaluate(`!!document.querySelector('.island.panel .panel-view[aria-label=${JSON.stringify(title)}]')`));
  const after = await invoke(bar, "get_settings");
  const events = await bar.evaluate("window.__testInput");
  interactions.push({label, events});
  check(`${label}: clic de confianza recibido en el botón`,events.some(e=>e.type==="pointerdown" && e.trusted && e.button && e.widget===id) && events.some(e=>e.type==="click" && e.trusted && e.button && e.widget===id));
  check(`${label}: clic conserva orden y fracción`, after.widgetOrder.join() === before.widgetOrder.join() && after.barOffsets[after.edge] === before.barOffsets[before.edge]);
  await click(bar, '[data-action="close-panel"]');
  await sleep(750);
}
async function reorder(mode) {
  await invoke(bar,"patch_settings",{patch:{edge:"top",mode,autoCompactSeconds:0}});
  await sleep(750);
  const before = await sample(`reordenar ${mode}: antes`);
  // Widgets adyacentes: el recorrido permanece dentro de la fila en ambos modos.
  const a = before.order[1], b = before.order[0], expected = [...before.order];
  expected.splice(expected.indexOf(a), 1);
  expected.splice(expected.indexOf(b), 0, a);
  await traceInput();
  const from = await geo(`li[data-id="${a}"] button`), to = await geo(`li[data-id="${b}"] button`);
  mouse("drag", ...from.at, ...to.at);
  await sleep(750);
  const after = await sample(`reordenar ${mode}: soltar`);
  interactions.push({label:`reordenar ${mode}`,from:from.at,to:to.at,events:await bar.evaluate("window.__testInput")});
  check(`${mode}: ratón guarda el orden exacto`, after.order.join() === expected.join() && JSON.parse(readFileSync(settingsFile,"utf8")).widgetOrder.join() === expected.join());
  check(`${mode}: reordenar no abre panel ni mueve la isla`, !after.shape.includes("panel") && near(after.win.x,before.win.x,1) && near(after.win.y,before.win.y,1) && after.offset === before.offset);
  if (mode === "compact") await compactClick("siguiente clic tras reordenar", a);
}
async function traceInput() {
  await bar.evaluate(`(() => {
    window.__testInput = [];
    if (window.__traceInputInstalled) return;
    window.__traceInputInstalled = true;
    for (const type of ['pointerdown','pointerup','click','dragstart','drop','lostpointercapture']) window.addEventListener(type,e=>window.__testInput.push({type:e.type,widget:e.target.closest('li.widget')?.dataset.id ?? null,button:!!e.target.closest('button'),x:e.clientX,y:e.clientY,trusted:e.isTrusted}),true);
  })()`);
}
async function keyboard() {
  await invoke(bar,"patch_settings",{patch:{mode:"compact"}});
  await sleep(750);
  await bar.evaluate(`document.querySelector('li[data-id="clock"] button').focus()`);
  check("teclado: foco en Reloj compacto", await bar.evaluate(`document.activeElement?.closest('li')?.dataset.id === 'clock'`));
  await bar.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13,text:"\r",unmodifiedText:"\r"});
  await bar.send("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
  await sleep(850);
  check("Enter en compacto abre Reloj",await bar.evaluate(`!!document.querySelector('.island.panel .panel-view[aria-label="Reloj"]')`));
  await click(bar, '[data-action="close-panel"]');
  await sleep(750);
  const before = await sample("Alt+flecha: antes"), expected = [...before.order];
  const index = expected.indexOf("clock");
  [expected[index],expected[index+1]] = [expected[index+1],expected[index]];
  for (const type of ["keyDown","keyUp"]) await bar.send("Input.dispatchKeyEvent",{type,key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39,modifiers:1});
  await sleep(700);
  const after = await sample("Alt+flecha: después");
  check("Alt+flecha en compacto reordena",after.order.join()===expected.join());
  check("Alt+flecha no abre panel ni mueve la isla",!after.shape.includes("panel") && near(after.win.x,before.win.x,1) && near(after.win.y,before.win.y,1) && after.offset===before.offset);
}
async function startApp() {
  if (instance || processCount() !== 0) throw new Error("No se puede lanzar sobre otra instancia");
  // APPDATA aísla la configuración OAuth (no se consulta ninguna credencial).
  // Tauri resuelve settings por KnownFolder de Windows, independiente de esa variable.
  const child = spawn(exe, [], { cwd: root, windowsHide: true, stdio: "ignore", env: {
    ...process.env, APPDATA: join(isolated,"roaming"), LOCALAPPDATA: join(isolated,"local"),
    WEBVIEW2_USER_DATA_FOLDER: join(isolated,"webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${process.env.CDP_PORT ?? "9222"}`,
  } });
  const owned = { child, pid: child.pid, exited: false, done: null };
  owned.done = new Promise((done) => {
    child.once("exit", () => { owned.exited = true; done(); });
    child.once("error", () => { if (!child.pid) { owned.exited = true; done(); } });
  });
  instance = owned;
  await new Promise((ok, fail) => { child.once("spawn", ok); child.once("error", fail); });
  lifecycle.push({ action: "launch", pid: owned.pid });
}
async function stopApp() {
  const owned = instance;
  const method = "pid";
  try { bar?.close(); }
  catch { /* Un CDP roto no impide terminar el PID propio. */ }
  finally { bar = null; }
  if (!owned) return;
  // La desaparición de la ventana no prueba que el proceso haya terminado.
  if (!owned.exited) {
    owned.child.kill(); // Solo el PID devuelto por spawn, también sin CDP o ventana.
  }
  await Promise.race([owned.done, sleep(5000)]);
  if (!owned.exited) throw new Error("El PID lanzado sigue vivo; no se restaurarán ajustes");
  lifecycle.push({ action: "exit", pid: owned.pid, method, exited: owned.exited });
  check(`instancia lanzada terminada por ${method}`, owned.exited);
  instance = null;
}
try {
  writeFileSync(settingsFile, JSON.stringify({ edge:"top", mode:"compact", autoCompactSeconds:0,
    theme:"dark", barOffsets:{top:0.5,bottom:0.5,left:0.5,right:0.5}, barOffsetsCenter:true, clipboardHistory:false, notifications:false,
    alarms:[], shortcuts:[], workspaces:[], bitwardenSeeded:true, shareToday:false }));
  // Regresión real del cierre sin conexión CDP (p. ej. fallo al conectar la UI).
  await startApp();
  await sleep(1000);
  await stopApp();
  check("cierre sin CDP deja cero procesos", processCount() === 0);
  await startApp();
  bar = await connectBar();
  await center();
  await compactClick("compacto inicial");
  await reorder("compact");
  await reorder("expanded");
  await keyboard();
  // Ambos sentidos, desde el asa, el fondo y Mini, en los dos bordes horizontales.
  for (const edge of ["top", "bottom"]) for (const source of ["grip", "background", "mini", "widget"]) for (const direction of [-1,1]) await sameEdge(edge,source,direction);
  for (const edge of ["top", "bottom"]) {
    await invoke(bar,"patch_settings",{patch:{edge,mode:"expanded",autoCompactSeconds:0}});
    await center();
    for (const shape of ["expanded","panel"]) {
      await invoke(bar,"patch_settings",{patch:{mode:"expanded"}});
      await sleep(750);
      if (shape === "panel") await click(bar,'li[data-id="clock"] button');
      await sleep(800);
      const before = await sample(`arrastrar ${shape}/${edge}: antes`);
      check(`${shape}/${edge}: forma inicial correcta`,before.shape.split(" ").includes(shape));
      const drop = await dragTo(before.win.x+before.win.w/2+70,before.win.y+before.win.h/2,"background");
      const released = await sample(`arrastrar ${shape}/${edge}: soltar`);
      check(`${shape}: cambia posición y fracción iniciales`,!near(released.win.x,before.win.x,2) && Math.abs(released.offset-before.offset)>0.01);
      check(`${shape}: conserva el lugar soltado`,released.edge===edge && near(released.win.x,drop.x,1) && near(released.win.y,drop.y,1));
      await sleep(2200);
      const settled = await sample(`arrastrar ${shape}/${edge}: tras 2 s`);
      check(`${shape}: no se recoloca tras 2 s`,near(settled.win.x,released.win.x,1) && settled.offset===released.offset);
      if (shape === "panel") await click(bar,'[data-action="close-panel"]');
      await invoke(bar,"patch_settings",{patch:{mode:"compact"}});
      await sleep(800);
      const compact = await sample(`arrastrar ${shape}/${edge}: compacto`);
      check(`${shape}: compacto conserva el centro soltado`,near(compact.win.x+compact.win.w/2,released.win.x+released.win.w/2,1) && compact.offset===released.offset);
    }
  }
  await invoke(bar,"patch_settings",{patch:{edge:"left",mode:"compact",autoCompactSeconds:0}});
  await sleep(750);
  await center();
  const verticalBefore = await sample("left/widget: antes");
  const verticalDrop = await dragTo(verticalBefore.win.x+verticalBefore.win.w/2,verticalBefore.win.y+verticalBefore.win.h/2-260,"widget");
  const verticalReleased = await sample("left/widget: soltar");
  check("icono vertical: cambia posición y fracción",verticalReleased.edge==="left" && !near(verticalReleased.win.y,verticalBefore.win.y,2) && Math.abs(verticalReleased.offset-verticalBefore.offset)>0.05);
  check("icono vertical: conserva el lugar soltado sin reordenar ni abrir panel",near(verticalReleased.win.x,verticalDrop.x,1) && near(verticalReleased.win.y,verticalDrop.y,1) && verticalReleased.order.join()===verticalBefore.order.join() && !verticalReleased.shape.includes("panel"));
  await sleep(2200);
  const verticalSettled = await sample("left/widget: tras 2 s");
  check("icono vertical: estable tras 2 s",near(verticalSettled.win.y,verticalReleased.win.y,1) && verticalSettled.offset===verticalReleased.offset);
  await compactClick("vertical: siguiente clic tras entrega","system");
  // D-047 también conserva el destino al cambiar de borde.
  await center();
  const { wa } = await geo();
  for (const [edge,x,y] of [["left",wa.x+70,wa.y+wa.h/2],["right",wa.x+wa.w-70,wa.y+wa.h/2],["bottom",wa.x+wa.w/2,wa.y+wa.h-70],["top",wa.x+wa.w/2,wa.y+70]]) {
    await dragTo(x,y,"background");
    const s = await invoke(bar,"get_settings");
    check(`arrastre al borde ${edge}`,s.edge===edge);
    await sample(`borde ${edge}`);
  }
  // Conserva JW-2-10: el destino puede tener otra escala DPI.
  const monitors = mouse("monitors").split(/\r?\n/).map((line) => {
    const [name, bounds] = line.split(";");
    return { name, ...parseRect(bounds)[0] };
  });
  const other = monitors.find((m) => m.x !== wa.x || m.y !== wa.y || m.w !== wa.w || m.h !== wa.h);
  if (other) {
    const originalMonitor = (await invoke(bar,"get_settings")).monitor;
    await dragTo(other.x+other.w/2,other.y+80,"background");
    await sleep(700);
    const s = await invoke(bar,"get_settings");
    check("arrastre real a otro monitor",s.monitor===other.name && s.edge==="top");
    await sample("otro monitor");
    await invoke(bar,"set_minimized",{minimized:true});
    await sleep(700);
    await sample("Mini en otro monitor");
    await invoke(bar,"set_minimized",{minimized:false});
    await invoke(bar,"patch_settings",{patch:{monitor:originalMonitor,edge:"top"}});
    await sleep(750);
    await sample("regresar al monitor original");
  } else console.log("SKIP cambio de monitor: solo hay uno");
  await dragTo(wa.x+wa.w*.8,wa.y+35);
  const moved = await sample("cerca del extremo");
  await invoke(bar,"patch_settings",{patch:{mode:"expanded",autoCompactSeconds:10}});
  await sleep(750);
  await sample("expandido cerca del extremo");
  mouse("move",wa.x+wa.w/2,wa.y+wa.h/2);
  await sleep(11200);
  check("auto-compactar cambia a compacto", (await invoke(bar,"get_settings")).mode === "compact");
  check("auto-compactar conserva la fracción", (await sample("auto-compactar")).offset === moved.offset);
  const order = (await invoke(bar,"get_settings")).widgetOrder;
  const a=order.at(-1), b=order[1];
  mouse("drag", ...(await geo(`li[data-id="${a}"]`)).at, ...(await geo(`li[data-id="${b}"]`)).at);
  await sleep(700);
  check("reordenar con arrastre real", (await invoke(bar,"get_settings")).widgetOrder.indexOf(a)<order.length-1);
  check("reordenar dentro de la fila no abre un panel",await bar.evaluate("!document.querySelector('.island.panel')"));
  check("reordenar conserva la fracción", (await sample("reordenar")).offset === moved.offset);
  const beforeRestart = await sample("antes del reinicio");
  await stopApp();
  await startApp();
  bar = await connectBar();
  const restarted = await sample("reinicio");
  check("el reinicio conserva fracción y posición", restarted.offset===beforeRestart.offset && near(restarted.win.x,beforeRestart.win.x,1) && near(restarted.win.y,beforeRestart.win.y,1));
  await center();
} catch (error) {
  executionError = error.message;
  check("ejecución completa sin excepción",false);
  console.error(error.message);
} finally {
  // Nunca restaurar el archivo con una instancia viva que pueda volver a escribirlo.
  // No volver a simular entrada durante la limpieza si Windows rechazó un gesto.
  try { await stopApp(); }
  catch (error) { check("terminación del PID lanzado",false); console.error(error.message); }
  finally {
    const allExited = instance === null && processCount() === 0;
    check("cero procesos antes de restaurar ajustes",allExited);
    if (allExited) {
      writeFileSync(settingsFile, originalBytes);
      const restored = readFileSync(settingsFile).equals(originalBytes);
      check("settings.json restaurado byte a byte",restored);
      if (restored) unlinkSync(join(backupDir,"settings.original.json"));
    } else check("la app debe estar cerrada antes de restaurar ajustes",false);
    check("fuentes y ejecutable conservan sus hashes", files.every(file=>hash(join(root,file))===hashes[file]) && hash(exe)===executableHash);
    writeFileSync(join(evidence,"results.json"),JSON.stringify({hashes,executableHash,centerRoute:"bar_menu → ID/rectángulo Win32 de Centrar (PID propio) → bar-center",executionError,checks,failures,samples,gestures,lifecycle,interactions},null,2));
  }
}
console.log(`${checks.length} comprobaciones, ${failures} fallos`);
process.exit(failures ? 1 : 0);
