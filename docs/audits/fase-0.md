# Auditoría — Fase 0 (línea base)

**Fecha.** 2026-08-20
**Alcance.** Todo lo heredado del laboratorio: 3 plugins, 1 contrato de agente, 3 archivos de prueba.
**Método.** Lectura de fuente, ejecución de la suite, verificación de la API del runtime
contra `@opencode-ai/plugin@1.18.18` (`dist/index.d.ts`), y consulta del estado real
de proveedores con `opencode auth list`.

---

## Veredicto

Lo construido tiene mejor criterio del que aparenta. El contrato de RECON es serio:
permisos declarativos, clasificación de evidencia y contrato de salida rígido. Eso ya
es ingeniería de agentes.

El problema no es la calidad de las piezas. Es que **la pieza que debía proteger no
está conectada a nada**, y el agente que sí está bien escrito **no puede arrancar**.

Estado del núcleo: **1 de 3 agentes escritos, 0 ejecutables, 0 fronteras verificadas.**

---

## Hallazgos

### H-01 · CRÍTICO · La política de seguridad no se aplica nunca

`lab/.opencode/plugins/policy-gate.ts:60-70`

El módulo exporta un objeto con una clave `tool`, que registra una herramienta
llamada `policy_gate` cuyo `execute()` devuelve `{ status: "ready" }` y nada más.

No engancha ningún hook. Ni `permission.ask`, ni `tool.execute.before`.

Consecuencia directa: `isDenied()` y `evaluatePolicy()` — la lógica entera de la
política — **solo las invocan los tests**. En una sesión real de OpenCode, `rm -rf ~`
y `git push --force` pasan sin que este archivo se entere.

El nombre del archivo dice "gate". El comportamiento es un `console.log` con corbata.

**Lo notable:** la lógica está bien. `evaluatePolicy` ya devuelve
`{ action: "allow" | "ask" | "deny" }`, que es **exactamente** el tipo que el hook
`permission.ask` espera en `output.status`. La pieza está tallada para encajar en un
enchufe al que nunca se conectó. Lo que falta no es rediseño: son las líneas de cableado.

**Se corrige en:** Fase 2, gate G2.5.

---

### H-02 · BLOQUEANTE · RECON apunta a un proveedor sin credenciales

`lab/.opencode/agents/recon.md:4` → `model: opencode/nemotron-3-ultra-free`

`opencode auth list` devuelve **0 credenciales**. El único proveedor disponible en
esta máquina es OpenRouter, y solo por la variable de entorno `OPENROUTER_API_KEY`.

El proveedor `opencode` no está autenticado. El agente, tal como está escrito hoy,
no puede ejecutarse.

Esto explica de forma bastante económica la sensación de estar atrasado: el trabajo
está bien hecho y no arranca, y una cosa se confunde fácil con la otra.

**Se corrige en:** Fase 1, gate G1.1.

---

### H-03 · ALTO · Los patrones de denegación se esquivan sin esfuerzo

`lab/.opencode/plugins/policy-gate.ts:7-21`

Las expresiones se aplican al comando completo y varias están ancladas a la línea entera.

`/^\s*rm\s+-rf\s+\/$/` exige que el comando sea *exactamente* `rm -rf /`. Pasan sin tocarse:

| Comando | Por qué pasa |
|---|---|
| `rm -rf / --no-preserve-root` | el `$` del ancla ya no cierra |
| `rm -fr /` | el patrón exige el orden `-rf` |
| `cd / && rm -rf .` | la ruta peligrosa nunca aparece literal |
| `echo ok; rm -rf ~` | la regex ancla en `^`, no evalúa el segundo comando |
| `RM=rm; $RM -rf ~` | expansión del shell, invisible a una regex |

Una lista de patrones sobre texto de shell es un filtro de ruido, no una frontera de
seguridad. Sirve para atrapar el error tonto, no al modelo que improvisa.

La frontera real tiene que ser el **nivel A** (que la herramienta ni se le entregue al
agente) y el **nivel B** aplicado sobre argumentos ya parseados. Ver `docs/ARCHITECTURE.md`.

**Se corrige en:** Fase 2, gates G2.3 y G2.4.

---

### H-04 · ALTO · El auditor falla en silencio, y ya falló

`lab/.opencode/plugins/realtime-auditor.ts:135-143`

`logEvent()` envuelve la escritura en un `try` con un `catch {}` vacío y el comentario
`// Silently fail logging`.

Esto no es teórico. Ocurrió durante esta misma auditoría:

- Suite ejecutada dentro de un sandbox sin permiso de escritura en `/tmp`:
  **4 fallos**, los cuatro en los tests de los hooks.
- La misma suite, mismo código, fuera del sandbox: **44/44 en verde**.

