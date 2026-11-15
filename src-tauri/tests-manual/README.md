# Verificación manual por CDP

## Parpadeo por fotograma: JW-34-6I

Sondas reutilizables, sin dependencias nuevas ni configuración de Windows. Ejecutar
desde `C:\dev\JarWis`, con **cero** instancias de JarWis; salir ordenadamente de la
instalada antes y volver a abrir `%LOCALAPPDATA%\JarWis\jarwis.exe` al terminar.
El arnés rechaza una instancia existente. Nunca instrumenta el proceso del usuario:
crea uno suspendido, redirige sus carpetas conocidas por DLL antes de `main`, exige
el handshake de aislamiento y solo entonces lo reanuda. Sus perfiles y capturas
quedan en `.jw-34-6i-runtime/`; los ajustes originales se verifican por SHA-256.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File src-tauri/tests-manual/build-flicker-probes.ps1
python -B src-tauri/tests-manual/flicker-native.py # sesión y DuplicateOutput; NO adquiere píxeles
$env:JW_RUN='medicion' # nombre simple, sin barras
$env:JW_CAPTURE='WGC' # predeterminado; captura el monitor que contiene la barra
$env:JW_CYCLES='2'
node src-tauri/tests-manual/flicker-investigate.mjs
python -B src-tauri/tests-manual/flicker-analyze.py src-tauri/tests-manual/.jw-34-6i-runtime/medicion
```

Requiere MSVC/SDK en las rutas de `build-flicker-probes.ps1`, Node 24, Python,
Pillow y numpy **ya instalados**, y `target/release/jarwis.exe` con UI embebida.
Si falta alguno, no instala nada. Para DXGI, elegir un monitor cuyo preflight
devuelva `duplicateOutput=0x00000000`: `$env:JW_CAPTURE='DXGI'` y, por ejemplo,
`$env:JW_MONITOR='\\.\DISPLAY5'` (nombre observado, no asumir que sigue existiendo).
El monitor principal de esta sesión rechazó DXGI con `0x887A0004`; WGC sí funcionó.

`flicker-native.py` captura con `AcquireNextFrame` o `flicker-wgc.cpp`, recorta en
GPU antes de mapear a CPU y solo guarda la zona sintética de 1100×420. La ventana
de fondo neutro tapa el área de trabajo; un latido de 4×4 fuerza presentaciones.
No ejecutar mientras se interactúa con otras ventanas que puedan cubrir esa zona.
No guarda escritorio, cuentas, audio, portapapeles ni acciones reales de Codex:
verifica el centinela del mock antes de capturar. Audio usa salida ficticia; la
mascota prueba rechazo simulado (panel de error) y dos alternancias exitosas simuladas.
El rechazo de la captura histórica se representó como `[object ArrayBuffer]`;
ejercita el mismo `onError` y tamaño mínimo del panel, no un mensaje real de Codex.

`flicker-probe.cpp` registra QPC, rects, brush y WM_SIZE/WM_WINDOWPOS*/PAINT/ERASE;
permite SWP_NOREDRAW, SWP_NOCOPYBITS y WS_EX_NOREDIRECTIONBITMAP temporales.
`JW_MODES` acepta `baseline,noredraw,nocopybits,noredirection,defer-css,hide-resize`.
`JW_TRANSPARENT=1` fuerza fondo WebView2 transparente desde su entorno;
`JW_CREATE_NOREDIRECT=1` aplica el estilo desde CreateWindowEx;
`JW_MOTION=no-preference` habilita movimiento **solo por emulación CDP**.

Para inspeccionar bounds COM, `python -B src-tauri/tests-manual/flicker-build.py`
genera una copia aislada de `main.rs` usando los rlibs release existentes (LTO y
manifiesto Common Controls v6). `flicker-probe.rs` añade la observación COM.
Usar `JW_EXE=C:\dev\JarWis\src-tauri\tests-manual\JW-34-6I-runtime\jw-flicker-fixture.exe`;
`JW_SYNC_BOUNDS=1` repite SetBounds al salir de WM_SIZE. Sin esa variable es control.
La copia no exporta Hoy ni descubre apps externas; no modifica fuentes de producto.

`flicker-analyze.py` mide el centro de la banda superior oscura (acabado Negro),
marca salto >6 px y ausencia de banda; no es un detector universal de todos los
acabados. Conserva los tiempos de presentación, AccumulatedFrames y huecos:
capturas omitidas impiden certificar ausencia de defectos de un solo refresco.
Selección histórica y metodología: [evidencia 6I](../../docs/evidence/JW-34-6I/README.md).
Al acabar, conservar solo evidencia seleccionada <5 MB y estos scripts; borrar
ambas carpetas runtime completas (verificar antes sus rutas absolutas dentro del
repo). No conservar DLL/EXE/OBJ/PDB, perfiles WebView ni copias instrumentadas.
`clean-flicker-probes.ps1` prepara esa limpieza con rutas exactas y guardas de
procesos/enlaces. **En la entrega 6I el borrado quedó bloqueado por la revisión
automática de ejecución; ambas carpetas siguen presentes.** La instalada sí quedó
abierta. El pendiente está reflejado en el informe y en verification.json.

## Regresión aislada de la auditoría JW-12

`audit-ui.mjs` sirve el build `dist/` y simula **todo** el IPC en un navegador sin ventana y perfil temporal. No inicia JarWis, no usa sus ajustes, no lee cuentas ni modifica el portapapeles. Requiere Edge y Playwright disponibles; no instala dependencias automáticamente.

```powershell
npm run build
# Si Playwright no está en node_modules, indicar su index.mjs absoluto:
$env:PLAYWRIGHT_MODULE = '<ruta absoluta a playwright/index.mjs>'
node src-tauri/tests-manual/audit-ui.mjs
```

JW-13 amplía la misma prueba a estilos, panel IA y Ajustes simulados. Para guardar una ejecución separada, usar `$env:EVIDENCE_DIR = 'docs/evidence/JW-13'` antes del comando; no instala ni ejecuta JarWis.

Verifica teclado, foco, errores, respuestas desordenadas tras cerrar sesión, fecha local en Bogotá, resúmenes y distribución/contraste en los cuatro bordes. Capturas con datos ficticios y `results.json` en `docs/evidence/JW-12/`. No reemplaza las pruebas nativas que siguen.

Lanza la app con depuración remota de WebView2 (PowerShell; desde Git Bash la variable no llega):

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
Start-Process .\target\release\jarwis.exe
node src-tauri/tests-manual/verify.mjs            # comprobaciones
# sin capturas desde JW-4-04 (la UI muestra datos reales)
```

