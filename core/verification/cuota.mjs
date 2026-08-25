/**
 * El presupuesto de peticiones, medido en vez de supuesto.
 *
 * Existe por un hecho que costó dos fases descubrir: **una corrida del flujo no
 * es una petición**. Cada llamada a herramienta que hace el agente —cada `read`,
 * cada `grep`, cada `edit`— es una petición al proveedor. Un RECON que lee quince
 * archivos gasta quince y pico. Por eso un tope de 50 diarias no da para cinco
 * corridas de verdad, y por eso el banco de fronteras —nueve corridas— se come el
 * presupuesto de un día él solo.
 *
 * Mientras eso fue una anécdota escrita en un informe, cada fase lo volvió a
 * descubrir a mitad de camino, con la evidencia ya partida por la mitad. Aquí
 * pasa a ser un número que se consulta ANTES de arrancar y se mide DESPUÉS.
 *
 * Dos decisiones que parecen detalles y no lo son:
 *
 * 1. **La sonda gasta una petición de verdad.** No hay endpoint gratis que diga
 *    cuántas quedan: `/api/v1/key` informa del gasto en dinero, y los modelos
 *    `:free` cuestan cero, así que su contador marca cero tanto si quedan
 *    cincuenta como si no queda ninguna. El único que sabe la verdad es el
 *    endpoint que cobra. Gastar una para no desperdiciar nueve es el trato.
 *
 * 2. **Agotada NO cuesta.** Un 429 se rechaza antes de facturar, así que
 *    preguntar cuando no queda nada es gratis. La sonda es cara exactamente en
 *    el caso en que la respuesta era «adelante».
 *
 * Ninguna función de aquí toca la red por su cuenta: el `fetch` entra por
 * parámetro. Así las pruebas de este archivo cuestan cero, como el resto de las
 * que viven en `npm test`.
 */

/**
 * Los tres estados posibles. `INDETERMINADA` no es un detalle defensivo: es la
 * misma distinción que sostiene todo el proyecto. Que la sonda no consiga
 * responder no es «hay cuota» ni «no hay»; es que no se sabe, y quien decide
 * tiene que verlo escrito en vez de deducirlo de un valor por defecto.
 */
export const CUOTA = {
  DISPONIBLE: "DISPONIBLE",
  AGOTADA: "AGOTADA",
  INDETERMINADA: "INDETERMINADA",
  INSERVIBLE: "INSERVIBLE",
}

/** Lo que cuesta el modelo más barato: una petición, un token, cero contexto. */
const SONDA = { max_tokens: 1, messages: [{ role: "user", content: "ok" }] }

/**
 * Los códigos en que el proveedor NO dudó: dijo que no.
 *
 * Solo dos, y la lista se quedó corta **después de medirla**, no antes.
 *
 * El motivo por el que existe: el 2026-08-25 `gemini-2.5-flash` devolvía 404 con
 * el texto «no longer available to new users», la sonda lo leía como «cuota
 * desconocida» y el relevo —cuya política ante la duda es arrancar a ciegas—
 * ELEGÍA ese modelo, dejando además sin mirar las opciones siguientes de la
 * escalera. Una señal negativa entrando como permiso.
 *
 * El motivo por el que **no** incluye al 403, que es la parte que costó: el
 * primer intento metió 400 y 403 aquí «por simetría». Cablearlo contra el
 * proveedor real lo desmintió en la misma sesión — `gemini-3.5-flash` dio 403 en
 * 1 de cada 6 llamadas seguidas y 200 en las otras 5, con el mensaje «Gemini API
 * has not been used in project … or it is disabled»: el coletazo de una
 * credencial recién creada, que se arregla solo. Con el 403 en esta lista, un
 * modelo perfectamente vivo se apagaba para siempre por un tropiezo de un
 * segundo. **El modo de fallo que mata a un control es el que rechaza trabajo
 * bueno**, y este control estuvo veinte minutos a un paso de tenerlo.
 *
 * Lo que queda son las dos respuestas que no dependen del reloj: la credencial
 * no vale (401) o el modelo no existe (404). Todo lo demás —403, 5xx, un corte,
 * un cuerpo ilegible— sigue siendo duda, y la duda se intenta.
 */
const TERMINALES = new Set([401, 404])

