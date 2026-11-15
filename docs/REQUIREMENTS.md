# Requisitos de JarWis

Estado de viabilidad según la investigación oficial JW-1B-01 (2026-10-18). Fuentes en `docs/research/JW-1B-01.md`.
**VIABLE** · **CONDICIONADA** (se indica la condición) · **NO DISPONIBLE** · **PROTOTIPO** (hay que probarla en local).

## A — Barra flotante
| Requisito | Estado |
|---|---|
| Siempre visible, posición superior/inferior/lateral, bandeja, inicio automático, atajos globales, tema claro/oscuro | VIABLE (plugins oficiales de Tauri 2 + `tray-icon`) |
| Multi-monitor y distintos DPI | VIABLE · PROTOTIPO (comportamiento del DPI al cambiar de monitor) |
| Mica | VIABLE (solo Windows 11) |
| Acrylic / Blur | CONDICIONADA: Microsoft documenta mal rendimiento al arrastrar o redimensionar |
| Ocultación automática y reserva del borde de pantalla | CONDICIONADA: `SHAppBarMessage` propio con el crate `windows` |
| Widgets reordenables y animaciones | VIABLE (React) |

## B — Google (cuenta personal)
| Requisito | Estado |
|---|---|
| Gmail, Calendar y Tasks en solo lectura | VIABLE: producción sin verificar, uso personal (≤100 usuarios conocidos), sin costo |
| Tasks: crear, editar, completar | CONDICIONADA: ampliar el permiso a `tasks` (requiere autorización) |
| Resúmenes de correo con IA | CONDICIONADA: enviar datos de Gmail (permiso restringido) a terceros puede exigir la evaluación de seguridad de Google. Requiere revisión de `security-auditor` y autorización |
| Notificaciones de correo nuevo | VIABLE por sondeo (push requiere Pub/Sub; evaluar más adelante) |

## C — Outlook (cuenta personal, Microsoft Graph)
| Requisito | Estado |
|---|---|
| Correo de Outlook | VIABLE vía reenvío a Gmail con la etiqueta "Outlook" (D-016 c) |
| Calendario de Outlook | NO DISPONIBLE sin Graph/Azure (descartado en D-016) |
| ~~Graph directo~~ | CONDICIONADA: requiere un tenant de Microsoft Entra; la vía oficial es una cuenta gratuita de Azure que **pide tarjeta** (sin cargo). Descartada en D-016 (opción c) |
| Revocación en el proveedor | NO DISPONIBLE (el endpoint `consumers` no tiene revocación): se borra la credencial local y el usuario retira el consentimiento en su cuenta |
| Bandeja unificada Gmail + Outlook | CONDICIONADA a C |

## D — Claude / Claude Code
| Requisito | Estado |
|---|---|
| Accesos rápidos a Claude, Claude Code y proyectos | VIABLE |
| Uso de la sesión de 5 h, uso semanal y reinicio de límites | RETIRADO (D-044, JW-9-03): la status line solo cubría la CLI; el panel enlaza a la página oficial https://claude.ai/settings/usage |
| Tokens y coste por sesión de Claude Code | RETIRADO con la status line (D-044) |
| Uso de claude.ai fuera de Claude Code | NO DISPONIBLE por vía programática oficial |
| Leer transcripciones `~/.claude/projects/*.jsonl` | Prohibido: texto plano con conversaciones y formato no contractual |
| Progreso del proyecto JarWis | VIABLE (Git y `docs/PROGRESS.md`) |

## E — Contraseñas (Bitwarden)
| Requisito | Estado |
|---|---|
| Abrir la app de escritorio | IMPLEMENTADO como acceso rápido «Bitwarden» sembrado una vez, el primero de la lista (exe o Store, D-045). Sin widget propio |
| Windows Hello | VIABLE, gestionado por Bitwarden. **La app debe descargarse de bitwarden.com, no de Microsoft Store** |
| Estado de la bóveda | CONDICIONADA: `bw status` solo da el estado de la sesión del CLI, no el de la app |
| Generador de contraseñas | CONDICIONADA: CLI instalado; hay que verificar si funciona sin sesión |
| Informes de contraseñas débiles o expuestas, contenido de la bóveda | Solo dentro de Bitwarden |

## F — Monitoreo
| Requisito | Estado |
|---|---|
| CPU, RAM, disco, red, tiempo encendido | VIABLE (`sysinfo`, una sola instancia, sondeo adaptativo) |
| Batería y carga | VIABLE (`GetSystemPowerStatus`) |
| Latencia | VIABLE (ping propio) |
| Uso de GPU | CONDICIONADA (no verificado) |
| Temperaturas | NO DISPONIBLE sin drivers o herramientas del fabricante |

## G — Audio y multimedia
| Requisito | Estado |
|---|---|
| Volumen, silencio, listar dispositivos | VIABLE (`IAudioEndpointVolume`) |
| Cambiar el dispositivo predeterminado | NO DISPONIBLE (API no pública): se abre `ms-settings:sound-devices` |
| Visualizador de audio | VIABLE (captura loopback WASAPI) |
| Controles e información de medios | PROTOTIPO (`GlobalSystemMediaTransportControlsSessionManager` en una app sin empaquetar) |

## H — Accesos rápidos
Abrir URLs, aplicaciones, carpetas y archivos: VIABLE (plugin opener) · Comandos autorizados: CONDICIONADA (lista blanca del plugin shell y auditoría de seguridad) · Búsqueda y categorías: VIABLE.

## I — Productividad
Notificaciones, agenda, resumen diario y panel de prioridades: VIABLE, dependen de B y C · Historial del portapapeles: CONDICIONADA (respetar `ExcludeClipboardContentFromMonitorProcessing` y no guardar lo copiado desde gestores de contraseñas) · Modo concentración: CONDICIONADA (no hay API para activarlo; se abre `ms-settings:quiethours`) · Espacios de trabajo: VIABLE.

## No funcionales
- Referencia medida: una app Tauri vacía usa 29 MB en su propio proceso y unos 377 MB de memoria en uso sumando WebView2 (memoria compartida contada varias veces). Objetivo: que JarWis en reposo no supere esa referencia en más de un 30 %.
- Ningún módulo bloquea la app ante fallos de red o autenticación.
- Windows 11, sin privilegios de administrador para el uso normal. Rutas de compilación cortas (límite de 260 caracteres).
