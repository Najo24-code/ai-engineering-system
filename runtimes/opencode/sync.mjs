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
 *   node runtimes/opencode/sync.mjs                 escribe los archivos en lab/
 *   node runtimes/opencode/sync.mjs --en <proyecto>  instala el sistema en otro repositorio
 *   node runtimes/opencode/sync.mjs --check          no escribe; sale 1 si hay desvío
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..", "..")
const AGENTS_DIR = join(ROOT, "agents")

/**
 * A qué proyecto se instala. Por defecto `lab/`, que es el banco de pruebas.
 *
 * Existe la bandera `--en` porque un sistema que solo sabe trabajar sobre su
 * propio laboratorio no está probado, está ensayado. Apuntarlo a un repositorio
 * de verdad —uno que no conoce, con su propia forma— es la primera prueba
 * honesta de que los contratos son de agentes y no de este árbol de archivos.
 */
const PROYECTO = (() => {
  const i = process.argv.indexOf("--en")
  if (i === -1) return join(ROOT, "lab")
  const r = process.argv[i + 1]
  if (!r) {
    console.error("--en necesita una ruta")
    process.exit(2)
  }
  return r.startsWith("/") ? r : join(process.cwd(), r)
})()

const TARGET_DIR = join(PROYECTO, ".opencode", "agents")

/**
 * El frontmatter solo sabe decir sí o no por herramienta. Para BUILD eso no
 * alcanza: necesita escribir, y la pregunta no es "¿puede escribir?" sino
 * "¿dónde?". Ese alcance lo aplica el policy gate en cada llamada, y lo lee de
 * aquí. Se GENERA desde los mismos contratos para que no exista una segunda
 * versión de la verdad que se desincronice en silencio.
 */
const SCOPES_PATH = join(PROYECTO, ".opencode", "scopes.generated.json")

/**
 * El plugin es la ÚNICA pieza que no puede copiarse tal cual.
 *
 * Importa `core/policies/policy.mjs` por una ruta relativa que solo es correcta
 * si el proyecto vive exactamente donde vive `lab/`. Instalado en un repositorio
 * de verdad, en cualquier otro sitio del disco, esa ruta no existe y el plugin
 * no carga — y un policy gate que no carga no avisa: simplemente no gobierna
 * nada, y la corrida sale igual de bien que si estuviera funcionando.
 *
 * Por eso se GENERA con la ruta resuelta a absoluta, y por eso la sustitución
 * falla ruidosamente si la línea que espera ya no está: prefiero que esto se
 * caiga aquí a que se caiga en silencio dentro del runtime.
 */
const PLUGIN_ORIGEN = join(HERE, "plugins", "policy-gate.ts")
const IMPORT_RELATIVO = 'import { decidir } from "../../../core/policies/policy.mjs"'

function renderPlugin() {
  const fuente = readFileSync(PLUGIN_ORIGEN, "utf8")
  if (!fuente.includes(IMPORT_RELATIVO)) {
    console.error(`El plugin ya no importa la política como se esperaba:`)
    console.error(`  esperaba: ${IMPORT_RELATIVO}`)
    console.error(`  en:       ${PLUGIN_ORIGEN}`)
    console.error("\nNo se escribió nada. Un plugin instalado con un import roto no gobierna nada.")
    process.exit(2)
  }
  const absoluto = `import { decidir } from ${JSON.stringify(join(ROOT, "core", "policies", "policy.mjs"))}`
  return fuente.replace(
    IMPORT_RELATIVO,
    `// GENERADO: la ruta la resuelve runtimes/opencode/sync.mjs al instalar.\n${absoluto}`,
  )
}

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
        "GENERADO por runtimes/opencode/sync.mjs — no editar a mano. Lo lee .opencode/plugins/policy-gate.ts en cada llamada de herramienta. Un agente que no aparece aquí no queda sin gobierno: le siguen aplicando las reglas universales de core/policies/policy.mjs.",
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
const salidas = [
  ...rendered.map(({ id, out }) => ({ id, out, path: join(TARGET_DIR, `${id}.md`) })),
  { id: "scopes.generated.json", out: scopesOut, path: SCOPES_PATH },
  { id: "plugins/policy-gate.ts", out: renderPlugin(), path: join(PROYECTO, ".opencode", "plugins", "policy-gate.ts") },
]

if (!check) {
  for (const d of [TARGET_DIR, join(PROYECTO, ".opencode", "plugins")]) mkdirSync(d, { recursive: true })
  ignorarLoInstalado()
}

/**
 * Lo que el instalador deja en el proyecto NO es trabajo del proyecto.
 *
 * Sin esto, `.opencode/` aparece como un puñado de archivos sin versionar y el
 * control de alcance del verificador los marca fuera de alcance en TODA corrida
 * posterior — el sistema se saboteaba a sí mismo al instalarse, y con un motivo
 * que además suena razonable.
 *
 * Se ignora por dentro, con un `.gitignore` propio, para no tocar el del
 * proyecto. Y solo si no había uno: este archivo es del proyecto en cuanto
 * alguien lo edita, y pisárselo en cada sync sería otra sorpresa.
 */
function ignorarLoInstalado() {
  const ruta = join(PROYECTO, ".opencode", ".gitignore")
  if (existsSync(ruta)) return
  writeFileSync(
    ruta,
    [
      "# GENERADO por ai-engineering-system al instalarse.",
      "#",
      "# Nada de esto se versiona. Son artefactos de UNA máquina concreta: el",
      "# plugin apunta a la política del sistema por ruta absoluta. Y sobre todo,",
      "# no son trabajo de este proyecto: si se versionaran, el control de alcance",
      "# del verificador los leería como archivos que un agente tocó sin permiso.",
      "*",
      "",
    ].join("\n"),
  )
  console.log("  + .gitignore (lo instalado no es trabajo del proyecto)")
}

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
if (!check) console.log(`Instalado en: ${PROYECTO}/.opencode/`)
