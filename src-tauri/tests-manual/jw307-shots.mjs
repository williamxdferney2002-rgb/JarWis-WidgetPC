// Capturas de JW-3-07: expandida horizontal, vertical y compacta. Restaura los ajustes.
import { pages, connect, invoke, screenshot, sleep } from "./cdp.mjs";
const dir = process.argv[2] ?? "docs/evidence";
let bar;
for (const t of (await pages()).filter((t) => t.url.startsWith("http://tauri.localhost"))) {
  const p = await connect(t);
  if ((await p.evaluate("window.__TAURI_INTERNALS__.metadata.currentWindow.label")) === "bar") { bar = p; break; }
  p.close();
}
await bar.send("Page.enable");
const orig = await invoke(bar, "get_settings");
const bg = { r: 128, g: 128, b: 128, a: 1 };
try {
  for (const [name, edge, mode] of [["expanded-horizontal", "top", "expanded"], ["expanded-vertical", "left", "expanded"], ["compact", "top", "compact"]]) {
    await invoke(bar, "patch_settings", { patch: { edge, mode, theme: "dark" } });
    await sleep(900);
    console.log(name, await bar.evaluate(`[...document.querySelectorAll(".tile-head,.tile-sub")].filter(e=>e.scrollWidth>e.clientWidth).map(e=>e.innerText)`));
    await screenshot(bar, `${dir}/JW-3-07-${name}.png`, bg);
  }
} finally {
  await invoke(bar, "patch_settings", { patch: { edge: orig.edge, mode: orig.mode, theme: orig.theme } });
}
process.exit(0);
