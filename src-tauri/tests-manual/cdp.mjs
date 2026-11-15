// Cliente CDP mínimo (Chrome DevTools Protocol) para verificar JarWis sobre WebView2.
// Sin dependencias: fetch y WebSocket nativos de Node 24. Ver verify.mjs.

const PORT = process.env.CDP_PORT ?? "9222";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Páginas de la app (las ventanas Tauri sirven desde http://tauri.localhost). */
export async function pages() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return (await res.json()).filter((t) => t.type === "page");
}

export async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, err) => {
    ws.onopen = ok;
    ws.onerror = err;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, err } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? err(new Error(JSON.stringify(msg.error))) : ok(msg.result);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
      logs.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      logs.push(`exception: ${d.exception?.description ?? d.text}`);
    } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      logs.push(`log.error: ${msg.params.entry.text}`);
    }
    listeners.get(msg.method)?.(msg.params);
  };
  const send = (method, params = {}) =>
    new Promise((ok, err) => {
      const n = ++id;
      pending.set(n, { ok, err });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  /** Evalúa en la página; `timeout` detecta un hilo principal bloqueado (invoke sin respuesta). */
  const evaluate = async (expression, timeout = 5000) => {
    const r = await Promise.race([
      send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
      sleep(timeout).then(() => {
        throw new Error(`TIMEOUT ${timeout} ms: ${expression.slice(0, 60)}`);
      }),
    ]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const once = (method, timeout = 3000) =>
    Promise.race([
      new Promise((ok) => listeners.set(method, (p) => (listeners.delete(method), ok(p)))),
      sleep(timeout).then(() => null),
    ]);
  await send("Runtime.enable");
  await send("Log.enable");
  return { send, evaluate, once, logs, close: () => ws.close() };
}

export const invoke = (page, cmd, args = {}) =>
  page.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

/** Restaura el orden con movimientos sobre la lista vigente, sin enviar una copia completa. */
export async function restoreWidgetOrder(page, order) {
  for (const [index, id] of order.entries()) {
    const current = (await invoke(page, "get_settings")).widgetOrder;
    if (current.includes(id) && current[index] !== id) {
      await invoke(page, "widget_move", { id, target: current[index] });
    }
  }
}

export async function center(page, selector) {
  const r = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })()`);
  if (!r) throw new Error(`no existe ${selector}`);
  return r;
}

/** Clic real con Input.dispatchMouseEvent en el centro de `selector`. */
export async function click(page, selector) {
  const { x, y } = await center(page, selector);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

/**
 * Arrastre con el ratón de `from` a `to`. Con Input.setInterceptDrags el
 * navegador entrega el arrastre a CDP (Input.dragIntercepted) en vez de iniciar
 * el arrastre del SO, y se completa con Input.dispatchDragEvent.
 * Devuelve true si el navegador llegó a iniciar el arrastre (hubo dragstart).
 */
export async function drag(page, from, to) {
  const a = await center(page, from);
  const b = await center(page, to);
  await page.send("Input.setInterceptDrags", { enabled: true });
  const intercepted = page.once("Input.dragIntercepted");
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    const x = a.x + ((b.x - a.x) * i) / 8;
    const y = a.y + ((b.y - a.y) * i) / 8;
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  }
  const ev = await intercepted;
  if (ev) {
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await page.send("Input.dispatchDragEvent", { type, x: b.x, y: b.y, data: ev.data });
    }
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 });
  await page.send("Input.setInterceptDrags", { enabled: false });
  return !!ev;
}

/** Captura solo el contenido de la página (no el escritorio de detrás). */
export async function screenshot(page, path, background) {
  const { writeFile } = await import("node:fs/promises");
  if (background) await page.send("Emulation.setDefaultBackgroundColorOverride", { color: background });
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  if (background) await page.send("Emulation.setDefaultBackgroundColorOverride", {});
  await writeFile(path, Buffer.from(data, "base64"));
}
