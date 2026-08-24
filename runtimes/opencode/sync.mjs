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

/**
 * El frontmatter solo sabe decir sí o no por herramienta. Para BUILD eso no
 * alcanza: necesita escribir, y la pregunta no es "¿puede escribir?" sino
 * "¿dónde?". Ese alcance lo aplica el policy gate en cada llamada, y lo lee de
 * aquí. Se GENERA desde los mismos contratos para que no exista una segunda
 * versión de la verdad que se desincronice en silencio.
 */
const SCOPES_PATH = join(ROOT, "lab", ".opencode", "scopes.generated.json")

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
    if (Object.prototype.hasOwnProperty.call(RT.permission_keys, t)) {
      permission[t] = "deny"                           // segunda capa; refuerzo, nunca la única
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

  const wanted = contract.model.preferred
  const model = RT.model_map[wanted]
  if (!model) {
    fail(id, `pide el modelo "${wanted}", que no está en el model_map de ${RT.runtime}`)
  }

  const head = {
    description: JSON.stringify(contract.purpose),
    mode: contract.role,
    model: model ?? "SIN-RESOLVER",
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

const ids = readdirSync(AGENTS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)

// Se renderiza todo en memoria primero. Nada toca el disco hasta que TODOS los
// contratos son válidos: un archivo a medio generar es peor que ninguno, porque
// parece configuración buena.
const scopes = {}

const rendered = ids.map((id) => {
  const contract = JSON.parse(readFileSync(join(AGENTS_DIR, id, "agent.json"), "utf8"))
  if (contract.id !== id) fail(id, `el campo id dice "${contract.id}" pero la carpeta se llama "${id}"`)

  // Un alcance ausente no es un alcance vacío: es un contrato que no contestó la
  // pregunta. Se rechaza en vez de asumir la respuesta permisiva.
  for (const campo of ["read", "write", "shell"]) {
    if (!Array.isArray(contract.scope?.[campo])) {
      fail(id, `scope.${campo} falta o no es una lista; el policy gate no puede aplicar un alcance que nadie declaró`)
    }
  }
  // Una herramienta que no tiene se declara como alcance vacío, no se omite:
  // omitirla haría que el gate lo tratara como "sin contrato".
  const usaBash = contract.tools.allow.includes("bash")
  if (!usaBash && contract.scope?.shell?.length) {
    fail(id, `declara comandos en scope.shell pero no tiene la herramienta bash`)
  }

  scopes[id] = { write: contract.scope.write, shell: contract.scope.shell }
  return { id, out: render(contract, id) }
})

const scopesOut =
  JSON.stringify(
    {
      $comment:
        "GENERADO por runtimes/opencode/sync.mjs — no editar a mano. Lo lee lab/.opencode/plugins/policy-gate.ts en cada llamada de herramienta. Un agente que no aparece aquí no queda sin gobierno: le siguen aplicando las reglas universales de core/policies/policy.mjs.",
      generado_desde: "agents/*/agent.json",
      agents: scopes,
    },
    null,
    2,
  ) + "\n"

if (problems.length) {
  console.error("El contrato no es válido para este runtime:")
  for (const p of problems) console.error(`  - ${p}`)
  console.error("\nNo se escribió nada.")
  process.exit(2)
}

let drift = 0
const salidas = [...rendered.map(({ id, out }) => ({ id, out, path: join(TARGET_DIR, `${id}.md`) })), {
  id: "scopes.generated.json",
  out: scopesOut,
  path: SCOPES_PATH,
}]

for (const { id, out, path } of salidas) {
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

if (drift) {
  console.error(`\n${drift} agente(s) desincronizado(s). Corre sync.mjs sin --check.`)
  process.exit(1)
}
console.log(`\n${ids.length} agente(s) sincronizado(s) con ${RT.runtime} ${RT.verified_version}.`)
