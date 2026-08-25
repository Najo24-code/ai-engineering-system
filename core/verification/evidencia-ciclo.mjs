#!/usr/bin/env node
/**
 * Junta la evidencia de un ciclo en una línea de JSON versionable.
 *
 *   node core/verification/evidencia-ciclo.mjs runs/<fecha> [runs/<fecha>/vuelta-2 ...]
 *
 * Existe porque `runs/` está gitignored —ahí dentro hay transcripts completos y
 * no tienen por qué vivir en el historial— pero un informe que cita evidencia que
 * nadie puede abrir es una afirmación sin respaldo. Esto extrae lo citable: el
 * veredicto medido, el juicio del revisor, sus defectos con las citas, y el
 * resultado de auditar esas citas. Nada de prosa.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"))

if (!dirs.length) {
  console.error("uso: evidencia-ciclo.mjs runs/<fecha> [más corridas...]")
  process.exit(2)
}

/** La tabla de defectos, tal cual la escribió el revisor. */
function defectos(review) {
  const bloque = /## Defects\s*\n([\s\S]*?)(?=\n## |\n---)/.exec(review)
  if (!bloque) return []
  return bloque[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && !/^\|\s*-+/.test(l) && !/Severidad/i.test(l))
    .map((l) => {
      const c = l.split("|").map((x) => x.trim())
      return { severidad: c[1], cita: c[2], que: c[3], porque: c[4] }
    })
    .filter((d) => d.severidad)
}

const destino = join(ROOT, "docs", "audits", "evidence", "fase-4-ciclo.jsonl")
mkdirSync(dirname(destino), { recursive: true })

for (const d of dirs) {
  const DIR = d.startsWith("/") ? d : join(ROOT, d)
  const dictamen = JSON.parse(readFileSync(join(DIR, "dictamen.json"), "utf8"))
  const review = existsSync(join(DIR, "review.md")) ? readFileSync(join(DIR, "review.md"), "utf8") : ""

  const linea = {
    corrida: d,
    fecha: dictamen.fecha,
    tarea: dictamen.tarea,
    medido: dictamen.medido,
    revisor: dictamen.revisor,
    defectos: defectos(review.replace(/\x1b?\[[0-9;]*m/g, "")),
    citas_rotas: dictamen.citas_rotas,
    incoherencias: dictamen.incoherencias,
    resultado: dictamen.resultado,
  }
  appendFileSync(destino, JSON.stringify(linea) + "\n")
  console.log(`${d} → ${linea.resultado} (${linea.defectos.length} defecto(s) citado(s))`)
}
console.log(`\nevidencia en docs/audits/evidence/fase-4-ciclo.jsonl`)
