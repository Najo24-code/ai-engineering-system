/**
 * Las pruebas del presupuesto.
 *
 * La que manda es **la del 429 disfrazado**: el runtime envuelve el rechazo por
 * cuota del proveedor en su propio `AI_APICallError`, y durante dos fases eso
 * bastó para que un fallo terminal entrara al banco vestido de fallo pasajero y
 * se llevara tres reintentos y treinta segundos por corrida. La distinción entre
 * «espera un poco» y «hoy ya no» es la única razón de ser de este archivo.
 *
 * Ninguna toca la red: el `fetch` entra por parámetro y los cuerpos son los que
 * el proveedor devolvió de verdad, copiados literales.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { sondearCuota, leerCabeceras, alcanza, costoMedido, CUOTA } from "./cuota.mjs"
import { clasificarFallo, credencialesDeRuntime, FALLO } from "./runner.mjs"

/** El cuerpo exacto de un 429 de OpenRouter, capturado el 2026-08-25. */
const CUERPO_429 = {
  error: {
    message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
    code: 429,
    metadata: {
      headers: {
        "X-RateLimit-Limit": "50",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "1787702400000",
      },
    },
  },
}

function respuesta({ status = 200, cuerpo = {}, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => cuerpo,
  }
}

const fetchQueDevuelve = (r) => async () => r

// ── dónde viven las cabeceras ────────────────────────────────────────────────

test("en un 429 las cabeceras viajan dentro del cuerpo, no como cabeceras", () => {
  // Si solo se miraran las cabeceras HTTP, el caso en que el proveedor SÍ dijo
  // el número exacto sería precisamente el que se leería como "no dijo nada".
  const c = leerCabeceras({ headers: { get: () => null }, cuerpo: CUERPO_429 })
  assert.equal(c.limite, 50)
  assert.equal(c.restantes, 0)
  assert.equal(c.resetMs, 1787702400000)
})

test("en una respuesta normal viajan como cabeceras HTTP", () => {
  const c = leerCabeceras({
    headers: { get: (k) => ({ "x-ratelimit-remaining": "37", "x-ratelimit-limit": "50" })[k] ?? null },
  })
  assert.equal(c.restantes, 37)
  assert.equal(c.limite, 50)
  assert.equal(c.resetMs, null)
})

// ── la sonda ─────────────────────────────────────────────────────────────────

test("429 es AGOTADA, con el número y el momento del reset", async () => {
  const c = await sondearCuota({
    apiKey: "k",
    modelo: "m",
    fetchImpl: fetchQueDevuelve(respuesta({ status: 429, cuerpo: CUERPO_429 })),
  })
  assert.equal(c.estado, CUOTA.AGOTADA)
  assert.equal(c.restantes, 0)
  assert.equal(c.resetMs, 1787702400000)
})

test("200 es DISPONIBLE", async () => {
  const c = await sondearCuota({
    apiKey: "k",
    modelo: "m",
    fetchImpl: fetchQueDevuelve(respuesta({ headers: { "x-ratelimit-remaining": "49" } })),
  })
  assert.equal(c.estado, CUOTA.DISPONIBLE)
  assert.equal(c.restantes, 49)
})

test("200 sin cabecera es DISPONIBLE con cantidad desconocida, no con un número inventado", async () => {
  // Que la respuesta fuera buena demuestra que quedaba AL MENOS una. No cuántas.
  const c = await sondearCuota({ apiKey: "k", modelo: "m", fetchImpl: fetchQueDevuelve(respuesta({})) })
  assert.equal(c.estado, CUOTA.DISPONIBLE)
  assert.equal(c.restantes, null)
})

test("una credencial rechazada NO es falta de cuota", async () => {
  // Confundirlas mandaría a esperar al reset diario por un problema que no se
  // arregla esperando: mañana la credencial seguirá siendo inválida. Tampoco es
  // duda —el proveedor no dudó— y por eso el estado es INSERVIBLE y no
  // INDETERMINADA, que es lo que devolvía hasta el 2026-08-25.
  const c = await sondearCuota({
    apiKey: "k",
    modelo: "m",
    fetchImpl: fetchQueDevuelve(respuesta({ status: 401, cuerpo: { error: { message: "Invalid API key" } } })),
  })
  assert.equal(c.estado, CUOTA.INSERVIBLE)
  assert.notEqual(c.estado, CUOTA.AGOTADA)
  assert.match(c.detalle, /Invalid API key/)
})

