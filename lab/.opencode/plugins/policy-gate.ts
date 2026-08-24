/**
 * POLICY GATE — el cableado de la política al runtime de OpenCode.
 *
 * Este archivo no decide nada. La decisión vive en core/policies/policy.mjs,
 * que no sabe qué runtime lo llama. Aquí solo se hace lo específico de OpenCode:
 * averiguar QUIÉN llama, traducir los argumentos, y APLICAR el veredicto.
 *
 * Dónde se aplica, y por qué ahí (verificado el 2026-08-24, opencode 1.18.18):
 *
 *   'permission.ask' NO SIRVE. No se dispara nunca, ni siquiera con el agente
 *   declarando `permission: {edit: ask, bash: ask, write: ask}`. La corrida se
 *   queda esperando una aprobación que en modo no interactivo nadie puede dar,
 *   y el plugin jamás ve el evento. La versión anterior de este archivo apostaba
 *   a ese hook y por eso su política no se aplicó nunca (H-01).
 *
 *   'tool.execute.before' SÍ SIRVE: lanzar desde aquí ABORTA la herramienta.
 *   Comprobado con control positivo en la misma corrida — se interceptó 'write'
 *   y se dejó 'bash' libre: el archivo de 'write' nunca apareció (el agente
 *   reintentó y volvió a fallar) y el de 'bash' sí. Además llegan los argumentos
 *   completos (filePath, command, workdir), que es lo que permite una política
 *   por ruta y por comando en vez de un sí/no por herramienta.
 *
 * Fallar cerrado: si algo de esto se rompe —no se resuelve el agente, el archivo
 * de alcances no carga, la decisión lanza— se niega. Un portero que ante la duda
 * abre no es un portero.
 */
import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { decidir } from "../../../core/policies/policy.mjs"

type Contrato = { write: string[]; shell: string[] }

const ARCHIVO_ALCANCES = "scopes.generated.json"
const REGISTRO = ".policy-gate.jsonl"

export const PolicyGate = async ({ directory }: any) => {
  const raiz: string = directory
  const registro = join(raiz, REGISTRO)

  let contratos: Record<string, Contrato> = {}
  let cargaFallida: string | null = null
  try {
    const crudo = readFileSync(join(raiz, ".opencode", ARCHIVO_ALCANCES), "utf8")
    contratos = JSON.parse(crudo).agents ?? {}
  } catch (e: any) {
    // No se puede negar todo por esto —dejaría el runtime inservible— pero
    // tampoco puede pasar inadvertido: sin alcances solo quedan las universales.
    cargaFallida = e?.message ?? String(e)
    console.error(`[policy-gate] sin ${ARCHIVO_ALCANCES}: solo aplican las reglas universales (${cargaFallida})`)
  }

  /**
   * OpenCode no dice qué agente hace la llamada. Lo dice de refilón: cada
   * mensaje de asistente trae su sessionID y su 'mode', que es el nombre del
   * agente, y los subagentes tienen sessionID propio. Se cachea de ahí.
   */
  const agentePorSesion = new Map<string, string>()

  const anotar = (registroLinea: object) => {
    try {
      appendFileSync(registro, JSON.stringify({ t: new Date().toISOString(), ...registroLinea }) + "\n")
    } catch (e) {
      // Un auditor que se traga sus errores deja un registro que parece completo
      // y no lo está. Que se vea, aunque no se pueda escribir.
      console.error("[policy-gate] no pudo registrar la decisión:", e)
    }
  }

  return {
    event: async ({ event }: any) => {
      if (event?.type === "message.updated" && event.properties?.info?.role === "assistant") {
        const info = event.properties.info
        if (info.sessionID && info.mode) agentePorSesion.set(info.sessionID, info.mode)
      }
    },

    "tool.execute.before": async (input: any, output: any) => {
      const agente = agentePorSesion.get(input.sessionID) ?? null
      const contrato = agente ? (contratos[agente] ?? null) : null

      let veredicto
      try {
        veredicto = decidir({ tool: input.tool, args: output.args ?? {}, root: raiz, contract: contrato })
      } catch (e: any) {
        veredicto = { action: "deny", rule: "GATE-ERROR", reason: `la política falló al decidir: ${e?.message}` }
      }

      if (veredicto.action !== "deny") return

      anotar({
        decision: "deny",
        agente,
        conContrato: Boolean(contrato),
        tool: input.tool,
        regla: veredicto.rule,
        motivo: veredicto.reason,
        args: output.args,
        sessionID: input.sessionID,
        callID: input.callID,
      })

      throw new Error(
        `POLICY GATE [${veredicto.rule}]: ${veredicto.reason}. ` +
          `Esta frontera la impone el sistema, no el prompt: no la puedes rodear. ` +
          `Si el trabajo la necesita de verdad, dilo en tu reporte y que lo decida una persona.`,
      )
    },
  }
}

export default PolicyGate