/**
 * Lee el trío de cabeceras del proveedor, mire donde mire.
 *
 * En una respuesta normal viajan como cabeceras HTTP. En un 429 de OpenRouter
 * viajan DENTRO del cuerpo, en `error.metadata.headers`, y con la caja cambiada.
 * Un lector que solo mirara las cabeceras daría `restantes: null` justo en el
 * caso en que el proveedor sí dijo el número exacto.
 */
export function leerCabeceras({ headers, cuerpo } = {}) {
  const deCuerpo = cuerpo?.error?.metadata?.headers ?? {}
  const buscar = (nombre) => {
    const directo = headers?.get?.(nombre)
    if (directo != null) return directo
    const clave = Object.keys(deCuerpo).find((k) => k.toLowerCase() === nombre)
    return clave ? deCuerpo[clave] : null
  }

  const num = (v) => {
    if (v == null || v === "") return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  return {
    limite: num(buscar("x-ratelimit-limit")),
    restantes: num(buscar("x-ratelimit-remaining")),
    // El proveedor lo manda en milisegundos de época, no en segundos ni en
    // "segundos desde ahora". Normalizarlo aquí evita que cada consumidor
    // reinvente la conversión y alguno la reinvente mal.
    resetMs: num(buscar("x-ratelimit-reset")),
  }
}

/**
 * Pregunta al proveedor si queda cuota. Cuesta una petición si la hay.
 *
 * @param {object} opciones
 * @param {string}   opciones.apiKey
 * @param {string}   opciones.modelo   id tal como lo espera el proveedor
 * @param {Function} [opciones.fetchImpl]
 * @param {string}   [opciones.url]
 * @param {number}   [opciones.timeoutMs] techo de espera; ver abajo por qué existe
 * @returns {Promise<{estado: string, restantes: number|null, limite: number|null,
 *                    resetMs: number|null, detalle: string}>}
 */
export async function sondearCuota({
  apiKey,
  modelo,
  fetchImpl = globalThis.fetch,
  url = "https://openrouter.ai/api/v1/chat/completions",
  // Medido el 2026-08-25 contra Google AI Studio: un id de modelo que el
  // proveedor no sirve por su endpoint compatible **no responde con un error, se
  // queda colgado**. `gemini-2.5-flash` contesta en 0,6 s; `gemini-flash-latest`
  // —que el propio listado de modelos anuncia— no contesta nunca, ni por fetch ni
  // por curl. Sin techo, esa opción del catálogo congela la elección de proveedor
  // entera y el sistema se queda sin arrancar por un id mal escrito.
  //
  // El techo no adivina: convierte "no contesta" en INDETERMINADA, que es lo que
  // de verdad se sabe, y deja seguir a la siguiente opción.
  timeoutMs = 20000,
} = {}) {
  if (!apiKey) {
    return { ...vacio(), detalle: "no hay credencial en el entorno" }
  }

  let respuesta
  let cuerpo = null
  const reloj = new AbortController()
  const alarma = setTimeout(() => reloj.abort(), timeoutMs)
  try {
    respuesta = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelo, ...SONDA }),
      signal: reloj.signal,
    })
    cuerpo = await respuesta.json().catch(() => null)
  } catch (err) {
    // Sin red no se sabe nada. Decirlo es más útil que suponer que hay cuota y
    // dejar que nueve corridas lo descubran una por una.
    const colgado = err?.name === "AbortError" || reloj.signal.aborted
    return {
      ...vacio(),
      detalle: colgado
        ? `la sonda esperó ${timeoutMs} ms y el proveedor no contestó (modelo "${modelo}"; ` +
          `un id que el proveedor no sirve se cuelga en vez de dar error)`
        : `la sonda no llegó al proveedor: ${err.message}`,
    }
  } finally {
    clearTimeout(alarma)
  }

  const { limite, restantes, resetMs } = leerCabeceras({ headers: respuesta.headers, cuerpo })

  if (respuesta.status === 429) {
    return {
      estado: CUOTA.AGOTADA,
      limite,
      restantes: restantes ?? 0,
      resetMs,
      detalle: cuerpo?.error?.message ?? "el proveedor devolvió 429",
    }
  }

  if (TERMINALES.has(respuesta.status)) {
    // 401 y 404. Aquí el proveedor no dudó: dijo que no. La credencial no vale o
    // el modelo no existe, y ninguna de las dos se arregla esperando ni
    // reintentando. Tratarlo como duda —que es lo que hacía este archivo— hace
    // que quien pregunta reciba un «adelante» por una respuesta que significaba
    // exactamente lo contrario.
    return {
      ...vacio(),
      estado: CUOTA.INSERVIBLE,
      limite,
      restantes,
      resetMs,
      detalle:
        (cuerpo?.error?.message ?? `el proveedor devolvió ${respuesta.status}`) +
        ` (HTTP ${respuesta.status}: no es falta de cuota y no se arregla esperando)`,
    }
  }

  if (!respuesta.ok) {
    // 5xx y cualquier otro. Aquí sí es duda: un hipo del proveedor no puede
    // apagar una opción que mañana funciona. Un fallo de credencial tampoco es
    // falta de cuota, y tratarlo como tal mandaría a esperar al reset por un
    // problema que no se arregla esperando.
    return {
      ...vacio(),
      limite,
      restantes,
      resetMs,
      detalle: cuerpo?.error?.message ?? `el proveedor devolvió ${respuesta.status}`,
    }
  }

  return {
    estado: CUOTA.DISPONIBLE,
    limite,
    // El proveedor puede no mandar el número. Que la respuesta fuera buena
    // demuestra que queda AL MENOS una, no cuántas: por eso `null` y no un
    // número inventado.
    restantes,
    resetMs,
    detalle: restantes == null ? "hay cuota; el proveedor no dijo cuánta" : "hay cuota",
  }
}