Restaura las preferencias modificadas con `patch_settings` y el orden con `widget_move`; nunca cambia «Iniciar con Windows». Las alarmas de prueba se borran con `alarm_remove`, sin reenviar ni reactivar alarmas del usuario. Accesos y espacios usan `set_shortcuts` y `set_workspaces`. No incluir el puerto en builds publicados.

## Reloj (JW-2-05)

```powershell
node src-tauri/tests-manual/clock.mjs docs/evidence           # panel, cronómetro, temporizador de 5 s, aviso, notificación, alarma + capturas JW-2-05-*.png
node src-tauri/tests-manual/clock.mjs --alarm                 # además espera a que suene una alarma real (≤ 2 min) y la pospone
node src-tauri/tests-manual/clock.mjs --keep                  # conserva la alarma de prueba para comprobarla tras reiniciar el exe
```

La notificación se comprueba por el recuento del historial del Centro de actividades (sin leer su contenido). En el exe sin instalar, Windows la muestra con el nombre e icono de PowerShell (`tauri-plugin-notification` solo fija el AppUserModelID fuera de `target\release`).

## Portapapeles (JW-2-06)

```powershell
node src-tauri/tests-manual/clipboard.mjs docs/evidence       # captura, exclusiones, copiar de nuevo, dedupe, búsqueda, fijar, pausa, borrar, Ajustes + capturas JW-2-06-*.png
```

