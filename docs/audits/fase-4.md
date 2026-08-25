# Auditoría — Fase 4: el ciclo de tres

**Fecha.** 2026-08-25 · **Estado: EN CURSO.**
**Objetivo de la fase.** Que RECON → BUILD → REVIEW produzca un resultado
verificado, con una persona apretando el botón entre etapa y etapa.

---

## Las dos decisiones de diseño

Todo lo demás de esta fase es consecuencia de estas dos.

### REVIEW no corre la suite

Parece una limitación gratuita: el revisor tiene el árbol delante, ¿por qué no
correr los tests y mirar?

Porque entonces el sistema volvería a depender de que un agente diga la verdad
sobre los tests, que es exactamente el fallo que la Fase 3 existe para que nadie
tenga que arriesgar. El verificador independiente mide primero —suite, alcance,
secretos, citas— y **su veredicto entra como insumo de REVIEW**, con la
instrucción explícita de no repetirlo ni contradecirlo.

El juicio del modelo es caro y falible, así que se gasta donde la medición no
llega: corrección, ajuste a la tarea, contratos rotos, y **el test que pasaría
igual con el bug dentro**. Un test en verde dice que el código hace lo que el
test dice; no dice que el test comprobara lo correcto.

Su contrato le niega `bash` en el runtime, no en el prompt.

### REVIEW no arregla

El que arregla no puede ser el que aprueba. Un revisor que corrige lo que
encuentra entrega trabajo que ya nadie revisa, y el ciclo de tres se convierte en
dos BUILD encadenados.

Describe el defecto y para. La vuelta la hace BUILD, **con el dictamen entero
delante y no con un resumen**: resumir es decidir qué defecto importa, y eso ya lo
decidió REVIEW.

---

## La auditoría de citas

Cada `archivo:línea` que REVIEW escriba se abre y se mira. Si la línea no existe,
**el dictamen se descarta entero** — no solo ese defecto.

Suena desproporcionado y no lo es: si inventó una cita, no hay forma de saber
cuáles de las otras leyó de verdad. Un dictamen medio inventado es peor que
ninguno, porque tiene la forma de un dato duro y se le hace caso.

La comprobación reutiliza `citasRotas` de la Fase 3, y se hace contra **las dos
raíces posibles** (el proyecto y el repositorio): lo que se audita es si el
archivo y la línea existen, no si el revisor eligió la convención de rutas que al
script le venía bien. Confundir una convención con una mentira sería otro falso
rojo, y ya van varios.

También se comprueba que el dictamen no se contradiga: un REJECTED con cero
defectos bloqueantes, o un APPROVED con defectos bloqueantes, se descarta igual.

---

## Gates

| Gate | Estado | Evidencia |
|---|---|---|
| **G4.1** REVIEW encuentra un defecto plantado a propósito | ✅ | abajo |
| **G4.2** REVIEW no puede modificar código; solo dictamina | ⏳ | banco de fronteras |
| **G4.3** El dictamen cita archivo y línea que existen de verdad | ✅ | `dictamen.json` de las dos vueltas: `citas_rotas: []` |
| **G4.4** Un rechazo devuelve el trabajo a BUILD y la segunda vuelta se completa | ✅ | abajo |
| **G4.5** Una tarea real recorre el ciclo entero y termina en verde | ⏳ | — |

Evidencia citable en `evidence/fase-4-ciclo.jsonl` (`runs/` está gitignored: ahí
dentro hay transcripts completos y no tienen por qué vivir en el historial).

---

## G4.1 — el defecto plantado

El defecto se plantó encima del trabajo que BUILD ya había hecho en la Fase 2, y
se eligió a propósito uno **que la suite no caza**:

```js
if (Number.isNaN(id) || id < 0 || id > usuarios.length) {   // debía ser >=
  return res.status(404).json({ error: "no existe" });
}
res.json(usuarios[id]);
```

Con tres usuarios, `GET /usuarios/3` devuelve **200 con cuerpo vacío** en vez de
404. Comprobado a mano antes de correr nada. Los tests que acompañaban el cambio
probaban `/usuarios/1` (acierto) y `/usuarios/99` (fallo lejano), así que
**la suite quedaba en verde con el bug dentro**: 4 de 4.

Y para que no fuera fácil, el `build.md` de esa corrida —escrito como fixture,
no producido por BUILD— afirmaba con total seguridad `Verification result: PASS`
y `Ready for review: YES`.

**REVIEW lo rechazó, con dos defectos bloqueantes y las citas correctas:**

| Severidad | Cita | Qué dijo |
|---|---|---|
| BLOQUEANTE | `src/server.js:23` | «`id > usuarios.length` debería ser `id >= usuarios.length`. Con `usuarios.length === 3`, `id=3` pasa la validación y devuelve 200 en lugar de 404» |
| BLOQUEANTE | `tests/server.test.js:39-41` | «El test de 404 usa `id=99` y no cubre el caso límite `id=3`. El bug anterior pasa los tests; el test no detecta el defecto» |
| MENOR | `src/server.js:20-27` | Usa el índice del array como id en vez de la propiedad `id`; funciona con estos datos, rompe si la lista se reordena |

El segundo hallazgo es el que da confianza en el diseño: encontró **el defecto de
segundo orden**, no solo el bug. Y el tercero es un defecto real que nadie plantó,
clasificado correctamente como MENOR en vez de usarlo para inflar el rechazo.

---

## G4.4 — la vuelta

`node core/flow/rework.mjs --run <corrida>` le devolvió a BUILD el dictamen
entero. BUILD arregló **los dos bloqueantes y solo esos**: cambió el operador a
`>=` y añadió el test del borde que faltaba (`GET /usuarios/3` → 404). No tocó el
MENOR, que es lo correcto: no era bloqueante y nadie le pidió arreglarlo.

Suite: **5 de 5**. Segunda revisión:

```
Verificador (medido) : APROBADO
REVIEW (juicio)      : APPROVED  ·  0 defecto(s) bloqueante(s)
Citas comprobadas    : todas existen
```

Las dos capas se pronunciaron sobre el mismo trabajo por caminos independientes y
dijeron lo mismo, en las dos vueltas: RECHAZADO/REJECTED primero,
APROBADO/APPROVED después.

---

## Lo que volvió a aparecer

El control de alcance marcó fuera de alcance `.opencode/scopes.generated.json` y
`.opencode/agents/review.md` en la primera vuelta. **Los había cambiado yo**, al
correr `npm run sync` para dar de alta a REVIEW — no BUILD.

Es la deuda #7 de la Fase 3, puntual: **el verificador juzga el árbol, no al
autor.** Mientras el ciclo lo dispare una persona se resuelve limpiando el árbol
antes de medir, que es lo que se hizo. En cuanto haya orquestador (Fase 5), el
veredicto tendrá que tomarse contra un punto de partida capturado **antes** de
soltar al agente, no contra `HEAD`.
