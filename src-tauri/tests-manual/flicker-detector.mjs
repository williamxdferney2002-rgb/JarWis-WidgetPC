// Detector puro: PNG de CDP, rejilla de superficie y regiones de contenido.
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

export function decodePng(buffer) {
  assert.equal(buffer.subarray(1, 4).toString(), 'PNG');
  let width, height, channels; const chunks = [];
  for (let p = 8; p < buffer.length;) {
    const n = buffer.readUInt32BE(p), type = buffer.toString('ascii', p + 4, p + 8), data = buffer.subarray(p + 8, p + 8 + n);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8); assert.equal(data[12], 0);
      channels = ({2: 3, 6: 4})[data[9]]; assert.ok(channels, 'PNG RGB/RGBA requerido');
    }
    if (type === 'IDAT') chunks.push(data);
    p += n + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels;
  assert.equal(raw.length, (stride + 1) * height);
  const pixels = new Uint8Array(width * height * 4), rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[y * stride + x - channels] : 0;
      const b = y ? rows[(y - 1) * stride + x] : 0;
      const c = y && x >= channels ? rows[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
      const predictor = [0, a, b, Math.floor((a + b) / 2), da <= db && da <= dc ? a : db <= dc ? b : c][filter];
      rows[y * stride + x] = raw[y * (stride + 1) + 1 + x] + predictor;
    }
    for (let x = 0; x < width; x++) {
      const src = y * stride + x * channels, dst = (y * width + x) * 4;
      pixels[dst]=rows[src]; pixels[dst+1]=rows[src+1]; pixels[dst+2]=rows[src+2]; pixels[dst+3]=channels===4?rows[src+3]:255;
    }
  }
  return {width, height, pixels};
}

function region(image, box) {
  const [x, y, w, h] = box; let count = 0, alpha = 0, light = 0, ink = 0;
  for (let j = Math.max(0, Math.ceil(y)); j < Math.min(image.height, y + h); j++) {
    for (let i = Math.max(0, Math.ceil(x)); i < Math.min(image.width, x + w); i++) {
      const p = (j * image.width + i) * 4, a = image.pixels[p + 3] / 255;
      const l = (0.2126 * image.pixels[p] + 0.7152 * image.pixels[p + 1] + 0.0722 * image.pixels[p + 2]) / 255;
      count++; alpha += a; light += l * a; ink += a > 0.78 && l > 0.28 ? 1 : 0;
    }
  }
  return {count, alpha: alpha / Math.max(1, count), light: light / Math.max(1, count), ink};
}

export function describe(image, meta) {
  const scale = image.width / meta.viewport[0];
  const box = r => r.map(v => v * scale);
  const [x, y, w, h] = box(meta.rect), grid = [];
  // Interior: no contar el brillo del borde como contenido.
  for (let j = 0; j < 4; j++) for (let i = 0; i < 8; i++) {
    grid.push(region(image, [x + 4 + i * (w - 8) / 8, y + 4 + j * (h - 8) / 4, (w - 8) / 8, (h - 8) / 4]));
  }
  const anchors = meta.anchors.map(r => region(image, box(r)));
  return {state: meta.state, rect: meta.rect, grid, anchors};
}

export function compare(sample, reference, {settled = false} = {}) {
  const defects = [];
  if (sample.state !== reference.state) return ['estado sin referencia'];
  for (let i = 0; i < sample.grid.length; i++) {
    const a = sample.grid[i], b = reference.grid[i];
    if (a.count < 4) { defects.push(`superficie fuera de captura:${i}`); continue; }
    if (b.alpha > 0.7 && a.alpha < b.alpha * 0.55) defects.push(`superficie ausente:${i}`);
    if (a.light > b.light + 0.30) defects.push(`destello:${i}`);
    if (settled && b.ink >= 12 && a.ink < b.ink * 0.35) defects.push(`contenido regional ausente:${i}`);
  }
  if (sample.anchors.length !== reference.anchors.length) defects.push('regiones de contenido incompletas');
  for (let i = 0; i < reference.anchors.length; i++) {
    const a = sample.anchors[i], b = reference.anchors[i];
    if (b.count < 4 || b.ink < 10) continue; // Región vacía/oculta también en la referencia.
    if (!a || a.count < 4) { defects.push(`contenido fuera de captura:${i}`); continue; }
    // La densidad permite el cambio de ancho del texto durante el morph.
    if (b.ink >= 10 && a.ink / a.count < (b.ink / b.count) * 0.35) defects.push(`contenido ausente:${i}`);
    if (a.light > b.light + 0.30) defects.push(`luminancia de contenido:${i}`);
  }
  return defects;
}