function vacio() {
  return { estado: CUOTA.INDETERMINADA, limite: null, restantes: null, resetMs: null, detalle: "" }
}

/**
 * ¿Alcanza para lo que se va a pedir?
 *
 * Deliberadamente NO bloquea cuando el proveedor no dijo cuántas quedan. Una
 * puerta que se cierra ante la duda convertiría cada silencio del proveedor en
 * un trabajo que no se hace; la duda se reporta y decide quien mira.
 *
 * @param {object} cuota      lo que devolvió `sondearCuota`
 * @param {number} necesarias estimación de peticiones del trabajo
 */
export function alcanza(cuota, necesarias) {
  if (cuota.estado === CUOTA.AGOTADA) {
    return { sigue: false, motivo: `no queda cuota; se renueva ${cuandoVuelve(cuota.resetMs)}` }
  }
  if (cuota.estado === CUOTA.INSERVIBLE) {
    // No es lo mismo que AGOTADA: no hay nada que esperar. Y no es lo mismo que
    // INDETERMINADA: no hay nada que dudar.
    return { sigue: false, motivo: `el proveedor rechaza esta opción: ${cuota.detalle}` }
  }
  if (cuota.estado === CUOTA.INDETERMINADA) {
    return { sigue: true, motivo: `cuota desconocida (${cuota.detalle}); se arranca a ciegas` }
  }
  if (cuota.restantes == null) {
    return { sigue: true, motivo: "hay cuota, cantidad desconocida; se arranca a ciegas" }
  }
  if (cuota.restantes < necesarias) {
    return {
      sigue: false,
      motivo:
        `quedan ${cuota.restantes} peticiones y este trabajo necesita ~${necesarias}. ` +
        `Arrancar dejaría la evidencia partida por la mitad, que es peor que no arrancar.`,
    }
  }
  return { sigue: true, motivo: `quedan ${cuota.restantes}; el trabajo necesita ~${necesarias}` }
}

/** Cuánto costó de verdad, restando dos lecturas. `null` si alguna falta. */
export function costoMedido(antes, despues) {
  if (antes?.restantes == null || despues?.restantes == null) return null
  const gasto = antes.restantes - despues.restantes
  // Si el contador subió, en medio cayó el reset diario. La resta no significa
  // nada y decirlo es mejor que publicar un número negativo con cara de dato.
  return gasto < 0 ? null : gasto
}

export function cuandoVuelve(resetMs) {
  if (!resetMs) return "en un momento que el proveedor no dijo"
  const falta = resetMs - Date.now()
  if (falta <= 0) return "ya (vuelve a intentarlo)"
  const horas = Math.floor(falta / 3_600_000)
  const minutos = Math.round((falta % 3_600_000) / 60_000)
  const reloj = new Date(resetMs).toLocaleTimeString("es-DO", { hour: "2-digit", minute: "2-digit" })
  return `a las ${reloj} (en ${horas ? `${horas}h ` : ""}${minutos}min)`
}
