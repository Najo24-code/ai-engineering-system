/**
 * Pruebas del clasificador de fallos.
 *
 * Este clasificador decide algo que nada más decide: si una corrida **llegó al
 * modelo**. De ahí salen las dos formas de mentir que tiene, y son opuestas:
 *
 *   - Decir que corrió cuando no corrió → un falso verde. Una frontera que
 *     "aguantó" porque el agente nunca llegó a intentar nada.
 *   - Decir que no corrió cuando sí corrió → un falso rojo. Se tira trabajo
 *     terminado, y encima como TERMINAL, que aborta sin reintentar.
 *
 * La segunda se comió un dictamen completo de REVIEW el 2026-08-26. Por eso
 * ahora manda la evidencia positiva: un informe cerrado es prueba de que hubo
 * corrida, y gana a cualquier frase que aparezca dentro.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { clasificarFallo, informeCompleto, FALLO, parsearEventos, delegacionesDe, textoDelPrimario } from "./runner.mjs"

const informe = (cuerpo) =>
  `# PROBE RESULT\n\n## Intento\nlo que se pidió\n\n## Respuesta del agente\n${cuerpo}\n\n## Errores observados\nNinguno.\n\n## Resultado\nEL AGENTE DIJO QUE LO HIZO\n`

// ── el caso que se comió un dictamen ───────────────────────────────────────

test("una cita de líneas acabada en 401 no es una credencial rechazada", () => {
  // El caso real: REVIEW citó `detectores.py:394-401` en su tabla de evidencia
  // y el flujo tiró el dictamen entero.
  const salida = informe("| Consulta SQL filtra por ventana | `detectores.py:394-401` | DIRECT |")
  assert.equal(clasificarFallo(salida), null)
})

test("un informe completo gana a cualquier frase que lleve dentro", () => {
  // Un revisor que dictamina sobre código de autenticación va a escribir estas
  // palabras. Escribirlas no es que el proveedor lo haya rechazado a él.
  for (const frase of [
    "El endpoint devuelve 401 unauthorized cuando falta el token.",
    "Falta rate limit en /ingest: cualquiera puede saturarlo.",
    "El disco no tiene quota configurada.",
    "El mensaje 'invalid api key' se registra en texto plano.",
  ]) {
    assert.equal(clasificarFallo(informe(frase)), null, `lo tiró por: ${frase}`)
  }
})

test("un informe que dice que NO pudo también es una corrida que ocurrió", () => {
  const salida = informe("bloqueado por la política").replace("LO HIZO", "NO PUDO")
  assert.equal(clasificarFallo(salida), null)
})

// ── el control positivo: sin informe, las frases sí valen ──────────────────

test("sin informe completo, la cuota agotada sigue siendo terminal", () => {
  const f = clasificarFallo('{"error":"free-models-per-day limit reached"}')
  assert.equal(f.clase, FALLO.TERMINAL)
  assert.match(f.motivo, /no queda cuota/)
})

test("sin informe completo, la credencial rechazada sigue siendo terminal", () => {
  for (const salida of [
    '{"error":{"message":"Invalid API key"}}',
    "401 Unauthorized",
    '{"statusCode": 401}',
    "HTTP/1.1 401",
  ]) {
    const f = clasificarFallo(salida)
    assert.equal(f?.clase, FALLO.TERMINAL, `no lo cazó: ${salida}`)
    assert.match(f.motivo, /credencial/)
  }
})

test("un número suelto con forma de cita no dispara ni en una corrida a medias", () => {
  // Una corrida cortada a la mitad puede llevar prosa del agente sin llegar a
  // cerrar el informe. Un rango de líneas no puede ser un estado HTTP.
  assert.equal(clasificarFallo("revisé `app.py:394-401` y `detectores.py:401`"), null)
})

test("la credencial ausente no es lo mismo que la rechazada, y sigue siendo terminal", () => {
  const f = clasificarFallo("Error: API key is missing")
  assert.equal(f.clase, FALLO.TERMINAL)
  assert.match(f.motivo, /falta la credencial/)
})

test("un error del runtime sin clasificar no pasa por bueno", () => {
  // La regla del proyecto: lo que no se puede medir NO pasa. Antes esto
  // devolvía null y la corrida seguía adelante con un diff vacío.
  const f = clasificarFallo("Error: something exploded")
  assert.equal(f.clase, FALLO.TRANSITORIO)
})

test("una salida vacía es una corrida que no ocurrió", () => {
  assert.equal(clasificarFallo("").clase, FALLO.TRANSITORIO)
})

// ── qué cuenta como informe completo ───────────────────────────────────────

test("informeCompleto exige el cierre del contrato, no solo texto largo", () => {
  assert.equal(informeCompleto(informe("x")), true)
  assert.equal(informeCompleto("## Respuesta del agente\nmucho texto pero sin cerrar"), false)
  assert.equal(informeCompleto("## Resultado\n(sin veredicto)"), false)
  assert.equal(informeCompleto("EL AGENTE DIJO QUE LO HIZO"), false, "sin la sección no basta la frase")
})

// ── el agente que corrió no es el que se pidió ─────────────────────────────

test("un subagente pedido por --agent no corre: el runtime cambia al de por defecto", () => {
  // Medido el 2026-08-26 contra opencode. No es un error: es un aviso, un cambio
  // de agente y de modelo, y código de salida 0.
  const salida = '! agent "recon" is a subagent, not a primary agent. Falling back to default agent\n> plan · qwen3.7-max\n'
  const f = clasificarFallo(salida)
  assert.equal(f.clase, FALLO.TERMINAL)
  assert.match(f.motivo, /NO corrió "recon"/)
})

test("la sustitución gana incluso a un informe que parece completo", () => {
  // El caso peligroso: el agente equivocado produce algo con buena pinta. Ningún
  // contenido puede desmentir un hecho sobre QUÉ corrió.
  const salida =
    '! agent "build" is a subagent, not a primary agent. Falling back to default agent\n' +
    "# PROBE RESULT\n\n## Respuesta del agente\ntodo bien\n\n## Resultado\nEL AGENTE DIJO QUE LO HIZO\n"
  const f = clasificarFallo(salida)
  assert.equal(f.clase, FALLO.TERMINAL)
  assert.match(f.motivo, /NO corrió "build"/)
})

test("reintentar una sustitución sería repetir lo imposible: es TERMINAL", () => {
  const f = clasificarFallo("falling back to default agent")
  assert.equal(f.clase, FALLO.TERMINAL)
})

test("un informe normal no se confunde con una sustitución", () => {
  const salida = "# PROBE RESULT\n\n## Respuesta del agente\nusé el subagente recon\n\n## Resultado\nEL AGENTE DIJO QUE LO HIZO\n"
  assert.equal(clasificarFallo(salida), null)
})

// ── los eventos: de dónde sale la respuesta del subagente ──────────────────

/**
 * Formas capturadas de una corrida real el 2026-08-26 (`opencode run --format
 * json`), no copiadas de ninguna documentación. Es la regla del proyecto: el
 * formato de un tercero se mide corriéndolo.
 */
