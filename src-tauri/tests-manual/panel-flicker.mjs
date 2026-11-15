// Abre/cierra cuatro paneles con datos ficticios; captura CDP y geometría Win32 por fotograma.
// Sin dependencias nuevas. Vite estable + cargo build --locked --offline antes de ejecutar.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, unlinkSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodePng, describe, compare, nativeDefects, domDefects, coverage, selfTest } from './flicker-detector.mjs';
import { pages, connect, invoke, click, center, sleep } from './cdp.mjs';

// Los controles se ejecutan ANTES de consultar procesos, modificar ajustes o lanzar la app.
const autotest = selfTest();
console.log(JSON.stringify({autotest}));
if (process.argv.includes('--self-test')) process.exit(0);
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const evidence = resolve(process.argv[2] ?? 'docs/evidence/JW-34-6E/after');
const cycles = Number(process.env.FLICKER_CYCLES ?? 10);
const quick = process.env.FLICKER_QUICK === '1';
if(!Number.isInteger(cycles)||cycles<1||cycles>10) throw new Error('FLICKER_CYCLES debe estar entre 1 y 10');
const count = () => Number(execFileSync('powershell', ['-NoProfile','-Command','@(Get-Process jarwis -ErrorAction SilentlyContinue).Count']).toString().trim());
const exe = resolve(process.env.JARWIS_TEST_EXE ?? join(root,'target/debug/jarwis.exe'));
if (!exe.startsWith(root+sep) || !existsSync(exe) || count()) throw new Error('Se requiere ejecutable local y cero instancias de JarWis');
const settingsFile = join(process.env.APPDATA,'com.jarwis.app/settings.json');
const backup = join(root,'target/JW-34-6E');
mkdirSync(backup,{recursive:true}); mkdirSync(evidence,{recursive:true});
const original = existsSync(settingsFile) ? readFileSync(settingsFile) : null;
const backupFile = join(backup,'settings.original.json');
if (existsSync(backupFile)) throw new Error('Ya existe un respaldo pendiente; no se sobrescribe');
if (original) writeFileSync(backupFile,original);
const isolated = mkdtempSync(join(backup,'run-'));
for (const d of ['roaming','local','webview']) mkdirSync(join(isolated,d));
const settings = {edge:'top',mode:'compact',minimized:false,autoCompactSeconds:0,barStyle:'classic',theme:'dark',
  barOffsets:{top:0.5,bottom:0.5,left:0.5,right:0.5},barOffsetsCenter:true,clipboardHistory:false,
  notifications:false,alarms:[],shortcuts:[],workspaces:[],bitwardenSeeded:true,shareToday:false};
