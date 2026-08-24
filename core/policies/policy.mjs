/**
 * La frontera de escritura. Neutral respecto al runtime.
 *
 * Este archivo no sabe qué es OpenCode. Recibe una llamada de herramienta ya
 * normalizada y devuelve un veredicto. El adaptador del runtime se encarga de
 * traducir y de APLICARLO; si nadie lo aplica, esto es un ensayo, no una política
 * (regla dura del proyecto: sin prueba de cableado, no está implementada).
 *
 * Dos niveles, y el orden importa:
 *
 *   UNIVERSAL  se aplica a todo el mundo, tenga contrato o no: secretos, estado
 *              de git, comandos destructivos, rutas fuera del proyecto. Son daños
 *              que ningún agente tiene motivo legítimo para causar.
 *
 *   DE ALCANCE se aplica solo a los agentes que declaran un contrato. Un agente
 *              sin contrato no queda sin gobierno: le siguen aplicando las
 *              universales. Simplemente no se le inventa un alcance que nadie
 *              declaró.
 *
 * Las negaciones ganan siempre. Estar dentro del alcance no habilita tocar un .env.
 */

/** Herramientas que no modifican nada. La frontera de lectura es del mapa `tools`. */
const SOLO_LECTURA = new Set([
  "read",
  "glob",
  "grep",
  "todowrite",
  "question",
  "skill",
  "webfetch",
  "task",
  "invalid",
])

/** Rutas que nadie edita como parte de su trabajo, esté en su alcance o no. */
const RUTAS_PROHIBIDAS = [
  "**/.env",
  "**/.env.*",
  "**/.git/**",
  "**/.github/workflows/**",
  "**/.ssh/**",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/id_rsa*",
  "**/credentials*",
  "**/secrets*",
  "**/.npmrc",
  "**/.netrc",
  "**/.opencode/**",
]

/** La excepción explícita: el ejemplo existe justamente para versionarse. */
const RUTAS_EXENTAS = ["**/.env.example"]

/**
 * Git reescribe historia y publica. Un agente que la altera hace daño fuera de
 * la máquina, donde ya no se deshace revirtiendo un archivo.
 */
const GIT_PROHIBIDO =
  /\bgit\s+(commit|push|reset|rebase|merge|cherry-pick|revert|tag|remote|filter-branch|am|apply|restore|switch|checkout|branch|clean|stash|worktree|gc|prune|reflog|update-ref|fetch|pull|submodule|config)\b/

const DESTRUCTIVO = [
  /^\s*rm\s+-[a-z]*[rf]/,
  /^\s*mkfs\./,
  /^\s*fdisk\s/,
  /^\s*dd\s+if=/,
  /^\s*shutdown\b/,
  /^\s*reboot\b/,
  /chmod\s+-R\s+777/,
  /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b/,
  /\bwget\b[^|]*\|\s*(sh|bash|zsh)\b/,
]

/**
 * Encadenar es evadir: "npm test; rm -rf ." pasa cualquier lista de permitidos
 * que mire solo el principio del comando. Si aparece un metacarácter, el comando
 * deja de ser analizable y se niega. Preferimos negar algo legítimo a permitir
 * algo que no supimos leer.
 */
const ENCADENA = new RegExp("[;&|`<>]|\\$\\(|\\n")

const ESCAPE = /[.+^${}()|[\]\\]/g

/** Glob mínimo: "**" cruza separadores, "*" no, "?" es un carácter. */
export function coincideGlob(patron, ruta) {
  const rx = patron
    .replace(ESCAPE, "\\$&")
    .replace(/\*\*\//g, " SLASH ")
    .replace(/\*\*/g, " ANY ")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/ SLASH /g, "(?:.*/)?")
    .replace(/ ANY /g, ".*")
  return new RegExp(`^${rx}$`).test(ruta)
}

const coincideAlguno = (patrones, ruta) => patrones.some((p) => coincideGlob(p, ruta))

