# AI Engineering System

Sistema de ingeniería de software multiagente: agentes con responsabilidades
separadas, permisos que de verdad se aplican y resultados que se verifican en vez
de creerse.

De uso personal. Pensado para funcionar en cualquier entorno, no dentro de una
herramienta concreta.

## La idea en una frase

Un agente no se define por su prompt, sino por lo que **no** puede hacer y por lo
que otro mecanismo **comprueba** de su trabajo.

## Estructura

```
agents/       contratos de agente, portables      (fuente de verdad)
core/
  policies/   reglas de permiso cableadas a hooks
  verification/  el que comprueba y no cree
runtimes/
  opencode/   adaptador para OpenCode
lab/          banco de pruebas: el repo sobre el que trabajan los agentes
docs/
  ARCHITECTURE.md  las cinco capas y dónde bloquea cada nivel
  ROADMAP.md       las siete fases y el gate de cada una
  audits/          un informe por fase; sin él la fase no cierra
```

Regla de dependencia: `agents/` no importa nada de `runtimes/`. El día que el
runtime sea otro, se reescribe un adaptador, no los agentes.

## Estado

| Fase | Qué prueba | Estado |
|---|---|---|
| 0 · Fundación | saber qué hay | **cerrada** |
| 1 · Un agente encerrado | que la frontera sea real | **cerrada** |
| 2 · Frontera de escritura | que BUILD no se salga | siguiente |
| 3 · Verificación | que el sistema no crea | |
| 4 · Ciclo de tres | RECON → BUILD → REVIEW | |
| 5 · Orquestación | que ATLAS decida | |
| 6 · Portabilidad | que sobreviva fuera de OpenCode | |

Detalle en [`docs/ROADMAP.md`](docs/ROADMAP.md).
Lo heredado, auditado en [`docs/audits/fase-0.md`](docs/audits/fase-0.md).

## La regla que sostiene todo lo demás

Una política sin **prueba de cableado** se considera no implementada.

No basta con que la función decida bien en un test de unidad. Hay que demostrar,
con el sistema corriendo, que la acción prohibida **falla de verdad**.

Escribir la regla y conectar la regla son dos trabajos distintos, y solo el
segundo protege algo.
