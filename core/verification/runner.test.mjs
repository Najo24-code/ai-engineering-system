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

import { clasificarFallo, informeCompleto, FALLO } from "./runner.mjs"

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