El plugin no registró ni un evento y no emitió ni una queja. Desde dentro, "el agente
no hizo nada peligroso" y "el auditor está muerto" se ven idénticos.

Un auditor que puede morir en silencio produce algo peor que ninguna evidencia:
produce confianza infundada. Si el registro es evidencia, no poder escribirlo tiene que
ser un error ruidoso.

Agrava el problema que la ruta `/tmp/opencode-audit.jsonl` (línea 3) sea una constante:
no configurable, y en `/tmp`, que es volátil por definición.

**Se corrige en:** Fase 3, gate G3.5.

---

### H-05 · MEDIO · La redacción de secretos no cubre los tokens de esta máquina

`lab/.opencode/plugins/realtime-auditor.ts:31-35`

Cubre `Bearer …`, `sk-…` y `ghp_…`.

No cubre:

| Formato | Qué es | Presente aquí |
|---|---|---|
| `gho_…` | token OAuth de GitHub CLI | **sí — las 3 cuentas de `gh` usan este prefijo** |
| `ghu_` / `ghs_` | tokens de usuario y de servidor de GitHub | posible |
| `github_pat_…` | PAT de nueva generación | posible |
| `AKIA…` | clave de acceso de AWS | no verificado |
| `eyJ…` | JWT | probable en cualquier API |

El formato exacto que esta máquina tiene en el llavero es justo el que el filtro no ve.

**Se corrige en:** Fase 3, gate G3.3.

---

### H-06 · MEDIO · Fuga de memoria en sesiones largas

`lab/.opencode/plugins/realtime-auditor.ts:145`

El mapa `sessions` se llena en `tool.execute.before` y solo se vacía en
`tool.execute.after`. Si una llamada se aborta, falla o el usuario la interrumpe, la
entrada queda para siempre. En un proceso de larga vida —que es exactamente lo que
será un orquestador— eso crece sin techo.

**Se corrige en:** Fase 3.

---

### H-07 · MEDIO · Tres ramas idénticas

`lab/.opencode/plugins/policy-gate.ts:44-58`

Las tres condiciones de `evaluatePolicy` comprueban un nivel de riesgo distinto y
hacen exactamente lo mismo. Colapsan en:

```ts
if (isDenied(args)) return { action: "deny", risk }
return { action: actionForRisk(risk), risk }
```

Cosmético en sí mismo, pero delata algo de fondo: el nivel de riesgo **no influye**
en la decisión de denegar. La función recibe un parámetro que no usa para decidir.
O el riesgo importa, o sobra.

**Se corrige en:** Fase 2.

---

### H-08 · MEDIO · Código sin pruebas

`lab/.opencode/plugins/context-intelligence.ts` — 216 líneas, el archivo más grande
del laboratorio, sin un solo test. Los otros dos plugins sí tienen suite.

Además estaba fuera de control de versiones hasta esta fase.

**Se corrige en:** Fase 1 (o se retira del alcance).

---

### H-09 · INFO · Esqueleto vacío — corregido

`core/`, `agents/`, `benchmarks/` y `profiles/` existían como directorios vacíos.
Git no versiona directorios vacíos, así que ni siquiera eran promesas: eran nada.

Eliminados. Se recrean cuando tengan contenido. Un árbol de carpetas no es arquitectura.

---

## Resumen

| ID | Severidad | Hallazgo | Fase |
|---|---|---|---|
| H-01 | CRÍTICO | La política no está cableada a ningún hook | 2 |
| H-02 | BLOQUEANTE | RECON apunta a un proveedor sin credenciales | 1 |
| H-03 | ALTO | Patrones de denegación evadibles | 2 |
| H-04 | ALTO | El auditor falla en silencio | 3 |
| H-05 | MEDIO | Redacción de secretos incompleta | 3 |
| H-06 | MEDIO | Fuga de memoria en `sessions` | 3 |
| H-07 | MEDIO | Riesgo calculado y no usado | 2 |
| H-08 | MEDIO | 216 líneas sin pruebas | 1 |
| H-09 | INFO | Esqueleto vacío | 0 · cerrado |

## Gate de Fase 0

- [x] Historial anterior preservado (`4457d1f` y `1e2d651` siguen en `git log`).
- [x] Sin secretos ni bases de datos versionadas — `oc.db` estaba vacío e ignorado.
- [x] Cada hallazgo con severidad, ruta y línea.
- [x] Suite heredada verificada: 44/44.

**Fase 0: CERRADA.**

## Lo que esta auditoría no cubrió

- `context-intelligence.ts` se leyó por encima; no se auditó su lógica.
- No se probó ninguna frontera de permisos en ejecución real. Ese es el trabajo de la
  Fase 1, y hasta entonces **ninguna frontera de este sistema puede darse por real**.
