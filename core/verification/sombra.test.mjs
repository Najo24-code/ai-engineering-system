/**
 * Pruebas del control de sombra.
 *
 * El caso que lo trajo está reproducido literal: es el que pasó los cinco
 * controles y la revisión de REVIEW el 2026-08-26, y solo lo delató una resta
 * hecha a mano. Los controles positivos son la mitad importante: este control
 * mira nombres repetidos, y los nombres se repiten legítimamente en sitios donde
 * no se pisan nada.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { definicionesDeTest, definicionesAñadidas, testsSombreados, explicarSombras } from "./sombra.mjs"

/** El separador de la clave: ámbito + NUL + nombre. Se construye, no se escribe. */
const SEP = String.fromCharCode(0)

const diffQueAñade = (ruta, ...lineas) =>
  [`diff --git a/${ruta} b/${ruta}`, `--- a/${ruta}`, `+++ b/${ruta}`, "@@ -1,1 +1,9 @@", ...lineas.map((l) => `+${l}`)].join("\n")

// ── el caso real ───────────────────────────────────────────────────────────

test("el nombre repetido que mató un test en yunque sale RECHAZADO", () => {
  const ruta = "server/test_detectores.py"
  const contenido = [
    "def test_muestras_viejas_quedan_fuera_de_la_ventana(conn):",
    "    # el original: cubria restart_storm",
    "    assert detectar_restart_storm(conn, 1, AHORA) == []",
    "",
    "def test_otra_cosa(conn):",
    "    pass",
    "",
    "def test_muestras_viejas_quedan_fuera_de_la_ventana(conn):",
    "    # el nuevo: cubre clock_skew. Python se queda con este.",
    "    assert detectar_clock_skew(conn, 1, AHORA) == []",
  ].join("\n")

  const sombras = testsSombreados({
    diff: diffQueAñade(ruta, "def test_muestras_viejas_quedan_fuera_de_la_ventana(conn):", "    assert detectar_clock_skew(conn, 1, AHORA) == []"),
    contenidos: { [ruta]: contenido },
  })

  assert.equal(sombras.length, 1)
  assert.equal(sombras[0].nombre, "test_muestras_viejas_quedan_fuera_de_la_ventana")
  assert.deepEqual(sombras[0].lineas, [1, 8])
  assert.match(explicarSombras(sombras), /solo corre la última/)
})

// ── los controles positivos: cuándo NO es una sombra ───────────────────────

test("un test nuevo con nombre propio no es sombra", () => {
  const ruta = "server/test_x.py"
  const contenido = "def test_uno():\n    pass\n\ndef test_dos():\n    pass\n"
  assert.deepEqual(testsSombreados({ diff: diffQueAñade(ruta, "def test_dos():"), contenidos: { [ruta]: contenido } }), [])
})

test("una colisión que YA estaba y que este cambio no tocó no se le cuelga a este cambio", () => {
  // Es un defecto de verdad, pero no es suyo. Rechazar por deuda vieja es cómo
  // se enseña a la gente a ignorar un control.
  const ruta = "server/test_x.py"
  const contenido = "def test_viejo():\n    pass\n\ndef test_viejo():\n    pass\n\ndef test_nuevo():\n    pass\n"
  assert.deepEqual(testsSombreados({ diff: diffQueAñade(ruta, "def test_nuevo():"), contenidos: { [ruta]: contenido } }), [])
})

test("dos métodos con el mismo nombre en clases distintas no se pisan", () => {
  // Sangría distinta de la de módulo: son espacios de nombres distintos, y
  // avisar aquí sería el rojo falso más fácil de producir en una suite por clases.
  const ruta = "tests/test_api.py"
  const contenido = [
    "class TestUno:",
    "    def test_caso_borde(self):",
    "        pass",
    "",
    "class TestDos:",
    "    def test_caso_borde(self):",
    "        pass",
  ].join("\n")
  const diff = diffQueAñade(ruta, "class TestDos:", "    def test_caso_borde(self):", "        pass")
  assert.deepEqual(testsSombreados({ diff, contenidos: { [ruta]: contenido } }), [])
})

test("dos test() con el mismo nombre en JS NO son sombra: los dos corren", () => {
  // La diferencia que hace que este control tenga sentido. `def` es un enlace en
  // un espacio de nombres; `test("x", ...)` es una llamada. Tratarlos igual
  // rechazaría suites de node:test y vitest que funcionan perfectamente.
  const ruta = "src/cosa.test.mjs"
  const contenido = 'test("hace lo suyo", () => {})\ntest("hace lo suyo", () => {})\n'
  assert.deepEqual(testsSombreados({ diff: diffQueAñade(ruta, 'test("hace lo suyo", () => {})'), contenidos: { [ruta]: contenido } }), [])
})

test("un archivo que no es de test no se mira", () => {
  const ruta = "server/detectores.py"
  const contenido = "def test_helper():\n    pass\n\ndef test_helper():\n    pass\n"
  assert.deepEqual(testsSombreados({ diff: diffQueAñade(ruta, "def test_helper():"), contenidos: { [ruta]: contenido } }), [])
})

test("un archivo que el diff nombra y no se puede leer no se da por malo", () => {
  const ruta = "tests/test_x.py"
  assert.deepEqual(testsSombreados({ diff: diffQueAñade(ruta, "def test_uno():"), contenidos: {} }), [])
})

// ── Go, donde el mismo mecanismo aplica ────────────────────────────────────

test("en Go dos func TestX también se pisan", () => {
  const ruta = "internal/cosa_test.go"
  const contenido = "func TestSuma(t *testing.T) {}\n\nfunc TestSuma(t *testing.T) {}\n"
  assert.equal(testsSombreados({ diff: diffQueAñade(ruta, "func TestSuma(t *testing.T) {}"), contenidos: { [ruta]: contenido } }).length, 1)
})

// ── las piezas por separado ────────────────────────────────────────────────

test("definicionesDeTest separa por ámbito, no por sangría", () => {
  // La clave es "ámbito\\0nombre"; el ámbito de módulo es la cadena vacía.
  const enModulo = (nombre) => `${""}${SEP}${nombre}`

  const d = definicionesDeTest("def test_a():\n    pass\ndef test_a():\n    pass\ndef test_b():\n")
  assert.deepEqual(d.get(enModulo("test_a")), [1, 3])
  assert.deepEqual(d.get(enModulo("test_b")), [5])

  const conClases = definicionesDeTest(
    ["class Uno:", "    def test_x(self):", "        pass", "class Dos:", "    def test_x(self):", "        pass"].join("\n"),
  )
  assert.deepEqual(conClases.get(`Uno${SEP}test_x`), [2])
  assert.deepEqual(conClases.get(`Dos${SEP}test_x`), [5])
})

test("definicionesAñadidas guarda el nombre pelado, y solo de archivos de test", () => {
  // Sin ámbito a propósito: un hunk no enseña la clase que lo contiene, así que
  // deducirlo desde el diff sería adivinar. El ámbito lo pone el archivo final.
  const diff = [
    "+++ b/tests/test_x.py",
    "+def test_nuevo():",
    "-def test_borrado():",
    " def test_contexto():",
    "+++ b/src/cosa.py",
    "+def test_no_es_de_test():",
  ].join("\n")
  const m = definicionesAñadidas(diff)
  assert.deepEqual([...(m.get("tests/test_x.py") ?? [])], ["test_nuevo"])
  assert.equal(m.has("src/cosa.py"), false)
})