// ── el proveedor que no duda ─────────────────────────────────────────────────

test("un modelo retirado da 404 y eso es un NO, no un no-sé", async () => {
  // El cuerpo es el que devolvió Google AI Studio el 2026-08-25, literal. La
  // sonda lo leía como "cuota desconocida" y el relevo, cuya política ante la
  // duda es arrancar a ciegas, ELEGÍA este modelo: una señal negativa entrando
  // como permiso, que es el fallo exacto que este repositorio existe para no
  // cometer.
  const c = await sondearCuota({
    apiKey: "k",
    modelo: "gemini-2.5-flash",
    fetchImpl: fetchQueDevuelve(
      respuesta({
        status: 404,
        cuerpo: {
          error: {
            code: 404,
            message: "This model models/gemini-2.5-flash is no longer available to new users.",
            status: "NOT_FOUND",
          },
        },
      }),
    ),
  })
  assert.equal(c.estado, CUOTA.INSERVIBLE)
  assert.match(c.detalle, /no longer available/)
})

test("el 403 de una credencial recién creada es duda, no sentencia", async () => {
  // Cuerpo real de Google AI Studio, capturado el 2026-08-25. Ese día
  // `gemini-3.5-flash` lo devolvió en 1 de cada 6 llamadas seguidas y contestó
  // 200 en las otras 5: es el coletazo de una key nueva, se arregla solo. Estuvo
  // en la lista de terminales durante veinte minutos y habría apagado para
  // siempre al único modelo del proveedor que funcionaba.
  const c = await sondearCuota({
    apiKey: "k",
    modelo: "gemini-3.5-flash",
    fetchImpl: fetchQueDevuelve(
      respuesta({
        status: 403,
        cuerpo: {
          error: {
            code: 403,
            message:
              "Gemini API has not been used in project 1066335340582 before or it is disabled. Enable it by visiting ...",
          },
        },
      }),
    ),
  })
  assert.equal(c.estado, CUOTA.INDETERMINADA)
  assert.notEqual(c.estado, CUOTA.INSERVIBLE)
})

test("un 500 SIGUE siendo duda: un hipo del proveedor no apaga una opción", async () => {
  // El límite del control, escrito. Si cualquier respuesta no-200 apagara la
  // opción, un rato malo del proveedor la borraría del catálogo efectivo. El
  // modo de fallo que mata a un control es el que rechaza trabajo bueno.
  const c = await sondearCuota({
    apiKey: "k",
    modelo: "m",
    fetchImpl: fetchQueDevuelve(respuesta({ status: 503, cuerpo: { error: { message: "overloaded" } } })),
  })
  assert.equal(c.estado, CUOTA.INDETERMINADA)
  assert.notEqual(c.estado, CUOTA.INSERVIBLE)
})

test("ante un INSERVIBLE no se arranca, y el motivo no manda a esperar", async () => {
  // Distinto de AGOTADA en lo único que importa al que lee: ahí no hay reset que
  // valga. Decir "espera al reset" ante un 404 manda a esperar para siempre.
  const r = alcanza({ estado: CUOTA.INSERVIBLE, detalle: "404 NOT_FOUND", resetMs: null }, 9)
  assert.equal(r.sigue, false)
  assert.doesNotMatch(r.motivo, /renueva|reset/i)
})

test("sin red la sonda dice que no sabe, no que hay cuota", async () => {
  const c = await sondearCuota({
    apiKey: "k",
    modelo: "m",
    fetchImpl: async () => {
      throw new Error("ENOTFOUND")
    },
  })
  assert.equal(c.estado, CUOTA.INDETERMINADA)
})

test("sin credencial no se sale a la red siquiera", async () => {
  let llamo = false
  const c = await sondearCuota({
    apiKey: "",
    modelo: "m",
    fetchImpl: async () => {
      llamo = true
      return respuesta({})
    },
  })
  assert.equal(llamo, false)
  assert.equal(c.estado, CUOTA.INDETERMINADA)
})

// ── la puerta ────────────────────────────────────────────────────────────────

