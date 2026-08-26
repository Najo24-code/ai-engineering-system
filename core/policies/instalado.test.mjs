/**
 * Pruebas del alcance efectivo.
 *
 * La que importa es la primera: el contrato dice `src/**` y la instalación dice
 * `server/**`. Antes de esto ganaba el contrato, y el verificador rechazaba
 * trabajo que el policy gate había autorizado, con el motivo «fuera del
 * alcance». Un rojo falso con un motivo creíble es el fallo más caro que puede
 * tener este sistema, porque no se descubre: se cree.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { elegirAlcance, comandoDePruebas } from "./instalado.mjs"

const contrato = { scope: { write: ["src/**", "tests/**"], shell: ["npm test", "git status"] } }

const instalacion = (write, shell = [], runtime = "opencode") => ({
  [runtime]: {
    ruta: runtime === "opencode" ? ".opencode/scopes.generated.json" : ".claude/hooks/scopes.generated.json",
    datos: { agents: { build: { write, shell } } },
  },
})

test("manda lo que se aplicó, no lo que declara el contrato", () => {
  const r = elegirAlcance({
    instalaciones: instalacion(["server/**"], ["venv/bin/python -m pytest server/ -q"]),
    contrato,
  })
  assert.deepEqual(r.write, ["server/**"])
  assert.match(r.fuente, /instalación de opencode/)
  assert.deepEqual(r.avisos, [])
})

test("sin instalación gobierna el contrato, y se dice que es el contrato", () => {
  // No es un fallo: en `lab/` es exactamente lo correcto. Lo que no puede es
  // pasar callado, porque en un proyecto que no sea Node con `src/` medir contra
  // el contrato es medir contra la forma de otro proyecto.
  const r = elegirAlcance({ instalaciones: {}, contrato })
  assert.deepEqual(r.write, ["src/**", "tests/**"])
  assert.equal(r.fuente, "contrato")
  assert.ok(r.avisos.some((a) => /no hay alcance instalado/.test(a)))
})

test("gana la instalación del runtime que de verdad corrió", () => {
  const dos = { ...instalacion(["server/**"]), ...instalacion(["src/**"], [], "claude-code") }
  assert.deepEqual(elegirAlcance({ instalaciones: dos, contrato, runtime: "opencode" }).write, ["server/**"])
  assert.deepEqual(elegirAlcance({ instalaciones: dos, contrato, runtime: "claude-code" }).write, ["src/**"])
})

test("dos instalaciones que no dicen lo mismo se avisan en vez de desempatarse en silencio", () => {
  // Gane la que gane, la otra está gobernando alguna corrida con otro alcance.
  // Eso lo arregla una persona, no una regla de desempate.
  const dos = { ...instalacion(["server/**"]), ...instalacion(["app/**"], [], "claude-code") }
  const r = elegirAlcance({ instalaciones: dos, contrato, runtime: "opencode" })
  assert.deepEqual(r.write, ["server/**"])
  assert.ok(r.avisos.some((a) => /no coinciden/.test(a) && /app\/\*\*/.test(a)))
})

test("dos instalaciones que dicen lo mismo no producen ruido", () => {
  const dos = { ...instalacion(["server/**"]), ...instalacion(["server/**"], [], "claude-code") }
  assert.deepEqual(elegirAlcance({ instalaciones: dos, contrato, runtime: "opencode" }).avisos, [])
})

test("si solo está instalado el otro runtime, se usa y se dice", () => {
  const r = elegirAlcance({ instalaciones: instalacion(["app/**"], [], "claude-code"), contrato, runtime: "opencode" })
  assert.deepEqual(r.write, ["app/**"])
  assert.ok(r.avisos.some((a) => /corrió en opencode/.test(a)))
})

test("una instalación ilegible se dice, no se ignora", () => {
  const rota = { opencode: { ruta: ".opencode/scopes.generated.json", error: "no se pudo leer: JSON malformado" } }
  const r = elegirAlcance({ instalaciones: rota, contrato })
  assert.ok(r.avisos.some((a) => /JSON malformado/.test(a)))
  assert.equal(r.fuente, "contrato", "cae al contrato, pero ruidosamente")
})

test("una instalación que no menciona al agente no cuenta como instalación suya", () => {
  const otra = { opencode: { ruta: "x", datos: { agents: { recon: { write: [], shell: [] } } } } }
  assert.equal(elegirAlcance({ instalaciones: otra, contrato, agente: "build" }).fuente, "contrato")
})

// ── el comando de la suite ─────────────────────────────────────────────────

test("el comando de pruebas sale de la instalación, no de una suposición", () => {
  assert.deepEqual(comandoDePruebas(["venv/bin/python -m pytest server/ -q", "git status", "git diff"]), [
    "venv/bin/python",
    "-m",
    "pytest",
    "server/",
    "-q",
  ])
})

test("los comandos de solo mirar no son la suite", () => {
  // Están en el alcance de todos los proyectos y no prueban nada; tomarlos por
  // la suite daría un verde sin haber corrido un solo test.
  assert.equal(comandoDePruebas(["git status", "git diff", "git log"]), null)
  assert.equal(comandoDePruebas([]), null)
})
