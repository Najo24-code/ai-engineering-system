#!/usr/bin/env node
/**
 * El SEGUNDO adaptador de runtime. La Fase 6 empieza aquí.
 *
 * El encargo, dicho por quien usa esto: que el sistema sea su flujo de trabajo
 * **en cualquier IDE y con cualquier IA**. La mitad de "cualquier IA" la resolvió
 * el relevo de proveedores. Esta es la otra mitad, y es la que de verdad prueba
 * si los contratos de `agents/` son contratos o son configuración de OpenCode con
 * otro nombre.
 *
 * La prueba es incómoda a propósito y está escrita como gate: **G6.2 — cambiar de
 * runtime no exige tocar `agents/`.** Este archivo no puede pedir ni un campo
 * nuevo a los contratos. Si lo necesitara, el problema no sería este adaptador:
 * sería que `agents/` nunca fue neutral.
 *
 * Lo que cambia entre runtimes es la TRADUCCIÓN —cómo se llaman las herramientas,
 * dónde vive la configuración, cómo se niega una llamada— y vive en
 * `runtime.json`, medido con una sonda. Lo que NO cambia es quién juzga: los dos
 * gates llaman a `core/policies/policy.mjs`. Dos copias de la política serían dos
 * sistemas parecidos, no uno portable.
 *
 * Uso:
 *   node runtimes/claude-code/sync.mjs --en <proyecto> [--alcance "src/**"] [--comandos "npm test"]
 */
import { versionInstalada, compararVersion } from "../version.mjs"
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { coincideGlob } from "../../core/policies/policy.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..", "..")
const AGENTS_DIR = join(ROOT, "agents")
const RT = JSON.parse(readFileSync(join(HERE, "runtime.json"), "utf8"))

const arg = (bandera) => {
  const i = process.argv.indexOf(bandera)
  if (i === -1) return null
  const v = process.argv[i + 1]
  if (!v || v.startsWith("--")) {
    console.error(`${bandera} necesita un valor`)
    process.exit(2)
  }
  return v
}
const listaArg = (b) => arg(b)?.split(",").map((x) => x.trim()).filter(Boolean) ?? null

const rutaProyecto = arg("--en")
if (!rutaProyecto) {
  console.error('uso: sync.mjs --en <proyecto> [--alcance "src/**"] [--comandos "npm test"]')
  process.exit(2)
}
const PROYECTO = rutaProyecto.startsWith("/") ? rutaProyecto : join(process.cwd(), rutaProyecto)
const ALCANCE = listaArg("--alcance")
const COMANDOS = listaArg("--comandos")

const DESTINO = join(PROYECTO, ".claude")
const problemas = []
const fail = (id, m) => problemas.push(`${id}: ${m}`)

const listaEnPrompt = (xs) => (xs.length ? xs.map((x) => `\`${x}\``).join(", ") : "ningún sitio")

/** El contrato nombra herramientas en neutro; aquí se traducen. Solo aquí. */
function traducirTools(allow, id) {
  return allow.map((t) => {
    const propio = RT.tool_map[t]
    // Una herramienta que este runtime no tiene NO se omite en silencio: omitirla
    // daría un agente que parece el mismo y puede menos, y nadie lo sabría.
    if (!propio) fail(id, `pide la herramienta "${t}", que no está en el tool_map de ${RT.runtime}`)
    return propio
  })
}

const ids = readdirSync(AGENTS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)

const scopes = {}
const rendered = ids.map((id) => {
  const contract = JSON.parse(readFileSync(join(AGENTS_DIR, id, "agent.json"), "utf8"))
  if (contract.id !== id) fail(id, `el campo id dice "${contract.id}" pero la carpeta se llama "${id}"`)
  for (const campo of ["read", "write", "shell"]) {
    if (!Array.isArray(contract.scope?.[campo])) {
      fail(id, `scope.${campo} falta o no es una lista; el gate no puede aplicar un alcance que nadie declaró`)
    }
  }

  const write = ALCANCE && contract.scope.write.length ? ALCANCE : contract.scope.write
  const shell =
    COMANDOS && contract.scope.shell.length
      ? [...COMANDOS, ...contract.scope.shell.filter((c) => c.startsWith("git "))]
      : contract.scope.shell
  scopes[id] = { write, shell }

  const modelo = RT.model_map[contract.model.preferred]
  if (!modelo) {
    fail(id, `pide el modelo "${contract.model.preferred}", que no está en el model_map de ${RT.runtime}`)
  }

  let prompt = readFileSync(join(AGENTS_DIR, id, "prompt.md"), "utf8").trimEnd()
  for (const [marca, clave] of [
    ["{{ALCANCE_ESCRITURA}}", "write"],
    ["{{COMANDOS_PERMITIDOS}}", "shell"],
  ]) {
    if (!prompt.includes(marca) && scopes[id][clave].length) {
      fail(id, `su prompt.md no lleva ${marca}: anunciaría fronteras distintas de las que el gate aplica`)
    }
    prompt = prompt.split(marca).join(listaEnPrompt(scopes[id][clave]))
  }

  const front = [
    "---",
    "# GENERADO por runtimes/claude-code/sync.mjs — no editar a mano.",
    `# Fuente: agents/${id}/agent.json + agents/${id}/prompt.md`,
    `name: ${id}`,
    `description: ${JSON.stringify(contract.purpose)}`,
    `tools: ${traducirTools(contract.tools.allow, id).join(", ")}`,
    `model: ${modelo ?? "SIN-RESOLVER"}`,
    // Sin `memory:` a propósito: añade Write y Edit en silencio, aunque `tools`
    // no los liste. Un agente de solo lectura con memoria no es de solo lectura.
    "---",
    "",
    prompt,
    "",
  ]
  return { id, out: front.join("\n") }
})

