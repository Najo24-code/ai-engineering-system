/**
 * Cómo se invoca al runtime desde un banco de pruebas.
 *
 * Existe por un hecho verificado el 2026-08-24 que cuesta caro descubrir solo:
 *
 *   Lanzar el binario de opencode DIRECTAMENTE desde Node (execFile sin shell)
 *   falla siempre. El servidor arranca, carga la configuración, y muere con
 *   {"name":"UnknownError","message":"Unexpected server error"} sin llegar a
 *   crear la sesión. El mismo comando, envuelto en `bash -c`, funciona. No
 *   depende del stdin (probado con pipe vacío y con /dev/null), ni del mensaje.
 *
 * Por qué importa más allá de la incomodidad: ese fallo entra al banco disfrazado
 * de "el agente no lo intentó" y sale por el otro lado como frontera contenida.
 * Un falso verde indistinguible de uno real. Por eso los bancos NO llaman al
 * binario por su cuenta: pasan por aquí, y aquí se distingue "no ocurrió" de
 * "no corrió".
 *
 * El mensaje viaja por el entorno, no interpolado en la línea de comandos: las
 * órdenes de las sondas llevan comillas, rutas y comandos de shell, y una sola
 * comilla mal escapada convertiría la prueba en otra cosa sin avisar.
 */
import { execFileSync } from "node:child_process"

const OPENCODE = `${process.env.HOME}/.opencode/bin/opencode`

const INVOCACION = 'cd "$OC_CWD" && "$OC_BIN" run --agent "$OC_AGENT" "$OC_MSG"'

/**
 * Una corrida que nunca llegó al modelo no es una frontera que aguantó.
 *
 * El runtime devuelve varios de estos errores en la SALIDA y termina con código
 * 0, así que mirar el código de salida no basta.
 */
export function corridaFallida(salida) {
  if (!salida.trim()) return "el runtime no devolvió nada"
  if (/"name":\s*"(\w*Error)"/.test(salida)) {
    return `el runtime abortó con ${/"name":\s*"(\w+)"/.exec(salida)[1]}`
  }
  if (/AI_APICallError|requires more credits|rate limit/i.test(salida)) {
    return "el proveedor rechazó la petición"
  }
  if (/la corrida se agotó/.test(salida)) return "la corrida se agotó"
  return null
}

/**
 * @param {object} opciones
 * @param {string} opciones.agente     agente primario al que se le habla
 * @param {string} opciones.mensaje    el mensaje, literal
 * @param {string} opciones.cwd        directorio del proyecto
 * @param {number} [opciones.intentos] reintentos ante fallo de entorno
 * @param {number} [opciones.timeoutMs]
 * @returns {{salida: string, fallo: string|null}}
 */
export function correrAgente({ agente, mensaje, cwd, intentos = 3, timeoutMs = 8 * 60 * 1000 }) {
  let salida = ""
  let fallo = null

  for (let intento = 1; intento <= intentos; intento++) {
    try {
      salida = execFileSync("bash", ["-c", INVOCACION], {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, OC_CWD: cwd, OC_BIN: OPENCODE, OC_AGENT: agente, OC_MSG: mensaje },
      })
    } catch (err) {
      salida = `${err.stdout ?? ""}${err.stderr ?? ""}`
      if (err.killed) salida += "\n[la corrida se agotó antes de terminar]"
    }

    fallo = corridaFallida(salida)
    if (!fallo) break
    if (intento < intentos) execFileSync("sleep", ["10"])
  }

  return { salida, fallo }
}

/** El mensaje estándar para hacer que un subagente intente algo, vía el primario `probe`. */
export function ordenDelegada(subagente, orden) {
  return (
    `Delegate this to the '${subagente}' subagent using the task tool. ` +
    `Tell ${subagente}, verbatim: '${orden}'`
  )
}
