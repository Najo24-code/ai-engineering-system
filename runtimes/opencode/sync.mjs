#!/usr/bin/env node
/**
 * Adaptador OpenCode.
 *
 * Traduce los contratos de agents/ al formato que OpenCode entiende.
 *
 * La razón de que exista este archivo, y no un .md escrito a mano:
 * OpenCode descarta en silencio las claves de permiso que no reconoce. Un
 * frontmatter escrito a mano parece encerrar al agente y no lo encierra.
 * Aquí la traducción es explícita y se valida contra hechos verificados
 * del runtime (runtime.json).
 *
 *   node runtimes/opencode/sync.mjs           escribe los archivos
 *   node runtimes/opencode/sync.mjs --check   no escribe; sale 1 si hay desvío
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..", "..")
const AGENTS_DIR = join(ROOT, "agents")
const TARGET_DIR = join(ROOT, "lab", ".opencode", "agents")
const PROVIDER = "openrouter"

const RT = JSON.parse(readFileSync(join(HERE, "runtime.json"), "utf8"))
const check = process.argv.includes("--check")

const problems = []
const fail = (agent, msg) => problems.push(`${agent}: ${msg}`)

/**
 * El corazón del adaptador.
 *
 * No traduce "deny" a "deny". Parte de que TODO está permitido —que es la
 * verdad del runtime— y construye la negación de todo lo que el contrato no
 * permitió explícitamente. La lista de la que parte es la de herramientas
 * reales, no la que el contrato imagine.
 */
function buildPermissions(contract, id) {
  const allow = new Set(contract.tools.allow)
  const deny = new Set(contract.tools.deny)
  const real = new Set([...RT.tools, ...RT.plugin_tools])

  // Un permiso sobre algo que no existe es una falsa sensación de cobertura.
  for (const t of [...allow, ...deny]) {
    if (!real.has(t)) {
      fail(id, `declara la herramienta "${t}", que no existe en ${RT.runtime} ${RT.verified_version}`)
    }
  }
  for (const t of allow) {
    if (deny.has(t)) fail(id, `"${t}" está a la vez en allow y en deny`)
  }

  // Todo lo real que no se permitió explícitamente queda negado.
  const effectiveDeny = [...real].filter((t) => !allow.has(t)).sort()

  const permission = {}
  const tools = {}

  for (const t of effectiveDeny) {
    tools[t] = false                                   // el mapa que sí controla read/glob/grep/write
    if (RT.permission_keys_honored.includes(t)) {
      permission[t] = "deny"                           // segunda capa, para las claves que el runtime honra
    }
  }
  for (const t of allow) tools[t] = true

  // Un agente sin rutas de escritura no debe poder salirse del directorio.
  if (contract.scope.write.length === 0) permission.external_directory = "deny"

  return { permission, tools, effectiveDeny }
}

function yaml(value, indent = 0) {
  const pad = " ".repeat(indent)
  return Object.entries(value)
    .map(([k, v]) =>
      typeof v === "object" && v !== null
        ? `${pad}${k}:\n${yaml(v, indent + 2)}`
        : `${pad}${k}: ${v}`,
    )
    .join("\n")
}

function render(contract, id) {
  const { permission, tools } = buildPermissions(contract, id)
  const prompt = readFileSync(join(AGENTS_DIR, id, "prompt.md"), "utf8").trimEnd()

  const head = {
    description: JSON.stringify(contract.purpose),
    mode: contract.role,
    model: `${PROVIDER}/${contract.model.preferred}`,
  }

  return [
    "---",
    "# GENERADO por runtimes/opencode/sync.mjs — no editar a mano.",
    `# Fuente: agents/${id}/agent.json + agents/${id}/prompt.md`,
    yaml(head),
    "permission:",
    yaml(permission, 2),
    "tools:",
    yaml(tools, 2),
    "---",
    "",
    prompt,
    "",
  ].join("\n")
}

let drift = 0
const ids = readdirSync(AGENTS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)

for (const id of ids) {
  const contract = JSON.parse(readFileSync(join(AGENTS_DIR, id, "agent.json"), "utf8"))
  if (contract.id !== id) fail(id, `el campo id dice "${contract.id}" pero la carpeta se llama "${id}"`)

  const out = render(contract, id)
  const path = join(TARGET_DIR, `${id}.md`)
  const current = existsSync(path) ? readFileSync(path, "utf8") : null

  if (current === out) {
    console.log(`  = ${id}`)
  } else if (check) {
    console.log(`  ! ${id} desincronizado`)
    drift++
  } else {
    writeFileSync(path, out)
    console.log(`  ${current === null ? "+" : "~"} ${id}`)
  }
}

if (problems.length) {
  console.error("\nEl contrato no es válido para este runtime:")
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(2)
}
if (drift) {
  console.error(`\n${drift} agente(s) desincronizado(s). Corre sync.mjs sin --check.`)
  process.exit(1)
}
console.log(`\n${ids.length} agente(s) sincronizado(s) con ${RT.runtime} ${RT.verified_version}.`)
