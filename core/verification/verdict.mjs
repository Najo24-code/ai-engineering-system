#!/usr/bin/env node
/**
 * EL VERIFICADOR. Aquí el sistema deja de creerle a los agentes.
 *
 * Todo lo construido hasta la fase 2 controla lo que el agente PUEDE hacer. Esta
 * capa controla algo distinto y más incómodo: lo que el agente DICE que hizo.
 *
 * El fallo que cierra este archivo no es el agente malicioso. Es el agente
 * normal, servicial, que escribe "los 214 tests pasan" porque el patrón de texto
 * encaja con lo que se espera de un informe, sin haber corrido nada. Ninguna
 * frontera de permisos detiene eso: no es una acción prohibida, es una frase. Se
 * detiene de una sola manera —midiendo por nuestra cuenta— y por eso el
 * verificador vive FUERA del agente y no comparte con él ni el proceso.
 *
 * Tres reglas gobiernan este archivo. Las tres son incómodas a propósito:
 *
 *   1. **Lo que el agente dice entra como AFIRMACIÓN, nunca como hecho.** El
 *      informe del agente es una hipótesis. Cada afirmación viaja junto a la
 *      medición independiente que la confirma o la desmiente, y en la evidencia
 *      quedan las dos, para que se pueda ver la distancia.
 *
 *   2. **Lo que no se puede medir NO pasa.** Es la regla que la gente afloja
 *      primero, y aflojarla convierte todo lo demás en teatro: si "no supe leer
 *      la salida de la suite" se trata como "la suite pasó", el verificador
 *      aprueba precisamente los casos raros, que son los peligrosos. Aquí, no
 *      medible es RECHAZADO, y el motivo se escribe.
 *
 *   3. **La suite se corre DENTRO del recinto.** No es purismo. La suite es
 *      código que escribió el agente; correrla aquí fuera le daría los permisos
 *      de este proceso, que es justo el agujero que anotó el informe de la fase 2.
 *      El verificador no puede cerrar ese agujero ejecutándolo él: lo cierra
 *      ejecutándolo encerrado.
 *
 * Uso:
 *   node core/verification/verdict.mjs --proyecto <ruta> [--base HEAD]
 *                                      [--informe <json>] [--alcance "src/**,tests/**"]
 *                                      [--comando "node --test tests/"]
 * Sale con código 1 si el veredicto es RECHAZADO.
 *
 * ⚠️ Un recinto no se anida: bubblewrap dentro de bubblewrap no arranca, porque
 * `--unshare-all` le quita al proceso de dentro justo lo que necesitaría para
 * crear otro. Se nota al verificar ESTE repositorio, cuya suite lanza recintos:
 * hay que apuntarle a la suite de política con `--comando`. No es un defecto del
 * verificador; es la forma que tiene el mecanismo.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { coincideGlob, normalizarRuta } from "../policies/policy.mjs"
import { perfil } from "../sandbox/profile.mjs"
import { argv } from "../sandbox/bwrap.mjs"

const AQUI = dirname(fileURLToPath(import.meta.url))
const RAIZ = join(AQUI, "..", "..")

/**
 * Lo que se busca en el diff. La lista es corta a propósito: cada patrón está
 * porque una credencial de ese tipo se ha filtrado a un repositorio público
 * alguna vez, no porque suene peligroso.
 */
const SECRETOS = [
  [/\bsk-or-v1-[a-zA-Z0-9]{16,}/, "clave de OpenRouter"],
  [/\bsk-ant-[a-zA-Z0-9_-]{16,}/, "clave de Anthropic"],
  [/\bsk-[a-zA-Z0-9]{32,}/, "clave de OpenAI"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "token de GitHub"],
  [/\bAKIA[0-9A-Z]{16}\b/, "clave de acceso de AWS"],
  [/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/, "llave privada"],
  [/\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]+@/, "cadena de conexión con contraseña"],
]

/** Un hallazgo del verificador: siempre lleva cómo se midió. */
const hallazgo = (control, aprueba, dice, medido, detalle = null) => ({
  control,
  aprueba,
  afirmado: dice,
  medido,
  detalle,
})

const git = (proyecto, args) => execFileSync("git", ["-C", proyecto, ...args], { encoding: "utf8", stdio: "pipe" })

// ── G3.1 · la suite la corre el verificador, dentro del recinto ──────────────

/**
 * Lee la salida del corredor de tests de Node (TAP). Devuelve `null` cuando no
 * la entiende, y ese `null` es información, no un fallo del parser: significa
 * "no medible", y arriba se traduce en rechazo.
 */