export function nativeDefects(rect, monitor, edge) {
  const [mx, my, mw, mh, dpi] = monitor, margin = Math.round(8 * dpi / 96);
  const [x, y, w, h] = rect, horizontal = edge === 'top' || edge === 'bottom';
  const along = horizontal ? mx + Math.round((mw - w) / 2) : my + Math.round((mh - h) / 2);
  const across = ({top: my + margin, bottom: my + mh - margin - h, left: mx + margin, right: mx + mw - margin - w})[edge];
  return Math.abs((horizontal ? x : y) - along) > 1 || Math.abs((horizontal ? y : x) - across) > 1;
}

export function domDefects(meta, edge) {
  const [x, y, w, h] = meta.rect, [vw, vh] = meta.viewport;
  // Fracción neutra 0,5: incluso durante el morph la isla conserva el centro.
  const horizontal = edge === 'top' || edge === 'bottom';
  const along = horizontal ? x + w / 2 - vw / 2 : y + h / 2 - vh / 2;
  const across = horizontal ? y - 4 : x - 4;
  return Math.abs(along) > 2 || Math.abs(across) > 2;
}

export function coverage(frames, clickAt, stableAt, endAt) {
  const times = frames.map(f => (f.start + f.end) / 2).filter(t => t >= clickAt && t <= endAt);
  const gaps = [times[0] - clickAt, ...times.slice(1).map((t, i) => t - times[i]), endAt - times.at(-1)];
  const maxGapMs = times.length ? Math.max(...gaps, ...frames.map(f => f.end - f.start)) : null;
  const reasons = [];
  if (times.length < 10) reasons.push('menos de 10 capturas');
  if (times.filter(t => t <= stableAt).length < 4) reasons.push('menos de 4 capturas hasta estabilizar');
  if (maxGapMs === null || maxGapMs > 50) reasons.push('hueco o incertidumbre de captura superior a 50 ms');
  if (endAt < stableAt + 150) reasons.push('sin 150 ms de cobertura estable');
  return {measured: reasons.length === 0, reasons, maxGapMs, samples: times.length};
}

export function selfTest() {
  const width = 320, height = 160;
  const base = {width, height, pixels: new Uint8Array(width * height * 4)};
  function fill(image, x, y, w, h, color) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) image.pixels.set(color, (j * width + i) * 4);
  }
  fill(base, 0, 0, width, height, [22, 24, 30, 255]);
  const meta = {state:'panel', viewport:[width,height], rect:[0,0,width,height], anchors:[]};
  for (let y = 16; y < 140; y += 40) for (let x = 16; x < 290; x += 64) {
    fill(base, x, y, 24, 8, [220,225,230,255]); meta.anchors.push([x,y,24,8]);
  }
  const ref = describe(base, meta), cases = [];
  const test = (name, edit) => {
    const image = {...base, pixels: base.pixels.slice()}; edit(image);
    const defects = compare(describe(image, meta), ref, {settled:true});
    assert.ok(defects.length, `Control negativo no detectado: ${name}`); cases.push({name,detected:true,defects: defects.length});
  };
  assert.deepEqual(compare(ref, ref, {settled:true}), []);
  test('destello blanco', i => fill(i, 0, 0, width, height, [255,255,255,255]));
  test('superficie vacía', i => fill(i, 0, 0, width, height, [22,24,30,255]));
  test('superficie oscura con cuadrado 8×8', i => { fill(i,0,0,width,height,[22,24,30,255]); fill(i,20,20,8,8,[255,255,255,255]); });
  test('desaparición parcial', i => fill(i, 0, 70, width, 90, [22,24,30,255]));
  test('salto visual de posición', i => {fill(i,0,0,width,height,[22,24,30,255]); for(let y=0;y<height-20;y++)for(let x=0;x<width-32;x++)i.pixels.set(base.pixels.subarray((y*width+x)*4,(y*width+x)*4+4),((y+20)*width+x+32)*4);});
  assert.ok(nativeDefects([120,10,320,160],[0,0,1000,800,120],'top'));
  cases.push({name:'salto nativo de posición',detected:true});
  assert.equal(domDefects({rect:[4,4,312,152],viewport:[320,160]},'top'),false);
  assert.ok(domDefects({rect:[36,4,312,152],viewport:[320,160]},'top'));
  assert.ok(domDefects({rect:[4,36,312,152],viewport:[320,160]},'left'));
  cases.push({name:'salto DOM junto con su contenido',detected:true});
  assert.equal(coverage([],0,300,500).measured,false);
  assert.equal(coverage([{start:0,end:10}],0,300,500).measured,false);
  assert.equal(coverage(Array.from({length:20},(_,i)=>({start:i*30,end:i*30+4})),0,300,580).measured,true);
  assert.equal(coverage(Array.from({length:20},(_,i)=>({start:i*60,end:i*60+4})),0,900,1150).measured,false);
  return {passed:true,cases,temporalControls:4};
}
