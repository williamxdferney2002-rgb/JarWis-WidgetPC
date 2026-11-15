// JW-34-6I. All transient writes stay under tests-manual; evidence is selected later.
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {pages,connect,click,sleep,invoke} from './cdp.mjs';

const root=resolve('.'), probeHome=join(root,'src-tauri/tests-manual/.jw-34-6i-runtime');
if(process.env.JW_RUN&&!/^[a-z0-9-]+$/i.test(process.env.JW_RUN))throw Error('JW_RUN must be a simple folder name');
if(process.env.JW_EXE&&!resolve(process.env.JW_EXE).startsWith(root+'\\'))throw Error('Test executable must stay inside repository');
const home=process.env.JW_RUN ? join(probeHome,process.env.JW_RUN) : probeHome;
const evidence=join(root,'docs/evidence/JW-34-6I');
const count=()=>Number(execFileSync('powershell',['-NoProfile','-Command','@(Get-Process jarwis,jw-flicker-fixture,jarwis-observed -ErrorAction SilentlyContinue).Count']).toString().trim());
if(root!=='C:\\dev\\JarWis'||count())throw Error('Expected repository and zero JarWis processes');
const digest=f=>existsSync(f)?createHash('sha256').update(readFileSync(f)).digest('hex'):null;
const realSettings=join(process.env.APPDATA,'com.jarwis.app/settings.json');
const sourceFiles=['src-tauri/src/main.rs','src-tauri/tauri.conf.json','src/styles.css','src/Bar.tsx','src-tauri/src/layout.rs'];
const hashes=Object.fromEntries(sourceFiles.map(f=>[f,digest(f)]));
const initialSettingsHash=digest(realSettings);
for(const dir of ['roaming/com.jarwis.app','local','webview','home','temp'])mkdirSync(join(home,dir),{recursive:true});
mkdirSync(evidence,{recursive:true});
const settings={edge:'top',mode:'compact',minimized:false,alwaysOnTop:true,autoCompactSeconds:0,barStyle:'classic',theme:'dark',
  barOffsets:{top:.5,bottom:.5,left:.5,right:.5},barOffsetsCenter:true,clipboardHistory:false,autostart:false,
  notifications:false,alarms:[],shortcuts:[],workspaces:[],bitwardenSeeded:true,shareToday:false,hiddenWidgets:[]};
writeFileSync(join(home,'roaming/com.jarwis.app/settings.json'),JSON.stringify(settings));
const mock=`(()=>{
  const nativeFetch=window.fetch.bind(window);
  const allow=new Set(['get_settings','patch_settings','set_panel','set_minimized','bar_track','plugin:event|listen','plugin:event|unlisten']);
  const feed=data=>({data,error:null,updatedAt:0});
  const fake={jw6i_ping:()=>true,cloud_status:()=>({configured:false,connected:false,loginInProgress:false}),
    cloud_mail:()=>feed({inboxUnread:0,outlookUnread:0,inboxMore:false,outlookMore:false,items:[]}),
    cloud_agenda:()=>feed({events:[],tasks:[],pendingTasks:0,tasksPartial:false}),
    clipboard_list:()=>({items:[],paused:false,enabled:false}),clock_state:()=>({timers:[],alerts:[]}),
    system_snapshot:()=>null,audio_state:()=>({volume:50,muted:false,deviceName:'Salida ficticia JW-34-6I'}),
    list_audio_devices:()=>[{id:'fake',name:'Salida ficticia JW-34-6I',isDefault:true}],media_state:()=>null};
  window.__jw6i={mode:'baseline',petFail:true,ipc:[],raf:[],running:false};
  const frame=()=>new Promise(ok=>requestAnimationFrame(ok));
  window.fetch=async(url,init)=>{
    const value=String(url);if(!value.includes('ipc.localhost/'))return nativeFetch(url,init);
    const cmd=decodeURIComponent(value.split('ipc.localhost/')[1].split(/[?#]/)[0]);
    if(cmd==='set_panel')window.__jw6i.ipc.push({t:performance.now(),cmd,body:typeof init?.body==='string'?JSON.parse(init.body):null});
    if(allow.has(cmd)){
      const response=await nativeFetch(url,init);
      if(cmd==='set_panel'&&window.__jw6i.mode==='defer-css'){await frame();await frame();}
      return response;
    }
    if(cmd==='show_codex_pet')return new Response(JSON.stringify(window.__jw6i.petFail?'Error ficticio JW-34-6I':null),{headers:{'Tauri-Response':window.__jw6i.petFail?'error':'ok'}});
    const ok=Object.hasOwn(fake,cmd);
    return new Response(JSON.stringify(ok?fake[cmd]():'IPC ficticio bloqueado'),{headers:{'Tauri-Response':ok?'ok':'error','content-type':'application/json'}});
  };
  addEventListener('resize',()=>{
    if(window.__jw6i.mode==='hide-resize'){
      const el=document.querySelector('.island');if(!el)return;
      el.style.opacity='0';requestAnimationFrame(()=>requestAnimationFrame(()=>el.style.opacity=''));
    }
  });
  const snapshot=()=>{
    const el=document.querySelector('.island');if(!el)return null;
    const r=el.getBoundingClientRect(),c=getComputedStyle(el);
    return {t:performance.now(),viewport:[innerWidth,innerHeight],rect:[r.x,r.y,r.width,r.height],
      opacity:c.opacity,background:c.backgroundColor,state:el.className,animations:el.getAnimations().map(a=>a.playState)};
  };
  window.__jw6i.snapshot=snapshot;
  const tick=()=>{if(window.__jw6i.running)window.__jw6i.raf.push(snapshot());requestAnimationFrame(tick)};requestAnimationFrame(tick);
})()`;
let helper,bar,pending,exitDone;
const result={started:new Date().toISOString(),initialCount:count(),hashes,settingsBefore:initialSettingsHash,
  measuredExe:digest(process.env.JW_EXE??join(root,'target/release/jarwis.exe')),
  syncBounds:process.env.JW_SYNC_BOUNDS==='1',
  exe:digest(join(root,'target/release/jarwis.exe')),installedExe:digest(join(process.env.LOCALAPPDATA,'JarWis/jarwis.exe')),
  method:(process.env.JW_CAPTURE??'WGC')+' + QPC WM messages; GPU crop restricted to synthetic underlay ROI',runs:[]};
