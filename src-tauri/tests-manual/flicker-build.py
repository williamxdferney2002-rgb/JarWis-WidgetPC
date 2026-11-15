"""Build an isolated instrumented COPY, leaving application sources and Cargo outputs untouched.
Uses already compiled rlibs; no downloads. python -B flicker-build.py
"""
from pathlib import Path
import os, re, subprocess, json
ROOT = Path(__file__).resolve().parents[2]
RUN = ROOT/'src-tauri/tests-manual/JW-34-6I-runtime'
RUN.mkdir(exist_ok=True)
source = (ROOT/'src-tauri/src/main.rs').read_text(encoding='utf-8')
source = re.sub(r'^mod (\w+);', lambda m: '#[path="'+(ROOT/'src-tauri/src'/f'{m[1]}.rs').as_posix()+'"]\nmod '+m[1]+';', source, flags=re.M)
source = source.replace('fn main() {', '''fn main() {
    let mut context = tauri::generate_context!();
    context.config_mut().app.app_directories_override = Some(tauri::utils::config::AppDirectoriesOverride::Root(std::path::PathBuf::from(std::env::var("JW_FIXTURE_ROOT").unwrap())));
''')
source = source.replace('.build(tauri::generate_context!())', '.build(context)')
source = source.replace('cloud::Cloud::new(cloud::today_path())', 'cloud::Cloud::new(None)')
source = source.replace('let initial = settings::load(&path);', '''let initial = Settings { auto_compact_seconds: 0, clipboard_history: false, notifications: false, share_today: false, bitwarden_seeded: true, ..Settings::default() };''')
source = source.replace('seed_bitwarden(&handle);', '// fixture: no external app discovery')
source = source.replace('win.show()?;', '''let h = win.hwnd()?.0 as usize;
                unsafe { fixture::install(h); }
                let _ = win.with_webview(|w| unsafe {
                    let c = w.controller();
                    fixture::CONTROLLER.store(std::mem::transmute_copy(&c), std::sync::atomic::Ordering::SeqCst);
                    std::mem::forget(c);
                });
                win.show()?;''')
source = source.replace('SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,', 'SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER | windows::Win32::UI::WindowsAndMessaging::SET_WINDOW_POS_FLAGS(std::env::var("JW_SWP").ok().and_then(|s|s.parse().ok()).unwrap_or(0)),')
source += '\n#[path="../flicker-probe.rs"] mod fixture;\n'
(RUN/'fixture.rs').write_text(source, encoding='utf-8')
deps = ROOT/'target/release/deps'
args = [str(Path.home()/'.cargo/bin/rustc.exe'), '--crate-name', 'jw_flicker_fixture', '--edition=2021', str(RUN/'fixture.rs'), '--crate-type', 'bin', '--cfg', 'desktop', '-C', 'panic=abort', '-C', 'opt-level=s', '-C', 'lto=fat', '-C', 'codegen-units=1', '-C', 'debuginfo=0', '-L', 'dependency='+str(deps), '-o', str(RUN/'jw-flicker-fixture.exe')]
for name in ['tauri','serde','serde_json','jarwis_auth','tauri_plugin_notification','tauri_plugin_autostart','tauri_plugin_opener','tauri_plugin_global_shortcut','tauri_plugin_single_instance','windows','sysinfo','chrono']:
    libs = sorted(deps.glob('lib'+name+'-*.rlib'), key=lambda p:p.stat().st_mtime, reverse=True)
    args += ['--extern',name+'='+str(libs[0])]
for output in (ROOT/'target/release/build').glob('*/output'):
    for line in output.read_text(errors='replace').splitlines():
        if line.startswith('cargo:rustc-link-search='):
            args += ['-L',line.split('=',1)[1]]
outputs = sorted((ROOT/'target/release/build').glob('jarwis-app-*/out'),key=lambda p:p.stat().st_mtime,reverse=True)
out = next(p for p in outputs if (p/'resource.lib').exists())
env = dict(os.environ, CARGO_MANIFEST_DIR=str(ROOT/'src-tauri'), OUT_DIR=str(out), CARGO_PKG_NAME='jarwis-app', CARGO_PKG_VERSION='0.1.0', CARGO_PKG_AUTHORS='', CARGO_PKG_DESCRIPTION='JarWis fixture', TAURI_ENV_TARGET_TRIPLE='x86_64-pc-windows-msvc', TMP=str(RUN), TEMP=str(RUN))
result = subprocess.run(args, env=env, capture_output=True, text=True)
(ROOT/'docs/evidence/JW-34-6I/build.log').write_text(result.stderr,encoding='utf-8')
print(result.returncode, result.stderr[-5500:])
if result.returncode == 0:
    # The DLL observer imports the v6 comctl32 subclass API. Also preserve PMv2.
    subprocess.run([r'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\mt.exe','-nologo','-manifest',str(ROOT/'src-tauri/examples/presence_probe.manifest'),'-outputresource:'+str(RUN/'jw-flicker-fixture.exe')+';#1'],check=True)
raise SystemExit(result.returncode)
