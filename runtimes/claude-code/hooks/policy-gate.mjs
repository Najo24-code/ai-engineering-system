#!/usr/bin/env node
/**
 * El policy gate de Claude Code.
 *
 * Hace exactamente lo mismo que su gemelo de opencode y por el mismo motivo: es
 * la capa B —la programática—, la que decide en CADA llamada a herramienta si
 * ocurre o no. Lo que cambia entre los dos runtimes es la forma de enterarse y la
 * forma de negar; lo que NO cambia es quién juzga. Los dos llaman a
 * `core/policies/policy.mjs`. Si cada runtime trajera su propia copia de la
 * política, la Fase 6 sería dos sistemas parecidos en vez de uno portable, y las
 * dos copias se separarían el primer día que alguien arreglara un caso en una.
 *
 * Cómo se entera (medido, no leído): un JSON por stdin con `tool_name` y
 * `tool_input`.
 *
 * Cómo niega (medido, no leído): **saliendo con código 2**. El texto de stderr le
 * llega al agente. Salir con 0 deja pasar la llamada.
 *
 * La regla que gobierna este archivo: **un fallo del gate NO puede ser un permiso.**
 * Si no se entiende la entrada, si la política revienta, si falta el alcance — se
 * niega. Un gate que se cae abierto es peor que no tener gate, porque el informe
 * dirá que había uno.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const AQUI = dirname(fileURLToPath(import.meta.url))

/**
 * GENERADO: el instalador escribe aquí la ruta ABSOLUTA a la política.
 *
 * Con una ruta relativa el gate solo carga si el proyecto vive donde vive `lab/`.
 * Ya pasó en opencode y el modo de fallo es el peor posible: **un gate que no
 * carga no avisa** — la corrida sale igual de bien que si estuviera gobernada.
 */
const RUTA_POLITICA = "{{RUTA_POLITICA}}"

function niegaYSale(motivo) {
  process.stderr.write(`POLICY GATE: ${motivo}\n`)
  process.exit(2)
}

let entrada = ""
try {
  entrada = readFileSync(0, "utf8")
} catch (err) {
  niegaYSale(`no se pudo leer la llamada (${err.message}); no se aprueba lo que no se puede leer`)
}

let llamada
try {
  llamada = JSON.parse(entrada)
} catch {
  niegaYSale("la llamada no vino como JSON reconocible; no se aprueba lo que no se puede leer")
}

// La ruta la reescribe el instalador. Un `.catch` que devolviera undefined haría
// reventar el destructuring dos líneas más abajo con un error distinto del real.
let decidir
try {
  ;({ decidir } = await import(RUTA_POLITICA))
} catch (err) {
  niegaYSale(`no se pudo cargar la política (${err.message}); un gate que no carga no gobierna nada`)
}

const RT = JSON.parse(readFileSync(join(AQUI, "runtime.json"), "utf8"))
const SCOPES = JSON.parse(readFileSync(join(AQUI, "scopes.generated.json"), "utf8"))

/** Del nombre de este runtime al neutro del contrato. Es el tool_map al revés. */
const aNeutro = Object.fromEntries(
  Object.entries(RT.tool_map)
    .filter(([k]) => !k.startsWith("$"))
    .map(([neutro, propio]) => [propio, neutro]),
)

const tool = aNeutro[llamada.tool_name]
if (!tool) {
  // Una herramienta que este adaptador no sabe traducir no se aprueba por no
  // saber traducirla. Es la misma regla U-DESCONOCIDA de la política.
  niegaYSale(`la herramienta "${llamada.tool_name}" no está en el tool_map de este runtime; se niega por defecto`)
}

/**
 * Qué agente está llamando.
 *
 * Claude Code no lo dice en la entrada del hook. Sin esa pieza no se puede aplicar
 * el alcance de UN agente, así que se aplica el del agente que puede escribir —el
 * más restrictivo que tiene sentido— y se declara aquí como límite conocido en vez
 * de esconderlo. Es la misma forma que tomó H-18 en opencode: el runtime no lo
 * dice, se deduce, y la deducción se escribe.
 */
const AGENTE = process.env.AES_AGENTE ?? "build"
const contract = SCOPES.agents?.[AGENTE] ?? null

const args = {
  filePath: llamada.tool_input?.file_path,
  command: llamada.tool_input?.command,
}

let veredicto
try {
  veredicto = decidir({ tool, args, root: llamada.cwd, contract })
} catch (err) {
  niegaYSale(`la política falló al juzgar (${err.message}); ante un fallo del gate se niega, nunca se permite`)
}

// La política dice `action: "deny" | "allow"`. Cualquier otra cosa —una versión
// que devuelva un campo nuevo, un null— NO es un permiso.
if (veredicto?.action !== "allow") {
  niegaYSale(`${veredicto?.rule ?? "U-ILEGIBLE"} — ${veredicto?.reason ?? "la política no devolvió un permiso reconocible"}`)
}
process.exit(0)
