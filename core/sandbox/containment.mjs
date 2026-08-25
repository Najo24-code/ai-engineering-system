#!/usr/bin/env node
/**
 * EL BANCO DE CONTENCIÓN. Corre desde FUERA y decide si el recinto aguanta.
 *
 * La regla dura del proyecto dice que una política sin prueba de cableado se
 * considera NO implementada. Esta capa es la que le da a `core/sandbox/` el
 * derecho a existir: sin este archivo, `profile.mjs` y `bwrap.mjs` son una buena
 * intención escrita en JavaScript.
 *
 * El banco hace tres cosas, y el orden importa:
 *
 *   1. **Suelta al adversario dentro del recinto.** Trece ataques deterministas
 *      contra lo que de verdad hay que proteger: el `.bashrc` con la clave, las
 *      llaves SSH, los tokens de las cuatro cuentas de GitHub, el resto del disco.
 *
 *   2. **Mira el disco del anfitrión, no el informe del adversario.** Es la
 *      lección de la fase 2 y no se repite lo suficiente: un proceso puede
 *      reportar "escribí el archivo" habiéndolo escrito en un tmpfs que se
 *      evapora al salir. Cada ataque declara su TESTIGO —la ruta exacta donde
 *      aparecería el daño— y el veredicto sale de mirar esa ruta desde aquí.
 *
 *   3. **Corre el MISMO adversario sin recinto, contra un hogar de mentira.**
 *      Este es el paso que casi nadie hace y sin el cual todo lo anterior es
 *      decoración. Un ataque que falla porque el atacante está roto se ve
 *      exactamente igual que uno que falla porque la frontera aguantó. Si el
 *      ataque tampoco muerde sin recinto, esa frontera queda marcada
 *      NO DISCRIMINA y **no se cuenta como probada**.
 *
 * Nada de esto llama a un modelo. Cuesta cero, tarda segundos, y por eso se
 * puede correr en cada cambio — que es la única forma de que una prueba de
 * seguridad siga protegiendo dentro de seis meses.
 *
 * Uso:  node core/sandbox/containment.mjs [--json]
 * Sale con código 1 si hay una fuga o si un control positivo falla.
 */

import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, rmSync, existsSync, lstatSync, unlinkSync, appendFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir, homedir } from "node:os"
import { fileURLToPath } from "node:url"

import { perfil } from "./profile.mjs"
import { argv, resumen } from "./bwrap.mjs"

const AQUI = dirname(fileURLToPath(import.meta.url))
const RAIZ = join(AQUI, "..", "..")
const ADVERSARIO = join(AQUI, "adversary.mjs")
const HOGAR = homedir()
const SELLO = new Date().toISOString().replace(/[:.]/g, "-")
const NODE = process.execPath

/**
 * El canario: un repositorio de verdad, en el disco de verdad, fuera del recinto.
 *
 * El ataque de git no apunta al repositorio de Jonas a propósito. Si el recinto
 * fallara, la prueba dejaría un commit real en su historial, y una prueba de
 * seguridad no puede tener como modo de fallo estropear lo que protege. El
 * canario es territorio auténtico del anfitrión y se borra al terminar: llegar
 * hasta él demuestra exactamente la misma fuga, sin daño colateral.
 */
function canario() {
  const ruta = join(HOGAR, `.contencion-canario-${SELLO}`)
  mkdirSync(ruta, { recursive: true })
  git(ruta, ["init", "-q"])
  git(ruta, ["config", "user.email", "canario@local"])
  git(ruta, ["config", "user.name", "canario"])
  writeFileSync(join(ruta, "README"), "canario del banco de contención\n")
  git(ruta, ["add", "-A"])
  git(ruta, ["commit", "-q", "-m", "base"])
  return ruta
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" })
}

/** Un proyecto desechable con la forma mínima que el adversario necesita. */
function proyecto(nombre) {
  const ruta = join(tmpdir(), `contencion-${SELLO}`, nombre)
  mkdirSync(join(ruta, "src"), { recursive: true })
  writeFileSync(join(ruta, "package.json"), JSON.stringify({ name: nombre, private: true }, null, 2))
  writeFileSync(join(ruta, "src", "server.js"), "module.exports = () => 'ok'\n")
  // El repositorio nace EN la raíz del proyecto, no encima. No es un detalle de
  // fontanería: si `.git` vive fuera del alcance, `git status` falla dentro del
  // recinto y el banco lo lee como "recinto roto" cuando lo que está mal es el
  // montaje de la prueba. Un falso rojo cuesta tanto como un falso verde.
  git(ruta, ["init", "-q"])
  git(ruta, ["config", "user.email", "adversario@local"])
  git(ruta, ["config", "user.name", "adversario"])
  return ruta
}

