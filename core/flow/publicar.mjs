#!/usr/bin/env node
/**
 * La salida del ciclo: el trabajo verificado se convierte en un pull request.
 *
 *   node core/flow/publicar.mjs --run runs/<fecha> [--confirmar]
 *
 * Sin `--confirmar` no publica nada: dice exactamente qué haría y para. Publicar
 * es la única acción del sistema entera que sale de la máquina, y una acción que
 * sale de la máquina no se dispara por escribir mal una ruta.
 *
 * **Este archivo es lo que le da sentido a que BUILD no pueda tocar git.** La
 * prohibición del contrato (`nada de commit, push, reset`) no es desconfianza
 * decorativa: publicar exige comprobar cosas que el agente que hizo el trabajo
 * no puede comprobar sobre sí mismo. Aquí se comprueban, fuera del agente, con
 * la evidencia que dejó la corrida.
 *
 * Las cinco negativas, y por qué cada una:
 *
 *   1. **Sin dictamen, no se publica.** Un PR con el sello del ciclo sobre un
 *      trabajo que nadie revisó es peor que un PR sin sello: el sello es lo que
 *      hace que el revisor humano mire menos.
 *   2. **Un dictamen descartado no aprueba.** Si REVIEW inventó una cita, su
 *      veredicto no vale, aunque diga APPROVED.
 *   3. **El verificador manda sobre el revisor.** APPROVED de REVIEW con
 *      RECHAZADO medido es un desacuerdo que resuelve la medición, siempre.
 *   4. **El árbol tiene que ser el mismo que se midió.** Entre medir y publicar
 *      pasa tiempo, y si algo cambió, el PR llevaría el sello de una verificación
 *      hecha sobre otro contenido.
 *   5. **Nada que ya estuviera sucio antes de empezar.** Las cuatro anteriores
 *      protegen a quien revisa; esta protege a quien lanza el ciclo. El diff se
 *      toma contra `HEAD` al terminar, así que un archivo que ya estaba tocado
 *      —tu trabajo a medias, el propio instalador— se le atribuye al agente y
 *      viajaría **dentro de su PR con el sello de verificación encima**. Las
 *      otras cuatro evitan rojos falsos y verdes falsos que se quedan en la
 *      máquina; esta evita uno que sale de ella.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"

import { archivosDelDiff } from "../verification/verdict.mjs"
import { huellaDeArchivos, compararHuellas, explicarDeriva } from "../verification/huella.mjs"
import { nombreDeRama } from "./issue.mjs"

// ── las decisiones, sin disco ni red ────────────────────────────────────────

/**
 * Todo lo que impide publicar, junto. Devuelve la lista entera en vez de parar
 * en el primero: quien está a punto de publicar necesita saber todo lo que le
 * falta, no descubrirlo de uno en uno.
 *
 * @returns {string[]} vacío significa que se puede publicar
 */
