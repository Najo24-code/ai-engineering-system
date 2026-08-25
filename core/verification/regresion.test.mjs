import { test } from "node:test"
import assert from "node:assert/strict"

import {
  esArchivoDeTest,
  testDeLinea,
  testsDelDiff,
  regresionDeSuite,
  testsRetiradosDeclarados,
} from "./regresion.mjs"

/** Arma un diff unificado sin tener que escribir encabezados a mano. */
const diff = (archivo, lineas) =>
  [`diff --git a/${archivo} b/${archivo}`, `--- a/${archivo}`, `+++ b/${archivo}`, "@@ -1,9 +1,9 @@", ...lineas].join("\n")

// ── qué archivo se mira ─────────────────────────────────────────────────────

test("archivos de test: los cuatro idiomas y sus carpetas", () => {
  for (const ruta of [
    "tests/calc.test.js",
    "test/calc.js",
    "src/__tests__/boton.tsx",
    "src/boton.spec.ts",
    "app/tests/test_usuarios.py",
    "server/usuarios_test.py",
  ]) {
    assert.equal(esArchivoDeTest(ruta), true, ruta)
  }
})

test("archivos de test: el código de producción no lo es", () => {
  for (const ruta of ["src/calc.js", "app/models/usuario.py", "README.md", "src/testing-utils.ts"]) {
    assert.equal(esArchivoDeTest(ruta), false, ruta)
  }
})

// ── qué línea declara un test ───────────────────────────────────────────────

test("declaraciones: node, vitest y jest", () => {
  assert.equal(testDeLinea(`test("suma dos positivos", () => {`).nombre, "suma dos positivos")
  assert.equal(testDeLinea(`  it('devuelve 404', async () => {`).nombre, "devuelve 404")
  assert.equal(testDeLinea("test.only(`caso raro`, () => {").nombre, "caso raro")
  assert.equal(testDeLinea(`test.each([1,2])("suma %i", (n) => {`).nombre, "suma %i")
})

test("declaraciones: pytest y unittest", () => {
  assert.equal(testDeLinea("def test_usuario_sin_nombre(self):").nombre, "test_usuario_sin_nombre")
  assert.equal(testDeLinea("    async def test_login_falla(client):").nombre, "test_login_falla")
})

test("una línea que no declara nada no inventa un nombre", () => {
  assert.equal(testDeLinea("const usuarios = []"), null)
  assert.equal(testDeLinea("// test de humo pendiente"), null)
})

test("`test.skip` silencia, no declara: el orden de la comprobación es lo que decide", () => {
  const s = testDeLinea(`test.skip("resta simple", () => {`)
  assert.equal(s.silencia, true)
  assert.equal(s.nombre, "resta simple")
  assert.equal(testDeLinea(`xit("resta a cero", () => {`).silencia, true)
  assert.equal(testDeLinea("@pytest.mark.xfail").silencia, true)
})

// ── el caso que abrió este archivo ──────────────────────────────────────────

test("el agente borra los tests que le salieron en rojo: sale sin declarar", () => {
  const d = diff("tests/calc.test.js", [
    ` test("suma dos positivos", () => assert.equal(suma(2, 3), 5))`,
    `-test("resta simple", () => assert.equal(resta(9, 4), 5))`,
    `-test("resta a cero", () => assert.equal(resta(4, 4), 0))`,
    `+test("divide simple", () => assert.equal(divide(10, 2), 5))`,
  ])
  const r = regresionDeSuite({ diff: d })
  assert.deepEqual(r.retirados.sort(), ["resta a cero", "resta simple"])
  assert.deepEqual(r.sinDeclarar.sort(), ["resta a cero", "resta simple"])
  assert.equal(r.limpio, false)
})

test("el mismo cambio, declarado en el informe, pasa", () => {
  const d = diff("tests/calc.test.js", [`-test("resta simple", () => {`, `-test("resta a cero", () => {`])
  const r = regresionDeSuite({ diff: d, declarados: ["resta simple", "resta a cero"] })
  assert.equal(r.limpio, true)
  assert.deepEqual(r.sinDeclarar, [])
})

test("declarar dos y retirar tres deja el tercero fuera: se comparan nombres, no cantidades", () => {
  const d = diff("tests/calc.test.js", [`-test("a", () => {`, `-test("b", () => {`, `-test("c", () => {`])
  const r = regresionDeSuite({ diff: d, declarados: ["a", "b"] })
  assert.deepEqual(r.sinDeclarar, ["c"])
  assert.equal(r.limpio, false)
})

// ── lo que NO puede rechazar, que es la mitad del trabajo ───────────────────

test("mover un test de archivo no es retirarlo", () => {
  const d = [
    diff("tests/viejo.test.js", [`-test("suma dos positivos", () => {`]),
    diff("tests/nuevo.test.js", [`+test("suma dos positivos", () => {`]),
  ].join("\n")
  assert.equal(regresionDeSuite({ diff: d }).limpio, true)
})

