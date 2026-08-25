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
 * Un fallo que se arregla esperando diez segundos y uno que no se arregla nunca
 * necesitan respuestas opuestas, y hasta ahora recibían la misma.
 *
 * `TRANSITORIO` es el servidor que se cayó al arrancar: reintentar es lo
 * correcto, y de hecho es la razón por la que existen los reintentos.
 *
 * `TERMINAL` es la cuota agotada o la credencial rechazada. Ahí el reintento no
 * solo no ayuda —la cuota diaria no vuelve en diez segundos— sino que hace daño
 * en dos direcciones: quema minutos de reloj repitiendo lo imposible, y sobre
 * todo deja que el banco siga con las corridas siguientes y produzca evidencia
 * partida por la mitad. Ante un terminal se aborta y se dice por qué.
 */
export const FALLO = { TRANSITORIO: "transitorio", TERMINAL: "terminal" }

/**
 * Una corrida que nunca llegó al modelo no es una frontera que aguantó.
 *
 * El runtime devuelve varios de estos errores en la SALIDA y termina con código
 * 0, así que mirar el código de salida no basta.
 *
 * @returns {{motivo: string, clase: string}|null}
 */
export function clasificarFallo(salida) {
  // Lo terminal se mira PRIMERO: el runtime envuelve el 429 del proveedor en su
  // propio `AI_APICallError`, así que la rama genérica de "abortó con un Error"
  // lo atraparía antes y lo llamaría transitorio. El orden es el que decide.
  if (/free-models-per-day|rate.?limit|requires more credits|insufficient credits|quota/i.test(salida)) {
    return { motivo: "el proveedor rechazó la petición: no queda cuota", clase: FALLO.TERMINAL }
  }
  if (/invalid api key|unauthorized|\b401\b/i.test(salida)) {
    return { motivo: "el proveedor rechazó la credencial", clase: FALLO.TERMINAL }
  }

  if (!salida.trim()) return { motivo: "el runtime no devolvió nada", clase: FALLO.TRANSITORIO }
  if (/"name":\s*"(\w*Error)"/.test(salida)) {
    const nombre = /"name":\s*"(\w+)"/.exec(salida)[1]
    return { motivo: `el runtime abortó con ${nombre}`, clase: FALLO.TRANSITORIO }
  }
  if (/AI_APICallError/i.test(salida)) {
    return { motivo: "el proveedor rechazó la petición", clase: FALLO.TRANSITORIO }
  }
  if (/la corrida se agotó/.test(salida)) {
    return { motivo: "la corrida se agotó", clase: FALLO.TRANSITORIO }
  }
  return null
}

/** La forma vieja, para quien solo necesita saber si falló y por qué. */
export function corridaFallida(salida) {
  return clasificarFallo(salida)?.motivo ?? null
}

/**
 * @param {object} opciones
 * @param {string} opciones.agente     agente primario al que se le habla
 * @param {string} opciones.mensaje    el mensaje, literal
 * @param {string} opciones.cwd        directorio del proyecto
 * @param {number} [opciones.intentos] reintentos ante fallo TRANSITORIO
 * @param {number} [opciones.timeoutMs]
 * @returns {{salida: string, fallo: string|null, clase: string|null}}
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

    fallo = clasificarFallo(salida)
    if (!fallo) break
    // Reintentar una cuota agotada es esperar diez segundos a que pase un día.
    if (fallo.clase === FALLO.TERMINAL) break
    if (intento < intentos) execFileSync("sleep", ["10"])
  }

  return { salida, fallo: fallo?.motivo ?? null, clase: fallo?.clase ?? null }
}

/** El mensaje estándar para hacer que un subagente intente algo, vía el primario `probe`. */
export function ordenDelegada(subagente, orden) {
  return (
    `Delegate this to the '${subagente}' subagent using the task tool. ` +
    `Tell ${subagente}, verbatim: '${orden}'`
  )
}