if (problemas.length) {
  console.error(`El contrato no es válido para ${RT.runtime}:`)
  for (const p of problemas) console.error(`  - ${p}`)
  console.error("\nNo se escribió nada. Media instalación parece configuración buena.")
  process.exit(2)
}

// El hook se GENERA: su ruta a la política tiene que ser absoluta o no carga, y un
// gate que no carga no avisa.
const hook = readFileSync(join(HERE, "hooks", "policy-gate.mjs"), "utf8").replace(
  '"{{RUTA_POLITICA}}"',
  JSON.stringify(join(ROOT, "core", "policies", "policy.mjs")),
)
if (!hook.includes(JSON.stringify(join(ROOT, "core", "policies", "policy.mjs")))) {
  console.error("El hook ya no lleva {{RUTA_POLITICA}}; instalarlo dejaría un gate que no carga.")
  process.exit(2)
}

const ajustes = {
  $comment: "GENERADO por runtimes/claude-code/sync.mjs — no editar a mano.",
  hooks: {
    PreToolUse: [
      {
        matcher: [RT.tool_map.write, RT.tool_map.edit, RT.tool_map.bash].join("|"),
        hooks: [{ type: "command", command: `$CLAUDE_PROJECT_DIR/.claude/hooks/policy-gate.mjs` }],
      },
    ],
  },
}

const archivos = [
  ...rendered.map((r) => ({ ruta: join(DESTINO, "agents", `${r.id}.md`), out: r.out })),
  { ruta: join(DESTINO, "hooks", "policy-gate.mjs"), out: hook, ejecutable: true },
  { ruta: join(DESTINO, "hooks", "runtime.json"), out: readFileSync(join(HERE, "runtime.json"), "utf8") },
  {
    ruta: join(DESTINO, "hooks", "scopes.generated.json"),
    out: JSON.stringify({ $comment: "GENERADO. Lo lee el hook en cada llamada.", agents: scopes }, null, 2) + "\n",
  },
  { ruta: join(DESTINO, "settings.json"), out: JSON.stringify(ajustes, null, 2) + "\n" },
  {
    ruta: join(DESTINO, ".gitignore"),
    out:
      "# GENERADO por ai-engineering-system al instalarse.\n#\n" +
      "# Nada de esto se versiona: son artefactos de UNA máquina (el hook apunta a\n" +
      "# la política por ruta absoluta) y no son trabajo de este proyecto. Si se\n" +
      "# versionaran, el control de alcance los leería como archivos que un agente\n" +
      "# tocó sin permiso.\n*\n",
  },
]

for (const a of archivos) {
  mkdirSync(dirname(a.ruta), { recursive: true })
  writeFileSync(a.ruta, a.out, a.ejecutable ? { mode: 0o755 } : undefined)
}

// Mismo control que el otro adaptador: un alcance que no encaja con nada no es una
// instalación que funcione, es una que se descubre rota en mitad de una corrida.
let versionados = null
try {
  versionados = execFileSync("git", ["-C", PROYECTO, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean)
} catch {}
const huerfanos = []
if (versionados) {
  for (const [id, s] of Object.entries(scopes)) {
    for (const patron of s.write) {
      if (!versionados.some((f) => coincideGlob(patron, f))) huerfanos.push({ id, patron })
    }
  }
}
if (huerfanos.length) {
  console.log("\n🔴 El alcance de escritura no encaja con este proyecto:")
  for (const h of huerfanos) console.log(`  ${h.id}: "${h.patron}" no coincide con ningún archivo versionado`)
  console.log(`\n  Pásale --alcance y --comandos, o el gate negará toda escritura.\n`)
}

// La versión que hay puesta, comparada con aquella contra la que se midieron los
// hechos de runtime.json. El porqué largo está en runtimes/version.mjs.
const cmdVersion = (RT.version_cmd ?? []).map((a) => a.replace("{HOME}", process.env.HOME ?? ""))
const versiones = compararVersion({
  runtime: RT.runtime,
  instalada: versionInstalada(cmdVersion),
  verificada: RT.verified_version,
})
console.log(`\n${ids.length} agente(s) sincronizado(s) · ${versiones.linea}`)
if (versiones.aviso) console.log(`⚠️  ${versiones.aviso}`)
console.log(`Instalado en: ${DESTINO}/`)
console.log(`\nFronteras: hook PreToolUse sobre ${ajustes.hooks.PreToolUse[0].matcher}, negando con código 2.`)
