# Seguridad de JarWis

Reglas operativas para los agentes: `.claude/rules/security.md`. Este documento describe el modelo de seguridad del producto.

## Principios
1. Gestores y bibliotecas consolidadas; sin criptografía propia.
2. Mínimo privilegio: OAuth de solo lectura hasta que una función necesite escritura.
3. Separación de datos personales y contexto de IA: los agentes nunca ven contenido de correos, tokens ni secretos.
4. Fallo seguro: un módulo caído no bloquea la app ni filtra información en los errores.

## Secretos y tokens
| Elemento | Dónde vive | Nunca en |
|---|---|---|
| Refresh/access tokens de Google y Microsoft | Administrador de credenciales de Windows (DPAPI), un registro por cuenta | repo, archivos planos, logs, stdout |
| `client_id` OAuth | Archivo de configuración local excluido de Git (no es secreto, pero se mantiene fuera del repo) | — |
| `client_secret` de la app de escritorio de Google | Igual que el `client_id`. Google lo considera no confidencial en apps instaladas | logs |
| Contraseña maestra de Bitwarden | Solo en la cabeza del usuario / Windows Hello | en ninguna parte de JarWis |

## OAuth (Fase 1C)
- Authorization Code + PKCE (S256), parámetro `state` aleatorio y validado.
- Navegador del sistema; redirección loopback `http://127.0.0.1:<puerto efímero>`.
- Google: `openid email`, `gmail.readonly`, `calendar.readonly`, `tasks.readonly`. Proyecto en Testing al inicio (refresh token caduca a los 7 días); después, producción sin verificar para uso personal si se confirma que está permitido.
- Microsoft: sin uso (D-016 c: el correo de Outlook llega reenviado a Gmail). La ruta del crate queda sin activar.
- Desconexión por cuenta: revocar en el proveedor cuando exista endpoint + borrar la credencial local.

## Datos personales en pruebas
- La salida por defecto: cuenta autenticada, conteos, IDs, fechas y el dominio del remitente.
- `--show` (asuntos/remitentes completos) solo lo ejecuta el usuario en su propia terminal.
- No se envía, borra, archiva ni modifica nada.

## Bitwarden
- Integración (D-045): sin widget ni comandos propios. Al arrancar, fuera del hilo principal, `bitwarden.rs` detecta la app de escritorio oficial (exe en rutas fijas o Store por nombre visible, D-041) y siembra **una sola vez** un acceso rápido «Bitwarden» al principio de la lista, validado con `validate_one` y abierto como cualquier otro acceso (`open_shortcut`, solo por id). El destino del acceso sembrado (ruta del exe o AUMID) se ve en Ajustes igual que el de cualquier acceso guardado; el módulo no envía a la WebView ninguna otra ruta ni dato.
- Desbloqueo con Windows Hello gestionado por Bitwarden, no por JarWis.
- Sin lectura del contenido de la bóveda. Cualquier ampliación requiere un diseño auditado por `security-auditor` y aprobación del usuario.
- Módulo aislado: solo usa `shortcuts`, `settings` y `audio::Com`; sin dependencias con los módulos de correo o nube. Nunca lee la carpeta de datos de Bitwarden.

## Lanzadores con destino fijo (D-047)
- `media_open` y `claude_open` solo reciben un enum; las URL, AUMID y rutas están en el núcleo. Apps de la Tienda revalidadas contra las instaladas antes de abrir (D-037): Spotify, Netflix (`4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App`), Claude (`Claude_pzs8sxrjxfjjc!Claude`) y ChatGPT (`OpenAI.Codex_2p2nqsd0c76g0!App`); si no están, su web oficial por HTTPS.
- Exe fijos solo con `fixed_exe` (absoluta, existente y ruta canónica igual a la candidata, sin enlaces ni uniones): Spotify (`%APPDATA%`), Bitwarden (D-041) y Antigravity IDE (`%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe`, sin web de respaldo).
- Terminal: `wt.exe -d %USERPROFILE% <claude.exe>` sin shell; carpeta validada (local, sin `;` ni comillas) y solo `claude.exe` nativo en rutas absolutas (nunca `.cmd`).

## Exportación «hoy.json» (D-048)
- **Qué:** `updated` (fecha y hora local) y, de la agenda de Google, solo títulos y fechas: tareas `{title, due}` (máximo 20, las mismas que muestra la isla) y eventos `{title, start, allDay}`. Nunca ids, enlaces, correo, remitentes ni tokens (test `today_json_has_only_titles_and_dates`).
- **Dónde:** `%LOCALAPPDATA%\JarWis\hoy.json`, en el perfil del usuario (protegido por los permisos del perfil, no cifrado). Escritura atómica; un fallo se ignora.
- **Por qué:** lo lee en local el resumen de la mañana del usuario (`/morning`), que no tiene conector para Google Tasks. JarWis no envía el archivo a ningún sitio ni abre red para escribirlo. El resumen de la mañana (`/morning` con `claude -p`) sí pasa estos títulos y fechas a Claude, con autorización explícita del usuario.
- **Control:** ajuste `shareToday` (activado por defecto, decisión del usuario). Apagarlo borra el archivo (y su temporal) y deja de escribirse; también se borra al cerrar sesión de Google y al arrancar con el ajuste apagado. Se escribe solo tras una consulta de agenda correcta, nunca desde la caché ni con la sesión cerrada.
- **Concurrencia (JW-12):** escritura y revocación comparten un bloqueo; cada exportación lleva un ticket capturado antes de consultar Google. Apagar compartir o cambiar sesión invalida los tickets anteriores. Logout espera a las escrituras ya iniciadas antes de borrar; un trabajo encolado antiguo no puede recrear el archivo ni sobrescribir una exportación posterior.

## Portapapeles (D-028)
- Captura por eventos (`WM_CLIPBOARDUPDATE`), solo texto de hasta 64 KB, **solo en memoria** (50 elementos más los fijados); nada en disco ni en logs; se pierde al cerrar.
- Exclusiones, evaluadas con el portapapeles abierto y antes de leer el texto: `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory`=0, `CanUploadToCloudClipboard`=0, y propietario Bitwarden / 1Password / KeePass* (apps de escritorio). Si no se pueden registrar los formatos, no se captura nada.
- **Límite conocido:** lo copiado desde extensiones del navegador tiene como propietario el navegador; solo se excluye si la extensión lo marca. JarWis conserva el texto aunque el gestor vacíe el portapapeles después.
- La WebView recibe fragmentos de 300 caracteres bajo demanda; la copia se hace por id y el texto completo no sale del núcleo. El evento de cambio no lleva contenido.
- Las pruebas con el portapapeles real (`tests-manual/clipboard.mjs`) solo con el usuario ausente y con su consentimiento; solo imprimen textos `jarwis-prueba*`.

## Pruebas de UI con datos personales (lección de JW-4-03)
- Con una sesión real guardada, la WebView muestra datos reales. Toda prueba por CDP inyecta datos ficticios interceptando `fetch` (`__TAURI_INTERNALS__.invoke` no es escribible). Antes de capturar o leer el DOM, comprueba que el mock está activo con un comando que solo existe en él y con filas centinela `jarwis-prueba`; si no, aborta.
- El mock nunca rechaza un fetch: Tauri reenviaría la orden al backend real por postMessage.
- No se capturan ventanas que muestren configuración real (Ajustes) sin simularla.
