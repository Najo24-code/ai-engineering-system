#!/usr/bin/env node
/**
 * La tercera etapa: REVIEW juzga lo que BUILD hizo.
 *
 *   node core/flow/review.mjs --run runs/<fecha> [--comando "node --test tests/"]
 *
 * Lo dispara una persona, igual que las dos anteriores. El orquestador es de la
 * Fase 5; hasta que el ciclo sea aburrido de tan confiable, automatizar el
 * disparo solo sirve para equivocarse más rápido.
 *
 * El orden de esta etapa no es casual, y es lo único que hay que entender de
 * este archivo:
 *
 *   1. **Primero mide el verificador.** Suite, alcance, secretos, citas: todo lo
 *      que se puede comprobar sin opinar, se comprueba antes de llamar a nadie.
 *   2. **Ese veredicto entra como insumo de REVIEW.** Así REVIEW no gasta su
 *      juicio —que es caro y falible— en lo que ya está medido, y sobre todo no
 *      se pone a *afirmar* cosas sobre los tests, que es exactamente lo que la
 *      Fase 3 existe para que nadie tenga que creerse.
 *   3. **Después se auditan las citas del dictamen.** Cada `archivo:línea` que
 *      REVIEW escriba se abre y se mira. Una cita inventada tiene la forma de un
 *      dato duro, y por eso un dictamen con una cita falsa se descarta entero:
 *      si inventó una, no hay manera de saber cuáles de las otras se leyó.
 *
 * REVIEW no corre la suite, no corre nada y no puede escribir: su contrato le
 * niega `bash`, `edit` y `write` en el runtime, no en el prompt. Eso está
 * probado aparte, en el banco de fronteras.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { correrAgente, ordenDelegada } from "../verification/runner.mjs"
import { veredicto } from "../verification/verdict.mjs"
import { leerDictamen, citasRotasEnAmbasRaices } from "./dictamen.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..", "..")

const args = process.argv.slice(2)
const leer = (bandera) => {
  const i = args.indexOf(bandera)
  return i === -1 ? null : args[i + 1]
}

const corrida = leer("--run")
if (!corrida) {
  console.error('uso: review.mjs --run runs/<fecha> [--comando "node --test tests/"]')
  process.exit(2)
}

const DIR = corrida.startsWith("/") ? corrida : join(ROOT, corrida)
if (!existsSync(DIR)) {
  console.error(`la corrida "${corrida}" no existe`)
  process.exit(2)
}

const deLaCorrida = (n, obligatorio = true) => {
  const r = join(DIR, n)
  if (!existsSync(r)) {
    if (!obligatorio) return null
    console.error(`la corrida no tiene ${n}; no se puede revisar lo que no está guardado`)
    process.exit(2)
  }
  return readFileSync(r, "utf8")
}

const task = (leer("--task") ?? deLaCorrida("tarea.txt")).trim()
const target = (leer("--target") ?? deLaCorrida("objetivo.txt", false) ?? "lab").trim()
const diff = deLaCorrida("cambios.diff")
const reporteBuild = deLaCorrida("build.md", false)
const CWD = target.startsWith("/") ? target : join(ROOT, target)

const guardar = (nombre, contenido) => {
  const ruta = join(DIR, nombre)
  writeFileSync(ruta, contenido.replace(/\x1b?\[[0-9;]*m/g, ""))
  return ruta
}

if (!diff.trim()) {
  console.error("el diff está vacío: BUILD no cambió nada y no hay nada que revisar")
  process.exit(3)
}

// ── 1. lo que se puede medir, se mide ───────────────────────────────────────

/** El alcance sale del contrato de BUILD. Una segunda copia se desincronizaría. */
const contratoBuild = JSON.parse(readFileSync(join(ROOT, "agents", "build", "agent.json"), "utf8"))
const alcance = contratoBuild.scope.write

process.stdout.write("MEDIR  el verificador, antes de opinar . ")
const medido = veredicto({
  proyecto: CWD,
  base: leer("--base") ?? "HEAD",
  alcance,
  informe: { texto: reporteBuild ?? "" },
  comando: leer("--comando")?.split(" ").filter(Boolean),
})
guardar("veredicto.json", JSON.stringify(medido, null, 2))
console.log(medido.resultado)
for (const c of medido.controles) console.log(`       ${c.aprueba ? "✅" : "🔴"} ${c.control.padEnd(9)} ${c.detalle ?? "conforme"}`)