export function leerTap(salida) {
  const pass = /^# pass (\d+)$/m.exec(salida)
  const fail = /^# fail (\d+)$/m.exec(salida)
  if (!pass || !fail) return null
  return { pasaron: Number(pass[1]), fallaron: Number(fail[1]) }
}

/**
 * Corre la suite del proyecto encerrada y devuelve lo que de verdad ocurrió.
 *
 * `red: false` no es un detalle: una suite sin red no puede "pasar" llamando a
 * un servicio de fuera, y tampoco puede mandar hacia fuera lo que encontró.
 */
export function correrSuiteAislada({ proyecto, comando = [process.execPath, "--test"], red = false }) {
  const recinto = perfil({ proyecto, home: "/home/verificador", red })
  try {
    const salida = execFileSync("bwrap", argv(recinto, comando), {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 300000,
    })
    return { corrio: true, codigo: 0, salida }
  } catch (e) {
    if (e.stdout === undefined && e.stderr === undefined) {
      // No es que la suite fallara: es que no llegó a correr. Distinguirlo
      // importa, porque "no corrió" nunca puede leerse como "pasó".
      return { corrio: false, codigo: null, salida: String(e.message ?? e) }
    }
    return { corrio: true, codigo: e.status ?? 1, salida: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

function controlSuite({ proyecto, afirmado, comando, red }) {
  const r = correrSuiteAislada({ proyecto, comando, red })

  if (!r.corrio) {
    return hallazgo("suite", false, afirmado, null, `la suite no llegó a correr: ${r.salida.slice(0, 200)}`)
  }

  const medido = leerTap(r.salida)
  if (!medido) {
    return hallazgo("suite", false, afirmado, null, "no se pudo leer el resultado de la suite; no medible no es aprobado")
  }

  if (medido.fallaron > 0) {
    return hallazgo("suite", false, afirmado, medido, `${medido.fallaron} tests fallan`)
  }
  if (medido.pasaron === 0) {
    // Una suite vacía sale con código 0. Es el verde más fácil de fabricar que
    // existe: basta con borrar los tests.
    return hallazgo("suite", false, afirmado, medido, "la suite no ejecutó ni un test")
  }

  // Y aquí es donde se caza al agente que se lo inventó.
  if (afirmado?.pasaron !== undefined && Number(afirmado.pasaron) !== medido.pasaron) {
    return hallazgo(
      "suite",
      false,
      afirmado,
      medido,
      `el informe dice ${afirmado.pasaron} tests en verde y la medición dice ${medido.pasaron}`,
    )
  }
  if (afirmado?.fallaron !== undefined && Number(afirmado.fallaron) !== medido.fallaron) {
    return hallazgo("suite", false, afirmado, medido, `el informe dice ${afirmado.fallaron} fallos y hay ${medido.fallaron}`)
  }

  return hallazgo("suite", true, afirmado, medido)
}

// ── G3.2 · el diff toca solo rutas permitidas ───────────────────────────────

export function archivosDelDiff(proyecto, base) {
  const salida = git(proyecto, ["diff", "--name-only", base])
  const sinSeguir = git(proyecto, ["ls-files", "--others", "--exclude-standard"])
  return [...new Set([...salida.split("\n"), ...sinSeguir.split("\n")].map((l) => l.trim()).filter(Boolean))]
}

function controlAlcance({ proyecto, base, alcance, afirmado }) {
  if (!alcance?.length) {
    return hallazgo("alcance", false, afirmado, null, "no se declaró alcance; sin alcance no hay nada contra qué medir")
  }
  const tocados = archivosDelDiff(proyecto, base)
  const fuera = tocados.filter((f) => {
    const rel = normalizarRuta(proyecto, f)
    return rel === null || !alcance.some((p) => coincideGlob(p, rel))
  })
  return fuera.length
    ? hallazgo("alcance", false, afirmado, tocados, `fuera del alcance: ${fuera.join(", ")}`)
    : hallazgo("alcance", true, afirmado, tocados)
}

// ── G3.3 · no aparecieron secretos en el diff ───────────────────────────────

/**
 * Se miran las líneas añadidas del diff Y el contenido entero de los archivos
 * nuevos sin añadir.
 *
 * Lo segundo no es exceso de celo: `git diff` no ve un archivo que nunca se
 * añadió al índice, así que un verificador que solo mirara el diff aprobaría el
 * caso más común de todos —el agente crea `config.local.js` con la clave dentro—
 * y lo aprobaría en silencio, que es la peor manera de fallar.
 */
function controlSecretos({ proyecto, base }) {
  const añadidas = git(proyecto, ["diff", base])
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))

  const nuevos = git(proyecto, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)

  for (const f of nuevos) {
    try {
      const contenido = readFileSync(join(proyecto, f), "utf8")
      if (contenido.includes("\u0000")) continue // binario: no hay líneas que leer
      añadidas.push(...contenido.split("\n"))
    } catch {
      // Ilegible (binario, enlace roto, permisos). Se anota, no se asume limpio.
      añadidas.push(`<<no se pudo leer ${f}>>`)
    }
  }

  const encontrados = []
  for (const linea of añadidas) {
    for (const [rx, nombre] of SECRETOS) {
      if (rx.test(linea)) encontrados.push(nombre)
    }
  }
  const unicos = [...new Set(encontrados)]
  return unicos.length
    ? hallazgo("secretos", false, null, unicos, `el cambio añade ${unicos.join(", ")}`)
    : hallazgo(
        "secretos",
        true,
        null,
        [],
        `${añadidas.length} líneas nuevas (diff + ${nuevos.length} archivos sin añadir), ninguna con forma de credencial`,
      )
}

// ── el añadido contra la alucinación pura: las citas ────────────────────────

/**
 * Un informe que cita `src/pagos.js:214` cuando el archivo tiene 30 líneas no
 * está equivocado: está inventado. Es la alucinación más difícil de ver leyendo,
 * porque tiene exactamente la forma de un dato duro.
 */
export function citasRotas(proyecto, texto) {
  const rotas = []
  for (const m of String(texto ?? "").matchAll(/\b([\w./-]+\.\w{1,5}):(\d+)\b/g)) {
    const [cita, ruta, linea] = [m[0], m[1], Number(m[2])]
    const rel = normalizarRuta(proyecto, ruta)
    const abs = rel === null ? null : join(proyecto, rel)
    if (!abs || !existsSync(abs)) {
      rotas.push({ cita, motivo: "el archivo no existe" })
      continue
    }
    const lineas = readFileSync(abs, "utf8").split("\n").length
    if (linea > lineas) rotas.push({ cita, motivo: `el archivo tiene ${lineas} líneas` })
  }
  return rotas
}

function controlCitas({ proyecto, texto }) {
  if (!texto) return null
  const rotas = citasRotas(proyecto, texto)
  return rotas.length
    ? hallazgo("citas", false, texto.length + " caracteres de informe", rotas, `${rotas.length} citas que no existen`)
    : hallazgo("citas", true, texto.length + " caracteres de informe", [])
}

// ── el veredicto ────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} o.proyecto  árbol de trabajo a juzgar
 * @param {string} [o.base]    contra qué se compara el diff
 * @param {string[]} o.alcance globs que el agente tenía permitido tocar
 * @param {object} [o.informe] lo que el agente AFIRMA: { tests:{pasaron,fallaron}, texto }
 */
export function veredicto({ proyecto, base = "HEAD", alcance = [], informe = {}, comando, red = false }) {
  const controles = [
    controlSuite({ proyecto, afirmado: informe.tests ?? null, comando, red }),
    controlAlcance({ proyecto, base, alcance, afirmado: informe.archivos ?? null }),
    controlSecretos({ proyecto, base }),
    controlCitas({ proyecto, texto: informe.texto }),
  ].filter(Boolean)

  const fallidos = controles.filter((c) => !c.aprueba)
  return {
    fecha: new Date().toISOString(),
    proyecto,
    base,
    alcance,
    resultado: fallidos.length ? "RECHAZADO" : "APROBADO",
    motivos: fallidos.map((c) => `${c.control}: ${c.detalle}`),
    controles,
  }
}

// ── linea de comandos ───────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const arg = (n, d = null) => {
    const i = process.argv.indexOf(`--${n}`)
    return i > -1 ? process.argv[i + 1] : d
  }
  const proyecto = arg("proyecto")
  if (!proyecto) {
    console.error("falta --proyecto <ruta>")
    process.exit(2)
  }
  const informeRuta = arg("informe")
  const comando = arg("comando")
  const v = veredicto({
    proyecto,
    base: arg("base", "HEAD"),
    alcance: (arg("alcance", "") || "").split(",").map((s) => s.trim()).filter(Boolean),
    informe: informeRuta ? JSON.parse(readFileSync(informeRuta, "utf8")) : {},
    comando: comando ? comando.split(" ").filter(Boolean) : undefined,
  })

  for (const c of v.controles) {
    console.log(`${c.aprueba ? "✅" : "🔴"} ${c.control.padEnd(10)} ${c.detalle ?? "conforme"}`)
  }
  console.log(`\n${v.resultado}`)

  const destino = join(RAIZ, "docs", "audits", "evidence", "fase-3-veredictos.jsonl")
  mkdirSync(dirname(destino), { recursive: true })
  writeFileSync(destino, JSON.stringify(v) + "\n", { flag: "a" })
  process.exit(v.resultado === "RECHAZADO" ? 1 : 0)
}