// Solo geometría, preferencias neutras y eventos atraviesan IPC. Todo dato/acción externa se simula.
const mock = `(() => {
  window.__flickerMock=true;
  const realFetch=window.fetch.bind(window);
  const allowed=new Set(['get_settings','patch_settings','set_panel','set_minimized','bar_track','plugin:event|listen','plugin:event|unlisten']);
  const feed=data=>({data,error:null,updatedAt:Date.now()});
  const fake={flicker_mock_ping:()=>true,cloud_mail:()=>feed({inboxUnread:1,outlookUnread:0,inboxMore:false,outlookMore:false,
    items:[{id:'fake',source:'gmail',from:'jarwis-prueba',subject:'Datos ficticios',date:1}]}),
    cloud_agenda:()=>feed({events:[],tasks:[],pendingTasks:0,tasksPartial:false}),
    cloud_status:()=>({configured:false,connected:false,loginInProgress:false}),
    clipboard_list:()=>({items:[],paused:false,enabled:false}),clock_state:()=>({timers:[],alerts:[]}),
    system_snapshot:()=>null,audio_state:()=>null,media_state:()=>null};
  window.fetch=async(url,init)=>{
    const value=String(url); if(!value.includes('ipc.localhost/')) return realFetch(url,init);
    const cmd=decodeURIComponent(value.split('ipc.localhost/')[1].split(/[?#]/)[0]);
    if(allowed.has(cmd)) return realFetch(url,init);
    const ok=Object.hasOwn(fake,cmd);
    return new Response(JSON.stringify(ok?fake[cmd]():'Acción ficticia bloqueada'),{headers:{'Tauri-Response':ok?'ok':'error','content-type':'application/json'}});
  };
})()`;
let app, probe, bar, appDone, exited=false, pending=null, failed=false;
let interrupted=false;
process.on('SIGINT',()=>{interrupted=true;});
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceFiles = ['src-tauri/src/main.rs','src/styles.css','src/Bar.tsx','src-tauri/src/layout.rs','src-tauri/tests-manual/panel-flicker.mjs','src-tauri/tests-manual/flicker-detector.mjs','src-tauri/tests-manual/frame-geometry.ps1','src-tauri/tests-manual/cdp.mjs','src-tauri/tests-manual/vite-stable.config.mjs'];
const hashes = Object.fromEntries(sourceFiles.map(f=>[f,hash(resolve(root,f))]));
const results={autotest,hashes,executableHash:hash(exe),cycles,quick,startedAt:new Date().toISOString(),references:[],method:'CDP PNG encadenado + GetWindowRect (Sleep 1 ms; cadencia efectiva registrada); sin escritorio',runs:[],restored:false,closed:false};
const probeCommand = line => new Promise((ok,fail)=>{
  if(pending) return fail(new Error('Sonda ocupada'));
  const timer=setTimeout(()=>{pending=null;fail(new Error('Sonda sin respuesta'));},5000);
  pending={ok:v=>{clearTimeout(timer);ok(v);}}; probe.stdin.write(line+'\n');
});
async function connectBar() {
  for(let i=0;i<40;i++) {
    for(const target of await pages().catch(()=>[])) {
      const p=await connect(target);
      if(await p.evaluate("window.__TAURI_INTERNALS__?.metadata.currentWindow.label === 'bar'")) return p;
      p.close();
    }
    await sleep(250);
  }
  throw new Error('No se encontró CDP');
}
// Solo metadatos geométricos; nunca texto ni atributos con datos personales.
const snapshot = `(() => {
  const island=document.querySelector('.island'), r=island.getBoundingClientRect();
  const box=e=>{const b=e.getBoundingClientRect();return [b.x,b.y,b.width,b.height];};
  const state=island.classList.contains('panel')?'panel':'compact';
  const selector=state==='panel'?'.panel-view strong,.panel-view p,.panel-view button,.panel-view svg,.panel-view img':'.widgets svg,.widgets img,.actions svg';
  return {t:performance.now(),state,viewport:[innerWidth,innerHeight],rect:box(island),
    opacity:Number(getComputedStyle(island).opacity),anchors:[...document.querySelectorAll(selector)].map(box),
    active:island.getAnimations().filter(a=>a.playState==='running').length};
})()`;
const references = new Map();
async function stableReference(key) {
  const samples=[];
  for(let i=0;i<3;i++) {
    const meta=await bar.evaluate(snapshot);
    const {data}=await bar.send('Page.captureScreenshot',{format:'png'});
    const image=decodePng(Buffer.from(data,'base64'));
    samples.push(describe(image,meta));
  }
  const reference=samples[0];
  const defects=samples.map(s=>compare(s,reference,{settled:true}));
  if(reference.anchors.filter(a=>a.ink>=10).length<2 || defects.some(d=>d.length)) {
    results.referenceError={key,samples,defects};
    throw new Error('Referencia sin contenido suficiente o inestable: '+key);
  }
  references.set(key,reference);
  results.references.push({key,samples:3,reference});
}
let saved=0; const savedGroups=new Map();
async function capture(selector,label,edge,key) {
  if(!await invoke(bar,'flicker_mock_ping')) throw new Error('Mock ausente; se cancela la captura');
  const before=await probeCommand('rect');
  const point=await center(bar,selector);
  await bar.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
  await bar.evaluate(`window.__flickerRaf=[];window.__flickerRunning=true;
    window.__flickerSnapshot=()=>${snapshot};
    (function frame(){window.__flickerRaf.push(window.__flickerSnapshot());if(window.__flickerRunning)requestAnimationFrame(frame);})();`);
  await probeCommand('start');
  const raw=[]; let stop=false, clickAt, clickEnd;
  // La captura ya está armada antes de pulsar; no hay análisis ni escritura en este bucle.
  const sampler=(async()=>{
    while(!stop) {
      const start=performance.now();
      const [shot,rect,meta]=await Promise.all([
        bar.send('Page.captureScreenshot',{format:'png'}),probeCommand('rect'),bar.evaluate(snapshot)]);
      raw.push({start,end:performance.now(),shot:shot.data,rect,meta});
      if(interrupted) throw new Error('Prueba interrumpida; medición incompleta');
    }
  })();
  sampler.catch(()=>{}); // La excepción se recoge al salir y se restaura el PID propio.
  let stableAt=null, endAt;
  try {
    clickAt=performance.now();
    await bar.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
    await bar.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});
    clickEnd=performance.now();
    // El plazo empieza en el clic. Se mantiene hasta estabilidad geométrica y 150 ms más.
    // Mínimo 650 ms: incluye el encogido nativo retardado (morph + margen).
    let unchangedSince=null, previous='';
    while(performance.now()-clickEnd<2200) {
      await sleep(10);
      const f=raw.at(-1); if(!f) continue;
      const expected=label.endsWith('-open')?'panel':'compact';
      const signature=JSON.stringify([f.rect,f.meta.rect.map(v=>Math.round(v)),f.meta.state]);
      if(f.meta.state===expected && f.meta.active===0 && signature===previous) unchangedSince??=performance.now();
      else unchangedSince=null;
      previous=signature;
      if(unchangedSince && performance.now()-unchangedSince>=150 && performance.now()-clickEnd>=650) {
        stableAt=unchangedSince; break;
      }
    }
    endAt=performance.now();
  } finally {stop=true;await sampler;}
  const native=await probeCommand('stop'), after=await probeCommand('rect');
  const raf=await bar.evaluate('window.__flickerRunning=false;window.__flickerRaf');
  if(!stableAt) {stableAt=endAt;failed=true;}
  const temporal=coverage(raw,clickAt,stableAt,endAt);
  let metadataUncertain=0;
  const frames=raw.filter(f=>f.end>=clickAt).map((f,index)=>{
    const image=decodePng(Buffer.from(f.shot,'base64'));
    // La captura CDP no declara qué rAF pintó. Asociar por geometría del alfa
    // entre los rAF de la solicitud; una asociación ambigua impide aceptación.
    let x0=image.width,y0=image.height,x1=-1,y1=-1;
    for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++)if(image.pixels[(y*image.width+x)*4+3]>200){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
    const bounds=[x0,y0,x1-x0+1,y1-y0+1];
    const candidates=[f.meta,...raf.filter(m=>m.t>=f.meta.t-20&&m.t<=f.meta.t+(f.end-f.start)+20)];
    const score=m=>{
      const scale=image.width/m.viewport[0];
      if(Math.abs(image.height-m.viewport[1]*scale)>2)return Infinity;
      return m.rect.reduce((n,v,i)=>n+Math.abs(v*scale-bounds[i]),0);
    };
    candidates.sort((a,b)=>score(a)-score(b));
    const meta=candidates[0], geometryError=score(meta);
    if(geometryError>12)metadataUncertain++;
    const description=describe(image,meta);
    const reference=references.get(key+'-'+meta.state);
    const settled=meta.rect.every((v,i)=>Math.abs(v-reference.rect[i])<2);
    const defects=compare(description,reference,{settled});
    if(domDefects(meta,edge)) defects.push('salto DOM');
    if(meta.opacity<0.99) defects.push('isla oculta');
    if(nativeDefects(f.rect,results.monitor,edge)) defects.push('salto nativo');
    // Máximo 12 PNG de esta pasada: pares de apertura/cierre o el primer defecto.
    let file;
    const group=label.split('-').slice(0,2).join('-');
    if(saved<12 && (savedGroups.get(group)??0)<2 && (defects.length || (label.endsWith('-0-open') && index===1))) {
      file=`${label}-${String(index).padStart(3,'0')}.png`;
      writeFileSync(join(evidence,file),Buffer.from(f.shot,'base64')); saved++; savedGroups.set(group,(savedGroups.get(group)??0)+1);
    }
    return {start:+(f.start-clickAt).toFixed(3),end:+(f.end-clickAt).toFixed(3),rect:f.rect,
      state:meta.state,geometryError:Number.isFinite(geometryError)?geometryError:null,defects,...(file?{file}:{}),regions:description.anchors.length};
  });
  if(metadataUncertain){temporal.measured=false;temporal.reasons.push('asociación PNG/rAF incierta en '+metadataUncertain+' muestras');}
  const nativeInvalid=native.filter(([,r])=>nativeDefects(r,results.monitor,edge));
  const nativeGaps=native.slice(1).map((f,i)=>f[0]-native[i][0]);
  const nativeMaxGapMs=Math.max(0,...nativeGaps);
  if(native.length<10||nativeMaxGapMs>50){temporal.measured=false;temporal.reasons.push('cobertura Win32 insuficiente');}
  const defectiveFrames=frames.filter(f=>f.defects.length).length;
  const run={label,before,after,clickDurationMs:clickEnd-clickAt,stableAt:stableAt-clickAt,endAt:endAt-clickAt,
    temporal,frames,native,nativeSamples:native.length,nativeMaxGapMs,nativeDefects:nativeInvalid,
    defectiveFrames,nativeDefectiveSamples:nativeInvalid.length,status:!temporal.measured?'no medida':defectiveFrames||nativeInvalid.length?'defectos':'medida sin defectos'};
  results.runs.push(run);
  if(defectiveFrames||nativeInvalid.length||!temporal.measured) failed=true;
  console.log(JSON.stringify({label,frames:frames.length,defectiveFrames,nativeDefectiveSamples:nativeInvalid.length,status:run.status,maxGapMs:temporal.maxGapMs}));
  return run;
}

