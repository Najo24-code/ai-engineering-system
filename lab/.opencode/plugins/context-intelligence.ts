import { tool } from "@opencode-ai/plugin"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

const HOME = process.env.HOME ?? ""
const BRIEFING_DIR = path.join(HOME, "briefing")
const DAILY_DIR = path.join(HOME, "Documentos", "daily hp")

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8")
  } catch {
    return ""
  }
}

async function recentFiles(
  directory: string,
  pattern: RegExp,
  limit = 5,
): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })

    return entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, limit)
  } catch {
    return []
  }
}

function clip(text: string, max = 12000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[CONTEXTO RECORTADO]`
}

export const ContextIntelligence = async () => {
  return {
    tool: {
      context_briefing: tool({
        description:
          "Recupera el briefing operativo reciente. Es contexto potencialmente stale y nunca sustituye la evidencia actual del repositorio.",
        args: {},
        async execute() {
          const files = await recentFiles(
            BRIEFING_DIR,
            /^\d{4}-\d{2}-\d{2}(?:-cierre)?\.md$/,
            3,
          )

          if (!files.length) {
            return "UNKNOWN: no hay briefings disponibles."
          }

          const sections = []

          for (const file of files) {
            const content = await readText(path.join(BRIEFING_DIR, file))

            if (content) {
              sections.push(
                `## DOCUMENTED — ${file}\n\n${clip(content, 6000)}`,
              )
            }
          }

          return sections.length
            ? sections.join("\n\n---\n\n")
            : "UNKNOWN: los archivos de briefing no pudieron leerse."
        },
      }),

      context_daily: tool({
        description:
          "Recupera dailys recientes relacionados con el trabajo de Cincinnatus/PTD.",
        args: {
          project: tool.schema
            .string()
            .optional()
            .describe(
              "Proyecto o palabra clave. Ejemplos: inventario, carnet, asistencia, PTD.",
            ),
        },
        async execute(args) {
          const keyword = args.project?.toLowerCase()

          const files = await recentFiles(
            DAILY_DIR,
            /\.md$/,
            50,
          )

          const selected = keyword
            ? files.filter((file) => file.toLowerCase().includes(keyword))
            : files.filter((file) =>
                file.toLowerCase().startsWith("cincinnatus-ptd-"),
              )

          const limited = selected.slice(0, 5)

          if (!limited.length) {
            return `UNKNOWN: no encontré dailys relevantes para ${
              keyword ?? "PTD"
            }.`
          }

          const sections = []

          for (const file of limited) {
            const content = await readText(path.join(DAILY_DIR, file))

            if (content) {
              sections.push(
                `## DOCUMENTED — ${file}\n\n${clip(content, 7000)}`,
              )
            }
          }

          return sections.join("\n\n---\n\n")
        },
      }),

      context_search: tool({
        description:
          "Busca contexto histórico relevante en briefing y dailys sin cargar todo el historial.",
        args: {
          query: tool.schema
            .string()
            .describe("Tema, proyecto, ticket, PR o término que se quiere investigar."),
        },
        async execute(args) {
          const query = args.query.toLowerCase()
          const terms = query
            .split(/\s+/)
            .map((term) => term.trim())
            .filter((term) => term.length >= 3)

          const files = [
            ...(await recentFiles(
              BRIEFING_DIR,
              /^\d{4}-\d{2}-\d{2}(?:-cierre)?\.md$/,
              10,
            )).map((name) => ({
              dir: BRIEFING_DIR,
              name,
              source: "briefing",
            })),
            ...(await recentFiles(
              DAILY_DIR,
              /\.md$/,
              50,
            )).map((name) => ({
              dir: DAILY_DIR,
              name,
              source: "daily",
            })),
          ]

          const matches: Array<{
            score: number
            source: string
            name: string
            excerpt: string
          }> = []

          for (const file of files) {
            const content = await readText(path.join(file.dir, file.name))
            if (!content) continue

            const lower = content.toLowerCase()

            const score = terms.reduce(
              (total, term) => total + (lower.includes(term) ? 1 : 0),
              0,
            )

            if (!score) continue

            const firstTerm = terms.find((term) => lower.includes(term))
            const index = firstTerm ? lower.indexOf(firstTerm) : 0

            const start = Math.max(0, index - 1200)
            const end = Math.min(content.length, index + 3500)

            matches.push({
              score,
              source: file.source,
              name: file.name,
              excerpt: content.slice(start, end),
            })
          }

          matches.sort((a, b) => b.score - a.score)

          if (!matches.length) {
            return `UNKNOWN: no encontré contexto histórico relevante para "${args.query}".`
          }

          return matches
            .slice(0, 5)
            .map(
              (match) =>
                `## ${match.source.toUpperCase()} — ${match.name} — score ${match.score}\n\n${clip(match.excerpt, 5000)}`,
            )
            .join("\n\n---\n\n")
        },
      }),
    },
  }
}

export default ContextIntelligence