test("mover un test a un archivo nuevo sin `git add` tampoco", () => {
  const d = diff("tests/viejo.test.js", [`-test("suma dos positivos", () => {`])
  const r = regresionDeSuite({ diff: d, nuevos: ["suma dos positivos"] })
  assert.equal(r.limpio, true)
})

test("editar el cuerpo de un test sin tocar su nombre no lo retira", () => {
  const d = diff("tests/calc.test.js", [
    `-test("suma dos positivos", () => assert.equal(suma(2, 3), 5))`,
    `+test("suma dos positivos", () => {`,
    `+  assert.equal(suma(2, 3), 5)`,
    `+})`,
  ])
  assert.equal(regresionDeSuite({ diff: d }).limpio, true)
})

test("un cambio que no toca archivos de test no dice nada de la suite", () => {
  const d = diff("src/calc.js", [`-export const resta = (a, b) => a - b`, `+export const resta = (a, b) => a - b + 1`])
  const r = regresionDeSuite({ diff: d })
  assert.deepEqual(r.retirados, [])
  assert.equal(r.limpio, true)
})

// ── silenciar es retirar con otro nombre ────────────────────────────────────

test("poner `.skip` a un test que estaba corriendo cuenta como retirarlo", () => {
  const d = diff("tests/calc.test.js", [
    `-test("resta simple", () => assert.equal(resta(9, 4), 5))`,
    `+test.skip("resta simple", () => assert.equal(resta(9, 4), 5))`,
  ])
  const r = regresionDeSuite({ diff: d })
  assert.deepEqual(r.silenciados, ["resta simple"])
  assert.deepEqual(r.sinDeclarar, ["resta simple"])
  assert.equal(r.limpio, false)
})

test("un test que nace apagado también se declara", () => {
  const d = diff("tests/calc.test.js", [`+test.todo("divide por cero")`])
  assert.deepEqual(regresionDeSuite({ diff: d }).sinDeclarar, ["divide por cero"])
})

// ── bordes del formato del diff ─────────────────────────────────────────────

test("borrar el archivo de test entero se lee por el encabezado del origen", () => {
  const d = [
    "diff --git a/tests/calc.test.js b/tests/calc.test.js",
    "deleted file mode 100644",
    "--- a/tests/calc.test.js",
    "+++ /dev/null",
    "@@ -1,4 +0,0 @@",
    `-test("resta simple", () => {`,
    `-test("resta a cero", () => {`,
  ].join("\n")
  assert.deepEqual(regresionDeSuite({ diff: d }).sinDeclarar.sort(), ["resta a cero", "resta simple"])
})

test("los `---` y `+++` del encabezado no se leen como líneas del cambio", () => {
  const d = diff("tests/calc.test.js", [`+test("nuevo", () => {`])
  const r = regresionDeSuite({ diff: d })
  assert.deepEqual(r.retirados, [])
  assert.equal(r.limpio, true)
})

test("un diff vacío no rechaza nada", () => {
  const r = regresionDeSuite({ diff: "" })
  assert.equal(r.limpio, true)
  assert.deepEqual(r.retirados, [])
})

test("declarar la retirada de un test que sigue ahí se ve, pero no rechaza", () => {
  const d = diff("tests/calc.test.js", [` test("suma", () => {`])
  const r = regresionDeSuite({ diff: d, declarados: ["un test que nadie tocó"] })
  assert.deepEqual(r.declaradosDeMas, ["un test que nadie tocó"])
  assert.equal(r.limpio, true)
})

// ── leer la declaración del informe de BUILD ────────────────────────────────

const informe = (retirados) =>
  ["## Verification", "`node --test` — 8 pass", "", "## Retired Tests", retirados, "", "## Out of Scope", "nada"].join("\n")

test("la declaración se lee de la sección del informe, con los nombres entre acentos graves", () => {
  const texto = informe("`resta simple` — resta() ya no existe\n`resta a cero` — misma razón")
  assert.deepEqual(testsRetiradosDeclarados(texto), ["resta simple", "resta a cero"])
})

test('"nada" no declara ningún test', () => {
  assert.deepEqual(testsRetiradosDeclarados(informe("nada")), [])
})

test("sin sección de retirados, no hay declaración", () => {
  assert.deepEqual(testsRetiradosDeclarados("## Verification\ntodo verde\n\n## Blocked\nnada"), [])
})

test("la sección termina en la siguiente, no en el primer renglón", () => {
  // El fallo que esto vigila: anclar el final con `$` y la bandera `m`, que en
  // JavaScript significa "final de renglón" y se comía todo menos la primera línea.
  const texto = informe("`a` — x\n`b` — y\n`c` — z")
  assert.deepEqual(testsRetiradosDeclarados(texto), ["a", "b", "c"])
})

test("un acento grave de la sección siguiente no se cuela", () => {
  const texto = informe("`a` — x")
  assert.deepEqual(testsRetiradosDeclarados(texto), ["a"])
  assert.equal(testsRetiradosDeclarados(texto).includes("node --test"), false)
})

test("un informe vacío o nulo no revienta", () => {
  assert.deepEqual(testsRetiradosDeclarados(""), [])
  assert.deepEqual(testsRetiradosDeclarados(null), [])
})
