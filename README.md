# AI Engineering System

Sistema de ingeniería de software multiagente: agentes con responsabilidades
separadas, permisos que de verdad se aplican y resultados que se verifican en vez
de creerse.

De uso personal. Pensado para funcionar en cualquier entorno, no dentro de una
herramienta concreta.

## La idea en una frase

Un agente no se define por su prompt, sino por lo que **no** puede hacer y por lo
que otro mecanismo **comprueba** de su trabajo.

De ahí sale la regla que sostiene todo lo demás:

> **Una política sin prueba de cableado se considera NO implementada.**
> El test de unidad no basta. Hay que demostrar, con el sistema corriendo, que
> la acción prohibida falla de verdad — y con control positivo, porque si no,
> un agente perezoso y una frontera sólida producen el mismo resultado.

Escribir la regla y cablear la regla son dos trabajos distintos, y solo el
segundo protege algo.

## Estructura

```
agents/       contratos de agente, portables      (fuente de verdad)
core/
  policies/     reglas de permiso cableadas a hooks
  sandbox/      el recinto: lo prohibido no se deniega, se vuelve imposible
  verification/ el que comprueba y no cree
  flow/         las etapas del ciclo, que dispara una persona
runtimes/
  opencode/   adaptador para OpenCode, y el plugin del policy gate
lab/          banco de pruebas: el repo sobre el que trabajan los agentes
docs/
  ARCHITECTURE.md  las cinco capas y dónde bloquea cada nivel
  ROADMAP.md       las siete fases y el gate de cada una
  audits/          un informe por fase; sin él la fase no cierra
```

Regla de dependencia: `agents/` no importa nada de `runtimes/`. El día que el
runtime sea otro, se reescribe un adaptador, no los agentes.

---

## El ciclo

```
RECON  →  BUILD  →  [verificador]  →  REVIEW  →  (rechazo) → BUILD
entiende  implementa   MIDE            JUZGA
```

Entre etapa y etapa aprieta el botón una persona. El orquestador es de la Fase 5;
hasta que el ciclo sea aburrido de tan confiable, automatizar el disparo solo
sirve para equivocarse más rápido.

| Agente | Puede | No puede |
|---|---|---|
| **RECON** | leer | escribir, ejecutar, delegar |
| **BUILD** | escribir en `src/**` y `tests/**`, correr la verificación | salir de su alcance, tocar secretos o CI, instalar, hacer commit |
| **REVIEW** | leer | **modificar nada**, **ejecutar nada** — ni siquiera los tests |

Que REVIEW no corra los tests es deliberado: si los corriera y reportara el
resultado, el sistema volvería a depender de que un agente diga la verdad sobre
los tests. Eso lo mide el verificador, que no es un agente.

## Las cinco capas de control

Están en `docs/ARCHITECTURE.md` con la evidencia de cada una.

- **A** declarativo — el runtime no le entrega la herramienta.
- **B** programático — el policy gate decide por ruta y por comando en cada llamada.
- **C** observación — audita; no bloquea.
- **D** el recinto — `core/sandbox/`, bubblewrap. Lo prohibido no se deniega: se
  vuelve **imposible**. Niega por omisión, así que no depende de que alguien se
  acordara de enumerar el peligro.
- **E** el verificador — `core/verification/verdict.mjs`. No bloquea acciones:
  rechaza **afirmaciones**. Regla dura: **lo que no se puede medir no pasa.**

---

## Apuntarlo a un proyecto tuyo

Requisitos: `node` 22+, `bwrap` (bubblewrap), `opencode`, y `OPENROUTER_API_KEY`
en el entorno.

```bash
# 1. instalar el sistema en el proyecto (crea su .opencode/)
node runtimes/opencode/sync.mjs --en /ruta/a/tu-proyecto

# 2. RECON entiende y BUILD implementa
node core/flow/recon-build.mjs --target /ruta/a/tu-proyecto \
  --task "lo que hay que hacer, en una frase"

# 3. el verificador mide y REVIEW juzga
node core/flow/review.mjs --run runs/<fecha>

# 4. si REVIEW rechaza, el trabajo vuelve a BUILD
node core/flow/rework.mjs --run runs/<fecha>
node core/flow/review.mjs --run runs/<fecha>/vuelta-2
```

Cada corrida deja `runs/<fecha>/` con lo que RECON entendió, lo que BUILD dice
que hizo, **lo que hizo de verdad** (`cambios.diff`), lo que la política le negó,
lo que se midió y lo que REVIEW dictaminó. `runs/` no se versiona: ahí dentro hay
transcripts completos.

⚠️ El proyecto tiene que ser un repositorio git: el verificador compara contra
`HEAD` para saber qué tocó el agente.

⚠️ El plugin instalado apunta a la política de **este** repositorio por ruta
absoluta. Si mueves el sistema de sitio, vuelve a correr el paso 1.

---

## Comprobar que las fronteras siguen siendo reales

```bash
npm test                  # 46 tests, ~1 s, CERO llamadas al proveedor
npm run gate:contencion   # el recinto: 13 ataques deterministas, cuesta cero
npm run sync:check        # ¿los agentes instalados coinciden con sus contratos?
```

Estos tres se pueden correr siempre. Los que llaman al modelo —
`core/verification/wiring.mjs` y `core/verification/boundary.mjs` — cuestan
corridas reales y por eso no son parte de `npm test`: una suite que gasta cuota
del proveedor se deja de correr, y una suite que no se corre no protege nada.

⚠️ `gate:contencion` mide la red. Correrlo dentro de un sandbox que bloquee la
salida a internet convierte un ataque contenido en un "no discrimina" que no es
verdad.

---

## Estado

| Fase | Qué prueba | Estado |
|---|---|---|
| 0 · Fundación | saber qué hay | **cerrada** |
| 1 · Un agente encerrado | que la frontera sea real | **cerrada** |
| 2 · Frontera de escritura | que BUILD no se salga | **cerrada** |
| 3 · Verificación | que el sistema no crea | **cerrada** |
| 4 · Ciclo de tres | RECON → BUILD → REVIEW | en curso |
| 5 · Orquestación | que ATLAS decida | |
| 6 · Portabilidad | que sobreviva fuera de OpenCode | |

Detalle en [`docs/ROADMAP.md`](docs/ROADMAP.md); un informe por fase en
[`docs/audits/`](docs/audits/).

Una fase no se cierra sin su informe, y si el gate falla la fase sigue abierta:
no se avanza "mientras tanto" a la siguiente.
