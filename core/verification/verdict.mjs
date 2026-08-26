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
import { leerResultado, FORMATOS } from "./resultados.mjs"
import { regresionDeSuite, esArchivoDeTest, testDeLinea } from "./regresion.mjs"
import { testsSombreados, explicarSombras } from "./sombra.mjs"

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

  const medido = leerResultado(r.salida)
  if (!medido) {
    return hallazgo(
      "suite",
      false,
      afirmado,
      null,
      `no se pudo leer el resultado de la suite; no medible no es aprobado. ` +
        `Formatos que este verificador entiende: ${FORMATOS.join(", ")}. ` +
        `Si el proyecto usa otro, apúntale al suyo con --comando.`,
    )
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

/**
 * `--relative` no es cosmético. Sin él, `git diff --name-only` devuelve rutas
 * desde la RAÍZ del repositorio, y el proyecto que se juzga puede ser un
 * subdirectorio —`lab/` lo es— con lo que cada ruta llega con un prefijo de más
 * y `normalizarRuta` la manda fuera del alcance. El veredicto saldría rechazado
 * por un error de fontanería y con un motivo que además suena plausible, que es
 * la peor clase de falso rojo.
 */
export function archivosDelDiff(proyecto, base) {
  const salida = git(proyecto, ["diff", "--name-only", "--relative", base])
  const sinSeguir = git(proyecto, ["ls-files", "--others", "--exclude-standard"])
  return [...new Set([...salida.split("\n"), ...sinSeguir.split("\n")].map((l) => l.trim()).filter(Boolean))]
}

/**
 * El diff DE VERDAD: lo modificado y lo que nació sin añadirse al índice.
 *
 * `git diff` no ve un archivo que nunca se añadió, y crear archivos nuevos es lo
 * más normal que hace una implementación. El 2026-08-26, contra `lab/`, BUILD
 * escribió `src/math.js` y `tests/math.test.js` correctos y el flujo guardó un
 * `cambios.diff` **vacío**, anunció «Archivos tocados: ninguno» y dejó la etapa
 * de revisión abortando con «BUILD no cambió nada». Trabajo impecable, evidencia
 * en blanco, y la culpa aparente sobre el agente. En yunque no se vio por pura
 * suerte: allí tocó dos archivos que ya existían.
 *
 * Los nuevos se renderizan con `git diff --no-index` contra `/dev/null`, que
 * produce un diff unificado de verdad —con su `+++ b/<ruta>` y su `new file
 * mode`— **sin tocar el índice**. `git add -N` daría lo mismo mutando el
 * repositorio de otro, y este sistema ya sabotéo una vez al proyecto que venía
 * a ayudar.
 */
export function diffCompleto(proyecto, base = "HEAD") {
  const seguidos = git(proyecto, ["diff", "--relative", base])
  const nuevos = git(proyecto, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)

  const trozos = []
  for (const rel of nuevos) {
    try {
      // Si saliera con 0 es que no hay diferencia contra /dev/null, o sea que el
      // archivo está vacío: no hay nada que renderizar.
      execFileSync("git", ["diff", "--no-index", "--", "/dev/null", rel], { cwd: proyecto, encoding: "utf8" })
    } catch (e) {
      // `--no-index` termina con 1 cuando hay diferencias, que aquí es siempre.
      // El diff viene por stdout; sin él no se inventa nada.
      if (e.stdout) trozos.push(e.stdout)
    }
  }
  return [seguidos, ...trozos].filter(Boolean).join("")
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
  const añadidas = git(proyecto, ["diff", "--relative", base])
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
/**
 * Una cita abreviada no es una cita inventada.
 *
 * REVIEW cita `detectores.py:50` cuando el archivo es `server/detectores.py`.
 * Abreviar así es lo que hace cualquiera que lleve un rato dentro del mismo
 * repositorio, y el 2026-08-26 costó un dictamen entero: cuatro citas
 * perfectamente resolubles a ojo salieron como «el archivo no existe» y el
 * dictamen se descartó, con un motivo que además suena a acusación.
 *
 * Se resuelve por sufijo contra los archivos versionados, y **solo si encaja con
 * uno**. Con dos o más, la cita sigue rota: ahí la ambigüedad es de verdad, y
 * elegir una sería el control inventándose el dato que vino a comprobar.
 */
function candidatosPorSufijo(proyecto, ruta) {
  let versionados
  try {
    versionados = git(proyecto, ["ls-files"]).split("\n")
  } catch {
    return [] // no es un repositorio: no hay contra qué resolver
  }
  const cola = `/${ruta.replace(/^\.\//, "")}`
  return versionados.map((f) => f.trim()).filter((f) => f && f.endsWith(cola))
}

export function citasRotas(proyecto, texto) {
  const rotas = []
  for (const m of String(texto ?? "").matchAll(/\b([\w./-]+\.\w{1,5}):(\d+)\b/g)) {
    const [cita, ruta, linea] = [m[0], m[1], Number(m[2])]
    const rel = normalizarRuta(proyecto, ruta)
    let abs = rel === null ? null : join(proyecto, rel)
    if (!abs || !existsSync(abs)) {
      const encajan = candidatosPorSufijo(proyecto, ruta)
      if (encajan.length !== 1) {
        rotas.push({
          cita,
          motivo: encajan.length ? `hay ${encajan.length} archivos que encajan: ${encajan.join(", ")}` : "el archivo no existe",
        })
        continue
      }
      abs = join(proyecto, encajan[0])
    }
    // Un archivo que termina en salto de línea NO tiene una línea vacía de más:
    // `"a\nb\nc\n".split("\n")` devuelve cuatro trozos y el último no es una
    // línea, es el final. Contarlo dejaba pasar una cita a la línea N+1, y esto
    // es justamente el control que caza citas inventadas.
    const texto = readFileSync(abs, "utf8")
    const lineas = texto.replace(/\n$/, "").split("\n").length
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

// ── G3.5 · la suite de después no puede ser más flaca que la de antes ───────

/**
 * El control de la suite mira la foto de después, y esa foto está limpia cuando
 * el agente borró justo los tests que le salieron en rojo. El dato que lo delata
 * está en la diferencia, no en el estado final. El porqué entero, y el cableado
 * que lo demostró aprobando código roto, están en `regresion.mjs`.
 *
 * Los archivos nuevos sin añadir al índice entran aquí por la misma razón que en
 * el control de secretos: `git diff` no los ve, y sin ellos mover un test a un
 * archivo recién creado parecería una baja.
 */
function controlRegresion({ proyecto, base, declarados }) {
  const diff = git(proyecto, ["diff", "--relative", base])

  const nuevos = []
  for (const f of git(proyecto, ["ls-files", "--others", "--exclude-standard"]).split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (!esArchivoDeTest(f)) continue
    try {
      for (const linea of readFileSync(join(proyecto, f), "utf8").split("\n")) {
        const t = testDeLinea(linea)
        if (t?.nombre && !t.silencia) nuevos.push(t.nombre)
      }
    } catch {
      // Ilegible. No se asume que traía el test que falta.
    }
  }

  const r = regresionDeSuite({ diff, nuevos, declarados: declarados ?? [] })
  const medido = { retirados: r.retirados, silenciados: r.silenciados }

  if (!r.limpio) {
    const lista = r.sinDeclarar.map((n) => `"${n}"`).join(", ")
    return hallazgo(
      "regresión",
      false,
      declarados ?? null,
      medido,
      `el cambio retira o silencia ${r.sinDeclarar.length} test(s) que el informe no declara: ${lista}. ` +
        `Retirar un test puede estar bien; hacerlo en silencio deja la suite en verde por adelgazamiento. ` +
        `Si es deliberado, el informe lo dice en "tests_retirados".`,
    )
  }

  const dichos = (declarados ?? []).length
  return hallazgo(
    "regresión",
    true,
    declarados ?? null,
    medido,
    dichos
      ? `${r.retirados.length + r.silenciados.length} test(s) retirados o silenciados, todos declarados`
      : "ningún test retirado ni silenciado sin declarar",
  )
}

// ── G3.7 · el test que muere sin que nadie lo borre ─────────────────────────

/**
 * El control de regresión mira lo que SALE del diff. Este mira lo que entra y
 * choca con lo que ya estaba.
 *
 * Los dos cubren el mismo daño —una suite verde que cubre menos— por caminos
 * opuestos, y por eso hacen falta los dos. El porqué medido está en `sombra.mjs`.
 */
function controlSombra({ proyecto, base }) {
  // Con el diff pelado, un test duplicado dentro de un archivo de test RECIÉN
  // CREADO quedaba fuera del control: `git diff` no ve lo que no se añadió.
  const diff = diffCompleto(proyecto, base)

  // El contenido FINAL, que es donde se ve la colisión: el diff enseña las
  // líneas que entran, no con quién se encuentran al llegar.
  const contenidos = {}
  for (const ruta of archivosDelDiff(proyecto, base)) {
    if (!esArchivoDeTest(ruta)) continue
    try {
      contenidos[ruta] = readFileSync(join(proyecto, ruta), "utf8")
    } catch {
      // Ilegible: no hay nada que comprobar aquí. Lo dice el control de alcance.
    }
  }

  const sombras = testsSombreados({ diff, contenidos })
  return sombras.length
    ? hallazgo(
        "sombra",
        false,
        null,
        sombras,
        `${explicarSombras(sombras)}. Un nombre repetido no borra nada del diff: mata la definición anterior ` +
          `al importar, y la suite sigue verde con un test menos.`,
      )
    : hallazgo("sombra", true, null, [])
}

// ── el veredicto ────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} o.proyecto  árbol de trabajo a juzgar
 * @param {string} [o.base]    contra qué se compara el diff
 * @param {string[]} o.alcance globs que el agente tenía permitido tocar
 * @param {object} [o.informe] lo que el agente AFIRMA:
 *   { tests:{pasaron,fallaron}, archivos, texto, tests_retirados }
 */
export function veredicto({ proyecto, base = "HEAD", alcance = [], informe = {}, comando, red = false }) {
  const controles = [
    controlSuite({ proyecto, afirmado: informe.tests ?? null, comando, red }),
    controlRegresion({ proyecto, base, declarados: informe.tests_retirados ?? null }),
    controlAlcance({ proyecto, base, alcance, afirmado: informe.archivos ?? null }),
    controlSombra({ proyecto, base }),
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
