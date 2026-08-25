/**
 * Las pruebas del lector de resultados.
 *
 * Todas las salidas de este archivo están **capturadas de corridas reales** en
 * esta máquina el 2026-08-25 —yunque con pytest, rafa-gym con vitest, jest sobre
 * un proyecto de prueba— en verde y en rojo. Ninguna viene de un README: un
 * formato copiado de la documentación es una suposición con buena letra, y este
 * repositorio existe precisamente para no dar por buenas las suposiciones con
 * buena letra.
 *
 * La que manda es la de la ambigüedad. Las demás comprueban que el lector
 * entiende; esa comprueba que **se calla cuando no está seguro**, que es la
 * única propiedad que impide que un número inventado salga con cara de medido.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { leerResultado } from "./resultados.mjs"

// ── salidas reales ───────────────────────────────────────────────────────────

const PYTEST_VERDE = `
.............................................                            [100%]
45 passed in 0.77s
`

const PYTEST_ROJO = `
FAILED test_x.py::test_c - assert 1 == 2
FAILED test_x.py::test_d - assert 1 == 2
2 failed, 2 passed in 0.02s
`

const VITEST_VERDE = `
 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  11:36:15
   Duration  186ms (transform 24ms, setup 0ms, import 38ms, tests 5ms, environment 0ms)
`

const VITEST_ROJO = `
 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
   Start at  11:36:07
   Duration  222ms (transform 41ms, setup 0ms, import 67ms, tests 19ms, environment 0ms)
`

const JEST_VERDE = `
Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        0.352 s, estimated 1 s
Ran all test suites.
`

const JEST_ROJO = `
Test Suites: 1 failed, 1 total
Tests:       1 failed, 2 passed, 3 total
Snapshots:   0 total
Time:        0.231 s
Ran all test suites.
`

const TAP_VERDE = `
1..66
# tests 66
# suites 0
# pass 66
# fail 0
# duration_ms 2315.45933
`

// ── el caso que motivó todo esto ─────────────────────────────────────────────

test("las 45 pruebas de yunque se leen, no se rechazan por no entenderlas", () => {
  // Antes de este archivo, esta salida devolvía null y el verificador la
  // traducía en RECHAZADO. Un rechazo indistinguible de uno legítimo.
  const r = leerResultado(PYTEST_VERDE)
  assert.deepEqual({ pasaron: r.pasaron, fallaron: r.fallaron }, { pasaron: 45, fallaron: 0 })
  assert.equal(r.formato, "pytest")
})

// ── cada corredor, en verde y en rojo ────────────────────────────────────────

for (const [nombre, salida, esperado, formato] of [
  ["pytest en rojo", PYTEST_ROJO, { pasaron: 2, fallaron: 2 }, "pytest"],
  ["vitest en verde", VITEST_VERDE, { pasaron: 3, fallaron: 0 }, "vitest"],
  ["vitest en rojo", VITEST_ROJO, { pasaron: 2, fallaron: 1 }, "vitest"],
  ["jest en verde", JEST_VERDE, { pasaron: 3, fallaron: 0 }, "jest"],
  ["jest en rojo", JEST_ROJO, { pasaron: 2, fallaron: 1 }, "jest"],
  ["node --test (TAP)", TAP_VERDE, { pasaron: 66, fallaron: 0 }, "tap"],
]) {
  test(nombre, () => {
    const r = leerResultado(salida)
    assert.ok(r, `no reconoció la salida de ${formato}`)
    assert.deepEqual({ pasaron: r.pasaron, fallaron: r.fallaron }, esperado)
    assert.equal(r.formato, formato)
  })
}

// ── que no se confundan entre ellos ──────────────────────────────────────────

test("la línea 'Test Files' de vitest no se lee como si fuera el total de pruebas", () => {
  // Dice 1 fichero, no 1 prueba. Confundirlas daría un total plausible y falso.
  assert.equal(leerResultado(VITEST_ROJO).pasaron, 2)
})

test("la línea 'Time: 0.352 s' de jest no se lee como el resumen de pytest", () => {
  assert.equal(leerResultado(JEST_VERDE).formato, "jest")
})

// ── la regla dura, intacta ───────────────────────────────────────────────────

test("una salida que nadie entiende sigue siendo no medible", () => {
  assert.equal(leerResultado("ok, todo bien, 214 tests pasaron"), null)
})

test("una salida vacía es no medible", () => {
  assert.equal(leerResultado(""), null)
})

test("un corredor que revienta al importar no sale con cero fallos", () => {
  // Cero pruebas ejecutadas y cero fallos sería el falso verde más barato de
  // fabricar: basta con romper el import.
  const r = leerResultado("ERROR test_x.py\n1 error in 0.05s\n")
  assert.equal(r.fallaron, 1)
})

test("si dos lectores no se ponen de acuerdo, el resultado es no medible", () => {
  // Elegir uno "por orden de la lista" sería adivinar, y el número adivinado
  // saldría con la misma cara de dato medido que uno real.
  const mezcla = `${JEST_VERDE}\n# pass 99\n# fail 0\n`
  assert.equal(leerResultado(mezcla), null)
})

test("dos lectores que coinciden no son ambigüedad", () => {
  const mezcla = `${JEST_VERDE}\n# pass 3\n# fail 0\n`
  assert.equal(leerResultado(mezcla).pasaron, 3)
})

test("los colores del terminal no rompen la lectura", () => {
  const conColor = "[32m45 passed[0m in 0.77s\n"
  assert.equal(leerResultado(conColor).pasaron, 45)
})
