# Arquitectura

## Principio rector

Un agente no se define por su nombre ni por su prompt.

Se define por cinco cosas, y las cinco tienen que ser verificables desde fuera del agente:

| Elemento | Pregunta que responde | Dónde vive |
|---|---|---|
| Responsabilidad | ¿De qué es dueño? | Contrato (`agents/*.agent.md`) |
| Herramientas | ¿Qué puede tocar? | Frontmatter `permission:` |
| Política | ¿Qué se le niega aunque lo pida? | `core/policies/` |
| Contrato de salida | ¿Qué devuelve, exactamente? | Contrato, sección "Required report" |
| Criterio de éxito | ¿Cómo sé que no mintió? | `core/verification/` |

Si uno de los cinco solo existe en el prompt, no existe.

## Las cinco capas

```
┌──────────────────────────────────────────────┐
│ 5. INTERFAZ      CLI · IDE · GitHub · cron   │
├──────────────────────────────────────────────┤
│ 4. ORQUESTACIÓN  quién actúa y en qué orden  │
├──────────────────────────────────────────────┤
│ 3. AGENTES       contratos portables         │
├──────────────────────────────────────────────┤
│ 2. POLÍTICAS     permisos · límites · gates  │
├──────────────────────────────────────────────┤
│ 1. RUNTIME       modelos · ejecución · hooks │
└──────────────────────────────────────────────┘
```

La regla de dependencia es de arriba hacia abajo y nunca al revés:

- La capa 3 (agentes) **no puede** importar nada de la capa 1 (runtime).
- Un contrato de agente es un documento, no un archivo de configuración de OpenCode.
- OpenCode es **un adaptador**, no el sistema. Vive en `runtimes/opencode/`.

Esto es lo que hace que el sistema sea portable. El día que el runtime sea otro,
lo que se reescribe es un adaptador, no los agentes.

## Dónde vive el enforcement de verdad

Esta sección es la más importante del documento, porque es donde casi todos los
sistemas de agentes son teatro.

Evidencia: `@opencode-ai/plugin@1.18.18`, `dist/index.d.ts`, interfaz `Hooks`.

Hay **tres** niveles de control, y solo dos bloquean:

### Nivel A — Declarativo (bloquea, lo aplica el runtime)

El bloque `permission:` del frontmatter del agente:

```yaml
permission:
  read: allow
  edit: deny
  bash: deny
  task: deny
```

Es la frontera más fuerte porque no depende de que el modelo obedezca.
El runtime simplemente no le entrega la herramienta.

**Primera regla del sistema: todo agente declara TODAS las herramientas,
incluidas las que niega.** Omitir una no es "por defecto denegado", es
"por defecto lo que decida el runtime", y eso cambia entre versiones.

### Nivel B — Programático (bloquea, lo aplica un plugin)

```ts
"permission.ask"?: (
  input: Permission,
  output: { status: "ask" | "deny" | "allow" }
) => Promise<void>
```

Este hook es el punto de decisión real: un plugin puede forzar `output.status = "deny"`.

Es donde deben vivir las reglas que el frontmatter no puede expresar, porque
dependen del *contenido* de la llamada y no solo del tipo de herramienta:
"puede usar `bash`, pero nunca `git push`", "puede editar, pero nunca `.env`".

### Nivel C — Observación (NO bloquea)

```ts
"tool.execute.before" / "tool.execute.after"
```

Sirven para auditar, medir y registrar evidencia. **No son una frontera de seguridad.**
Un auditor que observa no es un guardia que impide.

> Pendiente de verificación experimental (Fase 1): si lanzar una excepción dentro de
> `tool.execute.before` aborta la llamada. Los tipos no lo garantizan y no se
> documenta como contrato. Hasta comprobarlo, se asume que **no** bloquea.

### El error que hay que no repetir

La lógica de política puede estar perfectamente escrita y aun así no aplicarse nunca,
si no está enganchada a un hook que bloquee. Escribir la regla y cablear la regla son
dos trabajos distintos, y solo el segundo protege algo.

Por eso toda política de este sistema necesita **dos** pruebas:

1. Una prueba de unidad: la función decide bien.
2. Una prueba de cableado: con el sistema corriendo, la acción prohibida **falla de verdad**.

Una política sin prueba de cableado se considera no implementada.

## Contrato de agente

Todo agente de `agents/` define exactamente estos ocho campos:

```
1. PROPÓSITO        una frase; de qué es dueño
2. ENTRADAS         qué recibe y en qué formato
3. HERRAMIENTAS     lista explícita de allow
4. PROHIBICIONES    lista explícita de deny + por qué
5. ALCANCE          qué rutas puede leer y cuáles escribir
6. SALIDA           estructura exacta del reporte
7. ÉXITO            condiciones comprobables por un tercero
8. LÍMITES          cuándo debe detenerse y devolver el control
```

Un agente al que le falte cualquiera de los ocho no entra al catálogo.

## Verificación

El sistema nunca cree la palabra de un agente.

| Afirmación del agente | Lo que el sistema comprueba |
|---|---|
| "implementé la feature" | el diff existe y toca solo rutas permitidas |
| "los tests pasan" | el sistema corre los tests él mismo |
| "no rompí nada" | la suite completa, no la que el agente eligió |
| "revisé el código" | el reporte cita archivo y línea reales |
| "está listo" | todos los gates anteriores en verde |

La evidencia se guarda. Un resultado sin evidencia se trata como un fallo.