/**
 * "a/../../etc/passwd" y "/etc/passwd" son el mismo intento con distinta cara.
 * Se resuelve a una ruta relativa a la raíz; si sale del proyecto, devuelve null.
 */
export function normalizarRuta(raiz, ruta) {
  if (!ruta) return null
  const abs = ruta.startsWith("/") ? ruta : `${raiz}/${ruta}`
  const partes = []
  for (const seg of abs.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") partes.pop()
    else partes.push(seg)
  }
  const resuelta = `/${partes.join("/")}`
  const base = raiz.endsWith("/") ? raiz.slice(0, -1) : raiz
  if (resuelta !== base && !resuelta.startsWith(`${base}/`)) return null
  return resuelta.slice(base.length + 1)
}

const niega = (regla, motivo) => ({ action: "deny", rule: regla, reason: motivo })
const permite = (regla) => ({ action: "allow", rule: regla, reason: null })

function juzgarRuta(rutaRel, cruda, contrato) {
  if (rutaRel === null) {
    return niega("U-FUERA", `la ruta "${cruda}" queda fuera del proyecto`)
  }
  if (coincideAlguno(RUTAS_PROHIBIDAS, rutaRel) && !coincideAlguno(RUTAS_EXENTAS, rutaRel)) {
    return niega("U-SECRETO", `"${rutaRel}" es configuración sensible o credencial`)
  }
  if (!contrato) return permite("SIN-CONTRATO")

  const alcance = contrato.write ?? []
  if (alcance.length === 0) {
    return niega("A-SOLO-LECTURA", "el contrato no declara ninguna ruta de escritura")
  }
  if (!coincideAlguno(alcance, rutaRel)) {
    return niega("A-ALCANCE", `"${rutaRel}" está fuera del alcance declarado (${alcance.join(", ")})`)
  }
  return permite("A-ALCANCE")
}

function juzgarComando(cmd, contrato) {
  const texto = (cmd ?? "").trim()
  if (!texto) return niega("U-VACIO", "comando vacío")

  for (const rx of DESTRUCTIVO) {
    if (rx.test(texto)) return niega("U-DESTRUCTIVO", `el comando coincide con un patrón destructivo: ${rx}`)
  }
  if (GIT_PROHIBIDO.test(texto)) {
    return niega("U-GIT", "altera el estado de git; eso lo decide una persona")
  }
  if (!contrato) return permite("SIN-CONTRATO")

  const permitidos = contrato.shell ?? []
  if (permitidos.length === 0) {
    return niega("A-SIN-SHELL", "el contrato no declara ningún comando permitido")
  }
  if (ENCADENA.test(texto)) {
    return niega("A-ENCADENA", "el comando encadena o redirige; deja de ser analizable")
  }
  if (!permitidos.some((p) => texto === p || texto.startsWith(`${p} `))) {
    return niega("A-COMANDO", `"${texto}" no está en la lista de comandos declarados`)
  }
  return permite("A-COMANDO")
}

/**
 * @param {object} llamada
 * @param {string} llamada.tool           herramienta invocada
 * @param {object} llamada.args           argumentos tal como llegan del runtime
 * @param {string} llamada.root           raíz del proyecto (ruta absoluta)
 * @param {object|null} llamada.contract  { write: string[], shell: string[] } o null
 */
export function decidir({ tool, args = {}, root, contract = null }) {
  if (SOLO_LECTURA.has(tool)) return permite("LECTURA")

  if (tool === "bash") return juzgarComando(args.command, contract)

  if (tool === "write" || tool === "edit" || tool === "patch") {
    const cruda = args.filePath ?? args.path ?? args.file
    if (!cruda) return niega("U-OPACO", `${tool} sin ruta reconocible en los argumentos`)
    return juzgarRuta(normalizarRuta(root, cruda), cruda, contract)
  }

  // Una herramienta que no sabemos leer no se aprueba por no saber leerla.
  return niega("U-DESCONOCIDA", `la herramienta "${tool}" no tiene regla; se niega por defecto`)
}
