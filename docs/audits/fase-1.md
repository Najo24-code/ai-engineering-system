# Auditoría — Fase 1 (un agente que corre y está encerrado)

**Fecha.** 2026-08-20
**Estado.** **ABIERTA** — bloqueada en G1.1 por una credencial inválida.
**Método.** Se levantó un servidor real de OpenCode y se consultó el agente
*resuelto* en `/agent` y `/config`, en vez de leer el frontmatter y suponer.

---

## Por qué esta fase se audita mirando el runtime y no el archivo

El frontmatter es lo que uno *declara*. El agente resuelto es lo que el runtime
*hace*. Esta auditoría demuestra que no son lo mismo, y que la diferencia no
avisa: OpenCode descarta lo que no entiende sin un solo mensaje de error.

---

## Hallazgos

### H-10 · CRÍTICO · De 10 permisos declarados, 6 se descartaban en silencio

Estado del `recon.md` heredado, según el agente resuelto por el runtime:

| Declarado en el frontmatter | ¿Lo aplicó el runtime? |
|---|---|
| `edit: deny` | sí |
| `bash: deny` | sí |
| `task: deny` | sí |
| `webfetch: deny` | sí |
| `read: allow` | **no** — clave no válida en `permission` |
| `glob: allow` | **no** |
| `grep: allow` | **no** |
| `list: allow` | **no** — *y la herramienta `list` ni siquiera existe* |
| `websearch: deny` | **no** — *la herramienta `websearch` no existe* |
| `todowrite: deny` | **no** |

Cuatro de diez. Ninguna de las seis restantes produjo advertencia.

La regla base del agente resuelto es `{ permission: "*", pattern: "*", action: "allow" }`.
Lo que no se niega con una clave que el runtime reconozca, **queda permitido**.

Consecuencia: RECON, descrito en su propio prompt como *strictly read-only*, tenía
`todowrite` permitido y dos permisos que solo existían en la imaginación del archivo.

### H-11 · CRÍTICO · `write` es una herramienta distinta de `edit`

La lista real de herramientas de este runtime (obtenida de `/experimental/tool`) es:

```
bash  edit  glob  grep  invalid  question
read  skill  task  todowrite  webfetch  write
```

más las que inyectan los plugins: `context_briefing`, `context_daily`,
`context_search`, `policy_gate`.

`write` crea archivos y es **independiente** de `edit`. El contrato heredado negaba
`edit` y nunca mencionó `write`.

Un agente de solo lectura con la herramienta de crear archivos disponible no es un
agente de solo lectura. Es un agente de escritura al que nadie le ha pedido todavía
que escriba.

### H-12 · ALTO · `tools: { write: false }` no genera regla de denegación

Tras reescribir el contrato, el adaptador emitió trece entradas `tools: … false`.
El runtime convirtió doce de ellas en reglas `deny`:

```
bash  context_briefing  context_daily  context_search  edit
invalid  policy_gate  question  skill  task  todowrite  webfetch
```

Falta exactamente una: **`write`**. En el agente resuelto no aparece ninguna regla
para `write`, así que sigue cayendo en `*: allow`.

`/config` confirma que el valor **sí se parseó** (`"write": false` está ahí). Se
pierde entre el parseo y la resolución del agente.

Puede que OpenCode cubra `write` bajo la clave `edit` por tratarse ambas de
escritura. **Es una hipótesis, no un hallazgo, y no se registra como tal.**
Solo la prueba de fuga la resuelve, y esa prueba está bloqueada por G1.1.

Hasta entonces, la posición del sistema es la conservadora: **la capacidad de
escritura de RECON se considera NO contenida.**

### H-13 · BLOQUEANTE · `OPENROUTER_API_KEY` es inválida

```
GET https://openrouter.ai/api/v1/auth/key
→ HTTP 401 {"error":{"message":"User not found.","code":401}}
```

Comprobado contra la API de OpenRouter directamente, no a través de OpenCode. La
clave está revocada o su cuenta ya no existe. Se define en `~/.bashrc`.

Con esto, el estado de proveedores de la máquina es: **cero rutas de ejecución
disponibles.** `opencode auth list` no tiene credenciales, y la única variable de
entorno presente no autentica.

**H-02 no queda resuelto por esta fase, solo desplazado**: el modelo ya apunta a un
proveedor correcto; lo que falta ahora es una credencial que funcione.

---

## Lo que sí quedó construido

- `agents/recon/agent.json` — contrato portable, ocho campos, sin sintaxis de ningún runtime.
- `agents/recon/prompt.md` — el prompt, separado del contrato.
- `runtimes/opencode/runtime.json` — hechos **verificados** del runtime, con su fecha.
  Caduca al subir de versión.
- `runtimes/opencode/sync.mjs` — el adaptador.

El adaptador no traduce «deny» a «deny». Parte de que **todo está permitido**, que
es la verdad del runtime, y construye la negación de todo lo que el contrato no
permitió de forma explícita. Una herramienta nueva en una versión futura de OpenCode
nace negada, sin que nadie tenga que acordarse de negarla.

Se validó a sí mismo en su primera ejecución: rechazó el contrato porque declaraba
`list`, `patch` y `websearch`, tres herramientas que no existen.

```
recon: declara la herramienta "list", que no existe en opencode 1.18.18
recon: declara la herramienta "patch", que no existe en opencode 1.18.18
recon: declara la herramienta "websearch", que no existe en opencode 1.18.18
```

Ese es el trabajo que el frontmatter escrito a mano nunca iba a hacer.

---

## Estado del gate

| Gate | Estado | Nota |
|---|---|---|
| G1.1 arranca | 🔴 | bloqueado por H-13 |
| G1.2 cumple el contrato | ⚪ | requiere G1.1 |
| G1.3 no inventa | ⚪ | requiere G1.1 |
| G1.4 prueba de fuga | 🔴 | **el gate central**; bloqueado por H-13 y por H-14 |
| G1.5 prueba de cableado | 🟡 | parcial: el encierro se verificó en el agente resuelto, no en ejecución |

### H-14 · MEDIO · Un subagente no se puede ejecutar directamente

```
! agent "recon" is a subagent, not a primary agent. Falling back to default agent
```

`opencode run --agent` solo acepta agentes primarios. Para la prueba de fuga hace
falta o bien invocar a RECON con la herramienta `task` desde un agente primario, o
bien generar una variante primaria solo para la prueba.

Lo segundo prueba una configuración distinta de la que se usa en producción, así que
la primera es la vía correcta. Queda decidido para cuando G1.1 se desbloquee.

---

## Veredicto

La Fase 1 sigue abierta y **es correcto que siga abierta**.

El encierro de RECON mejoró de forma comprobable: de 4 permisos efectivos sobre 10
declarados, a 16 herramientas con posición explícita y default-deny. Pero *mejoró*
no es *demostrado*, y `write` sigue sin contención probada.

Lo que esta fase ya demostró, y era su propósito, es que **la intuición de partida
era correcta**: escribir `deny` en un archivo no es negar nada. Seis de diez
denegaciones eran decorativas y el sistema jamás lo dijo.