const command=v=>new Promise((ok,fail)=>{
  if(pending)return fail(Error('Native command already pending'));
  const timer=setTimeout(()=>{pending=null;fail(Error('Native command timeout '+v.cmd))},30000);
  pending={ok:v=>{clearTimeout(timer);ok(v)},fail};helper.stdin.write(JSON.stringify(v)+'\n');
});
try{
  const stale=join(home,'messages.jsonl');if(existsSync(stale))unlinkSync(stale);
  helper=spawn('python',['-B','src-tauri/tests-manual/flicker-native.py','--serve',process.env.JW_EXE??join(root,'target/release/jarwis.exe'),join(probeHome,'probe.dll')],{
    cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,
      JW_FLICKER_HOME:home,JW_PROBE_DIR:probeHome,JW_FIXTURE_ROOT:join(home,'fixture-root'),JW_EVENT_LOG:join(home,'controller.jsonl'),JW_NATIVE_INFO:join(home,'controller-info.json'),APPDATA:join(home,'roaming'),LOCALAPPDATA:join(home,'local'),TEMP:join(home,'temp'),TMP:join(home,'temp'),
      WEBVIEW2_USER_DATA_FOLDER:join(home,'webview'),WEBVIEW2_DEFAULT_BACKGROUND_COLOR:process.env.JW_TRANSPARENT?'00000000':undefined,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9222'}});
  exitDone=new Promise(ok=>helper.once('exit',(code)=>{result.helperExit=code;ok()}));
  let initOk,initFail;
  const ready=new Promise((ok,fail)=>{initOk=ok;initFail=fail;});
  createInterface({input:helper.stdout}).on('line',line=>{
    try{const data=JSON.parse(line);if(data.ready){initOk(data);return;}const p=pending;pending=null;p?.ok(data)}catch(e){initFail(e)}
  });
  helper.stderr.on('data',data=>{result.nativeError=(result.nativeError??'')+String(data);console.error(String(data))});
  result.native=await Promise.race([ready,sleep(16000).then(()=>{throw Error('No native ready handshake')})]);
  for(let i=0;i<60&&!bar;i++){
    for(const target of await pages().catch(()=>[])){
      const candidate=await connect(target);
      if(await candidate.evaluate("window.__TAURI_INTERNALS__?.metadata.currentWindow.label==='bar'")){bar=candidate;break;}
      candidate.close();
    }
    if(!bar)await sleep(200);
  }
  if(!bar)throw Error('No CDP target');
  await bar.send('Page.enable');await bar.send('Page.addScriptToEvaluateOnNewDocument',{source:mock});
  if(process.env.JW_MOTION)await bar.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:process.env.JW_MOTION}]});
  await bar.send('Page.reload');await sleep(1000);
  if(!await invoke(bar,'jw6i_ping'))throw Error('Mock not verified');
  result.mockVerified=true;
  if(process.env.JW_MONITOR)await invoke(bar,'patch_settings',{patch:{monitor:process.env.JW_MONITOR}});
  await sleep(200);
  result.media=await bar.evaluate("({reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,morph:getComputedStyle(document.documentElement).getPropertyValue('--morph')})");
  result.page=await bar.evaluate('location.href');
  result.syntheticDevice=await bar.evaluate("document.body.textContent.includes('Salida ficticia')");
  result.shield=await command({cmd:'shield'});await sleep(200);
  result.clockSync={before:await command({cmd:'rect'}),browser:await bar.evaluate('performance.now()'),after:await command({cmd:'rect'})};
  const modes=process.env.JW_MODES?.split(',')??['baseline','noredraw','nocopybits','noredirection','defer-css','hide-resize'];
  const cycles=Number(process.env.JW_CYCLES??2);
  for(const mode of modes){
    if((await command({cmd:'mode',value:{noredraw:1,nocopybits:2,noredirection:3}[mode]??0})).result!==1)throw Error('Observer not attached');
    await bar.evaluate(`window.__jw6i.mode=${JSON.stringify(mode)}`);
    for(const scenario of ['audio'])for(let cycle=0;cycle<cycles;cycle++)for(const action of ['open','close']){
      if(!await invoke(bar,'jw6i_ping'))throw Error('Mock lost');
      const label=`${process.env.JW_TRANSPARENT?'transparent-':''}${mode}-${scenario}-${cycle}-${action}`;
      await bar.evaluate('window.__jw6i.raf=[];window.__jw6i.ipc=[];window.__jw6i.running=true');
      const armed=await command({cmd:'start',roi:result.shield.roi,neutralUnderlayVerified:true});
      await sleep(70);
      const before=await command({cmd:'rect'});
      if(action==='close'){
        await bar.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await bar.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      }else await click(bar,'li[data-id="media"] button');
      const afterClick=await command({cmd:'rect'});
      await sleep(800);
      const stop=await command({cmd:'stop',label});
      const dom=await bar.evaluate('window.__jw6i.running=false;({raf:window.__jw6i.raf,ipc:window.__jw6i.ipc,final:window.__jw6i.snapshot()})');
      const expected=action==='open'?'panel':'compact';
      const run={label,mode,scenario,action,armed,before,afterClick,...stop,...dom,stateVerified:dom.final.state.split(' ').includes(expected)};
      result.runs.push(run);
      writeFileSync(join(home,'results.json'),JSON.stringify(result));
      console.log(JSON.stringify({label,frames:stop.frames.length,errors:stop.errors,stateVerified:run.stateVerified}));
      if(stop.errors.length||!run.stateVerified)throw Error('Invalid run '+label);
    }
  }
  // Repeated Codex-pet show is mocked too: it must not resize the bar.
  await bar.evaluate('window.__jw6i.petFail=false');
  await bar.evaluate('window.__jw6i.raf=[];window.__jw6i.ipc=[];window.__jw6i.running=true');
  const armed=await command({cmd:'start',roi:result.shield.roi,neutralUnderlayVerified:true});
  await sleep(70);
  const before=await command({cmd:'rect'});
  for(let n=0;n<2;n++){await click(bar,'li[data-id="codex-pet"] button');await sleep(200);}
  await sleep(200);
  const after=await command({cmd:'rect'});
  const label='pet-success-show';const stop=await command({cmd:'stop',label});
  const dom=await bar.evaluate('window.__jw6i.running=false;({raf:window.__jw6i.raf,ipc:window.__jw6i.ipc,final:window.__jw6i.snapshot()})');
  result.petSuccess={before,after};
  if(stop.errors.length||!dom.final.state.includes('compact')||JSON.stringify(before.rect)!==JSON.stringify(after.rect))throw Error('Invalid pet show capture');
  result.runs.push({label,mode:'baseline',scenario:'pet-success',action:'show',armed,before,afterClick:after,...stop,...dom,stateVerified:dom.final.state.includes('compact')});
}catch(error){result.error=error.message;console.error(error.message);process.exitCode=1;}
finally{
  bar?.close();
  if(helper){helper.stdin.end();await Promise.race([exitDone,sleep(10000)]);}
  result.settingsAfter=digest(realSettings);result.settingsUnchanged=result.settingsAfter===initialSettingsHash;
  result.sourcesUnchanged=sourceFiles.every(f=>digest(f)===hashes[f]);result.finalCount=count();
  writeFileSync(join(home,'results.json'),JSON.stringify(result));
  console.log(JSON.stringify({cleanup:{settingsUnchanged:result.settingsUnchanged,sourcesUnchanged:result.sourcesUnchanged,finalCount:result.finalCount},error:result.error}));
}
