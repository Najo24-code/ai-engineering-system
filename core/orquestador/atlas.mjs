#!/usr/bin/env node
/**
 * ATLAS: la persona describe el problema, no el proceso.
 *
 *   node core/orquestador/atlas.mjs --task "lo que pasa" --target /ruta/al/proyecto
 *   node core/orquestador/atlas.mjs --issue 12 --target /ruta/al/proyecto
 *
 * Lo que ATLAS hace, dicho sin adornos: **clasifica la tarea y recorre la ruta
 * que corresponde a esa clase, parando en seco al primer fallo.** No decide la
 * secuencia —eso es un dato declarado en `rutas.mjs`, validado al cargar— y no
 * publica: todas las rutas terminan entregándole a una persona.
 *
 * ## Por qué no hay "auto-arreglo"
 *
 * G5.3 pide que un fallo detenga el ciclo y que nunca se "arregle" siguiendo
 * adelante. Es la regla más fácil de romper sin querer, porque la tentación tiene
 * buena pinta: si REVIEW no corrió, ¿por qué no seguir con lo que hay? Porque una
 * etapa que arranca sobre un fallo anterior produce evidencia con la forma exacta
 * de la evidencia buena. El ciclo entero existe para que nadie tenga que
 * distinguir esas dos cosas a ojo.
 *
 * ## Cómo se sabe qué pasó en cada etapa
 *
 * No leyendo su salida por pantalla. Cada etapa del flujo ya termina con un
 * **código de salida** con significado y deja su **evidencia en JSON**; ATLAS
 * mira eso. Raspar prosa sería volver a preguntarle al vigilado cómo le fue.
 */

import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { RUTAS, MAX_VUELTAS, ETAPA, problemasDeTodas } from "./rutas.mjs"
import { decidir, renglonDeBitacora, explicarCorte, CLASES } from "./decidir.mjs"
import { correrAgente } from "../verification/runner.mjs"
import { diffCompleto } from "../verification/verdict.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..", "..")

// ── las rutas se validan ANTES de nada ─────────────────────────────────────

/**
 * Una ruta mal formada no puede llegar a correrse. Se comprueba aquí, con los
 * contratos de verdad, antes de gastar una sola llamada al modelo.
 */
const CONTRATOS = Object.fromEntries(
  ["recon", "build", "review", "probe"].map((id) => [id, JSON.parse(readFileSync(join(ROOT, "agents", id, "agent.json"), "utf8"))]),
)
const malFormadas = problemasDeTodas(RUTAS, CONTRATOS)
if (malFormadas.length) {
  console.error("🔴 hay rutas mal formadas; el orquestador no arranca:")
  for (const p of malFormadas) console.error(`   · ${p}`)
  process.exit(2)
}

// ── argumentos ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const leer = (b) => {
  const i = args.indexOf(b)
  return i === -1 ? null : args[i + 1]
}

const tarea = leer("--task")
const issue = leer("--issue")
const target = leer("--target") ?? "lab"
const claseForzada = leer("--clase")

if (!tarea && !issue) {
  console.error('uso: atlas.mjs --task "lo que pasa" [--target /ruta] [--clase <clase>] [--solo-clasificar]')
  console.error("     atlas.mjs --issue 12 [--repo owner/repo] [--target /ruta]")
  process.exit(2)
}

const CWD = target.startsWith("/") ? target : join(ROOT, target)
if (!existsSync(CWD)) {
  console.error(`el objetivo "${target}" no existe`)
  process.exit(2)
}

/**
 * Sin repositorio no hay verificación: el verificador compara el árbol contra
 * `HEAD`. Se comprueba aquí, antes de gastar nada, porque el fallo natural
 * —una excepción de git a mitad de una etapa— llega disfrazado de avería del
 * sistema cuando en realidad es una precondición que no se cumplió.
 */
try {
  execFileSync("git", ["-C", CWD, "rev-parse", "--git-dir"], { stdio: "pipe" })
} catch {
  console.error(`el objetivo "${target}" no es un repositorio git: sin HEAD contra el que comparar, nada de esto se puede verificar`)
  process.exit(2)
}

const sello = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const CICLO = join(ROOT, "runs", `atlas-${sello}`)
mkdirSync(CICLO, { recursive: true })
const BITACORA = join(CICLO, "decisiones.jsonl")