Solo escribe textos ficticios `jarwis-prueba-*` (con `clip.ps1`: `Set-Clipboard` y P/Invoke para los formatos de exclusión), nunca lee lo que hubiera antes y al terminar deja el portapapeles vacío. Requiere la sesión desbloqueada: con la pantalla bloqueada `OpenClipboard` devuelve `ERROR_ACCESS_DENIED` y la entrada de teclado sintética se descarta; entonces el script solo verifica la interfaz (`SKIP portapapeles real`). El historial vive solo en memoria y se pierde al cerrar JarWis.

**Aviso:** `clipboard.mjs` (y `clip.ps1`) sobrescriben el portapapeles real del usuario, y sus pasos «Borrar todo» y desactivar el historial borran también el historial en memoria que el usuario tuviera en esa instancia de JarWis. Ejecutarlos solo con el usuario ausente del equipo y con su consentimiento explícito. La prueba `#[ignore]` de `clipboard.rs` también escribe en el portapapeles real.

## Monitoreo y accesos rápidos (JW-3-01, JW-3-03)

```powershell
node src-tauri/tests-manual/system-shortcuts.mjs   # system_snapshot, permisos de la barra, validación de set_shortcuts
```

No abre ningún acceso real. Guarda temporalmente dos accesos de prueba y restaura los accesos con `set_shortcuts` y los espacios podados con `set_workspaces`.

## Audio y multimedia (JW-3-02)

```powershell
node src-tauri/tests-manual/audio-media.mjs   # audio_state, list_audio_devices, set_volume (y acotado), set_muted, media_state, formas de media_control
```

Cambia el volumen y el silencio reales y restaura los valores originales (también si falla una comprobación). No abre Configuración de sonido. `media_control` solo se envía cuando no hay sesión (debe fallar); con una sesión activa solo se comprueba la forma, para no interrumpir al usuario. De la sesión imprime solo `appId` y la longitud del título.

## Menú contextual de la isla (JW-2-08)

```powershell
node src-tauri/tests-manual/bar-menu.mjs   # clic derecho real (CDP) abre el menú, Posición, Ocultar barra, Ajustes…, Esc y Salir
```

Elige las opciones con el teclado (`win.ps1 keys`, entrada sintética global): no teclear mientras se ejecuta (~10 s). Cambia el borde a izquierda (o derecha si ya estaba a la izquierda) y lo restaura con `patch_settings`. Termina con «Salir de JarWis»: la app queda cerrada.

## Arrastrar la isla (JW-2-09)

```powershell
node src-tauri/tests-manual/bar-drag.mjs docs/evidence/JW-34-6B
```

Requiere Vite (`npx vite --config src-tauri/tests-manual/vite-stable.config.mjs`) y `target/debug/jarwis.exe` compilado con `cargo build --locked --offline`. La prueba comprueba que no haya otro `jarwis.exe`, lanza su propia instancia con CDP y guarda su PID (también en el reinicio). La configuración de prueba desactiva HMR y vigilancia de archivos para no recargar la WebView durante operaciones Tauri. Acepta tanto la URL de desarrollo como `tauri.localhost`. `JARWIS_TEST_EXE` puede indicar otro ejecutable dentro del repositorio.

Mueve el ratón real durante varios minutos: no tocarlo mientras se ejecuta. Prueba ambos sentidos en arriba/abajo desde asa, fondo, Mini e iconos que salen de la isla; también arrastra en expandido y con panel abierto. Mide el rectángulo Win32 **antes de soltar** y lo compara con la ventana, el dibujo de `.island` y la fracción persistida, también tras 2 s, hover, cambios de forma, panel, auto-compactado y reinicio. Soltar en el mismo borde guarda la posición; solo «Centrar» (`bar-center`) vuelve a 0,5. Conserva las pruebas de cambio de borde, monitor y reordenamiento dentro de la fila.