export function motivosParaNoPublicar({ dictamen, medido, deriva, archivos, previos = [] }) {
  const motivos = []

  if (!dictamen) motivos.push("la corrida no tiene dictamen.json: nadie revisó este trabajo")
  else {
    if (dictamen.aceptado === false) {
      const porqué = [...(dictamen.citas_rotas ?? []).map((c) => c.cita), ...(dictamen.incoherencias ?? [])]
      motivos.push(`el dictamen quedó descartado${porqué.length ? ` (${porqué.join("; ")})` : ""}`)
    }
    if (dictamen.revisor?.veredicto === "REJECTED") {
      motivos.push(`REVIEW rechazó el trabajo con ${dictamen.revisor.defectos_bloqueantes} defecto(s) bloqueante(s)`)
    } else if (dictamen.revisor?.veredicto !== "APPROVED") {
      motivos.push(`REVIEW no dejó un veredicto legible (${dictamen.revisor?.veredicto ?? "ninguno"})`)
    }
  }

  if (!medido) motivos.push("la corrida no tiene veredicto.json: no hay medición que publicar")
  else if (medido.resultado !== "APROBADO") {
    motivos.push(`el verificador midió RECHAZADO: ${(medido.motivos ?? []).join("; ") || "sin motivo registrado"}`)
  }

  if (!archivos?.length) motivos.push("no hay ni un archivo tocado: no hay nada que publicar")

  // La quinta negativa, y la única que protege a quien lanza el ciclo en vez de
  // proteger al que lo revisa: si un archivo ya estaba sucio ANTES de que el
  // agente corriera, publicarlo metería trabajo ajeno dentro del PR del agente,
  // con el sello de verificación encima. No se decide aquí de quién es cada
  // línea —puede ser de los dos—: se para y lo dice.
  const yaEstaban = (archivos ?? []).filter((a) => (previos ?? []).includes(a))
  if (yaEstaban.length) {
    motivos.push(
      `${yaEstaban.length} archivo(s) ya estaban sin commitear antes de que el agente corriera: ${yaEstaban.join(", ")}. ` +
        `Publicarlos metería trabajo que no es suyo dentro de su PR, firmado por la verificación. ` +
        `Commitea o descarta eso aparte y vuelve a medir`,
    )
  }

  // Una corrida anterior a que existiera el sello no se puede comparar, y a un
  // "no se puede comparar" no se le contesta con un "adelante". La ausencia de
  // prueba es exactamente lo que esta comprobación existe para no aceptar.
  if (deriva?.sinSello) {
    motivos.push(
      "la corrida no guardó la huella del árbol verificado: no hay forma de demostrar que lo que hay ahora " +
        "sea lo que se midió. Vuelve a correr la revisión sobre este árbol",
    )
  } else if (deriva && !deriva.iguales) {
    motivos.push(
      `el árbol cambió desde que se midió (${explicarDeriva(deriva)}). ` +
        `Lo que se publicaría no es lo que se verificó: vuelve a correr la revisión`,
    )
  }

  return motivos
}

/**
 * El cuerpo del PR.
 *
 * Lleva la medición, no la prosa. Un PR que dice «revisado por el sistema y todo
 * correcto» no le sirve a quien lo lee: lo que le sirve es qué se comprobó, con
 * qué resultado y cómo se llama la corrida donde está la evidencia entera.
 *
 * Y dice quién lo produjo. Un cambio que salió de un ciclo automático se revisa
 * con otros ojos que uno escrito a mano, y esconderlo le quita al revisor el
 * dato más útil que tiene.
 */
export function cuerpoDelPR({ issue, tarea, corrida, medido, dictamen, archivos }) {
  const controles = (medido?.controles ?? [])
    .map((c) => `| ${c.control} | ${c.aprueba ? "✅" : "🔴"} | ${(c.detalle ?? "conforme").replace(/\|/g, "\\|")} |`)
    .join("\n")

  const suite = (medido?.controles ?? []).find((c) => c.control === "suite")?.medido
  const lineas = []

  if (issue) lineas.push(`Closes #${issue.number}`, "")

  lineas.push(
    "## Qué cambia",
    "",
    issue ? `Lo que pide el issue #${issue.number}: ${String(issue.title).trim()}` : tarea.split("\n")[0],
    "",
    "## Archivos",
    "",
    ...archivos.map((a) => `- \`${a}\``),
    "",
    "## Verificación independiente",
    "",
    "Esto **no** es lo que el agente dice de su propio trabajo: lo midió un verificador",
    "que corre fuera de él, sobre el árbol tal como quedó.",
    "",
    "| control | resultado | detalle |",
    "| --- | --- | --- |",
    controles || "| — | — | sin controles registrados |",
    "",
  )

  if (suite?.pasaron !== undefined) {
    lineas.push(`Suite medida: **${suite.pasaron} en verde, ${suite.fallaron ?? 0} en rojo**.`, "")
  }

  lineas.push(
    "## Cómo salió esto",
    "",
    `Producido por el ciclo RECON → BUILD → REVIEW y verificado antes de publicarse.`,
    dictamen?.revisor
      ? `Dictamen de REVIEW: **${dictamen.revisor.veredicto}**, ${dictamen.revisor.defectos_bloqueantes} defecto(s) bloqueante(s); sus citas se auditaron una por una contra los archivos.`
      : "",
    "",
    `El árbol publicado es byte a byte el que se verificó — se comprueba antes de abrir el PR.`,
    `Evidencia completa de la corrida: \`${corrida}\` (reporte de RECON, informe de BUILD, diff, dictamen y veredicto).`,
    "",
    "Nada de esto sustituye la revisión de una persona. Un verificador comprueba que el",
    "trabajo es el que se pidió y que la suite pasó de verdad; no comprueba que valga la pena.",
  )

  return lineas.filter((l) => l !== null && l !== undefined).join("\n")
}