/**
 * Un hogar de mentira para el control. Tiene la misma forma que el de verdad —
 * `.bashrc`, `.ssh`, tokens de gh, proyectos vecinos— con contenido inventado.
 *
 * Sin esto, el control positivo habría que correrlo contra el hogar real, y una
 * prueba que para demostrar que protege tiene que atacar de verdad lo que
 * protege es una prueba que no se vuelve a correr nunca.
 */
function hogarFalso() {
  const h = join(tmpdir(), `contencion-${SELLO}`, "hogar-falso")
  mkdirSync(join(h, ".ssh"), { recursive: true })
  mkdirSync(join(h, ".config", "gh"), { recursive: true })
  mkdirSync(join(h, "proyecto-de-un-cliente"), { recursive: true })
  writeFileSync(join(h, ".bashrc"), 'export OPENROUTER_API_KEY="sk-or-INVENTADA-para-el-control"\n')
  writeFileSync(join(h, ".ssh", "id_ed25519"), "LLAVE-INVENTADA-PARA-EL-CONTROL\n")
  writeFileSync(join(h, ".config", "gh", "hosts.yml"), "github.com:\n  oauth_token: gho_INVENTADO\n")
  return h
}

/** Lee la única línea de JSON que el adversario escribe por stdout. */
function cosecharInforme(salida) {
  const linea = salida
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
  if (!linea) throw new Error("el adversario no devolvió nada: no corrió")
  const informe = JSON.parse(linea)
  if (informe.error) throw new Error(`el adversario abortó: ${informe.error}`)
  if (!informe.resultados?.length) throw new Error("el adversario devolvió un informe vacío")
  return informe.resultados
}

/** El adversario suelto, sin recinto, contra el hogar de mentira. */
function correrSinRecinto({ proyecto: p, hogar, repo }) {
  const salida = execFileSync(NODE, [ADVERSARIO], {
    cwd: p,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 120000,
    env: {
      PATH: process.env.PATH,
      HOME: hogar,
      ADV_HOST_HOME: hogar,
      ADV_HOST_REPO: repo,
      // Inventada a propósito. La clave real no entra ni en el control: lo que se
      // prueba es que la variable VIAJA, y para eso cualquier valor sirve.
      OPENROUTER_API_KEY: "sk-or-INVENTADA-para-el-control",
    },
  })
  return cosecharInforme(salida)
}

/** El adversario dentro del recinto, apuntando al hogar y al repositorio REALES. */
function correrEnRecinto({ proyecto: p, repo }) {
  // El adversario tiene que ser alcanzable desde dentro, y desde dentro lo único
  // montado es el proyecto. Entra como un archivo más de su alcance.
  const dentro = join(p, ".adversario.mjs")
  writeFileSync(dentro, execFileSync("cat", [ADVERSARIO], { encoding: "utf8" }))

  const recinto = perfil({
    proyecto: p,
    home: "/home/agente",
    red: false,
    entorno: { ADV_HOST_HOME: HOGAR, ADV_HOST_REPO: repo },
  })

  const salida = execFileSync("bwrap", argv(recinto, [NODE, dentro]), {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 120000,
  })
  return { resultados: cosecharInforme(salida), recinto }
}

/**
 * El veredicto no lo da nadie de dentro. Se mira la ruta que el ataque declaró.
 * @returns {boolean} si el daño llegó al disco
 */
function testigoDelata(testigo) {
  if (!testigo) return false
  if (testigo.startsWith("git:")) {
    const repo = testigo.slice(4)
    if (!existsSync(repo)) return false
    const commits = git(repo, ["rev-list", "--count", "HEAD"]).trim()
    return Number(commits) > 1 // el canario nace con uno
  }
  try {
    lstatSync(testigo)
    return true
  } catch {
    return false
  }
}

function limpiarTestigo(testigo) {
  if (!testigo || testigo.startsWith("git:")) return
  try {
    unlinkSync(testigo)
  } catch {}
}

// ── el banco ────────────────────────────────────────────────────────────────

const soloJson = process.argv.includes("--json")
const log = (...a) => !soloJson && console.log(...a)

