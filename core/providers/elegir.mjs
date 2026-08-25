#!/usr/bin/env node
/**
 * Decide con qué proveedor va a correr cada agente, y lo deja escrito.
 *
 * Un relevo que existe pero que nadie invoca es exactamente lo que este
 * repositorio llama «declarado, no cableado», y la regla dura del proyecto dice
 * que eso no cuenta. Este es el cable: lee los contratos de `agents/`, elige por
 * cada uno la primera opción que **cumple su contrato** y tiene con qué correr, y
 * escribe la elección donde el adaptador del runtime la va a encontrar.
 *
 *   node core/providers/elegir.mjs            decide y escribe la elección
 *   node core/providers/elegir.mjs --seco     la enseña sin escribir nada
 *
 * La bitácora se imprime siempre y se guarda con la elección. No es un log: es
 * la respuesta a «¿por qué este dictamen lo produjo ese modelo y no el otro?»,
 * que es una pregunta que se hace después, cuando ya no se puede reconstruir.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { elegir, firma } from "./relevo.mjs"
import { sondearCuota } from "../verification/cuota.mjs"

const AQUI = dirname(fileURLToPath(import.meta.url))
const RAIZ = join(AQUI, "..", "..")
const AGENTS = join(RAIZ, "agents")
const CATALOGO = JSON.parse(readFileSync(join(AQUI, "catalogo.json"), "utf8"))
const DESTINO = join(RAIZ, "runtimes", "opencode", "eleccion.json")

const seco = process.argv.includes("--seco")

/** El sondeo real. Una petición por proveedor, cero si está agotado. */
const sondear = ({ endpoint, apiKey, modelo }) => sondearCuota({ apiKey, modelo, url: endpoint })

const agentes = readdirSync(AGENTS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(AGENTS, d.name, "agent.json")))
  .map((d) => d.name)

const eleccion = {}
const bitacoras = {}
let faltan = 0

for (const id of agentes) {
  const contrato = JSON.parse(readFileSync(join(AGENTS, id, "agent.json"), "utf8"))
  const idNeutral = contrato.model.preferred
  const requisitos = { requires: contrato.model.requires ?? [], min_context: contrato.model.min_context ?? 0 }

  const r = await elegir({ catalogo: CATALOGO, idNeutral, requisitos, sondear })

  console.log(`\n─── ${id} · pide "${idNeutral}" (${requisitos.min_context.toLocaleString("es")} de contexto) ───`)
  for (const b of r.bitacora) {
    const marca = b.resultado === "elegida" ? "✅" : b.resultado === "descartada" ? "⛔" : "↷ "
    console.log(`  ${marca} ${b.proveedor}/${b.modelo}: ${b.motivo}${b.detalle ? ` — ${b.detalle}` : ""}`)
  }

  bitacoras[id] = r.bitacora
  if (r.elegida) {
    const prov = CATALOGO.proveedores[r.elegida.proveedor]
    eleccion[idNeutral] = {
      proveedor: r.elegida.proveedor,
      modelo: r.elegida.id,
      runtime_id: `${prov.prefijo_runtime}${r.elegida.id}`,
      estado: r.elegida.estado,
    }
    console.log(`  → ${firma(r.elegida)}`)
  } else {
    faltan++
    console.log(`  → SIN PROVEEDOR: ${r.motivo}`)
  }
}

console.log(`\n${"═".repeat(58)}`)

if (!seco) {
  writeFileSync(
    DESTINO,
    `${JSON.stringify(
      {
        $comment:
          "GENERADO por core/providers/elegir.mjs. El adaptador lo prefiere sobre el model_map del runtime. " +
          "Caduca: refleja qué proveedor tenía cuota en el momento de escribirlo.",
        decidido_en: new Date().toISOString(),
        eleccion,
        bitacoras,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`Elección escrita en runtimes/opencode/eleccion.json`)
}

for (const [neutral, e] of Object.entries(eleccion)) {
  console.log(`  ${neutral.padEnd(20)} ${e.proveedor}/${e.modelo}  [${e.estado}]`)
}

if (faltan) {
  console.error(
    `\n${faltan} agente(s) se quedaron sin con qué correr.` +
      `\nEl sistema se para en vez de bajarle el listón al contrato: un agente con menos contexto` +
      `\ndel que necesita no falla, que sería visible — sigue trabajando peor, que no lo es.`,
  )
  process.exit(6)
}
console.log("\nTodos los agentes tienen proveedor.")
