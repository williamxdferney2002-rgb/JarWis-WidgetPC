# Flujo multiagente de JarWis

```
Usuario → Arquitecto → Ejecutor → Auditor → Arquitecto → (integrar | corregir)
```

1. El arquitecto (sesión principal) recibe el objetivo y lo divide en tareas.
2. Clasifica cada tarea por complejidad, riesgo e impacto.
3. Elige al ejecutor:
   - Baja/media sin riesgo de seguridad → `simple-executor` (Sonnet).
   - Alta, integraciones, Windows, OAuth, seguridad, concurrencia → `complex-executor` (Opus).
4. Escribe la orden de trabajo (plantilla abajo) con los criterios de aceptación.
5. El ejecutor implementa y hace pruebas preliminares; entrega un informe.
6. El auditor revisa de forma independiente:
   - Estándar → `auditor` (Sonnet).
   - Seguridad, auth, tokens, contraseñas, datos personales, servicios externos → `security-auditor` (Opus, alto).
   - Cambios triviales (docs/estilos) → se acumulan y se auditan en lote al cerrar la fase.
7. APROBADO / APROBADO CON OBSERVACIONES → el arquitecto hace el commit y registra en `PROGRESS.md` y `AUDIT_LOG.md`.
8. RECHAZADO → el arquitecto interpreta los hallazgos, ajusta la orden y vuelve a delegar. **Máximo 3 ciclos**; después se escala al usuario.
9. BLOQUEADO POR LIMITACIÓN EXTERNA → se documenta y se informa al usuario.

Reglas: nadie audita su propio trabajo · no hay dos ejecutores sobre los mismos archivos · "implementado" ≠ "verificado" · se conservan las evidencias de las pruebas.

## Plantilla de orden de trabajo
```
ID: JW-<fase>-<nn>
Objetivo:
Complejidad: baja | media | alta | crítica
Ejecutor: simple-executor | complex-executor
Auditor: auditor | security-auditor | lote
Archivos permitidos:
Criterios de aceptación:
  1.
Pruebas requeridas:
Restricciones:
```

## Registro por tarea (PROGRESS.md)
ID · objetivo · complejidad · agente · archivos modificados · pruebas ejecutadas · resultados · informe del auditor · correcciones · estado final.
