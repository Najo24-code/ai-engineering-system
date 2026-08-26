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
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const OPENCODE = `${process.env.HOME}/.opencode/bin/opencode`
const CATALOGO = join(dirname(fileURLToPath(import.meta.url)), "..", "providers", "catalogo.json")

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
/**
 * Si el informe del primario está COMPLETO, la corrida llegó al modelo.
 *
 * El contrato de `probe` obliga a cerrar con la sección `Resultado`, y ese
 * cierre solo lo puede escribir un agente que corrió. Es evidencia positiva, y
 * por eso gana a cualquier frase que aparezca dentro del informe.
 *
 * Sin esto, el clasificador no distingue la voz del RUNTIME de la prosa del
 * AGENTE, porque las dos llegan por el mismo canal y en el mismo texto. El
 * 2026-08-26 eso tiró un dictamen entero de REVIEW: en su tabla de evidencia
 * había una cita de líneas, `detectores.py:394-401`, y `\b401\b` la leyó como
 * una credencial rechazada. Clasificado TERMINAL, que además aborta sin
 * reintentar. El único agente cuyo trabajo ES citar archivo:línea era el que no
 * podía citar un rango acabado en 401.
 */
export function informeCompleto(salida) {
  return /^##\s*Resultado\s*$/m.test(salida) && /EL AGENTE DIJO QUE (LO HIZO|NO PUDO)/.test(salida)
}

export function clasificarFallo(salida) {
  // Lo primero de todo: si hay informe completo, hubo corrida. Lo que venga
  // después son frases DENTRO del trabajo del agente, no errores del proveedor.
  if (informeCompleto(salida)) return null

  // Lo terminal se mira PRIMERO: el runtime envuelve el 429 del proveedor en su
  // propio `AI_APICallError`, así que la rama genérica de "abortó con un Error"
  // lo atraparía antes y lo llamaría transitorio. El orden es el que decide.
  if (/free-models-per-day|rate.?limit|requires more credits|insufficient credits|quota/i.test(salida)) {
    return { motivo: "el proveedor rechazó la petición: no queda cuota", clase: FALLO.TERMINAL }
  }
  // El 401 se exige con forma de HTTP. Un número suelto no es un estado: en una
  // salida a medias, `foo.py:394-401` o `line 401` volverían a disparar esto.
  // Riesgo que queda escrito en vez de escondido: "rate limit" y "quota" siguen
  // siendo palabras que un agente puede escribir sobre el código que revisa. En
  // una corrida COMPLETA ya no importan —manda `informeCompleto`—; en una a
  // medias, sí. Se arreglará cuando haya un caso medido, no antes.
  if (/invalid api key|401\s+unauthorized|\bunauthorized\b|status(?:_?code)?"?\s*[:=]\s*401\b|HTTP\/?[\d.]*\s*401\b/i.test(salida)) {
    return { motivo: "el proveedor rechazó la credencial", clase: FALLO.TERMINAL }
  }
  // Ausente NO es rechazada, y hasta el 2026-08-25 solo estaba contemplada la
  // segunda. El runtime dice "API key is missing" con otras palabras y sin 401,
  // así que la corrida entera —RECON y BUILD— murió sin escribir una línea y el
  // flujo imprimió "listo" en las dos. Esperar no lo arregla: falta configurar.
  if (/api key is missing|missing api key|no api key|apiKey.*(missing|not (set|provided))/i.test(salida)) {
    return { motivo: "falta la credencial en el entorno del runtime", clase: FALLO.TERMINAL }
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
  // El cajón de sastre. Antes esto devolvía `null` directamente, y `null`
  // significa "no falló": cualquier error que no estuviera en la lista de
  // arriba entraba como corrida buena. Es la regla del proyecto —lo que no se
  // puede medir NO pasa— rota justo aquí, en el sitio donde menos se nota,
  // porque el flujo sigue adelante y solo deja un diff vacío.
  //
  // No se puede invertir el valor por defecto (una corrida buena tampoco tiene
  // marca propia), pero un renglón que empieza por "Error:" no es ambiguo.
  const suelto = /^\s*Error:\s*(.+)$/m.exec(salida)
  if (suelto) {
    return { motivo: `el runtime devolvió un error sin clasificar: ${suelto[1].trim().slice(0, 120)}`, clase: FALLO.TRANSITORIO }
  }
  return null
}

/**
 * El nombre de la llave no es el mismo a los dos lados de la costura.
 *
 * La sonda de cuota habla por HTTP y lee la credencial como la nombra el
 * proveedor (`GEMINI_API_KEY`). El runtime usa el SDK, que exige otro nombre
 * (`GOOGLE_GENERATIVE_AI_API_KEY`). Con una sola de las dos puesta, el relevo
 * anuncia "hay credencial ✅" y la corrida siguiente muere por falta de
 * credencial: las dos piezas tienen razón por separado y el sistema miente en
 * el hueco que dejan.
 *
 * Aquí se copia el valor de una a otra, y el catálogo es quien dice a qué
 * nombre, porque es el único sitio que ya sabe que los proveedores existen.
 */
export function credencialesDeRuntime(entorno = process.env, catalogo = null) {
  const cat = catalogo ?? JSON.parse(readFileSync(CATALOGO, "utf8"))
  const extra = {}
  for (const p of Object.values(cat.proveedores ?? {})) {
    const { credencial, credencial_runtime: destino } = p
    if (!credencial || !destino || destino === credencial) continue
    // Si el nombre del runtime ya viene puesto a mano, manda ese: quien lo
    // exportó sabe algo que el catálogo no.
    if (entorno[destino]) continue
    if (entorno[credencial]) extra[destino] = entorno[credencial]
  }
  return extra
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
        env: {
          ...process.env,
          ...credencialesDeRuntime(),
          OC_CWD: cwd,
          OC_BIN: OPENCODE,
          OC_AGENT: agente,
          OC_MSG: mensaje,
        },
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