Guarda solo metadatos geométricos y del ciclo de procesos en `results.json`, sin capturas ni texto del DOM. Hace copia de los ajustes en `target/JW-34-6B/settings.original.json` y usa ajustes neutros. Aísla en el proceso hijo `APPDATA` (configuración OAuth), `LOCALAPPDATA` y el perfil WebView2; Tauri resuelve sus ajustes mediante KnownFolder de Windows. Termina su PID, espera la salida del proceso y exige cero instancias antes de restaurar y comparar los bytes; retira el respaldo tras verificar la igualdad. Incluye cierre sin CDP, clic compacto inicial y posterior a arrastres, orden exacto con ratón en compacto/expandido, Enter/Alt+flecha por CDP y entrega desde un icono vertical. Expandido/panel deben cambiar posición y fracción, además de conservarlas al soltar. No modifica inicio con Windows. La geometría usa DPI por monitor en `mouse.ps1`: `screenX` de la WebView no es una coordenada física fiable con escalas distintas.

JW-34-6E corrección 1: el centrado abre `bar_menu` por IPC y consulta el
popup `#32768` del PID propio. `menu-center.ps1` identifica el único «Centrar»
por su texto nativo y obtiene ID, habilitación y rectángulo mediante Win32.
Guarda esos metadatos antes de cualquier entrada; exige que `WindowFromPoint`
pertenezca a ese mismo popup/PID y comprueba cursor/resultado de `SendInput`.
No usa flechas, índices constantes ni selección inicial. Un rechazo aborta sin
reintentar ni relajar guardas. La limpieza termina el PID propio, sin más entrada.
El JSON registra errores, ruta de centrado y hashes de fuentes/ejecutable.
La identificación del ID no implica que el gesto haya sido aceptado: consultar
`executionError` y los resultados completos de arrastre/persistencia/reinicio.