/**
 * El mensaje del commit. Título del issue arriba, evidencia abajo.
 *
 * Sin firma de ninguna herramienta: quien responde por este commit es la persona
 * cuya cuenta lo publica.
 */
export function mensajeDeCommit({ issue, tarea, corrida, medido }) {
  const suite = (medido?.controles ?? []).find((c) => c.control === "suite")?.medido
  const titulo = issue ? String(issue.title).trim() : tarea.split("\n")[0].slice(0, 72)
  return [
    titulo,
    "",
    issue ? `Resuelve el issue #${issue.number}.` : "",
    "",
    suite?.pasaron !== undefined
      ? `Verificado por medición independiente: ${suite.pasaron} pruebas en verde, ${suite.fallaron ?? 0} en rojo,`
      : "Verificado por medición independiente:",
    `alcance respetado y sin secretos en el diff. Corrida ${corrida}.`,
    "",
  ]
    .filter((l) => l !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
}

// ── el guion ────────────────────────────────────────────────────────────────

const esteArchivo = fileURLToPath(import.meta.url)
if (process.argv[1] && basename(process.argv[1]) === basename(esteArchivo)) {
  const ROOT = join(dirname(esteArchivo), "..", "..")
  const args = process.argv.slice(2)
  const leer = (b) => {
    const i = args.indexOf(b)
    return i === -1 ? null : args[i + 1]
  }

  const corrida = leer("--run")
  if (!corrida) {
    console.error("uso: publicar.mjs --run runs/<fecha> [--confirmar] [--base <rama>]")
    process.exit(2)
  }

  const DIR = corrida.startsWith("/") ? corrida : join(ROOT, corrida)
  if (!existsSync(DIR)) {
    console.error(`la corrida "${corrida}" no existe`)
    process.exit(2)
  }

  const leerArchivo = (n, obligatorio = false) => {
    const r = join(DIR, n)
    if (existsSync(r)) return readFileSync(r, "utf8")
    if (obligatorio) {
      console.error(`la corrida no tiene ${n}`)
      process.exit(2)
    }
    return null
  }
  const leerJSON = (n) => {
    const t = leerArchivo(n)
    return t ? JSON.parse(t) : null
  }

  const tarea = (leerArchivo("tarea.txt", true) ?? "").trim()
  const target = (leerArchivo("objetivo.txt") ?? "lab").trim()
  const CWD = target.startsWith("/") ? target : join(ROOT, target)

  // El issue vive en la corrida original; una vuelta de rework es un
  // subdirectorio suyo y hereda el issue de su padre. Buscarlo en los dos
  // sitios evita que la segunda vuelta pierda el vínculo con lo que la originó.
  const issue = leerJSON("issue.json") ?? (existsSync(join(dirname(DIR), "issue.json")) ? JSON.parse(readFileSync(join(dirname(DIR), "issue.json"), "utf8")) : null)
  const medido = leerJSON("veredicto.json")
  const dictamen = leerJSON("dictamen.json")
  const huellaMedida = leerJSON("huella.json")

  const git = (...a) => execFileSync("git", ["-C", CWD, ...a], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }).trim()

  const archivos = archivosDelDiff(CWD, medido?.base ?? "HEAD")
  const huellaAhora = huellaDeArchivos(CWD, archivos)

  // Una corrida anterior a que existiera la huella no se puede comparar. No se
  // le inventa un "iguales: true": se dice que no hay con qué comparar, y eso ya
  // es motivo suficiente para no publicar a ciegas.
  const deriva = huellaMedida
    ? compararHuellas(huellaMedida, huellaAhora)
    : { iguales: false, aparecieron: [], desaparecieron: [], cambiaron: [], sinSello: true }

  // La foto de antes vive en la corrida original; una vuelta de rework la hereda.
  const previo =
    leerJSON("arbol-previo.json") ??
    (existsSync(join(dirname(DIR), "arbol-previo.json")) ? JSON.parse(readFileSync(join(dirname(DIR), "arbol-previo.json"), "utf8")) : null)

  const motivos = motivosParaNoPublicar({ dictamen, medido, deriva, archivos, previos: previo?.archivos ?? [] })
  if (!previo) {
    motivos.push(
      "la corrida no guardó cómo estaba el árbol antes de empezar: no se puede distinguir lo que hizo el agente de lo que ya estaba",
    )
  }

  console.log(`Corrida  : ${corrida}`)
  console.log(`Proyecto : ${target}`)
  console.log(`Issue    : ${issue ? `#${issue.number} ${issue.title}` : "ninguno (tarea escrita a mano)"}`)
  console.log(`Medido   : ${medido?.resultado ?? "sin veredicto"}`)
  console.log(`REVIEW   : ${dictamen?.revisor?.veredicto ?? "sin dictamen"}`)
  console.log(`Archivos : ${archivos.join(", ") || "ninguno"}\n`)

  if (motivos.length) {
    console.log("🔴 NO SE PUBLICA")
    for (const m of motivos) console.log(`   · ${m}`)
    process.exit(1)
  }

  const base = leer("--base") ?? git("rev-parse", "--abbrev-ref", "HEAD")
  if (base === "HEAD") {
    console.error("el proyecto está en HEAD desprendido; publicar desde ahí deja el trabajo sin rama de origen")
    process.exit(2)
  }
  const rama = issue ? nombreDeRama(issue) : `aes/${basename(DIR)}`
  const yaExiste = git("branch", "--list", rama)

  const cuerpo = cuerpoDelPR({ issue, tarea, corrida, medido, dictamen, archivos })
  const commit = mensajeDeCommit({ issue, tarea, corrida, medido })
  const titulo = issue ? String(issue.title).trim() : tarea.split("\n")[0].slice(0, 72)

  if (!args.includes("--confirmar")) {
    console.log("✅ Todo en verde. Esto es lo que haría (nada de esto ha pasado todavía):\n")
    console.log(`  1. rama nueva "${rama}" desde "${base}"${yaExiste ? "  ⚠️ ya existe" : ""}`)
    console.log(`  2. commit de ${archivos.length} archivo(s):\n${commit.split("\n").map((l) => `       ${l}`).join("\n")}`)
    console.log(`  3. push a origin/${rama}`)
    console.log(`  4. PR "${titulo}" contra ${base}, con este cuerpo:\n`)
    console.log(cuerpo.split("\n").map((l) => `       ${l}`).join("\n"))
    console.log(`\nPara publicarlo de verdad:\n  node core/flow/publicar.mjs --run ${corrida} --confirmar`)
    process.exit(0)
  }

  if (yaExiste) {
    console.error(`la rama "${rama}" ya existe en el proyecto; publicar encima pisaría trabajo`)
    process.exit(2)
  }

  process.stdout.write(`rama ${rama} ... `)
  git("checkout", "-b", rama)
  console.log("hecha")

  // Se añaden los archivos MEDIDOS, uno por uno, nunca `git add -A`. Lo segundo
  // barrería lo que hubiera en el árbol sin que nadie lo hubiera verificado, que
  // es justo lo que las cuatro comprobaciones de arriba existen para impedir.
  process.stdout.write(`commit de ${archivos.length} archivo(s) ... `)
  git("add", "--", ...archivos)
  const MENSAJE = join(DIR, "commit.txt")
  writeFileSync(MENSAJE, commit)
  git("commit", "-F", MENSAJE)
  console.log(git("rev-parse", "--short", "HEAD"))

  process.stdout.write("push ... ")
  git("push", "-u", "origin", rama)
  console.log("hecho")

  const CUERPO = join(DIR, "pr.md")
  writeFileSync(CUERPO, cuerpo)
  process.stdout.write("PR ... ")
  const url = execFileSync(
    "gh",
    ["pr", "create", "--title", titulo, "--body-file", CUERPO, "--base", base, "--head", rama],
    { cwd: CWD, encoding: "utf8" },
  ).trim()
  console.log(url.split("\n").at(-1))

  writeFileSync(join(DIR, "publicado.json"), JSON.stringify({ fecha: new Date().toISOString(), rama, base, pr: url.split("\n").at(-1), issue: issue?.number ?? null, archivos }, null, 2))

  console.log(`\n${"═".repeat(64)}`)
  console.log(`El proyecto quedó en la rama "${rama}". Para volver: git -C ${target} checkout ${base}`)
  console.log("Mergear lo decide una persona. El ciclo llega hasta aquí y para.")
  console.log("═".repeat(64))
}
