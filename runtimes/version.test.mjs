/**
 * Pruebas de la comprobación de versión.
 *
 * El caso que la trajo: el instalador imprimía «sincronizado con opencode
 * 1.18.18» —el número de `verified_version`— mientras la instalación tenía
 * 1.18.23. Nadie medía nada. La frase se leía como un hecho comprobado y era una
 * constante copiada de un archivo.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { versionDeSalida, versionInstalada, compararVersion } from "./version.mjs"

test("cada runtime contesta a su manera y de todas se saca el número", () => {
  assert.equal(versionDeSalida("1.18.23"), "1.18.23")
  assert.equal(versionDeSalida("2.1.246 (Claude Code)"), "2.1.246")
  assert.equal(versionDeSalida("opencode version 1.18.23\n"), "1.18.23")
})

test("una salida sin número no se convierte en un número", () => {
  assert.equal(versionDeSalida("command not found"), null)
  assert.equal(versionDeSalida(""), null)
  assert.equal(versionDeSalida(undefined), null)
})

test("un binario que no existe da null, no revienta la instalación", () => {
  assert.equal(versionInstalada(["/no/existe/binario", "--version"]), null)
  assert.equal(versionInstalada([]), null)
  assert.equal(versionInstalada(null), null)
})

test("coincidir se dice sin ruido", () => {
  const r = compararVersion({ runtime: "opencode", instalada: "1.18.23", verificada: "1.18.23" })
  assert.equal(r.estado, "coincide")
  assert.equal(r.aviso, null)
})

test("diferir avisa, y dice qué hay que correr para volver a darlo por cierto", () => {
  // Avisa, no impide: un gate que bloquea el trabajo por un salto de parche se
  // desactiva la primera semana. Lo que no puede es pasar callado.
  const r = compararVersion({ runtime: "opencode", instalada: "1.18.23", verificada: "1.18.18" })
  assert.equal(r.estado, "difiere")
  assert.match(r.linea, /1\.18\.23 instalado/)
  assert.match(r.linea, /verificaron contra 1\.18\.18/)
  assert.match(r.aviso, /gate:boundary/)
})

test("no poder medirla NO es que coincida", () => {
  // La regla de siempre: lo que no se puede medir no pasa por bueno. Un null
  // tratado como "igual" devolvería el silencio que este control vino a romper.
  const r = compararVersion({ runtime: "opencode", instalada: null, verificada: "1.18.18" })
  assert.equal(r.estado, "desconocida")
  assert.ok(r.aviso)
  assert.match(r.aviso, /no se sabe qué versión/)
})
