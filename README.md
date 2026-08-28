# AI Engineering System

[![ci](https://github.com/Najo24-code/ai-engineering-system/actions/workflows/ci.yml/badge.svg)](https://github.com/Najo24-code/ai-engineering-system/actions/workflows/ci.yml)

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
ISSUE →  RECON  →  BUILD  →  [verificador]  →  REVIEW  →  (rechazo) → BUILD
         entiende  implementa   MIDE            JUZGA          ↓
                                                          [publicar] → PR
```

Entra por un issue de GitHub y sale por un pull request. Las dos puntas son
código determinista, no agentes: **ningún agente abre un PR**, porque publicar
exige comprobar cosas que quien hizo el trabajo no puede comprobar sobre sí mismo.

Entre etapa y etapa aprieta el botón una persona. El orquestador es de la Fase 5;
hasta que el ciclo sea aburrido de tan confiable, automatizar el disparo solo
sirve para equivocarse más rápido.

| Agente | Puede | No puede |
|---|---|---|
| **RECON** | leer | escribir, ejecutar, delegar |
| **BUILD** | escribir donde diga la instalación del proyecto, correr la verificación | salir de su alcance, tocar secretos o CI, instalar, hacer commit |
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
  Mide cinco: la suite (la corre él, encerrada), la regresión de la suite, el
  alcance del diff, los secretos que añade y las citas del informe. La de
  regresión existe porque las otras cuatro miran el estado final, y borrar los
  tests que se pusieron en rojo deja un estado final impecable.

---

## Apuntarlo a un proyecto tuyo

### Requisitos

Medidos el 2026-08-26 montando una instalación limpia desde cero, no recordados.
Lo que decía antes esta sección describía la máquina donde se construyó el
sistema, que es exactamente lo que la Fase 6 existe para no dar por bueno.

| qué | por qué | cómo se pone |
|---|---|---|
| `node` 22+ | el sistema entero | — |
| `git` | el verificador compara el árbol contra `HEAD` | `apt install git` |
| `bwrap` (bubblewrap) | **el recinto**, y sin él fallan 5 pruebas de la suite | `apt install bubblewrap` |
| `opencode` | el runtime | `curl -fsSL https://opencode.ai/install \| bash` |
| credencial del proveedor | las llamadas al modelo | `opencode auth login` |
| `gh` autenticado | **solo** para `publicar.mjs` | `gh auth login` |

⚠️ **La credencial NO va en el entorno.** Esta sección decía «`OPENROUTER_API_KEY`
en el entorno» y era falso desde el 2026-08-25: el proveedor es OpenCode Zen y su
credencial vive donde la deja `opencode auth login` (`~/.local/share/opencode/auth.json`).
Quien siguiera el README ponía una variable que no se usa y le faltaba la que sí.

⚠️ **El recinto exige user namespaces sin privilegios.** Es una propiedad del
sistema donde corre, no del proyecto, y no estaba escrita en ninguna parte.
Sin ella `bwrap` no arranca y **cinco pruebas de `npm test` fallan con mensajes
que parecen defectos del verificador**. Dentro de un contenedor hacen falta las
tres, medidas una por una (ninguna es `--privileged` ni `--cap-add`):

```bash
docker run --security-opt seccomp=unconfined \
           --security-opt apparmor=unconfined \
           --security-opt systempaths=unconfined ...
```

Cada una falla distinto y por eso se pueden separar: sin `seccomp` no se crea el
namespace; sin `apparmor` se crea y no se puede montar; sin `systempaths` falla al
montar `/proc`.

```bash
# 1. instalar el sistema en el proyecto (crea su .opencode/)
#    --alcance y --comandos NO son opcionales fuera de un proyecto Node con src/:
#    donde vive el código y cómo se corren las pruebas son propiedades del
#    PROYECTO, no del rol del agente. Sin ellos el gate niega toda escritura.
node runtimes/opencode/sync.mjs --en /ruta/a/tu-proyecto \
  --alcance "server/**" --comandos "venv/bin/python -m pytest server/ -q"

# 2. RECON entiende y BUILD implementa — desde un issue, o desde una frase
node core/flow/recon-build.mjs --target /ruta/a/tu-proyecto --issue 12
node core/flow/recon-build.mjs --target /ruta/a/tu-proyecto \
  --task "lo que hay que hacer, en una frase"

# 3. el verificador mide y REVIEW juzga
node core/flow/review.mjs --run runs/<fecha>

# 4. si REVIEW rechaza, el trabajo vuelve a BUILD
node core/flow/rework.mjs --run runs/<fecha>
node core/flow/review.mjs --run runs/<fecha>/vuelta-2

# 5. si todo salió en verde, se publica. Sin --confirmar solo dice qué haría.
node core/flow/publicar.mjs --run runs/<fecha>
node core/flow/publicar.mjs --run runs/<fecha> --confirmar
```

El paso 5 se niega a publicar si no hay dictamen, si el dictamen quedó
descartado, si el verificador midió RECHAZADO, o si **el árbol ya no es el que se
verificó** — se sella el contenido de cada archivo tocado al medir y se vuelve a
comprobar al publicar. Entre medir y publicar pasa tiempo, y un PR con el sello
de una verificación hecha sobre otro contenido es peor que un PR sin sello.

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
npm test                  # 271 tests, ~1 s, CERO llamadas al proveedor
npm run gate:contencion   # el recinto: 13 ataques deterministas, cuesta cero
npm run relevo            # regenera runtimes/opencode/eleccion.json (gitignored)
npm run sync               # materializa lab/.opencode/ (gitignored)
npm run sync:check        # ¿lo instalado coincide con lo que sync acaba de escribir?
```

Estos cinco se pueden correr siempre. Los que llaman al modelo —
`core/verification/wiring.mjs` y `core/verification/boundary.mjs` — cuestan
corridas reales y por eso no son parte de `npm test`: una suite que gasta cuota
del proveedor se deja de correr, y una suite que no se corre no protege nada.

⚠️ `gate:contencion` mide la red. Correrlo dentro de un sandbox que bloquee la
salida a internet convierte un ataque contenido en un "no discrimina" que no es
verdad.

⚠️ **`sync:check` en un árbol recién clonado sale "desincronizado" sin que nada
esté roto**, por dos razones que son la misma: los `.opencode/` que compara son
gitignored a propósito (`eleccion.json` caduca con la cuota del día;
`plugins/policy-gate.ts` lleva una ruta absoluta que pertenece a la máquina
donde se instaló, ver más abajo). Sin haber corrido `relevo` y `sync` primero
no hay contra qué comparar. El orden que de verdad hace falta es
`relevo` → `sync` → `sync:check`, y así lo corre `.github/workflows/ci.yml`.

⚠️ **El recinto (`bwrap`) necesita el intérprete montado, y en máquinas con
`node` fuera de `/usr`** (nvm, asdf, volta, los runners de GitHub Actions,
que lo instalan en `/opt/hostedtoolcache/`) hay que tener bubblewrap instalado
y, en Ubuntu 24.04+, permitir user namespaces sin privilegios:
`sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`. El propio
`correrSuiteAislada` monta el intérprete de solo lectura desde donde de verdad
esté (`process.execPath`), así que lo único que falta ponerlo es el sysctl.

---

## Estado

| Fase | Qué prueba | Estado |
|---|---|---|
| 0 · Fundación | saber qué hay | **cerrada** |
| 1 · Un agente encerrado | que la frontera sea real | **cerrada** |
| 2 · Frontera de escritura | que BUILD no se salga | **cerrada** |
| 3 · Verificación | que el sistema no crea | **cerrada** |
| 4 · Ciclo de tres | RECON → BUILD → REVIEW | **cerrada** |
| 5 · Orquestación | que ATLAS decida, no que el modelo elija la ruta | **cerrada** |
| 6 · Portabilidad | que sobreviva fuera de OpenCode | **cerrada** |

**Las siete fases del plan original están cerradas** (2026-08-26). El issue
`Najo24-code/yunque#1` entró solo y salió como PR (`yunque#2`), con una vuelta
de rechazo que pidió un defecto real, no una simulada. Lo que sigue no está
escrito todavía: el propio `docs/ROADMAP.md` dice que la escala se mide en
*cuántas tareas puede ejecutar a la vez sin que nadie las vigile*, y eso no es
ninguna de las siete.

Detalle en [`docs/ROADMAP.md`](docs/ROADMAP.md); un informe por fase en
[`docs/audits/`](docs/audits/).

Una fase no se cierra sin su informe, y si el gate falla la fase sigue abierta:
no se avanza "mientras tanto" a la siguiente.
