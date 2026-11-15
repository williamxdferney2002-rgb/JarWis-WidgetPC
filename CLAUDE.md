# JarWis

Centro de control personal para Windows 11: barra flotante inteligente. Aplicación de escritorio real e instalable.
Nombre oficial y permanente: **JarWis** (no usar nombres provisionales).

Stack aprobado: Tauri 2 + React + TypeScript + Rust (+ Tailwind, SQLite cuando haga falta). Ver `docs/ARCHITECTURE.md`.

## Rol de esta sesión: Arquitecto y Orquestador
La sesión principal es el Arquitecto (Opus 5.5, esfuerzo medio; alto solo para decisiones complejas).
Planifica, delega, integra y registra. **Delega la programación** siempre que sea conveniente.

Flujo obligatorio para toda tarea: **ARQUITECTO → EJECUTOR → AUDITOR → APROBACIÓN O CORRECCIÓN**. Detalle en `docs/AGENT_WORKFLOW.md`.

| Agente | Modelo | Uso |
|---|---|---|
| `architect` | Opus, medio | Investigación/diseño de solo lectura |
| `simple-executor` | Sonnet, medio | UI simple, estilos, docs, config, errores localizados |
| `complex-executor` | Opus, medio | OAuth, Graph, Windows, seguridad, persistencia, concurrencia |
| `auditor` | Sonnet, medio | Auditoría estándar |
| `security-auditor` | Opus, alto | Auditoría reforzada: seguridad, auth, contraseñas, datos privados, servicios externos |

- Nunca un ejecutor audita su propio trabajo. Máximo 3 ciclos de corrección; después, escalar al usuario.
- Cambios triviales (docs/estilos): auditoría en lote al cerrar cada fase.
- Registrar cada tarea en `docs/PROGRESS.md` y cada informe en `docs/AUDIT_LOG.md`; decisiones en `docs/DECISIONS.md`.
- No paralelizar ejecutores sobre los mismos archivos.

## Optimización de tokens (D-033)
- **Reparto por capa, no por tarea:** Opus (`complex-executor`) solo para Rust, Win32, OAuth/seguridad, concurrencia y persistencia. Interfaz (React, CSS, textos, capturas, ajustes visuales) → `simple-executor` (Sonnet). Si una funcionalidad mezcla ambas, se divide en dos órdenes secuenciales: primero el núcleo con su API, después la UI.
- **Pedidos agrupados:** no enviar añadidos a un ejecutor en marcha salvo bloqueo; acumularlos para la siguiente orden.
- **Informes cortos:** cada agente devuelve como máximo unas 40 líneas; el detalle va en `docs/reports/<ID>.md`.
- **Reutilizar verificación:** usar los scripts de `src-tauri/tests-manual/` antes de escribir otros nuevos.
- **Una sesión por fase:** el estado vive en `docs/` y Git; al cerrar una fase, abrir una sesión nueva en lugar de prolongar la actual.

## Plan del usuario: Claude Pro
Consumo limitado. Sonnet por defecto para lo sencillo; Opus solo cuando aporta. Evitar investigaciones duplicadas: leer `docs/` antes de investigar.

## Idioma
Documentación, comentarios e interfaz en español. Código, identificadores y commits en inglés.

## Requiere autorización explícita del usuario
Instalar software global · modificar configuración de Windows · acceder a cuentas personales · leer mensajes reales · acceder a credenciales · acciones destructivas · archivos fuera del proyecto · publicar código (repo solo local por ahora) · servicios con costo · conectar integraciones externas · abrir cada pantalla de inicio de sesión inicial.

Reglas de seguridad y Git: `.claude/rules/`.
