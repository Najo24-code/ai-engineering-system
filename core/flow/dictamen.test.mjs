/**
 * Pruebas de las dos reglas que se le aplican al dictamen de REVIEW.
 *
 * Ninguna llama al proveedor: son texto de entrada y veredicto de salida. Ese es
 * el punto de haberlas sacado del archivo del flujo.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { leerDictamen, citasRotasEnAmbasRaices } from "./dictamen.mjs"

const cierre = (veredicto, bloqueantes) =>
  `\n---\nDefects found: 3\nBlocking defects: ${bloqueantes}\nVerdict: ${veredicto}\n`

test("lee el veredicto y los bloqueantes del cierre", () => {
  const d = leerDictamen(`## Defects\n...${cierre("REJECTED", 2)}`)
  assert.equal(d.veredicto, "REJECTED")
  assert.equal(d.bloqueantes, 2)
  assert.deepEqual(d.incoherencias, [])
})

test("gana la ÚLTIMA coincidencia, no la primera", () => {
  // El caso real: el modelo copia la plantilla arriba, o adelanta su conclusión,
  // y el cierre de verdad está al final.
  const d = leerDictamen(`Verdict: APPROVED | REJECTED\nBlocking defects: N\n${cierre("REJECTED", 2)}`)
  assert.equal(d.veredicto, "REJECTED")
  assert.equal(d.bloqueantes, 2)
})

test("rechazar sin un solo defecto bloqueante es una contradicción", () => {
  const d = leerDictamen(cierre("REJECTED", 0))
  assert.equal(d.incoherencias.length, 1)
  assert.match(d.incoherencias[0], /enseña a no leerlo/)
})

test("aprobar con defectos bloqueantes también lo es", () => {
  const d = leerDictamen(cierre("APPROVED", 3))
  assert.match(d.incoherencias.join(" "), /aprueba con 3/)
})

test("un dictamen sin cierre legible no pasa", () => {
  const d = leerDictamen("El cambio me parece bien, en general.")
  assert.equal(d.veredicto, null)
  assert.equal(d.incoherencias.length, 2) // ni veredicto ni bloqueantes
})

test("un veredicto que no es APPROVED ni REJECTED no pasa", () => {
  const d = leerDictamen("Blocking defects: 0\nVerdict: MAYBE\n")
  assert.match(d.incoherencias.join(" "), /veredicto desconocido: MAYBE/)
})

test("tolera negritas de markdown alrededor del campo", () => {
  const d = leerDictamen("**Blocking defects:** 1\n**Verdict:** REJECTED\n")
  assert.equal(d.veredicto, "REJECTED")
  assert.equal(d.bloqueantes, 1)
})

// ── las citas ───────────────────────────────────────────────────────────────

function arbol() {
  const raiz = mkdtempSync(join(tmpdir(), "dictamen-"))
  mkdirSync(join(raiz, "lab", "src"), { recursive: true })
  writeFileSync(join(raiz, "lab", "src", "server.js"), "a\nb\nc\n")
  return raiz
}

test("una cita que existe desde CUALQUIERA de las dos raíces es buena", () => {
  const raiz = arbol()
  const proyecto = join(raiz, "lab")
  try {
    // Escrita desde el proyecto...
    assert.deepEqual(citasRotasEnAmbasRaices(proyecto, raiz, "ver src/server.js:2"), [])
    // ...y escrita desde la raíz del repositorio. Las dos son la misma línea.
    assert.deepEqual(citasRotasEnAmbasRaices(proyecto, raiz, "ver lab/src/server.js:2"), [])
  } finally {
    rmSync(raiz, { recursive: true, force: true })
  }
})

test("una línea que no existe es una cita rota, se mire desde donde se mire", () => {
  const raiz = arbol()
  const proyecto = join(raiz, "lab")
  try {
    const rotas = citasRotasEnAmbasRaices(proyecto, raiz, "ver src/server.js:214")
    assert.equal(rotas.length, 1)
    assert.match(rotas[0].motivo, /3 líneas/)
  } finally {
    rmSync(raiz, { recursive: true, force: true })
  }
})

test("un archivo inventado es una cita rota", () => {
  const raiz = arbol()
  const proyecto = join(raiz, "lab")
  try {
    const rotas = citasRotasEnAmbasRaices(proyecto, raiz, "ver src/pagos.js:1")
    assert.equal(rotas.length, 1)
    assert.equal(rotas[0].motivo, "el archivo no existe")
  } finally {
    rmSync(raiz, { recursive: true, force: true })
  }
})
