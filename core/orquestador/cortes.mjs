#!/usr/bin/env node
/**
 * El banco de cortes: G5.3 cableado.
 *
 *   node core/orquestador/cortes.mjs
 *
 * El gate dice: **un fallo en cualquier etapa detiene el ciclo; nunca lo
 * "arregla" siguiendo adelante.** Eso no se demuestra leyendo el código del
 * orquestador —ahí siempre parece que para—: se demuestra provocando el fallo y
 * mirando qué hizo.
 *
 * Y se demuestra sin gastar una sola llamada al modelo, a propósito. Un banco
 * que cuesta tres corridas se corre una vez, el día que se escribe, y después
 * nadie lo vuelve a mirar. Este cuesta segundos, así que puede correr en cada
 * cambio — que es la única forma de que un control siga vivo.
 *
 * ## Qué se mira, y qué NO
 *
 * No se mira lo que ATLAS imprime. Se miran dos cosas que no se pueden fingir:
 *
 *   1. **El código de salida**, que dice si paró y por qué.
 *   2. **El disco**: que la etapa siguiente no dejó su evidencia. Un orquestador
 *      que dijera «me detuve» y hubiera seguido igual quedaría en evidencia aquí,
 *      y esa es exactamente la mentira que este banco existe para no creerse.
 *
 * ## El control positivo
 *
 * La mitad importante. Un orquestador que se detuviera SIEMPRE pasaría los tres
 * cortes y sería inútil. Por eso el banco incluye un caso que **tiene que
 * avanzar**: sin él, «para ante un fallo» y «no funciona» son indistinguibles.
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const ATLAS = join(ROOT, "core", "orquestador", "atlas.mjs")

/** Un repositorio de usar y tirar, con o sin cambios sin commitear. */
function repo({ sucio = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cortes-"))
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" })
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "src", "a.js"), "module.exports = 1\n")
  g("init", "-q")
  g("config", "user.email", "banco@local")
  g("config", "user.name", "banco")
  g("add", "-A")
  g("commit", "-q", "-m", "base")
  if (sucio) writeFileSync(join(dir, "src", "a.js"), "module.exports = 2\n")
  return dir
}

function correrAtlas(argumentos) {
  try {
    const salida = execFileSync("node", [ATLAS, ...argumentos], { encoding: "utf8", stdio: "pipe", cwd: ROOT })
    return { codigo: 0, salida }
  } catch (e) {
    return { codigo: typeof e.status === "number" ? e.status : -1, salida: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

/** Los ciclos que ATLAS dejó en disco, para poder mirar hasta dónde llegó. */
const ciclosEnDisco = () =>
  existsSync(join(ROOT, "runs")) ? readdirSync(join(ROOT, "runs")).filter((d) => d.startsWith("atlas-")) : []

const casos = [
  {
    id: "objetivo-sin-repositorio",
    espera: "CORTE",
    porque: "sin HEAD contra el que comparar no hay verificación posible, así que no se empieza",
    montar: () => mkdtempSync(join(tmpdir(), "cortes-norepo-")),
    argumentos: (dir) => ["--task", "cualquier cosa", "--target", dir, "--clase", "diagnosticar"],
    // Que NO haya creado ciclo es la prueba de que se detuvo antes de gastar nada.
    sinCiclo: true,
  },
  {
    id: "revisar-sin-nada-que-revisar",
    espera: "CORTE",
    porque: "la ruta de revisión sobre un árbol limpio no tiene objeto; inventarse uno sería trabajo que nadie pidió",
    montar: () => repo({ sucio: false }),
    argumentos: (dir) => ["--task", "revisa lo que hice", "--target", dir, "--clase", "revisar"],
  },
  {
    id: "clase-que-no-existe",
    espera: "CORTE",
    porque: "una clase desconocida no se aproxima a la más parecida: se corta hacia una persona",
    montar: () => repo({ sucio: true }),
    argumentos: (dir) => ["--task", "haz algo", "--target", dir, "--clase", "desplegar"],
  },
  {
    // Los tres de arriba son precondiciones que ATLAS comprueba él mismo. Este es
    // el que el gate pide de verdad: una etapa que ARRANCA y falla.
    //
    // El fallo se provoca sin trucos: un repositorio donde el sistema no está
    // instalado no tiene el agente `probe`, así que el runtime cae al agente por
    // defecto — el hallazgo del 2026-08-26— y `clasificarFallo` lo marca TERMINAL.
    // RECON no llega a producir nada y la etapa sale con código 4.
    //
    // Lo que se comprueba no es que ATLAS lo diga: es que **la etapa siguiente no
    // dejó evidencia**. Si hubiera seguido adelante, habría un veredicto en disco.
    id: "etapa-que-arranca-y-falla",
    espera: "CORTE",
    porque: "RECON no produce mapa y BUILD trabajaría a ciegas; seguir dejaría evidencia con forma de evidencia buena",
    montar: () => repo({ sucio: false }),
    argumentos: (dir) => ["--task", "anade una funcion suma", "--target", dir, "--clase", "implementar"],
    sinEtapaSiguiente: "veredicto.json",
    lento: true,
  },
  {
    id: "CONTROL+ ruta que sí puede recorrerse",
    espera: "AVANZA",
    porque: "sin esto, «se detiene ante un fallo» y «no funciona» son indistinguibles",
    montar: () => repo({ sucio: true }),
    argumentos: (dir) => ["--task", "mira esto", "--target", dir, "--clase", "revisar", "--solo-clasificar"],
  },
]

const resultados = []
for (const caso of casos) {
  const dir = caso.montar()
  const antesLista = ciclosEnDisco()
  const antes = antesLista.length
  const { codigo, salida } = correrAtlas(caso.argumentos(dir))
  const creoCiclo = ciclosEnDisco().length > antes

  const paro = codigo !== 0

  // Que la etapa siguiente no haya dejado nada en disco. Un orquestador que
  // dijera «me detuve» y hubiera seguido igual queda en evidencia aquí, y esa es
  // justo la mentira que este banco existe para no creerse.
  let avanzoIgual = false
  if (caso.sinEtapaSiguiente) {
    const nuevos = ciclosEnDisco().filter((d) => !antesLista.includes(d))
    avanzoIgual = nuevos.some((d) => existsSync(join(ROOT, "runs", d, "trabajo", caso.sinEtapaSiguiente)))
  }

  const bien =
    caso.espera === "CORTE"
      ? paro && (!caso.sinCiclo || !creoCiclo) && !avanzoIgual
      : codigo === 0

  resultados.push({ ...caso, codigo, paro, creoCiclo, avanzoIgual, bien, salida })
  rmSync(dir, { recursive: true, force: true })
}

const ancho = Math.max(...resultados.map((r) => r.id.length))
for (const r of resultados) {
  const marca = r.bien ? "✅" : "🔴"
  console.log(`${marca} ${r.id.padEnd(ancho)}  código=${String(r.codigo).padStart(2)}  ${r.espera}`)
  console.log(`   ${r.porque}`)
}

const fallidos = resultados.filter((r) => !r.bien)
console.log(`\ncortes correctos ${resultados.filter((r) => r.bien && r.espera === "CORTE").length} · controles positivos ${resultados.filter((r) => r.bien && r.espera === "AVANZA").length} · fallos ${fallidos.length}`)

if (fallidos.length) {
  for (const f of fallidos) {
    console.log(`\n🔴 ${f.id}: esperaba ${f.espera} y salió con código ${f.codigo}`)
    console.log(f.salida.split("\n").slice(-6).join("\n"))
  }
  process.exit(1)
}