const anotar = (decision) => appendFileSync(BITACORA, `${renglonDeBitacora(decision)}\n`)

/** Ejecuta una etapa del flujo y devuelve su código de salida, sin raspar prosa. */
function etapa(guion, argumentos) {
  try {
    execFileSync("node", [join(ROOT, "core", "flow", guion), ...argumentos], { stdio: "inherit", cwd: ROOT })
    return 0
  } catch (e) {
    return typeof e.status === "number" ? e.status : 1
  }
}

const alto = (texto, codigo = 0) => {
  console.log(`\n${"═".repeat(64)}`)
  console.log(texto)
  console.log(`\nBitácora de decisiones: runs/atlas-${sello}/decisiones.jsonl`)
  console.log("El ciclo llega hasta aquí. Publicar lo decide una persona.")
  console.log("═".repeat(64))
  process.exit(codigo)
}

// ── 1. de qué clase es esto ────────────────────────────────────────────────

const textoTarea = tarea ?? `el issue #${issue}`
console.log(`Ciclo   : runs/atlas-${sello}`)
console.log(`Objetivo: ${target}`)
console.log(`Tarea   : ${textoTarea.split("\n")[0]}\n`)

let decision

if (claseForzada) {
  // Forzar la clase es legítimo —quien lanza el ciclo suele saber qué pide— y se
  // registra como lo que es: una decisión de una persona, no del modelo. Sin esa
  // distinción, la bitácora atribuiría al clasificador aciertos que no son suyos.
  decision = decidir({ salidaDelModelo: `Clase: ${claseForzada}`, tarea: textoTarea })
  decision.quien = "persona"
} else {
  process.stdout.write("ATLAS  clasificando ................. ")
  const orden =
    `Classify this task into exactly ONE of these classes and nothing else.\n\n` +
    CLASES.map((c) => `- ${c}: ${RUTAS[c].porque}`).join("\n") +
    `\n\n=== THE TASK ===\n${textoTarea}\n=== END TASK ===\n\n` +
    `Answer with one line and nothing more:\nClase: <${CLASES.join("|")}>\n\n` +
    `If it does not fit exactly one of them, answer "Clase: ninguna". Do not invent a class ` +
    `and do not pick the closest one: an unclear task goes to a person, which is a good outcome, not a failure.`

  const r = correrAgente({ agente: "probe", cwd: CWD, mensaje: orden, timeoutMs: 5 * 60 * 1000 })
  writeFileSync(join(CICLO, "clasificacion.md"), r.delegada ?? r.salida)

  if (r.fallo) {
    console.log(`NO CORRIÓ (${r.fallo})`)
    decision = decidir({ salidaDelModelo: "", tarea: textoTarea })
    anotar(decision)
    alto(`🔴 ${explicarCorte({ etapa: "clasificación", motivo: r.fallo })}`, 4)
  }

  decision = decidir({ salidaDelModelo: r.delegada ?? r.salida, tarea: textoTarea })
  console.log(decision.clase ?? "sin clase legible")
}

anotar(decision)

if (decision.corte) {
  alto(
    `🔴 ${decision.corte}.\n\nNo se elige "la más probable": una tarea que no encaja va a una persona, ` +
      `y eso es un buen resultado, no un fallo. Clases posibles: ${CLASES.join(", ")}.`,
    3,
  )
}

console.log(`Ruta    : ${decision.etapas.join(" → ")}`)
console.log(`Porque  : ${decision.porque}\n`)

/**
 * Parar justo después de decidir.
 *
 * Existe para poder medir la clasificación —G5.1— sin pagar la ruta entera. Un
 * gate que sólo se puede comprobar gastando tres ciclos completos se comprueba
 * una vez y nunca más, y entonces deja de ser un gate.
 */
if (args.includes("--solo-clasificar")) {
  alto(`Sólo clasificación: la ruta no se recorrió.\n\nClase elegida: ${decision.clase} (decidió: ${decision.quien}).`)
}

// ── 2. recorrer la ruta ────────────────────────────────────────────────────

/**
 * Dónde va la evidencia de esta ruta. **Se dicta, no se adivina.**
 *
 * La otra opción era mirar qué directorio de `runs/` es el más nuevo. Eso falla
 * en cuanto hay dos ciclos a la vez o alguien dejó uno a medias, y falla en
 * silencio: el orquestador seguiría trabajando, sobre la evidencia de otro.
 */