test("no se arranca un trabajo que no cabe en lo que queda", () => {
  const p = alcanza({ estado: CUOTA.DISPONIBLE, restantes: 12, resetMs: null }, 54)
  assert.equal(p.sigue, false)
  assert.match(p.motivo, /quedan 12/)
})

test("se arranca si cabe", () => {
  assert.equal(alcanza({ estado: CUOTA.DISPONIBLE, restantes: 60 }, 54).sigue, true)
})

test("la duda no cierra la puerta, la reporta", () => {
  // Una puerta que se cierra ante el silencio del proveedor convierte cada
  // hipo de red en trabajo que no se hace.
  const p = alcanza({ estado: CUOTA.INDETERMINADA, detalle: "sin red" }, 54)
  assert.equal(p.sigue, true)
  assert.match(p.motivo, /a ciegas/)
})

test("agotada sí la cierra", () => {
  assert.equal(alcanza({ estado: CUOTA.AGOTADA, resetMs: Date.now() + 3_600_000 }, 1).sigue, false)
})

// ── el coste ─────────────────────────────────────────────────────────────────

test("el coste es la resta de las dos lecturas", () => {
  assert.equal(costoMedido({ restantes: 50 }, { restantes: 8 }), 42)
})

test("si el contador subió, en medio cayó el reset y la resta no significa nada", () => {
  // Publicar un número negativo con cara de dato es peor que decir "no se pudo".
  assert.equal(costoMedido({ restantes: 3 }, { restantes: 50 }), null)
})

test("sin alguna de las dos lecturas no hay coste que publicar", () => {
  assert.equal(costoMedido({ restantes: null }, { restantes: 8 }), null)
})

// ── la clasificación, que es lo que costó dos fases ──────────────────────────

test("el 429 envuelto en AI_APICallError se clasifica TERMINAL, no transitorio", () => {
  // Este es el caso real: el runtime envuelve el rechazo del proveedor en su
  // propio error con `"name"`, así que la rama genérica lo atraparía primero.
  // El orden de las comprobaciones es lo que decide, y por eso se prueba.
  const salida = `{"name":"AI_APICallError","message":"Rate limit exceeded: free-models-per-day. Add 10 credits"}`
  const f = clasificarFallo(salida)
  assert.equal(f.clase, FALLO.TERMINAL)
  assert.match(f.motivo, /no queda cuota/)
})

test("una credencial rechazada también es TERMINAL", () => {
  assert.equal(clasificarFallo(`{"name":"Error","message":"Invalid API key"}`).clase, FALLO.TERMINAL)
})

test("el servidor que se cae al arrancar es TRANSITORIO: para eso son los reintentos", () => {
  const f = clasificarFallo(`{"name":"UnknownError","message":"Unexpected server error"}`)
  assert.equal(f.clase, FALLO.TRANSITORIO)
  assert.match(f.motivo, /UnknownError/)
})

test("una salida vacía es TRANSITORIO", () => {
  assert.equal(clasificarFallo("   ").clase, FALLO.TRANSITORIO)
})

test("una corrida limpia no es fallo", () => {
  assert.equal(clasificarFallo("RECON REPORT\nEvidence Ledger: ..."), null)
})

/** La salida literal de la corrida que murió el 2026-08-25 contra yunque. */
const SIN_CREDENCIAL =
  "\n> probe · gemini-3.5-flash\n\n" +
  "Error: Google Generative AI API key is missing. Pass it using the 'apiKey' " +
  "parameter or the GOOGLE_GENERATIVE_AI_API_KEY environment variable."

test("una credencial AUSENTE no es una credencial rechazada, y las dos son terminales", () => {
  // Solo estaba contemplada la rechazada ("invalid api key", 401). El runtime
  // dice que falta con otras palabras y sin código, así que esto no encajaba en
  // ningún patrón, caía al `return null` del final —que significa "no falló"— y
  // el flujo imprimió "listo" para RECON y para BUILD con cero líneas escritas.
  const f = clasificarFallo(SIN_CREDENCIAL)
  assert.notEqual(f, null)
  assert.equal(f.clase, FALLO.TERMINAL)
  assert.match(f.motivo, /credencial/)
})