const eventoTexto = (texto) =>
  JSON.stringify({ type: "text", timestamp: 1, sessionID: "ses_x", part: { id: "p1", type: "text", text: texto } })

const eventoTarea = (subagente, salida, status = "completed") =>
  JSON.stringify({
    type: "tool_use",
    timestamp: 1,
    sessionID: "ses_x",
    part: {
      type: "tool",
      tool: "task",
      callID: "call-1",
      state: { status, input: { subagent_type: subagente, prompt: "…" }, output: salida },
    },
  })

const REPORTE = "# RECON REPORT\n\n## 1. Repository Identity\n…\n\n## 10. Evidence Ledger\n| x | y |"
const ENVUELTO = `<task id="ses_y" state="completed">\n<task_result>\n${REPORTE}\n</task_result>\n</task>`

test("las líneas que no son eventos no se pierden al parsear", () => {
  // Los avisos del runtime salen por stderr en texto plano. Tirarlas dejaría al
  // clasificador ciego justo donde más ve.
  const { eventos, sueltas } = parsearEventos(`! aviso del runtime\n${eventoTexto("hola")}\nno soy json`)
  assert.equal(eventos.length, 1)
  assert.deepEqual(sueltas, ["! aviso del runtime", "no soy json"])
})

test("algo que empieza por { y no es JSON va con las sueltas, no se tira", () => {
  const { eventos, sueltas } = parsearEventos('{esto no cierra')
  assert.equal(eventos.length, 0)
  assert.deepEqual(sueltas, ["{esto no cierra"])
})

test("la respuesta del subagente sale del tool task, desenvuelta", () => {
  const { eventos } = parsearEventos(eventoTarea("recon", ENVUELTO))
  const d = delegacionesDe(eventos)
  assert.equal(d.length, 1)
  assert.equal(d[0].subagente, "recon")
  assert.equal(d[0].salida, REPORTE)
})

test("una tarea sin terminar no cuenta: media respuesta no es media", () => {
  // Devolverla dejaría a BUILD trabajando sobre un mapa cortado por la mitad.
  const { eventos } = parsearEventos(eventoTarea("recon", ENVUELTO, "running"))
  assert.deepEqual(delegacionesDe(eventos), [])
})

test("una salida sin envoltorio se devuelve tal cual", () => {
  const { eventos } = parsearEventos(eventoTarea("build", "hice lo pedido"))
  assert.equal(delegacionesDe(eventos)[0].salida, "hice lo pedido")
})

test("el texto del primario sigue disponible, y es OTRA cosa que la delegada", () => {
  // El caso del 2026-08-26: el primario resumió. Las dos fuentes existen y no
  // dicen lo mismo; la que vale es la que escribe el runtime.
  const bruto = [eventoTarea("recon", ENVUELTO), eventoTexto("# PROBE RESULT\n\n## Respuesta del agente\n(resumido)")].join("\n")
  const { eventos } = parsearEventos(bruto)
  assert.match(textoDelPrimario(eventos), /\(resumido\)/)
  assert.equal(delegacionesDe(eventos)[0].salida, REPORTE)
})

test("sin eventos de texto, el primario es cadena vacía y no revienta", () => {
  assert.equal(textoDelPrimario([]), "")
  assert.equal(textoDelPrimario(undefined), "")
})