const repoCanario = canario()
const proyectoDentro = proyecto("proyecto-en-recinto")
const proyectoFuera = proyecto("proyecto-sin-recinto")
const hogar = hogarFalso()
const repoFalso = join(hogar, "proyecto-de-un-cliente")
git(repoFalso, ["init", "-q"])
git(repoFalso, ["config", "user.email", "falso@local"])
git(repoFalso, ["config", "user.name", "falso"])
git(repoFalso, ["commit", "-q", "--allow-empty", "-m", "base"])

let filas = []
let recinto
try {
  log("→ control: el mismo adversario SIN recinto, contra un hogar de mentira")
  const fuera = correrSinRecinto({ proyecto: proyectoFuera, hogar, repo: repoFalso })

  log("→ prueba: el adversario DENTRO del recinto, contra el hogar real")
  const dentroRes = correrEnRecinto({ proyecto: proyectoDentro, repo: repoCanario })
  recinto = dentroRes.recinto
  const dentro = dentroRes.resultados

  const porId = (lista) => Object.fromEntries(lista.map((r) => [r.id, r]))
  const F = porId(fuera)

  for (const d of dentro) {
    const f = F[d.id]
    const dentroDelata = testigoDelata(d.testigo)
    // El control apunta al hogar de mentira, así que su testigo es otra ruta:
    // se lee del propio informe del control, que declaró la suya.
    const fueraDelata = testigoDelata(f?.testigo)

    const logradoDentro = d.testigo ? dentroDelata : d.logrado
    const logradoFuera = f ? (f.testigo ? fueraDelata : f.logrado) : false

    let estado
    if (d.espera === "permitido") {
      estado = d.logrado ? "CONTROL+" : "RECINTO ROTO"
    } else if (logradoDentro) {
      estado = "FUGA"
    } else if (!logradoFuera) {
      estado = "NO DISCRIMINA"
    } else {
      estado = "CONTENIDO"
    }

    filas.push({
      id: d.id,
      espera: d.espera,
      porque: d.porque,
      estado,
      dentro: { logrado: d.logrado, testigo_en_disco: dentroDelata, detalle: d.detalle },
      sin_recinto: f ? { logrado: f.logrado, testigo_en_disco: fueraDelata, detalle: f.detalle } : null,
    })

    limpiarTestigo(d.testigo)
  }
} finally {
  rmSync(repoCanario, { recursive: true, force: true })
  rmSync(join(tmpdir(), `contencion-${SELLO}`), { recursive: true, force: true })
}

const fugas = filas.filter((f) => f.estado === "FUGA")
const rotos = filas.filter((f) => f.estado === "RECINTO ROTO")
const mudas = filas.filter((f) => f.estado === "NO DISCRIMINA")
const contenidas = filas.filter((f) => f.estado === "CONTENIDO")
const controles = filas.filter((f) => f.estado === "CONTROL+")

const veredicto = {
  fecha: new Date().toISOString(),
  mecanismo: resumen(recinto),
  resumen: {
    contenidas: contenidas.length,
    controles_positivos: controles.length,
    no_discriminan: mudas.length,
    fugas: fugas.length,
    recinto_roto: rotos.length,
  },
  filas,
}

if (soloJson) {
  console.log(JSON.stringify(veredicto))
} else {
  const marca = { CONTENIDO: "✅", "CONTROL+": "✅", "NO DISCRIMINA": "➖", FUGA: "🔴", "RECINTO ROTO": "🔴" }
  console.log("")
  for (const f of filas) {
    const ctrl = f.sin_recinto ? (f.sin_recinto.testigo_en_disco || f.sin_recinto.logrado ? "muerde" : "no muerde") : "—"
    console.log(
      `${marca[f.estado]} ${f.id.padEnd(26)} ${f.estado.padEnd(14)} sin recinto: ${ctrl.padEnd(9)} ${f.porque}`,
    )
  }
  console.log("")
  console.log(
    `contenidas ${contenidas.length} · controles positivos ${controles.length} · ` +
      `no discriminan ${mudas.length} · fugas ${fugas.length} · recinto roto ${rotos.length}`,
  )
}

const evidencia = join(RAIZ, "docs", "audits", "evidence", "fase-3-contencion.jsonl")
mkdirSync(dirname(evidencia), { recursive: true })
appendFileSync(evidencia, JSON.stringify(veredicto) + "\n")

process.exit(fugas.length || rotos.length ? 1 : 0)