// ── 2. REVIEW juzga lo que la medición no alcanza ───────────────────────────

const resumenMedido = medido.controles
  .map((c) => `- ${c.control}: ${c.aprueba ? "OK" : "PROBLEM"} — ${c.detalle ?? "conforme"}`)
  .join("\n")

const mensaje =
  `You are reviewing a change that another agent (BUILD) just made in this repository.\n\n` +
  `=== TASK GIVEN TO BUILD ===\n${task}\n=== END TASK ===\n\n` +
  `=== THE DIFF BUILD ACTUALLY PRODUCED ===\n${diff}\n=== END DIFF ===\n\n` +
  (reporteBuild
    ? `=== WHAT BUILD CLAIMS IT DID (party statement, not fact) ===\n${reporteBuild}\n=== END CLAIM ===\n\n`
    : "") +
  `=== MEASURED VERDICT FROM THE INDEPENDENT VERIFIER (${medido.resultado}) ===\n${resumenMedido}\n` +
  `=== END MEASURED VERDICT ===\n\n` +
  `This verdict was measured, not claimed. Do not re-check it and do not contradict it. ` +
  `Your job starts where the measurement ends: correctness, task fit, broken contracts, ` +
  `and tests that would pass with the bug still in. Open the files the diff touches; the diff ` +
  `shows the changed lines, not the context that breaks them. Produce your complete dictamen.`

process.stdout.write("\nREVIEW juzgando ....................... ")
const r = correrAgente({ agente: "probe", cwd: CWD, mensaje: ordenDelegada("review", mensaje), timeoutMs: 15 * 60 * 1000 })
guardar("review.md", r.salida)

if (r.fallo) {
  console.log(`NO CORRIÓ (${r.fallo})`)
  console.error(`\nREVIEW no llegó a dictaminar. Salida cruda en ${corrida}/review.md`)
  process.exit(4)
}
const dictamen = r.salida.replace(/\x1b?\[[0-9;]*m/g, "")
console.log("listo")

// ── 3. las citas del dictamen se auditan una por una ────────────────────────

const rotas = citasRotasEnAmbasRaices(CWD, ROOT, dictamen)

// ── 4. coherencia del propio dictamen ───────────────────────────────────────

const { veredicto: veredictoRevisor, bloqueantes, incoherencias } = leerDictamen(dictamen)

// ── el resultado de la etapa ────────────────────────────────────────────────

const descartado = rotas.length > 0 || incoherencias.length > 0

const salida = {
  fecha: new Date().toISOString(),
  corrida,
  tarea: task,
  medido: { resultado: medido.resultado, motivos: medido.motivos },
  revisor: { veredicto: veredictoRevisor, defectos_bloqueantes: bloqueantes },
  citas_rotas: rotas,
  incoherencias,
  aceptado: !descartado,
  resultado: descartado ? "DICTAMEN DESCARTADO" : veredictoRevisor,
}
guardar("dictamen.json", JSON.stringify(salida, null, 2))

console.log(`\n${"═".repeat(64)}`)
if (rotas.length) {
  console.log(`🔴 DICTAMEN DESCARTADO — ${rotas.length} cita(s) que no existen:`)
  for (const c of rotas) console.log(`     ${c.cita} — ${c.motivo}`)
  console.log("   Si inventó una, no hay forma de saber cuáles de las otras leyó.")
} else if (incoherencias.length) {
  console.log("🔴 DICTAMEN DESCARTADO — el dictamen se contradice:")
  for (const i of incoherencias) console.log(`     ${i}`)
} else {
  console.log(`Verificador (medido) : ${medido.resultado}`)
  console.log(`REVIEW (juicio)      : ${veredictoRevisor}  ·  ${bloqueantes} defecto(s) bloqueante(s)`)
  console.log(`Citas comprobadas    : todas existen`)
}
console.log(`\nEvidencia en ${corrida}/`)
console.log("  veredicto.json  lo que se midió")
console.log("  review.md       lo que REVIEW dictaminó")
console.log("  dictamen.json   el dictamen auditado")
console.log("═".repeat(64))

if (descartado) process.exit(5)
if (medido.resultado === "RECHAZADO" || veredictoRevisor === "REJECTED") {
  console.log("\nEl trabajo vuelve a BUILD:")
  console.log(`  node core/flow/rework.mjs --run ${corrida}`)
  process.exit(1)
}
console.log("\nCiclo en verde. Lo que se publica lo decide una persona.")
