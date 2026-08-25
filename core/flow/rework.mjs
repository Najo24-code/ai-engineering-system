#!/usr/bin/env node
/**
 * La vuelta: un dictamen que rechaza devuelve el trabajo a BUILD.
 *
 *   node core/flow/rework.mjs --run runs/<fecha>
 *
 * Sin esta etapa, REVIEW es un adorno caro. Encontrar un defecto y no tener por
 * dónde devolverlo deja el ciclo abierto, y un ciclo abierto se cierra siempre
 * de la misma manera: alguien mira el dictamen, se encoge de hombros y publica.
 *
 * Dos decisiones que valen más que el código:
 *
 *   - **La vuelta arranca del árbol como quedó, no de cero.** BUILD arregla lo
 *     que él mismo hizo. Rehacer desde el principio pierde el contexto y suele
 *     traer un defecto distinto en vez del mismo defecto arreglado.
 *   - **BUILD recibe el dictamen, no un resumen del dictamen.** Resumir es
 *     decidir qué defecto importa, y eso ya lo decidió REVIEW.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { correrAgente, ordenDelegada } from "../verification/runner.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..", "..")

const args = process.argv.slice(2)
const leer = (b) => {
  const i = args.indexOf(b)
  return i === -1 ? null : args[i + 1]
}

const corrida = leer("--run")
if (!corrida) {
  console.error("uso: rework.mjs --run runs/<fecha>")
  process.exit(2)
}

const DIR = corrida.startsWith("/") ? corrida : join(ROOT, corrida)
const pedir = (n) => {
  const r = join(DIR, n)
  if (!existsSync(r)) {
    console.error(`la corrida no tiene ${n}`)
    process.exit(2)
  }
  return readFileSync(r, "utf8")
}

const task = pedir("tarea.txt").trim()
const target = (existsSync(join(DIR, "objetivo.txt")) ? readFileSync(join(DIR, "objetivo.txt"), "utf8") : "lab").trim()
const dictamen = pedir("review.md")
const CWD = target.startsWith("/") ? target : join(ROOT, target)

const VUELTA = join(DIR, "vuelta-2")
mkdirSync(VUELTA, { recursive: true })

const limpio = (s) => s.replace(/\x1b?\[[0-9;]*m/g, "")
const guardar = (n, c) => writeFileSync(join(VUELTA, n), limpio(c))

guardar("tarea.txt", `${task}\n`)
guardar("objetivo.txt", `${target}\n`)

const mensaje =
  `A reviewer rejected your previous change and sent it back. The working tree is exactly as you left it.\n\n` +
  `=== THE ORIGINAL TASK ===\n${task}\n=== END TASK ===\n\n` +
  `=== THE REVIEWER'S DICTAMEN ===\n${limpio(dictamen)}\n=== END DICTAMEN ===\n\n` +
  `Fix every BLOCKING defect it lists, and nothing else. Do not redo the feature from scratch: ` +
  `repair what is there. If you believe a defect is not real, say so in your report with the evidence ` +
  `and leave the code as it is — do not argue by rewriting. Then verify and report as usual.`

console.log(`Vuelta 2 de ${corrida}`)
console.log(`Tarea: ${task}\n`)
process.stdout.write("BUILD  arreglando lo señalado ......... ")

const b = correrAgente({ agente: "probe", cwd: CWD, mensaje: ordenDelegada("build", mensaje), timeoutMs: 15 * 60 * 1000 })
guardar("build.md", b.salida)

if (b.fallo) {
  console.log(`NO CORRIÓ (${b.fallo})`)
  process.exit(4)
}
console.log("listo")

const diff = execFileSync("git", ["-C", CWD, "diff", "--relative"], {
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
})
guardar("cambios.diff", diff)

const registro = join(CWD, ".opencode", "policy-gate.jsonl")
if (existsSync(registro)) copyFileSync(registro, join(VUELTA, "policy-gate.jsonl"))

console.log(`\nEvidencia en ${corrida}/vuelta-2/`)
console.log("\nAhora se vuelve a revisar, que es el punto de tener un ciclo:")
console.log(`  node core/flow/review.mjs --run ${corrida}/vuelta-2`)
