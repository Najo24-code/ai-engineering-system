/**
 * Las pruebas del segundo adaptador.
 *
 * Ninguna llama a un modelo. Lo que prueban es la TRADUCCIÓN —que es todo lo que
 * un adaptador es— y, sobre todo, el hook: se instala de verdad en un proyecto
 * temporal y se le mete por stdin la misma forma de llamada que el runtime le
 * manda, medida con una sonda el 2026-08-25.
 *
 * La que más importa es la del gate que no puede leer su entrada. Un gate que
 * ante la duda deja pasar no es un gate roto: es un gate que miente, porque el
 * informe seguirá diciendo que había uno.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..", "..")
const SYNC = join(HERE, "sync.mjs")

/** Un proyecto de verdad, con git, porque el instalador contrasta contra `git ls-files`. */
function proyectoTemporal({ alcance = null, comandos = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aes-cc-"))
  mkdirSync(join(dir, "src"), { recursive: true })
  mkdirSync(join(dir, "tests"), { recursive: true })
  writeFileSync(join(dir, "src", "x.js"), "export const x = 1\n")
  writeFileSync(join(dir, "tests", "x.test.js"), "// t\n")
  writeFileSync(join(dir, "fuera.txt"), "no tocar\n")
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" })
  git("init", "-q")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  git("add", "-A")
  git("commit", "-qm", "init")

  const args = ["--en", dir]
  if (alcance) args.push("--alcance", alcance)
  if (comandos) args.push("--comandos", comandos)
  execFileSync("node", [SYNC, ...args], { stdio: "ignore" })
  return dir
}

/** Le habla al hook como le habla el runtime, y devuelve lo que decidió. */
function preguntarAlHook(dir, llamada) {
  const r = spawnSync("node", [join(dir, ".claude", "hooks", "policy-gate.mjs")], {
    input: typeof llamada === "string" ? llamada : JSON.stringify(llamada),
    encoding: "utf8",
  })
  return { codigo: r.status, motivo: (r.stderr ?? "").trim() }
}

// ── la traducción ───────────────────────────────────────────────────────────

test("los contratos se instalan sin tocar agents/ (G6.2)", () => {
  const dir = proyectoTemporal()
  const build = readFileSync(join(dir, ".claude", "agents", "build.md"), "utf8")
  assert.match(build, /^name: build$/m)
  // Los nombres del OTRO runtime no pueden aparecer: el contrato los dice en
  // neutro y este adaptador es el único sitio que sabe cómo los llama Claude Code.
  assert.match(build, /^tools: .*\bWrite\b.*$/m)
  assert.doesNotMatch(build, /^tools: .*\bwrite\b/m)
})

test("el frontmatter NUNCA emite `memory:`", () => {
  // Verificado aparte: `memory: user` añade Write y Edit en silencio aunque
  // `tools` no los liste. Un agente de solo lectura con memoria no lo es, y nada
  // en su frontmatter lo dice. RECON y REVIEW dejarían de ser de solo lectura.
  const dir = proyectoTemporal()
  for (const id of ["recon", "review", "build", "probe"]) {
    const md = readFileSync(join(dir, ".claude", "agents", `${id}.md`), "utf8")
    assert.doesNotMatch(md, /^memory:/m, `${id} emite memory:`)
  }
})

test("el prompt anuncia las MISMAS fronteras que el gate aplica", () => {
  // El fallo que esto cierra: instalado con --comandos, el gate exigía pytest y
  // el prompt seguía anunciando `npm test`. El agente hizo lo que le dijeron y su
  // propia política lo negó. Eso no es una frontera, es una trampa.
  const dir = proyectoTemporal({ alcance: "src/**", comandos: "pytest -q" })
  const build = readFileSync(join(dir, ".claude", "agents", "build.md"), "utf8")
  const scopes = JSON.parse(readFileSync(join(dir, ".claude", "hooks", "scopes.generated.json"), "utf8"))
  assert.match(build, /`pytest -q`/)
  assert.doesNotMatch(build, /npm test/)
  assert.deepEqual(scopes.agents.build.shell[0], "pytest -q")
})

test("el hook instalado no importa la política por ruta relativa", () => {
  // Un gate que no carga NO AVISA: la corrida sale igual de bien que si estuviera
  // gobernada. Por eso la ruta se resuelve al instalar.
  const dir = proyectoTemporal()
  const hook = readFileSync(join(dir, ".claude", "hooks", "policy-gate.mjs"), "utf8")
  assert.match(hook, new RegExp(JSON.stringify(join(ROOT, "core", "policies", "policy.mjs"))))
  assert.doesNotMatch(hook, /\{\{RUTA_POLITICA\}\}/)
})

// ── el gate, hablándole como le habla el runtime ────────────────────────────

const escribir = (ruta) => ({ hook_event_name: "PreToolUse", tool_name: "Write", cwd: "CWD", tool_input: { file_path: ruta } })

test("escribir DENTRO del alcance se permite", () => {
  const dir = proyectoTemporal()
  const r = preguntarAlHook(dir, { ...escribir(join(dir, "src", "nuevo.js")), cwd: dir })
  assert.equal(r.codigo, 0, `debió permitir y dijo: ${r.motivo}`)
})

test("escribir FUERA del alcance se niega, y el motivo nombra la regla", () => {
  const dir = proyectoTemporal()
  const r = preguntarAlHook(dir, { ...escribir(join(dir, "fuera.txt")), cwd: dir })
  assert.equal(r.codigo, 2)
  assert.match(r.motivo, /A-ALCANCE/)
})

test("un comando fuera de la lista se niega", () => {
  const dir = proyectoTemporal()
  const r = preguntarAlHook(dir, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    cwd: dir,
    tool_input: { command: "curl https://ejemplo.com" },
  })
  assert.equal(r.codigo, 2)
  assert.match(r.motivo, /A-COMANDO/)
})

test("una herramienta que el adaptador no sabe traducir se niega por defecto", () => {
  const dir = proyectoTemporal()
  const r = preguntarAlHook(dir, { hook_event_name: "PreToolUse", tool_name: "WebFetch", cwd: dir, tool_input: {} })
  assert.equal(r.codigo, 2)
  assert.match(r.motivo, /tool_map/)
})

test("una entrada ilegible se NIEGA; un gate que ante la duda deja pasar miente", () => {
  const dir = proyectoTemporal()
  const r = preguntarAlHook(dir, "esto no es json")
  assert.equal(r.codigo, 2)
  assert.match(r.motivo, /no se puede leer/)
})