## Parpadeo al abrir/cerrar paneles (JW-34-6E)

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --locked --offline
# En otra terminal; reiniciarlo después de modificar la UI (watch está desactivado):
npx vite --config src-tauri/tests-manual/vite-stable.config.mjs
node src-tauri/tests-manual/panel-flicker.mjs docs/evidence/JW-34-6E/after
```

`panel-flicker.mjs` lanza su propio PID y exige cero instancias previas. Copia
`%APPDATA%/com.jarwis.app/settings.json`, usa ajustes neutros y aísla OAuth,
LOCALAPPDATA y WebView2. Antes de inspeccionar/capturar verifica el centinela
del mock: correo, agenda, IA, portapapeles y acciones externas quedan simulados
o bloqueados; solo geometría, ajustes neutros y eventos llegan al núcleo.
No lee el escritorio ni el portapapeles real. Al terminar cierra su PID, espera
cero instancias y restaura los bytes originales antes de retirar el respaldo.

Por defecto abre/cierra Correo, Hoy, IA y Portapapeles diez veces cada uno,
en Negro/Pizarra/Aurora y arriba/izquierda: **480 transiciones**. Calibra tres
PNG estables de compacto y panel por combinación, solo con el mock verificado.
Antes de tocar ajustes ejecuta controles sintéticos obligatorios: blanco total,
superficie vacía, oscura con cuadrado 8×8, desaparición parcial y salto visual/nativo.
`node src-tauri/tests-manual/panel-flicker.mjs --self-test` los ejecuta sin abrir la app.

El detector compara luminancia/alfa en una rejilla interior 8×4 y contenido en
regiones DOM contra la referencia del mismo estado. En geometría estable compara
también tinta por celda; durante el morph contrasta densidad en cada región de
contenido. No reduce la decisión a un total global de píxeles. El PNG se asocia
por contorno alfa al rAF del intervalo de captura; asociación incierta bloquea
aceptación. No es reconocimiento semántico ni captura del compositor de DWM.

El bucle de PNG está armado antes de pulsar. Continúa desde el clic hasta tamaño,
estado y geometría estables durante 150 ms, al menos 650 ms desde soltar; plazo
máximo 2,2 s. El análisis y la escritura ocurren después del muestreo. Exige ≥10
capturas, ≥4 hasta estabilizar, cobertura estable de 150 ms y huecos/incertidumbre
≤50 ms, incluyendo extremos y duración de cada solicitud. La traza independiente
Win32 también exige ≥10 muestras y huecos ≤50 ms; `Sleep(1)` no promete 1 kHz.
Una transición con cobertura insuficiente queda **«no medida»**, falla la pasada
y jamás cierra aceptación, aunque no haya defectos visibles en sus muestras.

Conserva métricas/tipos de defecto por captura, conteos/cadencia Win32 y hasta
12 PNG representativos por pasada. `results.json` incluye referencias regionales,
tiempos relativos al clic, razones de cobertura, restauración/cierre y SHA-256
de fuentes/arnés/ejecutable, comprobados de nuevo al finalizar. La evidencia
histórica cruda se archiva fuera del repo; el informe enlaza su manifiesto.

`FLICKER_CYCLES=1` reduce repeticiones; `FLICKER_QUICK=1` limita a Negro/arriba;
`FLICKER_REDUCED=1` emula movimiento reducido solo en la WebView. Una pasada
corta no cierra aceptación. Si captura o entrada se rechazan, aborta sin repetir.

## Interfaz de Google (JW-4-03)

```powershell
node src-tauri/tests-manual/cloud-ui.mjs docs/evidence   # insignia, pestañas, agenda, clic → cloud_open, estados ok/cargando/signedOut/network/quota, Ajustes → Cuentas + capturas JW-4-03-*.png
```

Solo con datos ficticios: `__TAURI_INTERNALS__.invoke` no se puede sustituir, así que el script intercepta `fetch` (Page.addScriptToEvaluateOnNewDocument), recarga y comprueba el mock con `cloud_mock_ping` antes de inspeccionar o capturar; si no está activo, aborta. Nunca lee texto del DOM (solo booleanos y conteos), no llama a `cloud_login`/`cloud_logout` ni pulsa Conectar/Desconectar. Con una sesión real de Google la barra mostraría asuntos reales: no hacer capturas de la UI sin este mock. Al terminar recarga la barra sin mock.

## Claude (JW-5-02 / JW-5-03)

```powershell
node src-tauri/tests-manual/claude-ui.mjs docs/evidence  # panel Claude con mock verificado (cloud_mock_ping + filas jarwis-prueba) + capturas JW-5-03-*.png
```

`claude-ui.mjs` (actualizado en JW-9-02: lanzador Abrir Claude / terminal / Ver mi uso, proyectos y botones Spotify/YouTube del widget de medios; sin status line) sigue las reglas de `cloud-ui.mjs`: sin capturas de Ajustes y `claude_open` y `media_open` simulados (solo se comprueba el argumento; no se abre ninguna app).

## Hoy, Concentración, espacios y notificaciones (JW-7-03)

```powershell
node src-tauri/tests-manual/today-ui.mjs docs/evidence   # panel Hoy (resúmenes clicables) con mock verificado (cloud_mock_ping + filas jarwis-prueba), botones Concentración/espacio, Ajustes simulados + capturas JW-7-03-*.png
```

Mismas reglas que `claude-ui.mjs`: fetch interceptado, aborta si el mock no responde, `open_focus_settings`, `open_workspace`, `patch_settings` y `set_workspaces` son ficticios (no se abre ni se guarda nada) y `get_settings` real se parchea con accesos, espacios y alarmas ficticios antes de abrir Ajustes. Nota: el exe de `cargo build --release` solo carga la UI embebida con `npx tauri build --no-bundle` (sin eso apunta a localhost:1420).

## Rendimiento (JW-8-05)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File src-tauri\tests-manual\perf.ps1 [-Seconds 30] [-Settle 10]
```

Con JarWis ya en marcha (exe sin puerto de depuración), mide working set y private bytes de `jarwis.exe` y de su árbol (incluye `msedgewebview2.exe`), nº de procesos y CPU media con la isla visible y oculta (alterna con `win.ps1 tray-left`, comprueba con `win.ps1 visible "JarWis"`) y la restaura. PASS si el working set ≤ 37,7 MB (proceso) y ≤ 490 MB (árbol). Solo imprime cifras: no lee CommandLine ni rutas. Tarda ~90 s.