test("un Error que nadie supo clasificar tampoco es una corrida buena", () => {
  // El límite de lo anterior, escrito. La lista de patrones nunca va a estar
  // completa, así que lo que importa no es reconocer este error concreto: es que
  // el valor por defecto haya dejado de ser "todo bien". Un renglón que empieza
  // por "Error:" no es ambiguo, aunque no se sepa de qué error se trata.
  const f = clasificarFallo("\n> probe · x\n\nError: algo que todavía no le ha pasado a nadie")
  assert.notEqual(f, null)
  assert.match(f.motivo, /sin clasificar/)
})

// ── la costura entre la sonda y el runtime ──────────────────────────────────

const CAT_DOS_NOMBRES = {
  proveedores: {
    google: { credencial: "GEMINI_API_KEY", credencial_runtime: "GOOGLE_GENERATIVE_AI_API_KEY" },
    openrouter: { credencial: "OPENROUTER_API_KEY" },
  },
}

test("la llave se copia al nombre que pide el runtime", () => {
  // El relevo comprueba GEMINI_API_KEY y dice "hay credencial ✅"; el SDK de
  // Google exige otro nombre y contesta "missing API key". Las dos piezas tienen
  // razón por separado y el sistema mentía en el hueco que dejaban.
  const extra = credencialesDeRuntime({ GEMINI_API_KEY: "k" }, CAT_DOS_NOMBRES)
  assert.equal(extra.GOOGLE_GENERATIVE_AI_API_KEY, "k")
})

test("si el nombre del runtime ya viene puesto a mano, manda ese", () => {
  // Quien lo exportó sabe algo que el catálogo no; pisarlo sería el sistema
  // decidiendo por encima de la persona sin decírselo.
  const extra = credencialesDeRuntime(
    { GEMINI_API_KEY: "del-catalogo", GOOGLE_GENERATIVE_AI_API_KEY: "a-mano" },
    CAT_DOS_NOMBRES,
  )
  assert.equal(extra.GOOGLE_GENERATIVE_AI_API_KEY, undefined)
})

test("un proveedor con un solo nombre no inventa variables de entorno", () => {
  const extra = credencialesDeRuntime({ OPENROUTER_API_KEY: "k" }, CAT_DOS_NOMBRES)
  assert.deepEqual(extra, {})
})

test("sin la credencial de origen no se copia nada", () => {
  assert.deepEqual(credencialesDeRuntime({}, CAT_DOS_NOMBRES), {})
})

// ── el techo de espera ──────────────────────────────────────────────────────

test("un proveedor que no contesta sale INDETERMINADA, no cuelga la elección", async () => {
  // Medido el 2026-08-25: `gemini-flash-latest` figura en el listado de modelos
  // de Google y su endpoint compatible no responde nunca. Sin techo, esa opción
  // del catálogo congelaba `npm run relevo` entero.
  const fetchQueNuncaContesta = (_url, opciones) =>
    new Promise((_, rechaza) => {
      opciones.signal.addEventListener("abort", () => {
        const e = new Error("This operation was aborted")
        e.name = "AbortError"
        rechaza(e)
      })
    })

  const r = await sondearCuota({
    apiKey: "sk-de-mentira",
    modelo: "el-que-cuelga",
    fetchImpl: fetchQueNuncaContesta,
    timeoutMs: 25,
  })

  assert.equal(r.estado, CUOTA.INDETERMINADA)
  assert.match(r.detalle, /no contestó/)
  assert.match(r.detalle, /el-que-cuelga/)
})

test("colgarse no se confunde con no tener red: el motivo distingue los dos", async () => {
  const fetchSinRed = () => Promise.reject(new TypeError("fetch failed"))
  const r = await sondearCuota({ apiKey: "sk-de-mentira", modelo: "x", fetchImpl: fetchSinRed, timeoutMs: 25 })
  assert.equal(r.estado, CUOTA.INDETERMINADA)
  assert.match(r.detalle, /no llegó al proveedor/)
})

test("el techo no estorba cuando el proveedor sí contesta", async () => {
  const fetchRapido = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "x-ratelimit-limit": "50", "x-ratelimit-remaining": "49" }),
    json: async () => ({ choices: [] }),
  })
  const r = await sondearCuota({ apiKey: "sk-de-mentira", modelo: "x", fetchImpl: fetchRapido, timeoutMs: 25 })
  assert.equal(r.estado, CUOTA.DISPONIBLE)
  assert.equal(r.restantes, 49)
})
