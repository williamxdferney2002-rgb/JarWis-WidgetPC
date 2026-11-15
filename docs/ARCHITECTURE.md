# Arquitectura de JarWis

> Estado: **aprobada para la Fase 1C y la Fase 2** (cierre de la Fase 1B, 2026-10-18). Viabilidad por funcionalidad en `REQUIREMENTS.md`.

## Visión general
```
┌───────────── Frontend (WebView2) ─────────────┐
│ React + TypeScript + Tailwind                  │
│ Barra flotante · widgets · ajustes             │
└──────────────┬─────────────────────────────────┘
               │ comandos/eventos IPC de Tauri (permisos por capacidades)
┌──────────────┴──────────── Núcleo Rust (Tauri 2) ─────────────┐
│ jarwis-auth     OAuth Google/Microsoft + Administrador de      │
│                 credenciales                                   │
│ jarwis-google   Gmail, Calendar, Tasks (solo lectura)          │
│ jarwis-msgraph  Outlook mail/calendar (condicionado a D-016)   │
│ jarwis-system   CPU/RAM/disco/red (sysinfo) + batería (Win32)  │
│ jarwis-audio    IAudioEndpointVolume, loopback, GSMTC          │
│ jarwis-vault    detección de Bitwarden y siembra del acceso    │
│                 rápido (aislado, sin secretos, D-045)          │
│ jarwis-claude   lanzador (app, terminal, uso) y progreso de    │
│                 proyectos (D-044)                              │
│ storage         SQLite (caché y ajustes; sin secretos)         │
└────────────────────────────────────────────────────────────────┘
```

## Principios
- Workspace de Cargo en la raíz; cada módulo es un crate en `crates/` con una API async, sin pánicos y con estados degradados.
- Las capacidades de Tauri 2 limitan qué comandos invoca el frontend. Los permisos de autostart y global-shortcut se conceden de forma explícita.
- Los tokens nunca salen del núcleo Rust: el frontend recibe solo datos ya consultados.
- Sondeo adaptativo: frecuencia baja con la barra compacta u oculta.
- Cada dependencia nueva se justifica en `DECISIONS.md`.

## jarwis-auth (Fase 1C)
| Aspecto | Diseño |
|---|---|
| Flujo | Authorization Code + PKCE S256, `state` validado, navegador del sistema (`rundll32 url.dll,FileProtocolHandler`) |
| Redirect | Google: `http://127.0.0.1:<efímero>`. Microsoft: `http://localhost:<efímero>`; Microsoft ignora el puerto en localhost |
| Loopback | `std::net::TcpListener`, una conexión, timeout de 5 min |
| Tokens | Refresh token en el Administrador de credenciales (`keyring-core` + `windows-native-keyring-store`), persistencia **Local**, `set_secret` en UTF-8, máximo 2560 bytes. Access token solo en memoria |
| Rotación | El refresh token de Microsoft rota en cada uso: se sobrescribe siempre |
| Desconexión | Google: `POST /revoke` y borrado. Microsoft: borrado e instrucción para retirar el consentimiento |
| Configuración de clientes | `%APPDATA%\JarWis\oauth-clients.json`, fuera del repo |
| Dependencias | `oauth2` 5 (reqwest 0.12 + rustls a través de su re-export), keyring-core, windows-native-keyring-store, tokio, serde/serde_json |

## Fase 2 (app base)
- Plugins: `single-instance` (registrado el primero), `window-state`, `positioner`, `autostart`, `global-shortcut` y `opener`. Bandeja con la feature `tray-icon`.
- Ventana sin bordes, `transparent: true`, sin Mica en la barra (D-026: no se recorta en forma de píldora); fondo con CSS.
- Reserva del borde y ocultación automática con `SHAppBarMessage` en una iteración posterior.

## Estructura del repositorio
```
JarWis/
  Cargo.toml               workspace
  crates/jarwis-auth/      Fase 1C
  src-tauri/               Fase 2 (miembro del workspace)
  src/                     Fase 2 (React)
  docs/  .claude/  CLAUDE.md
```

## Prototipos pendientes
DPI multi-monitor, rendimiento de Acrylic en la build 26300, GSMTC en una app sin empaquetar y tamaño real de los refresh tokens de Microsoft.