let corrida = join("runs", `atlas-${sello}`, "trabajo")

const argsObjetivo = ["--target", target, "--salida", corrida]
const argsTarea = issue ? ["--issue", issue, ...(leer("--repo") ? ["--repo", leer("--repo")] : [])] : ["--task", tarea]

if (decision.clase === "diagnosticar") {
  const codigo = etapa("recon-build.mjs", [...argsTarea, ...argsObjetivo, "--solo-recon"])
  if (codigo !== 0) alto(`🔴 ${explicarCorte({ etapa: ETAPA.RECON, motivo: `la etapa terminó con código ${codigo}` })}`, codigo)
  alto(`✅ Diagnóstico listo en ${corrida}/recon.md.\n\nNo se tocó nada del proyecto: esta ruta no escribe.`)
}

if (decision.clase === "revisar") {
  // El cambio ya existe en el árbol. La corrida se arma desde él, sin volver a
  // pedirle a nadie que lo haga: rehacer un trabajo que ya está hecho es la forma
  // más cara de no revisarlo.
  const diff = diffCompleto(CWD)
  if (!diff.trim()) alto("🔴 no hay nada que revisar: el árbol está limpio.", 3)

  corrida = join("runs", `atlas-${sello}`, "revision")
  mkdirSync(join(ROOT, corrida), { recursive: true })
  writeFileSync(join(ROOT, corrida, "tarea.txt"), `${textoTarea}\n`)
  writeFileSync(join(ROOT, corrida, "objetivo.txt"), `${target}\n`)
  writeFileSync(join(ROOT, corrida, "cambios.diff"), diff)
  // En esta ruta lo sucio ES el objeto de la revisión, así que nada estaba "de
  // antes": lo dice explícitamente en vez de dejar el archivo sin escribir.
  writeFileSync(join(ROOT, corrida, "arbol-previo.json"), JSON.stringify({ base: "HEAD", archivos: [], huella: {} }, null, 2))

  const codigo = etapa("review.mjs", ["--run", corrida])
  if (codigo !== 0) alto(`🔴 ${explicarCorte({ etapa: ETAPA.REVIEW, motivo: `la etapa terminó con código ${codigo}` })}`, codigo)
  alto(`✅ Revisado. Evidencia en ${corrida}/.`)
}

// ── implementar: la única ruta con vueltas ─────────────────────────────────

let codigo = etapa("recon-build.mjs", [...argsTarea, ...argsObjetivo])
if (codigo !== 0) {
  alto(`🔴 ${explicarCorte({ etapa: ETAPA.BUILD, motivo: `la etapa terminó con código ${codigo}` })}`, codigo)
}

let vuelta = 1
let aRevisar = corrida

while (true) {
  codigo = etapa("review.mjs", ["--run", aRevisar])

  // 0 = todo en verde. 1 = el trabajo vuelve a BUILD. Cualquier otro es un fallo
  // de la etapa, y ahí NO se reintenta: reintentar un dictamen descartado o una
  // corrida que no llegó a correr es repetir lo mismo esperando otra cosa.
  if (codigo === 0) break
  if (codigo !== 1) {
    alto(`🔴 ${explicarCorte({ etapa: ETAPA.REVIEW, motivo: `la etapa terminó con código ${codigo}`, vuelta })}`, codigo)
  }

  if (vuelta >= MAX_VUELTAS) {
    alto(`🔴 ${explicarCorte({ etapa: "vueltas", maxVueltas: MAX_VUELTAS })}\n\nEvidencia en ${aRevisar}/.`, 1)
  }

  vuelta += 1
  console.log(`\n↩︎  vuelta ${vuelta} de ${MAX_VUELTAS}\n`)
  codigo = etapa("rework.mjs", ["--run", aRevisar])
  if (codigo !== 0) {
    alto(`🔴 ${explicarCorte({ etapa: ETAPA.BUILD, motivo: `la corrección terminó con código ${codigo}`, vuelta })}`, codigo)
  }
  aRevisar = join(aRevisar, "vuelta-2")
}

alto(
  `✅ Ciclo en verde en ${vuelta} vuelta(s). Evidencia en ${aRevisar}/.\n\n` +
    `Para ver qué publicaría, sin tocar nada:\n  node core/flow/publicar.mjs --run ${aRevisar}`,
)