try {
  writeFileSync(settingsFile,JSON.stringify(settings));
  app=spawn(exe,[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,APPDATA:join(isolated,'roaming'),LOCALAPPDATA:join(isolated,'local'),
    WEBVIEW2_USER_DATA_FOLDER:join(isolated,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${process.env.CDP_PORT??9222}`}});
  appDone=new Promise(ok=>{app.once('exit',()=>{exited=true;ok();});app.once('error',()=>{exited=true;ok();});});
  bar=await connectBar();
  await bar.send('Page.enable');
  await bar.send('Page.addScriptToEvaluateOnNewDocument',{source:mock}); await bar.send('Page.reload'); await sleep(1200);
  await bar.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:process.env.FLICKER_REDUCED==='1'?'reduce':'no-preference'}]});
  const sentinel=await bar.evaluate("window.__TAURI_INTERNALS__.invoke('flicker_mock_ping').then(v=>({ok:v===true,injected:window.__flickerMock}),()=>({ok:false,injected:!!window.__flickerMock}))");
  if(!sentinel.ok) throw new Error('No se activó el mock: '+JSON.stringify(sentinel));
  results.mockVerified=true;
  probe=spawn('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./frame-geometry.ps1',import.meta.url)),'-ProcessId',String(app.pid)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let ready;
  const initialized=new Promise(ok=>{ready=ok;});
  createInterface({input:probe.stdout}).on('line',line=>{if(line==='ready'){ready();return;} const p=pending;pending=null;p?.ok(JSON.parse(line));});
  probe.stderr.on('data',()=>{failed=true;results.probeError=true;});
  await Promise.race([initialized,sleep(7000).then(()=>{throw new Error('Sonda Win32 no disponible');})]);
  results.monitor=await probeCommand('monitor');
  results.reducedMotion=process.env.FLICKER_REDUCED==='1';
  results.widgetAnimation=await bar.evaluate("getComputedStyle(document.querySelector('.widgets')).animationName");
  for(const style of (quick?['classic']:['classic','royal','aurora'])) for(const edge of (quick?['top']:['top','left'])) {
    await invoke(bar,'patch_settings',{patch:{barStyle:style==='aurora'?'aurora':'classic',islandColor:style==='royal'?'royal':'black',edge}}); await sleep(750);
    for(const panel of ['mail','today','claude','clipboard']) for(let cycle=0;cycle<cycles;cycle++) {
      const key=`${style}-${edge}-${panel}`;
      if(cycle===0) {
        await stableReference(key+'-compact');
        await click(bar,`li[data-id="${panel}"] button`); await sleep(800);
        if(!await bar.evaluate("!!document.querySelector('.island.panel')")) throw new Error('Entrada rechazada durante calibración');
        await stableReference(key+'-panel');
        await click(bar,'[data-action="close-panel"]'); await sleep(800);
      }
      const label=`${key}-${cycle}`;
      await capture(`li[data-id="${panel}"] button`,label+'-open',edge,key);
      if(!await bar.evaluate("!!document.querySelector('.island.panel')")) throw new Error('Entrada simulada rechazada; medición pendiente');
      await capture('[data-action="close-panel"]',label+'-close',edge,key);
      if(!await bar.evaluate("!!document.querySelector('.island.compact')")) throw new Error('Entrada simulada rechazada; medición pendiente');
    }
  }
} catch(error) { failed=true;results.incomplete=true;results.error=error.message;console.log('FAIL '+error.message); }
finally {
  probe?.stdin.end(); probe?.kill(); bar?.close();
  if(app&&!exited){app.kill();await Promise.race([appDone,sleep(5000)]);}
  results.closed=(!app||exited)&&count()===0;
  if(results.closed) {
    if(original){writeFileSync(settingsFile,original);results.restored=readFileSync(settingsFile).equals(original);if(results.restored)unlinkSync(backupFile);}
    else {if(existsSync(settingsFile))unlinkSync(settingsFile);results.restored=true;}
  }
  results.failed=failed||!results.closed||!results.restored;
  results.summary={transitions:results.runs.length,screenshots:results.runs.reduce((n,r)=>n+r.frames.length,0),
    defectiveFrames:results.runs.reduce((n,r)=>n+r.defectiveFrames,0),
    nativeDefectiveSamples:results.runs.reduce((n,r)=>n+r.nativeDefectiveSamples,0),
    unmeasuredTransitions:results.runs.filter(r=>!r.temporal.measured).length};
  results.hashesVerified=sourceFiles.every(f=>hash(resolve(root,f))===hashes[f])&&hash(exe)===results.executableHash;
  if(!results.hashesVerified)results.failed=true;
  results.accepted=!results.failed&&!quick&&cycles===10&&results.runs.length===480;
  writeFileSync(join(evidence,'results.json'),JSON.stringify(results));
}
process.exitCode=results.failed?1:0;
